'use strict';

/**
 * Behavioral tests for the `check ui-plan-gate` subcommand (#1026).
 *
 * Tests the `computeUiPlanGate` pure function exported from check-command-router.cjs.
 * Uses in-memory tmpdir fixtures — no real CLI subprocess needed.
 *
 * Return shape: { frontend: bool, hasUiSpec: bool, block: bool, uiSpecPath: string|null }
 * Invariant: block = frontend && !hasUiSpec
 *
 * Per RULESET.TESTS.boundary-coverage: exercises all three branches:
 *   (a) frontend+no-spec → block:true
 *   (b) frontend+spec    → block:false
 *   (c) non-frontend     → block:false
 *
 * Per RULESET.TESTS.coderabbit-fix-prefer: calls the exported function and asserts typed fields.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');
const fc = require('./helpers/fast-check-setup.cjs');
const { computeUiPlanGate } = require('../gsd-core/bin/lib/check-command-router.cjs');
const { hasStaticFrontendEvidence } = require('../gsd-core/bin/lib/ui-frontend-evidence.cjs');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a minimal project dir with:
 *   .planning/ROADMAP.md   — one phase section with `phaseSection` body
 *   .planning/phases/01-test-phase/  — phase directory
 *   (optionally) a *-UI-SPEC.md inside the phase dir
 *   (optionally) static frontend evidence (#3312): 'component-file' writes
 *   src/App.tsx; 'package-json' writes a package.json with a react dependency;
 *   false (default) writes no frontend evidence at all (markdown/bash repo).
 */
