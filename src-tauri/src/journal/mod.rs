use crate::models::{Operation, OperationStep};
use chrono::Local;
use rusqlite::{params, Connection};

pub fn create_operation(
    conn: &Connection,
    source: &str,
    summary: Option<&str>,
) -> Result<i64, String> {
    let now = Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
    conn.execute(
        "INSERT INTO operations (source, status, summary, started_at) VALUES (?1, 'running', ?2, ?3)",
        params![source, summary, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

pub fn create_step_pending(
    conn: &Connection,
    operation_id: i64,
    seq: i32,
    rule_id: Option<i64>,
    action_type: &str,
    src_path: &str,
    dst_path: Option<&str>,
    file_size: Option<i64>,
    file_mtime: Option<&str>,
) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO operation_steps (operation_id, seq, rule_id, action_type, src_path, dst_path, file_size, file_mtime, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending')",
        params![operation_id, seq, rule_id, action_type, src_path, dst_path, file_size, file_mtime],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

pub fn mark_step_done(
    conn: &Connection,
    step_id: i64,
    content_hash: Option<&str>,
) -> Result<(), String> {
    let now = Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
    conn.execute(
        "UPDATE operation_steps SET status = 'done', content_hash = ?1, executed_at = ?2 WHERE id = ?3",
        params![content_hash, now, step_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn mark_step_failed(conn: &Connection, step_id: i64, error: &str) -> Result<(), String> {
    let now = Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
    conn.execute(
        "UPDATE operation_steps SET status = 'failed', error = ?1, executed_at = ?2 WHERE id = ?3",
        params![error, now, step_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn mark_step_undone(conn: &Connection, step_id: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE operation_steps SET status = 'undone' WHERE id = ?1",
        params![step_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn finish_operation(conn: &Connection, operation_id: i64) -> Result<(), String> {
    let now = Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();

    let has_failed: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM operation_steps WHERE operation_id = ?1 AND status = 'failed')",
            params![operation_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    let has_done: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM operation_steps WHERE operation_id = ?1 AND status = 'done')",
            params![operation_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    let status = if has_failed && has_done {
        "partial"
    } else if has_failed {
        "failed"
    } else {
        "done"
    };

    conn.execute(
        "UPDATE operations SET status = ?1, finished_at = ?2 WHERE id = ?3",
        params![status, now, operation_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn mark_operation_undone(conn: &Connection, operation_id: i64) -> Result<(), String> {
    let now = Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
    conn.execute(
        "UPDATE operations SET status = 'undone', finished_at = ?1 WHERE id = ?2",
        params![now, operation_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn get_operations(conn: &Connection, limit: i64, offset: i64) -> Result<Vec<Operation>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, source, status, summary, started_at, finished_at
             FROM operations ORDER BY id DESC LIMIT ?1 OFFSET ?2",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![limit, offset], |row| {
            Ok(Operation {
                id: row.get(0)?,
                source: row.get(1)?,
                status: row.get(2)?,
                summary: row.get(3)?,
                started_at: row.get(4)?,
                finished_at: row.get(5)?,
                steps: None,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut ops = Vec::new();
    for row in rows {
        ops.push(row.map_err(|e| e.to_string())?);
    }
    Ok(ops)
}

pub fn get_operation_steps(conn: &Connection, operation_id: i64) -> Result<Vec<OperationStep>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, operation_id, seq, rule_id, action_type, src_path, dst_path,
                    file_size, file_mtime, content_hash, status, error, executed_at
             FROM operation_steps WHERE operation_id = ?1 ORDER BY seq",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![operation_id], |row| {
            Ok(OperationStep {
                id: row.get(0)?,
                operation_id: row.get(1)?,
                seq: row.get(2)?,
                rule_id: row.get(3)?,
                action_type: row.get(4)?,
                src_path: row.get(5)?,
                dst_path: row.get(6)?,
                file_size: row.get(7)?,
                file_mtime: row.get(8)?,
                content_hash: row.get(9)?,
                status: row.get(10)?,
                error: row.get(11)?,
                executed_at: row.get(12)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut steps = Vec::new();
    for row in rows {
        steps.push(row.map_err(|e| e.to_string())?);
    }
    Ok(steps)
}

pub fn get_step_by_id(conn: &Connection, step_id: i64) -> Result<OperationStep, String> {
    conn.query_row(
        "SELECT id, operation_id, seq, rule_id, action_type, src_path, dst_path,
                file_size, file_mtime, content_hash, status, error, executed_at
         FROM operation_steps WHERE id = ?1",
        params![step_id],
        |row| {
            Ok(OperationStep {
                id: row.get(0)?,
                operation_id: row.get(1)?,
                seq: row.get(2)?,
                rule_id: row.get(3)?,
                action_type: row.get(4)?,
                src_path: row.get(5)?,
                dst_path: row.get(6)?,
                file_size: row.get(7)?,
                file_mtime: row.get(8)?,
                content_hash: row.get(9)?,
                status: row.get(10)?,
                error: row.get(11)?,
                executed_at: row.get(12)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

pub fn recover_pending_steps(conn: &Connection) -> Result<Vec<OperationStep>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, operation_id, seq, rule_id, action_type, src_path, dst_path,
                    file_size, file_mtime, content_hash, status, error, executed_at
             FROM operation_steps WHERE status = 'pending' ORDER BY operation_id, seq",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(OperationStep {
                id: row.get(0)?,
                operation_id: row.get(1)?,
                seq: row.get(2)?,
                rule_id: row.get(3)?,
                action_type: row.get(4)?,
                src_path: row.get(5)?,
                dst_path: row.get(6)?,
                file_size: row.get(7)?,
                file_mtime: row.get(8)?,
                content_hash: row.get(9)?,
                status: row.get(10)?,
                error: row.get(11)?,
                executed_at: row.get(12)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut steps = Vec::new();
    for row in rows {
        steps.push(row.map_err(|e| e.to_string())?);
    }
    Ok(steps)
}

pub fn count_done_steps_today(conn: &Connection) -> Result<usize, String> {
    let today = Local::now().format("%Y-%m-%d").to_string();
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM operation_steps WHERE status = 'done' AND executed_at LIKE ?1",
            params![format!("{}%", today)],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(count as usize)
}

pub fn count_done_steps_week(conn: &Connection) -> Result<usize, String> {
    let week_ago = (Local::now() - chrono::Duration::days(7))
        .format("%Y-%m-%dT%H:%M:%S")
        .to_string();
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM operation_steps WHERE status = 'done' AND executed_at >= ?1",
            params![week_ago],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(count as usize)
}
