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
      /** Subscribe to files the watcher organized. Returns an unsubscribe function. */
      onFileProcessed: (
        callback: (event: import("./lib/types").FileProcessedEvent) => void,
      ) => () => void;
    };
  }
}
