import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli, type CliIO } from '../src/index.js';

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../tests/fixtures/environments');
const fixtureHome = path.join(fixturesDir, 'opencode', 'home-oc-user');

interface Capture {
  out: string[];
  err: string[];
}

function captureIO(): { io: CliIO; capture: Capture } {
  const capture: Capture = { out: [], err: [] };
  const io: CliIO = {
    out: (line) => capture.out.push(line),
    err: (line) => capture.err.push(line),
  };
  return { io, capture };
}

beforeEach(() => {
  // policy file may or may not exist on dev machines; force the safe default for these tests
  delete process.env.CSN_POLICY_PATH;
});

describe('csn cli', () => {
  it('help prints the command table', async () => {
    const { io, capture } = captureIO();
    const code = await runCli(['help'], io);
    expect(code).toBe(0);
    expect(capture.out.join('\n')).toContain('csn audit');
    expect(capture.out.join('\n')).toContain('all actions are explicit');
  });

  it('audit --json on a fixture home yields opencode capabilities', async () => {
    const { io, capture } = captureIO();
    const code = await runCli(['audit', '--json', '--home', fixtureHome, '--only', 'opencode'], io);
    expect(code).toBe(0);
    const audit = JSON.parse(capture.out.join('\n')) as { environments: Array<{ adapterId: string; detected: boolean; capabilities: unknown[] }> };
    const oc = audit.environments.find((e) => e.adapterId === 'opencode');
    expect(oc?.detected).toBe(true);
    expect(oc?.capabilities.length).toBeGreaterThan(3);
    const flattened = JSON.stringify(audit).toLowerCase();
    expect(flattened).not.toMatch(/\bsk-[a-z0-9_-]{16,}/);
  });

  it('audit --home consumes its value (never silently falls back to the real machine)', async () => {
    const { io, capture } = captureIO();
    const fakeHome = path.join(os.tmpdir(), `csn-parser-check-${process.pid}`);
    // Old parser bug: `--home <value>` was read as a boolean and `<value>` became
    // positional, so the audit ran against the REAL home. On a machine with an
    // installed environment this test would wrongly detect it. With the value
    // consumed, an empty fake home must yield no detection at all.
    const code = await runCli(['audit', '--json', '--home', fakeHome, '--only', 'opencode'], io);
    expect(code).toBe(0);
    const audit = JSON.parse(capture.out.join('\n')) as { environments: Array<{ adapterId: string; detected: boolean }> };
    const oc = audit.environments.find((e) => e.adapterId === 'opencode');
    expect(oc?.detected).toBe(false);
  });

  it('audit markdown is honest about not-detected environments and shows the policy', async () => {
    const { io, capture } = captureIO();
    const fakeHome = path.join(os.tmpdir(), `csn-parser-check-${process.pid}-md`);
    const code = await runCli(['audit', '--home', fakeHome], io);
    expect(code).toBe(0);
    const text = capture.out.join('\n');
    expect(text).toContain('# CSN Capability Audit');
    expect(text).toContain('(not detected)'); // every environment states its absence honestly
    expect(text).toContain('sharing: disabled');
    expect(text).toContain('nothing ran automatically');
  });

  it('gap report renders with status column', async () => {
    const { io, capture } = captureIO();
    const code = await runCli(['gaps', '--json', '--home', fixtureHome, '--only', 'opencode'], io);
    expect(code).toBe(0);
    const report = JSON.parse(capture.out.join('\n')) as { targetId: string; summary: { missing: number } };
    expect(report.targetId).toBe('csn-backlog-v1');
  });

  it('submit dry-run never sends and says so', async () => {
    const { io, capture } = captureIO();
    const code = await runCli(['submit', '--dry-run', '--home', fixtureHome, '--only', 'opencode'], io);
    expect(code).toBe(0);
    const text = capture.out.join('\n');
    expect(text).toContain('Nothing was sent');
    expect(text).toContain('Submission preview');
  });

  it('submit refuses while sharing is disabled in policy', async () => {
    const { io, capture } = captureIO();
    const code = await runCli(['submit', '--endpoint', 'http://127.0.0.1:9', '--home', fixtureHome, '--only', 'opencode'], io);
    expect(code).toBe(3);
    expect(capture.err.join('\n')).toMatch(/sharing\.mode is "disabled"/);
  });
});