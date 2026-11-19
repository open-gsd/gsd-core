"use strict";
/**
 * runtime-homes.cts — canonical runtime → global config/skills directory mapping.
 *
 * Single source of truth for resolving the global config base directory and
 * the correct global skills directory for every GSD-supported runtime.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/runtime-homes.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved
 * byte-for-behaviour from the prior hand-written .cjs; only types are added.
 *
 * Runtime-specific notes:
 *   hermes  — GSD skills nest under skills/gsd/<skillName>/ (not the flat
 *             skills/<skillName>/ layout used by all other runtimes).
 *   cline   — Skills-capable since v3.48.0 (#782). SKILL.md files live at
 *             ~/.cline/skills/<skillName>/SKILL.md (same flat layout as cursor/codex).
 *             .clinerules is also emitted (rules-based compatibility layer).
 *   kimi    — Agent Skills are discovered from Kimi's generic user roots:
 *             ~/.config/agents/skills (recommended) then ~/.agents/skills,
 *             with Kimi selecting the first existing generic skills directory.
 *             ~/.kimi-code/skills is brand-specific and can be selected as a
 *             GSD write target with --config-dir or KIMI_CONFIG_DIR.
 *   trae    — Targets Trae IDE (trae.ai), the Electron-based IDE — NOT
 *             trae-agent (github.com/bytedance/trae-agent), a Python CLI that
 *             uses trae_config.yaml, has no ~/.trae directory, and has no
 *             skills system. Both are ByteDance "Trae" products; they are
 *             entirely distinct. The global ~/.trae/skills/ path is
 *             community-soft-confirmed: docs.trae.ai/ide/skills documents the
 *             SKILL.md format and project-level .trae/skills/, but does NOT
 *             publish the global on-disk path; ~/.trae/skills/ rests on
 *             community evidence incl. Trae-AI/TRAE#2253. Best-effort only.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GSD_LOCATION_ENV_KEYS = exports.NON_REGISTRY_CONFIG_HOME_DESCRIPTORS = exports.KIMI_CODE_HOOKS_TOML_DESCRIPTOR = exports.KIMI_HOOKS_TOML_DESCRIPTOR = exports.LEGACY_NON_REGISTRY_RUNTIME_IDS = void 0;
exports.isRegisteredRuntimeId = isRegisteredRuntimeId;
exports.resolveConfigHomeFromDescriptor = resolveConfigHomeFromDescriptor;
exports.resolveAntigravityGlobalDir = resolveAntigravityGlobalDir;
exports.detectAntigravityDirAmbiguity = detectAntigravityDirAmbiguity;
exports.resolveKimiGlobalDir = resolveKimiGlobalDir;
exports.resolveGsdHome = resolveGsdHome;
exports.resolveKimiHooksTomlDir = resolveKimiHooksTomlDir;
exports.getGlobalConfigDir = getGlobalConfigDir;
exports.resolveSkillsBaseFromDescriptor = resolveSkillsBaseFromDescriptor;
exports.getGlobalSkillsBase = getGlobalSkillsBase;
exports.getGlobalSkillDir = getGlobalSkillDir;
exports.getGlobalSkillDisplayPath = getGlobalSkillDisplayPath;
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const node_fs_1 = __importDefault(require("node:fs"));
const runtime_name_policy_cjs_1 = require("./runtime-name-policy.cjs");
/**
 * Expand a leading ~ to the given home directory (defaults to os.homedir()).
 * Every call site inside resolveConfigHomeFromDescriptor threads its
 * resolved `home` local through here so an injected opts.home (used by
 * hermetic tests) is honored instead of silently falling back to the real
 * home directory.
 */
function expandTilde(p, home = node_os_1.default.homedir()) {
    if (!p)
        return p;
    if (p.startsWith('~/') || p === '~')
        return node_path_1.default.join(home, p.slice(1));
    return p;
}
/**
 * True when `val` is a usable env-var override: a real string that contains
 * at least one non-whitespace character. Every env-override consumption site
 * in resolveConfigHomeFromDescriptor gates on this instead of a bare truthy
 * check, so `FOO_DIR=''` (empty), `FOO_DIR` unset (`undefined`), and
 * `FOO_DIR='   '` (whitespace-only — e.g. from a shell templating bug that
 * leaves a variable substitution blank but quoted) all fall back to the
 * descriptor default identically. Deliberately does NOT trim: a value that
 * merely has leading/trailing whitespace around otherwise-real content (or
 * interior whitespace, e.g. `~/My Agent Dir`) is passed through byte-for-byte
 * unchanged, exactly as this module already treats every other env-var
 * override (no site here or elsewhere in this file trims a path value) — so
 * default behavior for every non-whitespace value is unaffected by this guard.
 */
