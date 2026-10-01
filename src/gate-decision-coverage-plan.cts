/**
 * `check decision-coverage-plan` — blocking plan-phase decision-coverage gate
 * (#2492, #1365 fail-loud, #2770 empty-arg fail-closed), as a gate module (#5139, epic #5056,
 * ADR-5057 §4 first bullet): it returns a `GateResult`; the command router formats it.
 * Imports no io module and performs no direct console/stdout/stderr write (ESLint-enforced).
 *
 * Invocation (the context path may be supplied EITHER way; #4130 follow-up), argv after the verb:
 *   <phase-dir> <context-path>          (positional, the workflow caller's form)
 *   --context <path> [<phase-dir>]
 *
 * `--context <path>` follows the sibling flag convention (`check predicate`,
 * #2008): `--flag value` pairs parsed by the shared partitionPredicateArgs
 * pass, the flag WINNING over a same-purpose positional when both appear,
 * and a valueless `--context` counting as no context at all (it falls
 * through to the #2770 caller-error branch, not to the "CONTEXT.md missing"
 * green skip). The positional form keeps working unchanged — no sibling
 * check verb deprecates positionals and the plan-phase workflow passes them.
 */

import { gateVerdict, gateUnreadable, isGateUsageFailure } from './gate-verdict.cjs';
import type { GateResult } from './gate-verdict.cjs';
import { statEvidence } from './gate-evidence.cjs';
import { partitionPredicateArgs } from './gate-args.cjs';
import { resolveContainedPath } from './gate-phase-context.cjs';
import { isDecisionCoverageGateEnabled } from './gate-config.cjs';
import {
  decisionMentioned,
  extractPlanDesignatedSections,
  loadPlanContents,
  loadDecisionExtraction,
  buildPlanMessage,
} from './decision-coverage-support.cjs';
import type { UncoveredItem } from './decision-coverage-support.cjs';

/**
 * The verdict when CONTEXT.md or a plan could not be read. The blocking policy is unchanged
 * (`block: true`, fail-closed like the neighbouring arms); the outcome is `unreadable`, so the exit
 * status is UNAVAILABLE and nothing is certified from content the gate never saw (#5170).
 */
function unreadableDecisionGate(readError: string): GateResult {
  return gateUnreadable(true, {
    passed: false,
    skipped: false,
    reason: 'unreadable evidence',
    total: null,
    covered: null,
    readError,
    message: `Decision coverage gate could not read its evidence (${readError}). Fix the file permissions or encoding, then re-run the gate.`,
  });
}

/** The verdict when there is no CONTEXT.md: the legitimate green skip (authoritatively `none`, never `unreadable`). */
function contextMissingSkip(): GateResult {
  return gateVerdict('skip', false, { passed: true, skipped: true, reason: 'CONTEXT.md missing', total: 0, covered: 0, uncovered: [], message: 'No CONTEXT.md - nothing to check.' });
}

