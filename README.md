# Family Print Lab

A self-hosted workshop for a household's 3D printing: collect ideas for each person, design parts in a model workbench, send sliced plates to a Bambu Lab printer on your network, and keep track of every print and spool of filament. It runs on your own computer, and your data stays in a local SQLite database.

## Features

- **Profiles for each maker.** Choose who is making when the app opens. Each person has their own ideas, projects and progress, and switching profiles keeps unsaved drafts.
- **Projects and print jobs.** Checklists, sketches, slicer settings, the model version that was printed, and the outcome and time of each print.
- **Model workbench.** Parametric OpenSCAD parts with live sliders, mesh tools (scale, cut, drill, combine, lay flat), Blender repair and round-trips, and full version history. Download any version as STL or 3MF. Paste a Printables, Thingiverse or MakerWorld link to start a project with its credits, licence, pictures and (where the site allows) the files.
- **Printers.** Every current Bambu Lab model, as many as you have, on your own network (LAN-only mode). Find them with one button, see live status (temperatures and their history, both nozzles, fans, speed, AMS trays, progress), send sliced `.gcode.3mf` plates, and start, pause, resume or stop prints. Change speed, lights, temperatures and fans, jog and home, load and unload filament, and skip objects on a map of the plate. Jobs close themselves when a print finishes, fails or is cancelled.
- **Camera and timelapses.** Live view of every model's camera on this computer, snapshots, the timelapse and recording switches, and the printer's timelapse folder on the Media page.
- **Printer errors in plain words.** HMS alerts explained from an offline copy of Bambu's texts, with severity, a wiki link, Bambu's picture and the buttons Bambu offers, plus an alert history per printer.
- **Print queue.** Line jobs up for one printer or for any printer that fits. The next one starts once someone marks the plate clear, outside quiet hours, with the right filament loaded.
- **Slicing.** A slicing workspace with plates, move, rotate and scale, presets like Bambu Studio's (with your AMS trays), colour, support and seam painting, modifiers, variable layer height, a G-code preview and send. Jobs can also be sliced in one click. It runs on Print Lab Slicer, our own engine built from Bambu Studio's slicing core ([`slicer/UPSTREAM.md`](slicer/UPSTREAM.md)), or on an installed Bambu Studio when the engine is not there.
- **Calibration.** Flow rate, pressure advance, temperature, retraction and max volumetric speed tests, made by the engine, queued, read with a drawing and saved to the spool's preset. The printer's own flow calibration and K profiles on each printer page.
- **Notifications.** A bell in the top bar for finished, failed and paused prints, printer alerts, filament running out or running low, the queue, maintenance, AI checks and kids asking to print. In the desktop app they also show as system notifications. Optional channels send them to your phone or chat (ntfy, Discord, Telegram, email or your own webhook), each with its own events, quiet hours and wording.
- **Filament shelf.** AMS trays link to shelf spools (Bambu RFID spools by themselves), and each spool is charged for what its prints actually used. Optional Spoolman sync.
- **Statistics and maintenance.** Success rate, filament use and cost, printer hours and failure reasons, with a CSV. Care tasks from the Bambu Lab wiki with reminders, a print-hours odometer and a nozzle log.
- **Kid mode.** Kids make things from safe templates and ask to print them; a grown-up approves on the Family page (or on the phone, with Print Lab Cloud). Gentle print limits per child, badges, a family gallery with camera photos and printable certificates.
- **AI help (optional).** Uses your own Claude or ChatGPT subscription through the official Claude Code or Codex CLIs, or an Anthropic API key. It can design OpenSCAD models from a description or sketch, diagnose failed prints, suggest slicer settings, and help with writing. AI print checks (off by default) look at the camera every few layers for spaghetti or a part that came loose, with a rough check that runs on this computer or the AI you chose, and can pause the print.
- **Home automation (optional).** Smart plugs (Tasmota, Shelly, Home Assistant or a webhook) that switch a printer on before a print and off once it has cooled, MQTT out to your own broker with Home Assistant discovery, a Home Assistant token and Prometheus metrics.
- **Access from other devices (optional).** A household password or profile PINs for phones and tablets on your home network.
- **Safe with your data.** Automatic daily backups, JSON export and import, and live sync across open tabs.
- **Print Lab Cloud (optional, paid).** Answer kids' requests and follow every printer from your phone, get a notification when a print ends or needs you, pause, resume or stop a print, look through the camera, keep an encrypted copy of your backups, and add template packs and models from the shop. Status, camera pictures and commands are end-to-end encrypted with a key only your family's phones and computer have.

