import path from 'node:path';
import { pathKey } from '../planner';
import { QUARANTINE_DIR_NAME } from '../paths';
import { parseQuarantineStamp } from '../quarantine';
import { directorySet, getFilesByIds, type FileRow } from './repo';

const MB = 1024 * 1024;
const GB = 1024 * MB;
const MONTH_MS = 30.4375 * 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

export const LARGE_MEDIA_BYTES = 500 * MB;
export const HUGE_FILE_BYTES = 1 * GB;
export const QUARANTINE_KEEP_DAYS = 30;

export interface RecommendationOptions {
  /** "Old" means not modified for this many months. */
  oldMonths: number;
  now: number;
}

export interface Recommendation {
  id: string;
  title: string;
  /** What this group is, in plain words. */
  description: string;
  /** Exactly why these files are listed, so the reason is never a mystery. */
  basis: string;
  file_count: number;
  /** Disk space held by these files (shared hard-linked data counted once). */
  bytes: number;
}

export interface RecommendationSet {
  recommendations: Recommendation[];
  /** Distinct files across all recommendations: a file listed twice is counted once. */
  total_files: number;
  total_bytes: number;
  old_months: number;
}

interface Candidate {
  id: number;
  stored_size: number;
}

type Finder = (db: any, scanId: number, opts: RecommendationOptions) => Candidate[];

interface Definition {
  id: string;
  title: string;
  description: string;
  basis: (opts: RecommendationOptions) => string;
  find: Finder;
}

const sizeDesc = (a: Candidate, b: Candidate) => b.stored_size - a.stored_size || a.id - b.id;

/** Run a WHERE fragment and return matching files, biggest first. */
function sql(where: string, params: (opts: RecommendationOptions) => any[]): Finder {
  return (db, scanId, opts) =>
    db
      .prepare(`SELECT id, stored_size FROM inventory_files WHERE scan_id = ? AND ${where}`)
      .all(scanId, ...params(opts))
      .sort(sizeDesc);
}

const cutoff = (o: RecommendationOptions) => o.now - o.oldMonths * MONTH_MS;

const ARCHIVE_EXTS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst']);

