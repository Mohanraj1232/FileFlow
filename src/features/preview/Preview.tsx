import { useState, useEffect } from "react";
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

export default function Preview() {
  const { folderId: paramFolderId } = useParams();
  const { addToast } = useToast();
  const [folders, setFolders] = useState<WatchedFolder[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<number | "">("");
  const [plan, setPlan] = useState<PlanSummary | null>(null);
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
    } catch (e) {
      addToast({ type: "error", text: String(e) });
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
      addToast({ type: "error", text: "No files selected." });
      return;
    }
    setApplying(true);
    try {
      const op = await applyPlan(selectedFolder as number, selectedPaths);
      addToast({
        type: "success",
        text: `Operation completed: ${op.summary ?? "files organized successfully"}.`,
      });
      setPlan(null);
    } catch (e) {
      addToast({ type: "error", text: String(e) });
    } finally {
      setApplying(false);
    }
  }

  const selectedCount = plan?.steps.filter((s) => s.selected).length ?? 0;

  return (
    <div className="pb-4">
      <PageHeader
        title="Preview"
        description="Scan a folder, review the plan, then apply"
        actions={
          <>
            <Select
              value={selectedFolder}
              onChange={(e) =>
                setSelectedFolder(e.target.value ? Number(e.target.value) : "")
              }
              className="w-64"
            >
              <option value="">Select a folder...</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.path}
                </option>
              ))}
            </Select>
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
                  {plan.steps.map((step: PlannedStep, idx: number) => (
                    <TRow
                      key={idx}
                      className="cursor-pointer"
                      onClick={() => toggleStep(idx)}
                    >
                      <Td>
                        <input
                          type="checkbox"
                          checked={!!step.selected}
                          onChange={() => toggleStep(idx)}
                          onClick={(e) => e.stopPropagation()}
                          className="h-4 w-4 cursor-pointer accent-[var(--accent)]"
                        />
                      </Td>
                      <Td className="truncate" title={step.src_path}>
                        {step.src_path.split(/[/\\]/).pop()}
                      </Td>
                      <Td className="truncate text-fg-muted" title={step.rule_name}>
                        {step.rule_name || "—"}
                      </Td>
                      <Td className="text-center">
                        <StatusBadge status={step.action_type} size="sm" />
                      </Td>
                      <Td
                        className="truncate font-mono text-xs text-fg-muted"
                        title={step.dst_path ?? undefined}
                      >
                        {step.dst_path ?? "—"}
                      </Td>
                    </TRow>
                  ))}
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
