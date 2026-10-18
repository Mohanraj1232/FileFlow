import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { openTestDb } from '../../test/helpers';
import type { InvFile } from './inventory';
import * as repo from './repo';
import {
  computeRecommendations,
  recommendationFiles,
  LARGE_MEDIA_BYTES,
  HUGE_FILE_BYTES,
  type RecommendationOptions,
} from './recommend';
import { quarantineStamp } from '../quarantine';

const ROOT = path.resolve('/rec-root');
const NOW = Date.UTC(2026, 9, 18);
const DAY = 24 * 3600 * 1000;
const MONTH = 30.4375 * DAY;
const MB = 1024 * 1024;
const opts = (oldMonths = 6): RecommendationOptions => ({ oldMonths, now: NOW });
const ago = (months: number) => NOW - months * MONTH - DAY;

function inv(rel: string, size: number, kind: string, mtimeMs: number, over: Partial<InvFile> = {}): InvFile {
  const full = path.join(ROOT, rel);
  return {
    path: full, dir: path.dirname(full), root: ROOT, name: path.basename(full),
    ext: path.extname(full).replace('.', '').toLowerCase(),
    kind: kind as InvFile['kind'], size, storedSize: size, links: 1,
    mtimeMs, atimeMs: NOW, birthtimeMs: mtimeMs, ...over,
  };
}

function scanOf(db: any, files: InvFile[]): number {
  const id = repo.createScan(db, [ROOT]);
  repo.insertFiles(db, id, files);
  repo.finishScan(db, id, {
    fileCount: files.length, dirCount: 1,
    storedBytes: files.reduce((n, f) => n + f.storedSize, 0),
    logicalBytes: files.reduce((n, f) => n + f.size, 0), errorCount: 0,
  });
  return id;
}

let db: any;
beforeEach(() => {
  db = openTestDb();
});
afterEach(() => db.close());

const get = (set: ReturnType<typeof computeRecommendations>, id: string) => set.recommendations.find((r) => r.id === id);
const fileNames = (id: number, rec: string, o = opts()) =>
  recommendationFiles(db, id, rec, o, 0, 100).files.map((f) => f.name);

describe('old installers', () => {
  it('lists installers not modified within the threshold, and nothing else', () => {
    const id = scanOf(db, [
      inv('Setup-old.exe', 80 * MB, 'installer', ago(8)),
      inv('Setup-new.exe', 90 * MB, 'installer', ago(1)),
      inv('old-doc.pdf', 5 * MB, 'document', ago(30)),
    ]);
    const rec = get(computeRecommendations(db, id, opts()), 'old-installers')!;
    expect(rec).toMatchObject({ file_count: 1, bytes: 80 * MB });
    expect(rec.basis).toMatch(/6 months/);
    expect(fileNames(id, 'old-installers')).toEqual(['Setup-old.exe']);
  });

  it('the age threshold is adjustable', () => {
    const id = scanOf(db, [inv('Setup.exe', 10 * MB, 'installer', ago(4))]);
    expect(get(computeRecommendations(db, id, opts(6)), 'old-installers')).toBeUndefined();
    expect(get(computeRecommendations(db, id, opts(3)), 'old-installers')?.file_count).toBe(1);
    expect(get(computeRecommendations(db, id, opts(3)), 'old-installers')?.basis).toMatch(/3 months/);
  });
});

describe('large old videos and archives', () => {
  it('needs both the size and the age', () => {
    const id = scanOf(db, [
      inv('big-old.mkv', LARGE_MEDIA_BYTES, 'video', ago(9)),
      inv('big-old.zip', LARGE_MEDIA_BYTES + 1, 'archive', ago(9)),
      inv('small-old.mkv', LARGE_MEDIA_BYTES - 1, 'video', ago(9)),
      inv('big-new.mkv', LARGE_MEDIA_BYTES * 2, 'video', ago(1)),
      inv('big-old.pdf', LARGE_MEDIA_BYTES * 2, 'document', ago(9)),
    ]);
    expect(fileNames(id, 'large-old-media').sort()).toEqual(['big-old.mkv', 'big-old.zip']);
  });
});

describe('old files in Downloads', () => {
  it('matches only files inside a folder named Downloads (any letter case) that are old', () => {
    const id = scanOf(db, [
      inv('Downloads/old.zip', 5, 'archive', ago(10)),
      inv('home/downloads/old.pdf', 5, 'document', ago(10)),
      inv('Downloads/new.pdf', 5, 'document', ago(1)),
      inv('Documents/old.pdf', 5, 'document', ago(10)),
      inv('Downloadsfolder/old.pdf', 5, 'document', ago(10)),
      inv('Downloads.txt', 5, 'document', ago(10)),
    ]);
    expect(fileNames(id, 'old-downloads').sort()).toEqual(['old.pdf', 'old.zip']);
  });
});

describe('very large files not modified in a year', () => {
  it('lists files of at least 1 GB untouched for 12 months, whatever the age setting', () => {
    const id = scanOf(db, [
      inv('disk.img', HUGE_FILE_BYTES, 'other', ago(14)),
      inv('recent.img', HUGE_FILE_BYTES * 2, 'other', ago(6)),
      inv('smaller.img', HUGE_FILE_BYTES - 1, 'other', ago(14)),
    ]);
    expect(fileNames(id, 'huge-stale', opts(3))).toEqual(['disk.img']);
    expect(fileNames(id, 'huge-stale', opts(24))).toEqual(['disk.img']);
  });
});

