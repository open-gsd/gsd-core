"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedEvidenceReason = exports.RedEvidenceVerdict = void 0;
exports.classifyRedEvidence = classifyRedEvidence;
exports.buildRedEvidenceRecord = buildRedEvidenceRecord;
/** RED policy consumes normalized test reports; format details live in adapters. */
const report_parser_cjs_1 = require("./report-parser.cjs");
exports.RedEvidenceVerdict = { Accepted: 'RED_EVIDENCE_OK', Invalid: 'INVALID_RED' };
exports.RedEvidenceReason = {
    TargetFailed: 'target_test_failed', Green: 'unexpected_green', Empty: 'zero_tests_discovered',
    NoFailure: 'nonzero_exit_without_test_failure', LoadFailure: 'fixture_or_load_failure',
    NoTarget: 'no_target_test_failure', Invalid: 'invalid_record', Unreadable: 'unreadable_record',
    BuildFailure: 'build_failure',
};
/** Basename of a path-like string ('' for non-strings) — separators `/` and `\`. */
function baseOf(p) {
    return typeof p === 'string' ? (p.split(/[\\/]/).pop() ?? p) : '';
}
/** Coerce and validate the raw record's scalar fields. Returns null exit_code only when absent/non-numeric. */
function readInput(input) {
    const command = typeof input?.command === 'string' ? input.command : '';
    const output = typeof input?.output === 'string' ? input.output : '';
    const targetTest = typeof input?.targetTest === 'string' ? input.targetTest.trim() : '';
    const exitCode = typeof input?.exitCode === 'number' && Number.isInteger(input.exitCode) && input.exitCode >= 0 ? input.exitCode : null;
    if (!command || !targetTest || exitCode === null)
        return null;
    return { command, exitCode, output, targetTest };
}
/**
 * Classify a persisted RED-phase test run. Fail-closed: malformed input, an
 * unparseable/incomplete report, a file-named (load/crash) failure, or a
 * failure that is not the target test's are all INVALID_RED — only a nonzero
 * exit WITH the distinctly-named target test failing is RED_EVIDENCE_OK.
 * Never throws.
 */
function classifyRedEvidence(input) {
    const parsed = readInput(input);
    if (!parsed) {
        return {
            verdict: exports.RedEvidenceVerdict.Invalid, reason: exports.RedEvidenceReason.Invalid,
            evidence: {
                command: typeof input?.command === 'string' ? input.command : '',
                exit_code: null, target_test: '', tests: 0, pass: 0, fail: 0, failing_tests: [],
                matched_test: null, format: report_parser_cjs_1.ReportFormat.Unknown, report_errors: [],
            },
        };
    }
    const { command, exitCode, output, targetTest } = parsed;
    const report = (0, report_parser_cjs_1.parseTestReport)(output);
    const failures = report.tests.filter((test) => test.status === report_parser_cjs_1.TestStatus.Failed);
    const evidence = {
        command, exit_code: exitCode, target_test: targetTest,
        tests: report.tests.length,
        pass: report.tests.filter((test) => test.status === report_parser_cjs_1.TestStatus.Passed).length,
        fail: failures.length,
        failing_tests: failures.map((test) => test.name),
        matched_test: null,
        format: report.format,
        report_errors: report.issues,
    };
    if (exitCode === 0)
        return { verdict: exports.RedEvidenceVerdict.Invalid, reason: exports.RedEvidenceReason.Green, evidence };
    // A package that did not compile or load asserted nothing: refuse it as its own reason, ahead of
    // the generic unusable-report refusal, because the fix is different (make the test compile).
    if (report.buildFailed)
        return { verdict: exports.RedEvidenceVerdict.Invalid, reason: exports.RedEvidenceReason.BuildFailure, evidence };
    if (!report.valid)
        return { verdict: exports.RedEvidenceVerdict.Invalid, reason: exports.RedEvidenceReason.Invalid, evidence };
    if (report.tests.length === 0)
        return { verdict: exports.RedEvidenceVerdict.Invalid, reason: exports.RedEvidenceReason.Empty, evidence };
    if (failures.length === 0)
        return { verdict: exports.RedEvidenceVerdict.Invalid, reason: exports.RedEvidenceReason.NoFailure, evidence };
    const targetBase = baseOf(input?.targetFile);
    const distinctlyNamed = failures.filter((test) => !test.loadFailure && (!targetBase || baseOf(test.name) !== targetBase));
    if (distinctlyNamed.length === 0)
        return { verdict: exports.RedEvidenceVerdict.Invalid, reason: exports.RedEvidenceReason.LoadFailure, evidence };
    // Class targets can intentionally match multiple methods in a JUnit report.
    // Other identities must resolve uniquely, including passing/skipped siblings.
    // A load-failure entry (#5721) asserted nothing: it is never a target candidate. A target that
    // names only such entries is refused as the load failure it is, not as a missing target.
    const real = report.tests.filter((test) => !test.loadFailure);
    const exact = real.filter((test) => test.identities.includes(targetTest));
    const grouped = real.filter((test) => test.groupIdentities.includes(targetTest));
    if (exact.length === 0 && grouped.length === 0 && report.tests.some((test) => test.loadFailure
        && (test.identities.includes(targetTest) || test.groupIdentities.includes(targetTest)))) {
        return { verdict: exports.RedEvidenceVerdict.Invalid, reason: exports.RedEvidenceReason.LoadFailure, evidence };
    }
    const targets = exact.length > 0 ? exact : grouped;
    const unambiguous = exact.length > 0 ? exact.length === 1 : new Set(grouped.map((test) => test.group)).size === 1;
    const targetFailure = distinctlyNamed.find((test) => targets.includes(test));
    if (!unambiguous || !targetFailure) {
        return { verdict: exports.RedEvidenceVerdict.Invalid, reason: exports.RedEvidenceReason.NoTarget, evidence };
    }
    evidence.matched_test = targetFailure.name;
    return { verdict: exports.RedEvidenceVerdict.Accepted, reason: exports.RedEvidenceReason.TargetFailed, evidence };
}
/**
 * Project a classification into the persisted record shape — command, exit
 * code, failing test, expected, actual, verdict, reason — so the evidence
 * survives past the terminal and the gate can re-verify it deterministically.
 * Pure: JSON-serializable, no timestamps (the record's mtime/commit carries time).
 */
function buildRedEvidenceRecord(input, result) {
    return {
        command: result.evidence.command,
        exit_code: result.evidence.exit_code,
        failing_test: result.evidence.matched_test,
        target_test: result.evidence.target_test,
        expected: typeof input?.expected === 'string' ? input.expected : null,
        actual: typeof input?.actual === 'string' ? input.actual : null,
        verdict: result.verdict,
        reason: result.reason,
    };
}
