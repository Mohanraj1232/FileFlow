import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  FolderPlus,
  Trash2,
  Eye,
  FileCheck,
  ListFilter,
  FolderOpen,
  Activity,
} from "lucide-react";
import type { DashboardStats, WatchedFolder, Operation } from "../../lib/types";
import {
  getDashboardStats,
  getWatchedFolders,
  addWatchedFolder,
  removeWatchedFolder,
} from "../../lib/commands";
import StatusBadge from "../../components/StatusBadge";
import EmptyState from "../../components/EmptyState";

interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: number;
  color: string;
}

function StatCard({ icon, label, value, color }: StatCardProps) {
  return (
    <div
      className="rounded-xl p-5 flex items-center gap-4"
      style={{
        backgroundColor: "var(--bg-primary)",
        border: "1px solid var(--border-color)",
        boxShadow: "var(--shadow-sm)",
      }}
    >
      <div
        className="w-11 h-11 rounded-lg flex items-center justify-center"
        style={{ backgroundColor: color + "18", color }}
      >
        {icon}
      </div>
      <div>
        <p className="text-2xl font-bold" style={{ color: "var(--text-primary)" }}>
          {value}
        </p>
        <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
          {label}
        </p>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [folders, setFolders] = useState<WatchedFolder[]>([]);
  const [recentOps, setRecentOps] = useState<Operation[]>([]);
  const [loading, setLoading] = useState(true);

  async function loadData() {
    setLoading(true);
    try {
      const [s, f] = await Promise.all([getDashboardStats(), getWatchedFolders()]);
      setStats(s);
      setFolders(f);
      setRecentOps(s.recent_operations ?? []);
    } catch {
      setStats(null);
      setFolders([]);
      setRecentOps([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  async function handleAddFolder() {
    try {
      const selected = await window.electronAPI.showOpenDialog();
      if (selected) {
        await addWatchedFolder(selected, false);
        loadData();
      }
    } catch {
      // dialog cancelled or backend unavailable
    }
  }

  async function handleRemoveFolder(id: number) {
    try {
      await removeWatchedFolder(id);
      loadData();
    } catch {
      // ignore errors
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div
          className="w-8 h-8 border-3 border-t-transparent rounded-full animate-spin"
          style={{ borderColor: "var(--accent)", borderTopColor: "transparent" }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold" style={{ color: "var(--text-primary)" }}>
          Dashboard
        </h1>
        <p className="text-sm mt-1" style={{ color: "var(--text-secondary)" }}>
          Overview of your file organization
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={<FileCheck size={20} />}
          label="Organized today"
          value={stats?.files_organized_today ?? 0}
          color="#3b82f6"
        />
        <StatCard
          icon={<Activity size={20} />}
          label="This week"
          value={stats?.files_organized_week ?? 0}
          color="#22c55e"
        />
        <StatCard
          icon={<ListFilter size={20} />}
          label="Active rules"
          value={stats?.active_rules ?? 0}
          color="#f59e0b"
        />
        <StatCard
          icon={<FolderOpen size={20} />}
          label="Watched folders"
          value={stats?.watched_folders ?? folders.length}
          color="#8b5cf6"
        />
      </div>

      <div
        className="rounded-xl p-6"
        style={{
          backgroundColor: "var(--bg-primary)",
          border: "1px solid var(--border-color)",
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <div className="flex items-center justify-between mb-4">
          <h2
            className="text-base font-semibold"
            style={{ color: "var(--text-primary)" }}
          >
            Watched Folders
          </h2>
          <button
            onClick={handleAddFolder}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium text-white cursor-pointer"
            style={{ backgroundColor: "var(--accent)" }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.backgroundColor = "var(--accent-hover)")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.backgroundColor = "var(--accent)")
            }
          >
            <FolderPlus size={14} />
            Add Folder
          </button>
        </div>
        {folders.length === 0 ? (
          <p className="text-sm py-4" style={{ color: "var(--text-muted)" }}>
            No folders being watched. Add a folder to get started.
          </p>
        ) : (
          <div className="space-y-2">
            {folders.map((f) => (
              <div
                key={f.id}
                className="flex items-center justify-between px-4 py-3 rounded-lg"
                style={{ backgroundColor: "var(--bg-secondary)" }}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <FolderOpen
                    size={16}
                    style={{ color: "var(--text-secondary)", flexShrink: 0 }}
                  />
                  <span
                    className="text-sm truncate"
                    style={{ color: "var(--text-primary)" }}
                  >
                    {f.path}
                  </span>
                  <StatusBadge status={f.enabled ? "done" : "skipped"} size="sm" />
                </div>
                <button
                  onClick={() => handleRemoveFolder(f.id)}
                  className="p-1.5 rounded-md cursor-pointer"
                  style={{ color: "var(--text-muted)" }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.color = "var(--danger)")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.color = "var(--text-muted)")
                  }
                  title="Remove folder"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div
        className="rounded-xl p-6"
        style={{
          backgroundColor: "var(--bg-primary)",
          border: "1px solid var(--border-color)",
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <div className="flex items-center justify-between mb-4">
          <h2
            className="text-base font-semibold"
            style={{ color: "var(--text-primary)" }}
          >
            Recent Activity
          </h2>
          <button
            onClick={() => navigate("/preview")}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium text-white cursor-pointer"
            style={{ backgroundColor: "var(--accent)" }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.backgroundColor = "var(--accent-hover)")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.backgroundColor = "var(--accent)")
            }
          >
            <Eye size={14} />
            Organize Now
          </button>
        </div>
        {recentOps.length === 0 ? (
          <EmptyState
            icon={Activity}
            title="No activity yet"
            description="Operations will appear here once files are organized."
          />
        ) : (
          <div className="space-y-2">
            {recentOps.map((op) => (
              <div
                key={op.id}
                className="flex items-center justify-between px-4 py-3 rounded-lg"
                style={{ backgroundColor: "var(--bg-secondary)" }}
              >
                <div className="flex items-center gap-3">
                  <span
                    className="text-sm"
                    style={{ color: "var(--text-primary)" }}
                  >
                    {op.summary ?? `Operation #${op.id}`}
                  </span>
                  <StatusBadge status={op.status} size="sm" />
                </div>
                <span
                  className="text-xs"
                  style={{ color: "var(--text-muted)" }}
                >
                  {new Date(op.started_at).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
