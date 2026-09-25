# Family Print Lab

Plan, design, print and track a household's 3D-printing projects: ideas per person, a model workbench (parametric OpenSCAD parts with live sliders and AI editing, mesh tools, Blender round-trips, full version history), print jobs with slicer settings, a filament shelf that deducts what each print uses, a live link to a Bambu Lab printer on your network (status, sending sliced plates, print control), and an AI lab assistant that uses your Claude or ChatGPT subscription. Runs on your own computer; data stays in a local SQLite database. For an overview, privacy notes and the license, see the [project README](../README.md).

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
npm run dev:sim           # same, plus a simulated Bambu printer (control page: http://127.0.0.1:8766)
```

`dev:sim` uses its own database copy (`data/dev-sim.db`, seeded from `data/printlab.db`) so simulated prints never touch real data; delete it to start fresh, or pass `-- --real-data`. The simulator alone: `npm run sim -- --help`.

## Configuration (`.env`)

| Setting                                           | Purpose                                                                       |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| `DATABASE_URL`                                    | SQLite file (default `data/printlab.db`)                                      |
| `BACKUP_DIR`                                      | Automatic backups (default `data/backups`, daily, 14 kept)                    |
| `LEGACY_IMPORT`                                   | Previous app's `family.json` to import into an empty database                 |
| `HOST`, `PORT`                                    | Production server address (default `127.0.0.1:8765`)                          |
| `ALLOWED_HOSTS`                                   | Extra host names accepted when deliberately exposing the app on a LAN         |
| `BODY_SIZE_LIMIT`                                 | Largest request the server accepts; `110M` so model uploads (≤ 100 MB) fit    |
| `CLAUDE_BIN`, `CODEX_BIN`                         | Locations of the Claude Code / Codex CLIs if not on `PATH` or `~/.local/bin`  |
| `ANTHROPIC_API_KEY`                               | Optional API-key provider; `LAB_AI_MODEL`, `LAB_AI=off`                       |
| `MODELS_DIR`                                      | Model files (default `data/models`; other databases get `data/<name>-models`) |
| `BLENDER_PATH`                                    | Blender executable if not found automatically                                 |
| `BAMBU_HOST`, `BAMBU_SERIAL`, `BAMBU_ACCESS_CODE` | Printer in LAN-only + Developer Mode; optional `BAMBU_NAME`                   |
| `CLOUD_URL`                                       | Optional Print Lab Cloud, to answer kids’ requests from a phone               |

Which AI handles each task (chat, ideas, diagnosis, slicer settings, checklists, designing models) is chosen on the **Integrations** page (the status pill in the top bar): Claude through Claude Code, ChatGPT through Codex, or the Anthropic API. Subscriptions run through the official, unmodified CLIs in a locked-down mode (no tools, no file access, no MCP servers, no saved sessions; any API key in the environment is removed so billing stays on the subscription). Keep the app single-user when using a subscription. Requests send the details the task needs (workspace details such as family names and ages, projects, jobs, spools, printer status, attached photos, or a model's code) to the chosen provider. The printer link uses the printer's local MQTT reports for status and FTPS to upload sliced `.gcode.3mf` plates; commands (start, pause, resume, stop) are only sent when you press the button. LAN-only mode turns off Bambu cloud features such as remote printing from Bambu Handy.

## Architecture

- **SvelteKit + TypeScript** (Svelte 5 runes), built with adapter-node.
- **SQLite + Drizzle ORM**: schema in `src/lib/server/db/schema.ts`, migrations in `drizzle/` (applied on start; generate new ones with `npm run db:generate` after changing the schema). WAL mode, foreign keys, check constraints.
- **Service layer** `src/lib/server/lab.ts`: every write is validated (Zod, `validation.ts`), runs in one transaction, checks the row's `version` (concurrent edits get a 409 instead of overwriting), logs to the `activity` table and notifies live clients. Filament accounting (charging spools when prints finish, exact refunds on edit/delete) lives here.
- **Background tasks** `src/lib/server/tasks.ts`: AI designs and edits, Blender jobs and Blender windows run as tasks, not inside a web request, so closing a dialog or tab does not lose them. Each stage ("Asking Claude…", "Fixing a render error (attempt 2 of 3)…") is pushed to every open tab over the live event stream; the Activity tray, project pages and cards show them, and finished AI suggestions wait there to be reviewed or saved. Tasks are kept in memory (recent history until the app restarts).
- **Floating panels and writing help**: editors open as floating panels (minimize, expand, keep across pages). Long text fields have ⤢ (larger editor) and ✦ (AI writing help: flesh out an idea, make it clearer, list what to decide, what to measure, tidy notes). Suggestions stream in and change nothing until accepted (`POST /api/ai/write`).
- **Sketches**: a sketch pad (pen, marker, line, eraser, colours, undo, guide grid) for ideas. Sketches are PNGs stored in the database (so backups include them), shown on the project and in its visualizer, and can open the AI designer with the drawing attached.
- **Bulk changes**: select projects on the home grid (Select, Ctrl/⌘-click, Shift-click, Ctrl+A) to change progress, person or category, pin, duplicate or delete them in one transaction (`POST /api/projects/bulk`), all or nothing.
- **API** under `src/routes/api/` (one route per resource) and **live updates** over server-sent events (`/api/events`): every open tab stays in sync, including printer status and task progress. (Server-sent events rather than WebSockets: the server only needs to push, they reconnect by themselves, and they work with adapter-node as is.)
- **Printer** `src/lib/server/printer/`: minimal MQTT client, Bambu report parser, FTPS upload of sliced plates and print control, automation (a running print links to the one unlinked Printing job; the job closes itself as Succeeded/Failed), and the simulator.
- **AI** `src/lib/server/ai/`: `providers.ts` (Claude Code, Codex and Anthropic API behind one interface: structured JSON answers, streamed chat, images; at most two CLI runs at once), `assistant.ts` (ideas, failure diagnosis, slicer settings, checklists, chat), `cad.ts` (designs and edits OpenSCAD; every attempt is compiled and errors go back to the AI, up to 3 tries). Suggestions never write data until the user applies them.
- **Models** `src/lib/server/models.ts` + `src/lib/server/cad/`: parametric models (OpenSCAD 2025 in WebAssembly with the Manifold backend, one isolated worker per render with a timeout; customizer-style parameters parsed from the file) and mesh models (STL/3MF/OBJ import; scale, rotate, mirror, lay flat, cut, drill and boolean combine via manifold-3d). Every change is an immutable version stored as `data/models/<model>/<version>.stl` with a thumbnail; downloads as STL or 3MF. Blender runs headless for repair/simplify, and interactively for "Open in Blender", where each save comes back as a new version. Print jobs can link to the exact model version printed.
- **Integrations** `/integrations` (`src/lib/server/integrations.ts`): one card per tool (Claude Code, Codex, Anthropic API, Blender, OpenSCAD, printer) with live status, what it powers, a real test round trip and copyable setup steps; per-task AI routing. The top bar shows the same status; the design dialog can ask Claude and ChatGPT at once and show both designs side by side.
- **Workbench** `/projects/[id]/models/[modelId]`: three.js viewer on a to-scale X2D bed (views, section plane, measuring, face/point picking), CodeMirror editor with inline errors, parameter sliders with live preview, AI edit panel, mesh tools, and version history.
- **Print Lab Cloud link** `src/lib/server/cloud/link.ts` (optional, `CLOUD_URL`): device-code linking, one outbound WebSocket, reports print requests and accepts only approve/decline, applied through `Lab.decideRequest` like the Family page. Protocol: [`docs/cloud-protocol.md`](../docs/cloud-protocol.md); `tools/cloud-sim.ts` implements the cloud side for tests.
- **Security**: binds to 127.0.0.1 by default; rejects unexpected `Host` headers (DNS rebinding) and cross-site writes; strict CSP with script nonces; request size limits; `nosniff`, no-referrer and COOP headers.
- **Backups**: one folder per backup with a consistent online SQLite copy plus the model files (hard-linked, so unchanged files take no extra space); daily and before every import, 14 kept. JSON export/import (⋯ menu) for portability; it covers records, not model files.

## Checks

```sh
npm run check             # svelte-check (types)
npm run lint              # prettier + eslint
npm run test:unit -- --run    # services, filament accounting, import/export, printer (simulator), AI (stubbed and fake CLIs), CAD, mesh ops, model store
npm run test:e2e          # production build in Chrome against a throwaway database and a simulated printer
```

Unit tests use in-memory databases; end-to-end tests use `.e2e/`. Neither touches `data/`. No test calls a real AI provider or printer (the Blender test runs only when Blender is installed): report fields and the TLS/FTPS connection have so far been checked against the simulator only; reports from other Bambu Lab models may need parser changes.
