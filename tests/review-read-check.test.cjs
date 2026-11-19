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
const { runNode } = require('./helpers/process-seam.cjs');

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

  test('tasks counts real task elements only: not <task-foo>, a fenced example, a comment or inline code (#6286 Minor 5a)', () => {
    const plan = [
      PLAN_A,
      'Prose naming a <task-foo> element and `<task type="auto">` in inline code.',
      '<!-- <task type="auto">commented out</task> -->',
      '```xml',
      '<task type="auto">an example, not a task</task>',
      '```',
    ].join('\n');
    assert.equal(planFacts('12.6-01-PLAN.md', plan).tasks, 2);
  });

  test('a plan with no <task> elements counts its `## Task N` headings, as the plan parser does', () => {
    const plan = '---\nwave: 1\n---\n## Task 1: a\n## Task 2: b\n## Task 3: c\n';
    assert.equal(planFacts('12.6-03-PLAN.md', plan).tasks, 3);
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

  test('a bare `<truncated` in prose flags: an echo cannot be told from a quotation (#6286 Minor 3)', () => {
    assert.equal(checkRead(`${GOOD}\nagy replaces the tail with <truncated N bytes>.`, [A, B]).truncated, true);
  });

  test('every `<truncated` form the approval names flags (#6286 Minor 3)', () => {
    for (const marker of ['<truncated>', '<truncated 1,234 bytes>', '<truncated 12 KB>', '<TRUNCATED 9 bytes>']) {
      assert.equal(checkRead(`${GOOD}\n${marker}`, [A, B]).truncated, true, marker);
    }
  });

  test('a `<truncated` inside a code fence or inline code is a quotation, not a truncation (#6286 Minor 3)', () => {
    const quoted = [
      `${GOOD}\n\`\`\`\n<truncated 12 bytes>\n\`\`\``,
      `${GOOD}\n~~~text\n<truncated>\n~~~`,
      `${GOOD}\nagy writes \`<truncated 12 bytes>\` in place of the tail.`,
      `${GOOD}\na <truncatedness> word is not the marker`,
    ];
    for (const review of quoted) assert.equal(checkRead(review, [A, B]).truncated, false, review);
  });

  test('a wrong first duplicate does not hide a right second (#6286 Minor 4)', () => {
    const review = [
      'READ-CHECK 12.6-01: requirements=[REQ-01, REQ-02]; wave=9; depends_on=[]; tasks=2',
      'READ-CHECK 12.6-01: requirements=[REQ-01, REQ-02]; wave=1; depends_on=[]; tasks=2',
    ].join('\n');
    assert.equal(checkRead(review, [A]).complete, true);
    assert.equal(parseReadCheckLines(review).get('12.6-01').length, 2, 'every line for an id is kept');
  });

  test('every wrong line for an id reports the first line\'s fields', () => {
    const review = 'READ-CHECK 12.6-01: wave=9\nREAD-CHECK 12.6-01: requirements=[REQ-01, REQ-02]; wave=7; depends_on=[]; tasks=2';
    assert.deepEqual(checkRead(review, [A]).mismatched, { '12.6-01': ['requirements', 'wave', 'depends_on', 'tasks'] });
  });

  test('plausible spellings of a correct line pass (#6286 Minor 4)', () => {
    const facts = 'requirements=[REQ-01, REQ-02]; wave=1; depends_on=[]; tasks=2';
    const spellings = [
      `**READ-CHECK 12.6-01:** ${facts}`,
      `1. **READ-CHECK 12.6-01:** ${facts}`,
      `- READ-CHECK 12.6-01: ${facts}`,
      `| READ-CHECK 12.6-01: ${facts} |`,
      '| READ-CHECK 12.6-01 | requirements=[REQ-01, REQ-02] | wave=1 | depends_on=[] | tasks=2 |',
      `READ-CHECK \`12.6-01\`: ${facts}`,
      `READ-CHECK <12.6-01>: ${facts}`,
      `READ-CHECK 12.6-01-PLAN.md: ${facts}`,
      `read-check 12.6-01: ${facts}`,
      'READ-CHECK 12.6-01: requirements=[req-01, `REQ-02`]; wave=`1`; depends_on=none; tasks=**2**',
      'READ-CHECK 12.6-01: requirements=[REQ-01, REQ-02]; wave=1; depends_on=[none]; tasks=2',
      'READ-CHECK 12.6-01: Requirements=[REQ-01, REQ-02]; Wave=1; Depends_On=[N/A]; Tasks=2',
    ];
    for (const line of spellings) assert.equal(checkRead(line, [A]).complete, true, line);
  });

  test('a lower-case label matches an upper-case plan id', () => {
    const facts = { id: '03B-01', requirements: [], wave: 1, dependsOn: [], tasks: 1 };
    assert.equal(checkRead('read-check 03b-01: requirements=[]; wave=1; depends_on=[]; tasks=1', [facts]).complete, true);
  });

  test('a number with trailing junk does not match (#6286 Minor 4)', () => {
    assert.deepEqual(checkRead('READ-CHECK 12.6-01: requirements=[REQ-01, REQ-02]; wave=1abc; depends_on=[]; tasks=2abc', [A]).mismatched,
      { '12.6-01': ['wave', 'tasks'] });
  });

  test('a plan with no wave matches only an empty restatement', () => {
    const facts = { ...A, wave: null };
    const line = (w) => `READ-CHECK 12.6-01: requirements=[REQ-01, REQ-02]; wave=${w}; depends_on=[]; tasks=2`;
    assert.equal(checkRead(line('none'), [facts]).complete, true);
    assert.equal(checkRead(line(''), [facts]).complete, true);
    assert.deepEqual(checkRead(line('1abc'), [facts]).mismatched, { '12.6-01': ['wave'] });
  });

  test('a long whitespace run on a READ-CHECK line parses in linear time (#6286 Minor 2)', () => {
    // A child process, so a quadratic regex fails on the seam's bounded timeout instead of hanging
    // this file: a synchronous regex cannot be interrupted by node:test's own timeout.
    const lib = require.resolve('../gsd-core/bin/lib/review-read-check.cjs');
    const script = [
      `const { parseReadCheckLines } = require(${JSON.stringify(lib)});`,
      "const line = 'READ-CHECK 12.6-01: wave=1;' + ' '.repeat(1000000) + 'x';",
      "const got = parseReadCheckLines(line).get('12.6-01');",
      "if (!got || got[0].wave !== '1') process.exit(3);",
    ].join('\n');
    const r = runNode(['-e', script]);
    assert.equal(r.timedOut, false, 'the parse must not run away');
    assert.equal(r.exitCode, 0, r.summary);
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

  const FAILED = checkRead('', [A]);

  test('an existing leading discount marker stays first (#6286 Major 1)', () => {
    const blind = '> [reviewed-without-repo-access] no repo.\n\nbody';
    const out = stampIncompleteRead(blind, FAILED);
    assert.ok(out.startsWith('> [reviewed-without-repo-access]'), out);
    assert.equal(out.split('\n\n')[1].startsWith(`> ${READ_CHECK_MARKER}`), true, out);
    assert.equal(stampIncompleteRead(out, FAILED), out, 'stamping a stacked review must be idempotent');
  });

  test('a stacked CRLF review keeps its order and stays idempotent', () => {
    const blind = '> [reviewed-without-repo-access] no repo.\r\n\r\nbody';
    const out = stampIncompleteRead(blind, FAILED);
    assert.ok(out.startsWith('> [reviewed-without-repo-access]'), out);
    assert.match(out, /^> \[reviewed-without-repo-access\][^\r\n]*\r?\n\r?\n> \[incomplete-read\]/, out);
    assert.equal(stampIncompleteRead(out, FAILED), out);
  });

  test('a reviewer\'s own bracketed opener, or an unknown marker, does not sit above the stamp', () => {
    for (const opener of ['> [note] x', '> [reviewed-without-telemetry] x']) {
      assert.ok(stampIncompleteRead(`${opener}\n\nbody`, FAILED).startsWith(`> ${READ_CHECK_MARKER}`), opener);
    }
  });

  test('a review that merely mentions the marker is still stamped (#6286 Minor 5b)', () => {
    const mention = `The ${READ_CHECK_MARKER} marker is new in this PR.`;
    assert.ok(stampIncompleteRead(mention, FAILED).startsWith(`> ${READ_CHECK_MARKER}`));
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