function hasNonBlankOverride(val) {
    return typeof val === 'string' && val.trim() !== '';
}
function resolveDescriptorWithOptions(configHome) {
    return resolveConfigHomeFromDescriptor(configHome, {
        env: process.env,
        home: node_os_1.default.homedir(),
        existsSync: node_fs_1.default.existsSync,
    });
}
function getRegistry() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('./capability-registry.cjs');
}
/**
 * Legacy runtime ids that have a genuine, dedicated resolution branch
 * elsewhere in this module but no capability-registry descriptor (#3024
 * review BLOCKER, finding 1).
 *
 * `isRegisteredRuntimeId`'s real contract is "does this id resolve to a
 * real, runtime-specific path?", not "is it a key in the registry map" —
 * registry membership is only a proxy for that, and the proxy is wrong for
 * `grok`: `getGlobalConfigDir` has a live hardcoded branch for it (`~/.agents`,
 * overridable via `GROK_AGENTS_HOME`), predating the capability-registry
 * descriptor system, and it is documented end-user-facing surface
 * (pre-fix `gsd-core/workflows/sync-skills.md` listed it explicitly, and
 * `docs/discussions/grok-build-support-2026-05.md` records the support
 * decision). Rejecting it here would silently remove working, documented
 * `--skills-root`/`sync-skills` support for a runtime that never regressed.
 *
 * This set is enumerated by hand, not derived, and MUST stay in lockstep
 * with `getGlobalConfigDir`'s hardcoded branches: as of #3024, `grok` is
 * the ONLY id in this position (verified by reading the full function body
 * — every other unregistered id there falls through to the claude
 * fallback, which is the behavior this validator exists to reject). Do
 * NOT add an id here just because it "should" work — add it only after
 * confirming `getGlobalConfigDir` has a real dedicated branch for it, the
 * way `grok`'s is confirmed above. Do not "clean this up" by removing it;
 * that is exactly the regression this constant guards against.
 */
exports.LEGACY_NON_REGISTRY_RUNTIME_IDS = runtime_name_policy_cjs_1.LEGACY_NON_REGISTRY_RUNTIME_IDS;
/**
 * True when `runtime` is a real runtime id with a genuine, runtime-specific
 * resolution path — either a registered id in the capability registry
 * (`capability-registry.cjs`'s `runtimes` object) or one of the small,
 * explicitly named `LEGACY_NON_REGISTRY_RUNTIME_IDS` set (currently just
 * `grok`) that resolves via a dedicated hardcoded branch instead of a
 * registry descriptor.
 *
 * Guarded with an own-property lookup — never a bare index — so a
 * prototype-chain id (`__proto__`, `constructor`, `prototype`, `toString`,
 * …) can never resolve to an inherited value and be mistaken for a real
 * entry. Without this, `getGlobalSkillsBase`/`getGlobalConfigDir`'s bare
 * `runtimes[runtime]` lookups fall through the prototype chain for those
 * ids, find no usable descriptor, and silently resolve to claude's
 * fallback path instead of failing loudly (#3024).
 *
 * Single shared validator for every `--skills-root` entry point
 * (`gsd-tools query skills-root`'s `routeSkillsRoot`, `install.js
 * --skills-root`) so the two surfaces can never diverge on which runtime
 * ids they accept.
 */
function isRegisteredRuntimeId(runtime) {
    if (typeof runtime !== 'string')
        return false;
    const trimmed = runtime.trim();
    if (!trimmed)
        return false;
    return (0, runtime_name_policy_cjs_1.isKnownRuntimeId)(trimmed);
}
/**
 * Resolve a configHome descriptor to an absolute directory path.
 *
 * Implements the four descriptor kinds:
 *   - dot-home:           env-override → path.join(home, name)
 *   - dot-home-nested:    env-override → probed subdir of path.join(home, parent)
 *   - xdg:                env[0] → env[1](dirname) → env[2](XDG subdir) → ~/.config/<name>
 *   - generic-agents-root:env[0] → first probe where probeExists exists → probe[0]
 */
