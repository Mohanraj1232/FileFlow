import type { HTMLAttributes, ThHTMLAttributes, TdHTMLAttributes } from "react";

export function Table({
  className = "",
  ...rest
}: HTMLAttributes<HTMLTableElement>) {
  return <table className={`w-full text-left ${className}`} {...rest} />;
}

export function THead(props: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead {...props} />;
}

export function Th({
  className = "",
  ...rest
}: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={`border-b border-border px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-fg-subtle ${className}`}
      {...rest}
    />
  );
}

export function TRow({
  className = "",
  ...rest
}: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={`border-b border-border-muted last:border-b-0 transition-colors hover:bg-hover ${className}`}
      {...rest}
    />
  );
}

export function Td({
  className = "",
  ...rest
}: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={`px-4 py-3 text-sm text-fg ${className}`} {...rest} />;
}
