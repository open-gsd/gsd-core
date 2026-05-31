'use strict';

/**
 * Bug #447: plan-phase §13e gap-analysis ignores phase_req_ids → false-positive
 * coverage gaps.
 *
 * Root cause: runGapAnalysis() diffs the ENTIRE REQUIREMENTS.md against the
 * phase's plans, with no awareness of phase_req_ids. §13 (Requirements Coverage
 * Gate) skips when phase_req_ids is null/TBD, but §13e never inherited that
 * scoping contract — so a phase that maps no requirements reports every
 * unrelated project REQ-ID as "Not covered".
 *
 * Fix: teach the gap-analysis CLI a --phase-req-ids option (the durable home for
 * the scoping contract), mirroring §13:
 *   - null / TBD / empty  → skip the REQUIREMENTS.md comparison entirely
 *                           (CONTEXT.md decisions are still reported).
 *   - explicit ID list    → restrict the comparison to those IDs.
 *   - flag absent         → backward-compatible (compare the whole file).
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

describe('gap-analysis --phase-req-ids scoping (#447)', () => {
  let tmpDir;
  let phaseDir;

  function writeRequirements(ids) {
    const lines = ids.map((id, i) => `- [ ] **${id}** Requirement ${i + 1} description`);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements\n\n${lines.join('\n')}\n`);
  }

  function writeContext(decisions) {
    const dLines = decisions.map(d => `- **${d.id}:** ${d.text}`).join('\n');
    fs.writeFileSync(path.join(phaseDir, 'CONTEXT.md'),
      `# Phase Context\n\n<decisions>\n## Implementation Decisions\n\n${dLines}\n</decisions>\n`);
  }

  function writePlan(name, body) {
    fs.writeFileSync(path.join(phaseDir, `${name}-PLAN.md`), body);
  }

  function reqRows(out) {
    return out.rows.filter(r => r.source === 'REQUIREMENTS.md').map(r => r.item);
  }

  beforeEach(() => {
    tmpDir = createTempProject();
    phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(phaseDir, { recursive: true });
    const r = runGsdTools('config-ensure-section', tmpDir);
    assert.ok(r.success, `config-ensure-section failed: ${r.error}`);
  });

  afterEach(() => cleanup(tmpDir));

  // ── The core bug ─────────────────────────────────────────────────────────────

  test('phase mapping no REQs (--phase-req-ids TBD) reports zero REQUIREMENTS.md rows', () => {
    // A REQUIREMENTS.md full of IDs that belong to OTHER phases/milestones.
    writeRequirements(['BACK-01', 'WEB-03', 'API-07', 'DATA-02']);
    writePlan('01', '# Plan 1\n\nStandalone phase, maps no project requirements.\n');

    const r = runGsdTools(
      ['gap-analysis', '--phase-dir', phaseDir, '--phase-req-ids', 'TBD'], tmpDir);
    assert.ok(r.success, `gap-analysis failed: ${r.error}`);
    const out = JSON.parse(r.output);

    assert.deepStrictEqual(reqRows(out), [],
      'a phase that maps no REQ-IDs must not report unrelated project requirements as gaps');
    assert.strictEqual(out.counts.uncovered, 0,
      'no false-positive "not covered" rows for an unmapped phase');
  });

  test('--phase-req-ids null behaves the same as TBD (skip requirements)', () => {
    writeRequirements(['BACK-01', 'WEB-03']);
    writePlan('01', '# Plan\n\nNo mapped reqs.\n');

    const r = runGsdTools(
      ['gap-analysis', '--phase-dir', phaseDir, '--phase-req-ids', 'null'], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.deepStrictEqual(reqRows(out), []);
  });

  // ── Scoped to a mapped subset ────────────────────────────────────────────────

  test('explicit ID list restricts the comparison to those REQ-IDs', () => {
    writeRequirements(['REQ-01', 'REQ-02', 'REQ-03']);
    // Plan covers REQ-01 only; REQ-02 is mapped to the phase but not yet addressed.
    writePlan('01', '# Plan\n\nImplements REQ-01 only.\n');

    const r = runGsdTools(
      ['gap-analysis', '--phase-dir', phaseDir, '--phase-req-ids', 'REQ-01,REQ-02'], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);

    assert.deepStrictEqual(reqRows(out).sort(), ['REQ-01', 'REQ-02'],
      'only the phase-mapped REQ-IDs are considered; REQ-03 (another phase) is excluded');
    const req01 = out.rows.find(x => x.item === 'REQ-01');
    const req02 = out.rows.find(x => x.item === 'REQ-02');
    assert.strictEqual(req01.status, 'Covered');
    assert.strictEqual(req02.status, 'Not covered');
  });

  test('JSON-array-ish value (["REQ-01"]) is tolerated and scoped', () => {
    writeRequirements(['REQ-01', 'REQ-02']);
    writePlan('01', '# Plan\n\nImplements REQ-01.\n');

    const r = runGsdTools(
      ['gap-analysis', '--phase-dir', phaseDir, '--phase-req-ids', '["REQ-01"]'], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.deepStrictEqual(reqRows(out), ['REQ-01']);
  });

  // ── CONTEXT.md decisions are unaffected by req scoping ───────────────────────

  test('CONTEXT.md decisions are still reported when requirements are skipped', () => {
    writeRequirements(['BACK-01', 'WEB-03']);
    writeContext([{ id: 'D-01', text: 'Use a local notification daemon' }]);
    writePlan('01', '# Plan\n\nUnrelated work, no decisions addressed.\n');

    const r = runGsdTools(
      ['gap-analysis', '--phase-dir', phaseDir, '--phase-req-ids', 'TBD'], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);

    assert.deepStrictEqual(reqRows(out), [], 'requirements skipped');
    const d01 = out.rows.find(x => x.item === 'D-01');
    assert.ok(d01, 'CONTEXT.md decision D-01 must still be reported');
    assert.strictEqual(d01.source, 'CONTEXT.md');
    assert.strictEqual(d01.status, 'Not covered');
  });

  // ── Parser robustness (workflow passes the roadmap value verbatim) ───────────

  test('whitespace/newline-separated IDs are tolerated and scoped', () => {
    writeRequirements(['REQ-01', 'REQ-02', 'REQ-03']);
    writePlan('01', '# Plan\n\nImplements the first one.\n');
    const r = runGsdTools(
      ['gap-analysis', '--phase-dir', phaseDir, '--phase-req-ids', 'REQ-01 REQ-02\nREQ-03'], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.deepStrictEqual(reqRows(out).sort(), ['REQ-01', 'REQ-02', 'REQ-03']);
  });

  // ── Backward compatibility ───────────────────────────────────────────────────

  test('flag absent → whole REQUIREMENTS.md is compared (unchanged behavior)', () => {
    writeRequirements(['REQ-01', 'REQ-02']);
    writePlan('01', '# Plan\n\nImplements REQ-01 only.\n');

    const r = runGsdTools(['gap-analysis', '--phase-dir', phaseDir], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.deepStrictEqual(reqRows(out).sort(), ['REQ-01', 'REQ-02'],
      'with no --phase-req-ids, all requirements are still reported (back-compat)');
  });

  // ── §13e wiring: init.plan-phase --pick phase_req_ids → gap-analysis ─────────
  // Guards the exact query the workflow uses. `roadmap.get-phase` returns raw
  // phase TEXT (not JSON), so --pick yields nothing there; the scoping value
  // must come from `init.plan-phase`. This test would have caught using the
  // wrong query (which silently skips requirements for every phase).

  function writeRoadmap(reqLine) {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n## Phase 1: Test Phase\n**Goal:** Do the thing\n${reqLine}**Success Criteria:**\n- It works\n`);
  }

  test('init.plan-phase --pick phase_req_ids exposes the mapped IDs, and gap-analysis scopes to them', () => {
    writeRoadmap('**Requirements:** REQ-01, REQ-02\n');
    writeRequirements(['REQ-01', 'REQ-02', 'REQ-03']);
    writePlan('01', '# Plan\n\nImplements the first requirement only.\n');

    const q = runGsdTools(['query', 'init.plan-phase', '1', '--pick', 'phase_req_ids'], tmpDir);
    assert.ok(q.success, `init.plan-phase query failed: ${q.error}`);
    const ids = q.output.trim();
    assert.match(ids, /REQ-01/, 'init.plan-phase must expose phase_req_ids (roadmap.get-phase does NOT)');

    const r = runGsdTools(['gap-analysis', '--phase-dir', phaseDir, '--phase-req-ids', ids], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.deepStrictEqual(reqRows(out).sort(), ['REQ-01', 'REQ-02'],
      'gap report is scoped to the phase-mapped IDs; REQ-03 (another phase) is excluded');
  });

  test('phase with no Requirements line → init.plan-phase yields empty → gap-analysis skips requirements', () => {
    writeRoadmap(''); // no **Requirements:** line
    writeRequirements(['REQ-01', 'REQ-02']);
    writePlan('01', '# Plan\n\nStandalone phase.\n');

    const q = runGsdTools(['query', 'init.plan-phase', '1', '--pick', 'phase_req_ids'], tmpDir);
    assert.ok(q.success, q.error);
    const ids = q.output.trim(); // expected empty

    // The workflow passes the (possibly empty) value through verbatim.
    const r = runGsdTools(['gap-analysis', '--phase-dir', phaseDir, '--phase-req-ids', ids], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.deepStrictEqual(reqRows(out), [],
      'an unmapped phase reports no requirement gaps (the original #447 bug)');
  });
});
