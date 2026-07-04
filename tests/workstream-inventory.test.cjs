'use strict';

// Regression + projection coverage for the workstream-inventory module.
// #1913: status must be derived from authoritative shipped signals (milestone
// archive snapshot / ROADMAP SHIPPED marker), not trusted from the mutable
// STATE.md `Status` field.

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { cleanup } = require('./helpers.cjs');
const { createFixture, seedWorkstream } = require('./fixtures/index.cjs');
const { buildWorkstreamInventory } = require('../gsd-core/bin/lib/workstream-inventory-builder.cjs');
const { inspectWorkstream } = require('../gsd-core/bin/lib/workstream-inventory.cjs');

const STALE_STATE = 'status: executing\n';
const IN_PROGRESS_ROADMAP =
  '# Roadmap\n## Milestones\n- v2.0 Test — IN PROGRESS\n## Phases\n### Phase 1: Foo\n**Goal:** foo\n';

describe('#1913 — workstream status derived from authoritative shipped signals', () => {
  let tmpDir;
  before(() => { tmpDir = createFixture(); });
  after(() => cleanup(tmpDir));

  test('builder: milestoneShipped overrides a stale executing field (derived + conflict)', () => {
    const inv = buildWorkstreamInventory({
      name: 'ws-a',
      projectDir: tmpDir,
      workstreamDir: path.join(tmpDir, '.planning', 'workstreams', 'ws-a'),
      phaseDirNames: [],
      activeWorkstreamName: '',
      phaseFilesCounts: [],
      roadmapPhaseCount: 0,
      stateProjection: { status: 'executing', current_phase: null, last_activity: null },
      filesExist: { roadmap: true, state: true, requirements: true },
      milestoneShipped: true,
    });
    assert.equal(inv.status, 'milestone complete');
    assert.equal(inv.status_source, 'derived');
    assert.equal(inv.status_conflict, true);
  });

  test('builder: no shipped signal → field status, no conflict', () => {
    const inv = buildWorkstreamInventory({
      name: 'ws-b',
      projectDir: tmpDir,
      workstreamDir: path.join(tmpDir, '.planning', 'workstreams', 'ws-b'),
      phaseDirNames: [],
      activeWorkstreamName: '',
      phaseFilesCounts: [],
      roadmapPhaseCount: 0,
      stateProjection: { status: 'executing', current_phase: null, last_activity: null },
      filesExist: { roadmap: true, state: true, requirements: true },
      milestoneShipped: false,
    });
    assert.equal(inv.status, 'executing');
    assert.equal(inv.status_source, 'field');
    assert.equal(inv.status_conflict, false);
  });

  test('inspectWorkstream: shipped archive snapshot + stale executing STATE → derived complete', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-archived' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), STALE_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), IN_PROGRESS_ROADMAP);
    // Authoritative shipped signal: an archived milestone snapshot.
    fs.mkdirSync(path.join(wsDir, 'milestones'), { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'milestones', 'v1.0-ROADMAP.md'), '# v1.0 archived\n');

    const inv = inspectWorkstream(tmpDir, 'ws-archived', { active: null });
    assert.ok(inv, 'inventory should be produced');
    assert.equal(inv.status, 'milestone complete');
    assert.equal(inv.status_source, 'derived');
    assert.equal(inv.status_conflict, true);
  });

  test('inspectWorkstream: ROADMAP SHIPPED marker + stale executing STATE → derived complete', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-shipped' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), STALE_STATE);
    fs.writeFileSync(
      path.join(wsDir, 'ROADMAP.md'),
      '# Roadmap\n## Milestones\n<details><summary>✅ v1.0 MVP - SHIPPED 2026-06-01</summary>\n## Phases\n### Phase 1: Foo\n**Goal:** foo\n'
    );

    const inv = inspectWorkstream(tmpDir, 'ws-shipped', { active: null });
    assert.ok(inv, 'inventory should be produced');
    assert.equal(inv.status, 'milestone complete');
    assert.equal(inv.status_source, 'derived');
    assert.equal(inv.status_conflict, true);
  });

  test('inspectWorkstream: no shipped signals + executing STATE → field status, no conflict', () => {
    const wsDir = seedWorkstream(tmpDir, { name: 'ws-active' });
    fs.writeFileSync(path.join(wsDir, 'STATE.md'), STALE_STATE);
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), IN_PROGRESS_ROADMAP);

    const inv = inspectWorkstream(tmpDir, 'ws-active', { active: null });
    assert.ok(inv, 'inventory should be produced');
    assert.equal(inv.status, 'executing');
    assert.equal(inv.status_source, 'field');
    assert.equal(inv.status_conflict, false);
  });
});
