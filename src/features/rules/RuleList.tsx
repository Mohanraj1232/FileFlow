import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Pencil, Trash2, ListFilter, GripVertical } from "lucide-react";
import type { Rule, Condition, ConditionGroup } from "../../lib/types";
import { getRules, deleteRule, toggleRule } from "../../lib/commands";
import Toggle from "../../components/Toggle";
import EmptyState from "../../components/EmptyState";
import Modal from "../../components/Modal";

function summarizeCondition(cond: Condition): string {
  if ("all" in cond) {
    const g = cond as ConditionGroup;
    const parts = (g.all ?? g.any ?? []).map(summarizeCondition);
    const joiner = g.all ? " AND " : " OR ";
    return parts.join(joiner);
  }
  const leaf = cond as { field: string; op: string; value: unknown };
  const val = Array.isArray(leaf.value)
    ? (leaf.value as string[]).join(", ")
    : String(leaf.value);
  return `${leaf.field} ${leaf.op} ${val}`;
}

export default function RuleList() {
  const navigate = useNavigate();
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<Rule | null>(null);

  async function loadRules() {
    setLoading(true);
    try {
      const data = await getRules();
      setRules(data);
    } catch {
      setRules([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadRules();
  }, []);

  async function handleDelete() {
    if (!deleteTarget?.id) return;
    try {
      await deleteRule(deleteTarget.id);
      setDeleteTarget(null);
      loadRules();
    } catch {
      // ignore
    }
  }

  async function handleToggle(rule: Rule) {
    if (!rule.id) return;
    try {
      await toggleRule(rule.id, !rule.enabled);
      setRules((prev) =>
        prev.map((r) =>
          r.id === rule.id ? { ...r, enabled: !r.enabled } : r,
        ),
      );
    } catch {
      // ignore
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div
          className="w-8 h-8 border-3 border-t-transparent rounded-full animate-spin"
          style={{ borderColor: "var(--accent)", borderTopColor: "transparent" }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: "var(--text-primary)" }}>
            Rules
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--text-secondary)" }}>
            Define how your files should be organized
          </p>
        </div>
        <button
          onClick={() => navigate("/rules/new")}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white cursor-pointer"
          style={{ backgroundColor: "var(--accent)" }}
          onMouseEnter={(e) =>
            (e.currentTarget.style.backgroundColor = "var(--accent-hover)")
          }
          onMouseLeave={(e) =>
            (e.currentTarget.style.backgroundColor = "var(--accent)")
          }
        >
          <Plus size={16} />
          New Rule
        </button>
      </div>

      {rules.length === 0 ? (
        <div
          className="rounded-xl"
          style={{
            backgroundColor: "var(--bg-primary)",
            border: "1px solid var(--border-color)",
          }}
        >
          <EmptyState
            icon={ListFilter}
            title="No rules yet"
            description="Create your first rule to start organizing files automatically."
            actionLabel="Create Rule"
            onAction={() => navigate("/rules/new")}
          />
        </div>
      ) : (
        <div
          className="rounded-xl overflow-hidden"
          style={{
            backgroundColor: "var(--bg-primary)",
            border: "1px solid var(--border-color)",
            boxShadow: "var(--shadow-sm)",
          }}
        >
          <table className="w-full">
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border-color)" }}>
                <th className="w-8 px-4 py-3" />
                <th
                  className="text-left text-xs font-medium uppercase tracking-wider px-4 py-3"
                  style={{ color: "var(--text-muted)" }}
                >
                  Rule
                </th>
                <th
                  className="text-left text-xs font-medium uppercase tracking-wider px-4 py-3"
                  style={{ color: "var(--text-muted)" }}
                >
                  Conditions
                </th>
                <th
                  className="text-center text-xs font-medium uppercase tracking-wider px-4 py-3"
                  style={{ color: "var(--text-muted)" }}
                >
                  Priority
                </th>
                <th
                  className="text-center text-xs font-medium uppercase tracking-wider px-4 py-3"
                  style={{ color: "var(--text-muted)" }}
                >
                  Enabled
                </th>
                <th className="w-24 px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr
                  key={rule.id}
                  style={{ borderBottom: "1px solid var(--border-color)" }}
                  className="group"
                >
                  <td className="px-4 py-3">
                    <GripVertical
                      size={14}
                      style={{ color: "var(--text-muted)" }}
                      className="cursor-grab"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className="text-sm font-medium"
                      style={{ color: "var(--text-primary)" }}
                    >
                      {rule.name}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className="text-xs"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      {summarizeCondition(rule.condition)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span
                      className="text-xs font-mono"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {rule.priority}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <Toggle
                      checked={rule.enabled}
                      onChange={() => handleToggle(rule)}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 justify-end">
                      <button
                        onClick={() => navigate(`/rules/${rule.id}/edit`)}
                        className="p-1.5 rounded-md cursor-pointer"
                        style={{ color: "var(--text-muted)" }}
                        onMouseEnter={(e) =>
                          (e.currentTarget.style.color = "var(--accent)")
                        }
                        onMouseLeave={(e) =>
                          (e.currentTarget.style.color = "var(--text-muted)")
                        }
                        title="Edit rule"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        onClick={() => setDeleteTarget(rule)}
                        className="p-1.5 rounded-md cursor-pointer"
                        style={{ color: "var(--text-muted)" }}
                        onMouseEnter={(e) =>
                          (e.currentTarget.style.color = "var(--danger)")
                        }
                        onMouseLeave={(e) =>
                          (e.currentTarget.style.color = "var(--text-muted)")
                        }
                        title="Delete rule"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete Rule"
      >
        <p className="text-sm mb-6" style={{ color: "var(--text-secondary)" }}>
          Are you sure you want to delete &ldquo;{deleteTarget?.name}&rdquo;? This action
          cannot be undone.
        </p>
        <div className="flex justify-end gap-3">
          <button
            onClick={() => setDeleteTarget(null)}
            className="px-4 py-2 rounded-lg text-sm font-medium cursor-pointer"
            style={{
              backgroundColor: "var(--bg-tertiary)",
              color: "var(--text-primary)",
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleDelete}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white cursor-pointer"
            style={{ backgroundColor: "var(--danger)" }}
          >
            Delete
          </button>
        </div>
      </Modal>
    </div>
  );
}
