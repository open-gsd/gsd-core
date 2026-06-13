/**
 * Loop Resolver — ADR-857 phase 3c registry-consuming query
 *
 * Given a loop point (one of the 12 canonical points from loop-host-contract.cjs),
 * filters the materialized Capability Registry by config activation and returns
 * the active hooks as a JSON envelope with a rendered-markdown field.
 *
 * Consumed live by the landed phase-6 loop-hook cutovers: plan-phase.md / autonomous.md
 * at plan:pre (ui-phase) and autonomous.md at verify:post (ui-review). Further per-feature
 * cutovers are ongoing.
 *
 * Command surface: gsd-tools loop render-hooks <point>
 *
 * Exports (three things):
 *   resolveLoopHooks({ point, registry, config }) → { point, activeHooks }
 *   renderLoopHooks(resolved) → markdown string
 *   cmdLoopRenderHooks(cwd, point, raw, options) — I/O entry point
 *
 * Both pure functions (resolveLoopHooks, renderLoopHooks) take explicit
 * registry/config arguments so they are trivially testable without I/O.
 *
 * Dependencies (leaf modules only — no core.cjs circular risk):
 *   - node:fs / node:path  (raw config.json read for capability-key activation)
 *   - ./config-loader.cjs  (loadConfig)
 *   - ./planning-workspace.cjs  (planningDir — to locate config.json)
 *   - ./core.cjs           (output, error)
 *   - loop-host-contract.cjs (CANONICAL_POINTS via LOOP_HOST_CONTRACT)
 *   - capability-registry.cjs (byLoopPoint, consumed at call time)
 */

import fs from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
import core = require('./core.cjs');
const { output: coreOutput, error: coreError } = core;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import configLoaderModule = require('./config-loader.cjs');
const { loadConfig } = configLoaderModule;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import capabilityStateModule = require('./capability-state.cjs');
const { resolveCapabilityRuntimeState } = capabilityStateModule;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspaceMod = require('./planning-workspace.cjs');
const { planningDir, planningRoot } = planningWorkspaceMod;

// ─── Canonical points (derived from LOOP_HOST_CONTRACT — authoritative 12) ───

// FIX 2: Derive the authoritative canonical set from LOOP_HOST_CONTRACT so it
// cannot drift from the host contract. CANONICAL_POINTS_FALLBACK is kept as an
// alias for backward compatibility in tests and exports.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const _loopHostContract = require('./loop-host-contract.cjs') as { LOOP_HOST_CONTRACT: Array<{ points: string[] }> };
const CANONICAL_POINTS: ReadonlyArray<string> = (() => {
  try {
    const contract = _loopHostContract.LOOP_HOST_CONTRACT;
    if (Array.isArray(contract)) {
      const pts: string[] = [];
      for (const step of contract) {
        if (step && Array.isArray(step.points)) {
          for (const p of step.points) {
            if (typeof p === 'string') pts.push(p);
          }
        }
      }
      if (pts.length > 0) return pts;
    }
  } catch { /* fall through to hardcoded fallback */ }
  return [
    'discuss:pre',
    'discuss:post',
    'plan:pre',
    'plan:post',
    'execute:pre',
    'execute:wave:pre',
    'execute:wave:post',
    'execute:post',
    'verify:pre',
    'verify:post',
    'ship:pre',
    'ship:post',
  ];
})();

// Alias for backward compatibility (tests import this name)
const CANONICAL_POINTS_FALLBACK: ReadonlyArray<string> = CANONICAL_POINTS;

// FIX 2: _getCanonicalPoints now returns the authoritative CANONICAL_POINTS set
// derived from LOOP_HOST_CONTRACT — not the registry's byLoopPoint keys.
// The registry's byLoopPoint is only used to READ hooks, not to define valid points.
function _getCanonicalPoints(_registry: Record<string, unknown>): ReadonlyArray<string> {
  return CANONICAL_POINTS;
}

// ─── Prototype-pollution guard (inline literal, CodeQL barrier) ───────────────

/**
 * Traverse a dotted config key through a nested config object.
 * E.g. "workflow.ui_phase" in { workflow: { ui_phase: true } } → { found: true, value: true }
 * Returns { found: false } if any segment is a forbidden key or not an own property.
 */
