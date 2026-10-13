import type { Rule } from './engine';
import { fromRuleInput, type RuleInput } from './dto';

const now = () => new Date().toISOString().slice(0, 19);

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return (value as T) ?? fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * Load all rules (with their actions) in priority order, with JSON columns
 * parsed. A corrupt condition/params value is replaced by an inert one rather
 * than crashing every scan that loads the rules.
 */
export function loadRules(db: any): (Rule & { created_at: string; updated_at: string })[] {
  const rules = db.prepare('SELECT * FROM rules ORDER BY priority ASC, id ASC').all();
  const actionStmt = db.prepare(
    'SELECT * FROM rule_actions WHERE rule_id = ? ORDER BY position ASC'
  );

  for (const rule of rules) {
    rule.actions = actionStmt.all(rule.id).map((a: any) => ({
      ...a,
      params: parseJson(a.params, {}),
    }));
    // An unparseable condition becomes an "all of nothing" group that never matches.
    rule.condition = parseJson(rule.condition, { any: [] });
  }

  return rules;
}

export function getRule(db: any, id: number) {
  return loadRules(db).find((r) => r.id === id);
}

/** Create a rule and its actions atomically. Returns the new rule id. */
export function createRule(db: any, input: RuleInput): number {
  const row = fromRuleInput(input);
  const ts = now();

  return db.transaction(() => {
    const result = db
      .prepare(
        `INSERT INTO rules (name, enabled, priority, trigger_type, condition, stop_after, scope_folder, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.name,
        row.enabled,
        row.priority,
        row.trigger_type,
        row.condition,
        row.stop_after,
        row.scope_folder,
        ts,
        ts
      );
    const ruleId = Number(result.lastInsertRowid);
    insertActions(db, ruleId, row.actions);
    return ruleId;
  })();
}

/** Update a rule and replace its actions atomically. */
export function updateRule(db: any, input: RuleInput & { id: number }): number {
  const row = fromRuleInput(input);

  db.transaction(() => {
    const result = db
      .prepare(
        `UPDATE rules SET name = ?, enabled = ?, priority = ?, trigger_type = ?,
         condition = ?, stop_after = ?, scope_folder = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        row.name,
        row.enabled,
        row.priority,
        row.trigger_type,
        row.condition,
        row.stop_after,
        row.scope_folder,
        now(),
        input.id
      );
    if (result.changes === 0) throw new Error(`Rule not found: ${input.id}`);

    db.prepare('DELETE FROM rule_actions WHERE rule_id = ?').run(input.id);
    insertActions(db, input.id, row.actions);
  })();

  return input.id;
}

function insertActions(db: any, ruleId: number, actions: { action_type: string; params: string }[]) {
  const insert = db.prepare(
    'INSERT INTO rule_actions (rule_id, position, action_type, params) VALUES (?, ?, ?, ?)'
  );
  actions.forEach((a, i) => insert.run(ruleId, i, a.action_type, a.params));
}

export function deleteRule(db: any, id: number): void {
  db.prepare('DELETE FROM rules WHERE id = ?').run(id);
}

export function setRuleEnabled(db: any, id: number, enabled: boolean): void {
  db.prepare('UPDATE rules SET enabled = ?, updated_at = ? WHERE id = ?').run(
    enabled ? 1 : 0,
    now(),
    id
  );
}

/** Assign priorities 0..n-1 in the given order. */
export function reorderRules(db: any, ruleIds: number[]): void {
  const update = db.prepare('UPDATE rules SET priority = ?, updated_at = ? WHERE id = ?');
  const ts = now();
  db.transaction(() => {
    ruleIds.forEach((id, i) => update.run(i, ts, id));
  })();
}

export function getSetting(db: any, key: string): string | undefined {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
}
