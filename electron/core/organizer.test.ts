import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  previewFolder,
  applyPlan,
  getUnsortedFiles,
  walkFolder,
  PlanCache,
} from './organizer';
import { undoOperation } from './undo';
import { compileIgnore } from './ignore';
import { managedDirs } from './planner';
import { loadRules } from './rules-repo';
import { openTestDb, makeTmpTree, addFolder, listTree } from '../test/helpers';

vi.mock('trash', () => ({
  default: vi.fn(async (paths: string[]) => {
    for (const p of paths) fs.rmSync(p, { force: true });
  }),
}));

let db: any;
let cache: PlanCache;
beforeEach(() => {
  db = openTestDb();
  cache = new PlanCache();
});
afterEach(() => db.close());

const stepsOf = (plan: any) => plan.steps.filter((s: any) => s.action_type !== 'skip');

describe('preview + apply', () => {
  it('applies exactly the previewed plan', async () => {
    const root = makeTmpTree({ 'a.pdf': 'A', 'b.png': 'B', 'c.mp3': 'C', 'mystery.qqq': 'Q' });
    const folder = addFolder(db, root);

    const plan = await previewFolder(db, folder, cache);
    expect(plan.move_count).toBe(3);
    expect(plan.no_match_count).toBe(1);
    expect(plan.plan_id).toBeTruthy();
    // Nothing moves during a preview.
    expect(listTree(root)).toEqual(['a.pdf', 'b.png', 'c.mp3', 'mystery.qqq']);

    const outcome = await applyPlan(db, folder, plan.plan_id, null, cache, null);
    expect(outcome.steps_attempted).toBe(3);
    expect(outcome.operation.status).toBe('done');
    expect(listTree(root)).toEqual(['Audio/c.mp3', 'Documents/a.pdf', 'Images/b.png', 'mystery.qqq']);
  });

  it('only runs the files the user left selected', async () => {
    const root = makeTmpTree({ 'a.pdf': 'A', 'b.png': 'B' });
    const folder = addFolder(db, root);
    const plan = await previewFolder(db, folder, cache);

    const keep = plan.steps.find((s: any) => s.src_path.endsWith('a.pdf'))!.file_key;
    await applyPlan(db, folder, plan.plan_id, [keep], cache, null);

    expect(listTree(root)).toEqual(['Documents/a.pdf', 'b.png']);
  });

  it('applying with nothing selected does nothing', async () => {
    const root = makeTmpTree({ 'a.pdf': 'A' });
    const folder = addFolder(db, root);
    const plan = await previewFolder(db, folder, cache);
    const outcome = await applyPlan(db, folder, plan.plan_id, [], cache, null);
    expect(outcome).toMatchObject({ operation: null, steps_attempted: 0 });
    expect(listTree(root)).toEqual(['a.pdf']);
  });

  it('a plan is single-use', async () => {
    const root = makeTmpTree({ 'a.pdf': 'A' });
    const folder = addFolder(db, root);
    const plan = await previewFolder(db, folder, cache);
    await applyPlan(db, folder, plan.plan_id, null, cache, null);
    await expect(applyPlan(db, folder, plan.plan_id, null, cache, null)).rejects.toThrow(/expired/);
  });

  it('rejects unknown, expired and wrong-folder plan ids', async () => {
    const root = makeTmpTree({ 'a.pdf': 'A' });
    const other = makeTmpTree({ 'b.pdf': 'B' });
    const folder = addFolder(db, root);
    const otherFolder = addFolder(db, other);

    await expect(applyPlan(db, folder, 'not-a-plan', null, cache, null)).rejects.toThrow(/expired/);

    const plan = await previewFolder(db, folder, cache);
    await expect(applyPlan(db, otherFolder, plan.plan_id, null, cache, null)).rejects.toThrow(/different folder/);

    const shortLived = new PlanCache(-1);
    const stale = await previewFolder(db, folder, shortLived);
    await expect(applyPlan(db, folder, stale.plan_id, null, shortLived, null)).rejects.toThrow(/expired/);
    expect(listTree(root)).toEqual(['a.pdf']);
  });

  it('a file that changed after the preview is skipped, not moved', async () => {
    const root = makeTmpTree({ 'a.pdf': 'short', 'b.pdf': 'untouched' });
    const folder = addFolder(db, root);
    const plan = await previewFolder(db, folder, cache);

    fs.writeFileSync(path.join(root, 'a.pdf'), 'edited after the preview was made');

    const outcome = await applyPlan(db, folder, plan.plan_id, null, cache, null);
    expect(listTree(root)).toEqual(['Documents/b.pdf', 'a.pdf']);
    expect(outcome.operation.summary).toBe('1 file moved, 1 skipped');
  });

  it('files with the same name from different folders get unique destinations', async () => {
    const root = makeTmpTree({ 'one/a.pdf': '1', 'two/a.pdf': '2' });
    const folder = addFolder(db, root, true);
    const plan = await previewFolder(db, folder, cache);
    await applyPlan(db, folder, plan.plan_id, null, cache, null);
    expect(listTree(root)).toEqual(['Documents/a (2).pdf', 'Documents/a.pdf']);
  });

  it('skip policy: the preview shows a greyed-out skip row and apply leaves the file', async () => {
    const root = makeTmpTree({ 'a.pdf': 'NEW', 'Documents/a.pdf': 'OLD' });
    db.prepare("UPDATE settings SET value = 'skip' WHERE key = 'conflict_default'").run();
    const folder = addFolder(db, root);

    const plan = await previewFolder(db, folder, cache);
    expect(plan.skip_count).toBe(1);
    expect(plan.steps[0]).toMatchObject({ action_type: 'skip', selected: false });

    const outcome = await applyPlan(db, folder, plan.plan_id, null, cache, null);
    expect(outcome.steps_attempted).toBe(0);
    expect(fs.readFileSync(path.join(root, 'a.pdf'), 'utf8')).toBe('NEW');
    expect(fs.readFileSync(path.join(root, 'Documents', 'a.pdf'), 'utf8')).toBe('OLD');
  });
});

