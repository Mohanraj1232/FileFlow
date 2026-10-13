/**
 * The IPC contract between the Electron main process and the React renderer.
 *
 * This is the single source of truth for every object that crosses the IPC
 * boundary. The renderer re-exports these from src/lib/types.ts; the main
 * process builds them in electron/core/dto.ts. IPC payloads are plain data,
 * so nothing else statically checks the two sides against each other — keep
 * this file type-only so it can be imported from either side.
 */

export type FileKind =
  | 'document'
  | 'image'
  | 'video'
  | 'audio'
  | 'archive'
  | 'code'
  | 'installer'
  | 'other';

export type TriggerType = 'arrival' | 'scan' | 'both';

export type ConditionField =
  | 'extension'
  | 'name'
  | 'size'
  | 'kind'
  | 'source_folder'
  | 'created_age'
  | 'modified_age'
  | 'is_duplicate';

export type ConditionOp =
  | 'is'
  | 'in'
  | 'not_in'
  | 'contains'
  | 'starts_with'
  | 'ends_with'
  | 'equals'
  | 'matches'
  | 'glob'
  | 'gt'
  | 'lt'
  | 'between';

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

export type ActionType = 'move' | 'copy' | 'rename' | 'trash' | 'ignore';

/**
 * What to do when a destination file already exists. No policy ever overwrites:
 *  - auto_rename          : keep both, give the new file a unique "name (2)" name
 *  - skip                 : leave the source where it is
 *  - replace_if_identical : if the existing file has byte-identical content the
 *                           source is redundant (sent to trash); otherwise keep
 *                           both exactly like auto_rename
 */
export type ConflictPolicy = 'auto_rename' | 'skip' | 'replace_if_identical';

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

export type OperationSource = 'watcher' | 'scan' | 'manual';
export type OperationStatus =
  | 'planned'
  | 'running'
  | 'done'
  | 'partial'
  | 'failed'
  | 'undone'
  | 'partially_undone';
export type StepStatus = 'pending' | 'done' | 'failed' | 'undone' | 'skipped';

export interface Operation {
  id: number;
  source: string;
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
  /** 'skip' rows are informational: they are shown greyed out and never executed. */
  action_type: ActionType | 'skip';
  src_path: string;
  dst_path: string | null;
  file_size: number;
  file_mtime: string;
  selected: boolean;
  /** Identifies the file this step belongs to; chained steps share one key. */
  file_key: string;
  /** Why a step was skipped, or how a conflict was resolved. */
  note?: string;
}

export interface PlanSummary {
  /** Handle to the server-side copy of this plan; pass it to apply_plan. */
  plan_id: string;
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
  notification_level: 'all' | 'batched' | 'errors_only' | 'none';
  theme: 'light' | 'dark' | 'system';
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

/** Result of testing a file name against the saved rules (or an unsaved draft). */
export interface TestRuleResult {
  matched: boolean;
  rule_id?: number;
  rule_name?: string;
  /** Where the first move/copy action would put the file, variables expanded. */
  destination?: string;
  /** Resulting file name if a rename action matched. */
  new_name?: string;
}

/** What apply_plan returns: the finished operation plus how many steps were attempted. */
export interface ApplyResult {
  operation: Operation | null;
  steps_attempted: number;
  message?: string;
}

/** Pushed from the main process when the watcher organizes a file. */
export interface FileProcessedEvent {
  path: string;
  rule: string;
  actions: number;
  operation_id: number;
}
