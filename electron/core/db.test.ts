import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrations, runMigrations, getSchemaVersion, initDb, openMemoryDb } from './db';
import { makeTmpTree } from '../test/helpers';

const LATEST = migrations[migrations.length - 1].version;

/** A database exactly as v0.1.x left it: schema v1 only, with real-looking user data. */
function legacyV1Db(file = ':memory:'): any {
  const db: any = new Database(file);
  db.pragma('foreign_keys = ON');
  db.transaction(() => {
    migrations[0].up(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (1)').run();
  })();
  return db;
}

describe('fresh install', () => {
  it('reaches the latest schema with default settings and the seeded rules', () => {
    const db = openMemoryDb();
    expect(getSchemaVersion(db)).toBe(LATEST);
    expect(db.prepare('SELECT COUNT(*) c FROM rules').get().c).toBe(7);
    expect(db.prepare("SELECT value FROM settings WHERE key = 'conflict_default'").get().value).toBe('auto_rename');
    db.close();
  });

  it('migrations are ordered, unique and contiguous', () => {
    expect(migrations.map((m) => m.version)).toEqual(migrations.map((_, i) => i + 1));
  });

  it('running migrations again is a no-op', () => {
    const db = openMemoryDb();
    const before = db.prepare('SELECT COUNT(*) c FROM rules').get().c;
    runMigrations(db);
    expect(db.prepare('SELECT COUNT(*) c FROM rules').get().c).toBe(before);
    expect(db.prepare('SELECT COUNT(*) c FROM schema_version').get().c).toBe(1);
    db.close();
  });
});

describe('upgrading a v1 database (existing users)', () => {
  function seedUserData(db: any) {
    const now = '2026-01-01T00:00:00';
    // A user-made rule, plus the legacy conflict values the old UI could save.
    const rule = db
      .prepare(
        `INSERT INTO rules (name, enabled, priority, trigger_type, condition, stop_after, scope_folder, created_at, updated_at)
         VALUES ('My PDFs', 1, 99, 'arrival', ?, 1, NULL, ?, ?)`
      )
      .run(JSON.stringify({ field: 'extension', op: 'is', value: 'pdf' }), now, now).lastInsertRowid;
    const action = (params: object) =>
      db.prepare("INSERT INTO rule_actions (rule_id, position, action_type, params) VALUES (?, 0, 'move', ?)").run(rule, JSON.stringify(params));
    action({ destination: '/x/a', on_conflict: 'replace_if_duplicate' });
    action({ destination: '/x/b', on_conflict: 'ask' });
    action({ destination: '/x/c', on_conflict: 'skip' });
    action({ destination: '/x/d' });
    db.prepare("UPDATE settings SET value = 'replace_if_duplicate' WHERE key = 'conflict_default'").run();

    const op = db.prepare("INSERT INTO operations (source, status, summary, started_at) VALUES ('manual', 'done', '1 file moved', ?)").run(now).lastInsertRowid;
    db.prepare(
      "INSERT INTO operation_steps (operation_id, seq, rule_id, action_type, src_path, dst_path, file_size, status) VALUES (?, 1, ?, 'move', '/a', '/b', 5, 'done')"
    ).run(op, rule);
    db.prepare("INSERT INTO watched_folders (path, recursive, enabled, created_at) VALUES ('/w', 1, 1, ?)").run(now);
    return { ruleId: Number(rule), opId: Number(op) };
  }

  it('keeps every rule, action, folder, setting and history entry', () => {
    const db = legacyV1Db();
    const { opId } = seedUserData(db);
    const rulesBefore = db.prepare('SELECT * FROM rules ORDER BY id').all();

    runMigrations(db);

    expect(getSchemaVersion(db)).toBe(LATEST);
    expect(db.prepare('SELECT * FROM rules ORDER BY id').all()).toEqual(rulesBefore);
    expect(db.prepare('SELECT COUNT(*) c FROM rule_actions').get().c).toBe(7 + 4);
    expect(db.prepare('SELECT COUNT(*) c FROM watched_folders').get().c).toBe(1);
    expect(db.prepare('SELECT summary FROM operations WHERE id = ?').get(opId).summary).toBe('1 file moved');
    expect(db.prepare('SELECT status, dst_path FROM operation_steps').get()).toEqual({ status: 'done', dst_path: '/b' });
    db.close();
  });

  it('rewrites legacy conflict values; implicit per-action auto_rename is dropped so the global policy applies', () => {
    const db = legacyV1Db();
    seedUserData(db);
    runMigrations(db);

    expect(db.prepare("SELECT value FROM settings WHERE key = 'conflict_default'").get().value).toBe('replace_if_identical');
    const onConflict = db
      .prepare("SELECT params FROM rule_actions WHERE params LIKE '%/x/%' ORDER BY params")
      .all()
      .map((r: any) => JSON.parse(r.params).on_conflict);
    expect(onConflict).toEqual(['replace_if_identical', undefined, 'skip', undefined]);
    // The seeded default rules no longer pin a per-action policy.
    const seeded = db.prepare("SELECT params FROM rule_actions WHERE params LIKE '%{root}%'").all();
    expect(seeded).toHaveLength(7);
    for (const row of seeded) expect(JSON.parse(row.params).on_conflict).toBeUndefined();
    db.close();
  });

  it('adds the journal indexes', () => {
    const db = legacyV1Db();
    runMigrations(db);
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r: any) => r.name);
    expect(names).toEqual(expect.arrayContaining(['idx_steps_operation', 'idx_steps_status']));
    db.close();
  });

  it('a failing migration rolls back completely and leaves the version unchanged', () => {
    const db = legacyV1Db();
    const boom = { version: 99, name: 'boom', up: (d: any) => { d.exec("INSERT INTO settings (key, value) VALUES ('leak', '1')"); throw new Error('boom'); } };
    migrations.push(boom);
    try {
      expect(() => runMigrations(db)).toThrow('boom');
    } finally {
      migrations.pop();
    }
    expect(db.prepare("SELECT 1 FROM settings WHERE key = 'leak'").get()).toBeUndefined();
    db.close();
  });
});

