import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { executePlan, executeMove, executeCopy, recoverPending } from './executor';
import * as journal from './journal';
import { openTestDb, makeTmpTree, listTree, stepFor } from '../test/helpers';

// Never touch the real Recycle Bin: "trash" just deletes the synthetic file.
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
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

const steps = (opId: number) => journal.getOperationSteps(db, opId);

describe('executePlan: basic actions', () => {
  it('moves a file, journals it, and registers the destination as self-written', async () => {
    const root = makeTmpTree({ 'a.pdf': 'hello' });
    const src = path.join(root, 'a.pdf');
    const dst = path.join(root, 'Documents', 'a.pdf');
    const written = { add: vi.fn() };

    const opId = await executePlan(db, [stepFor(src, 'move', dst)], 'test', written);

    expect(fs.existsSync(src)).toBe(false);
    expect(fs.readFileSync(dst, 'utf8')).toBe('hello');
    expect(written.add).toHaveBeenCalledWith(dst);
    expect(steps(opId)).toMatchObject([{ status: 'done', action_type: 'move', src_path: src, dst_path: dst }]);
    expect(db.prepare('SELECT status, summary FROM operations WHERE id = ?').get(opId)).toEqual({
      status: 'done',
      summary: '1 file moved',
    });
  });

  it('copies a file and keeps the original', async () => {
    const root = makeTmpTree({ 'a.pdf': 'hello' });
    const dst = path.join(root, 'Backup', 'a.pdf');
    await executePlan(db, [stepFor(path.join(root, 'a.pdf'), 'copy', dst)], 'test');
    expect(listTree(root)).toEqual(['Backup/a.pdf', 'a.pdf']);
  });

  it('renames a file in place', async () => {
    const root = makeTmpTree({ 'a.pdf': 'x' });
    await executePlan(db, [stepFor(path.join(root, 'a.pdf'), 'rename', path.join(root, 'b.pdf'))], 'test');
    expect(listTree(root)).toEqual(['b.pdf']);
  });

  it('sends a file to the trash', async () => {
    const root = makeTmpTree({ 'a.pdf': 'x' });
    const src = path.join(root, 'a.pdf');
    const opId = await executePlan(db, [stepFor(src, 'trash', null)], 'test');
    expect(trashed).toEqual([src]);
    expect(steps(opId)[0].status).toBe('done');
  });

  it('runs chained steps in order (move, then rename the moved file)', async () => {
    const root = makeTmpTree({ 'a.pdf': 'x' });
    const src = path.join(root, 'a.pdf');
    const moved = path.join(root, 'D', 'a.pdf');
    const renamed = path.join(root, 'D', 'b.pdf');
    await executePlan(db, [stepFor(src, 'move', moved), { ...stepFor(src, 'rename', renamed), src_path: moved }], 'test');
    expect(listTree(root)).toEqual(['D/b.pdf']);
  });

  it('never journals or runs informational "skip" steps', async () => {
    const root = makeTmpTree({ 'a.pdf': 'x' });
    const src = path.join(root, 'a.pdf');
    const opId = await executePlan(db, [stepFor(src, 'skip', path.join(root, 'D', 'a.pdf'))], 'test');
    expect(steps(opId)).toHaveLength(0);
    expect(fs.existsSync(src)).toBe(true);
  });
});

