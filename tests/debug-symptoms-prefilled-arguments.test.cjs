// Workflow .md files — their text IS what the runtime loads. Testing text content
// tests the deployed contract. Per CONTRIBUTING.md exception matrix (see
// tests/agent-size-budget.test.cjs and tests/init-debug-workflow-contract.test.cjs
// for the same convention against this same file).

'use strict';

/**
 * `debug.md` Step 2 "Gather Symptoms" must state what to do when `$ARGUMENTS`
 * already supplies some or all of the five symptom fields (#5012).
 *
 * Before this fix, Step 2 said only "Use AskUserQuestion for each" with no branch
 * for pre-supplied values — the only `symptoms_prefilled: true` path was
 * `continue <slug>` (Section 1c), which skips Step 2 wholesale. There was no
 * documented behavior for a *new* session whose symptoms arrive in `$ARGUMENTS`.
 *
 * Matrix: `.gsd/bug/fix-5012-debug-symptoms-prefilled-arguments/50-test-matrix.md`.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKFLOW_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'debug.md');
const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf-8');

/** Slice out the "## 2. Gather Symptoms" section up to the next "## " heading. */
function step2Text(text) {
  const start = text.indexOf('## 2. Gather Symptoms');
  assert.notEqual(start, -1, 'Step 2 "Gather Symptoms" heading must exist');
  const rest = text.slice(start + 1);
  const nextHeadingOffset = rest.indexOf('\n## ');
  const end = nextHeadingOffset === -1 ? text.length : start + 1 + nextHeadingOffset;
  return text.slice(start, end);
}

describe('debug.md Step 2 pre-supplied $ARGUMENTS symptoms (#5012)', () => {
  const step2 = step2Text(workflow);

  test('row 1/2 — documents detecting $ARGUMENTS values and confirming instead of re-asking', () => {
    assert.ok(
      /\$ARGUMENTS/.test(step2),
      'Step 2 must reference $ARGUMENTS — the current text only says "Use AskUserQuestion for each" ' +
      'with no mention of values already supplied on invocation'
    );
    // Non-discriminating substring checks (bare /confirm/i, bare /\$ARGUMENTS/) would pass on
    // unrelated prose mentioning either word separately. Pin the actual causal claim: a supplied
    // value is shown back AND that confirmation happens INSTEAD of the open question — the two
    // literal phrases the fix's own text uses to state that branch.
    assert.ok(
      /show it back/i.test(step2),
      'Step 2 must document showing a supplied value back to the user before confirming it'
    );
    assert.ok(
      /confirm.*instead of asking the open question/is.test(step2),
      'Step 2 must document that confirming a supplied value happens INSTEAD OF asking the open ' +
      'question — not merely that the word "confirm" appears somewhere in the section'
    );
  });

  test('row 2 — the rule applies per field, not all-or-nothing', () => {
    assert.ok(
      /for each of the five (fields|symptom)/i.test(step2) || /each field/i.test(step2),
      'the rule must be stated per-field ("for each of the five fields") so a session with only ' +
      'SOME values supplied gets only the missing ones asked, not all-five-or-none'
    );
    assert.ok(
      /missing/i.test(step2),
      'Step 2 must say that fields NOT supplied in $ARGUMENTS are still asked via the open question'
    );
  });

  test('row 3 — the five original open-question bullets are unchanged (zero-prefilled case)', () => {
    const bullets = [
      /\*\*Expected behavior\*\*\s*-\s*What should happen\?/,
      /\*\*Actual behavior\*\*\s*-\s*What happens instead\?/,
      /\*\*Error messages\*\*\s*-\s*Any errors\? \(paste or describe\)/,
      /\*\*Timeline\*\*\s*-\s*When did this start\? Ever worked\?/,
      /\*\*Reproduction\*\*\s*-\s*How do you trigger it\?/,
    ];
    for (const re of bullets) {
      assert.ok(re.test(step2), `expected original bullet to survive unchanged: ${re}`);
    }
  });

  test('row 4 — continue <slug> path (Section 1c) is untouched, no forked/duplicated mechanism', () => {
    assert.ok(
      workflow.includes('skip Steps 2 and 3'),
      'Section 1c must still skip Step 2 wholesale for `continue <slug>` — the new detection ' +
      'logic belongs only inside Step 2 for the new-session path, not a second parallel mechanism'
    );
    const prefilledSpawnOccurrences = [...workflow.matchAll(/^symptoms_prefilled: true$/gm)].length;
    assert.equal(
      prefilledSpawnOccurrences,
      2,
      'exactly two session_params spawn blocks set symptoms_prefilled: true (continue path + new-session ' +
      'path after Step 2/3 complete) — a new/duplicated occurrence would mean the fix forked this mechanism ' +
      'instead of composing with it'
    );
  });

  test('row 5 — parsing edge cases: semicolons inside a value, and an empty value, are documented', () => {
    assert.ok(
      /semicolon[^.]*(?:precede|before)[^.]*(?:label|field)/i.test(step2),
      'Step 2 must say splitting happens on a semicolon that PRECEDES a recognized label, not on ' +
      'every semicolon — otherwise a value like "error: TypeError: x; retry failed" mis-splits ' +
      'into two fields'
    );
    assert.ok(
      /empty[^.]*(?:value|missing)/i.test(step2) || /missing[^.]*empty/i.test(step2),
      'Step 2 must say a label present with an empty/whitespace-only value counts as NOT supplied, ' +
      'so that field is still asked rather than silently confirmed as blank'
    );
  });
});
