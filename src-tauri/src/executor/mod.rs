use crate::journal;
use crate::models::PlannedStep;
use crate::watcher::RecentlyWritten;
use rusqlite::Connection;
use std::fs;
use std::path::Path;

pub fn execute_plan(
    conn: &Connection,
    steps: &[PlannedStep],
    source: &str,
    recently_written: &mut RecentlyWritten,
) -> Result<i64, String> {
    let selected: Vec<&PlannedStep> = steps.iter().filter(|s| s.selected).collect();
    if selected.is_empty() {
        return Err("No steps selected".to_string());
    }

    let summary = format!("{} file(s)", selected.len());
    let operation_id = journal::create_operation(conn, source, Some(&summary))?;

    for (i, step) in selected.iter().enumerate() {
        let step_id = journal::create_step_pending(
            conn,
            operation_id,
            i as i32,
            step.rule_id,
            &step.action_type,
            &step.src_path,
            step.dst_path.as_deref(),
            Some(step.file_size as i64),
            None,
        )?;

        match execute_step(step) {
            Ok(()) => {
                journal::mark_step_done(conn, step_id, None)?;
                if let Some(dst) = &step.dst_path {
                    recently_written.add(dst);
                }
            }
            Err(e) => {
                journal::mark_step_failed(conn, step_id, &e)?;
                log::error!("Step {} failed: {}", i, e);
            }
        }
    }

    journal::finish_operation(conn, operation_id)?;
    Ok(operation_id)
}

fn execute_step(step: &PlannedStep) -> Result<(), String> {
    match step.action_type.as_str() {
        "move" => execute_move(&step.src_path, step.dst_path.as_deref()),
        "copy" => execute_copy(&step.src_path, step.dst_path.as_deref()),
        "rename" => execute_move(&step.src_path, step.dst_path.as_deref()),
        "trash" => execute_trash(&step.src_path),
        "ignore" => Ok(()),
        other => Err(format!("Unknown action type: {}", other)),
    }
}

fn execute_move(src: &str, dst: Option<&str>) -> Result<(), String> {
    let dst = dst.ok_or("Move action requires a destination")?;
    let src_path = Path::new(src);
    let dst_path = Path::new(dst);

    if !src_path.exists() {
        return Err(format!("Source file not found: {}", src));
    }

    if let Some(parent) = dst_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    match fs::rename(src_path, dst_path) {
        Ok(()) => Ok(()),
        Err(e) => {
            if is_cross_device_error(&e) {
                cross_volume_move(src_path, dst_path)
            } else {
                Err(format!("Failed to move file: {}", e))
            }
        }
    }
}

fn cross_volume_move(src: &Path, dst: &Path) -> Result<(), String> {
    fs::copy(src, dst).map_err(|e| format!("Failed to copy file: {}", e))?;

    let src_meta = fs::metadata(src).map_err(|e| format!("Failed to read source: {}", e))?;
    let dst_meta = fs::metadata(dst).map_err(|e| format!("Failed to read destination: {}", e))?;

    if src_meta.len() != dst_meta.len() {
        fs::remove_file(dst).ok();
        return Err("Copy verification failed: file sizes differ".to_string());
    }

    fs::remove_file(src).map_err(|e| format!("Failed to remove source after copy: {}", e))?;
    Ok(())
}

fn execute_copy(src: &str, dst: Option<&str>) -> Result<(), String> {
    let dst = dst.ok_or("Copy action requires a destination")?;
    let src_path = Path::new(src);
    let dst_path = Path::new(dst);

    if !src_path.exists() {
        return Err(format!("Source file not found: {}", src));
    }

    if let Some(parent) = dst_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    fs::copy(src_path, dst_path).map_err(|e| format!("Failed to copy file: {}", e))?;
    Ok(())
}

fn execute_trash(src: &str) -> Result<(), String> {
    let src_path = Path::new(src);
    if !src_path.exists() {
        return Err(format!("Source file not found: {}", src));
    }
    trash::delete(src_path).map_err(|e| format!("Failed to trash file: {}", e))
}

fn is_cross_device_error(e: &std::io::Error) -> bool {
    #[cfg(target_os = "windows")]
    {
        e.raw_os_error() == Some(17)
    }
    #[cfg(not(target_os = "windows"))]
    {
        e.raw_os_error() == Some(18) // EXDEV
    }
}

pub fn recover_pending(conn: &Connection) -> Result<(), String> {
    let pending_steps = journal::recover_pending_steps(conn)?;

    for step in pending_steps {
        let src_exists = Path::new(&step.src_path).exists();
        let dst_exists = step
            .dst_path
            .as_ref()
            .map(|p| Path::new(p).exists())
            .unwrap_or(false);

        if dst_exists && !src_exists {
            journal::mark_step_done(conn, step.id, None)?;
            log::info!("Recovery: step {} completed (dst exists, src gone)", step.id);
        } else if src_exists && !dst_exists {
            journal::mark_step_failed(
                conn,
                step.id,
                "Interrupted: source exists but destination was not created",
            )?;
            log::warn!("Recovery: step {} failed (src exists, dst missing)", step.id);
        } else if src_exists && dst_exists {
            journal::mark_step_failed(
                conn,
                step.id,
                "Interrupted: both source and destination exist — manual resolution needed",
            )?;
            log::warn!(
                "Recovery: step {} needs manual resolution (both exist)",
                step.id
            );
        } else {
            journal::mark_step_failed(
                conn,
                step.id,
                "Interrupted: neither source nor destination found",
            )?;
            log::error!("Recovery: step {} — both files missing", step.id);
        }
    }

    Ok(())
}
