# Family Print Lab desktop

An Electron shell around the same app: it starts the app's server inside Electron (on a free local
port, bound to `127.0.0.1`), keeps the database in the per-user app folder, and updates itself from
GitHub Releases with `electron-updater`.

Install Node 24 and Bun first. Install the web app’s dependencies with `bun install` in `app/`, then:

```sh
cd desktop
bun install
bun run start      # builds the web app into server/ and opens it
bun run dist       # installers for this platform in release/ (not published)
```

`scripts/prepare-server.mjs` builds `../app` into `server/`, copies the migrations and resources, and
loads every chunk of the build to prove all its packages are installed here (release fails otherwise).
`scripts/after-pack.cjs` restores `three/examples/jsm`, which electron-builder always strips.

## Where things live

|                                     | Linux                        | macOS                                            | Windows                      |
| ----------------------------------- | ---------------------------- | ------------------------------------------------ | ---------------------------- |
| Data, `printlab.env`, `desktop.log` | `~/.config/Family Print Lab` | `~/Library/Application Support/Family Print Lab` | `%APPDATA%\Family Print Lab` |

Settings the web app reads from its environment (printer, `ANTHROPIC_API_KEY`, `CLOUD_URL`…) go in
`printlab.env` (File → Printer and AI settings), then File → Restart.

## Releasing

1. Bump `version` in `desktop/package.json` (and `app/package.json`).
2. Commit, then push the intended tag explicitly, for example `git tag v2.2.1 && git push origin v2.2.1`.
3. The _Desktop release_ workflow requires native engine builds and tests on all three platforms.
   It builds Windows (NSIS), macOS (dmg, zip) and Linux (AppImage, deb), staging their assets and
   `latest*.yml` updater manifests in a **draft** GitHub Release. Missing native bundles fail packaging.
4. Each installer job extracts or installs its package, checks the bundled engine handshake and
   capabilities, then launches the packaged app on loopback through Playwright. Review all three
   `desktop-smoke-*` artifacts and successful job results. Verify the updater manifest checksums
   against the uploaded assets and complete the release notes before publishing the draft.
5. Publish the verified draft with `gh release edit v2.2.1 --draft=false --latest`. Verify the public
   download links and update the website's platform notes to match the actual release.

To repeat the installer smoke check locally, run `node scripts/smoke-package.mjs` from `desktop/`
after packaging (use `xvfb-run -a` on headless Linux). It uses a temporary data directory, disables
Cloud and redirects updater checks to loopback. The test needs the app's Playwright dependency.

Installed apps check for updates at start and every 6 hours, download in the background, and offer
to restart. Code signing is not set up yet (see the main README).
