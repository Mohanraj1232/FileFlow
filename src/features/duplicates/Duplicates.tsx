import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FolderPlus,
  X,
  ScanSearch,
  Copy,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  ShieldCheck,
  Archive,
  Trash2,
  AlertTriangle,
} from "lucide-react";
import type {
  DuplicateGroup,
  DuplicateScanSummary,
  RemoveMode,
  ResolveDuplicatesResult,
  RootCheck,
} from "../../lib/types";
import {
  checkScanRoots,
  startDuplicateScan,
  getDuplicateScan,
  getDuplicateGroups,
  cancelDuplicateScan,
  resolveDuplicates,
  revealDuplicateFile,
  onDuplicateProgress,
} from "../../lib/commands";
import { errorMessage } from "../../lib/errors";
import { formatSize, formatDate, plural } from "../../lib/format";
import { useToast } from "../../components/Toast";
import Modal from "../../components/Modal";
import EmptyState from "../../components/EmptyState";
import Badge from "../../components/ui/Badge";
import Button from "../../components/ui/Button";
import PageHeader from "../../components/ui/PageHeader";
import { Card, CardHeader, CardBody } from "../../components/ui/Card";
import { Select } from "../../components/ui/Field";
import {
  AUTO_KEEP_LABELS,
  autoSelect,
  buildDecisions,
  canMark,
  marksToKeepOnly,
  pruneMarks,
  summarize,
  type AutoKeep,
} from "./selection";

const PAGE_SIZE = 50;

const MIN_SIZE_OPTIONS = [
  { value: 1, label: "Any size" },
  { value: 1024, label: "1 KB or larger" },
  { value: 1024 * 1024, label: "1 MB or larger" },
  { value: 10 * 1024 * 1024, label: "10 MB or larger" },
];

const LAST_SCAN_KEY = "fileflow.duplicates.lastScan";

/**
 * Remember the last scan's id so the page can pick it back up after the user
 * visits other pages or the window reloads. The scan and its results live in
 * the main process; this is only a per-window convenience, so any storage
 * failure is ignored.
 */
function rememberScan(id: string | null) {
  try {
    if (id) sessionStorage.setItem(LAST_SCAN_KEY, id);
    else sessionStorage.removeItem(LAST_SCAN_KEY);
  } catch {
    /* storage unavailable */
  }
}

function recallScan(): string | null {
  try {
    return sessionStorage.getItem(LAST_SCAN_KEY);
  } catch {
    return null;
  }
}

function ProgressBar({ percent, label }: { percent: number; label: string }) {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={p}
      className="h-2 w-full overflow-hidden rounded-full bg-inset"
    >
      <div className="h-full bg-accent transition-all" style={{ width: `${p}%` }} />
    </div>
  );
}

function ScanProgressCard({ scan, onCancel }: { scan: DuplicateScanSummary; onCancel: () => void }) {
  const p = scan.progress;
  let title = "Starting…";
  let percent = 0;
  let detail = "";

  if (p) {
    if (p.phase === "walking") {
      title = "Looking through your folders…";
      detail = `${plural(p.files_seen, "file")} found so far (${formatSize(p.bytes_seen)})`;
    } else if (p.phase === "comparing") {
      title = "Comparing file sizes…";
      detail = `${plural(p.files_seen, "file")} · ${plural(p.candidate_files, "file")} share a size with another`;
    } else {
      title = "Verifying contents…";
      percent = p.total_hash_bytes > 0 ? (p.hashed_bytes / p.total_hash_bytes) * 100 : 100;
      detail = `${p.hashed_files.toLocaleString()} of ${plural(
        p.candidate_files,
        "candidate file",
      )} checked (${formatSize(p.hashed_bytes)} of ${formatSize(p.total_hash_bytes)})`;
    }
  }

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium text-fg">{title}</p>
          <Button variant="secondary" size="sm" icon={<X size={14} />} onClick={onCancel}>
            Cancel
          </Button>
        </div>
        <ProgressBar percent={percent} label={title} />
        <p className="text-xs text-fg-muted" aria-live="polite">
          {detail}
        </p>
        {p?.current_path && (
          <p className="truncate font-mono text-[11px] text-fg-subtle" title={p.current_path}>
            {p.current_path}
          </p>
        )}
      </CardBody>
    </Card>
  );
}

interface GroupCardProps {
  group: DuplicateGroup;
  marks: Set<string>;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleMark: (group: DuplicateGroup, path: string) => void;
  onKeepOnly: (group: DuplicateGroup, path: string) => void;
  onReveal: (path: string) => void;
}

