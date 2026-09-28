import type {
  InputHTMLAttributes,
  LabelHTMLAttributes,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

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
