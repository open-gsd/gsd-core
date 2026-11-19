"use strict";
/**
 * installed-surface-resolver.cts — Installed Surface Resolver Module (#2872,
 * ADR-2866, Phase 3 — governed by
 * `.gsd/phase/feat-2872-manifest-scope-runtime/40-design.md`).
 *
 * `resolveInstalledSurfaces(runtime?, opts?)` answers a question no existing
 * module answers: "which surfaces actually exist on THIS machine, across
 * BOTH install scopes, right now?" `capability-state.cts` answers "which
 * capabilities are enabled in THIS config dir" — a different question at a
 * different altitude. This module is a new leaf: it reads two scopes at
 * once, composing three already-shipped, already-tested pieces
 * (`resolveScope`, Phase 1; `resolveTriggerSurface`, Phase 2; and
 * `readInstallManifest`, widened in this same phase) rather than
 * re-implementing any of their rules.
 *
 * ── Probe-not-declared keying ───────────────────────────────────────────────
 * A scope RECORD is keyed by the PROBED scope (`resolveScope`'s own `id`),
 * never by what the manifest itself claims. `manifestVersion`/`runtime`/
 * `scope` recorded inside a v2 manifest are corroboration, not identity: a
 * manifest copied between config dirs, or a `--config-dir` install, must
 * still be reported at the scope this machine actually resolves to.
 *
 * ── Report, don't correct ───────────────────────────────────────────────────
 * When a declared `runtime`/`scope` disagrees with the probe, this module
 * reports the mismatch (`declaredScopeMatchesProbe: false` /
 * `declaredRuntimeMatchesProbe: false`) and otherwise proceeds exactly as it
 * would for an undeclared (v1) manifest. It never silently substitutes the
 * declared value for the probed one, and never throws on a mismatch — see
 * B-row "Postel's Law" discussion in the design doc.
 *
 * ── One trigger call over installed scopes only ─────────────────────────────
 * `resolveTriggerSurface` is called AT MOST once per runtime, with the
 * scopes that are actually installed on this machine (per manifest
 * presence — never per the new corroboration fields, which is what keeps a
 * v1-only install fully functional with no reinstall required). A
 * hypothetical "what if both scopes were installed" answer is deliberately
 * not offered; #2218 is a fact about THIS machine, not a simulation.
 *
 * ── Installed-ness is manifest PRESENCE, never the new fields ───────────────
 * `installed` is `manifestVersion !== null`. A v1 manifest (no
 * `manifestVersion` key at all, `manifestVersion: 1` after normalization) is
 * a correct manifest written by an older GSD — never a broken one, never
 * grounds for `installed: false`, a warning, or a reinstall prompt.
 *
 * ── Stems come from the manifest, not the source tree ───────────────────────
 * `resolveTriggerSurface` needs `stems`. They are derived from the
 * INSTALLED manifest's own `files` keys (see the private stem-derivation
 * helpers below), never from a roster read of the source tree — a global
 * `claude` install ships no `commands/gsd` source, so a roster read would
 * return `[]` in exactly the configuration #2218 is about. The derivation
 * consumes `isNamespacedByDir` and `composeCommandFilename`
 * (`runtime-artifact-layout.cjs`, #2871 Phase 2's exported helpers) rather
 * than re-deriving either rule as a fourth independent copy.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveInstalledSurfaces = resolveInstalledSurfaces;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const install_scope_cjs_1 = require("./install-scope.cjs");
const shell_command_projection_cjs_1 = require("./shell-command-projection.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const runtimeArtifactLayoutMod = require("./runtime-artifact-layout.cjs");
const { resolveRuntimeArtifactLayout, resolveRuntimeArtifactLayoutFromRegistry, resolveTriggerSurface, isNamespacedByDir, composeCommandFilename, } = runtimeArtifactLayoutMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const installerMigrationsMod = require("./installer-migrations.cjs");
const { readInstallManifest, MANIFEST_NAME } = installerMigrationsMod;
// In .cts (CommonJS output) files, `require` is available as a global.
const _require = require;
// ── Internals ───────────────────────────────────────────────────────────
/**
 * A trigger stem is a kebab-case token and nothing else. Verified against the
 * real roster: all 71 `commands/gsd/*.md` stems match this, so it has no false
 * negatives today.
 *
 * This is a SECURITY boundary, not cosmetics. A stem is derived from a manifest
 * key — attacker-influenceable text, since a project-local
 * `gsd-file-manifest.json` lives inside a repository a user may merely have
 * cloned — and Phase 4 (#2873) renders it back to the user as `/gsd-<stem>`.
 * Without this, `skills/gsd-../../../x` yields the stem `..`, and control
 * characters, newlines, ANSI escapes and RTL-override codepoints all survive
 * into that rendered trigger. The `commands` branch happened to be protected by
 * its `composeCommandFilename` round-trip; the `skills` branch had no
 * equivalent, so the rule is stated once here and applied to both.
 */
