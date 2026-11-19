'use strict';

/**
 * #6332 (ADR-6315 item 14): the gsd-tools CLI is callable in-process.
 *
 * runInProcess(main, { argv, cwd, env }) runs a CLI main the way the binary
 * does, resolves to { exitCode, stdout, stderr }, writes nothing to the real
 * streams and leaves process state as it found it. runCli is gsd-tools' own
 * main behind that seam. Everything here runs in this process; the one case
 * that needs a fresh process is in in-process-cli.process.test.cjs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const {
  runInProcess, IN_PROCESS_REASON, DEFAULT_MAX_BUFFER_BYTES,
} = require('../gsd-core/bin/lib/in-process-cli.cjs');
const {
  registerInvocationReset, unregisterInvocationReset, invocationResetNames,
} = require('../gsd-core/bin/lib/invocation-scope.cjs');
const { ExitError, terminateNow } = require('../gsd-core/bin/lib/cli-exit.cjs');
const { loadConfig } = require('../gsd-core/bin/lib/config-loader.cjs');
const { runCli } = require('../gsd-core/bin/gsd-tools.cjs');

const CELL = Symbol.for('gsd.test.in-process-cell');

/** Everything runInProcess promises to leave alone. */
function processState() {
  return {
    argv: [...process.argv],
    cwd: process.cwd(),
    env: { ...process.env },
    exitCode: process.exitCode,
    writeSync: fs.writeSync,
    stdoutWrite: process.stdout.write,
    stderrWrite: process.stderr.write,
    exit: process.exit,
    cell: globalThis[CELL],
  };
}

function tempDir(t) {
  const dir = fs.realpathSync(createTempDir('gsd-in-process-'));
  t.after(() => cleanup(dir));
  return dir;
}

