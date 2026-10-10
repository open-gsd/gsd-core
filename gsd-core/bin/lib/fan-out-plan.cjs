"use strict";
/**
 * Fan-out plan (#5273, ADR-5273 Decisions 1, 2 and 9).
 *
 * Core's half of the fan-out seam: the plan schema, its validator and the concurrency
 * resolution. It holds NO policy. How a brief is decomposed, how many workers run and which
 * prompt each one gets belong to the capability that declares `fanOutStrategy`; this module
 * only decides whether what that capability returned is a plan core will hand to an executor.
 *
 * A plan is an ordered list of stages with a barrier between consecutive stages. Two shapes
 * exist, one per `loop fan-out-plan --stage`:
 *
 * - `decompose`: one stage holding one `decompose` dispatch.
 * - `fan-out`: a `workers` stage (2..maxWorkers `worker` dispatches plus at most one
 *   `cross-file` dispatch), then a `synthesize` stage holding exactly one `synthesizer`.
 *
 * Every rejection carries a stable reason code, so the caller can degrade to single-agent
 * dispatch loudly (ADR-5273 Decision 6). Nothing here throws on hostile input.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.QUIET_SINGLE_REASONS = exports.EXECUTOR_ONLY_FIELDS = exports.DISPATCH_PURPOSES = exports.FAN_OUT_REASON = exports.FAN_OUT_STAGES = exports.SCOPE_MAX_PATHS = exports.SCHEMA_MAX_BYTES = exports.PROMPT_MAX_BYTES = exports.MAX_WORKERS = exports.MIN_WORKERS = exports.FAN_OUT_WORKER_AGENT = exports.RESERVED_FALLBACK_DISPATCHES = exports.AGENT_BUDGET = void 0;
exports.checkScopePath = checkScopePath;
exports.validateFanOutPlan = validateFanOutPlan;
exports.readStrategySingle = readStrategySingle;
exports.resolveConcurrency = resolveConcurrency;
exports.planFanOut = planFanOut;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const security_cjs_1 = require("./security.cjs");
/** ADR-5273 Decision 2: one role run dispatches at most this many agents, fallback included. */
exports.AGENT_BUDGET = 9;
/** Every role run reserves one dispatch for the loud single-agent fallback. */
exports.RESERVED_FALLBACK_DISPATCHES = 1;
/** The one read-only worker agent a fan-out plan may dispatch besides the step's own agent. */
exports.FAN_OUT_WORKER_AGENT = 'gsd-swarm-worker';
/**
 * Bounds on a plan's declared `maxWorkers`. The ceiling is derived from the budget, not chosen:
 * 9 total, minus the synthesizer, minus the reserved fallback, minus the one extra dispatch each
 * role spends (decomposition for research and pattern-mapping, the cross-file worker for
 * code-review) leaves 6.
 */
exports.MIN_WORKERS = 2;
exports.MAX_WORKERS = exports.AGENT_BUDGET - 1 - exports.RESERVED_FALLBACK_DISPATCHES - 1;
/** Byte bounds on model-bound text a plan carries (ADR-5273 Decision 9). */
exports.PROMPT_MAX_BYTES = 32 * 1024;
exports.SCHEMA_MAX_BYTES = 8 * 1024;
exports.SCOPE_MAX_PATHS = 64;
exports.FAN_OUT_STAGES = Object.freeze(['decompose', 'fan-out']);
/** Closed set of reasons a fan-out degrades to single-agent dispatch at plan time. */
exports.FAN_OUT_REASON = Object.freeze({
    NO_FAN_OUT_TRAIT: 'no_fan_out_trait',
    NO_STRATEGY: 'no_strategy',
    STRATEGY_FAILED: 'strategy_failed',
    PARALLELIZATION_DISABLED: 'parallelization_disabled',
    INVALID_MAX_CONCURRENT_AGENTS: 'invalid_max_concurrent_agents',
    NO_NAMED_DISPATCH: 'no_named_dispatch',
    NO_CONCURRENCY: 'no_concurrency',
    INVALID_PLAN: 'invalid_plan',
    OVER_AGENT_BUDGET: 'over_agent_budget',
    TOO_FEW_UNITS: 'too_few_units',
    AMBIGUOUS_STRATEGY: 'ambiguous_strategy',
});
/** Reasons a strategy may return itself on a `mode: "single"` answer, beyond core's own. */
const STRATEGY_REASON_RE = /^[a-z][a-z0-9_]{0,63}$/;
exports.DISPATCH_PURPOSES = Object.freeze(['decompose', 'worker', 'cross-file', 'synthesizer']);
/**
 * Fields only execute-phase's wave adapter may set (ADR-5273 Decision 1, implementation step 5).
 * A plan returned by a `fanOutStrategy` command carrying any of them is rejected.
 */