describe('executePlan: never overwrites', () => {
  it('a destination that appeared after planning gets a unique name; the existing file is untouched', async () => {
    const root = makeTmpTree({ 'a.pdf': 'NEW', 'Documents/a.pdf': 'EXISTING' });
    const src = path.join(root, 'a.pdf');
    const dst = path.join(root, 'Documents', 'a.pdf');

    const opId = await executePlan(db, [stepFor(src, 'move', dst, { policy: 'auto_rename' })], 'test');

    expect(fs.readFileSync(dst, 'utf8')).toBe('EXISTING');
    const renamed = path.join(root, 'Documents', 'a (2).pdf');
    expect(fs.readFileSync(renamed, 'utf8')).toBe('NEW');
    // The journal records where the file really went, so undo can find it.
    expect(steps(opId)[0]).toMatchObject({ status: 'done', dst_path: renamed });
  });

  it('with policy "skip", a destination that appeared leaves the source in place', async () => {
    const root = makeTmpTree({ 'a.pdf': 'NEW', 'Documents/a.pdf': 'EXISTING' });
    const src = path.join(root, 'a.pdf');
    const dst = path.join(root, 'Documents', 'a.pdf');

    const opId = await executePlan(db, [stepFor(src, 'move', dst, { policy: 'skip' })], 'test');

    expect(fs.readFileSync(src, 'utf8')).toBe('NEW');
    expect(fs.readFileSync(dst, 'utf8')).toBe('EXISTING');
    expect(steps(opId)[0].status).toBe('skipped');
  });

  it('a copy never replaces an existing file', async () => {
    const root = makeTmpTree({ 'a.pdf': 'NEW', 'B/a.pdf': 'EXISTING' });
    const opId = await executePlan(
      db,
      [stepFor(path.join(root, 'a.pdf'), 'copy', path.join(root, 'B', 'a.pdf'))],
      'test'
    );
    expect(fs.readFileSync(path.join(root, 'B', 'a.pdf'), 'utf8')).toBe('EXISTING');
    expect(fs.readFileSync(path.join(root, 'B', 'a (2).pdf'), 'utf8')).toBe('NEW');
    expect(steps(opId)[0].status).toBe('done');
  });

  it('executeCopy itself refuses to overwrite (COPYFILE_EXCL)', () => {
    const root = makeTmpTree({ 'a.pdf': 'NEW', 'b.pdf': 'EXISTING' });
    expect(() => executeCopy(path.join(root, 'a.pdf'), path.join(root, 'b.pdf'))).toThrow(/EEXIST|exists/i);
    expect(fs.readFileSync(path.join(root, 'b.pdf'), 'utf8')).toBe('EXISTING');
  });

  it('a case-only rename of the file itself is not treated as a conflict', async () => {
    if (process.platform !== 'win32' && process.platform !== 'darwin') return; // case-sensitive FS
    const root = makeTmpTree({ 'Report.PDF': 'x' });
    await executePlan(
      db,
      [stepFor(path.join(root, 'Report.PDF'), 'rename', path.join(root, 'report.pdf'))],
      'test'
    );
    expect(listTree(root)).toEqual(['report.pdf']);
  });
});

