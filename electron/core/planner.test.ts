import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  plan,
  buildSummary,
  resolveConflict,
  expandVariables,
  expandRenamePattern,
  cleanFilename,
  slugify,
  normalizePolicy,
  managedDirs,
  isInManagedDir,
  pathKey,
} from './planner';
import { getFileMeta } from './models';
import { makeTmpTree } from '../test/helpers';

const rule = { id: 1, name: 'Test' };
const move = (destination: string, extra: Record<string, unknown> = {}) => ({
  action_type: 'move',
  params: { destination, ...extra },
});

describe('template expansion', () => {
  it('{root} expands to the watched root, not the file\'s own folder', () => {
    const root = makeTmpTree({ 'Documents/a.pdf': 'x' });
    const file = path.join(root, 'Documents', 'a.pdf');
    const meta = getFileMeta(file, root);
    expect(expandVariables('{root}/Documents', meta)).toBe(`${root}/Documents`);
  });

  it('expands kind, ext, name and date parts from the file', () => {
    const root = makeTmpTree({ 'Notes.TXT': 'x' });
    const meta = getFileMeta(path.join(root, 'Notes.TXT'), root);
    meta.mtime = new Date(2025, 2, 9, 12); // 9 March 2025, local time
    expect(expandVariables('{kind}/{ext}/{name}/{year}/{month}', meta)).toBe('document/txt/Notes/2025/03');
    expect(expandVariables('{date}|{date:YYYY-MM}|{date:YYYY}', meta)).toBe('2025-03-09|2025-03|2025');
  });

  it('rename variables and transforms', () => {
    const root = makeTmpTree({ 'My Report (1) - Copy.pdf': 'x' });
    const meta = getFileMeta(path.join(root, 'My Report (1) - Copy.pdf'), root);
    expect(expandRenamePattern('{name:lower}.{ext}', meta)).toBe('my report (1) - copy.pdf');
    expect(expandRenamePattern('{name:slug}.{ext}', meta)).toBe('my-report-1-copy.pdf');
    expect(cleanFilename('Budget (2)')).toBe('Budget');
    expect(cleanFilename('Thesis_final')).toBe('Thesis');
    expect(cleanFilename('Photo - Copy')).toBe('Photo');
    expect(slugify('  Hello, World!  ')).toBe('hello-world');
  });
});

describe('normalizePolicy', () => {
  it('maps stored values onto implemented policies', () => {
    expect(normalizePolicy('skip')).toBe('skip');
    expect(normalizePolicy('replace_if_identical')).toBe('replace_if_identical');
    expect(normalizePolicy('replace_if_duplicate')).toBe('replace_if_identical');
    expect(normalizePolicy('auto_rename')).toBe('auto_rename');
    expect(normalizePolicy('ask')).toBe('auto_rename');
    expect(normalizePolicy(undefined)).toBe('auto_rename');
    expect(normalizePolicy('garbage')).toBe('auto_rename');
  });
});

describe('resolveConflict', () => {
  it('returns the path unchanged when nothing is there', async () => {
    const root = makeTmpTree();
    const r = await resolveConflict(path.join(root, 'a.txt'), new Set(), 'auto_rename');
    expect(r).toEqual({ path: path.join(root, 'a.txt'), outcome: 'free' });
  });

  it('auto_rename picks a unique "(N)" name against disk and against the batch', async () => {
    const root = makeTmpTree({ 'a.txt': 'x', 'a (2).txt': 'y' });
    const claimed = new Set([pathKey(path.join(root, 'a (3).txt'))]);
    const r = await resolveConflict(path.join(root, 'a.txt'), claimed, 'auto_rename');
    expect(r.outcome).toBe('renamed');
    expect(r.path).toBe(path.join(root, 'a (4).txt'));
  });

  it('skip reports a conflict instead of choosing a name', async () => {
    const root = makeTmpTree({ 'a.txt': 'x' });
    const r = await resolveConflict(path.join(root, 'a.txt'), new Set(), 'skip');
    expect(r.outcome).toBe('skipped');
  });

  it('replace_if_identical recognises byte-identical content', async () => {
    const root = makeTmpTree({ 'dest/a.txt': 'same bytes', 'src/a.txt': 'same bytes' });
    const r = await resolveConflict(
      path.join(root, 'dest', 'a.txt'),
      new Set(),
      'replace_if_identical',
      path.join(root, 'src', 'a.txt')
    );
    expect(r.outcome).toBe('identical');
  });

  it('replace_if_identical NEVER replaces different content — it keeps both', async () => {
    const root = makeTmpTree({ 'dest/a.txt': 'old content', 'src/a.txt': 'new content' });
    const r = await resolveConflict(
      path.join(root, 'dest', 'a.txt'),
      new Set(),
      'replace_if_identical',
      path.join(root, 'src', 'a.txt')
    );
    expect(r.outcome).toBe('renamed');
    expect(r.path).toBe(path.join(root, 'dest', 'a (2).txt'));
  });

  it('same size but different content is not identical', async () => {
    const root = makeTmpTree({ 'dest/a.bin': 'AAAA', 'src/a.bin': 'AAAB' });
    const r = await resolveConflict(
      path.join(root, 'dest', 'a.bin'),
      new Set(),
      'replace_if_identical',
      path.join(root, 'src', 'a.bin')
    );
    expect(r.outcome).toBe('renamed');
  });
});

