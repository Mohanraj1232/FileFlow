import fs from 'node:fs';
import path from 'node:path';
import { pathKey } from './planner';
import { isProtectedPath } from './paths';

/** Let timers, IPC and rendering run; called every few hundred entries during long walks. */
export const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** "EACCES: permission denied..." style message for an error shown to the user. */
export function errMessage(err: unknown): string {
  const e = err as NodeJS.ErrnoException;
  return e?.code ? `${e.code}: ${e.message}` : String((err as Error)?.message ?? err);
}

export interface WalkEntry {
  path: string;
  name: string;
  /** Containing folder. */
  dir: string;
  /** The folder the user chose that this file was found under. */
  root: string;
  /** lstat result (bigint, so inode numbers are exact). Never a link. */
  stats: fs.BigIntStats;
}

export interface WalkOptions {
  roots: string[];
  includeHidden: boolean;
  /** Folder names never entered. */
  skipDirNames?: ReadonlySet<string>;
  /** Return true to leave a file out. */
  skipFile?: (name: string, fullPath: string) => boolean;
  /** User ignore patterns, tested against both folders and files. */
  isIgnored?: (fullPath: string, root: string) => boolean;
  signal?: AbortSignal;
  /** An unreadable folder or file: reported, never fatal. */
  onError: (filePath: string, err: unknown) => void;
  /** Every folder that was entered, including each root. */
  onDirectory?: (dir: string) => void;
}

/**
 * Walk folders and yield every regular file, safely.
 *
 * - Entries are classified with lstat, never the directory-entry type: lstat does
 *   not follow links and reports Windows junctions as links, which the type from
 *   opendir does not reliably do. A junction was once followed out of the scanned
 *   folder because of that. Symlinks and junctions are never followed.
 * - Protected system folders are never entered.
 * - A file reachable through overlapping roots is yielded once.
 * - Unreadable entries are reported through onError and skipped.
 * - The event loop is yielded to regularly, and the walk stops promptly on abort.
 */
export async function* walkFiles(options: WalkOptions): AsyncGenerator<WalkEntry> {
  const { signal } = options;
  const seen = new Set<string>();
  let counter = 0;

  for (const root of options.roots) {
    const stack: string[] = [root];

    while (stack.length && !signal?.aborted) {
      const dir = stack.pop()!;
      let handle: fs.Dir;
      try {
        handle = await fs.promises.opendir(dir);
      } catch (err) {
        options.onError(dir, err);
        continue;
      }
      options.onDirectory?.(dir);

      try {
        for await (const entry of handle) {
          if (signal?.aborted) break;
          if (++counter % 200 === 0) await yieldToEventLoop();

          if (!options.includeHidden && entry.name.startsWith('.')) continue;
          const full = path.join(dir, entry.name);

          let stats: fs.BigIntStats;
          try {
            stats = await fs.promises.lstat(full, { bigint: true });
          } catch (err) {
            options.onError(full, err);
            continue;
          }
          if (stats.isSymbolicLink()) continue;

          if (stats.isDirectory()) {
            if (options.skipDirNames?.has(entry.name)) continue;
            if (isProtectedPath(full)) continue;
            if (options.isIgnored?.(full, root)) continue;
            stack.push(full);
          } else if (stats.isFile()) {
            if (options.skipFile?.(entry.name, full)) continue;
            if (options.isIgnored?.(full, root)) continue;
            const key = pathKey(full);
            if (seen.has(key)) continue;
            seen.add(key);
            yield { path: full, name: entry.name, dir, root, stats };
          }
        }
      } catch (err) {
        options.onError(dir, err);
      } finally {
        await handle.close().catch(() => undefined);
      }
    }
  }
}
