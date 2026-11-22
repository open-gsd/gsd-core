'use strict';
/**
 * Tests for the state IO seam (ADR-1239 Phase C-1, AC4 / #1680).
 * Pins: filesystem (confined to a bound .planning/ root, #6146) + fail-closed
 * non-filesystem seams + host-backend binding + construction gating.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createStateIO, confineStatePath } = require('../gsd-core/bin/lib/state-io.cjs');
const stateShapes = require('./helpers/state-path-shapes.cjs');

test('filesystem stateIO: read/write delegate to fs inside the bound .planning/ root', (t) => {
  const fx = stateShapes.buildFixture(t);
  const io = createStateIO({ io: 'filesystem' }, { root: fx.planning });
  assert.strictEqual(io.io, 'filesystem');
  const file = path.join(fx.planning, 'sub', 'STATE.md');
  io.write(file, '# State\n');
  assert.strictEqual(io.read(file), '# State\n');
  assert.strictEqual(fs.readFileSync(file, 'utf-8'), '# State\n', 'must write through to real fs');
  io.write(file, 'x');
  assert.strictEqual(fs.readFileSync(file, 'utf-8'), 'x', 'an existing file is truncated, not appended');
});

test('filesystem stateIO: fail-closed when no .planning/ root is bound (#6146)', (t) => {
  const fx = stateShapes.buildFixture(t);
  for (const options of [undefined, {}, { root: '' }, { root: 'relative/.planning' }]) {
    const io = createStateIO({ io: 'filesystem' }, options);
    assert.strictEqual(io.io, 'filesystem');
    assert.throws(() => io.read(fx.state), /no absolute \.planning\/ root is bound/);
    assert.throws(() => io.write(fx.state, 'x'), /no absolute \.planning\/ root is bound/);
  }
  stateShapes.unchanged(fx);
});

// #6146: the adapter enforces the same confinement as the MCP dispatch, pinned
// here against the shared shapes WITHOUT going through the dispatch.
describe('REGRESSION #6146: filesystem stateIO confines every path to its root', () => {
  test('a symlink that stays inside the root is followed', (t) => {
    const fx = stateShapes.buildFixture(t);
    const inlink = path.join(fx.planning, 'inlink.md');
    if (!stateShapes.link(t, 'file', fx.state, inlink)) return;
    const io = createStateIO({ io: 'filesystem' }, { root: fx.planning });
    assert.strictEqual(io.read(inlink), stateShapes.IN);
  });

  for (const shape of stateShapes.REFUSAL_SHAPES) {
    for (const op of shape.ops) {
      test(`${op} refuses: ${shape.name}`, (t) => {
        const fx = stateShapes.buildFixture(t);
        const target = shape.setup(fx, t);
        if (target === null) return;
        const io = createStateIO({ io: 'filesystem' }, { root: fx.planning });
        let err = null;
        try {
          if (op === 'read') io.read(target);
          else io.write(target, stateShapes.PAYLOAD);
        } catch (e) {
          err = e;
        }
        assert.ok(err instanceof Error, `${op} must throw`);
        assert.ok(err.message.startsWith(`filesystem stateIO ${op} refused: `), err.message);
        stateShapes.assertRefusalText(err.message, fx, shape.reason);
        stateShapes.unchanged(fx);
        if (shape.proof) shape.proof(fx);
      });
    }
  }

  for (const op of ['read', 'write']) {
    test(`${op} refuses: a symlinked .planning root`, (t) => {
      const fx = stateShapes.buildFixture(t);
      const sr = stateShapes.symlinkedRootFixture(t, fx);
      if (sr === null) return;
      const io = createStateIO({ io: 'filesystem' }, { root: sr.planning });
      const run = op === 'read'
        ? () => io.read(path.join(sr.planning, 'secret.md'))
        : () => io.write(path.join(sr.planning, 'new2.md'), stateShapes.PAYLOAD);
      assert.throws(run, (e) => { stateShapes.assertRefusalText(e.message, fx, stateShapes.SYMLINKED_ROOT_REASON); return true; });
      stateShapes.unchanged(fx);
    });
  }

  // Check-then-open (Minor 3): the path is swapped between the check and the
  // open. fs.openSync is wrapped to perform the swap at the open.
  function swapAtOpen(t, target, swap) {
    const original = fs.openSync;
    let armed = true;
    fs.openSync = function patched(p, ...rest) {
      if (armed && p === target) { armed = false; swap(); }
      return original.call(this, p, ...rest);
    };
    t.after(() => { fs.openSync = original; });
  }

  test('a final component swapped to an outside symlink at open is not followed (O_NOFOLLOW)', (t) => {
    if (!fs.constants.O_NOFOLLOW) { t.skip('no O_NOFOLLOW on this platform'); return; }
    const fx = stateShapes.buildFixture(t);
    const io = createStateIO({ io: 'filesystem' }, { root: fx.planning });
    swapAtOpen(t, fx.state, () => { fs.unlinkSync(fx.state); fs.symlinkSync(fx.secret, fx.state); });
    assert.throws(() => io.write(fx.state, stateShapes.PAYLOAD), /^Error: filesystem stateIO write failed: ELOOP$/);
    assert.equal(fs.readFileSync(fx.secret, 'utf8'), stateShapes.SECRET, 'the outside file must be unchanged');
  });

  for (const op of ['read', 'write']) {
    test(`${op}: a parent directory swapped to an outside symlink at open is caught on the descriptor`, (t) => {
      const fx = stateShapes.buildFixture(t);
      const target = path.join(fx.planning, 'sub', 'secret.md');
      fs.writeFileSync(target, stateShapes.IN);
      const io = createStateIO({ io: 'filesystem' }, { root: fx.planning });
      let swapped = false;
      swapAtOpen(t, target, () => {
        fs.renameSync(path.join(fx.planning, 'sub'), path.join(fx.planning, 'sub-moved'));
        try {
          fs.symlinkSync(fx.outside, path.join(fx.planning, 'sub'), 'dir');
          swapped = true;
        } catch { /* platform refuses symlinks; the open then fails ENOENT */ }
      });
      let err = null;
      let out;
      try { out = op === 'read' ? io.read(target) : io.write(target, stateShapes.PAYLOAD); } catch (e) { err = e; }
      if (!swapped) { t.skip('cannot create a dir symlink here'); return; }
      assert.ok(err instanceof Error, `${op} must throw, got ${JSON.stringify(out)}`);
      assert.match(err.message, /^filesystem stateIO (read|write) refused: the path changed while it was being opened; /);
      assert.equal(fs.readFileSync(fx.secret, 'utf8'), stateShapes.SECRET, 'the outside file must be unchanged');
    });
  }

  test('a new file created concurrently at open is not overwritten (O_EXCL)', (t) => {
    const fx = stateShapes.buildFixture(t);
    const target = path.join(fx.planning, 'race-new.md');
    const io = createStateIO({ io: 'filesystem' }, { root: fx.planning });
    swapAtOpen(t, target, () => fs.writeFileSync(target, 'CONCURRENT\n'));
    assert.throws(() => io.write(target, stateShapes.PAYLOAD), /^Error: filesystem stateIO write failed: EEXIST$/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'CONCURRENT\n');
  });

  test('a file swapped to a hard link of an outside file at open is caught on the descriptor', (t) => {
    const fx = stateShapes.buildFixture(t);
    const io = createStateIO({ io: 'filesystem' }, { root: fx.planning });
    let linked = false;
    swapAtOpen(t, fx.state, () => {
      fs.unlinkSync(fx.state);
      try { fs.linkSync(fx.secret, fx.state); linked = true; } catch { fs.writeFileSync(fx.state, stateShapes.IN); }
    });
    let err = null;
    try { io.write(fx.state, stateShapes.PAYLOAD); } catch (e) { err = e; }
    if (!linked) { t.skip('cannot create a hard link here'); return; }
    assert.ok(err instanceof Error, 'write must throw');
    assert.match(err.message, /^filesystem stateIO write refused: the opened file has more than one hard link; /);
    assert.equal(fs.readFileSync(fx.secret, 'utf8'), stateShapes.SECRET, 'the outside file must be unchanged');
  });

  test('a file swapped to a directory at open is caught on the descriptor', (t) => {
    if (process.platform === 'win32') { t.skip('a directory cannot be opened as a file on Windows'); return; }
    const fx = stateShapes.buildFixture(t);
    const io = createStateIO({ io: 'filesystem' }, { root: fx.planning });
    swapAtOpen(t, fx.state, () => { fs.unlinkSync(fx.state); fs.mkdirSync(fx.state); });
    assert.throws(() => io.read(fx.state), /^Error: filesystem stateIO read refused: the opened path is not a regular file; /);
  });

  test('fs errors are reported by code without the absolute path', (t) => {
    const fx = stateShapes.buildFixture(t);
    const io = createStateIO({ io: 'filesystem' }, { root: fx.planning });
    assert.throws(() => io.read(path.join(fx.planning, 'absent.md')), /^Error: filesystem stateIO read failed: ENOENT$/);
  });

  test('confineStatePath is exported and returns the real in-root path', (t) => {
    const fx = stateShapes.buildFixture(t);
    assert.strictEqual(confineStatePath(fx.state, fx.planning, 'probe'), fx.state);
    assert.throws(() => confineStatePath(fx.secret, fx.planning, 'probe'), /^Error: probe refused: /);
  });
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
