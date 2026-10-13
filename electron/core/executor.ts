import fs from 'node:fs';
import path from 'node:path';
import * as journal from './journal';
import { hashFile } from './hash';
import { resolveConflict, samePath, type PlannedStep } from './planner';

/** Minimal surface of the RecentlyWritten tracker the executor needs. */
export interface WrittenTracker {
  add(filePath: string): void;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Move a file without ever replacing an existing one.
 *
 * Same-volume moves use rename. A cross-device move (EXDEV) copies with
 * COPYFILE_EXCL, verifies the copy by SHA-256 (size alone can miss corruption),
 * preserves the modification time, and only then removes the original.
 *
 * Callers are responsible for checking that `dst` is free first; the EXCL
 * flag on the copy path is a second line of defence, not the only one.
 */
export async function executeMove(src: string, dst: string): Promise<void> {
  ensureDir(path.dirname(dst));

  try {
    fs.renameSync(src, dst);
  } catch (err: any) {
    if (err.code !== 'EXDEV') throw err;

    fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
    try {
      const [srcHash, dstHash] = await Promise.all([hashFile(src), hashFile(dst)]);
      if (srcHash !== dstHash) {
        throw new Error('Cross-device move verification failed: content hash mismatch');
      }
      const srcStat = fs.statSync(src);
      fs.utimesSync(dst, srcStat.atime, srcStat.mtime);
    } catch (verifyErr) {
      // Remove only the copy WE just made; the original is untouched.
      try {
        fs.unlinkSync(dst);
      } catch {
        // ignore cleanup error
      }
      throw verifyErr;
    }
    fs.unlinkSync(src);
  }
}

/**
 * Copy a file. Fails (EEXIST) rather than overwrite an existing destination.
 */
export function executeCopy(src: string, dst: string): void {
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
}

/**
 * Send a file to the OS trash / recycle bin using the ESM-only `trash` package.
 * A real dynamic import() is required: trash is ESM-only and cannot be require()d.
 */
export async function executeTrash(src: string): Promise<void> {
  const { default: trash } = await import('trash');
  await trash([src]);
}

/**
 * Has the source changed since the plan was made? Returns a reason string
 * when the step must NOT run, or null when it is safe to proceed.
 */
function checkSource(step: PlannedStep): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(step.src_path);
  } catch (err: any) {
    return err.code === 'ENOENT'
      ? 'Source file no longer exists'
      : `Source not accessible: ${err.message}`;
  }
  if (!stat.isFile()) return 'Source is no longer a regular file';
  if (stat.size !== step.file_size) return 'File size changed since it was planned';
  if (step.file_mtime && stat.mtime.toISOString().slice(0, 19) !== step.file_mtime) {
    return 'File was modified since it was planned';
  }
  return null;
}

/**
 * Execute a full plan of steps, journaling each one.
 *
 * Every step is re-validated immediately before it runs: the source must still
 * match what was planned, and if the destination has been taken in the
 * meantime the step either skips (policy "skip") or picks a fresh unique name.
 * Existing files are never overwritten.
 *
 * @param source - where this operation originated (e.g. "manual:folder:3", "watcher")
 * @returns The operation ID from the journal
 */
export async function executePlan(
  db: any,
  steps: PlannedStep[],
  source: string,
  recentlyWritten?: WrittenTracker | null
): Promise<number> {
  const operationId = journal.createOperation(db, source);
  const runnable = steps.filter((s) => s.action_type !== 'skip');

  for (let i = 0; i < runnable.length; i++) {
    const step = runnable[i];
    const stepId = journal.createStepPending(db, {
      operationId,
      seq: i + 1,
      ruleId: step.rule_id,
      actionType: step.action_type,
      srcPath: step.src_path,
      dstPath: step.dst_path,
      fileSize: step.file_size,
      fileMtime: step.file_mtime,
      contentHash: null,
    });

    try {
      const stale = checkSource(step);
      if (stale) {
        journal.markStepSkipped(db, stepId, stale);
        continue;
      }

      let dst = step.dst_path;

      if (step.action_type !== 'trash') {
        if (!dst) throw new Error(`Step has no destination: ${step.action_type}`);

        // Destination taken since planning? (A case-only rename of the file
        // itself is not a conflict.)
        if (fs.existsSync(dst) && !samePath(step.src_path, dst)) {
          if (step.policy === 'skip') {
            journal.markStepSkipped(db, stepId, 'Destination appeared since planning (policy: skip)');
            continue;
          }
          const resolved = await resolveConflict(dst, new Set(), 'auto_rename');
          dst = resolved.path;
          journal.updateStepDst(db, stepId, dst);
        }
      }

      switch (step.action_type) {
        case 'move':
        case 'rename':
          await executeMove(step.src_path, dst!);
          recentlyWritten?.add(dst!);
          break;

        case 'copy':
          executeCopy(step.src_path, dst!);
          recentlyWritten?.add(dst!);
          break;

        case 'trash':
          await executeTrash(step.src_path);
          break;

        default:
          throw new Error(`Unknown action type: ${step.action_type}`);
      }

      journal.markStepDone(db, stepId);
    } catch (err: any) {
      journal.markStepFailed(db, stepId, err.message || String(err));
    }
  }

  journal.finishOperation(db, operationId);
  return operationId;
}

/**
 * Recover pending steps from incomplete operations (e.g. after a crash).
 * Checks filesystem state to determine whether each pending step succeeded or failed.
 */
export function recoverPending(db: any): void {
  const pendingSteps = journal.recoverPendingSteps(db);

  for (const step of pendingSteps) {
    const srcExists = fs.existsSync(step.src_path);
    const dstExists = step.dst_path ? fs.existsSync(step.dst_path) : false;

    if (step.action_type === 'trash') {
      if (!srcExists) {
        // Trash likely succeeded
        journal.markStepDone(db, step.id);
      } else {
        journal.markStepFailed(db, step.id, 'Interrupted: source still exists');
      }
    } else if (step.action_type === 'move' || step.action_type === 'rename') {
      if (dstExists && !srcExists) {
        // Move completed
        journal.markStepDone(db, step.id);
      } else if (srcExists && !dstExists) {
        // Move never started
        journal.markStepFailed(db, step.id, 'Interrupted: move not completed');
      } else if (srcExists && dstExists) {
        // Partial state — source still exists alongside destination
        journal.markStepFailed(
          db,
          step.id,
          'Interrupted: both source and destination exist'
        );
      } else {
        // Neither exists — file lost
        journal.markStepFailed(
          db,
          step.id,
          'Interrupted: source and destination both missing'
        );
      }
    } else if (step.action_type === 'copy') {
      if (dstExists) {
        journal.markStepDone(db, step.id);
      } else {
        journal.markStepFailed(db, step.id, 'Interrupted: copy not completed');
      }
    } else {
      journal.markStepFailed(db, step.id, `Unknown action type: ${step.action_type}`);
    }

    // Finish the parent operation if all steps are resolved
    if (step.operation_id) {
      const remaining = journal.recoverPendingSteps(db).filter(
        (s: any) => s.operation_id === step.operation_id
      );
      if (remaining.length === 0) {
        journal.finishOperation(db, step.operation_id);
      }
    }
  }
}
