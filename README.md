# FileFlow

**Your files. Automatically organized.**

FileFlow is a local-first desktop app that watches folders such as Downloads and Desktop and sorts new files with rules you define. Every change is previewed, journaled and undoable, so you can automate without worrying about losing files.

Built with Electron, React, TypeScript and SQLite. It runs on Windows, macOS and Linux.

---

## Features

- **Visual rule builder.** Build rules in the GUI, with no YAML or config files. Conditions can be grouped with AND/OR logic.
- **Default rules.** A fresh install seeds a basic rule set that sorts documents, images, videos, audio, archives, code and installers into sensible folders.
- **Folder watching.** New files are detected automatically. FileFlow waits for a file to finish writing before touching it, and it ignores in-progress downloads (`.crdownload`, `.part`, `.tmp` and similar).
- **Preview before you apply.** Run a dry run to see exactly what would move and where, then apply it. Apply runs the plan you reviewed, and each step is re-checked against the disk first.
- **History and undo.** Every operation is recorded. Undo a whole batch or a single step.
- **Unsorted inbox.** Files that match no rule are left alone. You can review them later, with no popups.
- **Local only.** There is no telemetry, no account and no cloud. Your data lives in a local SQLite database.

### Rule conditions

| Field | Operators |
|---|---|
| `extension` | `is`, `in`, `not_in` |
| `name` (without extension) | `contains`, `starts_with`, `ends_with`, `equals`, `matches` (regex), `glob` |
| `size` | `gt`, `lt`, `between` |
| `kind` (document, image, video, audio, archive, code, installer) | `is`, `in` |
| `source_folder` | `is` |

Rules are evaluated in priority order (lower number first). By default the first match wins.

### Rule actions

| Action | Description |
|---|---|
| `move` | Move to a destination. Destinations can use variables such as `Documents/{kind}/{year}`. |
| `copy` | Copy to a destination. |
| `rename` | Rename with a pattern. |
| `trash` | Send to the OS Recycle Bin or Trash. |

**Destination variables:** `{root}` (the watched folder the file belongs to) `{kind}` `{ext}` `{name}` `{year}` `{month}` `{date}` `{date:YYYY-MM-DD}` `{date:YYYY-MM}` `{date:YYYY}`

**Rename variables:** `{name}` `{name:clean}` `{name:lower}` `{name:slug}` `{ext}` `{kind}` `{date}`. The `clean` transform strips suffixes like `(1)` and ` - Copy`.

---

## Safety guarantees

A file tool that loses files is worse than no tool, so these rules are built in and covered by automated tests:

1. **Existing files are never overwritten.** If the destination name is taken, the new file gets a numbered name such as `report (2).pdf`. This is re-checked immediately before each move, not only when the plan is made.
2. **You choose what happens on a name clash** (Settings): keep both (default), skip the file and leave it where it is, or remove the incoming file only when the existing one is byte-for-byte identical (otherwise both are kept).
3. **Files are never hard-deleted.** Delete means move to the OS Recycle Bin or Trash.
4. **Changed files are not touched.** If a file's size or modification time changed after the preview, that step is skipped.
5. **Cross-drive moves are verified.** When a plain rename fails across volumes, FileFlow copies the file, compares SHA-256 hashes, and only then removes the original.
6. **The journal is written before and after each step.** After a crash, steps left `pending` are reconciled on the next start.
7. **Incomplete and hidden files are skipped.** Temp download extensions and dotfiles are ignored, and FileFlow waits until a file has stopped changing.
8. **Files are not sorted twice.** Folders FileFlow fills (such as `Downloads/Documents`) are excluded from scans and watching, FileFlow's own moves and undo restores are not picked up again, and a loop breaker stops any path that keeps reappearing.
9. **Operations run one at a time.** Watcher events go through a single serialized queue.
10. **Undo checks first.** A step is only reverted when it is safe to do so (the file is still there, unchanged in size, and the original location is free).
11. **Database upgrades keep a backup.** Before an existing database is migrated, a copy is saved next to it as `fileflow.db.bak-v<version>`.

