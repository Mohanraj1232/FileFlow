import fs from 'node:fs';
import { getFileMeta } from './models';
import { evaluate } from './engine';
import { plan, managedDirs, isInManagedDir, normalizePolicy } from './planner';
import { executePlan } from './executor';
import { loadRules, getSetting } from './rules-repo';
import { compileIgnore, parseIgnorePatterns } from './ignore';
import {
  RecentlyWritten,
  shouldIgnoreFile,
  isFileStable,
  isWatchingEnabled,
  type WatchTarget,
} from './watcher';

export interface PipelineDeps {
  db: any;
  recentlyWritten: RecentlyWritten;
  /** Defaults to the shared watching switch. */
  isEnabled?: () => boolean;
  /** How long a file must stay unchanged before it is touched. Tests pass 0. */
  stabilityWaitMs?: number;
}

export interface ProcessedFile {
  operationId: number;
  ruleName: string;
  steps: number;
}

/**
 * Handle one file reported by the folder watcher: filter, wait for it to
 * finish writing, match a rule, plan and execute. Returns what was done, or
 * null when the file was (deliberately) left alone.
 *
 * Files are left alone when: watching is paused, FileFlow itself just wrote
 * the file (a move, copy or undo), it is junk/temporary, it matches an ignore
 * pattern, it sits in a folder FileFlow fills, it is still being written, or
 * no rule matches.
 */
export async function processWatchedFile(
  deps: PipelineDeps,
  filePath: string,
  folder: WatchTarget
): Promise<ProcessedFile | null> {
  const { db, recentlyWritten } = deps;
  const enabled = deps.isEnabled ?? isWatchingEnabled;
  if (!enabled()) return null;

  // Skip files written by FileFlow itself
  if (recentlyWritten.contains(filePath)) return null;
  if (shouldIgnoreFile(filePath)) return null;

  const rules = loadRules(db);

  const isIgnored = compileIgnore(parseIgnorePatterns(getSetting(db, 'ignore_patterns')));
  if (isIgnored(filePath, folder.path)) return null;
  if (isInManagedDir(filePath, managedDirs(rules, folder.path))) return null;

  if (!(await isFileStable(filePath, deps.stabilityWaitMs ?? 2000))) return null;
  if (!fs.existsSync(filePath)) return null;

  const meta = getFileMeta(filePath, folder.path);
  const result = await evaluate(meta, rules, 'arrival');
  if (!result) return null;

  const policy = normalizePolicy(getSetting(db, 'conflict_default'));
  const steps = await plan(meta, result.rule, result.actions, new Set<string>(), policy);

  const runnable = steps.filter((s) => s.action_type !== 'skip');
  if (runnable.length === 0) return null;

  const operationId = await executePlan(db, runnable, 'watcher', recentlyWritten);
  return { operationId, ruleName: result.rule.name, steps: runnable.length };
}
