const Database = require('better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');

function getDbPath(userDataPath: string): string {
  return path.join(userDataPath, 'fileflow.db');
}

/**
 * Standard OS folders used to seed default rule destinations. Passed in by
 * main.ts (via Electron's app.getPath) rather than required directly here,
 * so this module stays free of an Electron dependency and easy to test.
 */
interface DefaultPaths {
  documents: string;
  pictures: string;
  videos: string;
  music: string;
  downloads: string;
}

function initDb(userDataPath: string, defaultPaths: DefaultPaths): any {
  const dbDir = userDataPath;
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const dbPath = getDbPath(userDataPath);
  const db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db, defaultPaths);

  return db;
}

function runMigrations(db: any, defaultPaths: DefaultPaths): void {
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
    migrateV1(db, defaultPaths);
  }
}

/**
 * A basic, common rule set seeded once on a brand-new install (schema
 * version 0 -> 1), so the app is immediately useful instead of shipping
 * with an empty rule list. Destinations use Electron's app.getPath()
 * results, which resolve to the correct standard folder per OS, so this
 * works unmodified on Windows, macOS, and Linux. Deliberately does not
 * include a catch-all "match everything" rule: files with no matching
 * kind stay visible in Unsorted for the user to review rather than being
 * silently moved by a rule they never reviewed.
 */
function seedDefaultRules(db: any, defaultPaths: DefaultPaths, now: string): void {
  const insertRule = db.prepare(`
    INSERT INTO rules (name, enabled, priority, trigger_type, condition, stop_after, scope_folder, created_at, updated_at)
    VALUES (?, 1, ?, 'both', ?, 1, NULL, ?, ?)
  `);
  const insertAction = db.prepare(`
    INSERT INTO rule_actions (rule_id, position, action_type, params)
    VALUES (?, 0, 'move', ?)
  `);

  const archives = path.join(defaultPaths.documents, 'Archives');
  const code = path.join(defaultPaths.documents, 'Code');
  const installers = path.join(defaultPaths.downloads, 'Installers');

  const rules: { name: string; kind: string; destination: string; priority: number }[] = [
    { name: 'Sort Documents', kind: 'document', destination: defaultPaths.documents, priority: 10 },
    { name: 'Sort Images', kind: 'image', destination: defaultPaths.pictures, priority: 20 },
    { name: 'Sort Videos', kind: 'video', destination: defaultPaths.videos, priority: 30 },
    { name: 'Sort Audio', kind: 'audio', destination: defaultPaths.music, priority: 40 },
    { name: 'Sort Archives', kind: 'archive', destination: archives, priority: 50 },
    { name: 'Sort Code Files', kind: 'code', destination: code, priority: 60 },
    { name: 'Sort Installers', kind: 'installer', destination: installers, priority: 70 },
  ];

  for (const rule of rules) {
    const condition = JSON.stringify({ field: 'kind', op: 'is', value: rule.kind });
    const result = insertRule.run(rule.name, rule.priority, condition, now, now);
    const params = JSON.stringify({ destination: rule.destination, on_conflict: 'auto_rename' });
    insertAction.run(result.lastInsertRowid, params);
  }
}

function migrateV1(db: any, defaultPaths: DefaultPaths): void {
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
    insertSetting.run('theme', 'dark');
    insertSetting.run('scan_schedule_minutes', '60');
    insertSetting.run('ignore_patterns', '[]');

    // Seed a basic common rule set so the app is useful immediately on a
    // fresh install, on any device/OS.
    const now = new Date().toISOString().slice(0, 19);
    seedDefaultRules(db, defaultPaths, now);

    // Set schema version
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(1);
  });

  migrate();
}

module.exports = { getDbPath, initDb };
