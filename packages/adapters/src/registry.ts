import type { EnvironmentAdapter } from '@csn/core';
import { createOpenCodeAdapter } from './opencode.js';
import { createClaudeCodeAdapter } from './claude-code.js';
import { createCodexAdapter } from './codex.js';
import { createCursorAdapter } from './cursor.js';

/**
 * Builtin adapter registry. Adding another environment = implement
 * `EnvironmentAdapter` (read-only, honest `supports`), then append here.
 */
export class AdapterRegistry {
  private readonly adapters: EnvironmentAdapter[];

  constructor(adapters: EnvironmentAdapter[] = getBuiltinAdapters()) {
    this.adapters = [...adapters];
  }

  list(): EnvironmentAdapter[] {
    return [...this.adapters];
  }

  has(adapterId: string): boolean {
    return this.adapters.some((adapter) => adapter.id === adapterId);
  }

  register(adapter: EnvironmentAdapter): void {
    if (this.adapters.some((existing) => existing.id === adapter.id)) {
      throw new Error(`adapter already registered: ${adapter.id}`);
    }
    this.adapters.push(adapter);
  }
}

export function getBuiltinAdapters(): EnvironmentAdapter[] {
  return [createOpenCodeAdapter(), createClaudeCodeAdapter(), createCodexAdapter(), createCursorAdapter()];
}
