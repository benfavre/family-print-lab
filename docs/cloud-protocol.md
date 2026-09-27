# Print Lab Cloud protocol (v2)

Family Print Lab can optionally link to a hosted service ("the cloud") so a grown-up can answer
kids' print requests from a phone and, only when a parent switches it on, follow the printers, see
encrypted camera pictures and pause, resume or stop prints. This document is the complete contract between the app and the
cloud: everything the app sends and everything the cloud may ask it to do. The app side lives in
`app/src/lib/server/cloud/`; `app/tools/cloud-sim.ts` is a small implementation of the cloud side
used by the tests.

## Principles

- **Off until linked.** Nothing is sent until someone links the app, and unlinking stops everything.
- **Outbound only.** The app opens one WebSocket to the cloud. It never listens for connections
  from the internet, so it still binds only to `127.0.0.1` (or the LAN it was configured for).
- **Few commands.** The cloud can ask the app to approve or decline a waiting print request. With
  protocol v2, and only when a parent allowed it, it can relay pause, resume and stop (and, with the
  queue, "start the next queued print") **signed by a phone** with the household phone key, and ask
  for a camera picture **sealed for the phone**. (It can also offer template packs, which are data
  the app checks and renders in its sandbox, never instructions.) It cannot read the workspace, send
  G-code, change temperatures or anything else. The app checks every command through the same code
  path as its own pages, and logs it.
- **Minimal data.** Only print requests are shared (see `RequestSummary`), plus, only when a parent
  turns each one on: the printers' status, their alerts, the print queue. Models, sketches,
  temperatures, spools, ages and everything else stay on the computer.
- **The cloud cannot forge or read what matters.** With a phone key, printer status, the queue and
  camera pictures travel sealed so the cloud relays bytes it cannot read, and commands carry a MAC
  it cannot compute. A compromised cloud can drop or delay messages, not invent them.

## Linking (device authorization)

Modelled on the OAuth 2.0 Device Authorization Grant (RFC 8628).

1. The app calls `POST {cloud}/device/pair` with `{"name": "Family Print Lab", "app": "2.0.0"}`.
   The cloud answers
   `{"pairingId": "<secret>", "userCode": "WDJB-MJHT", "verifyUrl": "{cloud}/link", "expiresIn": 600, "interval": 3}`.
2. The app shows the user code and the address. A grown-up signs in there and enters the code.
   The cloud shows what will be shared and asks them to confirm.
3. Meanwhile the app polls `POST {cloud}/device/pair/poll` with `{"pairingId": "…"}` every
   `interval` seconds. The answer is `{"status": "pending"}`, `{"status": "expired"}` or, once
   confirmed, `{"status": "linked", "deviceToken": "<secret>", "deviceId": "…", "account": "a@b.c"}`.
   The token is issued once; the cloud keeps only its hash.

User codes use 8 characters from `BCDFGHJKLMNPQRSTVWXZ23456789` and expire after 10 minutes.

## Connecting

1. `POST {cloud}/device/session` with `Authorization: Bearer <deviceToken>` returns
   `{"ticket": "<secret>"}`: single use, valid for 60 seconds. `401` means the device was unlinked;
   the app then forgets its token.
2. The app opens `wss://{cloud}/device/connect?ticket=<ticket>` (`ws://` only for local testing).
3. Messages are JSON text frames. The app sends `"ping"` (a bare string) every 30 seconds and the
   cloud answers `"pong"`. On disconnect the app reconnects with backoff (1 s doubling to 60 s).

Unlinking from the app: `POST {cloud}/device/unlink` with the bearer token removes the device on
the cloud side. The app forgets its token whatever the answer (it may be offline).

## Encrypted backups (Family plan)

Only when a parent turns on Cloud backup (Integrations → Backups). The app makes a recovery key
(32 characters from `ABCDEFGHJKMNPQRSTVWXYZ23456789`, shown once to write down, kept on the
computer) and derives an AES-256 key from it with HKDF-SHA256. About once a day it packs the newest
snapshot (the database and model files), compresses it, and seals it with AES-256-GCM:
`"PLB1" | key id (8 bytes) | IV (12 bytes) | ciphertext | tag (16 bytes)`. The key id (the first 8
bytes of SHA-256 of the AES key) only tells whether a key fits; the cloud never gets the key.

