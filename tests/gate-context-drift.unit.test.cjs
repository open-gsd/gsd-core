'use strict';

/**
 * In-process GateResult tests for `check verify-context-drift` (#5219, epic #5056, ADR-5057 §4 arm C).
 *
 * `evaluateContextDriftGate({ projectDir, args })` returns a GateResult. The byte-for-byte stdout /
 * exit-status equivalence with the pre-move code is pinned by
 * tests/check-router-cutover-equivalence.test.cjs (E14); this file pins the returned value, the
 * none-versus-unreadable boundary, the strict `<` staleness boundary at limit-1 / limit / limit+1, the
 * non-blocking "a throw is an unreadable verdict" contract, and that the gate never writes to stdout /
 * stderr.
 *
 * Effective times come from explicit file mtimes (`fs.utimesSync` with fixed epoch seconds) in a
 * non-git project: no wall clock is read or asserted. I/O failures are injected by monkeypatching the
 * fs method and restoring it in `finally` (never a mode-bit trick: root bypasses those).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, cleanup } = require('./helpers.cjs');
const { put } = require('./helpers/gate-positive-control.cjs');

const gate = require('../gsd-core/bin/lib/gate-context-drift.cjs');
const { isGateUsageFailure } = require('../gsd-core/bin/lib/gate-verdict.cjs');

const PHASE = '.planning/phases/01-x';
const CONTEXT_EPOCH = 2000;

/** Run the gate in a fresh project (set up by `setup`), asserting it wrote nothing to stdout / stderr. */
function evaluate(setup, args) {
  const dir = createTempProject('gate-context-');
  const writes = [];
  const outWrite = process.stdout.write;
  const errWrite = process.stderr.write;
  let restore;
  try {
    restore = setup ? setup(dir) : undefined;
    process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
    process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
    const result = gate.evaluateContextDriftGate({ projectDir: dir, args });
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
    assert.deepStrictEqual(writes, [], 'a gate module must not write to stdout/stderr');
    return result;
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
    if (typeof restore === 'function') restore();
    cleanup(dir);
  }
}

/** Write a phase file and pin its mtime to `epochSeconds`. */
function artifact(dir, name, epochSeconds, content = '# x\n') {
  put(dir, `${PHASE}/${name}`, content);
  fs.utimesSync(path.join(dir, PHASE, name), epochSeconds, epochSeconds);
}

function config(dir, action) {
  put(dir, '.planning/config.json', JSON.stringify(action === undefined ? {} : { workflow: { context_drift_action: action } }));
}

/** CONTEXT.md at CONTEXT_EPOCH plus RESEARCH.md at `researchEpoch`, under the policy `action`. */
function researchAt(researchEpoch, action) {
  return (dir) => {
    config(dir, action);
    artifact(dir, '01-CONTEXT.md', CONTEXT_EPOCH);
    artifact(dir, '01-RESEARCH.md', researchEpoch);
  };
}

describe('evaluateContextDriftGate: usage', () => {
  const USAGE = { failure: { code: 'unknown', message: 'Usage: verify context-drift <phase>' } };

  test('no argument is a usage failure carrying the old error() text', () => {
    const result = evaluate(undefined, []);
    assert.equal(isGateUsageFailure(result), true);
    assert.deepStrictEqual(result, USAGE);
  });

  test('an empty phase argument is the same usage failure', () => {
    assert.deepStrictEqual(evaluate(undefined, ['']), USAGE);
  });
});

