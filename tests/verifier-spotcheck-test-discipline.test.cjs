'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Issue #25: gsd-verifier Step 7b must not present the runner-specific
// full-suite "| grep" anti-pattern, and must steer toward
// enumerate-for-existence / single-named-test-for-pass.
const verifierPath = path.join(__dirname, '..', 'agents', 'gsd-verifier.md');
const content = fs.readFileSync(verifierPath, 'utf8');

// Scope assertions to the Step 7b section so the guard tracks the right place.
const start = content.indexOf('## Step 7b');
const end = content.indexOf('## Step 7c', start);
assert.ok(start !== -1 && end !== -1 && end > start, 'Step 7b section not found');
const step7b = content.slice(start, end);

test('Step 7b drops the misleading full-suite grep example', () => {
  assert.ok(
    !step7b.includes('npm test -- --grep "$PHASE_TEST_PATTERN" 2>&1 | grep -q "passing"'),
    'the runner-specific `npm test --grep` example should be removed (it mis-generalizes to `<full-suite> | grep`)'
  );
});

test('Step 7b steers existence proofs to test enumeration', () => {
  assert.ok(
    /cargo test -- --list/.test(step7b),
    'Step 7b should show the correct `cargo test -- --list` enumeration form'
  );
  assert.ok(
    /pytest --collect-only/.test(step7b) &&
      /vitest list/.test(step7b) &&
      /go test -list/.test(step7b),
    'Step 7b should list cross-ecosystem enumeration commands (pytest/vitest/go)'
  );
});

test('Step 7b steers pass-checks to a single named test', () => {
  assert.ok(
    /-- --exact/.test(step7b) &&
      /pytest -k/.test(step7b) &&
      /vitest run -t/.test(step7b),
    'Step 7b should show single-named-test commands across ecosystems'
  );
});

test('Step 7b forbids re-running the full suite per must-have', () => {
  assert.ok(
    /at most once per verification/i.test(step7b),
    'Step 7b should forbid invoking the full workspace test command more than once per verification'
  );
  assert.ok(
    /grep/i.test(step7b) && /per must-have|per truth/i.test(step7b),
    'Step 7b should explicitly call out the per-must-have full-suite grep anti-pattern'
  );
});