test('runInProcess captures both streams and reports the exit code (#6332)', async (t) => {
  await t.test('fs.writeSync and stream writes on fd 1 and fd 2 are captured, in order', async () => {
    const result = await runInProcess(() => {
      fs.writeSync(1, 'a');
      process.stdout.write('b');
      fs.writeSync(1, Buffer.from('c'));
      fs.writeSync(2, 'x');
      process.stderr.write('y');
    });

    assert.deepEqual(result, { exitCode: 0, stdout: 'abc', stderr: 'xy' });
  });

  await t.test('a stream write callback still fires', async () => {
    let called = 0;
    await runInProcess(() => {
      process.stdout.write('one', () => { called += 1; });
      process.stderr.write('two', 'utf8', () => { called += 1; });
    });

    assert.equal(called, 2);
  });

  await t.test('a buffer write honours offset and length, in both call forms', async () => {
    const result = await runInProcess(() => {
      assert.equal(fs.writeSync(1, Buffer.from('abcdef'), 2, 2), 2);
      assert.equal(fs.writeSync(2, Buffer.from('abcdef'), { offset: 1, length: 3 }), 3);
      assert.equal(fs.writeSync(1, Buffer.from('xyz'), 1), 2);
    });

    assert.deepEqual(result, { exitCode: 0, stdout: 'cdyz', stderr: 'bcd' });
  });

  await t.test('any ArrayBufferView is written as its bytes', async () => {
    // Each view sits at a non-zero offset inside a larger buffer, so a
    // stand-in that ignored byteOffset or byteLength would write other bytes.
    const backing = new Uint8Array(Buffer.from('__dv__abcd__')).buffer;
    const result = await runInProcess(() => {
      assert.equal(fs.writeSync(1, new DataView(backing, 2, 2)), 2);
      assert.equal(fs.writeSync(1, new Uint16Array(backing, 6, 2)), 4);
      process.stderr.write(new Uint8Array(backing, 2, 2));
    });

    assert.deepEqual(result, { exitCode: 0, stdout: 'dvabcd', stderr: 'dv' });
  });

  await t.test('an offset or length out of range, or data of the wrong type, throws as the real call does', async () => {
    const codes = [];
    const attempt = (fn) => {
      try {
        fn();
        codes.push('no-throw');
      } catch (err) {
        codes.push(err.code);
      }
    };
    const result = await runInProcess(() => {
      const six = Buffer.from('abcdef');
      attempt(() => fs.writeSync(1, six, 6, 0));
      attempt(() => fs.writeSync(1, six, 7));
      attempt(() => fs.writeSync(1, six, -1));
      attempt(() => fs.writeSync(1, six, 5, 1));
      attempt(() => fs.writeSync(1, six, 5, 2));
      attempt(() => fs.writeSync(1, 42));
      attempt(() => process.stdout.write(42));
      attempt(() => fs.writeSync(1, six, '2'));
      attempt(() => process.stdout.write(null));
    });

    assert.deepEqual(codes, [
      'no-throw', 'ERR_OUT_OF_RANGE', 'ERR_OUT_OF_RANGE',
      'no-throw', 'ERR_OUT_OF_RANGE',
      'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_TYPE',
      'ERR_INVALID_ARG_TYPE', 'ERR_STREAM_NULL_VALUES',
    ]);
    assert.deepEqual(result, { exitCode: 0, stdout: 'f', stderr: '' });
  });

  await t.test('null in the offset position is the options form, so a length after it is ignored', async () => {
    const result = await runInProcess(() => {
      assert.equal(fs.writeSync(1, Buffer.from('abcdef'), null, 2), 6);
    });

    assert.deepEqual(result, { exitCode: 0, stdout: 'abcdef', stderr: '' });
  });

  await t.test('a multibyte character split across two writes arrives whole', async () => {
    const euro = Buffer.from('€');
    const result = await runInProcess(() => {
      fs.writeSync(1, euro.subarray(0, 1));
      fs.writeSync(1, euro.subarray(1));
    });

    assert.equal(result.stdout, '€');
  });

  await t.test('a write to any other descriptor goes to that descriptor', async (t2) => {
    const file = path.join(tempDir(t2), 'out.txt');
    const result = await runInProcess(() => {
      const fd = fs.openSync(file, 'w');
      try {
        fs.writeSync(fd, 'to-the-file');
      } finally {
        fs.closeSync(fd);
      }
    });

    assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
    assert.equal(fs.readFileSync(file, 'utf8'), 'to-the-file');
  });

  await t.test('a number return, process.exitCode and an ExitError each set the exit code', async () => {
    assert.equal((await runInProcess(() => 3)).exitCode, 3);
    assert.equal((await runInProcess(() => { process.exitCode = 5; })).exitCode, 5);

    const thrown = await runInProcess(() => { throw new ExitError(4, 'refused'); });
    assert.deepEqual(thrown, { exitCode: 4, stdout: '', stderr: 'refused\n' });
  });

  await t.test('an async main is awaited', async () => {
    const result = await runInProcess(async () => {
      await Promise.resolve();
      fs.writeSync(1, 'late');
      return 6;
    });

    assert.deepEqual(result, { exitCode: 6, stdout: 'late', stderr: '' });
  });

  await t.test('an unexpected throw is exit code 1 with the error on stderr', async () => {
    const result = await runInProcess(() => { throw new TypeError('in-process-unexpected'); });

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.length > 0, 'the error is reported on the captured stderr');
  });
});

