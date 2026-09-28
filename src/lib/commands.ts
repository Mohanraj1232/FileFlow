import type {
  WatchedFolder,
  Rule,
  Operation,
  OperationStep,
  PlanSummary,
  UndoResult,
  DashboardStats,
  UnsortedFile,
  AppSettings,
} from "./types";

export async function getWatchedFolders(): Promise<WatchedFolder[]> {
  return window.electronAPI.getWatchedFolders();
}

export async function addWatchedFolder(
  path: string,
  recursive: boolean,
): Promise<WatchedFolder> {
  return window.electronAPI.addWatchedFolder(path, recursive);
}

export async function removeWatchedFolder(id: number): Promise<void> {
  return window.electronAPI.removeWatchedFolder(id);
}

export async function toggleWatchedFolder(
  id: number,
  enabled: boolean,
): Promise<void> {
  return window.electronAPI.toggleWatchedFolder(id, enabled);
}

export async function getRules(): Promise<Rule[]> {
  return window.electronAPI.getRules();
}

export async function createRule(rule: Rule): Promise<Rule> {
  return window.electronAPI.createRule(rule);
}

export async function updateRule(rule: Rule): Promise<Rule> {
  return window.electronAPI.updateRule(rule);
}

export async function deleteRule(id: number): Promise<void> {
  return window.electronAPI.deleteRule(id);
}

export async function toggleRule(
  id: number,
  enabled: boolean,
): Promise<void> {
  return window.electronAPI.toggleRule(id, enabled);
}

export async function reorderRules(
  ruleIds: number[],
): Promise<void> {
  return window.electronAPI.reorderRules(ruleIds);
}

export async function testRule(
  filename: string,
  ruleId?: number,
): Promise<{ matched: boolean; rule_name?: string; destination?: string }> {
  return window.electronAPI.testRule(filename, ruleId);
}

export async function previewFolder(
  folderId: number,
): Promise<PlanSummary> {
  return window.electronAPI.previewFolder(folderId);
}

export async function applyPlan(
  folderId: number,
  selectedPaths: string[],
): Promise<Operation> {
  return window.electronAPI.applyPlan(folderId, selectedPaths);
}

export async function getOperations(
  limit: number,
  offset: number,
): Promise<Operation[]> {
  return window.electronAPI.getOperations(limit, offset);
}

export async function getOperationSteps(
  operationId: number,
): Promise<OperationStep[]> {
  return window.electronAPI.getOperationSteps(operationId);
}

export async function undoOperation(
  operationId: number,
): Promise<UndoResult> {
  return window.electronAPI.undoOperation(operationId);
}

export async function undoStep(stepId: number): Promise<UndoResult> {
  return window.electronAPI.undoStep(stepId);
}

export async function getUnsortedFiles(
  folderId: number,
): Promise<UnsortedFile[]> {
  return window.electronAPI.getUnsortedFiles(folderId);
}

export async function getDashboardStats(): Promise<DashboardStats> {
  return window.electronAPI.getDashboardStats();
}

export async function getSettings(): Promise<AppSettings> {
  return window.electronAPI.getSettings();
}

export async function updateSetting(
  key: string,
  value: string,
): Promise<void> {
  return window.electronAPI.updateSetting(key, value);
}

export async function startWatching(): Promise<void> {
  return window.electronAPI.startWatching();
}

export async function stopWatching(): Promise<void> {
  return window.electronAPI.stopWatching();
}

export async function getWatchingStatus(): Promise<{ watching: boolean }> {
  return window.electronAPI.getWatchingStatus();
}

export async function setTitleBarTheme(isDark: boolean): Promise<void> {
  await window.electronAPI.setTitleBarTheme(isDark);
}
