# CSN Threat Model

Scope: the software in this repository, running as documented (CLI on a developer machine, optional network API, optional private Master Agent).

## The hard boundary

> **CSN may not build a capability that reports on activity inside the user's systems — their IDEs, terminals, prompts, sessions, keystrokes, or project workspaces — behind the user's back.** The founding rule of this repository, fixed at inception: *implementing a hidden behavior reporter is out of scope forever; consent-gated flows only.* A feature request (or code review finding) that effectively hides CSN's data collection from the user whose machine it runs on is rejected in review, regardless of technical merit.

Consequences already realized in code:

- No scheduler is installed anywhere. `schedule.enabled` defaults to `false`; the tasks command is fetch-on-demand.
- Nothing scans project folders unless `scan.allowProjectScans === true` AND the root is explicitly listed (`withinAllowedScanScope`, `projectScanAllowed`).
- The dashboard probes only when a button is pressed in a page you opened yourself, on 127.0.0.1, with `script-src 'none'`.
- The CLI prints its policy on every audit ("Policy in effect during this run").

## Assets

| # | Asset | Impact if compromised |
| --- | --- | --- |
| A1 | Operator secrets (API keys, tokens, browser profiles, `.env` files) | credential theft, account takeover |
| A2 | Machine layout / user identity (absolute paths, emails, usernames) | de-anonymization, targeted attacks |
| A3 | Community-submitted capability payloads | poisoned candidates → arbitrary code later |
| A4 | API server installation tokens | impersonation, report flooding |
| A5 | Master-Agent store (candidate proofs, validation logs) | evidence forgery in either direction |
| A6 | User attention (consent decisions) | consent fatigue → real consent becomes rubber-stamping |

## Attack surfaces & mitigations

### 1. Local audit process (A1, A2)

Reads: OpenCode `~/.config/opencode`, Claude Code `~/.claude` (settings.json, skills/, agents/, plugins/ — never `~/.claude.json`), Codex `~/.codex/config.toml` + project `.codex/`, Cursor `~/.cursor/mcp.json`.

- **Secret files are name-screened, not content-screened:** `SECRET_FILENAME_PATTERNS` denies `.env*`, `credentials.json`, `id_rsa`, `.pem`, `.key`, `mcp-auth.json`, `auth.json` etc. CSN never opens them, so it cannot leak from them.
- **Command values are never executed.** `hasExecutable()` answers "is this on PATH" via `where`/`which` — a boolean filesystem lookup, nothing else.
- **Environment variables of configured MCPs are described, never read** ("declares environment variables (values never read by CSN)").
- **Path minimization at record time:** `~/…` everywhere; emails are redacted by `redactText`; long descriptions truncated.

Residual risk: a malicious skill/agent description could still be prose designed to social-engineer a human auditing the report. Mitigation: descriptions are length-capped, secret-scanned, and rendered as data (not suggestions) in all UIs.

### 2. Outbound reports (A2, A6)

`buildSubmissionPayload` is the only serialization to the network: path-free, redaction-filtered, `ReportSubmissionSchema`-parsed, security-capped (≤500 capabilities, ≤10 project summaries, each field length-bounded). The CLI double-gates: policy `sharing.mode`, endpoint equality with the configured endpoint (mismatch ⇒ explicit flag needed), token from env var only (`CSN_NETWORK_TOKEN`) — never a flag/argument that could leak into history.

### 3. Network API (A3, A4)

- Tokens are 192-bit random, stored hashed; bearer lookup is by hash (no timing side-channel on value comparison), scopes enforced per endpoint, revocation first-class and idempotent.
- Intake: schema first (400 with per-field details), then **secret-shape refusal** (422) so a poisoned report cannot even be stored, then idempotency (content hash → replay detection), then rate limiting (429 + `retry-after`).
- Power asymmetry: reports are *one-way enrichments*; the only write path back to installations is the scheduled-task queue, which is delivery of a proposal, not of instructions, and requires a scheduled policy the user opted into.

### 4. Master agent (A3, A5, A6)

- Candidates are never trusted: `untrusted: true` survives intake; secret-shaped names/description/notes are refused before storage.
- The status machine prevents "verified by optimism": `testing-passed` is reachable **only** from a recorded validation run; `integration-proposed` only from `testing-passed`; acceptance is a separate human command (`accept --confirm`).
- Detached validation: `exec.allow` + explicit allowlist + sanitized child env + throwaway cwd + timeout + output cap + output secret-scan. Refusals are loud (exit code 3, printed reason, policy summary).
- Rollback is legal after integration (`integrated-verified → rolled-back`) and recorded in `acceptedIntegrations` notes.

### 5. Dashboard (A6)

No JS, no fetch, CSP `script-src 'none'`, localhost bind, forms are POSTs that re-render server-side. The GET `/api/audit` endpoint reveals nothing unless an audit was run in that server's lifetime.

## Trust boundaries for readers

1. **What's on your disk stays yours** — unless a report leaves, and you'll find that in exactly one place (policy + submission preview).
2. **What's in the network stays suspect** — community claims ride with `untrusted: true` and a `declared` ceiling until locally proven.
3. **What the master agent "knows" is reproducible** — every candidate state change is a history row with actor + reason; the store is plain JSON you can diff.

## Known gaps (v1, embrace-and-document)

- Single-node API store: no replication, no audit log for *server-side* admin actions (token issuance is logged only in-band).
- `describePolicy` cannot detect a user hand-editing policy *while* a long audit runs (TOCTOU on consent): audits snapshot the policy at start and print it.
- Rate limiting is in-process; a load-balanced deployment needs a shared limiter — documented, not hidden.
