'use strict';

// The debugger fix-acceptance guardrail (#1958, epic #1957 Phase 1A): the reference extract exists and gsd-debugger
// @-includes it; the five signals are documented; each signal degrades gracefully (no Stryker, no test suite, a
// skipped signal is logged); the FIX REJECTED BY GUARDRAIL return is defined and handled; per-signal results are
// recorded; the acceptance criteria and the subprocess bounds are stated. Was tests/debugger-fix-acceptance.test.cjs.

const REFERENCE = 'gsd-core/references/debugger-fix-acceptance.md';

// The words occur in this order in the text (case-insensitive), as `a.*b.*c` matched on one line.
function inOrder(text, words) {
  const lower = text.toLowerCase();
  let at = 0;
  for (const word of words) {
    const found = lower.indexOf(word, at);
    if (found === -1) return false;
    at = found + word.length;
  }
  return true;
}

// A line holds one of the word sequences in order (`.` never crossed a newline).
const lineHasAny = (text, sequences) => text.split('\n').some((line) => sequences.some((words) => inOrder(line, words)));

// The text with every run of whitespace as one space, built without a backtracking pattern.
const flatten = (text) => text.split(/\s/).filter(Boolean).join(' ');

// `surviv` + 1 to 50 word characters + " mutant" (any case), found by one walk over the text.
function survivingMutant(text) {
  const lower = text.toLowerCase();
  let at = lower.indexOf('surviv');
  while (at !== -1) {
    let end = at + 'surviv'.length;
    while (end < lower.length && /\w/.test(lower[end])) end += 1;
    const run = end - (at + 'surviv'.length);
    if (run >= 1 && run <= 50 && lower.startsWith(' mutant', end)) return true;
    at = lower.indexOf('surviv', at + 1);
  }
  return false;
}

module.exports = {
  id: 'debugger-fix-acceptance',
  issue: '#1958',
  check(ctx) {
    ctx.exists(REFERENCE, 'the debugger-fix-acceptance.md reference must exist');
    ctx.doc('agents/gsd-debugger.md')
      .has('@~/.claude/gsd-core/references/debugger-fix-acceptance.md', 'gsd-debugger.md must @-include the fix-acceptance reference')
      .has('FIX REJECTED BY GUARDRAIL', 'gsd-debugger.md must define the guardrail-rejection structured return');
    ctx.doc('agents/gsd-debug-session-manager.md')
      .has('FIX REJECTED BY GUARDRAIL', 'the session manager must handle the FIX REJECTED BY GUARDRAIL return in its continuation loop');
    ctx.doc('gsd-core/templates/DEBUG.md')
      .has(/per-signal|guardrail|fix-acceptance/i, 'DEBUG.md Resolution.verification must note structured per-signal recording');

    ctx.doc(REFERENCE)
      .has(/target test/i, 'signal 1: the target test greens')
      .has(/mutation/i, 'signal 2: the mutation check')
      .has(/no-op|deletion|behavior-deleting/i, 'signal 3: the no-op/deletion detector')
      .has(/adjacent|held-out/i, 'signal 4: adjacent/held-out tests')
      .has(/revert[\s-]{0,20}and[\s-]{0,20}reconfirm/i, 'signal 5: revert-and-reconfirm')
      .has(/no Stryker|stryker (?:is )?(?:absent|unavailable|not configured)/i, 'the reference must document skipping the mutation check when Stryker is absent')
      .has(/no test suite/i, 'the reference must document the no-suite reduction path')
      .satisfies((text) => lineHasAny(text, [['skipped', 'log'], ['log', 'skip'], ['recorded', 'skip'], ['skip', 'record']]),
        'skipped signals must be logged or recorded in the debug file')
      .has(/guardrail_verdict/, 'the reference must define the guardrail_verdict field in Resolution.verification')
      .has(/target_test|mutation_check|no_op_deletion|adjacent_tests|revert_and_reconfirm/, 'the reference must enumerate the per-signal verification keys')
      .satisfies((text) => survivingMutant(text) || lineHasAny(text, [['mutant', 'surviv']]),
        'the reference must state that a surviving mutant rejects the fix')
      .satisfies((text) => {
        const lower = flatten(text).toLowerCase();
        const at = lower.indexOf('delet');
        return at !== -1 && ['reject', 'justif', 'rca', 'root cause'].some((word) => lower.indexOf(word, at + 'delet'.length) !== -1);
      }, 'a deletion-only diff must be rejected unless the RCA justifies removal')
      .satisfies((text) => {
        const flat = flatten(text);
        return inOrder(flat, ['before', 'accept']) || inOrder(flat, ['accept', 'after', 'revert']) || flat.toLowerCase().includes('prior to accept');
      }, 'revert-and-reconfirm must run before a fix is accepted')
      .has(/timeout/i, 'the reference must mention a timeout')
      .has(/60s|60.?second/i, 'the reference must state the 60s npm/Stryker bound')
      .has(/git/i, 'the reference must bound the git subprocess (signal 5) too');
  },
};
