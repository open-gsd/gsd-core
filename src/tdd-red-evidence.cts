/** RED policy consumes normalized test reports; format details live in adapters. */
import { parseTestReport, TestStatus, ReportFormat } from './report-parser.cjs';
import { createHash } from 'node:crypto';

export const RedEvidenceVerdict = { Accepted: 'RED_EVIDENCE_OK', Invalid: 'INVALID_RED', Unsupported: 'UNSUPPORTED_REPORT' } as const;
export type RedEvidenceVerdict = (typeof RedEvidenceVerdict)[keyof typeof RedEvidenceVerdict];

export const RedEvidenceReason = {
  TargetFailed: 'target_test_failed', Green: 'unexpected_green', Empty: 'zero_tests_discovered',
  NoFailure: 'nonzero_exit_without_test_failure', LoadFailure: 'fixture_or_load_failure',
  NoTarget: 'no_target_test_failure', Invalid: 'invalid_record', Unreadable: 'unreadable_record',
  BuildFailure: 'build_failure', Unsupported: 'unsupported_report_format',
} as const;
export type RedEvidenceReason = (typeof RedEvidenceReason)[keyof typeof RedEvidenceReason];

/** The raw run record the executor persists after the RED-phase test command. */
export interface RedEvidenceInput {
  /** The exact test command that was run (persisted verbatim). */
  command: unknown;
  /** The command's exit code. */
  exitCode: unknown;
  /** Unmodified TAP, JUnit XML, swift-testing console, unittest text, or `go test` text report produced by the actual run. */
  output: unknown;
  /**
   * Identity of the target the plan named: the `test('...')` name for
   * TAP runs (qualified when ambiguous), or class/method for JUnit XML (#4724).
   */
  targetTest: unknown;
  /** Path of the test file the target test lives in (file-named failures are crashes). */
  targetFile?: unknown;
  /** Expected result stated by the plan's <behavior> (persisted verbatim). */
  expected?: unknown;
  /** Actual result observed in the failing assertion (persisted verbatim). */
  actual?: unknown;
  /** Original streams, unique run identity and raw-byte file hashes for parent review. */
  stdout?: unknown;
  stderr?: unknown;
  runId?: unknown;
  captureComplete?: unknown;
  state?: unknown;
  parentReview?: unknown;
}

/** The classification verdict plus the compact evidence it was decided on. */
export interface RedEvidenceResult {
  verdict: RedEvidenceVerdict;
  reason: RedEvidenceReason;
  evidence: {
    command: string;
    exit_code: number | null;
    target_test: string;
    tests: number | null;
    pass: number | null;
    fail: number | null;
    review_digest?: string | null;
    failing_tests: string[];
    matched_test: string | null;
    format: ReportFormat;
    report_errors: string[];
  };
}

/** The persisted RED evidence record (acceptance: command, exit code, failing test, expected, actual). */
export interface RedEvidenceRecord {
  command: string;
  exit_code: number | null;
  failing_test: string | null;
  target_test: string;
  expected: string | null;
  actual: string | null;
  verdict: RedEvidenceVerdict;
  reason: RedEvidenceReason;
  /** Original unsupported capture and decision, never a synthetic parser pass. */
  unsupported_run?: RedEvidenceInput;
}

/** Basename of a path-like string ('' for non-strings) — separators `/` and `\`. */
function baseOf(p: unknown): string {
  return typeof p === 'string' ? (p.split(/[\\/]/).pop() ?? p) : '';
}

/** Coerce and validate the raw record's scalar fields. Returns null exit_code only when absent/non-numeric. */
function readInput(input: RedEvidenceInput): {
  command: string;
  exitCode: number | null;
  output: string;
  targetTest: string;
} | null {
  const command = typeof input?.command === 'string' ? input.command : '';
  const output = typeof input?.output === 'string' ? input.output : '';
  const targetTest = typeof input?.targetTest === 'string' ? input.targetTest.trim() : '';
  const exitCode =
    typeof input?.exitCode === 'number' && Number.isInteger(input.exitCode) && input.exitCode >= 0 ? input.exitCode : null;
  if (!command || !targetTest || exitCode === null) return null;
  return { command, exitCode, output, targetTest };
}

/**
 * Classify a persisted RED-phase test run. Fail-closed: malformed input, an
 * malformed/incomplete supported report, a file-named (load/crash) failure, or a
 * failure that is not the target test's are INVALID_RED. Unsupported format is
 * assessment unavailable, never machine acceptance. Only a nonzero
 * exit WITH the distinctly-named target test failing is RED_EVIDENCE_OK.
 * Never throws.
 */
