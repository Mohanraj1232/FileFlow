export {};

declare global {
  interface Window {
    electronAPI: {
      getWatchedFolders: () => Promise<import("./lib/types").WatchedFolder[]>;
      addWatchedFolder: (path: string, recursive: boolean) => Promise<import("./lib/types").WatchedFolder>;
      removeWatchedFolder: (id: number) => Promise<void>;
      toggleWatchedFolder: (id: number, enabled: boolean) => Promise<void>;
      getRules: () => Promise<import("./lib/types").Rule[]>;
      createRule: (rule: import("./lib/types").Rule) => Promise<import("./lib/types").Rule>;
      updateRule: (rule: import("./lib/types").Rule) => Promise<import("./lib/types").Rule>;
      deleteRule: (id: number) => Promise<void>;
      toggleRule: (id: number, enabled: boolean) => Promise<void>;
      reorderRules: (ruleIds: number[]) => Promise<void>;
      testRule: (filename: string, ruleId?: number) => Promise<{ matched: boolean; rule_name?: string; destination?: string }>;
      previewFolder: (folderId: number) => Promise<import("./lib/types").PlanSummary>;
      applyPlan: (folderId: number, selectedPaths: string[]) => Promise<import("./lib/types").Operation>;
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
      showOpenDialog: () => Promise<string | null>;
    };
  }
}
