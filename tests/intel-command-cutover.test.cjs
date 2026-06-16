'use strict';
/**
 * intel-command-cutover.test.cjs — ADR-959 phase 4d-impl-4 equivalence tests.
 *
 * Verifies that the `intel` command family, after cutover from the hardcoded
 * `case 'intel':` arm in gsd-tools.cjs to the capability registry dispatch
 * path (default → dispatchCapabilityCommand → intel-command-router.cjs →
 * routeIntelCommand), behaves identically to the old inline case.
 *
 * Test categories:
 *   1. UNIT (recording mock) — precise arg/call equivalence for each subcommand
 *   2. DISPATCH — command reaches the router via default-case registry dispatch
 *   3. BEHAVIOR — subprocess output shape assertions (query, status, disabled gate)
 *   4. ERROR PATHS — unknown subcommand, usage (missing term/filePath)
 *   5. JSON-ERRORS — structured {ok:false,reason,message} for error paths
 *   6. REGISTRY — commandFamilies.intel, configSchema["intel.enabled"], capabilities.intel
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const registry = require('../gsd-core/bin/lib/capability-registry.cjs');
const { routeIntelCommand } = require('../gsd-core/bin/lib/intel-command-router.cjs');

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeErrorRecorder() {
  const calls = [];
  const fn = (msg, reason) => calls.push({ msg, reason });
  fn.calls = calls;
  return fn;
}

/**
 * Build a recording mock for the intel module.
 * Each function records its call and returns a sentinel so tests can assert
 * on WHICH function was called and with WHICH arguments without real I/O.
 */
function makeIntelMock(overrides = {}) {
  const calls = [];
  function recorder(name, ...fnArgs) {
    const sentinel = { _mock: name, args: fnArgs };
    calls.push(sentinel);
    return sentinel;
  }
  return {
    calls,
    mock: {
      intelQuery: (term, planningDir) => recorder('intelQuery', term, planningDir),
      intelStatus: (planningDir) => {
        const sentinel = recorder('intelStatus', planningDir);
        // Return a status with files so the timeAgo loop can be exercised
        sentinel.files = overrides.statusFiles ?? {};
        return sentinel;
      },
      intelDiff: (planningDir) => recorder('intelDiff', planningDir),
      intelSnapshot: (planningDir) => recorder('intelSnapshot', planningDir),
      intelValidate: (planningDir) => recorder('intelValidate', planningDir),
      intelUpdate: (planningDir) => recorder('intelUpdate', planningDir),
      intelApiSurface: (planningDir) => recorder('intelApiSurface', planningDir),
      intelPatchMeta: (filePath) => recorder('intelPatchMeta', filePath),
      intelExtractExports: (filePath) => recorder('intelExtractExports', filePath),
      ...overrides.methods,
    },
  };
}

function runJsonErrors(args, tmpDir, env = {}) {
  const result = runGsdTools(args, tmpDir, { ...env, GSD_JSON_ERRORS: '1' });
  assert.strictEqual(result.success, false,
    `Expected failure with GSD_JSON_ERRORS=1 for args: ${args.join(' ')}\n` +
    `stdout: ${result.output}\nstderr: ${result.error}`);
  let parsed;
  try {
    parsed = JSON.parse(result.error);
  } catch (e) {
    throw new Error(
      `GSD_JSON_ERRORS=1 must emit valid JSON on stderr.\n` +
      `Args: ${args.join(' ')}\nstderr: ${result.error}\nparse error: ${e.message}`,
    );
  }
  return parsed;
}

function assertTypedError(parsed, expectedReason, label) {
  assert.strictEqual(parsed.ok, false, `${label}: error object must have ok: false`);
  assert.strictEqual(parsed.reason, expectedReason,
    `${label}: reason must be "${expectedReason}", got: ${parsed.reason}`);
  assert.ok(typeof parsed.message === 'string' && parsed.message.length > 0,
    `${label}: message must be a non-empty string`);
}

