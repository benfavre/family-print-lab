# 3D Printing for the Office & Home Lab

This folder manages 3D-printing projects for the office and home lab: ideas, measurements, designs, slicer files, print results, and installed parts.

## Family app

The working project tracker lives in [`app/`](app/README.md): a SvelteKit + TypeScript app with a local SQLite database (Drizzle ORM), a model workbench (parametric OpenSCAD, mesh tools, Blender), a read-only link to the Bambu Lab printer, and AI help through your Claude or ChatGPT subscription.

```sh
cd app
nvm use                 # Node 24
npm start               # http://127.0.0.1:8765 (after npm install && npm run build)
npm run dev:sim         # development with a simulated printer until the real one is set up
```

Data lives in `app/data/printlab.db` (model files in `app/data/models/`) with automatic daily backups in `app/data/backups/`. The previous version of the app (single JSON file) is kept in `archive/app-legacy/`; its data was imported on 2026-09-25. See [app/README.md](app/README.md) for setup, configuration and architecture.

## Reference notes

- [Tasks](TASKS.md): next actions and work in progress.
- [Projects](projects/README.md): active designs and completed prints.
- [Equipment](inventory/equipment.md): printer and printing accessories.
- [Office](office/README.md): desk and storage print ideas.
- [Home lab](homelab/README.md): cable, labeling, and equipment organization print ideas.
- [3D printing](printing/README.md): printer, materials, and print projects.
- [Maintenance](maintenance/log.md): completed work and next checks.

## Working conventions

- Use Markdown for notes and ISO dates (`YYYY-MM-DD`).
- Give equipment stable IDs, such as `PRN-001`.
- Keep one folder per project under `projects/`; start with the [project template](templates/project.md).
- Store project source files and exports with that project's notes. Record which revision was printed or installed.
- Mark unknown information as `TBD`; distinguish planned equipment from equipment actually owned.
- Record completed maintenance in the log and upcoming work in tasks.
- Store passwords, API keys, printer access codes, Wi-Fi credentials, and recovery keys in a password manager. Reference the entry name only.

Start by choosing one useful part, measuring where it will fit, and creating its project folder.
