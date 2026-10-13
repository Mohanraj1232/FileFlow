import { describe, it, expect } from 'vitest';
import type { DuplicateFile, DuplicateGroup } from '../../lib/types';
import {
  pickKeeper,
  marksToKeepOnly,
  autoSelect,
  canMark,
  keptCount,
  summarize,
  buildDecisions,
  pruneMarks,
} from './selection';

function file(path: string, modified: string, copyId: number): DuplicateFile {
  return { path, name: path.split('/').pop()!, size: 100, modified_at: modified, hash_status: 'verified', copy_id: copyId };
}

function group(hash: string, size: number, files: DuplicateFile[]): DuplicateGroup {
  const copies = new Set(files.map((f) => f.copy_id)).size;
  return {
    hash,
    size,
    file_count: files.length,
    copies,
    total_size: size * copies,
    reclaimable_bytes: size * (copies - 1),
    files: files.map((f) => ({ ...f, size })),
  };
}

const g1 = group('h1', 100, [
  file('/a/old.txt', '2020-01-01T00:00:00.000Z', 1),
  file('/a/mid-long-name.txt', '2022-01-01T00:00:00.000Z', 2),
  file('/n.txt', '2024-01-01T00:00:00.000Z', 3),
]);
const g2 = group('h2', 50, [
  file('/b/x.bin', '2021-01-01T00:00:00.000Z', 1),
  file('/b/y.bin', '2023-01-01T00:00:00.000Z', 2),
]);

describe('pickKeeper', () => {
  it('oldest / newest / shortest path', () => {
    expect(pickKeeper(g1, 'oldest').path).toBe('/a/old.txt');
    expect(pickKeeper(g1, 'newest').path).toBe('/n.txt');
    expect(pickKeeper(g1, 'shortest_path').path).toBe('/n.txt');
  });

  it('is stable on ties', () => {
    const tie = group('t', 10, [file('/z.txt', '2020-01-01T00:00:00.000Z', 1), file('/a.txt', '2020-01-01T00:00:00.000Z', 2)]);
    expect(pickKeeper(tie, 'oldest').path).toBe('/a.txt');
  });
});

describe('marking', () => {
  it('keeps only the chosen file', () => {
    expect(marksToKeepOnly(g1, '/n.txt').sort()).toEqual(['/a/mid-long-name.txt', '/a/old.txt']);
    expect(marksToKeepOnly(g1, '/nope.txt')).toEqual([]);
  });

  it('never marks a hard link of the file being kept', () => {
    const linked = group('h3', 100, [file('/k.txt', '2020-01-01T00:00:00.000Z', 1), file('/link-of-k.txt', '2020-01-01T00:00:00.000Z', 1), file('/other.txt', '2021-01-01T00:00:00.000Z', 2)]);
    expect(marksToKeepOnly(linked, '/k.txt')).toEqual(['/other.txt']);
  });

  it('auto-select applies one rule to every group', () => {
    const marks = autoSelect([g1, g2], 'oldest');
    expect([...marks].sort()).toEqual(['/a/mid-long-name.txt', '/b/y.bin', '/n.txt']);
  });

  it('the last kept file cannot be marked', () => {
    const marks = new Set(['/a/old.txt', '/a/mid-long-name.txt']);
    expect(keptCount(g1, marks)).toBe(1);
    expect(canMark(g1, marks, '/n.txt')).toBe(false); // would remove every copy
    expect(canMark(g1, marks, '/a/old.txt')).toBe(true); // un-marking is always allowed
    expect(canMark(g1, new Set(), '/n.txt')).toBe(true);
  });
});

describe('summary and decisions', () => {
  it('counts files, groups and space freed', () => {
    const marks = new Set(['/a/old.txt', '/a/mid-long-name.txt', '/b/y.bin']);
    expect(summarize([g1, g2], marks)).toEqual({ files: 3, groups: 2, bytes: 100 * 2 + 50 });
  });

  it('counts nothing for hard links of a kept file, and a shared copy once', () => {
    const linked = group('h3', 100, [
      file('/k.txt', '2020-01-01T00:00:00.000Z', 1),
      file('/link-of-k.txt', '2020-01-01T00:00:00.000Z', 1),
      file('/o1.txt', '2021-01-01T00:00:00.000Z', 2),
      file('/o2-hardlink.txt', '2021-01-01T00:00:00.000Z', 2),
    ]);
    // remove both links of copy 2 -> frees 100 once; removing link-of-k frees nothing
    const marks = new Set(['/o1.txt', '/o2-hardlink.txt', '/link-of-k.txt']);
    expect(summarize([linked], marks)).toEqual({ files: 3, groups: 1, bytes: 100 });
  });

  it('is empty when nothing is marked', () => {
    expect(summarize([g1, g2], new Set())).toEqual({ files: 0, groups: 0, bytes: 0 });
    expect(buildDecisions([g1, g2], new Set())).toEqual([]);
  });

  it('builds one decision per affected group, listing the files to KEEP', () => {
    const marks = new Set(['/a/old.txt', '/a/mid-long-name.txt']);
    expect(buildDecisions([g1, g2], marks)).toEqual([{ hash: 'h1', keep: ['/n.txt'] }]);
  });

  it('every decision keeps at least one file when marks respect canMark', () => {
    const marks = autoSelect([g1, g2], 'newest');
    for (const d of buildDecisions([g1, g2], marks)) expect(d.keep.length).toBeGreaterThanOrEqual(1);
  });
});

describe('pruneMarks', () => {
  it('forgets marks for files that are no longer listed', () => {
    const pruned = pruneMarks([g2], new Set(['/a/old.txt', '/b/y.bin']));
    expect([...pruned]).toEqual(['/b/y.bin']);
  });
});
