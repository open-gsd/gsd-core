"use strict";
/**
 * Claude orchestration command router — CLI dispatcher for
 * `gsd-tools claude-orchestration <subcommand>`.
 *
 * #1143 — thin CLI adapter over the pure `claude-orchestration.cjs` module.
 * Lets execute-phase (or any orchestrator) invoke the Workflow-backend
 * detection and the Workflow-script emitter through the standard capability
 * command surface (ADR-959) instead of a bare `require()`.
 *
 * Router signature: { args, cwd, raw, error } — identical to the other host
 * routers; discovered by dispatchCapabilityCommand via the registry's
 * commandFamilies index.
 *
 * Subcommands:
 *   detect-backend [--runtime <id>] [--agent-sdk-version <ver>] [--no-nested-dispatch]
 *       Resolves whether the Workflow backend should activate. `--runtime` is
 *       OPTIONAL (#2590): it falls back to the canonical
 *       `GSD_RUNTIME > config.runtime > 'claude'` chain. `--agent-sdk-version`
 *       (and GSD_AGENT_SDK_VERSION) is accepted and ignored — deprecated, #4747.
 *       Reads the `claude_orchestration.*` keys from .planning/config.json and
 *       Claude Code's workflow kill switches: the CLAUDE_CODE_DISABLE_WORKFLOWS
 *       env var and `disableWorkflows` / `enableWorkflows` in managed, project
 *       local, project and user settings files. Emits { available, backend, reason }.
 *
 *   emit-workflow --waves <path> --run-id <id> [--phase-dir <dir>] [--budget <n>] [--executor-model <id>]
 *       Reads a wave/plan manifest JSON file and emits the generated Workflow
 *       script + summary. The manifest shape matches emitWorkflowScript's input:
 *       { waves: [{ id, plans: [{ id, brief, files_modified: string[], use_worktree?: boolean }] }] }.
 *       `use_worktree` defaults to true; pass `false` for a plan the inline path
 *       (execute-phase.md step 2.5) would also keep out of worktree isolation
 *       (submodule-touching plans — #2772 / #2285 finding 1).
 *
 *   resolve-wave-dispatch --waves <path> --run-id <id> [--runtime <id>]
 *       [--agent-sdk-version <ignored, deprecated>] [--no-nested-dispatch] [--phase-dir <dir>]
 *       [--budget <n>] [--executor-model <id>]
 *       #2285 — the single composed seam a PRE-wave dispatch-backend selector
 *       (`execute:wave:pre`) uses: resolves detect-backend + emit-workflow in
 *       ONE call. Emits { backend: 'inline'|'workflow', reason, script?, summary? }.
 *       Fail-closed identically to detect-backend/emit-workflow individually —
 *       any gate miss, or an emit failure on a malformed --waves manifest,
 *       resolves to 'inline' with no script.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const io = require("./io.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const core = require("./claude-orchestration.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const configLoader = require("./config-loader.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const runtimeSlash = require("./runtime-slash.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- model-resolver.cjs is an export= CommonJS module
const modelResolver = require("./model-resolver.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const shellProjection = require("./shell-command-projection.cjs");
const { output } = io;
const { detectWorkflowBackend, emitWorkflowScript, resolveWaveDispatch } = core;
const CAPABLE_HOST = { dispatch: { nested: true, background: true } };
function usage(error) {
    error('Usage: gsd-tools claude-orchestration <detect-backend|emit-workflow|resolve-wave-dispatch> [...]\n' +
        '  detect-backend [--runtime <id>] [--no-nested-dispatch]\n' +
        '  emit-workflow --waves <path> --run-id <id> [--phase-dir <dir>] [--budget <n>] [--executor-model <id>]\n' +
        '  resolve-wave-dispatch --waves <path> --run-id <id> [--runtime <id>] [--no-nested-dispatch] [--phase-dir <dir>] [--budget <n>] [--executor-model <id>]');
}
function argValue(args, flag) {
    const i = args.indexOf(flag);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
}
/**
 * Resolve the `claude_orchestration.*` config slice from the project config
 * (federated keys are merged by loadConfig as a nested object), flattened into
 * the dotted-key shape `detectWorkflowBackend`/`resolveWaveDispatch` expect. A
 * config read failure degrades to an empty slice — it must not break the core
 * loop. Shared by `detect-backend` and `resolve-wave-dispatch`.
 */
