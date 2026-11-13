'use strict';
/**
 * Platform-sensitive tests split out of tests/state-io.test.cjs (#5120).
 *
 * scripts/gen-platform-conformance-tier.cjs selects whole files for the real-OS
 * (Windows/macOS) conformance tier. The rows below carry the platform signal, so they
 * live here; tests/state-io.test.cjs stays signal-free.
 *
 * #5120 review (M1): the filesystem stateIO adapter's STATE.md branch is documented
 * (src/state-io.cts header, docs/how-to/connect-gsd-mcp-server.md) to refuse a
 * STATE.md that is a symlink, a FIFO or a device with a tool error. The write seam
 * it calls does not: its atomic path replaces whatever sits at the target by rename,
 * so a symlinked STATE.md was silently replaced by a regular file while the link's
 * real target kept its old bytes, and a FIFO was replaced the same way. The adapter
 * now refuses any existing STATE.md that is not a regular file, under the STATE.md
 * lock, and writes nothing.
 *
 * Rows and why each lives here:
 * - the symlink rows: `fs.symlinkSync` needs privileges on Windows (process-platform).
 *   Without them the row records a skip and asserts the platform is win32.
 * - the FIFO row: there is no FIFO on Windows; `mkfifo` is a child process
 *   (process-platform, raw-child-process). On win32 it skips with a counted assertion
 *   that the platform is win32, so it can never pass on POSIX with zero assertions.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createStateIO } = require('../gsd-core/bin/lib/state-io.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { runHook, assertSeamExit } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const REFUSAL = (err) => err.code === 'ENXIO' && /STATE\.md/.test(err.message) && /not a regular file/.test(err.message);

/** lstat type of `p` as a word, so an assertion message names what is there. */
function kindOf(p) {
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isFIFO()) return 'fifo';
  if (st.isFile()) return 'file';
  return 'other';
}

/** Try a symlink; on Windows without the privilege report false (the caller asserts win32). */
function trySymlink(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath);
    return true;
  } catch (err) {
    if (process.platform === 'win32' && (err.code === 'EPERM' || err.code === 'EACCES')) return false;
    throw err;
  }
}

test('filesystem stateIO: a symlinked STATE.md is refused and neither the link nor its target is written (#5120 review M1)', (t) => {
  const dir = createTempDir('state-io-5120-link-');
  t.after(() => cleanup(dir));
  const realDir = path.join(dir, 'real');
  fs.mkdirSync(realDir);
  const target = path.join(realDir, 'target.md');
  fs.writeFileSync(target, 'orig\n');
  const planning = path.join(dir, '.planning');
  fs.mkdirSync(planning);
  const file = path.join(planning, 'STATE.md');
  if (!trySymlink(path.relative(planning, target), file)) {
    assert.equal(process.platform, 'win32', 'only Windows without the symlink privilege may skip this row');
    t.skip('fs.symlinkSync needs a privilege on this Windows host');
    return;
  }

  assert.throws(() => createStateIO({ io: 'filesystem' }).write(file, '# new\n'), REFUSAL);
  assert.equal(kindOf(file), 'symlink', 'STATE.md is still the symlink');
  assert.equal(fs.readlinkSync(file), path.relative(planning, target), 'the link still points where it did');
  assert.equal(fs.readFileSync(target, 'utf8'), 'orig\n', 'the link target keeps its bytes');
  assert.equal(fs.existsSync(`${file}.lock`), false, 'the lock is released');
});

test('filesystem stateIO: a dangling-symlink STATE.md is refused and nothing is created (#5120 review M1)', (t) => {
  const dir = createTempDir('state-io-5120-dangling-');
  t.after(() => cleanup(dir));
  const file = path.join(dir, 'STATE.md');
  const missing = path.join(dir, 'nowhere', 'target.md');
  if (!trySymlink(missing, file)) {
    assert.equal(process.platform, 'win32', 'only Windows without the symlink privilege may skip this row');
    t.skip('fs.symlinkSync needs a privilege on this Windows host');
    return;
  }

  assert.throws(() => createStateIO({ io: 'filesystem' }).write(file, '# new\n'), REFUSAL);
  assert.equal(kindOf(file), 'symlink', 'STATE.md is still the dangling symlink');
  assert.equal(fs.existsSync(missing), false, 'nothing is created through the link');
  assert.equal(fs.existsSync(`${file}.lock`), false, 'the lock is released');
});

test('filesystem stateIO: a FIFO STATE.md is refused without blocking and stays a FIFO (#5120 review M1)', (t) => {
  if (process.platform === 'win32') {
    assert.equal(process.platform, 'win32', 'the FIFO row skips on Windows only');
    t.skip('no FIFOs on Windows');
    return;
  }
  const dir = createTempDir('state-io-5120-fifo-');
  t.after(() => cleanup(dir));
  const file = path.join(dir, 'STATE.md');
  // Throws when mkfifo fails, so on POSIX the row never passes without a real FIFO.
  assertSeamExit(assert, runHook(file, [], { interpreter: 'mkfifo', timeoutMs: PROBE_TIMEOUT_MS }), 0, 'mkfifo');
  assert.equal(kindOf(file), 'fifo', 'precondition: STATE.md is a FIFO');

  assert.throws(() => createStateIO({ io: 'filesystem' }).write(file, '# new\n'), REFUSAL);
  assert.equal(kindOf(file), 'fifo', 'STATE.md is still the FIFO, not replaced by a regular file');
  assert.equal(fs.existsSync(`${file}.lock`), false, 'the lock is released');
});

// The how-to (docs/how-to/connect-gsd-mcp-server.md) promises a tool error, not a
// protocol error and not ok:true, for a symlinked STATE.md written through MCP.
test('tools/call gsd_write_state: a symlinked STATE.md returns a tool error and the link target keeps its bytes (#5120 review M1)', (t) => {
  const { handleMessage } = require('../gsd-core/bin/lib/mcp-server.cjs');
  const dir = createTempDir('mcp-5120-link-');
  t.after(() => cleanup(dir));
  const target = path.join(dir, 'shared.md');
  fs.writeFileSync(target, 'shared\n');
  const file = path.join(dir, 'STATE.md');
  if (!trySymlink(target, file)) {
    assert.equal(process.platform, 'win32', 'only Windows without the symlink privilege may skip this row');
    t.skip('fs.symlinkSync needs a privilege on this Windows host');
    return;
  }

  const res = handleMessage({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'gsd_write_state', arguments: { path: file, content: '# new\n' } } });
  assert.equal(res.error, undefined, 'a tool error, not a JSON-RPC protocol error');
  assert.equal(res.result.isError, true, 'the tool call reports an error');
  assert.match(res.result.content[0].text, /^Tool error: ENXIO: .*STATE\.md is not a regular file \(it is a symlink\)/);
  assert.equal(kindOf(file), 'symlink', 'STATE.md is still the symlink');
  assert.equal(fs.readFileSync(target, 'utf8'), 'shared\n', 'the shared file keeps its bytes');
});