describe('plan()', () => {
  it('plans a move into the expanded destination', async () => {
    const root = makeTmpTree({ 'a.pdf': 'x' });
    const meta = getFileMeta(path.join(root, 'a.pdf'), root);
    const steps = await plan(meta, rule, [move('{root}/Documents')], new Set());
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      action_type: 'move',
      src_path: path.join(root, 'a.pdf'),
      dst_path: path.join(root, 'Documents', 'a.pdf'),
      selected: true,
    });
  });

  it('is idempotent: a file already in its destination yields no steps (no Documents/Documents)', async () => {
    const root = makeTmpTree({ 'Documents/a.pdf': 'x' });
    const meta = getFileMeta(path.join(root, 'Documents', 'a.pdf'), root);
    expect(await plan(meta, rule, [move('{root}/Documents')], new Set())).toEqual([]);
  });

  it('two files with one name in the same batch get different destinations', async () => {
    const root = makeTmpTree({ 'one/a.pdf': '1', 'two/a.pdf': '2' });
    const claimed = new Set<string>();
    const s1 = await plan(getFileMeta(path.join(root, 'one', 'a.pdf'), root), rule, [move('{root}/D')], claimed);
    const s2 = await plan(getFileMeta(path.join(root, 'two', 'a.pdf'), root), rule, [move('{root}/D')], claimed);
    expect(s1[0].dst_path).toBe(path.join(root, 'D', 'a.pdf'));
    expect(s2[0].dst_path).toBe(path.join(root, 'D', 'a (2).pdf'));
  });

  it('skip policy produces an unselected "skip" step and no move', async () => {
    const root = makeTmpTree({ 'a.pdf': 'new', 'Documents/a.pdf': 'old' });
    const meta = getFileMeta(path.join(root, 'a.pdf'), root);
    const steps = await plan(meta, rule, [move('{root}/Documents')], new Set(), 'skip');
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ action_type: 'skip', selected: false });
    expect(steps[0].note).toMatch(/skip/i);
  });

  it('a per-action on_conflict overrides the global default', async () => {
    const root = makeTmpTree({ 'a.pdf': 'new', 'Documents/a.pdf': 'old' });
    const meta = getFileMeta(path.join(root, 'a.pdf'), root);
    const steps = await plan(meta, rule, [move('{root}/Documents', { on_conflict: 'skip' })], new Set(), 'auto_rename');
    expect(steps[0].action_type).toBe('skip');
  });

  it('replace_if_identical turns an identical-content move into a trash of the redundant source', async () => {
    const root = makeTmpTree({ 'a.pdf': 'dup', 'Documents/a.pdf': 'dup' });
    const meta = getFileMeta(path.join(root, 'a.pdf'), root);
    const steps = await plan(meta, rule, [move('{root}/Documents')], new Set(), 'replace_if_identical');
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      action_type: 'trash',
      src_path: path.join(root, 'a.pdf'),
      dst_path: path.join(root, 'Documents', 'a.pdf'),
    });
  });

  it('chains move then rename on the moved path', async () => {
    const root = makeTmpTree({ 'My Doc (1).pdf': 'x' });
    const meta = getFileMeta(path.join(root, 'My Doc (1).pdf'), root);
    const steps = await plan(
      meta,
      rule,
      [move('{root}/Docs'), { action_type: 'rename', params: { pattern: '{name:clean}.{ext}' } }],
      new Set()
    );
    expect(steps.map((s) => s.action_type)).toEqual(['move', 'rename']);
    expect(steps[1].src_path).toBe(path.join(root, 'Docs', 'My Doc (1).pdf'));
    expect(steps[1].dst_path).toBe(path.join(root, 'Docs', 'My Doc.pdf'));
  });

  it('a copy leaves the original path for later actions', async () => {
    const root = makeTmpTree({ 'a.pdf': 'x' });
    const meta = getFileMeta(path.join(root, 'a.pdf'), root);
    const steps = await plan(meta, rule, [{ action_type: 'copy', params: { destination: '{root}/Backup' } }, move('{root}/Main')], new Set());
    expect(steps.map((s) => [s.action_type, s.src_path])).toEqual([
      ['copy', path.join(root, 'a.pdf')],
      ['move', path.join(root, 'a.pdf')],
    ]);
  });

  it('ignores a move/copy action that has no destination instead of crashing', async () => {
    const root = makeTmpTree({ 'a.pdf': 'x' });
    const meta = getFileMeta(path.join(root, 'a.pdf'), root);
    expect(await plan(meta, rule, [{ action_type: 'move', params: {} }], new Set())).toEqual([]);
  });

  it('a no-op rename (pattern equals the current name) plans nothing', async () => {
    const root = makeTmpTree({ 'a.pdf': 'x' });
    const meta = getFileMeta(path.join(root, 'a.pdf'), root);
    expect(await plan(meta, rule, [{ action_type: 'rename', params: { pattern: '{name}.{ext}' } }], new Set())).toEqual([]);
  });

  it('rename into an occupied name renames to a free one instead of overwriting', async () => {
    const root = makeTmpTree({ 'a.pdf': 'x', 'b.pdf': 'taken' });
    const meta = getFileMeta(path.join(root, 'a.pdf'), root);
    const steps = await plan(meta, rule, [{ action_type: 'rename', params: { pattern: 'b.{ext}' } }], new Set());
    expect(steps[0].dst_path).toBe(path.join(root, 'b (2).pdf'));
  });

  it('plans a trash step', async () => {
    const root = makeTmpTree({ 'a.tmpx': 'x' });
    const meta = getFileMeta(path.join(root, 'a.tmpx'), root);
    const steps = await plan(meta, rule, [{ action_type: 'trash', params: {} }], new Set());
    expect(steps[0]).toMatchObject({ action_type: 'trash', dst_path: null });
  });

  it('planning never touches the filesystem', async () => {
    const root = makeTmpTree({ 'a.pdf': 'x' });
    const meta = getFileMeta(path.join(root, 'a.pdf'), root);
    await plan(meta, rule, [move('{root}/Documents')], new Set());
    expect(fs.existsSync(path.join(root, 'Documents'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'a.pdf'))).toBe(true);
  });
});

