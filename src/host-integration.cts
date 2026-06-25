'use strict';

/**
 * Host Integration module — ADR-1239 Phase A.
 *
 * Pure, additive, no-I/O module providing a closed vocabulary for host
 * integration axes, degradation ladder, profile classification, and
 * capability negotiation.
 *
 * The SINGLE source of truth for integration axes and degradation levels.
 * All functions are pure (no side effects, no I/O).
 *
 * Per-CLI sourced axis VALUES (with citations) live in docs/reference/host-integration-capability-matrix.md — every value is documented or explicitly 'undocumented'.
 */

// ---------------------------------------------------------------------------
// Protocol version
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Undocumented sentinel — fail-closed when a host omits CLI docs for an axis
// ---------------------------------------------------------------------------

/**
 * Sentinel value used when a host descriptor's CLI docs do not state a value
 * for an axis. It VALIDATES (accepted by the validator) but NEVER propagates
 * into effective axes — it fails closed exactly like an unknown/missing value.
 *
 * Do NOT add to HOST_INTEGRATION_AXES (which is the documented vocabulary).
 */
const UNDOCUMENTED = 'undocumented';

// ---------------------------------------------------------------------------
// Closed vocabulary — axes and interface points
// ---------------------------------------------------------------------------

const HOST_INTEGRATION_AXES = Object.freeze({
  embeddingMode:   Object.freeze(['imperative', 'declarative'] as const),
  commandSurface:  Object.freeze(['slash-file', 'slash-programmatic', 'slash-toml', 'palette', 'prose-only'] as const),
  modelMode:       Object.freeze(['active', 'passive'] as const),
  hookBus:         Object.freeze(['host', 'engine', 'none'] as const),
  stateIO:         Object.freeze(['filesystem', 'sandboxed-storage', 'session-log-append'] as const),
  transport:       Object.freeze(['mcp', 'native-extension'] as const),
  runtime:         Object.freeze(['node', 'bun', 'sandboxed-web', 'python', 'go', 'rust', 'electron', 'other'] as const),
  subagentToolkit: Object.freeze(['full', 'read-only'] as const),
});

const INTERFACE_POINTS = Object.freeze(['command', 'dispatch', 'model', 'hooks', 'state', 'artifact'] as const);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type EmbeddingMode    = 'imperative' | 'declarative';
type CommandSurface   = 'slash-file' | 'slash-programmatic' | 'slash-toml' | 'palette' | 'prose-only';
type ModelMode        = 'active' | 'passive';
type HookBus          = 'host' | 'engine' | 'none';
type StateIO          = 'filesystem' | 'sandboxed-storage' | 'session-log-append';
type Transport        = 'mcp' | 'native-extension';
type HostRuntime      = 'node' | 'bun' | 'sandboxed-web' | 'python' | 'go' | 'rust' | 'electron' | 'other';
type SubagentToolkit  = 'full' | 'read-only';
type DegradationLevel = 'full' | 'degraded' | 'absent';
type InterfacePoint   = 'command' | 'dispatch' | 'model' | 'hooks' | 'state' | 'artifact';

interface DispatchCapability {
  namedDispatch: boolean;
  nested: boolean;
  maxDepth: number;
  background: boolean;
  subagentToolkit: SubagentToolkit;
  backgroundDispatch: boolean;
}

interface HostIntegrationAxes {
  embeddingMode: EmbeddingMode;
  commandSurface: CommandSurface;
  dispatch: DispatchCapability;
  modelMode: ModelMode;
  hookBus: HookBus;
  stateIO: StateIO;
  transport: Transport;
  runtime: HostRuntime;
}

interface DegradationResult {
  level: DegradationLevel;
  fallback: string;
  unknown?: boolean;
}

// ---------------------------------------------------------------------------
// Profile baselines
// ---------------------------------------------------------------------------

// Fail-closed floor: the most restrictive known value per axis, injected when a host omits an axis (degrade-closed, never assume capability).
const SAFE_DEFAULTS: HostIntegrationAxes = {
  embeddingMode:  'declarative',
  commandSurface: 'prose-only',
  dispatch: { namedDispatch: false, nested: false, maxDepth: 0, background: false, subagentToolkit: 'read-only', backgroundDispatch: false },
  modelMode:      'passive',
  hookBus:        'none',
  stateIO:        'session-log-append',
  transport:      'mcp',
  runtime:        'node',
};

