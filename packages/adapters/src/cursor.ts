import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AuditOptions, CapabilityRecord, EnvironmentAdapter, EnvironmentAudit } from '@csn/core';
import {
  evidence, existsDir, existsFile, parseJsonLenient, sanitizeForOutput, type DirScanContext,
} from './fs-utils.js';
import { buildRecord, auditOptionsDefaults } from './shared.js';
import { hasExecutable } from './path-resolve.js';

/**
 * Cursor adapter.
 *
 * Verification status: **docs-unverified for v0.1**. Cursor's official MCP
 * documentation page could not be reached during development (their docs
 * site served the docs index instead of the target page). This adapter
 * reads the widely-documented `mcp.json` format that Cursor distributions
 * have used historically. That is why this adapter declares limits — see
 * `knownLimitations` — and why consumers should treat its output as
 * *declared-only* evidence.
 */
export function createCursorAdapter(): EnvironmentAdapter {
  return {
    id: 'cursor',
    name: 'Cursor',
    supports: { localAudit: true, sanitizedReporting: true, scheduledWork: false },
    knownLimitations: [
      'mcp.json format interpreted from commonly-documented structure; official Cursor docs could not be reached during development — treat as fallback',
      'project .cursor/mcp.json only read for roots explicitly allowed in policy',
      'adapter never launches any configured MCP server',
    ],
    audit: (options) => auditCursor(options),
  };
}

export function auditCursor(options: AuditOptions): EnvironmentAudit {
  const opts = auditOptionsDefaults(options);
  const homeRoot = opts.homeRoot;
  const ctx: DirScanContext = { homeRoot };
  const capabilities: CapabilityRecord[] = [];
  const configPaths: string[] = [];
  const errors: string[] = [];
  const detectionEvidence: CapabilityRecord['evidence'] = [];

  const globalConfigPath = path.join(homeRoot, '.cursor', 'mcp.json');
  const targets: Array<{ p: string; scope: string }> = [];
  if (existsFile(globalConfigPath)) {
    targets.push({ p: globalConfigPath, scope: 'global' });
    detectionEvidence.push(evidence('files-on-disk', '~/.cursor/mcp.json present', globalConfigPath, ctx));
    configPaths.push(sanitizeForOutput(globalConfigPath, ctx));
  } else if (existsDir(path.join(homeRoot, '.cursor'))) {
    detectionEvidence.push(evidence('files-on-disk', '.cursor directory present but mcp.json not found', path.join(homeRoot, '.cursor'), ctx));
  }

  for (const allowedRoot of opts.allowedRoots) {
    const projectConfigPath = path.join(allowedRoot, '.cursor', 'mcp.json');
    if (existsFile(projectConfigPath)) {
      targets.push({ p: projectConfigPath, scope: 'project' });
      detectionEvidence.push(evidence('files-on-disk', 'project .cursor/mcp.json present', projectConfigPath, ctx));
      configPaths.push(sanitizeForOutput(projectConfigPath, ctx));
    }
  }

  const detected = existsDir(path.join(homeRoot, '.cursor')) || targets.length > 0;
  if (!detected) {
    return {
      adapterId: 'cursor',
      environmentName: 'Cursor',
      detected: false,
      detectionEvidence: [],
      configurationPaths: [],
      capabilities: [],
      limitations: ['.cursor directory not found; Cursor not detected on this machine'],
      errors: [],
    };
  }

  for (const target of targets) {
    let raw: string;
    try {
      raw = fs.readFileSync(target.p, 'utf8');
    } catch (err) {
      errors.push(`unreadable ${sanitizeForOutput(target.p, ctx)}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const res = parseJsonLenient(raw);
    if (!res.ok) {
      errors.push(`${sanitizeForOutput(target.p, ctx)}: parse error (${res.error})`);
      continue;
    }
    const config = res.value as { mcpServers?: Record<string, unknown> };
    const servers = config && typeof config === 'object' ? config['mcpServers'] : undefined;
    if (!servers || typeof servers !== 'object') {
      errors.push(`${sanitizeForOutput(target.p, ctx)}: mcpServers object missing (format may have changed — see limitations)`);
      continue;
    }
    for (const [name, rawEntry] of Object.entries(servers as Record<string, unknown>)) {
      if (capabilities.length >= opts.maxCapabilities) break;
      const entry = (rawEntry ?? {}) as { command?: unknown; args?: unknown; url?: unknown; env?: unknown; disabled?: boolean };
      if (entry.disabled === true) continue;
      const notes: CapabilityRecord['securityNotes'] = [];
      const evs: CapabilityRecord['evidence'] = [
        evidence('config-entry', `MCP server '${name}' configured in ${target.scope} mcp.json`, target.p, ctx),
      ];
      const tokens = Array.isArray(entry.args) && typeof entry.command === 'string'
        ? [String(entry.command), ...(entry.args as unknown[]).map(String)]
        : Array.isArray(entry.command)
          ? (entry.command as unknown[]).map(String)
          : [];
      if (tokens[0] && opts.checkConfigured) {
        if (hasExecutable(tokens[0])) {
          evs.push(evidence('runtime-observed', `runner '${tokens[0]}' found on PATH (not executed)`, undefined, ctx));
        } else {
          notes.push({ severity: 'low', message: `runner '${tokens[0]}' not found on PATH` });
        }
      }
      if (entry.env) {
        notes.push({ severity: 'info', message: 'declares environment variables for the server process (values never read by CSN)' });
      }
      capabilities.push(
        buildRecord({
          environment: 'cursor',
          name,
          sourceType: 'cursor-mcp-config',
          sourcePath: target.p,
          kind: 'mcp',
          description: typeof entry.url === 'string' ? 'remote MCP server' : 'local MCP server',
          dependencies: [...new Set(tokens.slice(0, 2))],
          evidenceList: evs,
          securityNotes: notes,
        }),
      );
    }
  }

  return {
    adapterId: 'cursor',
    environmentName: 'Cursor',
    detected,
    detectionEvidence,
    configurationPaths: configPaths,
    capabilities,
    limitations: [
      ...createCursorAdapter().knownLimitations,
      'evidence derived here is config-entry level only (no official docs cross-check available in this build)',
    ],
    errors,
  };
}
