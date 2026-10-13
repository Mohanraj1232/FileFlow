import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  LoopGuard,
  RecentlyWritten,
  WatcherManager,
  shouldIgnoreFile,
  isFileStable,
  type WatchTarget,
} from './watcher';
import { makeTmpTree } from '../test/helpers';

describe('shouldIgnoreFile', () => {
  it.each([
    'a.crdownload', 'a.PART', 'a.partial', 'a.tmp', 'a.download', 'a.opdownload',
    '~$draft.docx', '.DS_Store', 'desktop.ini', 'Thumbs.db',
  ])('ignores %s', (name) => {
    expect(shouldIgnoreFile(path.join('x', name))).toBe(true);
  });

  it.each(['report.pdf', 'photo.jpg', 'archive.zip', 'tmp.pdf'])('does not ignore %s', (name) => {
    expect(shouldIgnoreFile(path.join('x', name))).toBe(false);
  });
});

describe('RecentlyWritten', () => {
  it('remembers paths regardless of slash style', () => {
    const rw = new RecentlyWritten(1000);
    rw.add('C:\\a\\b.pdf');
    expect(rw.contains('C:/a/b.pdf')).toBe(true);
    expect(rw.contains('C:/a/other.pdf')).toBe(false);
  });

  it('forgets entries after the ttl', () => {
    vi.useFakeTimers();
    try {
      const rw = new RecentlyWritten(1000);
      rw.add('/a/b.pdf');
      vi.advanceTimersByTime(999);
      expect(rw.contains('/a/b.pdf')).toBe(true);
      vi.advanceTimersByTime(2);
      expect(rw.contains('/a/b.pdf')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleanup drops expired entries only', () => {
    vi.useFakeTimers();
    try {
      const rw = new RecentlyWritten(1000);
      rw.add('/old');
      vi.advanceTimersByTime(1500);
      rw.add('/new');
      rw.cleanup();
      expect(rw.contains('/old')).toBe(false);
      expect(rw.contains('/new')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('LoopGuard (circuit breaker)', () => {
  it('lets a path through up to the limit, then blocks it', () => {
    const g = new LoopGuard(3, 60_000);
    const results = [1, 2, 3, 4, 5].map((i) => g.allow('/loop.pdf', 1000 + i));
    expect(results).toEqual([true, true, true, false, false]);
  });

  it('is per path', () => {
    const g = new LoopGuard(1, 60_000);
    expect(g.allow('/a', 1)).toBe(true);
    expect(g.allow('/b', 2)).toBe(true);
    expect(g.allow('/a', 3)).toBe(false);
  });

  it('forgets hits outside the window', () => {
    const g = new LoopGuard(1, 1000);
    expect(g.allow('/a', 0)).toBe(true);
    expect(g.allow('/a', 500)).toBe(false);
    expect(g.allow('/a', 1500)).toBe(true);
  });
});

describe('isFileStable', () => {
  it('true for a file that is not changing', async () => {
    const root = makeTmpTree({ 'a.bin': 'x' });
    expect(await isFileStable(path.join(root, 'a.bin'), 20)).toBe(true);
  });

  it('false when the file is still being written', async () => {
    const root = makeTmpTree({ 'a.bin': 'x' });
    const file = path.join(root, 'a.bin');
    const pending = isFileStable(file, 100);
    fs.appendFileSync(file, 'more data');
    expect(await pending).toBe(false);
  });

  it('false when the file vanishes or never existed', async () => {
    const root = makeTmpTree({ 'a.bin': 'x' });
    const file = path.join(root, 'a.bin');
    const pending = isFileStable(file, 50);
    fs.rmSync(file);
    expect(await pending).toBe(false);
    expect(await isFileStable(path.join(root, 'nope'), 10)).toBe(false);
  });
});

describe('WatcherManager with a real filesystem watcher', () => {
  const folderOf = (p: string, recursive = false): WatchTarget => ({ id: 1, path: p, recursive });

  async function waitFor(cond: () => boolean, ms = 8000) {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > ms) throw new Error('timed out waiting for the watcher');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('reports new top-level files, ignores subfolders and later edits (no "change" re-processing)', async () => {
    const root = makeTmpTree({ 'sub/': '' });
    const seen: string[] = [];
    const wm = new WatcherManager((p) => void seen.push(path.basename(p)));
    wm.add(folderOf(root));
    await settle(500); // let the initial scan finish (ignoreInitial)

    fs.writeFileSync(path.join(root, 'new.pdf'), 'v1');
    fs.writeFileSync(path.join(root, 'sub', 'hidden-in-sub.pdf'), 'x');
    await waitFor(() => seen.includes('new.pdf'));

    fs.writeFileSync(path.join(root, 'new.pdf'), 'v2 edited later');
    await settle(3500);
    await wm.close();

    expect(seen).toEqual(['new.pdf']);
  }, 25000);

  it('recursive folders also report files in subfolders; dotfiles and junk folders are skipped', async () => {
    const root = makeTmpTree({ 'sub/': '', 'node_modules/': '' });
    const seen: string[] = [];
    const wm = new WatcherManager((p) => void seen.push(path.relative(root, p).replace(/\\/g, '/')));
    wm.add(folderOf(root, true));
    await settle(500);

    fs.writeFileSync(path.join(root, 'sub', 'a.pdf'), 'x');
    fs.writeFileSync(path.join(root, '.secret.pdf'), 'x');
    fs.writeFileSync(path.join(root, 'node_modules', 'b.pdf'), 'x');
    await waitFor(() => seen.includes('sub/a.pdf'));
    await settle(2500);
    await wm.close();

    expect(seen).toEqual(['sub/a.pdf']);
  }, 25000);

  it('honours the shouldIgnore hook, and stops reporting after remove()', async () => {
    const root = makeTmpTree();
    const seen: string[] = [];
    const wm = new WatcherManager(
      (p) => void seen.push(path.basename(p)),
      (p) => path.basename(p).startsWith('skip-')
    );
    wm.add(folderOf(root));
    await settle(500);

    fs.writeFileSync(path.join(root, 'skip-me.pdf'), 'x');
    fs.writeFileSync(path.join(root, 'take-me.pdf'), 'x');
    await waitFor(() => seen.includes('take-me.pdf'));
    await settle(500);
    expect(seen).toEqual(['take-me.pdf']);

    await wm.remove(root);
    expect(wm.size).toBe(0);
    fs.writeFileSync(path.join(root, 'after-remove.pdf'), 'x');
    await settle(3000);
    await wm.close();
    expect(seen).toEqual(['take-me.pdf']);
  }, 25000);

  it('adding the same folder twice does not double-report', async () => {
    const root = makeTmpTree();
    const seen: string[] = [];
    const wm = new WatcherManager((p) => void seen.push(path.basename(p)));
    wm.add(folderOf(root));
    wm.add(folderOf(root));
    expect(wm.size).toBe(1);
    await settle(500);
    fs.writeFileSync(path.join(root, 'once.pdf'), 'x');
    await waitFor(() => seen.length > 0);
    await settle(500);
    await wm.close();
    expect(seen).toEqual(['once.pdf']);
  }, 25000);

  it('one failing handler does not stop later files being processed', async () => {
    const root = makeTmpTree();
    const seen: string[] = [];
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const wm = new WatcherManager((p) => {
      seen.push(path.basename(p));
      if (path.basename(p) === 'bad.pdf') throw new Error('handler blew up');
    });
    wm.add(folderOf(root));
    await settle(500);
    fs.writeFileSync(path.join(root, 'bad.pdf'), 'x');
    await waitFor(() => seen.includes('bad.pdf'));
    fs.writeFileSync(path.join(root, 'good.pdf'), 'x');
    await waitFor(() => seen.includes('good.pdf'));
    await wm.close();
    errors.mockRestore();
    expect(seen).toEqual(['bad.pdf', 'good.pdf']);
  }, 25000);
});