const PROFILE_BASELINES: Readonly<Record<'programmatic-cli' | 'declarative-cli' | 'ide', HostIntegrationAxes>> =
  Object.freeze({
    'programmatic-cli': Object.freeze({
      embeddingMode:  'imperative',
      commandSurface: 'slash-file',
      dispatch: Object.freeze({ namedDispatch: true, nested: true, maxDepth: -1, background: true, subagentToolkit: 'full', backgroundDispatch: true }),
      modelMode:      'passive',
      hookBus:        'host',
      stateIO:        'filesystem',
      transport:      'mcp',
      runtime:        'node',
    } as HostIntegrationAxes),
    'declarative-cli': Object.freeze({
      embeddingMode:  'declarative',
      commandSurface: 'slash-file',
      dispatch: Object.freeze({ namedDispatch: true, nested: false, maxDepth: 1, background: false, subagentToolkit: 'full', backgroundDispatch: false }),
      modelMode:      'passive',
      hookBus:        'host',
      stateIO:        'filesystem',
      transport:      'mcp',
      runtime:        'node',
    } as HostIntegrationAxes),
    'ide': Object.freeze({
      embeddingMode:  'imperative',
      commandSurface: 'palette',
      dispatch: Object.freeze({ namedDispatch: true, nested: true, maxDepth: 5, background: true, subagentToolkit: 'full', backgroundDispatch: true }),
      modelMode:      'active',
      hookBus:        'engine',
      stateIO:        'sandboxed-storage',
      transport:      'mcp',
      runtime:        'sandboxed-web',
    } as HostIntegrationAxes),
  });

// ---------------------------------------------------------------------------
// degradationFor — plain data-table lookup (NOT clever code)
// ---------------------------------------------------------------------------

/**
 * Look up the degradation level for a given interface point and partial axes.
 *
 * NEVER throws. Returns { level:'absent', fallback:'...', unknown:true } for
 * any missing or unrecognised axis value.
 */
function degradationFor(point: InterfacePoint, axes: Partial<HostIntegrationAxes>): DegradationResult {
  const UNKNOWN: DegradationResult = {
    level: 'absent',
    fallback: 'unknown capability — degraded closed',
    unknown: true,
  };

  switch (point) {
    case 'command': {
      const cs = (axes as Record<string, unknown>).commandSurface;
      if (cs === 'slash-file' || cs === 'slash-programmatic') return { level: 'full', fallback: '' };
      if (cs === 'slash-toml' || cs === 'palette')            return { level: 'degraded', fallback: 'toml/palette surface — limited command routing' };
      if (cs === 'prose-only')                                 return { level: 'absent',  fallback: 'AGENTS.md prose + skills menu' };
      return UNKNOWN;
    }

    case 'dispatch': {
      const d = (axes as Record<string, unknown>).dispatch;
      if (!d || typeof d !== 'object') return UNKNOWN;
      const disp = d as Record<string, unknown>;
      if (disp.namedDispatch !== true || disp.maxDepth === 0) {
        return { level: 'absent', fallback: 'single-agent inline / SDK sub-session' };
      }
      // maxDepth < 0 means unbounded
      const isUnbounded = typeof disp.maxDepth === 'number' && Number.isFinite(disp.maxDepth) && disp.maxDepth < 0;
      const depth = (typeof disp.maxDepth === 'number' && Number.isFinite(disp.maxDepth)) ? disp.maxDepth : 0;
      const isFullDepth = isUnbounded || (disp.nested === true && depth >= 2);
      if (isFullDepth) {
        // Fail-closed: return 'full' ONLY when subagentToolkit is explicitly 'full';
        // any other value (read-only, undocumented, unknown, missing) → degraded.
        if (disp.subagentToolkit === 'full') {
          return { level: 'full', fallback: '' };
        }
        return { level: 'degraded', fallback: 'restricted/undocumented subagent toolkit — limited dispatch surface' };
      }
      // flat (maxDepth===1)
      return { level: 'degraded', fallback: 'flat dispatch — waves run inline' };
    }

    case 'model': {
      const mm = (axes as Record<string, unknown>).modelMode;
      if (mm === 'active')  return { level: 'full',     fallback: '' };
      if (mm === 'passive') return { level: 'degraded', fallback: 'instruction-injection / per-agent model field' };
      return UNKNOWN;
    }

    case 'hooks': {
      const hb = (axes as Record<string, unknown>).hookBus;
      if (hb === 'host')   return { level: 'full',     fallback: '' };
      if (hb === 'engine') return { level: 'degraded', fallback: 'engine-owned bus' };
      if (hb === 'none')   return { level: 'absent',   fallback: 'rule-text instructions' };
      return UNKNOWN;
    }

    case 'state': {
      const si = (axes as Record<string, unknown>).stateIO;
      if (si === 'filesystem')          return { level: 'full',     fallback: '' };
      if (si === 'sandboxed-storage')   return { level: 'degraded', fallback: 'sandboxed storage' };
      if (si === 'session-log-append')  return { level: 'degraded', fallback: 'append-only session log' };
      return UNKNOWN;
    }

    case 'artifact': {
      const cs = (axes as Record<string, unknown>).commandSurface;
      if (cs === 'slash-file' || cs === 'slash-programmatic') return { level: 'full',     fallback: '' };
      if (cs === 'slash-toml' || cs === 'prose-only')         return { level: 'degraded', fallback: 'menu / @-only' };
      if (cs === 'palette')                                    return { level: 'absent',   fallback: 'palette + chat participant; skills become LM tools' };
      return UNKNOWN;
    }

    default:
      return UNKNOWN;
  }
}

