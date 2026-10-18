import crypto from 'node:crypto';
import path from 'node:path';
import { pathKey } from '../planner';
import { rootsKey } from '../paths';
import type { InvFile, InvError } from './inventory';

const SEP = path.sep;
const MAX_STORED_ERRORS = 500;
const MAX_KEPT_SCANS = 10;
const IN_CHUNK = 500;

export type ScanState = 'running' | 'done';

export interface ScanRow {
  id: number;
  roots: string[];
  state: ScanState;
  started_at: string;
  finished_at: string | null;
  file_count: number;
  dir_count: number;
  stored_bytes: number;
  logical_bytes: number;
  error_count: number;
}

export interface FileRow {
  id: number;
  scan_id: number;
  root: string;
  path: string;
  dir: string;
  name: string;
  ext: string;
  kind: string;
  size: number;
  stored_size: number;
  links: number;
  mtime: number;
  atime: number | null;
  birthtime: number | null;
}

export { rootsKey };

const nowIso = () => new Date().toISOString().slice(0, 19);

function toScanRow(r: any): ScanRow {
  return { ...r, roots: JSON.parse(r.roots) };
}

// ---------------------------------------------------------------------------
// scans
// ---------------------------------------------------------------------------

/** Start a scan. It is invisible to reports (state 'running') until finishScan swaps it in. */
export function createScan(db: any, roots: string[]): number {
  const building = `${rootsKey(roots)}\n#building:${crypto.randomUUID()}`;
  const info = db
    .prepare("INSERT INTO inventory_scans (roots, roots_key, state, started_at) VALUES (?, ?, 'running', ?)")
    .run(JSON.stringify(roots), building, nowIso());
  return Number(info.lastInsertRowid);
}

export function insertFiles(db: any, scanId: number, files: InvFile[]): void {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO inventory_files
       (scan_id, root, path, dir, name, ext, kind, size, stored_size, links, mtime, atime, birthtime)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  db.transaction(() => {
    for (const f of files) {
      stmt.run(
        scanId, f.root, f.path, f.dir, f.name, f.ext, f.kind, f.size, f.storedSize, f.links,
        Math.trunc(f.mtimeMs), Math.trunc(f.atimeMs), Math.trunc(f.birthtimeMs)
      );
    }
  })();
}

export function insertErrors(db: any, scanId: number, errors: InvError[]): void {
  const stmt = db.prepare('INSERT INTO inventory_errors (scan_id, path, error) VALUES (?, ?, ?)');
  db.transaction(() => {
    for (const e of errors.slice(0, MAX_STORED_ERRORS)) stmt.run(scanId, e.path, e.error);
  })();
}

export interface ScanTotals {
  fileCount: number;
  dirCount: number;
  storedBytes: number;
  logicalBytes: number;
  errorCount: number;
}

/**
 * Complete a scan: replace any earlier scan of the same folders, publish this one, and trim old
 * scans. Atomic, so there is never a moment with no valid report for these folders.
 */
export function finishScan(db: any, scanId: number, totals: ScanTotals): void {
  db.transaction(() => {
    const scan = toScanRow(db.prepare('SELECT * FROM inventory_scans WHERE id = ?').get(scanId));
    const key = rootsKey(scan.roots);
    db.prepare("DELETE FROM inventory_scans WHERE roots_key = ? AND id != ?").run(key, scanId);
    db.prepare(
      `UPDATE inventory_scans
         SET roots_key = ?, state = 'done', finished_at = ?, file_count = ?, dir_count = ?,
             stored_bytes = ?, logical_bytes = ?, error_count = ?
       WHERE id = ?`
    ).run(key, nowIso(), totals.fileCount, totals.dirCount, totals.storedBytes, totals.logicalBytes, totals.errorCount, scanId);

    // Keep only the most recent scans.
    const old = db
      .prepare("SELECT id FROM inventory_scans WHERE state = 'done' ORDER BY finished_at DESC, id DESC LIMIT -1 OFFSET ?")
      .all(MAX_KEPT_SCANS);
    for (const o of old) db.prepare('DELETE FROM inventory_scans WHERE id = ?').run(o.id);
  })();
}

/** Discard a scan that was cancelled or failed. Any earlier scan of the same folders is untouched. */
export function discardScan(db: any, scanId: number): void {
  db.prepare('DELETE FROM inventory_scans WHERE id = ?').run(scanId);
}