describe('evaluateContextDriftGate: none versus unreadable', () => {
  test('an absent phases tree is a skip', () => {
    const result = evaluate((dir) => cleanup(path.join(dir, '.planning', 'phases')), ['1']);
    assert.equal(result.outcome, 'skip');
    assert.equal(result.block, false);
    assert.deepStrictEqual(result.payload, { block: false, skipped: true, reason: 'no-phases-directory', stale_artifacts: [], message: 'No phases directory' });
    assert.equal(JSON.stringify(result.payload), '{"block":false,"skipped":true,"reason":"no-phases-directory","stale_artifacts":[],"message":"No phases directory"}', 'key order is the wire order');
  });

  test('a phases tree that cannot be examined is unreadable, never a skip', () => {
    const realStat = fs.statSync;
    const result = evaluate(() => {
      fs.statSync = function patched(p, ...rest) {
        if (String(p).endsWith(`${path.sep}phases`)) {
          const err = new Error('EACCES: simulated');
          err.code = 'EACCES';
          throw err;
        }
        return realStat.call(fs, p, ...rest);
      };
      return () => { fs.statSync = realStat; };
    }, ['1']);
    assert.equal(result.outcome, 'unreadable');
    assert.equal(result.block, false);
    assert.equal(result.payload.reason, 'phases-dir-unreadable');
    assert.equal(result.payload.skipped, true);
    assert.match(result.payload.message, /^Could not examine .*phases \(EACCES\)$/);
  });

  test('a phase that does not resolve is unreadable (phase-not-found) with the old message', () => {
    const result = evaluate(researchAt(1000), ['99']);
    assert.equal(result.outcome, 'unreadable');
    assert.deepStrictEqual(result.payload, { block: false, skipped: true, reason: 'phase-not-found', stale_artifacts: [], message: 'Phase directory not found: 99' });
  });

  test('a resolved phase directory whose entries cannot be listed is unreadable (phase-not-found)', () => {
    const realReaddir = fs.readdirSync;
    const result = evaluate((dir) => {
      researchAt(1000)(dir);
      const phaseDir = path.join(dir, PHASE);
      fs.readdirSync = function patched(p, ...rest) {
        if (String(p) === phaseDir) {
          const err = new Error('EACCES: simulated');
          err.code = 'EACCES';
          throw err;
        }
        return realReaddir.call(fs, p, ...rest);
      };
      return () => { fs.readdirSync = realReaddir; };
    }, ['1']);
    assert.equal(result.outcome, 'unreadable');
    assert.equal(result.payload.reason, 'phase-not-found');
  });

  test('a phase with no CONTEXT.md is a skip (nothing to compare)', () => {
    const result = evaluate((dir) => artifact(dir, '01-RESEARCH.md', 1000), ['1']);
    assert.equal(result.outcome, 'skip');
    assert.deepStrictEqual(result.payload, { block: false, skipped: true, reason: 'no-context-md', stale_artifacts: [], message: '' });
  });

  test('a phase with a CONTEXT.md and no upstream artifact is a skip', () => {
    const result = evaluate((dir) => artifact(dir, '01-CONTEXT.md', CONTEXT_EPOCH), ['1']);
    assert.equal(result.outcome, 'skip');
    assert.equal(result.payload.reason, 'no-upstream-artifacts');
  });

  test('AI-SPEC.md and UI-SPEC.md are not upstream artifacts', () => {
    const result = evaluate((dir) => {
      artifact(dir, '01-CONTEXT.md', CONTEXT_EPOCH);
      artifact(dir, '01-AI-SPEC.md', 1000);
      artifact(dir, '01-UI-SPEC.md', 1000);
    }, ['1']);
    assert.equal(result.outcome, 'skip');
    assert.equal(result.payload.reason, 'no-upstream-artifacts');
  });
});

describe('evaluateContextDriftGate: the strict staleness boundary (limit-1 / limit / limit+1)', () => {
  test('an artifact older than CONTEXT.md is stale (advisory under the default policy, never blocking)', () => {
    const result = evaluate(researchAt(CONTEXT_EPOCH - 1), ['1']);
    assert.equal(result.outcome, 'advisory');
    assert.equal(result.block, false);
    assert.deepStrictEqual(result.payload.stale_artifacts, ['01-RESEARCH.md']);
    assert.equal(result.payload.action, 'warn');
  });

  test('an artifact at exactly the same instant as CONTEXT.md is in sync, not stale', () => {
    const result = evaluate(researchAt(CONTEXT_EPOCH), ['1']);
    assert.equal(result.outcome, 'pass');
    assert.deepStrictEqual(result.payload.stale_artifacts, []);
  });

  test('an artifact newer than CONTEXT.md is in sync', () => {
    const result = evaluate(researchAt(CONTEXT_EPOCH + 1), ['1']);
    assert.equal(result.outcome, 'pass');
    assert.deepStrictEqual(result.payload.stale_artifacts, []);
  });

  test('property: an artifact is stale exactly when it is strictly older than CONTEXT.md', () => {
    assert.deepStrictEqual(gate.computeContextDrift(100, [{ file: 'a', effectiveMs: 99 }, { file: 'b', effectiveMs: 100 }, { file: 'c', effectiveMs: 101 }]), ['a']);
    fc.assert(fc.property(fc.integer({ min: -1000, max: 1000 }), fc.array(fc.integer({ min: -1000, max: 1000 }), { maxLength: 8 }), (context, times) => {
      const entries = times.map((effectiveMs, i) => ({ file: `f${i}`, effectiveMs }));
      const stale = gate.computeContextDrift(context, entries);
      return stale.length === times.filter((t) => t < context).length
        && stale.every((file) => entries.find((e) => e.file === file).effectiveMs < context);
    }), { seed: 5219, numRuns: 100 });
  });
});