function resolveConfigHomeFromDescriptor(configHome, opts = {}) {
    const env = opts.env ?? process.env;
    const home = opts.home ?? node_os_1.default.homedir();
    const existsSyncFn = opts.existsSync ?? node_fs_1.default.existsSync;
    switch (configHome.kind) {
        case 'dot-home': {
            // First env var that is set wins
            for (const varName of configHome.env) {
                const val = env[varName];
                if (hasNonBlankOverride(val))
                    return expandTilde(val, home);
            }
            return node_path_1.default.join(home, configHome.name);
        }
        case 'dot-home-nested': {
            // env override
            const nestedEnv0Val = env[configHome.env[0]];
            if (configHome.env[0] && hasNonBlankOverride(nestedEnv0Val)) {
                return expandTilde(nestedEnv0Val, home);
            }
            const base = node_path_1.default.join(home, configHome.parent);
            if (configHome.probe && configHome.probe.length > 0) {
                // Pass 1 (marker-priority): when probeExists is declared, prefer the
                // candidate GSD actually owns (its `<candidate>/<probeExists>` exists).
                // This disambiguates an active-but-shadowing sibling dir (e.g. the
                // Antigravity-IDE `~/.gemini/antigravity` dir) from the dir GSD was
                // installed into, instead of blindly taking the first dir that exists.
                if (configHome.probeExists) {
                    for (const candidate of configHome.probe) {
                        const resolved = node_path_1.default.join(base, candidate);
                        if (existsSyncFn(node_path_1.default.join(resolved, configHome.probeExists))) {
                            return resolved;
                        }
                    }
                }
                // Pass 2 (legacy bare-existence): first candidate dir that exists.
                for (const candidate of configHome.probe) {
                    const resolved = node_path_1.default.join(base, candidate);
                    if (existsSyncFn(resolved))
                        return resolved;
                }
                // fallback: first probe candidate
                return node_path_1.default.join(base, configHome.probe[0]);
            }
            // no probe (e.g. windsurf): always name under parent
            return node_path_1.default.join(base, configHome.name);
        }
        case 'xdg': {
            // env[0]: direct override dir
            const xdgEnv0Val = env[configHome.env[0]];
            if (configHome.env[0] && hasNonBlankOverride(xdgEnv0Val)) {
                return expandTilde(xdgEnv0Val, home);
            }
            // env[1]: FILE path → dirname
            const xdgEnv1Val = env[configHome.env[1]];
            if (configHome.env[1] && hasNonBlankOverride(xdgEnv1Val)) {
                return node_path_1.default.dirname(expandTilde(xdgEnv1Val, home));
            }
            // env[2]: XDG_CONFIG_HOME → subdir
            const xdgEnv2Val = env[configHome.env[2]];
            if (configHome.env[2] && hasNonBlankOverride(xdgEnv2Val)) {
                return node_path_1.default.join(expandTilde(xdgEnv2Val, home), configHome.name);
            }
            return node_path_1.default.join(home, '.config', configHome.name);
        }
        case 'generic-agents-root': {
            // env override
            const garEnv0Val = env[configHome.env[0]];
            if (configHome.env[0] && hasNonBlankOverride(garEnv0Val)) {
                return expandTilde(garEnv0Val, home);
            }
            // probe each candidate; return first where probeExists subpath exists
            for (const candidate of configHome.probe) {
                const resolved = expandTilde(candidate, home);
                if (existsSyncFn(node_path_1.default.join(resolved, configHome.probeExists))) {
                    return resolved;
                }
            }
            // fallback: first probe candidate
            return expandTilde(configHome.probe[0], home);
        }
        case 'none': {
            // #2103: no file-projected config directory exists for this runtime
            // (e.g. vscode). Previously this kind had no matching case, so the
            // switch fell through and implicitly returned `undefined` — which
            // then crashed a downstream `path.join(undefined, ...)` with a
            // cryptic `TypeError [ERR_INVALID_ARG_TYPE]` far from the real cause.
            // Throwing here makes the failure mode explicit; callers that need a
            // nullable result (getGlobalSkillsBase) check `configHome.kind` and
            // short-circuit BEFORE ever reaching this function.
            throw new Error(`Runtime "${configHome.name}" has no config-home directory (configHome.kind === "none")`);
        }
    }
}
/**
 * Resolve Antigravity global config dir across 1.x and 2.x layouts.
 *
 * Thin wrapper delegating to resolveConfigHomeFromDescriptor with the
 * antigravity descriptor shape. Preserved for external callers and tests.
 */
