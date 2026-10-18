import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, ChevronRight, Info, Copy } from "lucide-react";
import type { DuplicateSavings, StorageFile, StorageRecommendation, StorageRecommendations } from "../../lib/types";
import { storageGetRecommendations, storageGetRecommendationFiles } from "../../lib/commands";
import { errorMessage } from "../../lib/errors";
import { formatSize, plural } from "../../lib/format";
import { useToast } from "../../components/Toast";
import Badge from "../../components/ui/Badge";
import Button from "../../components/ui/Button";
import EmptyState from "../../components/EmptyState";
import { Card, CardBody } from "../../components/ui/Card";
import { Select } from "../../components/ui/Field";
import FileTable, { type Selection } from "./FileTable";
import { OLD_MONTH_CHOICES } from "./logic";

const PAGE = 100;

interface CleanupTabProps {
  scanId: number;
  selection: Selection;
  onToggle: (file: StorageFile) => void;
  onToggleAll: (files: StorageFile[], selected: boolean) => void;
  onReveal: (path: string) => void;
  duplicates: DuplicateSavings | null;
  refreshKey: number;
}

function RecommendationCard({
  rec,
  scanId,
  months,
  selection,
  onToggle,
  onToggleAll,
  onReveal,
  refreshKey,
}: {
  rec: StorageRecommendation;
  scanId: number;
  months: number;
  selection: Selection;
  onToggle: CleanupTabProps["onToggle"];
  onToggleAll: CleanupTabProps["onToggleAll"];
  onReveal: CleanupTabProps["onReveal"];
  refreshKey: number;
}) {
  const { addToast } = useToast();
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<StorageFile[]>([]);
  const [totalCount, setTotalCount] = useState(rec.file_count);
  const [totalBytes, setTotalBytes] = useState(rec.bytes);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (offset: number) => {
      setLoading(true);
      try {
        const page = await storageGetRecommendationFiles(scanId, rec.id, months, offset, PAGE);
        setFiles((prev) => (offset === 0 ? page.files : [...prev, ...page.files]));
        setTotalCount(page.total_count);
        setTotalBytes(page.total_bytes);
      } catch (e) {
        addToast({ type: "error", text: errorMessage(e) });
      } finally {
        setLoading(false);
      }
    },
    [scanId, rec.id, months, addToast],
  );

  // Reload when opened, and whenever the threshold or the data changes while it is open.
  useEffect(() => {
    if (open) void load(0);
  }, [open, load, refreshKey, rec.file_count]);

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-start justify-between gap-4 px-5 py-4 text-left hover:bg-hover/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <div className="flex min-w-0 items-start gap-3">
          {open ? <ChevronDown size={16} className="mt-0.5 shrink-0 text-fg-muted" /> : <ChevronRight size={16} className="mt-0.5 shrink-0 text-fg-muted" />}
          <div className="min-w-0">
            <p className="text-sm font-medium text-fg">{rec.title}</p>
            <p className="text-xs text-fg-muted">{rec.description}</p>
            <p className="mt-1.5 flex gap-1.5 text-xs text-fg-subtle">
              <Info size={12} className="mt-0.5 shrink-0" />
              <span>{rec.basis}</span>
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge tone="success" size="sm">{formatSize(rec.bytes)}</Badge>
          <span className="text-xs text-fg-muted">{plural(rec.file_count, "file")}</span>
        </div>
      </button>

      {open && (
        <div className="border-t border-border-muted">
          <FileTable
            files={files}
            selection={selection}
            onToggle={onToggle}
            onToggleAll={onToggleAll}
            onReveal={onReveal}
            totalCount={totalCount}
            totalBytes={totalBytes}
            loading={loading}
            onMore={() => void load(files.length)}
            emptyText="Nothing here any more."
          />
        </div>
      )}
    </Card>
  );
}

export default function CleanupTab({
  scanId,
  selection,
  onToggle,
  onToggleAll,
  onReveal,
  duplicates,
  refreshKey,
}: CleanupTabProps) {
  const navigate = useNavigate();
  const { addToast } = useToast();
  const [months, setMonths] = useState(6);
  const [data, setData] = useState<StorageRecommendations | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    storageGetRecommendations(scanId, months)
      .then((r) => !cancelled && setData(r))
      .catch((e) => !cancelled && addToast({ type: "error", text: errorMessage(e) }))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [scanId, months, refreshKey, addToast]);

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0 text-sm text-fg-muted">
            <p>
              These are suggestions to <strong className="text-fg">review</strong>, never automatic. Nothing is removed until
              you tick files and confirm. Removal can be undone from History when you choose the quarantine option.
            </p>
            {data && data.recommendations.length > 0 && (
              <p className="mt-1">
                Up to <strong className="text-fg">{formatSize(data.total_bytes)}</strong> across{" "}
                <strong className="text-fg">{plural(data.total_files, "file")}</strong>. A file listed in more than one
                suggestion is counted once.
              </p>
            )}
          </div>
          <div className="w-60 shrink-0">
            <label htmlFor="old-months" className="mb-1.5 block text-xs font-medium text-fg-muted">
              Treat files as old when not modified in
            </label>
            <Select id="old-months" value={months} onChange={(e) => setMonths(Number(e.target.value))}>
              {OLD_MONTH_CHOICES.map((m) => (
                <option key={m} value={m}>{m === 12 ? "1 year" : m === 24 ? "2 years" : plural(m, "month")}</option>
              ))}
            </Select>
          </div>
        </CardBody>
      </Card>

      {/* Duplicates are counted apart from the suggestions below. */}
      <Card>
        <CardBody className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <Copy size={18} className="mt-0.5 shrink-0 text-fg-muted" />
            <div className="text-sm">
              <p className="font-medium text-fg">Duplicate files</p>
              <p className="text-xs text-fg-muted">
                {duplicates
                  ? `A duplicate scan of these folders found ${plural(duplicates.group_count, "group")} with ${formatSize(
                      duplicates.reclaimable_bytes,
                    )} reclaimable. This is counted separately from the suggestions below, because which copy you keep is your choice.`
                  : "Not scanned yet for these folders. Duplicates are counted separately from the suggestions below."}
              </p>
            </div>
          </div>
          <Button variant="secondary" size="sm" onClick={() => navigate("/duplicates")}>
            {duplicates ? "Review duplicates" : "Find duplicates"}
          </Button>
        </CardBody>
      </Card>

      {loading && !data ? (
        <p className="py-6 text-center text-sm text-fg-muted">Looking for things to clean up…</p>
      ) : !data || data.recommendations.length === 0 ? (
        <Card>
          <EmptyState
            icon={Info}
            title="Nothing to suggest"
            description={`No files match the cleanup suggestions at "not modified in ${months} months". Try a shorter time, or look through the Files tab yourself.`}
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {data.recommendations.map((r) => (
            <RecommendationCard
              key={`${r.id}-${months}`}
              rec={r}
              scanId={scanId}
              months={months}
              selection={selection}
              onToggle={onToggle}
              onToggleAll={onToggleAll}
              onReveal={onReveal}
              refreshKey={refreshKey}
            />
          ))}
        </div>
      )}
    </div>
  );
}
