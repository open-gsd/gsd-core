'use strict';

/**
 * capability-matrix-sync.test.cjs — ADR-1244 Phase 6 (D9) content invariants.
 *
 * The committed docs/reference/capability-matrix.md FRESHNESS guard
 * (`gen-capability-matrix.cjs --check` + byte-for-byte) moved to
 * `npm run lint:generated-sync`, where it runs against the committed file in
 * both local and CI lint lanes — instead of being masked by gsd-test's
 * `npm run build` leg regenerating artifacts. What remains here are the
 * architectural CONTENT invariants the matrix must satisfy regardless of how
 * freshness is enforced: every first-party capability appears as a row, and
 * the rendered extension points reflect the registry (not placeholders).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MATRIX = path.join(ROOT, 'docs', 'reference', 'capability-matrix.md');
const registry = require('../gsd-core/bin/lib/capability-registry.cjs');

describe('capability-matrix content invariants (ADR-1244 Phase 6)', () => {
  test('every first-party capability in the registry appears as a matrix row', () => {
    const md = fs.readFileSync(MATRIX, 'utf8');
    for (const cap of Object.values(registry.capabilities)) {
      if (cap.role !== 'feature' && cap.role !== 'runtime') continue;
      assert.ok(md.includes('`' + cap.id + '`'), `capability ${cap.id} (${cap.role}) must appear in the matrix`);
    }
  });

  test('extension points + hook kinds reflect the registry byLoopPoint index (not placeholders)', () => {
    const md = fs.readFileSync(MATRIX, 'utf8');
    // The stub used "see capability.json" placeholders — the generated matrix must not.
    assert.ok(!md.includes('see capability.json'), 'matrix must show real extension points, not placeholders');
    // `security` registers a gate at ship:pre — a hard architectural invariant. Assert the precondition
    // UNCONDITIONALLY (so this never degrades to a vacuous pass if the registry changes), then assert the
    // rendered row reflects it.
    const shipPreGates = (registry.byLoopPoint['ship:pre'] && registry.byLoopPoint['ship:pre'].gates) || [];
    assert.ok(shipPreGates.some((g) => g.capId === 'security'), 'precondition: security registers a ship:pre gate in the registry');
    const securityRow = md.split(/\r?\n/).find((l) => l.includes('`security`') && l.includes('|'));
    assert.ok(securityRow && securityRow.includes('`ship:pre`'), 'security row must list its real ship:pre extension point');
  });
});
