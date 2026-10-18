import fs from 'node:fs';
import { executePlan, type WrittenTracker } from '../executor';
import * as journal from '../journal';
import { pathKey } from '../planner';
import { isProtectedPath, QUARANTINE_DIR_NAME } from '../paths';
import { RemovalPlanner, type RemoveMode } from '../quarantine';
import { deleteFilesByIds, getFilesByPaths, refreshTotals, type FileRow, type ScanRow } from './repo';

export const MAX_CLEANUP_FILES = 5000;

export interface CleanupOutcome {
  operationId: number | null;
  removed: { path: string; size: number }[];
  skipped: { path: string; reason: string }[];
  /** Space freed. A file with other hard links frees nothing by itself, so it adds 0 here. */
  reclaimedBytes: number;
}

export class InvalidCleanupError extends Error {}

const insideQuarantine = (p: string) => p.split(/[\\/]/).includes(QUARANTINE_DIR_NAME);

/**
 * Remove files chosen from a storage report: moved to a quarantine folder (undoable from
 * History) or sent to the system trash. Never a permanent delete, and never automatic.
 *
 * The renderer only names paths; each must belong to the scan (it cannot ask for arbitrary
 * files), and each file is checked again right before it is touched: still a regular file (not
 * a link), same size and modification time as when it was scanned, and not in a protected
 * folder. Anything that no longer matches is skipped and reported.
 */
export async function cleanupFiles(
  db: any,
  scan: ScanRow,
  paths: unknown,
  mode: RemoveMode,
  recentlyWritten: WrittenTracker | null,
  now: Date = new Date()
): Promise<CleanupOutcome> {
  if (scan.state !== 'done') throw new InvalidCleanupError('That scan has not finished.');
  if (mode !== 'quarantine' && mode !== 'trash') throw new InvalidCleanupError(`Unknown removal mode: ${mode}`);
  if (!Array.isArray(paths) || paths.length === 0 || paths.some((p) => typeof p !== 'string')) {
    throw new InvalidCleanupError('Nothing selected to remove.');
  }
  if (paths.length > MAX_CLEANUP_FILES) {
    throw new InvalidCleanupError(`Select at most ${MAX_CLEANUP_FILES.toLocaleString()} files at a time.`);
  }

  const unique = [...new Set(paths as string[])];
  const rows = getFilesByPaths(db, scan.id, unique);
  const removal = new RemovalPlanner(scan.roots, mode, 'Storage cleanup', now);

  const skipped: { path: string; reason: string }[] = [];
  const steps = [];
  const planned = new Map<string, FileRow>();

  for (const p of unique) {
    const row = rows.get(p);
    if (!row) {
      skipped.push({ path: p, reason: 'Not part of this scan' });
      continue;
    }
    if (mode === 'quarantine' && insideQuarantine(p)) {
      skipped.push({ path: p, reason: 'Already in quarantine; send it to the trash instead' });
      continue;
    }
    if (isProtectedPath(p)) {
      skipped.push({ path: p, reason: 'Inside a protected system folder' });
      continue;
    }

    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      skipped.push({ path: p, reason: 'File no longer exists' });
      continue;
    }
    if (st.isSymbolicLink() || !st.isFile()) {
      skipped.push({ path: p, reason: 'No longer a regular file' });
      continue;
    }
    if (st.size !== row.size || Math.trunc(st.mtimeMs) !== row.mtime) {
      skipped.push({ path: p, reason: 'File changed since the scan' });
      continue;
    }

    steps.push(await removal.step({ path: p, name: row.name, size: row.size, mtime: st.mtime }, 'cleanup'));
    planned.set(pathKey(p), row);
  }

  if (steps.length === 0) return { operationId: null, removed: [], skipped, reclaimedBytes: 0 };

  const operationId = await executePlan(db, steps, `cleanup:${scan.id}`, recentlyWritten);

  const removed: { path: string; size: number }[] = [];
  const removedIds: number[] = [];
  let reclaimedBytes = 0;
  for (const step of journal.getOperationSteps(db, operationId)) {
    const row = planned.get(pathKey(step.src_path));
    if (!row) continue;
    if (step.status === 'done') {
      removed.push({ path: row.path, size: row.size });
      removedIds.push(row.id);
      if (row.links === 1) reclaimedBytes += row.size;
    } else {
      skipped.push({ path: row.path, reason: step.error || `Not removed (${step.status})` });
    }
  }

  // Keep the report honest: removed files leave it, and totals are recomputed.
  if (removedIds.length) {
    deleteFilesByIds(db, removedIds);
    refreshTotals(db, scan.id);
  }
  return { operationId, removed, skipped, reclaimedBytes };
}
