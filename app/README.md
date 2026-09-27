# Family Print Lab

Plan, design, print and track a household's 3D-printing projects: ideas per person, a model workbench (parametric OpenSCAD parts with live sliders and AI editing, mesh tools, Blender round-trips, full version history), print jobs with slicer settings, a filament shelf that deducts what each print uses, live links to the Bambu Lab printers on your network (status, sending sliced plates, print control), and an AI lab assistant that uses your Claude or ChatGPT subscription. Runs on your own computer; data stays in a local SQLite database. For an overview, privacy notes and the license, see the [project README](../README.md).

## Requirements

Node.js 24 (`nvm use` picks it up from `.nvmrc`). No other services. Optional, detected automatically:

- **Claude Code** (`claude`, signed in with `/login`) and/or **Codex** (`codex login`) to use a Claude or ChatGPT subscription for the AI features. An Anthropic API key also works.
- **Blender** 4.2+ for mesh repair/simplify and "Open in Blender" (portable build in `~/.local/opt/blender-*` or on `PATH`).

## Run it

```sh
nvm use
npm install
cp .env.example .env      # optional settings: printer, assistant, port
npm run build
npm start                 # http://127.0.0.1:8765 (HOST/PORT in .env)
```

On first start the database is created and migrated, and the app asks you to create the first profile. If you are upgrading from the original single-file version, put its `family.json` at `data/legacy/family.json` (or set `LEGACY_IMPORT`) before the first start and it is imported into the empty database. Existing data can also be restored from the app (⋯ → Import backup).

### Develop

```sh
npm run dev               # http://localhost:5173 with hot reload
npm run dev:sim           # same, plus three simulated Bambu printers: X2D, P1S, A1 mini (control page: http://127.0.0.1:8766)
```

`dev:sim` uses its own database copy (`data/dev-sim.db`, seeded from `data/printlab.db`) so simulated prints never touch real data; delete it to start fresh, pass `-- --real-data`, or `-- --single` for just the X2D. The simulator alone: `npm run sim -- --help` (any model: `--fleet N6,C12,N1`).

## Configuration (`.env`)

| Setting                                           | Purpose                                                                                |
| ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                    | SQLite file (default `data/printlab.db`)                                               |
| `BACKUP_DIR`                                      | Automatic backups (default `data/backups`, daily, 14 kept)                             |
| `LEGACY_IMPORT`                                   | Previous app's `family.json` to import into an empty database                          |
| `HOST`, `PORT`                                    | Production server address (default `127.0.0.1:8765`)                                   |
| `ALLOWED_HOSTS`                                   | Extra host names accepted when deliberately exposing the app on a LAN                  |
| `BODY_SIZE_LIMIT`                                 | Largest request the server accepts; `110M` so model uploads (≤ 100 MB) fit             |
| `CLAUDE_BIN`, `CODEX_BIN`                         | Locations of the Claude Code / Codex CLIs if not on `PATH` or `~/.local/bin`           |
| `ANTHROPIC_API_KEY`                               | Optional API-key provider; `LAB_AI_MODEL`, `LAB_AI=off`                                |
| `MODELS_DIR`                                      | Model files (default `data/models`; other databases get `data/<name>-models`)          |
| `BLENDER_PATH`                                    | Blender executable if not found automatically                                          |
| `BAMBU_HOST`, `BAMBU_SERIAL`, `BAMBU_ACCESS_CODE` | Older setups: one printer, imported once into Settings → Printers (add printers there) |
| `BAMBU_NAME`, `BAMBU_MODEL`                       | Name and model code (`N6` = X2D, `C12` = P1S…) of that imported printer                |
| `PRINTLAB_PRINTERS`                               | Development and tests only: a JSON list of printers registered on every start          |
| `PRINTLAB_SLICER_PATH`                            | The Print Lab Slicer engine binary, once built (see `slicer/UPSTREAM.md`)              |
| `BAMBU_STUDIO_PATH`, `ORCA_SLICER_PATH`           | A Bambu Studio or OrcaSlicer install to slice with, if not found automatically         |
| `CLOUD_URL`                                       | Optional Print Lab Cloud, to answer kids’ requests from a phone                        |

