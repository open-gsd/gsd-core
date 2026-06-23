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
    for (const kind of layout.kinds) {
        let stagedDir;
        try {
            stagedDir = kind.stage(resolvedProfile);
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
        }
        catch (err) {
            return { ok: false, kind: 'rewrite_failed', message: errorMessage(err), cleanupDirs, failedKind: kind.kind };
        }
        items.push({
            kind: kind.kind,
            sourceDir,
            destDir: path.join(layout.configDir, kind.destSubpath),
        });
    }
    return { ok: true, plan: { items, cleanupDirs } };
}
function createRuntimeArtifactUninstallPlan(layout) {
    return {
        items: layout.kinds.map((kind) => ({
            kind: kind.kind,
            destDir: path.join(layout.configDir, kind.destSubpath),
        })),
    };
}
module.exports = { createRuntimeArtifactInstallPlan, createRuntimeArtifactUninstallPlan };
