import * as os from 'node:os';
import type { AuditOptions, CapabilityRecord, CapabilityCategory } from '@csn/core';
import { verificationFromEvidence, computeConfidence, capabilityId, STRUCTURAL_KIND_TO_CATEGORY } from '@csn/core';

export interface AuditOptionDefaults {
  homeRoot: string;
  maxCapabilities: number;
  checkConfigured: boolean;
  allowedRoots: string[];
}

export function auditOptionsDefaults(options: AuditOptions): AuditOptionDefaults {
  return {
    homeRoot: options.homeRoot ?? os.homedir(),
    maxCapabilities: options.maxCapabilities ?? 400,
    checkConfigured: options.checkConfigured ?? true,
    allowedRoots: options.allowedRoots ?? [],
  };
}

/**
 * Bundle structural kind + evidence into one record. Used by every adapter so
 * verification + confidence stay consistent across environments.
 */
export function buildRecord(input: {
  name: string;
  sourceType: string;
  sourcePath?: string;
  kind: keyof typeof STRUCTURAL_KIND_TO_CATEGORY;
  environment?: string;
  description?: string;
  license?: string;
  version?: string;
  dependencies?: string[];
  evidenceList: CapabilityRecord['evidence'];
  securityNotes?: CapabilityRecord['securityNotes'];
}): CapabilityRecord {
  const category: CapabilityCategory = STRUCTURAL_KIND_TO_CATEGORY[input.kind];
  return {
    id: capabilityId(input.environment ?? 'unknown-env', input.sourceType, input.name, input.version),
    name: input.name,
    category,
    description: input.description,
    environment: input.environment ?? 'unknown-env',
    sourceType: input.sourceType,
    sourcePath: input.sourcePath,
    version: input.version,
    dependencies: input.dependencies,
    license: input.license,
    evidence: input.evidenceList,
    verification: verificationFromEvidence(input.evidenceList),
    confidence: computeConfidence(input.evidenceList),
    securityNotes: input.securityNotes ?? [],
    lastVerifiedAt: new Date().toISOString(),
  };
}
