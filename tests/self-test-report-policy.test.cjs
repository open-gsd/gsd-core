'use strict';

// #5612 — the self-test report: a fix PR from a non-maintainer carries a
// head-bound JSON record of what the submitter ran. Tests assert on the typed
// REASON enum, never on free text.
//
// What this check must NOT do is pass a report that is stale, a template
// placeholder, claims a failing-first test that did not fail on the base, or
// claims a suite that did not pass. It validates shape and sha binding; it does
// not, and cannot, prove the run happened.

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

function bodyWith(report, { heading = '## Self-test report', fence = '```' } = {}) {
  return `## Fix PR\n\nFixes #1\n\n${heading}\n\n${fence}json\n${JSON.stringify(report, null, 2)}\n${fence}\n\n## Checklist\n- [x] done\n`;
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

  test('a non-json fence in the section is skipped and a later json fence is used', () => {
    const body = '## Self-test report\n\n```bash\nnpm test\n```\n\n```json\n{"a":1}\n```\n';
    assert.deepEqual(JSON.parse(extractReport(body).json), { a: 1 });
  });

  test('tilde fences and CRLF line endings work', () => {
    const body = '## Self-test report\r\n\r\n~~~json\r\n{"a":1}\r\n~~~\r\n';
    assert.equal(extractReport(body).found, true);
  });

  test('an unclosed fence yields nothing', () => {
    assert.equal(extractReport('## Self-test report\n\n```json\n{"a":1}\n').found, false);
  });

  test('empty and non-string bodies yield nothing', () => {
    for (const body of ['', null, undefined, 42]) assert.equal(extractReport(body).found, false);
  });
});

describe('exemptions', () => {
  test('a non-fix PR passes with no report', () => {
    assert.deepEqual(verdict({ body: '', headRef: 'chore/x', title: 'chore: x' }).reason, REASON.OK_NOT_A_FIX);
  });

  test('a maintainer author passes with no report, case-insensitively', () => {
    assert.equal(verdict({ body: '', authorLogin: 'Trek-E' }).reason, REASON.OK_MAINTAINER_AUTHOR);
  });

  test('a bot author passes with no report', () => {
    assert.equal(verdict({ body: '', authorLogin: 'dependabot[bot]' }).reason, REASON.OK_BOT_AUTHOR);
  });

  test('a non-fix PR needs no maintainer list', () => {
    assert.equal(verdict({ body: '', headRef: 'wiki/x', title: 'docs: x', maintainers: null }).reason, REASON.OK_NOT_A_FIX);
  });
});

describe('a fix PR from an outsider', () => {
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

  test('the template placeholder fails', () => {
    const placeholder = goodReport({ head_sha: '<40-hex sha of your final commit>' });
    const v = verdict({ body: bodyWith(placeholder) });
    assert.equal(v.reason, REASON.FAIL_SCHEMA);
    assert.ok(v.problems.some((p) => p.includes('head_sha')));
  });

  test('a report for an older head is stale', () => {
    assert.equal(verdict({ body: bodyWith(goodReport({ head_sha: OLD })) }).reason, REASON.FAIL_STALE_SHA);
  });

  test('the sha comparison is case-insensitive', () => {
    assert.equal(verdict({ body: bodyWith(goodReport({ head_sha: HEAD.toUpperCase() })) }).ok, true);
  });

  test('a test that did not fail on the base fails failing-first', () => {
    const report = goodReport({ failing_first: { test: 't.test.cjs', fails_on_base: false, passes_on_head: true } });
    assert.equal(verdict({ body: bodyWith(report) }).reason, REASON.FAIL_NOT_FAILING_FIRST);
  });

  test('a test that does not pass on the head fails failing-first', () => {
    const report = goodReport({ failing_first: { test: 't.test.cjs', fails_on_base: true, passes_on_head: false } });
    assert.equal(verdict({ body: bodyWith(report) }).reason, REASON.FAIL_NOT_FAILING_FIRST);
  });

  test('an explained not-applicable failing-first passes', () => {
    const report = goodReport({ failing_first: { not_applicable_reason: 'docs typo, no behaviour to test' } });
    assert.equal(verdict({ body: bodyWith(report) }).ok, true);
  });

  test('an empty not-applicable explanation fails', () => {
    for (const reason of ['', '   ', 5]) {
      const report = goodReport({ failing_first: { not_applicable_reason: reason } });
      assert.equal(verdict({ body: bodyWith(report) }).reason, REASON.FAIL_SCHEMA, JSON.stringify(reason));
    }
  });

  test('a suite that did not pass fails', () => {
    for (const suite of [
      { command: 'npm test', result: 'failed', passed: 9, failed: 1 },
      { command: 'npm test', result: 'skipped', passed: 0, failed: 0 },
      { command: 'npm test', result: 'passed', passed: 99, failed: 1 },
    ]) {
      const v = verdict({ body: bodyWith(goodReport({ full_suite: suite })) });
      assert.equal(v.reason, REASON.FAIL_SUITE_NOT_PASSED, JSON.stringify(suite));
    }
  });

  test('every required field is required', () => {
    for (const key of ['schema', 'head_sha', 'tool', 'failing_first', 'commands', 'full_suite', 'environment', 'output_excerpt']) {
      const report = goodReport();
      delete report[key];
      assert.equal(verdict({ body: bodyWith(report) }).reason, REASON.FAIL_SCHEMA, key);
    }
  });

  test('a wrong schema version, tool, or empty commands fail', () => {
    for (const bad of [{ schema: 2 }, { schema: '1' }, { tool: 'vibes' }, { commands: [] }, { commands: [''] }, { commands: 'npm test' }]) {
      assert.equal(verdict({ body: bodyWith(goodReport(bad)) }).reason, REASON.FAIL_SCHEMA, JSON.stringify(bad));
    }
  });

  test('every accepted tool passes', () => {
    for (const tool of ['gsd-test', 'npm-test', 'manual']) assert.equal(verdict({ body: bodyWith(goodReport({ tool })) }).ok, true, tool);
  });

  test('the output excerpt is bounded', () => {
    assert.equal(verdict({ body: bodyWith(goodReport({ output_excerpt: 'x'.repeat(EXCERPT_MAX) })) }).ok, true);
    assert.equal(verdict({ body: bodyWith(goodReport({ output_excerpt: 'x'.repeat(EXCERPT_MAX + 1) })) }).reason, REASON.FAIL_SCHEMA);
  });

  test('an unreadable maintainer list fails closed for a fix PR', () => {
    for (const bad of [null, undefined, new Set(), []]) {
      assert.equal(verdict({ maintainers: bad }).reason, REASON.FAIL_MAINTAINERS_UNREADABLE, String(bad));
    }
  });

  test('missing author or a bad head sha is invalid input', () => {
    assert.equal(verdict({ authorLogin: '' }).reason, REASON.FAIL_INPUT_INVALID);
    for (const headSha of ['', 'abc', 'z'.repeat(40), undefined]) {
      assert.equal(verdict({ headSha }).reason, REASON.FAIL_INPUT_INVALID, String(headSha));
    }
  });
});

