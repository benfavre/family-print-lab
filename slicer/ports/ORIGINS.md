# Ported files

Every file in this repository adapted from Bambu Studio or OrcaSlicer (calibration generators, the
paint codec, 3MF constants and so on) has a row here and an `origin: <repo> <path> @ <commit>` line in
its header comment. `slicer/scripts/upstream.sh ports` compares each Bambu Studio row with the current
pin and lists the ones whose upstream file changed, so ported code is reviewed on every update.
OrcaSlicer rows are compared by hand until `slicer/orca.lock` exists.

Data generated from the pinned tree (the printer model catalogue, HMS texts, vendor profiles) is not
listed here: it is read through `app/tools/lib/upstream.ts` and regenerated on every update.

| Our file | Repository | Upstream path | Commit |
| --- | --- | --- | --- |
