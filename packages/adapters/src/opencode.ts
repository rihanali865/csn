import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AuditOptions, CapabilityRecord, EnvironmentAdapter, EnvironmentAudit } from '@csn/core';
import {
  evidence, existsDir, existsFile, listFiles, listSubdirs, parseFrontmatter, parseJsonLenient,
  sanitizeForOutput, safeRead, type DirScanContext,
} from './fs-utils.js';
import { hasExecutable } from './path-resolve.js';
import { buildRecord as buildSharedRecord, auditOptionsDefaults } from './shared.js';

/**
 * OpenCode adapter.
 *
 * Claims grounded in:
 * - https://opencode.ai/docs/config/   (config locations + keys)
 * - https://opencode.ai/docs/agents/   (agents/ markdown + `agent` config key)
 * - https://opencode.ai/docs/skills/   (skills/<name>/SKILL.md)
 * - https://opencode.ai/docs/plugins/  (plugins/ dir + `plugin` npm key)
 * - https://opencode.ai/docs/mcp-servers/ (`mcp` local/remote schema)
 * plus the local OpenCode v2 layout this adapter was developed against.
 *
 * Strictly read-only. Configured commands are checked for PATH
 * resolvability with `where`/`which` only — never executed.
 */
export function createOpenCodeAdapter(): EnvironmentAdapter {
  return {
    id: 'opencode',
    name: 'OpenCode',
    supports: { localAudit: true, sanitizedReporting: true, scheduledWork: true },
    knownLimitations: [
      'CLI version is not probed — the adapter never executes the opencode binary',
      'formatter/lsp config keys are recorded as evidence but not classified as capabilities in v1',
      'OPENCODE_CONFIG env-var override is not followed (fixed root layout only)',
      'opencode token stores (~/.local/share/opencode/mcp-auth.json) are never read',
    ],
    audit: (options) => auditOpenCode(options),
  };
}

interface McpEntry {
  type?: string;
  command?: unknown;
  url?: unknown;
  enabled?: boolean;
  environment?: unknown;
  headers?: unknown;
  oauth?: unknown;
}

export function auditOpenCode(options: AuditOptions): EnvironmentAudit {
  const opts = auditOptionsDefaults(options);
  const homeRoot = opts.homeRoot;
  const ctx: DirScanContext = { homeRoot };
  const capabilities: CapabilityRecord[] = [];
  const configPaths: string[] = [];
  const errors: string[] = [];
  const detectionEvidence: CapabilityRecord['evidence'] = [];
  const max = opts.maxCapabilities;
  const checkConfigured = opts.checkConfigured;

  const globalDir = path.join(homeRoot, '.config', 'opencode');
  const roots: Array<{ baseDir: string; scope: string }> = [];
  if (existsDir(globalDir)) {
    roots.push({ baseDir: globalDir, scope: 'global' });
    configPaths.push(sanitizeForOutput(globalDir, ctx));
    detectionEvidence.push(evidence('files-on-disk', 'global OpenCode config directory present', globalDir, ctx));
  }

  for (const projectRoot of options.allowedRoots ?? []) {
    const projectOpenCodeDir = path.join(projectRoot, '.opencode');
    if (existsDir(projectOpenCodeDir)) {
      roots.push({ baseDir: projectOpenCodeDir, scope: 'project' });
      configPaths.push(sanitizeForOutput(projectOpenCodeDir, ctx));
      detectionEvidence.push(evidence('files-on-disk', 'project .opencode directory present', projectOpenCodeDir, ctx));
    }
  }

  const stop = () => capabilities.length >= max;
  for (const root of roots) {
    if (stop()) break;
    scanRoot(root.baseDir, root.scope, ctx, { capabilities, errors, detectionEvidence, max, checkConfigured });
  }

  const detected = roots.length > 0;
  const limitations = detected
    ? [...createOpenCodeAdapter().knownLimitations, ...(checkConfigured ? [] : ['dependency resolvability checks were disabled for this run'])]
    : ['OpenCode global directory (~/.config/opencode) not found; environment not detected on this machine'];

  return {
    adapterId: 'opencode',
    environmentName: 'OpenCode',
    detected,
    detectionEvidence,
    configurationPaths: configPaths,
    capabilities,
    limitations,
    errors,
  };
}

interface ScanAcc {
  capabilities: CapabilityRecord[];
  errors: string[];
  detectionEvidence: CapabilityRecord['evidence'];
  max: number;
  checkConfigured: boolean;
}

