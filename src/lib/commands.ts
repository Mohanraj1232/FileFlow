import { invoke } from "@tauri-apps/api/core";
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
  return invoke("get_watched_folders");
}

export async function addWatchedFolder(
  path: string,
  recursive: boolean,
): Promise<WatchedFolder> {
  return invoke("add_watched_folder", { path, recursive });
}

export async function removeWatchedFolder(id: number): Promise<void> {
  return invoke("remove_watched_folder", { id });
}

export async function toggleWatchedFolder(
  id: number,
  enabled: boolean,
): Promise<void> {
  return invoke("toggle_watched_folder", { id, enabled });
}

export async function getRules(): Promise<Rule[]> {
  return invoke("get_rules");
}

export async function createRule(rule: Rule): Promise<Rule> {
  return invoke("create_rule", { rule });
}

export async function updateRule(rule: Rule): Promise<Rule> {
  return invoke("update_rule", { rule });
}

export async function deleteRule(id: number): Promise<void> {
  return invoke("delete_rule", { id });
}

export async function toggleRule(
  id: number,
  enabled: boolean,
): Promise<void> {
  return invoke("toggle_rule", { id, enabled });
}

export async function reorderRules(
  ruleIds: number[],
): Promise<void> {
  return invoke("reorder_rules", { ruleIds });
}

export async function testRule(
  filename: string,
  ruleId?: number,
): Promise<{ matched: boolean; rule_name?: string; destination?: string }> {
  return invoke("test_rule", { filename, ruleId });
}

export async function previewFolder(
  folderId: number,
): Promise<PlanSummary> {
  return invoke("preview_folder", { folderId });
}

export async function applyPlan(
  folderId: number,
  selectedPaths: string[],
): Promise<Operation> {
  return invoke("apply_plan", { folderId, selectedPaths });
}

export async function getOperations(
  limit: number,
  offset: number,
): Promise<Operation[]> {
  return invoke("get_operations", { limit, offset });
}

export async function getOperationSteps(
  operationId: number,
): Promise<OperationStep[]> {
  return invoke("get_operation_steps", { operationId });
}

export async function undoOperation(
  operationId: number,
): Promise<UndoResult> {
  return invoke("undo_operation", { operationId });
}

export async function undoStep(stepId: number): Promise<UndoResult> {
  return invoke("undo_step", { stepId });
}

export async function getUnsortedFiles(
  folderId: number,
): Promise<UnsortedFile[]> {
  return invoke("get_unsorted_files", { folderId });
}

export async function getDashboardStats(): Promise<DashboardStats> {
  return invoke("get_dashboard_stats");
}

export async function getSettings(): Promise<AppSettings> {
  return invoke("get_settings");
}

export async function updateSetting(
  key: string,
  value: string,
): Promise<void> {
  return invoke("update_setting", { key, value });
}

export async function startWatching(): Promise<void> {
  return invoke("start_watching");
}

export async function stopWatching(): Promise<void> {
  return invoke("stop_watching");
}
