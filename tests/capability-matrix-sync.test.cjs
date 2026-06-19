'use strict';

/**
 * capability-matrix-sync.test.cjs — ADR-1244 Phase 6 (D9) drift guard.
 *
 * Asserts the committed docs/reference/capability-matrix.md is exactly what
 * scripts/gen-capability-matrix.cjs would generate from the current registry.
 * If a capability is added/removed or its tier/role/engines/extension-points/
 * hook-kinds change without regenerating the matrix, this fails — the same
 * pattern that keeps docs/INVENTORY-MANIFEST.json and capability-registry.cjs honest.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const GENERATOR = path.join(ROOT, 'scripts', 'gen-capability-matrix.cjs');
const MATRIX = path.join(ROOT, 'docs', 'reference', 'capability-matrix.md');
const { buildMatrix } = require('../scripts/gen-capability-matrix.cjs');
const registry = require('../gsd-core/bin/lib/capability-registry.cjs');

describe('capability-matrix drift guard (ADR-1244 Phase 6)', () => {
  test('the committed matrix is in sync with the registry (`gen-capability-matrix.cjs --check` exits 0)', () => {
    // execFileSync throws if the generator exits non-zero (i.e. the committed file is stale).
    assert.doesNotThrow(() => {
      execFileSync(process.execPath, [GENERATOR, '--check'], { cwd: ROOT, stdio: 'pipe' });
    }, 'committed capability-matrix.md is stale — run: node scripts/gen-capability-matrix.cjs --write');
  });

  test('buildMatrix(registry) equals the committed file byte-for-byte (modulo line endings)', () => {
    const generated = buildMatrix(registry).replace(/\r\n/g, '\n').replace(/\n+$/, '\n');
    const committed = fs.readFileSync(MATRIX, 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '\n');
    assert.equal(committed, generated);
  });

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
    // A capability that registers a known hook must show its real point. `security` registers a gate at ship:pre.
    if (registry.byLoopPoint['ship:pre'] && (registry.byLoopPoint['ship:pre'].gates || []).some((g) => g.capId === 'security')) {
      const securityRow = md.split('\n').find((l) => l.includes('`security`') && l.includes('|'));
      assert.ok(securityRow && securityRow.includes('`ship:pre`'), 'security row must list its real ship:pre extension point');
    }
  });
});
