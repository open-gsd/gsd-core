// allow-test-rule: architectural-invariant
// Guards a removal mandated by ADR-0174 (retire @opengsd/gsd-sdk package
// boundary), which explicitly deletes the generator-based CJS↔SDK hand-sync
// tooling. These assertions check repo structure (file absence, package.json
// wiring) — they are not source-text inspection of any .cjs module — and exist
// to prevent silent re-introduction of the retired seam tooling.

/**
 * Regression guard for issue #556 — retire orphaned CJS↔SDK hand-sync tooling.
 *
 * The @opengsd/gsd-sdk package boundary was retired (ADR-0174, #191/#192) and
 * the `sdk/` tree is no longer tracked. The generator-based hand-sync lint that
 * policed CJS-vs-SDK TypeScript drift is therefore dead infrastructure: it
 * referenced an `sdk/src` tree that no longer exists and was wired into no CI
 * workflow or npm script. This guard asserts it stays removed.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');

describe('retired CJS↔SDK hand-sync tooling (#556 / ADR-0174)', () => {
  test('the hand-sync pair lint script is absent', () => {
    const lintScript = path.join(REPO_ROOT, 'scripts', 'lint-shared-module-handsync.cjs');
    assert.ok(
      !fs.existsSync(lintScript),
      'scripts/lint-shared-module-handsync.cjs should be removed — the CJS↔SDK seam it policed was retired by ADR-0174',
    );
  });

  test('the hand-sync allowlist is absent', () => {
    const allowlist = path.join(REPO_ROOT, 'scripts', 'shared-module-handsync-allowlist.json');
    assert.ok(
      !fs.existsSync(allowlist),
      'scripts/shared-module-handsync-allowlist.json should be removed — it paired bin/lib/*.cjs files with sdk/src sources that no longer exist',
    );
  });

  test('no npm script re-wires the retired hand-sync lint', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    const offenders = Object.entries(pkg.scripts || {})
      .filter(([, cmd]) => cmd.includes('lint-shared-module-handsync'))
      .map(([name]) => name);
    assert.deepEqual(
      offenders,
      [],
      `package.json scripts must not invoke the retired hand-sync lint; found: ${offenders.join(', ')}`,
    );
  });
});
