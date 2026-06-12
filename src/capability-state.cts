/**
 * Capability State Resolver — ADR-857 phase 4b
 *
 * Unified capability-state resolver that composes the three toggle systems
 * (install profile, runtime surface, config activation) into one per-capability
 * view. ADDITIVE — install/surface/workflows are untouched; this resolver is
 * exposed only as the `gsd-tools capability state` diagnostic, not yet consumed by
 * any workflow (workflow wiring is the phase-6 cutover).
 *
 * Exports (three things, mirroring loop-resolver):
 *   resolveCapabilityState({ registry, installedSkills, surfacedSkills, config, cwd })
 *     → { capabilities: CapabilityStateEntry[] }
 *   cmdCapabilityState(cwd, runtimeConfigDir, raw, options) — I/O entry point
 *
 * resolveCapabilityState is DETERMINISTIC given (registry, installedSkills,
 * surfacedSkills, config) and — when `cwd` is provided — the project config
 * files at `cwd` (.planning/config.json etc). Pass `cwd: undefined` for a
 * pure, config-only resolution with no filesystem I/O.
 * cmdCapabilityState is the I/O handler.
 *
 * Dependencies (leaf modules only — no core.cjs circular risk):
 *   - node:path (used by _resolveActivationValue via loop-resolver)
 *   - ./core.cjs               (output, error)
 *   - ./loop-resolver.cjs      (_resolveActivationValue — reuse the export)
 *   - ./install-profiles.cjs   (readActiveProfile, loadSkillsManifest, resolveProfile)
 *   - ./surface.cjs            (resolveSurface)
 *   - ./config-loader.cjs      (loadConfig)
 *   - ./runtime-homes.cjs      (getGlobalConfigDir — for runtimeConfigDir auto-detection)
 *   - capability-registry.cjs  (loaded at call time)
 */

import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
import core = require('./core.cjs');
const { output: coreOutput, error: coreError } = core;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import loopResolverMod = require('./loop-resolver.cjs');
const { _resolveActivationValue } = loopResolverMod;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import configLoaderMod = require('./config-loader.cjs');
const { loadConfig } = configLoaderMod;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import installProfilesMod = require('./install-profiles.cjs');
const { readActiveProfile, loadSkillsManifest, resolveProfile } = installProfilesMod;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import surfaceMod = require('./surface.cjs');
const { resolveSurface } = surfaceMod;

// ─── Types ────────────────────────────────────────────────────────────────────

interface HookEntry {
  /** Loop point this hook fires at */
  point: string;
  /** Which hook kind */
  kind: 'step' | 'gate' | 'contribution';
  /**
   * The raw `when` value from the registry entry. Carried through for
   * visibility (diagnostic aid). undefined = no `when` field present
   * (unconditional hook). empty-string or non-string = present but
   * malformed → inactive (mirrors loop-resolver semantics).
   */
  when: unknown;
  /** Whether this hook is currently active based on config */
  active: boolean;
}

interface CapabilityStateEntry {
  id: string;
  tier: string;
  /** Skill stems this capability owns */
  skills: string[];
  /**
   * True if every skill owned by this capability is in the installed set.
   * Vacuously true for capabilities with an empty skills array.
   * True when installedSkills is the '*' sentinel (full install).
   */
  installed: boolean;
  /**
   * True if every skill owned by this capability is in the surfaced set.
   * Vacuously true for capabilities with an empty skills array.
   */
  surfaced: boolean;
  /** Resolved hook activation state across steps, gates, and contributions */
  hooks: HookEntry[];
}

interface ResolveCapabilityStateInput {
  /** The registry object (typically from capability-registry.cjs) */
  registry: Record<string, unknown>;
  /**
   * Set of installed skill stems, or '*' for full/unrestricted install.
   */
  installedSkills: Set<string> | '*';
  /** Set of surfaced skill stems for the current runtime config dir */
  surfacedSkills: Set<string>;
  /** loadConfig result for config-key activation resolution */
  config: Record<string, unknown>;
  /** Optional cwd — enables raw config.json fallback read (mirrors loop-resolver) */
  cwd?: string | undefined;
}

interface ResolveCapabilityStateResult {
  capabilities: CapabilityStateEntry[];
}

// ─── Prototype-pollution guard (inline literal, CodeQL barrier) ───────────────

