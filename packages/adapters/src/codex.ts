import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import type { AuditOptions, CapabilityRecord, EnvironmentAdapter, EnvironmentAudit } from '@csn/core';
import {
  evidence, existsDir, existsFile, sanitizeForOutput, safeRead, type DirScanContext,
} from './fs-utils.js';
import { buildRecord, auditOptionsDefaults } from './shared.js';

/**
 * Codex CLI adapter (OpenAI).
 *
 * Claims grounded in (verified this session):
 * - https://developers.openai.com/codex/config-basic.md
 *   (`~/.codex/config.toml`, project `.codex/config.toml`, `[features]` table)
 *
 * Scope: read-only TOML-subset parsing for MCP servers, features and plugin
 * signals. The adapter never executes codex or any configured command.
 * Project `.codex/` layers are only scanned for roots explicitly allowed in
 * policy (mirroring Codex's own trust requirement).
 */

export function createCodexAdapter(): EnvironmentAdapter {
  return {
    id: 'codex',
    name: 'Codex',
    supports: { localAudit: true, sanitizedReporting: true, scheduledWork: false },
    knownLimitations: [
      'parses a TOML subset only (top-level keys, [table] sections, string/bool/number/array values); exotic TOML may be skipped',
      'profiles, hooks and requirements.toml layers are recorded as evidence but not expanded in v1',
      'adapter never executes the codex binary; no CLI version probing',
    ],
    audit: (options) => auditCodex(options),
  };
}

interface TomlSection { name: string; entries: Record<string, ToplValue>; }
type ToplValue = string | number | boolean | ToplValue[];