exports.EXECUTOR_ONLY_FIELDS = Object.freeze(['isolation', 'worktree_metadata', 'resultContract']);
const PLAN_KEYS = new Set(['mode', 'stage', 'maxWorkers', 'stages']);
const STAGE_KEYS = new Set(['id', 'dispatches']);
const DISPATCH_KEYS = new Set(['purpose', 'agentType', 'model', 'tier', 'prompt', 'schema', 'scope']);
const CONTROL_CHAR = /[\x00-\x1f\x7f\u2028\u2029]/;
function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function byteLength(s) {
    return Buffer.byteLength(s, 'utf8');
}
function describeValue(v) {
    try {
        return JSON.stringify(v) ?? String(v);
    }
    catch {
        return typeof v;
    }
}
function invalid(detail) {
    return { ok: false, reason: exports.FAN_OUT_REASON.INVALID_PLAN, detail };
}
/**
 * ADR-4650 containment for a model-written path, in the two halves `validatePaths`
 * (src/reviewer-step-dispatch.cts) applies: a lexical check, then a realpath check so a symlink
 * whose own path is inside the root cannot point outside it. Stricter than that function in two
 * places, because these paths come from a model rather than from `git diff`: any `..` segment is
 * rejected even when it would resolve inside the root, and a path that does not exist is rejected
 * rather than skipped.
 */