function _getNestedConfigValue(
  config: Record<string, unknown>,
  dotKey: string,
): { found: boolean; value: unknown } {
  const segments = dotKey.split('.');
  let current: unknown = config;
  for (const seg of segments) {
    // Inline literal prototype-pollution guard (CodeQL barrier)
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

// ─── Single-key activation resolver (FIX 1) ───────────────────────────────────

/**
 * Warn-once set for raw config.json parse errors.
 * Avoids noisy per-call stderr from a single malformed file.
 */
const _warnedRawConfigPaths = new Set<string>();

/**
 * Read a raw config.json file and perform a guarded nested-lookup of a single
 * dotted key. Returns { found: false } if the file is missing (ENOENT) or if
 * the key is absent/forbidden. On a genuine JSON parse error: warns once to
 * stderr and returns { found: false } — never throws.
 */
function _readRawConfigKey(
  filePath: string,
  dotKey: string,
): { found: boolean; value: unknown } {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      if (!_warnedRawConfigPaths.has(filePath)) {
        _warnedRawConfigPaths.add(filePath);
        try {
          process.stderr.write(
            `gsd-tools: warning: failed to parse ${filePath} as JSON — skipping for activation resolution\n`,
          );
        } catch { /* stderr might be closed */ }
      }
      return { found: false, value: undefined };
    }
    return _getNestedConfigValue(parsed, dotKey);
  } catch {
    // ENOENT (missing file) is expected → skip silently. All other errors → also skip (defensive).
    return { found: false, value: undefined };
  }
}

/**
 * FIX 1: Resolve the effective value for a hook's `when` key using the
 * four-level precedence:
 *
 * 1. loadConfig result (`config` arg) — guarded nested-lookup of the dotted key.
 *    This is the post-cutover federated path (covers keys that loadConfig now exposes).
 * 2. Raw workstream `.planning/.../config.json` — guarded single-key lookup.
 *    Workstream wins over root (mirrors loadConfig inheritance).
 * 3. Raw root `.planning/config.json` — guarded single-key lookup.
 * 4. `registry.configSchema[when]?.default` — schema default.
 *    A `default: true` hook is active out-of-the-box without any config.
 * 5. Absent → inactive (return false).
 *
 * Never constructs a merged object from raw JSON keys — only reads the single
 * leaf value at the guarded dotted path.  Prototype-pollution sink is eliminated.
 */
