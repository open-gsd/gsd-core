/**
 * Runtime name policy — alias resolution and canonicalization for GSD runtime
 * identifiers (ADR-457 build-at-publish: the hand-written
 * bin/lib/runtime-name-policy.cjs collapsed to a TypeScript source of truth).
 * Behaviour is preserved byte-for-behaviour from the prior hand-written .cjs;
 * only types are added.
 *
 * Group C cross-import candidate: no bin/lib sibling dependencies; only
 * node:fs and node:path. Once this module is migrated, runtime-slash.cjs
 * (which imports runtime-name-policy.cjs) becomes the first true cross-import
 * proof candidate.
 */

import fs from 'node:fs';
import path from 'node:path';

const FALLBACK_ALIASES: Readonly<Record<string, string[]>> = {
  claude: ['claude', 'claude-code', 'claude-cli'],
  opencode: ['opencode', 'open-code', 'opencode-cli'],
  kilo: ['kilo', 'kilo-cli'],
  gemini: ['gemini', 'gemini-cli', 'gemini-code'],
  codex: ['codex', 'codex-app', 'codex-cli', 'codex_desktop', 'codex-desktop'],
  copilot: ['copilot', 'copilot-cli', 'github-copilot'],
  antigravity: ['antigravity', 'antigravity-cli', 'antigravity-agent'],
  cursor: ['cursor', 'cursor-cli', 'cursor-nightly'],
  windsurf: ['windsurf', 'windsurf-cli', 'windsurf-next', 'devin-desktop'],
  augment: ['augment', 'augment-code', 'augment-cli'],
  trae: ['trae', 'trae-cli'],
  qwen: ['qwen', 'qwen-code', 'qwen-cli'],
  hermes: ['hermes', 'hermes-agent', 'hermes-cli'],
  kimi: ['kimi'],
  codebuddy: ['codebuddy', 'codebuddy-cli'],
  cline: ['cline', 'cline-cli'],
};

function normalizeRuntimeToken(value: string): string {
  return String(value).trim().toLowerCase().replace(/[_\s]+/g, '-');
}

function loadAliasManifest(): Record<string, string[]> {
  const manifestCandidates = [
    path.resolve(__dirname, '..', 'shared', 'runtime-aliases.manifest.json'),
    path.resolve(__dirname, '../../../sdk/shared/runtime-aliases.manifest.json'),
  ];
  for (const manifestPath of manifestCandidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object') return parsed as Record<string, string[]>;
    } catch {
      // Try next candidate.
    }
  }
  return { ...FALLBACK_ALIASES };
}

const aliasManifest = loadAliasManifest();
const aliasToCanonical = new Map<string, string>();
for (const [canonical, aliases] of Object.entries(aliasManifest)) {
  if (typeof canonical !== 'string' || !Array.isArray(aliases)) continue;
  aliasToCanonical.set(normalizeRuntimeToken(canonical), normalizeRuntimeToken(canonical));
  for (const alias of aliases) {
    if (typeof alias !== 'string') continue;
    aliasToCanonical.set(normalizeRuntimeToken(alias), normalizeRuntimeToken(canonical));
  }
}

export function canonicalizeRuntimeName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return aliasToCanonical.get(normalizeRuntimeToken(value)) || null;
}

/**
 * Resolve runtime from a precedence list of candidate values.
 *
 * - First non-empty string candidate wins.
 * - Known aliases are canonicalized (codex-cli -> codex).
 * - Unknown values are normalized and returned (future-runtime tolerance).
 *
 * @param candidates - string candidates in precedence order
 * @returns the resolved runtime name, or null if no valid candidate
 */
export function resolveRuntimeNameFromCandidates(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const normalized = normalizeRuntimeToken(candidate);
    if (!normalized) continue;
    return canonicalizeRuntimeName(normalized) || normalized;
  }
  return null;
}

/**
 * Map a canonical runtime id to its on-disk local config directory name
 * (e.g. `cursor` -> `.cursor`, `windsurf` -> `.devin`). Unknown/empty inputs
 * fall back to `.claude`.
 *
 * Pure runtime-identity projection. Relocated from `bin/install.js` per
 * ADR-1508 (epic #1507, #1510 Phase 1) so the Runtime Artifact Conversion
 * Module's rewrite engine can consume it without importing the installer.
 * `bin/install.js` re-exports this same function for back-compat.
 */
export function getDirName(runtime: string): string {
  if (runtime === 'copilot') return '.github';
  if (runtime === 'opencode') return '.opencode';
  if (runtime === 'gemini') return '.gemini';
  if (runtime === 'kilo') return '.kilo';
  if (runtime === 'codex') return '.codex';
  if (runtime === 'antigravity') return '.agents';
  if (runtime === 'cursor') return '.cursor';
  if (runtime === 'windsurf') return '.devin';
  if (runtime === 'augment') return '.augment';
  if (runtime === 'trae') return '.trae';
  if (runtime === 'qwen') return '.qwen';
  if (runtime === 'hermes') return '.hermes';
  if (runtime === 'kimi') return '.kimi-code';
  if (runtime === 'codebuddy') return '.codebuddy';
  if (runtime === 'cline') return '.cline';
  return '.claude';
}
