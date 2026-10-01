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
 * Consequence of resolving against the process cwd: the CLI runs with cwd === projectDir in every
 * workflow, so a project-relative path (`r.json`) works. Invoked with cwd !== projectDir, that same
 * relative path resolves outside the project and is the usage failure above (it was an
 * `unreadable_record` verdict before containment); an absolute path inside the project works from
 * any cwd.
 */

import path from 'node:path';
import { tryWithinRoot, PathAcceptance } from './security.cjs';
import { gateVerdict, gateUnreadable, gateUsageFailure, GATE_FAILURE_CODE } from './gate-verdict.cjs';
import type { GateResult } from './gate-verdict.cjs';
import { readTextEvidence } from './gate-evidence.cjs';
import { classifyRedEvidence, buildRedEvidenceRecord } from './tdd-red-evidence.cjs';

export function evaluateTddRedEvidence(input: { projectDir: string; args: readonly string[] }): GateResult {
  const recordPath = typeof input.args[0] === 'string' ? input.args[0] : '';
  if (!recordPath) {
    return gateUsageFailure(
      GATE_FAILURE_CODE.SDK_MISSING_ARG,
      'tdd-red-evidence requires a record path: check tdd-red-evidence <record.json>',
    );
  }
  const resolved = path.resolve(recordPath);
  // Containment BEFORE the read (the read follows symlinks, so it is decided on the resolved
  // target). Only the verdict of the predicate is used; the echoed path stays `resolved`.
  if (tryWithinRoot(resolved, input.projectDir, PathAcceptance.AbsoluteInsideRoot) === null) {
    return gateUsageFailure(GATE_FAILURE_CODE.USAGE, `path escapes its allowed directory: ${recordPath}`);
  }
  const read = readTextEvidence(resolved);
  const text = read.kind === 'found' ? read.value : '';
  const record = ((): Record<string, unknown> | null => {
    if (!text) return null;
    try {
      return (JSON.parse(text) ?? {}) as Record<string, unknown>;
    } catch {
      return null;
    }
  })();
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
    return read.kind === 'unreadable' ? gateUnreadable(true, payload) : gateVerdict('block', true, payload);
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
  const result = classifyRedEvidence(evidenceInput);
  const built = buildRedEvidenceRecord(evidenceInput, result);
  const ok = result.verdict === 'RED_EVIDENCE_OK';
  // Uniform gate contract: block = !passed. INVALID_RED blocks GREEN.
  return gateVerdict(ok ? 'pass' : 'block', !ok, {
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
