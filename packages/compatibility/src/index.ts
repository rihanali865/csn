/** Integration manifest validation + conflict/duplicate detection (spec §4 Problem B). */

export interface ManifestIssue {
  severity: 'error' | 'warning' | 'suspicious';
  field?: string;
  message: string;
}

export interface ManifestCheckResult {
  ok: boolean;
  issues: ManifestIssue[];
}

export type GenericManifest = Record<string, unknown>;

/**
 * Validates a single MCP-style manifest entry (opencode/cursor/codex shape
 * is normalized by adapters before reaching here).
 */
export function validateMcpEntry(name: string, entry: GenericManifest): ManifestCheckResult {
  const issues: ManifestIssue[] = [];
  const type = typeof entry['type'] === 'string' ? (entry['type'] as string) : undefined;
  const command = Array.isArray(entry['command']) ? (entry['command'] as unknown[]).map(String) : undefined;
  const url = typeof entry['url'] === 'string' ? entry['url'] : undefined;
  const env = entry['environment'] ?? entry['env'];

  if (type && !['local', 'remote'].includes(type)) {
    issues.push({ severity: 'error', field: 'type', message: `unknown MCP type '${type}'` });
  }
  if (!type) {
    issues.push({ severity: 'warning', field: 'type', message: 'type missing — cannot determine local/remote transport' });
  }
  if (type === 'local' && (!command || command.length === 0)) {
    issues.push({ severity: 'error', field: 'command', message: 'local MCP server requires a command array' });
  }
  if (type === 'local' && command && typeof command[0] === 'string' && /rm\s+-rf|curl\s+.*\|\s*(sh|bash)/i.test(command.join(' '))) {
    issues.push({ severity: 'suspicious', field: 'command', message: 'command contains shell-destructive or remote-execution pattern' });
  }
  if (type === 'remote') {
    if (!url) issues.push({ severity: 'error', field: 'url', message: 'remote MCP server requires a url' });
    if (url && /token|key|secret=[^&\s]+/i.test(url)) {
      issues.push({ severity: 'suspicious', field: 'url', message: 'url embeds a credential-looking query parameter' });
    }
    if (url && !/^https:\/\//.test(url)) {
      issues.push({ severity: 'warning', field: 'url', message: 'remote MCP URL is not https' });
    }
  }
  if (env && typeof env === 'object') {
    for (const key of Object.keys(env as object)) {
      if (/secret|token|api[_-]?key|password/i.test(key)) {
        issues.push({
          severity: 'suspicious',
          field: 'environment',
          message: `environment key '${key}' looks credential-shaped; values must never be stored or shown by tools`,
        });
      }
    }
  }
  if (Object.keys(entry).length === 0) {
    issues.push({ severity: 'error', message: 'empty MCP entry' });
  }

  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}

/** Cross-record conflict/duplicate scanning over a capability registry. */
export interface ConflictFinding {
  kind: 'duplicate-name' | 'duplicate-id' | 'config-drift';
  capabilityName: string;
  detail: string;
  involved: Array<{ id: string; sourceType: string }>;
}

export interface RegistryComparable {
  id: string;
  name: string;
  environment: string;
  sourceType: string;
  category: string;
  dependencies?: string[];
  sourcePath?: string;
}

export function findRegistryConflicts(registry: readonly RegistryComparable[]): ConflictFinding[] {
  const findings: ConflictFinding[] = [];

  // duplicate capability identity (same name inside the same environment)
  const byEnvName = new Map<string, RegistryComparable[]>();
  for (const record of registry) {
    const key = `${record.environment}::${record.name.toLowerCase()}`;
    const bucket = byEnvName.get(key) ?? [];
    bucket.push(record);
    byEnvName.set(key, bucket);
  }
  for (const [key, bucket] of byEnvName) {
    if (bucket.length <= 1) continue;
    const sourceTypes = new Set(bucket.map((r) => r.sourceType));
    findings.push({
      kind: 'duplicate-id',
      capabilityName: bucket[0].name,
      detail: `capability '${bucket[0].name}' declared ${bucket.length} times in ${key.split('::')[0]} via ${[...sourceTypes].join(', ')}`,
      involved: bucket.map((r) => ({ id: r.id, sourceType: r.sourceType })),
    });
  }

  return findings;
}

/**
 * Dependency resolution — pure: caller supplies a resolver (e.g. the
 * adapters' PATH check). Philosophy: *not resolvable* produces a finding,
 * never a mutation.
 */
export interface DependencyFinding {
  capabilityId: string;
  dependency: string;
  status: 'resolvable' | 'missing' | 'unresolved';
}

export function checkDependencies(
  registry: readonly RegistryComparable[],
  resolver: (cmd: string) => boolean,
): DependencyFinding[] {
  const findings: DependencyFinding[] = [];
  for (const record of registry) {
    for (const dependency of record.dependencies ?? []) {
      if (resolver(dependency)) {
        findings.push({ capabilityId: record.id, dependency, status: 'resolvable' });
      } else {
        findings.push({ capabilityId: record.id, dependency, status: 'missing' });
      }
    }
  }
  return findings;
}

/** Deterministic review-plan generation (setup plans are read-only). */
export interface SetupPlanStep {
  order: number;
  action: string;
  rationale: string;
}

export function buildSetupPlan(finding: ConflictFinding): SetupPlanStep[] {
  const steps: SetupPlanStep[] = [];
  steps.push({
    order: 1,
    action: `review every declaration of '${finding.capabilityName}' (${finding.involved.map((i) => i.sourceType).join(' vs ')})`,
    rationale: 'deduplicate before editing config files; open each declaration in its own config',
  });
  if (finding.kind === 'duplicate-id') {
    steps.push({ order: 2, action: 'choose one canonical declaration and disable the others (enabled=false rather than deleting)', rationale: 'rollback is one-line and preserves evidence' });
  }
  steps.push({ order: 3, action: 'run the CSN audit again and confirm the conflict disappears', rationale: 'verification must be observed, not assumed' });
  return steps;
}

export function renderConflicts(conflicts: readonly ConflictFinding[]): string {
  if (conflicts.length === 0) return 'No duplicate or conflicting integrations detected.';
  return conflicts
    .map((c) => `- [${c.kind}] ${c.capabilityName}: ${c.detail}`)
    .join('\n');
}
