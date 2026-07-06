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
 *       Resolves whether the Workflow backend should activate. `--runtime`
 *       defaults to the GSD_RUNTIME env var (or 'unknown'). Reads the
 *       `claude_orchestration.*` keys from .planning/config.json. Emits
 *       { available, backend, reason }.
 *
 *   emit-workflow --waves <path> --run-id <id> [--phase-dir <dir>] [--budget <n>]
 *       Reads a wave/plan manifest JSON file and emits the generated Workflow
 *       script + summary. The manifest shape matches emitWorkflowScript's input:
 *       { waves: [{ id, plans: [{ id, brief, files_modified: string[] }] }] }.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const io = require("./io.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const core = require("./claude-orchestration.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const configLoader = require("./config-loader.cjs");
const { output } = io;
const { detectWorkflowBackend, emitWorkflowScript } = core;
const CAPABLE_HOST = { dispatch: { nested: true, background: true } };
function usage(error) {
    error('Usage: gsd-tools claude-orchestration <detect-backend|emit-workflow> [...]\n' +
        '  detect-backend [--runtime <id>] [--agent-sdk-version <ver>] [--no-nested-dispatch]\n' +
        '  emit-workflow --waves <path> --run-id <id> [--phase-dir <dir>] [--budget <n>]');
}
function argValue(args, flag) {
    const i = args.indexOf(flag);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
}
/**
 * Detect whether the Workflow backend should activate for the current/given
 * runtime. Reads `claude_orchestration.*` from the project config; runtime and
 * SDK version come from flags (the orchestrator already knows these) or env.
 */
function cmdDetectBackend(args, cwd, raw) {
    const runtimeId = argValue(args, '--runtime') || process.env['GSD_RUNTIME'] || 'unknown';
    const agentSdkVersion = argValue(args, '--agent-sdk-version');
    const noNested = args.includes('--no-nested-dispatch');
    const hostIntegration = noNested ? { dispatch: { nested: false, background: true } } : CAPABLE_HOST;
    // Resolve the claude_orchestration.* slice from the project config (federated
    // keys are merged by loadConfig as a nested object). A config read failure
    // degrades to inline — it must not break the core loop.
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
    // Flatten the nested slice into the dotted-key shape detectWorkflowBackend expects.
    const flatConfig = {};
    for (const k of Object.keys(claudeSlice)) {
        flatConfig['claude_orchestration.' + k] = claudeSlice[k];
    }
    const result = detectWorkflowBackend({ runtimeId, hostIntegration, config: flatConfig, agentSdkVersion });
    output(result, raw);
}
/**
 * Emit a Workflow script from a wave/plan manifest file.
 */
function cmdEmitWorkflow(args, _cwd, raw, error) {
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
    let waves;
    try {
        const content = node_fs_1.default.readFileSync(node_path_1.default.resolve(wavesPath), 'utf8');
        const parsed = JSON.parse(content);
        waves = parsed['waves'];
    }
    catch (e) {
        error('emit-workflow: could not read/parse --waves file "' + wavesPath + '": ' + (e instanceof Error ? e.message : String(e)));
        return;
    }
    const budgetTokens = budgetRaw !== undefined ? parseInt(budgetRaw, 10) : undefined;
    const budget = (typeof budgetTokens === 'number' && !Number.isNaN(budgetTokens)) ? budgetTokens : undefined;
    const result = emitWorkflowScript({
        phaseDir,
        runId,
        waves: waves,
        budgetTokens: budget,
    });
    if (!result.ok) {
        error('emit-workflow: ' + result.reason);
        return;
    }
    output({ script: result.script, summary: result.summary }, raw);
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
    else {
        usage(error);
    }
}
module.exports = { routeClaudeOrchestrationCommand };
