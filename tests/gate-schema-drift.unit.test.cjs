'use strict';

/**
 * In-process GateResult tests for `check verify-schema-drift` (#5219, epic #5056, ADR-5057 §4 arm C).
 *
 * `evaluateSchemaDriftGate({ projectDir, args, env })` returns a GateResult: a GateVerdict for every
 * arm that printed a payload before the move and a GateUsageFailure for the one arm that called
 * `error()`. The byte-for-byte stdout / exit-status equivalence with the pre-move code is pinned by
 * tests/check-router-cutover-equivalence.test.cjs (E12); this file pins the returned value, the
 * none-versus-unreadable boundary (an absent phases tree is a skip, one that cannot be examined is
 * `unreadable`), the non-blocking "a throw is an unreadable verdict" contract, and that the gate
 * never writes to stdout / stderr (only the router formats output).
 *
 * I/O failures are injected by monkeypatching the fs method and restoring it in `finally` (never a
 * mode-bit trick: root bypasses those).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, createTempGitProject, cleanup } = require('./helpers.cjs');
const { put, git, failRead } = require('./helpers/gate-positive-control.cjs');

const gate = require('../gsd-core/bin/lib/gate-schema-drift.cjs');
const phaseContext = require('../gsd-core/bin/lib/gate-phase-context.cjs');
const { isGateUsageFailure } = require('../gsd-core/bin/lib/gate-verdict.cjs');

const SCHEMA_PLAN = '---\nphase: 01\nfiles_modified:\n  - prisma/schema.prisma\n---\n\n# Plan\n';
const CLEAN_PLAN = '---\nphase: 01\nfiles_modified:\n  - src/a.js\n---\n\n# Plan\n';
const PHASE = '.planning/phases/01-schema';

/** Run `fn(dir)` in a fresh project, asserting the gate wrote nothing to stdout / stderr. */
function inProject(options, fn) {
  const dir = options.git ? createTempGitProject('gate-schema-') : createTempProject('gate-schema-');
  const writes = [];
  const outWrite = process.stdout.write;
  const errWrite = process.stderr.write;
  let restore;
  try {
    restore = options.setup ? options.setup(dir) : undefined;
    process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
    process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
    const result = fn(dir);
    return { result, writes };
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
    if (typeof restore === 'function') restore();
    cleanup(dir);
  }
}

function evaluate(options, args, env) {
  const { result, writes } = inProject(options, (dir) => gate.evaluateSchemaDriftGate({
    projectDir: dir,
    args: typeof args === 'function' ? args(dir) : args,
    ...(env === undefined ? {} : { env }),
  }));
  assert.deepStrictEqual(writes, [], 'a gate module must not write to stdout/stderr');
  return result;
}

function withSchemaPlan(dir) { put(dir, `${PHASE}/01-01-PLAN.md`, SCHEMA_PLAN); }

describe('evaluateSchemaDriftGate: usage', () => {
  const USAGE = { failure: { code: 'unknown', message: 'Usage: verify schema-drift <phase> [--skip]' } };

  test('no argument is a usage failure carrying the old error() text', () => {
    const result = evaluate({}, []);
    assert.equal(isGateUsageFailure(result), true);
    assert.deepStrictEqual(result, USAGE);
  });

  test('an empty phase argument is the same usage failure', () => {
    assert.deepStrictEqual(evaluate({}, ['']), USAGE);
  });
});

