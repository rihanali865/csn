/**
 * Capability Swarm Network — shared capability model.
 *
 * Ground rules encoded in these types:
 * - `verification` deliberately separates *detection* (declared/configured)
 *   from *successful execution* (tested). Discovery never sets `tested`.
 * - `confidence` is derived from evidence type only, never from a claim made
 *   by the environment, a README or an agent.
 * - Paths are stored sanitized (home directory replaced with `~`).
 */
export type CapabilityCategory =
  | 'agent'
  | 'skill'
  | 'mcp-server'
  | 'plugin'
  | 'custom-command'
  | 'browser-automation'
  | 'desktop-automation'
  | 'voice-speech'
  | 'memory-retrieval'
  | 'planning-orchestration'
  | 'testing-qa'
  | 'media-processing'
  | 'local-model'
  | 'scheduling'
  | 'build-deploy'
  | 'project-instructions'
  | 'other';

/** How we know a capability exists. Ordered from weakest to strongest. */
export type EvidenceType =
  | 'config-entry' // present in a validated config file
  | 'files-on-disk' // supporting files exist and are readable
  | 'manifest-parse' // a manifest parsed successfully (SKILL.md frontmatter, JSON schema)
  | 'objective-documentation' // offline docs keyed by adapter id, not remote claims
  | 'runtime-observed' // e.g. adapter saw a lockfile/dir layout it did not run
  | 'executed-check'; // a capability-specific check actually ran and passed

export type VerificationStatus = 'declared' | 'configured' | 'tested' | 'failed';

export type Severity = 'info' | 'low' | 'medium' | 'high';

export interface SecurityNote {
  severity: Severity;
  message: string;
}

export interface Evidence {
  type: EvidenceType;
  /** Sanitized, human-readable statement of the observation. */
  detail: string;
  /** Sanitized path (home directory → `~`). */
  path?: string;
}

export interface CapabilityRecord {
  id: string;
  name: string;
  category: CapabilityCategory;
  description?: string;
  /** Adapter id, e.g. `opencode`. */
  environment: string;
  sourceType: string;
  /** Sanitized path. */
  sourcePath?: string;
  version?: string;
  dependencies?: string[];
  license?: string;
  evidence: Evidence[];
  verification: VerificationStatus;
  /** 0..1, derived deterministically from evidence strength. */
  confidence: number;
  securityNotes: SecurityNote[];
  lastVerifiedAt: string;
}

export interface EnvironmentAudit {
  adapterId: string;
  environmentName: string;
  detected: boolean;
  detectionEvidence: Evidence[];
  /** Sanitized config paths looked at / used; empty when not detected. */
  configurationPaths: string[];
  /** Only set from locally verifiable sources (config file, lockfile). Never a network call. */
  cliVersion?: string;
  capabilities: CapabilityRecord[];
  limitations: string[];
  errors: string[];
}

export interface AuditSummary {
  capabilities: number;
  byCategory: Record<string, number>;
  byVerification: Record<string, number>;
}

export interface AuditResult {
  schemaVersion: 1;
  generatedAt: string;
  wallTimeMs: number;
  environments: EnvironmentAudit[];
  summary: AuditSummary;
}

/** Any adapter must implement this. */
export interface EnvironmentAdapter {
  id: string;
  name: string;
  /** What this adapter can actually do — verified, honest claims only. */
  supports: {
    localAudit: boolean;
    sanitizedReporting: boolean;
    scheduledWork: boolean;
  };
  knownLimitations: string[];
  /** Returns a *synchronous* env audit (fs-only reads); must not throw on missing config — return detected:false. */
  audit(options: AuditOptions): EnvironmentAudit;
}

export interface AuditOptions {
  /** Extra project/config roots the user explicitly allowed in policy. */
  allowedRoots?: string[];
  /** Verify supporting files for declared config entries. */
  checkConfigured?: boolean;
  /** Hard cap per adapter so scans cannot explode. */
  maxCapabilities?: number;
  /** Override the user home used for path resolution (fixtures/tests). */
  homeRoot?: string;
}
