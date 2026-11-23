'use strict';
/**
 * Runtime Artifact Install Plan Module.
 *
 * Turns a pre-resolved runtime artifact layout into staged copy inputs. The
 * installer adapter still owns pruning, copying, migrations, output, and final
 * cleanup execution.
 */
// In .cts (CommonJS output) files, `require` is available as a global.
const _require = require;
const path = _require('node:path');
const { tryWithinRootLexical } = _require('./security.cjs');
const { hostBehaviorsFor } = _require('./runtime-name-policy.cjs');
const { isMinimalMode } = _require('./install-profiles.cjs');
// #2870: InstallScope is owned by install-scope.cts, not re-declared here.
// `isGlobalScope` centralizes the `scope === 'global'` boolean projection
// this module needs at `_computePathPrefix`'s `isGlobal: boolean` boundary
// (see the module-level doc comment on `isGlobalScope` for why the
// projection is centralized rather than eliminated).
const install_scope_cjs_1 = require("./install-scope.cjs");
/**
 * Asserts that `destSubpath` resolves to a path inside `configDir`.
 *
 * Rejects any path that escapes the configDir root (e.g. "../../etc") and any
 * path containing a NUL byte. This is a security gate for Phase B of
 * ADR-1239: third-party descriptors must never be able to write outside the
 * designated config home directory.
 *
 * @param configDir - The root config directory (e.g. ~/.claude).
 * @param destSubpath - The relative path declared by the runtime descriptor.
 * @returns The resolved absolute path under configDir.
 * @throws {Error} if destSubpath escapes configDir or contains a NUL byte.
 */
