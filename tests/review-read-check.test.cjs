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
  READ_CHECK_MARKER,
} = require('../gsd-core/bin/lib/review-read-check.cjs');
const planDocument = require('../gsd-core/bin/lib/plan-document.cjs');
const { runNode, runHook } = require('./helpers/process-seam.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const fc = require('./helpers/fast-check-setup.cjs');

const LIB = require.resolve('../gsd-core/bin/lib/review-read-check.cjs');

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

  // A child process each, so a quadratic count fails on the seam's bounded timeout instead of
  // hanging this file. Sized so the plan parser's quadratic overruns that bound several times over
  // (100,000 openings took 19 s there); the linear scan takes milliseconds.
  test('an unclosed `<task ` run is counted in linear time (#6286 Minor 6)', () => {
    const script = [
      `const { planFacts } = require(${JSON.stringify(LIB)});`,
      "if (planFacts('x-01-PLAN.md', '<task '.repeat(400000)).tasks !== 0) process.exit(3);",
    ].join('\n');
    const r = runNode(['-e', script]);
    assert.equal(r.timedOut, false, 'the count must not run away');
    assert.equal(r.exitCode, 0, r.summary);
  });

  test('an `<objective>` followed by a newline run is counted in linear time (#6286 Minor 6)', () => {
    // plan-document's objective regex is quadratic on this shape; the count does not call it.
    const script = [
      `const { planFacts } = require(${JSON.stringify(LIB)});`,
      "if (planFacts('x-01-PLAN.md', '<objective>' + '\\n'.repeat(600000)).tasks !== 0) process.exit(3);",
    ].join('\n');
    const r = runNode(['-e', script]);
    assert.equal(r.timedOut, false, 'the count must not run away');
    assert.equal(r.exitCode, 0, r.summary);
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

  test('a long decoration run inside the id still parses in linear time (#6286 Nit 2)', () => {
    const script = [
      `const { parseReadCheckLines } = require(${JSON.stringify(LIB)});`,
      "const w = '**'.repeat(500000);",
      "const ticks = '`'.repeat(1000000);",
      "if (!parseReadCheckLines('READ-CHECK ' + w + '12-01' + w + ': wave=1').has('12-01')) process.exit(3);",
      "parseReadCheckLines('**READ-CHECK 12-01' + ticks + ': wave=1');",
      "parseReadCheckLines('READ-CHECK ' + '<'.repeat(1000000) + '12-01: wave=1');",
    ].join('\n');
    const r = runNode(['-e', script]);
    assert.equal(r.timedOut, false, 'the parse must not run away');
    assert.equal(r.exitCode, 0, r.summary);
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

  test('a seam without fileSize throws instead of skipping every plan (#6286 Minor 1)', () => {
    // Each plan read sits in a try/catch that skips an unreadable plan; a missing seam inside it
    // would skip them all and report nothing.
    const { exists, readFile } = deps(files);
    assert.throws(() => runReadCheck(GOOD, PROMPT, '/repo', { exists, readFile }), /fileSize/);
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

  // exists and fileSize are the real filesystem, as in production. readFile records the path and
  // returns a plan without opening anything, so a FIFO reached by mistake fails the row instead of
  // blocking it.
  function fsDeps(prompt) {
    const reads = [];
    return {
      reads,
      exists: (p) => p === PROMPT || fs.existsSync(p),
      fileSize: (p) => {
        const st = fs.statSync(p, { throwIfNoEntry: false });
        return st && st.isFile() ? st.size : null;
      },
      readFile: (p) => {
        reads.push(p);
        return p === PROMPT ? prompt : PLAN_B;
      },
    };
  }

  /** Run the check with the in-repo control plan plus `header`; return what was read and missed. */
  function check(header) {
    const d = fsDeps(`#### ${OK}\nbody\n#### ${header}\nbody\n`);
    const r = runReadCheck('no restatement', PROMPT, repo, d);
    return { reads: d.reads, missing: r.missing };
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
});

describe('#5491 properties (#6286 Minor 2)', () => {
  const planId = fc
    .tuple(fc.integer({ min: 1, max: 99 }), fc.option(fc.integer({ min: 1, max: 9 }), { nil: null }), fc.integer({ min: 1, max: 99 }))
    .map(([phase, sub, n]) => `${phase}${sub === null ? '' : `.${sub}`}-${String(n).padStart(2, '0')}`);
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
    dependsOn: fc.uniqueArray(planId, { maxLength: 3 }),
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

  test('a decorated correct restatement is complete; a wrong task count is not', () => {
    fc.assert(
      fc.property(facts, decoration, fc.integer({ min: 1, max: 5 }), (f, d, off) => {
        const review = (tasks) => ['## Review', render({ ...f, tasks }, d), 'Looks fine.'].join(d.eol);
        const right = checkRead(review(f.tasks), [f]);
        const wrong = checkRead(review(f.tasks + off), [f]);
        return right.complete && !wrong.complete && wrong.mismatched[f.id].join() === 'tasks';
      }),
      { seed: 6286, numRuns: 500 },
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
      { seed: 6286, numRuns: 500 },
    );
  });
});
