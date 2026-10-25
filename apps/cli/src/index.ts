#!/usr/bin/env node
import process from 'node:process';
import { AdapterRegistry, getBuiltinAdapters } from '@csn/adapters';
import { runAudit, buildGapReport, backlogProfile } from '@csn/discovery';
import { type AuditResult } from '@csn/core';
import { loadPolicy, describePolicy, POLICY_FILE_NAME, type CsnPolicy } from '@csn/policy';
import { buildSubmissionPayload, renderAuditMarkdown, renderGapMarkdown, renderSubmissionPreview } from '@csn/reports';

/**
 * CSN CLI — everything here runs only when a human explicitly invokes it.
 * Defaults are boring by design: no scan without a command, no upload without
 * an enabled sharing policy + endpoint + token.
 */

export interface CliIO {
  out: (line: string) => void;
  err: (line: string) => void;
}

export const consoleIO: CliIO = { out: (l) => console.log(l), err: (l) => console.error(l) };

interface Args {
  flags: Record<string, string | boolean>;
  positional: string[];
}

const VALUE_FLAGS = new Set(['home', 'only', 'max', 'note', 'endpoint', 'strict-path']);

/**
 * Parses CLI argv. Flags with values accept both `--flag value` (next token,
 * consumed) and `--flag=value`; boolean flags take no value. Value flags only
 * swallow the next token when that token is not itself a flag.
 */
function parse(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (raw.startsWith('--')) {
      const body = raw.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (VALUE_FLAGS.has(body) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[body] = argv[++i];
      } else {
        flags[body] = true;
      }
    } else {
      positional.push(raw);
    }
  }
  return { flags, positional };
}

const HELP_LINES = [
  'csn — the Capability Swarm Network CLI (all actions are explicit; nothing runs in the background)',
  '',
  '  csn audit [--json] [--home <root>] [--only opencode,claude-code]  audit AI coding environments (read-only)',
  '  csn gaps   [--json] [--home <root>]                               gap report vs the built-in backlog profile',
  '  csn policy [--json]                                               show consent/policy state and its file path',
  '  csn submit [--dry-run] [--endpoint <url>] [--token-env <VARNAME>]  sanitized report preview / guarded network submit',
  '',
  'Defaults are conservative: sharing disabled, scheduled work disabled, project scans disabled.',
  `${POLICY_FILE_NAME} lives in ~/.config/csn/ — the CLI never flips a consent switch on its own.`,
];

interface RunAuditOptions {
  home?: string;
  only?: string[];
  max?: number;
}

async function doAudit(args: RunAuditOptions): Promise<AuditResult> {
  const registry = new AdapterRegistry(getBuiltinAdapters());
  return runAudit(
    {
      homeRoot: args.home ?? process.env.CSN_HOME ?? undefined,
      maxCapabilities: args.max,
      environmentFilter: args.only,
    },
    registry,
  );
}

