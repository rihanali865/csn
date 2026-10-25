import type { AuditResult, CapabilityRecord } from '@csn/core';
import { DesiredCapability, CapabilityGap, findCapabilityGaps, summarizeGaps } from '@csn/core';

/**
 * Gap report: compares the local registry (flat capabilities from an audit)
 * against a desired-capability profile (network-backed or fixture/backlog).
 * Pure and deterministic; every gap states its reason.
 */
export interface GapReport {
  generatedAt: string;
  /** target profile identity, e.g. 'network-default' | fixture name */
  targetId: string;
  gaps: CapabilityGap[];
  summary: { missing: number; partial: number; covered: number };
  registrySize: number;
}

export interface DesiredProfile {
  targetId: string;
  capabilities: DesiredCapability[];
}

/** TS can't exclude readonly arrays from Array.isArray's negative branch — use a predicate. */
function isAuditResult(local: readonly CapabilityRecord[] | AuditResult): local is AuditResult {
  return !Array.isArray(local);
}

export function buildGapReport(local: readonly CapabilityRecord[] | AuditResult, profile: DesiredProfile): GapReport {
  const flat = isAuditResult(local) ? local.environments.flatMap((env) => env.capabilities) : local;
  const gaps = findCapabilityGaps(flat.map((r) => ({ id: r.id, name: r.name, category: r.category, description: r.description })), profile.capabilities);
  return {
    generatedAt: new Date().toISOString(),
    targetId: profile.targetId,
    gaps,
    summary: summarizeGaps(gaps),
    registrySize: flat.length,
  };
}

/**
 * Default desirable-capability profile used by the CLI when no network
 * profile is configured. Deliberately small, public, and opinionated —
 * it's labeled as a *backlog profile*, not a network result.
 */
export const BACKLOG_PROFILE_ID = 'csn-backlog-v1';

export function backlogProfile(): DesiredProfile {
  return {
    targetId: BACKLOG_PROFILE_ID,
    capabilities: [
      { name: 'browser automation', category: 'browser-automation', aliases: ['playwright', 'browser testing'] },
      { name: 'desktop automation', category: 'desktop-automation', aliases: ['computer use'] },
      { name: 'speech synthesis', category: 'voice-speech', aliases: ['tts'] },
      { name: 'speech recognition', category: 'voice-speech', aliases: ['asr', 'transcription'] },
      { name: 'persistent memory retrieval', category: 'memory-retrieval', aliases: ['memory system', 'vector memory'] },
      { name: 'scheduling automation', category: 'scheduling', aliases: ['cron', 'scheduler'] },
      { name: 'video editing', category: 'media-processing', aliases: ['video editor'] },
      { name: 'test automation', category: 'testing-qa', aliases: ['test runner'] },
      { name: 'local model runtime', category: 'local-model', aliases: ['ollama'] },
      { name: 'build deployment tooling', category: 'build-deploy', aliases: ['ci', 'release tooling'] },
    ],
  };
}

/** `covered` means some local capability already satisfies the need. */
export function uncoveredGaps(report: GapReport): CapabilityGap[] {
  return report.gaps.filter((gap) => gap.status !== 'covered');
}