describe('v3: storage inventory tables', () => {
  it('are created, and deleting a scan cascades to its files and errors', () => {
    const db = openMemoryDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r: any) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['inventory_scans', 'inventory_files', 'inventory_errors']));

    db.prepare("INSERT INTO inventory_scans (id, roots, roots_key, state, started_at) VALUES (1, '[]', 'k', 'done', 'now')").run();
    db.prepare("INSERT INTO inventory_files (scan_id, root, path, dir, name, ext, kind, size, stored_size, mtime) VALUES (1, 'r', 'r/a', 'r', 'a', '', 'other', 1, 1, 0)").run();
    db.prepare("INSERT INTO inventory_errors (scan_id, path, error) VALUES (1, 'p', 'e')").run();
    db.prepare('DELETE FROM inventory_scans WHERE id = 1').run();
    expect(db.prepare('SELECT COUNT(*) c FROM inventory_files').get().c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM inventory_errors').get().c).toBe(0);
    db.close();
  });

  it('one file path per scan, and one scan per set of folders', () => {
    const db = openMemoryDb();
    db.prepare("INSERT INTO inventory_scans (id, roots, roots_key, state, started_at) VALUES (1, '[]', 'k', 'done', 'now')").run();
    const insert = () => db.prepare("INSERT INTO inventory_files (scan_id, root, path, dir, name, ext, kind, size, stored_size, mtime) VALUES (1, 'r', 'r/a', 'r', 'a', '', 'other', 1, 1, 0)").run();
    insert();
    expect(insert).toThrow(/UNIQUE/);
    expect(() => db.prepare("INSERT INTO inventory_scans (roots, roots_key, state, started_at) VALUES ('[]', 'k', 'done', 'now')").run()).toThrow(/UNIQUE/);
    db.close();
  });

  it('upgrading a v2 database keeps its data and adds the tables', () => {
    const db: any = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.transaction(() => {
      migrations[0].up(db);
      db.prepare('INSERT INTO schema_version (version) VALUES (1)').run();
    })();
    runMigrations(db); // v1 -> latest in one go
    // Pretend we were at v2 and only v3 is pending: re-run the migration path from a clean v2 state.
    db.exec('DROP TABLE inventory_errors; DROP TABLE inventory_files; DROP TABLE inventory_scans;');
    db.prepare('UPDATE schema_version SET version = 2').run();
    const rulesBefore = db.prepare('SELECT COUNT(*) c FROM rules').get().c;

    runMigrations(db);

    expect(getSchemaVersion(db)).toBe(LATEST);
    expect(db.prepare('SELECT COUNT(*) c FROM rules').get().c).toBe(rulesBefore);
    expect(db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name = 'inventory_files'").get().c).toBe(1);
    db.close();
  });
});

describe('backup before upgrading', () => {
  it('copies the database file as .bak-v1 before applying migrations', () => {
    const dir = makeTmpTree();
    const dbPath = path.join(dir, 'fileflow.db');
    const old = legacyV1Db(dbPath);
    old.prepare("INSERT INTO watched_folders (path, recursive, enabled, created_at) VALUES ('/keepme', 0, 1, 'now')").run();
    old.close();

    const db: any = new Database(dbPath);
    runMigrations(db, { dbPath });
    expect(getSchemaVersion(db)).toBe(LATEST);
    db.close();

    const backupPath = `${dbPath}.bak-v1`;
    expect(fs.existsSync(backupPath)).toBe(true);
    const backup: any = new Database(backupPath, { readonly: true });
    expect(getSchemaVersion(backup)).toBe(1);
    expect(backup.prepare('SELECT path FROM watched_folders').get().path).toBe('/keepme');
    backup.close();
  });

  it('does not back up a brand-new database', () => {
    const dir = makeTmpTree();
    const db = initDb(dir);
    db.close();
    expect(fs.readdirSync(dir).filter((f) => f.includes('.bak-'))).toEqual([]);
  });
});
