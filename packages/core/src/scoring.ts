import type { CandidateStatus } from './statuses.js';

/**
 * Explainable candidate scoring (spec §11).
 *
 * Every factor is a normalized 0..100 *favorability* value (100 = best) so
 * that weight math stays direction-consistent; each factor carries a
 * human-readable rationale. Gates can override the numeric verdict — a high
 * score never integrates a candidate by itself.
 */
export interface ScoreFactorKey {
  key: string;
  label: string;
  weight: number;
}

export const DEFAULT_WEIGHTS: Record<FactorKey, number> = {
  evidenceQuality: 0.16,
  demonstratedFunction: 0.16,
  relevance: 0.12,
  compatibility: 0.1,
  security: 0.12,
  dependencyHealth: 0.06,
  licensing: 0.08,
  maintenance: 0.05,
  performanceImpact: 0.04,
  integrationComplexity: 0.04,
  testCoverage: 0.04,
  regressionRisk: 0.03,
};

export type FactorKey =
  | 'evidenceQuality' | 'demonstratedFunction' | 'relevance' | 'compatibility'
  | 'security' | 'dependencyHealth' | 'licensing' | 'maintenance'
  | 'performanceImpact' | 'integrationComplexity' | 'testCoverage' | 'regressionRisk';

export type ScoreFactors = Record<FactorKey, number>;

export interface FactorLabel { label: string; weight: number; }

export const FACTOR_LABELS: Record<FactorKey, FactorLabel> = {
  evidenceQuality: { label: 'Evidence quality', weight: DEFAULT_WEIGHTS.evidenceQuality },
  demonstratedFunction: { label: 'Demonstrated functionality', weight: DEFAULT_WEIGHTS.demonstratedFunction },
  relevance: { label: 'Relevance to this environment', weight: DEFAULT_WEIGHTS.relevance },
  compatibility: { label: 'Compatibility', weight: DEFAULT_WEIGHTS.compatibility },
  security: { label: 'Security posture', weight: DEFAULT_WEIGHTS.security },
  dependencyHealth: { label: 'Dependency health', weight: DEFAULT_WEIGHTS.dependencyHealth },
  licensing: { label: 'Licensing', weight: DEFAULT_WEIGHTS.licensing },
  maintenance: { label: 'Maintenance status', weight: DEFAULT_WEIGHTS.maintenance },
  performanceImpact: { label: 'Performance impact', weight: DEFAULT_WEIGHTS.performanceImpact },
  integrationComplexity: { label: 'Integration complexity (higher = simpler)', weight: DEFAULT_WEIGHTS.integrationComplexity },
  testCoverage: { label: 'Test coverage', weight: DEFAULT_WEIGHTS.testCoverage },
  regressionRisk: { label: 'Regression safety (higher = safer)', weight: DEFAULT_WEIGHTS.regressionRisk },
};

export interface GateFinding {
  gate: 'security' | 'license' | 'policy' | 'evidence';
  level: 'warn' | 'cap' | 'block';
  reason: string;
}

export interface ScoreResult {
  total: number;
  factors: Array<{ key: FactorKey; label: string; weight: number; raw: number; weighted: number; }>;
  gates: GateFinding[];
  /** Scoring is advisory: this is the verdict it *recommends*, gates permitting. */
  suggestedStatus: CandidateStatus;
}

const BANDS = {
  rejected: 42,
  testing: 68,
} as const;

export function scoreCandidate(input: ScoreFactors, gates: GateFinding[] = []): ScoreResult {
  const factors = (Object.keys(DEFAULT_WEIGHTS) as FactorKey[]).map((key) => {
    const raw = clamp(input[key] ?? 0);
    const weight = DEFAULT_WEIGHTS[key];
    return { key, label: FACTOR_LABELS[key].label, weight, raw, weighted: raw * weight };
  });

  const total = Math.round(factors.reduce((sum, f) => sum + f.weighted, 0) * 100) / 100;

  let suggested: CandidateStatus =
    total < BANDS.rejected ? 'rejected' : total < BANDS.testing ? 'needs-more-evidence' : 'ready-for-detached-testing';

  for (const gate of gates) {
    if (gate.level === 'block') {
      suggested = 'rejected';
    } else if (gate.level === 'cap' && suggested !== 'rejected') {
      suggested = 'needs-more-evidence';
    }
  }

  return { total, factors, gates, suggestedStatus: suggested };
}

function clamp(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

/** Convenience gate evaluators used by the master agent intake/evaluation. */
export function securityGate(securityScore: number, findings: readonly string[]): GateFinding | null {
  if (securityScore < 30) {
    return { gate: 'security', level: 'block', reason: `security score ${securityScore} < 30: ${findings[0] ?? 'unresolved security findings'}` };
  }
  if (securityScore < 60) {
    return { gate: 'security', level: 'cap', reason: `security score ${securityScore} below comfortable range` };
  }
  return null;
}

export function licenseGate(licenseScore: number, unknownLicense: boolean): GateFinding | null {
  if (unknownLicense) return { gate: 'license', level: 'cap', reason: 'license could not be determined from available sources' };
  if (licenseScore < 25) return { gate: 'license', level: 'block', reason: `license score ${licenseScore} < 25` };
  return null;
}
