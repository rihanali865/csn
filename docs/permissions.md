# CSN Permissions — Who is allowed to do what, where

CSN is designed around a single, inspectable permission file: `~/.config/csn/policy.json` (schema in `packages/policy`). Defaults are all-off. This page is the human-readable contract of that file.

## Read scopes

| Path CSN may read | Allowed by | Notes |
| --- | --- | --- |
| `~/.config/opencode/**` | always (environment config) | read-only; token stores inside are name-screened away |
| `~/.claude/settings.json`, `skills/`, `agents/`, `plugins/` | always | `~/.claude.json` is on the never-read list |
| `~/.codex/config.toml`, project `.codex/*/config.toml` | always | parsed with a TOML-subset parser that *reports* unsupported lines |
| `~/.cursor/mcp.json` | always | adapter marked docs-unverified in its limitations |
| any `scan.roots[]` entry | only if `scan.allowProjectScans: true` | checked via `withinAllowedScanScope()`; `.git/node_modules/dist/…` excluded by default |
| `~/.config/csn/policy.json` | always (it *is* the policy) | |

Command *resolvability* checks (`where`/`which`) hit PATH only — binaries are never launched by the audit layer.

## Write scopes

| Location | Who writes it | What |
| --- | --- | --- |
| `~/.config/csn/master/data.json` | master agent CLI | candidate store (local, yours) |
| `~/.config/csn/api/data.json` | network API process on a server | installation/report store (hashed tokens) |
| nothing else | — | CSN writes no project files, no shell rc's, no crontabs, no browser settings |

## Execution scopes

| What can execute | Gate(s) |
| --- | --- |
| audit probes | never execute anything (PATH-lookup only) |
| detached validation | `exec.allow: true` **AND** command matches `exec.allowedCommandPrefixes` **AND** you typed the command yourself in the CLI invocation |

## Network egress scopes

| Destination | Gate(s) |
| --- | --- |
| report submit | `sharing.mode != 'disabled'`, endpoint match (or explicit mismatch override), `CSN_NETWORK_TOKEN` env present |
| task fetch | `schedule.enabled: true` + endpoint + env token |
| everything else | nothing — no telemetry, no update pings, no CDN |

## Defaults table (policy.json as parsed with no file present)

```yaml
version: 1
scan.roots: []
scan.allowProjectScans: false
scan.maxFilesPerEnvironment: 2000
privacy.redactEmails: true
privacy.minimizePaths: true
privacy.allowDescriptionCapture: true
sharing.mode: disabled
sharing.allowProjectSummaries: false
sharing.endpoint: (unset)
schedule.enabled: false
schedule.hour: 10 (Saturday)
exec.allow: false
exec.allowedCommandPrefixes: []
exec.timeoutMs: 60000
exec.maxBufferBytes: 2000000
masterAgent.requireManualConfirmForIntegration: true
masterAgent.maxCandidatesTracked: 100
```

To inspect the live values: `npm run audit -- policy` (or the dashboard's policy link). CSN never mutates this file itself.
