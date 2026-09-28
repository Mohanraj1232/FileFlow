import { useState, useEffect } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Plus, X, FlaskConical, Save, ArrowLeft, FolderOpen } from "lucide-react";
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
import Button from "../../components/ui/Button";
import PageHeader from "../../components/ui/PageHeader";
import { Card, CardHeader, CardBody } from "../../components/ui/Card";
import { Label, Input, Select } from "../../components/ui/Field";

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

export default function RuleBuilder() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isEditing = Boolean(id);

  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState<TriggerType>("arrival");
  const [groupType, setGroupType] = useState<"all" | "any">("all");
  const [conditions, setConditions] = useState<ConditionRow[]>(() => {
    // Prefilled from Unsorted's "Create Rule" link (?ext=...&kind=...),
    // only when creating a new rule — an edit's useEffect below overwrites this.
    if (!isEditing) {
      const ext = searchParams.get("ext");
      const kind = searchParams.get("kind");
      if (ext) {
        return [{ id: nextCondId++, field: "extension", op: "is", value: ext }];
      }
      if (kind) {
        return [{ id: nextCondId++, field: "kind", op: "is", value: kind }];
      }
    }
    return [{ id: nextCondId++, field: "extension", op: "is", value: "" }];
  });
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
      const selected = await window.electronAPI.showOpenDialog();
      if (selected) updateAction(actionId, { destination: selected });
    } catch {
      // dialog cancelled
    }
  }

  return (
    <div>
      <PageHeader
        back={
          <Button
            variant="ghost"
            size="md"
            iconOnly
            aria-label="Back to Rules"
            icon={<ArrowLeft size={18} />}
            onClick={() => navigate("/rules")}
          />
        }
        title={isEditing ? "Edit Rule" : "New Rule"}
        description={
          isEditing
            ? "Modify this rule's conditions and actions"
            : "Define conditions and actions for automatic file organization"
        }
      />

      <div className="space-y-4 max-w-3xl">
        {error && (
          <div className="rounded-lg border border-danger bg-danger-soft px-4 py-3 text-sm text-danger">
            {error}
          </div>
        )}

        <Card>
          <CardBody className="space-y-4">
            <div>
              <Label>Rule Name</Label>
              <Input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Sort PDFs to Documents"
              />
            </div>
            <div>
              <Label>Trigger</Label>
              <Select
                value={trigger}
                onChange={(e) => setTrigger(e.target.value as TriggerType)}
                className="max-w-xs"
              >
                <option value="arrival">On file arrival</option>
                <option value="scan">On scheduled scan</option>
                <option value="both">Both</option>
              </Select>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Conditions"
            actions={
              conditions.length > 1 && (
                <div className="inline-flex overflow-hidden rounded-md border border-border text-xs">
                  <button
                    onClick={() => setGroupType("all")}
                    className={`cursor-pointer px-3 py-1 font-medium transition-colors ${
                      groupType === "all"
                        ? "bg-accent text-white"
                        : "bg-inset text-fg-muted hover:text-fg"
                    }`}
                  >
                    AND
                  </button>
                  <button
                    onClick={() => setGroupType("any")}
                    className={`cursor-pointer px-3 py-1 font-medium transition-colors ${
                      groupType === "any"
                        ? "bg-accent text-white"
                        : "bg-inset text-fg-muted hover:text-fg"
                    }`}
                  >
                    OR
                  </button>
                </div>
              )
            }
          />
          <CardBody>
            <div className="space-y-3">
              {conditions.map((cond, idx) => {
                const ops = OPS_BY_FIELD[cond.field] ?? [];
                const showKindSelect =
                  cond.field === "kind" && (cond.op === "is" || cond.op === "in");

                return (
                  <div key={cond.id}>
                    {idx > 0 && (
                      <div className="py-1 text-center text-xs font-medium text-fg-muted">
                        {groupType === "all" ? "AND" : "OR"}
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      {/* Fixed-width wrapper, not w-auto on the Select itself:
                          Select/Input share a base class that includes w-full,
                          and because of how Tailwind orders conflicting width
                          utilities in its generated stylesheet, a w-auto passed
                          alongside it does not reliably win — width:100% keeps
                          winning regardless of className order. A wrapper with
                          its own fixed width sidesteps the conflict entirely
                          (the Select just fills that wrapper's real width). */}
                      <div className="w-[150px] shrink-0">
                        <Select
                          value={cond.field}
                          onChange={(e) =>
                            updateCondition(cond.id, { field: e.target.value })
                          }
                        >
                          {FIELD_OPTIONS.map((f) => (
                            <option key={f.value} value={f.value}>
                              {f.label}
                            </option>
                          ))}
                        </Select>
                      </div>

                      <div className="w-[140px] shrink-0">
                        <Select
                          value={cond.op}
                          onChange={(e) =>
                            updateCondition(cond.id, {
                              op: e.target.value as ConditionOp,
                            })
                          }
                        >
                          {ops.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </Select>
                      </div>

                      {/* Wrapper claims the flex space; the control fills it with
                          plain w-full. Chromium's flex algorithm gives form
                          controls (input/select) special intrinsic-size handling
                          that can ignore flex-basis:0% when flex-1 is applied
                          directly to them, collapsing them to a tiny min-content
                          box instead of growing — wrapping in a plain div sidesteps
                          that entirely since divs don't have that special casing. */}
                      <div className="min-w-0 flex-1">
                        {showKindSelect ? (
                          <Select
                            value={cond.value}
                            onChange={(e) =>
                              updateCondition(cond.id, { value: e.target.value })
                            }
                          >
                            <option value="">Select kind...</option>
                            {KIND_OPTIONS.map((k) => (
                              <option key={k} value={k}>
                                {k}
                              </option>
                            ))}
                          </Select>
                        ) : (
                          <Input
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
                          />
                        )}
                      </div>

                      {conditions.length > 1 && (
                        <Button
                          variant="ghostDanger"
                          size="sm"
                          iconOnly
                          aria-label="Remove condition"
                          icon={<X size={16} />}
                          onClick={() => removeCondition(cond.id)}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <Button
              variant="soft"
              size="sm"
              className="mt-4"
              icon={<Plus size={14} />}
              onClick={addCondition}
            >
              Add Condition
            </Button>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Actions" />
          <CardBody>
            <div className="space-y-3">
              {actions.map((act) => (
                <div key={act.id} className="flex items-start gap-2">
                  <div className="w-[130px] shrink-0">
                    <Select
                      value={act.action_type}
                      onChange={(e) =>
                        updateAction(act.id, {
                          action_type: e.target.value as ActionType,
                        })
                      }
                    >
                      <option value="move">Move</option>
                      <option value="copy">Copy</option>
                      <option value="rename">Rename</option>
                      <option value="trash">Trash</option>
                      <option value="ignore">Ignore</option>
                    </Select>
                  </div>

                  {(act.action_type === "move" || act.action_type === "copy") && (
                    <div className="flex flex-1 gap-2">
                      <div className="min-w-0 flex-1">
                        <Input
                          type="text"
                          value={act.destination}
                          onChange={(e) =>
                            updateAction(act.id, { destination: e.target.value })
                          }
                          placeholder="Destination folder (e.g., Documents/{kind})"
                        />
                      </div>
                      <Button
                        variant="secondary"
                        icon={<FolderOpen size={14} />}
                        onClick={() => handlePickFolder(act.id)}
                        className="whitespace-nowrap"
                      >
                        Browse
                      </Button>
                    </div>
                  )}

                  {act.action_type === "rename" && (
                    <div className="min-w-0 flex-1">
                      <Input
                        type="text"
                        value={act.pattern}
                        onChange={(e) =>
                          updateAction(act.id, { pattern: e.target.value })
                        }
                        placeholder="Pattern (e.g., {date}_{name:clean}.{ext})"
                      />
                    </div>
                  )}

                  {(act.action_type === "trash" || act.action_type === "ignore") && (
                    <div className="flex-1 px-3 py-2 text-sm text-fg-muted">
                      {act.action_type === "trash"
                        ? "Move to system recycle bin"
                        : "Skip this file (stop matching further rules)"}
                    </div>
                  )}

                  {actions.length > 1 && (
                    <Button
                      variant="ghostDanger"
                      size="sm"
                      iconOnly
                      aria-label="Remove action"
                      icon={<X size={16} />}
                      onClick={() => removeAction(act.id)}
                      className="mt-0.5"
                    />
                  )}
                </div>
              ))}
            </div>

            <Button
              variant="soft"
              size="sm"
              className="mt-4"
              icon={<Plus size={14} />}
              onClick={addAction}
            >
              Add Action
            </Button>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Test Rule" />
          <CardBody>
            <div className="flex gap-2">
              <div className="min-w-0 flex-1">
                <Input
                  type="text"
                  value={testFilename}
                  onChange={(e) => {
                    setTestFilename(e.target.value);
                    setTestResult(null);
                  }}
                  placeholder="Enter a filename to test (e.g., report.pdf)"
                  onKeyDown={(e) => e.key === "Enter" && handleTest()}
                />
              </div>
              <Button
                variant="secondary"
                icon={<FlaskConical size={14} />}
                onClick={handleTest}
              >
                Test
              </Button>
            </div>
            {testResult && (
              <div
                className={`mt-3 rounded-lg px-4 py-3 text-sm ${
                  testResult.matched
                    ? "bg-success-soft text-success"
                    : "bg-inset text-fg-muted"
                }`}
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
          </CardBody>
        </Card>

        <div className="sticky bottom-4 flex justify-end gap-3 rounded-xl border border-border bg-surface px-5 py-4 shadow-pop">
          <Button variant="secondary" onClick={() => navigate("/rules")}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={saving}
            icon={<Save size={16} />}
            onClick={handleSave}
          >
            {saving ? "Saving..." : isEditing ? "Update Rule" : "Create Rule"}
          </Button>
        </div>
      </div>
    </div>
  );
}
