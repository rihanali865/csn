---
name: Bug report
about: Something behaves differently than the documented consent/evidence contract
title: '[bug] '
labels: ['bug']
---
**What happened?** Paste the exact command/output (paths are usually fine — CSN outputs are minimized; if you see an absolute home path, that is itself a bug).

**What did you expect instead?** (e.g. "adapter should refuse to read X", "status should stay `declared`")

**Package / area**
- [ ] adapters (opencode / claude-code / codex / cursor)
- [ ] discovery / gap report
- [ ] reports / privacy
- [ ] policy / consent gates
- [ ] services/api
- [ ] master agent
- [ ] apps (cli / dashboard)

**Environment** (OS, node version, which AI coding envs are installed — no version needed, CSN doesn't even check it)

**Consent state** (run `csn policy --json`, remove nothing — defaults are fine)

**Security impact?** If this leaks secrets or bypasses consent, stop here and follow SECURITY.md instead of posting publicly.

**Reproduction** — steps, or (best) a fixture diff under `tests/fixtures/environments/` that triggers it.
