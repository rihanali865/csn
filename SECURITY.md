# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | yes (pre-release, fast fixes) |

## Reporting a vulnerability

Use GitHub's **private vulnerability reporting** (Security tab → Report a vulnerability) or email the address listed in the repo owner profile. Do **not** open a public issue for anything with security impact.

Please include: affected package (`@csn/*`, `services/api`, …), a minimal reproduction, and if possible a suggested fix. Coordinated disclosure: we aim to acknowledge within 72 hours, publish fixes in the next patch release, and credit reporters who wish to be named.

**Never paste secrets into a vulnerability report** (or anywhere in this project's tooling — the intake validator will actually refuse capability content shaped like a credential; apply the same hygiene to your issue).

## What is in scope

- Any CSN path that could read/leak secrets outside the documented scopes (`docs/permissions.md`, `docs/threat-model.md`).
- Bypassing the consent gates (`sharing.mode`, `schedule.enabled`, `exec.allow`, `allowProjectScans`) — including any code that enables these implicitly.
- The API's auth/intake: token handling, secret-shape refusal, idempotency/replay behavior, rate limits.
- The detached-validation sandbox (sanitized env, allowlist, timeout).
- Anything that would *hide* data collection from the user running CSN — this class of issue is the project's hard boundary (see `docs/threat-model.md`) and is treated as a critical severity violation of the product spec itself.

## Out of scope

- Vulnerabilities in *audited* third-party tools (OpenCode/Claude Code/Codex/Cursor) as products — report those upstream; CSN only reads their config files.
- Findings that require an attacker with local interactive access to the same user session (CSN provides no defense against a compromised user account running unrelated malware).
- SSRF from hand-entered `--endpoint` URLs by the consenting operator (documented behavior; validated server-side).