function makeProject({ phaseSection = '', hasUiSpec = false, frontendEvidence = 'component-file' } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-plan-gate-test-'));
  const planningDir = path.join(tmpDir, '.planning');
  const phasesDir = path.join(planningDir, 'phases');
  const phaseDir = path.join(phasesDir, '01-test-phase');

  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify({}), 'utf8');
  if (frontendEvidence === 'component-file') {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'App.tsx'), 'export function App() { return null; }\n', 'utf8');
  } else if (frontendEvidence === 'package-json') {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'fixture', dependencies: { react: '^18.3.1' } }),
      'utf8',
    );
  } else if (frontendEvidence === 'swiftui') {
    fs.mkdirSync(path.join(tmpDir, 'Sources'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'Sources', 'ContentView.swift'), 'import SwiftUI\nstruct ContentView: View { var body: some View { Text("hi") } }\n', 'utf8');
  } else if (frontendEvidence === 'compose') {
    fs.mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'lib', 'Main.kt'), 'import androidx.compose.material3.Text\n', 'utf8');
  } else if (frontendEvidence === 'flutter') {
    fs.mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'lib', 'main.dart'), "import 'package:flutter/material.dart';\nvoid main() {}\n", 'utf8');
  } else if (frontendEvidence === 'xaml') {
    fs.writeFileSync(path.join(tmpDir, 'MainPage.xaml'), '<Page x:Class="App.MainPage" />\n', 'utf8');
  } else if (frontendEvidence === 'swift-non-ui') {
    fs.mkdirSync(path.join(tmpDir, 'Sources'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'Sources', 'TaskRunner.swift'), 'import Foundation\nstruct TaskRunner { }\n', 'utf8');
  }

  // Minimal ROADMAP.md with one phase section
  const roadmapContent = [
    '# Project Roadmap',
    '',
    '## Phase 1: Test Phase',
    '',
    phaseSection,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(planningDir, 'ROADMAP.md'), roadmapContent, 'utf8');

  if (hasUiSpec) {
    fs.writeFileSync(path.join(phaseDir, '01-UI-SPEC.md'), '# UI Design Contract\n', 'utf8');
  }

  return { tmpDir, phaseDir };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('computeUiPlanGate — ui.plan-gate check logic (#1026)', () => {
  let frontendNoSpec, frontendWithSpec, nonFrontend;

  before(() => {
    // Branch (a): frontend + no UI-SPEC → block:true
    frontendNoSpec = makeProject({
      phaseSection: 'Build the user interface and dashboard components for the frontend.',
      hasUiSpec: false,
    });
    // Branch (b): frontend + UI-SPEC exists → block:false
    frontendWithSpec = makeProject({
      phaseSection: 'Build the frontend dashboard with React components and UI forms.',
      hasUiSpec: true,
    });
    // Branch (c): no frontend indicators → block:false
    nonFrontend = makeProject({
      phaseSection: 'Add a REST API endpoint and database migration for the user table.',
      hasUiSpec: false,
    });
  });

  after(() => {
    for (const { tmpDir } of [frontendNoSpec, frontendWithSpec, nonFrontend]) {
      try { cleanup(tmpDir); } catch { /* ignore */ }
    }
  });

  describe('return shape', () => {
    test('result has required keys: frontend, hasUiSpec, block, uiSpecPath', () => {
      const result = computeUiPlanGate(nonFrontend.tmpDir, '1');
      assert.ok(typeof result === 'object' && result !== null, 'result must be an object');
      assert.ok(typeof result.frontend === 'boolean', 'frontend must be boolean');
      assert.ok(typeof result.hasUiSpec === 'boolean', 'hasUiSpec must be boolean');
      assert.ok(typeof result.block === 'boolean', 'block must be boolean');
      assert.ok('uiSpecPath' in result, 'uiSpecPath key must be present');
    });

    test('block invariant: block === frontend && hasFrontendEvidence && !hasUiSpec for all scenarios', () => {
      // #3312: block additionally requires static frontend evidence — token match
      // alone no longer blocks (hyphenated proper nouns like `dashboard-financeiro`
      // satisfy the sniffer's word boundary).
      for (const [label, { tmpDir }] of [
        ['frontendNoSpec', frontendNoSpec],
        ['frontendWithSpec', frontendWithSpec],
        ['nonFrontend', nonFrontend],
      ]) {
        const r = computeUiPlanGate(tmpDir, '1');
        assert.strictEqual(
          r.block,
          r.frontend && r.hasFrontendEvidence && !r.hasUiSpec,
          `${label}: block invariant violated — frontend=${r.frontend} hasFrontendEvidence=${r.hasFrontendEvidence} hasUiSpec=${r.hasUiSpec} block=${r.block}`,
        );
      }
    });
  });

  describe('branch (a) — frontend + no UI-SPEC → block:true', () => {
    test('detects frontend indicators in phase section', () => {
      const r = computeUiPlanGate(frontendNoSpec.tmpDir, '1');
      assert.strictEqual(r.frontend, true, 'should detect frontend indicators');
    });

    test('hasUiSpec is false when no *-UI-SPEC.md exists', () => {
      const r = computeUiPlanGate(frontendNoSpec.tmpDir, '1');
      assert.strictEqual(r.hasUiSpec, false, 'hasUiSpec must be false');
    });

    test('block is true when frontend + no UI-SPEC', () => {
      const r = computeUiPlanGate(frontendNoSpec.tmpDir, '1');
      assert.strictEqual(r.block, true, 'block must be true');
    });

    test('uiSpecPath is null when no UI-SPEC', () => {
      const r = computeUiPlanGate(frontendNoSpec.tmpDir, '1');
      assert.strictEqual(r.uiSpecPath, null, 'uiSpecPath must be null');
    });
  });

  describe('branch (b) — frontend + UI-SPEC exists → block:false', () => {
    test('detects frontend indicators in phase section', () => {
      const r = computeUiPlanGate(frontendWithSpec.tmpDir, '1');
      assert.strictEqual(r.frontend, true, 'should detect frontend indicators');
    });

    test('hasUiSpec is true when *-UI-SPEC.md exists', () => {
      const r = computeUiPlanGate(frontendWithSpec.tmpDir, '1');
      assert.strictEqual(r.hasUiSpec, true, 'hasUiSpec must be true');
    });

    test('block is false when UI-SPEC exists', () => {
      const r = computeUiPlanGate(frontendWithSpec.tmpDir, '1');
      assert.strictEqual(r.block, false, 'block must be false when spec exists');
    });

    test('uiSpecPath is a non-empty string ending in -UI-SPEC.md', () => {
      const r = computeUiPlanGate(frontendWithSpec.tmpDir, '1');
      assert.ok(typeof r.uiSpecPath === 'string' && r.uiSpecPath.length > 0,
        'uiSpecPath must be a non-empty string');
      assert.ok(r.uiSpecPath.endsWith('-UI-SPEC.md'), 'uiSpecPath must end with -UI-SPEC.md');
    });
  });

  describe('branch (c) — non-frontend phase → block:false', () => {
    test('frontend is false for non-UI phase section', () => {
      const r = computeUiPlanGate(nonFrontend.tmpDir, '1');
      assert.strictEqual(r.frontend, false, 'should NOT detect frontend indicators');
    });

    test('block is false for non-frontend phases', () => {
      const r = computeUiPlanGate(nonFrontend.tmpDir, '1');
      assert.strictEqual(r.block, false, 'block must be false');
    });
  });

  describe('uses checkUiPresence word-boundary rules — no detection reimplementation', () => {
    test('"microfrontend" (compound word) does NOT trigger frontend:true', () => {
      const proj = makeProject({
        phaseSection: 'Refactor the microfrontend architecture for better code reuse.',
        hasUiSpec: false,
      });
      try {
        const r = computeUiPlanGate(proj.tmpDir, '1');
        assert.strictEqual(r.frontend, false,
          '"microfrontend" compound word must NOT trigger frontend (word-boundary rule from checkUiPresence)');
      } finally {
        try { cleanup(proj.tmpDir); } catch { /* ignore */ }
      }
    });

    test('"micro-frontend" (hyphenated) triggers frontend:true', () => {
      const proj = makeProject({
        phaseSection: 'Refactor the micro-frontend architecture for better code reuse.',
        hasUiSpec: false,
      });
      try {
        const r = computeUiPlanGate(proj.tmpDir, '1');
        assert.strictEqual(r.frontend, true,
          '"micro-frontend" must trigger frontend detection (word-boundary rule from checkUiPresence)');
      } finally {
        try { cleanup(proj.tmpDir); } catch { /* ignore */ }
      }
    });
  });

  describe('graceful degradation', () => {
    test('non-existent project dir returns frontend:false, block:false (no crash)', () => {
      const r = computeUiPlanGate('/tmp/nonexistent-gsd-test-dir-xyz', '1');
      assert.strictEqual(typeof r.frontend, 'boolean', 'frontend must be boolean');
      assert.strictEqual(r.frontend, false, 'missing roadmap → no frontend indicators');
      assert.strictEqual(r.block, false, 'missing roadmap → block false');
    });

    test('missing ROADMAP.md returns frontend:false gracefully (no phaseLookupFailed)', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-gate-nomap-'));
      try {
        fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-phase'), { recursive: true });
        const r = computeUiPlanGate(tmpDir, '1');
        assert.strictEqual(r.frontend, false, 'no ROADMAP → no frontend indicators');
        assert.strictEqual(r.block, false, 'no ROADMAP → no block');
        // phaseLookupFailed must NOT be set when ROADMAP.md is absent (no-roadmap project)
        assert.ok(
          !r.phaseLookupFailed,
          'phaseLookupFailed must NOT be set when ROADMAP.md is absent (no-roadmap project is not a lookup failure)'
        );
      } finally {
        try { cleanup(tmpDir); } catch { /* ignore */ }
      }
    });

    test('ROADMAP.md present but phase not found → phaseLookupFailed:true (not silent false)', () => {
      // This verifies FIX 2: when ROADMAP.md exists but the phase header is absent,
      // we surface phaseLookupFailed rather than silently degrading to frontend:false,
      // so an onError:halt gate cannot be silently bypassed by a typo in the phase number.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-gate-noPhase-'));
      try {
        const planningDir = path.join(tmpDir, '.planning');
        const phasesDir = path.join(planningDir, 'phases');
        fs.mkdirSync(path.join(phasesDir, '01-test-phase'), { recursive: true });
        // ROADMAP.md exists but has no Phase 99 header
        fs.writeFileSync(path.join(planningDir, 'ROADMAP.md'), [
          '# Project Roadmap',
          '',
          '## Phase 1: Test Phase',
          '',
          'Build the frontend dashboard with React components.',
          '',
        ].join('\n'), 'utf8');
        // Phase 99 is not in the roadmap
        const r = computeUiPlanGate(tmpDir, '99');
        assert.strictEqual(r.phaseLookupFailed, true,
          'phaseLookupFailed must be true when ROADMAP.md exists but phase is not found');
        // frontend should be false because section is empty
        assert.strictEqual(r.frontend, false, 'empty section → no frontend indicators');
      } finally {
        try { cleanup(tmpDir); } catch { /* ignore */ }
      }
    });
  });

  describe('full-roadmap fallback (FIX 2 — mirrors roadmap.get-phase two-pass lookup)', () => {
    test('phase in non-current milestone section is found via full-roadmap fallback', () => {
      // Simulates a project where STATE.md declares milestone v1.0, but Phase 1 is
      // in the v0.9 section (an older milestone, NOT in a <details> block).
      // extractCurrentMilestone(content, cwd) returns only the v1.0 section → misses Phase 1.
      // stripShippedMilestones(content) returns the FULL roadmap (strips only <details>) → finds Phase 1.
      // computeUiPlanGate must find it via the stripShippedMilestones fallback, matching
      // what `gsd_run query roadmap.get-phase` does.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-gate-milestone-'));
      try {
        const planningDir = path.join(tmpDir, '.planning');
        const phasesDir = path.join(planningDir, 'phases');
        fs.mkdirSync(path.join(phasesDir, '01-test-phase'), { recursive: true });

        // STATE.md declares current milestone = v1.0
        fs.writeFileSync(path.join(planningDir, 'STATE.md'), [
          '---',
          'milestone: v1.0',
          '---',
          '',
          'State content.',
        ].join('\n'), 'utf8');

        // ROADMAP.md: Phase 1 is in v0.9 (NOT <details>), Phase 2 is in v1.0.
        // With STATE.md pointing to v1.0, extractCurrentMilestone returns the v1.0 section only.
        const roadmap = [
          '# Project Roadmap',
          '',
          '## v0.9 — Previous Milestone',
          '',
          '### Phase 1: Frontend Dashboard',
          '',
          'Build the user interface and dashboard components for the frontend.',
          '',
          '## v1.0 — Current Milestone',
          '',
          '### Phase 2: API Layer',
          '',
          'Add REST API endpoints.',
          '',
        ].join('\n');
        fs.writeFileSync(path.join(planningDir, 'ROADMAP.md'), roadmap, 'utf8');

        // Phase 1 is a frontend phase in a non-current milestone — must still be detected
        const r = computeUiPlanGate(tmpDir, '1');
        assert.strictEqual(r.frontend, true,
          'frontend:true must be detected for phase in non-current milestone (full-roadmap fallback)');
        assert.ok(
          !r.phaseLookupFailed,
          'phaseLookupFailed must be false when phase is found via full-roadmap fallback'
        );
      } finally {
        try { cleanup(tmpDir); } catch { /* ignore */ }
      }
    });
  });

  // ── #3312: token match alone must NOT block — static structural corroboration ──

  describe('#3312 structural corroboration — hyphenated proper nouns in non-frontend repos', () => {
    test('dashboard-financeiro mention, repo with NO frontend evidence → frontend:true but block:false', () => {
      // The reporter's exact shape: a markdown+bash+config repo (no src/, no
      // package.json, no component files) whose phase names the repo
      // `dashboard-financeiro`. The sniffer legitimately matches `dashboard`
      // (hyphen is a word boundary — same rule that catches `micro-frontend`),
      // but the gate must not BLOCK without structural frontend evidence.
      const proj = makeProject({
        phaseSection: 'Fix broken references in dashboard-financeiro, update .env.tpl and CI workflows.',
        hasUiSpec: false,
        frontendEvidence: false,
      });
      try {
        const r = computeUiPlanGate(proj.tmpDir, '1');
        assert.strictEqual(r.frontend, true,
          'the token match itself still registers (sniffer semantics unchanged)');
        assert.strictEqual(r.hasFrontendEvidence, false,
          'a repo with no component files and no UI-framework dep has no frontend evidence');
        assert.strictEqual(r.block, false,
          '#3312: token match without structural evidence must NOT block planning');
        assert.strictEqual(r.uiSpecPath, null);
      } finally {
        try { cleanup(proj.tmpDir); } catch { /* ignore */ }
      }
    });

    test('same proper-noun mention WITH component file in tree → block:true (corroboration restores block)', () => {
      const proj = makeProject({
        phaseSection: 'Fix broken references in dashboard-financeiro and adjust the nav layout.',
        hasUiSpec: false,
        frontendEvidence: 'component-file',
      });
      try {
        const r = computeUiPlanGate(proj.tmpDir, '1');
        assert.strictEqual(r.frontend, true);
        assert.strictEqual(r.hasFrontendEvidence, true, 'src/App.tsx is frontend evidence');
        assert.strictEqual(r.block, true, 'token match + evidence + no spec → block');
      } finally {
        try { cleanup(proj.tmpDir); } catch { /* ignore */ }
      }
    });

    test('package.json with a UI-framework dependency counts as frontend evidence', () => {
      const proj = makeProject({
        phaseSection: 'Rebuild the dashboard for the finance team.',
        hasUiSpec: false,
        frontendEvidence: 'package-json',
      });
      try {
        const r = computeUiPlanGate(proj.tmpDir, '1');
        assert.strictEqual(r.hasFrontendEvidence, true,
          'package.json with a react dependency is frontend evidence even with no component files yet');
        assert.strictEqual(r.block, true);
      } finally {
        try { cleanup(proj.tmpDir); } catch { /* ignore */ }
      }
    });

    test('plain prose UI phase in a repo with NO frontend evidence → block:false (general rule, not a token denylist)', () => {
      const proj = makeProject({
        phaseSection: 'Build the user interface and dashboard components for the frontend.',
        hasUiSpec: false,
        frontendEvidence: false,
      });
      try {
        const r = computeUiPlanGate(proj.tmpDir, '1');
        assert.strictEqual(r.frontend, true);
        assert.strictEqual(r.hasFrontendEvidence, false);
        assert.strictEqual(r.block, false,
          'corroboration is required for EVERY token match, not just proper-noun shapes');
      } finally {
        try { cleanup(proj.tmpDir); } catch { /* ignore */ }
      }
    });

    test('matchedToken/matchedLine surface what tripped the sniffer (issue: judge in one second)', () => {
      const proj = makeProject({
        phaseSection: 'Deliverables: .env.tpl, CI workflows.\n\nReferences: dashboard-financeiro repo.',
        hasUiSpec: false,
        frontendEvidence: false,
      });
      try {
        const r = computeUiPlanGate(proj.tmpDir, '1');
        assert.strictEqual(r.matchedToken, 'dashboard', 'first matched token is surfaced');
        assert.ok(
          typeof r.matchedLine === 'string' && r.matchedLine.includes('dashboard-financeiro'),
          'first matching line is surfaced so the operator can see the proper-noun context',
        );
      } finally {
        try { cleanup(proj.tmpDir); } catch { /* ignore */ }
      }
    });

    test('matchedToken/matchedLine are null for non-frontend phases', () => {
      const proj = makeProject({
        phaseSection: 'Add a REST API endpoint and database migration for the user table.',
        hasUiSpec: false,
        frontendEvidence: 'component-file',
      });
      try {
        const r = computeUiPlanGate(proj.tmpDir, '1');
        assert.strictEqual(r.frontend, false);
        assert.strictEqual(r.matchedToken, null);
        assert.strictEqual(r.matchedLine, null);
      } finally {
        try { cleanup(proj.tmpDir); } catch { /* ignore */ }
      }
    });

    test('UI-SPEC present + token match + evidence → block:false (spec still satisfies the gate)', () => {
      const proj = makeProject({
        phaseSection: 'Build the frontend dashboard with React components.',
        hasUiSpec: true,
        frontendEvidence: 'component-file',
      });
      try {
        const r = computeUiPlanGate(proj.tmpDir, '1');
        assert.strictEqual(r.frontend, true);
        assert.strictEqual(r.hasUiSpec, true);
        assert.strictEqual(r.block, false);
      } finally {
        try { cleanup(proj.tmpDir); } catch { /* ignore */ }
      }
    });
  });
});

