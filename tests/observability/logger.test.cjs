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
const fc = require('fast-check');

const {
  createDefaultLogger,
  createNoOpLogger,
  resolveDispatchLogger,
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
    const lines = stderrOutput.split(/\r?\n/).filter(l => l.trim().length > 0);
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
    const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
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
    const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
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
    const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
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

// ─── resolveDispatchLogger — the live dispatch seam's opt-in gate (#4975) ────
//
// Both live createHub() seams used to call isAuditEnabled() with no config, so
// only GSD_AUDIT could ever turn the opt-in audit trail on and a project's
// `audit.enabled: true` was inert. resolveDispatchLogger(cwd) is the one gate
// both seams now share: it resolves `audit.enabled` for the cwd the seam
// already holds and returns the reference DispatchLogger, or undefined (no
// logger injected — the Hub keeps its no-op fallback) when observability is off.

describe('resolveDispatchLogger — config audit.enabled opt-in gate (#4975)', () => {
  // Frozen verdicts: what the seam would inject for a given project + env.
  const VERDICT = Object.freeze({
    NO_LOGGER: 'no_logger',
    AUDIT_TRAIL: 'audit_trail',
    LOGGER_WITHOUT_TRAIL: 'logger_without_trail',
  });
  const GATE_ENV_KEYS = ['GSD_AUDIT', 'GSD_AUDIT_ARGS', 'GSD_WORKSTREAM', 'GSD_PROJECT'];

  let tmpDir;
  let savedEnv;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    savedEnv = Object.fromEntries(GATE_ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of GATE_ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of GATE_ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
    }
    cleanup(tmpDir);
  });

  function writeConfig(relDir, text) {
    const dir = path.join(tmpDir, relDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), text);
  }

  /** Resolve the seam's logger and report what it would do with one dispatch. */
  function gateVerdict() {
    const logger = resolveDispatchLogger(tmpDir);
    if (logger === undefined) return VERDICT.NO_LOGGER;
    logger.onEvent(makeOkEvent({ traceId: 'gate-probe' }));
    return fs.existsSync(path.join(tmpDir, '.planning', '.gsd-trace.jsonl'))
      ? VERDICT.AUDIT_TRAIL
      : VERDICT.LOGGER_WITHOUT_TRAIL;
  }

  test('happy path: audit.enabled true with no GSD_AUDIT injects the audit-enabled reference logger', () => {
    writeConfig('.planning', JSON.stringify({ audit: { enabled: true } }));
    assert.equal(gateVerdict(), VERDICT.AUDIT_TRAIL);
  });

  test('missing: no .planning/config.json injects no logger', () => {
    assert.equal(gateVerdict(), VERDICT.NO_LOGGER);
    assert.equal(fs.existsSync(path.join(tmpDir, '.planning')), false,
      'resolving the gate must not create .planning/ as a side effect');
  });

  test('missing key / false / non-boolean / wrong shape all degrade to no logger', () => {
    const fixtures = [
      ['empty object', '{}'],
      ['empty audit section', JSON.stringify({ audit: {} })],
      ['explicit false', JSON.stringify({ audit: { enabled: false } })],
      ['string "true"', JSON.stringify({ audit: { enabled: 'true' } })],
      ['number 1', JSON.stringify({ audit: { enabled: 1 } })],
      ['null', JSON.stringify({ audit: { enabled: null } })],
      ['object where boolean expected', JSON.stringify({ audit: { enabled: {} } })],
      ['scalar where section expected', JSON.stringify({ audit: true })],
      ['array where section expected', JSON.stringify({ audit: [true] })],
      ['array config root', JSON.stringify([{ audit: { enabled: true } }])],
      ['flat dotted key is not the nested key', JSON.stringify({ 'audit.enabled': true })],
    ];
    for (const [label, text] of fixtures) {
      writeConfig('.planning', text);
      assert.equal(gateVerdict(), VERDICT.NO_LOGGER, `${label}: must inject no logger`);
    }
  });

  test('malformed: empty, whitespace-only, and unparseable config.json degrade to no logger without throwing', () => {
    const fixtures = [
      ['empty file', ''],
      ['whitespace-only file', '  \n\t\n'],
      ['trailing comma', '{"audit":{"enabled":true},}'],
      ['truncated JSON', '{"audit":{"enabled":tr'],
      ['BOM-prefixed JSON', '﻿{"audit":{"enabled":true}}'],
    ];
    for (const [label, text] of fixtures) {
      writeConfig('.planning', text);
      assert.equal(gateVerdict(), VERDICT.NO_LOGGER, `${label}: must degrade to audit off`);
    }
  });

  test('filesystem failure: config.json that is a directory degrades to no logger', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'config.json'), { recursive: true });
    assert.equal(gateVerdict(), VERDICT.NO_LOGGER);
  });

  test('duplicate key: JSON last-wins, the same value config-get reports', () => {
    writeConfig('.planning', '{"audit":{"enabled":false,"enabled":true}}');
    assert.equal(gateVerdict(), VERDICT.AUDIT_TRAIL);
  });

  test('conflicting sources: GSD_AUDIT=1 turns the trail on even when audit.enabled is false', () => {
    writeConfig('.planning', JSON.stringify({ audit: { enabled: false } }));
    process.env.GSD_AUDIT = '1';
    assert.equal(gateVerdict(), VERDICT.AUDIT_TRAIL);
  });

  test('conflicting sources: audit.enabled true turns the trail on even when GSD_AUDIT is set to a non-"1" value', () => {
    // Either source enables; neither disables the other. Only GSD_AUDIT === "1"
    // is an env opt-in — "0" was never an off-switch, and #4975 does not make it one.
    writeConfig('.planning', JSON.stringify({ audit: { enabled: true } }));
    process.env.GSD_AUDIT = '0';
    assert.equal(gateVerdict(), VERDICT.AUDIT_TRAIL);
  });

  test('malformed config with GSD_AUDIT=1 degrades to the env-var-only behaviour, not to a broken gate', () => {
    writeConfig('.planning', '{"audit":');
    process.env.GSD_AUDIT = '1';
    assert.equal(gateVerdict(), VERDICT.AUDIT_TRAIL);
  });

  test('workstream scope: the workstream config wins, the root config is inherited when the workstream does not set the key', () => {
    process.env.GSD_WORKSTREAM = 'alpha';
    writeConfig('.planning', JSON.stringify({ audit: { enabled: true } }));
    assert.equal(gateVerdict(), VERDICT.AUDIT_TRAIL, 'no workstream config: inherits the root value');

    writeConfig(path.join('.planning', 'workstreams', 'alpha'), '{}');
    assert.equal(gateVerdict(), VERDICT.AUDIT_TRAIL, 'workstream config without the key: inherits the root value');

    writeConfig(path.join('.planning', 'workstreams', 'alpha'), JSON.stringify({ audit: { enabled: false } }));
    assert.equal(gateVerdict(), VERDICT.NO_LOGGER, 'the workstream\'s own false wins over the root true');
  });

  test('workstream scope: a workstream-only true enables the trail even when the root config is absent', () => {
    process.env.GSD_WORKSTREAM = 'alpha';
    writeConfig(path.join('.planning', 'workstreams', 'alpha'), JSON.stringify({ audit: { enabled: true } }));
    assert.equal(gateVerdict(), VERDICT.AUDIT_TRAIL);
  });

  test('workstream scope: an unparseable workstream config sets nothing, so the root value is inherited', () => {
    process.env.GSD_WORKSTREAM = 'alpha';
    writeConfig(path.join('.planning', 'workstreams', 'alpha'), '{"audit":');
    assert.equal(gateVerdict(), VERDICT.NO_LOGGER, 'broken workstream config and no root config: no logger');

    writeConfig('.planning', JSON.stringify({ audit: { enabled: true } }));
    assert.equal(gateVerdict(), VERDICT.AUDIT_TRAIL, 'broken workstream config: inherits the root true');
  });

  test('hostile env: a traversal-shaped GSD_WORKSTREAM degrades to no logger instead of throwing', () => {
    writeConfig('.planning', JSON.stringify({ audit: { enabled: true } }));
    process.env.GSD_WORKSTREAM = '../escape';
    assert.equal(gateVerdict(), VERDICT.NO_LOGGER);

    process.env.GSD_AUDIT = '1';
    assert.equal(gateVerdict(), VERDICT.AUDIT_TRAIL, 'GSD_AUDIT=1 still works when the config read degrades');
  });

  // ── Properties (RULESET.TESTS.property-based-testing) ──────────────────────
  // The gate parses arbitrary JSON config shapes into one strict boolean. The
  // invariant: with GSD_AUDIT unset, a logger is injected iff the resolved
  // `audit.enabled` value is exactly `true`; with GSD_AUDIT=1, always. Values
  // come from fast-check's JSON arbitraries, never from the gate's own writer.
  // Seed pinned to the issue number and runs bounded, so a failure replays.
  const PROPERTY_RUNS = { seed: 4975, numRuns: 100 };
  const NON_OBJECT = fc.oneof(
    fc.constant(null), fc.boolean(), fc.integer(), fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.string(), fc.array(fc.jsonValue(), { maxLength: 3 }),
  );

  test('property: a logger is injected iff audit.enabled is exactly true (GSD_AUDIT unset)', () => {
    fc.assert(
      fc.property(fc.oneof(fc.constant(true), fc.jsonValue()), (value) => {
        writeConfig('.planning', JSON.stringify({ audit: { enabled: value } }));
        return (resolveDispatchLogger(tmpDir) !== undefined) === (value === true);
      }),
      PROPERTY_RUNS,
    );
  });

  test('property: a non-object audit section or config root never injects a logger (GSD_AUDIT unset)', () => {
    fc.assert(
      fc.property(NON_OBJECT, fc.boolean(), (shape, atRoot) => {
        writeConfig('.planning', JSON.stringify(atRoot ? shape : { audit: shape }));
        return resolveDispatchLogger(tmpDir) === undefined;
      }),
      PROPERTY_RUNS,
    );
  });

  test('property: GSD_AUDIT=1 injects a logger whatever the config content', () => {
    process.env.GSD_AUDIT = '1';
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.jsonValue().map((v) => JSON.stringify(v))), (text) => {
        writeConfig('.planning', text);
        return resolveDispatchLogger(tmpDir) !== undefined;
      }),
      PROPERTY_RUNS,
    );
  });
});
