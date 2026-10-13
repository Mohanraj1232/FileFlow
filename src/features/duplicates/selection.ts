import type { DuplicateDecision, DuplicateFile, DuplicateGroup } from "../../lib/types";

/**
 * Selection model for the duplicate finder.
 *
 * Nothing is selected by default. A file is "marked" when the user wants it
 * removed; every unmarked file in its group is kept. A group must always keep
 * at least one file — the server enforces this too, these helpers just stop
 * the UI from offering an impossible choice.
 */

export type AutoKeep = "oldest" | "newest" | "shortest_path";

export const AUTO_KEEP_LABELS: Record<AutoKeep, string> = {
  oldest: "Keep the oldest copy in every group",
  newest: "Keep the newest copy in every group",
  shortest_path: "Keep the copy with the shortest path",
};

/** The file to keep in a group for an automatic rule. Ties break alphabetically so results are stable. */
export function pickKeeper(group: DuplicateGroup, rule: AutoKeep): DuplicateFile {
  const files = [...group.files];
  const byPath = (a: DuplicateFile, b: DuplicateFile) => a.path.localeCompare(b.path);
  switch (rule) {
    case "oldest":
      files.sort((a, b) => a.modified_at.localeCompare(b.modified_at) || byPath(a, b));
      break;
    case "newest":
      files.sort((a, b) => b.modified_at.localeCompare(a.modified_at) || byPath(a, b));
      break;
    case "shortest_path":
      files.sort((a, b) => a.path.length - b.path.length || byPath(a, b));
      break;
  }
  return files[0];
}

/** Paths to mark so only `keepPath` survives. Hard links of the kept file are left alone: removing them frees nothing. */
export function marksToKeepOnly(group: DuplicateGroup, keepPath: string): string[] {
  const keeper = group.files.find((f) => f.path === keepPath);
  if (!keeper) return [];
  return group.files.filter((f) => f.copy_id !== keeper.copy_id).map((f) => f.path);
}

/** Apply an automatic rule to every group, returning the full set of marked paths. */
export function autoSelect(groups: DuplicateGroup[], rule: AutoKeep): Set<string> {
  const marks = new Set<string>();
  for (const group of groups) {
    for (const p of marksToKeepOnly(group, pickKeeper(group, rule).path)) marks.add(p);
  }
  return marks;
}

/** Number of files in the group that are NOT marked (i.e. will be kept). */
export function keptCount(group: DuplicateGroup, marks: Set<string>): number {
  return group.files.filter((f) => !marks.has(f.path)).length;
}

/** Marking `path` is only allowed if at least one other file in its group stays. */
export function canMark(group: DuplicateGroup, marks: Set<string>, path: string): boolean {
  if (marks.has(path)) return true; // un-marking is always fine
  return keptCount(group, marks) > 1;
}

export interface SelectionSummary {
  files: number;
  groups: number;
  /** Space actually freed: each distinct stored copy once; hard links of a kept file free nothing. */
  bytes: number;
}

export function summarize(groups: DuplicateGroup[], marks: Set<string>): SelectionSummary {
  let files = 0;
  let touched = 0;
  let bytes = 0;

  for (const group of groups) {
    const marked = group.files.filter((f) => marks.has(f.path));
    if (marked.length === 0) continue;
    touched++;
    files += marked.length;

    const keptCopies = new Set(group.files.filter((f) => !marks.has(f.path)).map((f) => f.copy_id));
    const freed = new Set(marked.map((f) => f.copy_id).filter((id) => !keptCopies.has(id)));
    bytes += group.size * freed.size;
  }
  return { files, groups: touched, bytes };
}

/** The request sent to the server: for each affected group, the files to keep. */
export function buildDecisions(groups: DuplicateGroup[], marks: Set<string>): DuplicateDecision[] {
  const out: DuplicateDecision[] = [];
  for (const group of groups) {
    if (!group.files.some((f) => marks.has(f.path))) continue;
    out.push({
      hash: group.hash,
      keep: group.files.filter((f) => !marks.has(f.path)).map((f) => f.path),
    });
  }
  return out;
}

/** Drop marks for files that are no longer in any loaded group (e.g. after a removal). */
export function pruneMarks(groups: DuplicateGroup[], marks: Set<string>): Set<string> {
  const present = new Set(groups.flatMap((g) => g.files.map((f) => f.path)));
  return new Set([...marks].filter((p) => present.has(p)));
}
