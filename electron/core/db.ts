const Database = require('better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');

function getDbPath(userDataPath: string): string {
  return path.join(userDataPath, 'fileflow.db');
}

function initDb(userDataPath: string): any {
  const dbDir = userDataPath;
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const dbPath = getDbPath(userDataPath);
  const db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);

  return db;
}

function runMigrations(db: any): void {
  // Check current schema version
  const hasVersionTable = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
    )
    .get();

  let currentVersion = 0;
  if (hasVersionTable) {
    const row = db.prepare('SELECT version FROM schema_version').get();
    if (row) {
      currentVersion = row.version;
    }
  }

  if (currentVersion < 1) {
    migrateV1(db);
  }
}

function migrateV1(db: any): void {
  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS watched_folders (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        recursive INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rules (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL,
        trigger_type TEXT NOT NULL DEFAULT 'arrival',
        condition TEXT NOT NULL,
        stop_after INTEGER NOT NULL DEFAULT 1,
        scope_folder INTEGER REFERENCES watched_folders(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rule_actions (
        id INTEGER PRIMARY KEY,
        rule_id INTEGER NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        action_type TEXT NOT NULL,
        params TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS operations (
        id INTEGER PRIMARY KEY,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS operation_steps (
        id INTEGER PRIMARY KEY,
        operation_id INTEGER NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        rule_id INTEGER REFERENCES rules(id) ON DELETE SET NULL,
        action_type TEXT NOT NULL,
        src_path TEXT NOT NULL,
        dst_path TEXT,
        file_size INTEGER,
        file_mtime TEXT,
        content_hash TEXT,
        status TEXT NOT NULL,
        error TEXT,
        executed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS file_index (
        path TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        mtime TEXT NOT NULL,
        hash TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_file_index_size ON file_index(size);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER NOT NULL
      );
    `);

    // Insert default settings
    const insertSetting = db.prepare(
      'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
    );
    insertSetting.run('conflict_default', 'auto_rename');
    insertSetting.run('notification_level', 'batched');
    insertSetting.run('theme', 'system');
    insertSetting.run('scan_schedule_minutes', '60');
    insertSetting.run('ignore_patterns', '[]');

    // Set schema version
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(1);
  });

  migrate();
}

module.exports = { getDbPath, initDb };
