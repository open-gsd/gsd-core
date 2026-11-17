/**
 * #5491 — proof-of-reading check for the antigravity review lane.
 *
 * agy can exit 0 with a normal-looking review after reading only part of its prompt (stdin cut
 * with `<truncated N bytes>`, paged `view_file`, silent compaction). The lane is asked to restate
 * each plan's requirements / wave / depends_on / task count; these tests pin how that restatement
 * is compared with the plans and how a failure is surfaced.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  planPathsFromPrompt,
  planFacts,
  parseReadCheckLines,
  checkRead,
  stampIncompleteRead,
  runReadCheck,
  readCheckInstruction,
  READ_CHECK_MARKER,
} = require('../gsd-core/bin/lib/review-read-check.cjs');

const PLAN_A = [
  '---',
  'phase: 12.6',
  'plan: 01',
  'wave: 1',
  'depends_on: []',
  'requirements: [REQ-01, REQ-02]',
  '---',
  '',
  '<tasks>',
  '<task type="auto">one</task>',
  '<task type="checkpoint:decision" gate="blocking">two</task>',
  '</tasks>',
].join('\n');

const PLAN_B = [
  '---',
  'wave: 2',
  'depends_on: ["12.6-01"]',
  'requirements:',
  '  - REQ-03',
  '---',
  '<task type="auto">only</task>',
].join('\n');

const A = { id: '12.6-01', requirements: ['REQ-01', 'REQ-02'], wave: 1, dependsOn: [], tasks: 2 };
const B = { id: '12.6-02', requirements: ['REQ-03'], wave: 2, dependsOn: ['12.6-01'], tasks: 1 };

const GOOD = [
  '## 12.6-01',
  'READ-CHECK 12.6-01: requirements=[REQ-02, REQ-01]; wave=1; depends_on=[]; tasks=2',
  'Looks fine.',
  '## 12.6-02',
  '`READ-CHECK 12.6-02: requirements=[REQ-03]; wave=2; depends_on=[12.6-01]; tasks=1`',
].join('\n');

describe('#5491 planPathsFromPrompt / planFacts', () => {
  test('reads the `#### <path>-PLAN.md` headers build_prompt writes, once each', () => {
    const prompt = [
      '### Plans to Review',
      '#### .planning/phases/12.6-x/12.6-01-PLAN.md',
      PLAN_A,
      '#### Not a plan header',
      '#### .planning/phases/12.6-x/12.6-02-PLAN.md',
      '#### .planning/phases/12.6-x/12.6-01-PLAN.md',
    ].join('\n');
    assert.deepEqual(planPathsFromPrompt(prompt), [
      '.planning/phases/12.6-x/12.6-01-PLAN.md',
      '.planning/phases/12.6-x/12.6-02-PLAN.md',
    ]);
  });

  test('facts come from frontmatter; tasks count <task elements, not the <tasks> wrapper', () => {
    assert.deepEqual(planFacts('.planning/phases/12.6-x/12.6-01-PLAN.md', PLAN_A), A);
    assert.deepEqual(planFacts('12.6-02-PLAN.md', PLAN_B), B);
  });
});

describe('#5491 checkRead', () => {
  test('a correct restatement of every plan is complete (set order and decoration ignored)', () => {
    assert.deepEqual(checkRead(GOOD, [A, B]), { complete: true, truncated: false, compacted: false, missing: [], mismatched: {} });
  });

  test('a plan with no READ-CHECK line is missing', () => {
    const r = checkRead(GOOD.split('\n').slice(0, 3).join('\n'), [A, B]);
    assert.equal(r.complete, false);
    assert.deepEqual(r.missing, ['12.6-02']);
  });

  test('each wrong or absent field is named', () => {
    const review = 'READ-CHECK 12.6-01: requirements=[REQ-01]; wave=2; tasks=2';
    assert.deepEqual(checkRead(review, [A]).mismatched, { '12.6-01': ['requirements', 'wave', 'depends_on'] });
  });

  test('a `<truncated N bytes>` marker fails the check even when every line matches', () => {
    const r = checkRead(`${GOOD}\n<truncated 61234 bytes>`, [A, B]);
    assert.equal(r.truncated, true);
    assert.equal(r.complete, false);
  });

  test('a compaction the handler saw fails the check even when every line matches', () => {
    // Live agy 1.5.10 run: all nine plans restated correctly, then the session compacted while
    // checking repo files and the review was written from the summary.
    const r = checkRead(GOOD, [A, B], true);
    assert.equal(r.compacted, true);
    assert.equal(r.complete, false);
    assert.match(stampIncompleteRead('body', r), /compacted its context/);
  });

  test('prose that merely names the marker shape is not a truncation', () => {
    assert.equal(checkRead(`${GOOD}\nagy replaces the tail with <truncated N bytes>.`, [A, B]).truncated, false);
  });

  test('the first READ-CHECK line for an id wins', () => {
    const lines = parseReadCheckLines('READ-CHECK x: wave=1\nREAD-CHECK x: wave=9');
    assert.equal(lines.get('x').wave, '1');
  });

  test('the instruction carries the exact line shape the parser reads', () => {
    assert.match(readCheckInstruction(), /READ-CHECK <plan id>: requirements=\[<ids>\]; wave=<n>; depends_on=\[<plan ids>\]; tasks=<n>/);
  });
});

describe('#5491 stampIncompleteRead', () => {
  test('a complete check leaves the review untouched', () => {
    assert.equal(stampIncompleteRead('body', checkRead(GOOD, [A, B])), 'body');
  });

  test('a failed check prepends the marker with the reason, once', () => {
    const check = checkRead('READ-CHECK 12.6-01: requirements=[REQ-01, REQ-02]; wave=1; depends_on=[]; tasks=5', [A, B]);
    const once = stampIncompleteRead('body', check);
    assert.ok(once.startsWith(`> ${READ_CHECK_MARKER}`));
    assert.match(once, /no READ-CHECK line for 12\.6-02/);
    assert.match(once, /12\.6-01 \(tasks\)/);
    assert.equal(stampIncompleteRead(once, check), once, 'stamping must be idempotent');
  });
});

describe('#5491 runReadCheck', () => {
  const PROMPT = '/run/gsd-review-prompt.md';
  const files = {
    [PROMPT]: '#### .planning/p/12.6-01-PLAN.md\nx\n#### .planning/p/12.6-02-PLAN.md\n',
    '/repo/.planning/p/12.6-01-PLAN.md': PLAN_A,
    '/repo/.planning/p/12.6-02-PLAN.md': PLAN_B,
  };
  const deps = (f) => ({
    exists: (p) => p in f,
    readFile: (p) => { if (!(p in f)) throw new Error(`ENOENT ${p}`); return f[p]; },
  });

  test('expected facts are read from the plan files the prompt names', () => {
    assert.equal(runReadCheck(GOOD, PROMPT, '/repo', deps(files)).complete, true);
    assert.deepEqual(runReadCheck('no restatement', PROMPT, '/repo/', deps(files)).missing, ['12.6-01', '12.6-02']);
  });

  test('an unreadable plan is skipped, not flagged', () => {
    const f = { ...files };
    delete f['/repo/.planning/p/12.6-02-PLAN.md'];
    assert.equal(runReadCheck(GOOD.split('\n').slice(0, 2).join('\n'), PROMPT, '/repo', deps(f)).complete, true);
  });

  test('nothing to check (no plan headers, no marker) returns undefined', () => {
    assert.equal(runReadCheck('review', '/missing.md', '/repo', deps({})), undefined);
    assert.equal(runReadCheck('<truncated 9 bytes>', '/missing.md', '/repo', deps({})).truncated, true);
    assert.equal(runReadCheck('review', '/missing.md', '/repo', deps({}), { compacted: true }).compacted, true);
  });
});
