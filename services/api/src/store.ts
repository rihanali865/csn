import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ReportSubmission, ScheduledTask } from '@csn/core';

/**
 * API storage layer. All records are server-side; a report payload stored here
 * is already schema-validated and secret-free. Two implementations:
 *  - InMemoryStore  (tests,ephemeral)
 *  - FileStore      (single-node deployment, atomic JSON file under ~/.config/csn)
 */

export interface TokenRecord {
  tokenId: string;
  installationId: string;
  /** sha256 hex of the raw token; the raw token itself is never persisted. */
  tokenHash: string;
  scopes: string[];
  createdAt: string;
  revokedAt?: string;
  lastUsedAt?: string;
}

export interface InstallationRecord {
  installationId: string;
  label?: string;
  createdAt: string;
}

export interface ReportRecord {
  submissionId: string;
  installationId: string;
  receivedAt: string;
  payload: ReportSubmission;
  /** sha256 of the canonical payload — used for replay/idempotency detection. */
  requestHash: string;
}

export interface SubmissionAckRecord {
  status: 'completed' | 'declined' | 'failed';
  note?: string;
  at: string;
}

export interface TaskRecord {
  task: ScheduledTask;
  installationId: string;
  createdAt: string;
  deliveredAt?: string;
  ack?: SubmissionAckRecord;
}

export interface ApiStore {
  installations: InstallationRecord[];
  tokens: TokenRecord[];
  reports: ReportRecord[];
  tasks: TaskRecord[];
}

export interface ApiStoreApi {
  readonly data: ApiStore;
  save(): void;
}

export class InMemoryStore implements ApiStoreApi {
  readonly data: ApiStore;
  constructor(initial?: Partial<ApiStore>) {
    this.data = {
      installations: initial?.installations ?? [],
      tokens: initial?.tokens ?? [],
      reports: initial?.reports ?? [],
      tasks: initial?.tasks ?? [],
    };
  }
  save(): void {
    /* ephemeral */
  }
}

/**
 * JSON-file store with atomic writes (tmp file + rename). Never stores raw
 * tokens — only their sha256. Data lives under the CSN config dir by default
 * and must never be committed (gitignore covers csn-data/).
 */
export class FileStore implements ApiStoreApi {
  readonly data: ApiStore;
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = loadStoreFile(filePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  save(): void {
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    try {
      // Windows rename over an existing file needs a two-step swap.
      if (fs.existsSync(this.filePath)) fs.rmSync(this.filePath, { force: true });
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
      throw err;
    }
  }
}

function loadStoreFile(filePath: string): ApiStore {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<ApiStore>;
    return {
      installations: Array.isArray(raw.installations) ? raw.installations : [],
      tokens: Array.isArray(raw.tokens) ? raw.tokens : [],
      reports: Array.isArray(raw.reports) ? raw.reports : [],
      tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
    };
  } catch {
    return { installations: [], tokens: [], reports: [], tasks: [] };
  }
}