/** Remove scans left unfinished by a crash or a quit during a scan. */
export function purgeUnfinished(db: any): number {
  return db.prepare("DELETE FROM inventory_scans WHERE state = 'running'").run().changes;
}

export function listScans(db: any): ScanRow[] {
  return db
    .prepare("SELECT * FROM inventory_scans WHERE state = 'done' ORDER BY finished_at DESC, id DESC")
    .all()
    .map(toScanRow);
}

export function getScan(db: any, scanId: number): ScanRow | undefined {
  const row = db.prepare('SELECT * FROM inventory_scans WHERE id = ?').get(scanId);
  return row ? toScanRow(row) : undefined;
}

export function deleteScan(db: any, scanId: number): void {
  db.prepare('DELETE FROM inventory_scans WHERE id = ?').run(scanId);
}

/** Delete every stored scan (used by the privacy controls). */
export function clearInventory(db: any): number {
  return db.prepare('DELETE FROM inventory_scans').run().changes;
}

export function getErrors(db: any, scanId: number, limit = 200): InvError[] {
  return db.prepare('SELECT path, error FROM inventory_errors WHERE scan_id = ? ORDER BY id LIMIT ?').all(scanId, limit);
}

/** Recompute a scan's totals after files were removed from it. */
export function refreshTotals(db: any, scanId: number): void {
  db.prepare(
    `UPDATE inventory_scans SET
       file_count = (SELECT COUNT(*) FROM inventory_files WHERE scan_id = ?),
       stored_bytes = (SELECT COALESCE(SUM(stored_size), 0) FROM inventory_files WHERE scan_id = ?),
       logical_bytes = (SELECT COALESCE(SUM(size), 0) FROM inventory_files WHERE scan_id = ?)
     WHERE id = ?`
  ).run(scanId, scanId, scanId, scanId);
}

// ---------------------------------------------------------------------------
// filtering
// ---------------------------------------------------------------------------

export interface FileFilter {
  /** Only files in this folder or below. */
  folder?: string | null;
  kinds?: string[];
  ext?: string;
  min_size?: number;
  max_size?: number;
  /** Epoch ms. */
  modified_before?: number;
  modified_after?: number;
  name_contains?: string;
}

export type FileSort = 'size_desc' | 'size_asc' | 'mtime_asc' | 'mtime_desc' | 'name' | 'path';

const SORTS: Record<FileSort, string> = {
  size_desc: 'size DESC, id',
  size_asc: 'size ASC, id',
  mtime_asc: 'mtime ASC, id',
  mtime_desc: 'mtime DESC, id',
  name: 'name COLLATE NOCASE ASC, id',
  path: 'path COLLATE NOCASE ASC, id',
};

/** Folder as a prefix that matches only real children ("C:\\a" must not match "C:\\ab"). */
export function folderPrefix(folder: string): string {
  return folder.endsWith(SEP) ? folder : folder + SEP;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);

function buildWhere(scanId: number, f: FileFilter = {}): { sql: string; params: any[] } {
  const parts = ['scan_id = ?'];
  const params: any[] = [scanId];

  if (f.folder) {
    const prefix = folderPrefix(f.folder);
    parts.push('(dir = ? OR substr(dir, 1, ?) = ?)');
    params.push(f.folder.endsWith(SEP) && f.folder.length > 1 ? f.folder.slice(0, -1) : f.folder, prefix.length, prefix);
  }
  if (f.kinds && f.kinds.length) {
    parts.push(`kind IN (${f.kinds.map(() => '?').join(',')})`);
    params.push(...f.kinds);
  }
  if (f.ext) {
    parts.push('ext = ?');
    params.push(f.ext.toLowerCase().replace(/^\./, ''));
  }
  if (Number.isFinite(f.min_size)) {
    parts.push('size >= ?');
    params.push(f.min_size);
  }
  if (Number.isFinite(f.max_size)) {
    parts.push('size <= ?');
    params.push(f.max_size);
  }
  if (Number.isFinite(f.modified_before)) {
    parts.push('mtime < ?');
    params.push(f.modified_before);
  }
  if (Number.isFinite(f.modified_after)) {
    parts.push('mtime >= ?');
    params.push(f.modified_after);
  }
  if (f.name_contains && f.name_contains.trim()) {
    parts.push("name LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(f.name_contains.trim())}%`);
  }
  return { sql: parts.join(' AND '), params };
}

export interface FilesPage {
  files: FileRow[];
  total_count: number;
  /** Disk usage of every matching file, not just this page. */
  total_bytes: number;
  offset: number;
}

export function queryFiles(
  db: any,
  scanId: number,
  filter: FileFilter,
  sort: FileSort = 'size_desc',
  offset = 0,
  limit = 100
): FilesPage {
  const { sql, params } = buildWhere(scanId, filter);
  const totals = db
    .prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(stored_size), 0) AS b FROM inventory_files WHERE ${sql}`)
    .get(...params);
  const order = SORTS[sort] ?? SORTS.size_desc;
  const files = db
    .prepare(`SELECT * FROM inventory_files WHERE ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, Math.min(Math.max(1, limit), 500), Math.max(0, offset));
  return { files, total_count: totals.c, total_bytes: totals.b, offset: Math.max(0, offset) };
}