const SAFE_STEM = /^[a-z0-9][a-z0-9-]*$/;
function getDefaultRuntimeRegistry() {
    return _require('./capability-registry.cjs');
}
/** C7: every registered runtime id, sorted for determinism. Reads
 *  `opts.registry` when provided (so a sweep is assertable without the real
 *  capability registry), else the real one. */
function listRegisteredRuntimeIds(opts) {
    const registry = opts.registry ?? getDefaultRuntimeRegistry();
    return Object.keys(registry.runtimes).sort();
}
/**
 * D — the stem inverse for one `commands`/`skills` layout kind entry.
 * Consumes `isNamespacedByDir` (to decide the commands filename shape) and
 * `composeCommandFilename` (to VERIFY a candidate stem round-trips to the
 * exact filename seen) rather than re-deriving either rule locally (design
 * "Rejected" #6). Manifest keys are normalized with an unconditional
 * `.replace(/\\/g, '/')` (D7) — never gated on `path.sep` — matching this
 * repo's recorded path-separator-normalization defect class.
 */
function deriveStemsForKindEntry(kind, destSubpath, prefix, fileKeys) {
    const destSubpathNorm = (0, shell_command_projection_cjs_1.posixNormalize)(destSubpath);
    const boundary = `${destSubpathNorm}/`;
    const namespacedByDir = isNamespacedByDir(kind, destSubpath, prefix);
    const stems = new Set();
    for (const rawKey of fileKeys) {
        const key = rawKey.replace(/\\/g, '/');
        if (!key.startsWith(boundary))
            continue; // D4: key not under this declared subpath
        const rest = key.slice(boundary.length);
        if (rest === '')
            continue;
        const segments = rest.split('/');
        if (kind === 'skills') {
            const dirSegment = segments[0];
            if (!dirSegment.startsWith(prefix))
                continue; // D5: subpath matches, prefix does not
            const stem = dirSegment.slice(prefix.length);
            if (stem === '')
                continue; // D7/B7: empty stem never emitted
            if (!SAFE_STEM.test(stem))
                continue; // security: reject anything but a kebab-case token
            stems.add(stem); // D6: several files under one dir -> one stem
            continue;
        }
        // commands: exactly one path segment — the composed filename itself.
        if (segments.length !== 1)
            continue;
        const filename = segments[0];
        if (!filename.endsWith('.md'))
            continue;
        const base = filename.slice(0, -3);
        const candidateStem = namespacedByDir
            ? base
            : (base.startsWith(prefix) ? base.slice(prefix.length) : '');
        if (candidateStem === '')
            continue;
        if (composeCommandFilename(namespacedByDir, prefix, candidateStem) !== filename)
            continue;
        if (!SAFE_STEM.test(candidateStem))
            continue; // security: reject anything but a kebab-case token
        stems.add(candidateStem);
    }
    return [...stems];
}
/** D — full stem set for one scope: every `commands`/`skills` layout kind
 *  entry, unioned. Empty `files` (C13) short-circuits to `[]` without
 *  resolving a layout at all. */
function deriveStemsFromManifest(runtime, scopeId, configHome, files, opts) {
    const fileKeys = Object.keys(files);
    if (fileKeys.length === 0)
        return [];
    const layout = opts.registry !== undefined
        ? resolveRuntimeArtifactLayoutFromRegistry(opts.registry, runtime, configHome, scopeId)
        : resolveRuntimeArtifactLayout(runtime, configHome, scopeId);
    const stems = new Set();
    for (const kindEntry of layout.kinds) {
        if (kindEntry.kind !== 'commands' && kindEntry.kind !== 'skills')
            continue; // excludes agents/kimi-agents (D4)
        for (const stem of deriveStemsForKindEntry(kindEntry.kind, kindEntry.destSubpath, kindEntry.prefix, fileKeys)) {
            stems.add(stem);
        }
    }
    return [...stems].sort();
}
/**
 * True when `p` is a symlink. An `lstatSync` throw (ENOENT — nothing at this
 * path) is NOT evidence of a symlink; it is treated as "not a symlink" here
 * and left for `readManifest` to classify (it already owns the absent-file
 * case, per C14 above).
 */
