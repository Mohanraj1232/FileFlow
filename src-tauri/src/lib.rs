pub mod commands;
pub mod db;
pub mod engine;
pub mod executor;
pub mod journal;
pub mod models;
pub mod planner;
pub mod undo;
pub mod watcher;

use parking_lot::Mutex;
use rusqlite::Connection;
use std::sync::Arc;
use tauri::Manager;

pub struct AppState {
    pub db: Arc<Mutex<Connection>>,
    pub watching: Arc<Mutex<bool>>,
    pub recently_written: Arc<Mutex<watcher::RecentlyWritten>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to get app data dir");

            let db_path = db::get_db_path(&app_data_dir);
            let conn = db::init_db(&db_path).expect("Failed to initialize database");

            executor::recover_pending(&conn).ok();

            let state = AppState {
                db: Arc::new(Mutex::new(conn)),
                watching: Arc::new(Mutex::new(false)),
                recently_written: Arc::new(Mutex::new(watcher::RecentlyWritten::new())),
            };

            app.manage(state);

            log::info!("FileFlow initialized. DB at {:?}", db_path);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_watched_folders,
            commands::add_watched_folder,
            commands::remove_watched_folder,
            commands::toggle_watched_folder,
            commands::get_rules,
            commands::create_rule,
            commands::update_rule,
            commands::delete_rule,
            commands::toggle_rule,
            commands::reorder_rules,
            commands::test_rule,
            commands::preview_folder,
            commands::apply_plan,
            commands::get_operations,
            commands::get_operation_steps,
            commands::undo_operation,
            commands::undo_step,
            commands::get_unsorted_files,
            commands::get_dashboard_stats,
            commands::get_settings,
            commands::update_setting,
            commands::start_watching,
            commands::stop_watching,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