function enableIntel(tmpDir) {
  const planningDir = path.join(tmpDir, '.planning');
  const configPath = path.join(planningDir, 'config.json');
  const config = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
    : {};
  // isIntelCapabilityActive() / isCapabilityActive('intel', cwd) requires the NESTED form { intel: { enabled: true } }.
  // A flat dotted key like config['intel.enabled'] = true is NOT recognised.
  config.intel = { ...(config.intel ?? {}), enabled: true };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

/**
 * Build a recording mock for the core module.
 * Captures all core.output() calls so no bytes reach real stdout.
 * Provides a deterministic timeAgo that returns a fixed relative string.
 */
function makeCoreMock() {
  const outputCalls = [];
  return {
    outputCalls,
    mock: {
      output: (value, raw) => { outputCalls.push({ value, raw }); },
      timeAgo: (_date) => '2 hours ago',
    },
  };
}

// ─── 1. UNIT — recording mocks (precise routing equivalence) ─────────────────

describe('intel router: unit tests via recording mocks', () => {
  const CWD = '/fake/cwd';
  const PLANNING_DIR = path.join(CWD, '.planning');

  // ── query ──────────────────────────────────────────────────────────────────

  test('routeIntelCommand query: calls intelQuery(term, planningDir)', () => {
    const m = makeIntelMock();
    const c = makeCoreMock();
    const intelCalls = [];
    const TERM = 'myterm';

    routeIntelCommand({
      args: ['intel', 'query', TERM],
      cwd: CWD,
      raw: false,
      error: makeErrorRecorder(),
      _core: c.mock,
      _intel: {
        ...m.mock,
        intelQuery: (term, planningDir) => {
          intelCalls.push({ fn: 'intelQuery', term, planningDir });
          return { matches: [], total: 0, term };
        },
      },
    });

    assert.strictEqual(intelCalls.length, 1, 'intelQuery must be called once');
    assert.strictEqual(intelCalls[0].term, TERM, 'term must be forwarded');
    assert.strictEqual(intelCalls[0].planningDir, PLANNING_DIR,
      'planningDir must be path.join(cwd, ".planning")');
    // core.output must be called with the query result (no real stdout write)
    assert.strictEqual(c.outputCalls.length, 1, 'core.output must be called once for query result');
  });

  test('routeIntelCommand query: missing term calls error(USAGE)', () => {
    const errFn = makeErrorRecorder();
    const c = makeCoreMock();
    routeIntelCommand({
      args: ['intel', 'query'],
      cwd: CWD, raw: false, error: errFn,
      _core: c.mock,
      _intel: makeIntelMock().mock,
    });
    assert.strictEqual(errFn.calls.length, 1, 'error must be called for missing term');
    assert.ok(errFn.calls[0].msg.includes('gsd-tools intel query <term>'),
      'usage error must mention correct usage');
    assert.strictEqual(errFn.calls[0].reason, 'usage',
      'reason must be "usage" (ERROR_REASON.USAGE)');
    // core.output must NOT be called on usage error (early return)
    assert.strictEqual(c.outputCalls.length, 0, 'core.output must not be called on usage error');
  });

  // ── status ─────────────────────────────────────────────────────────────────

  test('routeIntelCommand status (raw=false): calls intelStatus; applies timeAgo on updated_at', () => {
    const ISO_DATE = '2020-01-01T00:00:00.000Z';
    const statusCalls = [];
    let capturedStatus = null;
    const c = makeCoreMock();

    routeIntelCommand({
      args: ['intel', 'status'],
      cwd: CWD,
      raw: false,
      error: makeErrorRecorder(),
      _core: c.mock,
      _intel: {
        ...makeIntelMock().mock,
        intelStatus: (planningDir) => {
          statusCalls.push(planningDir);
          // Return a status object with a file that has updated_at
          capturedStatus = {
            files: {
              'file-roles.json': { updated_at: ISO_DATE, stale: false },
            },
            overall_stale: false,
          };
          return capturedStatus;
        },
      },
    });

    assert.strictEqual(statusCalls.length, 1, 'intelStatus must be called once');
    assert.strictEqual(statusCalls[0], PLANNING_DIR, 'planningDir must be path.join(cwd, ".planning")');
    // core.output must be called exactly once with the (mutated) status
    assert.strictEqual(c.outputCalls.length, 1, 'core.output must be called once for status result');
    assert.strictEqual(c.outputCalls[0].raw, false, 'core.output must be called with raw=false');
    // The timeAgo transform must have mutated updated_at on the status object
    // (c.mock.timeAgo returns '2 hours ago' deterministically)
    const updatedAt = capturedStatus.files['file-roles.json'].updated_at;
    assert.strictEqual(updatedAt, '2 hours ago',
      'non-raw mode: updated_at must be replaced with the timeAgo string from core.timeAgo()');
    assert.notStrictEqual(updatedAt, ISO_DATE,
      'non-raw mode: updated_at must no longer be an ISO string');
  });

  test('routeIntelCommand status (raw=true): calls intelStatus; does NOT apply timeAgo', () => {
    const ISO_DATE = '2020-01-01T00:00:00.000Z';
    let capturedStatus = null;
    const c = makeCoreMock();

    routeIntelCommand({
      args: ['intel', 'status'],
      cwd: CWD,
      raw: true,
      error: makeErrorRecorder(),
      _core: c.mock,
      _intel: {
        ...makeIntelMock().mock,
        intelStatus: (_planningDir) => {
          capturedStatus = {
            files: {
              'file-roles.json': { updated_at: ISO_DATE, stale: false },
            },
          };
          return capturedStatus;
        },
      },
    });

    // core.output must be called exactly once
    assert.strictEqual(c.outputCalls.length, 1, 'core.output must be called once for status result');
    assert.strictEqual(c.outputCalls[0].raw, true, 'core.output must be called with raw=true');
    // raw=true must skip the timeAgo loop — updated_at must remain unchanged
    const updatedAt = capturedStatus.files['file-roles.json'].updated_at;
    assert.strictEqual(updatedAt, ISO_DATE,
      'raw=true mode: updated_at must NOT be transformed — it must remain an ISO string');
  });

  test('routeIntelCommand status: files without updated_at are left untouched', () => {
    let capturedStatus = null;
    const c = makeCoreMock();

    routeIntelCommand({
      args: ['intel', 'status'],
      cwd: CWD,
      raw: false,
      error: makeErrorRecorder(),
      _core: c.mock,
      _intel: {
        ...makeIntelMock().mock,
        intelStatus: () => {
          capturedStatus = {
            files: {
              'some-file.json': { stale: true }, // no updated_at
            },
          };
          return capturedStatus;
        },
      },
    });

    // Must not error and file object must be unchanged (no updated_at added)
    assert.ok(!('updated_at' in capturedStatus.files['some-file.json']),
      'files without updated_at must not have it added by the transform');
    assert.strictEqual(c.outputCalls.length, 1, 'core.output must still be called once');
  });

  // ── planningDir-only subcommands ───────────────────────────────────────────

  for (const subcommand of ['diff', 'snapshot', 'validate', 'update', 'api-surface']) {
    // Build the expected function name: 'diff' → 'intelDiff', 'api-surface' → 'intelApiSurface'
    const fnName = 'intel' + subcommand.replace(/-([a-z])/g, (_, c) => c.toUpperCase()).replace(/^./, c => c.toUpperCase());

    test(`routeIntelCommand ${subcommand}: calls ${fnName}(planningDir)`, () => {
      const calls = [];
      const coreMock = makeCoreMock();
      const mockMethod = (planningDir) => {
        calls.push(planningDir);
        return { result: subcommand };
      };
      routeIntelCommand({
        args: ['intel', subcommand],
        cwd: CWD,
        raw: false,
        error: makeErrorRecorder(),
        _core: coreMock.mock,
        _intel: { ...makeIntelMock().mock, [fnName]: mockMethod },
      });
      assert.strictEqual(calls.length, 1, `${fnName} must be called once`);
      assert.strictEqual(calls[0], PLANNING_DIR,
        `${fnName} must be called with path.join(cwd, ".planning")`);
      assert.strictEqual(coreMock.outputCalls.length, 1, `core.output must be called once for ${subcommand}`);
    });
  }

  // ── patch-meta ─────────────────────────────────────────────────────────────

  test('routeIntelCommand patch-meta: calls intelPatchMeta(path.resolve(cwd, filePath))', () => {
    const calls = [];
    const c = makeCoreMock();
    const FILE_ARG = 'src/auth.ts';
    const EXPECTED = path.resolve(CWD, FILE_ARG);

    routeIntelCommand({
      args: ['intel', 'patch-meta', FILE_ARG],
      cwd: CWD,
      raw: false,
      error: makeErrorRecorder(),
      _core: c.mock,
      _intel: {
        ...makeIntelMock().mock,
        intelPatchMeta: (fp) => { calls.push(fp); return { ok: true }; },
      },
    });

    assert.strictEqual(calls.length, 1, 'intelPatchMeta must be called once');
    assert.strictEqual(calls[0], EXPECTED,
      'intelPatchMeta must receive path.resolve(cwd, filePath)');
    assert.strictEqual(c.outputCalls.length, 1, 'core.output must be called once for patch-meta result');
  });

  test('routeIntelCommand patch-meta: missing filePath calls error(USAGE)', () => {
    const errFn = makeErrorRecorder();
    const c = makeCoreMock();
    routeIntelCommand({
      args: ['intel', 'patch-meta'],
      cwd: CWD, raw: false, error: errFn,
      _core: c.mock,
      _intel: makeIntelMock().mock,
    });
    assert.strictEqual(errFn.calls.length, 1, 'error must be called for missing filePath');
    assert.ok(errFn.calls[0].msg.includes('gsd-tools intel patch-meta <file-path>'),
      'usage error must mention correct usage');
    assert.strictEqual(errFn.calls[0].reason, 'usage',
      'reason must be "usage" (ERROR_REASON.USAGE)');
    assert.strictEqual(c.outputCalls.length, 0, 'core.output must not be called on usage error');
  });

  // ── extract-exports ────────────────────────────────────────────────────────

  test('routeIntelCommand extract-exports: calls intelExtractExports(path.resolve(cwd, filePath))', () => {
    const calls = [];
    const c = makeCoreMock();
    const FILE_ARG = 'lib/io.cjs';
    const EXPECTED = path.resolve(CWD, FILE_ARG);

    routeIntelCommand({
      args: ['intel', 'extract-exports', FILE_ARG],
      cwd: CWD,
      raw: false,
      error: makeErrorRecorder(),
      _core: c.mock,
      _intel: {
        ...makeIntelMock().mock,
        intelExtractExports: (fp) => { calls.push(fp); return { exports: [] }; },
      },
    });

    assert.strictEqual(calls.length, 1, 'intelExtractExports must be called once');
    assert.strictEqual(calls[0], EXPECTED,
      'intelExtractExports must receive path.resolve(cwd, filePath)');
    assert.strictEqual(c.outputCalls.length, 1, 'core.output must be called once for extract-exports result');
  });

  test('routeIntelCommand extract-exports: missing filePath calls error(USAGE)', () => {
    const errFn = makeErrorRecorder();
    const c = makeCoreMock();
    routeIntelCommand({
      args: ['intel', 'extract-exports'],
      cwd: CWD, raw: false, error: errFn,
      _core: c.mock,
      _intel: makeIntelMock().mock,
    });
    assert.strictEqual(errFn.calls.length, 1, 'error must be called for missing filePath');
    assert.ok(errFn.calls[0].msg.includes('gsd-tools intel extract-exports <file-path>'),
      'usage error must mention correct usage');
    assert.strictEqual(errFn.calls[0].reason, 'usage',
      'reason must be "usage" (ERROR_REASON.USAGE)');
    assert.strictEqual(c.outputCalls.length, 0, 'core.output must not be called on usage error');
  });

  // ── unknown subcommand ─────────────────────────────────────────────────────

  test('routeIntelCommand unknown subcommand: calls error(SDK_UNKNOWN_COMMAND)', () => {
    const errFn = makeErrorRecorder();
    const c = makeCoreMock();
    routeIntelCommand({
      args: ['intel', 'nonexistent'],
      cwd: CWD, raw: false, error: errFn,
      _core: c.mock,
      _intel: makeIntelMock().mock,
    });
    assert.strictEqual(errFn.calls.length, 1, 'error must be called for unknown subcommand');
    assert.ok(errFn.calls[0].msg.includes('Unknown intel subcommand'),
      `error message must say "Unknown intel subcommand"`);
    assert.strictEqual(errFn.calls[0].reason, 'sdk_unknown_command',
      'reason must be "sdk_unknown_command" (ERROR_REASON.SDK_UNKNOWN_COMMAND)');
    assert.strictEqual(c.outputCalls.length, 0, 'core.output must not be called for unknown subcommand');
  });
});

// ─── 2. DISPATCH — intel reaches the router via default-case registry ─────────

describe('intel cutover: dispatch path (default-case → capability registry)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-intel-cutover-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('intel subcommand does not emit "Unknown command: intel" (reaches capability router)', () => {
    // With intel.enabled absent/false the router will return a disabled payload —
    // but it must NOT fall through to the "Unknown command" error.
    const result = runGsdTools(['intel', 'status'], tmpDir);
    const stderr = result.error || '';
    assert.strictEqual(
      stderr.includes('Unknown command: intel'),
      false,
      `Must not emit "Unknown command: intel". stderr: ${stderr}`,
    );
    // The disabled gate returns a JSON payload (exit 0) — or the command succeeds
    assert.ok(result.success,
      `intel status must exit 0. stderr: ${stderr}`);
  });

  test('intel status --raw dispatches correctly (no "Unknown command")', () => {
    const result = runGsdTools(['intel', 'status', '--raw'], tmpDir);
    const stderr = result.error || '';
    assert.strictEqual(
      stderr.includes('Unknown command: intel'),
      false,
      `intel status --raw must not emit "Unknown command: intel". stderr: ${stderr}`,
    );
  });
});

