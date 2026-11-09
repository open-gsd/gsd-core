'use strict';
/**
 * Tests for the state IO seam (ADR-1239 Phase C-1, AC4 / #1680).
 * Pins: filesystem (today's behavior) + fail-closed non-filesystem seams +
 * host-backend binding + construction gating.
 */

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createStateIO } = require('../gsd-core/bin/lib/state-io.cjs');
const { normalizeContent } = require('../gsd-core/bin/lib/shell-command-projection.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

test('filesystem stateIO: read/write delegate to fs (today behavior)', () => {
  const io = createStateIO({ io: 'filesystem' });
  assert.strictEqual(io.io, 'filesystem');
  const dir = createTempDir();
  try {
    const file = path.join(dir, 'STATE.md');
    io.write(file, '# State\n');
    assert.strictEqual(io.read(file), '# State\n');
    assert.strictEqual(fs.readFileSync(file, 'utf-8'), '# State\n', 'must write through to real fs');
  } finally {
    cleanup(dir);
  }
});

test('sandboxed-storage stateIO: fail-closed until a host backend is bound', () => {
  const io = createStateIO({ io: 'sandboxed-storage' });
  assert.strictEqual(io.io, 'sandboxed-storage');
  assert.throws(() => io.read('/x'), /no host backend bound/, 'read must fail closed when unbound');
  assert.throws(() => io.write('/x', 'y'), /no host backend bound/, 'write must fail closed when unbound');
});

test('session-log-append stateIO: fail-closed until a host backend is bound', () => {
  const io = createStateIO({ io: 'session-log-append' });
  assert.throws(() => io.read('/x'), /no host backend bound/);
});

test('non-filesystem stateIO: host backend is used when bound', () => {
  const calls = [];
  const io = createStateIO(
    { io: 'sandboxed-storage' },
    { backend: {
      read: (p) => { calls.push(['read', p]); return 'BACKEND:' + p; },
      write: (p, c) => { calls.push(['write', p, c]); },
    } },
  );
  assert.strictEqual(io.read('/state/log'), 'BACKEND:/state/log');
  io.write('/state/log', 'entry');
  assert.deepStrictEqual(calls, [['read', '/state/log'], ['write', '/state/log', 'entry']]);
});

test('createStateIO: invalid io throws (fail-closed construction)', () => {
  for (const bad of ['memory', '', null, undefined, 2]) {
    assert.throws(() => createStateIO({ io: bad }), TypeError, `io=${JSON.stringify(bad)} must throw`);
  }
});

// #5120 (epic #4629, ADR-4629 guard roster "No raw STATE.md write outside the
// seam"): the filesystem adapter wrote STATE.md with a raw fs.writeFileSync,
// outside the STATE.md lock, so a host writing through MCP `gsd_write_state`
// could lose a concurrent update (the #500/#905/#1230 lost-update family).
// A STATE.md destination now takes the lock and writes through the seam, the
// cmdStateMilestoneSwitch shape; every other destination is unchanged.
test('filesystem stateIO: a STATE.md destination is written through the seam, under the STATE.md lock (#5120)', (t) => {
  const dir = createTempDir('state-io-5120-');
  t.after(() => cleanup(dir));
  const file = path.join(dir, 'STATE.md');
  const original = '---\r\nstatus: executing\r\n---\r\n# State\r\nline one\r\n\r\n\r\nline two\r\n';
  const expected = normalizeContent(file, original).content;
  assert.notEqual(expected, original, 'precondition: the CRLF fixture is one the seam normalizes');

  const writes = [];
  const record = (destination) => {
    if (path.resolve(String(destination)) === path.resolve(file)) writes.push({ lockHeld: fs.existsSync(`${file}.lock`) });
  };
  const realWrite = fs.writeFileSync;
  const realRename = fs.renameSync;
  mock.method(fs, 'writeFileSync', function (target, ...rest) { record(target); return realWrite.call(this, target, ...rest); });
  mock.method(fs, 'renameSync', function (from, to) { record(to); return realRename.call(this, from, to); });
  t.after(() => mock.restoreAll());

  createStateIO({ io: 'filesystem' }).write(file, original);
  mock.restoreAll();

  assert.deepEqual(writes, [{ lockHeld: true }], 'one write lands on STATE.md, and it holds the STATE.md lock');
  assert.equal(fs.readFileSync(file, 'utf8'), expected, 'STATE.md holds the content as the seam writes it');
  assert.equal(fs.existsSync(`${file}.lock`), false, 'the lock is released after the write');
});

test('filesystem stateIO: a STATE.md write that cannot take the lock throws and writes nothing (#5120)', (t) => {
  const dir = createTempDir('state-io-5120-nolock-');
  t.after(() => cleanup(dir));
  const file = path.join(dir, 'STATE.md');
  fs.writeFileSync(file, '# before\n');

  // An errno acquireStateLock does not retry, so the failure is immediate.
  const realOpen = fs.openSync;
  mock.method(fs, 'openSync', function (target, ...rest) {
    if (String(target) === `${file}.lock`) throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' });
    return realOpen.call(this, target, ...rest);
  });
  t.after(() => mock.restoreAll());

  assert.throws(() => createStateIO({ io: 'filesystem' }).write(file, '# after\n'), /EROFS/);
  mock.restoreAll();
  assert.equal(fs.readFileSync(file, 'utf8'), '# before\n', 'STATE.md is untouched when the lock cannot be taken');
});

test('filesystem stateIO: every other destination is written byte-for-byte with no lock (ADR-1239 today\'s behavior)', (t) => {
  const dir = createTempDir('state-io-bytes-');
  t.after(() => cleanup(dir));
  const io = createStateIO({ io: 'filesystem' });
  const crlf = '# Title\r\nline\r\n\r\n\r\n- a\r\ntext\r\n\r\n\r\n';
  for (const name of ['PROJECT.md', 'config.json', 'STATE.md.bak', 'state.md', 'ROADMAP.md']) {
    const file = path.join(dir, name);
    io.write(file, crlf);
    assert.equal(fs.readFileSync(file, 'utf8'), crlf, `${name} is written exactly as given`);
    assert.equal(fs.existsSync(`${file}.lock`), false, `${name} takes no lock`);
  }
});
