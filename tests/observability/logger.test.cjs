'use strict';

/**
 * Tests for DispatchLogger interface + default implementation (issue #177).
 *
 * All tests use real fs and real stderr capture (no mocks).
 * Env vars are restored in afterEach.
 * Temp dirs are created under os.tmpdir() and cleaned up in afterEach.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  createDefaultLogger,
  createNoOpLogger,
} = require('../../gsd-core/bin/lib/observability/logger.cjs');
const { cleanup } = require('../helpers.cjs');

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-logger-test-'));
}

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

function makeOkEvent(overrides = {}) {
  return Object.assign({
    traceId: 'test-trace-id',
    parentTraceId: undefined,
    command: 'plan',
    result: { kind: 'ok', data: null },
    timestamp: '2026-01-01T00:00:00.000Z',
  }, overrides);
}

function makeErrEvent(kindPayload, overrides = {}) {
  return Object.assign({
    traceId: 'test-trace-id',
    parentTraceId: undefined,
    command: 'plan',
    result: kindPayload,
    timestamp: '2026-01-01T00:00:00.000Z',
  }, overrides);
}

// ─── createNoOpLogger ────────────────────────────────────────────────────────

describe('createNoOpLogger', () => {
  test('returns an object with onEvent', () => {
    const logger = createNoOpLogger();
    assert.ok(typeof logger.onEvent === 'function', 'onEvent must be a function');
  });

  test('onEvent does not throw on ok result', () => {
    const logger = createNoOpLogger();
    assert.doesNotThrow(() => logger.onEvent(makeOkEvent()));
  });

  test('onEvent does not throw on error result', () => {
    const logger = createNoOpLogger();
    assert.doesNotThrow(() =>
      logger.onEvent(makeErrEvent({ kind: 'UnknownCommand', command: 'bogus' }))
    );
  });

  test('onEvent does not write to stderr', () => {
    const logger = createNoOpLogger();
    const output = captureStderr(() => logger.onEvent(makeOkEvent()));
    assert.equal(output, '', 'no-op logger must not write to stderr');
  });
});

// ─── createDefaultLogger — silent on success ─────────────────────────────────

describe('createDefaultLogger — silent on success', () => {
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
    cleanup(tmpDir);
  });

  test('no stderr output on ok result', () => {
    const logger = createDefaultLogger({ cwd: tmpDir });
    const stderrOutput = captureStderr(() => logger.onEvent(makeOkEvent()));
    assert.equal(stderrOutput, '', 'must not write to stderr on ok result');
  });

  test('no audit file created on ok result (no GSD_AUDIT)', () => {
    const logger = createDefaultLogger({ cwd: tmpDir });
    logger.onEvent(makeOkEvent());
    const auditPath = path.join(tmpDir, '.planning', '.gsd-trace.jsonl');
    assert.ok(!fs.existsSync(auditPath), 'audit file must not be created without GSD_AUDIT=1');
  });
});

// ─── createDefaultLogger — stderr on error ──────────────────────────────────

describe('createDefaultLogger — stderr on error', () => {
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
    cleanup(tmpDir);
  });

  test('emits exactly one JSON line to stderr on error', () => {
    const logger = createDefaultLogger({ cwd: tmpDir });
    const errEvent = makeErrEvent({ kind: 'UnknownCommand', command: 'bogus' });
    const stderrOutput = captureStderr(() => logger.onEvent(errEvent));

    // Must be exactly one non-empty line
    const lines = stderrOutput.split('\n').filter(l => l.trim().length > 0);
    assert.equal(lines.length, 1, `expected 1 line, got ${lines.length}: ${stderrOutput}`);
  });

  test('stderr line is valid JSON', () => {
    const logger = createDefaultLogger({ cwd: tmpDir });
    const errEvent = makeErrEvent({ kind: 'HandlerFailure', message: 'boom' });
    let stderrOutput = '';
    stderrOutput = captureStderr(() => logger.onEvent(errEvent));

    const line = stderrOutput.trim();
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(line); }, `stderr line must be valid JSON, got: ${line}`);
    assert.ok(parsed !== null && typeof parsed === 'object');
  });

  test('stderr JSON contains kind field matching result kind', () => {
    const logger = createDefaultLogger({ cwd: tmpDir });
    const errEvent = makeErrEvent({ kind: 'HandlerRefusal', reason: 'refused' });
    const stderrOutput = captureStderr(() => logger.onEvent(errEvent));
    const parsed = JSON.parse(stderrOutput.trim());
    assert.equal(parsed.kind, 'HandlerRefusal');
  });

  test('stderr JSON contains traceId from the event', () => {
    const logger = createDefaultLogger({ cwd: tmpDir });
    const errEvent = makeErrEvent({ kind: 'UnknownCommand', command: 'bogus' });
    errEvent.traceId = 'specific-trace-id-123';
    const stderrOutput = captureStderr(() => logger.onEvent(errEvent));
    const parsed = JSON.parse(stderrOutput.trim());
    assert.equal(parsed.traceId, 'specific-trace-id-123');
  });

  test('stderr JSON does not contain args by default (redaction)', () => {
    const logger = createDefaultLogger({ cwd: tmpDir });
    const errEvent = makeErrEvent({ kind: 'InvalidArgs', arg: '--bad', reason: 'oops' });
    errEvent.args = ['--bad', 'value'];
    const stderrOutput = captureStderr(() => logger.onEvent(errEvent));
    const parsed = JSON.parse(stderrOutput.trim());
    assert.ok(!('args' in parsed), 'args must be redacted from stderr output by default');
  });

  test('stderr JSON includes args when GSD_AUDIT_ARGS=1', () => {
    process.env.GSD_AUDIT_ARGS = '1';
    const logger = createDefaultLogger({ cwd: tmpDir });
    const errEvent = Object.assign(
      makeErrEvent({ kind: 'InvalidArgs', arg: '--bad', reason: 'oops' }),
      { args: ['--bad', 'value'] }
    );
    const stderrOutput = captureStderr(() => logger.onEvent(errEvent));
    const parsed = JSON.parse(stderrOutput.trim());
    assert.ok('args' in parsed, 'args must appear in stderr when GSD_AUDIT_ARGS=1');
    assert.deepStrictEqual(parsed.args, ['--bad', 'value']);
  });

  test('no stderr output on ok result even when GSD_AUDIT=1', () => {
    process.env.GSD_AUDIT = '1';
    const logger = createDefaultLogger({ cwd: tmpDir });
    const stderrOutput = captureStderr(() => logger.onEvent(makeOkEvent()));
    assert.equal(stderrOutput, '', 'ok result must never produce stderr output');
  });
});

// ─── createDefaultLogger — audit file ───────────────────────────────────────

describe('createDefaultLogger — audit file', () => {
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
    cleanup(tmpDir);
  });

  test('creates .planning/.gsd-trace.jsonl when GSD_AUDIT=1 (ok result)', () => {
    process.env.GSD_AUDIT = '1';
    const logger = createDefaultLogger({ cwd: tmpDir });
    logger.onEvent(makeOkEvent());
    const auditPath = path.join(tmpDir, '.planning', '.gsd-trace.jsonl');
    assert.ok(fs.existsSync(auditPath), 'audit file must be created when GSD_AUDIT=1');
  });

  test('creates .planning/ directory if absent', () => {
    process.env.GSD_AUDIT = '1';
    // tmpDir has no .planning/ subdirectory
    assert.ok(!fs.existsSync(path.join(tmpDir, '.planning')));
    const logger = createDefaultLogger({ cwd: tmpDir });
    logger.onEvent(makeOkEvent());
    assert.ok(fs.existsSync(path.join(tmpDir, '.planning')));
  });

  test('audit file contains one valid JSON line per event', () => {
    process.env.GSD_AUDIT = '1';
    const logger = createDefaultLogger({ cwd: tmpDir });
    logger.onEvent(makeOkEvent({ traceId: 'a1' }));
    logger.onEvent(makeOkEvent({ traceId: 'a2' }));

    const auditPath = path.join(tmpDir, '.planning', '.gsd-trace.jsonl');
    const content = fs.readFileSync(auditPath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim().length > 0);
    assert.equal(lines.length, 2, `expected 2 lines, got ${lines.length}`);

    const parsed0 = JSON.parse(lines[0]);
    const parsed1 = JSON.parse(lines[1]);
    assert.equal(parsed0.traceId, 'a1');
    assert.equal(parsed1.traceId, 'a2');
  });

  test('audit file is append-only (second run adds to existing content)', () => {
    process.env.GSD_AUDIT = '1';
    const auditPath = path.join(tmpDir, '.planning', '.gsd-trace.jsonl');

    const logger1 = createDefaultLogger({ cwd: tmpDir });
    logger1.onEvent(makeOkEvent({ traceId: 'first' }));

    const logger2 = createDefaultLogger({ cwd: tmpDir });
    logger2.onEvent(makeOkEvent({ traceId: 'second' }));

    const content = fs.readFileSync(auditPath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim().length > 0);
    assert.equal(lines.length, 2, 'both events must appear (append-only)');
    assert.equal(JSON.parse(lines[0]).traceId, 'first');
    assert.equal(JSON.parse(lines[1]).traceId, 'second');
  });

  test('audit file contains both ok and error events', () => {
    process.env.GSD_AUDIT = '1';
    const logger = createDefaultLogger({ cwd: tmpDir });
    logger.onEvent(makeOkEvent({ traceId: 'ok-event' }));
    logger.onEvent(makeErrEvent({ kind: 'HandlerFailure', message: 'boom' }, { traceId: 'err-event' }));

    const auditPath = path.join(tmpDir, '.planning', '.gsd-trace.jsonl');
    const content = fs.readFileSync(auditPath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim().length > 0);
    assert.equal(lines.length, 2);

    const traceIds = lines.map(l => JSON.parse(l).traceId);
    assert.ok(traceIds.includes('ok-event'), 'ok event must be in audit file');
    assert.ok(traceIds.includes('err-event'), 'error event must be in audit file');
  });

  test('audit file does NOT contain args by default', () => {
    process.env.GSD_AUDIT = '1';
    const logger = createDefaultLogger({ cwd: tmpDir });
    const event = Object.assign(makeOkEvent(), { args: ['secret-arg'] });
    logger.onEvent(event);

    const auditPath = path.join(tmpDir, '.planning', '.gsd-trace.jsonl');
    const content = fs.readFileSync(auditPath, 'utf8');
    const parsed = JSON.parse(content.trim());
    assert.ok(!('args' in parsed), 'args must be redacted from audit file by default');
  });

  test('audit file DOES contain args when GSD_AUDIT_ARGS=1', () => {
    process.env.GSD_AUDIT = '1';
    process.env.GSD_AUDIT_ARGS = '1';
    const logger = createDefaultLogger({ cwd: tmpDir });
    const event = Object.assign(makeOkEvent(), { args: ['visible-arg'] });
    logger.onEvent(event);

    const auditPath = path.join(tmpDir, '.planning', '.gsd-trace.jsonl');
    const content = fs.readFileSync(auditPath, 'utf8');
    const parsed = JSON.parse(content.trim());
    assert.ok('args' in parsed, 'args must appear in audit file when GSD_AUDIT_ARGS=1');
    assert.deepStrictEqual(parsed.args, ['visible-arg']);
  });

  test('config.audit.enabled === true triggers audit file (without GSD_AUDIT env)', () => {
    // GSD_AUDIT is not set, but config says enabled
    const logger = createDefaultLogger({ cwd: tmpDir, config: { audit: { enabled: true } } });
    logger.onEvent(makeOkEvent({ traceId: 'config-triggered' }));

    const auditPath = path.join(tmpDir, '.planning', '.gsd-trace.jsonl');
    assert.ok(fs.existsSync(auditPath), 'audit file must be created when config.audit.enabled=true');
    const parsed = JSON.parse(fs.readFileSync(auditPath, 'utf8').trim());
    assert.equal(parsed.traceId, 'config-triggered');
  });
});
