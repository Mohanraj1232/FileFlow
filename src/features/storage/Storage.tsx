import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderPlus, X, ScanSearch, HardDrive, Files, FolderTree, Archive, Trash2, Eraser, AlertTriangle } from "lucide-react";
import type {
  DuplicateSavings,
  FileKind,
  RemoveMode,
  RootCheck,
  StorageCleanupResult,
  StorageFile,
  StorageReport,
  StorageScanSummary,
} from "../../lib/types";
import {
  checkScanRoots,
  onStorageProgress,
  storageCancelScan,
  storageCleanup,
  storageDeleteScan,
  storageGetDuplicateSavings,
  storageGetReport,
  storageListScans,
  storageReveal,
  storageStartScan,
} from "../../lib/commands";
import { errorMessage } from "../../lib/errors";
import { formatSize, formatDate, plural } from "../../lib/format";
import { useToast } from "../../components/Toast";
import Modal from "../../components/Modal";
import EmptyState from "../../components/EmptyState";
import Button from "../../components/ui/Button";
import PageHeader from "../../components/ui/PageHeader";
import StatCard from "../../components/ui/StatCard";
import { Card, CardHeader, CardBody } from "../../components/ui/Card";
import { Select } from "../../components/ui/Field";
import type { Selection } from "./FileTable";
import OverviewTab from "./OverviewTab";
import FilesTab from "./FilesTab";
import CleanupTab from "./CleanupTab";
import { EMPTY_FILTER, rootsLabel, selectionTotals, type FilterState, type Tab } from "./logic";

const LAST_SCAN_KEY = "fileflow.storage.scan";

function remember(id: number | null) {
  try {
    if (id) sessionStorage.setItem(LAST_SCAN_KEY, String(id));
    else sessionStorage.removeItem(LAST_SCAN_KEY);
  } catch {
    /* storage unavailable */
  }
}

