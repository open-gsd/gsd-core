import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_RUNTIMES, type Runtime } from '../model-catalog.js';

interface RuntimeAliasManifest {
  [canonicalRuntime: string]: string[];
}

const MANIFEST_PATH = new URL('../shared/runtime-aliases.manifest.json', import.meta.url);
const manifest: RuntimeAliasManifest = JSON.parse(readFileSync(fileURLToPath(MANIFEST_PATH), 'utf-8'));

function normalizeRuntimeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s]+/g, '-');
}

const aliasToCanonical = new Map<string, Runtime>();
for (const runtime of SUPPORTED_RUNTIMES as Runtime[]) {
  aliasToCanonical.set(normalizeRuntimeToken(runtime), runtime);
}
for (const [canonical, aliases] of Object.entries(manifest)) {
  if (!(SUPPORTED_RUNTIMES as readonly string[]).includes(canonical)) continue;
  for (const alias of aliases) {
    if (typeof alias !== 'string') continue;
    aliasToCanonical.set(normalizeRuntimeToken(alias), canonical as Runtime);
  }
}

export function canonicalizeRuntimeName(value: unknown): Runtime | null {
  if (typeof value !== 'string') return null;
  return aliasToCanonical.get(normalizeRuntimeToken(value)) ?? null;
}
