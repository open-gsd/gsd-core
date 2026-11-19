"use strict";
/**
 * `check predicate` as a gate module (#5139, epic #5056, ADR-5057 §4 first bullet): generic
 * evaluator for capability gate `check.predicate` blocks (#2008). It returns a `GateResult`; the
 * command router formats it. Imports no io module and performs no direct console/stdout/stderr
 * write (ESLint-enforced).
 *
 * The workflow gate-dispatch invokes this for any gate whose `check` carries a `predicate` (instead
 * of a `query`); the predicate object is passed as `--predicate '<json>'`. The standard `{ block,
 * message, details? }` gate contract is the payload. A malformed predicate / unknown kind THROWS
 * inside the evaluator and is mapped here to a `usage` failure (non-zero exit at the router), which
 * the workflow's two-step gate contract treats as a step-1 command failure routed per the gate's
 * `onError`.
 *
 * Invocation (argv after the verb):
 *   --predicate '<json>' [--phase-dir <dir>] [--phase-number <n>] [--phase-req-ids <ids>]
 *
 * The subprocess runs at the runtime project root (`projectDir`), inheriting the process env.
 * Interpolation placeholders ${PHASE_NUMBER}/${PHASE_DIR}/${PHASE_REQ_IDS} are substituted from the
 * flags.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildPredicateDeps = buildPredicateDeps;
exports.evaluateCheckPredicate = evaluateCheckPredicate;
const node_path_1 = __importDefault(require("node:path"));
const gate_verdict_cjs_1 = require("./gate-verdict.cjs");
const gate_evidence_cjs_1 = require("./gate-evidence.cjs");
const gate_phase_context_cjs_1 = require("./gate-phase-context.cjs");
const gate_args_cjs_1 = require("./gate-args.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const frontmatterMod = require("./frontmatter.cjs");
const { extractFrontmatter } = frontmatterMod;
const security_cjs_1 = require("./security.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const gatePredicateEval = require("./gate-predicate-evaluator.cjs");
const { evaluatePredicate } = gatePredicateEval;
const shell_command_projection_cjs_1 = require("./shell-command-projection.cjs");
/**
 * Production subprocess binding for the gate-predicate evaluator. Wraps the
 * bounded `execTool` seam (shell-command-projection) as a `runBoundedShell`
 * the pure evaluator consumes. `sh -c` runs the interpolated command; the
 * subprocess inherits the process env and is killed (SIGTERM) on timeout.
 *
 * `timedOut` is derived from the kill signal: spawnSync sets `signal: 'SIGTERM'`
 * when the `timeout` fires, distinct from a normal non-zero exit code. A command
 * that self-terminates with SIGTERM is indistinguishable at this seam and is
 * reported as a timeout — either way the gate blocks (non-zero), so the outcome
 * is fail-closed and correct. See ADR-2008.
 */