function resolveFlatClaudeOrchestrationConfig(cwd) {
    let claudeSlice = {};
    try {
        const loaded = configLoader.loadConfig(cwd);
        const slice = loaded['claude_orchestration'];
        if (slice && typeof slice === 'object' && !Array.isArray(slice)) {
            claudeSlice = slice;
        }
    }
    catch {
        claudeSlice = {};
    }
    const flatConfig = {};
    for (const k of Object.keys(claudeSlice)) {
        flatConfig['claude_orchestration.' + k] = claudeSlice[k];
    }
    return flatConfig;
}
/**
 * Documented managed-settings directory per platform (#4747;
 * code.claude.com/docs/en/managed-settings). Any non-darwin, non-win32 platform
 * uses the Linux/WSL path.
 */
function managedSettingsDir(platform) {
    if (platform === 'darwin')
        return '/Library/Application Support/ClaudeCode';
    if (platform === 'win32')
        return ['C:', 'Program Files', 'ClaudeCode'].join(node_path_1.default.win32.sep);
    return '/etc/claude-code';
}
// #4747: a repo-controlled .claude/settings*.json must not hang or exhaust the CLI.
const MAX_SETTINGS_FILE_BYTES = 1024 * 1024;
/**
 * Read one JSON settings file. Missing (ENOENT/ENOTDIR) is `absent`; any other
 * read error, invalid JSON, or a non-object root is `unreadable` (fail-closed).
 */
function readJsonObjectFile(p) {
    let text;
    try {
        const st = node_fs_1.default.statSync(p);
        if (!st.isFile() || st.size > MAX_SETTINGS_FILE_BYTES)
            return { status: 'unreadable' };
        text = node_fs_1.default.readFileSync(p, 'utf8');
    }
    catch (e) {
        const code = e?.code;
        return code === 'ENOENT' || code === 'ENOTDIR' ? { status: 'absent' } : { status: 'unreadable' };
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return { status: 'unreadable' };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { status: 'unreadable' };
    }
    return { status: 'ok', settings: parsed };
}
function readManagedSource(dir) {
    try {
        const base = readJsonObjectFile(node_path_1.default.join(dir, 'managed-settings.json'));
        const dropInDir = node_path_1.default.join(dir, 'managed-settings.d');
        let names = [];
        try {
            names = node_fs_1.default.readdirSync(dropInDir);
        }
        catch (e) {
            const code = e?.code;
            if (code !== 'ENOENT' && code !== 'ENOTDIR')
                return { scope: 'managed', status: 'unreadable' };
        }
        const dropIns = names.filter((n) => !n.startsWith('.') && n.endsWith('.json')).sort()
            .map((n) => readJsonObjectFile(node_path_1.default.join(dropInDir, n)));
        if (base.status === 'unreadable' || dropIns.some((d) => d.status === 'unreadable')) {
            return { scope: 'managed', status: 'unreadable' };
        }
        const layers = [];
        if (base.status === 'ok')
            layers.push(base.settings);
        for (const d of dropIns) {
            if (d.status === 'ok')
                layers.push(d.settings);
        }
        if (layers.length === 0)
            return { scope: 'managed', status: 'absent' };
        return { scope: 'managed', status: 'ok', settings: Object.assign({}, ...layers) };
    }
    catch {
        return { scope: 'managed', status: 'unreadable' };
    }
}
/**
 * Read the settings files that can carry Claude Code's workflow kill switches
 * (#4747). Returns exactly four sources, precedence-ordered highest first:
 * managed, projectLocal, project, user. `--settings` and non-file managed
 * sources are not observable. No subprocesses; never throws.
 */
function readWorkflowSettingsSources(opts) {
    const fileSource = (scope, p) => {
        try {
            const r = readJsonObjectFile(p);
            return r.status === 'ok' ? { scope, status: 'ok', settings: r.settings } : { scope, status: r.status };
        }
        catch {
            return { scope, status: 'unreadable' };
        }
    };
    const managedDir = opts.managedDir ?? managedSettingsDir(opts.platform ?? process.platform);
    const configDir = opts.env ? shellProjection.envGet(opts.env, 'CLAUDE_CONFIG_DIR') : undefined;
    let user;
    if (typeof configDir === 'string' && configDir.length > 0) {
        user = fileSource('user', node_path_1.default.join(configDir, 'settings.json'));
    }
    else if (typeof opts.homedir === 'string' && opts.homedir.length > 0) {
        user = fileSource('user', node_path_1.default.join(opts.homedir, '.claude', 'settings.json'));
    }
    else {
        user = { scope: 'user', status: 'unreadable' };
    }
    return [
        readManagedSource(managedDir),
        fileSource('projectLocal', node_path_1.default.join(opts.cwd, '.claude', 'settings.local.json')),
        fileSource('project', node_path_1.default.join(opts.cwd, '.claude', 'settings.json')),
        user,
    ];
}
/**
 * Resolve `--runtime`/`--no-nested-dispatch` and the Claude Code workflow kill
 * switches into the `{ runtimeId, hostIntegration, workflowAvailability }` triple
 * both `detect-backend` and `resolve-wave-dispatch` pass to the pure detection
 * seam. `--agent-sdk-version` / GSD_AGENT_SDK_VERSION are ignored (#4747).
 */
