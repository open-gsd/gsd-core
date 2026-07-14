'use strict';

/**
 * Property-based tests for deriveProgressFromRoadmap column-invariance (#2137).
 *
 * Module: gsd-core/bin/lib/phase-lifecycle.cjs
 * Exported: deriveProgressFromRoadmap(roadmapContent)
 *
 * The #2137 fix re-reads the `## Progress` table by HEADER NAME (locate the
 * `Phase` / `Status` / `Completed` / plans columns by their header cell, index
 * data rows positionally) instead of by a fixed 4-column layout. The core new
 * capability is therefore invariance to column ORDER and column COUNT: the same
 * data must derive the same {completedPhases, totalPhases, totalPlans} no matter
 * where the columns sit or how many unrelated columns are interleaved.
 *
 * Property tested:
 *   Header-cell permutation + injection invariance — for any set of phase rows,
 *   shuffling the header columns and injecting arbitrary unrelated columns leaves
 *   the derived counts identical to the counts computed directly from the data.
 *   This is the property that distinguishes header-driven parsing from the old
 *   position-locked regex, and it is the finding the reviewer held firm on.
 *
 * Lives in a standalone *.property.test.cjs file (the established property-test
 * convention). Its effective prefix `derive-progress.property` matches no
 * production module prefix, so — like the other *.property.test.cjs files — it
 * maps to no module and does not count against the per-module test-file cap
 * (lint-test-file-count.cjs). It is named `derive-progress` rather than
 * `phase-lifecycle` so it does not get greedily attributed to the shorter
 * `phase` prod prefix. The unit/regression fixtures live in state.test.cjs
 * alongside the other deriveProgressFromRoadmap cases.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const { deriveProgressFromRoadmap } = require('../gsd-core/bin/lib/phase-lifecycle.cjs');

// A header name for an INJECTED (unrelated) column. It must not collide with the
// reader's column-name lookups: not exactly `phase` / `status` / `completed`
// (indexOf exact match) and not containing `plans` (findIndex substring match).
// Restricted to letters + spaces so it never introduces a `|` that would break
// cell splitting.
const injectedNameArb = fc
  .stringMatching(/^[A-Za-z][A-Za-z ]{0,11}$/)
  .filter((s) => {
    const l = s.trim().toLowerCase();
    return l !== '' && l !== 'phase' && l !== 'status' && l !== 'completed' && !l.includes('plans');
  });

// One phase row's underlying data. `num` stays ≤ 900 so it never trips the 999.x
// backlog sentinel; `plans` stays ≥ 1 so the plans denominator sum is always > 0
// (deterministic — the reader reports a 0 sum as null, which we avoid here to
// keep the expected value exact). `name` is letters/spaces only (no `|`).
const rowArb = fc.record({
  num: fc.integer({ min: 1, max: 900 }),
  name: fc.stringMatching(/^[A-Za-z][A-Za-z ]{0,8}$/),
  complete: fc.boolean(),
  plans: fc.integer({ min: 1, max: 9 }),
});

// Render the cell for a given logical column key from a row datum.
function cellFor(key, row) {
  switch (key) {
    case 'phase':
      return `${row.num}. ${row.name}`.trim();
    case 'plans':
      return `${row.plans}/${row.plans}`;
    case 'status':
      return row.complete ? 'Complete' : 'Not started';
    case 'completed':
      return row.complete ? '2026-01-01' : '-';
    default:
      return 'x'; // injected column placeholder value
  }
}

describe('#2137 deriveProgressFromRoadmap — column-order / column-count invariance', () => {
  test('shuffled headers + injected columns derive the same counts as the data', () => {
    fc.assert(
      fc.property(
        fc.array(rowArb, { minLength: 1, maxLength: 6 }),
        fc.uniqueArray(injectedNameArb, { maxLength: 3, selector: (s) => s.trim().toLowerCase() }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (rows, injected, permSeed) => {
          // The four real columns plus any injected unrelated columns.
          const columns = [
            { key: 'phase', header: 'Phase' },
            { key: 'plans', header: 'Plans Complete' },
            { key: 'status', header: 'Status' },
            { key: 'completed', header: 'Completed' },
            ...injected.map((h, i) => ({ key: `inj${i}`, header: h })),
          ];

          // Deterministic Fisher–Yates permutation driven by permSeed (an LCG),
          // so column ORDER varies across runs without needing Math.random.
          let s = (permSeed % 2147483647) + 1;
          const nextRand = () => {
            s = (s * 48271) % 2147483647;
            return (s - 1) / 2147483646;
          };
          for (let i = columns.length - 1; i > 0; i--) {
            const j = Math.floor(nextRand() * (i + 1));
            [columns[i], columns[j]] = [columns[j], columns[i]];
          }

          const headerRow = `| ${columns.map((c) => c.header).join(' | ')} |`;
          const sepRow = `| ${columns.map(() => '---').join(' | ')} |`;
          const dataRows = rows.map((r) => `| ${columns.map((c) => cellFor(c.key, r)).join(' | ')} |`);
          const roadmap = ['## Progress', '', headerRow, sepRow, ...dataRows].join('\n');

          const expectedCompleted = rows.filter((r) => r.complete).length;
          const expectedPlans = rows.reduce((acc, r) => acc + r.plans, 0);

          const result = deriveProgressFromRoadmap(roadmap);
          assert.deepEqual(
            result,
            {
              completedPhases: expectedCompleted > 0 ? expectedCompleted : null,
              totalPhases: rows.length,
              totalPlans: expectedPlans, // ≥ 1 per row, so always > 0 → non-null
            },
            `derived counts must be invariant to column order/count. columns=${columns
              .map((c) => c.header)
              .join('|')}`,
          );
        },
      ),
    );
  });
});