- `PUT {cloud}/device/backups` with the bearer token, `x-backup-key: <key id hex>` and the sealed
  file as the body (at most 95 MB). `402` without the Family plan. The cloud keeps the last 7 per
  computer and deletes any backup after 90 days.
- `GET {cloud}/device/backups` lists the account's backups (from all its computers):
  `{"backups": [{"id", "device", "createdAt", "size", "keyId"}]}`.
- `GET {cloud}/device/backups/{id}` returns a sealed file, which the app opens with the recovery
  key and restores like any local backup (after taking a safety snapshot).

## Template packs (Family plan)

`GET {cloud}/device/packs` with the bearer token returns `{"plan": true, "packs": Pack[]}` (an empty
list without the plan). The app fetches it after each `welcome` and `plan` message. A pack is data:
kid mode template descriptions (the same shape as the built-in ones in `app/src/lib/shared/kid.ts`)
each with a self-contained OpenSCAD `source`. The app validates them strictly (sizes at most 240 mm,
known control kinds, no replacing a built-in template), renders them in its OpenSCAD sandbox with a
time limit, and applies the kid mode rules to every value. Without the plan, installed packs are
removed; things already made from them are kept.

## Shop (credits)

The shop sells kid mode packs, customizable parts (OpenSCAD with Customizer annotations) and
ready-made models (3MF), for the account's credits. All with the bearer token:

- `GET {cloud}/device/shop`: `{"items": [{id, kind, title, blurb, description, price, plan, facts, version, owned}], "balance", "plan", "site"}`.
- `POST {cloud}/device/shop/{id}/buy`: `{"balance"}`, `402` when the credits do not cover it, `409`
  when it is already owned. A grown-up confirms first; kid mode cannot reach the app's shop.
- `GET {cloud}/device/library`: what the account owns, with what to install: `pack` (a kid mode
  pack, also delivered by `/device/packs`), `name` and `source` (a part), or `file` and `format` (a
  model, downloaded from `GET {cloud}/device/library/{id}/file`).
- Pictures are public: `GET {cloud}/shop/{id}.webp` (the app serves them to its page itself).

After any purchase (in the app or on the website) the cloud sends `{"type": "library"}` so linked
apps refresh.

## The household phone key (v2)

A random 32-byte key the app makes the first time a parent chooses **Show phone key** (Family page →
Answer from your phone, parent PIN required). It is kept in the app's database (so encrypted backups
carry it) and on the family's phones, never in the cloud. The key id is the first 8 bytes of
SHA-256 of the key (hex).

- The app shows a QR code of `{cloud}/phone-key#k=<key, base64url>`. The key is in the URL fragment,
  which browsers never send to a server; the cloud's `/phone-key` page stores it in the phone's
  IndexedDB and removes it from the address bar. Phones without a camera app can paste the link.
- **Forget all phones** makes a new key: phones with the old one can no longer open anything or send
  commands until they scan the new one.
- Two subkeys, HKDF-SHA256 with salt `family-print-lab`: `info "phone seal v1"` (AES-256-GCM, 32
  bytes) and `info "phone mac v1"` (HMAC-SHA256, 32 bytes).
- **Sealed** data: `"PLS1" | key id (8 bytes) | IV (12 bytes) | ciphertext | tag (16 bytes)`, base64 in
  JSON, with the additional data given for each message below.

## Messages

App → cloud:

