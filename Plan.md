# FileFlow — Project Plan & Implementation Guide

> **FileFlow — Your files. Automatically organized.**
> A local-first desktop app that watches folders (Downloads, Desktop, …) and organizes files using user-defined rules, with preview, history, and undo.

---

## Table of Contents

1. [Evaluation of the Idea](#1-evaluation-of-the-idea)
2. [Corrections to the Original Proposal](#2-corrections-to-the-original-proposal)
3. [Scope & Goals](#3-scope--goals)
4. [Tech Stack Decision](#4-tech-stack-decision)
5. [Architecture](#5-architecture)
6. [Data Model](#6-data-model)
7. [Rule Engine Design](#7-rule-engine-design)
8. [File-Operation Safety Rules (Non-Negotiable)](#8-file-operation-safety-rules-non-negotiable)
9. [Phase-wise Implementation](#9-phase-wise-implementation)
10. [Testing Strategy](#10-testing-strategy)
11. [Risks & Mitigations](#11-risks--mitigations)
12. [Repository Structure](#12-repository-structure)
13. [Timeline Summary](#13-timeline-summary)
14. [Stretch Goals](#14-stretch-goals)
15. [How to Pitch It (Resume / Viva / Demo)](#15-how-to-pitch-it-resume--viva--demo)

---

## 1. Evaluation of the Idea

### Verdict: **Good project — build it, but build it for engineering depth, not novelty.**

| Criterion | Score (/10) | Notes |
|---|---|---|
| Real-world usefulness | 8 | Messy Downloads folders are a universal problem. You will use it yourself. |
| Novelty | 4 | The space is crowded (see below). The idea itself won't impress; the execution will. |
| Technical depth | 8 | File watching, a rule engine, transactional file ops, undo journal, hashing, background services, packaging. Plenty to talk about. |
| Scope control | 7 | Naturally incremental — a working MVP in weeks, polish for months. |
| Demo-ability | 9 | Dropping a file into Downloads and watching it vanish into the right folder is a great live demo. |
| Risk | Medium | The main risk is **data loss**. A file tool that loses a user's file is worse than no tool. Safety must be designed in from day one. |

### Existing alternatives (know these before anyone asks "how is this different?")

| Tool | Platform | Notes |
|---|---|---|
| **Hazel** | macOS, paid | The gold standard for rule-based file automation. |
| **DropIt** | Windows, free | Rule-based, older UI, portable. |
| **File Juggler** | Windows, paid | Watch folders + rules. |
| **organize** (`organize-tool`) | Cross-platform, Python CLI | YAML rules, no GUI. |
| **Belvedere** | Windows, open source | Old, largely unmaintained. |

**Your realistic differentiators:**
1. **Free, open-source, cross-platform, modern UI** — Hazel-style power for Windows/Linux users.
2. **Safety-first UX** — dry run, preview, a full operation journal, and reliable multi-level undo. Most competitors are weak here.
3. **Visual rule builder + templates** — no YAML or config files.
4. **Local-only, zero telemetry** — a clear privacy position.

### Strengths of the proposal
- Preview / Dry Run and Undo are the right priorities — they are what separate a product from a script.
- The phased roadmap is sensible in spirit.
- SQLite for local state is the correct choice.
- Templates lower the barrier for new users.

### Weaknesses of the proposal
- It ignores the hard parts: half-downloaded files, locked files, cross-drive moves, name collisions, event storms, and undo validity.
- Undo is placed in Phase 2, but the **operation journal** that makes undo possible must exist from the first file you move.
- Some features are low value for the effort (Compress, Statistics in early phases).
- A few features are logically inconsistent (see Section 2).

---

## 2. Corrections to the Original Proposal

| Original | Problem | Fix |
|---|---|---|
| **"No rule → Ask User"** | A popup for every unmatched download is extremely annoying. | Default: **leave the file alone**. Show unmatched files in an "Unsorted" inbox view the user can check whenever they like. Make popups opt-in. |
| **"Created > 30 days ago"** as a watch condition | A newly detected file is never 30 days old. Age-based rules can't be event-driven. | Support **two trigger types**: *on-arrival* (watcher) and *scheduled scan* (e.g., daily sweep). Age rules only run on scans. |
| **Rename example**: `resume_final_final2.pdf` + `{date}_{filename}` → `2026-09-22_resume.pdf` | The pattern alone would produce `2026-09-22_resume_final_final2.pdf`. | Add explicit **transforms**: `{filename:clean}` (strip `(1)`, `_final`, `copy`), `{filename:lower}`, `{filename:slug}`. Show a live preview of the result in the rule builder. |
| **Delete action** | Permanent deletion by an automated tool is dangerous. | Delete = **move to OS Recycle Bin / Trash** only. Never hard-delete. |
| **Preview** and **Dry Run** as separate features | They are the same engine. | One **Plan → Review → Apply** pipeline. Dry Run = produce a plan without applying it. |
| **Undo in Phase 2** | Files moved in Phase 1 without a journal can never be undone. | Build the **operation journal in Phase 1**. Undo UI can come later. |
| **SHA-256 on every file** | Hashing large videos on every arrival is slow. | Only hash when a **size match** already exists; prefer **BLAKE3** (much faster). |
| **Compress action** | Low value, adds complexity. | Move to stretch goals. |
| **Statistics dashboard** in Phase 3 | Nice-to-have, not core. | Move to the polish phase. |

---

## 3. Scope & Goals

### Product goals
- **G1 — Zero-effort organization:** once rules are set, new files are sorted without user action.
- **G2 — Never lose a file:** every operation is journaled, reversible, and conflict-safe.
- **G3 — No config files:** everything is configurable through the GUI.
- **G4 — Local-only:** no network calls except an optional update check.

### Non-goals (explicitly out of scope for v1)
- Cloud sync / remote folders.
- AI-based classification (possible stretch goal; keep "no AI" as the default).
- Content-based rules (e.g., reading PDF text) — stretch goal.
- Mobile apps.

### Definition of "v1.0 done"
A user can install FileFlow on Windows, pick Downloads, apply the "Student" template, and for a week have files organized automatically, with every action visible in history and undoable — with **zero lost files**.

---

## 4. Tech Stack Decision

### Recommended: **Tauri 2 + React + TypeScript + Rust core**

| Layer | Choice | Why |
|---|---|---|
| Shell | **Tauri 2** | ~5–15 MB installers (vs ~100 MB+ for Electron), low RAM, built-in tray/updater/autostart plugins. |
| UI | **React + TypeScript + Vite** | Familiar, huge ecosystem. |
| UI styling | Tailwind CSS + shadcn/ui (or Radix) | Fast, consistent, accessible components. |
| Core logic | **Rust** | Safe, fast file operations; a strong resume signal. |
| File watching | `notify` + `notify-debouncer-full` crates | Cross-platform watcher with debouncing. |
| Database | SQLite via `rusqlite` (or `sqlx`) | Local, single-file, transactional. |
| Hashing | `blake3` crate | Very fast content hashing. |
| Recycle bin | `trash` crate | Cross-platform "move to trash". |
| Glob / patterns | `globset`, `regex` | Filename matching. |
| Tauri plugins | `tray`, `autostart`, `notification`, `updater`, `dialog`, `fs` | Background app features. |

### Alternative: **Electron + React + Node.js**
Choose this if learning Rust in parallel feels like too much. Equivalents: `chokidar` (watching), `better-sqlite3`, `trash` (npm), `electron-builder`, `electron-updater`. The architecture and phases below apply unchanged — only the core language changes.

### Decision rule
- Comfortable spending ~2 weeks learning Rust basics → **Tauri** (better product, better resume).
- Deadline-driven or JS-strong team → **Electron**.

> **Tip:** keep the rule engine and file-op planner as **pure functions** with no I/O. That makes them easy to test, and easy to port if you ever switch stacks.

---

## 5. Architecture

```text
┌────────────────────────────────────────────────────────────┐
│                     React UI (WebView)                      │
│  Dashboard · Rules · Rule Builder · Preview · History ·    │
│  Unsorted Inbox · Settings                                  │
└──────────────────────────┬─────────────────────────────────┘
                           │  Tauri commands (invoke) + events
┌──────────────────────────┴─────────────────────────────────┐
│                       Rust Core                             │
│                                                             │
│  ┌──────────────┐   ┌──────────────┐   ┌────────────────┐  │
│  │ Watcher      │──▶│ Stability    │──▶│ Job Queue      │  │
│  │ (notify)     │   │ Checker      │   │ (serialized)   │  │
│  └──────────────┘   └──────────────┘   └───────┬────────┘  │
│  ┌──────────────┐                              │           │
│  │ Scheduler    │─────────────────────────────▶│           │
│  │ (scans)      │                              ▼           │
│  └──────────────┘                     ┌────────────────┐   │
│                                       │ Rule Engine    │   │
│                                       │ (pure)         │   │
│                                       └───────┬────────┘   │
│                                               ▼            │
│                                       ┌────────────────┐   │
│                                       │ Planner (pure) │   │
│                                       │ → Plan         │   │
│                                       └───────┬────────┘   │
│                             auto-apply or     │ preview    │
│                             user approval     ▼            │
│                                       ┌────────────────┐   │
│                                       │ Executor       │   │
│                                       │ (journaled)    │   │
│                                       └───────┬────────┘   │
│                                               ▼            │
│  ┌──────────────┐   ┌──────────────┐   ┌────────────────┐  │
│  │ Undo Service │◀─▶│ Journal      │◀─▶│ SQLite         │  │
│  └──────────────┘   └──────────────┘   └────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

### Pipeline: Detect → Stabilize → Match → Plan → (Review) → Execute → Journal

1. **Detect** — watcher emits a create/rename event, or a scheduled scan enumerates files.
2. **Stabilize** — wait until the file is complete (see Section 8).
3. **Match** — rule engine returns the first matching enabled rule (by priority).
4. **Plan** — planner computes concrete operations (final paths, collision resolution).
5. **Review** — auto-apply for watcher events (configurable), preview for manual/bulk runs.
6. **Execute** — executor performs operations one by one, journaling each step.
7. **Journal** — every step recorded; used for history and undo.

---

## 6. Data Model

```sql
-- Folders being watched
CREATE TABLE watched_folders (
  id            INTEGER PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,
  recursive     INTEGER NOT NULL DEFAULT 0,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

-- Rules
CREATE TABLE rules (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  priority      INTEGER NOT NULL,          -- lower = evaluated first
  trigger       TEXT NOT NULL,             -- 'arrival' | 'scan' | 'both'
  condition     TEXT NOT NULL,             -- JSON condition tree (see §7)
  stop_after    INTEGER NOT NULL DEFAULT 1,-- stop evaluating further rules on match
  scope_folder  INTEGER REFERENCES watched_folders(id), -- NULL = all folders
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Ordered actions per rule
CREATE TABLE rule_actions (
  id            INTEGER PRIMARY KEY,
  rule_id       INTEGER NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  action_type   TEXT NOT NULL,             -- move|copy|rename|trash|ignore
  params        TEXT NOT NULL              -- JSON: destination, pattern, on_conflict…
);

-- One operation = one batch (a single file on arrival, or a bulk apply)
CREATE TABLE operations (
  id            INTEGER PRIMARY KEY,
  source        TEXT NOT NULL,             -- 'watcher' | 'scan' | 'manual'
  status        TEXT NOT NULL,             -- planned|running|done|partial|failed|undone
  summary       TEXT,
  started_at    TEXT NOT NULL,
  finished_at   TEXT
);

-- Individual file steps (the journal)
CREATE TABLE operation_steps (
  id            INTEGER PRIMARY KEY,
  operation_id  INTEGER NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  rule_id       INTEGER REFERENCES rules(id) ON DELETE SET NULL,
  action_type   TEXT NOT NULL,
  src_path      TEXT NOT NULL,
  dst_path      TEXT,
  file_size     INTEGER,
  file_mtime    TEXT,
  content_hash  TEXT,                      -- only when computed
  status        TEXT NOT NULL,             -- pending|done|failed|undone|skipped
  error         TEXT,
  executed_at   TEXT
);

-- Hash cache for duplicate detection
CREATE TABLE file_index (
  path          TEXT PRIMARY KEY,
  size          INTEGER NOT NULL,
  mtime         TEXT NOT NULL,
  hash          TEXT                       -- lazily computed
);
CREATE INDEX idx_file_index_size ON file_index(size);

CREATE TABLE settings (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL
);

CREATE TABLE schema_version (version INTEGER NOT NULL);
```

**Design notes**
- Conditions are stored as a **JSON tree**, not a flat table — this naturally supports nested AND/OR groups without complex joins.
- The journal records `file_size` and `file_mtime` after each step so undo can detect whether the file was changed since.
- Use SQLite **WAL mode** and wrap each step's journal update in a transaction.
- Keep a `schema_version` table and write migrations from the start.

---

## 7. Rule Engine Design

### Condition tree (JSON)

```json
{
  "all": [
    { "field": "extension", "op": "in", "value": ["pdf"] },
    { "any": [
      { "field": "name", "op": "contains", "value": "assignment", "case": false },
      { "field": "name", "op": "matches", "value": "^CS\\d{4}" }
    ]}
  ]
}
```

### Supported fields & operators

| Field | Operators | Trigger |
|---|---|---|
| `extension` | `is`, `in`, `not_in` | arrival, scan |
| `name` (without extension) | `contains`, `starts_with`, `ends_with`, `equals`, `matches` (regex), `glob` | arrival, scan |
| `size` | `gt`, `lt`, `between` (with KB/MB/GB units) | arrival, scan |
| `kind` (category: document, image, video, audio, archive, code, installer) | `is`, `in` | arrival, scan |
| `source_folder` | `is` | arrival, scan |
| `created_age` / `modified_age` | `gt`, `lt` (days) | **scan only** |
| `is_duplicate` | `is` | arrival, scan |

Maintain an **extension → kind** map (e.g., `jpg, png, webp, heic → image`) so templates can use `kind` instead of listing every extension.

### Actions

| Action | Params | Notes |
|---|---|---|
| `move` | `destination`, `on_conflict` | Destination supports variables: `Documents/{kind}/{year}` |
| `copy` | `destination`, `on_conflict` | |
| `rename` | `pattern` | `{name}`, `{name:clean}`, `{name:lower}`, `{ext}`, `{date}`, `{date:YYYY-MM}`, `{counter}`, `{kind}` |
| `trash` | — | OS recycle bin only |
| `ignore` | — | Explicitly skip; also stops further rules |

`on_conflict`: `auto_rename` (default: `report (2).pdf`), `skip`, `replace_if_duplicate` (only when hashes match), `ask`.

### Evaluation semantics
- Rules are evaluated in **priority order**; the **first match wins** by default (`stop_after = true`).
- A rule's actions execute **in sequence** (e.g., rename then move).
- The engine is a **pure function**: `evaluate(file_meta, rules) -> Option<MatchedRule>` and `plan(file_meta, rule, fs_snapshot) -> Vec<Step>`. No disk access inside — the caller supplies metadata. This makes it fully unit-testable.

### Loop prevention
If a destination is inside a watched folder, a moved file could be re-matched forever. Prevent this by:
1. Refusing to save rules whose destination is inside the same watched folder (non-recursive watch), and
2. Keeping a short-lived "recently written by FileFlow" set; watcher events for those paths are ignored.

---

## 8. File-Operation Safety Rules (Non-Negotiable)

These apply from **Phase 1** onward.

1. **Never touch incomplete files.**
   - Ignore temp extensions: `.crdownload`, `.part`, `.partial`, `.tmp`, `.download`, `.opdownload`, `~$*` (Office lock files), `.DS_Store`, `desktop.ini`, `Thumbs.db`.
   - **Stability check:** file size and mtime unchanged across 2 checks ~2 s apart, and the file can be opened (not locked). Retry with backoff up to a limit; otherwise leave it for the next scan.
2. **Never overwrite.** Default conflict policy is auto-rename. Replace only when content hashes are identical.
3. **Never hard-delete.** Trash only.
4. **Cross-volume moves** (e.g., `C:` → `D:`): `rename()` fails across drives. Fall back to **copy → verify (size + hash) → trash/delete source**. Never delete the source before the copy is verified.
5. **Journal before and after.** Write the step as `pending` before touching the disk, mark `done` after. On startup, scan for `pending` steps left by a crash and reconcile them.
6. **Undo only when safe.** Before reverting a step, confirm the file still exists at `dst_path` with the recorded size/mtime, and that `src_path` is free. Otherwise mark that step "cannot undo" and explain why — never guess.
7. **Serialize operations.** One executor queue; no two jobs touch the same path concurrently.
8. **Protected paths.** Refuse to watch or target system folders (`C:\Windows`, `Program Files`, `/System`, `/usr`, the user's home root itself, etc.).
9. **Beware sync folders.** OneDrive/Dropbox/Google Drive folders can contain placeholder (cloud-only) files. Skip files that are not locally available and warn users when watching a synced folder.
10. **Path limits.** Handle Windows long paths (>260 chars) and illegal filename characters produced by rename patterns.

---

## 9. Phase-wise Implementation

Estimated effort assumes **~10–12 hours/week** for one developer. Adjust for team size.

---

### Phase 0 — Setup & Technical Spikes (Week 1)

**Goal:** a running skeleton and confidence in the risky parts.

**Tasks**
- [ ] Create repo, README, license (MIT or Apache-2.0), `.gitignore`, issue templates.
- [ ] Scaffold Tauri 2 + React + TS + Vite; confirm `invoke` round-trip.
- [ ] Set up lint/format: `eslint`, `prettier`, `rustfmt`, `clippy`.
- [ ] CI (GitHub Actions): build + test on Windows, macOS, Linux.
- [ ] **Spike 1:** `notify` watcher on Downloads — log events while downloading a large file in Chrome/Edge/Firefox. Observe the `.crdownload` → final rename sequence.
- [ ] **Spike 2:** cross-drive move on Windows (USB/second partition).
- [ ] **Spike 3:** `trash` crate on each OS.
- [ ] Write an ADR (architecture decision record) for Tauri vs Electron.

**Deliverable:** an app window that prints file events from a chosen folder.
**Exit criteria:** you can explain exactly what events a browser download produces.

---

### Phase 1 — Core Engine + Safe Operations (Weeks 2–4) — *MVP foundation*

**Goal:** a correct, tested, journaled core — mostly headless.

**Tasks**
- [ ] SQLite setup: migrations, WAL mode, schema from Section 6.
- [ ] `FileMeta` extraction (name, ext, size, times, kind).
- [ ] Rule engine (pure) with `extension` and `kind` conditions only.
- [ ] Planner (pure): destination resolution, folder creation steps, conflict auto-rename.
- [ ] Executor: `move` with same-volume rename and cross-volume copy-verify-delete.
- [ ] Journal: pending/done/failed steps; crash recovery on startup.
- [ ] Stability checker + temp-file ignore list.
- [ ] Watcher → stability → engine → executor pipeline (auto-apply).
- [ ] Minimal UI: pick one watched folder, list rules (hard-coded or simple form), show a raw log of operations.
- [ ] Unit tests for engine and planner; integration tests in temp directories.

**Deliverable:** drop `report.pdf` into Downloads → it lands in `Documents/PDF/report.pdf`, and the journal shows it.
**Exit criteria**
- Downloading a 1 GB file never triggers a premature move.
- Name collisions produce `report (2).pdf`, never an overwrite.
- Killing the app mid-operation leaves no lost files; restart reconciles.

---

### Phase 2 — Usable App: Rules UI, Preview, History, Undo (Weeks 5–7)

**Goal:** a real product a non-technical user can operate.

**Tasks**
- [ ] App shell: sidebar navigation (Dashboard, Rules, History, Unsorted, Settings).
- [ ] **Visual rule builder**
  - Condition rows with field/operator/value dropdowns; AND/OR groups (one level of nesting is enough for v1).
  - Action list with folder picker.
  - **Live test box:** type a sample filename → see whether it matches and where it would go.
  - Validation (empty values, invalid regex, destination loop).
- [ ] Rule list: enable/disable toggle, drag-to-reorder priority, duplicate, delete.
- [ ] Add conditions: `name` (contains/starts/ends/regex/glob), `size`, `source_folder`.
- [ ] Add actions: `copy`, `ignore`.
- [ ] **Plan → Review → Apply** ("Organize Now" / Dry Run)
  - Scan a folder, build a plan, show a grouped table (by rule/destination) with counts.
  - Per-file checkboxes to exclude items.
  - Summary: would move / copy / skip / no matching rule.
- [ ] **History view:** operations grouped by day, expandable to steps, filter by rule/status.
- [ ] **Undo:** undo an entire operation or individual steps, with safety checks from Section 8 and a clear report of anything that couldn't be reverted.
- [ ] **Unsorted inbox:** files with no matching rule, with a "Create rule from this file" shortcut.
- [ ] Multiple watched folders.
- [ ] Toast notifications inside the app for errors.

**Deliverable:** full create-rule → preview → apply → undo loop entirely through the GUI.
**Exit criteria**
- A non-technical friend can create a working rule without help in under 2 minutes (do this test!).
- Undo of a 100-file operation restores every file to its original path.

---

### Phase 3 — Power Features: Rename, Duplicates, Scans, Templates (Weeks 8–10)

**Goal:** the features that make FileFlow better than a script.

**Tasks**
- [ ] **Rename action** with pattern variables and transforms (`{name:clean}`, `{name:slug}`, `{date:YYYY-MM-DD}`, `{counter}`), live preview in the builder, and illegal-character sanitization.
- [ ] **Variables in destinations:** `Media/{kind}/{year}/{month}`.
- [ ] **Duplicate detection**
  - Maintain `file_index` for destination folders.
  - Hash only when a size match exists; cache hashes keyed by (path, size, mtime).
  - `is_duplicate` condition and `replace_if_duplicate` / "trash duplicate" options.
  - A "Find duplicates" tool view: groups, total reclaimable space, keep-newest/keep-oldest bulk choices → goes through Plan → Review → Apply.
- [ ] **Trash action** (recycle bin only).
- [ ] **Scheduled scans** + age conditions (`created_age`, `modified_age`), e.g., "trash installers older than 30 days" (with preview the first time).
- [ ] **Rule templates:** Student, Developer, Designer, General. Applying a template shows the rules first, lets the user adjust the base folder, then creates them (disabled by default, or with a first-run dry run).
- [ ] **Import/export rules** as JSON (share your setup with friends).

**Deliverable:** a new user applies the Student template and cleans a 1,000-file Downloads folder with a single reviewed operation.
**Exit criteria**
- Duplicate scan of 10,000 files finishes in reasonable time (target: under a minute on an SSD when few sizes collide).
- Rename preview exactly matches the real result.

---

### Phase 4 — Background Experience (Weeks 11–12)

**Goal:** FileFlow runs quietly all day.

**Tasks**
- [ ] **System tray**: status icon, pause/resume watching, "Organize now", open app, quit.
- [ ] Close-to-tray behavior (configurable).
- [ ] **Launch at startup** (Tauri autostart plugin), off by default, offered during onboarding.
- [ ] **Native notifications** — batched ("Organized 5 files") rather than one per file; a "quiet mode" option.
- [ ] **Pause rules / pause all** (e.g., during exams or big downloads).
- [ ] Watcher resilience: handle folders deleted/renamed/drives unplugged; re-attach when they return.
- [ ] Performance pass: idle CPU near 0%, memory target under ~100 MB.
- [ ] **Onboarding flow:** pick folders → pick template → run first dry run → enable auto mode.
- [ ] Settings page: conflict default, notification level, scan schedule, ignore list, theme (light/dark).

**Deliverable:** FileFlow starts with the OS and organizes files in the background for days without intervention.
**Exit criteria:** a 7-day personal "dogfooding" run with zero lost files and no crashes. Keep a log of every bug found.

---

### Phase 5 — Polish, Stats, Packaging & Release (Weeks 13–15)

**Goal:** something strangers can install.

**Tasks**
- [ ] **Statistics dashboard:** files organized (week/month), by kind, top rules, space reclaimed from duplicates. Computed from the journal — no extra tracking.
- [ ] Accessibility: keyboard navigation, focus states, screen-reader labels.
- [ ] Error handling review: every failure has a human-readable message and a suggested fix.
- [ ] **Packaging**
  - Windows: MSI/NSIS installer via Tauri bundler.
  - macOS: `.dmg` (note: unsigned apps show Gatekeeper warnings; code signing requires a paid Apple developer account).
  - Linux: AppImage and `.deb`.
- [ ] **Auto-updater** (Tauri updater plugin + GitHub Releases, signed update manifests).
- [ ] Windows code signing is paid; for a student release, document the SmartScreen warning honestly in the README.
- [ ] Documentation: README with GIF demo, user guide, rule-writing guide, FAQ, CONTRIBUTING.md, architecture doc.
- [ ] Landing page (GitHub Pages) with screenshots and download links.
- [ ] Release **v1.0.0** on GitHub; post to relevant communities for feedback.

**Deliverable:** public v1.0 release with installers for 3 OSes.
**Exit criteria:** 5 external users install it and use it for a week; collect feedback via GitHub Issues.

---

## 10. Testing Strategy

| Layer | What | How |
|---|---|---|
| Rule engine | Every field/operator, AND/OR nesting, priority, stop-after | Rust unit tests; table-driven cases |
| Planner | Collision naming, variable expansion, loop detection, illegal chars | Unit tests + **property-based tests** (`proptest`): "a plan never contains two steps writing the same destination" |
| Executor | Same-volume move, cross-volume move, locked file, missing destination, disk full | Integration tests on temp dirs (`tempfile` crate) |
| Journal & undo | Crash mid-operation, undo after file was modified, undo when source path now occupied | Fault-injection tests (panic at step N, restart, verify state) |
| Watcher | Browser downloads, bulk copy of 1,000 files, rapid rename chains | Semi-automated scripts + manual test checklist |
| UI | Rule builder flows, preview, undo | Vitest + React Testing Library; a few Playwright/WebDriver E2E flows |
| Cross-platform | Windows, macOS, Linux | CI matrix + manual smoke test before each release |

**Golden rule:** every bug that could lose a file gets a regression test before it's fixed.

---

## 11. Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| Moving a partially downloaded file | High | High | Temp-extension ignore list + stability check (Section 8.1) |
| Overwriting / losing a file | Critical | Medium | Never overwrite, copy-verify-delete, journal, trash-only |
| Watcher event storms (bulk copies) | Medium | High | Debouncing + serialized job queue + batching |
| Infinite move loops | Medium | Medium | Destination validation + recently-written set |
| Undo on changed files | High | Medium | Size/mtime verification; refuse unsafe undo with explanation |
| Rust learning curve | Medium | Medium | Phase 0 spikes; keep Rust surface small; Electron fallback |
| Antivirus / SmartScreen flags unsigned app | Low–Medium | High | Clear README guidance; open-source builds from CI |
| Scope creep | High | High | Stick to the phase exit criteria; park ideas in Section 14 |
| Cloud-sync placeholders | Medium | Medium | Detect and skip non-local files; warn on synced folders |

---

## 12. Repository Structure

```text
fileflow/
├── src/                        # React frontend
│   ├── app/                    # routes / layout
│   ├── features/
│   │   ├── rules/              # rule list, rule builder
│   │   ├── preview/            # plan review
│   │   ├── history/            # operations, undo
│   │   ├── unsorted/
│   │   ├── dashboard/
│   │   └── settings/
│   ├── components/             # shared UI
│   ├── lib/                    # tauri command wrappers, types
│   └── main.tsx
├── src-tauri/
│   ├── src/
│   │   ├── main.rs
│   │   ├── commands/           # tauri command handlers (thin)
│   │   ├── engine/             # rule evaluation (pure)
│   │   ├── planner/            # plan generation (pure)
│   │   ├── executor/           # file operations
│   │   ├── journal/            # operation log, crash recovery
│   │   ├── undo/
│   │   ├── watcher/            # notify + stability checker
│   │   ├── scheduler/          # periodic scans
│   │   ├── dedupe/             # hashing, file index
│   │   ├── templates/          # built-in rule templates (JSON)
│   │   ├── db/                 # migrations, repositories
│   │   └── tray.rs
│   ├── migrations/
│   ├── tests/                  # integration tests
│   └── tauri.conf.json
├── docs/
│   ├── architecture.md
│   ├── adr/                    # decision records
│   ├── user-guide.md
│   └── rules-reference.md
├── .github/workflows/
├── README.md
├── CONTRIBUTING.md
└── LICENSE
```

---

## 13. Timeline Summary

| Phase | Weeks | Focus | Key milestone |
|---|---|---|---|
| 0 | 1 | Setup & spikes | File events visible in app |
| 1 | 2–4 | Core engine + safety | Auto-move with journal, crash-safe |
| 2 | 5–7 | Rule builder, preview, history, undo | Full GUI loop, undo works |
| 3 | 8–10 | Rename, duplicates, scans, templates | 1,000-file cleanup in one reviewed operation |
| 4 | 11–12 | Tray, startup, notifications, onboarding | 7-day background dogfood run |
| 5 | 13–15 | Stats, packaging, docs, release | Public v1.0 on GitHub |

**Total: ~15 weeks** at 10–12 hrs/week. With a team of 3–4 (e.g., one on Rust core, one on UI, one on testing/docs), Phases 2–3 can overlap and the total drops to roughly 9–10 weeks.

### Suggested team split (if working as a team)
- **Core (Rust):** engine, planner, executor, journal, watcher.
- **Frontend:** app shell, rule builder, preview, history, dashboard.
- **Quality & release:** test suites, CI matrix, fault injection, packaging, docs, landing page.
- **Shared:** weekly demo + review against the exit criteria.

---

## 14. Stretch Goals

Park these until after v1.0:

- **Compress action** (zip old files).
- **Content-aware rules:** PDF text contains "invoice", image EXIF date/camera, audio ID3 tags.
- **Optional local AI classifier** (on-device, opt-in) that suggests rules from your Unsorted inbox — keeps the privacy promise.
- **Rule suggestions** from history: "You've manually moved 12 `.stl` files to `3D/` — create a rule?"
- **CLI companion** (`fileflow run --dry-run`) sharing the same Rust core.
- **Per-rule schedules** and "quiet hours".
- **Localization** (Tamil, Hindi, etc.).
- **Plugin/scripting hook** (run a user script as an action) — with strong warnings.

---

## 15. How to Pitch It (Resume / Viva / Demo)

**Resume line**
> *FileFlow — cross-platform desktop file automation (Tauri, Rust, React, SQLite). Built a rule engine with nested conditions, a crash-safe journaled executor with multi-level undo, BLAKE3-based duplicate detection, and a debounced filesystem watcher with download-completion detection. Released v1.0 with installers for Windows, macOS, and Linux.*

**Technical talking points that impress reviewers**
1. How you detect that a download has finished (stability checks, temp extensions).
2. Why cross-drive moves need copy → verify → delete.
3. How the journal makes the app crash-safe and undo trustworthy.
4. Why the rule engine and planner are pure functions (testability, property tests).
5. Why hashing is lazy and size-gated (performance).
6. How you prevented infinite move loops.

**Live demo script (3 minutes)**
1. Show a messy Downloads folder.
2. Apply the Student template → Dry Run → show the preview with counts.
3. Apply → folders appear organized.
4. Download a file live in the browser → it gets sorted automatically; tray notification appears.
5. Open History → Undo the bulk operation → everything returns.
6. Close with the privacy line: *"Your files never leave your computer."*