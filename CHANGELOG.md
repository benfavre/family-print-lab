# Changelog

Changes to Family Print Lab, the local, self-hosted household printing app. Print Lab Cloud is an
optional companion with its own releases. Earlier releases remain documented in the
[GitHub release history](https://github.com/benfavre/family-print-lab/releases).

## Unreleased

These changes are on `parity` after the published 2.2.0 tag. They are **not included in the 2.2.0
installers**.

- Match H2D/X2D filaments to feeders connected to the correct nozzle. Reject known wrong-side
  selections before sending, including forced sends; queue dispatch checks the same restrictions.
- Recheck filament warnings after waking a printer, before uploading a file.
- Enable native configuration validation with the same plate overrides, filament grouping and
  calibration preparation used for slicing, without discarding existing previews or sliced files.
- Ignore invalid time and filament estimates in imported sliced files, using valid G-code or
  filament metadata where available.

- Clarify phone pairing for several computers: scan each computer’s key and revoke a lost phone on
  each computer. The Cloud companion now keeps multiple keys without replacing existing pairings,
  including keys saved by older phone clients; this also works with the released 2.2.0 app.

- Fix Windows dependency target discovery when command output contains carriage returns, and select
  native Windows Perl when building OpenSSL.
- Set the C++ standard required by OCCT on AppleClang and support macOS's bundled Bash 3.2.
- Use portable JSON number formatting on older macOS targets and select native Windows
  `pkg-config.exe` explicitly.
- Supply missing upstream header includes exposed by Clang/libc++ when precompiled headers are off.
- Retain completed native dependency caches when a later build step fails, and allow retries of one
  engine platform at a time. Complete Windows and macOS native-engine verification remains pending.

## 2.2.0 — 2026-09-27

[Download 2.2.0](https://github.com/benfavre/family-print-lab/releases/tag/v2.2.0) ·
[Changes since 2.1.5](https://github.com/benfavre/family-print-lab/compare/v2.1.5...v2.2.0)

This release brings the parity programme into the desktop app: an integrated slicing workspace,
more printer and filament controls, a print queue, family tools and optional remote access. It also
ships the first verified Linux desktop bundle of **Print Lab Slicer**, our headless engine built on
Bambu Studio's slicing core. Slicing and project editing run on your computer.

### Desktop availability

| Platform            | Installers     | Slicing in this release                                                |
| ------------------- | -------------- | ---------------------------------------------------------------------- |
| Linux x64           | AppImage, deb  | Bundled Print Lab Slicer; package and engine verified on Ubuntu 22.04. |
| Windows x64         | NSIS installer | Uses an installed Bambu Studio command line. No bundled native engine. |
| macOS Apple silicon | dmg, zip       | Uses an installed Bambu Studio command line. No bundled native engine. |

All three installer jobs passed. The Windows and macOS **native-engine** builds did not; their
installers retain the command-line fallback. Engine-generated calibration tests require Print Lab
Slicer and are unavailable through that fallback. Installers remain unsigned; macOS updates require
manual installation while code signing is unavailable.

### Print Lab Slicer and project files

- Open and save Bambu Studio and OrcaSlicer 3MF projects through the native engine. Round-trip tests
  in both directions against the TypeScript reader and writer cover unknown fields, attachments,
  object transforms, painting and layer-height profiles.
- Preview the engine's processed toolpaths in the workspace, with layer, feature, filament and speed
  views. Show per-object time and filament statistics when the G-code contains object labels.
- Automatically group filaments for H2D/X2D extruders and reserve wipe-tower space during arrangement.
- Produce repeatable time and filament estimates. Fix uninitialised processor state that could yield
  negative time estimates, including `M73 R-2147483648`, and record time/weight goldens for X1 Carbon,
  P1S, A1 mini, H2D and X2D.
- Preserve nullable configuration values and raw G-code strings across the JSON interface. Keep
  project settings available for editing. Configuration errors detected by the engine block slicing;
  some legacy fields and forward-compatible substitutions remain accepted upstream.
- Fix native memory errors, leaks and worker-startup deadlocks found by AddressSanitizer,
  UndefinedBehaviorSanitizer and Valgrind. Keep upstream changes in a documented patch queue at
  Bambu Studio `v02.08.02.61`; see [UPSTREAM.md](slicer/UPSTREAM.md).

### Slicing workspace and modelling

- Work with multiple plates, object transforms, Bambu presets, AMS tray choices, modifiers,
  height ranges, progress reporting, preview and sending plates as jobs. Save changes when leaving
  and retain undo history for edits.
- Paint colour, supports and seams. A small brush can subdivide a facet using Bambu-compatible
  painting data instead of colouring its entire original triangle.
- Edit variable layer heights with adaptive, smoothing and brush tools. Respect participating
  extruders' layer-height limits and show a colour overlay on the model. Preserve valid two-point
  profiles through project saves and undo.
- Measure between surface points or entered coordinates, including individual axis offsets.
- Cut along a project plane, simplify a sealed mesh within a surface tolerance, and combine,
  subtract or intersect solids without changing their placement.
- Add raised or engraved text on a picked model surface, including tilted undersides. Text becomes
  mesh geometry in the project.
- Ask before clearing painting and other geometry-specific data that an operation invalidates.
  Undo restores the original object and its metadata; cancelled or late operations cannot overwrite
  a newer selection or edit.
- Generate flow-rate, pressure-advance, temperature, retraction, maximum volumetric speed and VFA
  calibration prints with the native engine, queue them, and save results to filament presets.

### Printers, filament and everyday printing

- Manage several printers with on-demand LAN discovery, model-specific capabilities, live status,
  temperature history and redacted diagnostics. Printer writes explain when Developer Mode is off.
- Add camera viewing, snapshots, timelapse controls and a Media page for browsing and downloading
  files from printer storage. RTSPS cameras use the system ffmpeg.
- Expand printer controls for temperatures, fans, lights, speed, motion, AMS loading and unloading,
  drying, printer calibration and guarded custom G-code. Skip objects from a clickable plate map.
- Link AMS trays to shelf spools and account for filament per tray. Import spools and synchronise
  usage with an optional Spoolman server.
- Queue jobs for a chosen printer or one that fits. Require a clear plate before starting the next
  print, with holds, quiet hours and an upcoming-job view.
- Explain HMS alerts with offline English and French text, severity, pictures, links, supported
  actions and history. Missing French entries fall back to English; failed-job context uses public
  printer snapshot fields.
- Add notification history and desktop notifications, with optional ntfy, webhook, Discord,
  Telegram and email channels, event choices and quiet hours.
- Track printer hours, nozzle changes and maintenance reminders, and compare printing activity by
  date, printer or maker with CSV export.

### Family projects and optional integrations

- Import models from Printables, Thingiverse and MakerWorld links, subject to each site's access
  rules, or drop files into the app. Show designer credits and licences on the project page, plus
  import progress and cancellation in Activity.
- Extend kid mode with print requests, per-child limits, badges, a gallery with camera photos and
  printable certificates. Award a completed-print badge before its certificate is fetched.
- Guide a fresh installation through adding a printer, choosing tools, adding the family and sending
  a first print.
- Connect optional smart plugs, Home Assistant, an MQTT broker and Prometheus metrics. Smart-plug
  automation can power a printer on before a job and wait for it to cool before switching off.
- Offer opt-in camera checks for possible print failures, either a rough local check through ffmpeg
  or a chosen AI provider, with history, alerts and an optional pause. These checks are off by default.

### Remote access, privacy and access control

- With optional Print Lab Cloud protocol v2, share every selected printer, its alerts and queue with
  household phones. With a paired household phone key, encrypt shared status, queue details and camera pictures; sign
  pause, resume, stop and “Start next” commands so the relay cannot forge them. Without a phone key,
  opted-in status and queue sharing can use the plain-text compatibility path.
- Persist remote-command replay protection in local SQLite across restarts. Refuse commands if the
  protection cannot be recorded, and refuse an unencrypted protocol downgrade once a phone key exists.
- Keep “Start next” tied to the computer's queue decision and a plate marked clear; arbitrary remote
  file selection is not included.
- Harden LAN PIN/password access against parallel guesses and session escalation. Repeated failures
  extend the address lockout up to 24 hours.
- Keep loopback binding (`127.0.0.1`) as the default. Cloud sharing, AI providers, external notification
  channels and other network integrations remain opt-in.
- The companion Print Lab Cloud 0.2.0 deployment includes protocol-v2 migration `0007_remote.sql`.
  Self-hosted companion deployments must apply this migration before deploying the Worker; see
  [the cloud protocol](docs/cloud-protocol.md).

### Verification and known limits

- **Printer validation uses the simulator, not physical hardware.** No real-printer compatibility is
  claimed. The RTSPS camera path has argument and certificate tests, but no live RTSPS stream test;
  some simulator variants use a closely related model's state.
- **Modelling is still partial.** Cut, simplify and text operate on one model part; Boolean operations
  require two single-part, single-copy objects. Simplification requires a sealed mesh. Assembly view,
  broader multipart operations and editable vector text remain deferred.
- **Object estimates need labels.** Upstream single-object G-code has no object labels, so per-object
  estimates are unavailable for that case.
- **Storage and firmware controls are limited.** Deleting printer files, storage-tunnel support and
  “Print again” are deferred. Firmware flashing is not provided.
- App checks report **zero errors and warnings**, with Prettier and ESLint clean. The native-backed
  app unit run passed **1,440 tests**, with four explicit optional/protocol-only skips.
- Three consecutive full browser runs passed **61 tests each**, with one installed-Studio-only skip.
  Previously deferred model-import, HMS, cloud-remote, phone and split-view coverage ran successfully.
- Strict ASan/UBSan passed **10 native tests and 105 integration tests**, with one protocol-only skip.
  Valgrind reported **zero errors and zero definite or indirect leaks**, with small runtime
  TLS/reachable allocations remaining.
- The Linux release build passed the same native/integration suite on Ubuntu 22.04. The published
  Linux package and engine started successfully there and served the app on loopback. All 11 release
  assets and three updater manifests were checked, including installer SHA-512 checksums.

For the detailed feature matrix, hardware caveats and current follow-up work, see
[the parity status](docs/parity/STATUS.md).
