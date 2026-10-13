import { useEffect, useRef } from "react";
import { Outlet } from "react-router-dom";
import Sidebar from "./Sidebar";
import TitleBar from "./TitleBar";
import { useToast } from "../components/Toast";
import { onFileProcessed } from "../lib/commands";

/** Fired on `window` whenever the watcher changed something, so open pages can reload. */
export const DATA_CHANGED_EVENT = "fileflow:data-changed";

/** A burst of files is announced once, after things go quiet for this long. */
const NOTIFY_QUIET_MS = 1500;

export default function Layout() {
  const { addToast } = useToast();
  const pending = useRef<{ count: number; rules: Set<string> }>({ count: 0, rules: new Set() });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // No-op outside Electron (e.g. `npm run dev` in a plain browser).
    if (!window.electronAPI?.onFileProcessed) return;

    const unsubscribe = onFileProcessed((event) => {
      pending.current.count += 1;
      pending.current.rules.add(event.rule);

      window.dispatchEvent(new Event(DATA_CHANGED_EVENT));

      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        const { count, rules } = pending.current;
        pending.current = { count: 0, rules: new Set() };
        addToast({
          type: "info",
          text:
            count === 1
              ? `Organized 1 file (${[...rules][0]})`
              : `Organized ${count} files`,
        });
      }, NOTIFY_QUIET_MS);
    });

    return () => {
      unsubscribe();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [addToast]);

  return (
    <div className="grid h-screen w-screen grid-cols-[250px_1fr] grid-rows-[40px_1fr] overflow-hidden bg-canvas">
      <div className="col-span-2">
        <TitleBar />
      </div>
      <Sidebar />
      <main className="overflow-y-auto p-6">
        <div className="mx-auto max-w-6xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
