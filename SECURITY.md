# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Report a vulnerability** button on the repository's Security tab. Don't open a public issue. You should get a reply within a week.

## Scope and threat model

Family Print Lab is designed to run on a trusted machine for one household:

- It listens on `127.0.0.1` by default and **has no authentication**. Profiles are not access control. Anyone who can reach the port can read and change everything and control the printer.
- Exposing it on a LAN (`HOST` plus `ALLOWED_HOSTS`) means trusting everyone on that network. Exposing it to the internet is not supported.
- It defends against browser-based attacks from other sites: DNS rebinding (Host checks), cross-site writes, and script injection (strict CSP with nonces).
- AI subscriptions run the official CLIs with tools, file access and MCP servers disabled, in a scratch directory.

Reports that are especially welcome: a web page that can read or change data in a locally running instance, escapes from the AI CLI sandbox, path traversal in model or backup files, and crafted model/3MF files that crash the server or run code.
