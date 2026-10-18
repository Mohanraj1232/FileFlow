import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import * as svc from './service';
import { parseFilter } from './dto';
import { StorageScanStore } from './store';
import { DuplicateScanStore } from '../duplicates/store';
import * as repo from './repo';
import { openTestDb, makeTmpTree, buildInventory } from '../../test/helpers';

let db: any;
beforeEach(() => {
  db = openTestDb();
});
afterEach(() => db.close());

const MB = 1024;

describe('buildReport', () => {
  const spec = {
    'docs/a.pdf': 'a'.repeat(100),
    'docs/b.pdf': 'b'.repeat(200),
    'media/big.mp4': 'm'.repeat(5 * MB),
    'media/raw/x.mp4': 'x'.repeat(MB),
    'top.txt': 't'.repeat(10),
  };

  it('describes the whole scan at the top level', async () => {
    const root = makeTmpTree(spec);
    const id = await buildInventory(db, [root]);
    const report = svc.buildReport(db, id, null);

    expect(report.folder).toBeNull();
    expect(report.scan).toMatchObject({ state: 'done', file_count: 5, stored_bytes: 300 + 6 * MB + 10 });
    expect(report.children.map((c) => [c.path, c.files])).toEqual([[root, 5]]); // the chosen root
    expect(report.by_kind.map((k) => k.kind)).toEqual(['video', 'document']); // .pdf, .txt are documents; sizes order
    expect(report.largest_files[0]).toMatchObject({ name: 'big.mp4', kind: 'video' });
    expect(report.largest_folders.map((f) => f.name)).toEqual(['media', 'raw', 'docs']);
    expect(report.age.reduce((n, b) => n + b.files, 0)).toBe(5);
    expect(report.errors).toEqual([]);
  });

  it('drills into a folder: children, kinds, ages and top lists are all scoped to it', async () => {
    const root = makeTmpTree(spec);
    const id = await buildInventory(db, [root]);
    const media = path.join(root, 'media');
    const report = svc.buildReport(db, id, media);

    expect(report.folder).toBe(media);
    expect(report.children.map((c) => [c.name, c.bytes])).toEqual([['raw', MB]]);
    expect(report.direct_files).toEqual({ files: 1, bytes: 5 * MB });
    expect(report.by_kind).toHaveLength(1);
    expect(report.by_kind[0]).toMatchObject({ kind: 'video', files: 2, bytes: 6 * MB });
    expect(report.largest_files.map((f) => f.name)).toEqual(['big.mp4', 'x.mp4']);
    expect(report.largest_folders.map((f) => f.name)).toEqual(['raw']); // the folder itself is not in its own list
    expect(report.age.reduce((n, b) => n + b.files, 0)).toBe(2);
  });

  it('includes read errors from the scan', async () => {
    const root = makeTmpTree({ 'a.txt': 'x' });
    const id = repo.createScan(db, [root]);
    repo.finishScan(db, id, { fileCount: 0, dirCount: 0, storedBytes: 0, logicalBytes: 0, errorCount: 1 });
    repo.insertErrors(db, id, [{ path: '/locked', error: 'EACCES: permission denied' }]);
    expect(svc.buildReport(db, id, null).errors).toEqual([{ path: '/locked', error: 'EACCES: permission denied' }]);
  });

  it('refuses a scan that is not finished or does not exist', () => {
    const running = repo.createScan(db, ['/x']);
    expect(() => svc.buildReport(db, running, null)).toThrow(/no longer available/);
    expect(() => svc.buildReport(db, 9999, null)).toThrow(/no longer available/);
  });
});

describe('filesPage', () => {
  it('applies a sanitised filter and returns totals for every match', async () => {
    const root = makeTmpTree({ 'a.mp4': 'x'.repeat(50), 'b.mp4': 'y'.repeat(20), 'c.txt': 'z' });
    const id = await buildInventory(db, [root]);
    const page = svc.filesPage(db, id, { kinds: ['video'], bogus: 'ignored' }, 'size_asc', 0, 1);
    expect(page.files.map((f) => f.name)).toEqual(['b.mp4']);
    expect(page).toMatchObject({ total_count: 2, total_bytes: 70, offset: 0 });
    expect(page.files[0]).toMatchObject({ kind: 'video', size: 20, stored_size: 20, links: 1 });
    expect(Date.parse(page.files[0].modified_at)).not.toBeNaN();
  });

  it('falls back to the default sort for an unknown sort, and to defaults for junk paging', async () => {
    const root = makeTmpTree({ 'small.txt': 'x', 'big.txt': 'x'.repeat(100) });
    const id = await buildInventory(db, [root]);
    const page = svc.filesPage(db, id, {}, 'DROP TABLE', 'abc', -5);
    expect(page.files.map((f) => f.name)).toEqual(['big.txt', 'small.txt']);
    expect(page.offset).toBe(0);
  });
});