export function classifyRedEvidence(input: RedEvidenceInput): RedEvidenceResult {
  const parsed = readInput(input);
  if (!parsed) {
    return {
      verdict: RedEvidenceVerdict.Invalid, reason: RedEvidenceReason.Invalid,
      evidence: {
        command: typeof input?.command === 'string' ? input.command : '',
        exit_code: null, target_test: '', tests: 0, pass: 0, fail: 0, failing_tests: [],
        matched_test: null, format: ReportFormat.Unknown, report_errors: [],
      },
    };
  }
  const { command, exitCode, output, targetTest } = parsed;
  const report = parseTestReport(output);
  const failures = report.tests.filter((test) => test.status === TestStatus.Failed);
  const evidence = {
    command, exit_code: exitCode, target_test: targetTest,
    tests: report.tests.length,
    pass: report.tests.filter((test) => test.status === TestStatus.Passed).length,
    fail: failures.length,
    failing_tests: failures.map((test) => test.name),
    matched_test: null as string | null,
    format: report.format,
    report_errors: report.issues,
  };
  if (exitCode === 0) return { verdict: RedEvidenceVerdict.Invalid, reason: RedEvidenceReason.Green, evidence };
  // A package that did not compile or load asserted nothing: refuse it as its own reason, ahead of
  // the generic unusable-report refusal, because the fix is different (make the test compile).
  if (report.buildFailed) return { verdict: RedEvidenceVerdict.Invalid, reason: RedEvidenceReason.BuildFailure, evidence };
  if (report.unsupported) {
    // Selecting a diagnostic stream must not hide recognized evidence in the other stream.
    // Require that report to go through the normal machine path, including all invalid arms.
    const otherReports = [input.stdout, input.stderr]
      .filter((stream): stream is string => typeof stream === 'string' && stream !== output && stream.trim().length > 0)
      .map(parseTestReport);
    if (otherReports.some(other => !other.unsupported)) return {
      verdict: RedEvidenceVerdict.Invalid, reason: RedEvidenceReason.Invalid,
      evidence: { ...evidence, report_errors: ['Recognized report in another captured stream; classify that original report directly'] },
    };
    return {
      verdict: RedEvidenceVerdict.Unsupported, reason: RedEvidenceReason.Unsupported,
      evidence: { ...evidence, tests: null, pass: null, fail: null, review_digest: redReviewDigest(input) },
    };
  }
  if (!report.valid) return { verdict: RedEvidenceVerdict.Invalid, reason: RedEvidenceReason.Invalid, evidence };
  if (report.tests.length === 0) return { verdict: RedEvidenceVerdict.Invalid, reason: RedEvidenceReason.Empty, evidence };
  if (failures.length === 0) return { verdict: RedEvidenceVerdict.Invalid, reason: RedEvidenceReason.NoFailure, evidence };
  const targetBase = baseOf(input?.targetFile);
  const distinctlyNamed = failures.filter((test) => !test.loadFailure && (!targetBase || baseOf(test.name) !== targetBase));
  if (distinctlyNamed.length === 0) return { verdict: RedEvidenceVerdict.Invalid, reason: RedEvidenceReason.LoadFailure, evidence };
  // Class targets can intentionally match multiple methods in a JUnit report.
  // Other identities must resolve uniquely, including passing/skipped siblings.
  // A load-failure entry (#5721) asserted nothing: it is never a target candidate. A target that
  // names only such entries is refused as the load failure it is, not as a missing target.
  const real = report.tests.filter((test) => !test.loadFailure);
  const exact = real.filter((test) => test.identities.includes(targetTest));
  const grouped = real.filter((test) => test.groupIdentities.includes(targetTest));
  if (exact.length === 0 && grouped.length === 0 && report.tests.some((test) => test.loadFailure
    && (test.identities.includes(targetTest) || test.groupIdentities.includes(targetTest)))) {
    return { verdict: RedEvidenceVerdict.Invalid, reason: RedEvidenceReason.LoadFailure, evidence };
  }
  const targets = exact.length > 0 ? exact : grouped;
  const unambiguous = exact.length > 0 ? exact.length === 1 : new Set(grouped.map((test) => test.group)).size === 1;
  const targetFailure = distinctlyNamed.find((test) => targets.includes(test));
  if (!unambiguous || !targetFailure) {
    return { verdict: RedEvidenceVerdict.Invalid, reason: RedEvidenceReason.NoTarget, evidence };
  }
  evidence.matched_test = targetFailure.name;
  return { verdict: RedEvidenceVerdict.Accepted, reason: RedEvidenceReason.TargetFailed, evidence };
}

