import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Inbox, Plus, FileText } from "lucide-react";
import type { WatchedFolder, UnsortedFile, FileKind } from "../../lib/types";
import { getWatchedFolders, getUnsortedFiles } from "../../lib/commands";
import EmptyState from "../../components/EmptyState";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const kindColors: Record<FileKind, string> = {
  document: "#3b82f6",
  image: "#8b5cf6",
  video: "#ef4444",
  audio: "#f59e0b",
  archive: "#6b7280",
  code: "#22c55e",
  installer: "#ec4899",
  other: "#94a3b8",
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
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold" style={{ color: "var(--text-primary)" }}>
          Unsorted Files
        </h1>
        <p className="text-sm mt-1" style={{ color: "var(--text-secondary)" }}>
          Files that don&apos;t match any rule
        </p>
      </div>

      <div
        className="rounded-xl p-6"
        style={{
          backgroundColor: "var(--bg-primary)",
          border: "1px solid var(--border-color)",
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <label
          className="block text-xs font-medium mb-1.5"
          style={{ color: "var(--text-secondary)" }}
        >
          Folder
        </label>
        <select
          value={selectedFolder}
          onChange={(e) =>
            setSelectedFolder(e.target.value ? Number(e.target.value) : "")
          }
          className="w-full max-w-md px-3 py-2 rounded-lg text-sm cursor-pointer"
          style={{
            backgroundColor: "var(--bg-secondary)",
            color: "var(--text-primary)",
            border: "1px solid var(--border-color)",
          }}
        >
          <option value="">Select a folder...</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.path}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-32">
          <div
            className="w-8 h-8 border-3 border-t-transparent rounded-full animate-spin"
            style={{ borderColor: "var(--accent)", borderTopColor: "transparent" }}
          />
        </div>
      ) : files.length === 0 ? (
        <div
          className="rounded-xl"
          style={{
            backgroundColor: "var(--bg-primary)",
            border: "1px solid var(--border-color)",
          }}
        >
          <EmptyState
            icon={Inbox}
            title={selectedFolder ? "All sorted!" : "Select a folder"}
            description={
              selectedFolder
                ? "Every file in this folder matches an existing rule."
                : "Choose a watched folder above to see unsorted files."
            }
          />
        </div>
      ) : (
        <div
          className="rounded-xl overflow-hidden"
          style={{
            backgroundColor: "var(--bg-primary)",
            border: "1px solid var(--border-color)",
            boxShadow: "var(--shadow-sm)",
          }}
        >
          <table className="w-full">
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border-color)" }}>
                <th
                  className="text-left text-xs font-medium uppercase tracking-wider px-5 py-3"
                  style={{ color: "var(--text-muted)" }}
                >
                  File
                </th>
                <th
                  className="text-center text-xs font-medium uppercase tracking-wider px-4 py-3"
                  style={{ color: "var(--text-muted)" }}
                >
                  Kind
                </th>
                <th
                  className="text-right text-xs font-medium uppercase tracking-wider px-4 py-3"
                  style={{ color: "var(--text-muted)" }}
                >
                  Size
                </th>
                <th
                  className="text-right text-xs font-medium uppercase tracking-wider px-4 py-3"
                  style={{ color: "var(--text-muted)" }}
                >
                  Modified
                </th>
                <th className="w-28 px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {files.map((file) => (
                <tr
                  key={file.path}
                  style={{ borderBottom: "1px solid var(--border-color)" }}
                >
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <FileText
                        size={16}
                        style={{ color: "var(--text-muted)", flexShrink: 0 }}
                      />
                      <div className="min-w-0">
                        <p
                          className="text-sm truncate"
                          style={{ color: "var(--text-primary)" }}
                        >
                          {file.name}
                        </p>
                        <p
                          className="text-[10px]"
                          style={{ color: "var(--text-muted)" }}
                        >
                          .{file.extension}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span
                      className="inline-block text-[10px] font-medium px-2 py-0.5 rounded-full capitalize"
                      style={{
                        backgroundColor: (kindColors[file.kind] ?? "#94a3b8") + "18",
                        color: kindColors[file.kind] ?? "#94a3b8",
                      }}
                    >
                      {file.kind}
                    </span>
                  </td>
                  <td
                    className="px-4 py-3 text-right text-xs"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {formatSize(file.size)}
                  </td>
                  <td
                    className="px-4 py-3 text-right text-xs"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {new Date(file.modified_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => handleCreateRule(file)}
                      className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium cursor-pointer ml-auto"
                      style={{
                        color: "var(--accent)",
                        backgroundColor: "var(--accent-light)",
                      }}
                    >
                      <Plus size={12} />
                      Create Rule
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
