import chokidar, { type FSWatcher } from 'chokidar';
import fs from 'node:fs';
import path from 'node:path';
import { pathKey } from './planner';

/** File extensions for temporary/incomplete downloads */
export const TEMP_EXTENSIONS = [
  'crdownload',
  'part',
  'partial',
  'tmp',
  'download',
  'opdownload',
];

/** OS-generated files to always ignore */
export const IGNORED_FILES = ['.DS_Store', 'desktop.ini', 'Thumbs.db'];

/** Directory names never worth descending into (watching or scanning). */
export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-electron',
  'build',
  'release',
  '__pycache__',
  'vendor',
  'Pods',
  'DerivedData',
  '.build',
]);

/** How deep a recursive watched folder is traversed (EMFILE protection). */
export const RECURSIVE_WATCH_DEPTH = 3;

/**
 * Shared watching-enabled state. This is the single source of truth for
 * whether the watcher should act on detected files — both the IPC handlers
 * (start_watching/stop_watching) and the main process's file-detection
 * callback read/write this.
 */
let watchingEnabled = false;

export function isWatchingEnabled(): boolean {
  return watchingEnabled;
}

export function setWatchingEnabled(enabled: boolean): void {
  watchingEnabled = enabled;
}

/**
 * Check if a file should be ignored by the watcher.
 */
export function shouldIgnoreFile(filePath: string): boolean {
  const baseName = path.basename(filePath);

  // Check ignored OS files
  if (IGNORED_FILES.includes(baseName)) {
    return true;
  }

  // Check temp/lock prefix (e.g. ~$document.docx)
  if (baseName.startsWith('~$')) {
    return true;
  }

  // Check temp extensions
  const ext = path.extname(baseName).replace(/^\./, '').toLowerCase();
  if (TEMP_EXTENSIONS.includes(ext)) {
    return true;
  }

  return false;
}

/**
 * Check if a file has stabilized (finished writing).
 * Reads size/mtime, waits, re-checks, and verifies the file can be opened.
 */
export async function isFileStable(filePath: string, waitMs = 2000): Promise<boolean> {
  try {
    const stat1 = fs.statSync(filePath);
    const size1 = stat1.size;
    const mtime1 = stat1.mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, waitMs));

    if (!fs.existsSync(filePath)) {
      return false;
    }

    const stat2 = fs.statSync(filePath);
    if (size1 !== stat2.size || mtime1 !== stat2.mtimeMs) {
      return false;
    }

    // Try to open the file to verify it's not locked
    let fd: number | null = null;
    try {
      fd = fs.openSync(filePath, 'r');
      return true;
    } catch {
      return false;
    } finally {
      if (fd !== null) {
        fs.closeSync(fd);
      }
    }
  } catch {
    return false;
  }
}

/**
 * Tracks recently written files to prevent re-processing files that
 * FileFlow itself just created/moved/restored.
 */
export class RecentlyWritten {
  private map: Map<string, number>;
  private ttlMs: number;

  constructor(ttlMs: number = 30000) {
    this.map = new Map();
    this.ttlMs = ttlMs;
  }

  /** Register a file path as recently written. */
  add(filePath: string): void {
    this.map.set(pathKey(filePath), Date.now());
  }

  /** Check whether a file path was recently written by FileFlow. */
  contains(filePath: string): boolean {
    const key = pathKey(filePath);
    const timestamp = this.map.get(key);
    if (timestamp === undefined) return false;

    if (Date.now() - timestamp > this.ttlMs) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  /** Remove expired entries. */
  cleanup(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [key, timestamp] of this.map.entries()) {
      if (timestamp < cutoff) {
        this.map.delete(key);
      }
    }
  }
}

export interface WatchTarget {
  id: number;
  path: string;
  recursive: boolean;
}

export type OnWatchedFile = (filePath: string, folder: WatchTarget) => void | Promise<void>;

/**
 * Loop circuit breaker: if the same path is reported more than `max` times in
 * `windowMs`, something is feeding its own output back in. Stop processing it.
 */
export class LoopGuard {
  private hits = new Map<string, number[]>();

  constructor(
    private max = 3,
    private windowMs = 10 * 60 * 1000
  ) {}

  /** Returns true when this path is allowed through. */
  allow(filePath: string, now = Date.now()): boolean {
    const key = pathKey(filePath);
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}

/**
 * Owns one chokidar watcher per watched folder, so each folder gets its own
 * depth (top level only, or a bounded recursion) and can be removed
 * independently. All detected files go through a single serialized queue.
 */
export class WatcherManager {
  private watchers = new Map<string, { watcher: FSWatcher; folder: WatchTarget }>();
  private queue: Promise<void> = Promise.resolve();
  private guard = new LoopGuard();

  constructor(
    private onFile: OnWatchedFile,
    private shouldIgnore?: (filePath: string, folder: WatchTarget) => boolean
  ) {}

  /** Start watching a folder (no-op if it is already watched). */
  add(folder: WatchTarget): void {
    const key = pathKey(folder.path);
    if (this.watchers.has(key)) return;

    const watcher = chokidar.watch(folder.path, {
      persistent: true,
      ignoreInitial: true,
      followSymlinks: false,
      depth: folder.recursive ? RECURSIVE_WATCH_DEPTH : 0,
      awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: 500,
      },
      // chokidar v4 has no glob support, so ignore rules are a function.
      ignored: (p: string) => {
        const base = path.basename(p);
        if (p !== folder.path && base.startsWith('.')) return true;
        if (IGNORED_DIRS.has(base)) return true;
        if (this.shouldIgnore && p !== folder.path && this.shouldIgnore(p, folder)) return true;
        return false;
      },
    });

    // Serialize processing: two files landing close together must not be
    // planned concurrently, or both could pick the same destination name.
    // Only 'add' is handled — a 'change' on an already-sorted file must not
    // send it round the pipeline again.
    watcher.on('add', (filePath: string) => this.enqueue(filePath, folder));
    watcher.on('error', (err: unknown) => {
      console.error(`Watcher error in ${folder.path}:`, err);
    });

    this.watchers.set(key, { watcher, folder });
  }

  /** Stop watching a folder. */
  async remove(folderPath: string): Promise<void> {
    const key = pathKey(folderPath);
    const entry = this.watchers.get(key);
    if (!entry) return;
    this.watchers.delete(key);
    await entry.watcher.close();
  }

  async close(): Promise<void> {
    const all = [...this.watchers.values()];
    this.watchers.clear();
    await Promise.all(all.map((e) => e.watcher.close()));
  }

  /** Number of folders currently watched. */
  get size(): number {
    return this.watchers.size;
  }

  private enqueue(filePath: string, folder: WatchTarget): void {
    if (!this.guard.allow(filePath)) {
      console.warn(`Loop guard: ignoring ${filePath} (reported too often)`);
      return;
    }
    this.queue = this.queue
      .then(() => this.onFile(filePath, folder))
      .catch((err) => {
        console.error(`Error processing watched file ${filePath}:`, err);
      });
  }
}

export function createWatcher(
  onFile: OnWatchedFile,
  shouldIgnore?: (filePath: string, folder: WatchTarget) => boolean
): WatcherManager {
  return new WatcherManager(onFile, shouldIgnore);
}