function assertDestWithinConfigHome(configDir, destSubpath) {
    if (destSubpath.includes('\0')) {
        throw new Error(`destSubpath "${destSubpath}" contains a NUL byte and is not valid`);
    }
    const root = path.resolve(configDir);
    // `resolved === root` is a DELIBERATE ADDITIONAL rejection, separate from
    // the containment decision: `tryWithinRootLexical` treats target === root
    // as CONTAINED, but a destSubpath of "" (or one that resolves to configDir
    // itself) must never be accepted here — this is the strict-subpath
    // requirement Phase B of ADR-1239 imposes on third-party descriptors, and
    // it prevents a descriptor from writing at configHome itself. Kept as its
    // own check per ADR-4650 decision 6 (a wrapper may add its own conditions
    // on top of the canonical predicate, never invert it).
    const contained = tryWithinRootLexical(destSubpath, configDir);
    if (contained === null || contained === root) {
        throw new Error(`destSubpath "${destSubpath}" must be a strict subpath of configHome "${configDir}" — not configHome itself or outside it (escapes configHome)`);
    }
    return contained;
}
function resolveRuntimeArtifactDestination(configDir, kind) {
    return assertDestWithinConfigHome(resolveRuntimeArtifactInstallRoot(configDir, kind), kind.destSubpath);
}
function resolveRuntimeArtifactInstallRoot(configDir, kind) {
    if (kind?.home != null && typeof kind.home !== 'string') {
        throw new TypeError('Artifact home must be a string, null, or undefined');
    }
    return (kind && typeof kind.home === 'string' && kind.home !== '') ? kind.home : configDir;
}
function shouldInstallCombinedFamily(behaviors) {
    return Boolean(behaviors.combinedFamilyInstall);
}
function isLegacyFlatLocalInstall(behaviors, scope) {
    return scope === 'local' && behaviors.localInstallStyle === 'legacy-flat';
}
function shouldInstallStandaloneAgents(pluginOnlyInstall, skillsRuntime) {
    return !pluginOnlyInstall && !skillsRuntime;
}
function requiredRuntimeSurfaceSources(layout, scope) {
    const required = new Set();
    if (!(0, install_scope_cjs_1.isGlobalScope)(scope))
        return required;
    for (const kind of layout.kinds) {
        if (kind.kind === 'commands' || kind.kind === 'skills')
            required.add('commands');
        if (kind.kind === 'agents' || kind.kind === 'kimi-agents')
            required.add('agents');
    }
    return required;
}
function codexAgentRolesEnabled(installMode, resolvedProfile) {
    return !isMinimalMode(installMode) || (resolvedProfile.agents instanceof Set && resolvedProfile.agents.size > 0);
}
function plannedActionsMutateCodexHooksInputs(actions) {
    return actions.some((action) => (action.relPath === 'hooks.json' || action.relPath === 'config.toml') &&
        ['rewrite-json', 'remove-managed', 'backup-and-remove'].includes(action.type));
}
function copyWithPathReplacementSymlinkRefusalMessage(destDir, installRoot) {
    return `copyWithPathReplacement: destDir "${destDir}" contains a symlink the install root "${installRoot}" does not trust \u2014 refusing to write. If this is an intentional user-owned symlink layout, re-run with GSD_ALLOW_SYMLINKED_DEST=1.`;
}
function installRuntimeArtifactsSymlinkRefusalMessage(dest, installRoot) {
    return `installRuntimeArtifacts: destDir "${dest}" contains a symlink the install root "${installRoot}" does not trust \u2014 refusing to create. If this is an intentional user-owned symlink layout (e.g. externalized skills/hooks dir, multi-account configHome, or a dotfiles-managed configHome), re-run with GSD_ALLOW_SYMLINKED_DEST=1.`;
}
function installOpencodeFamilySkillsSymlinkRefusalMessage(dest, installRoot) {
    return `installOpencodeFamilySkills: destDir "${dest}" contains a symlink the install root "${installRoot}" does not trust \u2014 refusing to write. If this is an intentional user-owned symlink layout, re-run with GSD_ALLOW_SYMLINKED_DEST=1.`;
}
function installAgentsKindStandaloneSymlinkRefusalMessage(dest, installRoot) {
    return `installAgentsKindStandalone: destDir "${dest}" contains a symlink the install root "${installRoot}" does not trust \u2014 refusing to write. If this is an intentional user-owned symlink layout, re-run with GSD_ALLOW_SYMLINKED_DEST=1.`;
}
function syncRuntimeSurfaceCorpusSymlinkRefusalMessage(destination, installRoot) {
    return `syncRuntimeSurfaceCorpus: destination "${destination}" contains a symlink the install root "${installRoot}" does not trust \u2014 refusing to write.`;
}
function installCodexConfigSymlinkRefusalMessage(targetDir) {
    return `installCodexConfig: a Codex config path under "${targetDir}" contains a symlink the install root does not trust \u2014 refusing to write. If this is an intentional user-owned symlink layout, re-run with GSD_ALLOW_SYMLINKED_DEST=1.`;
}
function installCodexAgentTomlSymlinkRefusalMessage(agentTomlPath) {
    return `installCodexConfig: agent toml path "${agentTomlPath}" contains a symlink the install root does not trust \u2014 refusing to write. If this is an intentional user-owned symlink layout, re-run with GSD_ALLOW_SYMLINKED_DEST=1.`;
}
function errorMessage(err) {
    if (err instanceof Error)
        return err.message;
    return String(err);
}
function addCleanupDir(cleanupDirs, stagedDir, rewrittenDir) {
    const sourceDir = rewrittenDir ?? stagedDir;
    if (sourceDir !== stagedDir)
        cleanupDirs.push(sourceDir);
    return sourceDir;
}
function createRuntimeArtifactInstallPlan(args) {
    const { layout, resolvedProfile, homedir, platform, resolveAttribution, projectDir, deps = {}, } = args;
    const conversionExports = _require('./runtime-artifact-conversion.cjs');
    const rewriteStagedSkillBodies = deps.rewriteStagedSkillBodies ?? conversionExports.rewriteStagedSkillBodies;
    const rewriteStagedCommandBodies = deps.rewriteStagedCommandBodies ?? conversionExports.rewriteStagedCommandBodies;
    const cleanupDirs = [];
    const items = [];
    const scope = layout.scope ?? 'global';
    const rewriteOpts = {
        runtime: layout.runtime,
        configDir: layout.configDir,
        scope,
        homedir,
        platform,
        resolveAttribution,
    };
    // ADR-1235 §1: build the staging context once per plan. Agent kinds apply
    // the CORRECT pre-converter cross-cutting (path rewrites → attribution →
    // converter → normalize). This
    // mirrors the exact per-file order in the former inline agent loop.
    // NO _stampNonClaudeRuntimeDefaults — agents are NOT stamped in the inline loop.
    const os = _require('node:os');
    const { posixNormalize } = _require('./shell-command-projection.cjs');
    const homedirFn = homedir ?? (() => os.homedir());
    const resolvedTarget = posixNormalize(path.resolve(layout.configDir));
    const homeDir = posixNormalize(homedirFn());
    // #2870: `scope` above is already the module-owned `InstallScope` value
    // (`layout.scope ?? 'global'`, defaulted before this point, so it is never
    // `undefined` here) — `isGlobalScope` projects it to the boolean
    // `_computePathPrefix`'s existing `isGlobal: boolean` API requires.
    const isGlobal = (0, install_scope_cjs_1.isGlobalScope)(scope);
    const isOpencode = hostBehaviorsFor(layout.runtime).opencodePathPrefix === true;
    const isWindowsHost = (platform ?? process.platform) === 'win32';
    // #4377: descriptor-derived local dir name, so an opted-in local install
    // emits a project-relative prefix instead of this checkout's absolute path.
    const pathPrefix = conversionExports._computePathPrefix({ isGlobal, isOpencode, isWindowsHost, resolvedTarget, homeDir, localDirName: conversionExports._localIncludeDirName(layout.runtime) });
    const attribution = resolveAttribution ? resolveAttribution(layout.runtime) : undefined;
    // #2875 Part 2 (row I1): layout.configDir IS the install root the inline
    // agent loop called `targetDir` — same value, same resolution.
    const agentCtx = {
        runtime: layout.runtime,
        pathPrefix,
        attribution,
        targetDir: layout.configDir,
        projectDir: projectDir ?? layout.configDir,
    };
    for (const kind of layout.kinds) {
        let stagedDir;
        try {
            // Agent kinds use the context for their pre-converter cross-cutting
            // sequence; other kinds ignore it.
            stagedDir = kind.stage(resolvedProfile, agentCtx);
        }
        catch (err) {
            return { ok: false, kind: 'stage_failed', message: errorMessage(err), cleanupDirs, failedKind: kind.kind };
        }
        let sourceDir = stagedDir;
        try {
            if (kind.kind === 'commands') {
                const rewrittenDir = rewriteStagedCommandBodies(stagedDir, rewriteOpts);
                sourceDir = addCleanupDir(cleanupDirs, stagedDir, rewrittenDir);
            }
            else if (kind.kind === 'skills' || kind.kind === 'kimi-agents') {
                const rewrittenDir = rewriteStagedSkillBodies(stagedDir, rewriteOpts);
                sourceDir = addCleanupDir(cleanupDirs, stagedDir, rewrittenDir);
            }
            // Agent kinds: cross-cutting already applied INSIDE kind.stage() via agentCtx.
            // No POST-step needed. sourceDir stays as stagedDir.
        }
        catch (err) {
            return { ok: false, kind: 'rewrite_failed', message: errorMessage(err), cleanupDirs, failedKind: kind.kind };
        }
        items.push({
            kind: kind.kind,
            sourceDir,
            destDir: resolveRuntimeArtifactDestination(layout.configDir, kind),
        });
    }
    return { ok: true, plan: { items, cleanupDirs } };
}
function createRuntimeArtifactUninstallPlan(layout) {
    return {
        items: layout.kinds.map((kind) => ({
            kind: kind.kind,
            destDir: resolveRuntimeArtifactDestination(layout.configDir, kind),
        })),
    };
}
module.exports = {
    assertDestWithinConfigHome,
    resolveRuntimeArtifactDestination,
    resolveRuntimeArtifactInstallRoot,
    shouldInstallCombinedFamily,
    isLegacyFlatLocalInstall,
    shouldInstallStandaloneAgents,
    requiredRuntimeSurfaceSources,
    codexAgentRolesEnabled,
    plannedActionsMutateCodexHooksInputs,
    copyWithPathReplacementSymlinkRefusalMessage,
    installRuntimeArtifactsSymlinkRefusalMessage,
    installOpencodeFamilySkillsSymlinkRefusalMessage,
    installAgentsKindStandaloneSymlinkRefusalMessage,
    syncRuntimeSurfaceCorpusSymlinkRefusalMessage,
    installCodexConfigSymlinkRefusalMessage,
    installCodexAgentTomlSymlinkRefusalMessage,
    createRuntimeArtifactInstallPlan,
    createRuntimeArtifactUninstallPlan,
};
