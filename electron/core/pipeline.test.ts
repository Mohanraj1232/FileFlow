import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { processWatchedFile } from './pipeline';
import { undoOperation } from './undo';
import { RecentlyWritten } from './watcher';
import { openTestDb, makeTmpTree, addFolder, listTree, clearRules, insertRule } from '../test/helpers';

const trashed: string[] = [];
vi.mock('trash', () => ({
  default: vi.fn(async (paths: string[]) => {
    for (const p of paths) {
      trashed.push(p);
      fs.rmSync(p, { force: true });
    }
  }),
}));

let db: any;
let tracker: RecentlyWritten;
beforeEach(() => {
  db = openTestDb(); // includes the seeded default rules ({root}/Documents etc.)
  tracker = new RecentlyWritten(30_000);
  trashed.length = 0;
  folders.clear();
});
afterEach(() => db.close());

function run(file: string, root: string, over: Partial<Parameters<typeof processWatchedFile>[0]> = {}) {
  const folder = addFolderOnce(root);
  return processWatchedFile(
    { db, recentlyWritten: tracker, isEnabled: () => true, stabilityWaitMs: 0, ...over },
    file,
    { id: folder.id, path: folder.path, recursive: false }
  );
}

const folders = new Map<string, any>();
function addFolderOnce(root: string) {
  if (!folders.has(root)) folders.set(root, addFolder(db, root));
  return folders.get(root);
}

