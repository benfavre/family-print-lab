# Family Print Lab

A self-hosted workshop for a household's 3D printing: collect ideas for each person, design parts in a model workbench, send sliced plates to a Bambu Lab printer on your network, and keep track of every print and spool of filament. It runs on your own computer, and your data stays in a local SQLite database.

## Features

- **Profiles for each maker.** Choose who is making when the app opens. Each person has their own ideas, projects and progress, and switching profiles keeps unsaved drafts.
- **Projects and print jobs.** Checklists, sketches, slicer settings, the model version that was printed, and the outcome and time of each print.
- **Model workbench.** Parametric OpenSCAD parts with live sliders, mesh tools (scale, cut, drill, combine, lay flat), Blender repair and round-trips, and full version history. Download any version as STL or 3MF.
- **Printers.** Every current Bambu Lab model, as many as you have, on your own network (LAN-only mode). Find them with one button, see live status (temperatures, both nozzles, AMS trays, progress, alerts), send sliced `.gcode.3mf` plates, and start, pause, resume or stop prints. Jobs close themselves when a print finishes, fails or is cancelled.
- **Slicing.** Slice a model version for any of your printers from the job page, with the main settings. It uses a Bambu Studio or OrcaSlicer install for now; our own engine, Print Lab Slicer, is being built from Bambu Studio's slicing core ([`slicer/UPSTREAM.md`](slicer/UPSTREAM.md)).
- **Notifications.** A bell in the top bar for finished, failed and paused prints, printer alerts, filament running out and kids asking to print. In the desktop app they also show as system notifications. Optional channels send them to your phone or chat (ntfy, Discord, Telegram, email or your own webhook), each with its own events, quiet hours and wording.
- **Filament shelf.** Each spool is charged for what its prints actually used.
- **Kid mode.** Kids make things from safe templates and ask to print them; a grown-up approves on the Family page (or on the phone, with Print Lab Cloud).
- **AI help (optional).** Uses your own Claude or ChatGPT subscription through the official Claude Code or Codex CLIs, or an Anthropic API key. It can design OpenSCAD models from a description or sketch, diagnose failed prints, suggest slicer settings, and help with writing.
- **Safe with your data.** Automatic daily backups, JSON export and import, and live sync across open tabs.
- **Print Lab Cloud (optional, paid).** Answer kids' requests and follow a print from your phone, get a notification when it ends, keep an encrypted copy of your backups, and add template packs and models from the shop.

How this compares with Bambu Handy and Bambu Studio, and what is still to come: [docs/parity/STATUS.md](docs/parity/STATUS.md).

## Download

Get the desktop app for Windows, macOS or Linux from **[familyprintlab.app/download](https://familyprintlab.app/download)** (or the [latest release](https://github.com/benfavre/family-print-lab/releases/latest)). It keeps itself up to date. Your data stays on your computer, in the app's own folder (File → Open data folder), and printer or AI settings go in File → Printer and AI settings.

The installers are not code-signed yet: Windows may show a SmartScreen warning (More info → Run anyway), and on macOS open the app with right-click → Open the first time. Automatic updates on macOS need signing, so Mac users download new versions by hand for now.

## Run from source

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
| Bambu Studio or OrcaSlicer                             | Slicing inside the app                                |
| Bambu Lab printers in LAN-only + Developer Mode        | Live status, sending plates, print control            |

## Privacy and security

- The server listens on `127.0.0.1` only, and it has **no login**. Profiles are for convenience, not access control. Don't expose it to the internet. To use it on your LAN, list the host names in `ALLOWED_HOSTS` and trust everyone on that network.
- Nothing leaves your machine unless you turn on an AI provider, add a notification channel or link Print Lab Cloud.
- **Printers** are reached on your local network only, never through Bambu's cloud: status over the printer's MQTT service (port 8883) and uploads over FTPS (port 990), both encrypted. Access codes stay in the local database. The app checks each printer's certificate against Bambu's certificate authorities, or remembers the certificate the first time you press Test and refuses a different one later, so the access code is never sent to a device pretending to be your printer. **Find printers** listens for the printers' announcements and sends one broadcast on your network (UDP port 2021), only when you press it. Download diagnostics saves a report to your computer with serials, access codes, job and file names and account ids removed; nothing is uploaded.
- **Why LAN-only and Developer Mode.** Bambu printers accept commands from other apps only in LAN-only mode with Developer Mode on (printer settings → Network). That turns off Bambu's cloud (remote printing and viewing in Bambu Handy), and anyone on your network who knows the access code can then control the printer, so keep the code private and your Wi-Fi password strong. Without Developer Mode the app still shows status, and says why commands do nothing.
- **Notification channels** are off until you add one (Integrations → Notifications). Each sends the message text (printer and print names, alerts, a kid's display name) to the service you chose, and a picture from the printer's camera only if you switch that on; pictures of kids' prints need their own switch. Tokens and passwords stay in the local database and are never shown again. The public ntfy.sh server lets anyone who knows a topic read it, so the app suggests a random one. Links in messages appear only when `ORIGIN` is set.
- **Slicing** runs on your computer. Nothing is sent anywhere.
- **Print Lab Cloud (optional)** lets a grown-up answer kids’ print requests from a phone. Linking is off until you do it on the Family page; the app then opens one outbound connection, shares only print requests (child’s first name or “Your child”, the title, message, size, colour and a small picture), and the cloud can only approve or decline a waiting request. Two more things are shared only if you switch them on: “Share print progress” sends the first printer’s state, print name, percentage, time left and layer (nothing else about your printers), and Cloud backup uploads backups sealed on your computer with a recovery key the cloud never sees. The full protocol is in [docs/cloud-protocol.md](docs/cloud-protocol.md). AI requests send what the task needs (for example profile names and ages, project details, photos you attach, or a model's code) to the provider you chose.
- Subscription-based AI runs the official CLIs with tools, file access and MCP servers disabled. It is meant for one person using their own subscription. Don't share an instance that is signed in to your account.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Contributing

Issues and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[GNU Affero General Public License v3.0 or later](LICENSE). You can use, modify and self-host it freely. If you offer a modified version to others over a network, you must share its source under the same license.

Bundled fonts keep their own licenses (SIL Open Font License; see `app/static/fonts/` and `app/resources/fonts/`).

Family Print Lab is an independent project. It is not affiliated with or endorsed by Bambu Lab, Anthropic or OpenAI. Their names are used only to describe compatibility.
