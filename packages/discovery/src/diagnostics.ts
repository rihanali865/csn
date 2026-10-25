/** Task-recovery & diagnostics (spec §4 Problem C). */
import { createHash } from 'node:crypto';

export type TaskFailureClass =
  | 'missing-dependency'
  | 'failed-tool-call'
  | 'repeated-retry'
  | 'stale-state'
  | 'config-failure'
  | 'incomplete-verification'
  | 'unverified-success'
  | 'interrupted'
  | 'unknown';

export interface TaskSignal {
  taskId: string;
  startedAt: string;
  updatedAt: string;
  toolCalls: Array<{ name: string; ok: boolean; at: string; error?: string }>;
  retries: number;
  declaredSuccess: boolean;
  verificationRan: boolean;
  stateMarkers?: Record<string, unknown>;
}

export interface Diagnosis {
  taskId: string;
  failureClasses: TaskFailureClass[];
  resumable: boolean;
  evidence: string[];
  recommendations: string[];
}

const RETRY_SATURATION = 3;

/**
 * Classify an interrupted/failed agent task from observed signals only.
 * No LLM heuristics: deterministic rules over the supplied structured state.
 */
export function diagnoseTask(signal: TaskSignal): Diagnosis {
  const failureClasses: TaskFailureClass[] = [];
  const evidence: string[] = [];
  const recommendations: string[] = [];

  const failedCalls = signal.toolCalls.filter((c) => !c.ok);
  if (failedCalls.some((c) => /spawn|ENOENT|command not found|not recognized/i.test(c.error ?? ''))) {
    failureClasses.push('missing-dependency');
    evidence.push(`tool call failed with missing-binary style error: ${failedCalls.find((c) => /spawn|ENOENT/i.test(c.error ?? ''))?.name}`);
    recommendations.push('install the missing dependency, or record the requirement in the project setup docs');
  }

  if (failedCalls.length > 0) {
    failureClasses.push('failed-tool-call');
    evidence.push(`${failedCalls.length} of ${signal.toolCalls.length} tool calls failed`);
  }

  if (signal.retries > RETRY_SATURATION) {
    failureClasses.push('repeated-retry');
    evidence.push(`${signal.retries} retries recorded (threshold ${RETRY_SATURATION})`);
    recommendations.push('stop retrying the same step; capture the failing input and inspect it directly');
  }

  const ageMs = Date.parse(signal.updatedAt) - Date.parse(signal.startedAt);
  if (!Number.isNaN(ageMs) && ageMs > 15 * 60 * 1000 && failedCalls.length > 0) {
    failureClasses.push('stale-state');
    evidence.push(`state unchanged for over 15 minutes with failures present`);
    recommendations.push('re-run the task from a checkpoint, or clear stale state markers');
  }

  if (signal.declaredSuccess && !signal.verificationRan) {
    failureClasses.push('unverified-success');
    evidence.push('task declared success without running a verification step');
    recommendations.push('report this task as suspect; run an explicit verification pass before accepting the result');
  }

  if (signal.declaredSuccess && signal.verificationRan && failedCalls.length === 0) {
    recommendations.push('task looks healthy: declared success backed by a verification run and no failed calls');
  } else if (!signal.declaredSuccess) {
    failureClasses.push('interrupted');
    evidence.push('no successful declaration recorded');
    recommendations.push('resume from the last surviving checkpoint once the failure classes above are resolved');
  }

  if (failureClasses.length === 0) {
    failureClasses.push('unknown');
    recommendations.push('no rule matched; capture richer tool logs and re-run diagnosis');
  }

  const resumable = !signal.declaredSuccess && !failureClasses.includes('unverified-success');

  return { taskId: signal.taskId, failureClasses, resumable, evidence, recommendations };
}

export interface ResumePlan {
  taskId: string;
  checkpoint: string;
  steps: string[];
}

/** Build a bounded resume plan: only when diagnosis says resumable. */
export function buildResumePlan(diagnosis: Diagnosis, lastCheckpoint: string, steps: string[]): ResumePlan | null {
  if (!diagnosis.resumable || lastCheckpoint === '' || steps.length === 0) return null;
  return { taskId: diagnosis.taskId, checkpoint: lastCheckpoint, steps };
}

export function taskSignature(signal: TaskSignal): string {
  return createHash('sha256').update(JSON.stringify(signal.toolCalls)).digest('hex').slice(0, 16);
}
