'use strict';

/**
 * tests/mutation-matrix-ratchet.test.cjs
 *
 * Guards the per-module mutation-score ratchet contract defined in
 * scripts/mutation-matrix.cjs (ADR-456 / issue #1187).
 *
 * Assertions:
 *  (a) TARGET_MUTATION_SCORE is exported as a numeric constant equal to 80.
 *  (b) Every COVERED module declares a numeric minScore (50 ≤ minScore ≤ 100).
 *  (c) The matrix entry emitted by buildResult() / the script's JSON output
 *      includes minScore for each module.
 *  (d) A COVERED module missing minScore causes the above assertions to fail
 *      (negative proof — ensured by the ≥50 / ≤100 range check).
 *
 * Design note: this test imports the script's internals via require() — the
 * script exports COVERED and TARGET_MUTATION_SCORE so they can be tested
 * without subprocess overhead. buildResult() is not exported so we verify the
 * matrix output by running the script as a child process (stdin pipe mode).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const MATRIX_SCRIPT = path.resolve(__dirname, '../scripts/mutation-matrix.cjs');
const matrix = require(MATRIX_SCRIPT);

// ── (a) TARGET_MUTATION_SCORE ─────────────────────────────────────────────────
describe('mutation-matrix ratchet: TARGET_MUTATION_SCORE export', () => {
  test('exports TARGET_MUTATION_SCORE', () => {
    assert.ok(
      Object.prototype.hasOwnProperty.call(matrix, 'TARGET_MUTATION_SCORE'),
      'mutation-matrix.cjs must export TARGET_MUTATION_SCORE'
    );
  });

  test('TARGET_MUTATION_SCORE is numeric', () => {
    assert.strictEqual(
      typeof matrix.TARGET_MUTATION_SCORE,
      'number',
      'TARGET_MUTATION_SCORE must be a number'
    );
  });

  test('TARGET_MUTATION_SCORE equals 80', () => {
    assert.strictEqual(
      matrix.TARGET_MUTATION_SCORE,
      80,
      'TARGET_MUTATION_SCORE must equal 80 (ADR-456 floor)'
    );
  });
});

// ── (b) every COVERED module has a valid minScore ─────────────────────────────
describe('mutation-matrix ratchet: per-module minScore in COVERED', () => {
  test('exports COVERED object', () => {
    assert.ok(
      Object.prototype.hasOwnProperty.call(matrix, 'COVERED'),
      'mutation-matrix.cjs must export COVERED'
    );
    assert.strictEqual(typeof matrix.COVERED, 'object');
    assert.ok(matrix.COVERED !== null);
  });

  const covered = matrix.COVERED || {};
  const moduleNames = Object.keys(covered);

  test('COVERED has at least one module', () => {
    assert.ok(moduleNames.length > 0, 'COVERED must contain at least one module');
  });

  for (const name of moduleNames) {
    describe(`module: ${name}`, () => {
      test(`${name}: declares minScore`, () => {
        const entry = covered[name];
        assert.ok(
          Object.prototype.hasOwnProperty.call(entry, 'minScore'),
          `COVERED['${name}'] must have a minScore property`
        );
      });

      test(`${name}: minScore is a number`, () => {
        const entry = covered[name];
        assert.strictEqual(
          typeof entry.minScore,
          'number',
          `COVERED['${name}'].minScore must be a number`
        );
      });

      test(`${name}: minScore is between 50 and 100 (inclusive)`, () => {
        const entry = covered[name];
        assert.ok(
          entry.minScore >= 50,
          `COVERED['${name}'].minScore (${entry.minScore}) must be ≥ 50`
        );
        assert.ok(
          entry.minScore <= 100,
          `COVERED['${name}'].minScore (${entry.minScore}) must be ≤ 100`
        );
      });
    });
  }
});

// ── (c) matrix JSON emitted by the script includes minScore per module ────────
describe('mutation-matrix ratchet: matrix JSON output includes minScore', () => {
  test('script emits valid JSON with minScore in each matrix include entry', () => {
    // Use stdin pipe mode: pass every COVERED module's src/*.cts path as
    // "changed" files so all modules appear in the matrix output.
    // computeMatrix() matches `src/<module>.cts` — derive from the module name.
    const covered = matrix.COVERED || {};
    const moduleNames = Object.keys(covered);
    const stdinLines = moduleNames.map(name => `src/${name}.cts`).join('\n');

    const raw = execFileSync(
      process.execPath,
      [MATRIX_SCRIPT],
      {
        input: stdinLines + '\n',
        encoding: 'utf8',
        cwd: path.resolve(__dirname, '..'),
      }
    );

    let result;
    try {
      result = JSON.parse(raw);
    } catch (e) {
      assert.fail(`mutation-matrix.cjs did not emit valid JSON: ${e.message}\nOutput: ${raw}`);
    }

    assert.strictEqual(result.has_work, 'true', 'has_work must be "true" when covered modules change');
    assert.ok(Array.isArray(result.matrix.include), 'matrix.include must be an array');
    assert.ok(result.matrix.include.length > 0, 'matrix.include must not be empty');

    for (const entry of result.matrix.include) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(entry, 'minScore'),
        `matrix entry for '${entry.name}' must include minScore in JSON output`
      );
      assert.strictEqual(
        typeof entry.minScore,
        'number',
        `matrix entry for '${entry.name}' minScore must be a number`
      );
      assert.ok(
        entry.minScore >= 50 && entry.minScore <= 100,
        `matrix entry for '${entry.name}' minScore (${entry.minScore}) must be between 50 and 100`
      );
    }
  });
});

// ── (d) negative proof: missing minScore is detectable ───────────────────────
describe('mutation-matrix ratchet: guard detects missing minScore', () => {
  test('a module entry without minScore would fail the range check (50-100)', () => {
    // Simulate the invariant: if minScore is missing, typeof === 'undefined',
    // which is not 'number' → the per-module assertion above would catch it.
    const fakeEntry = { cjs: 'foo.cjs', tests: ['tests/foo.test.cjs'] };
    assert.notStrictEqual(
      typeof fakeEntry.minScore,
      'number',
      'An entry without minScore must NOT pass the typeof-number check'
    );
    // Also verify that undefined < 50 and undefined > 100 are both false,
    // meaning the ≥50 check below would also catch it if typeof were lenient.
    assert.ok(
      !(fakeEntry.minScore >= 50),
      'undefined minScore must fail the ≥50 guard'
    );
  });
});

// ── (e) monotonic ratchet: minScore may only increase ────────────────────────
// RATCHET_BASELINE captures the committed floors as of the initial #1187 measurement.
//
// CONTRACT: a module's minScore in COVERED must NEVER drop below its entry here.
// Raising a floor is always allowed (no assertion fails when score goes up).
// LOWERING a floor requires editing this baseline — that edit is the visible,
// reviewable red flag that a deliberate regression is being introduced.
//
// To ADD a new module to COVERED: also add a baseline entry here before merging.
// The assertion "every COVERED module has a baseline" enforces this.
const RATCHET_BASELINE = {
  'context-utilization':     80,
  'prompt-budget':           90,
  'frontmatter':             62,
  'adr-parser':              68,
  'config-schema':           68,
  'active-workstream-store': 80,
  'core-utils':              75,
};

describe('mutation-matrix ratchet: monotonic floor enforcement', () => {
  const covered = matrix.COVERED || {};
  const coveredNames = Object.keys(covered);

  test('every COVERED module has a RATCHET_BASELINE entry (new modules must add one)', () => {
    for (const name of coveredNames) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(RATCHET_BASELINE, name),
        `COVERED module '${name}' has no RATCHET_BASELINE entry — add one before merging`
      );
    }
  });

  for (const name of coveredNames) {
    test(`${name}: minScore >= baseline (${RATCHET_BASELINE[name] ?? 'NO BASELINE'}) — never lower the floor`, () => {
      const baseline = RATCHET_BASELINE[name];
      if (baseline === undefined) {
        // Already caught by the presence check above; skip the numeric compare
        // to avoid a confusing NaN comparison error.
        assert.fail(`no RATCHET_BASELINE for '${name}' — add it`);
        return;
      }
      const actual = covered[name].minScore;
      assert.ok(
        actual >= baseline,
        `COVERED['${name}'].minScore (${actual}) dropped below RATCHET_BASELINE (${baseline}) — ratchet violation`
      );
    });
  }
});
