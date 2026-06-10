/**
 * Federated Config — Defensive merge of capability-declared config keys
 *
 * ADR-857 phase 3b: wires the Capability Registry's configSchema into
 * loadConfig as a provably-empty no-op channel until capability keys are
 * migrated out of the central config-schema.
 *
 * Exported function:
 *   mergeFederatedConfig({ configSchema, isCentralKey, userConfig })
 *     → { values, validKeys, warnings }
 *
 * Design:
 *   - For each key in configSchema:
 *       If isCentralKey(key) → SKIP; push a pending-migration warning.
 *       Else if slice is malformed → SKIP; push a warning. Never throw.
 *       Else (valid federated key absent from central):
 *         resolvedValue = nested userConfig lookup if present & type-matches; else slice.default.
 *         Add key→resolvedValue to values; add key to validKeys.
 *   - Guard all object writes with inline literal __proto__/constructor/prototype checks.
 *   - Zero external dependencies; no ajv; hand-rolled type checks only.
 *
 * ADR-857 no-op guarantee:
 *   With the current registry, every UI key is still present in the central
 *   config-schema, so isCentralKey() returns true for all of them and values
 *   is always empty. The channel is live but carries no traffic until a key
 *   is atomically removed from the central schema (the cutover step).
 *
 * Dependencies: none (zero-dep module).
 */

// ─── Types ─────────────────────────────────────────────────────────────────────

/** Shape of one entry in the capability registry's configSchema index. */
interface ConfigSliceEntry {
  owner: string;
  type: string;
  default: unknown;
  description: string;
  values?: string[];  // required for enum type
  [key: string]: unknown;
}

interface MergeFederatedConfigInput {
  /** configSchema index from the capability registry: { [key]: ConfigSliceEntry } */
  configSchema: Record<string, unknown>;
  /** Returns true if the given key is owned by the central config-schema. */
  isCentralKey: (key: string) => boolean;
  /** The raw/merged user config object already loaded in loadConfig. */
  userConfig: Record<string, unknown>;
}

interface MergeFederatedConfigResult {
  /** Resolved values for federated (non-central) keys: { key → resolvedValue } */
  values: Record<string, unknown>;
  /** Array of keys that are now valid federated keys (i.e. were added to values). */
  validKeys: string[];
  /** Human-readable diagnostic strings (pending-migration, malformed-slice, type-mismatch). */
  warnings: string[];
}

// ─── Allowed slice types (mirrors gen-capability-registry.cjs VALID_CONFIG_SLICE_TYPES) ──

const VALID_SLICE_TYPES = new Set<string>(['boolean', 'string', 'number', 'enum']);

// ─── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Returns true if `slice` has a non-empty type, a `default` property, and a
 * non-empty string description. Does NOT throw.
 */
function _isWellFormedSlice(slice: unknown): slice is ConfigSliceEntry {
  if (typeof slice !== 'object' || slice === null || Array.isArray(slice)) return false;
  const s = slice as Record<string, unknown>;
  if (typeof s['type'] !== 'string' || s['type'].length === 0) return false;
  if (!VALID_SLICE_TYPES.has(s['type'])) return false;
  if (!Object.prototype.hasOwnProperty.call(s, 'default')) return false;
  return true;
}

/**
 * Returns true if `value` matches the declared type in the slice.
 * For enum, also validates against slice.values if present.
 */
function _typeMatches(value: unknown, slice: ConfigSliceEntry): boolean {
  switch (slice.type) {
    case 'boolean': return typeof value === 'boolean';
    case 'string':  return typeof value === 'string';
    case 'number':  return typeof value === 'number';
    case 'enum':
      // Must be a string AND, if values list is present, must be in it
      if (typeof value !== 'string') return false;
      if (Array.isArray(slice.values) && slice.values.length > 0) {
        return slice.values.includes(value);
      }
      return true;
    default:        return false;
  }
}

/**
 * Traverse a dotted key path through a nested config object.
 * E.g. key="workflow.ui_phase", obj={workflow:{ui_phase:false}} → {found:true, value:false}
 * Returns {found:false} if any segment is missing or not an own property.
 * Handles 1, 2, or N segments generically.
 */
