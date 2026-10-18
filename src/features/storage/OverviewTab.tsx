import { ChevronRight, FolderOpen, Files } from "lucide-react";
import type { FileKind, StorageReport } from "../../lib/types";
import { formatSize, formatDate, plural } from "../../lib/format";
import Badge from "../../components/ui/Badge";
import Button from "../../components/ui/Button";
import { Card, CardHeader, CardBody } from "../../components/ui/Card";
import { BarRow } from "./Bars";
import { crumbs, KIND_COLORS, KIND_LABELS } from "./logic";

interface OverviewTabProps {
  report: StorageReport;
  onOpenFolder: (path: string | null) => void;
  onShowFiles: (scope: { folder?: string | null; kind?: FileKind }) => void;
  onReveal: (path: string) => void;
}

export default function OverviewTab({ report, onOpenFolder, onShowFiles, onReveal }: OverviewTabProps) {
  const trail = crumbs(report.folder, report.scan.roots);
  const folderTotal = report.children.reduce((n, c) => n + c.bytes, 0) + report.direct_files.bytes;
  const kindTotal = report.by_kind.reduce((n, k) => n + k.bytes, 0);
  const ageTotal = report.age.reduce((n, a) => n + a.bytes, 0);

  return (
    <div className="space-y-4">
      {/* ---- where the space is ---- */}
      <Card>
        <CardHeader
          title="Where the space is"
          description="Each folder includes everything inside it. Click a folder to look inside."
        />
        <CardBody className="space-y-3">
          <nav aria-label="Folder path" className="flex flex-wrap items-center gap-1 text-sm">
            {trail.map((c, i) => (
              <span key={c.path ?? "top"} className="flex items-center gap-1">
                {i > 0 && <ChevronRight size={12} className="text-fg-subtle" />}
                {i === trail.length - 1 ? (
                  <span className="font-medium text-fg" aria-current="page">{c.label}</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onOpenFolder(c.path)}
                    className="cursor-pointer text-accent-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    {c.label}
                  </button>
                )}
              </span>
            ))}
            {report.folder && (
              <Button
                variant="soft"
                size="sm"
                className="ml-auto"
                icon={<Files size={13} />}
                onClick={() => onShowFiles({ folder: report.folder })}
              >
                Show files here
              </Button>
            )}
          </nav>

          {report.children.length === 0 && report.direct_files.files === 0 ? (
            <p className="py-2 text-sm text-fg-muted">This folder is empty.</p>
          ) : (
            <div>
              {report.children.slice(0, 30).map((c) => (
                <BarRow
                  key={c.path}
                  label={
                    <span className="inline-flex items-center gap-2">
                      <FolderOpen size={14} className="shrink-0 text-fg-muted" />
                      {c.name}
                    </span>
                  }
                  detail={plural(c.files, "file")}
                  valueLabel={formatSize(c.bytes)}
                  value={c.bytes}
                  total={folderTotal}
                  onClick={() => onOpenFolder(c.path)}
                  title={c.path}
                />
              ))}
              {report.children.length > 30 && (
                <p className="px-1 py-2 text-xs text-fg-subtle">…and {report.children.length - 30} smaller folders</p>
              )}
              {report.direct_files.files > 0 && (
                <BarRow
                  label="Files directly in this folder"
                  detail={plural(report.direct_files.files, "file")}
                  valueLabel={formatSize(report.direct_files.bytes)}
                  value={report.direct_files.bytes}
                  total={folderTotal}
                  color="bg-fg-subtle"
                  onClick={report.folder ? () => onShowFiles({ folder: report.folder }) : undefined}
                />
              )}
            </div>
          )}
        </CardBody>
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* ---- by type ---- */}
        <Card>
          <CardHeader title="By file type" description="Click a type to list its files." />
          <CardBody>
            {report.by_kind.length === 0 ? (
              <p className="text-sm text-fg-muted">No files.</p>
            ) : (
              report.by_kind.map((k) => (
                <BarRow
                  key={k.kind}
                  label={KIND_LABELS[k.kind]}
                  detail={
                    `${plural(k.files, "file")}` +
                    (k.top_extensions.length
                      ? " · " + k.top_extensions.slice(0, 3).map((e) => `${e.ext || "no extension"} ${formatSize(e.bytes)}`).join(", ")
                      : "")
                  }
                  valueLabel={formatSize(k.bytes)}
                  value={k.bytes}
                  total={kindTotal}
                  color={KIND_COLORS[k.kind]}
                  onClick={() => onShowFiles({ kind: k.kind, folder: report.folder })}
                />
              ))
            )}
          </CardBody>
        </Card>

        {/* ---- age ---- */}
        <Card>
          <CardHeader
            title="How long since files changed"
            description="Based on last modified date. A file that has not changed may still be one you need."
          />
          <CardBody>
            {report.age.map((a) => (
              <BarRow
                key={a.label}
                label={a.label}
                detail={plural(a.files, "file")}
                valueLabel={formatSize(a.bytes)}
                value={a.bytes}
                total={ageTotal}
                color="bg-warning"
              />
            ))}
          </CardBody>
        </Card>

        {/* ---- largest folders ---- */}
        <Card>
          <CardHeader title="Largest folders" description="Including everything inside them." />
          <CardBody>
            {report.largest_folders.length === 0 ? (
              <p className="text-sm text-fg-muted">No subfolders.</p>
            ) : (
              report.largest_folders.map((f) => (
                <BarRow
                  key={f.path}
                  label={f.name}
                  detail={f.path}
                  valueLabel={formatSize(f.bytes)}
                  value={f.bytes}
                  total={report.largest_folders[0].bytes}
                  onClick={() => onOpenFolder(f.path)}
                  title={`Look inside ${f.path}`}
                />
              ))
            )}
          </CardBody>
        </Card>

        {/* ---- largest files ---- */}
        <Card>
          <CardHeader title="Largest files" />
          <CardBody>
            {report.largest_files.length === 0 ? (
              <p className="text-sm text-fg-muted">No files.</p>
            ) : (
              <ul className="space-y-1.5">
                {report.largest_files.map((f) => (
                  <li key={f.id} className="flex items-center gap-3 rounded-lg bg-inset px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-fg" title={f.path}>{f.name}</p>
                      <p className="truncate font-mono text-[11px] text-fg-muted" title={f.dir}>{f.dir}</p>
                    </div>
                    <Badge tone="neutral" size="sm">{formatDate(f.modified_at)}</Badge>
                    <span className="w-20 shrink-0 text-right text-sm tabular-nums text-fg">{formatSize(f.size)}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      aria-label={`Show ${f.name} in its folder`}
                      icon={<FolderOpen size={14} />}
                      onClick={() => onReveal(f.path)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      {report.errors.length > 0 && (
        <Card>
          <details className="px-5 py-3 text-xs text-fg-muted">
            <summary className="cursor-pointer text-warning">
              {plural(report.scan.error_count, "file or folder")} could not be read and are not counted
            </summary>
            <ul className="mt-2 space-y-1">
              {report.errors.map((e) => (
                <li key={e.path} className="truncate font-mono" title={`${e.path} — ${e.error}`}>
                  {e.path} — {e.error}
                </li>
              ))}
              {report.scan.error_count > report.errors.length && (
                <li>…and {report.scan.error_count - report.errors.length} more</li>
              )}
            </ul>
          </details>
        </Card>
      )}
    </div>
  );
}