test('process.exit ends an in-process call the way it ends a process (#6332)', async (t) => {
  await t.test('it ends the call with that code and does not end this process', async () => {
    const result = await runInProcess(() => {
      fs.writeSync(1, 'before');
      process.exit(7);
    });

    assert.deepEqual(result, { exitCode: 7, stdout: 'before', stderr: '' });
  });

  await t.test('the code keeps its low eight bits, as an exit status does', async () => {
    const codeFor = async (code) => (await runInProcess(() => { process.exit(code); })).exitCode;

    assert.equal(await codeFor(0), 0);
    assert.equal(await codeFor(1), 1);
    assert.equal(await codeFor(254), 254);
    assert.equal(await codeFor(255), 255);
    assert.equal(await codeFor(256), 0);
    assert.equal(await codeFor(-1), 255);
    assert.equal(await codeFor('3'), 3);
    assert.equal(await codeFor('0x10'), 16);
  });

  await t.test('an explicit undefined or null argument replaces process.exitCode, as the real call does', async () => {
    for (const code of [undefined, null]) {
      const result = await runInProcess(() => {
        process.exitCode = 8;
        process.exit(code);
      });
      assert.equal(result.exitCode, 0, `process.exit(${String(code)})`);
    }
  });

  await t.test('a code that is not an integer is an error, not a success', async () => {
    for (const code of ['abc', 1.5, {}, true]) {
      const result = await runInProcess(() => { process.exit(code); });
      assert.equal(result.exitCode, 1, `process.exit(${JSON.stringify(code)}) must not read as 0`);
    }
  });

  await t.test('with no argument it uses process.exitCode', async () => {
    const result = await runInProcess(() => {
      process.exitCode = 8;
      process.exit();
    });

    assert.equal(result.exitCode, 8);
  });

  await t.test('the first code wins when a catch block exits again', async () => {
    const result = await runInProcess(() => {
      try {
        process.exit(4);
      } catch {
        process.exit(9);
      }
    });

    assert.equal(result.exitCode, 4);
  });

  await t.test('nothing written after the exit is captured', async () => {
    const result = await runInProcess(() => {
      fs.writeSync(1, 'kept');
      try {
        process.exit(3);
      } catch {
        fs.writeSync(1, 'dropped');
        process.stderr.write('dropped');
      }
    });

    assert.deepEqual(result, { exitCode: 3, stdout: 'kept', stderr: '' });
  });

  await t.test('a hook deny through terminateNow gives its payload on both streams and nothing else', async () => {
    const payload = { decision: 'block' };
    const result = await runInProcess(() => { terminateNow('HOOK_DENY', payload); });

    assert.equal(result.exitCode, 2);
    assert.deepEqual(JSON.parse(result.stdout), payload);
    assert.deepEqual(JSON.parse(result.stderr), payload);
  });
});

test('runInProcess gives main the argv, cwd and env it was passed (#6332)', async (t) => {
  await t.test('argv is what main reads after the two leading entries', async () => {
    let seen;
    await runInProcess(() => { seen = process.argv.slice(2); }, { argv: ['state', '--raw'] });
    assert.deepEqual(seen, ['state', '--raw']);

    await runInProcess(() => { seen = process.argv.slice(2); }, { argv: [] });
    assert.deepEqual(seen, []);

    await runInProcess(() => { seen = process.argv.slice(2); });
    assert.deepEqual(seen, []);
  });

  await t.test('cwd is the working directory main sees', async (t2) => {
    const dir = tempDir(t2);
    let seen;
    await runInProcess(() => { seen = fs.realpathSync(process.cwd()); }, { cwd: dir });

    assert.equal(seen, dir);
  });

  await t.test('env replaces the environment, it does not merge into it', async (t2) => {
    process.env.GSD_IN_PROCESS_OUTER = 'outer';
    t2.after(() => { delete process.env.GSD_IN_PROCESS_OUTER; });
    let seen;
    await runInProcess(
      () => { seen = { outer: process.env.GSD_IN_PROCESS_OUTER, inner: process.env.GSD_IN_PROCESS_INNER }; },
      { env: { GSD_IN_PROCESS_INNER: 'inner', GSD_IN_PROCESS_UNSET: undefined } },
    );
    assert.deepEqual(seen, { outer: undefined, inner: 'inner' });

    await runInProcess(() => { seen = Object.keys(process.env); }, { env: {} });
    assert.deepEqual(seen, []);
    assert.equal(process.env.GSD_IN_PROCESS_OUTER, 'outer');
  });

  await t.test('passing process.env itself keeps the environment', async (t2) => {
    process.env.GSD_IN_PROCESS_SELF = 'self';
    t2.after(() => { delete process.env.GSD_IN_PROCESS_SELF; });
    const outside = { ...process.env };
    let seen;
    await runInProcess(() => { seen = { ...process.env }; }, { env: process.env });

    assert.deepEqual(seen, outside);
    assert.deepEqual({ ...process.env }, outside);
  });

  await t.test('a gsd.* global cell set outside is not visible inside', async (t2) => {
    globalThis[CELL] = 'outside';
    t2.after(() => { delete globalThis[CELL]; });
    let seen = 'unset';
    await runInProcess(() => { seen = globalThis[CELL]; });

    assert.equal(seen, undefined);
    assert.equal(globalThis[CELL], 'outside');
  });
});

