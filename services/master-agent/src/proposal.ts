import type { Candidate } from './intake.js';
import { canTransition, type CandidateStatus } from '@csn/core';

/**
 * Integration proposal generator. A proposal is a *document for a human
 * operator*: it lays out claims, counter-evidence, gates, and the exact
 * integration/rollback steps. It never asserts a capability "works" — only
 * what has been locally demonstrated, and it says so explicitly.
 */

export interface ProposalContext {
  /** local registry facts (from a local audit), used as the complement/gap rationale */
  localCapabilityCount?: number;
  operatorName?: string;
}

function checklistTitle(status: CandidateStatus): string {
  switch (status) {
    case 'testing-passed':
      return '## Proposed next step: create an integration proposal decision';
    case 'integration-proposed':
      return '## Awaiting the human gate: accept or reject this integration';
    case 'testing-failed':
      return '## Blocked: validation failed — do not integrate';
    case 'rejected':
      return '## Blocked: candidate is rejected';
    case 'integrated-verified':
      return '## Already integrated (verified) — rollback remains available';
    default:
      return '## Not yet a proposal — status remains in the pre-testing pipeline';
  }
}

export function buildProposal(candidate: Candidate, context: ProposalContext = {}): { canPropose: boolean; reason?: string; markdown: string } {
  const lines: string[] = [];
  const at = new Date().toISOString();
  const cap = candidate.capability;

  lines.push(`# CSN Integration Proposal — ${cap.name}`, '');
  lines.push(`*Generated ${at} by the CSN Master Agent for ${context.operatorName ?? 'the operator'}.*`, '');

  if (candidate.status !== 'testing-passed' && candidate.status !== 'integration-proposed') {
    lines.push(checklistTitle(candidate.status), '');
    lines.push(`> candidate status: **${candidate.status}** — proposals are generated only after local validation passed.`, '');
  }

  lines.push('## What is being proposed', '');
  lines.push(`| Field | Value |`, '| --- | --- |');
  lines.push(`| capability | ${cap.name} |`);
  lines.push(`| category | ${cap.category} |`);
  lines.push(`| source install | ${candidate.installationId} (community report, untrusted input) |`);
  lines.push(`| license | ${cap.license ?? '**none stated — stays gate-blocked**'} |`);
  lines.push(`| version | ${cap.version ?? 'unspecified'} |`);
  lines.push(`| upstream verification | ${cap.verification} (what the *report* claimed) |`);
  lines.push(`| upstream confidence | ${(cap.confidence * 100).toFixed(0)}% |`, '');

  lines.push('## What was locally done so far', '');
  lines.push(`- local comparison: **${candidate.localStatus}** — ${candidate.rationale}`);
  lines.push(`- scoring: total **${candidate.scoreSummary?.total ?? 'n/a'}**, suggested status **${candidate.scoreSummary?.suggestedStatus ?? 'n/a'}**`);
  for (const gate of candidate.scoreSummary?.gates ?? []) lines.push(`- gate finding: ${gate}`);
  const v = candidate.validation;
  lines.push(
    v?.ran
      ? `- detached validation: **${v.passed ? 'passed' : 'failed'}** (exit ${v.exitCode ?? 'n/a'}, ${v.durationMs}ms, cwd ${v.cwdUsed})`
      : `- detached validation: not run${v?.reason ? ` — reason: ${v.reason}` : ''}`,
    '',
  );

  lines.push(checklistTitle(candidate.status), '');
  lines.push(`- current status: **${candidate.status}**`);
  lines.push(`- transition from here to 'integration-proposed': ${canTransition(candidate.status, 'integration-proposed') ? 'legal' : '*illegal* — run validation or resolve gates first'}`, '');

  lines.push('## Proposal record', '');
  lines.push('```json');
  lines.push(JSON.stringify({ id: candidate.id, name: cap.name, localStatus: candidate.localStatus, status: candidate.status }, null, 2));
  lines.push('```', '');

  lines.push('## What this document is NOT', '');
  lines.push('- it is **not proof** that a capability works — a passing record is evidence, never proven functionality;');
  lines.push('- nothing here was executed against a user\'s machine without the consent gates recorded in the candidate history;');
  lines.push('- community report values (verification/confidence) are self-claims until this environment reproduces them.', '');

  const canPropose = candidate.status === 'testing-passed' || candidate.status === 'integration-proposed';
  if (!canPropose) {
    lines.push(`## Reason this is not yet proposable`, '');
    lines.push(`status must be 'testing-passed' (or already 'integration-proposed'); today it is '${candidate.status}'. Run the detached validation stage after the testing gates.`, '');
  }

  lines.push('## Include a local audit summary', '');
  lines.push(context.localCapabilityCount !== undefined ? `Local registry size: ${context.localCapabilityCount} capabilities.` : 'No local audit was referenced for this proposal.', '');

  const markdown = lines.join('\n');
  return { canPropose, reason: canPropose ? undefined : `status is '${candidate.status}'`, markdown };
}