export function getFilesByIds(db: any, ids: number[]): FileRow[] {
  const out: FileRow[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    out.push(...db.prepare(`SELECT * FROM inventory_files WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk));
  }
  const byId = new Map(out.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is FileRow => !!r);
}

export function getFilesByPaths(db: any, scanId: number, paths: string[]): Map<string, FileRow> {
  const found = new Map<string, FileRow>();
  for (let i = 0; i < paths.length; i += IN_CHUNK) {
    const chunk = paths.slice(i, i + IN_CHUNK);
    const rows: FileRow[] = db
      .prepare(`SELECT * FROM inventory_files WHERE scan_id = ? AND path IN (${chunk.map(() => '?').join(',')})`)
      .all(scanId, ...chunk);
    for (const r of rows) found.set(r.path, r);
  }
  return found;
}

export function deleteFilesByIds(db: any, ids: number[]): void {
  db.transaction(() => {
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const chunk = ids.slice(i, i + IN_CHUNK);
      db.prepare(`DELETE FROM inventory_files WHERE id IN (${chunk.map(() => '?').join(',')})`).run(...chunk);
    }
  })();
}

// ---------------------------------------------------------------------------
// report aggregates
// ---------------------------------------------------------------------------

export interface Tally {
  files: number;
  bytes: number;
}

export interface FolderEntry extends Tally {
  path: string;
  name: string;
}

interface DirTotal extends Tally {
  dir: string;
}

function dirTotals(db: any, scanId: number, filter: FileFilter = {}): DirTotal[] {
  const { sql, params } = buildWhere(scanId, filter);
  return db
    .prepare(`SELECT dir, COUNT(*) AS files, COALESCE(SUM(stored_size), 0) AS bytes FROM inventory_files WHERE ${sql} GROUP BY dir`)
    .all(...params);
}

/**
 * What is inside `folder`: each immediate subfolder with everything beneath it rolled up, plus the
 * files sitting directly in the folder. With no folder, the chosen root folders themselves.
 */
export function folderBreakdown(
  db: any,
  scanId: number,
  folder: string | null
): { children: FolderEntry[]; direct: Tally } {
  if (!folder) {
    const rows = db
      .prepare(
        `SELECT root AS path, COUNT(*) AS files, COALESCE(SUM(stored_size), 0) AS bytes
           FROM inventory_files WHERE scan_id = ? GROUP BY root ORDER BY bytes DESC`
      )
      .all(scanId);
    return { children: rows.map((r: any) => ({ ...r, name: r.path })), direct: { files: 0, bytes: 0 } };
  }

  const base = folder.endsWith(SEP) && folder.length > 1 ? folder.slice(0, -1) : folder;
  const prefix = folderPrefix(folder);
  const direct: Tally = { files: 0, bytes: 0 };
  const children = new Map<string, FolderEntry>();

  for (const row of dirTotals(db, scanId, { folder })) {
    if (row.dir === base) {
      direct.files += row.files;
      direct.bytes += row.bytes;
      continue;
    }
    const first = row.dir.slice(prefix.length).split(SEP)[0];
    const childPath = prefix + first;
    const entry = children.get(childPath) ?? { path: childPath, name: first, files: 0, bytes: 0 };
    entry.files += row.files;
    entry.bytes += row.bytes;
    children.set(childPath, entry);
  }
  return { children: [...children.values()].sort((a, b) => b.bytes - a.bytes), direct };
}

/** The biggest folders by total size including everything beneath them (the chosen roots excluded). */
export function largestFolders(
  db: any,
  scanId: number,
  roots: string[],
  limit = 10,
  within?: string | null
): FolderEntry[] {
  // Scoped to a folder, that folder plays the part of the root.
  const rootKeys = new Set((within ? [within] : roots).map(pathKey));
  const totals = new Map<string, FolderEntry>();

  for (const row of dirTotals(db, scanId, within ? { folder: within } : {})) {
    let current = row.dir;
    for (let guard = 0; guard < 200; guard++) {
      const key = pathKey(current);
      if (rootKeys.has(key)) break;
      const entry = totals.get(key) ?? { path: current, name: path.basename(current) || current, files: 0, bytes: 0 };
      entry.files += row.files;
      entry.bytes += row.bytes;
      totals.set(key, entry);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return [...totals.values()].sort((a, b) => b.bytes - a.bytes).slice(0, limit);
}

export interface KindTally extends Tally {
  kind: string;
  top_extensions: (Tally & { ext: string })[];
}

export function byKind(db: any, scanId: number, filter: FileFilter = {}): KindTally[] {
  const { sql, params } = buildWhere(scanId, filter);
  const kinds: KindTally[] = db
    .prepare(
      `SELECT kind, COUNT(*) AS files, COALESCE(SUM(stored_size), 0) AS bytes
         FROM inventory_files WHERE ${sql} GROUP BY kind ORDER BY bytes DESC`
    )
    .all(...params)
    .map((r: any) => ({ ...r, top_extensions: [] }));

  const exts: any[] = db
    .prepare(
      `SELECT kind, ext, COUNT(*) AS files, COALESCE(SUM(stored_size), 0) AS bytes
         FROM inventory_files WHERE ${sql} GROUP BY kind, ext ORDER BY bytes DESC`
    )
    .all(...params);
  const byKindMap = new Map(kinds.map((k) => [k.kind, k]));
  for (const e of exts) {
    const k = byKindMap.get(e.kind);
    if (k && k.top_extensions.length < 5) k.top_extensions.push({ ext: e.ext, files: e.files, bytes: e.bytes });
  }
  return kinds;
}

export interface AgeBucket extends Tally {
  label: string;
  /** Modified before this instant (epoch ms), or null for the newest bucket. */
  older_than: number | null;
}

const MONTH_MS = 30.4375 * 24 * 3600 * 1000;

/** How much space is held by files of each age (by last modified time; not by use). */
export function ageBuckets(db: any, scanId: number, now: number, filter: FileFilter = {}): AgeBucket[] {
  const edges: { label: string; from: number | null; to: number | null }[] = [
    { label: 'Past month', from: now - MONTH_MS, to: null },
    { label: '1–6 months', from: now - 6 * MONTH_MS, to: now - MONTH_MS },
    { label: '6–12 months', from: now - 12 * MONTH_MS, to: now - 6 * MONTH_MS },
    { label: '1–2 years', from: now - 24 * MONTH_MS, to: now - 12 * MONTH_MS },
    { label: 'Over 2 years', from: null, to: now - 24 * MONTH_MS },
  ];
  const base = buildWhere(scanId, filter);
  return edges.map((e) => {
    const parts = [base.sql];
    const params = [...base.params];
    if (e.from !== null) {
      parts.push('mtime >= ?');
      params.push(e.from);
    }
    if (e.to !== null) {
      parts.push('mtime < ?');
      params.push(e.to);
    }
    const r = db
      .prepare(`SELECT COUNT(*) AS files, COALESCE(SUM(stored_size), 0) AS bytes FROM inventory_files WHERE ${parts.join(' AND ')}`)
      .get(...params);
    return { label: e.label, files: r.files, bytes: r.bytes, older_than: e.to };
  });
}

/** Every folder that has files beneath it, including all ancestors (for "does this folder exist" checks). */
export function directorySet(db: any, scanId: number): Set<string> {
  const dirs = new Set<string>();
  for (const { dir } of db.prepare('SELECT DISTINCT dir FROM inventory_files WHERE scan_id = ?').all(scanId)) {
    let cur: string = dir;
    for (let guard = 0; guard < 200 && !dirs.has(pathKey(cur)); guard++) {
      dirs.add(pathKey(cur));
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return dirs;
}
