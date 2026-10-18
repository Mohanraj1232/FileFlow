import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { cleanupFiles, InvalidCleanupError, MAX_CLEANUP_FILES } from './cleanup';
import * as repo from './repo';
import { undoOperation } from '../undo';
import * as journal from '../journal';
import { RecentlyWritten, } from '../watcher';
import { protectAppDataDir } from '../paths';
import { openTestDb, makeTmpTree, listTree, buildInventory, tryHardLink, trySymlink } from '../../test/helpers';
import type { InvFile } from './inventory';

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
beforeEach(() => {
  db = openTestDb();
  trashed.length = 0;
});
afterEach(() => db.close());

const scanRow = (id: number) => repo.getScan(db, id)!;
const without = (root: string) => listTree(root).filter((p) => !p.startsWith('FileFlow Quarantine'));

describe('quarantine mode', () => {
  it('moves the chosen files aside, leaves the rest, and journals it under "cleanup:"', async () => {
    const root = makeTmpTree({ 'big.bin': 'x'.repeat(500), 'old.iso': 'y'.repeat(300), 'keep.txt': 'k' });
    const id = await buildInventory(db, [root]);

    const out = await cleanupFiles(db, scanRow(id), [path.join(root, 'big.bin'), path.join(root, 'old.iso')], 'quarantine', null);

    expect(out.removed.map((r) => path.basename(r.path)).sort()).toEqual(['big.bin', 'old.iso']);
    expect(out.skipped).toEqual([]);
    expect(out.reclaimedBytes).toBe(800);
    expect(without(root)).toEqual(['keep.txt']);
    expect(listTree(root).filter((p) => p.startsWith('FileFlow Quarantine/'))).toHaveLength(2);
    expect(db.prepare('SELECT source, status FROM operations WHERE id = ?').get(out.operationId)).toEqual({
      source: `cleanup:${id}`,
      status: 'done',
    });
  });

  it('is undoable from History', async () => {
    const root = makeTmpTree({ 'a.bin': 'aaaa', 'b.bin': 'bb', 'c.txt': 'c' });
    const before = listTree(root);
    const id = await buildInventory(db, [root]);
    const out = await cleanupFiles(db, scanRow(id), [path.join(root, 'a.bin'), path.join(root, 'b.bin')], 'quarantine', null);

    const undo = await undoOperation(db, out.operationId!);
    expect(undo).toMatchObject({ success: true, steps_undone: 2 });
    expect(without(root)).toEqual(before);
  });

  it('keeps the report honest: removed files leave it and the totals shrink', async () => {
    const root = makeTmpTree({ 'a.bin': 'x'.repeat(100), 'b.bin': 'y'.repeat(40) });
    const id = await buildInventory(db, [root]);
    expect(scanRow(id)).toMatchObject({ file_count: 2, stored_bytes: 140 });

    await cleanupFiles(db, scanRow(id), [path.join(root, 'a.bin')], 'quarantine', null);

    expect(scanRow(id)).toMatchObject({ file_count: 1, stored_bytes: 40, logical_bytes: 40 });
    expect(repo.queryFiles(db, id, {}).files.map((f) => f.name)).toEqual(['b.bin']);
  });

  it('registers moved files so the folder watcher ignores them', async () => {
    const root = makeTmpTree({ 'a.bin': 'x' });
    const id = await buildInventory(db, [root]);
    const tracker = new RecentlyWritten(30_000);
    const out = await cleanupFiles(db, scanRow(id), [path.join(root, 'a.bin')], 'quarantine', tracker);
    const step = journal.getOperationSteps(db, out.operationId!)[0];
    expect(tracker.contains(step.dst_path)).toBe(true);
  });

  it('refuses to quarantine something already in quarantine, but can trash it', async () => {
    const root = makeTmpTree({ 'FileFlow Quarantine/2026-01-01_000000/b/old.txt': 'old' });
    const file = path.join(root, 'FileFlow Quarantine', '2026-01-01_000000', 'b', 'old.txt');
    const id = await buildInventory(db, [root]);

    const q = await cleanupFiles(db, scanRow(id), [file], 'quarantine', null);
    expect(q.removed).toEqual([]);
    expect(q.skipped[0].reason).toMatch(/Already in quarantine/);

    const t = await cleanupFiles(db, scanRow(id), [file], 'trash', null);
    expect(t.removed).toHaveLength(1);
    expect(trashed).toEqual([file]);
  });
});

