import { z } from 'zod';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * CSN policy (spec §12/§13): one schema that decides what the product is
 * allowed to do. Defaults are maximally conservative:
 * - scanning only the user's own environment config dirs
 * - sharing disabled (never enabled implicitly)
 * - scheduled work disabled
 * - arbitrary execution disabled
 */
export const ScanPolicySchema = z.object({
  roots: z.array(z.string()).max(8).default([]),
  allowProjectScans: z.boolean().default(false),
  excludeGlobs: z.array(z.string()).max(64).default(['.git', 'node_modules', 'dist', 'build', 'coverage', '.env', '.env.*', 'secrets', 'credentials', '*.pem', '*.key']),
  maxFilesPerEnvironment: z.number().int().min(10).max(20000).default(2000),
});

export const PrivacyPolicySchema = z.object({
  redactEmails: z.boolean().default(true),
  minimizePaths: z.boolean().default(true),
  allowDescriptionCapture: z.boolean().default(true),
});

export const SharingPolicySchema = z.object({
  mode: z.enum(['disabled', 'manual', 'scheduled']).default('disabled'),
  allowProjectSummaries: z.boolean().default(false),
  endpoint: z.string().url().max(300).optional(),
});

export const SchedulePolicySchema = z.object({
  enabled: z.boolean().default(false),
  dayOfWeek: z.number().int().min(0).max(6).default(6), // 0 = Sunday; default Saturday
  hour: z.number().int().min(0).max(23).default(10),
});

export const ExecPolicySchema = z.object({
  allow: z.boolean().default(false),
  allowedCommandPrefixes: z.array(z.string()).max(16).default([]),
  timeoutMs: z.number().int().min(1000).max(15 * 60 * 1000).default(60_000),
  maxBufferBytes: z.number().int().min(1_000).max(50 * 1024 * 1024).default(2_000_000),
});

export const MasterAgentPolicySchema = z.object({
  requireManualConfirmForIntegration: z.boolean().default(true),
  maxCandidatesTracked: z.number().int().min(1).max(1000).default(100),
});

export const CsnPolicySchema = z.object({
  version: z.literal(1),
  scan: ScanPolicySchema.default({}),
  privacy: PrivacyPolicySchema.default({}),
  sharing: SharingPolicySchema.default({}),
  schedule: SchedulePolicySchema.default({}),
  exec: ExecPolicySchema.default({}),
  masterAgent: MasterAgentPolicySchema.default({}),
});

export type CsnPolicy = z.infer<typeof CsnPolicySchema>;
export type SharingMode = CsnPolicy['sharing']['mode'];

export const DEFAULT_POLICY: CsnPolicy = CsnPolicySchema.parse({ version: 1 });
export const POLICY_FILE_NAME = 'policy.json';

export function policyFileCandidates(homeRoot = os.homedir()): string[] {
  return [path.join(homeRoot, '.config', 'csn', POLICY_FILE_NAME)];
}

/** Loads user policy if present; overrides defaults with a deep merge. Never enables sharing implicitly. */
export function loadPolicy(explicitPath?: string, homeRoot = os.homedir()): CsnPolicy {
  const candidates = explicitPath ? [explicitPath, ...policyFileCandidates(homeRoot)] : policyFileCandidates(homeRoot);
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const raw = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      const userPartial = { ...raw, version: <const>1 };
      const parsed = CsnPolicySchema.parse(userPartial);
      if (parsed.sharing.mode !== 'disabled' && typeof parsed.sharing.endpoint !== 'string') {
        parsed.sharing = { ...parsed.sharing, mode: 'manual' }; // no endpoint configured → never auto-send
      }
      return parsed;
    } catch {
      // unreadable/invalid policy file: fall through to defaults with a warning path contract
      continue;
    }
  }
  return { ...DEFAULT_POLICY };
}

/* ------------------------------------------------------------------ */

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
}

/** Hard gate for report submission (spec: everything consent-based). */
export function submissionAllowed(policy: CsnPolicy): PolicyDecision {
  if (policy.sharing.mode === 'disabled') {
    return { allowed: false, reason: 'sharing is disabled in policy — reports stay on this machine' };
  }
  if (policy.sharing.mode === 'manual' || policy.sharing.mode === 'scheduled') {
    if (typeof policy.sharing.endpoint !== 'string') {
      return { allowed: false, reason: 'sharing endpoint missing from policy' };
    }
    return { allowed: true, reason: `sharing mode '${policy.sharing.mode}' → ${policy.sharing.endpoint}` };
  }
  return { allowed: false, reason: 'unknown sharing mode' };
}

/** Scan-scope enforcement: rejects paths outside explicit allow-lists. */
export function withinAllowedScanScope(absolutePath: string, policy: CsnPolicy, homeRoot = os.homedir()): boolean {
  const normalized = path.normalize(absolutePath).replace(/\\/g, '/').toLowerCase();
  const allowed = new Set<string>(
    [
      path.join(homeRoot, '.config', 'opencode'), // verified global layout
      path.join(homeRoot, '.claude'),
      path.join(homeRoot, '.codex'),
      path.join(homeRoot, '.cursor'),
      ...policy.scan.roots,
    ].map((p) => path.normalize(p).replace(/\\/g, '/').toLowerCase()),
  );
  for (const root of allowed) {
    if (normalized === root || normalized.startsWith(`${root}/`)) return true;
  }
  return false;
}

/** Project directory access requires the explicit flag. */
export function projectScanAllowed(policy: CsnPolicy): PolicyDecision {
  if (policy.scan.allowProjectScans) return { allowed: true, reason: 'project scans explicitly enabled in policy' };
  return { allowed: false, reason: 'project-scoped scanning disabled by policy' };
}

export function describePolicy(policy: CsnPolicy): string {
  const lines = [
    'CSN policy (effective):',
    `  scan roots: ~/.config/opencode, ~/.claude, ~/.codex, ~/.cursor${policy.scan.roots.length > 0 ? `, +${policy.scan.roots.length} user roots` : ''}`,
    `  project scans: ${policy.scan.allowProjectScans ? 'enabled' : 'disabled (default)'}`,
    `  sharing: ${policy.sharing.mode} (${submissionAllowed(policy).allowed ? 'endpoint configured' : 'no endpoint'})`,
    `  weekly schedule: ${policy.schedule.enabled ? `enabled — day ${policy.schedule.dayOfWeek}, hour ${policy.schedule.hour}` : 'disabled (default)'}`,
    `  arbitrary execution: ${policy.exec.allow ? 'enabled (gated command prefixes)' : 'disabled (default)'}`,
    `  project summaries: ${policy.sharing.allowProjectSummaries ? 'allowed (max 10, sanitized)' : 'never generated (default)'}`,
  ];
  return lines.join('\n');
}