// ─── 3. BEHAVIOR — subprocess output shape (equivalence to old inline cases) ──

describe('intel cutover: output shape equivalence', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-intel-behavior-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('intel status (disabled gate): exits 0, produces JSON payload with disabled:true', () => {
    // intel.enabled absent — disabled gate response from intel.cjs
    const result = runGsdTools(['intel', 'status'], tmpDir);
    assert.ok(result.success, `intel status must exit 0. stderr: ${result.error}`);
    let parsed;
    assert.doesNotThrow(
      () => { parsed = JSON.parse(result.output); },
      'intel status must emit valid JSON when disabled',
    );
    assert.strictEqual(parsed.disabled, true, 'disabled gate must set disabled: true');
  });

  test('intel query (disabled gate): exits 0, produces JSON with disabled:true', () => {
    const result = runGsdTools(['intel', 'query', 'someterm'], tmpDir);
    assert.ok(result.success, `intel query must exit 0 (disabled gate). stderr: ${result.error}`);
    let parsed;
    assert.doesNotThrow(
      () => { parsed = JSON.parse(result.output); },
      'intel query disabled gate must emit valid JSON',
    );
    assert.strictEqual(parsed.disabled, true, 'disabled gate must set disabled: true on query');
  });

  test('intel status --raw (disabled gate): exits 0, produces JSON', () => {
    const result = runGsdTools(['intel', 'status', '--raw'], tmpDir);
    assert.ok(result.success, `intel status --raw must exit 0. stderr: ${result.error}`);
    let parsed;
    assert.doesNotThrow(
      () => { parsed = JSON.parse(result.output); },
      'intel status --raw must emit valid JSON',
    );
    assert.strictEqual(parsed.disabled, true, 'raw disabled gate must still set disabled: true');
  });

  test('intel status (non-raw, enabled, with intel files): updated_at is a timeAgo string', () => {
    enableIntel(tmpDir);
    const planningDir = path.join(tmpDir, '.planning');
    const intelDir = path.join(planningDir, 'intel');
    fs.mkdirSync(intelDir, { recursive: true });

    // Write a file-roles.json intel file with an old updated_at
    const oldDate = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago
    const intelData = {
      _meta: { updated_at: oldDate },
      entries: {},
    };
    fs.writeFileSync(path.join(intelDir, 'file-roles.json'), JSON.stringify(intelData, null, 2), 'utf8');

    const result = runGsdTools(['intel', 'status'], tmpDir);
    assert.ok(result.success, `intel status must exit 0. stderr: ${result.error}`);
    let parsed;
    assert.doesNotThrow(
      () => { parsed = JSON.parse(result.output); },
      'intel status must emit valid JSON',
    );
    // Confirm intel is actually ENABLED (not hitting the disabled gate)
    assert.strictEqual(parsed.disabled, undefined,
      `intel must be enabled; got disabled gate response instead. config may not be nested correctly.\noutput: ${result.output}`);
    // Non-raw: file-roles.json must be present with updated_at set
    const fileEntry = parsed.files?.['file-roles.json'];
    assert.ok(fileEntry, `intel status must include file-roles.json in files. Got: ${JSON.stringify(parsed)}`);
    assert.ok(fileEntry.updated_at,
      `file-roles.json must have updated_at. Got: ${JSON.stringify(fileEntry)}`);
    // The timeAgo transform converts ISO → "X hours ago" (never an ISO format)
    const isIso = /^\d{4}-\d{2}-\d{2}T/.test(fileEntry.updated_at);
    assert.strictEqual(isIso, false,
      `Non-raw updated_at must be a timeAgo string, not an ISO date. Got: ${fileEntry.updated_at}`);
  });

  test('intel status raw=true (enabled, with intel files): updated_at remains an ISO string', () => {
    enableIntel(tmpDir);
    const planningDir = path.join(tmpDir, '.planning');
    const intelDir = path.join(planningDir, 'intel');
    fs.mkdirSync(intelDir, { recursive: true });

    const isoDate = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const intelData = {
      _meta: { updated_at: isoDate },
      entries: {},
    };
    fs.writeFileSync(path.join(intelDir, 'file-roles.json'), JSON.stringify(intelData, null, 2), 'utf8');

    const result = runGsdTools(['intel', 'status', '--raw'], tmpDir);
    assert.ok(result.success, `intel status --raw must exit 0. stderr: ${result.error}`);
    let parsed;
    assert.doesNotThrow(
      () => { parsed = JSON.parse(result.output); },
      'intel status --raw must emit valid JSON',
    );
    // Confirm intel is actually ENABLED (not hitting the disabled gate)
    assert.strictEqual(parsed.disabled, undefined,
      `intel must be enabled; got disabled gate response instead. config may not be nested correctly.\noutput: ${result.output}`);
    // raw=true: file-roles.json must be present with updated_at set
    const fileEntry = parsed.files?.['file-roles.json'];
    assert.ok(fileEntry, `intel status --raw must include file-roles.json in files. Got: ${JSON.stringify(parsed)}`);
    assert.ok(fileEntry.updated_at,
      `file-roles.json must have updated_at in raw mode. Got: ${JSON.stringify(fileEntry)}`);
    // raw=true: updated_at must remain an ISO string (no timeAgo transform)
    const isIso = /^\d{4}-\d{2}-\d{2}T/.test(fileEntry.updated_at);
    assert.strictEqual(isIso, true,
      `--raw updated_at must remain an ISO string. Got: ${fileEntry.updated_at}`);
  });
});

