import { describe, it, expect, afterAll } from 'vitest';
import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDashboardApp } from '../src/server.js';

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../tests/fixtures/environments');
const fixtureHome = path.join(fixturesDir, 'opencode', 'home-oc-user');

const servers: http.Server[] = [];
afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(): Promise<number> {
  const app = createDashboardApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return (server.address() as { port: number }).port;
}

async function call(port: number, method: string, urlPath: string): Promise<{ status: number; text: string; headers: Record<string, string | undefined> }> {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, { method });
  return { status: res.status, text: await res.text(), headers: Object.fromEntries(res.headers.entries()) };
}

describe('csn dashboard', () => {
  it('healthz and home page render with consent-first messaging', async () => {
    process.env.CSN_HOME = fixtureHome;
    const port = await listen();
    const health = await call(port, 'GET', '/healthz');
    expect(health.status).toBe(200);
    expect(JSON.parse(health.text)).toMatchObject({ ok: true, service: 'csn-dashboard' });

    const home = await call(port, 'GET', '/');
    expect(home.status).toBe(200);
    expect(home.text).toContain('capability swarm network');
    expect(home.text).toContain('no scan yet in this session');
    expect(home.headers['content-security-policy']).toContain("script-src 'none'");
    delete process.env.CSN_HOME;
  });

  it('audit action runs only on click and stores the result; preview API answers after', async () => {
    process.env.CSN_HOME = fixtureHome;
    const port = await listen();

    const beforeApi = await call(port, 'GET', '/api/audit');
    expect(beforeApi.status).toBe(404);

    const previewBefore = await call(port, 'GET', '/api/preview-submission');
    expect(previewBefore.status).toBe(404);

    const page = await call(port, 'POST', '/action/audit');
    expect(page.status).toBe(200);
    expect(page.text).toContain('# CSN Capability Audit');
    expect(fs.existsSync(fixtureHome)).toBe(true);

    const api = await call(port, 'GET', '/api/audit');
    expect(api.status).toBe(200);
    const audit = JSON.parse(api.text) as { environments: Array<{ adapterId: string; detected: boolean }> };
    expect(audit.environments.find((e) => e.adapterId === 'opencode')?.detected).toBe(true);

    const preview = await call(port, 'GET', '/api/preview-submission');
    expect(preview.status).toBe(200);
    const withPreview = JSON.parse(preview.text) as { payload: { capabilities: unknown[] } };
    expect(withPreview.payload.capabilities.length).toBeGreaterThan(0);

    const policy = await call(port, 'GET', '/api/policy');
    expect(policy.status).toBe(200);
    expect(JSON.parse(policy.text).policy.sharing.mode).toBe('disabled');
    delete process.env.CSN_HOME;
  });

  it('gap action renders the backlog comparison', async () => {
    process.env.CSN_HOME = fixtureHome;
    const port = await listen();
    const page = await call(port, 'POST', '/action/gaps');
    expect(page.status).toBe(200);
    expect(page.text).toContain('csn-backlog-v1');
    expect(page.text).toContain('Detection ≠ execution');
    delete process.env.CSN_HOME;
  });
});
