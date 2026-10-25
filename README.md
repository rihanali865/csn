# Capability Swarm Network (CSN)

**CSN audits the AI coding environments already installed on *your* machine, produces an explainable capability inventory, compares it against what the network says exists, and lets you choose — explicitly, every time — what (if anything) to share.**

Design north star: *a report with receipts, or silence.* Every claim in a CSN output is traceable to a file on your disk, a checksummed config, or a deliberately recorded limitation. When CSN cannot verify something, it says so in the output itself.

```
┌──────────────────────────────────────────────────────────────────────┐
│  your machine                                                        │
│                                                                      │
│   ┌──────────┐   read-only fs    ┌─────────────┐   sanitized      │
│   │ adapters │ ────────────────▶ │ local audit │ ──▶ capability  │
│   └──────────┘  (opencode,      └─────────────┘    records        │
│                  claude-code,            │                         │
│                  codex, cursor)          ▼                         │
│                               ┌──────────────────┐                 │
│                     consent ─▶│ reports & policy │                 │
│                  (opt-in!)    │ · minimization   │                 │
│                               │ · secret denial  │                 │
│                               └───────┬──────────┘                 │
│                                       │ only if sharing.mode≠off   │
└───────────────────────────────────────│──────────────────────────────┘
                                        ▼
                          ┌───────────────────────────┐
                          │ network api (server-side) │
                          │ · hashed scoped tokens    │
                          │ · idempotent intake       │
                          │ · rate limits             │
                          │ · scheduled task delivery │
                          └───────────────────────────┘
```

## What it is not

- **Not a hidden monitor.** CSN never runs in the background, never schedules anything by default, and never reads a project it wasn't explicitly granted. Builds started something without your knowledge? That is *out of scope by design* — see [the consent boundary](docs/threat-model.md#the-hard-boundary).
- **Not a capability marketplace of promises.** A community report's "verified" is a *self-claim* until it is reproduced locally under an explicitly consented, allowlisted, resource-capped execution policy.
- **Not a telemetry service.** The default network URL list is empty. Sharing is `disabled` unless you edit `~/.config/csn/policy.json` by hand.

## Quick start

```bash
npm install
npm run typecheck
npm test

# audit your installed AI coding environments (read-only)
npm run audit

# where are the gaps vs a maintained backlog profile?
npm run audit -- gaps        # or: tsx apps/cli/src/index.ts gaps

# what are you consenting to right now?
npm run audit -- policy

# local dashboard (dark UI, runs only while open, scans only on click)
npm run dashboard
```

> Windows note: npm enforces an "allow-scripts" state on this workspace (`allowScripts` in the root package.json). `esbuild` is the only scripted dependency and it is already approved.

## The verification legend (why "configured" ≠ "works")

Every capability record carries one of four statuses:

| Status | Meaning | Can be produced by |
| --- | --- | --- |
| `declared` | someone (or a doc page) says it exists | anything, including the network |
| `configured` | a config file parses and names it, key parts exist on disk | local adapters only |
| `tested` | an *explicitly consented, allowlisted, resource-capped local check* ran and passed | a separately-gated validation stage only |
| `failed` | that same kind of check ran and did not pass | a separately-gated validation stage only |

Adapters can never emit `tested`/`failed` — the confidence math is derived deterministically from evidence and the transition machine refuses skips. This is why "detection ≠ execution" appears everywhere in the codebase.

## Repository layout

| Path | What lives there |
| --- | --- |
| `packages/core` | types, schemas (zod), deterministic ids, gap comparison, candidate status machine, explainable scoring |
| `packages/privacy` | redaction patterns, path minimization, secret-filename deny-list, strict project summarizer |
| `packages/adapters` | per-environment probes: opencode, claude-code, codex, cursor (read-only, PATH-check-only) |
| `packages/discovery` | audit engine, category refinement, gap reports, task-recovery diagnostics |
| `packages/compatibility` | MCP-entry validation, registry conflicts, dependency checks, setup plans |
| `packages/policy` | the consent file (`policy.json`), all gating functions |
| `packages/reports` | sanitized submissions, markdown rendering |
| `services/api` | network API: hashed scoped tokens, idempotent intake, rate limits, task delivery |
| `apps/cli` | the `csn` command: audit / gaps / policy / submit / tasks |
| `apps/dashboard` | local-only HTML dashboard (no JS, CSP `script-src 'none'`) |
| `docs/` | architecture, threat model, privacy model, permissions, roadmap |

## Honest limitations

- The **cursor adapter is `docs-unverified`**: Cursor's MCP documentation page could not be reached during development; detection there is layout-based with explicit disclosure in every audit.
- The API is a **single-node deployment** store (JSON file with atomic swap). Rate limiting is in-process. A federated/DB backend is on the roadmap.
- Configured *commands are never executed* during audits — only resolvability is checked (`where`/`which`). Executive checks can only ever run behind BOTH a policy switch AND an explicit command allowlist, in a separately-gated validation stage — never inside an audit.
- No OpenAI/Anthropic/etc. adapter yet. Adding an environment = implement `EnvironmentAdapter` + tests + fixture.

## The consent surface (one file)

`~/.config/csn/policy.json` — every toggle is default-off:

```jsonc
{
  "version": 1,
  "scan": { "roots": [], "allowProjectScans": false },
  "privacy": { "redactEmails": true, "minimizePaths": true, "allowDescriptionCapture": true },
  "sharing": { "mode": "disabled", "allowProjectSummaries": false },
  "schedule": { "enabled": false },
  "exec": { "allow": false, "allowedCommandPrefixes": [], "timeoutMs": 60000 }
}
```

`npm run audit -- policy` prints exactly what is on right now and never flips anything.

## Public API (server operators)

The API is deliberately small: `POST /v1/installations`, `DELETE /v1/installations/:id/tokens/:tokenId`, `POST /v1/reports` (idempotent, secret-shape refused, rate-limited), `GET /v1/tasks/next`, `POST /v1/tasks/:taskId/ack`, `GET /healthz`. Tokens are hashed server-side (sha256); raw tokens are shown once. See `docs/architecture.md` for contracts and rate limits.

## Contributing & security

- Bugs & proposals via [issues](CONTRIBUTING.md).
- Please see [SECURITY.md](SECURITY.md) before reporting a vulnerabilty — in particular, *never* paste secrets into bug reports; CSN's own tools refuse them at intake.

## License

MIT — see [LICENSE](LICENSE).