describe('evaluateSchemaDriftGate: none versus unreadable', () => {
  test('an absent phases tree is a skip, not an unreadable verdict', () => {
    const result = evaluate({ setup: (dir) => cleanup(path.join(dir, '.planning', 'phases')) }, ['1']);
    assert.equal(result.outcome, 'skip');
    assert.equal(result.block, false);
    assert.deepStrictEqual(result.payload, { block: false, drift_detected: false, blocking: false, message: 'No phases directory' });
    assert.equal(JSON.stringify(result.payload), '{"block":false,"drift_detected":false,"blocking":false,"message":"No phases directory"}', 'key order is the wire order');
  });

  test('a phases tree that cannot be examined is unreadable (non-blocking payload), never a skip', () => {
    const realStat = fs.statSync;
    const result = evaluate({
      setup: () => {
        fs.statSync = function patched(p, ...rest) {
          if (String(p).endsWith(`${path.sep}phases`)) {
            const err = new Error('EACCES: simulated');
            err.code = 'EACCES';
            throw err;
          }
          return realStat.call(fs, p, ...rest);
        };
        return () => { fs.statSync = realStat; };
      },
    }, ['1']);
    assert.equal(result.outcome, 'unreadable');
    assert.equal(result.block, false);
    assert.equal(result.payload.block, false);
    assert.equal(result.payload.unreadable, true);
    assert.equal(result.payload.read_error, 'EACCES');
    assert.match(result.payload.message, /^schema-drift could not examine .*phases \(EACCES\); drift was not evaluated$/);
  });

  test('a phase that does not resolve is unreadable with the old message', () => {
    const result = evaluate({ setup: withSchemaPlan }, ['99']);
    assert.equal(result.outcome, 'unreadable');
    assert.deepStrictEqual(result.payload, { block: false, drift_detected: false, blocking: false, message: 'Phase directory not found: 99' });
  });

  test('a phase token is matched as a whole phase, never as a substring of another phase directory', () => {
    const result = evaluate({
      setup: (dir) => {
        put(dir, '.planning/phases/11-expansion/11-01-PLAN.md', SCHEMA_PLAN);
      },
    }, ['1']);
    assert.equal(result.outcome, 'unreadable', 'phase 1 must not resolve to 11-expansion');
    assert.equal(result.payload.message, 'Phase directory not found: 1');
  });

  test('a plan that cannot be read is unreadable and names the file; drift is not reported as clean', () => {
    const result = evaluate({
      setup: (dir) => { withSchemaPlan(dir); return failRead('01-01-PLAN.md'); },
    }, ['1']);
    assert.equal(result.outcome, 'unreadable');
    assert.equal(result.block, false);
    assert.equal(result.payload.unreadable_file, '01-01-PLAN.md');
    assert.equal(result.payload.read_error, 'EACCES');
    assert.equal(result.payload.drift_detected, false);
    assert.match(result.payload.message, /could not read 01-01-PLAN\.md \(EACCES\); drift was not evaluated$/);
  });

  test('a summary that cannot be read is unreadable too', () => {
    const result = evaluate({
      setup: (dir) => {
        withSchemaPlan(dir);
        put(dir, `${PHASE}/01-01-SUMMARY.md`, '---\nphase: 01\n---\n\nran npx prisma db push\n');
        return failRead('01-01-SUMMARY.md');
      },
    }, ['1']);
    assert.equal(result.outcome, 'unreadable');
    assert.equal(result.payload.unreadable_file, '01-01-SUMMARY.md');
  });

  test('the bypass makes an unreadable plan moot: the unreadable arm is not taken, and no plan content is read so nothing is detected (pass, exactly this payload)', () => {
    const result = evaluate({
      setup: (dir) => { withSchemaPlan(dir); return failRead('01-01-PLAN.md'); },
    }, ['1'], { GSD_SKIP_SCHEMA_CHECK: 'true' });
    assert.equal(result.outcome, 'pass');
    assert.equal(result.block, false);
    assert.deepStrictEqual(result.payload, {
      block: false,
      drift_detected: false,
      blocking: false,
      schema_files: [],
      orms: [],
      unpushed_orms: [],
      message: '',
      skipped: false,
    });
  });
});

describe('evaluateSchemaDriftGate: verdicts', () => {
  test('a plan modifying a schema with no push evidenced blocks, with the full payload', () => {
    const result = evaluate({ git: true, setup: withSchemaPlan }, ['1']);
    assert.equal(result.outcome, 'block');
    assert.equal(result.block, true);
    assert.deepStrictEqual(Object.keys(result.payload), ['block', 'drift_detected', 'blocking', 'schema_files', 'orms', 'unpushed_orms', 'message', 'skipped']);
    assert.equal(result.payload.block, true);
    assert.equal(result.payload.drift_detected, true);
    assert.equal(result.payload.blocking, true);
    assert.deepStrictEqual(result.payload.schema_files, ['prisma/schema.prisma']);
    assert.deepStrictEqual(result.payload.orms, ['prisma']);
    assert.deepStrictEqual(result.payload.unpushed_orms, ['prisma']);
    assert.equal(result.payload.skipped, false);
  });

  test('a push evidenced in the phase summary is a pass', () => {
    const result = evaluate({
      git: true,
      setup: (dir) => {
        withSchemaPlan(dir);
        put(dir, `${PHASE}/01-01-SUMMARY.md`, '---\nphase: 01\n---\n\nRan `npx prisma db push` against the dev database.\n');
      },
    }, ['1']);
    assert.equal(result.outcome, 'pass');
    assert.equal(result.block, false);
    assert.deepStrictEqual(result.payload.unpushed_orms, []);
  });

  test('a push evidenced in the subject of the phase\'s own commit is a pass', () => {
    const result = evaluate({
      git: true,
      setup: (dir) => {
        put(dir, `${PHASE}/01-01-PLAN.md`, SCHEMA_PLAN);
        put(dir, `${PHASE}/01-01-SUMMARY.md`, '---\nphase: 01\n---\n\ndone\n');
        git(dir, 'add', '-A');
        git(dir, 'commit', '-m', 'feat(01-01): npx prisma db push the schema');
      },
    }, ['1']);
    assert.equal(result.outcome, 'pass');
    assert.deepStrictEqual(result.payload.unpushed_orms, []);
  });

  test('a plan touching no schema file is a pass with nothing detected', () => {
    const result = evaluate({ git: true, setup: (dir) => put(dir, `${PHASE}/01-01-PLAN.md`, CLEAN_PLAN) }, ['1']);
    assert.equal(result.outcome, 'pass');
    assert.deepStrictEqual(result.payload.schema_files, []);
  });

  test('a phase with no plan files at all is a pass (no declared targets)', () => {
    const result = evaluate({ git: true, setup: (dir) => put(dir, `${PHASE}/notes.txt`, 'x\n') }, ['1']);
    assert.equal(result.outcome, 'pass');
    assert.equal(result.block, false);
  });
});