describe('parseFilter', () => {
  it('keeps valid fields and converts dates', () => {
    const f = parseFilter({
      folder: '/a', kinds: ['video', 'nonsense'], ext: ' PDF ', min_size: 10, max_size: 99,
      modified_before: '2026-01-01T00:00:00Z', modified_after: '2025-01-01', name_contains: ' hi ',
    });
    expect(f).toEqual({
      folder: '/a', kinds: ['video'], ext: 'PDF', min_size: 10, max_size: 99,
      modified_before: Date.parse('2026-01-01T00:00:00Z'), modified_after: Date.parse('2025-01-01'), name_contains: 'hi',
    });
  });

  it('drops invalid values and unknown fields, and tolerates non-objects', () => {
    expect(parseFilter({ min_size: -1, max_size: 'x', modified_before: 'not a date', kinds: 'video', ext: ' ', name_contains: '  ', extra: 1 })).toEqual({});
    expect(parseFilter(null)).toEqual({});
    expect(parseFilter('hello')).toEqual({});
  });
});

describe('recommendations', () => {
  it('uses 6 months unless given a supported value', async () => {
    const root = makeTmpTree({ 'a.txt': 'x' });
    const id = await buildInventory(db, [root]);
    expect(svc.recommendations(db, id, 'weird').old_months).toBe(6);
    expect(svc.recommendations(db, id, 12).old_months).toBe(12);
    expect(svc.recommendations(db, id, 7).old_months).toBe(6);
  });
});

describe('summaries', () => {
  it('lists finished scans, with a running scan first', async () => {
    const root = makeTmpTree({ 'a.txt': 'abc' });
    const store = new StorageScanStore();
    const first = store.start({ db, roots: [root] });
    for (let i = 0; i < 200 && store.get(first.id)!.state === 'running'; i++) await new Promise((r) => setTimeout(r, 20));

    const other = makeTmpTree({ 'b.txt': 'x' });
    const second = store.start({ db, roots: [other] });
    const listed = svc.listSummaries(db, store);
    expect(listed[0]).toMatchObject({ scan_id: second.id, state: 'running' });
    expect(listed.some((s) => s.scan_id === first.id && s.state === 'done')).toBe(true);

    expect(svc.getSummary(db, store, first.id)).toMatchObject({ state: 'done', file_count: 1, stored_bytes: 3 });
    for (let i = 0; i < 200 && store.get(second.id)!.state === 'running'; i++) await new Promise((r) => setTimeout(r, 20));
  });

  it('a cancelled scan is reported as cancelled, not as missing', async () => {
    const spec: Record<string, string> = {};
    for (let i = 0; i < 300; i++) spec[`f${i}.txt`] = 'x';
    const root = makeTmpTree(spec);
    const store = new StorageScanStore();
    const s = store.start({ db, roots: [root] });
    store.cancel(s.id);
    for (let i = 0; i < 200 && store.get(s.id)!.state === 'running'; i++) await new Promise((r) => setTimeout(r, 20));
    expect(svc.getSummary(db, store, s.id).state).toBe('cancelled');
  });

  it('an unknown scan is an error', () => {
    expect(() => svc.getSummary(db, new StorageScanStore(), 12345)).toThrow(/no longer available/);
  });
});

describe('duplicateSavings', () => {
  async function dupScan(roots: string[]) {
    const store = new DuplicateScanStore();
    const started = store.start({ roots, db });
    for (let i = 0; i < 200 && store.get(started.id)!.state === 'running'; i++) await new Promise((r) => setTimeout(r, 20));
    return store;
  }

  it('reports a duplicate scan of exactly the same folders, kept apart from recommendations', async () => {
    const root = makeTmpTree({ 'a.txt': 'same content', 'b.txt': 'same content', 'c.txt': 'different!!!!!' });
    const id = await buildInventory(db, [root]);
    const dups = await dupScan([root]);
    expect(svc.duplicateSavings(db, id, dups)).toMatchObject({ reclaimable_bytes: 'same content'.length, group_count: 1 });
  });

  it('is null when no duplicate scan covers those folders', async () => {
    const root = makeTmpTree({ 'a.txt': 'same content', 'b.txt': 'same content' });
    const other = makeTmpTree({ 'x.txt': 'x' });
    const id = await buildInventory(db, [root]);
    expect(svc.duplicateSavings(db, id, new DuplicateScanStore())).toBeNull();
    expect(svc.duplicateSavings(db, id, await dupScan([other]))).toBeNull();
    expect(svc.duplicateSavings(db, id, await dupScan([root, other]))).toBeNull(); // a different set of folders
  });
});