| Message                                                                                                                 | When                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `{"type": "hello", "app": "2.0.0", "protocol": 2}`                                                                      | First message after connecting. A cloud that closes with `4400` before `welcome` gets a second connection saying `"protocol": 1` (v1 behaviour: one printer, no remote control).                                                                                   |
| `{"type": "requests", "requests": RequestSummary[]}`                                                                    | After `welcome`, and whenever requests change. Always the full current list (waiting requests, plus those answered in the last 7 days); the cloud replaces what it had.                                                                                            |
| `{"type": "printer", "printer": PrinterSummary \| null}`                                                                | After `welcome`, then (only with "Share print progress" on) at once when the printer's state changes and at most every 30 seconds while printing. `null` while sharing is off: it carries nothing about the printer, and the cloud forgets what it had.            |
| `{"type": "result", "commandId": "…", "ok": true}` or `{"type": "result", "commandId": "…", "ok": false, "error": "…"}` | Answer to a `decide` or `control` command                                                                                                                                                                                                                          |
| `{"type": "printers", "printers": PrinterSummaryV2[] \| SealedPrinter[] \| null, "control": bool, "snapshots": bool}`   | v2, replaces `printer`. After `welcome`, then at once when a printer's state, event or alerts change, at most every 30 seconds for progress. `null` while "Share printer status" is off (the cloud forgets them). `control`/`snapshots`: what the phone may offer. |
| `{"type": "queue", "items": QueueSummary[] \| null, "sealed"?: "…", "event": PushEvent \| null}`                        | v2. After `welcome` and when the queue changes. `items` is `null` while "Share queue" is off; with a phone key the list is sealed instead (`sealed`, additional data `queue\|<deviceId>`, no `items`).                                                             |
| `{"type": "snapshot", "requestId", "printerId", "capturedAt", "sealed"}` or `{…, "error": "…"}`                         | v2. Answer to `snapshot.request`.                                                                                                                                                                                                                                  |

Cloud → app:

| Message                                                                                                                                   | Meaning                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `{"type": "welcome", "account": "a@b.c", "plan": true}`                                                                                   | Connected; `plan` says whether the Family plan is active (approvals from the phone need it)                |
| `{"type": "decide", "commandId": "…", "requestId": "…", "version": 1, "decision": "approve" \| "decline", "reply": "…", "by": "a@b.c"}`   | A grown-up answered on the phone. The app applies it only if the request is still waiting at that version. |
| `{"type": "plan", "plan": true}`                                                                                                          | The Family plan started or ended (sent right away, not only on connect)                                    |
| `{"type": "control", "commandId", "printerId", "action": "pause" \| "resume" \| "stop" \| "dispatch", "by", "at", "mac", "queueItemId"?}` | v2. A phone's signed command, relayed untouched (see Remote control).                                      |
| `{"type": "snapshot.request", "requestId", "printerId"}`                                                                                  | v2. A phone asks for a camera picture (see Camera pictures).                                               |
| `{"type": "library"}`                                                                                                                     | Something was bought: fetch packs and the library again                                                    |
| `{"type": "unlinked"}`                                                                                                                    | The device was removed on the cloud side; the app forgets its token.                                       |

`RequestSummary`:

```json
{
  "id": "…",
  "version": 1,
  "status": "Waiting",
  "kid": "Léa",
  "title": "Name sign: LÉA",
  "message": "Please! 🙏",
  "reply": "",
  "size": [66, 47, 5],
  "grams": 13,
  "colour": { "name": "Sunset orange", "hex": "#ff7a2f" },
  "createdAt": "2026-09-25T18:00:00.000Z",
  "decidedAt": null,
  "thumbnail": "data:image/webp;base64,…"
}
```

`PrinterSummary` (nothing else about the printer is sent). With several printers, protocol v1 carries
only the first one in Settings → Printers; the others are never mentioned:

```json
{
  "state": "printing",
  "title": "Name sign",
  "percent": 42,
  "remainingMinutes": 35,
  "layer": 40,
  "totalLayers": 90
}
```

`state` is one of `idle`, `preparing`, `printing`, `paused`, `finished`, `failed` or `offline`.
`percent`, `remainingMinutes` and the layers are `null` unless a print is under way. When a print
goes from under way to `finished` or `failed`, the cloud may notify the parent's phone.

`kid` is the child's profile name, or `"Your child"` when "Share kids' names" is off. `thumbnail`
(a small WebP, at most about 40 kB) is included only while a request is waiting.

