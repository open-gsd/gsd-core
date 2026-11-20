'use strict';

/**
 * #6332 (ADR-6315 item 14): the gsd-tools CLI is callable in-process.
 *
 * runInProcess(main, { argv, cwd, env }) runs a CLI main the way the binary
 * does, resolves to { exitCode, stdout, stderr }, writes nothing to the real
 * streams and leaves process state as it found it. runCli is gsd-tools' own
 * main behind that seam. Everything here runs in this process; the one case
 * that needs a fresh process is in in-process-cli.process.test.cjs.
 *
 * #6333 (ADR-6315 item 15): runInProcessSync is the same seam for a main that
 * finishes before it returns, and runGsdTools calls gsd-tools through it. A
 * main that turns out to be asynchronous is refused, never half-run. That an
 * in-process call gives the result the spawned binary gives is proved in
 * cli-parity.process.test.cjs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const helpers = require('./helpers.cjs');
const processSeam = require('./helpers/process-seam.cjs');

const {
  createTempDir, cleanup, runGsdTools, runGsdToolsAsync, runGsdToolsProcess, SPAWNED_MAX_BUFFER_BYTES, TOOLS_PATH,
} = helpers;

const {
  runInProcess, runInProcessSync, IN_PROCESS_REASON, DEFAULT_MAX_BUFFER_BYTES,
} = require('../gsd-core/bin/lib/in-process-cli.cjs');
const {
  registerInvocationReset, unregisterInvocationReset, invocationResetNames,
} = require('../gsd-core/bin/lib/invocation-scope.cjs');
const { ExitError, terminateNow } = require('../gsd-core/bin/lib/cli-exit.cjs');
const { loadConfig } = require('../gsd-core/bin/lib/config-loader.cjs');
const {
  runCli, runCliSync, asyncHostCommandNames, HOST_COMMAND_ROUTERS,
} = require('../gsd-core/bin/gsd-tools.cjs');

const CELL = Symbol.for('gsd.test.in-process-cell');

/** Everything runInProcess promises to leave alone. */
function processState() {
  return {
    argv: [...process.argv],
    cwd: process.cwd(),
    env: { ...process.env },
    exitCode: process.exitCode,
    writeSync: fs.writeSync,
    readSync: fs.readSync,
    readFileSync: fs.readFileSync,
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

  // After the call: a wrapper that was layered over the stand-in outlives the
  // call and is installed again. The stand-in is stale and goes down to what
  // it replaced, so the wrapper is entered once and nothing calls it again.
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
    assert.equal(wrapperCalls, 1, 'the stale stand-in goes down to what it replaced, never back up to the wrapper');
  });

  // The wrapper is still installed when a LATER call opens, so that call's
  // stand-in replaces the wrapper and forwards down to it; the wrapper calls
  // the earlier call's stale stand-in, which offers the write to the open call
  // and, declined, goes down again. Nothing may send it back up.
  await t.test('a wrapper over a stale stand-in that is still installed when the next call opens', async (t2) => {
    const file = path.join(tempDir(t2), 'stale-under-next.txt');
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
    let result;
    try {
      result = await runInProcess(() => {
        const fd = fs.openSync(file, 'w');
        try {
          fs.writeSync(fd, 'to-the-file');
        } finally {
          fs.closeSync(fd);
        }
        fs.writeSync(1, 'captured');
        // The stale stand-in, reached through the wrapper from inside this
        // call, acts for this call: the write is captured, not printed.
        wrapper(2, 'through-the-stale-one');
      });
      assert.equal(fs.writeSync, wrapper, 'the call puts back what it found installed');
    } finally {
      fs.writeSync = real;
    }

    assert.deepEqual(result, { exitCode: 0, stdout: 'captured', stderr: 'through-the-stale-one' });
    assert.equal(fs.readFileSync(file, 'utf8'), 'to-the-file');
    assert.equal(wrapperCalls, 2, 'once for the file write forwarded down, once called directly');
  });

  // The same with a wrapper that calls down after an await: the stale
  // stand-in is entered later, and still goes down.
  await t.test('a stale asynchronous wrapper installed again after the call still reaches the real function', async (t2) => {
    const file = path.join(tempDir(t2), 'stale-async.txt');
    const real = fs.writeSync;
    let wrapper;
    let wrapperCalls = 0;
    await runInProcess(() => {
      const below = fs.writeSync;
      wrapper = async (fd, data, ...rest) => {
        wrapperCalls += 1;
        if (wrapperCalls > 5) throw new Error('the wrapper and the stale stand-in are calling each other');
        await null;
        return below.call(fs, fd, data, ...rest);
      };
    });

    t2.after(() => { fs.writeSync = real; });
    fs.writeSync = wrapper;
    const fd = fs.openSync(file, 'w');
    try {
      assert.equal(await fs.writeSync(fd, 'once'), 4);
    } finally {
      fs.writeSync = real;
      fs.closeSync(fd);
    }

    assert.equal(fs.readFileSync(file, 'utf8'), 'once');
    assert.equal(wrapperCalls, 1);
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

  // The other half: the same stale references used from OUTSIDE the later
  // call, while it is suspended. They belong to nobody's call, so they reach
  // the real writer and the later call captures nothing of them.
  await t.test('a stand-in kept from an earlier call, used outside a later suspended call, reaches the real writer', async (t2) => {
    const outside = [];
    const realStderrWrite = process.stderr.write;
    const realWriteSync = fs.writeSync;
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

    let keptWriteSync;
    let keptStderrWrite;
    await runInProcess(() => {
      keptWriteSync = fs.writeSync;
      keptStderrWrite = process.stderr.write;
    });

    let suspended;
    const reachedAwait = new Promise((resolve) => { suspended = resolve; });
    let resume;
    const gate = new Promise((resolve) => { resume = resolve; });
    const running = runInProcess(async () => {
      suspended();
      await gate;
      keptWriteSync.call(fs, 2, 'in-process-marker:inside;');
    });

    await reachedAwait;
    keptWriteSync.call(fs, 2, 'in-process-marker:stale-outside');
    keptStderrWrite.call(process.stderr, 'in-process-marker:stale-outside');
    resume();

    assert.deepEqual(await running, { exitCode: 0, stdout: '', stderr: 'in-process-marker:inside;' });
    assert.deepEqual(outside, ['sync:in-process-marker:stale-outside', 'stream:in-process-marker:stale-outside']);
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
      INVALID_OPTION: 'in_process_invalid_option',
      OUTPUT_OVERFLOW: 'in_process_output_overflow',
      BUSY: 'in_process_busy',
      ASYNC_COMMAND: 'in_process_async_command',
      ASYNC_STARTED: 'in_process_async_started',
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

// Two commands start asynchronous work in their router (they read session
// files as streams). The binary waits for it because the event loop is not
// empty; an in-process call has to wait for it too, or it returns before the
// command has written anything and the output lands on the real stdout later.
test('runCli waits for a command whose router finishes asynchronously (#6332)', async (t) => {
  function sessions(t2) {
    const dir = tempDir(t2);
    fs.mkdirSync(path.join(dir, 'proj'));
    fs.writeFileSync(path.join(dir, 'proj', 's1.jsonl'), `${JSON.stringify({
      type: 'user',
      userType: 'external',
      message: { role: 'user', content: 'hello there friend' },
      timestamp: '2026-01-01T00:00:00Z',
    })}\n`);
    return dir;
  }
  // The commands write their output file under the temp root; keep it inside the test's directory.
  const env = (dir) => {
    const root = path.join(dir, 'tmp');
    fs.mkdirSync(root, { recursive: true });
    return { ...process.env, TMPDIR: root, TEMP: root, TMP: root };
  };

  await t.test('extract-messages returns its result', async (t2) => {
    const dir = sessions(t2);

    const result = await runCli({ argv: ['extract-messages', 'proj', '--path', dir], env: env(dir) });

    assert.equal(result.exitCode, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.messages_extracted, 1);
    assert.equal(JSON.parse(fs.readFileSync(report.output_file, 'utf8')).content, 'hello there friend');
  });

  await t.test('profile-sample returns its result', async (t2) => {
    const dir = sessions(t2);

    const result = await runCli({ argv: ['profile-sample', '--path', dir], env: env(dir) });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).messages_sampled, 1);
  });

  await t.test('a failure inside the asynchronous work is the call\'s exit code and stderr', async (t2) => {
    const dir = sessions(t2);

    const result = await runCli({ argv: ['extract-messages', 'no-such-project', '--path', dir], env: env(dir) });

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /No project matching "no-such-project"/);
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

function thrownBy(run) {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

test('runInProcessSync returns what a synchronous main did (#6333)', async (t) => {
  await t.test('both streams are captured and a returned number is the exit code', () => {
    const result = runInProcessSync(() => {
      fs.writeSync(1, 'a');
      process.stdout.write('b');
      process.stderr.write('e');
      return 4;
    });

    assert.deepEqual(result, { exitCode: 4, stdout: 'ab', stderr: 'e' });
  });

  await t.test('process.exit ends main with that code and does not end this process', () => {
    assert.deepEqual(
      runInProcessSync(() => { process.exit(3); }),
      { exitCode: 3, stdout: '', stderr: '' },
    );
  });

  await t.test('a thrown ExitError settles as its code and message, as runMain settles it', () => {
    assert.deepEqual(
      runInProcessSync(() => { throw new ExitError(7, 'boom'); }),
      { exitCode: 7, stdout: '', stderr: 'boom\n' },
    );
  });

  await t.test('argv, cwd and env are what main sees, and process state is as it was afterwards', (t2) => {
    const dir = tempDir(t2);
    const before = processState();
    globalThis[CELL] = 'outer';
    t2.after(() => { delete globalThis[CELL]; });
    const withCell = { ...before, cell: 'outer' };

    const result = runInProcessSync(() => {
      globalThis[CELL] = 'inner';
      fs.writeSync(1, JSON.stringify({
        argv: process.argv.slice(2), cwd: process.cwd(), only: process.env.GSD_SYNC_ONLY, path: process.env.PATH,
      }));
    }, { argv: ['one', 'two'], cwd: dir, env: { GSD_SYNC_ONLY: 'yes' } });

    assert.deepEqual(JSON.parse(result.stdout), { argv: ['one', 'two'], cwd: dir, only: 'yes' });
    assert.deepEqual(processState(), withCell);
  });

  await t.test('gives the result the asynchronous form gives, for any output and exit code', async () => {
    await fc.assert(fc.asyncProperty(
      fc.string(), fc.string(), fc.integer({ min: 0, max: 255 }),
      async (out, err, code) => {
        const main = () => {
          fs.writeSync(1, out);
          process.stderr.write(err);
          return code;
        };
        assert.deepEqual(runInProcessSync(main), await runInProcess(main));
      },
    ));
  });

  await t.test('output up to maxBufferBytes is returned; one byte more is refused', () => {
    const write = (text) => () => { fs.writeSync(1, text); };

    assert.equal(runInProcessSync(write('abc'), { maxBufferBytes: 4 }).stdout, 'abc');
    assert.equal(runInProcessSync(write('abcd'), { maxBufferBytes: 4 }).stdout, 'abcd');
    assert.equal(
      thrownBy(() => runInProcessSync(write('abcde'), { maxBufferBytes: 4 }))?.code,
      IN_PROCESS_REASON.OUTPUT_OVERFLOW,
    );
  });

  await t.test('invalid options are refused before main runs', () => {
    let ran = false;
    const error = thrownBy(() => runInProcessSync(() => { ran = true; }, { argv: 'not-an-array' }));

    assert.equal(error?.code, IN_PROCESS_REASON.INVALID_ARGV);
    assert.equal(ran, false);
  });

  // `env: 5` has no entries: applied, it would empty the environment.
  await t.test('an option of the wrong type is refused before anything is changed, in both forms', async () => {
    const before = processState();
    for (const options of [
      { env: 5 }, { env: null }, { env: ['A=1'] }, { cwd: 5 }, { stdin: Buffer.from('x') }, { scriptPath: 1 },
    ]) {
      let ran = false;
      const main = () => { ran = true; };
      assert.equal(thrownBy(() => runInProcessSync(main, options))?.code, IN_PROCESS_REASON.INVALID_OPTION, JSON.stringify(options));
      await assert.rejects(runInProcess(main, options), { code: IN_PROCESS_REASON.INVALID_OPTION });
      assert.equal(ran, false);
    }
    assert.deepEqual(processState(), before);
  });
});

test('runInProcessSync serves standard input from options.stdin (#6333)', async (t) => {
  await t.test('readFileSync(0) gives the text once, then nothing', () => {
    const result = runInProcessSync(() => {
      fs.writeSync(1, `${fs.readFileSync(0, 'utf8')}|${fs.readFileSync(0, 'utf8')}|`);
    }, { stdin: 'héllo' });

    assert.equal(result.stdout, 'héllo||');
  });

  await t.test('without an encoding it gives bytes, and with no stdin option it gives none', () => {
    const result = runInProcessSync(() => {
      const bytes = fs.readFileSync(0);
      fs.writeSync(1, `${Buffer.isBuffer(bytes)}:${bytes.length}`);
    });

    assert.equal(result.stdout, 'true:0');
  });

  await t.test('readSync(0) drains it in the pieces the caller asks for, then reports end of input', () => {
    const result = runInProcessSync(() => {
      const chunk = Buffer.alloc(3);
      const pieces = [];
      let count;
      while ((count = fs.readSync(0, chunk, 0, 3, null)) > 0) pieces.push(chunk.subarray(0, count).toString());
      fs.writeSync(1, JSON.stringify(pieces));
    }, { stdin: 'abcdefg' });

    assert.deepEqual(JSON.parse(result.stdout), ['abc', 'def', 'g']);
  });

  await t.test('readSync(0) refuses an offset or length outside the buffer, as node does, and reads nothing', () => {
    const result = runInProcessSync(() => {
      const chunk = Buffer.alloc(4);
      const codes = [[0, -1], [-1, 2], [5, 1], [0, 5], [1.5, 1], [4, 1]]
        .map(([offset, length]) => thrownBy(() => fs.readSync(0, chunk, offset, length, null))?.code);
      // Nothing was consumed by the refused reads: a negative length must not move the cursor back or forward.
      const count = fs.readSync(0, chunk, 0, 4, null);
      fs.writeSync(1, JSON.stringify({ codes, count, read: chunk.toString() }));
    }, { stdin: 'abcdef' });

    assert.deepEqual(JSON.parse(result.stdout), {
      codes: Array(6).fill('ERR_OUT_OF_RANGE'), count: 4, read: 'abcd',
    });
  });

  await t.test('readSync(0) at the edges of the buffer: a zero length, and an offset at the end', () => {
    const result = runInProcessSync(() => {
      const chunk = Buffer.alloc(4, '.');
      const counts = [fs.readSync(0, chunk, 0, 0, null), fs.readSync(0, chunk, 4, 0, null), fs.readSync(0, chunk, 3, 1, null)];
      fs.writeSync(1, JSON.stringify({ counts, chunk: chunk.toString() }));
    }, { stdin: 'abcdef' });

    assert.deepEqual(JSON.parse(result.stdout), { counts: [0, 0, 1], chunk: '...a' });
  });

  await t.test('reads of anything else are the real reads', (t2) => {
    const file = path.join(tempDir(t2), 'input.txt');
    fs.writeFileSync(file, 'from-disk');

    const result = runInProcessSync(() => {
      const fd = fs.openSync(file, 'r');
      try {
        const chunk = Buffer.alloc(4);
        const count = fs.readSync(fd, chunk, 0, 4, 0);
        fs.writeSync(1, `${fs.readFileSync(file, 'utf8')}|${chunk.subarray(0, count).toString()}`);
      } finally {
        fs.closeSync(fd);
      }
    }, { stdin: 'not-this' });

    assert.equal(result.stdout, 'from-disk|from');
  });
});

test('runInProcessSync refuses what it cannot finish (#6333)', async (t) => {
  await t.test('a main that returns a promise has started work: refused as started, process state restored', async () => {
    const before = processState();
    const pending = Promise.resolve(0);

    const error = thrownBy(() => runInProcessSync(() => {
      fs.writeSync(1, 'discarded');
      return pending;
    }, { argv: ['x'] }));
    await pending;

    assert.equal(error?.code, IN_PROCESS_REASON.ASYNC_STARTED);
    assert.deepEqual(processState(), before);
  });

  await t.test('a rejection of the promise such a main returned is not an unhandled rejection', async (t2) => {
    const unhandled = [];
    const onUnhandled = (reason) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    t2.after(() => { process.off('unhandledRejection', onUnhandled); });

    const error = thrownBy(() => runInProcessSync(() => Promise.reject(new Error('nobody waited'))));
    await new Promise((resolve) => { setImmediate(resolve); });

    assert.equal(error?.code, IN_PROCESS_REASON.ASYNC_STARTED);
    assert.deepEqual(unhandled, []);
  });

  await t.test('a main that refused a command before running it names it: refused as not run', () => {
    const error = thrownBy(() => runInProcessSync(() => {
      globalThis[CELL] = 'the-command';
      throw new ExitError(1);
    }, { asyncRefusalKey: CELL }));

    assert.equal(error?.code, IN_PROCESS_REASON.ASYNC_COMMAND);
    assert.equal(error?.command, 'the-command');
    assert.match(error?.message ?? '', /the-command/);
    assert.equal(globalThis[CELL], undefined, 'the cell does not outlive the call');
  });

  await t.test('a main that reports a command whose work had started: refused as started, with its name', () => {
    const error = thrownBy(() => runInProcessSync(() => {
      globalThis[CELL] = { started: 'the-command' };
      throw new ExitError(1);
    }, { asyncRefusalKey: CELL }));

    assert.equal(error?.code, IN_PROCESS_REASON.ASYNC_STARTED);
    assert.equal(error?.command, 'the-command');
    assert.match(error?.message ?? '', /do not run the command again.*the-command/);
  });

  await t.test('a call from inside a synchronous call is refused as busy; the outer call is unharmed', () => {
    const result = runInProcessSync(() => {
      fs.writeSync(1, 'before;');
      fs.writeSync(1, `${thrownBy(() => runInProcessSync(() => {}))?.code};`);
      fs.writeSync(1, 'after');
    });

    assert.deepEqual(result, { exitCode: 0, stdout: `before;${IN_PROCESS_REASON.BUSY};after`, stderr: '' });
  });

  await t.test('a call while an asynchronous call is open is refused as busy, and works once it has closed', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const open = runInProcess(async () => {
      await gate;
      fs.writeSync(1, 'late');
    });
    await new Promise((resolve) => { setImmediate(resolve); });

    const error = thrownBy(() => runInProcessSync(() => {}));
    release();

    assert.equal(error?.code, IN_PROCESS_REASON.BUSY);
    assert.deepEqual(await open, { exitCode: 0, stdout: 'late', stderr: '' });
    assert.equal(runInProcessSync(() => { fs.writeSync(1, 'ok'); }).stdout, 'ok');
  });
});

test('runCliSync and a router that turns out to be asynchronous (#6333)', async (t) => {
  // A router that is not declared async and is on no list, but returns a
  // promise: its work has started by the time anyone can know.
  function withRouter(t2, router) {
    HOST_COMMAND_ROUTERS['zz-undeclared-async'] = router;
    t2.after(() => { delete HOST_COMMAND_ROUTERS['zz-undeclared-async']; });
  }

  await t.test('the call fails as started, names the command, and the next call works', async (t2) => {
    let finished = false;
    const work = Promise.resolve().then(() => { finished = true; });
    withRouter(t2, () => work);

    const error = thrownBy(() => runCliSync({ argv: ['zz-undeclared-async'] }));

    assert.equal(error?.code, IN_PROCESS_REASON.ASYNC_STARTED);
    assert.equal(error?.command, 'zz-undeclared-async');
    assert.equal(finished, false, 'the call did not wait');
    assert.equal(runCliSync({ argv: ['generate-slug', 'Next Call'] }).exitCode, 0);
    await work;
  });

  await t.test('a rejection of the abandoned work does not become an unhandled rejection', async (t2) => {
    const unhandled = [];
    const onUnhandled = (reason) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    t2.after(() => { process.off('unhandledRejection', onUnhandled); });
    withRouter(t2, () => Promise.reject(new Error('abandoned work failed')));

    assert.equal(thrownBy(() => runCliSync({ argv: ['zz-undeclared-async'] }))?.code, IN_PROCESS_REASON.ASYNC_STARTED);
    // Unhandled rejections are reported after the microtask queue drains.
    await new Promise((resolve) => { setImmediate(resolve); });

    assert.deepEqual(unhandled, []);
  });

  await t.test('a thenable whose then throws is still reported as started', (t2) => {
    withRouter(t2, () => ({ then() { throw new Error('then threw'); } }));

    const error = thrownBy(() => runCliSync({ argv: ['zz-undeclared-async'] }));

    assert.equal(error?.code, IN_PROCESS_REASON.ASYNC_STARTED);
    assert.equal(error?.command, 'zz-undeclared-async');
  });

  // The switch that makes a call synchronous-only belongs to gsd-tools. A
  // global cell of that name, set by anything else, must change nothing.
  await t.test('a global cell cannot make the asynchronous entry refuse an asynchronous command', async (t2) => {
    const cell = Symbol.for('gsd.cli.syncOnly');
    globalThis[cell] = true;
    t2.after(() => { delete globalThis[cell]; });
    withRouter(t2, async () => { fs.writeSync(1, 'ran'); });

    assert.deepEqual(await runCli({ argv: ['zz-undeclared-async'] }), { exitCode: 0, stdout: 'ran', stderr: '' });
  });

  await t.test('the asynchronous entry waits for the same router', async (t2) => {
    let finished = false;
    withRouter(t2, () => Promise.resolve().then(() => { finished = true; }));

    const result = await runCli({ argv: ['zz-undeclared-async'] });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(finished, true);
  });
});

// Module state that was set from the environment when the module loaded: the
// learnings store kept the home directory, and io kept the temp directory, of
// whichever command loaded them first. Both are resolved on each use now.
test('a module default that depends on the environment follows each call (#6333)', async (t) => {
  await t.test('the learnings store follows the home directory', (t2) => {
    const learnings = require('../gsd-core/bin/lib/learnings.cjs');
    for (const home of [tempDir(t2), tempDir(t2)]) {
      const store = runInProcessSync(() => { fs.writeSync(1, learnings.DEFAULT_STORE_DIR); }, {
        env: { ...process.env, HOME: home, USERPROFILE: home },
      }).stdout;
      assert.equal(store, path.join(home, '.gsd', 'knowledge'));
    }
  });

  await t.test('the GSD temp directory follows the temp root', (t2) => {
    const io = require('../gsd-core/bin/lib/io.cjs');
    for (const root of [tempDir(t2), tempDir(t2)]) {
      const result = runInProcessSync(() => {
        io.ensureGsdTempDir();
        fs.writeSync(1, JSON.stringify([io.GSD_TEMP_DIR, io.gsdTempDir()]));
      }, { env: { ...process.env, TMPDIR: root, TEMP: root, TMP: root } });
      const expected = path.join(root, 'gsd');
      assert.deepEqual(JSON.parse(result.stdout).map((dir) => fs.realpathSync(dir)), [expected, expected]);
    }
  });
});

test('runGsdTools runs the command in this process (#6333)', async (t) => {
  // Every case here watches the process seam: a call that reaches it started
  // a child process (or would have, where the case replaces it).
  const watchSeam = (t2, implementation) => (implementation === undefined
    ? t2.mock.method(processSeam, 'runNode')
    : t2.mock.method(processSeam, 'runNode', implementation));

  const exited = (exitCode, stdout = '', stderr = '') => ({
    outcome: processSeam.OUTCOME.EXITED, exitCode, stdout, stderr, timedOut: false, signal: null, killed: false, code: null,
  });

  await t.test('a command string is split as a shell would, and no process is started', (t2) => {
    const seam = watchSeam(t2);

    assert.deepEqual(
      runGsdTools('generate-slug "Hello World"'),
      { success: true, output: '{\n  "slug": "hello-world"\n}', exitCode: 0 },
    );
    assert.equal(seam.mock.callCount(), 0);
  });

  await t.test('an argv array is passed as it is', (t2) => {
    const seam = watchSeam(t2);

    assert.deepEqual(JSON.parse(runGsdTools(['generate-slug', 'A $B "c"']).output), { slug: 'a-b-c' });
    assert.equal(seam.mock.callCount(), 0);
  });

  await t.test('a failing command gives success false, its stderr as the error and its exit code', (t2) => {
    const seam = watchSeam(t2);

    assert.deepEqual(
      runGsdTools('no-such-command-zz'),
      { success: false, output: '', error: 'Error: Unknown command: no-such-command-zz', exitCode: 1 },
    );
    assert.equal(seam.mock.callCount(), 0);
  });

  await t.test('cwd and env reach the command', (t2) => {
    const dir = tempDir(t2);
    fs.mkdirSync(path.join(dir, '.planning'));

    const found = JSON.parse(runGsdTools(['verify-path-exists', '.planning'], dir, { HOME: dir, USERPROFILE: dir }).output);

    assert.equal(found.exists, true);
  });

  await t.test('a command that finishes asynchronously is refused by name, pointed at runGsdToolsAsync, and not spawned', (t2) => {
    const seam = watchSeam(t2);
    for (const command of [...asyncHostCommandNames(), 'extract-messages', 'profile-sample', 'run-with-timeout']) {
      assert.throws(
        () => runGsdTools([command, '--flag'], tempDir(t2)),
        (error) => error.message.includes(`"${command}"`) && error.message.includes('runGsdToolsAsync')
          && error.cause?.code === IN_PROCESS_REASON.ASYNC_COMMAND,
        command,
      );
    }
    assert.equal(seam.mock.callCount(), 0);
  });

  await t.test('runGsdToolsAsync serves any command in this process, with the same result shape', async (t2) => {
    const seam = watchSeam(t2);
    const dir = tempDir(t2);

    assert.deepEqual(
      await runGsdToolsAsync('generate-slug "Hello World"', dir),
      { success: true, output: '{\n  "slug": "hello-world"\n}', exitCode: 0 },
    );
    const asyncCommand = await runGsdToolsAsync(['capability', 'no-such-subcommand-zz'], dir, { HOME: dir, USERPROFILE: dir });
    assert.equal(asyncCommand.success, false);
    assert.equal(asyncCommand.exitCode, 1);
    assert.match(asyncCommand.error, /Unknown capability subcommand: no-such-subcommand-zz/);
    assert.equal(seam.mock.callCount(), 0);
  });

  await t.test('both helpers give a synchronous command the same result', async (t2) => {
    const dir = tempDir(t2);
    for (const args of ['generate-slug "A b"', 'no-such-command-zz', ['verify-path-exists', '.']]) {
      assert.deepEqual(await runGsdToolsAsync(args, dir), runGsdTools(args, dir), JSON.stringify(args));
    }
  });

  await t.test('the in-process call is given the buffer limit a spawned command has', (t2) => {
    const tools = require(TOOLS_PATH);
    const call = t2.mock.method(tools, 'runCliSync', () => ({ exitCode: 0, stdout: 'ok', stderr: '' }));

    runGsdTools('generate-slug x');

    assert.equal(call.mock.calls[0].arguments[0].maxBufferBytes, SPAWNED_MAX_BUFFER_BYTES);
    assert.equal(SPAWNED_MAX_BUFFER_BYTES, 1024 * 1024);
  });

  await t.test('output over that limit is the failure the spawned form reports, and the command is not run again', (t2) => {
    const seam = watchSeam(t2);
    const tools = require(TOOLS_PATH);
    const overflow = Object.assign(new Error('stdout exceeded maxBufferBytes'), { code: IN_PROCESS_REASON.OUTPUT_OVERFLOW });
    t2.mock.method(tools, 'runCliSync', () => { throw overflow; });

    assert.deepEqual(runGsdTools('generate-slug x'), {
      success: false,
      output: '',
      error: 'gsd-tools output exceeded the subprocess buffer limit (code=ENOBUFS)',
      exitCode: 1,
    });
    assert.equal(seam.mock.callCount(), 0);
  });

  await t.test('an ENOENT thrown by the call itself is not mistaken for a missing working directory', (t2) => {
    const seam = watchSeam(t2);
    const tools = require(TOOLS_PATH);
    const failure = Object.assign(new Error('ENOENT: no such file or directory, uv_cwd'), { code: 'ENOENT' });
    t2.mock.method(tools, 'runCliSync', () => { throw failure; });

    assert.equal(thrownBy(() => runGsdTools('generate-slug x')), failure);
    assert.equal(seam.mock.callCount(), 0);
  });

  await t.test('a working directory that does not exist is a real-process question: refused, and runGsdToolsProcess answers it', async (t2) => {
    const seam = watchSeam(t2, () => ({ ...exited(null), outcome: processSeam.OUTCOME.SPAWN_FAILED, code: 'ENOENT' }));
    const missing = path.join(tempDir(t2), 'not-here');
    const refused = (error) => error.message.includes('not-here') && error.message.includes('runGsdToolsProcess');

    assert.throws(() => runGsdTools('generate-slug x', missing), refused);
    await assert.rejects(runGsdToolsAsync('generate-slug x', missing), refused);
    assert.equal(seam.mock.callCount(), 0);

    assert.deepEqual(
      runGsdToolsProcess('generate-slug x', missing),
      { success: false, output: '', error: 'gsd-tools failed to spawn (code=ENOENT)', exitCode: 1 },
    );
    assert.equal(seam.mock.callCount(), 1);
  });

  await t.test('a command whose work had started is never run again in a child process', (t2) => {
    const seam = watchSeam(t2);
    const tools = require(TOOLS_PATH);
    const failure = Object.assign(new Error('started'), { code: IN_PROCESS_REASON.ASYNC_STARTED });
    t2.mock.method(tools, 'runCliSync', () => { throw failure; });

    assert.equal(thrownBy(() => runGsdTools('generate-slug x')), failure);
    assert.equal(seam.mock.callCount(), 0);
  });

  await t.test('a NODE_ variable set for the call is refused: it would do nothing in this process', async (t2) => {
    const seam = watchSeam(t2);
    for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'NODE_NO_WARNINGS', 'NODE_PENDING_DEPRECATION', 'node_options']) {
      const refused = (error) => error.message.includes(name) && error.message.includes('runGsdToolsProcess');
      assert.throws(() => runGsdTools('generate-slug x', process.cwd(), { [name]: 'set-for-this-call' }), refused, name);
      await assert.rejects(runGsdToolsAsync('generate-slug x', process.cwd(), { [name]: 'set-for-this-call' }), refused, name);
    }
    // Not refused: the two a program reads for itself, a key that sets nothing,
    // and a variable passed through unchanged from this process's environment.
    const saved = process.env.NODE_NO_WARNINGS;
    process.env.NODE_NO_WARNINGS = '1';
    t2.after(() => {
      if (saved === undefined) delete process.env.NODE_NO_WARNINGS;
      else process.env.NODE_NO_WARNINGS = saved;
    });
    for (const env of [{ NODE_TEST_CONTEXT: '' }, { NODE_ENV: 'test' }, { NODE_OPTIONS: undefined }, { ...process.env }]) {
      assert.equal(runGsdTools('generate-slug x', process.cwd(), env).success, true, JSON.stringify(Object.keys(env).slice(0, 3)));
    }
    assert.throws(() => runGsdTools('generate-slug x', process.cwd(), { NODE_NO_WARNINGS: '0' }), /NODE_NO_WARNINGS/);
    assert.equal(seam.mock.callCount(), 0);
  });

  await t.test('any other variable set for the call does not', (t2) => {
    const seam = watchSeam(t2);

    assert.equal(runGsdTools('generate-slug x', process.cwd(), { GSD_ANYTHING: '1', NODEISH: '1' }).success, true);
    assert.equal(seam.mock.callCount(), 0);
  });

  await t.test('GSD_TEST_CLI_MODE=process spawns every call', async (t2) => {
    const seam = watchSeam(t2, () => exited(0, 'from the child'));
    const saved = process.env.GSD_TEST_CLI_MODE;
    t2.after(() => {
      if (saved === undefined) delete process.env.GSD_TEST_CLI_MODE;
      else process.env.GSD_TEST_CLI_MODE = saved;
    });
    process.env.GSD_TEST_CLI_MODE = 'process';

    assert.deepEqual(runGsdTools('generate-slug x'), { success: true, output: 'from the child', exitCode: 0 });
    assert.deepEqual(await runGsdToolsAsync('websearch x'), { success: true, output: 'from the child', exitCode: 0 });
    assert.equal(seam.mock.callCount(), 2);
  });

  await t.test('runGsdToolsProcess always spawns', (t2) => {
    const seam = watchSeam(t2, () => exited(2, 'out', 'err\n'));

    assert.deepEqual(
      runGsdToolsProcess(['generate-slug', 'x']),
      { success: false, output: 'out', error: 'err', exitCode: 2 },
    );
    assert.equal(seam.mock.callCount(), 1);
  });

  await t.test('an error that is not a reason to spawn is thrown to the caller', (t2) => {
    const seam = watchSeam(t2);
    const tools = require(TOOLS_PATH);
    const failure = Object.assign(new Error('restore failed'), { code: IN_PROCESS_REASON.RESTORE_FAILED });
    t2.mock.method(tools, 'runCliSync', () => { throw failure; });

    assert.equal(thrownBy(() => runGsdTools('generate-slug x')), failure);
    assert.equal(seam.mock.callCount(), 0);
  });
});
