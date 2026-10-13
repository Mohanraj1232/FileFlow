import fs from 'node:fs';
import path from 'node:path';
import type { FileMetaInfo } from './models';
import { filesIdentical } from './hash';

export type ConflictPolicy = 'auto_rename' | 'skip' | 'replace_if_identical';
export type ConflictOutcome = 'free' | 'renamed' | 'skipped' | 'identical';

type FileMeta = FileMetaInfo;

interface PlanRule {
  id: number;
  name: string;
}

// Field names here match src/lib/types.ts's PlannedStep/PlanSummary exactly —
// this is the actual IPC contract the renderer reads (preview_folder sends
// these objects across the IPC boundary as plain data, so nothing statically
// checks them against the renderer's types; a naming mismatch here silently
// shows up as blank/undefined fields in the UI instead of a compile error).
export interface PlannedStep {
  rule_id: number;
  rule_name: string;
  /** 'skip' steps are informational only: they are never executed or journaled. */
  action_type: 'move' | 'copy' | 'rename' | 'trash' | 'skip';
  src_path: string;
  dst_path: string | null;
  file_size: number;
  file_mtime: string;
  selected: boolean;
  /** Why a step was skipped, or a note about how a conflict was resolved. */
  note?: string;
  /** Conflict policy to honour if the destination appears between plan and execution. */
  policy?: ConflictPolicy;
}

export interface PlanSummary {
  steps: PlannedStep[];
  move_count: number;
  copy_count: number;
  rename_count: number;
  trash_count: number;
  skip_count: number;
  no_match_count: number;
}

const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

/** Canonical key for comparing paths: forward slashes, case-folded on case-insensitive filesystems. */
export function pathKey(p: string): string {
  const normalized = path.normalize(p).replace(/\\/g, '/');
  return CASE_INSENSITIVE_FS ? normalized.toLowerCase() : normalized;
}

export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/**
 * Map any stored/legacy conflict value onto a policy the planner implements.
 * 'replace_if_duplicate' (older versions) means "replace only if same content".
 * Anything unknown falls back to the safest behaviour that never loses data.
 */
export function normalizePolicy(value: unknown): ConflictPolicy {
  switch (value) {
    case 'skip':
      return 'skip';
    case 'replace_if_identical':
    case 'replace_if_duplicate':
      return 'replace_if_identical';
    default:
      return 'auto_rename';
  }
}

/**
 * Strip common junk suffixes from a filename.
 * Removes patterns like " (1)", "_final", "- copy", "copy", "(copy)".
 */
export function cleanFilename(name: string): string {
  let cleaned = name;
  // Remove " (1)", " (2)", etc.
  cleaned = cleaned.replace(/\s*\(\d+\)\s*$/g, '');
  // Remove "_final", "-final", " final"
  cleaned = cleaned.replace(/[\s_-]*final\s*$/gi, '');
  // Remove "- copy", " - copy", "_copy", " copy"
  cleaned = cleaned.replace(/[\s_-]*copy\s*$/gi, '');
  // Remove "(copy)", "( copy )"
  cleaned = cleaned.replace(/\s*\(\s*copy\s*\)\s*$/gi, '');
  // Remove " - Copy", " - Copy (2)" (Windows pattern)
  cleaned = cleaned.replace(/\s*-\s*Copy(\s*\(\d+\))?\s*$/gi, '');
  return cleaned.trim();
}

/**
 * Convert a string to a URL-friendly slug.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function dateParts(mtime: Date | string) {
  const d = mtime instanceof Date ? mtime : new Date(mtime);
  return {
    year: String(d.getFullYear()),
    month: String(d.getMonth() + 1).padStart(2, '0'),
    day: String(d.getDate()).padStart(2, '0'),
  };
}

/**
 * Expand template variables in a destination path string.
 */
export function expandVariables(template: string, fileMeta: FileMeta): string {
  const { year, month, day } = dateParts(fileMeta.mtime);

  let result = template;
  // The watched folder the file belongs to — lets a destination be expressed
  // relative to whichever watched folder produced the file (e.g.
  // "{root}/Audio") instead of a path hardcoded to one specific folder. It is
  // the watched root, NOT the file's current directory, so a file that was
  // already sorted into "<root>/Audio" resolves "{root}/Audio" to the same
  // place rather than nesting "Audio/Audio".
  result = result.replace(/\{root\}/g, fileMeta.watchRoot ?? fileMeta.sourceFolder);
  result = result.replace(/\{kind\}/g, fileMeta.kind);
  result = result.replace(/\{ext\}/g, fileMeta.extension);
  result = result.replace(/\{name\}/g, fileMeta.name);
  result = result.replace(/\{year\}/g, year);
  result = result.replace(/\{month\}/g, month);
  result = result.replace(/\{date:YYYY-MM-DD\}/g, `${year}-${month}-${day}`);
  result = result.replace(/\{date:YYYY-MM\}/g, `${year}-${month}`);
  result = result.replace(/\{date:YYYY\}/g, year);
  result = result.replace(/\{date\}/g, `${year}-${month}-${day}`);

  return result;
}