describe('evaluateContextDriftGate: the configured policy', () => {
  test('stale under workflow.context_drift_action=block blocks, with the verdict payload', () => {
    const result = evaluate(researchAt(1000, 'block'), ['1']);
    assert.equal(result.outcome, 'block');
    assert.equal(result.block, true);
    assert.deepStrictEqual(Object.keys(result.payload), ['block', 'skipped', 'stale_artifacts', 'action', 'message']);
    assert.equal(result.payload.block, true);
    assert.equal(result.payload.action, 'block');
    assert.deepStrictEqual(result.payload.stale_artifacts, ['01-RESEARCH.md']);
    assert.match(result.payload.message, /^CONTEXT\.md decisions are newer than: 01-RESEARCH\.md\. Regenerate research: \/gsd-plan-phase 1 --research\. /);
  });

  test('an unrecognised policy value is read as warn', () => {
    const result = evaluate(researchAt(1000, 'explode'), ['1']);
    assert.equal(result.outcome, 'advisory');
    assert.equal(result.payload.action, 'warn');
    assert.equal(result.block, false);
  });

  test('the block policy with nothing stale passes', () => {
    const result = evaluate(researchAt(3000, 'block'), ['1']);
    assert.equal(result.outcome, 'pass');
    assert.equal(result.block, false);
    assert.equal(result.payload.message, '');
  });

  test('the message names the regeneration step for each stale artifact kind', () => {
    const result = evaluate((dir) => {
      config(dir, 'block');
      artifact(dir, '01-CONTEXT.md', CONTEXT_EPOCH);
      artifact(dir, '01-RESEARCH.md', 1000);
      artifact(dir, '01-PATTERNS.md', 1000);
      artifact(dir, '01-VALIDATION.md', 1000);
    }, ['1']);
    assert.deepStrictEqual(result.payload.stale_artifacts, ['01-RESEARCH.md', '01-PATTERNS.md', '01-VALIDATION.md']);
    assert.match(result.payload.message, /Regenerate research: \/gsd-plan-phase 1 --research\./);
    assert.match(result.payload.message, /Regenerate patterns: delete the PATTERNS\.md file, then re-run \/gsd-plan-phase\./);
    assert.match(result.payload.message, /Regenerate or manually reconcile VALIDATION\.md \/ SPEC\.md against the current decisions\./);
    assert.match(result.payload.message, /that carries the staleness forward\.$/);
  });

  test('a SPEC.md counts as upstream (and only a plain one)', () => {
    const result = evaluate((dir) => {
      artifact(dir, '01-CONTEXT.md', CONTEXT_EPOCH);
      artifact(dir, '01-SPEC.md', 1000);
    }, ['1']);
    assert.deepStrictEqual(result.payload.stale_artifacts, ['01-SPEC.md']);
  });
});

describe('evaluateContextDriftGate: the non-blocking contract', () => {
  test('a throw is a non-blocking unreadable verdict carrying the message, never a crash', () => {
    const previous = process.env.GSD_WORKSTREAM;
    process.env.GSD_WORKSTREAM = '../escape';
    let result;
    try {
      result = evaluate(undefined, ['1']);
    } finally {
      if (previous === undefined) delete process.env.GSD_WORKSTREAM;
      else process.env.GSD_WORKSTREAM = previous;
    }
    assert.equal(isGateUsageFailure(result), false);
    assert.equal(result.outcome, 'unreadable');
    assert.equal(result.block, false);
    assert.equal(result.payload.block, false);
    assert.equal(result.payload.skipped, true);
    assert.deepStrictEqual(result.payload.stale_artifacts, []);
    assert.match(result.payload.reason, /^exception: /);
  });

  test('a file that vanishes mid-evaluation (stat throws) is the same non-blocking unreadable verdict', () => {
    const realStat = fs.statSync;
    const result = evaluate((dir) => {
      researchAt(1000)(dir);
      const target = path.join(dir, PHASE, '01-RESEARCH.md');
      fs.statSync = function patched(p, ...rest) {
        if (String(p) === target) throw new Error('simulated stat failure');
        return realStat.call(fs, p, ...rest);
      };
      return () => { fs.statSync = realStat; };
    }, ['1']);
    assert.equal(result.outcome, 'unreadable');
    assert.equal(result.block, false);
    assert.equal(result.payload.reason, 'exception: simulated stat failure');
  });
});
