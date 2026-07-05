'use strict';

// Regression guard for #2018 — applySurface over an empty/unresolvable manifest
// silently deleted every gsd-* agent because the agent-prune loop in _syncGsdDir
// didn't check manifest membership (unlike pruneSkillDirs which conservatively
// preserves everything when the manifest is empty). The fix skips the agent-prune
// loop when the manifest is empty/absent so agents are never bulk-deleted.

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { _syncGsdDir } = require('../gsd-core/bin/lib/surface.cjs');
const { cleanup } = require('./helpers.cjs');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-surface-empty-')); }

describe('#2018 — empty manifest must not delete gsd-* agents', () => {
  let dest, staged;
  beforeEach(() => {
    dest = tmp(); staged = tmp();
    // Simulate existing agents in dest (what a real install has)
    for (const name of ['gsd-executor.md', 'gsd-planner.md', 'gsd-verifier.md']) {
      fs.writeFileSync(path.join(dest, name), `# ${name}\n`);
    }
    // Staged dir is EMPTY (unresolvable manifest → nothing staged)
  });
  afterEach(() => { cleanup(dest); cleanup(staged); });

  test('empty manifest → agents preserved (not deleted)', () => {
    _syncGsdDir(staged, dest, 'agents', new Map());
    const remaining = fs.readdirSync(dest).filter((f) => f.startsWith('gsd-'));
    assert.deepEqual(remaining.sort(), ['gsd-executor.md', 'gsd-planner.md', 'gsd-verifier.md'],
      'all gsd-* agents must survive an empty manifest');
  });

  test('undefined manifest → agents preserved', () => {
    _syncGsdDir(staged, dest, 'agents', undefined);
    const remaining = fs.readdirSync(dest).filter((f) => f.startsWith('gsd-'));
    assert.ok(remaining.length === 3, 'all agents preserved with undefined manifest');
  });

  test('non-empty manifest + empty staged → agents still preserved (staged set empty but manifest exists)', () => {
    // A populated manifest (even with a different set) is trusted; but staged is empty.
    // The manifest gate only fires on EMPTY manifest. With a non-empty manifest but
    // empty staged, the prune loop SHOULD run (agents not in staged get pruned).
    // This test documents the boundary: non-empty manifest → prune happens.
    const manifest = new Map([['gsd-old-agent', []]]);
    _syncGsdDir(staged, dest, 'agents', manifest);
    const remaining = fs.readdirSync(dest).filter((f) => f.startsWith('gsd-'));
    // With a non-empty manifest, staged is empty → all agents pruned (this is the
    // existing behavior for a genuine "all agents were un-surfaced" scenario, NOT
    // the empty-manifest bug).
    assert.deepEqual(remaining, [], 'non-empty manifest + empty staged → agents pruned (expected behavior)');
  });

  test('empty manifest but new agents staged → new agents added, existing preserved', () => {
    // Stage a new agent
    fs.writeFileSync(path.join(staged, 'gsd-new-agent.md'), '# New\n');
    _syncGsdDir(staged, dest, 'agents', new Map());
    const remaining = fs.readdirSync(dest).filter((f) => f.startsWith('gsd-'));
    assert.ok(remaining.includes('gsd-new-agent.md'), 'new staged agent must be copied');
    assert.ok(remaining.includes('gsd-executor.md'), 'existing agent must be preserved');
    assert.ok(remaining.length === 4, '3 existing + 1 new = 4 agents');
  });
});
