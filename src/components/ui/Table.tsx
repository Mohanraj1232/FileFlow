import type { HTMLAttributes, ThHTMLAttributes, TdHTMLAttributes } from "react";

export function Table({
  className = "",
  ...rest
}: HTMLAttributes<HTMLTableElement>) {
  // table-fixed is required, not cosmetic: with the browser default
  // (table-layout: auto), column widths are computed from each cell's
  // unwrapped content, so truncate/min-w-0 inside a cell never engages —
  // a single long value can force the whole table wider than its card,
  // silently pushing later columns out of view under overflow-hidden.
  // Fixed layout makes column widths authoritative (driven by the header
  // row's widths, e.g. a Th's w-10/w-28), which is what actually lets
  // narrow icon/action columns stay narrow and text columns truncate.
  return <table className={`w-full table-fixed text-left ${className}`} {...rest} />;
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
