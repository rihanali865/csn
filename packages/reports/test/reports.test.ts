import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import { buildSubmissionPayload, renderAuditMarkdown, renderGapMarkdown, renderSubmissionPreview, toSanitizedCapability } from '../src/index.js';
import type { AuditResult, EnvironmentAudit, CapabilityRecord } from '@csn/core';
import { buildGapReport, backlogProfile } from '@csn/discovery';

const cap = (overrides: Partial<CapabilityRecord> = {}): CapabilityRecord => ({
  id: 'opencode/mcp/demo',
  name: 'demo',
  category: 'mcp-server',
  environment: 'opencode',
  sourceType: 'mcp-config',
  evidence: [],
  verification: 'configured',
  confidence: 0.7,
  securityNotes: [{ severity: 'low', message: 'auth headers present' }],
  lastVerifiedAt: new Date().toISOString(),
  ...overrides,
});

const envAudit = (overrides: Partial<EnvironmentAudit> = {}): EnvironmentAudit => ({
  adapterId: 'opencode',
  environmentName: 'OpenCode',
  detected: true,
  detectionEvidence: [],
  configurationPaths: [],
  capabilities: [cap(), cap({ id: 'x', name: 'review-thing', category: 'skill', description: 'Reviews code with contact admin@example.com' })],
  limitations: [],
  errors: [],
  ...overrides,
});

const audit = (overrides: Partial<AuditResult> = {}): AuditResult => ({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  wallTimeMs: 12,
  environments: [envAudit()],
  summary: { capabilities: 2, byCategory: { 'mcp-server': 1, skill: 1 }, byVerification: { configured: 2 } },
  ...overrides,
});

describe('submission payload building', () => {
  it('produces a schema-valid payload with no paths', () => {
    const payload = buildSubmissionPayload(audit(), { adapterVersion: '0.1.0' });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('sourcePath');
    // WORKS on every OS: homedir() is stable; process.env.USERPROFILE is not.
    expect(serialized).not.toContain(os.homedir());
    expect(payload.capabilities).toHaveLength(2);
    expect(payload.capabilities[0].verification).toBe('configured');
  });

  it('redacts emails and secrets out of descriptions', () => {
    const payload = buildSubmissionPayload(audit(), { adapterVersion: '0.1.0' });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('admin@example.com');
    expect(serialized).toContain('[REDACTED:email]');
  });

  it('drops descriptions that still look secret-bearing after redaction', () => {
    const suspicious = envAudit({ capabilities: [cap({ description: 'use sk-ABCtest11223344556677889900 key here' })] });
    const payload = buildSubmissionPayload(audit({ environments: [suspicious] }), { adapterVersion: '0.0.1' });
    expect(JSON.stringify(payload)).not.toContain('sk-ABCtest');
  });

  it('never fabricates verification: preserves discovered value', () => {
    const declaredOnly = envAudit({ capabilities: [cap({ verification: 'declared', confidence: 0.5 })] });
    const payload = buildSubmissionPayload(audit({ environments: [declaredOnly] }), { adapterVersion: '0.0.1' });
    expect(payload.capabilities[0].verification).toBe('declared');
  });

  it('refuses project summaries unless explicitly passed by caller', () => {
    const payload = buildSubmissionPayload(audit(), { adapterVersion: '0.0.1' });
    expect(payload.projectSummaries).toEqual([]);
  });
});

describe('markdown rendering', () => {
  it('renders audit with legend and env sections', () => {
    const md = renderAuditMarkdown(audit());
    expect(md).toContain('# CSN Capability Audit');
    expect(md).toContain('declared = seen in a config file');
    expect(md).toContain('## OpenCode (detected)');
    expect(md).toContain('demo');
  });

  it('renders detected:false honestly', () => {
    const result = audit({ environments: [envAudit({ detected: false, capabilities: [] })] });
    expect(renderAuditMarkdown(result)).toContain('## OpenCode (not detected)');
  });

  it('renders gap report with reasons', () => {
    const {
      environments,
    } = audit();
    const report = buildGapReport(environments.flatMap((env) => env.capabilities), backlogProfile());
    const md = renderGapMarkdown(report);
    expect(md).toMatch(/Missing: \d+/);
    expect(md).toContain('| Status | Desired capability |');
  });

  it('submission preview states clearly nothing was sent', () => {
    const preview = renderSubmissionPreview(buildSubmissionPayload(audit(), { adapterVersion: '0.0.1' }));
    expect(preview).toContain('nothing was sent');
    expect(preview).toContain('Sharing stays off');
  });
});

describe('toSanitizedCapability', () => {
  it('truncates long name/descriptions to schema bounds', () => {
    const sanitized = toSanitizedCapability(cap({ name: 'x'.repeat(200), description: 'y'.repeat(500) }));
    expect(sanitized.name.length).toBeLessThanOrEqual(120);
    expect(sanitized.description?.length ?? 0).toBeLessThanOrEqual(300);
  });

  it('caps number of security notes to 4', () => {
    const notes = Array.from({ length: 8 }, () => ({ severity: 'low' as const, message: 'note' }));
    const sanitized = toSanitizedCapability(cap({ securityNotes: notes }));
    expect(sanitized.securityNotes.length).toBe(4);
  });
});
