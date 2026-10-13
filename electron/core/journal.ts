/**
 * Operation journal — all database queries for operation and step tracking.
 * Uses better-sqlite3 prepared statements (synchronous).
 */

export function now(): string {
  return new Date().toISOString().slice(0, 19);
}

/**
 * Create a new operation record.
 */
export function createOperation(db: any, source: string): number {
  const stmt = db.prepare(
    'INSERT INTO operations (source, status, started_at) VALUES (?, ?, ?)'
  );
  const result = stmt.run(source, 'running', now());
  return result.lastInsertRowid as number;
}

/**
 * Create a pending step within an operation.
 */
export function createStepPending(
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
export function markStepDone(db: any, stepId: number): void {
  db.prepare(
    "UPDATE operation_steps SET status = 'done', executed_at = ? WHERE id = ?"
  ).run(now(), stepId);
}

/**
 * Mark a step as failed with an error message.
 */
export function markStepFailed(db: any, stepId: number, error: string): void {
  db.prepare(
    "UPDATE operation_steps SET status = 'failed', error = ?, executed_at = ? WHERE id = ?"
  ).run(error, now(), stepId);
}

/**
 * Mark a step as skipped: it was deliberately not executed (the source changed
 * since the preview, the conflict policy said skip, etc.). Nothing on disk was touched.
 */
export function markStepSkipped(db: any, stepId: number, reason: string): void {
  db.prepare(
    "UPDATE operation_steps SET status = 'skipped', error = ?, executed_at = ? WHERE id = ?"
  ).run(reason, now(), stepId);
}

/**
 * Record the destination actually used when it differs from the planned one
 * (a conflict appeared between planning and execution).
 */
export function updateStepDst(db: any, stepId: number, dstPath: string): void {
  db.prepare('UPDATE operation_steps SET dst_path = ? WHERE id = ?').run(dstPath, stepId);
}

/**
 * Mark a step as undone.
 */
export function markStepUndone(db: any, stepId: number): void {
  db.prepare(
    "UPDATE operation_steps SET status = 'undone', executed_at = ? WHERE id = ?"
  ).run(now(), stepId);
}

/**
 * Finish an operation — determine final status from step statuses.
 */
export function finishOperation(db: any, operationId: number): void {
  const allSteps = db
    .prepare('SELECT status FROM operation_steps WHERE operation_id = ?')
    .all(operationId);
  // Skipped steps touched nothing; they must not make a clean run look partial.
  const steps = allSteps.filter((s: any) => s.status !== 'skipped');

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
export function buildOperationSummary(db: any, operationId: number): string {
  const steps = db
    .prepare(
      "SELECT action_type, COUNT(*) as count FROM operation_steps WHERE operation_id = ? AND status = 'done' GROUP BY action_type"
    )
    .all(operationId);

  const skipped = db
    .prepare(
      "SELECT COUNT(*) as count FROM operation_steps WHERE operation_id = ? AND status = 'skipped'"
    )
    .get(operationId).count;

  if (steps.length === 0) {
    return skipped > 0 ? `${skipped} skipped, nothing changed` : 'No files processed';
  }

  const parts = steps.map(
    (s: any) =>
      `${s.count} file${s.count > 1 ? 's' : ''} ${s.action_type === 'move' ? 'moved' : s.action_type === 'copy' ? 'copied' : s.action_type === 'rename' ? 'renamed' : s.action_type === 'trash' ? 'trashed' : s.action_type + 'd'}`
  );

  if (skipped > 0) parts.push(`${skipped} skipped`);
  return parts.join(', ');
}

/**
 * Set an operation's status to reflect the outcome of an undo attempt.
 * Use 'undone' when every done step was successfully reverted, or
 * 'partially_undone' when some steps could not be reverted.
 */
export function setOperationUndoStatus(
  db: any,
  operationId: number,
  status: 'undone' | 'partially_undone'
): void {
  db.prepare(
    'UPDATE operations SET status = ?, finished_at = ? WHERE id = ?'
  ).run(status, now(), operationId);
}

/**
 * Get operations with pagination.
 */
export function getOperations(
  db: any,
  limit: number = 50,
  offset: number = 0
): any[] {
  return db
    .prepare(
      'SELECT * FROM operations ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?'
    )
    .all(limit, offset);
}

/**
 * Get all steps for an operation.
 */
export function getOperationSteps(db: any, operationId: number): any[] {
  return db
    .prepare(
      'SELECT * FROM operation_steps WHERE operation_id = ? ORDER BY seq ASC'
    )
    .all(operationId);
}

/**
 * Get a single step by ID.
 */
export function getStepById(db: any, stepId: number): any {
  return db.prepare('SELECT * FROM operation_steps WHERE id = ?').get(stepId);
}

/**
 * Recover all pending steps (for crash recovery).
 */
export function recoverPendingSteps(db: any): any[] {
  return db
    .prepare("SELECT * FROM operation_steps WHERE status = 'pending'")
    .all();
}

/**
 * Count done steps from today.
 */
export function countDoneStepsToday(db: any): number {
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
export function countDoneStepsWeek(db: any): number {
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
