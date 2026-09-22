const fs = require('node:fs');
const path = require('node:path');

interface FileMeta {
  name: string;
  extension: string;
  size: number;
  mtime: Date;
  kind: string;
  path: string;
  sourceFolder: string;
}

interface RuleAction {
  id: number;
  rule_id: number;
  position: number;
  action_type: string;
  params: any;
}

interface Rule {
  id: number;
  name: string;
  priority: number;
  [key: string]: any;
}

interface PlannedStep {
  ruleId: number;
  ruleName: string;
  actionType: string;
  srcPath: string;
  dstPath: string | null;
  fileSize: number;
  fileMtime: string;
}

interface PlanSummary {
  totalFiles: number;
  matchedFiles: number;
  unmatchedFiles: number;
  steps: PlannedStep[];
  byAction: Record<string, number>;
  byRule: Record<string, number>;
}

/**
 * Strip common junk suffixes from a filename.
 * Removes patterns like " (1)", "_final", "- copy", "copy", "(copy)".
 */
function cleanFilename(name: string): string {
  let cleaned = name;
  // Remove " (1)", " (2)", etc.
  cleaned = cleaned.replace(/\s*\(\d+\)\s*$/g, '');
  // Remove "_final", "-final", " final"
  cleaned = cleaned.replace(/[\s_-]*final\s*$/gi, '');
  // Remove "- copy", " - copy", "_copy", " copy"
  cleaned = cleaned.replace(/[\s_-]*copy\s*$/gi, '');
  // Remove "(copy)", "( copy )"
  cleaned = cleaned.replace(/\s*\(\s*copy\s*\)\s*$/gi, '');
  // Remove " - Copy", " - Copy (2)" (Windows pattern)
  cleaned = cleaned.replace(/\s*-\s*Copy(\s*\(\d+\))?\s*$/gi, '');
  return cleaned.trim();
}

/**
 * Convert a string to a URL-friendly slug.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Expand template variables in a destination path string.
 */
function expandVariables(template: string, fileMeta: FileMeta): string {
  const mtime = fileMeta.mtime instanceof Date ? fileMeta.mtime : new Date(fileMeta.mtime);
  const year = String(mtime.getFullYear());
  const month = String(mtime.getMonth() + 1).padStart(2, '0');
  const day = String(mtime.getDate()).padStart(2, '0');

  let result = template;
  result = result.replace(/\{kind\}/g, fileMeta.kind);
  result = result.replace(/\{ext\}/g, fileMeta.extension);
  result = result.replace(/\{name\}/g, fileMeta.name);
  result = result.replace(/\{year\}/g, year);
  result = result.replace(/\{month\}/g, month);
  result = result.replace(/\{date:YYYY-MM-DD\}/g, `${year}-${month}-${day}`);
  result = result.replace(/\{date:YYYY-MM\}/g, `${year}-${month}`);
  result = result.replace(/\{date:YYYY\}/g, year);
  result = result.replace(/\{date\}/g, `${year}-${month}-${day}`);

  return result;
}

/**
 * Expand rename pattern variables.
 */
function expandRenamePattern(pattern: string, fileMeta: FileMeta): string {
  const mtime = fileMeta.mtime instanceof Date ? fileMeta.mtime : new Date(fileMeta.mtime);
  const year = String(mtime.getFullYear());
  const month = String(mtime.getMonth() + 1).padStart(2, '0');
  const day = String(mtime.getDate()).padStart(2, '0');

  let result = pattern;
  result = result.replace(/\{name:clean\}/g, cleanFilename(fileMeta.name));
  result = result.replace(/\{name:lower\}/g, fileMeta.name.toLowerCase());
  result = result.replace(/\{name:slug\}/g, slugify(fileMeta.name));
  result = result.replace(/\{name\}/g, fileMeta.name);
  result = result.replace(/\{ext\}/g, fileMeta.extension);
  result = result.replace(/\{kind\}/g, fileMeta.kind);
  result = result.replace(/\{date\}/g, `${year}-${month}-${day}`);

  return result;
}

/**
 * Resolve a filename conflict by appending an incrementing number.
 * Checks both the existingFiles set and the filesystem.
 */
function resolveConflict(
  destPath: string,
  existingFiles: Set<string>,
  policy: string
): string {
  if (policy !== 'auto_rename') {
    return destPath;
  }

  const normalized = destPath.replace(/\\/g, '/');
  if (!existingFiles.has(normalized) && !fs.existsSync(destPath)) {
    return destPath;
  }

  const parsed = path.parse(destPath);
  let counter = 2;
  let candidate: string;

  do {
    candidate = path.join(parsed.dir, `${parsed.name} (${counter})${parsed.ext}`);
    counter++;
  } while (
    existingFiles.has(candidate.replace(/\\/g, '/')) ||
    fs.existsSync(candidate)
  );

  return candidate;
}