describe('archives that may already be extracted', () => {
  it('matches an archive beside a folder named like it, including .tar.gz', () => {
    const id = scanOf(db, [
      inv('backup.zip', 100, 'archive', ago(1)),
      inv('backup/data.txt', 1, 'document', ago(1)),
      inv('photos.tar.gz', 200, 'archive', ago(1)),
      inv('photos/deep/img.jpg', 1, 'image', ago(1)),
      inv('lonely.zip', 300, 'archive', ago(1)),
      inv('other.zip', 400, 'archive', ago(1)),
      inv('other2/file.txt', 1, 'document', ago(1)),
      inv('sub/backup.zip', 500, 'archive', ago(1)), // folder "backup" is NOT beside this one
    ]);
    const rec = get(computeRecommendations(db, id, opts()), 'extracted-archives')!;
    expect(rec.basis).toMatch(/guess/);
    expect(fileNames(id, 'extracted-archives').sort()).toEqual(['backup.zip', 'photos.tar.gz']);
    expect(rec.bytes).toBe(300);
  });
});

describe('quarantined files kept long enough', () => {
  const q = (daysAgo: number, name: string) =>
    inv(`FileFlow Quarantine/${quarantineStamp(new Date(NOW - daysAgo * DAY))}/bucket/${name}`, 50, 'document', ago(40));

  it('dates the batch from its folder name, not the file\'s own age', () => {
    const id = scanOf(db, [
      q(60, 'old.txt'),
      q(5, 'recent.txt'),
      inv('FileFlow Quarantine/not-a-stamp/x/odd.txt', 50, 'document', ago(40)),
    ]);
    expect(fileNames(id, 'old-quarantine')).toEqual(['old.txt']);
  });
});

describe('combined savings never count a file twice', () => {
  it('a file in several recommendations is counted once in the total', () => {
    // An old, huge video inside Downloads: matches old-downloads, large-old-media and huge-stale.
    const id = scanOf(db, [
      inv('Downloads/huge.mkv', 2 * HUGE_FILE_BYTES, 'video', ago(14)),
      inv('Downloads/Setup.exe', 100 * MB, 'installer', ago(10)),
      inv('plain-installer.exe', 50 * MB, 'installer', ago(10)),
    ]);
    const set = computeRecommendations(db, id, opts());
    const sum = set.recommendations.reduce((n, r) => n + r.bytes, 0);
    expect(set.total_files).toBe(3);
    expect(set.total_bytes).toBe(2 * HUGE_FILE_BYTES + 150 * MB);
    expect(sum).toBeGreaterThan(set.total_bytes); // each list on its own overlaps; the total does not
    expect(get(set, 'huge-stale')!.bytes).toBe(2 * HUGE_FILE_BYTES);
  });

  it('hard-linked data is counted once', () => {
    const id = scanOf(db, [
      inv('a.exe', 100, 'installer', ago(9), { links: 2 }),
      inv('b.exe', 100, 'installer', ago(9), { links: 2, storedSize: 0 }),
    ]);
    const set = computeRecommendations(db, id, opts());
    expect(set.total_bytes).toBe(100);
    expect(get(set, 'old-installers')).toMatchObject({ file_count: 2, bytes: 100 });
  });
});

describe('the set', () => {
  it('omits empty recommendations and sorts by space', () => {
    const id = scanOf(db, [inv('s.exe', 1 * MB, 'installer', ago(9)), inv('Downloads/x.bin', 9 * MB, 'other', ago(9))]);
    const set = computeRecommendations(db, id, opts());
    expect(set.recommendations.map((r) => r.id)).toEqual(['old-downloads', 'old-installers']);
    expect(set.old_months).toBe(6);
  });

  it('is empty for a scan with nothing to suggest', () => {
    const id = scanOf(db, [inv('fresh.txt', 5, 'document', NOW - DAY)]);
    expect(computeRecommendations(db, id, opts())).toMatchObject({ recommendations: [], total_files: 0, total_bytes: 0 });
  });

  it('never changes anything: computing twice gives the same answer', () => {
    const id = scanOf(db, [inv('s.exe', 1 * MB, 'installer', ago(9))]);
    expect(computeRecommendations(db, id, opts())).toEqual(computeRecommendations(db, id, opts()));
  });
});

describe('recommendationFiles', () => {
  it('pages the files, biggest first, with totals for the whole recommendation', () => {
    const id = scanOf(db, [
      inv('a.exe', 10, 'installer', ago(9)),
      inv('b.exe', 30, 'installer', ago(9)),
      inv('c.exe', 20, 'installer', ago(9)),
    ]);
    const p1 = recommendationFiles(db, id, 'old-installers', opts(), 0, 2);
    const p2 = recommendationFiles(db, id, 'old-installers', opts(), 2, 2);
    expect(p1.files.map((f) => f.name)).toEqual(['b.exe', 'c.exe']);
    expect(p2.files.map((f) => f.name)).toEqual(['a.exe']);
    expect(p1).toMatchObject({ total_count: 3, total_bytes: 60 });
  });

  it('rejects an unknown recommendation', () => {
    const id = scanOf(db, [inv('a.exe', 10, 'installer', ago(9))]);
    expect(() => recommendationFiles(db, id, 'nope', opts(), 0, 10)).toThrow(/Unknown recommendation/);
  });
});
