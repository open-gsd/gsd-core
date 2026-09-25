'use strict';

// #4304 (ADR-612 PR-4 review fix, Major finding) — parity test between the
// phase/state write paths' bracket-numeric canonicalization and the Phase Id
// Display Module's `renderBracketPhaseDisplay`/`renderBracketMilestoneDisplay`,
// which now own that grammar alone (`milestoneToken`/`phaseToken`,
// src/phase-id-display.cts). Before this fix, `bracketWriteContext`/
// `bracketPhaseId` (src/phase.cts) and `phaseDisplayFor` (src/state.cts) each
// re-derived "legacy vN.0 milestone / phase numeric -> bracket token" locally,
// with semantics that silently diverged from the adapter on malformed input.
// This file proves the write path and the adapter agree for every milestone/phase
// spelling in the matrix below, and that an adapter-rejected input is
// rejected loudly by the write path rather than silently mis-canonicalized.

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { parsePhaseId, toDir } = require('../gsd-core/bin/lib/phase-id.cjs');
const {
  renderBracketPhaseDisplay,
  renderBracketMilestoneDisplay,
} = require('../gsd-core/bin/lib/phase-id-display.cjs');

const projects = new Set();

afterEach(() => {
  for (const dir of projects) cleanup(dir);
  projects.clear();
});

function project(prefix = 'adr-612-write-parity-') {
  const dir = createTempProject(prefix);
  projects.add(dir);
  return dir;
}

function planning(dir, ...parts) {
  return path.join(dir, '.planning', ...parts);
}

function writeConfig(dir) {
  fs.writeFileSync(
    planning(dir, 'config.json'),
    JSON.stringify({ project_code: 'CK', phase_id_convention: 'bracket' }, null, 2) + '\n',
  );
}

