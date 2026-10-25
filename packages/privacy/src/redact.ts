/**
 * Secret redaction. Deterministic, dependency-free.
 *
 * Two independent layers:
 * 1. pattern redaction — scrub token-shaped content from any string
 * 2. path minimization — replace home/user prefixes with `~`
 *
 * The engine never needs the *value* of a secret to detect one.
 */
export const REDACTIONS: Array<{ id: string; label: string; pattern: RegExp }> = [
  { id: 'openai-style-key', label: '[REDACTED:api-key]', pattern: /\bsk-[A-Za-z0-9_\-]{16,}\b/g },
  { id: 'anthropic-style-key', label: '[REDACTED:api-key]', pattern: /\bsk-ant-[A-Za-z0-9_\-]{16,}\b/g },
  { id: 'github-pat', label: '[REDACTED:github-token]', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { id: 'aws-access-key', label: '[REDACTED:aws-key]', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'google-api-key', label: '[REDACTED:api-key]', pattern: /\bAIza[0-9A-Za-z_\-]{30,}\b/g },
  { id: 'slack-token', label: '[REDACTED:token]', pattern: /\bxox[abposr]-[A-Za-z0-9\-]{10,}\b/g },
  { id: 'jwt', label: '[REDACTED:jwt]', pattern: /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g },
  { id: 'bearer-header', label: 'Bearer [REDACTED:token]', pattern: /\b[Bb]earer\s+[A-Za-z0-9_\-\.=/+]{12,}\b/g },
  { id: 'key-value-pairs', label: '[REDACTED]', pattern: /\b(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*\S+/gi },
  { id: 'url-credentials', label: '[REDACTED:surl-cred]', pattern: /\b[a-z][a-z0-9+.\-]*:\/\/[^\s\/"'@]+:[^\s\/"'@]+@[^\s"']+/gi },
];

export interface RedactOptions {
  /** Also redact email-shaped strings (default true — user content should never leak identities). */
  emails?: boolean;
}

export function redactText(input: string, options: RedactOptions = {}): string {
  let out = input;
  for (const rule of REDACTIONS) {
    out = out.replace(rule.pattern, rule.label);
  }
  if (options.emails !== false) {
    out = out.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED:email]');
  }
  return out;
}

/** True when redaction changed anything. Used by the API to refuse postings that contain raw secrets. */
export function containsSecret(input: string): boolean {
  return redactText(input, { emails: false }) !== input || redactText(input, { emails: true }) !== input;
}

/**
 * Paths are minimized: everything matching the user home (or explicit roots)
 * collapses to `~`. This makes capability IDs stable across machines and
 * prevents path structure leakage in reports and submissions.
 */
export function minimizePath(absolutePath: string, roots: string[] = []): string {
  let out = absolutePath.replace(/\\/g, '/');
  for (const root of roots) {
    const norm = root.replace(/\\/g, '/').replace(/\/+$/, '');
    if (norm.length > 2 && (out === norm || out.startsWith(`${norm}/`))) {
      out = `~/${out.slice(norm.length + 1)}`;
      break;
    }
  }
  return out;
}

/**
 * Filenames that must never be read or transmitted by CSN discovered
 * scanning. Used as a deny-list over directory entries.
 */
export const SECRET_FILENAME_PATTERNS: RegExp[] = [
  /^\.env(\..+)?$/i,
  /^\.env$/i,
  /(^|\/)(credentials|secrets?)(\/|$)/i,
  /(^|\/)\.?(ssh|aws)(\/|$)/i,
  /(^|\/)\.netrc$/i,
  /\.pem$/i,
  /\.pfx$/i,
  /\.p12$/i,
  /\.keystore$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa)(_|\.|$)/i,
  /\.key$/i,
  /(^|\/)auth\.json$/i,
  /(^|\/)mcp-auth\.json$/i,
  /(^|\/)credentials\.json$/i,
  /(^|\/)service-account.*\.json$/i,
  /\.env$/i,
];

export function isSecretFilename(pathLike: string): boolean {
  const p = pathLike.replace(/\\/g, '/').toLowerCase();
  return SECRET_FILENAME_PATTERNS.some((re) => re.test(p));
}

/** Drive letters are dropped entirely; users shouldn't leak their volume layout. */
export function sanitizePath(p: string, roots: string[] = []): string {
  const minimized = minimizePath(p, roots);
  return minimized.replace(/^[A-Za-z]:\//, '/');
}
