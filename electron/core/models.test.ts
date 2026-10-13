import { describe, it, expect } from 'vitest';
import { extensionToKind, getFileMeta } from './models';
import { makeTmpTree } from '../test/helpers';
import path from 'node:path';

describe('extensionToKind', () => {
  const cases: [string, string][] = [
    // documents
    ['pdf', 'document'], ['docx', 'document'], ['txt', 'document'], ['md', 'document'],
    ['csv', 'document'], ['epub', 'document'], ['log', 'document'],
    // images
    ['jpg', 'image'], ['png', 'image'], ['svg', 'image'], ['heic', 'image'], ['psd', 'image'],
    // video
    ['mp4', 'video'], ['mkv', 'video'], ['mov', 'video'], ['mts', 'video'], ['m2ts', 'video'],
    // audio
    ['mp3', 'audio'], ['flac', 'audio'], ['wav', 'audio'],
    // archives
    ['zip', 'archive'], ['7z', 'archive'], ['tar', 'archive'], ['gz', 'archive'], ['iso', 'archive'],
    // programming files
    ['py', 'code'], ['java', 'code'], ['js', 'code'], ['tsx', 'code'], ['rs', 'code'],
    ['json', 'code'], ['yml', 'code'], ['sql', 'code'],
    // installers
    ['exe', 'installer'], ['msi', 'installer'], ['deb', 'installer'], ['apk', 'installer'],
  ];

  it.each(cases)('.%s is %s', (ext, kind) => {
    expect(extensionToKind(ext)).toBe(kind);
  });

  it('classifies .ts as TypeScript code, not video', () => {
    expect(extensionToKind('ts')).toBe('code');
    expect(extensionToKind('TS')).toBe('code');
  });

  it('classifies .dmg as an installer, not a generic archive', () => {
    expect(extensionToKind('dmg')).toBe('installer');
  });

  it('is case-insensitive and tolerates a leading dot', () => {
    expect(extensionToKind('.PDF')).toBe('document');
    expect(extensionToKind('Mp3')).toBe('audio');
  });

  it('returns "other" for unknown, empty, and prototype-named extensions', () => {
    expect(extensionToKind('xyz123')).toBe('other');
    expect(extensionToKind('')).toBe('other');
    expect(extensionToKind('constructor')).toBe('other');
    expect(extensionToKind('__proto__')).toBe('other');
  });
});

describe('getFileMeta', () => {
  it('reads name, extension, size and folder from a real file', () => {
    const root = makeTmpTree({ 'Report.Final.PDF': 'hello' });
    const meta = getFileMeta(path.join(root, 'Report.Final.PDF'));
    expect(meta.name).toBe('Report.Final');
    expect(meta.extension).toBe('pdf');
    expect(meta.kind).toBe('document');
    expect(meta.size).toBe(5);
    expect(meta.sourceFolder).toBe(root);
  });

  it('defaults watchRoot to the containing folder and honours an explicit one', () => {
    const root = makeTmpTree({ 'sub/a.txt': 'x' });
    const file = path.join(root, 'sub', 'a.txt');
    expect(getFileMeta(file).watchRoot).toBe(path.join(root, 'sub'));
    expect(getFileMeta(file, root).watchRoot).toBe(root);
  });

  it('handles files without an extension', () => {
    const root = makeTmpTree({ Makefile: 'all:' });
    const meta = getFileMeta(path.join(root, 'Makefile'));
    expect(meta.extension).toBe('');
    expect(meta.kind).toBe('other');
  });
});
