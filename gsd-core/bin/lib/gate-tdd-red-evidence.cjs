"use strict";
/**
 * `check tdd-red-evidence` as a gate module (#5139, epic #5056, ADR-5057 §4 first bullet, #3770):
 * it returns a `GateResult`; the command router formats it. Imports no io module and performs no
 * direct console/stdout/stderr write (ESLint-enforced).
 *
 * Validates a persisted RED-phase test-run record for a `type: tdd` plan. Only an INTENTIONAL
 * failure of the target test (verdict RED_EVIDENCE_OK) may authorize GREEN; zero-test discovery,
 * fixture/load crashes, nonzero exits without a failing test, unrelated failures, and unexpected
 * greens are INVALID_RED and block GREEN. The record is the JSON the executor persists after
 * running the RED command: `{ command, exitCode, output, targetTest, targetFile?, expected?,
 * actual? }`. Fail-closed: a missing/unreadable/unparseable record is INVALID_RED (reason
 * `unreadable_record`), never a pass.
 *
 * Argv after the verb: `<record.json>`. The record path resolves against the PROCESS cwd
 * (`path.resolve`), as before the move, and must then stay INSIDE the project directory (realpath
 * containment, ADR-4650) BEFORE anything is read: a record path that escapes it is the usage
 * failure `path escapes its allowed directory: <arg>`, so the gate cannot be made to read — and
 * echo the fields of — an arbitrary readable file (#5139 security review). The path echoed in the
 * payload stays the resolved (not realpath'd) form, unchanged.
 *
 * A linked worktree is part of the project it was cut from (#5879): dispatch remaps `projectDir` to
 * the main checkout when the worktree has no `.planning/` of its own, so a record the executor wrote
 * inside the worktree it runs in is ALSO accepted. Nothing else widens: a path outside both roots
 * is still the usage failure.
 *
 * Consequence of resolving against the process cwd: the CLI runs with cwd === projectDir in every
 * workflow, so a project-relative path (`r.json`) works. Invoked with cwd !== projectDir, that same
 * relative path resolves outside the project and is the usage failure above (it was an
 * `unreadable_record` verdict before containment); an absolute path inside the project works from
 * any cwd.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateTddRedEvidence = evaluateTddRedEvidence;
const node_path_1 = __importDefault(require("node:path"));
const security_cjs_1 = require("./security.cjs");
const project_context_cjs_1 = require("./project-context.cjs");
const gate_verdict_cjs_1 = require("./gate-verdict.cjs");
const gate_evidence_cjs_1 = require("./gate-evidence.cjs");
const tdd_red_evidence_cjs_1 = require("./tdd-red-evidence.cjs");
/** Parse the persisted record. A parse failure is typed evidence (never a swallowed `null`). */
function parseRecordEvidence(text, span) {
    try {
        return (0, gate_evidence_cjs_1.evidenceFound)((JSON.parse(text) ?? {}));
    }
    catch (err) {
        return (0, gate_evidence_cjs_1.evidenceFromError)(err, span);
    }
}
/**
 * The linked worktree the process runs in, when `projectDir` is not already it. Absent outside a
 * linked worktree (then only `projectDir` contains the record).
 */
function currentLinkedWorktree(projectDir) {
    const ctx = (0, project_context_cjs_1.resolveProjectContext)(process.cwd());
    return ctx.isLinkedWorktree && node_path_1.default.resolve(ctx.worktreeRoot) !== node_path_1.default.resolve(projectDir) ? ctx.worktreeRoot : null;
}
function evaluateTddRedEvidence(input) {
    const recordPath = typeof input.args[0] === 'string' ? input.args[0] : '';
    if (!recordPath) {
        return (0, gate_verdict_cjs_1.gateUsageFailure)(gate_verdict_cjs_1.GATE_FAILURE_CODE.SDK_MISSING_ARG, 'tdd-red-evidence requires a record path: check tdd-red-evidence <record.json>');
    }
    const resolved = node_path_1.default.resolve(recordPath);
    // Containment BEFORE the read (the read follows symlinks, so it is decided on the resolved
    // target). Only the verdict of the predicate is used; the echoed path stays `resolved`.
    const worktreeDir = input.worktreeDir === undefined ? currentLinkedWorktree(input.projectDir) : input.worktreeDir;
    const inside = (root) => (0, security_cjs_1.tryWithinRoot)(resolved, root, security_cjs_1.PathAcceptance.AbsoluteInsideRoot) !== null;
    if (!inside(input.projectDir) && !(worktreeDir !== null && inside(worktreeDir))) {
        return (0, gate_verdict_cjs_1.gateUsageFailure)(gate_verdict_cjs_1.GATE_FAILURE_CODE.USAGE, `path escapes its allowed directory: ${recordPath}`);
    }
    const read = (0, gate_evidence_cjs_1.readTextEvidence)(resolved);
    const text = read.kind === 'found' ? read.value : '';
    const parsed = text ? parseRecordEvidence(text, resolved) : null;
    // Malformed JSON is content that WAS read: it is a failing record (`block`), not a swallowed error.
    const record = parsed !== null && parsed.kind === 'found' ? parsed.value : null;
    if (!record) {
        const payload = {
            passed: false,
            block: true,
            verdict: 'INVALID_RED',
            reason: 'unreadable_record',
            record: resolved,
            readError: text ? `record is not valid JSON: ${resolved}` : `record not found or unreadable: ${resolved}`,
        };
        // Fail-closed policy is unchanged (`block: true`); a record that exists but could not be read
        // is "could not look" (#5170), so its outcome is `unreadable` and the exit status follows it.
        return read.kind === 'unreadable' ? (0, gate_verdict_cjs_1.gateUnreadable)(true, payload) : (0, gate_verdict_cjs_1.gateVerdict)('block', true, payload);
    }
    const evidenceInput = {
        command: record['command'],
        exitCode: record['exitCode'],
        output: record['output'],
        targetTest: record['targetTest'],
        targetFile: record['targetFile'],
        expected: record['expected'],
        actual: record['actual'],
    };
    const result = (0, tdd_red_evidence_cjs_1.classifyRedEvidence)(evidenceInput);
    const built = (0, tdd_red_evidence_cjs_1.buildRedEvidenceRecord)(evidenceInput, result);
    const ok = result.verdict === 'RED_EVIDENCE_OK';
    // Uniform gate contract: block = !passed. INVALID_RED blocks GREEN.
    return (0, gate_verdict_cjs_1.gateVerdict)(ok ? 'pass' : 'block', !ok, {
        passed: ok,
        block: !ok,
        verdict: result.verdict,
        reason: result.reason,
        evidence: result.evidence,
        record: built,
        message: ok
            ? `RED evidence verified: target test "${result.evidence.target_test}" failed as expected (exit ${result.evidence.exit_code}). GREEN authorized.`
            : `INVALID_RED (${result.reason}): GREEN blocked. Fix the RED phase — only an intentional failure of target test "${result.evidence.target_test}" authorizes production edits.`,
    });
}