function isSymlinkPath(p, lstatSync) {
    try {
        return lstatSync(p).isSymbolicLink();
    }
    catch {
        return false;
    }
}
/**
 * The shared "not installed" degraded shape (C14's EACCES path, and this
 * phase's new symlink-guard path). A FACTORY, not a module-level constant
 * object: a `const` object spread at each return site would still share the
 * same `stems` ARRAY reference across every call (`...` shallow-copies the
 * object but not the array a property points at), which would violate this
 * module's own "builds fresh arrays/objects on every call" contract (C15) —
 * a caller mutating one degraded record's `stems` must never be visible on
 * another's.
 */
function notInstalledScopeRecordFields() {
    return {
        installed: false,
        manifestVersion: null,
        declaredRuntime: null,
        declaredScope: null,
        declaredScopeMatchesProbe: null,
        declaredRuntimeMatchesProbe: null,
        stems: [],
    };
}
/**
 * Build one scope's record. `resolvedConfigHome` has already been probed
 * successfully by the time this is called (a `resolveScope` `TypeError` is
 * handled by the caller, per C8 — it is never this function's concern).
 *
 * Two distinct failure modes are handled with two distinct, narrowly-scoped
 * try/catches — NOT one catch-all around the whole function:
 *
 *  - The manifest READ (`readManifest`) is the only thing that can justify
 *    `installed: false` (C14, e.g. EACCES). A failure here means "we could
 *    not even tell whether this scope is installed".
 *  - The stem DERIVATION (`deriveStemsFromManifest`, which resolves a
 *    runtime artifact layout) is a separate concern. A `TypeError` thrown
 *    while deriving stems is a layout-lookup failure, not evidence the
 *    manifest is absent — the manifest was already read successfully, so
 *    `installed` and every declared/*MatchesProbe field stay exactly as the
 *    manifest reported. Conflating the two would report a genuinely
 *    installed runtime as `installed: false`, hiding a real install from
 *    #2218 shadow detection precisely when this module exists to surface it.
 */
function buildScopeRecord(runtime, scopeId, resolvedConfigHome, opts) {
    // Hardening requirement 2 (#2873 design doc, "Hardening requirements
    // claimed from #2873's comment"): `readInstallManifest` -> `readJsonIfPresent`
    // uses `existsSync` + `readFileSync` and therefore FOLLOWS symlinks, and
    // this module resolves `local` against `process.cwd()` — a directory that,
    // as of this phase, becomes reachable from an arbitrary cloned repository
    // (this is the same phase that makes the local scope's manifest a first
    // read target, not merely a write target). The in-tree precedent is
    // `getAgentsDir` (`agent-install-check.cts`), which probes with
    // `fs.lstatSync(...).isDirectory()`/`.isFile()` and deliberately does not
    // follow. #2872 left this resolver's read un-guarded only because the path
    // had zero callers at the time; refusing to follow a symlinked config dir
    // or manifest here closes that asymmetry rather than carrying it forward.
    // Degrading to `installed: false` reuses the SAME shape the EACCES catch
    // below already returns — no new failure shape is introduced.
    const lstatSync = opts.lstatSync ?? node_fs_1.default.lstatSync;
    const manifestPath = node_path_1.default.join(resolvedConfigHome, MANIFEST_NAME);
    if (isSymlinkPath(resolvedConfigHome, lstatSync) || isSymlinkPath(manifestPath, lstatSync)) {
        return { scope: scopeId, configHome: resolvedConfigHome, ...notInstalledScopeRecordFields() };
    }
    let manifest;
    try {
        const readManifest = opts.readManifest ?? readInstallManifest;
        manifest = readManifest(resolvedConfigHome);
    }
    catch {
        // C14: manifest read/probe failure degrades to not-installed, never throws.
        // Deliberately a BARE catch, unlike the stem-derivation catch below: any
        // read failure at all (EACCES, ENOENT-after-race, a corrupt filesystem)
        // legitimately means "cannot tell whether installed" (design row C14), so
        // there is no error TYPE here that should instead propagate.
        return { scope: scopeId, configHome: resolvedConfigHome, ...notInstalledScopeRecordFields() };
    }
    const installed = manifest.manifestVersion !== null; // C9: presence, never the new fields
    const declaredRuntime = manifest.runtime;
    const declaredScope = manifest.scope;
    const declaredRuntimeMatchesProbe = declaredRuntime === null ? null : declaredRuntime === runtime;
    const declaredScopeMatchesProbe = declaredScope === null ? null : declaredScope === scopeId;
    let stems = [];
    if (installed) {
        try {
            stems = deriveStemsFromManifest(runtime, scopeId, resolvedConfigHome, manifest.files, opts);
        }
        catch (error) {
            if (!(error instanceof TypeError))
                throw error;
            // A layout-lookup failure means "we could not enumerate this scope's
            // triggers", NOT "this scope is not installed" — the manifest read
            // already succeeded above, so `installed` and the declared fields
            // stay as reported. Conflating the two would hide a real install.
            // Anything that is not the expected `TypeError` (a genuine bug in
            // `deriveStemsFromManifest`/`resolveRuntimeArtifactLayout`) is
            // rethrown rather than silently degrading to `stems: []` — this
            // matches `resolveInstalledSurfaces`'s own `TypeError` narrowing
            // below, so the two catches cannot drift apart.
            stems = [];
        }
    }
    return {
        scope: scopeId,
        configHome: resolvedConfigHome,
        installed,
        manifestVersion: manifest.manifestVersion,
        declaredRuntime,
        declaredScope,
        declaredScopeMatchesProbe,
        declaredRuntimeMatchesProbe,
        stems,
    };
}
/**
 * Resolve one runtime's full installed surface. A `resolveScope` `TypeError`
 * (unknown runtime, or `configHome.kind === 'none'`, e.g. vscode) propagates
 * from here uncaught — `resolveInstalledSurfaces` decides whether that
 * means "skip" (C7 sweep) or "propagate" (explicit single-runtime ask, C8).
 */
