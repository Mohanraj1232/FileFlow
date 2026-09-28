const { ipcMain, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { getFileMeta } = require('./models');
const { evaluate } = require('./engine');
const { plan, buildSummary } = require('./planner');
const { executePlan } = require('./executor');
const journal = require('./journal');
const { undoOperation, undoStep } = require('./undo');
const {
  watchFolder,
  unwatchFolder,
  isWatchingEnabled,
  setWatchingEnabled,
} = require('./watcher');

/**
 * Recursively walk a directory, returning all file paths.
 */
function walkDir(dirPath: string, recursive: boolean): string[] {
  const results: string[] = [];

  let entries: any[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isFile()) {
      results.push(fullPath);
    } else if (entry.isDirectory() && recursive) {
      results.push(...walkDir(fullPath, true));
    }
  }

  return results;
}

/**
 * Load all rules from the database with their actions, parsing JSON conditions.
 */
function loadRules(db: any): any[] {
  const rules = db.prepare('SELECT * FROM rules ORDER BY priority ASC').all();

  for (const rule of rules) {
    const actions = db
      .prepare(
        'SELECT * FROM rule_actions WHERE rule_id = ? ORDER BY position ASC'
      )
      .all(rule.id);

    rule.actions = actions.map((a: any) => ({
      ...a,
      params: typeof a.params === 'string' ? JSON.parse(a.params) : a.params,
    }));

    rule.condition =
      typeof rule.condition === 'string'
        ? JSON.parse(rule.condition)
        : rule.condition;
  }

  return rules;
}

/**
 * Get conflict resolution policy from settings.
 */
function getConflictPolicy(db: any): string {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'conflict_default'")
    .get();
  return row ? row.value : 'auto_rename';
}

/**
 * Register all IPC handlers.
 */
