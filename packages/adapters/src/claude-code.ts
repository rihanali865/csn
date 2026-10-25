import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AuditOptions, CapabilityRecord, EnvironmentAdapter, EnvironmentAudit } from '@csn/core';
import { STRUCTURAL_KIND_TO_CATEGORY } from '@csn/core';
import {
  evidence, existsDir, existsFile, listFiles, listSubdirs, parseFrontmatter, sanitizeForOutput,
  safeRead, type DirScanContext,
} from './fs-utils.js';
import { buildRecord, auditOptionsDefaults } from './shared.js';

/**
 * Claude Code adapter.
 *
 * Claims grounded in:
 * - https://code.claude.com/docs/en/settings (settings.json scopes, plugins)
 * - skill paths `~/.claude/skills/<name>/SKILL.md` (also cross-confirmed in OpenCode docs)
 *
 * Privacy: `~/.claude.json` is deliberately NOT parsed — it holds account
 * state, MCP credentials and per-project trust data. Only the safe
 * structured surfaces (settings.json, skills/, agents/, plugins/) are read.
 */
export function createClaudeCodeAdapter(): EnvironmentAdapter {
  return {
    id: 'claude-code',
    name: 'Claude Code',
    supports: { localAudit: true, sanitizedReporting: true, scheduledWork: false },
    knownLimitations: [
      '~/.claude.json is intentionally never parsed (account/session/credential state); MCP servers defined there are therefore not discovered yet',
      'hooks configuration is recorded as evidence but hook script contents are never read',
      'adapter never executes the claude binary; no CLI version probing',
    ],
    audit: (options) => auditClaudeCode(options),
  };
}

export function auditClaudeCode(options: AuditOptions): EnvironmentAudit {
  const opts = auditOptionsDefaults(options);
  const homeRoot = opts.homeRoot;
  const ctx: DirScanContext = { homeRoot };
  const capabilities: CapabilityRecord[] = [];
  const configPaths: string[] = [];
  const errors: string[] = [];
  const detectionEvidence: CapabilityRecord['evidence'] = [];
  const max = opts.maxCapabilities;

  const claudeDir = path.join(homeRoot, '.claude');
  const detected = existsDir(claudeDir);
  if (!detected) {
    return {
      adapterId: 'claude-code',
      environmentName: 'Claude Code',
      detected: false,
      detectionEvidence: [],
      configurationPaths: [],
      capabilities: [],
      limitations: ['~/.claude not found; Claude Code not detected on this machine'],
      errors: [],
    };
  }
  configPaths.push(sanitizeForOutput(claudeDir, ctx));
  detectionEvidence.push(evidence('files-on-disk', '.claude directory present', claudeDir, ctx));

  // settings.json — strict JSON per docs
  const settingsPath = path.join(claudeDir, 'settings.json');
  if (existsFile(settingsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
      const keys = Object.keys(parsed);
      detectionEvidence.push(evidence('manifest-parse', `settings.json parsed (keys: ${keys.slice(0, 6).join(', ')})`, settingsPath, ctx));
      configPaths.push(sanitizeForOutput(settingsPath, ctx));
      if (parsed['permissions']) {
        capabilities.push(
          buildRecord({
            environment: 'claude-code',
            name: 'permission rules (permissions.allow/deny)',
            sourceType: 'claude-settings',
            sourcePath: settingsPath,
            kind: 'config',
            description: 'allow/ask/deny rule sets from user settings',
            evidenceList: [evidence('config-entry', 'permissions block present in settings.json', settingsPath, ctx)],
          }),
        );
      }
      const enabledPlugins = parsed['enabledPlugins'];
      if (enabledPlugins !== undefined) {
        const count = Array.isArray(enabledPlugins) ? enabledPlugins.length : Object.keys(enabledPlugins as object).length;
        capabilities.push(
          buildRecord({
            environment: 'claude-code',
            name: 'enabled plugins (settings.json)',
            sourceType: 'claude-settings',
            sourcePath: settingsPath,
            kind: 'plugin',
            description: `${count} plugin entrie(s) enabled in user settings`,
            evidenceList: [evidence('config-entry', 'enabledPlugins present in settings.json', settingsPath, ctx)],
            securityNotes: [{ severity: 'medium', message: 'plugins execute inside Claude Code sessions; review before enabling' }],
          }),
        );
      }
    } catch (err) {
      errors.push(`settings.json unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // skills
  for (const skillDirName of listSubdirs(path.join(claudeDir, 'skills'))) {
    if (capabilities.length >= max) break;
    const skillFilePath = path.join(claudeDir, 'skills', skillDirName, 'SKILL.md');
    if (!existsFile(skillFilePath)) continue;
    const meta = parseFrontmatter(safeRead(skillFilePath));
    capabilities.push(
      buildRecord({
        environment: 'claude-code',
        name: meta.name || skillDirName,
        sourceType: 'skill-manifest',
        sourcePath: skillFilePath,
        kind: 'skill',
        description: meta.description,
        license: meta.license,
        evidenceList: [
          evidence('files-on-disk', `skill directory present (skills/${skillDirName})`, path.join(claudeDir, 'skills', skillDirName), ctx),
          ...(Object.keys(meta).length > 0 ? [evidence('manifest-parse', 'SKILL.md frontmatter parsed', skillFilePath, ctx)] : []),
        ],
      }),
    );
  }

  // agents
  for (const file of listFiles(path.join(claudeDir, 'agents'), ['.md'])) {
    if (capabilities.length >= max) break;
    const agentFilePath = path.join(claudeDir, 'agents', file);
    const meta = parseFrontmatter(safeRead(agentFilePath));
    capabilities.push(
      buildRecord({
        environment: 'claude-code',
        name: file.replace(/\.md$/i, ''),
        sourceType: 'markdown-agent',
        sourcePath: agentFilePath,
        kind: 'agent',
        description: meta.description,
        evidenceList: [
          evidence('files-on-disk', `agent markdown present (agents/${file})`, agentFilePath, ctx),
          ...(Object.keys(meta).length > 0 ? [evidence('manifest-parse', 'frontmatter parsed', agentFilePath, ctx)] : []),
        ],
      }),
    );
  }

  // plugin dirs
  for (const entry of listSubdirs(path.join(claudeDir, 'plugins'))) {
    if (capabilities.length >= max) break;
    const pluginDirPath = path.join(claudeDir, 'plugins', entry);
    capabilities.push(
      buildRecord({
        environment: 'claude-code',
        name: entry,
        sourceType: 'plugin-dir',
        sourcePath: pluginDirPath,
        kind: 'plugin',
        evidenceList: [evidence('files-on-disk', 'plugin directory present', pluginDirPath, ctx)],
        securityNotes: [{ severity: 'medium', message: 'plugin code loads inside Claude Code at startup; review before enabling' }],
      }),
    );
  }

  const limitations = [
    ...createClaudeCodeAdapter().knownLimitations,
    'project .claude/settings.json is only read for allowed project roots (policy-controlled)',
  ];

  return {
    adapterId: 'claude-code',
    environmentName: 'Claude Code',
    detected,
    detectionEvidence,
    configurationPaths: configPaths,
    capabilities,
    limitations,
    errors,
  };
}