## Printers (v2)

`PrinterSummaryV2`, one per enabled printer, in Settings order, only with "Share printer status" on:

```json
{
  "id": "3f0c…",
  "name": "Bambu Lab P1S",
  "model": "P1S",
  "state": "printing",
  "title": "Name sign",
  "percent": 42,
  "remainingMinutes": 35,
  "layer": 40,
  "totalLayers": 90,
  "hms": [{ "key": "…", "severity": "serious", "text": "…" }],
  "camera": true,
  "event": { "kind": "finished", "at": 1790000000000 }
}
```

`hms` is present only with "Share alerts" on. `camera` says whether a picture can be asked for
(camera present, pictures on, phone key made). `event` is the printer's latest push-worthy event:
`kind` is `finished`, `failed`, `cancelled`, `paused` or `alert` (an alert the error database calls
serious or fatal), `at` in milliseconds; the cloud sends a content-free push once per new `at`.

With a phone key (**status minimisation**) each entry is `SealedPrinter`
`{"id", "state", "event", "sealed"}`: the whole `PrinterSummaryV2` sealed with additional data
`printers|<deviceId>`, and only what the cloud needs for pushes in clear. The phone checks that the
sealed `id` matches.

`QueueSummary`: `{"id", "title", "printerId" | null, "status", "minutes" | null, "waitingFor" | null}`
(`waitingFor` is why it has not started, `null` for the one that goes next). The queue's `event`
kinds are `queue-started` and `queue-held`.

## Remote control (v2)

The phone builds the command in the browser: `commandId` (random, 8–80 of `A-Za-z0-9_-`), `at`
(milliseconds since 1970) and `mac` = lower-case hex HMAC-SHA256 with the phone mac key over
`commandId|printerId|action|at` (for `dispatch`, `|queueItemId` is appended). The cloud passes them
through untouched and never sees the phone key. The app applies a command only when **all** hold:

1. "Allow pause, resume and stop from the phone" is on (turning it on needs the parent PIN) and
   printer status is shared;
2. the cloud said the Family plan is active;
3. the MAC verifies;
4. `at` is within 2 minutes of the computer's clock;
5. `commandId` was not seen before (replay cache).

Then it sends `print.pause`, `print.resume` or `print.stop` through the printer's own command layer
(which still checks the printer's state and Developer Mode) and logs "Paused Bambu Lab P1S from the
phone, a@b.c". Refusals of forged, stale or replayed commands are logged too. `dispatch` (optional,
needs "Share queue" and the queue package) starts the next queued print on that printer only if
`queueItemId` is the item that would go next and the plate was confirmed clear on the computer.
Nothing else can be sent: no G-code, temperatures or other commands.

## Camera pictures (v2)

With "Camera pictures and live view" on and a phone key made, a `snapshot.request` is answered with a
JPEG at most 1280 px wide and 512 KB (about 700 KB in base64; Cloudflare accepts up to 32 MiB per
received WebSocket message, https://developers.cloudflare.com/durable-objects/platform/limits/ ). The
picture is sealed with the phone seal key; the plaintext is `u16 header length | JSON header
{"capturedAt", "printerId", "type": "image/jpeg"} | JPEG`, and the additional data is
`requestId|printerId|capturedAt`, so the cloud cannot pass off one printer's picture as another's,
answer a request with an old picture, or read it. `capturedAt` also travels in clear so the phone
can build the additional data; it shows how old the picture is. The cloud relays the message and
never stores it. Live view is the phone repeating requests (at most 2 a second, 2 minutes per
session, rate-limited per account by the cloud); the app also refuses more than 150 pictures a minute.

## Versioning

`protocol` is bumped for incompatible changes. A cloud that does not support the app's protocol
closes the socket with code `4400` and a reason the app shows to the user. The cloud accepts 1 and
2 and keeps v1 behaviour for apps that say 1 (`printer`, one printer); an app that speaks 2 falls
back to 1 when an older cloud refuses it.
