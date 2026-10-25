---
name: Feature / adapter request
about: Propose a new environment adapter, gap-profile, or capability
title: '[feature] '
labels: ['enhancement']
---
**Is your proposal consent-compatible?** CSN's hard rule: no feature that monitors user activity without explicit, per-instance consent (see docs/threat-model.md). The first paragraph of this issue should say how your idea fits.

**Environment / adapter?** If requesting an adapter: link the official config docs you verified (this is a PR prerequisite — adapters must be grounded in documented layout or marked docs-unverified explicitly).

**Gap it closes** — which desirable capability (cf. the backlog profile in `packages/discovery`) would this enable?

**Failure story** — how should this feature fail when the dataset/host is missing, oversized, or secret-shaped?

**Test sketch** — which fixtures/cases would prove both the happy path and the refusal path?
