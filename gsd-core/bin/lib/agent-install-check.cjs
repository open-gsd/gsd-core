"use strict";
/**
 * Agent Install Check — moved from core.cts (ADR-857 T0 #1268 phase rehome-core-squatters).
 *
 * Owns:
 *   - getAgentsDir(runtime?, projectRoot?): string
 *   - checkAgentsInstalled(runtime?, projectRoot?): AgentsInstalledResult
 *
 * The core.cjs re-export spine was retired in epic #1267; callers import
 * these symbols from agent-install-check.cjs directly.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const modelProfiles = require("./model-profiles.cjs");
const { MODEL_PROFILES } = modelProfiles;
const runtime_homes_cjs_1 = require("./runtime-homes.cjs");
const runtime_name_policy_cjs_1 = require("./runtime-name-policy.cjs");
// #3242 — model-catalog is a genuine leaf (only node:path + its own JSON), which is
// exactly why Phase 1 (#3241) moved isAnthropicFlavoredModel there: this module can
// consume it without dragging model-resolver's config-loader chain into a
// pure read/verify surface.
const model_catalog_cjs_1 = require("./model-catalog.cjs");
// #3243 — the Codex `.toml` block-range/BOM/scan primitives moved into the typed
// IR module (Phase 3), which this reader now imports rather than defining
// locally. Behavior is unchanged: scanTomlLines/stripBOM here are the exact
// same lenient functions that used to live in this file — see
// codex-agent-toml.cts's module header for the reader/writer reconciliation.
// #3897 CAUSE A fix: `deriveCodexSandboxMode` needs the resolved `tools:`
// frontmatter VALUE, not raw content — this module used to reach that via
// `runtime-artifact-conversion.cjs`'s general-purpose
// `extractFrontmatterAndBody`/`extractFrontmatterField`, but that module's
// dependency chain (`command-roster.cjs` -> `scripts/fix-slash-commands.cjs`,
// a dev-only repo script) does not resolve from an installed tree — any test
// exercising a synthetic install dir blew up at module load. `codex-agent-toml.cjs`
// is already imported here, is a genuine leaf (node builtins only, zero
// side effects), and now exports `extractToolsValue` — a single-purpose
// `tools:`-VALUE reader (inline AND YAML block-list form, #3897 list-form
// parse fix), not a general frontmatter parser — for exactly this caller,
// shared with `bin/install.js`'s emitter so the two sandbox-feeding paths
// can never silently disagree, and no fourth copy of frontmatter parsing is
// added.
const codex_agent_toml_cjs_1 = require("./codex-agent-toml.cjs");
/**
 * Frozen reason enum for {@link checkCodexModelPosture}. Per CONTRIBUTING's
 * typed-IR rule ("Error / status / reason → a frozen enum"): callers and tests
 * assert on these wire values, never on prose. Adding a member is a deliberate
 * three-way coordinated change — enum, emitting site, and the enum-lock test.
 */
