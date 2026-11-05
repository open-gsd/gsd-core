'use strict';

/**
 * #5646 — the post-wave `ui-safety-gate` and the plan-time `ui-plan-gate` must agree on whether a
 * project has a frontend. The plan gate blocks only when the phase vocabulary is corroborated by static
 * frontend evidence (#3312); the safety gate had no evidence term, so a Python-only project whose phase
 * Goal says "interface" and whose commits touch a weak-signal file (an `.html` fixture, a Python file
 * under a `ui/` directory) was halted at `execute:wave:post` after the plan gate had cleared it.
 *
 * Real git repositories, real gate modules; the verdict fields are asserted, not their prose.
 */

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { cleanup, createTempDir } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { computeUiSafetyGate } = require('../gsd-core/bin/lib/gate-ui-safety.cjs');
const { computeUiPlanGate } = require('../gsd-core/bin/lib/check-command-router.cjs');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@test.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@test.com',
};
const FRONTEND_GOAL = 'Expose an interface for the nightly report.';
const BACKEND_GOAL = 'Build the backend API endpoints only.';
const PY = 'def handler():\n    return 1\n';

const tmpDirs = [];
after(() => { for (const d of tmpDirs) { try { cleanup(d); } catch { /* best-effort */ } } });

function git(dir, ...args) {
  return gitOrThrow(args, { cwd: dir, env: GIT_ENV });
}

