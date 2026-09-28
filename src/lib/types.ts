export type FileKind =
  | "document"
  | "image"
  | "video"
  | "audio"
  | "archive"
  | "code"
  | "installer"
  | "other";

export type TriggerType = "arrival" | "scan" | "both";

export type ConditionField =
  | "extension"
  | "name"
  | "size"
  | "kind"
  | "source_folder"
  | "created_age"
  | "modified_age"
  | "is_duplicate";

export type ConditionOp =
  | "is"
  | "in"
  | "not_in"
  | "contains"
  | "starts_with"
  | "ends_with"
  | "equals"
  | "matches"
  | "glob"
  | "gt"
  | "lt"
  | "between";

export interface ConditionLeaf {
  field: ConditionField;
  op: ConditionOp;
  value: string | string[] | number | number[] | boolean;
  case_sensitive?: boolean;
}

export interface ConditionGroup {
  all?: Condition[];
  any?: Condition[];
}

export type Condition = ConditionLeaf | ConditionGroup;

export type ActionType = "move" | "copy" | "rename" | "trash" | "ignore";

export type ConflictPolicy =
  | "auto_rename"
  | "skip"
  | "replace_if_duplicate"
  | "ask";

export interface RuleAction {
  id?: number;
  rule_id?: number;
  position: number;
  action_type: ActionType;
  params: {
    destination?: string;
    pattern?: string;
    on_conflict?: ConflictPolicy;
  };
}

export interface Rule {
  id?: number;
  name: string;
  enabled: boolean;
  priority: number;
  trigger: TriggerType;
  condition: Condition;
  stop_after: boolean;
  scope_folder?: number | null;
  actions: RuleAction[];
  created_at?: string;
  updated_at?: string;
}

export interface WatchedFolder {
  id: number;
  path: string;
  recursive: boolean;
  enabled: boolean;
  created_at: string;
}

export type OperationSource = "watcher" | "scan" | "manual";
export type OperationStatus =
  | "planned"
  | "running"
  | "done"
  | "partial"
  | "failed"
  | "undone"
  | "partially_undone";
export type StepStatus =
  | "pending"
  | "done"
  | "failed"
  | "undone"
  | "skipped";

export interface Operation {
  id: number;
  source: OperationSource;
  status: OperationStatus;
  summary: string | null;
  started_at: string;
  finished_at: string | null;
  steps?: OperationStep[];
}

export interface OperationStep {
  id: number;
  operation_id: number;
  seq: number;
  rule_id: number | null;
  action_type: ActionType;
  src_path: string;
  dst_path: string | null;
  file_size: number | null;
  file_mtime: string | null;
  content_hash: string | null;
  status: StepStatus;
  error: string | null;
  executed_at: string | null;
}

export interface PlannedStep {
  rule_id: number | null;
  rule_name: string;
  action_type: ActionType;
  src_path: string;
  dst_path: string | null;
  file_size: number;
  selected: boolean;
}

export interface PlanSummary {
  steps: PlannedStep[];
  move_count: number;
  copy_count: number;
  rename_count: number;
  trash_count: number;
  skip_count: number;
  no_match_count: number;
}

export interface UndoResult {
  success: boolean;
  steps_undone: number;
  steps_skipped: number;
  errors: string[];
}

export interface AppSettings {
  conflict_default: ConflictPolicy;
  notification_level: "all" | "batched" | "errors_only" | "none";
  theme: "light" | "dark" | "system";
  scan_schedule_minutes: number;
  ignore_patterns: string[];
}

export interface DashboardStats {
  files_organized_today: number;
  files_organized_week: number;
  active_rules: number;
  watched_folders: number;
  recent_operations: Operation[];
}

export interface UnsortedFile {
  path: string;
  name: string;
  extension: string;
  size: number;
  kind: FileKind;
  modified_at: string;
}