/**
 * Expand rename pattern variables.
 */
export function expandRenamePattern(pattern: string, fileMeta: FileMeta): string {
  const { year, month, day } = dateParts(fileMeta.mtime);

  let result = pattern;
  result = result.replace(/\{name:clean\}/g, cleanFilename(fileMeta.name));
  result = result.replace(/\{name:lower\}/g, fileMeta.name.toLowerCase());
  result = result.replace(/\{name:slug\}/g, slugify(fileMeta.name));
  result = result.replace(/\{name\}/g, fileMeta.name);
  result = result.replace(/\{ext\}/g, fileMeta.extension);
  result = result.replace(/\{kind\}/g, fileMeta.kind);
  result = result.replace(/\{date\}/g, `${year}-${month}-${day}`);

  return result;
}

/**
 * Decide what to do when `destPath` may already be taken.
 *
 * `existingFiles` holds destinations already claimed earlier in the same plan
 * (keyed with pathKey), so two files planned together can never target one name.
 *
 *  - free      : nothing there; use destPath as is.
 *  - renamed   : taken; a unique "name (N).ext" was chosen (auto_rename).
 *  - skipped   : taken and policy is 'skip'; the caller must not touch it.
 *  - identical : taken by a file with the exact same bytes as `srcPath`
 *                (replace_if_identical); the caller can drop the redundant source.
 *
 * A file is NEVER overwritten: when contents differ, replace_if_identical falls
 * back to renaming.
 */
export async function resolveConflict(
  destPath: string,
  existingFiles: Set<string>,
  policy: ConflictPolicy,
  srcPath?: string
): Promise<{ path: string; outcome: ConflictOutcome }> {
  const claimed = existingFiles.has(pathKey(destPath));
  const onDisk = fs.existsSync(destPath);

  if (!claimed && !onDisk) {
    return { path: destPath, outcome: 'free' };
  }

  if (policy === 'skip') {
    return { path: destPath, outcome: 'skipped' };
  }

  if (policy === 'replace_if_identical' && onDisk && !claimed && srcPath) {
    try {
      if (await filesIdentical(srcPath, destPath)) {
        return { path: destPath, outcome: 'identical' };
      }
    } catch {
      // Unreadable: treat as different and keep both files.
    }
  }

  const parsed = path.parse(destPath);
  let counter = 2;
  let candidate: string;
  do {
    candidate = path.join(parsed.dir, `${parsed.name} (${counter})${parsed.ext}`);
    counter++;
  } while (existingFiles.has(pathKey(candidate)) || fs.existsSync(candidate));

  return { path: candidate, outcome: 'renamed' };
}

function stepBase(rule: PlanRule, fileMeta: FileMeta) {
  return {
    rule_id: rule.id,
    rule_name: rule.name,
    file_size: fileMeta.size,
    file_mtime: (fileMeta.mtime instanceof Date ? fileMeta.mtime : new Date(fileMeta.mtime))
      .toISOString()
      .slice(0, 19),
    selected: true,
  };
}

/**
 * Generate the steps for a single file against a matched rule.
 *
 * `existingFiles` is shared across a whole batch; the planner records every
 * destination it hands out so later files in the batch avoid it.
 */
