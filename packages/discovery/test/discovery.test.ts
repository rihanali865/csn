import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAudit, refineAll, refineCategory, flattenAudit, buildGapReport, backlogProfile, uncoveredGaps, diagnoseTask, buildResumePlan } from '@csn/discovery';
import { AdapterRegistry, createOpenCodeAdapter } from '@csn/adapters';
import type { TaskSignal } from '@csn/discovery';

// -------------------------------- classification

describe('semantic classifier', () => {
  it('refines skills to specialized categories from name/description', () => {
    const refined = refineCategory({
      id: 'x', name: 'browser testing', category: 'skill', environment: 'test', sourceType: 'unknown',
      evidence: [], verification: 'declared', confidence: 0.5, securityNotes: [], lastVerifiedAt: new Date().toISOString(),
      description: 'drives a browser via dom automation',
    });
    expect(refined.category).toBe('browser-automation');
  });

  it('leaves non-descriptive caps untouched (avoid false positives)', () => {
    const unchanged = refineCategory({
      id: 'y', name: 'docs-search', category: 'agent', environment: 'test', sourceType: 'unknown',
      evidence: [], verification: 'declared', confidence: 0.5, securityNotes: [], lastVerifiedAt: new Date().toISOString(),
      description: 'Searches project documentation on demand',
    });
    expect(unchanged.category).toBe('agent');
  });

  it('refineAll refines many at once without changing id/verification', () => {
    const base = {
      environment: 't', sourceType: 's', evidence: [], verification: 'declared' as const,
      confidence: 0.4, securityNotes: [], lastVerifiedAt: new Date().toISOString(),
    };
    const [first] = refineAll([
      { id: '1', name: 'computer use helper', category: 'skill', ...base, description: 'desktop control loop' },
      { id: '2', name: 'math tool', category: 'agent', ...base },
    ]);
    expect(first).toBeDefined();
    expect(first?.category).toBe('desktop-automation');
  });
});

// -------------------------------- gap report

const localCap = (id: string, name: string, category: import('@csn/core').CapabilityRecord['category']): import('@csn/core').CapabilityRecord =>
  ({ id, name, category, environment: 'test', sourceType: 't', evidence: [], verification: 'declared', confidence: 0.5, securityNotes: [], lastVerifiedAt: '' });

describe('gap report', () => {
  const registry = [
    localCap('a', 'playwright', 'browser-automation'),
    localCap('b', 'video-editing', 'media-processing'),
  ];

  it('classifies covered/missing precisely', () => {
    const report = buildGapReport(registry, {
      targetId: 'test-profile',
      capabilities: [
        { name: 'playwright' },
        { name: 'speech synthesis', category: 'voice-speech' },
        { name: 'video editing', aliases: ['video editing'] },
      ],
    });
    const byName = Object.fromEntries(report.gaps.map((gap) => [gap.desired.name, gap.status]));
    expect(byName['playwright']).toBe('covered');
    expect(byName['speech synthesis']).toBe('missing');
    expect(byName['video editing']).toBe('covered');
    expect(report.summary).toEqual({ missing: 1, partial: 0, covered: 2 });
  });

  it('uncoveredGaps filters to actionable items', () => {
    const report = buildGapReport(registry, backlogProfile());
    for (const gap of uncoveredGaps(report)) expect(gap.status).not.toBe('covered');
  });

  it('accepts an AuditResult directly', () => {
    const report = buildGapReport(
      {
        environments: [{ capabilities: registry, adapterId: 'x' } as never],
      } as never,
      backlogProfile(),
    );
    expect(report.registrySize).toBe(2);
  });
});

// -------------------------------- audit engine over a synthetic home

