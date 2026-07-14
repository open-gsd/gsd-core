'use strict';

/**
 * golden-parity-single-source.test.cjs — anti-divergence guard (#2266).
 *
 * tests/golden-install-parity.test.cjs and scripts/gen-golden-install-parity-zcode.cjs
 * used to each carry their OWN inline copy of buildParityManifest plus its 4
 * exclusion constants (VOLATILE_FILES, HOOK_CONFIG_FILES,
 * HOOK_CONFIG_RELATIVE_PATHS, EXCLUDED_PREFIXES). The two copies drifted —
 * the generator's copy was missing the realpath/`<HOME>` normalization the
 * test harness's copy had — and shipped broken fixtures three times (#2086,
 * #2095, #2100). Phase 1 of the golden-install-parity redesign (#2266)
 * consolidated both call sites onto a single canonical implementation in
 * tests/helpers/install-shared.cjs.
 *
 * This guard (mirrors the ADR-2121 anti-divergence pattern) enforces that
 * consolidation stays consolidated:
 *   1. install-shared.cjs actually exports a working buildParityManifest +
 *      the 4 exclusion constants with the expected shapes.
 *   2. Neither downstream consumer re-declares its own inline copy of the
 *      builder function or the exclusion constants.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('install-shared.cjs exports the canonical buildParityManifest + exclusion constants (#2266)', () => {
  const installShared = require('./helpers/install-shared.cjs');

  assert.equal(
    typeof installShared.buildParityManifest,
    'function',
    'install-shared.cjs must export buildParityManifest as the single source of truth'
  );

  assert.ok(
    installShared.VOLATILE_FILES instanceof Set,
    'VOLATILE_FILES must be a Set'
  );
  assert.ok(
    installShared.HOOK_CONFIG_FILES instanceof Set,
    'HOOK_CONFIG_FILES must be a Set'
  );
  assert.ok(
    installShared.HOOK_CONFIG_RELATIVE_PATHS instanceof Set,
    'HOOK_CONFIG_RELATIVE_PATHS must be a Set'
  );
  assert.ok(
    Array.isArray(installShared.EXCLUDED_PREFIXES),
    'EXCLUDED_PREFIXES must be an array'
  );
  assert.ok(
    installShared.EXCLUDED_PREFIXES.includes('gsd-core/bin/lib/'),
    "EXCLUDED_PREFIXES must include 'gsd-core/bin/lib/' (compiled runtime artifacts, build-environment-dependent)"
  );
});

// The anti-divergence check below reads the two downstream .cjs source files
// as plain text to prove they no longer re-declare the builder/constants
// inline — the runtime-contract-under-test IS the source text (whether a
// second inline copy exists), not behavior a require() could exercise.
// allow-test-rule: source text is the product for this anti-divergence check, see #2266
test('golden-install-parity.test.cjs does not re-declare an inline buildParityManifest or exclusion constants (#2266)', () => {
  const testHarnessPath = path.join(ROOT, 'tests', 'golden-install-parity.test.cjs');
  const content = fs.readFileSync(testHarnessPath, 'utf8');

  assert.ok(
    !/function\s+buildParityManifest/.test(content),
    'tests/golden-install-parity.test.cjs must import buildParityManifest from ' +
    './helpers/install-shared.cjs, not re-declare it inline'
  );
  assert.ok(
    !/const\s+VOLATILE_FILES\s*=\s*new\s+Set/.test(content),
    'tests/golden-install-parity.test.cjs must import VOLATILE_FILES from ' +
    './helpers/install-shared.cjs, not re-declare it inline'
  );
});

test('gen-golden-install-parity-zcode.cjs does not re-declare an inline buildParityManifest or exclusion constants (#2266)', () => {
  const generatorPath = path.join(ROOT, 'scripts', 'gen-golden-install-parity-zcode.cjs');
  const content = fs.readFileSync(generatorPath, 'utf8');

  assert.ok(
    !/function\s+buildParityManifest/.test(content),
    'scripts/gen-golden-install-parity-zcode.cjs must import buildParityManifest from ' +
    'tests/helpers/install-shared.cjs, not re-declare it inline'
  );
  assert.ok(
    !/const\s+VOLATILE_FILES\s*=\s*new\s+Set/.test(content),
    'scripts/gen-golden-install-parity-zcode.cjs must import VOLATILE_FILES from ' +
    'tests/helpers/install-shared.cjs, not re-declare it inline'
  );
});