function resolveAntigravityGlobalDir(opts = {}) {
    const env = opts.env ?? process.env;
    const home = opts.home ?? node_os_1.default.homedir();
    const existsSyncFn = opts.existsSync ?? node_fs_1.default.existsSync;
    return resolveConfigHomeFromDescriptor({
        kind: 'dot-home-nested',
        name: 'antigravity',
        parent: '.gemini',
        env: ['ANTIGRAVITY_CONFIG_DIR'],
        probe: ['antigravity', 'antigravity-ide', 'antigravity-cli'],
        // Prefer the candidate GSD installed into (carries gsd-core/VERSION) over
        // a bare-existing sibling. Without this, a CLI user (antigravity-cli) who
        // also has the IDE's ~/.gemini/antigravity dir is shadowed to the legacy
        // dir because it is probed first. See #213/#217. The posix-slash literal
        // matches capabilities/antigravity/capability.json; both normalize via
        // path.join at the check site, so Windows backslash handling is covered.
        probeExists: 'gsd-core/VERSION',
    }, { env, home, existsSync: existsSyncFn });
}
/**
 * Detect whether the Antigravity config-dir resolution is ambiguous — i.e. more
 * than one of ~/.gemini/{antigravity,antigravity-ide,antigravity-cli} exists, so
 * a user upgrading from a pre-#217 install may have had GSD written into the
 * wrong sibling dir (the legacy/IDE dir shadowing an active CLI dir).
 *
 * This is a pure, side-effect-free probe intended for the installer and
 * /gsd-update to surface operator guidance (set ANTIGRAVITY_CONFIG_DIR or move
 * gsd-core/ into the intended dir). The migration framework cannot relocate an
 * install across sibling config dirs (it is bounded to a single configDir and
 * has no cross-dir move primitive — see installer-migrations 004), so existing
 * misinstalls are corrected by re-detection + operator guidance, not an
 * automatic move.
 */
function detectAntigravityDirAmbiguity(opts = {}) {
    const env = opts.env ?? process.env;
    const home = opts.home ?? node_os_1.default.homedir();
    const existsSyncFn = opts.existsSync ?? node_fs_1.default.existsSync;
    const marker = node_path_1.default.join('gsd-core', 'VERSION');
    const base = node_path_1.default.join(home, '.gemini');
    const candidates = ['antigravity', 'antigravity-ide', 'antigravity-cli'].map((c) => node_path_1.default.join(base, c));
    const presentDirs = candidates.filter((dir) => existsSyncFn(dir));
    const gsdMarkedDirs = candidates.filter((dir) => existsSyncFn(node_path_1.default.join(dir, marker)));
    return {
        ambiguous: presentDirs.length > 1,
        resolved: resolveAntigravityGlobalDir({ env, home, existsSync: existsSyncFn }),
        presentDirs,
        gsdMarkedDirs,
        envOverridden: Boolean(env['ANTIGRAVITY_CONFIG_DIR']),
    };
}
/**
 * Resolve Kimi's generic user root using Kimi CLI's documented first-existing
 * generic skills directory policy:
 *
 *   1. ~/.config/agents/skills  (recommended)
 *   2. ~/.agents/skills
 *
 * If neither generic skills directory exists yet, install to the recommended
 * ~/.config/agents root so the generated skills become the first generic
 * candidate Kimi discovers.
 *
 * KIMI_CONFIG_DIR is a GSD installer write-location override. It is not Kimi's
 * upstream data-root variable, and arbitrary roots are discoverable by Kimi only
 * when the user also configures Kimi --skills-dir or extra_skill_dirs.
 *
 * Thin wrapper delegating to resolveConfigHomeFromDescriptor with the
 * kimi descriptor shape. Preserved for external callers and tests.
 */
