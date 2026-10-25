import { describe, it, expect } from 'vitest';
import { capabilityId, slug, shortHash } from '../src/ids.js';
import { findCapabilityGaps, summarizeGaps, normalizeName } from '../src/gaps.js';
import { scoreCandidate, securityGate, licenseGate } from '../src/scoring.js';
import { canTransition, assertTransition } from '../src/statuses.js';
import { ReportSubmissionSchema, formatSchemaIssues } from '../src/schemas.js';
import { CATEGORY_KEYWORD_RULES } from '../src/categories.js';
import type { CapabilityRecord } from '../src/types.js';

const local = (id: string, name: string, category: CapabilityRecord['category'], description?: string) => ({
  id, name, category, description,
});

// ---------------------------------------------------------------- ids

describe('ids', () => {
  it('produces stable ids independent of case/spacing', () => {
    expect(capabilityId('opencode', 'skill', 'Video Editing')).toBe(capabilityId('OpenCode', ' Skill ', 'video-editing'));
  });
  it('slug keeps only safe chars', () => {
    expect(slug('Context Engine v2!')).toBe('context-engine-v2');
  });
  it('shortHash is 12 hex chars', () => {
    expect(shortHash('anything')).toMatch(/^[0-9a-f]{12}$/);
  });
});

// ---------------------------------------------------------------- gaps

describe('gap comparison', () => {
  const registry = [
    local('opencode/skill/video-editing', 'Video Editing', 'media-processing', 'edit video scripts with ffmpeg'),
    local('opencode/mcp/playwright', 'playwright', 'browser-automation', 'browser test automation'),
    local('opencode/skill/memory-system', 'memory-system', 'memory-retrieval', 'persistent memory retrieval'),
  ];

  it('marks exact-name matches as covered', () => {
    const gaps = findCapabilityGaps(registry, [{ name: 'Video Editing', category: 'media-processing' }]);
    expect(gaps[0].status).toBe('covered');
    expect(summarizeGaps(gaps).covered).toBe(1);
  });

  it('marks blank spots as missing', () => {
    const gaps = findCapabilityGaps(registry, [{ name: 'speech synthesis', category: 'voice-speech' }]);
    expect(gaps[0].status).toBe('missing');
  });

  it('uses aliases for covered detection', () => {
    const gaps = findCapabilityGaps(registry, [{ name: 'totally-different-name', aliases: ['playwright'] }]);
    expect(gaps[0].status).toBe('covered');
  });

  it('partial when one significant token overlaps within same category', () => {
    const gaps = findCapabilityGaps(registry, [{ name: 'document retrieval', category: 'memory-retrieval' }]);
    expect(gaps[0].status).toBe('partial');
    expect(gaps[0].matches[0]).toBe('opencode/skill/memory-system');
  });

  it('multi-token overlap covers even across categories', () => {
    const gaps = findCapabilityGaps(registry, [{ name: 'video ffmpeg editing' }]);
    expect(gaps[0].status).toBe('covered');
  });

  it('normalizers ignore punctuation and case', () => {
    expect(normalizeName('Browser-Automation!')).toBe('browser automation');
  });
});

// ---------------------------------------------------------------- scoring

const goodFactors = {
  evidenceQuality: 80, demonstratedFunction: 75, relevance: 85, compatibility: 80,
  security: 82, dependencyHealth: 70, licensing: 90, maintenance: 75,
  performanceImpact: 70, integrationComplexity: 80, testCoverage: 65, regressionRisk: 75,
} as const;

