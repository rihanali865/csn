import { isSecretFilename, redactText, sanitizePath } from './redact.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Strict data-minimization project summarizer (spec §7).
 *
 * Reads ONLY:
 *  - package.json / pyproject.toml / go.mod / Cargo.toml value declarations
 *  - the first paragraph block of README*.md
 *
 * It never walks source directories beyond counting extensions at depth 1,
 * never follows symlinks out of the project, and never returns raw file
 * content. Exits with `ok:false` the moment a secret-like file up top is
 * encountered and referenced.
 */
export interface ProjectSummary {
  ok: boolean;
  root: string; // minimized path
  name?: string;
  purpose?: string;
  categories: string[];
  techStack: string[];
  sizeClass: 'tiny' | 'small' | 'medium' | 'large';
  evidenceBasis: 'manifest-only' | 'manifest-and-readme-head';
  notes: string[];
}

const MANIFESTS = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml'] as const;
const READMES = ['README.md', 'readme.md', 'README.MD', 'Readme.md', 'README.txt'] as const;
const EXCLUDED_TOP = ['node_modules', '.git', '__pycache__', 'dist', 'build', 'coverage', '.venv', 'venv'];
const MEDIA_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.mp3', '.wav', '.mp4', '.mov', '.webp', '.ico']);

function sizeClassFromCount(fileCount: number): ProjectSummary['sizeClass'] {
  if (fileCount < 25) return 'tiny';
  if (fileCount < 200) return 'small';
  if (fileCount < 2000) return 'medium';
  return 'large';
}

function firstMeaningfulBlock(text: string): string {
  const lines = text.split(/\r?\n/).slice(0, 40);
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('![') || trimmed.startsWith('<')) continue;
    out.push(trimmed.replace(/[#*_`>]/g, ''));
    if (out.join(' ').length > 400) break;
  }
  return redactText(out.join(' ').slice(0, 240)).trim();
}

function categoryGuesses(name: string, purpose: string, deps: string[]): string[] {
  const hay = `${name} ${purpose} ${deps.join(' ')}`.toLowerCase();
  const cats: string[] = [];
  const push = (c: string, kw: string[]) => { if (kw.some((k) => hay.includes(k)) && !cats.includes(c)) cats.push(c); };
  push('product-research', ['research', 'discover', 'sourcing', 'scout', 'marketplace']);
  push('e-commerce', ['shopify', 'commerce', 'store', 'dropship', 'amazon', 'product']);
  push('ai-content', ['ai', 'gpt', 'video', 'content', 'generat']);
  push('developer-tools', ['cli', 'sdk', 'api', 'dev', 'developer']);
  push('analytics', ['analytics', 'dashboard', 'metrics']);
  return cats.slice(0, 4);
}

export function summarizeProject(projectRoot: string, homeRoot?: string): ProjectSummary {
  const notes: string[] = [];
  const rootSanitized = sanitizePath(projectRoot, homeRoot ? [homeRoot] : []);

  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    return { ok: false, root: rootSanitized, categories: [], techStack: [], sizeClass: 'tiny', evidenceBasis: 'manifest-only', notes: ['project root not found'] };
  }

  const entries = fs.readdirSync(projectRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && isSecretFilename(entry.name)) {
      return { ok: false, root: rootSanitized, categories: [], techStack: [], sizeClass: 'tiny', evidenceBasis: 'manifest-only', notes: [`secret-like top-level file detected (${entry.name}); refusing to summarize`] };
    }
  }

  let name: string | undefined;
  let purpose: string | undefined;
  let techStack: string[] = [];
  let evidenceBasis: ProjectSummary['evidenceBasis'] = 'manifest-only';

  const manifest = entries.find((e) => (MANIFESTS as readonly string[]).includes(e.name) && e.isFile());
  if (manifest) {
    const raw = fs.readFileSync(path.join(projectRoot, manifest.name), 'utf8');
    if (manifest.name === 'package.json') {
      try {
        const pkg = JSON.parse(raw) as { name?: string; description?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
        name = redactText(String(pkg.name ?? '')) || undefined;
        purpose = pkg.description ? redactText(String(pkg.description)).slice(0, 240) : undefined;
        techStack = [...Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })].filter((k) => !/^(_[^_]|@types\/)/.test(k)).slice(0, 12);
      } catch {
        notes.push('package.json not parseable; falling back to top-level file stats only');
      }
    } else if (manifest.name === 'pyproject.toml') {
      const nameMatch = raw.match(/^\s*name\s*=\s*"([^"]+)"/m);
      const descMatch = raw.match(/^\s*description\s*=\s*"([^"]+)"/m);
      name = nameMatch?.[1];
      purpose = descMatch ? redactText(descMatch[1]).slice(0, 240) : undefined;
      techStack = (raw.match(/^\s*([a-zA-Z0-9_\-\.]+)\s*=\s*["']/gm) ?? []).map((s) => s.replace(/^\s*/, '').split(' ')[0]).slice(0, 12);
    } else if (manifest.name === 'go.mod') {
      const moduleMatch = raw.match(/^module\s+(\S+)/m);
      name = moduleMatch?.[1];
      techStack = ['go'];
    } else if (manifest.name === 'Cargo.toml') {
      const nameMatch = raw.match(/^\s*name\s*=\s*"([^"]+)"/m);
      name = nameMatch?.[1];
      techStack = ['rust'];
    }
  }

  const readme = entries.find((e) => (READMES as readonly string[]).includes(e.name) && e.isFile());
  if (readme) {
    const head = firstMeaningfulBlock(fs.readFileSync(path.join(projectRoot, readme.name), 'utf8'));
    purpose = purpose || head || undefined;
    evidenceBasis = 'manifest-and-readme-head';
  }

  // depth-1 file stats for a size class only — no file names, no content
  let fileCount = 0;
  for (const e of entries) {
    if (EXCLUDED_TOP.includes(e.name)) continue;
    if (e.isFile() && !MEDIA_EXT.has(path.extname(e.name).toLowerCase())) fileCount += 1;
  }

  const summary: ProjectSummary = {
    ok: true,
    root: rootSanitized,
    name,
    purpose,
    categories: categoryGuesses(name ?? '', purpose ?? '', techStack),
    techStack,
    sizeClass: sizeClassFromCount(fileCount),
    evidenceBasis,
    notes,
  };
  if (!purpose) notes.push('no purpose field derivable from manifests/README head');
  return summary;
}
