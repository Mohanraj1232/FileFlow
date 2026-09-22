/**
 * Operation journal — all database queries for operation and step tracking.
 * Uses better-sqlite3 prepared statements (synchronous).
 */

function now(): string {
  return new Date().toISOString().slice(0, 19);
}

/**
 * Create a new operation record.
 */
function createOperation(db: any, source: string): number {
  const stmt = db.prepare(
    'INSERT INTO operations (source, status, started_at) VALUES (?, ?, ?)'
  );
  const result = stmt.run(source, 'running', now());
  return result.lastInsertRowid as number;
}

/**
 * Create a pending step within an operation.
 */
function createStepPending(
  db: any,
  step: {
    operationId: number;
    seq: number;
    ruleId: number | null;
    actionType: string;
    srcPath: string;
    dstPath: string | null;
    fileSize: number | null;
    fileMtime: string | null;
    contentHash: string | null;
  }
): number {
  const stmt = db.prepare(`
    INSERT INTO operation_steps
      (operation_id, seq, rule_id, action_type, src_path, dst_path,
       file_size, file_mtime, content_hash, status, executed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `);
  const result = stmt.run(
    step.operationId,
    step.seq,
    step.ruleId,
    step.actionType,
    step.srcPath,
    step.dstPath,
    step.fileSize,
    step.fileMtime,
    step.contentHash,
    now()
  );
  return result.lastInsertRowid as number;
}

/**
 * Mark a step as done.
 */
function markStepDone(db: any, stepId: number): void {
  db.prepare(
    "UPDATE operation_steps SET status = 'done', executed_at = ? WHERE id = ?"
  ).run(now(), stepId);
}

/**
 * Mark a step as failed with an error message.
 */
function markStepFailed(db: any, stepId: number, error: string): void {
  db.prepare(
    "UPDATE operation_steps SET status = 'failed', error = ?, executed_at = ? WHERE id = ?"
  ).run(error, now(), stepId);
}

/**
 * Mark a step as undone.
 */
function markStepUndone(db: any, stepId: number): void {
  db.prepare(
    "UPDATE operation_steps SET status = 'undone', executed_at = ? WHERE id = ?"
  ).run(now(), stepId);
}

/**
 * Finish an operation — determine final status from step statuses.
 */
function finishOperation(db: any, operationId: number): void {
  const steps = db
    .prepare('SELECT status FROM operation_steps WHERE operation_id = ?')
    .all(operationId);

  let status: string;
  if (steps.length === 0) {
    status = 'done';
  } else {
    const allDone = steps.every((s: any) => s.status === 'done');
    const allFailed = steps.every((s: any) => s.status === 'failed');

    if (allDone) {
      status = 'done';
    } else if (allFailed) {
      status = 'failed';
    } else {
      status = 'partial';
    }
  }

  const summary = buildOperationSummary(db, operationId);

  db.prepare(
    'UPDATE operations SET status = ?, summary = ?, finished_at = ? WHERE id = ?'
  ).run(status, summary, now(), operationId);
}

/**
 * Build a human-readable summary string for an operation.
 */
function buildOperationSummary(db: any, operationId: number): string {
  const steps = db
    .prepare(
      "SELECT action_type, COUNT(*) as count FROM operation_steps WHERE operation_id = ? AND status = 'done' GROUP BY action_type"
    )
    .all(operationId);

  if (steps.length === 0) return 'No files processed';

  const parts = steps.map(
    (s: any) =>
      `${s.count} file${s.count > 1 ? 's' : ''} ${s.action_type === 'move' ? 'moved' : s.action_type === 'copy' ? 'copied' : s.action_type === 'rename' ? 'renamed' : s.action_type === 'trash' ? 'trashed' : s.action_type + 'd'}`
  );

  return parts.join(', ');
}

/**
 * Mark an entire operation as undone.
 */
function markOperationUndone(db: any, operationId: number): void {
  db.prepare(
    "UPDATE operations SET status = 'undone', finished_at = ? WHERE id = ?"
  ).run(now(), operationId);
}

/**
 * Get operations with pagination.
 */
function getOperations(
  db: any,
  limit: number = 50,
  offset: number = 0
): any[] {
  return db
    .prepare(
      'SELECT * FROM operations ORDER BY started_at DESC LIMIT ? OFFSET ?'
    )
    .all(limit, offset);
}

/**
 * Get all steps for an operation.
 */
function getOperationSteps(db: any, operationId: number): any[] {
  return db
    .prepare(
      'SELECT * FROM operation_steps WHERE operation_id = ? ORDER BY seq ASC'
    )
    .all(operationId);
}

/**
 * Get a single step by ID.
 */
function getStepById(db: any, stepId: number): any {
  return db.prepare('SELECT * FROM operation_steps WHERE id = ?').get(stepId);
}

/**
 * Recover all pending steps (for crash recovery).
 */
function recoverPendingSteps(db: any): any[] {
  return db
    .prepare("SELECT * FROM operation_steps WHERE status = 'pending'")
    .all();
}

/**
 * Count done steps from today.
 */
function countDoneStepsToday(db: any): number {
  const today = new Date().toISOString().slice(0, 10);
  const row = db
    .prepare(
      "SELECT COUNT(*) as count FROM operation_steps WHERE status = 'done' AND executed_at >= ?"
    )
    .get(today);
  return row ? row.count : 0;
}

/**
 * Count done steps from the past 7 days.
 */
function countDoneStepsWeek(db: any): number {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const row = db
    .prepare(
      "SELECT COUNT(*) as count FROM operation_steps WHERE status = 'done' AND executed_at >= ?"
    )
    .get(weekAgo);
  return row ? row.count : 0;
}

module.exports = {
  createOperation,
  createStepPending,
  markStepDone,
  markStepFailed,
  markStepUndone,
  finishOperation,
  markOperationUndone,
  getOperations,
  getOperationSteps,
  getStepById,
  recoverPendingSteps,
  countDoneStepsToday,
  countDoneStepsWeek,
};
