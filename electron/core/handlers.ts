import { ipcMain, dialog } from 'electron';
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
import { parseIgnorePatterns } from './ignore';
import { normalizePolicy } from './planner';
import type { DashboardStats, TestRuleResult } from '../shared/contract';

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
}