function _resolveActivationValue(
  dotKey: string,
  config: Record<string, unknown>,
  cwd: string | undefined,
  registry: Record<string, unknown>,
): boolean {
  // Level 1: loadConfig result
  const fromConfig = _getNestedConfigValue(config, dotKey);
  if (fromConfig.found) return Boolean(fromConfig.value);

  // Level 2 + 3: raw config.json files (only when cwd is available)
  if (cwd) {
    // Level 2: workstream config (planningDir respects GSD_WORKSTREAM env)
    const wsConfigPath = path.join(planningDir(cwd), 'config.json');
    // Level 3: root config (planningRoot = cwd/.planning always)
    const rootConfigPath = path.join(planningRoot(cwd), 'config.json');

    // Workstream wins over root (mirroring loadConfig root→workstream precedence:
    // workstream overlays root, so workstream value takes precedence).
    const fromWs = _readRawConfigKey(wsConfigPath, dotKey);
    if (fromWs.found) return Boolean(fromWs.value);

    // Only read root if it differs from the workstream path (avoids double-read
    // when no workstream is active and both paths resolve to the same file).
    if (wsConfigPath !== rootConfigPath) {
      const fromRoot = _readRawConfigKey(rootConfigPath, dotKey);
      if (fromRoot.found) return Boolean(fromRoot.value);
    }
  }

  // Level 4: registry configSchema default
  const schemaEntry = (registry['configSchema'] as Record<string, unknown> | undefined)?.[dotKey];
  if (schemaEntry && typeof schemaEntry === 'object' && schemaEntry !== null) {
    const def = (schemaEntry as Record<string, unknown>)['default'];
    if (def !== undefined) return Boolean(def);
  }

  // Level 5: absent → inactive
  return false;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface HookRef {
  skill?: string;
  agent?: string;
  [key: string]: unknown;
}

interface RawHook {
  capId?: unknown;
  point?: unknown;
  ref?: unknown;
  into?: unknown;
  fragment?: unknown;
  produces?: unknown;
  consumes?: unknown;
  when?: unknown;
  onError?: unknown;
  blocking?: unknown;
  check?: unknown;
}

type HookKind = 'step' | 'contribution' | 'gate';

interface ActiveHook {
  capId: string;
  kind: HookKind;
  ref?: HookRef;
  into?: string;
  fragment?: { inline?: string; path?: string };
  when?: string;
  produces?: string[];
  consumes?: string[];
  blocking?: boolean;
  check?: unknown;
  onError?: string;
}

interface ResolveLoopHooksInput {
  point: string;
  registry: Record<string, unknown>;
  config: Record<string, unknown>;
  /** Optional cwd — enables raw config.json fallback reads (FIX 1 precedence level 2). */
  cwd?: string;
  /** Optional capability-state map; when present, disabled capabilities do not render hooks. */
  capabilityStatesById?: Map<string, { enabled?: boolean }> | Record<string, { enabled?: boolean }>;
}

interface ResolveLoopHooksResult {
  point: string;
  activeHooks: ActiveHook[];
}

// ─── Pure resolver ─────────────────────────────────────────────────────────────

/**
 * Pure resolver: given a point, registry, and config, returns the active hooks.
 *
 * Throws if `point` is not one of the 12 canonical points (caller converts to
 * core.error). Never throws for malformed registry/hook entries — skips and
 * continues.
 *
 * Ordering: steps first, then contributions, then gates. Within each array,
 * the materialized registry order is preserved.
 *
 * Activation: a hook with no `when` is always active. With `when` (dotted key),
 * resolved against `config`; active iff truthy. Inactive hooks are filtered out.
 */
function resolveLoopHooks(input: ResolveLoopHooksInput): ResolveLoopHooksResult {
  const { point, registry, config, cwd, capabilityStatesById } = input;

  // Validate point
  const canonicalPoints = _getCanonicalPoints(registry);
  if (!canonicalPoints.includes(point)) {
    throw new Error(
      `Invalid loop point: "${point}". Valid points: ${canonicalPoints.join(', ')}`,
    );
  }

  // Guard: registry missing byLoopPoint
  const byLoopPoint = registry['byLoopPoint'];
  if (!byLoopPoint || typeof byLoopPoint !== 'object' || Array.isArray(byLoopPoint)) {
    return { point, activeHooks: [] };
  }
  const byLoopPointMap = byLoopPoint as Record<string, unknown>;

  // Guard: point missing in registry
  const entry = byLoopPointMap[point];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { point, activeHooks: [] };
  }
  const entryMap = entry as Record<string, unknown>;

  const activeHooks: ActiveHook[] = [];

  // Helper: check activation using single-key precedence resolver (FIX 1 + FIX 3)
  function isActive(hook: RawHook): boolean {
    const when = hook['when'];
    // No `when` → unconditional hook, always active
    if (when === undefined || when === null) return true;
    // FIX 3: `when` present but not a non-empty string → malformed registry data → INACTIVE
    if (typeof when !== 'string' || when.length === 0) return false;
    return _resolveActivationValue(when, config, cwd, registry);
  }

  function isCapabilityEnabled(capId: string): boolean {
    if (!capabilityStatesById) return true;
    const state = capabilityStatesById instanceof Map
      ? capabilityStatesById.get(capId)
      : capabilityStatesById[capId];
    if (!state) return false;
    return state.enabled !== false;
  }

  // Helper: safe string array
  function toStringArray(v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === 'string');
  }

  function toFragment(v: unknown): { inline?: string; path?: string } | undefined {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    const raw = v as Record<string, unknown>;
    const fragment: { inline?: string; path?: string } = {};
    if (typeof raw.inline === 'string') fragment.inline = raw.inline;
    if (typeof raw.path === 'string') fragment.path = raw.path;
    return Object.keys(fragment).length > 0 ? fragment : undefined;
  }

  // Process steps
  const stepsRaw = entryMap['steps'];
  const steps: RawHook[] = Array.isArray(stepsRaw) ? (stepsRaw as RawHook[]) : [];
  for (const hook of steps) {
    if (!hook || typeof hook !== 'object') continue;
    const capId = typeof hook['capId'] === 'string' ? hook['capId'] : '';
    if (!isCapabilityEnabled(capId)) continue;
    if (!isActive(hook)) continue;
    const ref = (typeof hook['ref'] === 'object' && hook['ref'] !== null)
      ? (hook['ref'] as HookRef)
      : undefined;
    const when = typeof hook['when'] === 'string' ? hook['when'] : undefined;
    const fragment = toFragment(hook['fragment']);
    const produces = toStringArray(hook['produces']);
    const consumes = toStringArray(hook['consumes']);
    const onError = typeof hook['onError'] === 'string' ? hook['onError'] : undefined;
    const active: ActiveHook = { capId, kind: 'step' };
    if (ref !== undefined) active.ref = ref;
    if (fragment !== undefined) active.fragment = fragment;
    if (when !== undefined) active.when = when;
    if (produces.length > 0) active.produces = produces;
    if (consumes.length > 0) active.consumes = consumes;
    if (onError !== undefined) active.onError = onError;
    activeHooks.push(active);
  }

  // Process contributions
  const contributionsRaw = entryMap['contributions'];
  const contributions: RawHook[] = Array.isArray(contributionsRaw) ? (contributionsRaw as RawHook[]) : [];
  for (const hook of contributions) {
    if (!hook || typeof hook !== 'object') continue;
    const capId = typeof hook['capId'] === 'string' ? hook['capId'] : '';
    if (!isCapabilityEnabled(capId)) continue;
    if (!isActive(hook)) continue;
    const into = typeof hook['into'] === 'string' ? hook['into'] : undefined;
    const fragment = toFragment(hook['fragment']);
    const when = typeof hook['when'] === 'string' ? hook['when'] : undefined;
    const produces = toStringArray(hook['produces']);
    const consumes = toStringArray(hook['consumes']);
    const onError = typeof hook['onError'] === 'string' ? hook['onError'] : undefined;
    const active: ActiveHook = { capId, kind: 'contribution' };
    if (into !== undefined) active.into = into;
    if (fragment !== undefined) active.fragment = fragment;
    if (when !== undefined) active.when = when;
    if (produces.length > 0) active.produces = produces;
    if (consumes.length > 0) active.consumes = consumes;
    if (onError !== undefined) active.onError = onError;
    activeHooks.push(active);
  }

  // Process gates
  const gatesRaw = entryMap['gates'];
  const gates: RawHook[] = Array.isArray(gatesRaw) ? (gatesRaw as RawHook[]) : [];
  for (const hook of gates) {
    if (!hook || typeof hook !== 'object') continue;
    const capId = typeof hook['capId'] === 'string' ? hook['capId'] : '';
    if (!isCapabilityEnabled(capId)) continue;
    if (!isActive(hook)) continue;
    const when = typeof hook['when'] === 'string' ? hook['when'] : undefined;
    const check = hook['check'] !== undefined ? hook['check'] : undefined;
    const blocking = typeof hook['blocking'] === 'boolean' ? hook['blocking'] : undefined;
    const onError = typeof hook['onError'] === 'string' ? hook['onError'] : undefined;
    const active: ActiveHook = { capId, kind: 'gate' };
    if (when !== undefined) active.when = when;
    if (check !== undefined) active.check = check;
    if (blocking !== undefined) active.blocking = blocking;
    if (onError !== undefined) active.onError = onError;
    activeHooks.push(active);
  }

  return { point, activeHooks };
}