// ─── 4. ERROR PATHS — unknown subcommand, usage errors ───────────────────────

describe('intel cutover: error paths (exit non-zero + correct messages)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-intel-err-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('intel query (missing term): exits non-zero, emits usage message', () => {
    const result = runGsdTools(['intel', 'query'], tmpDir);
    assert.strictEqual(result.success, false, 'intel query without term must exit non-zero');
    const output = result.error + result.output;
    assert.ok(
      output.includes('gsd-tools intel query <term>'),
      `Must emit usage hint for missing term. Got: ${output}`,
    );
  });

  test('intel patch-meta (missing filePath): exits non-zero, emits usage message', () => {
    const result = runGsdTools(['intel', 'patch-meta'], tmpDir);
    assert.strictEqual(result.success, false, 'intel patch-meta without filePath must exit non-zero');
    const output = result.error + result.output;
    assert.ok(
      output.includes('gsd-tools intel patch-meta <file-path>'),
      `Must emit usage hint for missing filePath. Got: ${output}`,
    );
  });

  test('intel extract-exports (missing filePath): exits non-zero, emits usage message', () => {
    const result = runGsdTools(['intel', 'extract-exports'], tmpDir);
    assert.strictEqual(result.success, false, 'intel extract-exports without filePath must exit non-zero');
    const output = result.error + result.output;
    assert.ok(
      output.includes('gsd-tools intel extract-exports <file-path>'),
      `Must emit usage hint for missing filePath. Got: ${output}`,
    );
  });

  test('intel unknown subcommand: exits non-zero, emits "Unknown intel subcommand"', () => {
    const result = runGsdTools(['intel', 'bogussubcmd'], tmpDir);
    assert.strictEqual(result.success, false, 'intel unknown subcommand must exit non-zero');
    const output = result.error + result.output;
    assert.ok(
      output.includes('Unknown intel subcommand'),
      `Must emit "Unknown intel subcommand". Got: ${output}`,
    );
    // Must list all 9 valid subcommands
    const EXPECTED_SUBCMDS = ['query', 'status', 'update', 'diff', 'snapshot', 'patch-meta', 'validate', 'extract-exports', 'api-surface'];
    for (const sc of EXPECTED_SUBCMDS) {
      assert.ok(output.includes(sc),
        `Unknown subcommand error must list "${sc}". Got: ${output}`);
    }
  });
});

