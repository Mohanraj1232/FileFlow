import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { scanDuplicates } from './scan';
import { resolveDuplicates, InvalidDecisionError, type Decision } from './resolve';
import { DuplicateScanStore, type ScanEntry } from './store';
import { undoOperation } from '../undo';
import * as journal from '../journal';
import { RecentlyWritten } from '../watcher';
import { openTestDb, makeTmpTree, listTree } from '../../test/helpers';

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

/** Scan real files and wrap the result as a finished scan entry. */
async function finishedScan(roots: string[]): Promise<ScanEntry> {
  const result = await scanDuplicates({ roots });
  return {
    id: 'test-scan',
    roots,
    state: 'done',
    progress: null,
    result,
    error: null,
    startedAt: Date.now(),
    finishedAt: Date.now(),
    controller: new AbortController(),
  };
}

const keepOnly = (entry: ScanEntry, keepName: string): Decision[] =>
  entry.result!.groups.map((g) => ({
    hash: g.hash,
    keep: g.files.filter((f) => f.name === keepName).map((f) => f.path),
  }));

describe('quarantine mode', () => {
  it('moves the unwanted copies into a quarantine folder and keeps the chosen one', async () => {
    const root = makeTmpTree({ 'keep.txt': 'same bytes', 'copy1.txt': 'same bytes', 'sub/copy2.txt': 'same bytes', 'other.txt': 'unrelated' });
    const entry = await finishedScan([root]);

    const out = await resolveDuplicates(db, entry, keepOnly(entry, 'keep.txt'), 'quarantine', null);

    expect(out.removed.map((r) => path.basename(r.path)).sort()).toEqual(['copy1.txt', 'copy2.txt']);
    expect(out.skipped).toEqual([]);
    expect(out.reclaimedBytes).toBe(2 * 'same bytes'.length);
    const left = listTree(root);
    expect(left).toContain('keep.txt');
    expect(left).toContain('other.txt');
    expect(left.filter((p) => p.startsWith('FileFlow Quarantine/'))).toHaveLength(2);
    expect(left).not.toContain('copy1.txt');
    expect(left).not.toContain('sub/copy2.txt');
  });

  it('is journaled under the duplicates source and fully undoable', async () => {
    const root = makeTmpTree({ 'keep.txt': 'same bytes', 'copy1.txt': 'same bytes', 'sub/copy2.txt': 'same bytes' });
    const before = listTree(root);
    const entry = await finishedScan([root]);

    const out = await resolveDuplicates(db, entry, keepOnly(entry, 'keep.txt'), 'quarantine', null);
    const op = db.prepare('SELECT * FROM operations WHERE id = ?').get(out.operationId);
    expect(op.source).toBe('duplicates:test-scan');
    expect(op.status).toBe('done');

    const undo = await undoOperation(db, out.operationId!);
    expect(undo).toMatchObject({ success: true, steps_undone: 2 });
    expect(listTree(root).filter((p) => !p.startsWith('FileFlow Quarantine'))).toEqual(before);
  });

  it('quarantined files are not found as duplicates by the next scan', async () => {
    const root = makeTmpTree({ 'keep.txt': 'same bytes', 'copy1.txt': 'same bytes' });
    const entry = await finishedScan([root]);
    await resolveDuplicates(db, entry, keepOnly(entry, 'keep.txt'), 'quarantine', null);
    expect((await scanDuplicates({ roots: [root] })).groups).toEqual([]);
  });

  it('copies with the same name from different folders do not collide in quarantine', async () => {
    const root = makeTmpTree({ 'keep/doc.txt': 'same bytes', 'a/doc.txt': 'same bytes', 'b/doc.txt': 'same bytes' });
    const entry = await finishedScan([root]);
    const keep = entry.result!.groups[0].files.find((f) => f.path.includes(`keep${path.sep}`))!;
    const out = await resolveDuplicates(db, entry, [{ hash: entry.result!.groups[0].hash, keep: [keep.path] }], 'quarantine', null);
    expect(out.removed).toHaveLength(2);
    const quarantined = listTree(root).filter((p) => p.startsWith('FileFlow Quarantine/'));
    expect(quarantined).toHaveLength(2);
    expect(new Set(quarantined).size).toBe(2);
  });

  it('registers moved files so the folder watcher ignores them', async () => {
    const root = makeTmpTree({ 'keep.txt': 'same bytes', 'copy1.txt': 'same bytes' });
    const entry = await finishedScan([root]);
    const tracker = new RecentlyWritten(30_000);
    const out = await resolveDuplicates(db, entry, keepOnly(entry, 'keep.txt'), 'quarantine', tracker);
    const step = journal.getOperationSteps(db, out.operationId!)[0];
    expect(tracker.contains(step.dst_path)).toBe(true);
  });
});

