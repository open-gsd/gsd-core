'use strict';

/**
 * gsd-secret-read-guard.js — the stdin-timer cells of the host crash-policy
 * opt-in (#5784). Each runs the hook file and drives its stdin through a raw
 * pipe: six hold it open, so the hook's own stall timer ends them, and one
 * closes it before that timer, so the scan does.
 *
 * The timer is observed and steered through a clock seam, never raced: every
 * spawn loads tests/helpers/stdin-timer-preload.cjs, whose header lists what it
 * reports on fd 3. Every cell asserts the hook armed STDIN_TIMEOUT_MS once and
 * never restarted it, and each held-open cell that the timer fired, so no cell
 * reads elapsed time. Three cells run the timer at the hook's own 3 s. The rest
 * set GSD_TEST_STALL_TIMER: 100 ms, counted from arming, or from the hook's first
 * `data` chunk where the cell writes a payload (the pending-data cell: its
 * second); the early-close cell parks it (armed, never due).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
// A raw spawn, not the process seam: spawnSync with no `input` closes the
// child's stdin at once, so the hook takes its outer catch, never its timer.
// A file of its own, not a `.platform` sibling: the child runs only node, no
// real-OS signal (#6002), so a sibling would break the split invariant (#5074).
// Nor in tests/gsd-secret-read-guard.test.cjs: a node-only child beside its
// unlinkSync reads as fs-lock-or-install-child and would move that whole suite
// onto the Windows conformance tier.
const { spawn } = require('node:child_process');
const { runHook: runHookSeam } = require('./helpers/process-seam.cjs');
const { QUICK_SPAWN_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'gsd-secret-read-guard.js');
const TIMER_PRELOAD = path.join(__dirname, 'helpers', 'stdin-timer-preload.cjs');
const { GUARD_ERROR_CAUSE, STDIN_TIMEOUT_MS } = require(HOOK_PATH);

// What the held-open cells schedule the timer at: only the timer can end those
// runs, so a short delay changes nothing but the wall time. A cell that writes a
// payload counts it from the hook's first `data` (fromData), so the payload is
// in before the timer can fire however slow the host is.
const SHORT_STALL_MS = 100;
// When the early-close cell closes stdin: after the payload has arrived and the
// timer is armed. Its timer is parked, so this delay orders nothing.
const CLOSE_AFTER_MS = 200;

// How often the unsteered fed cell writes a chunk: well inside the hook's 3 s,
// so a hook that restarted its timer on `data` would never come due.
const FEED_EVERY_MS = 100;

// The hook reads its crash policy from its environment, and the preload reads
// its delay from its own; each spawn starts from process.env without either,
// and the cells pass back what they need.
const ON_CRASH_ENV = 'GSD_SECRET_READ_GUARD_ON_CRASH';
const STALL_TIMER_ENV = 'GSD_TEST_STALL_TIMER';
function hookEnv(extra = {}) {
  const env = { ...process.env };
  delete env[ON_CRASH_ENV];
  delete env[STALL_TIMER_ENV];
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

// Spawns the hook file under the timer preload, on a real pipe. With a
// `written` string the payload goes in first, whole. With `closeAfterMs` the
// pipe then closes after that delay; without it the pipe stays open, so only
// the stall timer can end the run. With `stallTimer` the preload schedules the
// timer at that many ms, or parks it for 'park'; without it the timer runs at
// the hook's own delay. With `fromData` those ms count from the hook's first
// `data` (or its n-th, for a number) rather than from when it armed the timer.
// With `feed` that string is written again each time the hook reports a chunk,
// so data keeps arriving until the run ends; with `feedEveryMs` it is written on
// that interval instead, with no reference to what the hook received. fd 3 carries the preload's
// report. The kill is a hang backstop (the timer's scheduled delay, or the
// close for a parked timer, plus the quick-spawn bound), never an elapsed-time
// assertion. NODE_V8_COVERAGE is blanked rather than deleted: a child under c8
// inherits it and runs several times slower, and Node restores an inherited key
// that the child env lacks but leaves an own key alone.
function runPiped({ env: extraEnv, written, closeAfterMs, stallTimer, fromData = false, feed, feedEveryMs } = {}) {
  const extra = { NODE_V8_COVERAGE: '', ...extraEnv };
  if (stallTimer !== undefined) {
    const chunk = typeof fromData === 'number' ? `:${fromData}` : '';
    extra[STALL_TIMER_ENV] = fromData ? `after-data:${stallTimer}${chunk}` : String(stallTimer);
  }
  const endsByMs = stallTimer === 'park' ? (closeAfterMs ?? 0) : (stallTimer ?? STDIN_TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--require', TIMER_PRELOAD, HOOK_PATH], {
      env: hookEnv(extra),
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timerReport = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    let fed = 0;
    child.stdio[3].setEncoding('utf8').on('data', (chunk) => {
      timerReport += chunk;
      if (feed === undefined || feedEveryMs !== undefined) return;
      const delivered = (timerReport.match(/^data /gm) || []).length;
      for (; fed < delivered; fed++) child.stdin.write(feed);
    });
    child.stdin.on('error', () => {});
    if (written !== undefined) child.stdin.write(written);
    const closer = closeAfterMs === undefined ? null : setTimeout(() => child.stdin.end(), closeAfterMs);
    const feeder = feedEveryMs === undefined ? null : setInterval(() => child.stdin.write(feed ?? ' '), feedEveryMs);
    const backstop = setTimeout(() => child.kill('SIGKILL'), endsByMs + QUICK_SPAWN_TIMEOUT_MS);
    child.on('error', (err) => { clearTimeout(closer); clearInterval(feeder); clearTimeout(backstop); reject(err); });
    child.on('close', (status) => {
      clearTimeout(closer);
      clearInterval(feeder);
      clearTimeout(backstop);
      child.stdin.destroy();
      const lines = timerReport.split('\n').filter(Boolean);
      const values = (word) => lines.filter((l) => l.startsWith(`${word} `)).map((l) => Number(l.slice(word.length + 1)));
      resolve({ status, stdout, stderr, lines, armed: values('armed'), fired: values('fired'), refreshed: values('refreshed'), data: values('data') });
    });
  });
}

// The hook must arm one timer, at exactly its exported bound, whatever delay
// the preload then schedules it at, and never restart it.
function assertArmed(r, label) {
  assert.deepEqual(r.armed, [STDIN_TIMEOUT_MS], `${label}: the hook must arm one stdin timer at STDIN_TIMEOUT_MS`);
  assert.deepEqual(r.refreshed, [], `${label}: the hook must never restart its stdin timer`);
}

// ...and, on a held-open pipe, the timer must be what ended the run.
function assertTimer(r, label) {
  assertArmed(r, label);
  assert.deepEqual(r.fired, [STDIN_TIMEOUT_MS], `${label}: the stdin timer must fire`);
}

// The hook's own `data` listener received the whole payload, and before its
// timer fired: the parent's write alone proves only that bytes entered the pipe.
function assertReceivedBeforeStall(r, payload, label) {
  const received = r.data.reduce((sum, n) => sum + n, 0);
  assert.equal(received, Buffer.byteLength(payload), `${label}: the hook must receive the whole payload`);
  const lastData = r.lines.map((l) => l.startsWith('data ')).lastIndexOf(true);
  const fired = r.lines.findIndex((l) => l.startsWith('fired '));
  assert.ok(fired > lastData, `${label}: the payload must arrive before the timer fires`);
}

// Only the unset cells use it: the default path must stay silent on both
// streams, byte for byte as before the opt-in existed.
function assertAllowed(r, label) {
  assert.equal(r.status, 0, `${label}: expected allow (exit 0), got exit ${r.status}; stdout=${r.stdout}`);
  assert.equal(r.stdout, '', `${label}: an allow must emit nothing on stdout`);
  assert.equal(r.stderr, '', `${label}: the default path must emit nothing on stderr`);
}

// A guard-error deny names its failure in the typed `cause` field and writes
// the plain reason to stderr, as the scan's own codes do (crash() forwards the
// hook's stderrPayload on DENY).
function assertGuardError(r, label, cause) {
  assert.equal(r.status, 2, `${label}: expected block (exit 2), got exit ${r.status}; stdout=${r.stdout}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block', label);
  assert.equal(out.code, 'guard-error', `${label}: code`);
  assert.equal(out.cause, cause, `${label}: cause`);
  assert.equal(typeof out.reason, 'string');
  assert.ok(out.reason.length > 0, `${label}: reason present`);
  assert.equal(r.stderr, out.reason, `${label}: stderr must carry the plain reason string (crash stderrPayload)`);
  return out;
}

describe('gsd-secret-read-guard: host opt-in to deny on its own failure (#5784)', () => {
  const DENY_ENV = { [ON_CRASH_ENV]: 'deny' };
  const MALFORMED = '{not json';

  test('opted in: a stalled stdin blocks as guard-error', async () => {
    // The docs, the changeset and the hook header all state 3 s.
    assert.equal(STDIN_TIMEOUT_MS, 3000, 'the documented stall bound');
    const r = await runPiped({ env: DENY_ENV });
    assertGuardError(r, 'stall', GUARD_ERROR_CAUSE.STDIN_STALL);
    assertTimer(r, 'stall');
    // The two failure paths name different causes, so a runner that closed
    // stdin (and so reached the outer catch) cannot pass as a stall.
    assertGuardError(runHook(MALFORMED, DENY_ENV), 'crash', GUARD_ERROR_CAUSE.HOOK_ERROR);
  });

  test('unset: a stalled stdin still allows, silently', async () => {
    const r = await runPiped();
    assertAllowed(r, 'stall');
    assertTimer(r, 'stall');
  });

  // The timer runs from the hook's start and `data` does not touch it, so a
  // payload that arrives whole while the pipe stays open is still a stall: the
  // hook never reaches its verdict, which runs only on `end`.
  const FULL_PAYLOAD = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls -la' } });

  test('opted in: a full payload whose stdin stays open blocks as guard-error', async () => {
    const w = await runPiped({ env: DENY_ENV, written: FULL_PAYLOAD, stallTimer: SHORT_STALL_MS, fromData: true });
    // The written stall must end on the stdin timer, like the empty one.
    assertGuardError(w, 'written stall', GUARD_ERROR_CAUSE.STDIN_STALL);
    assertTimer(w, 'written stall');
    assertReceivedBeforeStall(w, FULL_PAYLOAD, 'written stall');
    const s = await runPiped({ env: DENY_ENV, stallTimer: SHORT_STALL_MS });
    assertGuardError(s, 'stall', GUARD_ERROR_CAUSE.STDIN_STALL);
    assertTimer(s, 'stall');
  });

  test('unset: a full payload whose stdin stays open still allows, silently', async () => {
    const r = await runPiped({ written: FULL_PAYLOAD, stallTimer: SHORT_STALL_MS, fromData: true });
    assertAllowed(r, 'written stall');
    assertTimer(r, 'written stall');
    assertReceivedBeforeStall(r, FULL_PAYLOAD, 'written stall');
  });

  // Data that keeps arriving must not hold the timer off. The cell writes the
  // payload, then one more chunk each time the hook reports one, and the
  // preload starts the timer only once the second chunk is in, so the hook's
  // `data` handler has run twice before the timer can fire and goes on running
  // while it is pending. A restart the preload's seam sees shows in its report
  // on any host: refresh() by any route as `refreshed`, a new timer through
  // setTimeout (global or node:timers) as a second `armed` (assertArmed). The
  // timer that fires here is the seam's, so a restart the seam does not see is
  // the next cell's to catch.
  test('opted in: data arriving while the timer is pending does not restart it', async () => {
    const r = await runPiped({ env: DENY_ENV, written: FULL_PAYLOAD, stallTimer: SHORT_STALL_MS, fromData: 2, feed: ' ' });
    assertGuardError(r, 'fed stall', GUARD_ERROR_CAUSE.STDIN_STALL);
    assertTimer(r, 'fed stall');
    const fired = r.lines.findIndex((l) => l.startsWith('fired '));
    const before = r.lines.slice(0, fired).filter((l) => l.startsWith('data ')).length;
    assert.ok(before >= 2, `fed stall: the timer must fire after the chunk that started it (${before} chunk(s) before it)`);
  });

  // The same check by behaviour alone, whatever API a restart goes through.
  // Nothing steers the timer: the hook's own 3 s timer is the one that fires,
  // and a chunk goes in every FEED_EVERY_MS until the run ends. A correct hook
  // ends at its bound however the feed is timed, so this cannot fail one; a hook
  // that restarted its timer on `data` never comes due while chunks keep
  // arriving, and the run ends only at the backstop.
  test('opted in: data fed through the whole window does not hold off the timer at its own 3 s', async () => {
    const r = await runPiped({ env: DENY_ENV, written: FULL_PAYLOAD, feedEveryMs: FEED_EVERY_MS });
    assertGuardError(r, 'fed at 3 s', GUARD_ERROR_CAUSE.STDIN_STALL);
    assertTimer(r, 'fed at 3 s');
  });

  // The other side of the bound. The timer is armed and parked, so it is still
  // pending when the pipe closes CLOSE_AFTER_MS in, and nothing about the host's
  // speed can let it fire first. Both payloads must reach the scan's own
  // verdict. A parked timer cannot fire, so the report shows only that the
  // timer was armed; the verdicts show that the scan, not the timer, decided.
  test('opted in: a payload whose stdin closes before the timer gets its ordinary verdict', async () => {
    const early = { env: DENY_ENV, closeAfterMs: CLOSE_AFTER_MS, stallTimer: 'park' };
    const allowed = await runPiped({ ...early, written: FULL_PAYLOAD });
    assertAllowed(allowed, 'allow, closed early');
    assertArmed(allowed, 'allow, closed early');
    const secret = '/p/' + '.e' + 'nv';
    const read = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: secret } });
    const r = await runPiped({ ...early, written: read });
    assert.equal(r.status, 2, `secret read, closed early: expected block (exit 2), got exit ${r.status}; stdout=${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'block');
    assert.equal(out.code, 'secret-read', 'the scan must decide, not the stdin timer');
    assert.equal(out.path, secret);
    assertArmed(r, 'secret read, closed early');
  });
});