function _getNestedValue(obj: Record<string, unknown>, key: string): { found: boolean; value: unknown } {
  const segments = key.split('.');
  let current: unknown = obj;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    // Inline literal prototype-pollution guard
    if (seg === '__proto__' || seg === 'constructor' || seg === 'prototype') {
      return { found: false, value: undefined };
    }
    if (typeof current !== 'object' || current === null) {
      return { found: false, value: undefined };
    }
    const cur = current as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) {
      return { found: false, value: undefined };
    }
    current = cur[seg];
  }
  return { found: true, value: current };
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Defensive merge of capability-declared config slices into the loadConfig
 * return value.
 *
 * DEFENSIVE contract (never throws, even on bad capability data):
 *   - Null/undefined/non-object input → returns empty result.
 *   - Null/undefined/non-object userConfig → treated as {} (no overrides).
 *   - Central keys are skipped with a pending-migration warning.
 *   - Malformed slices are skipped with a warning.
 *   - User-supplied values with wrong types (or out-of-enum values) fall back
 *     to the slice default (a type-mismatch warning is pushed but the key is
 *     still federated with its default; this is best-effort degraded operation).
 */
function mergeFederatedConfig(input: MergeFederatedConfigInput): MergeFederatedConfigResult {
  // FIX 4: Guard null/undefined/non-object input
  if (input === null || input === undefined || typeof input !== 'object') {
    return { values: Object.create(null) as Record<string, unknown>, validKeys: [], warnings: [] };
  }

  const { configSchema, isCentralKey } = input;

  // FIX 4: Guard null/undefined/non-object userConfig — treat as {}
  const userConfig: Record<string, unknown> =
    (input.userConfig !== null && input.userConfig !== undefined && typeof input.userConfig === 'object' && !Array.isArray(input.userConfig))
      ? input.userConfig
      : {};

  // FIX 6b: Use null-prototype object for all return paths
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const validKeys: string[] = [];
  const warnings: string[] = [];

  if (typeof configSchema !== 'object' || configSchema === null) {
    return { values: Object.create(null) as Record<string, unknown>, validKeys: [], warnings: [] };
  }

  for (const key of Object.keys(configSchema)) {
    // S2: inline literal prototype-pollution guard (CodeQL barrier)
    // Guard both the full key AND all dotted-path segments
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const _keySegments = key.split('.');
    if (_keySegments.some((s) => s === '__proto__' || s === 'constructor' || s === 'prototype')) continue;

    const slice = configSchema[key];

    // If this key is still in the central schema → pending migration, skip
    try {
      if (isCentralKey(key)) {
        warnings.push(
          'federated-config: key "' + key + '" is still in the central config-schema (pending-migration); ' +
          'skipping federated resolution until the central schema entry is removed',
        );
        continue;
      }
    } catch {
      // isCentralKey threw — treat as unknown, skip defensively
      warnings.push('federated-config: isCentralKey("' + key + '") threw; skipping key');
      continue;
    }

    // Validate slice shape — skip malformed entries
    if (!_isWellFormedSlice(slice)) {
      warnings.push(
        'federated-config: config slice for key "' + key + '" is malformed (missing or invalid type/default); skipping',
      );
      continue;
    }

    const sliceEntry = slice;

    // FIX 1: Resolve value using NESTED dotted-path lookup through userConfig
    let resolvedValue: unknown = sliceEntry.default;
    const { found: userHasKey, value: userValue } = _getNestedValue(userConfig, key);
    if (userHasKey && userValue !== undefined) {
      // FIX 5b: For enum, validate against slice.values if present; otherwise check type
      if (_typeMatches(userValue, sliceEntry)) {
        resolvedValue = userValue;
      } else {
        const typeDesc = sliceEntry.type === 'enum' && Array.isArray(sliceEntry.values)
          ? 'enum(' + sliceEntry.values.join('|') + ')'
          : sliceEntry.type;
        warnings.push(
          'federated-config: user-supplied value for "' + key + '" has wrong type or invalid enum value ' +
          '(expected ' + typeDesc + ', got ' + typeof userValue +
          (typeof userValue === 'string' ? ' "' + String(userValue) + '"' : '') +
          '); falling back to slice default',
        );
        // resolvedValue stays as slice default
      }
    }

    // S2: inline literal guard before writing to values
    if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype') {
      values[key] = resolvedValue;
      validKeys.push(key);
    }
  }

  return { values, validKeys, warnings };
}

export = { mergeFederatedConfig };
