# FileFlow

**Your files. Automatically organized.**

FileFlow is a local-first desktop app that watches folders such as Downloads and Desktop and sorts new files with rules you define. Every change is previewed, journaled and undoable, so you can automate without worrying about losing files.

Built with Electron, React, TypeScript and SQLite. It runs on Windows, macOS and Linux.

---

## Features

- **Visual rule builder.** Build rules in the GUI, with no YAML or config files. Conditions can be grouped with AND/OR logic.
- **Default rules.** A fresh install seeds a basic rule set that sorts documents, images, videos, audio, archives, code and installers into sensible folders.
- **Folder watching.** New files are detected automatically. FileFlow waits for a file to finish writing before touching it, and it ignores in-progress downloads (`.crdownload`, `.part`, `.tmp` and similar).
- **Preview before you apply.** Run a dry run to see exactly what would move and where, then apply it.
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

**Destination variables:** `{kind}` `{ext}` `{name}` `{year}` `{month}` `{date}` `{date:YYYY-MM-DD}` `{date:YYYY-MM}` `{date:YYYY}`

**Rename variables:** `{name}` `{name:clean}` `{name:lower}` `{name:slug}` `{ext}` `{kind}` `{date}`. The `clean` transform strips suffixes like `(1)` and ` - Copy`.

---

## Safety guarantees

A file tool that loses files is worse than no tool, so these rules are built in:

1. **Files are never overwritten.** Name collisions get a numbered name such as `report (2).pdf`.
2. **Files are never hard-deleted.** Delete means move to the OS Recycle Bin or Trash.
3. **Cross-drive moves are verified.** When a plain rename fails across volumes, FileFlow copies the file, checks the size, and only then removes the original.
4. **The journal is written before and after each step.** After a crash, steps left `pending` are reconciled on the next start.
5. **Incomplete files are skipped.** Temp download extensions are ignored, and FileFlow waits until a file's size has stopped changing.
6. **Operations run one at a time.** Steps go through a single serialized executor.
7. **Undo checks first.** A step is only reverted when it is safe to do so.

---

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) 18 or newer
- npm
- On Windows, the native `better-sqlite3` module may need the Visual Studio C++ build tools if no prebuilt binary is available

### Run in development

```bash
git clone https://github.com/<your-username>/FileFlow.git
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
| `npm run electron:start` | Build everything and launch the app without installing it |

---

## How to use it

1. **Open the app.** Default rules for your Documents, Pictures, Videos and Music folders are created on first run.
2. **Add a watched folder** (for example Downloads) and turn watching on.
3. **Edit or add rules** under **Rules**. The builder lets you set conditions, destinations and priority.
4. **Use Preview** to dry-run your rules against a folder and see the plan before anything moves.
5. **Review History** to see what was moved. Undo a batch or a single file.
6. **Check Unsorted** for files that matched no rule.
7. **Open Settings** to change the theme, the default conflict policy, notification level, scan schedule and ignore patterns.

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

**Tech stack:** Electron, React 18, TypeScript, Vite, Tailwind CSS 4, better-sqlite3, chokidar, picomatch, trash, lucide-react.

---

## Roadmap

Some items below are in the design but not yet implemented:

- Age-based rules (`created_age`, `modified_age`) for scheduled scans
- Duplicate detection with content hashing
- Protected-path checks that refuse to watch system folders
- System tray, autostart and auto-update
- Automated tests and CI
- Rule templates (for example Student, Developer, Designer)

---

## Contributing

Issues and pull requests are welcome. For larger changes, please open an issue first to discuss the approach. Keep the safety guarantees above intact: any change that touches file operations must keep them.

## License

No license has been chosen yet. Add a `LICENSE` file (for example MIT) before publishing, and replace this section with its name.
