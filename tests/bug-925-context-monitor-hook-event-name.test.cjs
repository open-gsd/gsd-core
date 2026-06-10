/**
 * Regression test for bug #925
 *
 * hooks/gsd-context-monitor.js hardcodes `hookEventName: "PostToolUse"` (or
 * "AfterTool" for Gemini) regardless of which hook event invoked it. Since
 * PR #821 the same script is also registered under Stop, SubagentStop, and
 * PreCompact in hooks/hooks.json. Claude Code rejects output whose
 * hookSpecificOutput.hookEventName doesn't echo the triggering event:
 *
 *   "expected Stop but got PostToolUse"
 *
 * Fix: derive hookEventName from the parsed stdin payload's `hook_event_name`
 * field (already available in the data object), falling back to the
 * Gemini / non-Gemini heuristic for runtimes that don't send it.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MONITOR_PATH = path.join(__dirname, '..', 'hooks', 'gsd-context-monitor.js');

/**
 * Write a bridge metrics file and invoke the context monitor with the given
 * payload fields. Returns the parsed stdout object (or null if the hook
 * produced no output).
 *
 * remainingPct must be <= 35 to cross the WARNING threshold so the hook
 * actually emits output.
 */
function runMonitor({ hookEventName, sessionId, remainingPct = 30, usedPct = 70, env = {} }) {
  const bridgePath = path.join(os.tmpdir(), `claude-ctx-${sessionId}.json`);
  fs.writeFileSync(bridgePath, JSON.stringify({
    session_id: sessionId,
    remaining_percentage: remainingPct,
    used_pct: usedPct,
    timestamp: Math.floor(Date.now() / 1000),
  }));

  const payload = { session_id: sessionId, cwd: os.tmpdir() };
  if (hookEventName !== undefined) {
    payload.hook_event_name = hookEventName;
  }

  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [MONITOR_PATH], {
      input: JSON.stringify(payload),
      encoding: 'utf-8',
      timeout: 5000,
      env: { ...process.env, ...env },
    });
  } catch (e) {
    stdout = e.stdout || '';
  } finally {
    try { fs.unlinkSync(bridgePath); } catch { /* noop */ }
    try {
      fs.unlinkSync(path.join(os.tmpdir(), `claude-ctx-${sessionId}-warned.json`));
    } catch { /* noop */ }
  }

  if (!stdout) return null;
  return JSON.parse(stdout);
}

