'use strict';

/**
 * Unit tests for the #5328 `init --ws` carry of active-workstream-store.cjs (recordInitWorkstream / peekInitWorkstream).
 * Named `active-workstream-store-*` so scripts/mutation-matrix.cjs derives it into that module's Stryker shard.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanup, saveSessionEnv, restoreSessionEnv, clearSessionEnv } = require('./helpers.cjs');
const { createSessionScopedPointerAdapter } = require('../gsd-core/bin/lib/active-workstream-store.cjs');

// ── recordInitWorkstream / peekInitWorkstream (#5328 init --ws carry) ───────────
// The carry lives under os.tmpdir() beside the session pointers; every key a test writes is cleared after it.

describe('recordInitWorkstream / peekInitWorkstream', () => {
  const { recordInitWorkstream, peekInitWorkstream } = require('../gsd-core/bin/lib/active-workstream-store.cjs');
  const W = require('../gsd-core/bin/lib/active-workstream-store.cjs').INIT_WORKSTREAM_MAX_AGE_MS;
  const T = 1_000_000;
  let base;
  let saved;
  const raw = (key) => createSessionScopedPointerAdapter(base, key).read();
  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-unit-carry-'));
    saved = saveSessionEnv();
    clearSessionEnv();
  });
  afterEach(() => {
    for (const key of ['init-ws-s1', 'init-ws-s2', 'init-ws-a_b', 'claude-code-session-id-x']) {
      createSessionScopedPointerAdapter(base, key).clear();
    }
    restoreSessionEnv(saved);
    cleanup(base);
  });

  test('a record for a session reads back for that session only, as "<name> <ms>", and returns true', () => {
    assert.equal(recordInitWorkstream(base, 's1', 'alpha', T), true);
    assert.equal(peekInitWorkstream(base, 's1', T), 'alpha');
    assert.equal(raw('init-ws-s1'), `alpha ${T}`);
    assert.equal(peekInitWorkstream(base, 's2', T), null);
  });

  test('no session id records nothing and returns false', () => {
    for (const session of [undefined, '', '   ']) {
      assert.equal(recordInitWorkstream(base, session, 'alpha', T), false, String(session));
      assert.equal(peekInitWorkstream(base, session, T), null, String(session));
    }
  });

  test('the session id goes through the session-token sanitizer', () => {
    assert.equal(recordInitWorkstream(base, 'a b', 'alpha', T), true);
    assert.equal(peekInitWorkstream(base, 'a_b', T), 'alpha');
  });

  test('an invalid workstream name is never recorded', () => {
    for (const name of ['', '../x', 'a b']) {
      assert.equal(recordInitWorkstream(base, 's1', name, T), false, name);
      assert.equal(peekInitWorkstream(base, 's1', T), null, name);
    }
  });

  test('the carry window is 12 hours', () => assert.equal(W, 12 * 60 * 60 * 1000));

  test('expiry: fresh at age 0 and W-1, expired at W and W+1, and a future write time is not fresh', () => {
    recordInitWorkstream(base, 's1', 'alpha', T);
    assert.equal(peekInitWorkstream(base, 's1', T), 'alpha');
    assert.equal(peekInitWorkstream(base, 's1', T + W - 1), 'alpha');
    assert.equal(peekInitWorkstream(base, 's1', T + W), null);
    assert.equal(peekInitWorkstream(base, 's1', T + W + 1), null);
    assert.equal(peekInitWorkstream(base, 's1', T - 1), null);
  });

  test('every record refreshes the write time', () => {
    recordInitWorkstream(base, 's1', 'alpha', T);
    recordInitWorkstream(base, 's1', 'alpha', T + W - 1);
    assert.equal(peekInitWorkstream(base, 's1', T + W + 1), 'alpha');
  });

  test('a record prunes expired carries, keeps fresh ones and leaves non-carry files alone', () => {
    recordInitWorkstream(base, 's1', 'alpha', T);
    createSessionScopedPointerAdapter(base, 'claude-code-session-id-x').write('beta');
    recordInitWorkstream(base, 's2', 'gamma', T + W - 1);
    assert.equal(raw('init-ws-s1'), `alpha ${T}`, 'a fresh carry is kept');
    recordInitWorkstream(base, 's2', 'gamma', T + W);
    assert.equal(raw('init-ws-s1'), null, 'an expired carry is pruned');
    assert.equal(raw('claude-code-session-id-x'), 'beta', 'a session pointer is not a carry');
    assert.equal(peekInitWorkstream(base, 's2', T + W), 'gamma');
  });

  test('a stray directory named like a carry cannot turn a recorded carry into "not recorded"', (t) => {
    const session = path.basename(base); // unique to this test, so its carry file names one session directory only
    t.after(() => createSessionScopedPointerAdapter(base, `init-ws-${session}`).clear());
    recordInitWorkstream(base, session, 'alpha', T);
    const sessions = path.join(os.tmpdir(), 'gsd-workstream-sessions');
    const dir = fs.readdirSync(sessions).map((d) => path.join(sessions, d)).find((d) => fs.existsSync(path.join(d, `init-ws-${session}`)));
    const stray = path.join(dir, 'init-ws-x');
    fs.mkdirSync(stray);
    t.after(() => cleanup(stray));
    assert.equal(recordInitWorkstream(base, session, 'beta', T + W), true);
    assert.equal(peekInitWorkstream(base, session, T + W), 'beta');
  });
});
