// Rule evaluation engine — pure logic, no I/O side effects

interface Condition {
  all?: Condition[];
  any?: Condition[];
  field?: string;
  op?: string;
  value?: any;
}

interface RuleAction {
  id: number;
  rule_id: number;
  position: number;
  action_type: string;
  params: any;
}

interface Rule {
  id: number;
  name: string;
  enabled: number;
  priority: number;
  trigger_type: string;
  condition: Condition;
  stop_after: number;
  scope_folder: number | null;
  actions: RuleAction[];
}

interface FileMeta {
  name: string;
  extension: string;
  size: number;
  mtime: Date;
  kind: string;
  path: string;
  sourceFolder: string;
}

interface EvalResult {
  rule: Rule;
  actions: RuleAction[];
}

// Cached picomatch import promise (ESM-only package)
let picomatchPromise: Promise<any> | null = null;

function getPicomatch(): Promise<any> {
  if (!picomatchPromise) {
    picomatchPromise = import('picomatch').then((m) => m.default || m);
  }
  return picomatchPromise;
}

// Picomatch cache for compiled glob patterns
const globCache = new Map<string, (input: string) => boolean>();

async function getGlobMatcher(
  pattern: string
): Promise<(input: string) => boolean> {
  const cached = globCache.get(pattern);
  if (cached) return cached;

  const picomatch = await getPicomatch();
  const matcher = picomatch(pattern, { nocase: true });
  globCache.set(pattern, matcher);
  return matcher;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

async function evaluateLeaf(fileMeta: FileMeta, cond: Condition): Promise<boolean> {
  const { field, op, value } = cond;
  if (!field || !op) return false;

  switch (field) {
    case 'extension': {
      const ext = fileMeta.extension.toLowerCase();
      switch (op) {
        case 'is':
          return ext === String(value).toLowerCase().replace(/^\./, '');
        case 'in': {
          const list = Array.isArray(value)
            ? value
            : String(value).split(',').map((s: string) => s.trim());
          return list.some(
            (v: string) => v.toLowerCase().replace(/^\./, '') === ext
          );
        }
        case 'not_in': {
          const list = Array.isArray(value)
            ? value
            : String(value).split(',').map((s: string) => s.trim());
          return !list.some(
            (v: string) => v.toLowerCase().replace(/^\./, '') === ext
          );
        }
        default:
          return false;
      }
    }

    case 'name': {
      const name = fileMeta.name;
      switch (op) {
        case 'contains':
          return name.toLowerCase().includes(String(value).toLowerCase());
        case 'starts_with':
          return name.toLowerCase().startsWith(String(value).toLowerCase());
        case 'ends_with':
          return name.toLowerCase().endsWith(String(value).toLowerCase());
        case 'equals':
          return name.toLowerCase() === String(value).toLowerCase();
        case 'matches': {
          try {
            const regex = new RegExp(String(value), 'i');
            return regex.test(name);
          } catch {
            return false;
          }
        }
        case 'glob': {
          const matcher = await getGlobMatcher(String(value));
          return matcher(name);
        }
        default:
          return false;
      }
    }

    case 'size': {
      const size = fileMeta.size;
      switch (op) {
        case 'gt':
          return size > Number(value);
        case 'lt':
          return size < Number(value);
        case 'between': {
          const bounds = Array.isArray(value)
            ? value
            : String(value).split(',').map((s: string) => Number(s.trim()));
          return size >= Number(bounds[0]) && size <= Number(bounds[1]);
        }
        default:
          return false;
      }
    }

    case 'kind': {
      const kind = fileMeta.kind;
      switch (op) {
        case 'is':
          return kind === String(value).toLowerCase();
        case 'in': {
          const list = Array.isArray(value)
            ? value
            : String(value).split(',').map((s: string) => s.trim());
          return list.some((v: string) => v.toLowerCase() === kind);
        }
        default:
          return false;
      }
    }

    case 'source_folder': {
      switch (op) {
        case 'is':
          return (
            normalizePath(fileMeta.sourceFolder) ===
            normalizePath(String(value))
          );
        default:
          return false;
      }
    }

    default:
      return false;
  }
}

async function evaluateCondition(
  fileMeta: FileMeta,
  cond: Condition
): Promise<boolean> {
  // AND group
  if (cond.all && Array.isArray(cond.all)) {
    for (const child of cond.all) {
      if (!(await evaluateCondition(fileMeta, child))) {
        return false;
      }
    }
    return true;
  }

  // OR group
  if (cond.any && Array.isArray(cond.any)) {
    for (const child of cond.any) {
      if (await evaluateCondition(fileMeta, child)) {
        return true;
      }
    }
    return false;
  }

  // Leaf condition
  return evaluateLeaf(fileMeta, cond);
}

async function evaluate(
  fileMeta: FileMeta,
  rules: Rule[],
  trigger: string
): Promise<EvalResult | null> {
  // Filter enabled rules matching trigger type, sort by priority (lower number = higher priority)
  const candidateRules = rules
    .filter((r) => r.enabled === 1 && r.trigger_type === trigger)
    .sort((a, b) => a.priority - b.priority);

  for (const rule of candidateRules) {
    const condition =
      typeof rule.condition === 'string'
        ? JSON.parse(rule.condition)
        : rule.condition;

    const matched = await evaluateCondition(fileMeta, condition);
    if (matched) {
      return {
        rule,
        actions: rule.actions.sort((a, b) => a.position - b.position),
      };
    }
  }

  return null;
}

module.exports = { evaluate, evaluateCondition };
