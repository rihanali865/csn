# CSN Architecture

CSN is a TypeScript ESM monorepo (npm workspaces, no build step — `tsx` executes workspace source directly, `vitest` runs tests with path aliases).

```
packages/core          ─ types · zod schemas · deterministic ids · gaps · status machine · scoring · confidence
packages/privacy       ─ redact.ts (patterns) · minimize.ts (paths, filenames)
packages/adapters      ─ fs-utils (jsonc/frontmatter/toml-subset parsing) · per-env probes · registry
packages/discovery     ─ audit-engine (per-adapter isolation) · refine keywords · gap-report · task diagnostics
packages/compatibility ─ mcp entry validation · registry conflicts · dependency resolver injection · setup plans
packages/policy        ─ CsnPolicy schema · gating functions (submissionAllowed, projectScanAllowed, withinAllowedScanScope)
packages/reports       ─ sanitized submissions (schema-parsed) · markdown renderers
services/api           ─ express app: identity, intake, tasks (store-injected, testable)
services/master-agent  ─ private operator pipeline (intake→evaluate→research→validate→propose→integrate/rollback)
apps/cli               ─ user-facing commands
apps/dashboard         ─ local-only express + server-rendered HTML
tests/fixtures/…       ─ per-environment fake homes for adapter tests
tests/integration/…    ─ cross-package end-to-end (audit → submission → api → master intake)
```

## Dependency direction (enforced by review, soon by lint)

`core` has zero internal deps. Everything depends (one-way) on `core` and `privacy`. `discovery` consumes `adapters`. Nothing in `packages/` touches `node:net`. Only `services/api`, `apps/*` and master-agent make network/file-system mutations.

## Key invariants

1. **Records are born deterministic.** Adapter → `buildRecord(...)` → `capabilityId(env, sourceType, name, version)`, `verificationFromEvidence(evidence)`, `computeConfidence(evidence)`. Two runs on the same disk produce identical ids and equal confidence.
2. **Adapters cannot mint `tested`.** `verificationFromEvidence` maps evidence types to at most `configured`; only the master agent's validation stage can set `tested`/`failed`, and only via a policy-gated subprocess.
3. **Paths never leave the machine unminimized.** `minimizePath(absolute, [homeRoot])` → `~/…`, applied at every record source and evidence path, and again during `buildSubmissionPayload`.
4. **Every status transition is explicit.** `assertTransition(from, to, reason)` — the transition table in `packages/core/src/statuses.ts` is the only authority. CLI/refusals record history instead of mutating silently.
5. **Untrusted stays untrusted.** Community-sourced candidates carry `untrusted: true` through intake; only local execution (validation) with a passing result moves them forward.

## Network API contract (v1)

| Endpoint | Auth | Semantics |
| --- | --- | --- |
| `POST /v1/installations` | none (IP rate-limited) | returns `{ installationId, token (raw, shown once), scopes }`; token stored as sha256 |
| `DELETE /v1/installations/:installationId/tokens/:tokenId` | Bearer | revoke a token of the *same* installation; idempotent |
| `POST /v1/reports` | Bearer (`report:submit`) | zod validation → secret-shape refusal (422) → idempotency by canonical payload hash (replay ⇒ 200, first ⇒ 201) → rate limit 120/h/inst |
| `GET /v1/tasks/next` | Bearer (`task:ack`) | delivers at most one pending task; drains after delivery |
| `POST /v1/tasks/:taskId/ack` | Bearer (`task:ack`) | first ack wins; replay returns the original outcome |
| `GET /healthz` | none | freshness + version |

Error envelope: `{ "error": { "code": "schema|secret_shaped_content|rate_limited|unauthorized|token_revoked|insufficient_scope|not_found|not_delivered|invalid_json|payload_too_large|internal", "message": string, "details?": string[] } }`.

Limits (`ApiLimits`): 30 registrations/hour/IP, 120 submissions/hour/installation, body cap 256 kB. The express handler order is: bearer → hash lookup → revoked? → scope? → rate limit → schema → secrets → idempotency → store.

## Master agent pipeline states

```
reported ─▶ research-pending ─▶ (needs-more-evidence ◀▶ research-pending) ─▶ ready-for-detached-testing
   │              ▼                                   ▼                            │
   └─rejected ◀──┴──── gates (security/license/evidence) ────◀─── testing-failed ◀─┘
                                                                  │ pass
                                                                  ▼
                                                    integration-proposed
                                                                  │ human confirm
                                                                  ▼
                                                        integrated-verified
                                                                  │ rollback
                                                                  ▼
                                                           rolled-back (terminal)
```

- Scoring suggests; the machine disposes. Gate rejections (`securityGate`, `licenseGate`, evidence gates) short-circuit to `rejected` by the shortest legal path.
- Research findings are `declared`-ceiling: they can fill `license`/docs references but never raise verification strength.
- Detached validation runs `exec.allow===true` + allowlist-matched commands only, in a sanitized env, temp cwd, timeout + byte cap, stdout/stderr scanned for secret shapes before storage (else withheld).

## Extension points

- **New environment adapter:** implement `EnvironmentAdapter` (honest `supports`, non-empty `knownLimitations`, sync `audit(options): EnvironmentAudit` that never throws on missing config), add fixtures under `tests/fixtures/environments/<env>/`, register in `registry.ts`, document the docs-URL provenance in the header comment or mark `docs-unverified` in limitations.
- **Custom gap profile:** `DesiredProfile { targetId, capabilities: DesiredCapability[] }` — CLI/dashboard currently ship `csn-backlog-v1`.
- **Storage swap for API/master store:** both are single-interface JSON stores (`ApiStoreApi` / MasterStore file) designed for a sqlite/served replacement (Node 24 `node:sqlite` is available in this repo's baseline).
