'use strict';
/**
 * graphify-command-cutover.test.cjs — ADR-959 phase 4d-impl-2 equivalence tests.
 *
 * Verifies that the `graphify` command family, after cutover from the hardcoded
 * `case 'graphify':` arm in gsd-tools.cjs to the capability registry dispatch
 * path (default → dispatchCapabilityCommand → graphify-command-router.cjs →
 * routeGraphifyCommand), behaves identically to the old inline case.
 *
 * Test categories:
 *   1. UNIT (recording mock) — precise arg/call equivalence for every routing path
 *   2. DISPATCH — command reaches the router via default-case registry dispatch
 *   3. SUBCOMMANDS — subprocess tests with real output-shape assertions
 *   4. ERROR PATHS — unknown subcommand, usage (missing term), disabled gate
 *   5. JSON-ERRORS — structured {ok:false,reason,message} on usage/unknown errors
 *   6. REGISTRY — commandFamilies/bySkill/configSchema/profileMembership/capabilityClusters
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const {
  enableGraphify,
  writeGraphJson,
  SAMPLE_GRAPH,
} = require('./helpers/graphify.cjs');

const registry = require('../gsd-core/bin/lib/capability-registry.cjs');
const { routeGraphifyCommand } = require('../gsd-core/bin/lib/graphify-command-router.cjs');

// ─── helpers ────────────────────────────────────────────────────────────────

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

/**
 * Build a recording mock for the graphify module.
 * Each public function records its call and returns a sentinel object
 * `{ _mock: '<fnName>', args: [...] }` so tests can assert on WHICH function
 * was called and with WHICH arguments without running real I/O.
 */
function makeGraphifyMock() {
  const calls = [];
  function recorder(name, ...fnArgs) {
    const sentinel = { _mock: name, args: fnArgs };
    calls.push(sentinel);
    return sentinel;
  }
  return {
    calls,
    mock: {
      graphifyQuery: (cwd, term, opts) => recorder('graphifyQuery', cwd, term, opts),
      graphifyStatus: (cwd) => recorder('graphifyStatus', cwd),
      graphifyDiff: (cwd) => recorder('graphifyDiff', cwd),
      graphifyBuild: (cwd) => recorder('graphifyBuild', cwd),
      writeSnapshot: (cwd) => recorder('writeSnapshot', cwd),
    },
  };
}

// ─── 1. UNIT — precise routing equivalence via recording mock ─────────────────

