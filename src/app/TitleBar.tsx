import { useLocation } from "react-router-dom";
import { FileStack } from "lucide-react";
import { pageLabelForPath } from "./nav";

export default function TitleBar() {
  const location = useLocation();
  const pageLabel = pageLabelForPath(location.pathname);
  const isMac = window.electronAPI?.platform === "darwin";

  return (
    <header
      className={`drag flex h-10 shrink-0 items-center gap-3 border-b border-border bg-titlebar px-3 ${
        isMac ? "pl-20" : "pr-[138px]"
      }`}
    >
      <div className="flex items-center gap-2">
        <div
          className="flex h-6 w-6 items-center justify-center rounded-md"
          style={{
            background: "linear-gradient(135deg, var(--accent), var(--accent-hover))",
          }}
        >
          <FileStack size={14} className="text-white" />
        </div>
        <span className="text-xs font-semibold tracking-tight text-fg">
          FileFlow
        </span>
      </div>
      <span className="text-xs text-border select-none">/</span>
      <span className="text-xs font-medium text-fg-muted">{pageLabel}</span>
    </header>
  );
}
