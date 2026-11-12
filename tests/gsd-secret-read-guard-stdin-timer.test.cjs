'use strict';

/**
 * gsd-secret-read-guard.js — the stdin-timer cells of the host crash-policy
 * opt-in (#5784). Each drives the hook's stdin through a raw pipe that this
 * file controls: four hold it open, so the hook's own 3 s timer (stdin not
 * closed) is what ends them, and one closes it before that timer, so the scan
 * does.
 *
 * The process seam cannot stand in for these: spawnSync with no `input` closes
 * the child's stdin at once, so the hook sees EOF and takes its outer catch,
 * never its stdin timer.
 *
 * Why a file of its own, and not a `.platform` sibling: the child runs only
 * node, which is not a real-OS signal (#6002), so a sibling would carry no
 * signal and break the split invariant (#5074). Nor are these cells in
 * tests/gsd-secret-read-guard.test.cjs: a node-only child beside that file's
 * unlinkSync reads as fs-lock-or-install-child and would move the whole guard
 * suite onto the Windows conformance tier, which nothing here needs.
 *
 * Tests (describe "gsd-secret-read-guard: host opt-in to deny on its own
 * failure (#5784)"):
 *   - "opted in: a stalled stdin blocks as guard-error"
 *   - "unset: a stalled stdin still allows, silently"
 *   - "opted in: a full payload whose stdin stays open blocks as guard-error" —
 *     writes a complete payload into the held-open pipe, so the timer must
 *     still fire after data arrived.
 *   - "unset: a full payload whose stdin stays open still allows, silently"
 *   - "opted in: a payload whose stdin closes before the timer gets its
 *     ordinary verdict" — the other side of the 3 s boundary: the pipe closes
 *     2 s after spawn, so the hook must reach its scan, not guard-error.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { runHook: runHookSeam } = require('./helpers/process-seam.cjs');
const { QUICK_SPAWN_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'gsd-secret-read-guard.js');

// The hook reads its crash policy from its environment, so each spawn starts
// from process.env without it; the opt-in cells pass it back explicitly.
const ON_CRASH_ENV = 'GSD_SECRET_READ_GUARD_ON_CRASH';
function hookEnv(extra = {}) {
  const env = { ...process.env };
  delete env[ON_CRASH_ENV];
  return { ...env, ...extra };
}

function runHook(payload, extraEnv) {
  const r = runHookSeam(HOOK_PATH, [], {
    input: payload,
    env: hookEnv(extraEnv),
    timeoutMs: QUICK_SPAWN_TIMEOUT_MS,
  });
  return { status: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

// Spawns the hook on a real pipe. With a `written` string the payload goes in
// first, whole. With `closeAfterMs` the pipe then closes after that delay;
// without it the pipe stays open, so only the hook's own 3 s stdin timer can
// end it. The kill is a hang backstop (that timer plus the quick-spawn bound),
// never an elapsed-time assertion. NODE_V8_COVERAGE is blanked rather than
// deleted: a child under c8 inherits it and runs several times slower, and Node
// restores an inherited key that the child env lacks but leaves an own key
// alone.
function runPiped(extraEnv, written, closeAfterMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_PATH], {
      env: hookEnv({ NODE_V8_COVERAGE: '', ...extraEnv }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', () => {});
    if (written !== undefined) child.stdin.write(written);
    const closer = closeAfterMs === undefined ? null : setTimeout(() => child.stdin.end(), closeAfterMs);
    const backstop = setTimeout(() => child.kill('SIGKILL'), 3000 + QUICK_SPAWN_TIMEOUT_MS);
    child.on('error', (err) => { clearTimeout(closer); clearTimeout(backstop); reject(err); });
    child.on('close', (status) => {
      clearTimeout(closer);
      clearTimeout(backstop);
      child.stdin.destroy();
      resolve({ status, stdout, stderr });
    });
  });
}

// The pipe held open: only the hook's 3 s stdin timer can end the run.
function runStalled(extraEnv, written) {
  return runPiped(extraEnv, written);
}

// Only the unset cells use it: the default path must stay silent on both
// streams, byte for byte as before the opt-in existed.
function assertAllowed(r, label) {
  assert.equal(r.status, 0, `${label}: expected allow (exit 0), got exit ${r.status}; stdout=${r.stdout}`);
  assert.equal(r.stdout, '', `${label}: an allow must emit nothing on stdout`);
  assert.equal(r.stderr, '', `${label}: the default path must emit nothing on stderr`);
}

// A guard-error deny writes the plain reason to stderr, as the scan's own codes
// do (crash() forwards the hook's stderrPayload on DENY).
function assertGuardError(r, label) {
  assert.equal(r.status, 2, `${label}: expected block (exit 2), got exit ${r.status}; stdout=${r.stdout}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block', label);
  assert.equal(out.code, 'guard-error', `${label}: code`);
  assert.equal(typeof out.reason, 'string');
  assert.ok(out.reason.length > 0, `${label}: reason present`);
  assert.equal(r.stderr, out.reason, `${label}: stderr must carry the plain reason string (crash stderrPayload)`);
  return out;
}

describe('gsd-secret-read-guard: host opt-in to deny on its own failure (#5784)', () => {
  const DENY_ENV = { [ON_CRASH_ENV]: 'deny' };
  const MALFORMED = '{not json';

  test('opted in: a stalled stdin blocks as guard-error', async () => {
    const stall = assertGuardError(await runStalled(DENY_ENV), 'stall');
    // The two failure paths name different causes, so a runner that closed
    // stdin (and so reached the outer catch) cannot pass as a stall.
    const crash = assertGuardError(runHook(MALFORMED, DENY_ENV), 'crash');
    assert.notEqual(stall.reason, crash.reason, 'the stall must come from the stdin timer, not the outer catch');
  });

  test('unset: a stalled stdin still allows, silently', async () => {
    assertAllowed(await runStalled(), 'stall');
  });

  // The timer runs from spawn and `data` does not touch it, so a payload that
  // arrives whole while the pipe stays open is still a stall: the hook never
  // reaches its verdict, which runs only on `end`.
  const FULL_PAYLOAD = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls -la' } });

  test('opted in: a full payload whose stdin stays open blocks as guard-error', async () => {
    const written = assertGuardError(await runStalled(DENY_ENV, FULL_PAYLOAD), 'written stall');
    const stall = assertGuardError(await runStalled(DENY_ENV), 'stall');
    assert.equal(written.reason, stall.reason, 'the written stall must end on the stdin timer, like the empty one');
  });

  test('unset: a full payload whose stdin stays open still allows, silently', async () => {
    assertAllowed(await runStalled(undefined, FULL_PAYLOAD), 'written stall');
  });

  // The other side of the 3 s boundary. A separate hook process cannot take
  // mock.timers, so this cell closes the pipe 2 s after spawn rather than at
  // the timer's edge. The hook arms its timer only after it has started, so
  // the close lands a little under 2 s into that timer: a timer cut below
  // about 1.8 s fires first and fails the cell, while the correct one keeps
  // about 1 s of headroom for a slow spawn or a late close. The delay only
  // orders the close before the timer, and nothing asserts on elapsed time.
  // Both payloads must reach the scan's own verdict, so a timer that fired
  // anyway reads as guard-error in either one.
  const CLOSE_BEFORE_TIMER_MS = 2000;

  test('opted in: a payload whose stdin closes before the timer gets its ordinary verdict', async () => {
    assertAllowed(await runPiped(DENY_ENV, FULL_PAYLOAD, CLOSE_BEFORE_TIMER_MS), 'allow, closed early');
    const secret = '/p/' + '.e' + 'nv';
    const read = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: secret } });
    const r = await runPiped(DENY_ENV, read, CLOSE_BEFORE_TIMER_MS);
    assert.equal(r.status, 2, `secret read, closed early: expected block (exit 2), got exit ${r.status}; stdout=${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'block');
    assert.equal(out.code, 'secret-read', 'the scan must decide, not the stdin timer');
    assert.equal(out.path, secret);
  });
});
