import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CsnPolicy } from '@csn/policy';
import { containsSecret } from '@csn/privacy';
import type { Candidate, ValidationRecord } from './intake.js';

/**
 * Detached validation. Hard rules (checked again here, not assumed):
 *  - the operator's policy must both enable exec AND allowlist the command prefix
 *    (defaults are allow:false — validation never runs on out-of-box policy)
 *  - the child process gets a minimal sanitized environment; no secrets are
 *    passed, nothing from the operator's config tree is exposed
 *  - a throwaway cwd under the OS temp dir, killed on timeout, output capped
 *  - the candidate can only move to testing-passed/testing-failed; a refusal is
 *    recorded, not silent
 */

export interface ValidationPlan {
  candidateId: string;
  approved: boolean;
  refusal?: string;
  command?: string[];
  timeoutMs?: number;
  maxBufferBytes?: number;
  policySummary: string;
}

const WINDOWS_SAFE_ENV_KEYS = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'TEMP', 'TMP', 'COMSPEC', 'WINDIR'];
const POSIX_SAFE_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'TERM'];

/** Candidate must be in a state the machine allows to become testing-*. */
export function candidateReadyForTesting(candidate: Candidate): boolean {
  return candidate.status === 'ready-for-detached-testing';
}

export function buildValidationPlan(candidate: Candidate, policy: CsnPolicy, optCandidates: string[] = []): ValidationPlan {
  const policySummary = `exec.allow=${policy.exec.allow}; prefixes=${JSON.stringify(policy.exec.allowedCommandPrefixes)}; timeoutMs=${policy.exec.timeoutMs}`;

  if (!policy.exec.allow) {
    return {
      candidateId: candidate.id,
      approved: false,
      refusal: 'policy.exec.allow is false (the safe default) — detached validation requires the user to explicitly enable and allowlist commands in policy.json',
      policySummary,
    };
  }
  if (!candidateReadyForTesting(candidate)) {
    return {
      candidateId: candidate.id,
      approved: false,
      refusal: `candidate status is '${candidate.status}'; only 'ready-for-detached-testing' may be validated`,
      policySummary,
    };
  }

  const command = optCandidates.find((candidateCmd) => {
    const first = candidateCmd.split(/\s+/)[0] ?? candidateCmd;
    return policy.exec.allowedCommandPrefixes.some((prefix) => first === prefix.trim());
  });

  if (!command) {
    return {
      candidateId: candidate.id,
      approved: false,
      refusal: "command is not in policy.exec.allowedCommandPrefixes (the allowlist) — network-sourced commands are never executed ad hoc",
      policySummary,
    };
  }

  return {
    candidateId: candidate.id,
    approved: true,
    command: command.split(/\s+/),
    timeoutMs: policy.exec.timeoutMs,
    maxBufferBytes: policy.exec.maxBufferBytes,
    policySummary,
  };
}

function sanitizedEnv(): NodeJS.ProcessEnv {
  // minimal environment: PATH + OS plumbing only — nothing the operator keeps
  // in env files/API keys is reachable from the validation child
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    NODE_ENV: 'production',
    CSN_VALIDATION: '1',
  };
  if (process.platform === 'win32') {
    for (const key of ['SYSTEMROOT', 'COMSPEC', 'TEMP', 'TMP'] as const) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
  } else {
    for (const key of ['LANG', 'TERM'] as const) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
  }
  return env;
}

export interface RunResult {
  record: ValidationRecord;
}

/**
 * Execute a pre-approved plan detached from the operator's context. Returns a
 * ValidationRecord; the caller alone decides what status the candidate gets
 * (via the transition machine).
 */
export async function runDetachedValidation(plan: ValidationPlan): Promise<RunResult> {
  if (!plan.approved || !plan.command) {
    const record: ValidationRecord = { ran: false, reason: plan.refusal };
    return { record };
  }

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'csn-validate-'));
  const started = Date.now();
  const timeoutMs = plan.timeoutMs ?? 60_000;
  const maxBuffer = plan.maxBufferBytes ?? 2_000_000;

  const result = await new Promise<{ code: number | null; output: string; timedOut: boolean }>((resolve) => {
    let output = '';
    let timedOut = false;
    const child = spawn(plan.command![0]!, plan.command!.slice(1), {
      cwd,
      env: sanitizedEnv(),
      shell: false, // never shell — no operator shell config leaks in
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* process already gone */
      }
    }, timeoutMs);

    const collect = (chunk: Buffer | string) => {
      if (Buffer.byteLength(output, 'utf8') < maxBuffer) output += String(chunk);
      else output = output.slice(0, Math.floor(maxBuffer / 4)) + '\n… output truncated by CSN (byte cap)';
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', (err) => {
      output += `\nspawn error: ${err.message}`;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });

  let outputTail = result.output.slice(-4000);
  if (containsSecret(outputTail)) {
    outputTail = 'output withheld: it contained credential-shaped content';
  }

  const record: ValidationRecord = {
    ran: true,
    passed: result.code === 0 && !result.timedOut,
    exitCode: result.code ?? undefined,
    outputTail,
    durationMs: Date.now() - started,
    cwdUsed: path.basename(cwd),
    command: plan.command.map((part, index) => (index === 0 ? part : '**redacted-arg**')),
  };
  return { record };
}

export function workspaceRoot(): string {
  return os.tmpdir();
}
