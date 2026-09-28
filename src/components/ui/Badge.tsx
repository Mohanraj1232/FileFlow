import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";

interface BadgeProps {
  tone?: BadgeTone;
  size?: "sm" | "md";
  children: ReactNode;
  className?: string;
}

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: "bg-hover text-fg-muted",
  accent: "bg-accent-soft text-accent-fg",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
};

export default function Badge({
  tone = "neutral",
  size = "md",
  children,
  className = "",
}: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full font-medium capitalize whitespace-nowrap ${
        size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs"
      } ${TONE_CLASSES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
