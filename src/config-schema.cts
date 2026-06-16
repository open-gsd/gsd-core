/**
 * Thin adapter — sources schema data from the manifest via the generated
 * Configuration Module. All inline literals have been removed; the manifest
 * at gsd-core/bin/shared/config-schema.manifest.json is the single source of truth.
 *
 * Imported by:
 *   - config.cjs (isValidConfigKey validator)
 *   - many tests (config-schema.property.test.cjs, bug-*, feat-*, etc.)
 * (core.cjs re-export spine retired in epic #1267)
 *
 * See Phase 2 Cycle 5 (#3536) — schema manifest migration.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/config-schema.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour from
 * the prior hand-written .cjs; only types are added.
 */

import {
  VALID_CONFIG_KEYS,
  RUNTIME_STATE_KEYS,
  DYNAMIC_KEY_PATTERNS,
} from './configuration.cjs';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const capabilityRegistry = require('./capability-registry.cjs') as {
  configSchema?: Record<string, unknown>;
};

function isCapabilityConfigKey(keyPath: string): boolean {
  if (typeof keyPath !== 'string') return false;
  const schema = capabilityRegistry.configSchema;
  if (!schema || typeof schema !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(schema, keyPath);
}

/**
 * Returns true for keys owned by the central schema adapter rather than a
 * federated Capability config slice.
 */
function isCentralConfigKey(keyPath: string): boolean {
  if (typeof keyPath !== 'string') return false;
  if (VALID_CONFIG_KEYS.has(keyPath)) return true;
  if (RUNTIME_STATE_KEYS.has(keyPath)) return true;
  return DYNAMIC_KEY_PATTERNS.some((p) => p.test(keyPath));
}

/**
 * Returns true if keyPath is a valid central, runtime-state, dynamic, or
 * federated Capability config key.
 */
function isValidConfigKey(keyPath: string): boolean {
  if (isCentralConfigKey(keyPath)) return true;
  return isCapabilityConfigKey(keyPath);
}

export = {
  VALID_CONFIG_KEYS,
  RUNTIME_STATE_KEYS,
  DYNAMIC_KEY_PATTERNS,
  isCapabilityConfigKey,
  isCentralConfigKey,
  isValidConfigKey,
};
