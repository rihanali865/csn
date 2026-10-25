import type { CapabilityCategory } from './types.js';

/**
 * Capability-gap comparison.
 *
 * The Master Agent compares inbound/network capability profiles against its
 * local registry. Matching is deterministic and explainable: every gap
 * result states *why* it reached its status.
 */
export interface DesiredCapability {
  name: string;
  category?: CapabilityCategory;
  description?: string;
  aliases?: string[];
}

export type GapStatus = 'missing' | 'partial' | 'covered';

export interface CapabilityGap {
  desired: DesiredCapability;
  status: GapStatus;
  /** Local capability ids that satisfied (or partially satisfied) the need. */
  matches: string[];
  reason: string;
}

const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'of', 'to', 'in', 'on', 'with', 'my']);

export function normalizeName(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function significantTokens(input: string): string[] {
  return normalizeName(input)
    .split(' ')
    .filter((t) => t.length > 3 && !STOPWORDS.has(t));
}

function singularize(word: string): string {
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) return word.slice(0, -1);
  return word;
}

function tokenSet(record: { name: string; description?: string; category?: string }): { tokens: string[]; nameKey: string } {
  const nameKey = normalizeName(record.name);
  const text = `${record.name} ${record.description ?? ''}`;
  return {
    tokens: [...new Set(significantTokens(text).map(singularize))],
    nameKey,
  };
}

/** `covered` (same capability present), `partial` (token overlap, same category), else `missing`. */
export function assessOne(desired: DesiredCapability, local: readonly { id: string; name: string; category: CapabilityCategory; description?: string }[]): CapabilityGap {
  const want = tokenSet({ name: desired.name, description: desired.description, category: desired.category });
  const aliases = (desired.aliases ?? []).map((a) => normalizeName(a));
  const wantTokens = new Set(want.tokens);

  const exact: string[] = [];
  const partial: string[] = [];

  for (const cap of local) {
    const have = tokenSet(cap);
    const nameMatch = have.nameKey === want.nameKey || aliases.includes(have.nameKey);
    const overlap = [...wantTokens].filter((t) => have.tokens.includes(t));
    if (nameMatch || overlap.length >= 2) {
      exact.push(cap.id);
      continue;
    }
    if (overlap.length === 1 && desired.category && cap.category === desired.category) {
      partial.push(cap.id);
    }
  }

  if (exact.length > 0) {
    return { desired, status: 'covered', matches: exact, reason: 'name/alias exact match or ≥2 significant shared tokens' };
  }
  if (partial.length > 0) {
    return { desired, status: 'partial', matches: partial, reason: `single-token overlap within category '${desired.category}'` };
  }
  return { desired, status: 'missing', matches: [], reason: 'no exact name/alias match and no significant token overlap' };
}

export function findCapabilityGaps(
  local: readonly { id: string; name: string; category: CapabilityCategory; description?: string }[],
  desired: readonly DesiredCapability[],
): CapabilityGap[] {
  return desired.map((d) => assessOne(d, local));
}

export function summarizeGaps(gaps: readonly CapabilityGap[]): { missing: number; partial: number; covered: number } {
  const acc = { missing: 0, partial: 0, covered: 0 };
  for (const g of gaps) acc[g.status] += 1;
  return acc;
}
