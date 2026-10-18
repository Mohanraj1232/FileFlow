import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { openTestDb } from '../../test/helpers';
import type { InvFile } from './inventory';
import * as repo from './repo';
import { pathKey } from '../planner';

const ROOT = path.resolve('/inv-root');
const ROOT2 = path.resolve('/inv-other');
const P = (...p: string[]) => path.join(ROOT, ...p);
const NOW = Date.UTC(2026, 9, 18);
const DAY = 24 * 3600 * 1000;
const MONTH = 30.4375 * DAY;

/** A synthetic file row (nothing on disk). */
function inv(rel: string, size: number, over: Partial<InvFile> = {}): InvFile {
  const full = over.root ? path.join(over.root, rel) : P(rel);
  const ext = path.extname(full).replace('.', '').toLowerCase();
  return {
    path: full,
    dir: path.dirname(full),
    root: ROOT,
    name: path.basename(full),
    ext,
    kind: 'other',
    size,
    storedSize: size,
    links: 1,
    mtimeMs: NOW - DAY,
    atimeMs: NOW,
    birthtimeMs: NOW - 2 * DAY,
    ...over,
  };
}

const totals = (files: InvFile[]) => ({
  fileCount: files.length,
  dirCount: new Set(files.map((f) => f.dir)).size,
  storedBytes: files.reduce((n, f) => n + f.storedSize, 0),
  logicalBytes: files.reduce((n, f) => n + f.size, 0),
  errorCount: 0,
});

/** Create a finished scan from synthetic files. */
function makeScan(db: any, files: InvFile[], roots = [ROOT]): number {
  const id = repo.createScan(db, roots);
  repo.insertFiles(db, id, files);
  repo.finishScan(db, id, totals(files));
  return id;
}

let db: any;
beforeEach(() => {
  db = openTestDb();
});
afterEach(() => db.close());

describe('scan lifecycle', () => {
  it('a running scan is invisible to reports until it finishes', () => {
    const id = repo.createScan(db, [ROOT]);
    repo.insertFiles(db, id, [inv('a.txt', 10)]);
    expect(repo.listScans(db)).toEqual([]);
    expect(repo.getScan(db, id)?.state).toBe('running');

    repo.finishScan(db, id, totals([inv('a.txt', 10)]));
    const [scan] = repo.listScans(db);
    expect(scan).toMatchObject({ id, state: 'done', file_count: 1, stored_bytes: 10, roots: [ROOT] });
    expect(scan.finished_at).not.toBeNull();
  });

  it('a re-scan of the same folders replaces the old scan, including its rows', () => {
    const first = makeScan(db, [inv('old.txt', 5)]);
    const second = makeScan(db, [inv('new1.txt', 7), inv('new2.txt', 8)]);

    expect(repo.listScans(db).map((s) => s.id)).toEqual([second]);
    expect(repo.getScan(db, first)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) c FROM inventory_files WHERE scan_id = ?').get(first).c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM inventory_files WHERE scan_id = ?').get(second).c).toBe(2);
  });

  it('the same folders in another order are the same scan; different folders are separate scans', () => {
    makeScan(db, [inv('a.txt', 1)], [ROOT, ROOT2]);
    makeScan(db, [inv('b.txt', 1)], [ROOT2, ROOT]);
    expect(repo.listScans(db)).toHaveLength(1);
    makeScan(db, [inv('c.txt', 1)], [ROOT]);
    expect(repo.listScans(db)).toHaveLength(2);
  });

  it('a cancelled or failed scan leaves the previous report untouched', () => {
    const good = makeScan(db, [inv('keep.txt', 5)]);
    const building = repo.createScan(db, [ROOT]);
    repo.insertFiles(db, building, [inv('partial.txt', 9)]);
    repo.discardScan(db, building);

    expect(repo.listScans(db).map((s) => s.id)).toEqual([good]);
    expect(repo.queryFiles(db, good, {}).files.map((f) => f.name)).toEqual(['keep.txt']);
    expect(db.prepare('SELECT COUNT(*) c FROM inventory_files').get().c).toBe(1);
  });

  it('purges scans left unfinished by a crash', () => {
    const good = makeScan(db, [inv('keep.txt', 5)]);
    repo.createScan(db, [ROOT2]);
    expect(repo.purgeUnfinished(db)).toBe(1);
    expect(repo.listScans(db).map((s) => s.id)).toEqual([good]);
  });

  it('keeps only the 10 most recent scans', () => {
    for (let i = 0; i < 12; i++) makeScan(db, [inv(`f${i}.txt`, 1, { root: path.resolve(`/r${i}`) })], [path.resolve(`/r${i}`)]);
    expect(repo.listScans(db)).toHaveLength(10);
  });

  it('deleting a scan removes its files and errors', () => {
    const id = makeScan(db, [inv('a.txt', 1)]);
    repo.insertErrors(db, id, [{ path: '/x', error: 'EACCES' }]);
    repo.deleteScan(db, id);
    expect(db.prepare('SELECT COUNT(*) c FROM inventory_files').get().c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM inventory_errors').get().c).toBe(0);
  });

  it('stores scan errors, capped, and returns them', () => {
    const id = makeScan(db, [inv('a.txt', 1)]);
    repo.insertErrors(db, id, Array.from({ length: 600 }, (_, i) => ({ path: `/p${i}`, error: 'EACCES' })));
    expect(db.prepare('SELECT COUNT(*) c FROM inventory_errors').get().c).toBe(500);
    expect(repo.getErrors(db, id, 3)).toHaveLength(3);
  });

  it('clearInventory removes everything', () => {
    makeScan(db, [inv('a.txt', 1)]);
    expect(repo.clearInventory(db)).toBe(1);
    expect(repo.listScans(db)).toEqual([]);
  });
});

