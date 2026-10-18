import { ipcMain, dialog, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { extensionToKind } from './models';
import { evaluate, type Rule as EngineRule } from './engine';
import { expandVariables, expandRenamePattern } from './planner';
import * as journal from './journal';
import { undoOperation, undoStep } from './undo';
import {
  isWatchingEnabled,
  setWatchingEnabled,
  type WatcherManager,
  type RecentlyWritten,
} from './watcher';
import * as repo from './rules-repo';
import {
  toRuleDto,
  toWatchedFolderDto,
  toSettingsDto,
  type RuleInput,
} from './dto';
import {
  previewFolder,
  applyPlan,
  getUnsortedFiles,
  PlanCache,
  type FolderRow,
} from './organizer';
import { parseIgnorePatterns, compileIgnore } from './ignore';
import { checkRoots } from './paths';
import { DuplicateScanStore } from './duplicates/store';
import { resolveDuplicates, InvalidDecisionError, type Decision } from './duplicates/resolve';
import { toSummaryDto, toGroupDto } from './duplicates/dto';
import { StorageScanStore } from './storage/store';
import * as storage from './storage/service';
import { runningToSummary } from './storage/dto';
import * as storageRepo from './storage/repo';
import { cleanupFiles, InvalidCleanupError } from './storage/cleanup';
import { normalizePolicy } from './planner';
import type {
  DashboardStats,
  TestRuleResult,
  DuplicateScanOptions,
  DuplicateGroupsPage,
  ResolveDuplicatesResult,
  StorageCleanupResult,
} from '../shared/contract';

const SETTING_KEYS = [
  'conflict_default',
  'notification_level',
  'theme',
  'scan_schedule_minutes',
  'ignore_patterns',
] as const;

function getFolder(db: any, id: number): FolderRow {
  const folder = db.prepare('SELECT * FROM watched_folders WHERE id = ?').get(id);
  if (!folder) throw new Error(`Folder not found: ${id}`);
  return folder;
}

/** Validate a setting before it is stored, so a bad value can't poison later scans. */
function validateSetting(key: string, value: string): string {
  if (!(SETTING_KEYS as readonly string[]).includes(key)) {
    throw new Error(`Unknown setting: ${key}`);
  }
  switch (key) {
    case 'conflict_default':
      return normalizePolicy(value);
    case 'notification_level':
      if (!['all', 'batched', 'errors_only', 'none'].includes(value)) {
        throw new Error(`Invalid notification level: ${value}`);
      }
      return value;
    case 'theme':
      if (!['light', 'dark', 'system'].includes(value)) throw new Error(`Invalid theme: ${value}`);
      return value;
    case 'scan_schedule_minutes': {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 1 || n > 10080) throw new Error('Invalid scan schedule');
      return String(Math.round(n));
    }
    case 'ignore_patterns':
      return JSON.stringify(parseIgnorePatterns(value));
    default:
      return value;
  }
}

const MAX_SCAN_ROOTS = 20;

/** Validate the folder list sent by the renderer: strings only, absolute, unique. */
function validateRoots(roots: unknown): string[] {
  if (!Array.isArray(roots) || roots.length === 0) throw new Error('Choose at least one folder to scan.');
  if (roots.length > MAX_SCAN_ROOTS) throw new Error(`Choose at most ${MAX_SCAN_ROOTS} folders.`);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of roots) {
    if (typeof r !== 'string' || !r.trim()) throw new Error('Invalid folder path.');
    const abs = path.resolve(r);
    const key = process.platform === 'win32' || process.platform === 'darwin' ? abs.toLowerCase() : abs;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(abs);
    }
  }
  return out;
}

function validateDecisions(decisions: unknown): Decision[] {
  if (!Array.isArray(decisions) || decisions.length === 0) throw new Error('Nothing selected to remove.');
  return decisions.map((d: any) => {
    if (!d || typeof d.hash !== 'string' || !Array.isArray(d.keep) || d.keep.some((k: unknown) => typeof k !== 'string')) {
      throw new Error('Invalid selection.');
    }
    return { hash: d.hash, keep: d.keep as string[] };
  });
}

