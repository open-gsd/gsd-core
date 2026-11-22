/**
 * #5491 — proof-of-reading check for the antigravity review lane.
 *
 * agy can exit 0 with a normal-looking review after reading only part of its prompt (stdin cut
 * with `<truncated N bytes>`, paged `view_file`, silent compaction). The lane is asked to restate
 * each plan's requirements / wave / depends_on / task count; these tests pin how that restatement
 * is compared with the plans and how a failure is surfaced.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  planPathsFromPrompt,
  planFacts,
  parseReadCheckLines,
  checkRead,
  stampIncompleteRead,
  runReadCheck,
  readCheckInstruction,
  readPlanBounded,
  READ_CHECK_MARKER,
  MAX_PLAN_BYTES,
  MAX_PLAN_HEADERS,
  MAX_TOTAL_PLAN_BYTES,
} = require('../gsd-core/bin/lib/review-read-check.cjs');
const planDocument = require('../gsd-core/bin/lib/plan-document.cjs');
const { runNode, runHook } = require('./helpers/process-seam.cjs');
const { createTempDir, cleanup, installSpawnEnv } = require('./helpers.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const fc = require('./helpers/fast-check-setup.cjs');

const LIB = require.resolve('../gsd-core/bin/lib/review-read-check.cjs');

/**
 * `fn(lib, n)` (given as source) evaluated in a child at n and at 4n. The row asserts both answers,
 * not a time (#6286 Nit 6): a linear reading gives them, while a quadratic one cannot finish the 4n
 * leg and the child is stopped by the seam's bounded timeout, a backstop only. The same 1x/4x shape
 * as tests/adr-612-bracket-read-tolerance.test.cjs. A child because a synchronous regex cannot be
 * interrupted by node:test's own timeout.
 */
function atOneAndFourTimes(fnSource, n) {
  const r = runNode(['-e', [
    `const lib = require(${JSON.stringify(LIB)});`,
    `const fn = ${fnSource};`,
    `process.stdout.write(JSON.stringify([fn(lib, ${n}), fn(lib, ${4 * n})]));`,
  ].join('\n')]);
  return { answers: r.exitCode === 0 ? JSON.parse(r.stdout) : null, summary: r.summary };
}

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

  test('the task count equals the plan parser\'s taskCount on the shapes its grammar covers (#6286 Minor 6)', () => {
    const shapes = [
      [PLAN_A, 2],
      ['<task type="checkpoint:human-verify" gate="blocking">a</task>\n<task type="auto">b</task>\n<task type="checkpoint:decision">c</task>', 3],
      ['<TASK type="auto">a</TASK>\n<Task>b</Task>\n<task\ttype="auto">c</task>\n<task\n  type="auto">d</task>', 4],
      // A `<task` inside an opening tag is part of that tag, not a second opening.
      ['<task note="<task x">a</task>\n<task a="<task" b>c</task>', 2],
      ['<tasks>\n<task-foo>x</task-foo>\n<task>a</task>\n</tasks>', 1],
      ['<task type="auto">a</task>\n<task ', 1],
      ['## Task 1: a\n##Task 2 b\n## task 3\n### Task 4\n## Task x', 4],
    ];
    for (const [body, n] of shapes) {
      assert.equal(planFacts('12.6-04-PLAN.md', body).tasks, n, body);
      assert.equal(planDocument.parsePlanDocument(body).taskCount, n, body);
    }
  });

  // Sized so the plan parser's quadratic cannot finish even the 1x leg (100,000 openings took 19 s
  // there); the linear scan answers both legs in milliseconds.
  test('an unclosed `<task ` run is counted at 1x and 4x its length (#6286 Minor 6, Nit 6)', () => {
    const { answers, summary } = atOneAndFourTimes("(lib, n) => lib.planFacts('x-01-PLAN.md', '<task '.repeat(n)).tasks", 400000);
    assert.deepEqual(answers, [0, 0], summary);
  });

  test('an `<objective>` followed by a newline run is counted at 1x and 4x its length (#6286 Minor 6, Nit 6)', () => {
    // plan-document's objective regex is quadratic on this shape; the count does not call it.
    const { answers, summary } = atOneAndFourTimes("(lib, n) => lib.planFacts('x-01-PLAN.md', '<objective>' + '\\n'.repeat(n)).tasks", 600000);
    assert.deepEqual(answers, [0, 0], summary);
  });
});

