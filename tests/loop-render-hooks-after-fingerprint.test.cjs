/**
 * tests/loop-render-hooks-after-fingerprint.test.cjs — #5105 test matrix rows T5-T9.
 *
 * FAILING-FIRST: `loop render-hooks <point> --after-fingerprint <phaseDir>` does
 * not exist yet — design 40-design.md §R "R2" (src/loop-resolver.cts,
 * cmdLoopRenderHooks). These tests encode the required `skippedHooks`
 * projection; expected to fail until R2 lands.
 *
 * Design: .gsd/phase/fix-5105-verify-lifecycle-writes/40-design.md §R "R2".
 * Matrix: .gsd/phase/fix-5105-verify-lifecycle-writes/50-test-matrix.md T5-T9.
 *
 * Model: tests/loop-render-hooks.test.cjs's end-to-end `cmdLoopRenderHooks`
 * section (real registry, `gsd_run`/runNode against a temp project with
 * nyquist/security/ui/mempalace capabilities enabled).
 */

'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const ROOT = path.resolve(__dirname, '..');
const GSD_TOOLS = path.join(ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');

// A project with nyquist/security/ui/mempalace all enabled, so all four
// verify:post steps are registered active (mirrors "UI pilot integration" /
// the design's registered-hooks census: validate-phase, secure-phase,
// ui-review, mempalace-capture).
function makeProjectDir() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-after-fp-'));
  const planningDir = path.join(projectDir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(
    path.join(planningDir, 'config.json'),
    JSON.stringify({
      workflow: {
        ui_phase: true, ui_review: true, ui_safety_gate: true,
        nyquist: true, security: true, mempalace: true,
      },
      nyquist: { enabled: true },
      security: { enabled: true },
      mempalace: { enabled: true },
    }),
  );
  return projectDir;
}

function renderHooks(projectDir, phaseDir, extraArgs = []) {
  return runNode(
    [GSD_TOOLS, 'loop', 'render-hooks', 'verify:post', '--cwd', projectDir, '--raw', ...extraArgs],
    { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS },
  );
}

describe('T5-T9: loop render-hooks verify:post --after-fingerprint (#5105 R2)', () => {
  let projectDir;

  before(() => { projectDir = makeProjectDir(); });
  after(() => { if (projectDir) cleanup(projectDir); });

  test('T5: phase dir holding only SECURITY.md → security step skipped, nyquist/ui active, mempalace active', () => {
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    cleanup(phaseDir);
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-SECURITY.md'), '# Security\n');

    const result = renderHooks(projectDir, phaseDir, ['--after-fingerprint', phaseDir]);
    assert.strictEqual(result.exitCode, 0, `expected exit 0: ${result.stderr}`);
    const envelope = JSON.parse(result.stdout.trim());
    assert.ok(Array.isArray(envelope.skippedHooks), 'skippedHooks must be present with the flag');
    const securitySkip = envelope.skippedHooks.find((s) => s.capId === 'security');
    assert.ok(securitySkip, `expected security step in skippedHooks; got: ${JSON.stringify(envelope.skippedHooks)}`);
    assert.strictEqual(securitySkip.reason, 'produces-present');
    assert.deepStrictEqual(securitySkip.artifacts, ['SECURITY.md']);
    // #5105 S1: verify-work.md's secure-phase enablement check reads
    // skippedHooks (not just activeHooks) — each entry must carry enough to
    // resolve `kind == "step"` and `ref.skill == "secure-phase"` from it.
    assert.strictEqual(securitySkip.kind, 'step');
    assert.strictEqual(securitySkip.ref && securitySkip.ref.skill, 'secure-phase');

    const nyquistActive = envelope.activeHooks.find((h) => h.capId === 'nyquist');
    const uiActive = envelope.activeHooks.find((h) => h.capId === 'ui' && h.kind === 'step');
    const mempalaceActive = envelope.activeHooks.find((h) => h.capId === 'mempalace');
    assert.ok(nyquistActive, 'nyquist must stay active (VALIDATION.md absent)');
    assert.ok(uiActive, 'ui-review must stay active (UI-REVIEW.md absent)');
    assert.ok(mempalaceActive, 'mempalace (produces: []) always passes through');
  });

  test('T6: phase dir with none of the artifacts → every step active, skippedHooks empty', () => {
    const phaseDir = path.join(projectDir, '.planning', 'phases', '02-bar');
    cleanup(phaseDir);
    fs.mkdirSync(phaseDir, { recursive: true });

    const result = renderHooks(projectDir, phaseDir, ['--after-fingerprint', phaseDir]);
    assert.strictEqual(result.exitCode, 0, `expected exit 0: ${result.stderr}`);
    const envelope = JSON.parse(result.stdout.trim());
    assert.deepStrictEqual(envelope.skippedHooks, [], 'a missing artifact is still created — nothing skipped');
    assert.ok(envelope.activeHooks.length > 0, 'sanity: steps are registered');
  });

  test('T7: boundary — SECURITY.md.bak, 01-SECURITY.md.tmp, and a directory named 01-SECURITY.md are NOT "present"', () => {
    const phaseDir = path.join(projectDir, '.planning', 'phases', '03-boundary');
    cleanup(phaseDir);
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, 'SECURITY.md.bak'), 'x');
    fs.writeFileSync(path.join(phaseDir, '01-SECURITY.md.tmp'), 'x');
    fs.mkdirSync(path.join(phaseDir, '01-VALIDATION.md'));

    const result = renderHooks(projectDir, phaseDir, ['--after-fingerprint', phaseDir]);
    assert.strictEqual(result.exitCode, 0, `expected exit 0: ${result.stderr}`);
    const envelope = JSON.parse(result.stdout.trim());
    assert.deepStrictEqual(
      envelope.skippedHooks, [],
      'a .bak/.tmp suffix or a directory of the same name must not count as present',
    );
  });

  test('T8: nonexistent phase dir → exits non-zero, never passes everything through', () => {
    const phaseDir = path.join(projectDir, '.planning', 'phases', 'does-not-exist');
    const result = renderHooks(projectDir, phaseDir, ['--after-fingerprint', phaseDir]);
    assert.notStrictEqual(result.exitCode, 0, 'a nonexistent phase dir must fail closed');
  });

  test('T9: same command without the flag → output identical to today (no skippedHooks key)', () => {
    const phaseDir = path.join(projectDir, '.planning', 'phases', '04-nolflag');
    cleanup(phaseDir);
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-SECURITY.md'), '# Security\n');

    const withFlag = renderHooks(projectDir, phaseDir, ['--after-fingerprint', phaseDir]);
    const withoutFlag = renderHooks(projectDir, phaseDir);
    assert.strictEqual(withoutFlag.exitCode, 0, `expected exit 0: ${withoutFlag.stderr}`);
    const envelopeWithout = JSON.parse(withoutFlag.stdout.trim());
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(envelopeWithout, 'skippedHooks'), false,
      'no --after-fingerprint flag → no skippedHooks key at all (regression lock)',
    );
    // Sanity: the flag actually changes SOMETHING (proves this isn't just an
    // always-absent key regardless of flag presence).
    const envelopeWith = JSON.parse(withFlag.stdout.trim());
    assert.ok(
      Object.prototype.hasOwnProperty.call(envelopeWith, 'skippedHooks'),
      'sanity: --after-fingerprint must add the skippedHooks key',
    );
  });
});

