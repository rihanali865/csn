# Roadmap

Status vocabulary: `shipped` · `in progress` · `designed (schema exists)` · `future`.

## v1 — public launch (this repo)

- [x] Read-only audits for OpenCode / Claude Code / Codex (Cursor partial, docs-unverified)
- [x] Deterministic capability records + verification statuses + confidence
- [x] Consent file (policy.json) with all-off defaults + transparency commands
- [x] Gap report vs backlog profile
- [x] Network API: hashed tokens, idempotent intake, rate limits, task queue
- [x] Master agent pipeline to `integration-proposed` with human gate
- [x] CLI + dashboard UX

## v1.x — hardening

- [ ] `npm audit`/dependency-policy automation (`weekly npm ci` lockfile drift check)
- [ ] Adapter fixture matrices: claude-code project `.claude/`, codex project `.codex/` layouts
- [ ] API: aggregated `CapabilityProfile` serving (schema exists in core) with k-anonymity N
- [ ] API: sqlite (`node:sqlite`) store behind the same `ApiStoreApi` interface
- [ ] Server-side audit log for admin actions (token issuance/revocation)
- [ ] OSGi-style "publisher allowlist" for the master agent ((operator-trusted report sources))

## v2 — trust work

- [ ] Cursor adapter grounding: docs reachable, official schema verified, limitations shrunk or removed
- [ ] More environments (Dify? LangGraph? VS Code Copilot agents?) — each via the adapter checklist
- [ ] Capability *profiles* with versioned manifests (capability groups + conflict sets)
- [ ] Signed capability claims (operator-signs-report; server verifies with pinned keys)
- [ ] Differential reports (state diffing between two audits on the same machine)

## Always

- [ ] Keep the consent boundary intact: no feature request that hides monitoring from the user behind whose machine CSN runs (see threat model). This line is permanent.