/** Evaluate a file *name* against rules, without touching any file. */
async function testRuleAgainst(
  filename: string,
  rules: EngineRule[]
): Promise<TestRuleResult> {
  const parsed = path.parse(filename);
  const ext = parsed.ext.replace(/^\./, '').toLowerCase();
  const mockMeta = {
    name: parsed.name,
    extension: ext,
    size: 0,
    mtime: new Date(),
    kind: extensionToKind(ext),
    path: filename,
    sourceFolder: parsed.dir || '.',
    // Left literal so the result reads "{root}/Documents" rather than a made-up path.
    watchRoot: '{root}',
  };

  const result = await evaluate(mockMeta, rules, 'any');
  if (!result) return { matched: false };

  const out: TestRuleResult = {
    matched: true,
    rule_id: result.rule.id,
    rule_name: result.rule.name,
  };
  for (const action of result.actions) {
    const params = action.params ?? {};
    if (!out.destination && (action.action_type === 'move' || action.action_type === 'copy') && params.destination) {
      out.destination = path.join(expandVariables(params.destination, mockMeta), parsed.base);
    }
    if (action.action_type === 'rename' && !out.new_name) {
      const newName = expandRenamePattern(params.pattern || params.name || '{name}.{ext}', mockMeta);
      const pattern = String(params.pattern || '{name}.{ext}');
      out.new_name =
        !pattern.includes('{ext}') && ext && !newName.endsWith(`.${ext}`) ? `${newName}.${ext}` : newName;
    }
  }
  return out;
}

/**
 * Register all IPC handlers.
 */
