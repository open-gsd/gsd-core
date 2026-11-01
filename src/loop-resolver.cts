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
 * Dependencies (leaf modules only — no circular risk):
 *   - ./config-loader.cjs  (loadConfigResolved, CONFIG_REASON)
 *   - ./io.cjs             (output, error)
 *   - ./capability-activation.cjs (resolveConfigKey, _resolveActivationValue, _getNestedConfigValue, _readRawConfigKey)
 *   - loop-host-contract.cjs (CANONICAL_POINTS via LOOP_HOST_CONTRACT)
 *   - capability-registry.cjs (byLoopPoint, consumed at call time)
 *   - capability-state.cjs (resolveCapabilityRuntimeState — for capabilities list)
 *   - ./security.cjs       (requireSafePath, sanitizeLabel, tryWithinRoot, PathAcceptance)
 *   - ./phase-locator.cjs  (guardedFindPhase)
 *   - ./planning-workspace.cjs (planningDir)
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import ioMod = require('./io.cjs');
const { output: coreOutput, error: coreError } = ioMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import verificationMod = require('./verification.cjs');
const { resolvePhaseArtifactFile } = verificationMod;
import { requireSafePath, sanitizeLabel, tryWithinRoot, PathAcceptance } from './security.cjs';

// eslint-disable-next-line @typescript-eslint/no-require-imports -- phase-locator.cjs is an export= CommonJS module
import phaseLocator = require('./phase-locator.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspaceMod = require('./planning-workspace.cjs');
const { planningDir } = planningWorkspaceMod;
const { guardedFindPhase } = phaseLocator;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import configLoaderModule = require('./config-loader.cjs');
const { loadConfigResolved, CONFIG_REASON } = configLoaderModule;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import capabilityStateModule = require('./capability-state.cjs');
const { resolveCapabilityRuntimeState } = capabilityStateModule;

// ─── Capability-activation engine (single owner for config-key precedence) ────
// eslint-disable-next-line @typescript-eslint/no-require-imports
import capabilityActivationModule = require('./capability-activation.cjs');
const { _getNestedConfigValue, _readRawConfigKey, _resolveActivationValue, _resolvePointGate, resolveConfigKey } = capabilityActivationModule;

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

// ─── (Precedence engine imported from capability-activation.cjs above) ────────

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
  /** #4209 DISP-02: step-only reviewer-lane opt-in trait; validated boolean upstream. */
  supportsReviewerLanes?: unknown;
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
  /** Resolved capability-owned config values declared in the contribution's configValues map. */
  configValues?: Record<string, unknown>;
  /**
   * #4209 DISP-02: step-only reviewer-lane opt-in trait. Only present (and only
   * ever `true`) when the source step declared a literal `true`; omitted or
   * `false` never reach the active hook — the field is inert by absence, not
   * by carrying `false`.
   */
  supportsReviewerLanes?: true;
}