function recall(): number | null {
  try {
    const v = Number(sessionStorage.getItem(LAST_SCAN_KEY));
    return Number.isInteger(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

const TABS: { id: Tab; label: string; icon: typeof FolderTree }[] = [
  { id: "overview", label: "Overview", icon: FolderTree },
  { id: "files", label: "Files", icon: Files },
  { id: "cleanup", label: "Cleanup", icon: Eraser },
];

export default function Storage() {
  const { addToast } = useToast();

  // ---- what to scan, and the reports on offer ----
  const [roots, setRoots] = useState<string[]>([]);
  const [includeHidden, setIncludeHidden] = useState(true);
  const [scans, setScans] = useState<StorageScanSummary[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);
  const [sensitive, setSensitive] = useState<RootCheck["sensitive"] | null>(null);
  const [listLoaded, setListLoaded] = useState(false);
  // With a report open the folder setup collapses to one line; this brings the full controls back.
  const [editing, setEditing] = useState(false);

  // ---- the open report ----
  const [tab, setTab] = useState<Tab>("overview");
  const [folder, setFolder] = useState<string | null>(null);
  const [report, setReport] = useState<StorageReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER);
  const [duplicates, setDuplicates] = useState<DuplicateSavings | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // ---- removal ----
  const [selection, setSelection] = useState<Selection>(new Map());
  const [mode, setMode] = useState<RemoveMode>("quarantine");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [lastResult, setLastResult] = useState<StorageCleanupResult | null>(null);

  const active = useMemo(() => scans.find((s) => s.scan_id === activeId) ?? null, [scans, activeId]);
  const running = scans.find((s) => s.state === "running") ?? null;
  const reportScanId = active?.state === "done" ? active.scan_id : null;
  const finished = useMemo(() => scans.filter((s) => s.state === "done"), [scans]);
  const activeIdRef = useRef<number | null>(null);
  activeIdRef.current = activeId;

  // ---- loading the list of scans ----
  const reloadScans = useCallback(
    async (preferId?: number) => {
      try {
        const list = await storageListScans();
        setScans(list);
        setListLoaded(true);
        const wanted = preferId ?? activeIdRef.current ?? recall();
        const pick =
          list.find((s) => s.scan_id === wanted) ?? list.find((s) => s.state === "running") ?? list.find((s) => s.state === "done");
        if (pick) {
          setActiveId(pick.scan_id);
          remember(pick.scan_id);
          if (pick.state === "done" && pick.scan_id !== activeIdRef.current) setRoots(pick.roots);
        } else {
          setActiveId(null);
        }
      } catch (e) {
        setListLoaded(true);
        addToast({ type: "error", text: errorMessage(e) });
      }
    },
    [addToast],
  );

  useEffect(() => {
    void reloadScans();
  }, [reloadScans]);

  // Live progress from the running scan; when it ends, pick up the finished report.
  useEffect(() => {
    if (!window.electronAPI?.onStorageProgress) return;
    return onStorageProgress((summary) => {
      setScans((prev) => {
        const others = prev.filter((s) => s.scan_id !== summary.scan_id);
        return [summary, ...others];
      });
      if (summary.state === "done") {
        void reloadScans(summary.scan_id);
        addToast({ type: "success", text: "Scan finished." });
      } else if (summary.state === "cancelled") {
        void reloadScans();
      } else if (summary.state === "failed") {
        void reloadScans();
        addToast({ type: "error", text: summary.error ?? "The scan failed." });
      }
    });
  }, [reloadScans, addToast]);

  // ---- loading the open report ----
  useEffect(() => {
    if (reportScanId === null) {
      setReport(null);
      return;
    }
    let cancelled = false;
    setReportLoading(true);
    storageGetReport(reportScanId, folder)
      .then((r) => !cancelled && setReport(r))
      .catch((e) => {
        if (!cancelled) addToast({ type: "error", text: errorMessage(e) });
      })
      .finally(() => !cancelled && setReportLoading(false));
    return () => {
      cancelled = true;
    };
  }, [reportScanId, folder, refreshKey, addToast]);

  useEffect(() => {
    if (reportScanId === null) {
      setDuplicates(null);
      return;
    }
    storageGetDuplicateSavings(reportScanId)
      .then(setDuplicates)
      .catch(() => setDuplicates(null));
  }, [reportScanId, refreshKey]);

  // Switching to another report starts fresh: top level, no filters, nothing selected.
  useEffect(() => {
    setFolder(null);
    setFilter(EMPTY_FILTER);
    setSelection(new Map());
    setLastResult(null);
  }, [reportScanId]);

  // ---- starting / cancelling a scan ----
  async function addFolder() {
    try {
      const picked = await window.electronAPI.showOpenDialog();
      if (picked) setRoots((prev) => (prev.includes(picked) ? prev : [...prev, picked]));
    } catch (e) {
      addToast({ type: "error", text: errorMessage(e) });
    }
  }

  async function beginScan(confirmSensitive: boolean) {
    setStarting(true);
    try {
      const started = await storageStartScan(roots, { include_hidden: includeHidden, confirm_sensitive: confirmSensitive });
      setEditing(false);
      setScans((prev) => [started, ...prev.filter((s) => s.scan_id !== started.scan_id)]);
      setActiveId(started.scan_id);
      remember(started.scan_id);
      // A tiny scan can finish before this call returns; make sure the settled state is picked up.
      await reloadScans(started.scan_id);
    } catch (e) {
      addToast({ type: "error", text: errorMessage(e) });
    } finally {
      setStarting(false);
    }
  }

  async function handleScan() {
    if (roots.length === 0) return;
    try {
      const check = await checkScanRoots(roots);
      if (check.missing.length) {
        addToast({ type: "error", text: `Folder not found: ${check.missing[0]}` });
        return;
      }
      if (check.protected.length) {
        addToast({ type: "error", text: `FileFlow does not scan system folders: ${check.protected.join(", ")}` });
        return;
      }
      if (check.sensitive.length) {
        setSensitive(check.sensitive);
        return;
      }
      await beginScan(false);
    } catch (e) {
      addToast({ type: "error", text: errorMessage(e) });
    }
  }

  async function handleCancel() {
    if (!running) return;
    try {
      await storageCancelScan(running.scan_id);
    } catch (e) {
      addToast({ type: "error", text: errorMessage(e) });
    }
  }

  async function handleForget() {
    if (reportScanId === null) return;
    try {
      await storageDeleteScan(reportScanId);
      remember(null);
      setActiveId(null);
      await reloadScans();
      addToast({ type: "info", text: "Report deleted. Your files were not touched." });
    } catch (e) {
      addToast({ type: "error", text: errorMessage(e) });
    }
  }

  // ---- selection ----
  const toggleFile = useCallback((file: StorageFile) => {
    setSelection((prev) => {
      const next = new Map(prev);
      if (next.has(file.path)) next.delete(file.path);
      else next.set(file.path, file.stored_size);
      return next;
    });
  }, []);

  const toggleMany = useCallback((files: StorageFile[], selected: boolean) => {
    setSelection((prev) => {
      const next = new Map(prev);
      for (const f of files) {
        if (selected) next.set(f.path, f.stored_size);
        else next.delete(f.path);
      }
      return next;
    });
  }, []);

  const totals = selectionTotals(selection);

  async function handleReveal(path: string) {
    if (reportScanId === null) return;
    try {
      await storageReveal(reportScanId, path);
    } catch (e) {
      addToast({ type: "error", text: errorMessage(e) });
    }
  }

  async function handleRemove() {
    if (reportScanId === null) return;
    setResolving(true);
    try {
      const result = await storageCleanup(reportScanId, [...selection.keys()], mode);
      setLastResult(result);
      setConfirmOpen(false);

      if (result.removed_count > 0) {
        addToast({
          type: "success",
          text: `${plural(result.removed_count, "file")} ${mode === "quarantine" ? "moved to quarantine" : "sent to the trash"} · ${formatSize(result.reclaimed_bytes)} freed`,
        });
      } else {
        addToast({ type: "info", text: "Nothing was removed." });
      }
      if (result.skipped.length > 0) {
        addToast({ type: "info", text: `${plural(result.skipped.length, "file")} skipped — see the list below.` });
      }

      // Forget the selection for anything that is gone, then reload the report and the open lists.
      const gone = new Set<string>(selection.keys());
      for (const s of result.skipped) gone.delete(s.path);
      setSelection((prev) => {
        const next = new Map(prev);
        for (const p of gone) next.delete(p);
        return next;
      });
      setRefreshKey((k) => k + 1);
      void reloadScans(reportScanId);
    } catch (e) {
      addToast({ type: "error", text: errorMessage(e) });
      setConfirmOpen(false);
    } finally {
      setResolving(false);
    }
  }

  function showFiles(scope: { folder?: string | null; kind?: FileKind }) {
    setFilter({ ...EMPTY_FILTER, folder: scope.folder ?? null, kind: scope.kind ?? "" });
    setTab("files");
  }

  const sameFolders = active?.state === "done" && active.roots.length === roots.length && active.roots.every((r) => roots.includes(r));

  return (
    <div className="pb-24">
      <PageHeader title="Storage" description="See where your space goes, then decide what to clean up. Nothing is removed without your say-so." />

      {/* ---- compact bar while a report is open ---- */}
      {reportScanId !== null && !editing && !running && (
        <Card className="mb-4">
          <CardBody className="flex flex-wrap items-center gap-3 !py-3">
            <HardDrive size={16} className="shrink-0 text-fg-muted" />
            <span className="min-w-0 truncate text-sm text-fg" title={roots.join(", ")}>
              {rootsLabel(roots)}
              <span className="ml-2 text-xs text-fg-muted">{plural(roots.length, "folder")}</span>
            </span>
            {finished.length > 1 && (
              <div className="w-64">
                <Select
                  aria-label="Earlier reports"
                  value={reportScanId}
                  onChange={(e) => {
                    const id = Number(e.target.value);
                    setActiveId(id);
                    remember(id);
                    const s = finished.find((x) => x.scan_id === id);
                    if (s) setRoots(s.roots);
                  }}
                >
                  {finished.map((s) => (
                    <option key={s.scan_id} value={s.scan_id}>
                      {rootsLabel(s.roots)} — {formatSize(s.stored_bytes)} · {s.finished_at ? formatDate(s.finished_at) : ""}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            <div className="ml-auto flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
                Change folders
              </Button>
              <Button variant="ghost" size="sm" icon={<Trash2 size={13} />} onClick={handleForget}>
                Delete this report
              </Button>
              <Button variant="primary" size="sm" icon={<ScanSearch size={14} />} loading={starting} onClick={handleScan}>
                Scan again
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      {/* ---- what to analyze ---- */}
      {(reportScanId === null || editing || !!running) && (
      <Card className="mb-4">
        <CardHeader title="Folders to analyze" description="Only file names, sizes and dates are read. Contents are never opened." />
        <CardBody className="space-y-4">
          {roots.length === 0 ? (
            <p className="text-sm text-fg-muted">No folders chosen yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {roots.map((r) => (
                <li key={r} className="flex items-center justify-between gap-3 rounded-lg bg-inset px-3 py-2">
                  <span className="truncate text-sm text-fg" title={r}>{r}</span>
                  <Button
                    variant="ghostDanger"
                    size="sm"
                    iconOnly
                    aria-label={`Remove ${r} from the list`}
                    disabled={!!running}
                    icon={<X size={14} />}
                    onClick={() => setRoots((prev) => prev.filter((x) => x !== r))}
                  />
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-end gap-4">
            <Button variant="secondary" icon={<FolderPlus size={14} />} disabled={!!running} onClick={addFolder}>
              Add folder
            </Button>
            <label className="flex cursor-pointer items-center gap-2 pb-2 text-sm text-fg-muted">
              <input
                type="checkbox"
                checked={includeHidden}
                disabled={!!running}
                onChange={(e) => setIncludeHidden(e.target.checked)}
                className="h-4 w-4 cursor-pointer accent-[var(--accent)]"
              />
              Include hidden files and folders
            </label>

            {finished.length > 0 && (
              <div className="w-72">
                <label htmlFor="report-select" className="mb-1.5 block text-xs font-medium text-fg-muted">
                  Earlier reports
                </label>
                <Select
                  id="report-select"
                  value={reportScanId ?? ""}
                  disabled={!!running}
                  onChange={(e) => {
                    const id = Number(e.target.value);
                    setActiveId(id);
                    remember(id);
                    const s = finished.find((x) => x.scan_id === id);
                    if (s) setRoots(s.roots);
                  }}
                >
                  {finished.map((s) => (
                    <option key={s.scan_id} value={s.scan_id}>
                      {rootsLabel(s.roots)} — {formatSize(s.stored_bytes)} · {s.finished_at ? formatDate(s.finished_at) : ""}
                    </option>
                  ))}
                </Select>
              </div>
            )}

            <div className="ml-auto flex items-center gap-2">
              {reportScanId !== null && !running && (
                <Button variant="ghost" size="sm" icon={<Trash2 size={13} />} onClick={handleForget}>
                  Delete this report
                </Button>
              )}
              <Button
                variant="primary"
                icon={<ScanSearch size={16} />}
                loading={starting}
                disabled={roots.length === 0 || !!running}
                onClick={handleScan}
              >
                {running ? "Scanning…" : sameFolders ? "Scan again" : "Analyze storage"}
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>
      )}

      {/* ---- progress ---- */}
      {running && (
        <Card className="mb-4">
          <CardBody className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-fg">Looking through your folders…</p>
              <Button variant="secondary" size="sm" icon={<X size={14} />} onClick={handleCancel}>
                Cancel
              </Button>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-inset" role="progressbar" aria-label="Scanning" aria-busy="true">
              <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
            </div>
            <p className="text-xs text-fg-muted" aria-live="polite">
              {plural(running.progress?.files_seen ?? 0, "file")} found · {formatSize(running.progress?.bytes_seen ?? 0)}
            </p>
            {running.progress?.current_path && (
              <p className="truncate font-mono text-[11px] text-fg-subtle" title={running.progress.current_path}>
                {running.progress.current_path}
              </p>
            )}
            <p className="text-xs text-fg-subtle">Your earlier report stays available until this scan finishes.</p>
          </CardBody>
        </Card>
      )}

      {active && (active.state === "cancelled" || active.state === "failed") && !running && (
        <Card className="mb-4">
          <EmptyState
            icon={active.state === "failed" ? AlertTriangle : X}
            title={active.state === "failed" ? "The scan failed" : "Scan cancelled"}
            description={active.state === "failed" ? (active.error ?? "An unexpected error stopped the scan.") : "Nothing was changed."}
          />
        </Card>
      )}

      {/* ---- the report ---- */}
      {reportScanId !== null && report && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
            <StatCard icon={<HardDrive size={20} />} label="Space used" value={formatSize(report.scan.stored_bytes)} tone="accent" />
            <StatCard icon={<Files size={20} />} label="Files" value={report.scan.file_count.toLocaleString()} tone="success" />
            <StatCard icon={<FolderTree size={20} />} label="Folders" value={report.scan.dir_count.toLocaleString()} tone="warning" />
            <StatCard
              icon={<ScanSearch size={20} />}
              label={`Scanned ${report.scan.finished_at ? formatDate(report.scan.finished_at) : ""}`}
              value={report.scan.error_count > 0 ? `${report.scan.error_count} unreadable` : "Complete"}
              tone={report.scan.error_count > 0 ? "danger" : "success"}
            />
          </div>
          {report.scan.logical_bytes > report.scan.stored_bytes && (
            <p className="text-xs text-fg-muted">
              Some files share storage (hard links), so listed file sizes add up to {formatSize(report.scan.logical_bytes)} but only{" "}
              {formatSize(report.scan.stored_bytes)} of disk is used. Totals count shared data once.
            </p>
          )}

          <div role="tablist" aria-label="Storage views" className="flex gap-1 border-b border-border">
            {TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                role="tab"
                type="button"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={`-mb-px flex cursor-pointer items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                  tab === id ? "border-accent text-fg" : "border-transparent text-fg-muted hover:text-fg"
                }`}
              >
                <Icon size={15} />
                {label}
              </button>
            ))}
          </div>

          {lastResult && lastResult.skipped.length > 0 && (
            <Card>
              <CardHeader title={`${plural(lastResult.skipped.length, "file")} were not removed`} description="These were left exactly as they are." />
              <CardBody>
                <ul className="space-y-1 text-xs text-fg-muted">
                  {lastResult.skipped.slice(0, 20).map((s) => (
                    <li key={s.path} className="truncate" title={`${s.path} — ${s.reason}`}>
                      <span className="font-mono">{s.path}</span> — {s.reason}
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          )}

          <div role="tabpanel" className={reportLoading ? "opacity-70 transition-opacity" : ""}>
            {tab === "overview" && (
              <OverviewTab report={report} onOpenFolder={setFolder} onShowFiles={showFiles} onReveal={handleReveal} />
            )}
            {tab === "files" && (
              <FilesTab
                scanId={reportScanId}
                filter={filter}
                onFilterChange={setFilter}
                selection={selection}
                onToggle={toggleFile}
                onToggleAll={toggleMany}
                onReveal={handleReveal}
                refreshKey={refreshKey}
              />
            )}
            {tab === "cleanup" && (
              <CleanupTab
                scanId={reportScanId}
                selection={selection}
                onToggle={toggleFile}
                onToggleAll={toggleMany}
                onReveal={handleReveal}
                duplicates={duplicates}
                refreshKey={refreshKey}
              />
            )}
          </div>
        </div>
      )}

      {listLoaded && scans.length === 0 && (
        <Card>
          <EmptyState
            icon={HardDrive}
            title="See where your space goes"
            description="Add the folders you want to look at, then analyze. You'll get a breakdown by folder, type and age, and suggestions you can review."
          />
        </Card>
      )}

      {/* ---- action bar ---- */}
      {reportScanId !== null && selection.size > 0 && (
        <div className="sticky bottom-4 mt-4 flex flex-wrap items-center justify-end gap-4 rounded-xl border border-border bg-surface px-5 py-4 shadow-pop">
          <span className="mr-auto text-sm text-fg-muted" aria-live="polite">
            {plural(totals.files, "file")} selected · about {formatSize(totals.bytes)}
          </span>
          <Button variant="ghost" size="sm" onClick={() => setSelection(new Map())}>
            Clear selection
          </Button>
          <div className="w-72">
            <Select aria-label="What to do with the selected files" value={mode} onChange={(e) => setMode(e.target.value as RemoveMode)}>
              <option value="quarantine">Quarantine folder (undoable)</option>
              <option value="trash">Recycle Bin / Trash (not undoable)</option>
            </Select>
          </div>
          <Button
            variant={mode === "trash" ? "danger" : "primary"}
            icon={mode === "trash" ? <Trash2 size={16} /> : <Archive size={16} />}
            onClick={() => setConfirmOpen(true)}
          >
            Review and remove…
          </Button>
        </div>
      )}

      {/* ---- confirmations ---- */}
      <Modal open={confirmOpen} onClose={() => !resolving && setConfirmOpen(false)} title="Remove the selected files?">
        <div className="space-y-3 text-sm text-fg-muted">
          <p>
            <strong className="text-fg">{plural(totals.files, "file")}</strong> (about{" "}
            <strong className="text-fg">{formatSize(totals.bytes)}</strong>) will be{" "}
            {mode === "quarantine" ? "moved out of the way" : "sent to the Recycle Bin / Trash"}. Everything else stays where it is.
          </p>
          {mode === "quarantine" ? (
            <p>
              They go to a <code>FileFlow Quarantine</code> folder inside the folder you analyzed, on the same drive. You can restore
              them from <strong className="text-fg">History → Undo</strong>.
            </p>
          ) : (
            <p className="rounded-lg bg-warning-soft px-3 py-2 text-warning">
              FileFlow cannot undo this. To get a file back, restore it from the system Recycle Bin / Trash.
            </p>
          )}
          <p>
            Each file is checked again right before it is touched; anything that changed since the scan is skipped. Space actually
            freed may be less if files share storage.
          </p>
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="secondary" disabled={resolving} onClick={() => setConfirmOpen(false)}>
            Cancel
          </Button>
          <Button variant={mode === "trash" ? "danger" : "primary"} loading={resolving} onClick={handleRemove}>
            {mode === "quarantine" ? "Move to quarantine" : "Send to trash"}
          </Button>
        </div>
      </Modal>

      <Modal open={sensitive !== null} onClose={() => setSensitive(null)} title="Analyze this location?">
        <div className="space-y-3 text-sm text-fg-muted">
          {sensitive?.map((s) => (
            <div key={s.path} className="rounded-lg bg-warning-soft px-3 py-2">
              <p className="break-all font-mono text-xs text-fg">{s.path}</p>
              <p className="mt-1 text-warning">{s.reason}</p>
            </div>
          ))}
          <p>Only names, sizes and dates are read, and nothing is removed without your review, but this may take a long time.</p>
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="secondary" onClick={() => setSensitive(null)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setSensitive(null);
              void beginScan(true);
            }}
          >
            Analyze anyway
          </Button>
        </div>
      </Modal>
    </div>
  );
}