function resolveDetectionArgs(args, cwd) {
    // #2590: the old fallback chain was `--runtime > GSD_RUNTIME > 'unknown'`,
    // diverging from the canonical `GSD_RUNTIME > config.runtime > 'claude'` used
    // by runtime-slash.resolveRuntime — so ANY manual invocation without
    // --runtime reported `runtime_not_claude` on a perfectly ordinary Claude
    // project. Delegate to the canonical resolver instead of re-deriving it.
    const runtimeId = argValue(args, '--runtime') || runtimeSlash.resolveRuntime(cwd || null);
    let home;
    try {
        home = node_os_1.default.homedir();
    }
    catch {
        home = undefined;
    }
    // Test-only seam so CLI tests do not read the host's real managed settings; ignored outside GSD_TEST_MODE.
    const injectedManagedDir = process.env['GSD_TEST_MODE'] === '1'
        ? shellProjection.envGet(process.env, 'GSD_TEST_MANAGED_SETTINGS_DIR')
        : undefined;
    const testManagedDir = typeof injectedManagedDir === 'string' && injectedManagedDir.length > 0 ? injectedManagedDir : undefined;
    const workflowAvailability = core.resolveWorkflowAvailability({
        env: { CLAUDE_CODE_DISABLE_WORKFLOWS: shellProjection.envGet(process.env, 'CLAUDE_CODE_DISABLE_WORKFLOWS') },
        sources: readWorkflowSettingsSources({ cwd: cwd || process.cwd(), env: process.env, platform: process.platform, homedir: home, ...(testManagedDir ? { managedDir: testManagedDir } : {}) }),
    });
    const noNested = args.includes('--no-nested-dispatch');
    const hostIntegration = noNested ? { dispatch: { nested: false, background: true } } : CAPABLE_HOST;
    return { runtimeId, hostIntegration, workflowAvailability };
}
/**
 * #2686 — resolve the `gsd-executor` model this dispatch should carry.
 *
 * Defaults from the project config rather than requiring a flag. The Workflow
 * backend previously emitted no model at all, so `model_overrides` /
 * `model_policy` / `model_profile` were silently inert on that path while the
 * inline path honored them. Reading the same source the inline path reads is
 * what makes the two backends agree by construction: an orchestrator that never
 * learns about a new flag would otherwise silently keep the old bug.
 *
 * `--executor-model` exists only to pin/override. Resolution is side-effect-free
 * and fails closed to `undefined` (emission then omits the key, i.e. exactly the
 * pre-#2686 output) rather than guessing a model.
 */