function makeSessionId(suffix) {
  return `test-925-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ─── hookEventName echoing ────────────────────────────────────────────────────

describe('bug #925: context monitor echoes the invoking hook event name', () => {
  test('hookEventName is "Stop" when payload contains hook_event_name: "Stop"', () => {
    const out = runMonitor({ hookEventName: 'Stop', sessionId: makeSessionId('stop') });
    assert.ok(out, 'hook must emit output when context is below WARNING threshold (remaining=30)');
    assert.strictEqual(
      out.hookSpecificOutput?.hookEventName,
      'Stop',
      `Expected hookEventName "Stop" but got "${out.hookSpecificOutput?.hookEventName}". ` +
      'The hook must echo the hook_event_name from stdin, not hardcode "PostToolUse".'
    );
  });

  test('hookEventName is "SubagentStop" when payload contains hook_event_name: "SubagentStop"', () => {
    const out = runMonitor({ hookEventName: 'SubagentStop', sessionId: makeSessionId('subagent-stop') });
    assert.ok(out, 'hook must emit output when context is below WARNING threshold');
    assert.strictEqual(
      out.hookSpecificOutput?.hookEventName,
      'SubagentStop',
      `Expected hookEventName "SubagentStop" but got "${out.hookSpecificOutput?.hookEventName}".`
    );
  });

  test('hookEventName is "PreCompact" when payload contains hook_event_name: "PreCompact"', () => {
    const out = runMonitor({ hookEventName: 'PreCompact', sessionId: makeSessionId('precompact') });
    assert.ok(out, 'hook must emit output when context is below WARNING threshold');
    assert.strictEqual(
      out.hookSpecificOutput?.hookEventName,
      'PreCompact',
      `Expected hookEventName "PreCompact" but got "${out.hookSpecificOutput?.hookEventName}".`
    );
  });

  test('hookEventName is "PostToolUse" when payload contains hook_event_name: "PostToolUse"', () => {
    const out = runMonitor({ hookEventName: 'PostToolUse', sessionId: makeSessionId('posttools') });
    assert.ok(out, 'hook must emit output when context is below WARNING threshold');
    assert.strictEqual(
      out.hookSpecificOutput?.hookEventName,
      'PostToolUse',
      `Expected hookEventName "PostToolUse" but got "${out.hookSpecificOutput?.hookEventName}".`
    );
  });
});

// ─── Fallback behaviour (no hook_event_name in payload) ──────────────────────

describe('bug #925: context monitor falls back to heuristic when hook_event_name absent', () => {
  test('falls back to "PostToolUse" when hook_event_name is absent (non-Gemini)', () => {
    const env = { ...process.env };
    delete env.GEMINI_API_KEY;
    const out = runMonitor({
      hookEventName: undefined,
      sessionId: makeSessionId('fallback-non-gemini'),
      env: { GEMINI_API_KEY: '' }, // ensure unset
    });
    assert.ok(out, 'hook must emit output when context is below WARNING threshold');
    assert.strictEqual(
      out.hookSpecificOutput?.hookEventName,
      'PostToolUse',
      `Expected fallback "PostToolUse" for non-Gemini but got "${out.hookSpecificOutput?.hookEventName}".`
    );
  });

  test('falls back to "AfterTool" when hook_event_name is absent and GEMINI_API_KEY is set', () => {
    const out = runMonitor({
      hookEventName: undefined,
      sessionId: makeSessionId('fallback-gemini'),
      env: { GEMINI_API_KEY: 'fake-key-for-test' },
    });
    assert.ok(out, 'hook must emit output when context is below WARNING threshold');
    assert.strictEqual(
      out.hookSpecificOutput?.hookEventName,
      'AfterTool',
      `Expected fallback "AfterTool" for Gemini but got "${out.hookSpecificOutput?.hookEventName}".`
    );
  });

  test('falls back to "PostToolUse" when hook_event_name is an empty string (non-Gemini)', () => {
    const out = runMonitor({
      hookEventName: '',
      sessionId: makeSessionId('fallback-empty'),
      env: { GEMINI_API_KEY: '' },
    });
    assert.ok(out, 'hook must emit output when context is below WARNING threshold');
    assert.strictEqual(
      out.hookSpecificOutput?.hookEventName,
      'PostToolUse',
      `Expected fallback "PostToolUse" for empty hook_event_name but got "${out.hookSpecificOutput?.hookEventName}".`
    );
  });

  test('falls back to "PostToolUse" when hook_event_name is whitespace-only (non-Gemini)', () => {
    // trim() makes "   " → "" which is falsy, so the || fallback fires
    const out = runMonitor({
      hookEventName: '   ',
      sessionId: makeSessionId('fallback-whitespace'),
      env: { GEMINI_API_KEY: '' },
    });
    assert.ok(out, 'hook must emit output when context is below WARNING threshold');
    assert.strictEqual(
      out.hookSpecificOutput?.hookEventName,
      'PostToolUse',
      `Expected fallback "PostToolUse" for whitespace-only hook_event_name but got "${out.hookSpecificOutput?.hookEventName}".`
    );
  });
});

// ─── Critical threshold also echoes the event name ───────────────────────────

describe('bug #925: critical threshold warning also uses correct hookEventName', () => {
  test('CRITICAL warning emitted under Stop also echoes "Stop"', () => {
    const out = runMonitor({
      hookEventName: 'Stop',
      sessionId: makeSessionId('critical-stop'),
      remainingPct: 20,
      usedPct: 80,
    });
    assert.ok(out, 'hook must emit output at critical threshold (remaining=20)');
    assert.strictEqual(
      out.hookSpecificOutput?.hookEventName,
      'Stop',
      `Expected hookEventName "Stop" at critical threshold, got "${out.hookSpecificOutput?.hookEventName}".`
    );
    assert.match(
      out.hookSpecificOutput?.additionalContext || '',
      /CONTEXT CRITICAL/,
      'Output should be a CRITICAL warning at remaining=20'
    );
  });
});
