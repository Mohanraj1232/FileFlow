import { describe, it, expect } from 'vitest';
import {
  percent,
  monthsAgoIso,
  buildFilter,
  hasActiveFilter,
  EMPTY_FILTER,
  crumbs,
  rootsLabel,
  selectionTotals,
  OLD_MONTH_CHOICES,
  KIND_LABELS,
  KIND_COLORS,
} from './logic';

describe('percent', () => {
  it('is a whole percentage, clamped, and safe for an empty total', () => {
    expect(percent(25, 100)).toBe(25);
    expect(percent(1, 3)).toBe(33);
    expect(percent(5, 0)).toBe(0);
    expect(percent(150, 100)).toBe(100);
    expect(percent(-5, 100)).toBe(0);
  });
});

describe('buildFilter', () => {
  const now = Date.UTC(2026, 9, 18);

  it('adds nothing for blank controls', () => {
    expect(buildFilter(EMPTY_FILTER, now)).toEqual({});
    expect(hasActiveFilter(EMPTY_FILTER)).toBe(false);
  });

  it('translates every control', () => {
    const f = buildFilter(
      { folder: '/a', kind: 'video', ext: ' .MP4 ', minSize: 1024, olderThanMonths: 6, name: ' clip ' },
      now
    );
    expect(f).toEqual({
      folder: '/a', kinds: ['video'], ext: 'MP4', min_size: 1024, name_contains: 'clip',
      modified_before: monthsAgoIso(6, now),
    });
    expect(hasActiveFilter({ ...EMPTY_FILTER, name: 'x' })).toBe(true);
  });

  it('"not changed in N months" is a date N months in the past', () => {
    const iso = monthsAgoIso(12, now);
    const days = (now - Date.parse(iso)) / (24 * 3600 * 1000);
    expect(days).toBeGreaterThan(364);
    expect(days).toBeLessThan(367);
  });

  it('whitespace-only text controls count as blank', () => {
    expect(buildFilter({ ...EMPTY_FILTER, ext: '  ', name: '   ' }, now)).toEqual({});
    expect(hasActiveFilter({ ...EMPTY_FILTER, ext: '  ', name: '   ' })).toBe(false);
  });
});

describe('crumbs', () => {
  it('starts at the top level', () => {
    expect(crumbs(null, ['C:\\data'])).toEqual([{ label: 'All folders', path: null }]);
  });

  it('builds a trail from the containing root, on Windows paths', () => {
    expect(crumbs('C:\\data\\a\\b', ['C:\\data'])).toEqual([
      { label: 'All folders', path: null },
      { label: 'C:\\data', path: 'C:\\data' },
      { label: 'a', path: 'C:\\data\\a' },
      { label: 'b', path: 'C:\\data\\a\\b' },
    ]);
  });

  it('and on POSIX paths', () => {
    expect(crumbs('/home/me/data/x', ['/home/me/data']).map((c) => c.path)).toEqual([null, '/home/me/data', '/home/me/data/x']);
  });

  it('picks the most specific root, ignores trailing separators and letter case', () => {
    const trail = crumbs('/Data/Sub/x', ['/data', '/data/sub/']);
    expect(trail[1].path).toBe('/data/sub/');
    expect(trail.map((c) => c.label)).toEqual(['All folders', '/data/sub/', 'x']);
  });

  it('a root itself is just the root; a folder outside every root shows as is', () => {
    expect(crumbs('/d', ['/d']).map((c) => c.path)).toEqual([null, '/d']);
    expect(crumbs('/elsewhere', ['/d'])).toEqual([{ label: 'All folders', path: null }, { label: '/elsewhere', path: '/elsewhere' }]);
  });

  it('does not treat a sibling with a shared prefix as inside the root', () => {
    expect(crumbs('/data2/x', ['/data']).map((c) => c.path)).toEqual([null, '/data2/x']);
  });
});

describe('small helpers', () => {
  it('rootsLabel', () => {
    expect(rootsLabel(['C:\\Users\\me\\Downloads'])).toBe('Downloads');
    expect(rootsLabel(['/a/Photos', '/b/Docs', '/c/X'])).toBe('Photos +2 more');
    expect(rootsLabel([])).toBe('');
    expect(rootsLabel(['/'])).toBe('/');
  });

  it('selectionTotals sums the selected files', () => {
    expect(selectionTotals(new Map([['a', 10], ['b', 5]]))).toEqual({ files: 2, bytes: 15 });
    expect(selectionTotals(new Map())).toEqual({ files: 0, bytes: 0 });
  });

  it('every kind has a label and a colour', () => {
    expect(Object.keys(KIND_LABELS).sort()).toEqual(Object.keys(KIND_COLORS).sort());
    expect(KIND_LABELS.other).toBe('Other');
  });

  it('the cleanup thresholds are the ones the backend accepts', () => {
    expect(OLD_MONTH_CHOICES).toEqual([1, 3, 6, 12, 24]);
  });
});
