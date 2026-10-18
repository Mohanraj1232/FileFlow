import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { FileKind, StorageFile, StorageSort } from "../../lib/types";
import { storageQueryFiles } from "../../lib/commands";
import { errorMessage } from "../../lib/errors";
import { useToast } from "../../components/Toast";
import Badge from "../../components/ui/Badge";
import Button from "../../components/ui/Button";
import { Card, CardBody } from "../../components/ui/Card";
import { Input, Select } from "../../components/ui/Field";
import FileTable, { type Selection } from "./FileTable";
import {
  AGE_CHOICES,
  EMPTY_FILTER,
  KIND_LABELS,
  MIN_SIZE_CHOICES,
  buildFilter,
  hasActiveFilter,
  type FilterState,
} from "./logic";

const PAGE = 100;

const SORT_LABELS: Record<StorageSort, string> = {
  size_desc: "Largest first",
  size_asc: "Smallest first",
  mtime_asc: "Oldest first",
  mtime_desc: "Newest first",
  name: "Name A–Z",
  path: "Path A–Z",
};

interface FilesTabProps {
  scanId: number;
  filter: FilterState;
  onFilterChange: (f: FilterState) => void;
  selection: Selection;
  onToggle: (file: StorageFile) => void;
  onToggleAll: (files: StorageFile[], selected: boolean) => void;
  onReveal: (path: string) => void;
  /** Changes whenever the underlying data changed (e.g. after a removal), to reload the list. */
  refreshKey: number;
}

export default function FilesTab({
  scanId,
  filter,
  onFilterChange,
  selection,
  onToggle,
  onToggleAll,
  onReveal,
  refreshKey,
}: FilesTabProps) {
  const { addToast } = useToast();
  const [sort, setSort] = useState<StorageSort>("size_desc");
  const [files, setFiles] = useState<StorageFile[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);

  // Reload (debounced, so typing does not fire a query per keystroke) whenever the filter or sort changes.
  useEffect(() => {
    const mine = ++requestId.current;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const page = await storageQueryFiles(scanId, buildFilter(filter), sort, 0, PAGE);
        if (mine !== requestId.current) return; // a newer request superseded this one
        setFiles(page.files);
        setTotalCount(page.total_count);
        setTotalBytes(page.total_bytes);
      } catch (e) {
        if (mine === requestId.current) addToast({ type: "error", text: errorMessage(e) });
      } finally {
        if (mine === requestId.current) setLoading(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [scanId, filter, sort, refreshKey, addToast]);

  async function loadMore() {
    const mine = requestId.current;
    setLoading(true);
    try {
      const page = await storageQueryFiles(scanId, buildFilter(filter), sort, files.length, PAGE);
      if (mine !== requestId.current) return;
      setFiles((prev) => [...prev, ...page.files]);
      setTotalCount(page.total_count);
      setTotalBytes(page.total_bytes);
    } catch (e) {
      addToast({ type: "error", text: errorMessage(e) });
    } finally {
      setLoading(false);
    }
  }

  const set = (patch: Partial<FilterState>) => onFilterChange({ ...filter, ...patch });

  return (
    <Card className="overflow-hidden">
      <CardBody className="space-y-3 border-b border-border-muted">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Type" id="f-kind" width="w-40">
            <Select id="f-kind" value={filter.kind} onChange={(e) => set({ kind: e.target.value as FileKind | "" })}>
              <option value="">All types</option>
              {(Object.keys(KIND_LABELS) as FileKind[]).map((k) => (
                <option key={k} value={k}>{KIND_LABELS[k]}</option>
              ))}
            </Select>
          </Field>
          <Field label="Extension" id="f-ext" width="w-28">
            <Input id="f-ext" placeholder="e.g. mp4" value={filter.ext} onChange={(e) => set({ ext: e.target.value })} />
          </Field>
          <Field label="Size" id="f-size" width="w-44">
            <Select id="f-size" value={filter.minSize} onChange={(e) => set({ minSize: Number(e.target.value) })}>
              {MIN_SIZE_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </Select>
          </Field>
          <Field label="Last modified" id="f-age" width="w-56">
            <Select id="f-age" value={filter.olderThanMonths} onChange={(e) => set({ olderThanMonths: Number(e.target.value) })}>
              {AGE_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </Select>
          </Field>
          <Field label="Name contains" id="f-name" width="w-48">
            <Input id="f-name" placeholder="Part of a file name" value={filter.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label="Sort" id="f-sort" width="w-40">
            <Select id="f-sort" value={sort} onChange={(e) => setSort(e.target.value as StorageSort)}>
              {(Object.keys(SORT_LABELS) as StorageSort[]).map((s) => <option key={s} value={s}>{SORT_LABELS[s]}</option>)}
            </Select>
          </Field>
        </div>

        {(filter.folder || hasActiveFilter(filter)) && (
          <div className="flex flex-wrap items-center gap-2">
            {filter.folder && (
              <Badge tone="accent">
                In folder: <span className="ml-1 max-w-[28rem] truncate font-mono normal-case" title={filter.folder}>{filter.folder}</span>
                <button
                  type="button"
                  aria-label="Remove folder filter"
                  className="ml-1.5 cursor-pointer"
                  onClick={() => set({ folder: null })}
                >
                  <X size={11} />
                </button>
              </Badge>
            )}
            {hasActiveFilter(filter) && (
              <Button variant="ghost" size="sm" onClick={() => onFilterChange(EMPTY_FILTER)}>
                Clear all filters
              </Button>
            )}
          </div>
        )}
      </CardBody>

      <FileTable
        files={files}
        selection={selection}
        onToggle={onToggle}
        onToggleAll={onToggleAll}
        onReveal={onReveal}
        totalCount={totalCount}
        totalBytes={totalBytes}
        loading={loading}
        onMore={loadMore}
        emptyText="No files match these filters."
      />
    </Card>
  );
}

function Field({ label, id, width, children }: { label: string; id: string; width: string; children: React.ReactNode }) {
  return (
    <div className={width}>
      <label htmlFor={id} className="mb-1.5 block text-xs font-medium text-fg-muted">
        {label}
      </label>
      {children}
    </div>
  );
}
