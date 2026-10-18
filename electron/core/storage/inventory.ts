import path from 'node:path';
import { extensionToKind, type FileKind } from '../models';
import { SKIPPED_SYSTEM_DIR_NAMES } from '../paths';
import { walkFiles, errMessage } from '../walk';

export interface InvFile {
  path: string;
  dir: string;
  root: string;
  name: string;
  /** Lower-case, no dot. */
  ext: string;
  kind: FileKind;
  size: number;
  /** Disk usage this file adds: 0 for the second and later hard links to the same data. */
  storedSize: number;
  links: number;
  mtimeMs: number;
  /** Last access. Unreliable: many systems do not update it. Shown, never used to decide "unused". */
  atimeMs: number;
  birthtimeMs: number;
}

export interface InvProgress {
  phase: 'walking' | 'done';
  filesSeen: number;
  bytesSeen: number;
  currentPath: string | null;
}

export interface InvError {
  path: string;
  error: string;
}

export interface InvOptions {
  roots: string[];
  /** Default true: hidden folders (.git, .cache, ...) are real disk usage. */
  includeHidden?: boolean;
  /** User ignore patterns. */
  isIgnored?: (filePath: string, root: string) => boolean;
  signal?: AbortSignal;
  /** Receives files in batches, so the caller can write them to the database in transactions. */
  onBatch: (files: InvFile[]) => void;
  onProgress?: (progress: InvProgress) => void;
  onError?: (error: InvError) => void;
  batchSize?: number;
}

export interface InvResult {
  cancelled: boolean;
  filesScanned: number;
  dirsScanned: number;
  /** Sum of every file's size (hard links counted each time). */
  logicalBytes: number;
  /** Disk usage: shared (hard-linked) data counted once. */
  storedBytes: number;
  errorCount: number;
}

/**
 * Walk folders and record every file's metadata. Unlike the duplicate scanner this keeps hidden
 * files and dependency folders (they are real storage), skips only protected and system
 * bookkeeping folders, and never opens a file's contents.
 */
export async function scanInventory(options: InvOptions): Promise<InvResult> {
  const batchSize = options.batchSize ?? 1000;
  const result: InvResult = {
    cancelled: false,
    filesScanned: 0,
    dirsScanned: 0,
    logicalBytes: 0,
    storedBytes: 0,
    errorCount: 0,
  };
  const progress: InvProgress = { phase: 'walking', filesSeen: 0, bytesSeen: 0, currentPath: null };
  let lastEmit = 0;
  const emit = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < 100) return;
    lastEmit = now;
    options.onProgress?.({ ...progress });
  };

  // Only files with more than one link need remembering, which keeps this small.
  const countedLinks = new Set<string>();
  let batch: InvFile[] = [];
  const flush = () => {
    if (batch.length === 0) return;
    options.onBatch(batch);
    batch = [];
  };

  for await (const entry of walkFiles({
    roots: options.roots,
    includeHidden: options.includeHidden ?? true,
    skipDirNames: SKIPPED_SYSTEM_DIR_NAMES,
    isIgnored: options.isIgnored,
    signal: options.signal,
    onDirectory: () => {
      result.dirsScanned++;
    },
    onError: (p, err) => {
      result.errorCount++;
      options.onError?.({ path: p, error: errMessage(err) });
    },
  })) {
    const st = entry.stats;
    const size = Number(st.size);
    const links = Number(st.nlink);

    let storedSize = size;
    if (links > 1 && st.ino !== 0n) {
      const key = `${st.dev}:${st.ino}`;
      if (countedLinks.has(key)) storedSize = 0;
      else countedLinks.add(key);
    }

    const ext = path.extname(entry.name).replace(/^\./, '').toLowerCase();
    batch.push({
      path: entry.path,
      dir: entry.dir,
      root: entry.root,
      name: entry.name,
      ext,
      kind: extensionToKind(ext),
      size,
      storedSize,
      links,
      mtimeMs: Number(st.mtimeMs),
      atimeMs: Number(st.atimeMs),
      birthtimeMs: Number(st.birthtimeMs),
    });

    result.filesScanned++;
    result.logicalBytes += size;
    result.storedBytes += storedSize;
    progress.filesSeen = result.filesScanned;
    progress.bytesSeen = result.storedBytes;
    progress.currentPath = entry.path;
    if (batch.length >= batchSize) flush();
    emit();
  }

  if (options.signal?.aborted) {
    result.cancelled = true;
    return result;
  }

  flush();
  progress.phase = 'done';
  progress.currentPath = null;
  emit(true);
  return result;
}
