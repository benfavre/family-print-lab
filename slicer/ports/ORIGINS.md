# Ported files

Every file in this repository adapted from Bambu Studio or OrcaSlicer (calibration generators, the
paint codec, 3MF constants and so on) has a row here and an `origin: <repo> <path> @ <commit>` line in
its header comment. `slicer/scripts/upstream.sh ports` compares each Bambu Studio row with the current
pin and lists the ones whose upstream file changed, so ported code is reviewed on every update.
OrcaSlicer rows are compared by hand against the release in `slicer/orca.lock`.

Data generated from the pinned tree (the printer model catalogue, HMS texts, vendor profiles) is not
listed here: it is read through `app/tools/lib/upstream.ts` and regenerated on every update.

| Our file | Repository | Upstream path | Commit |
| --- | --- | --- | --- |
| `slicer/engine/src/features/calib/calib.cpp` | BambuStudio | `src/slic3r/GUI/Plater.cpp` | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `slicer/engine/src/features/calib/calib.cpp` | BambuStudio | `src/slic3r/GUI/calib_dlg.cpp` | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `slicer/engine/src/features/calib/calib.cpp` | OrcaSlicer | `src/slic3r/GUI/Plater.cpp` | `8500fcdccaa10b5099ac20d252af3a7c560046f1` |
| `slicer/engine/src/facade/upstream/calib.cpp` | BambuStudio | `src/slic3r/GUI/Plater.cpp` | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `slicer/engine/resources/calib/filament_flow/Orca-LinearFlow.3mf` | OrcaSlicer | `resources/calib/filament_flow/Orca-LinearFlow.3mf` | `8500fcdccaa10b5099ac20d252af3a7c560046f1` |
| `slicer/engine/resources/calib/filament_flow/Orca-LinearFlow_fine.3mf` | OrcaSlicer | `resources/calib/filament_flow/Orca-LinearFlow_fine.3mf` | `8500fcdccaa10b5099ac20d252af3a7c560046f1` |
| `app/src/lib/shared/slicer-calibration.ts` | BambuStudio | `src/slic3r/GUI/calib_dlg.cpp` | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/shared/slicer-calibration.ts` | BambuStudio | `src/slic3r/GUI/DeviceCore/DevCalib.cpp` | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/server/printer/commands/defs/slicer-calibration.ts` | BambuStudio | `src/slic3r/GUI/DeviceManager.cpp` | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
