'use strict';

/**
 * loop-hooks-ship-pre-e2e.test.cjs — E2E content tests for the ship:pre hook point.
 *
 * ADR-857 phase 6 gap coverage. Tests cover:
 *   - loop render-hooks ship:pre CLI subprocess (envelope shape, predicate typing)
 *   - frontmatter get CLI subprocess (threats_open field contract)
 *   - resolveLoopHooks pure-function with realRegistry (predicate.equals integer contract)
 *
 * NOTE: ship:pre has NO runnable predicate evaluator — enforcement is ship.md prose only.
 * The check.predicate shape is asserted here to pin the Hyrum's-law contract for downstream
 * consumers (workflow prose, manual ship gate). This is a known robustness gap (kerckhoffs).
 *
 * Follows RULESET.TESTS (no source-grep, BVA at thresholds, genuine assertions).
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { cleanup } = require('./helpers.cjs');

const GSD_TOOLS = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

const {
  resolveLoopHooks,
} = require('../gsd-core/bin/lib/loop-resolver.cjs');

const realRegistry = require('../gsd-core/bin/lib/capability-registry.cjs');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Run gsd-tools synchronously via spawnSync. Returns { status, stdout, stderr }.
 * Does NOT throw on non-zero exit — callers must assert status themselves.
 */
function runTools(args, opts = {}) {
  const result = spawnSync(process.execPath, [GSD_TOOLS, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    cwd: opts.cwd || process.cwd(),
    env: {
      ...process.env,
      // Clear ambient session vars that can redirect config paths
      GSD_SESSION_KEY: '',
      CODEX_THREAD_ID: '',
      CLAUDE_SESSION_ID: '',
      ...opts.env,
    },
  });
  return result;
}

/**
 * Create a minimal temp project directory with a .planning/ dir.
 * Optionally write config.json if configObj is provided.
 */
function makeTmpProject(prefix, configObj) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const planningDir = path.join(tmpDir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  if (configObj !== undefined) {
    fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify(configObj), 'utf8');
  }
  return tmpDir;
}

/**
 * Write a SECURITY.md file with the given frontmatter content to the given dir.
 */
