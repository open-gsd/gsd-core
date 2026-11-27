/**
 * Capability activation helpers.
 *
 * Shared by the Capability State Resolver and Loop Resolver so config-key
 * activation uses one precedence chain and one prototype-pollution guard.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports -- #6030 CJS interop import, as in the sibling config modules
import configValueResolver = require('./config-value-resolver.cjs');
const { resolveConfigValue } = configValueResolver;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- #6030 CJS interop import, as in the sibling config modules
import configLoader = require('./config-loader.cjs');
const { honorsGlobalDefaults } = configLoader;

function _getNestedConfigValue(
  config: Record<string, unknown>,
  dotKey: string,
): { found: boolean; value: unknown } {
  const segments = dotKey.split('.');
  let current: unknown = config;
  for (const seg of segments) {
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

/**
 * Resolve the raw value for a dotted config key using the four-level precedence
 * walk. Returns { found, value } with the RAW value (not coerced to boolean),
 * so callers can decide how to interpret the value (boolean gate vs. raw config
 * value for numeric/string settings like security_asvs_level).
 *
 * Precedence (mirrors _resolveActivationValue):
 *   1. loadConfig result (config arg) — guarded nested-lookup.
 *   2. Workstream config.json at planningDir(cwd)/config.json.
 *   3. Root config.json at planningRoot(cwd)/config.json (only if path differs).
 *   4. registry.configSchema[dotKey].default — schema default.
 *   5. Absent → { found: false, value: undefined }.
 *
 * `quiet: true` (default false) suppresses the one-time stderr warning for a config.json that is
 * not valid JSON: a gate reads its switch quietly (a malformed config is simply "key absent"), it
 * never writes to stderr (#5139).
 */
function resolveConfigKey(
  dotKey: string,
  opts: { config: Record<string, unknown>; cwd: string | undefined; registry: Record<string, unknown>; quiet?: boolean },
): { found: boolean; value: unknown } {
  const { config, cwd, registry } = opts;
  const quiet = opts.quiet === true;

  // Level 1: loadConfig result
  const fromConfig = _getNestedConfigValue(config, dotKey);
  if (fromConfig.found) return { found: true, value: fromConfig.value };

  // Level 2 + 3 (+ the global defaults layer, #4071): the Config Value Resolution Module walks the
  // workstream, root and global-defaults files (#6030, ADR-1411 Decision 5). Only a file layer
  // counts here: a built-in or schema default must not make an unset switch look configured, and
  // the injected registry below stays the schema-default source.
  if (cwd) {
    const rawSchema = registry['configSchema'];
    const resolved = resolveConfigValue(dotKey, {
      cwd,
      quiet,
      honorGlobal: honorsGlobalDefaults,
      // A gate key the registry does not declare still resolves over the file layers (#6032).
      allowUndeclared: true,
      ...(rawSchema && typeof rawSchema === 'object' && !Array.isArray(rawSchema)
        ? { configSchema: rawSchema as Record<string, unknown> }
        : {}),
    });
    if (resolved.found && (resolved.layer === 'workstream' || resolved.layer === 'root' || resolved.layer === 'global-defaults')) {
      return { found: true, value: resolved.value };
    }
  }

  // Level 4: registry configSchema default
  const schemaMap = registry['configSchema'];
  if (schemaMap && typeof schemaMap === 'object' && !Array.isArray(schemaMap)
      && Object.prototype.hasOwnProperty.call(schemaMap, dotKey)) {
    const schemaEntry = (schemaMap as Record<string, unknown>)[dotKey];
    if (schemaEntry && typeof schemaEntry === 'object' && schemaEntry !== null) {
      const def = (schemaEntry as Record<string, unknown>)['default'];
      if (def !== undefined) return { found: true, value: def };
    }
  }

  // Level 5: absent
  return { found: false, value: undefined };
}

function _resolveActivationValue(
  dotKey: string,
  config: Record<string, unknown>,
  cwd: string | undefined,
  registry: Record<string, unknown>,
): boolean {
  const r = resolveConfigKey(dotKey, { config, cwd, registry });
  return r.found ? isActivationValueOn(r.value) : false;
}

/**
 * A hand-edited config can carry a boolean switch as a string. `Boolean("false")` is true, which would
 * turn a switch ON that the file says is off, so a string is read for its meaning: empty, "false", "0",
 * "no" and "off" (any case, surrounding whitespace ignored) are off; every other string is on. A non-string
 * keeps plain truthiness, so numbers, booleans and objects behave as before.
 */
const OFF_STRINGS: ReadonlySet<string> = new Set(['', 'false', '0', 'no', 'off']);

function isActivationValueOn(value: unknown): boolean {
  if (typeof value === 'string') return !OFF_STRINGS.has(value.trim().toLowerCase());
  return Boolean(value);
}

/**
 * Resolve a step's optional `pointFrom` gate (#3661): a step declaring
 * `pointFrom: "<dotted enum key>"` is only active for ITS OWN `point` when the
 * resolved value of that config key equals `point` exactly. This lets a
 * capability register the same logical step at more than one loop point and
 * have config select which registration is live — without teaching the
 * shared `when` grammar an equality operator (`when` stays a plain boolean
 * gate on a dotted key everywhere else).
 *
 * No `pointFrom` → true (unconditional; every existing step is unaffected).
 * Present but not a non-empty string → false (malformed, mirrors `when`).
 * Present and resolved → true only on an exact match against `point`.
 *
 * Single-owner precedence engine: called from both `loop-resolver.cts`
 * (`isActive`) and `capability-state.cts` (`processHooks`) so the two
 * consumers can never diverge on activation (see
 * `tests/capability-precedence-parity.test.cjs`).
 */
function _resolvePointGate(
  pointFrom: unknown,
  point: string,
  config: Record<string, unknown>,
  cwd: string | undefined,
  registry: Record<string, unknown>,
): boolean {
  if (pointFrom === undefined || pointFrom === null) return true;
  if (typeof pointFrom !== 'string' || pointFrom.length === 0) return false;
  const r = resolveConfigKey(pointFrom, { config, cwd, registry });
  return r.found && r.value === point;
}

export = {
  _getNestedConfigValue,
  _resolveActivationValue,
  _resolvePointGate,
  resolveConfigKey,
};
