import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Plus, X, FlaskConical, Save, ArrowLeft } from "lucide-react";
import type {
  Rule,
  RuleAction,
  ConditionLeaf,
  ConditionOp,
  ActionType,
  TriggerType,
  ConflictPolicy,
} from "../../lib/types";
import { createRule, updateRule, getRules, testRule } from "../../lib/commands";

const FIELD_OPTIONS = [
  { value: "extension", label: "File Extension" },
  { value: "name", label: "File Name" },
  { value: "size", label: "File Size" },
  { value: "kind", label: "File Kind" },
  { value: "source_folder", label: "Source Folder" },
];

const OPS_BY_FIELD: Record<string, { value: ConditionOp; label: string }[]> = {
  extension: [
    { value: "is", label: "is" },
    { value: "in", label: "is one of" },
    { value: "not_in", label: "is not one of" },
  ],
  name: [
    { value: "contains", label: "contains" },
    { value: "starts_with", label: "starts with" },
    { value: "ends_with", label: "ends with" },
    { value: "equals", label: "equals" },
    { value: "matches", label: "matches regex" },
    { value: "glob", label: "matches glob" },
  ],
  size: [
    { value: "gt", label: "greater than" },
    { value: "lt", label: "less than" },
    { value: "between", label: "between" },
  ],
  kind: [
    { value: "is", label: "is" },
    { value: "in", label: "is one of" },
  ],
  source_folder: [{ value: "is", label: "is" }],
};

const KIND_OPTIONS = [
  "document",
  "image",
  "video",
  "audio",
  "archive",
  "code",
  "installer",
  "other",
];

interface ConditionRow {
  id: number;
  field: string;
  op: ConditionOp;
  value: string;
}

interface ActionRow {
  id: number;
  action_type: ActionType;
  destination: string;
  pattern: string;
  on_conflict: ConflictPolicy;
}

let nextCondId = 1;
let nextActionId = 1;

function inputClass(): string {
  return "w-full px-3 py-2 rounded-lg text-sm outline-none transition-colors";
}

