'use strict';

/**
 * Regression tests for #5933: the global `--default <value>` option took the
 * next token as its value even when that token was another flag, and removed
 * it from argv before command routing. `migrate-config --default --dry-run`
 * therefore lost `--dry-run` and wrote the config.
 *
 * `--default` now refuses a missing or `--`-led value with the same usage error
 * as its siblings `--cwd`, `--project-dir`, `--ws` and `--pick`, before any token is
 * removed. An explicit empty string and ordinary values keep working.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { createTempProject, cleanup } = require('./helpers.cjs');
const { runCli } = require('./helpers/cli-negative.cjs');
const { runCliSync } = require('../gsd-core/bin/gsd-tools.cjs');
const { ERROR_REASON } = require('../gsd-core/bin/lib/io.cjs');

// The parent's GSD_* variables (GSD_WORKSTREAM, GSD_PROJECT_DIR, ...) would be
// read before the refusals run, so every call unsets them. An undefined value
// unsets a variable for both the spawned and the in-process call.
const GSD_UNSET = Object.fromEntries(
  Object.keys(process.env).filter((name) => /^GSD_/i.test(name)).map((name) => [name, undefined]),
);

function run(argv, cwd) {
  return runCli(argv, { cwd, env: GSD_UNSET });
}

// The same call in this process, for the properties below (no spawn per run).
function runInProcess(argv, cwd) {
  const { exitCode, stdout, stderr } = runCliSync({
    argv: ['--json-errors', ...argv],
    cwd,
    env: { ...process.env, ...GSD_UNSET },
  });
  let reason = null;
  try {
    reason = JSON.parse(stderr.trim()).reason;
  } catch {
    // Not a --json-errors payload: reason stays null and the assertion names it.
  }
  return { exitCode, stdout, reason };
}

function assertUsageRefusal(result) {
  assert.notEqual(result.status, 0, `expected a non-zero exit, got ${result.status}`);
  assert.equal(result.reason, ERROR_REASON.USAGE);
  assert.equal(result.stdout, '', 'a refused flag must print no result');
  assert.equal(result.hasStackTrace, false);
}

describe('--default refuses a missing or flag-shaped value (#5933)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-default-5933-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('migrate-config --default --dry-run is refused and the config is not rewritten', () => {
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ depth: 'comprehensive' }, null, 2), 'utf-8');
    const before = fs.readFileSync(configPath);

    const result = run(['migrate-config', '--default', '--dry-run'], tmpDir);

    assertUsageRefusal(result);
    assert.deepEqual(fs.readFileSync(configPath), before, 'the config must be byte-for-byte unchanged');
  });

  for (const value of ['--foo', '--', '--dry-run']) {
    test(`config-get <absent> --default ${value} is refused`, () => {
      const result = run(['config-get', 'absent.key', '--default', value], tmpDir);
      assertUsageRefusal(result);
    });
  }

  test('a bare trailing --default is refused instead of becoming an empty default', () => {
    const result = run(['config-get', 'absent.key', '--default'], tmpDir);
    assertUsageRefusal(result);
  });

  test('a bare trailing --default after --raw is refused', () => {
    const result = run(['config-get', 'absent.key', '--raw', '--default'], tmpDir);
    assertUsageRefusal(result);
  });
});

describe('--default keeps accepting real values (#5933)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-default-5933-ok-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // Boundary rows: "" (limit - 1), "x" (limit), "--x" (limit + 1, refused above
  // and in the parity block below). Single-dash and whitespace-only values are
  // values: only the `--` prefix is refused, as for the sibling options.
  // [argv value, value the JSON output decodes to (ADR 1411 encoding, unchanged)]
  const accepted = [
    ['', ''],
    ['x', 'x'],
    ['fallback', 'fallback'],
    ['null', null],
    ['[]', []],
    ['5', 5],
    ['end-of-phase', 'end-of-phase'],
    ['-x', '-x'],
    [' ', ' '],
    ['défaut', 'défaut'],
  ];

  for (const [value, decoded] of accepted) {
    test(`--raw prints ${JSON.stringify(value)} for an absent key`, () => {
      const result = run(['config-get', 'absent.key', '--default', value, '--raw'], tmpDir);
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.equal(result.stdout, value);
    });

    test(`JSON output carries ${JSON.stringify(value)} for an absent key`, () => {
      const result = run(['config-get', 'absent.key', '--default', value], tmpDir);
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.deepEqual(JSON.parse(result.stdout), decoded);
    });
  }
});

describe('the value-taking global options share one refusal rule (#5933)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-global-flags-5933-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  for (const flag of ['--cwd', '--project-dir', '--ws', '--pick', '--default']) {
    test(`${flag} refuses a following --x with the usage reason`, () => {
      const result = run(['config-get', 'absent.key', flag, '--x'], tmpDir);
      assertUsageRefusal(result);
    });

    test(`${flag} with no value at all is refused with the usage reason`, () => {
      const result = run(['config-get', 'absent.key', flag], tmpDir);
      assertUsageRefusal(result);
    });
  }

  // `--default ""` is the one empty value that is accepted (see above).
  for (const flag of ['--cwd', '--project-dir', '--ws', '--pick']) {
    test(`${flag} "" is refused with the usage reason`, () => {
      const result = run(['config-get', 'absent.key', flag, ''], tmpDir);
      assertUsageRefusal(result);
    });
  }

  for (const token of ['--ws=', '--ws=  ']) {
    test(`${JSON.stringify(token)} (no name after trimming) is refused with the usage reason`, () => {
      const result = run(['config-get', 'absent.key', token], tmpDir);
      assertUsageRefusal(result);
    });
  }

  // The `=` forms carry their value in the same token, so only an empty value is
  // a missing one, as for `--cwd=` and `--project-dir=`. `--ws=--x` names a
  // workstream, and an invalid name is reported as one.
  test('--ws=--x is judged as a workstream name, like any other invalid name', () => {
    const dashed = run(['config-get', 'absent.key', '--ws=--x'], tmpDir);
    const invalid = run(['config-get', 'absent.key', '--ws=bad/name'], tmpDir);
    assert.notEqual(invalid.status, 0);
    assert.notEqual(invalid.reason, ERROR_REASON.USAGE, 'baseline: an invalid name is not a missing value');
    assert.equal(dashed.status, invalid.status);
    assert.equal(dashed.reason, invalid.reason);
    assert.equal(dashed.hasStackTrace, false);
  });
});

describe('--ws keeps its parse order and its trimming (#5933)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-ws-5933-');
    for (const [name, status] of [['alpha', 'Alpha active'], ['beta', 'Beta active']]) {
      const dir = path.join(tmpDir, '.planning', 'workstreams', name);
      fs.mkdirSync(path.join(dir, 'phases'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'STATE.md'), `# State\n**Status:** ${status}\n`, 'utf-8');
    }
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // `state json` reads the selected workstream's STATE.md, so `status` shows
  // which workstream the CLI resolved.
  const rows = [
    [['--ws', 'beta'], 'Beta active'],
    [['--ws=alpha'], 'Alpha active'],
    [['--ws= alpha '], 'Alpha active'],
    [['--ws=alpha', '--ws', 'beta'], 'Alpha active'],
    [['--ws', 'beta', '--ws=alpha'], 'Alpha active'],
    // The `=` form is the one judged, so a refusable `--ws` beside it is ignored.
    [['--ws=alpha', '--ws'], 'Alpha active'],
    [['--ws', '--x', '--ws=alpha'], 'Alpha active'],
  ];

  for (const [wsArgs, status] of rows) {
    test(`${wsArgs.map((arg) => JSON.stringify(arg)).join(' ')} selects the workstream with status ${status}`, () => {
      const result = run(['state', 'json', '--raw', ...wsArgs], tmpDir);
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.equal(JSON.parse(result.stdout).status, status);
    });
  }

  test('an empty --ws= is refused even when a --ws <name> follows', () => {
    const result = run(['state', 'json', '--raw', '--ws=', '--ws', 'beta'], tmpDir);
    assertUsageRefusal(result);
  });
});

describe('properties of the refusal rule (#5933)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-flags-5933-prop-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  const VALUE_FLAGS = ['--cwd', '--project-dir', '--ws', '--pick', '--default'];
  // Other global flags are read by their own rules before these, so a value
  // spelled like one of them is left out of the generated values.
  const GLOBAL_TOKENS = new Set([...VALUE_FLAGS, '--raw', '--json-errors', '-h', '-?', '-v']);

  const dashedValue = fc
    .stringMatching(/^[a-z0-9-]{0,8}$/)
    .map((rest) => `--${rest}`)
    .filter((value) => !GLOBAL_TOKENS.has(value));
  const plainValue = fc
    .stringMatching(/^[a-zA-Z0-9 ._-]{0,10}$/)
    .filter((value) => !value.startsWith('--') && !GLOBAL_TOKENS.has(value));

  test('property: a missing or --led value is refused with the usage reason, wherever the flag sits', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...VALUE_FLAGS),
        fc.option(dashedValue, { nil: undefined }),
        fc.boolean(),
        (flag, value, flagFirst) => {
          // A missing value means the flag is the last token.
          let argv;
          if (value === undefined) {
            argv = ['config-get', 'absent.key', flag];
          } else if (flagFirst) {
            argv = [flag, value, 'config-get', 'absent.key'];
          } else {
            argv = ['config-get', 'absent.key', flag, value];
          }
          const result = runInProcess(argv, tmpDir);
          assert.notEqual(result.exitCode, 0, `argv ${JSON.stringify(argv)}`);
          assert.equal(result.reason, ERROR_REASON.USAGE, `argv ${JSON.stringify(argv)}`);
          assert.equal(result.stdout, '', `argv ${JSON.stringify(argv)}`);
        },
      ),
    );
  });

  test('property: any other --default value is accepted, and where it sits does not change the result', () => {
    fc.assert(
      fc.property(plainValue, (value) => {
        const after = runInProcess(['config-get', 'absent.key', '--default', value, '--raw'], tmpDir);
        const before = runInProcess(['--default', value, 'config-get', 'absent.key', '--raw'], tmpDir);
        assert.equal(after.exitCode, 0, `value ${JSON.stringify(value)}`);
        assert.equal(before.exitCode, 0, `value ${JSON.stringify(value)}`);
        assert.equal(before.stdout, after.stdout, `value ${JSON.stringify(value)}`);
      }),
    );
  });
});
