import fs from 'node:fs';
import path from 'node:path';
import { hashFile, hashHead, HashAbortedError } from '../hash';
import { pathKey } from '../planner';
import { shouldIgnoreFile } from '../watcher';
import { isProtectedPath, SKIPPED_SYSTEM_DIR_NAMES, QUARANTINE_DIR_NAME } from '../paths';

/** Files at or below this size are hashed once, in full; larger ones get a cheap head hash first. */
export const HEAD_BYTES = 64 * 1024;

/** Folders that are never worth scanning for duplicates (dependency and build caches). */
const SKIPPED_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  '__pycache__',
  'Pods',
  'DerivedData',
  '.build',
  QUARANTINE_DIR_NAME,
  ...SKIPPED_SYSTEM_DIR_NAMES,
]);

export interface DupFile {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
  /** Identifies the underlying data. Hard links to one file share a key. */
  linkKey: string;
  /** 'computed' = hashed during this scan; 'cached' = reused from an earlier scan (size and mtime unchanged). */
  hashSource: 'computed' | 'cached';
}

export interface DupGroup {
  hash: string;
  size: number;
  /** Oldest first. */
  files: DupFile[];
  /** Space freed by keeping one copy: size x (distinct stored copies - 1). Hard links free nothing. */
  reclaimableBytes: number;
}

export type ScanPhase = 'walking' | 'comparing' | 'hashing' | 'done';

export interface ScanProgress {
  phase: ScanPhase;
  filesSeen: number;
  bytesSeen: number;
  /** Files that share a size with another file and may need hashing. */
  candidateFiles: number;
  hashedFiles: number;
  hashedBytes: number;
  totalHashBytes: number;
  currentPath: string | null;
}

export interface ScanError {
  path: string;
  error: string;
}

export interface ScanStats {
  filesScanned: number;
  bytesScanned: number;
  candidateFiles: number;
  filesHashed: number;
  filesFromCache: number;
  bytesHashed: number;
  groups: number;
  duplicateFiles: number;
  reclaimableBytes: number;
  errors: ScanError[];
}

export interface ScanResult {
  groups: DupGroup[];
  stats: ScanStats;
  cancelled: boolean;
}

/** Remembers full hashes between scans, keyed by path and validated by size + mtime. */
export interface HashCache {
  get(filePath: string, size: number, mtimeMs: number): string | undefined;
  put(filePath: string, size: number, mtimeMs: number, hash: string): void;
}

export interface ScanOptions {
  roots: string[];
  /** Files smaller than this are ignored. Default 1 (empty files are never duplicates worth reporting). */
  minSize?: number;
  includeHidden?: boolean;
  /** User ignore patterns. */
  isIgnored?: (filePath: string, root: string) => boolean;
  signal?: AbortSignal;
  cache?: HashCache;
  onProgress?: (progress: ScanProgress) => void;
  /** Parallel full-file hashes. Kept low: this is disk-bound work. */
  hashConcurrency?: number;
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

function errMessage(err: unknown): string {
  const e = err as NodeJS.ErrnoException;
  return e?.code ? `${e.code}: ${e.message}` : String((err as Error)?.message ?? err);
}

/** Run `fn` over `items` with at most `limit` in flight, stopping early on abort. */
async function runPool<T>(
  items: T[],
  limit: number,
  signal: AbortSignal | undefined,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !signal?.aborted) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, limit) }, worker));
}

/**
 * Find files with byte-identical content.
 *
 * Pipeline (each stage only runs on what the previous one could not rule out):
 *   1. walk the folders and group files by size   — a unique size cannot be a duplicate
 *   2. hash the first 64 KB of same-size files    — cheap filter for large files
 *   3. full streaming SHA-256 of what is left     — the actual proof of equality
 * Two files are duplicates only if their full SHA-256 hashes match. Names and
 * sizes alone never make a duplicate. Symlinks are never followed, and hard
 * links to the same data are recognised so they are not counted as savings.
 */