// A fixture whose milestone is expected to be ACCEPTED by the adapter: the
// ROADMAP's milestone/phase headings are built from the adapter's own
// `renderBracketMilestoneDisplay`, not a hand-spelled `[CK.02]`, so the
// fixture stays internally consistent across every milestone spelling in the
// matrix (e.g. "v10" qualifies as `[CK.10]`, not `[CK.02]`).
function writeValidBracketFixture(dir, milestone) {
  writeConfig(dir);
  const milestoneId = renderBracketMilestoneDisplay(milestone, 'CK');
  assert.notEqual(milestoneId, null, `test setup: adapter must accept milestone "${milestone}"`);
  fs.writeFileSync(
    planning(dir, 'STATE.md'),
    [
      '---',
      'gsd_state_version: 1.0',
      `milestone: ${milestone}`,
      'milestone_name: Foundation',
      'status: planning',
      'last_activity_desc: Roadmap created',
      '---',
      '',
      '# Project State',
      '',
      '**Current focus:** Pending',
      '**Status:** Planning',
      '**Current Phase:** 01',
      '**Current Phase Name:** Foundation',
      '**Current Plan:** 1',
      '**Total Plans in Phase:** 1',
      '**Last Activity:** 2026-09-01',
      '**Last Activity Description:** Roadmap created',
      '',
      '## Current Position',
      '',
      'Phase: 01 (Foundation) — READY TO PLAN',
      'Plan: 1 of 1',
      'Status: Planning',
      'Last activity: 2026-09-01 — Roadmap created',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    planning(dir, 'ROADMAP.md'),
    [
      '# Roadmap',
      '',
      `## ${milestoneId} ${milestone} — Foundation`,
      '',
      `### ${milestoneId} 01: Foundation`,
      '',
      '**Goal:** Existing',
      '',
    ].join('\n'),
  );
  fs.mkdirSync(planning(dir, 'phases', `${milestoneId.slice(1, -1)}-01-foundation`), { recursive: true });
}

// A fixture whose milestone is expected to be REJECTED by the adapter: the
// write path must refuse before ever reading ROADMAP.md, so the fixture's
// ROADMAP is a minimal placeholder rather than a bracket-consistent one.
function writeRejectedMilestoneFixture(dir, milestone) {
  writeConfig(dir);
  fs.writeFileSync(planning(dir, 'STATE.md'), `---\nmilestone: ${milestone}\n---\n`);
  fs.writeFileSync(planning(dir, 'ROADMAP.md'), '# Roadmap\n');
}

function run(args, cwd) {
  const result = runGsdTools(args, cwd);
  assert.equal(result.success, true, `${args.join(' ')} failed: ${result.error || result.output}`);
  return JSON.parse(result.output);
}

const MILESTONE_SPELLINGS = ['v2', '2', 'v02', '2.0', 'v2.0', 'v10'];
const PHASE_SPELLINGS = ['3', '03', '3.1', '03.01', '12'];
const ADAPTER_REJECTED = ['v2.0.1', 'abc', '3.1.1'];

describe('#4304 review fix (Major): write-path bracket canonicalization matches the adapter', () => {
  for (const milestone of MILESTONE_SPELLINGS) {
    test(`phase add heading and directory carry the adapter's token for milestone "${milestone}"`, () => {
      const dir = project();
      writeValidBracketFixture(dir, milestone);

      const out = run(['phase', 'add', 'Next Phase'], dir);

      const expectedId = renderBracketPhaseDisplay(milestone, 2, 'CK');
      assert.notEqual(expectedId, null, `test setup: adapter must accept milestone "${milestone}"`);
      const expectedDir = toDir(parsePhaseId(expectedId), 'next-phase');

      assert.equal(out.directory, `.planning/phases/${expectedDir}`);
      assert.equal(fs.existsSync(planning(dir, 'phases', expectedDir)), true);
      const roadmap = fs.readFileSync(planning(dir, 'ROADMAP.md'), 'utf8');
      assert.equal(roadmap.includes(`### ${expectedId}: Next Phase`), true);
    });
  }

  for (const phase of PHASE_SPELLINGS) {
    test(`state begin-phase descriptive text carries the adapter's token for phase "${phase}"`, () => {
      const dir = project();
      writeValidBracketFixture(dir, 'v2.0');

      run(['state', 'begin-phase', '--phase', phase, '--name', 'Parity Check', '--plans', '1'], dir);

      const expectedId = renderBracketPhaseDisplay('v2.0', phase, 'CK');
      assert.notEqual(expectedId, null, `test setup: adapter must accept phase "${phase}"`);
      const state = fs.readFileSync(planning(dir, 'STATE.md'), 'utf8');
      assert.equal(state.includes(`**Current focus:** ${expectedId} — Parity Check`), true);
      assert.equal(state.includes(`**Last Activity Description:** ${expectedId} execution started`), true);
    });
  }

  for (const bad of ADAPTER_REJECTED) {
    test(`phase add refuses instead of mis-canonicalizing an adapter-rejected milestone "${bad}"`, () => {
      const dir = project();
      writeRejectedMilestoneFixture(dir, bad);
      assert.equal(renderBracketPhaseDisplay(bad, 2, 'CK'), null, `test setup: adapter must reject milestone "${bad}"`);
      const before = fs.readFileSync(planning(dir, 'ROADMAP.md'), 'utf8');

      const result = runGsdTools(['phase', 'add', 'Next Phase'], dir);

      assert.equal(result.success, false, `expected refusal for milestone "${bad}", got: ${result.output}`);
      assert.equal(fs.readFileSync(planning(dir, 'ROADMAP.md'), 'utf8'), before);
      assert.deepEqual(fs.readdirSync(planning(dir, 'phases')), []);
    });

    test(`state begin-phase refuses instead of mis-canonicalizing an adapter-rejected phase "${bad}"`, () => {
      const dir = project();
      writeValidBracketFixture(dir, 'v2.0');
      assert.equal(renderBracketPhaseDisplay('v2.0', bad, 'CK'), null, `test setup: adapter must reject phase "${bad}"`);
      const before = fs.readFileSync(planning(dir, 'STATE.md'), 'utf8');

      const result = runGsdTools(['state', 'begin-phase', '--phase', bad, '--name', 'X', '--plans', '1'], dir);

      assert.equal(result.success, false, `expected refusal for phase "${bad}", got: ${result.output}`);
      assert.equal(fs.readFileSync(planning(dir, 'STATE.md'), 'utf8'), before);
    });
  }
});
