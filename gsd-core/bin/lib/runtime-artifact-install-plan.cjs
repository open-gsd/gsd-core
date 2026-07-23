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
    const resolved = path.resolve(configDir, destSubpath);
    if (resolved === root || !resolved.startsWith(root + path.sep)) {
        throw new Error(`destSubpath "${destSubpath}" must be a strict subpath of configHome "${configDir}" — not configHome itself or outside it (escapes configHome)`);
    }
    return resolved;
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
    const { layout, resolvedProfile, homedir, platform, resolveAttribution, deps = {}, } = args;
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
    // ADR-1235 §1: build agentCtx once per plan so agents kind entries can apply
    // the CORRECT pre-converter cross-cutting (path rewrites → attribution → converter
    // → normalize). This mirrors the exact per-file order in the inline agent loop
    // in bin/install.js (lines 9330-9415). agentCtx is passed as the second arg
    // to kind.stage() for agents kind entries with a converter (convertedAgentsKind).
    // NO _stampNonClaudeRuntimeDefaults — agents are NOT stamped in the inline loop.
    const os = _require('node:os');
    const { posixNormalize } = _require('./shell-command-projection.cjs');
    const homedirFn = homedir ?? (() => os.homedir());
    const resolvedTarget = posixNormalize(path.resolve(layout.configDir));
    const homeDir = posixNormalize(homedirFn());
    const isGlobal = scope === 'global';
    const isOpencode = layout.runtime === 'opencode';
    const isWindowsHost = (platform ?? process.platform) === 'win32';
    const pathPrefix = conversionExports._computePathPrefix({ isGlobal, isOpencode, isWindowsHost, resolvedTarget, homeDir });
    const attribution = resolveAttribution ? resolveAttribution(layout.runtime) : undefined;
    const agentCtx = { runtime: layout.runtime, pathPrefix, attribution };
    for (const kind of layout.kinds) {
        let stagedDir;
        try {
            if (kind.kind === 'agents') {
                // ADR-1235 §1: pass agentCtx so stageAgentsForRuntimeWithConverter applies
                // the full inline-loop order: pathRewrites → attribution → converter → normalize.
                // The cross-cutting is now PRE-converter (inside staging), not POST.
                stagedDir = kind.stage(resolvedProfile, agentCtx);
            }
            else {
                stagedDir = kind.stage(resolvedProfile);
            }
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
            // agents kind: cross-cutting already applied INSIDE kind.stage() via agentCtx.
            // No POST-step needed. sourceDir stays as stagedDir.
        }
        catch (err) {
            return { ok: false, kind: 'rewrite_failed', message: errorMessage(err), cleanupDirs, failedKind: kind.kind };
        }
        items.push({
            kind: kind.kind,
            sourceDir,
            destDir: assertDestWithinConfigHome(kind.home ?? layout.configDir, kind.destSubpath),
        });
    }
    return { ok: true, plan: { items, cleanupDirs } };
}
function createRuntimeArtifactUninstallPlan(layout) {
    return {
        items: layout.kinds.map((kind) => ({
            kind: kind.kind,
            destDir: assertDestWithinConfigHome(kind.home ?? layout.configDir, kind.destSubpath),
        })),
    };
}
module.exports = { assertDestWithinConfigHome, createRuntimeArtifactInstallPlan, createRuntimeArtifactUninstallPlan };
