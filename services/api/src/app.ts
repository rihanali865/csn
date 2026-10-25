import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { ReportSubmissionSchema, ScheduledTaskSchema, formatSchemaIssues } from '@csn/core';
import { containsSecret } from '@csn/privacy';
import { InMemoryStore, type ApiStoreApi, type TaskRecord } from './store.js';
import { DEFAULT_SCOPES, TOKEN_SCOPES, bearerToken, hashToken, issueToken } from './auth.js';
import { RateLimiter } from './ratelimit.js';

export interface ApiLimits {
  /** Max submissions per installation per window. */
  submissionsPerHour: number;
  /** Max registration requests per IP per window. */
  registrationsPerHour: number;
  windowMs: number;
}

export const DEFAULT_LIMITS: ApiLimits = {
  submissionsPerHour: 120,
  registrationsPerHour: 30,
  windowMs: 60 * 60 * 1000,
};

export interface CreateAppOptions {
  store?: ApiStoreApi;
  limits?: ApiLimits;
  /** injectable clock (tests); also used to build task windows. */
  now?: () => Date;
}

const API_VERSION = 'csn-api/0.1.0';

function errorBody(code: string, message: string, details?: string[]) {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

function sendError(res: Response, status: number, code: string, message: string, details?: string[]): void {
  res.status(status).json(errorBody(code, message, details));
}

/**
 * Network API application. Order of checks for any authenticated endpoint:
 * bearer header → hash lookup in store → revoked? → scope? → rate limit.
 * The raw Authorization value is never logged and never echoed back.
 */
export function createApiApp(options: CreateAppOptions = {}): Express {
  const store = options.store ?? new InMemoryStore();
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const now = options.now ?? (() => new Date());
  const submissionLimiter = new RateLimiter(limits.submissionsPerHour, limits.windowMs, () => now().getTime());
  const registrationLimiter = new RateLimiter(limits.registrationsPerHour, limits.windowMs, () => now().getTime());

  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next: NextFunction) => {
    res.setHeader('x-csn-api-version', API_VERSION);
    next();
  });
  // Bounded body — reports are path-free summaries; a real report is well under this.
  app.use(express.json({ limit: '256kb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, version: API_VERSION });
  });

  /* ---------------------------------------------------------------- */
  /* Installation registration                                          */
  /* ---------------------------------------------------------------- */

  app.post('/v1/installations', (req, res) => {
    const ipKey = `reg:${req.ip ?? 'unknown'}`;
    if (registrationLimiter.isLimited(ipKey)) {
      return sendError(res, 429, 'rate_limited', 'too many registrations from this address this hour');
    }
    const label = typeof (req.body as { label?: unknown })?.label === 'string' ? String((req.body as { label?: unknown }).label).slice(0, 80) : undefined;
    const at = now().toISOString();
    const installationId = `ins_${randomUUID().slice(0, 12)}`;
    const issued = issueToken(installationId, DEFAULT_SCOPES, at);
    store.data.installations.push({ installationId, label, createdAt: at });
    store.data.tokens.push(issued.token);
    store.save();
    return res.status(201).json({
      installationId,
      created_at: at,
      token: issued.rawToken,
      tokenId: issued.token.tokenId,
      scopes: issued.token.scopes,
      note: 'the token is shown once; store it locally — the server only keeps its sha256',
    });
  });

  /* ---------------------------------------------------------------- */
  /* Auth middleware helper (express-style)                             */
  /* ---------------------------------------------------------------- */

  interface AuthedLocals {
    auth: { installationId: string; tokenId: string; scopes: string[] };
  }

  function authenticate(requiredScope: string) {
    return (req: Request & { locals?: Partial<AuthedLocals> }, res: Response, next: NextFunction) => {
      const header = req.headers.authorization;
      const parsed = bearerToken(typeof header === 'string' ? header : undefined);
      if (!parsed.ok) return sendError(res, 401, parsed.code, parsed.message);
      const tokenHash = hashToken(parsed.raw);
      const record = store.data.tokens.find((t) => t.tokenHash === tokenHash);
      if (!record) return sendError(res, 401, 'invalid_token', 'token not recognized');
      if (record.revokedAt) return sendError(res, 401, 'token_revoked', `token ${record.tokenId} was revoked at ${record.revokedAt}`);
      if (!record.scopes.includes(requiredScope)) {
        return sendError(res, 403, 'insufficient_scope', `token lacks scope '${requiredScope}'`);
      }
      record.lastUsedAt = now().toISOString();
      req.locals = { auth: { installationId: record.installationId, tokenId: record.tokenId, scopes: record.scopes } };
      next();
    };
  }

  function authed(req: Request & { locals?: Partial<AuthedLocals> }): { installationId: string; tokenId: string } {
    const l = req.locals ?? {};
    return { installationId: l.auth?.installationId ?? '', tokenId: l.auth?.tokenId ?? '' };
  }

  /* ---------------------------------------------------------------- */
  /* Token revocation                                                   */
  /* ---------------------------------------------------------------- */

  app.delete('/v1/installations/:installationId/tokens/:tokenId', authenticate(TOKEN_SCOPES.reports), (req, res) => {
    const { installationId, tokenId } = authed(req);
    const params = req.params as { installationId?: string; tokenId?: string };
    if (params.installationId !== installationId) {
      return sendError(res, 403, 'forbidden', 'token does not belong to this installation');
    }
    const target = store.data.tokens.find((t) => t.installationId === installationId && t.tokenId === params.tokenId);
    if (!target) return sendError(res, 404, 'not_found', 'no such token for this installation');
    const wasRevoked = Boolean(target.revokedAt);
    if (!wasRevoked) {
      target.revokedAt = now().toISOString();
      store.save();
    }
    return res.json({ tokenId: target.tokenId, revokedAt: target.revokedAt, alreadyRevoked: wasRevoked });
  });

  /* ---------------------------------------------------------------- */
  /* Report intake                                                      */
  /* ---------------------------------------------------------------- */

  app.post('/v1/reports', authenticate(TOKEN_SCOPES.reports), (req, res) => {
    const { installationId } = authed(req);
    const key = `rep:${installationId}`;
    if (submissionLimiter.isLimited(key)) {
      return res
        .status(429)
        .setHeader('retry-after', String(submissionLimiter.secondsUntilWindowEnd(key)))
        .json(errorBody('rate_limited', 'submission quota exhausted for this hour'));
    }

    const parsed = ReportSubmissionSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'schema', 'payload does not satisfy schema v1', formatSchemaIssues(parsed.error));
    }
    const payload = parsed.data;

    const secretScanTargets = [JSON.stringify(payload.capabilities), JSON.stringify(payload.projectSummaries)].join('\n');
    if (containsSecret(secretScanTargets)) {
      return sendError(res, 422, 'secret_shaped_content', 'refused: capability notes contain a value shaped like a credential; redact on the client first');
    }

    const canonical = JSON.stringify({ installationId, payload });
    const requestHash = createHash('sha256').update(canonical).digest('hex');

    const prior = store.data.reports.find((r) => r.installationId === installationId && r.requestHash === requestHash);
    if (prior) {
      return res.status(200).json({
        submissionId: prior.submissionId,
        receivedAt: prior.receivedAt,
        replay: true,
      });
    }

    const submissionId = `sub_${randomUUID().slice(0, 12)}`;
    const receivedAt = now().toISOString();
    store.data.reports.push({ submissionId, installationId, receivedAt, payload, requestHash });
    store.save();
    return res.status(201).json({
      submissionId,
      receivedAt,
      replay: false,
    });
  });

  /* ---------------------------------------------------------------- */
  /* Scheduled task delivery + ack                                      */
  /* ---------------------------------------------------------------- */

  app.get('/v1/tasks/next', authenticate(TOKEN_SCOPES.tasks), (req, res) => {
    const { installationId } = authed(req);
    const next = store.data.tasks.find((t) => t.installationId === installationId && !t.deliveredAt);
    if (!next) return res.status(204).send();
    next.deliveredAt = now().toISOString();
    store.save();
    return res.json({
      task: ScheduledTaskSchema.parse(next.task),
      deliveredAt: next.deliveredAt,
      ackUrl: `/v1/tasks/${next.task.taskId}/ack`,
    });
  });

  app.post('/v1/tasks/:taskId/ack', authenticate(TOKEN_SCOPES.tasks), (req, res) => {
    const { installationId } = authed(req);
    const params = req.params as { taskId?: string };
    const record = store.data.tasks.find((t) => t.task.taskId === params.taskId && t.installationId === installationId);
    if (!record) return sendError(res, 404, 'not_found', 'no such task for this installation');
    if (!record.deliveredAt) return sendError(res, 409, 'not_delivered', 'acknowledge the task only after it has been delivered to you');
    if (record.ack) {
      return res.status(200).json({ taskId: record.task.taskId, status: record.ack.status, replay: true });
    }
    const body = (req.body ?? {}) as { status?: unknown; note?: unknown };
    const status = body.status;
    if (status !== 'completed' && status !== 'declined' && status !== 'failed') {
      return sendError(res, 400, 'schema', "ack.status must be 'completed' | 'declined' | 'failed'");
    }
    const note = typeof body.note === 'string' ? body.note.slice(0, 400) : undefined;
    record.ack = { status, note, at: now().toISOString() };
    store.save();
    return res.status(200).json({ taskId: record.task.taskId, status, replay: false });
  });

  /* ---------------------------------------------------------------- */
  /* Errors: JSON, bounded, no stack traces to clients                  */
  /* ---------------------------------------------------------------- */

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const isBodyTooLarge = err instanceof Error && /entity\.too\.large/i.test(err.message);
    if (isBodyTooLarge) return sendError(res, 413, 'payload_too_large', 'body exceeds 256kb; reports are summaries, not raw logs');
    if (err instanceof Error && err.message.includes('JSON')) return sendError(res, 400, 'invalid_json', 'request body is not valid JSON');
    console.error('[csn-api] unhandled:', err instanceof Error ? err.message : String(err));
    return sendError(res, 500, 'internal', 'internal error (details are logged server-side only)');
  });

  return app;
}

export { TOKEN_SCOPES };
export type { TaskRecord };