function buildPredicateDeps() {
    return {
        runBoundedShell(opts) {
            const r = (0, shell_command_projection_cjs_1.execTool)('sh', ['-c', opts.command], { cwd: opts.cwd, timeout: opts.timeoutMs });
            return {
                exitCode: r.exitCode,
                stdout: r.stdout,
                stderr: r.stderr,
                signal: r.signal,
                timedOut: r.timedOut,
            };
        },
        findPhaseArtifact(phaseDir, artifactSuffix) {
            // #5170 (ADR-5057 §4): an ABSENT directory or artifact is `none` (the artifact is not there);
            // one that exists but cannot be examined is `unreadable` and THROWS — `evaluateCheckPredicate`
            // maps a throw to the usage failure the dispatch contract routes by `onError`. It is never
            // folded into "artifact not found", which a predicate may read as a clean answer.
            const unreadable = (target, reason) => {
                throw new Error(`predicate artifact could not be examined: ${target} (${reason})`);
            };
            const regularFileOrNull = (candidate) => {
                const st = (0, gate_evidence_cjs_1.statEvidence)(candidate);
                if (st.kind === 'unreadable')
                    return unreadable(candidate, st.reason);
                return st.kind === 'found' && st.value.isFile() ? candidate : null;
            };
            const phaseDirStat = (0, gate_evidence_cjs_1.statEvidence)(phaseDir);
            if (phaseDirStat.kind === 'unreadable')
                return unreadable(phaseDir, phaseDirStat.reason);
            if (phaseDirStat.kind === 'none')
                return [];
            if (artifactSuffix === '.' ||
                artifactSuffix === '..' ||
                artifactSuffix.includes('\0') ||
                node_path_1.default.basename(artifactSuffix) !== artifactSuffix ||
                node_path_1.default.win32.basename(artifactSuffix) !== artifactSuffix) {
                return [];
            }
            // #5313: collect EVERY distinct match; the evaluator fails closed on >1 instead of trusting listing order.
            const found = [];
            const planningContained = (0, security_cjs_1.tryWithinRoot)(node_path_1.default.join('.planning', artifactSuffix), phaseDir);
            if (planningContained !== null) {
                const planning = regularFileOrNull(planningContained);
                if (planning !== null)
                    found.push(planning);
            }
            const listing = (0, gate_evidence_cjs_1.readDirEvidence)(phaseDir);
            if (listing.kind === 'unreadable')
                return unreadable(phaseDir, listing.reason);
            if (listing.kind === 'none')
                return [];
            for (const f of listing.value) {
                if (f.endsWith('-' + artifactSuffix) || f === artifactSuffix) {
                    const candidateContained = (0, security_cjs_1.tryWithinRoot)(f, phaseDir);
                    if (candidateContained === null)
                        continue;
                    const candidate = regularFileOrNull(candidateContained);
                    if (candidate !== null)
                        found.push(candidate);
                }
            }
            return found;
        },
        readFrontmatter(filePath) {
            const content = (0, shell_command_projection_cjs_1.platformReadSync)(filePath);
            if (content === null)
                throw new Error(`predicate artifact disappeared before it could be read: ${filePath}`);
            const parsed = extractFrontmatter(content, filePath);
            return parsed;
        },
    };
}
function evaluateCheckPredicate(input) {
    const { projectDir } = input;
    const flags = (0, gate_args_cjs_1.parsePredicateFlags)(input.args);
    const predicateJson = flags['predicate'];
    if (!predicateJson) {
        return (0, gate_verdict_cjs_1.gateUsageFailure)(gate_verdict_cjs_1.GATE_FAILURE_CODE.SDK_MISSING_ARG, 'predicate requires --predicate <json> (the gate hook check.predicate object)');
    }
    let predicate;
    try {
        predicate = JSON.parse(predicateJson);
    }
    catch {
        return (0, gate_verdict_cjs_1.gateUsageFailure)(gate_verdict_cjs_1.GATE_FAILURE_CODE.USAGE, 'predicate --predicate value must be valid JSON');
    }
    const rawPhaseDir = flags['phase-dir'];
    let resolvedPhaseDir = rawPhaseDir;
    if (typeof rawPhaseDir === 'string' && rawPhaseDir !== '') {
        const resolved = (0, gate_phase_context_cjs_1.resolveContainedPath)(rawPhaseDir, projectDir);
        if ((0, gate_verdict_cjs_1.isGateUsageFailure)(resolved))
            return resolved;
        resolvedPhaseDir = resolved;
    }
    const ctx = {
        cwd: projectDir,
        phaseNumber: flags['phase-number'],
        phaseDir: resolvedPhaseDir,
        phaseReqIds: flags['phase-req-ids'],
    };
    let result;
    try {
        result = evaluatePredicate(predicate, ctx, buildPredicateDeps());
    }
    catch (e) {
        return (0, gate_verdict_cjs_1.gateUsageFailure)(gate_verdict_cjs_1.GATE_FAILURE_CODE.USAGE, `gate predicate evaluation failed: ${e.message}`);
    }
    return (0, gate_verdict_cjs_1.gateVerdict)(result.block ? 'block' : 'pass', result.block === true, { ...result });
}
