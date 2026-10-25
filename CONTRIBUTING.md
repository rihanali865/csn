# Contributing to CSN

Thank you! CSN is an opinionated, safety-first codebase — the review bar here is unusually nitpicky about *consent and evidence honesty*, and that's the point. This guide sets expectations so PRs merge fast.

## Ground rules

1. **Consent is never implicit.** Any feature that scans, schedules, executes, or transmits must default to OFF and be gated by `packages/policy`. If your PR adds a gate, it adds a test proving the off-by-default path.
2. **Evidence honesty over optimism.** A "capability" is only as strong as its weakest claim. Adapters produce `configured` at best. New evidence types need an updated `verificationFromEvidence` mapping and a test.
3. **No hidden monitoring.** See `docs/threat-model.md#the-hard-boundary` — PRs that instrument user activity behind their back will be closed with a pointer to this line (yes, that includes "helpful" telemetry).
4. **Deterministic outputs.** IDs, scores, and confidence must be pure functions of the record. No wall-clock in IDs; timestamps only in dedicated fields.
5. **Path minimization everywhere.** Any new surface carrying a file path goes through `minimizePath`/`sanitizePath` and has a test asserting the output starts with `~/` or contains nothing sensitive.

## Dev setup

```bash
npm install          # workspaces + tsx + vitest
npm run typecheck    # tsc --noEmit across packages
npm test             # vitest, all packages
npm run audit        # smoke-run the CLI against your real config (read-only)
npm run dashboard    # local-only dashboard on 127.0.0.1:4777
```

On Windows with npm ≥10: allow-scripts state is respected via the root `package.json → allowScripts` map. `esbuild` is the only entry; if you add a scripted dependency, propose it in an issue first.

## Code layout expectations

- `packages/*` must stay dependency-free of each other except along the documented direction (see `docs/architecture.md`).
- Keep adapters small and side-effect-safe: sync fs reads, tolerant parsers that *record* failures instead of throwing.
- Tests live in `packages/<pkg>/test/` and use fixtures from `tests/fixtures/environments/`. No network in unit tests.

## PR checklist

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (and you added/updated tests for behavior change)
- [ ] New user-facing strings avoid exposing paths/secrets; run `npm run audit -- audit --home tests/fixtures/environments/opencode/home-oc-user` and eyeball the output
- [ ] New consent-affecting behavior: policy schema + default + docs (`docs/permissions.md`) + a refusal-path test
- [ ] Adapter changes: fixture added/updated, `knownLimitations` still truthful
- [ ] No new dependency without justification in the PR description

## Commit style

Conventional-commit-ish prefixes on one line: `feat(cli): …`, `fix(api): …`, `test(discovery): …`, `docs: …`. Body optional but appreciated for anything touching the consent/policy surface.

## Review process

Every PR gets: (1) a spec-compliance pass (does it do what it says — nothing more), (2) an evidence-honesty pass (claims properly bounded), (3) a people pass (token/secret hygiene). Maintainers may close PRs that violate rule 3 outright.
