import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { intake, compareWithLocal, submissionHash, type SubmissionEnvelope } from '../src/intake.js';
import { evaluateCandidate } from '../src/evaluate.js';
import { loadStore, saveStore, emptyData } from '../src/store.js';
import { planResearch, applyResearchFindings } from '../src/research.js';
import { buildValidationPlan, runDetachedValidation } from '../src/validation.js';
import { buildProposal } from '../src/proposal.js';
import { proposeCandidate, integrateCandidate, advanceCandidate } from '../src/pipeline.js';
import { DEFAULT_POLICY, type CsnPolicy } from '@csn/policy';

const reportFixture = (over: Record<string, unknown> = {}, capabilityOver: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  environment: { type: 'opencode', adapterVersion: '0.1.0', osFamily: 'windows' },
  capabilities: [
    {
      name: 'browser-guard',
      category: 'browser-automation',
      sourceType: 'mcp-config',
      verification: 'configured',
      confidence: 0.6,
      license: 'MIT',
      securityNotes: [],
      ...capabilityOver,
    },
  ],
  projectSummaries: [],
  ...over,
});

const envelopeFor = (payload: unknown): SubmissionEnvelope => ({
  installationId: 'ins_test0001',
  receivedAt: new Date().toISOString(),
  payload,
});

describe('intake', () => {
  it('accepts a valid report and marks candidates untrusted', () => {
    const result = intake(envelopeFor(reportFixture()), []);
    expect(result.accepted).toBe(1);
    expect(result.newCandidates[0]?.status).toBe('reported');
    expect(result.newCandidates[0]?.untrusted).toBe(true);
    expect(result.newCandidates[0]?.history[0]?.actor).toBe('intake');
  });

  it('rejects schema-violating payloads', () => {
    const bad = { schemaVersion: 9, capabilities: 'everything' };
    const result = intake(envelopeFor(bad), []);
    expect(result.accepted).toBe(0);
    expect(result.rejected[0]).toMatch(/^schema:/);
  });

  it('never stores secret-shaped capability content', () => {
    const sneaky = reportFixture({}, { name: 'helper', securityNotes: ['runs with sk_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'] });
    const result = intake(envelopeFor(sneaky), []);
    expect(result.accepted).toBe(0);
    expect(result.rejected.join('\n')).toMatch(/secret-shaped/i);
  });

  it('deduplicates by name+category slug', () => {
    const payload = reportFixture();
    const first = intake(envelopeFor(payload), []);
    void first;
    const afterFirst: import('../src/intake.js').Candidate[] = first.newCandidates;
    const second = intake(envelopeFor({ ...reportFixture() }), afterFirst);
    expect(second.accepted).toBe(0);
    expect(second.deduplicated).toBe(1);
  });

  it('submissionHash is stable and not empty', () => {
    const payload = reportFixture();
    expect(submissionHash(payload)).toBe(submissionHash(payload));
    expect(submissionHash(payload).length).toBe(24);
  });
});

describe('compareWithLocal', () => {
  const local = [
    { id: 'r1', name: 'Browser Guard', category: 'browser-automation', description: 'guards the browser' },
    { name: 'other', category: 'testing-qa' },
  ];

  it('detects an exact local equivalent case-insensitively', () => {
    const candidate = intake(envelopeFor(reportFixture()), []).newCandidates[0]!;
    expect(compareWithLocal(candidate.capability, local).localStatus).toBe('equivalent-exists');
  });

  it('falls back to complement and gap honestly', () => {
    const named = { name: 'SuperWidget', category: 'browser-automation', description: 'nothing like local', sourceType: 'x' };
    const candidate = intake(envelopeFor(reportFixture({}, named)), []).newCandidates[0]!;
    expect(compareWithLocal(candidate.capability, local).localStatus).toBe('complement');
    const alien = { name: 'AlienKit', category: 'local-model', description: 'from another galaxy', sourceType: 'x' };
    const candidate2 = intake(envelopeFor(reportFixture({}, alien)), []).newCandidates[0]!;
    expect(compareWithLocal(candidate2.capability, local).localStatus).toBe('gap');
  });
});

describe('evaluate', () => {
  it('moves reported candidates to research-pending with explainability', () => {
    const candidate = intake(envelopeFor(reportFixture()), []).newCandidates[0]!;
    const updated = evaluateCandidate(candidate, { local: [] });
    expect(updated.status).toBe('research-pending');
    expect(updated.scoreSummary?.total).toBeGreaterThan(0);
    expect(updated.history.some((h) => h.actor === 'scoring')).toBe(true);
    expect(updated.rationale).toContain('nothing local matches');
  });

  it('blocks on a failed verification claim', () => {
    const candidate = intake(envelopeFor(reportFixture({}, { verification: 'failed' })), []).newCandidates[0]!;
    const updated = evaluateCandidate(candidate, { local: [] });
    expect(updated.scoreSummary?.gates.join('\n')).toMatch(/failed/);
    expect(updated.status).toBe('rejected');
  });
});