// ─── Pure renderer ─────────────────────────────────────────────────────────────

/**
 * Pure renderer: given a resolved result, returns a deterministic markdown string.
 *
 * Empty active set → returns a "no active hooks" placeholder line.
 * Steps: heading with ordinal + skill ref + capId, produces/consumes lines.
 * Contributions: labeled block.
 * Gates: check name, blocking flag, onError.
 */
function renderLoopHooks(resolved: ResolveLoopHooksResult): string {
  const { point, activeHooks } = resolved;

  if (activeHooks.length === 0) {
    return `_No active hooks at ${point}._`;
  }

  const lines: string[] = [];
  let stepOrdinal = 0;

  for (const hook of activeHooks) {
    if (hook.kind === 'step') {
      stepOrdinal += 1;
      const refStr = hook.ref?.skill
        ? `skill:${hook.ref.skill}`
        : hook.ref?.agent
          ? `agent:${hook.ref.agent}`
          : JSON.stringify(hook.ref ?? {});
      lines.push(`### Step ${stepOrdinal}: ${refStr} (${hook.capId})`);
      if (hook.produces && hook.produces.length > 0) {
        lines.push(`- produces: ${hook.produces.join(', ')}`);
      }
      if (hook.consumes && hook.consumes.length > 0) {
        lines.push(`- consumes: ${hook.consumes.join(', ')}`);
      }
      if (hook.when) {
        lines.push(`- when: \`${hook.when}\``);
      }
      if (hook.onError) {
        lines.push(`- onError: ${hook.onError}`);
      }
      if (hook.fragment?.inline) {
        lines.push('');
        lines.push(hook.fragment.inline);
      } else if (hook.fragment?.path) {
        lines.push('');
        lines.push(`_Step fragment path is declared but not rendered by loop-resolver: ${hook.fragment.path}_`);
      }
      lines.push('');
    } else if (hook.kind === 'contribution') {
      lines.push(`<contribution from="${hook.capId}" into="${hook.into ?? '(unset)'}">`);
      if (hook.fragment?.inline) {
        lines.push(hook.fragment.inline);
      } else if (hook.fragment?.path) {
        lines.push(`_Contribution fragment path is declared but not rendered by loop-resolver: ${hook.fragment.path}_`);
      }
      if (hook.produces && hook.produces.length > 0) {
        lines.push(`- produces: ${hook.produces.join(', ')}`);
      }
      if (hook.consumes && hook.consumes.length > 0) {
        lines.push(`- consumes: ${hook.consumes.join(', ')}`);
      }
      if (hook.when) {
        lines.push(`- when: \`${hook.when}\``);
      }
      if (hook.onError) {
        lines.push(`- onError: ${hook.onError}`);
      }
      lines.push('</contribution>');
      lines.push('');
    } else if (hook.kind === 'gate') {
      let checkStr = '(none)';
      if (hook.check !== undefined && hook.check !== null) {
        checkStr = typeof hook.check === 'object'
          ? JSON.stringify(hook.check)
          : typeof hook.check === 'string' || typeof hook.check === 'number' || typeof hook.check === 'boolean'
            ? String(hook.check)
            : '(complex)';
      }
      lines.push(`**Gate** (${hook.capId}): check=${checkStr}, blocking=${String(hook.blocking ?? false)}, onError=${hook.onError ?? 'skip'}`);
      if (hook.when) {
        lines.push(`- when: \`${hook.when}\``);
      }
      lines.push('');
    }
  }

  // Trim trailing blank line
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines.join('\n');
}