function resolveKimiGlobalDir(opts = {}) {
    const env = opts.env ?? process.env;
    const home = opts.home ?? node_os_1.default.homedir();
    const existsSyncFn = opts.existsSync ?? node_fs_1.default.existsSync;
    return resolveConfigHomeFromDescriptor({
        kind: 'generic-agents-root',
        name: 'agents',
        env: ['KIMI_CONFIG_DIR'],
        probe: ['~/.config/agents', '~/.agents'],
        probeExists: 'skills',
    }, { env, home, existsSync: existsSyncFn });
}
/**
 * Kimi CLI's own native config.toml home. Hoisted out of resolveKimiHooksTomlDir
 * so it is ENUMERABLE, not merely resolvable.
 *
 * #2665 round 3: a config-location var that lives only inside a function body is
 * invisible to every consumer that needs the SET rather than the path — the test
 * scrub list and the hermeticity guard both derive from descriptors, and this one
 * reached neither. `kimi` is the sharp case precisely because it owns TWO config
 * homes: KIMI_CONFIG_DIR (registry-visible, already covered) and KIMI_SHARE_DIR
 * (this one), so a derivation keyed only on the registry looks complete and is not.
 */
exports.KIMI_HOOKS_TOML_DESCRIPTOR = {
    kind: 'dot-home',
    name: '.kimi',
    env: ['KIMI_SHARE_DIR'],
};
/**
 * Kimi Code's native config.toml home — the `kimi-code` counterpart of the
 * descriptor above, hoisted for exactly the same reason.
 *
 * #2755 landed kimi-code hooks support on `next` while this PR was open, and
 * declared this descriptor as an inline object literal inside
 * resolveKimiHooksTomlDir's body — the same resolvable-but-not-enumerable shape
 * round 3 hoisted KIMI_SHARE_DIR out of. Hoisting it puts `KIMI_CODE_HOME` into
 * the derived scrub set and the hermeticity guard's watch roots in the SAME
 * commit, which is the property NON_REGISTRY_CONFIG_HOME_DESCRIPTORS exists to
 * guarantee. Each product's env var stays scoped to that product (#2755).
 */
exports.KIMI_CODE_HOOKS_TOML_DESCRIPTOR = {
    kind: 'dot-home',
    name: '.kimi-code',
    env: ['KIMI_CODE_HOME'],
};
/**
 * Config-home descriptors resolved OUTSIDE the capability registry.
 *
 * Anything added here is picked up by every derived consumer in the same commit —
 * which is the property that makes the derivation structurally incapable of being
 * narrower than the surface it guards. Adding a hardcoded resolver WITHOUT adding
 * its descriptor here is the defect this array exists to make hard.
 */
exports.NON_REGISTRY_CONFIG_HOME_DESCRIPTORS = [
    exports.KIMI_HOOKS_TOML_DESCRIPTOR,
    exports.KIMI_CODE_HOOKS_TOML_DESCRIPTOR,
];
/**
 * GSD's OWN location vars — a second family, not runtime configHomes.
 *
 * #2665 round 3: the registry describes where each *third-party runtime* keeps its
 * config. It says nothing about where GSD keeps its own user-owned state, and that
 * is a separate env-first surface:
 *
 *   GSD_HOME       — `process.env['GSD_HOME'] || os.homedir()`, the root of
 *                    `$GSD_HOME/.gsd/` (consent.json, defaults.json, capability
 *                    overlays). Read env-first by capability-loader, capability-consent,
 *                    capability-state, capability-writer, config-loader, install-profiles
 *                    and bin/install.js. A WRITE surface.
 *   GSD_AGENTS_DIR — `if (process.env['GSD_AGENTS_DIR']) return it`, priority 1 in
 *                    getAgentsDir. Misdirects a READ rather than a write, hence lower
 *                    severity — but it is env-first and unconditional, so it belongs
 *                    to the same class.
 *
 * Deliberately NOT folded into the descriptor array above: these do not resolve
 * through resolveConfigHomeFromDescriptor and have no `kind`/`name` shape.
 */
