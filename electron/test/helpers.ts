import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import { openMemoryDb } from '../core/db';
import type { PlannedStep } from '../core/planner';
import { scanInventory } from '../core/storage/inventory';
import { createScan, insertFiles, finishScan } from '../core/storage/repo';

const created: string[] = [];

/**
 * Create a throwaway directory tree of synthetic files under the OS temp dir.
 * `spec` maps relative paths to contents; a path ending in "/" makes an empty
 * directory. Everything created here is removed after each test, so tests never
 * touch real user files.
 */
export function makeTmpTree(spec: Record<string, string | Buffer> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fileflow-test-'));
  created.push(root);
  for (const [rel, content] of Object.entries(spec)) {
    const full = path.join(root, rel);
    if (rel.endsWith('/')) {
      fs.mkdirSync(full, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }
  // Resolve symlinked temp dirs (macOS /var -> /private/var) so paths compare equal.
  return fs.realpathSync(root);
}

afterEach(() => {
  while (created.length) {
    const dir = created.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Fresh in-memory database with all migrations (and the default rules) applied. */
export function openTestDb() {
  return openMemoryDb();
}

/** Insert a watched folder row and return it. */
export function addFolder(db: any, folderPath: string, recursive = false) {
  const info = db
    .prepare('INSERT INTO watched_folders (path, recursive, enabled, created_at) VALUES (?, ?, 1, ?)')
    .run(folderPath, recursive ? 1 : 0, new Date().toISOString().slice(0, 19));
  return db.prepare('SELECT * FROM watched_folders WHERE id = ?').get(info.lastInsertRowid);
}

/** Remove the seeded default rules so a test controls exactly which rules exist. */
export function clearRules(db: any) {
  db.prepare('DELETE FROM rules').run();
}

export function insertRule(
  db: any,
  opts: {
    name?: string;
    priority?: number;
    trigger?: string;
    condition: unknown;
    actions: { action_type: string; params: Record<string, unknown> }[];
  }
): number {
  const ts = '2026-01-01T00:00:00';
  const info = db
    .prepare(
      `INSERT INTO rules (name, enabled, priority, trigger_type, condition, stop_after, scope_folder, created_at, updated_at)
       VALUES (?, 1, ?, ?, ?, 1, NULL, ?, ?)`
    )
    .run(
      opts.name ?? 'Test rule',
      opts.priority ?? 1,
      opts.trigger ?? 'both',
      JSON.stringify(opts.condition),
      ts,
      ts
    );
  const id = Number(info.lastInsertRowid);
  opts.actions.forEach((a, i) =>
    db
      .prepare('INSERT INTO rule_actions (rule_id, position, action_type, params) VALUES (?, ?, ?, ?)')
      .run(id, i, a.action_type, JSON.stringify(a.params))
  );
  return id;
}

/** Recursively list files under a directory as sorted forward-slash relative paths. */
export function listTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full).replace(/\\/g, '/'));
    }
  };
  walk(root);
  return out.sort();
}

/** A planned step for a real file, with size/mtime taken from disk exactly as the planner records them. */
export function stepFor(
  src: string,
  action: PlannedStep['action_type'],
  dst: string | null,
  extra: Partial<PlannedStep> = {}
): PlannedStep {
  const st = fs.statSync(src);
  return {
    rule_id: 1,
    rule_name: 'Test',
    action_type: action,
    src_path: src,
    dst_path: dst,
    file_size: st.size,
    file_mtime: st.mtime.toISOString().slice(0, 19),
    selected: true,
    ...extra,
  };
}

/** Scan real folders into the database exactly as a finished storage scan would, and return its id. */
export async function buildInventory(db: any, roots: string[], opts: { includeHidden?: boolean } = {}): Promise<number> {
  const scanId = createScan(db, roots);
  const result = await scanInventory({
    roots,
    includeHidden: opts.includeHidden,
    onBatch: (files) => insertFiles(db, scanId, files),
  });
  finishScan(db, scanId, {
    fileCount: result.filesScanned,
    dirCount: result.dirsScanned,
    storedBytes: result.storedBytes,
    logicalBytes: result.logicalBytes,
    errorCount: result.errorCount,
  });
  return scanId;
}

/** Try to create a hard link; false when the filesystem or permissions do not allow it. */
export function tryHardLink(target: string, link: string): boolean {
  try {
    fs.linkSync(target, link);
    return true;
  } catch {
    return false;
  }
}

/** Try to create a symlink/junction; false when the OS or permissions do not allow it. */
export function trySymlink(target: string, link: string, type: 'file' | 'junction'): boolean {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch {
    return false;
  }
}
