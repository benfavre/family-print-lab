# Parity status: Family Print Lab vs Bambu Handy and Bambu Studio

Where Family Print Lab (with the optional Print Lab Cloud) stands against Bambu Handy (the phone app)
and Bambu Studio (the slicer), feature by feature. The plan behind it, with the work packages named
in the last column, is [PLAN.md](PLAN.md).

This page describes the `parity` branch with the foundation and every wave 1 and wave 2 package
merged (camera, controls, hms, ams, notifications, queue, home-automation, maintenance, analytics,
kids, model-import, lan-auth, the slicer packages, cloud-remote, ai-vision, slicer-calibration,
slicer-ui and onboarding). "Done" means done against the simulator: nothing has been tried on a real
printer yet (see Known limitations). Update this page when a package lands.

- **Done**: works in the app today, with tests against the simulator.
- **Partial**: some of it works; the notes say what is missing.
- **Planned**: a package in the plan will add it (named in the notes).
- **Not planned**: deliberately left out, with the reason.

"Yes" in a Bambu column means that app has the feature, "No" that it does not, and "—" that it does
not apply or we have not checked.

## Printers and monitoring

| Feature                        | Handy  | Studio | Family Print Lab | Notes                                                                                                                                                                                                                                                                                                                          |
| ------------------------------ | ------ | ------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Several printers in one place  | Yes    | Yes    | Done             | Integrations → Printers, a printers overview and a page per printer. Order is saved; the first printer is the default.                                                                                                                                                                                                         |
| Find printers on the network   | Yes    | Yes    | Done             | SSDP, only when you press Find printers. It only suggests: a found printer never changes a saved one.                                                                                                                                                                                                                          |
| Every current Bambu model      | Yes    | Yes    | Done             | Catalogue generated from Bambu Studio `v02.08.02.61` (X1, X1 Carbon, X1E, P1P, P1S, P2S, A1, A1 mini, A2L, X2D, H2C, H2D, H2D Pro, H2S). Simulated for 12 models.                                                                                                                                                              |
| Live status                    | Yes    | Yes    | Done             | Stage, progress, layers, time left, temperatures (both nozzles on H2D/X2D), fans, speed, lights, firmware version. Delta reports merged per tray, as P1/A1 need.                                                                                                                                                               |
| Temperature history            | No     | No     | Done             | A chart on each printer's page.                                                                                                                                                                                                                                                                                                |
| AMS view                       | Yes    | Yes    | Done             | Trays, colours, materials, remaining, humidity and temperature per unit, AMS HT included. Tray settings, RFID re-read, AMS options and drying (AMS 2 Pro, AMS HT) from the printer page.                                                                                                                                       |
| Filament inventory             | Yes    | —      | Done             | Trays link to shelf spools (RFID spools by themselves); each print is charged per tray from the sliced grams and refunded if the job is deleted. Optional Spoolman import and usage sync.                                                                                                                                      |
| Printer errors (HMS)           | Yes    | Yes    | Done             | Offline English and French Bambu Studio texts, severity, wiki link, pictures and buttons, alert history and failed-job context from typed printer snapshots. Other languages fall back to English.                                                                                                                             |
| Notifications                  | Yes    | Yes    | Done             | A bell with the notification centre, desktop notifications, and opt-in ntfy, webhook, Discord, Telegram and email channels with quiet hours and per-event wording: prints done, failed, paused, printer alerts, runouts, a spool running low, queue, maintenance and AI checks. With Print Lab Cloud, phone notifications too. |
| Live camera at home            | Yes    | Yes    | Done             | Every model: port-6000 JPEG on the A1 and P1, RTSP(S) through the system ffmpeg on the others (the certificate is checked first). Snapshots for other packages, camera controls.                                                                                                                                               |
| Timelapses and recordings      | Yes    | Yes    | Done             | Timelapse and recording switches, and the printer's timelapse folder over FTPS on the Media page.                                                                                                                                                                                                                              |
| Files on the printer's storage | Yes    | Yes    | Partial          | Browse and download timelapses, recordings and other card files over FTPS (Media page). Port-6000 storage tunnelling, delete and Print again remain deferred.                                                                                                                                                                  |
| Firmware update                | Yes    | Yes    | Partial          | Shows the firmware version and when an update is available. Flashing firmware: not planned (use the printer or Bambu Handy).                                                                                                                                                                                                   |
| Watching away from home        | Yes    | No     | Done             | Print Lab Cloud (protocol v2) shows every shared printer, alerts and the queue on the phone. With the household phone key, status, camera pictures and live view are end-to-end encrypted: the cloud relays bytes it cannot read. All off until a parent turns them on.                                                        |
| AI print-failure detection     | Some\* | No     | Done             | ai-vision, off by default: a rough check on this computer (ffmpeg, nothing leaves the house) or the AI provider you chose, every N layers or minutes, with alerts, an optional one-time pause and a history page. \*On printers with an AI camera, detection also runs on the printer.                                         |