function _isSafePropKey(key: unknown): key is string {
  // Inline literal guards — CodeQL barrier pattern
  if (typeof key !== 'string') return false;
  if (key === '__proto__') return false;
  if (key === 'constructor') return false;
  if (key === 'prototype') return false;
  return true;
}

// ─── Pure resolver ─────────────────────────────────────────────────────────────

/**
 * Deterministic resolver: for each capability in the registry, produce the
 * three-dimension state view:
 *   1. installed  — does the install profile cover this capability?
 *   2. surfaced   — does the runtime surface enable this capability?
 *   3. hooks      — per-hook activation derived from config `when` keys.
 *
 * Determinism contract: given the same (registry, installedSkills,
 * surfacedSkills, config) and — when `cwd` is set — the same project config
 * files at `cwd`, the output is identical across calls. Pass `cwd: undefined`
 * for a pure, config-only resolution with no filesystem I/O.
 *
 * Never throws for malformed registry/hook entries — skips/defaults defensively.
 * An empty or missing capabilities object → { capabilities: [] }.
 *
 * @param input.registry         The capability-registry.cjs module export.
 * @param input.installedSkills  Set<string> | '*' — from resolveProfile().skills.
 * @param input.surfacedSkills   Set<string> — from resolveSurface().skills.
 * @param input.config           Record from loadConfig(cwd).
 * @param input.cwd              Optional; when provided, enables raw .planning/config.json
 *                               fallback reads (levels 2+3 of _resolveActivationValue
 *                               precedence). Omit for a pure in-memory resolution.
 */
function resolveCapabilityState(input: ResolveCapabilityStateInput): ResolveCapabilityStateResult {
  const { registry, installedSkills, surfacedSkills, config, cwd } = input;

  // Guard: registry missing capabilities
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
    return { capabilities: [] };
  }
  const capabilitiesRaw = registry['capabilities'];
  if (!capabilitiesRaw || typeof capabilitiesRaw !== 'object' || Array.isArray(capabilitiesRaw)) {
    return { capabilities: [] };
  }
  const capabilitiesMap = capabilitiesRaw as Record<string, unknown>;

  const results: CapabilityStateEntry[] = [];

  for (const capId of Object.keys(capabilitiesMap)) {
    // Prototype-pollution guard on capability id
    if (!_isSafePropKey(capId)) continue;

    const cap = capabilitiesMap[capId];
    if (!cap || typeof cap !== 'object' || Array.isArray(cap)) continue;
    const capObj = cap as Record<string, unknown>;

    // Extract tier
    const tier = typeof capObj['tier'] === 'string' ? capObj['tier'] : 'unknown';

    // Extract skills array
    const skillsRaw = capObj['skills'];
    const skills: string[] = Array.isArray(skillsRaw)
      ? skillsRaw.filter((s): s is string => typeof s === 'string')
      : [];

    // ── installed ──────────────────────────────────────────────────────────────
    // Empty-skills cap → vacuously installed (no skills to be absent).
    // installedSkills === '*' → installed = true for every cap.
    let installed: boolean;
    if (installedSkills === '*') {
      installed = true;
    } else if (skills.length === 0) {
      installed = true; // vacuous: no skills required
    } else {
      installed = skills.every((s) => installedSkills.has(s));
    }

    // ── surfaced ───────────────────────────────────────────────────────────────
    // Empty-skills cap → vacuously surfaced.
    let surfaced: boolean;
    if (skills.length === 0) {
      surfaced = true; // vacuous
    } else {
      surfaced = skills.every((s) => surfacedSkills.has(s));
    }

    // ── hooks ──────────────────────────────────────────────────────────────────
    // Collect from steps, gates, contributions. Each may have a `when` key.
    // Activation semantics (mirrors loop-resolver.isActive exactly):
    //   - No `when` field present (undefined/null) → unconditional, active=true
    //   - Non-empty string `when` → resolve via _resolveActivationValue
    //   - Present-but-empty-string or non-string `when` → malformed, active=false
    // The original `when` value is carried through to the output for visibility.
    const hooks: HookEntry[] = [];

    function processHooks(
      arr: unknown[],
      kind: 'step' | 'gate' | 'contribution',
    ): void {
      for (const hookRaw of arr) {
        if (!hookRaw || typeof hookRaw !== 'object' || Array.isArray(hookRaw)) continue;
        const h = hookRaw as Record<string, unknown>;
        const point = typeof h['point'] === 'string' ? h['point'] : '';
        // Carry the raw `when` value through for visibility
        const whenRaw: unknown = h['when'];
        let active: boolean;
        if (whenRaw === undefined || whenRaw === null) {
          // No `when` field → unconditional, always active
          active = true;
        } else if (typeof whenRaw === 'string' && whenRaw.length > 0) {
          // Non-empty string `when` → resolve via _resolveActivationValue
          active = _resolveActivationValue(whenRaw, config, cwd, registry);
        } else {
          // Present-but-empty-string or non-string `when` → malformed, inactive
          // (mirrors loop-resolver.isActive: `typeof when !== 'string' || when.length === 0` → false)
          active = false;
        }
        hooks.push({ point, kind, when: whenRaw, active });
      }
    }

    const stepsRaw = capObj['steps'];
    const gatesRaw = capObj['gates'];
    const contributionsRaw = capObj['contributions'];

    processHooks(Array.isArray(stepsRaw) ? stepsRaw : [], 'step');
    processHooks(Array.isArray(gatesRaw) ? gatesRaw : [], 'gate');
    processHooks(Array.isArray(contributionsRaw) ? contributionsRaw : [], 'contribution');

    results.push({ id: capId, tier, skills, installed, surfaced, hooks });
  }

  // Deterministic sort by id for stable output across calls
  results.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  return { capabilities: results };
}