/**
 * Generate a plan of steps for a single file against a matched rule.
 */
function plan(
  fileMeta: FileMeta,
  rule: Rule,
  actions: any[],
  existingFiles: Set<string>,
  conflictPolicy: string = 'auto_rename'
): PlannedStep[] {
  const steps: PlannedStep[] = [];

  // Track the current path of the file as actions may chain (move then rename)
  let currentPath = fileMeta.path;

  for (const action of actions) {
    const params =
      typeof action.params === 'string'
        ? JSON.parse(action.params)
        : action.params;

    switch (action.action_type) {
      case 'move': {
        const destFolder = expandVariables(params.destination, fileMeta);
        const fileName = path.basename(currentPath);
        let destPath = path.join(destFolder, fileName);
        destPath = resolveConflict(destPath, existingFiles, conflictPolicy);

        // Track destination to prevent future conflicts
        existingFiles.add(destPath.replace(/\\/g, '/'));

        steps.push({
          ruleId: rule.id,
          ruleName: rule.name,
          actionType: 'move',
          srcPath: currentPath,
          dstPath: destPath,
          fileSize: fileMeta.size,
          fileMtime: (fileMeta.mtime instanceof Date ? fileMeta.mtime : new Date(fileMeta.mtime)).toISOString().slice(0, 19),
        });

        currentPath = destPath;
        break;
      }

      case 'copy': {
        const destFolder = expandVariables(params.destination, fileMeta);
        const fileName = path.basename(currentPath);
        let destPath = path.join(destFolder, fileName);
        destPath = resolveConflict(destPath, existingFiles, conflictPolicy);

        existingFiles.add(destPath.replace(/\\/g, '/'));

        steps.push({
          ruleId: rule.id,
          ruleName: rule.name,
          actionType: 'copy',
          srcPath: currentPath,
          dstPath: destPath,
          fileSize: fileMeta.size,
          fileMtime: (fileMeta.mtime instanceof Date ? fileMeta.mtime : new Date(fileMeta.mtime)).toISOString().slice(0, 19),
        });
        // copy does not change currentPath
        break;
      }

      case 'rename': {
        const pattern = params.pattern || params.name || '{name}.{ext}';
        const newName = expandRenamePattern(pattern, fileMeta);
        const ext = fileMeta.extension ? `.${fileMeta.extension}` : '';

        // If the pattern already includes an extension placeholder, don't double-add
        let finalName = newName;
        if (!pattern.includes('{ext}') && ext && !newName.endsWith(ext)) {
          finalName = newName + ext;
        }

        const dir = path.dirname(currentPath);
        let destPath = path.join(dir, finalName);
        destPath = resolveConflict(destPath, existingFiles, conflictPolicy);

        existingFiles.add(destPath.replace(/\\/g, '/'));

        steps.push({
          ruleId: rule.id,
          ruleName: rule.name,
          actionType: 'rename',
          srcPath: currentPath,
          dstPath: destPath,
          fileSize: fileMeta.size,
          fileMtime: (fileMeta.mtime instanceof Date ? fileMeta.mtime : new Date(fileMeta.mtime)).toISOString().slice(0, 19),
        });

        currentPath = destPath;
        break;
      }

      case 'trash': {
        steps.push({
          ruleId: rule.id,
          ruleName: rule.name,
          actionType: 'trash',
          srcPath: currentPath,
          dstPath: null,
          fileSize: fileMeta.size,
          fileMtime: (fileMeta.mtime instanceof Date ? fileMeta.mtime : new Date(fileMeta.mtime)).toISOString().slice(0, 19),
        });
        break;
      }
    }
  }

  return steps;
}

/**
 * Build a summary of the plan across all files.
 */
function buildSummary(
  steps: PlannedStep[],
  unmatchedCount: number,
  totalFiles: number
): PlanSummary {
  const byAction: Record<string, number> = {};
  const byRule: Record<string, number> = {};

  for (const step of steps) {
    byAction[step.actionType] = (byAction[step.actionType] || 0) + 1;
    byRule[step.ruleName] = (byRule[step.ruleName] || 0) + 1;
  }

  // Count unique source files that have steps
  const matchedPaths = new Set(steps.map((s) => s.srcPath));

  return {
    totalFiles,
    matchedFiles: matchedPaths.size,
    unmatchedFiles: unmatchedCount,
    steps,
    byAction,
    byRule,
  };
}

module.exports = {
  plan,
  buildSummary,
  expandVariables,
  expandRenamePattern,
  cleanFilename,
  slugify,
  resolveConflict,
};
