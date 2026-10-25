import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Candidate } from './intake.js';

/**
 * Local-first candidate store. JSON file with atomic replace; no network.
 * Kept deliberately simple for v0.1 — designed so a future sqlite/served
 * backend can implement the same tiny interface.
 */
export interface MasterData {
  schemaVersion: 1;
  candidates: Candidate[];
  acceptedIntegrations: Array<{ id: string; at: string; note: string }>;
}

export interface MasterStoreOptions {
  /** When omitted: <home>/.config/csn/master/ */
  dataDir?: string;
  homeRoot?: string;
}

export function masterDataDir(options: MasterStoreOptions = {}): string {
  if (options.dataDir) return options.dataDir;
  const home = options.homeRoot ?? os.homedir();
  return path.join(home, '.config', 'csn', 'master');
}

export function defaultStoreFilePath(options: MasterStoreOptions = {}): string {
  return path.join(masterDataDir(options), 'data.json');
}

export function loadStore(options: MasterStoreOptions = {}): MasterData {
  const file = defaultStoreFilePath(options);
  try {
    if (!fs.existsSync(file)) return emptyData();
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as MasterData;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.candidates)) return emptyData();
    return parsed;
  } catch {
    return emptyData();
  }
}

export function emptyData(): MasterData {
  return { schemaVersion: 1, candidates: [], acceptedIntegrations: [] };
}

export function saveStore(data: MasterData, options: MasterStoreOptions = {}): string {
  const dir = masterDataDir(options);
  fs.mkdirSync(dir, { recursive: true });
  const file = defaultStoreFilePath(options);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

export function upsertCandidate(candidate: Candidate, options: MasterStoreOptions = {}): MasterData {
  const data = loadStore(options);
  const index = data.candidates.findIndex((c) => c.id === candidate.id);
  if (index >= 0) data.candidates[index] = candidate;
  else data.candidates.push(candidate);
  if (data.candidates.length > 500) data.candidates.splice(0, data.candidates.length - 500); // bounded
  saveStore(data, options);
  return data;
}

export function recordAcceptedIntegration(id: string, note: string, options: MasterStoreOptions = {}): MasterData {
  const data = loadStore(options);
  data.acceptedIntegrations.push({ id, at: new Date().toISOString(), note });
  saveStore(data, options);
  return data;
}
