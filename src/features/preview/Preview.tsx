import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { Play, Eye, CheckSquare, Square, Loader2 } from "lucide-react";
import type { WatchedFolder, PlanSummary, PlannedStep } from "../../lib/types";
import {
  getWatchedFolders,
  previewFolder,
  applyPlan,
} from "../../lib/commands";
import StatusBadge from "../../components/StatusBadge";
import EmptyState from "../../components/EmptyState";

export default function Preview() {
  const { folderId: paramFolderId } = useParams();
  const [folders, setFolders] = useState<WatchedFolder[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<number | "">("");
  const [plan, setPlan] = useState<PlanSummary | null>(null);
  const [scanning, setScanning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const f = await getWatchedFolders();
        setFolders(f);
        if (paramFolderId) {
          setSelectedFolder(Number(paramFolderId));
        } else if (f.length > 0) {
          setSelectedFolder(f[0].id);
        }
      } catch {
        setFolders([]);
      }
    })();
  }, [paramFolderId]);

  async function handleScan() {
    if (!selectedFolder) return;
    setScanning(true);
    setPlan(null);
    setMessage(null);
    try {
      const result = await previewFolder(selectedFolder as number);
      setPlan(result);
    } catch (e) {
      setMessage({ type: "error", text: String(e) });
    } finally {
      setScanning(false);
    }
  }

  function toggleStep(idx: number) {
    if (!plan) return;
    setPlan({
      ...plan,
      steps: plan.steps.map((s, i) =>
        i === idx ? { ...s, selected: !s.selected } : s,
      ),
    });
  }

  function toggleAll(selected: boolean) {
    if (!plan) return;
    setPlan({
      ...plan,
      steps: plan.steps.map((s) => ({ ...s, selected })),
    });
  }

  async function handleApply() {
    if (!plan || !selectedFolder) return;
    const selectedPaths = plan.steps
      .filter((s) => s.selected)
      .map((s) => s.src_path);
    if (selectedPaths.length === 0) {
      setMessage({ type: "error", text: "No files selected." });
      return;
    }
    setApplying(true);
    setMessage(null);
    try {
      const op = await applyPlan(selectedFolder as number, selectedPaths);
      setMessage({
        type: "success",
        text: `Operation completed: ${op.summary ?? "files organized successfully"}.`,
      });
      setPlan(null);
    } catch (e) {
      setMessage({ type: "error", text: String(e) });
    } finally {
      setApplying(false);
    }
  }

  const selectedCount = plan?.steps.filter((s) => s.selected).length ?? 0;

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1
          className="text-2xl font-bold"
          style={{ color: "var(--text-primary)" }}
        >
          Preview
        </h1>
        <p className="text-sm mt-1" style={{ color: "var(--text-secondary)" }}>
          Scan a folder, review the plan, then apply
        </p>
      </div>

      {message && (
        <div
          className="px-4 py-3 rounded-lg text-sm"
          style={{
            backgroundColor:
              message.type === "success"
                ? "var(--success-light)"
                : "var(--danger-light)",
            color:
              message.type === "success" ? "var(--success)" : "var(--danger)",
          }}
        >
          {message.text}
        </div>
      )}

      <div
        className="rounded-xl p-6"
        style={{
          backgroundColor: "var(--bg-primary)",
          border: "1px solid var(--border-color)",
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <label
              className="block text-xs font-medium mb-1.5"
              style={{ color: "var(--text-secondary)" }}
            >
              Folder to scan
            </label>
            <select
              value={selectedFolder}
              onChange={(e) =>
                setSelectedFolder(e.target.value ? Number(e.target.value) : "")
              }
              className="w-full px-3 py-2 rounded-lg text-sm cursor-pointer"
              style={{
                backgroundColor: "var(--bg-secondary)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-color)",
              }}
            >
              <option value="">Select a folder...</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.path}
                </option>
              ))}
            </select>
          </div>
          <button
            onClick={handleScan}
            disabled={!selectedFolder || scanning}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white cursor-pointer disabled:opacity-50"
            style={{ backgroundColor: "var(--accent)" }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.backgroundColor = "var(--accent-hover)")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.backgroundColor = "var(--accent)")
            }
          >
            {scanning ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Eye size={16} />
            )}
            {scanning ? "Scanning..." : "Scan"}
          </button>
        </div>
      </div>

      {plan && (
        <>
          {/* Summary bar */}
          <div
            className="rounded-xl p-4 flex items-center justify-between flex-wrap gap-3"
            style={{
              backgroundColor: "var(--bg-primary)",
              border: "1px solid var(--border-color)",
              boxShadow: "var(--shadow-sm)",
            }}
          >
            <div
              className="flex items-center gap-4 text-xs"
              style={{ color: "var(--text-secondary)" }}
            >
              <span>
                <strong style={{ color: "var(--text-primary)" }}>
                  {plan.move_count}
                </strong>{" "}
                move
              </span>
              <span>
                <strong style={{ color: "var(--text-primary)" }}>
                  {plan.copy_count}
                </strong>{" "}
                copy
              </span>
              <span>
                <strong style={{ color: "var(--text-primary)" }}>
                  {plan.rename_count}
                </strong>{" "}
                rename
              </span>
              <span>
                <strong style={{ color: "var(--text-primary)" }}>
                  {plan.trash_count}
                </strong>{" "}
                trash
              </span>
              <span>
                <strong style={{ color: "var(--text-primary)" }}>
                  {plan.no_match_count}
                </strong>{" "}
                no match
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => toggleAll(true)}
                className="text-xs px-2 py-1 rounded cursor-pointer"
                style={{
                  color: "var(--accent)",
                  backgroundColor: "var(--accent-light)",
                }}
              >
                Select all
              </button>
              <button
                onClick={() => toggleAll(false)}
                className="text-xs px-2 py-1 rounded cursor-pointer"
                style={{
                  color: "var(--text-secondary)",
                  backgroundColor: "var(--bg-tertiary)",
                }}
              >
                Deselect all
              </button>
            </div>
          </div>

          {/* Steps table */}
          {plan.steps.length === 0 ? (
            <div
              className="rounded-xl"
              style={{
                backgroundColor: "var(--bg-primary)",
                border: "1px solid var(--border-color)",
              }}
            >
              <EmptyState
                icon={Eye}
                title="Nothing to organize"
                description="All files in this folder already match their rules or have no matching rules."
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
                  <tr
                    style={{
                      borderBottom: "1px solid var(--border-color)",
                    }}
                  >
                    <th className="w-10 px-4 py-3" />
                    <th
                      className="text-left text-xs font-medium uppercase tracking-wider px-4 py-3"
                      style={{ color: "var(--text-muted)" }}
                    >
                      File
                    </th>
                    <th
                      className="text-left text-xs font-medium uppercase tracking-wider px-4 py-3"
                      style={{ color: "var(--text-muted)" }}
                    >
                      Rule
                    </th>
                    <th
                      className="text-center text-xs font-medium uppercase tracking-wider px-4 py-3"
                      style={{ color: "var(--text-muted)" }}
                    >
                      Action
                    </th>
                    <th
                      className="text-left text-xs font-medium uppercase tracking-wider px-4 py-3"
                      style={{ color: "var(--text-muted)" }}
                    >
                      Destination
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {plan.steps.map((step: PlannedStep, idx: number) => (
                    <tr
                      key={idx}
                      style={{
                        borderBottom: "1px solid var(--border-color)",
                      }}
                      className="cursor-pointer"
                      onClick={() => toggleStep(idx)}
                    >
                      <td className="px-4 py-3">
                        {step.selected ? (
                          <CheckSquare
                            size={16}
                            style={{ color: "var(--accent)" }}
                          />
                        ) : (
                          <Square
                            size={16}
                            style={{ color: "var(--text-muted)" }}
                          />
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className="text-sm"
                          style={{ color: "var(--text-primary)" }}
                        >
                          {step.src_path.split(/[/\\]/).pop()}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className="text-xs"
                          style={{ color: "var(--text-secondary)" }}
                        >
                          {step.rule_name || "—"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <StatusBadge status={step.action_type} size="sm" />
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className="text-xs font-mono"
                          style={{ color: "var(--text-secondary)" }}
                        >
                          {step.dst_path ?? "—"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Apply button */}
          {plan.steps.length > 0 && (
            <div className="flex justify-end">
              <button
                onClick={handleApply}
                disabled={applying || selectedCount === 0}
                className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium text-white cursor-pointer disabled:opacity-50"
                style={{ backgroundColor: "var(--success)" }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.opacity = "0.9")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.opacity = "1")
                }
              >
                {applying ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Play size={16} />
                )}
                {applying
                  ? "Applying..."
                  : `Apply (${selectedCount} file${selectedCount !== 1 ? "s" : ""})`}
              </button>
            </div>
          )}
        </>
      )}

      {!plan && !scanning && (
        <div
          className="rounded-xl"
          style={{
            backgroundColor: "var(--bg-primary)",
            border: "1px solid var(--border-color)",
          }}
        >
          <EmptyState
            icon={Eye}
            title="No preview yet"
            description="Select a folder and click Scan to see what would be organized."
          />
        </div>
      )}
    </div>
  );
}
