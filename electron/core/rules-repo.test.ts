import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openTestDb, clearRules } from '../test/helpers';
import * as repo from './rules-repo';
import { toRuleDto, toSettingsDto, fromRuleInput } from './dto';

let db: any;
beforeEach(() => {
  db = openTestDb();
  clearRules(db);
});
afterEach(() => db.close());

const input = (over: Record<string, unknown> = {}) => ({
  name: 'PDFs',
  enabled: true,
  priority: 5,
  trigger: 'scan',
  condition: { field: 'extension', op: 'is', value: 'pdf' },
  stop_after: true,
  actions: [{ action_type: 'move', params: { destination: '/x/{kind}' } }],
  ...over,
});

describe('rule storage and the renderer contract', () => {
  it('stores the renderer\'s `trigger` as trigger_type and returns it as `trigger` (was always reset to "arrival")', () => {
    const id = repo.createRule(db, input({ trigger: 'scan' }));
    expect(db.prepare('SELECT trigger_type FROM rules WHERE id = ?').get(id).trigger_type).toBe('scan');
    expect(toRuleDto(repo.getRule(db, id)!).trigger).toBe('scan');
  });

  it('returns booleans, not 0/1', () => {
    const id = repo.createRule(db, input({ enabled: false, stop_after: false }));
    const dto = toRuleDto(repo.getRule(db, id)!);
    expect(dto.enabled).toBe(false);
    expect(dto.stop_after).toBe(false);
    expect(dto.condition).toEqual({ field: 'extension', op: 'is', value: 'pdf' });
    expect(dto.actions[0].params).toEqual({ destination: '/x/{kind}' });
  });

  it('accepts the legacy `trigger_type` field name too', () => {
    const id = repo.createRule(db, input({ trigger: undefined, trigger_type: 'both' }));
    expect(toRuleDto(repo.getRule(db, id)!).trigger).toBe('both');
  });

  it('update replaces the rule and its actions', () => {
    const id = repo.createRule(db, input());
    repo.updateRule(db, {
      ...input({ name: 'Renamed', actions: [{ action_type: 'copy', params: { destination: '/y' } }] }),
      id,
    } as any);
    const rule = repo.getRule(db, id)!;
    expect(rule.name).toBe('Renamed');
    expect(rule.actions.map((a) => a.action_type)).toEqual(['copy']);
  });

  it('an invalid update changes nothing (atomic): the old actions survive', () => {
    const id = repo.createRule(db, input());
    expect(() =>
      repo.updateRule(db, { ...input({ actions: [{ action_type: 'move', params: {} }] }), id } as any)
    ).toThrow(/destination/);
    expect(repo.getRule(db, id)!.actions).toHaveLength(1);
    expect(repo.getRule(db, id)!.actions[0].params).toEqual({ destination: '/x/{kind}' });
  });

  it('updating a rule that does not exist throws instead of silently doing nothing', () => {
    expect(() => repo.updateRule(db, { ...input(), id: 4242 } as any)).toThrow(/not found/);
  });

  it('delete cascades to actions; toggle flips enabled', () => {
    const id = repo.createRule(db, input());
    repo.setRuleEnabled(db, id, false);
    expect(repo.getRule(db, id)!.enabled).toBe(0);
    repo.deleteRule(db, id);
    expect(db.prepare('SELECT COUNT(*) c FROM rule_actions').get().c).toBe(0);
  });

  it('reorder assigns priorities in the order given and loadRules returns them in that order', () => {
    const a = repo.createRule(db, input({ name: 'A' }));
    const b = repo.createRule(db, input({ name: 'B' }));
    const c = repo.createRule(db, input({ name: 'C' }));
    repo.reorderRules(db, [c, a, b]);
    expect(repo.loadRules(db).map((r) => r.name)).toEqual(['C', 'A', 'B']);
  });

  it('a corrupt stored condition becomes an inert rule instead of crashing every scan', () => {
    const id = repo.createRule(db, input());
    db.prepare('UPDATE rules SET condition = ? WHERE id = ?').run('{not json', id);
    expect(() => repo.loadRules(db)).not.toThrow();
    expect(repo.getRule(db, id)!.condition).toEqual({ any: [] });
  });
});

describe('input validation', () => {
  it.each([
    [{ name: '   ' }, /needs a name/],
    [{ trigger: 'sometimes' }, /Unknown trigger/],
    [{ condition: undefined }, /needs a condition/],
    [{ actions: [{ action_type: 'explode', params: {} }] }, /unknown action type/],
    [{ actions: [{ action_type: 'copy', params: {} }] }, /needs a destination/],
  ])('rejects %j', (over, message) => {
    expect(() => fromRuleInput(input(over as any) as any)).toThrow(message);
  });

  it('rename and trash actions need no destination', () => {
    expect(() =>
      fromRuleInput(input({ actions: [{ action_type: 'rename', params: { pattern: '{name}' } }, { action_type: 'trash', params: {} }] }) as any)
    ).not.toThrow();
  });
});

describe('settings DTO', () => {
  it('parses stored strings into the shapes the UI expects', () => {
    const s = toSettingsDto([
      { key: 'conflict_default', value: 'replace_if_duplicate' },
      { key: 'notification_level', value: 'errors_only' },
      { key: 'theme', value: 'light' },
      { key: 'scan_schedule_minutes', value: '15' },
      { key: 'ignore_patterns', value: '["*.tmp"]' },
    ]);
    expect(s).toEqual({
      conflict_default: 'replace_if_identical',
      notification_level: 'errors_only',
      theme: 'light',
      scan_schedule_minutes: 15,
      ignore_patterns: ['*.tmp'],
    });
  });

  it('falls back to safe defaults for missing or corrupt values', () => {
    const s = toSettingsDto([{ key: 'ignore_patterns', value: 'garbage' }, { key: 'scan_schedule_minutes', value: 'abc' }]);
    expect(s.ignore_patterns).toEqual([]);
    expect(s.scan_schedule_minutes).toBe(60);
    expect(s.conflict_default).toBe('auto_rename');
  });
});
