'use strict';

/**
 * #2289 — gsd-context-monitor lifecycle-event output allowlist.
 *
 * The context monitor emits a `hookSpecificOutput.additionalContext` envelope
 * to inject context warnings. That shape is only valid for the context-injection
 * events (PostToolUse, and AfterTool for the Gemini dialect). Codex also wires
 * this hook to Stop / SubagentStart / SubagentStop / PreCompact (#772), and
 * Codex's Stop schema REJECTS the envelope ("hook returned invalid stop hook
 * JSON output"). The fix uses a positive allowlist: emit only for
 * injection-capable events; every other event — and a missing/unknown name —
 * exits 0 with NO stdout, while side effects (debounce, critical-session
 * recording) still run.
 *
 * These tests drive the real hook script end-to-end (spawn + stdin + a fresh
 * metrics bridge file), asserting behavior, not source text.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'gsd-context-monitor.js');

// Run the monitor with a synthetic, fresh metrics bridge file.
// Returns { stdout, warnData } and cleans up the bridge + sentinel files.
// opts: { event, remaining, used = 80, gemini = false, gsdActive = false }
function runMonitor(opts) {
  const {
    event,
    remaining,
    used = 80,
    gemini = false,
    gsdActive = false,
  } = opts;

  const sessionId = `fix-2289-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tmpDir = os.tmpdir();
  const metricsPath = path.join(tmpDir, `claude-ctx-${sessionId}.json`);
  const warnPath = path.join(tmpDir, `claude-ctx-${sessionId}-warned.json`);

  // Fresh (non-stale) metrics: timestamp is "now" in seconds.
  fs.writeFileSync(metricsPath, JSON.stringify({
    timestamp: Math.floor(Date.now() / 1000),
    remaining_percentage: remaining,
    used_pct: used,
  }));

  // Optional GSD-active project dir (STATE.md present) so the critical-session
  // recording side effect is reachable.
  let cwd = tmpDir;
  let projDir = null;
  if (gsdActive) {
    projDir = fs.mkdtempSync(path.join(tmpDir, 'fix-2289-proj-'));
    fs.mkdirSync(path.join(projDir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(projDir, '.planning', 'STATE.md'), '# State\n');
    cwd = projDir;
  }

  const payload = { session_id: sessionId, cwd };
  if (event !== undefined) payload.hook_event_name = event;

  const env = { ...process.env };
  if (gemini) env.GEMINI_API_KEY = 'test-key';
  else delete env.GEMINI_API_KEY;

  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [HOOK_PATH], {
      input: JSON.stringify(payload),
      env,
      encoding: 'utf8',
      timeout: 8000,
    });
  } catch (e) {
    stdout = e.stdout || '';
  }

  let warnData = null;
  try {
    warnData = JSON.parse(fs.readFileSync(warnPath, 'utf8'));
  } catch { /* sentinel may not exist */ }

  // Cleanup
  for (const p of [metricsPath, warnPath]) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }
  if (projDir) {
    // Retry-tolerant teardown: the critical path fires a detached, unref()'d
    // `state record-session` grandchild against projDir, and execFileSync does
    // not wait for it. maxRetries/retryDelay absorbs the transient
    // EBUSY/ENOTEMPTY window while that process exits, so cleanup can neither
    // flake nor leak the temp dir (mirrors tests/helpers.cjs cleanup(); see the
    // #2289 review and the prior fix in perf-317-context-monitor-fs.test.cjs).
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- test fixture teardown of a unique mkdtemp dir
    try { fs.rmSync(projDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* ignore */ }
  }

  return { stdout, warnData };
}

describe('#2289 context-monitor: non-injection events exit silently', () => {
  // Boundary coverage around WARNING (35) and CRITICAL (25) — Stop must stay
  // silent at limit-1 / limit / limit+1 for BOTH thresholds.
  for (const remaining of [40, 36, 35, 34, 26, 25, 24, 20]) {
    test(`Stop event at remaining=${remaining}% → exit 0, empty stdout`, () => {
      const { stdout } = runMonitor({ event: 'Stop', remaining });
      assert.strictEqual(stdout, '', `Stop must emit nothing at remaining=${remaining}% (Codex rejects the envelope)`);
    });
  }

  test('missing hook_event_name (no Gemini) at 30% → empty stdout', () => {
    const { stdout } = runMonitor({ event: undefined, remaining: 30 });
    assert.strictEqual(stdout, '', 'a missing event name must not fall through to the injection envelope');
  });

  test('empty-string hook_event_name (no Gemini) at 30% → empty stdout', () => {
    const { stdout } = runMonitor({ event: '   ', remaining: 30 });
    assert.strictEqual(stdout, '', 'a blank event name must be treated as missing → silent');
  });

  for (const event of ['SubagentStart', 'SubagentStop', 'PreCompact', 'SessionStart', 'BeforeTool']) {
    test(`unknown/non-injection event "${event}" at 30% → empty stdout`, () => {
      const { stdout } = runMonitor({ event, remaining: 30 });
      assert.strictEqual(stdout, '', `${event} is not injection-capable and must emit nothing`);
    });
  }
});