/**
 * Project a classification into the persisted record shape — command, exit
 * code, failing test, expected, actual, verdict, reason — so the evidence
 * survives past the terminal and the gate can re-verify it deterministically.
 * Pure: JSON-serializable, no timestamps (the record's mtime/commit carries time).
 */
export function buildRedEvidenceRecord(input: RedEvidenceInput, result: RedEvidenceResult): RedEvidenceRecord {
  return {
    command: result.evidence.command,
    exit_code: result.evidence.exit_code,
    failing_test: result.evidence.matched_test,
    target_test: result.evidence.target_test,
    expected: typeof input?.expected === 'string' ? input.expected : null,
    actual: typeof input?.actual === 'string' ? input.actual : null,
    verdict: result.verdict,
    reason: result.reason,
    ...(result.verdict === RedEvidenceVerdict.Unsupported ? { unsupported_run: input } : {}),
  };
}

/** Auditable workflow authority, not authenticated agent identity. */
export const ParentRedReviewStatus = {
  Missing: 'missing', Invalid: 'invalid', Stale: 'stale', Rejected: 'rejected',
  Abstained: 'abstained', Accepted: 'accepted', Unreadable: 'unreadable',
} as const;
export type ParentRedReviewStatus = (typeof ParentRedReviewStatus)[keyof typeof ParentRedReviewStatus];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function nonblank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Scope is declared at capture time and includes the target. Null means absent. */
export function redReviewState(input: RedEvidenceInput): Record<string, string | null> | null {
  const state = asRecord(input.state);
  if (!state || !nonblank(input.targetFile) || !Object.hasOwn(state, input.targetFile)) return null;
  const entries = Object.entries(state);
  if (!entries.length || entries.some(([file, hash]) => !nonblank(file)
    || (hash !== null && (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))))) return null;
  if (state[input.targetFile] === null) return null;
  return state as Record<string, string | null>;
}

/** Bind the complete capture and sorted declared state, excluding the decision. */
export function redReviewDigest(input: RedEvidenceInput): string | null {
  const state = redReviewState(input);
  if (!readInput(input) || !state || !nonblank(input.runId) || input.captureComplete !== true
    || typeof input.stdout !== 'string' || typeof input.stderr !== 'string'
    || !nonblank(input.output) || !nonblank(input.expected) || !nonblank(input.actual)) return null;
  if (input.output !== input.stdout && input.output !== input.stderr) return null;
  return createHash('sha256').update(JSON.stringify([
    'parent-red-review-v1', input.command, input.exitCode, input.output, input.targetTest,
    input.targetFile, input.expected, input.actual, input.stdout, input.stderr, input.runId,
    input.captureComplete, Object.entries(state).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
  ])).digest('hex');
}

/** No decision can override INVALID_RED. Current state comes from the gate's contained reads. */
export function assessParentRedReview(input: RedEvidenceInput, currentState: Record<string, string | null> | null): ParentRedReviewStatus {
  if (classifyRedEvidence(input).verdict !== RedEvidenceVerdict.Unsupported) return ParentRedReviewStatus.Invalid;
  if (input.parentReview === undefined) return ParentRedReviewStatus.Missing;
  const review = asRecord(input.parentReview);
  const digest = redReviewDigest(input);
  if (!review || review['role'] !== 'parent' || !nonblank(review['reason']) || !digest) return ParentRedReviewStatus.Invalid;
  if (review['evidenceDigest'] !== digest) return ParentRedReviewStatus.Stale;
  const state = redReviewState(input)!;
  if (!currentState || Object.entries(state).some(([file, hash]) => currentState[file] !== hash)) return ParentRedReviewStatus.Stale;
  if (review['decision'] === 'reject') return ParentRedReviewStatus.Rejected;
  if (review['decision'] === 'abstain') return ParentRedReviewStatus.Abstained;
  const checks = asRecord(review['checks']);
  if (review['decision'] !== 'accept' || !checks || [
    'completeCapture', 'setupSucceeded', 'targetExecuted', 'intendedAssertionFailed', 'noUnrelatedFailures',
  ].some(key => checks[key] !== true)) return ParentRedReviewStatus.Invalid;
  return ParentRedReviewStatus.Accepted;
}