describe('trash mode', () => {
  it('sends only the unwanted copies to the trash', async () => {
    const root = makeTmpTree({ 'keep.txt': 'same bytes', 'copy1.txt': 'same bytes' });
    const entry = await finishedScan([root]);
    const out = await resolveDuplicates(db, entry, keepOnly(entry, 'keep.txt'), 'trash', null);
    expect(trashed).toEqual([path.join(root, 'copy1.txt')]);
    expect(out.removed).toHaveLength(1);
    expect(listTree(root)).toEqual(['keep.txt']);
  });
});

describe('the last good copy is protected', () => {
  it('refuses a request that keeps nothing, and changes nothing', async () => {
    const root = makeTmpTree({ 'a.txt': 'same bytes', 'b.txt': 'same bytes' });
    const entry = await finishedScan([root]);
    const hash = entry.result!.groups[0].hash;
    await expect(resolveDuplicates(db, entry, [{ hash, keep: [] }], 'quarantine', null)).rejects.toBeInstanceOf(InvalidDecisionError);
    expect(listTree(root)).toEqual(['a.txt', 'b.txt']);
  });

  it('refuses a kept path that is not part of the group (the UI cannot name arbitrary files)', async () => {
    const root = makeTmpTree({ 'a.txt': 'same bytes', 'b.txt': 'same bytes', 'precious.txt': 'not a duplicate' });
    const entry = await finishedScan([root]);
    const hash = entry.result!.groups[0].hash;
    await expect(
      resolveDuplicates(db, entry, [{ hash, keep: [path.join(root, 'precious.txt')] }], 'trash', null)
    ).rejects.toThrow(/not part of its group/);
    expect(listTree(root)).toEqual(['a.txt', 'b.txt', 'precious.txt']);
    expect(trashed).toEqual([]);
  });

  it('refuses unknown or repeated groups', async () => {
    const root = makeTmpTree({ 'a.txt': 'same bytes', 'b.txt': 'same bytes' });
    const entry = await finishedScan([root]);
    const group = entry.result!.groups[0];
    const keep = [group.files[0].path];
    await expect(resolveDuplicates(db, entry, [{ hash: 'f'.repeat(64), keep }], 'trash', null)).rejects.toThrow(/not part of this scan/);
    await expect(
      resolveDuplicates(db, entry, [{ hash: group.hash, keep }, { hash: group.hash, keep }], 'trash', null)
    ).rejects.toThrow(/more than once/);
  });

  it('one invalid group aborts the whole request before anything is moved', async () => {
    const root = makeTmpTree({ 'a1.txt': 'aaaa', 'a2.txt': 'aaaa', 'b1.txt': 'bbbbbb', 'b2.txt': 'bbbbbb' });
    const entry = await finishedScan([root]);
    const [g1, g2] = entry.result!.groups;
    await expect(
      resolveDuplicates(db, entry, [{ hash: g1.hash, keep: [g1.files[0].path] }, { hash: g2.hash, keep: [] }], 'quarantine', null)
    ).rejects.toBeInstanceOf(InvalidDecisionError);
    expect(listTree(root)).toEqual(['a1.txt', 'a2.txt', 'b1.txt', 'b2.txt']);
  });

  it('removes NOTHING from a group whose kept file was deleted after the scan', async () => {
    const root = makeTmpTree({ 'keep.txt': 'same bytes', 'copy.txt': 'same bytes' });
    const entry = await finishedScan([root]);
    fs.rmSync(path.join(root, 'keep.txt')); // the only kept copy disappears

    const out = await resolveDuplicates(db, entry, keepOnly(entry, 'keep.txt'), 'trash', null);

    expect(out.removed).toEqual([]);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0].reason).toMatch(/could be verified/);
    expect(fs.existsSync(path.join(root, 'copy.txt'))).toBe(true); // the last copy survives
    expect(trashed).toEqual([]);
  });

  it('removes NOTHING from a group whose kept file was edited after the scan', async () => {
    const root = makeTmpTree({ 'keep.txt': 'same bytes', 'copy.txt': 'same bytes' });
    const entry = await finishedScan([root]);
    fs.writeFileSync(path.join(root, 'keep.txt'), 'same bytes'.replace('same', 'diff')); // same size, new content

    const out = await resolveDuplicates(db, entry, keepOnly(entry, 'keep.txt'), 'trash', null);
    expect(out.removed).toEqual([]);
    expect(fs.existsSync(path.join(root, 'copy.txt'))).toBe(true);
  });

  it('with several files kept, one verified copy is enough', async () => {
    const root = makeTmpTree({ 'k1.txt': 'same bytes', 'k2.txt': 'same bytes', 'x.txt': 'same bytes' });
    const entry = await finishedScan([root]);
    fs.rmSync(path.join(root, 'k1.txt')); // one kept copy is gone, the other is fine
    const group = entry.result!.groups[0];
    const keep = group.files.filter((f) => f.name.startsWith('k')).map((f) => f.path);
    const out = await resolveDuplicates(db, entry, [{ hash: group.hash, keep }], 'trash', null);
    expect(out.removed.map((r) => path.basename(r.path))).toEqual(['x.txt']);
    expect(fs.existsSync(path.join(root, 'k2.txt'))).toBe(true);
  });
});

