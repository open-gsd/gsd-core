"use strict";
/**
 * Conservative cleanup for artifact surfaces retired by a runtime descriptor.
 *
 * A descriptor may stop materializing an artifact kind while old installs
 * still contain files from that surface. Install and profile/surface apply
 * both call this helper so either path converges an existing installation.
 * Only files proven managed by the previous install manifest are removed;
 * modified and unknown files are preserved for the journaled installer
 * migration (or the user) to handle without data loss.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const node_path_1 = __importDefault(require("node:path"));
// #2874 (ADR-58 cleanup phase): pruneRetiredRuntimeArtifacts is the first
// thing installRuntimeArtifacts calls, so its fs calls are routed through
// the injectable seam too — see install-fs-adapter.cts's module doc.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const installFsAdapter = require("./install-fs-adapter.cjs");
const { installFs } = installFsAdapter;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const installerMigrations = require("./installer-migrations.cjs");
const external_descriptor_trust_cjs_1 = require("./external-descriptor-trust.cjs");
// Generated at build time, so no TypeScript source declaration exists.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const capabilityRegistry = require('./capability-registry.cjs');
function retiredArtifactsFor(runtime) {
    const configured = capabilityRegistry.runtimes?.[runtime]?.runtime?.hostBehaviors?.retiredArtifacts;
    return Array.isArray(configured) ? configured : [];
}
function pruneRetiredRuntimeArtifacts(runtime, configDir) {
    const result = { removed: [], preserved: [] };
    const declarations = retiredArtifactsFor(runtime);
    if (declarations.length === 0)
        return result;
    const manifest = installerMigrations.readInstallManifest(configDir);
    for (const declaration of declarations) {
        const destSubpath = declaration.destSubpath;
        const prefix = declaration.prefix;
        const suffix = declaration.suffix;
        if (typeof destSubpath !== 'string' || destSubpath.length === 0 ||
            typeof prefix !== 'string' || prefix.length === 0 ||
            typeof suffix !== 'string' || suffix.length === 0 ||
            !(0, external_descriptor_trust_cjs_1.isPathConfined)(destSubpath, configDir)) {
            continue;
        }
        const destDir = node_path_1.default.resolve(configDir, destSubpath);
        let entries;
        try {
            if (!installFs().existsSync(destDir) || installFs().lstatSync(destDir).isSymbolicLink())
                continue;
            entries = installFs().readdirSync(destDir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith(suffix))
                continue;
            const relPath = node_path_1.default.posix.join(destSubpath.replace(/\\/g, '/'), entry.name);
            const artifact = installerMigrations.classifyArtifact(configDir, relPath, manifest);
            if (artifact.classification !== 'managed-pristine') {
                result.preserved.push(relPath);
                continue;
            }
            try {
                installFs().unlinkSync(node_path_1.default.join(destDir, entry.name));
                result.removed.push(relPath);
            }
            catch {
                result.preserved.push(relPath);
            }
        }
        try {
            if (installFs().readdirSync(destDir).length === 0)
                installFs().rmdirSync(destDir);
        }
        catch {
            // Non-empty, unreadable, or concurrently changed: preserve the directory.
        }
    }
    return result;
}
module.exports = { pruneRetiredRuntimeArtifacts, retiredArtifactsFor };
