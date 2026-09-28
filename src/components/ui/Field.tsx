import type {
  InputHTMLAttributes,
  LabelHTMLAttributes,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

// Includes w-full so most callers get sensible full-width sizing for free.
// IMPORTANT: because of this, never pass a conflicting width utility (w-64,
// w-24, w-auto, ...) via this component's className prop to size it — Tailwind
// does not guarantee a later class in the source wins a same-specificity
// conflict (it orders by its own internal rules, not className order), so
// w-full has been observed to silently win regardless of what's passed here.
// To give an Input/Select/Textarea a specific width, wrap it in its own sized
// div instead (e.g. <div className="w-64"><Select .../></div>) and leave this
// component's own className alone.
const controlClass =
  "w-full h-9 px-3 rounded-md text-sm bg-inset text-fg border border-border outline-none transition-colors placeholder:text-fg-subtle focus:border-accent focus:ring-2 focus:ring-accent/30 disabled:opacity-50 disabled:cursor-not-allowed";

export function Label({
  className = "",
  ...rest
}: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={`mb-1.5 block text-xs font-medium text-fg-muted ${className}`}
      {...rest}
    />
  );
}

export function Input({
  className = "",
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${controlClass} ${className}`} {...rest} />;
}

export function Select({
  className = "",
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`${controlClass} cursor-pointer ${className}`} {...rest} />
  );
}

export function Textarea({
  className = "",
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`${controlClass} h-auto min-h-20 py-2 resize-y ${className}`}
      {...rest}
    />
  );
}