describe('store', () => {
  it('round-trips through a sandboxed dir', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'csn-master-store-'));
    const dataDir = path.join(dir, 'store');
    const data = emptyData();
    saveStore(data, { dataDir });
    const loaded = loadStore({ dataDir });
    expect(loaded.candidates).toHaveLength(0);
  });
});

describe('research', () => {
  it('plan derives npm + docs sources with a declared ceiling', () => {
    const candidate = intake(envelopeFor(reportFixture({}, { description: 'see https://example.com/guard for details' })), []).newCandidates[0]!;
    const plan = planResearch(candidate);
    expect(plan.evidenceCeiling).toBe('declared');
    expect(plan.sources.some((s) => s.kind === 'npm-package')).toBe(true);
    expect(plan.sources.some((s) => s.kind === 'docs-url')).toBe(true);
  });

  it('apply keeps declared ceiling and can advance reported → research-pending', () => {
    const candidate = intake(envelopeFor(reportFixture({}, { license: undefined })), []).newCandidates[0]!;
    void candidate.capability.license;
    const result = applyResearchFindings(candidate, { license: 'Apache-2.0', licenseSource: 'repo-license-file', docsVerified: true, docsRef: 'https://example.com' });
    expect(result.changes.join('\n')).toMatch(/Apache-2\.0/);
    expect(result.statusAfter).toBe('research-pending');
    expect(candidate.capability.verification).toBe('configured'); // unchanged: research never upgrades evidence
  });
});

describe('validation plan', () => {
  const enabled: CsnPolicy = {
    ...DEFAULT_POLICY,
    exec: { allow: true, allowedCommandPrefixes: ['node'], timeoutMs: 10_000, maxBufferBytes: 100_000 },
  };

  it('refuses on default (exec-off) policy', () => {
    const candidate = intake(envelopeFor(reportFixture()), []).newCandidates[0]!;
    candidate.status = 'ready-for-detached-testing';
    const plan = buildValidationPlan(candidate, DEFAULT_POLICY, ['node x.js']);
    expect(plan.approved).toBe(false);
    expect(plan.refusal).toMatch(/exec/i);
  });

  it('refuses a status that is not ready for testing', () => {
    const candidate = intake(envelopeFor(reportFixture()), []).newCandidates[0]!;
    const plan = buildValidationPlan(candidate, enabled, ['node x.js']);
    expect(plan.approved).toBe(false);
    expect(plan.refusal).toMatch(/status/);
  });

  it('requires a policy-allowlisted prefix', () => {
    const candidate = intake(envelopeFor(reportFixture()), []).newCandidates[0]!;
    candidate.status = 'ready-for-detached-testing';
    const plan = buildValidationPlan(candidate, enabled, ['powershell -NoProfile -CommandRemove']);
    expect(plan.approved).toBe(false);
    expect(plan.refusal).toMatch(/allowlist/i);
  });

  it('approves only allowlisted commands (research candidate detached validation)', async () => {
    const candidate = intake(envelopeFor(reportFixture()), []).newCandidates[0]!;
    candidate.status = 'ready-for-detached-testing';
    const plan = buildValidationPlan(candidate, enabled, ['node --version']);
    expect(plan.approved).toBe(true);
    const { record } = await runDetachedValidation(plan);
    expect(record.ran).toBe(true);
    expect(record.passed).toBe(true);
    expect(record.command?.join(' ')).toBe('node **redacted-arg**');
  });
});

describe('proposal + integration gates', () => {
  it('refuses proposals before testing passed, and accepts after with status advance', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'csn-master-proposals-'));
    const save = () => undefined;
    void save;
    const candidate = intake(envelopeFor(reportFixture({}, { name: 'Unverified Widget' })), []).newCandidates[0]!;
    const proposal1 = buildProposal(candidate);
    expect(proposal1.canPropose).toBe(false);
    expect(proposal1.markdown).toMatch(/not yet proposable/i);
    void existsSync;

    // simulate validation path: ready → testing-passed
    candidate.status = 'ready-for-detached-testing';
    const result = advanceCandidate(candidate, 'testing-passed', 'validation', 'passed local detached run');
    expect(result.ok).toBe(true);

    dataStoreRoundTrip(candidate, dir);
    const proposal2 = buildProposal(candidate);
    expect(proposal2.canPropose).toBe(true);
    const propose = proposeCandidate(candidate.id, proposal2.markdown, { dataDir: dir });
    expect(propose.ok).toBe(true);
    const accept = integrateCandidate(candidate.id, 'user confirmed', { dataDir: dir });
    expect(accept.ok).toBe(true);
    expect(accept.ok && accept.candidate.status).toBe('integrated-verified');
  });

  function dataStoreRoundTrip(candidate: import('../src/intake.js').Candidate, dir: string): void {
    const data = loadStore({ dataDir: dir });
    data.candidates.push(candidate);
    saveStore(data, { dataDir: dir });
  }
});