// ─── 5. JSON-ERRORS — GSD_JSON_ERRORS mode ───────────────────────────────────

describe('intel cutover: GSD_JSON_ERRORS structured error payloads', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-intel-jsonerr-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('intel query (missing term) with GSD_JSON_ERRORS=1 emits {ok:false,reason:"usage"}', () => {
    const parsed = runJsonErrors(['intel', 'query'], tmpDir);
    assertTypedError(parsed, 'usage', 'intel query missing term');
    assert.ok(parsed.message.includes('gsd-tools intel query <term>'),
      'usage message must include the usage hint');
  });

  test('intel patch-meta (missing filePath) with GSD_JSON_ERRORS=1 emits {ok:false,reason:"usage"}', () => {
    const parsed = runJsonErrors(['intel', 'patch-meta'], tmpDir);
    assertTypedError(parsed, 'usage', 'intel patch-meta missing filePath');
    assert.ok(parsed.message.includes('gsd-tools intel patch-meta <file-path>'),
      'usage message must include the usage hint');
  });

  test('intel extract-exports (missing filePath) with GSD_JSON_ERRORS=1 emits {ok:false,reason:"usage"}', () => {
    const parsed = runJsonErrors(['intel', 'extract-exports'], tmpDir);
    assertTypedError(parsed, 'usage', 'intel extract-exports missing filePath');
    assert.ok(parsed.message.includes('gsd-tools intel extract-exports <file-path>'),
      'usage message must include the usage hint');
  });

  test('intel unknown subcommand with GSD_JSON_ERRORS=1 emits {ok:false,reason:"sdk_unknown_command"}', () => {
    const parsed = runJsonErrors(['intel', 'notasubcmd'], tmpDir);
    assertTypedError(parsed, 'sdk_unknown_command', 'intel unknown subcommand');
    assert.ok(parsed.message.includes('Unknown intel subcommand'),
      'sdk_unknown_command message must say "Unknown intel subcommand"');
  });

  test('intel status (disabled gate) with GSD_JSON_ERRORS=1 does NOT emit error payload (succeeds)', () => {
    // The disabled gate is not a CLI error — it exits 0 with a JSON payload
    const result = runGsdTools(['intel', 'status'], tmpDir, { GSD_JSON_ERRORS: '1' });
    assert.ok(result.success,
      `intel status disabled gate must exit 0 with GSD_JSON_ERRORS=1. stderr: ${result.error}`);
  });
});

