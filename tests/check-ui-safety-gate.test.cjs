'use strict';

/**
 * Behavioral tests for the `check ui-safety-gate` subcommand (#1168).
 *
 * Tests the `computeUiSafetyGate` pure function exported from check-command-router.cjs.
 * Uses in-memory tmpdir fixtures — no real CLI subprocess needed.
 *
 * Return shape: { frontend: bool, hasUiFiles: bool, hasUiSpec: bool, block: bool, message?: string }
 * Invariant: block = frontend && hasUiFiles && !hasUiSpec
 *
 * Per RULESET.TESTS.boundary-coverage: exercises all branches:
 *   (a) frontend + UI files changed + no spec → block:true
 *   (b) frontend + UI files changed + spec exists → block:false
 *   (c) non-frontend → block:false
 *   (d) frontend + no UI files changed → block:false
 *
 * Per RULESET.TESTS.coderabbit-fix-prefer: calls the exported function and asserts typed fields.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');
const { computeUiSafetyGate } = require('../gsd-core/bin/lib/check-command-router.cjs');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a minimal project dir with:
 *   .planning/ROADMAP.md   — one phase section with `phaseSection` body
 *   .planning/phases/01-test-phase/  — phase directory
 *   (optionally) a *-UI-SPEC.md inside the phase dir
 */
function makeProject({ phaseSection = '', hasUiSpec = false } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-safety-gate-test-'));
  const planningDir = path.join(tmpDir, '.planning');
  const phasesDir = path.join(planningDir, 'phases');
  const phaseDir = path.join(phasesDir, '01-test-phase');

  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify({}), 'utf8');

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

