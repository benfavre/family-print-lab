# Print Lab Cloud protocol (v1)

Family Print Lab can optionally link to a hosted service ("the cloud") so a grown-up can answer
kids' print requests from a phone. This document is the complete contract between the app and the
cloud: everything the app sends and everything the cloud may ask it to do. The app side lives in
`app/src/lib/server/cloud/`; `app/tools/cloud-sim.ts` is a small implementation of the cloud side
used by the tests.

## Principles

- **Off until linked.** Nothing is sent until someone links the app, and unlinking stops everything.
- **Outbound only.** The app opens one WebSocket to the cloud. It never listens for connections
  from the internet, so it still binds only to `127.0.0.1` (or the LAN it was configured for).
- **One command.** The cloud can ask the app to do exactly one thing: approve or decline a waiting
  print request. It cannot read the workspace, start, pause or stop prints, or change anything
  else. The app checks every command through the same code path as the Family page (including the
  request's version), and logs it.
- **Minimal data.** Only print requests are shared (see `RequestSummary`). Models, sketches, the
  printer, spools, ages and everything else stay on the computer.

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

## Messages

App → cloud:

| Message                                                                                                                 | When                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{"type": "hello", "app": "2.0.0", "protocol": 1}`                                                                      | First message after connecting                                                                                                                                          |
| `{"type": "requests", "requests": RequestSummary[]}`                                                                    | After `welcome`, and whenever requests change. Always the full current list (waiting requests, plus those answered in the last 7 days); the cloud replaces what it had. |
| `{"type": "result", "commandId": "…", "ok": true}` or `{"type": "result", "commandId": "…", "ok": false, "error": "…"}` | Answer to a `decide` command                                                                                                                                            |

Cloud → app:

| Message                                                                                                                                 | Meaning                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `{"type": "welcome", "account": "a@b.c", "plan": true}`                                                                                 | Connected; `plan` says whether the Family plan is active (approvals from the phone need it)                |
| `{"type": "decide", "commandId": "…", "requestId": "…", "version": 1, "decision": "approve" \| "decline", "reply": "…", "by": "a@b.c"}` | A grown-up answered on the phone. The app applies it only if the request is still waiting at that version. |
| `{"type": "unlinked"}`                                                                                                                  | The device was removed on the cloud side; the app forgets its token.                                       |

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

`kid` is the child's profile name, or `"Your child"` when "Share kids' names" is off. `thumbnail`
(a small WebP, at most about 40 kB) is included only while a request is waiting.

## Versioning

`protocol` is bumped for incompatible changes. A cloud that does not support the app's protocol
closes the socket with code `4400` and a reason the app shows to the user.
