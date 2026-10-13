import { app, BrowserWindow, Menu } from 'electron';
import path from 'node:path';
import { initDb } from './core/db';
import { recoverPending } from './core/executor';
import { registerHandlers } from './core/handlers';
import {
  RecentlyWritten,
  WatcherManager,
  setWatchingEnabled,
  type WatchTarget,
} from './core/watcher';
import { processWatchedFile } from './core/pipeline';
import { loadRules, getSetting } from './core/rules-repo';
import { managedDirs, isInManagedDir } from './core/planner';
import { compileIgnore, parseIgnorePatterns } from './core/ignore';
import { protectAppDataDir } from './core/paths';
import type { FileProcessedEvent } from './shared/contract';

let mainWindow: BrowserWindow | null = null;
let db: any = null;
let watchers: WatcherManager | null = null;
let recentlyWritten: RecentlyWritten | null = null;
let cleanupTimer: NodeJS.Timeout | null = null;

function createWindow(): void {
  // Ship without the default Electron dev menu (reload/toggle devtools/etc)
  // in production; keep it in dev for debugging convenience.
  if (app.isPackaged) {
    Menu.setApplicationMenu(null);
  }

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0d1117',
    // Custom title bar: the renderer draws its own 40px bar (src/app/TitleBar.tsx)
    // and the OS overlays real min/max/close controls into it, so window
    // management (Snap Layouts, accessibility, etc) still works natively.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay:
      process.platform === 'darwin'
        ? undefined
        : { color: '#010409', symbolColor: '#8b949e', height: 40 },
    trafficLightPosition:
      process.platform === 'darwin' ? { x: 16, y: 12 } : undefined,
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
    mainWindow?.show();
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
async function handleWatchedFile(filePath: string, folder: WatchTarget): Promise<void> {
  if (!db || !recentlyWritten) return;

  try {
    const done = await processWatchedFile({ db, recentlyWritten }, filePath, folder);
    if (done && mainWindow && !mainWindow.isDestroyed()) {
      const event: FileProcessedEvent = {
        path: filePath,
        rule: done.ruleName,
        actions: done.steps,
        operation_id: done.operationId,
      };
      mainWindow.webContents.send('file-processed', event);
    }
  } catch (err) {
    console.error(`Error processing watched file ${filePath}:`, err);
  }
}

/**
 * Keep the watcher out of folders FileFlow fills itself and out of anything
 * the user told it to ignore, so it doesn't even open them (EMFILE) or report
 * their files.
 */
const IGNORE_CACHE_TTL_MS = 5000;
const ignoreCache = new Map<
  number,
  { at: number; isIgnored: (p: string, root: string) => boolean; dirs: string[] }
>();

function shouldIgnoreInWatcher(filePath: string, folder: WatchTarget): boolean {
  if (!db) return false;
  try {
    // chokidar asks about every path it sees, so the rules/settings behind
    // this are cached briefly instead of read from the database each time.
    let entry = ignoreCache.get(folder.id);
    if (!entry || Date.now() - entry.at > IGNORE_CACHE_TTL_MS) {
      entry = {
        at: Date.now(),
        isIgnored: compileIgnore(parseIgnorePatterns(getSetting(db, 'ignore_patterns'))),
        dirs: managedDirs(loadRules(db), folder.path),
      };
      ignoreCache.set(folder.id, entry);
    }
    return (
      entry.isIgnored(filePath, folder.path) ||
      isInManagedDir(filePath, entry.dirs) ||
      isInManagedDir(path.join(filePath, 'x'), entry.dirs)
    );
  } catch {
    return false;
  }
}

/**
 * Initialize and start watching all enabled folders.
 */
function startWatchingFolders(): void {
  if (!db) return;

  watchers = new WatcherManager(handleWatchedFile, shouldIgnoreInWatcher);

  const folders = db.prepare('SELECT * FROM watched_folders WHERE enabled = 1').all();
  for (const folder of folders) {
    watchers.add({ id: folder.id, path: folder.path, recursive: !!folder.recursive });
  }

  setWatchingEnabled(true);

  // Periodic cleanup of recently written entries
  cleanupTimer = setInterval(() => recentlyWritten?.cleanup(), 60000);
}

async function shutdown(): Promise<void> {
  if (cleanupTimer) clearInterval(cleanupTimer);
  if (watchers) await watchers.close();
  watchers = null;
  if (db) {
    db.close();
    db = null;
  }
}

// ===== App lifecycle =====

app.whenReady().then(() => {
  // FileFlow's own data folder (database, backups) must never be scanned or modified.
  protectAppDataDir(app.getPath('userData'));

  // Initialize database (runs pending migrations, backing up first)
  db = initDb(app.getPath('userData'));

  // Recover any pending operations from a previous crash
  recoverPending(db);

  // One tracker shared by the executor, the undo service and the watcher,
  // so files FileFlow just wrote or restored are not picked up again.
  recentlyWritten = new RecentlyWritten(30000);

  // Start file watching (creates `watchers`, needed by registerHandlers below)
  startWatchingFolders();

  // Register all IPC handlers. mainWindow doesn't exist yet (createWindow
  // runs after this), so handlers that need it (e.g. title-bar theming)
  // are given an accessor rather than the window itself.
  registerHandlers(db, recentlyWritten, watchers!, () => mainWindow);

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
    app.quit();
  }
});

app.on('before-quit', () => {
  void shutdown();
});
