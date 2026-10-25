import type { Candidate } from './intake.js';

/**
 * Research stage — gather *declared* information about an untrusted candidate
 * from public surfaces (docs pages, package registries, license fields).
 * Research NEVER upgrades evidence strength: the strongest verification it can
 * justify is 'declared' with sources recorded. A claimed report is still just
 * a report; only local execution/promotion paths move status honestly.
 */

export interface ResearchSource {
  kind: 'npm-package' | 'docs-url' | 'local-folder' | 'none';
  reference: string;
  note: string;
}

export interface ResearchChecklist {
  candidateId: string;
  sources: ResearchSource[];
  checks: string[];
  /** Cap the evidence ceiling of this stage, message included in reports. */
  evidenceCeiling: 'declared';
}

export interface ResearchFindings {
  license?: string;
  /** findings must cite where they came from — research without provenance is discarded. */
  licenseSource?: 'npm-readme' | 'repo-license-file' | 'docs-page';
  docsVerified?: boolean;
  docsRef?: string;
}

const NPM_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const URL_RE = /https?:\/\/[^\s"'`()[\]]+/g;

export function planResearch(candidate: Candidate): ResearchChecklist {
  const name = candidate.capability.name.trim();
  const description = candidate.capability.description ?? '';
  const sources: ResearchSource[] = [];

  if (NPM_NAME_RE.test(name)) {
    const reference = `npm registry page for '${name}' (registry.npmjs.org/${name})`;
    sources.push({ kind: 'npm-package', reference, note: 'confirm the package exists, has a license, and the description matches the report' });
  } else {
    sources.push({ kind: 'none', reference: name, note: "name is not a plain package name — confirm manually what this capability claims to be (' ' prefixed names and sentences are excluded from npm lookup)" });
  }

  const urls = (description.match(URL_RE) ?? []).slice(0, 3);
  for (const url of urls) {
    sources.push({ kind: 'docs-url', reference: url, note: 'verify the remote page states what the report claims; never paste page secrets into the store' });
  }

  const checks: string[] = [
    'license: fill from an authoritative source; candidates without any license must stay blocked at intake→evaluation gates',
    'existence: npm/docs/local refs resolved? a capability nobody can find is a reject candidate',
    'claims parity: report description vs upstream docs — mismatches lower trust',
    'security notes: restate any red flags in your own words; attachments/patches must never be opened',
  ];

  return { candidateId: candidate.id, sources, checks, evidenceCeiling: 'declared' };
}

function pushHistory(candidate: Candidate, reason: string): void {
  candidate.history.push({
    at: new Date().toISOString(),
    from: candidate.status,
    to: candidate.status,
    actor: 'manual',
    reason,
  });
}

/**
 * Apply manually-verified research findings. Reported→research-pending stays
 * 'needs-more-evidence' unless ALL minimum fields land (license + at least one
 * verified doc/source). Where transition is illegal the candidate stays put —
 * the status machine, not the operator, decides.
 */
export function applyResearchFindings(candidate: Candidate, findings: ResearchFindings): { statusAfter: Candidate['status']; changes: string[] } {
  const changes: string[] = [];
  if (findings.license && findings.licenseSource) {
    candidate.capability.license = findings.license.slice(0, 120);
    changes.push(`license set to '${findings.license}' (source: ${findings.licenseSource})`);
  }
  if (findings.docsVerified) {
    changes.push(`documented at ${findings.docsRef ?? '(reference omitted)'} — claims declared, not executed`);
  }

  const enough =
    changes.length >= 2 &&
    candidate.capability.license !== undefined;

  if (enough && candidate.status === 'reported') {
    candidate.status = 'research-pending';
    candidate.history.push({
      at: new Date().toISOString(),
      from: 'reported',
      to: 'research-pending',
      actor: 'manual',
      reason: 'research findings accepted (declared-level only)',
    });
  } else if (!enough) {
    pushHistory(candidate, `research applied but insufficient for status advance (${changes.length} change(s); needs license + at least one verified claim)`);
  }

  return { statusAfter: candidate.status, changes };
}
