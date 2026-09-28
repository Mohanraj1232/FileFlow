const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { initDb } = require('./core/db');
const { recoverPending } = require('./core/executor');
const { registerHandlers } = require('./core/handlers');
const {
  RecentlyWritten,
  createWatcher,
  watchFolder,
  unwatchFolder,
  shouldIgnoreFile,
  isFileStable,
  isWatchingEnabled,
  setWatchingEnabled,
} = require('./core/watcher');
const { getFileMeta } = require('./core/models');
const { evaluate } = require('./core/engine');
const { plan } = require('./core/planner');
const { executePlan } = require('./core/executor');

let mainWindow: any = null;
let db: any = null;
let watcher: any = null;
let recentlyWritten: any = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'FileFlow',
    show: false,
  });

  // Show window when ready to prevent visual flash
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Dev vs production loading
  if (!app.isPackaged && process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

/**
 * Handle a new file detected by the watcher.
 */
async function handleWatchedFile(filePath: string): Promise<void> {
  if (!isWatchingEnabled() || !db) return;

  // Skip files written by FileFlow itself
  if (recentlyWritten && recentlyWritten.contains(filePath)) return;

  // Skip temp/ignored files
  if (shouldIgnoreFile(filePath)) return;

  // Wait for file to stabilize
  const stable = await isFileStable(filePath);
  if (!stable) return;

  try {
    const fileMeta = getFileMeta(filePath);

    // Load rules from DB
    const rules = db
      .prepare('SELECT * FROM rules ORDER BY priority ASC')
      .all()
      .map((rule: any) => {
        const actions = db
          .prepare(
            'SELECT * FROM rule_actions WHERE rule_id = ? ORDER BY position ASC'
          )
          .all(rule.id)
          .map((a: any) => ({
            ...a,
            params:
              typeof a.params === 'string' ? JSON.parse(a.params) : a.params,
          }));

        return {
          ...rule,
          condition:
            typeof rule.condition === 'string'
              ? JSON.parse(rule.condition)
              : rule.condition,
          actions,
        };
      });

    const result = await evaluate(fileMeta, rules, 'arrival');
    if (!result) return;

    // Get conflict policy
    const settingRow = db
      .prepare("SELECT value FROM settings WHERE key = 'conflict_default'")
      .get();
    const conflictPolicy = settingRow ? settingRow.value : 'auto_rename';

    const existingFiles = new Set<string>();
    const steps = plan(
      fileMeta,
      result.rule,
      result.actions,
      existingFiles,
      conflictPolicy
    );

    if (steps.length > 0) {
      await executePlan(db, steps, 'watcher', recentlyWritten);

      // Notify the renderer about the operation
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('file-processed', {
          path: filePath,
          rule: result.rule.name,
          actions: steps.length,
        });
      }
    }
  } catch (err) {
    console.error(`Error processing watched file ${filePath}:`, err);
  }
}

/**
 * Initialize and start watching all enabled folders.
 */
function startWatchingFolders(): void {
  if (!db) return;

  recentlyWritten = new RecentlyWritten(30000);

  watcher = createWatcher(handleWatchedFile);

  const folders = db
    .prepare('SELECT * FROM watched_folders WHERE enabled = 1')
    .all();

  for (const folder of folders) {
    watchFolder(watcher, folder.path);
  }

  setWatchingEnabled(true);

  // Periodic cleanup of recently written entries
  setInterval(() => {
    if (recentlyWritten) {
      recentlyWritten.cleanup();
    }
  }, 60000);
}

// ===== App lifecycle =====

app.whenReady().then(() => {
  // Initialize database
  const userDataPath = app.getPath('userData');
  db = initDb(userDataPath);

  // Recover any pending operations from a previous crash
  recoverPending(db);

  // Initialize the recently written tracker
  recentlyWritten = new RecentlyWritten(30000);

  // Start file watching (creates `watcher`, needed by registerHandlers below)
  startWatchingFolders();

  // Register all IPC handlers
  registerHandlers(db, recentlyWritten, watcher);

  // Create the main window
  createWindow();

  // macOS: re-create window when dock icon clicked
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // On macOS, apps typically stay active until Cmd+Q
  if (process.platform !== 'darwin') {
    // Clean up watcher
    if (watcher) {
      watcher.close();
    }
    // Close database
    if (db) {
      db.close();
    }
    app.quit();
  }
});

app.on('before-quit', () => {
  if (watcher) {
    watcher.close();
  }
  if (db) {
    db.close();
  }
});