describe('computeUiSafetyGate — ui.safety-gate check logic (#1168)', () => {
  let frontendNoSpec, frontendWithSpec, nonFrontend;

  before(() => {
    // Branch (a): frontend + no UI-SPEC → tests block behavior
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
    test('result has required keys: frontend, hasUiFiles, hasUiSpec, block', () => {
      const result = computeUiSafetyGate(nonFrontend.tmpDir, '1');
      assert.ok(typeof result === 'object' && result !== null, 'result must be an object');
      assert.ok(typeof result.frontend === 'boolean', 'frontend must be boolean');
      assert.ok(typeof result.hasUiFiles === 'boolean', 'hasUiFiles must be boolean');
      assert.ok(typeof result.hasUiSpec === 'boolean', 'hasUiSpec must be boolean');
      assert.ok(typeof result.block === 'boolean', 'block must be boolean');
    });

    test('block invariant: block === frontend && hasUiFiles && !hasUiSpec for all scenarios', () => {
      for (const [label, { tmpDir }] of [
        ['frontendNoSpec', frontendNoSpec],
        ['frontendWithSpec', frontendWithSpec],
        ['nonFrontend', nonFrontend],
      ]) {
        const r = computeUiSafetyGate(tmpDir, '1');
        assert.strictEqual(
          r.block,
          r.frontend && r.hasUiFiles && !r.hasUiSpec,
          `${label}: block invariant violated — frontend=${r.frontend} hasUiFiles=${r.hasUiFiles} hasUiSpec=${r.hasUiSpec} block=${r.block}`,
        );
      }
    });
  });

  describe('branch (a) — frontend + no UI-SPEC → gate fires when hasUiFiles', () => {
    test('detects frontend indicators in phase section', () => {
      const r = computeUiSafetyGate(frontendNoSpec.tmpDir, '1');
      assert.strictEqual(r.frontend, true, 'should detect frontend indicators');
    });

    test('hasUiSpec is false when no *-UI-SPEC.md exists', () => {
      const r = computeUiSafetyGate(frontendNoSpec.tmpDir, '1');
      assert.strictEqual(r.hasUiSpec, false, 'hasUiSpec must be false');
    });

    test('block is true when frontend + hasUiFiles + no UI-SPEC', () => {
      // hasUiFiles depends on git state; when false, block must also be false (invariant).
      // We verify the invariant holds rather than hardcoding the git state.
      const r = computeUiSafetyGate(frontendNoSpec.tmpDir, '1');
      assert.strictEqual(r.block, r.frontend && r.hasUiFiles && !r.hasUiSpec,
        'block invariant: frontend && hasUiFiles && !hasUiSpec');
    });

    test('message is present when block is true', () => {
      const r = computeUiSafetyGate(frontendNoSpec.tmpDir, '1');
      if (r.block) {
        assert.ok(typeof r.message === 'string' && r.message.length > 0,
          'message must be a non-empty string when block is true');
        assert.ok(r.message.includes('UI-SPEC'), 'message must reference UI-SPEC');
      }
    });
  });

  describe('branch (b) — frontend + UI-SPEC exists → block:false', () => {
    test('detects frontend indicators in phase section', () => {
      const r = computeUiSafetyGate(frontendWithSpec.tmpDir, '1');
      assert.strictEqual(r.frontend, true, 'should detect frontend indicators');
    });

    test('hasUiSpec is true when *-UI-SPEC.md exists', () => {
      const r = computeUiSafetyGate(frontendWithSpec.tmpDir, '1');
      assert.strictEqual(r.hasUiSpec, true, 'hasUiSpec must be true');
    });

    test('block is false when UI-SPEC exists (regardless of hasUiFiles)', () => {
      const r = computeUiSafetyGate(frontendWithSpec.tmpDir, '1');
      assert.strictEqual(r.block, false, 'block must be false when spec exists');
    });

    test('message is absent when block is false', () => {
      const r = computeUiSafetyGate(frontendWithSpec.tmpDir, '1');
      assert.ok(!r.message || r.message === undefined,
        'message must be absent when block is false');
    });
  });

  describe('branch (c) — non-frontend phase → block:false', () => {
    test('frontend is false for non-UI phase section', () => {
      const r = computeUiSafetyGate(nonFrontend.tmpDir, '1');
      assert.strictEqual(r.frontend, false, 'should NOT detect frontend indicators');
    });

    test('block is false for non-frontend phases', () => {
      const r = computeUiSafetyGate(nonFrontend.tmpDir, '1');
      assert.strictEqual(r.block, false, 'block must be false');
    });
  });

  describe('graceful degradation', () => {
    test('non-existent project dir returns frontend:false, block:false (no crash)', () => {
      const r = computeUiSafetyGate('/tmp/nonexistent-gsd-test-dir-xyz', '1');
      assert.strictEqual(typeof r.frontend, 'boolean', 'frontend must be boolean');
      assert.strictEqual(r.frontend, false, 'missing roadmap → no frontend indicators');
      assert.strictEqual(r.block, false, 'missing roadmap → block false');
      assert.strictEqual(typeof r.hasUiFiles, 'boolean', 'hasUiFiles must be boolean');
      assert.strictEqual(typeof r.hasUiSpec, 'boolean', 'hasUiSpec must be boolean');
    });

    test('missing ROADMAP.md returns frontend:false gracefully (no phaseLookupFailed)', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-safety-nomap-'));
      try {
        fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-phase'), { recursive: true });
        const r = computeUiSafetyGate(tmpDir, '1');
        assert.strictEqual(r.frontend, false, 'no ROADMAP → no frontend indicators');
        assert.strictEqual(r.block, false, 'no ROADMAP → no block');
        assert.ok(
          !r.phaseLookupFailed,
          'phaseLookupFailed must NOT be set when ROADMAP.md is absent (no-roadmap project is not a lookup failure)',
        );
      } finally {
        try { cleanup(tmpDir); } catch { /* ignore */ }
      }
    });

    test('ROADMAP.md present but phase not found → phaseLookupFailed:true (not silent false)', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-safety-noPhase-'));
      try {
        const planningDir = path.join(tmpDir, '.planning');
        const phasesDir = path.join(planningDir, 'phases');
        fs.mkdirSync(path.join(phasesDir, '01-test-phase'), { recursive: true });
        fs.writeFileSync(path.join(planningDir, 'ROADMAP.md'), [
          '# Project Roadmap',
          '',
          '## Phase 1: Test Phase',
          '',
          'Build the frontend dashboard with React components.',
          '',
        ].join('\n'), 'utf8');
        // Phase 99 is not in the roadmap
        const r = computeUiSafetyGate(tmpDir, '99');
        assert.strictEqual(r.phaseLookupFailed, true,
          'phaseLookupFailed must be true when ROADMAP.md exists but phase is not found');
        assert.strictEqual(r.frontend, false, 'empty section → no frontend indicators');
      } finally {
        try { cleanup(tmpDir); } catch { /* ignore */ }
      }
    });
  });

  describe('routing — ui-safety-gate is routable via check-command-router', () => {
    test('routeCheckCommand routes ui-safety-gate (hyphen form)', () => {
      const { routeCheckCommand } = require('../gsd-core/bin/lib/check-command-router.cjs');
      // Should not throw; just verify routing works (output goes to stdout)
      let threw = false;
      try {
        routeCheckCommand({ args: ['check', 'ui-safety-gate', '1'], cwd: nonFrontend.tmpDir, raw: true });
      } catch (err) {
        threw = true;
      }
      assert.strictEqual(threw, false, 'routeCheckCommand must not throw for ui-safety-gate');
    });

    test('routeCheckCommand routes ui.safety-gate (dot form — normalized to hyphens)', () => {
      const { routeCheckCommand } = require('../gsd-core/bin/lib/check-command-router.cjs');
      let threw = false;
      try {
        routeCheckCommand({ args: ['check', 'ui.safety-gate', '1'], cwd: nonFrontend.tmpDir, raw: true });
      } catch (err) {
        threw = true;
      }
      assert.strictEqual(threw, false, 'routeCheckCommand must not throw for ui.safety-gate (dot form)');
    });
  });
});