## Printer control

| Feature                                | Handy | Studio | Family Print Lab | Notes                                                                                                                                                                                                                                                                                                        |
| -------------------------------------- | ----- | ------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Start a print                          | Yes   | Yes    | Done             | Upload over FTPS and start, with AMS mapping by filament and the URL form each model expects. One send at a time per printer; refused prints go back to the queue.                                                                                                                                           |
| Pause, resume, stop                    | Yes   | Yes    | Done             | Sent with QoS 1 and confirmed from live status. The app says when Developer Mode is off, instead of commands silently doing nothing. Kid mode cannot reach any printer write route.                                                                                                                          |
| Speed, lights, temperatures, fans, jog | Yes   | Yes    | Done             | Speed, lights, nozzle, bed and chamber temperatures, fans and airduct, home and jog, extruder, active nozzle, AMS load and unload, printer calibration, print checks and guarded custom G-code. Dedicated MQTT commands only when the printer says it supports them, G-code otherwise, as Bambu Studio does. |
| Skip objects                           | Yes   | Yes    | Done             | A clickable plate map from the job's sliced file.                                                                                                                                                                                                                                                            |
| Pause and stop from the phone          | Yes   | No     | Done             | cloud-remote (Family plan, parent PIN to turn on): pause, resume and stop, signed on the phone with the household key so Print Lab Cloud can relay but not forge them. Command claims persist in local SQLite across restarts; storage failures refuse commands.                                             |
| Start a print from the phone           | Yes   | No     | Partial          | "Start next": the job the computer's queue would start next, on a plate marked clear, signed like the other commands. Choosing any file from the phone: not planned.                                                                                                                                         |
| Print queue across printers            | No    | Yes    | Done             | A queue per printer or for any printer that fits, started when the plate is marked clear, with quiet hours, holds, a timeline and Up next on the printer page.                                                                                                                                               |

## Slicing (Bambu Studio)

