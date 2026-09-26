# Print Lab Slicer and upstream Bambu Studio

Print Lab Slicer is built from [Bambu Studio](https://github.com/bambulab/BambuStudio)'s slicing core
(libslic3r, AGPL-3.0, compatible with this project's AGPL-3.0-or-later). This page is how we keep that
fork up to date. The short version: **our code never lives inside the upstream tree**, so moving to a
new Bambu Studio release is a rebase of a handful of small patches, not a merge of two histories.

## The pin

<!-- pin:start -->

| Upstream | Tag | Commit | Patch queue |
| --- | --- | --- | --- |
| Bambu Studio | `v02.08.02.61` | `926a7192574bcb9b3a732e1ec59a46d79cb45466` | version 0, 0 patch(es), hash `(empty)` |

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
  patches/series      our patch queue, in order (empty today)
  patches/NNNN-*.patch  git format-patch files, each explaining why it exists
  rr-cache/           recorded conflict resolutions (git rerere), replayed on the next update
  ports/ORIGINS.md    files we adapted from Bambu Studio or OrcaSlicer, with the commit they came from
  scripts/upstream.sh fetch | rebase | export | status | resources | ports | build | test
  tests/upstream.test.sh  tests upstream.sh against a toy upstream with three tags
  .upstream/          the checkout (never committed): the pinned tag plus the patch queue
```

In `slicer/.upstream` the branch `printlab` is the pinned tag with our patches on top, and the tag
`printlab-base` marks the upstream commit underneath them.

## Rules that keep updates cheap

1. **Our code stays outside the upstream tree.** The engine (`slicer/engine`, when it lands) consumes
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
4. Build and test (once `slicer/engine` exists): `slicer/scripts/upstream.sh build -j 6`, then
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

## State of the engine

The update tooling above works today and is tested; the app slices through a stock Bambu Studio or
OrcaSlicer command line (`app/src/lib/server/slicer.ts`, found by `slicer/locate.ts`). The native
engine (`slicer/engine`: the facade, the JSON-RPC loop and the build) is not in the repository yet.
The app side of its protocol is: `StdioEngine` in `app/src/lib/server/slicer/engine.ts` speaks the
Slicer Engine Protocol (`app/src/lib/shared/slicer/protocol.ts`) and is tested against a fake engine.
When `slicer/engine/CMakeLists.txt` lands, `upstream.sh build` builds the deps superbuild with the
headless options above into `${PRINTLAB_SLICER_BUILD_DIR:-slicer/.build}/deps`, then the engine into
`…/engine`, and the workflow builds and tests it on every update.