exports.GSD_LOCATION_ENV_KEYS = ['GSD_HOME', 'GSD_AGENTS_DIR'];
/**
 * #5017: the ONE rule for the root of the GSD-owned store (`$GSD_HOME/.gsd/`:
 * defaults.json, consent.json, capability overlays) — `GSD_HOME` when set and
 * non-blank, otherwise the home directory. The config loader, the install-time
 * resolvers, the installer's defaults writer and capability staging all call
 * this, so one configuration gives one answer at install time, at dispatch time
 * and in the staged capabilities. The hooks (cold-tree, no lib import) and the
 * settings / new-project workflows (shell) carry the same rule inline; a test
 * pins each of them to it.
 *
 * `fallbackHome` lets a caller that already holds an injected home directory
 * (the install-time resolvers' test seam) keep using it when GSD_HOME is unset.
 * A blank `GSD_HOME` is "unset": `''` must never become a relative store path.
 */
function resolveGsdHome(fallbackHome = node_os_1.default.homedir()) {
    return process.env['GSD_HOME'] || fallbackHome;
}
/**
 * Resolve the directory holding the Kimi product's OWN native config.toml —
 * the file that product itself reads for providers/models/hooks/etc, and the
 * one GSD writes its `[[hooks]]` block, hooks bundle and CommonJS marker into.
 *
 * The two Kimi runtimes share `hooksSurface: "kimi-hooks-toml"` but are
 * different products with different roots, and this must be selected by
 * `runtime` (#2755). Before that fix this function was unparameterized and a
 * `--kimi-code` install wrote its hooks into Kimi CLI's `~/.kimi`, leaving Kimi
 * Code with none:
 *
 *   kimi       → `~/.kimi`,      overridden by `KIMI_SHARE_DIR`
 *                (moonshotai.github.io/kimi-cli/en/configuration/data-locations.html)
 *   kimi-code  → `~/.kimi-code`, overridden by `KIMI_CODE_HOME`
 *                (moonshotai/kimi-code docs/en/configuration/data-locations.md;
 *                 its hooks doc places `[[hooks]]` in `~/.kimi-code/config.toml`)
 *
 * Each product's env var is scoped to that product: `KIMI_SHARE_DIR` is Kimi
 * CLI's own upstream variable and must NOT redirect kimi-code, nor vice versa.
 *
 * An unrecognised `runtime` (and an omitted one) falls back to `~/.kimi`, which
 * preserves the pre-#2755 behaviour for every existing caller that passes no
 * runtime — this function is exported, so that default is a contract.
 *
 * For BOTH runtimes this is deliberately a SEPARATE directory from the generic
 * Agent-Skills root resolved by `resolveKimiGlobalDir` (`~/.config/agents`):
 * both vendors' docs confirm the Agent-Skills search path is independent of the
 * data-root env var. GSD's native `[[hooks]]` entries go in
 * `<this dir>/config.toml`, never into the skills configDir.
 */
function resolveKimiHooksTomlDir(opts = {}) {
    const env = opts.env ?? process.env;
    const home = opts.home ?? node_os_1.default.homedir();
    // Explicit comparison rather than an object lookup keyed on `runtime`: the
    // value originates from argv, and an index would resolve inherited keys
    // (`constructor`, `__proto__`) to something that is not a descriptor.
    const descriptor = opts.runtime === 'kimi-code'
        ? exports.KIMI_CODE_HOOKS_TOML_DESCRIPTOR
        : exports.KIMI_HOOKS_TOML_DESCRIPTOR;
    return resolveConfigHomeFromDescriptor(descriptor, { env, home });
}
/**
 * Return the global config base directory for the given runtime.
 * Respects the same env-var overrides as bin/install.js getGlobalDir().
 *
 * @param runtime   - The runtime identifier (e.g. 'claude', 'opencode').
 * @param explicitDir - If provided and non-empty, returned immediately after
 *   tilde-expansion, overriding all env-var and default logic. This matches
 *   the behaviour of bin/install.js getGlobalDir(runtime, explicitDir).
 */
