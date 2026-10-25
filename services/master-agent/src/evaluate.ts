import type { ScoreResult, ScoreFactors, GateFinding } from '@csn/core';
import { scoreCandidate, securityGate, licenseGate } from '@csn/core';
import { assertTransition, type CandidateStatus } from '@csn/core';
import type { Candidate } from './intake.js';
import { compareWithLocal } from './intake.js';

/**
 * Stage 2+ — candidate evaluation is EXPLAINABLE (spec §11): factors, gates
 * and the suggested status are all surfaced, and states are only advanced
 * through the legal transition machine. Nothing here can ever integrate a
 * candidate — scoring is advisory by design.
 */
export interface EvaluationContext {
  local: readonly { id?: string; name: string; category: string; description?: string }[];
  /** overrides let an operator correct individual factor values (documented in output) */
  factorsOverride?: Partial<ScoreFactors>;
}

export function defaultFactors(candidate: Candidate): ScoreFactors {
  return {
    evidenceQuality: evidenceQualityFactor(candidate),
    demonstratedFunction: candidate.capability.verification === 'tested' ? 75 : candidate.capability.verification === 'configured' ? 45 : 25,
    relevance: candidate.localStatus === 'gap' ? 80 : candidate.localStatus === 'complement' ? 55 : 30,
    compatibility: 60,
    security: securityFactor(candidate),
    dependencyHealth: candidate.capability.securityNotes.some((n) => /not found on PATH/i.test(n)) ? 25 : 70,
    licensing: candidate.capability.license ? 80 : 35,
    maintenance: 50,
    performanceImpact: 60,
    integrationComplexity: candidate.capability.sourceType.startsWith('mcp') ? 70 : 55,
    testCoverage: candidate.capability.verification === 'tested' ? 70 : 30,
    regressionRisk: 55,
  };
}

function evidenceQualityFactor(candidate: Candidate): number {
  const base = candidate.capability.confidence * 100;
  const corroborations = Math.min(20, candidate.capability.securityNotes.length * 5);
  return Math.max(10, Math.min(95, base - corroborations * 0.4 + corroborationBoost(candidate)));
}

function corroborationBoost(candidate: Candidate): number {
  // reporting installations that corroborate the same capability raise evidence quality
  return candidate.history.length * 4;
}

function securityFactor(candidate: Candidate): number {
  let security = 75;
  for (const note of candidate.capability.securityNotes) {
    if (note.includes('startup') || note.includes('executes')) security -= 25;
    if (note.toLowerCase().includes('suspend') || note.toLowerCase().includes('deny')) security -= 10;
  }
  if (candidate.untrusted) security = Math.min(security, 65);
  return Math.max(0, security);
}

export function evaluateCandidate(candidate: Candidate, context: EvaluationContext): Candidate {
  const comparison = compareWithLocal(candidate.capability, context.local);
  candidate.localStatus = comparison.localStatus;
  candidate.rationale = comparison.rationale;

  const factors = { ...defaultFactors(candidate), ...context.factorsOverride };
  const gates: GateFinding[] = [];
  const securityGateResult = securityGate(factors.security, [
    ...candidate.capability.securityNotes.filter((n) => n.startsWith('executes') || n.includes('startup')).map((n) => n),
  ]);
  if (securityGateResult) gates.push(securityGateResult);
  const licenseGateResult = licenseGate(factors.licensing, candidate.capability.license === undefined);
  if (licenseGateResult) gates.push(licenseGateResult);
  if (candidate.capability.verification === 'failed') {
    gates.push({ gate: 'evidence', level: 'block', reason: 'upstream verification status is failed' });
  }

  const scored = scoreCandidate(factors, gates);
  candidate.scoreSummary = {
    total: scored.total,
    suggestedStatus: scored.suggestedStatus,
    gates: scored.gates.map((gate) => `${gate.level}:${gate.reason}`),
  };

  // Score → status advancement must respect the state machine:
  // reported candidates first move to research-pending, then to the suggestion.
  advanceStatusChain(candidate, scored.suggestedStatus);
  return candidate;
}

function advanceStatusChain(candidate: Candidate, suggested: CandidateStatus): void {
  const pushHistory = (from: CandidateStatus | undefined, to: CandidateStatus, actor: 'scoring', reason: string) => {
    candidate.history.push({ at: new Date().toISOString(), from, to, actor, reason });
  };

  if (candidate.status === suggested) return;

  // Hard gate rejections advance the shortest legal path; everything else
  // advances at most ONE hop per evaluation so research is never skipped.
  if (suggested === 'rejected') {
    if (legalTransitionOrThrow(candidate.status, 'rejected')) {
      pushHistory(candidate.status, 'rejected', 'scoring', `blocked by gates (total ${candidate.scoreSummary?.total})`);
      candidate.status = 'rejected';
      return;
    }
  }

  if (candidate.status === 'reported') {
    pushHistory('reported', 'research-pending', 'scoring', 'evaluation pipeline: research before any deeper status change');
    candidate.status = 'research-pending';
    return;
  }

  if (legalTransitionOrThrow(candidate.status, suggested)) {
    pushHistory(candidate.status, suggested, 'scoring', `suggested by explainable scoring (total ${candidate.scoreSummary?.total}${gatesSuffix(candidate)})`);
    candidate.status = suggested;
  }
}

function legalTransitionOrThrow(from: CandidateStatus, to: CandidateStatus): boolean {
  try {
    assertTransition(from, to, 'scoring');
    return true;
  } catch {
    return false;
  }
}

function gatesSuffix(candidate: Candidate): string {
  const gates = candidate.scoreSummary?.gates ?? [];
  return gates.length > 0 ? `, gates: ${gates.join('; ')}` : '';
}
