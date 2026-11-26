'use strict';

/**
 * #6677: tests/helpers/bash-probe.cjs decides whether a bash-block behavior test runs, skips or
 * fails at load. Every suite that runs a documented bash block leans on it, and a skip on a host without curl or jq left no trace
 * (the gsd-test tester image has neither). The contract tested here: a tool present means the
 * suite runs; a tool missing under CI, or under GSD_REQUIRE_BASH_TOOLS, fails the file at load; a
 * tool missing anywhere else skips, and the skip is announced as a named skipped test.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fc = require('./helpers/fast-check-setup.cjs');
const { cleanup } = require('./helpers.cjs');
const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { isolatedEnv } = require('./helpers/isolated-env.cjs');
const probe = require('./helpers/bash-probe.cjs');

const { createSkipUnless, REQUIRE_ENV_KEYS } = probe;
const MISSING = 'gsd-no-such-tool-6677';

/** A skipUnless over a fake host: `present` names the tools it has, `env` is its environment. */
function hostWith(present, env = {}) {
  const announced = [];
  const skipUnless = createSkipUnless({
    have: (tool) => present.includes(tool),
    env,
    announce: (reason) => announced.push(reason),
  });
  return { skipUnless, announced };
}

describe('skipUnless: a tool is present', () => {
  test('every tool present: the suite runs and nothing is announced', () => {
    const { skipUnless, announced } = hostWith(['bash', 'jq']);
    assert.strictEqual(skipUnless('bash', 'jq'), false);
    assert.deepStrictEqual(announced, []);
  });

  test('a tool present under CI is still not a skip', () => {
    const { skipUnless } = hostWith(['bash'], { CI: 'true' });
    assert.strictEqual(skipUnless('bash'), false);
  });

  test('a tool present under GSD_REQUIRE_BASH_TOOLS is not a skip either', () => {
    const { skipUnless, announced } = hostWith(['bash', 'jq'], { GSD_REQUIRE_BASH_TOOLS: '1' });
    assert.strictEqual(skipUnless('bash', 'jq'), false);
    assert.deepStrictEqual(announced, []);
  });

  test('no tools asked for: nothing to be missing', () => {
    const { skipUnless } = hostWith([], { CI: 'true' });
    assert.strictEqual(skipUnless(), false);
  });
});

describe('skipUnless: a tool is missing and neither switch is set', () => {
  test('returns the reason and announces it once', () => {
    const { skipUnless, announced } = hostWith(['bash']);
    const reason = skipUnless('bash', 'curl');
    assert.strictEqual(reason, 'bash and curl are required');
    assert.deepStrictEqual(announced, [reason]);
  });

  test('one tool is "is required", several are "are required"', () => {
    const { skipUnless } = hostWith([]);
    assert.strictEqual(skipUnless('jq'), 'jq is required');
    assert.strictEqual(skipUnless('bash', 'jq', 'node'), 'bash and jq and node are required');
  });

  test('the missing tool can be the first, the last or all of them', () => {
    for (const present of [['jq'], ['bash'], []]) {
      const { skipUnless, announced } = hostWith(present);
      assert.strictEqual(skipUnless('bash', 'jq'), 'bash and jq are required');
      assert.strictEqual(announced.length, 1);
    }
  });

  test('an empty CI is unset: it skips', () => {
    const { skipUnless, announced } = hostWith([], { CI: '' });
    assert.strictEqual(skipUnless('curl'), 'curl is required');
    assert.strictEqual(announced.length, 1);
  });
});

describe('skipUnless: a tool is missing under a switch', () => {
  test('CI fails the file at load, with the text callers and docs already rely on, and announces nothing', () => {
    const { skipUnless, announced } = hostWith([], { CI: 'true' });
    assert.throws(() => skipUnless('curl'), /curl is required under CI: a bash-block behavior test must run, not skip/);
    assert.deepStrictEqual(announced, []);
  });

  test('GSD_REQUIRE_BASH_TOOLS fails the file at load and names itself', () => {
    const { skipUnless, announced } = hostWith([], { GSD_REQUIRE_BASH_TOOLS: '1' });
    assert.throws(() => skipUnless('jq'), /jq is required under GSD_REQUIRE_BASH_TOOLS: a bash-block behavior test must run, not skip/);
    assert.deepStrictEqual(announced, []);
  });

  test('with both set the error names CI, the first key in REQUIRE_ENV_KEYS', () => {
    assert.deepStrictEqual(REQUIRE_ENV_KEYS, ['CI', 'GSD_REQUIRE_BASH_TOOLS']);
    const { skipUnless } = hostWith([], { CI: 'true', GSD_REQUIRE_BASH_TOOLS: '1' });
    assert.throws(() => skipUnless('curl'), /under CI:/);
  });

  test('the environment is read when skipUnless is called, not when it is created', () => {
    const env = {};
    const skipUnless = createSkipUnless({ have: () => false, env, announce: () => {} });
    assert.strictEqual(skipUnless('curl'), 'curl is required');
    env.GSD_REQUIRE_BASH_TOOLS = '1';
    assert.throws(() => skipUnless('curl'), /under GSD_REQUIRE_BASH_TOOLS/);
  });
});