describe('#5105 S10: producesEntryPresent shares resolvePhaseArtifactFile; --after-fingerprint is a confined path', () => {
  let projectDir;

  before(() => { projectDir = makeProjectDir(); });
  after(() => { if (projectDir) cleanup(projectDir); });

  test('a stray 02-SECURITY.md inside a phase dir named 01-foo does NOT count as present', () => {
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo-wrongprefix');
    cleanup(phaseDir);
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '02-SECURITY.md'), '# Security\n');

    const result = renderHooks(projectDir, phaseDir, ['--after-fingerprint', phaseDir]);
    assert.strictEqual(result.exitCode, 0, `expected exit 0: ${result.stderr}`);
    const envelope = JSON.parse(result.stdout.trim());
    assert.deepStrictEqual(
      envelope.skippedHooks, [],
      'a cross-phase-numbered stray artifact must not count as this phase\'s own',
    );
  });

  test('--after-fingerprint <relative-path> resolves against --cwd, not process cwd', () => {
    const phaseDir = path.join(projectDir, '.planning', 'phases', '05-relative');
    cleanup(phaseDir);
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '05-SECURITY.md'), '# Security\n');

    const relPhaseDir = path.relative(projectDir, phaseDir);
    const result = renderHooks(projectDir, phaseDir, ['--after-fingerprint', relPhaseDir]);
    assert.strictEqual(result.exitCode, 0, `expected exit 0: ${result.stderr}`);
    const envelope = JSON.parse(result.stdout.trim());
    const securitySkip = envelope.skippedHooks.find((s) => s.capId === 'security');
    assert.ok(securitySkip, `relative --after-fingerprint must resolve against --cwd; got: ${JSON.stringify(envelope.skippedHooks)}`);
  });

  test('--after-fingerprint <path outside the project root> is refused (fail closed)', (t) => {
    const phaseDir = path.join(projectDir, '.planning', 'phases', '06-outside');
    cleanup(phaseDir);
    fs.mkdirSync(phaseDir, { recursive: true });

    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-after-fp-outside-'));
    t.after(() => cleanup(outsideDir));

    const result = renderHooks(projectDir, phaseDir, ['--after-fingerprint', outsideDir]);
    assert.notStrictEqual(result.exitCode, 0, 'a phase dir outside the project root must be refused, not silently accepted');
    assert.match(
      result.stderr,
      /--after-fingerprint directory is unsafe/,
      `expected the fail-closed refusal message; got: ${result.stderr}`,
    );
  });
});