describe('properties', () => {
  test('extractReport never throws and never reports found without a heading', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (body) => {
        const got = extractReport(body);
        if (!/self-test report/i.test(body)) return got.found === false;
        return typeof got.found === 'boolean';
      }),
      { numRuns: 400 },
    );
  });

  test('a valid report with any one required field removed never passes', () => {
    const keys = ['schema', 'head_sha', 'tool', 'failing_first', 'commands', 'full_suite', 'environment', 'output_excerpt'];
    fc.assert(
      fc.property(fc.constantFrom(...keys), (key) => {
        const report = goodReport();
        delete report[key];
        return verdict({ body: bodyWith(report) }).ok === false;
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

  function run(t, { maintainersText = 'trek-e\n', env = {} } = {}) {
    const dir = createTempDir('gsd-5612-main-');
    t.after(() => cleanup(dir));
    const maintainersFile = path.join(dir, 'MAINTAINERS');
    const outputFile = path.join(dir, 'github_output');
    if (maintainersText !== null) fs.writeFileSync(maintainersFile, maintainersText);
    const result = runNode([SCRIPT], {
      cwd: dir,
      timeoutMs: PROBE_TIMEOUT_MS,
      env: {
        PATH: process.env.PATH,
        MAINTAINERS_FILE: maintainersFile,
        GITHUB_OUTPUT: outputFile,
        PR_AUTHOR_LOGIN: 'outsider',
        HEAD_REF: 'fix/1-thing',
        PR_TITLE: 'fix(#1): thing',
        HEAD_SHA: HEAD,
        PR_BODY: bodyWith(goodReport()),
        ...env,
      },
    });
    const outputs = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8') : '';
    return { result, outputs, verdict: JSON.parse(result.stdout.trim().split('\n').pop() || 'null') };
  }

  test('a valid report exits 0 and writes ok=true', (t) => {
    const r = run(t);
    assert.equal(r.result.exitCode, 0);
    assert.equal(r.verdict.reason, REASON.OK_REPORT);
    assert.match(r.outputs, /^ok=true$/m);
  });

  test('a missing report exits 1, writes ok=false, and annotates the problem', (t) => {
    const r = run(t, { env: { PR_BODY: '## Fix PR\n' } });
    assert.equal(r.result.exitCode, 1);
    assert.equal(r.verdict.reason, REASON.FAIL_NO_REPORT);
    assert.match(r.outputs, /^ok=false$/m);
    assert.match(r.result.stderr, /^::error::Self-test report: /m);
  });

  test('a stale report exits 1 and names the current head in the annotation', (t) => {
    const r = run(t, { env: { PR_BODY: bodyWith(goodReport({ head_sha: OLD })) } });
    assert.equal(r.result.exitCode, 1);
    assert.equal(r.verdict.reason, REASON.FAIL_STALE_SHA);
    assert.ok(r.result.stderr.includes(HEAD));
  });

  test('a maintainer author exits 0 without a report', (t) => {
    const r = run(t, { env: { PR_AUTHOR_LOGIN: 'trek-e', PR_BODY: '' } });
    assert.equal(r.result.exitCode, 0);
    assert.equal(r.verdict.reason, REASON.OK_MAINTAINER_AUTHOR);
  });

  test('a missing maintainer file fails closed for a fix PR but not for other work', (t) => {
    assert.equal(run(t, { maintainersText: null }).verdict.reason, REASON.FAIL_MAINTAINERS_UNREADABLE);
    assert.equal(run(t, { maintainersText: null, env: { HEAD_REF: 'chore/x', PR_TITLE: 'chore: x' } }).verdict.reason, REASON.OK_NOT_A_FIX);
  });

  test('a body that tries to forge an annotation cannot add a line', (t) => {
    const evil = bodyWith(goodReport({ tool: 'x\n::error::forged' }));
    const r = run(t, { env: { PR_BODY: evil } });
    assert.equal(r.result.exitCode, 1);
    const annotations = r.result.stderr.split('\n').filter((l) => l.startsWith('::'));
    assert.ok(annotations.every((l) => l.startsWith('::error::Self-test report: ')));
    assert.equal(r.result.stderr.includes('forged'), false);
  });
});
