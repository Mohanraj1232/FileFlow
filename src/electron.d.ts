export {};

declare global {
  interface Window {
    electronAPI: {
      platform: string;
      getWatchedFolders: () => Promise<import("./lib/types").WatchedFolder[]>;
      addWatchedFolder: (path: string, recursive: boolean) => Promise<import("./lib/types").WatchedFolder>;
      removeWatchedFolder: (id: number) => Promise<void>;
      toggleWatchedFolder: (id: number, enabled: boolean) => Promise<void>;
      getRules: () => Promise<import("./lib/types").Rule[]>;
      createRule: (rule: import("./lib/types").Rule) => Promise<import("./lib/types").Rule>;
      updateRule: (rule: import("./lib/types").Rule) => Promise<import("./lib/types").Rule>;
      deleteRule: (id: number) => Promise<void>;
      toggleRule: (id: number, enabled: boolean) => Promise<void>;
      reorderRules: (ruleIds: number[]) => Promise<import("./lib/types").Rule[]>;
      testRule: (
        filename: string,
        ruleId: number | null,
        draft?: import("./lib/types").Rule,
      ) => Promise<import("./lib/types").TestRuleResult>;
      previewFolder: (folderId: number) => Promise<import("./lib/types").PlanSummary>;
      applyPlan: (
        folderId: number,
        planId: string,
        selectedFileKeys: string[] | null,
      ) => Promise<import("./lib/types").ApplyResult>;
      getOperations: (limit: number, offset: number) => Promise<import("./lib/types").Operation[]>;
      getOperationSteps: (operationId: number) => Promise<import("./lib/types").OperationStep[]>;
      undoOperation: (operationId: number) => Promise<import("./lib/types").UndoResult>;
      undoStep: (stepId: number) => Promise<import("./lib/types").UndoResult>;
      getUnsortedFiles: (folderId: number) => Promise<import("./lib/types").UnsortedFile[]>;
      getDashboardStats: () => Promise<import("./lib/types").DashboardStats>;
      getSettings: () => Promise<import("./lib/types").AppSettings>;
      updateSetting: (key: string, value: string) => Promise<void>;
      startWatching: () => Promise<void>;
      stopWatching: () => Promise<void>;
      getWatchingStatus: () => Promise<{ watching: boolean }>;
      setTitleBarTheme: (isDark: boolean) => Promise<{ success: boolean }>;
      showOpenDialog: () => Promise<string | null>;
      checkScanRoots: (roots: string[]) => Promise<import("./lib/types").RootCheck>;
      startDuplicateScan: (
        roots: string[],
        options?: import("./lib/types").DuplicateScanOptions,
      ) => Promise<import("./lib/types").DuplicateScanSummary>;
      getDuplicateScan: (scanId: string) => Promise<import("./lib/types").DuplicateScanSummary>;
      getDuplicateGroups: (
        scanId: string,
        offset: number,
        limit: number,
      ) => Promise<import("./lib/types").DuplicateGroupsPage>;
      cancelDuplicateScan: (scanId: string) => Promise<{ cancelled: boolean }>;
      resolveDuplicates: (
        scanId: string,
        decisions: import("./lib/types").DuplicateDecision[],
        mode: import("./lib/types").RemoveMode,
      ) => Promise<import("./lib/types").ResolveDuplicatesResult>;
      revealDuplicateFile: (scanId: string, filePath: string) => Promise<{ success: boolean }>;
      /** Progress of the running duplicate scan. Returns an unsubscribe function. */
      onDuplicateProgress: (
        callback: (summary: import("./lib/types").DuplicateScanSummary) => void,
      ) => () => void;
      /** Subscribe to files the watcher organized. Returns an unsubscribe function. */
      onFileProcessed: (
        callback: (event: import("./lib/types").FileProcessedEvent) => void,
      ) => () => void;
    };
  }
}
