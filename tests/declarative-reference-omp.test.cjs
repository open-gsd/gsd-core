// allow-test-rule: structural-regression-guard — assert no `runtime === 'omp'` string-equality branch in bin/install.js
'use strict';

/**
 * Declarative reference host — Oh My Pi (OMP).
 *
 * OMP installs through the descriptor-driven artifactLayout (commands, nested
 * skills, agents with model overrides, rules, extensions), and its
 * capability.json declares `hostIntegration` + `dispatch` axes + `hostBehaviors`.
 * The install flows entirely through descriptor/hostBehaviors — zero
 * `runtime === 'omp'` branches in bin/install.js.
 *
 * This test mirrors tests/declarative-reference-copilot.test.cjs: it
 * (1) classifies OMP's profile via profileOf, (2) confirms the public
 * declarative adapter classifies it as declarative, (3) proves negotiation
 * fails CLOSED on a corrupted descriptor, (4) proves the validator accepts
 * the descriptor, and (5) source-greps bin/install.js for any
 * `runtime === 'omp'` string-equality branch (AC2).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  profileOf,
  negotiateHostCapabilities,
  UNDOCUMENTED,
} = require('../gsd-core/bin/lib/host-integration.cjs');
const { validateCapability } = require('../gsd-core/bin/lib/capability-validator.cjs');
const { createDeclarativeAdapter } = require('../gsd-core/bin/lib/adapter-declarative.cjs');

const DESC = path.join(__dirname, '..', 'capabilities', 'omp', 'capability.json');
const OMP_CAP = JSON.parse(fs.readFileSync(DESC, 'utf8'));
const OMP_AXES = OMP_CAP.runtime.hostIntegration;

test('OMP classifies as the declarative-cli reference profile (profileOf)', () => {
  const desc = JSON.parse(fs.readFileSync(DESC, 'utf8'));
  const axes = desc.runtime.hostIntegration;
  assert.ok(axes && axes.embeddingMode, 'omp descriptor declares hostIntegration axes');
  assert.equal(profileOf(axes), 'declarative-cli',
    'OMP is a Declarative-CLI host');
});

test('the public declarative adapter classifies OMP as a declarative host', () => {
  const adapter = createDeclarativeAdapter({ runtime: 'omp' });
  assert.equal(adapter.kind, 'declarative');
  assert.equal(adapter.runtime, 'omp');
  assert.equal(typeof adapter.install, 'function');
});

test('negotiation fails CLOSED on a corrupted OMP descriptor', () => {
  // Negotiation takes hostIntegration axes. A corrupted embeddingMode must
  // degrade to a safe default, not pass through the corrupted value.
  const corrupted = { ...OMP_AXES, embeddingMode: 'INVALID_VALUE' };
  const result = negotiateHostCapabilities(corrupted);
  assert.notEqual(result.effective.embeddingMode, 'INVALID_VALUE',
    'a corrupted OMP embeddingMode must degrade to a safe default, not pass through');
});

test('the validator accepts the OMP descriptor', () => {
  const errors = validateCapability(OMP_CAP, 'omp');
  assert.deepEqual(errors, [],
    `OMP descriptor must pass validation; got: ${JSON.stringify(errors)}`);
});

test('no `runtime === "omp"` string-equality branch remains in bin/install.js (AC2)', () => {
  const installJs = fs.readFileSync(
    path.join(__dirname, '..', 'bin', 'install.js'),
    'utf8',
  );
  // Strip comments to avoid false positives from comments mentioning "omp".
  const stripped = installJs
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  const branchHits = stripped.match(/runtime\s*===\s*['"]omp['"]/g) || [];
  assert.deepEqual(branchHits, [],
    `AC2: no runtime === 'omp' string-equality branch may remain in bin/install.js; found ${branchHits.length} occurrence(s)`);
});