function checkScopePath(projectRoot, p) {
    if (typeof p !== 'string' || p.length === 0)
        return { ok: false, code: 'not_string' };
    if (CONTROL_CHAR.test(p))
        return { ok: false, code: 'control_char' };
    if (node_path_1.default.isAbsolute(p) || node_path_1.default.win32.isAbsolute(p))
        return { ok: false, code: 'absolute' };
    if (p.split(/[\\/]/).includes('..'))
        return { ok: false, code: 'dot_dot' };
    const root = node_path_1.default.resolve(projectRoot);
    if ((0, security_cjs_1.tryWithinRootLexical)(p, root) === null)
        return { ok: false, code: 'escapes_root' };
    let realRoot;
    try {
        realRoot = node_fs_1.default.realpathSync(root);
    }
    catch {
        return { ok: false, code: 'missing' };
    }
    let real;
    try {
        real = node_fs_1.default.realpathSync(node_path_1.default.resolve(root, p));
    }
    catch {
        return { ok: false, code: 'missing' };
    }
    if ((0, security_cjs_1.tryWithinRootLexical)(real, realRoot) === null)
        return { ok: false, code: 'escapes_root' };
    return { ok: true };
}
/** Whose resolved model and tier a dispatch of this purpose must carry (ADR-5273 Decision 9). */
function modelOwner(purpose, stepAgent) {
    return purpose === 'worker' ? exports.FAN_OUT_WORKER_AGENT : stepAgent;
}
function validateDispatch(d, where, ctx) {
    if (!isPlainObject(d))
        return invalid(`${where} is not an object`);
    for (const k of Object.keys(d)) {
        if (exports.EXECUTOR_ONLY_FIELDS.includes(k))
            return invalid(`${where} carries executor-only field ${k}`);
        if (!DISPATCH_KEYS.has(k))
            return invalid(`${where} carries unknown field ${k}`);
    }
    const purpose = d['purpose'];
    if (typeof purpose !== 'string' || !exports.DISPATCH_PURPOSES.includes(purpose)) {
        return invalid(`${where}.purpose is not one of ${exports.DISPATCH_PURPOSES.join(', ')}`);
    }
    const p = purpose;
    const expectedAgent = p === 'synthesizer' ? ctx.stepAgent : exports.FAN_OUT_WORKER_AGENT;
    if (d['agentType'] !== expectedAgent) {
        return invalid(`${where}.agentType must be ${expectedAgent} for a ${p} dispatch`);
    }
    const owner = modelOwner(p, ctx.stepAgent);
    const resolved = ctx.resolveModel(owner);
    if (!resolved || typeof resolved.model !== 'string' || typeof resolved.tier !== 'string') {
        return invalid(`${where}: resolve-model returned nothing for ${owner}`);
    }
    if (d['model'] !== resolved.model || d['tier'] !== resolved.tier) {
        return invalid(`${where}: model/tier differ from resolve-model ${owner}`);
    }
    const prompt = d['prompt'];
    if (typeof prompt !== 'string' || prompt.length === 0)
        return invalid(`${where}.prompt is not a non-empty string`);
    if (byteLength(prompt) > exports.PROMPT_MAX_BYTES)
        return invalid(`${where}.prompt exceeds ${exports.PROMPT_MAX_BYTES} bytes`);
    const schema = d['schema'];
    if (p === 'synthesizer') {
        if (schema !== null && schema !== undefined)
            return invalid(`${where}.schema must be null for the synthesizer`);
    }
    else {
        if (!isPlainObject(schema))
            return invalid(`${where}.schema is not an object`);
        let json;
        try {
            json = JSON.stringify(schema);
        }
        catch {
            return invalid(`${where}.schema is not serializable`);
        }
        if (byteLength(json) > exports.SCHEMA_MAX_BYTES)
            return invalid(`${where}.schema exceeds ${exports.SCHEMA_MAX_BYTES} bytes`);
    }
    const scope = d['scope'];
    const needsScope = p === 'worker' || p === 'cross-file';
    if (needsScope) {
        if (!Array.isArray(scope) || scope.length === 0)
            return invalid(`${where}.scope is not a non-empty array`);
        if (scope.length > exports.SCOPE_MAX_PATHS)
            return invalid(`${where}.scope exceeds ${exports.SCOPE_MAX_PATHS} paths`);
        for (let i = 0; i < scope.length; i++) {
            const r = checkScopePath(ctx.projectRoot, scope[i]);
            if (!r.ok)
                return invalid(`${where}.scope[${i}] rejected: ${r.code}`);
        }
    }
    else if (scope !== undefined) {
        return invalid(`${where}.scope is only allowed on worker and cross-file dispatches`);
    }
    return {
        ok: true,
        dispatch: {
            purpose: p,
            agentType: expectedAgent,
            model: resolved.model,
            tier: resolved.tier,
            prompt,
            schema: p === 'synthesizer' ? null : schema,
            ...(needsScope ? { scope: [...scope] } : {}),
        },
    };
}
function validateStage(s, index, ctx) {
    const where = `stages[${index}]`;
    if (!isPlainObject(s))
        return invalid(`${where} is not an object`);
    for (const k of Object.keys(s)) {
        if (exports.EXECUTOR_ONLY_FIELDS.includes(k))
            return invalid(`${where} carries executor-only field ${k}`);
        if (!STAGE_KEYS.has(k))
            return invalid(`${where} carries unknown field ${k}`);
    }
    if (typeof s['id'] !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(s['id']))
        return invalid(`${where}.id is not a slug`);
    const dispatches = s['dispatches'];
    if (!Array.isArray(dispatches) || dispatches.length === 0)
        return invalid(`${where}.dispatches is not a non-empty array`);
    const out = [];
    for (let i = 0; i < dispatches.length; i++) {
        const r = validateDispatch(dispatches[i], `${where}.dispatches[${i}]`, ctx);
        if (!r.ok)
            return r;
        out.push(r.dispatch);
    }
    return { ok: true, stage: { id: s['id'], dispatches: out } };
}
/**
 * Validate a plan a `fanOutStrategy` command returned. Checks run in a fixed order so each
 * boundary has one verdict: every structural and trust check (`invalid_plan`), then the unit
 * count (`too_few_units`), then the agent budget (`over_agent_budget`).
 */
