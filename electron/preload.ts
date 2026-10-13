import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,

  // Watched Folders
  getWatchedFolders: () => ipcRenderer.invoke('get_watched_folders'),

  addWatchedFolder: (path: string, recursive: boolean) =>
    ipcRenderer.invoke('add_watched_folder', path, recursive),

  removeWatchedFolder: (id: number) =>
    ipcRenderer.invoke('remove_watched_folder', id),

  toggleWatchedFolder: (id: number, enabled: boolean) =>
    ipcRenderer.invoke('toggle_watched_folder', id, enabled),

  // Rules
  getRules: () => ipcRenderer.invoke('get_rules'),

  createRule: (rule: any) => ipcRenderer.invoke('create_rule', rule),

  updateRule: (rule: any) => ipcRenderer.invoke('update_rule', rule),

  deleteRule: (id: number) => ipcRenderer.invoke('delete_rule', id),

  toggleRule: (id: number, enabled: boolean) =>
    ipcRenderer.invoke('toggle_rule', id, enabled),

  reorderRules: (ruleIds: number[]) =>
    ipcRenderer.invoke('reorder_rules', ruleIds),

  // Rule Testing & Preview
  testRule: (filename: string, ruleId: number | null, draft?: unknown) =>
    ipcRenderer.invoke('test_rule', filename, ruleId, draft),

  previewFolder: (folderId: number) =>
    ipcRenderer.invoke('preview_folder', folderId),

  applyPlan: (folderId: number, planId: string, selectedFileKeys: string[] | null) =>
    ipcRenderer.invoke('apply_plan', folderId, planId, selectedFileKeys),

  // Operations & Journal
  getOperations: (limit: number, offset: number) =>
    ipcRenderer.invoke('get_operations', limit, offset),

  getOperationSteps: (operationId: number) =>
    ipcRenderer.invoke('get_operation_steps', operationId),

  // Undo
  undoOperation: (operationId: number) =>
    ipcRenderer.invoke('undo_operation', operationId),

  undoStep: (stepId: number) => ipcRenderer.invoke('undo_step', stepId),

  // Unsorted Files
  getUnsortedFiles: (folderId: number) =>
    ipcRenderer.invoke('get_unsorted_files', folderId),

  // Dashboard
  getDashboardStats: () => ipcRenderer.invoke('get_dashboard_stats'),

  // Settings
  getSettings: () => ipcRenderer.invoke('get_settings'),

  updateSetting: (key: string, value: string) =>
    ipcRenderer.invoke('update_setting', key, value),

  // Watching Control
  startWatching: () => ipcRenderer.invoke('start_watching'),

  stopWatching: () => ipcRenderer.invoke('stop_watching'),

  getWatchingStatus: () => ipcRenderer.invoke('get_watching_status'),

  // Title Bar
  setTitleBarTheme: (isDark: boolean) =>
    ipcRenderer.invoke('set_title_bar_theme', isDark),

  // Dialog
  showOpenDialog: () => ipcRenderer.invoke('show_open_dialog'),

  // Duplicate finder
  checkScanRoots: (roots: string[]) => ipcRenderer.invoke('check_scan_roots', roots),

  startDuplicateScan: (roots: string[], options?: unknown) =>
    ipcRenderer.invoke('start_duplicate_scan', roots, options),

  getDuplicateScan: (scanId: string) => ipcRenderer.invoke('get_duplicate_scan', scanId),

  getDuplicateGroups: (scanId: string, offset: number, limit: number) =>
    ipcRenderer.invoke('get_duplicate_groups', scanId, offset, limit),

  cancelDuplicateScan: (scanId: string) => ipcRenderer.invoke('cancel_duplicate_scan', scanId),

  resolveDuplicates: (scanId: string, decisions: unknown, mode: string) =>
    ipcRenderer.invoke('resolve_duplicates', scanId, decisions, mode),

  revealDuplicateFile: (scanId: string, filePath: string) =>
    ipcRenderer.invoke('reveal_duplicate_file', scanId, filePath),

  onDuplicateProgress: (callback: (data: any) => void) => {
    const listener = (_event: unknown, data: unknown) => callback(data);
    ipcRenderer.on('duplicate-progress', listener);
    return () => ipcRenderer.removeListener('duplicate-progress', listener);
  },

  // Event listeners for renderer
  onFileProcessed: (callback: (data: any) => void) => {
    const listener = (_event: unknown, data: unknown) => callback(data);
    ipcRenderer.on('file-processed', listener);
    // Return an unsubscribe function so a component only removes its own listener.
    return () => ipcRenderer.removeListener('file-processed', listener);
  },

  removeFileProcessedListener: () => {
    ipcRenderer.removeAllListeners('file-processed');
  },
});
