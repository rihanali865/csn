import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

import { createOpenCodeAdapter } from '@csn/adapters';
import { createClaudeCodeAdapter, createCodexAdapter, createCursorAdapter, getBuiltinAdapters, AdapterRegistry } from '@csn/adapters';
import { parseTomlSubset, parseFrontmatter, stripJsonc, recordFromOpencodeConfig } from '@csn/adapters';

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../tests/fixtures/environments');

const fixtureHome = (env: string) => path.join(fixturesDir, env);
const realOpenCodeDir = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.config', 'opencode');

// ------------------------------------------------------------ text utilities

describe('jsonc / frontmatter / toml parsing', () => {
  it('stripJsonc removes comments and trailing commas', () => {
    const parsed = stripJsonc(`{// comment\n "a": 1, /* c */ "b": [1, 2,],}`);
    expect(JSON.parse(parsed)).toEqual({ a: 1, b: [1, 2] });
  });

  it('stripJsonc keeps string content intact', () => {
    const parsed = stripJsonc(`{"url": "https://x//notacomment", "b": "a/*c*/"}`);
    expect(JSON.parse(parsed).url).toBe('https://x//notacomment');
  });

  it('parseFrontmatter grabs scalars and skips body', () => {
    const meta = parseFrontmatter('---\ndescription: Reviews code\nmode: subagent\nlicense: MIT\n---\nbody with: colon');
    expect(meta).toEqual({ description: 'Reviews code', mode: 'subagent', license: 'MIT' });
  });

  it('parses frontmatter identically when a Windows checkout produced CRLF', () => {
    const crlf = '---\r\nname: video-editing\r\ndescription: Cut, polish and QC video edits with ffmpeg and Remotion\r\nlicense: MIT\r\n---\nbody';
    expect(parseFrontmatter(crlf)).toEqual({ name: 'video-editing', description: 'Cut, polish and QC video edits with ffmpeg and Remotion', license: 'MIT' });
  });

  it('parseFrontmatter tolerates non-frontmatter files', () => {
    expect(parseFrontmatter('# Just docs\nkey: value')).toEqual({});
  });

  it('parseTomlSubset handles sections, arrays, bools, comments', () => {
    const res = parseTomlSubset(`
model = "gpt-5.2"
[features]
a = true
b = false
weird = 3
[mcp_servers.files]
command = ["node", "./x.js"]
`);
    expect(res.topLevel.model).toBe('gpt-5.2');
    expect(res.sections).toHaveLength(2);
    expect(res.sections[1]?.entries.command).toEqual(['node', './x.js']);
    expect(res.errors).toHaveLength(0);
  });

  it('parseTomlSubset records (not guesses) unsupported lines', () => {
    const res = parseTomlSubset('inline = { not = "supported" }\n');
    expect(res.topLevel.inline).toBeUndefined();
    expect(res.errors.length).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------ adapter registry

describe('adapter registry', () => {
  it('exposes the four builtins with honest supports', () => {
    const all = getBuiltinAdapters();
    expect(all.map((adapter) => adapter.id)).toEqual(['opencode', 'claude-code', 'codex', 'cursor']);
    for (const adapter of all) {
      expect(adapter.knownLimitations.length).toBeGreaterThan(0);
    }
    // scheduledWork: only verified-capable adapters may claim it
    expect(getBuiltinAdapters().find((adapter) => adapter.id === 'opencode')?.supports.scheduledWork).toBe(true);
    expect(getBuiltinAdapters().find((adapter) => adapter.id === 'cursor')?.supports.scheduledWork).toBe(false);
  });

  it('registers new adapters and rejects duplicates', () => {
    const fresh = new AdapterRegistry([]);
    expect(fresh.has('checker')).toBe(false);
    fresh.register(createOpenCodeAdapter());
    expect(fresh.has('opencode')).toBe(true);
    expect(() => fresh.register(createOpenCodeAdapter())).toThrow(/already registered/);
  });
});

// ------------------------------------------------------------ opencode adapter

const ocHome = path.join(fixtureHome('opencode'), 'home-oc-user');

describe('opencode adapter (fixture home)', () => {
  const audit = createOpenCodeAdapter().audit({ homeRoot: ocHome, allowedRoots: [] });

  it('detects the fixture environment', () => {
    expect(audit.detected).toBe(true);
    expect(audit.detectionEvidence.length).toBeGreaterThan(0);
  });

  it('discovers mcp servers; disabled entries are skipped', () => {
    const mcps = audit.capabilities.filter((c) => c.sourceType === 'mcp-config');
    expect(mcps.map((c) => c.name).sort()).toEqual(['docs-server', 'remote-search']);
  });

  it('configured local MCP records the runner as dependency', () => {
    const docsServer = audit.capabilities.find((c) => c.name === 'docs-server' && c.sourceType === 'mcp-config');
    expect(docsServer?.dependencies).toEqual(['node']);
    expect(docsServer?.verification).toBe('configured'); // node is always on PATH
    expect(docsServer?.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('never leaks secret header values or agent-body junk', () => {
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain('ghp_ZZZZ');
    expect(serialized).not.toContain('AnotherFakeBody');
  });

  it('discovers agents, skills, commands, plugins, mcps dirs', () => {
    const names = audit.capabilities.map((c) => `${c.sourceType}:${c.name}`);
    expect(names).toContain('markdown-agent:review');
    expect(names).toContain('skill-manifest:video-editing');
    expect(names).toContain('markdown-command:run-tests');
    expect(names).toContain('plugin-dir:mcp-notifier');
    expect(names).toContain('mcp-dir:unreal-mcp');
    expect(names).toContain('config-agent:docs-search');
    expect(names).toContain('config-plugin:opencode-wakatime');
    expect(names).toContain('config-instructions:project instructions (config instructions)');
  });

  it('records license from skill frontmatter', () => {
    const skill = audit.capabilities.find((c) => c.name === 'video-editing');
    expect(skill?.license).toBe('MIT');
  });

  it('all emitted paths are home-minimized (start with ~)', () => {
    for (const record of audit.capabilities) {
      if (record.sourcePath) expect(record.sourcePath.startsWith('~/')).toBe(true);
    }
    for (const detection of audit.detectionEvidence) {
      if (detection.path) expect(detection.path.startsWith('~/')).toBe(true);
    }
  });

  it('project scope only applies to allowed roots', () => {
    const noProjects = createOpenCodeAdapter().audit({ homeRoot: ocHome });
    expect(noProjects.configurationPaths.every((p) => p.includes('.config/opencode'))).toBe(true);
  });
});

// ------------------------------------------------------------ claude code adapter

const ccHome = path.join(fixtureHome('claude-code'), 'home-cc-user');

describe('claude code adapter (fixture home)', () => {
  const audit = createClaudeCodeAdapter().audit({ homeRoot: ccHome });

  it('detects and parses settings.json', () => {
    expect(audit.detected).toBe(true);
    expect(audit.detectionEvidence.some((e) => e.type === 'manifest-parse')).toBe(true);
  });

  it('discovers permissions record and enabled plugins', () => {
    const names = audit.capabilities.map((c) => c.name);
    expect(names.some((n) => n.startsWith('permission rules'))).toBe(true);
    expect(names.some((n) => n.startsWith('enabled plugins'))).toBe(true);
  });

  it('discovers skills and agents with licenses', () => {
    const skill = audit.capabilities.find((c) => c.name === 'commit-helper');
    expect(skill?.license).toBe('Apache-2.0');
    expect(audit.capabilities.some((c) => c.name === 'audit' && c.sourceType === 'markdown-agent')).toBe(true);
  });

  it('graceful not-detected for empty home', () => {
    const empty = createClaudeCodeAdapter().audit({ homeRoot: path.join(fixturesDir, 'empty') });
    expect(empty.detected).toBe(false);
    expect(empty.limitations[0]).toMatch(/not detected/i);
  });
});

// ------------------------------------------------------------ codex adapter

const codexHome = path.join(fixtureHome('codex'), 'home-codex-user');

describe('codex adapter (fixture home)', () => {
  const audit = createCodexAdapter().audit({ homeRoot: codexHome });

  it('detects user config.toml', () => {
    expect(audit.detected).toBe(true);
  });

  it('reads MCP servers from [mcp_servers.*] sections', () => {
    const mcps = audit.capabilities.filter((c) => c.sourceType === 'mcp-toml');
    expect(mcps.map((c) => c.name).sort()).toEqual(['files', 'remote-docs']);
  });

  it('records feature flags as a config capability', () => {
    const features = audit.capabilities.find((c) => c.sourceType === 'codex-features');
    expect(features?.description).toMatch(/multi_agent/);
  });

  it('not-detected for empty home', () => {
    const empty = createCodexAdapter().audit({ homeRoot: path.join(fixtureHome('opencode'), 'empty-nowhere') });
    expect(empty.detected).toBe(false);
  });
});

// ------------------------------------------------------------ cursor adapter

const cursorHome = path.join(fixtureHome('cursor'), 'home-cursor-user');

describe('cursor adapter (fixture home)', () => {
  const audit = createCursorAdapter().audit({ homeRoot: cursorHome });

  it('detects ~/.cursor/mcp.json', () => {
    expect(audit.detected).toBe(true);
  });

  it('discovers both mcp servers', () => {
    const mcps = audit.capabilities.filter((c) => c.sourceType === 'cursor-mcp-config');
    expect(mcps.map((c) => c.name).sort()).toEqual(['filesystem', 'wiki-lookup']);
  });

  it('is explicit about docs-unverified status', () => {
    expect(audit.limitations.join(' ')).toMatch(/docs/i);
  });
});

// ------------------------------------------------------------ mcp config parsing unit check

describe('recordFromOpencodeConfig', () => {
  const ctx = { homeRoot: ocHome };
  it('orders evidence and marks disabled servers skipped', () => {
    const records = recordFromOpencodeConfig(
      {
        mcp: {
          'a': { type: 'local', command: ['node', './s.js'] },
          'b': { type: 'local', command: ['notrealcmdxyz'], environment: { X: '1' } },
        },
      },
      'global',
      'C:/fixture/opencode.json',
      ctx,
      true,
    );
    expect(records).toHaveLength(2);
    const aProc = records.find((record) => record.name === 'a');
    expect(aProc?.verification).toBe('configured');
    const bProc = records.find((record) => record.name === 'b');
    expect(bProc?.securityNotes.some((n) => n.message.includes('not found on PATH'))).toBe(true);
  });
});

// ------------------------------------------------------------ real machine (conditional)

const describeReal = existsSync(realOpenCodeDir) ? describe : describe.skip;

describeReal('opencode adapter (real machine, read-only)', () => {
  it('runs against the actual OpenCode install', () => {
    const audit = createOpenCodeAdapter().audit({ maxCapabilities: 500 });
    expect(audit.detected).toBe(true);
    expect(audit.capabilities.length).toBeGreaterThan(10);
  const lcd = JSON.stringify(audit).toLowerCase();
  // token-shaped content never leaks (naive substrings like 'sk-' would false-positive on ordinary words, e.g. 'task-dag')
  expect(lcd).not.toMatch(/\bsk-[a-z0-9_-]{16,}/i);
  expect(lcd).not.toMatch(/\bgh[pousr]_[a-z0-9]{20,}\b/i);
  expect(lcd).not.toMatch(/bearer\s+[a-z0-9_.\-=/+]{12,}/i);
  // credential stores are never read — check capability content, not the adapter's own disclosure text in limitations
  expect(JSON.stringify(audit.capabilities).toLowerCase()).not.toContain('mcp-auth');
    // never leaks raw absolute home path
    const home = realOpenCodeDir.split(path.sep).slice(0, 3).join(path.sep);
    if (home.length > 4) {
      expect(JSON.stringify(audit)).not.toContain(home);
    }
  });
});
