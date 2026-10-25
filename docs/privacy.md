# CSN Privacy Model

Everything here is enforced in code, not in prose. The one-line version: **CSN ships conclusions about capability *shape*, never your file contents, network topology, or identity.**

## What a submission physically contains

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-01-01T00:00:00.000Z",
  "environment": { "type": "opencode", "adapterVersion": "0.1.0", "osFamily": "windows" },
  "capabilities": [
    {
      "name": "docs-server",            // ≤120 chars
      "category": "mcp-server",
      "description": "local MCP server",// ≤300 chars, secret-scanned
      "sourceType": "mcp-config",       // ≤60 chars — no path
      "verification": "configured",
      "confidence": 0.7,
      "version": "1.0.0",               // only if the manifest stated it
      "license": "MIT",
      "securityNotes": ["runner found on PATH; not executed"] // ≤4 notes, ≤200 chars each
    }
  ],
  "projectSummaries": [],               // only with allowProjectSummaries:true
  "notes": "user-written, ≤400 chars"
}
```

Not present anywhere in a submission: absolute paths, home directory shape, usernames, file contents, environment values, tokens, command lines from your configs.

## The three safety nets, in order

1. **Deny at source.** Adapters refuse to open secret files by name (`SECRET_FILENAME_PATTERNS`): `.env*`, `credentials.json`, `auth.json`, `mcp-auth.json`, `*.pem`, `*.key`, `id_rsa*`, ssh/aws dirs, `.netrc`. There is no code path that reads these at all.
2. **Deny at sanitize.** `redactText()` scrubs token-shaped values (OpenAI/Anthropic-style keys, GitHub PATs, AWS keys, JWTs, Slacks, Bearer headers, `user:pass@host` URLs, `password=` pairs) and user emails. `minimizePath()` collapses home paths to `~/`. `sanitizePath()` additionally drops drive letters.
3. **Deny at storage & submission.** The API refuses any report whose capability notes are secret-shaped (422) — even after the client-side checks. Master intake does the same, per capability, with rejection reasons recorded.

## Project summaries (opt-in twice)

`summarizeProject` produces a tiny perceived-purpose blurb (`purpose ≤240 chars`, categories ≤6, techStack ≤12, `sizeClass`, `evidenceBasis: 'manifest-only'|'manifest-and-readme-head'`) — and it **returns `ok: false` on any secret-like top-level file** rather than summarizing around it. Summaries enter a submission only when *both* `sharing.mode != disabled` **and** `sharing.allowProjectSummaries === true`.

## The never-read list (as of v1)

- `~/.claude.json` (Claude Code's local state file — even though configs elsewhere are parsed)
- `~/.local/share/opencode/mcp-auth.json` and any OAuth/token caches
- Browser profiles, password managers, ssh agents
- Anything under a project root unless `allowProjectScans` is true and the root is listed
- Web accounts of any kind — the adapters do not log in anywhere

## Data lifetimes

| Data | Lives where | Deleted when |
| --- | --- | --- |
| Audit result (paths already minimized) | process memory / file you choose to save | when you close it |
| Submission payload | server store (if you submit) | operator-side retention (v1: manual purging of the JSON store) |
| Master candidates | `~/.config/csn/master/data.json` | `maxCandidatesTracked` bound (500 hard cap) or manual delete |
| API tokens | server store, sha256 only | on revoke |

## What we can't promise (yet)

- Server-side aggregation is local-first: the stored reports are minimized, but a server operator could still see *your* capability names until aggregation lands (roadmap: k-anonymized `CapabilityProfile`s are already schema-defined).
- Confidence values are evidence-derived, not proof. A `configured` MCP that is malicious still looks `configured`.
