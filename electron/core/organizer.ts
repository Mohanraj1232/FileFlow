import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getFileMeta, type FileMetaInfo } from './models';
import { evaluate } from './engine';
import {
  plan,
  buildSummary,
  managedDirs,
  isInManagedDir,
  normalizePolicy,
  type PlannedStep,
  type PlanSummary,
} from './planner';
import { executePlan, type WrittenTracker } from './executor';
import { loadRules, getSetting } from './rules-repo';
import { compileIgnore, parseIgnorePatterns } from './ignore';
import { shouldIgnoreFile, IGNORED_DIRS } from './watcher';
import type { UnsortedFile } from '../shared/contract';

export interface FolderRow {
  id: number;
  path: string;
  recursive: number | boolean;
}

/** A planned step as sent to the renderer: carries the key tying chained steps to one file. */
export type PlanStepDto = PlannedStep & { file_key: string };

export interface PlanSummaryDto extends Omit<PlanSummary, 'steps'> {
  plan_id: string;
  steps: PlanStepDto[];
}

/** Everything a scan needs, loaded once so every file sees the same rules and settings. */
interface ScanContext {
  rules: ReturnType<typeof loadRules>;
  policy: ReturnType<typeof normalizePolicy>;
  isIgnored: (filePath: string, root: string) => boolean;
  managed: string[];
}

function scanContext(db: any, folder: FolderRow): ScanContext {
  const rules = loadRules(db);
  return {
    rules,
    policy: normalizePolicy(getSetting(db, 'conflict_default')),
    isIgnored: compileIgnore(parseIgnorePatterns(getSetting(db, 'ignore_patterns'))),
    managed: managedDirs(rules, folder.path),
  };
}

/**
 * List the regular files in a watched folder.
 *
 * Skipped on purpose (the same things the live watcher ignores, so a manual
 * scan never does something the watcher would refuse to):
 *  - hidden files and folders, OS junk, and in-progress downloads
 *  - folders like node_modules and .git
 *  - the user's ignore patterns
 *  - folders FileFlow itself fills (e.g. <root>/Documents), so already-sorted
 *    files are not run through the rules again
 * Symlinks are never followed.
 */
export function walkFolder(folder: FolderRow, ctx: Pick<ScanContext, 'isIgnored' | 'managed'>): string[] {
  const results: string[] = [];
  const recursive = !!folder.recursive;

  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skip it, don't abort the scan
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.name.startsWith('.')) continue;

      if (entry.isDirectory()) {
        if (!recursive) continue;
        if (IGNORED_DIRS.has(entry.name)) continue;
        if (isInManagedDir(path.join(full, 'x'), ctx.managed)) continue;
        if (ctx.isIgnored(full, folder.path)) continue;
        visit(full);
      } else if (entry.isFile()) {
        if (shouldIgnoreFile(full)) continue;
        if (isInManagedDir(full, ctx.managed)) continue;
        if (ctx.isIgnored(full, folder.path)) continue;
        results.push(full);
      }
    }
  };

  visit(folder.path);
  return results;
}

/** Build the full plan for a folder: every matched file's steps, plus a count of unmatched files. */
export async function buildFolderPlan(
  db: any,
  folder: FolderRow
): Promise<{ steps: PlanStepDto[]; unmatched: number }> {
  const ctx = scanContext(db, folder);
  const files = walkFolder(folder, ctx);
  const existing = new Set<string>();
  const steps: PlanStepDto[] = [];
  let unmatched = 0;

  for (const filePath of files) {
    let meta: FileMetaInfo;
    try {
      meta = getFileMeta(filePath, folder.path);
    } catch {
      continue; // vanished or unreadable
    }

    const result = await evaluate(meta, ctx.rules, 'any');
    if (!result) {
      unmatched++;
      continue;
    }

    const fileSteps = await plan(meta, result.rule, result.actions, existing, ctx.policy);
    for (const s of fileSteps) steps.push({ ...s, file_key: filePath });
  }

  return { steps, unmatched };
}

