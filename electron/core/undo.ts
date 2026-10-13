import fs from 'node:fs';
import * as journal from './journal';
import { executeMove, executeTrash, type WrittenTracker } from './executor';

export interface UndoResult {
  success: boolean;
  steps_undone: number;
  steps_skipped: number;
  errors: string[];
}

/**
 * Undo a single step. Returns whether the undo succeeded and any error.
 *
 * Restored files are registered with `recentlyWritten` so the folder watcher
 * does not immediately pick the file back up and re-sort it.
 */
async function undoSingleStep(
  db: any,
  step: any,
  recentlyWritten?: WrittenTracker | null
): Promise<{ success: boolean; error?: string }> {
  switch (step.action_type) {
    case 'move':
    case 'rename': {
      // Verify destination (current location) exists
      if (!step.dst_path) {
        return { success: false, error: 'No destination path recorded' };
      }
      if (!fs.existsSync(step.dst_path)) {
        return {
          success: false,
          error: `Destination file no longer exists: ${step.dst_path}`,
        };
      }

      // Verify size matches what was recorded
      if (step.file_size != null) {
        const dstStat = fs.statSync(step.dst_path);
        if (dstStat.size !== step.file_size) {
          return {
            success: false,
            error: `File size mismatch at destination (expected ${step.file_size}, got ${dstStat.size})`,
          };
        }
      }

      // Verify source (original location) is free
      if (fs.existsSync(step.src_path)) {
        return {
          success: false,
          error: `Original location is occupied: ${step.src_path}`,
        };
      }

      try {
        // Register first: the watcher may see the file the instant it lands.
        recentlyWritten?.add(step.src_path);
        await executeMove(step.dst_path, step.src_path);
        journal.markStepUndone(db, step.id);
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message || String(err) };
      }
    }

    case 'copy': {
      // Verify the copy destination exists
      if (!step.dst_path) {
        return { success: false, error: 'No destination path recorded' };
      }
      if (!fs.existsSync(step.dst_path)) {
        return {
          success: false,
          error: `Copied file no longer exists: ${step.dst_path}`,
        };
      }

      // Verify size matches
      if (step.file_size != null) {
        const dstStat = fs.statSync(step.dst_path);
        if (dstStat.size !== step.file_size) {
          return {
            success: false,
            error: `File size mismatch (expected ${step.file_size}, got ${dstStat.size})`,
          };
        }
      }

      // Trash the copy
      try {
        await executeTrash(step.dst_path);
        journal.markStepUndone(db, step.id);
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message || String(err) };
      }
    }

    case 'trash': {
      return {
        success: false,
        error: 'Cannot undo trash operations — restore the file from the system Recycle Bin / Trash',
      };
    }

    default:
      return {
        success: false,
        error: `Unknown action type: ${step.action_type}`,
      };
  }
}

/**
 * Undo an entire operation — reverse all done steps in reverse order.
 */
export async function undoOperation(
  db: any,
  operationId: number,
  recentlyWritten?: WrittenTracker | null
): Promise<UndoResult> {
  const steps = journal.getOperationSteps(db, operationId);
  const result: UndoResult = {
    success: true,
    steps_undone: 0,
    steps_skipped: 0,
    errors: [],
  };

  // Only undo steps that are currently 'done', in reverse order
  const doneSteps = steps
    .filter((s: any) => s.status === 'done')
    .reverse();

  if (doneSteps.length === 0) {
    result.success = false;
    result.errors.push('No completed steps to undo');
    return result;
  }

  for (const step of doneSteps) {
    const stepResult = await undoSingleStep(db, step, recentlyWritten);
    if (stepResult.success) {
      result.steps_undone++;
    } else {
      result.steps_skipped++;
      result.errors.push(
        `Step ${step.id} (${step.action_type}): ${stepResult.error}`
      );
    }
  }

  // Reflect the outcome on the operation: fully undone only if every
  // attempted step succeeded, otherwise partially undone so the UI can
  // still offer a retry path for the remaining steps.
  if (result.steps_undone > 0) {
    journal.setOperationUndoStatus(
      db,
      operationId,
      result.steps_skipped === 0 ? 'undone' : 'partially_undone'
    );
  }

  result.success = result.errors.length === 0;
  return result;
}

/**
 * Undo a single step by step ID.
 */
export async function undoStep(
  db: any,
  stepId: number,
  recentlyWritten?: WrittenTracker | null
): Promise<UndoResult> {
  const step = journal.getStepById(db, stepId);
  if (!step) {
    return {
      success: false,
      steps_undone: 0,
      steps_skipped: 1,
      errors: [`Step ${stepId} not found`],
    };
  }

  if (step.status !== 'done') {
    return {
      success: false,
      steps_undone: 0,
      steps_skipped: 1,
      errors: [`Step ${stepId} is not in 'done' status (current: ${step.status})`],
    };
  }

  const stepResult = await undoSingleStep(db, step, recentlyWritten);
  return {
    success: stepResult.success,
    steps_undone: stepResult.success ? 1 : 0,
    steps_skipped: stepResult.success ? 0 : 1,
    errors: stepResult.error ? [stepResult.error] : [],
  };
}
