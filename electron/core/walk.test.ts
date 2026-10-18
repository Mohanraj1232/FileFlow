import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { walkFiles, type WalkOptions } from './walk';
import { protectAppDataDir } from './paths';
import { makeTmpTree, trySymlink } from '../test/helpers';

async function collect(over: Partial<WalkOptions> & { roots: string[] }) {
  const errors: { path: string; error: unknown }[] = [];
  const dirs: string[] = [];
  const files: string[] = [];
  for await (const e of walkFiles({
    includeHidden: false,
    onError: (p, err) => errors.push({ path: p, error: err }),
    onDirectory: (d) => dirs.push(d),
    ...over,
  })) {
    files.push(path.relative(over.roots[0], e.path).replace(/\\/g, '/'));
  }
  return { files: files.sort(), errors, dirs };
}

describe('walkFiles', () => {
  it('yields every regular file under the roots, recursively, with its folder and root', async () => {
    const root = makeTmpTree({ 'a.txt': 'a', 'sub/b.txt': 'b', 'sub/deeper/c.txt': 'c' });
    const seen: { dir: string; root: string; size: bigint }[] = [];
    for await (const e of walkFiles({ roots: [root], includeHidden: false, onError: () => {} })) {
      seen.push({ dir: e.dir, root: e.root, size: e.stats.size });
    }
    expect(seen).toHaveLength(3);
    expect(seen.every((s) => s.root === root && s.size === 1n)).toBe(true);
    expect(seen.map((s) => path.relative(root, s.dir).replace(/\\/g, '/')).sort()).toEqual(['', 'sub', 'sub/deeper']);
  });

  it('skips hidden files and folders unless asked', async () => {
    const root = makeTmpTree({ 'v.txt': '1', '.h.txt': '2', '.cfg/inner.txt': '3' });
    expect((await collect({ roots: [root] })).files).toEqual(['v.txt']);
    expect((await collect({ roots: [root], includeHidden: true })).files).toEqual(['.cfg/inner.txt', '.h.txt', 'v.txt']);
  });

  it('honours skipDirNames, skipFile and ignore patterns', async () => {
    const root = makeTmpTree({ 'keep.txt': '1', 'node_modules/x.js': '2', 'a.tmp': '3', 'logs/old.log': '4' });
    const { files } = await collect({
      roots: [root],
      skipDirNames: new Set(['node_modules']),
      skipFile: (name) => name.endsWith('.tmp'),
      isIgnored: (p) => p.endsWith('.log'),
    });
    expect(files).toEqual(['keep.txt']);
  });

  it('does not enter protected folders', async () => {
    const root = makeTmpTree({ 'ok.txt': '1', 'guarded-walk/inner.txt': '2' });
    protectAppDataDir(path.join(root, 'guarded-walk'));
    expect((await collect({ roots: [root] })).files).toEqual(['ok.txt']);
  });

  it('never follows a junction or symlinked folder (the Windows CI regression)', async (ctx) => {
    const outside = makeTmpTree({ 'secret.txt': 's', 'deep/more.txt': 'm' });
    const root = makeTmpTree({ 'mine.txt': 'x' });
    if (!trySymlink(outside, path.join(root, 'link'), 'junction')) ctx.skip();
    expect((await collect({ roots: [root] })).files).toEqual(['mine.txt']);
  });

  it('never yields a symlinked file', async (ctx) => {
    const outside = makeTmpTree({ 'secret.txt': 's' });
    const root = makeTmpTree({ 'mine.txt': 'x' });
    if (!trySymlink(path.join(outside, 'secret.txt'), path.join(root, 'file-link.txt'), 'file')) ctx.skip();
    expect((await collect({ roots: [root] })).files).toEqual(['mine.txt']);
  });

  it('yields a file once when roots overlap', async () => {
    const root = makeTmpTree({ 'a.txt': '1', 'sub/b.txt': '2' });
    const { files } = await collect({ roots: [root, path.join(root, 'sub'), root] });
    expect(files).toEqual(['a.txt', 'sub/b.txt']);
  });

  it('reports an unreadable root and carries on', async () => {
    const root = makeTmpTree({ 'a.txt': '1' });
    const { files, errors } = await collect({ roots: [root, path.join(root, 'nope')] });
    expect(files).toEqual(['a.txt']);
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toContain('nope');
  });

  it('reports every folder it enters, including each root', async () => {
    const root = makeTmpTree({ 'a/x.txt': '1', 'b/': '' });
    const { dirs } = await collect({ roots: [root] });
    expect(dirs.map((d) => path.relative(root, d).replace(/\\/g, '/')).sort()).toEqual(['', 'a', 'b']);
  });

  it('stops promptly when aborted', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 100; i++) files[`f${i}.txt`] = 'x';
    const root = makeTmpTree(files);
    const controller = new AbortController();
    let count = 0;
    for await (const _ of walkFiles({ roots: [root], includeHidden: false, signal: controller.signal, onError: () => {} })) {
      void _;
      if (++count === 5) controller.abort();
    }
    expect(count).toBeLessThan(100);
  });

  it('a root that is itself reached through a link is still walked', async (ctx) => {
    const real = makeTmpTree({ 'a.txt': '1' });
    const holder = makeTmpTree();
    const link = path.join(holder, 'via');
    if (!trySymlink(real, link, 'junction')) ctx.skip();
    expect((await collect({ roots: [link] })).files).toEqual(['a.txt']);
  });

  it('reads files as plain data: size is exact for a known file', async () => {
    const root = makeTmpTree({ 'five.bin': Buffer.alloc(5) });
    for await (const e of walkFiles({ roots: [root], includeHidden: false, onError: () => {} })) {
      expect(Number(e.stats.size)).toBe(5);
      expect(fs.statSync(e.path).size).toBe(5);
    }
  });
});
