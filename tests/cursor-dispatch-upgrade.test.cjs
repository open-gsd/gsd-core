'use strict';

/**
 * cursor dispatch UPGRADE — ADR-1239 / #2089 AC4b.
 *
 * Proves GSD's wave-based execution drives Cursor's native named/background
 * nested subagent dispatch (background:true, backgroundDispatch:true,
 * nested:true, maxDepth:2) instead of flattening to inline sequential calls.
 *
 * Cite:
 *   https://cursor.com/docs/subagents  — named + background dispatch
 *   https://cursor.com/docs/sdk/typescript — nested subagent depth-2 constraint
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { shouldFlattenDispatch } = require('../gsd-core/bin/lib/host-integration.cjs');

const CUR_CAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'capabilities', 'cursor', 'capability.json'), 'utf8'),
);
const CUR_DISPATCH = CUR_CAP.runtime.hostIntegration.dispatch;

// -- AC4b: cursor dispatch axes ----------------------------------------------

test('cursor dispatch declares namedDispatch + nested + background + backgroundDispatch', () => {
  assert.equal(CUR_DISPATCH.namedDispatch, true,
    'cite https://cursor.com/docs/subagents — named subagent invocation');
  assert.equal(CUR_DISPATCH.nested, true,
    'cite https://cursor.com/docs/sdk/typescript — nested subagents');
  assert.equal(CUR_DISPATCH.background, true,
    'cite https://cursor.com/docs/subagents — background dispatch');
  assert.equal(CUR_DISPATCH.backgroundDispatch, true,
    'cite https://cursor.com/docs/subagents FAQ — subagents can launch child subagents');
});

test('cursor dispatch respects maxDepth: 2 (the documented constraint)', () => {
  assert.equal(CUR_DISPATCH.maxDepth, 2,
    'cite https://cursor.com/docs/sdk/typescript — "a subagent launched by another subagent can\'t launch further"');
});

// -- AC4b: shouldFlattenDispatch returns false (NOT force-flattened) ----------

test('shouldFlattenDispatch(cursor) is false — GSD uses native background dispatch', () => {
  assert.equal(shouldFlattenDispatch(CUR_DISPATCH), false,
    'cursor has background:true + backgroundDispatch:true → GSD must NOT force-flatten');
});

test('pre-upgrade cursor axes (background:false) DID force-flatten', () => {
  const preUpgrade = { ...CUR_DISPATCH, background: false, backgroundDispatch: 'undocumented' };
  assert.equal(shouldFlattenDispatch(preUpgrade), true,
    'pre-upgrade cursor (no background dispatch) was force-flattened — the behavioral change #2089 lands');
});

test('shouldFlattenDispatch is true when backgroundDispatch is false (depth-2 but no bg dispatch)', () => {
  const noBgDispatch = { ...CUR_DISPATCH, backgroundDispatch: false };
  assert.equal(shouldFlattenDispatch(noBgDispatch), true,
    'background without backgroundDispatch still flattens (the #853 rule)');
});

// -- AC4b: boundary — maxDepth 2 is the discriminator vs unbounded -----------

test('maxDepth 2 is the documented constraint (not -1 unbounded)', () => {
  assert.notEqual(CUR_DISPATCH.maxDepth, -1,
    'cursor is NOT unbounded — depth-2 is the documented hard limit');
  assert.ok(CUR_DISPATCH.maxDepth > 0 && CUR_DISPATCH.maxDepth <= 2,
    'maxDepth must be a positive integer ≤ 2 per cursor docs');
});
