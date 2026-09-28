import Badge, { type BadgeTone } from "./ui/Badge";

interface StatusBadgeProps {
  status: string;
  size?: "sm" | "md";
}

const TONE_MAP: Record<string, BadgeTone> = {
  done: "success",
  success: "success",
  completed: "success",
  failed: "danger",
  error: "danger",
  undone: "neutral",
  partially_undone: "warning",
  skipped: "neutral",
  pending: "accent",
  running: "accent",
  planned: "accent",
  partial: "warning",
  warning: "warning",
};

export default function StatusBadge({ status, size = "md" }: StatusBadgeProps) {
  return (
    <Badge tone={TONE_MAP[status] ?? "neutral"} size={size}>
      {status.replace(/_/g, " ")}
    </Badge>
  );
}
