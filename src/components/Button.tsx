import { useState } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Loader2 } from "lucide-react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  loading?: boolean;
  children?: ReactNode;
}

const VARIANT_STYLES: Record<
  ButtonVariant,
  { bg: string; bgHover: string; text: string }
> = {
  primary: {
    bg: "var(--accent)",
    bgHover: "var(--accent-hover)",
    text: "white",
  },
  secondary: {
    bg: "var(--bg-tertiary)",
    bgHover: "var(--border-strong)",
    text: "var(--text-primary)",
  },
  ghost: {
    bg: "transparent",
    bgHover: "var(--bg-tertiary)",
    text: "var(--text-secondary)",
  },
  danger: {
    bg: "var(--danger-light)",
    bgHover: "var(--danger-light)",
    text: "var(--danger)",
  },
};

const SIZE_STYLES: Record<ButtonSize, string> = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
};

/**
 * Shared button styled from the app's CSS-variable design system, so call
 * sites stop repeating the onMouseEnter/onMouseLeave hover-swap pattern.
 */
export default function Button({
  variant = "secondary",
  size = "md",
  icon,
  loading,
  disabled,
  children,
  className = "",
  style,
  ...rest
}: ButtonProps) {
  const [hovered, setHovered] = useState(false);
  const colors = VARIANT_STYLES[variant];

  return (
    <button
      {...rest}
      disabled={disabled || loading}
      onMouseEnter={(e) => {
        setHovered(true);
        rest.onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        setHovered(false);
        rest.onMouseLeave?.(e);
      }}
      className={`flex items-center gap-2 rounded-lg font-medium cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${SIZE_STYLES[size]} ${className}`}
      style={{
        backgroundColor: hovered ? colors.bgHover : colors.bg,
        color: colors.text,
        ...style,
      }}
    >
      {loading ? <Loader2 size={16} className="animate-spin" /> : icon}
      {children}
    </button>
  );
}
