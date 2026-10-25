/**
 * Candidate status machine (spec §11). Every transition is explicit and
 * provenance-carrying; the Master Agent refuses attempts to skip states.
 */
export const CANDIDATE_STATUSES = [
  'reported', // intake accepted, untrusted
  'research-pending',
  'needs-more-evidence',
  'rejected',
  'ready-for-detached-testing',
  'testing-failed',
  'testing-passed',
  'integration-proposed',
  'integrated-verified',
  'rolled-back',
] as const;

export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

const TRANSITIONS: Record<CandidateStatus, CandidateStatus[]> = {
  reported: ['research-pending', 'needs-more-evidence', 'rejected'],
  'research-pending': ['needs-more-evidence', 'rejected', 'ready-for-detached-testing'],
  'needs-more-evidence': ['research-pending', 'rejected', 'reported'],
  rejected: [],
  'ready-for-detached-testing': ['testing-passed', 'testing-failed', 'needs-more-evidence'],
  'testing-failed': ['ready-for-detached-testing', 'rejected', 'needs-more-evidence'],
  'testing-passed': ['integration-proposed', 'needs-more-evidence', 'rejected'],
  'integration-proposed': ['integrated-verified', 'testing-failed', 'rejected'],
  'integrated-verified': ['rolled-back'],
  'rolled-back': [],
};

export function canTransition(from: CandidateStatus, to: CandidateStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: CandidateStatus, to: CandidateStatus, reason: string): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal status transition ${from} -> ${to} (${reason})`);
  }
}