| Feature                                   | Handy | Studio | Family Print Lab | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------- | ----- | ------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slice inside the app                      | No    | Yes    | Done             | The slicing workspace (Slicer projects) and one-click slicing of jobs, through Print Lab Slicer, or the Bambu Studio command line when the engine is not installed.                                                                                                                                                                                                                                                                                                                                                                                             |
| Print Lab Slicer engine                   | No    | —      | Partial          | The full Linux engine and dependencies build locally in 20 minutes 40 seconds on this 24-worker build host. Native preview, repeatable estimates, automatic H2D/X2D grouping and wipe-tower arrangement pass runtime tests. Project read/write passes the TypeScript reference fixtures in both directions. Strict ASan/UBSan validation passes. macOS native builds and golden slices now pass; Windows verification is in progress. Desktop packages consume the platform bundle.                                                                             |
| Plates, painting, modifiers, layer ranges | No    | Yes    | Done             | Plates, transforms, presets, colour/support/seam painting with small-brush facet subdivision, modifiers, variable layer heights constrained by the participating nozzles, a layer-height colour overlay, slicing, preview and send.                                                                                                                                                                                                                                                                                                                             |
| Presets like Bambu Studio's               | No    | Yes    | Done             | Bambu system presets resolved as Bambu Studio does, user presets with Bambu import and export, per-job and per-spool slicer settings.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| G-code preview                            | No    | Yes    | Done             | The workspace uses the engine's processed toolpaths and per-object statistics when available. Job cards and send windows retain layer range, move scrubber, feature/filament/speed colours and time per layer. Single-object upstream G-code has no object labels, so per-object estimates remain unavailable there.                                                                                                                                                                                                                                            |
| Bambu project files (3MF)                 | No    | Yes    | Done             | Reads sliced `.gcode.3mf` plates, and reads and writes Bambu Studio / OrcaSlicer projects in the slicing workspace. Cross-language reference fixtures verify preservation of unknown fields, attachments, painting and transforms.                                                                                                                                                                                                                                                                                                                              |
| Calibration (flow, pressure advance…)     | No    | Yes    | Done             | Calibrate page: flow rate (two passes or OrcaSlicer's YOLO), pressure advance (lines, pattern, tower), temperature tower, retraction, max volumetric speed and VFA, made by Print Lab Slicer, queued, read with a drawing and saved to the spool's filament preset. The printer's own flow dynamics and flow rate calibration and its K profiles on each printer page, switched off where Bambu Studio switches them off (flow rate on the H2 series, flow dynamics on the P1 series). Needs the engine (not the command line).                                 |
| Cut, emboss, boolean, simplify, measure   | No    | Yes    | Partial          | The slicing workspace measures surface points and axis offsets, cuts along project planes, combines/subtracts/intersects solids and simplifies with a surface tolerance. Placement and undo are preserved; geometry-specific data clearing needs consent. Cut supports one model part; boolean supports two single-part, single-copy objects. Raised and engraved text supports surface picking and becomes mesh geometry. Cut, simplify and text support one model part; assembly view, broader multipart operations and editable vector text remain deferred. |
| MakerWorld and other model sites          | Yes   | Yes    | Done             | Paste a Printables, Thingiverse or MakerWorld link; credits and licence appear on the project page. Import stages and cancellation appear in Activity. Pictures and files depend on what the site permits; model files can also be dropped into the app.                                                                                                                                                                                                                                                                                                        |

## What Bambu does not have

| Feature                                          | Family Print Lab | Notes                                                                                                                                                                                |
| ------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A profile for each maker, projects, checklists   | Done             | Ideas, sketches, slicer settings and the result of each print, per person.                                                                                                           |
| Kid mode with print requests                     | Done             | Kids make things from safe templates and ask; a grown-up approves here or on the phone.                                                                                              |
| Parametric workbench with AI design              | Done             | OpenSCAD in WebAssembly, live sliders, version history; AI with your own subscription.                                                                                               |
| Local-first, LAN-only                            | Done             | Listens on `127.0.0.1` by default. Printers are reached on the LAN only.                                                                                                             |
| Encrypted cloud backups                          | Done             | Family plan; sealed on the computer with a recovery key only the family has.                                                                                                         |
| Verified connection to each printer              | Done             | Bambu CAs bundled; otherwise the certificate is pinned on first use.                                                                                                                 |
| Optional login for LAN access                    | Done             | A household password or profile PINs for LAN devices, signed-in devices and Log out. Repeated failures increase the per-address lockout up to 24 hours, retained until a quiet week. |
| Family differentiators (rewards, safe catalogue) | Done             | kids: print limits per child, badges, a family gallery with camera photos, printable certificates.                                                                                   |
| Statistics, maintenance tracker                  | Done             | Stats by date, printer and person with a CSV; maintenance tasks from the Bambu Lab wiki with reminders, a print-hours odometer and a nozzle log.                                     |
| Smart plugs, Home Assistant, MQTT out            | Done             | home-automation, off until you set it up: smart plugs, MQTT out, Home Assistant access and Prometheus metrics.                                                                       |
| First-run wizard                                 | Done             | onboarding: a setup guide from a fresh lab to a first print.                                                                                                                         |

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
- **Print Lab Cloud needs protocol v2** for every printer, remote control and sealed status. An older
  cloud gets v1 (the first printer's progress only) until a phone key exists; after that the app asks
  for the cloud to be updated rather than send status in the clear.
- **Print Lab Slicer is built separately.** `slicer/scripts/upstream.sh build` builds the engine; the
  v2.2.0 Linux installer bundles the engine, verified on Ubuntu 22.04. Windows and macOS installers
  use an installed Bambu Studio command line, with calibration tests off. Native build fixes for
  those platforms are on `parity`; complete native-runner verification remains pending.
- **Camera over RTSPS.** The simulator serves every model's camera the port-6000 way, so the RTSPS
  path through ffmpeg (X1, P2S, H2 and X2D series) is covered by unit tests of its arguments and
  certificate check, not by a live stream.
- **Simulator gaps.** The X1, X1E and one H2C variant have no simulated state of their own and start
  from their closest sibling.

## Continuation validation (2026-09-27)

Before changes, app check was clean, unit tests had 1,282 passes, 65 skips and one network-dependent
failure. Playwright could not launch its hard-coded system Chrome: 34 failures and 19 unrun tests.
Cloud check and all 66 Cloud unit tests passed.

The deterministic connection fixture and bundled Chromium configuration remove those baseline
failures. Repeated browser runs exposed a certificate/badge prefetch race and two test timing/selector
issues, now fixed. Three consecutive full quiet browser runs pass 61 tests each, with one
installed-Studio-only skip (3.8, 3.9 and 3.9 minutes). All previously deferred browser specs run.

The native-backed app unit run passes 1,440 tests across 157 files, with four explicit skips:
two installed-Studio CLI tests, one opt-in Blender GUI test and the protocol-only missing-capability
case (the full engine provides those capabilities). Check reports zero errors and warnings;
Prettier and ESLint pass. Cloud check, lint and all 66 unit tests pass. Linux desktop preparation
copies the engine bundle byte for byte and loads all 361 server chunks. Strict ASan/UBSan passes
all 10 native tests and 105 integration tests, with one protocol-only skip. Release checks also pass
10 native and eight protocol tests. Five printer goldens now record seconds and grams and pass in
both release and strict sanitizer builds. Valgrind reports zero errors and zero definite/indirect
leaks without suppressions; 960 bytes possibly lost in runtime TLS and 1,880 reachable bytes remain.

No physical printer or Windows/macOS native runner was used for the local continuation checks.

## Release deployment (2026-09-27)

The initial Print Lab Cloud 0.2.0 release was deployed at `https://familyprintlab.app` from `d9eedfd`. Migration
`0007_remote.sql` was applied before deployment. Existing production variables, secrets and resource
bindings were preserved. Public pages and phone-key assets return 200; unauthenticated printer pages
redirect to sign-in and the printer API returns 401. Worker version:
`22c48d03-8919-4a5d-b885-91bca4922f49`. Cloud check, formatting and all 66 tests pass locally; its
private GitHub Actions job cannot start until the account billing/spending restriction is resolved.

Family Print Lab [v2.2.0](https://github.com/benfavre/family-print-lab/releases/tag/v2.2.0) is published
at commit `5dc7ffa`. All three desktop installer jobs passed. The Linux native dependency/engine build
on Ubuntu 22.04 took 3,465 seconds (57 minutes 45 seconds) at four workers; ten native tests and 105
integration tests passed, with one protocol-only skip. All 11 release assets and three updater
manifests were verified, including installer SHA-512 checksums. The published Linux package and its
engine start successfully inside Ubuntu 22.04 and serve the profile page on loopback. The live
download page shows 2.2.0, and all four installer links redirect to its published assets.

Windows and macOS installers retain the installed-Studio fallback. Native runner attempts found
Windows CRLF target-list and Perl selection issues, plus macOS OCCT standard-selection and Bash 3.2
issues. Fixes and regression checks are committed on `parity`; targeted native retries continue.
CI now retains completed dependency caches after later failures and supports one-platform retries.
These follow-up build changes do not alter the v2.2.0 tag. Installers remain unsigned, and no physical
printer has been used.

## Phone integration follow-up (2026-09-27)

The Cloud companion now keeps phone keys for several linked computers, preserving the legacy
single-key browser entry. Status, queues, camera replies and commands use the correct computer’s key.
Missing or rotated keys affect only the matching computer; a phone can forget one saved key or all
of them. Key storage failures do not downgrade to plain-text status. Camera switching clears the
previous image, and commands cancelled with Escape cannot reuse an earlier confirmation.

This update is compatible with the released desktop 2.2.0 protocol; no desktop upgrade is required.
The desktop pairing instructions and protocol documentation are updated on `parity` for the next
installer release. Physical-printer verification remains outstanding.

Cloud `22f7d47` is deployed as Worker `315b07b8-5538-4a99-8295-a379003bd90c`. Production bindings
were unchanged, no D1 migration was required, and the live phone-key page passed anonymous pairing,
reload and individual/all-forgetting checks in an isolated browser. Secrets stayed out of network
requests. Printer/account authentication boundaries and deployed helper/service-worker assets were
verified. The public website and changelogs also include the integration update.

Validation for this follow-up:

- Cloud: check and formatting pass; 81 unit/integration tests pass (76 before this change).
- Cloud: 106 browser/service-worker checks pass, including 48 public website checks, 48 real-browser
  keyring cases across three widths and both themes, and 10 service-worker notification cases.
- Desktop baseline: check reports zero errors/warnings; 1,398 unit tests pass with 46 optional/native
  and protocol-only skips in this run. Native-engine tests were not enabled for this UI/Cloud change.
- Desktop after changes: check, Prettier and ESLint pass; 44 Cloud unit tests pass with one
  protocol-only skip, plus both phone approval and cloud-remote simulator browser tests.

No engine code or installer assets changed in this follow-up.

## Bambu and slicer integration follow-up (2026-09-27)

Send mapping now respects reported AMS nozzle bindings and the fixed left/right external-spool
addresses on dual-nozzle printers. Known wrong-side selections cannot be forced, including empty
or unreported external spools. Automatic mapping and queue selection use the same restrictions;
the Send panel updates when a feeder changes nozzle. Single-nozzle files and unknown legacy AMS
bindings retain their previous behaviour. Material warnings are checked again after waking a printer,
before any upload, and still require an explicit override.

Native `config.validate` is enabled and shares slicing's preparation of plate overrides, filament
maps, nozzle volumes, grouping and calibration. Validation keeps existing sliced files and previews.
Imported sliced files discard negative/non-finite estimates and fall back to valid G-code or filament
metadata, keeping invalid values out of planning and filament accounting.

The baseline app check had zero errors/warnings. Its native-backed unit run had 1,430 passes,
13 skips and one failure: the local binary still reported the previous patch queue. The selected
browser baseline had three passes and one failure because the editing test assumed no engine was
installed. That test now explicitly exercises the no-engine case on any host.

The focused printer checks pass all 78 unit/simulator tests and the browser test for rebinding an
AMS feeder while the Send panel is open. Imported-estimate and FTP checks pass all 19 tests.
The full native-backed app run passes 1,467 tests across 158 files, with four optional/protocol-only
skips. App check has zero errors/warnings; Prettier and ESLint pass. The rebuilt engine passes
12 native and nine protocol tests, plus 105 integration tests with one protocol-only skip.
Dependencies refreshed in 473.23 seconds; the release-engine rebuild took 389.05 seconds and its
final incremental build 25.10 seconds, at 24 workers.
The new native validation tests pass Valgrind with zero errors and zero definite/indirect leaks;
3,840 possibly-lost bytes in TBB worker TLS and 4,256 reachable bytes remain, without suppressions.
This follow-up used release builds and Valgrind; the full ASan/UBSan results above are from the earlier
continuation pass.
All 63 browser tests pass in 4.2 minutes. The first full run found one further catalogue-dependent
test assumption: a broad infill search stayed on Quality while the requested field was on Strength.
Searching for the exact setting key makes that test work with the installed native catalogue too.

Windows/macOS build work continues. Both completed their dependency superbuilds in earlier attempts;
native `pkg-config.exe` selection and old-macOS JSON formatting fix the subsequent configure/compiler
errors. The next macOS attempt passed the JSON stage and exposed a missing upstream header include,
fixed by patch 0017. A later missing `<sstream>` include is fixed by patch 0018; both failures were
reproduced and checked with Clang, using libc++ for the standard-library case. These changes are on
`parity`, not in the published 2.2.0 installers. Complete Windows/macOS native build verification
remains pending in GitHub Actions. No physical printer has been used.

Sliced plates retain their nozzle diameter metadata. Sends and queue dispatch block a known diameter
mismatch, including after wake-up and with a material override; the Send panel rechecks when the
printer reports a nozzle change. Fixed dual-nozzle checks use the pinned slicer's logical left/right
ordering and only the nozzles used by that plate. Missing legacy metadata, unknown reported diameters,
and ambiguous dual mappings retain their previous behaviour. Dynamic rack and filament-switcher
assignments still need a dedicated compatibility check: their metadata is recognised, but this
fixed-nozzle comparison does not guess their physical assignment. Validation uses simulator and
browser fixtures; no real-printer verification is claimed.

### 2.2.1 release validation (in progress)

The candidate passes 1,491 app unit/integration tests (four expected skips), up from 1,467
before this pass. App check reports zero errors and warnings; Prettier and ESLint pass.
Nozzle changes pass 98 targeted tests and two dedicated browser cases. Four complete app
browser runs with fresh databases pass all 65 cases each, up from 63 before this pass.
The latest run, after the Unicode archive fix, took 3.9 minutes.
The command-palette test now focuses the main region before checking shortcuts.
Cloud passes 82 unit tests and 106 browser cases; its GitHub Actions job remains blocked by
account billing, so these results come from local verification.

Queue 20 contains 21 upstream patches. The latest local rebuild took 304.23 seconds at 24 workers
and passes 13 native, ten protocol and 107 integration tests (one protocol-only integration skip).
The RPC concurrency regression passes 50 consecutive runs using explicit gates. Project files,
profiles, scratch files, toolpath previews, thumbnails and the native slice/export fixture exercise
accented and non-Latin paths. The earlier Linux AppImage check verified server discovery of its
bundled engine and all 56 printer profiles from an isolated Unicode installation/data directory.

Native macOS builds and integration tests passed before the latest archive patch. Its runtime
bundle now includes and relocates zstd, retains the BSD notice, and passes a downloaded-artifact
Mach-O audit. Windows compilation and linkage passed in 37 minutes 47 seconds, followed by all
13 native and ten protocol tests. Its broader integration suite exposed Unix-only launcher fixtures
and an upstream ANSI conversion when adding Unicode source files to a 3MF archive. The launcher
fixes now pass the actual Windows preflight; patch 0021 removes the archive conversion, with full
native retries running on all platforms. No Windows integration or packaged-release pass is claimed yet.

Release automation verifies source/artifact provenance, requires every native platform, and checks
installed AppImage/NSIS/dmg packages before staging an immutable tag and draft release. Installer
checks cover bundled profiles, the isolated data directory, local server discovery, capabilities and
macOS runtime dependencies. An intentional negative CI check rejected stale native artifacts and
skipped both packaging and release staging. Publication remains gated on all three installed-package
checks and verified installer/updater checksums.
