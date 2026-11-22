/**
 * Process-contract cases of the custom phase reader suite (#6334, ADR-6315
 * item 16). Each case here is about what a separate process does, which is why
 * it spawns one: how an `ExitError` becomes an exit code and a JSON error on
 * stderr, and that a reader does not block on a named pipe. The logic cases
 * live in tests/custom-phase-readers.test.cjs and run in-process.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { createCustomPhaseProject: fixture, cleanup, homeSandboxEnv } = require('./helpers.cjs');
const processSeam = require('./helpers/process-seam.cjs');

test('phase directory collision: shared batch preflight refuses distinct ids mapping to one target', () => {
  const cwd = fixture(null);
  try {
    // CLI batches derive IDs from titles; exercise the exported writer seam's
    // explicit entry shape used by every writer without patching global I/O.
    const lib = path.resolve(__dirname, '../gsd-core/bin/lib');
    const script = `const {setJsonErrorMode} = require(${JSON.stringify(path.join(lib, 'io.cjs'))}); setJsonErrorMode(true);
      const {ExitError} = require(${JSON.stringify(path.join(lib, 'cli-exit.cjs'))});
      const locator = require(${JSON.stringify(path.join(lib, 'phase-locator.cjs'))});
      try { locator.createPhaseDirectories(${JSON.stringify(cwd)}, [{id:'A',slug:'b-x'}, {id:'A-b',slug:'x'}], locator.phaseDirectoryOptions(${JSON.stringify(cwd)})); }
      catch (cause) { if (cause instanceof ExitError) process.exitCode = cause.code; else throw cause; }`;
    const result = processSeam.runNode(['-e', script], {
      timeoutMs: PROBE_TIMEOUT_MS, env: {...process.env, ...homeSandboxEnv(cwd)},
    });
    assert.notEqual(result.exitCode, 0, result.stdout);
    assert.equal(JSON.parse(result.stderr).reason, 'phase_id_collision');
    assert.deepEqual(fs.readdirSync(path.join(cwd, '.planning/phases')), []);
  } finally { cleanup(cwd); }
});

for (const kind of ['oversized', 'symlink', 'fifo']) {
  test(`identity marker safety: ignores ${kind} without an unbounded read`, {skip: kind === 'fifo' && process.platform === 'win32'}, () => {
    const cwd = fixture(null);
    try {
      const dir = path.join(cwd, '.planning/phases/AUTH-boundary');
      fs.mkdirSync(dir);
      const marker = path.join(dir, '.phase-id');
      if (kind === 'oversized') fs.writeFileSync(marker, 'AUTH' + ' '.repeat(1024));
      else if (kind === 'symlink') {
        const target = path.join(cwd, 'identity.txt');
        fs.writeFileSync(target, 'AUTH');
        fs.symlinkSync(target, marker);
      } else {
        const fifo = processSeam.runHook(marker, [], {interpreter: 'mkfifo', timeoutMs: PROBE_TIMEOUT_MS});
        assert.equal(fifo.exitCode, 0, fifo.stderr);
      }
      const script = `const locator = require(${JSON.stringify(require.resolve('../gsd-core/bin/lib/phase-locator.cjs'))}); process.stdout.write(JSON.stringify(locator.phaseDirectoryOptions(process.cwd(), {phase_naming:'custom'}, '').directoryIds));`;
      const result = processSeam.runNode(['-e', script], {
        cwd, env: {...process.env, ...homeSandboxEnv(cwd)}, timeoutMs: PROBE_TIMEOUT_MS,
      });
      assert.equal(result.exitCode, 0, JSON.stringify(result));
      assert.deepEqual(JSON.parse(result.stdout), {});
    } finally { cleanup(cwd); }
  });
}
