'use strict';
/**
 * Runtime config adapter registry — dispatch table for install-phase config
 * mutations (issue #60), replacing inline `runtime === '...'` branching in
 * bin/install.js.
 *
 * ADR-857 phase 5g drive 2: The hand-kept REGISTRY const has been retired.
 * Values are now read directly from the capability-registry.cjs descriptor
 * (capabilities/<id>/capability.json runtime block) so a single source of
 * truth drives all surfaces.
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
 *     false for codex / copilot / kilo / cursor / windsurf / trae / cline / kimi (legacy exclusion list).
 *     true for all other runtimes.
 * - `finishPermissionWriter` names the finishInstall-phase dedicated config writer:
 *     'opencode'    → writes BOTH shared settings AND its own permissions file.
 *     'kilo'        → writes only its own permissions file.
 *     'antigravity' → writes BOTH shared settings.json permissions.allow AND a
 *                      standalone mcp_config.json MCP companion profile (#2096
 *                      Phase B Upgrades 1+2).
 *     null          → no dedicated permission writer.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runtimes } = require('./capability-registry.cjs');
/** Valid sandboxTier enum values — mirrors the gen-capability-registry validator vocabulary. */
const VALID_SANDBOX_TIERS = new Set(['none', 'codex-agent-sandbox']);
/**
 * The complete set of 16 supported runtimes for config-adapter dispatch.
 *
 * Excludes runtimes whose installSurface is 'none' (#2103 — e.g. VS Code): a
 * 'none' installSurface means the runtime has NO CLI install surface at all
 * (Marketplace/VSIX-distributed, never dispatched through
 * install()/finishInstall()), so it is not a "config-adapter runtime" by
 * definition. This keeps this set in lockstep with bin/install.js's
 * `allRuntimes` (see the folded:issue-57-runtime-install-no-drift describe
 * block in tests/runtime-config-adapter-registry.test.cjs) without needing a
 * separate hand-kept exclusion list.
 */
const ALLOWED_CONFIG_RUNTIMES = new Set(Object.entries(runtimes)
    .filter(([, cap]) => cap && cap.runtime && typeof cap.runtime['installSurface'] === 'string' && cap.runtime['installSurface'] !== 'none')
    .map(([id]) => id));
/** All valid installSurface values. */
const INSTALL_SURFACES = Object.freeze([
    'settings-json',
    'codex-toml',
    'copilot-instructions',
    'cline-rules',
    'cursor-hooks-json',
    'profile-marker-only',
    'none',
]);
/**
 * Resolve the config adapter intent for a given runtime.
 *
 * Returns a fresh object each call so callers cannot poison the registry by
 * mutating the returned value.
 *
 * @throws {TypeError} if runtime is not a known supported runtime.
 */
function resolveRuntimeConfigIntent(runtime) {
    const entry = runtimes[runtime]?.runtime;
    if (!entry)
        throw new TypeError(`Unknown runtime for config adapter: ${runtime}`);
    const permissionWriter = entry['permissionWriter'];
    return {
        runtime,
        installSurface: entry['installSurface'],
        writesSharedSettings: entry['writesSharedSettings'],
        finishPermissionWriter: permissionWriter == null ? null : permissionWriter,
    };
}
function resolveInstallPlanFromRuntimes(runtimeDescriptors, runtime) {
    const desc = runtimeDescriptors[runtime]?.runtime;
    if (!desc)
        throw new TypeError(`Unknown runtime for install plan: ${runtime}`);
    if (desc['hooksSurface'] == null) {
        throw new TypeError(`runtime.hooksSurface is required for install plan: ${runtime}`);
    }
    const sandboxTier = desc['sandboxTier'];
    if (typeof sandboxTier !== 'string' || !VALID_SANDBOX_TIERS.has(sandboxTier)) {
        throw new TypeError(`Runtime '${runtime}' has a missing or invalid sandboxTier descriptor axis: ${JSON.stringify(sandboxTier)}`);
    }
    const permissionWriter = desc['permissionWriter'];
    return {
        runtime,
        installSurface: desc['installSurface'],
        writesSharedSettings: desc['writesSharedSettings'],
        finishPermissionWriter: permissionWriter == null ? null : permissionWriter,
        hookEvents: desc['hookEvents'],
        extendedHookEvents: Array.isArray(desc['extendedHookEvents']) ? [...desc['extendedHookEvents']] : [],
        hooksSurface: desc['hooksSurface'],
        sandboxTier,
    };
}
/**
 * Resolve the complete install plan for a given runtime.
 *
 * Composes the config-intent axes from resolveRuntimeConfigIntent PLUS the
 * three hook axes (hookEvents / extendedHookEvents / hooksSurface) that
 * install() previously read scattered from the capability registry.
 *
 * ADR-857 phase 5g capstone — single typed seam for all install-level
 * descriptor reads. Returns a fresh object each call.
 *
 * @throws {TypeError} if runtime is not a known supported runtime.
 */
function resolveInstallPlan(runtime) {
    return resolveInstallPlanFromRuntimes(runtimes, runtime);
}
module.exports = { resolveRuntimeConfigIntent, resolveInstallPlan, resolveInstallPlanFromRuntimes, ALLOWED_CONFIG_RUNTIMES, INSTALL_SURFACES };
