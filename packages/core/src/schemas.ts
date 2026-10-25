import { z } from 'zod';

/**
 * Network submission contract (schema version 1).
 *
 * Everything in here is data-minimized by design:
 * - no file paths, no home directory, no hostnames
 * - capability descriptions are capped at 300 chars
 * - project summaries are an explicit, separately-gated feature
 */
export const CAPABILITY_CATEGORIES_AS_ARRAY = [
  'agent', 'skill', 'mcp-server', 'plugin', 'custom-command',
  'browser-automation', 'desktop-automation', 'voice-speech',
  'memory-retrieval', 'planning-orchestration', 'testing-qa',
  'media-processing', 'local-model', 'scheduling', 'build-deploy',
  'project-instructions', 'other',
] as const;

export const VERIFICATION_STATUSES = ['declared', 'configured', 'tested', 'failed'] as const;

export const SanitizedCapabilitySchema = z.object({
  name: z.string().min(1).max(120),
  category: z.enum(CAPABILITY_CATEGORIES_AS_ARRAY),
  description: z.string().max(300).optional(),
  sourceType: z.string().max(60),
  verification: z.enum(VERIFICATION_STATUSES),
  confidence: z.number().min(0).max(1),
  version: z.string().max(40).optional(),
  license: z.string().max(120).optional(),
  securityNotes: z.array(z.string().max(200)).max(4).default([]),
});

export const ProjectSummarySchema = z.object({
  /** Short, user-supplied-or-derived purpose statement. No confidential inference. */
  purpose: z.string().min(1).max(240),
  categories: z.array(z.string().max(40)).max(6),
  techStack: z.array(z.string().max(40)).max(12),
  sizeClass: z.enum(['tiny', 'small', 'medium', 'large']),
  /** What the summary is based on. We only ever publish manifest/docs-derived summaries. */
  evidenceBasis: z.enum(['manifest-only', 'manifest-and-readme-head']),
});

export const ReportSubmissionSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime(),
  environment: z.object({
    type: z.string().max(40),
    adapterVersion: z.string().max(40),
    osFamily: z.enum(['windows', 'macos', 'linux', 'other']),
  }),
  capabilities: z.array(SanitizedCapabilitySchema).max(500),
  projectSummaries: z.array(ProjectSummarySchema).max(10).default([]),
  notes: z.string().max(400).optional(),
});

export type ReportSubmission = z.infer<typeof ReportSubmissionSchema>;
export type SanitizedCapability = z.infer<typeof SanitizedCapabilitySchema>;

/** Task delivered to an installation for its scheduled capability review. */
export const ScheduledTaskSchema = z.object({
  taskId: z.string().min(4).max(64),
  type: z.literal('scheduled-review'),
  issuedAt: z.string().datetime(),
  dueAt: z.string().datetime(),
  instructions: z.string().max(600),
});

export type ScheduledTask = z.infer<typeof ScheduledTaskSchema>;

/** Aggregated, non-identifying capability profiles served back to installs. */
export const CapabilityProfileSchema = z.object({
  name: z.string().min(1).max(120),
  category: z.enum(CAPABILITY_CATEGORIES_AS_ARRAY),
  installationsSeen: z.number().int().min(1),
  avgConfidence: z.number().min(0).max(1),
  sampleLicense: z.string().max(120).optional(),
});

export type CapabilityProfile = z.infer<typeof CapabilityProfileSchema>;

/** Malformed submissions are rejected per-field; error shapes stay informative but bounded. */
export function formatSchemaIssues(error: z.ZodError): string[] {
  return error.issues.slice(0, 12).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
}