export function registerHandlers(
  db: any,
  recentlyWritten: RecentlyWritten,
  watchers: WatcherManager,
  getMainWindow: () => any
): void {
  const planCache = new PlanCache();
  const dupStore = new DuplicateScanStore();
  const storageStore = new StorageScanStore();

  // ===== Watched Folders =====

  ipcMain.handle('get_watched_folders', () => {
    return db
      .prepare('SELECT * FROM watched_folders ORDER BY id ASC')
      .all()
      .map(toWatchedFolderDto);
  });

  ipcMain.handle(
    'add_watched_folder',
    (_event, folderPath: string, recursive: boolean) => {
      if (typeof folderPath !== 'string' || !folderPath) throw new Error('A folder path is required');
      if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
        throw new Error(`Directory does not exist: ${folderPath}`);
      }

      const existing = db.prepare('SELECT id FROM watched_folders WHERE path = ?').get(folderPath);
      if (existing) throw new Error('That folder is already being watched');

      const now = new Date().toISOString().slice(0, 19);
      const result = db
        .prepare(
          'INSERT INTO watched_folders (path, recursive, enabled, created_at) VALUES (?, ?, 1, ?)'
        )
        .run(folderPath, recursive ? 1 : 0, now);

      const row = db
        .prepare('SELECT * FROM watched_folders WHERE id = ?')
        .get(result.lastInsertRowid);
      watchers.add({ id: row.id, path: row.path, recursive: !!row.recursive });
      return toWatchedFolderDto(row);
    }
  );

  ipcMain.handle('remove_watched_folder', async (_event, id: number) => {
    const folder = db.prepare('SELECT * FROM watched_folders WHERE id = ?').get(id);
    db.prepare('DELETE FROM watched_folders WHERE id = ?').run(id);
    if (folder) await watchers.remove(folder.path);
    return { success: true };
  });

  ipcMain.handle('toggle_watched_folder', async (_event, id: number, enabled: boolean) => {
    db.prepare('UPDATE watched_folders SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    const folder = db.prepare('SELECT * FROM watched_folders WHERE id = ?').get(id);
    if (folder) {
      if (enabled) {
        watchers.add({ id: folder.id, path: folder.path, recursive: !!folder.recursive });
      } else {
        await watchers.remove(folder.path);
      }
    }
    return folder ? toWatchedFolderDto(folder) : null;
  });

  // ===== Rules =====

  ipcMain.handle('get_rules', () => repo.loadRules(db).map(toRuleDto));

  ipcMain.handle('create_rule', (_event, ruleData: RuleInput) => {
    const id = repo.createRule(db, ruleData);
    return toRuleDto(repo.getRule(db, id)!);
  });

  ipcMain.handle('update_rule', (_event, ruleData: RuleInput & { id: number }) => {
    const id = repo.updateRule(db, ruleData);
    return toRuleDto(repo.getRule(db, id)!);
  });

  ipcMain.handle('delete_rule', (_event, id: number) => {
    repo.deleteRule(db, id);
    return { success: true };
  });

  ipcMain.handle('toggle_rule', (_event, id: number, enabled: boolean) => {
    repo.setRuleEnabled(db, id, enabled);
    const rule = repo.getRule(db, id);
    return rule ? toRuleDto(rule) : null;
  });

  ipcMain.handle('reorder_rules', (_event, ruleIds: number[]) => {
    repo.reorderRules(db, ruleIds);
    return repo.loadRules(db).map(toRuleDto);
  });

  // ===== Rule Testing & Preview =====

  ipcMain.handle(
    'test_rule',
    async (_event, filename: string, ruleId: number | null, draft?: RuleInput) => {
      let rules: EngineRule[];
      if (draft) {
        // Test an unsaved rule exactly as the builder currently shows it.
        rules = [
          {
            id: draft.id ?? 0,
            name: draft.name || 'Unsaved rule',
            enabled: 1,
            priority: 0,
            trigger_type: 'both',
            condition: draft.condition as any,
            stop_after: 1,
            scope_folder: null,
            actions: (draft.actions ?? []).map((a, i) => ({
              id: i,
              rule_id: draft.id ?? 0,
              position: i,
              action_type: a.action_type,
              params: typeof a.params === 'string' ? JSON.parse(a.params) : a.params,
            })),
          },
        ];
      } else {
        rules = repo.loadRules(db);
        if (ruleId) rules = rules.filter((r) => r.id === ruleId);
      }
      return testRuleAgainst(filename, rules);
    }
  );

  ipcMain.handle('preview_folder', async (_event, folderId: number) => {
    return previewFolder(db, getFolder(db, folderId), planCache);
  });

  ipcMain.handle(
    'apply_plan',
    async (_event, folderId: number, planId: string, selectedFileKeys: string[] | null) => {
      return applyPlan(
        db,
        getFolder(db, folderId),
        planId,
        selectedFileKeys,
        planCache,
        recentlyWritten
      );
    }
  );

  // ===== Operations & Journal =====

  ipcMain.handle('get_operations', (_event, limit: number = 50, offset: number = 0) => {
    return journal.getOperations(db, limit, offset);
  });

  ipcMain.handle('get_operation_steps', (_event, operationId: number) => {
    return journal.getOperationSteps(db, operationId);
  });

  // ===== Undo =====

  ipcMain.handle('undo_operation', (_event, operationId: number) =>
    undoOperation(db, operationId, recentlyWritten)
  );

  ipcMain.handle('undo_step', (_event, stepId: number) =>
    undoStep(db, stepId, recentlyWritten)
  );

  // ===== Unsorted Files =====

  ipcMain.handle('get_unsorted_files', (_event, folderId: number) => {
    return getUnsortedFiles(db, getFolder(db, folderId));
  });

  // ===== Dashboard Stats =====

  ipcMain.handle('get_dashboard_stats', (): DashboardStats => {
    const count = (sql: string) => db.prepare(sql).get().count as number;
    return {
      files_organized_today: journal.countDoneStepsToday(db),
      files_organized_week: journal.countDoneStepsWeek(db),
      active_rules: count('SELECT COUNT(*) as count FROM rules WHERE enabled = 1'),
      watched_folders: count('SELECT COUNT(*) as count FROM watched_folders'),
      recent_operations: journal.getOperations(db, 5, 0),
    };
  });

  // ===== Settings =====

  ipcMain.handle('get_settings', () => {
    return toSettingsDto(db.prepare('SELECT key, value FROM settings').all());
  });

  ipcMain.handle('update_setting', (_event, key: string, value: string) => {
    const clean = validateSetting(key, String(value));
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, clean);
    return { success: true };
  });

  // ===== Watching Control =====

  ipcMain.handle('start_watching', () => {
    setWatchingEnabled(true);
    return { watching: true };
  });

  ipcMain.handle('stop_watching', () => {
    setWatchingEnabled(false);
    return { watching: false };
  });

  ipcMain.handle('get_watching_status', () => ({ watching: isWatchingEnabled() }));

  // ===== Title Bar =====

  ipcMain.handle('set_title_bar_theme', (_event, isDark: boolean) => {
    const win = getMainWindow();
    // macOS uses hiddenInset (native traffic lights); overlay only
    // applies on Windows/Linux where we draw the min/max/close area.
    if (win && typeof win.setTitleBarOverlay === 'function') {
      win.setTitleBarOverlay({
        color: isDark ? '#010409' : '#ffffff',
        symbolColor: isDark ? '#8b949e' : '#656d76',
        height: 40,
      });
    }
    return { success: true };
  });

  // ===== Dialog =====

  ipcMain.handle('show_open_dialog', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // ===== Duplicate finder =====

  const pushProgress = (entry: Parameters<typeof toSummaryDto>[0]) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('duplicate-progress', toSummaryDto(entry));
  };

  const getScan = (scanId: unknown) => {
    const entry = typeof scanId === 'string' ? dupStore.get(scanId) : undefined;
    if (!entry) throw new Error('That scan is no longer available. Run a new scan.');
    return entry;
  };

  ipcMain.handle('check_scan_roots', (_event, roots: string[]) => checkRoots(validateRoots(roots)));

  ipcMain.handle('start_duplicate_scan', (_event, roots: string[], options?: DuplicateScanOptions) => {
    const list = validateRoots(roots);
    const check = checkRoots(list);
    if (check.missing.length) throw new Error(`Folder not found: ${check.missing[0]}`);
    if (check.protected.length) {
      throw new Error(`FileFlow does not scan system folders: ${check.protected.join(', ')}`);
    }
    if (check.sensitive.length && !options?.confirm_sensitive) {
      throw new Error(`Confirmation required to scan: ${check.sensitive.map((s) => s.path).join(', ')}`);
    }

    const minSize = Number(options?.min_size);
    const entry = dupStore.start({
      roots: list,
      db,
      minSize: Number.isFinite(minSize) && minSize >= 1 ? Math.floor(minSize) : 1,
      includeHidden: !!options?.include_hidden,
      isIgnored: compileIgnore(parseIgnorePatterns(repo.getSetting(db, 'ignore_patterns'))),
      onUpdate: pushProgress,
    });
    return toSummaryDto(entry);
  });

  ipcMain.handle('get_duplicate_scan', (_event, scanId: string) => toSummaryDto(getScan(scanId)));

  ipcMain.handle(
    'get_duplicate_groups',
    (_event, scanId: string, offset: number = 0, limit: number = 50): DuplicateGroupsPage => {
      const entry = getScan(scanId);
      if (entry.state !== 'done' || !entry.result) throw new Error('This scan has no results to show.');
      const start = Math.max(0, Math.floor(Number(offset)) || 0);
      const size = Math.min(200, Math.max(1, Math.floor(Number(limit)) || 50));
      return {
        groups: entry.result.groups.slice(start, start + size).map(toGroupDto),
        total_groups: entry.result.groups.length,
        offset: start,
      };
    }
  );

  ipcMain.handle('cancel_duplicate_scan', (_event, scanId: string) => ({
    cancelled: dupStore.cancel(String(scanId)),
  }));

  ipcMain.handle(
    'resolve_duplicates',
    async (_event, scanId: string, decisions: unknown, mode: string): Promise<ResolveDuplicatesResult> => {
      const entry = getScan(scanId);
      try {
        const out = await resolveDuplicates(
          db,
          entry,
          validateDecisions(decisions),
          mode as 'quarantine' | 'trash',
          recentlyWritten
        );
        return {
          operation:
            out.operationId === null
              ? null
              : db.prepare('SELECT * FROM operations WHERE id = ?').get(out.operationId),
          removed_count: out.removed.length,
          reclaimed_bytes: out.reclaimedBytes,
          skipped: out.skipped,
        };
      } catch (err) {
        if (err instanceof InvalidDecisionError) throw new Error(err.message);
        throw err;
      }
    }
  );

  // Only files this scan actually found can be revealed: the renderer cannot ask to open arbitrary paths.
  ipcMain.handle('reveal_duplicate_file', (_event, scanId: string, filePath: string) => {
    const entry = getScan(scanId);
    const known = entry.result?.groups.some((g) => g.files.some((f) => f.path === filePath));
    if (!known) throw new Error('That file is not part of this scan.');
    shell.showItemInFolder(filePath);
    return { success: true };
  });

  // ===== Storage analysis =====

  const pushStorageProgress = (scan: Parameters<typeof runningToSummary>[0]) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('storage-progress', runningToSummary(scan));
  };

  const scanIdOf = (value: unknown): number => {
    const id = Number(value);
    if (!Number.isInteger(id) || id < 1) throw new Error('That scan is no longer available. Run a new scan.');
    return id;
  };

  ipcMain.handle('storage_list_scans', () => storage.listSummaries(db, storageStore));

  ipcMain.handle(
    'storage_start_scan',
    (_event, roots: string[], options?: { include_hidden?: boolean; confirm_sensitive?: boolean }) => {
      const list = validateRoots(roots);
      const check = checkRoots(list);
      if (check.missing.length) throw new Error(`Folder not found: ${check.missing[0]}`);
      if (check.protected.length) {
        throw new Error(`FileFlow does not scan system folders: ${check.protected.join(', ')}`);
      }
      if (check.sensitive.length && !options?.confirm_sensitive) {
        throw new Error(`Confirmation required to scan: ${check.sensitive.map((s) => s.path).join(', ')}`);
      }
      const scan = storageStore.start({
        db,
        roots: list,
        includeHidden: options?.include_hidden !== false,
        isIgnored: compileIgnore(parseIgnorePatterns(repo.getSetting(db, 'ignore_patterns'))),
        onUpdate: pushStorageProgress,
      });
      return runningToSummary(scan);
    }
  );

  ipcMain.handle('storage_get_scan', (_event, scanId: number) =>
    storage.getSummary(db, storageStore, scanIdOf(scanId))
  );

  ipcMain.handle('storage_cancel_scan', (_event, scanId: number) => ({
    cancelled: storageStore.cancel(scanIdOf(scanId)),
  }));

  ipcMain.handle('storage_delete_scan', (_event, scanId: number) => {
    const id = scanIdOf(scanId);
    if (storageStore.get(id)?.state === 'running') throw new Error('Cancel the scan before deleting it.');
    storageRepo.deleteScan(db, id);
    return { success: true };
  });

  ipcMain.handle('storage_get_report', (_event, scanId: number, folder?: string | null) =>
    storage.buildReport(db, scanIdOf(scanId), typeof folder === 'string' && folder ? folder : null)
  );

  ipcMain.handle(
    'storage_query_files',
    (_event, scanId: number, filter: unknown, sort: unknown, offset: unknown, limit: unknown) =>
      storage.filesPage(db, scanIdOf(scanId), filter, sort, offset, limit)
  );

  ipcMain.handle('storage_get_recommendations', (_event, scanId: number, oldMonths?: number) =>
    storage.recommendations(db, scanIdOf(scanId), oldMonths)
  );

  ipcMain.handle(
    'storage_get_recommendation_files',
    (_event, scanId: number, recommendationId: string, oldMonths: unknown, offset: unknown, limit: unknown) =>
      storage.recommendationPage(db, scanIdOf(scanId), recommendationId, oldMonths, offset, limit)
  );

  ipcMain.handle('storage_get_duplicate_savings', (_event, scanId: number) =>
    storage.duplicateSavings(db, scanIdOf(scanId), dupStore)
  );

  ipcMain.handle(
    'storage_cleanup',
    async (_event, scanId: number, paths: unknown, mode: string): Promise<StorageCleanupResult> => {
      const row = storageRepo.getScan(db, scanIdOf(scanId));
      if (!row) throw new Error('That scan is no longer available. Run a new scan.');
      try {
        const out = await cleanupFiles(db, row, paths, mode as 'quarantine' | 'trash', recentlyWritten);
        return {
          operation:
            out.operationId === null
              ? null
              : db.prepare('SELECT * FROM operations WHERE id = ?').get(out.operationId),
          removed_count: out.removed.length,
          reclaimed_bytes: out.reclaimedBytes,
          skipped: out.skipped,
        };
      } catch (err) {
        if (err instanceof InvalidCleanupError) throw new Error(err.message);
        throw err;
      }
    }
  );

  // Only files this scan recorded can be revealed: the renderer cannot ask to open arbitrary paths.
  ipcMain.handle('storage_reveal', (_event, scanId: number, filePath: string) => {
    const known = typeof filePath === 'string' && storageRepo.getFilesByPaths(db, scanIdOf(scanId), [filePath]).has(filePath);
    if (!known) throw new Error('That file is not part of this scan.');
    shell.showItemInFolder(filePath);
    return { success: true };
  });
}
