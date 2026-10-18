import type {
  StorageFile,
  StorageFileFilter,
  StorageScanSummary,
} from '../../shared/contract';
import type { FileRow, FileFilter, ScanRow } from './repo';
import type { RunningScan } from './store';

const iso = (ms: number | null) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

export function toFileDto(r: FileRow): StorageFile {
  return {
    id: r.id,
    path: r.path,
    name: r.name,
    dir: r.dir,
    ext: r.ext,
    kind: r.kind as StorageFile['kind'],
    size: r.size,
    stored_size: r.stored_size,
    links: r.links,
    modified_at: new Date(r.mtime).toISOString(),
    accessed_at: iso(r.atime),
  };
}

/** A finished scan, from its database row. */
export function rowToSummary(row: ScanRow): StorageScanSummary {
  return {
    scan_id: row.id,
    roots: row.roots,
    state: 'done',
    started_at: row.started_at,
    finished_at: row.finished_at,
    file_count: row.file_count,
    dir_count: row.dir_count,
    stored_bytes: row.stored_bytes,
    logical_bytes: row.logical_bytes,
    error_count: row.error_count,
    progress: null,
    error: null,
  };
}

/** A scan that is running, or ended without producing a report (cancelled / failed). */
export function runningToSummary(s: RunningScan): StorageScanSummary {
  const p = s.progress;
  return {
    scan_id: s.id,
    roots: s.roots,
    state: s.state,
    started_at: null,
    finished_at: null,
    file_count: p?.filesSeen ?? 0,
    dir_count: 0,
    stored_bytes: p?.bytesSeen ?? 0,
    logical_bytes: p?.bytesSeen ?? 0,
    error_count: 0,
    progress: p
      ? { phase: p.phase, files_seen: p.filesSeen, bytes_seen: p.bytesSeen, current_path: p.currentPath }
      : null,
    error: s.error,
  };
}

const KINDS = ['document', 'image', 'video', 'audio', 'archive', 'code', 'installer', 'other'];

function dateMs(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** Turn renderer input into a safe filter. Unknown fields are dropped; bad values are ignored. */
export function parseFilter(raw: unknown): FileFilter {
  const r = (raw && typeof raw === 'object' ? raw : {}) as StorageFileFilter;
  const filter: FileFilter = {};
  if (typeof r.folder === 'string' && r.folder) filter.folder = r.folder;
  if (Array.isArray(r.kinds)) filter.kinds = r.kinds.filter((k) => KINDS.includes(k));
  if (typeof r.ext === 'string' && r.ext.trim()) filter.ext = r.ext.trim().slice(0, 32);
  filter.min_size = num(r.min_size);
  filter.max_size = num(r.max_size);
  filter.modified_before = dateMs(r.modified_before);
  filter.modified_after = dateMs(r.modified_after);
  if (typeof r.name_contains === 'string' && r.name_contains.trim()) filter.name_contains = r.name_contains.trim().slice(0, 200);
  for (const k of Object.keys(filter) as (keyof FileFilter)[]) if (filter[k] === undefined) delete filter[k];
  return filter;
}
