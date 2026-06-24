// allow-test-rule: source-text-is-the-product see #1528
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const UI_REVIEW = path.join(__dirname, '..', 'gsd-core', 'workflows', 'ui-review.md');
const MANAGER = path.join(__dirname, '..', 'gsd-core', 'workflows', 'manager.md');

describe('ui-review next guidance', () => {
  test('prioritizes current-phase verification over next-phase planning (#1528)', () => {
    const content = fs.readFileSync(UI_REVIEW, 'utf-8');
    const nextBlock = content.slice(
      content.indexOf('## ▶ Next'),
      content.indexOf('## Automated UI Verification'),
    );

    assert.match(nextBlock, /verify-work \{N\}/, 'ui-review must route to current-phase UAT');
    assert.doesNotMatch(
      nextBlock,
      /plan-phase \{N\+1\}/,
      'ui-review must not present next-phase planning before current-phase verification passes',
    );
    assert.equal(
      (nextBlock.match(/verify-work \{N\}/g) || []).length,
      1,
      'ui-review next block must not duplicate verify-work guidance',
    );
  });
});

describe('manager verify dispatch', () => {
  test('dispatches verify recommendations through their command field (#1523)', () => {
    const content = fs.readFileSync(MANAGER, 'utf-8');
    const compoundBlock = content.slice(
      content.indexOf('### Compound Action'),
      content.indexOf('### Discuss Phase N'),
    );

    assert.match(compoundBlock, /recommended action's `command`/);
    assert.match(compoundBlock, /gsd-execute-phase/);
    assert.match(compoundBlock, /gsd-verify-work/);
    assert.doesNotMatch(
      compoundBlock,
      /Inline verification:\s*```[\s\S]*Skill\(skill="gsd-verify-work", args="\{PHASE_NUM\}"\)/,
    );
  });
});