test('runInProcess runs one call at a time (#6332)', async (t) => {
  await t.test('a call made from inside main is refused, and the outer call completes', async () => {
    let nested;
    const outer = await runInProcess(async () => {
      nested = await runInProcess(() => 0).then(() => null, (err) => err);
      return 2;
    });

    assert.equal(nested.code, IN_PROCESS_REASON.REENTRANT);
    assert.equal(outer.exitCode, 2);
  });

  await t.test('code a finished call left behind may call again', async () => {
    let later;
    const first = await runInProcess(() => {
      setImmediate(() => { later = runInProcess(() => 5); });
      return 1;
    });
    await new Promise((resolve) => { setImmediate(resolve); });

    assert.equal(first.exitCode, 1);
    assert.deepEqual(await later, { exitCode: 5, stdout: '', stderr: '' });
  });

  // Found by the first full-suite run of this file: node:test reports to its
  // parent by writing to stdout, and that write landed while an in-process
  // call was suspended at an await. The call captured it and the runner lost
  // it. Only writes made from inside the call's own async context belong to it.
  await t.test('a write made from outside a suspended call goes to the real writer, not the capture', async (t2) => {
    const outside = [];
    const realStderrWrite = process.stderr.write;
    const realWriteSync = fs.writeSync;
    // Only this test's own marker is recorded. Anything else written to
    // stderr while the stubs are installed still goes where it was going.
    const isMarker = (data) => typeof data === 'string' && data.startsWith('in-process-marker:');
    process.stderr.write = function write(chunk, ...rest) {
      if (!isMarker(chunk)) return realStderrWrite.call(this, chunk, ...rest);
      outside.push(`stream:${chunk}`);
      return true;
    };
    fs.writeSync = (fd, data, ...rest) => {
      if (fd !== 2 || !isMarker(data)) return realWriteSync.call(fs, fd, data, ...rest);
      outside.push(`sync:${data}`);
      return data.length;
    };
    t2.after(() => {
      process.stderr.write = realStderrWrite;
      fs.writeSync = realWriteSync;
    });

    let suspended;
    const reachedAwait = new Promise((resolve) => { suspended = resolve; });
    let resume;
    const gate = new Promise((resolve) => { resume = resolve; });

    const running = runInProcess(async () => {
      process.stderr.write('in-process-marker:inside-before;');
      suspended();
      await gate;
      fs.writeSync(2, 'in-process-marker:inside-after;');
    });

    await reachedAwait;
    process.stderr.write('in-process-marker:outside');
    fs.writeSync(2, 'in-process-marker:outside');
    resume();
    const result = await running;

    assert.deepEqual(result, {
      exitCode: 0, stdout: '', stderr: 'in-process-marker:inside-before;in-process-marker:inside-after;',
    });
    assert.deepEqual(outside, ['stream:in-process-marker:outside', 'sync:in-process-marker:outside']);
  });

  // Found by comparing every command in-process against the spawned binary:
  // main wraps its work in io.cts's stdout capture, which layers its own
  // fs.writeSync on top of the call's stand-in and calls back down into it. A
  // write to any other descriptor then went up to the wrapper, down to the
  // stand-in and up again without end ("Maximum call stack size exceeded").
  await t.test('a wrapper layered over a stand-in inside the call still reaches the real function', async (t2) => {
    const file = path.join(tempDir(t2), 'layered.txt');
    const result = await runInProcess(() => {
      const below = fs.writeSync;
      const seenByWrapper = [];
      fs.writeSync = (fd, data, ...rest) => {
        seenByWrapper.push(fd);
        return below.call(fs, fd, data, ...rest);
      };
      try {
        const fd = fs.openSync(file, 'w');
        try {
          fs.writeSync(fd, 'through-the-wrapper');
        } finally {
          fs.closeSync(fd);
        }
        fs.writeSync(1, 'captured');
      } finally {
        fs.writeSync = below;
      }
      return seenByWrapper.length;
    });

    assert.deepEqual(result, { exitCode: 2, stdout: 'captured', stderr: '' });
    assert.equal(fs.readFileSync(file, 'utf8'), 'through-the-wrapper');
  });

  await t.test('a command that writes a file through fs.writeSync runs in-process', async (t2) => {
    const project = tempDir(t2);
    fs.mkdirSync(path.join(project, '.planning'));
    fs.writeFileSync(path.join(project, '.planning', 'STATE.md'), '# State\n');

    const result = await runCli({ argv: ['quick-tasks-migrate', '--cwd', project] });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, migrated: false });
  });

  // The same loop, after the call: a wrapper that was layered over the
  // stand-in outlives the call and is installed again. The stand-in is stale
  // and defers to what is installed, which is the wrapper that calls it.
  await t.test('a wrapper over a stale stand-in, installed again after the call, still reaches the real function', async (t2) => {
    const file = path.join(tempDir(t2), 'stale-layered.txt');
    const real = fs.writeSync;
    let wrapper;
    let wrapperCalls = 0;
    await runInProcess(() => {
      const below = fs.writeSync;
      wrapper = (fd, data, ...rest) => {
        wrapperCalls += 1;
        return below.call(fs, fd, data, ...rest);
      };
    });

    t2.after(() => { fs.writeSync = real; });
    fs.writeSync = wrapper;
    const fd = fs.openSync(file, 'w');
    try {
      assert.equal(fs.writeSync(fd, 'once'), 4);
    } finally {
      fs.closeSync(fd);
      fs.writeSync = real;
    }

    assert.equal(fs.readFileSync(file, 'utf8'), 'once');
    assert.equal(wrapperCalls, 2, 'the wrapper is entered once by the caller and once by the stale stand-in');
  });

  // A module first loaded inside main may keep a reference to a stand-in
  // (`const { exit } = process`). Used during a later call, that stale
  // reference must act for the later call, never reach the real function.
  await t.test('a stand-in kept from an earlier call acts for the call that uses it', async () => {
    let keptExit;
    let keptWriteSync;
    let keptStdoutWrite;
    await runInProcess(() => {
      keptExit = process.exit;
      keptWriteSync = fs.writeSync;
      keptStdoutWrite = process.stdout.write;
    });

    const later = await runInProcess(() => {
      keptWriteSync.call(fs, 1, 'sync;');
      keptStdoutWrite.call(process.stdout, 'stream;');
      keptExit(9);
    });

    assert.deepEqual(later, { exitCode: 9, stdout: 'sync;stream;', stderr: '' });
  });

  await t.test('calls started together queue, and each gets only its own output', async () => {
    const order = [];
    const call = (name, code) => runInProcess(async () => {
      order.push(`${name}:start`);
      fs.writeSync(1, name);
      await Promise.resolve();
      order.push(`${name}:end`);
      return code;
    });

    const results = await Promise.all([call('a', 1), call('b', 2), call('c', 3)]);

    assert.deepEqual(results, [
      { exitCode: 1, stdout: 'a', stderr: '' },
      { exitCode: 2, stdout: 'b', stderr: '' },
      { exitCode: 3, stdout: 'c', stderr: '' },
    ]);
    assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  await t.test('a call that rejects does not block the calls behind it', async (t2) => {
    const missing = path.join(tempDir(t2), 'does-not-exist');
    const [first, second] = await Promise.allSettled([
      runInProcess(() => 0, { cwd: missing }),
      runInProcess(() => 5),
    ]);

    assert.equal(first.status, 'rejected');
    assert.deepEqual(second, { status: 'fulfilled', value: { exitCode: 5, stdout: '', stderr: '' } });
  });
});

