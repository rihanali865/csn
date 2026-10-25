import { createHash } from 'node:crypto';

/** Stable, filesystem-safe capability id. Same env+source+name always maps to the same id. */
export function capabilityId(environment: string, sourceType: string, name: string, version?: string): string {
  const base = `${normalize(environment)}/${normalize(sourceType)}/${slug(name)}`;
  if (!version) return base;
  return `${base}@${slug(version)}`;
}

export function slug(input: string): string {
  return normalize(input)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

function normalize(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '');
}

export function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

export function reportId(installationId: string, hash: string): string {
  return `rpt_${shortHash(`${installationId}:${hash}`)}`;
}
