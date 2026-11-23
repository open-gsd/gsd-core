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

// A line holds one of the word sequences in order (`.` never crossed LF, CR, U+2028 or U+2029).
const lineHasAny = (text, sequences) => text.split(/[\n\r\u2028\u2029]/).some((line) => sequences.some((words) => inOrder(line, words)));

// The paragraphs of the text (runs of lines between blank lines), each with its whitespace flattened to single spaces.
function paragraphsOf(text) {
  const out = [];
  let current = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      if (current.length > 0) out.push(current.join(' '));
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) out.push(current.join(' '));
  return out.map((paragraph) => paragraph.split(/\s/).filter(Boolean).join(' '));
}

const isAlnum = (ch) => ch !== undefined && /[a-z0-9]/.test(ch);
const isWordChar = (ch) => ch === '_' || isAlnum(ch);

// The word stands alone in the (lower-cased) text: no letter, digit or underscore right before it and no letter or
// digit right after it (a trailing underscore does not join it, so timeout_ms and git_dir count; digit, legit,
// timeouts, x_timeout and GSD_TIMEOUT do not).
function hasWord(lower, word) {
  let at = lower.indexOf(word);
  while (at !== -1) {
    if (!isWordChar(lower[at - 1]) && !isAlnum(lower[at + word.length])) return true;
    at = lower.indexOf(word, at + 1);
  }
  return false;
}

// `60s`, or `60`, at most one character, `second` or `seconds`, each standing alone as above.
function hasSixtySeconds(lower) {
  let at = lower.indexOf('60');
  while (at !== -1) {
    if (!isWordChar(lower[at - 1])) {
      if (lower[at + 2] === 's' && !isAlnum(lower[at + 3])) return true;
      for (const skip of [0, 1]) {
        if (skip === 1 && lower[at + 2] === '\n') continue;
        const word = at + 2 + skip;
        if (!lower.startsWith('second', word)) continue;
        const end = word + 'second'.length + (lower[word + 'second'.length] === 's' ? 1 : 0);
        if (!isAlnum(lower[end])) return true;
      }
    }
    at = lower.indexOf('60', at + 1);
  }
  return false;
}

const REVERT_NAME = /revert[\s-]{0,20}and[\s-]{0,20}reconfirm/i;

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
      .has(REVERT_NAME, 'signal 5: revert-and-reconfirm')
      .has(/no Stryker|stryker (?:is )?(?:absent|unavailable|not configured)/i, 'the reference must document skipping the mutation check when Stryker is absent')
      .has(/no test suite/i, 'the reference must document the no-suite reduction path')
      .satisfies((text) => lineHasAny(text, [['skipped', 'log'], ['log', 'skip'], ['recorded', 'skip'], ['skip', 'record']]),
        'skipped signals must be logged or recorded in the debug file')
      .has(/guardrail_verdict/, 'the reference must define the guardrail_verdict field in Resolution.verification')
      .has(/target_test|mutation_check|no_op_deletion|adjacent_tests|revert_and_reconfirm/, 'the reference must enumerate the per-signal verification keys')
      .satisfies((text) => survivingMutant(text) || lineHasAny(text, [['mutant', 'surviv']]),
        'the reference must state that a surviving mutant rejects the fix')
      .satisfies((text) => paragraphsOf(text).some((paragraph) => {
        const lower = paragraph.toLowerCase();
        if (!lower.includes('no-op')) return false;
        const at = lower.indexOf('delet');
        return at !== -1 && ['reject', 'justif', 'rca', 'root cause'].some((word) => lower.indexOf(word, at + 'delet'.length) !== -1);
      }), 'a deletion-only diff must be rejected unless the RCA justifies removal (in the paragraph that states the no-op/deletion detector)')
      .satisfies((text) => paragraphsOf(text).some((paragraph) => REVERT_NAME.test(paragraph)
        && (inOrder(paragraph, ['before', 'accept']) || inOrder(paragraph, ['accept', 'after', 'revert']) || paragraph.toLowerCase().includes('prior to accept'))),
      'revert-and-reconfirm must run before a fix is accepted (in the paragraph that names revert-and-reconfirm)')
      .satisfies((text) => hasWord(text.toLowerCase(), 'timeout') || 'no standalone timeout', 'the reference must mention a timeout')
      .satisfies((text) => hasSixtySeconds(text.toLowerCase()) || 'no standalone 60s or 60 seconds', 'the reference must state the 60s npm/Stryker bound')
      .satisfies((text) => hasWord(text.toLowerCase(), 'git') || 'no standalone git', 'the reference must bound the git subprocess (signal 5) too');
  },
};
