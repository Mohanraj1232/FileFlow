import type {
  AppSettings,
  Operation,
  Rule as RuleDto,
  WatchedFolder as WatchedFolderDto,
} from '../shared/contract';
import type { Rule as EngineRule } from './engine';
import { parseIgnorePatterns } from './ignore';
import { normalizePolicy } from './planner';

/**
 * The ONLY place database rows are turned into the objects the renderer sees
 * (and renderer input is turned back into row values). Keeping the mapping in
 * one module is what stops the two sides drifting apart — the renderer reads
 * `trigger`/`enabled: boolean`, the database stores `trigger_type`/`enabled: 0|1`.
 */

export function toRuleDto(rule: EngineRule & { created_at?: string; updated_at?: string }): RuleDto {
  return {
    id: rule.id,
    name: rule.name,
    enabled: !!rule.enabled,
    priority: rule.priority,
    trigger: (rule.trigger_type as RuleDto['trigger']) ?? 'arrival',
    condition: rule.condition as RuleDto['condition'],
    stop_after: !!rule.stop_after,
    scope_folder: rule.scope_folder ?? null,
    actions: (rule.actions ?? []).map((a) => ({
      id: a.id,
      rule_id: a.rule_id,
      position: a.position,
      action_type: a.action_type as RuleDto['actions'][number]['action_type'],
      params: a.params,
    })),
    created_at: rule.created_at,
    updated_at: rule.updated_at,
  };
}

export function toWatchedFolderDto(row: any): WatchedFolderDto {
  return {
    id: row.id,
    path: row.path,
    recursive: !!row.recursive,
    enabled: !!row.enabled,
    created_at: row.created_at,
  };
}

export function toOperationDto(row: any): Operation {
  return row as Operation;
}

export function toSettingsDto(rows: { key: string; value: string }[]): AppSettings {
  const raw: Record<string, string> = {};
  for (const row of rows) raw[row.key] = row.value;

  const minutes = Number(raw.scan_schedule_minutes);
  return {
    conflict_default: normalizePolicy(raw.conflict_default),
    notification_level: (raw.notification_level as AppSettings['notification_level']) ?? 'batched',
    theme: (raw.theme as AppSettings['theme']) ?? 'dark',
    scan_schedule_minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : 60,
    ignore_patterns: parseIgnorePatterns(raw.ignore_patterns),
  };
}

/** A rule as the renderer sends it, tolerant of either `trigger` or `trigger_type`. */
export interface RuleInput {
  id?: number;
  name: string;
  enabled?: boolean | number;
  priority?: number;
  trigger?: string;
  trigger_type?: string;
  condition: unknown;
  stop_after?: boolean | number;
  scope_folder?: number | null;
  actions?: { action_type: string; params: unknown }[];
}

const TRIGGERS = ['arrival', 'scan', 'both'];
const ACTION_TYPES = ['move', 'copy', 'rename', 'trash', 'ignore'];

export interface RuleRow {
  name: string;
  enabled: number;
  priority: number;
  trigger_type: string;
  condition: string;
  stop_after: number;
  scope_folder: number | null;
  actions: { action_type: string; params: string }[];
}

/** Validate and normalize renderer input into database values. Throws on invalid rules. */
export function fromRuleInput(input: RuleInput): RuleRow {
  const name = String(input.name ?? '').trim();
  if (!name) throw new Error('A rule needs a name');

  const trigger = input.trigger ?? input.trigger_type ?? 'arrival';
  if (!TRIGGERS.includes(trigger)) throw new Error(`Unknown trigger: ${trigger}`);

  if (input.condition === undefined || input.condition === null) {
    throw new Error('A rule needs a condition');
  }
  const conditionObj =
    typeof input.condition === 'string' ? JSON.parse(input.condition) : input.condition;

  const actions = (input.actions ?? []).map((a, i) => {
    if (!ACTION_TYPES.includes(a.action_type)) {
      throw new Error(`Action ${i + 1}: unknown action type "${a.action_type}"`);
    }
    const params =
      typeof a.params === 'string' ? JSON.parse(a.params) : ((a.params as object) ?? {});
    if ((a.action_type === 'move' || a.action_type === 'copy') && !(params as any).destination) {
      throw new Error(`Action ${i + 1} (${a.action_type}) needs a destination folder`);
    }
    return { action_type: a.action_type, params: JSON.stringify(params) };
  });

  return {
    name,
    enabled: input.enabled === undefined ? 1 : input.enabled ? 1 : 0,
    priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : 0,
    trigger_type: trigger,
    condition: JSON.stringify(conditionObj),
    stop_after: input.stop_after === undefined ? 1 : input.stop_after ? 1 : 0,
    scope_folder: input.scope_folder || null,
    actions,
  };
}
