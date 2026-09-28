import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Pencil, Trash2, ListFilter, GripVertical } from "lucide-react";
import type { Rule, Condition, ConditionGroup } from "../../lib/types";
import { getRules, deleteRule, toggleRule } from "../../lib/commands";
import Toggle from "../../components/Toggle";
import EmptyState from "../../components/EmptyState";
import Modal from "../../components/Modal";
import Badge from "../../components/ui/Badge";
import Button from "../../components/ui/Button";
import PageHeader from "../../components/ui/PageHeader";
import { Card } from "../../components/ui/Card";
import { Table, THead, Th, TRow, Td } from "../../components/ui/Table";
import { LoadingState } from "../../components/ui/Spinner";

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

  if (loading) return <LoadingState />;

  return (
    <div>
      <PageHeader
        title="Rules"
        description="Define how your files should be organized"
        actions={
          <Button
            variant="primary"
            onClick={() => navigate("/rules/new")}
            icon={<Plus size={14} />}
          >
            New Rule
          </Button>
        }
      />

      {rules.length === 0 ? (
        <Card>
          <EmptyState
            icon={ListFilter}
            title="No rules yet"
            description="Create your first rule to start organizing files automatically."
            actionLabel="Create Rule"
            onAction={() => navigate("/rules/new")}
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <Table>
            <THead>
              <tr>
                <Th className="w-8" />
                <Th className="w-56">Rule</Th>
                <Th>Conditions</Th>
                <Th className="w-20 text-center">Priority</Th>
                <Th className="w-20 text-center">Enabled</Th>
                <Th className="w-24" />
              </tr>
            </THead>
            <tbody>
              {rules.map((rule) => (
                <TRow key={rule.id}>
                  <Td>
                    <GripVertical size={14} className="cursor-grab text-fg-subtle" />
                  </Td>
                  <Td>
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-medium text-fg" title={rule.name}>
                        {rule.name}
                      </span>
                      <Badge tone="neutral" size="sm" className="shrink-0">
                        {rule.trigger}
                      </Badge>
                    </div>
                  </Td>
                  <Td className="text-fg-muted">
                    <code
                      className="block truncate text-xs"
                      title={summarizeCondition(rule.condition)}
                    >
                      {summarizeCondition(rule.condition)}
                    </code>
                  </Td>
                  <Td className="text-center font-mono text-xs text-fg-muted">
                    {rule.priority}
                  </Td>
                  <Td className="text-center">
                    <Toggle checked={rule.enabled} onChange={() => handleToggle(rule)} />
                  </Td>
                  <Td>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        aria-label="Edit rule"
                        icon={<Pencil size={14} />}
                        onClick={() => navigate(`/rules/${rule.id}/edit`)}
                      />
                      <Button
                        variant="ghostDanger"
                        size="sm"
                        iconOnly
                        aria-label="Delete rule"
                        icon={<Trash2 size={14} />}
                        onClick={() => setDeleteTarget(rule)}
                      />
                    </div>
                  </Td>
                </TRow>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete Rule"
      >
        <p className="mb-6 text-sm text-fg-muted">
          Are you sure you want to delete &ldquo;{deleteTarget?.name}&rdquo;? This action
          cannot be undone.
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={() => setDeleteTarget(null)}>
            Cancel
          </Button>
          <Button variant="danger" onClick={handleDelete}>
            Delete
          </Button>
        </div>
      </Modal>
    </div>
  );
}