function registerHandlers(db: any, recentlyWritten: any, watcher: any): void {
  // ===== Watched Folders =====

  ipcMain.handle('get_watched_folders', () => {
    return db.prepare('SELECT * FROM watched_folders ORDER BY id ASC').all();
  });

  ipcMain.handle(
    'add_watched_folder',
    (_event: any, folderPath: string, recursive: boolean) => {
      // Validate directory exists
      if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
        throw new Error(`Directory does not exist: ${folderPath}`);
      }

      const now = new Date().toISOString().slice(0, 19);
      const result = db
        .prepare(
          'INSERT INTO watched_folders (path, recursive, enabled, created_at) VALUES (?, ?, 1, ?)'
        )
        .run(folderPath, recursive ? 1 : 0, now);

      watchFolder(watcher, folderPath);

      return db
        .prepare('SELECT * FROM watched_folders WHERE id = ?')
        .get(result.lastInsertRowid);
    }
  );

  ipcMain.handle('remove_watched_folder', (_event: any, id: number) => {
    const folder = db
      .prepare('SELECT * FROM watched_folders WHERE id = ?')
      .get(id);

    db.prepare('DELETE FROM watched_folders WHERE id = ?').run(id);

    if (folder) {
      unwatchFolder(watcher, folder.path);
    }

    return { success: true };
  });

  ipcMain.handle(
    'toggle_watched_folder',
    (_event: any, id: number, enabled: boolean) => {
      db.prepare('UPDATE watched_folders SET enabled = ? WHERE id = ?').run(
        enabled ? 1 : 0,
        id
      );

      const folder = db
        .prepare('SELECT * FROM watched_folders WHERE id = ?')
        .get(id);

      if (folder) {
        if (enabled) {
          watchFolder(watcher, folder.path);
        } else {
          unwatchFolder(watcher, folder.path);
        }
      }

      return folder;
    }
  );

  // ===== Rules =====

  ipcMain.handle('get_rules', () => {
    return loadRules(db);
  });

  ipcMain.handle('create_rule', (_event: any, ruleData: any) => {
    const now = new Date().toISOString().slice(0, 19);
    const conditionStr =
      typeof ruleData.condition === 'string'
        ? ruleData.condition
        : JSON.stringify(ruleData.condition);

    const result = db
      .prepare(
        `INSERT INTO rules (name, enabled, priority, trigger_type, condition, stop_after, scope_folder, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ruleData.name,
        ruleData.enabled !== undefined ? (ruleData.enabled ? 1 : 0) : 1,
        ruleData.priority || 0,
        ruleData.trigger_type || 'arrival',
        conditionStr,
        ruleData.stop_after !== undefined ? (ruleData.stop_after ? 1 : 0) : 1,
        ruleData.scope_folder || null,
        now,
        now
      );

    const ruleId = result.lastInsertRowid;

    // Insert actions
    if (ruleData.actions && Array.isArray(ruleData.actions)) {
      const insertAction = db.prepare(
        'INSERT INTO rule_actions (rule_id, position, action_type, params) VALUES (?, ?, ?, ?)'
      );

      for (let i = 0; i < ruleData.actions.length; i++) {
        const action = ruleData.actions[i];
        const paramsStr =
          typeof action.params === 'string'
            ? action.params
            : JSON.stringify(action.params);
        insertAction.run(ruleId, i, action.action_type, paramsStr);
      }
    }

    // Return the created rule with actions
    const rules = loadRules(db);
    return rules.find((r: any) => r.id === ruleId);
  });

  ipcMain.handle('update_rule', (_event: any, ruleData: any) => {
    const now = new Date().toISOString().slice(0, 19);
    const conditionStr =
      typeof ruleData.condition === 'string'
        ? ruleData.condition
        : JSON.stringify(ruleData.condition);

    db.prepare(
      `UPDATE rules SET name = ?, enabled = ?, priority = ?, trigger_type = ?,
       condition = ?, stop_after = ?, scope_folder = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      ruleData.name,
      ruleData.enabled !== undefined ? (ruleData.enabled ? 1 : 0) : 1,
      ruleData.priority || 0,
      ruleData.trigger_type || 'arrival',
      conditionStr,
      ruleData.stop_after !== undefined ? (ruleData.stop_after ? 1 : 0) : 1,
      ruleData.scope_folder || null,
      now,
      ruleData.id
    );

    // Delete old actions and insert new ones
    db.prepare('DELETE FROM rule_actions WHERE rule_id = ?').run(ruleData.id);

    if (ruleData.actions && Array.isArray(ruleData.actions)) {
      const insertAction = db.prepare(
        'INSERT INTO rule_actions (rule_id, position, action_type, params) VALUES (?, ?, ?, ?)'
      );

      for (let i = 0; i < ruleData.actions.length; i++) {
        const action = ruleData.actions[i];
        const paramsStr =
          typeof action.params === 'string'
            ? action.params
            : JSON.stringify(action.params);
        insertAction.run(ruleData.id, i, action.action_type, paramsStr);
      }
    }

    const rules = loadRules(db);
    return rules.find((r: any) => r.id === ruleData.id);
  });

  ipcMain.handle('delete_rule', (_event: any, id: number) => {
    db.prepare('DELETE FROM rules WHERE id = ?').run(id);
    return { success: true };
  });

  ipcMain.handle(
    'toggle_rule',
    (_event: any, id: number, enabled: boolean) => {
      const now = new Date().toISOString().slice(0, 19);
      db.prepare(
        'UPDATE rules SET enabled = ?, updated_at = ? WHERE id = ?'
      ).run(enabled ? 1 : 0, now, id);
      const rules = loadRules(db);
      return rules.find((r: any) => r.id === id);
    }
  );

  ipcMain.handle('reorder_rules', (_event: any, ruleIds: number[]) => {
    const now = new Date().toISOString().slice(0, 19);
    const updateStmt = db.prepare(
      'UPDATE rules SET priority = ?, updated_at = ? WHERE id = ?'
    );

    const reorder = db.transaction(() => {
      for (let i = 0; i < ruleIds.length; i++) {
        updateStmt.run(i, now, ruleIds[i]);
      }
    });

    reorder();
    return loadRules(db);
  });

  // ===== Rule Testing & Preview =====

  ipcMain.handle(
    'test_rule',
    async (_event: any, filename: string, ruleId: number | null) => {
      // Build a mock FileMeta from the filename
      const parsed = path.parse(filename);
      const ext = parsed.ext.replace(/^\./, '').toLowerCase();
      const { extensionToKind } = require('./models');

      const mockMeta = {
        name: parsed.name,
        extension: ext,
        size: 0,
        mtime: new Date(),
        kind: extensionToKind(ext),
        path: filename,
        sourceFolder: parsed.dir || '.',
      };

      let rules: any[];
      if (ruleId) {
        rules = loadRules(db).filter((r: any) => r.id === ruleId);
      } else {
        rules = loadRules(db);
      }

      const result = await evaluate(mockMeta, rules, 'arrival');
      if (result) {
        return {
          matched: true,
          rule: { id: result.rule.id, name: result.rule.name },
          actions: result.actions.map((a: any) => ({
            action_type: a.action_type,
            params: a.params,
          })),
        };
      }
      return { matched: false, rule: null, actions: [] };
    }
  );

  ipcMain.handle(
    'preview_folder',
    async (_event: any, folderId: number) => {
      const folder = db
        .prepare('SELECT * FROM watched_folders WHERE id = ?')
        .get(folderId);

      if (!folder) throw new Error(`Folder not found: ${folderId}`);

      const files = walkDir(folder.path, !!folder.recursive);
      const rules = loadRules(db);
      const conflictPolicy = getConflictPolicy(db);
      const existingFiles = new Set<string>();

      const allSteps: any[] = [];
      let unmatchedCount = 0;

      for (const filePath of files) {
        let fileMeta;
        try {
          fileMeta = getFileMeta(filePath);
        } catch {
          continue; // Skip files we can't stat
        }

        const result = await evaluate(fileMeta, rules, 'arrival');
        if (result) {
          const steps = plan(
            fileMeta,
            result.rule,
            result.actions,
            existingFiles,
            conflictPolicy
          );
          allSteps.push(...steps);
        } else {
          unmatchedCount++;
        }
      }

      return buildSummary(allSteps, unmatchedCount, files.length);
    }
  );

  ipcMain.handle(
    'apply_plan',
    async (
      _event: any,
      folderId: number,
      selectedPaths: string[] | null
    ) => {
      const folder = db
        .prepare('SELECT * FROM watched_folders WHERE id = ?')
        .get(folderId);

      if (!folder) throw new Error(`Folder not found: ${folderId}`);

      let files = walkDir(folder.path, !!folder.recursive);

      // Filter to selected paths if provided
      if (selectedPaths && selectedPaths.length > 0) {
        const selectedSet = new Set(
          selectedPaths.map((p: string) => p.replace(/\\/g, '/'))
        );
        files = files.filter((f) => selectedSet.has(f.replace(/\\/g, '/')));
      }

      const rules = loadRules(db);
      const conflictPolicy = getConflictPolicy(db);
      const existingFiles = new Set<string>();
      const allSteps: any[] = [];

      for (const filePath of files) {
        let fileMeta;
        try {
          fileMeta = getFileMeta(filePath);
        } catch {
          continue;
        }

        const result = await evaluate(fileMeta, rules, 'arrival');
        if (result) {
          const steps = plan(
            fileMeta,
            result.rule,
            result.actions,
            existingFiles,
            conflictPolicy
          );
          allSteps.push(...steps);
        }
      }

      if (allSteps.length === 0) {
        return { operationId: null, stepsExecuted: 0, message: 'No files matched any rules' };
      }

      const operationId = await executePlan(
        db,
        allSteps,
        `manual:folder:${folderId}`,
        recentlyWritten
      );

      const operation = db
        .prepare('SELECT * FROM operations WHERE id = ?')
        .get(operationId);

      return {
        operationId,
        stepsExecuted: allSteps.length,
        operation,
      };
    }
  );

  // ===== Operations & Journal =====

  ipcMain.handle(
    'get_operations',
    (_event: any, limit: number = 50, offset: number = 0) => {
      return journal.getOperations(db, limit, offset);
    }
  );

  ipcMain.handle(
    'get_operation_steps',
    (_event: any, operationId: number) => {
      return journal.getOperationSteps(db, operationId);
    }
  );

  // ===== Undo =====

  ipcMain.handle('undo_operation', async (_event: any, operationId: number) => {
    return await undoOperation(db, operationId);
  });

  ipcMain.handle('undo_step', async (_event: any, stepId: number) => {
    return await undoStep(db, stepId);
  });

  // ===== Unsorted Files =====

  ipcMain.handle(
    'get_unsorted_files',
    async (_event: any, folderId: number) => {
      const folder = db
        .prepare('SELECT * FROM watched_folders WHERE id = ?')
        .get(folderId);

      if (!folder) throw new Error(`Folder not found: ${folderId}`);

      const files = walkDir(folder.path, !!folder.recursive);
      const rules = loadRules(db);
      const unsorted: any[] = [];

      for (const filePath of files) {
        let fileMeta;
        try {
          fileMeta = getFileMeta(filePath);
        } catch {
          continue;
        }

        const result = await evaluate(fileMeta, rules, 'arrival');
        if (!result) {
          unsorted.push(fileMeta);
        }
      }

      return unsorted;
    }
  );

  // ===== Dashboard Stats =====

  ipcMain.handle('get_dashboard_stats', () => {
    const totalFolders = db
      .prepare('SELECT COUNT(*) as count FROM watched_folders')
      .get().count;
    const activeFolders = db
      .prepare(
        'SELECT COUNT(*) as count FROM watched_folders WHERE enabled = 1'
      )
      .get().count;
    const totalRules = db
      .prepare('SELECT COUNT(*) as count FROM rules')
      .get().count;
    const activeRules = db
      .prepare('SELECT COUNT(*) as count FROM rules WHERE enabled = 1')
      .get().count;
    const totalOperations = db
      .prepare('SELECT COUNT(*) as count FROM operations')
      .get().count;
    const filesToday = journal.countDoneStepsToday(db);
    const filesWeek = journal.countDoneStepsWeek(db);

    const recentOps = journal.getOperations(db, 5, 0);

    return {
      totalFolders,
      activeFolders,
      totalRules,
      activeRules,
      totalOperations,
      filesToday,
      filesWeek,
      recentOperations: recentOps,
    };
  });

  // ===== Settings =====

  ipcMain.handle('get_settings', () => {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const settings: Record<string, string> = {};
    for (const row of rows) {
      settings[row.key] = row.value;
    }
    return settings;
  });

  ipcMain.handle(
    'update_setting',
    (_event: any, key: string, value: string) => {
      db.prepare(
        'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'
      ).run(key, value);
      return { success: true };
    }
  );

  // ===== Watching Control =====

  ipcMain.handle('start_watching', () => {
    setWatchingEnabled(true);
    return { watching: true };
  });

  ipcMain.handle('stop_watching', () => {
    setWatchingEnabled(false);
    return { watching: false };
  });

  ipcMain.handle('get_watching_status', () => {
    return { watching: isWatchingEnabled() };
  });

  // ===== Dialog =====

  ipcMain.handle('show_open_dialog', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  });
}

module.exports = { registerHandlers };
