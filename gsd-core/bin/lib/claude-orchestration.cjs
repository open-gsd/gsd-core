"use strict";
/**
 * Claude Orchestration Policy - issue #1143.
 *
 * Pure policy for selecting the Claude Code execution backend and refusing
 * known-unsafe manual dispatch modes. The module is intentionally small:
 * capability registration owns activation, and the host loop consumes the
 * blocking preflight through the generic gate contract.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveClaudeOrchestrationStatus = resolveClaudeOrchestrationStatus;
exports.cmdClaudeOrchestrationStatus = cmdClaudeOrchestrationStatus;
exports.cmdClaudeOrchestrationPreflight = cmdClaudeOrchestrationPreflight;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ioMod = require("./io.cjs");
const { output } = ioMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const configLoader = require("./config-loader.cjs");
const { loadConfig } = configLoader;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const planningWorkspace = require("./planning-workspace.cjs");
const { planningDir } = planningWorkspace;
const teams_status_cjs_1 = require("./teams-status.cjs");
const VALID_BACKENDS = new Set(['auto', 'inline', 'workflow']);
function strictEnvFlag(env, key) {
    const raw = (env[key] ?? '').trim().toLowerCase();
    return raw === '1' || raw === 'true';
}
function strictBoolean(value, fallback = false) {
    if (typeof value === 'boolean')
        return value;
    if (typeof value === 'string') {
        const raw = value.trim().toLowerCase();
        if (raw === 'true' || raw === '1')
            return true;
        if (raw === 'false' || raw === '0' || raw === '')
            return false;
    }
    return fallback;
}
function configValue(config, dottedKey) {
    if (!config)
        return undefined;
    if (Object.prototype.hasOwnProperty.call(config, dottedKey))
        return config[dottedKey];
    const parts = dottedKey.split('.');
    let current = config;
    for (const part of parts) {
        if (!current || typeof current !== 'object' || Array.isArray(current))
            return undefined;
        current = current[part];
    }
    return current;
}
function describeInvalidConfigValue(value) {
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number'
        || typeof value === 'boolean'
        || typeof value === 'bigint'
        || typeof value === 'symbol') {
        return value.toString();
    }
    try {
        const json = JSON.stringify(value);
        if (json !== undefined)
            return json;
    }
    catch { /* fall through to generic tag */ }
    return Object.prototype.toString.call(value);
}
function requestedBackend(config) {
    const raw = configValue(config, 'workflow.claude_orchestration_backend');
    if (raw === undefined || raw === null)
        return { backend: 'auto', invalidRaw: null };
    if (typeof raw !== 'string')
        return { backend: 'auto', invalidRaw: describeInvalidConfigValue(raw) };
    const normalized = raw.trim().toLowerCase();
    if (VALID_BACKENDS.has(normalized)) {
        return { backend: normalized, invalidRaw: null };
    }
    return { backend: 'auto', invalidRaw: raw };
}
function validateRawProjectConfig(cwd) {
    const configPath = node_path_1.default.join(planningDir(cwd), 'config.json');
    if (!node_fs_1.default.existsSync(configPath))
        return null;
    let parsed;
    try {
        parsed = JSON.parse(node_fs_1.default.readFileSync(configPath, 'utf-8'));
    }
    catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return {
            reason: 'config-read-failed',
            message: `Claude orchestration cannot read .planning/config.json (${detail}); fix the config before executing waves.`,
        };
    }
    const backend = requestedBackend(parsed);
    if (backend.invalidRaw !== null) {
        return {
            reason: 'invalid-backend',
            message: `workflow.claude_orchestration_backend must be one of auto, inline, or workflow; got ${JSON.stringify(backend.invalidRaw)}.`,
        };
    }
    return null;
}
function readProjectConfig(cwd) {
    const rawError = validateRawProjectConfig(cwd);
    if (rawError)
        return { config: {}, error: rawError };
    try {
        return { config: loadConfig(cwd), error: null };
    }
    catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return {
            config: {},
            error: {
                reason: 'config-read-failed',
                message: `Claude orchestration cannot load project config (${detail}); fix the config before executing waves.`,
            },
        };
    }
}
/**
 * Resolve Claude orchestration readiness from injected runtime, env, and config.
 * This function is pure: no process.env, filesystem, or subprocess reads.
 */