const POSTURE_REASON = Object.freeze({
    ANTHROPIC_FLAVORED_MODEL: 'anthropic_flavored_model',
    ORPHANED_REASONING_EFFORT: 'orphaned_reasoning_effort',
    UNREADABLE: 'unreadable',
    NOT_CODEX: 'not_codex',
    AGENTS_DIR_MISSING: 'agents_dir_missing',
});
// Matches the value-truncation convention in bin/install.js's
// _warnCodexModelOverrideDropped: values over 64 chars are capped so an
// oversized or secret-shaped config value can never reach a report in full.
function truncatePostureValue(value) {
    return value.length > 64 ? `${value.slice(0, 64)}…` : value;
}
/**
 * Resolve the agents directory for the given runtime.
 *
 * Priority:
 *   1. GSD_AGENTS_DIR env var (explicit override, any runtime)
 *   2. For claude runtime: __dirname-relative path (agents/ sibling of
 *      gsd-core/) — correct for repo runs and runtime-config-dir installs,
 *      where the sibling agents/ IS the user's agents dir — UNLESS that path
 *      carries an exact node_modules segment. gsd-tools.cjs lives inside
 *      gsd-core/bin/ in every install shape, but on an npm-global install
 *      gsd-core/ sits inside the package (not the runtime config dir) and the
 *      package ships its own agents/, so the install-relative path resolves
 *      to the bundled copy and the check validates the package against
 *      itself — agents_installed can never be false. In that case resolve
 *      getGlobalConfigDir('claude')/agents (honours CLAUDE_CONFIG_DIR) like
 *      every other runtime (#3203).
 *   3. For non-claude runtimes with a manifest-backed project-local install:
 *      <projectRoot>/<localConfigDir>/agents (or <projectRoot>/agents when
 *      the runtime's local install targets the project root). Requiring the
 *      GSD manifest prevents runtime-native project agents from shadowing a
 *      working global GSD install. A local agents directory or manifest that is a
 *      symlink (a junction on Windows) is followed (#5911); a dangling link falls
 *      through to the global directory.
 *   4. For non-claude runtimes: getGlobalConfigDir(runtime)/agents
 *
 * @param runtime - the active runtime name; defaults to GSD_RUNTIME env, then 'claude'
 * @param projectRoot - canonical project root for local-install discovery
 */
function getAgentsDir(runtime, projectRoot) {
    if (process.env['GSD_AGENTS_DIR']) {
        return process.env['GSD_AGENTS_DIR'];
    }
    const resolved = runtime ?? (process.env['GSD_RUNTIME'] || 'claude');
    if (resolved === 'claude') {
        const installRelative = node_path_1.default.join(__dirname, '..', '..', '..', 'agents');
        // #3203: a lexical guard, not an install-shape test. It targets the
        // layouts where the sibling agents/ is the package's own bundled copy and
        // the check would otherwise validate the package against itself; a path
        // merely carrying a directory of that name resolves the same way, and a
        // non-empty GSD_AGENTS_DIR overrides both.
        if (installRelative.split(node_path_1.default.sep).includes('node_modules')) {
            return node_path_1.default.join((0, runtime_homes_cjs_1.getGlobalConfigDir)('claude'), 'agents');
        }
        return installRelative;
    }
    if (projectRoot) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { runtimes } = require('./capability-registry.cjs');
        const runtimeConfig = runtimes[resolved]?.runtime;
        const localConfigDirName = (0, runtime_name_policy_cjs_1.getDirName)(resolved);
        const localConfigDir = localConfigDirName === runtime_name_policy_cjs_1.NO_LOCAL_CONFIG_DIR_SENTINEL
            ? undefined
            : runtimeConfig?.hostBehaviors?.localTargetIsProjectRoot
                ? projectRoot
                : node_path_1.default.join(projectRoot, localConfigDirName);
        if (!localConfigDir) {
            return node_path_1.default.join((0, runtime_homes_cjs_1.getGlobalConfigDir)(resolved), 'agents');
        }
        const localAgentsDir = node_path_1.default.join(localConfigDir, 'agents');
        const manifestPath = node_path_1.default.join(localConfigDir, 'gsd-file-manifest.json');
        try {
            // #5911: stat, not lstat. A project that links one shared install into its config dir (a
            // symlink, or a directory junction on Windows) must resolve to the linked agents dir the way
            // the runtime itself loads it; lstat describes the link, so it reported neither a directory
            // nor a file. The manifest requirement (#2602) still decides whether the local dir counts.
            if (node_fs_1.default.statSync(localAgentsDir).isDirectory() && node_fs_1.default.statSync(manifestPath).isFile()) {
                return localAgentsDir;
            }
        }
        catch {
            // Local discovery is best-effort; any probe failure (a dangling link included) preserves
            // the global fallback.
        }
    }
    return node_path_1.default.join((0, runtime_homes_cjs_1.getGlobalConfigDir)(resolved), 'agents');
}
/**
 * Check which GSD agents are installed on disk.
 *
 * @param runtime - the active runtime name; defaults to GSD_RUNTIME env, then 'claude'
 * @param projectRoot - canonical project root for local-install discovery
 */
