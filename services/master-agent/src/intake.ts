import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { ReportSubmissionSchema, formatSchemaIssues, type SanitizedCapability } from '@csn/core';
import { CANDIDATE_STATUSES, type CandidateStatus } from '@csn/core';

/* ------------------------------------------------------------------ */
/* Candidate model                                                     */
/* ------------------------------------------------------------------ */

export interface CandidateHistoryEvent {
  at: string;
  from?: CandidateStatus;
  to: CandidateStatus;
  actor: 'intake' | 'scoring' | 'validation' | 'proposal' | 'manual';
  reason: string;
}

export interface ValidationRecord {
  ran: boolean;
  reason?: string;
  passed?: boolean;
  exitCode?: number;
  outputTail?: string;
  durationMs?: number;
  cwdUsed?: string;
  command?: string[];
}

export interface Candidate {
  id: string;
  capability: SanitizedCapability;
  status: CandidateStatus;
  untrusted: boolean;
  installationId: string;
  firstSeen: string;
  lastSeen: string;
  localStatus: 'equivalent-exists' | 'complement' | 'gap';
  rationale: string;
  history: CandidateHistoryEvent[];
  scoreSummary?: { total: number; suggestedStatus: CandidateStatus; gates: string[] };
  validation?: ValidationRecord;
  proposal?: { generatedAt: string; markdown: string };
}

export interface IntakeResult {
  accepted: number;
  rejected: string[];
  newCandidates: Candidate[];
  deduplicated: number;
  issues: string[];
}

/* ------------------------------------------------------------------ */
/* Intake (Stage 1)                                                    */
/* ------------------------------------------------------------------ */

export interface SubmissionEnvelope {
  installationId: string;
  receivedAt: string;
  payload: unknown;
}

export function submissionHash(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 24);
}

function candidateSlug(capability: SanitizedCapability): string {
  return createHash('sha256')
    .update(`${capability.name.toLowerCase()}::${capability.category}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Stage 1 — validate, dedupe and record untrusted candidates with provenance.
 * A submission is never trusted content: every candidate carries
 * `untrusted: true` until the pipeline verifies it.
 */
export function intake(envelope: SubmissionEnvelope, existing: readonly Candidate[]): IntakeResult {
  const issues: string[] = [];
  const rejected: string[] = [];
  const newCandidates: Candidate[] = [];

  const parsed = ReportSubmissionSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    return { accepted: 0, rejected: [`schema: ${formatSchemaIssues(parsed.error).join('; ')}`], newCandidates: [], deduplicated: 0, issues: ['payload rejected at intake (schema)'] };
  }
  const report = parsed.data;
  if (report.capabilities.length === 0) {
    const message = 'report contains no capabilities';
    rejected.push(message);
    issues.push('application error: empty capability list is not a useful report');
  }

  const existingBySlug = new Map(existing.map((candidate) => [candidateSlug(candidate.capability), candidate]));
  let deduplicated = 0;

  for (const capability of report.capabilities) {
    // aggressive content checks: name/description must not carry secret-shaped content
    if (/gh[pousr]_|sk-ant?-|AKIA|Bearer\s+[A-Za-z0-9]/i.test(`${capability.name} ${capability.description ?? ''}`)) {
      rejected.push(`capability '${capability.name}': secret-shaped content in name/description`);
      issues.push('intake refused capability with secret-shaped content');
      continue;
    }
    const slug = candidateSlug(capability);
    const prior = existingBySlug.get(slug);
    if (prior) {
      deduplicated += 1;
      continue;
    }
    const candidate: Candidate = {
      id: `cand_${randomUUID().slice(0, 8)}`,
      capability,
      status: 'reported',
      untrusted: true,
      installationId: envelope.installationId,
      firstSeen: envelope.receivedAt,
      lastSeen: envelope.receivedAt,
      localStatus: 'gap',
      rationale: 'not yet compared with local registry',
      history: [{ at: envelope.receivedAt, to: 'reported', actor: 'intake', reason: `accepted from installation ${envelope.installationId} (hash ${submissionHash(envelope.payload)})` }],
    };
    newCandidates.push(candidate);
    existingBySlug.set(slug, candidate);
  }

  return { accepted: newCandidates.length, rejected, newCandidates, deduplicated, issues };
}

/** Compare one candidate against the local registry (Stage 2 helper). */
export function compareWithLocal(
  capability: SanitizedCapability,
  local: readonly { name: string; category: string; description?: string; id?: string }[],
): { localStatus: 'equivalent-exists' | 'complement' | 'gap'; rationale: string } {
  const wanted = capability.name.toLowerCase().trim();
  for (const record of local) {
    const have = record.name.toLowerCase().trim();
    if (have === wanted) return { localStatus: 'equivalent-exists', rationale: `exact local equivalent exists: ${record.id ?? record.name}` };
    const shared = capability.description && record.description
      ? capability.description.toLowerCase().split(/\W+/).filter((w) => w.length > 4 && record.description?.toLowerCase().includes(w))
      : [];
    if (shared.length >= 2) return { localStatus: 'equivalent-exists', rationale: `local record overlaps (${shared.slice(0, 3).join(', ')})` };
  }
  const categoryMatch = local.some((record) => record.category === capability.category);
  if (categoryMatch) return { localStatus: 'complement', rationale: `same category present locally, but no functional equivalent found for '${capability.name}'` };
  return { localStatus: 'gap', rationale: `nothing local matches this capability or its category (${capability.category})` };
}

export const CANDIDATE_STATUS_LIST = CANDIDATE_STATUSES;
