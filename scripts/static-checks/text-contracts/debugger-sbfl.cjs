'use strict';

// Spectrum-based fault localization in the debugger (#1959, epic #1957 Phase 1B): the SBFL reference exists and gsd-debugger
// @-includes it; it names Ochiai and documents the sqrt-based formula with its failed and passed terms, Tarantula as a
// fallback and top-N seeding; it documents skipping, with a log, when there is no coverage or test suite; it records the
// ranking under Evidence; and it notes SBFL suits deterministic failures and is not trusted on flaky spectra. Was
// tests/debugger-sbfl.test.cjs. Its Ochiai cases ran an implementation defined inside the test file, so they asserted nothing
// about the repo and are not carried over.

const AGENT = 'agents/gsd-debugger.md';
const REFERENCE = 'gsd-core/references/debugger-sbfl.md';

// Does the line contain `first` and, somewhere after its first occurrence, `second` (case-insensitive)?
function hasInOrder(line, first, second) {
  const lower = line.toLowerCase();
  const at = lower.indexOf(first);
  return at !== -1 && lower.indexOf(second, at + first.length) !== -1;
}

module.exports = {
  id: 'debugger-sbfl',
  issue: '#1959',
  check(ctx) {
    ctx.exists(REFERENCE, 'debugger-sbfl.md reference must exist');
    ctx.doc(AGENT).has('@~/.claude/gsd-core/references/debugger-sbfl.md', 'gsd-debugger.md must @-include the SBFL reference');
    ctx.doc(REFERENCE)
      .has(/ochiai/i, 'the reference must name the Ochiai formula')
      .has(/sqrt/i, 'the reference must document the sqrt-based formula')
      .has(/failed/i, 'the reference must reference the failed(s) term')
      .has(/passed/i, 'the reference must reference the passed(s) term')
      .has(/tarantula/i, 'the reference must mention Tarantula as a documented fallback')
      .has(/top-?n/i, 'the reference must document top-N shortlist seeding')
      .has(/no coverage|no test suite|coverage (?:is )?(?:absent|unavailable)/i, 'the reference must document the no-coverage skip path')
      .satisfies((text) => text.split(/\r|\n|\u2028|\u2029/).some((line) => hasInOrder(line, 'skip', 'log') || hasInOrder(line, 'log', 'skip') || hasInOrder(line, 'skip', 'note') || hasInOrder(line, 'note', 'skip')) || 'no such line', 'a skip must be logged (not a silent pass): auditability')
      .has(/evidence/i, 'the reference must document that the ranking lands in the Evidence section of the debug file')
      .has(/bohrbug|deterministic|flaky|heisenbug|mandelbug/i, 'the reference must note SBFL suits deterministic bugs and is not trusted on flaky spectra (pairs with Phase 2B)');
  },
};