// ─── #4658 — native (non-JS) frontend evidence ────────────────────────────────
// hasStaticFrontendEvidence recognised only JS-ecosystem evidence (a root
// package.json UI-framework dep, or a .tsx/.jsx/.vue/.svelte file), so
// computeUiPlanGate could never block for a SwiftUI / Compose / Flutter / XAML
// project — the #3312 gate was structurally unreachable for an entire class of
// project. The native branch keeps the same unambiguous-component bar as the
// .tsx subset: source files count only with their import marker (the reporter's
// 37-file Swift CLI with zero UI imports stays silent), while .xaml is
// extension-alone for the same reason .tsx is.

describe('hasStaticFrontendEvidence — native evidence branch (#4658)', () => {
  // relPath -> content; a `null` value creates a DIRECTORY at that path.
  function nativeProject(files) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-evidence-4658-'));
    for (const rel of Object.keys(files)) {
      const target = path.join(tmpDir, rel);
      if (files[rel] === null) {
        fs.mkdirSync(target, { recursive: true });
      } else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, files[rel], 'utf8');
      }
    }
    return tmpDir;
  }

  test('a SwiftUI import counts as static frontend evidence (#4658)', (t) => {
    const dir = nativeProject({ 'Sources/ContentView.swift': 'import SwiftUI\nstruct ContentView: View {}\n' });
    t.after(() => cleanup(dir));
    assert.strictEqual(hasStaticFrontendEvidence(dir), true, 'import SwiftUI is unambiguous native UI evidence');
  });

  test('a UIKit import counts as static frontend evidence (#4658)', (t) => {
    const dir = nativeProject({ 'AppDelegate.swift': 'import UIKit\n' });
    t.after(() => cleanup(dir));
    assert.strictEqual(hasStaticFrontendEvidence(dir), true);
  });

  test('a Compose import counts as static frontend evidence (#4658)', (t) => {
    const dir = nativeProject({ 'lib/Main.kt': 'import androidx.compose.material3.Text\n' });
    t.after(() => cleanup(dir));
    assert.strictEqual(hasStaticFrontendEvidence(dir), true);
  });

  test('a Flutter import counts as static frontend evidence (#4658)', (t) => {
    const dir = nativeProject({ 'lib/main.dart': "import 'package:flutter/material.dart';\nvoid main() {}\n" });
    t.after(() => cleanup(dir));
    assert.strictEqual(hasStaticFrontendEvidence(dir), true);
  });

  test('a XAML page counts as static frontend evidence (#4658)', (t) => {
    const dir = nativeProject({ 'MainPage.xaml': '<Page x:Class="App.MainPage" />\n' });
    t.after(() => cleanup(dir));
    assert.strictEqual(hasStaticFrontendEvidence(dir), true, '.xaml is extension-alone, like .tsx');
  });

  test('a non-UI Swift package stays non-evidence (import marker required)', (t) => {
    // The reporter's control case: 37 Swift files, zero UI imports — a CLI, a
    // server. Extension-alone matching would misclassify exactly this class.
    const dir = nativeProject({ 'Sources/TaskRunner.swift': 'import Foundation\nstruct TaskRunner { }\n' });
    t.after(() => cleanup(dir));
    assert.strictEqual(hasStaticFrontendEvidence(dir), false);
  });

  test('plain Kotlin and Dart sources stay non-evidence', (t) => {
    const dir = nativeProject({
      'lib/Repo.kt': 'class Repo { fun get(): Int = 1 }\n',
      'bin/main.dart': 'void main() { print(1); }\n',
    });
    t.after(() => cleanup(dir));
    assert.strictEqual(hasStaticFrontendEvidence(dir), false);
  });

  test('marker matching is exact — prose mentions and case changes are not imports', (t) => {
    const mentioned = nativeProject({ 'Sources/Notes.swift': '// SwiftUI is nice, but this is a comment\nimport Foundation\n' });
    t.after(() => cleanup(mentioned));
    assert.strictEqual(hasStaticFrontendEvidence(mentioned), false, 'a prose/comment mention is not an import');

    const lowercased = nativeProject({ 'Sources/A.swift': 'import swiftui\n' });
    t.after(() => cleanup(lowercased));
    assert.strictEqual(hasStaticFrontendEvidence(lowercased), false, 'imports are case-sensitive in all four ecosystems');

    const kotlinComment = nativeProject({ 'lib/Main.kt': '// TODO: migrate to androidx.compose\nfun main() {}\n' });
    t.after(() => cleanup(kotlinComment));
    assert.strictEqual(hasStaticFrontendEvidence(kotlinComment), false, 'a bare framework-name mention is not a Kotlin import');

    const dartComment = nativeProject({ 'lib/main.dart': '// see package:flutter docs\nvoid main() {}\n' });
    t.after(() => cleanup(dartComment));
    assert.strictEqual(hasStaticFrontendEvidence(dartComment), false, 'a bare package-path mention is not a Dart import');
  });

  test('native files are found below the project root', (t) => {
    const dir = nativeProject({ 'lib/ui/deep/Chart.kt': 'import androidx.compose.foundation.Canvas\n' });
    t.after(() => cleanup(dir));
    assert.strictEqual(hasStaticFrontendEvidence(dir), true);
  });

  test('SKIP_DIRS still excludes vendored native matches', (t) => {
    const dir = nativeProject({ 'node_modules/somepkg/Chart.kt': 'import androidx.compose.foundation.Canvas\n' });
    t.after(() => cleanup(dir));
    assert.strictEqual(hasStaticFrontendEvidence(dir), false, 'vendored trees are not project evidence');
  });

  test('extension matching is case-insensitive (.XAML)', (t) => {
    const dir = nativeProject({ 'MainPage.XAML': '<Page />\n' });
    t.after(() => cleanup(dir));
    assert.strictEqual(hasStaticFrontendEvidence(dir), true, 'matching UI_COMPONENT_FILE_RE\'s existing /i semantics');
  });

  test('unreadable directories degrade to false, never throw', (t) => {
    const dir = nativeProject({ 'Sources/ContentView.swift': 'import SwiftUI\n' });
    const origReaddir = fs.readdirSync;
    t.after(() => { cleanup(dir); });
    t.mock.method(fs, 'readdirSync', (p, opts) => {
      if (String(p).endsWith('Sources')) throw new Error('EIO: simulated read failure');
      return origReaddir.call(fs, p, opts);
    });
    assert.strictEqual(hasStaticFrontendEvidence(dir), false, 'I/O failure = no evidence, per the module contract');
  });

  test('property: native evidence is exactly the marker-matched source content', () => {
    // Deterministic: pinned seed, bounded runs, counterexample printed on
    // failure (fc's default). Filler is filtered so it cannot carry a marker.
    const markers = [
      ['.swift', 'import SwiftUI'],
      ['.swift', 'import UIKit'],
      ['.kt', 'import androidx.compose'],
      ['.dart', "import 'package:flutter"],
    ];
    const filler = fc.string({ minLength: 0, maxLength: 80 })
      .filter((s) => !s.includes('import') && !s.includes('androidx') && !s.includes('package:') && !s.includes('\n'));
    // try/finally lives in this HELPER (no test context), per the exemption.
    function withFixture(content, fn) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-evidence-prop-4658-'));
      try {
        fs.writeFileSync(path.join(dir, `probe${content.ext}`), content.text, 'utf8');
        return fn(dir);
      } finally {
        cleanup(dir);
      }
    }
    fc.assert(
      fc.property(
        fc.constantFrom(...markers),
        filler,
        ([ext, marker], noise) => withFixture({ ext, text: `${noise}\n${marker}\n${noise}\n` }, (dir) => {
          assert.strictEqual(hasStaticFrontendEvidence(dir), true, `marker ${JSON.stringify(marker)} must be evidence`);
        }),
      ),
      { seed: 4658, numRuns: 100 },
    );
    fc.assert(
      fc.property(filler, (noise) => withFixture({ ext: '.swift', text: `${noise}\n${noise}\n` }, (dir) => {
        assert.strictEqual(hasStaticFrontendEvidence(dir), false, 'filler-only content is not evidence');
      })),
      { seed: 4659, numRuns: 100 },
    );
  });
});

