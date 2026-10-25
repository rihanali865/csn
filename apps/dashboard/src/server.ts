import * as process from 'node:process';
import * as os from 'node:os';
import express, { type Request, type Response } from 'express';
import { AdapterRegistry, getBuiltinAdapters } from '@csn/adapters';
import { runAudit, buildGapReport, backlogProfile, type GapReport } from '@csn/discovery';
import { type AuditResult } from '@csn/core';
import { loadPolicy, describePolicy } from '@csn/policy';
import { buildSubmissionPayload, renderAuditMarkdown, renderGapMarkdown } from '@csn/reports';
import { renderHtml } from './render.js';

/**
 * Local dashboard — dark UI, teal accent (matches the design reference in the
 * desktop demo). Runs ONLY on 127.0.0.1 and ONLY probes environments when the
 * user clicks a button in the UI. No timers, no background scans, no uploads.
 */

export interface DashboardOptions {
  port?: number;
  host?: string;
}

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface DashboardState {
  lastAudit?: { at: string; result: AuditResult; markdown: string };
  lastGap?: { at: string; report: GapReport; markdown: string };
}

export function createDashboardApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  const state: DashboardState = {};

  app.use((_req, res, next) => {
    res.setHeader('content-security-policy', "default-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; script-src 'none'");
    res.setHeader('referrer-policy', 'no-referrer');
    next();
  });
  app.use(express.json({ limit: '64kb' }));

  const homeRoot = process.env.CSN_HOME ?? os.homedir();
  const runLocalAudit = async (): Promise<AuditResult> =>
    runAudit({ homeRoot }, new AdapterRegistry(getBuiltinAdapters()));

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ ok: true, service: 'csn-dashboard' });
  });

  app.get('/', (_req, res) => {
    res.type('html').send(
      renderHtml({
        title: 'CSN dashboard',
        sections: [],
        navHint: 'Audits and gap reports run only when you press a button — no background scans, ever.',
        state,
      }),
    );
  });

  app.post('/action/audit', async (_req, res) => {
    try {
      const result = await runLocalAudit();
      const markdown = renderAuditMarkdown(result, { homeRoot: process.env.CSN_HOME ?? os.homedir() });
      state.lastAudit = { at: new Date().toISOString(), result, markdown };
      res.type('html').send(renderHtml({ title: 'CSN audit', sections: [{ title: 'Capability audit (read-only scan, done just now)', bodyHtml: `<pre id="audit-md">${escapeHtml(markdown)}</pre>` }], navHint: 'This scan just finished — on your click only. Nothing went to the network.', state }));
    } catch (err) {
      res.type('html').status(500).send(renderHtml({ title: 'CSN audit failed', sections: [{ title: 'Error', bodyHtml: `<pre>${escapeHtml(err instanceof Error ? err.message : String(err))}</pre>` }], navHint: 'Debug help: the error text is above.', state }));
    }
  });

  app.post('/action/gaps', async (_req, res) => {
    try {
      const audit = await runLocalAudit();
      const report = buildGapReport(audit, backlogProfile());
      state.lastGap = { at: new Date().toISOString(), report, markdown: renderGapMarkdown(report) };
      res.type('html').send(
        renderHtml({
          title: 'CSN gap report',
          sections: [{ title: `Capability gaps vs backlog profile (${report.targetId})`, bodyHtml: `<pre>${escapeHtml(state.lastGap.markdown)}</pre>` }],
          navHint: 'Gaps are measured against the built-in backlog profile. Remember: detection ≠ execution.',
          state,
        }),
      );
    } catch (err) {
      res.type('html').status(500).send(renderHtml({ title: 'CSN gap report failed', sections: [{ title: 'Error', bodyHtml: `<pre>${escapeHtml(err instanceof Error ? err.message : String(err))}</pre>` }], navHint: 'Debug help: the error text is above.', state }));
    }
  });

  app.get('/api/policy', (_req, res) => {
    res.json({ policy: loadPolicy(), described: describePolicy(loadPolicy()) });
  });

  app.get('/api/audit', (_req, res) => {
    if (!state.lastAudit) return res.status(404).json({ error: { code: 'no_audit_yet', message: 'no audit has been run in this dashboard session — POST /action/audit first' } });
    res.json(state.lastAudit.result);
  });

  app.get('/api/preview-submission', (_req, res) => {
    const policy = loadPolicy();
    if (!state.lastAudit) {
      return res.status(404).json({ error: { code: 'no_audit_yet', message: 'run POST /action/audit first' } });
    }
    const payload = buildSubmissionPayload(state.lastAudit.result, { adapterVersion: 'csn-dashboard/0.1.0' });
    res.json({ payload, sharing: describePolicy(policy) });
  });

  return app;
}

export function startDashboardServer(options: DashboardOptions = {}): { port: number; host: string; server: import('node:http').Server } {
  const port = options.port ?? Number(process.env.CSN_DASH_PORT ?? 4777);
  const host = options.host ?? process.env.CSN_DASH_HOST ?? '127.0.0.1';
  const server = createDashboardApp().listen(port, host, () => {
    console.log(`[csn-dashboard] http://${host}:${port} (local-only; audits run only when you click)`);
  });
  return { port, host, server };
}
