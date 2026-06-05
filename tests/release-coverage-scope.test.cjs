// allow-test-rule: source-text-is-the-product
// .github/workflows/release.yml is the deployed CI contract; asserting
// the release-gate test command is only expressible against the workflow text.

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RELEASE_WORKFLOW = path.join(__dirname, '..', '.github', 'workflows', 'release.yml');

describe('release-coverage-scope', () => {
  test('release.yml uses test:coverage:unit (not full suite) in both rc and finalize gates', () => {
    const lines = fs.readFileSync(RELEASE_WORKFLOW, 'utf8').split('\n').map(l => l.trim());
    const bareCount = lines.filter(l => l === 'npm run test:coverage').length;
    const unitCount = lines.filter(l => l === 'npm run test:coverage:unit').length;
    assert.strictEqual(bareCount, 0,
      `release.yml still has ${bareCount} bare 'npm run test:coverage' line(s); expected 0`);
    assert.strictEqual(unitCount, 2,
      `release.yml has ${unitCount} 'npm run test:coverage:unit' line(s); expected 2`);
  });


});
