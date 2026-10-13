import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { executePlan } from './executor';
import { undoOperation, undoStep } from './undo';
import * as journal from './journal';
import { RecentlyWritten } from './watcher';
import { openTestDb, makeTmpTree, listTree, stepFor } from '../test/helpers';

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

const opStatus = (id: number) => db.prepare('SELECT status FROM operations WHERE id = ?').get(id).status;

describe('undoOperation', () => {
  it('restores moved files to their original locations', async () => {
    const root = makeTmpTree({ 'a.pdf': 'A', 'b.png': 'B' });
    const opId = await executePlan(
      db,
      [
        stepFor(path.join(root, 'a.pdf'), 'move', path.join(root, 'Documents', 'a.pdf')),
        stepFor(path.join(root, 'b.png'), 'move', path.join(root, 'Images', 'b.png')),
      ],
      'test'
    );
    expect(listTree(root)).toEqual(['Documents/a.pdf', 'Images/b.png']);

    const result = await undoOperation(db, opId);

    expect(result).toMatchObject({ success: true, steps_undone: 2, steps_skipped: 0, errors: [] });
    expect(listTree(root)).toEqual(['a.pdf', 'b.png']);
    expect(fs.readFileSync(path.join(root, 'a.pdf'), 'utf8')).toBe('A');
    expect(opStatus(opId)).toBe('undone');
    expect(journal.getOperationSteps(db, opId).map((s: any) => s.status)).toEqual(['undone', 'undone']);
  });

  it('reverses chained steps in reverse order (move then rename)', async () => {
    const root = makeTmpTree({ 'a.pdf': 'A' });
    const src = path.join(root, 'a.pdf');
    const moved = path.join(root, 'D', 'a.pdf');
    const renamed = path.join(root, 'D', 'b.pdf');
    const opId = await executePlan(
      db,
      [stepFor(src, 'move', moved), { ...stepFor(src, 'rename', renamed), src_path: moved }],
      'test'
    );
    await undoOperation(db, opId);
    expect(listTree(root)).toEqual(['a.pdf']);
  });

  it('registers restored files so the watcher will not re-sort them', async () => {
    const root = makeTmpTree({ 'a.pdf': 'A' });
    const src = path.join(root, 'a.pdf');
    const opId = await executePlan(db, [stepFor(src, 'move', path.join(root, 'D', 'a.pdf'))], 'test');

    const tracker = new RecentlyWritten(30_000);
    expect(tracker.contains(src)).toBe(false);
    await undoOperation(db, opId, tracker);
    expect(tracker.contains(src)).toBe(true);
  });

  it('will not overwrite: refuses when the original location is occupied', async () => {
    const root = makeTmpTree({ 'a.pdf': 'ORIGINAL' });
    const src = path.join(root, 'a.pdf');
    const dst = path.join(root, 'D', 'a.pdf');
    const opId = await executePlan(db, [stepFor(src, 'move', dst)], 'test');
    fs.writeFileSync(src, 'SOMETHING NEW'); // user created a new file at the old path

    const result = await undoOperation(db, opId);

    expect(result.success).toBe(false);
    expect(result.errors[0]).toMatch(/occupied/);
    expect(fs.readFileSync(src, 'utf8')).toBe('SOMETHING NEW');
    expect(fs.readFileSync(dst, 'utf8')).toBe('ORIGINAL');
  });

  it('refuses when the moved file was modified since (size mismatch)', async () => {
    const root = makeTmpTree({ 'a.pdf': 'short' });
    const dst = path.join(root, 'D', 'a.pdf');
    const opId = await executePlan(db, [stepFor(path.join(root, 'a.pdf'), 'move', dst)], 'test');
    fs.writeFileSync(dst, 'edited and now much longer');

    const result = await undoOperation(db, opId);
    expect(result.success).toBe(false);
    expect(result.errors[0]).toMatch(/size mismatch/);
    expect(fs.existsSync(dst)).toBe(true);
  });

  it('reports a missing destination instead of throwing', async () => {
    const root = makeTmpTree({ 'a.pdf': 'A' });
    const dst = path.join(root, 'D', 'a.pdf');
    const opId = await executePlan(db, [stepFor(path.join(root, 'a.pdf'), 'move', dst)], 'test');
    fs.rmSync(dst);
    const result = await undoOperation(db, opId);
    expect(result.success).toBe(false);
    expect(result.errors[0]).toMatch(/no longer exists/);
  });

  it('partially undone: undoes what it can and marks the operation accordingly', async () => {
    const root = makeTmpTree({ 'a.pdf': 'A', 'b.pdf': 'B' });
    const opId = await executePlan(
      db,
      [
        stepFor(path.join(root, 'a.pdf'), 'move', path.join(root, 'D', 'a.pdf')),
        stepFor(path.join(root, 'b.pdf'), 'move', path.join(root, 'D', 'b.pdf')),
      ],
      'test'
    );
    fs.rmSync(path.join(root, 'D', 'b.pdf'));

    const result = await undoOperation(db, opId);

    expect(result).toMatchObject({ success: false, steps_undone: 1, steps_skipped: 1 });
    expect(opStatus(opId)).toBe('partially_undone');
    expect(fs.existsSync(path.join(root, 'a.pdf'))).toBe(true);
  });

  it('undoing a copy trashes the copy and keeps the original', async () => {
    const root = makeTmpTree({ 'a.pdf': 'A' });
    const copy = path.join(root, 'Backup', 'a.pdf');
    const opId = await executePlan(db, [stepFor(path.join(root, 'a.pdf'), 'copy', copy)], 'test');
    await undoOperation(db, opId);
    expect(trashed).toEqual([copy]);
    expect(listTree(root)).toEqual(['a.pdf']);
  });

  it('cannot undo a trash step, and says how to recover the file', async () => {
    const root = makeTmpTree({ 'a.pdf': 'A' });
    const opId = await executePlan(db, [stepFor(path.join(root, 'a.pdf'), 'trash', null)], 'test');
    const result = await undoOperation(db, opId);
    expect(result.success).toBe(false);
    expect(result.errors[0]).toMatch(/Recycle Bin|Trash/);
  });

  it('only undoes completed steps, and cannot be undone twice', async () => {
    const root = makeTmpTree({ 'a.pdf': 'A' });
    const opId = await executePlan(db, [stepFor(path.join(root, 'a.pdf'), 'move', path.join(root, 'D', 'a.pdf'))], 'test');
    expect((await undoOperation(db, opId)).success).toBe(true);
    const again = await undoOperation(db, opId);
    expect(again).toMatchObject({ success: false, errors: ['No completed steps to undo'] });
  });
});

