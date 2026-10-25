import type { AuditOptions, CapabilityRecord, EnvironmentAdapter } from '@csn/core';
import { CATEGORY_KEYWORD_RULES } from '@csn/core';
import type { AuditResult } from '@csn/core';
import { AdapterRegistry } from '@csn/adapters';

/**
 * Audit engine: runs every registered adapter, collects results with
 * per-adapter error isolation, and produces the aggregate AuditResult with
 * deterministic summaries.
 */
export interface AuditRunOptions extends AuditOptions {
  /** Only run these adapter ids (device/diagnostics). */
  environmentFilter?: string[];
}

const EMPTY_AUDIT = (adapter: EnvironmentAdapter, message: string) => ({
  adapterId: adapter.id,
  environmentName: adapter.name,
  detected: false,
  detectionEvidence: [],
  configurationPaths: [],
  capabilities: [],
  limitations: ['adapter crashed during audit — see errors'],
  errors: [message],
});

export async function runAudit(
  options: AuditRunOptions = {},
  registry: AdapterRegistry = new AdapterRegistry(),
): Promise<AuditResult> {
  const started = Date.now();
  const environments = [];
  const filter = new Set(options.environmentFilter ?? []);

  for (const adapter of registry.list()) {
    if (filter.size > 0 && !filter.has(adapter.id)) continue;
    try {
      const { homeRoot, ...rest } = options;
      environments.push(await adapter.audit({ ...rest, homeRoot }));
    } catch (err) {
      environments.push(EMPTY_AUDIT(adapter, err instanceof Error ? err.message : String(err)));
    }
  }

  const all = environments.flatMap((environment) => environment.capabilities);
  const byCategory: Record<string, number> = {};
  const byVerification: Record<string, number> = {};
  for (const record of all) {
    byCategory[record.category] = (byCategory[record.category] ?? 0) + 1;
    byVerification[record.verification] = (byVerification[record.verification] ?? 0) + 1;
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    wallTimeMs: Date.now() - started,
    environments,
    summary: { capabilities: all.length, byCategory, byVerification },
  };
}

/** Environments where detection must be verified by callers (for UI honesty). */
export function auditExportable(result: AuditResult): AuditResult & { exportNote: string } {
  return {
    ...result,
    exportNote: 'This audit was produced by local read-only filesystem inspection. Detection ≠ execution; items marked "configured" have supporting files/dependencies, not runtime proof.',
  };
}

/**
 * Deterministic semantic classifier. Structural categories come from
 * adapters (agent/skill/mcp-server/plugin/custom-command/...); keyword rules
 * refine those into specialized categories (browser-automation,
 * voice-speech, …) only when the capability's own name/description
 * contains the keyword. Existence always comes from on-disk evidence.
 */
export function refineCategory(record: CapabilityRecord): CapabilityRecord {
  const structuralBase = new Set(['agent', 'skill', 'mcp-server', 'plugin', 'custom-command', 'project-instructions', 'other']);
  if (!structuralBase.has(record.category)) return record; // already specific (e.g. from earlier refinement)

  const haystack = `${record.name} ${record.description ?? ''}`.toLowerCase();
  for (const rule of CATEGORY_KEYWORD_RULES) {
    if (rule.keywords.length === 0) continue; // placeholder pseudo-rule
    if (rule.keywords.some((keyword) => haystack.includes(keyword))) {
      return { ...record, category: (rule.category as CapabilityRecord['category']) };
    }
  }
  return record;
}

export function refineAll(records: readonly CapabilityRecord[]): CapabilityRecord[] {
  return records.map(refineCategory);
}

/** Convenience for tools/dashboards: flat capability list from an audit. */
export function flattenAudit(result: AuditResult): CapabilityRecord[] {
  return result.environments.flatMap((environment) => environment.capabilities);
}

/** Used by CLI counters; exported so tests and dashboards agree on semantics. */
export function countByVerification(result: AuditResult): Record<string, number> {
  return result.summary.byVerification;
}
