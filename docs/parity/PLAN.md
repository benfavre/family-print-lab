# Parity plan: Family Print Lab + Print Lab Cloud beyond Bambu Handy and Bambu Studio

This is the master plan for the "parity" programme. Several agents implement it in parallel, each in
its own git worktree, and a merger brings their work together. Every interface below is a contract:
code against it exactly. If you must deviate, do the smallest thing that works, keep the contract's
shape where you can, and explain the deviation in your final report (section "Deviations").

- Repos: Family Print Lab (FPL, AGPL-3.0-or-later) at `/home/wd29-pc/dev/family-print-lab`, branch
  `parity`. Print Lab Cloud (PLC, proprietary) at `/home/wd29-pc/dev/printlab-cloud`, branch `parity`.
- The user asked for the slicer to stay modular so our Bambu Studio fork is easy to keep up to date.
  Section 5.6 turns that into hard requirements (our code outside the upstream tree, a small patch
  queue, one facade, scripted rebase, golden tests, an automated update workflow).
- Order: **Foundation** (one agent) → merge → **Wave 1** (16 packages in parallel) → merge → **Wave 2**
  (5 packages in parallel) → merge.
- Branches: `parity-foundation`, then `parity-<key>` (for example `parity-hms`) created from `parity`
  after the foundation is merged. Suggested worktree path: `/home/wd29-pc/dev/fpl-wt/<key>` (and
  `/home/wd29-pc/dev/plc-wt/<key>` for PLC). Never push, never commit to `main`.

Contents

1. Ground rules (recap)
2. Where we start: what exists, and defects found while studying it
3. Target architecture
4. FOUNDATION specification (1a–1f)
5. Wave 1 work packages
6. Wave 2 work packages
7. Merge and conflict guidance
8. Appendix: verified protocol facts and sources

---

## 1. Ground rules (recap)

These restate the programme rules so the plan is self-contained. The task text you were given wins
if it is stricter.

- Node: start every shell command that runs node tooling with
  `source ~/.nvm/nvm.sh && nvm use 24 >/dev/null`.
- **bun only.** `bun install`, `bun run check`, `bunx vitest --run [files]`, `bunx prettier --write <files>`,
  `bunx eslint <files>`. Never npm/pnpm/yarn. Avoid new dependencies; prefer `node:tls`, `node:net`,
  `node:dgram`, `node:child_process` and the system `ffmpeg` at `/usr/bin/ffmpeg`. If one is
  unavoidable: `bun add`, never edit `package-lock.json`, list it in your report. `bun.lock` stays
  uncommitted. (Existing CI and desktop scripts still call npm; do not rewrite them unless your package
  says so.)
- Match the codebase: Svelte 5 runes, the existing component and CSS patterns (`panel`, `panel-head`,
  `panel-title`, `section-meta`, `int-section`…), comment density, plain short sentence-case UI copy
  in British spelling ("colour", "centre", "licence" as a noun).
- **Protocol accuracy first.** Never guess an MQTT payload, camera protocol or HMS format. Verify
  against OpenBambuAPI, ha-bambulab, Bambu Studio source or the Bambu wiki, and cite the source in a
  one-line comment next to the code (URL, plus file path for repos). Local clones:
  `/tmp/claude-1000/-home-wd29-pc-dev/83e6fd4a-d275-4c10-8a81-cfca49daeb99/scratchpad/refs/<name>`
  (OpenBambuAPI at `cc383a2`, ha-bambulab at `0e027ff` are already there; clone others shallowly
  beside them after checking they are not there yet).
- No real printer exists here. Everything must work against the simulator and be exercised by
  `bun run dev:sim` and tests. Never claim real-printer verification; say "verified against
  <source> and the simulator".
- Control needs Developer Mode on the printer. Never implement Bambu's non-Developer-Mode MQTT
  signing/field encryption, never use keys or certificates extracted from Bambu software, and never
  load Bambu's proprietary `bambu_networking` plugin. When `fun` says signing is required, say so
  plainly and keep the app read-only for that printer.
- A Bambu Studio sparse clone at the pinned tag (`v02.08.02.61`) is at `refs/BambuStudio` next to the
  other references (device code under `src/slic3r/GUI/DeviceCore/` and `DeviceManager.cpp`,
  `resources/printers`, `resources/hms`); add paths with `git sparse-checkout add` rather than
  re-cloning. Line numbers cited in this plan refer to that tag.
- Privacy: nothing leaves the machine unless the user opts in. Keep the `127.0.0.1` default.
- DB migrations: hand-written SQL `app/drizzle/NNNN_<name>.sql`, an entry in
  `app/drizzle/meta/_journal.json`, and the matching `schema.ts`/`db/tables/*.ts` change. Use the
  migration slot reserved for your package in section 7.3 (the merger renumbers only on collision).
- Quality bar: `bun run check` with 0 errors and 0 warnings, all vitest tests pass, new logic has
  unit tests, prettier and eslint clean on every file you touched.
- Commits: repo style "Area: what it does, in plain words", message ends with a blank line then
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Final report (your return value): what you built, files, tests run and their result, anything not
  finished with exact next steps, dependencies added, migration numbers used, deviations.

---

## 2. Where we start

### 2.1 What exists (as of `f4fc747` on `parity`)

- `app/src/lib/server/printer/bambu.ts`: `BambuPrinter` (one printer, from `BAMBU_*` env via
  `printerFromEnv`), MQTT over TLS to `device/<serial>/report|request`, `summarize()` into
  `PrinterSnapshot`, commands `project_file`/`pause`/`resume`/`stop` with reply matching, FTPS upload.
- `mqtt.ts`: hand-written MQTT 3.1.1 client/codec, QoS 0 only. `ftp.ts`: implicit-FTPS upload with TLS
  session reuse (upload only). `ftp-server.ts`: plain FTP server for the simulator.
- `simulator.ts`: one simulated printer (serial `SIM-X2D-0001`, X2D only), MQTT + FTP, prints with
  heating/layers/AMS/fail/alert, answers commands like firmware. `tools/printer-sim.ts` (CLI + control
  page on :8766), `tools/dev-sim.ts` (sim + `vite dev` on a separate DB `data/dev-sim.db`).
- `sliced.ts`: reads `.gcode.3mf` (plates, time, grams, filaments, thumbnails) and `PRINTER_MODEL_IDS`;
  `fakeSliced()` for tests.
- `slicer.ts`: slicing via the stock Bambu Studio CLI, flattening `resources/profiles/BBL` inheritance,
  **hard-coded to the X2D** (`Bambu Lab X2D <nozzle> nozzle`, model id `N6`).
- `printing.ts`: `PrintFiles` (attach sliced file, check, send = upload + `project_file`, one send at a
  time), with an `N6` hard-code in `check()`.
- `lab.ts`: `Lab` domain service (transactional writes, `events` 'change', `linkStartedTask(task)`,
  `closePrinterTask(task, ok)` linking the printer's task name to a `Printing` job).
- `runtime.ts`: boots DB, Lab, models, tasks, backups, **one** printer, printing, AI, cloud link;
  `printerStatus()`.
- Routes: `/api/printer` (status), `/api/printer/control` (pause/resume/stop), `/api/jobs/[id]/send`,
  `/api/events` (SSE: `hello`, `change`, `printer` throttled 750 ms, `task`, `cloud`). Pages:
  `/printer`, `/jobs`, `/filament`, `/family`, `/integrations` (Settings redirects here), `/shop`,
  `/kid/*`. Nav in `app/src/lib/client/nav.ts`. Live client state in `LabStore`
  (`app/src/lib/client/app.svelte.ts`, `printer = $state<PrinterStatus>`).
- DB (`app/src/lib/server/db/schema.ts`): profiles, projects, checklist_items, spools, jobs, models,
  model_versions, activity, meta, sketches, print_requests. Migrations 0000–0004 (the last `when` is
  `1790363534567`).
- Cloud link (`cloud/link.ts`, protocol v1 in `docs/cloud-protocol.md`): outbound WebSocket, request
  list, optional `PrinterSummary` of the single printer, `decide` command, E2E backups (`vault.ts`).
- PLC: Worker + Durable Object `Household` per account (`src/household.ts`), D1 table `printers` keyed
  by `device_id` (one printer per linked computer), phone PWA `/requests` (`src/phone.ts`,
  `public/js/phone.js`), content-free Web Push (`src/push.ts`), plan gating `hasFamilyPlan`.
- Desktop: Electron `desktop/main.cjs` imports the server build in the main process with
  `cwd = desktop/server`; `desktop/scripts/prepare-server.mjs` copies `build/`, `drizzle/`,
  `resources/`; releases via `.github/workflows/release.yml`.

### 2.2 Defects and gaps found (the foundation fixes all of these)

1. `merge()` in `bambu.ts` replaces arrays wholesale. P1/A1 send deltas; ha-bambulab merges AMS units
   and trays **by `id`** (`pybambu/models.py` `AMSList.print_update`), so a partial tray update can wipe
   the other trays here. Arrays keyed by `id` (or `node`) must merge per element.
2. AMS HT units have ids 128–135 and `tray_now` ≥ 128 (ha-bambulab `AMSList.print_update`); `summarize()`
   computes `unit*4+tray` for everything and `ams_mapping2` only special-cases `>= 254`.
3. Only `print`-topic replies are read. `info` (get_version), `system` (ledctrl, accessories), `camera`,
   `xcam`, `upgrade` and `mc_print` (push_info) messages are dropped.
4. QoS 0 only. OpenBambuAPI `mqtt.md` says `stop`/`pause`/`resume` are sent with QoS 1.
5. `project_file` always uses `url: ftp:///<file>`. ha-bambulab `const.py` `LEGACY_SDCARD_PRINTERS` says
   X1/X1C/X1E/P1P/P1S/A1/A1 mini use `file:///sdcard/<file>`; newer models use `ftp:///<file>`.
6. Stopping a print is recorded as a failed print. Firmware reports `FAILED` with print error
   `0300400C` "The task was canceled." (Bambu HMS data, `device_error`); that must become
   `Cancelled`.
7. X2D hard-codes: `printing.ts` (`N6` check), `simulator.ts` (rejects non-`N6` files),
   `slicer.ts` (machine name, model id), `printerFromEnv` default name, printer page copy.
8. New-firmware telemetry is ignored: `device.bed.info.temp`, `device.ctc.info.temp`,
   `device.extruder.info[]` (low 16 bits current, high 16 bits target; `snow` = active tray per
   nozzle), `device.nozzle.info[]`, `device.airduct`, `vir_slot` (ha-bambulab `Temperature`, `AMSList`,
   `Fans`, `ExternalSpool`). The second nozzle of H2D/X2D is invisible.
9. `fun` bit `0x20000000` (MQTT signature required, i.e. Developer Mode off; ha-bambulab `const.py`
   `Print_Fun_Values`) is not surfaced, so commands silently do nothing when Developer Mode is off.
10. No capability knowledge per model, no multi-printer, no discovery, no event bus, no typed commands.
11. **TLS is not verified at all** (`bambu.ts` sets `rejectUnauthorized: false` and a no-op
    `checkServerIdentity`; same in `ftp.ts`). Anyone on the LAN who answers on the printer's IP
    receives the access code. Printers present a leaf `CN=<serial>` issued by a Bambu device CA, expect SNI =
    serial, and have no IP SAN (OpenBambuAPI `tls.md`; ClusterM open-bamboo-networking
    `research/10.06-lan-tls-and-access-codes.md`). The foundation fixes this (4.2.3 "TLS policy").
12. Node offers TLS 1.3 by default. ha-bambulab caps printer TLS at 1.2 because "P2S firmware
    01.02.00.00 never responds to a TLS 1.3 ClientHello" (`pybambu/bambu_client.py`
    `create_local_ssl_context`), so a P2S would hang on connect here.
13. `fun` (and `fun2`, `cfg`, `aux`, `stat`) are hex strings of up to 64 bits or more
    (`MOCK-X2D.json` `fun` = `40029FD1B30F9CB7`). Bambu Studio reads feature bits well above bit 32
    from them (`DeviceManager.cpp` ~4430–4500: bit 39 MQTT bed temperature, 49 part skip, 60 nozzle
    rack…). They must be parsed with `BigInt('0x' + s)`, never `parseInt`/`Number`.
14. Cancelled prints can also end with print error `0500400E` "Printing was cancelled." (Bambu
    Studio `resources/hms/hms_en_094.json` `device_error`), not only `0300400C`.

### 2.3 Feature coverage against Bambu Handy and Bambu Studio

So nothing falls between packages. "Out" means deliberately not in this programme.

