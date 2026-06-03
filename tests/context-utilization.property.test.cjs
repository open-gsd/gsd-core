'use strict';

/**
 * Property-based tests for context-utilization.cjs
 *
 * Module: gsd-core/bin/lib/context-utilization.cjs
 * Exported: classifyContextUtilization(tokensUsed, contextWindow) -> { percent, state }
 *
 * Thresholds (from module source):
 *   ratio < 0.60  → healthy
 *   0.60 <= ratio < 0.70 → warning
 *   ratio >= 0.70 → critical
 *
 * Properties tested:
 *   (a) Boundary: across the 60% and 70% thresholds the classify flips correctly
 *   (b) Robustness: hostile inputs (null/undefined/NaN/Infinity/negative/wrong-type)
 *       always throw TypeError (documented contract) and never throw non-TypeError
 *   (c) Return shape: all valid inputs return an object with typed { percent, state }
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const { classifyContextUtilization, STATES } = require('../gsd-core/bin/lib/context-utilization.cjs');

// ─── Boundary constants ───────────────────────────────────────────────────────
const WARNING_THRESHOLD = 0.60; // ratio < this → healthy
const CRITICAL_THRESHOLD = 0.70; // ratio < this → warning, else critical
const WINDOW = 10000; // A fixed contextWindow that gives us clean ratio math
const W = 50; // boundary exploration width: ±50 tokens around the threshold

describe('context-utilization property tests', () => {
  // ─── (a) Boundary property: classify flips at exactly 60% and 70% ────────────
  test('property: classify is healthy below 60%, warning in [60%,70%), critical at ≥70%', () => {
    // Test across a range of context windows.
    // The boundary is at the exact RATIO — not at Math.floor(window * ratio).
    // e.g. with window=1001: floor(1001 * 0.60) = 600, but 600/1001 = 0.5994 < 0.60 → healthy.
    // So we compute the exact first token count that meets or exceeds the threshold.
    fc.assert(
      fc.property(
        // contextWindow: 1000..200000 to keep ratios well-defined
        fc.integer({ min: 1000, max: 200_000 }),
        (contextWindow) => {
          // First integer where tokensUsed/contextWindow >= WARNING_THRESHOLD
          const firstWarning = Math.ceil(contextWindow * WARNING_THRESHOLD);
          // First integer where tokensUsed/contextWindow >= CRITICAL_THRESHOLD
          const firstCritical = Math.ceil(contextWindow * CRITICAL_THRESHOLD);

          // Just below warning threshold → healthy
          if (firstWarning > 0) {
            const below = firstWarning - 1;
            const r = classifyContextUtilization(below, contextWindow);
            assert.equal(
              r.state,
              STATES.HEALTHY,
              `tokensUsed=${below} contextWindow=${contextWindow} ratio=${(below / contextWindow).toFixed(6)} expected healthy got ${r.state}`
            );
          }

          // At exact warning boundary → warning (unless critical collapses to same point)
          if (firstWarning < firstCritical && firstWarning <= contextWindow) {
            const r2 = classifyContextUtilization(firstWarning, contextWindow);
            assert.equal(
              r2.state,
              STATES.WARNING,
              `tokensUsed=${firstWarning} ratio=${(firstWarning / contextWindow).toFixed(6)} expected warning got ${r2.state}`
            );
          }

          // At or above critical threshold → critical
          if (firstCritical <= contextWindow) {
            const r3 = classifyContextUtilization(firstCritical, contextWindow);
            assert.equal(
              r3.state,
              STATES.CRITICAL,
              `tokensUsed=${firstCritical} ratio=${(firstCritical / contextWindow).toFixed(6)} expected critical got ${r3.state}`
            );
          }
        }
      )
    );
  });

  test('property: near 60% boundary the state is always healthy (never warning/critical)', () => {
    // Tokens strictly below ceil(WINDOW * 0.60) must classify as healthy.
    // The boundary is the FIRST integer where ratio >= 0.60 (Math.ceil).
    // We sample from [firstWarning - W, firstWarning - 1] to probe just below it.
    const firstWarning = Math.ceil(WINDOW * WARNING_THRESHOLD); // = 6000
    const rangeMin = Math.max(0, firstWarning - W);             // = 5950
    const rangeMax = firstWarning - 1;                          // = 5999
    fc.assert(
      fc.property(
        fc.integer({ min: rangeMin, max: rangeMax }),
        (tokensUsed) => {
          const r = classifyContextUtilization(tokensUsed, WINDOW);
          assert.equal(
            r.state,
            STATES.HEALTHY,
            `tokensUsed=${tokensUsed}/${WINDOW}=${(tokensUsed / WINDOW * 100).toFixed(2)}% expected healthy got ${r.state}`
          );
        }
      )
    );
  });

  test('property: near 70% boundary tokens at/above critical threshold must be critical', () => {
    const criticalFloor = Math.ceil(WINDOW * CRITICAL_THRESHOLD);
    fc.assert(
      fc.property(
        fc.integer({ min: criticalFloor, max: WINDOW }),
        (tokensUsed) => {
          const r = classifyContextUtilization(tokensUsed, WINDOW);
          assert.equal(
            r.state,
            STATES.CRITICAL,
            `tokensUsed=${tokensUsed}/${WINDOW}=${(tokensUsed / WINDOW * 100).toFixed(2)}% expected critical got ${r.state}`
          );
        }
      )
    );
  });

  // ─── (b) Robustness: hostile inputs always throw TypeError ────────────────────
  test('property: non-integer/negative tokensUsed always throws TypeError', () => {
    const invalidTokensUsed = fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.constant(NaN),
      fc.constant(Infinity),
      fc.constant(-Infinity),
      fc.constant(-1),
      fc.integer({ min: -10000, max: -1 }),
      fc.double({ min: 0.1, max: 0.9 }),
      fc.string(),
      fc.boolean(),
      fc.constant([]),
      fc.constant({})
    );
    fc.assert(
      fc.property(invalidTokensUsed, (bad) => {
        assert.throws(
          () => classifyContextUtilization(bad, 10000),
          (err) => {
            assert.ok(err instanceof TypeError, `Expected TypeError but got ${err.constructor.name}: ${err.message}`);
            return true;
          }
        );
      })
    );
  });

  test('property: non-integer/non-positive contextWindow always throws TypeError', () => {
    const invalidWindows = fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.constant(NaN),
      fc.constant(Infinity),
      fc.constant(-Infinity),
      fc.constant(0),
      fc.constant(-1),
      fc.integer({ min: -10000, max: 0 }),
      fc.double({ min: 0.1, max: 0.9 }),
      fc.string(),
      fc.boolean()
    );
    fc.assert(
      fc.property(invalidWindows, (bad) => {
        assert.throws(
          () => classifyContextUtilization(1000, bad),
          (err) => {
            assert.ok(err instanceof TypeError, `Expected TypeError for contextWindow=${bad} but got ${err.constructor.name}: ${err.message}`);
            return true;
          }
        );
      })
    );
  });

  // ─── (c) Return shape: all valid inputs produce typed { percent, state } ──────
  test('property: valid inputs always return { percent: number[0..100], state: string }', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }), // contextWindow
        (contextWindow) => {
          // tokensUsed in [0, contextWindow]
          const tokensUsed = Math.floor(Math.random() * (contextWindow + 1));
          const r = classifyContextUtilization(tokensUsed, contextWindow);

          assert.ok(typeof r === 'object' && r !== null, 'result must be object');
          assert.ok(typeof r.percent === 'number', `percent must be number got ${typeof r.percent}`);
          assert.ok(typeof r.state === 'string', `state must be string got ${typeof r.state}`);
          assert.ok(r.percent >= 0 && r.percent <= 100, `percent ${r.percent} out of [0,100]`);
          assert.ok(
            [STATES.HEALTHY, STATES.WARNING, STATES.CRITICAL].includes(r.state),
            `state must be one of the STATES enum, got ${r.state}`
          );
        }
      )
    );
  });

  test('property: tokensUsed exceeding contextWindow clamps to 100% critical', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: 1, max: 100_000 }),
        (contextWindow, extra) => {
          const tokensUsed = contextWindow + extra; // always exceeds window
          const r = classifyContextUtilization(tokensUsed, contextWindow);
          assert.equal(r.state, STATES.CRITICAL, `overflow ${tokensUsed}/${contextWindow} must be critical`);
          assert.equal(r.percent, 100, `overflow percent must clamp to 100, got ${r.percent}`);
        }
      )
    );
  });
});
