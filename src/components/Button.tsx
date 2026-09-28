import { useState } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Loader2 } from "lucide-react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
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
    bgHover: "var(--bg-tertiary)",
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

/**
 * Shared button styled from the app's CSS-variable design system, so call
 * sites stop repeating the onMouseEnter/onMouseLeave hover-swap pattern.
 */
export default function Button({
  variant = "secondary",
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
      className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
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
