import type { LucideIcon } from "lucide-react";
import Button from "./ui/Button";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}

export default function EmptyState({
  icon: Icon,
  title,
  description,
  actionLabel,
  onAction,
}: EmptyStateProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-4 py-16 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-hover">
        <Icon size={26} className="text-fg-subtle" />
      </div>
      <h3 className="mb-1 text-base font-semibold text-fg">{title}</h3>
      <p className="mb-6 max-w-sm text-sm text-fg-muted">{description}</p>
      {actionLabel && onAction && (
        <Button variant="primary" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
