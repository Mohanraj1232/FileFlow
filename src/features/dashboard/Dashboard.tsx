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
  toggleWatchedFolder,
} from "../../lib/commands";
import StatusBadge from "../../components/StatusBadge";
import EmptyState from "../../components/EmptyState";
import Button from "../../components/ui/Button";
import PageHeader from "../../components/ui/PageHeader";
import { Card, CardHeader, CardBody } from "../../components/ui/Card";
import StatCard from "../../components/ui/StatCard";
import { LoadingState } from "../../components/ui/Spinner";
import Toggle from "../../components/Toggle";

function formatRelativeTime(iso: string): string {
  const diffSec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(iso).toLocaleDateString();
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

  async function handleToggleFolder(folder: WatchedFolder) {
    setFolders((prev) =>
      prev.map((f) => (f.id === folder.id ? { ...f, enabled: !f.enabled } : f)),
    );
    try {
      await toggleWatchedFolder(folder.id, !folder.enabled);
    } catch {
      loadData();
    }
  }

  if (loading) return <LoadingState />;

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description="Overview of your file organization"
        actions={
          <>
            <Button
              variant="secondary"
              onClick={handleAddFolder}
              icon={<FolderPlus size={14} />}
            >
              Add Folder
            </Button>
            <Button
              variant="primary"
              onClick={() => navigate("/preview")}
              disabled={folders.length === 0}
              icon={<Eye size={14} />}
            >
              Organize Now
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard
          icon={<FileCheck size={20} />}
          label="Organized today"
          value={stats?.files_organized_today ?? 0}
          tone="accent"
        />
        <StatCard
          icon={<Activity size={20} />}
          label="This week"
          value={stats?.files_organized_week ?? 0}
          tone="success"
        />
        <StatCard
          icon={<ListFilter size={20} />}
          label="Active rules"
          value={stats?.active_rules ?? 0}
          tone="warning"
        />
        <StatCard
          icon={<FolderOpen size={20} />}
          label="Watched folders"
          value={stats?.watched_folders ?? folders.length}
          tone="accent"
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <CardHeader title="Watched Folders" />
          <CardBody>
            {folders.length === 0 ? (
              <p className="py-2 text-sm text-fg-muted">
                No folders being watched. Add a folder to get started.
              </p>
            ) : (
              <div className="space-y-2">
                {folders.map((f) => (
                  <div
                    key={f.id}
                    className="flex items-center justify-between gap-3 rounded-lg bg-inset px-3 py-2.5"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <FolderOpen size={16} className="shrink-0 text-fg-muted" />
                      <span className="truncate text-sm text-fg" title={f.path}>
                        {f.path}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Toggle
                        checked={!!f.enabled}
                        onChange={() => handleToggleFolder(f)}
                      />
                      <Button
                        variant="ghostDanger"
                        size="sm"
                        iconOnly
                        aria-label="Remove folder"
                        icon={<Trash2 size={14} />}
                        onClick={() => handleRemoveFolder(f.id)}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>

        <Card className="flex flex-col lg:col-span-3">
          <CardHeader title="Recent Activity" />
          {recentOps.length === 0 ? (
            <EmptyState
              icon={Activity}
              title="No activity yet"
              description="Operations will appear here once files are organized."
              actionLabel={
                folders.length === 0 ? "Add a Folder to Start" : undefined
              }
              onAction={folders.length === 0 ? handleAddFolder : undefined}
            />
          ) : (
            <CardBody className="space-y-2">
              {recentOps.map((op) => (
                <div
                  key={op.id}
                  className="flex items-center justify-between gap-3 rounded-lg bg-inset px-3 py-2.5"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="truncate text-sm text-fg">
                      {op.summary ?? `Operation #${op.id}`}
                    </span>
                    <StatusBadge status={op.status} size="sm" />
                  </div>
                  <span className="shrink-0 text-xs text-fg-muted">
                    {formatRelativeTime(op.started_at)}
                  </span>
                </div>
              ))}
            </CardBody>
          )}
        </Card>
      </div>
    </div>
  );
}
