import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  ListFilter,
  Eye,
  Clock,
  Inbox,
  Settings2,
  Play,
  Pause,
  FileStack,
} from "lucide-react";
import { useState, useEffect } from "react";
import { startWatching, stopWatching, getWatchingStatus } from "../lib/commands";
import { useToast } from "../components/Toast";

const navItems = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/rules", label: "Rules", icon: ListFilter },
  { to: "/preview", label: "Preview", icon: Eye },
  { to: "/history", label: "History", icon: Clock },
  { to: "/unsorted", label: "Unsorted", icon: Inbox },
  { to: "/settings", label: "Settings", icon: Settings2 },
];

export default function Sidebar() {
  const [watching, setWatching] = useState(false);
  const [toggling, setToggling] = useState(false);
  const { addToast } = useToast();

  useEffect(() => {
    getWatchingStatus()
      .then((status) => setWatching(status.watching))
      .catch(() => {
        // backend may not be ready yet — keep the default
      });
  }, []);

  async function handleToggleWatch() {
    setToggling(true);
    try {
      if (watching) {
        await stopWatching();
        setWatching(false);
      } else {
        await startWatching();
        setWatching(true);
      }
    } catch (e) {
      addToast({
        type: "error",
        text: `Failed to ${watching ? "pause" : "start"} watching: ${String(e)}`,
      });
    } finally {
      setToggling(false);
    }
  }

  return (
    <aside
      className="fixed left-0 top-0 bottom-0 w-60 flex flex-col z-10"
      style={{ backgroundColor: "var(--bg-sidebar)" }}
    >
      <div className="px-5 py-6 flex items-center gap-3">
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
          style={{
            background: "linear-gradient(135deg, var(--accent), var(--accent-hover))",
            boxShadow: "var(--shadow-md)",
          }}
        >
          <FileStack size={20} color="white" />
        </div>
        <div>
          <h1
            className="text-lg font-bold tracking-tight"
            style={{ color: "var(--text-sidebar)" }}
          >
            FileFlow
          </h1>
          <p className="text-[10px]" style={{ color: "var(--text-sidebar-muted)" }}>
            Your files. Automatically organized.
          </p>
        </div>
      </div>

      <nav className="flex-1 px-3 space-y-0.5">
        {navItems.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            className="flex items-center gap-3 pl-[13px] pr-4 py-2.5 rounded-lg text-sm font-medium transition-colors"
            style={({ isActive }) => ({
              backgroundColor: isActive ? "var(--bg-sidebar-active)" : "transparent",
              color: isActive ? "var(--text-sidebar)" : "var(--text-sidebar-muted)",
              borderLeft: isActive
                ? "3px solid var(--accent)"
                : "3px solid transparent",
            })}
            onMouseEnter={(e) => {
              if (!e.currentTarget.classList.contains("active"))
                e.currentTarget.style.backgroundColor = "var(--bg-sidebar-hover)";
            }}
            onMouseLeave={(e) => {
              const isActive = e.currentTarget.getAttribute("aria-current") === "page";
              e.currentTarget.style.backgroundColor = isActive
                ? "var(--bg-sidebar-active)"
                : "transparent";
            }}
          >
            <Icon size={18} />
            {label}
          </NavLink>
        ))}
      </nav>

      <div
        className="px-4 py-4 mx-3 mb-3 rounded-lg"
        style={{ backgroundColor: "var(--bg-sidebar-active)" }}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span
              className="w-2 h-2 rounded-full"
              style={{
                backgroundColor: watching ? "var(--success)" : "var(--warning)",
              }}
            />
            <span
              className="text-xs font-medium"
              style={{ color: "var(--text-sidebar)" }}
            >
              {watching ? "Watching" : "Paused"}
            </span>
          </div>
          <button
            onClick={handleToggleWatch}
            disabled={toggling}
            className="p-1.5 rounded-md cursor-pointer transition-colors disabled:opacity-50"
            style={{ color: "var(--text-sidebar-muted)" }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.color = "var(--text-sidebar)")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.color = "var(--text-sidebar-muted)")
            }
            title={watching ? "Pause watching" : "Start watching"}
          >
            {watching ? <Pause size={14} /> : <Play size={14} />}
          </button>
        </div>
      </div>
    </aside>
  );
}