describe('graphify router: precise unit tests (recording mock)', () => {
  const CWD = '/fake/cwd';
  const RAW = false;

  function makeErrorRecorder() {
    const calls = [];
    const fn = (msg, reason) => calls.push({ msg, reason });
    fn.calls = calls;
    return fn;
  }

  test('query with term → calls graphifyQuery(cwd, term, { budget: null })', () => {
    const { calls, mock } = makeGraphifyMock();
    const errFn = makeErrorRecorder();
    routeGraphifyCommand({
      args: ['graphify', 'query', 'myterm'],
      cwd: CWD, raw: RAW, error: errFn, _graphify: mock,
    });
    assert.strictEqual(errFn.calls.length, 0, 'error must not be called');
    assert.strictEqual(calls.length, 1, 'exactly one graphify fn called');
    assert.strictEqual(calls[0]._mock, 'graphifyQuery');
    assert.deepStrictEqual(calls[0].args, [CWD, 'myterm', { budget: null }]);
  });

  test('query with --budget → calls graphifyQuery(cwd, term, { budget: 5 }) as integer', () => {
    const { calls, mock } = makeGraphifyMock();
    const errFn = makeErrorRecorder();
    routeGraphifyCommand({
      args: ['graphify', 'query', 'myterm', '--budget', '5'],
      cwd: CWD, raw: RAW, error: errFn, _graphify: mock,
    });
    assert.strictEqual(errFn.calls.length, 0, 'error must not be called');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]._mock, 'graphifyQuery');
    // budget must be parsed as integer 5, not the string '5'
    assert.deepStrictEqual(calls[0].args, [CWD, 'myterm', { budget: 5 }]);
    assert.strictEqual(typeof calls[0].args[2].budget, 'number',
      'budget must be a number, not a string');
  });

  test('query missing term → error(usage msg, USAGE); graphifyQuery NOT called', () => {
    const { calls, mock } = makeGraphifyMock();
    const errFn = makeErrorRecorder();
    routeGraphifyCommand({
      args: ['graphify', 'query'],
      cwd: CWD, raw: RAW, error: errFn, _graphify: mock,
    });
    assert.strictEqual(errFn.calls.length, 1, 'error must be called once');
    assert.ok(
      errFn.calls[0].msg.includes('Usage: gsd-tools graphify query <term>'),
      `usage message must match exactly; got: ${errFn.calls[0].msg}`,
    );
    assert.strictEqual(errFn.calls[0].reason, 'usage',
      `reason must be 'usage'; got: ${errFn.calls[0].reason}`);
    assert.strictEqual(calls.length, 0, 'graphifyQuery must NOT be called');
  });

  test('status → calls graphifyStatus(cwd)', () => {
    const { calls, mock } = makeGraphifyMock();
    const errFn = makeErrorRecorder();
    routeGraphifyCommand({
      args: ['graphify', 'status'],
      cwd: CWD, raw: RAW, error: errFn, _graphify: mock,
    });
    assert.strictEqual(errFn.calls.length, 0);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]._mock, 'graphifyStatus');
    assert.deepStrictEqual(calls[0].args, [CWD]);
  });

  test('diff → calls graphifyDiff(cwd)', () => {
    const { calls, mock } = makeGraphifyMock();
    const errFn = makeErrorRecorder();
    routeGraphifyCommand({
      args: ['graphify', 'diff'],
      cwd: CWD, raw: RAW, error: errFn, _graphify: mock,
    });
    assert.strictEqual(errFn.calls.length, 0);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]._mock, 'graphifyDiff');
    assert.deepStrictEqual(calls[0].args, [CWD]);
  });

  test('build (no snapshot) → calls graphifyBuild(cwd); NOT writeSnapshot', () => {
    const { calls, mock } = makeGraphifyMock();
    const errFn = makeErrorRecorder();
    routeGraphifyCommand({
      args: ['graphify', 'build'],
      cwd: CWD, raw: RAW, error: errFn, _graphify: mock,
    });
    assert.strictEqual(errFn.calls.length, 0);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]._mock, 'graphifyBuild',
      'build without "snapshot" arg must call graphifyBuild, NOT writeSnapshot');
    assert.deepStrictEqual(calls[0].args, [CWD]);
    const wroteSnapshot = calls.some(c => c._mock === 'writeSnapshot');
    assert.strictEqual(wroteSnapshot, false, 'writeSnapshot must NOT be called for plain build');
  });

  test('build snapshot → calls writeSnapshot(cwd); NOT graphifyBuild', () => {
    const { calls, mock } = makeGraphifyMock();
    const errFn = makeErrorRecorder();
    routeGraphifyCommand({
      args: ['graphify', 'build', 'snapshot'],
      cwd: CWD, raw: RAW, error: errFn, _graphify: mock,
    });
    assert.strictEqual(errFn.calls.length, 0);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]._mock, 'writeSnapshot',
      'build snapshot must call writeSnapshot, NOT graphifyBuild');
    assert.deepStrictEqual(calls[0].args, [CWD]);
    const calledBuild = calls.some(c => c._mock === 'graphifyBuild');
    assert.strictEqual(calledBuild, false, 'graphifyBuild must NOT be called for build snapshot');
  });

  test('unknown subcommand → error(sdk_unknown_command); no graphify fn called', () => {
    const { calls, mock } = makeGraphifyMock();
    const errFn = makeErrorRecorder();
    routeGraphifyCommand({
      args: ['graphify', 'bogus'],
      cwd: CWD, raw: RAW, error: errFn, _graphify: mock,
    });
    assert.strictEqual(errFn.calls.length, 1, 'error must be called once');
    assert.ok(
      errFn.calls[0].msg.includes('Unknown graphify subcommand'),
      `unknown-subcommand message must include "Unknown graphify subcommand"; got: ${errFn.calls[0].msg}`,
    );
    assert.ok(
      errFn.calls[0].msg.includes('build') &&
      errFn.calls[0].msg.includes('query') &&
      errFn.calls[0].msg.includes('status') &&
      errFn.calls[0].msg.includes('diff'),
      `unknown-subcommand message must list all subcommands; got: ${errFn.calls[0].msg}`,
    );
    assert.strictEqual(errFn.calls[0].reason, 'sdk_unknown_command',
      `reason must be 'sdk_unknown_command'; got: ${errFn.calls[0].reason}`);
    assert.strictEqual(calls.length, 0, 'no graphify fn must be called for unknown subcommand');
  });
});

// ─── 2. DISPATCH — command reaches router via default-case ───────────────────

