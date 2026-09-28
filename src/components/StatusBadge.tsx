interface StatusBadgeProps {
  status: string;
  size?: "sm" | "md";
}

const colorMap: Record<string, { bg: string; text: string }> = {
  done: { bg: "var(--success-light)", text: "var(--success)" },
  success: { bg: "var(--success-light)", text: "var(--success)" },
  completed: { bg: "var(--success-light)", text: "var(--success)" },
  failed: { bg: "var(--danger-light)", text: "var(--danger)" },
  error: { bg: "var(--danger-light)", text: "var(--danger)" },
  undone: { bg: "var(--bg-tertiary)", text: "var(--text-muted)" },
  partially_undone: { bg: "var(--warning-light)", text: "var(--warning)" },
  skipped: { bg: "var(--bg-tertiary)", text: "var(--text-muted)" },
  pending: { bg: "var(--accent-light)", text: "var(--accent)" },
  running: { bg: "var(--accent-light)", text: "var(--accent)" },
  planned: { bg: "var(--accent-light)", text: "var(--accent)" },
  partial: { bg: "var(--warning-light)", text: "var(--warning)" },
  warning: { bg: "var(--warning-light)", text: "var(--warning)" },
};

export default function StatusBadge({ status, size = "md" }: StatusBadgeProps) {
  const colors = colorMap[status] ?? {
    bg: "var(--bg-tertiary)",
    text: "var(--text-muted)",
  };
  const sizeClass = size === "sm" ? "text-xs px-1.5 py-0.5" : "text-xs px-2 py-1";

  return (
    <span
      className={`inline-flex items-center rounded-full font-medium capitalize ${sizeClass}`}
      style={{ backgroundColor: colors.bg, color: colors.text }}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}
