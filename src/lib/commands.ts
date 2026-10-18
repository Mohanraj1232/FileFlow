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
  TestRuleResult,
  ApplyResult,
  FileProcessedEvent,
  DuplicateScanOptions,
  DuplicateScanSummary,
  DuplicateGroupsPage,
  DuplicateDecision,
  RemoveMode,
  ResolveDuplicatesResult,
  RootCheck,
  StorageScanSummary,
  StorageReport,
  StorageFileFilter,
  StorageSort,
  StorageFilesPage,
  StorageRecommendations,
  DuplicateSavings,
  StorageCleanupResult,
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
): Promise<Rule[]> {
  return window.electronAPI.reorderRules(ruleIds);
}

/**
 * Test a file name against the saved rules, a single saved rule (`ruleId`),
 * or an unsaved rule exactly as the builder currently shows it (`draft`).
 */
export async function testRule(
  filename: string,
  ruleId?: number,
  draft?: Rule,
): Promise<TestRuleResult> {
  return window.electronAPI.testRule(filename, ruleId ?? null, draft);
}

export async function previewFolder(
  folderId: number,
): Promise<PlanSummary> {
  return window.electronAPI.previewFolder(folderId);
}

/** Run the previewed plan. Only the plan id and the ticked files are sent, never raw paths. */
export async function applyPlan(
  folderId: number,
  planId: string,
  selectedFileKeys: string[] | null,
): Promise<ApplyResult> {
  return window.electronAPI.applyPlan(folderId, planId, selectedFileKeys);
}

export function onFileProcessed(
  callback: (event: FileProcessedEvent) => void,
): () => void {
  return window.electronAPI.onFileProcessed(callback);
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

// ---- Duplicate finder ----------------------------------------------------

export async function checkScanRoots(roots: string[]): Promise<RootCheck> {
  return window.electronAPI.checkScanRoots(roots);
}

export async function startDuplicateScan(
  roots: string[],
  options?: DuplicateScanOptions,
): Promise<DuplicateScanSummary> {
  return window.electronAPI.startDuplicateScan(roots, options);
}

export async function getDuplicateScan(scanId: string): Promise<DuplicateScanSummary> {
  return window.electronAPI.getDuplicateScan(scanId);
}

export async function getDuplicateGroups(
  scanId: string,
  offset: number,
  limit: number,
): Promise<DuplicateGroupsPage> {
  return window.electronAPI.getDuplicateGroups(scanId, offset, limit);
}

export async function cancelDuplicateScan(scanId: string): Promise<{ cancelled: boolean }> {
  return window.electronAPI.cancelDuplicateScan(scanId);
}

/** Remove the unwanted copies. `keep` lists the files to KEEP in each group; the rest are removed. */
export async function resolveDuplicates(
  scanId: string,
  decisions: DuplicateDecision[],
  mode: RemoveMode,
): Promise<ResolveDuplicatesResult> {
  return window.electronAPI.resolveDuplicates(scanId, decisions, mode);
}

export async function revealDuplicateFile(scanId: string, filePath: string): Promise<void> {
  await window.electronAPI.revealDuplicateFile(scanId, filePath);
}

export function onDuplicateProgress(
  callback: (summary: DuplicateScanSummary) => void,
): () => void {
  return window.electronAPI.onDuplicateProgress(callback);
}

// ---- Storage analysis ----------------------------------------------------

export async function storageListScans(): Promise<StorageScanSummary[]> {
  return window.electronAPI.storageListScans();
}

export async function storageStartScan(
  roots: string[],
  options?: { include_hidden?: boolean; confirm_sensitive?: boolean },
): Promise<StorageScanSummary> {
  return window.electronAPI.storageStartScan(roots, options);
}

export async function storageGetScan(scanId: number): Promise<StorageScanSummary> {
  return window.electronAPI.storageGetScan(scanId);
}

export async function storageCancelScan(scanId: number): Promise<{ cancelled: boolean }> {
  return window.electronAPI.storageCancelScan(scanId);
}

export async function storageDeleteScan(scanId: number): Promise<void> {
  await window.electronAPI.storageDeleteScan(scanId);
}

export async function storageGetReport(scanId: number, folder?: string | null): Promise<StorageReport> {
  return window.electronAPI.storageGetReport(scanId, folder ?? null);
}

export async function storageQueryFiles(
  scanId: number,
  filter: StorageFileFilter,
  sort: StorageSort,
  offset: number,
  limit: number,
): Promise<StorageFilesPage> {
  return window.electronAPI.storageQueryFiles(scanId, filter, sort, offset, limit);
}

export async function storageGetRecommendations(
  scanId: number,
  oldMonths?: number,
): Promise<StorageRecommendations> {
  return window.electronAPI.storageGetRecommendations(scanId, oldMonths);
}

export async function storageGetRecommendationFiles(
  scanId: number,
  recommendationId: string,
  oldMonths: number,
  offset: number,
  limit: number,
): Promise<StorageFilesPage> {
  return window.electronAPI.storageGetRecommendationFiles(scanId, recommendationId, oldMonths, offset, limit);
}

export async function storageGetDuplicateSavings(scanId: number): Promise<DuplicateSavings | null> {
  return window.electronAPI.storageGetDuplicateSavings(scanId);
}

/** Remove the chosen files: quarantine (undoable from History) or the system trash. */
export async function storageCleanup(
  scanId: number,
  paths: string[],
  mode: RemoveMode,
): Promise<StorageCleanupResult> {
  return window.electronAPI.storageCleanup(scanId, paths, mode);
}

export async function storageReveal(scanId: number, filePath: string): Promise<void> {
  await window.electronAPI.storageReveal(scanId, filePath);
}

export function onStorageProgress(callback: (summary: StorageScanSummary) => void): () => void {
  return window.electronAPI.onStorageProgress(callback);
}