// ─── I/O command handler ───────────────────────────────────────────────────────

/**
 * Derive the commands/gsd path from __dirname (which resolves to
 * gsd-core/bin/lib/ at runtime). The source tree is:
 *   <repo>/gsd-core/bin/lib/capability-state.cjs
 *   <repo>/commands/gsd/*.md
 * So we walk up three levels: lib/ → bin/ → gsd-core/ → <repo>/, then
 * into commands/gsd/.
 */
function _resolveCommandsGsdDir(): string {
  // __dirname = gsd-core/bin/lib/
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  return path.join(repoRoot, 'commands', 'gsd');
}

/**
 * Command entry point: resolve install profile, surface, and config; compute
 * capability state; emit the envelope via core.output.
 *
 * Envelope: { runtimeConfigDir, warnings?: string[], capabilities: CapabilityStateEntry[] }
 *
 * runtimeConfigDir resolution (when not provided or empty):
 *   Uses the canonical getGlobalConfigDir from runtime-homes.cjs to detect the
 *   active runtime's config dir — the same resolver used by install.js. This
 *   correctly handles all supported runtimes (claude, codex, cursor, gemini,
 *   opencode, grok, etc.) and their env-var overrides. Defaults to claude
 *   (falls back to ~/.claude) if the resolver throws.
 *
 * Failure surfacing: genuine resolution failures (manifest/profile/surface
 * errors) are reported in the `warnings` array in the envelope. The output
 * remains useful — degraded to the best available state — but the caller can
 * detect that the state is not fully resolved.
 *
 *   Legitimate "no marker → default full profile" is NOT a warning.
 *   A thrown error during profile/surface resolution IS a warning.
 *
 * @param cwd              Project root directory
 * @param runtimeConfigDir Runtime config directory (e.g. ~/.claude). May be
 *                         empty/undefined — falls back to auto-detection.
 *                         Providing a value without a next token (e.g. the flag
 *                         is last in argv with no following value) should be
 *                         caught by the caller before invoking this function.
 * @param raw              Whether to emit raw JSON (core.output raw mode)
 * @param _options         Reserved for future use
 */
