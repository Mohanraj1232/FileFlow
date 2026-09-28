import { useState, useEffect } from "react";
import {
  Clock,
  ChevronDown,
  ChevronRight,
  Undo2,
  Loader2,
} from "lucide-react";
import type { Operation, OperationStep } from "../../lib/types";
import {
  getOperations,
  getOperationSteps,
  undoOperation,
  undoStep,
} from "../../lib/commands";
import StatusBadge from "../../components/StatusBadge";
import EmptyState from "../../components/EmptyState";

function groupByDay(ops: Operation[]): Map<string, Operation[]> {
  const groups = new Map<string, Operation[]>();
  for (const op of ops) {
    const day = new Date(op.started_at).toLocaleDateString(undefined, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const existing = groups.get(day) ?? [];
    existing.push(op);
    groups.set(day, existing);
  }
  return groups;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function History() {
  const [operations, setOperations] = useState<Operation[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedOps, setExpandedOps] = useState<Set<number>>(new Set());
  const [steps, setSteps] = useState<Map<number, OperationStep[]>>(new Map());
  const [undoing, setUndoing] = useState<number | null>(null);
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);

  const PAGE_SIZE = 20;

  async function loadOperations(pageNum: number, append: boolean) {
    setLoading(true);
    try {
      const ops = await getOperations(PAGE_SIZE, pageNum * PAGE_SIZE);
      if (append) {
        setOperations((prev) => [...prev, ...ops]);
      } else {
        setOperations(ops);
      }
      setHasMore(ops.length === PAGE_SIZE);
    } catch {
      if (!append) setOperations([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadOperations(0, false);
  }, []);

  async function toggleExpand(opId: number) {
    const next = new Set(expandedOps);
    if (next.has(opId)) {
      next.delete(opId);
    } else {
      next.add(opId);
      if (!steps.has(opId)) {
        try {
          const s = await getOperationSteps(opId);
          setSteps((prev) => new Map(prev).set(opId, s));
        } catch {
          // ignore
        }
      }
    }
    setExpandedOps(next);
  }

  async function handleUndoOperation(opId: number) {
    setUndoing(opId);
    setMessage(null);
    try {
      const result = await undoOperation(opId);
      if (result.success) {
        setMessage({
          type: "success",
          text: `Undone: ${result.steps_undone} step(s) reverted${result.steps_skipped > 0 ? `, ${result.steps_skipped} skipped` : ""}.`,
        });
      } else {
        setMessage({
          type: "error",
          text: result.errors.join("; ") || "Undo failed.",
        });
      }
      loadOperations(0, false);
    } catch (e) {
      setMessage({ type: "error", text: String(e) });
    } finally {
      setUndoing(null);
    }
  }

  async function handleUndoStep(stepId: number) {
    setUndoing(stepId);
    setMessage(null);
    try {
      const result = await undoStep(stepId);
      if (result.success) {
        setMessage({ type: "success", text: "Step undone successfully." });
      } else {
        setMessage({
          type: "error",
          text: result.errors.join("; ") || "Undo failed.",
        });
      }
      loadOperations(0, false);
    } catch (e) {
      setMessage({ type: "error", text: String(e) });
    } finally {
      setUndoing(null);
    }
  }

  function loadMore() {
    const next = page + 1;
    setPage(next);
    loadOperations(next, true);
  }

  const grouped = groupByDay(operations);

  if (loading && operations.length === 0) {
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
      <div>
        <h1
          className="text-2xl font-bold"
          style={{ color: "var(--text-primary)" }}
        >
          History
        </h1>
        <p className="text-sm mt-1" style={{ color: "var(--text-secondary)" }}>
          View past operations and undo changes
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

      {operations.length === 0 ? (
        <div
          className="rounded-xl"
          style={{
            backgroundColor: "var(--bg-primary)",
            border: "1px solid var(--border-color)",
          }}
        >
          <EmptyState
            icon={Clock}
            title="No history yet"
            description="Operations will appear here once files are organized."
          />
        </div>
      ) : (
        <div className="space-y-6">
          {Array.from(grouped.entries()).map(([day, ops]) => (
            <div key={day}>
              <h3
                className="text-xs font-semibold uppercase tracking-wider mb-3"
                style={{ color: "var(--text-muted)" }}
              >
                {day}
              </h3>
              <div className="space-y-2">
                {ops.map((op) => {
                  const isExpanded = expandedOps.has(op.id);
                  const opSteps = steps.get(op.id) ?? [];

                  return (
                    <div
                      key={op.id}
                      className="rounded-xl overflow-hidden"
                      style={{
                        backgroundColor: "var(--bg-primary)",
                        border: "1px solid var(--border-color)",
                        boxShadow: "var(--shadow-sm)",
                      }}
                    >
                      {/* Operation header */}
                      <div
                        className="flex items-center justify-between px-5 py-4 cursor-pointer"
                        onClick={() => toggleExpand(op.id)}
                      >
                        <div className="flex items-center gap-3">
                          {isExpanded ? (
                            <ChevronDown
                              size={16}
                              style={{ color: "var(--text-muted)" }}
                            />
                          ) : (
                            <ChevronRight
                              size={16}
                              style={{ color: "var(--text-muted)" }}
                            />
                          )}
                          <span
                            className="text-sm font-medium"
                            style={{ color: "var(--text-primary)" }}
                          >
                            {op.summary ?? `Operation #${op.id}`}
                          </span>
                          <StatusBadge status={op.status} size="sm" />
                        </div>
                        <div className="flex items-center gap-3">
                          <span
                            className="text-xs"
                            style={{ color: "var(--text-muted)" }}
                          >
                            {formatTime(op.started_at)}
                          </span>
                          {(op.status === "done" ||
                            op.status === "partially_undone") && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleUndoOperation(op.id);
                              }}
                              disabled={undoing !== null}
                              className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium cursor-pointer disabled:opacity-50"
                              style={{
                                color: "var(--warning)",
                                backgroundColor: "var(--warning-light)",
                              }}
                            >
                              {undoing === op.id ? (
                                <Loader2 size={12} className="animate-spin" />
                              ) : (
                                <Undo2 size={12} />
                              )}
                              {op.status === "partially_undone" ? "Retry" : "Undo"}
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Expanded steps */}
                      {isExpanded && (
                        <div
                          className="px-5 pb-4"
                          style={{
                            borderTop: "1px solid var(--border-color)",
                          }}
                        >
                          {opSteps.length === 0 ? (
                            <p
                              className="text-xs py-3"
                              style={{ color: "var(--text-muted)" }}
                            >
                              Loading steps...
                            </p>
                          ) : (
                            <table className="w-full mt-3">
                              <thead>
                                <tr>
                                  <th
                                    className="text-left text-[10px] font-medium uppercase tracking-wider pb-2"
                                    style={{ color: "var(--text-muted)" }}
                                  >
                                    Source
                                  </th>
                                  <th
                                    className="text-left text-[10px] font-medium uppercase tracking-wider pb-2 px-2"
                                    style={{ color: "var(--text-muted)" }}
                                  >
                                    Action
                                  </th>
                                  <th
                                    className="text-left text-[10px] font-medium uppercase tracking-wider pb-2"
                                    style={{ color: "var(--text-muted)" }}
                                  >
                                    Destination
                                  </th>
                                  <th
                                    className="text-center text-[10px] font-medium uppercase tracking-wider pb-2"
                                    style={{ color: "var(--text-muted)" }}
                                  >
                                    Status
                                  </th>
                                  <th className="w-16 pb-2" />
                                </tr>
                              </thead>
                              <tbody>
                                {opSteps.map((step) => (
                                  <tr
                                    key={step.id}
                                    style={{
                                      borderTop:
                                        "1px solid var(--border-color)",
                                    }}
                                  >
                                    <td
                                      className="py-2 text-xs font-mono truncate max-w-[200px]"
                                      style={{
                                        color: "var(--text-primary)",
                                      }}
                                      title={step.src_path}
                                    >
                                      {step.src_path.split(/[/\\]/).pop()}
                                    </td>
                                    <td className="py-2 px-2">
                                      <StatusBadge
                                        status={step.action_type}
                                        size="sm"
                                      />
                                    </td>
                                    <td
                                      className="py-2 text-xs font-mono truncate max-w-[200px]"
                                      style={{
                                        color: "var(--text-secondary)",
                                      }}
                                      title={step.dst_path ?? ""}
                                    >
                                      {step.dst_path
                                        ? step.dst_path.split(/[/\\]/).pop()
                                        : "—"}
                                    </td>
                                    <td className="py-2 text-center">
                                      <StatusBadge
                                        status={step.status}
                                        size="sm"
                                      />
                                    </td>
                                    <td className="py-2 text-right">
                                      {step.status === "done" && (
                                        <button
                                          onClick={() =>
                                            handleUndoStep(step.id)
                                          }
                                          disabled={undoing !== null}
                                          className="p-1 rounded cursor-pointer disabled:opacity-50"
                                          style={{
                                            color: "var(--warning)",
                                          }}
                                          title="Undo this step"
                                        >
                                          <Undo2 size={12} />
                                        </button>
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {hasMore && (
            <div className="flex justify-center">
              <button
                onClick={loadMore}
                disabled={loading}
                className="px-4 py-2 rounded-lg text-sm font-medium cursor-pointer"
                style={{
                  backgroundColor: "var(--bg-tertiary)",
                  color: "var(--text-secondary)",
                }}
              >
                {loading ? "Loading..." : "Load More"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
