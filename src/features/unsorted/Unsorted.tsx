import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Inbox, Plus, FileText } from "lucide-react";
import type { WatchedFolder, UnsortedFile, FileKind } from "../../lib/types";
import { getWatchedFolders, getUnsortedFiles } from "../../lib/commands";
import EmptyState from "../../components/EmptyState";
import Badge, { type BadgeTone } from "../../components/ui/Badge";
import Button from "../../components/ui/Button";
import PageHeader from "../../components/ui/PageHeader";
import { Card } from "../../components/ui/Card";
import { Select } from "../../components/ui/Field";
import { Table, THead, Th, TRow, Td } from "../../components/ui/Table";
import { LoadingState } from "../../components/ui/Spinner";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const kindTones: Record<FileKind, BadgeTone> = {
  document: "accent",
  image: "accent",
  video: "danger",
  audio: "warning",
  archive: "neutral",
  code: "success",
  installer: "danger",
  other: "neutral",
};

export default function Unsorted() {
  const navigate = useNavigate();
  const [folders, setFolders] = useState<WatchedFolder[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<number | "">("");
  const [files, setFiles] = useState<UnsortedFile[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const f = await getWatchedFolders();
        setFolders(f);
        if (f.length > 0) setSelectedFolder(f[0].id);
      } catch {
        setFolders([]);
      }
    })();
  }, []);

  useEffect(() => {
    if (!selectedFolder) {
      setFiles([]);
      return;
    }
    (async () => {
      setLoading(true);
      try {
        const result = await getUnsortedFiles(selectedFolder as number);
        setFiles(result);
      } catch {
        setFiles([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [selectedFolder]);

  function handleCreateRule(file: UnsortedFile) {
    const params = new URLSearchParams({
      ext: file.extension,
      kind: file.kind,
    });
    navigate(`/rules/new?${params.toString()}`);
  }

  return (
    <div>
      <PageHeader
        title="Unsorted Files"
        description="Files that don't match any rule"
        actions={
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
        }
      />

      {loading ? (
        <LoadingState height="h-32" />
      ) : files.length === 0 ? (
        <Card>
          <EmptyState
            icon={Inbox}
            title={selectedFolder ? "All sorted!" : "Select a folder"}
            description={
              selectedFolder
                ? "Every file in this folder matches an existing rule."
                : "Choose a watched folder above to see unsorted files."
            }
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <Table>
            <THead>
              <tr>
                <Th>File</Th>
                <Th className="w-24 text-center">Kind</Th>
                <Th className="w-24 text-right">Size</Th>
                <Th className="w-28 text-right">Modified</Th>
                <Th className="w-28" />
              </tr>
            </THead>
            <tbody>
              {files.map((file) => (
                <TRow key={file.path}>
                  <Td>
                    <div className="flex items-center gap-2">
                      <FileText size={16} className="shrink-0 text-fg-muted" />
                      <div className="min-w-0">
                        <p className="truncate text-sm text-fg">{file.name}</p>
                        <p className="text-[10px] text-fg-subtle">
                          .{file.extension}
                        </p>
                      </div>
                    </div>
                  </Td>
                  <Td className="text-center">
                    <Badge tone={kindTones[file.kind] ?? "neutral"} size="sm">
                      {file.kind}
                    </Badge>
                  </Td>
                  <Td className="text-right text-fg-muted">
                    {formatSize(file.size)}
                  </Td>
                  <Td className="text-right text-fg-muted">
                    {new Date(file.modified_at).toLocaleDateString()}
                  </Td>
                  <Td className="text-right">
                    <Button
                      variant="soft"
                      size="sm"
                      className="ml-auto"
                      icon={<Plus size={12} />}
                      onClick={() => handleCreateRule(file)}
                    >
                      Create Rule
                    </Button>
                  </Td>
                </TRow>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}