// ─── I/O command handler ───────────────────────────────────────────────────────

/**
 * Command entry point: load registry + config, resolve + render, emit envelope.
 *
 * Envelope: { point, activeHooks, rendered }
 * On invalid point, emits core.error instead of throwing.
 *
 * Config note: FIX 1 replaced _loadMergedConfig (whole-config deep-merge) with a
 * per-hook single-key activation resolver (_resolveActivationValue). The resolver
 * checks loadConfig result first, then raw config.json files directly (workstream
 * then root), then the registry's configSchema default. This eliminates the
 * merged-object-from-untrusted-keys security concern and correctly handles
 * pre-cutover keys like `workflow.ui_phase` that live in config.json but are not
 * yet exposed through loadConfig's whitelist.
 */
function cmdLoopRenderHooks(
  cwd: string,
  point: string,
  raw: boolean,
  options: Record<string, unknown> = {},
): void {
  if (!point) {
    coreError('loop render-hooks requires a <point> argument. Valid points: ' + CANONICAL_POINTS.join(', '));
    return;
  }

  const runtimeConfigDir = typeof options['configDir'] === 'string'
    ? options['configDir']
    : undefined;
  const state = resolveCapabilityRuntimeState(cwd, runtimeConfigDir) as {
    warnings?: string[];
    registry: Record<string, unknown>;
    config: Record<string, unknown>;
    capabilities: Array<{ id: string; enabled?: boolean }>;
  };
  const registry = state.registry;
  const config = state.config || loadConfig(cwd);
  const capabilityStatesById = new Map<string, { enabled?: boolean }>();
  for (const cap of state.capabilities || []) {
    capabilityStatesById.set(cap.id, cap);
  }

  let resolved: ResolveLoopHooksResult;
  try {
    resolved = resolveLoopHooks({ point, registry, config, cwd, capabilityStatesById });
  } catch (err: unknown) {
    const msg = (err instanceof Error) ? err.message : String(err);
    coreError(msg);
    return;
  }

  const rendered = renderLoopHooks(resolved);
  const envelope: {
    point: string;
    activeHooks: ActiveHook[];
    rendered: string;
    warnings?: string[];
  } = {
    point: resolved.point,
    activeHooks: resolved.activeHooks,
    rendered,
  };
  if (state.warnings && state.warnings.length > 0) {
    envelope.warnings = state.warnings;
  }

  coreOutput(envelope, raw);
}

export = {
  resolveLoopHooks,
  renderLoopHooks,
  cmdLoopRenderHooks,
  // Exported for tests
  _getNestedConfigValue,
  _resolveActivationValue,
  _readRawConfigKey,
  CANONICAL_POINTS_FALLBACK,
  CANONICAL_POINTS,
};
