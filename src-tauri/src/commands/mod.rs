use crate::models::*;
use crate::{engine, executor, journal, planner, undo, watcher, AppState};
use rusqlite::params;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::State;

#[tauri::command]
pub fn get_watched_folders(state: State<'_, AppState>) -> Result<Vec<WatchedFolder>, String> {
    let db = state.db.lock();
    let mut stmt = db
        .prepare(
            "SELECT id, path, recursive, enabled, created_at FROM watched_folders ORDER BY id",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(WatchedFolder {
                id: row.get(0)?,
                path: row.get(1)?,
                recursive: row.get::<_, i32>(2)? != 0,
                enabled: row.get::<_, i32>(3)? != 0,
                created_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut folders = Vec::new();
    for row in rows {
        folders.push(row.map_err(|e| e.to_string())?);
    }
    Ok(folders)
}

#[tauri::command]
pub fn add_watched_folder(
    state: State<'_, AppState>,
    path: String,
    recursive: bool,
) -> Result<WatchedFolder, String> {
    let folder_path = Path::new(&path);
    if !folder_path.exists() || !folder_path.is_dir() {
        return Err(format!("Directory does not exist: {}", path));
    }

    let now = chrono::Local::now()
        .format("%Y-%m-%dT%H:%M:%S")
        .to_string();
    let db = state.db.lock();
    db.execute(
        "INSERT INTO watched_folders (path, recursive, enabled, created_at) VALUES (?1, ?2, 1, ?3)",
        params![path, recursive as i32, now],
    )
    .map_err(|e| e.to_string())?;

    let id = db.last_insert_rowid();
    Ok(WatchedFolder {
        id,
        path,
        recursive,
        enabled: true,
        created_at: now,
    })
}

#[tauri::command]
pub fn remove_watched_folder(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let db = state.db.lock();
    db.execute("DELETE FROM watched_folders WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn toggle_watched_folder(
    state: State<'_, AppState>,
    id: i64,
    enabled: bool,
) -> Result<(), String> {
    let db = state.db.lock();
    db.execute(
        "UPDATE watched_folders SET enabled = ?1 WHERE id = ?2",
        params![enabled as i32, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_rules(state: State<'_, AppState>) -> Result<Vec<Rule>, String> {
    let db = state.db.lock();
    let mut stmt = db
        .prepare(
            "SELECT id, name, enabled, priority, trigger_type, condition, stop_after, scope_folder, created_at, updated_at
             FROM rules ORDER BY priority",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            let condition_json: String = row.get(5)?;
            let id: i64 = row.get(0)?;
            Ok((id, row.get(1)?, row.get::<_, i32>(2)?, row.get(3)?, row.get::<_, String>(4)?,
                condition_json, row.get::<_, i32>(6)?, row.get::<_, Option<i64>>(7)?,
                row.get::<_, String>(8)?, row.get::<_, String>(9)?))
        })
        .map_err(|e| e.to_string())?;

    let mut rules = Vec::new();
    for row in rows {
        let (id, name, enabled, priority, trigger_str, condition_json, stop_after, scope_folder, created_at, updated_at) =
            row.map_err(|e| e.to_string())?;

        let condition: Condition =
            serde_json::from_str(&condition_json).map_err(|e| e.to_string())?;
        let trigger: TriggerType =
            serde_json::from_str(&format!("\"{}\"", trigger_str)).unwrap_or(TriggerType::Arrival);

        let actions = load_rule_actions(&db, id)?;

        rules.push(Rule {
            id: Some(id),
            name,
            enabled: enabled != 0,
            priority,
            trigger,
            condition,
            stop_after: stop_after != 0,
            scope_folder,
            actions,
            created_at: Some(created_at),
            updated_at: Some(updated_at),
        });
    }

    Ok(rules)
}

fn load_rule_actions(db: &rusqlite::Connection, rule_id: i64) -> Result<Vec<RuleAction>, String> {
    let mut stmt = db
        .prepare(
            "SELECT id, rule_id, position, action_type, params FROM rule_actions WHERE rule_id = ?1 ORDER BY position",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![rule_id], |row| {
            let params_json: String = row.get(4)?;
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get::<_, String>(3)?, params_json))
        })
        .map_err(|e| e.to_string())?;

    let mut actions = Vec::new();
    for row in rows {
        let (id, rid, position, action_type_str, params_json) = row.map_err(|e| e.to_string())?;
        let params: ActionParams =
            serde_json::from_str(&params_json).map_err(|e| e.to_string())?;

        actions.push(RuleAction {
            id: Some(id),
            rule_id: Some(rid),
            position,
            action_type: ActionType::from_str(&action_type_str),
            params,
        });
    }

    Ok(actions)
}

#[tauri::command]
pub fn create_rule(state: State<'_, AppState>, rule: Rule) -> Result<Rule, String> {
    let db = state.db.lock();
    let now = chrono::Local::now()
        .format("%Y-%m-%dT%H:%M:%S")
        .to_string();
    let condition_json = serde_json::to_string(&rule.condition).map_err(|e| e.to_string())?;
    let trigger_str = serde_json::to_string(&rule.trigger)
        .map_err(|e| e.to_string())?
        .trim_matches('"')
        .to_string();

    db.execute(
        "INSERT INTO rules (name, enabled, priority, trigger_type, condition, stop_after, scope_folder, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            rule.name,
            rule.enabled as i32,
            rule.priority,
            trigger_str,
            condition_json,
            rule.stop_after as i32,
            rule.scope_folder,
            now,
            now
        ],
    )
    .map_err(|e| e.to_string())?;

    let rule_id = db.last_insert_rowid();

    for action in &rule.actions {
        let params_json = serde_json::to_string(&action.params).map_err(|e| e.to_string())?;
        db.execute(
            "INSERT INTO rule_actions (rule_id, position, action_type, params) VALUES (?1, ?2, ?3, ?4)",
            params![rule_id, action.position, action.action_type.as_str(), params_json],
        )
        .map_err(|e| e.to_string())?;
    }

    let actions = load_rule_actions(&db, rule_id)?;

    Ok(Rule {
        id: Some(rule_id),
        name: rule.name,
        enabled: rule.enabled,
        priority: rule.priority,
        trigger: rule.trigger,
        condition: rule.condition,
        stop_after: rule.stop_after,
        scope_folder: rule.scope_folder,
        actions,
        created_at: Some(now.clone()),
        updated_at: Some(now),
    })
}

#[tauri::command]
pub fn update_rule(state: State<'_, AppState>, rule: Rule) -> Result<Rule, String> {
    let rule_id = rule.id.ok_or("Rule ID is required for update")?;
    let db = state.db.lock();
    let now = chrono::Local::now()
        .format("%Y-%m-%dT%H:%M:%S")
        .to_string();
    let condition_json = serde_json::to_string(&rule.condition).map_err(|e| e.to_string())?;
    let trigger_str = serde_json::to_string(&rule.trigger)
        .map_err(|e| e.to_string())?
        .trim_matches('"')
        .to_string();

    db.execute(
        "UPDATE rules SET name=?1, enabled=?2, priority=?3, trigger_type=?4, condition=?5, stop_after=?6, scope_folder=?7, updated_at=?8 WHERE id=?9",
        params![
            rule.name,
            rule.enabled as i32,
            rule.priority,
            trigger_str,
            condition_json,
            rule.stop_after as i32,
            rule.scope_folder,
            now,
            rule_id
        ],
    )
    .map_err(|e| e.to_string())?;

    db.execute(
        "DELETE FROM rule_actions WHERE rule_id = ?1",
        params![rule_id],
    )
    .map_err(|e| e.to_string())?;

    for action in &rule.actions {
        let params_json = serde_json::to_string(&action.params).map_err(|e| e.to_string())?;
        db.execute(
            "INSERT INTO rule_actions (rule_id, position, action_type, params) VALUES (?1, ?2, ?3, ?4)",
            params![rule_id, action.position, action.action_type.as_str(), params_json],
        )
        .map_err(|e| e.to_string())?;
    }

    let actions = load_rule_actions(&db, rule_id)?;
    let created_at: String = db
        .query_row(
            "SELECT created_at FROM rules WHERE id = ?1",
            params![rule_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    Ok(Rule {
        id: Some(rule_id),
        name: rule.name,
        enabled: rule.enabled,
        priority: rule.priority,
        trigger: rule.trigger,
        condition: rule.condition,
        stop_after: rule.stop_after,
        scope_folder: rule.scope_folder,
        actions,
        created_at: Some(created_at),
        updated_at: Some(now),
    })
}

#[tauri::command]
pub fn delete_rule(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let db = state.db.lock();
    db.execute("DELETE FROM rules WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn toggle_rule(state: State<'_, AppState>, id: i64, enabled: bool) -> Result<(), String> {
    let db = state.db.lock();
    db.execute(
        "UPDATE rules SET enabled = ?1 WHERE id = ?2",
        params![enabled as i32, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn reorder_rules(state: State<'_, AppState>, rule_ids: Vec<i64>) -> Result<(), String> {
    let db = state.db.lock();
    for (i, id) in rule_ids.iter().enumerate() {
        db.execute(
            "UPDATE rules SET priority = ?1 WHERE id = ?2",
            params![i as i32, id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn test_rule(
    state: State<'_, AppState>,
    filename: String,
    rule_id: Option<i64>,
) -> Result<serde_json::Value, String> {
    let db = state.db.lock();
    let rules = load_all_rules(&db)?;

    let path = PathBuf::from(&filename);
    let ext = path
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let name = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let meta = FileMeta {
        name,
        extension: ext.clone(),
        size: 0,
        mtime: String::new(),
        kind: crate::models::extension_to_kind(&ext),
        path: filename.clone(),
        source_folder: String::new(),
    };

    let rules_to_check: Vec<Rule> = if let Some(rid) = rule_id {
        rules.into_iter().filter(|r| r.id == Some(rid)).collect()
    } else {
        rules
    };

    match engine::evaluate(&meta, &rules_to_check, &TriggerType::Arrival) {
        Some(result) => {
            let dest = result
                .actions
                .first()
                .and_then(|a| a.params.destination.clone());
            Ok(serde_json::json!({
                "matched": true,
                "rule_name": result.rule.name,
                "destination": dest
            }))
        }
        None => Ok(serde_json::json!({
            "matched": false
        })),
    }
}

fn load_all_rules(db: &rusqlite::Connection) -> Result<Vec<Rule>, String> {
    let mut stmt = db
        .prepare(
            "SELECT id, name, enabled, priority, trigger_type, condition, stop_after, scope_folder, created_at, updated_at
             FROM rules ORDER BY priority",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i32>(2)?,
                row.get::<_, i32>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, i32>(6)?,
                row.get::<_, Option<i64>>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut rules = Vec::new();
    for row in rows {
        let (id, name, enabled, priority, trigger_str, condition_json, stop_after, scope_folder, created_at, updated_at) =
            row.map_err(|e| e.to_string())?;

        let condition: Condition =
            serde_json::from_str(&condition_json).map_err(|e| e.to_string())?;
        let trigger: TriggerType =
            serde_json::from_str(&format!("\"{}\"", trigger_str)).unwrap_or(TriggerType::Arrival);
        let actions = load_rule_actions(db, id)?;

        rules.push(Rule {
            id: Some(id),
            name,
            enabled: enabled != 0,
            priority,
            trigger,
            condition,
            stop_after: stop_after != 0,
            scope_folder,
            actions,
            created_at: Some(created_at),
            updated_at: Some(updated_at),
        });
    }

    Ok(rules)
}

#[tauri::command]
pub fn preview_folder(state: State<'_, AppState>, folder_id: i64) -> Result<PlanSummary, String> {
    let db = state.db.lock();

    let folder: WatchedFolder = db
        .query_row(
            "SELECT id, path, recursive, enabled, created_at FROM watched_folders WHERE id = ?1",
            params![folder_id],
            |row| {
                Ok(WatchedFolder {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    recursive: row.get::<_, i32>(2)? != 0,
                    enabled: row.get::<_, i32>(3)? != 0,
                    created_at: row.get(4)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;

    let rules = load_all_rules(&db)?;

    let folder_path = Path::new(&folder.path);
    let entries: Vec<PathBuf> = if folder.recursive {
        walkdir(folder_path)
    } else {
        std::fs::read_dir(folder_path)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_file())
            .map(|e| e.path())
            .collect()
    };

    let existing_files: HashSet<PathBuf> = HashSet::new();
    let mut all_steps = Vec::new();
    let mut unmatched = 0;

    for entry in entries {
        if watcher::should_ignore_file(&entry) {
            continue;
        }

        let meta = match FileMeta::from_path(&entry) {
            Ok(m) => m,
            Err(_) => continue,
        };

        match engine::evaluate(&meta, &rules, &TriggerType::Scan) {
            Some(result) => {
                let steps =
                    planner::plan(&meta, &result.rule, &result.actions, &existing_files);
                all_steps.extend(steps);
            }
            None => {
                unmatched += 1;
            }
        }
    }

    Ok(planner::build_summary(&all_steps, unmatched))
}

fn walkdir(path: &Path) -> Vec<PathBuf> {
    let mut result = Vec::new();
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                result.extend(walkdir(&p));
            } else if p.is_file() {
                result.push(p);
            }
        }
    }
    result
}

#[tauri::command]
pub fn apply_plan(
    state: State<'_, AppState>,
    folder_id: i64,
    selected_paths: Vec<String>,
) -> Result<Operation, String> {
    let db = state.db.lock();

    let folder: WatchedFolder = db
        .query_row(
            "SELECT id, path, recursive, enabled, created_at FROM watched_folders WHERE id = ?1",
            params![folder_id],
            |row| {
                Ok(WatchedFolder {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    recursive: row.get::<_, i32>(2)? != 0,
                    enabled: row.get::<_, i32>(3)? != 0,
                    created_at: row.get(4)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;

    let rules = load_all_rules(&db)?;
    let selected_set: HashSet<String> = selected_paths.into_iter().collect();

    let folder_path = Path::new(&folder.path);
    let entries: Vec<PathBuf> = if folder.recursive {
        walkdir(folder_path)
    } else {
        std::fs::read_dir(folder_path)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_file())
            .map(|e| e.path())
            .collect()
    };

    let existing_files: HashSet<PathBuf> = HashSet::new();
    let mut all_steps = Vec::new();

    for entry in entries {
        if watcher::should_ignore_file(&entry) {
            continue;
        }

        let path_str = entry.to_string_lossy().to_string();
        if !selected_set.is_empty() && !selected_set.contains(&path_str) {
            continue;
        }

        let meta = match FileMeta::from_path(&entry) {
            Ok(m) => m,
            Err(_) => continue,
        };

        if let Some(result) = engine::evaluate(&meta, &rules, &TriggerType::Scan) {
            let steps = planner::plan(&meta, &result.rule, &result.actions, &existing_files);
            all_steps.extend(steps);
        }
    }

    let mut recently_written = state.recently_written.lock();
    let operation_id =
        executor::execute_plan(&db, &all_steps, "manual", &mut recently_written)?;

    let op = db
        .query_row(
            "SELECT id, source, status, summary, started_at, finished_at FROM operations WHERE id = ?1",
            params![operation_id],
            |row| {
                Ok(Operation {
                    id: row.get(0)?,
                    source: row.get(1)?,
                    status: row.get(2)?,
                    summary: row.get(3)?,
                    started_at: row.get(4)?,
                    finished_at: row.get(5)?,
                    steps: None,
                })
            },
        )
        .map_err(|e| e.to_string())?;

    Ok(op)
}

#[tauri::command]
pub fn get_operations(
    state: State<'_, AppState>,
    limit: i64,
    offset: i64,
) -> Result<Vec<Operation>, String> {
    let db = state.db.lock();
    journal::get_operations(&db, limit, offset)
}

#[tauri::command]
pub fn get_operation_steps(
    state: State<'_, AppState>,
    operation_id: i64,
) -> Result<Vec<OperationStep>, String> {
    let db = state.db.lock();
    journal::get_operation_steps(&db, operation_id)
}

#[tauri::command]
pub fn undo_operation(
    state: State<'_, AppState>,
    operation_id: i64,
) -> Result<UndoResult, String> {
    let db = state.db.lock();
    undo::undo_operation(&db, operation_id)
}

#[tauri::command]
pub fn undo_step(state: State<'_, AppState>, step_id: i64) -> Result<UndoResult, String> {
    let db = state.db.lock();
    undo::undo_step(&db, step_id)
}

#[tauri::command]
pub fn get_unsorted_files(
    state: State<'_, AppState>,
    folder_id: i64,
) -> Result<Vec<UnsortedFile>, String> {
    let db = state.db.lock();

    let folder: WatchedFolder = db
        .query_row(
            "SELECT id, path, recursive, enabled, created_at FROM watched_folders WHERE id = ?1",
            params![folder_id],
            |row| {
                Ok(WatchedFolder {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    recursive: row.get::<_, i32>(2)? != 0,
                    enabled: row.get::<_, i32>(3)? != 0,
                    created_at: row.get(4)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;

    let rules = load_all_rules(&db)?;

    let folder_path = Path::new(&folder.path);
    let entries: Vec<PathBuf> = std::fs::read_dir(folder_path)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_file())
        .map(|e| e.path())
        .collect();

    let mut unsorted = Vec::new();
    for entry in entries {
        if watcher::should_ignore_file(&entry) {
            continue;
        }
        let meta = match FileMeta::from_path(&entry) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if engine::evaluate(&meta, &rules, &TriggerType::Arrival).is_none() {
            unsorted.push(UnsortedFile {
                path: meta.path,
                name: meta.name,
                extension: meta.extension,
                size: meta.size,
                kind: meta.kind,
                modified_at: meta.mtime,
            });
        }
    }

    Ok(unsorted)
}

#[tauri::command]
pub fn get_dashboard_stats(state: State<'_, AppState>) -> Result<DashboardStats, String> {
    let db = state.db.lock();

    let files_today = journal::count_done_steps_today(&db)?;
    let files_week = journal::count_done_steps_week(&db)?;

    let active_rules: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM rules WHERE enabled = 1",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    let watched_folders: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM watched_folders WHERE enabled = 1",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    let recent_operations = journal::get_operations(&db, 10, 0)?;

    Ok(DashboardStats {
        files_organized_today: files_today,
        files_organized_week: files_week,
        active_rules: active_rules as usize,
        watched_folders: watched_folders as usize,
        recent_operations,
    })
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    let db = state.db.lock();

    let get_setting = |key: &str, default: &str| -> String {
        db.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .unwrap_or_else(|_| default.to_string())
    };

    let ignore_str = get_setting("ignore_patterns", "[]");
    let ignore_patterns: Vec<String> =
        serde_json::from_str(&ignore_str).unwrap_or_default();

    Ok(AppSettings {
        conflict_default: get_setting("conflict_default", "auto_rename"),
        notification_level: get_setting("notification_level", "batched"),
        theme: get_setting("theme", "system"),
        scan_schedule_minutes: get_setting("scan_schedule_minutes", "60")
            .parse()
            .unwrap_or(60),
        ignore_patterns,
    })
}

#[tauri::command]
pub fn update_setting(state: State<'_, AppState>, key: String, value: String) -> Result<(), String> {
    let db = state.db.lock();
    db.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn start_watching(state: State<'_, AppState>) -> Result<(), String> {
    let mut watching = state.watching.lock();
    *watching = true;
    log::info!("File watching started");
    Ok(())
}

#[tauri::command]
pub fn stop_watching(state: State<'_, AppState>) -> Result<(), String> {
    let mut watching = state.watching.lock();
    *watching = false;
    log::info!("File watching stopped");
    Ok(())
}
