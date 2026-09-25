# Family Print Lab

A self-hosted workshop for a household's 3D printing: collect ideas for each person, design parts in a model workbench, send sliced plates to a Bambu Lab printer on your network, and keep track of every print and spool of filament. It runs on your own computer, and your data stays in a local SQLite database.

## Features

- **Profiles for each maker.** Choose who is making when the app opens. Each person has their own ideas, projects and progress, and switching profiles keeps unsaved drafts.
- **Projects and print jobs.** Checklists, sketches, slicer settings, the model version that was printed, and the outcome and time of each print.
- **Model workbench.** Parametric OpenSCAD parts with live sliders, mesh tools (scale, cut, drill, combine, lay flat), Blender repair and round-trips, and full version history. Download any version as STL or 3MF.
- **Printer link.** Live status from a Bambu Lab printer in LAN-only mode. Upload sliced `.gcode.3mf` plates, then start, pause, resume or stop prints. Jobs close themselves when a print finishes.
- **Filament shelf.** Each spool is charged for what its prints actually used.
- **AI help (optional).** Uses your own Claude or ChatGPT subscription through the official Claude Code or Codex CLIs, or an Anthropic API key. It can design OpenSCAD models from a description or sketch, diagnose failed prints, suggest slicer settings, and help with writing.
- **Safe with your data.** Automatic daily backups, JSON export and import, and live sync across open tabs.

## Quick start

Requires Node.js 24. Developed and tested on Linux.

```sh
git clone <this repository> family-print-lab
cd family-print-lab/app
nvm use                     # Node 24, from .nvmrc
npm install
cp .env.example .env        # optional: printer, AI, port
npm run build
npm start                   # http://127.0.0.1:8765
```

No printer yet? `npm run dev:sim` runs the app with a simulated Bambu printer. Setup, configuration, architecture and tests are covered in [`app/README.md`](app/README.md).

### Optional tools

These are detected automatically and shown on the **Integrations** page:

| Tool                                                   | Enables                                               |
| ------------------------------------------------------ | ----------------------------------------------------- |
| [Claude Code](https://claude.com/claude-code) or Codex | AI features using your Claude or ChatGPT subscription |
| Anthropic API key                                      | AI features billed per use                            |
| Blender 4.2+                                           | Mesh repair, simplification and "Open in Blender"     |
| Bambu Lab printer in LAN-only + Developer Mode         | Live status, sending plates, print control            |

## Privacy and security

- The server listens on `127.0.0.1` only, and it has **no login**. Profiles are for convenience, not access control. Don't expose it to the internet. To use it on your LAN, list the host names in `ALLOWED_HOSTS` and trust everyone on that network.
- Nothing leaves your machine unless you turn on an AI provider or link Print Lab Cloud.
- **Print Lab Cloud (optional)** lets a grown-up answer kids’ print requests from a phone. Linking is off until you do it on the Family page; the app then opens one outbound connection, shares only print requests (child’s first name or “Your child”, the title, message, size, colour and a small picture), and the cloud can only approve or decline a waiting request. The full protocol is in [docs/cloud-protocol.md](docs/cloud-protocol.md). AI requests send what the task needs (for example profile names and ages, project details, photos you attach, or a model's code) to the provider you chose.
- Subscription-based AI runs the official CLIs with tools, file access and MCP servers disabled. It is meant for one person using their own subscription. Don't share an instance that is signed in to your account.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Contributing

Issues and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[GNU Affero General Public License v3.0 or later](LICENSE). You can use, modify and self-host it freely. If you offer a modified version to others over a network, you must share its source under the same license.

Bundled fonts keep their own licenses (SIL Open Font License; see `app/static/fonts/` and `app/resources/fonts/`).

Family Print Lab is an independent project. It is not affiliated with or endorsed by Bambu Lab, Anthropic or OpenAI. Their names are used only to describe compatibility.