describe('files that changed after the scan are not touched', () => {
  it('skips a copy modified after the scan', async () => {
    const root = makeTmpTree({ 'keep.txt': 'same bytes', 'edited.txt': 'same bytes', 'plain.txt': 'same bytes' });
    const entry = await finishedScan([root]);
    fs.writeFileSync(path.join(root, 'edited.txt'), 'I rewrote this file entirely');

    const out = await resolveDuplicates(db, entry, keepOnly(entry, 'keep.txt'), 'quarantine', null);

    expect(out.removed.map((r) => path.basename(r.path))).toEqual(['plain.txt']);
    expect(out.skipped).toEqual([{ path: path.join(root, 'edited.txt'), reason: 'File changed since the scan' }]);
    expect(fs.readFileSync(path.join(root, 'edited.txt'), 'utf8')).toBe('I rewrote this file entirely');
  });

  it('catches a swapped file even when its size AND modification time are unchanged', async () => {
    const root = makeTmpTree({ 'keep.txt': 'same bytes', 'sneaky.txt': 'same bytes' });
    const entry = await finishedScan([root]);
    const target = path.join(root, 'sneaky.txt');
    const original = fs.statSync(target);
    fs.writeFileSync(target, 'DIFF bytes'); // same length, different content
    // Restore the timestamp exactly (a Date only has millisecond precision and can land 1 ms off,
    // which would let the earlier modification-time check catch this instead of the content hash).
    fs.utimesSync(target, original.atimeMs / 1000, original.mtimeMs / 1000);
    expect(Math.trunc(fs.statSync(target).mtimeMs)).toBe(Math.trunc(original.mtimeMs));

    const out = await resolveDuplicates(db, entry, keepOnly(entry, 'keep.txt'), 'quarantine', null);

    expect(out.removed).toEqual([]);
    expect(out.skipped[0].reason).toMatch(/no longer matches/);
    expect(fs.readFileSync(target, 'utf8')).toBe('DIFF bytes');
  });

  it('skips a copy that has already disappeared', async () => {
    const root = makeTmpTree({ 'keep.txt': 'same bytes', 'gone.txt': 'same bytes', 'plain.txt': 'same bytes' });
    const entry = await finishedScan([root]);
    fs.rmSync(path.join(root, 'gone.txt'));
    const out = await resolveDuplicates(db, entry, keepOnly(entry, 'keep.txt'), 'trash', null);
    expect(out.removed.map((r) => path.basename(r.path))).toEqual(['plain.txt']);
    expect(out.skipped[0].reason).toMatch(/no longer exists/);
  });
});

describe('hard links', () => {
  it('leaves a hard link of a kept file alone (it would free no space)', async (ctx) => {
    const root = makeTmpTree({ 'keep.bin': 'x'.repeat(300), 'copy.bin': 'x'.repeat(300) });
    try {
      fs.linkSync(path.join(root, 'keep.bin'), path.join(root, 'link-of-keep.bin'));
    } catch {
      ctx.skip(); // filesystem without hard links: reported as skipped, not silently passed
    }
    const entry = await finishedScan([root]);
    const out = await resolveDuplicates(db, entry, keepOnly(entry, 'keep.bin'), 'trash', null);
    expect(out.removed.map((r) => path.basename(r.path))).toEqual(['copy.bin']);
    expect(out.skipped.some((s) => /Hard link/.test(s.reason))).toBe(true);
    expect(fs.existsSync(path.join(root, 'link-of-keep.bin'))).toBe(true);
    expect(out.reclaimedBytes).toBe(300);
  });
});

