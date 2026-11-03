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
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { runHook, runNode } = require('./helpers/process-seam.cjs');
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

  // The carry directory of `base`: a record for a throwaway session creates it, and the session's own files stay inside it.
  const carryDir = (t, session) => {
    t.after(() => createSessionScopedPointerAdapter(base, `init-ws-${session}`).clear());
    recordInitWorkstream(base, session, 'alpha', T);
    const sessions = path.join(os.tmpdir(), 'gsd-workstream-sessions');
    return fs.readdirSync(sessions).map((d) => path.join(sessions, d)).find((d) => fs.existsSync(path.join(d, `init-ws-${session}`)));
  };

  test('an unreadable entry does not stop the prune of later expired carries', (t) => {
    const session = path.basename(base);
    const dir = carryDir(t, session);
    const strays = [];
    for (let i = 0; i < 8; i++) {
      const stray = path.join(dir, `init-ws-0stray${i}`);
      fs.mkdirSync(stray);
      strays.push(stray);
      createSessionScopedPointerAdapter(base, `init-ws-old${i}`).write(`alpha ${T}`);
    }
    t.after(() => {
      strays.forEach((s) => cleanup(s));
      for (let i = 0; i < 8; i++) createSessionScopedPointerAdapter(base, `init-ws-old${i}`).clear();
    });
    assert.equal(recordInitWorkstream(base, session, 'beta', T + W), true);
    for (let i = 0; i < 8; i++) assert.equal(raw(`init-ws-old${i}`), null, `old${i} is pruned`);
  });

  // The carry file path of a throwaway session, so a test writes the raw bytes a carry holds.
  const carryFile = (t, session) => path.join(carryDir(t, session), `init-ws-${session}`);

  test('surrounding whitespace in the carry file parses to the same name and write time', (t) => {
    const session = path.basename(base);
    const file = carryFile(t, session);
    for (const text of [`alpha ${T}`, `\n alpha ${T}`, `alpha ${T}\n`, `  \talpha ${T} \n\n`]) {
      fs.writeFileSync(file, text);
      assert.equal(peekInitWorkstream(base, session, T), 'alpha', JSON.stringify(text));
    }
  });

  test('a carry file is read up to exactly 1024 bytes and not beyond', (t) => {
    const session = path.basename(base);
    const file = carryFile(t, session);
    const cap = 1024;
    const sized = (n) => `alpha ${T}`.padEnd(n, ' ');
    for (const [n, expected] of [[cap - 1, 'alpha'], [cap, 'alpha'], [cap + 1, null]]) {
      fs.writeFileSync(file, sized(n));
      assert.equal(fs.statSync(file).size, n);
      assert.equal(peekInitWorkstream(base, session, T), expected, `${n} bytes`);
    }
  });

  test('a directory at the carry path reads as no carry', (t) => {
    const session = path.basename(base);
    const file = carryFile(t, session);
    cleanup(file);
    fs.mkdirSync(file);
    t.after(() => cleanup(file));
    assert.equal(peekInitWorkstream(base, session, T), null);
  });

  test('a read releases its descriptor whether the carry is small or oversized', (t) => {
    if (!fs.existsSync('/proc/self/fd')) return t.skip('no /proc/self/fd');
    const session = path.basename(base);
    const file = carryFile(t, session);
    const open = () => fs.readdirSync('/proc/self/fd').length;
    for (const text of [`alpha ${T}`, `alpha ${T}`.padEnd(2048, ' ')]) {
      fs.writeFileSync(file, text);
      const before = open();
      for (let i = 0; i < 20; i++) peekInitWorkstream(base, session, T);
      assert.equal(open(), before, `${text.length} bytes leaks no descriptor`);
    }
  });

  test('pruning an entry that vanished after the listing does not throw, still prunes later entries and removes with force', (t) => {
    const session = path.basename(base);
    const dir = carryDir(t, session);
    createSessionScopedPointerAdapter(base, 'init-ws-zold').write(`alpha ${T}`);
    t.after(() => createSessionScopedPointerAdapter(base, 'init-ws-zold').clear());
    const realList = fs.readdirSync;
    const rm = t.mock.method(fs, 'rmSync');
    fs.readdirSync = (d, ...rest) => {
      const names = realList(d, ...rest);
      return d === dir ? ['init-ws-0phantom', ...names] : names;
    };
    t.after(() => { fs.readdirSync = realList; });
    assert.equal(recordInitWorkstream(base, session, 'beta', T + W), true);
    const forced = rm.mock.calls.filter((c) => path.basename(c.arguments[0]) === 'init-ws-0phantom').map((c) => c.arguments[1]?.force);
    assert.deepEqual(forced, [true], 'the vanished entry is removed with force');
    assert.equal(raw('init-ws-zold'), null, 'a later expired carry is still pruned');
  });

  test('a FIFO named like a carry never blocks a read or a record', (t) => {
    const session = path.basename(base);
    const dir = carryDir(t, session);
    const fifoSession = `${session}-fifo`;
    const fifo = path.join(dir, `init-ws-${fifoSession}`);
    const made = runHook(fifo, [], { interpreter: 'mkfifo', timeoutMs: PROBE_TIMEOUT_MS });
    if (made.exitCode !== 0) return t.skip('mkfifo is not available');
    t.after(() => cleanup(fifo));
    const lib = path.resolve(__dirname, '../gsd-core/bin/lib/active-workstream-store.cjs');
    const run = (code) => runNode(['-e', code, lib, base, fifoSession, session], { timeoutMs: PROBE_TIMEOUT_MS });
    const peeked = run('const s = require(process.argv[1]); console.log(String(s.peekInitWorkstream(process.argv[2], process.argv[3], 0)));');
    assert.equal(peeked.timedOut, false, 'peek returned instead of blocking');
    assert.equal(peeked.exitCode, 0, peeked.stderr);
    assert.equal(peeked.stdout.trim(), 'null');
    const recorded = run('const s = require(process.argv[1]); console.log(String(s.recordInitWorkstream(process.argv[2], process.argv[4], "beta", Date.now())));');
    assert.equal(recorded.timedOut, false, 'record returned instead of blocking');
    assert.equal(recorded.exitCode, 0, recorded.stderr);
    assert.equal(recorded.stdout.trim(), 'true');
  });
});
