import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { TokenRecord } from './store.js';

/**
 * Installation identity: a scoped bearer token. The raw token is shown exactly
 * once at registration, then only its sha256 is stored/compared. Scopes bound
 * what each token may do; revocation is a first-class operation.
 */
export const TOKEN_SCOPES = {
  reports: 'report:submit',
  tasks: 'task:ack',
} as const;

export const DEFAULT_SCOPES: string[] = [TOKEN_SCOPES.reports, TOKEN_SCOPES.tasks];

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export interface IssuedToken {
  token: TokenRecord;
  /** Raw secret — returned once, never persisted. */
  rawToken: string;
}

export function issueToken(installationId: string, scopes: string[] = DEFAULT_SCOPES, createdAt = new Date().toISOString()): IssuedToken {
  const rawToken = `csn_${randomBytes(24).toString('base64url')}`;
  const record: TokenRecord = {
    tokenId: `tok_${randomUUID().slice(0, 8)}`,
    installationId,
    tokenHash: hashToken(rawToken),
    scopes: [...scopes],
    createdAt,
  };
  return { token: record, rawToken };
}

export interface AuthenticatedRequest {
  installationId: string;
  tokenId: string;
  scopes: string[];
}

/** Extract + hash the bearer header; verification happens against stored hashes. */
export function bearerToken(header: string | undefined): { ok: true; raw: string } | { ok: false; code: string; message: string } {
  if (!header) return { ok: false, code: 'unauthorized', message: 'missing Authorization: Bearer header' };
  const match = /^Bearer\s+(\S+)$/.exec(header);
  if (!match) return { ok: false, code: 'unauthorized', message: 'Authorization header must be `Bearer <token>`' };
  return { ok: true, raw: match[1] ?? '' };
}
