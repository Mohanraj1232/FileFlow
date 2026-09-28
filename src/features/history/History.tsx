import { useState, useEffect } from "react";
import { Clock, ChevronDown, ChevronRight, Undo2 } from "lucide-react";
import type { Operation, OperationStep } from "../../lib/types";
import {
  getOperations,
  getOperationSteps,
  undoOperation,
  undoStep,
} from "../../lib/commands";
import StatusBadge from "../../components/StatusBadge";
import EmptyState from "../../components/EmptyState";
import Button from "../../components/ui/Button";
import PageHeader from "../../components/ui/PageHeader";
import { Card } from "../../components/ui/Card";
import { Table, THead, Th, TRow, Td } from "../../components/ui/Table";
import { LoadingState } from "../../components/ui/Spinner";
import { useToast } from "../../components/Toast";

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
  const { addToast } = useToast();
  const [operations, setOperations] = useState<Operation[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedOps, setExpandedOps] = useState<Set<number>>(new Set());
  const [steps, setSteps] = useState<Map<number, OperationStep[]>>(new Map());
  const [undoing, setUndoing] = useState<number | null>(null);
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
    try {
      const result = await undoOperation(opId);
      if (result.success) {
        addToast({
          type: "success",
          text: `Undone: ${result.steps_undone} step(s) reverted${result.steps_skipped > 0 ? `, ${result.steps_skipped} skipped` : ""}.`,
        });
      } else {
        addToast({
          type: "error",
          text: result.errors.join("; ") || "Undo failed.",
        });
      }
      loadOperations(0, false);
    } catch (e) {
      addToast({ type: "error", text: String(e) });
    } finally {
      setUndoing(null);
    }
  }

  async function handleUndoStep(stepId: number) {
    setUndoing(stepId);
    try {
      const result = await undoStep(stepId);
      if (result.success) {
        addToast({ type: "success", text: "Step undone successfully." });
      } else {
        addToast({
          type: "error",
          text: result.errors.join("; ") || "Undo failed.",
        });
      }
      loadOperations(0, false);
    } catch (e) {
      addToast({ type: "error", text: String(e) });
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

  if (loading && operations.length === 0) return <LoadingState />;

  return (
    <div>
      <PageHeader
        title="History"
        description="View past operations and undo changes"
      />

      {operations.length === 0 ? (
        <Card>
          <EmptyState
            icon={Clock}
            title="No history yet"
            description="Operations will appear here once files are organized."
          />
        </Card>
      ) : (
        <div className="space-y-6">
          {Array.from(grouped.entries()).map(([day, ops]) => (
            <div key={day}>
              <h3 className="sticky top-0 z-[1] -mx-1 mb-3 bg-canvas px-1 py-1 text-xs font-semibold uppercase tracking-wider text-fg-muted">
                {day}
              </h3>
              <div className="space-y-2">
                {ops.map((op) => {
                  const isExpanded = expandedOps.has(op.id);
                  const opSteps = steps.get(op.id) ?? [];

                  return (
                    <Card key={op.id} className="overflow-hidden">
                      <div
                        className="flex cursor-pointer items-center justify-between px-5 py-4"
                        onClick={() => toggleExpand(op.id)}
                      >
                        <div className="flex items-center gap-3">
                          {isExpanded ? (
                            <ChevronDown size={16} className="text-fg-muted" />
                          ) : (
                            <ChevronRight size={16} className="text-fg-muted" />
                          )}
                          <span className="text-sm font-medium text-fg">
                            {op.summary ?? `Operation #${op.id}`}
                          </span>
                          <StatusBadge status={op.status} size="sm" />
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-xs text-fg-muted">
                            {formatTime(op.started_at)}
                          </span>
                          {(op.status === "done" ||
                            op.status === "partially_undone") && (
                            <Button
                              variant="danger"
                              size="sm"
                              disabled={undoing !== null}
                              loading={undoing === op.id}
                              icon={<Undo2 size={12} />}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleUndoOperation(op.id);
                              }}
                            >
                              {op.status === "partially_undone" ? "Retry" : "Undo"}
                            </Button>
                          )}
                        </div>
                      </div>

                      {isExpanded && (
                        <div className="border-t border-border-muted px-5 pb-2">
                          {opSteps.length === 0 ? (
                            <p className="py-3 text-xs text-fg-muted">
                              Loading steps...
                            </p>
                          ) : (
                            <Table>
                              <THead>
                                <tr>
                                  <Th>Source</Th>
                                  <Th className="w-24">Action</Th>
                                  <Th>Destination</Th>
                                  <Th className="w-28 text-center">Status</Th>
                                  <Th className="w-16" />
                                </tr>
                              </THead>
                              <tbody>
                                {opSteps.map((step) => (
                                  <TRow key={step.id}>
                                    <Td
                                      className="max-w-[200px] truncate font-mono text-xs"
                                      title={step.src_path}
                                    >
                                      {step.src_path.split(/[/\\]/).pop()}
                                    </Td>
                                    <Td>
                                      <StatusBadge status={step.action_type} size="sm" />
                                    </Td>
                                    <Td
                                      className="max-w-[200px] truncate font-mono text-xs text-fg-muted"
                                      title={step.dst_path ?? ""}
                                    >
                                      {step.dst_path
                                        ? step.dst_path.split(/[/\\]/).pop()
                                        : "—"}
                                    </Td>
                                    <Td className="text-center">
                                      <StatusBadge status={step.status} size="sm" />
                                    </Td>
                                    <Td className="text-right">
                                      {step.status === "done" && (
                                        <Button
                                          variant="ghostDanger"
                                          size="sm"
                                          iconOnly
                                          aria-label="Undo this step"
                                          disabled={undoing !== null}
                                          icon={<Undo2 size={12} />}
                                          onClick={() => handleUndoStep(step.id)}
                                        />
                                      )}
                                    </Td>
                                  </TRow>
                                ))}
                              </tbody>
                            </Table>
                          )}
                        </div>
                      )}
                    </Card>
                  );
                })}
              </div>
            </div>
          ))}

          {hasMore && (
            <div className="flex justify-center">
              <Button variant="ghost" disabled={loading} onClick={loadMore}>
                {loading ? "Loading..." : "Load More"}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