describe('graphify cutover: dispatch path (default-case → capability registry)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('graphify status dispatches via capability registry (not hardcoded case)', () => {
    // With graphify disabled the router returns a disabledResponse; the key
    // assertion here is that the command REACHES the router at all (no
    // "Unknown command: graphify" error) — proving default→registry dispatch.
    const result = runGsdTools(['graphify', 'status'], tmpDir);
    // graphify disabled → status returns disabled response JSON (not unknown-command error)
    assert.ok(result.success, `Expected success (disabled response), got error: ${result.error}`);
    const isUnknownCommand = (result.error || '').includes('Unknown command: graphify');
    assert.strictEqual(isUnknownCommand, false, 'Must not emit "Unknown command: graphify"');
  });

  test('unknown subcommand emits sdk_unknown_command (proves router reached)', () => {
    // If dispatch failed we'd see "Unknown command: graphify" with reason
    // sdk_unknown_command. Getting "Unknown graphify subcommand" confirms the
    // router was reached.
    const parsed = runJsonErrors(['graphify', 'bogus-xyzzy'], tmpDir);
    assertTypedError(parsed, 'sdk_unknown_command', 'unknown-subcommand dispatch proof');
    assert.ok(
      parsed.message.includes('graphify') || parsed.message.includes('Unknown'),
      `message should mention graphify or Unknown subcommand; got: ${parsed.message}`,
    );
  });
});

// ─── 3. SUBCOMMANDS — subprocess tests with real output-shape assertions ──────

