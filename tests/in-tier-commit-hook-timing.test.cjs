/**
 * #5473 — time the 112KB validate-commit rows INSIDE the real macOS conformance
 * tier, varying which bash runs the hook, its environment (including locale) and
 * its spawn mode (see scripts/diagnose-validate-commit-in-tier.cjs for what and why).
 *
 * This file is in the macOS tier on purpose: the tier's shell step runs zsh, and
 * that signal is what puts a test file there, so it runs beside the very files
 * whose contention is under study. It asserts no timing. The pure helpers are
 * tested everywhere; the measurement runs only on macOS (os.type() is 'Darwin').
 * TEMPORARY: delete this file and the module once #5473 is resolved.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanup } = require('./helpers.cjs');

const {
  describeEnv,
  without,
  findOnPath,
  buildCells,
  roundOrder,
  runSync,
  runDetached,
  inTierReport,
  SHOWN_ENV,
  SYSTEM_BASH,
} = require('../scripts/diagnose-validate-commit-in-tier.cjs');
const { makeProject, hookEnv } = require('../scripts/diagnose-validate-commit-phases.cjs');

const onMac = os.type() === 'Darwin';
const macOnly = !onMac && 'macOS-only';

describe('describeEnv', () => {
  test('names are sorted; only allowlisted values are shown', () => {
    const { names, shown } = describeEnv({ ZED: '1', GITHUB_TOKEN: 'secret', NODE_TEST_CONTEXT: 'child', ALPHA: '2' });
    assert.deepEqual(names, ['ALPHA', 'GITHUB_TOKEN', 'NODE_TEST_CONTEXT', 'ZED']);
    assert.deepEqual(shown, { NODE_TEST_CONTEXT: 'child' });
    assert.ok(!JSON.stringify(shown).includes('secret'));
  });

  test('NODE_OPTIONS is reported by name only: it can carry --require paths and flags', () => {
    const { names, shown } = describeEnv({ NODE_OPTIONS: '--require /secret/path' });
    assert.deepEqual(names, ['NODE_OPTIONS']);
    assert.deepEqual(shown, {});
  });

  test('every allowlisted name is shown when present and none are invented when absent', () => {
    const all = Object.fromEntries(SHOWN_ENV.map((k) => [k, 'v']));
    assert.deepEqual(Object.keys(describeEnv(all).shown).sort(), [...SHOWN_ENV].sort());
    assert.deepEqual(describeEnv({}).shown, {});
  });

  test('an inherited property is not a variable', () => {
    const env = Object.create({ LANG: 'inherited' });
    assert.deepEqual(describeEnv(env).shown, {});
  });
});

describe('without', () => {
  test('drops exactly the variables whose name starts with a prefix, and does not mutate its input', () => {
    const env = { NODE_A: '1', NODEX: '2', GSD_B: '3', RUN_TESTS_C: '4', PATH: '/bin' };
    assert.deepEqual(without(env, ['NODE_']), { NODEX: '2', GSD_B: '3', RUN_TESTS_C: '4', PATH: '/bin' });
    assert.deepEqual(without(env, ['GSD_', 'RUN_TESTS_']), { NODE_A: '1', NODEX: '2', PATH: '/bin' });
    assert.deepEqual(without(env, []), env);
    assert.equal(env.NODE_A, '1');
  });
});

// An executable file to copy (the copy keeps the source's permission bits); the
// tests need none where there is no /bin/sh.
const SOME_EXECUTABLE = '/bin/sh';
const noExecutable = !fs.existsSync(SOME_EXECUTABLE) && 'needs /bin/sh to copy as an executable';

describe('findOnPath', () => {
  test('returns the FIRST executable file on the path, as spawn would resolve it', { skip: noExecutable }, () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-find-a-'));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-find-b-'));
    try {
      for (const dir of [a, b]) fs.copyFileSync(SOME_EXECUTABLE, path.join(dir, 'tool'));
      assert.equal(findOnPath('tool', `${a}${path.delimiter}${b}`), path.join(a, 'tool'));
      assert.equal(findOnPath('tool', `${b}${path.delimiter}${a}`), path.join(b, 'tool'));
    } finally {
      cleanup(a);
      cleanup(b);
    }
  });

  test('skips a non-executable file, a directory and an empty entry; null when absent', { skip: noExecutable }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-find-c-'));
    try {
      fs.writeFileSync(path.join(dir, 'plain'), 'x'); // default mode: not executable
      fs.mkdirSync(path.join(dir, 'subdir'));
      assert.equal(findOnPath('plain', dir), null);
      assert.equal(findOnPath('subdir', dir), null);
      assert.equal(findOnPath('missing', `${path.delimiter}${dir}`), null);
      assert.equal(findOnPath('x', ''), null);
      assert.equal(findOnPath('x', undefined), null);
    } finally {
      cleanup(dir);
    }
  });
});

describe('buildCells', () => {
  const base = { PATH: '/p', HOME: '/h', NODE_TEST_CONTEXT: 'child', GSD_X: '1', RUN_TESTS_Y: '2', LANG: 'en_US.UTF-8' };

  test('with a PATH bash that is not /bin/bash, both interpreters are timed in both spawn modes', () => {
    const cells = buildCells(base, '/opt/homebrew/bin/bash');
    const real = cells.filter((c) => c.label === 'PATH bash, inherited env');
    assert.deepEqual(real.map((c) => c.mode), ['sync', 'async']);
    const system = cells.filter((c) => c.bin === SYSTEM_BASH);
    assert.deepEqual(system.map((c) => c.mode), ['sync', 'async']);
  });

  test('when the PATH bash IS /bin/bash the duplicate interpreter cells are left out', () => {
    const cells = buildCells(base, SYSTEM_BASH);
    assert.equal(cells.filter((c) => c.label.startsWith('/bin/bash')).length, 0);
    assert.equal(cells.length, buildCells(base, '/opt/homebrew/bin/bash').length - 2);
  });

  test('the first cell is the real row\'s environment unchanged', () => {
    assert.deepEqual(buildCells(base, '/b')[0].env, base);
  });

  test('minimal env is exactly PATH and HOME, a missing HOME being the empty string', () => {
    const minimal = (b) => buildCells(b, '/b').find((c) => c.label.includes('minimal')).env;
    assert.deepEqual(minimal(base), { PATH: '/p', HOME: '/h' });
    assert.deepEqual(minimal({ PATH: '/p' }), { PATH: '/p', HOME: '' });
  });

  test('each family variant removes one family and nothing else; locale variants set only LC_ALL', () => {
    const cells = buildCells(base, '/b');
    const find = (needle) => cells.find((c) => c.label.includes(needle)).env;
    assert.deepEqual(Object.keys(find('without NODE_')).sort(), ['GSD_X', 'HOME', 'LANG', 'PATH', 'RUN_TESTS_Y']);
    assert.deepEqual(Object.keys(find('without GSD_')).sort(), ['HOME', 'LANG', 'NODE_TEST_CONTEXT', 'PATH']);
    assert.equal(find('LC_ALL=C').LC_ALL, 'C');
    assert.equal(find('en_US.UTF-8').LC_ALL, 'en_US.UTF-8');
    assert.equal(base.LC_ALL, undefined);
  });
});

describe('roundOrder', () => {
  test('visits every cell exactly once per round, starting one further along each round', () => {
    assert.deepEqual(roundOrder(3, 0), [0, 1, 2]);
    assert.deepEqual(roundOrder(3, 1), [1, 2, 0]);
    assert.deepEqual(roundOrder(3, 2), [2, 0, 1]);
    assert.deepEqual(roundOrder(3, 3), [0, 1, 2]);
  });

  test('boundary: zero and one cell', () => {
    assert.deepEqual(roundOrder(0, 5), []);
    assert.deepEqual(roundOrder(1, 7), [0]);
  });
});

describe('real runs', () => {
  test('runSync and runDetached agree with the hook on a conforming and a blocked commit', { skip: macOnly }, async () => {
    const project = makeProject();
    try {
      const env = hookEnv();
      for (const run of [runSync, runDetached]) {
        const ok = await run(project, 'git commit -m "feat: add thing"', env, SYSTEM_BASH);
        assert.equal(ok.status, 0);
        assert.equal(ok.killed, false);
        const blocked = await run(project, 'git commit -m "wibble wobble"', env, SYSTEM_BASH);
        assert.equal(blocked.status, 2);
      }
    } finally {
      cleanup(project);
    }
  });
});

describe('inTierReport', () => {
  test('rejects a run count that is not a positive integer', async () => {
    for (const bad of [0, -1, 1.5, NaN]) await assert.rejects(inTierReport({ runs: bad }), RangeError);
  });

  test('measures inside the tier and prints the report (no timing asserted)', { skip: macOnly }, async () => {
    const { text, ok } = await inTierReport();
    // The report is the deliverable: it goes to the job log and the job summary.
    console.log(text);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
    assert.ok(ok, text);
    assert.match(text, /INSIDE the conformance tier/);
    assert.match(text, /`bash` on the inherited PATH: /);
    assert.match(text, /async \+ detached \+ group kill/);
    assert.match(text, /LC_ALL=en_US\.UTF-8/);
  });
});