function write(dir, rel, content) {
  const target = path.join(dir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

/**
 * A git project for phase 1. Commit 1 holds the planning files and `rootFiles`; commit 2 adds
 * `phaseFiles` (the phase's own work). The phase carries a committed PLAN so the evaluation-scope
 * resolver can anchor the phase at a commit.
 */
function project({ goal = FRONTEND_GOAL, rootFiles = {}, phaseFiles = {}, uiSpec = false } = {}) {
  const dir = createTempDir('gsd-5646-');
  tmpDirs.push(dir);
  git(dir, 'init');
  git(dir, 'config', 'commit.gpgsign', 'false');
  write(dir, '.planning/config.json', '{}');
  write(dir, '.planning/ROADMAP.md', `## Phase 1: Report\n\n${goal}\n`);
  write(dir, '.planning/phases/01-phase/01-01-PLAN.md', '# Plan\n');
  if (uiSpec) write(dir, '.planning/phases/01-phase/01-UI-SPEC.md', '# UI Spec\n');
  write(dir, 'README.md', '# Project\n');
  for (const [rel, content] of Object.entries(rootFiles)) write(dir, rel, content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'initial');
  for (const [rel, content] of Object.entries(phaseFiles)) write(dir, rel, content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '--allow-empty', '-m', 'phase work');
  return dir;
}

const HTML_FIXTURE = { 'tests/fixtures/page.html': '<p>fixture</p>\n' };
const UI_DIR_PY = { 'src/pkg/ui/handlers.py': PY };
const TSX_COMPONENT = { 'src/components/Button.tsx': 'export const Button = () => null;\n' };
const REACT_PACKAGE = { 'package.json': JSON.stringify({ name: 'fixture', dependencies: { react: '^18.3.1' } }) };
const SWIFTUI = { 'Sources/ContentView.swift': 'import SwiftUI\nstruct ContentView: View {}\n' };
const BROKEN_PACKAGE = { 'package.json': '{ not json' };

describe('ui-safety-gate requires static frontend evidence, as ui-plan-gate does (#5646)', () => {
  test('a Python-only phase with an .html fixture does not block (#5646)', () => {
    const dir = project({ phaseFiles: { ...HTML_FIXTURE, 'src/app.py': PY } });
    const r = computeUiSafetyGate(dir, '1');
    assert.equal(r.frontend, true);
    assert.equal(r.hasUiFiles, true);
    assert.equal(r.hasUiSpec, false);
    assert.equal(r.hasFrontendEvidence, false);
    assert.equal(r.block, false);
  });

  test('a Python file under a ui/ directory does not block (#5646)', () => {
    const dir = project({ phaseFiles: UI_DIR_PY });
    const r = computeUiSafetyGate(dir, '1');
    assert.equal(r.hasUiFiles, true);
    assert.equal(r.hasFrontendEvidence, false);
    assert.equal(r.block, false);
  });

  test('a component-framework file still blocks (#5646)', () => {
    const dir = project({ phaseFiles: TSX_COMPONENT });
    const r = computeUiSafetyGate(dir, '1');
    assert.equal(r.hasFrontendEvidence, true);
    assert.equal(r.block, true);
  });

  test('a UI-framework dependency still blocks (#5646)', () => {
    const dir = project({ rootFiles: REACT_PACKAGE, phaseFiles: HTML_FIXTURE });
    const r = computeUiSafetyGate(dir, '1');
    assert.equal(r.hasFrontendEvidence, true);
    assert.equal(r.block, true);
  });

  test('native UI evidence still blocks (#5646)', () => {
    const dir = project({ rootFiles: SWIFTUI, phaseFiles: { 'Sources/theme.css': 'a { color: red }\n' } });
    const r = computeUiSafetyGate(dir, '1');
    assert.equal(r.hasFrontendEvidence, true);
    assert.equal(r.block, true);
  });

  test('no UI files changed does not block even with evidence in the tree (#5646)', () => {
    const dir = project({ rootFiles: REACT_PACKAGE, phaseFiles: { 'src/app.py': PY } });
    const r = computeUiSafetyGate(dir, '1');
    assert.equal(r.hasUiFiles, false);
    assert.equal(r.block, false);
  });

  test('a non-frontend phase never blocks (#5646)', () => {
    const dir = project({ goal: BACKEND_GOAL, phaseFiles: TSX_COMPONENT });
    const r = computeUiSafetyGate(dir, '1');
    assert.equal(r.frontend, false);
    assert.equal(r.block, false);
  });

  test('unreadable frontend evidence without a UI-SPEC is reported, not passed (#5646)', () => {
    const dir = project({ rootFiles: BROKEN_PACKAGE, phaseFiles: HTML_FIXTURE });
    const r = computeUiSafetyGate(dir, '1');
    assert.equal(r.hasFrontendEvidence, false);
    assert.equal(r.block, false);
    assert.equal(typeof r.readError, 'string', 'the verdict must say the evidence could not be read');
  });

  test('a UI-SPEC clears unreadable evidence (#5646)', () => {
    const dir = project({ rootFiles: BROKEN_PACKAGE, phaseFiles: HTML_FIXTURE, uiSpec: true });
    const r = computeUiSafetyGate(dir, '1');
    assert.equal(r.hasUiSpec, true);
    assert.equal(r.block, false);
    assert.equal(r.readError, undefined);
  });

  test('plan and safety gates agree on frontend evidence (#5646)', () => {
    const cases = [
      { phaseFiles: { ...HTML_FIXTURE, 'src/app.py': PY } },
      { phaseFiles: UI_DIR_PY },
      { phaseFiles: TSX_COMPONENT },
      { rootFiles: REACT_PACKAGE, phaseFiles: HTML_FIXTURE },
      { rootFiles: SWIFTUI, phaseFiles: { 'Sources/theme.css': 'a { color: red }\n' } },
      { rootFiles: BROKEN_PACKAGE, phaseFiles: HTML_FIXTURE },
    ];
    for (const spec of cases) {
      const dir = project(spec);
      const plan = computeUiPlanGate(dir, '1');
      const safety = computeUiSafetyGate(dir, '1');
      const label = JSON.stringify(Object.keys({ ...spec.rootFiles, ...spec.phaseFiles }));
      assert.equal(safety.hasUiFiles, true, `every case changes a UI-pattern file: ${label}`);
      assert.equal(safety.hasFrontendEvidence, plan.hasFrontendEvidence, `evidence differs for ${label}`);
      // With UI files changed and no UI-SPEC, the post-wave verdict is the plan-time verdict.
      assert.equal(safety.block, plan.block, `block differs for ${label}`);
    }
  });
});