export async function scanDuplicates(options: ScanOptions): Promise<ScanResult> {
  const { signal, cache, onProgress } = options;
  const minSize = Math.max(1, options.minSize ?? 1);
  const concurrency = options.hashConcurrency ?? 2;

  const stats: ScanStats = {
    filesScanned: 0,
    bytesScanned: 0,
    candidateFiles: 0,
    filesHashed: 0,
    filesFromCache: 0,
    bytesHashed: 0,
    groups: 0,
    duplicateFiles: 0,
    reclaimableBytes: 0,
    errors: [],
  };

  const progress: ScanProgress = {
    phase: 'walking',
    filesSeen: 0,
    bytesSeen: 0,
    candidateFiles: 0,
    hashedFiles: 0,
    hashedBytes: 0,
    totalHashBytes: 0,
    currentPath: null,
  };
  let lastEmit = 0;
  const emit = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < 100) return;
    lastEmit = now;
    onProgress?.({ ...progress });
  };
  const fail = (filePath: string, err: unknown) => stats.errors.push({ path: filePath, error: errMessage(err) });
  const cancelled = () => !!signal?.aborted;

  // ---- 1. walk ---------------------------------------------------------
  const bySize = new Map<number, DupFile[]>();
  const seen = new Set<string>();

  const walk = async (root: string) => {
    const stack: string[] = [root];
    let counter = 0;

    while (stack.length && !cancelled()) {
      const dir = stack.pop()!;
      let handle: fs.Dir;
      try {
        handle = await fs.promises.opendir(dir);
      } catch (err) {
        fail(dir, err);
        continue;
      }

      try {
        for await (const entry of handle) {
          if (cancelled()) break;
          if (++counter % 200 === 0) await yieldToEventLoop();

          const full = path.join(dir, entry.name);
          if (!options.includeHidden && entry.name.startsWith('.')) continue;

          // Classify with lstat rather than the Dirent type: lstat never follows a link, and
          // it reports Windows junctions as links, which the directory-entry type from
          // opendir does not reliably do (a junction was followed out of the scanned folder
          // on Windows CI). Links are never followed; their targets are not part of the scan.
          let st: fs.BigIntStats;
          try {
            st = await fs.promises.lstat(full, { bigint: true });
          } catch (err) {
            fail(full, err);
            continue;
          }
          if (st.isSymbolicLink()) continue;

          if (st.isDirectory()) {
            if (SKIPPED_DIR_NAMES.has(entry.name)) continue;
            if (isProtectedPath(full)) continue;
            if (options.isIgnored?.(full, root)) continue;
            stack.push(full);
          } else if (st.isFile()) {
            if (shouldIgnoreFile(full)) continue;
            if (options.isIgnored?.(full, root)) continue;
            const key = pathKey(full);
            if (seen.has(key)) continue; // overlapping roots
            seen.add(key);

            const size = Number(st.size);
            if (size < minSize) continue;

            progress.filesSeen++;
            progress.bytesSeen += size;
            stats.filesScanned++;
            stats.bytesScanned += size;
            progress.currentPath = full;
            emit();

            const dup: DupFile = {
              path: full,
              name: entry.name,
              size,
              mtimeMs: Number(st.mtimeMs),
              linkKey: st.ino !== 0n ? `${st.dev}:${st.ino}` : `path:${key}`,
              hashSource: 'computed',
            };
            const bucket = bySize.get(size);
            if (bucket) bucket.push(dup);
            else bySize.set(size, [dup]);
          }
        }
      } catch (err) {
        fail(dir, err);
      } finally {
        await handle.close().catch(() => undefined);
      }
    }
  };

  for (const root of options.roots) {
    if (cancelled()) break;
    await walk(root);
  }
  if (cancelled()) return { groups: [], stats, cancelled: true };

  // ---- 2. same-size candidates ----------------------------------------
  progress.phase = 'comparing';
  emit(true);

  const distinctStorage = (files: DupFile[]) => new Set(files.map((f) => f.linkKey)).size;
  let candidates: DupFile[][] = [];
  for (const bucket of bySize.values()) {
    // Needs at least two distinct stored copies; hard links of one file are not duplicates.
    if (distinctStorage(bucket) >= 2) candidates.push(bucket);
  }
  stats.candidateFiles = candidates.reduce((n, b) => n + b.length, 0);
  progress.candidateFiles = stats.candidateFiles;

  // Hash one representative per distinct stored copy; hard links share the result.
  const representatives = (files: DupFile[]) => {
    const byLink = new Map<string, DupFile[]>();
    for (const f of files) {
      const list = byLink.get(f.linkKey);
      if (list) list.push(f);
      else byLink.set(f.linkKey, [f]);
    }
    return byLink;
  };

  // Cheap head hash for large files, to rule out most same-size files without reading them fully.
  const headFiltered: DupFile[][] = [];
  for (const bucket of candidates) {
    if (cancelled()) break;
    const size = bucket[0].size;
    if (size <= HEAD_BYTES) {
      headFiltered.push(bucket);
      continue;
    }

    const links = representatives(bucket);
    const headOf = new Map<string, string>();
    const reps = [...links.values()].map((files) => files[0]);
    await runPool(reps, concurrency, signal, async (rep) => {
      try {
        headOf.set(rep.linkKey, await hashHead(rep.path, HEAD_BYTES));
        progress.currentPath = rep.path;
        emit();
      } catch (err) {
        fail(rep.path, err);
      }
    });

    const byHead = new Map<string, DupFile[]>();
    for (const [linkKey, files] of links) {
      const head = headOf.get(linkKey);
      if (!head) continue; // unreadable: already reported
      const list = byHead.get(head);
      if (list) list.push(...files);
      else byHead.set(head, [...files]);
    }
    for (const files of byHead.values()) {
      if (distinctStorage(files) >= 2) headFiltered.push(files);
    }
  }
  if (cancelled()) return { groups: [], stats, cancelled: true };

  // ---- 3. full hash ----------------------------------------------------
  progress.phase = 'hashing';
  const toHash: DupFile[] = [];
  for (const bucket of headFiltered) {
    for (const files of representatives(bucket).values()) toHash.push(files[0]);
  }
  progress.totalHashBytes = toHash.reduce((n, f) => n + f.size, 0);
  emit(true);

  const hashOfLink = new Map<string, { hash: string; source: 'computed' | 'cached' }>();
  await runPool(toHash, concurrency, signal, async (rep) => {
    progress.currentPath = rep.path;
    try {
      const cached = cache?.get(rep.path, rep.size, rep.mtimeMs);
      let hash: string;
      let source: 'computed' | 'cached';
      if (cached) {
        hash = cached;
        source = 'cached';
        stats.filesFromCache++;
      } else {
        hash = await hashFile(rep.path, signal);
        source = 'computed';
        stats.filesHashed++;
        stats.bytesHashed += rep.size;

        // The file must not have changed while it was being read.
        const after = await fs.promises.stat(rep.path, { bigint: true });
        if (Number(after.size) !== rep.size || Number(after.mtimeMs) !== rep.mtimeMs) {
          throw new Error('File changed while it was being scanned');
        }
        cache?.put(rep.path, rep.size, rep.mtimeMs, hash);
      }
      hashOfLink.set(rep.linkKey, { hash, source });
    } catch (err) {
      if (err instanceof HashAbortedError) return;
      fail(rep.path, err);
    } finally {
      progress.hashedFiles++;
      progress.hashedBytes += rep.size;
      emit();
    }
  });
  if (cancelled()) return { groups: [], stats, cancelled: true };

  // ---- 4. group by hash ------------------------------------------------
  const byHash = new Map<string, DupFile[]>();
  for (const bucket of headFiltered) {
    for (const file of bucket) {
      const entry = hashOfLink.get(file.linkKey);
      if (!entry) continue;
      file.hashSource = entry.source;
      const key = `${file.size}:${entry.hash}`;
      const list = byHash.get(key);
      if (list) list.push(file);
      else byHash.set(key, [file]);
    }
  }

  const groups: DupGroup[] = [];
  for (const [key, files] of byHash) {
    const copies = distinctStorage(files);
    if (copies < 2) continue;
    const size = files[0].size;
    files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
    groups.push({
      hash: key.slice(key.indexOf(':') + 1),
      size,
      files,
      reclaimableBytes: size * (copies - 1),
    });
  }
  groups.sort((a, b) => b.reclaimableBytes - a.reclaimableBytes || a.hash.localeCompare(b.hash));

  stats.groups = groups.length;
  stats.duplicateFiles = groups.reduce((n, g) => n + g.files.length - 1, 0);
  stats.reclaimableBytes = groups.reduce((n, g) => n + g.reclaimableBytes, 0);

  progress.phase = 'done';
  progress.currentPath = null;
  emit(true);
  return { groups, stats, cancelled: false };
}