const DEFINITIONS: Definition[] = [
  {
    id: 'old-installers',
    title: 'Old installers',
    description: 'Setup programs you probably ran long ago.',
    basis: (o) => `Installer files (.exe, .msi, .dmg, .pkg, …) not modified in the last ${o.oldMonths} months.`,
    find: sql("kind = 'installer' AND mtime < ?", (o) => [cutoff(o)]),
  },
  {
    id: 'large-old-media',
    title: 'Large old videos and archives',
    description: 'Big files that take a lot of room and have not been touched in a while.',
    basis: (o) =>
      `Videos and archives of at least ${LARGE_MEDIA_BYTES / MB} MB not modified in the last ${o.oldMonths} months.`,
    find: sql("kind IN ('video', 'archive') AND size >= ? AND mtime < ?", (o) => [LARGE_MEDIA_BYTES, cutoff(o)]),
  },
  {
    id: 'old-downloads',
    title: 'Old files in Downloads',
    description: 'Things downloaded once and never moved anywhere.',
    basis: (o) => `Any file inside a folder named "Downloads" not modified in the last ${o.oldMonths} months.`,
    find: sql(`lower(path) LIKE ? AND mtime < ?`, (o) => [`%${path.sep}downloads${path.sep}%`, cutoff(o)]),
  },
  {
    id: 'huge-stale',
    title: 'Very large files not modified in a year',
    description: 'The biggest single files that look untouched.',
    basis: () => `Files of at least ${HUGE_FILE_BYTES / GB} GB not modified in the last 12 months.`,
    find: sql('size >= ? AND mtime < ?', (o) => [HUGE_FILE_BYTES, o.now - 12 * MONTH_MS]),
  },
  {
    id: 'extracted-archives',
    title: 'Archives that may already be extracted',
    description: 'A compressed file sitting next to a folder with the same name.',
    basis: () =>
      'An archive (.zip, .rar, .7z, .tar, .gz, …) in the same folder as a folder named like the archive. ' +
      'This is a guess from the names: check the folder really holds the contents before removing the archive.',
    find: (db, scanId) => {
      const dirs = directorySet(db, scanId);
      const rows = db
        .prepare("SELECT id, stored_size, dir, name, ext FROM inventory_files WHERE scan_id = ? AND kind = 'archive'")
        .all(scanId) as (Candidate & { dir: string; name: string; ext: string })[];
      return rows
        .filter((r) => {
          if (!ARCHIVE_EXTS.has(r.ext)) return false;
          // "backup.tar.gz" -> "backup"
          let stem = r.name.slice(0, r.name.length - r.ext.length - 1);
          if (stem.toLowerCase().endsWith('.tar')) stem = stem.slice(0, -4);
          return !!stem && dirs.has(pathKey(path.join(r.dir, stem)));
        })
        .map((r) => ({ id: r.id, stored_size: r.stored_size }))
        .sort(sizeDesc);
    },
  },
  {
    id: 'old-quarantine',
    title: 'Quarantined files kept long enough',
    description: `Copies FileFlow moved aside more than ${QUARANTINE_KEEP_DAYS} days ago.`,
    basis: () =>
      `Files inside a "${QUARANTINE_DIR_NAME}" folder whose batch was created over ${QUARANTINE_KEEP_DAYS} days ago ` +
      '(the date comes from the batch folder name). Emptying them sends them to the Recycle Bin / Trash.',
    find: (db, scanId, opts) => {
      const rows = db
        .prepare('SELECT id, stored_size, path FROM inventory_files WHERE scan_id = ? AND path LIKE ?')
        .all(scanId, `%${QUARANTINE_DIR_NAME}%`) as (Candidate & { path: string })[];
      return rows
        .filter((r) => {
          const parts = r.path.split(path.sep);
          const i = parts.lastIndexOf(QUARANTINE_DIR_NAME);
          const stamp = i >= 0 ? parseQuarantineStamp(parts[i + 1] ?? '') : null;
          return !!stamp && opts.now - stamp.getTime() > QUARANTINE_KEEP_DAYS * DAY_MS;
        })
        .map((r) => ({ id: r.id, stored_size: r.stored_size }))
        .sort(sizeDesc);
    },
  },
];

export const RECOMMENDATION_IDS = DEFINITIONS.map((d) => d.id);

/** Compute every recommendation for a scan. Nothing is changed. */
export function computeRecommendations(
  db: any,
  scanId: number,
  opts: RecommendationOptions
): RecommendationSet {
  const union = new Map<number, number>();
  const recommendations: Recommendation[] = [];

  for (const def of DEFINITIONS) {
    const found = def.find(db, scanId, opts);
    if (found.length === 0) continue;
    for (const c of found) union.set(c.id, c.stored_size);
    recommendations.push({
      id: def.id,
      title: def.title,
      description: def.description,
      basis: def.basis(opts),
      file_count: found.length,
      bytes: found.reduce((n, c) => n + c.stored_size, 0),
    });
  }

  let totalBytes = 0;
  for (const b of union.values()) totalBytes += b;
  return {
    recommendations: recommendations.sort((a, b) => b.bytes - a.bytes),
    total_files: union.size,
    total_bytes: totalBytes,
    old_months: opts.oldMonths,
  };
}

/** The files behind one recommendation, biggest first, one page at a time. */
export function recommendationFiles(
  db: any,
  scanId: number,
  recommendationId: string,
  opts: RecommendationOptions,
  offset: number,
  limit: number
): { files: FileRow[]; total_count: number; total_bytes: number; offset: number } {
  const def = DEFINITIONS.find((d) => d.id === recommendationId);
  if (!def) throw new Error(`Unknown recommendation: ${recommendationId}`);

  const found = def.find(db, scanId, opts);
  const start = Math.max(0, offset);
  const page = found.slice(start, start + Math.min(Math.max(1, limit), 500));
  return {
    files: getFilesByIds(db, page.map((c) => c.id)),
    total_count: found.length,
    total_bytes: found.reduce((n, c) => n + c.stored_size, 0),
    offset: start,
  };
}