function validateFanOutPlan(plan, ctx) {
    if (!isPlainObject(plan))
        return invalid('plan is not an object');
    for (const k of Object.keys(plan)) {
        if (exports.EXECUTOR_ONLY_FIELDS.includes(k))
            return invalid(`plan carries executor-only field ${k}`);
        if (!PLAN_KEYS.has(k))
            return invalid(`plan carries unknown field ${k}`);
    }
    if (plan['mode'] !== 'fan-out')
        return invalid('plan.mode is not "fan-out"');
    if (plan['stage'] !== ctx.stage)
        return invalid(`plan.stage is not "${ctx.stage}"`);
    const maxWorkers = plan['maxWorkers'];
    if (typeof maxWorkers !== 'number' || !Number.isInteger(maxWorkers) || maxWorkers < exports.MIN_WORKERS || maxWorkers > exports.MAX_WORKERS) {
        return invalid(`plan.maxWorkers is not an integer in ${exports.MIN_WORKERS}..${exports.MAX_WORKERS}`);
    }
    const rawStages = plan['stages'];
    if (!Array.isArray(rawStages))
        return invalid('plan.stages is not an array');
    const stages = [];
    for (let i = 0; i < rawStages.length; i++) {
        const r = validateStage(rawStages[i], i, ctx);
        if (!r.ok)
            return r;
        stages.push(r.stage);
    }
    const purposesOf = (st) => st.dispatches.map((d) => d.purpose);
    let workerCount = 0;
    if (ctx.stage === 'decompose') {
        if (stages.length !== 1)
            return invalid('a decompose plan has exactly one stage');
        const ps = purposesOf(stages[0]);
        if (ps.length !== 1 || ps[0] !== 'decompose')
            return invalid('a decompose plan holds exactly one decompose dispatch');
    }
    else {
        if (stages.length !== 2)
            return invalid('a fan-out plan has exactly two stages: workers, then synthesize');
        const workerPs = purposesOf(stages[0]);
        if (workerPs.some((x) => x !== 'worker' && x !== 'cross-file'))
            return invalid('stages[0] holds only worker and cross-file dispatches');
        if (workerPs.filter((x) => x === 'cross-file').length > 1)
            return invalid('stages[0] holds at most one cross-file dispatch');
        workerCount = workerPs.filter((x) => x === 'worker').length;
        const synthPs = purposesOf(stages[1]);
        if (synthPs.length !== 1 || synthPs[0] !== 'synthesizer')
            return invalid('stages[1] holds exactly one synthesizer dispatch');
        if (workerCount > maxWorkers)
            return invalid(`plan has ${workerCount} worker units, more than maxWorkers ${maxWorkers}`);
        if (workerCount < exports.MIN_WORKERS) {
            return { ok: false, reason: exports.FAN_OUT_REASON.TOO_FEW_UNITS, detail: `plan has ${workerCount} worker unit(s); at least ${exports.MIN_WORKERS} are needed` };
        }
    }
    const prior = Number.isSafeInteger(ctx.priorDispatches) && ctx.priorDispatches > 0 ? ctx.priorDispatches : 0;
    const dispatches = stages.reduce((n, st) => n + st.dispatches.length, 0);
    const total = prior + dispatches + exports.RESERVED_FALLBACK_DISPATCHES;
    if (total > exports.AGENT_BUDGET) {
        return {
            ok: false,
            reason: exports.FAN_OUT_REASON.OVER_AGENT_BUDGET,
            detail: `${prior} prior + ${dispatches} planned + ${exports.RESERVED_FALLBACK_DISPATCHES} reserved fallback = ${total} > ${exports.AGENT_BUDGET}`,
        };
    }
    return { ok: true, plan: { mode: 'fan-out', stage: ctx.stage, maxWorkers, stages }, dispatches };
}
/** A strategy's quiet or loud refusal: `{ "mode": "single", "reason": "<code>" }`. */
function readStrategySingle(answer) {
    if (!isPlainObject(answer) || answer['mode'] !== 'single')
        return null;
    const reason = answer['reason'];
    return { reason: typeof reason === 'string' && STRATEGY_REASON_RE.test(reason) ? reason : exports.FAN_OUT_REASON.STRATEGY_FAILED };
}
/**
 * ADR-5273 Decision 2: C = min(dispatch-capacity, parallelization.max_concurrent_agents,
 * maxWorkers). An invalid configured value fails closed rather than clamping, and a C below 2
 * cannot fan out at all.
 */
function resolveConcurrency(input) {
    if (!input.maxConcurrentAgents.ok) {
        return {
            ok: false,
            reason: exports.FAN_OUT_REASON.INVALID_MAX_CONCURRENT_AGENTS,
            detail: `parallelization.max_concurrent_agents is ${describeValue(input.maxConcurrentAgents.value)}, not a positive integer`,
        };
    }
    const cap = Number.isSafeInteger(input.dispatchCapacity) && input.dispatchCapacity > 0 ? input.dispatchCapacity : 1;
    const terms = { dispatchCapacity: cap, maxConcurrentAgents: input.maxConcurrentAgents.value, maxWorkers: input.maxWorkers };
    const c = Math.min(terms.dispatchCapacity, terms.maxConcurrentAgents, terms.maxWorkers);
    if (!(c >= 2)) {
        return {
            ok: false,
            reason: exports.FAN_OUT_REASON.NO_CONCURRENCY,
            detail: `C = min(dispatch-capacity ${terms.dispatchCapacity}, max_concurrent_agents ${terms.maxConcurrentAgents}, maxWorkers ${terms.maxWorkers}) = ${c}`,
        };
    }
    return { ok: true, c, terms };
}
/**
 * Reasons that mean "the user did not ask for a fan-out here", so the caller prints nothing
 * (ADR-5273 Decision 6, the two un-loud rungs, plus the two seam-level equivalents: the step did
 * not opt in, or no fan-out capability is installed and active).
 */