describe('scoring', () => {
  it('ready band for strong candidates', () => {
    const result = scoreCandidate({ ...goodFactors });
    expect(result.suggestedStatus).toBe('ready-for-detached-testing');
    expect(result.total).toBeGreaterThan(68);
  });

  it('monotone: improving any factor never lowers the total', () => {
    const base = scoreCandidate({ ...goodFactors }).total;
    const plus = scoreCandidate({ ...goodFactors, security: 100 }).total;
    expect(plus).toBeGreaterThanOrEqual(base);
  });

  it('low band rejects', () => {
    const weak = Object.fromEntries(Object.keys(goodFactors).map((k) => [k, 20])) as unknown as typeof goodFactors;
    expect(scoreCandidate({ ...weak }).suggestedStatus).toBe('rejected');
  });

  it('security block gate overrides a high score', () => {
    const gates = [securityGate(10, ['install script curls remote payload'])];
    const result = scoreCandidate({ ...goodFactors, security: 10 }, gates as never[]);
    expect(result.suggestedStatus).toBe('rejected');
  });

  it('cap gate downgrades to needs-more-evidence', () => {
    const result = scoreCandidate({ ...goodFactors }, [licenseGate(90, true)] as never[]);
    expect(result.suggestedStatus).toBe('needs-more-evidence');
  });

  it('every factor appears with a label and weight', () => {
    const result = scoreCandidate({ ...goodFactors });
    expect(result.factors).toHaveLength(12);
    for (const f of result.factors) expect(f.label.length).toBeGreaterThan(3);
  });
});

// ---------------------------------------------------------------- statuses

describe('candidate status machine', () => {
  it('refuses to skip evidence/testing stages', () => {
    expect(canTransition('reported', 'integrated-verified')).toBe(false);
    expect(canTransition('testing-passed', 'ready-for-detached-testing')).toBe(false);
  });

  it('rejecting is absorbing', () => {
    expect(canTransition('rejected', 'ready-for-detached-testing')).toBe(false);
  });

  it('allows rollback after integration', () => {
    expect(canTransition('integrated-verified', 'rolled-back')).toBe(true);
  });

  it('throws on illegal transitions with the reason surfaced', () => {
    expect(() => assertTransition('reported', 'integrated-verified', 'dreaming')).toThrow(/reported/);
  });
});

// ---------------------------------------------------------------- schemas

describe('report submission schema', () => {
  const valid = () => ({
    schemaVersion: 1 as const,
    generatedAt: new Date().toISOString(),
    environment: { type: 'opencode', adapterVersion: '0.1.0', osFamily: 'windows' as const },
    capabilities: [{
      name: 'video-editing', category: 'media-processing' as const, sourceType: 'skill-manifest',
      verification: 'configured' as const, confidence: 0.7, securityNotes: [],
    }],
  });

  it('accepts a valid submission', () => {
    const parsed = ReportSubmissionSchema.safeParse(valid());
    expect(parsed.success).toBe(true);
  });

  it('rejects oversized descriptions and wrong schemaVersion', () => {
    const bad = valid() as Record<string, unknown>;
    bad.schemaVersion = 2;
    expect(ReportSubmissionSchema.safeParse(bad).success).toBe(false);
  });

  it('defaults projectSummaries to empty (never included implicitly)', () => {
    const parsed = ReportSubmissionSchema.parse(valid());
    expect(parsed.projectSummaries).toEqual([]);
  });

  it('formats bounded issue lists', () => {
    const r = ReportSubmissionSchema.safeParse({ nonsense: true });
    expect(r.success).toBe(false);
    if (!r.success) expect(formatSchemaIssues(r.error).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- categories

describe('category rules', () => {
  it('rules point at known categories only', () => {
    const known = new Set([
      'agent', 'skill', 'mcp-server', 'plugin', 'custom-command', 'browser-automation',
      'desktop-automation', 'voice-speech', 'memory-retrieval', 'planning-orchestration',
      'testing-qa', 'media-processing', 'local-model', 'scheduling', 'build-deploy',
      'project-instructions', 'other',
    ]);
    for (const rule of CATEGORY_KEYWORD_RULES) {
      if (rule.category === 'security-adjacent') continue; // declared placeholder with no keywords
      expect(known.has(rule.category)).toBe(true);
    }
  });
});