Moving a file to the Trash cannot be undone from inside FileFlow; restore it from the system Recycle Bin or Trash.

---

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) 18 or newer
- npm
- On Windows, the native `better-sqlite3` module may need the Visual Studio C++ build tools if no prebuilt binary is available

### Run in development

```bash
git clone https://github.com/Mohanraj1232/FileFlow.git
cd FileFlow
npm install
npm run electron:dev
```

This compiles the Electron main process, starts the Vite dev server on port 1420, and launches the app with hot reload for the UI.

### Build an installer

```bash
npm run electron:build
```

Installers are written to `release/`: NSIS on Windows, DMG on macOS and AppImage on Linux.

### Other scripts

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server only (UI in the browser, without the Electron backend) |
| `npm run build` | Type-check and build the UI |
| `npm run build:electron` | Compile the Electron main process |
| `npm run typecheck` | Type-check the UI and the Electron main process |
| `npm test` | Run the backend test suite (see [Testing](#testing)) |
| `npm run electron:start` | Build everything and launch the app without installing it |

---

## How to use it

1. **Open the app.** Default rules for your Documents, Pictures, Videos and Music folders are created on first run.
2. **Add a watched folder** (for example Downloads) and turn watching on.
3. **Edit or add rules** under **Rules**. The builder lets you set conditions, destinations and priority.
4. **Use Preview** to dry-run your rules against a folder and see the plan before anything moves.
5. **Review History** to see what was moved. Undo a batch or a single file.
6. **Check Unsorted** for files that matched no rule.
7. **Open Settings** to change the theme, what happens when a file with the same name already exists, and which files and folders to ignore.

---

## Architecture

```text
React UI (renderer)  ──IPC──▶  Electron main process
                                 │
   Watcher (chokidar) ─▶ Stability check ─▶ Rule engine (pure) ─▶ Planner (pure)
                                                                      │
                                                                      ▼
                                                  Executor (journaled) ─▶ SQLite
                                                                      ▲
                                                             Undo service
```

The pipeline is **Detect → Stabilize → Match → Plan → (Review) → Execute → Journal**.

The rule engine and planner are pure functions with no I/O, which keeps them easy to test.

```text
electron/
  main.ts            App entry, window, watcher wiring
  preload.ts         Safe IPC bridge to the renderer
  core/
    engine.ts        Rule evaluation (pure)
    planner.ts       Destination resolution and conflict handling (pure)
    executor.ts      Journaled file operations, crash recovery
    journal.ts       Operation history
    undo.ts          Safe reversal of operations
    watcher.ts       Folder watching and ignore lists
    db.ts            SQLite schema and default rules
    handlers.ts      IPC handlers
    models.ts        File metadata and extension-to-kind map
src/
  app/               Layout, sidebar, title bar
  components/        Shared UI components
  features/          Dashboard, Rules, Preview, History, Unsorted, Settings
  lib/               Types, theme and IPC command wrappers
```

## Testing

```bash
npm test
```

The backend tests use Vitest and run under Electron's own Node, so the native `better-sqlite3` build matches the one the app ships with. Every test works on temporary directories and synthetic files, never on real user data. They cover rule evaluation, planning and conflict handling, execution and re-validation, undo, crash recovery, the watcher pipeline, repeated and recursive scans, and database migrations.

**Tech stack:** Electron, React 18, TypeScript, Vite, Tailwind CSS 4, better-sqlite3, chokidar, picomatch, trash, lucide-react.

---

## Roadmap

Some items below are in the design but not yet implemented. In particular, the settings screen does not yet offer a scan schedule or notification level because those are not wired up yet.

- Age-based rules (`created_age`, `modified_age`) for scheduled scans
- Duplicate detection with content hashing
- Protected-path checks that refuse to watch system folders
- System tray, autostart and auto-update
- Rule templates (for example Student, Developer, Designer)

---

## Contributing

Issues and pull requests are welcome. For larger changes, please open an issue first to discuss the approach. Keep the safety guarantees above intact: any change that touches file operations must keep them.

## License

Released under the [MIT License](LICENSE).
