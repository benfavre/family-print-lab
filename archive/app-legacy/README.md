# Family Print Lab

A local web app for managing family 3D-printing ideas and projects. Includes four editable profiles and 16 starter ideas (four each). Starter ideas are suggestions, not downloaded models or ready-to-print files.

## Open the app

From `/home/pc1/dev/lab`:

```sh
node app/server.js
```

Open **http://127.0.0.1:8765** in your browser. Keep the terminal running; press Ctrl+C to stop. To use another port, run `node app/server.js --port 8766`.

Requires Node.js 18 or later. Run `npm install` in `app/` once (it installs the Anthropic SDK used by the assistant). From `app/`, `npm start` works too. The server listens only on this computer. Profiles are organizational records, not user accounts.

## Use it

- Use the top-bar profile switcher to view a person’s projects, or choose Everyone. Switching profiles opens their projects and clears search/status filters. New ideas default to the selected person.
- Open a project to edit its owner, description, category, progress, material, model link, file references, and print notes.
- Move projects through Idea → Planned → Printing → Done using the Progress field.
- Open Family profiles to rename people, set ages, interests, favorite colors, and profile colors, or add/remove people. Reassign a person's projects before deleting their profile.
- Use New idea to add your own projects; search and status filters help find them.
- Pin projects (the pin on a card or sidebar row, the Pin button on a project, or the right-click menu) to keep them first in the grid and in the sidebar's Pinned section. On a project page the other projects stay in a searchable sidebar: press / to search, ↑/↓ and Enter to move, Esc to clear.
- Right-click a project or print job (or press the Menu key / Shift+F10 on it) for quick actions: open, pin, change progress, queue a print, edit, duplicate, copy link, delete.
- Open any project for its detail page: a progress stepper, print jobs, checklist, notes, model and file references, material cost and a timeline. Duplicate a project to start a variant.
- **Print jobs** holds the queue. Queue a plate with its slicer settings, then Start → Succeeded / Failed, or Reprint. Progress and time left are estimated from the start time and your estimate; no printer is connected.
- **Filament** tracks spools. When a job that uses a spool succeeds or fails, its filament weight is deducted; editing or deleting that job returns it. Editing a spool's weight by hand resets that baseline.
- Press Ctrl+K (⌘K on Mac) to jump to any project, view or action. Press N for a new item on the current page and / to search projects.
- **Printer** shows the live printer once it is connected (see below): progress, layer, time left, temperatures, AMS slots and error codes. A print job linked to the running print shows live progress and closes itself as Succeeded or Failed when the printer finishes, deducting its filament, even if no browser is open. Starting a job while the printer is running links them automatically; so does a print that starts while exactly one job is marked Printing. Add an AMS slot to the filament shelf with one click.
- **✦ Lab assistant** (bottom-right) is Claude with your workspace as context: ask questions and attach photos of prints. The ✦ buttons around the app suggest ideas for a family member, diagnose a failed job (a photo helps), recommend slicer settings (also inside the job form) and tailor a project checklist. Suggestions change nothing until you click to apply them.
- Import restores a JSON backup, replacing everything after confirmation. Backups from older versions are upgraded automatically.
- For children, starter notes include design and adult-supervision considerations. Printed objects have not been safety tested.

## Where everything lives

- `data/family.json`: live profiles, projects, print jobs and spools; created from `seed.json` on first launch.
- `data/family.backup.json`: the state before the most recent successful edit.
- `seed.json`: original starter content, used only if the live data file is absent.
- `../projects/`: place your CAD, model exports, slicer projects, and photos here. The UI stores file references, not uploads.
- Existing Markdown notes remain reference documents; editing them does not update the app, or vice versa.

Writes are atomic, and stale tabs cannot overwrite newer changes. If a save conflicts, keep a copy of your unfinished text, close the form, refresh, and retry.

## Printer link and assistant setup

Both are optional and configured in `app/.env` (copy `app/.env.example`; the file is ignored by Git). Restart the app after editing it; the startup line shows what is connected.

- **Printer:** on the printer, turn on Settings → WLAN/Network → LAN Mode Only, then Developer Mode, and set `BAMBU_HOST`, `BAMBU_SERIAL` and `BAMBU_ACCESS_CODE`. The link is read-only: the app subscribes to the printer's local MQTT reports and never sends commands. LAN-only mode turns off Bambu cloud features such as remote printing from Bambu Handy. Bambu documents Developer Mode for the X1, P1 and A1 series; the report format used here is the community-documented one for those models, and X2D-specific fields have not been verified against real hardware.
- **Assistant:** set `ANTHROPIC_API_KEY` (or sign in with `ant auth login`). It uses `claude-opus-5` with Anthropic's server-side fallback for declined requests; override with `LAB_AI_MODEL`, or set `LAB_AI=off`. Each request sends workspace details (family names and ages, projects, jobs, spools, printer status, and any attached photo) to Anthropic and is billed to that account.

## Printer simulator (until the real printer is set up)

`npm run dev` (from `app/`) starts a simulated Bambu printer and the app together, already connected. Open the app at http://127.0.0.1:8765 and the simulator's control page at http://127.0.0.1:8766 to start, pause, finish or fail prints, raise an alert, change speed (default ×20) or turn on auto-play. The simulator speaks the same local protocol the real printer uses (plain TCP instead of TLS), heats up, prints layer by layer, uses up AMS filament, and fails about 15% of prints so failure handling gets exercised. The app labels it "Simulator" everywhere.

Dev mode uses a separate copy of your workspace, `data/dev.json` (made from `data/family.json` the first time; delete it to start fresh), so simulated prints never change real data. Use `npm run dev -- --real-data` to work on the real file. The simulator also runs alone with `npm run sim` (see `--help` for port, serial, speed and failure-rate options, and type `help` for its commands).

## Backup and restore

Use **Export backup** for a dated JSON copy of the latest records. Also back up the `projects/` folder separately to preserve design files.

To restore, stop the app, keep a copy of the current `data/family.json`, and replace it with an exported JSON backup. Restart the app. The server validates the data on startup; a malformed file is not silently replaced.

Live family data and automatic backups are ignored by Git. No cloud sync, printer connection, or automatic printing is configured. The printer name remains user-reported until confirmed.

## Validation

```sh
cd app && npm install && npm test
```

Tests use temporary data, a fake printer on a local socket and a stub Claude client (no network or API spend). They cover persistence, project/profile changes, stale-write conflicts, invalid records, local-access boundaries, printer report parsing, automatic job linking and closing, and assistant requests, streaming and error handling. They do not modify live family data. The redesigned UI was checked in headless Chrome at desktop and phone widths (layout, dialogs, WebGL scene); it was not tested on physical devices. Optional WebMCP tools are feature-detected; their browser registration has not been verified in a supported context.

## Model references

Two starter projects link to reference designs, with no files copied: [desk cable holder](https://makerworld.com/en/models/1400922-desk-cable-management-holder) and [desk organizer](https://makerworld.com/en/models/1153572). Check dimensions, license, and printer compatibility before using a model. Other starter ideas are original prompts to personalize or find a suitable design for.