function checkAgentsInstalled(runtime, projectRoot) {
    const resolvedRuntime = runtime ?? (process.env['GSD_RUNTIME'] || 'claude');
    const agentsDir = getAgentsDir(resolvedRuntime, projectRoot);
    const expectedAgents = Object.keys(MODEL_PROFILES);
    const installed = [];
    const missing = [];
    if (!node_fs_1.default.existsSync(agentsDir)) {
        return {
            agents_installed: false,
            missing_agents: expectedAgents,
            installed_agents: [],
            incomplete_agents: [],
            agents_dir: agentsDir,
            agent_runtime: resolvedRuntime,
        };
    }
    for (const agent of expectedAgents) {
        if (agentFileExists(agentsDir, agent, resolvedRuntime)) {
            installed.push(agent);
        }
        else {
            missing.push(agent);
        }
    }
    // ── Manifest-backed completeness check ──────────────────────────────────────
    // If a gsd-file-manifest.json exists alongside the agents dir (parent dir),
    // verify that every manifest-tracked file for each expected agent is present
    // on disk. Missing manifest-tracked files indicate an incomplete install even
    // when the plain presence check above passed (e.g. .md present, .toml absent).
    // If no manifest is found the check is a no-op (graceful for claude/bundled).
    const incomplete = [];
    // #2872: the manifest read is the Installer Migration Module's, not a
    // fourth private copy of it. Lazily required — matching this file's own
    // capability-registry idiom — so a pure read/verify surface on the
    // init/verify hot path takes no new static dependency.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readInstallManifest } = require('./installer-migrations.cjs');
    const manifestFiles = readInstallManifest(node_path_1.default.dirname(agentsDir)).files;
    if (Object.keys(manifestFiles).length > 0) {
        for (const agent of expectedAgents) {
            // Find all manifest keys that belong to this agent:
            // key must be "agents/<agentName>.<ext>" with no further path segments.
            const agentPrefix = `agents/${agent}.`;
            const agentManifestKeys = Object.keys(manifestFiles).filter(key => {
                if (!key.startsWith(agentPrefix))
                    return false;
                const rest = key.slice(agentPrefix.length);
                // rest must be a bare extension (no slashes, non-empty)
                return rest.length > 0 && !rest.includes('/');
            });
            if (agentManifestKeys.length === 0) {
                // Agent not tracked in manifest — skip completeness check for this agent
                continue;
            }
            const allPresent = agentManifestKeys.every(key => {
                const basename = key.slice('agents/'.length);
                return node_fs_1.default.existsSync(node_path_1.default.join(agentsDir, basename));
            });
            if (!allPresent) {
                incomplete.push(agent);
            }
        }
    }
    return {
        agents_installed: installed.length > 0 && missing.length === 0 && incomplete.length === 0,
        missing_agents: missing,
        installed_agents: installed,
        incomplete_agents: incomplete,
        agents_dir: agentsDir,
        agent_runtime: resolvedRuntime,
    };
}
/**
 * Validate Codex `.toml` agent files for Anthropic-flavored `model` pins and
 * orphaned `model_reasoning_effort` values (ADR-2313 D6, #3242).
 *
 * A new sibling export to {@link checkAgentsInstalled}, deliberately — that
 * function carries 33 upstream dependents and cyclomatic complexity 25, so this
 * posture check gets zero new branches there (see 40-design.md "Rejected" #1).
 * Presence is `checkAgentsInstalled`'s job; this function's job starts only once
 * the runtime is confirmed `codex` and only inspects posture, never presence.
 *
 * Read-only: detects, never repairs (repair is Phase 3, #3243).
 *
 * @param runtime - the active runtime name; defaults to GSD_RUNTIME env, then 'claude'
 * @param projectRoot - canonical project root for local-install discovery
 */
