# Parity status: Family Print Lab vs Bambu Handy and Bambu Studio

Where Family Print Lab (with the optional Print Lab Cloud) stands against Bambu Handy (the phone app)
and Bambu Studio (the slicer), feature by feature. The plan behind it, with the work packages named
in the last column, is [PLAN.md](PLAN.md).

This page describes the `parity` branch after the foundation merge: the printer registry, telemetry,
command layer, event bus, extension registries, slicer contracts and the Bambu Studio fork tooling.
The wave 1 and wave 2 packages are not merged yet, so most of the camera, control and slicer work
below is **planned**, not done. Update this page when a package lands.

- **Done**: works in the app today, with tests against the simulator.
- **Partial**: some of it works; the notes say what is missing.
- **Planned**: a package in the plan will add it (named in the notes).
- **Not planned**: deliberately left out, with the reason.

"Yes" in a Bambu column means that app has the feature, "No" that it does not, and "—" that it does
not apply or we have not checked.

## Printers and monitoring

| Feature                        | Handy  | Studio | Family Print Lab | Notes                                                                                                                                                                                                |
| ------------------------------ | ------ | ------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Several printers in one place  | Yes    | Yes    | Done             | Integrations → Printers, a printers overview and a page per printer. Order is saved; the first printer is the default.                                                                               |
| Find printers on the network   | Yes    | Yes    | Done             | SSDP, only when you press Find printers. It only suggests: a found printer never changes a saved one.                                                                                                |
| Every current Bambu model      | Yes    | Yes    | Done             | Catalogue generated from Bambu Studio `v02.08.02.61` (X1, X1 Carbon, X1E, P1P, P1S, P2S, A1, A1 mini, A2L, X2D, H2C, H2D, H2D Pro, H2S). Simulated for 12 models.                                    |
| Live status                    | Yes    | Yes    | Done             | Stage, progress, layers, time left, temperatures (both nozzles on H2D/X2D), fans, speed, lights, firmware version. Delta reports merged per tray, as P1/A1 need.                                     |
| Temperature history            | No     | No     | Done             | A chart on each printer's page.                                                                                                                                                                      |
| AMS view                       | Yes    | Yes    | Done             | Trays, colours, materials, remaining, humidity and temperature per unit, AMS HT included. Tray settings, RFID re-read, AMS options and drying (AMS 2 Pro, AMS HT) from the printer page.             |
| Filament inventory             | Yes    | —      | Done             | Trays link to shelf spools (RFID spools by themselves); each print is charged per tray from the sliced grams and refunded if the job is deleted. Optional Spoolman import and usage sync.            |
| Printer errors (HMS)           | Yes    | Yes    | Done             | Plain words offline (Bambu Studio texts), severity, wiki link, Bambu's picture and buttons, alert history per printer, the error on failed jobs.                                                     |
| Notifications                  | Yes    | Yes    | Partial          | With Print Lab Cloud (Family plan): phone notifications for kids' requests and when a print on the first printer finishes or fails. Local channels: planned (notifications).                         |
| Live camera at home            | Yes    | Yes    | Planned          | camera                                                                                                                                                                                               |
| Timelapses and recordings      | Yes    | Yes    | Planned          | camera                                                                                                                                                                                               |
| Files on the printer's storage | Yes    | Yes    | Planned          | camera (files page)                                                                                                                                                                                  |
| Firmware update                | Yes    | Yes    | Partial          | Shows the firmware version and when an update is available. Flashing firmware: not planned (use the printer or Bambu Handy).                                                                         |
| Watching away from home        | Yes    | No     | Partial          | Print Lab Cloud shows the first printer's progress on the phone, only with "Share print progress" on. All printers, alerts and end-to-end encrypted snapshots and live view: planned (cloud-remote). |
| AI print-failure detection     | Some\* | No     | Planned          | ai-vision, using the AI provider you chose. \*On printers with an AI camera, detection runs on the printer.                                                                                          |

## Printer control

| Feature                                | Handy | Studio | Family Print Lab | Notes                                                                                                                                                                               |
| -------------------------------------- | ----- | ------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start a print                          | Yes   | Yes    | Done             | Upload over FTPS and start, with AMS mapping by filament and the URL form each model expects. One send at a time per printer; refused prints go back to the queue.                  |
| Pause, resume, stop                    | Yes   | Yes    | Done             | Sent with QoS 1 and confirmed from live status. The app says when Developer Mode is off, instead of commands silently doing nothing. Kid mode cannot reach any printer write route. |
| Speed, lights, temperatures, fans, jog | Yes   | Yes    | Planned          | controls. The command layer is ready; each command gets a cited definition.                                                                                                         |
| Skip objects                           | Yes   | Yes    | Planned          | controls                                                                                                                                                                            |
| Pause and stop from the phone          | Yes   | No     | Planned          | cloud-remote, with commands signed on the phone so Print Lab Cloud can relay but not forge them.                                                                                    |
| Start a print from the phone           | Yes   | No     | Planned          | cloud-remote (stretch: "Start next queued job", parent-authorised)                                                                                                                  |
| Print queue across printers            | No    | Yes    | Partial          | Print jobs are queued per project and sent to a chosen printer. A shared queue that dispatches to free printers: planned (queue).                                                   |