describe('repeated and recursive scans are idempotent (no nesting, no repeat moves)', () => {
  it('recursive: preview + apply, then again, then once more — never Documents/Documents', async () => {
    const root = makeTmpTree({
      'a.pdf': 'A',
      'sub/b.pdf': 'B',
      'sub/deeper/c.png': 'C',
      'Documents/already.pdf': 'D',
    });
    const folder = addFolder(db, root, true);

    const first = await previewFolder(db, folder, cache);
    await applyPlan(db, folder, first.plan_id, null, cache, null);
    const afterFirst = listTree(root);
    expect(afterFirst).toEqual([
      'Documents/a.pdf',
      'Documents/already.pdf',
      'Documents/b.pdf',
      'Images/c.png',
    ]);

    for (let i = 0; i < 2; i++) {
      const again = await previewFolder(db, folder, cache);
      expect(stepsOf(again)).toEqual([]);
      expect(again.no_match_count).toBe(0);
      await applyPlan(db, folder, again.plan_id, null, cache, null);
      expect(listTree(root)).toEqual(afterFirst);
    }
    expect(fs.existsSync(path.join(root, 'Documents', 'Documents'))).toBe(false);
  });

  it('non-recursive folders never look inside subfolders', async () => {
    const root = makeTmpTree({ 'a.pdf': 'A', 'sub/b.pdf': 'B' });
    const folder = addFolder(db, root, false);
    const plan = await previewFolder(db, folder, cache);
    await applyPlan(db, folder, plan.plan_id, null, cache, null);
    expect(listTree(root)).toEqual(['Documents/a.pdf', 'sub/b.pdf']);
  });

  it('a nested destination template ({root}/Documents/{year}) is also left alone once sorted', async () => {
    db.prepare("UPDATE rule_actions SET params = ? WHERE rule_id = (SELECT id FROM rules WHERE name = 'Sort Documents')")
      .run(JSON.stringify({ destination: '{root}/Documents/{year}', on_conflict: 'auto_rename' }));
    const root = makeTmpTree({ 'a.pdf': 'A' });
    const folder = addFolder(db, root, true);

    const first = await previewFolder(db, folder, cache);
    await applyPlan(db, folder, first.plan_id, null, cache, null);
    const sorted = listTree(root);
    expect(sorted).toHaveLength(1);
    expect(sorted[0]).toMatch(/^Documents\/\d{4}\/a\.pdf$/);

    const again = await previewFolder(db, folder, cache);
    expect(stepsOf(again)).toEqual([]);
  });

  it('undo then re-scan puts the file back exactly once', async () => {
    const root = makeTmpTree({ 'a.pdf': 'A' });
    const folder = addFolder(db, root, true);
    const plan = await previewFolder(db, folder, cache);
    const { operation } = await applyPlan(db, folder, plan.plan_id, null, cache, null);

    await undoOperation(db, operation.id);
    expect(listTree(root)).toEqual(['a.pdf']);

    const again = await previewFolder(db, folder, cache);
    await applyPlan(db, folder, again.plan_id, null, cache, null);
    expect(listTree(root)).toEqual(['Documents/a.pdf']);
  });
});

describe('walkFolder', () => {
  function walk(root: string, recursive: boolean) {
    const rules = loadRules(db);
    return walkFolder(
      { id: 1, path: root, recursive },
      { isIgnored: compileIgnore(['*.skipme']), managed: managedDirs(rules, root) }
    ).map((p) => path.relative(root, p).replace(/\\/g, '/')).sort();
  }

  it('skips hidden files, temp downloads, junk folders, managed folders and ignore patterns', () => {
    const root = makeTmpTree({
      'keep.pdf': 'x',
      '.hidden.pdf': 'x',
      'dl.crdownload': 'x',
      'Thumbs.db': 'x',
      'x.skipme': 'x',
      'node_modules/pkg/index.js': 'x',
      '.git/config': 'x',
      'Documents/sorted.pdf': 'x',
      'sub/inner.pdf': 'x',
    });
    expect(walk(root, true)).toEqual(['keep.pdf', 'sub/inner.pdf']);
    expect(walk(root, false)).toEqual(['keep.pdf']);
  });

  it('does not follow symlinked directories', function () {
    const root = makeTmpTree({ 'real/inner.pdf': 'x' });
    const outside = makeTmpTree({ 'secret.pdf': 'x' });
    try {
      fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
    } catch {
      return; // symlinks not permitted in this environment
    }
    expect(walk(root, true)).toEqual(['real/inner.pdf']);
  });

  it('survives an unreadable or missing folder', () => {
    expect(walk(path.join(makeTmpTree(), 'does-not-exist'), true)).toEqual([]);
  });
});

describe('getUnsortedFiles', () => {
  it('lists files no rule matches, with the fields the UI reads', async () => {
    const root = makeTmpTree({ 'a.pdf': 'A', 'mystery.qqq': 'abc' });
    const folder = addFolder(db, root);
    const unsorted = await getUnsortedFiles(db, folder);
    expect(unsorted).toHaveLength(1);
    expect(unsorted[0]).toMatchObject({
      path: path.join(root, 'mystery.qqq'),
      name: 'mystery',
      extension: 'qqq',
      size: 3,
      kind: 'other',
    });
    expect(new Date(unsorted[0].modified_at).getTime()).not.toBeNaN();
  });
});
