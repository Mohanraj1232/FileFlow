import type { ReactNode } from "react";

interface StatCardProps {
  icon: ReactNode;
  label: string;
  value: number;
  tone: "accent" | "success" | "warning" | "danger";
}

const TONE_CLASSES: Record<StatCardProps["tone"], string> = {
  accent: "bg-accent-soft text-accent-fg",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
};

export default function StatCard({ icon, label, value, tone }: StatCardProps) {
  return (
    <div className="flex items-center gap-4 rounded-xl border border-border bg-surface p-5 shadow-card">
      <div
        className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full ${TONE_CLASSES[tone]}`}
      >
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-3xl font-bold leading-tight text-fg">{value}</p>
        <p className="text-xs text-fg-muted">{label}</p>
      </div>
    </div>
  );
}