// ─── 6. REGISTRY — commandFamilies.intel + configSchema + capabilities.intel ──

describe('intel cutover: registry entries correct', () => {
  test('commandFamilies["intel"] present and well-shaped', () => {
    const entry = registry.commandFamilies['intel'];
    assert.ok(entry, 'commandFamilies["intel"] must be present');
    assert.strictEqual(entry.capId, 'intel',
      'commandFamilies["intel"].capId must be "intel"');
    assert.strictEqual(entry.module, 'intel-command-router.cjs',
      'commandFamilies["intel"].module must be "intel-command-router.cjs"');
    assert.strictEqual(entry.router, 'routeIntelCommand',
      'commandFamilies["intel"].router must be "routeIntelCommand"');
  });

  test('capabilities.intel present with role:feature and tier:full', () => {
    const cap = registry.capabilities.intel;
    assert.ok(cap, 'capabilities.intel must be present');
    assert.strictEqual(cap.role, 'feature', 'intel capability must have role: feature');
    assert.strictEqual(cap.tier, 'full', 'intel capability must have tier: full');
  });

  test('capabilities.intel.commands has exactly one entry with family "intel"', () => {
    const cap = registry.capabilities.intel;
    assert.ok(Array.isArray(cap.commands) && cap.commands.length === 1,
      'intel capability must have exactly 1 command');
    const cmd = cap.commands[0];
    assert.strictEqual(cmd.family, 'intel', 'command family must be "intel"');
    assert.strictEqual(cmd.module, 'intel-command-router.cjs',
      'command module must be "intel-command-router.cjs"');
    assert.strictEqual(cmd.router, 'routeIntelCommand',
      'command router must be "routeIntelCommand"');
  });

  test('configSchema["intel.enabled"] present with expected shape', () => {
    const schemaEntry = registry.configSchema['intel.enabled'];
    assert.ok(schemaEntry, 'configSchema["intel.enabled"] must be present');
    assert.strictEqual(schemaEntry.owner, 'intel',
      'configSchema["intel.enabled"].owner must be "intel"');
    assert.strictEqual(schemaEntry.type, 'boolean',
      'intel.enabled must have type: boolean');
    assert.strictEqual(schemaEntry.default, false,
      'intel.enabled must default to false');
  });

  test('routeIntelCommand is an exported function', () => {
    assert.strictEqual(typeof routeIntelCommand, 'function',
      'routeIntelCommand must be an exported function');
  });

  test('intel has no skills — vacuous profileMembership (no entry)', () => {
    // intel capability declares skills:[] → no skill-cluster-based profileMembership entry
    const cap = registry.capabilities.intel;
    assert.deepStrictEqual(cap.skills, [],
      'intel capability must have empty skills array');
    const pm = registry.profileMembership.intel;
    assert.strictEqual(pm, undefined,
      'profileMembership.intel must be undefined (no skills declared)');
  });

  test('intel has no skills — vacuous capabilityClusters (no entry)', () => {
    const clusters = registry.capabilityClusters.intel;
    assert.strictEqual(clusters, undefined,
      'capabilityClusters.intel must be undefined (no skills declared)');
  });

  test('graphify/audit-uat/audit-open commandFamilies entries still present (no regression)', () => {
    assert.ok(registry.commandFamilies['graphify'], 'commandFamilies["graphify"] must still be present');
    assert.ok(registry.commandFamilies['audit-uat'], 'commandFamilies["audit-uat"] must still be present');
    assert.ok(registry.commandFamilies['audit-open'], 'commandFamilies["audit-open"] must still be present');
  });
});