describe('executePlan: re-validation at execution time', () => {
  it('skips a step whose source disappeared', async () => {
    const root = makeTmpTree({ 'a.pdf': 'x' });
    const src = path.join(root, 'a.pdf');
    const step = stepFor(src, 'move', path.join(root, 'D', 'a.pdf'));
    fs.rmSync(src);
    const opId = await executePlan(db, [step], 'test');
    expect(steps(opId)[0]).toMatchObject({ status: 'skipped', error: expect.stringMatching(/no longer exists/) });
  });

  it('skips a step whose source changed size since planning', async () => {
    const root = makeTmpTree({ 'a.pdf': 'short' });
    const src = path.join(root, 'a.pdf');
    const step = stepFor(src, 'move', path.join(root, 'D', 'a.pdf'));
    fs.writeFileSync(src, 'a much longer replacement');
    const opId = await executePlan(db, [step], 'test');
    expect(steps(opId)[0].status).toBe('skipped');
    expect(fs.existsSync(src)).toBe(true);
  });

  it('skips a step whose source was modified (same size) since planning', async () => {
    const root = makeTmpTree({ 'a.pdf': 'AAAA' });
    const src = path.join(root, 'a.pdf');
    const step = stepFor(src, 'move', path.join(root, 'D', 'a.pdf'));
    fs.writeFileSync(src, 'BBBB');
    fs.utimesSync(src, new Date(), new Date(Date.now() + 60_000));
    const opId = await executePlan(db, [step], 'test');
    expect(steps(opId)[0].status).toBe('skipped');
    expect(fs.readFileSync(src, 'utf8')).toBe('BBBB');
  });

  it('a skipped step does not make the operation look partial', async () => {
    const root = makeTmpTree({ 'a.pdf': 'x', 'b.pdf': 'y' });
    const a = stepFor(path.join(root, 'a.pdf'), 'move', path.join(root, 'D', 'a.pdf'));
    const b = stepFor(path.join(root, 'b.pdf'), 'move', path.join(root, 'D', 'b.pdf'));
    fs.rmSync(path.join(root, 'b.pdf'));
    const opId = await executePlan(db, [a, b], 'test');
    const op = db.prepare('SELECT status, summary FROM operations WHERE id = ?').get(opId);
    expect(op.status).toBe('done');
    expect(op.summary).toBe('1 file moved, 1 skipped');
  });

  it('a failing step is recorded and does not stop the rest of the plan', async () => {
    const root = makeTmpTree({ 'a.pdf': 'x', 'b.pdf': 'y' });
    // Destination "folder" is actually a file, so creating it fails.
    fs.writeFileSync(path.join(root, 'blocker'), 'i am a file');
    const bad = stepFor(path.join(root, 'a.pdf'), 'move', path.join(root, 'blocker', 'a.pdf'));
    const good = stepFor(path.join(root, 'b.pdf'), 'move', path.join(root, 'D', 'b.pdf'));
    const opId = await executePlan(db, [bad, good], 'test');
    expect(steps(opId).map((s: any) => s.status)).toEqual(['failed', 'done']);
    expect(db.prepare('SELECT status FROM operations WHERE id = ?').get(opId).status).toBe('partial');
    expect(fs.existsSync(path.join(root, 'a.pdf'))).toBe(true);
  });
});

describe('cross-device moves (EXDEV)', () => {
  function forceExdev() {
    const realRename = fs.renameSync;
    return vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      // Only simulate the cross-device failure for the file move, not unrelated renames.
      const err: any = new Error('cross-device link not permitted');
      err.code = 'EXDEV';
      void realRename;
      void from;
      void to;
      throw err;
    });
  }

  it('copies, verifies by hash, preserves mtime, and removes the original', async () => {
    const root = makeTmpTree({ 'a.bin': 'payload-123' });
    const src = path.join(root, 'a.bin');
    const dst = path.join(root, 'other', 'a.bin');
    const past = new Date('2020-01-02T03:04:05Z');
    fs.utimesSync(src, past, past);
    forceExdev();

    await executeMove(src, dst);

    expect(fs.existsSync(src)).toBe(false);
    expect(fs.readFileSync(dst, 'utf8')).toBe('payload-123');
    expect(Math.abs(fs.statSync(dst).mtime.getTime() - past.getTime())).toBeLessThan(2000);
  });

  it('a corrupted copy is detected: the bad copy is removed and the original is kept', async () => {
    const root = makeTmpTree({ 'a.bin': 'payload-123' });
    const src = path.join(root, 'a.bin');
    const dst = path.join(root, 'other', 'a.bin');
    forceExdev();
    const realCopy = fs.copyFileSync;
    vi.spyOn(fs, 'copyFileSync').mockImplementation((s, d, flags) => {
      realCopy(s, d, flags);
      fs.writeFileSync(d, 'XXXXXXXXXXX'); // same length, different bytes: a size check would miss it
    });

    await expect(executeMove(src, dst)).rejects.toThrow(/hash mismatch/);

    expect(fs.readFileSync(src, 'utf8')).toBe('payload-123');
    expect(fs.existsSync(dst)).toBe(false);
  });

  it('refuses to overwrite an existing destination on the copy path', async () => {
    const root = makeTmpTree({ 'a.bin': 'NEW', 'other/a.bin': 'EXISTING' });
    forceExdev();
    await expect(
      executeMove(path.join(root, 'a.bin'), path.join(root, 'other', 'a.bin'))
    ).rejects.toThrow();
    expect(fs.readFileSync(path.join(root, 'other', 'a.bin'), 'utf8')).toBe('EXISTING');
    expect(fs.readFileSync(path.join(root, 'a.bin'), 'utf8')).toBe('NEW');
  });
});

