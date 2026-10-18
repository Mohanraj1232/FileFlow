import crypto from 'node:crypto';
import { rootsKey } from '../paths';
import { scanDuplicates, type DupGroup, type HashCache, type ScanProgress, type ScanResult, type ScanOptions } from './scan';

/**
 * Remembers full-file hashes between scans in the existing `file_index`
 * table. An entry is only trusted when path, size and modification time all
 * still match. The cache only ever speeds up *finding* duplicates: before any
 * file is removed, resolve re-hashes it from disk, so a stale or tampered
 * entry can never cause data loss.
 */
export class DbHashCache implements HashCache {
  constructor(private db: any) {}

  get(filePath: string, size: number, mtimeMs: number): string | undefined {
    const row = this.db
      .prepare('SELECT size, mtime, hash FROM file_index WHERE path = ?')
      .get(filePath);
    if (!row || !row.hash) return undefined;
    return row.size === size && row.mtime === String(Math.trunc(mtimeMs)) ? row.hash : undefined;
  }

  put(filePath: string, size: number, mtimeMs: number, hash: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO file_index (path, size, mtime, hash) VALUES (?, ?, ?, ?)')
      .run(filePath, size, String(Math.trunc(mtimeMs)), hash);
  }
}

/** Forget every remembered hash (also used by the privacy controls added later). */
export function clearHashCache(db: any): number {
  return db.prepare('DELETE FROM file_index').run().changes;
}

export type ScanState = 'running' | 'done' | 'cancelled' | 'failed';

export interface ScanEntry {
  id: string;
  roots: string[];
  state: ScanState;
  progress: ScanProgress | null;
  /** Present once the scan finished; files acted on are removed from it. */
  result: ScanResult | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  controller: AbortController;
}

export interface StartScanArgs extends Omit<ScanOptions, 'signal' | 'cache' | 'onProgress'> {
  db?: any;
  /** Called (throttled) while the scan runs, and once more when it ends. */
  onUpdate?: (entry: ScanEntry) => void;
}

/**
 * Holds duplicate scans in the main process. The renderer only ever refers to
 * a scan by id, and removal only acts on files this store found — it never
 * trusts paths sent from the UI.
 */
export class DuplicateScanStore {
  private scans = new Map<string, ScanEntry>();

  constructor(
    private ttlMs = 2 * 60 * 60 * 1000,
    private maxEntries = 5
  ) {}

  get running(): ScanEntry | undefined {
    return [...this.scans.values()].find((s) => s.state === 'running');
  }

  /** Start a scan in the background and return immediately. */
  start(args: StartScanArgs): ScanEntry {
    if (this.running) {
      throw new Error('A duplicate scan is already running. Wait for it to finish or cancel it first.');
    }
    this.sweep();

    const entry: ScanEntry = {
      id: crypto.randomUUID(),
      roots: args.roots,
      state: 'running',
      progress: null,
      result: null,
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
      controller: new AbortController(),
    };
    this.scans.set(entry.id, entry);

    const { db, onUpdate, ...scanArgs } = args;
    void scanDuplicates({
      ...scanArgs,
      signal: entry.controller.signal,
      cache: db ? new DbHashCache(db) : undefined,
      onProgress: (p) => {
        entry.progress = p;
        onUpdate?.(entry);
      },
    })
      .then((result) => {
        entry.result = result.cancelled ? null : result;
        entry.state = result.cancelled ? 'cancelled' : 'done';
      })
      .catch((err) => {
        entry.state = 'failed';
        entry.error = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        entry.finishedAt = Date.now();
        onUpdate?.(entry);
      });

    return entry;
  }

  get(id: string): ScanEntry | undefined {
    return this.scans.get(id);
  }

  /** The most recent finished scan of exactly this set of folders, if one is still held. */
  latestDoneFor(roots: string[]): ScanEntry | undefined {
    const key = rootsKey(roots);
    return [...this.scans.values()]
      .filter((s) => s.state === 'done' && s.result && rootsKey(s.roots) === key)
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0];
  }

  /** Cancel a running scan. Its partial findings are discarded. */
  cancel(id: string): boolean {
    const entry = this.scans.get(id);
    if (!entry || entry.state !== 'running') return false;
    entry.controller.abort();
    return true;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, s] of this.scans) {
      if (s.state !== 'running' && now - (s.finishedAt ?? s.startedAt) > this.ttlMs) this.scans.delete(id);
    }
    while (this.scans.size >= this.maxEntries) {
      const oldestFinished = [...this.scans.values()]
        .filter((s) => s.state !== 'running')
        .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))[0];
      if (!oldestFinished) break;
      this.scans.delete(oldestFinished.id);
    }
  }
}

/**
 * Drop files that were removed from a finished scan's results and recompute
 * what is left, so the UI never offers a file that is gone.
 */
export function removeFromResult(entry: ScanEntry, removedPaths: Set<string>): void {
  if (!entry.result) return;
  const groups: DupGroup[] = [];

  for (const group of entry.result.groups) {
    const files = group.files.filter((f) => !removedPaths.has(f.path));
    const copies = new Set(files.map((f) => f.linkKey)).size;
    if (copies < 2) continue;
    groups.push({ ...group, files, reclaimableBytes: group.size * (copies - 1) });
  }

  entry.result = {
    ...entry.result,
    groups,
    stats: {
      ...entry.result.stats,
      groups: groups.length,
      duplicateFiles: groups.reduce((n, g) => n + g.files.length - 1, 0),
      reclaimableBytes: groups.reduce((n, g) => n + g.reclaimableBytes, 0),
    },
  };
}