describe('computeUiPlanGate — native evidence fires the gate (#4658)', () => {
  test('native frontend evidence fires the gate on a UI phase without a UI-SPEC (#4658)', (t) => {
    const proj = makeProject({
      phaseSection: 'Build the SwiftUI dashboard list and detail views.',
      hasUiSpec: false,
      frontendEvidence: 'swiftui',
    });
    t.after(() => cleanup(proj.tmpDir));
    const r = computeUiPlanGate(proj.tmpDir, '1');
    assert.strictEqual(r.frontend, true, 'the vocabulary match already succeeded (#3718 untouched)');
    assert.strictEqual(r.hasFrontendEvidence, true, 'a SwiftUI project IS structural frontend evidence');
    assert.strictEqual(r.block, true, 'the issue title criterion: the gate must actually FIRE for native projects');
  });

  test('native evidence respects the UI-SPEC branch (block:false when the spec exists)', (t) => {
    const proj = makeProject({
      phaseSection: 'Build the SwiftUI dashboard list and detail views.',
      hasUiSpec: true,
      frontendEvidence: 'swiftui',
    });
    t.after(() => cleanup(proj.tmpDir));
    const r = computeUiPlanGate(proj.tmpDir, '1');
    assert.strictEqual(r.hasFrontendEvidence, true);
    assert.strictEqual(r.hasUiSpec, true);
    assert.strictEqual(r.block, false, 'branch (b) is unchanged for native evidence');
  });

  test('non-UI native source stays block:false (corroboration still required)', (t) => {
    const proj = makeProject({
      phaseSection: 'Build the dashboard views for the settings screen.',
      hasUiSpec: false,
      frontendEvidence: 'swift-non-ui',
    });
    t.after(() => cleanup(proj.tmpDir));
    const r = computeUiPlanGate(proj.tmpDir, '1');
    assert.strictEqual(r.frontend, true, 'vocabulary match is unchanged');
    assert.strictEqual(r.hasFrontendEvidence, false, 'import Foundation is not UI evidence');
    assert.strictEqual(r.block, false, 'the control case: extension-alone would have blocked this');
  });
});

