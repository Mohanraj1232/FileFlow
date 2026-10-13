import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { compileIgnore, parseIgnorePatterns } from './ignore';

const root = path.resolve('/watched');
const at = (...p: string[]) => path.join(root, ...p);

describe('parseIgnorePatterns', () => {
  it('parses a JSON array, drops blanks and non-strings', () => {
    expect(parseIgnorePatterns('["*.tmp", "", 5, "a/**"]')).toEqual(['*.tmp', 'a/**']);
  });

  it('tolerates missing, corrupt and non-array values', () => {
    expect(parseIgnorePatterns(undefined)).toEqual([]);
    expect(parseIgnorePatterns('')).toEqual([]);
    expect(parseIgnorePatterns('not json')).toEqual([]);
    expect(parseIgnorePatterns('{"a":1}')).toEqual([]);
  });
});

describe('compileIgnore', () => {
  it('matches nothing when there are no patterns', () => {
    expect(compileIgnore([])(at('a.tmp'), root)).toBe(false);
  });

  it('a slash-free pattern matches the file name at any depth, case-insensitively', () => {
    const ignored = compileIgnore(['*.tmp', '.DS_Store']);
    expect(ignored(at('a.tmp'), root)).toBe(true);
    expect(ignored(at('deep', 'er', 'B.TMP'), root)).toBe(true);
    expect(ignored(at('.ds_store'), root)).toBe(true);
    expect(ignored(at('a.pdf'), root)).toBe(false);
  });

  it('a slash-free pattern also excludes everything inside a matching folder', () => {
    const ignored = compileIgnore(['node_modules']);
    expect(ignored(at('proj', 'node_modules', 'x.js'), root)).toBe(true);
    expect(ignored(at('proj', 'src', 'x.js'), root)).toBe(false);
  });

  it('a pattern with a slash matches the path relative to the watched root', () => {
    const ignored = compileIgnore(['Backups/**', 'old/*.zip']);
    expect(ignored(at('Backups', 'a', 'b.txt'), root)).toBe(true);
    expect(ignored(at('old', 'x.zip'), root)).toBe(true);
    expect(ignored(at('other', 'old', 'x.zip'), root)).toBe(false);
  });
});
