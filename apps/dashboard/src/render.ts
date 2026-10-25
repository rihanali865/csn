import type { GapReport } from '@csn/discovery';
import type { AuditResult } from '@csn/core';

/**
 * Server-rendered HTML. Single inline stylesheet (CSP: script-src 'none'),
 * dark glassy surfaces with a teal accent — mirrors the CSN demo design
 * language. No JS at all: every action is a plain form POST.
 */

export interface DashboardSection {
  title: string;
  bodyHtml: string;
}

export interface RenderHtmlOptions {
  title: string;
  sections: DashboardSection[];
  navHint: string;
  state?: {
    lastAudit?: { at: string; result: AuditResult };
    lastGap?: { at: string; report: GapReport };
  };
}

function fmtCount(state: RenderHtmlOptions['state']): string {
  const audit = state?.lastAudit;
  if (!audit) return 'no scan yet in this session';
  return `${audit.result.summary.capabilities} capabilities · scanned ${audit.at.slice(11, 19)}Z`;
}

export function renderHtml(options: RenderHtmlOptions): string {  const sections = options.sections
    .map((s) => `<section class="card"><h2>${escape(s.title)}</h2>${s.bodyHtml}</section>`)
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escape(options.title)}</title>
<style>
  :root {
    --bg: #0c1216;
    --panel: #111a20;
    --panel-edge: #1d2a33;
    --text: #d7e4ea;
    --muted: #7f95a1;
    --accent: #2dd4bf;
    --accent-dim: #134e4a;
    --warn: #f59e0b;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font: 15px/1.55 'Segoe UI', system-ui, sans-serif;
    background: radial-gradient(1200px 700px at 80% -10%, #10262e 0%, var(--bg) 60%);
    color: var(--text);
    min-height: 100vh;
  }
  header.site {
    padding: 28px 32px 18px;
    border-bottom: 1px solid var(--panel-edge);
    display: flex; align-items: baseline; gap: 18px; flex-wrap: wrap;
  }
  header.site h1 { margin: 0; font-size: 22px; letter-spacing: .4px; }
  header.site h1 .swarm { color: var(--accent); }
  header.site .count { color: var(--muted); font-size: 13px; }
  nav.hint { padding: 10px 32px 0; color: var(--muted); font-size: 13px; }
  main { padding: 18px 32px 48px; display: grid; gap: 18px; max-width: 1100px; }
  .card {
    background: linear-gradient(160deg, var(--panel) 0%, #0e161b 100%);
    border: 1px solid var(--panel-edge);
    border-radius: 14px;
    padding: 18px 20px;
    box-shadow: 0 10px 30px rgba(0,0,0,.35);
  }
  .card h2 { margin: 0 0 12px; font-size: 15px; color: var(--accent); letter-spacing: .3px; }
  pre {
    background: #0a1116; border: 1px solid var(--panel-edge); border-radius: 10px;
    padding: 14px 16px; overflow-x: auto; font: 12.5px/1.5 Consolas, monospace; color: #b7cdd8;
    white-space: pre-wrap;
  }
  form.actions { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
  button {
    background: var(--accent-dim); color: var(--accent); border: 1px solid var(--accent);
    padding: 9px 16px; border-radius: 9px; font-weight: 600; cursor: pointer; font-size: 14px;
  }
  button:hover { background: #1a5f57; }
  .foot { color: var(--muted); font-size: 12.5px; padding: 0 32px 40px; }
  a { color: var(--accent); }
</style>
</head>
<body>
<header class="site">
  <h1>CSN <span class="swarm">·</span> capability swarm network</h1>
  <span class="count">${escape(fmtCount(options.state))}</span>
</header>
<nav class="hint">${escape(options.navHint)}</nav>
<main>
  <section class="card">
    <h2>Run something (only when you say so)</h2>
    <form class="actions" method="POST" action="/action/audit">
      <button type="submit">Audit my AI coding environments</button>
    </form>
    <form class="actions" method="POST" action="/action/gaps">
      <button type="submit">Show capability gaps</button>
      <a href="/api/policy">policy JSON</a>
      <a href="/api/preview-submission">submission preview</a>
    </form>
  </section>
  ${sections}
</main>
<footer class="foot">
  Local-only dashboard. No scheduled scans, no network uploads — sharing stays disabled in policy.json until you explicitly enable it.
  Detection ≠ execution: "configured" evidence shown here is a read of your disk, not proof a capability works.
</footer>
</body>
</html>`;
}

function escape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