function checkCodexModelPosture(runtime, projectRoot) {
    // Short-circuit BEFORE any filesystem access: a non-codex runtime must never
    // have its agents directory resolved or a stray .toml inspected, however
    // violating that file's contents would be if it were ever read (#3242 row 25).
    const resolvedRuntime = runtime ?? (process.env['GSD_RUNTIME'] || 'claude');
    if (resolvedRuntime !== 'codex') {
        return {
            ok: true,
            violations: [],
            checked: [],
            agents_dir: '',
            agent_runtime: resolvedRuntime,
            reason: POSTURE_REASON.NOT_CODEX,
        };
    }
    const agentsDir = getAgentsDir(resolvedRuntime, projectRoot);
    if (!node_fs_1.default.existsSync(agentsDir)) {
        // Presence is checkAgentsInstalled's job — an absent agents dir here is a
        // distinct, non-violating outcome, not a failure of this check.
        return {
            ok: true,
            violations: [],
            checked: [],
            agents_dir: agentsDir,
            agent_runtime: resolvedRuntime,
            reason: POSTURE_REASON.AGENTS_DIR_MISSING,
        };
    }
    // Skip symlinks — matches cmdEffortSync's existing idiom in commands.cts
    // ("Skip symlinks — only write regular files..."). Here the risk is reading
    // (not writing) through a symlink: readFileSync follows symlinks, so an
    // agents-dir symlink pointing at an arbitrary file would let that target's
    // contents be echoed into this function's `value` field. A symlinked agent
    // file is a structural install choice (checkAgentsInstalled's territory),
    // not a model-content posture defect, so it is silently excluded from
    // `checked` rather than reported as a distinct violation — same shape as
    // cmdEffortSync, which silently drops symlinks from its file list rather
    // than inventing a new skip/violation reason.
    const tomlFiles = node_fs_1.default
        .readdirSync(agentsDir)
        .filter((entry) => {
        if (!entry.endsWith('.toml'))
            return false;
        try {
            return node_fs_1.default.lstatSync(node_path_1.default.join(agentsDir, entry)).isFile();
        }
        catch {
            return false;
        }
    })
        .sort();
    const checked = [];
    const violations = [];
    for (const entry of tomlFiles) {
        const agentName = entry.slice(0, -'.toml'.length);
        const filePath = node_path_1.default.join(agentsDir, entry);
        checked.push(agentName);
        let raw;
        try {
            raw = node_fs_1.default.readFileSync(filePath, 'utf8');
        }
        catch {
            // Never throws, never silently skips — an unreadable file is reported and
            // the loop continues checking the rest (40-design.md "Rejected" #5).
            violations.push({ agent: agentName, file: filePath, reason: POSTURE_REASON.UNREADABLE });
            continue;
        }
        const { model, hasReasoningEffort } = (0, codex_agent_toml_cjs_1.scanTomlLines)((0, codex_agent_toml_cjs_1.stripBOM)(raw));
        if (model !== null && (0, model_catalog_cjs_1.isAnthropicFlavoredModel)(model)) {
            violations.push({
                agent: agentName,
                file: filePath,
                reason: POSTURE_REASON.ANTHROPIC_FLAVORED_MODEL,
                value: truncatePostureValue(model),
            });
        }
        else if (model === null && hasReasoningEffort) {
            // #838 coupling: a reasoning-effort pin with no model pin means Codex
            // inherits the session model while the effort pin silently disagrees.
            violations.push({
                agent: agentName,
                file: filePath,
                reason: POSTURE_REASON.ORPHANED_REASONING_EFFORT,
            });
        }
    }
    return {
        ok: violations.length === 0,
        violations,
        checked,
        agents_dir: agentsDir,
        agent_runtime: resolvedRuntime,
    };
}
// #3897 rung 3 — the canonical bundled `agents/*.md` source directory (the
// tool-contract source of truth), resolved the same install-relative way
// getAgentsDir resolves the claude case, WITHOUT that function's npm-global
// node_modules redirect: that redirect exists so a Codex/claude INSTALL is
// never validated against itself, but here we deliberately want the bundled
// copy every time — it is the only place the `tools:` contract a role
// derives its sandbox_mode from actually lives, in every install shape
// (repo-dev tree or npm-global package, where the package still ships its
// own agents/ alongside bin/ and gsd-core/).
//
// #5496: "install-relative" has three shapes. This module compiles to
// `<root>/gsd-core/bin/lib/`, so `<root>` is three parents up. In the repository
// and the npm package the canonical sources are `<root>/agents`. In an INSTALLED
// config dir `<root>/agents` holds the CONVERTED runtime copies (no `tools:`
// declaration — every role then derived `read-only`, 26 false violations on a
// clean Codex install) and the canonical sources are `<root>/gsd-core/agents`.
// Prefer the nested directory when it actually holds agent sources; fall back to
// `<root>/agents`. `root` is a parameter so each layout is testable.
//
// #5636: "holds agent sources" is a recognized agent file, `gsd-<name>.md` (every file in the shipped
// roster) that is not a `.compact.md` variant. Any markdown would let a stray README in the nested
// directory hide the real sources, so the posture check found no role's canonical file and skipped all.
const CANONICAL_AGENT_SOURCE_FILE = /^gsd-.+\.md$/;
function isCanonicalAgentSourceFile(entry) {
    return CANONICAL_AGENT_SOURCE_FILE.test(entry) && !entry.endsWith('.compact.md');
}
function canonicalAgentSourceDir(root = node_path_1.default.join(__dirname, '..', '..', '..')) {
    const nested = node_path_1.default.join(root, 'gsd-core', 'agents');
    try {
        if (node_fs_1.default.readdirSync(nested).some(isCanonicalAgentSourceFile))
            return nested;
    }
    catch {
        // Absent or unreadable: not this layout.
    }
    return node_path_1.default.join(root, 'agents');
}
/**
 * Validate installed Codex `.toml` agents' `sandbox_mode` against what each
 * role's own tool contract derives (#3897, ADR-3473 §8.3 criterion 3,
 * HALT.md option 2). Sibling to {@link checkCodexModelPosture} — same shape,
 * same short-circuits — but a different defect class: a TOML whose
 * `sandbox_mode` disagrees with the derived expectation, not a bad `model`.
 *
 * `deriveCodexSandboxMode` (and the `CODEX_SANDBOX_HOLDS` hold list + its own
 * self-invalidation check it embeds) is imported from `codex-agent-toml.cjs`
 * — the shared, side-effect-free leaf both `bin/install.js`'s emitter and
 * this posture check import from (CAUSE A fix, #3897: this function used to
 * lazily `require('bin/install.js')` to reach the same derivation, but
 * requiring `bin/install.js` runs its whole CLI top-level, including an
 * ASCII banner print to stdout, which corrupted every stdout-JSON caller of
 * this posture check, e.g. `gsd-tools validate agents`) — so the emitter and
 * this posture check can never silently diverge on the same tool-contract
 * predicate — the exact generative-fix-divergence shape this epic exists to
 * close. `deriveCodexSandboxMode` itself is total (never throws, #3897
 * CAUSE C fix) — a held role whose supplied content no longer derives
 * broader than its pin simply returns `read-only` rather than failing,
 * because the pin is then a no-op. The staleness invariant (S4/S5) this
 * check's imports still carry is enforced separately, at the real `agents/`
 * roster level, by `validateCodexSandboxHolds` and
 * `tests/codex-config.test.cjs` T24/T25 — not by this per-call derivation.
 *
 * Read-only: detects, never repairs — same posture as {@link checkCodexModelPosture}.
 *
 * @param runtime - the active runtime name; defaults to GSD_RUNTIME env, then 'claude'
 * @param projectRoot - canonical project root for local-install discovery
 */