function GroupCard({ group, marks, expanded, onToggleExpand, onToggleMark, onKeepOnly, onReveal }: GroupCardProps) {
  const markedHere = group.files.filter((f) => marks.has(f.path)).length;

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={onToggleExpand}
        aria-expanded={expanded}
        className="flex w-full cursor-pointer items-center justify-between gap-3 px-5 py-3.5 text-left hover:bg-hover/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <div className="flex min-w-0 items-center gap-3">
          {expanded ? <ChevronDown size={16} className="shrink-0 text-fg-muted" /> : <ChevronRight size={16} className="shrink-0 text-fg-muted" />}
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-fg" title={group.files[0].name}>
              {group.files[0].name}
            </p>
            <p className="text-xs text-fg-muted">
              {group.file_count} identical copies · {formatSize(group.size)} each
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {markedHere > 0 && <Badge tone="warning" size="sm">{markedHere} marked</Badge>}
          <Badge tone="accent" size="sm">{formatSize(group.reclaimable_bytes)} reclaimable</Badge>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border-muted">
          {group.files.map((file) => {
            const marked = marks.has(file.path);
            const disabled = !canMark(group, marks, file.path);
            const hardLinked = group.files.filter((f) => f.copy_id === file.copy_id).length > 1;
            return (
              <div
                key={file.path}
                className={`flex items-center gap-3 border-b border-border-muted px-5 py-2.5 last:border-b-0 ${
                  marked ? "bg-warning-soft/40" : ""
                }`}
              >
                <input
                  type="checkbox"
                  checked={marked}
                  disabled={disabled}
                  onChange={() => onToggleMark(group, file.path)}
                  aria-label={`Remove ${file.path}`}
                  title={disabled ? "At least one copy must be kept" : "Mark this copy for removal"}
                  className="h-4 w-4 shrink-0 cursor-pointer accent-[var(--accent)] disabled:cursor-not-allowed"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-fg" title={file.name}>
                    {file.name}
                    {!marked && markedHere > 0 && <span className="ml-2 text-xs text-success">kept</span>}
                  </p>
                  <p className="truncate font-mono text-[11px] text-fg-muted" title={file.path}>
                    {file.path}
                  </p>
                </div>
                <div className="hidden shrink-0 text-right text-xs text-fg-muted sm:block">
                  <p>{formatSize(file.size)}</p>
                  <p>{formatDate(file.modified_at)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <span title={file.hash_status === "verified" ? "Full SHA-256 compared in this scan" : "Hash reused from an earlier scan (file unchanged). It is re-checked before anything is removed."}>
                    <Badge tone={file.hash_status === "verified" ? "success" : "neutral"} size="sm">
                      <ShieldCheck size={11} className="mr-1" />
                      {file.hash_status === "verified" ? "verified" : "cached"}
                    </Badge>
                  </span>
                  {hardLinked && (
                    <span title="Hard links to the same stored data: removing one frees no space.">
                      <Badge tone="warning" size="sm">linked #{file.copy_id}</Badge>
                    </span>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => onKeepOnly(group, file.path)}>
                    Keep only this
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    aria-label={`Show ${file.name} in its folder`}
                    icon={<FolderOpen size={14} />}
                    onClick={() => onReveal(file.path)}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

export default function Duplicates() {
  const { addToast } = useToast();
  const [roots, setRoots] = useState<string[]>([]);
  const [minSize, setMinSize] = useState(1024);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [scan, setScan] = useState<DuplicateScanSummary | null>(null);
  const [starting, setStarting] = useState(false);

  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [totalGroups, setTotalGroups] = useState(0);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [marks, setMarks] = useState<Set<string>>(new Set());

  const [mode, setMode] = useState<RemoveMode>("quarantine");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [lastResult, setLastResult] = useState<ResolveDuplicatesResult | null>(null);
  const [sensitive, setSensitive] = useState<RootCheck["sensitive"] | null>(null);

  const loadedFor = useRef<string | null>(null);
  const scanId = scan?.scan_id ?? null;

  // ---- keep the progress card live ------------------------------------
  useEffect(() => {
    if (!window.electronAPI?.onDuplicateProgress) return;
    return onDuplicateProgress((summary) => {
      setScan((current) => (current && current.scan_id === summary.scan_id ? summary : current));
    });
  }, []);

  // Pick up a scan started earlier in this session (the scan lives in the main process).
  useEffect(() => {
    const id = recallScan();
    if (!id || !window.electronAPI?.getDuplicateScan) return;
    getDuplicateScan(id)
      .then((s) => {
        setScan(s);
        setRoots(s.roots);
      })
      .catch(() => rememberScan(null)); // expired or app restarted
  }, []);

  // ---- results ---------------------------------------------------------
  const loadGroups = useCallback(
    async (id: string, offset: number, replace: boolean) => {
      setLoadingGroups(true);
      try {
        const page = await getDuplicateGroups(id, offset, PAGE_SIZE);
        setTotalGroups(page.total_groups);
        setGroups((prev) => (replace ? page.groups : [...prev, ...page.groups]));
      } catch (e) {
        addToast({ type: "error", text: errorMessage(e) });
      } finally {
        setLoadingGroups(false);
      }
    },
    [addToast],
  );

  useEffect(() => {
    if (scan?.state === "done" && scan.scan_id !== loadedFor.current) {
      loadedFor.current = scan.scan_id;
      void loadGroups(scan.scan_id, 0, true);
    }
  }, [scan, loadGroups]);

  // ---- starting a scan -------------------------------------------------
  async function addFolder() {
    try {
      const folder = await window.electronAPI.showOpenDialog();
      if (folder) setRoots((prev) => (prev.includes(folder) ? prev : [...prev, folder]));
    } catch (e) {
      addToast({ type: "error", text: errorMessage(e) });
    }
  }

  async function beginScan(confirmSensitive: boolean) {
    setStarting(true);
    try {
      const started = await startDuplicateScan(roots, {
        min_size: minSize,
        include_hidden: includeHidden,
        confirm_sensitive: confirmSensitive,
      });
      rememberScan(started.scan_id);
      loadedFor.current = null;
      setGroups([]);
      setTotalGroups(0);
      setMarks(new Set());
      setExpanded(new Set());
      setLastResult(null);
      setScan(started);
      // A very small scan can finish before this call returns; fetch the settled state once.
      setScan(await getDuplicateScan(started.scan_id));
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
        addToast({
          type: "error",
          text: `FileFlow does not scan system folders: ${check.protected.join(", ")}`,
        });
        return;
      }
      if (check.sensitive.length) {
        setSensitive(check.sensitive); // ask first
        return;
      }
      await beginScan(false);
    } catch (e) {
      addToast({ type: "error", text: errorMessage(e) });
    }
  }

  async function handleCancel() {
    if (!scanId) return;
    try {
      await cancelDuplicateScan(scanId);
    } catch (e) {
      addToast({ type: "error", text: errorMessage(e) });
    }
  }

  // ---- selection -------------------------------------------------------
  function toggleMark(group: DuplicateGroup, path: string) {
    setMarks((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else if (canMark(group, prev, path)) next.add(path);
      return next;
    });
  }

  function keepOnly(group: DuplicateGroup, path: string) {
    setMarks((prev) => {
      const next = new Set(prev);
      for (const f of group.files) next.delete(f.path);
      for (const p of marksToKeepOnly(group, path)) next.add(p);
      return next;
    });
  }

  function toggleExpand(hash: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });
  }

  const selection = useMemo(() => summarize(groups, marks), [groups, marks]);

  // ---- removal ---------------------------------------------------------
  async function handleReveal(path: string) {
    if (!scanId) return;
    try {
      await revealDuplicateFile(scanId, path);
    } catch (e) {
      addToast({ type: "error", text: errorMessage(e) });
    }
  }

  async function handleRemove() {
    if (!scanId) return;
    setResolving(true);
    try {
      const result = await resolveDuplicates(scanId, buildDecisions(groups, marks), mode);
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

      // Refresh from the server, which has dropped everything that was removed.
      const keepLoaded = Math.max(PAGE_SIZE, groups.length);
      const page = await getDuplicateGroups(scanId, 0, keepLoaded);
      setGroups(page.groups);
      setTotalGroups(page.total_groups);
      setMarks((prev) => pruneMarks(page.groups, prev));
      setScan(await getDuplicateScan(scanId));
    } catch (e) {
      addToast({ type: "error", text: errorMessage(e) });
      setConfirmOpen(false);
    } finally {
      setResolving(false);
    }
  }

  const running = scan?.state === "running";
  const stats = scan?.stats;

  return (
    <div className="pb-24">
      <PageHeader
        title="Duplicate Finder"
        description="Find identical files and review them before anything is removed"
      />

      {/* ---- what to scan ---- */}
      <Card className="mb-4">
        <CardHeader title="Folders to scan" description="Files are compared by their contents, never by name or size alone." />
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
                    disabled={running}
                    icon={<X size={14} />}
                    onClick={() => setRoots((prev) => prev.filter((x) => x !== r))}
                  />
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-end gap-4">
            <Button variant="secondary" icon={<FolderPlus size={14} />} disabled={running} onClick={addFolder}>
              Add folder
            </Button>
            <div className="w-48">
              <label className="mb-1.5 block text-xs font-medium text-fg-muted" htmlFor="dup-min-size">
                Ignore files smaller than
              </label>
              <Select
                id="dup-min-size"
                value={minSize}
                disabled={running}
                onChange={(e) => setMinSize(Number(e.target.value))}
              >
                {MIN_SIZE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </Select>
            </div>
            <label className="flex cursor-pointer items-center gap-2 pb-2 text-sm text-fg-muted">
              <input
                type="checkbox"
                checked={includeHidden}
                disabled={running}
                onChange={(e) => setIncludeHidden(e.target.checked)}
                className="h-4 w-4 cursor-pointer accent-[var(--accent)]"
              />
              Include hidden files and folders
            </label>
            <div className="ml-auto">
              <Button
                variant="primary"
                icon={<ScanSearch size={16} />}
                loading={starting}
                disabled={roots.length === 0 || running}
                onClick={handleScan}
              >
                {running ? "Scanning…" : "Scan for duplicates"}
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>

      {/* ---- progress / outcome ---- */}
      {scan && running && <ScanProgressCard scan={scan} onCancel={handleCancel} />}

      {scan?.state === "cancelled" && (
        <Card>
          <EmptyState icon={X} title="Scan cancelled" description="Nothing was changed. Partial results are discarded; run the scan again when you're ready." />
        </Card>
      )}

      {scan?.state === "failed" && (
        <Card>
          <EmptyState icon={AlertTriangle} title="The scan failed" description={scan.error ?? "An unexpected error stopped the scan."} />
        </Card>
      )}

      {scan?.state === "done" && stats && (
        <div className="space-y-4">
          <Card>
            <CardBody className="flex flex-wrap items-center justify-between gap-4 !py-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="accent">{plural(stats.group_count, "duplicate group")}</Badge>
                <Badge tone="neutral">{plural(stats.duplicate_files, "extra copy", "extra copies")}</Badge>
                <Badge tone="success">{formatSize(stats.reclaimable_bytes)} reclaimable</Badge>
              </div>
              <p className="text-xs text-fg-muted">
                Scanned {plural(stats.files_scanned, "file")} ({formatSize(stats.bytes_scanned)}) · read {plural(stats.files_hashed, "file")}
                {stats.files_from_cache > 0 && ` · reused ${plural(stats.files_from_cache, "earlier result")}`}
              </p>
            </CardBody>
            {stats.error_count > 0 && (
              <details className="border-t border-border-muted px-5 py-3 text-xs text-fg-muted">
                <summary className="cursor-pointer text-warning">
                  {plural(stats.error_count, "file or folder")} could not be read
                </summary>
                <ul className="mt-2 space-y-1">
                  {stats.errors.map((e) => (
                    <li key={e.path} className="truncate font-mono" title={`${e.path} — ${e.error}`}>
                      {e.path} — {e.error}
                    </li>
                  ))}
                  {stats.error_count > stats.errors.length && <li>…and {stats.error_count - stats.errors.length} more</li>}
                </ul>
              </details>
            )}
          </Card>

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

          {groups.length === 0 && !loadingGroups ? (
            <Card>
              <EmptyState
                icon={Copy}
                title={lastResult && lastResult.removed_count > 0 ? "All cleaned up" : "No duplicates found"}
                description={
                  lastResult && lastResult.removed_count > 0
                    ? `Removed ${plural(lastResult.removed_count, "copy", "copies")} and freed ${formatSize(
                        lastResult.reclaimed_bytes,
                      )}. You can undo this from History.`
                    : "No two files in these folders have identical contents."
                }
              />
            </Card>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-fg-muted">
                  {marks.size === 0
                    ? "Nothing is selected yet. Open a group to choose what to keep, or let FileFlow pick for you:"
                    : "Review the marked files below (open a group to change what is kept), then remove them."}
                </p>
                <div className="flex items-center gap-2">
                  <div className="w-72">
                    <Select
                      aria-label="Automatically choose which copy to keep"
                      value=""
                      onChange={(e) => {
                        if (e.target.value) setMarks(autoSelect(groups, e.target.value as AutoKeep));
                      }}
                    >
                      <option value="">Auto-select…</option>
                      {(Object.keys(AUTO_KEEP_LABELS) as AutoKeep[]).map((k) => (
                        <option key={k} value={k}>{AUTO_KEEP_LABELS[k]}</option>
                      ))}
                    </Select>
                  </div>
                  <Button variant="ghost" size="sm" disabled={marks.size === 0} onClick={() => setMarks(new Set())}>
                    Clear selection
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                {groups.map((g) => (
                  <GroupCard
                    key={g.hash}
                    group={g}
                    marks={marks}
                    expanded={expanded.has(g.hash)}
                    onToggleExpand={() => toggleExpand(g.hash)}
                    onToggleMark={toggleMark}
                    onKeepOnly={keepOnly}
                    onReveal={handleReveal}
                  />
                ))}
              </div>

              {groups.length < totalGroups && (
                <div className="flex justify-center">
                  <Button variant="ghost" loading={loadingGroups} onClick={() => scanId && loadGroups(scanId, groups.length, false)}>
                    Show more ({totalGroups - groups.length} more groups)
                  </Button>
                </div>
              )}
              {groups.length < totalGroups && (
                <p className="text-center text-xs text-fg-subtle">
                  Auto-select and removal only apply to the groups shown above.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {!scan && (
        <Card>
          <EmptyState
            icon={Copy}
            title="Find duplicate files"
            description="Add the folders you want to check, then scan. You'll review every group before anything is moved or removed."
          />
        </Card>
      )}

      {/* ---- action bar ---- */}
      {scan?.state === "done" && groups.length > 0 && (
        <div className="sticky bottom-4 mt-4 flex flex-wrap items-center justify-end gap-4 rounded-xl border border-border bg-surface px-5 py-4 shadow-pop">
          <span className="mr-auto text-sm text-fg-muted" aria-live="polite">
            {selection.files === 0
              ? "No files marked for removal"
              : `${plural(selection.files, "file")} marked in ${plural(selection.groups, "group")} · ${formatSize(selection.bytes)} to free`}
          </span>
          <div className="w-72">
            <Select aria-label="What to do with removed copies" value={mode} onChange={(e) => setMode(e.target.value as RemoveMode)}>
              <option value="quarantine">Quarantine folder (undoable)</option>
              <option value="trash">Recycle Bin / Trash (not undoable)</option>
            </Select>
          </div>
          <Button
            variant={mode === "trash" ? "danger" : "primary"}
            icon={mode === "trash" ? <Trash2 size={16} /> : <Archive size={16} />}
            disabled={selection.files === 0}
            onClick={() => setConfirmOpen(true)}
          >
            Review and remove…
          </Button>
        </div>
      )}

      {/* ---- confirmations ---- */}
      <Modal open={confirmOpen} onClose={() => !resolving && setConfirmOpen(false)} title="Remove duplicate copies?">
        <div className="space-y-3 text-sm text-fg-muted">
          <p>
            <strong className="text-fg">{plural(selection.files, "file")}</strong> in{" "}
            <strong className="text-fg">{plural(selection.groups, "group")}</strong> will be{" "}
            {mode === "quarantine" ? "moved out of the way" : "sent to the Recycle Bin / Trash"}, freeing about{" "}
            <strong className="text-fg">{formatSize(selection.bytes)}</strong>. In every group, the files you did not mark are kept.
          </p>
          {mode === "quarantine" ? (
            <p>
              They go to a <code>FileFlow Quarantine</code> folder inside the folder you scanned, on the same drive. You can
              restore them from <strong className="text-fg">History → Undo</strong>.
            </p>
          ) : (
            <p className="rounded-lg bg-warning-soft px-3 py-2 text-warning">
              FileFlow cannot undo this. To get a file back, restore it from the system Recycle Bin / Trash.
            </p>
          )}
          <p>Each file is checked again right before it is touched; anything that changed since the scan is skipped.</p>
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

      <Modal open={sensitive !== null} onClose={() => setSensitive(null)} title="Scan this location?">
        <div className="space-y-3 text-sm text-fg-muted">
          {sensitive?.map((s) => (
            <div key={s.path} className="rounded-lg bg-warning-soft px-3 py-2">
              <p className="break-all font-mono text-xs text-fg">{s.path}</p>
              <p className="mt-1 text-warning">{s.reason}</p>
            </div>
          ))}
          <p>Nothing is removed without your review, but a scan here may take a long time and show files you didn't expect.</p>
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
            Scan anyway
          </Button>
        </div>
      </Modal>
    </div>
  );
}