test('runInProcess refuses input it cannot honour (#6332)', async (t) => {
  await t.test('argv that is not an array of strings is refused before anything changes', async () => {
    const before = processState();
    for (const argv of ['state', [1], [undefined], { 0: 'state' }]) {
      await assert.rejects(runInProcess(() => 0, { argv }), { code: IN_PROCESS_REASON.INVALID_ARGV });
    }
    assert.deepEqual(processState(), before);
  });

  await t.test('maxBufferBytes that is not a non-negative integer is refused', async () => {
    for (const maxBufferBytes of [-1, 1.5, '10', Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(
        runInProcess(() => 0, { maxBufferBytes }),
        { code: IN_PROCESS_REASON.INVALID_MAX_BUFFER },
      );
    }
    assert.equal(Number.isInteger(DEFAULT_MAX_BUFFER_BYTES) && DEFAULT_MAX_BUFFER_BYTES > 0, true);
  });

  await t.test('output at the buffer limit is returned; one byte over is refused', async () => {
    const limit = 16;
    const write = (bytes, fd = 1) => runInProcess(
      () => { fs.writeSync(fd, 'x'.repeat(bytes)); },
      { maxBufferBytes: limit },
    );

    assert.equal((await write(limit - 1)).stdout.length, limit - 1);
    assert.equal((await write(limit)).stdout.length, limit);
    await assert.rejects(write(limit + 1), { code: IN_PROCESS_REASON.OUTPUT_OVERFLOW });
    await assert.rejects(
      runInProcess(() => { fs.writeSync(1, 'x'.repeat(limit + 1)); return 7; }, { maxBufferBytes: limit }),
      { code: IN_PROCESS_REASON.OUTPUT_OVERFLOW, exitCode: 7 },
    );
    assert.equal((await write(limit, 2)).stderr.length, limit);
    await assert.rejects(write(limit + 1, 2), { code: IN_PROCESS_REASON.OUTPUT_OVERFLOW });
    assert.deepEqual(await runInProcess(() => 0, { maxBufferBytes: 0 }), { exitCode: 0, stdout: '', stderr: '' });
  });

  await t.test('a cwd that does not exist rejects and restores everything', async (t2) => {
    const before = processState();
    const missing = path.join(tempDir(t2), 'does-not-exist');

    await assert.rejects(runInProcess(() => 0, { cwd: missing }));
    assert.deepEqual(processState(), before);
  });

  await t.test('the codes are the contract', () => {
    assert.deepEqual({ ...IN_PROCESS_REASON }, {
      REENTRANT: 'in_process_reentrant',
      INVALID_ARGV: 'in_process_invalid_argv',
      INVALID_MAX_BUFFER: 'in_process_invalid_max_buffer',
      OUTPUT_OVERFLOW: 'in_process_output_overflow',
      RESET_FAILED: 'in_process_reset_failed',
      RESTORE_FAILED: 'in_process_restore_failed',
    });
    assert.equal(Object.isFrozen(IN_PROCESS_REASON), true);
  });
});

test('a restore step that fails does not stop the other restores (#6332)', async (t) => {
  const before = processState();
  const realChdir = process.chdir;
  t.after(() => { process.chdir = realChdir; });
  globalThis[CELL] = 'outside';
  t.after(() => { delete globalThis[CELL]; });
  const withCell = processState();

  // main breaks the one call the restore needs to put the working directory
  // back, then changes everything else a call can change.
  const failed = await runInProcess(() => {
    process.chdir = () => { throw new Error('in-process-chdir-broken'); };
    process.env.GSD_IN_PROCESS_LEAK = 'leak';
    process.exitCode = 9;
    globalThis[CELL] = 'inside';
  }, { argv: ['x'], env: { GSD_IN_PROCESS_ONLY: '1' } }).then(() => null, (err) => err);
  process.chdir = realChdir;

  assert.equal(failed.code, IN_PROCESS_REASON.RESTORE_FAILED);
  assert.equal(failed.cause instanceof AggregateError, true);
  assert.equal(failed.cause.errors.length, 1, 'one restore step failed');
  assert.deepEqual(processState(), withCell, 'every other restore still ran');

  const next = await runInProcess(() => 4);
  assert.equal(next.exitCode, 4, 'the next call is not blocked');

  delete globalThis[CELL];
  assert.deepEqual(processState(), before);
});

test('module-level caches are reset around every in-process call (#6332)', async (t) => {
  await t.test('a registered reset runs before and after each call', async () => {
    let resets = 0;
    let seenInside;
    registerInvocationReset('test.in-process-counter', () => { resets += 1; });
    t.after(() => { unregisterInvocationReset('test.in-process-counter'); });

    await runInProcess(() => { seenInside = resets; });
    assert.equal(seenInside, 1, 'reset before main ran');
    assert.equal(resets, 2, 'and again after it');

    await runInProcess(() => { process.exit(1); });
    assert.equal(resets, 4);

    assert.equal(unregisterInvocationReset('test.in-process-counter'), true);
    assert.equal(unregisterInvocationReset('test.in-process-counter'), false);
    assert.equal(invocationResetNames().includes('test.in-process-counter'), false);
    await runInProcess(() => 0);
    assert.equal(resets, 4, 'an unregistered reset no longer runs');
  });

  await t.test('a reset that fails before main refuses the call, runs nothing and restores everything', async (t2) => {
    const before = processState();
    let mainRan = false;
    registerInvocationReset('test.in-process-throwing', () => { throw new Error('in-process-reset-broken'); });
    t2.after(() => { unregisterInvocationReset('test.in-process-throwing'); });

    await assert.rejects(
      runInProcess(() => { mainRan = true; }, { argv: ['x'], env: { GSD_IN_PROCESS_ONLY: '1' } }),
      { code: IN_PROCESS_REASON.RESET_FAILED },
    );
    assert.equal(mainRan, false);
    assert.deepEqual(processState(), before);

    unregisterInvocationReset('test.in-process-throwing');
    assert.equal((await runInProcess(() => 6)).exitCode, 6, 'the next call is not blocked');
  });

  await t.test('the modules with per-invocation state are registered', () => {
    require('../gsd-core/bin/lib/state.cjs');
    require('../gsd-core/bin/lib/capability-activation.cjs');
    require('../gsd-core/bin/lib/model-resolver.cjs');
    require('../gsd-core/bin/lib/unusable-input.cjs');
    const names = invocationResetNames();

    for (const name of [
      'state.diskScanCache',
      'config-loader.warnings',
      'config-loader.gitIgnoredCache',
      'capability-activation.warnedRawConfigPaths',
      'model-resolver.unmappableWarnings',
      'unusable-input.warnedInputs',
    ]) {
      assert.ok(names.includes(name), `${name} is not registered; registered: ${names.join(', ')}`);
    }
  });

  // loadConfig warns once per process about an unknown config key. Two
  // in-process calls are two invocations, so each must warn as the first one
  // did; two loads inside one call are one invocation and warn once.
  await t.test('a once-per-invocation config warning is given on every call', async (t2) => {
    const project = tempDir(t2);
    const home = tempDir(t2);
    fs.mkdirSync(path.join(project, '.planning'));
    fs.writeFileSync(path.join(project, '.planning', 'config.json'), JSON.stringify({ in_process_unknown_key_6332: true }));
    const env = { ...process.env, HOME: home, USERPROFILE: home };

    const twiceInOneCall = await runInProcess(() => { loadConfig(project); loadConfig(project); }, { env });
    const first = await runInProcess(() => { loadConfig(project); }, { env });
    const second = await runInProcess(() => { loadConfig(project); }, { env });

    assert.ok(first.stderr.length > 0, 'the unknown key is warned about');
    assert.equal(second.stderr, first.stderr, 'the second call warns exactly as the first did');
    assert.equal(twiceInOneCall.stderr, first.stderr, 'two loads in one call warn once');
  });
});

// The invariant (CONTEXT.md, RULESET.TESTS.property-based-testing): whatever
// main does to process state, and however it ends, the state after the call
// equals the state before it, and the call reports exactly what main wrote
// and the code it ended with. Each generated main performs a random sequence
// of the things a CLI can do.
test('any in-process call restores process state and reports what main did (#6332)', async (t) => {
  const dir = tempDir(t);
  const text = fc.stringMatching(/^[a-z0-9 ]{0,8}$/);
  const code = fc.integer({ min: 0, max: 255 });
  const step = fc.oneof(
    fc.record({ kind: fc.constant('stdout'), text }),
    fc.record({ kind: fc.constant('stderr'), text }),
    fc.record({ kind: fc.constant('exitCode'), code }),
    fc.record({ kind: fc.constant('chdir') }),
    fc.record({ kind: fc.constant('setEnv'), value: text }),
    fc.record({ kind: fc.constant('deleteEnv') }),
    fc.record({ kind: fc.constant('argv') }),
    fc.record({ kind: fc.constant('cell') }),
  );
  const ending = fc.oneof(
    fc.record({ kind: fc.constant('return') }),
    fc.record({ kind: fc.constant('number'), code }),
    fc.record({ kind: fc.constant('exit'), code }),
    fc.record({ kind: fc.constant('exitError'), code }),
    fc.record({ kind: fc.constant('throw') }),
  );

  function mainFor(steps, end) {
    return () => {
      for (const s of steps) {
        if (s.kind === 'stdout') fs.writeSync(1, s.text);
        else if (s.kind === 'stderr') process.stderr.write(s.text);
        else if (s.kind === 'exitCode') process.exitCode = s.code;
        else if (s.kind === 'chdir') process.chdir(dir);
        else if (s.kind === 'setEnv') process.env.GSD_IN_PROCESS_PROP = s.value;
        else if (s.kind === 'deleteEnv') delete process.env.PATH;
        else if (s.kind === 'argv') process.argv.push('--mutated');
        else globalThis[CELL] = 'inside';
      }
      if (end.kind === 'number') return end.code;
      if (end.kind === 'exit') process.exit(end.code);
      if (end.kind === 'exitError') throw new ExitError(end.code);
      if (end.kind === 'throw') throw new Error('in-process-property');
      return undefined;
    };
  }

  // The oracle, written from the documented rules and not from the code.
  function expected(steps, end) {
    const written = (kind) => steps.filter((s) => s.kind === kind).map((s) => s.text).join('');
    const lastExitCode = steps.filter((s) => s.kind === 'exitCode').map((s) => s.code).pop() ?? 0;
    if (end.kind === 'return') return { exitCode: lastExitCode, stdout: written('stdout'), stderr: written('stderr') };
    if (end.kind === 'throw') return { exitCode: 1, stdout: written('stdout'), stderrPrefix: written('stderr') };
    return { exitCode: end.code, stdout: written('stdout'), stderr: written('stderr') };
  }

  const seen = { exit: 0, throw: 0, mutated: 0 };
  await fc.assert(fc.asyncProperty(
    fc.array(fc.tuple(fc.array(step, { maxLength: 6 }), ending), { minLength: 1, maxLength: 4 }),
    async (calls) => {
      const before = processState();
      for (const [steps, end] of calls) {
        if (end.kind === 'exit') seen.exit += 1;
        if (end.kind === 'throw') seen.throw += 1;
        if (steps.length > 0) seen.mutated += 1;

        const result = await runInProcess(mainFor(steps, end), { argv: ['x'] });
        const want = expected(steps, end);

        assert.equal(result.exitCode, want.exitCode);
        assert.equal(result.stdout, want.stdout);
        if (want.stderr !== undefined) assert.equal(result.stderr, want.stderr);
        else assert.equal(result.stderr.slice(0, want.stderrPrefix.length), want.stderrPrefix);
        assert.deepEqual(processState(), before);
      }
    },
  ), { numRuns: 100 });

  assert.ok(
    seen.exit > 0 && seen.throw > 0 && seen.mutated > 0,
    `the property must exercise every ending, saw ${JSON.stringify(seen)}`,
  );
});

test('runCli runs gsd-tools in-process (#6332)', async (t) => {
  await t.test('a command prints its result and exits 0', async () => {
    const result = await runCli({ argv: ['generate-slug', 'Hello World'] });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { slug: 'hello-world' });
  });

  await t.test('an unknown command exits 1 with a typed reason under --json-errors', async () => {
    const result = await runCli({ argv: ['--json-errors', 'no-such-command-6332'] });

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).reason, 'sdk_unknown_command');
  });

  await t.test('--json-errors on one call does not carry into the next', async () => {
    await runCli({ argv: ['--json-errors', 'no-such-command-6332'] });
    const plain = await runCli({ argv: ['no-such-command-6332'] });

    assert.equal(plain.exitCode, 1);
    assert.throws(() => JSON.parse(plain.stderr), SyntaxError);
  });

  await t.test('a caller cannot change the script path the CLI sees', async () => {
    const result = await runCli({ argv: ['generate-slug', 'Path'], scriptPath: 'not-the-cli' });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), { slug: 'path' });
  });

  await t.test('a run of calls leaves process state as it was', async () => {
    const before = processState();

    await runCli({ argv: ['generate-slug', 'One'] });
    await runCli({ argv: ['no-such-command-6332'] });
    await runCli({ argv: ['--cwd', path.join(before.cwd, 'no-such-dir-6332'), 'generate-slug', 'Two'] });

    assert.deepEqual(processState(), before);
  });
});
