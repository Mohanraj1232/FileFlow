import path from 'node:path';
import { pathKey, resolveConflict, type PlannedStep } from './planner';
import { QUARANTINE_DIR_NAME } from './paths';

export type RemoveMode = 'quarantine' | 'trash';

/** "2026-10-18_093015": sortable and filesystem-safe, so a quarantine batch can be dated from its folder name. */
export function quarantineStamp(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '');
}

/** The inverse of quarantineStamp, or null when a folder name is not one. */
export function parseQuarantineStamp(name: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(name);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The scanned folder that contains `filePath`, so quarantine lands on the same volume (an instant rename). */
export function containingRoot(roots: string[], filePath: string): string {
  const key = pathKey(filePath);
  const matches = roots
    .filter((r) => key.startsWith(pathKey(r).replace(/\/+$/, '') + '/'))
    .sort((a, b) => b.length - a.length);
  return matches[0] ?? path.dirname(filePath);
}

export interface RemovalFile {
  path: string;
  name: string;
  size: number;
  mtime: Date;
}

/**
 * Builds the journaled steps that remove files: either a move into a
 * `FileFlow Quarantine/<timestamp>/<bucket>/` folder next to the originals
 * (undoable), or a send to the system trash (not undoable in-app).
 * One planner is used for a whole batch so quarantined names never collide.
 */
export class RemovalPlanner {
  private claimed = new Set<string>();
  private stamp: string;

  constructor(
    private roots: string[],
    private mode: RemoveMode,
    private ruleName: string,
    now: Date = new Date()
  ) {
    this.stamp = quarantineStamp(now);
  }

  /** `bucket` is a short folder name that groups related files (e.g. a duplicate group's hash prefix). */
  async step(file: RemovalFile, bucket: string): Promise<PlannedStep> {
    let dst: string | null = null;
    if (this.mode === 'quarantine') {
      const base = path.join(containingRoot(this.roots, file.path), QUARANTINE_DIR_NAME, this.stamp, bucket);
      dst = (await resolveConflict(path.join(base, file.name), this.claimed, 'auto_rename')).path;
      this.claimed.add(pathKey(dst));
    }

    return {
      rule_id: null,
      rule_name: this.ruleName,
      action_type: this.mode === 'quarantine' ? 'move' : 'trash',
      src_path: file.path,
      dst_path: dst,
      file_size: file.size,
      file_mtime: file.mtime.toISOString().slice(0, 19),
      selected: true,
      policy: 'auto_rename',
    };
  }
}
