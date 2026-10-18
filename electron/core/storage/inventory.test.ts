import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { scanInventory, type InvFile, type InvProgress } from './inventory';
import { compileIgnore } from '../ignore';
import { makeTmpTree, tryHardLink } from '../../test/helpers';

async function run(roots: string[], over: Record<string, unknown> = {}) {
  const files: InvFile[] = [];
  const errors: { path: string; error: string }[] = [];
  const batches: number[] = [];
  const result = await scanInventory({
    roots,
    onBatch: (b) => {
      batches.push(b.length);
      files.push(...b);
    },
    onError: (e) => errors.push(e),
    ...over,
  });
  return { result, files, errors, batches };
}

const rel = (f: InvFile, root: string) => path.relative(root, f.path).replace(/\\/g, '/');

describe('scanInventory', () => {
  it('records each file\'s metadata from the filesystem', async () => {
    const root = makeTmpTree({ 'Report.PDF': 'x'.repeat(1234), 'sub/clip.mp4': 'y'.repeat(10) });
    const past = new Date('2022-03-04T05:06:07Z');
    fs.utimesSync(path.join(root, 'Report.PDF'), past, past);

    const { files, result } = await run([root]);
    const pdf = files.find((f) => f.name === 'Report.PDF')!;
    expect(pdf).toMatchObject({ ext: 'pdf', kind: 'document', size: 1234, storedSize: 1234, links: 1, root, dir: root });
    expect(Math.abs(pdf.mtimeMs - past.getTime())).toBeLessThan(2000);
    expect(files.find((f) => f.name === 'clip.mp4')).toMatchObject({ kind: 'video', ext: 'mp4', dir: path.join(root, 'sub') });
    expect(result).toMatchObject({ filesScanned: 2, logicalBytes: 1244, storedBytes: 1244, cancelled: false, errorCount: 0 });
    expect(result.dirsScanned).toBe(2);
  });

  it('classifies files with and without extensions', async () => {
    const root = makeTmpTree({ 'a.ZIP': '1', 'Makefile': '2', 'x.tar.gz': '3', 'main.ts': '4' });
    const { files } = await run([root]);
    const kind = (n: string) => files.find((f) => f.name === n)!.kind;
    expect(kind('a.ZIP')).toBe('archive');
    expect(kind('Makefile')).toBe('other');
    expect(kind('x.tar.gz')).toBe('archive');
    expect(kind('main.ts')).toBe('code'); // not video
  });

  it('includes hidden files and dependency folders: they are real disk usage', async () => {
    const root = makeTmpTree({ '.git/objects/pack': 'g'.repeat(100), 'node_modules/pkg/i.js': 'n'.repeat(50), 'v.txt': 'v' });
    const { files, result } = await run([root]);
    expect(files.map((f) => rel(f, root)).sort()).toEqual(['.git/objects/pack', 'node_modules/pkg/i.js', 'v.txt']);
    expect(result.storedBytes).toBe(151);
  });

  it('can leave hidden files out, and applies ignore patterns', async () => {
    const root = makeTmpTree({ '.h': '1', 'a.log': '2', 'b.txt': '3' });
    const { files } = await run([root], { includeHidden: false, isIgnored: compileIgnore(['*.log']) });
    expect(files.map((f) => f.name)).toEqual(['b.txt']);
  });

  it('counts shared (hard-linked) data once in disk usage, but still lists every link', async (ctx) => {
    const root = makeTmpTree({ 'orig.bin': 'z'.repeat(1000), 'other.bin': 'q'.repeat(500) });
    if (!tryHardLink(path.join(root, 'orig.bin'), path.join(root, 'link.bin'))) ctx.skip();

    const { files, result } = await run([root]);
    expect(files).toHaveLength(3);
    const linked = files.filter((f) => f.name === 'orig.bin' || f.name === 'link.bin');
    expect(linked.every((f) => f.links === 2 && f.size === 1000)).toBe(true);
    expect(linked.map((f) => f.storedSize).sort((a, b) => a - b)).toEqual([0, 1000]);
    expect(result.storedBytes).toBe(1500);
    expect(result.logicalBytes).toBe(2500);
  });

  it('delivers files in batches of the requested size', async () => {
    const spec: Record<string, string> = {};
    for (let i = 0; i < 25; i++) spec[`f${i}.txt`] = 'x';
    const { batches, files } = await run([makeTmpTree(spec)], { batchSize: 10 });
    expect(files).toHaveLength(25);
    expect(batches).toEqual([10, 10, 5]);
  });

  it('reports unreadable folders without failing', async () => {
    const root = makeTmpTree({ 'a.txt': '1' });
    const { result, errors } = await run([root, path.join(root, 'missing')]);
    expect(result.filesScanned).toBe(1);
    expect(result.errorCount).toBe(1);
    expect(errors[0].error).toMatch(/ENOENT/);
  });

  it('reports progress ending at "done"', async () => {
    const root = makeTmpTree({ 'a.txt': 'abc', 'b.txt': 'de' });
    let last: InvProgress | null = null;
    await run([root], { onProgress: (p: InvProgress) => (last = p) });
    expect(last).toMatchObject({ phase: 'done', filesSeen: 2, bytesSeen: 5 });
  });

  it('stops when cancelled and flags it', async () => {
    const spec: Record<string, string> = {};
    for (let i = 0; i < 300; i++) spec[`f${i}.txt`] = 'x';
    const root = makeTmpTree(spec);
    const controller = new AbortController();
    let delivered = 0;
    const result = await scanInventory({
      roots: [root],
      signal: controller.signal,
      batchSize: 10,
      onBatch: (b) => {
        delivered += b.length;
        controller.abort(); // cancel as soon as the first batch arrives
      },
    });
    expect(result.cancelled).toBe(true);
    expect(result.filesScanned).toBeLessThan(300);
    expect(delivered).toBeLessThan(300);
  });

  it('never opens file contents: an unreadable-content file is still recorded by metadata', async () => {
    const root = makeTmpTree({ 'a.bin': Buffer.from([0, 1, 2, 3]) });
    const { files } = await run([root]);
    expect(files[0].size).toBe(4);
  });
});