describe('#5491 checkRead', () => {
  test('a correct restatement of every plan is complete (set order and decoration ignored)', () => {
    assert.deepEqual(checkRead(GOOD, [A, B]), { complete: true, truncated: false, compacted: false, missing: [], mismatched: {}, unchecked: [] });
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

  test('a `<truncated` after an unclosed fence still flags: the output was cut mid-block (code review 2)', () => {
    assert.equal(checkRead('# Review\n\n```js\nconst x = 1;\n<truncated 5000 bytes>\n', []).truncated, true);
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

  test('a long whitespace run on a READ-CHECK line parses at 1x and 4x its length (#6286 Minor 2, Nit 6)', () => {
    const fn = "(lib, n) => (lib.parseReadCheckLines('READ-CHECK 12.6-01: wave=1;' + ' '.repeat(n) + 'x').get('12.6-01') || [{}])[0].wave";
    const { answers, summary } = atOneAndFourTimes(fn, 1000000);
    assert.deepEqual(answers, ['1', '1'], summary);
  });

  test('a long colon run parses at 1x and 4x its length (#6286 Nit 3, Nit 6)', () => {
    // An id may hold a `:`, so the id's end is searched for; it must not be searched again per colon.
    const fn = "(lib, n) => [...lib.parseReadCheckLines('READ-CHECK 12-01' + ':'.repeat(n) + 'wave=1').keys()].map((k) => k.length)";
    const { answers, summary } = atOneAndFourTimes(fn, 1000000);
    assert.deepEqual(answers, [[1000000 + 4], [4000000 + 4]], summary);
  });

  test('the instruction carries the exact line shape the parser reads', () => {
    assert.match(readCheckInstruction(), /READ-CHECK <plan id>: requirements=\[<ids>\]; wave=<n>; depends_on=\[<plan ids>\]; tasks=<n>/);
  });

  test('the instruction defines `<plan id>` and asks only when the prompt has plans (#6286 Minor 3, Nit 1)', () => {
    assert.match(readCheckInstruction(), /^If the prompt contains plans, /);
    assert.match(readCheckInstruction(), /<plan id> is the plan's file name without -PLAN\.md/);
  });

  test('a path or a -PLAN.md file name in place of the id matches the plan (#6286 Minor 3)', () => {
    const facts = 'requirements=[REQ-01, REQ-02]; wave=1; depends_on=[]; tasks=2';
    for (const id of ['.planning/p/12.6-01-PLAN.md', '.planning\\p\\12.6-01-PLAN.md', '`.planning/p/12.6-01-PLAN.md`']) {
      assert.equal(checkRead(`READ-CHECK ${id}: ${facts}`, [A]).complete, true, id);
    }
  });

  const line = (id, tasks = 1) => `READ-CHECK ${id}: requirements=[]; wave=1; depends_on=[]; tasks=${tasks}`;
  const factsFor = (id) => ({ id, requirements: [], wave: 1, dependsOn: [], tasks: 1 });

  test('a leading or trailing `_` or `*` is part of the id, not decoration (#6286 Nit 2)', () => {
    for (const id of ['_x-01', 'x-01_', '_x-01_', '*x-01', 'constructor', '__proto__']) {
      assert.equal(checkRead(line(id), [factsFor(id)]).complete, true, id);
    }
    assert.deepEqual(checkRead(line('_x-01_'), [factsFor('x-01')]).missing, ['x-01'], 'a lone `_` pair is not unwrapped');
  });

  test('a mismatched `__proto__` plan is reported, not lost to the prototype setter (#6286 Nit 2)', () => {
    const r = checkRead(line('__proto__', 9), [factsFor('__proto__')]);
    assert.equal(r.complete, false);
    assert.deepEqual(Object.keys(r.mismatched), ['__proto__']);
    assert.deepEqual(r.mismatched.__proto__, ['tasks']);
    assert.equal(Object.getPrototypeOf(r.mismatched), Object.prototype);
  });

  test('matched `**…**`, backtick and `<…>` wrappers unwrap, stacked too, beside a wrapped label (#6286 Nit 2)', () => {
    const facts = 'requirements=[REQ-01, REQ-02]; wave=1; depends_on=[]; tasks=2';
    const spellings = [
      `READ-CHECK **\`12.6-01\`**: ${facts}`,
      `READ-CHECK <\`12.6-01\`>: ${facts}`,
      `**READ-CHECK 12.6-01**: ${facts}`,
      '| **READ-CHECK 12.6-01** | requirements=[REQ-01, REQ-02] | wave=1 | depends_on=[] | tasks=2 |',
      `\`READ-CHECK 12.6-01\`: ${facts}`,
      `**\`READ-CHECK 12.6-01\`**: ${facts}`,
      // Emphasis on the label alone, or across label and id, is the label's, not the id's.
      `**READ-CHECK** 12.6-01: ${facts}`,
      `\`READ-CHECK\` 12.6-01: ${facts}`,
      `*READ-CHECK* 12.6-01: ${facts}`,
      `_READ-CHECK_ 12.6-01: ${facts}`,
      `*READ-CHECK 12.6-01*: ${facts}`,
      `_READ-CHECK 12.6-01_: ${facts}`,
      `***READ-CHECK 12.6-01***: ${facts}`,
    ];
    for (const l of spellings) assert.equal(checkRead(l, [A]).complete, true, l);
  });

  test('a long decoration run inside the id parses at 1x and 4x its length (#6286 Nit 2, Nit 6)', () => {
    const fn = `(lib, n) => [
      lib.parseReadCheckLines('READ-CHECK ' + '**'.repeat(n / 2) + '12-01' + '**'.repeat(n / 2) + ': wave=1').has('12-01'),
      lib.parseReadCheckLines('**READ-CHECK 12-01' + '\`'.repeat(n) + ': wave=1').size,
      lib.parseReadCheckLines('READ-CHECK ' + '<'.repeat(n) + '12-01: wave=1').size,
    ]`;
    const { answers, summary } = atOneAndFourTimes(fn, 1000000);
    assert.deepEqual(answers, [[true, 1, 1], [true, 1, 1]], summary);
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

  test('the stamp does not assume the input was plans (#6286 Nit 1)', () => {
    assert.match(stampIncompleteRead('body', FAILED), /may not rest on a full read of its input:/);
  });

  test('a marker-only review ending in one newline keeps its marker first (#6286 Nit 3)', () => {
    for (const eol of ['\n', '\r\n']) {
      const blind = `> [reviewed-without-repo-access] no repo.${eol}`;
      const once = stampIncompleteRead(blind, FAILED);
      assert.ok(once.startsWith(blind), JSON.stringify(once));
      assert.ok(once.slice(blind.length).startsWith(`\n> ${READ_CHECK_MARKER}`), 'the stamp is its own paragraph');
      assert.equal(stampIncompleteRead(once, FAILED), once, JSON.stringify(once));
    }
  });

  test('a marker followed by a lazy-continuation line is not split by the stamp (#6286 Nit 3)', () => {
    // One newline mid-review continues the same blockquote, so the marker paragraph is not a
    // leading marker the stamp can follow; it must stay whole.
    const quote = '> [reviewed-without-repo-access] no repo.\nthe same quote, continued';
    const once = stampIncompleteRead(`${quote}\n\nbody`, FAILED);
    assert.ok(once.includes(quote), JSON.stringify(once));
    assert.equal(stampIncompleteRead(once, FAILED), once);
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
    readPlanBounded: (p, max) => (p in f && f[p].length <= max ? f[p] : null),
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

  test('a seam without readPlanBounded throws instead of leaving every plan unchecked (#6286 Minor 1, Minor 3)', () => {
    // Each plan read sits in a try/catch; a missing seam inside it would mark every plan unchecked
    // and hide why.
    const { exists, readFile } = deps(files);
    assert.throws(() => runReadCheck(GOOD, PROMPT, '/repo', { exists, readFile }), /readPlanBounded/);
  });
});

describe('#5491 runReadCheck reads only bounded regular files inside the repo (#6286 Minor 1)', () => {
  // Real directories: the containment check resolves symlinks, which an in-memory stub cannot model.
  const PROMPT = '/run/gsd-review-prompt.md';
  const OK = '.planning/p/ok-01-PLAN.md';
  const MiB = 1024 * 1024;
  let tmp;
  let repo;
  let outside;

  before(() => {
    tmp = fs.realpathSync(createTempDir('gsd-read-check-'));
    repo = path.join(tmp, 'a', 'repo');
    outside = path.join(tmp, 'outside');
    fs.mkdirSync(path.join(repo, '.planning', 'p'), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret-PLAN.md'), PLAN_A);
    for (const name of ['ok-01-PLAN.md', 'dotdot-01-PLAN.md']) fs.writeFileSync(path.join(repo, '.planning', 'p', name), PLAN_B);
    fs.writeFileSync(path.join(repo, '.planning', 'p', 'edge-01-PLAN.md'), 'x'.repeat(MiB));
    fs.writeFileSync(path.join(repo, '.planning', 'p', 'big-01-PLAN.md'), 'x'.repeat(MiB + 1));
    fs.mkdirSync(path.join(repo, '.planning', 'p', 'dir-01-PLAN.md'));
  });
  after(() => cleanup(tmp));

  // exists is the real filesystem, as in production; readFile serves only the prompt.
  function fsDeps(prompt) {
    const reads = [];
    return {
      reads,
      exists: (p) => p === PROMPT || fs.existsSync(p),
      readFile: (p) => {
        if (p !== PROMPT) throw new Error(`a plan is read through readPlanBounded, not readFile: ${p}`);
        reads.push(p);
        return prompt;
      },
      // Stats instead of opening, so a reader regression fails its own child-process rows below
      // rather than blocking this file on the FIFO. Only a plan it returns counts as read.
      readPlanBounded: (p, max) => {
        const st = fs.statSync(p);
        if (!st.isFile() || st.size > max) return null;
        reads.push(p);
        return PLAN_B;
      },
    };
  }

  /** Run the check with the in-repo control plan plus `header`; return what was read, missed and left unchecked. */
  function check(header) {
    const d = fsDeps(`#### ${OK}\nbody\n#### ${header}\nbody\n`);
    const r = runReadCheck('no restatement', PROMPT, repo, d);
    return { reads: d.reads, missing: r.missing, unchecked: r.unchecked };
  }

  /** Only the prompt and the control plan are read; only the control plan is missing. */
  function assertSkipped(header) {
    const { reads, missing } = check(header);
    assert.deepEqual(reads, [PROMPT, `${repo}/${OK}`], header);
    assert.deepEqual(missing, ['ok-01'], header);
  }

  test('a `../` header that escapes the repo is not read', () => {
    assertSkipped('../../outside/secret-PLAN.md');
  });

  test('an absolute header is not read', () => {
    assertSkipped(path.join(outside, 'secret-PLAN.md'));
  });

  test('a `..` segment is refused even when the path stays inside the repo', () => {
    assertSkipped('.planning/../.planning/p/dotdot-01-PLAN.md');
  });

  test('a symlink inside the repo pointing outside is not read', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, () => {
    fs.symlinkSync(path.join(outside, 'secret-PLAN.md'), path.join(repo, '.planning', 'p', 'link-01-PLAN.md'));
    assertSkipped('.planning/p/link-01-PLAN.md');
  });

  test('a FIFO named like a plan is not read', { skip: process.platform === 'win32' && 'no mkfifo on Windows' }, () => {
    const fifo = path.join(repo, '.planning', 'p', 'fifo-01-PLAN.md');
    throwIfFailed(runHook(fifo, [], { interpreter: 'mkfifo', timeoutMs: PROBE_TIMEOUT_MS }), `mkfifo ${fifo}`);
    assertSkipped('.planning/p/fifo-01-PLAN.md');
  });

  test('a directory named like a plan is not read', () => {
    assertSkipped('.planning/p/dir-01-PLAN.md');
  });

  test('a plan over 1 MiB is not read; one of exactly 1 MiB is', () => {
    assertSkipped('.planning/p/big-01-PLAN.md');
    const { reads, missing } = check('.planning/p/edge-01-PLAN.md');
    assert.deepEqual(reads, [PROMPT, `${repo}/${OK}`, `${repo}/.planning/p/edge-01-PLAN.md`]);
    assert.deepEqual(missing, ['ok-01', 'edge-01']);
  });

  test('a FIFO, a directory or an over-1-MiB plan is recorded as unchecked, not dropped (#6286 Minor 2)', { skip: process.platform === 'win32' && 'no mkfifo on Windows' }, () => {
    const fifo = path.join(repo, '.planning', 'p', 'fifo-01-PLAN.md');
    if (!fs.existsSync(fifo)) throwIfFailed(runHook(fifo, [], { interpreter: 'mkfifo', timeoutMs: PROBE_TIMEOUT_MS }), `mkfifo ${fifo}`);
    for (const name of ['fifo-01', 'dir-01', 'big-01']) {
      assert.deepEqual(check(`.planning/p/${name}-PLAN.md`).unchecked, [name], name);
    }
    assert.deepEqual(check('.planning/p/edge-01-PLAN.md').unchecked, [], 'an in-bound plan is checked');
    assert.deepEqual(check('../../outside/secret-PLAN.md').unchecked, [], 'a header outside the repo names no plan of this repo');
    assert.deepEqual(check('.planning/p/absent-01-PLAN.md').unchecked, [], 'a header naming no file is still skipped');
  });

  test('when every named plan is unchecked the result says so instead of returning undefined (#6286 Minor 2)', () => {
    const d = fsDeps('#### .planning/p/big-01-PLAN.md\nbody\n');
    const r = runReadCheck('review', PROMPT, repo, d);
    assert.notEqual(r, undefined);
    assert.equal(r.complete, false);
    assert.deepEqual(r.unchecked, ['big-01']);
    assert.match(stampIncompleteRead('body', r), /big-01 could not be checked/);
  });

  test('a plan is read at its resolved path, not the spelling the containment check resolved (code review 2)', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, () => {
    const real = path.join(repo, '.planning', 'r');
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, 'real-01-PLAN.md'), PLAN_B);
    const alias = path.join(repo, '.planning', 's');
    if (!fs.existsSync(alias)) fs.symlinkSync('r', alias);
    const { reads } = check('.planning/s/real-01-PLAN.md');
    assert.deepEqual(reads, [PROMPT, `${repo}/${OK}`, `${repo}/.planning/r/real-01-PLAN.md`]);
  });

  test('a plan reached through a symlinked directory is the same plan, read once (#6286 Minor 1)', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, () => {
    const alias = path.join(repo, '.planning', 'q');
    if (!fs.existsSync(alias)) fs.symlinkSync('p', alias);
    const { reads, missing } = check('.planning/q/ok-01-PLAN.md');
    assert.deepEqual(reads, [PROMPT, `${repo}/${OK}`]);
    assert.deepEqual(missing, ['ok-01']);
  });

  test('the stamp names ten unchecked plans and counts the rest', () => {
    const ids = Array.from({ length: 12 }, (_, k) => `z-${k}`);
    const stamp = stampIncompleteRead('body', checkRead('', [], false, ids));
    assert.match(stamp, /the plan file for z-0, z-1, z-2, z-3, z-4, z-5, z-6, z-7, z-8, z-9 and 2 more could not be checked/);
  });
});

// Seeds come from tests/helpers/fast-check-setup.cjs (42, or GSD_FC_SEED to explore), not a pin
// per property (#6286 Nit 5).
describe('#5491 properties (#6286 Minor 2, Nit 5)', () => {
  // A plan's own id may start or end with `_` or `*` and hold a `:` (#6286 Nit 2, Nit 3, Nit 5).
  // Ids inside a depends_on list do not take the `_`/`*` ends: list values lose their emphasis on
  // both sides of the comparison, the plan's frontmatter included.
  const idOf = (pres, posts) => fc
    .tuple(
      fc.constantFrom(...pres),
      fc.integer({ min: 1, max: 99 }),
      fc.option(fc.integer({ min: 1, max: 9 }), { nil: null }),
      fc.integer({ min: 1, max: 99 }),
      fc.constantFrom(...posts),
    )
    .map(([pre, phase, sub, n, post]) => `${pre}${phase}${sub === null ? '' : `.${sub}`}-${String(n).padStart(2, '0')}${post}`);
  const planId = idOf(['', '_', '*', '__', 'q:'], ['', '_', '*', ':x']);
  const listedId = idOf(['', 'q:'], ['', ':x']);
  const reqIds = fc.uniqueArray(fc.integer({ min: 1, max: 999 }).map((n) => `REQ-${n}`), { maxLength: 4 });
  const list = (ids, empty) => (ids.length ? `[${ids.join(', ')}]` : empty);

  /** One READ-CHECK line for `f`, in the decoration `d` picks. */
  function render(f, d) {
    const id = d.idWrap.replace('ID', `${d.prefix}${f.id}${d.suffix ? '-PLAN.md' : ''}`);
    const label = `${d.lower ? 'read-check' : 'READ-CHECK'} ${id}`;
    const values = [
      `requirements=${list(f.requirements, d.empty)}`,
      `wave=${f.wave}`,
      `depends_on=${list(f.dependsOn, d.empty)}`,
      `tasks=${f.tasks}`,
    ];
    const e = d.emphasis;
    const head =
      d.wrap === 'label-colon' ? `${e}${label}:${e}`
        : d.wrap === 'label-and-id' ? `${e}${label}${e}:`
          : d.wrap === 'label-only' ? `${e}${d.lower ? 'read-check' : 'READ-CHECK'}${e} ${id}:`
            : `${label}:`;
    const cell = d.wrap === 'label-colon' ? `${e}${label}${e}` : head.slice(0, -1);
    const body = d.table ? `| ${cell} | ${values.join(' | ')} |` : `${head} ${values.join('; ')}`;
    return `${d.quote ? '> ' : ''}${d.listMark}${body}`;
  }

  const facts = fc.record({
    id: planId,
    requirements: reqIds,
    wave: fc.integer({ min: 0, max: 20 }),
    dependsOn: fc.uniqueArray(listedId, { maxLength: 3 }),
    tasks: fc.integer({ min: 0, max: 40 }),
  });
  const decoration = fc.record({
    listMark: fc.constantFrom('', '- ', '* ', '1. ', '2) '),
    quote: fc.boolean(),
    wrap: fc.constantFrom('none', 'label-colon', 'label-and-id', 'label-only'),
    emphasis: fc.constantFrom('**', '*', '_', '`'),
    idWrap: fc.constantFrom('ID', '`ID`', '<ID>', '**ID**', '**`ID`**'),
    prefix: fc.constantFrom('', '.planning/phases/12-x/', '.planning\\phases\\12-x\\'),
    suffix: fc.boolean(),
    table: fc.boolean(),
    lower: fc.boolean(),
    empty: fc.constantFrom('[]', 'none', '[none]'),
    eol: fc.constantFrom('\n', '\r\n'),
  });

  /** `f` with exactly one field changed so it no longer matches. */
  const mutation = fc.oneof(
    fc.integer({ min: 1, max: 5 }).map((off) => ['tasks', (f) => ({ ...f, tasks: f.tasks + off })]),
    fc.integer({ min: 1, max: 5 }).map((off) => ['wave', (f) => ({ ...f, wave: f.wave + off })]),
    fc.constant(['requirements', (f) => ({ ...f, requirements: [...f.requirements, 'REQ-1000'] })]),
    fc.constant(['requirements', (f) => ({ ...f, requirements: f.requirements.length ? f.requirements.slice(1) : ['REQ-1000'] })]),
    fc.constant(['depends_on', (f) => ({ ...f, dependsOn: [...f.dependsOn, '100-01'] })]),
    fc.constant(['depends_on', (f) => ({ ...f, dependsOn: f.dependsOn.length ? f.dependsOn.slice(1) : ['100-01'] })]),
  );

  test('a decorated correct restatement is complete; one wrong field is named alone', () => {
    fc.assert(
      fc.property(facts, decoration, mutation, (f, d, [field, change]) => {
        const review = (restated) => ['## Review', render(restated, d), 'Looks fine.'].join(d.eol);
        const right = checkRead(review(f), [f]);
        const wrong = checkRead(review({ ...change(f), id: f.id }), [f]);
        return right.complete && !wrong.complete && wrong.mismatched[f.id].join() === field;
      }),
      { numRuns: 500 },
    );
  });

  test('stamping is idempotent and the first leading marker stays first', () => {
    const MARKERS = [
      '> [reviewed-without-repo-access] no repo.',
      '> [reviewed-without-source-citations] no citations.',
      `> ${READ_CHECK_MARKER} an earlier stamp.`,
    ];
    const FAILED = checkRead('', [A]);
    fc.assert(
      fc.property(
        fc.shuffledSubarray(MARKERS, { minLength: 0, maxLength: 3 }),
        fc.constantFrom('\n', '\r\n'),
        fc.constantFrom('', 'body text', '> [note] the reviewer\'s own opener\n\nbody'),
        fc.constantFrom('', '\n', '\r\n', '\n\n', '\r\n\r\n'),
        (markers, eol, body, end) => {
          // A trailing newline only ends a marker-only review; a body follows a blank line.
          const run = markers.join(eol + eol);
          const review = body ? (run ? `${run}${eol}${eol}${body}` : body) : `${run}${end}`;
          const once = stampIncompleteRead(review, FAILED);
          const at = once.indexOf(`> ${READ_CHECK_MARKER}`);
          return (
            stampIncompleteRead(once, FAILED) === once &&
            (markers.length === 0 || once.startsWith(markers[0])) &&
            at >= 0 &&
            (at === 0 || /\r?\n\r?\n$/.test(once.slice(0, at))) &&
            (!body.includes('[note]') || once.indexOf('[note]') > at)
          );
        },
      ),
      { numRuns: 500 },
    );
  });
});

const B_LINE = 'READ-CHECK 12.6-02: requirements=[REQ-03]; wave=2; depends_on=[12.6-01]; tasks=1';
const lineFor = (id) => B_LINE.replace('12.6-02', id);

/** In-memory seams over normalized paths, so two spellings of one plan reach one file; counts every bounded read. */
function memDeps(prompt, plans) {
  const PROMPT = '/run/gsd-review-prompt.md';
  const norm = (p) => path.posix.normalize(p);
  const calls = [];
  return {
    PROMPT,
    calls,
    exists: (p) => p === PROMPT || norm(p) in plans,
    readFile: (p) => {
      if (p !== PROMPT) throw new Error(`a plan is read through readPlanBounded, not readFile: ${p}`);
      return prompt;
    },
    readPlanBounded: (p, max) => {
      calls.push({ p, max });
      const content = plans[norm(p)];
      return content !== undefined && Buffer.byteLength(content) <= max ? content : null;
    },
  };
}

describe('#5491 runReadCheck reads each plan once, within a header and byte budget (#6286 Minor 1)', () => {
  test('one plan named in many spellings is read once', () => {
    const spellings = Array.from({ length: 50 }, (_, k) => `.planning/${'./'.repeat(k)}p/12.6-02-PLAN.md`);
    const d = memDeps(spellings.map((h) => `#### ${h}`).join('\n'), { '/repo/.planning/p/12.6-02-PLAN.md': PLAN_B });
    const r = runReadCheck(B_LINE, d.PROMPT, '/repo', d);
    assert.equal(d.calls.length, 1, JSON.stringify(d.calls.slice(0, 3)));
    assert.equal(r.complete, true);
  });

  test('up to MAX_PLAN_HEADERS headers are read; the next is unchecked without being read', () => {
    const ids = Array.from({ length: MAX_PLAN_HEADERS + 1 }, (_, k) => `x-${k}`);
    const plans = Object.fromEntries(ids.map((id) => [`/repo/p/${id}-PLAN.md`, PLAN_B]));
    const lines = ids.map(lineFor).join('\n');
    const prompt = (n) => ids.slice(0, n).map((id) => `#### p/${id}-PLAN.md`).join('\n');

    const atLimit = memDeps(prompt(MAX_PLAN_HEADERS), plans);
    const ok = runReadCheck(lines, atLimit.PROMPT, '/repo', atLimit);
    assert.equal(atLimit.calls.length, MAX_PLAN_HEADERS);
    assert.equal(ok.complete, true);

    const over = memDeps(prompt(MAX_PLAN_HEADERS + 1), plans);
    const r = runReadCheck(lines, over.PROMPT, '/repo', over);
    assert.equal(over.calls.length, MAX_PLAN_HEADERS);
    assert.deepEqual(r.unchecked, [ids[MAX_PLAN_HEADERS]]);
    assert.equal(r.complete, false);
  });

  test('each read is bounded by the byte budget left; a plan past it is unchecked', () => {
    const n = MAX_TOTAL_PLAN_BYTES / MAX_PLAN_BYTES;
    assert.ok(Number.isInteger(n) && n > 1, 'the budget is a whole number of maximal plans');
    const full = PLAN_B + ' '.repeat(MAX_PLAN_BYTES - Buffer.byteLength(PLAN_B));
    const ids = Array.from({ length: n + 1 }, (_, k) => `y-${k}`);
    const prompt = ids.map((id) => `#### p/${id}-PLAN.md`).join('\n');
    const lines = ids.map(lineFor).join('\n');

    // n maximal plans spend the whole budget: the last plan is not read at all.
    const spent = memDeps(prompt, Object.fromEntries(ids.map((id, k) => [`/repo/p/${id}-PLAN.md`, k < n ? full : PLAN_B])));
    const r = runReadCheck(lines, spent.PROMPT, '/repo', spent);
    assert.deepEqual(spent.calls.map((c) => c.max), Array(n).fill(MAX_PLAN_BYTES));
    assert.deepEqual(r.unchecked, [ids[n]]);
    assert.deepEqual(r.missing, []);

    // One byte left: the last read is asked for at most that byte, so the plan is unchecked.
    const short = memDeps(prompt, Object.fromEntries(ids.map((id, k) => [`/repo/p/${id}-PLAN.md`, k < n - 1 ? full : k === n - 1 ? full.slice(1) : PLAN_B])));
    const r2 = runReadCheck(lines, short.PROMPT, '/repo', short);
    assert.deepEqual(short.calls.map((c) => c.max), [...Array(n).fill(MAX_PLAN_BYTES), 1]);
    assert.deepEqual(r2.unchecked, [ids[n]]);
  });
});

describe('#5491 a plan file that cannot be opened is unchecked (#6286 Minor 2)', () => {
  test('a reader that throws leaves the plan unchecked and the others checked', () => {
    const d = memDeps('#### p/12.6-02-PLAN.md\n#### p/locked-01-PLAN.md\n', { '/repo/p/12.6-02-PLAN.md': PLAN_B, '/repo/p/locked-01-PLAN.md': PLAN_B });
    const read = d.readPlanBounded;
    d.readPlanBounded = (p, max) => {
      if (p.endsWith('locked-01-PLAN.md')) throw Object.assign(new Error(`EACCES ${p}`), { code: 'EACCES' });
      return read(p, max);
    };
    const r = runReadCheck(B_LINE, d.PROMPT, '/repo', d);
    assert.deepEqual({ unchecked: r.unchecked, missing: r.missing, complete: r.complete }, { unchecked: ['locked-01'], missing: [], complete: false });
  });
});

describe('#5491 two plans with one id need two READ-CHECK lines (#6286 Minor 4)', () => {
  const D = { id: 'dup', requirements: [], wave: 1, dependsOn: [], tasks: 1 };
  const LINE = 'READ-CHECK dup: requirements=[]; wave=1; depends_on=[]; tasks=1';

  test('one line vouches for one plan only', () => {
    const r = checkRead(LINE, [D, D]);
    assert.equal(r.complete, false);
    assert.deepEqual(r.missing, ['dup']);
    assert.equal(checkRead(`${LINE}\n${LINE}`, [D, D]).complete, true);
  });

  test('each plan takes a line that matches its own facts', () => {
    const E = { ...D, wave: 2 };
    assert.equal(checkRead(`${LINE.replace('wave=1', 'wave=2')}\n${LINE}`, [D, E]).complete, true);
    assert.deepEqual(checkRead(`${LINE}\n${LINE}`, [D, E]).mismatched, { dup: ['wave'] });
  });

  test('q/dup-PLAN.md and r/dup-PLAN.md are two plans', () => {
    const plans = { '/repo/q/dup-PLAN.md': PLAN_B, '/repo/r/dup-PLAN.md': PLAN_B };
    const d = memDeps('#### q/dup-PLAN.md\n#### r/dup-PLAN.md\n', plans);
    assert.deepEqual(runReadCheck(lineFor('dup'), d.PROMPT, '/repo', d).missing, ['dup']);
    assert.equal(runReadCheck(`${lineFor('dup')}\n${lineFor('dup')}`, d.PROMPT, '/repo', d).complete, true);
  });
});

describe('#5491 plan headers inside a closed code fence are plan content (#6286 Nit 1)', () => {
  test('a fenced header is not a plan; an unclosed fence does not hide later headers', () => {
    const prompt = [
      '#### p/a-01-PLAN.md',
      '```md',
      '#### p/ghost-01-PLAN.md',
      '```',
      '#### p/b-01-PLAN.md',
      '~~~',
      '#### p/c-01-PLAN.md',
    ].join('\n');
    assert.deepEqual(planPathsFromPrompt(prompt), ['p/a-01-PLAN.md', 'p/b-01-PLAN.md', 'p/c-01-PLAN.md']);
  });

  test('a plan body quoting a header in a fence adds no expected plan', () => {
    const body = `${PLAN_B}\n\`\`\`\n#### p/ghost-01-PLAN.md\n\`\`\`\n`;
    const d = memDeps(`#### p/12.6-02-PLAN.md\n${body}`, { '/repo/p/12.6-02-PLAN.md': body, '/repo/p/ghost-01-PLAN.md': PLAN_B });
    const r = runReadCheck(B_LINE, d.PROMPT, '/repo', d);
    assert.equal(r.complete, true, JSON.stringify(r));
  });
});

describe('#5491 code review 2 parse rows', () => {
  test('a `;` inside a bracketed list is part of the list', () => {
    const line = 'READ-CHECK 12.6-01: requirements=[REQ-01; REQ-02]; wave=1; depends_on=[]; tasks=2';
    assert.equal(checkRead(line, [A]).complete, true);
  });

  test('a bare PLAN.md header is not a plan of the read check (review.md reads `*-PLAN.md` only)', () => {
    assert.deepEqual(planPathsFromPrompt('#### p/PLAN.md\n#### PLAN.md\n#### p/x-01-PLAN.md'), ['p/x-01-PLAN.md']);
  });

  test('two plans with one id that both mismatch report the fields of both', () => {
    const D = { id: 'dup', requirements: [], wave: 1, dependsOn: [], tasks: 1 };
    const E = { ...D, wave: 2, tasks: 9 };
    const line = 'READ-CHECK dup: requirements=[]; wave=1; depends_on=[]; tasks=9';
    assert.deepEqual(checkRead(line, [D, E]).mismatched, { dup: ['wave', 'tasks'] });
  });
});

describe('#5491 ids compare as Unicode text and may hold a colon (#6286 Nit 3)', () => {
  const TAIL = 'requirements=[]; wave=1; depends_on=[]; tasks=1';
  const facts = (id) => ({ id, requirements: [], wave: 1, dependsOn: [], tasks: 1 });

  test('an NFD plan id matches an NFC restatement, and the reverse', () => {
    const nfc = 'café-01';
    const nfd = 'café-01';
    assert.equal(checkRead(`READ-CHECK ${nfc}: ${TAIL}`, [facts(nfd)]).complete, true);
    assert.equal(checkRead(`READ-CHECK ${nfd}: ${TAIL}`, [facts(nfc)]).complete, true);
    assert.equal(planFacts(`p/${nfd}-PLAN.md`, PLAN_B).id, nfc, 'the id read from a file name is NFC');
  });

  test('a `:` in a plan id is part of the id', () => {
    assert.equal(checkRead(`READ-CHECK a:b-01: ${TAIL}`, [facts('a:b-01')]).complete, true);
    assert.equal(checkRead(`READ-CHECK a:b-01:${TAIL}`, [facts('a:b-01')]).complete, true);
    assert.equal(checkRead(`| READ-CHECK a:b-01 | ${TAIL.replaceAll(';', ' |')} |`, [facts('a:b-01')]).complete, true);
    assert.deepEqual(planPathsFromPrompt('#### p/a:b-01-PLAN.md'), ['p/a:b-01-PLAN.md']);
  });

  test('a note after the id still ends the id at its colon', () => {
    assert.deepEqual([...parseReadCheckLines('READ-CHECK 12.6-01: note: wave=1').keys()], ['12.6-01']);
  });

  test('a NUL in a plan header or a restated id is rejected', () => {
    assert.deepEqual(planPathsFromPrompt('#### p/a\0b-01-PLAN.md\n#### p/ok-01-PLAN.md'), ['p/ok-01-PLAN.md']);
    assert.equal(parseReadCheckLines(`READ-CHECK a\0b-01: ${TAIL}`).size, 0);
  });
});

describe('#5491 readPlanBounded opens once and reads within its bound (#6286 Minor 3)', () => {
  let dir;
  before(() => { dir = fs.realpathSync(createTempDir('gsd-read-bounded-')); });
  after(() => cleanup(dir));

  test('a regular file of at most maxBytes is read; one byte over is not', () => {
    const f = path.join(dir, 'ten-PLAN.md');
    fs.writeFileSync(f, '0123456789');
    assert.equal(readPlanBounded(f, 10), '0123456789');
    assert.equal(readPlanBounded(f, 9), null);
  });

  test('a directory is not read', () => {
    const d = path.join(dir, 'dir-PLAN.md');
    fs.mkdirSync(d);
    let got;
    try {
      got = readPlanBounded(d, 10);
    } catch (e) {
      if (!e.code) throw e;
      got = null; // Windows refuses to open a directory at all
    }
    assert.equal(got, null);
  });

  test('a file that holds more than its fstat size is refused', { skip: process.platform !== 'linux' && '/proc is Linux-only' }, () => {
    // /proc files are regular with an fstat size of 0 but real content: the shape of a plan that
    // grew after the open.
    assert.equal(readPlanBounded('/proc/version', 1024), null);
  });

  // A child process each: a reader that blocks on a FIFO or streams a device would hang this file.
  // The seam's bounded timeout is a backstop; the row asserts the reader's answer.
  const answer = (target) => runNode(['-e', [
    `const { readPlanBounded } = require(${JSON.stringify(LIB)});`,
    `process.stdout.write(JSON.stringify(readPlanBounded(${JSON.stringify(target)}, 1024)));`,
  ].join('\n')]);

  test('a FIFO with no writer is refused without blocking', { skip: process.platform === 'win32' && 'no mkfifo on Windows' }, () => {
    const fifo = path.join(dir, 'fifo-PLAN.md');
    throwIfFailed(runHook(fifo, [], { interpreter: 'mkfifo', timeoutMs: PROBE_TIMEOUT_MS }), `mkfifo ${fifo}`);
    const r = answer(fifo);
    assert.equal(r.stdout, 'null', r.summary);
  });

  test('a link to an endless character device is refused, not streamed', { skip: process.platform === 'win32' && 'no /dev/zero on Windows' }, () => {
    const link = path.join(dir, 'zero-PLAN.md');
    fs.symlinkSync('/dev/zero', link);
    const r = answer(link);
    assert.equal(r.stdout, 'null', r.summary);
  });
});

describe('#5491 plan task count agrees with the plan parser on fence-free plans (#6286 Minor 5)', () => {
  // No backtick, `~~~` or `<!--`: planFacts deliberately ignores code and comments, which the
  // plan parser counts. Sizes stay small because the plan parser's count is quadratic (#6420).
  const piece = fc.constantFrom(
    '<task>', '<task type="auto">', '<TASK\n  type="x">', '<Task\t>', '</task>', '<tasks>', '</tasks>',
    '<task-foo>', '<task ', '<task note="<task x">', '>', '<', '## Task 3: a', '##Task 1 b', '### Task 2',
    '## task', '## Task x', 'prose', ' ', '\n', '\n\n',
  );
  test('planFacts(...).tasks equals parsePlanDocument(...).taskCount', () => {
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 40 }), (pieces) => {
        const body = `---\nwave: 1\n---\n${pieces.join('')}`;
        return planFacts('p/x-01-PLAN.md', body).tasks === planDocument.parsePlanDocument(body).taskCount;
      }),
    );
  });
});

describe('#5491 the real review-lane invoke reads plans through the bounded reader (#6286 Minor 3)', { skip: process.platform === 'win32' && 'the stub agy is a shebang script and the row needs mkfifo' }, () => {
  // The production deps in gsd-tools.cjs, end to end: a stub `agy` on PATH, a real plan and a FIFO
  // named like one. Only a reader bound to one descriptor answers the FIFO header, without blocking.
  const TOOLS = path.resolve(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');
  let tmp;
  before(() => { tmp = fs.realpathSync(createTempDir('gsd-read-check-e2e-')); });
  after(() => cleanup(tmp));

  test('a plan is checked and a FIFO header is unchecked', () => {
    const bin = path.join(tmp, 'bin');
    const repo = path.join(tmp, 'repo');
    const run = path.join(tmp, 'run');
    for (const d of [bin, path.join(repo, '.planning', 'p'), run]) fs.mkdirSync(d, { recursive: true });
    const agy = path.join(bin, 'agy');
    fs.writeFileSync(agy, [
      '#!/usr/bin/env node',
      "if (process.argv.includes('--help')) process.stdout.write('--add-dir');",
      "else process.stdout.write('Looks fine. see src/a.ts:3\\n');",
    ].join('\n'));
    fs.chmodSync(agy, 0o755);
    fs.writeFileSync(path.join(repo, '.planning', 'p', '12.6-02-PLAN.md'), PLAN_B);
    const fifo = path.join(repo, '.planning', 'p', 'fifo-01-PLAN.md');
    throwIfFailed(runHook(fifo, [], { interpreter: 'mkfifo', timeoutMs: PROBE_TIMEOUT_MS }), `mkfifo ${fifo}`);
    const prompt = path.join(run, 'gsd-review-prompt.md');
    fs.writeFileSync(prompt, `#### .planning/p/12.6-02-PLAN.md\n${PLAN_B}\n#### .planning/p/fifo-01-PLAN.md\nbody\n`);

    const r = runNode(
      [TOOLS, 'review-lane', 'invoke', '--slug', 'antigravity', '--run-dir', run, '--repo-root', repo, '--prompt-file', prompt],
      { cwd: repo, env: installSpawnEnv({ PATH: `${bin}${path.delimiter}${process.env.PATH}` }) },
    );
    assert.equal(r.exitCode, 0, r.summary);
    const { readCheck } = JSON.parse(r.stdout);
    assert.deepEqual({ missing: readCheck.missing, unchecked: readCheck.unchecked }, { missing: ['12.6-02'], unchecked: ['fifo-01'] }, r.stdout);
    assert.match(fs.readFileSync(path.join(run, 'gsd-review-antigravity.md'), 'utf8'), /^> \[incomplete-read\]/);
  });
});

describe('#5491 a prompt that names no plan reports no compaction (#6286 round 5 Minor 1)', () => {
  test('no plan header: compaction known or unknown returns undefined; a truncation marker still reports', () => {
    const d = memDeps('Review this diff.', {});
    assert.equal(runReadCheck('review', d.PROMPT, '/repo', d, { compacted: 'unknown' }), undefined);
    assert.equal(runReadCheck('review', d.PROMPT, '/repo', d, { compacted: true }), undefined);
    const t = runReadCheck('<truncated 9 bytes>', d.PROMPT, '/repo', d, { compacted: 'unknown' });
    assert.deepEqual({ truncated: t.truncated, compacted: t.compacted }, { truncated: true, compacted: false });
    assert.doesNotMatch(stampIncompleteRead('body', t), /compacted/);
  });

  test('a header naming a missing plan file still reports an unknown compaction: the prompt asked for READ-CHECK lines', () => {
    const d = memDeps('#### p/absent-01-PLAN.md', {});
    assert.equal(runReadCheck('review', d.PROMPT, '/repo', d, { compacted: 'unknown' }).compacted, 'unknown');
  });
});

describe('#5491 a fence left open in one plan hides no later plan (#6286 round 5 Minor 2)', () => {
  const LINE_A = 'READ-CHECK a-01: requirements=[REQ-01, REQ-02]; wave=1; depends_on=[]; tasks=2';
  const LINE_B = 'READ-CHECK b-01: requirements=[REQ-03]; wave=2; depends_on=[12.6-01]; tasks=1';

  test('an unclosed fence in plan A paired with plan B\'s first bare fence leaves B a plan to check', () => {
    const planA = `${PLAN_A}\n\`\`\`bash\necho never closed\n`;
    const planB = `${PLAN_B}\n\`\`\`\nan example\n\`\`\`\n`;
    const d = memDeps(`#### p/a-01-PLAN.md\n${planA}\n#### p/b-01-PLAN.md\n${planB}`, {
      '/repo/p/a-01-PLAN.md': planA,
      '/repo/p/b-01-PLAN.md': planB,
    });
    assert.deepEqual(runReadCheck(LINE_A, d.PROMPT, '/repo', d).missing, ['b-01']);
    assert.equal(runReadCheck(`${LINE_A}\n${LINE_B}`, d.PROMPT, '/repo', d).complete, true);
  });

  test('a fenced header with no plan header outside a fence names no plan', () => {
    const d = memDeps('Review this diff.\n```\n#### p/b-01-PLAN.md\n```\n', { '/repo/p/b-01-PLAN.md': PLAN_B });
    assert.equal(runReadCheck('Looks fine.', d.PROMPT, '/repo', d), undefined);
  });
});