describe('undoStep', () => {
  it('undoes one step by id', async () => {
    const root = makeTmpTree({ 'a.pdf': 'A', 'b.pdf': 'B' });
    const opId = await executePlan(
      db,
      [
        stepFor(path.join(root, 'a.pdf'), 'move', path.join(root, 'D', 'a.pdf')),
        stepFor(path.join(root, 'b.pdf'), 'move', path.join(root, 'D', 'b.pdf')),
      ],
      'test'
    );
    const [first] = journal.getOperationSteps(db, opId);
    const result = await undoStep(db, first.id);
    expect(result).toMatchObject({ success: true, steps_undone: 1 });
    expect(listTree(root)).toEqual(['D/b.pdf', 'a.pdf']);
  });

  it('rejects unknown steps and steps that are not "done"', async () => {
    expect((await undoStep(db, 9999)).errors[0]).toMatch(/not found/);

    const root = makeTmpTree({ 'a.pdf': 'A' });
    const opId = await executePlan(db, [stepFor(path.join(root, 'a.pdf'), 'move', path.join(root, 'D', 'a.pdf'))], 'test');
    const [step] = journal.getOperationSteps(db, opId);
    await undoStep(db, step.id);
    expect((await undoStep(db, step.id)).errors[0]).toMatch(/not in 'done' status/);
  });
});