Which AI handles each task (chat, ideas, diagnosis, slicer settings, checklists, designing models) is chosen on the **Integrations** page (the status pill in the top bar): Claude through Claude Code, ChatGPT through Codex, or the Anthropic API. Subscriptions run through the official, unmodified CLIs in a locked-down mode (no tools, no file access, no MCP servers, no saved sessions; any API key in the environment is removed so billing stays on the subscription). Keep the app single-user when using a subscription. Requests send the details the task needs (workspace details such as family names and ages, projects, jobs, spools, printer status, attached photos, or a model's code) to the chosen provider. The printer link uses the printer's local MQTT reports for status and FTPS to upload sliced `.gcode.3mf` plates; commands (start, pause, resume, stop) are only sent when you press the button. LAN-only mode turns off Bambu cloud features such as remote printing from Bambu Handy.

## Architecture

- **SvelteKit + TypeScript** (Svelte 5 runes), built with adapter-node.
- **SQLite + Drizzle ORM**: tables in `src/lib/server/db/tables/`, one file per area, gathered by `src/lib/server/db/schema.ts`; migrations in `drizzle/` (applied on start; generate new ones with `npm run db:generate` after changing the schema). WAL mode, foreign keys, check constraints.
- **Service layer** `src/lib/server/lab.ts`: every write is validated (Zod, `validation.ts`), runs in one transaction, checks the row's `version` (concurrent edits get a 409 instead of overwriting), logs to the `activity` table and notifies live clients. Filament accounting (charging spools when prints finish, exact refunds on edit/delete) lives here.
- **Background tasks** `src/lib/server/tasks.ts`: AI designs and edits, Blender jobs and Blender windows run as tasks, not inside a web request, so closing a dialog or tab does not lose them. Each stage ("Asking Claude…", "Fixing a render error (attempt 2 of 3)…") is pushed to every open tab over the live event stream; the Activity tray, project pages and cards show them, and finished AI suggestions wait there to be reviewed or saved. Tasks are kept in memory (recent history until the app restarts).
- **Floating panels and writing help**: editors open as floating panels (minimize, expand, keep across pages). Long text fields have ⤢ (larger editor) and ✦ (AI writing help: flesh out an idea, make it clearer, list what to decide, what to measure, tidy notes). Suggestions stream in and change nothing until accepted (`POST /api/ai/write`).
- **Sketches**: a sketch pad (pen, marker, line, eraser, colours, undo, guide grid) for ideas. Sketches are PNGs stored in the database (so backups include them), shown on the project and in its visualizer, and can open the AI designer with the drawing attached.
- **Bulk changes**: select projects on the home grid (Select, Ctrl/⌘-click, Shift-click, Ctrl+A) to change progress, person or category, pin, duplicate or delete them in one transaction (`POST /api/projects/bulk`), all or nothing.
- **API** under `src/routes/api/` (one route per resource) and **live updates** over server-sent events (`/api/events`): every open tab stays in sync, including printer status and task progress. (Server-sent events rather than WebSockets: the server only needs to push, they reconnect by themselves, and they work with adapter-node as is.)
- **Printers** `src/lib/server/printer/`: the saved printers and their connections, typed commands, status changes as events and the simulator for every model. See [Printers, commands and events](#printers-commands-and-events) below.
- **Extension points**: server modules (`src/lib/server/modules/<key>/module.ts`), UI slots (`src/lib/client/modules/<key>/ui.ts`), commands (`commands/defs/<key>.ts`), simulator features, events and tables are added as files; `src/lib/server/testing/harness.ts` gives integration tests a runtime with simulated printers. See `docs/parity/PLAN.md`.
- **Slicer** `src/lib/server/slicer.ts` + `src/lib/server/slicer/`: slices a model version for the job's printer with the Bambu Studio (or OrcaSlicer) command line, flattening Bambu's system profiles first. `slicer/locate.ts` finds a slicer (our engine first, then a stock install) and `slicer/engine.ts` is the client for Print Lab Slicer, our headless engine built from Bambu Studio's libslic3r, which speaks newline-delimited JSON-RPC on stdin/stdout (`src/lib/shared/slicer/protocol.ts`). The engine itself and how the Bambu Studio fork is kept up to date live in `../slicer/` ([`UPSTREAM.md`](../slicer/UPSTREAM.md)).
- **AI** `src/lib/server/ai/`: `providers.ts` (Claude Code, Codex and Anthropic API behind one interface: structured JSON answers, streamed chat, images; at most two CLI runs at once), `assistant.ts` (ideas, failure diagnosis, slicer settings, checklists, chat), `cad.ts` (designs and edits OpenSCAD; every attempt is compiled and errors go back to the AI, up to 3 tries). Suggestions never write data until the user applies them.
- **Models** `src/lib/server/models.ts` + `src/lib/server/cad/`: parametric models (OpenSCAD 2025 in WebAssembly with the Manifold backend, one isolated worker per render with a timeout; customizer-style parameters parsed from the file) and mesh models (STL/3MF/OBJ import; scale, rotate, mirror, lay flat, cut, drill and boolean combine via manifold-3d). Every change is an immutable version stored as `data/models/<model>/<version>.stl` with a thumbnail; downloads as STL or 3MF. Blender runs headless for repair/simplify, and interactively for "Open in Blender", where each save comes back as a new version. Print jobs can link to the exact model version printed.
- **Integrations** `/integrations` (`src/lib/server/integrations.ts`): one card per tool (Claude Code, Codex, Anthropic API, Blender, OpenSCAD, the slicer, the printers, and rows modules add), with Settings → Printers first with live status, what it powers, a real test round trip and copyable setup steps; per-task AI routing. The top bar shows the same status; the design dialog can ask Claude and ChatGPT at once and show both designs side by side.
- **Workbench** `/projects/[id]/models/[modelId]`: three.js viewer on a to-scale X2D bed (views, section plane, measuring, face/point picking), CodeMirror editor with inline errors, parameter sliders with live preview, AI edit panel, mesh tools, and version history.
- **Print Lab Cloud link** `src/lib/server/cloud/link.ts` (optional, `CLOUD_URL`): device-code linking, one outbound WebSocket, reports print requests and accepts only approve/decline, applied through `Lab.decideRequest` like the Family page. Protocol: [`docs/cloud-protocol.md`](../docs/cloud-protocol.md); `tools/cloud-sim.ts` implements the cloud side for tests.
- **Security**: binds to 127.0.0.1 by default; rejects unexpected `Host` headers (DNS rebinding) and cross-site writes; strict CSP with script nonces; request size limits; `nosniff`, no-referrer and COOP headers.
- **Backups**: one folder per backup with a consistent online SQLite copy plus the model files (hard-linked, so unchanged files take no extra space); daily and before every import, 14 kept. JSON export/import (⋯ menu) for portability; it covers records, not model files.

## Printers, commands and events

How the app talks to Bambu Lab printers, from the saved settings to the live page. Everything cites the source of each payload (OpenBambuAPI, ha-bambulab, Bambu Studio) next to the code.

- **Models** `src/lib/shared/printers/`: `models.generated.ts` is generated from Bambu Studio's printer profiles at the pinned release (`tools/gen-printer-models.ts`), and `models.ts` adds what the profiles do not say (camera, nozzles, HMS prefix, start-print URL form) and derives each model's capabilities. `status.ts` is the typed status every page and module reads.
- **PrinterManager** `manager.ts`: the `printers` table is the source of truth (Settings → Printers; the old `BAMBU_*` settings are imported once). Each enabled printer gets one `BambuPrinter` connection (`bambu.ts`): MQTT over TLS to the printer's local broker, a full report asked for on every reconnect, and FTPS uploads (`ftp.ts`). Reports are merged into the retained state (`report.ts`; P1, A1 and newer send only what changed, so trays and units merge by id) and parsed into a snapshot. The first printer in the list is the default for old single-printer call sites and for Print Lab Cloud. Writes are versioned like the rest of the workspace. **Find printers** (`discovery.ts`) listens for SSDP on UDP 2021 and only suggests printers; it never changes a saved one.
- **Trust** `tls.ts`: SNI is the serial, TLS 1.2 at most (the P2S never answers TLS 1.3), the bundled Bambu CAs (`certs/`) and our own check that the certificate's CN is the serial. When the chain does not verify, the certificate is pinned the first time a person tests or adds the printer, and a different one later is refused until they press Trust the new certificate. The access code is never sent before this check.
- **Command layer** `commands/`: each command is a definition in `commands/defs/*.ts` with its topic, source, a Zod schema for its parameters, the capabilities it needs, a guard that refuses in plain words, the message it builds, and a risk (`safe`, `confirm` or `parent`, never in kid mode). `BambuPrinter.send(name, params)` validates, refuses when Developer Mode is off, adds the sequence id, publishes (QoS 1 for pause, resume and stop) and resolves `confirmed` on the printer's reply or when live status shows the effect, else `sent` after a timeout. `POST /api/printers/[id]/commands` runs one by name. `commands.golden.json` pins every payload.
- **Event bus** `../events.ts`: `diff.ts` turns each status change into typed events (`printer.online|offline`, `print.started|paused|resumed|layer|finished|failed|cancelled`, `hms.raised|cleared`, `ams.runout`, `ams.tray.changed`), and `Lab` emits `request.created|decided`. Listeners run in registration order; the runtime's own (linking a running print to a Printing job and closing it as Succeeded, Failed or Cancelled) run before any module's. Modules add events by declaration merging. The last 200 events are kept for a first load.
- **Live updates**: `/api/events` sends each printer's status (throttled to one per 750 ms per printer) and module live channels (`event: live`) to every open tab; `LabStore` keeps printers by id.
- **Pages**: `/printers` (overview) and `/printers/[id]` (current print, temperatures, AMS, alerts, connection, ready jobs); Settings → Printers adds, tests, reorders and removes printers. Packages add panels and tabs through the UI registry instead of editing the pages.
- **Simulator** `sim/`: a simulated printer for every model, started from real published reports (`sim/states/`), speaking MQTT and FTP like firmware. Packages add behaviour in `sim/features/`. `npm run dev:sim` runs a fleet; `testing/harness.ts` gives tests one on free ports.
- **AMS sync** `modules/ams/` (package `ams`): links each tray to a Filament shelf spool (`ams_links`; Bambu RFID spools link by themselves by `tray_uuid`, others are suggested by material and colour for the person to confirm), adds an RFID spool to the shelf in one click, and charges each finished or failed print to the spools in the trays it used from the job's AMS mapping and the sliced grams (`spool_charges`; deleting or re-opening the job refunds them through SQLite triggers). The AMS panel on each printer page shows humidity, temperature and drying (AMS 2 Pro and AMS HT), and sends tray settings, RFID re-reads and the AMS options (`commands/defs/ams.ts`). Spoolman is an opt-in integration (Integrations → Spoolman): import spools, record usage, pull weights. Events: `spool.charged`, `spool.linked`, `spool.low`.
- **Camera and print queue** are not in the app yet. They come as the `camera` and `queue` packages, each a server module with its own routes, commands, simulator feature and UI slots (`docs/parity/PLAN.md` 5.3 and 5.11). What works today and what is still to come: [`docs/parity/STATUS.md`](../docs/parity/STATUS.md).

## Checks

```sh
npm run check             # svelte-check (types)
npm run lint              # prettier + eslint
npm run test:unit -- --run    # services, filament accounting, import/export, printer (simulator), AI (stubbed and fake CLIs), CAD, mesh ops, model store
npm run test:e2e          # production build in Chrome against a throwaway database and a simulated printer
```

Unit tests use in-memory databases; end-to-end tests use `.e2e/`. Neither touches `data/`. No test calls a real AI provider or printer (the Blender test runs only when Blender is installed): report fields have been checked against published reports from other projects (ha-bambulab's mocks) and the simulator, and the TLS/FTPS connection against the simulator only. Settings → Printers → Download diagnostics saves a redacted report that can become a new test fixture.
