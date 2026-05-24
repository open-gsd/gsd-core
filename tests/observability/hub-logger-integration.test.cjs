'use strict';

/**
 * Integration tests for the Hub + DispatchLogger seam (issue #177).
 *
 * These tests verify that:
 * 1. The Hub calls logger.onEvent exactly once per dispatch.
 * 2. The event passed to the logger has the correct shape.
 * 3. Logger errors do NOT propagate to the dispatch caller.
 * 4. The no-op logger is used when no logger is injected.
 * 5. A custom logger (injected via constructor) receives correct events.
 *
 * Real Hub code is used — no mocks of the Hub itself.
 * Logger is a real tracking stub (records calls, no fs writes needed here).
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  createHub,
  ERROR_KINDS,
} = require('../../get-shit-done/bin/lib/command-routing-hub.cjs');

const {
  createDefaultLogger,
  createNoOpLogger,
} = require('../../get-shit-done/bin/lib/observability/logger.cjs');

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Creates a logger stub that records every onEvent call. */
function makeTrackingLogger() {
  const calls = [];
  return {
    onEvent(event) {
      calls.push(event);
    },
    calls,
  };
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-hub-logger-test-'));
}

/** Capture all stderr writes during fn() */
function captureStderr(fn) {
  const chunks = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return originalWrite(chunk, ...rest);
  };
  try {
    fn();
  } finally {
    process.stderr.write = originalWrite;
  }
  return chunks.join('');
}

function makeHub(logger) {
  const registry = {
    plan: {
      '': () => ({ ok: true, data: 'done' }),
    },
    discuss: {
      '': () => ({ ok: false, kind: 'HandlerRefusal', reason: 'not now' }),
    },
    broken: {
      '': () => { throw new Error('handler exploded'); },
    },
  };
  const manifest = {
    plan: [''],
    discuss: [''],
    broken: [''],
  };
  return createHub({ cjsRegistry: registry, manifest, logger });
}

// ─── Hub calls logger.onEvent once per dispatch ───────────────────────────────

describe('Hub + logger — onEvent called per dispatch', () => {
  test('onEvent called exactly once on successful dispatch', () => {
    const tracking = makeTrackingLogger();
    const hub = makeHub(tracking);
    hub.dispatch({ family: 'plan', subcommand: '' });
    assert.equal(tracking.calls.length, 1, 'onEvent must be called exactly once');
  });

  test('onEvent called exactly once on error dispatch', () => {
    const tracking = makeTrackingLogger();
    const hub = makeHub(tracking);
    hub.dispatch({ family: 'discuss', subcommand: '' });
    assert.equal(tracking.calls.length, 1, 'onEvent must be called exactly once on error');
  });

  test('onEvent called exactly once when handler throws', () => {
    const tracking = makeTrackingLogger();
    const hub = makeHub(tracking);
    hub.dispatch({ family: 'broken', subcommand: '' });
    assert.equal(tracking.calls.length, 1, 'onEvent must be called even when handler throws');
  });

  test('onEvent called once for unknown command', () => {
    const tracking = makeTrackingLogger();
    const hub = makeHub(tracking);
    hub.dispatch({ family: 'nonexistent', subcommand: '' });
    assert.equal(tracking.calls.length, 1);
  });

  test('multiple dispatches produce multiple onEvent calls (one per dispatch)', () => {
    const tracking = makeTrackingLogger();
    const hub = makeHub(tracking);
    hub.dispatch({ family: 'plan', subcommand: '' });
    hub.dispatch({ family: 'discuss', subcommand: '' });
    hub.dispatch({ family: 'plan', subcommand: '' });
    assert.equal(tracking.calls.length, 3);
  });
});

// ─── Event shape passed to logger ────────────────────────────────────────────

describe('Hub + logger — event shape', () => {
  test('event has traceId, command, result, timestamp on success', () => {
    const tracking = makeTrackingLogger();
    const hub = makeHub(tracking);
    hub.dispatch({ family: 'plan', subcommand: '' });

    const event = tracking.calls[0];
    assert.ok(typeof event.traceId === 'string', 'traceId must be a string');
    assert.ok(typeof event.command === 'string', 'command must be a string');
    assert.ok(typeof event.timestamp === 'string', 'timestamp must be a string');
    assert.ok('result' in event, 'result must be present');
  });

  test('event.result.kind is "ok" for successful dispatch', () => {
    const tracking = makeTrackingLogger();
    const hub = makeHub(tracking);
    hub.dispatch({ family: 'plan', subcommand: '' });
    assert.equal(tracking.calls[0].result.kind, 'ok');
  });

  test('event.result.kind is the error kind for failed dispatch', () => {
    const tracking = makeTrackingLogger();
    const hub = makeHub(tracking);
    hub.dispatch({ family: 'discuss', subcommand: '' });
    assert.equal(tracking.calls[0].result.kind, 'HandlerRefusal');
  });

  test('event.result.kind is HandlerFailure when handler throws', () => {
    const tracking = makeTrackingLogger();
    const hub = makeHub(tracking);
    hub.dispatch({ family: 'broken', subcommand: '' });
    assert.equal(tracking.calls[0].result.kind, 'HandlerFailure');
  });

  test('event.command includes the family', () => {
    const tracking = makeTrackingLogger();
    const hub = makeHub(tracking);
    hub.dispatch({ family: 'plan', subcommand: '' });
    assert.ok(tracking.calls[0].command.includes('plan'), 'command must reference the family');
  });

  test('each dispatch has a unique traceId', () => {
    const tracking = makeTrackingLogger();
    const hub = makeHub(tracking);
    hub.dispatch({ family: 'plan', subcommand: '' });
    hub.dispatch({ family: 'plan', subcommand: '' });
    assert.notEqual(
      tracking.calls[0].traceId,
      tracking.calls[1].traceId,
      'consecutive dispatches must produce unique traceIds'
    );
  });

  test('event.parentTraceId is undefined in P1.3', () => {
    const tracking = makeTrackingLogger();
    const hub = makeHub(tracking);
    hub.dispatch({ family: 'plan', subcommand: '' });
    assert.strictEqual(tracking.calls[0].parentTraceId, undefined,
      'parentTraceId must be undefined in P1.3');
  });
});