describe('processWatchedFile', () => {
  it('organizes a newly arrived file with the matching rule', async () => {
    const root = makeTmpTree({ 'notes.pdf': 'x' });
    const result = await run(path.join(root, 'notes.pdf'), root);
    expect(result).toMatchObject({ ruleName: 'Sort Documents', steps: 1 });
    expect(listTree(root)).toEqual(['Documents/notes.pdf']);
  });

  it('leaves files alone when watching is paused', async () => {
    const root = makeTmpTree({ 'notes.pdf': 'x' });
    expect(await run(path.join(root, 'notes.pdf'), root, { isEnabled: () => false })).toBeNull();
    expect(listTree(root)).toEqual(['notes.pdf']);
  });

  it('ignores files FileFlow itself just wrote (self-trigger prevention)', async () => {
    const root = makeTmpTree({ 'notes.pdf': 'x' });
    const file = path.join(root, 'notes.pdf');
    tracker.add(file);
    expect(await run(file, root)).toBeNull();
    expect(listTree(root)).toEqual(['notes.pdf']);
  });

  it('does not re-sort a file that was already sorted into a managed folder', async () => {
    const root = makeTmpTree({ 'Documents/notes.pdf': 'x' });
    expect(await run(path.join(root, 'Documents', 'notes.pdf'), root)).toBeNull();
    expect(listTree(root)).toEqual(['Documents/notes.pdf']);
  });

  it('ignores temp downloads and lock files', async () => {
    const root = makeTmpTree({ 'big.zip.crdownload': 'x', '~$draft.docx': 'x', 'a.part': 'x', 'Thumbs.db': 'x' });
    for (const name of fs.readdirSync(root)) {
      expect(await run(path.join(root, name), root)).toBeNull();
    }
    expect(listTree(root).length).toBe(4);
  });

  it('respects the ignore_patterns setting', async () => {
    const root = makeTmpTree({ 'keep-me.pdf': 'x', 'move-me.pdf': 'x' });
    db.prepare("UPDATE settings SET value = ? WHERE key = 'ignore_patterns'").run(JSON.stringify(['keep-*']));
    expect(await run(path.join(root, 'keep-me.pdf'), root)).toBeNull();
    expect(await run(path.join(root, 'move-me.pdf'), root)).not.toBeNull();
    expect(listTree(root)).toEqual(['Documents/move-me.pdf', 'keep-me.pdf']);
  });

  it('does nothing when no rule matches', async () => {
    const root = makeTmpTree({ 'mystery.qqq': 'x' });
    expect(await run(path.join(root, 'mystery.qqq'), root)).toBeNull();
    expect(listTree(root)).toEqual(['mystery.qqq']);
  });

  it('does nothing when the file vanished before it could be processed', async () => {
    const root = makeTmpTree();
    expect(await run(path.join(root, 'ghost.pdf'), root)).toBeNull();
  });

  it('an undone move is NOT sorted again (the loop the audit found)', async () => {
    const root = makeTmpTree({ 'notes.pdf': 'x' });
    const file = path.join(root, 'notes.pdf');

    const done = await run(file, root);
    expect(listTree(root)).toEqual(['Documents/notes.pdf']);

    await undoOperation(db, done!.operationId, tracker);
    expect(listTree(root)).toEqual(['notes.pdf']);

    // The watcher now reports the restored file. It must be left where it is.
    expect(await run(file, root)).toBeNull();
    expect(listTree(root)).toEqual(['notes.pdf']);
  });

  it('with policy "skip", an existing destination file is left alone and the source stays', async () => {
    const root = makeTmpTree({ 'notes.pdf': 'NEW', 'Documents/notes.pdf': 'OLD' });
    db.prepare("UPDATE settings SET value = 'skip' WHERE key = 'conflict_default'").run();
    expect(await run(path.join(root, 'notes.pdf'), root)).toBeNull();
    expect(fs.readFileSync(path.join(root, 'notes.pdf'), 'utf8')).toBe('NEW');
    expect(fs.readFileSync(path.join(root, 'Documents', 'notes.pdf'), 'utf8')).toBe('OLD');
  });

  it('with the default policy, an existing destination file is never overwritten', async () => {
    const root = makeTmpTree({ 'notes.pdf': 'NEW', 'Documents/notes.pdf': 'OLD' });
    await run(path.join(root, 'notes.pdf'), root);
    expect(fs.readFileSync(path.join(root, 'Documents', 'notes.pdf'), 'utf8')).toBe('OLD');
    expect(fs.readFileSync(path.join(root, 'Documents', 'notes (2).pdf'), 'utf8')).toBe('NEW');
  });

  it('with replace_if_identical, an identical file is dropped, a different one is kept', async () => {
    const root = makeTmpTree({
      'same.pdf': 'DUP', 'Documents/same.pdf': 'DUP',
      'diff.pdf': 'NEW', 'Documents/diff.pdf': 'OLD',
    });
    db.prepare("UPDATE settings SET value = 'replace_if_identical' WHERE key = 'conflict_default'").run();

    await run(path.join(root, 'same.pdf'), root);
    await run(path.join(root, 'diff.pdf'), root);

    expect(trashed).toEqual([path.join(root, 'same.pdf')]);
    expect(fs.readFileSync(path.join(root, 'Documents', 'diff.pdf'), 'utf8')).toBe('OLD');
    expect(fs.readFileSync(path.join(root, 'Documents', 'diff (2).pdf'), 'utf8')).toBe('NEW');
    expect(fs.existsSync(path.join(root, 'diff.pdf'))).toBe(false);
  });

  it('honours custom rules and their priority', async () => {
    const root = makeTmpTree({ 'invoice-2025.pdf': 'x' });
    clearRules(db);
    insertRule(db, {
      name: 'Invoices',
      priority: 1,
      condition: { all: [{ field: 'name', op: 'starts_with', value: 'invoice' }, { field: 'extension', op: 'is', value: 'pdf' }] },
      actions: [{ action_type: 'move', params: { destination: '{root}/Finance/{year}' } }],
    });
    insertRule(db, {
      name: 'All PDFs',
      priority: 2,
      condition: { field: 'extension', op: 'is', value: 'pdf' },
      actions: [{ action_type: 'move', params: { destination: '{root}/PDFs' } }],
    });
    const result = await run(path.join(root, 'invoice-2025.pdf'), root);
    expect(result?.ruleName).toBe('Invoices');
    expect(listTree(root)[0]).toMatch(/^Finance\/\d{4}\/invoice-2025\.pdf$/);
  });
});