function resolveExecutorModel(args, cwd) {
    const pinned = argValue(args, '--executor-model');
    if (pinned !== undefined)
        return pinned;
    try {
        const resolved = modelResolver.resolveModelInternal(cwd, 'gsd-executor');
        return typeof resolved === 'string' ? resolved : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Read and parse a `--waves <path>` manifest file.
 *
 * #2285 finding 2: a real read/parse failure (`ok:false`) is DISTINCT from a
 * manifest that parsed fine but has no top-level `waves` key (`ok:true, waves:
 * undefined`) — collapsing both into the same sentinel made the missing-key
 * case exit 0 with ZERO output (fail-silent), breaking the "exit 0 => parseable
 * JSON verdict" contract callers rely on. Only the `ok:false` (read/parse threw)
 * case calls `error(...)` and should short-circuit the caller; `ok:true` with a
 * missing/malformed `waves` value must flow through to `emitWorkflowScript`'s
 * own validation (matching how `{"waves": null}` already behaves) so the caller
 * emits an explicit, non-empty verdict instead of silently doing nothing.
 */
function readWavesManifest(wavesPath, error) {
    try {
        const content = node_fs_1.default.readFileSync(node_path_1.default.resolve(wavesPath), 'utf8');
        const parsed = JSON.parse(content);
        return { ok: true, waves: parsed['waves'] };
    }
    catch (e) {
        error('could not read/parse --waves file "' + wavesPath + '": ' + (e instanceof Error ? e.message : String(e)));
        return { ok: false };
    }
}
/**
 * Detect whether the Workflow backend should activate for the current/given
 * runtime. Reads `claude_orchestration.*` from the project config; runtime and
 * SDK version come from flags (the orchestrator already knows these) or env.
 */
function cmdDetectBackend(args, cwd, raw) {
    const { runtimeId, hostIntegration, workflowAvailability } = resolveDetectionArgs(args, cwd);
    const flatConfig = resolveFlatClaudeOrchestrationConfig(cwd);
    const result = detectWorkflowBackend({ runtimeId, hostIntegration, config: flatConfig, workflowAvailability });
    output(result, raw);
}
/**
 * Emit a Workflow script from a wave/plan manifest file.
 */
function cmdEmitWorkflow(args, cwd, raw, error) {
    const wavesPath = argValue(args, '--waves');
    const runId = argValue(args, '--run-id');
    const phaseDir = argValue(args, '--phase-dir') || '.planning/phases/current';
    const budgetRaw = argValue(args, '--budget');
    if (!wavesPath) {
        error('emit-workflow requires --waves <path>');
        return;
    }
    if (!runId) {
        error('emit-workflow requires --run-id <id>');
        return;
    }
    const read = readWavesManifest(wavesPath, (msg) => error('emit-workflow: ' + msg));
    if (!read.ok)
        return; // read/parse failure — error() already surfaced it loudly above
    const budgetTokens = budgetRaw !== undefined ? parseInt(budgetRaw, 10) : undefined;
    const budget = (typeof budgetTokens === 'number' && !Number.isNaN(budgetTokens)) ? budgetTokens : undefined;
    const result = emitWorkflowScript({
        phaseDir,
        runId,
        waves: read.waves,
        budgetTokens: budget,
        executorModel: resolveExecutorModel(args, cwd),
    });
    if (!result.ok) {
        error('emit-workflow: ' + result.reason);
        return;
    }
    output({ script: result.script, summary: result.summary }, raw);
}
/**
 * #2285 — the single composed seam a PRE-wave dispatch-backend selector
 * (`execute:wave:pre`) uses: resolves `detect-backend` + `emit-workflow` in
 * ONE call via `resolveWaveDispatch`. Emits
 * `{ backend: 'inline'|'workflow', reason, script?, summary? }`.
 */
function cmdResolveWaveDispatch(args, cwd, raw, error) {
    const wavesPath = argValue(args, '--waves');
    const runId = argValue(args, '--run-id');
    const phaseDir = argValue(args, '--phase-dir') || '.planning/phases/current';
    const budgetRaw = argValue(args, '--budget');
    if (!wavesPath) {
        error('resolve-wave-dispatch requires --waves <path>');
        return;
    }
    if (!runId) {
        error('resolve-wave-dispatch requires --run-id <id>');
        return;
    }
    const read = readWavesManifest(wavesPath, (msg) => error('resolve-wave-dispatch: ' + msg));
    if (!read.ok)
        return; // read/parse failure — error() already surfaced it loudly above
    const { runtimeId, hostIntegration, workflowAvailability } = resolveDetectionArgs(args, cwd);
    const flatConfig = resolveFlatClaudeOrchestrationConfig(cwd);
    const budgetTokens = budgetRaw !== undefined ? parseInt(budgetRaw, 10) : undefined;
    const budget = (typeof budgetTokens === 'number' && !Number.isNaN(budgetTokens)) ? budgetTokens : undefined;
    const result = resolveWaveDispatch({
        runtimeId,
        hostIntegration,
        config: flatConfig,
        workflowAvailability,
        phaseDir,
        runId,
        waves: read.waves,
        budgetTokens: budget,
        executorModel: resolveExecutorModel(args, cwd),
    });
    output(result, raw);
}
function routeClaudeOrchestrationCommand(opts) {
    const { args, cwd, raw, error } = opts;
    // args[0] is the family ('claude-orchestration'); the subcommand is args[1].
    const subcommand = args[1];
    if (subcommand === 'detect-backend') {
        cmdDetectBackend(args, cwd, raw);
    }
    else if (subcommand === 'emit-workflow') {
        cmdEmitWorkflow(args, cwd, raw, error);
    }
    else if (subcommand === 'resolve-wave-dispatch') {
        cmdResolveWaveDispatch(args, cwd, raw, error);
    }
    else {
        usage(error);
    }
}
module.exports = { routeClaudeOrchestrationCommand, readWorkflowSettingsSources, managedSettingsDir };
