import { FolderOpen } from "lucide-react";
import type { StorageFile } from "../../lib/types";
import { formatSize, formatDate, plural } from "../../lib/format";
import Badge from "../../components/ui/Badge";
import Button from "../../components/ui/Button";
import { KIND_LABELS } from "./logic";

/** The files chosen for removal: path -> the disk space each adds. Shared by every tab. */
export type Selection = Map<string, number>;

interface FileTableProps {
  files: StorageFile[];
  selection: Selection;
  onToggle: (file: StorageFile) => void;
  onToggleAll: (files: StorageFile[], selected: boolean) => void;
  onReveal: (path: string) => void;
  totalCount: number;
  totalBytes: number;
  loading: boolean;
  onMore: () => void;
  emptyText: string;
}

/** A page of files with checkboxes. Nothing is ever pre-selected. */
export default function FileTable({
  files,
  selection,
  onToggle,
  onToggleAll,
  onReveal,
  totalCount,
  totalBytes,
  loading,
  onMore,
  emptyText,
}: FileTableProps) {
  const allShown = files.length > 0 && files.every((f) => selection.has(f.path));

  if (files.length === 0 && !loading) {
    return <p className="px-5 py-6 text-center text-sm text-fg-muted">{emptyText}</p>;
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-muted px-5 py-2.5 text-xs text-fg-muted">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={allShown}
            onChange={(e) => onToggleAll(files, e.target.checked)}
            aria-label="Select all files shown"
            className="h-4 w-4 cursor-pointer accent-[var(--accent)]"
          />
          Select all shown
        </label>
        <span aria-live="polite">
          {plural(totalCount, "file")} · {formatSize(totalBytes)}
          {files.length < totalCount && ` · showing ${files.length.toLocaleString()}`}
        </span>
      </div>

      <ul>
        {files.map((f) => {
          const checked = selection.has(f.path);
          return (
            <li
              key={f.id}
              className={`flex items-center gap-3 border-b border-border-muted px-5 py-2 last:border-b-0 ${
                checked ? "bg-warning-soft/40" : ""
              }`}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onToggle(f)}
                aria-label={`Select ${f.path}`}
                className="h-4 w-4 shrink-0 cursor-pointer accent-[var(--accent)]"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-fg" title={f.name}>
                  {f.name}
                </p>
                <p className="truncate font-mono text-[11px] text-fg-muted" title={f.path}>
                  {f.dir}
                </p>
              </div>
              <div className="hidden shrink-0 sm:block">
                <Badge tone="neutral" size="sm">
                  {KIND_LABELS[f.kind]}
                </Badge>
              </div>
              <div className="w-24 shrink-0 text-right text-sm tabular-nums text-fg">
                {formatSize(f.size)}
                {f.links > 1 && (
                  <span
                    className="block text-[10px] text-warning"
                    title="Hard-linked: this data is shared with other file names, so removing one name may free no space."
                  >
                    {f.stored_size === 0 ? "shared" : `${f.links} links`}
                  </span>
                )}
              </div>
              <div className="hidden w-24 shrink-0 text-right text-xs text-fg-muted md:block" title="Last modified">
                {formatDate(f.modified_at)}
              </div>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label={`Show ${f.name} in its folder`}
                icon={<FolderOpen size={14} />}
                onClick={() => onReveal(f.path)}
              />
            </li>
          );
        })}
      </ul>

      {files.length < totalCount && (
        <div className="flex justify-center border-t border-border-muted py-3">
          <Button variant="ghost" size="sm" loading={loading} onClick={onMore}>
            Show more ({(totalCount - files.length).toLocaleString()} more)
          </Button>
        </div>
      )}
    </div>
  );
}
