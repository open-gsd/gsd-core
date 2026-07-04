'use strict';
/**
 * Tests for the state IO seam (ADR-1239 Phase C-1, AC4 / #1680).
 * Pins: filesystem (today's behavior) + fail-closed non-filesystem seams +
 * host-backend binding + construction gating.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createStateIO } = require('../gsd-core/bin/lib/state-io.cjs');
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