describe('skipUnless: property over tool subsets and switch combinations', () => {
  const TOOLS = ['bash', 'curl', 'jq', 'node'];
  test('false exactly when every asked tool is present; a throw exactly when one is missing under a switch; else the reason', () => {
    fc.assert(fc.property(
      fc.subarray(TOOLS),
      fc.subarray(TOOLS, { minLength: 1 }),
      fc.boolean(),
      fc.boolean(),
      (present, asked, ci, requireTools) => {
        const env = {};
        if (ci) env.CI = 'true';
        if (requireTools) env.GSD_REQUIRE_BASH_TOOLS = '1';
        const { skipUnless, announced } = hostWith(present, env);
        const allPresent = asked.every((tool) => present.includes(tool));
        if (allPresent) return skipUnless(...asked) === false && announced.length === 0;
        if (ci || requireTools) {
          try { skipUnless(...asked); return false; } catch (err) { return /must run, not skip/.test(err.message) && announced.length === 0; }
        }
        const reason = skipUnless(...asked);
        return typeof reason === 'string' && announced.length === 1 && announced[0] === reason;
      },
    ));
  });
});

describe('the default skipUnless against this host', () => {
  test('bash, which every bash-block test needs, resolves', () => {
    assert.strictEqual(probe.have('bash'), true);
  });

  test('a tool that does not exist does not', () => {
    assert.strictEqual(probe.have(MISSING), false);
  });

  test('a name with shell syntax is looked up as a name, never run', () => {
    // As part of the shell text this would run `true` after the lookup and answer true.
    assert.strictEqual(probe.have(`${MISSING}; true`), false);
    assert.strictEqual(probe.have(`${MISSING} || true`), false);
  });
});

describe('a guarded suite, run for real (fixture under node --test)', () => {
  const PROBE = path.join(__dirname, 'helpers', 'bash-probe.cjs');

  /** Run a one-suite fixture guarded by `tool` in a child with only PATH, plus `extra`. */
  function runFixture(t, tool, extra = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-6677-'));
    t.after(() => cleanup(dir));
    const file = path.join(dir, 'guarded.test.cjs');
    fs.writeFileSync(file, [
      "'use strict';",
      "const { describe, test } = require('node:test');",
      `const { skipUnless } = require(${JSON.stringify(PROBE)});`,
      `const SKIP = skipUnless(${JSON.stringify(tool)});`,
      "describe('guarded', { skip: SKIP }, () => { test('runs only when the tool is here', () => {}); });",
      '',
    ].join('\n'));
    const base = { PATH: process.env.PATH };
    if (process.env.SystemRoot) base.SystemRoot = process.env.SystemRoot;
    // tap is the reporter scripts/run-tests.cjs gives its own chunks; the seam's default bound applies.
    const result = runNode(['--test', '--test-reporter=tap', file], {
      env: isolatedEnv({ home: dir, base, override: extra }),
    });
    assert.strictEqual(result.outcome, OUTCOME.EXITED, result.stderr);
    return result;
  }

  test('a missing tool off CI is a visible skipped test, and the run still passes', (t) => {
    const r = runFixture(t, MISSING);
    assert.strictEqual(r.exitCode, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^# skipped 1$/m);
    assert.match(r.stdout, new RegExp(`${MISSING} is required`));
  });

  test('the same fixture under GSD_REQUIRE_BASH_TOOLS fails at load and says why', (t) => {
    const r = runFixture(t, MISSING, { GSD_REQUIRE_BASH_TOOLS: '1' });
    assert.notStrictEqual(r.exitCode, 0);
    assert.match(r.stdout + r.stderr, /under GSD_REQUIRE_BASH_TOOLS/);
  });

  test('the same fixture under CI fails at load too', (t) => {
    const r = runFixture(t, MISSING, { CI: 'true' });
    assert.notStrictEqual(r.exitCode, 0);
    assert.match(r.stdout + r.stderr, /under CI/);
  });

  test('a present tool under the switch still runs the suite', (t) => {
    const r = runFixture(t, 'bash', { GSD_REQUIRE_BASH_TOOLS: '1' });
    assert.strictEqual(r.exitCode, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^# skipped 0$/m);
    assert.match(r.stdout, /^# pass 1$/m);
  });

  test('a present tool runs the suite: nothing skipped', (t) => {
    const r = runFixture(t, 'bash');
    assert.strictEqual(r.exitCode, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^# skipped 0$/m);
    assert.match(r.stdout, /^# pass 1$/m);
  });
});
