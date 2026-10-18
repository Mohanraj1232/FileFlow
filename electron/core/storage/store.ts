import { scanInventory, type InvError, type InvProgress } from './inventory';
import { createScan, insertFiles, insertErrors, finishScan, discardScan } from './repo';

export type RunState = 'running' | 'done' | 'cancelled' | 'failed';

export interface RunningScan {
  /** The scan's id in the database (also what reports use once it is done). */
  id: number;
  roots: string[];
  state: RunState;
  progress: InvProgress | null;
  error: string | null;
  controller: AbortController;
}

export interface StartArgs {
  db: any;
  roots: string[];
  includeHidden?: boolean;
  isIgnored?: (filePath: string, root: string) => boolean;
  /** Called (throttled) while scanning and once when it ends. */
  onUpdate?: (scan: RunningScan) => void;
}

/**
 * Runs one storage scan at a time in the background. Files are written to the database in
 * batches as they are found. The scan only becomes visible (and replaces an earlier scan of the
 * same folders) when it completes; a cancelled or failed scan leaves the old report untouched.
 */
export class StorageScanStore {
  private scans = new Map<number, RunningScan>();

  constructor(private maxRemembered = 10) {}

  get running(): RunningScan | undefined {
    return [...this.scans.values()].find((s) => s.state === 'running');
  }

  start(args: StartArgs): RunningScan {
    if (this.running) throw new Error('A storage scan is already running. Wait for it to finish or cancel it first.');

    const { db } = args;
    const scanId = createScan(db, args.roots);
    const entry: RunningScan = {
      id: scanId,
      roots: args.roots,
      state: 'running',
      progress: null,
      error: null,
      controller: new AbortController(),
    };
    this.scans.set(scanId, entry);
    this.trim();

    const errors: InvError[] = [];
    void (async () => {
      try {
        const result = await scanInventory({
          roots: args.roots,
          includeHidden: args.includeHidden,
          isIgnored: args.isIgnored,
          signal: entry.controller.signal,
          onBatch: (files) => insertFiles(db, scanId, files),
          onError: (e) => {
            if (errors.length < 500) errors.push(e);
          },
          onProgress: (p) => {
            entry.progress = p;
            args.onUpdate?.(entry);
          },
        });

        if (result.cancelled) {
          discardScan(db, scanId);
          entry.state = 'cancelled';
        } else {
          insertErrors(db, scanId, errors);
          finishScan(db, scanId, {
            fileCount: result.filesScanned,
            dirCount: result.dirsScanned,
            storedBytes: result.storedBytes,
            logicalBytes: result.logicalBytes,
            errorCount: result.errorCount,
          });
          entry.state = 'done';
        }
      } catch (err) {
        try {
          discardScan(db, scanId);
        } catch {
          /* database may already be closed during shutdown */
        }
        entry.state = 'failed';
        entry.error = err instanceof Error ? err.message : String(err);
      } finally {
        args.onUpdate?.(entry);
      }
    })();

    return entry;
  }

  get(id: number): RunningScan | undefined {
    return this.scans.get(id);
  }

  cancel(id: number): boolean {
    const scan = this.scans.get(id);
    if (!scan || scan.state !== 'running') return false;
    scan.controller.abort();
    return true;
  }

  private trim(): void {
    while (this.scans.size > this.maxRemembered) {
      const oldest = [...this.scans.values()].find((s) => s.state !== 'running');
      if (!oldest) return;
      this.scans.delete(oldest.id);
    }
  }
}