describe('evaluateSchemaDriftGate: the GSD_SKIP_SCHEMA_CHECK bypass arrives as env', () => {
  const run = (env) => evaluate({ git: true, setup: withSchemaPlan }, ['1'], env);

  test('the exact string "true" bypasses: outcome skip, block false, drift still reported', () => {
    const result = run({ GSD_SKIP_SCHEMA_CHECK: 'true' });
    assert.equal(result.outcome, 'skip');
    assert.equal(result.block, false);
    assert.equal(result.payload.block, false);
    assert.equal(result.payload.drift_detected, true);
    assert.equal(result.payload.skipped, true);
  });

  for (const value of ['1', 'TRUE', 'True', ' true', 'true ', '', 'false', 'yes']) {
    test(`${JSON.stringify(value)} does not bypass`, () => {
      assert.equal(run({ GSD_SKIP_SCHEMA_CHECK: value }).outcome, 'block');
    });
  }

  test('no env at all does not bypass (the gate reads no ambient state for it)', () => {
    const previous = process.env.GSD_SKIP_SCHEMA_CHECK;
    process.env.GSD_SKIP_SCHEMA_CHECK = 'true';
    try {
      assert.equal(run(undefined).outcome, 'block');
      assert.equal(run({}).outcome, 'block');
    } finally {
      if (previous === undefined) delete process.env.GSD_SKIP_SCHEMA_CHECK;
      else process.env.GSD_SKIP_SCHEMA_CHECK = previous;
    }
  });
});

describe('evaluateSchemaDriftGate: the non-blocking contract', () => {
  test('a throw is a non-blocking unreadable verdict carrying the message, never a crash', () => {
    const previous = process.env.GSD_WORKSTREAM;
    process.env.GSD_WORKSTREAM = '../escape';
    let result;
    try {
      result = evaluate({}, ['1']);
    } finally {
      if (previous === undefined) delete process.env.GSD_WORKSTREAM;
      else process.env.GSD_WORKSTREAM = previous;
    }
    assert.equal(isGateUsageFailure(result), false);
    assert.equal(result.outcome, 'unreadable');
    assert.equal(result.block, false);
    assert.equal(result.payload.block, false);
    assert.equal(result.payload.drift_detected, false);
    assert.equal(result.payload.blocking, false);
    assert.match(result.payload.message, /^exception: /);
  });

  test('every verdict the gate returns is frozen (it cannot be mutated after it was returned)', () => {
    const result = evaluate({ git: true, setup: withSchemaPlan }, ['1']);
    assert.ok(Object.isFrozen(result.payload));
  });
});

describe('resolvePhaseDirByToken (gate-phase-context, shared by the schema- and context-drift gates)', () => {
  test('an exact phase number resolves, a different phase whose directory merely contains it does not', () => {
    const dir = createTempProject('gate-schema-resolve-');
    try {
      put(dir, '.planning/phases/11-expansion/keep.txt', 'x\n');
      put(dir, '.planning/phases/01-core/keep.txt', 'x\n');
      const phasesDir = path.join(dir, '.planning', 'phases');
      assert.equal(phaseContext.resolvePhaseDirByToken(dir, phasesDir, '1'), path.join(phasesDir, '01-core'));
      assert.equal(phaseContext.resolvePhaseDirByToken(dir, phasesDir, '01'), path.join(phasesDir, '01-core'));
      assert.equal(phaseContext.resolvePhaseDirByToken(dir, phasesDir, '11'), path.join(phasesDir, '11-expansion'));
      assert.equal(phaseContext.resolvePhaseDirByToken(dir, phasesDir, '2'), null);
    } finally {
      cleanup(dir);
    }
  });

  test('an exact directory name falls back, and a name escaping the phases tree resolves to nothing', () => {
    const dir = createTempProject('gate-schema-resolve-');
    try {
      put(dir, '.planning/phases/custom-name/keep.txt', 'x\n');
      put(dir, '.planning/outside/keep.txt', 'x\n');
      const phasesDir = path.join(dir, '.planning', 'phases');
      assert.equal(phaseContext.resolvePhaseDirByToken(dir, phasesDir, 'custom-name'), path.join(phasesDir, 'custom-name'));
      assert.equal(phaseContext.resolvePhaseDirByToken(dir, phasesDir, '../outside'), null);
    } finally {
      cleanup(dir);
    }
  });
});