describe('audit engine', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'csn-audit-home-'));
    const ocDir = path.join(home, '.config', 'opencode');
    fs.mkdirSync(path.join(ocDir, 'agents'), { recursive: true });
    fs.writeFileSync(
      path.join(ocDir, 'opencode.json'),
      JSON.stringify({ mcp: { demo: { type: 'local', command: ['node', 'x.js'] } } }),
    );
    fs.writeFileSync(path.join(ocDir, 'agents', 'tester.md'), '---\ndescription: Runs checks\nmode: subagent\n---\n');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'claude-opus-5-5' }));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('combines adapters into one summary with per-adapter isolation', async () => {
    const result = await runAudit({ homeRoot: home }, new AdapterRegistry([createOpenCodeAdapter()]));
    expect(result.schemaVersion).toBe(1);
    expect(result.summary.capabilities).toBeGreaterThanOrEqual(2);
    expect(result.environments).toHaveLength(1);
    expect(result.environments[0]?.adapterId).toBe('opencode');
    expect(result.wallTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('environment filter works', async () => {
    const result = await runAudit({ homeRoot: home, environmentFilter: ['claude-code'] }, new AdapterRegistry([createOpenCodeAdapter(), { ...(createOpenCodeAdapter()), id: 'claude-code' } as never]));
    expect(result.environments).toHaveLength(1);
  });

  it('never throws for a broken adapter', async () => {
    const brokenRegistry = new AdapterRegistry([
      {
        id: 'broken',
        name: 'Broken',
        supports: { localAudit: true, sanitizedReporting: false, scheduledWork: false },
        knownLimitations: [],
        audit: () => { throw new Error('boom'); },
      },
    ]);
    const result = await runAudit({ homeRoot: home }, brokenRegistry);
    expect(result.environments[0]?.errors[0]).toBe('boom');
    expect(result.summary.capabilities).toBe(0);
  });

  it('flattenAudit works across envs', async () => {
    const result = await runAudit({ homeRoot: home });
    expect(flattenAudit(result).length).toBeGreaterThanOrEqual(2);
  });
});

// -------------------------------- diagnostics

const makeSignal = (overrides: Partial<TaskSignal> = {}): TaskSignal => ({
  taskId: 't1',
  startedAt: new Date().toISOString(),
  updatedAt: new Date(Date.now() + 60_000).toISOString(),
  toolCalls: [{ name: 'exec', ok: true, at: new Date().toISOString() }],
  retries: 0,
  declaredSuccess: false,
  verificationRan: false,
  ...overrides,
});

describe('task diagnostics', () => {
  it('flags unverified success as suspect', () => {
    const diagnosis = diagnoseTask(makeSignal({ declaredSuccess: true, verificationRan: false }));
    expect(diagnosis.failureClasses).toContain('unverified-success');
    expect(diagnosis.resumable).toBe(false);
    expect(diagnosis.recommendations.join(' ')).toMatch(/suspect/i);
  });

  it('detects missing dependencies from spawn-style errors', () => {
    const diagnosis = diagnoseTask(makeSignal({
      toolCalls: [{ name: 'bash', ok: false, at: new Date().toISOString(), error: 'spawn ffmpeg ENOENT' }],
      declaredSuccess: false,
    }));
    expect(diagnosis.failureClasses).toContain('missing-dependency');
  });

  it('retry saturation is flagged after 3 retries', () => {
    const diagnosis = diagnoseTask(makeSignal({ retries: 4 }));
    expect(diagnosis.failureClasses).toContain('repeated-retry');
  });

  it('resume plan only for resumable tasks with a checkpoint', () => {
    const diagnosis = diagnoseTask(makeSignal({ declaredSuccess: true, verificationRan: true }));
    expect(buildResumePlan(diagnosis, 'cp-1', ['step'])).toBeNull();
    const resumable = diagnoseTask(makeSignal({}));
    const plan = buildResumePlan(resumable, 'cp-7', ['restore state', 'rerun']);
    expect(plan?.checkpoint).toBe('cp-7');
    expect(plan?.steps).toHaveLength(2);
  });

  it('healthy verified success is rewarded with a positive note and is non-resumable', () => {
    const diagnosis = diagnoseTask(makeSignal({ declaredSuccess: true, verificationRan: true }));
    expect(diagnosis.resumable).toBe(false);
    expect(diagnosis.recommendations[0]).toMatch(/healthy/i);
  });
});