export function evaluateDecisionCoveragePlan(input: { projectDir: string; args: readonly string[] }): GateResult {
  const { projectDir, args } = input;
  // Partition the argv AFTER the verb so flag tokens and their values never land in a
  // positional slot.
  const { flags, positionals } = partitionPredicateArgs(args);
  let phaseDir = '';
  if (positionals[0]) {
    const resolved = resolveContainedPath(positionals[0], projectDir);
    if (isGateUsageFailure(resolved)) return resolved;
    phaseDir = resolved;
  }
  // A VALUELESS `--context` stays a bare token in the positionals (sibling
  // parser semantics); it must not then be read as the context PATH — a
  // `--`-prefixed "path" is a caller mistake, and #2770's law says a missing
  // context argument fails CLOSED, never a silent "CONTEXT.md missing" green
  // skip. So only a non-flag positional may serve as the context.
  const positionalContext = positionals[1] && !positionals[1].startsWith('--') ? positionals[1] : '';
  const contextArg = flags['context'] ?? positionalContext ?? '';
  let contextPath = '';
  if (contextArg) {
    const resolved = resolveContainedPath(contextArg, projectDir);
    if (isGateUsageFailure(resolved)) return resolved;
    contextPath = resolved;
  }

  if (!isDecisionCoverageGateEnabled(projectDir)) {
    return gateVerdict('skip', false, { passed: true, skipped: true, reason: 'workflow.context_coverage_gate is false', total: 0, covered: 0, uncovered: [], message: 'Decision coverage gate disabled by config.' });
  }
  // #2770: an EMPTY/MISSING contextPath argument is a CALLER ERROR (the workflow
  // forgot to pass the path — e.g. a shell variable lost between Bash blocks), not
  // evidence the phase has no CONTEXT.md. Fail closed (mirrors #1365 fail-loud) so a
  // blocking gate cannot silently certify success on a caller mistake.
  if (!contextArg || contextArg === '') {
    return gateVerdict('block', true, { passed: false, skipped: false, reason: 'missing context path argument', total: 0, covered: 0, uncovered: [], message: 'Decision coverage gate called without a context path argument — the caller (e.g. the plan-phase workflow) must pass the CONTEXT.md path. An empty argument is a caller error, not evidence there is nothing to check (#2770).' });
  }
  // One stat answers both questions (#5170): `none` (ENOENT/ENOTDIR) is a REAL path whose file
  // genuinely does not exist — the LEGITIMATE green skip. `fs.existsSync` answered `false` for an
  // EACCES on a parent too, certifying "nothing to check" over a CONTEXT.md the gate never saw.
  const contextStat = statEvidence(contextPath);
  if (contextStat.kind === 'none') {
    return contextMissingSkip();
  }
  // #4794: a NON-FILE path (a directory — the adjacent same-looking positional
  // swapped, the issue's repro 2) is a caller error like #2770's empty argument:
  // the read yields nothing, and the gate used to certify passed:true on a phase
  // full of decisions. Fail closed, naming it. A stat failure other than "absent"
  // answers the SAME fail-closed JSON (outcome `unreadable`), never a throw.
  const contextIsFile = contextStat.kind === 'found' && contextStat.value.isFile();
  if (!contextIsFile) {
    const contextKind = contextStat.kind === 'found'
      ? (contextStat.value.isDirectory() ? 'directory' : 'non-file entry')
      : 'unreadable path';
    const notAFile = { passed: false, skipped: false, reason: 'context path is not a file', total: null, covered: null, message: `Decision coverage gate: the context path "${contextArg}" is not a readable file (${contextKind}). Swap the adjacent positionals or pass --context <path-to-CONTEXT.md>.` };
    // Fail-closed policy is unchanged (`block: true`); a path that could not even be examined is
    // "could not look" (#5170), so its outcome is `unreadable` and the exit status follows it.
    return contextStat.kind === 'unreadable' ? gateUnreadable(true, notAFile) : gateVerdict('block', true, notAFile);
  }

  const extracted = loadDecisionExtraction(contextPath);
  if (extracted.kind === 'unreadable') return unreadableDecisionGate(`${extracted.span ?? contextPath}: ${extracted.reason}`);
  if (extracted.kind === 'none') {
    return contextMissingSkip();
  }
  const { trackable: decisions, outcome, unreadableIds } = extracted.value;

  // #1365 fail-loud gate: any could-not-parse outcome must NOT silently pass —
  // even when some decisions were extracted (e.g. D-01 valid but D-02 malformed).
  // A parse-miss on ANY bullet means the gate cannot certify full coverage.
  // Fire independent of decisions.length so a partial-parse still blocks.
  if (outcome === 'could-not-parse') {
    // #4794: nothing was measured — the answer must not carry the fields of a
    // gate that did. total/covered are null (a type change is the point:
    // 0 reads as data, null does not), `uncovered` is OMITTED (the list was
    // never built), and the ids that failed to parse are carried so a caller
    // capturing stdout knows which decision to fix.
    const partialParse = decisions.length > 0;
    return gateVerdict('block', true, {
      passed: false,
      skipped: false,
      reason: 'could-not-parse',
      total: null,
      covered: null,
      unreadable: unreadableIds,
      message: (partialParse
        ? 'Decision coverage gate: decisions could not be fully parsed — one or more ' +
          '`- **D-NN ...**` bullets appear malformed (missing `:` or ` — ` separator, or a phase ' +
          'prefix that is not a digit run, e.g. `D4x-01`). Fix the bullet format so all decisions ' +
          'can be read before re-running the gate.'
        : 'Decision coverage gate: could not parse decisions — possible format mismatch. ' +
          'The CONTEXT.md appears to be decision-shaped (has a <decisions> block, a decisions heading, ' +
          'or D- tokens) but no decision bullets could be extracted. Check the formatting of the decisions ' +
          'block and ensure bullets follow the `- **D-NN:** text`, `- **D4-NN:** text` (phase-prefixed), ' +
          'or `- **D-NN — title** body` form. An ID grammar the parser does not support (e.g. `DEC-01`) ' +
          'also lands here.')
        + (unreadableIds.length > 0 ? ' Unreadable ids: ' + unreadableIds.join(', ') + '.' : ''),
    });
  }

  if (decisions.length === 0) {
    return gateVerdict('skip', false, { passed: true, skipped: true, reason: 'no trackable decisions', total: 0, covered: 0, uncovered: [], message: 'No trackable decisions in CONTEXT.md.' });
  }

  const planContents = loadPlanContents(phaseDir);
  if (planContents.kind === 'unreadable') return unreadableDecisionGate(`${planContents.span ?? phaseDir}: ${planContents.reason}`);
  const sections = planContents.value.map(extractPlanDesignatedSections);
  const uncovered: UncoveredItem[] = [];
  let covered = 0;
  for (const decision of decisions) {
    if (sections.some((section) => decisionMentioned(section, decision))) covered++;
    else uncovered.push({ id: decision.id, text: decision.text, category: decision.category });
  }

  const passed = uncovered.length === 0;
  return gateVerdict(passed ? 'pass' : 'block', !passed, {
    passed,
    skipped: false,
    total: decisions.length,
    covered,
    uncovered,
    message: buildPlanMessage(uncovered),
  });
}
