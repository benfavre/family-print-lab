# Project 3MF fixtures

Test input for `slicer3mf.test.ts`. Every `.3mf` here is read, written and read again, and must come
back identical. Upstream files are copied unchanged.

| File                            | Source                                                                                                                         | Licence    | Covers                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `bambu-pa-pattern.3mf`          | Bambu Studio `resources/calib/pressure_advance/pa_pattern.3mf` at `v02.08.02.61` (`926a719`)                                   | AGPL-3.0   | Bambu Studio 1.7 project: custom G-code per layer (multi-line), `<assemble>`, plate thumbnails, identify ids, full project settings          |
| `bambu-auto-pa-line-dual.3mf`   | Bambu Studio `resources/calib/pressure_advance/auto_pa_line_dual.3mf` at `v02.08.02.61`                                        | AGPL-3.0   | 8 objects sharing one sub-model file (shared meshes), modifier parts with per-part settings, per-object extruders, cut information, dual-nozzle settings |
| `bambu-flowrate-test-pass1.3mf` | Bambu Studio `resources/calib/filament_flow/flowrate-test-pass1.3mf` at `v02.08.02.61`                                         | AGPL-3.0   | Plain 3MF from another tool: ZIP64 archive, inline meshes, material colour groups, thumbnail                                                |
| `bambu-test-buchse.3mf`         | Bambu Studio `tests/data/test_3mf/Geräte/Büchse.3mf` at `v02.08.02.61`                                                         | AGPL-3.0   | Minimal plain 3MF: one mesh, no settings (becomes one object on one plate)                                                                  |
| `orca-badge.3mf`                | OrcaSlicer `resources/handy_models/OrcaBadge.3mf` at `main` `6a07853` (2026-09)                                                | AGPL-3.0   | OrcaSlicer project: many parts per object with their own filaments, `filament_sequence.json`, empty project settings                        |
| `synth-bambu-features.3mf`      | Synthesised by `make-synthetic.ts` in the layout of Bambu Studio's exporter (`bbs_3mf.cpp`), not produced by Bambu Studio      | AGPL-3.0\* | Painting (supports, seam, colour incl. a split triangle, fuzzy skin), all part types, text part, height ranges, layer height profile, two plates with bed type, print sequence, spiral mode, filament maps, custom G-code on plate 2, filament sequence, non-ASCII passthrough name |
| `synth-prusa-volumes.3mf`       | Synthesised by `make-synthetic.ts` in the layout of PrusaSlicer's exporter (`3mf.cpp`, `version_2.8.1`), not produced by PrusaSlicer | AGPL-3.0\* | PrusaSlicer project: one mesh split into volumes by triangle ranges, `slic3rpe:` painting attributes, PrusaSlicer layer height profile        |

\* Part of this repository (AGPL-3.0-or-later).

No project file in either upstream repository has painting, height ranges, several plates or dual-nozzle
filament maps, so the two synthesised files cover those. Regenerate them with:

```sh
cd app && bunx tsx src/lib/server/slicer3mf/__fixtures__/make-synthetic.ts
```

SHA-256 of the upstream copies:

```
f06f8914ad2c7b1faf067f328ea6f8febc01cc3d3aebd399e08d1f5b12b176de  bambu-auto-pa-line-dual.3mf
f71b839130000caab52f99c258a575dabb0f46b1ddc74591c9e438720740e03c  bambu-flowrate-test-pass1.3mf
2e2c0e271a50c6f89cc42a97b134d6f678d7d3d2849fa9b48c8203586aba5111  bambu-pa-pattern.3mf
de20508dff06f8faf8ca992c00238d4affc916ba4b812e8ff9ec1571fec533a1  bambu-test-buchse.3mf
04573823874f90a8b46778ef35a78a210422bfef0051a53d296b3364ade56f93  orca-badge.3mf
```
