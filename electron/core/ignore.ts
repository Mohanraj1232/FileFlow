import path from 'node:path';
import picomatch from 'picomatch';

/**
 * Parse the stored `ignore_patterns` setting (a JSON array of glob strings).
 * Tolerates a missing or corrupt value by returning no patterns.
 */
export function parseIgnorePatterns(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((p): p is string => typeof p === 'string');
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((p): p is string => typeof p === 'string' && p.trim() !== '')
      : [];
  } catch {
    return [];
  }
}

/**
 * Compile glob patterns into a predicate `(filePath, root) => boolean`.
 *
 *  - A pattern without a slash ("*.tmp", ".DS_Store") matches any path segment's
 *    name, so it also excludes everything inside a matching folder.
 *  - A pattern with a slash ("old/**", "Backups/*.zip") matches the path
 *    relative to the watched root.
 * Matching is case-insensitive and treats dotfiles like any other file.
 */
export function compileIgnore(patterns: string[]): (filePath: string, root: string) => boolean {
  const cleaned = patterns.map((p) => p.trim()).filter(Boolean);
  if (cleaned.length === 0) return () => false;

  const compiled = cleaned.map((pattern) => ({
    hasSlash: pattern.includes('/') || pattern.includes('\\'),
    test: picomatch(pattern.replace(/\\/g, '/'), { nocase: true, dot: true }),
  }));

  return (filePath, root) => {
    const rel = path.relative(root, filePath).replace(/\\/g, '/');
    // A file outside the root (or the root itself) is never matched by relative patterns.
    const segments = rel && !rel.startsWith('..') ? rel.split('/') : [path.basename(filePath)];

    return compiled.some(({ hasSlash, test }) =>
      hasSlash ? test(rel) : segments.some((seg) => test(seg))
    );
  };
}