## Slicing (Bambu Studio)

| Feature                                   | Handy | Studio | Family Print Lab | Notes                                                                                                                                                                                                                                  |
| ----------------------------------------- | ----- | ------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slice inside the app                      | No    | Yes    | Partial          | Uses a Bambu Studio or OrcaSlicer install on the computer, for every model in the catalogue, with the main settings (layer height, material, supports, infill, plate).                                                                 |
| Print Lab Slicer engine                   | No    | —      | Partial          | Done: the engine protocol, project and preview formats, the client (tested against a fake engine) and the fork tooling (pinned Bambu Studio release, patch queue, weekly update workflow). Not yet: the engine itself (slicer-engine). |
| Plates, painting, modifiers, layer ranges | No    | Yes    | Planned          | slicer-ui, slicer-3mf                                                                                                                                                                                                                  |
| Presets like Bambu Studio's               | No    | Yes    | Partial          | Bambu system profiles are read and flattened. Editing and saving presets: planned (slicer-profiles).                                                                                                                                   |
| G-code preview                            | No    | Yes    | Done             | Every sliced plate, on the job card (follows the printing layer) and in the send window: layer range, move scrubber, colour by feature, filament or speed, legend toggles, time per layer. Read in a worker thread, cached.            |
| Bambu project files (3MF)                 | No    | Yes    | Done             | Reads sliced `.gcode.3mf` plates, and reads and writes full Bambu Studio / OrcaSlicer projects without loss: import, look inside and download them per project. Editing them in the app: planned (slicer-ui).                          |
| Calibration (flow, pressure advance…)     | No    | Yes    | Planned          | slicer-calibration, ported from OrcaSlicer's generators.                                                                                                                                                                               |
| Cut, boolean, simplify, measure           | No    | Yes    | Partial          | In the model workbench: cut, drill, combine, lay flat, measuring, and simplify through Blender. Text and emboss: not planned for now (OpenSCAD parts can have text).                                                                   |
| MakerWorld and other model sites          | Yes   | Yes    | Planned          | model-import: details and a link, you download the file yourself. Printables, Thingiverse and drag and drop too.                                                                                                                       |

## What Bambu does not have

| Feature                                          | Family Print Lab | Notes                                                                                                                                                      |
| ------------------------------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A profile for each maker, projects, checklists   | Done             | Ideas, sketches, slicer settings and the result of each print, per person.                                                                                 |
| Kid mode with print requests                     | Done             | Kids make things from safe templates and ask; a grown-up approves here or on the phone.                                                                    |
| Parametric workbench with AI design              | Done             | OpenSCAD in WebAssembly, live sliders, version history; AI with your own subscription.                                                                     |
| Local-first, LAN-only                            | Done             | Listens on `127.0.0.1` by default. Printers are reached on the LAN only.                                                                                   |
| Encrypted cloud backups                          | Done             | Family plan; sealed on the computer with a recovery key only the family has.                                                                               |
| Verified connection to each printer              | Done             | Bambu CAs bundled; otherwise the certificate is pinned on first use.                                                                                       |
| Optional login for LAN access                    | Planned          | lan-auth                                                                                                                                                   |
| Family differentiators (rewards, safe catalogue) | Planned          | kids                                                                                                                                                       |
| Statistics, maintenance tracker                  | Partial          | Stats: success rate, filament and cost, printer hours, failure reasons and a CSV, by date, printer and person. Maintenance tracker: planned (maintenance). |
| Smart plugs, Home Assistant, MQTT out            | Planned          | home-automation, off until you turn it on                                                                                                                  |
| First-run wizard                                 | Planned          | onboarding                                                                                                                                                 |

## Not planned

- **Bambu cloud printing, Bambu's remote video and its proprietary network plugin.** They are closed
  and need a Bambu account. Our remote path is Print Lab Cloud, with end-to-end encryption for anything
  beyond the minimal status.
- **Printers without Developer Mode.** Bambu firmware only accepts commands from third-party apps in
  LAN-only mode with Developer Mode on. Signing commands the way Bambu's own apps do is not
  something we will copy.
- **Flashing firmware.** Use the printer's own menu or Bambu Handy.

## Known limitations

- **No real-printer verification.** Nothing here has been tested against a physical printer. Report
  parsing is checked against published reports (ha-bambulab's mocks and other projects' captures),
  every command payload cites its source, and everything runs against the simulator, which is written
  from the same sources. Settings → Printers → Download diagnostics saves a redacted report that can
  become a test fixture.
- **Start-print URL form.** The references disagree about `ftp:///` vs `file:///sdcard/` for the X2D,
  P2S, A2L and H2D Pro. The app tries `ftp:///` first, retries once with the other form and logs which
  one worked, so a real printer's diagnostics can settle it.
- **Certificates.** Some printers use device CAs that are not in the bundled set; those are pinned on
  first use, which trusts whatever answers the first time you press Test.
- **Print Lab Cloud shows one printer.** Protocol v1 carries the first printer's progress only.
- **Slicing needs a Bambu Studio or OrcaSlicer install** until the Print Lab Slicer engine is built,
  and the settings exposed are the main ones only.
- **Simulator gaps.** The X1, X1E and one H2C variant have no simulated state of their own and start
  from their closest sibling.
