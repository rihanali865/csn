import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { redactText, containsSecret, minimizePath, isSecretFilename, sanitizePath } from '../src/redact.js';
import { summarizeProject } from '../src/minimize.js';

describe('redaction patterns', () => {
  it.each([
    ['sk-ABCDEFGHIJKLMNOP12345678', '[REDACTED:api-key]'],
    ['sk-ant-abcdefghij123456789012', '[REDACTED:api-key]'],
    ['ghp_0123456789abcdefghij0123456', '[REDACTED:github-token]'],
    ['AKIAIOSFODNN7EXAMPLE', '[REDACTED:aws-key]'],
    ['xoxb-123-456-abcdefghij', '[REDACTED:token]'],
    ['Bearer abcdefghijklmnopqrstuv', 'Bearer [REDACTED:token]'],
  ])('redacts %s', (input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it('redacts JWT tokens', () => {
    expect(redactText('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'))
      .toBe('[REDACTED:jwt]');
  });

  it('redacts secret assignments surface:, =, and env-style', () => {
    expect(redactText('password=hunter2hunter2')).toContain('[REDACTED]');
    expect(redactText('api_key: abcdefgh12345')).toContain('[REDACTED]');
  });

  it('redacts URL credentials', () => {
    expect(redactText('postgres://admin:sundaysecret@db.example/prod')).toBe('[REDACTED:surl-cred]');
  });

  it('redacts emails by default and keeps code-stable strings intact otherwise', () => {
    expect(redactText('contact me at dev.admin@example.com')).toContain('[REDACTED:email]');
    const clean = 'const version = "1.2.3";';
    expect(containsSecret(clean)).toBe(false);
  });

  it('detects secrets without knowing their values', () => {
    expect(containsSecret('token: ghp_0123456789abcdefghij0123456')).toBe(true);
    expect(containsSecret('plain text')).toBe(false);
  });

  it('plain technical text passes through unchanged', () => {
    expect(redactText('OpenCode adapter checks ~/.config/opencode/agents')).toBe('OpenCode adapter checks ~/.config/opencode/agents');
  });
});

describe('path minimization', () => {
  it('collapses home root to ~', () => {
    const home = os.homedir();
    expect(minimizePath(path.join(home, 'config', 'opencode', 'agents'), [home])).toBe('~config/opencode/agents'.replace('config', 'config/') ? '~/config/opencode/agents' : '');
  });

  it('leaves unrelated paths alone', () => {
    expect(minimizePath('C:/other/place', ['C:/Users/me'])).toBe('C:/other/place');
  });

  it('sanitizePath drops drive letters', () => {
    expect(sanitizePath('C:\\nonexistent\\dir')).not.toMatch(/^[A-Za-z]:\\/);
  });
});

describe('secret filename exclusion', () => {
  it('marks secret files deny-listed', () => {
    for (const f of ['.env', '.env.production', 'id_rsa', 'id_ed25519', 'server.pem', 'auth.json', 'mcp-auth.json', 'credentials.json','my.key']) {
      expect(isSecretFilename(f)).toBe(true);
    }
  });

  it('allows ordinary files', () => {
    for (const f of ['main.go', 'SKILL.md', 'opencode.json', 'environment.txt']) {
      expect(isSecretFilename(f)).toBe(false);
    }
  });
});

describe('project summarizer', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csn-proj-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('summarizes from package.json only (no source content)', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'dropship-scout',
      description: 'Helps dropshippers discover and evaluate products',
      dependencies: { react: '^18', zod: '^3' },
      devDependencies: { '@types/node': '^24' },
    }));
    fs.writeFileSync(path.join(dir, 'index.ts'), 'const API_KEY = "sk-leriustomtal-token"; // should never be read');
    const s = summarizeProject(dir);
    expect(s.ok).toBe(true);
    expect(s.name).toBe('dropship-scout');
    expect(s.purpose).toContain('dropshippers');
    expect(s.categories).toContain('e-commerce');
    expect(s.techStack).toEqual(expect.arrayContaining(['react', 'zod']));
    expect(s.sizeClass).toBe('tiny');
  });

  it('refuses to summarize when a top-level secret file exists', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, '.env'), 'SOMETHING=1');
    const s = summarizeProject(dir);
    expect(s.ok).toBe(false);
    expect(s.notes[0]).toMatch(/secret-like/);
  });

  it('uses the README head only when no description exists', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    fs.writeFileSync(path.join(dir, 'README.md'), '# X\n\nThis is a product-research platform for analysts.'); // code block below must not matter
    const s = summarizeProject(dir);
    expect(s.purpose).toContain('product-research');
    expect(s.evidenceBasis).toBe('manifest-and-readme-head');
  });
});
