'use strict';
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
/**
 * Runtime artifact layout module — resolves the artifact directory shapes
 * (commands, agents, skills) for each supported runtime.
 *
 * grok is intentionally absent: it is in runtime-homes.cjs but has no runtime
 * capability descriptor. The TypeError on unknown runtime is the loud-fail
 * signal that a runtime was added without an artifact layout descriptor.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/runtime-artifact-layout.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */
const node_path_1 = __importDefault(require("node:path"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
// #2874 (ADR-58 cleanup phase): route this module's fs calls through the
// installRuntimeArtifacts call tree's injectable seam — see
// install-fs-adapter.cts's module doc. Resolves to real `node:fs` (the
// `fs` import above stays for type-only references, e.g. `fs.Dirent`)
// unless the top-level installRuntimeArtifacts call injected a `deps.fs`.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const installFsAdapter = require("./install-fs-adapter.cjs");
const security_cjs_1 = require("./security.cjs");
const { installFs, mkInstallTempDir } = installFsAdapter;
// Reuse the install manifest's existing parser and streamed SHA-256
// classification instead of deriving a second integrity implementation here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const installerMigrations = require("./installer-migrations.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const installProfiles = require("./install-profiles.cjs");
const { stageSkillsForProfile, stageAgentsForRuntimeWithConverter, stageSkillsForRuntimeAsSkills, stageCommandsForRuntimeFlat, } = installProfiles;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const runtimeArtifactConversion = require("./runtime-artifact-conversion.cjs");
const conversionExports = runtimeArtifactConversion;
// #2875 Part 2 (J8): shared model-override precedence resolver — see its
// module doc for why kilo/opencode MUST resolve through this ONE function
// rather than re-deriving the chain per runtime.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const installModelOverrideResolver = require("./install-model-override-resolver.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- export= CommonJS module, same as the sibling resolver import above
const installEffortResolver = require("./install-effort-resolver.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- export= CommonJS module, same as the sibling resolver import above
const modelCatalog = require("./model-catalog.cjs");
const shell_command_projection_cjs_1 = require("./shell-command-projection.cjs");
// #2870: `isGlobalScope` centralizes the `scope === 'global'` boolean
// projection both kind-builder closures below need at the converters'
// positional `isGlobal` boundary (see its doc comment in install-scope.cts
// for why the projection is centralized rather than eliminated).
const install_scope_cjs_1 = require("./install-scope.cjs");
// In .cts (CommonJS output) files, `require` is available as a global.
const _require = require;
function requiredRuntimeSurfaceSourceClasses(kinds) {
    const required = new Set();
    for (const kind of kinds) {
        if (kind.kind === 'commands' || kind.kind === 'skills')
            required.add('commands');
        if (kind.kind === 'agents' || kind.kind === 'kimi-agents')
            required.add('agents');
    }
    return required;
}
// ---------------------------------------------------------------------------
// Source root finders
// ---------------------------------------------------------------------------
function isReadableDirectory(candidate, routed) {
    try {
        const io = routed ? installFs() : node_fs_1.default;
        const stat = io.lstatSync(candidate);
        if (!stat.isDirectory() || stat.isSymbolicLink())
            return false;
        const entries = io.readdirSync(candidate);
        let readableFiles = 0;
        for (const name of entries) {
            const child = node_path_1.default.join(candidate, name);
            const childStat = io.lstatSync(child);
            if (childStat.isSymbolicLink())
                return false;
            if (childStat.isDirectory()) {
                if (!isReadableDirectory(child, routed))
                    return false;
                readableFiles += 1;
            }
            else if (childStat.isFile()) {
                if (routed)
                    io.readFileSync(child);
                else
                    node_fs_1.default.accessSync(child, node_fs_1.default.constants.R_OK);
                readableFiles += 1;
            }
            else {
                return false;
            }
        }
        return readableFiles > 0;
    }
    catch {
        return false;
    }
}
function isPhysicallyConfinedTo(root, candidate) {
    // ADR-4650 decision 6: lexical family on already-realpath'd operands — the
    // surrounding try/catch must survive verbatim, since a non-existent
    // candidate throwing out of realpathSync (not `tryWithinRootLexical`, which
    // would accept it) is exactly the "incomplete manifest" signal this
    // function's callers depend on.
    try {
        const physicalRoot = installFs().realpathSync(root);
        const physicalCandidate = installFs().realpathSync(candidate);
        return (0, security_cjs_1.tryWithinRootLexical)(physicalCandidate, physicalRoot) !== null;
    }
    catch {
        return false;
    }
}
function installedManifestIsComplete(runtimeConfigDir, required) {
    // This synchronous admission check binds provider selection to the corpus
    // observed here. Same-user mutation after resolution is outside #4132's
    // threat model and would require a broader snapshot/transaction design.
    const io = installFs();
    const manifestPath = node_path_1.default.join(runtimeConfigDir, 'gsd-file-manifest.json');
    if (!io.existsSync(manifestPath))
        return false;
    if (!isPhysicallyConfinedTo(runtimeConfigDir, manifestPath))
        return false;
    try {
        const manifest = installerMigrations.readInstallManifest(runtimeConfigDir);
        if (manifest.manifestVersion === null)
            return false;
        const keys = Object.keys(manifest.files);
        const prefixes = [];
        if (required.has('commands'))
            prefixes.push('gsd-core/commands/gsd/');
        if (required.has('agents'))
            prefixes.push('gsd-core/agents/');
        for (const prefix of prefixes) {
            const expected = keys.filter((key) => key.startsWith(prefix));
            if (expected.length === 0)
                return false;
            const expectedSet = new Set(expected);
            const corpusRoot = node_path_1.default.resolve(runtimeConfigDir, ...prefix.slice(0, -1).split('/'));
            if (!isPhysicallyConfinedTo(runtimeConfigDir, corpusRoot))
                return false;
            let actualFiles = 0;
            const visit = (dir) => {
                for (const name of io.readdirSync(dir)) {
                    const candidate = node_path_1.default.join(dir, name);
                    const stat = io.lstatSync(candidate);
                    if (stat.isSymbolicLink())
                        return false;
                    if (stat.isDirectory()) {
                        if (!visit(candidate))
                            return false;
                    }
                    else if (stat.isFile()) {
                        const relative = node_path_1.default.relative(corpusRoot, candidate).split(node_path_1.default.sep).join('/');
                        if (!expectedSet.has(prefix + relative))
                            return false;
                        actualFiles += 1;
                    }
                    else {
                        return false;
                    }
                }
                return true;
            };
            if (!visit(corpusRoot) || actualFiles !== expected.length)
                return false;
            for (const key of expected) {
                const parts = key.split('/');
                if (parts.some((part) => part === '' || part === '.' || part === '..'))
                    return false;
                // ADR-4650 decision 6: lexical family — the object is lstat'd (never
                // stat'd) and refused if it is a symlink just below, so this gate must
                // refuse rather than resolve.
                const candidate = (0, security_cjs_1.tryWithinRootLexical)(parts.join('/'), runtimeConfigDir);
                if (candidate === null || candidate === node_path_1.default.resolve(runtimeConfigDir))
                    return false;
                const stat = io.lstatSync(candidate);
                if (!stat.isFile() || stat.isSymbolicLink())
                    return false;
                if (installerMigrations.classifyArtifact(runtimeConfigDir, key, manifest).classification !== 'managed-pristine') {
                    return false;
                }
            }
        }
        return true;
    }
    catch {
        return false;
    }
}
function providerHasRequiredClasses(provider, required, routed, runtimeConfigDir) {
    if (provider.kind === 'installed' && runtimeConfigDir) {
        return installedManifestIsComplete(runtimeConfigDir, required);
    }
    return (!required.has('commands') || isReadableDirectory(provider.commandsRoot, routed)) &&
        (!required.has('agents') || isReadableDirectory(provider.agentsRoot, routed));
}
function providersShareRequiredRoots(left, right, required) {
    const leftFs = left.kind === 'package' ? node_fs_1.default : installFs();
    const rightFs = right.kind === 'package' ? node_fs_1.default : installFs();
    const physicalRootsOverlap = (leftRoot, rightRoot) => {
        const canonicalize = (io, root) => {
            let existing = node_path_1.default.resolve(root);
            const missingSegments = [];
            while (true) {
                try {
                    return node_path_1.default.resolve(io.realpathSync(existing), ...missingSegments);
                }
                catch (error) {
                    if (error.code !== 'ENOENT')
                        return null;
                    const parent = node_path_1.default.dirname(existing);
                    if (parent === existing)
                        return null;
                    missingSegments.unshift(node_path_1.default.basename(existing));
                    existing = parent;
                }
            }
        };
        const overlap = (leftPath, rightPath) => {
            const relative = node_path_1.default.relative(leftPath, rightPath);
            return relative === '' ||
                (relative !== '..' && !relative.startsWith(`..${node_path_1.default.sep}`) && !node_path_1.default.isAbsolute(relative)); // allow-handrolled-containment: bidirectional physical-root overlap/identity check between two providers for dedup detection — not a security confinement gate on untrusted input
        };
        const physicalLeft = canonicalize(leftFs, leftRoot);
        const physicalRight = canonicalize(rightFs, rightRoot);
        if (!physicalLeft || !physicalRight)
            return true;
        return overlap(physicalLeft, physicalRight) || overlap(physicalRight, physicalLeft);
    };
    return (required.has('commands') && physicalRootsOverlap(left.commandsRoot, right.commandsRoot)) ||
        (required.has('agents') && physicalRootsOverlap(left.agentsRoot, right.agentsRoot));
}
function markerProvider(runtimeConfigDir) {
    const markerPath = node_path_1.default.join(runtimeConfigDir, '.gsd-source');
    try {
        if (!installFs().existsSync(markerPath))
            return null;
        const markerStat = installFs().lstatSync(markerPath);
        if (!markerStat.isFile() || markerStat.isSymbolicLink())
            return null;
        const commandsRoot = installFs().readFileSync(markerPath, 'utf8').trim();
        if (!commandsRoot)
            return null;
        // A marker written by the installer may point at this process's executing
        // package. Preserve package-source IO on real fs so the existing injected
        // destination adapter remains destination-only (#2874).
        const packaged = packageProvider(new Set(['commands']));
        if (packaged && node_path_1.default.resolve(commandsRoot) === node_path_1.default.resolve(packaged.commandsRoot)) {
            return packaged;
        }
        return {
            kind: 'marker',
            commandsRoot,
            agentsRoot: node_path_1.default.resolve(node_path_1.default.dirname(commandsRoot), '..', 'agents'),
        };
    }
    catch {
        return null;
    }
}
function packageProvider(required) {
    // Package-source IO deliberately stays on real fs; injected install adapters
    // model destinations, not the executing package tree (#2874).
    let dir = __dirname;
    for (let i = 0; i < 6; i++) {
        const candidate = {
            kind: 'package',
            commandsRoot: node_path_1.default.join(dir, 'commands', 'gsd'),
            agentsRoot: node_path_1.default.join(dir, 'agents'),
        };
        if (providerHasRequiredClasses(candidate, required, false))
            return candidate;
        const parent = node_path_1.default.dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return null;
}
/**
 * Select one complete source provider for an entire resolved layout.
 * Provider mixing is forbidden: a skills+agents layout cannot take commands
 * from one package version and agents from another.
 */
function resolveSourceProvider(runtimeConfigDir, requiredClasses, scope = 'global', authority = 'compatible') {
    const required = new Set(requiredClasses);
    let rejectedInstalled = null;
    if (required.size === 0) {
        return { kind: 'package', commandsRoot: '', agentsRoot: '' };
    }
    if (runtimeConfigDir && scope === 'global') {
        const installed = {
            kind: 'installed',
            commandsRoot: node_path_1.default.join(runtimeConfigDir, 'gsd-core', 'commands', 'gsd'),
            agentsRoot: node_path_1.default.join(runtimeConfigDir, 'gsd-core', 'agents'),
        };
        if (providerHasRequiredClasses(installed, required, true, runtimeConfigDir))
            return installed;
        rejectedInstalled = installed;
        const marker = markerProvider(runtimeConfigDir);
        if (marker && !providersShareRequiredRoots(marker, installed, required) && providerHasRequiredClasses(marker, required, marker.kind !== 'package')) {
            return marker;
        }
    }
    else if (runtimeConfigDir) {
        const marker = markerProvider(runtimeConfigDir);
        if (marker && providerHasRequiredClasses(marker, required, marker.kind !== 'package'))
            return marker;
    }
    if (authority === 'compatible') {
        const packaged = packageProvider(required);
        if (packaged &&
            (!rejectedInstalled || !providersShareRequiredRoots(packaged, rejectedInstalled, required))) {
            return packaged;
        }
    }
    throw new Error(`Runtime Surface source is unavailable or incomplete for ${[...required].sort().join('+')}; ` +
        'install or upgrade gsd-core before materializing this surface.');
}
function sourceRootFor(context, sourceClass) {
    context.provider ??= resolveSourceProvider(context.runtimeConfigDir, context.required, context.scope, context.authority);
    return sourceClass === 'commands' ? context.provider.commandsRoot : context.provider.agentsRoot;
}
function findInstallSourceRoot(runtimeConfigDir) {
    return resolveSourceProvider(runtimeConfigDir, ['commands']).commandsRoot;
}
// ---------------------------------------------------------------------------
// Layout table builders
// ---------------------------------------------------------------------------
function commandsKind(destSubpath, prefix, sourceContext) {
    return {
        kind: 'commands',
        destSubpath,
        prefix,
        stage: (resolved) => stageSkillsForProfile(sourceRootFor(sourceContext, 'commands'), resolved),
    };
}
function agentsKind(destSubpath, prefix, configDir, sourceContext) {
    return {
        kind: 'agents',
        destSubpath,
        prefix,
        // #2995: a `converter: null` agents entry (claude local, zcode) previously
        // staged via stageAgentsForProfile — a RAW byte copy that never reads content
        // into JS, so gsd:section markers shipped verbatim. Route through the
        // composing stager with an identity converter instead: same output as the raw
        // copy for an unmarked agent, markers stripped for a marked one. Routing both
        // agent kinds through the stager collapses what were five independent agent
        // read points down to three compose call sites: this stager, bin/install.js's
        // inline agent loop, and installCodexConfig's per-agent .toml writer. The
        // exhaustive per-runtime sweep in tests/agent-fragments-emission.install.test.cjs
        // is what keeps a fourth from appearing uncomposed.
        // #2875 Part 2 (row I2): agentCtx threaded through so a runtime using this
        // converter:null builder (claude, plus any future identity-copy runtime)
        // ALSO gets path-rewrites/attribution/frontmatter-extensions/normalize
        // when a caller supplies agentCtx (createRuntimeArtifactInstallPlan /
        // applySurface's agentCtx build). Previously this closure's `(resolved) =>`
        // signature silently dropped the second arg every caller already passed —
        // a caller with NO agentCtx in scope is unaffected (row I2: converter-only,
        // as today), matching stageAgentsForRuntimeWithConverter's own contract.
        stage: (resolved, agentCtx) => stageAgentsForRuntimeWithConverter(sourceRootFor(sourceContext, 'agents'), resolved, (content) => content, false, agentCtx?.runtime ? agentCtx : undefined),
    };
}
/**
 * Runtime allowlist check for a descriptor-declared `converter` name, applied
 * at DISPATCH time (security fix). `VALID_CONVERTER_NAMES` (capability-
 * validator.cjs) is otherwise enforced ONLY at lint/build time
 * (`check:contract-drift`) — every `conversionExports[converterName]`
 * dynamic-property read below trusted that a `capability.json` reaching this
 * far had already passed that check. It had not, in general: a hand-edited
 * or malformed descriptor naming an Object-prototype member (`"constructor"`,
 * `"toString"`, `"hasOwnProperty"`, ...) resolves to that member instead of
 * throwing, producing garbage staged content rather than a loud failure —
 * pre-existing, but promoted from the `/gsd-surface`-only path to the real
 * install path for seven runtimes by #2875 Part 2's agents-bypass closure.
 * Required lazily (call-time, not module-top) to avoid a load-time circular
 * require, the same pattern install-engine.cts's `_hostBehaviors` already
 * uses for `capability-registry.cjs`. Fails CLOSED: any error loading the
 * allowlist itself (missing module, exotic bundling) is treated as "nothing
 * is allowed", never as "skip the check".
 */
function _resolveNamedConverter(converterName, kindLabel) {
    let validNames;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        validNames = require('./capability-validator.cjs').VALID_CONVERTER_NAMES;
    }
    catch {
        validNames = undefined;
    }
    if (!validNames || !validNames.has(converterName)) {
        throw new Error(`Unknown converter "${converterName}" declared for a ${kindLabel} kind — refusing to dispatch (not in capability-validator.cjs's VALID_CONVERTER_NAMES allowlist).`);
    }
    const fn = conversionExports[converterName];
    if (typeof fn !== 'function') {
        throw new Error(`Converter "${converterName}" is allowlisted but is not an exported function of runtime-artifact-conversion.cjs.`);
    }
    return fn;
}
/**
 * Build a converted-agents kind descriptor for runtimes whose agent `.md` files
 * need runtime-specific frontmatter/body conversion (e.g. Copilot, Cursor, Codex).
 *
 * Unlike `agentsKind` (which raw-copies source files), this kind applies
 * `converterName` from Runtime Artifact Conversion exports to each agent file
 * during staging, writing flat `${name}.md` files to the staged directory.
 *
 * Agent filenames are preserved verbatim (the prefix is already embedded in the
 * agent stem — e.g. `gsd-planner.md`).
 *
 * #1173 SCOPE, updated by #2875 Part 2 (the agents-bypass closure) — measured
 * against the tree, not the ADR-3574 framing that preceded it:
 *
 * Of the four blockers this comment used to name for wiring `bin/install.js`'s
 * inline agent loop against this resolver, THREE were already stale by the
 * time #2875 measured them and are not re-litigated here: Copilot's
 * `.agent.md` rename (the loop's own `destName = entry.name` comment records
 * the ternary dropped in #2099; the descriptor fold applies it via
 * `hostBehaviors.agentFileExtension`), the cross-cutting path-prefix rewrite +
 * attribution (`stageAgentsForRuntimeWithConverter` already applies
 * `applyAgentPathRewrites` -> `processAttribution` when `agentCtx` is
 * present), and stale-file cleanup (`_removeGsdEntries` prunes every
 * `gsd-`-prefixed entry in a kind's destSubpath, broader than the loop's own
 * extension-gated check).
 *
 * The fourth — config-reading steps — was the real gap, and #2875 Part 2
 * closed it: `stageAgentsForRuntimeWithConverter` now takes a per-file
 * `agentName` (`agentCtx.agentName`, ADR-1235 §1) and a `targetDir`
 * (`agentCtx.targetDir`), which together let it (a) run a post-converter
 * frontmatter-extensions step (`applyAgentFrontmatterExtensions`, driven by
 * `hostBehaviors.agentFrontmatterExtensions` — Claude's `effort` +
 * `disallowedTools` injection) and (b) let THIS function resolve a per-agent
 * model override (`installModelOverrideResolver.resolveAgentModelOverride`,
 * `model_overrides[agent]` > `model_profile_overrides.<rt>.<tier>` > omit)
 * before invoking a converter that needs it (kilo/opencode). Both pieces —
 * plus a data-driven Hermes branding converter
 * (`convertClaudeAgentToHermesAgent`, reading `hostBehaviors.brandingRewrites`
 * rather than a hardcoded string table) — are single-sourced: `bin/install.js`
 * requires the SAME functions this module does, so its inline loop and the
 * descriptor path can no longer independently drift (the CLAUDE.md
 * "Generative Fix Divergence" class the prior duplication risked).
 *
 * `tests/agent-descriptor-parity.test.cjs` proves byte-identical output
 * between the inline loop and a SYNTHETIC descriptor registry (the same
 * override seam `resolveRuntimeArtifactLayoutFromRegistry` exposes) for all
 * six runtimes the inline loop still served: claude, cline, codex, hermes,
 * kilo, opencode.
 *
 * Both findings the prior revision of this comment named as STILL deferred
 * are now CLOSED (#2875 Part 2 Task A/B/C), measured against the real
 * `capability.json` entries and the real production entry points, not
 * argued from this module alone:
 *
 * 1. **kilo/opencode reaching `layout.kinds`.** `installEngine.
 *    installAgentsKindStandalone` (install-engine.cts) is called from inside
 *    `installOpencodeFamilyArtifacts` and resolves the agents kind through
 *    THIS SAME `resolveRuntimeArtifactLayout`/`convertedAgentsKind` path —
 *    `installOpencodeFamilyArtifacts` no longer stages only `commands` +
 *    `skills`. `bin/install.js`'s legacy-flat local path (claude-local,
 *    `hostBehaviors.localInstallStyle === 'legacy-flat'`) reaches the SAME
 *    generic loop only via `installRuntimeArtifacts`'s conditional
 *    `_isSkillsRuntime` branch; a call to `installAgentsKindStandalone` was
 *    added at claude-local's own call site to cover that scope too — the
 *    install-tree golden fixture (`tests/fixtures/install-tree/claude-local.json`)
 *    is what caught the gap when it was first missed.
 * 2. **`/gsd:surface` / `applySurface` activation.** Confirmed convergent,
 *    not merely non-broken: for all six runtimes (claude, cline, codex,
 *    hermes, kilo, opencode), staging via `applySurface` into a freshly
 *    wiped `agents/` directory produces byte-identical output (including
 *    filenames) to `installRuntimeArtifacts`'s own write — verified directly
 *    against the built registry, not inferred.
 *
 * The inline loop (`_DESCRIPTOR_AGENTS_RUNTIMES` and the `bin/install.js`
 * agent-staging block it gated) is DELETED — every runtime the registry
 * declares an `agents` kind for is descriptor-driven now, including a
 * seventh runtime (`kimi-code`) this comment's own prior measurement missed
 * (it fell through the inline loop's generic `else if` branch, same as
 * claude, with no dedicated dialect arm — caught by the same golden fixture).
 *
 * Codex's `config.toml [agents.gsd-*]` strip (`bin/install.js`, under
 * `isMinimalMode` + `hostBehaviors.tomlConfigInstall`) remains the one
 * genuinely out-of-scope constraint: it mutates a host config file, not the
 * agents directory, and no descriptor kind models host-config mutation. It
 * stays exactly where it is.
 *
 * Mirrors the `convertedCommandsKind` pattern (#785).
 *
 * @param destSubpath   destination subpath within configDir (e.g. 'agents')
 * @param prefix        filename prefix (informational; not applied here)
 * @param converterName name of converter function in Runtime Artifact Conversion exports
 * @param configDir     runtime config dir (for .gsd-source marker resolution)
 */
function convertedAgentsKind(destSubpath, prefix, converterName, configDir, sourceContext, scope, excludeSuffixes) {
    return {
        kind: 'agents',
        destSubpath,
        prefix,
        stage: (resolved, agentCtx) => {
            // #2870: `scope` is this function's own parameter (default `'global'`,
            // so it is never undefined here), sourced upstream from the Install
            // Scope Module's resolved id. `isGlobalScope` projects it to the
            // boolean `stageAgentsForRuntimeWithConverter`'s positional API
            // requires — see its doc comment in install-scope.cts.
            const rawConverter = _resolveNamedConverter(converterName, 'agents');
            // #2875 Part 2 (J5-J8): kilo/opencode agent converters take an options
            // bag (`{isAgent, modelOverride}`), not the `isGlobal` boolean every
            // other agent converter's 2nd positional arg means — mirrors the
            // inline loop's per-runtime `frontmatterDialect === 'opencode' | 'kilo'`
            // branches (bin/install.js), which resolve model_overrides[agent] >
            // model_profile_overrides.<runtime>.<tier> > omit BEFORE calling the
            // converter. Resolved ONCE per stage() call (not per file — a pure
            // function of configDir/targetDir) via the single shared precedence
            // resolver so kilo and opencode can never diverge (J8).
            const needsModelOverride = converterName === 'convertClaudeToOpencodeFrontmatter' || converterName === 'convertClaudeToKiloFrontmatter';
            let converter;
            if (needsModelOverride) {
                const overrideTargetDir = agentCtx?.targetDir ?? configDir;
                const modelOverrides = installModelOverrideResolver.readGsdEffectiveModelOverrides(overrideTargetDir);
                const runtimeResolver = installModelOverrideResolver.readGsdRuntimeProfileResolver(overrideTargetDir);
                // #3706: the resolved reasoning effort, threaded exactly as the model is —
                // config read ONCE per stage(), per-agent value resolved per file.
                //
                // Gated on the effort config being PRESENT, not on a value coming back.
                // `resolveInstallTimeEffort` always returns something (measured: 'high'
                // even with no project config and no effort block), so "skip when
                // resolution yields no value" has no trigger and would stamp `variant:`
                // into every generated agent file for every existing install. OpenCode's
                // built-in variant sets are provider-specific upstream (Anthropic ships
                // only `high`/`max`), so a level GSD resolved is not guaranteed to name a
                // variant the user's provider actually has — emitting one unasked-for is
                // the risk this gate avoids. #1156's rule for `model: inherit` is the
                // precedent: do not emit a key the runtime may not understand.
                //
                // OpenCode only; the kilo converter ignores the field (no EFFORT_ARGV.kilo).
                const effortConfig = converterName === 'convertClaudeToOpencodeFrontmatter'
                    ? installEffortResolver.readGsdEffectiveEffortConfig(overrideTargetDir)
                    : null;
                converter = (content, _isGlobal, meta) => {
                    const modelOverride = meta
                        ? installModelOverrideResolver.resolveAgentModelOverride(meta.agentName, modelOverrides, runtimeResolver)
                        : null;
                    // The universal level is NOT emitted raw. `clampEffortForHost` is the
                    // declared OpenCode effort capability (EFFORT_ARGV.opencode: its own
                    // `supported` set + `clamp`), and it is what rejects a level that is
                    // not a wire value — most importantly `inherit`, which per #3533 (10d)
                    // means "omit the key and follow the host default" and must never be
                    // written literally. Anything unsupported clamps to null, which omits
                    // the key rather than inventing one.
                    const universal = effortConfig && meta
                        ? installEffortResolver.resolveInstallTimeEffort(effortConfig, meta.agentName)
                        : null;
                    const variant = universal ? modelCatalog.clampEffortForHost('opencode', universal) : null;
                    return rawConverter(content, { isAgent: true, modelOverride, variant });
                };
            }
            else {
                // isGlobal is threaded so scope-aware agent converters (copilot, antigravity)
                // choose global-home vs workspace-relative paths; converters that only take
                // (content) ignore the extra positional arg. Mirrors skillsKind's scope
                // threading (#1173).
                converter = (content) => rawConverter(content, (0, install_scope_cjs_1.isGlobalScope)(scope));
                if (converterName === 'convertClaudeAgentToTraeAgent') {
                    // #5715: the Trae agent converter needs the prefix the path-rewrite step
                    // already emitted, so it can leave it alone.
                    const traeConverter = rawConverter;
                    converter = (content, _isGlobal, meta) => traeConverter(content, (0, install_scope_cjs_1.isGlobalScope)(scope), meta);
                }
            }
            // ADR-1235 §1: when agentCtx is provided (by createRuntimeArtifactInstallPlan
            // for descriptor-driven runtimes), thread it through so stageAgentsForRuntimeWithConverter
            // can apply the full pre-converter + post-converter sequence in the correct order.
            return stageAgentsForRuntimeWithConverter(sourceRootFor(sourceContext, 'agents'), resolved, converter, (0, install_scope_cjs_1.isGlobalScope)(scope), agentCtx?.runtime ? agentCtx : undefined, excludeSuffixes);
        },
    };
}
function kimiAgentsKind(destSubpath, prefix, configDir, sourceContext) {
    return {
        kind: 'kimi-agents',
        destSubpath,
        prefix,
        stage: (resolved, agentCtx) => {
            const buildKimiAgentArtifacts = conversionExports['buildKimiAgentArtifacts'];
            // #2995: compose at staging (identity converter) so the readFileSync below
            // sees marker-free content — same single composing stager as agentsKind.
            const stagedAgents = stageAgentsForRuntimeWithConverter(sourceRootFor(sourceContext, 'agents'), resolved, (content) => content, false, agentCtx);
            const subagents = [];
            if (installFs().existsSync(stagedAgents)) {
                for (const entry of installFs().readdirSync(stagedAgents, { withFileTypes: true })) {
                    if (!entry.isFile() || !entry.name.endsWith('.md'))
                        continue;
                    const agentPath = node_path_1.default.join(stagedAgents, entry.name);
                    subagents.push({
                        path: (0, shell_command_projection_cjs_1.posixNormalize)(node_path_1.default.join('agents', entry.name)),
                        content: installFs().readFileSync(agentPath, 'utf8'),
                    });
                }
            }
            const rootAgent = `---\nname: gsd\ndescription: Run GSD workflows in Kimi CLI.\ntools: Agent\n---\n\n# GSD for Kimi CLI\n\nCoordinate installed /skill:gsd-* workflows and route work to generated GSD subagents when a workflow requires an agent handoff.\n`;
            const artifacts = buildKimiAgentArtifacts({ rootAgent, subagents });
            const stageDir = mkInstallTempDir('gsd-kimi-agents-');
            installProfiles.STAGED_DIRS.add(stageDir);
            installFs().writeFileSync(node_path_1.default.join(stageDir, 'gsd.yaml'), artifacts.root.yaml);
            installFs().writeFileSync(node_path_1.default.join(stageDir, 'gsd.md'), artifacts.root.prompt);
            const subagentsDir = node_path_1.default.join(stageDir, 'subagents');
            installFs().mkdirSync(subagentsDir, { recursive: true });
            for (const artifact of artifacts.subagents) {
                installFs().writeFileSync(node_path_1.default.join(subagentsDir, `${artifact.name}.yaml`), artifact.yaml);
                installFs().writeFileSync(node_path_1.default.join(subagentsDir, `${artifact.name}.md`), artifact.prompt);
            }
            return stageDir;
        },
    };
}
/**
 * Build a skills kind descriptor.
 *
 * @param destSubpath
 * @param prefix
 * @param converterName  name of converter function in Runtime Artifact Conversion exports
 * @param runtime        canonical runtime ID (gates Hermes/Qwen branding in converter)
 * @param configDir      runtime config dir (for .gsd-source marker resolution)
 * @param nested         if true, nest concrete skills under their ns-* routers (#69)
 * @param scope          install scope; converted to isGlobal and passed as 5th positional
 *                       arg so scope-aware converters (antigravity, copilot) can choose
 *                       between global home paths and workspace-relative paths without
 *                       colliding with the `runtime` string at position 3.
 * @param capabilityRegistry #2322: optional capability registry — captured in the
 *                       stage() closure so third-party capability skills are bound to
 *                       their declaring capId at staging time. Absent -> stage() stages
 *                       nothing third-party (fail closed).
 */
function skillsKind(destSubpath, prefix, converterName, runtime, configDir, nested, scope, sourceContext, capabilityRegistry) {
    return {
        kind: 'skills',
        destSubpath,
        prefix,
        converter: converterName,
        stage: (resolved) => {
            const realConverter = _resolveNamedConverter(converterName, 'skills');
            // Compute cmdNames once per stage call for performance (#3583).
            // Extra trailing args are ignored by converters that don't need them. The
            // isGlobal flag is the 5th positional (NOT the 3rd): the 3rd positional is
            // `runtime` for the claude/kimi/cline converters, so the scope-aware
            // converters (antigravity, copilot) read isGlobal from position 5 to avoid
            // colliding with `runtime` and always taking the global branch.
            const cmdNames = conversionExports.readGsdCommandNames
                ? conversionExports.readGsdCommandNames()
                : [];
            // #2870: same judgment as convertedAgentsKind above — `scope` is this
            // function's own parameter (default `'global'`, so it is never
            // undefined here); `isGlobalScope` projects it to the boolean
            // `realConverter`'s positional `isGlobal` arg requires.
            const isGlobal = (0, install_scope_cjs_1.isGlobalScope)(scope);
            // #2873 (4b): spec-root reachability is applied LATER in the pipeline —
            // see `rewriteStagedSkillBodies` in runtime-artifact-conversion.cts, not
            // here. This stage() closure runs BEFORE the staged directory's generic
            // path-prefix rewrite pass (`applyRuntimeContentRewritesInPlace`'s
            // `case 'claude'`), which unconditionally rewrites any bare (non-`@`)
            // `~/.claude/` substring to the undocumented `$HOME/.claude/` form and
            // only restores the `@`-prefixed form. Emitting the imperative
            // tilde-path prose here would get silently mangled by that later pass;
            // it must run AFTER it instead, once the `@`-include is in its final
            // rewritten shape.
            const wrappedConverter = (content, skillName) => realConverter(content, skillName, runtime, cmdNames, isGlobal);
            return stageSkillsForRuntimeAsSkills(sourceRootFor(sourceContext, 'commands'), resolved, wrappedConverter, prefix, nested, capabilityRegistry);
        },
    };
}
/**
 * Build a converted-commands kind descriptor for runtimes that use a flat
 * commands directory with per-file conversion (e.g. Cursor 1.6 slash commands).
 *
 * Unlike `commandsKind` (which passes raw source files through), this kind
 * applies `converterName` from Runtime Artifact Conversion exports to each file during
 * staging, writing flat `${prefix}${stem}.md` files to the staged directory.
 *
 * The staged files are then written by `_copyStaged` (commands branch) which
 * handles prefix logic via the existing layout machinery.
 *
 * @param destSubpath   destination subpath within configDir (e.g. 'commands')
 * @param prefix        filename prefix, e.g. 'gsd-'
 * @param converterName name of converter function in Runtime Artifact Conversion exports
 * @param configDir     runtime config dir (for .gsd-source marker resolution)
 */
function convertedCommandsKind(destSubpath, prefix, converterName, sourceContext) {
    return {
        kind: 'commands',
        destSubpath,
        prefix,
        stage: (resolved) => {
            const converter = _resolveNamedConverter(converterName, 'commands');
            return stageCommandsForRuntimeFlat(sourceRootFor(sourceContext, 'commands'), resolved, converter, prefix);
        },
    };
}
function getRegistry() {
    return _require('./capability-registry.cjs');
}
/**
 * Map a single ArtifactKindDescriptor entry to an ArtifactKind using the
 * matching builder function. Mirrors the hand-built calls in the old switch.
 */
function dispatchKindEntry(entry, runtime, configDir, scope, capabilityRegistry, sourceContext) {
    const { kind, destSubpath, prefix, nesting, converter } = entry;
    const nested = nesting === 'nested';
    let result;
    switch (kind) {
        case 'commands':
            result = converter == null
                ? commandsKind(destSubpath, prefix, sourceContext)
                : convertedCommandsKind(destSubpath, prefix, converter, sourceContext);
            break;
        case 'agents':
            result = converter == null
                ? agentsKind(destSubpath, prefix, configDir, sourceContext)
                : convertedAgentsKind(destSubpath, prefix, converter, configDir, sourceContext, scope, entry.excludeSuffixes);
            break;
        case 'skills':
            if (converter == null) {
                throw new TypeError(`resolveRuntimeArtifactLayout: skills entry for '${runtime}' has converter=null (converter is required for skills)`);
            }
            result = skillsKind(destSubpath, prefix, converter, runtime, configDir, nested, scope, sourceContext, capabilityRegistry);
            break;
        case 'kimi-agents':
            result = kimiAgentsKind(destSubpath, prefix, configDir, sourceContext);
            break;
        default:
            throw new TypeError(`resolveRuntimeArtifactLayout: unknown kind '${kind}' in descriptor for runtime '${runtime}'`);
    }
    // scope is guaranteed 'local' | 'global' here: resolveRuntimeArtifactLayoutFromRegistry
    // (the only caller of dispatchKindEntry) throws TypeError before this point if scope is
    // anything else (see the `scope !== 'local' && scope !== 'global'` guard above its
    // dispatchKindEntry call), so isGlobalScope's throw-on-invalid-input never fires here.
    if ((0, install_scope_cjs_1.isGlobalScope)(scope) && typeof entry.home === 'string' && entry.home !== '') {
        result.home = node_path_1.default.join(node_os_1.default.homedir(), entry.home);
    }
    return result;
}
/**
 * Resolve the artifact layout for a given runtime and config directory.
 *
 * ADR-857 phase 5d: driven by the capability-registry artifactLayout descriptor
 * instead of a hardcoded switch statement.
 *
 * @param capabilityRegistry #2322: optional — when the caller has a composed
 *   capability registry in scope (e.g. capability-writer.cts's `capability set`
 *   path, or a fresh install's registry-aware profile resolution), pass it here
 *   so the skills kind's stage() closure can materialize installed third-party
 *   capability skills bound to their declaring capId. Both call paths (surface
 *   apply AND the installer) must pass their registry here — resolveProfile's
 *   own `'*'` (full profile) short-circuit never carries a registry, so if it
 *   is not threaded in at layout-build time a `full`-profile install stages no
 *   third-party capability skills regardless of registration (#2322 blocker 2).
 */
function resolveRuntimeArtifactLayout(runtime, configDir, scope = 'global', capabilityRegistry) {
    return resolveRuntimeArtifactLayoutFromRegistry(getRegistry(), runtime, configDir, scope, capabilityRegistry);
}
function resolveRuntimeArtifactLayoutFromRegistry(registry, runtime, configDir, scope = 'global', capabilityRegistry) {
    if (typeof configDir !== 'string' || configDir === '') {
        throw new TypeError('configDir must be a non-empty string');
    }
    if (scope !== 'local' && scope !== 'global') {
        throw new TypeError('scope must be "local" or "global"');
    }
    const desc = registry.runtimes[runtime]?.runtime?.artifactLayout;
    if (!desc) {
        throw new TypeError(`Unknown runtime: '${runtime}' — add to runtime-artifact-layout.cjs table`);
    }
    const entries = desc[scope] ?? [];
    const required = requiredRuntimeSurfaceSourceClasses(entries);
    // Stage closures share one lazy source-resolution context, so the first kind
    // to stage selects and caches one complete provider for every required source
    // class. Global layouts accept only installed or marker providers; the
    // installer owns its private package fallback by retrying through a transient
    // compatibility marker after source resolution fails. Local layouts retain
    // compatible marker/package resolution and never provision the global corpus.
    const sourceContext = {
        runtimeConfigDir: configDir,
        scope,
        required,
        authority: scope === 'local' ? 'compatible' : 'runtime',
    };
    const kinds = entries.map((entry) => dispatchKindEntry(entry, runtime, configDir, scope, capabilityRegistry, sourceContext));
    return { runtime, configDir, scope, kinds };
}
function getTriggerRegistry() {
    return _require('./capability-registry.cjs');
}
/**
 * capability-validator.cjs is a COMMITTED plain .cjs (not built from a .cts
 * source — see its own header comment), so it is required the same way
 * capability-registry.cjs is above: a lazy `_require` rather than a static
 * ES import. DEFAULT_TRIGGER_PRECEDENCE is the single source of truth for
 * "what applies when a descriptor omits triggerPrecedence"; this module
 * reads it rather than re-declaring `['skills', 'commands']` as a second
 * literal that could silently drift from the validator's own default.
 */
function getDefaultTriggerPrecedence() {
    const capValidator = _require('./capability-validator.cjs');
    return capValidator.DEFAULT_TRIGGER_PRECEDENCE;
}
/**
 * True when a `commands` kind entry is namespaced by its destination
 * directory rather than by a filename prefix — i.e. `destSubpath`'s basename
 * equals `prefix` with its trailing hyphen stripped (e.g. `commands/gsd` +
 * `gsd-`). When true, `_copyStaged` (`install-engine.cts`) and `surface.cts`
 * both write the bare stem filename (no prefix) because the directory itself
 * already carries the namespace; `resolveTriggerSurface` mirrors that in its
 * own `destPath` computation. Single source of truth for the three sites
 * that used to compute this independently (#2871 Phase 2 review finding) —
 * a new caller MUST reuse this rather than re-deriving the rule.
 */
function isNamespacedByDir(kind, destSubpath, prefix) {
    const destLast = node_path_1.default.posix.basename((0, shell_command_projection_cjs_1.posixNormalize)(destSubpath));
    const prefixStem = prefix ? prefix.replace(/-$/, '') : '';
    return kind === 'commands' && destLast === prefixStem;
}
/**
 * Compose the destination filename `_copyStaged` (install-engine.cts) writes
 * for a `commands` kind entry, given `isNamespacedByDir`'s result, the
 * kind's prefix, and the file's `.md`-stripped stem. Single source of truth
 * alongside `isNamespacedByDir` for the FILENAME COMPOSITION itself (#2871
 * Phase 2 review finding — the boolean was single-sourced first, but the
 * `${stem}.md` / `${prefix}${stem}.md` string-building around it stayed
 * duplicated between `_copyStaged` and `resolveTriggerSurface`'s `destPath`
 * prediction below, so a divergence in the write convention would not have
 * failed anything).
 *
 * Byte-identical to `_copyStaged`'s prior separate branches: when
 * `namespacedByDir` is true this returns `${stem}.md`. `_copyStaged` always
 * derives `stem` as `entry.name.slice(0, -3)` for an `entry.name` that has
 * already been filtered to end in `.md`, so `${stem}.md` is always exactly
 * `entry.name` again — `_copyStaged` can pass this helper's result in place
 * of the `entry.name` it used to write directly, with no behavior change.
 */
function composeCommandFilename(namespacedByDir, prefix, stem) {
    return namespacedByDir ? `${stem}.md` : `${prefix}${stem}.md`;
}
/**
 * True when candidate `a` should win over the current best `b` for the same
 * trigger. Scope rank first (Phase 1's `install-scope.cts#scopeRank` —
 * global outranks local; NOT re-derived here), then the runtime's
 * `triggerPrecedence` kind ordering (lower index = higher priority). A kind
 * absent from `precedenceRank` (should not happen — every entry's kind is
 * validated against the same closed vocabulary the precedence list draws
 * from) sorts last rather than throwing, so a malformed precedence value
 * degrades to "leaves the incumbent standing" instead of corrupting the
 * whole resolution.
 */
function isHigherPriority(a, b, precedenceRank) {
    const rankA = (0, install_scope_cjs_1.scopeRank)(a.scope);
    const rankB = (0, install_scope_cjs_1.scopeRank)(b.scope);
    if (rankA !== rankB)
        return rankA > rankB;
    const pa = precedenceRank.get(a.kind) ?? Number.POSITIVE_INFINITY;
    const pb = precedenceRank.get(b.kind) ?? Number.POSITIVE_INFINITY;
    return pa < pb;
}
/**
 * Resolve the `/gsd-<name>`-style trigger surface for a runtime: what the
 * user types, at which scope, whether it wins or is shadowed, and (for
 * nested-router runtimes) whether the host registers it directly or only
 * reaches it through a router. Pure — no filesystem, no mutation of `scopes`
 * or `opts`, and safe against a caller mutating the returned array/objects
 * (a fresh array/objects are built on every call; nothing is cached or
 * shared across calls beyond the read-only registry module).
 *
 * Only `commands` and `skills` kind entries are considered — see the
 * module-level comment above. `resolveRuntimeArtifactLayout` is untouched by
 * this function; they are independent readers of the same descriptor.
 *
 * @throws {TypeError} for an unknown runtime — same contract (and message
 *   shape) as `resolveRuntimeArtifactLayoutFromRegistry`.
 * @throws {TypeError} for an unrecognized entry in `scopes` — reuses
 *   `install-scope.cts`'s shared `validateScopeId`, the same validator
 *   `scopeRank`/`resolveScope`/`isGlobalScope` already throw through, so this
 *   sibling of theirs cannot silently fail open on a bad scope (#2871 Phase 2
 *   review finding). `scopes: []` is untouched — an empty array has no
 *   entries to validate and still resolves to `[]`.
 */
function resolveTriggerSurface(runtime, scopes, opts) {
    const registry = opts.registry ?? getTriggerRegistry();
    const runtimeDescriptor = registry.runtimes[runtime]?.runtime;
    const layout = runtimeDescriptor?.artifactLayout;
    if (!layout) {
        throw new TypeError(`Unknown runtime: '${runtime}' — add to runtime-artifact-layout.cjs table`);
    }
    for (const scope of scopes) {
        (0, install_scope_cjs_1.validateScopeId)(scope, 'resolveTriggerSurface');
    }
    const scopeSet = new Set(scopes);
    const stems = opts.stems ?? [];
    const routerStemSet = new Set(opts.routerStems ?? []);
    const childToRouters = opts.childToRouters ?? {};
    const precedence = runtimeDescriptor?.triggerPrecedence ?? getDefaultTriggerPrecedence();
    const precedenceRank = new Map(precedence.map((kind, index) => [kind, index]));
    const surfaces = [];
    for (const scope of install_scope_cjs_1.SCOPE_ORDER) {
        if (!scopeSet.has(scope))
            continue;
        const entries = layout[scope] ?? [];
        for (const entry of entries) {
            if (entry.kind !== 'commands' && entry.kind !== 'skills')
                continue; // excludes agents/kimi-agents
            const kind = entry.kind;
            const destSubpath = (0, shell_command_projection_cjs_1.posixNormalize)(entry.destSubpath);
            const namespacedByDir = isNamespacedByDir(kind, entry.destSubpath, entry.prefix);
            const nested = entry.nesting === 'nested';
            for (const stem of stems) {
                const trigger = `${entry.prefix}${stem}`;
                let destPath;
                if (kind === 'skills') {
                    destPath = `${destSubpath}/${entry.prefix}${stem}`;
                }
                else {
                    destPath = `${destSubpath}/${composeCommandFilename(namespacedByDir, entry.prefix, stem)}`;
                }
                let registration = 'direct';
                let routerTrigger = null;
                if (nested && routerStemSet.size > 0 && !routerStemSet.has(stem)) {
                    const owningRouters = childToRouters[stem];
                    const routerStem = owningRouters && owningRouters.length > 0 ? owningRouters[0] : undefined;
                    if (routerStem !== undefined && routerStemSet.has(routerStem)) {
                        registration = 'via-router';
                        routerTrigger = `${entry.prefix}${routerStem}`;
                    }
                }
                surfaces.push({ trigger, kind, scope, destPath, registration, routerTrigger, shadowedBy: null });
            }
        }
    }
    // Winner computation, per trigger string, across every scope/kind candidate.
    const groups = new Map();
    for (const surface of surfaces) {
        const group = groups.get(surface.trigger);
        if (group) {
            group.push(surface);
        }
        else {
            groups.set(surface.trigger, [surface]);
        }
    }
    for (const group of groups.values()) {
        if (group.length <= 1)
            continue; // sole candidate: unshadowed by construction
        let winner = group[0];
        for (let i = 1; i < group.length; i++) {
            const candidate = group[i];
            if (isHigherPriority(candidate, winner, precedenceRank))
                winner = candidate;
        }
        for (const surface of group) {
            if (surface !== winner) {
                surface.shadowedBy = { kind: winner.kind, scope: winner.scope };
            }
        }
    }
    return surfaces;
}
// ---------------------------------------------------------------------------
// The advertised "next step" command (#5215, ADR-5057 §5 Phase 12).
//
// What the installer tells a user to run is a projection of what the runtime
// registered: the `new-project` trigger the Trigger Surface resolves for the
// install scope. It is never a per-runtime literal, so a runtime that registers
// no such trigger (pi's native extension registers only `/gsd`; windsurf's
// global layout registers nothing) cannot be told to run one (#4567).
// ---------------------------------------------------------------------------
/** The cross-agent default for an id GSD cannot know (ADR-5057 §5 Phase 10 amendment). */
const DEFAULT_NEW_PROJECT_COMMAND = '/gsd-new-project';
/**
 * How a host invokes a registered trigger. Presentation only — whether the
 * trigger exists is decided by the registered surface, not by this table. A
 * runtime absent here is invoked as `/<trigger>`.
 */
// Agent Skills hosts that start a skill with `/skill:<name>` (kimi; pi, #5547 —
// pi never accepts a bare `/<name>` for a skill).
const slashSkillInvocation = (trigger) => `/skill:${trigger}`;
const TRIGGER_INVOCATION = {
    codex: (trigger) => `$${trigger}`,
    cursor: (trigger) => `${trigger} (mention the skill name)`,
    kimi: slashSkillInvocation,
    pi: slashSkillInvocation,
};
/**
 * The command a native-extension runtime registers instead of per-workflow
 * triggers: the extension file's stem as a slash command (pi's `gsd.js`
 * registers `/gsd`; pinned by tests/advertised-command-parity.test.cjs against
 * the extension itself). `null` for a runtime with no native plugin.
 */
function nativePluginCommand(runtime) {
    const descriptor = getTriggerRegistry().runtimes[runtime]?.runtime;
    const file = descriptor?.hostBehaviors?.nativePlugin?.file;
    if (typeof file !== 'string' || file.length === 0)
        return null;
    const stem = file.replace(/\.[^.]+$/, '');
    return stem.length > 0 ? `/${stem}` : null;
}
/**
 * The command the installer advertises for starting a project, generated from
 * the registered trigger surface of `runtime` in `scope`. `unregistered` means
 * the runtime registers no `new-project` trigger there (`nativeCommand` names
 * what a native-extension runtime registers instead). An empty or unregistered
 * id keeps the documented cross-agent default: it names a runtime GSD cannot
 * know, so no surface exists to project from. Membership is decided up front,
 * so an error inside the surface resolution is a bug and propagates.
 */
function resolveAdvertisedNewProject(runtime, scope) {
    const known = Boolean(runtime) && Object.prototype.hasOwnProperty.call(getTriggerRegistry().runtimes, runtime);
    if (!known)
        return { kind: 'command', command: DEFAULT_NEW_PROJECT_COMMAND };
    const registered = resolveTriggerSurface(runtime, [scope], { stems: ['new-project'] })[0];
    if (!registered)
        return { kind: 'unregistered', nativeCommand: nativePluginCommand(runtime) };
    const render = Object.prototype.hasOwnProperty.call(TRIGGER_INVOCATION, runtime)
        ? TRIGGER_INVOCATION[runtime]
        : (trigger) => `/${trigger}`;
    return { kind: 'command', command: render(registered.trigger) };
}
module.exports = { resolveRuntimeArtifactLayout, resolveRuntimeArtifactLayoutFromRegistry, findInstallSourceRoot, resolveTriggerSurface, resolveAdvertisedNewProject, isNamespacedByDir, composeCommandFilename };