exports.QUIET_SINGLE_REASONS = new Set([
    exports.FAN_OUT_REASON.NO_FAN_OUT_TRAIT,
    exports.FAN_OUT_REASON.NO_STRATEGY,
    'disabled',
    'role_not_selected',
]);
function single(reason, detail, strategy) {
    return {
        mode: 'single',
        reason,
        loud: !exports.QUIET_SINGLE_REASONS.has(reason),
        ...(detail !== undefined ? { detail } : {}),
        ...(strategy !== undefined ? { strategy } : {}),
    };
}
/**
 * `gsd_run loop fan-out-plan`, minus argv parsing and I/O. The plan-time ladder of ADR-5273
 * Decision 6 runs in this order, and the first miss wins:
 *
 * 1. the step's `supportsFanOut` trait (quiet), 2. exactly one active strategy (none is quiet),
 * 3. the strategy's own answer (its `disabled` / `role_not_selected` are quiet), 4. the boolean
 * `parallelization`, 5. `parallelization.max_concurrent_agents`, 6. named dispatch, 7. plan
 * validation, 8. C >= 2.
 *
 * Plan validation runs before C because C's third term is the plan's own `maxWorkers`. The
 * strategy runs before the config rungs so a user who never enabled the strategy sees nothing.
 */
function planFanOut(input, deps) {
    const step = deps.resolveStep();
    if (!step.trait)
        return single(exports.FAN_OUT_REASON.NO_FAN_OUT_TRAIT);
    if (step.strategies.length === 0)
        return single(exports.FAN_OUT_REASON.NO_STRATEGY);
    if (step.strategies.length > 1) {
        return single(exports.FAN_OUT_REASON.AMBIGUOUS_STRATEGY, `active strategies: ${step.strategies.map((x) => x.capId).sort().join(', ')}`);
    }
    const strategy = step.strategies[0];
    const invoked = deps.invokeStrategy(strategy);
    if (!invoked.ok)
        return single(exports.FAN_OUT_REASON.STRATEGY_FAILED, invoked.detail, strategy);
    const declined = readStrategySingle(invoked.answer);
    if (declined)
        return single(declined.reason, undefined, strategy);
    if (!deps.parallelizationEnabled())
        return single(exports.FAN_OUT_REASON.PARALLELIZATION_DISABLED, undefined, strategy);
    const mca = deps.maxConcurrentAgents();
    if (!mca.ok) {
        return single(exports.FAN_OUT_REASON.INVALID_MAX_CONCURRENT_AGENTS, `parallelization.max_concurrent_agents is ${describeValue(mca.value)}, not a positive integer`, strategy);
    }
    if (!deps.namedDispatch())
        return single(exports.FAN_OUT_REASON.NO_NAMED_DISPATCH, undefined, strategy);
    const validated = validateFanOutPlan(invoked.answer, {
        stage: input.stage,
        stepAgent: input.stepAgent,
        resolveModel: deps.resolveModel,
        projectRoot: input.projectRoot,
        priorDispatches: input.decomposed ? 1 : 0,
    });
    if (!validated.ok)
        return single(validated.reason, validated.detail, strategy);
    const cap = deps.dispatchCapacity();
    const conc = resolveConcurrency({ dispatchCapacity: cap.capacity, maxConcurrentAgents: mca, maxWorkers: validated.plan.maxWorkers });
    if (!conc.ok)
        return single(conc.reason, `${conc.detail} (dispatch-capacity source ${cap.source}, reason ${cap.reason})`, strategy);
    return {
        mode: 'fan-out',
        stage: input.stage,
        strategy,
        plan: validated.plan,
        dispatches: validated.dispatches,
        reservedFallback: exports.RESERVED_FALLBACK_DISPATCHES,
        concurrency: { c: conc.c, terms: conc.terms, capacitySource: cap.source, capacityReason: cap.reason },
    };
}
