import { spawnSync } from 'node:child_process';

const cache = new Map<string, boolean>();

/**
 * Checks whether a command is resolvable on PATH **without running it**.
 * Uses `where` (Windows) / `which` (POSIX). This is a dependency check,
 * never an execution.
 */
export function hasExecutable(command: string): boolean {
  const key = `${process.platform}:${command}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  let resolvable = false;
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(cmd, [command], { timeout: 4000, windowsHide: true });
    resolvable = result.status === 0;
  } catch {
    resolvable = false;
  }
  cache.set(key, resolvable);
  return resolvable;
}
