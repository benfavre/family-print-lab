# Family Print Lab desktop

An Electron shell around the same app: it starts the app's server inside Electron (on a free local
port, bound to `127.0.0.1`), keeps the database in the per-user app folder, and updates itself from
GitHub Releases with `electron-updater`.

```sh
cd desktop
npm install
npm start          # builds the web app into server/ and opens it
npm run dist       # installers for this platform in release/ (not published)
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
2. Commit, then `git tag v2.1.0 && git push --tags`.
3. The _Desktop release_ workflow builds Windows (NSIS), macOS (dmg, zip) and Linux (AppImage, deb)
   and publishes them, with the `latest*.yml` files the updater reads, as a GitHub Release.

Installed apps check for updates at start and every 6 hours, download in the background, and offer
to restart. Code signing is not set up yet (see the main README).
