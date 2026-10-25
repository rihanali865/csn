/**
 * Phase-6 cross-package integration: the entire consented loop on one fixture
 * machine — audit (discovery+adapters) → submission payload (reports) → network
 * API intake (register/submit/replay-verify) → master agent intake & evaluation
 * → status machine outcomes. Asserts the evidence-honesty invariants end-to-end.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { AdapterRegistry, getBuiltinAdapters } from '@csn/adapters';
import { runAudit } from '@csn/discovery';
import { buildSubmissionPayload } from '@csn/reports';
import { DEFAULT_POLICY, type CsnPolicy } from '@csn/policy';
import { createApiApp, InMemoryStore, issueToken } from '@csn/api';
import { isSecretFilename, minimizePath } from '@csn/privacy';
import { intake, evaluateCandidate, type SubmissionEnvelope, type Candidate } from '@csn/master-agent';

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/environments');
const fixtureHome = path.join(fixturesDir, 'opencode', 'home-oc-user');

describe('end-to-end: fixture machine → sanitized report → api → master agent', () => {
  it('audit→submission→api round trip never leaks a home path and replays idempotently', async () => {
    // 1) local audit (read-only, fixture home)
    const audit = await runAudit({ homeRoot: fixtureHome }, new AdapterRegistry(getBuiltinAdapters()));
    expect(audit.environments.find((e) => e.adapterId === 'opencode')?.detected).toBe(true);

    // 2) sanitized submission
    const payload = buildSubmissionPayload(audit, { adapterVersion: 'csn-integration/0.1.0' });
    const serialized = JSON.stringify(payload).toLowerCase();
    expect(serialized).not.toContain('home-oc-user');
    expect(serialized).not.toMatch(/\bsk-[a-z0-9_-]{16,}/);
    expect(serialized).not.toMatch(/\bgh[pousr]_[a-z0-9]{20,}\b/);
    // denial at source: no secret-named file ever reached the payload
    for (const env of audit.environments) {
      for (const record of env.capabilities) {
        const originalSource = record.sourcePath ?? '';
        if (originalSource) expect(isSecretFilename(originalSource)).toBe(false);
      }
    }

    // 3) network api: register → submit → replay
    const app = createApiApp({ store: new InMemoryStore(), limits: { submissionsPerHour: 120, registrationsPerHour: 30, windowMs: 3600_000 } });
    const server = (await import('node:http')).createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const reg = await fetch(`http://127.0.0.1:${port}/v1/installations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(reg.status).toBe(201);
      const { token } = (await reg.json()) as { token: string };

      const submit = await fetch(`http://127.0.0.1:${port}/v1/reports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      expect(submit.status).toBe(201);
      const first = (await submit.json()) as { submissionId: string; replay: boolean };
      expect(first.replay).toBe(false);

      const resubmit = await fetch(`http://127.0.0.1:${port}/v1/reports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      expect(resubmit.status).toBe(200);
      expect(((await resubmit.json()) as { replay: boolean; submissionId: string })).toMatchObject({ replay: true, submissionId: first.submissionId });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('master intake accepts the api-sanitized payload and the state machine stays honest', async () => {
    const audit = await runAudit({ homeRoot: fixtureHome }, new AdapterRegistry(getBuiltinAdapters()));
    const payload = buildSubmissionPayload(audit, { adapterVersion: 'csn-integration/0.1.0' });

    const envelope: SubmissionEnvelope = {
      installationId: 'ins_roundtrip00',
      receivedAt: new Date().toISOString(),
      payload,
    };
    const intakeResult = intake(envelope, []);
    expect(intakeResult.accepted).toBeGreaterThan(0);
    expect(intakeResult.rejected).toHaveLength(0);
    for (const candidate of intakeResult.newCandidates) {
      expect(candidate.untrusted).toBe(true);
      expect(candidate.status).toBe('reported');
      // candidates only ever carry sanitized shapes
      expect(Object.keys(candidate.capability)).not.toContain('sourcePath');
      expect(Object.keys(candidate.capability)).not.toContain('evidence');
    }

    // evaluation without a local registry: gaps explained, statuses single-hop
    const updated: Candidate[] = intakeResult.newCandidates.map((candidate) => evaluateCandidate(candidate, { local: [] }));
    for (const candidate of updated) {
      expect(['research-pending', 'rejected', 'needs-more-evidence']).toContain(candidate.status);
      expect(candidate.history.some((h) => h.actor === 'scoring')).toBe(true);
      // research-first invariant: reported candidates may not hop straight to a deep state
      expect(candidate.status).not.toBe('ready-for-detached-testing');
    }
  });

  it('policy defaults block sharing end-to-end (no accidental egress is even possible)', () => {
    const policy: CsnPolicy = DEFAULT_POLICY;
    expect(policy.sharing.mode).toBe('disabled');
    expect(policy.scan.allowProjectScans).toBe(false);
    expect(policy.exec.allow).toBe(false);
    expect(policy.schedule.enabled).toBe(false);
    // minimizePath never produces an absolute path for anything under home
    const home = os.homedir();
    const inside = path.join(home, '.config', 'opencode', 'skills', 'x', 'SKILL.md');
    expect(minimizePath(inside, [home]).startsWith('~/')).toBe(true);
    // and a file CSN refuses by name pattern can never enter a payload
    expect(isSecretFilename(path.join(home, 'leaked.env'))).toBe(true);
  });

  it('issueToken scope defaults cover exactly the two network surfaces', () => {
    const issued = issueToken('ins_scopetest');
    expect(issued.token.scopes.sort()).toEqual(['report:submit', 'task:ack']);
    expect(issued.rawToken.startsWith('csn_')).toBe(true);
    expect(issued.token.tokenHash.length).toBe(64);
  });
});