function scanRoot(baseDir: string, scope: string, ctx: DirScanContext, acc: ScanAcc): void {
  // ---- config files
  for (const configFile of ['opencode.json', 'opencode.jsonc']) {
    const configFilePath = path.join(baseDir, configFile);
    if (!existsFile(configFilePath)) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(configFilePath, 'utf8');
    } catch (err) {
      acc.errors.push(`unreadable ${sanitizeForOutput(configFilePath, ctx)}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const res = parseJsonLenient(raw);
    if (!res.ok) {
      acc.errors.push(`${sanitizeForOutput(configFilePath, ctx)}: config parse error (${res.error})`);
      continue;
    }
    for (const rec of recordFromOpencodeConfig(res.value as Record<string, unknown>, scope, configFilePath, ctx, acc.checkConfigured)) {
      if (acc.capabilities.length >= acc.max) break;
      acc.capabilities.push(rec);
    }
    acc.detectionEvidence.push(evidence('manifest-parse', `${configFile} parsed (${scope})`, configFilePath, ctx));
  }

  // ---- agents (agents/ + legacy agent/)
  const seenAgents = new Set(acc.capabilities.filter((c) => c.sourceType.includes('agent')).map((c) => c.name));
  for (const agentsDirName of ['agents', 'agent']) {
    const agentsDirPath = path.join(baseDir, agentsDirName);
    for (const file of listFiles(agentsDirPath, ['.md'])) {
      if (acc.capabilities.length >= acc.max) break;
      const agentName = file.replace(/\.md$/i, '');
      if (seenAgents.has(agentName)) continue;
      seenAgents.add(agentName);
      const agentFilePath = path.join(agentsDirPath, file);
      const meta = parseFrontmatter(safeRead(agentFilePath));
      acc.capabilities.push(
        buildRecord({
          name: agentName,
          sourceType: 'markdown-agent',
          sourcePath: sanitizeForOutput(agentFilePath, ctx),
          kind: 'agent',
          description: meta.description,
          evidenceList: [
            evidence('files-on-disk', `agent markdown present (${agentsDirName}/${file})`, agentFilePath, ctx),
            ...(Object.keys(meta).length > 0
              ? [evidence('manifest-parse', `frontmatter parsed (mode: ${meta.mode ?? 'default'})`, agentFilePath, ctx)]
              : []),
          ],
        }),
      );
    }
  }

  // ---- skills
  const skillsDirPath = path.join(baseDir, 'skills');
  for (const skillDirName of listSubdirs(skillsDirPath)) {
    if (acc.capabilities.length >= acc.max) break;
    const skillFilePath = path.join(skillsDirPath, skillDirName, 'SKILL.md');
    if (!existsFile(skillFilePath)) continue;
    const meta = parseFrontmatter(safeRead(skillFilePath));
    acc.capabilities.push(
      buildRecord({
        name: meta.name || skillDirName,
        sourceType: 'skill-manifest',
        sourcePath: sanitizeForOutput(skillFilePath, ctx),
        kind: 'skill',
        description: meta.description,
        license: meta.license,
        evidenceList: [
          evidence('files-on-disk', `skill directory present (skills/${skillDirName})`, path.join(skillsDirPath, skillDirName), ctx),
          ...(Object.keys(meta).length > 0
            ? [evidence('manifest-parse', `SKILL.md frontmatter parsed (name: ${meta.name || '(implicit)'})`, skillFilePath, ctx)]
            : []),
        ],
      }),
    );
  }

  // ---- local plugin directories
  const pluginsDirPath = path.join(baseDir, 'plugins');
  for (const entry of listSubdirs(pluginsDirPath)) {
    if (acc.capabilities.length >= acc.max) break;
    const pluginDirPath = path.join(pluginsDirPath, entry);
    acc.capabilities.push(
      buildRecord({
        name: entry,
        sourceType: 'plugin-dir',
        sourcePath: sanitizeForOutput(pluginDirPath, ctx),
        kind: 'plugin',
        evidenceList: [evidence('files-on-disk', 'plugin directory present', pluginDirPath, ctx)],
        securityNotes: [{ severity: 'medium', message: 'plugin code is loaded by the environment at startup; review before enabling' }],
      }),
    );
  }

  // ---- custom commands
  const commandsDirPath = path.join(baseDir, 'commands');
  for (const file of listFiles(commandsDirPath, ['.md'])) {
    if (acc.capabilities.length >= acc.max) break;
    const commandFilePath = path.join(commandsDirPath, file);
    const meta = parseFrontmatter(safeRead(commandFilePath));
    acc.capabilities.push(
      buildRecord({
        name: file.replace(/\.md$/i, ''),
        sourceType: 'markdown-command',
        sourcePath: sanitizeForOutput(commandFilePath, ctx),
        kind: 'command',
        description: meta.description,
        evidenceList: [evidence('files-on-disk', `command template present (commands/${file})`, commandFilePath, ctx)],
      }),
    );
  }

  // ---- nonstandard mcps/ directory observed in some setups
  const mcpsDirPath = path.join(baseDir, 'mcps');
  for (const entry of listSubdirs(mcpsDirPath)) {
    if (acc.capabilities.length >= acc.max) break;
    const mcpDirPath = path.join(mcpsDirPath, entry);
    acc.capabilities.push(
      buildRecord({
        name: entry,
        sourceType: 'mcp-dir',
        sourcePath: sanitizeForOutput(mcpDirPath, ctx),
        kind: 'mcp',
        evidenceList: [evidence('files-on-disk', 'MCP server directory present (mcps/)', mcpDirPath, ctx)],
        securityNotes: [{ severity: 'medium', message: 'local MCP server directory; behavior unverified until executed' }],
      }),
    );
  }

  // explicit policy surface (report as evidence, not a capability)
  const permissionsSet = 'permission' in readConfigRaw(baseDir) ? scope : '';
  if (permissionsSet) {
    acc.detectionEvidence.push(evidence('config-entry', `permission policy configured in ${scope} opencode config`, baseDir, ctx));
  }
}

function readConfigRaw(baseDir: string): Record<string, unknown> {
  for (const configFile of ['opencode.json', 'opencode.jsonc']) {
    const filePath = path.join(baseDir, configFile);
    if (!existsFile(filePath)) continue;
    const res = parseJsonLenient(fs.readFileSync(filePath, 'utf8'));
    if (res.ok) return res.value as Record<string, unknown>;
  }
  return {};
}

/** Turn a parsed OpenCode config into records for config-sourced capabilities. */
export function recordFromOpencodeConfig(
  configValue: Record<string, unknown>,
  scope: string,
  configFilePath: string,
  ctx: DirScanContext,
  checkConfigured: boolean,
): CapabilityRecord[] {
  const out: CapabilityRecord[] = [];
  const baseEvidence = (detail: string) => [evidence('config-entry', detail, configFilePath, ctx)];
  const sourcePath = sanitizeForOutput(configFilePath, ctx);

  const mcp = configValue['mcp'];
  if (mcp && typeof mcp === 'object' && !Array.isArray(mcp)) {
    for (const [name, raw] of Object.entries(mcp as Record<string, unknown>)) {
      const entry = (raw ?? {}) as McpEntry;
      if (entry.enabled === false) continue;
      const deps: string[] = [];
      const notes: CapabilityRecord['securityNotes'] = [];
      const evs = [...baseEvidence(`MCP server '${name}' configured in ${scope} config`)];
      if (entry.type === 'local' && Array.isArray(entry.command)) {
        const tokens = entry.command.map(String);
        if (tokens[0]) deps.push(tokens[0]);
        const runner = tokens[0];
        if (runner && checkConfigured) {
          if (hasExecutable(runner)) {
            evs.push(evidence('runtime-observed', `runner '${runner}' found on PATH (not executed)`, undefined, ctx));
          } else {
            notes.push({ severity: 'low', message: `runner '${runner}' not found on PATH — server cannot start until dependency is installed` });
          }
        }
        if (entry.environment) {
          notes.push({ severity: 'info', message: 'declares environment variables for the server process (values never read by CSN)' });
        }
      } else if (entry.type === 'remote') {
        if (entry.headers) {
          notes.push({ severity: 'low', message: 'configured with authentication headers; values are redacted everywhere in CSN' });
        }
        if (entry.oauth) {
          notes.push({ severity: 'info', message: 'OAuth flow configured; credentials stored by OpenCode are never read by CSN' });
        }
      }
      out.push(
        buildRecord({
          name,
          sourceType: 'mcp-config',
          sourcePath,
          kind: 'mcp',
          description: entry.type === 'remote' ? 'remote MCP server' : 'local MCP server',
          dependencies: deps,
          evidenceList: evs,
          securityNotes: notes,
        }),
      );
    }
  }

  const agentConfig = configValue['agent'];
  if (agentConfig && typeof agentConfig === 'object' && !Array.isArray(agentConfig)) {
    for (const [name, raw] of Object.entries(agentConfig as Record<string, unknown>)) {
      const entry = (raw ?? {}) as { description?: string; disable?: boolean };
      if (entry.disable === true) continue;
      out.push(
        buildRecord({
          name,
          sourceType: 'config-agent',
          sourcePath,
          kind: 'agent',
          description: entry.description,
          evidenceList: baseEvidence(`inline agent '${name}' configured in ${scope} config`),
        }),
      );
    }
  }

  if (Array.isArray(configValue['plugin'])) {
    for (const raw of configValue['plugin']) {
      const pluginName = String(raw);
      if (!pluginName) continue;
      out.push(
        buildRecord({
          name: pluginName,
          sourceType: 'config-plugin',
          sourcePath,
          kind: 'plugin',
          evidenceList: baseEvidence(`npm plugin '${pluginName}' enabled in ${scope} config`),
          securityNotes: [{ severity: 'medium', message: 'npm plugin executes at environment startup (bun install + import)' }],
        }),
      );
    }
  }

  if (Array.isArray(configValue['instructions']) && configValue['instructions'].length > 0) {
    out.push(
      buildRecord({
        name: 'project instructions (config instructions)',
        sourceType: 'config-instructions',
        sourcePath,
        kind: 'instruction-file',
        description: `${(configValue['instructions'] as unknown[]).length} instruction file(s) loaded from ${scope} config`,
        evidenceList: baseEvidence(`instructions list present in ${scope} config`),
      }),
    );
  }

  return out;
}

/** OpenCode-scoped record builder: delegates to the shared builder and pins the environment field (deterministic ids). */
function buildRecord(input: Omit<Parameters<typeof buildSharedRecord>[0], 'environment'>): CapabilityRecord {
  return buildSharedRecord({ ...input, environment: 'opencode' });
}
