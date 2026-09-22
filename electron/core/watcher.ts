const chokidar = require('chokidar');
const fs = require('node:fs');
const path = require('node:path');

/** File extensions for temporary/incomplete downloads */
const TEMP_EXTENSIONS = [
  'crdownload',
  'part',
  'partial',
  'tmp',
  'download',
  'opdownload',
];

/** OS-generated files to always ignore */
const IGNORED_FILES = ['.DS_Store', 'desktop.ini', 'Thumbs.db'];

/**
 * Check if a file should be ignored by the watcher.
 */
function shouldIgnoreFile(filePath: string): boolean {
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
 * Reads size/mtime, waits 2 seconds, re-checks, and verifies the file can be opened.
 */
async function isFileStable(filePath: string): Promise<boolean> {
  try {
    const stat1 = fs.statSync(filePath);
    const size1 = stat1.size;
    const mtime1 = stat1.mtimeMs;

    // Wait 2 seconds
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Re-check
    if (!fs.existsSync(filePath)) {
      return false;
    }

    const stat2 = fs.statSync(filePath);
    const size2 = stat2.size;
    const mtime2 = stat2.mtimeMs;

    if (size1 !== size2 || mtime1 !== mtime2) {
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
 * FileFlow itself just created/moved.
 */
class RecentlyWritten {
  private map: Map<string, number>;
  private ttlMs: number;

  constructor(ttlMs: number = 30000) {
    this.map = new Map();
    this.ttlMs = ttlMs;
  }

  /**
   * Register a file path as recently written.
   */
  add(filePath: string): void {
    const normalized = filePath.replace(/\\/g, '/');
    this.map.set(normalized, Date.now());
  }

  /**
   * Check whether a file path was recently written by FileFlow.
   */
  contains(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');
    const timestamp = this.map.get(normalized);
    if (timestamp === undefined) return false;

    if (Date.now() - timestamp > this.ttlMs) {
      this.map.delete(normalized);
      return false;
    }
    return true;
  }

  /**
   * Remove expired entries.
   */
  cleanup(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [key, timestamp] of this.map.entries()) {
      if (timestamp < cutoff) {
        this.map.delete(key);
      }
    }
  }
}

/**
 * Create a chokidar watcher instance.
 *
 * @param onFile - Callback invoked for each new/changed file path
 * @returns The chokidar watcher instance
 */
function createWatcher(
  onFile: (filePath: string) => void
): any {
  const watcher = chokidar.watch([], {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 500,
    },
    // Ignore dot files and common system files
    ignored: [
      /(^|[/\\])\../,
      '**/desktop.ini',
      '**/Thumbs.db',
      '**/.DS_Store',
    ],
  });

  watcher.on('add', (filePath: string) => {
    onFile(filePath);
  });

  watcher.on('change', (filePath: string) => {
    onFile(filePath);
  });

  return watcher;
}

/**
 * Add a folder path to an existing watcher.
 */
function watchFolder(watcher: any, folderPath: string): void {
  watcher.add(folderPath);
}

/**
 * Remove a folder path from an existing watcher.
 */
function unwatchFolder(watcher: any, folderPath: string): void {
  watcher.unwatch(folderPath);
}

module.exports = {
  TEMP_EXTENSIONS,
  IGNORED_FILES,
  shouldIgnoreFile,
  isFileStable,
  RecentlyWritten,
  createWatcher,
  watchFolder,
  unwatchFolder,
};
