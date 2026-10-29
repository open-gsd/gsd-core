'use strict';

/**
 * gsd-secret-read-guard.js — the stdin-timer cells of the host crash-policy
 * opt-in (#5784), split out of tests/gsd-secret-read-guard.test.cjs because
 * they need a real OS pipe.
 *
 * Moved tests (describe "gsd-secret-read-guard: host opt-in to deny on its own
 * failure (#5784)"):
 *   - "opted in: a stalled stdin blocks as guard-error" — holds the hook's
 *     stdin pipe open through a raw child process, so the hook's own 3 s timer
 *     is what ends it; pipe EOF and kill behaviour differ on Windows
 *     (raw-child-process).
 *   - "unset: a stalled stdin still allows, silently" — the same held-open
 *     pipe, with the opt-in unset (raw-child-process).
 *
 * The process seam cannot stand in for these: spawnSync with no `input` closes
 * the child's stdin at once, so the hook sees EOF and takes its outer catch,
 * never its stdin timer.
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

// Keeps the pipe open and never writes, so only the hook's own 3 s stdin timer
// can end it. The kill is a hang backstop (that timer plus the quick-spawn
// bound), never an elapsed-time assertion. NODE_V8_COVERAGE is blanked rather
// than deleted: a child under c8 inherits it and runs several times slower,
// and Node restores an inherited key that the child env lacks but leaves an
// own key alone.
function runStalled(extraEnv) {
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
    const backstop = setTimeout(() => child.kill('SIGKILL'), 3000 + QUICK_SPAWN_TIMEOUT_MS);
    child.on('error', (err) => { clearTimeout(backstop); reject(err); });
    child.on('close', (status) => {
      clearTimeout(backstop);
      child.stdin.destroy();
      resolve({ status, stdout, stderr });
    });
  });
}

function assertAllowed(r, label) {
  assert.equal(r.status, 0, `${label}: expected allow (exit 0), got exit ${r.status}; stdout=${r.stdout}`);
  assert.equal(r.stdout, '', `${label}: an allow must emit nothing on stdout`);
}

// crash() hands one payload to both streams, so a guard-error deny's stderr is
// the payload's JSON, not the plain reason the scan's own codes write.
function assertGuardError(r, label) {
  assert.equal(r.status, 2, `${label}: expected block (exit 2), got exit ${r.status}; stdout=${r.stdout}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block', label);
  assert.equal(out.code, 'guard-error', `${label}: code`);
  assert.equal(typeof out.reason, 'string');
  assert.ok(out.reason.length > 0, `${label}: reason present`);
  assert.deepEqual(JSON.parse(r.stderr), out, `${label}: stderr carries the same payload`);
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
});