describe('graphify cutover: subcommand behavior equivalence', () => {
  let tmpDir;
  let planningDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    planningDir = path.join(tmpDir, '.planning');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('status (disabled) → disabled response with disabled:true', () => {
    const result = runGsdTools(['graphify', 'status'], tmpDir);
    assert.ok(result.success, `Expected success; error: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.disabled, true, 'disabled graphify: disabled must be true');
  });

  test('status (enabled, no graph) → exists:false shape distinguishes from disabled', () => {
    enableGraphify(planningDir);
    const result = runGsdTools(['graphify', 'status'], tmpDir);
    assert.ok(result.success, `Expected success; error: ${result.error}`);
    const parsed = JSON.parse(result.output);
    // enabled but no graph → { exists: false } — NOT { disabled: true }
    assert.notStrictEqual(parsed.disabled, true,
      'enabled graphify status: disabled must not be true');
    assert.strictEqual(parsed.exists, false,
      'enabled graphify status (no graph): exists must be false');
  });

  test('status (enabled, with graph) → exists:true with node_count/edge_count fields', () => {
    enableGraphify(planningDir);
    writeGraphJson(planningDir, SAMPLE_GRAPH);
    const result = runGsdTools(['graphify', 'status'], tmpDir);
    assert.ok(result.success, `Expected success; error: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.exists, true,
      'status with graph: exists must be true');
    assert.ok('node_count' in parsed,
      'status with graph must include node_count field');
    assert.ok('edge_count' in parsed,
      'status with graph must include edge_count field');
    assert.strictEqual(parsed.node_count, SAMPLE_GRAPH.nodes.length,
      `node_count must match graph: got ${parsed.node_count}, expected ${SAMPLE_GRAPH.nodes.length}`);
    // status shape is distinct from query/diff/build by presence of exists+node_count
    assert.ok(!('term' in parsed),
      'status shape must not have term field (would indicate wrong function called)');
    assert.ok(!('action' in parsed),
      'status shape must not have action field (would indicate build was called instead)');
  });

  test('diff (enabled, no snapshot) → no_baseline:true shape (distinct from status/query/build)', () => {
    enableGraphify(planningDir);
    const result = runGsdTools(['graphify', 'diff'], tmpDir);
    assert.ok(result.success, `Expected success; error: ${result.error}`);
    const parsed = JSON.parse(result.output);
    // diff with no snapshot → { no_baseline: true }
    assert.strictEqual(parsed.no_baseline, true,
      'diff (no snapshot) must return no_baseline:true — routing reached diff handler');
    // Shape is distinct from status (which has exists:) and query (which has term:)
    assert.ok(!('exists' in parsed),
      'diff response must not have exists field (would indicate status was called instead)');
    assert.ok(!('term' in parsed),
      'diff response must not have term field (would indicate query was called instead)');
  });

  test('build (enabled, no graphify binary) → action:spawn_agent shape (distinct from snapshot)', () => {
    enableGraphify(planningDir);
    const result = runGsdTools(['graphify', 'build'], tmpDir);
    // graphify binary is not installed in test environments → graphifyBuild returns
    // an error about missing binary, NOT action:spawn_agent.  Either way, the output
    // shape is from graphifyBuild (not writeSnapshot which returns {saved:true,...}).
    const parsed = JSON.parse(result.output);
    // graphifyBuild with no binary → { error: '...' } (installed check failed)
    // graphifyBuild with binary → { action: 'spawn_agent', ... }
    // writeSnapshot → { saved: true, timestamp, node_count, edge_count }
    // Key: must NOT be snapshot's {saved:true} shape
    assert.strictEqual(parsed.saved, undefined,
      'build (not snapshot) must NOT return saved:true — routing must call graphifyBuild not writeSnapshot');
    assert.ok('error' in parsed || 'action' in parsed,
      `build must return graphifyBuild shape ({error:...} or {action:...}); got: ${JSON.stringify(parsed)}`);
  });

  test('build snapshot (enabled) → saved:true shape (distinct from plain build)', () => {
    enableGraphify(planningDir);
    // write graph.json so writeSnapshot can read it
    writeGraphJson(planningDir, SAMPLE_GRAPH);
    const result = runGsdTools(['graphify', 'build', 'snapshot'], tmpDir);
    assert.ok(result.success, `Expected success; error: ${result.error}`);
    const parsed = JSON.parse(result.output);
    // writeSnapshot → { saved: true, timestamp: <ISO>, node_count: N, edge_count: M }
    assert.strictEqual(parsed.saved, true,
      'build snapshot must return saved:true — routing must call writeSnapshot, not graphifyBuild');
    assert.ok('timestamp' in parsed,
      'build snapshot result must include timestamp field');
    assert.ok('node_count' in parsed,
      'build snapshot result must include node_count field');
    assert.ok('edge_count' in parsed,
      'build snapshot result must include edge_count field');
    // Shape must NOT be graphifyBuild shape (which has action: or error:)
    assert.strictEqual(parsed.action, undefined,
      'build snapshot must not have action field (that would be graphifyBuild, not writeSnapshot)');
  });

  test('query with term (enabled, with graph) → term field echoed in response', () => {
    enableGraphify(planningDir);
    writeGraphJson(planningDir, SAMPLE_GRAPH);
    const result = runGsdTools(['graphify', 'query', 'AuthService'], tmpDir);
    assert.ok(result.success, `Expected success; error: ${result.error}`);
    const parsed = JSON.parse(result.output);
    // graphifyQuery → { term, nodes, edges, total_nodes, total_edges, trimmed }
    assert.strictEqual(parsed.term, 'AuthService',
      'query response must echo the search term — confirms graphifyQuery was called');
    assert.ok('nodes' in parsed,
      'query response must include nodes array');
    assert.ok('total_nodes' in parsed,
      'query response must include total_nodes field');
    // Shape distinct from status (exists), diff (no_baseline), build (action/saved)
    assert.strictEqual(parsed.exists, undefined,
      'query must not have exists field (that would be status)');
    assert.strictEqual(parsed.saved, undefined,
      'query must not have saved field (that would be writeSnapshot)');
  });

  test('query with --budget flag → same term field, budget applied (NaN budget graceful)', () => {
    enableGraphify(planningDir);
    writeGraphJson(planningDir, SAMPLE_GRAPH);
    const result = runGsdTools(['graphify', 'query', 'AuthService', '--budget', '5'], tmpDir);
    assert.ok(result.success, `Expected success; error: ${result.error}`);
    const parsed = JSON.parse(result.output);
    // Must still return the query shape (term echoed), not a routing error
    assert.strictEqual(parsed.term, 'AuthService',
      'query+--budget must echo term — confirms graphifyQuery reached with --budget arg');
    // Confirms it's not a build/snapshot shape (which would have saved:/action:)
    assert.strictEqual(parsed.saved, undefined, 'must not be writeSnapshot shape');
    assert.strictEqual(parsed.action, undefined, 'must not be graphifyBuild shape');
  });

  test('diff (disabled) → disabled response with disabled:true', () => {
    const result = runGsdTools(['graphify', 'diff'], tmpDir);
    assert.ok(result.success, `Expected success (disabled); error: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.disabled, true, 'disabled diff: disabled must be true');
  });
});

// ─── 4. ERROR PATHS ──────────────────────────────────────────────────────────

describe('graphify cutover: error path equivalence', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('unknown subcommand → non-zero exit', () => {
    const result = runGsdTools(['graphify', 'bogus-sub-xyzzy'], tmpDir);
    assert.strictEqual(result.success, false, 'unknown subcommand must fail');
  });

  test('unknown subcommand error message mentions expected subcommands', () => {
    const result = runGsdTools(['graphify', 'bogus-sub-xyzzy'], tmpDir);
    assert.ok(
      result.error.includes('build') &&
      result.error.includes('query') &&
      result.error.includes('status') &&
      result.error.includes('diff'),
      `unknown-subcommand error should list build, query, status, diff; got: ${result.error}`,
    );
  });

  test('query with no term → non-zero exit with usage error', () => {
    const result = runGsdTools(['graphify', 'query'], tmpDir);
    assert.strictEqual(result.success, false, 'missing term must fail');
  });

  test('query with no term → error message contains usage hint', () => {
    const result = runGsdTools(['graphify', 'query'], tmpDir);
    assert.ok(
      result.error.includes('Usage') || result.error.includes('graphify query'),
      `missing-term error should mention usage; got: ${result.error}`,
    );
  });
});

// ─── 5. JSON-ERRORS ──────────────────────────────────────────────────────────

describe('graphify cutover: --json-errors structured output', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('unknown subcommand → sdk_unknown_command reason (behavior preserved)', () => {
    const parsed = runJsonErrors(['graphify', 'bogus-xyzzy'], tmpDir);
    assertTypedError(parsed, 'sdk_unknown_command', 'unknown graphify subcommand');
  });

  test('query missing term → usage reason (behavior preserved)', () => {
    const parsed = runJsonErrors(['graphify', 'query'], tmpDir);
    assertTypedError(parsed, 'usage', 'graphify query missing term');
  });

  test('unknown subcommand message text preserved', () => {
    const parsed = runJsonErrors(['graphify', 'bogus-xyzzy'], tmpDir);
    assert.ok(
      parsed.message.includes('Unknown graphify subcommand'),
      `message must start with "Unknown graphify subcommand"; got: ${parsed.message}`,
    );
  });

  test('query missing term message text preserved', () => {
    const parsed = runJsonErrors(['graphify', 'query'], tmpDir);
    assert.ok(
      parsed.message.includes('graphify query'),
      `message must include "graphify query"; got: ${parsed.message}`,
    );
  });
});

// ─── 6. REGISTRY ─────────────────────────────────────────────────────────────

describe('graphify cutover: registry entries correct', () => {
  test('commandFamilies.graphify entry present and well-shaped', () => {
    const entry = registry.commandFamilies.graphify;
    assert.ok(entry, 'commandFamilies.graphify must be present');
    assert.strictEqual(entry.capId, 'graphify', 'commandFamilies.graphify.capId must be "graphify"');
    assert.strictEqual(entry.module, 'graphify-command-router.cjs',
      'commandFamilies.graphify.module must be "graphify-command-router.cjs"');
    assert.strictEqual(entry.router, 'routeGraphifyCommand',
      'commandFamilies.graphify.router must be "routeGraphifyCommand"');
  });

  test('bySkill.graphify maps to graphify capability', () => {
    assert.strictEqual(registry.bySkill.graphify, 'graphify',
      'bySkill["graphify"] must point to the graphify capability');
  });

  test('configSchema["graphify.enabled"] entry present', () => {
    const entry = registry.configSchema['graphify.enabled'];
    assert.ok(entry, 'configSchema["graphify.enabled"] must be present');
    assert.strictEqual(entry.owner, 'graphify', 'configSchema owner must be "graphify"');
    assert.strictEqual(entry.type, 'boolean', 'configSchema type must be "boolean"');
    assert.strictEqual(entry.default, false, 'configSchema default must be false');
  });

  test('profileMembership.graphify is tier:full, profiles:["full"]', () => {
    const pm = registry.profileMembership.graphify;
    assert.ok(pm, 'profileMembership.graphify must be present');
    assert.strictEqual(pm.tier, 'full', 'profileMembership.graphify.tier must be "full"');
    assert.deepStrictEqual(pm.profiles, ['full'],
      'profileMembership.graphify.profiles must be ["full"]');
  });

  test('capabilityClusters.graphify is ["graphify"]', () => {
    const clusters = registry.capabilityClusters.graphify;
    assert.deepStrictEqual(clusters, ['graphify'],
      'capabilityClusters.graphify must be ["graphify"]');
  });

  test('graphify capability id in capabilities map', () => {
    const cap = registry.capabilities.graphify;
    assert.ok(cap, 'capabilities.graphify must be present');
    assert.strictEqual(cap.role, 'feature', 'graphify capability must have role: feature');
    assert.strictEqual(cap.tier, 'full', 'graphify capability must have tier: full');
  });

  test('graphify capability commands[0] entry', () => {
    const cap = registry.capabilities.graphify;
    assert.ok(Array.isArray(cap.commands) && cap.commands.length > 0,
      'graphify capability must have commands array');
    const cmd = cap.commands[0];
    assert.strictEqual(cmd.family, 'graphify');
    assert.strictEqual(cmd.module, 'graphify-command-router.cjs');
    assert.strictEqual(cmd.router, 'routeGraphifyCommand');
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-974-graphify-budget-missing-value.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-974-graphify-budget-missing-value (consolidation epic #1969 B3 #1972)", () => {
'use strict';
/**
 * bug-974-graphify-budget-missing-value.test.cjs
 *
 * Regression guard: `gsd-tools graphify query <term> --budget` with no value
 * following --budget must emit a USAGE error and exit non-zero.
 *
 * Bug: args[budgetIdx + 1] was undefined → parseInt(undefined, 10) → NaN.
 * NaN is falsy so the budget guard `if (options.budget)` silently skipped
 * trimming and the query ran unbounded with no warning. (#974)
 *
 * Test categories:
 *   1. BEHAVIORAL (recording mock) — direct routeGraphifyCommand call, no I/O
 *   2. SUBPROCESS — end-to-end via runGsdTools
 *   3. PROPERTY — budget arg parser: non-numeric/absent → usage error, valid int → passes
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const {
  enableGraphify,
  writeGraphJson,
  SAMPLE_GRAPH,
} = require('./helpers/graphify.cjs');
const fc = require('./helpers/fast-check-setup.cjs');

const { routeGraphifyCommand } = require('../gsd-core/bin/lib/graphify-command-router.cjs');

// ─── Recording-mock helpers (mirrors graphify-command-cutover.test.cjs) ────────

function makeGraphifyMock() {
  const calls = [];
  function recorder(name, ...fnArgs) {
    const sentinel = { _mock: name, args: fnArgs };
    calls.push(sentinel);
    return sentinel;
  }
  return {
    calls,
    mock: {
      graphifyQuery: (cwd, term, opts) => recorder('graphifyQuery', cwd, term, opts),
      graphifyStatus: (cwd) => recorder('graphifyStatus', cwd),
      graphifyDiff: (cwd) => recorder('graphifyDiff', cwd),
      graphifyBuild: (cwd) => recorder('graphifyBuild', cwd),
      writeSnapshot: (cwd) => recorder('writeSnapshot', cwd),
    },
  };
}

function makeErrorRecorder() {
  const calls = [];
  const fn = (msg, reason) => calls.push({ msg, reason });
  fn.calls = calls;
  return fn;
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

// ─── 1. BEHAVIORAL — direct routeGraphifyCommand (recording mock, no I/O) ─────

describe('bug #974: --budget missing value → usage error (unit, recording mock)', () => {
  const CWD = '/fake/cwd';
  const RAW = false;

  // (a) --budget as last arg (no value following)
  test('(a) --budget last arg (missing value) → error(USAGE); graphifyQuery NOT called', () => {
    const { calls, mock } = makeGraphifyMock();
    const errFn = makeErrorRecorder();
    routeGraphifyCommand({
      args: ['graphify', 'query', 'myterm', '--budget'],
      cwd: CWD, raw: RAW, error: errFn, _graphify: mock,
    });
    assert.strictEqual(errFn.calls.length, 1,
      `error must be called exactly once; got ${errFn.calls.length} calls`);
    assert.strictEqual(errFn.calls[0].reason, 'usage',
      `reason must be 'usage'; got: ${errFn.calls[0].reason}`);
    assert.ok(
      errFn.calls[0].msg.includes('graphify query'),
      `usage message must mention "graphify query"; got: ${errFn.calls[0].msg}`,
    );
    assert.strictEqual(calls.length, 0,
      'graphifyQuery must NOT be called when --budget has no value');
  });

  // (b) --budget with a non-numeric value
  test('(b) --budget foo (non-numeric value) → error(USAGE); graphifyQuery NOT called', () => {
    const { calls, mock } = makeGraphifyMock();
    const errFn = makeErrorRecorder();
    routeGraphifyCommand({
      args: ['graphify', 'query', 'myterm', '--budget', 'foo'],
      cwd: CWD, raw: RAW, error: errFn, _graphify: mock,
    });
    assert.strictEqual(errFn.calls.length, 1,
      `error must be called exactly once; got ${errFn.calls.length} calls`);
    assert.strictEqual(errFn.calls[0].reason, 'usage',
      `reason must be 'usage'; got: ${errFn.calls[0].reason}`);
    assert.strictEqual(calls.length, 0,
      'graphifyQuery must NOT be called when --budget value is non-numeric');
  });

  // (c) --budget 0 → 0 is a valid integer, must NOT error
  test('(c) --budget 0 (explicit zero) → budget passed as 0, no error', () => {
    const { calls, mock } = makeGraphifyMock();
    const errFn = makeErrorRecorder();
    routeGraphifyCommand({
      args: ['graphify', 'query', 'myterm', '--budget', '0'],
      cwd: CWD, raw: RAW, error: errFn, _graphify: mock,
    });
    assert.strictEqual(errFn.calls.length, 0,
      `error must NOT be called for --budget 0; got: ${JSON.stringify(errFn.calls)}`);
    assert.strictEqual(calls.length, 1,
      'graphifyQuery MUST be called for --budget 0');
    assert.strictEqual(calls[0]._mock, 'graphifyQuery');
    assert.strictEqual(calls[0].args[2].budget, 0,
      `budget must be 0, got: ${calls[0].args[2].budget}`);
  });

  // (d) valid --budget 500 → regression: still works after fix
  test('(d) --budget 500 (valid positive integer) → budget: 500, no error', () => {
    const { calls, mock } = makeGraphifyMock();
    const errFn = makeErrorRecorder();
    routeGraphifyCommand({
      args: ['graphify', 'query', 'myterm', '--budget', '500'],
      cwd: CWD, raw: RAW, error: errFn, _graphify: mock,
    });
    assert.strictEqual(errFn.calls.length, 0,
      `error must NOT be called for --budget 500; got: ${JSON.stringify(errFn.calls)}`);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]._mock, 'graphifyQuery');
    assert.strictEqual(calls[0].args[2].budget, 500,
      `budget must be integer 500; got: ${calls[0].args[2].budget}`);
    assert.strictEqual(typeof calls[0].args[2].budget, 'number',
      'budget must be a number, not string');
  });

});

// ─── 2. SUBPROCESS — end-to-end via runGsdTools ───────────────────────────────

describe('bug #974: --budget missing value → usage error (subprocess)', () => {
  let tmpDir;
  let planningDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    planningDir = path.join(tmpDir, '.planning');
    enableGraphify(planningDir);
    writeGraphJson(planningDir, SAMPLE_GRAPH);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('subprocess: --budget last arg → non-zero exit', () => {
    const result = runGsdTools(
      ['graphify', 'query', 'AuthService', '--budget'],
      tmpDir,
    );
    assert.strictEqual(result.success, false,
      `--budget with no value must exit non-zero; stderr: ${result.error}`);
  });

  test('subprocess: --budget last arg → stderr contains usage hint', () => {
    const result = runGsdTools(
      ['graphify', 'query', 'AuthService', '--budget'],
      tmpDir,
    );
    assert.ok(
      result.error.includes('Usage') || result.error.includes('graphify query'),
      `stderr must contain usage hint; got: ${result.error}`,
    );
  });

  test('subprocess: --budget foo (non-numeric) → non-zero exit', () => {
    const result = runGsdTools(
      ['graphify', 'query', 'AuthService', '--budget', 'foo'],
      tmpDir,
    );
    assert.strictEqual(result.success, false,
      `--budget with non-numeric value must exit non-zero; stderr: ${result.error}`);
  });

  test('subprocess: --budget last arg → GSD_JSON_ERRORS=1 → usage reason', () => {
    const parsed = runJsonErrors(
      ['graphify', 'query', 'AuthService', '--budget'],
      tmpDir,
    );
    assertTypedError(parsed, 'usage', '--budget missing value json-error');
    assert.ok(
      parsed.message.includes('graphify query'),
      `message must include "graphify query"; got: ${parsed.message}`,
    );
  });

  test('subprocess: --budget foo → GSD_JSON_ERRORS=1 → usage reason', () => {
    const parsed = runJsonErrors(
      ['graphify', 'query', 'AuthService', '--budget', 'foo'],
      tmpDir,
    );
    assertTypedError(parsed, 'usage', '--budget non-numeric json-error');
  });

  // Regression: valid --budget still works after the fix
  test('subprocess: --budget 500 (valid) → success, term echoed', () => {
    const result = runGsdTools(
      ['graphify', 'query', 'AuthService', '--budget', '500'],
      tmpDir,
    );
    assert.ok(result.success,
      `--budget 500 must still succeed after fix; error: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.term, 'AuthService',
      'term must be echoed in query response');
    assert.ok('nodes' in parsed, 'response must include nodes array');
    assert.ok('total_nodes' in parsed, 'response must include total_nodes field');
  });
});