function resolveOneRuntime(runtime, opts) {
    const scopes = install_scope_cjs_1.SCOPE_ORDER.map((scopeId) => {
        const resolved = (0, install_scope_cjs_1.resolveScope)({
            id: scopeId,
            runtime,
            env: opts.env,
            home: opts.home,
            existsSync: opts.existsSync,
            cwd: opts.cwd,
        });
        return buildScopeRecord(runtime, scopeId, resolved.configHome, opts);
    });
    // C12: dedupe by resolved configHome BEFORE the trigger call, keeping the
    // higher-ranked (global, first in SCOPE_ORDER) scope. Both scope RECORDS
    // above are unaffected — only the scope list handed to resolveTriggerSurface
    // is deduped.
    const seenConfigHomes = new Set();
    const triggerScopeIds = [];
    for (const record of scopes) {
        if (!record.installed)
            continue;
        if (seenConfigHomes.has(record.configHome))
            continue;
        seenConfigHomes.add(record.configHome);
        triggerScopeIds.push(record.scope);
    }
    const stemUnion = new Set();
    for (const scopeId of triggerScopeIds) {
        const record = scopes.find((s) => s.scope === scopeId);
        for (const stem of record?.stems ?? [])
            stemUnion.add(stem);
    }
    const triggers = triggerScopeIds.length > 0
        ? resolveTriggerSurface(runtime, triggerScopeIds, {
            stems: [...stemUnion].sort(),
            registry: opts.registry,
        })
        : [];
    return { runtime, scopes, triggers };
}
/**
 * Read-only. Probes both install scopes for a runtime (or every registered
 * runtime, sorted by id, when `runtime` is omitted), reads each scope's
 * manifest, and resolves the trigger surface across the scopes that are
 * actually installed on this machine. See the module-level comment for the
 * non-obvious choices (probe-not-declared keying, report-don't-correct, one
 * trigger call over installed scopes only).
 *
 * Pure with respect to caller-visible state: builds fresh arrays/objects on
 * every call (C15) and performs no writes. Filesystem reads happen only via
 * `resolveScope`'s injected `existsSync`/`env`/`home`/`cwd` and via
 * `readManifest` (default: `readInstallManifest`).
 *
 * @throws {TypeError} when `runtime` is given explicitly and it is unknown,
 *   or has no installable config directory (`configHome.kind === 'none'`,
 *   e.g. vscode) — same contract `resolveScope` throws. In the all-runtimes
 *   sweep (`runtime` omitted), a runtime that would throw this same
 *   `TypeError` is skipped instead, so one non-installable runtime cannot
 *   kill the sweep (C7/C8). Any other error type is never swallowed here.
 */
function resolveInstalledSurfaces(runtime, opts = {}) {
    if (typeof runtime === 'string') {
        return [resolveOneRuntime(runtime, opts)];
    }
    const results = [];
    for (const runtimeId of listRegisteredRuntimeIds(opts)) {
        try {
            results.push(resolveOneRuntime(runtimeId, opts));
        }
        catch (error) {
            if (error instanceof TypeError)
                continue; // C8: sweep skips, never dies
            throw error;
        }
    }
    return results;
}