// ---------------------------------------------------------------------------
// profileOf
// ---------------------------------------------------------------------------

/**
 * Classify a partial set of integration axes into a named profile.
 * Returns null when no profile can be determined.
 */
function profileOf(axes: Partial<HostIntegrationAxes>): 'programmatic-cli' | 'declarative-cli' | 'ide' | null {
  const a = axes as Record<string, unknown>;
  if (a.embeddingMode === 'imperative' && a.runtime === 'sandboxed-web') return 'ide';
  if (a.embeddingMode === 'imperative')   return 'programmatic-cli';
  if (a.embeddingMode === 'declarative')  return 'declarative-cli';
  return null;
}

// ---------------------------------------------------------------------------
// EngineCapabilities + DEFAULT_ENGINE
// ---------------------------------------------------------------------------

interface EngineCapabilities {
  protocolVersion: number;
  axes: HostIntegrationAxes;
  known: typeof HOST_INTEGRATION_AXES;
}

const DEFAULT_ENGINE: EngineCapabilities = {
  protocolVersion: PROTOCOL_VERSION,
  axes: {
    embeddingMode:  'imperative',
    commandSurface: 'slash-file',
    dispatch: { namedDispatch: true, nested: true, maxDepth: -1, background: true, subagentToolkit: 'full', backgroundDispatch: true },
    modelMode:      'active',
    hookBus:        'host',
    stateIO:        'filesystem',
    transport:      'mcp',
    runtime:        'node',
  },
  known: HOST_INTEGRATION_AXES,
};

// ---------------------------------------------------------------------------
// NegotiationResult
// ---------------------------------------------------------------------------