describe('#2289 context-monitor: injection events still warn (unchanged)', () => {
  test('PostToolUse at 30% → WARNING envelope with hookEventName PostToolUse', () => {
    const { stdout } = runMonitor({ event: 'PostToolUse', remaining: 30, used: 70 });
    assert.notStrictEqual(stdout, '', 'PostToolUse must still emit a warning envelope');
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(parsed.hookSpecificOutput.additionalContext, /CONTEXT WARNING/);
  });

  test('PostToolUse at 20% → CRITICAL envelope', () => {
    const { stdout } = runMonitor({ event: 'PostToolUse', remaining: 20, used: 80 });
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(parsed.hookSpecificOutput.additionalContext, /CONTEXT CRITICAL/);
  });

  test('AfterTool at 30% → WARNING envelope with hookEventName AfterTool', () => {
    const { stdout } = runMonitor({ event: 'AfterTool', remaining: 30 });
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'AfterTool');
    assert.match(parsed.hookSpecificOutput.additionalContext, /CONTEXT WARNING/);
  });

  test('missing event name WITH Gemini env at 30% → AfterTool envelope (fallback preserved)', () => {
    const { stdout } = runMonitor({ event: undefined, remaining: 30, gemini: true });
    assert.notStrictEqual(stdout, '', 'Gemini AfterTool fallback must still emit when the event name is absent');
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'AfterTool');
  });

  test('explicit PostToolUse WITH Gemini env → explicit name wins over the AfterTool fallback', () => {
    // Precedence guard: the Gemini fallback only applies to a MISSING name; an
    // explicit PostToolUse must still report as PostToolUse even under GEMINI_API_KEY.
    const { stdout } = runMonitor({ event: 'PostToolUse', remaining: 30, gemini: true });
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(parsed.hookSpecificOutput.additionalContext, /CONTEXT WARNING/);
  });

  // Threshold boundaries on the emit path: 36 = no warn, 35 = warn, 25 = critical, 26 = warn.
  test('PostToolUse at 36% (above WARNING) → empty stdout', () => {
    const { stdout } = runMonitor({ event: 'PostToolUse', remaining: 36 });
    assert.strictEqual(stdout, '', 'no warning above the 35% threshold');
  });

  test('PostToolUse at 35% (WARNING boundary) → WARNING envelope', () => {
    const { stdout } = runMonitor({ event: 'PostToolUse', remaining: 35 });
    assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /CONTEXT WARNING/);
  });

  test('PostToolUse at 25% (CRITICAL boundary) → CRITICAL envelope', () => {
    const { stdout } = runMonitor({ event: 'PostToolUse', remaining: 25 });
    assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /CONTEXT CRITICAL/);
  });
});

describe('#2289 context-monitor: side effects still fire on silent events (no output ≠ no side effect)', () => {
  test('Stop at 30% still writes the debounce sentinel (bookkeeping runs)', () => {
    const { stdout, warnData } = runMonitor({ event: 'Stop', remaining: 30 });
    assert.strictEqual(stdout, '', 'Stop emits nothing');
    assert.ok(warnData, 'the debounce sentinel must still be written on a silenced Stop event');
    assert.strictEqual(warnData.lastLevel, 'warning', 'debounce level bookkeeping runs regardless of output');
  });

  test('Stop at 20% in a GSD project still records the critical-session sentinel', () => {
    const { stdout, warnData } = runMonitor({ event: 'Stop', remaining: 20, used: 80, gsdActive: true });
    assert.strictEqual(stdout, '', 'Stop emits nothing even at critical context');
    assert.ok(warnData, 'sentinel must be written');
    assert.strictEqual(warnData.criticalRecorded, true, 'critical-session recording side effect fires on the silent Stop event');
  });
});
