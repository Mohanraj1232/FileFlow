const { contextBridge, ipcRenderer } = require('electron');

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
  testRule: (filename: string, ruleId: number | null) =>
    ipcRenderer.invoke('test_rule', filename, ruleId),

  previewFolder: (folderId: number) =>
    ipcRenderer.invoke('preview_folder', folderId),

  applyPlan: (folderId: number, selectedPaths: string[] | null) =>
    ipcRenderer.invoke('apply_plan', folderId, selectedPaths),

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

  // Event listeners for renderer
  onFileProcessed: (callback: (data: any) => void) => {
    ipcRenderer.on('file-processed', (_event: any, data: any) =>
      callback(data)
    );
  },

  removeFileProcessedListener: () => {
    ipcRenderer.removeAllListeners('file-processed');
  },
});
