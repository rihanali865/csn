import { assertTransition, type CandidateStatus } from '@csn/core';
import type { Candidate } from './intake.js';
import { loadStore, recordAcceptedIntegration, saveStore, type MasterData, type MasterStoreOptions } from './store.js';

/**
 * Operator-controlled status advancement + integration bookkeeping.
 * Every move goes through the core transition machine; a refusal is recorded
 * as a history note instead of silently ignored.
 */

export function advanceCandidate(
  candidate: Candidate,
  to: CandidateStatus,
  actor: Candidate['history'][number]['actor'],
  reason: string,
  after?: (c: Candidate) => void,
): { ok: boolean; error?: string } {
  try {
    assertTransition(candidate.status, to, `${reason} (actor: ${actor})`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
  candidate.history.push({ at: new Date().toISOString(), from: candidate.status, to, actor, reason });
  candidate.status = to;
  after?.(candidate);
  return { ok: true };
}

export function findCandidate(data: MasterData, id: string): Candidate | undefined {
  return data.candidates.find((c) => c.id === id);
}

/** testing-passed -> integration-proposed, attaching the generated markdown. */
export function proposeCandidate(
  id: string,
  markdown: string,
  options: MasterStoreOptions = {},
): { ok: true; candidate: Candidate } | { ok: false; error: string } {
  const data = loadStore(options);
  const candidate = findCandidate(data, id);
  if (!candidate) return { ok: false, error: `no candidate '${id}' in store` };
  const result = advanceCandidate(candidate, 'integration-proposed', 'proposal', 'detached validation passed; proposal document generated for the human gate');
  if (!result.ok) return { ok: false, error: result.error! };
  candidate.proposal = { generatedAt: new Date().toISOString(), markdown };
  saveStore(data, options);
  return { ok: true, candidate };
}

/** integration-proposed -> integrated-verified. Explicit, human-gated ('--confirm'). */
export function integrateCandidate(
  id: string,
  note: string,
  options: MasterStoreOptions = {},
): { ok: true; candidate: Candidate; rollbackNote: string } | { ok: false; error: string } {
  const data = loadStore(options);
  const candidate = findCandidate(data, id);
  if (!candidate) return { ok: false, error: `no candidate '${id}' in store` };
  const result = advanceCandidate(candidate, 'integrated-verified', 'manual', note.trim() || 'operator confirmed integration after reviewing the proposal');
  if (!result.ok) return { ok: false, error: result.error! };
  saveStore(data, options);
  recordAcceptedIntegration(
    id,
    `integrated at status '${candidate.status}'; rollback path stays open (integrated-verified -> rolled-back)`,
    options,
  );
  return { ok: true, candidate, rollbackNote: 'rollback path stays open: integrated-verified -> rolled-back' };
}

export function rollbackCandidate(
  id: string,
  note: string,
  options: MasterStoreOptions = {},
): { ok: true; candidate: Candidate } | { ok: false; error: string } {
  const data = loadStore(options);
  const candidate = findCandidate(data, id);
  if (!candidate) return { ok: false, error: `no candidate '${id}' in store` };
  const result = advanceCandidate(candidate, 'rolled-back', 'manual', note.trim() || 'operator rolled back');
  if (!result.ok) return { ok: false, error: result.error! };
  saveStore(data, options);
  return { ok: true, candidate };
}
