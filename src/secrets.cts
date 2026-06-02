/**
 * Secrets handling — masking convention for API keys and other
 * credentials managed via /gsd-settings-integrations (ADR-457 build-at-publish:
 * the hand-written bin/lib/secrets.cjs collapsed to a TypeScript source of
 * truth). Behaviour is preserved byte-for-behaviour from the prior hand-written
 * .cjs; only types are added.
 *
 * This module does not read the filesystem.
 */

export const SECRET_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'brave_search',
  'firecrawl',
  'exa_search',
]);

export function isSecretKey(keyPath: string): boolean {
  return SECRET_CONFIG_KEYS.has(keyPath);
}

/** Scalar types that stringify meaningfully. */
type MaskableValue = string | number | boolean | null | undefined;

export function maskSecret(value: MaskableValue): string {
  if (value === null || value === undefined || value === '')
    return '(unset)';
  const s = String(value);
  if (s.length < 8)
    return '****';
  return '****' + s.slice(-4);
}

export function maskIfSecret(keyPath: string, value: MaskableValue): MaskableValue {
  return isSecretKey(keyPath) ? maskSecret(value) : value;
}
