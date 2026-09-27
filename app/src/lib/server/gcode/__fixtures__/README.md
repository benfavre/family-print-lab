# G-code preview fixtures

Real Bambu Studio G-code, packed into a `.gcode.3mf` container (`Metadata/plate_1.gcode`, its MD5 and a
`slice_info.config` written from the G-code's own header: printer model, time, weights, filaments). The
G-code itself is unchanged.

| File                              | G-code source                                                                                                                                                                                                                                                              | What it covers                                                                                                                                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `a1-two-colour-cube.gcode.3mf`    | `Slic3rPostProcessingUploaderUnitTests/TestData/BambuStudio/bambustudio-01.10.01.50-calibration-cube-two-filament.gcode` from [HoffmanEngineering/Slic3rPostProcessingUploader](https://github.com/HoffmanEngineering/Slic3rPostProcessingUploader) at `6b5ee83` | Bambu Studio 01.10.01.50, Bambu Lab A1, two PLA filaments (T0/T1 changes, flushes, prime tower), G2 arcs in relative mode, wipes, M73. The upstream test file keeps 9 of the 128 layers, so it previews 9 layers. |
| `x1c-petg-light-guide.gcode.3mf` | `hardware/enclosure/output/v215/bambu-studio/all-plates/plate_3.gcode` from [sayhiben/little-on-air](https://github.com/sayhiben/little-on-air) at `010b809` | Bambu Studio 02.08.02.61 (the pinned tag), Bambu Lab X1 Carbon, 29 layers at 0.1 mm printed with the third filament (an indented `T2`), complete file. |
| `a1-mini-cube.gcode.3mf` | `test_cube_v2.gcode` from [little-did-I-know/Gcode](https://github.com/little-did-I-know/Gcode) at `9ea0c5e` | Bambu Studio 02.05.00.66, Bambu Lab A1 mini, 50 layers, arcs, floating vertical shells, complete file. |

All three are MIT licensed:

- Copyright (c) 2024-2026 Hoffman Engineering
- Copyright (c) 2026 Ben Menesini
- Copyright (c) 2026 little-did-I-know

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
> associated documentation files (the "Software"), to deal in the Software without restriction,
> including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense,
> and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so,
> subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial
> portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
> LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
> NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
> WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
> SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