export async function runCli(argv: string[], io: CliIO = consoleIO): Promise<number> {
  const args = parse(argv);
  const command = args.positional[0] ?? 'help';
  const rest = args.positional.slice(1);

  const json = args.flags.json === true;
  const auditOptions: RunAuditOptions = {
    home: typeof args.flags.home === 'string' ? args.flags.home : undefined,
    only: typeof args.flags.only === 'string' ? args.flags.only.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    max: typeof args.flags.max === 'string' ? Number(args.flags.max) : undefined,
  };

  switch (command) {
    case 'help':
    case undefined: {
      for (const line of HELP_LINES) io.out(line);
      return 0;
    }

    case 'audit': {
      const policy = loadPolicy();
      const audit = await doAudit(auditOptions);
      if (json) {
        io.out(JSON.stringify(audit, null, 2));
        return 0;
      }
      io.out(renderAuditMarkdown(audit, { homeRoot: auditOptions.home ?? process.env.CSN_HOME ?? undefined }));
      io.out('');
      io.out('## Policy in effect during this run');
      io.out(describePolicy(policy));
      io.out('');
      io.out('_Reviewed by explicit request — nothing ran automatically, nothing left the machine._');
      return 0;
    }

    case 'gaps': {
      const audit = await doAudit(auditOptions);
      const report = buildGapReport(audit, backlogProfile());
      if (json) {
        io.out(JSON.stringify(report, null, 2));
        return 0;
      }
      io.out(renderGapMarkdown(report));
      return 0;
    }

    case 'policy': {
      const strict = (typeof args.flags['strict-path'] === 'string' ? args.flags['strict-path'] : undefined) as string | undefined;
      const policy: CsnPolicy = strict ? loadPolicy(strict) : loadPolicy();
      if (json) {
        io.out(JSON.stringify(policy, null, 2));
        return 0;
      }
      io.out('# CSN policy (what this tool is allowed to do)\n');
      io.out(describePolicy(policy));
      const decision = policy.sharing.mode;
      io.out('');
      io.out(`sharing: ${decision} — ${decision === 'disabled' ? 'nothing will ever be sent' : 'only byte-exact previews go to the endpoint you configured'}`);
      io.out(`policy file: ${strict ?? '~/.config/csn/' + POLICY_FILE_NAME}`);
      io.out('_Consent is file-based: you can read every rule before it applies._');
      return 0;
    }

    case 'submit': {
      const policy = loadPolicy();
      const audit = await doAudit(auditOptions);
      const payload = buildSubmissionPayload(audit, {
        adapterVersion: 'csn-cli/0.1.0',
        notes: typeof args.flags.note === 'string' ? args.flags.note.slice(0, 400) : undefined,
      });
      const preview = renderSubmissionPreview(payload);

      if (args.flags['dry-run'] === true || !args.flags.endpoint) {
        io.out(preview);
        io.out('');
        io.out(args.flags.endpoint ? 'Nothing was sent (dry-run).' : 'Nothing was sent (no --endpoint supplied).');
        return 0;
      }

      if (policy.sharing.mode === 'disabled') {
        io.err('refused: sharing.mode is "disabled" in policy.json — enable it explicitly (manual) before submitting');
        return 3;
      }
      if (policy.sharing.mode === 'manual' && typeof policy.sharing.endpoint === 'string' && !args.flags['allow-mismatched-endpoint']) {
        const configured = policy.sharing.endpoint;
        if (configured !== String(args.flags.endpoint)) {
          io.err(`refused: --endpoint does not equal the endpoint configured in ${POLICY_FILE_NAME} (${configured}); pass --allow-mismatched-endpoint to override consciously`);
          return 3;
        }
      }
      const tokenEnvVar = typeof args.flags['token-env'] === 'string' ? args.flags['token-env'] : 'CSN_NETWORK_TOKEN';
      const token = process.env[tokenEnvVar];
      if (!token) {
        io.err(`refused: no token in env ${tokenEnvVar} — tokens are read from the environment, never from flags/history`);
        return 3;
      }

      const endpoint = String(args.flags.endpoint);
      try {
        const response = await fetch(new URL('/v1/reports', endpoint).toString(), {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify(payload),
        });
        const body = (await response.json().catch(() => ({}))) as { submissionId?: string; replay?: boolean; error?: { code?: string; message?: string; details?: string[] } };
        if (!response.ok) {
          io.err(`submit failed: ${response.status} ${body.error?.code ?? ''} ${body.error?.message ?? ''}`);
          for (const detail of body.error?.details ?? []) io.err(`  · ${detail}`);
          return 5;
        }
        io.out(`submitted: ${body.submissionId} (replay: ${body.replay === true}) — payload contained ${payload.capabilities.length} sanitized capabilities, 0 paths, 0 raw secrets`);
        return 0;
      } catch (err) {
        io.err(`network error: ${err instanceof Error ? err.message : String(err)}`);
        return 5;
      }
    }

    case 'tasks': {
      const policy = loadPolicy();
      if (!policy.schedule.enabled) {
        io.out('scheduled work: disabled (default). No polling, no timers. Enable schedule.enabled only if *you* want recurring reviews.');
        return 0;
      }
      const endpoint = typeof args.flags.endpoint === 'string' ? args.flags.endpoint : policy.sharing.endpoint;
      if (!endpoint) {
        io.err('refused: no endpoint configured (policy.sharing.endpoint or --endpoint) — task polling requires a concrete destination');
        return 3;
      }
      const tokenEnvVar = typeof args.flags['token-env'] === 'string' ? args.flags['token-env'] : 'CSN_NETWORK_TOKEN';
      const token = process.env[tokenEnvVar];
      if (!token) {
        io.err(`refused: no token in env ${tokenEnvVar}`);
        return 3;
      }
      const response = await fetch(new URL('/v1/tasks/next', endpoint).toString(), {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.status === 204) {
        io.out('no scheduled tasks pending.');
        return 0;
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
        io.err(`task fetch failed: ${response.status} ${body.error?.code ?? ''} ${body.error?.message ?? ''}`);
        return 5;
      }
      const body = (await response.json()) as { task: { taskId: string; instructions: string; dueAt: string } };
      io.out(`pending task ${body.task.taskId}:`);
      io.out(`  instructions: ${body.task.instructions}`);
      io.out(`  due: ${body.task.dueAt}`);
      io.out('_A task is a proposal: run it only if you agree, and ack it with `csn task-ack`._');
      return 0;
    }

    default:
      io.err(`unknown command: ${command} (also unresolved argument list: ${rest.join(' ')})`);
      for (const line of HELP_LINES) io.err(line);
      return 1;
  }
}

const isDirectRun = typeof process !== 'undefined' && process.argv[1] !== undefined && /cli[\\/]src[\\/]index\.ts$/.test(process.argv[1].replace(/\\/g, '/'));
if (isDirectRun) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`fatal: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}
