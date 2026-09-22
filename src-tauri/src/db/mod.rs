use rusqlite::{Connection, Result as SqlResult};
use std::path::PathBuf;

const CURRENT_SCHEMA_VERSION: i32 = 1;

pub fn get_db_path(app_data_dir: &PathBuf) -> PathBuf {
    app_data_dir.join("fileflow.db")
}

pub fn init_db(db_path: &PathBuf) -> SqlResult<Connection> {
    std::fs::create_dir_all(db_path.parent().unwrap()).ok();
    let conn = Connection::open(db_path)?;
    conn.execute_batch("PRAGMA journal_mode=WAL;")?;
    conn.execute_batch("PRAGMA foreign_keys=ON;")?;
    run_migrations(&conn)?;
    Ok(conn)
}

fn run_migrations(conn: &Connection) -> SqlResult<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)",
        [],
    )?;

    let version: i32 = conn
        .query_row("SELECT COALESCE(MAX(version), 0) FROM schema_version", [], |row| {
            row.get(0)
        })?;

    if version < 1 {
        migrate_v1(conn)?;
    }

    Ok(())
}

fn migrate_v1(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS watched_folders (
            id            INTEGER PRIMARY KEY,
            path          TEXT NOT NULL UNIQUE,
            recursive     INTEGER NOT NULL DEFAULT 0,
            enabled       INTEGER NOT NULL DEFAULT 1,
            created_at    TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS rules (
            id            INTEGER PRIMARY KEY,
            name          TEXT NOT NULL,
            enabled       INTEGER NOT NULL DEFAULT 1,
            priority      INTEGER NOT NULL,
            trigger_type  TEXT NOT NULL DEFAULT 'arrival',
            condition     TEXT NOT NULL,
            stop_after    INTEGER NOT NULL DEFAULT 1,
            scope_folder  INTEGER REFERENCES watched_folders(id),
            created_at    TEXT NOT NULL,
            updated_at    TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS rule_actions (
            id            INTEGER PRIMARY KEY,
            rule_id       INTEGER NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
            position      INTEGER NOT NULL,
            action_type   TEXT NOT NULL,
            params        TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS operations (
            id            INTEGER PRIMARY KEY,
            source        TEXT NOT NULL,
            status        TEXT NOT NULL,
            summary       TEXT,
            started_at    TEXT NOT NULL,
            finished_at   TEXT
        );

        CREATE TABLE IF NOT EXISTS operation_steps (
            id            INTEGER PRIMARY KEY,
            operation_id  INTEGER NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
            seq           INTEGER NOT NULL,
            rule_id       INTEGER REFERENCES rules(id) ON DELETE SET NULL,
            action_type   TEXT NOT NULL,
            src_path      TEXT NOT NULL,
            dst_path      TEXT,
            file_size     INTEGER,
            file_mtime    TEXT,
            content_hash  TEXT,
            status        TEXT NOT NULL,
            error         TEXT,
            executed_at   TEXT
        );

        CREATE TABLE IF NOT EXISTS file_index (
            path          TEXT PRIMARY KEY,
            size          INTEGER NOT NULL,
            mtime         TEXT NOT NULL,
            hash          TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_file_index_size ON file_index(size);

        CREATE TABLE IF NOT EXISTS settings (
            key           TEXT PRIMARY KEY,
            value         TEXT NOT NULL
        );

        INSERT OR IGNORE INTO settings (key, value) VALUES ('conflict_default', 'auto_rename');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('notification_level', 'batched');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('theme', 'system');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('scan_schedule_minutes', '60');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('ignore_patterns', '[]');

        INSERT INTO schema_version (version) VALUES (1);
        ",
    )?;
    Ok(())
}