/** Files in a folder that no rule matches. */
export async function getUnsortedFiles(db: any, folder: FolderRow): Promise<UnsortedFile[]> {
  const ctx = scanContext(db, folder);
  const unsorted: UnsortedFile[] = [];

  for (const filePath of walkFolder(folder, ctx)) {
    let meta: FileMetaInfo;
    try {
      meta = getFileMeta(filePath, folder.path);
    } catch {
      continue;
    }
    if (!(await evaluate(meta, ctx.rules, 'any'))) {
      unsorted.push({
        path: meta.path,
        name: meta.name,
        extension: meta.extension,
        size: meta.size,
        kind: meta.kind,
        modified_at: meta.mtime.toISOString(),
      });
    }
  }
  return unsorted;
}

interface CachedPlan {
  folderId: number;
  steps: PlanStepDto[];
  createdAt: number;
}

/**
 * Holds previews in the main process so "Apply" runs exactly what the user
 * reviewed. The renderer only ever sends back a plan id and file keys — never
 * raw source/destination paths to execute.
 */
export class PlanCache {
  private plans = new Map<string, CachedPlan>();

  constructor(
    private ttlMs = 30 * 60 * 1000,
    private maxEntries = 20
  ) {}

  put(folderId: number, steps: PlanStepDto[]): string {
    this.sweep();
    const id = crypto.randomUUID();
    this.plans.set(id, { folderId, steps, createdAt: Date.now() });
    // Drop the oldest previews beyond the cap.
    while (this.plans.size > this.maxEntries) {
      const oldest = this.plans.keys().next().value as string;
      this.plans.delete(oldest);
    }
    return id;
  }

  get(id: string): CachedPlan | undefined {
    const entry = this.plans.get(id);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.plans.delete(id);
      return undefined;
    }
    return entry;
  }

  delete(id: string): void {
    this.plans.delete(id);
  }

  private sweep(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, p] of this.plans) {
      if (p.createdAt < cutoff) this.plans.delete(id);
    }
  }
}

export async function previewFolder(
  db: any,
  folder: FolderRow,
  cache: PlanCache
): Promise<PlanSummaryDto> {
  const { steps, unmatched } = await buildFolderPlan(db, folder);
  const summary = buildSummary(steps, unmatched);
  return { ...summary, steps, plan_id: cache.put(folder.id, steps) };
}

export interface ApplyOutcome {
  operation: any | null;
  steps_attempted: number;
  message?: string;
}

/**
 * Execute a previously previewed plan.
 * @param selectedFileKeys files the user left ticked; null means every selectable step.
 */
export async function applyPlan(
  db: any,
  folder: FolderRow,
  planId: string,
  selectedFileKeys: string[] | null,
  cache: PlanCache,
  recentlyWritten: WrittenTracker | null
): Promise<ApplyOutcome> {
  const cached = cache.get(planId);
  if (!cached) {
    throw new Error('This preview has expired. Scan the folder again to get a fresh plan.');
  }
  if (cached.folderId !== folder.id) {
    throw new Error('This preview belongs to a different folder.');
  }

  const selected = selectedFileKeys ? new Set(selectedFileKeys) : null;
  const toRun = cached.steps.filter(
    (s) => s.action_type !== 'skip' && (selected ? selected.has(s.file_key) : s.selected)
  );

  if (toRun.length === 0) {
    return { operation: null, steps_attempted: 0, message: 'Nothing selected to apply' };
  }

  // A plan is single-use: re-applying it would just replay stale steps.
  cache.delete(planId);

  const operationId = await executePlan(db, toRun, `manual:folder:${folder.id}`, recentlyWritten);
  const operation = db.prepare('SELECT * FROM operations WHERE id = ?').get(operationId);
  return { operation, steps_attempted: toRun.length };
}