| Bambu feature                                                                                        | Where it lands                                                                       |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Handy: live camera at home / away                                                                    | camera (LAN) / cloud-remote (E2E-sealed low-rate live view)                          |
| Handy: timelapses and recordings                                                                     | camera                                                                               |
| Handy: pause/resume/stop, speed, lights, temperatures, fans, airduct, jog, home                      | controls (+ cloud-remote for pause/resume/stop away from home)                       |
| Handy: HMS alerts with pictures and action buttons                                                   | hms (Bambu Studio `resources/hms/local_image` pictures included)                     |
| Handy: push notifications (finished, failed, paused, HMS)                                            | notifications (local channels) + cloud-remote (content-free Web Push)                |
| Handy: AMS view, tray settings, RFID re-read, drying, filament inventory                             | ams                                                                                  |
| Handy: skip objects                                                                                  | controls                                                                             |
| Handy: several printers, device list                                                                 | foundation (registry, `/printers`)                                                   |
| Handy: start a print from the phone                                                                  | cloud-remote (optional "Start next queued job", parent-authorised)                   |
| Handy/Studio: firmware update                                                                        | maintenance shows versions and "update available" only. Out: flashing                |
| Studio device tab: print files already on the printer's storage                                      | camera (files page, stretch: "Print again" via a `print.project_file:storage` def)   |
| Studio device tab: flow dynamics (PA) calibration, K-value profiles per filament (`extrusion_cali*`) | slicer-calibration (wave 2)                                                          |
| Studio device tab: nozzle type/diameter, H2C hotend rack                                             | maintenance (records, `system.set_accessories`), status (read-only rack info)        |
| Studio: send to several printers, print queue                                                        | queue                                                                                |
| Studio: slicing, plates, painting, modifiers, variable layer height, preview                         | slicer-engine, slicer-3mf, slicer-profiles, gcode-preview, slicer-ui                 |
| Studio: cut, text/emboss, measure, simplify, mesh boolean, assembly view                             | Out for this programme (slicer-ui lists them as follow-ups; `Part.text` round-trips) |
| Studio: calibration generators (Orca's menu)                                                         | slicer-calibration                                                                   |
| Studio: MakerWorld integration                                                                       | model-import (metadata + manual download only)                                       |
| Bambu cloud printing, TUTK/Agora remote video, non-Developer-Mode signing                            | Out (proprietary; our remote path is Print Lab Cloud with E2E sealing)               |

---

## 3. Target architecture

```
                        ┌──────────────────────── app (SvelteKit, one Node process) ─────────────────────────┐
 Bambu printers         │ server                                                                              │
 (LAN, MQTT 8883,       │  printer/manager.ts  PrinterManager ── BambuPrinter × N ── mqtt.ts / ftp.ts          │
  FTPS 990, cam 322/    │        │  status diff                    │ send(command)                            │
  6000, SSDP UDP 2021)  │        ▼                                 ▼                                          │
        ▲               │  events.ts  EventBus ◄──────── printer/commands/* (typed, cited, capability-gated)    │
        │               │     │  typed events: print.*, hms.*, ams.*, printer.*, queue.*, request.* …          │
        │               │     ├─► modules/hms  modules/notifications  modules/queue  modules/home-automation … │
        │               │     └─► cloud/link.ts (opt-in)                                                     │
        │               │  modules.ts  (import.meta.glob of modules/*/module.ts; ModuleContext; services)    │
        │               │  slicer/engine.ts ── stdio JSON-RPC ── printlab-slicer (C++, libslic3r facade)     │
        │               │                   └─ CLI backend (stock Bambu Studio / OrcaSlicer)                 │
        │               │  db (drizzle + better-sqlite3): tables split per area in db/tables/*.ts            │
        │               │ client                                                                              │
        │               │  LabStore (printers by id, live channels)  registry.ts (nav, panels, sections…)   │
        └───────────────┤  pages render registry slots; packages add files, not edits                       │
                        └─────────────────────────────────────────────────────────────────────────────────────┘
```

Principles:

- **Additive packages.** The foundation creates registries (server modules, UI slots, commands, events,
  simulator features, DB table files, hooks) so wave packages add new files and at most one line in a
  list file. Section 7 lists every hot spot and its rule.
- **One printer abstraction.** `BambuPrinter` stays the per-printer connection (renamed concept:
  "connection"); `PrinterManager` owns N of them. `rt.printer` remains as a deprecated alias to the
  primary printer so old call sites keep compiling during the transition; the foundation migrates all
  existing call sites anyway.
- **Everything typed and cited.** Status fields, commands and capabilities cite their source.

---

## 4. FOUNDATION specification

One agent builds all of this on `parity-foundation` before any wave-1 work starts. It is large; do it
in this order and commit per step: (1) catalogue + status types + parsing + fixtures/conformance tests,
(2) command layer + mqtt QoS 1 + TLS policy, (3) DB + PrinterManager + discovery + simulator fleet, (4)
routes + UI and jobs, (5) event bus and registries + test harness, (6) slicer contracts + upstream lock
helper.

**Minimum before wave 1 starts.** Wave packages code against contracts, not polish. These must be
merged before wave 1: everything in 4.1–4.6 that is a type, registry, interface or route listed in
4.2.6; the simulator fleet and `sim/features`; the DB split and migration 0005; the test harness
(4.6.6); the slicer contract files (4.7) and `slicer/upstream.lock` + `app/tools/lib/upstream.ts`.
These may land as follow-up commits on `parity` while wave 1 runs (list them in the report): drag
reordering and discovery UI in Settings, the diagnostics download, the `PrinterChip` multi-printer
menu, the printer switcher tabs, and `gen-printer-models.ts` downloading from GitHub (reading a local
checkout is enough at first).

### 4.0 Foundation file map

New files (the foundation owns them; wave packages extend only through the documented mechanisms):

```
app/src/lib/shared/printers/models.generated.ts   generated capability data from Bambu Studio resources/printers/*.json
app/src/lib/shared/printers/models.ts             model catalogue + helpers (hand-written layer)
app/src/lib/shared/printers/status.ts             PrinterSnapshot / PrinterStatus / sub-types
app/src/lib/shared/printers/stages.ts             stage id → name table
app/src/lib/shared/printers/info.ts               PrinterInfo (registry row as the client sees it), DiscoveredPrinter
app/src/lib/server/printer/report.ts              mergeReport(), parseReport() (moved out of bambu.ts; pure)
app/src/lib/server/printer/flags.ts               hexFlag(str, bit, count) over BigInt; fun/fun2/cfg/aux/stat decoders (pure)
app/src/lib/server/printer/tls.ts                 printerTlsOptions(serial, pin) + verifyPrinterCert(); used by MQTT, FTPS, camera
app/src/lib/server/printer/certs/*.pem            Bambu printer CA certificates (from ha-bambulab pybambu/certs, MIT; README with source)
app/src/lib/server/testing/harness.ts             startTestLab(): in-memory DB + runtime + simulated fleet for integration tests
app/tools/lib/upstream.ts                         readUpstreamLock(), upstreamFile(path): the one pinned Bambu Studio source for all generators
slicer/upstream.lock                              created by the foundation (format in 5.6); slicer-engine owns it afterwards
app/src/lib/server/printer/manager.ts             PrinterManager
app/src/lib/server/printer/discovery.ts           SSDP listener (UDP 2021)
app/src/lib/server/printer/diff.ts                diffStatus(prev, next) → LabEvent[] (pure)
app/src/lib/server/printer/commands/registry.ts   CommandMap, defineCommand, registry (glob of defs/*.ts)
app/src/lib/server/printer/commands/defs/core.ts  pushall, get_version, project_file, pause, resume, stop, gcode_line
app/src/lib/server/printer/sim/                   simulator split: core.ts, fleet.ts, states/<code>.json, features/index.ts
app/src/lib/server/printer/__fixtures__/reports/  conformance fixtures + README.md (sources, licences)
app/src/lib/server/printer/conformance.test.ts    fixture-driven tests
app/src/lib/server/events.ts                      EventBus + LabEventMap
app/src/lib/server/modules.ts                     server module registry (defineModule, ModuleContext)
app/src/lib/server/modules/contracts.ts           service interfaces packages implement (CameraService…)
app/src/lib/server/module-settings.ts             per-module settings stored in meta
app/src/lib/server/hooks/index.ts                 SvelteKit handle chain (HANDLES list)
app/src/lib/server/db/tables/*.ts                 schema split (core.ts holds today's tables; printers.ts new)
app/src/lib/client/registry.ts                    UI registry (glob of client/modules/*/ui.ts)
app/src/lib/client/live.ts                        live channel subscription helper
app/src/lib/shared/slicer/protocol.ts             Slicer Engine Protocol types (1e)
app/src/lib/shared/slicer/project.ts              Scene/Project model (1e)
app/src/lib/shared/slicer/preview.ts              preview format types + encode/decode (1e)
app/src/lib/shared/slicer/profiles.ts             profile resolution API types (1e)
app/src/lib/server/slicer/locate.ts               engine / CLI location (1e)
app/src/lib/server/slicer/engine.ts               SlicerEngine interface + openSlicer() stub (1e)
app/tools/gen-printer-models.ts                   regenerates models.generated.ts from a Bambu Studio checkout or GitHub at the pinned tag
app/src/routes/printers/+page.svelte              printers overview
app/src/routes/printers/[id]/+page.svelte         printer detail (the old /printer page, printer-aware, with slots)
app/src/routes/api/printers/…                     see 4.2.6
app/src/lib/components/printers/*                 PrintersSection (settings), PrinterForm, PrinterCard, PrinterPicker, AmsView
```

Existing files the foundation edits: `bambu.ts`, `mqtt.ts`, `simulator.ts` (becomes a thin re-export of
`sim/`), `sliced.ts` (`PRINTER_MODEL_IDS` → catalogue), `printing.ts`, `slicer.ts` (model parameter only),
`lab.ts`, `runtime.ts`, `db/schema.ts`, `domain.ts` (re-exports), `validation.ts`, `integrations.ts`,
`cloud/link.ts` (primary-printer adapter), `ai/assistant.ts` + `routes/api/ai/[task]/+server.ts`
(all printers), `hooks.server.ts`, `kid/session.ts` (registry-driven reads), `routes/api/events`,
`routes/+layout.server.ts`, `routes/+layout.svelte`, `routes/printer/+page.svelte` (redirect),
`routes/integrations/+page.svelte` (slots), `routes/jobs`, `routes/family/+page.svelte` (slot host),
`lib/client/app.svelte.ts`, `nav.ts`, `actions.ts`, `format.ts`, components `PrinterChip`, `SendPanel`,
`JobCard`, `JobForm`, `SpoolForm`, `TopBar`, `BottomNav`, `TempChart`, `tools/dev-sim.ts`,
`tools/printer-sim.ts`, `playwright.config.ts` (fleet flag), `.env.example`, e2e specs that reference
`/printer`, `ftp.ts` (TLS options only: `printerTlsOptions`; camera owns it afterwards), `app/.gitignore`
and the root `.gitignore` (every ignore line the programme needs, added once here so wave packages do
not edit them: `app/resources/bambu/`, `slicer/.upstream/`, `slicer/.build/`, `slicer/dist/`,
`desktop/server/engine/`).

### 4.1 Printer model catalogue and capabilities (1a, 1c)

**Source of truth.** Bambu Studio ships per-model capability files `resources/printers/<model_id>.json`
(verified at tag `v02.08.02.61`: `BL-P001 BL-P002 C11 C12 C13 N1 N2S N6 N7 N9 O1C O1C2 O1D O1E O1S`).
Each file is keyed by firmware version (`"00.00.00.00"` base plus later keys such as C11's
`01.02.99.00`), with `print.support_*` flags, `print.ipcam.liveview` (`local: "local"` on C11, C12, N1,
N2S, N9 = the port-6000 JPEG stream; BL-P001/BL-P002/C13/N6/N7/O1* list only `remote: "tutk"` for
liveview and expose local RTSP(S) through the `ipcam.rtsp_url` report field; `ipcam.file.local` on
N6/N7/O1* is the port-6000 file tunnel, not a camera), `ftp_folder`, `nozzle_temp_range`,
`bed_temperature_limit`, `fan`, `support_chamber_temp_edit_range`.

Caution: Bambu Studio itself reads **only the `00.00.00.00` block** at this tag (`DevConfigUtil.h/.cpp`
always index `jj["00.00.00.00"]`; `MachineObject::parse_version_func()` is empty). So the later keys are
unverified as to merge semantics: the generator records them in `firmwareCaps` (deep-merge, as the
files suggest), but runtime evidence wins: feature bits the printer reports in `fun`/`fun2` (4.3.2
`firmwareSupport`) and ha-bambulab's firmware gates (`pybambu/models.py` `supports_feature`) override
the file for the fields they cover. Record for each capability which source decided it (comment next
to the field).

`app/tools/gen-printer-models.ts` (run with `bunx tsx app/tools/gen-printer-models.ts [--from <dir>]`)
reads those files from `slicer/.upstream/resources/printers` when present, else downloads them from
`https://raw.githubusercontent.com/bambulab/BambuStudio/<tag>/resources/printers/<code>.json` with the
tag from `slicer/upstream.lock` (default `v02.08.02.61` until slicer-engine creates the lock), and writes
`models.generated.ts` (committed; header says tag, commit `926a7192574bcb9b3a732e1ec59a46d79cb45466`,
licence AGPL-3.0 of Bambu Studio, generated, do not edit). It reads the lock and files only through
`app/tools/lib/upstream.ts` (4.0), the same helper hms and slicer-profiles use, so one pin moves all
upstream-derived data together. When upstream has a model code that `MODEL_CODES` lacks, the
generator prints it and exits non-zero with `--strict` (the slicer update workflow in 5.6 runs it that
way), so a new Bambu printer is noticed, not silently dropped.

```ts
// app/src/lib/shared/printers/models.ts
export const MODEL_CODES = [
	'BL-P001',
	'BL-P002',
	'C13',
	'C11',
	'C12',
	'N1',
	'N2S',
	'N9',
	'N7',
	'N6',
	'O1D',
	'O1E',
	'O1S',
	'O1C',
	'O1C2'
] as const;
export type ModelCode = (typeof MODEL_CODES)[number];
export type Series = 'X1' | 'P1' | 'A1' | 'A2' | 'P2' | 'H2' | 'X2';
/**
 * How the live camera is reached on the LAN (see 8.4). The catalogue gives the default; the live
 * report decides (`ipcam.rtsp_url`: "rtsps://…" → rtsps, "rtsp://…" → rtsp on port 554, "disable" →
 * off until the user enables LAN liveview), as Bambu Studio DeviceManager.cpp ~3450 does.
 */
export type CameraProtocol = 'rtsps' | 'rtsp' | 'jpeg6000' | 'none';

export interface Capabilities {
	chamberTempDisplay: boolean; // support_chamber_temp_display, or chamber_temper reported (X1)
	chamberTempEdit: boolean; // support_chamber_temp_edit
	auxFan: boolean; // support_aux_fan
	chamberFan: boolean; // support_chamber_fan
	secondaryAuxFan: boolean; // ha-bambulab Features.SECONDARY_AUX_FAN (P2S, X2D)
	airductMode: boolean; // ha-bambulab Features.AIRDUCT_MODE (H2, P2S, X2D)
	lidar: boolean; // support_lidar_calibration
	aiMonitoring: boolean; // support_ai_monitoring
	firstLayerInspect: boolean; // support_first_layer_inspect
	buildPlateMarkerDetect: boolean;
	amsHumidity: boolean; // support_ams_humidity
	amsDrying: boolean; // ha-bambulab Features.AMS_DRYING (per-model firmware gates)
	amsDryingSettings: boolean; // ha-bambulab Features.AMS_DRYING_SETTINGS
	amsSwitchCommand: boolean; // support_command_ams_switch
	amsReadRfid: boolean; // ha-bambulab Features.AMS_READ_RFID_COMMAND
	dualNozzle: boolean; // ha-bambulab dual_nozzle_printers (H2C, H2D, H2D Pro, X2D)
	extruderTool: boolean; // ha-bambulab Features.EXTRUDER_TOOL (H2 laser/cutter head)
	workLight: boolean; // lights_report "work_light" (X1 series)
	chamberLight2: boolean; // ha-bambulab Features.CHAMBER_LIGHT_2 (H2, X2)
	heatbedLight: boolean; // ha-bambulab Features.HEATBED_LIGHT (H2)
	doorSensor: boolean; // ha-bambulab Features.DOOR_SENSOR (with firmware gates)
	promptSound: boolean; // support_prompt_sound
	timelapse: boolean; // support_timelapse
	sendToSd: boolean; // support_send_to_sd
	printWithoutSd: boolean; // support_print_without_sd
	motorNoiseCali: boolean; // support_motor_noise_cali
	flowCalibration: boolean; // support_flow_calibration
	autoFlowCalibration: boolean; // support_auto_flow_calibration
	nozzleOffsetCalibration: boolean; // support_nozzle_offset_calibration
	bedLeveling: boolean; // support_bed_leveling > 0
	userPreset: boolean; // support_user_preset
	kValueInReport: boolean; // ha-bambulab Features.K_VALUE (A1, A2, P1)
	activeChamberHeater: boolean; // ha-bambulab Features.ACTIVE_CHAMBER_HEATER (X1E, H2, X2)
	fireAlarmBuzzer: boolean; // ha-bambulab Features.FIRE_ALARM_BUZZER (H2); buzzer_ctrl
	hotendRack: boolean; // ha-bambulab Features.HOTEND_RACK (H2C with a rack reported); also fun bit 60
	/** P1 firmware ≥ 01.07.00.00 ignores LAN commands while also cloud-connected (ha-bambulab Features.HYBRID_MODE_BLOCKS_CONTROL): warn, do not block. */
	hybridModeBlocksControl: boolean;
	/** Firmware where Developer Mode is required for LAN control (ha-bambulab Features.MQTT_ENCRYPTION_FIRMWARE): drives the setup help text. */
	developerModeRequired: boolean;
}

export interface PrinterModel {
	code: ModelCode;
	/** Bambu Studio machine model name, e.g. "Bambu Lab X1 Carbon" (also the profile machine_model name). */
	name: string;
	short: string; // "X1C", "P1S", "A1 mini", "H2D", "X2D"…
	series: Series;
	/** Serial-number prefix Bambu's HMS data uses for this model ("00M", "094"…), null when unknown. */
	hmsDevice: string | null;
	/** X1 series send full push_status; others send deltas (OpenBambuAPI mqtt.md "push_status"). */
	reports: 'full' | 'delta';
	camera: CameraProtocol;
	nozzles: 1 | 2;
	/** project_file url form: 'sdcard' → file:///sdcard/<name>, 'ftp' → ftp:///<name> (ha-bambulab const.py). */
	printUrl: 'sdcard' | 'ftp';
	enclosed: boolean; // printer_is_enclosed
	nozzleTempMax: number; // nozzle_temp_range[1] / nozzle_max_temperature
	bedTempMax: number; // bed_temperature_limit / bed_temp_range
	chamberTempMax: number | null; // support_chamber_temp_edit_range[1]
	caps: Capabilities; // at firmware 00.00.00.00
	/** Version-gated overrides, ascending by firmware version (from the per-version keys). */
	firmwareCaps: { from: string; caps: Partial<Capabilities> }[];
}

export const PRINTER_MODELS: Record<ModelCode, PrinterModel>;
export function modelByCode(code: string): PrinterModel | null;
/**
 * Model from SSDP DevModel, get_version product_name, or the older AP/project_name heuristics
 * (ha-bambulab utils.get_printer_type). product_name is not the machine name: the X1C reports
 * "Bambu Lab X1-Carbon" (MOCK-X1CMULTIAMS.json), so match on ha-bambulab's table, not on `name`.
 * The H2C pair O1C/O1C2 cannot be told apart from product_name: prefer SSDP DevModel, else O1C2.
 */
export function detectModel(input: {
	ssdpModel?: string;
	productName?: string;
	modules?: VersionModule[];
}): ModelCode | null;
/** Capabilities for a model at a firmware version (base + every firmwareCaps entry whose `from` ≤ version). */
export function capabilitiesFor(code: ModelCode, firmware: string | null): Capabilities;
/** Compare "01.07.50.18"-style versions. */
export function compareFirmware(a: string, b: string): number;
```

Verified model table (section 8.1 has sources). Fill the hand-written fields from it:

| code      | name                | short   | series | hmsDevice     | camera   | nozzles | printUrl |
| --------- | ------------------- | ------- | ------ | ------------- | -------- | ------- | -------- |
| BL-P001   | Bambu Lab X1 Carbon | X1C     | X1     | 00M           | rtsps    | 1       | sdcard   |
| BL-P002   | Bambu Lab X1        | X1      | X1     | 00M           | rtsps    | 1       | sdcard   |
| C13       | Bambu Lab X1E       | X1E     | X1     | 03W           | rtsps    | 1       | sdcard   |
| C11       | Bambu Lab P1P       | P1P     | P1     | 01S           | jpeg6000 | 1       | sdcard   |
| C12       | Bambu Lab P1S       | P1S     | P1     | 01P           | jpeg6000 | 1       | sdcard   |
| N1        | Bambu Lab A1 mini   | A1 mini | A1     | 030           | jpeg6000 | 1       | sdcard   |
| N2S       | Bambu Lab A1        | A1      | A1     | 039           | jpeg6000 | 1       | sdcard   |
| N9        | Bambu Lab A2L       | A2L     | A2     | null (verify) | jpeg6000 | 1       | ftp      |
| N7        | Bambu Lab P2S       | P2S     | P2     | 22E           | rtsps    | 1       | ftp      |
| N6        | Bambu Lab X2D       | X2D     | X2     | null (verify) | rtsps    | 2       | ftp      |
| O1D       | Bambu Lab H2D       | H2D     | H2     | 094           | rtsps    | 2       | ftp      |
| O1E       | Bambu Lab H2D Pro   | H2D Pro | H2     | null (verify) | rtsps    | 2       | ftp      |
| O1S       | Bambu Lab H2S       | H2S     | H2     | 093           | rtsps    | 1       | ftp      |
| O1C, O1C2 | Bambu Lab H2C       | H2C     | H2     | null (verify) | rtsps    | 2       | ftp      |

"null (verify)": Bambu Studio's `resources/hms/` also has files for device prefixes `239`, `20P`, `26A`,
`31B`; the hms package maps them to models (from the wiki or Bambu Studio source) and fills these in.

`camera` is the default before the first report. Per the ha-bambulab mocks, LAN liveview is **off by
default** (`ipcam.rtsp_url = "disable"`) on P2S, X2D and H2C as well as H2S/H2D, so every `rtsps` model
needs the "LAN Only Liveview" help text, not only the H2 series.

`reports`: `'full'` for BL-P001, BL-P002, C13; `'delta'` for all others. The merge in 4.3 is correct for
both; the flag only controls how often a `pushall` is allowed (never more than once per 5 minutes on
`'delta'` models: OpenBambuAPI mqtt.md, "pushing.pushall" caution).

### 4.2 Multi-printer registry (1a)

#### 4.2.1 Table and migration

Migration `app/drizzle/0005_printers.sql`, journal entry `{ idx: 5, version: "6", when: 1790400300000,
tag: "0005_printers", breakpoints: true }`.

```sql
CREATE TABLE `printers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`model` text NOT NULL,
	`host` text NOT NULL,
	`serial` text NOT NULL,
	`access_code` text NOT NULL,
	`port` integer DEFAULT 8883 NOT NULL,
	`ftp_port` integer DEFAULT 990 NOT NULL,
	`tls` integer DEFAULT true NOT NULL,
	`simulated` integer DEFAULT false NOT NULL,
	`tls_pin` text,
	`enabled` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `printers_serial` ON `printers` (`serial`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `printer_id` text REFERENCES printers(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `jobs` ADD `dispatch` text;--> statement-breakpoint
CREATE INDEX `jobs_printer` ON `jobs` (`printer_id`);
```

Schema split: move every current table from `db/schema.ts` into `db/tables/core.ts` unchanged, add
`db/tables/printers.ts`, and make `db/schema.ts` exactly:

```ts
// Tables live in db/tables/, one file per area; add one `export *` line for a new file.
export * from './tables/core';
export * from './tables/printers';
```

`jobs` gains `printerId: text('printer_id').references(() => printers.id, { onDelete: 'set null' })`
and `dispatch: text('dispatch', { mode: 'json' }).$type<JobDispatch>()`:

```ts
// app/src/lib/shared/domain.ts
/** What was sent to a printer for this job (set when it is sent; read by AMS usage accounting). */
export interface JobDispatch {
	printerId: string;
	plate: number;
	useAms: boolean;
	/** Global tray per filament in the file, as sent (see 8.3 for the numbering). */
	amsMapping: number[];
	remoteName: string;
	at: string;
}
// Job gains: printerId: string | null; dispatch: JobDispatch | null;
```

**Env import (the "migration" of the current printer).** SQL cannot read env, so it runs at boot in
`PrinterManager.start()`:

1. If `meta['printers_env_imported']` is unset and `BAMBU_HOST`, `BAMBU_SERIAL`, `BAMBU_ACCESS_CODE`
   are all set (from `.env` or the desktop's `printlab.env`, which main.cjs loads into `process.env`):
   insert one row (`name` = `BAMBU_NAME` or the model's name; `model` = `BAMBU_MODEL` if it is a valid
   code, else `detectModel({ productName: BAMBU_NAME })`, else `'N6'` because the app has only ever
   targeted the X2D; `port` `BAMBU_PORT`||8883; `ftp_port` `BAMBU_FTP_PORT`||990; `tls` `BAMBU_TLS !== 'off'`;
   `simulated` `BAMBU_SIMULATED === '1'`; `sort_order` 0), unless a row with that serial exists. Set
   the meta flag either way. After that the Settings UI is the source of truth; deleting the printer
   does not bring it back.
2. `PRINTLAB_PRINTERS` (JSON array of `{ name, model, host, port?, ftpPort?, serial, accessCode, tls?,
simulated? }`): upserted by serial on **every** boot. Used by `dev:sim` and e2e for fleets; not
   documented for end users beyond `.env.example`.
3. Existing `Printing` jobs keep `printer_id = NULL`; linking (4.2.5) treats NULL as "any printer".

Access codes: stored in the table (as the env file stored them). Never sent to the client
(`PrinterInfo.hasAccessCode`), never logged, excluded from `portability.ts` export (import leaves
printers untouched). They are in the SQLite backups, which the cloud only stores encrypted.
`tls_pin` holds the SHA-256 fingerprint of the printer's leaf certificate when it was pinned on first
use (4.2.3); editing `serial` or pressing "Trust the new certificate" clears it. Editing `host` alone
keeps it: the certificate names the serial, not the address, so a printer that got a new DHCP address
stays trusted (review fix; the first version cleared it on a host change too). A certificate that Test
trusted is remembered for that serial and address and used when the printer is added or edited to
match.

#### 4.2.2 Types

```ts
// app/src/lib/shared/printers/info.ts
export interface PrinterInfo {
	id: string;
	name: string;
	model: ModelCode;
	host: string;
	serial: string;
	port: number;
	ftpPort: number;
	tls: boolean;
	simulated: boolean;
	enabled: boolean;
	sortOrder: number;
	hasAccessCode: boolean;
	/** 'ca': chain verified against the Bambu CA bundle; 'pinned': leaf fingerprint pinned on first use; null: not connected yet. */
	trust: 'ca' | 'pinned' | null;
	version: number;
	createdAt: string;
	updatedAt: string;
}
export interface DiscoveredPrinter {
	serial: string; // SSDP USN
	host: string; // SSDP Location (bare IPv4)
	model: ModelCode | null; // from DevModel.bambu.com
	ssdpModel: string; // raw DevModel.bambu.com
	name: string; // DevName.bambu.com
	lanOnly: boolean; // DevConnect.bambu.com === 'lan'
	firmware: string | null; // DevVersion.bambu.com
	lastSeen: string;
	known: boolean; // already in the registry (same serial)
}
```

`Workspace` gains `printers: PrinterInfo[]` (sorted by `sortOrder`, then `createdAt`), produced by
`Lab.snapshot()` from the table. This is the only Workspace change in the whole programme; packages
must not add more (they use their own endpoints and live channels).

Validation (`validation.ts`): `printerInput` (name 1–60, model enum, host = IPv4/IPv6/hostname ≤ 253,
serial `^[A-Z0-9-]{4,32}$`i, accessCode `^[A-Za-z0-9]{8}$` on create, optional on patch, ports 1–65535,
booleans), `printerPatch` (+ `version`), `printerReorder` (`ids: string[]`).

#### 4.2.3 PrinterManager

```ts
// app/src/lib/server/printer/manager.ts
export interface PrinterManagerOptions {
	env: Record<string, string | undefined>;
	log: (m: string) => void;
}
export class PrinterManager extends EventEmitter {
	constructor(db: DB, lab: Lab, bus: EventBus, options: PrinterManagerOptions);
	/** Env import (4.2.1), then one connection per enabled row. */
	start(): void;
	stop(): void;
	list(): BambuPrinter[]; // enabled, in sort order
	get(id: string): BambuPrinter | undefined;
	require(id: string): BambuPrinter; // AppError(404, 'That printer no longer exists.') / (409, 'That printer is switched off in Settings.')
	/** The first enabled printer in sort order: what single-printer callers (cloud v1, kid page) use. */
	primary(): BambuPrinter | null;
	statuses(): PrinterStatus[];
	info(): PrinterInfo[];
	create(input: unknown): PrinterInfo; // validates, inserts, connects if enabled, lab.touch('printer')
	update(id: string, input: unknown): PrinterInfo; // versioned; reconnects when connection fields change
	remove(id: string): void; // disconnects; jobs keep history (printer_id set null by FK)
	reorder(ids: string[]): void;
	/** Connects with the given settings without saving: first report + get_version, 10 s timeout. */
	test(input: unknown): Promise<{
		ok: boolean;
		ms: number;
		detail: string;
		model: ModelCode | null;
		firmware: string | null;
	}>;
	discover(ms?: number): Promise<DiscoveredPrinter[]>;
	/** Emits 'update' (printerId) on every status change; 'changed' when the registry changes. */
}
```

Every write goes through `Lab`-style versioned updates and `lab.touch('printer', message)` so clients
refresh (`printers` in Workspace). Reconnect: keep the current backoff (2 s doubling to 60 s) per
connection. Offline is reported to the bus only after 10 s without reconnecting (debounce flapping).

**TLS policy** (`printer/tls.ts`, used for MQTT 8883, FTPS 990, RTSPS 322 and port 6000 alike; fixes
defects 11 and 12):

- `servername` = the printer's serial (SNI), `maxVersion: 'TLSv1.2'` (ha-bambulab
  `create_local_ssl_context`, P2S TLS 1.3 hang), `ca` = the bundled Bambu CA certificates
  (`printer/certs/`, copied from ha-bambulab `pybambu/certs/*.cert`, MIT, with a README naming the
  source commit).
- Custom `checkServerIdentity`: the leaf subject CN must equal the configured serial (case-insensitive);
  there is no IP SAN, so Node's default hostname check must be replaced, not merely disabled.
- If the chain does not verify (per-model device CAs are often missing from public bundles: ClusterM
  `10.06-lan-tls-and-access-codes.md`), fall back to trust on first use: the first successful
  connection that the user started (Test or Add in Settings) stores the leaf SHA-256 fingerprint in
  `printers.tls_pin`; later connections must match it or fail with "This printer's security
  certificate changed. If you replaced or reset the printer, press Trust the new certificate."
  Rows created by the env import (4.2.1) count as user-started for their first connection.
- Mechanics: connect with `rejectUnauthorized: false` and decide in the `secureConnect` handler, before
  anything is written: accept when `socket.authorized` (CA chain) and the CN matches, or when the leaf
  fingerprint equals `tls_pin`; otherwise destroy the socket. So the access code (MQTT CONNECT,
  FTP PASS, camera auth packet) is never sent to an unverified peer. One function, `verifyPrinterCert`,
  used by every client, with unit tests.
- Simulated printers (`simulated = 1`) and `tls = 0` skip verification; the simulator's self-signed
  certificate uses CN = its serial so the CN check is still exercised in tests with a test CA.

**Sequence ids.** Keep every `sequence_id` a decimal string in 20000–29999 (wrap within the window),
which is what Bambu Studio uses (`STUDIO_START_SEQ_ID`) and stays under 2^31−1: AMS commands with
larger ids hang the AMS (ClusterM `research/06.02-mqtt.md`). Replies may carry `result` as
`"success"`, `"SUCCESS"`, `"fail"` or an integer (camera), or no `result` at all: treat a missing
`result` as success and a numeric non-zero `result`/`err_code` as failure.

`BambuPrinter` changes:

- `PrinterConfig` gains `id: string` and `model: ModelCode`.
- Reports go through `mergeReport(raw, message)` + `parseReport(raw, ctx)` from `report.ts` (4.3).
- Handle every top-level key: `print` (status or reply), `info` (`get_version` reply → firmware
  modules), `system`, `camera`, `xcam`, `upgrade`, `pushing` (replies), `mc_print` (`push_info` lines,
  emitted raw as `'log'` for later use).
- On connect: subscribe, `pushall`, `get_version`. Then `get_version` again every 6 h. Every connect
  forces `pushall`, reconnects included: deltas sent while the connection was down are never repeated,
  so the merged raw report is stale until a full one arrives (ha-bambulab `bambu_client.py`
  `_on_connect` → `subscribe_and_request_info` publishes PUSH_ALL on each connect). The only limit on
  a forced one is Bambu Studio's `REQUEST_PUSH_MIN_TIME` (3 s, `DeviceManager.hpp`); within it the
  `pushall` is deferred, not dropped. OpenBambuAPI's 5 minutes is a rule of thumb against polling
  and applies to the watchdog below, not to reconnects.
- Stale watchdog: no message for 60 s while "connected" → one `pushall` (respecting the 5-minute
  rule on delta models) then close/reconnect after another 30 s without an answer. When the 5-minute
  rule holds the `pushall` back, a quiet delta printer is not stale (it may have nothing to report).
- `send()` from the command layer (4.4) replaces the private `command()`; `startPrint` and `control`
  become thin wrappers over `send('print.project_file' | 'print.pause' | …)`.
- `rawReport()` returns the merged raw report with `sn`, `serial`-like fields and IPs redacted, for the
  "Download diagnostics" button (lets people with real printers contribute fixtures).

`mqtt.ts` additions (so no wave package needs to touch it): `publish(topic, payload, { qos?: 0 | 1;
retain?: boolean })` with packet ids and PUBACK handling for QoS 1 (resolve on PUBACK, reject on close),
the retain flag bit, and `encode.puback`/`decode` support for PUBACK (type 4). The simulator broker
answers QoS 1 publishes with PUBACK. Tests for both.

#### 4.2.4 SSDP discovery

Verified (section 8.2): printers send `NOTIFY * HTTP/1.1` datagrams about every 5 s to
`255.255.255.255:2021` (source port 2021); the `Host: 239.255.255.250:1990` header is informational.
Headers: `Location` (bare IPv4), `NT: urn:bambulab-com:device:3dprinter:1`, `USN` (serial),
`DevModel.bambu.com`, `DevName.bambu.com`, `DevConnect.bambu.com` (`lan` when LAN-only),
`DevBind.bambu.com`, `Devseclink.bambu.com`, `DevVersion.bambu.com`, `DevCap.bambu.com`.

`discovery.ts`: `node:dgram` udp4 socket, `reuseAddr: true`, bind `0.0.0.0:2021`, `setBroadcast(true)`,
send one `M-SEARCH * HTTP/1.1\r\nHost: 239.255.255.250:1990\r\nST: urn:bambulab-com:device:3dprinter:1\r\nMAN: "ssdp:discover"\r\nMX: 3\r\n\r\n`
to `255.255.255.255:2021` (as X1Plus `x1p.ts` does), collect for `ms` (default 6000), parse
case-insensitively, keep only `NT`/`ST` = the Bambu URN, dedupe by USN. Only on demand (the user presses
"Find printers" or onboarding runs it); never a background listener. If binding fails (port in use),
return `[]` with a warning string. `parseSsdp(text)` is pure and unit-tested with the captured sample in
8.2. The simulator fleet can answer discovery: `sim/fleet.ts` sends NOTIFY datagrams to
`127.0.0.1:<port>` when started with `--ssdp <port>`; `discover()` accepts `{ port }` for tests.

SSDP is unauthenticated: anyone on the LAN can announce any serial at any IP. So discovery only
suggests; it never changes a saved printer's `host` by itself (offer "This printer now answers at
10.0.0.12. Update?"), and the TLS policy above is what stops a spoofed device from receiving the access
code. Parse defensively (datagrams ≤ 2 KB, header values ≤ 200 chars, `Location` must be an IPv4
literal).

#### 4.2.5 Jobs become printer-aware

- `Lab.linkStartedTask(printerId, task)` and
  `Lab.closePrinterTask(printerId, task, outcome: 'succeeded' | 'failed' | 'cancelled')`: consider jobs
  with `printer_id = printerId OR printer_id IS NULL`; when linking a NULL job, set its `printer_id`.
  `'cancelled'` transitions to `Cancelled` (defect 6).
- `jobInput`/`jobPatch` accept `printerId` (nullable; "any printer" when null). `reprintJob` copies it.
- `PrintFiles.check(jobId, opts)` / `send(jobId, opts)`: `SendOptions` gains `printerId?: string`
  (default: job's `printerId`, else the primary). One send at a time **per printer**, and
  per job (the same job cannot go to two printers at once). Model check:
  `sliced.printerModelId` must equal the printer's `model` (also accept the H2C pair `O1C`/`O1C2`
  either way); the error names both models ("This file was sliced for the P1S. This printer is an X2D.").
  On send, store `printer_id` and `dispatch` on the job. `SendOptions.amsMapping` has one tray per
  filament the plate uses (in the plate's order, as `SendPanel` builds it); `projectMapping()` in
  `printing.ts` turns it into `project_file`'s one entry per project filament by filament id (8.3), and
  `dispatch.amsMapping` stores that form (entry i = filament i + 1, -1 unused).
- Waking a printer (contract for queue and home-automation): `SendOptions` also gains `wake?: boolean`.
  With `wake: true` and at least one `beforeDispatch` hook registered, `check()` reports "not
  connected" as a warning-free deferral instead of blocking; the background task then runs
  `hooks.beforeDispatch` **inside `deliver()`** (with the task's `signal`), re-checks connection,
  model and busy state (the send's own lock does not count), and only then uploads. Callers never run `beforeDispatch` themselves (the queue
  must not call it separately, or the plug is switched twice). `send()` keeps returning the task it
  starts (from `TaskCenter.start`), so callers can await its outcome.
- `sliceJob` passes the job's printer model (or the primary's) to `slice()`; `SliceSettings` gains
  `model: ModelCode` and `slicer.ts` derives the machine preset name from `PRINTER_MODELS[model].name`
  and the model id for `finish()`. (The slicer-engine package replaces this module; the foundation only
  removes the hard-code.)
- Simulator validates `printer_model_id` against its own model instead of `N6`.

#### 4.2.6 API routes

All through `api()` in `http.ts`. Kid mode refuses them by default (existing `kidAccess`).

| Route                            | Method | Body / query                                                                     | Result                                                                              |
| -------------------------------- | ------ | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `/api/printers`                  | GET    |                                                                                  | `PrinterStatus[]`                                                                   |
| `/api/printers`                  | POST   | `printerInput`                                                                   | `{ printer: PrinterInfo }` + workspace                                              |
| `/api/printers/reorder`          | POST   | `{ ids }`                                                                        | workspace                                                                           |
| `/api/printers/test`             | POST   | `printerInput` (access code required unless `id` given and the serial is unchanged, then the stored one is used) | test result                                                                         |
| `/api/printers/discover`         | POST   | `{ ms? }` (≤ 15000)                                                              | `{ printers: DiscoveredPrinter[], warning? }`                                       |
| `/api/printers/[id]`             | GET    |                                                                                  | `PrinterStatus`                                                                     |
| `/api/printers/[id]`             | PATCH  | `printerPatch`                                                                   | `{ printer }` + workspace                                                           |
| `/api/printers/[id]`             | DELETE |                                                                                  | workspace                                                                           |
| `/api/printers/[id]/control`     | POST   | `{ action: 'pause' \| 'resume' \| 'stop' }`                                      | `{ outcome }`                                                                       |
| `/api/printers/[id]/commands`    | POST   | `{ name: CommandName, params }`                                                  | `CommandOutcome` (4.4)                                                              |
| `/api/printers/[id]/diagnostics` | GET    |                                                                                  | redacted raw report + versions (JSON download)                                      |
| `/api/printer`                   | GET    |                                                                                  | primary `PrinterStatus` or `{ configured: false }` (kept for kid pages; deprecated) |
| `/api/printer/control`           | POST   | as before                                                                        | acts on the primary (deprecated)                                                    |
| `/api/jobs/[id]/send`            | POST   | adds `printerId?`                                                                | unchanged                                                                           |

#### 4.2.7 UI

- `/printers`: grid of `PrinterCard` (name, model, state pill, progress ring, task, time left, nozzle
  and bed temps, AMS colour strip, offline error). Empty state explains LAN-only + Developer Mode and
  links to Settings → Printers. Nav item "Printers" (key `r`) replaces "Printer".
- `/printers/[id]`: today's `/printer` page made printer-aware (all `lab.printer` → this printer), plus
  the registry slots (4.6.3): `printerPanels` rendered in the main and side columns by `order`. The
  foundation's own panels become registered panels too: "Current print" (order 10, main), "Queued jobs
  ready to send" (order 20, main), "Temperatures" (TempChart, order 10, side), "AMS" (`AmsView`, `id: 'ams'`, order 20,
  side, renders `trayActions`), "Alerts" basic list (`id: 'alerts'`, order 30, side; the hms package
  registers its own panel with `replaces: 'alerts'`, see 4.6.3). A printer switcher (tabs when ≤ 4 printers, else a select) sits under the hero.
- `/printer` redirects (308) to `/printers/<primary id>` or `/printers` when there is none.
- Settings (`/integrations`): new first section "Printers" (`PrintersSection.svelte`): list in sort order
  with drag handle + keyboard reorder (Alt+↑/↓), enable toggle, Edit (`PrinterForm`: name, model select
  grouped by series, host, serial, access code (write-only, "Leave empty to keep"), advanced: ports, TLS,
  simulated), Test (shows ms, model/firmware found, or the friendly error), Remove (ConfirmDialog),
  "Find printers" (discovery results with "Add" prefilled; LAN-only and Developer Mode notes), and
  "Download diagnostics" per printer. The old four-step env instructions move here as help text.
- `PrinterChip` (top bar): primary printer's state; with more than one printer a count badge and a
  menu listing each printer's state; click navigates to `/printers/[id]`.
- `SendPanel`: printer picker (`PrinterPicker`, compatible printers first, incompatible disabled with the
  reason), AMS mapping uses the chosen printer's trays, then `sendPanelSections` slot.
- `JobForm`: "Printer" select (Any printer + each). `JobCard`/jobs page: printer chip when set, live
  progress via `lab.liveFor(job)` using `job.printerId`, and `jobPanels` slot.
- `SpoolForm`: renders `spoolFormFields` slot after the existing fields.
- `/family`: renders `familyPanels` slot after `KidModeSection`.
- `+layout.svelte`: renders `globalOverlays` slot (for drop zones and dialogs) and `TopBar` renders
  `topBarItems`.

`LabStore` (`app.svelte.ts`):

```ts
printers = $state<Record<string, PrinterStatus>>({});
get printerList(): PrinterStatus[];            // by ws.printers sort order
get primaryPrinter(): PrinterStatus | null;
printerById(id: string | null | undefined): PrinterStatus | null;
printerActiveFor(id: string): boolean;
/** @deprecated single-printer callers: the primary printer, or { configured: false }. */
get printer(): PrinterStatus;
get printerActive(): boolean;                  // any printer active (was: the one printer)
liveFor(job: Job): PrinterSnapshot | null;     // job.printerId, or any printer running job.printerTask
onLive<T>(channel: string, fn: (data: T) => void): () => void;  // see 4.6.4
```

SSE (`/api/events`): `hello` sends `{ changeId, printers: PrinterStatus[], printer: <primary or
{configured:false}>, cloud, tasks }`; `printer` events carry one `PrinterStatus` (with `id`), throttled
to 750 ms **per printer**; new `live` event `{ channel, data }` (4.6.4).

### 4.3 Telemetry: full typed status (1b)

`report.ts` holds two pure functions and all field knowledge:

```ts
/** Merges a report message into the retained raw state (4.3.1 semantics). Mutates and returns `raw`. */
export function mergeReport(raw: Raw, patch: Raw): Raw;
/** Builds the typed snapshot from the merged raw state. */
export function parseReport(
	raw: Raw,
	ctx: { model: PrinterModel; versions: VersionModule[]; accessCodeSet: boolean }
): PrinterSnapshot;
```

#### 4.3.1 Merge semantics (X1 full vs P1/A1 delta)

- Deep-merge plain objects (skip `__proto__`, `constructor`, `prototype`, as today).
- Arrays of objects with an identity key merge **per element by that key**, creating missing elements:
  `ams.ams[]` by `id`; `ams.ams[].tray[]` by `id`; `device.extruder.info[]` by `id`;
  `device.nozzle.info[]` by `id`; `device.airduct.parts[]` by `id`; `vir_slot[]` by `id`;
  `lights_report[]` by `node`. (ha-bambulab updates AMS/tray/extruder/nozzle per id; `Lights` searches
  by `node`.)
- Exception: a tray element that carries only `id` (and maybe `state`) replaces the stored tray: the
  slot is empty now (ha-bambulab `AMSTray.print_update` "metadata only"; Bambu Studio
  `DevFilaSystem.cpp` `ParseAmsTrayInfo` clears the filament of a tray sent without `tray_type`).
  Merging it would keep showing the spool that was taken out.
- Units stay in the merged report after they are unplugged, so `parseReport` leaves out units whose
  bit in `ams_exist_bits` is 0 (bit = unit id for AMS, AMS Lite and AMS 2 Pro, 12 for the A2L's AMS
  Lite, `4 + id − 128` for AMS HT; Bambu Studio `ParseAmsInfo`). Without the field every unit counts.
- All other arrays replace (`hms`, `s_obj`, `stg`, `cols`, `filam_bak`, `ams_mapping`, `mapping`,
  `airduct.modeList`, `new_ver_list`).
- A `pushall` reply (sequence matching our `pushall`, or any report on a `'full'` model) is still merged,
  not substituted, so values a model never reports keep their last value; but when a full report omits
  `hms` or `s_obj` entirely nothing changes, and when it carries `hms: []` alerts clear.
- Command replies (`print.command` other than `push_status`) never merge into status; `ams_filament_setting`
  etc. replies echo parameters that must not overwrite tray state.
- Values from the network are clamped: strings sliced (≤ 200 chars unless noted), numbers checked
  finite, colours validated `^[0-9A-F]{6,8}$`i.

#### 4.3.2 Status types

`app/src/lib/shared/printers/status.ts` (re-exported from `domain.ts` so existing imports work). Existing
`PrinterSnapshot` fields keep their names and meaning; everything else is new. Units: °C, percent 0–100,
minutes, millimetres.

```ts
export type LightMode = 'on' | 'off' | 'flashing';
export type SpeedLevel = 1 | 2 | 3 | 4; // silent, standard, sport, ludicrous (OpenBambuAPI print.print_speed)
/**
 * One number per filament source, following Bambu Studio's tray index (8.3):
 * 0–15 AMS / AMS 2 Pro / AMS Lite (unit*4+slot), 24–27 AMS Lite on the A2L (AMS type 5, unit id 16),
 * 128–135 AMS HT (the unit id, one slot), 255 = main (right, or only) external spool, 254 = deputy
 * (left) external spool. "Nothing loaded" is `null`, never 255.
 */
export type GlobalTray = number;
export const EXT_MAIN = 255; // Bambu Studio DevDefs.h VIRTUAL_TRAY_MAIN_ID
export const EXT_DEPUTY = 254; // VIRTUAL_TRAY_DEPUTY_ID

export interface HmsCode {
	attr: number | null;
	code: number | null;
} // unchanged shape (hms package decodes)

export interface PrinterTray {
	// existing fields first
	slot: string;
	active: boolean;
	type: string;
	name: string;
	color: string | null;
	remain: number | null;
	global: GlobalTray; // new: global tray number
	colors: string[]; // `cols` (multi-colour spools), '#rrggbb'
	infoIdx: string; // tray_info_idx, e.g. "GFA00" (Bambu filament id)
	idName: string; // tray_id_name, e.g. "A00-W1"
	tagUid: string | null; // tag_uid; null when all zeros
	trayUuid: string | null; // tray_uuid; null when all zeros
	weight: number | null; // tray_weight (g, spool nominal)
	diameter: number | null; // tray_diameter
	tempMin: number | null;
	tempMax: number | null; // nozzle_temp_min/max
	bedTemp: number | null;
	dryingTemp: number | null;
	dryingHours: number | null; // drying_temp, drying_time
	k: number | null; // pressure advance when reported (A1/P1)
	state: number | null; // tray `state` flags when present
	totalLengthMm: number | null; // total_len
	isBambu: boolean; // from tray_is_bbl_bits
}

export interface AmsUnit {
	// existing fields first
	unit: string;
	humidity: number | null;
	trays: PrinterTray[];
	id: number; // numeric id (0–3; 16 for the A2L's AMS Lite; 128–135 for AMS HT)
	/**
	 * From the unit's `info` hex string bits 0–3: 1 AMS, 2 AMS Lite, 3 AMS 2 Pro (N3F), 4 AMS HT (N3S),
	 * 5 AMS Lite on the A2L ("AMS_LITE_MIXED") (Bambu Studio DevDefs.h DevAmsType, DevFilaSystem.cpp
	 * ~597); without `info`, get_version module names ams/, ams_f1/, n3f/, n3s/ (ha-bambulab
	 * AMSList.info_update), and AMS Lite on A1/A1 mini.
	 */
	model: 'AMS' | 'AMS Lite' | 'AMS 2 Pro' | 'AMS HT' | 'Unknown';
	humidityIndex: number | null; // `humidity` level 1–5 as reported (ha-bambulab ignores other values); check which end is dry in Bambu Studio before labelling it
	humidityPercent: number | null; // `humidity_raw` 1–100
	temp: number | null; // `temp`
	drying: {
		remainingMinutes: number;
		temp: number | null;
		durationHours: number | null;
		filament: string;
	} | null; // dry_time, dry_setting.*
	serial: string | null;
	firmware: string | null; // from get_version (sn redacted to last 4 in client payloads)
	/** Extruder it feeds: `info` bits 8–11 (0 main/right, 1 deputy/left, 0xE = through the filament switcher → null) (DevFilaSystem.cpp ~599). */
	nozzle: number | null;
	dryStatus: number | null; // `info` bits 4–7 when the printer supports remote drying (fun2 bit 5); raw, labelled by the ams package
}

export interface NozzleState {
	id: number; // 0 = right / single, 1 = left (ha-bambulab Temperature)
	temp: number | null;
	target: number | null;
	diameter: number | null; // nozzle_diameter or device.nozzle.info[].diameter
	type: string | null; // 'hardened_steel' | 'stainless_steel' | new codes like 'HS01' (raw)
	activeTray: GlobalTray | null; // device.extruder.info[].snow: ams = (snow >> 8) & 0xFF, slot = snow & 0xFF, 0xFFFF = none (Bambu Studio DevExtruderSystem.cpp ~368), else legacy tray_now (8.3)
	wear: number | null;
}

export interface PrinterSnapshot {
	// ---- existing (unchanged meaning) ----
	gcodeState: string;
	percent: number | null;
	remainingMinutes: number | null;
	layer: number | null;
	totalLayers: number | null;
	nozzle: number | null;
	nozzleTarget: number | null; // active nozzle
	bed: number | null;
	bedTarget: number | null;
	chamber: number | null;
	task: string;
	speedLevel: number | null;
	printError: number;
	hms: HmsCode[];
	wifiSignal: string;
	ams: AmsUnit[];
	// ---- new ----
	chamberTarget: number | null; // device.ctc.info.temp high word
	stage: { id: number | null; name: string; subStage: number | null; printStage: number | null }; // stg_cur (255/-1 idle), mc_print_sub_stage, mc_print_stage
	speed: { level: SpeedLevel | null; magnitude: number | null }; // spd_lvl, spd_mag (%)
	fans: {
		part: number | null;
		aux: number | null;
		chamber: number | null;
		heatbreak: number | null;
		secondaryAux: number | null;
	}; // percent; raw 0–15 → ceil(raw/15*100/10)*10 (ha-bambulab utils.fan_percentage); airduct part 160 already %
	airductMode: number | null; // device.airduct.modeCur
	lights: {
		chamber: LightMode | null;
		chamber2: LightMode | null;
		work: LightMode | null;
		heatbed: LightMode | null;
	};
	nozzles: NozzleState[]; // length 1 or 2
	activeNozzle: number; // (device.extruder.state >> 4) & 0xF, else 0
	externalSpools: PrinterTray[]; // vt_tray, or vir_slot[] on dual-nozzle printers
	activeTray: GlobalTray | null; // active nozzle's tray; null when nothing is loaded
	xcam: {
		spaghetti: boolean | null;
		firstLayer: boolean | null;
		buildplateMarker: boolean | null;
		printingMonitor: boolean | null;
		printHalt: boolean | null;
		haltSensitivity: string | null;
		allowSkipParts: boolean | null;
	};
	sdCard: 'normal' | 'missing' | 'abnormal' | null; // home_flag bits 0x100 present / 0x200 abnormal, else `sdcard` bool
	doorOpen: boolean | null; // home_flag / stat bit 0x00800000 where supported
	camera: {
		present: boolean | null; // ipcam.ipcam_dev === "1"
		lanLiveview: 'rtsps' | 'rtsp' | 'local' | 'disabled' | null; // from ipcam.rtsp_url / ipcam.liveview.local (DeviceManager.cpp ~3450)
		rtspUrl: string | null; // host part redacted in client payloads; the camera module uses the registry host
		recording: boolean | null;
		timelapse: boolean | null;
		resolution: string | null;
	}; // ipcam.*; 'disable' → null
	skippedObjects: number[]; // s_obj
	printType: string | null; // print_type
	gcodeFile: string;
	prepareProgress: number | null; // gcode_file, gcode_file_prepare_percent
	plate: { index: number | null; count: number | null }; // plate_idx / plate_cnt where reported
	developerMode: boolean | null; // bit 29 of BigInt('0x' + fun) clear (ha-bambulab Print_Fun_Values.MQTT_SIGNATURE_REQUIRED) when `fun` is present
	/**
	 * Feature bits the printer itself reports, decoded with flags.ts (Bambu Studio DeviceManager.cpp
	 * ~4430–4480, DevAxis.cpp ~15): undefined when the source string is absent. The controls package
	 * uses these to choose between Bambu Studio's MQTT commands and the G-code fallbacks.
	 */
	firmwareSupport: {
		mqttBedTemp?: boolean; // fun bit 39 → print.set_bed_temp
		mqttHoming?: boolean; // fun bit 32 → print.back_to_center
		mqttAxis?: boolean; // fun bit 38 → print.xyz_ctrl
		partSkip?: boolean; // fun bit 49
		flowCalibration?: boolean; // fun bit 6
		paCalibration?: boolean; // fun bit 7
		motorNoiseCali?: boolean; // fun bit 10
		internalTimelapse?: boolean; // fun bit 28
		doorOpenCheck?: boolean; // fun bit 12
		nozzleRack?: boolean; // fun bit 60
		remoteDrying?: boolean; // fun2 bit 5
		printWithEmmc?: boolean; // fun2 bit 0
	};
	firmware: { version: string | null; modules: VersionModule[] }; // get_version (ota sw_ver)
	upgrade: { available: boolean; version: string | null; state: string | null }; // upgrade_state / new_ver_list (read-only)
	lastReportAt: string | null;
}

export interface VersionModule {
	name: string;
	hw: string;
	sw: string;
	product: string;
	serialTail: string;
}

export interface PrinterStatus {
	configured: boolean;
	// existing
	name?: string;
	simulated?: boolean;
	connected?: boolean;
	lastSeen?: string | null;
	error?: string;
	warning?: string;
	printing?: boolean;
	state?: PrinterSnapshot | null;
	// new (always set when configured)
	id?: string;
	model?: ModelCode;
	modelName?: string;
	caps?: Capabilities; // capabilitiesFor(model, firmware)
	camera?: CameraProtocol;
	enabled?: boolean;
}
```

Stage names: `stages.ts` exports `STAGE_NAMES: Record<number, string>` in plain sentence case built
from ha-bambulab `CURRENT_STAGE_IDS` (MIT; 0–77, plus -1 and 255 = idle) and `stageName(id)`. Cite the
file. Also `SPEED_LABELS = { 1: 'Silent', 2: 'Standard', 3: 'Sport', 4: 'Ludicrous' }`.

Temperatures: prefer `device.bed.info.temp` / `device.ctc.info.temp` / `device.extruder.info[].temp`
(packed: current = `v & 0xFFFF`, target = `(v >> 16) & 0xFFFF`) when present, else the classic
top-level fields (ha-bambulab `Temperature.print_update`). The existing `nozzle`/`nozzleTarget` report
the active nozzle.

AMS: tray activity comes from `device.extruder.info[].snow` per nozzle whenever `device.extruder` is
present (P2S, A2L, H2*, X2D send it even with one nozzle), else legacy `ams.tray_now` (255 none → `null`,
254 → `EXT_MAIN`, 128–135 → AMS HT unit, else unit = n >> 2, slot = n & 3; Bambu Studio
DevExtruderSystem.cpp ~276–305). From `snow`: ams 0–3 → ams*4+slot, 16 → 24+slot (A2L AMS Lite, verify
against a report with it loaded), 128–135 → the ams id, 254/255 → that external spool, `0xFFFF` → `null`.
`humidity` with values outside 1–5 and temps outside 0–100 are ignored during AMS power-up
(ha-bambulab). External spools: `vir_slot[]` entries by `id` ("255" main, "254" deputy) on printers
that send it, else `vt_tray` as `EXT_MAIN`.

`loadedSlots()` in `shared/printing.ts` switches to `global` numbers and labels AMS HT units
("HT1") and external spools ("Ext" on single-nozzle printers; "Ext R" = 255, "Ext L" = 254 on dual).

### 4.4 Generic typed command layer (1c)

```ts
// app/src/lib/server/printer/commands/registry.ts
import type { z } from 'zod';

/** Every command's params, by name. Packages add entries by declaration merging (see below). */
export interface CommandMap {
	'pushing.pushall': Record<string, never>;
	'info.get_version': Record<string, never>;
	'print.project_file': ProjectFileParams;
	'print.pause': Record<string, never>;
	'print.resume': Record<string, never>;
	'print.stop': Record<string, never>;
	'print.gcode_line': { lines: string[]; allowEmergency?: boolean };
}
export type CommandName = keyof CommandMap;
export type Topic = 'print' | 'system' | 'info' | 'pushing' | 'camera' | 'xcam' | 'upgrade';

export interface CommandContext {
	printerId: string;
	model: PrinterModel;
	caps: Capabilities;
	status: PrinterSnapshot | null;
	firmware: string | null;
}

export interface CommandDef<N extends CommandName = CommandName> {
	name: N;
	topic: Topic;
	/** Where the payload is documented; shown in code review, not to users. */
	source: string;
	params: z.ZodType<CommandMap[N]>;
	/** Capabilities that must all be true (checked before guard). */
	requires?: (keyof Capabilities)[];
	/** Plain-words reason to refuse, or null. Runs after params are parsed. */
	guard?: (ctx: CommandContext, params: CommandMap[N]) => string | null;
	/** Body under `topic`, without sequence_id; must include `command`. */
	build: (params: CommandMap[N], ctx: CommandContext) => Record<string, unknown>;
	/** Resolve 'confirmed' early when live status shows the effect. */
	settled?: (status: PrinterSnapshot, params: CommandMap[N]) => boolean;
	/** 'wait': resolve on the matching reply (default); 'none': resolve 'sent' once published. */
	reply?: 'wait' | 'none';
	timeoutMs?: number; // default 10000; on timeout resolve 'sent' (some firmware never answers)
	qos?: 0 | 1; // default 0; pause/resume/stop use 1
	/** UI hint: 'safe' (one tap), 'confirm' (ConfirmDialog), 'parent' (confirm + never in kid mode). */
	risk: 'safe' | 'confirm' | 'parent';
}

export function defineCommand<N extends CommandName>(def: CommandDef<N>): CommandDef<N>;
export function commandDef(name: string): CommandDef | undefined;
export function allCommands(): CommandDef[];

export interface CommandOutcome {
	outcome: 'confirmed' | 'sent';
	/** The printer's reply body when there was one (topic object, e.g. get_version's `module`). */
	reply?: Record<string, unknown>;
}
```

- Registration: `registry.ts` collects `import.meta.glob('./defs/*.ts', { eager: true })`; each defs file
  `export default [defineCommand({...}), …]`. Wave packages add `defs/<key>.ts` and declare their params:

  ```ts
  declare module '../registry' {
  	interface CommandMap {
  		'print.print_speed': { level: SpeedLevel };
  	}
  }
  ```

  Names are `<topic>.<command>` when one-to-one with a firmware command, else `<topic>.<command>:<variant>`
  (for example `print.gcode_line:set_nozzle_temp`), so two packages never pick the same name.

- `BambuPrinter.send(name, params, { signal? })`: looks up the def, parses params (zod → AppError 400),
  checks connected (409 "The printer is not connected."), `developerMode === false` (409 "Developer
  Mode is off on the printer, so it ignores commands from this app. Turn it on in the printer's
  network settings."), `requires`, `guard` (409 with the message), builds the message
  `{ [topic]: { sequence_id, ...body } }`, publishes with `qos`, waits per `reply`/`settled`/`timeoutMs`,
  rejects on a reply whose `result` is not success/ok (case-insensitive) with `reason`/`err_msg`.
- Sequence ids: per connection, start at `20000 + random(0..9999)`, increment and wrap inside
  20000–29999 (4.2.3), send as string. Match replies on topic + `command` + `sequence_id` when echoed
  (also accept `sequenceId`, which `ams_get_rfid` replies use per OpenBambuAPI; requests always send
  `sequence_id` as Bambu Studio and ha-bambulab do), else topic + `command` inside the timeout.
- `ProjectFileParams` is today's `StartOptions` from `bambu.ts` (file, plate, title, md5, useAms,
  amsMapping, bedType, timelapse, bedLeveling, flowCalibration), exported from `defs/core.ts`.
- Core defs (foundation, `defs/core.ts`), each citing OpenBambuAPI `mqtt.md` section:
  `pushing.pushall` (`{command:'pushall', version: 1, push_target: 1}`), `info.get_version`,
  `print.project_file` (moves today's payload, uses `printUrl` for `url`, `ams_mapping2` with AMS HT
  and external handling per 8.3, guard "busy"), `print.pause` (guard: RUNNING only; PREPARE message as
  today), `print.resume` (PAUSE only), `print.stop` (active only), all three `qos: 1`;
  `print.gcode_line` (`risk: 'parent'`, lines joined with `\n` and a trailing `\n`, ≤ 50 lines, each
  ≤ 256 printable ASCII chars, rejects `M112` unless `allowEmergency` — the controls package adds the
  safety guards; ha-bambulab `SEND_GCODE_TEMPLATE`).
- `print.project_file` mapping (verified in Bambu Studio `SelectMachine.cpp`
  `get_ams_mapping_result` ~1424–1510 at the tag, cite it): `ams_mapping` has **one entry per project
  filament** in filament order: the tray index (0–15, 128–135, 24–27) or `-1` for unused and for
  external spools; `ams_mapping2` has one `{ ams_id, slot_id }` per filament: `{255, 255}` unused,
  AMS HT `{128+n, 0}`, external `{255 or 254, 0}`. OpenBambuAPI's right-aligned 5-slot pattern is older
  behaviour; do not use it. Keep the X1/P1/A1 `file:///sdcard/` vs `ftp:///` url rule (4.1 `printUrl`).
- `print.stop`/`pause`/`resume` bodies are `{ command, param: "" }` (OpenBambuAPI `mqtt.md`); HMS
  "resume/ignore/stop this error" variants carry `err`, `param: "reserve"` and `job_id` and belong to
  the hms package (8.6).

### 4.5 Event bus (1d)

```ts
// app/src/lib/server/events.ts
export interface EventBase {
	at: string;
} // ISO time, set by emit()
export interface PrintRef {
	printerId: string;
	printerName: string;
	jobId: string | null;
	task: string;
}

export interface LabEventMap {
	'printer.online': { printerId: string; printerName: string };
	'printer.offline': { printerId: string; printerName: string; error: string };
	'print.started': PrintRef;
	'print.paused': PrintRef & {
		reason: 'user' | 'error' | 'filament' | 'other';
		stage: number | null;
	};
	'print.resumed': PrintRef;
	'print.layer': PrintRef & { layer: number; totalLayers: number | null; percent: number | null }; // on each layer change
	'print.finished': PrintRef & { minutes: number | null };
	'print.failed': PrintRef & { printError: number; hms: HmsCode[] };
	'print.cancelled': PrintRef;
	'hms.raised': { printerId: string; printerName: string; hms: HmsCode };
	'hms.cleared': { printerId: string; printerName: string; hms: HmsCode };
	'ams.runout': { printerId: string; printerName: string; tray: GlobalTray | null }; // stage 6 "paused_filament_runout" (hms package may add code-based detection)
	'ams.tray.changed': {
		printerId: string;
		printerName: string;
		tray: GlobalTray;
		before: PrinterTray | null;
		after: PrinterTray | null;
	};
	'queue.changed': { printerId: string | null; reason: string }; // emitted by the queue package
	'request.created': { requestId: string; profileId: string; projectId: string }; // kid asked to print (foundation emits from Lab)
	'request.decided': { requestId: string; decision: 'approve' | 'decline'; jobId: string | null };
}
export type LabEventName = keyof LabEventMap;
export type LabEvent<K extends LabEventName = LabEventName> = {
	name: K;
	data: LabEventMap[K] & EventBase;
};

export class EventBus {
	on<K extends LabEventName>(name: K, fn: (data: LabEventMap[K] & EventBase) => void): () => void;
	onAny(fn: (event: LabEvent) => void): () => void;
	emit<K extends LabEventName>(name: K, data: LabEventMap[K]): void; // adds `at`; listener errors are caught and logged, never thrown to the emitter
	/** Last 200 events, newest last (for the notification centre's first load and tests). */
	recent(): LabEvent[];
}
```

- Packages add events by declaration merging in their own files
  (`declare module '$lib/server/events' { interface LabEventMap { 'maintenance.due': {...} } }`). Names
  are `<area>.<what>`. Reserved for wave-1 packages: `queue.*` (queue), `maintenance.*` (maintenance),
  `power.*` (home-automation), `camera.*` (camera), `spool.*` (ams), `kid.*` (kids),
  `notification.*` (notifications), `vision.*` (ai-vision, wave 2).
- `diff.ts`: `diffStatus(printer, prev, next, jobIdFor): LabEvent[]` with `printer: { id; name }`,
  `prev: PrinterStatus | null`, `next: PrinterStatus`, `jobIdFor: (task: string) => string | null` — pure; derives online/offline, print transitions
  (active set `PREPARE RUNNING PAUSE SLICING`; FINISH → finished; FAILED with printError `0x0300400C`
  or `0x0500400E` → cancelled; FAILED → failed; active → IDLE → cancelled), pause reason from stage (16 user, 6 runout,
  others error), layer changes, HMS set differences (by attr+code), AMS tray changes (by `global`,
  comparing type/colour/uuid/remain rounded to 5 %). Table-driven tests cover each rule.
  Print transitions need a snapshot to compare with: the first report after the app starts (or after a
  Settings change reconnects the printer) never emits `print.started` for a print already running (the
  manager links it to a job quietly with `lab.linkStartedTask`), so modules do not announce a print as
  started on every restart. A print that ended while the app was away (FINISH or FAILED in that first
  report) is reported once, only while a job is still `Printing` for its task (`jobIdFor` finds it).
- Wiring (runtime): PrinterManager computes events on each `update` and emits them; the runtime
  subscribes `print.started` → `lab.linkStartedTask`, `print.finished|failed|cancelled` →
  `lab.closePrinterTask` (replacing today's direct `started`/`finished` listeners). `Lab.requestPrint`
  and `Lab.decideRequest` emit `request.*` after commit via a bus passed to `Lab` (optional constructor
  arg, so tests that build `new Lab(db)` still work).
- Ordering guarantee (packages rely on it): `emit()` calls listeners synchronously in registration
  order, and the runtime registers its core listeners (`linkStartedTask`, `closePrinterTask`) **before**
  any module starts. So when a module's `print.finished` listener runs, the job is already
  `Succeeded`/`Failed`/`Cancelled` and `data.jobId` is set whenever the print was linked (for
  `print.started`, the runtime's listener fills in `jobId` when it has just linked the task, so later
  listeners see it). A listener
  that needs async work must not block the emitter (fire and forget with its own error handling).

### 4.6 Extension registries (make wave-1 additive)

#### 4.6.1 Server modules

```ts
// app/src/lib/server/modules.ts
export interface ModuleContext {
	db: DB;
	lab: Lab;
	bus: EventBus;
	printers: PrinterManager;
	tasks: TaskCenter;
	printing: PrintFiles;
	models: ModelStore;
	hooks: Hooks;
	live: LivePublisher;
	env: Record<string, string | undefined>;
	dataDir: string; // directory beside the database (per database name, like models/)
	log(message: string): void; // prefixes "[print-lab:<key>]"
	settings<T>(schema: z.ZodType<T>, defaults: T): SettingsStore<T>;
	module<K extends keyof ModuleServices>(key: K): ModuleServices[K] | undefined;
}
export interface ServerModule<K extends string = string, S = unknown> {
	key: K;
	/** Start order (lower first); default 100. */
	order?: number;
	start(ctx: ModuleContext): S; // returns the service others reach through ctx.module(key) / rt.module(key)
	stop?(): void | Promise<void>;
	/** Rows for the Integrations page (status + setup steps). */
	integrations?(): IntegrationStatus[] | Promise<IntegrationStatus[]>;
	/** Extra GET API paths kid mode may read (default: none). */
	kidReads?: RegExp[];
}
/** Services by module key; packages add their entry by declaration merging in modules/<key>/module.ts. */
export interface ModuleServices {}
export function defineModule<K extends string, S>(m: ServerModule<K, S>): ServerModule<K, S>;
```

- Discovery: `runtime.ts` loads `import.meta.glob('./modules/*/module.ts', { eager: true })`, sorts by
  `order`, starts each inside try/catch (a failing module logs and stays off; the app still boots),
  stops them in reverse order on shutdown. `Runtime` gains `bus`, `printers`, `module(key)`,
  `modules()` (keys + started/failed).
- `module-settings.ts`: `SettingsStore<T> = { get(): T; set(input: unknown): T; key: string }` stored as
  JSON in `meta` under `settings:<module key>`, parsed with the module's zod schema, defaults on
  failure. Secrets (tokens, passwords) live there too; the module must never return them from its API
  (return `hasToken: true`). Existing `settings.ts` (AI routing) is untouched.
- `hooks` (`Hooks`): `beforeDispatch: HookList<(ctx: { printerId: string; jobId: string; signal: AbortSignal }) => Promise<void>>`
  run in registration order inside the `PrintFiles.send` background task before upload (4.2.5 "Waking
  a printer"; home-automation powers the plug and waits for the printer; a throwing hook aborts the
  send with its message). `HookList` has `add(fn): () => void` and `size`.
- `integrations.ts` appends every module's `integrations()` rows; `IntegrationId` widens to `string`
  (keep the existing literal ids for the built-ins).
- `kidAccess()` also allows `GET` paths matching any module's `kidReads`.

Service contracts the foundation declares now (interfaces only, in `modules/contracts.ts`, and the
matching `ModuleServices` entries are added by each package):

```ts
export interface CameraService {
	// camera
	has(printerId: string): boolean;
	getSnapshot(
		printerId: string,
		opts?: { maxAgeMs?: number; signal?: AbortSignal }
	): Promise<Buffer>; // JPEG
}
export interface HmsService {
	// hms
	describe(code: HmsCode | number, printerId: string): HmsInfo;
	active(printerId: string): HmsInfo[];
}
export interface HmsInfo {
	key: string;
	kind: 'hms' | 'print_error';
	severity: 'fatal' | 'serious' | 'common' | 'info' | 'unknown';
	module: string;
	text: string;
	wikiUrl: string | null;
	actions: HmsAction[];
}
export interface HmsAction {
	id: number;
	label: string;
	command: CommandName | null;
}
export interface NotifyService {
	// notifications
	notify(message: {
		title: string;
		body: string;
		level: 'info' | 'success' | 'warning' | 'error';
		printerId?: string;
		link?: string;
		event?: string;
	}): void;
}
export interface QueueService {
	// queue
	enqueue(jobId: string, opts?: { printerId?: string | null; notBefore?: string | null }): void;
	nextFor(printerId: string): { jobId: string } | null;
}
export interface PowerService {
	// home-automation
	ensureOn(printerId: string, opts?: { signal?: AbortSignal }): Promise<void>;
}
export interface SpoolSyncService {
	// ams
	spoolForTray(printerId: string, tray: GlobalTray): string | null;
}
export interface ProfileServiceModule {
	profiles: ProfileService;
} // slicer-profiles (1e)
export interface SlicerServiceModule {
	open(): Promise<SlicerEngine | null>;
} // slicer-engine (1e)
export interface ProjectStoreService {
	// slicer-3mf
	load(slicerProjectId: string): Promise<Project>;
	save(slicerProjectId: string, project: Project): Promise<void>;
}
```

#### 4.6.2 SvelteKit handle chain

`hooks.server.ts` becomes `export const handle = sequence(...HANDLES)` with `HANDLES` from
`$lib/server/hooks/index.ts`: `[hostGuard, crossSiteGuard, kidGuard, securityHeaders]` (today's logic,
split without behaviour change; compression stays last inside `securityHeaders`). lan-auth adds its
handle by inserting one line (`auth` between `crossSiteGuard` and `kidGuard`).

#### 4.6.3 UI registry

```ts
// app/src/lib/client/registry.ts
import type { Component } from 'svelte';
export interface UiModule {
	key: string;
	nav?: (NavItem & SlotEntry)[]; // BASE order: Projects 10, Print jobs 20, Printers 30, Filament 40, Family 50, Shop 60
	printerPanels?: PrinterPanel[];
	/** Links to a printer's sub-pages (Alerts, Media, Maintenance, AI checks…) shown under the printer hero. */
	printerTabs?: PrinterTab[];
	trayActions?: TrayAction[];
	settingsSections?: SettingsSection[];
	jobPanels?: JobPanel[];
	sendPanelSections?: SendSection[];
	spoolFormFields?: SpoolField[];
	familyPanels?: SlotComponent[];
	topBarItems?: SlotComponent[];
	globalOverlays?: SlotComponent[];
	paletteCommands?: {
		id: string;
		label: string;
		keywords?: string;
		run: (app: AppContext) => void;
	}[];
}
/** Every slot entry has an id, an order and optionally the id of an entry it replaces. */
export interface SlotEntry {
	id: string;
	order: number;
	replaces?: string;
}
export interface PrinterPanel extends SlotEntry {
	title: string;
	column: 'main' | 'side';
	component: Component<{ printer: PrinterStatus; info: PrinterInfo }>;
	show?: (printer: PrinterStatus) => boolean;
}
export interface PrinterTab extends SlotEntry {
	label: string;
	/** e.g. (id) => `/printers/${id}/alerts`; the route belongs to the registering package. */
	href: (printerId: string) => string;
	show?: (printer: PrinterStatus) => boolean;
}
export interface TrayAction extends SlotEntry {
	label: string;
	show?: (tray: PrinterTray, printer: PrinterStatus) => boolean;
	run: (ctx: {
		tray: PrinterTray;
		printer: PrinterStatus;
		app: AppContext;
	}) => void | Promise<void>;
}
export interface SettingsSection extends SlotEntry {
	title: string;
	group:
		'printers' | 'printing' | 'integrations' | 'notifications' | 'family' | 'privacy' | 'system';
	component: Component<Record<string, never>>;
}
export interface JobPanel extends SlotEntry {
	component: Component<{ job: Job }>;
	show?: (job: Job) => boolean;
}
export interface SendSection extends SlotEntry {
	component: Component<{ job: Job; printerId: string | null; plate: number }>;
}
export interface SpoolField extends SlotEntry {
	component: Component<{ spool: Spool | null; draft: Record<string, unknown> }>;
}
export interface SlotComponent extends SlotEntry {
	component: Component<Record<string, never>>;
}

export function defineUi(m: UiModule): UiModule;
/**
 * Every client/modules/<key>/ui.ts (gathered with import.meta.glob, eager), merged per slot and sorted
 * by order. An entry with `replaces: '<id>'` removes the entry with that id from the same slot;
 * otherwise duplicate ids in one slot are an error (thrown in dev, logged in production).
 */
export const UI: { [K in keyof Omit<UiModule, 'key'>]-?: NonNullable<UiModule[K]> };
```

Packages add `app/src/lib/client/modules/<key>/ui.ts` and components in `app/src/lib/components/<key>/`.
`nav.ts` builds `NAV` from the base items plus `UI.nav`; `BottomNav` shows the first five by order plus
"More". The printer detail page renders `printerTabs` as a row of links under the hero (hidden when
empty). Foundation registers its own slots in `client/modules/printers/ui.ts`. Settings page groups
sections under headings by `group` (Printers first, then the existing AI blocks, then the others,
`BackupsSection` stays last as `system`).

#### 4.6.4 Live channels

`LivePublisher` = `{ send(channel: string, data: unknown): void }`; the SSE endpoint relays as
`event: live`, `data: {"channel","data"}` to every open tab (channel names `<module>:<name>`).
`client/live.ts` exports `onLive(channel, fn)` used through `lab.onLive`. Use for push updates a
package's own page needs (camera state, queue order, notification count); not for bulk data.

#### 4.6.6 Test harness

Every wave package needs "a runtime with a simulated printer" in its integration tests; without a
shared helper each would invent one. `app/src/lib/server/testing/harness.ts`:

```ts
export interface TestLab {
	rt: Runtime; // real runtime over an in-memory SQLite DB, migrations applied
	fleet: Fleet; // simulated printers on free ports, registered as printers rows
	printer(model: ModelCode): { info: PrinterInfo; sim: SimPrinter };
	/** Resolves when the bus has emitted `name` (optionally matching `where`), rejects after `ms`. */
	nextEvent<K extends LabEventName>(
		name: K,
		where?: (d: LabEventMap[K]) => boolean,
		ms?: number
	): Promise<LabEventMap[K]>;
	stop(): Promise<void>;
}
export function startTestLab(o?: {
	fleet?: ModelCode[]; // default ['N6']
	modules?: string[]; // module keys to start (default: all found by the glob; [] = none)
	features?: SimFeature[]; // extra simulator features
	env?: Record<string, string>;
	speed?: number; // simulator time factor, default 60
}): Promise<TestLab>;
```

Simulated printers run with TLS off (plain MQTT/FTP on 127.0.0.1) except in the TLS policy tests.
Ports come from binding port 0, never fixed numbers, so vitest workers can run in parallel.

#### 4.6.5 Simulator features

The simulator moves to `app/src/lib/server/printer/sim/` and stays runnable by `tsx` (no
`import.meta.glob` there):

```ts
// sim/core.ts
export interface SimOptions {
	model?: ModelCode;
	serial?: string;
	name?: string;
	accessCode?: string;
	speed?: number;
	auto?: boolean;
	failRate?: number;
	log?: (m: string) => void;
}
export interface SimPrinter {
	model: PrinterModel;
	serial: string;
	name: string;
	state: Json; // raw `print` object
	report(full?: boolean): void; // delta or full per model.reports (full on pushall)
	answer(
		topic: string,
		command: string,
		sequence: unknown,
		result: 'success' | 'failed',
		extra?: Json
	): void;
	publishRaw(topic: string, body: Json): void; // e.g. info.get_version replies
	files: Map<string, { data: Buffer }>;
	log(m: string): void;
}
export interface SimFeature {
	key: string;
	init?(sim: SimPrinter): void;
	/** Return undefined when not handled; otherwise the reply to send. */
	command?(
		sim: SimPrinter,
		topic: string,
		msg: Json
	): { result: 'success' | 'failed'; reason?: string; extra?: Json } | 'silent' | undefined;
	step?(sim: SimPrinter, seconds: number): void;
	controls?: { id: string; label: string; run(sim: SimPrinter, body: Json): void }[]; // buttons on the control page
}
export function createSimulator(o?: SimOptions): Simulator; // same API as today plus `model`, `sim` = SimPrinter
// sim/fleet.ts
export function createFleet(o: {
	printers: SimOptions[];
	host?: string;
	basePort?: number;
	baseFtpPort?: number;
	ssdpPort?: number;
}): Promise<Fleet>;
// sim/features/index.ts
export const FEATURES: SimFeature[] = [core /* wave packages add one line each below */];
```

- Initial state per model comes from `sim/states/<code>.json`, copied from the conformance fixtures
  (4.8) with serials anonymised, so simulated reports have the real shape (device blocks on H2/X2,
  vir_slot, AMS HT…). Delta models publish only changed keys (today's behaviour), full models publish
  everything each tick.
- `get_version` is answered from the fixture's `get_version` block.
- `tools/printer-sim.ts`: `--fleet N6,C12,N1` (default `N6`, so the e2e command line keeps working),
  `--port` is the first MQTT port (+1 per printer), `--ftp-port` likewise, `--ssdp <port>` optional; the
  control page gets a printer selector and renders each feature's `controls`. `tools/dev-sim.ts` starts
  a three-printer fleet (X2D, P1S, A1 mini) and passes it as `PRINTLAB_PRINTERS`; `--single` keeps one.
  `simulator.ts` re-exports `createSimulator` and `Simulator` for existing tests.

### 4.7 Slicer contracts (1e) — types and stubs only

The foundation writes these files with full types, doc comments and small pure helpers
(encode/decode, locate). No engine, no 3MF, no profile code: those are wave-1 packages.

#### 4.7.1 Slicer Engine Protocol (`app/src/lib/shared/slicer/protocol.ts`)

Transport: newline-delimited JSON-RPC 2.0 over the engine's stdin/stdout. One JSON object per line,
UTF-8, no embedded newlines. stdout carries protocol only (the engine redirects everything upstream
prints to stderr at startup); stderr is logs. Large data never goes inline: files in a work directory
the client passes in `engine.hello`; inline base64 is allowed only up to 1 MB.

Protocol version `PROTOCOL = { major: 1, minor: 0 }`. The client requires an equal `major`; a lower
`minor` is fine, and features are gated by the capability list, so an engine one release older or
newer still works.

```ts
export type EngineCapability =
	| 'project.open'
	| 'project.save'
	| 'project.sync'
	| 'mesh.put'
	| 'arrange'
	| 'orient'
	| 'slice'
	| 'slice.cancel'
	| 'export.gcode3mf'
	| 'export.thumbnails'
	| 'preview.v1'
	| 'profiles.resolve'
	| 'profiles.list'
	| 'paint.supports'
	| 'paint.seam'
	| 'paint.color'
	| 'paint.fuzzy_skin'
	| 'modifiers'
	| 'height_ranges'
	| 'variable_layer_height'
	| 'multi_nozzle'
	| 'config.validate'
	| `calib.${string}`; // slicer-calibration generators (wave 2)

export interface EngineInfo {
	engine: 'printlab-slicer' | 'bambu-studio-cli' | 'orca-slicer-cli';
	version: string; // our engine version (semver)
	protocol: { major: number; minor: number };
	upstream: { name: 'BambuStudio' | 'OrcaSlicer'; tag: string; commit: string | null };
	patchQueue: { version: number; hash: string; patches: string[] } | null; // null for CLI backends
	capabilities: EngineCapability[];
	profiles: { dir: string; vendorVersion: string } | null; // BBL profiles shipped with this engine (same upstream tag)
}

export interface Progress {
	stage:
		| 'loading'
		| 'preparing'
		| 'slicing'
		| 'perimeters'
		| 'infill'
		| 'support'
		| 'gcode'
		| 'exporting'
		| 'arranging'
		| 'orienting';
	percent: number;
	message: string;
}

export interface ConfigError {
	key: string;
	message: string;
	objectId?: string;
}
export interface SliceWarning {
	code: string;
	message: string;
	objectId?: string;
	plate?: number;
}
export interface PlateStats {
	plate: number;
	seconds: number;
	layers: number;
	filaments: { index: number; grams: number; meters: number }[];
	objects: { objectId: string; seconds: number | null; grams: number | null }[]; // per-object breakdown when available
	warnings: SliceWarning[];
}

/** method → params/result. Notifications ($/…) are listed separately. */
export interface EngineMethods {
	'engine.hello': {
		params: {
			client: string;
			protocol: { major: number; minor: number };
			workDir: string;
			resourcesDir?: string;
		};
		result: EngineInfo;
	};
	'engine.ping': { params: Record<string, never>; result: { ok: true } };
	'engine.shutdown': { params: Record<string, never>; result: { ok: true } };
	'mesh.put': {
		params: { meshId: string; path: string; format: 'stl' | 'obj' | '3mf' | 'step' };
		result: {
			meshId: string;
			triangles: number;
			bbox: [number, number, number, number, number, number];
			repaired: { edgesFixed: number; facetsRemoved: number; facetsReversed: number };
		};
	};
	'mesh.drop': { params: { meshIds: string[] }; result: { ok: true } };
	'project.open': {
		params: { path: string };
		result: { projectId: string; project: Project; meshDir: string };
	}; // reads a .3mf with upstream's reader; meshes written as binary STL into meshDir, referenced by MeshRef
	'project.create': { params: { presets: PresetSelection }; result: { projectId: string } };
	'project.sync': {
		params: { projectId: string; project: Project; presets: ResolvedBundle };
		result: { revision: number; errors: ConfigError[] };
	}; // full desired state; engine diffs by stable ids
	'project.save': {
		params: { projectId: string; path: string; thumbnails?: PlateImages[] };
		result: { path: string };
	}; // unsliced Bambu project 3MF
	'project.close': { params: { projectId: string }; result: { ok: true } };
	'config.validate': {
		params: { projectId: string; plate?: number };
		result: { errors: ConfigError[]; warnings: SliceWarning[] };
	};
	arrange: {
		params: {
			projectId: string;
			plate: number | 'all';
			spacing?: number;
			allowRotation?: boolean;
			alignment?: 'center' | 'x' | 'y';
		};
		result: {
			instances: { objectId: string; instanceId: string; plate: number; transform: Transform }[];
		};
	};
	orient: {
		params: { projectId: string; objectIds: string[] };
		result: { objects: { objectId: string; transform: Transform }[] };
	};
	slice: { params: { projectId: string; plate: number }; result: PlateStats }; // emits $/progress; cancellable
	'export.gcode3mf': {
		params: {
			projectId: string;
			plates: number[] | 'all';
			path: string;
			thumbnails: 'engine' | PlateImages[];
		};
		result: { path: string; plates: SlicedPlate[] }; // SlicedPlate from $lib/shared/domain (existing type)
	}; // with Bambu metadata (slice_info.config, plate_N.json, md5, pick/top images)
	'preview.get': {
		params: { projectId: string; plate: number; path: string; travel?: boolean };
		result: { path: string; header: PreviewHeader };
	}; // writes the 4.7.3 container to `path`
	'profiles.list': {
		params: { kind: PresetKind; vendorDir?: string };
		result: { presets: PresetSummary[] };
	};
	'profiles.resolve': {
		params: { selection: PresetSelection; userPresets?: UserPreset[]; vendorDir?: string };
		result: ResolvedBundle;
	}; // upstream PresetBundle as the oracle for slicer-profiles tests
}
export interface PlateImages {
	plate: number;
	thumbnail: string /* path to PNG 512×512 */;
	noLight?: string;
	top?: string;
	pick?: string;
	small?: string;
}

/** Notifications. Engine → client: $/progress, $/log. Client → engine: $/cancel. */
export interface EngineNotifications {
	'$/progress': { id: number | string; progress: Progress };
	'$/log': { level: 'debug' | 'info' | 'warn' | 'error'; message: string };
	'$/cancel': { id: number | string };
}

export const ERROR = {
	PARSE: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL: -32603,
	PROJECT_NOT_FOUND: 1001,
	MESH_NOT_FOUND: 1002,
	FILE_READ: 1003,
	UNSUPPORTED_FORMAT: 1004,
	INVALID_CONFIG: 1010,
	PRESET_NOT_FOUND: 1011,
	SLICE_FAILED: 1020,
	NOTHING_TO_SLICE: 1021,
	OUTSIDE_PLATE: 1022,
	CANCELLED: 1030,
	EXPORT_FAILED: 1040,
	CAPABILITY_MISSING: 1050,
	UPSTREAM_EXCEPTION: 1099
} as const;
/** error.data: { message: plain words for the UI, detail?: upstream text, key?: config key, objectId? } */
```

Rules: requests are processed in order per `projectId` (the engine may run different projects
concurrently); `slice` can be cancelled with `$/cancel` (the engine calls upstream's print cancel and
answers `CANCELLED`); the engine must never write outside `workDir` and paths the client passes; every
error carries a plain-words `data.message`.

#### 4.7.2 Scene/Project model (`app/src/lib/shared/slicer/project.ts`)

Owned by slicer-3mf after the foundation (additive changes only). Mirrors Bambu Studio's model so a
3MF round-trips losslessly.

```ts
/** 3MF transform: 12 numbers, row-major 3×4 as written in the `transform` attribute: m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32 (3MF core spec). */
export type Transform = [
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number
];
export type ConfigValue = string | string[]; // upstream serialises every option as text; per-filament/per-extruder options are arrays
export type ConfigMap = Record<string, ConfigValue>;
export type MeshId = string; // sha256 (hex) of the canonical binary STL

export interface PresetRef {
	kind: PresetKind;
	name: string;
	source: 'system' | 'user' | 'project';
	userPresetId?: string;
}
export interface PresetSelection {
	printer: PresetRef;
	process: PresetRef;
	filaments: PresetRef[];
}

export interface MeshRef {
	id: MeshId;
	triangles: number;
	vertices: number;
	bbox: [number, number, number, number, number, number];
	storage:
		{ kind: 'file'; path: string } | { kind: 'model-version'; modelId: string; versionId: string };
}
/** Facet painting exactly as Bambu Studio stores it: per-triangle TriangleSelector strings (hex), sparse by triangle index. Attribute names: paint_supports, paint_seam, paint_color, paint_fuzzy_skin (bbs_3mf.cpp). */
export interface PaintData {
	supports?: Record<number, string>;
	seam?: Record<number, string>;
	color?: Record<number, string>;
	fuzzySkin?: Record<number, string>;
}

export type PartType = 'model' | 'negative' | 'modifier' | 'support_blocker' | 'support_enforcer';
export interface Part {
	id: string;
	sourceId?: number;
	name: string;
	type: PartType;
	mesh: MeshId;
	transform: Transform; // volume matrix relative to its object
	config: ConfigMap; // per-part overrides (e.g. extruder, wall_loops)
	filament?: number; // 1-based extruder/filament
	paint?: PaintData;
	primitive?: { kind: 'box' | 'cylinder' | 'sphere'; size: [number, number, number] }; // generated modifiers
	text?: Record<string, string>; // text_info attributes, kept verbatim
}
export interface Instance {
	id: string;
	transform: Transform;
	printable: boolean;
	identifyId?: number; /* slice_info object id used by skip_objects */
}
export interface HeightRange {
	minZ: number;
	maxZ: number;
	config: ConfigMap;
}
export interface SceneObject {
	id: string;
	sourceId?: number;
	name: string;
	parts: Part[];
	instances: Instance[];
	config: ConfigMap; // per-object overrides
	heightRanges: HeightRange[]; // layer_config_ranges.xml
	layerHeightProfile?: number[]; // layer_heights_profile.txt: z,h pairs
	printable: boolean;
	extras?: Record<string, string>; // unknown metadata, round-tripped
}
export type BedType =
	| 'Cool Plate'
	| 'Engineering Plate'
	| 'High Temp Plate'
	| 'Textured PEI Plate'
	| 'Supertack Plate'
	| string;
export interface Plate {
	index: number; // 1-based
	name: string;
	locked: boolean;
	bedType?: BedType;
	printSequence?: 'by layer' | 'by object';
	spiralVase?: boolean;
	filamentMapMode?: string;
	filamentMaps?: number[]; // dual-nozzle filament → nozzle mapping
	firstLayerSequence?: number[];
	otherLayersSequence?: number[];
	instances: { objectId: string; instanceId: string }[];
	config: ConfigMap; // plate-level overrides
	thumbnail?: string; // path
}
export interface FilamentSlot {
	index: number; // 1-based
	preset: PresetRef;
	color: string;
	type: string;
	tray?: GlobalTray | null;
	spoolId?: string | null;
	nozzle?: 0 | 1 | null;
}
export interface Project {
	format: 1;
	meta: {
		title: string;
		designer?: string;
		license?: string;
		origin?: string;
		description?: string;
		sourceUrl?: string;
		application?: string;
		createdAt?: string;
		modifiedAt?: string;
		extras?: Record<string, string>;
	};
	presets: PresetSelection;
	projectConfig: ConfigMap; // project_settings.config values that differ from the resolved presets
	filaments: FilamentSlot[];
	plates: Plate[];
	objects: SceneObject[];
	meshes: Record<MeshId, MeshRef>;
	/** Files and XML we do not model, kept byte-for-byte for round-trips (path → base64 or file path). */
	passthrough: Record<string, { path: string } | { base64: string }>;
}
export function emptyProject(presets: PresetSelection): Project;
export function transformToMatrix4(t: Transform): number[]; // three.js column-major 16
export function matrix4ToTransform(m: ArrayLike<number>): Transform;
```

#### 4.7.3 Preview format (`app/src/lib/shared/slicer/preview.ts`)

One binary container, produced both by the TS G-code parser (gcode-preview) and by the engine
(`preview.get`), decoded once in the browser. All numbers little-endian.

```
offset 0   "PLPV"                      magic, 4 bytes
       4   u16 version = 1
       6   u16 flags (bit0: travel moves included)
       8   u32 headerBytes             length of the JSON header, padded with spaces to a multiple of 4
      12   header JSON (UTF-8)         PreviewHeader
       …   seg   Float32 × 6n          x0 y0 z0 x1 y1 z1 per segment (mm)
       …   attr  Uint8   × 4n          feature, tool (0-based filament), width (0.01 mm units), height (0.01 mm units)
       …   speed Uint16  × n           mm/s (clamped to 65535), then zero-padding to a multiple of 4
```

```ts
export const PREVIEW_FEATURES = [
	'Other',
	'Travel',
	'Outer wall',
	'Inner wall',
	'Overhang wall',
	'Sparse infill',
	'Internal solid infill',
	'Top surface',
	'Bottom surface',
	'Bridge',
	'Gap infill',
	'Support',
	'Support interface',
	'Support transition',
	'Brim',
	'Skirt',
	'Prime tower',
	'Ironing',
	'Custom',
	'Wipe'
] as const; // index = feature code; append only, never reorder
export interface PreviewLayer {
	z: number;
	height: number;
	seconds: number | null;
	first: number;
	count: number;
}
export interface PreviewHeader {
	version: 1;
	plate: number;
	source: 'gcode' | 'engine';
	segments: number;
	bbox: [number, number, number, number, number, number];
	features: string[]; // PREVIEW_FEATURES at write time (lets old decoders show new names)
	tools: { index: number; color: string; type: string }[];
	layers: PreviewLayer[];
	totalSeconds: number | null;
}
export interface PreviewData {
	header: PreviewHeader;
	seg: Float32Array;
	attr: Uint8Array;
	speed: Uint16Array;
}
export function encodePreview(data: PreviewData): Uint8Array;
export function decodePreview(bytes: ArrayBuffer | Uint8Array): PreviewData; // throws on bad magic/version/sizes
```

The foundation implements `encodePreview`/`decodePreview` with round-trip and malformed-input tests.
gcode-preview maps Bambu `; FEATURE: <name>` comments to these names (verify the role names in
`src/libslic3r/ExtrusionEntity.cpp` at the pinned tag and extend `PREVIEW_FEATURES` by appending (named so it never clashes with the simulator's `FEATURES`)).

#### 4.7.4 Profile resolution API (`app/src/lib/shared/slicer/profiles.ts`)

```ts
export type PresetKind = 'printer' | 'process' | 'filament'; // Bambu Studio dirs: machine/, process/, filament/
export interface PresetSummary {
	kind: PresetKind;
	name: string;
	source: 'system' | 'user';
	id: string; // system: name; user: DB id
	inherits: string | null;
	instantiable: boolean; // instantiation !== "false"
	compatiblePrinters: string[]; // compatible_printers
	compatibleCondition: string | null; // compatible_printers_condition
	printerModel?: string;
	nozzle?: string; // printer presets: printer_model, nozzle_diameter
	filamentType?: string;
	filamentId?: string; // filament presets: filament_type[0], filament_id (e.g. "GFA00")
	settingId?: string;
}
export interface UserPreset {
	id: string;
	kind: PresetKind;
	name: string;
	inherits: string | null;
	config: ConfigMap;
	updatedAt: string;
}
export interface ResolvedPreset {
	kind: PresetKind;
	name: string;
	chain: string[];
	config: ConfigMap;
	origin: Record<string, string /* preset name that set the key */>;
}
export interface ResolvedBundle {
	printer: ResolvedPreset;
	process: ResolvedPreset;
	filaments: ResolvedPreset[];
	/** The flat config the slicer consumes (printer + process + per-filament arrays combined as upstream does). */
	full: ConfigMap;
	vendor: { tag: string; version: string };
}
export interface ProfileService {
	vendor(): { tag: string; version: string; dir: string } | null;
	list(
		kind: PresetKind,
		filter?: { printer?: string; model?: ModelCode; nozzle?: string; includeHidden?: boolean }
	): PresetSummary[];
	resolve(ref: PresetRef): ResolvedPreset;
	diff(ref: PresetRef): { key: string; value: ConfigValue; parent: ConfigValue | null }[];
	compatible(printer: PresetRef, kind: 'process' | 'filament'): PresetSummary[];
	/** Default printer/process/filament presets for a printer model, nozzle and material ("PLA", "PETG HF"…). */
	defaults(model: ModelCode, nozzle: string, material?: string): PresetSelection;
	bundle(
		selection: PresetSelection,
		overrides?: { process?: ConfigMap; filaments?: ConfigMap[]; printer?: ConfigMap }
	): ResolvedBundle;
}
```

#### 4.7.5 Engine location and bundling (`app/src/lib/server/slicer/locate.ts`)

```ts
export interface SlicerLocation {
	kind: 'engine' | 'bambu-studio-cli' | 'orca-slicer-cli';
	path: string;
	resourcesDir: string | null; // profiles live at <resourcesDir>/profiles/BBL(.json)
	source: 'env' | 'desktop' | 'dev-build' | 'installed';
}
export function locateSlicers(
	env?: Record<string, string | undefined>,
	cwd?: string
): SlicerLocation[]; // in preference order
export function locateEngine(env?, cwd?): SlicerLocation | null;
export function locateCli(env?, cwd?): SlicerLocation | null;
```

Search order (first existing, executable file wins; `exe` suffix `.exe` on Windows; `<plat>` =
`linux-x64`, `darwin-arm64`, `darwin-x64`, `win32-x64` from `process.platform-process.arch`):

1. `PRINTLAB_SLICER_PATH` (explicit engine binary; resources = sibling `resources/`) — source `env`.
2. Desktop bundle: `<cwd>/engine/printlab-slicer<exe>` with `<cwd>/engine/resources` (the Electron app
   runs the server with `cwd = desktop/server`; `prepare-server.mjs` copies the engine there) — `desktop`.
3. Dev builds: `<repo>/slicer/dist/<plat>/printlab-slicer<exe>`, then
   `$PRINTLAB_SLICER_BUILD_DIR/engine/printlab-slicer<exe>` — `dev-build`. `<repo>` is found by walking
   up from `cwd` to the directory that has `slicer/UPSTREAM.md`.
4. Stock CLIs (fallback backend): `BAMBU_STUDIO_PATH`, `ORCA_SLICER_PATH`, then
   `~/.local/opt/bambu-studio-*/AppRun` (newest, as today), `~/.local/opt/orca-slicer-*/AppRun`,
   `/Applications/BambuStudio.app/Contents/MacOS/BambuStudio`,
   `/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer`,
   `%ProgramFiles%\Bambu Studio\bambu-studio.exe`, `%ProgramFiles%\OrcaSlicer\orca-slicer.exe`,
   `/usr/bin/bambu-studio`, `/usr/bin/orca-slicer` — `installed`; resourcesDir per install layout
   (Linux AppImage: `<dir>/resources`; macOS: `Contents/Resources`; Windows: `<dir>\resources`).
5. None: slicing unavailable; Integrations explains how to get it (desktop app includes the engine;
   otherwise install Bambu Studio).

`engine.ts` (stub from the foundation, implemented by slicer-engine):

```ts
export interface SlicerEngine {
	readonly info: EngineInfo;
	has(cap: EngineCapability): boolean;
	call<M extends keyof EngineMethods>(method: M, params: EngineMethods[M]['params'], opts?: { signal?: AbortSignal; onProgress?: (p: Progress) => void; timeoutMs?: number }): Promise<EngineMethods[M]['result']>;
	close(): Promise<void>;
}
export class EngineError extends Error { constructor(readonly code: number, message: string, readonly data?: unknown) }
/** Engine binary if found and it negotiates, else the CLI backend, else null. Cached; restarted after a crash. */
export async function openSlicer(env?: Record<string, string | undefined>): Promise<SlicerEngine | null>;
```

The foundation's stub `openSlicer` returns `null` and the existing `slicer.ts` keeps working.

### 4.8 Protocol conformance tests (1f)

Fixtures in `app/src/lib/server/printer/__fixtures__/reports/`, each `<name>.json` =
`{ "source": "<url + commit>", "licence": "MIT (ha-bambulab)" | "…", "model": "<code>", "pushall": {…},
"get_version": {…}, "deltas"?: [{…}, …] }` plus `<name>.expected.json` (the parsed `PrinterSnapshot`,
hand-reviewed, not blindly generated). `README.md` lists each file's source and licence and notes any
edits (serials replaced with `REDACTED`/`SIM-…`).

| Fixture                               | Model                  | Source                                                                                                                                                                                                   |
| ------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `x1c-multi-ams`                       | BL-P001                | ha-bambulab `pybambu/mock_data/MOCK-X1CMULTIAMS.json` (MIT)                                                                                                                                              |
| `p1p-no-ams`                          | C11                    | ha-bambulab `MOCK-P1PNOAMS.json` (MIT)                                                                                                                                                                   |
| `p1s`                                 | C12                    | search real dumps (`gh search code '"C12"' mc_print_stage`, bambuddy/ha issues); if none, derive from `p1p-no-ams` + OpenBambuAPI pushall AMS block and mark `"synthetic": true`                         |
| `a1`                                  | N2S                    | ha-bambulab `MOCK-A1.json` (MIT)                                                                                                                                                                         |
| `a1-mini`                             | N1                     | search as for P1S; else derive from `a1` (AMS Lite `ams_f1/0` module) and mark synthetic                                                                                                                 |
| `h2d`, `h2d-ext-spool`                | O1D                    | ha-bambulab `MOCK-H2D.json`, `MOCK-H2DEXTSPOOLACTIVE.json` (MIT)                                                                                                                                         |
| `x2d`                                 | N6                     | ha-bambulab `MOCK-X2D.json` (MIT)                                                                                                                                                                        |
| `p2s`, `h2s`, `h2c`, `h2d-pro`, `a2l` | N7, O1S, O1C2, O1E, N9 | ha-bambulab mocks (MIT)                                                                                                                                                                                  |
| `openbambuapi-pushall`                | BL-P001                | Not copied: OpenBambuAPI is GFDL-1.3 (`LICENSE.md`), not compatible with AGPL code/fixtures. Write a synthetic fixture from our reading of `mqtt.md` and cite it                                         |
| `p1-delta-sequence`                   | C12                    | synthetic sequence: pushall then partial deltas (single tray change, humidity change, `hms` raised then `[]`, gcode_state PREPARE→RUNNING→FINISH), shaped per OpenBambuAPI "P1 Series" push_status notes |

`conformance.test.ts`:

- For each fixture: `parseReport(mergeReport({}, pushall), ctx)` equals `expected`; applying `deltas` in
  order equals the `expected.afterDeltas` block when present; merging the pushall twice is idempotent.
- Keyed-merge cases: a delta with one tray does not remove the other three; a delta for AMS unit 1 does
  not touch unit 0; AMS HT unit 128 tray activity; H2D `snow` → active tray per nozzle; external spool
  (254/255) activity; packed temperatures.
- `detectModel` for every fixture's `get_version`; `capabilitiesFor` firmware gating (e.g. P1S
  `support_command_ams_switch` from `01.02.99.10`).
- Flags: `fun` from `MOCK-X2D.json` (`40029FD1B30F9CB7`, 64-bit) decodes with BigInt;
  `developerMode` is `true` there and `false` for `MOCK-H2D.json` (`1AFFF9CFF`, bit 29 set); `fun2`
  longer than 16 hex digits decodes.
- A2L (`MOCK-A2L.json`): AMS unit id `16` with `info` `30001005` → model 'AMS Lite', trays numbered
  24–27. X2D: `info` `11002103` → 'AMS 2 Pro' feeding nozzle 1. H2D ext-spool mock: HT units 128/129.
- Legacy `tray_now` 254 → `EXT_MAIN`, 255 → `null`; `snow` 0xFFFF → `null`.
- Cancel detection for print errors `0300400C` and `0500400E`.
- TLS policy (`tls.test.ts`): a test CA + leaf `CN=<serial>` passes; wrong CN fails; unknown CA with no
  pin pins on a user-started test and then refuses a different leaf; the access code is never written
  to a socket whose check failed.
- Command payload goldens: `commands.golden.json` holds, per core command, the expected payload for a
  given model/params with the source cited; `build()` must match exactly (sequence id normalised).
- `diffStatus` event table tests.
- Simulator conformance: for each supported sim model, a connected `BambuPrinter` parses the simulator's
  reports into a snapshot with the same keys populated as the fixture's expected snapshot.

### 4.9 Foundation acceptance criteria

- `bun run check` 0/0, all vitest pass, e2e pass (after updating specs for `/printers`), prettier/eslint
  clean.
- With `BAMBU_*` env set and an empty `printers` table, first boot creates exactly one printer; a second
  boot creates none; `PRINTLAB_PRINTERS` upserts.
- `bun run dev:sim` shows three simulated printers (X2D, P1S, A1 mini) live on `/printers`; each can be
  paused/resumed/stopped; sending a job to the P1S with an X2D-sliced file is refused with a clear
  message; a correctly sliced `fakeSliced({ printerModelId: 'C12' })` job prints on the P1S and closes
  as Succeeded; stopping a print closes the job as Cancelled.
- Settings → Printers: add, edit (access code write-only), test, disable, reorder, remove, discover
  (tested against the simulator's SSDP option), diagnostics download.
- Every existing printer route/UI works per printer; `/printer` and `/api/printer*` still work.
- A module dropped into `modules/example/module.ts` (a test fixture module under `src/lib/server/modules/__test__/`
  is fine) starts, receives bus events, and its `integrations()` row shows; a `client/modules/<x>/ui.ts`
  adds a nav item and a printer panel without editing any other file.
- Slicer contract files type-check and `preview.ts` round-trips; `locate.ts` has unit tests with a fake
  filesystem layout.
- `startTestLab({ fleet: ['N6', 'C12'] })` boots in under 5 s in vitest and a sample test prints a
  `fakeSliced` job to Succeeded through it.
- Printer connections verify TLS per 4.2.3; the simulator-backed tests cover CA, pin and mismatch.
- Report lists anything deferred.

---

## 5. Wave 1 work packages

Every package:

- Branch `parity-<key>` from `parity` after the foundation merge; its own worktree.
- Server code in `app/src/lib/server/modules/<key>/` (entry `module.ts` using `defineModule`, adding its
  `ModuleServices` entry), shared types in `app/src/lib/shared/<key>.ts`, client registrations in
  `app/src/lib/client/modules/<key>/ui.ts`, components in `app/src/lib/components/<key>/`, routes under
  its own directories, commands in `app/src/lib/server/printer/commands/defs/<key>.ts`, simulator
  support in `app/src/lib/server/printer/sim/features/<key>.ts` (+1 line in `sim/features/index.ts`),
  tables in `app/src/lib/server/db/tables/<key>.ts` (+1 `export *` line in `db/schema.ts`), migration in
  its reserved slot (7.3).
- "Owns" = files it creates and may freely change. "May touch" = shared files with the exact allowed
  change; anything else shared needs a note in the report.
- Tests: unit tests next to the code (`*.test.ts`), simulator-backed integration tests where a printer
  is involved (through `startTestLab`, 4.6.6), an e2e spec `app/e2e/<key>.e2e.ts` for the main user
  path when there is UI.
- Validation schemas live in the package (`modules/<key>/validation.ts`), not in the shared
  `validation.ts`. Printer sub-pages get a `printerTabs` entry rather than an edit to the printer page.
- Scope: each package lists "Must" and "Stretch" where the plan says so. Deliver every Must first; a
  Stretch item not done goes in the report with next steps, never half-wired into the UI.
- UI copy: plain, short, sentence case, British spelling; explain printer requirements (for example
  "Needs Developer Mode on the printer") in words a parent understands.

### 5.1 `hms` — understandable printer errors

**Goal.** Turn HMS and `print_error` codes into plain text with severity, wiki link, history and
one-click actions, offline.

**User-facing scope.**

- Alerts panel on `/printers/[id]` (`id: 'hms-alerts'`, `replaces: 'alerts'`): each
  active alert with severity icon, text, code (`0700_2000_0002_0001` style), "Learn more" (wiki), and
  action buttons where Bambu defines them for that code (for example "Resume", "Retry", "Done").
- Print error banner on the printer page and the job card when a print failed with an error.
- History: `/printers/[id]/alerts` page listing raised/cleared alerts with times, filter by severity.
- Integrations row "Printer error help" (offline database version, source).

**Data.**

- `app/tools/hms/build-hms.ts` builds `app/resources/hms/hms-en.json.gz` (committed, target < 1.5 MB)
  and `app/resources/hms/SOURCES.md` from:
  1. Bambu Studio `resources/hms/hms_en_<device>.json` + `hms_action_<device>.json` at the pinned tag
     (AGPL-3.0, like FPL) — fetched with a sparse checkout or from `slicer/.upstream` when present.
     Format (checked at the tag):
     `{ result, t, ver, data: { device_hms: { ver, en: [{ ecode, intro }] }, device_error: { ver, en: [...] } } }`
     with 16-hex `ecode` for HMS and 8-hex for print errors, and
     actions `{ data: [{ ecode, actions: [ids], image, device }] }` where `ecode` is **either** 8 or 16
     hex (match both tables). `image` names a PNG under `resources/hms/local_image/`: ship the images
     referenced by the codes we keep (size-capped, WebP-converted with ffmpeg if that helps stay under
     budget) so alerts can show Bambu's picture like Handy does. The raw set is ~150 MB for all languages:
     take `hms_en_*` and `hms_action_*` only (other languages later).
  2. ha-bambulab `pybambu/hms_error_text/hms_en.json.gz` and `wiki_links.json.gz` (MIT) for the models
     Bambu Studio does not bundle (X1/P1/A1); format `{ device_hms: { <code>: { <text>: [models] } } }`.
     Output format: `{ version, sources, messages: string[], hms: { [16-hex]: [msgIdx] | { [device]: msgIdx, default?: msgIdx } }, errors: { [8-hex]: … }, wiki: { [16-hex]: { [series]: path } }, actions: { [code]: { [device]: number[] } } }`.
- Decoding (verify and cite): full HMS key = `attr` and `code` as 8-hex each, concatenated
  (`hmsCode()` in `format.ts` already renders `AAAA_AAAA_CCCC_CCCC`); severity = `code >> 16`
  (1 fatal, 2 serious, 3 common, 4 info) and module = `attr >> 24` (0x03 mc, 0x05 mainboard, 0x07 ams,
  0x08 toolhead, 0x0C xcam) per ha-bambulab `utils.get_HMS_severity/get_HMS_module`; `print_error` =
  8-hex of the uint32, looked up in `device_error`. Device-specific text chosen by the printer's
  `hmsDevice` (serial prefix; fill the "verify" rows of 4.1's table and commit the catalogue change).
  Wiki link: specific path when known, else `https://wiki.bambulab.com/en/hms/home`.
- Actions: map Bambu's action ids to labels and MQTT commands by reading Bambu Studio
  `src/slic3r/GUI/DeviceErrorDialog.cpp` (`ActionButton` enum, `on_button_click` ~535) and
  `DeviceManager.cpp` at the pinned tag. Verified builders there: `command_hms_resume` (`print.resume`
  with `err`, `param: "reserve"`, `job_id`, QoS 1), `command_hms_ignore` (`print.ignore`, same fields),
  `command_hms_idle_ignore` (`print.idle_ignore` with `err`, `type`), `command_hms_stop` (`print.stop`
  with `err`, `param: "reserve"`, `job_id`), `command_clean_print_error` (`print.clean_print_error` with
  `subtask_id`, `print_error`), `command_clean_print_error_uiop` (`system.uiop` `name: "print_error"`,
  `action: "close"`), `command_stop_buzzer` (`print.buzzer_ctrl` `mode: 0`, QoS 1), `ams_control`
  (`resume`/`done`). Add each as a command def in `defs/hms.ts` (names like `print.resume:hms`) citing
  file and line. Unmapped ids render no button. Buttons Bambu only shows on the printer (for example
  resuming laser/cutting tasks, `check_resume_condition`) render no button either.

**Backend.** Module `hms`: `HmsService`; table `hms_events` (id, printer_id FK cascade, kind
'hms'|'print_error', code text, severity, text, raised_at, cleared_at, job_id nullable) written on
`hms.raised`/`hms.cleared`/`print.failed`; `/api/printers/[id]/hms` (active + history, paginated),
`/api/hms/lookup?code=&printerId=`, `POST /api/printers/[id]/hms/action { code, actionId }` (runs the
mapped command through `send`). Emits no new bus events (notifications uses `hms.raised` + `HmsService.describe`).

Reads the pinned tag through `app/tools/lib/upstream.ts`; the slicer update workflow (5.6 rule 7)
reruns the builder so HMS text moves with the pin. Adds a `printerTabs` entry "Alerts".

**Owns** `modules/hms/*`, `components/hms/*`, `routes/printers/[id]/alerts/*`, `routes/api/hms/*`,
`routes/api/printers/[id]/hms/*`, `tools/hms/*`, `resources/hms/*`, `defs/hms.ts`, `sim/features/hms.ts`,
`db/tables/hms.ts`, migration 0006, `app/package.json` script `hms:build` (one line).
**May touch** `models.ts` (hmsDevice values only), `format.ts` (add `hmsKey()` beside `hmsCode()`),
`JobCard.svelte` only through `jobPanels` (no edit), `sim/features/index.ts` (+1 line).

**Simulator.** Raise realistic codes from the database (AMS runout, nozzle clog, first-layer) via
control buttons; honour action commands (e.g. resume clears the alert and resumes).

**Tests.** Decoder table tests (severity/module/key), lookup by device with fallback to default and to
English, wiki path selection, builder output golden, action mapping, history rows on raise/clear
(simulator-driven).

**Acceptance.** Simulated AMS alert shows plain text + severity + wiki link; its action button resolves
it; history keeps it with raised/cleared times; failed print shows the error text on the job.

### 5.2 `controls` — full printer controls

**Goal.** Everything Bambu Handy/Studio can do from the device page, through the command layer, with
capability gating and safety guards.

**Scope and commands** (each a def in `defs/controls.ts`, citing the source; exact payloads from the
sources, never invented):

- Speed level: `print.print_speed` `{ param: "1".."4" }` (OpenBambuAPI). Only while printing.
- Lights: `system.ledctrl` for `chamber_light`, `chamber_light2` (when `chamberLight2`), `work_light`
  (X1), `heatbed_light` (H2) with the full field set (ha-bambulab `commands.py` templates).
- New protocol vs G-code. Bambu Studio has dedicated MQTT commands for several controls and falls
  back to G-code when the printer does not report support. Mirror its choice, reading the callers in
  `src/slic3r/GUI/StatusPanel.cpp` at the tag (add it to the sparse clone) and gating on
  `status.firmwareSupport` (4.3.2). Verified builders:
  - nozzle: `print.set_nozzle_temp { extruder_index, target_temp }` QoS 1 (`DeviceManager.cpp`
    `command_set_nozzle_new` ~1611) on dual-nozzle printers; `M104 S<t>` via `gcode_line` otherwise
    (`command_set_nozzle` ~1596). **Do not** send `M104 … T<n>`: nothing in the sources shows it.
  - bed: `print.set_bed_temp { temp }` when `firmwareSupport.mqttBedTemp` (fun bit 39), else `M140 S<t>`
    (`command_set_bed` ~1571).
  - chamber: `print.set_ctt { ctt_val }` QoS 1 (`DeviceCore/DevChamberCtrl.cpp`) where Bambu Studio
    uses it; ha-bambulab's `M141`/`M145 P0|P1` form (`utils.set_temperature_to_gcode`, not on X1E)
    only where Studio has no MQTT path. Gate on `chamberTempEdit`/`activeChamberHeater`.
  - fans: `print.set_fan { fan_index, speed }` (`DeviceCore/DevFan.cpp` `command_control_fan_new`) on
    printers with the airduct/new fan system; else `M106 P1|P2|P3|P10 S<0-255>` in 10 % steps
    (ha-bambulab `fan_percentage_to_gcode`), gated on `auxFan`/`chamberFan`/`secondaryAuxFan`.
  - airduct mode: `print.set_airduct { modeId, submode }` (`DevFan.cpp`; ha-bambulab
    `AIRDUCT_SET_MODE_TEMPLATE` uses `submode: -1`), modes from `device.airduct.modeList`, gated on
    `airductMode`.
  - home: `print.back_to_center` when `mqttHoming` (fun bit 32), else `G28` (Studio sends `G28 X` while
    printing; we only home when idle). Jog: `print.xyz_ctrl { axis, dir, mode }` when `mqttAxis` (fun
    bit 38; `mode` 1 for steps ≥ 10 mm, Y/Z direction inverted on A-series bed slingers:
    `DevAxisCtrl.cpp`), else ha-bambulab `MOVE_AXIS_GCODE`.
  - active nozzle (dual): `print.select_extruder { extruder_index }` QoS 1 (`DevCtrl.cpp`), only idle.
  - buzzer (H2, `fireAlarmBuzzer`): `print.buzzer_ctrl { mode }` (0 silent, 1 alarm, 2 beeping;
    ha-bambulab `BUZZER_SET_*`).
- Temperature limits from the model (`nozzleTempMax`, `bedTempMax`, `chamberTempMax`); refuse above.
- AMS: load tray `print.ams_change_filament` in Bambu Studio's form (`DeviceManager.cpp`
  `command_ams_change_filament` ~1640): `{ ams_id, slot_id, target, curr_temp, tar_temp, extruder_id? }`
  with `target` = ams_id*4+slot for AMS units (ams_id < 16) and `target` = ams_id for AMS HT / external
  (tray index 0 is special-cased the same way); unload = the same command with
  `target: 255, slot_id: 255` ("the new protocol to mark unload") where supported, else `print.unload_filament` (or
  the gcode_file fallback OpenBambuAPI notes); retry/done `print.ams_control` (`resume`, `done`;
  ha-bambulab). Gate on `amsSwitchCommand`. Exposed as `trayActions` (Load, Unload) so every tray view
  gets them.
- Calibration: `print.calibration` with the option bitmask (lidar, bed levelling, vibration, motor
  noise) gated per capability; only when idle.
- Home `G28` and jog (ha-bambulab `MOVE_AXIS_GCODE`, `HOME_GCODE`, `EXTRUDER_GCODE`): only when idle,
  step 1/10/50 mm, Z step limited, extruder only above 170 °C.
- Custom G-code (guarded): parent-only panel behind a "I know what I am doing" confirm, blocklist while
  printing (`G28`, `G29`, `M84`, `M502`, `M500`…; list in code with reasons), line limits from
  `print.gcode_line`.
- Skip objects: `print.skip_objects { obj_list: [identify ids] }` (OpenBambuAPI), while RUNNING/PAUSE,
  only when `firmwareSupport.partSkip` is true or unknown (older firmware without the bit: allow, as
  ha-bambulab does).
  Object picker: for jobs sent from the app, read the job's `.gcode.3mf`: `Metadata/slice_info.config`
  `<object identify_id name skipped>` and `Metadata/plate_<n>.json` (`bbox_objects`) plus
  `Metadata/pick_<n>.png` for a clickable plate map (verify file names in Bambu Studio
  `bbs_3mf.cpp` `_add_bbox_file_to_archive`); already skipped (`s_obj`) shown struck through. For prints
  started elsewhere: list from the report only, no picture.
- Print options `print.print_option` (auto recovery, sound, air print/tangle/blob detect, door-open
  check where supported; read the field names from Bambu Studio's six `print_option` builders at the tag)
  and AI detector toggles `xcam.xcam_control_set` (module names from OpenBambuAPI) with "halt on error"
  choice.
- Must: speed, lights, temperatures, fans, pause/resume/stop on the page, AMS load/unload, skip objects
  from the report list. Stretch: skip-objects plate picture, calibration, jog pad, custom G-code panel,
  airduct, buzzer.

**UI.** Printer panels: "Controls" (main, order 30: speed, lights, temps, fans, home/jog pad,
calibration), "Skip objects" (main, shown only while printing a file with objects), "Detectors"
(side). Every control disabled with a reason when the capability is missing, the printer is busy, or
Developer Mode is off. Dangerous actions use `ConfirmDialog`. Never visible in kid mode.

**Owns** `defs/controls.ts`, `modules/controls/*` (plate-map reader, guards), `components/controls/*`,
`client/modules/controls/ui.ts`, `routes/api/printers/[id]/objects/*` (object list + pick image),
`sim/features/controls.ts`. **May touch** `sim/features/index.ts` (+1 line). No DB.

**Simulator.** Speed changes scale print time; lights/fans/temps reflect in reports; skip objects adds
to `s_obj` and shortens the job; calibration plays a stage sequence; gcode_line parsed for M104/M140/
M141/M106/G28 only; the new-protocol commands above are answered and reflected; per-model `fun` values
come from the fixtures so both branches (MQTT command vs G-code) are exercised across the fleet.

**Tests.** Every builder vs a golden payload with source; guard tables (limits, states, capability);
plate map parser against a `fakeSliced` extended with bbox JSON; simulator round trips.

**Acceptance.** On the simulated X2D, P1S, A1 mini: each control either works (report reflects it) or is
disabled with the right reason (e.g. no chamber temperature on P1S, no work light on A1).

### 5.3 `camera` — live view, snapshots, timelapses

**Goal.** Live camera for every model, a snapshot API for other packages, timelapse/recording browser.

**Protocols** (section 8.4, cite in code):

- Which path: from the live report, as Bambu Studio does (`status.camera.lanLiveview`, 4.3.2):
  `rtsps` → RTSPS on 322, `rtsp` → plain RTSP on 554 (ClusterM `research/06.05-rtsp.md`), `local` or
  a `jpeg6000` model → port 6000 JPEG, `disabled` → "Turn on LAN Only Liveview on the printer"
  (P2S, X2D, H2 all report `disable` until it is switched on; see 4.1), no report yet → catalogue
  default. Always build the URL from the registry host, never from the host inside `rtsp_url`.
- RTSP(S) `rtsps://bblp:<code>@<host>:322/streaming/live/1` (Digest auth, live555 server, H.264; RTCP
  receiver reports expected, which ffmpeg sends). Pipeline: one `ffmpeg` per printer
  (`-rtsp_transport tcp -i <url> -an -c:v mjpeg -q:v 6 -r 10 -f mpjpeg -`), fanned out to all viewers,
  stopped 30 s after the last viewer. TLS: ffmpeg cannot apply our CN/pin policy, so before starting
  ffmpeg open one `node:tls` connection to 322 with `printerTlsOptions` and refuse if it fails.
  Keep the access code out of logs; the URL with the code is visible to local `ps` while ffmpeg runs:
  document it in code, and prefer (Stretch) a small in-process RTSP-over-TLS client that depacketises
  H.264 (RFC 6184) and pipes Annex B to `ffmpeg -f h264 -i -`, which keeps the code inside our process.
- JPEG over TLS on port 6000 for `'jpeg6000'` models: `node:tls` connect with `printerTlsOptions`
  (4.2.3), send the 80-byte auth packet (`0x40`, `0x3000`, 0, 0, 32-byte username `bblp`, 32-byte
  access code), read 16-byte headers (payload size LE) + JPEG (`FF D8` … `FF D9`), reconnect with backoff.
  On other models port 6000 is the file tunnel (different handshake; the wrong one closes the session:
  ClusterM `research/06.04-port-6000.md`), so never probe it to detect a camera.
- Browser: `GET /api/printers/[id]/camera/stream` as `multipart/x-mixed-replace` (works under the
  existing CSP `img-src 'self'`), `GET /api/printers/[id]/camera/snapshot.jpg`.
- `CameraService.getSnapshot()` returns the newest frame not older than `maxAgeMs` (default 2000),
  starting a short-lived session when none runs.
- Timelapse/recordings: extend `ftp.ts` with `list(dir)` (MLSD, falling back to LIST parsing) and
  `download(path, onProgress, signal)`, keeping the TLS session reuse the printer requires. Browse
  `/timelapse` (ha-bambulab `media_sources.py` uses it) and thumbnails if present; stream downloads to
  the browser (no full buffering) at `/api/printers/[id]/files?dir=` and `/api/printers/[id]/files/download?path=`
  (path validated against the listed directory; no `..`).
- Newer models may keep timelapses on internal storage reachable only through the port-6000 file
  tunnel (`LIST_INFO` with `{"api_version":2,"notify":"DETAIL","type":"timelapse"}`, `FILE_DOWNLOAD`;
  ha-bambulab `pybambu/media_sources.py` `Tcp6000MediaSource`, ClusterM `06.04-port-6000.md`; H2S
  01.02.00.00 rejected `LIST_INFO` per OpenBambuAPI `lan-file-tunnel.md`). Stretch: implement it as a
  second media source behind the same endpoints; Must: when FTPS finds nothing on an `rtsps` model,
  say "This printer keeps timelapses where the app cannot reach them yet".
- Commands: `camera.ipcam_timelapse`, `camera.ipcam_record_set` (OpenBambuAPI) as toggles; resolution
  `camera.ipcam_resolution_set` only if you verify its fields in Bambu Studio `DeviceManager.cpp`.
- Must: live view (both paths), snapshot API, FTPS timelapse list/download. Stretch: port-6000 file
  tunnel, card thumbnails, delete, "Print again" for 3MF files found on the printer
  (`print.project_file:storage` def in `defs/camera.ts`, url per `printUrl`).

**UI.** Printer panel "Camera" (main, order 5): live image, fullscreen, snapshot download, "Camera off"
states with reasons (LAN liveview off, Developer Mode, printer offline, ffmpeg missing). Printer card
shows a small live thumbnail (snapshot every 10 s) only when the user enabled "Show camera on cards".
Page `/printers/[id]/media` (a `printerTabs` entry "Media"): timelapses and recordings with
thumbnails, size, date, download, delete (only if the protocol supports it; otherwise no delete).

**Owns** `modules/camera/*`, `components/camera/*`, `routes/api/printers/[id]/camera/*`,
`routes/api/printers/[id]/files/*`, `routes/printers/[id]/media/*`, `defs/camera.ts`,
`sim/features/camera.ts`, fixture JPEGs. **May touch** `printer/ftp.ts` (add list/download only),
`printer/ftp-server.ts` (LIST/RETR for the simulator), `sim/features/index.ts` (+1 line),
`Permissions-Policy` stays `camera=()` (we do not use the browser camera). Migration slot 0016 only if
you need a cache table (prefer none).

**Simulator.** A port-6000-style frame server per simulated printer, bound to 127.0.0.1 (plain TCP
when TLS is off),
serving generated frames: pre-rendered small JPEG fixtures cycling, or `ffmpeg -f lavfi testsrc` when
available. RTSPS models in the simulator report `ipcam.rtsp_url` pointing at the same frame server
flagged so the camera module uses the JPEG path in simulation (document this simplification). FTP
server serves a fake `/timelapse` folder.

**Tests.** Port-6000 framing parser (chunked input, bad sizes), auth packet bytes, MJPEG multipart
writer, ffmpeg argument builder, FTP list parsing (MLSD and Unix LIST), path validation, snapshot
caching.

**Acceptance.** `dev:sim`: live view on all three simulated printers, snapshot endpoint returns a JPEG,
timelapse list downloads a file; missing ffmpeg shows a clear setup hint for RTSPS models.

### 5.4 `ams` — AMS and spool inventory sync

**Goal.** The AMS and the Filament page agree: trays map to spools, Bambu RFID spools appear by
themselves, usage is charged per tray, tray settings are editable, drying is controllable.

**Scope.**

- Matching: tray ↔ spool by RFID `tray_uuid` (then `tag_uid`), else brand + material + colour distance
  (`colorDistance`) with user confirmation. Links in `ams_links` (printer_id, tray global, spool_id,
  linked_at, last_remain, last_uuid). Unmatched Bambu RFID tray → "Add to Filament" one click
  (brand "Bambu Lab", material `tray_type`, colour, `tray_sub_brands`, weight from `tray_weight`,
  remaining from `remain` %).
- Usage per tray: on `print.finished|failed` use the job's `dispatch.amsMapping` + the plate's
  per-filament grams from `SlicedInfo` to charge each linked spool (table `spool_charges` (id, job_id,
  spool_id, grams, tray) so edits/deletes refund exactly, like `Lab.settle`). For failed prints charge
  proportionally to progress. RFID spools: reconcile with `remain` deltas when they disagree by > 10 %
  (show, do not silently overwrite). Manual jobs keep today's single-spool path in `Lab`.
- Tray settings: `print.ams_filament_setting` (ams_id, tray_id, tray_info_idx, tray_color RRGGBBAA,
  nozzle_temp_min/max, tray_type; OpenBambuAPI; Bambu Studio `command_ams_filament_settings` also sends
  `setting_id`, multi-colour `tray_colors` and `tray_ctype`, and for external spools `tray_id` 254: read it
  at the tag and match it) from a dialog prefilled from the linked spool; `print.ams_get_rfid` re-read
  (`amsReadRfid`); `print.ams_user_setting` in Bambu Studio's form (`ams_id: -1` = all units,
  `startup_read_option`, `tray_read_option`, `calibrate_remain_flag`; `DeviceManager.cpp` ~1675).
- Drying (capability `amsDrying`/`amsDryingSettings`): `print.ams_filament_drying` (ha-bambulab
  `AMS_FILAMENT_DRYING_TEMPLATE`: temp, duration, humidity, mode, rotate_tray, filament,
  cooling_temp, close_power_conflict) start/stop; status from `dry_time`/`dry_setting`.
- Humidity display (index and %), AMS temperature, model (AMS / Lite / 2 Pro / HT).
- Spoolman (opt-in integration): settings URL + optional token; import spools, keep `spoolman_id`, push
  usage (`PUT /api/v1/spool/{id}/use` with `use_weight`; verify against Spoolman's OpenAPI at
  `<url>/api/v1/docs`), pull remaining weights on demand. Off by default; nothing sent until enabled.
- Tray numbers are `GlobalTray` (4.3.2) everywhere, including A2L trays 24–27 and external spools
  254/255; `ams_links` keys on them.
- Must: matching and links, RFID "Add to Filament", usage charging/refunds, tray settings dialog,
  humidity/temperature display. Stretch: drying controls, Spoolman.

**Schema** (`db/tables/ams.ts`, migration 0007): `ams_links`, `spool_charges`; `spools` gains
`rfid_uuid`, `rfid_tag`, `bambu_info_idx`, `spoolman_id` (nullable). Adding columns to `spools` is an
allowed exception: edit `db/tables/core.ts` `spools` only with these four columns.

**UI.** Printer panel "AMS" (side, order 20, `id: 'ams-sync'`, `replaces: 'ams'`, the foundation's `AmsView`):
units with humidity, drying controls, trays with colour, material, remaining, linked spool, "Link",
"Settings", and every registered `trayActions`. `/filament`: each spool shows where it is loaded;
`spoolFormFields` adds RFID/Spoolman fields. Settings section "Spoolman" (group integrations).

**Owns** `modules/ams/*`, `components/ams/*`, `routes/api/printers/[id]/ams/*`, `routes/api/spoolman/*`,
`defs/ams.ts`, `sim/features/ams.ts`, `db/tables/ams.ts`. **May touch** `db/tables/core.ts` (spools
columns only), `routes/filament/+page.svelte` (loaded-in badge only), `sim/features/index.ts`.

**Simulator.** Multiple AMS units per model (AMS on X2D, AMS Lite on A1 mini, AMS 2 Pro + HT option),
RFID trays with uuids, remain decreasing, humidity drift, drying state machine, tray setting command
updates the tray.

**Tests.** Matching (uuid, fallback, ambiguity), charge/refund maths with mapping, failed-print
proportion, drying builder, Spoolman client against a fake HTTP server.

**Acceptance.** A simulated RFID spool appears as a suggested spool; after a two-colour print both
linked spools drop by the sliced grams; deleting the job refunds them.

### 5.5 `notifications` — notification centre and channels

**Goal.** Tell people what matters, where they want it, only when they opt in.

**Scope.**

- In-app centre: bell in the top bar (`topBarItems`) with unread count, list, mark read/all, link to the
  printer/job. Stored in `notifications` (id, event, level, title, body, printer_id, job_id, link,
  created_at, read_at); keep the last 500.
- Desktop OS notifications in Electron: `desktop/main.cjs` sets `globalThis.printLabDesktop = { notify(title, body, link) }`
  (using Electron `Notification`, click focuses the window and navigates) before importing the server;
  the module uses it when present and enabled.
- Channels (each opt-in, each with a test button and per-event toggles): ntfy (server URL default
  `https://ntfy.sh`, topic, optional token; `POST <server>/<topic>` with `Title`, `Priority`, `Tags`
  headers), Discord webhook (`POST` JSON `{ content, embeds }`), Telegram bot
  (`POST https://api.telegram.org/bot<token>/sendMessage { chat_id, text }`), generic webhook (`POST` JSON
  `{ event, at, data }` with optional `X-PrintLab-Signature: sha256=<hex HMAC>`), email via SMTP only if
  a minimal `node:tls`/`node:net` client (STARTTLS, AUTH PLAIN/LOGIN) fits in about 200 lines with tests
  against a fake SMTP server; otherwise skip email and say so. Verify each API's current docs and cite.
- Events: `print.finished|failed|cancelled|paused`, `hms.raised` (severity filter), `ams.runout`,
  `printer.offline` (after 2 min), `request.created` (kid asked), `queue.*` and `maintenance.due` when
  those packages exist (subscribe by name; unknown names are fine), plus `NotifyService.notify()` for
  others. Templates per event with `{{printer}}`, `{{task}}`, `{{job}}`, `{{percent}}`, `{{error}}`,
  `{{kid}}` placeholders, editable, with defaults in plain words. Quiet hours per channel. Snapshot
  attachment (camera, if present) opt-in per channel where the API supports it.
- Privacy: every external channel sends text (and, if enabled, a picture of the inside of the home) to
  a third party. The channel setup says so in one plain sentence, snapshots are off by default and
  never attached for kid-owned jobs unless a parent enables "Include pictures of kids' prints", and
  `{{kid}}` renders the profile's display name only. Channel secrets (tokens, webhook HMAC secret,
  SMTP password) are write-only in the API (`hasToken`). Default ntfy server is `https://ntfy.sh`
  (public): recommend a random topic (generated) and say that anyone who knows it can read it.
- Must: in-app centre, desktop notifications, ntfy, generic webhook. Stretch: Discord, Telegram, SMTP.

**Owns** `modules/notifications/*`, `components/notifications/*`, `routes/api/notifications/*`,
`db/tables/notifications.ts`, migration 0008. **May touch** `desktop/main.cjs` (the bridge only).

**Tests.** Template rendering, per-event routing, quiet hours, each channel's request shape against a
local fake server, signature HMAC, retention.

**Acceptance.** A simulated failed print creates an in-app notification and (with a local fake ntfy
server in tests) one channel request; disabled channels send nothing.

### 5.6 `slicer-engine` — Print Lab Slicer engine

This package answers the user's explicit request: stay modular so the Bambu Studio fork is easy to keep
up to date. The modularity rules below are **hard requirements**.

**Goal.** A headless engine `printlab-slicer` built from Bambu Studio's libslic3r at a pinned release,
speaking the Slicer Engine Protocol (4.7.1), plus the TypeScript client and a CLI fallback so the app
slices today on every model.

**Priorities** (the native build takes hours and may not finish; order the work so the user's
modularity request is met even then):

1. Must: the `slicer/` layout, `upstream.lock` format, `scripts/upstream.sh` (fetch, rebase with
   `--report`, export, status) with a shell test that rebases a toy patch across two tags, `UPSTREAM.md`
   with the full update procedure, the empty-or-minimal patch queue, `slicer-upstream.yml`.
2. Must: TypeScript `StdioEngine` tested against a **fake engine** (`app/src/lib/server/slicer/__fixtures__/fake-engine.mjs`,
   a small node script speaking protocol v1 with canned results, progress and cancel), and `CliEngine`
   covering every catalogue model, so the app slices without the native engine.
3. Should: the C++ engine (facade, rpc, build) and golden tests.
4. Stretch: `slicer-build.yml` matrix and desktop bundling.

**Layout (all new, owned by this package).**

```
slicer/
  UPSTREAM.md            pinned tag + commit, policy, update procedure (step by step)
  upstream.lock          created by the foundation; key=value lines, `#` comments (machine-readable):
                           name=BambuStudio
                           url=https://github.com/bambulab/BambuStudio.git
                           tag=v02.08.02.61
                           commit=926a7192574bcb9b3a732e1ec59a46d79cb45466
                           queue=0            (patch-queue version, bumped by `export`)
                           queue_hash=        (sha256 over the series file + patches, empty when none)
  orca.lock              same format for OrcaSlicer (slicer-calibration's ports; created then)
  ports/                 ORIGINS.md: every file ported from upstream or Orca, with source path + commit
  patches/series         ordered patch file names
  patches/0001-….patch   git format-patch output; header explains why + "Upstreamable: yes/no"
  rr-cache/              committed git rerere resolutions (linked into .upstream/.git/rr-cache)
  engine/CMakeLists.txt  our CMake project; consumes upstream via add_subdirectory(… EXCLUDE_FROM_ALL)
  engine/src/main.cpp    stdio setup (protocol fd, stdout→stderr redirect), loop
  engine/src/rpc/        json-rpc framing, dispatcher, method handlers (talk only to facade/ and features/)
  engine/src/facade/     the ONLY code that includes upstream headers:
                         ModelIO (3MF load/store, meshes), Presets (PresetBundle, resolve), Arrange, Orient,
                         Slice (Print, progress, cancel), Export (gcode.3mf with metadata), Preview (layer data), Version
  engine/src/features/   our own modules: thumbnails (CPU rasteriser for plate/no-light/top/pick images),
                         analysis/, calib/ (wave 2 slicer-calibration)
  engine/tests/          C++ unit tests (ctest) for rpc framing and facade smoke tests
  scripts/upstream.sh    fetch | rebase | export | build | test | resources | status
  scripts/build-deps.sh  upstream deps superbuild with headless options
  tests/golden/          small fixture projects (*.3mf) + expected.json with tolerances
  .gitignore             .upstream/ .build/ dist/
```

**Modularity rules.**

1. Our code lives outside the upstream tree. `slicer/.upstream` (never committed) is materialised by
   `upstream.sh fetch` at the tag in `upstream.lock`.
2. Patch queue: minimal, numbered, `git format-patch` style, each with a header: why it exists,
   upstreamable or not, files touched. Prefer build-system patches (headless build, consuming the tree
   via `add_subdirectory` e.g. `CMAKE_SOURCE_DIR` → `PROJECT_SOURCE_DIR`) and generic extension points
   over logic edits. Target: a handful. Patches exist only when the build proves the need: first try
   upstream options (`SLIC3R_GUI=OFF`, `SLIC3R_BUILD_TESTS=OFF`, deps `DEP_BUILD_WXWIDGETS=OFF`,
   `DEP_BUILD_GLFW=OFF`, `DEP_BUILD_FFMPEG=OFF`, `DEP_BUILD_LIBHARU=OFF`… all exist at the tag).
3. One facade: nothing outside `engine/src/facade/` includes upstream headers or names upstream types;
   facade headers expose our own plain structs (mirroring `protocol.ts`). Upstream API churn is fixed
   in one place.
4. Our features are modules in `engine/src/features/`, not patches. A feature that genuinely needs an
   engine change gets its own isolated patch series (named `1xxx-<feature>-…` so the base queue stays
   small).
5. `upstream.sh`:
   - `fetch [<tag>]`: `git init slicer/.upstream`, `git fetch --depth 1 <url> tag <tag>`, branch `printlab`
     at the tag, tag `printlab-base`, `git am --3way` the series (committer "Print Lab patch queue"),
     link `rr-cache`. Idempotent (skips when already at tag with the same patch hashes).
   - `rebase <new-tag>`: `rerere.enabled=true`, `rerere.autoupdate=true`, fetch the new tag (depth 1),
     `git rebase --onto <new-tag> printlab-base printlab`; on conflict stop with clear instructions
     (resolve, `git add`, `git rebase --continue`, then `export`); `--report <file.json>` mode (for CI)
     aborts on conflict and then tests each remaining patch with `git apply --check --3way` to list every
     patch that fails.
   - `export`: `git format-patch --zero-commit --no-signature -o slicer/patches printlab-base..printlab`,
     rewrite `series`, bump `queue` and update `upstream.lock`/`UPSTREAM.md`.
   - `build [--deps-only] [-j N]`: deps into `${PRINTLAB_SLICER_BUILD_DIR:-slicer/.build}/deps` (cache key =
     tag + hash of `deps/` + platform), then
     `cmake -S slicer/engine -B $BUILD/engine -DPRINTLAB_UPSTREAM_DIR=slicer/.upstream`
     `-DCMAKE_PREFIX_PATH=$BUILD/deps/usr/local -DCMAKE_BUILD_TYPE=Release` (Makefiles; ninja is not
     installed here), install to
     `slicer/dist/<plat>/` with `resources/` (profiles/BBL + BBL.json, printers/, and whatever libslic3r
     needs at runtime).
   - `test`: ctest, then `cd app && PRINTLAB_SLICER_PATH=… bunx vitest --run src/lib/server/slicer/`.
   - `resources`: copy `resources/profiles/BBL*`, `resources/printers`, `resources/hms` from `.upstream`
     into `slicer/dist/<plat>/resources` and `app/resources/bambu/` (git-ignored; used by slicer-profiles
     and hms builders when present).
   - `status`: tag, commit, patch count, dirty state.
6. Golden tests independent of the upstream version: slice fixture projects for X1C, P1S, A1 mini, H2D,
   X2D; compare layer count (exact), estimated time and filament grams (±3 %), header metadata
   (`printer_model_id`, `nozzle_diameters`, `X-BBL-Client-Version`, plate count, md5 present) and
   protocol conformance (hello, capabilities, error codes, cancel). Expected values live in
   `tests/golden/expected.json`, updated deliberately with a reason line.
7. `.github/workflows/slicer-upstream.yml`: weekly cron + manual; finds the latest **non-prerelease**
   Bambu Studio release (`gh api repos/bambulab/BambuStudio/releases/latest`; note newer tags such as
   `v02.08.04.57` exist that are not "latest"), compares with `upstream.lock`; if newer: fetch (old),
   rebase (new) with `--report`, build (Linux), golden tests; then regenerate **all upstream-derived
   data** at the new tag in the same branch: `gen-printer-models.ts --strict` (new model codes are
   listed in the PR body), `hms:build`, `profiles:fetch` + slicer-profiles' resolution tests, and the
   facade compile (each step runs only when its script exists, since packages merge in any order).
   Success → `export` and open a PR "Slicer: Bambu Studio <tag>" (golden diff, data
   diff summary, patch-queue changes); failure → open or update an issue listing the failing
   patches/tests/steps. Uses `GITHUB_TOKEN` only; PRs opened with it do not trigger other workflows,
   so this workflow runs every check itself and says so in the PR body (a maintainer can re-run CI by
   pushing).
8. The engine reports upstream tag/commit, patch-queue version/hash/names and capabilities in
   `engine.hello`; the TS client requires `protocol.major === 1` and gates features on capabilities.
9. Profiles come from the same pinned tag: the engine bundle ships them and reports
   `profiles.dir`/`vendorVersion`; slicer-profiles prefers them.
10. One pin, one helper: `slicer/upstream.lock` is the only place the Bambu Studio version is written.
    `app/tools/lib/upstream.ts` (foundation) reads it (and throws when it is missing: there is no
    second copy of the pin) and serves files from a git checkout (`slicer/.upstream`, or `--from`)
    read at exactly the locked commit (`git show <commit>:<path>`, so a stale or mid-rebase checkout
    cannot label one version's data as another's; a checkout without that commit is refused), else
    from `raw.githubusercontent.com/<owner>/<repo>/<commit>/<path>` (owner/repo from the lock's `url`)
    into a cache under `slicer/.build/upstream-cache/<commit>/` (git-ignored, outside `app/resources`
    so it never ships in the desktop bundle). The model catalogue, HMS builder, profile fetcher and
    engine build all use it, so bumping the lock moves everything together. A test asserts that
    `UPSTREAM_PRINTERS` in `models.generated.ts` equals the lock's tag and commit.
11. Ports are tracked: any file adapted from Bambu Studio or OrcaSlicer (calibration generators, paint
    codec, 3MF constants) records `origin: <repo> <path> @ <commit>` in a header comment and a row in
    `slicer/ports/ORIGINS.md`; `upstream.sh ports` lists which origins changed between the recorded
    commit and the current pin, so ported TypeScript/C++ gets reviewed on each update too.
12. A GitHub fork is optional, never the source of truth. If the team wants a browsable fork,
    `upstream.sh export --push <remote>` may push branch `printlab/<tag>` (upstream tag + our series) to it; the
    patch queue in this repo stays authoritative and reviewable in normal PRs.

Never use, link or ship Bambu's proprietary `bambu_networking` plugin or anything from `src/slic3r`
(GUI). A CI step fails the build if the binary references `bambu_networking` or `NetworkAgent`.

**Build here.** Build on this machine (8 cores, 15 GB RAM): `-j6`, build output under
`/tmp/claude-1000/-home-wd29-pc-dev/83e6fd4a-d275-4c10-8a81-cfca49daeb99/scratchpad/slicer-build`
(set `PRINTLAB_SLICER_BUILD_DIR` to it) so reviewers reuse it. Long steps (deps: Boost, TBB, OpenVDB,
CGAL/GMP/MPFR, OCCT, OpenCV, assimp, freetype… — hours) run with `run_in_background` and are polled.
If the full native build cannot finish, deliver everything else, record exactly how far it got and the
remaining commands in `UPSTREAM.md` and the report. Do not claim a working engine you have not run.

**Engine implementation notes.** Thumbnails: upstream's CLI renders thumbnails with OpenGL; we render
plate images with our CPU rasteriser in `features/thumbnails` and pass them to upstream's 3MF store
through the facade (its store parameters accept thumbnail data), so no GL is needed. Progress: upstream
print status callback → `$/progress`. Cancel: upstream print cancel. Painting: load/store via upstream's
3MF code so encoding is Bambu's own. Preview: walk upstream's G-code processor result (or the
generated G-code) in `facade/Preview` and write the 4.7.3 container.

**TypeScript.** `app/src/lib/server/slicer/engine.ts`: `StdioEngine` (spawn, NDJSON framing, request
ids, `$/progress` routing, `$/cancel` on abort, timeouts, restart on crash, idle shutdown after
10 min, one process shared), `CliEngine` (fallback): implements `slice`/`export.gcode3mf`/`arrange`/
`orient`/`profiles.resolve` by writing a 3MF (via slicer-3mf's writer once merged; until then the
existing STL path) and running the stock CLI (`--slice`, `--export-3mf`, `--arrange`, `--orient`,
`--load-settings`, `--load-filaments`, `--curr-bed-type`; read `result.json`), covering **every model**
in the catalogue (machine preset `"<model name> <nozzle> nozzle"`, model id from the catalogue) and
removing the X2D hard-code. `slicer/service.ts` (new) is what `PrintFiles.sliceJob` calls;
`slicer.ts` shrinks to profile flattening helpers the CLI backend needs, or is deleted if unused.
Integrations row "Print Lab Slicer" (engine version, upstream tag, backend in use).

**CI/desktop.** `.github/workflows/slicer-build.yml` (push on `slicer/**`, manual, `workflow_call`):
matrix `ubuntu-22.04` (x64, older glibc), `windows-2022` (x64), `macos-14` (arm64; x64 via
`CMAKE_OSX_ARCHITECTURES=x86_64` if feasible), deps cached with `actions/cache`, artifact
`printlab-slicer-<plat>` (binary + resources + LICENSE + `engine.json` with versions). `release.yml`
calls it and copies artifacts into `slicer/dist/<plat>` before `prepare-server`; a failed engine build
does not block a desktop release (the app falls back to the CLI). `desktop/scripts/prepare-server.mjs`
copies `slicer/dist/<plat>` to `desktop/server/engine` when present.

**Owns** `slicer/**` (the foundation created `slicer/upstream.lock`; this package owns it from now on),
`app/src/lib/server/slicer/**` (except the foundation's `locate.ts`, which it may
extend), `.github/workflows/slicer-*.yml`, `modules/slicer-engine/*`. **May touch** `printing.ts`
(`sliceJob` → service), `integrations.ts` (remove the old slicer row in favour of the module's),
`desktop/scripts/prepare-server.mjs`, `.github/workflows/release.yml`, `app/tools/lib/upstream.ts`
(additive helpers only), `app/package.json` (script `slicer:build` only). The ignore lines already
exist (foundation); tell the merger if more are needed rather than editing `.gitignore`. No DB.

**Tests.** TS (against the fake engine): framing (partial lines, huge lines, stray stderr), negotiation (major mismatch → error,
missing capability → `CAPABILITY_MISSING` locally), cancel, crash/restart, CLI backend argument
building per model, result parsing, golden tests gated on an engine (skipped otherwise). C++: rpc
framing and facade smoke tests.

**Acceptance.** Without an engine, jobs slice via the stock CLI for P1S/A1 mini/X2D presets (where the
CLI is installed; skipped tests otherwise). With the engine built, `engine.hello` reports versions and
capabilities, golden tests pass, and a sliced file prints on the simulated printer of the right model.
`UPSTREAM.md` has the complete update procedure.

### 5.7 `slicer-3mf` — Bambu-compatible project files

**Goal.** Read and write Bambu Studio / OrcaSlicer project 3MF in TypeScript, losslessly, into the
foundation's `Project` model, which this package now owns.

**Scope.** Parse and write: `3D/3dmodel.model` + `3D/Objects/object_N.model` (production extension
`p:path`, `p:UUID`), components and build items, `Metadata/model_settings.config` (objects, parts
with `name`, `volume_type`/part type, `extruder`, `matrix`, `source_*`, per-object/per-part config
keys, plates with instances and metadata `bed_type`, `print_sequence`, `spiral_mode`, `filament_maps`,
`thumbnail_file`…), `Metadata/project_settings.config` (JSON), `Metadata/plate_N.png` etc.,
`Metadata/layer_heights_profile.txt`, `layer_config_ranges.xml`, `custom_gcode_per_layer.xml`,
`cut_information.xml`, `filament_sequence.json`, painting attributes `paint_supports`, `paint_seam`,
`paint_color`, `paint_fuzzy_skin` on triangles, metadata (Title, Designer, License, Origin…), and keep
everything else byte-for-byte in `passthrough`. Constants from Bambu Studio
`src/libslic3r/Format/bbs_3mf.cpp` at the pinned tag (cite line numbers). Also read PrusaSlicer-style
and plain 3MF (single mesh → one object).

- Paint codec: `shared/slicer/paint.ts` decodes/encodes the per-triangle TriangleSelector strings
  (port the (de)serialisation of upstream `TriangleSelector`) so slicer-ui can paint; round-trip tests.
- Storage: `slicer_projects` table (id, project_id FK projects cascade, name, file, revision, created_at,
  updated_at; migration 0018) and `ProjectStore` service saving `.3mf` under `data/slicer-projects/`
  with meshes content-addressed under `data/slicer-meshes/<sha256>.stl` (swept like models).
- Endpoints: `POST /api/slicer-projects` (create from model versions or upload),
  `GET/PUT /api/slicer-projects/[id]` (Project JSON), `GET /api/slicer-projects/[id]/file` (download 3MF, "Open in
  Bambu Studio"), `POST /api/slicer-projects/import` (upload a 3MF).
- Zip: reuse `cad/mesh.ts` `readZip`/`writeZip` (add streaming/deflate support there only if needed and
  mention it; it is otherwise not a shared hot spot).

**Owns** `app/src/lib/shared/slicer/project.ts` (additive changes), `shared/slicer/paint.ts`,
`app/src/lib/server/slicer3mf/**`, `modules/slicer-3mf/*`, `routes/api/slicer-projects/**`,
`db/tables/slicer-projects.ts`, fixtures `app/src/lib/server/slicer3mf/__fixtures__/`.
**May touch** `cad/mesh.ts` (zip helpers only).

**Fixtures.** Real files produced by Bambu Studio and OrcaSlicer from their repositories (for example
`resources/calib/**` projects and any `*.3mf` under their test data at the pinned tags), each with source
and licence noted; include multi-plate, modifiers, height ranges, painting (supports/seam/colour/fuzzy),
multi-filament, dual-nozzle maps.

**Tests.** Read every fixture; read → write → read deep-equal; untouched passthrough bytes identical;
painting strings preserved; transforms exact; written files validated by the engine's `project.open`
when an engine is available (skipped otherwise).

**Acceptance.** Every fixture round-trips without loss; a project created from a model version opens
in the engine (when available) with the same objects and plates.

### 5.8 `slicer-profiles` — presets like Bambu Studio's

**Goal.** Bambu system profiles plus user presets, resolved exactly as Bambu Studio does, implementing
`ProfileService` (4.7.4).

**Scope.**

- Vendor profiles at the engine's pinned tag: `bun run profiles:fetch` (`app/tools/fetch-profiles.ts`,
  through `app/tools/lib/upstream.ts` so the tag comes from `slicer/upstream.lock`)
  sparse-checks-out `resources/profiles/BBL.json` + `resources/profiles/BBL/` into
  `app/resources/bambu/profiles/` (git-ignored) unless `slicer/.upstream` or an engine bundle provides
  them; lookup order: engine `profiles.dir` → `PRINTLAB_PROFILES_DIR` → `app/resources/bambu/profiles` →
  stock CLI resources (today's behaviour). `prepare-server.mjs` copies them for the desktop (1 line).
- Resolution identical to upstream `PresetBundle::load_vendor_configs_from_json` and friends at the
  tag: `BBL.json` lists (`machine_model_list`, `machine_list`, `process_list`, `filament_list` with
  `sub_path`), `inherits` chains, `instantiation`, `setting_id`, `filament_id`, `compatible_printers`,
  `compatible_printers_condition` (implement the expression subset used by BBL profiles; test that
  every condition string in the vendor set parses), and any other inheritance/include mechanism the
  loader has. Oracle test: when an engine is present compare `resolve()` with engine
  `profiles.resolve` for a sample of presets.
- User presets in DB (`user_presets`: id, kind, name, inherits, config JSON of overridden keys only,
  version, created_at, updated_at; migration 0009), per-job overrides (`jobs.slice_overrides` JSON; an
  allowed column addition in `db/tables/core.ts`), filament presets linked to spools
  (`spools.filament_preset`) and to AMS trays by `tray_info_idx` ↔ `filament_id`.
- Import/export: Bambu user preset `.json` and `.bbscfg` bundles (verify the bundle format in Bambu
  Studio's preset export code at the tag).
- Compatibility filtering by printer model and nozzle; `defaults(model, nozzle, material)` (replaces
  `chooseProfiles` heuristics in the CLI backend; slicer-engine consumes it once merged, until then
  keep both).

**UI.** Settings section "Slicer profiles" (group printing): browse by printer, user presets list,
create from a system preset, edit keys (grouped like Bambu Studio's tabs where feasible, raw key/value
fallback), diff against parent, import/export. Job panel "Slicer settings" (per-job overrides) via
`jobPanels`. Spool form preset field via `spoolFormFields`.

**Owns** `app/src/lib/server/profiles/**`, `modules/slicer-profiles/*`, `components/profiles/*`,
`routes/api/slicer/profiles/**`, `routes/api/slicer/presets/**`, `tools/fetch-profiles.ts`,
`db/tables/presets.ts`. **May touch** `db/tables/core.ts` (`jobs.slice_overrides`,
`spools.filament_preset` only), `app/package.json` (`profiles:fetch` script),
`desktop/scripts/prepare-server.mjs` (copy line).

**Tests.** Inheritance chains, instantiation filtering, condition evaluator over all vendor strings,
diff, user preset save/load, import/export round trip, defaults per model, oracle comparison (gated).

**Acceptance.** For each catalogue model the default selection resolves; a user preset overriding
`sparse_infill_density` diffs correctly and flows into a slice (through slicer-engine once merged).

### 5.9 `gcode-preview` — see the toolpaths

**Goal.** A fast three.js G-code preview for any sliced plate, on the job and before sending.

**Scope.** Server: extract `Metadata/plate_N.gcode` from the `.gcode.3mf` (`readZip`), stream-parse
G0/G1 and G2/G3 arcs (linearise), absolute/relative modes (G90/G91, M82/M83), `; FEATURE:`,
`; LAYER_CHANGE` / `; Z_HEIGHT:` / `; LAYER_HEIGHT:` comments, tool changes (Bambu `M620`/`T<n>` blocks),
M73 progress/remaining for per-layer time (fallback: feed-rate estimate), widths from `; LINE_WIDTH:`
if present; write the 4.7.3 container, cached next to the sliced file (`<file>.plate<N>.preview.bin`,
swept with it). API `GET /api/jobs/[id]/sliced/preview?plate=N` (octet-stream, cache headers). Parse
in a worker thread (`node:worker_threads`) with a background task for large files.
Client: `GcodePreview.svelte` (three.js `LineSegments` with per-segment colour; optional wider
"tube" rendering for the current layer), layer range slider, in-layer move scrubber, colour by
feature / filament / speed, legend toggles, time per layer bar chart, total time and filament.
Shown as a job panel (`jobPanels`) and a SendPanel section (`sendPanelSections`) for the chosen plate.
Budget: plates up to ~5 million segments stay interactive (decimate travel, drop moves < 0.05 mm when
over budget, say so in the UI).

**Owns** `app/src/lib/server/gcode/**`, `components/gcode/**`, `client/modules/gcode-preview/ui.ts`,
`routes/api/jobs/[id]/sliced/preview/*`, `modules/gcode-preview/*`. **May touch** `printing.ts`
(`sweep()` also removes preview caches; 1–2 lines).

**Tests.** Parser on real Bambu G-code fixtures (from a Bambu Studio sliced sample; note source),
arc linearisation, feature mapping, layer boundaries, time per layer, container round trip.

**Acceptance.** The fixture plate previews with correct layer count and feature colours; a 50 MB
G-code parses in the background without blocking requests.

### 5.10 `model-import` — MakerWorld, Printables, Thingiverse, drag and drop

**Goal.** Paste a model page link, get a project with credits, licence, pictures and (where allowed)
the files; drop STL/3MF/OBJ anywhere.

**Scope.**

- `POST /api/imports/url { url }` → preview (site, title, author, author URL, licence, licence URL,
  description, images, files with names and sizes, whether files can be downloaded here);
  `POST /api/imports/url/confirm { url, projectId?, files: [...] }` → creates/updates a project, downloads
  the chosen files into models via `ModelStore`, stores attribution. The path `/api/import` is the
  existing workspace import; do not reuse it.
- Printables: public GraphQL (`https://api.printables.com/graphql/`); verify current query/mutation
  names for model details and download links by inspecting the public site's requests; respect rate
  limits. Thingiverse: REST API `https://api.thingiverse.com/things/{id}` and `/files` with the user's
  own app token (Settings; opt-in). MakerWorld: public page metadata only (Open Graph / embedded JSON),
  then "Download in your browser, then drop the file here" with a drop zone bound to the pending
  import. Every network call only on explicit user action; User-Agent names Family Print Lab.
- Server-side fetching of pasted URLs is an SSRF risk (the server sits on the home LAN, next to
  printers and routers). One fetch helper in the module: `https:` only; host allowlist per site
  (`printables.com`, `api.printables.com`, `media.printables.com`, `www.thingiverse.com`,
  `api.thingiverse.com`, `cdn.thingiverse.com`, `makerworld.com` and the image/file CDNs you verify, each
  cited); resolve DNS and refuse loopback, private, link-local and multicast addresses; follow at most
  3 redirects, re-checking each; timeouts; size caps (HTML 2 MB, images 5 MB, model files 100 MB);
  content-type checks. Tests cover each refusal.
- Licences: show the licence prominently; for NC/ND licences show what that means in plain words;
  never strip attribution; add credit text to the project description and a `project_sources` row
  (project_id, site, url, title, author, author_url, licence, licence_url, images JSON, imported_at;
  migration 0015). Images downloaded (size-capped) and stored as sketches or project pictures.
- Drag-and-drop anywhere: a `globalOverlays` component shows a drop target over the app; dropping
  STL/3MF/OBJ opens "Add to…" (new project or existing) and imports through `ModelStore`. Kid mode:
  not available.

**Owns** `modules/model-import/*`, `components/import/*`, `routes/api/imports/**`,
`db/tables/imports.ts`, `client/modules/model-import/ui.ts`. No shared file edits expected.

**Tests.** URL parsing per site, metadata extraction from saved HTML/JSON fixtures (no live network in
tests), licence classification, download size caps, attribution text.

**Acceptance.** Saved-fixture imports for each site create a project with credits; a dropped STL lands
in the chosen project.

### 5.11 `queue` — multi-printer print queue

**Goal.** Line up jobs per printer or for "any compatible printer" and let them start themselves safely.

**Scope.** `queue_items` (id, job_id unique FK cascade, printer_id nullable FK set null, position,
not_before, require_plate_clear, status 'waiting'|'held'|'dispatching'|'sent'|'failed', reason,
created_at, updated_at) and `queue_printer_state` (printer_id PK, auto_dispatch, plate_clear_needed,
paused); settings: quiet hours (per weekday, start/end), default "require plate cleared" on
(migration 0010). Dispatcher: on `print.finished|failed|cancelled`, `printer.online`, queue changes and
a 30 s tick, pick the first eligible item for each idle printer: printer idle and connected, not paused,
plate confirmed clear (a finished print sets `plate_clear_needed`; the user confirms in the UI or on the
printer page), outside quiet hours, `not_before` passed, file sliced for that printer's model, AMS
mapping from `autoMapping` has no problems (else hold with the reason), then
`rt.printing.send(jobId, { printerId, useAms, amsMapping, wake: true })`, which runs
`hooks.beforeDispatch` (power) inside its task (4.2.5); the queue never calls the hooks itself. An
offline printer counts as eligible only when a `beforeDispatch` hook is registered (`hooks.beforeDispatch.size > 0`).
The item stays `dispatching` until the returned task settles (`sent` / `failed` with its message).
Emits `queue.changed`, `queue.dispatched`, `queue.held` (declared by this package).
`QueueService`. API `/api/queue` (list, add, reorder, remove, hold/release), `/api/queue/printers/[id]`
(auto on/off, plate cleared).

**UI.** `/queue` page (nav "Queue", order 25): columns per printer + "Any printer", drag reorder
(HTML5 drag and drop with keyboard alternative), plate-cleared button, hold/release, reasons shown;
timeline view (SVG, uses estimates, now line, quiet hours shaded). SendPanel section "Add to queue".
Printer panel "Up next".

**Owns** `modules/queue/*`, `components/queue/*`, `routes/queue/*`, `routes/api/queue/**`,
`db/tables/queue.ts`, `client/modules/queue/ui.ts`, `sim/features/queue.ts` (not needed unless you add
a plate-clear simulation).

**Tests.** Eligibility rules table, ordering, quiet hours across midnight, plate-clear flow, "any
compatible printer" choice, holds for AMS mismatches, simulator end-to-end: two jobs dispatch one after
another after plate confirmation.

**Acceptance.** Three queued jobs for two simulated printers dispatch correctly with plate
confirmations and respect quiet hours.

### 5.12 `home-automation` — plugs, MQTT out, Home Assistant, metrics

**Goal.** Power printers on/off automatically and let home automation see the lab, all opt-in.

**Scope.**

- Smart plugs per printer (`plugs`: id, printer_id, kind 'tasmota'|'shelly'|'shelly-rpc'|'homeassistant'|'webhook',
  config JSON, auto_on, auto_off, cooldown_minutes, off_below_nozzle; migration 0011). Tasmota
  `GET http://<ip>/cm?cmnd=Power%20On|Off|Status` (optional user/password), Shelly Gen1
  `/relay/0?turn=on|off`, Gen2+ RPC `/rpc/Switch.Set?id=0&on=true`, Home Assistant REST
  `POST /api/services/switch/turn_on|turn_off` with a long-lived token and `entity_id`, generic webhook
  URLs. Verify each against official docs and cite.
- Auto power-on: `PowerService.ensureOn` registered as a `beforeDispatch` hook (turn on, wait until the
  printer is online, timeout 3 min, honour the hook's `signal`); it only acts for printers with a plug
  and `auto_on`, and returns immediately when the printer is already online. Auto power-off after `print.finished|failed|cancelled` once the
  nozzle is below the threshold and the cool-down has passed and no queue item is due within 15 min.
  Never cut power while printing or while the nozzle is hot.
- Outbound MQTT (opt-in): broker URL, TLS, credentials; publish retained JSON on
  `printlab/<printer-id>/status` and events on `printlab/events/<name>` using `mqtt.ts` (QoS 1, retain
  from the foundation); optional Home Assistant MQTT discovery configs.
- REST for Home Assistant: `GET /api/ha/printers` (flat sensor-friendly JSON), bearer token required
  (generated in Settings) unless the request is from 127.0.0.1.
- Prometheus `GET /metrics` (text format: printer state, temps, progress, AMS humidity, job counts),
  local only by default (127.0.0.1 or token).
- "From 127.0.0.1" means the socket address (`event.getClientAddress()`), never `X-Forwarded-For` or
  `Host`. Tokens are shown once, stored as SHA-256 hashes in the module settings and compared in
  constant time; plug and broker passwords are write-only in the API. Neither endpoint nor the MQTT output
  exposes serials, access codes or IPs (use printer ids and names). With lan-auth on, a
  logged-in session also works.

**UI.** Settings section "Home automation" (plugs per printer with test buttons, MQTT, HA token,
metrics toggle). Printer panel "Power" (on/off with confirmation, auto settings).

**Owns** `modules/home-automation/*`, `components/home-automation/*`, `routes/api/ha/**`,
`routes/metrics/+server.ts`, `routes/api/plugs/**`, `db/tables/plugs.ts`, `sim/features/power.ts`
(printer goes offline/online with a fake plug). No shared file edits expected.

**Tests.** Plug clients vs fake HTTP servers, power-off safety rules, hook timeout, MQTT publish
payloads against the simulator broker, metrics format, token checks.

**Acceptance.** A queued job on a powered-off simulated printer powers it on, prints, and powers off
after cooling; `/metrics` returns valid exposition text.

### 5.13 `kids` — family differentiators

**Goal.** Make printing a family activity with gentle limits and celebration.

**Scope.**

- Limits per child (`kid_limits`: profile_id PK, prints_per_day, prints_per_week, grams_per_week,
  grams_per_month, need_approval_over_grams; migration 0012) enforced when a child asks
  (`/api/kid/things/[id]/ask` checks `KidsService.check(profileId, grams)` before `lab.requestPrint`;
  friendly kid-facing messages) and shown to the parent when approving (requests UI on `/family`).
- Family gallery (`gallery_items`: id, job_id, profile_id, image blob (WebP/JPEG ≤ 400 KB), caption,
  created_at): on `print.finished` for a kid's job, take a camera snapshot if the camera service exists
  and the parent enabled it, else invite a photo upload. `/family/gallery` with filters per child;
  kid pages show their own gallery.
- Badges/milestones (`kid_badges`: profile_id, badge, earned_at, job_id) computed from history (first
  print, 5/10/25 prints, first multi-colour, first design from scratch, week streak…), celebratory UI in
  kid mode.
- Printable certificate `/family/certificate/[jobId]` (print CSS, no PDF dependency).
- Parent dashboard on `/family` (`familyPanels`): per-child activity, limits usage, recent requests.
- Kid mode reads: register `kidReads` for the child's own gallery/badges endpoints.

**Owns** `modules/kids/*`, `components/kids/*`, `routes/family/gallery/*`,
`routes/family/certificate/*`, `routes/api/kids/**`, `db/tables/kids.ts`. **May touch**
`routes/api/kid/things/[id]/ask/+server.ts` (limit check), `routes/kid/**` pages (gallery/badges
sections), `kid/session.ts` only if `kidReads` is not enough (explain).

**Tests.** Limit windows (day/week/month boundaries, time zones), grams estimate, badge rules,
certificate page rendering, gallery capture with and without camera.

**Acceptance.** A child over the daily limit gets a kind "not today" message; a finished kid print
earns a badge, appears in the gallery with a photo (simulated camera), and has a printable certificate.

### 5.14 `analytics` — statistics dashboard

**Goal.** See how the lab is doing: success, filament, cost, machine hours, failures.

**Scope.** `/analytics` (nav "Stats", order 45): success rate over time (weekly), filament grams and
cost by month / material / person (project owner) / printer, machine hours per printer, failure
reasons (HMS/print error text when the hms service exists, else job notes), average print time,
top projects. Filters: date range, printer, person. CSV export `GET /api/analytics/export.csv?…`
(RFC 4180). Charts as small SVG Svelte components (`components/charts/`: Line, Bars, StackedBars, Donut,
Sparkline) with accessible labels and colours from the existing CSS variables; no chart library. SQL
aggregates in `modules/analytics/queries.ts` (tested on a seeded DB).

**Owns** `modules/analytics/*`, `components/analytics/*`, `components/charts/*`, `routes/analytics/*`,
`routes/api/analytics/**`, `client/modules/analytics/ui.ts`. No DB tables (slot 0017 unused unless
a cache is truly needed).

**Tests.** Aggregation queries (cost per gram from spool cost/total, jobs without spools, cancelled
excluded from success rate), CSV escaping, chart scale helpers.

**Acceptance.** With the e2e fixture data the dashboard shows correct numbers matching hand-computed
values; CSV opens in a spreadsheet.

### 5.15 `maintenance` — maintenance tracker

**Goal.** Know when each printer needs care, and what firmware it runs.

**Scope.** `maintenance_tasks` (id, printer_id, kind, label, interval_hours, interval_days,
last_done_at, last_done_hours, notes) and `maintenance_log` (id, task_id, printer_id, done_at,
hours_at, note); `printers_odometer` (printer_id, baseline_hours) (migration 0013). Default tasks per
series from Bambu wiki maintenance pages (cite each URL; if the wiki gives no interval, leave it for
the user to set rather than invent one): e.g. lubricate/clean rods or rails, clean the nozzle wiper,
check belts, clean the build plate, replace carbon filter, AMS desiccant. Print-hours odometer from
`jobs.actual_minutes` per printer + baseline. Reminders: daily check emits `maintenance.due`
(declared here) once per task until done. Firmware: show `status.firmware` modules (OTA version, AMS
versions) and an "Update available" hint from `status.upgrade` (read-only; never flash; link to the
wiki release notes page). Nozzle changes logged as maintenance entries (and `system.set_accessories`
for nozzle type/diameter only if controls did not already add it — coordinate by checking
`commandDef()` at runtime; otherwise just record).

**UI.** Printer panel "Maintenance" (side): due soon/overdue, mark done, odometer. Page
`/printers/[id]/maintenance` (a `printerTabs` entry) with log and task editing. Nozzle info: show
`device.nozzle.info[]` (type, diameter, wear) and, on the H2C, the hotend rack (read-only; Bambu Studio
`DeviceCore/DevNozzleRack.cpp`); `system.set_accessories` per OpenBambuAPI `mqtt.md`
(`accessory_type: "nozzle"`, `nozzle_diameter`, `nozzle_type`) only for single-nozzle printers unless
you verify the dual-nozzle form in Bambu Studio.

**Owns** `modules/maintenance/*`, `components/maintenance/*`, `routes/printers/[id]/maintenance/*`,
`routes/api/printers/[id]/maintenance/**`, `db/tables/maintenance.ts`.

**Tests.** Due computation (hours and days), odometer, reminder de-duplication, default task table has
a source for every interval.

**Acceptance.** After simulated prints add hours, a task becomes due, a notification event fires, and
marking it done resets it.

### 5.16 `lan-auth` — optional login for LAN access

**Goal.** Safe access from other devices on the home network, off by default on 127.0.0.1.

**Scope.** Modes: off (default), household password, per-profile PINs. Required automatically when
`ALLOWED_HOSTS` lists a non-local host or `HOST` is not loopback: until a password is set, non-local
requests get a "Set a password on the computer first" page; loopback stays open unless "Require login
here too" is on. Password hashing `crypto.scrypt` (N=2^15, r=8, p=1, 16-byte salt), constant-time
compare. Sessions (`sessions`: id hash, profile_id nullable, created_at, last_seen_at, expires_at,
user_agent, ip; migration 0014): cookie `print_lab_session` HttpOnly, SameSite=Lax, Secure when the
request is HTTPS, 30-day sliding expiry, logout everywhere. Rate limiting per IP and per account
(5 attempts / 5 min, exponential lockout), no username enumeration. CSRF: keep the existing Origin
same-host check for writes and SameSite cookies; SSE and API require the session. Kid mode stays
PIN-based: a kid profile's PIN logs straight into kid mode; the parent PIN still guards leaving it.
Handle added to `HANDLES` (4.6.2). Settings section "Access from other devices" (group privacy) with
session list.

**Owns** `modules/lan-auth/*`, `components/auth/*`, `routes/login/*`, `routes/api/auth/**`,
`lib/server/hooks/auth.ts`, `db/tables/auth.ts`. **May touch** `lib/server/hooks/index.ts` (+1 line),
`kid/session.ts` (allow the login route), `.env.example` (document).

**Tests.** Hashing, session lifecycle, rate limiter, hook decisions table (local/non-local × mode ×
path), CSRF interplay, kid PIN login; e2e on a non-local Host header.

**Acceptance.** Default desktop use is unchanged; with `ALLOWED_HOSTS=printlab.local` requests from that
host need a login; brute force is throttled.

---

## 6. Wave 2 work packages

Built after every wave-1 package is merged. Same conventions as section 5.

### 6.1 `ai-vision` — AI print-failure checks

**Goal.** Catch spaghetti, detachment and blobs early from camera snapshots, opt-in.

**Scope.** Settings (off by default): provider (existing `ai/providers.ts`; all three providers
accept an image), check every N layers and/or M minutes, confidence threshold, "Pause the print when
sure" (off by default; uses `print.pause`), per-printer enable. On `print.layer`/timer: `CameraService.getSnapshot`,
build a prompt with job context (object name, layer/total, material, elapsed), ask for strict JSON
`{ verdict: 'ok'|'spaghetti'|'detached'|'blob'|'unsure', confidence: 0..1, reason }`, validate with zod,
store in `vision_checks` (id, printer_id, job_id, layer, at, verdict, confidence, reason, provider,
frame file; migration 0021; frames pruned after 14 days), emit `vision.alert` (declared here) above the
threshold, optional auto-pause. Local heuristic mode without deps: decode frames to small greyscale with
`ffmpeg` (`-f rawvideo -pix_fmt gray -s 160x120`) and flag sudden texture/edge-density changes versus the
first-layer reference; label it clearly as a rough check. Kid-safe: nothing is sent unless a parent
enabled a provider. UI: printer panel "AI check" (last result, frames strip), history page, notifications
via the event.

**Owns** `modules/ai-vision/*`, `components/vision/*`, routes under `api/printers/[id]/vision/**`,
`db/tables/vision.ts`. **Tests** prompt/response validation, scheduling, threshold/auto-pause logic,
heuristic on fixture frames. **Acceptance** simulated frames with an injected "spaghetti" frame (fixture)
trigger an alert with the local heuristic and with a mocked provider.

### 6.2 `cloud-remote` — the phone sees and controls printers (both repos)

**Goal.** Opt-in, parent-authorised remote view and control from the phone PWA, with end-to-end
encrypted camera snapshots.

**Protocol v2** (extend `docs/cloud-protocol.md`; `hello.protocol: 2`; the cloud accepts 1 and 2 and
keeps v1 behaviour for old apps):

- App → cloud `{"type":"printers","printers":PrinterSummaryV2[]}` (replaces `printer` for v2; each has
  `id`, `name`, `model`, the v1 fields, `hms: { key, severity, text }[]` only with "Share alerts",
  `camera: boolean`) and `{"type":"queue","items":QueueSummary[]}` only with "Share queue".
- **Phone key** (replaces "derive from the recovery key": the recovery key exists only when backups are
  on, and a phone must be revocable without re-keying backups). The app generates a random 32-byte
  household phone key (stored in `meta`, included in encrypted backups), key id = first 8 bytes of
  SHA-256 of the key. A parent shows it as a QR code on the computer (parent PIN required); the phone
  scans it and keeps it in IndexedDB; it is never sent to PLC. "Forget all phones" rotates the key.
  Two subkeys via HKDF-SHA256 (salt `family-print-lab`): `info "phone seal v1"` (AES-256-GCM) and
  `info "phone mac v1"` (HMAC-SHA256).
- Cloud → app `{"type":"control","commandId","printerId","action":"pause"|"resume"|"stop","by","at","mac"}` →
  applied through `printers.require(id).send('print.pause' | …)` only when "Allow remote control" is on,
  the cloud says the Family plan is active, **and** `mac` = HMAC(phone mac key, `commandId|printerId|action|at`)
  verifies with `at` within 2 minutes and `commandId` not seen before (replay cache). So a compromised
  PLC can relay but not forge commands. Answered with `result`. Every remote action is logged in
  activity ("Paused from the phone by a@b.c"). No G-code, temperatures or other commands remotely.
- Cloud → app `{"type":"snapshot.request","requestId","printerId"}` → app replies
  `{"type":"snapshot","requestId","printerId","sealed":"<base64>"}`: JPEG sealed with the phone seal key,
  format `"PLS1" | key id (8) | IV (12) | ciphertext | tag (16)` like `vault.ts`, with
  `requestId|printerId|capturedAt` as AES-GCM additional data and `capturedAt` inside the plaintext
  header, so PLC cannot swap printers or replay an old picture unnoticed. The phone decrypts with
  WebCrypto. PLC relays bytes it cannot read and never stores them. Keep each WebSocket message well
  under 1 MiB after base64 (downscale to ≤ 1280 px wide, JPEG quality ≤ 70; check Cloudflare's current
  WebSocket message limit and cite it).
- Live view away from home (Handy parity): the phone viewer repeats `snapshot.request` at up to 2 fps for
  at most 2 minutes per session (then "Tap to keep watching"), rate-limited per account in the Durable
  Object. Same sealing; no video leaves the house unencrypted.
- Status minimisation: with a phone key set, `printers` entries are sent sealed (`"sealed"` field, same
  format, AAD `printers|deviceId`) and only `{ id, state, event }` travel in clear so PLC can send
  content-free pushes; without a phone key the v1 minimal fields apply.
- Web Push (content-free, as today) for `print.finished|failed|cancelled|paused`, HMS severity ≥ serious,
  and queue events, each toggleable on the phone.
- Optional (Stretch) "Start next queued job" from the phone: same MAC'd command path with action
  `dispatch` and a `queueItemId`, only when the queue package is present and the printer's plate is
  confirmed clear.
- Capabilities are separate toggles in the app (Family page → Print Lab Cloud): share status of all
  printers, share alerts, share queue, allow remote control (requires the parent PIN to enable), camera
  snapshots and live view.
- Must: v2 hello/printers, MAC'd pause/resume/stop, sealed snapshots, phone key QR, PLC relay + phone UI.
  Stretch: live view, sealed status, remote dispatch.

**FPL.** `cloud/link.ts` (owned by this package in wave 2), a Cloud section update, key QR dialog,
tests in `link.test.ts` + `tools/cloud-sim.ts`. **PLC.** `src/household.ts` (v2 messages, command relay
like `decide`, snapshot relay with timeout), D1 migration `0007_remote.sql` (`device_printers`
(device_id, printer_id, account_id, data, event, updated_at) keyed by (device_id, printer_id)), API
`/api/printers` (all printers of the account), `/api/printers/:deviceId/:printerId/control`,
`/api/printers/:deviceId/:printerId/snapshot` (the phone builds `commandId`, `at` and `mac` in the
browser; PLC passes them through untouched and never sees the phone key), phone UI (printer cards with state, controls behind a
confirm, alerts, queue, snapshot viewer with decryption), Web Push for HMS (severity ≥ serious) and
queue events (content-free, as today), plan gating with `hasFamilyPlan`, tests in the Workers runtime
(vitest pool workers) for relay, gating and validation.

**Acceptance.** With the cloud simulator: phone API lists two printers, pause from the phone pauses the
simulated printer, a command with a wrong or replayed MAC is refused, a sealed snapshot decrypts in a
test with the phone key (and fails with swapped AAD), and PLC stores nothing.

### 6.3 `slicer-ui` — the Print Lab Slicer workspace

**Goal.** A full slicing workspace in the web app on top of slicer-3mf, slicer-profiles,
slicer-engine and gcode-preview.

**Scope.** Route `/projects/[id]/slicer/[slicerProjectId]` (and "Slice" entry points from model
versions, imports, files). three.js scene with multiple plates; add models from workbench versions,
imports, uploads; move/rotate/scale gizmos with snapping, drop to bed, lay on face; auto-arrange and
auto-orient via the engine; object list with parts; per-object and per-part settings panels
(slicer-profiles keys, grouped); modifier volumes (box/cylinder/sphere/imported) and height-range
modifiers; variable layer height editor (profile curve); brush painting for supports, seams and
multi-colour (brush, fill, edge-detection/smart fill modes) using `paint.ts`; filament/AMS slot
assignment per object/part with colour preview from the chosen printer's trays; plate settings (bed
type, print sequence, spiral vase); slice with progress and cancel; integrated preview (gcode-preview
viewer with the engine's `preview.get`); per-object time/filament breakdown; "Send to printer" through
the queue (or direct send); "Open in Bambu Studio" (download the project 3MF). Replaces the old per-job
slicing panel for grown-ups; kid mode keeps its simple path and never shows the slicer. Works with the
CLI backend with reduced features (capabilities gate painting, preview source, arrange).

This is far more than one agent can finish; build it in milestones and stop at a clean one:

1. Must: route, scene with plates, add objects, move/rotate/scale + drop to bed, object list, preset
   selection (printer/process/filaments with AMS colours), plate settings, slice with progress/cancel,
   preview, send (queue or direct), "Open in Bambu Studio".
2. Should: auto-arrange/orient, per-object and per-part settings, modifier volumes, height ranges,
   per-object breakdown.
3. Stretch: painting (supports, seam, colour with smart fill), variable layer height editor, lay on
   face.
4. Follow-ups (report only): cut, text/emboss, measure, simplify, mesh boolean, assembly view.

Pure logic (transform maths, selection, undo stack, settings grouping) lives in `client/slicer/*.ts` with
unit tests; three.js code stays thin.

**Owns** `routes/projects/[id]/slicer/**`, `components/slicer/**`, `client/slicer/**`,
`modules/slicer-ui/*` (server helpers), migration 0023 if it needs UI state. **May touch** the job
panel that offered slicing (replace), project page entry points.

**Acceptance.** Build a two-plate project with a modifier and painted supports, slice with progress,
preview, send plate 2 to a simulated printer, and round-trip the project through "Open in Bambu Studio"
(file validated by the engine reader).

### 6.4 `slicer-calibration` — calibration suite

**Goal.** Calibration beyond Bambu Studio's, porting OrcaSlicer's Calibration menu generators
(AGPL-3.0; credit OrcaSlicer and the original authors in code and UI).

**Scope.** Engine feature module `slicer/engine/src/features/calib/` (no upstream patches unless truly
necessary; then an isolated `1xxx-calib-*` series) exposing `calib.flow_rate`, `calib.pa_line`,
`calib.pa_pattern`, `calib.pa_tower`, `calib.temp_tower`, `calib.retraction`, `calib.max_volumetric`,
`calib.vfa` capabilities, each generating a project for the chosen printer/filament; a guided wizard
UI (pick printer, filament/spool, test, print via queue, read the result with pictures, enter the
winning value) that writes the result into the user filament preset (slicer-profiles) and the spool
record. Port from OrcaSlicer's calibration sources at a pinned OrcaSlicer tag (`slicer/orca.lock`,
cite paths and tag; each ported file gets an `origin:` header and a row in `slicer/ports/ORIGINS.md`,
5.6 rule 11). CLI fallback: generators that need the engine are disabled with a reason.

Printer-side calibration (Bambu Studio device tab parity; commands in `defs/slicer-calibration.ts`,
fields read from Bambu Studio `DeviceManager.cpp` / `DeviceCore/DevCalib*.cpp` at the tag and cited):
flow dynamics (PA) calibration `print.extrusion_cali`, results `extrusion_cali_get` /
`extrusion_cali_get_result`, K-value profiles per filament and nozzle `extrusion_cali_set` /
`extrusion_cali_sel` / `extrusion_cali_del`, flow rate `flowrate_cali` / `flowrate_get_result`, gated on
`firmwareSupport.paCalibration` / `flowCalibration`. Simulator: canned results. Stretch if time runs
short, but keep the command defs and the K-profile list.

**Acceptance.** Each generator produces a sliceable project with the right parameter steps in its
G-code (golden checks); the wizard stores a flow ratio into a user preset and the spool.

### 6.5 `onboarding` — first-run wizard and integrations refresh

**Goal.** A first run that gets a family printing in minutes, honest about trade-offs.

**Scope.** Wizard at `/welcome` on first run (no profiles and no printers) and from Settings: find
printers (SSDP), explain LAN-only + Developer Mode plainly (Bambu Handy and cloud printing stop working
while LAN-only is on; how to switch back), enter the access code, test the connection, pick
integrations (slicer engine/CLI, AI provider, Blender, notifications, cloud link), create family
profiles (with kid mode and parent PIN), done screen. The printer step verifies TLS per 4.2.3 and, when
the certificate is pinned rather than CA-verified, says in one line that the app will warn if it ever
changes. Integrations page refresh: one card per
integration including every module row, with status, what it powers, setup steps, and tests.

**Owns** `routes/welcome/**`, `components/onboarding/**`, the Integrations page layout (coordinate by
keeping registry slots intact). **Acceptance** e2e: fresh DB → wizard → simulated printer added → first
job sent.

---

## 7. Merge and conflict guidance

### 7.1 Principles

- Packages add files; shared files get at most small, listed, additive edits.
- Registries replace edits: server modules (`modules/*/module.ts`), commands (`commands/defs/*.ts`),
  events (declaration merging), UI slots (`client/modules/*/ui.ts`), simulator features (one line in
  `sim/features/index.ts`), tables (`db/tables/*.ts` + one `export *` line), handles (one line),
  settings (`ctx.settings()` in meta), integrations rows (`integrations()`), kid reads (`kidReads`),
  printer sub-pages (`printerTabs`), integration tests (`startTestLab`), upstream files (`app/tools/lib/upstream.ts`).
- Never reformat files you do not own (run prettier only on files you touched).
- Rebase your branch on `parity` before handing over; resolve your own conflicts.

### 7.2 Hot spots and rules

| File                                                                       | Owner after foundation            | Rule for others                                                                                                                         |
| -------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `db/schema.ts`                                                             | foundation                        | add one `export * from './tables/<key>'` line at the end                                                                                |
| `db/tables/core.ts`                                                        | foundation                        | only the listed column additions (ams: spools rfid/spoolman columns; slicer-profiles: `jobs.slice_overrides`, `spools.filament_preset`) |
| `drizzle/meta/_journal.json`                                               | merger                            | append your entry with your slot's `idx`/`when`; the merger fixes order                                                                 |
| `printer/sim/features/index.ts`                                            | foundation                        | one import + one array entry, appended at the end; the merger keeps every line on conflict                                              |
| `printer/sim/core.ts`, `simulator.ts`                                      | foundation                        | no edits; use a feature                                                                                                                 |
| `printer/bambu.ts`, `report.ts`, `manager.ts`, `mqtt.ts`                   | foundation                        | no edits; report gaps (a parse field missing → add it in your module from `rawReport()` only as a last resort, and note it)             |
| `printer/tls.ts`, `flags.ts`, `certs/`, `testing/harness.ts`               | foundation                        | no edits; use them (a harness option you need → note it in the report)                                                                  |
| `printer/ftp.ts`, `ftp-server.ts`                                          | camera                            | others: none                                                                                                                            |
| `commands/registry.ts`                                                     | foundation                        | no edits; add `defs/<key>.ts`                                                                                                           |
| `events.ts`                                                                | foundation                        | no edits; declaration merging in your files                                                                                             |
| `runtime.ts`, `modules.ts`, `http.ts`                                      | foundation                        | no edits                                                                                                                                |
| `lib/server/hooks/index.ts`                                                | foundation                        | lan-auth adds one line                                                                                                                  |
| `lab.ts`                                                                   | foundation                        | no edits (use your own tables/services); if unavoidable, add a method at the end of the class in a block commented with your key        |
| `printing.ts`                                                              | foundation                        | slicer-engine (`sliceJob`), gcode-preview (`sweep` 1–2 lines) only                                                                      |
| `domain.ts`, `shared/printers/*`                                           | foundation                        | hms may fill `hmsDevice` values; otherwise no edits (put types in `shared/<key>.ts`)                                                    |
| `client/app.svelte.ts`, `registry.ts`, `nav.ts`                            | foundation                        | no edits; use slots, `lab.onLive`, your own stores                                                                                      |
| `routes/printers/[id]/+page.svelte`                                        | foundation                        | no edits; `printerPanels`, `printerTabs`                                                                                                |
| `routes/integrations/+page.svelte`                                         | foundation (onboarding in wave 2) | no edits; `settingsSections`                                                                                                            |
| `routes/+layout.svelte`, `TopBar.svelte`                                   | foundation                        | no edits; `globalOverlays`, `topBarItems`                                                                                               |
| `SendPanel.svelte`, `JobCard.svelte`, `JobForm.svelte`, `SpoolForm.svelte` | foundation                        | no edits; `sendPanelSections`, `jobPanels`, `spoolFormFields`                                                                           |
| `routes/family/+page.svelte`                                               | foundation                        | no edits; `familyPanels`                                                                                                                |
| `routes/filament/+page.svelte`                                             | ams                               | others: none                                                                                                                            |
| `kid/session.ts`                                                           | foundation                        | kids / lan-auth only with a reason                                                                                                      |
| `cloud/link.ts`, `docs/cloud-protocol.md`                                  | cloud-remote (wave 2)             | wave 1: none                                                                                                                            |
| `desktop/main.cjs`                                                         | notifications (bridge)            | others: none                                                                                                                            |
| `desktop/scripts/prepare-server.mjs`                                       | slicer-engine                     | slicer-profiles one copy line                                                                                                           |
| `.github/workflows/*`                                                      | slicer-engine                     | others: none                                                                                                                            |
| `app/package.json`                                                         | —                                 | script lines only (`slicer:build`, `profiles:fetch`, `hms:build`); no dependencies without listing them                                 |
| `app/.gitignore`, root `.gitignore`                                        | foundation                        | no edits (all programme ignores are added by the foundation); ask the merger                                                            |
| `validation.ts`                                                            | foundation                        | no edits; schemas live in `modules/<key>/validation.ts`                                                                                 |
| `slicer/upstream.lock`, `app/tools/lib/upstream.ts`                        | foundation, then slicer-engine    | others read them through the helper; only `upstream.sh export` (or a deliberate PR) changes the lock                                    |
| `app.css`                                                                  | —                                 | no edits; component-scoped styles                                                                                                       |
| `.env.example`                                                             | foundation                        | lan-auth documents its variables in its own block at the end                                                                            |

### 7.3 Migration slots

`when` values keep drizzle's ordering (`sqlite-core/dialect.js` applies a migration only if its `when`
is greater than the last applied one), so slots are fixed in advance: `when = 1790400000000 + NN × 60000`.

| NN   | Tag                    | Package                                 |
| ---- | ---------------------- | --------------------------------------- |
| 0005 | `0005_printers`        | foundation                              |
| 0006 | `0006_hms`             | hms                                     |
| 0007 | `0007_ams`             | ams                                     |
| 0008 | `0008_notifications`   | notifications                           |
| 0009 | `0009_presets`         | slicer-profiles                         |
| 0010 | `0010_queue`           | queue                                   |
| 0011 | `0011_home_automation` | home-automation                         |
| 0012 | `0012_kids`            | kids                                    |
| 0013 | `0013_maintenance`     | maintenance                             |
| 0014 | `0014_lan_auth`        | lan-auth                                |
| 0015 | `0015_model_import`    | model-import                            |
| 0016 | reserved               | camera (only if needed)                 |
| 0017 | reserved               | analytics (only if needed)              |
| 0018 | `0018_slicer_projects` | slicer-3mf                              |
| 0019 | reserved               | controls (only if needed)               |
| 0020 | reserved               | gcode-preview (only if needed)          |
| 0021 | `0021_vision`          | ai-vision                               |
| 0022 | reserved               | cloud-remote (FPL side, only if needed) |
| 0023 | reserved               | slicer-ui                               |
| 0024 | reserved               | slicer-calibration                      |
| 0025 | reserved               | onboarding                              |

A package that needs no table leaves its slot unused (gaps are fine: the journal `idx` must still be
consecutive, so the merger assigns `idx` in merge order while keeping each file's `NNNN_` name and
`when`). PLC: cloud-remote uses `migrations/0007_remote.sql`.

### 7.4 Merge order

1. Foundation.
2. Wave 1, in this order (low-risk and depended-upon first): slicer-3mf, slicer-profiles,
   gcode-preview, controls, hms, camera, ams, notifications, queue, home-automation, maintenance,
   analytics, kids, model-import, lan-auth, slicer-engine (last: largest, and it consumes slicer-3mf
   and slicer-profiles through their services when present).
3. After each merge: `bun install`, `bun run check`, `bunx vitest --run`, e2e smoke
   (`bunx playwright test app.e2e.ts` at least), `bun run dev:sim` sanity.
4. Wave 2: cloud-remote (both repos), ai-vision, slicer-calibration, slicer-ui, onboarding (last, it
   touches the Integrations page layout).

### 7.5 Cross-package dependencies (all soft)

Wave-1 packages never import each other's code. They reach each other only through `ctx.module(key)`
(which may be `undefined`: degrade gracefully) and bus events. Examples: kids uses `camera` if present;
notifications uses `hms` descriptions if present; queue calls `hooks.beforeDispatch` (home-automation
registers there); analytics joins `hms_events` only if the table exists (check `sqlite_master`);
slicer-engine uses `slicer-profiles` and `slicer-3mf` services when present, else its own fallbacks.

---

## 8. Appendix: verified protocol facts and sources

### 8.1 Model codes

From Bambu Studio `resources/profiles/BBL/machine/<model>.json` `model_id` at `v02.08.02.61`
(commit `926a7192574bcb9b3a732e1ec59a46d79cb45466`): X1 Carbon `BL-P001`, X1 `BL-P002`, X1E `C13`, P1P
`C11`, P1S `C12`, A1 mini `N1`, A1 `N2S`, H2D `O1D`, H2D Pro `O1E`, H2S `O1S`, P2S `N7`, H2C `O1C2`
(capability files exist for both `O1C` and `O1C2`), X2D `N6`, A2L `N9`. HMS serial prefixes from
ha-bambulab `scripts/update_error_text.py` `_DEVICE_TYPES`: X1/X1C `00M`, X1E `03W`, A1 `039`, A1 mini
`030`, P1P `01S`, P1S `01P`, P2S `22E`, H2S `093`, H2D `094`. Model detection from `get_version`:
ha-bambulab `utils.get_printer_type` (`product_name`, then AP/project_name heuristics).

### 8.2 SSDP discovery

ClusterM/open-bamboo-networking `research/06.01-ssdp.md` (captured 2026-07): NOTIFY to
`255.255.255.255:2021` from source port 2021 about every 5 s; `Host: 239.255.255.250:1990` is only a
header. Sample:

```
NOTIFY * HTTP/1.1
Host: 239.255.255.250:1990
Server: UPnP/1.0
Location: 10.13.1.30
NT: urn:bambulab-com:device:3dprinter:1
NTS: ssdp:alive
USN: 22E8BJ610801473
Cache-Control: max-age=1800
DevModel.bambu.com: N7
DevName.bambu.com: <name>
DevConnect.bambu.com: cloud
DevBind.bambu.com: occupied
Devseclink.bambu.com: secure
DevInf.bambu.com: wlan0
DevVersion.bambu.com: 01.02.00.00
DevCap.bambu.com: 1
```

X1Plus `installer-clientside/x1p-js/src/x1p.ts` binds UDP 2021 and broadcasts an M-SEARCH to
`255.255.255.255:2021`. ha-bambulab `manifest.json` declares `st: urn:bambulab-com:device:3dprinter:1`.

### 8.3 Trays and AMS numbering

- `tray_now` (legacy, single nozzle): 255 none, 254 external spool, 128–135 AMS HT (one tray each), else
  `unit*4 + slot` (OpenBambuAPI `mqtt.md` pushall comment; ha-bambulab `AMSList.print_update`; Bambu
  Studio `DeviceCore/DevExtruderSystem.cpp` ~276–305 maps 254 to external main `255`/slot 0).
- `device.extruder.info[i]` (sent by P2S, A2L, H2*, X2D): `snow`/`spre`/`star` (now/previous/target) =
  `(ams_id << 8) | slot_id`, low 8 bits slot, `0xFFFF` = none; `temp` packed (low 16 current, high 16
  target); `info` bits 1 filament at extruder, 2 in buffer, 3 nozzle present. `device.extruder.state`
  bits 0–3 extruder count, 4–7 current extruder, 8–11 target extruder, 12–14 switch state
  (`DevExtruderSystem.cpp` ~320–387). Nozzle ids: 0 = main (right, or only), 1 = deputy (left).
- Tray index (Bambu Studio `DeviceCore/DevFilaSystem.cpp` ~355–375, `DevDefs.h`): AMS / AMS Lite /
  AMS 2 Pro `ams_id*4 + slot`; AMS HT (N3S) = `ams_id` (128–135); A2L AMS Lite ("AMS_LITE_MIXED",
  type 5, ams id 16) = `24 + slot`; external `255` main / `254` deputy (`VIRTUAL_TRAY_MAIN_ID/DEPUTY_ID`).
- AMS `info` hex bits: 0–3 type (1 AMS, 2 AMS Lite, 3 AMS 2 Pro, 4 AMS HT, 5 A2L AMS Lite), 4–7 drying
  status, 8–11 extruder (0xE = through the filament switcher), 18–23 dry fan/sub status, 30–31 remain
  estimate version (`DevFilaSystem.cpp` ~596–617). External spools: `vt_tray` (single) or `vir_slot[]`
  (ids "255", "254").
- `project_file`: `ams_mapping` = one tray index per project filament, `-1` unused/external;
  `ams_mapping2` = `{ ams_id, slot_id }` per filament, `{255,255}` unused, external `{255|254, 0}`, AMS HT
  `{128+n, 0}` (Bambu Studio `SelectMachine.cpp` `get_ams_mapping_result` ~1424–1510).

### 8.4 Camera

OpenBambuAPI `video.md`: X1 and P2S serve `rtsps://<ip>:322/streaming/live/1` (user `bblp`, access
code); H2S/H2D serve the same URL but LAN RTSPS is off by default (report shows
`ipcam.rtsp_url = "disable"` until "LAN Only Liveview" is turned on). A1/P1 serve 1280×720 JPEG frames
over TLS on port 6000: 80-byte auth packet (u32 LE 0x40, u32 0x3000, u32 0, u32 0, 32-byte username,
32-byte password), then per frame a 16-byte header (u32 LE payload size, itrack 0, flags 1, 0) and the
JPEG. ha-bambulab `Features.CAMERA_RTSP` = H2*, P2S, X1, X1E, X2D; `CAMERA_IMAGE` = A1, A2L, P1.
Bambu Studio `resources/printers/*.json` `ipcam.liveview.local = "local"` on C11, C12, N1, N2S, N9.
Bambu Studio picks the LAN path from the report: `ipcam.rtsp_url` empty → none, `"disable"` → disabled,
`rtsps…` → RTSPS, other → RTSP; `ipcam.liveview.local` one of `none disabled local rtsps rtsp`
(`DeviceManager.cpp` ~3450–3466); URLs built from the printer's LAN IP, port 6000 for `local`
(`MediaPlayCtrl.cpp` ~440). Plain RTSP uses port 554 (ClusterM `research/06.05-rtsp.md`; live555, Digest
auth, H.264, geometry from the SDP SPS). The ha-bambulab mocks report `rtsp_url = "disable"` for P2S,
X2D and H2C too. Port 6000 on RTSP models is the file tunnel (`BambuTunnelLocal`: login on subchannel 1,
CTRL JSON on subchannel 2; OpenBambuAPI `lan-file-tunnel.md`, ClusterM `06.04-port-6000.md`).

### 8.5 HMS

- Bambu Studio `resources/hms/hms_<lang>_<device>.json` (`device_hms`, `device_error`, `ecode`, `intro`)
  and `hms_action_<device>.json` (`ecode`, `actions`, `image`) for devices `093 094 20P 22E 239 26A 31B`
  at the pinned tag (AGPL-3.0).
- ha-bambulab `pybambu/hms_error_text/hms_<lang>.json.gz` (all models, from Bambu's public
  `https://e.bambulab.com/query.php?lang=<lang>&d=<prefix>` query) and `wiki_links.json.gz` (MIT).
- Severity `code >> 16` (1 fatal, 2 serious, 3 common, 4 info); module `attr >> 24`. Bambu Studio's
  long code is `%02X%02X%02X%02X00%02X%04X` over module/num/part/reserved/level/msg
  (`DeviceCore/DevHMS.cpp` `get_long_error_code`), identical to `attr` and `code` as 8-hex each.
- Files: `{ result, t, ver, data: { device_hms: { ver, en: [...] }, device_error: { ver, en: [...] } } }`;
  action files key on 8- or 16-hex `ecode`; `image` names a PNG in `resources/hms/local_image/`.
- `print_error` `0x0300400C` = "The task was canceled." and `0x0500400E` = "Printing was cancelled."
  (Bambu data, `device_error`, e.g. `hms_en_094.json`).

### 8.6 Commands referenced in this plan

OpenBambuAPI `mqtt.md`: `pushing.pushall` (do not repeat under 5 min on P1P), `info.get_version`,
`print.stop|pause|resume` (QoS 1), `print.ams_change_filament`, `print.ams_get_rfid`,
`print.ams_user_setting`, `print.ams_filament_setting`, `print.ams_control`, `print.print_speed`,
`print.gcode_file`, `print.gcode_line`, `print.calibration` (bitmask), `print.unload_filament`,
`print.project_file`, `print.skip_objects` (+ `s_obj` in reports), `print.print_option`,
`system.ledctrl`, `system.get_access_code`, `system.set_accessories`, `camera.ipcam_record_set`,
`camera.ipcam_timelapse`, `xcam.xcam_control_set`. ha-bambulab `pybambu/commands.py`: light templates
incl. `chamber_light2`/`heatbed_light`, `ams_filament_drying`, `buzzer_ctrl`, `set_airduct`,
`MOVE_AXIS_GCODE`, `HOME_GCODE`, `EXTRUDER_GCODE`; `utils.py` fan and temperature G-code. ha-bambulab
`const.py`: `LEGACY_SDCARD_PRINTERS` (`file:///sdcard/` URL form), `CURRENT_STAGE_IDS`,
`Print_Fun_Values.MQTT_SIGNATURE_REQUIRED = 0x20000000`, `Home_Flag_Values`.

Bambu Studio builders at the tag (`DeviceManager.cpp` unless noted; read the function before coding):
`print.set_nozzle_temp {extruder_index, target_temp}` QoS 1 (~1611), `print.set_bed_temp {temp}` when
fun bit 39 else `M140` (~1571), `print.set_ctt {ctt_val}` QoS 1 (`DevChamberCtrl.cpp`),
`print.set_fan {fan_index, speed}` (`DevFan.cpp`), `print.set_airduct {modeId, submode}` (`DevFan.cpp`),
`print.back_to_center` when fun bit 32 else `G28` (`DevAxisCtrl.cpp`), `print.xyz_ctrl {axis, dir, mode}`
when fun bit 38 (`DevAxisCtrl.cpp`), `print.select_extruder {extruder_index}` QoS 1 (`DevCtrl.cpp`),
`print.ams_change_filament {ams_id, slot_id, target, curr_temp, tar_temp, extruder_id?}` (~1640; unload
= `target 255, slot_id 255`), `print.ams_user_setting {ams_id: -1, startup_read_option,
tray_read_option, calibrate_remain_flag}` (~1675), `print.ams_filament_setting` (~1705),
`print.buzzer_ctrl {mode}` QoS 1 (~1560), HMS `resume`/`ignore`/`stop` with `err`, `param: "reserve"`,
`job_id` and `idle_ignore {err, type}` (~1460–1500), `print.clean_print_error {subtask_id, print_error}`
and `system.uiop {name: "print_error", action: "close"}` (~1390), `info.get_version` QoS 1 (~1270).
Other commands present at the tag (fields not reviewed here): `extrusion_cali*`, `flowrate_cali`,
`flowrate_get_result`, `ams_reset`, `auto_stop_ams_dry`, `ams_filament_drying`, `close_air_filt`,
`set_against_continued_heating_mode`, `set_extrusion_length`, `get_auto_nozzle_mapping`,
`nozzle_holder_ctrl`, `holder_nozzle_refresh`, `nozzle_info_confirm`, `refresh_nozzle`,
`system.set_door_stat`, `system.print_cache_set`, `camera.ipcam_resolution_set`,
`camera.ipcam_get_media_info`, `camera.ipcam_delete_oldest_timelapse`, `camera.ipcam_cap_pic_set`.

### 8.7 Bambu Studio build facts (v02.08.02.61)

Top-level options `SLIC3R_GUI`, `SLIC3R_STATIC`, `SLIC3R_BUILD_TESTS`, `SLIC3R_PCH`; `src/CMakeLists.txt`
builds `libslic3r` and its bundled libraries unconditionally and GUI parts only `if (SLIC3R_GUI)`;
`libslic3r` requires CGAL, OpenCV (core), assimp, OpenCASCADE, Freetype, OpenVDB, TBB, Boost; deps
superbuild options include `DEP_BUILD_WXWIDGETS`, `DEP_BUILD_GLFW`, `DEP_BUILD_FFMPEG`,
`DEP_BUILD_LIBHARU`, `DEP_BUILD_OPENSSL`, `DEP_BUILD_BOOST`… 3MF constants (`paint_supports`,
`paint_seam`, `paint_color`, `paint_fuzzy_skin`, `Metadata/model_settings.config`,
`Metadata/project_settings.config`, `Metadata/slice_info.config`, `Metadata/plate_%d.png`,
`layer_heights_profile.txt`, `layer_config_ranges.xml`) in `src/libslic3r/Format/bbs_3mf.cpp`. Latest
non-prerelease release: `v02.08.02.61` (2026-08-21); newer tags (`v02.08.03.x`, `v02.08.04.57`) exist.

### 8.8 TLS, sequence ids and flag strings

- Printer TLS: leaf `CN=<serial>`, no IP/DNS SAN, SNI = serial, issued by a Bambu device CA that public
  bundles may lack (OpenBambuAPI `tls.md`; ClusterM `research/10.06-lan-tls-and-access-codes.md`).
  ha-bambulab verifies against `pybambu/certs/*.cert` with hostname checking off and caps at TLS 1.2
  for the P2S (`bambu_client.py` `create_local_ssl_context`).
- `sequence_id`: decimal string; Bambu Studio uses a process-wide counter from 20000 (valid 20000–29999);
  AMS commands with ids above 2^31−1 hang the AMS (ClusterM `research/06.02-mqtt.md`). Reply `result`
  casing varies (`success`, `SUCCESS`, `fail`) and some replies have none.
- Flag strings `fun`, `fun2`, `cfg`, `aux`, `stat` are hex; Bambu Studio reads bits with
  `stoull(str, 16)` (`get_flag_bits`, so ≤ 64 bits) and `fun2` bit-by-bit without a length limit
  (`get_flag_bits_no_border`) (`DeviceManager.cpp` ~4430–4560). Parse with BigInt.
- OpenBambuAPI is licensed GFDL-1.3: cite it, do not copy its text or examples into AGPL code/fixtures.
