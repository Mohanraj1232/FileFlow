import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { isProtectedPath, sensitiveReason, checkRoots, protectAppDataDir } from './paths';
import { makeTmpTree } from '../test/helpers';

describe('isProtectedPath', () => {
  it('protects the operating system folders', () => {
    if (process.platform === 'win32') {
      const windir = process.env.SystemRoot ?? 'C:\\Windows';
      expect(isProtectedPath(windir)).toBe(true);
      expect(isProtectedPath(path.join(windir, 'System32', 'drivers'))).toBe(true);
      expect(isProtectedPath(process.env.ProgramFiles ?? 'C:\\Program Files')).toBe(true);
    } else if (process.platform === 'darwin') {
      expect(isProtectedPath('/System/Library')).toBe(true);
      expect(isProtectedPath('/usr/bin')).toBe(true);
    } else {
      expect(isProtectedPath('/etc')).toBe(true);
      expect(isProtectedPath('/usr/lib/x')).toBe(true);
    }
  });

  it('does not protect ordinary user folders', () => {
    expect(isProtectedPath(makeTmpTree())).toBe(false);
    expect(isProtectedPath(path.join(os.homedir(), 'Documents'))).toBe(false);
  });

  it('is not fooled by a similarly named sibling folder', () => {
    const dir = makeTmpTree({ 'guard/': '', 'guard-not/': '' });
    protectAppDataDir(path.join(dir, 'guard'));
    expect(isProtectedPath(path.join(dir, 'guard', 'inner', 'file.txt'))).toBe(true);
    expect(isProtectedPath(path.join(dir, 'guard-not', 'file.txt'))).toBe(false);
  });

  it('resolves ".." so a path cannot sneak into a protected folder', () => {
    const dir = makeTmpTree({ 'guard2/': '', 'other/': '' });
    protectAppDataDir(path.join(dir, 'guard2'));
    expect(isProtectedPath(path.join(dir, 'other', '..', 'guard2', 'x'))).toBe(true);
  });
});

describe('sensitiveReason', () => {
  it('flags a whole drive / filesystem root', () => {
    expect(sensitiveReason(path.parse(os.homedir()).root)).toMatch(/whole drive/);
  });

  it('flags the whole home folder but not folders inside it', () => {
    expect(sensitiveReason(os.homedir())).toMatch(/home folder/);
    expect(sensitiveReason(path.join(os.homedir(), 'Downloads'))).toBeNull();
    expect(sensitiveReason(path.join(os.homedir(), 'Documents', 'Photos'))).toBeNull();
  });

  it('flags folders that hold credentials or application data', () => {
    expect(sensitiveReason(path.join(os.homedir(), '.ssh'))).toMatch(/credentials/);
    expect(sensitiveReason(path.join(os.homedir(), 'AppData', 'Local', 'x'))).toMatch(/application data/);
  });

  it('accepts an ordinary folder', () => {
    expect(sensitiveReason(makeTmpTree())).toBeNull();
  });
});

describe('checkRoots', () => {
  it('sorts folders into protected, sensitive, missing and fine', () => {
    const ok = makeTmpTree();
    const missing = path.join(ok, 'nope');
    const file = path.join(makeTmpTree({ 'f.txt': 'x' }), 'f.txt'); // a file is not a folder
    const protectedDir = makeTmpTree({ 'p/': '' });
    protectAppDataDir(path.join(protectedDir, 'p'));

    const result = checkRoots([ok, missing, file, path.join(protectedDir, 'p'), os.homedir()]);
    expect(result.missing).toEqual([missing, file]);
    expect(result.protected).toEqual([path.join(protectedDir, 'p')]);
    expect(result.sensitive.map((s) => s.path)).toEqual([os.homedir()]);
  });
});