// Review-pass additions (#4658): gate-level coverage for a second native
// ecosystem, and the unreadable-FILE degrade path of the bounded marker read.
describe('computeUiPlanGate — native evidence, additional ecosystems (#4658)', () => {
  test('compose evidence fires the gate through the same block formula', (t) => {
    const proj = makeProject({
      phaseSection: 'Migrate the dashboard list to Jetpack Compose components.',
      hasUiSpec: false,
      frontendEvidence: 'compose',
    });
    t.after(() => cleanup(proj.tmpDir));
    const r = computeUiPlanGate(proj.tmpDir, '1');
    assert.strictEqual(r.frontend, true);
    assert.strictEqual(r.hasFrontendEvidence, true, 'a Compose project IS structural frontend evidence');
    assert.strictEqual(r.block, true);
  });

  test('an unreadable candidate file degrades to no evidence, never throws', (t) => {
    const { hasStaticFrontendEvidence: probe } = require('../gsd-core/bin/lib/ui-frontend-evidence.cjs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-evidence-io-4658-'));
    const origRead = fs.readSync;
    t.after(() => { cleanup(dir); });
    fs.writeFileSync(path.join(dir, 'Main.kt'), 'import androidx.compose.material3.Text\n', 'utf8');
    t.mock.method(fs, 'readSync', () => {
      throw new Error('EIO: simulated read failure');
    });
    assert.strictEqual(probe(dir), false, 'read failure = no evidence, per the module contract');
    assert.ok(origRead, 'original readSync preserved by t.mock auto-restore');
  });
});
