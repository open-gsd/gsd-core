/**
 * Behavior-lock tests for perf #317 — context-monitor hook fs I/O collapse
 *
 * The fix collapses each `if (existsSync(p)) { readFileSync(p) }` pattern
 * into a single `readFileSync` guarded by try/catch treating ENOENT as the
 * "file absent" branch. These tests lock the observable behavior so that
 * the optimized code is proved equivalent across all three files:
 *   1. metrics file (early-exit path when absent)
 *   2. config.json (defaults when absent)
 *   3. warn sentinel (first-warn vs debounce)
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');

const MONITOR_PATH = path.join(__dirname, '..', 'hooks', 'gsd-context-monitor.js');
const tmpDir = os.tmpdir();

/**
 * Spawn the context-monitor hook with the given options.
 *
 * @param {object} opts
 * @param {string}  opts.sessionId     - session ID embedded in stdin payload
 * @param {string}  [opts.cwd]         - cwd in payload (defaults to tmpDir)
 * @param {boolean} [opts.writeMetrics] - if true, write a bridge file before spawn
 * @param {number}  [opts.remaining]   - remaining_percentage for bridge file
 * @param {number}  [opts.usedPct]     - used_pct for bridge file
 * @param {boolean} [opts.writeWarn]   - if true, write a warn sentinel before spawn
 * @param {object}  [opts.warnData]    - content for warn sentinel (defaults to first-warn-like data)
 * @returns {{ exitCode: number, stdout: string }}
 */
function runMonitorRaw(opts) {
  const {
    sessionId,
    cwd = tmpDir,
    writeMetrics = false,
    remaining = 20,
    usedPct = 80,
    writeWarn = false,
    warnData = null,
  } = opts;

  const metricsPath = path.join(tmpDir, `claude-ctx-${sessionId}.json`);
  const warnPath = path.join(tmpDir, `claude-ctx-${sessionId}-warned.json`);

  if (writeMetrics) {
    fs.writeFileSync(metricsPath, JSON.stringify({
      session_id: sessionId,
      remaining_percentage: remaining,
      used_pct: usedPct,
      timestamp: Math.floor(Date.now() / 1000),
    }));
  }

  if (writeWarn) {
    const wd = warnData ?? { callsSinceWarn: 0, lastLevel: null };
    fs.writeFileSync(warnPath, JSON.stringify(wd));
  }

  const input = JSON.stringify({ session_id: sessionId, cwd });
  let stdout = '';
  let exitCode = 0;

  try {
    stdout = execFileSync(process.execPath, [MONITOR_PATH], {
      input,
      encoding: 'utf-8',
      timeout: 5000,
    });
  } catch (e) {
    exitCode = e.status ?? 1;
    stdout = e.stdout || '';
  } finally {
    try { fs.unlinkSync(metricsPath); } catch { /* already absent */ }
    try { fs.unlinkSync(warnPath); } catch { /* already absent */ }
  }

  return { exitCode, stdout };
}

// ─── 1. Metrics file absent → early exit 0, no stdout ────────────────────────

describe('perf #317: metrics file absent (exercises ENOENT early-exit path)', () => {
  test('exits 0 with empty stdout when metrics file does not exist', () => {
    // This is the "subagent / fresh session" path. The original code did:
    //   if (!existsSync(metricsPath)) process.exit(0)
    // The fix collapses to try/catch ENOENT → process.exit(0).
    // Both branches must produce: exit code 0, zero bytes on stdout.
    const sessionId = `test-317-no-metrics-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { exitCode, stdout } = runMonitorRaw({ sessionId, writeMetrics: false });

    // Non-vacuous: assert the exact signature of the early-exit branch
    assert.strictEqual(exitCode, 0,
      'hook must exit 0 when metrics file is absent (subagent/fresh-session path)');
    assert.strictEqual(stdout, '',
      'hook must produce NO stdout when metrics file is absent — empty stdout is the ' +
      'unique signature of the early-exit branch; any output would mean the hook ' +
      'continued past the metrics-absent guard, proving the ENOENT branch is not taken');
  });

  test('a distinct session with a present metrics file DOES produce output (proves the absent-file test is not vacuous)', () => {
    // If the absent-file test passed vacuously (e.g. the hook never emits output
    // for ANY session), this companion test would fail — locking non-vacuousness.
    const sessionId = `test-317-has-metrics-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { stdout } = runMonitorRaw({
      sessionId,
      writeMetrics: true,
      remaining: 20,  // below CRITICAL_THRESHOLD=25 → will emit
      usedPct: 80,
    });
    assert.ok(stdout.length > 0,
      'hook must emit JSON output when metrics ARE present and remaining <= CRITICAL_THRESHOLD; ' +
      'this proves the absent-file test above is non-vacuous');
    const parsed = JSON.parse(stdout);
    assert.ok(
      parsed?.hookSpecificOutput?.additionalContext,
      'output must contain hookSpecificOutput.additionalContext'
    );
  });
});

// ─── 2. config.json absent → uses defaults, still emits warning ──────────────