interface ResolveLoopHooksInput {
  point: string;
  registry: Record<string, unknown>;
  config: Record<string, unknown>;
  /** Optional cwd — enables raw config.json fallback reads (FIX 1 precedence level 2). */
  cwd?: string;
  /**
   * Optional capability-state map; when present, inactive capabilities do not render hooks.
   * Each entry carries both `enabled` (installed+surfaced) and `active` (enabled+configActivation).
   * The resolver gates on `active` so that the config activation key (activationKey) is
   * honoured even when no per-hook `when` guard is present (Phase 4 tri-state alignment).
   *
   * `active` is REQUIRED (not optional) so the gate is fail-closed: a missing or undefined
   * `active` field is a compile error, never silently treated as truthy.
   */
  capabilityStatesById?: Map<string, { enabled?: boolean; active: boolean }> | Record<string, { enabled?: boolean; active: boolean }>;
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
 * io.error). Never throws for malformed registry/hook entries — skips and
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
    if (when !== undefined && when !== null) {
      // FIX 3: `when` present but not a non-empty string → malformed registry data → INACTIVE
      if (typeof when !== 'string' || when.length === 0) return false;
      if (!_resolveActivationValue(when, config, cwd, registry)) return false;
    }
    // #3661: optional point-selection gate — see capability-activation.cts.
    return _resolvePointGate((hook as Record<string, unknown>)['pointFrom'], point, config, cwd, registry);
  }

  function isCapabilityActive(capId: string): boolean {
    if (!capabilityStatesById) return true;
    const state = capabilityStatesById instanceof Map
      ? capabilityStatesById.get(capId)
      : capabilityStatesById[capId];
    if (!state) return false;
    // Fail-closed gate: only render the hook when active is explicitly true.
    // A capability can be installed and surfaced (enabled=true) but config-disabled
    // (active=false); in that case the hook must not render.
    // Phase 4 tri-state alignment: `active` is now required (not optional), so
    // `=== true` is the correct fail-closed check (not `!== false`).
    return state.active === true;
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

  /**
   * Resolve declared configValues for a contribution hook.
   * The hook may carry `configValues: { alias: "dotted.key", ... }`.
   * Each key is resolved using the same four-level precedence as activation resolution,
   * but returning the raw value (not coerced to boolean) so numeric/string config values
   * are preserved (e.g. security_asvs_level: 2, security_block_on: "medium").
   */
  function resolveConfigValues(hook: RawHook): Record<string, unknown> | undefined {
    const raw = (hook as Record<string, unknown>)['configValues'];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const rawMap = raw as Record<string, unknown>;
    const resolved: Record<string, unknown> = {};
    for (const [alias, dotKey] of Object.entries(rawMap)) {
      // Prototype-pollution guard (inline literal, CodeQL barrier)
      if (alias === '__proto__' || alias === 'constructor' || alias === 'prototype') continue;
      if (typeof dotKey !== 'string') continue;
      const r = resolveConfigKey(dotKey, { config, cwd, registry });
      if (r.found) resolved[alias] = r.value;
    }
    return Object.keys(resolved).length > 0 ? resolved : undefined;
  }

  // Process steps
  const stepsRaw = entryMap['steps'];
  const steps: RawHook[] = Array.isArray(stepsRaw) ? (stepsRaw as RawHook[]) : [];
  for (const hook of steps) {
    if (!hook || typeof hook !== 'object') continue;
    const capId = typeof hook['capId'] === 'string' ? hook['capId'] : '';
    if (!isCapabilityActive(capId)) continue;
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
    // #4209 DISP-02: only a literal `true` projects; absent/false stay inert.
    if (hook['supportsReviewerLanes'] === true) active.supportsReviewerLanes = true;
    activeHooks.push(active);
  }

  // Process contributions
  const contributionsRaw = entryMap['contributions'];
  const contributions: RawHook[] = Array.isArray(contributionsRaw) ? (contributionsRaw as RawHook[]) : [];
  for (const hook of contributions) {
    if (!hook || typeof hook !== 'object') continue;
    const capId = typeof hook['capId'] === 'string' ? hook['capId'] : '';
    if (!isCapabilityActive(capId)) continue;
    if (!isActive(hook)) continue;
    const into = typeof hook['into'] === 'string' ? hook['into'] : undefined;
    const fragment = toFragment(hook['fragment']);
    const when = typeof hook['when'] === 'string' ? hook['when'] : undefined;
    const produces = toStringArray(hook['produces']);
    const consumes = toStringArray(hook['consumes']);
    const onError = typeof hook['onError'] === 'string' ? hook['onError'] : undefined;
    const configValuesResolved = resolveConfigValues(hook);
    const active: ActiveHook = { capId, kind: 'contribution' };
    if (into !== undefined) active.into = into;
    if (fragment !== undefined) active.fragment = fragment;
    if (when !== undefined) active.when = when;
    if (produces.length > 0) active.produces = produces;
    if (consumes.length > 0) active.consumes = consumes;
    if (onError !== undefined) active.onError = onError;
    if (configValuesResolved !== undefined) active.configValues = configValuesResolved;
    activeHooks.push(active);
  }

  // Process gates
  const gatesRaw = entryMap['gates'];
  const gates: RawHook[] = Array.isArray(gatesRaw) ? (gatesRaw as RawHook[]) : [];
  for (const hook of gates) {
    if (!hook || typeof hook !== 'object') continue;
    const capId = typeof hook['capId'] === 'string' ? hook['capId'] : '';
    if (!isCapabilityActive(capId)) continue;
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
 * Envelope: { point, activeHooks, rendered, context?, phaseDrop?, warnings?, skippedHooks? }
 * On invalid point, emits io.error instead of throwing.
 *
 * Config note: FIX 1 replaced _loadMergedConfig (whole-config deep-merge) with a
 * per-hook single-key activation resolver (_resolveActivationValue). The resolver
 * checks loadConfig result first, then raw config.json files directly (workstream
 * then root), then the registry's configSchema default. This eliminates the
 * merged-object-from-untrusted-keys security concern and correctly handles
 * pre-cutover keys like `workflow.ui_phase` that live in config.json but are not
 * yet exposed through loadConfig's whitelist.
 *
 * --active-cap <capId>: when present, resolves hooks for <point> exactly as the
 * normal path does, then prints exactly `true` (if any resolved activeHook has
 * capId === <capId>) or `false` followed by a single newline, and exits 0.
 * No JSON envelope is emitted — output is clean for shell $(…) capture.
 * Missing <capId> value → coreError + non-zero exit.
 * Unknown/inactive capId → `false` (not an error).
 */
// #2009: a capability id surfaced inside the runnable `gsd capability remove <id>`
// remediation must match the canonical kebab-case id shape (identical to
// capability-consent.cts / capability-ledger.cts) before it is embedded — a raw
// overlay directory name is attacker-controlled and can carry shell/markdown
// metacharacters (backticks, ';', '|', '$()'). An id that fails this check is
// withheld and no runnable command is rendered for it.
const LOAD_FAIL_CAP_ID_RE = /^[a-z][a-z0-9-]*$/;

// #2009: neutralize control chars, newlines, and backticks from a third-party
// load-failure reason so a malicious manifest cannot break out of the warning
// line or inject markdown / prompt content into the surfaced message.
function sanitizeLoadFailReason(reason: unknown): string {
  const cleaned = String(reason)
    // Strip C0 control chars, DEL, and backticks; collapse remaining whitespace.
    .replace(/[\x00-\x1F\x7F`]/g, ' ')
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  return cleaned || '(no reason given)';
}

/** The additive, optional field `--phase <token>` resolves into (#4030). */
interface PhaseContext {
  phase: string;
  phaseDir: string;
}

/** Why a supplied --phase/--phase-dir produced no context. In-process callers, tests and the CLI envelope's `phaseDrop` carry this code. */
const PHASE_DROP = Object.freeze({
  ARCHIVED: 'ARCHIVED',
  ESCAPES_ROOT: 'ESCAPES_ROOT',
  DIR_MISMATCH: 'DIR_MISMATCH',
  AMBIGUOUS: 'AMBIGUOUS',
  UNRESOLVED: 'UNRESOLVED',
  PHASE_DIR_ALONE: 'PHASE_DIR_ALONE',
  INVALID_TOKEN: 'INVALID_TOKEN',
  CONFIG_FAULT: 'CONFIG_FAULT',
} as const);
type PhaseDrop = typeof PHASE_DROP[keyof typeof PHASE_DROP];
/** The grammar a --phase token must match before it is looked up, echoed or spliced into a handler argv. */
const PHASE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

interface ResolvedActiveHooks {
  point: string;
  activeHooks: ActiveHook[];
  warnings: string[];
  context?: PhaseContext;
  phaseDrop?: PhaseDrop;
}

/**
 * #4030: optional --phase <token> → derived context: { phase, phaseDir }.
 * Resolved via guardedFindPhase (same #2237 foreign-prefix guard as `init.*`),
 * so a phase-scoped handler gets the task-local phase instead of inferring it
 * from STATE.current_phase. Unresolvable or ambiguous input degrades to "no
 * context" plus a warning — never a hard error, never silent.
 *
 * `--phase-dir` is only a CHECK against what the token resolved to, never an
 * independent path: the emitted phaseDir is always the locator's own value, so
 * there is no caller path to confine, and `--phase 05 --phase-dir <another
 * in-project phase>` is rejected as incoherent.
 */
function resolvePhaseContext(
  cwd: string,
  phaseArg: string | undefined,
  phaseDirArg: string | undefined,
  projectCode: unknown,
  phaseNaming: unknown,
  configFault: string | undefined,
): { context: PhaseContext | undefined; warnings: string[]; drop?: PhaseDrop } {
  let phaseContext: PhaseContext | undefined;
  let drop: PhaseDrop | undefined;
  const phaseWarnings: string[] = [];
  // One owner for every caller- or disk-derived value a warning echoes:
  // sanitizeLabel escapes C0, DEL and C1 control characters, then the value is
  // capped at 80 characters.
  const shown = (v: string): string => JSON.stringify(sanitizeLabel(v).slice(0, 80));
  if (phaseArg !== undefined && configFault !== undefined) {
    drop = PHASE_DROP.CONFIG_FAULT;
    phaseWarnings.push(
      `--phase ${shown(phaseArg)} not resolved: .planning/config.json is unusable (${configFault}), ` +
      'so project_code and phase_naming are unknown; context omitted.',
    );
  } else if (phaseArg !== undefined && !PHASE_TOKEN_RE.test(phaseArg)) {
    drop = PHASE_DROP.INVALID_TOKEN;
    phaseWarnings.push(`--phase ${shown(phaseArg)} is not a safe phase token; context omitted.`);
  } else if (phaseArg !== undefined) {
    // guardedFindPhase is typed Record<string, unknown> | null; narrow once to
    // the fields read below.
    const phaseResult = guardedFindPhase(cwd, phaseArg, projectCode, phaseNaming) as {
      found: boolean;
      directory: string;
      phase_number: string;
      ambiguous_matches?: string[];
      archived?: string;
    } | null;
    if (phaseResult?.found && phaseResult.archived) {
      // guardedFindPhase falls back to archived milestone phases (init.* guards
      // the same way). ADR-4030 scopes context to a direct child of the active
      // .planning/phases, so an archived hit degrades like an unresolved token
      // rather than pointing a hook at retired plans. Omitting `context` keeps
      // any `phaseDir` off retired plans; the dispatch table still hands the
      // handler the host's own PHASE_NUMBER, which init.* resolved the same way.
      drop = PHASE_DROP.ARCHIVED;
      phaseWarnings.push(
        `--phase ${shown(phaseArg)} resolved only to an archived phase ` +
        `(${shown(phaseResult.directory)}, milestone ${shown(phaseResult.archived)}); ` +
        'context omitted.',
      );
    } else if (phaseResult?.found) {
      // Confinement first: a symlinked `.planning`, workstream or `phases`
      // parent puts a lexically in-project dir elsewhere. tryWithinRoot
      // realpaths both sides (null on escape or dangling symlink); the dir must
      // also be a direct child of the real phases dir. Any throw fails closed.
      const resolvedDir = path.resolve(cwd, phaseResult.directory);
      let escapes = false;
      try {
        const realPhases = tryWithinRoot(path.join(planningDir(cwd), 'phases'), cwd, PathAcceptance.AbsoluteInsideRoot);
        const realDir = tryWithinRoot(resolvedDir, cwd, PathAcceptance.AbsoluteInsideRoot);
        escapes = !realPhases || !realDir || path.dirname(realDir) !== realPhases;
      } catch { escapes = true; }
      // A supplied --phase-dir must name the same directory the token resolved
      // to (dev+ino, so case/normalization is the filesystem's call). FAT32,
      // exFAT and some SMB shares report ino 0 for every entry, so there the
      // realpaths decide. It only gates; the emitted phaseDir is always the
      // locator's value.
      const sameDir = (): boolean => {
        try {
          const given = path.resolve(cwd, phaseDirArg as string);
          // bigint: an NTFS 64-bit FileId loses precision as a double.
          const a = fs.statSync(given, { bigint: true });
          const b = fs.statSync(resolvedDir, { bigint: true });
          if (a.dev !== b.dev || a.ino !== b.ino) return false;
          return a.ino !== 0n || fs.realpathSync.native(given) === fs.realpathSync.native(resolvedDir);
        } catch { return false; }
      };
      if (escapes) {
        drop = PHASE_DROP.ESCAPES_ROOT;
        phaseWarnings.push(
          `--phase ${shown(phaseArg)} resolved to ${shown(phaseResult.directory)}, ` +
          'which escapes the project\'s .planning/phases tree (symlink or unreadable path); context omitted.',
        );
      } else if (phaseDirArg !== undefined && !sameDir()) {
        drop = PHASE_DROP.DIR_MISMATCH;
        phaseWarnings.push(
          `--phase-dir ${shown(phaseDirArg)} does not match the directory ` +
          `--phase ${shown(phaseArg)} resolves to (${shown(phaseResult.directory)}); context omitted.`,
        );
      } else {
        phaseContext = { phase: phaseResult.phase_number, phaseDir: phaseResult.directory };
      }
    } else if (phaseResult?.ambiguous_matches?.length) {
      // No context even when --phase-dir names a candidate: the directory would
      // become an independent source of truth, and `init.*` does not
      // disambiguate here either (#2237).
      drop = PHASE_DROP.AMBIGUOUS;
      phaseWarnings.push(
        `--phase ${shown(phaseArg)} is ambiguous: ${phaseResult.ambiguous_matches.length} ` +
        `directories match (${phaseResult.ambiguous_matches.slice(0, 5).map((m) => shown(m)).join(', ')}` +
        `${phaseResult.ambiguous_matches.length > 5 ? `, … ${phaseResult.ambiguous_matches.length - 5} more` : ''}); context omitted.`,
      );
    } else {
      drop = PHASE_DROP.UNRESOLVED;
      phaseWarnings.push(`--phase ${shown(phaseArg)} did not match a phase directory; context omitted.`);
    }
  } else if (phaseDirArg !== undefined) {
    // Nothing to check it against; honouring it would make it the unconfined
    // caller path this design avoids (#4354).
    drop = PHASE_DROP.PHASE_DIR_ALONE;
    phaseWarnings.push('--phase-dir requires --phase; it is verified against the token\'s resolution, never used alone. Context omitted.');
  }
  return { context: phaseContext, warnings: phaseWarnings, drop };
}

/**
 * The full config/registry/capability-state resolution `cmdLoopRenderHooks` performs, minus its
 * CLI-only output formatting — extracted so an in-process caller (e.g. `review-lane dispatch-step`
 * self-verifying a `supportsReviewerLanes` trait) can reach the SAME resolution `gsd_run loop
 * render-hooks <point> --raw` would give it, without spawning a subprocess and re-parsing its
 * stdout (which was subject to `io.cjs`'s `@file:` overflow protocol on the rendered-string
 * envelope — a bug class this in-process call cannot hit, since it never touches that envelope
 * or its rendering at all).
 *
 * Throws on an invalid `point` (mirrors `resolveLoopHooks`); callers convert to their own error
 * channel. `options.phase` / `options.phaseDir` (#4030) are resolved by `resolvePhaseContext` into
 * the returned `context` (and `phaseDrop` when the token is dropped). Emits the same loud stderr
 * warnings `cmdLoopRenderHooks` always has, regardless of caller — load failures plus dropped
 * phase context; a skipped gate must never be silently invisible.
 */
function resolveActiveHooksForPoint(
  cwd: string,
  point: string,
  options: Record<string, unknown> = {},
): ResolvedActiveHooks {
  const runtimeConfigDir = typeof options['configDir'] === 'string'
    ? options['configDir']
    : undefined;
  // #2003: thread an explicit --runtime override into the capability-state
  // resolver so the config-dir resolution bypasses the persisted-runtime
  // fallback (GSD_RUNTIME → config.runtime). Without this, a repo with persisted
  // runtime:"codex" resolves the config dir to ~/.codex and execute:post /
  // verify:post hooks silently no-op when the operator drives from Claude Code.
  const runtimeOverride = typeof options['runtime'] === 'string' ? options['runtime'] : undefined;
  // Load the config snapshot ONCE and share it with both the capability-state
  // resolver (via configOverride) and loop-hook resolution, so federated keys
  // present in loadConfig resolve identically for `active` and for hook when/
  // configValues — eliminating the previous double loadConfig() call. Note: keys
  // absent from loadConfig still fall through to raw .planning/config.json reads
  // (precedence levels 2-3) in each pass; that residual re-read window is
  // pre-existing (unchanged by this consolidation), not introduced here.
  const { config, reason: configReason } = loadConfigResolved(cwd);
  const configFault = configReason === CONFIG_REASON.CONFIG_UNPARSEABLE || configReason === CONFIG_REASON.CONFIG_UNREADABLE
    ? configReason
    : undefined;
  const state = resolveCapabilityRuntimeState(cwd, runtimeConfigDir, config, runtimeOverride) as {
    warnings?: string[];
    capabilities: Array<{ id: string; enabled?: boolean; active: boolean }>;
  };
  // Load overlay-aware registry (ADR-1244 D2 wiring) so installed third-party
  // capabilities are visible to loop rendering exactly like first-party ones.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { loadRegistry } = require('./capability-loader.cjs') as { loadRegistry: (opts?: Record<string, unknown>) => Record<string, unknown> };
  // #1459 IC-04: thread the consent home (process.env.GSD_HOME) EXPLICITLY so a consented project cap's
  // loop surfaces (steps/gates/contributions) render here at the SAME home that gated its activation.
  const registry = loadRegistry({ includeInstalled: true, cwd, gsdHome: process.env['GSD_HOME'] });
  const capabilityStatesById = new Map<string, { enabled?: boolean; active: boolean }>();
  for (const cap of state.capabilities || []) {
    capabilityStatesById.set(cap.id, cap);
  }

  const resolved: ResolveLoopHooksResult = resolveLoopHooks({ point, registry, config, cwd, capabilityStatesById });

  const { context: phaseContext, warnings: phaseWarnings, drop: phaseDrop } = resolvePhaseContext(
    cwd,
    typeof options['phase'] === 'string' ? options['phase'] : undefined,
    typeof options['phaseDir'] === 'string' ? options['phaseDir'] : undefined,
    config['project_code'],
    config['phase_naming'],
    configFault,
  );

  // ── ADR-1244 D2: load-failed capability gates FAIL OPEN with a loud warning ────
  // Decision (#2009): a capability that failed to LOAD must not block the loop.
  // The prior behavior injected a BLOCKING synthetic gate (blocking:true,
  // onError:'halt') at every point where the skipped cap declared a gate, so a
  // single incompatible capability halted every ship:pre / verify:post
  // project-wide for a load error unrelated to what the gate checked — with no
  // remediation surfaced. We now fail OPEN: no gate is injected (the loop proceeds
  // and `--active-cap <failed-cap>` correctly reports it inactive), and a loud
  // warning is emitted instead — to STDERR (which the operator, or the agent
  // running the command, actually sees regardless of how the host workflow
  // consumes stdout) AND in the envelope's `warnings` channel for structured
  // consumers. The warning names the load reason and the exact
  // `gsd capability remove <id>` remediation so the operator can clear the broken
  // capability. blockedGates is still recorded by the loader; only the consequence
  // changes from block to warn. step/contribution overlays were already skip-open.
  //
  // The gate injection was dropped rather than made non-blocking because no host
  // workflow generically surfaces an arbitrary gate's message at ship:pre /
  // verify:post (consumers dispatch on specific capIds / ref.skills), and the
  // generic gate consumers expect an object-shaped `check`, not a prose string —
  // so an injected advisory gate would be silently dropped or mis-dispatched. A
  // stderr warning is the channel that is actually surfaced. (See #2009 review.)
  const overlayMeta = (registry as { _overlay?: { blockedGates?: Array<{ point: string; capId: string; reason: string }> } })['_overlay'];
  const loadFailWarnings: string[] = [];
  if (overlayMeta && Array.isArray(overlayMeta.blockedGates)) {
    for (const blocked of overlayMeta.blockedGates) {
      if (blocked.point !== point) continue;
      // Security (#2009 review): capId/reason come from a third-party manifest or
      // directory name. Validate capId before embedding it in the runnable
      // remediation command; withhold it (no runnable command) if it is not a
      // canonical id. Strip control chars/backticks from reason.
      const idValid = LOAD_FAIL_CAP_ID_RE.test(String(blocked.capId));
      const capLabel = idValid
        ? `"${blocked.capId}"`
        : 'with an invalid id (withheld) under .gsd/capabilities/';
      const remediation = idValid
        ? `Run \`gsd capability remove ${blocked.capId}\` to remove it, or fix the load error.`
        : 'Remove the offending capability directory under .gsd/capabilities/, or fix the load error.';
      loadFailWarnings.push(
        `capability ${capLabel} failed to load (${sanitizeLoadFailReason(blocked.reason)}); ` +
        `its gate at ${point} is SKIPPED and NOT enforced (failing open). ${remediation}`,
      );
    }
  }
  // Emit loudly to stderr in EVERY output mode (including --active-cap), so a
  // skipped gate or a dropped #4030 phase context reaches the operator/agent
  // even when the caller only captures the `*_HOOKS_JSON` envelope. The phase
  // warnings also stay in the envelope's `warnings`, which loop-hook-dispatch.md
  // reads (via `phaseDrop`) to choose the ref.command phase argument. state.warnings is only read
  // here (into combinedWarnings below), never written to stderr.
  for (const w of [...loadFailWarnings, ...phaseWarnings]) {
    process.stderr.write(`gsd: warning — ${w}\n`);
  }

  // Surface capability-state warnings and the #2009 load-failure fail-open warnings together
  // (in addition to the stderr emission above, which is the channel host workflows actually see).
  const combinedWarnings = [...(state.warnings || []), ...loadFailWarnings, ...phaseWarnings];

  return { point: resolved.point, activeHooks: resolved.activeHooks, warnings: combinedWarnings, context: phaseContext, phaseDrop };
}

// ─── #5105 R2: post-fingerprint hook gating ────────────────────────────────

interface SkippedHook {
  capId: string;
  kind: 'step';
  ref?: HookRef;
  reason: 'produces-present';
  artifacts: string[];
}

/**
 * #5105 R2: a `produces` entry `p` "exists" in `phaseDir` when it resolves via
 * the SAME phase-artifact selection core `resolveVerificationFile`/
 * `resolveUatFile` delegate to (`resolvePhaseArtifactFile`, `verification.cts`)
 * — no second derivation of "which file counts as this phase's artifact"
 * (#3473 F2's generative-divergence class). That core is pure and takes an
 * already-read directory listing of REGULAR-file names only, so a directory
 * of the same name, or a suffixed near-miss (`p.bak`, `p.tmp`), never counts,
 * and `phaseDirName` scoping rejects a stray cross-phase file (`02-SECURITY.md`
 * inside a `01-foo` phase dir) exactly as the aggregate scans do.
 */
function producesEntryPresent(fileNames: readonly string[], phaseDirName: string, p: string): boolean {
  return resolvePhaseArtifactFile([...fileNames], p, { phaseDirName, allowBare: true }) !== null;
}

/**
 * #5105 R2: partition `activeHooks` by whether every one of a `kind:"step"`
 * hook's declared `produces` artifacts already exists (as a regular file)
 * directly in `phaseDir`. A hook with `produces: []` (e.g. mempalace-capture),
 * and every gate/contribution, passes through unchanged in `activeHooks`.
 *
 * Throws when `phaseDir` cannot be read (fail closed — the caller converts
 * this to a `coreError` exit, never a silent pass-everything-through).
 */
function partitionHooksByFingerprint(
  activeHooks: readonly ActiveHook[],
  phaseDir: string,
): { activeHooks: ActiveHook[]; skippedHooks: SkippedHook[] } {
  const entries = fs.readdirSync(phaseDir, { withFileTypes: true });
  const fileNames = entries.filter((e) => e.isFile()).map((e) => e.name);
  const phaseDirName = path.basename(phaseDir);

  const kept: ActiveHook[] = [];
  const skipped: SkippedHook[] = [];
  for (const hook of activeHooks) {
    if (hook.kind !== 'step' || !hook.produces || hook.produces.length === 0) {
      kept.push(hook);
      continue;
    }
    const everyProduced = hook.produces.every((p) => producesEntryPresent(fileNames, phaseDirName, p));
    if (everyProduced) {
      skipped.push({
        capId: hook.capId,
        kind: 'step',
        ref: hook.ref,
        reason: 'produces-present',
        artifacts: [...hook.produces],
      });
    } else {
      kept.push(hook);
    }
  }
  return { activeHooks: kept, skippedHooks: skipped };
}

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

  // --active-cap <capId> mode: emit 'true' or 'false' only (scanner-safe, no JSON envelope)
  const activeCapId = typeof options['activeCap'] === 'string' ? options['activeCap'] : undefined;
  if (activeCapId !== undefined && activeCapId === '') {
    coreError('--active-cap requires a <capId> value (e.g. --active-cap tdd)');
    return;
  }

  let result: ResolvedActiveHooks;
  try {
    result = resolveActiveHooksForPoint(cwd, point, options);
  } catch (err: unknown) {
    const msg = (err instanceof Error) ? err.message : String(err);
    coreError(msg);
    return;
  }

  // #5105 R2: --after-fingerprint <phaseDir> — gate out verify:post steps
  // whose declared artifact(s) already exist in phaseDir (execute-phase
  // already dispatched them before its own fingerprint; a re-dispatch here
  // would write a post-fingerprint covered path for no reason, #4981/#4887).
  const afterFingerprintDir = typeof options['afterFingerprint'] === 'string' ? options['afterFingerprint'] : undefined;
  let skippedHooks: SkippedHook[] | undefined;
  if (afterFingerprintDir !== undefined) {
    // #5105 S10: resolve relative to the handler's own cwd (never the
    // process cwd) and fail closed if it escapes the project root — the same
    // `requireSafePath` seam `uat.cts`'s `cmdUatCompleteSession` uses for its
    // own path argument.
    let safePhaseDir: string;
    try {
      safePhaseDir = requireSafePath(afterFingerprintDir, cwd, '--after-fingerprint directory', PathAcceptance.AbsoluteInsideRoot);
    } catch (err: unknown) {
      const msg = (err instanceof Error) ? err.message : String(err);
      coreError(`--after-fingerprint directory is unsafe: ${msg}`);
      return;
    }
    let partition: { activeHooks: ActiveHook[]; skippedHooks: SkippedHook[] };
    try {
      partition = partitionHooksByFingerprint(result.activeHooks, safePhaseDir);
    } catch (err: unknown) {
      const msg = (err instanceof Error) ? err.message : String(err);
      coreError(`--after-fingerprint phase directory not found or unreadable: ${afterFingerprintDir} (${msg})`);
      return;
    }
    result = { ...result, activeHooks: partition.activeHooks };
    skippedHooks = partition.skippedHooks;
  }

  if (activeCapId !== undefined) {
    const isActive = result.activeHooks.some((h) => h.capId === activeCapId);
    process.stdout.write(isActive ? 'true\n' : 'false\n');
    return;
  }

  const rendered = renderLoopHooks({ point: result.point, activeHooks: result.activeHooks });
  const envelope: {
    point: string;
    activeHooks: ActiveHook[];
    rendered: string;
    warnings?: string[];
    skippedHooks?: SkippedHook[];
    context?: PhaseContext; // present when --phase resolved to one phase directory
    phaseDrop?: PhaseDrop; // present when --phase was dropped, with the typed reason
  } = {
    point: result.point,
    activeHooks: result.activeHooks,
    rendered,
  };
  if (result.context) envelope.context = result.context;
  if (result.phaseDrop) envelope.phaseDrop = result.phaseDrop;
  if (result.warnings.length > 0) {
    envelope.warnings = result.warnings;
  }
  if (skippedHooks !== undefined) {
    envelope.skippedHooks = skippedHooks;
  }

  coreOutput(envelope, raw);
}

export = {
  resolveLoopHooks,
  renderLoopHooks,
  cmdLoopRenderHooks,
  resolveActiveHooksForPoint,
  PHASE_DROP, PHASE_TOKEN_RE,
  partitionHooksByFingerprint,
  // Exported for tests
  _getNestedConfigValue,
  _resolveActivationValue,
  _readRawConfigKey,
  // Re-exported for identity parity guard (FIX 2: resolveConfigValues in this module
  // calls resolveConfigKey; exporting it here makes the single-owner contract testable).
  resolveConfigKey,
  // #3661: re-exported for the same identity parity guard — isActive calls
  // _resolvePointGate; exporting it here makes the single-owner contract testable
  // (see tests/capability-precedence-parity.test.cjs's identity guard describe block).
  _resolvePointGate,
  CANONICAL_POINTS_FALLBACK,
  CANONICAL_POINTS,
};
