'use strict';

/**
 * #6814: the `plan-phase-coverage-gate` text contract. plan-phase step 13 must keep its null/TBD skip, read the live
 * plan set through phase.list-plans and each plan's `requirements` through frontmatter.get, strip the CR a Windows
 * jq.exe writes (without jq 1.7's -b), never grep or glob plan files, and count a requirement as covered only on an
 * exact line match. The shipped tree passes; each mutation below, made to a copy of plan-phase.md, fails it.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');
const textContracts = require('../scripts/static-checks/text-contracts.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const ROOT = path.join(__dirname, '..');
const CONTRACT = 'plan-phase-coverage-gate';
const PLAN = path.join('gsd-core', 'workflows', 'plan-phase.md');
const SHIPPED = fs.readFileSync(path.join(ROOT, PLAN), 'utf8');
// #6814's base line, the one the contract must refuse.
const GREP_LINE = 'PLAN_REQS=$(grep -h "requirements_addressed\\|requirements:" ${PHASE_DIR}/*-PLAN.md 2>/dev/null | tr -d \'[]\' | tr \',\' \'\\n\' | sed \'s/^[[:space:]]*//\' | sort -u)';

/** A tree holding this contract and plan-phase.md as `edit` leaves the shipped text. */
function makeTree(t, edit) {
  const root = createTempDir('gsd-coverage-gate-contract-');
  t.after(() => cleanup(root));
  const dir = path.join(root, 'contracts');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts', 'static-checks', 'text-contracts', `${CONTRACT}.cjs`), path.join(dir, `${CONTRACT}.cjs`));
  fs.mkdirSync(path.dirname(path.join(root, PLAN)), { recursive: true });
  const text = edit(SHIPPED);
  assert.notEqual(text, SHIPPED, 'the mutation must change plan-phase.md');
  fs.writeFileSync(path.join(root, PLAN), text);
  return { root, dir };
}

/** The shipped text with exactly one occurrence of `from` replaced by `to`. */
const replaceOnce = (from, to) => (text) => {
  assert.equal(text.split(from).length, 2, `plan-phase.md must carry ${JSON.stringify(from)} once`);
  return text.replace(from, () => to);
};

// A temporary tree holds just this contract, so the engine's shipped-count minimum is lowered to that one.
const messages = (tree) => textContracts.run({ ...tree, minContracts: 1 }).map((f) => f.message);
const PLAN_REQS_LINE = splitLines(SHIPPED).find((l) => l.startsWith('PLAN_REQS=$('));

describe('plan-phase-coverage-gate (#6814)', () => {
  test('theShippedTreePasses: step 13 reads the live plans\' requirements field and matches IDs exactly', () => {
    assert.deepEqual(textContracts.run({ root: ROOT, only: [CONTRACT], minContracts: 1 }), []);
  });

  const MUTATIONS = [
    ['droppingTheSkipRule', replaceOnce('**Skip if:** `phase_req_ids` is null or TBD', '**Skip if:** never'), /must still skip a phase with no mapped requirements/],
    ['droppingTheExactMatchRule', replaceOnce('only if it equals a `PLAN_REQS` line exactly', 'if it appears in `PLAN_REQS`'), /only on an exact line match/],
    ['aPathListWithCr', replaceOnce("'.plans[]' | tr -d '\\r' |", "'.plans[]' |"), /each plan path with/],
    ['anIdListWithCr', replaceOnce("done | tr -d '\\r' | sort", 'done | sort'), /each ID with/],
    ['aJqBinaryFlag', replaceOnce("--raw | jq -r '", "--raw | jq -rb '"), /jq 1\.6 has no such option/],
    ['aPathReadWithoutIfs', replaceOnce('while IFS= read -r p;', 'while read -r p;'), /read each plan path verbatim/],
    ['anotherField', replaceOnce('--field requirements', '--field requirements_addressed'), /a field the plan format does not have/],
    ['aRootPlanGlob', replaceOnce('**Step 2: Compare.**', '**Step 2: Compare** each `*-PLAN.md`.'), /must not glob root plan files/],
    ['aMissingSectionEnd', replaceOnce('## 13a. Decision Coverage Gate', '## Decision Coverage Gate'), /closing marker/],
  ];
  for (const [name, edit, expected] of MUTATIONS) {
    test(`${name} is exactly one finding`, (t) => {
      const found = messages(makeTree(t, edit));
      assert.equal(found.length, 1, found.join('\n'));
      assert.match(found[0], expected);
    });
  }

  test('restoringTheGrep is a finding for each rule the base line broke: no list-plans, no frontmatter.get, no whole-path read, no CR strip on paths or IDs, the unread field, the grep and the glob', (t) => {
    const found = messages(makeTree(t, replaceOnce(PLAN_REQS_LINE, GREP_LINE)));
    assert.equal(found.length, 8, found.join('\n'));
    for (const expected of [/phase\.list-plans/, /through frontmatter\.get/, /read each plan path verbatim/, /each plan path with/, /each ID with/, /a field the plan format does not have/, /must not grep/, /must not glob root plan files/]) {
      assert.ok(found.some((m) => expected.test(m)), `${expected}: ${found.join('\n')}`);
    }
  });
});
