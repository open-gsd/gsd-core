'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FALLBACK_ALIASES = {
  claude: ['claude', 'claude-code', 'claude-cli'],
  opencode: ['opencode', 'open-code', 'opencode-cli'],
  kilo: ['kilo', 'kilo-cli'],
  gemini: ['gemini', 'gemini-cli', 'gemini-code'],
  codex: ['codex', 'codex-app', 'codex-cli', 'codex_desktop', 'codex-desktop'],
  copilot: ['copilot', 'copilot-cli', 'github-copilot'],
  antigravity: ['antigravity', 'antigravity-cli', 'antigravity-agent'],
  cursor: ['cursor', 'cursor-cli', 'cursor-nightly'],
  windsurf: ['windsurf', 'windsurf-cli', 'windsurf-next'],
  augment: ['augment', 'augment-code', 'augment-cli'],
  trae: ['trae', 'trae-cli'],
  qwen: ['qwen', 'qwen-code', 'qwen-cli'],
  hermes: ['hermes', 'hermes-agent', 'hermes-cli'],
  codebuddy: ['codebuddy', 'codebuddy-cli'],
  cline: ['cline', 'cline-cli'],
};

function normalizeRuntimeToken(value) {
  return String(value).trim().toLowerCase().replace(/[_\s]+/g, '-');
}

function loadAliasManifest() {
  try {
    const manifestPath = path.resolve(__dirname, '../../../sdk/shared/runtime-aliases.manifest.json');
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // Fall through to fallback aliases.
  }
  return FALLBACK_ALIASES;
}

const aliasManifest = loadAliasManifest();
const aliasToCanonical = new Map();
for (const [canonical, aliases] of Object.entries(aliasManifest)) {
  if (typeof canonical !== 'string' || !Array.isArray(aliases)) continue;
  aliasToCanonical.set(normalizeRuntimeToken(canonical), normalizeRuntimeToken(canonical));
  for (const alias of aliases) {
    if (typeof alias !== 'string') continue;
    aliasToCanonical.set(normalizeRuntimeToken(alias), normalizeRuntimeToken(canonical));
  }
}

function canonicalizeRuntimeName(value) {
  if (typeof value !== 'string') return null;
  return aliasToCanonical.get(normalizeRuntimeToken(value)) || null;
}

module.exports = {
  canonicalizeRuntimeName,
};
