# Bambu printer CA certificates

Public certificate authorities that sign the certificates Bambu Lab printers present on the local
network (MQTT 8883, FTPS 990, RTSPS 322, port 6000). `printer/tls.ts` trusts only these when it
checks a printer, together with the rule that the certificate must name the printer's serial number.

Copied unchanged from ha-bambulab `custom_components/bambu_lab/pybambu/certs/*.cert`
(https://github.com/greghesp/ha-bambulab at commit `0e027ff`, MIT licence), renamed to `.pem`:

| File                   | Contents                                                         |
| ---------------------- | ---------------------------------------------------------------- |
| `bambu.pem`            | BBL CA, BBL CA2 RSA and BBL CA2 ECC roots and cross-certificates |
| `bambu_p2s_250626.pem` | BBL Device CA N7-V2 (P2S)                                        |
| `bambu_h2c_251122.pem` | BBL Device CA O1C2-V2 (H2C)                                      |
| `bambu_x2c_260425.pem` | BBL Device CA N6-V2 (X2D)                                        |

Printers whose device CA is missing here are trusted on first use instead (the fingerprint of the
certificate is pinned when you test or add the printer in Settings).
