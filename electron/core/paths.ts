import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { pathKey } from './planner';

/**
 * Locations FileFlow must never scan or modify: operating-system and
 * application-critical folders. Phase 5 builds the full path-validation layer
 * on top of this; the duplicate finder needs the basics now.
 */
function protectedRoots(): string[] {
  const roots: string[] = [];

  if (process.platform === 'win32') {
    const env = process.env;
    for (const v of [env.SystemRoot, env.windir, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramData]) {
      if (v) roots.push(v);
    }
  } else if (process.platform === 'darwin') {
    roots.push('/System', '/Library', '/usr', '/bin', '/sbin', '/private', '/cores');
  } else {
    roots.push('/etc', '/usr', '/bin', '/sbin', '/boot', '/proc', '/sys', '/dev', '/lib', '/lib64', '/run');
  }

  return roots;
}

/** Extra folders to treat as protected (the app's own data folder). */
const extraProtected: string[] = [];

/** Register the app's own data folder so it can never be scanned or modified. */
export function protectAppDataDir(dir: string): void {
  extraProtected.push(dir);
}

function isInside(child: string, parent: string): boolean {
  const c = pathKey(child);
  const p = pathKey(parent).replace(/\/+$/, '');
  return c === p || c.startsWith(p + '/');
}

/** True when `p` is, or is inside, an OS-critical or application-critical folder. */
export function isProtectedPath(p: string): boolean {
  const resolved = path.resolve(p);
  return [...protectedRoots(), ...extraProtected].some((root) => isInside(resolved, path.resolve(root)));
}

/** Folder names that hold system bookkeeping or already-removed files; never scanned. */
export const SKIPPED_SYSTEM_DIR_NAMES = new Set([
  '$RECYCLE.BIN',
  'System Volume Information',
  '.Trash',
  '.Trashes',
  '.Spotlight-V100',
  '.fseventsd',
  'lost+found',
]);

/** Name of the per-folder quarantine directory. Always excluded from scans. */
export const QUARANTINE_DIR_NAME = 'FileFlow Quarantine';

export interface SensitiveLocation {
  path: string;
  reason: string;
}

/**
 * Locations that are allowed but risky to scan wholesale: a drive/filesystem
 * root, the whole home folder, or a folder that holds credentials or app
 * data. The UI warns and asks for confirmation before scanning these.
 */
export function sensitiveReason(p: string): string | null {
  const resolved = path.resolve(p);
  if (path.parse(resolved).root === resolved) {
    return 'This is a whole drive. Scanning it can take a very long time and include files you did not mean to review.';
  }

  const home = os.homedir();
  if (pathKey(resolved) === pathKey(home)) {
    return 'This is your entire home folder, which includes application data and settings.';
  }

  const sensitiveNames = ['.ssh', '.gnupg', '.aws', '.config', 'AppData', 'Library'];
  for (const name of sensitiveNames) {
    if (isInside(resolved, path.join(home, name))) {
      return `This folder (${name}) holds application data or credentials. Duplicates here are usually intentional.`;
    }
  }
  return null;
}

export interface RootCheck {
  protected: string[];
  sensitive: SensitiveLocation[];
  missing: string[];
}

/** Classify the folders a user wants to scan before anything is read. */
export function checkRoots(roots: string[]): RootCheck {
  const result: RootCheck = { protected: [], sensitive: [], missing: [] };
  for (const root of roots) {
    let isDir = false;
    try {
      isDir = fs.statSync(root).isDirectory();
    } catch {
      /* missing or unreadable */
    }
    if (!isDir) {
      result.missing.push(root);
      continue;
    }
    if (isProtectedPath(root)) {
      result.protected.push(root);
      continue;
    }
    const reason = sensitiveReason(root);
    if (reason) result.sensitive.push({ path: root, reason });
  }
  return result;
}
