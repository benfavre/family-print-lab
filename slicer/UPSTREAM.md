# Print Lab Slicer and upstream Bambu Studio

Print Lab Slicer is built from [Bambu Studio](https://github.com/bambulab/BambuStudio)'s slicing core
(libslic3r, AGPL-3.0, compatible with this project's AGPL-3.0-or-later). This page is how we keep that
fork up to date. The short version: **our code never lives inside the upstream tree**, so moving to a
new Bambu Studio release is a rebase of a handful of small patches, not a merge of two histories.

## The pin

<!-- pin:start -->

| Upstream     | Tag            | Commit                                     | Patch queue                                                                                     |
| ------------ | -------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Bambu Studio | `v02.08.02.61` | `926a7192574bcb9b3a732e1ec59a46d79cb45466` | version 7, 5 patch(es), hash `c0fcb78443f56333fd2b3bdb6f4fb89c88e2360b2a8eb3a3fd790ecd13c184b4` |

<!-- pin:end -->

`slicer/upstream.lock` is the only place the version is written; `upstream.sh export` rewrites it and
the table above. Everything derived from Bambu Studio reads the same pin through
`app/tools/lib/upstream.ts`: the printer model catalogue (`app/tools/gen-printer-models.ts`), HMS
texts, vendor profiles and the engine build. So bumping the lock moves all of it together, and the
helper refuses a local checkout that is not at the pinned commit.

## How the pieces fit

```
slicer/
  upstream.lock       the pin: name, url, tag, commit, queue version, queue hash
  UPSTREAM.md         this page
  patches/series      our patch queue, in order
  patches/NNNN-*.patch  git format-patch files, each explaining why it exists
  rr-cache/           recorded conflict resolutions (git rerere), replayed on the next update
  orca.lock           the OrcaSlicer release the calibration ports were compared against
  ports/ORIGINS.md    files we adapted from Bambu Studio or OrcaSlicer, with the commit they came from
  scripts/upstream.sh fetch | rebase | export | status | resources | ports | build | test
  scripts/build-deps.sh  Bambu Studio's dependency superbuild, headless and cached
  engine/             printlab-slicer, our engine (CMake project; consumes the checkout)
    src/main.cpp        stdio setup (protocol on the real stdout, everything else to stderr)
    src/rpc/            JSON, the JSON-RPC server (a strand per project, progress, cancel), methods
    src/facade/         the facade interface and our plain structs
      upstream/         the ONLY code that includes upstream headers (Model, presets, slice, export)
      null_facade.cpp   the build without upstream (protocol layer only)
    src/features/       our modules: thumbnails (CPU rasteriser for plate pictures), calib (calibration
                        test recipes ported from Bambu Studio's and OrcaSlicer's GUI; see below)
    resources/          our own runtime files (calibration models from OrcaSlicer), bundled as resources/printlab/
    tests/              ctest: JSON, rpc, thumbnails, calib, and a facade smoke test with upstream
  tests/upstream.test.sh  tests upstream.sh against a toy upstream with three tags
  tests/golden/       golden slices (expected.json), run by app/src/lib/server/slicer/golden.test.ts
  .upstream/          the checkout (never committed): the pinned tag plus the patch queue
  .build/             build output (never committed): deps/, engine/, engine-protocol/
  dist/<platform>/    the engine bundle (never committed): binary, resources, LICENSE, engine.json
```

In `slicer/.upstream` the branch `printlab` is the pinned tag with our patches on top, and the tag
`printlab-base` marks the upstream commit underneath them.

## Rules that keep updates cheap

1. **Our code stays outside the upstream tree.** The engine (`slicer/engine`) consumes
   upstream through CMake `add_subdirectory(… EXCLUDE_FROM_ALL)`.
2. **One facade.** Only `slicer/engine/src/facade/` includes upstream headers or names upstream types.
   When Bambu Studio changes an API, the fix is in one place.
3. **Features are modules, not patches.** Our own work (thumbnails, analysis, calibration) goes in
   `slicer/engine/src/features/`.
4. **Patches are the last resort, and small.** First try upstream's own options (`SLIC3R_GUI=OFF`,
   `SLIC3R_BUILD_TESTS=OFF`, deps `DEP_BUILD_WXWIDGETS=OFF`, `DEP_BUILD_GLFW=OFF`,
   `DEP_BUILD_FFMPEG=OFF`, `DEP_BUILD_LIBHARU=OFF`). Prefer build-system patches and generic extension
   points over logic edits. A feature that truly needs an engine change gets its own series named
   `1xxx-<feature>-…` so the base queue stays short.
5. **Every patch explains itself.** The commit message says why it exists, which files it touches and
   `Upstreamable: yes` or `no`. Upstreamable patches should be offered to Bambu Lab, so the queue shrinks.
6. **Ported code is tracked.** A file adapted from Bambu Studio or OrcaSlicer has an
   `origin: <repo> <path> @ <commit>` header line and a row in `ports/ORIGINS.md`.
7. **Never use Bambu's proprietary network plugin** (`bambu_networking`, `NetworkAgent`) or anything
   from `src/slic3r` (the GUI). CI fails the build if the binary references them.
8. **A GitHub fork is optional and never the source of truth.** `upstream.sh export --push <remote>`
   pushes a browsable branch `printlab/<tag>`; the patch queue in this repository stays authoritative.

## Updating to a new Bambu Studio release

The `Slicer upstream` workflow (`.github/workflows/slicer-upstream.yml`) does this every Monday and
opens a pull request, or an issue listing the patches that no longer apply. By hand:

1. Pick the release. Use the latest one that is not a pre-release:
   `gh api repos/bambulab/BambuStudio/releases/latest --jq .tag_name` (newer pre-release tags exist).
2. Materialise the current pin: `slicer/scripts/upstream.sh fetch`
3. Replay the queue onto the new tag: `slicer/scripts/upstream.sh rebase v02.08.xx.yy`
   - It applies cleanly: go to step 4.
   - It stops on a conflict: see _Resolving a patch that stopped applying_ below.
4. Build and test: `slicer/scripts/upstream.sh build -j 6`, then
   `slicer/scripts/upstream.sh test`.
5. Write the new pin and queue back: `slicer/scripts/upstream.sh export`. This rewrites
   `patches/`, `upstream.lock` and the table on this page.
6. Regenerate everything derived from the pin, from `app/`:
   - `../slicer/scripts/upstream.sh resources` (profiles, printers and HMS texts into
     `app/resources/bambu/`, git-ignored)
   - `bunx tsx tools/gen-printer-models.ts --strict` (it lists model codes Bambu Studio has and our
     catalogue lacks; add them to `MODEL_CODES` in `src/lib/shared/printers/models.ts`)
   - `bun run hms:build` and `bun run profiles:fetch` when those scripts exist
7. Check ported files: `slicer/scripts/upstream.sh ports`. Review each `CHANGED` one against
   upstream and update its commit in `ports/ORIGINS.md`.
8. Run the app checks (`bun run check`, `bunx vitest --run`) and open a pull request titled
   "Slicer: Bambu Studio <tag>" with `slicer/` (including `rr-cache/`) and the regenerated files.

`slicer/scripts/upstream.sh status` shows the pin, the checkout and whether anything is unexported
at any point.

## Resolving a patch that stopped applying

`rebase` stops at the first patch that conflicts and says so.

1. `git -C slicer/.upstream status` lists the conflicted files. Fix them, keeping the intent written
   in the patch's commit message.
2. `git -C slicer/.upstream add <files>` and `git -C slicer/.upstream rebase --continue`. Repeat until
   the rebase finishes.
3. `slicer/scripts/upstream.sh export`, then carry on from step 4 above.
4. Commit `slicer/rr-cache/` with the rest: git rerere recorded your resolution there, and the next
   `rebase` (yours or the workflow's) replays it without stopping.

If the patch is no longer needed because upstream now does the same thing, drop it during the rebase
(`git rebase --skip`) and say so in the pull request. To give up and start again:
`git -C slicer/.upstream rebase --abort && FORCE=1 slicer/scripts/upstream.sh fetch`.

With `--report <file.json>` (the workflow's mode) `rebase` does not stop: it aborts, then tries every
patch against the new tag and writes `{"ok": false, "failed": ["0002-….patch", …]}` so the issue
lists all of them at once. The checkout is left as it was.

## Adding or changing a patch

1. `slicer/scripts/upstream.sh fetch`
2. Edit in `slicer/.upstream` and commit on branch `printlab`, one commit per patch. The message:

   ```
   Build: consume libslic3r from a parent CMake project

   Why: our engine adds upstream with add_subdirectory; CMAKE_SOURCE_DIR then points at our tree.
   Files: CMakeLists.txt, src/CMakeLists.txt
   Upstreamable: yes
   ```

   To change an existing patch, use `git commit --fixup` and `git rebase -i --autosquash printlab-base`.

3. `slicer/scripts/upstream.sh export` and commit `slicer/` in a pull request.

`fetch` refuses to throw away commits that are only in the checkout; export them first (or pass
`FORCE=1` on purpose).

## Testing the tooling

`bash slicer/tests/upstream.test.sh` runs `upstream.sh` against a toy upstream with three tags:
fetch, export, re-fetch from the queue, a clean rebase, a conflicting one (with and without
`--report`), a recorded resolution replayed by rerere, and a tag that moved upstream (refused). CI runs
it on every pull request.

## Building the engine

`slicer/scripts/upstream.sh build [-j N]` (or `bun run slicer:build` from `app/`) does everything:

1. `build-deps.sh`: Bambu Studio's dependency superbuild (`slicer/.upstream/deps`) into
   `${PRINTLAB_SLICER_BUILD_DIR:-slicer/.build}/deps/usr/local`, with upstream's own switches for a
   headless build (`DEP_BUILD_WXWIDGETS=OFF`, `DEP_BUILD_FFMPEG=OFF`, `DEP_BUILD_LIBHARU=OFF`,
   `DEP_BUILD_GLFW=OFF`) and without the GL targets (`dep_GLEW`, `dep_OpenCSG`). It builds `m4` into
   the build directory when the host lacks it (GMP needs it). The result is stamped with a key (tag,
   git tree of `deps/`, platform) that CI also uses for its cache; `build-deps.sh --print-key` shows it.
   About 75 minutes with `-j 2` on an 8-core laptop, 634 MB installed.
2. The engine: `cmake -S slicer/engine -B .build/engine -DPRINTLAB_UPSTREAM_DIR=slicer/.upstream
-DCMAKE_PREFIX_PATH=.build/deps/usr/local`, which adds upstream with `add_subdirectory(…
EXCLUDE_FROM_ALL)` (`SLIC3R_GUI=OFF`, `FLATPAK=ON` so no FFmpeg is copied) and builds only
   libslic3r and what it needs.
3. The bundle in `slicer/dist/<platform>/`: `printlab-slicer`, `resources/` (profiles, printers,
   info from the same tag), `LICENSE`, `engine.json`. The app finds it there (`slicer/locate.ts`);
   the desktop build copies it next to the server. The build fails if the binary mentions
   `bambu_networking` or `NetworkAgent`.

`upstream.sh build --no-upstream` builds only the protocol layer (a minute, no checkout needed): it
answers `engine.hello` with the pin and no slicing capabilities, which is what the conformance tests
and the `slicer-protocol` job in ci.yml need (it runs on every pull request, so app-side client
changes are checked against the engine too). `upstream.sh test` runs ctest, then the app's slicer tests with
`PRINTLAB_SLICER_PATH` set to the build (protocol conformance and golden slices included).

The patch queue holds two build fixes and three memory-safety fixes, all marked upstreamable:

- 0001: the top-level `CMakeLists.txt` asked for OpenGL, GLEW and GLFW even with the GUI off, and
  those are what fails on a headless host.
- 0002: `FilamentMixer.hpp` uses `std::map` without including `<map>`. Upstream builds libslic3r with
  precompiled headers, which hides it; the engine builds without them (`SLIC3R_PCH=OFF`, to keep each
  compiler process small), so a missing include shows up as a compile error. Any further one found the
  same way gets the same one-line treatment.
- 0003: a concentric-infill edge grid retained references into a temporary point vector; keep the
  vector alive until the intersection check completes.
- 0004: initialise bed-temperature/layer caches and the no-tower heating-position sentinel; do not
  construct an exclusion polygon from undefined wipe-tower bounds.
- 0005: release placeholder strings when comparisons change their type or move assignment replaces
  them, and release the 3MF exporter's temporary heap ZIP buffers after their readers finish.

## State of the engine

- The app side is complete and tested: `StdioEngine` (`app/src/lib/server/slicer/engine.ts`) against a
  fake engine, `CliEngine` (`cli.ts`) against a fake Bambu Studio for every model in the catalogue,
  `service.ts` (what jobs call) through both, and the protocol conformance tests against the real
  protocol-only binary.
- The protocol layer and features pass locally with Make, Ninja and Ninja Multi-Config (`--no-upstream`); native Windows and macOS verification remains outstanding.
- The full engine builds, links and runs on Linux x64 (Ubuntu 22.04, GCC 11, `-j 2`: about 75
  minutes for the dependencies and about two hours for libslic3r and the engine). ctest passes
  (`test_facade` slices a cube for the P1S), the protocol conformance tests pass, the golden boxes
  for the X1C, P1S, A1 mini, H2D and X2D slice to the recorded layer counts and nozzle diameters, and
  a job sliced by the engine prints to Succeeded on the simulated P1S
  (`modules/slicer-engine/module.test.ts`). No real printer has printed its files yet.
- What linking needed: libslic3r calls a few things upstream only builds with the GUI (nanosvg,
  `Slic3r::Http` and `BBL_Encrypt` for LogSink's encrypted logs, OpenSSL's MD5), so
  `facade/upstream/link_shims.cpp` compiles nanosvg and gives the other two no-op bodies: the engine
  opens no network connection. Upstream's enum-list option defaults carry no keys (`restore_enum_maps`
  in `convert.cpp`), and `nozzle_volume_type` / `filament_volume_map` are set per plate as the CLI does.
- The non-deterministic time and filament estimates came from the facade leaving `Print::m_origin`
  unset. `Print::export_gcode` passes that value to the G-code processor's XY offset. The facade now
  follows `PartPlate::set_print`, setting a zero origin after translating the model to plate-local
  coordinates, and sets the zero-based plate index. Three repeated cube slices now agree on time
  and filament; the bounded, finite estimate assertions fail on the original build.
- Valgrind also found an uninitialised volume paint-cache timestamp (initialised in our facade),
  an incomplete PNG IHDR (fixed in our thumbnail encoder), and upstream memory errors. Queue patch
  0003 keeps concentric-infill edge-grid points alive through intersection checks. Patch 0004
  initialises G-code temperature/layer caches and skips an undefined wipe-tower bounding box.
  Patch 0005 also fixes string-comparison/move-assignment and temporary ZIP-buffer leaks. After
  the fixes, Valgrind reports zero memory errors and zero definitely/indirectly lost bytes across
  three repeated slices and export. Small reachable/possibly-lost runtime allocations remain
  (5,696 bytes total in that run). Full sanitizer validation and golden time/weight recording are
  still in progress.
- A re-configure used to rebuild all of libslic3r, because its version header carries the configure
  time; `upstream.sh build` now sets `SOURCE_DATE_EPOCH` to the pinned commit's time.
- Native `preview.get` writes the browser's PLPV format from `GCodeProcessorResult`. Its layers,
  travel filtering, and per-object time/filament pass a TypeScript cross-decoder test. The workspace
  already prefers this capability and displays the engine's object statistics. Upstream omits object
  labels for single-instance/calibration prints; unavailable breakdown values remain null.
- The H2D/X2D auto-map setup now supplies the CLI's virtual AMS slots and retains the selected maps
  for export. Two-filament native tests pass for both printers, including an X2D regression that retains
  Bowden-specific retraction settings after grouping. Resolvers preserve raw filament variants
  and their owner indices until the upstream grouping pass selects them. Wipe-tower arrangement
  reservations pass both portable sizing tests and native arrangement tests.
- Native `project.open`/`project.save` pass all seven TypeScript reference fixtures in both
  directions, including unknown fields, attachments, painting and transforms. Geometry import/export
  uses libslic3r; a preservation codec retains fields its slicing model normalises. Opening/saving
  unsupported configuration remains possible, while slicing refuses invalid settings instead of
  silently substituting defaults. An eighth integration test covers that boundary. `config.validate`
  still needs to share all per-plate preparation with slicing.
- The current machine is Linux x64 (Ubuntu 24.04, GCC 13.3, 24 logical CPUs, 62 GiB RAM shared with
  other processes). The first complete dependency and release-engine build at `-j 24` took
  **1,239.93 seconds (20 minutes 40 seconds)**. The pinned source fetch took 22.48 seconds.
- Make, Ninja and Ninja Multi-Config dependency-target discovery and protocol builds are verified
  locally. Windows/macOS workflow/tool discovery and desktop bundle copying have been hardened,
  but neither OS has been run on this machine; those CI jobs remain nonblocking.

On a bigger machine, from the repository root:

```
slicer/scripts/upstream.sh fetch
slicer/scripts/upstream.sh build -j 16
slicer/scripts/upstream.sh test
# once the time estimate is repeatable:
GOLDEN_UPDATE=1 GOLDEN_REASON='time and weight recorded' slicer/scripts/upstream.sh test
```

## Diagnostic builds

`upstream.sh build --sanitize -j N` builds the engine **and libslic3r** with address, undefined-behaviour
and float-cast-overflow sanitizers. It reuses the release dependency prefix but keeps instrumented
objects in `.build/engine-sanitize` and its bundle in `dist/sanitize/<platform>`. Run
`UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1 slicer/scripts/upstream.sh test --sanitize` for strict failure on UB.
`--debug-symbols` similarly uses `.build/engine-debug` and `dist/debug/<platform>` for Valgrind or a
debugger. `test --native-only` runs just ctest; `test --no-upstream` selects the protocol build.
Normal desktop packaging always reads `dist/<platform>`, never the diagnostic bundles.

For Valgrind, set `PRINTLAB_TEST_RESOURCES` to the pinned checkout's `resources/` and run
`valgrind --track-origins=yes --error-limit=no --error-exitcode=99 .build/engine/tests/test_facade`
from `slicer/`. Keep the full log: the initial cascade exceeded Valgrind's default 1,000-context limit.

## Calibration tests

`calib.generate` (capability `calib.<kind>` for flow_rate, pa_line, pa_pattern, pa_tower, temp_tower,
retraction, max_volumetric and vfa) opens a project holding one test. The per-layer changes are
upstream's own (libslic3r `Calib.cpp` and `GCode.cpp` read `Print::set_calib_params`); what the GUI does
before slicing (load the model, scale and cut it, change the settings) is ported into
`engine/src/features/calib/` as plain recipes and applied in `engine/src/facade/upstream/calib.cpp`.
The models come from the checkout's `resources/calib/` (copied into the bundle by `build`), plus
OrcaSlicer's linear flow test models in `engine/resources/calib/`. On an update, compare
`src/slic3r/GUI/Plater.cpp` (the `calib_*` functions) and `calib_dlg.cpp` with the recipes, and
OrcaSlicer's `adjust_settings_for_flowrate_calib` at the tag in `orca.lock`; the golden checks in
`app/src/lib/server/modules/slicer-calibration/golden.test.ts` read the steps back out of the G-code.
