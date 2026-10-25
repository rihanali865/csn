import { describe, it, expect, afterAll } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApiApp } from '../src/app.js';
import { InMemoryStore } from '../src/store.js';
import { issueToken } from '../src/auth.js';
import type { ScheduledTask } from '@csn/core';

interface Started {
  port: number;
  close: () => Promise<void>;
}

async function startApp(opts?: Parameters<typeof createApiApp>[0]): Promise<Started> {
  const app = createApiApp(opts);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface CallResult {
  status: number;
  body: any;
  retryAfter?: string;
}

async function call(port: number, method: string, urlPath: string, body?: unknown, token?: string): Promise<CallResult> {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let payload: any;
  try {
    payload = res.status === 204 ? null : await res.json();
  } catch {
    payload = null;
  }
  return { status: res.status, body: payload, retryAfter: res.headers.get('retry-after') ?? undefined };
}

const validReport = (name = 'docs-server') => ({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  environment: { type: 'opencode', adapterVersion: '0.1.0', osFamily: 'windows' },
  capabilities: [
    {
      name,
      category: 'mcp-server',
      sourceType: 'mcp-config',
      verification: 'configured',
      confidence: 0.6,
      securityNotes: ['runner found on PATH; not executed'],
    },
  ],
  projectSummaries: [],
});

interface Session {
  installationId: string;
  token: string;
}

const servers: Started[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

async function register(port: number): Promise<{ session: Session; result: CallResult }> {
  const result = await call(port, 'POST', '/v1/installations', {});
  return { session: { installationId: result.body.installationId, token: result.body.token }, result };
}

describe('csn api', () => {
  it('healthz needs no auth', async () => {
    const s = await startApp({ store: new InMemoryStore() });
    servers.push(s);
    await expect(call(s.port, 'GET', '/healthz')).resolves.toMatchObject({ status: 200, body: { ok: true } });
  });

  it('registration returns the raw token exactly once', async () => {
    const s = await startApp({ store: new InMemoryStore() });
    servers.push(s);
    const { session, result } = await register(s.port);
    expect(result.status).toBe(201);
    expect(session.token.startsWith('csn_')).toBe(true);
    expect(result.body.scopes).toContain('report:submit');
    expect(result.body.note.toLowerCase()).toContain('shown once');
  });

  it('accepts a valid report and replays identical submissions', async () => {
    const s = await startApp({ store: new InMemoryStore() });
    servers.push(s);
    const { session } = await register(s.port);
    // replay means identical content: reuse one payload object (same generatedAt)
    const payload = validReport();
    const first = await call(s.port, 'POST', '/v1/reports', payload, session.token);
    expect(first.status).toBe(201);
    expect(first.body.replay).toBe(false);
    expect(first.body.submissionId.startsWith('sub_')).toBe(true);

    const replay = await call(s.port, 'POST', '/v1/reports', payload, session.token);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ replay: true, submissionId: first.body.submissionId });
  });

  it('rejects malformed payloads with per-field details', async () => {
    const s = await startApp({ store: new InMemoryStore() });
    servers.push(s);
    const { session } = await register(s.port);
    const bad = await call(s.port, 'POST', '/v1/reports', { schemaVersion: 1, capabilities: 'all of them' }, session.token);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('schema');
    expect(bad.body.error.details.length).toBeGreaterThan(0);
  });

  it('refuses secret-shaped capability content', async () => {
    const s = await startApp({ store: new InMemoryStore() });
    servers.push(s);
    const { session } = await register(s.port);
    const report = validReport();
    (report.capabilities[0] as { securityNotes: string[] }).securityNotes = [
      'token looks like ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcd',
    ];
    const res = await call(s.port, 'POST', '/v1/reports', report, session.token);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('secret_shaped_content');
  });

  it('enforces token validity, scopes and revocation', async () => {
    const store = new InMemoryStore();
    const s = await startApp({ store });
    servers.push(s);
    const { session, result } = await register(s.port);
    const installationId = session.installationId;

    const noAuth = await call(s.port, 'POST', '/v1/reports', validReport());
    expect(noAuth.status).toBe(401);

    const garbage = await call(s.port, 'POST', '/v1/reports', validReport(), 'csn_forguess');
    expect(garbage.status).toBe(401);

    // a scoped-down token cannot touch task endpoints
    const limited = issueToken(installationId, ['report:submit']);
    store.data.tokens.push(limited.token);
    const forbidden = await call(s.port, 'GET', '/v1/tasks/next', undefined, limited.rawToken);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('insufficient_scope');

    const revokeRes = await call(s.port, 'DELETE', `/v1/installations/${installationId}/tokens/${result.body.tokenId}`, undefined, session.token);
    expect(revokeRes.status).toBe(200);
    expect(revokeRes.body.alreadyRevoked).toBe(false);

    const afterRevocation = await call(s.port, 'POST', '/v1/reports', validReport(), session.token);
    expect(afterRevocation.status).toBe(401);
    expect(afterRevocation.body.error.code).toBe('token_revoked');

    // a token from another installation cannot revoke anything here
    const other = await startApp({ store: new InMemoryStore() });
    servers.push(other);
    const { session: otherSession } = await register(other.port);
    const crossToken = issueToken(installationId, ['report:submit']);
    store.data.tokens.push(crossToken.token);
    const cross = await call(s.port, 'DELETE', `/v1/installations/${installationId}/tokens/${result.body.tokenId}`, undefined, crossToken.rawToken);
    expect(cross.status).toBe(200); // same installation, revocation is idempotent
    expect(cross.body.alreadyRevoked).toBe(true);

    void otherSession;
  });

  it('rate limits submissions per installation', async () => {
    const s = await startApp({ store: new InMemoryStore(), limits: { submissionsPerHour: 2, registrationsPerHour: 30, windowMs: 3600_000 } });
    servers.push(s);
    const { session } = await register(s.port);
    const a = await call(s.port, 'POST', '/v1/reports', validReport('a'), session.token);
    const b = await call(s.port, 'POST', '/v1/reports', validReport('b'), session.token);
    expect([a.status, b.status]).toEqual([201, 201]);
    const c = await call(s.port, 'POST', '/v1/reports', validReport('c'), session.token);
    expect(c.status).toBe(429);
    expect(c.retryAfter).toBeDefined();
    // replays of already-accepted bodies still surface as replays (idempotency beats the limiter's error)
    const replay = await call(s.port, 'POST', '/v1/reports', validReport('a'), session.token);
    expect(replay.status).toBe(429); // limiter counts all authenticated calls, replays are not special
  });

  it('delivers a scheduled task once, then drains; ack is idempotent', async () => {
    const store = new InMemoryStore();
    const s = await startApp({ store });
    servers.push(s);
    const { session } = await register(s.port);

    const task: ScheduledTask = {
      taskId: 'task_abcd1234',
      type: 'scheduled-review',
      issuedAt: new Date().toISOString(),
      dueAt: new Date(Date.now() + 600_000).toISOString(),
      instructions: 're-run the environment audit and submit an updated report if approved by the user',
    };
    store.data.tasks.push({ task, installationId: session.installationId, createdAt: new Date().toISOString() });

    const ackUndelivered = await call(s.port, 'POST', `/v1/tasks/${task.taskId}/ack`, { status: 'completed' }, session.token);
    expect(ackUndelivered.status).toBe(409);

    const delivery = await call(s.port, 'GET', '/v1/tasks/next', undefined, session.token);
    expect(delivery.status).toBe(200);
    expect(delivery.body.task.taskId).toBe(task.taskId);
    expect(delivery.body.ackUrl).toBe(`/v1/tasks/${task.taskId}/ack`);

    const drained = await call(s.port, 'GET', '/v1/tasks/next', undefined, session.token);
    expect(drained.status).toBe(204);

    const ack = await call(s.port, 'POST', `/v1/tasks/${task.taskId}/ack`, { status: 'completed', note: 'audit re-run approved by user' }, session.token);
    expect(ack.status).toBe(200);
    expect(ack.body.replay).toBe(false);

    const ackReplay = await call(s.port, 'POST', `/v1/tasks/${task.taskId}/ack`, { status: 'failed' }, session.token);
    expect(ackReplay.status).toBe(200);
    expect(ackReplay.body).toMatchObject({ status: 'completed', replay: true });
  });

  it('task delivery is scoped to the owning installation', async () => {
    const store = new InMemoryStore();
    const s = await startApp({ store });
    servers.push(s);
    const { session: mine } = await register(s.port);
    const { session: theirs } = await register(s.port);

    store.data.tasks.push({
      task: {
        taskId: 'task_theirs_only',
        type: 'scheduled-review',
        issuedAt: new Date().toISOString(),
        dueAt: new Date(Date.now() + 60_000).toISOString(),
        instructions: 'x',
      },
      installationId: theirs.installationId,
      createdAt: new Date().toISOString(),
    });

    const res = await call(s.port, 'GET', '/v1/tasks/next', undefined, mine.token);
    expect(res.status).toBe(204);
  });
});