function getGlobalConfigDir(runtime, explicitDir) {
    // A retired or unknown runtime id must never resolve — checked before
    // `explicitDir` so an explicit directory cannot mask the fact that the runtime
    // itself is gone (retired) or was never registered (#5169). An absent id
    // (`''`) is the generic "no runtime" path and still reaches the default.
    (0, runtime_name_policy_cjs_1.assertKnownRuntime)(runtime);
    if (explicitDir)
        return expandTilde(explicitDir);
    // ── Legacy non-registry runtimes (grok): table-driven, not registry-backed ─
    if (Object.prototype.hasOwnProperty.call(runtime_name_policy_cjs_1.LEGACY_NON_REGISTRY_RUNTIME_HOMES, runtime)) {
        const legacy = runtime_name_policy_cjs_1.LEGACY_NON_REGISTRY_RUNTIME_HOMES[runtime];
        const env = process.env;
        const override = env[legacy.env];
        return override ? expandTilde(override) : node_path_1.default.join(node_os_1.default.homedir(), ...legacy.dir);
    }
    // ── Descriptor-driven: look up in capability-registry ────────────────────
    const { runtimes } = getRegistry();
    const runtimeEntry = runtimes[runtime];
    if (runtimeEntry?.runtime?.configHome) {
        return resolveDescriptorWithOptions(runtimeEntry.runtime.configHome);
    }
    // ── Default (unknown runtime → Claude fallback) ───────────────────────────
    const env = process.env;
    return env['CLAUDE_CONFIG_DIR'] ? expandTilde(env['CLAUDE_CONFIG_DIR']) : node_path_1.default.join(node_os_1.default.homedir(), '.claude');
}
/**
 * Return the global skills base directory for the given runtime.
 * Descriptor-backed runtimes derive the base home from configHome.skillsHome
 * when present, then append the first global skills artifact destSubpath.
 */
function resolveSkillsBaseFromDescriptor(configHome, opts = {}, skillsDestSubpath = 'skills') {
    const baseDescriptor = configHome.skillsHome ?? configHome;
    const base = resolveConfigHomeFromDescriptor(baseDescriptor, opts);
    return node_path_1.default.join(base, skillsDestSubpath);
}
function getGlobalSkillsBase(runtime) {
    (0, runtime_name_policy_cjs_1.assertKnownRuntime)(runtime);
    const runtimeEntry = getRegistry().runtimes[runtime];
    const descriptor = runtimeEntry?.runtime;
    // #2103: a runtime with `configHome.kind === 'none'` (e.g. vscode —
    // Marketplace/VSIX extension, installSurface:'none') has no file-projected
    // config directory at all, and therefore no skills root. Short-circuit to
    // null BEFORE falling through to getGlobalConfigDir below, which would
    // otherwise throw resolving a 'none' configHome (see
    // resolveConfigHomeFromDescriptor's 'none' case). null is the correct
    // answer here, not a crash — the `=== null` guard at every call site
    // (bin/install.js --skills-root, gsd-tools routeSkillsRoot) already
    // handles it as "this runtime does not use a skills directory".
    if (descriptor?.configHome?.kind === 'none')
        return null;
    const globalSkillsKind = descriptor?.artifactLayout?.global?.find((entry) => entry.kind === 'skills');
    // ADR-1239 upgrade 3 (#2088): honor a skills-kind `home` override (e.g. Codex
    // → $HOME/.agents/skills, independent of $CODEX_HOME) so the reported skills
    // root matches where the installer actually writes (the artifact layout /
    // _resolveSkillsRootDir). Without this, `--skills-root` and the sync-skills
    // workflow would look under configHome/skills while skills live under ~/.agents.
    if (globalSkillsKind?.home && globalSkillsKind?.destSubpath) {
        return node_path_1.default.join(node_os_1.default.homedir(), globalSkillsKind.home, globalSkillsKind.destSubpath);
    }
    if (descriptor?.configHome && globalSkillsKind?.destSubpath) {
        return resolveSkillsBaseFromDescriptor(descriptor.configHome, { env: process.env, home: node_os_1.default.homedir(), existsSync: node_fs_1.default.existsSync }, globalSkillsKind.destSubpath);
    }
    const configDir = getGlobalConfigDir(runtime);
    return node_path_1.default.join(configDir, 'skills');
}
/**
 * Return the full path to a specific skill's directory for the given runtime.
 */
function getGlobalSkillDir(runtime, skillName) {
    const base = getGlobalSkillsBase(runtime);
    if (base === null)
        return null;
    return node_path_1.default.join(base, skillName);
}
/**
 * Return a human-readable display path for a global skill (for log messages).
 */
function getGlobalSkillDisplayPath(runtime, skillName) {
    const dir = getGlobalSkillDir(runtime, skillName);
    if (!dir)
        return `(${runtime} does not use a skills directory)`;
    // Replace homedir prefix with ~ for readability
    const home = node_os_1.default.homedir();
    return dir.startsWith(home) ? '~' + dir.slice(home.length) : dir;
}
