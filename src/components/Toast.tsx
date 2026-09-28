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

const TONE_CLASSES: Record<ToastType, string> = {
  success: "bg-success-soft text-success",
  error: "bg-danger-soft text-danger",
  info: "bg-accent-soft text-accent-fg",
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
      <div className="fixed bottom-4 right-4 z-50 flex max-w-sm flex-col gap-2">
        {toasts.map((toast) => {
          const Icon = ICONS[toast.type];
          return (
            <div
              key={toast.id}
              className={`flex items-start gap-2 rounded-lg px-4 py-3 text-sm shadow-pop ${TONE_CLASSES[toast.type]}`}
            >
              <Icon size={16} className="mt-0.5 shrink-0" />
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
