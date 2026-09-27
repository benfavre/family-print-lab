# Continue the parity programme on a bigger machine

Paste the prompt below into Claude Code on the new machine, in an empty working directory.

---

We're continuing the "parity" programme for Family Print Lab (AGPL, self-hosted household 3D printing
for Bambu Lab printers) and Print Lab Cloud (proprietary Cloudflare Worker companion). The goal is to be
more feature-complete than Bambu Handy and Bambu Studio. That includes our own slicer, "Print Lab Slicer":
a headless engine built on Bambu Studio's libslic3r, kept modular so upstream updates stay cheap. All 21
work packages are built and merged on branch `parity` in both repos. This machine is much bigger than the
one that built them, so the job now is the heavy work that was deferred, plus hardening.

## 1. Setup

```sh
git clone https://github.com/benfavre/family-print-lab && git -C family-print-lab switch parity
git clone https://github.com/benfavre/printlab-cloud   && git -C printlab-cloud switch parity
```

Toolchain rules:

- **Node.** Install Node 24 through nvm (`nvm install 24`). Start every shell command that runs node
  tooling with `source ~/.nvm/nvm.sh && nvm use 24 >/dev/null`.
- **Packages.** Use bun only, never npm, pnpm or yarn:
  - `bun install` in `family-print-lab/app` and in `printlab-cloud`
  - `bun run check`
  - `bunx vitest --run`
  - `bunx playwright test`
- **Lock files.** Add `bun.lock` to `.git/info/exclude` in both repos. The committed npm lock files stay
  as they are.
- **System packages.**
  - Needed: ffmpeg, git, cmake, ninja, gcc/g++ 11 or newer, m4, and the build essentials for Bambu
    Studio's dependency superbuild.
  - Recommended: valgrind, and clang for the sanitizer build.
  - Playwright chromium: `bunx playwright install chromium`.
- **Baseline.** Before changing anything, run both repos' check and unit tests plus the Playwright suite.
  Record the results.

## 2. Read first

- `family-print-lab/docs/parity/PLAN.md`: the architecture, contracts and package specs. Each package
  section lists its deferred items.
- `family-print-lab/docs/parity/STATUS.md`: the feature matrix against Handy and Studio, with honest
  status.
- `family-print-lab/slicer/UPSTREAM.md`: how the fork works, the patch queue, `upstream.sh`, the engine
  build and the engine's current state.
- `family-print-lab/docs/cloud-protocol.md` and `printlab-cloud/README.md`.

## 3. Work, in priority order

1. **Build the native engine at full speed.**
   Run `slicer/scripts/upstream.sh fetch`, then `build -j <cores>`, then `test`.
2. **Fix the non-deterministic time and filament estimate.**
   `slice_info.config` sometimes shows `prediction` -2147483648, and the G-code has
   `M73 R-2147483648`. Build the engine and libslic3r with `-fsanitize=address,undefined`, and also run
   it under valgrind. Find the uninitialised read on the G-code processor path.
   - Fix it in our facade if possible. Otherwise add a minimal, upstreamable patch to
     `slicer/patches`, following the rules in UPSTREAM.md.
   - Then record the golden `seconds` and `grams`:
     `GOLDEN_UPDATE=1 GOLDEN_REASON='time and weight recorded' slicer/scripts/upstream.sh test`.
3. **Finish the engine's missing capabilities.** They currently answer CAPABILITY_MISSING:
   - `project.open` and `project.save`: Bambu 3MF read/write. The TypeScript port in slicer-3mf is the
     behavioural reference, and round-trip tests must pass both ways.
   - `preview.get`
   - Multi-extruder filament grouping (the H2D/X2D auto map)
   - The wipe tower placeholder when arranging

   Then switch the slicer workspace to the engine's per-object time/filament and its own toolpath
   preview.

4. **Cross-platform engine builds.** Make `slicer-build.yml` (Windows, macOS) actually work. Use a local
   runner, or act, or at least get the build to succeed on whatever OS is available. Make sure the
   desktop app bundles `slicer/dist/<platform>`.
5. **Re-run Playwright on a quiet machine.** These specs were skipped under load: `model-import`, `hms`,
   `cloud-remote`, `phone`, and the `app.e2e.ts` split-view test. Also run the whole suite several times
   to find flaky tests, and fix them.
6. **Clear the deferred items** listed in each package section of PLAN.md and in STATUS.md, highest value
   first. Known ones:
   - The cloud-remote replay cache is in memory. Persist seen command ids, or refuse commands timed
     before the app started.
   - Add jobId, subtaskId and jobAttr to `PrinterSnapshot`, so hms stops reading the private report.
   - Translate HMS messages to other languages (French first).
   - Show model-import credits on the project page.
   - Show import progress in the Activity tray.
   - Painting that splits triangles under a small brush.
   - Variable layer height: use the multi-extruder limits, and add a colour overlay.
   - Slicer-ui follow-ups: cut, emboss, measure, simplify, boolean.
   - Longer lan-auth PINs, or a longer lockout cap.
7. **Bigger multi-agent passes.** You may use Workflow orchestration. The lessons from the first run:
   - Launch from inside a git repo.
   - For parallel packages, each agent creates its own worktree with
     `git -C <repo> worktree add <dir> -B parity-<key> parity` and removes it when done.
   - Branch names use a dash, `parity-<key>`. Git refuses `parity/<key>` because `parity` exists.
   - A single merger merges one branch at a time, and sets migration idx/when at merge time
     (PLAN.md §7.3).
   - Only the merger touches the main checkout.

## 4. Rules

- **Printer protocol.** Never guess payloads. Verify against OpenBambuAPI, ha-bambulab or the Bambu
  Studio source at the pinned tag, and cite the source in a code comment.
- **No real printer.** Unless I say one is connected, everything is tested against the simulator. Never
  claim real-printer verification.
- **Privacy.** Local-first. Nothing leaves the machine unless the user opts in. The server binds to
  127.0.0.1 by default.
- **Code style.**
  - Match the surrounding code.
  - UI copy is plain, short, sentence case, and uses British spelling.
  - Svelte 5 runes.
- **Quality bar.**
  - `bun run check`: 0 errors, 0 warnings.
  - Unit tests and Playwright: green.
  - prettier and eslint: clean.
  - New logic comes with tests.
- **Commits.**
  - Style: "Area: what it does, in plain words".
  - End each message with the attribution trailer Claude Code gives you.
  - Work on `parity` or on `parity-<key>` branches. Never commit to main/master.
  - Do not push or open PRs without asking me.
- **Print Lab Cloud deploys.** Never deploy. Note that `migrations/0007_remote.sql` must be applied
  (`bun run db:migrate:remote`) before `wrangler deploy`.

## 5. Finish

Report:

- what was done, and what is still deferred and why
- before/after test results
- engine build times on this machine

Update STATUS.md and UPSTREAM.md to match reality.
