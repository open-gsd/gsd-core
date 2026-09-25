/** RED policy consumes normalized test reports; format details live in adapters. */
import { parseTestReport, TestStatus, ReportFormat } from './report-parser.cjs';

export const RedEvidenceVerdict = { Accepted: 'RED_EVIDENCE_OK', Invalid: 'INVALID_RED' } as const;
export type RedEvidenceVerdict = (typeof RedEvidenceVerdict)[keyof typeof RedEvidenceVerdict];

export const RedEvidenceReason = {
  TargetFailed: 'target_test_failed', Green: 'unexpected_green', Empty: 'zero_tests_discovered',
  NoFailure: 'nonzero_exit_without_test_failure', LoadFailure: 'fixture_or_load_failure',
  NoTarget: 'no_target_test_failure', Invalid: 'invalid_record', Unreadable: 'unreadable_record',
} as const;
export type RedEvidenceReason = (typeof RedEvidenceReason)[keyof typeof RedEvidenceReason];

/** The raw run record the executor persists after the RED-phase test command. */
export interface RedEvidenceInput {
  /** The exact test command that was run (persisted verbatim). */
  command: unknown;
  /** The command's exit code. */
  exitCode: unknown;
  /** Unmodified TAP or JUnit XML produced by the actual run. */
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
}

/** The classification verdict plus the compact evidence it was decided on. */
export interface RedEvidenceResult {
  verdict: RedEvidenceVerdict;
  reason: RedEvidenceReason;
  evidence: {
    command: string;
    exit_code: number | null;
    target_test: string;
    tests: number;
    pass: number;
    fail: number;
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
 * unparseable/incomplete report, a file-named (load/crash) failure, or a
 * failure that is not the target test's are all INVALID_RED — only a nonzero
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
  if (!report.valid) return { verdict: RedEvidenceVerdict.Invalid, reason: RedEvidenceReason.Invalid, evidence };
  if (report.tests.length === 0) return { verdict: RedEvidenceVerdict.Invalid, reason: RedEvidenceReason.Empty, evidence };
  if (failures.length === 0) return { verdict: RedEvidenceVerdict.Invalid, reason: RedEvidenceReason.NoFailure, evidence };
  const targetBase = baseOf(input?.targetFile);
  const distinctlyNamed = failures.filter((test) => !targetBase || baseOf(test.name) !== targetBase);
  if (distinctlyNamed.length === 0) return { verdict: RedEvidenceVerdict.Invalid, reason: RedEvidenceReason.LoadFailure, evidence };
  // Class targets can intentionally match multiple methods in a JUnit report.
  // Other identities must resolve uniquely, including passing/skipped siblings.
  const exact = report.tests.filter((test) => test.identities.includes(targetTest));
  const grouped = report.tests.filter((test) => test.groupIdentities.includes(targetTest));
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
  };
}
