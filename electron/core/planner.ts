const fs = require('node:fs');
const path = require('node:path');

interface FileMeta {
  name: string;
  extension: string;
  size: number;
  mtime: Date;
  kind: string;
  path: string;
  sourceFolder: string;
}

interface RuleAction {
  id: number;
  rule_id: number;
  position: number;
  action_type: string;
  params: any;
}

interface Rule {
  id: number;
  name: string;
  priority: number;
  [key: string]: any;
}

// Field names here match src/lib/types.ts's PlannedStep/PlanSummary exactly —
// this is the actual IPC contract the renderer reads (get_unsorted_files/
// preview_folder/apply_plan all send these objects across the IPC boundary
// as plain data, so nothing statically checks them against the renderer's
// types; a naming mismatch here silently shows up as blank/undefined fields
// in the UI instead of a compile error).
interface PlannedStep {
  rule_id: number;
  rule_name: string;
  action_type: string;
  src_path: string;
  dst_path: string | null;
  file_size: number;
  file_mtime: string;
  selected: boolean;
}

interface PlanSummary {
  steps: PlannedStep[];
  move_count: number;
  copy_count: number;
  rename_count: number;
  trash_count: number;
  skip_count: number;
  no_match_count: number;
}

/**
 * Strip common junk suffixes from a filename.
 * Removes patterns like " (1)", "_final", "- copy", "copy", "(copy)".
 */
function cleanFilename(name: string): string {
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
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Expand template variables in a destination path string.
 */
function expandVariables(template: string, fileMeta: FileMeta): string {
  const mtime = fileMeta.mtime instanceof Date ? fileMeta.mtime : new Date(fileMeta.mtime);
  const year = String(mtime.getFullYear());
  const month = String(mtime.getMonth() + 1).padStart(2, '0');
  const day = String(mtime.getDate()).padStart(2, '0');

  let result = template;
  // The folder the file currently lives in — lets a destination be
  // expressed relative to whichever watched folder produced the file
  // (e.g. "{root}/Audio") instead of a path hardcoded to one specific
  // watched folder, so the same rule works across every folder watched.
  result = result.replace(/\{root\}/g, fileMeta.sourceFolder);
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
function expandRenamePattern(pattern: string, fileMeta: FileMeta): string {
  const mtime = fileMeta.mtime instanceof Date ? fileMeta.mtime : new Date(fileMeta.mtime);
  const year = String(mtime.getFullYear());
  const month = String(mtime.getMonth() + 1).padStart(2, '0');
  const day = String(mtime.getDate()).padStart(2, '0');

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
 * Resolve a filename conflict by appending an incrementing number.
 * Checks both the existingFiles set and the filesystem.
 */
function resolveConflict(
  destPath: string,
  existingFiles: Set<string>,
  policy: string
): string {
  if (policy !== 'auto_rename') {
    return destPath;
  }

  const normalized = destPath.replace(/\\/g, '/');
  if (!existingFiles.has(normalized) && !fs.existsSync(destPath)) {
    return destPath;
  }

  const parsed = path.parse(destPath);
  let counter = 2;
  let candidate: string;

  do {
    candidate = path.join(parsed.dir, `${parsed.name} (${counter})${parsed.ext}`);
    counter++;
  } while (
    existingFiles.has(candidate.replace(/\\/g, '/')) ||
    fs.existsSync(candidate)
  );

  return candidate;
}

/**
 * Generate a plan of steps for a single file against a matched rule.
 */
function plan(
  fileMeta: FileMeta,
  rule: Rule,
  actions: any[],
  existingFiles: Set<string>,
  conflictPolicy: string = 'auto_rename'
): PlannedStep[] {
  const steps: PlannedStep[] = [];

  // Track the current path of the file as actions may chain (move then rename)
  let currentPath = fileMeta.path;

  for (const action of actions) {
    const params =
      typeof action.params === 'string'
        ? JSON.parse(action.params)
        : action.params;

    switch (action.action_type) {
      case 'move': {
        const destFolder = expandVariables(params.destination, fileMeta);
        const fileName = path.basename(currentPath);
        let destPath = path.join(destFolder, fileName);
        destPath = resolveConflict(destPath, existingFiles, conflictPolicy);

        // Track destination to prevent future conflicts
        existingFiles.add(destPath.replace(/\\/g, '/'));

        steps.push({
          rule_id: rule.id,
          rule_name: rule.name,
          action_type: 'move',
          src_path: currentPath,
          dst_path: destPath,
          file_size: fileMeta.size,
          file_mtime: (fileMeta.mtime instanceof Date ? fileMeta.mtime : new Date(fileMeta.mtime)).toISOString().slice(0, 19),
          selected: true,
        });

        currentPath = destPath;
        break;
      }

      case 'copy': {
        const destFolder = expandVariables(params.destination, fileMeta);
        const fileName = path.basename(currentPath);
        let destPath = path.join(destFolder, fileName);
        destPath = resolveConflict(destPath, existingFiles, conflictPolicy);

        existingFiles.add(destPath.replace(/\\/g, '/'));

        steps.push({
          rule_id: rule.id,
          rule_name: rule.name,
          action_type: 'copy',
          src_path: currentPath,
          dst_path: destPath,
          file_size: fileMeta.size,
          file_mtime: (fileMeta.mtime instanceof Date ? fileMeta.mtime : new Date(fileMeta.mtime)).toISOString().slice(0, 19),
          selected: true,
        });
        // copy does not change currentPath
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

        const dir = path.dirname(currentPath);
        let destPath = path.join(dir, finalName);
        destPath = resolveConflict(destPath, existingFiles, conflictPolicy);

        existingFiles.add(destPath.replace(/\\/g, '/'));

        steps.push({
          rule_id: rule.id,
          rule_name: rule.name,
          action_type: 'rename',
          src_path: currentPath,
          dst_path: destPath,
          file_size: fileMeta.size,
          file_mtime: (fileMeta.mtime instanceof Date ? fileMeta.mtime : new Date(fileMeta.mtime)).toISOString().slice(0, 19),
          selected: true,
        });

        currentPath = destPath;
        break;
      }

      case 'trash': {
        steps.push({
          rule_id: rule.id,
          rule_name: rule.name,
          action_type: 'trash',
          src_path: currentPath,
          dst_path: null,
          file_size: fileMeta.size,
          file_mtime: (fileMeta.mtime instanceof Date ? fileMeta.mtime : new Date(fileMeta.mtime)).toISOString().slice(0, 19),
          selected: true,
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
function buildSummary(
  steps: PlannedStep[],
  unmatchedCount: number,
  _totalFiles: number
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
    skip_count: 0,
    no_match_count: unmatchedCount,
  };
}

module.exports = {
  plan,
  buildSummary,
  expandVariables,
  expandRenamePattern,
  cleanFilename,
  slugify,
  resolveConflict,
};
