# Ported files

Every file in this repository adapted from Bambu Studio or OrcaSlicer (calibration generators, the
paint codec, 3MF constants and so on) has a row here and an `origin: <repo> <path> @ <commit>` line in
its header comment. `slicer/scripts/upstream.sh ports` compares each Bambu Studio row with the current
pin and lists the ones whose upstream file changed, so ported code is reviewed on every update.
OrcaSlicer rows are compared by hand against the release in `slicer/orca.lock`, PrusaSlicer rows
against the tag named in the file. `app/tools/ports-origins.test.ts` (part of the app's unit tests)
fails when a source file's header cites a Bambu Studio path (`src/libslic3r/…`, `src/slic3r/…`)
without a row here, or when a row's file has no `origin:` line naming that path.

Data generated from the pinned tree (the printer model catalogue, HMS texts, vendor profiles) is not
listed here: it is read through `app/tools/lib/upstream.ts` and regenerated on every update.

| Our file                                                               | Repository  | Upstream path                                            | Commit                                     |
| ---------------------------------------------------------------------- | ----------- | -------------------------------------------------------- | ------------------------------------------ |
| `slicer/engine/src/facade/wipe_tower.hpp`                              | BambuStudio | `src/slic3r/GUI/Jobs/ArrangeJob.cpp`                     | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `slicer/engine/src/facade/wipe_tower.hpp`                              | BambuStudio | `src/slic3r/GUI/PartPlate.cpp`                           | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `slicer/engine/src/facade/upstream/arrange_orient.cpp`                 | BambuStudio | `src/slic3r/GUI/Jobs/ArrangeJob.cpp`                     | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `slicer/engine/src/facade/upstream/arrange_orient.cpp`                 | BambuStudio | `src/slic3r/GUI/PartPlate.cpp`                           | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `slicer/engine/src/facade/upstream/slice.cpp`                          | BambuStudio | `src/BambuStudio.cpp`                                    | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `slicer/engine/src/facade/upstream/slice.cpp`                          | BambuStudio | `src/slic3r/GUI/PartPlate.cpp`                           | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `slicer/engine/src/facade/upstream/slice.cpp`                          | BambuStudio | `src/slic3r/GUI/Plater.cpp`                              | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `slicer/engine/src/features/calib/calib.cpp`                           | BambuStudio | `src/slic3r/GUI/Plater.cpp`                              | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `slicer/engine/src/features/calib/calib.cpp`                           | BambuStudio | `src/slic3r/GUI/calib_dlg.cpp`                           | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `slicer/engine/src/features/calib/calib.cpp`                           | OrcaSlicer  | `src/slic3r/GUI/Plater.cpp`                              | `8500fcdccaa10b5099ac20d252af3a7c560046f1` |
| `slicer/engine/src/facade/upstream/calib.cpp`                          | BambuStudio | `src/slic3r/GUI/Plater.cpp`                              | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `slicer/engine/resources/calib/filament_flow/Orca-LinearFlow.3mf`      | OrcaSlicer  | `resources/calib/filament_flow/Orca-LinearFlow.3mf`      | `8500fcdccaa10b5099ac20d252af3a7c560046f1` |
| `slicer/engine/resources/calib/filament_flow/Orca-LinearFlow_fine.3mf` | OrcaSlicer  | `resources/calib/filament_flow/Orca-LinearFlow_fine.3mf` | `8500fcdccaa10b5099ac20d252af3a7c560046f1` |
| `app/src/lib/shared/slicer-calibration.ts`                             | BambuStudio | `src/slic3r/GUI/calib_dlg.cpp`                           | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/shared/slicer-calibration.ts`                             | BambuStudio | `src/slic3r/GUI/DeviceCore/DevCalib.cpp`                 | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/server/printer/commands/defs/slicer-calibration.ts`       | BambuStudio | `src/slic3r/GUI/DeviceManager.cpp`                       | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/client/slicer/settings.ts`                                | BambuStudio | `src/libslic3r/PrintConfig.cpp`                          | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/client/slicer/settings.ts`                                | BambuStudio | `src/slic3r/GUI/Tab.cpp`                                 | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/server/gcode/parse.ts`                                    | BambuStudio | `src/libslic3r/GCode/GCodeProcessor.cpp`                 | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/server/modules/controls/plate.ts`                         | BambuStudio | `src/libslic3r/Format/bbs_3mf.cpp`                       | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/server/modules/hms/actions.ts`                            | BambuStudio | `src/slic3r/GUI/DeviceErrorDialog.hpp`                   | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/server/modules/hms/actions.ts`                            | BambuStudio | `src/slic3r/GUI/DeviceErrorDialog.cpp`                   | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/server/printer/commands/defs/core.ts`                     | BambuStudio | `src/slic3r/GUI/DeviceManager.cpp`                       | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/server/printer/commands/defs/core.ts`                     | BambuStudio | `src/slic3r/GUI/SelectMachine.cpp`                       | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/server/printer/commands/defs/controls.ts`                 | BambuStudio | `src/slic3r/GUI/DeviceManager.cpp`                       | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/server/printer/commands/defs/controls.ts`                 | BambuStudio | `src/slic3r/GUI/StatusPanel.cpp`                         | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/server/printer/commands/defs/ams.ts`                      | BambuStudio | `src/slic3r/GUI/DeviceManager.cpp`                       | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/server/printer/commands/defs/ams.ts`                      | BambuStudio | `src/slic3r/GUI/DeviceCore/DevFilaSystemCtrl.cpp`        | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/server/printer/commands/defs/hms.ts`                      | BambuStudio | `src/slic3r/GUI/DeviceManager.cpp`                       | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/server/printer/commands/defs/camera.ts`                   | BambuStudio | `src/slic3r/GUI/DeviceManager.cpp`                       | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/server/printer/report.ts`                                 | BambuStudio | `src/slic3r/GUI/DeviceManager.cpp`                       | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/server/profiles/condition.ts`                             | BambuStudio | `src/libslic3r/PlaceholderParser.cpp`                    | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/server/profiles/condition.ts`                             | BambuStudio | `src/libslic3r/Preset.cpp`                               | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/server/profiles/io.ts`                                    | BambuStudio | `src/libslic3r/Config.cpp`                               | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/server/profiles/io.ts`                                    | BambuStudio | `src/slic3r/GUI/CreatePresetsDialog.cpp`                 | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/server/profiles/library.ts`                               | BambuStudio | `src/libslic3r/Preset.cpp`                               | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/server/profiles/store.ts`                                 | BambuStudio | `src/libslic3r/Preset.cpp`                               | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/server/profiles/vendor.ts`                                | BambuStudio | `src/libslic3r/PresetBundle.cpp`                         | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/server/slicer/cli.ts`                                     | BambuStudio | `src/libslic3r/PrintConfig.cpp`                          | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/server/slicer3mf/constants.ts`                            | BambuStudio | `src/libslic3r/Format/bbs_3mf.cpp`                       | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/server/slicer3mf/constants.ts`                            | PrusaSlicer | `src/libslic3r/Format/3mf.cpp`                           | `5dc04b4e8f14f65bbcc5377d62cad3e86c2aea36` |
| `app/src/lib/server/slicer3mf/read.ts`                                 | BambuStudio | `src/libslic3r/Format/bbs_3mf.cpp`                       | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/server/slicer3mf/write.ts`                                | BambuStudio | `src/libslic3r/Format/bbs_3mf.cpp`                       | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/shared/controls.ts`                                       | BambuStudio | `src/slic3r/GUI/StatusPanel.cpp`                         | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/shared/controls.ts`                                       | BambuStudio | `src/slic3r/GUI/DeviceManager.cpp`                       | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/shared/slicer/paint.ts`                                   | BambuStudio | `src/libslic3r/TriangleSelector.cpp`                     | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/shared/slicer/paint.ts`                                   | BambuStudio | `src/libslic3r/Model.cpp`                                | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/shared/slicer/project.ts`                                 | BambuStudio | `src/libslic3r/Format/bbs_3mf.cpp`                       | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `slicer/engine/src/facade/upstream/link_shims.cpp`                     | BambuStudio | `src/slic3r/Utils/Http.cpp`                              | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `slicer/engine/src/facade/upstream/link_shims.cpp`                     | BambuStudio | `src/slic3r/Utils/BBLUtil.cpp`                           | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `slicer/engine/src/features/calib/calib.hpp`                           | BambuStudio | `src/slic3r/GUI/Plater.cpp`                              | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `slicer/engine/src/features/calib/calib.hpp`                           | BambuStudio | `src/slic3r/GUI/calib_dlg.cpp`                           | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `slicer/engine/src/features/calib/calib.hpp`                           | OrcaSlicer  | `src/slic3r/GUI/Plater.cpp`                              | `8500fcdccaa10b5099ac20d252af3a7c560046f1` |
| `slicer/engine/src/facade/upstream/link_shims.cpp`                     | BambuStudio | `src/slic3r/Utils/ColorSpaceConvert.cpp`                 | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `slicer/engine/src/features/project/read.cpp`                          | BambuStudio | `src/libslic3r/Format/bbs_3mf.cpp`                       | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `slicer/engine/src/features/project/write.cpp`                         | BambuStudio | `src/libslic3r/Format/bbs_3mf.cpp`                       | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `slicer/engine/src/facade/upstream/project_io.cpp`                     | BambuStudio | `src/libslic3r/Format/bbs_3mf.cpp`                       | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/client/slicer/layers.ts`                                  | BambuStudio | `src/libslic3r/Slicing.cpp`                              | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/client/slicer/layers.ts`                                  | BambuStudio | `src/libslic3r/SlicingAdaptive.cpp`                      | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/client/slicer/layers.ts`                                  | BambuStudio | `src/libslic3r/PrintObject.cpp`                          | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/client/slicer/layer-view.ts`                              | BambuStudio | `src/libslic3r/PrintObject.cpp`                          | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/client/slicer/paint.ts`                                   | BambuStudio | `src/libslic3r/TriangleSelector.cpp`                     | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
| `app/src/lib/client/slicer/paint-geometry.ts`                          | BambuStudio | `src/libslic3r/TriangleSelector.cpp`                     | `926a7192574bcb9b3a732e1ec59a46d79cb45466` |
