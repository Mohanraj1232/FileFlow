import { describe, it, expect } from 'vitest';
import { evaluate, evaluateCondition, type Rule } from './engine';
import type { FileMetaInfo } from './models';

function meta(over: Partial<FileMetaInfo> = {}): FileMetaInfo {
  return {
    name: 'Invoice 2025',
    extension: 'pdf',
    size: 2048,
    mtime: new Date('2025-06-15T10:00:00'),
    kind: 'document',
    path: '/in/Invoice 2025.pdf',
    sourceFolder: '/in',
    watchRoot: '/in',
    ...over,
  };
}

function rule(over: Partial<Rule> & { id: number }): Rule {
  return {
    name: `rule-${over.id}`,
    enabled: 1,
    priority: over.id,
    trigger_type: 'both',
    condition: { field: 'kind', op: 'is', value: 'document' },
    stop_after: 1,
    scope_folder: null,
    actions: [],
    ...over,
  };
}

describe('leaf conditions', () => {
  it('extension is / in / not_in', async () => {
    expect(await evaluateCondition(meta(), { field: 'extension', op: 'is', value: '.PDF' })).toBe(true);
    expect(await evaluateCondition(meta(), { field: 'extension', op: 'in', value: 'doc, pdf' })).toBe(true);
    expect(await evaluateCondition(meta(), { field: 'extension', op: 'in', value: ['png'] })).toBe(false);
    expect(await evaluateCondition(meta(), { field: 'extension', op: 'not_in', value: ['png', 'jpg'] })).toBe(true);
    expect(await evaluateCondition(meta(), { field: 'extension', op: 'not_in', value: 'pdf' })).toBe(false);
  });

  it('name operators are case-insensitive', async () => {
    const n = (op: string, value: string) =>
      evaluateCondition(meta(), { field: 'name', op, value });
    expect(await n('contains', 'INVOICE')).toBe(true);
    expect(await n('starts_with', 'invoice')).toBe(true);
    expect(await n('ends_with', '2025')).toBe(true);
    expect(await n('equals', 'invoice 2025')).toBe(true);
    expect(await n('matches', '^inv.*\\d{4}$')).toBe(true);
    expect(await n('glob', 'invoice*')).toBe(true);
    expect(await n('glob', 'receipt*')).toBe(false);
  });

  it('an invalid regex never matches and never throws', async () => {
    expect(await evaluateCondition(meta(), { field: 'name', op: 'matches', value: '([' })).toBe(false);
  });

  it('size gt / lt / between', async () => {
    expect(await evaluateCondition(meta(), { field: 'size', op: 'gt', value: 1000 })).toBe(true);
    expect(await evaluateCondition(meta(), { field: 'size', op: 'lt', value: 1000 })).toBe(false);
    expect(await evaluateCondition(meta(), { field: 'size', op: 'between', value: [2048, 4096] })).toBe(true);
    expect(await evaluateCondition(meta(), { field: 'size', op: 'between', value: '1, 2047' })).toBe(false);
  });

  it('kind is / in and source_folder is', async () => {
    expect(await evaluateCondition(meta(), { field: 'kind', op: 'is', value: 'Document' })).toBe(true);
    expect(await evaluateCondition(meta(), { field: 'kind', op: 'in', value: 'image,document' })).toBe(true);
    expect(await evaluateCondition(meta({ sourceFolder: 'C:\\In' }), { field: 'source_folder', op: 'is', value: 'c:/in' })).toBe(true);
  });

  it('unknown fields, unknown operators and incomplete leaves do not match', async () => {
    expect(await evaluateCondition(meta(), { field: 'bogus', op: 'is', value: 'x' })).toBe(false);
    expect(await evaluateCondition(meta(), { field: 'kind', op: 'weird', value: 'x' })).toBe(false);
    expect(await evaluateCondition(meta(), { field: 'kind' })).toBe(false);
  });
});

describe('condition groups', () => {
  const isPdf = { field: 'extension', op: 'is', value: 'pdf' };
  const isPng = { field: 'extension', op: 'is', value: 'png' };
  const big = { field: 'size', op: 'gt', value: 1_000_000 };

  it('all = AND, any = OR, and they nest', async () => {
    expect(await evaluateCondition(meta(), { all: [isPdf, big] })).toBe(false);
    expect(await evaluateCondition(meta(), { any: [isPng, isPdf] })).toBe(true);
    expect(await evaluateCondition(meta(), { all: [isPdf, { any: [isPng, big, isPdf] }] })).toBe(true);
    expect(await evaluateCondition(meta(), { all: [isPdf, { any: [isPng, big] }] })).toBe(false);
  });

  it('an empty any-group never matches', async () => {
    expect(await evaluateCondition(meta(), { any: [] })).toBe(false);
  });
});

describe('evaluate (rule selection)', () => {
  it('first matching rule by priority wins, regardless of list order', async () => {
    const rules = [
      rule({ id: 2, priority: 20, name: 'second' }),
      rule({ id: 1, priority: 10, name: 'first' }),
    ];
    const result = await evaluate(meta(), rules, 'arrival');
    expect(result?.rule.name).toBe('first');
  });

  it('skips disabled rules', async () => {
    const rules = [rule({ id: 1, enabled: 0 }), rule({ id: 2, name: 'enabled' })];
    expect((await evaluate(meta(), rules, 'arrival'))?.rule.name).toBe('enabled');
  });

  it('honours the trigger type; "both" matches either', async () => {
    const arrivalOnly = rule({ id: 1, trigger_type: 'arrival', name: 'arrival' });
    const scanOnly = rule({ id: 2, trigger_type: 'scan', name: 'scan' });
    const both = rule({ id: 3, trigger_type: 'both', name: 'both' });

    expect((await evaluate(meta(), [arrivalOnly, scanOnly, both], 'scan'))?.rule.name).toBe('scan');
    expect((await evaluate(meta(), [scanOnly, both], 'arrival'))?.rule.name).toBe('both');
    expect(await evaluate(meta(), [scanOnly], 'arrival')).toBeNull();
  });

  it('trigger "any" (a user-initiated scan) applies every enabled rule', async () => {
    const arrivalOnly = rule({ id: 1, trigger_type: 'arrival' });
    const scanOnly = rule({ id: 2, trigger_type: 'scan', priority: 0, name: 'scan' });
    expect((await evaluate(meta(), [arrivalOnly, scanOnly], 'any'))?.rule.name).toBe('scan');
  });

  it('returns null when nothing matches', async () => {
    const r = rule({ id: 1, condition: { field: 'kind', op: 'is', value: 'video' } });
    expect(await evaluate(meta(), [r], 'arrival')).toBeNull();
  });

  it('returns the matched rule\'s actions ordered by position', async () => {
    const r = rule({
      id: 1,
      actions: [
        { id: 2, rule_id: 1, position: 1, action_type: 'rename', params: {} },
        { id: 1, rule_id: 1, position: 0, action_type: 'move', params: {} },
      ],
    });
    const result = await evaluate(meta(), [r], 'arrival');
    expect(result?.actions.map((a) => a.action_type)).toEqual(['move', 'rename']);
  });
});
