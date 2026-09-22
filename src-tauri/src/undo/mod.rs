use crate::journal;
use crate::models::UndoResult;
use rusqlite::Connection;
use std::fs;
use std::path::Path;

pub fn undo_operation(conn: &Connection, operation_id: i64) -> Result<UndoResult, String> {
    let steps = journal::get_operation_steps(conn, operation_id)?;
    let mut result = UndoResult {
        success: true,
        steps_undone: 0,
        steps_skipped: 0,
        errors: Vec::new(),
    };

    for step in steps.iter().rev() {
        if step.status != "done" {
            result.steps_skipped += 1;
            continue;
        }

        match undo_single_step(conn, step) {
            Ok(true) => {
                result.steps_undone += 1;
            }
            Ok(false) => {
                result.steps_skipped += 1;
            }
            Err(e) => {
                result.errors.push(format!("Step {}: {}", step.seq, e));
                result.success = false;
            }
        }
    }

    if result.errors.is_empty() {
        journal::mark_operation_undone(conn, operation_id)?;
    }

    Ok(result)
}

pub fn undo_step(conn: &Connection, step_id: i64) -> Result<UndoResult, String> {
    let step = journal::get_step_by_id(conn, step_id)?;
    let mut result = UndoResult {
        success: true,
        steps_undone: 0,
        steps_skipped: 0,
        errors: Vec::new(),
    };

    if step.status != "done" {
        result.steps_skipped = 1;
        result.errors.push(format!(
            "Step is not in 'done' status (current: {})",
            step.status
        ));
        result.success = false;
        return Ok(result);
    }

    match undo_single_step(conn, &step) {
        Ok(true) => {
            result.steps_undone = 1;
        }
        Ok(false) => {
            result.steps_skipped = 1;
        }
        Err(e) => {
            result.errors.push(e);
            result.success = false;
        }
    }

    Ok(result)
}

fn undo_single_step(
    conn: &Connection,
    step: &crate::models::OperationStep,
) -> Result<bool, String> {
    match step.action_type.as_str() {
        "move" | "rename" => undo_move(conn, step),
        "copy" => undo_copy(conn, step),
        "trash" => {
            Err("Cannot undo trash operations — file is in the OS recycle bin".to_string())
        }
        "ignore" => Ok(false),
        other => Err(format!("Unknown action type for undo: {}", other)),
    }
}

fn undo_move(conn: &Connection, step: &crate::models::OperationStep) -> Result<bool, String> {
    let dst_path = step
        .dst_path
        .as_ref()
        .ok_or("No destination path recorded")?;
    let src_path = &step.src_path;

    let dst = Path::new(dst_path);
    let src = Path::new(src_path);

    if !dst.exists() {
        return Err(format!(
            "Cannot undo: file no longer exists at {}",
            dst_path
        ));
    }

    if let Some(expected_size) = step.file_size {
        let actual_size = fs::metadata(dst)
            .map(|m| m.len() as i64)
            .unwrap_or(-1);
        if actual_size != expected_size {
            return Err(format!(
                "Cannot undo: file at destination was modified (expected size {}, got {})",
                expected_size, actual_size
            ));
        }
    }

    if src.exists() {
        return Err(format!(
            "Cannot undo: original location is occupied: {}",
            src_path
        ));
    }

    if let Some(parent) = src.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directory: {}", e))?;
    }

    fs::rename(dst, src).or_else(|e| {
        if is_cross_device_error(&e) {
            fs::copy(dst, src)
                .map_err(|e| format!("Failed to copy back: {}", e))
                .and_then(|_| {
                    fs::remove_file(dst)
                        .map_err(|e| format!("Failed to remove after copy back: {}", e))
                })
        } else {
            Err(format!("Failed to move back: {}", e))
        }
    })?;

    journal::mark_step_undone(conn, step.id)?;
    Ok(true)
}

fn undo_copy(conn: &Connection, step: &crate::models::OperationStep) -> Result<bool, String> {
    let dst_path = step
        .dst_path
        .as_ref()
        .ok_or("No destination path recorded")?;
    let dst = Path::new(dst_path);

    if !dst.exists() {
        return Err(format!(
            "Cannot undo copy: file no longer exists at {}",
            dst_path
        ));
    }

    if let Some(expected_size) = step.file_size {
        let actual_size = fs::metadata(dst)
            .map(|m| m.len() as i64)
            .unwrap_or(-1);
        if actual_size != expected_size {
            return Err(format!(
                "Cannot undo copy: file at destination was modified (expected size {}, got {})",
                expected_size, actual_size
            ));
        }
    }

    trash::delete(dst).map_err(|e| format!("Failed to trash copied file: {}", e))?;

    journal::mark_step_undone(conn, step.id)?;
    Ok(true)
}

fn is_cross_device_error(e: &std::io::Error) -> bool {
    #[cfg(target_os = "windows")]
    {
        e.raw_os_error() == Some(17)
    }
    #[cfg(not(target_os = "windows"))]
    {
        e.raw_os_error() == Some(18)
    }
}