describe('perf #317: config.json absent (exercises config-missing → defaults path)', () => {
  test('emits warning using defaults when .planning/config.json is absent', () => {
    // Original code: existsSync(planningDir) guards the config read.
    // Fix collapses to: try { config = JSON.parse(readFileSync(configPath)) } catch { defaults }
    // When config.json is missing, the hook should proceed with defaults
    // (context_warnings not disabled) and emit the same warning.
    //
    // We point cwd at a temp dir that has NO .planning/config.json.
    const sessionId = `test-317-no-config-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const testCwd = fs.mkdtempSync(path.join(tmpDir, 'gsd-317-no-config-'));

    try {
      // Metrics present, below warning threshold → should warn
      const { exitCode, stdout } = runMonitorRaw({
        sessionId,
        cwd: testCwd,
        writeMetrics: true,
        remaining: 20,
        usedPct: 80,
      });

      assert.strictEqual(exitCode, 0, 'hook should exit 0 (not crash) when config.json absent');
      assert.ok(stdout.length > 0,
        'hook should still emit a warning when config.json is absent (defaults apply)');
      const parsed = JSON.parse(stdout);
      assert.ok(
        parsed?.hookSpecificOutput?.additionalContext,
        'warning output must contain additionalContext'
      );
    } finally {
      cleanup(testCwd);
    }
  });

  test('respects context_warnings=false when config.json IS present', () => {
    // Proves the config read actually works (not just always-defaults).
    const sessionId = `test-317-config-disabled-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const testCwd = fs.mkdtempSync(path.join(tmpDir, 'gsd-317-config-disabled-'));
    const planningDir = path.join(testCwd, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
    fs.writeFileSync(
      path.join(planningDir, 'config.json'),
      JSON.stringify({ hooks: { context_warnings: false } })
    );

    // Write metrics so the hook would warn if config_warnings wasn't false
    const metricsPath = path.join(tmpDir, `claude-ctx-${sessionId}.json`);
    fs.writeFileSync(metricsPath, JSON.stringify({
      session_id: sessionId,
      remaining_percentage: 20,
      used_pct: 80,
      timestamp: Math.floor(Date.now() / 1000),
    }));

    let exitCode = 0;
    let stdout = '';
    try {
      stdout = execFileSync(process.execPath, [MONITOR_PATH], {
        input: JSON.stringify({ session_id: sessionId, cwd: testCwd }),
        encoding: 'utf-8',
        timeout: 5000,
      });
    } catch (e) {
      exitCode = e.status ?? 1;
      stdout = e.stdout || '';
    } finally {
      try { fs.unlinkSync(metricsPath); } catch { /* noop */ }
      cleanup(testCwd);
    }

    assert.strictEqual(exitCode, 0, 'hook should exit 0 when context_warnings=false');
    assert.strictEqual(stdout, '',
      'hook should produce NO output when context_warnings=false in config.json');
  });
});

// ─── 3. Warn sentinel absent vs present (debounce behavior) ──────────────────

describe('perf #317: warn sentinel absent/present (exercises sentinel ENOENT path)', () => {
  test('emits warning on first call when warn sentinel is absent', () => {
    // Original: !existsSync(warnPath) → firstWarn=true → emit immediately.
    // Fix: try { warnData = JSON.parse(readFileSync(warnPath)) } catch { /* keep defaults */ }
    // When sentinel absent, warnData stays at default { callsSinceWarn:0, lastLevel:null }
    // and firstWarn=true → hook emits immediately.
    const sessionId = `test-317-first-warn-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { exitCode, stdout } = runMonitorRaw({
      sessionId,
      writeMetrics: true,
      remaining: 30,
      usedPct: 70,
      writeWarn: false,  // sentinel absent
    });

    assert.strictEqual(exitCode, 0);
    assert.ok(stdout.length > 0,
      'hook should emit warning on first call (sentinel absent = firstWarn path)');
    const parsed = JSON.parse(stdout);
    assert.ok(parsed?.hookSpecificOutput?.additionalContext,
      'first-warn output must contain additionalContext');
  });

  test('debounces when warn sentinel is present and callsSinceWarn is below threshold', () => {
    // Original: existsSync(warnPath) → readFileSync → warnData loaded → debounce check.
    // Fix: try { warnData = JSON.parse(readFileSync(warnPath)) } catch { defaults }
    // When sentinel present with recent warn, hook exits 0 with no output.
    const sessionId = `test-317-debounced-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { exitCode, stdout } = runMonitorRaw({
      sessionId,
      writeMetrics: true,
      remaining: 30,
      usedPct: 70,
      writeWarn: true,
      warnData: {
        // callsSinceWarn=1 (below DEBOUNCE_CALLS=5), same level → debounce fires
        callsSinceWarn: 1,
        lastLevel: 'warning',
      },
    });

    assert.strictEqual(exitCode, 0,
      'hook must exit 0 during debounce window');
    assert.strictEqual(stdout, '',
      'hook must emit NO output during debounce window (sentinel present, callsSinceWarn < 5)');
  });

  test('severity escalation (WARNING → CRITICAL) bypasses debounce even with sentinel present', () => {
    // Even if callsSinceWarn is low, escalating from warning to critical must fire immediately.
    // This tests the `severityEscalated` bypass path.
    const sessionId = `test-317-escalated-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { exitCode, stdout } = runMonitorRaw({
      sessionId,
      writeMetrics: true,
      remaining: 20,   // CRITICAL (below 25)
      usedPct: 80,
      writeWarn: true,
      warnData: {
        callsSinceWarn: 1,      // below DEBOUNCE_CALLS → would normally debounce
        lastLevel: 'warning',   // previous level was warning → escalation to critical
      },
    });

    assert.strictEqual(exitCode, 0);
    assert.ok(stdout.length > 0,
      'severity escalation (warning→critical) must bypass debounce and emit warning');
    const parsed = JSON.parse(stdout);
    const msg = parsed?.hookSpecificOutput?.additionalContext;
    assert.ok(msg, 'escalation output must contain additionalContext');
    assert.match(msg, /CONTEXT CRITICAL/,
      'escalated message must say CONTEXT CRITICAL');
  });
});