describe('totals never double count shared data', () => {
  it('uses stored_size for totals while showing each file\'s own size', () => {
    const files = [inv('orig.bin', 1000, { links: 2 }), inv('link.bin', 1000, { links: 2, storedSize: 0 }), inv('x.bin', 500)];
    const id = makeScan(db, files);
    const page = repo.queryFiles(db, id, {});
    expect(page.total_count).toBe(3);
    expect(page.total_bytes).toBe(1500);
    expect(page.files.filter((f) => f.size === 1000)).toHaveLength(2);
    expect(repo.getScan(db, id)).toMatchObject({ stored_bytes: 1500, logical_bytes: 2500 });
  });

  it('refreshTotals recomputes after files are deleted', () => {
    const id = makeScan(db, [inv('a.bin', 100), inv('b.bin', 200)]);
    const [first] = repo.queryFiles(db, id, {}, 'size_asc').files;
    repo.deleteFilesByIds(db, [first.id]);
    repo.refreshTotals(db, id);
    expect(repo.getScan(db, id)).toMatchObject({ file_count: 1, stored_bytes: 200, logical_bytes: 200 });
  });
});

describe('folderBreakdown', () => {
  const files = [
    inv('a/one.txt', 100), inv('a/two.txt', 50), inv('a/deep/x/three.txt', 400),
    inv('ab/sibling.txt', 7),
    inv('b/four.txt', 30),
    inv('top.txt', 5),
  ];

  it('with no folder, lists each chosen root', () => {
    const id = makeScan(db, [...files, inv('r2.txt', 9, { root: ROOT2 })], [ROOT, ROOT2]);
    const { children } = repo.folderBreakdown(db, id, null);
    expect(children.map((c) => [c.path, c.bytes])).toEqual([[ROOT, 592], [ROOT2, 9]]);
  });

  it('rolls everything beneath each subfolder up into it, and reports files directly inside', () => {
    const id = makeScan(db, files);
    const root = repo.folderBreakdown(db, id, ROOT);
    expect(root.direct).toEqual({ files: 1, bytes: 5 });
    expect(root.children.map((c) => [c.name, c.files, c.bytes])).toEqual([['a', 3, 550], ['b', 1, 30], ['ab', 1, 7]]);

    const a = repo.folderBreakdown(db, id, P('a'));
    expect(a.direct).toEqual({ files: 2, bytes: 150 });
    expect(a.children).toEqual([{ path: P('a', 'deep'), name: 'deep', files: 1, bytes: 400 }]);
  });

  it('does not mix up folders that share a name prefix ("a" vs "ab")', () => {
    const id = makeScan(db, files);
    const a = repo.folderBreakdown(db, id, P('a'));
    expect(a.children.some((c) => c.name === 'sibling.txt' || c.path.includes('ab'))).toBe(false);
    expect(repo.queryFiles(db, id, { folder: P('a') }).files.map((f) => f.name).sort()).toEqual(['one.txt', 'three.txt', 'two.txt']);
    expect(repo.queryFiles(db, id, { folder: P('ab') }).files.map((f) => f.name)).toEqual(['sibling.txt']);
  });

  it('a folder with nothing in it is empty', () => {
    const id = makeScan(db, files);
    expect(repo.folderBreakdown(db, id, P('nope'))).toEqual({ children: [], direct: { files: 0, bytes: 0 } });
  });
});

