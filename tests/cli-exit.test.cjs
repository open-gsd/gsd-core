'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { ExitError, runMain } = require('../scripts/lib/cli-exit.cjs');

/** Settle the runMain promise chain before asserting. */
async function settle() {
  await new Promise((r) => setImmediate(r));
}

describe('ExitError', () => {
  test('default code is 1', () => {
    const err = new ExitError();
    assert.equal(err.code, 1);
  });

  test('name is ExitError', () => {
    const err = new ExitError();
    assert.equal(err.name, 'ExitError');
  });

  test('instanceof Error', () => {
    assert.ok(new ExitError() instanceof Error);
  });

  test('hasUserMessage is false when no message passed', () => {
    const err = new ExitError(1);
    assert.equal(err.hasUserMessage, false);
  });

  test('hasUserMessage is true when message passed', () => {
    const err = new ExitError(1, 'something went wrong');
    assert.equal(err.hasUserMessage, true);
  });

  test('custom code is preserved', () => {
    const err = new ExitError(42, 'boom');
    assert.equal(err.code, 42);
  });

  test('message is set to user message when provided', () => {
    const err = new ExitError(2, 'user msg');
    assert.equal(err.message, 'user msg');
  });

  test('message is synthetic when no message provided', () => {
    const err = new ExitError(3);
    assert.equal(err.message, 'process exit 3');
  });
});

describe('runMain', () => {
  test('main returns a number sets process.exitCode', async () => {
    const saved = process.exitCode;
    try {
      runMain(() => 42);
      await settle();
      assert.equal(process.exitCode, 42);
    } finally {
      process.exitCode = saved || 0;
    }
  });

  test('main returns undefined leaves process.exitCode unchanged', async () => {
    const saved = process.exitCode;
    // Set a known value before calling
    process.exitCode = 0;
    try {
      runMain(() => undefined);
      await settle();
      assert.equal(process.exitCode, 0);
    } finally {
      process.exitCode = saved || 0;
    }
  });

  test('main throws ExitError sets process.exitCode to err.code', async () => {
    const saved = process.exitCode;
    try {
      runMain(() => { throw new ExitError(2); });
      await settle();
      assert.equal(process.exitCode, 2);
    } finally {
      process.exitCode = saved || 0;
    }
  });

  test('main rejects async ExitError(0) sets process.exitCode to 0', async () => {
    const saved = process.exitCode;
    try {
      runMain(async () => { throw new ExitError(0); });
      await settle();
      assert.equal(process.exitCode, 0);
    } finally {
      process.exitCode = saved !== undefined ? saved : 0;
    }
  });

  test('main throws generic Error sets process.exitCode to 1 and writes stderr', async () => {
    const saved = process.exitCode;
    const stderrChunks = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return origWrite(chunk, ...args);
    };
    try {
      runMain(() => { throw new Error('kaboom'); });
      await settle();
      assert.equal(process.exitCode, 1);
      const combined = stderrChunks.join('');
      assert.ok(combined.includes('kaboom'), `expected "kaboom" in stderr: ${combined}`);
    } finally {
      process.stderr.write = origWrite;
      process.exitCode = saved || 0;
    }
  });

  test('ExitError with hasUserMessage and non-zero code writes to stderr', async () => {
    const saved = process.exitCode;
    const stderrChunks = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return origWrite(chunk, ...args);
    };
    try {
      runMain(() => { throw new ExitError(1, 'user-visible error'); });
      await settle();
      assert.equal(process.exitCode, 1);
      const combined = stderrChunks.join('');
      assert.ok(combined.includes('user-visible error'), `expected message in stderr: ${combined}`);
    } finally {
      process.stderr.write = origWrite;
      process.exitCode = saved || 0;
    }
  });

  test('ExitError with hasUserMessage and code 0 does NOT write to stderr', async () => {
    const saved = process.exitCode;
    const stderrChunks = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return origWrite(chunk, ...args);
    };
    try {
      runMain(() => { throw new ExitError(0, 'silent success'); });
      await settle();
      assert.equal(process.exitCode, 0);
      const combined = stderrChunks.join('');
      assert.equal(combined.includes('silent success'), false,
        `did not expect message in stderr: ${combined}`);
    } finally {
      process.stderr.write = origWrite;
      process.exitCode = saved !== undefined ? saved : 0;
    }
  });
});
