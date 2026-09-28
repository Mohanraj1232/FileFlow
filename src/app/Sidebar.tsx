import { NavLink } from "react-router-dom";
import { Play, Pause } from "lucide-react";
import { useState, useEffect } from "react";
import { startWatching, stopWatching, getWatchingStatus } from "../lib/commands";
import { useToast } from "../components/Toast";
import { navGroups, settingsNavItem, type NavItem } from "./nav";
import Button from "../components/ui/Button";

function SidebarLink({ to, label, icon: Icon }: NavItem) {
  return (
    <NavLink
      to={to}
      end={to === "/"}
      className={({ isActive }) =>
        `relative flex items-center gap-2.5 rounded-md py-2 pl-3 pr-2.5 text-sm font-medium transition-colors ${
          isActive
            ? "bg-accent-soft text-fg"
            : "text-fg-muted hover:bg-hover hover:text-fg"
        }`
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent" />
          )}
          <Icon size={16} className="shrink-0" />
          {label}
        </>
      )}
    </NavLink>
  );
}

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
    <aside className="flex flex-col overflow-y-auto border-r border-border bg-surface">
      <nav className="flex-1 space-y-4 px-3 py-4">
        {navGroups.map((group) => (
          <div key={group.label}>
            <p className="px-2.5 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">
              {group.label}
            </p>
            <div className="space-y-0.5">
              {group.items.map((item) => (
                <SidebarLink key={item.to} {...item} />
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t border-border-muted px-3 py-3">
        <SidebarLink {...settingsNavItem} />
      </div>

      <div className="mx-3 mb-3 flex items-center justify-between rounded-lg bg-inset px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${watching ? "bg-success" : "bg-warning"}`}
          />
          <span className="text-xs font-medium text-fg">
            {watching ? "Watching" : "Paused"}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={watching ? "Pause watching" : "Start watching"}
          icon={watching ? <Pause size={14} /> : <Play size={14} />}
          onClick={handleToggleWatch}
          disabled={toggling}
        />
      </div>
    </aside>
  );
}