// ─── 3. PROPERTY — budget parse: non-numeric/absent → usage error, valid int → passes
//    Per RULESET.TESTS.property-based-testing: parsing/budget-limit modules
//    must include ≥1 fast-check property test.

describe('bug #974: budget arg parser property tests', () => {
  const CWD = '/fake/cwd';
  const RAW = false;

  // Property (a): any non-numeric, non-parseable string for --budget → usage error
  //
  // The budget-VALUE generator is constrained to genuinely non-numeric values.
  // The .filter(v => Number.isNaN(parseInt(v, 10))) at the end is the authoritative
  // gate: it excludes any value that parseInt(v, 10) would accept (e.g. "+5", "-3",
  // " 7", "0x1a", "007"). This makes the property universally true rather than
  // relying on a runtime skip inside the property body.
  // The term is fixed as "myterm" — this property is about the BUDGET VALUE, not
  // the term.
  test('property: non-numeric --budget value always produces usage error', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          // Alphabetic-start strings (parseInt('abc') = NaN)
          fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,20}$/),
          // Empty string (parseInt('') = NaN)
          fc.constant(''),
          // Strings starting with special chars — filtered below for safety
          fc.stringMatching(/^[!@#$%^&*()_+={}\][|\\:;"'<,>?/~`][^\s]{0,10}$/),
        ).filter(v => Number.isNaN(parseInt(v, 10))),
        (badValue) => {
          const { mock } = makeGraphifyMock();
          const errFn = makeErrorRecorder();
          routeGraphifyCommand({
            args: ['graphify', 'query', 'myterm', '--budget', badValue],
            cwd: CWD, raw: RAW, error: errFn, _graphify: mock,
          });
          assert.strictEqual(errFn.calls.length, 1,
            `--budget "${badValue}" (NaN) must produce exactly one error call`);
          assert.strictEqual(errFn.calls[0].reason, 'usage',
            `--budget "${badValue}" error must have reason 'usage'; got: ${errFn.calls[0].reason}`);
        },
      ),
      // Explicit seed + numRuns for CI determinism.
      { seed: 1001, numRuns: 200 },
    );
  });

  // Example (b): --budget as last arg (missing value) → usage error, for fixed valid terms.
  // Previously a property fuzz over a validTerm generator; replaced with deterministic
  // examples because the regex `/^[A-Za-z0-9][A-Za-z0-9_.-]{0,29}$/` admitted single
  // digits like "0" which are falsy and trigger the router's `if (!term)` guard instead
  // of the budget-missing-value path, causing a spurious test failure (seed 1004, term
  // "0"). These properties are about the BUDGET contract; the term is a fixed bystander.
  test('example: --budget as last arg always produces usage error (fixed terms)', () => {
    const FIXED_TERMS = ['someterm', 'AuthService', 'a1', 'graph-node_1', 'MyComponent'];
    for (const term of FIXED_TERMS) {
      const { mock } = makeGraphifyMock();
      const errFn = makeErrorRecorder();
      routeGraphifyCommand({
        args: ['graphify', 'query', term, '--budget'],
        cwd: CWD, raw: RAW, error: errFn, _graphify: mock,
      });
      assert.strictEqual(errFn.calls.length, 1,
        `--budget as last arg: term=${JSON.stringify(term)}: must produce exactly one error call; got ${errFn.calls.length}`);
      assert.strictEqual(errFn.calls[0].reason, 'usage',
        `--budget as last arg: term=${JSON.stringify(term)}: reason must be 'usage'; got ${errFn.calls[0].reason}`);
    }
  });

  // Property (c): valid positive integer strings → budget passed through as number, no error
  test('property: positive integer string for --budget is always accepted', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000_000 }),
        (n) => {
          const { calls, mock } = makeGraphifyMock();
          const errFn = makeErrorRecorder();
          routeGraphifyCommand({
            args: ['graphify', 'query', 'myterm', '--budget', String(n)],
            cwd: CWD, raw: RAW, error: errFn, _graphify: mock,
          });
          assert.strictEqual(errFn.calls.length, 0,
            `--budget ${n} (valid positive integer) must not produce an error`);
          assert.strictEqual(calls.length, 1, 'graphifyQuery must be called');
          assert.strictEqual(calls[0].args[2].budget, n,
            `budget must equal ${n}; got: ${calls[0].args[2].budget}`);
          assert.strictEqual(typeof calls[0].args[2].budget, 'number',
            `budget must be a number, not string "${calls[0].args[2].budget}"`);
        },
      ),
      // Explicit seed + numRuns for CI determinism.
      { seed: 1003, numRuns: 200 },
    );
  });

  // Example (d): absence of --budget flag yields budget:null and no error, for fixed valid terms.
  // Previously a property fuzz over a validTerm generator; replaced with deterministic
  // examples for the same reason as example (b): single-digit terms like "0" are falsy
  // and trigger the router's term-missing usage error, not the budget-absent path.
  // These examples fix the term as clearly valid multi-char identifiers.
  test('example: absence of --budget flag yields budget:null and no error (fixed terms)', () => {
    const FIXED_TERMS = ['someterm', 'AuthService', 'a1', 'graph-node_1', 'MyComponent'];
    for (const term of FIXED_TERMS) {
      const { calls, mock } = makeGraphifyMock();
      const errFn = makeErrorRecorder();
      routeGraphifyCommand({
        args: ['graphify', 'query', term],
        cwd: CWD, raw: RAW, error: errFn, _graphify: mock,
      });
      assert.strictEqual(errFn.calls.length, 0,
        `no --budget flag must not produce an error for term "${term}"`);
      assert.strictEqual(calls.length, 1,
        `graphifyQuery must be called for term "${term}"; got calls.length=${calls.length}`);
      assert.strictEqual(calls[0].args[2].budget, null,
        `absent --budget must pass budget:null; got: ${calls[0].args[2].budget}`);
    }
  });
});
  });
}