function writeSecurityMd(dir, frontmatter) {
  const content = `---\n${frontmatter}\n---\n# Security Review\n`;
  const filePath = path.join(dir, 'SECURITY.md');
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

// ─── Fixture state ─────────────────────────────────────────────────────────────

let tmpEnforcementOn;    // .planning/config.json with security_enforcement:true
let tmpEnforcementOff;   // .planning/config.json with security_enforcement:false
let tmpNoConfig;         // .planning/ dir with NO config.json (schema default applies)
let tmpWithSecurityMd;   // project + SECURITY.md variants in sub-temp dir

before(() => {
  tmpEnforcementOn = makeTmpProject('ship-pre-on-', { workflow: { security_enforcement: true } });
  tmpEnforcementOff = makeTmpProject('ship-pre-off-', { workflow: { security_enforcement: false } });
  tmpNoConfig = makeTmpProject('ship-pre-noconf-');  // no config.json
  tmpWithSecurityMd = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-pre-secmd-'));
});

after(() => {
  if (tmpEnforcementOn) cleanup(tmpEnforcementOn);
  if (tmpEnforcementOff) cleanup(tmpEnforcementOff);
  if (tmpNoConfig) cleanup(tmpNoConfig);
  if (tmpWithSecurityMd) cleanup(tmpWithSecurityMd);
});

// ─── 1. render-hooks ship:pre envelope tests ──────────────────────────────────

describe('loop render-hooks ship:pre — envelope resolution', () => {

  test('[happy] security_enforcement=true returns gate hook with correct predicate shape', () => {
    const result = runTools(['loop', 'render-hooks', 'ship:pre', '--raw'], { cwd: tmpEnforcementOn });

    assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}; stderr: ${result.stderr}`);

    const envelope = JSON.parse(result.stdout.trim());

    assert.strictEqual(envelope.point, 'ship:pre');
    assert.strictEqual(envelope.activeHooks.length, 1, 'expected exactly 1 active hook');

    const gate = envelope.activeHooks[0];
    assert.strictEqual(gate.capId, 'security');
    assert.strictEqual(gate.kind, 'gate');
    assert.strictEqual(gate.blocking, true);
    assert.strictEqual(gate.onError, 'halt');
    assert.strictEqual(gate.when, 'workflow.security_enforcement');

    // Predicate shape — the critical contract for downstream workflow prose
    const pred = gate.check.predicate;
    assert.strictEqual(pred.kind, 'artifact-frontmatter-equals');
    assert.strictEqual(pred.artifact, 'SECURITY.md');
    assert.strictEqual(pred.field, 'threats_open');
    assert.strictEqual(pred.equals, 0);
    // TYPE contract: equals must be integer (not string '0')
    assert.strictEqual(typeof pred.equals, 'number', 'predicate.equals must be a number, not a string');
  });

  test('[negative] security_enforcement=false returns empty activeHooks (gate suppressed)', () => {
    const result = runTools(['loop', 'render-hooks', 'ship:pre', '--raw'], { cwd: tmpEnforcementOff });

    assert.strictEqual(result.status, 0);

    const envelope = JSON.parse(result.stdout.trim());

    assert.strictEqual(envelope.point, 'ship:pre');
    assert.deepEqual(envelope.activeHooks, [], 'expected empty activeHooks when enforcement disabled');
    assert.strictEqual(envelope.rendered, '_No active hooks at ship:pre._');

    // Confirm no security hook leaked through
    const secHook = envelope.activeHooks.find(h => h.capId === 'security');
    assert.strictEqual(secHook, undefined, 'security gate must be absent when enforcement=false');
  });

  test('[happy] no config.json uses schema default (security_enforcement=true) and activates gate', () => {
    const result = runTools(['loop', 'render-hooks', 'ship:pre', '--raw'], { cwd: tmpNoConfig });

    assert.strictEqual(result.status, 0);

    const envelope = JSON.parse(result.stdout.trim());

    // Schema default for security_enforcement is true — gate must fire
    assert.strictEqual(envelope.activeHooks.length, 1, 'schema default must activate the security gate');
    assert.strictEqual(envelope.activeHooks[0].capId, 'security');
    assert.strictEqual(envelope.activeHooks[0].blocking, true);
  });

  test('[empty-resolution] gate active when no SECURITY.md exists: envelope confirms gate live (fail-closed)', () => {
    // The phase dir has NO SECURITY.md — the gate is still ACTIVE in the envelope
    // (activation is config-driven; file absence is a predicate evaluation concern
    // handled by ship.md prose, not the CLI resolver).
    const tmpPhaseNoSec = makeTmpProject('ship-pre-nosec-', { workflow: { security_enforcement: true } });
    try {
      const phaseDir = path.join(tmpPhaseNoSec, '.planning', 'phases', '01-feature');
      fs.mkdirSync(phaseDir, { recursive: true });
      // No SECURITY.md written anywhere

      const result = runTools(['loop', 'render-hooks', 'ship:pre', '--raw'], { cwd: tmpPhaseNoSec });
      assert.strictEqual(result.status, 0);

      const envelope = JSON.parse(result.stdout.trim());

      // Gate must still be active — no-file does not suppress the gate
      assert.strictEqual(envelope.activeHooks.length, 1, 'gate must remain active even without SECURITY.md on disk');
      assert.strictEqual(envelope.activeHooks[0].capId, 'security');
      assert.strictEqual(envelope.activeHooks[0].blocking, true);
      // Confirm no SECURITY.md in the phase dir (this is the "no-file" scenario)
      const hasSec = fs.readdirSync(phaseDir).some(f => f.endsWith('-SECURITY.md') || f === 'SECURITY.md');
      assert.strictEqual(hasSec, false, 'fixture must have no SECURITY.md for this test to be meaningful');
    } finally {
      cleanup(tmpPhaseNoSec);
    }
  });

});

// ─── 2. predicate.equals integer contract via resolveLoopHooks (pure function) ─

describe('resolveLoopHooks ship:pre — predicate.equals integer type contract', () => {

  test('[bva] predicate.equals is integer 0 in resolved output (Hyrum\'s-law type pin)', () => {
    const resolved = resolveLoopHooks({
      point: 'ship:pre',
      registry: realRegistry,
      config: { workflow: { security_enforcement: true } },
    });

    assert.strictEqual(resolved.activeHooks.length, 1);
    const gate = resolved.activeHooks[0];
    assert.strictEqual(gate.capId, 'security');

    const equals = gate.check.predicate.equals;
    assert.strictEqual(equals, 0, 'predicate.equals must be integer 0');
    assert.strictEqual(typeof equals, 'number', 'predicate.equals typeof must be number, not string');
  });

  test('[negative] security_enforcement=false via resolveLoopHooks returns 0 active hooks', () => {
    const resolved = resolveLoopHooks({
      point: 'ship:pre',
      registry: realRegistry,
      config: { workflow: { security_enforcement: false } },
    });

    assert.strictEqual(resolved.activeHooks.length, 0, 'enforcement=false must yield 0 hooks');
    assert.strictEqual(resolved.point, 'ship:pre');
  });

});

// ─── 3. frontmatter get contract for threats_open field ───────────────────────

describe('frontmatter get SECURITY.md threats_open — type contract', () => {

  test('[happy] threats_open:0 returns string "0" (type contract: YAML→string via frontmatter CLI)', () => {
    const secFile = writeSecurityMd(tmpWithSecurityMd, 'threats_open: 0\nasvs_level: 1');

    const result = runTools(['frontmatter', 'get', secFile, '--field', 'threats_open', '--raw']);

    assert.strictEqual(result.status, 0);
    // Raw output is JSON-encoded string "0", not integer 0
    const parsed = JSON.parse(result.stdout.trim());
    assert.strictEqual(parsed, '0', 'frontmatter returns string "0", not integer 0');
    assert.strictEqual(typeof parsed, 'string', 'frontmatter CLI must return a string for YAML integer fields');
  });

  test('[bva] threats_open:1 returns string "1" — above threshold, predicate(equals:0) fails', () => {
    // BVA: equals:0 passes, equals:1 blocks — this is the just-above threshold value
    const secFile = path.join(tmpWithSecurityMd, 'SECURITY-1.md');
    fs.writeFileSync(secFile, '---\nthreats_open: 1\nasvs_level: 1\n---\n# Security\n', 'utf8');

    const result = runTools(['frontmatter', 'get', secFile, '--field', 'threats_open', '--raw']);

    assert.strictEqual(result.status, 0);
    const parsed = JSON.parse(result.stdout.trim());
    assert.strictEqual(parsed, '1', 'threats_open:1 must return string "1"');
    // Verify this differs from the passing case (string "0" !== string "1")
    assert.notStrictEqual(parsed, '0', 'string "1" must not equal passing value "0"');
  });

  test('[negative] missing threats_open field returns Field-not-found error (fail-closed path)', () => {
    const secFile = path.join(tmpWithSecurityMd, 'SECURITY-missing-field.md');
    // No threats_open key in frontmatter — only unrelated fields
    fs.writeFileSync(secFile, '---\nphase: 01\nstatus: active\n---\n# Security\n', 'utf8');

    const result = runTools(['frontmatter', 'get', secFile, '--field', 'threats_open', '--raw']);

    // Exit 0 — the CLI returns a JSON error object, not a crash
    assert.strictEqual(result.status, 0);
    const parsed = JSON.parse(result.stdout.trim());

    // Must return an error object, not a string value
    assert.strictEqual(typeof parsed, 'object', 'missing field must return an object, not a string');
    assert.strictEqual(parsed.error, 'Field not found');
    assert.strictEqual(parsed.field, 'threats_open');
  });

  test('[negative] threats_open: unknown returns string "unknown" (ambiguous value must fail closed)', () => {
    // Non-numeric string value — predicate (equals:0 integer) cannot match
    const secFile = path.join(tmpWithSecurityMd, 'SECURITY-unknown.md');
    fs.writeFileSync(secFile, '---\nthreats_open: unknown\nasvs_level: 1\n---\n# Security\n', 'utf8');

    const result = runTools(['frontmatter', 'get', secFile, '--field', 'threats_open', '--raw']);

    assert.strictEqual(result.status, 0);
    const parsed = JSON.parse(result.stdout.trim());

    assert.strictEqual(parsed, 'unknown', 'non-numeric value must be returned as-is');
    // Confirm this is NOT a match for predicate.equals===0 (integer)
    assert.notStrictEqual(parsed, 0, 'string "unknown" must not match integer 0');
    assert.strictEqual(typeof parsed, 'string');
  });

});

// ─── 4. Real registry structure sanity ────────────────────────────────────────

describe('real registry ship:pre — structural guards', () => {

  test('ship:pre byLoopPoint entry has exactly 1 gate and 0 steps/contributions', () => {
    const entry = realRegistry.byLoopPoint['ship:pre'];
    assert.ok(entry, 'ship:pre must exist in byLoopPoint');
    assert.strictEqual(entry.steps.length, 0, 'ship:pre must have 0 steps');
    assert.strictEqual(entry.contributions.length, 0, 'ship:pre must have 0 contributions');
    assert.strictEqual(entry.gates.length, 1, 'ship:pre must have exactly 1 gate (security)');
  });

  test('ship:pre gate capId is "security" and check has predicate not query', () => {
    const gate = realRegistry.byLoopPoint['ship:pre'].gates[0];
    assert.strictEqual(gate.capId, 'security');
    assert.ok(gate.check.predicate, 'ship:pre gate must use predicate, not query');
    assert.strictEqual(gate.check.query, undefined, 'ship:pre must NOT have a check.query (predicate-only gate)');
  });

});
