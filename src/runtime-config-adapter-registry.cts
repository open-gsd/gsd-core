'use strict';

/**
 * Runtime config adapter registry — explicit dispatch table for install-phase
 * config mutations (issue #60), replacing inline `runtime === '...'` branching
 * in bin/install.js.
 *
 * Design notes:
 * - `installSurface` selects which config handler install() runs:
 *     'settings-json'        → fall through to the shared settings.json accumulation.
 *     'codex-toml'           → early-return after writing codex.toml.
 *     'copilot-instructions' → early-return after writing .github/copilot-instructions.md.
 *     'cline-rules'          → early-return after writing .clinerules.
 *     'cursor-hooks-json'    → early-return after writing .cursor/hooks.json (issue #777).
 *     'profile-marker-only'  → early-return after writing only the profile marker.
 * - `writesSharedSettings` is the finishInstall writeSettings gate:
 *     false for codex / copilot / kilo / cursor / windsurf / trae / cline (legacy exclusion list).
 *     true for all other runtimes.
 * - `finishPermissionWriter` names the finishInstall-phase dedicated config writer:
 *     'opencode' → writes BOTH shared settings AND its own permissions file.
 *     'kilo'     → writes only its own permissions file.
 *     null       → no dedicated permission writer.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ConfigInstallSurface =
  | 'settings-json'
  | 'codex-toml'
  | 'copilot-instructions'
  | 'cline-rules'
  | 'cursor-hooks-json'
  | 'profile-marker-only';

type FinishPermissionWriter = 'opencode' | 'kilo' | null;

interface RuntimeConfigIntent {
  runtime: string;
  installSurface: ConfigInstallSurface;
  writesSharedSettings: boolean;
  finishPermissionWriter: FinishPermissionWriter;
}

interface RegistryEntry {
  installSurface: ConfigInstallSurface;
  writesSharedSettings: boolean;
  finishPermissionWriter: FinishPermissionWriter;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const REGISTRY: Record<string, Readonly<RegistryEntry>> = Object.freeze({
  claude:      Object.freeze({ installSurface: 'settings-json',        writesSharedSettings: true,  finishPermissionWriter: null       } as const),
  gemini:      Object.freeze({ installSurface: 'settings-json',        writesSharedSettings: true,  finishPermissionWriter: null       } as const),
  antigravity: Object.freeze({ installSurface: 'settings-json',        writesSharedSettings: true,  finishPermissionWriter: null       } as const),
  augment:     Object.freeze({ installSurface: 'settings-json',        writesSharedSettings: true,  finishPermissionWriter: null       } as const),
  qwen:        Object.freeze({ installSurface: 'settings-json',        writesSharedSettings: true,  finishPermissionWriter: null       } as const),
  hermes:      Object.freeze({ installSurface: 'settings-json',        writesSharedSettings: true,  finishPermissionWriter: null       } as const),
  codebuddy:   Object.freeze({ installSurface: 'settings-json',        writesSharedSettings: true,  finishPermissionWriter: null       } as const),
  opencode:    Object.freeze({ installSurface: 'settings-json',        writesSharedSettings: true,  finishPermissionWriter: 'opencode' } as const),
  kilo:        Object.freeze({ installSurface: 'settings-json',        writesSharedSettings: false, finishPermissionWriter: 'kilo'     } as const),
  codex:       Object.freeze({ installSurface: 'codex-toml',           writesSharedSettings: false, finishPermissionWriter: null       } as const),
  copilot:     Object.freeze({ installSurface: 'copilot-instructions', writesSharedSettings: false, finishPermissionWriter: null       } as const),
  cline:       Object.freeze({ installSurface: 'cline-rules',          writesSharedSettings: false, finishPermissionWriter: null       } as const),
  cursor:      Object.freeze({ installSurface: 'cursor-hooks-json',    writesSharedSettings: false, finishPermissionWriter: null       } as const),
  windsurf:    Object.freeze({ installSurface: 'profile-marker-only',  writesSharedSettings: false, finishPermissionWriter: null       } as const),
  trae:        Object.freeze({ installSurface: 'profile-marker-only',  writesSharedSettings: false, finishPermissionWriter: null       } as const),
  qoder:       Object.freeze({ installSurface: 'profile-marker-only',  writesSharedSettings: false, finishPermissionWriter: null       } as const),
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/** The complete set of 15 supported runtimes for config-adapter dispatch. */
const ALLOWED_CONFIG_RUNTIMES: ReadonlySet<string> = new Set(Object.keys(REGISTRY));

/** All valid installSurface values. */
const INSTALL_SURFACES: ReadonlyArray<ConfigInstallSurface> = Object.freeze([
  'settings-json',
  'codex-toml',
  'copilot-instructions',
  'cline-rules',
  'cursor-hooks-json',
  'profile-marker-only',
]);

/**
 * Resolve the config adapter intent for a given runtime.
 *
 * Returns a fresh object each call so callers cannot poison the registry by
 * mutating the returned value.
 *
 * @throws {TypeError} if runtime is not a known supported runtime.
 */
function resolveRuntimeConfigIntent(runtime: string): RuntimeConfigIntent {
  if (!Object.hasOwn(REGISTRY, runtime)) {
    throw new TypeError(`Unknown runtime for config adapter: ${runtime}`);
  }
  const entry = REGISTRY[runtime];
  return {
    runtime,
    installSurface:        entry.installSurface,
    writesSharedSettings:  entry.writesSharedSettings,
    finishPermissionWriter: entry.finishPermissionWriter,
  };
}

export = { resolveRuntimeConfigIntent, ALLOWED_CONFIG_RUNTIMES, INSTALL_SURFACES };
