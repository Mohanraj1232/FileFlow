import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

export function getDbPath(userDataPath: string): string {
  return path.join(userDataPath, 'fileflow.db');
}

export interface Migration {
  version: number;
  name: string;
  up(db: any): void;
}

/**
 * A basic, common rule set seeded once on a brand-new install (schema
 * version 0 -> 1), so the app is immediately useful instead of shipping
 * with an empty rule list. Destinations use the {root} template variable
 * (electron/core/planner.ts expandVariables), which resolves to whichever
 * watched folder the matched file belongs to — so the same seeded rule
 * organizes correctly inside every folder the user later watches, rather
 * than funneling everything into one path hardcoded at install time.
 * Deliberately does not include a catch-all "match everything" rule: files
 * with no matching kind stay visible in Unsorted for the user to review
 * rather than being silently moved by a rule they never reviewed.
 */
function seedDefaultRules(db: any, now: string): void {
  const insertRule = db.prepare(`
    INSERT INTO rules (name, enabled, priority, trigger_type, condition, stop_after, scope_folder, created_at, updated_at)
    VALUES (?, 1, ?, 'both', ?, 1, NULL, ?, ?)
  `);
  const insertAction = db.prepare(`
    INSERT INTO rule_actions (rule_id, position, action_type, params)
    VALUES (?, 0, 'move', ?)
  `);

  const rules: { name: string; kind: string; subfolder: string; priority: number }[] = [
    { name: 'Sort Documents', kind: 'document', subfolder: 'Documents', priority: 10 },
    { name: 'Sort Images', kind: 'image', subfolder: 'Images', priority: 20 },
    { name: 'Sort Videos', kind: 'video', subfolder: 'Videos', priority: 30 },
    { name: 'Sort Audio', kind: 'audio', subfolder: 'Audio', priority: 40 },
    { name: 'Sort Archives', kind: 'archive', subfolder: 'Archives', priority: 50 },
    { name: 'Sort Code Files', kind: 'code', subfolder: 'Code', priority: 60 },
    { name: 'Sort Installers', kind: 'installer', subfolder: 'Installers', priority: 70 },
  ];

  for (const rule of rules) {
    const condition = JSON.stringify({ field: 'kind', op: 'is', value: rule.kind });
    const result = insertRule.run(rule.name, rule.priority, condition, now, now);
    const params = JSON.stringify({
      destination: `{root}/${rule.subfolder}`,
      on_conflict: 'auto_rename',
    });
    insertAction.run(result.lastInsertRowid, params);
  }
}

function migrateV1(db: any): void {
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
  seedDefaultRules(db, new Date().toISOString().slice(0, 19));
}

/**
 * v2: conflict-policy cleanup + indexes.
 *
 *  - The global setting 'replace_if_duplicate' becomes 'replace_if_identical'
 *    (it now genuinely compares content), and the never-implemented 'ask'
 *    becomes 'auto_rename'.
 *  - Per-action `on_conflict` is now an optional OVERRIDE of the global
 *    setting. Older versions stamped `on_conflict: 'auto_rename'` onto every
 *    action without the user ever choosing it (the rule builder had no such
 *    control), which would have made the global setting impossible to apply.
 *    Those implicit values are removed so rules follow the global policy;
 *    deliberate values ('skip', 'replace_if_duplicate' -> 'replace_if_identical')
 *    are kept.
 *  - Index the journal tables that History and crash recovery query by.
 */
function migrateV2(db: any): void {
  const setting = db
    .prepare("SELECT value FROM settings WHERE key = 'conflict_default'")
    .get();
  if (setting) {
    const fixed =
      setting.value === 'replace_if_duplicate'
        ? 'replace_if_identical'
        : setting.value === 'ask'
          ? 'auto_rename'
          : setting.value;
    db.prepare("UPDATE settings SET value = ? WHERE key = 'conflict_default'").run(fixed);
  }

  const actions = db.prepare('SELECT id, params FROM rule_actions').all();
  const update = db.prepare('UPDATE rule_actions SET params = ? WHERE id = ?');
  for (const action of actions) {
    try {
      const params = JSON.parse(action.params);
      if (!params || params.on_conflict === undefined) continue;

      const { on_conflict, ...rest } = params;
      if (on_conflict === 'replace_if_duplicate') {
        update.run(JSON.stringify({ ...rest, on_conflict: 'replace_if_identical' }), action.id);
      } else if (on_conflict === 'auto_rename' || on_conflict === 'ask') {
        update.run(JSON.stringify(rest), action.id);
      }
    } catch {
      // Leave unparseable params untouched; the planner tolerates them.
    }
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_steps_operation ON operation_steps(operation_id);
    CREATE INDEX IF NOT EXISTS idx_steps_status ON operation_steps(status);
  `);
}

/** Ordered list of schema migrations. Append new ones; never edit shipped ones. */
export const migrations: Migration[] = [
  { version: 1, name: 'initial schema + default rules', up: migrateV1 },
  { version: 2, name: 'conflict policy cleanup + journal indexes', up: migrateV2 },
];

export function getSchemaVersion(db: any): number {
  const hasVersionTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get();
  if (!hasVersionTable) return 0;
  const row = db.prepare('SELECT version FROM schema_version').get();
  return row ? row.version : 0;
}

export interface MigrateOptions {
  /** Path of the database file, used to take a safety copy before upgrading. */
  dbPath?: string;
}

/**
 * Apply every pending migration in order, each in its own transaction.
 * Before upgrading an existing database, a copy is saved next to it as
 * `fileflow.db.bak-v<oldVersion>` so a bad migration is never unrecoverable.
 */
export function runMigrations(db: any, options: MigrateOptions = {}): void {
  const current = getSchemaVersion(db);
  const pending = migrations.filter((m) => m.version > current);
  if (pending.length === 0) return;

  if (current > 0 && options.dbPath && fs.existsSync(options.dbPath)) {
    const backup = `${options.dbPath}.bak-v${current}`;
    if (!fs.existsSync(backup)) {
      // Fold the WAL into the main file so the copy is complete.
      db.pragma('wal_checkpoint(TRUNCATE)');
      fs.copyFileSync(options.dbPath, backup);
    }
  }

  for (const migration of pending) {
    db.transaction(() => {
      migration.up(db);
      db.prepare('DELETE FROM schema_version').run();
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migration.version);
    })();
  }
}

export function initDb(userDataPath: string): any {
  if (!fs.existsSync(userDataPath)) {
    fs.mkdirSync(userDataPath, { recursive: true });
  }

  const dbPath = getDbPath(userDataPath);
  const db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db, { dbPath });

  return db;
}

/** In-memory database with all migrations applied — for tests. */
export function openMemoryDb(): any {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}