describe('trash mode', () => {
  it('sends only the chosen files to the trash', async () => {
    const root = makeTmpTree({ 'a.bin': 'aaa', 'b.bin': 'bbb' });
    const id = await buildInventory(db, [root]);
    const out = await cleanupFiles(db, scanRow(id), [path.join(root, 'a.bin')], 'trash', null);
    expect(trashed).toEqual([path.join(root, 'a.bin')]);
    expect(out.removed).toHaveLength(1);
    expect(listTree(root)).toEqual(['b.bin']);
  });
});

describe('what may be removed', () => {
  it('only files that belong to the scan: the renderer cannot name arbitrary paths', async () => {
    const root = makeTmpTree({ 'in.bin': 'x' });
    const outside = makeTmpTree({ 'precious.txt': 'keep me' });
    const id = await buildInventory(db, [root]);

    const out = await cleanupFiles(db, scanRow(id), [path.join(outside, 'precious.txt'), path.join(root, 'in.bin')], 'trash', null);

    expect(out.skipped).toEqual([{ path: path.join(outside, 'precious.txt'), reason: 'Not part of this scan' }]);
    expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep me');
    expect(out.removed).toHaveLength(1);
  });

  it.each([
    ['nothing', []],
    ['non-strings', [1, 2]],
    ['not an array', 'a.txt'],
  ])('rejects a request with %s', async (_label, paths) => {
    const root = makeTmpTree({ 'a.bin': 'x' });
    const id = await buildInventory(db, [root]);
    await expect(cleanupFiles(db, scanRow(id), paths as any, 'trash', null)).rejects.toBeInstanceOf(InvalidCleanupError);
    expect(listTree(root)).toEqual(['a.bin']);
  });

  it('rejects too many files at once, an unknown mode, and an unfinished scan', async () => {
    const root = makeTmpTree({ 'a.bin': 'x' });
    const id = await buildInventory(db, [root]);
    const many = Array.from({ length: MAX_CLEANUP_FILES + 1 }, (_, i) => `/f${i}`);
    await expect(cleanupFiles(db, scanRow(id), many, 'trash', null)).rejects.toThrow(/at most/);
    await expect(cleanupFiles(db, scanRow(id), [path.join(root, 'a.bin')], 'delete' as any, null)).rejects.toThrow(/Unknown removal mode/);
    await expect(cleanupFiles(db, { ...scanRow(id), state: 'running' }, [path.join(root, 'a.bin')], 'trash', null)).rejects.toThrow(/not finished/);
    expect(listTree(root)).toEqual(['a.bin']);
  });

  it('skips a file that changed size after the scan', async () => {
    const root = makeTmpTree({ 'a.bin': 'short' });
    const id = await buildInventory(db, [root]);
    fs.writeFileSync(path.join(root, 'a.bin'), 'a much longer replacement');
    const out = await cleanupFiles(db, scanRow(id), [path.join(root, 'a.bin')], 'trash', null);
    expect(out.removed).toEqual([]);
    expect(out.skipped[0].reason).toBe('File changed since the scan');
    expect(fs.existsSync(path.join(root, 'a.bin'))).toBe(true);
  });

  it('skips a file modified after the scan even if its size is unchanged', async () => {
    const root = makeTmpTree({ 'a.bin': 'AAAA' });
    const id = await buildInventory(db, [root]);
    fs.writeFileSync(path.join(root, 'a.bin'), 'BBBB');
    fs.utimesSync(path.join(root, 'a.bin'), new Date(), new Date(Date.now() + 60_000));
    const out = await cleanupFiles(db, scanRow(id), [path.join(root, 'a.bin')], 'trash', null);
    expect(out.removed).toEqual([]);
    expect(fs.readFileSync(path.join(root, 'a.bin'), 'utf8')).toBe('BBBB');
  });

  it('skips a file that has already gone', async () => {
    const root = makeTmpTree({ 'a.bin': 'x', 'b.bin': 'y' });
    const id = await buildInventory(db, [root]);
    fs.rmSync(path.join(root, 'a.bin'));
    const out = await cleanupFiles(db, scanRow(id), [path.join(root, 'a.bin'), path.join(root, 'b.bin')], 'trash', null);
    expect(out.skipped).toEqual([{ path: path.join(root, 'a.bin'), reason: 'File no longer exists' }]);
    expect(out.removed.map((r) => path.basename(r.path))).toEqual(['b.bin']);
  });

  it('skips a file that was replaced by a symlink after the scan', async (ctx) => {
    const root = makeTmpTree({ 'a.bin': 'x', 'real.txt': 'precious' });
    const id = await buildInventory(db, [root]);
    fs.rmSync(path.join(root, 'a.bin'));
    if (!trySymlink(path.join(root, 'real.txt'), path.join(root, 'a.bin'), 'file')) ctx.skip();

    const out = await cleanupFiles(db, scanRow(id), [path.join(root, 'a.bin')], 'trash', null);
    expect(out.removed).toEqual([]);
    expect(out.skipped[0].reason).toMatch(/regular file/);
    expect(fs.readFileSync(path.join(root, 'real.txt'), 'utf8')).toBe('precious');
  });

  it('never touches a protected folder', async () => {
    const root = makeTmpTree({ 'guarded-cleanup/secret.bin': 'x' });
    protectAppDataDir(path.join(root, 'guarded-cleanup'));
    // The walker would never list this file, so put the row in by hand to prove the check itself.
    const file = path.join(root, 'guarded-cleanup', 'secret.bin');
    const scanId = repo.createScan(db, [root]);
    const row: InvFile = {
      path: file, dir: path.dirname(file), root, name: 'secret.bin', ext: 'bin', kind: 'other',
      size: 1, storedSize: 1, links: 1, mtimeMs: fs.statSync(file).mtimeMs, atimeMs: 0, birthtimeMs: 0,
    };
    repo.insertFiles(db, scanId, [row]);
    repo.finishScan(db, scanId, { fileCount: 1, dirCount: 1, storedBytes: 1, logicalBytes: 1, errorCount: 0 });

    const out = await cleanupFiles(db, scanRow(scanId), [file], 'trash', null);
    expect(out.skipped[0].reason).toMatch(/protected/);
    expect(fs.existsSync(file)).toBe(true);
    expect(trashed).toEqual([]);
  });

  it('removing a hard link frees nothing by itself', async (ctx) => {
    const root = makeTmpTree({ 'orig.bin': 'x'.repeat(400), 'solo.bin': 'y'.repeat(100) });
    if (!tryHardLink(path.join(root, 'orig.bin'), path.join(root, 'link.bin'))) ctx.skip();
    const id = await buildInventory(db, [root]);
    const out = await cleanupFiles(
      db, scanRow(id), [path.join(root, 'link.bin'), path.join(root, 'solo.bin')], 'trash', null
    );
    expect(out.removed).toHaveLength(2);
    expect(out.reclaimedBytes).toBe(100); // the 400 bytes are still held by orig.bin
  });

  it('the same path listed twice is removed once', async () => {
    const root = makeTmpTree({ 'a.bin': 'x' });
    const id = await buildInventory(db, [root]);
    const p = path.join(root, 'a.bin');
    const out = await cleanupFiles(db, scanRow(id), [p, p], 'trash', null);
    expect(out.removed).toHaveLength(1);
    expect(trashed).toEqual([p]);
  });
});
