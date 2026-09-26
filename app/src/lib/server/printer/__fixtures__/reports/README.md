# Printer report fixtures

Each `<name>.json` is one printer's report as the app receives it:
`{ source, licence, model, synthetic?, edits, pushall, get_version, deltas? }`, where `pushall` is
the `print` object of a full report, `get_version` the `info` object of the version answer and
`deltas` (optional) later `print` messages applied in order. `<name>.expected.json` is the
`PrinterSnapshot` that `parseReport(mergeReport({}, pushall))` must give (plus `afterDeltas` when
there are deltas). The expected files were produced by the parser and then reviewed field by field
against the raw reports; regenerate them only after a deliberate parser change
(`UPDATE_FIXTURES=1 bunx vitest --run src/lib/server/printer/conformance.test.ts`) and review the
diff.

Common edits: only the `print` / `info` objects are kept; serial numbers other than the mocks' own
`MOCK-…` names are replaced with `**REDACTED**`; IP addresses become `192.0.2.10` (TEST-NET-1) and
`net.info[].ip` becomes `0`.

| Fixture                | Model   | Source                                                                                                                   | Licence                          | Notes                                                                                                                   |
| ---------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `x1c-multi-ams`        | BL-P001 | ha-bambulab `pybambu/mock_data/MOCK-X1CMULTIAMS.json` at `0e027ff`                                                       | MIT (ha-bambulab)                | Its `rtsp_url` is redacted in the mock, so it parses as plain RTSP                                                      |
| `p1p-no-ams`           | C11     | ha-bambulab `MOCK-P1PNOAMS.json`                                                                                         | MIT (ha-bambulab)                | External spool active (`tray_now` 254)                                                                                  |
| `p1s`                  | C12     | Derived from `MOCK-P1PNOAMS.json`                                                                                        | MIT (ha-bambulab), edited        | Synthetic: one AMS added in ha-bambulab's documented shape, printing on tray 1; no real P1S dump was available          |
| `a1`                   | N2S     | ha-bambulab `MOCK-A1.json`                                                                                               | MIT (ha-bambulab)                | `stg_cur` 0 while idle (corrected to 255)                                                                               |
| `a1-mini`              | N1      | Derived from `MOCK-A1.json`                                                                                              | MIT (ha-bambulab), edited        | Synthetic: get_version `project_name` N1; report unchanged (AMS Lite `ams_f1/0`)                                        |
| `h2d`                  | O1D     | ha-bambulab `MOCK-H2D.json`                                                                                              | MIT (ha-bambulab)                | Developer Mode off (`fun` bit 29 set)                                                                                   |
| `h2d-ext-spool`        | O1D     | ha-bambulab `MOCK-H2DEXTSPOOLACTIVE.json`                                                                                | MIT (ha-bambulab)                | AMS HT units 128/129, external spool active                                                                             |
| `x2d`                  | N6      | ha-bambulab `MOCK-X2D.json`                                                                                              | MIT (ha-bambulab)                | 64-bit `fun`; bit 29 is set, so Developer Mode reads as off (a cloud-connected printer)                                 |
| `p2s`                  | N7      | ha-bambulab `MOCK-P2S.json`                                                                                              | MIT (ha-bambulab)                |                                                                                                                         |
| `h2s`                  | O1S     | ha-bambulab `MOCK-H2S.json`                                                                                              | MIT (ha-bambulab)                |                                                                                                                         |
| `h2c`                  | O1C2    | ha-bambulab `MOCK-H2C.json`                                                                                              | MIT (ha-bambulab)                | Nozzle rack bit (fun bit 60) set                                                                                        |
| `h2d-pro`              | O1E     | ha-bambulab `MOCK-H2DPRO.json`                                                                                           | MIT (ha-bambulab)                | Developer Mode on                                                                                                       |
| `a2l`                  | N9      | ha-bambulab `MOCK-A2L.json`                                                                                              | MIT (ha-bambulab)                | AMS Lite as unit 16 (`info` 30001005), trays 24–27                                                                      |
| `openbambuapi-pushall` | BL-P001 | Written for this project from our reading of OpenBambuAPI `mqtt.md` ("pushing.pushall", "print.push_status") at `cc383a2` | AGPL-3.0-or-later (this project) | Synthetic. OpenBambuAPI is GFDL-1.3, so nothing is copied from it                                                       |
| `p1-delta-sequence`    | C12     | Written for this project, shaped per OpenBambuAPI `mqtt.md` "print.push_status" (P1 series send only changed values)      | AGPL-3.0-or-later (this project) | Synthetic: tray change, humidity change, PREPARE → RUNNING → FINISH, HMS raised then cleared, a command reply in between |

People with real printers can contribute more: Settings → Printers → "Download diagnostics" saves a
redacted report in the same shape.