export default function RuleBuilder() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isEditing = Boolean(id);

  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState<TriggerType>("arrival");
  const [groupType, setGroupType] = useState<"all" | "any">("all");
  const [conditions, setConditions] = useState<ConditionRow[]>([
    { id: nextCondId++, field: "extension", op: "is", value: "" },
  ]);
  const [actions, setActions] = useState<ActionRow[]>([
    {
      id: nextActionId++,
      action_type: "move",
      destination: "",
      pattern: "",
      on_conflict: "auto_rename",
    },
  ]);
  const [testFilename, setTestFilename] = useState("");
  const [testResult, setTestResult] = useState<{
    matched: boolean;
    rule_name?: string;
    destination?: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!id) return;
    (async () => {
      try {
        const rules = await getRules();
        const rule = rules.find((r) => r.id === Number(id));
        if (!rule) return;
        setName(rule.name);
        setTrigger(rule.trigger);

        const cond = rule.condition;
        if ("all" in cond || "any" in cond) {
          const isAll = "all" in cond;
          setGroupType(isAll ? "all" : "any");
          const items = (isAll ? (cond as { all: ConditionLeaf[] }).all : (cond as { any: ConditionLeaf[] }).any) ?? [];
          setConditions(
            items.map((leaf) => ({
              id: nextCondId++,
              field: (leaf as ConditionLeaf).field,
              op: (leaf as ConditionLeaf).op,
              value: Array.isArray((leaf as ConditionLeaf).value)
                ? ((leaf as ConditionLeaf).value as string[]).join(", ")
                : String((leaf as ConditionLeaf).value),
            })),
          );
        } else {
          const leaf = cond as ConditionLeaf;
          setConditions([
            {
              id: nextCondId++,
              field: leaf.field,
              op: leaf.op,
              value: Array.isArray(leaf.value)
                ? (leaf.value as string[]).join(", ")
                : String(leaf.value),
            },
          ]);
        }

        setActions(
          rule.actions.map((a) => ({
            id: nextActionId++,
            action_type: a.action_type,
            destination: a.params.destination ?? "",
            pattern: a.params.pattern ?? "",
            on_conflict: a.params.on_conflict ?? "auto_rename",
          })),
        );
      } catch {
        // ignore load error
      }
    })();
  }, [id]);

  function addCondition() {
    setConditions((prev) => [
      ...prev,
      { id: nextCondId++, field: "extension", op: "is" as ConditionOp, value: "" },
    ]);
  }

  function removeCondition(condId: number) {
    setConditions((prev) => prev.filter((c) => c.id !== condId));
  }

  function updateCondition(condId: number, update: Partial<ConditionRow>) {
    setConditions((prev) =>
      prev.map((c) => {
        if (c.id !== condId) return c;
        const merged = { ...c, ...update };
        if (update.field && update.field !== c.field) {
          const ops = OPS_BY_FIELD[update.field] ?? [];
          merged.op = ops[0]?.value ?? ("is" as ConditionOp);
          merged.value = "";
        }
        return merged;
      }),
    );
  }

  function addAction() {
    setActions((prev) => [
      ...prev,
      {
        id: nextActionId++,
        action_type: "move",
        destination: "",
        pattern: "",
        on_conflict: "auto_rename",
      },
    ]);
  }

  function removeAction(actionId: number) {
    setActions((prev) => prev.filter((a) => a.id !== actionId));
  }

  function updateAction(actionId: number, update: Partial<ActionRow>) {
    setActions((prev) =>
      prev.map((a) => (a.id === actionId ? { ...a, ...update } : a)),
    );
  }

  function parseValue(field: string, raw: string): string | string[] | number {
    if (field === "size") return Number(raw) || 0;
    if (["extension", "kind"].includes(field) && raw.includes(",")) {
      return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    }
    return raw;
  }

  function buildRule(): Rule {
    const condLeaves: ConditionLeaf[] = conditions.map((c) => ({
      field: c.field as ConditionLeaf["field"],
      op: c.op,
      value: parseValue(c.field, c.value),
    }));

    const condition =
      condLeaves.length === 1
        ? condLeaves[0]
        : { [groupType]: condLeaves };

    const ruleActions: RuleAction[] = actions.map((a, i) => ({
      position: i,
      action_type: a.action_type,
      params: {
        ...(a.destination ? { destination: a.destination } : {}),
        ...(a.pattern ? { pattern: a.pattern } : {}),
        on_conflict: a.on_conflict,
      },
    }));

    return {
      ...(id ? { id: Number(id) } : {}),
      name,
      enabled: true,
      priority: 0,
      trigger,
      condition,
      stop_after: true,
      actions: ruleActions,
    };
  }

  async function handleSave() {
    if (!name.trim()) {
      setError("Rule name is required.");
      return;
    }
    if (conditions.length === 0) {
      setError("At least one condition is required.");
      return;
    }
    if (actions.length === 0) {
      setError("At least one action is required.");
      return;
    }
    setError("");
    setSaving(true);
    try {
      const rule = buildRule();
      if (isEditing) {
        await updateRule(rule);
      } else {
        await createRule(rule);
      }
      navigate("/rules");
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    if (!testFilename.trim()) return;
    try {
      const result = await testRule(testFilename, id ? Number(id) : undefined);
      setTestResult(result);
    } catch {
      setTestResult({ matched: false });
    }
  }

  async function handlePickFolder(actionId: number) {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, multiple: false, title: "Select destination folder" });
      if (selected) updateAction(actionId, { destination: selected as string });
    } catch {
      // dialog cancelled
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate("/rules")}
          className="p-2 rounded-lg cursor-pointer"
          style={{ color: "var(--text-secondary)" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-primary)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-secondary)")}
        >
          <ArrowLeft size={20} />
        </button>
        <div>
          <h1 className="text-2xl font-bold" style={{ color: "var(--text-primary)" }}>
            {isEditing ? "Edit Rule" : "New Rule"}
          </h1>
          <p className="text-sm mt-0.5" style={{ color: "var(--text-secondary)" }}>
            {isEditing
              ? "Modify this rule's conditions and actions"
              : "Define conditions and actions for automatic file organization"}
          </p>
        </div>
      </div>

      {error && (
        <div
          className="px-4 py-3 rounded-lg text-sm"
          style={{
            backgroundColor: "var(--danger-light)",
            color: "var(--danger)",
            border: "1px solid var(--danger)",
          }}
        >
          {error}
        </div>
      )}

      {/* Name & Trigger */}
      <div
        className="rounded-xl p-6 space-y-4"
        style={{
          backgroundColor: "var(--bg-primary)",
          border: "1px solid var(--border-color)",
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <div>
          <label
            className="block text-xs font-medium mb-1.5"
            style={{ color: "var(--text-secondary)" }}
          >
            Rule Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Sort PDFs to Documents"
            className={inputClass()}
            style={{
              backgroundColor: "var(--bg-secondary)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-color)",
            }}
          />
        </div>
        <div>
          <label
            className="block text-xs font-medium mb-1.5"
            style={{ color: "var(--text-secondary)" }}
          >
            Trigger
          </label>
          <select
            value={trigger}
            onChange={(e) => setTrigger(e.target.value as TriggerType)}
            className={inputClass() + " cursor-pointer"}
            style={{
              backgroundColor: "var(--bg-secondary)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-color)",
            }}
          >
            <option value="arrival">On file arrival</option>
            <option value="scan">On scheduled scan</option>
            <option value="both">Both</option>
          </select>
        </div>
      </div>

      {/* Conditions */}
      <div
        className="rounded-xl p-6"
        style={{
          backgroundColor: "var(--bg-primary)",
          border: "1px solid var(--border-color)",
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <div className="flex items-center justify-between mb-4">
          <h2
            className="text-base font-semibold"
            style={{ color: "var(--text-primary)" }}
          >
            Conditions
          </h2>
          <div className="flex items-center gap-2">
            {conditions.length > 1 && (
              <div
                className="flex rounded-lg overflow-hidden text-xs"
                style={{ border: "1px solid var(--border-color)" }}
              >
                <button
                  onClick={() => setGroupType("all")}
                  className="px-3 py-1 cursor-pointer font-medium"
                  style={{
                    backgroundColor:
                      groupType === "all"
                        ? "var(--accent)"
                        : "var(--bg-secondary)",
                    color:
                      groupType === "all" ? "white" : "var(--text-secondary)",
                  }}
                >
                  AND
                </button>
                <button
                  onClick={() => setGroupType("any")}
                  className="px-3 py-1 cursor-pointer font-medium"
                  style={{
                    backgroundColor:
                      groupType === "any"
                        ? "var(--accent)"
                        : "var(--bg-secondary)",
                    color:
                      groupType === "any" ? "white" : "var(--text-secondary)",
                  }}
                >
                  OR
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="space-y-3">
          {conditions.map((cond, idx) => {
            const ops = OPS_BY_FIELD[cond.field] ?? [];
            const showKindSelect =
              cond.field === "kind" && (cond.op === "is" || cond.op === "in");

            return (
              <div key={cond.id}>
                {idx > 0 && (
                  <div
                    className="text-xs font-medium text-center py-1"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {groupType === "all" ? "AND" : "OR"}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <select
                    value={cond.field}
                    onChange={(e) =>
                      updateCondition(cond.id, { field: e.target.value })
                    }
                    className="px-3 py-2 rounded-lg text-sm cursor-pointer min-w-[140px]"
                    style={{
                      backgroundColor: "var(--bg-secondary)",
                      color: "var(--text-primary)",
                      border: "1px solid var(--border-color)",
                    }}
                  >
                    {FIELD_OPTIONS.map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </select>

                  <select
                    value={cond.op}
                    onChange={(e) =>
                      updateCondition(cond.id, {
                        op: e.target.value as ConditionOp,
                      })
                    }
                    className="px-3 py-2 rounded-lg text-sm cursor-pointer min-w-[130px]"
                    style={{
                      backgroundColor: "var(--bg-secondary)",
                      color: "var(--text-primary)",
                      border: "1px solid var(--border-color)",
                    }}
                  >
                    {ops.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>

                  {showKindSelect ? (
                    <select
                      value={cond.value}
                      onChange={(e) =>
                        updateCondition(cond.id, { value: e.target.value })
                      }
                      className="flex-1 px-3 py-2 rounded-lg text-sm cursor-pointer"
                      style={{
                        backgroundColor: "var(--bg-secondary)",
                        color: "var(--text-primary)",
                        border: "1px solid var(--border-color)",
                      }}
                    >
                      <option value="">Select kind...</option>
                      {KIND_OPTIONS.map((k) => (
                        <option key={k} value={k}>
                          {k}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={cond.field === "size" ? "number" : "text"}
                      value={cond.value}
                      onChange={(e) =>
                        updateCondition(cond.id, { value: e.target.value })
                      }
                      placeholder={
                        cond.field === "extension"
                          ? "e.g., pdf or pdf, docx, txt"
                          : cond.field === "size"
                            ? "Size in bytes"
                            : cond.field === "name"
                              ? "e.g., report"
                              : "Value"
                      }
                      className="flex-1 px-3 py-2 rounded-lg text-sm outline-none"
                      style={{
                        backgroundColor: "var(--bg-secondary)",
                        color: "var(--text-primary)",
                        border: "1px solid var(--border-color)",
                      }}
                    />
                  )}

                  {conditions.length > 1 && (
                    <button
                      onClick={() => removeCondition(cond.id)}
                      className="p-2 rounded-md cursor-pointer"
                      style={{ color: "var(--text-muted)" }}
                      onMouseEnter={(e) =>
                        (e.currentTarget.style.color = "var(--danger)")
                      }
                      onMouseLeave={(e) =>
                        (e.currentTarget.style.color = "var(--text-muted)")
                      }
                    >
                      <X size={16} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <button
          onClick={addCondition}
          className="flex items-center gap-1.5 mt-4 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer"
          style={{
            color: "var(--accent)",
            backgroundColor: "var(--accent-light)",
          }}
        >
          <Plus size={14} />
          Add Condition
        </button>
      </div>

      {/* Actions */}
      <div
        className="rounded-xl p-6"
        style={{
          backgroundColor: "var(--bg-primary)",
          border: "1px solid var(--border-color)",
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <h2
          className="text-base font-semibold mb-4"
          style={{ color: "var(--text-primary)" }}
        >
          Actions
        </h2>

        <div className="space-y-3">
          {actions.map((act) => (
            <div key={act.id} className="flex items-start gap-2">
              <select
                value={act.action_type}
                onChange={(e) =>
                  updateAction(act.id, {
                    action_type: e.target.value as ActionType,
                  })
                }
                className="px-3 py-2 rounded-lg text-sm cursor-pointer min-w-[120px]"
                style={{
                  backgroundColor: "var(--bg-secondary)",
                  color: "var(--text-primary)",
                  border: "1px solid var(--border-color)",
                }}
              >
                <option value="move">Move</option>
                <option value="copy">Copy</option>
                <option value="rename">Rename</option>
                <option value="trash">Trash</option>
                <option value="ignore">Ignore</option>
              </select>

              {(act.action_type === "move" || act.action_type === "copy") && (
                <div className="flex-1 flex gap-2">
                  <input
                    type="text"
                    value={act.destination}
                    onChange={(e) =>
                      updateAction(act.id, { destination: e.target.value })
                    }
                    placeholder="Destination folder (e.g., Documents/{kind})"
                    className="flex-1 px-3 py-2 rounded-lg text-sm outline-none"
                    style={{
                      backgroundColor: "var(--bg-secondary)",
                      color: "var(--text-primary)",
                      border: "1px solid var(--border-color)",
                    }}
                  />
                  <button
                    onClick={() => handlePickFolder(act.id)}
                    className="px-3 py-2 rounded-lg text-xs font-medium cursor-pointer whitespace-nowrap"
                    style={{
                      backgroundColor: "var(--bg-tertiary)",
                      color: "var(--text-secondary)",
                      border: "1px solid var(--border-color)",
                    }}
                  >
                    Browse
                  </button>
                </div>
              )}

              {act.action_type === "rename" && (
                <input
                  type="text"
                  value={act.pattern}
                  onChange={(e) =>
                    updateAction(act.id, { pattern: e.target.value })
                  }
                  placeholder="Pattern (e.g., {date}_{name:clean}.{ext})"
                  className="flex-1 px-3 py-2 rounded-lg text-sm outline-none"
                  style={{
                    backgroundColor: "var(--bg-secondary)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--border-color)",
                  }}
                />
              )}

              {(act.action_type === "trash" || act.action_type === "ignore") && (
                <div
                  className="flex-1 px-3 py-2 rounded-lg text-sm"
                  style={{ color: "var(--text-muted)" }}
                >
                  {act.action_type === "trash"
                    ? "Move to system recycle bin"
                    : "Skip this file (stop matching further rules)"}
                </div>
              )}

              {actions.length > 1 && (
                <button
                  onClick={() => removeAction(act.id)}
                  className="p-2 rounded-md cursor-pointer mt-0.5"
                  style={{ color: "var(--text-muted)" }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.color = "var(--danger)")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.color = "var(--text-muted)")
                  }
                >
                  <X size={16} />
                </button>
              )}
            </div>
          ))}
        </div>

        <button
          onClick={addAction}
          className="flex items-center gap-1.5 mt-4 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer"
          style={{
            color: "var(--accent)",
            backgroundColor: "var(--accent-light)",
          }}
        >
          <Plus size={14} />
          Add Action
        </button>
      </div>

      {/* Live Test */}
      <div
        className="rounded-xl p-6"
        style={{
          backgroundColor: "var(--bg-primary)",
          border: "1px solid var(--border-color)",
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <h2
          className="text-base font-semibold mb-3"
          style={{ color: "var(--text-primary)" }}
        >
          Test Rule
        </h2>
        <div className="flex gap-2">
          <input
            type="text"
            value={testFilename}
            onChange={(e) => {
              setTestFilename(e.target.value);
              setTestResult(null);
            }}
            placeholder="Enter a filename to test (e.g., report.pdf)"
            className="flex-1 px-3 py-2 rounded-lg text-sm outline-none"
            style={{
              backgroundColor: "var(--bg-secondary)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-color)",
            }}
            onKeyDown={(e) => e.key === "Enter" && handleTest()}
          />
          <button
            onClick={handleTest}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium cursor-pointer"
            style={{
              backgroundColor: "var(--bg-tertiary)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-color)",
            }}
          >
            <FlaskConical size={14} />
            Test
          </button>
        </div>
        {testResult && (
          <div
            className="mt-3 px-4 py-3 rounded-lg text-sm"
            style={{
              backgroundColor: testResult.matched
                ? "var(--success-light)"
                : "var(--bg-tertiary)",
              color: testResult.matched
                ? "var(--success)"
                : "var(--text-muted)",
            }}
          >
            {testResult.matched ? (
              <>
                <strong>Match!</strong>
                {testResult.destination && (
                  <> — would move to <code>{testResult.destination}</code></>
                )}
              </>
            ) : (
              "No match — this file would not be affected by this rule."
            )}
          </div>
        )}
      </div>

      {/* Save */}
      <div className="flex items-center justify-end gap-3 pb-8">
        <button
          onClick={() => navigate("/rules")}
          className="px-4 py-2 rounded-lg text-sm font-medium cursor-pointer"
          style={{
            backgroundColor: "var(--bg-tertiary)",
            color: "var(--text-primary)",
          }}
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium text-white cursor-pointer disabled:opacity-50"
          style={{ backgroundColor: "var(--accent)" }}
          onMouseEnter={(e) =>
            (e.currentTarget.style.backgroundColor = "var(--accent-hover)")
          }
          onMouseLeave={(e) =>
            (e.currentTarget.style.backgroundColor = "var(--accent)")
          }
        >
          <Save size={16} />
          {saving ? "Saving..." : isEditing ? "Update Rule" : "Create Rule"}
        </button>
      </div>
    </div>
  );
}
