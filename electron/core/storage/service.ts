import type {
  DuplicateSavings,
  StorageFilesPage,
  StorageRecommendations,
  StorageReport,
  StorageScanSummary,
  StorageSort,
} from '../../shared/contract';
import type { DuplicateScanStore } from '../duplicates/store';
import { parseFilter, rowToSummary, runningToSummary, toFileDto } from './dto';
import { computeRecommendations, recommendationFiles } from './recommend';
import * as repo from './repo';
import type { StorageScanStore } from './store';

const SORTS: StorageSort[] = ['size_desc', 'size_asc', 'mtime_asc', 'mtime_desc', 'name', 'path'];

/** A positive whole number, or `fallback` for anything else (junk, zero, negative). */
const positive = (value: unknown, fallback: number): number => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export class StorageNotFoundError extends Error {
  constructor() {
    super('That scan is no longer available. Run a new scan.');
  }
}

/** A scan's current state: finished scans come from the database, running/ended ones from memory. */
export function getSummary(db: any, store: StorageScanStore, scanId: number): StorageScanSummary {
  const live = store.get(scanId);
  if (live && live.state !== 'done') return runningToSummary(live);
  const row = repo.getScan(db, scanId);
  if (!row) throw new StorageNotFoundError();
  return row.state === 'done' ? rowToSummary(row) : runningToSummary(live!);
}

/** Finished scans, newest first, followed by any scan that is running right now. */
export function listSummaries(db: any, store: StorageScanStore): StorageScanSummary[] {
  const done = repo.listScans(db).map(rowToSummary);
  const running = store.running;
  return running ? [runningToSummary(running), ...done] : done;
}

function requireDone(db: any, scanId: number): repo.ScanRow {
  const row = repo.getScan(db, scanId);
  if (!row || row.state !== 'done') throw new StorageNotFoundError();
  return row;
}

export function buildReport(db: any, scanId: number, folder: string | null, now = Date.now()): StorageReport {
  const scan = requireDone(db, scanId);
  const scope = folder ? { folder } : {};

  const { children, direct } = repo.folderBreakdown(db, scanId, folder);
  return {
    scan: rowToSummary(scan),
    folder,
    children,
    direct_files: direct,
    by_kind: repo.byKind(db, scanId, scope) as StorageReport['by_kind'],
    largest_folders: repo.largestFolders(db, scanId, scan.roots, 10, folder),
    largest_files: repo.queryFiles(db, scanId, scope, 'size_desc', 0, 10).files.map(toFileDto),
    age: repo.ageBuckets(db, scanId, now, scope).map(({ label, files, bytes }) => ({ label, files, bytes })),
    errors: repo.getErrors(db, scanId, 50),
  };
}

export function filesPage(
  db: any,
  scanId: number,
  rawFilter: unknown,
  sort: unknown,
  offset: unknown,
  limit: unknown
): StorageFilesPage {
  requireDone(db, scanId);
  const page = repo.queryFiles(
    db,
    scanId,
    parseFilter(rawFilter),
    SORTS.includes(sort as StorageSort) ? (sort as StorageSort) : 'size_desc',
    Math.max(0, Math.floor(Number(offset)) || 0),
    positive(limit, 100)
  );
  return { ...page, files: page.files.map(toFileDto) };
}

export const OLD_MONTH_CHOICES = [1, 3, 6, 12, 24];

function oldMonths(raw: unknown): number {
  const n = Number(raw);
  return OLD_MONTH_CHOICES.includes(n) ? n : 6;
}

export function recommendations(db: any, scanId: number, rawMonths: unknown, now = Date.now()): StorageRecommendations {
  requireDone(db, scanId);
  return computeRecommendations(db, scanId, { oldMonths: oldMonths(rawMonths), now });
}

export function recommendationPage(
  db: any,
  scanId: number,
  recommendationId: string,
  rawMonths: unknown,
  offset: unknown,
  limit: unknown,
  now = Date.now()
): StorageFilesPage {
  requireDone(db, scanId);
  const page = recommendationFiles(
    db, scanId, String(recommendationId), { oldMonths: oldMonths(rawMonths), now }, Math.max(0, Math.floor(Number(offset)) || 0), positive(limit, 100)
  );
  return { ...page, files: page.files.map(toFileDto) };
}

/**
 * Savings from a duplicate scan covering exactly the same folders, if one is still held.
 * These are deliberately NOT added to the recommendation totals: which copy of a duplicate you
 * keep is your choice, and a duplicate may also be listed by a recommendation.
 */
export function duplicateSavings(db: any, scanId: number, dups: DuplicateScanStore): DuplicateSavings | null {
  const scan = requireDone(db, scanId);
  const found = dups.latestDoneFor(scan.roots);
  if (!found?.result) return null;
  return {
    reclaimable_bytes: found.result.stats.reclaimableBytes,
    group_count: found.result.stats.groups,
    scanned_at: found.finishedAt ? new Date(found.finishedAt).toISOString() : null,
  };
}
