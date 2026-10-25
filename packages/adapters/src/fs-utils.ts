import * as fs from 'node:fs';
import * as path from 'node:path';
import { minimizePath } from '@csn/privacy';
import type { Evidence } from '@csn/core';

export interface DirScanContext {
  /** The user home root used for path minimization in outputs. */
  homeRoot: string;
}

export function sanitizeForOutput(absolutePath: string, ctx: DirScanContext): string {
  return minimizePath(absolutePath, [ctx.homeRoot]);
}

export function existsDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function existsFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function listFiles(dir: string, exts?: string[]): string[] {
  if (!existsDir(dir)) return [];
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && (exts === undefined || exts.includes(path.extname(d.name).toLowerCase())))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

export function listSubdirs(dir: string): string[] {
  if (!existsDir(dir)) return [];
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Read a text file with a hard size cap (privacy + DoS safety). Returns ''
 * when the file is missing, oversized, or unreadable — adapters treat '' as
 * "no frontmatter available", which degrades evidence honestly.
 */
export function safeRead(filePath: string, maxBytes = 256 * 1024): string {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > maxBytes) return '';
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Tolerant JSONC parser: supports `//` and `/* *\/` comments and trailing
 * commas — the formats OpenCode officially allows (opencode.jsonc).
 */
export function stripJsonc(text: string): string {
  // tolerate a UTF-8 BOM (common in real-world user configs edited on Windows)
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      // copy the whole string literal verbatim
      out += ch;
      i += 1;
      while (i < n) {
        const c = text[i];
        out += c;
        if (c === '\\' && i + 1 < n) {
          out += text[i + 1];
          i += 2;
          continue;
        }
        i += 1;
        if (c === '"') break;
      }
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export function parseJsonLenient(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(stripJsonc(text)) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Minimal YAML-subset frontmatter parser for agent/skill markdown.
 * Handles `key: value` scalars and one nesting level for `metadata`.
 * Big YAML features (anchors/multiline) are intentionally unsupported and
 * reported as evidence limitations rather than silently mis-parsed.
 */
export function parseFrontmatter(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!text.startsWith('---')) return result;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return result;
  const block = text.slice(4, end);
  for (const rawLine of block.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
    const commentIdx = rawLine.indexOf(' #');
    const line = commentIdx > 0 ? rawLine.slice(0, commentIdx) : rawLine;
    const match = line.match(/^([A-Za-z0-9_.\-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const [, key, valueRaw] = match;
    const value = valueRaw.trim().replace(/^["']|["']$/g, '');
    if (value === '' || value === 'null' || value === '|' || value === '>') continue;
    if (key.startsWith('metadata.')) {
      // flattened metadata keys are dropped (privacy-minimal and low-value)
      continue;
    }
    result[key] = value;
  }
  return result;
}

export function evidence(type: Evidence['type'], detail: string, filePath?: string, ctx?: DirScanContext): Evidence {
  return {
    type,
    detail,
    path: filePath === undefined ? undefined : ctx ? sanitizeForOutput(filePath, ctx) : filePath,
  };
}
