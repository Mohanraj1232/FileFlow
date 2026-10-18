import fs from 'node:fs';
import path from 'node:path';
import { hashFile } from '../hash';
import { executePlan, type WrittenTracker } from '../executor';
import * as journal from '../journal';
import { pathKey, type PlannedStep } from '../planner';
import { isProtectedPath } from '../paths';
import { RemovalPlanner, type RemoveMode } from '../quarantine';
import { removeFromResult, type ScanEntry } from './store';
import type { DupFile } from './scan';

export type { RemoveMode };

/** For one group: which files the user wants to KEEP. Everything else in the group is a removal candidate. */
export interface Decision {
  hash: string;
  keep: string[];
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface ResolveOutcome {
  operationId: number | null;
  removed: { path: string; size: number }[];
  skipped: SkippedFile[];
  /** Space freed, counting each distinct stored copy once. */
  reclaimedBytes: number;
}

/** Thrown for a malformed request, before anything has been touched. */
export class InvalidDecisionError extends Error {}

async function verifiedHash(file: { path: string; size: number; mtimeMs?: number }): Promise<string | null> {
  try {
    const st = fs.statSync(file.path);
    if (!st.isFile() || st.size !== file.size) return null;
    return await hashFile(file.path);
  } catch {
    return null;
  }
}

/**
 * Remove the unwanted copies from duplicate groups, safely.
 *
 * Nothing is trusted from the scan alone. For every group, before removing
 * anything, this:
 *   1. requires at least one file to be kept, and every kept path to be a
 *      member of the group (the renderer cannot name arbitrary files);
 *   2. re-hashes a kept file from disk and refuses the whole group if no kept
 *      copy still matches — so the last good copy can never be removed;
 *   3. re-checks each file to remove (size, modification time, full SHA-256);
 *   4. leaves alone hard links of a kept file and anything in a protected folder.
 * Files are moved to a quarantine folder (undoable from History) or sent to the
 * system trash. Nothing is permanently deleted.
 */
export async function resolveDuplicates(
  db: any,
  entry: ScanEntry,
  decisions: Decision[],
  mode: RemoveMode,
  recentlyWritten: WrittenTracker | null,
  now: Date = new Date()
): Promise<ResolveOutcome> {
  if (entry.state !== 'done' || !entry.result) {
    throw new InvalidDecisionError('That scan has not finished, so its results cannot be acted on.');
  }
  if (mode !== 'quarantine' && mode !== 'trash') {
    throw new InvalidDecisionError(`Unknown removal mode: ${mode}`);
  }

  const groups = new Map(entry.result.groups.map((g) => [g.hash, g]));

  // ---- validate the whole request before touching anything ----
  const seenHashes = new Set<string>();
  for (const d of decisions) {
    const group = groups.get(d.hash);
    if (!group) throw new InvalidDecisionError('A selected group is not part of this scan (it may already be resolved).');
    if (seenHashes.has(d.hash)) throw new InvalidDecisionError('A group was selected more than once.');
    seenHashes.add(d.hash);

    if (!Array.isArray(d.keep) || d.keep.length === 0) {
      throw new InvalidDecisionError('Every group must keep at least one file.');
    }
    const members = new Set(group.files.map((f) => pathKey(f.path)));
    for (const k of d.keep) {
      if (!members.has(pathKey(k))) throw new InvalidDecisionError('A file to keep is not part of its group.');
    }
  }

  const skipped: SkippedFile[] = [];
  const steps: PlannedStep[] = [];
  const planned: { file: DupFile; group: string }[] = [];
  const removal = new RemovalPlanner(entry.roots, mode, 'Duplicate cleanup', now);

  for (const d of decisions) {
    const group = groups.get(d.hash)!;
    const keepKeys = new Set(d.keep.map(pathKey));
    const kept = group.files.filter((f) => keepKeys.has(pathKey(f.path)));
    const candidates = group.files.filter((f) => !keepKeys.has(pathKey(f.path)));
    if (candidates.length === 0) continue;

    // 2. a kept copy must still exist with identical content
    let keeperOk = false;
    for (const k of kept) {
      if ((await verifiedHash(k)) === group.hash) {
        keeperOk = true;
        break;
      }
    }
    if (!keeperOk) {
      for (const c of candidates) {
        skipped.push({ path: c.path, reason: 'None of the files you kept could be verified (changed or missing since the scan)' });
      }
      continue;
    }

    const keptLinks = new Set(kept.map((k) => k.linkKey));

    for (const file of candidates) {
      if (keptLinks.has(file.linkKey)) {
        skipped.push({ path: file.path, reason: 'Hard link to a file you kept — removing it would free no space' });
        continue;
      }
      if (isProtectedPath(file.path)) {
        skipped.push({ path: file.path, reason: 'Inside a protected system folder' });
        continue;
      }

      let st: fs.Stats;
      try {
        st = fs.statSync(file.path);
      } catch {
        skipped.push({ path: file.path, reason: 'File no longer exists' });
        continue;
      }
      if (!st.isFile() || st.size !== file.size || Math.trunc(st.mtimeMs) !== Math.trunc(file.mtimeMs)) {
        skipped.push({ path: file.path, reason: 'File changed since the scan' });
        continue;
      }
      if ((await verifiedHash(file)) !== group.hash) {
        skipped.push({ path: file.path, reason: 'File content no longer matches' });
        continue;
      }

      steps.push(
        await removal.step(
          { path: file.path, name: file.name, size: file.size, mtime: st.mtime },
          group.hash.slice(0, 12)
        )
      );
      planned.push({ file, group: group.hash });
    }
  }

  if (steps.length === 0) {
    return { operationId: null, removed: [], skipped, reclaimedBytes: 0 };
  }

  const operationId = await executePlan(db, steps, `duplicates:${entry.id}`, recentlyWritten);

  // Report what actually happened, per file, from the journal.
  const byPath = new Map(planned.map((p) => [pathKey(p.file.path), p.file]));
  const removed: { path: string; size: number }[] = [];
  for (const step of journal.getOperationSteps(db, operationId)) {
    const file = byPath.get(pathKey(step.src_path));
    if (!file) continue;
    if (step.status === 'done') removed.push({ path: file.path, size: file.size });
    else skipped.push({ path: file.path, reason: step.error || `Not removed (${step.status})` });
  }

  // Distinct stored copies only: several removed hard links of one file free its space once.
  const links = new Map<string, number>();
  for (const r of removed) {
    const f = byPath.get(pathKey(r.path))!;
    links.set(f.linkKey, f.size);
  }
  const reclaimedBytes = [...links.values()].reduce((n, s) => n + s, 0);

  removeFromResult(entry, new Set(removed.map((r) => r.path)));
  return { operationId, removed, skipped, reclaimedBytes };
}
