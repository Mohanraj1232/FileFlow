import { useState, useEffect, useMemo } from "react";
import { useParams } from "react-router-dom";
import { Play, Eye } from "lucide-react";
import type { WatchedFolder, PlanSummary, PlannedStep } from "../../lib/types";
import {
  getWatchedFolders,
  previewFolder,
  applyPlan,
} from "../../lib/commands";
import StatusBadge from "../../components/StatusBadge";
import EmptyState from "../../components/EmptyState";
import Badge from "../../components/ui/Badge";
import Button from "../../components/ui/Button";
import PageHeader from "../../components/ui/PageHeader";
import { Card, CardBody } from "../../components/ui/Card";
import { Select } from "../../components/ui/Field";
import { Table, THead, Th, TRow, Td } from "../../components/ui/Table";
import { useToast } from "../../components/Toast";
import { errorMessage } from "../../lib/errors";

export default function Preview() {
  const { folderId: paramFolderId } = useParams();
  const { addToast } = useToast();
  const [folders, setFolders] = useState<WatchedFolder[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<number | "">("");
  const [plan, setPlan] = useState<PlanSummary | null>(null);
  // Selection is per FILE: a file's chained steps (e.g. move then rename)
  // are applied or skipped together, so one checkbox controls them all.
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [applying, setApplying] = useState(false);

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
    try {
      const result = await previewFolder(selectedFolder as number);
      setPlan(result);
      setSelectedKeys(
        new Set(
          result.steps
            .filter((s) => s.action_type !== "skip" && s.selected)
            .map((s) => s.file_key),
        ),
      );
    } catch (e) {
      addToast({ type: "error", text: errorMessage(e) });
    } finally {
      setScanning(false);
    }
  }

  function toggleFile(fileKey: string) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(fileKey)) next.delete(fileKey);
      else next.add(fileKey);
      return next;
    });
  }

  function toggleAll(selected: boolean) {
    setSelectedKeys(selected ? new Set(actionableKeys) : new Set());
  }

  async function handleApply() {
    if (!plan || !selectedFolder) return;
    if (selectedKeys.size === 0) {
      addToast({ type: "error", text: "No files selected." });
      return;
    }
    setApplying(true);
    try {
      const result = await applyPlan(
        selectedFolder as number,
        plan.plan_id,
        [...selectedKeys],
      );
      addToast({
        type: result.operation ? "success" : "info",
        text: result.operation
          ? `Done: ${result.operation.summary ?? "files organized"}.`
          : (result.message ?? "Nothing was applied."),
      });
      setPlan(null);
    } catch (e) {
      addToast({ type: "error", text: errorMessage(e) });
    } finally {
      setApplying(false);
    }
  }

  // Files that have something to do (skip rows are informational only).
  const actionableKeys = useMemo(
    () =>
      plan
        ? [...new Set(plan.steps.filter((s) => s.action_type !== "skip").map((s) => s.file_key))]
        : [],
    [plan],
  );

  // The checkbox lives on a file's first step row; its later steps are indented under it.
  const firstRowOfFile = useMemo(() => {
    const first = new Map<string, number>();
    plan?.steps.forEach((s, i) => {
      if (!first.has(s.file_key)) first.set(s.file_key, i);
    });
    return first;
  }, [plan]);

  const selectedCount = selectedKeys.size;

  return (
    <div className="pb-4">
      <PageHeader
        title="Preview"
        description="Scan a folder, review the plan, then apply"
        actions={
          <>
            <div className="w-64 shrink-0">
              <Select
                value={selectedFolder}
                onChange={(e) =>
                  setSelectedFolder(e.target.value ? Number(e.target.value) : "")
                }
              >
                <option value="">Select a folder...</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.path}
                  </option>
                ))}
              </Select>
            </div>
            <Button
              variant="primary"
              disabled={!selectedFolder || scanning}
              loading={scanning}
              icon={<Eye size={16} />}
              onClick={handleScan}
            >
              {scanning ? "Scanning..." : "Scan"}
            </Button>
          </>
        }
      />

      {plan && (
        <div className="space-y-4">
          <Card>
            <CardBody className="flex flex-wrap items-center justify-between gap-3 !py-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="accent">{plan.move_count} move</Badge>
                <Badge tone="accent">{plan.copy_count} copy</Badge>
                <Badge tone="accent">{plan.rename_count} rename</Badge>
                <Badge tone="warning">{plan.trash_count} trash</Badge>
                {plan.skip_count > 0 && (
                  <Badge tone="warning">{plan.skip_count} skipped (name taken)</Badge>
                )}
                <Badge tone="neutral">{plan.no_match_count} no match</Badge>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="soft" size="sm" onClick={() => toggleAll(true)}>
                  Select all
                </Button>
                <Button variant="secondary" size="sm" onClick={() => toggleAll(false)}>
                  Deselect all
                </Button>
              </div>
            </CardBody>
          </Card>

          {plan.steps.length === 0 ? (
            <Card>
              <EmptyState
                icon={Eye}
                title="Nothing to organize"
                description="All files in this folder already match their rules or have no matching rules."
              />
            </Card>
          ) : (
            <Card className="overflow-hidden pb-16">
              <Table>
                <THead>
                  <tr>
                    <Th className="w-10" />
                    <Th className="w-64">File</Th>
                    <Th className="w-40">Rule</Th>
                    <Th className="w-24 text-center">Action</Th>
                    <Th>Destination</Th>
                  </tr>
                </THead>
                <tbody>
                  {plan.steps.map((step: PlannedStep, idx: number) => {
                    const isSkip = step.action_type === "skip";
                    const isFirst = firstRowOfFile.get(step.file_key) === idx;
                    const fileName = step.src_path.split(/[/\\]/).pop();
                    return (
                      <TRow
                        key={idx}
                        className={isSkip ? "opacity-60" : isFirst ? "cursor-pointer" : ""}
                        onClick={!isSkip && isFirst ? () => toggleFile(step.file_key) : undefined}
                      >
                        <Td>
                          {!isSkip && isFirst && (
                            <input
                              type="checkbox"
                              checked={selectedKeys.has(step.file_key)}
                              onChange={() => toggleFile(step.file_key)}
                              onClick={(e) => e.stopPropagation()}
                              aria-label={`Select ${fileName}`}
                              className="h-4 w-4 cursor-pointer accent-[var(--accent)]"
                            />
                          )}
                        </Td>
                        <Td className="truncate" title={step.src_path}>
                          {isFirst ? fileName : <span className="pl-4 text-fg-subtle">↳ then</span>}
                        </Td>
                        <Td className="truncate text-fg-muted" title={step.rule_name}>
                          {step.rule_name || "—"}
                        </Td>
                        <Td className="text-center">
                          <StatusBadge status={isSkip ? "skipped" : step.action_type} size="sm" />
                        </Td>
                        <Td
                          className="truncate font-mono text-xs text-fg-muted"
                          title={step.note ?? step.dst_path ?? undefined}
                        >
                          {isSkip ? (step.note ?? "Skipped") : (step.dst_path ?? "—")}
                          {!isSkip && step.note ? (
                            <span className="ml-2 font-sans text-warning">{step.note}</span>
                          ) : null}
                        </Td>
                      </TRow>
                    );
                  })}
                </tbody>
              </Table>
            </Card>
          )}

          {plan.steps.length > 0 && (
            <div className="sticky bottom-4 flex items-center justify-end gap-4 rounded-xl border border-border bg-surface px-5 py-4 shadow-pop">
              <span className="text-sm text-fg-muted">
                {selectedCount} file{selectedCount !== 1 ? "s" : ""} selected
              </span>
              <Button
                variant="primary"
                disabled={applying || selectedCount === 0}
                loading={applying}
                icon={<Play size={16} />}
                onClick={handleApply}
              >
                {applying ? "Applying..." : `Apply (${selectedCount})`}
              </Button>
            </div>
          )}
        </div>
      )}

      {!plan && !scanning && (
        <Card>
          <EmptyState
            icon={Eye}
            title="No preview yet"
            description="Select a folder and click Scan to see what would be organized."
          />
        </Card>
      )}
    </div>
  );
}