describe('results after removal', () => {
  it('drops removed files and resolved groups from the scan results, with totals recomputed', async () => {
    const root = makeTmpTree({
      'a1.txt': 'aaaa', 'a2.txt': 'aaaa',
      'b1.txt': 'bbbbbb', 'b2.txt': 'bbbbbb', 'b3.txt': 'bbbbbb',
    });
    const entry = await finishedScan([root]);
    expect(entry.result!.stats.reclaimableBytes).toBe(4 + 12);

    const bGroup = entry.result!.groups.find((g) => g.size === 6)!;
    await resolveDuplicates(db, entry, [{ hash: bGroup.hash, keep: [bGroup.files[0].path] }], 'trash', null);

    expect(entry.result!.groups).toHaveLength(1);
    expect(entry.result!.groups[0].size).toBe(4);
    expect(entry.result!.stats).toMatchObject({ groups: 1, duplicateFiles: 1, reclaimableBytes: 4 });
  });

  it('keeping two of three copies removes just one and keeps the group', async () => {
    const root = makeTmpTree({ 'a.txt': 'same bytes', 'b.txt': 'same bytes', 'c.txt': 'same bytes' });
    const entry = await finishedScan([root]);
    const g = entry.result!.groups[0];
    await resolveDuplicates(db, entry, [{ hash: g.hash, keep: [g.files[0].path, g.files[1].path] }], 'trash', null);
    expect(entry.result!.groups[0].files).toHaveLength(2);
    expect(listTree(root)).toHaveLength(2);
  });

  it('does nothing when no file is selected for removal', async () => {
    const root = makeTmpTree({ 'a.txt': 'same bytes', 'b.txt': 'same bytes' });
    const entry = await finishedScan([root]);
    const g = entry.result!.groups[0];
    const out = await resolveDuplicates(db, entry, [{ hash: g.hash, keep: g.files.map((f) => f.path) }], 'trash', null);
    expect(out).toMatchObject({ operationId: null, removed: [] });
    expect(listTree(root)).toEqual(['a.txt', 'b.txt']);
  });
});

describe('scans that are not finished', () => {
  it.each(['running', 'cancelled', 'failed'] as const)('refuses to act on a %s scan', async (state) => {
    const root = makeTmpTree({ 'a.txt': 'same bytes', 'b.txt': 'same bytes' });
    const entry = await finishedScan([root]);
    entry.state = state;
    await expect(resolveDuplicates(db, entry, [], 'trash', null)).rejects.toThrow(/not finished/);
  });
});

describe('DuplicateScanStore', () => {
  const wait = async (store: DuplicateScanStore, id: string) => {
    for (let i = 0; i < 200 && store.get(id)!.state === 'running'; i++) await new Promise((r) => setTimeout(r, 25));
    return store.get(id)!;
  };

  it('runs a scan in the background and keeps its results', async () => {
    const root = makeTmpTree({ 'a.txt': 'same bytes', 'b.txt': 'same bytes' });
    const store = new DuplicateScanStore();
    const started = store.start({ roots: [root], db });
    expect(started.state).toBe('running');
    const done = await wait(store, started.id);
    expect(done.state).toBe('done');
    expect(done.result!.groups).toHaveLength(1);
    expect(done.finishedAt).not.toBeNull();
  });

  it('allows only one scan at a time', async () => {
    const root = makeTmpTree({ 'a.txt': 'same bytes', 'b.txt': 'same bytes' });
    const store = new DuplicateScanStore();
    const first = store.start({ roots: [root] });
    expect(() => store.start({ roots: [root] })).toThrow(/already running/);
    await wait(store, first.id);
    expect(() => store.start({ roots: [root] })).not.toThrow();
  });

  it('cancel discards partial results', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 50; i++) files[`f${i}.txt`] = 'same bytes';
    const root = makeTmpTree(files);
    const store = new DuplicateScanStore();
    const started = store.start({ roots: [root] });
    expect(store.cancel(started.id)).toBe(true);
    const done = await wait(store, started.id);
    expect(done.state).toBe('cancelled');
    expect(done.result).toBeNull();
    expect(store.cancel(started.id)).toBe(false); // nothing left to cancel
    await expect(resolveDuplicates(db, done, [], 'trash', null)).rejects.toThrow(/not finished/);
  });

  it('uses the database hash cache, and ignores a stale entry', async () => {
    const root = makeTmpTree({ 'a.txt': 'same bytes', 'b.txt': 'same bytes' });
    const store = new DuplicateScanStore();

    const first = await wait(store, store.start({ roots: [root], db }).id);
    expect(first.result!.stats.filesHashed).toBe(2);
    expect(db.prepare('SELECT COUNT(*) c FROM file_index').get().c).toBe(2);

    const second = await wait(store, store.start({ roots: [root], db }).id);
    expect(second.result!.stats.filesFromCache).toBe(2);
    expect(second.result!.stats.filesHashed).toBe(0);

    fs.writeFileSync(path.join(root, 'a.txt'), 'changed completely');
    const third = await wait(store, store.start({ roots: [root], db }).id);
    expect(third.result!.groups).toEqual([]);
  });
});
