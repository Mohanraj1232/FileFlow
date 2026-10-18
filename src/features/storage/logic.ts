import type { FileKind, StorageFileFilter } from "../../lib/types";

const MONTH_MS = 30.4375 * 24 * 3600 * 1000;

/** Share of `total` that `part` is, as a whole percentage clamped to 0–100. Safe when the total is 0. */
export function percent(part: number, total: number): number {
  if (!total || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((part / total) * 100)));
}

/** ISO date for "N months ago". */
export function monthsAgoIso(months: number, now: number = Date.now()): string {
  return new Date(now - months * MONTH_MS).toISOString();
}

export const KIND_LABELS: Record<FileKind, string> = {
  document: "Documents",
  image: "Images",
  video: "Videos",
  audio: "Audio",
  archive: "Archives",
  code: "Code",
  installer: "Installers",
  other: "Other",
};

/** Tailwind fill for a kind's bar. Colour is a hint only: every bar also carries its text label. */
export const KIND_COLORS: Record<FileKind, string> = {
  document: "bg-accent",
  image: "bg-success",
  video: "bg-danger",
  audio: "bg-warning",
  archive: "bg-fg-muted",
  code: "bg-accent",
  installer: "bg-danger",
  other: "bg-fg-subtle",
};

export type Tab = "overview" | "files" | "cleanup";

/** What the Files tab's controls hold. Empty string / 0 mean "no filter". */
export interface FilterState {
  folder: string | null;
  kind: FileKind | "";
  ext: string;
  minSize: number;
  olderThanMonths: number;
  name: string;
}

export const EMPTY_FILTER: FilterState = {
  folder: null,
  kind: "",
  ext: "",
  minSize: 0,
  olderThanMonths: 0,
  name: "",
};

export function hasActiveFilter(f: FilterState): boolean {
  return !!(f.folder || f.kind || f.ext.trim() || f.minSize || f.olderThanMonths || f.name.trim());
}

/** Translate the controls into the filter the backend understands. Blank controls add nothing. */
export function buildFilter(f: FilterState, now: number = Date.now()): StorageFileFilter {
  const out: StorageFileFilter = {};
  if (f.folder) out.folder = f.folder;
  if (f.kind) out.kinds = [f.kind];
  if (f.ext.trim()) out.ext = f.ext.trim().replace(/^\./, "");
  if (f.minSize > 0) out.min_size = f.minSize;
  if (f.olderThanMonths > 0) out.modified_before = monthsAgoIso(f.olderThanMonths, now);
  if (f.name.trim()) out.name_contains = f.name.trim();
  return out;
}

export interface Crumb {
  label: string;
  /** null = the top level (the chosen folders). */
  path: string | null;
}

const SEPARATOR = /[\\/]/;

/** Breadcrumb trail from the top level down to `folder`, relative to the chosen root that contains it. */
export function crumbs(folder: string | null, roots: string[]): Crumb[] {
  const trail: Crumb[] = [{ label: "All folders", path: null }];
  if (!folder) return trail;

  const key = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase().replace(/\\/g, "/");
  const root = [...roots]
    .sort((a, b) => b.length - a.length)
    .find((r) => key(folder) === key(r) || key(folder).startsWith(key(r) + "/"));
  if (!root) return [...trail, { label: folder, path: folder }];

  trail.push({ label: root, path: root });
  const rest = folder.slice(root.replace(/[\\/]+$/, "").length).split(SEPARATOR).filter(Boolean);
  const sep = folder.includes("\\") ? "\\" : "/";
  let current = root.replace(/[\\/]+$/, "");
  for (const part of rest) {
    current = current + sep + part;
    trail.push({ label: part, path: current });
  }
  return trail;
}

/** Short, readable name for a scan's folders: "Downloads" or "Downloads +2 more". */
export function rootsLabel(roots: string[]): string {
  const base = (p: string) => p.replace(/[\\/]+$/, "").split(SEPARATOR).pop() || p;
  if (roots.length === 0) return "";
  return roots.length === 1 ? base(roots[0]) : `${base(roots[0])} +${roots.length - 1} more`;
}

export interface SelectionTotals {
  files: number;
  bytes: number;
}

export function selectionTotals(selected: Map<string, number>): SelectionTotals {
  let bytes = 0;
  for (const b of selected.values()) bytes += b;
  return { files: selected.size, bytes };
}

export const MIN_SIZE_CHOICES = [
  { value: 0, label: "Any size" },
  { value: 1024 * 1024, label: "1 MB or larger" },
  { value: 10 * 1024 * 1024, label: "10 MB or larger" },
  { value: 100 * 1024 * 1024, label: "100 MB or larger" },
  { value: 1024 * 1024 * 1024, label: "1 GB or larger" },
];

export const AGE_CHOICES = [
  { value: 0, label: "Any date" },
  { value: 1, label: "Not changed in 1 month" },
  { value: 3, label: "Not changed in 3 months" },
  { value: 6, label: "Not changed in 6 months" },
  { value: 12, label: "Not changed in 1 year" },
  { value: 24, label: "Not changed in 2 years" },
];

/** Choices for the cleanup tab's "old" threshold (must match what the backend accepts). */
export const OLD_MONTH_CHOICES = [1, 3, 6, 12, 24];