describe('largestFolders', () => {
  it('ranks folders by everything beneath them, excluding the chosen roots', () => {
    const id = makeScan(db, [inv('big/sub/a.bin', 900), inv('big/b.bin', 100), inv('small/c.bin', 50), inv('top.bin', 5000)]);
    const top = repo.largestFolders(db, id, [ROOT], 10);
    expect(top.map((f) => [f.name, f.bytes])).toEqual([['big', 1000], ['sub', 900], ['small', 50]]);
    expect(top.some((f) => f.path === ROOT)).toBe(false);
  });

  it('honours the limit', () => {
    const id = makeScan(db, [inv('a/x', 3), inv('b/x', 2), inv('c/x', 1)]);
    expect(repo.largestFolders(db, id, [ROOT], 2).map((f) => f.name)).toEqual(['a', 'b']);
  });
});

describe('byKind', () => {
  it('totals each kind, biggest first, with the top five extensions', () => {
    const files = [
      inv('v1.mp4', 500, { kind: 'video' }), inv('v2.mkv', 300, { kind: 'video' }),
      inv('d1.pdf', 100, { kind: 'document' }),
      ...['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((e, i) => inv(`x.${e}`, 10 + i, { kind: 'other' })),
    ];
    const id = makeScan(db, files);
    const kinds = repo.byKind(db, id);
    expect(kinds.map((k) => [k.kind, k.files, k.bytes])).toEqual([['video', 2, 800], ['document', 1, 100], ['other', 7, 91]]);
    expect(kinds[0].top_extensions).toEqual([{ ext: 'mp4', files: 1, bytes: 500 }, { ext: 'mkv', files: 1, bytes: 300 }]);
    expect(kinds[2].top_extensions).toHaveLength(5);
    expect(kinds[2].top_extensions[0].ext).toBe('g'); // largest first
  });

  it('can be limited to a folder', () => {
    const id = makeScan(db, [inv('a/x.mp4', 10, { kind: 'video' }), inv('b/y.mp4', 99, { kind: 'video' })]);
    expect(repo.byKind(db, id, { folder: P('a') })[0].bytes).toBe(10);
  });
});

describe('ageBuckets', () => {
  it('splits space by last-modified age', () => {
    const at = (months: number) => NOW - months * MONTH - DAY;
    const id = makeScan(db, [
      inv('new.txt', 1, { mtimeMs: NOW - 2 * DAY }),
      inv('m3.txt', 10, { mtimeMs: at(3) }),
      inv('m8.txt', 100, { mtimeMs: at(8) }),
      inv('y1.txt', 1000, { mtimeMs: at(15) }),
      inv('y3.txt', 10000, { mtimeMs: at(40) }),
    ]);
    const buckets = repo.ageBuckets(db, id, NOW);
    expect(buckets.map((b) => [b.label, b.files, b.bytes])).toEqual([
      ['Past month', 1, 1],
      ['1–6 months', 1, 10],
      ['6–12 months', 1, 100],
      ['1–2 years', 1, 1000],
      ['Over 2 years', 1, 10000],
    ]);
    // Every file lands in exactly one bucket.
    expect(buckets.reduce((n, b) => n + b.files, 0)).toBe(5);
  });
});

describe('queryFiles', () => {
  const D = (n: number) => NOW - n * DAY;
  const files = [
    inv('docs/report.pdf', 5000, { kind: 'document', mtimeMs: D(400) }),
    inv('docs/notes.txt', 100, { kind: 'document', mtimeMs: D(5) }),
    inv('media/movie.mp4', 90000, { kind: 'video', mtimeMs: D(200) }),
    inv('media/clip.mp4', 3000, { kind: 'video', mtimeMs: D(1) }),
    inv('100%_done.txt', 7, { kind: 'document', mtimeMs: D(2) }),
    inv('100x_done.txt', 8, { kind: 'document', mtimeMs: D(3) }),
  ];
  let id: number;
  beforeEach(() => {
    id = makeScan(db, files);
  });
  const names = (f: repo.FileFilter, sort: repo.FileSort = 'name') => repo.queryFiles(db, id, f, sort).files.map((x) => x.name);

  it('filters by kind, extension, size, modified time and folder', () => {
    expect(names({ kinds: ['video'] })).toEqual(['clip.mp4', 'movie.mp4']);
    expect(names({ ext: '.MP4' })).toEqual(['clip.mp4', 'movie.mp4']);
    expect(names({ min_size: 3000, max_size: 5000 })).toEqual(['clip.mp4', 'report.pdf']);
    expect(names({ modified_before: D(100) })).toEqual(['movie.mp4', 'report.pdf']);
    expect(names({ modified_after: D(4) })).toEqual(['100%_done.txt', '100x_done.txt', 'clip.mp4']); // notes.txt is 5 days old
    expect(names({ folder: P('media') })).toEqual(['clip.mp4', 'movie.mp4']);
  });

  it('combines filters', () => {
    expect(names({ kinds: ['video'], modified_before: D(100) })).toEqual(['movie.mp4']);
  });

  it('name search is a plain substring match: % and _ are literal characters', () => {
    expect(names({ name_contains: 'REPORT' })).toEqual(['report.pdf']);
    expect(names({ name_contains: '100%' })).toEqual(['100%_done.txt']);
    expect(names({ name_contains: '_done' })).toEqual(['100%_done.txt', '100x_done.txt']);
    expect(names({ name_contains: '%' })).toEqual(['100%_done.txt']);
  });

  it('sorts', () => {
    expect(names({}, 'size_desc')[0]).toBe('movie.mp4');
    expect(names({}, 'size_asc')[0]).toBe('100%_done.txt');
    expect(names({}, 'mtime_desc')[0]).toBe('clip.mp4');
    expect(names({}, 'mtime_asc')[0]).toBe('report.pdf');
  });

  it('pages without changing the totals, which cover every match', () => {
    const p1 = repo.queryFiles(db, id, {}, 'size_desc', 0, 2);
    const p2 = repo.queryFiles(db, id, {}, 'size_desc', 2, 2);
    expect(p1.files.map((f) => f.name)).toEqual(['movie.mp4', 'report.pdf']);
    expect(p2.files.map((f) => f.name)).toEqual(['clip.mp4', 'notes.txt']);
    expect(p1.total_count).toBe(6);
    expect(p1.total_bytes).toBe(5000 + 100 + 90000 + 3000 + 7 + 8);
    expect(p2.offset).toBe(2);
  });

  it('finds nothing in another scan', () => {
    const other = makeScan(db, [inv('only.txt', 1)], [ROOT2]);
    expect(repo.queryFiles(db, other, {}).files.map((f) => f.name)).toEqual(['only.txt']);
  });

  it('getFilesByPaths and getFilesByIds return rows for known paths only', () => {
    const found = repo.getFilesByPaths(db, id, [P('docs', 'report.pdf'), P('nope.txt')]);
    expect([...found.keys()]).toEqual([P('docs', 'report.pdf')]);
    const rows = repo.getFilesByIds(db, [found.get(P('docs', 'report.pdf'))!.id, 999999]);
    expect(rows.map((r) => r.name)).toEqual(['report.pdf']);
  });
});

describe('directorySet', () => {
  it('contains every folder with files beneath it, including ancestors', () => {
    const id = makeScan(db, [inv('a/b/c.txt', 1), inv('x.txt', 1)]);
    const dirs = repo.directorySet(db, id);
    expect(dirs.has(pathKey(path.join(ROOT, 'a', 'b')))).toBe(true);
    expect(dirs.has(pathKey(path.join(ROOT, 'a')))).toBe(true); // an ancestor with no files of its own
    expect(dirs.has(pathKey(ROOT))).toBe(true);
    expect(dirs.has(pathKey(path.join(ROOT, 'a', 'zzz')))).toBe(false);
  });
});
