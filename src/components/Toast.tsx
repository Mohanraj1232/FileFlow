import { createContext, useCallback, useContext, useRef, useState } from "react";
import type { ReactNode } from "react";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";

type ToastType = "success" | "error" | "info";

interface ToastItem {
  id: number;
  type: ToastType;
  text: string;
}

interface ToastContextValue {
  addToast: (toast: { type: ToastType; text: string }) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const ICONS: Record<ToastType, typeof CheckCircle2> = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
};

const COLORS: Record<ToastType, { bg: string; text: string }> = {
  success: { bg: "var(--success-light)", text: "var(--success)" },
  error: { bg: "var(--danger-light)", text: "var(--danger)" },
  info: { bg: "var(--accent-light)", text: "var(--accent)" },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback(
    ({ type, text }: { type: ToastType; text: string }) => {
      const id = nextId.current++;
      setToasts((prev) => [...prev, { id, type, text }]);
      setTimeout(() => dismissToast(id), 5000);
    },
    [dismissToast],
  );

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
        {toasts.map((toast) => {
          const Icon = ICONS[toast.type];
          const colors = COLORS[toast.type];
          return (
            <div
              key={toast.id}
              className="flex items-start gap-2 px-4 py-3 rounded-lg text-sm"
              style={{
                backgroundColor: colors.bg,
                color: colors.text,
                boxShadow: "var(--shadow-md)",
              }}
            >
              <Icon size={16} className="shrink-0 mt-0.5" />
              <span className="flex-1">{toast.text}</span>
              <button
                onClick={() => dismissToast(toast.id)}
                className="shrink-0 cursor-pointer opacity-70 hover:opacity-100"
                aria-label="Dismiss"
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return ctx;
}
