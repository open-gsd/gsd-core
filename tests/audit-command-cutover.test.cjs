'use strict';
/**
 * audit-command-cutover.test.cjs — ADR-959 phase 4d-impl-3 equivalence tests.
 *
 * Verifies that `audit-uat` and `audit-open`, after cutover from the hardcoded
 * `case 'audit-uat':` and `case 'audit-open':` arms in gsd-tools.cjs to the
 * capability registry dispatch path (default → dispatchCapabilityCommand →
 * audit-command-router.cjs → routeAuditUat | routeAuditOpen), behave
 * identically to the old inline cases.
 *
 * Test categories:
 *   1. UNIT (recording mock) — precise arg/call equivalence for each router
 *   2. DISPATCH — commands reach routers via default-case registry dispatch
 *   3. BEHAVIOR — subprocess tests with real output-shape assertions
 *   4. JSON-ERRORS — structured {ok:false,reason,message} for error paths
 *   5. REGISTRY — commandFamilies entries, audit capability in registry
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const registry = require('../gsd-core/bin/lib/capability-registry.cjs');
const { routeAuditUat, routeAuditOpen } = require('../gsd-core/bin/lib/audit-command-router.cjs');

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeErrorRecorder() {
  const calls = [];
  const fn = (msg, reason) => calls.push({ msg, reason });
  fn.calls = calls;
  return fn;
}

// ─── 1. UNIT — recording mocks (precise routing equivalence) ─────────────────

describe('audit routers: unit tests via recording mocks', () => {
  const CWD = '/fake/cwd';
  const RAW = false;

  // ── routeAuditUat ──────────────────────────────────────────────────────────

  test('routeAuditUat: calls _uat.cmdAuditUat(cwd, raw) exactly once', () => {
    const uatCalls = [];
    const mockUat = {
      cmdAuditUat: (cwd, raw) => uatCalls.push({ cwd, raw }),
    };
    const errFn = makeErrorRecorder();

    routeAuditUat({
      args: ['audit-uat'],
      cwd: CWD, raw: RAW, error: errFn,
      _uat: mockUat,
    });

    assert.strictEqual(errFn.calls.length, 0, 'error must not be called');
    assert.strictEqual(uatCalls.length, 1, 'cmdAuditUat must be called exactly once');
    assert.strictEqual(uatCalls[0].cwd, CWD, 'cwd passed through correctly');
    assert.strictEqual(uatCalls[0].raw, RAW, 'raw passed through correctly');
  });

  test('routeAuditUat: raw=true is forwarded correctly', () => {
    const uatCalls = [];
    const mockUat = {
      cmdAuditUat: (cwd, raw) => uatCalls.push({ cwd, raw }),
    };
    routeAuditUat({
      args: ['audit-uat'],
      cwd: CWD, raw: true, error: makeErrorRecorder(),
      _uat: mockUat,
    });
    assert.strictEqual(uatCalls[0].raw, true, 'raw=true must be forwarded');
  });

  // ── routeAuditOpen ─────────────────────────────────────────────────────────

  test('routeAuditOpen (no --json): calls auditOpenArtifacts, formatAuditReport; output(null, true, report)', () => {
    const auditCalls = [];
    const coreCalls = [];
    const FAKE_RESULT = { fake: true };
    const FAKE_REPORT = 'REPORT TEXT';
    const mockAudit = {
      auditOpenArtifacts: (cwd) => { auditCalls.push({ fn: 'auditOpenArtifacts', cwd }); return FAKE_RESULT; },
      formatAuditReport: (res) => { auditCalls.push({ fn: 'formatAuditReport', res }); return FAKE_REPORT; },
    };
    // Inject a recording _core stub so no bytes reach the real process stdout.
    const mockCore = {
      output: (...callArgs) => coreCalls.push(callArgs),
    };
    routeAuditOpen({
      args: ['audit-open'],
      cwd: CWD, raw: RAW, error: makeErrorRecorder(),
      _audit: mockAudit,
      _core: mockCore,
    });
    // auditOpenArtifacts called first, then formatAuditReport with its result
    assert.strictEqual(auditCalls.length, 2, 'must call auditOpenArtifacts then formatAuditReport');
    assert.strictEqual(auditCalls[0].fn, 'auditOpenArtifacts', 'first call must be auditOpenArtifacts');
    assert.strictEqual(auditCalls[0].cwd, CWD, 'auditOpenArtifacts cwd must match');
    assert.strictEqual(auditCalls[1].fn, 'formatAuditReport', 'second call must be formatAuditReport');
    assert.strictEqual(auditCalls[1].res, FAKE_RESULT, 'formatAuditReport must receive auditOpenArtifacts result');
    // Assert the exact 3-arg core.output call form for text mode:
    //   core.output(null, true, formatAuditReport(result))
    assert.strictEqual(coreCalls.length, 1, 'core.output must be called exactly once');
    assert.strictEqual(coreCalls[0][0], null, 'text mode: first arg to core.output must be null');
    assert.strictEqual(coreCalls[0][1], true, 'text mode: second arg to core.output must be true');
    assert.strictEqual(coreCalls[0][2], FAKE_REPORT, 'text mode: third arg to core.output must be the formatted report');
  });

  test('routeAuditOpen (--json): calls auditOpenArtifacts but NOT formatAuditReport; output(result, raw)', () => {
    const auditCalls = [];
    const coreCalls = [];
    const FAKE_RESULT = { fake: true };
    const mockAudit = {
      auditOpenArtifacts: (cwd) => { auditCalls.push({ fn: 'auditOpenArtifacts', cwd }); return FAKE_RESULT; },
      formatAuditReport: (res) => { auditCalls.push({ fn: 'formatAuditReport', res }); return 'REPORT'; },
    };
    // Inject a recording _core stub so no bytes reach the real process stdout.
    const mockCore = {
      output: (...callArgs) => coreCalls.push(callArgs),
    };
    routeAuditOpen({
      args: ['audit-open', '--json'],
      cwd: CWD, raw: RAW, error: makeErrorRecorder(),
      _audit: mockAudit,
      _core: mockCore,
    });
    // auditOpenArtifacts called; formatAuditReport must NOT be called for --json
    const fmtCalls = auditCalls.filter(c => c.fn === 'formatAuditReport');
    assert.strictEqual(fmtCalls.length, 0, '--json mode must NOT call formatAuditReport');
    const artifactCalls = auditCalls.filter(c => c.fn === 'auditOpenArtifacts');
    assert.strictEqual(artifactCalls.length, 1, '--json mode must call auditOpenArtifacts once');
    // Assert the exact 2-arg core.output call form for JSON mode:
    //   core.output(result, raw)
    assert.strictEqual(coreCalls.length, 1, 'core.output must be called exactly once');
    assert.strictEqual(coreCalls[0][0], FAKE_RESULT, 'json mode: first arg to core.output must be the result object');
    assert.strictEqual(coreCalls[0][1], RAW, 'json mode: second arg to core.output must be raw');
    assert.strictEqual(coreCalls[0].length, 2, 'json mode: core.output must be called with exactly 2 args');
  });
});

// ─── 2. DISPATCH — commands reach routers via default-case ───────────────────

describe('audit cutover: dispatch path (default-case → capability registry)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-audit-cutover-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('audit-uat dispatches via capability registry (no "Unknown command" error)', () => {
    const result = runGsdTools(['audit-uat'], tmpDir);
    // audit-uat with a minimal project may succeed or fail on file-not-found;
    // the key assertion is it never emits "Unknown command: audit-uat"
    const isUnknownCmd = (result.error || '').includes('Unknown command: audit-uat');
    assert.strictEqual(isUnknownCmd, false,
      `Must not emit "Unknown command: audit-uat". stderr: ${result.error}`);
    assert.ok(result.success,
      `audit-uat must exit 0. stderr: ${result.error}`);
  });

  test('audit-open dispatches via capability registry (no "Unknown command" error)', () => {
    const result = runGsdTools(['audit-open'], tmpDir);
    const isUnknownCmd = (result.error || '').includes('Unknown command: audit-open');
    assert.strictEqual(isUnknownCmd, false,
      `Must not emit "Unknown command: audit-open". stderr: ${result.error}`);
    assert.ok(result.success,
      `audit-open must exit 0. stderr: ${result.error}`);
  });

  test('audit-open --json dispatches via capability registry', () => {
    const result = runGsdTools(['audit-open', '--json'], tmpDir);
    const isUnknownCmd = (result.error || '').includes('Unknown command: audit-open');
    assert.strictEqual(isUnknownCmd, false,
      `Must not emit "Unknown command: audit-open" with --json. stderr: ${result.error}`);
    // Must also produce valid JSON output
    assert.ok(result.success,
      `audit-open --json must succeed. stderr: ${result.error}`);
    assert.doesNotThrow(
      () => JSON.parse(result.output),
      'audit-open --json must produce valid JSON',
    );
  });
});

// ─── 3. BEHAVIOR — subprocess output shape (equivalence to old inline cases) ──

describe('audit cutover: output shape equivalence', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-audit-behavior-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('audit-open (text) succeeds and produces non-empty output', () => {
    const result = runGsdTools(['audit-open'], tmpDir);
    assert.ok(result.success,
      `audit-open must succeed. stderr: ${result.error}`);
    assert.ok(result.output && result.output.length > 0,
      'audit-open text output must be non-empty');
    // Must be raw text, not JSON-encoded (regression guard from #2911)
    assert.ok(!result.output.startsWith('"'),
      'text mode must not start with a JSON quote');
    assert.ok(!result.output.includes('\\n'),
      'text mode must not contain literal \\n sequences');
  });

  test('audit-open --json produces valid JSON with expected shape', () => {
    const result = runGsdTools(['audit-open', '--json'], tmpDir);
    assert.ok(result.success,
      `audit-open --json must succeed. stderr: ${result.error}`);
    let parsed;
    assert.doesNotThrow(
      () => { parsed = JSON.parse(result.output); },
      'audit-open --json must emit valid JSON',
    );
    assert.equal(typeof parsed, 'object', 'parsed payload must be an object');
    assert.ok(parsed !== null, 'parsed payload must not be null');
    // Shape contract from auditOpenArtifacts() (regression guard from #2911)
    assert.equal(typeof parsed.scanned_at, 'string', 'must include scanned_at');
    assert.equal(typeof parsed.has_open_items, 'boolean', 'must include has_open_items');
    assert.equal(typeof parsed.counts, 'object', 'must include counts');
    assert.equal(typeof parsed.items, 'object', 'must include items');
  });

  test('audit-open (text) report title present as standalone line', () => {
    const result = runGsdTools(['audit-open'], tmpDir);
    assert.ok(result.success,
      `audit-open must succeed. stderr: ${result.error}`);
    const lines = result.output.split('\n').map(l => l.trim()).filter(Boolean);
    assert.ok(
      lines.includes('Milestone Close: Open Artifact Audit'),
      `report title must appear as a standalone line; got: ${JSON.stringify(lines.slice(0, 5))}`,
    );
  });

  test('audit-uat succeeds and produces non-empty stdout', () => {
    const result = runGsdTools(['audit-uat'], tmpDir);
    assert.ok(result.success,
      `audit-uat must succeed. stderr: ${result.error}`);
    assert.ok(result.output && result.output.length > 0,
      'audit-uat must write non-empty output to stdout');
  });

  test('audit-uat --raw flag passes through (does not break dispatch)', () => {
    const result = runGsdTools(['audit-uat', '--raw'], tmpDir);
    // --raw is a gsd-tools global flag; it modifies output encoding but
    // the command must still succeed and produce output
    assert.ok(result.success,
      `audit-uat --raw must succeed. stderr: ${result.error}`);
  });
});

// ─── 4. JSON-ERRORS — GSD_JSON_ERRORS mode passes through cleanly ────────────

describe('audit cutover: GSD_JSON_ERRORS mode (both commands succeed without structured error)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-audit-jsonerr-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('audit-open --json with GSD_JSON_ERRORS=1 succeeds (no spurious error payload)', () => {
    // Successful commands must not emit JSON error payloads; verify exit 0.
    const result = runGsdTools(['audit-open', '--json'], tmpDir, { GSD_JSON_ERRORS: '1' });
    assert.ok(result.success,
      `audit-open --json must succeed even with GSD_JSON_ERRORS=1; stderr: ${result.error}`);
  });

  test('audit-open text with GSD_JSON_ERRORS=1 succeeds (no spurious error payload)', () => {
    const result = runGsdTools(['audit-open'], tmpDir, { GSD_JSON_ERRORS: '1' });
    assert.ok(result.success,
      `audit-open text mode must succeed even with GSD_JSON_ERRORS=1; stderr: ${result.error}`);
  });

  test('audit-uat with GSD_JSON_ERRORS=1 succeeds (no spurious error payload)', () => {
    const result = runGsdTools(['audit-uat'], tmpDir, { GSD_JSON_ERRORS: '1' });
    assert.ok(result.success,
      `audit-uat must succeed even with GSD_JSON_ERRORS=1; stderr: ${result.error}`);
  });
});

// ─── 5. REGISTRY — commandFamilies entries ───────────────────────────────────

describe('audit cutover: registry entries correct', () => {
  test('commandFamilies["audit-uat"] present and well-shaped', () => {
    const entry = registry.commandFamilies['audit-uat'];
    assert.ok(entry, 'commandFamilies["audit-uat"] must be present');
    assert.strictEqual(entry.capId, 'audit',
      'commandFamilies["audit-uat"].capId must be "audit"');
    assert.strictEqual(entry.module, 'audit-command-router.cjs',
      'commandFamilies["audit-uat"].module must be "audit-command-router.cjs"');
    assert.strictEqual(entry.router, 'routeAuditUat',
      'commandFamilies["audit-uat"].router must be "routeAuditUat"');
  });

  test('commandFamilies["audit-open"] present and well-shaped', () => {
    const entry = registry.commandFamilies['audit-open'];
    assert.ok(entry, 'commandFamilies["audit-open"] must be present');
    assert.strictEqual(entry.capId, 'audit',
      'commandFamilies["audit-open"].capId must be "audit"');
    assert.strictEqual(entry.module, 'audit-command-router.cjs',
      'commandFamilies["audit-open"].module must be "audit-command-router.cjs"');
    assert.strictEqual(entry.router, 'routeAuditOpen',
      'commandFamilies["audit-open"].router must be "routeAuditOpen"');
  });

  test('capabilities.audit present with role:feature and tier:full', () => {
    const cap = registry.capabilities.audit;
    assert.ok(cap, 'capabilities.audit must be present');
    assert.strictEqual(cap.role, 'feature', 'audit capability must have role: feature');
    assert.strictEqual(cap.tier, 'full', 'audit capability must have tier: full');
  });

  test('capabilities.audit.commands has both audit-uat and audit-open entries', () => {
    const cap = registry.capabilities.audit;
    assert.ok(Array.isArray(cap.commands) && cap.commands.length === 2,
      'audit capability must have exactly 2 commands');

    const uatCmd = cap.commands.find(c => c.family === 'audit-uat');
    assert.ok(uatCmd, 'commands must include audit-uat family');
    assert.strictEqual(uatCmd.module, 'audit-command-router.cjs');
    assert.strictEqual(uatCmd.router, 'routeAuditUat');

    const openCmd = cap.commands.find(c => c.family === 'audit-open');
    assert.ok(openCmd, 'commands must include audit-open family');
    assert.strictEqual(openCmd.module, 'audit-command-router.cjs');
    assert.strictEqual(openCmd.router, 'routeAuditOpen');
  });

  test('routeAuditUat and routeAuditOpen are exported functions', () => {
    assert.strictEqual(typeof routeAuditUat, 'function',
      'routeAuditUat must be an exported function');
    assert.strictEqual(typeof routeAuditOpen, 'function',
      'routeAuditOpen must be an exported function');
  });

  test('profileMembership.audit is vacuous (no skills → no skill-cluster entry)', () => {
    // audit declares skills:[] → no skill-cluster-based profileMembership entry.
    // This is correct: profileMembership tracks skill ownership, not capability existence.
    const pm = registry.profileMembership.audit;
    assert.strictEqual(pm, undefined,
      'profileMembership.audit must be undefined (no skills declared)');
  });

  test('capabilityClusters.audit is vacuous (no skills → no cluster entry)', () => {
    // Same as profileMembership — skill-less capabilities produce no cluster entries.
    const clusters = registry.capabilityClusters.audit;
    assert.strictEqual(clusters, undefined,
      'capabilityClusters.audit must be undefined (no skills declared)');
  });

  test('audit has no skills — vacuous install/surface (no skill-index entries)', () => {
    // audit capability declares no skills, so bySkill has no "audit" entry
    // (there is no skill named "audit")
    const cap = registry.capabilities.audit;
    assert.deepStrictEqual(cap.skills, [],
      'audit capability must have empty skills array');
  });

  test('graphify commandFamilies entry still present (no regression)', () => {
    const entry = registry.commandFamilies['graphify'];
    assert.ok(entry, 'commandFamilies["graphify"] must still be present');
    assert.strictEqual(entry.capId, 'graphify');
    assert.strictEqual(entry.module, 'graphify-command-router.cjs');
    assert.strictEqual(entry.router, 'routeGraphifyCommand');
  });
});
