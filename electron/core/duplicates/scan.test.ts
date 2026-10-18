import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { scanDuplicates, HEAD_BYTES, type HashCache, type ScanProgress } from './scan';
import { compileIgnore } from '../ignore';
import { protectAppDataDir } from '../paths';
import { makeTmpTree } from '../../test/helpers';

const names = (g: { files: { path: string }[] }, root: string) =>
  g.files.map((f) => path.relative(root, f.path).replace(/\\/g, '/')).sort();

/** Try to create a hard link; false when the filesystem or permissions do not allow it. */
function tryHardLink(target: string, link: string): boolean {
  try {
    fs.linkSync(target, link);
    return true;
  } catch {
    return false;
  }
}

/** Try to create a symlink/junction; false when the OS or permissions do not allow it. */
function trySymlink(target: string, link: string, type: 'file' | 'junction'): boolean {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch {
    return false;
  }
}

/** A hash cache that records what was asked of it. */
function memoryCache() {
  const store = new Map<string, string>();
  const calls = { get: 0, put: 0 };
  const key = (p: string, s: number, m: number) => `${p}|${s}|${Math.trunc(m)}`;
  const cache: HashCache = {
    get: (p, s, m) => {
      calls.get++;
      return store.get(key(p, s, m));
    },
    put: (p, s, m, h) => {
      calls.put++;
      store.set(key(p, s, m), h);
    },
  };
  return { cache, calls, store };
}