describe('buildSummary', () => {
  it('counts each action type, skips and unmatched files', () => {
    const base = { rule_id: 1, rule_name: 'r', src_path: 's', dst_path: 'd', file_size: 1, file_mtime: 't', selected: true };
    const summary = buildSummary(
      [
        { ...base, action_type: 'move' },
        { ...base, action_type: 'move' },
        { ...base, action_type: 'copy' },
        { ...base, action_type: 'trash' },
        { ...base, action_type: 'skip', selected: false },
      ],
      3
    );
    expect(summary).toMatchObject({ move_count: 2, copy_count: 1, rename_count: 0, trash_count: 1, skip_count: 1, no_match_count: 3 });
  });
});

describe('managed destination folders', () => {
  const rules = (destination: string) => [
    { enabled: 1, actions: [{ action_type: 'move', params: { destination } }] },
  ];

  it('finds the folders FileFlow fills inside the watched root', () => {
    const root = path.resolve('/watched');
    const dirs = managedDirs(
      [...rules('{root}/Documents/{year}'), ...rules('{root}/Images')],
      root
    );
    expect(dirs.map(pathKey).sort()).toEqual([pathKey(path.join(root, 'Documents')), pathKey(path.join(root, 'Images'))]);
  });

  it('ignores destinations outside the root, the root itself, disabled rules and non-moves', () => {
    const root = path.resolve('/watched');
    const elsewhere = path.resolve('/elsewhere/Docs');
    expect(managedDirs(rules(elsewhere), root)).toEqual([]);
    expect(managedDirs(rules('{root}/{kind}'), root)).toEqual([]);
    expect(managedDirs([{ enabled: 0, actions: [{ action_type: 'move', params: { destination: '{root}/X' } }] }], root)).toEqual([]);
    expect(managedDirs([{ enabled: 1, actions: [{ action_type: 'rename', params: { pattern: 'x' } }] }], root)).toEqual([]);
  });

  it('isInManagedDir matches files beneath a managed folder only', () => {
    const root = path.resolve('/watched');
    const dirs = [path.join(root, 'Documents')];
    expect(isInManagedDir(path.join(root, 'Documents', 'a.pdf'), dirs)).toBe(true);
    expect(isInManagedDir(path.join(root, 'Documents', '2025', 'a.pdf'), dirs)).toBe(true);
    expect(isInManagedDir(path.join(root, 'Documents2', 'a.pdf'), dirs)).toBe(false);
    expect(isInManagedDir(path.join(root, 'a.pdf'), dirs)).toBe(false);
  });
});
