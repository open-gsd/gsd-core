'use strict';

// #5612 — the self-test report: a fix PR from a non-maintainer carries a
// head-bound JSON record of what the submitter ran. Tests assert on the typed
// REASON enum, never on free text.
//
// What this check must NOT do is pass a report that is stale, a template
// placeholder (whole or partly filled), claims a failing-first test that did not
// fail on the base, or claims a suite that did not pass. It validates shape and
// sha binding; it does not, and cannot, prove the run happened.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');

const { createTempDir, cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const {
  REASON,
  EXCERPT_MAX,
  isFixPr,
  extractReport,
  validateReport,
  evaluateSelfTestReport,
} = require('../scripts/self-test-report-policy.cjs');

const HEAD = 'c'.repeat(40);
const OLD = 'd'.repeat(40);
const maintainers = new Set(['trek-e']);

function goodReport(overrides = {}) {
  return {
    schema: 1,
    head_sha: HEAD,
    tool: 'gsd-test',
    failing_first: { test: 'tests/x.test.cjs', fails_on_base: true, passes_on_head: true },
    commands: ['node --test tests/x.test.cjs'],
    full_suite: { command: 'npm test', result: 'passed', passed: 100, failed: 0 },
    environment: { os: 'darwin 24', node: '24.1.0' },
    output_excerpt: 'ok 1 - regression',
    ...overrides,
  };
}

function bodyWith(report, { heading = '## Self-test report', fence = '```', info = 'json' } = {}) {
  return `## Fix PR\n\nFixes #1\n\n${heading}\n\n${fence}${info}\n${JSON.stringify(report, null, 2)}\n${fence}\n\n## Checklist\n- [x] done\n`;
}

function verdict(overrides = {}) {
  return evaluateSelfTestReport({
    body: bodyWith(goodReport()),
    headRef: 'fix/1-thing',
    title: 'fix(#1): thing',
    authorLogin: 'outsider',
    headSha: HEAD,
    maintainers,
    ...overrides,
  });
}

function reasonFor(report) {
  return verdict({ body: bodyWith(report) }).reason;
}

describe('isFixPr', () => {
  test('a fix/ head ref', () => assert.equal(isFixPr({ headRef: 'fix/12-a', title: 'x' }), true));
  test('a fix title', () => {
    for (const title of ['fix: a', 'fix(#12): a', 'Fix(scope)!: a', ' fix: padded']) {
      assert.equal(isFixPr({ headRef: 'chore/x', title }), true, title);
    }
  });
  test('other work is not a fix PR', () => {
    for (const [headRef, title] of [['chore/x', 'chore: a'], ['feat/x', 'feat: a'], ['wiki/x', 'prefix: a'], ['hotfix/x', 'hotfix: a'], [undefined, undefined]]) {
      assert.equal(isFixPr({ headRef, title }), false, `${headRef} / ${title}`);
    }
  });
});

describe('extractReport', () => {
  test('finds the json block under the heading', () => {
    const got = extractReport(bodyWith(goodReport()));
    assert.equal(got.found, true);
    assert.equal(JSON.parse(got.json).schema, 1);
  });

  test('accepts any heading level, bold decoration and a trailing hash run', () => {
    for (const heading of ['# Self-test report', '### Self-test report', '## **Self-test report**', '## Self-test report ##', '## SELF-TEST REPORT']) {
      assert.equal(extractReport(bodyWith(goodReport(), { heading })).found, true, heading);
    }
  });

  test('a heading that is only close-ish is not the section', () => {
    for (const heading of ['## Self-test report:', '## Self test report', '#Self-test report', '####### Self-test report']) {
      assert.equal(extractReport(bodyWith(goodReport(), { heading })).found, false, heading);
    }
  });

  test('a json block before the heading is not the report', () => {
    const body = '```json\n{"schema":1}\n```\n\n## Self-test report\n\nnothing here\n';
    assert.equal(extractReport(body).found, false);
  });

  test('a json block after the next same-level heading is not the report', () => {
    const body = '## Self-test report\n\ntext\n\n## Checklist\n\n```json\n{"schema":1}\n```\n';
    assert.equal(extractReport(body).found, false);
  });

  test('a deeper heading inside the section does not end it', () => {
    const body = '## Self-test report\n\n### Details\n\n```json\n{"a":1}\n```\n';
    assert.equal(extractReport(body).found, true);
  });

  test('a # line inside a fence is not a heading', () => {
    const body = '## Self-test report\n\n```json\n{"a":"# not a heading"}\n```\n';
    assert.deepEqual(JSON.parse(extractReport(body).json), { a: '# not a heading' });
  });

  test('a heading-looking line inside a non-json fence does not end the section', () => {
    const body = '## Self-test report\n\n```text\n## Checklist\n```\n\n```json\n{"a":1}\n```\n';
    assert.deepEqual(JSON.parse(extractReport(body).json), { a: 1 });
  });

  test('a non-json fence in the section is skipped and a later json fence is used', () => {
    const body = '## Self-test report\n\n```bash\nnpm test\n```\n\n```json\n{"a":1}\n```\n';
    assert.deepEqual(JSON.parse(extractReport(body).json), { a: 1 });
  });

  test('the first json block wins', () => {
    const body = '## Self-test report\n\n```json\n{"first":1}\n```\n\n```json\n{"second":2}\n```\n';
    assert.deepEqual(JSON.parse(extractReport(body).json), { first: 1 });
  });

  test('the language is case-insensitive and may carry trailing info', () => {
    for (const info of ['JSON', 'Json', 'json title="x"', 'json   ']) {
      const body = `## Self-test report\n\n\`\`\`${info}\n{"a":1}\n\`\`\`\n`;
      assert.deepEqual(JSON.parse(extractReport(body).json), { a: 1 }, info);
    }
  });

  test('tilde fences and CRLF line endings work', () => {
    const body = '## Self-test report\r\n\r\n~~~json\r\n{"a":1}\r\n~~~\r\n';
    assert.equal(extractReport(body).found, true);
  });

  test('a longer outer fence wraps an inner example without ending early', () => {
    const body = '## Self-test report\n\n````json\n```\n{"a":1}\n```\n````\n';
    const got = extractReport(body);
    assert.equal(got.found, true);
    assert.ok(got.json.includes('```'));
  });

  test('a backtick fence is not closed by a tilde fence', () => {
    const body = '## Self-test report\n\n```json\n{"a":1}\n~~~\n';
    assert.equal(extractReport(body).found, false);
  });

  test('an indented fence is still a fence', () => {
    const body = '## Self-test report\n\n   ```json\n{"a":1}\n   ```\n';
    assert.equal(extractReport(body).found, true);
  });

  test('a block inside an HTML comment is not the report', () => {
    const body = '## Self-test report\n\n<!--\n```json\n{"hidden":1}\n```\n-->\n';
    assert.equal(extractReport(body).found, false);
  });

  test('a single-line HTML comment does not hide the block after it', () => {
    const body = '## Self-test report\n\n<!-- note -->\n\n```json\n{"a":1}\n```\n';
    assert.equal(extractReport(body).found, true);
  });

  test('a comment marker inside a fenced block is part of the block', () => {
    const body = '## Self-test report\n\n```json\n{"a":"<!--"}\n```\n';
    assert.deepEqual(JSON.parse(extractReport(body).json), { a: '<!--' });
  });

  test('an unclosed fence yields nothing', () => {
    assert.equal(extractReport('## Self-test report\n\n```json\n{"a":1}\n').found, false);
  });

  test('empty and non-string bodies yield nothing', () => {
    for (const body of ['', null, undefined, 42]) assert.equal(extractReport(body).found, false);
  });

  test('a very long line of whitespace is handled in bounded time and does not hide the report', () => {
    // The heading regex used to be cubic on this shape (8,000 spaces took ~23 s).
    // A regression hangs this test rather than failing an assertion on a clock.
    const hostile = `# a${' '.repeat(60000)}x${' '.repeat(60000)}x`;
    const body = `${hostile}\n\n## Self-test report\n\n\`\`\`json\n{"a":1}\n\`\`\`\n`;
    assert.deepEqual(JSON.parse(extractReport(body).json), { a: 1 });
    assert.equal(extractReport(`## Self-test report\n\n${hostile}\n`).found, false);
  });

  test('a fence opener followed by a long whitespace run is handled', () => {
    const body = `## Self-test report\n\n\`\`\`${' '.repeat(60000)}!\n{"a":1}\n\`\`\`\n`;
    assert.equal(typeof extractReport(body).found, 'boolean');
  });

  test('a captured line longer than the syntax cap is kept in full', () => {
    const long = 'x'.repeat(5000);
    const body = `## Self-test report\n\n\`\`\`json\n{"a":"${long}"}\n\`\`\`\n`;
    assert.equal(JSON.parse(extractReport(body).json).a, long);
  });
});

describe('exemptions', () => {
  test('a non-fix PR passes with no report', () => {
    assert.equal(verdict({ body: '', headRef: 'chore/x', title: 'chore: x' }).reason, REASON.OK_NOT_A_FIX);
  });

  test('a maintainer author passes with no report, case-insensitively', () => {
    assert.equal(verdict({ body: '', authorLogin: 'Trek-E' }).reason, REASON.OK_MAINTAINER_AUTHOR);
  });

  test('a bot author passes with no report, even with no maintainer list', () => {
    assert.equal(verdict({ body: '', authorLogin: 'dependabot[bot]', maintainers: null }).reason, REASON.OK_BOT_AUTHOR);
  });

  test('a non-fix PR needs no maintainer list', () => {
    assert.equal(verdict({ body: '', headRef: 'wiki/x', title: 'docs: x', maintainers: null }).reason, REASON.OK_NOT_A_FIX);
  });
});

describe('a fix PR from an outsider: whole-report outcomes', () => {
  test('a valid report passes', () => {
    assert.deepEqual(verdict(), { ok: true, reason: REASON.OK_REPORT, problems: [] });
  });

  test('no report fails', () => {
    assert.equal(verdict({ body: '## Fix PR\n\nFixes #1\n' }).reason, REASON.FAIL_NO_REPORT);
  });

  test('a section without a json block fails as no report', () => {
    assert.equal(verdict({ body: '## Self-test report\n\ntested it, trust me\n' }).reason, REASON.FAIL_NO_REPORT);
  });

  test('invalid json fails', () => {
    assert.equal(verdict({ body: '## Self-test report\n\n```json\n{ nope\n```\n' }).reason, REASON.FAIL_MALFORMED_JSON);
  });

  test('json that is not an object fails the schema', () => {
    for (const json of ['[]', '42', 'null', '"x"']) {
      assert.equal(verdict({ body: `## Self-test report\n\n\`\`\`json\n${json}\n\`\`\`\n` }).reason, REASON.FAIL_SCHEMA, json);
    }
  });

  test('an unreadable maintainer list fails closed for a fix PR', () => {
    for (const bad of [null, undefined, new Set(), []]) {
      assert.equal(verdict({ maintainers: bad }).reason, REASON.FAIL_MAINTAINERS_UNREADABLE, String(bad));
    }
  });

  test('missing or non-string author, or a bad head sha, is invalid input', () => {
    assert.equal(verdict({ authorLogin: '' }).reason, REASON.FAIL_INPUT_INVALID);
    assert.equal(verdict({ authorLogin: 7 }).reason, REASON.FAIL_INPUT_INVALID);
    for (const headSha of ['', 'abc', 'z'.repeat(40), undefined, 42]) {
      assert.equal(verdict({ headSha }).reason, REASON.FAIL_INPUT_INVALID, String(headSha));
    }
  });

  test('the bot exemption is decided before the maintainer list is consulted', () => {
    assert.equal(verdict({ body: '', authorLogin: 'x[bot]', maintainers: new Set() }).reason, REASON.OK_BOT_AUTHOR);
  });
});

describe('validateReport: field by field', () => {
  test('every required field is required', () => {
    for (const key of ['schema', 'head_sha', 'tool', 'failing_first', 'commands', 'full_suite', 'environment', 'output_excerpt']) {
      const report = goodReport();
      delete report[key];
      assert.equal(reasonFor(report), REASON.FAIL_SCHEMA, key);
    }
  });

  test('schema, tool and commands', () => {
    for (const bad of [{ schema: 2 }, { schema: '1' }, { tool: 'vibes' }, { commands: [] }, { commands: [''] }, { commands: 'npm test' }, { commands: [1] }]) {
      assert.equal(reasonFor(goodReport(bad)), REASON.FAIL_SCHEMA, JSON.stringify(bad));
    }
  });

  test('every accepted tool passes', () => {
    for (const tool of ['gsd-test', 'npm-test', 'manual']) assert.equal(reasonFor(goodReport({ tool })), REASON.OK_REPORT, tool);
  });

  test('head_sha must be 40 hex characters', () => {
    for (const head_sha of ['c'.repeat(39), 'c'.repeat(41), 'g'.repeat(40), '', 7]) {
      assert.equal(reasonFor(goodReport({ head_sha })), REASON.FAIL_SCHEMA, String(head_sha));
    }
  });

  test('failing_first shape', () => {
    const cases = [
      [[], 'an array'],
      ['x', 'a string'],
      [{ fails_on_base: true, passes_on_head: true }, 'no test name'],
      [{ test: '', fails_on_base: true, passes_on_head: true }, 'empty test name'],
      [{ test: 't', fails_on_base: 'true', passes_on_head: true }, 'string boolean on base'],
      [{ test: 't', fails_on_base: true, passes_on_head: 1 }, 'numeric boolean on head'],
      [{ test: 't', fails_on_base: true }, 'missing passes_on_head'],
    ];
    for (const [failing_first, label] of cases) {
      assert.equal(reasonFor(goodReport({ failing_first })), REASON.FAIL_SCHEMA, label);
    }
  });

  test('a test that did not fail on the base, or does not pass on the head, fails failing-first', () => {
    for (const ff of [
      { test: 't', fails_on_base: false, passes_on_head: true },
      { test: 't', fails_on_base: true, passes_on_head: false },
      { test: 't', fails_on_base: false, passes_on_head: false },
    ]) {
      assert.equal(reasonFor(goodReport({ failing_first: ff })), REASON.FAIL_NOT_FAILING_FIRST, JSON.stringify(ff));
    }
  });

  test('an explained not-applicable failing-first passes', () => {
    assert.equal(reasonFor(goodReport({ failing_first: { not_applicable_reason: 'docs typo, no behaviour to test' } })), REASON.OK_REPORT);
  });

  test('an empty or non-string not-applicable explanation fails', () => {
    for (const reason of ['', '   ', 5, null, false]) {
      assert.equal(reasonFor(goodReport({ failing_first: { not_applicable_reason: reason } })), REASON.FAIL_SCHEMA, JSON.stringify(reason));
    }
  });

  test('full_suite shape', () => {
    const base = { command: 'npm test', result: 'passed', passed: 1, failed: 0 };
    const cases = [
      [[], 'array'],
      [{ ...base, command: '' }, 'empty command'],
      [{ ...base, result: 'green' }, 'unknown result'],
      [{ ...base, passed: -1 }, 'negative passed'],
      [{ ...base, passed: 1.5 }, 'fractional passed'],
      [{ ...base, passed: '1' }, 'string passed'],
      [{ ...base, failed: -1 }, 'negative failed'],
      [{ ...base, failed: '0' }, 'string failed'],
    ];
    for (const [full_suite, label] of cases) {
      assert.equal(reasonFor(goodReport({ full_suite })), REASON.FAIL_SCHEMA, label);
    }
  });

  test('a suite that did not pass fails, including one that claims passed with nothing run', () => {
    for (const suite of [
      { command: 'npm test', result: 'failed', passed: 9, failed: 1 },
      { command: 'npm test', result: 'skipped', passed: 0, failed: 0 },
      { command: 'npm test', result: 'passed', passed: 99, failed: 1 },
      { command: 'npm test', result: 'passed', passed: 0, failed: 0 },
    ]) {
      assert.equal(reasonFor(goodReport({ full_suite: suite })), REASON.FAIL_SUITE_NOT_PASSED, JSON.stringify(suite));
    }
  });

  test('environment must give both os and node', () => {
    for (const environment of [[], 'x', { os: 'a' }, { node: '24' }, { os: '', node: '24' }, { os: 'a', node: ' ' }]) {
      assert.equal(reasonFor(goodReport({ environment })), REASON.FAIL_SCHEMA, JSON.stringify(environment));
    }
  });

  test('the output excerpt is bounded', () => {
    assert.equal(reasonFor(goodReport({ output_excerpt: 'x'.repeat(EXCERPT_MAX - 1) })), REASON.OK_REPORT);
    assert.equal(reasonFor(goodReport({ output_excerpt: 'x'.repeat(EXCERPT_MAX) })), REASON.OK_REPORT);
    assert.equal(reasonFor(goodReport({ output_excerpt: 'x'.repeat(EXCERPT_MAX + 1) })), REASON.FAIL_SCHEMA);
    assert.equal(reasonFor(goodReport({ output_excerpt: '' })), REASON.FAIL_SCHEMA);
  });
});

describe('placeholders: a partly filled template never passes', () => {
  const placeholders = [
    ['head_sha', { head_sha: '<40-hex sha of your final commit>' }],
    ['environment.os', { environment: { os: '<your OS and version>', node: '24.1.0' } }],
    ['environment.node', { environment: { os: 'darwin 24', node: '<node --version>' } }],
    ['output_excerpt', { output_excerpt: '<the last lines of the passing run>' }],
    ['commands', { commands: ['<the command you ran>'] }],
    ['failing_first.test', { failing_first: { test: '<test file>', fails_on_base: true, passes_on_head: true } }],
    ['failing_first.not_applicable_reason', { failing_first: { not_applicable_reason: '<why>' } }],
    ['full_suite.command', { full_suite: { command: '<command>', result: 'passed', passed: 5, failed: 0 } }],
  ];
  for (const [name, override] of placeholders) {
    test(`${name} still a placeholder fails, and the problem names it`, () => {
      const v = verdict({ body: bodyWith(goodReport(override)) });
      assert.equal(v.reason, REASON.FAIL_SCHEMA);
      assert.ok(v.problems.some((p) => p.startsWith(`${name} is still the template placeholder`)), v.problems.join('|'));
    });
  }

  test('angle brackets that are part of real content are not a placeholder', () => {
    const report = goodReport({ output_excerpt: 'expected <a> to equal <b>', commands: ['node --test "tests/<x>.test.cjs" && echo <done>'] });
    assert.equal(reasonFor(report), REASON.OK_REPORT);
  });
});

describe('ordering of the substantive checks', () => {
  const stale = { head_sha: OLD };
  const notFailingFirst = { failing_first: { test: 't', fails_on_base: false, passes_on_head: true } };
  const suiteFailed = { full_suite: { command: 'npm test', result: 'failed', passed: 1, failed: 1 } };

  test('stale outranks not-failing-first and a failed suite', () => {
    assert.equal(reasonFor(goodReport({ ...stale, ...notFailingFirst, ...suiteFailed })), REASON.FAIL_STALE_SHA);
  });

  test('not-failing-first outranks a failed suite', () => {
    assert.equal(reasonFor(goodReport({ ...notFailingFirst, ...suiteFailed })), REASON.FAIL_NOT_FAILING_FIRST);
  });

  test('a schema problem outranks a stale sha, so one class is reported per push', () => {
    assert.equal(reasonFor(goodReport({ ...stale, tool: 'vibes' })), REASON.FAIL_SCHEMA);
  });

  test('the sha comparison is case-insensitive', () => {
    assert.equal(reasonFor(goodReport({ head_sha: HEAD.toUpperCase() })), REASON.OK_REPORT);
  });

  test('a report for an older head names both shas in the problem', () => {
    const v = verdict({ body: bodyWith(goodReport(stale)) });
    assert.ok(v.problems[0].includes(OLD) && v.problems[0].includes(HEAD));
  });
});

describe('properties', () => {
  // Always starts with a non-space so a generated value can never be blank.
  const alnum = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,39}$/);
  const validReportArb = fc.record({
    os: alnum,
    node: alnum,
    command: alnum,
    passed: fc.integer({ min: 1, max: 100000 }),
    excerpt: fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 .:=-]{0,199}$/),
    test: alnum,
    tool: fc.constantFrom('gsd-test', 'npm-test', 'manual'),
    n: fc.integer({ min: 1, max: 4 }),
  });

  test('every well-formed report for the current head passes, whatever the content', () => {
    fc.assert(
      fc.property(validReportArb, (g) => {
        const report = goodReport({
          tool: g.tool,
          failing_first: { test: g.test, fails_on_base: true, passes_on_head: true },
          commands: Array.from({ length: g.n }, (_, i) => `${g.command} ${i}`),
          full_suite: { command: g.command, result: 'passed', passed: g.passed, failed: 0 },
          environment: { os: g.os, node: g.node },
          output_excerpt: g.excerpt,
        });
        return reasonFor(report) === REASON.OK_REPORT;
      }),
      { numRuns: 200 },
    );
  });

  test('breaking exactly one sub-field of a well-formed report never passes', () => {
    const breakers = [
      (r) => { r.failing_first.fails_on_base = false; },
      (r) => { r.failing_first.passes_on_head = false; },
      (r) => { r.full_suite.failed = 1; },
      (r) => { r.full_suite.result = 'failed'; },
      (r) => { r.full_suite.passed = 0; },
      (r) => { r.head_sha = OLD; },
      (r) => { r.environment.os = ''; },
      (r) => { r.commands = []; },
      (r) => { r.output_excerpt = 'x'.repeat(EXCERPT_MAX + 1); },
      (r) => { r.schema = 0; },
    ];
    fc.assert(
      fc.property(fc.constantFrom(...breakers), (breakIt) => {
        const report = goodReport();
        breakIt(report);
        return reasonFor(report) !== REASON.OK_REPORT;
      }),
    );
  });

  test('any head sha other than the report\'s never passes', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9a-f]{40}$/), (other) => {
        fc.pre(other !== HEAD);
        return verdict({ headSha: other }).ok === false;
      }),
      { numRuns: 200 },
    );
  });

  test('extractReport never throws and never finds a report without the heading', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (body) => {
        const got = extractReport(body);
        if (/self-test report/i.test(body)) return typeof got.found === 'boolean';
        return got.found === false;
      }),
      { numRuns: 400 },
    );
  });

  test('extractReport returns the exact json it was given', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const body = `## Self-test report\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
        const got = extractReport(body);
        return got.found && JSON.stringify(JSON.parse(got.json)) === JSON.stringify(value);
      }),
      { numRuns: 200 },
    );
  });

  test('validateReport is total over arbitrary JSON values', () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        const got = validateReport(value, HEAD);
        return typeof got.ok === 'boolean' && typeof got.reason === 'string' && Array.isArray(got.problems);
      }),
      { numRuns: 300 },
    );
  });
});

describe('main(): environment wiring and exit code', () => {
  const SCRIPT = path.join(__dirname, '..', 'scripts', 'self-test-report-policy.cjs');

  function run(t, { maintainersText = 'trek-e\n', env = {}, body = bodyWith(goodReport()), title = 'fix(#1): thing', viaFiles = false } = {}) {
    const dir = createTempDir('gsd-5612-main-');
    t.after(() => cleanup(dir));
    const maintainersFile = path.join(dir, 'MAINTAINERS');
    const outputFile = path.join(dir, 'github_output');
    if (maintainersText !== null) fs.writeFileSync(maintainersFile, maintainersText);
    const bodyEnv = {};
    if (viaFiles) {
      fs.writeFileSync(path.join(dir, 'body.txt'), body);
      fs.writeFileSync(path.join(dir, 'title.txt'), title);
      bodyEnv.PR_BODY_FILE = path.join(dir, 'body.txt');
      bodyEnv.PR_TITLE_FILE = path.join(dir, 'title.txt');
    } else {
      bodyEnv.PR_BODY = body;
      bodyEnv.PR_TITLE = title;
    }
    const result = runNode([SCRIPT], {
      cwd: dir,
      timeoutMs: PROBE_TIMEOUT_MS,
      env: {
        PATH: process.env.PATH,
        MAINTAINERS_FILE: maintainersFile,
        GITHUB_OUTPUT: outputFile,
        PR_AUTHOR_LOGIN: 'outsider',
        HEAD_REF: 'fix/1-thing',
        HEAD_SHA: HEAD,
        ...bodyEnv,
        ...env,
      },
    });
    const outputs = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8') : '';
    return { result, outputs, dir, verdict: JSON.parse(result.stdout.trim().split('\n').pop() || 'null') };
  }

  test('a valid report exits 0 and writes ok=true', (t) => {
    const r = run(t);
    assert.equal(r.result.exitCode, 0);
    assert.equal(r.verdict.reason, REASON.OK_REPORT);
    assert.match(r.outputs, /^ok=true$/m);
    assert.match(r.outputs, new RegExp(`^reason=${REASON.OK_REPORT}$`, 'm'));
  });

  test('the body and title can be read from files (the workflow reads them live)', (t) => {
    const r = run(t, { viaFiles: true });
    assert.equal(r.result.exitCode, 0);
    assert.equal(r.verdict.reason, REASON.OK_REPORT);
  });

  test('a file-supplied body is used even when a stale PR_BODY env is also present', (t) => {
    const r = run(t, { viaFiles: true, env: { PR_BODY: '' } });
    assert.equal(r.verdict.reason, REASON.OK_REPORT);
  });

  test('an unreadable body or title file fails closed as invalid input', (t) => {
    const r = run(t, { viaFiles: true, env: { PR_BODY_FILE: '/nonexistent/body.txt' } });
    assert.equal(r.result.exitCode, 1);
    assert.equal(r.verdict.reason, REASON.FAIL_INPUT_INVALID);
    const r2 = run(t, { viaFiles: true, env: { PR_TITLE_FILE: '/nonexistent/title.txt' } });
    assert.equal(r2.verdict.reason, REASON.FAIL_INPUT_INVALID);
  });

  test('a missing report exits 1, writes ok=false, and annotates the problem', (t) => {
    const r = run(t, { body: '## Fix PR\n' });
    assert.equal(r.result.exitCode, 1);
    assert.equal(r.verdict.reason, REASON.FAIL_NO_REPORT);
    assert.match(r.outputs, /^ok=false$/m);
    assert.match(r.result.stderr, /^::error::Self-test report: /m);
  });

  test('a stale report exits 1 and names the current head in the annotation', (t) => {
    const r = run(t, { body: bodyWith(goodReport({ head_sha: OLD })) });
    assert.equal(r.result.exitCode, 1);
    assert.equal(r.verdict.reason, REASON.FAIL_STALE_SHA);
    assert.ok(r.result.stderr.includes(HEAD));
  });

  test('a maintainer author exits 0 without a report', (t) => {
    const r = run(t, { env: { PR_AUTHOR_LOGIN: 'trek-e' }, body: '' });
    assert.equal(r.result.exitCode, 0);
    assert.equal(r.verdict.reason, REASON.OK_MAINTAINER_AUTHOR);
  });

  test('a missing maintainer file fails closed for a fix PR but not for other work', (t) => {
    assert.equal(run(t, { maintainersText: null }).verdict.reason, REASON.FAIL_MAINTAINERS_UNREADABLE);
    assert.equal(run(t, { maintainersText: null, title: 'chore: x', env: { HEAD_REF: 'chore/x' } }).verdict.reason, REASON.OK_NOT_A_FIX);
  });

  test('attacker text that reaches an annotation cannot start a second workflow command', (t) => {
    // The JSON syntax error is the one place attacker text reaches an annotation:
    // the parser echoes part of the input, including a newline and "::error::".
    const evil = '## Self-test report\n\n```json\n{"a": "x\n::error::forged\n::set-output name=pwn::1"\n```\n';
    const r = run(t, { body: evil });
    assert.equal(r.result.exitCode, 1);
    assert.equal(r.verdict.reason, REASON.FAIL_MALFORMED_JSON);
    const lines = r.result.stderr.split('\n').filter((l) => l !== '');
    assert.ok(lines.length >= 1);
    for (const line of lines) assert.ok(line.startsWith('::error::Self-test report: '), line);
    assert.equal(lines.filter((l) => l.includes('::set-output')).every((l) => l.startsWith('::error::')), true);
  });
});
