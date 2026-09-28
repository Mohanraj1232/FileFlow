import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import Button from "./ui/Button";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

export default function Modal({ open, onClose, title, children }: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (open) document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative mx-4 w-full max-w-lg rounded-xl border border-border bg-surface p-6 shadow-pop">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-fg">{title}</h2>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Close"
            icon={<X size={16} />}
            onClick={onClose}
          />
        </div>
        {children}
      </div>
    </div>
  );
}