export function auditCodex(options: AuditOptions): EnvironmentAudit {
  const opts = auditOptionsDefaults(options);
  const homeRoot = opts.homeRoot;
  const ctx: DirScanContext = { homeRoot };
  const capabilities: CapabilityRecord[] = [];
  const configPaths: string[] = [];
  const errors: string[] = [];
  const detectionEvidence: CapabilityRecord['evidence'] = [];
  const max = opts.maxCapabilities;

  const targets: Array<{ configPath: string; scope: string }> = [];
  const userConfig = path.join(homeRoot, '.codex', 'config.toml');
  if (existsFile(userConfig)) {
    targets.push({ configPath: userConfig, scope: 'user' });
    detectionEvidence.push(evidence('files-on-disk', '~/.codex/config.toml present', path.join(homeRoot, '.codex'), ctx));
    configPaths.push(sanitizeForOutput(userConfig, ctx));
  }

  for (const allowedRoot of opts.allowedRoots) {
    const projectConfig = path.join(allowedRoot, '.codex', 'config.toml');
    if (existsFile(projectConfig)) {
      targets.push({ configPath: projectConfig, scope: 'project' });
      detectionEvidence.push(evidence('files-on-disk', 'project .codex/config.toml present', projectConfig, ctx));
      configPaths.push(sanitizeForOutput(projectConfig, ctx));
    }
  }

  const detected = targets.length > 0;
  if (!detected) {
    return {
      adapterId: 'codex',
      environmentName: 'Codex',
      detected: false,
      detectionEvidence: [],
      configurationPaths: [],
      capabilities: [],
      limitations: ['~/.codex and project .codex layers not found; Codex not detected on this machine'],
      errors: [],
    };
  }

  for (const target of targets) {
    let raw: string;
    try {
      raw = fs.readFileSync(target.configPath, 'utf8');
    } catch (err) {
      errors.push(`unreadable ${sanitizeForOutput(target.configPath, ctx)}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const parsed = parseTomlSubset(raw);
    if (parsed.errors.length > 0) errors.push(...parsed.errors.map((message) => `${sanitizeForOutput(target.configPath, ctx)}: ${message}`));
    detectionEvidence.push(evidence('manifest-parse', `config.toml parsed (${target.scope})`, target.configPath, ctx));

    // MCP servers: [mcp_servers.<name>] with command/args/url
    for (const section of parsed.sections) {
      if (capabilities.length >= max) break;
      const mcpMatch = section.name.match(/^mcp_servers\.(.+)$/i);
      if (!mcpMatch) continue;
      const serverName = mcpMatch[1];
      const isRemote = Boolean(section.entries['url']);
      const commandTokens = Array.isArray(section.entries['command'])
        ? (section.entries['command'] as ToplValue[]).map(String)
        : typeof section.entries['command'] === 'string' ? [String(section.entries['command'])] : [];
      const notes: CapabilityRecord['securityNotes'] = [];
      const evs: CapabilityRecord['evidence'] = [
        evidence('config-entry', `MCP server '${serverName}' configured in ${target.scope} config.toml`, target.configPath, ctx),
      ];
      const sectionsStar = section.entries;
      if (sectionsStar['enabled'] === false) continue;
      const dependsOn = commandTokens.slice(0, 2);
      if (commandTokens[0] && opts.checkConfigured && !existsExecutable(commandTokens[0])) {
        notes.push({ severity: 'low', message: `runner '${commandTokens[0]}' not verified on PATH` });
      }
      if (isRemote) notes.push({ severity: 'info', message: 'remote server: credentials/env based access are never read by CSN' });
      capabilities.push(
        buildRecord({
          environment: 'codex',
          name: serverName,
          sourceType: 'mcp-toml',
          sourcePath: target.configPath,
          kind: 'mcp',
          description: isRemote ? 'remote MCP server' : 'local MCP server',
          dependencies: dependsOn,
          evidenceList: evs,
          securityNotes: notes,
        }),
      );
    }

    // [features] table — stable/experimental feature toggles as evidence
    const features = parsed.sections.find((section) => section.name === 'features');
    if (features && Object.keys(features.entries).length > 0) {
      capabilities.push(
        buildRecord({
          environment: 'codex',
          name: 'feature flags ([features])',
          sourceType: 'codex-features',
          sourcePath: target.configPath,
          kind: 'config',
          description: `${Object.keys(features.entries).length} feature flag(s) incl. ${Object.keys(features.entries).slice(0, 3).join(', ')}`,
          evidenceList: [evidence('config-entry', '[features] table parsed', target.configPath, ctx)],
        }),
      );
    }
  }

  return {
    adapterId: 'codex',
    environmentName: 'Codex',
    detected: true,
    detectionEvidence,
    configurationPaths: configPaths,
    capabilities,
    limitations: [...createCodexAdapter().knownLimitations, ...(opts.checkConfigured ? [] : ['PATH checks disabled for this run'])],
    errors,
  };
}

function existsExecutable(command: string): boolean {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    return spawnSync(cmd, [command], { timeout: 4000, windowsHide: true }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Minimal TOML-subset parser: top-level key/values, [section] headers,
 * strings ("..." / '...'), booleans, numbers and arrays of those. Lines that
 * do not fit are recorded as parse issues (skipped, never guessed).
 */
export function parseTomlSubset(text: string): { sections: TomlSection[]; topLevel: Record<string, ToplValue>; errors: string[] } {
  const sections: TomlSection[] = [];
  const topLevel: Record<string, ToplValue> = {};
  const errors: string[] = [];
  let current: TomlSection | null = null;

  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sectionMatch = line.match(/^\[([A-Za-z0-9_.\-]+)\]$/);
    if (sectionMatch) {
      current = { name: sectionMatch[1], entries: {} };
      sections.push(current);
      continue;
    }
    const kvMatch = line.match(/^([A-Za-z0-9_\-]+)\s*=\s*(.+)$/);
    if (!kvMatch) {
      errors.push(`line ${index + 1}: unsupported TOML construct skipped`);
      continue;
    }
    const [, key, rawValue] = kvMatch;
    const value = parseToplValue(rawValue.trim(), index + 1, errors);
    if (value === undefined) continue;
    if (current) current.entries[key] = value;
    else topLevel[key] = value;
  }
  return { sections, topLevel, errors };
}

function parseToplValue(raw: string, line: number, errors: string[]): ToplValue | undefined {
  const withoutComment = stripComment(raw).trim();
  if (withoutComment === '' || withoutComment === undefined) {
    errors.push(`line ${line}: empty value skipped`);
    return undefined;
  }
  if (withoutComment === 'true') return true;
  if (withoutComment === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(withoutComment)) return Number(withoutComment);
  if (withoutComment.startsWith('"') || withoutComment.startsWith("'")) {
    const quote = withoutComment[0];
    const end = withoutComment.lastIndexOf(quote);
    if (end > 0) return withoutComment.slice(1, end);
    errors.push(`line ${line}: unterminated string skipped`);
    return undefined;
  }
  if (withoutComment.startsWith('[')) {
    const inner = withoutComment.slice(1, withoutComment.lastIndexOf(']') > 0 ? withoutComment.lastIndexOf(']') : undefined);
    const items: ToplValue[] = [];
    for (const part of splitTopLevel(inner)) {
      const parsed = parseToplValue(part.trim(), line, errors);
      if (parsed !== undefined && !(Array.isArray(parsed) && parsed.length === 0)) items.push(Array.isArray(parsed) ? parsed.flat() : parsed);
    }
    return items;
  }
  errors.push(`line ${line}: value type not understood (${withoutComment.slice(0, 24)}…) skipped`);
  return undefined;
}

function stripComment(raw: string): string {
  let inString: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      continue;
    }
    if (ch === '#') return raw.slice(0, i);
  }
  return raw;
}

function splitTopLevel(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inString: string | null = null;
  let buf = '';
  for (const ch of inner) {
    if (inString) {
      buf += ch;
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      buf += ch;
      continue;
    }
    if (ch === '[') depth += 1;
    if (ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}
