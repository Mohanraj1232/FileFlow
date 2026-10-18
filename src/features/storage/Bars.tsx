import type { ReactNode } from "react";
import { percent } from "./logic";

interface BarRowProps {
  label: ReactNode;
  /** Small text under the label (counts, extensions). */
  detail?: ReactNode;
  /** Text shown at the right, e.g. "1.2 GB". */
  valueLabel: string;
  value: number;
  total: number;
  /** Tailwind background class for the filled part. */
  color?: string;
  onClick?: () => void;
  title?: string;
}

/**
 * One row of a horizontal bar chart. The numbers are always written out, so the bar is a visual aid
 * only and nothing depends on colour or on seeing the bar.
 */
export function BarRow({ label, detail, valueLabel, value, total, color = "bg-accent", onClick, title }: BarRowProps) {
  const pct = percent(value, total);
  const body = (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-sm text-fg">{label}</span>
        <span className="shrink-0 text-sm tabular-nums text-fg-muted">
          {valueLabel}
          <span className="ml-2 inline-block w-9 text-right text-xs text-fg-subtle">{pct}%</span>
        </span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-inset" aria-hidden="true">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.max(pct, value > 0 ? 1 : 0)}%` }} />
      </div>
      {detail && <div className="mt-1 truncate text-xs text-fg-subtle">{detail}</div>}
    </>
  );

  if (!onClick) return <div className="px-1 py-2">{body}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="block w-full cursor-pointer rounded-md px-1 py-2 text-left transition-colors hover:bg-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {body}
    </button>
  );
}