How this compares with Bambu Handy and Bambu Studio, and what is still to come: [docs/parity/STATUS.md](docs/parity/STATUS.md).

## Download

Current release: **[2.2.1](https://github.com/benfavre/family-print-lab/releases/tag/v2.2.1)**. Read the
[full changelog](CHANGELOG.md) for the slicing, printer and family features, validation and known limits.
The Windows x64, Linux x64 and macOS Apple silicon installers bundle Print Lab Slicer. The Mac package requires macOS 14 or newer.

Get the desktop app for Windows, macOS or Linux from **[familyprintlab.app/download](https://familyprintlab.app/download)** (or the [latest release](https://github.com/benfavre/family-print-lab/releases/latest)). Windows and Linux keep themselves up to date; Mac users install updates by hand. Your data stays on your computer, in the app's own folder (File → Open data folder), and printer or AI settings go in File → Printer and AI settings.

The installers are not code-signed yet. Windows may show a SmartScreen warning (More info → Run anyway). On macOS, first try opening the app. If the developer cannot be verified, follow [Apple’s instructions](https://support.apple.com/en-gb/102445) in System Settings → Privacy & Security → Open Anyway after checking that you trust the download. Automatic updates on macOS need signing, so Mac users download new versions by hand for now.

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

| Tool                                                   | Enables                                                                                               |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| [Claude Code](https://claude.com/claude-code) or Codex | AI features using your Claude or ChatGPT subscription                                                 |
| Anthropic API key                                      | AI features billed per use                                                                            |
| Blender 4.2+                                           | Mesh repair, simplification and "Open in Blender"                                                     |
| Print Lab Slicer                                       | The slicing workspace, one-click slicing and calibration tests (bundled with every desktop installer) |
| Bambu Studio or OrcaSlicer                             | Slicing when Print Lab Slicer is not installed (no calibration tests)                                 |
| ffmpeg                                                 | Live camera on printers other than the A1 and P1 series, and the rough AI print check                 |
| Bambu Lab printers in LAN-only + Developer Mode        | Live status, camera, sending plates, print control                                                    |
| Spoolman                                               | Importing spools and recording what each print used                                                   |
| Smart plugs, an MQTT broker or Home Assistant          | Switching printers on and off, and showing them in your home automation                               |
| A Thingiverse app token                                | Importing Thingiverse links (Printables and MakerWorld need nothing)                                  |

## Privacy and security

- The server listens on `127.0.0.1` only. This computer needs **no login**; profiles are for convenience, not access control. Don't expose it to the internet. To use it on your LAN, list the host names in `ALLOWED_HOSTS` and set a household password (Integrations → Access from other devices): other devices then log in with it or with a profile's PIN, and until a password is set they are turned away.
- Nothing leaves your machine unless you turn on an AI provider, a notification channel, home automation, Spoolman, import a model from a link, or link Print Lab Cloud. Each is off until you set it up, and each sends only what is listed below.
- **Printers** are reached on your local network only, never through Bambu's cloud: status and commands over the printer's MQTT service (port 8883), uploads and the timelapse folder over FTPS (port 990), and the camera over TLS on port 6000 (A1 and P1 series) or RTSPS on port 322 (the others, through ffmpeg on this computer), all encrypted. Only a printer that reports plain RTSP (port 554) is watched unencrypted. Access codes stay in the local database. The app checks each printer's certificate against Bambu's certificate authorities, or remembers the certificate the first time you press Test and refuses a different one later, so the access code is never sent to a device pretending to be your printer. **Find printers** listens for the printers' announcements and sends one broadcast on your network (UDP port 2021), only when you press it. Download diagnostics saves a report to your computer with serials, access codes, job and file names and account ids removed; nothing is uploaded.
- **Why LAN-only and Developer Mode.** Bambu printers accept commands from other apps only in LAN-only mode with Developer Mode on (printer settings → Network). That turns off Bambu's cloud (remote printing and viewing in Bambu Handy), and anyone on your network who knows the access code can then control the printer, so keep the code private and your Wi-Fi password strong. Without Developer Mode the app still shows status and the camera, and says why commands do nothing. Print Lab Cloud is how you reach the printers away from home instead.
- **Camera** pictures stay on this computer unless you choose otherwise: a notification channel sends one only if you switch that on (pictures of kids' prints need their own switch), AI print checks send one to the AI you chose (the rough check never sends anything), and Print Lab Cloud gets them only sealed for your phones.
- **AI print checks** are off until a parent turns them on. The rough check runs on this computer. With an AI provider, each check sends a camera picture and the print's name to it.
- **Notification channels** are off until you add one (Integrations → Notifications). Each sends the message text (printer and print names, alerts, a kid's display name) to the service you chose. Tokens and passwords stay in the local database and are never shown again. The public ntfy.sh server lets anyone who knows a topic read it, so the app suggests a random one. Links in messages appear only when `ORIGIN` is set.
- **Home automation** talks only to devices and servers you enter: smart plugs over their own local HTTP API (or your Home Assistant, or a webhook you choose), and MQTT out to your broker (`mqtts://` for TLS) with each printer's status and the lab's events. Home Assistant and Prometheus read `/api/ha/printers` and `/metrics` with a token you make, or from this computer. They see printer ids, names and status, never serials, access codes or addresses.
- **Spoolman** (optional) gets spool usage at the address you enter, and the app reads spools from it.
- **Model import** fetches a Printables, Thingiverse or MakerWorld page only when you paste its link, over HTTPS to those sites only (never to addresses on your network). A Thingiverse token is your own and stays on this computer.
- **Slicing** runs on your computer. Nothing is sent anywhere.
- **Print Lab Cloud (optional)** lets a grown-up answer kids’ print requests from a phone. Linking is off until you do it on the Family page; the app then opens one outbound connection, shares only print requests (child’s first name or “Your child”, the title, message, size, colour and a small picture), and the cloud can only approve or decline a waiting request. Everything else is off until a parent switches it on: printer status (state, print name, progress, layers), alerts and the queue; camera pictures and live view; pause, resume, stop and Start next from the phone (parent PIN). With the household phone key (shown as a QR code on the Family page and kept only on this computer and your phones), status, the queue and camera pictures are end-to-end encrypted, and phone commands are signed, so the cloud relays what it cannot read or forge; it keeps only each printer's id, state and latest event in the clear to send notifications. Cloud backup uploads backups sealed on your computer with a recovery key the cloud never sees. The full protocol is in [docs/cloud-protocol.md](docs/cloud-protocol.md).
- **AI requests** send what the task needs (for example profile names and ages, project details, photos you attach, or a model's code) to the provider you chose. Subscription-based AI runs the official CLIs with tools, file access and MCP servers disabled. It is meant for one person using their own subscription. Don't share an instance that is signed in to your account.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Contributing

Issues and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[GNU Affero General Public License v3.0 or later](LICENSE). You can use, modify and self-host it freely. If you offer a modified version to others over a network, you must share its source under the same license.

Bundled fonts keep their own licenses (SIL Open Font License; see `app/static/fonts/` and `app/resources/fonts/`).

Family Print Lab is an independent project. It is not affiliated with or endorsed by Bambu Lab, Anthropic or OpenAI. Their names are used only to describe compatibility.