function resolveClaudeOrchestrationStatus(opts) {
    const runtime = (opts.runtime || 'claude').trim().toLowerCase();
    const enabled = strictBoolean(configValue(opts.config, 'workflow.claude_orchestration'), false);
    const backendSelection = requestedBackend(opts.config);
    const backend = backendSelection.backend;
    const workflowsDisabled = strictEnvFlag(opts.env, 'CLAUDE_CODE_DISABLE_WORKFLOWS');
    const workflowAvailable = runtime === 'claude' && !workflowsDisabled;
    const teams = (0, teams_status_cjs_1.resolveTeamsStatus)({ runtime, env: opts.env });
    const teamsActive = teams.active;
    const manualDispatchSafe = !teamsActive;
    const selectedBackend = 'inline';
    let block = false;
    let reason = 'disabled';
    let message = 'Claude orchestration capability is disabled.';
    let configError = opts.configError?.message ?? null;
    if (opts.configError) {
        block = true;
        reason = opts.configError.reason;
        message = opts.configError.message;
    }
    else if (backendSelection.invalidRaw !== null) {
        block = true;
        configError = `Invalid workflow.claude_orchestration_backend: ${JSON.stringify(backendSelection.invalidRaw)}`;
        reason = 'invalid-backend';
        message = 'workflow.claude_orchestration_backend must be one of auto, inline, or workflow.';
    }
    else if (!enabled) {
        reason = 'disabled';
    }
    else if (runtime !== 'claude') {
        reason = 'non-claude-runtime';
        message = `Claude orchestration is enabled but runtime is "${runtime}"; skipping Claude-only backend selection.`;
    }
    else if (backend === 'workflow') {
        block = true;
        reason = 'workflow-backend-unavailable';
        message = workflowsDisabled
            ? 'Claude orchestration workflow backend was requested, but workflows are disabled in this environment.'
            : 'Claude orchestration workflow backend is reserved until the generated Workflow executor is implemented; use auto or inline for the current preflight slice.';
    }
    else if (selectedBackend === 'inline' && !manualDispatchSafe) {
        block = true;
        reason = 'manual-dispatch-unsafe-with-agent-teams';
        message = 'Claude manual background-agent dispatch is unsafe while Claude Code agent teams are active; disable agent teams or disable this capability before executing waves.';
    }
    else {
        reason = 'inline-ready';
        message = 'Claude orchestration will use inline executor dispatch.';
    }
    return {
        enabled,
        active: enabled && runtime === 'claude',
        runtime,
        requested_backend: backend,
        selected_backend: selectedBackend,
        workflow_available: workflowAvailable,
        workflows_disabled: workflowsDisabled,
        teams_active: teamsActive,
        manual_dispatch_safe: manualDispatchSafe,
        config_error: configError,
        block,
        passed: !block,
        reason,
        message,
    };
}
function resolveFromProject(cwd) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const runtimeSlash = require('./runtime-slash.cjs');
    const projectConfig = readProjectConfig(cwd);
    return resolveClaudeOrchestrationStatus({
        runtime: runtimeSlash.resolveRuntime(cwd),
        env: process.env,
        config: projectConfig.config,
        configError: projectConfig.error,
    });
}
function cmdClaudeOrchestrationStatus(cwd, raw) {
    output(resolveFromProject(cwd), raw, undefined);
}
function cmdClaudeOrchestrationPreflight(cwd, raw) {
    output(resolveFromProject(cwd), raw, undefined);
}
