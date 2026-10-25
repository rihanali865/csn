import type { Evidence, EvidenceType, VerificationStatus } from './types.js';

/**
 * Deterministic trust arithmetic. Discovery can only ever produce
 * `declared`/`configured`; `tested`/`failed` are reserved for the master
 * agent's validation pipeline. Keeping the rule in one place guarantees
 * that no adapter accidentally overclaims.
 */
const EVIDENCE_WEIGHT: Record<EvidenceType, number> = {
  'executed-check': 0.95,
  'runtime-observed': 0.8,
  'manifest-parse': 0.7,
  'files-on-disk': 0.65,
  'config-entry': 0.5,
  'objective-documentation': 0.4,
};

export function computeConfidence(evidence: readonly Evidence[]): number {
  if (evidence.length === 0) return 0;
  const sorted = [...evidence].map((e) => EVIDENCE_WEIGHT[e.type]).sort((a, b) => b - a);
  let confidence = sorted[0];
  const secondStrong = sorted[1];
  if (secondStrong !== undefined && secondStrong >= 0.5) confidence = Math.min(0.95, confidence + 0.05);
  return Math.round(confidence * 100) / 100;
}

export function verificationFromEvidence(evidence: readonly Evidence[]): VerificationStatus {
  const hasSubstance = evidence.some(
    (e) => e.type === 'manifest-parse' || e.type === 'files-on-disk' || e.type === 'runtime-observed' || e.type === 'executed-check',
  );
  return hasSubstance ? 'configured' : 'declared';
}

export function strongestEvidenceType(evidence: readonly Evidence[]): EvidenceType | null {
  if (evidence.length === 0) return null;
  return [...evidence].sort((a, b) => EVIDENCE_WEIGHT[b.type] - EVIDENCE_WEIGHT[a.type])[0].type;
}
