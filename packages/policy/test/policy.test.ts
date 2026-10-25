import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_POLICY, loadPolicy, submissionAllowed, withinAllowedScanScope, projectScanAllowed,
  describePolicy, CsnPolicySchema,
} from '../src/index.js';

describe('default policy is maximally conservative', () => {
  it('sharing, schedule and exec are all disabled by default', () => {
    expect(DEFAULT_POLICY.sharing.mode).toBe('disabled');
    expect(DEFAULT_POLICY.schedule.enabled).toBe(false);
    expect(DEFAULT_POLICY.exec.allow).toBe(false);
    expect(DEFAULT_POLICY.sharing.allowProjectSummaries).toBe(false);
    expect(DEFAULT_POLICY.scan.allowProjectScans).toBe(false);
  });

  it('defaults parse again (idempotent schema)', () => {
    expect(CsnPolicySchema.safeParse(DEFAULT_POLICY).success).toBe(true);
  });
});

describe('submission gating', () => {
  const policy = (mode: 'disabled' | 'manual' | 'scheduled', endpoint?: string, summaries = false) =>
    ({ ...DEFAULT_POLICY, sharing: { mode, allowProjectSummaries: summaries, endpoint } });

  it('disabled mode → never allowed, clear reason', () => {
    expect(submissionAllowed(policy('disabled'))).toEqual({
      allowed: false,
      reason: 'sharing is disabled in policy — reports stay on this machine',
    });
  });

  it('manual without endpoint is refused even if user asked', () => {
    const decision = submissionAllowed(policy('manual'));
    expect(decision.allowed).toBe(false);
  });

  it('manual with endpoint requires explicit endpoint and allows', () => {
    expect(submissionAllowed(policy('manual', 'https://csn.example')).allowed).toBe(true);
  });

  it('summaries never included unless explicitly allowed', () => {
    expect(policy('manual', 'https://x', false).sharing.allowProjectSummaries).toBe(false);
  });
});

describe('scan scope enforcement', () => {
  const home = path.join('C:/', 'Users', 'demo-home');

  it('global env config dir is allowed', () => {
    expect(withinAllowedScanScope(path.join(home, '.config', 'opencode', 'agents'), { ...DEFAULT_POLICY }, home)).toBe(true);
    expect(withinAllowedScanScope(path.join(home, '.claude', 'skills'), { ...DEFAULT_POLICY }, home)).toBe(true);
  });

  it('projects are rejected unless allow-listed in roots or flag on', () => {
    const project = path.join(home, 'work', 'my-app');
    expect(withinAllowedScanScope(project, { ...DEFAULT_POLICY }, home)).toBe(false);
    const withRoot = { ...DEFAULT_POLICY, scan: { ...DEFAULT_POLICY.scan, roots: [project] } };
    expect(withinAllowedScanScope(project, withRoot, home)).toBe(true);
    expect(projectScanAllowed(DEFAULT_POLICY).allowed).toBe(false);
  });

  it('case/separator normalisation prevents bypass tricks', () => {
    const tricky = path.join(home, '.config', 'OpEnCode') + '/../../work/secret';
    expect(withinAllowedScanScope(tricky, { ...DEFAULT_POLICY }, home)).toBe(false);
  });
});

describe('policy loading', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'csn-policy-home-'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('loads user policy from ~/.config/csn/policy.json', () => {
    const dir = path.join(home, '.config', 'csn');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify({ sharing: { mode: 'manual', endpoint: 'https://csn.local' } }));
    const policy = loadPolicy(undefined, home);
    expect(policy.sharing.mode).toBe('manual');
    expect(policy.sharing.endpoint).toBe('https://csn.local');
    expect(policy.version).toBe(1);
  });

  it('broken policy file falls back to defaults (never half-applies)', () => {
    const dir = path.join(home, '.config', 'csn');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'policy.json'), '{ oops ');
    const policy = loadPolicy(undefined, home);
    expect(policy).toEqual(DEFAULT_POLICY);
  });

  it('hostile policy attempting auto-scheduling without endpoint is tamed', () => {
    const dir = path.join(home, '.config', 'csn');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify({ sharing: { mode: 'scheduled' } }));
    const policy = loadPolicy(undefined, home);
    expect(policy.sharing.mode).toBe('manual');
    expect(policy.sharing.endpoint).toBeUndefined();
  });

  it('describePolicy surfaces every control to the user (transparency text)', () => {
    const text = describePolicy(DEFAULT_POLICY);
    expect(text).toContain('sharing: disabled');
    expect(text).toContain('weekly schedule: disabled');
    expect(text).toContain('arbitrary execution: disabled');
  });
});