interface NegotiationResult {
  protocolVersion: number;
  effective: HostIntegrationAxes;
  points: Record<InterfacePoint, { hostLevel: DegradationLevel; effectiveLevel: DegradationLevel; fallback: string }>;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// negotiateHostCapabilities
// ---------------------------------------------------------------------------

/**
 * Negotiate host integration capabilities against an engine.
 *
 * POST-CONDITION: every effective scalar axis value is in engine.known[axis].
 * effective never contains a value the host didn't declare AND the engine
 * cannot drive.
 *
 * NEVER throws. Returns a fresh object each call (mutation-safe).
 */
function negotiateHostCapabilities(
  host: Partial<HostIntegrationAxes> & { protocolVersion?: number },
  engine: EngineCapabilities = DEFAULT_ENGINE,
): NegotiationResult {
  const warnings: string[] = [];
  const h = host as Record<string, unknown>;
  // Warn if protocolVersion is present but not a finite number
  if (h.protocolVersion !== undefined && (typeof h.protocolVersion !== 'number' || !Number.isFinite(h.protocolVersion))) {
    warnings.push(`host protocolVersion is not a finite number — using engine version ${engine.protocolVersion}`);
  }
  const hostPV = (typeof h.protocolVersion === 'number' && Number.isFinite(h.protocolVersion)) ? h.protocolVersion : engine.protocolVersion;
  const enginePV = engine.protocolVersion;

  // Warn if host declares a newer protocol version
  if (hostPV > enginePV) {
    warnings.push(
      `host protocolVersion ${hostPV} newer than engine ${enginePV} — capabilities beyond version ${enginePV} not trusted`,
    );
  }

  // ---------------------------------------------------------------------------
  // Helper: negotiate a single scalar axis
  // ---------------------------------------------------------------------------
  function negotiateScalar<K extends keyof typeof HOST_INTEGRATION_AXES>(
    axis: K,
  ): (typeof HOST_INTEGRATION_AXES)[K][number] {
    type V = (typeof HOST_INTEGRATION_AXES)[K][number];
    const knownValues: ReadonlyArray<V> = engine.known[axis];
    const hostVal = h[axis] as V | undefined;
    const engineVal = engine.axes[axis as keyof HostIntegrationAxes] as V;
    const safeDefault = SAFE_DEFAULTS[axis as keyof HostIntegrationAxes] as V;

    if (hostVal === undefined || hostVal === null) {
      // Host did not declare this axis
      warnings.push(`host did not declare '${axis}'`);
      return safeDefault;
    }
    if ((hostVal as unknown) === UNDOCUMENTED) {
      // Host declared the undocumented sentinel — treat as fail-closed (degrade to safe default)
      warnings.push(`host axis '${axis}' is undocumented — degraded closed`);
      return safeDefault;
    }
    if (!knownValues.includes(hostVal)) {
      // Host declared an unknown/future value — NEVER copy into effective
      warnings.push(
        `host declared unknown '${axis}' value '${String(hostVal)}' — not trusted (host protocolVersion ${hostPV} vs engine ${enginePV})`,
      );
      return safeDefault;
    }
    // Engine capability cap: if the engine can't drive the host's value,
    // use the engine's lesser capability.
    // For modelMode: 'active' > 'passive' — if host wants active but engine
    // is passive, cap to passive.
    if (axis === 'modelMode') {
      if (hostVal === 'active' && engineVal === 'passive') return 'passive';
    }
    return hostVal;
  }

  // Negotiate all scalar axes
  const effectiveEmbeddingMode  = negotiateScalar('embeddingMode');
  const effectiveCommandSurface = negotiateScalar('commandSurface');
  const effectiveModelMode      = negotiateScalar('modelMode');
  const effectiveHookBus        = negotiateScalar('hookBus');
  const effectiveStateIO        = negotiateScalar('stateIO');
  const effectiveTransport      = negotiateScalar('transport');
  const effectiveRuntime        = negotiateScalar('runtime');

  // ---------------------------------------------------------------------------
  // Dispatch struct negotiation
  // ---------------------------------------------------------------------------
  const hostDispatch = (typeof h.dispatch === 'object' && h.dispatch !== null)
    ? h.dispatch as Record<string, unknown>
    : null;
  const engineDispatch = engine.axes.dispatch;

  let effectiveNamedDispatch: boolean;
  let effectiveNested: boolean;
  let effectiveBackground: boolean;
  let effectiveBackgroundDispatch: boolean;
  let effectiveSubagentToolkit: SubagentToolkit;
  let effectiveMaxDepth: number;

  if (hostDispatch === null) {
    // Host didn't declare dispatch at all — fail-closed to most-restrictive values
    warnings.push(`host did not declare 'dispatch'`);
    effectiveNamedDispatch      = false;
    effectiveNested             = false;
    effectiveBackground         = false;
    effectiveBackgroundDispatch = false;
    effectiveSubagentToolkit    = 'read-only';
    effectiveMaxDepth           = 0;
  } else {
    // N1: observability warnings for 'undocumented' sentinel on dispatch fields
    if (hostDispatch.namedDispatch === 'undocumented') {
      warnings.push(`dispatch.namedDispatch is undocumented — degraded closed`);
    }
    if (hostDispatch.nested === 'undocumented') {
      warnings.push(`dispatch.nested is undocumented — degraded closed`);
    }
    if (hostDispatch.background === 'undocumented') {
      warnings.push(`dispatch.background is undocumented — degraded closed`);
    }
    if (hostDispatch.subagentToolkit === 'undocumented') {
      warnings.push(`dispatch.subagentToolkit is undocumented — degraded closed (read-only)`);
    }
    if (hostDispatch.backgroundDispatch === 'undocumented') {
      warnings.push(`dispatch.backgroundDispatch is undocumented — degraded closed`);
    }

    effectiveNamedDispatch      = (hostDispatch.namedDispatch === true) && engineDispatch.namedDispatch;
    effectiveNested             = (hostDispatch.nested === true) && engineDispatch.nested;
    effectiveBackground         = (hostDispatch.background === true) && engineDispatch.background;
    effectiveBackgroundDispatch = (hostDispatch.backgroundDispatch === true) && engineDispatch.backgroundDispatch;

    // subagentToolkit: fail closed to read-only unless explicitly 'full'
    // (an 'undocumented' or 'read-only' value → read-only)
    const hostToolkit   = hostDispatch.subagentToolkit === 'full' ? 'full' : 'read-only';
    const engineToolkit = engineDispatch.subagentToolkit === 'read-only' ? 'read-only' : 'full';
    effectiveSubagentToolkit = (hostToolkit === 'read-only' || engineToolkit === 'read-only') ? 'read-only' : 'full';

    // maxDepth: missing/non-number/non-finite → 0 + warning
    let hostMaxDepth: number;
    if (typeof hostDispatch.maxDepth !== 'number' || !Number.isFinite(hostDispatch.maxDepth)) {
      warnings.push(`host dispatch.maxDepth is missing or not a number — treating as 0`);
      hostMaxDepth = 0;
    } else {
      hostMaxDepth = hostDispatch.maxDepth;
    }

    // Treat negative as +Infinity for the min, then if result is +Infinity emit -1
    const hDepthNum = hostMaxDepth < 0 ? Infinity : hostMaxDepth;
    const eDepthNum = engineDispatch.maxDepth < 0 ? Infinity : engineDispatch.maxDepth;
    const minDepth  = Math.min(hDepthNum, eDepthNum);
    effectiveMaxDepth = minDepth === Infinity ? -1 : minDepth;

    // If namedDispatch is false, cap maxDepth/nested/background/backgroundDispatch to 0/false/false/false (struct consistency)
    if (!effectiveNamedDispatch) {
      effectiveMaxDepth           = 0;
      effectiveNested             = false;
      effectiveBackground         = false;
      effectiveBackgroundDispatch = false;
    }
  }

  const effectiveDispatch: DispatchCapability = {
    namedDispatch:      effectiveNamedDispatch,
    nested:             effectiveNested,
    maxDepth:           effectiveMaxDepth,
    background:         effectiveBackground,
    subagentToolkit:    effectiveSubagentToolkit,
    backgroundDispatch: effectiveBackgroundDispatch,
  };

  // ---------------------------------------------------------------------------
  // Assemble effective axes
  // ---------------------------------------------------------------------------
  const effective: HostIntegrationAxes = {
    embeddingMode:  effectiveEmbeddingMode,
    commandSurface: effectiveCommandSurface,
    dispatch:       effectiveDispatch,
    modelMode:      effectiveModelMode,
    hookBus:        effectiveHookBus,
    stateIO:        effectiveStateIO,
    transport:      effectiveTransport,
    runtime:        effectiveRuntime,
  };

  // ---------------------------------------------------------------------------
  // Compute points (fresh objects — mutation-safe)
  // ---------------------------------------------------------------------------
  const points = {} as Record<InterfacePoint, { hostLevel: DegradationLevel; effectiveLevel: DegradationLevel; fallback: string }>;
  for (const point of INTERFACE_POINTS) {
    const hostDeg      = degradationFor(point, host);
    const effectiveDeg = degradationFor(point, effective);
    points[point] = {
      hostLevel:      hostDeg.level,
      effectiveLevel: effectiveDeg.level,
      fallback:       effectiveDeg.fallback,
    };
  }

  // protocolVersion: min of host and engine
  const resultProtocolVersion = Math.min(hostPV, enginePV);

  return {
    protocolVersion: resultProtocolVersion,
    effective,
    points,
    warnings: [...warnings], // fresh copy
  };
}

// ---------------------------------------------------------------------------
// shouldFlattenDispatch — ADR-1239 Phase B / #1708
// ---------------------------------------------------------------------------

/**
 * Returns true when the orchestrator MUST run inline (flatten); false when it
 * may be backgrounded.
 *
 * A host may background only if it can reliably background a nesting-capable
 * orchestrator — i.e. both `background` AND `backgroundDispatch` are
 * explicitly `true`. Any other value (false, missing, 'undocumented') fails
 * closed to inline (the always-safe path).
 *
 * This graduates the #853 prose rule (originally `RUNTIME === 'codex'`, then
 * extended to cursor) to a typed, documentation-sourced decision; codex AND
 * cursor are both background-eligible in the registry. See
 * docs/reference/host-integration-capability-matrix.md.
 *
 * Null-safety: if dispatch is null, undefined, or not an object, returns true
 * (inline, fail-closed) instead of throwing.
 */
type UnvalidatedDispatch = (Partial<DispatchCapability> & { background?: unknown; backgroundDispatch?: unknown }) | null | undefined;

function shouldFlattenDispatch(dispatch: UnvalidatedDispatch): boolean {
  if (!dispatch || typeof dispatch !== 'object') return true;
  const canBackground = dispatch.background === true && dispatch.backgroundDispatch === true;
  return !canBackground;
}

// ---------------------------------------------------------------------------
// Module export (CommonJS — matches existing src/*.cts pattern)
// ---------------------------------------------------------------------------

export = {
  PROTOCOL_VERSION,
  UNDOCUMENTED,
  HOST_INTEGRATION_AXES,
  INTERFACE_POINTS,
  PROFILE_BASELINES,
  DEFAULT_ENGINE,
  degradationFor,
  profileOf,
  negotiateHostCapabilities,
  shouldFlattenDispatch,
};