function checkCodexSandboxPosture(runtime, projectRoot) {
    const resolvedRuntime = runtime ?? (process.env['GSD_RUNTIME'] || 'claude');
    if (resolvedRuntime !== 'codex') {
        return {
            ok: true,
            violations: [],
            checked: [],
            agents_dir: '',
            agent_runtime: resolvedRuntime,
            reason: POSTURE_REASON.NOT_CODEX,
        };
    }
    const agentsDir = getAgentsDir(resolvedRuntime, projectRoot);
    if (!node_fs_1.default.existsSync(agentsDir)) {
        return {
            ok: true,
            violations: [],
            checked: [],
            agents_dir: agentsDir,
            agent_runtime: resolvedRuntime,
            reason: POSTURE_REASON.AGENTS_DIR_MISSING,
        };
    }
    const canonicalAgentsDir = canonicalAgentSourceDir();
    // Same symlink guard as checkCodexModelPosture, same reason (never follow
    // an agents-dir symlink into an arbitrary file's content).
    const tomlFiles = node_fs_1.default
        .readdirSync(agentsDir)
        .filter((entry) => {
        if (!entry.endsWith('.toml'))
            return false;
        try {
            return node_fs_1.default.lstatSync(node_path_1.default.join(agentsDir, entry)).isFile();
        }
        catch {
            return false;
        }
    })
        .sort();
    const checked = [];
    const violations = [];
    for (const entry of tomlFiles) {
        const agentName = entry.slice(0, -'.toml'.length);
        const filePath = node_path_1.default.join(agentsDir, entry);
        checked.push(agentName);
        let raw;
        try {
            raw = node_fs_1.default.readFileSync(filePath, 'utf8');
        }
        catch {
            violations.push({ agent: agentName, file: filePath, reason: POSTURE_REASON.UNREADABLE });
            continue;
        }
        // #3897 rung 4 (isolated correctness review, MINOR finding 2): route
        // through the same block-aware `scanTomlLines` the sibling
        // `checkCodexModelPosture` already uses, rather than a naive whole-file
        // regex — a `sandbox_mode = "..."`-shaped line inside the
        // `developer_instructions` block (prose) must never be read as a live
        // value. A prior naive `raw.match(/^sandbox_mode.../m)` here produced a
        // FALSE violation whenever an agent's own prompt prose happened to
        // contain that shape.
        const found = (0, codex_agent_toml_cjs_1.scanTomlLines)((0, codex_agent_toml_cjs_1.stripBOM)(raw)).sandboxMode;
        if (found === null) {
            // No sandbox_mode line at all (e.g. sandboxTier "none") is a deliberate,
            // documented state elsewhere — not this check's business.
            continue;
        }
        const canonicalFile = node_path_1.default.join(canonicalAgentsDir, `${agentName}.md`);
        let canonicalContent;
        try {
            canonicalContent = node_fs_1.default.readFileSync(canonicalFile, 'utf8');
        }
        catch {
            // No canonical role source (a custom/non-roster agent) — nothing to
            // derive an expectation from, so this is not this check's business.
            continue;
        }
        // `canonicalContent` is always a real string here (read via fs.readFileSync
        // above), so extractToolsValue's `undefined` (non-string input) branch is
        // unreachable on this path — the `?? ''` is a type-level formality, not a
        // behavior change (F4, #3897 security review: extractToolsValue is TOTAL).
        const toolsRaw = (0, codex_agent_toml_cjs_1.extractToolsValue)(canonicalContent) ?? '';
        const expected = (0, codex_agent_toml_cjs_1.deriveCodexSandboxMode)(agentName, toolsRaw);
        if (expected !== found) {
            // #3897 rung 4 (isolated correctness review, MINOR finding 3):
            // truncatePostureValue matches the sibling checkCodexModelPosture's
            // convention (see its own `value: truncatePostureValue(model)` above)
            // so an oversized or secret-shaped `sandbox_mode` value can never
            // reach `validate agents --raw` output at full length.
            violations.push({
                agent: agentName,
                file: filePath,
                expected: truncatePostureValue(expected),
                found: truncatePostureValue(found),
            });
        }
    }
    return {
        ok: violations.length === 0,
        violations,
        checked,
        agents_dir: agentsDir,
        agent_runtime: resolvedRuntime,
    };
}
/**
 * Probe a single agents dir for `<name>` across runtime filename variants.
 * Mirrors {@link checkAgentsInstalled}'s probe (`.md`, `.agent.md`, `.toml`,
 * and the kimi `subagents/<name>.{yaml,md}` pair) so the two can never disagree
 * about which on-disk shapes count as "installed". Not exported — internal to
 * {@link resolveAgentHint}.
 */