describe('recoverPending (interrupted operations)', () => {
  function pendingStep(src: string, dst: string | null, action: string) {
    const opId = journal.createOperation(db, 'crashed');
    const id = journal.createStepPending(db, {
      operationId: opId, seq: 1, ruleId: null, actionType: action,
      srcPath: src, dstPath: dst, fileSize: 1, fileMtime: null, contentHash: null,
    });
    return { opId, id };
  }
  const status = (id: number) => journal.getStepById(db, id);

  it('move finished before the crash -> done', () => {
    const root = makeTmpTree({ 'D/a.pdf': 'x' });
    const { id, opId } = pendingStep(path.join(root, 'a.pdf'), path.join(root, 'D', 'a.pdf'), 'move');
    recoverPending(db);
    expect(status(id).status).toBe('done');
    expect(db.prepare('SELECT status FROM operations WHERE id = ?').get(opId).status).toBe('done');
  });

  it('move never started -> failed, source untouched', () => {
    const root = makeTmpTree({ 'a.pdf': 'x' });
    const { id } = pendingStep(path.join(root, 'a.pdf'), path.join(root, 'D', 'a.pdf'), 'move');
    recoverPending(db);
    expect(status(id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/not completed/) });
    expect(fs.existsSync(path.join(root, 'a.pdf'))).toBe(true);
  });

  it('both source and destination exist -> failed, and NOTHING is deleted', () => {
    const root = makeTmpTree({ 'a.pdf': 'x', 'D/a.pdf': 'x' });
    const { id } = pendingStep(path.join(root, 'a.pdf'), path.join(root, 'D', 'a.pdf'), 'move');
    recoverPending(db);
    expect(status(id).status).toBe('failed');
    expect(listTree(root)).toEqual(['D/a.pdf', 'a.pdf']);
  });

  it('neither exists -> failed with an explicit message', () => {
    const root = makeTmpTree();
    const { id } = pendingStep(path.join(root, 'a.pdf'), path.join(root, 'D', 'a.pdf'), 'move');
    recoverPending(db);
    expect(status(id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/both missing/) });
  });

  it('copy: done only if the copy exists; trash: done only if the source is gone', () => {
    const root = makeTmpTree({ 'a.pdf': 'x', 'B/a.pdf': 'x', 'keep.pdf': 'x' });
    const copyDone = pendingStep(path.join(root, 'a.pdf'), path.join(root, 'B', 'a.pdf'), 'copy');
    const copyNot = pendingStep(path.join(root, 'a.pdf'), path.join(root, 'C', 'a.pdf'), 'copy');
    const trashDone = pendingStep(path.join(root, 'gone.pdf'), null, 'trash');
    const trashNot = pendingStep(path.join(root, 'keep.pdf'), null, 'trash');
    recoverPending(db);
    expect(status(copyDone.id).status).toBe('done');
    expect(status(copyNot.id).status).toBe('failed');
    expect(status(trashDone.id).status).toBe('done');
    expect(status(trashNot.id).status).toBe('failed');
  });

  it('leaves no step pending, and a second run changes nothing', () => {
    const root = makeTmpTree({ 'a.pdf': 'x' });
    pendingStep(path.join(root, 'a.pdf'), path.join(root, 'D', 'a.pdf'), 'move');
    recoverPending(db);
    expect(journal.recoverPendingSteps(db)).toHaveLength(0);
    expect(() => recoverPending(db)).not.toThrow();
  });
});
