'use strict';

/**
 * E2E capability-wiring tests for the API-coverage gate (#1562).
 *
 * Drives the real CLI subprocess (`loop render-hooks verify:pre` and
 * `check api-coverage.verify-pre`) against temp projects to prove:
 *   - the gate is data-driven (activates/deactivates by config) — acceptance #5
 *   - the seal contract (block / pass) — acceptance #1, #2, #4
 *   - the matrix persists on disk and is read at seal time — acceptance #6
 *
 * CONTENT/E2E only: every test drives a real CLI subprocess. No readFileSync
 * source-grep. Genuine assertions: each case asserts the SPECIFIC differing
 * value (block true/false, capId presence), not a count.
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { cleanup } = require('./helpers.cjs');

const TOOLS_PATH = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

const TEST_ENV_BASE = {
  GSD_SESSION_KEY: '',
  CODEX_THREAD_ID: '',
  CLAUDE_SESSION_ID: '',
  CLAUDE_CODE_SSE_PORT: '',
  OPENCODE_SESSION_ID: '',
  GEMINI_SESSION_ID: '',
  CURSOR_SESSION_ID: '',
  WINDSURF_SESSION_ID: '',
  TERM_SESSION: '',
  WT_SESSION: '',
  TMUX_PANE: '',
  ZELLIJ_SESSION_NAME: '',
  TTY: '',
  SSH_TTY: '',
};

function runTools(args, cwd) {
  const argv = Array.isArray(args)
    ? args
    : (args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [])
        .map((t) => t.replace(/"([^"]*)"/g, '$1').replace(/'([^']*)'/g, '$1'));
  try {
    const stdout = execFileSync(process.execPath, [TOOLS_PATH, ...argv], {
      cwd,
      encoding: 'utf-8',
      env: { ...process.env, ...TEST_ENV_BASE },
      timeout: 60000,
    });
    return { success: true, output: stdout.trim(), exitCode: 0, error: '' };
  } catch (err) {
    return {
      success: false,
      output: err.stdout?.toString().trim() || '',
      error: err.stderr?.toString().trim() || err.message,
      exitCode: err.status ?? 1,
    };
  }
}

function makeProject(workflow) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-apicov-'));
  fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'config.json'),
    JSON.stringify({ workflow }),
    'utf8'
  );
  return tmpDir;
}

function makePhaseDir(projectDir, phaseSlug) {
  const dir = path.join(projectDir, '.planning', 'phases', phaseSlug);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writePlan(phaseDir, planFile, body) {
  fs.writeFileSync(path.join(phaseDir, planFile), body, 'utf8');
}

function writeCoverage(phaseDir, body) {
  fs.writeFileSync(path.join(phaseDir, 'COVERAGE.md'), body, 'utf8');
}

function verifyPreHooks(cwd) {
  const result = runTools('loop render-hooks verify:pre --raw', cwd);
  assert.ok(result.success, `render-hooks verify:pre should succeed. stderr: ${result.error}`);
  const envelope = JSON.parse(result.output);
  assert.strictEqual(envelope.point, 'verify:pre', 'point field must be verify:pre');
  assert.ok(Array.isArray(envelope.activeHooks), 'activeHooks must be an array');
  return envelope;
}

function findCap(envelope, capId) {
  return envelope.activeHooks.find((h) => h.capId === capId) || null;
}

function runGate(cwd, phaseDir) {
  return runTools(['check', 'api-coverage.verify-pre', phaseDir, '--raw'], cwd);
}

// ─── Capability wiring: data-driven activation (acceptance #5) ───────────────

describe('api-coverage verify:pre gate — capability wiring (#1562 acceptance #5)', () => {
  let tmpDir;
  afterEach(() => { if (tmpDir) { cleanup(tmpDir); tmpDir = null; } });

  test('gate is ACTIVE when workflow.api_coverage_gate is true', () => {
    tmpDir = makeProject({ api_coverage_gate: true });
    const env = verifyPreHooks(tmpDir);
    const hook = findCap(env, 'ai-integration');
    assert.ok(hook, 'ai-integration gate must register at verify:pre when enabled');
    assert.strictEqual(hook.kind, 'gate');
    assert.strictEqual(hook.blocking, true);
    assert.strictEqual(hook.check.query, 'api-coverage.verify-pre');
  });

  test('gate is ABSENT when workflow.api_coverage_gate is false', () => {
    tmpDir = makeProject({ api_coverage_gate: false });
    const env = verifyPreHooks(tmpDir);
    assert.strictEqual(findCap(env, 'ai-integration'), null, 'gate must not register when disabled');
  });

  test('gate is ACTIVE by default when the key is absent (opt-out, not opt-in)', () => {
    tmpDir = makeProject({});
    const env = verifyPreHooks(tmpDir);
    assert.ok(findCap(env, 'ai-integration'), 'gate must default ON (full-coverage-by-default)');
  });
});

// ─── Seal contract: block / pass (acceptance #1, #2, #4, #6) ──────────────────

describe('api-coverage.verify-pre — seal contract (#1562 acceptance #1,#2,#4,#6)', () => {
  let tmpDir;
  let phaseDir;
  afterEach(() => { if (tmpDir) { cleanup(tmpDir); tmpDir = null; } });

  function fresh() {
    tmpDir = makeProject({ api_coverage_gate: true });
    phaseDir = makePhaseDir(tmpDir, '01-pay');
    return phaseDir;
  }

  test('#1 API phase without a matrix → BLOCKS the seal', () => {
    fresh();
    writePlan(phaseDir, '01-PLAN.md', '# Plan\nIntegrate the Stripe API for payment processing.');
    const r = runGate(tmpDir, phaseDir);
    assert.ok(r.success, `gate should succeed (JSON). stderr: ${r.error}`);
    const j = JSON.parse(r.output);
    assert.strictEqual(j.block, true, 'must block when API integration has no matrix');
    assert.strictEqual(j.detected, true);
    assert.strictEqual(j.coverage_present, false);
  });

  test('#4 non-API phase without a matrix → does NOT block', () => {
    fresh();
    writePlan(phaseDir, '01-PLAN.md', '# Plan\nRefactor the auth helper to use bcrypt.');
    const r = runGate(tmpDir, phaseDir);
    assert.ok(r.success, `gate should succeed. stderr: ${r.error}`);
    const j = JSON.parse(r.output);
    assert.strictEqual(j.block, false, 'must not block a non-API phase');
    assert.strictEqual(j.detected, false);
  });

  test('unreadable plan file → BLOCKS fail-closed instead of silently passing (#2365 review)', (t) => {
    if (process.getuid && process.getuid() === 0) {
      t.skip('chmod 000 does not deny the root user');
      return;
    }
    fresh();
    // A readable non-API plan plus an UNREADABLE plan that DOES integrate: the
    // gate must not conclude "no integration" from the readable half alone.
    writePlan(phaseDir, '01-PLAN.md', '# Plan\nRefactor the UI.');
    const unreadable = path.join(phaseDir, '02-PLAN.md');
    fs.writeFileSync(unreadable, '# Plan\nIntegrate the Stripe API.', 'utf8');
    fs.chmodSync(unreadable, 0o000);
    try {
      const r = runGate(tmpDir, phaseDir);
      const j = JSON.parse(r.output);
      assert.strictEqual(j.block, true, 'unreadable scope must fail-closed (block), not pass');
      assert.match(j.message, /could not read/i);
    } finally {
      fs.chmodSync(unreadable, 0o644); // restore so cleanup can remove it
    }
  });

  test('unreadable phase directory → BLOCKS fail-closed (#2365 round-4 review)', (t) => {
    if (process.getuid && process.getuid() === 0) {
      t.skip('chmod 000 does not deny the root user');
      return;
    }
    fresh();
    writePlan(phaseDir, '01-PLAN.md', '# Plan\nIntegrate the Stripe API.');
    fs.chmodSync(phaseDir, 0o000); // directory exists but cannot be enumerated
    try {
      const r = runGate(tmpDir, phaseDir);
      const j = JSON.parse(r.output);
      // Fail-closed: caught either by phase resolution or by readPhaseScope —
      // the invariant is that an unreadable directory never silently passes.
      assert.strictEqual(j.block, true, 'an unreadable phase directory must fail-closed, not pass');
      assert.match(j.message, /could not (read|resolve)/i);
    } finally {
      fs.chmodSync(phaseDir, 0o755); // restore so cleanup can recurse
    }
  });

  test('#1/#6 API phase WITH a valid matrix → passes (matrix persists on disk)', () => {
    fresh();
    writePlan(phaseDir, '01-PLAN.md', '# Plan\nIntegrate the Stripe API for payment processing.');
    writeCoverage(
      phaseDir,
      '| capability | decision | reason |\n|---|---|---|\n' +
        '| charge | INTEGRATE | |\n| refund | OPT-OUT | not needed yet |\n'
    );
    const r = runGate(tmpDir, phaseDir);
    assert.ok(r.success, `gate should succeed. stderr: ${r.error}`);
    const j = JSON.parse(r.output);
    assert.strictEqual(j.block, false);
    assert.strictEqual(j.coverage_present, true);
    assert.strictEqual(j.counts.surface, 2);
    assert.strictEqual(j.counts.optout, 1);
  });

  test('#2 OPT-OUT without a reason → BLOCKS (un-decided hole)', () => {
    fresh();
    writePlan(phaseDir, '01-PLAN.md', '# Plan\nIntegrate the Stripe API.');
    writeCoverage(
      phaseDir,
      '| capability | decision | reason |\n|---|---|---|\n| refund | OPT-OUT | |\n'
    );
    const r = runGate(tmpDir, phaseDir);
    const j = JSON.parse(r.output);
    assert.strictEqual(j.block, true, 'opt-out without reason must block');
    assert.ok(j.errors.some((e) => /missing reason/i.test(e)));
  });

  test('#2 empty matrix → BLOCKS (surface must be enumerated)', () => {
    fresh();
    writePlan(phaseDir, '01-PLAN.md', '# Plan\nIntegrate the Stripe API.');
    writeCoverage(phaseDir, '| capability | decision | reason |\n|---|---|---|\n');
    const r = runGate(tmpDir, phaseDir);
    const j = JSON.parse(r.output);
    assert.strictEqual(j.block, true);
    assert.ok(j.errors.some((e) => /empty/i.test(e)));
  });

  test('#3 a second platform with full-coverage baseline is accepted (no asymmetry)', () => {
    fresh();
    writePlan(phaseDir, '01-PLAN.md', '# Plan\nAdd a YouTube SDK as a second media platform.');
    // Full-coverage baseline for the second platform: every capability decided.
    writeCoverage(
      phaseDir,
      '| capability | decision | reason |\n|---|---|---|\n' +
        '| search | INTEGRATE | |\n| playlists | INTEGRATE | |\n| skip | INTEGRATE | |\n'
    );
    const r = runGate(tmpDir, phaseDir);
    const j = JSON.parse(r.output);
    assert.strictEqual(j.block, false, 'a fully-decided second platform seals clean');
    assert.strictEqual(j.counts.surface, 3);
  });

  test('JSON-fenced matrix is accepted (machine-generated form)', () => {
    fresh();
    writePlan(phaseDir, '01-PLAN.md', '# Plan\nIntegrate the Stripe API.');
    writeCoverage(
      phaseDir,
      '```coverage\n[{"capability":"charge","decision":"INTEGRATE","reason":""}]\n```\n'
    );
    const r = runGate(tmpDir, phaseDir);
    const j = JSON.parse(r.output);
    assert.strictEqual(j.block, false);
    assert.strictEqual(j.counts.surface, 1);
  });

  // ── #2365: detector false positives must not block, and a phase may declare
  // "no external API integration" instead of fabricating a matrix row.
  test('#2365 phase naming a first-party route path → does NOT block', () => {
    fresh();
    writePlan(
      phaseDir,
      '01-PLAN.md',
      '# Plan\nRun integration tests for src/app/api/profile/route.test.ts.'
    );
    const r = runGate(tmpDir, phaseDir);
    assert.ok(r.success, `gate should succeed. stderr: ${r.error}`);
    const j = JSON.parse(r.output);
    assert.strictEqual(j.block, false, 'a first-party route path is not an external API');
    assert.strictEqual(j.detected, false);
  });

  test('#2365 COVERAGE.md declaring no external API integration → passes the gate', () => {
    fresh();
    writePlan(phaseDir, '01-PLAN.md', '# Plan\nRender the export page.');
    writeCoverage(phaseDir, 'No external API integration: UI-only phase, no third-party surface.\n');
    const r = runGate(tmpDir, phaseDir);
    assert.ok(r.success, `gate should succeed. stderr: ${r.error}`);
    const j = JSON.parse(r.output);
    assert.strictEqual(j.block, false, 'a reasoned no-integration declaration satisfies the gate');
    assert.strictEqual(j.coverage_present, true);
    assert.strictEqual(j.none_declared, true);
    assert.strictEqual(j.detected, false, 'a non-API plan shows no overridden signals');
  });

  test('#2365 declaration overriding live detection passes but SURFACES the contradiction', () => {
    fresh();
    writePlan(phaseDir, '01-PLAN.md', '# Plan\nIntegrate the Stripe API for payments.');
    writeCoverage(phaseDir, 'No external API integration: detector over-fired; this phase is UI-only.\n');
    const r = runGate(tmpDir, phaseDir);
    assert.ok(r.success, `gate should succeed. stderr: ${r.error}`);
    const j = JSON.parse(r.output);
    assert.strictEqual(j.block, false, 'the declaration is the human overrule — it must win');
    assert.strictEqual(j.none_declared, true);
    assert.strictEqual(j.detected, true, 'the contradiction must be visible, not silent');
    assert.ok(Array.isArray(j.signals) && j.signals.length > 0);
    assert.ok(/overrid/i.test(j.message), `message should surface the override: ${j.message}`);
  });

  // ── Security (#1562 security review S1/S2): the phase arg is taken only as a
  // token resolved under .planning/phases/. Traversal / unresolvable args must
  // NOT read files outside the phase dir, and — since the phases tree exists —
  // must fail CLOSED (a blocking gate must not silently bypass on a bad arg).
  test('path-traversal arg is contained and fails CLOSED (phases tree exists)', () => {
    fresh(); // creates .planning/phases/01-pay
    const r = runTools(['check', 'api-coverage.verify-pre', '../../etc', '--raw'], tmpDir);
    assert.ok(r.success, `gate should succeed (JSON). stderr: ${r.error}`);
    const j = JSON.parse(r.output);
    assert.strictEqual(j.block, true, 'unresolvable phase under an existing phases tree must block');
    assert.strictEqual(j.phase_lookup_failed, true);
  });

  test('no .planning/phases at all → fail-open (genuine non-GSD project)', () => {
    // A project with .planning/config.json but no phases directory.
    const noPhases = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-apicov-nophase-'));
    try {
      fs.mkdirSync(path.join(noPhases, '.planning'), { recursive: true });
      fs.writeFileSync(
        path.join(noPhases, '.planning', 'config.json'),
        JSON.stringify({ workflow: { api_coverage_gate: true } }),
        'utf8'
      );
      const r = runTools(['check', 'api-coverage.verify-pre', '01-pay', '--raw'], noPhases);
      assert.ok(r.success);
      const j = JSON.parse(r.output);
      assert.strictEqual(j.block, false, 'no phases tree → pass (not a GSD project)');
    } finally {
      cleanup(noPhases);
    }
  });
});
