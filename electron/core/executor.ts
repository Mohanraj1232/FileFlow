const fs = require('node:fs');
const path = require('node:path');
const journal = require('./journal');

interface PlannedStep {
  ruleId: number;
  ruleName: string;
  actionType: string;
  srcPath: string;
  dstPath: string | null;
  fileSize: number;
  fileMtime: string;
}

/**
 * Execute a move operation with cross-device fallback.
 * If fs.renameSync fails (EXDEV — cross-device link), falls back to
 * copy + verify + delete.
 */
function executeMove(src: string, dst: string): void {
  const dstDir = path.dirname(dst);
  if (!fs.existsSync(dstDir)) {
    fs.mkdirSync(dstDir, { recursive: true });
  }

  try {
    fs.renameSync(src, dst);
  } catch (err: any) {
    if (err.code === 'EXDEV') {
      // Cross-device: copy, verify, then remove original
      fs.copyFileSync(src, dst);
      const srcStat = fs.statSync(src);
      const dstStat = fs.statSync(dst);
      if (srcStat.size !== dstStat.size) {
        // Clean up failed copy
        try {
          fs.unlinkSync(dst);
        } catch {
          // ignore cleanup error
        }
        throw new Error(
          `Cross-device move verification failed: size mismatch (src=${srcStat.size}, dst=${dstStat.size})`
        );
      }
      fs.unlinkSync(src);
    } else {
      throw err;
    }
  }
}

/**
 * Execute a copy operation.
 */
function executeCopy(src: string, dst: string): void {
  const dstDir = path.dirname(dst);
  if (!fs.existsSync(dstDir)) {
    fs.mkdirSync(dstDir, { recursive: true });
  }
  fs.copyFileSync(src, dst);
}

/**
 * Execute a trash operation using the `trash` ESM package.
 */
async function executeTrash(src: string): Promise<void> {
  const trashModule = await import('trash');
  const trashFn = trashModule.default || trashModule;
  await trashFn([src]);
}

/**
 * Execute a full plan of steps, journaling each one.
 *
 * @param db - The better-sqlite3 database instance
 * @param steps - Array of planned steps to execute
 * @param source - Description of where this operation originated (e.g. "manual", "watcher")
 * @param recentlyWritten - RecentlyWritten tracker to register output paths
 * @returns The operation ID from the journal
 */
async function executePlan(
  db: any,
  steps: PlannedStep[],
  source: string,
  recentlyWritten: any
): Promise<number> {
  const operationId = journal.createOperation(db, source);

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepId = journal.createStepPending(db, {
      operationId,
      seq: i + 1,
      ruleId: step.ruleId,
      actionType: step.actionType,
      srcPath: step.srcPath,
      dstPath: step.dstPath,
      fileSize: step.fileSize,
      fileMtime: step.fileMtime,
      contentHash: null,
    });

    try {
      switch (step.actionType) {
        case 'move':
        case 'rename':
          executeMove(step.srcPath, step.dstPath!);
          if (recentlyWritten && step.dstPath) {
            recentlyWritten.add(step.dstPath);
          }
          break;

        case 'copy':
          executeCopy(step.srcPath, step.dstPath!);
          if (recentlyWritten && step.dstPath) {
            recentlyWritten.add(step.dstPath);
          }
          break;

        case 'trash':
          await executeTrash(step.srcPath);
          break;

        default:
          throw new Error(`Unknown action type: ${step.actionType}`);
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
function recoverPending(db: any): void {
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

module.exports = { executePlan, executeMove, executeCopy, executeTrash, recoverPending };