function cmdCapabilityState(
  cwd: string,
  runtimeConfigDir: string | undefined | null,
  raw: boolean,
  _options: Record<string, unknown> = {},
): void {
  const warnings: string[] = [];

  // Resolve runtimeConfigDir using the canonical runtime-homes resolver.
  // When not provided, getGlobalConfigDir(runtime) is called with 'claude'
  // as the default runtime — the same fallback as install.js. The canonical
  // resolver handles all env-var overrides (CLAUDE_CONFIG_DIR, CODEX_HOME,
  // CURSOR_CONFIG_DIR, GROK_AGENTS_HOME, etc.) correctly and without
  // fabricating env vars that don't exist upstream.
  let resolvedConfigDir: string = runtimeConfigDir || '';
  if (!resolvedConfigDir) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const runtimeHomes = require('./runtime-homes.cjs') as {
        getGlobalConfigDir: (runtime: string) => string;
      };
      // Delegate runtime detection entirely to getGlobalConfigDir: calling it
      // with 'claude' causes it to check CLAUDE_CONFIG_DIR first, falling back
      // to ~/.claude. The canonical resolver already encodes the correct env-var
      // precedence for each runtime — we do not re-implement that logic here.
      // For non-claude runtimes, the caller should pass --config-dir explicitly
      // (or set the runtime-specific env var, which getGlobalConfigDir honors).
      resolvedConfigDir = runtimeHomes.getGlobalConfigDir('claude');
    } catch {
      // Defensive fallback: use ~/.claude if the canonical resolver throws.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const os = require('node:os') as typeof import('node:os');
      resolvedConfigDir = path.join(os.homedir(), '.claude');
    }
  }

  // ── Load registry (ADR-857 phase 4c) ────────────────────────────────────────
  // Load BEFORE resolveProfile and resolveSurface so both calls receive the
  // registry and capability-contributed skills are reflected in installed/surfaced.
  // No-op today (UI capability is tier:full → only adds to 'full', which returns
  // '*' regardless) but cutover-ready for future tier:core/standard capabilities.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const registry = require('./capability-registry.cjs') as Record<string, unknown>;

  // ── Resolve installed skills (from install profile) ──────────────────────────
  // Distinguish "no profile marker → default full" (legitimate) from a thrown
  // error (surface as a warning and degrade gracefully — do NOT silently report
  // installedSkills='*' as if the install profile were truly unlimited).
  let installedSkills: Set<string> | '*';
  try {
    const commandsGsdDir = _resolveCommandsGsdDir();
    const manifest = loadSkillsManifest(commandsGsdDir);
    const profileName = readActiveProfile(resolvedConfigDir) ?? 'full';
    const resolvedInstall = resolveProfile({
      modes: profileName.split(',').map((s: string) => s.trim()),
      manifest,
      registry,
    });
    installedSkills = resolvedInstall.skills;
  } catch (err: unknown) {
    // Genuine resolution failure — surface it so the caller is not misled.
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`profile-resolution failed: ${msg}`);
    coreError(`capability state: profile resolution failed: ${msg}`);
    // Degrade to empty set (not '*') so installed=false is reported accurately.
    installedSkills = new Set<string>();
  }

  // ── Resolve surfaced skills (from runtime surface) ────────────────────────────
  let surfacedSkills: Set<string>;
  try {
    const commandsGsdDir = _resolveCommandsGsdDir();
    const manifest = loadSkillsManifest(commandsGsdDir);
    const surfaceResult = resolveSurface(resolvedConfigDir, manifest, undefined, registry);
    // resolveSurface returns { name, skills: Set<string>, agents: Set<string> }
    // (always a concrete Set — full profile is materialized)
    surfacedSkills = surfaceResult.skills instanceof Set
      ? surfaceResult.skills
      : new Set<string>();
  } catch (err: unknown) {
    // Genuine surface resolution failure — surface it so the caller is not misled.
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`surface-resolution failed: ${msg}`);
    coreError(`capability state: surface resolution failed: ${msg}`);
    surfacedSkills = new Set<string>();
  }

  // ── Load config ───────────────────────────────────────────────────────────────
  let config: Record<string, unknown>;
  try {
    config = loadConfig(cwd);
  } catch {
    config = {};
  }

  // ── Resolve state ────────────────────────────────────────────────────────────

  const result = resolveCapabilityState({
    registry,
    installedSkills,
    surfacedSkills,
    config,
    cwd,
  });

  // Build envelope — include warnings array only when non-empty so the nominal
  // path keeps the output clean and callers can check `warnings` for degraded state.
  const envelope: {
    runtimeConfigDir: string;
    warnings?: string[];
    capabilities: CapabilityStateEntry[];
  } = {
    runtimeConfigDir: resolvedConfigDir,
    capabilities: result.capabilities,
  };
  if (warnings.length > 0) {
    envelope.warnings = warnings;
  }

  coreOutput(envelope, raw);
}

export = {
  resolveCapabilityState,
  cmdCapabilityState,
  // Exported for tests
  _resolveCommandsGsdDir,
  _isSafePropKey,
};
