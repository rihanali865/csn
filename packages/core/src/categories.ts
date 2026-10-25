/**
 * Capability categories with human labels and keyword rules used by the
 * deterministic classifier (packages/discovery). Keyword rules are an
 * evidence-improvement, not evidence replacement: they only refine the
 * category of something whose *existence* was already verified on disk.
 */
import type { CapabilityCategory } from './types.js';

export const CAPABILITY_CATEGORIES = [
  'agent',
  'skill',
  'mcp-server',
  'plugin',
  'custom-command',
  'browser-automation',
  'desktop-automation',
  'voice-speech',
  'memory-retrieval',
  'planning-orchestration',
  'testing-qa',
  'media-processing',
  'local-model',
  'scheduling',
  'build-deploy',
  'project-instructions',
  'other',
] as const;

export type CategoryKeywordRule = { category: string; keywords: string[] };

/**
 * Order matters: first matching rule wins. Keywords are matched against the
 * capability's name + description (lowercased). These are intentionally
 * conservative — anything not confidently matched stays 'other' or keeps the
 * structurally-derived category.
 */
export const CATEGORY_KEYWORD_RULES: CategoryKeywordRule[] = [
  { category: 'browser-automation', keywords: ['browser', 'playwright', 'selenium', 'dom automation', 'web driver', 'webdriver', 'page test'] },
  { category: 'desktop-automation', keywords: ['desktop control', 'computer use', 'screen control', 'mouse', 'keyboard automation', 'desktop automation'] },
  { category: 'voice-speech', keywords: ['speech', 'voice', 'transcri', 'text-to-speech', 'tts', 'asr', 'dictation'] },
  { category: 'memory-retrieval', keywords: ['memory', 'retriev', 'recall', 'vector store', 'embedding search', 'context engine', 'knowledge base'] },
  { category: 'testing-qa', keywords: ['test runner', 'qa', 'explorator', 'playtest', 'regression', 'coverage', 'e2e', 'spec-review'] },
  { category: 'media-processing', keywords: ['video', 'audio', 'image', 'sprite', 'asset generation', 'art-generation', 'subtitle', 'render'] },
  { category: 'local-model', keywords: ['local model', 'llama', 'ollama', 'gpt4all', 'local inference'] },
  { category: 'scheduling', keywords: ['cron', 'schedule', 'timer', 'weekly', 'interval'] },
  { category: 'build-deploy', keywords: ['deploy', 'ci', 'release', 'package', 'docker', 'pipeline', 'build'] },
  { category: 'planning-orchestration', keywords: ['orchestrat', 'planner', 'goal', 'swarm', 'dagent', 'task graph', 'roadmap', 'blueprint', 'loop controller', 'coordinat'] },
];

/** Structural kind derived from source location (most reliable signal). */
export type SourceKind = 'agent' | 'skill' | 'mcp' | 'plugin' | 'command' | 'config' | 'instruction-file';

export const STRUCTURAL_KIND_TO_CATEGORY: Record<SourceKind, CapabilityCategory> = {
  agent: 'agent',
  skill: 'skill',
  mcp: 'mcp-server',
  plugin: 'plugin',
  command: 'custom-command',
  config: 'other',
  'instruction-file': 'project-instructions',
};

export const CATEGORY_LABELS: Record<CapabilityCategory, string> = {
  agent: 'Custom agents',
  skill: 'Skills / instructions',
  'mcp-server': 'MCP integrations',
  plugin: 'Plugins',
  'custom-command': 'Custom commands',
  'browser-automation': 'Browser automation',
  'desktop-automation': 'Desktop automation',
  'voice-speech': 'Voice / speech',
  'memory-retrieval': 'Memory & retrieval',
  'planning-orchestration': 'Planning & orchestration',
  'testing-qa': 'Testing & QA',
  'media-processing': 'Image / audio / video',
  'local-model': 'Local models',
  scheduling: 'Scheduling & automation',
  'build-deploy': 'Build & deployment',
  'project-instructions': 'Project instructions',
  other: 'Other',
};
