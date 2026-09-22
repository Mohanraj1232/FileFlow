const fs = require('node:fs');
const path = require('node:path');

type FileKind =
  | 'document'
  | 'image'
  | 'video'
  | 'audio'
  | 'archive'
  | 'code'
  | 'installer'
  | 'other';

interface FileMetaInfo {
  name: string;
  extension: string;
  size: number;
  mtime: Date;
  kind: FileKind;
  path: string;
  sourceFolder: string;
}

const KIND_MAP: Record<string, FileKind> = {
  // Documents
  pdf: 'document',
  doc: 'document',
  docx: 'document',
  xls: 'document',
  xlsx: 'document',
  ppt: 'document',
  pptx: 'document',
  odt: 'document',
  ods: 'document',
  odp: 'document',
  rtf: 'document',
  txt: 'document',
  csv: 'document',
  tsv: 'document',
  md: 'document',
  tex: 'document',
  epub: 'document',
  mobi: 'document',
  pages: 'document',
  numbers: 'document',
  keynote: 'document',
  wpd: 'document',
  wps: 'document',
  log: 'document',

  // Images
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  gif: 'image',
  bmp: 'image',
  svg: 'image',
  webp: 'image',
  ico: 'image',
  tiff: 'image',
  tif: 'image',
  psd: 'image',
  ai: 'image',
  eps: 'image',
  raw: 'image',
  cr2: 'image',
  nef: 'image',
  heic: 'image',
  heif: 'image',
  avif: 'image',
  jxl: 'image',

  // Video
  mp4: 'video',
  mkv: 'video',
  avi: 'video',
  mov: 'video',
  wmv: 'video',
  flv: 'video',
  webm: 'video',
  m4v: 'video',
  mpg: 'video',
  mpeg: 'video',
  '3gp': 'video',
  ts: 'video',
  vob: 'video',

  // Audio
  mp3: 'audio',
  wav: 'audio',
  flac: 'audio',
  aac: 'audio',
  ogg: 'audio',
  wma: 'audio',
  m4a: 'audio',
  opus: 'audio',
  aiff: 'audio',
  alac: 'audio',
  mid: 'audio',
  midi: 'audio',
  ape: 'audio',

  // Archives
  zip: 'archive',
  rar: 'archive',
  '7z': 'archive',
  tar: 'archive',
  gz: 'archive',
  bz2: 'archive',
  xz: 'archive',
  zst: 'archive',
  lz: 'archive',
  cab: 'archive',
  iso: 'archive',
  dmg: 'archive',
  tgz: 'archive',

  // Code
  js: 'code',
  jsx: 'code',
  // Note: .ts is listed under video (transport stream); for code detection
  // rely on the kind map order — but we handle .ts in code context separately.
  tsx: 'code',
  py: 'code',
  rb: 'code',
  java: 'code',
  c: 'code',
  cpp: 'code',
  h: 'code',
  hpp: 'code',
  cs: 'code',
  go: 'code',
  rs: 'code',
  swift: 'code',
  kt: 'code',
  scala: 'code',
  php: 'code',
  html: 'code',
  htm: 'code',
  css: 'code',
  scss: 'code',
  sass: 'code',
  less: 'code',
  json: 'code',
  xml: 'code',
  yaml: 'code',
  yml: 'code',
  toml: 'code',
  ini: 'code',
  cfg: 'code',
  sh: 'code',
  bat: 'code',
  ps1: 'code',
  sql: 'code',
  r: 'code',
  lua: 'code',
  pl: 'code',
  dart: 'code',
  vue: 'code',
  svelte: 'code',

  // Installers
  exe: 'installer',
  msi: 'installer',
  deb: 'installer',
  rpm: 'installer',
  appimage: 'installer',
  pkg: 'installer',
  apk: 'installer',
  snap: 'installer',
  flatpak: 'installer',
};

function extensionToKind(ext: string): FileKind {
  const normalized = ext.toLowerCase().replace(/^\./, '');
  return KIND_MAP[normalized] || 'other';
}

function getFileMeta(filePath: string): FileMetaInfo {
  const stat = fs.statSync(filePath);
  const parsed = path.parse(filePath);
  const ext = parsed.ext.replace(/^\./, '').toLowerCase();

  return {
    name: parsed.name,
    extension: ext,
    size: stat.size,
    mtime: stat.mtime,
    kind: extensionToKind(ext),
    path: filePath,
    sourceFolder: parsed.dir,
  };
}

module.exports = { extensionToKind, getFileMeta };
// Re-export types via declaration for TypeScript consumers
export type { FileKind, FileMetaInfo };
