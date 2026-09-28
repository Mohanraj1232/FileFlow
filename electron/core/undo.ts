const fs = require('node:fs');
const path = require('node:path');
const journal = require('./journal');

interface UndoResult {
  success: boolean;
  steps_undone: number;
  steps_skipped: number;
  errors: string[];
}

/**
 * Move a file back to its original location with cross-device fallback.
 */
function moveBack(src: string, dst: string): void {
  const dstDir = path.dirname(dst);
  if (!fs.existsSync(dstDir)) {
    fs.mkdirSync(dstDir, { recursive: true });
  }

  try {
    fs.renameSync(src, dst);
  } catch (err: any) {
    if (err.code === 'EXDEV') {
      fs.copyFileSync(src, dst);
      const srcStat = fs.statSync(src);
      const dstStat = fs.statSync(dst);
      if (srcStat.size !== dstStat.size) {
        try {
          fs.unlinkSync(dst);
        } catch {
          // ignore cleanup error
        }
        throw new Error(
          `Cross-device undo move verification failed: size mismatch`
        );
      }
      fs.unlinkSync(src);
    } else {
      throw err;
    }
  }
}

/**
 * Undo a single step. Returns whether the undo succeeded and any error.
 */
async function undoSingleStep(
  db: any,
  step: any
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
        moveBack(step.dst_path, step.src_path);
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
        const trashModule = await import('trash');
        const trashFn = trashModule.default || trashModule;
        await trashFn([step.dst_path]);
        journal.markStepUndone(db, step.id);
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message || String(err) };
      }
    }

    case 'trash': {
      return {
        success: false,
        error: 'Cannot undo trash operations',
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
async function undoOperation(db: any, operationId: number): Promise<UndoResult> {
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
    const stepResult = await undoSingleStep(db, step);
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
async function undoStep(db: any, stepId: number): Promise<UndoResult> {
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

  const stepResult = await undoSingleStep(db, step);
  return {
    success: stepResult.success,
    steps_undone: stepResult.success ? 1 : 0,
    steps_skipped: stepResult.success ? 0 : 1,
    errors: stepResult.error ? [stepResult.error] : [],
  };
}

module.exports = { undoOperation, undoStep };