// ─── Logger errors do not break dispatch ────────────────────────────────────

describe('Hub + logger — logger errors are contained', () => {
  test('dispatch still returns Result even if logger.onEvent throws', () => {
    const throwingLogger = {
      onEvent() { throw new Error('logger exploded'); },
    };
    const hub = makeHub(throwingLogger);

    let result;
    // Must not throw
    assert.doesNotThrow(() => {
      result = hub.dispatch({ family: 'plan', subcommand: '' });
    });
    assert.ok(result.ok === true, 'dispatch must still return ok result despite logger failure');
  });

  test('logger failure emits a warn line to stderr, not an uncaught exception', () => {
    const throwingLogger = {
      onEvent() { throw new Error('logger is broken'); },
    };
    const hub = makeHub(throwingLogger);

    const stderrOutput = captureStderr(() => {
      hub.dispatch({ family: 'plan', subcommand: '' });
    });

    // There should be some warning output
    assert.ok(stderrOutput.length > 0, 'a warning must be emitted to stderr when logger fails');
    // It should be parseable JSON with level:warn
    const parsed = JSON.parse(stderrOutput.trim().split('\n')[0]);
    assert.equal(parsed.level, 'warn', 'logger failure warning must have level:warn');
    assert.equal(parsed.source, 'DispatchLogger');
  });
});

// ─── No logger injected — defaults to no-op ──────────────────────────────────

describe('Hub — default no-op when no logger injected', () => {
  test('Hub works without a logger param (no throw)', () => {
    const hub = createHub({
      cjsRegistry: { plan: { '': () => ({ ok: true, data: null }) } },
      manifest: { plan: [''] },
    });
    let result;
    assert.doesNotThrow(() => {
      result = hub.dispatch({ family: 'plan', subcommand: '' });
    });
    assert.ok(result.ok);
  });

  test('no stderr output for success when no logger injected', () => {
    const hub = createHub({
      cjsRegistry: { plan: { '': () => ({ ok: true, data: null }) } },
      manifest: { plan: [''] },
    });
    const stderrOutput = captureStderr(() => {
      hub.dispatch({ family: 'plan', subcommand: '' });
    });
    assert.equal(stderrOutput, '', 'no-op default must not produce any stderr');
  });
});

// ─── End-to-end: createDefaultLogger with real Hub ──────────────────────────

describe('Hub + createDefaultLogger — end-to-end', () => {
  let tmpDir;
  let savedAudit;
  let savedAuditArgs;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    savedAudit = process.env.GSD_AUDIT;
    savedAuditArgs = process.env.GSD_AUDIT_ARGS;
    delete process.env.GSD_AUDIT;
    delete process.env.GSD_AUDIT_ARGS;
  });

  afterEach(() => {
    if (savedAudit === undefined) delete process.env.GSD_AUDIT; else process.env.GSD_AUDIT = savedAudit;
    if (savedAuditArgs === undefined) delete process.env.GSD_AUDIT_ARGS; else process.env.GSD_AUDIT_ARGS = savedAuditArgs;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('silent on success with default logger', () => {
    const logger = createDefaultLogger({ cwd: tmpDir });
    const hub = makeHub(logger);
    const stderrOutput = captureStderr(() => hub.dispatch({ family: 'plan', subcommand: '' }));
    assert.equal(stderrOutput, '', 'must be silent on success');
  });

  test('stderr line on error with default logger', () => {
    const logger = createDefaultLogger({ cwd: tmpDir });
    const hub = makeHub(logger);
    const stderrOutput = captureStderr(() => hub.dispatch({ family: 'discuss', subcommand: '' }));
    assert.ok(stderrOutput.trim().length > 0, 'must emit to stderr on error');
    const parsed = JSON.parse(stderrOutput.trim());
    assert.equal(parsed.kind, 'HandlerRefusal');
  });

  test('audit file written when GSD_AUDIT=1', () => {
    process.env.GSD_AUDIT = '1';
    const logger = createDefaultLogger({ cwd: tmpDir });
    const hub = makeHub(logger);
    hub.dispatch({ family: 'plan', subcommand: '' });

    const auditPath = path.join(tmpDir, '.planning', '.gsd-trace.jsonl');
    assert.ok(fs.existsSync(auditPath), 'audit file must exist after dispatch with GSD_AUDIT=1');

    const line = fs.readFileSync(auditPath, 'utf8').trim();
    const parsed = JSON.parse(line);
    assert.ok(typeof parsed.traceId === 'string');
    assert.equal(parsed.result.kind, 'ok');
  });
});
