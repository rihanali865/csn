# Changelog

All notable changes to CSN are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is 0.x (breaking changes land on MINOR bumps until 1.0).

## [0.1.0] — 2026-10-26 (initial public cut)

### Added
- **Core** (`@csn/core`): capability record/evidence model, deterministic IDs, category taxonomy + keyword refinement, zod schemas for network payloads (`ReportSubmission`, `ScheduledTask`, `CapabilityProfile`), desired-vs-local gap comparison, candidate **status machine** (10 states, explicit-transition-only), explainable 12-factor scoring with security/license/evidence gates, confidence derivation from evidence.
- **Privacy** (`@csn/privacy`): token-shape redaction (OpenAI/Anthropic/GitHub/AWS/JWT/Slack/Bearer/URL-creds/kv-pairs), email redaction, home-path minimization, drive-letter stripping, secret-filename deny-list (env, pem, key, credentials, ssh, mcp-auth…), strict project summarizer that fails closed on secret-like top-level files.
- **Adapters** (`@csn/adapters`): OpenCode (config/agents/skills/plugins/commands/mcps, disabled-MCP skip, PATH checks only), Claude Code (settings.json/skills/agents/plugins; `~/.claude.json` never read), Codex (`config.toml` + project `.codex/`, `[features]`), Cursor (`mcp.json`, honestly labeled **docs-unverified**), JSONC/frontmatter/TOML-subset parsers, BOM tolerance, `AdapterRegistry` with duplicate rejection.
- **Discovery** (`@csn/discovery`): audit engine with per-adapter error isolation, semantic category refinement, gap reports (incl. built-in `csn-backlog-v1` profile), task-recovery diagnostics (unverified-success / missing-dependency / retry-saturation) & resume plans.
- **Compatibility** (`@csn/compatibility`): MCP-entry validation (destructive shell, credential-shaped env, non-https/token-in-URL patterns), registry conflicts, injected dependency resolver, setup plans.
- **Policy** (`@csn/policy`): single consent file `~/.config/csn/policy.json`; every knob default-off; `describePolicy`, scan-scope & submission gates; never auto-enables sharing without endpoint.
- **Reports** (`@csn/reports`): path-free, schema-parsed submission builder; legend-laden audit/gap markdown renderers; explicit "nothing was sent" preview.
- **Network API** (`@csn/api`): installation registration with **hashed, scoped, revocable** tokens (raw shown once), report intake with schema→secret→idempotency→rate-limit ordering, scheduled-task delivery + idempotent ack, JSON error envelope, bounded bodies, localhost-default server.
- **Master Agent** (`@csn/master-agent`, private tooling): schema-gated intake with secret-shape rejection & dedupe, local-registry comparison via real audit, 12-factor explainable evaluation pulling through legal status chains, research stage with *declared-ceiling* honesty, policy-gated detached validation (sanitized env / temp cwd / allowlist / timeout / output cap / secret-scan of captured output), proposal markdown generator with explicit NOT-proof language, propose→accept→rollback human gate.
- **Apps**: `csn` CLI (audit / gaps / policy / submit / tasks — dry-run first, policy echo on every audit) and a script-free, CSP-hardened local dashboard (scan-on-click).
- **Docs**: architecture, threat model (including the repository's founding consent boundary), privacy model, permissions contract; SECURITY/CONTRIBUTING/CODE_OF_CONDUCT; issue templates; CI (node 22/24 × ubuntu/windows).

### Notes
- First release has **zero commits → 157 green tests → public**, all capabilities verified by running them: numbers live in the delivery report (v1 acceptance evidence).
- Cursor adapter ships deliberately incomplete (docs unreachable at build time), marked in `knownLimitations` on every audit it produces.
