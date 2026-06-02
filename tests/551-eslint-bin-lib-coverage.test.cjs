'use strict';

/**
 * Regression / migration-gate test for #551 and ADR-457 (TS migration).
 *
 * ESLint must apply the correct policy to every gsd-core/bin/lib/*.cjs
 * file as modules migrate from hand-written CJS to tsc-generated artifacts:
 *
 *   - tsc-generated artifact (has src/<basename>.cts counterpart) → MUST be
 *     eslint-ignored.  We lint the *.cts source instead (ADR-457).
 *   - Genuinely hand-written (no src/*.cts counterpart) → MUST be linted
 *     (NOT ignored).  Includes scripts-generated package-identity.cjs which
 *     has no *.cts source.
 *
 * The test is filesystem-driven — it scans bin/lib at runtime and checks each
 * file against the src/ directory, so it stays correct automatically as more
 * modules migrate.  No hardcoded lists.
 *
 * ESLint behaviour is verified via ESLint's own `isPathIgnored()` API so the
 * test reflects real resolved flat-config precedence, not a textual scan of
 * eslint.config.mjs.
 */

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ESLint } = require('eslint');

const ROOT = path.resolve(__dirname, '..');
const LIB_DIR = path.join(ROOT, 'gsd-core', 'bin', 'lib');
const SRC_DIR = path.join(ROOT, 'src');

/**
 * Returns true if the given bin/lib/*.cjs file has a corresponding
 * src/<basename>.cts TypeScript source (meaning it is tsc-generated).
 */
function hasTsSource(absPath) {
  const base = path.basename(absPath, '.cjs');
  return (
    fs.existsSync(path.join(SRC_DIR, `${base}.cts`)) ||
    fs.existsSync(path.join(SRC_DIR, `${base}.ts`))
  );
}

let eslint;
before(() => {
  eslint = new ESLint({ cwd: ROOT });
});

describe('ESLint coverage tracks the bin/lib TS migration (ADR-457 / #537)', () => {
  /**
   * Main invariant: scan every *.cjs in bin/lib and assert the correct ESLint
   * policy is applied.
   */
  test('each bin/lib/*.cjs is linted xor ignored according to migration state', async () => {
    const wronglyIgnored = []; // hand-written but ignored — should be linted
    const wronglyLinted = []; // tsc-generated but not ignored — should be ignored

    const entries = fs.readdirSync(LIB_DIR).filter((e) => e.endsWith('.cjs'));
    for (const entry of entries) {
      const abs = path.join(LIB_DIR, entry);
      const generated = hasTsSource(abs);
      const ignored = await eslint.isPathIgnored(abs);

      if (generated && !ignored) {
        wronglyLinted.push(entry);
      } else if (!generated && ignored) {
        wronglyIgnored.push(entry);
      }
    }

    assert.deepEqual(
      wronglyLinted,
      [],
      `tsc-generated bin/lib modules not yet added to ESLint ignore list: ${wronglyLinted.join(', ')}`,
    );
    assert.deepEqual(
      wronglyIgnored,
      [],
      `Hand-written bin/lib modules silently excluded from ESLint: ${wronglyIgnored.join(', ')}`,
    );
  });

  test('semver-compare.cjs (tsc-generated publish artifact) stays eslint-ignored (ADR-457)', async () => {
    const f = path.join(LIB_DIR, 'semver-compare.cjs');
    assert.equal(
      await eslint.isPathIgnored(f),
      true,
      'semver-compare.cjs is a tsc-generated publish-time artifact and must stay ignored',
    );
  });

  test('package-identity.cjs (script-generated, no *.cts source) is linted, not ignored (#551)', async () => {
    const f = path.join(LIB_DIR, 'package-identity.cjs');
    assert.equal(
      await eslint.isPathIgnored(f),
      false,
      'package-identity.cjs has no src/*.cts counterpart and must be linted, not ignored',
    );
  });
});
