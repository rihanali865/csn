import * as os from 'node:os';
import type { AuditResult, CapabilityRecord, EnvironmentAudit, SanitizedCapability, ReportSubmission } from '@csn/core';
import { ReportSubmissionSchema } from '@csn/core';
import { redactText, sanitizePath, containsSecret } from '@csn/privacy';
import type { GapReport } from '@csn/discovery';

/**
 * Submission payload builder — the ONLY sanctioned path that turns local
 * audit data into something network-facing. Rules:
 * - no paths, no hostnames, no home dir, no raw config content
 * - descriptions are redacted + truncated; dropped entirely if still suspicious
 * - project summaries arrive pre-approved through the privacy module and are
 *   attached only when the caller passes them in (policy-gated upstream)
 */
export function buildSubmissionPayload(
  audit: AuditResult,
  meta: {
    adapterVersion: string;
    osFamily?: 'windows' | 'macos' | 'linux' | 'other';
    notes?: string;
    projectSummaries?: ReportSubmission['projectSummaries'];
  },
): ReportSubmission {
  const osFamily = meta.osFamily ?? inferOsFamily();
  const capabilities = audit.environments.flatMap((env) => env.capabilities).map(toSanitizedCapability);
  return ReportSubmissionSchema.parse({
    schemaVersion: 1 as const,
    generatedAt: audit.generatedAt,
    environment: {
      type: audit.environments[0]?.adapterId ?? 'unknown',
      adapterVersion: meta.adapterVersion,
      osFamily,
    },
    capabilities,
    projectSummaries: meta.projectSummaries ?? [],
    notes: meta.notes,
  });
}

function inferOsFamily(): 'windows' | 'macos' | 'linux' | 'other' {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'linux') return 'linux';
  return 'other';
}

export function toSanitizedCapability(capability: CapabilityRecord): SanitizedCapability {
  const description = capability.description
    ? redactText(capability.description.slice(0, 280), { emails: true })
    : undefined;
  const safeDescription = description && !containsSecret(description) ? description : undefined;
  return {
    name: capability.name.slice(0, 120),
    category: capability.category,
    description: safeDescription,
    sourceType: capability.sourceType.slice(0, 60),
    verification: capability.verification,
    confidence: capability.confidence,
    version: capability.version?.slice(0, 40),
    license: capability.license?.slice(0, 120),
    securityNotes: capability.securityNotes.map((note) => note.message.slice(0, 200)).slice(0, 4),
  };
}

/* ------------------------------------------------------------------ */

export interface RenderOptions {
  maxRowsPerEnvironment?: number;
}

const VERIFICATION_LEGEND = [
  'Legend: declared = seen in a config file; configured = validated on disk (files/dependencies resolve);',
  'tested = executed by the Master Agent validation pipeline (not used by discovery); failed = a check ran and failed.',
].join('\n');

export function renderAuditMarkdown(audit: AuditResult, options: RenderOptions = {}): string {
  const maxRows = options.maxRowsPerEnvironment ?? 100;
  const lines: string[] = [];
  const homeRoot = sanitizeHomeRootFromPathHint();
  lines.push(`# CSN Capability Audit`, '');
  lines.push(`Generated: ${audit.generatedAt} · wall time: ${audit.wallTimeMs}ms · capabilities: ${audit.summary.capabilities}`, '');
  lines.push(VERIFICATION_LEGEND, '');
  lines.push(`## Summary`, '');
  lines.push('| Category | Count |', '| --- | --- |');
  for (const [category, count] of Object.entries(audit.summary.byCategory).sort()) {
    lines.push(`| ${category} | ${count} |`);
  }
  lines.push('');
  for (const environment of audit.environments) {
    lines.push(`## ${environment.environmentName} (${environment.detected ? 'detected' : 'not detected'})`, '');
    if (environment.configurationPaths.length > 0) {
      lines.push(`Config paths: ${environment.configurationPaths.join(', ')}`, '');
    }
    if (environment.errors.length > 0) {
      lines.push(`Errors:`, ...environment.errors.map((e) => `- ${e}`), '');
    }
    if (environment.capabilities.length > 0) {
      lines.push('| Capability | Category | Verification | Confidence | Notes |', '| --- | --- | --- | --- | --- |');
      for (const capability of environment.capabilities.slice(0, maxRows)) {
        const notes = capability.securityNotes.map((n) => n.message).join('; ');
        lines.push(
          `| ${escapePipe(capability.name)} | ${capability.category} | ${capability.verification} | ${capability.confidence} | ${escapePipe(notes.slice(0, 120))} |`,
        );
      }
      if (environment.capabilities.length > maxRows) {
        lines.push(`… ${environment.capabilities.length - maxRows} more`);
      }
      lines.push('');
    }
    if (environment.limitations.length > 0) {
      lines.push(`Limitations:`, ...environment.limitations.map((l) => `- ${l}`), '');
    }
  }
  lines.push('', `_Paths shown are minimized against ${homeRoot}._`);
  return lines.join('\n');
}

export function renderGapMarkdown(report: GapReport): string {
  const lines: string[] = [];
  lines.push(`# CSN Capability Gap Report`, '');
  lines.push(`Target profile: **${report.targetId}** · local capabilities: ${report.registrySize}`, '');
  lines.push(`Missing: ${report.summary.missing} · Partial: ${report.summary.partial} · Covered: ${report.summary.covered}`, '');
  lines.push('| Status | Desired capability | Category | Reason | Existing matches |', '| --- | --- | --- | --- | --- |');
  for (const gap of report.gaps) {
    lines.push(
      `| ${gap.status} | ${escapePipe(gap.desired.name)} | ${gap.desired.category ?? '—'} | ${escapePipe(gap.reason)} | ${gap.matches.slice(0, 2).join(', ') || '—'} |`,
    );
  }
  lines.push('', '_Detection ≠ execution: coverage claims reflect local registry evidence (configured or better)._');
  return lines.join('\n');
}

export function renderSubmissionPreview(payload: ReportSubmission): string {
  const lines: string[] = [];
  lines.push(`# Submission preview (nothing was sent)`, '');
  lines.push(`Environment: ${payload.environment.type} (${payload.environment.osFamily}) · capabilities: ${payload.capabilities.length}`, '');
  lines.push(`Project summaries included: ${payload.projectSummaries.length}`, '');
  lines.push('```json');
  lines.push(JSON.stringify(payload, null, 2).slice(0, 4000));
  lines.push('```', '');
  lines.push('_This is opt-in only. Sharing stays off until policy.sharing is enabled explicitly._');
  return lines.join('\n');
}

function escapePipe(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' · ');
}

/** Home path (minimized path root) for legend; keeps absolute paths out of reports. */
function sanitizeHomeRootFromPathHint(): string {
  const home = os.homedir();
  return sanitizePath(home, [home]).replace(/\/+$/, '') || '~';
}