describe('finding duplicates', () => {
  it('groups files with identical content, whatever their names', async () => {
    const root = makeTmpTree({
      'a.txt': 'hello world',
      'sub/copy of a.txt': 'hello world',
      'renamed.dat': 'hello world',
      'other.txt': 'something else!',
    });
    const { groups, stats, cancelled } = await scanDuplicates({ roots: [root] });

    expect(cancelled).toBe(false);
    expect(groups).toHaveLength(1);
    expect(names(groups[0], root)).toEqual(['a.txt', 'renamed.dat', 'sub/copy of a.txt']);
    expect(groups[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stats.groups).toBe(1);
    expect(stats.duplicateFiles).toBe(2);
  });

  it('does NOT group same-named files that have different content', async () => {
    const root = makeTmpTree({ 'one/report.pdf': 'version one', 'two/report.pdf': 'version two' });
    const { groups } = await scanDuplicates({ roots: [root] });
    expect(groups).toEqual([]);
  });

  it('does NOT group same-sized files that have different content (small files)', async () => {
    const root = makeTmpTree({ 'a.bin': 'AAAAAAAAAA', 'b.bin': 'AAAAAAAAAB' });
    const { groups, stats } = await scanDuplicates({ roots: [root] });
    expect(groups).toEqual([]);
    expect(stats.filesHashed).toBe(2); // they were compared by content, and found different
  });

  it('does NOT group large files that share a first 64 KB but differ later', async () => {
    const size = HEAD_BYTES * 3;
    const a = Buffer.alloc(size, 'x');
    const b = Buffer.from(a);
    b[size - 1] = 'y'.charCodeAt(0); // differs only at the very end
    const c = Buffer.from(a); // an exact copy of a
    const root = makeTmpTree({ 'a.bin': a, 'b.bin': b, 'c.bin': c });

    const { groups } = await scanDuplicates({ roots: [root] });
    expect(groups).toHaveLength(1);
    expect(names(groups[0], root)).toEqual(['a.bin', 'c.bin']);
  });

  it('never hashes a file whose size is unique', async () => {
    const root = makeTmpTree({ 'one.txt': 'a', 'two.txt': 'bb', 'three.txt': 'ccc' });
    const { groups, stats } = await scanDuplicates({ roots: [root] });
    expect(groups).toEqual([]);
    expect(stats.candidateFiles).toBe(0);
    expect(stats.filesHashed).toBe(0);
    expect(stats.filesScanned).toBe(3);
  });

  it('skips the full hash of large files whose head differs', async () => {
    const size = HEAD_BYTES * 2;
    const a = Buffer.alloc(size, 'a');
    const b = Buffer.alloc(size, 'b'); // same size, different first bytes
    const root = makeTmpTree({ 'a.bin': a, 'b.bin': b });
    const { groups, stats } = await scanDuplicates({ roots: [root] });
    expect(groups).toEqual([]);
    expect(stats.filesHashed).toBe(0); // ruled out by the 64 KB head, never read in full
  });

  it('ignores empty files', async () => {
    const root = makeTmpTree({ 'empty1.txt': '', 'empty2.txt': '', 'x.txt': 'x' });
    const { groups, stats } = await scanDuplicates({ roots: [root] });
    expect(groups).toEqual([]);
    expect(stats.filesScanned).toBe(1);
  });

  it('honours the minimum size', async () => {
    const small = 'tiny';
    const big = 'b'.repeat(2000);
    const root = makeTmpTree({ 's1': small, 's2': small, 'b1': big, 'b2': big });
    const { groups } = await scanDuplicates({ roots: [root], minSize: 1000 });
    expect(groups).toHaveLength(1);
    expect(groups[0].size).toBe(2000);
  });

  it('finds duplicates across several folders, and tolerates overlapping folders', async () => {
    const root = makeTmpTree({ 'A/f.txt': 'same', 'B/g.txt': 'same', 'A/inner/h.txt': 'unique content' });
    const { groups, stats } = await scanDuplicates({
      roots: [path.join(root, 'A'), path.join(root, 'B'), root, path.join(root, 'A', 'inner')],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].files).toHaveLength(2); // overlapping roots do not create phantom copies
    expect(stats.filesScanned).toBe(3);
  });
});

describe('space accounting', () => {
  it('reclaimable space = size x (copies - 1), per group, with no double counting', async () => {
    const root = makeTmpTree({
      'a1': 'x'.repeat(100), 'a2': 'x'.repeat(100), 'a3': 'x'.repeat(100), // 3 copies of 100 B -> 200
      'b1': 'y'.repeat(50), 'b2': 'y'.repeat(50),                           // 2 copies of 50 B  -> 50
      'solo': 'z'.repeat(70),
    });
    const { groups, stats } = await scanDuplicates({ roots: [root] });
    expect(groups.map((g) => g.reclaimableBytes)).toEqual([200, 50]); // biggest saving first
    expect(stats.reclaimableBytes).toBe(250);
    expect(stats.duplicateFiles).toBe(3);
  });

  it('hard links to the same data are not counted as savings', async (ctx) => {
    const root = makeTmpTree({ 'orig.bin': 'x'.repeat(500), 'real-copy.bin': 'x'.repeat(500) });
    if (!tryHardLink(path.join(root, 'orig.bin'), path.join(root, 'link.bin'))) ctx.skip();
    const { groups } = await scanDuplicates({ roots: [root] });
    expect(groups).toHaveLength(1);
    expect(groups[0].files).toHaveLength(3);
    // orig + link are one stored copy; real-copy is a second. Only one copy can be freed.
    expect(groups[0].reclaimableBytes).toBe(500);
  });

  it('files that are only hard links of each other are not a duplicate group', async (ctx) => {
    const root = makeTmpTree({ 'orig.bin': 'x'.repeat(500) });
    if (!tryHardLink(path.join(root, 'orig.bin'), path.join(root, 'link.bin'))) ctx.skip();
    const { groups } = await scanDuplicates({ roots: [root] });
    expect(groups).toEqual([]);
  });

  it('lists the oldest copy first', async () => {
    const root = makeTmpTree({ 'new.txt': 'same', 'old.txt': 'same', 'mid.txt': 'same' });
    const set = (n: string, iso: string) => fs.utimesSync(path.join(root, n), new Date(iso), new Date(iso));
    set('old.txt', '2020-01-01T00:00:00Z');
    set('mid.txt', '2022-01-01T00:00:00Z');
    set('new.txt', '2024-01-01T00:00:00Z');
    const { groups } = await scanDuplicates({ roots: [root] });
    expect(groups[0].files.map((f) => f.name)).toEqual(['old.txt', 'mid.txt', 'new.txt']);
  });
});

describe('what is (not) scanned', () => {
  it('skips hidden files and folders unless asked', async () => {
    const root = makeTmpTree({ 'visible.txt': 'same', '.hidden.txt': 'same', '.cfg/inner.txt': 'same' });
    expect((await scanDuplicates({ roots: [root] })).groups).toEqual([]);
    const all = await scanDuplicates({ roots: [root], includeHidden: true });
    expect(all.groups[0].files).toHaveLength(3);
  });

  it('skips dependency folders, the quarantine folder, temp downloads and OS junk', async () => {
    const root = makeTmpTree({
      'keep.txt': 'same',
      'node_modules/pkg/a.txt': 'same',
      '.git/objects/b': 'same',
      'FileFlow Quarantine/2026/c.txt': 'same',
      'partial.crdownload': 'same',
      'Thumbs.db': 'same',
    });
    expect((await scanDuplicates({ roots: [root], includeHidden: true })).groups).toEqual([]);
  });

  it('applies user ignore patterns', async () => {
    const root = makeTmpTree({ 'a.txt': 'same', 'b.log': 'same', 'Backups/c.txt': 'same' });
    const { groups } = await scanDuplicates({ roots: [root], isIgnored: compileIgnore(['*.log', 'Backups/**']) });
    expect(groups).toEqual([]);
  });

  it('never enters protected folders', async () => {
    const root = makeTmpTree({ 'visible.txt': 'same', 'guarded/inner.txt': 'same' });
    protectAppDataDir(path.join(root, 'guarded'));
    expect((await scanDuplicates({ roots: [root] })).groups).toEqual([]);
  });

  // Links are tested separately so one unavailable kind (a file symlink needs admin rights or
  // Developer Mode on Windows) does not hide the other. An unavailable kind is reported as a
  // SKIP in the test output rather than silently passing.
  it('does not follow a symlinked or junctioned folder out of the scanned folder', async (ctx) => {
    const outside = makeTmpTree({ 'secret.txt': 'same', 'deeper/also-secret.txt': 'same' });
    const root = makeTmpTree({ 'mine.txt': 'same' });
    if (!trySymlink(outside, path.join(root, 'link'), 'junction')) ctx.skip();

    const { groups, stats } = await scanDuplicates({ roots: [root] });
    expect(groups).toEqual([]);
    expect(stats.filesScanned).toBe(1); // only mine.txt; nothing reached through the link
  });

  it('does not follow a symlinked file out of the scanned folder', async (ctx) => {
    const outside = makeTmpTree({ 'secret.txt': 'same' });
    const root = makeTmpTree({ 'mine.txt': 'same' });
    if (!trySymlink(path.join(outside, 'secret.txt'), path.join(root, 'file-link.txt'), 'file')) ctx.skip();

    const { groups, stats } = await scanDuplicates({ roots: [root] });
    expect(groups).toEqual([]);
    expect(stats.filesScanned).toBe(1);
  });

  it('a scanned folder that is itself reached through a link is still scanned', async (ctx) => {
    const real = makeTmpTree({ 'a.txt': 'same', 'b.txt': 'same' });
    const holder = makeTmpTree();
    const link = path.join(holder, 'via-link');
    if (!trySymlink(real, link, 'junction')) ctx.skip();

    // The user chose this folder, so its own files are scanned; links found INSIDE are not followed.
    const { groups } = await scanDuplicates({ roots: [link] });
    expect(groups).toHaveLength(1);
  });

  it('reports an unreadable folder instead of failing the whole scan', async () => {
    const root = makeTmpTree({ 'a.txt': 'same', 'b.txt': 'same' });
    const { groups, stats } = await scanDuplicates({ roots: [root, path.join(root, 'does-not-exist')] });
    expect(groups).toHaveLength(1);
    expect(stats.errors).toHaveLength(1);
    expect(stats.errors[0].path).toContain('does-not-exist');
  });
});

describe('hash cache', () => {
  it('reuses hashes for unchanged files on the next scan', async () => {
    const root = makeTmpTree({ 'a.txt': 'same content', 'b.txt': 'same content' });
    const { cache, calls } = memoryCache();

    const first = await scanDuplicates({ roots: [root], cache });
    expect(first.stats.filesHashed).toBe(2);
    expect(first.stats.filesFromCache).toBe(0);
    expect(calls.put).toBe(2);

    const second = await scanDuplicates({ roots: [root], cache });
    expect(second.stats.filesHashed).toBe(0);
    expect(second.stats.filesFromCache).toBe(2);
    expect(second.groups).toHaveLength(1);
    expect(second.groups[0].files.every((f) => f.hashSource === 'cached')).toBe(true);
    expect(first.groups[0].files.every((f) => f.hashSource === 'computed')).toBe(true);
  });

  it('re-hashes a file once its size or modification time changes', async () => {
    const root = makeTmpTree({ 'a.txt': 'same content', 'b.txt': 'same content' });
    const { cache } = memoryCache();
    await scanDuplicates({ roots: [root], cache });

    // a.txt now has different content (and a new size): its cached hash must not be used.
    fs.writeFileSync(path.join(root, 'a.txt'), 'now different and longer');
    const { groups, stats } = await scanDuplicates({ roots: [root], cache });
    expect(groups).toEqual([]);
    expect(stats.filesFromCache).toBe(0);
  });
});

describe('cancellation, progress and interruption', () => {
  it('stops when cancelled and returns nothing actionable', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 40; i++) files[`f${i}.txt`] = 'same content';
    const root = makeTmpTree(files);

    const controller = new AbortController();
    const result = await scanDuplicates({
      roots: [root],
      signal: controller.signal,
      onProgress: (p) => {
        if (p.phase === 'hashing') controller.abort();
      },
    });
    expect(result.cancelled).toBe(true);
    expect(result.groups).toEqual([]);
  });

  it('an already-cancelled scan does no work', async () => {
    const root = makeTmpTree({ 'a.txt': 'same', 'b.txt': 'same' });
    const controller = new AbortController();
    controller.abort();
    const result = await scanDuplicates({ roots: [root], signal: controller.signal });
    expect(result).toMatchObject({ cancelled: true, groups: [] });
    expect(result.stats.filesScanned).toBe(0);
  });

  it('reports progress through every phase and ends at "done"', async () => {
    const root = makeTmpTree({ 'a.txt': 'same', 'b.txt': 'same' });
    const phases: string[] = [];
    let last: ScanProgress | null = null;
    await scanDuplicates({
      roots: [root],
      onProgress: (p) => {
        if (phases[phases.length - 1] !== p.phase) phases.push(p.phase);
        last = p;
      },
    });
    expect(phases).toEqual(['walking', 'comparing', 'hashing', 'done']);
    expect(last).toMatchObject({ phase: 'done', filesSeen: 2, hashedFiles: 2, candidateFiles: 2 });
  });

  it('a file that changes while the scan is running is reported and left out', async () => {
    const root = makeTmpTree({ 'a.txt': 'same content', 'b.txt': 'same content', 'c.txt': 'same content' });
    let touched = false;
    const { groups, stats } = await scanDuplicates({
      roots: [root],
      onProgress: (p) => {
        // After walking, before hashing: modify one file.
        if (p.phase === 'comparing' && !touched) {
          touched = true;
          fs.appendFileSync(path.join(root, 'c.txt'), ' + appended');
        }
      },
    });
    expect(stats.errors.some((e) => e.path.endsWith('c.txt') && /changed/i.test(e.error))).toBe(true);
    expect(groups).toHaveLength(1);
    expect(groups[0].files.map((f) => f.name).sort()).toEqual(['a.txt', 'b.txt']);
  });
});