function agentFileExists(agentsDir, name, runtime) {
    const base = node_path_1.default.join(agentsDir, `${name}.md`);
    const copilot = node_path_1.default.join(agentsDir, `${name}.agent.md`);
    const codex = node_path_1.default.join(agentsDir, `${name}.toml`);
    if (node_fs_1.default.existsSync(base) || node_fs_1.default.existsSync(copilot) || node_fs_1.default.existsSync(codex)) {
        return true;
    }
    // kimi requires BOTH the persona yaml and the prompt md (same as checkAgentsInstalled).
    const kimiYaml = node_path_1.default.join(agentsDir, 'subagents', `${name}.yaml`);
    const kimiPrompt = node_path_1.default.join(agentsDir, 'subagents', `${name}.md`);
    // #5169: descriptor-declared (`hostBehaviors.requiresSubagentPair`); a label
    // that is not a registered runtime declares nothing, so it never requires the pair.
    return (0, runtime_name_policy_cjs_1.hostBehaviorsFor)(runtime).requiresSubagentPair === true
        && node_fs_1.default.existsSync(kimiYaml) && node_fs_1.default.existsSync(kimiPrompt);
}
/**
 * Resolve a per-plan `agent_hint` specialist name to a dispatchable subagent
 * type on the active runtime (#1689). Unlike {@link checkAgentsInstalled},
 * which validates the fixed GSD roster, this answers "does an agent file for
 * this ARBITRARY name exist in the active runtime's agent dir(s)?" — so a plan
 * can opt into a domain specialist (e.g. a Flutter engineer) that shares the
 * gsd-executor contract without being part of the built-in roster.
 *
 * Probes BOTH the runtime-canonical agents dir ({@link getAgentsDir}, which
 * honors `GSD_AGENTS_DIR`, project-local manifest-backed installs, and the
 * claude install-relative path) AND the runtime's global config agents dir, so
 * a specialist installed at either level is recognized. The decision in #1689
 * explicitly requires consulting the active runtime's agent dir rather than
 * only the Claude runtime's user-global and project-local agent dirs.
 *
 * @returns the name when a matching agent file exists; `null` when it does not
 *   (the caller falls back to `gsd-executor`). An empty/whitespace name always
 *   returns `null`.
 */
function resolveAgentHint(name, runtime, projectRoot) {
    const trimmed = String(name ?? '').trim();
    if (trimmed === '')
        return null;
    // A hint is a bare agent name. Reject path separators and `..` so a value
    // like `../../README` cannot path-traverse out of the agents dir via
    // path.join and match an unrelated file — that would echo an invalid
    // subagent_type and block the wave, defeating fail-closed resolution.
    if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..'))
        return null;
    const resolvedRuntime = runtime ?? (process.env['GSD_RUNTIME'] || 'claude');
    const candidateDirs = new Set();
    candidateDirs.add(getAgentsDir(resolvedRuntime, projectRoot));
    candidateDirs.add(node_path_1.default.join((0, runtime_homes_cjs_1.getGlobalConfigDir)(resolvedRuntime), 'agents'));
    for (const dir of candidateDirs) {
        if (agentFileExists(dir, trimmed, resolvedRuntime)) {
            return trimmed;
        }
    }
    return null;
}
module.exports = {
    getAgentsDir,
    checkAgentsInstalled,
    checkCodexModelPosture,
    checkCodexSandboxPosture,
    canonicalAgentSourceDir,
    POSTURE_REASON,
    resolveAgentHint,
};
