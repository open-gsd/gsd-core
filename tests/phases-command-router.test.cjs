'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { routePhasesCommand } = require('../gsd-core/bin/lib/phases-command-router.cjs');

// These tests exercise router dispatch with a deterministic runtime context.
let _prevWorkstream;
before(() => {
  _prevWorkstream = process.env.GSD_WORKSTREAM;
  process.env.GSD_WORKSTREAM = 'test-unit';
});
after(() => {
  if (_prevWorkstream === undefined) delete process.env.GSD_WORKSTREAM;
  else process.env.GSD_WORKSTREAM = _prevWorkstream;
});

describe('phases-command-router', () => {
  test('routes phases list with parsed options', () => {
    const calls = [];
    const phase = {
      cmdPhasesList: (cwd, options, raw) => calls.push({ cwd, options, raw }),
    };

    routePhasesCommand({
      phase,
      milestone: {},
      args: ['phases', 'list', '--type', 'plans', '--phase', '10', '--include-archived'],
      cwd: '/tmp/proj',
      raw: true,
      error: (msg) => {
        throw new Error(msg);
      },
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      cwd: '/tmp/proj',
      options: { type: 'plans', phase: '10', includeArchived: true },
      raw: true,
    });
  });

  test('routes phases clear with trailing args', () => {
    const calls = [];
    const milestone = {
      cmdPhasesClear: (cwd, raw, trailing) => calls.push({ cwd, raw, trailing }),
    };

    routePhasesCommand({
      phase: {},
      milestone,
      args: ['phases', 'clear', '--confirm'],
      cwd: '/tmp/proj',
      raw: false,
      error: (msg) => {
        throw new Error(msg);
      },
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      cwd: '/tmp/proj',
      raw: false,
      trailing: ['--confirm'],
    });
  });

  test('errors on unknown phases subcommand', () => {
    let message = null;
    routePhasesCommand({
      phase: {},
      milestone: {},
      args: ['phases', 'archive'],
      cwd: '/tmp/proj',
      raw: false,
      error: (msg) => {
        message = msg;
      },
    });

    assert.equal(message, 'Unknown phases subcommand. Available: list, clear');
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-1826-phases-clear-confirm.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-1826-phases-clear-confirm (consolidation epic #1969 B2 #1971)", () => {
/**
 * Regression tests for bug #1826
 *
 * `phases clear` must require an explicit --confirm flag before deleting any
 * phase directories. Without it, any accidental or hallucinated invocation
 * wipes the entire .planning/phases/ tree with no warning.
 *
 * Rules:
 *   - Phase dirs present + no --confirm → non-zero exit, clear error message
 *   - Phase dirs present + --confirm    → deletes, exits 0, reports count
 *   - No phase dirs + no --confirm      → exits 0, cleared=0 (nothing to guard)
 */

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

describe('bug #1826: phases clear --confirm guard', () => {
  let tmpDir;
  // Consolidation #1969: the host suite forces GSD_WORKSTREAM=test-unit, which
  // runGsdTools propagates into child processes and redirects the project lookup.
  // Clear it for these tests (unset when this file ran standalone); restore after.
  let __savedWorkstream;

  beforeEach(() => {
    __savedWorkstream = process.env.GSD_WORKSTREAM;
    delete process.env.GSD_WORKSTREAM;
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
    if (__savedWorkstream === undefined) delete process.env.GSD_WORKSTREAM;
    else process.env.GSD_WORKSTREAM = __savedWorkstream;
  });

  test('phases clear without --confirm is rejected when phase dirs exist', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    fs.mkdirSync(path.join(phasesDir, '01-foundation'), { recursive: true });
    fs.mkdirSync(path.join(phasesDir, '02-api'), { recursive: true });

    const result = runGsdTools(['phases', 'clear'], tmpDir);

    assert.ok(!result.success, 'should exit non-zero when dirs exist and --confirm absent');
    assert.ok(
      result.error.includes('--confirm'),
      `error message must mention --confirm; got: ${result.error}`
    );

    // Dirs must be untouched
    assert.ok(fs.existsSync(path.join(phasesDir, '01-foundation')), 'dirs must not be deleted');
    assert.ok(fs.existsSync(path.join(phasesDir, '02-api')), 'dirs must not be deleted');
  });

  test('phases clear --confirm deletes dirs and reports count', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    fs.mkdirSync(path.join(phasesDir, '01-foundation'), { recursive: true });
    fs.mkdirSync(path.join(phasesDir, '02-api'), { recursive: true });

    const result = runGsdTools(['phases', 'clear', '--confirm'], tmpDir);

    assert.ok(result.success, `should succeed with --confirm: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.cleared, 2);
    assert.ok(!fs.existsSync(path.join(phasesDir, '01-foundation')), 'dirs should be removed');
  });

  test('phases clear without --confirm succeeds when no phase dirs exist', () => {
    // .planning/phases/ exists but is empty — nothing to guard
    const result = runGsdTools(['phases', 'clear'], tmpDir);

    assert.ok(result.success, `should succeed with empty phases dir: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.cleared, 0);
  });
});
  });
}
