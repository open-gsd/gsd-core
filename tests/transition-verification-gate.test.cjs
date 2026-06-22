// allow-test-rule: source-text-is-the-product see #1522

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const transitionWorkflowPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'transition.md');

test('transition workflow treats unresolved verification as a blocking phase gate (#1522)', () => {
  const content = fs.readFileSync(transitionWorkflowPath, 'utf-8');

  assert.match(content, /preliminary check blocks obviously unresolved verification/i);
  assert.match(content, /phase\.complete[\s\S]*fail-closes/i);
  assert.match(content, /authoritative stale-aware gate/i);
  assert.match(content, /canonical verification\s+status is `passed`/i);
  assert.doesNotMatch(content, /does NOT block transition/i);
  assert.doesNotMatch(content, /carry forward as debt/i);
});