export async function plan(
  fileMeta: FileMeta,
  rule: PlanRule,
  actions: any[],
  existingFiles: Set<string>,
  defaultPolicy: unknown = 'auto_rename'
): Promise<PlannedStep[]> {
  const steps: PlannedStep[] = [];
  const base = stepBase(rule, fileMeta);

  // Track the current path of the file as actions may chain (move then rename)
  let currentPath = fileMeta.path;

  for (const action of actions) {
    const params =
      typeof action.params === 'string' ? JSON.parse(action.params) : action.params ?? {};
    const policy = normalizePolicy(params.on_conflict ?? defaultPolicy);

    switch (action.action_type) {
      case 'move':
      case 'copy': {
        // A destination-less action (saved with an empty field) can't be planned;
        // skip it rather than crash the whole scan.
        if (!params.destination) break;
        const destFolder = expandVariables(params.destination, fileMeta);
        const wanted = path.join(destFolder, path.basename(currentPath));

        // Already where this action would put it: nothing to do. This is what
        // keeps repeated scans idempotent.
        if (action.action_type === 'move' && samePath(wanted, currentPath)) break;

        const resolved = await resolveConflict(wanted, existingFiles, policy, currentPath);

        if (resolved.outcome === 'skipped') {
          steps.push({
            ...base,
            action_type: 'skip',
            src_path: currentPath,
            dst_path: wanted,
            selected: false,
            note: 'Destination already exists (conflict policy: skip)',
          });
          return steps;
        }

        if (resolved.outcome === 'identical') {
          if (action.action_type === 'copy') {
            steps.push({
              ...base,
              action_type: 'skip',
              src_path: currentPath,
              dst_path: wanted,
              selected: false,
              note: 'An identical copy already exists at the destination',
            });
          } else {
            // The destination already holds the same bytes: the source is
            // redundant. Trash it (recoverable from the OS bin); dst_path
            // records which file made it redundant.
            steps.push({
              ...base,
              action_type: 'trash',
              src_path: currentPath,
              dst_path: wanted,
              note: 'Identical file already at destination — source sent to trash',
            });
          }
          return steps;
        }

        existingFiles.add(pathKey(resolved.path));
        steps.push({
          ...base,
          action_type: action.action_type,
          src_path: currentPath,
          dst_path: resolved.path,
          policy,
        });
        if (action.action_type === 'move') currentPath = resolved.path;
        break;
      }

      case 'rename': {
        const pattern = params.pattern || params.name || '{name}.{ext}';
        const newName = expandRenamePattern(pattern, fileMeta);
        const ext = fileMeta.extension ? `.${fileMeta.extension}` : '';

        // If the pattern already includes an extension placeholder, don't double-add
        let finalName = newName;
        if (!pattern.includes('{ext}') && ext && !newName.endsWith(ext)) {
          finalName = newName + ext;
        }

        const wanted = path.join(path.dirname(currentPath), finalName);
        if (wanted === currentPath) break;

        // Case-only rename on a case-insensitive filesystem: the "destination"
        // is the file itself, not a conflicting file.
        if (samePath(wanted, currentPath)) {
          steps.push({
            ...base,
            action_type: 'rename',
            src_path: currentPath,
            dst_path: wanted,
            policy,
          });
          currentPath = wanted;
          break;
        }

        const resolved = await resolveConflict(wanted, existingFiles, policy, currentPath);

        if (resolved.outcome === 'skipped') {
          steps.push({
            ...base,
            action_type: 'skip',
            src_path: currentPath,
            dst_path: wanted,
            selected: false,
            note: 'A file with that name already exists (conflict policy: skip)',
          });
          return steps;
        }

        if (resolved.outcome === 'identical') {
          steps.push({
            ...base,
            action_type: 'trash',
            src_path: currentPath,
            dst_path: wanted,
            note: 'Identical file already has that name — source sent to trash',
          });
          return steps;
        }

        existingFiles.add(pathKey(resolved.path));
        steps.push({
          ...base,
          action_type: 'rename',
          src_path: currentPath,
          dst_path: resolved.path,
          policy,
        });
        currentPath = resolved.path;
        break;
      }

      case 'trash': {
        steps.push({
          ...base,
          action_type: 'trash',
          src_path: currentPath,
          dst_path: null,
        });
        break;
      }
    }
  }

  return steps;
}

/**
 * Build a summary of the plan across all files.
 */
export function buildSummary(
  steps: PlannedStep[],
  unmatchedCount: number,
  _totalFiles?: number
): PlanSummary {
  const byAction: Record<string, number> = {};

  for (const step of steps) {
    byAction[step.action_type] = (byAction[step.action_type] || 0) + 1;
  }

  return {
    steps,
    move_count: byAction.move || 0,
    copy_count: byAction.copy || 0,
    rename_count: byAction.rename || 0,
    trash_count: byAction.trash || 0,
    skip_count: byAction.skip || 0,
    no_match_count: unmatchedCount,
  };
}

/**
 * Directories that FileFlow itself fills, inside `watchRoot`: the static
 * (variable-free) prefix of every enabled rule's move/copy destination.
 * Scans and the watcher skip these so already-sorted files are not
 * re-evaluated and moved around again.
 */
export function managedDirs(rules: any[], watchRoot: string): string[] {
  const dirs = new Map<string, string>();

  for (const rule of rules) {
    if (!rule.enabled) continue;
    for (const action of rule.actions ?? []) {
      if (action.action_type !== 'move' && action.action_type !== 'copy') continue;
      const params =
        typeof action.params === 'string' ? JSON.parse(action.params) : action.params ?? {};
      if (!params.destination) continue;

      const withRoot = String(params.destination).replace(/\{root\}/g, watchRoot);
      const segments = withRoot.split(/[\\/]/);
      const staticParts: string[] = [];
      for (const seg of segments) {
        if (seg.includes('{')) break;
        staticParts.push(seg);
      }
      if (staticParts.length === 0) continue;
      const prefix = staticParts.join(path.sep) || path.sep;
      if (!path.isAbsolute(prefix)) continue;

      const rel = path.relative(watchRoot, prefix);
      // Only subfolders strictly inside the watched root count.
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      dirs.set(pathKey(prefix), prefix);
    }
  }

  return [...dirs.values()];
}

/** True when `filePath` lives under one of the managed destination directories. */
export function isInManagedDir(filePath: string, dirs: string[]): boolean {
  const key = pathKey(filePath);
  return dirs.some((d) => key.startsWith(pathKey(d) + '/'));
}
