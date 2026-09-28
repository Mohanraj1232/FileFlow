import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Loader2 } from "lucide-react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type ButtonSize = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
  /** Renders as a square icon button. Always pass aria-label alongside this. */
  iconOnly?: boolean;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-accent text-white hover:bg-accent-hover",
  secondary: "bg-hover text-fg hover:bg-border-muted",
  ghost: "bg-transparent text-fg-muted hover:bg-hover hover:text-fg",
  danger: "bg-danger-soft text-danger hover:bg-danger hover:text-white",
  outline: "bg-transparent text-fg border border-border hover:bg-hover",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs gap-1.5",
  md: "h-9 px-4 text-sm gap-2",
};

const ICON_ONLY_SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-8 w-8",
  md: "h-9 w-9",
};

const ICON_PX: Record<ButtonSize, number> = { sm: 14, md: 16 };

export default function Button({
  variant = "secondary",
  size = "md",
  loading,
  icon,
  iconOnly,
  disabled,
  children,
  className = "",
  ...rest
}: ButtonProps) {
  return (
    <button
      disabled={disabled || loading}
      className={`inline-flex shrink-0 items-center justify-center rounded-md font-medium transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas ${VARIANT_CLASSES[variant]} ${iconOnly ? ICON_ONLY_SIZE_CLASSES[size] : SIZE_CLASSES[size]} ${className}`}
      {...rest}
    >
      {loading ? (
        <Loader2 size={ICON_PX[size]} className="animate-spin" />
      ) : (
        icon
      )}
      {!iconOnly && children}
    </button>
  );
}
