'use strict';

// debug.md Step 2 "Gather Symptoms" states what to do when `$ARGUMENTS` already supplies some or all of the five
// symptom fields (#5012): a supplied value is shown back and confirmed INSTEAD OF asking the open question, the rule
// is per field, the five original open-question bullets are unchanged, `continue <slug>` (Section 1c) still skips
// Step 2, exactly two session_params blocks set `symptoms_prefilled: true`, and the semicolon / empty-value parsing
// edge cases are documented. The test's unbounded `.*` and `[\s\S]` spans are two indexOf checks and bounded classes.
// A missing next heading after Step 2 is a finding (the test read to end of file). Was
// tests/debug-symptoms-prefilled-arguments.test.cjs.

const PHRASE = 'instead of asking the open question';

module.exports = {
  id: 'debug-symptoms-prefilled-arguments',
  issue: '#5012',
  check(ctx) {
    const workflow = ctx.doc('gsd-core/workflows/debug.md');
    workflow
      .slice('## 2. Gather Symptoms', '\n## ')
      .has(/\$ARGUMENTS/, 'Step 2 must reference $ARGUMENTS')
      .has(/show it back/i, 'Step 2 must document showing a supplied value back to the user before confirming it')
      .satisfies((text) => {
        const lower = text.toLowerCase();
        const at = lower.indexOf(PHRASE);
        return (at >= 0 && lower.slice(0, at).includes('confirm')) || `expected "confirm" before "${PHRASE}"`;
      }, 'Step 2 must document that confirming a supplied value happens INSTEAD OF asking the open question')
      .satisfies((text) => /for each of the five (fields|symptom)/i.test(text) || /each field/i.test(text), 'the rule must be stated per field so a session with only some values supplied gets only the missing ones asked')
      .has(/missing/i, 'Step 2 must say that fields not supplied in $ARGUMENTS are still asked via the open question')
      .has(/\*\*Expected behavior\*\*\s{0,20}-\s{0,20}What should happen\?/, 'the original Expected behavior bullet must survive unchanged')
      .has(/\*\*Actual behavior\*\*\s{0,20}-\s{0,20}What happens instead\?/, 'the original Actual behavior bullet must survive unchanged')
      .has(/\*\*Error messages\*\*\s{0,20}-\s{0,20}Any errors\? \(paste or describe\)/, 'the original Error messages bullet must survive unchanged')
      .has(/\*\*Timeline\*\*\s{0,20}-\s{0,20}When did this start\? Ever worked\?/, 'the original Timeline bullet must survive unchanged')
      .has(/\*\*Reproduction\*\*\s{0,20}-\s{0,20}How do you trigger it\?/, 'the original Reproduction bullet must survive unchanged')
      .has(/semicolon[^.]{0,500}(?:precede|before)[^.]{0,500}(?:label|field)/i, 'Step 2 must say splitting happens on a semicolon that precedes a recognized label, not on every semicolon')
      .satisfies((text) => /empty[^.]{0,500}(?:value|missing)/i.test(text) || /missing[^.]{0,500}empty/i.test(text), 'Step 2 must say a label present with an empty value counts as not supplied');

    workflow
      .has('skip Steps 2 and 3', 'Section 1c must still skip Step 2 wholesale for `continue <slug>`')
      .satisfies((text) => {
        const count = [...text.matchAll(/^symptoms_prefilled: true$/gm)].length;
        return count === 2 || `found ${count}`;
      }, 'exactly two session_params spawn blocks set symptoms_prefilled: true (continue path and new-session path)');
  },
};
