'use strict';

/**
 * Executor dispatch identity: a plan's `agent_hint:` routes it to a hinted executor
 * (gsd-core/workflows/execute-phase/steps/per-plan-executor-routing.md), but both isolation
 * guards recognised only `gsd-executor`, so the hinted executor was waved through as a
 * "confirmed non-executor" even when the recorded dispatch decision required a harness
 * worktree. The dispatch record now names the plan's executor (`executor_type`, ADR-4630
 * record), and the guards check whichever executor it names.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');
const { createFixture } = require('./fixtures/index.cjs');
const { SENTINEL_RELATIVE_PATH, SENTINEL_STALE_MS, AGED_NONE_MAX_MS, MAX_EXECUTOR_TYPES, MAX_SCANNED_RECORDS, MAX_SCANNED_DIR_ENTRIES, CLOCK_SKEW_MS, SENTINEL_MAX_BYTES, GSD_ROLE_NAMES, isGsdRoleName, hasJsonSuffix, displayAgentName, isValidExecutorType, readSentinel, extractDispatchIdentifiers, isExecutorDispatch, keyedSentinelPath, phaseSentinelPath } = require('../hooks/lib/isolation-sentinel.js');
const { REASON_CODE } = require('../hooks/lib/isolation-deny-reason.js');
const guard = require('../hooks/gsd-agent-isolation-guard.js');
const cursor = require('../hooks/gsd-cursor-subagent-start.js');

const WRITTEN_AT = 1_000_000;
const fresh = { now: () => WRITTEN_AT + 1000 };
const HINTED = 'acme-rails-executor';
const FLAG = 'isolation="worktree"';

function writeSentinel(dir, over = {}) {
  const p = path.join(dir, SENTINEL_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({
    isolation: 'harness-worktree', harness_flag: FLAG, phase: '02', plan: '02-01-api', written_at: WRITTEN_AT, ...over,
  }));
}

const marker = '[gsd:dispatch phase="02" plan="02-01-api"] Execute plan 01 of phase 02.';
// The prose frame names the phase but carries no canonical marker, so it never classifies a dispatch
// as an executor dispatch by itself: only a record naming the type does.
const plain = 'Execute plan 01 of phase 02.';

function claudeDecision(project, subagentType, toolInputExtra = {}, text = plain) {
  return guard.evaluateDispatch({
    tool_name: 'Agent',
    cwd: project,
    tool_input: { subagent_type: subagentType, prompt: text, ...toolInputExtra },
  }, { clock: fresh });
}

function claudeVerdict(project, subagentType, toolInputExtra = {}, text = plain) {
  return claudeDecision(project, subagentType, toolInputExtra, text).action;
}

function cursorDecision(project, subagentType, text = plain) {
  return cursor.resolveIsolationDecision({
    subagent_type: subagentType,
    task: text,
    workspace_roots: [project],
  }, { clock: fresh });
}

function cursorVerdict(project, subagentType, text = plain) {
  return cursorDecision(project, subagentType, text).action;
}

/** The specialist must get exactly the verdict (and reason) gsd-executor gets for the same dispatch text. */
function assertSameAsExecutor(project, specialist, text, label) {
  const exec = claudeDecision(project, 'gsd-executor', {}, text);
  const spec = claudeDecision(project, specialist, {}, text);
  assert.strictEqual(spec.action, exec.action, `claude action ${label}`);
  assert.strictEqual(spec.reasonCode, exec.reasonCode, `claude reasonCode ${label}`);
  assert.strictEqual(cursorVerdict(project, specialist, text), cursorVerdict(project, 'gsd-executor', text), `cursor ${label}`);
  return exec;
}

describe('isolation guards check the executor the dispatch record names', () => {
  let project;
  before(() => {
    project = createFixture({ prefix: 'gsd-hinted-exec-', planning: true, git: true, projectDoc: false });
    fs.writeFileSync(path.join(project, '.planning', 'config.json'), JSON.stringify({ runtime: 'claude' }));
  });
  after(() => { cleanup(project); });

  test('a hinted executor without the worktree flag is blocked when the record names it', () => {
    writeSentinel(project, { executor_type: HINTED });
    const decision = claudeDecision(project, HINTED);
    assert.strictEqual(decision.action, 'block', 'claude guard');
    assert.strictEqual(decision.reasonCode, REASON_CODE.HARNESS_FLAG_MISSING, 'claude guard reason');
    assert.strictEqual(cursorVerdict(project, HINTED), 'deny', 'cursor hook');
  });

  test('the same hinted executor carrying the flag is allowed', () => {
    writeSentinel(project, { executor_type: HINTED });
    assert.strictEqual(claudeVerdict(project, HINTED, { isolation: 'worktree' }), 'allow');
  });

  test('when the record names a hinted executor, gsd-executor itself is still guarded', () => {
    writeSentinel(project, { executor_type: HINTED });
    assert.strictEqual(claudeVerdict(project, 'gsd-executor'), 'block');
  });

  test('a non-executor agent is not guarded', () => {
    writeSentinel(project, { executor_type: HINTED });
    assert.strictEqual(claudeVerdict(project, 'gsd-verifier'), 'allow', 'claude guard');
    assert.strictEqual(cursorVerdict(project, 'gsd-verifier'), 'allow', 'cursor hook');
  });

  test('a hand-written record naming a GSD role never classifies it; a custom executor in the same record still classifies', () => {
    writeSentinel(project, { executor_type: 'gsd-verifier', executor_types: ['gsd-planner', 'acme-a'] });
    for (const role of ['gsd-verifier', 'gsd-planner']) {
      assert.strictEqual(claudeVerdict(project, role), 'allow', `claude ${role}`);
      assert.strictEqual(cursorVerdict(project, role), 'allow', `cursor ${role}`);
    }
    assert.strictEqual(claudeVerdict(project, 'acme-a'), 'block', 'claude acme-a');
    assert.strictEqual(cursorVerdict(project, 'acme-a'), 'deny', 'cursor acme-a');
  });

  test('a record without executor_type keeps the gsd-executor-only rule', () => {
    writeSentinel(project);
    assert.strictEqual(claudeVerdict(project, 'gsd-executor'), 'block');
    assert.strictEqual(claudeVerdict(project, HINTED), 'allow');
  });
});

describe('cursor hook checks the executor the dispatch record names', () => {
  let project;
  before(() => {
    project = createFixture({ prefix: 'gsd-hinted-exec-cursor-', planning: true, git: true, projectDoc: false });
    fs.writeFileSync(path.join(project, '.planning', 'config.json'), JSON.stringify({ runtime: 'cursor' }));
  });
  after(() => { cleanup(project); });

  test('a hinted executor is denied when the record names it', () => {
    writeSentinel(project, { executor_type: HINTED });
    assert.strictEqual(cursorVerdict(project, HINTED), 'deny');
  });

  test('gsd-executor stays guarded when the record names a hinted executor', () => {
    writeSentinel(project, { executor_type: HINTED });
    assert.strictEqual(cursorVerdict(project, 'gsd-executor'), 'deny');
  });

  test('a non-executor agent is allowed', () => {
    writeSentinel(project, { executor_type: HINTED });
    assert.strictEqual(cursorVerdict(project, 'gsd-verifier'), 'allow');
  });

  test('a record without executor_type keeps the gsd-executor-only rule', () => {
    writeSentinel(project);
    assert.strictEqual(cursorVerdict(project, 'gsd-executor'), 'deny');
    assert.strictEqual(cursorVerdict(project, HINTED), 'allow');
  });

  test('a record for a different plan still names the type: a hinted dispatch gets the verdict gsd-executor gets, marker or not', () => {
    writeSentinel(project, { executor_type: HINTED, plan: '02-09-other' });
    assertSameAsExecutor(project, HINTED, marker, 'different plan');
    assert.strictEqual(cursorVerdict(project, HINTED, plain), 'deny', 'no marker: the recent record names the type');
  });
});

describe('a record only governs a hinted executor while it applies and is well-formed', () => {
  let project;
  before(() => {
    project = createFixture({ prefix: 'gsd-hinted-exec-edge-', planning: true, git: true, projectDoc: false });
    fs.writeFileSync(path.join(project, '.planning', 'config.json'), JSON.stringify({ runtime: 'claude' }));
  });
  after(() => { cleanup(project); });

  test('a recent record naming the hinted executor classifies a dispatch of another plan or another phase', () => {
    writeSentinel(project, { executor_type: HINTED });
    const other = '[gsd:dispatch phase="02" plan="02-02-docs"] Execute plan 02 of phase 02.';
    assertSameAsExecutor(project, HINTED, other, 'other plan');
    const exec = assertSameAsExecutor(project, HINTED, 'Execute plan 02 of phase 03.', 'no marker, other phase');
    assert.strictEqual(exec.action, 'block', 'gsd-executor is blocked');
    assert.strictEqual(claudeDecision(project, HINTED, {}, 'Execute plan 02 of phase 03.').action, 'block', 'the specialist is held to the same rule');
  });

  test('a stale record naming the hinted executor still classifies the dispatch (fresh at limit-1; aged-classified at limit and limit+1)', () => {
    const writtenAt = (ageMs) => fresh.now() - ageMs;
    writeSentinel(project, { executor_type: HINTED, written_at: writtenAt(SENTINEL_STALE_MS - 1) });
    assert.strictEqual(claudeVerdict(project, HINTED), 'block', 'age limit-1 (fresh)');
    for (const [age, label] of [[SENTINEL_STALE_MS, 'age limit'], [SENTINEL_STALE_MS + 1, 'age limit+1']]) {
      writeSentinel(project, { executor_type: HINTED, written_at: writtenAt(age) });
      const exec = assertSameAsExecutor(project, HINTED, plain, label);
      assert.strictEqual(exec.action, 'block', `gsd-executor falls back to the registry for a stale record (${label})`);
    }
  });

  test('a record classifies only while at most AGED_NONE_MAX_MS old, whatever its phase (limit-1 / limit / limit+1)', () => {
    const writtenAt = (ageMs) => fresh.now() - ageMs;
    for (const age of [AGED_NONE_MAX_MS - 1, AGED_NONE_MAX_MS]) {
      writeSentinel(project, { executor_type: HINTED, written_at: writtenAt(age) });
      assert.strictEqual(claudeVerdict(project, HINTED), 'block', `age ${age}`);
      assert.strictEqual(cursorVerdict(project, HINTED), 'deny', `cursor age ${age}`);
      assertSameAsExecutor(project, HINTED, plain, `age ${age}`);
    }
    writeSentinel(project, { executor_type: HINTED, written_at: writtenAt(AGED_NONE_MAX_MS + 1) });
    assert.strictEqual(claudeVerdict(project, HINTED), 'allow', 'age limit+1');
    assert.strictEqual(cursorVerdict(project, HINTED), 'allow', 'cursor age limit+1');
    writeSentinel(project, { executor_type: HINTED, written_at: writtenAt(SENTINEL_STALE_MS + 1), phase: '09' });
    const other = assertSameAsExecutor(project, HINTED, plain, 'stale record of another phase');
    assert.strictEqual(other.action, 'block', 'a stale record of another phase classifies');
    writeSentinel(project, { executor_type: HINTED, written_at: writtenAt(-60_000) });
    // The file's mtime is recent, so a record dated beyond the skew allowance cannot be ruled out: fail closed.
    assert.strictEqual(claudeVerdict(project, HINTED), 'block', 'future-dated record with a recent mtime fails closed');
    writeSentinel(project, { executor_type: HINTED, written_at: writtenAt(-CLOCK_SKEW_MS) });
    assert.strictEqual(claudeVerdict(project, HINTED), 'block', 'future-dated within the skew allowance');
  });

  test('a future-dated legacy record whose mtime is aged is ignored (the mtime proves it is not recent)', () => {
    // Wall-clock only seeds the mtime; the verdict uses this injected clock, anchored to it.
    const now = Date.now();
    const clock = { now: () => now };
    writeSentinel(project, { executor_type: 'acme-other', written_at: now + 60_000 });
    const OLD = (now - 2 * AGED_NONE_MAX_MS) / 1000;
    fs.utimesSync(path.join(project, SENTINEL_RELATIVE_PATH), OLD, OLD);
    const verdict = (type) => guard.evaluateDispatch({ tool_name: 'Agent', cwd: project, tool_input: { subagent_type: type, prompt: plain } }, { clock }).action;
    assert.strictEqual(verdict(HINTED), 'allow', 'aged mtime, future written_at');
    writeSentinel(project, { executor_type: 'acme-other', written_at: now + 60_000 });
    assert.strictEqual(verdict(HINTED), 'block', 'recent mtime, future written_at');
  });

  test('an invalid executor_type reads as absent (the dispatch is allowed, the record is not malformed)', () => {
    const invalid = ['../x', '-x', 'a/b', 'a..b', '', 'a'.repeat(129)];
    for (const executorType of invalid) {
      writeSentinel(project, { executor_type: executorType });
      assert.strictEqual(claudeVerdict(project, executorType || 'acme-empty'), 'allow', `claude: ${JSON.stringify(executorType)}`);
      assert.strictEqual(claudeVerdict(project, 'gsd-executor'), 'block', 'the rest of the record still applies to gsd-executor');
    }
    writeSentinel(project, { executor_type: 12345 });
    assert.strictEqual(claudeVerdict(project, '12345'), 'allow', 'non-string executor_type');
    assert.strictEqual(claudeVerdict(project, 'gsd-executor'), 'block');
  });

  test('executor_type length boundary: 128 characters is recorded, 129 is not', () => {
    const at = `a${'b'.repeat(127)}`;
    writeSentinel(project, { executor_type: at });
    assert.strictEqual(claudeVerdict(project, at), 'block', '128');
    const over = `${at}b`;
    writeSentinel(project, { executor_type: over });
    assert.strictEqual(claudeVerdict(project, over), 'allow', '129');
    const under = at.slice(0, -1);
    writeSentinel(project, { executor_type: under });
    assert.strictEqual(claudeVerdict(project, under), 'block', '127');
  });
});

describe('a project without .planning/config.json is never guarded for a hinted executor', () => {
  let project;
  before(() => {
    project = createFixture({ prefix: 'gsd-hinted-exec-nongsd-', planning: false, git: true, projectDoc: false });
  });
  after(() => { cleanup(project); });

  test('claude guard and cursor hook allow the hinted dispatch', () => {
    writeSentinel(project, { executor_type: HINTED });
    assert.strictEqual(claudeVerdict(project, HINTED), 'allow');
    assert.strictEqual(cursorVerdict(project, HINTED), 'allow');
  });
});

describe('a phase-level record names its executors as executor_types (limit-1 / limit / limit+1 and malformed input)', () => {
  let project;
  const typeName = (i) => `acme-agent-${String(i).padStart(3, '0')}`;
  const names = (n) => Array.from({ length: n }, (_, i) => typeName(i));
  before(() => {
    project = createFixture({ prefix: 'gsd-hinted-exec-types-', planning: true, git: true, projectDoc: false });
    fs.writeFileSync(path.join(project, '.planning', 'config.json'), JSON.stringify({ runtime: 'claude' }));
  });
  after(() => { cleanup(project); });

  test('the bound is 64 entries', () => {
    assert.strictEqual(MAX_EXECUTOR_TYPES, 64);
  });

  test('63, 64 and 65 recorded entries: the reader keeps at most 64 and guards exactly those', () => {
    for (const [count, kept] of [[MAX_EXECUTOR_TYPES - 1, 63], [MAX_EXECUTOR_TYPES, 64], [MAX_EXECUTOR_TYPES + 1, 64]]) {
      writeSentinel(project, { plan: null, executor_types: names(count) });
      const read = readSentinel(project, { clock: fresh });
      assert.strictEqual(read.malformed, false, `count ${count}`);
      assert.strictEqual(read.executorTypes.length, kept, `count ${count}`);
      assert.strictEqual(claudeVerdict(project, typeName(kept - 1)), 'block', `last kept entry at ${count}`);
      // At 65 the record is truncated, so an over-bound name cannot be ruled out: fail closed.
      const over = count > MAX_EXECUTOR_TYPES ? 'block' : 'allow';
      assert.strictEqual(claudeVerdict(project, typeName(MAX_EXECUTOR_TYPES)), over, `the 65th entry (count ${count})`);
    }
  });

  test('a listed executor is blocked without the flag and allowed with it; unlisted agents stay allowed', () => {
    writeSentinel(project, { plan: null, executor_types: [HINTED] });
    assert.strictEqual(claudeDecision(project, HINTED).reasonCode, REASON_CODE.HARNESS_FLAG_MISSING);
    assert.strictEqual(cursorVerdict(project, HINTED), 'deny');
    assert.strictEqual(claudeVerdict(project, HINTED, { isolation: 'worktree' }), 'allow');
    assert.strictEqual(claudeVerdict(project, 'gsd-verifier'), 'allow');
    assert.strictEqual(claudeVerdict(project, 'acme-other-executor'), 'allow');
  });

  test('a stale record still names a listed executor, and so does a record of another phase', () => {
    writeSentinel(project, { plan: null, executor_types: [HINTED], written_at: fresh.now() - SENTINEL_STALE_MS });
    assertSameAsExecutor(project, HINTED, plain, 'stale phase-level record');
    writeSentinel(project, { plan: null, phase: '09', executor_types: [HINTED] });
    const exec = assertSameAsExecutor(project, HINTED, plain, 'different phase');
    assert.strictEqual(exec.action, 'block', 'different phase: classified like gsd-executor');
  });

  test('a non-array executor_types reads as empty and the record stays well-formed', () => {
    for (const bad of ['acme-rails-executor', { 0: HINTED }, 7, null, true]) {
      writeSentinel(project, { plan: null, executor_types: bad });
      const read = readSentinel(project, { clock: fresh });
      assert.strictEqual(read.malformed, false, JSON.stringify(bad));
      assert.deepStrictEqual(read.executorTypes, [], JSON.stringify(bad));
      assert.strictEqual(claudeVerdict(project, HINTED), 'allow', JSON.stringify(bad));
      assert.strictEqual(claudeVerdict(project, 'gsd-executor'), 'block', 'the rest of the record still applies');
    }
  });

  test('invalid entries are dropped and valid ones kept', () => {
    writeSentinel(project, { plan: null, executor_types: ['../x', HINTED, 5, null, 'a/b', '', 'a..b', '-x', 'a'.repeat(129), {}] });
    assert.deepStrictEqual(readSentinel(project, { clock: fresh }).executorTypes, [HINTED]);
    assert.strictEqual(claudeVerdict(project, HINTED), 'block');
  });
});

describe('a truncated phase-level record: executor_types_truncated is read strictly', () => {
  let project;
  const DROPPED = 'acme-dropped-executor';
  before(() => {
    project = createFixture({ prefix: 'gsd-hinted-exec-trunc-', planning: true, git: true, projectDoc: false });
    fs.writeFileSync(path.join(project, '.planning', 'config.json'), JSON.stringify({ runtime: 'claude' }));
  });
  after(() => { cleanup(project); });

  test('only a literal true sets executorTypesTruncated', () => {
    for (const [value, expected] of [[true, true], [false, false], ['true', false], [1, false], [null, false], [undefined, false]]) {
      writeSentinel(project, { plan: null, executor_types: [HINTED], executor_types_truncated: value });
      assert.strictEqual(readSentinel(project, { clock: fresh }).executorTypesTruncated, expected, JSON.stringify(value));
    }
  });

  test('a name dropped from a truncated list is guarded by its canonical marker and by the truncated record itself', () => {
    writeSentinel(project, { plan: null, executor_types: [HINTED], executor_types_truncated: true });
    assert.strictEqual(claudeDecision(project, DROPPED, {}, marker).reasonCode, REASON_CODE.HARNESS_FLAG_MISSING, 'marker');
    assert.strictEqual(cursorVerdict(project, DROPPED, marker), 'deny', 'cursor marker');
    assert.strictEqual(claudeVerdict(project, DROPPED, { isolation: 'worktree' }, marker), 'allow', 'marker with the flag');
    assert.strictEqual(claudeVerdict(project, DROPPED, {}, plain), 'block', 'prose frame only: the truncated record cannot rule it out');
    assert.strictEqual(claudeVerdict(project, DROPPED, {}, 'Do the work.'), 'block', 'no identifiers: the truncated record cannot rule it out');
    assert.strictEqual(cursorVerdict(project, DROPPED, plain), 'deny', 'cursor, prose frame only');
    assert.strictEqual(claudeVerdict(project, 'gsd-verifier', {}, plain), 'allow', 'a GSD role stays allowed');
  });
});

describe('the canonical dispatch marker makes any subagent_type an executor dispatch on gsd-executor\'s exact path', () => {
  const TYPES = ['gsd-executor', HINTED, 'acme-unlisted-executor'];
  let project;
  before(() => {
    project = createFixture({ prefix: 'gsd-hinted-exec-marker-', planning: true, git: true, projectDoc: false });
    fs.writeFileSync(path.join(project, '.planning', 'config.json'), JSON.stringify({ runtime: 'claude' }));
  });
  after(() => { cleanup(project); });

  function clearRecords() {
    cleanup(path.join(project, '.gsd'));
  }

  test('no record at all on a harness-worktree project: every type gets the registry-fallback verdict gsd-executor gets', () => {
    clearRecords();
    const exec = claudeDecision(project, 'gsd-executor', {}, marker);
    assert.strictEqual(exec.action, 'block', 'gsd-executor falls back to the registry capability');
    for (const type of TYPES) {
      const decision = claudeDecision(project, type, {}, marker);
      assert.strictEqual(decision.action, exec.action, type);
      assert.strictEqual(decision.reasonCode, exec.reasonCode, type);
      assert.strictEqual(cursorVerdict(project, type, marker), cursorVerdict(project, 'gsd-executor', marker), `cursor ${type}`);
      assert.strictEqual(claudeVerdict(project, type, { isolation: 'worktree' }, marker), claudeVerdict(project, 'gsd-executor', { isolation: 'worktree' }, marker), `flag ${type}`);
    }
  });

  test('no marker and no matching record: a specialist is allowed, as is a non-executor', () => {
    clearRecords();
    for (const type of [HINTED, 'acme-unlisted-executor', 'gsd-verifier']) {
      assert.strictEqual(claudeVerdict(project, type, {}, plain), 'allow', type);
      assert.strictEqual(claudeVerdict(project, type, {}, 'Do the work.'), 'allow', `${type} no identifiers`);
      assert.strictEqual(cursorVerdict(project, type, plain), 'allow', `cursor ${type}`);
    }
    writeSentinel(project, { executor_type: HINTED });
    assert.strictEqual(claudeVerdict(project, 'gsd-verifier', {}, plain), 'allow', 'a record naming another type does not classify gsd-verifier');
    assert.strictEqual(cursorVerdict(project, 'gsd-verifier', plain), 'allow', 'cursor');
  });

  test('the marker never classifies a GSD role as an executor dispatch', () => {
    clearRecords();
    const ids = extractDispatchIdentifiers(marker);
    assert.strictEqual(ids.source, 'marker', 'precondition: the canonical marker');
    for (const type of ['gsd-verifier', 'GSD-Planner']) {
      assert.strictEqual(isExecutorDispatch(type, { present: false }, ids, { clock: fresh }), false, `isExecutorDispatch ${type}`);
      assert.strictEqual(claudeVerdict(project, type, {}, marker), 'allow', `claude ${type}`);
      assert.strictEqual(cursorVerdict(project, type, marker), 'allow', `cursor ${type}`);
    }
    assert.strictEqual(isExecutorDispatch(HINTED, { present: false }, ids, { clock: fresh }), true, 'a non-role type still is');
  });

  test('an aged recorded none governs a marker-bearing specialist exactly as it governs gsd-executor', () => {
    writeSentinel(project, { isolation: 'none', harness_flag: null, executor_type: HINTED, written_at: fresh.now() - SENTINEL_STALE_MS });
    const exec = assertSameAsExecutor(project, HINTED, marker, 'aged none');
    assert.strictEqual(exec.action, 'allow', 'the aged sequential degrade allows gsd-executor');
  });
});

describe('every applicable candidate record names its executors, not only the newest one', () => {
  const A = 'acme-a';
  const B = 'acme-b';
  let project;
  before(() => {
    project = createFixture({ prefix: 'gsd-hinted-exec-cands-', planning: true, git: true, projectDoc: false });
    fs.writeFileSync(path.join(project, '.planning', 'config.json'), JSON.stringify({ runtime: 'claude' }));
  });
  after(() => { cleanup(project); });

  function writeKeyed(file, over) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      isolation: 'harness-worktree', harness_flag: FLAG, phase: '02', plan: null, written_at: WRITTEN_AT, ...over,
    }));
  }

  // The reproduction: `record --phase 02`, then `--plan 02-01`, then `--plan 02-02`. The phase-level
  // record names acme-a and acme-b; the newest record belongs to plan 02-02 and names only acme-b.
  function recordPhaseThenPlans() {
    cleanup(path.join(project, '.gsd'));
    writeKeyed(phaseSentinelPath(project, '02'), { executor_type: 'gsd-executor', executor_types: [A, B], written_at: WRITTEN_AT });
    writeKeyed(keyedSentinelPath(project, '02', '02-01'), { plan: '02-01', executor_type: A, written_at: WRITTEN_AT + 1 });
    writeKeyed(keyedSentinelPath(project, '02', '02-02'), { plan: '02-02', executor_type: B, written_at: WRITTEN_AT + 2 });
    writeSentinel(project, { plan: '02-02', executor_type: B, written_at: WRITTEN_AT + 2 });
  }

  const prompts = [
    'Execute plan 01 of phase 02.',
    'Run the plan.',
    '[gsd:dispatch phase="02" plan="02-01"] Execute plan 01 of phase 02.',
    '[gsd:dispatch phase="02" plan="02-02"] Execute plan 02 of phase 02.',
  ];

  test('a prose-only dispatch of either specialist gets the verdict and reason gsd-executor gets', () => {
    recordPhaseThenPlans();
    for (const type of [A, B]) {
      for (const text of prompts) {
        const exec = assertSameAsExecutor(project, type, text, `${type} ${JSON.stringify(text.slice(0, 24))}`);
        assert.strictEqual(exec.action, 'block', `gsd-executor is blocked: ${text}`);
        const spec = claudeDecision(project, type, {}, text);
        assert.strictEqual(spec.action, 'block', `${type} ${text}`);
        assert.strictEqual(spec.reasonCode, REASON_CODE.HARNESS_FLAG_MISSING, `${type} ${text}`);
        assert.strictEqual(cursorVerdict(project, type, text), 'deny', `cursor ${type} ${text}`);
      }
    }
  });

  test('the candidates widen nothing for a non-executor or an unlisted agent', () => {
    recordPhaseThenPlans();
    for (const type of ['gsd-verifier', 'acme-unlisted']) {
      assert.strictEqual(claudeVerdict(project, type), 'allow', type);
      assert.strictEqual(cursorVerdict(project, type), 'allow', `cursor ${type}`);
    }
  });

  test('the candidates are not enumerable, so the returned record keeps its shape', () => {
    recordPhaseThenPlans();
    const read = readSentinel(project, { clock: fresh, dispatchIds: { phase: '02', plan: '02-02' } });
    assert.ok(Array.isArray(read.candidates) && read.candidates.length >= 2, 'candidates exposed');
    assert.ok(!Object.keys(read).includes('candidates'), 'not enumerable');
  });
});

describe('every dispatch is classified against any recent record in the project', () => {
  const A = 'acme-a';
  const B = 'acme-b';
  const PHASELESS = 'Run the plan.';
  let project;
  before(() => {
    project = createFixture({ prefix: 'gsd-hinted-exec-phaseless-', planning: true, git: true, projectDoc: false });
    fs.writeFileSync(path.join(project, '.planning', 'config.json'), JSON.stringify({ runtime: 'claude' }));
  });
  after(() => { cleanup(project); });

  function writeKeyed(file, over) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      isolation: 'harness-worktree', harness_flag: FLAG, phase: '02', plan: null, written_at: WRITTEN_AT, ...over,
    }));
  }

  function recordPhaseThenPlans() {
    cleanup(path.join(project, '.gsd'));
    writeKeyed(phaseSentinelPath(project, '02'), { executor_type: 'gsd-executor', executor_types: [A, B] });
    writeKeyed(keyedSentinelPath(project, '02', '02-01'), { plan: '02-01', executor_type: A, written_at: WRITTEN_AT + 1 });
    writeKeyed(keyedSentinelPath(project, '02', '02-02'), { plan: '02-02', executor_type: B, written_at: WRITTEN_AT + 2 });
  }

  test('"Run the plan." gives each listed specialist the verdict and reason gsd-executor gets, in both guards', () => {
    recordPhaseThenPlans();
    for (const type of [A, B]) {
      const exec = assertSameAsExecutor(project, type, PHASELESS, type);
      assert.strictEqual(exec.action, 'block', 'gsd-executor is blocked');
      const spec = claudeDecision(project, type, {}, PHASELESS);
      assert.strictEqual(spec.action, 'block', `${type} claude`);
      assert.strictEqual(spec.reasonCode, REASON_CODE.HARNESS_FLAG_MISSING, `${type} reason`);
      assert.strictEqual(cursorVerdict(project, type, PHASELESS), 'deny', `${type} cursor`);
      assert.strictEqual(claudeVerdict(project, type, { isolation: 'worktree' }, PHASELESS), 'allow', `${type} with the flag`);
    }
  });

  test('a non-executor and an unlisted agent stay allowed', () => {
    recordPhaseThenPlans();
    for (const type of ['gsd-verifier', 'acme-unlisted']) {
      assert.strictEqual(claudeVerdict(project, type, {}, PHASELESS), 'allow', type);
      assert.strictEqual(cursorVerdict(project, type, PHASELESS), 'allow', `cursor ${type}`);
    }
  });

  test('a stale record naming the type classifies a phase-less dispatch while at most AGED_NONE_MAX_MS old', () => {
    cleanup(path.join(project, '.gsd'));
    writeKeyed(phaseSentinelPath(project, '02'), { executor_types: [A], written_at: fresh.now() - SENTINEL_STALE_MS });
    const exec = assertSameAsExecutor(project, A, PHASELESS, 'stale record');
    assert.strictEqual(exec.action, 'block', 'gsd-executor is blocked');
    assert.strictEqual(claudeVerdict(project, A, {}, PHASELESS), 'block', 'claude');
    assert.strictEqual(cursorVerdict(project, A, PHASELESS), 'deny', 'cursor');
    writeKeyed(phaseSentinelPath(project, '02'), { executor_types: [A], written_at: fresh.now() - AGED_NONE_MAX_MS - 1 });
    assert.strictEqual(claudeVerdict(project, A, {}, PHASELESS), 'allow', 'claude, older than AGED_NONE_MAX_MS');
    assert.strictEqual(cursorVerdict(project, A, PHASELESS), 'allow', 'cursor, older than AGED_NONE_MAX_MS');
  });

  test('non-record entries, directories and mtime-aged unusable files are ignored without throwing', () => {
    // Wall-clock only seeds file mtimes (the filesystem stamps real time); every verdict uses this
    // injected clock, anchored to the seeded mtimes so the aged files really are aged.
    const now = Date.now();
    const clock = { now: () => now };
    cleanup(path.join(project, '.gsd'));
    const dir = path.join(project, '.gsd', 'dispatch-isolation');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
    fs.mkdirSync(path.join(dir, 'subdir.json'));
    // Unusable record files whose mtime is past the recency window cannot name a recent dispatch.
    const OLD = (now - 2 * AGED_NONE_MAX_MS) / 1000;
    for (const [name, text] of [['broken.json', '{not json'], ['empty.json', ''], ['wrong-name.json', JSON.stringify({ isolation: 'harness-worktree', phase: '02', plan: null, written_at: WRITTEN_AT, executor_types: [A] })]]) {
      fs.writeFileSync(path.join(dir, name), text);
      fs.utimesSync(path.join(dir, name), OLD, OLD);
    }
    assert.strictEqual(dispatchesAt(A, clock).claude.action, 'allow', 'claude, only ignorable entries');
    assert.strictEqual(dispatchesAt(A, clock).cur.action, 'allow', 'cursor, only ignorable entries');
    writeKeyed(phaseSentinelPath(project, '02'), { executor_types: [A], written_at: now });
    assert.strictEqual(dispatchesAt(A, clock).claude.action, 'block', 'claude, one valid record among them');
    assert.strictEqual(dispatchesAt(A, clock).cur.action, 'deny', 'cursor, one valid record among them');
  });

  describe('an mtime-recent record file the reader refuses cannot be ruled out: the type gets gsd-executor\'s verdict', () => {
    const canChmod = process.platform !== 'win32' && !(typeof process.getuid === 'function' && process.getuid() === 0);
    const dirPath = () => path.join(project, '.gsd', 'dispatch-isolation');
    const legacyPath = () => path.join(project, SENTINEL_RELATIVE_PATH);
    const reset = () => {
      cleanup(path.join(project, '.gsd'));
      fs.mkdirSync(dirPath(), { recursive: true });
    };
    const body = (over = {}) => JSON.stringify({ isolation: 'harness-worktree', harness_flag: FLAG, phase: '02', plan: null, written_at: WRITTEN_AT, executor_types: [A], ...over });
    const expectFailClosed = (label) => {
      for (const type of ['acme-x', A]) {
        const exec = assertSameAsExecutor(project, type, PHASELESS, `${type} ${label}`);
        assert.strictEqual(exec.action, 'block', `gsd-executor is blocked ${label}`);
        assert.strictEqual(claudeVerdict(project, type, {}, PHASELESS), 'block', `claude ${type} ${label}`);
        assert.strictEqual(claudeDecision(project, type, {}, PHASELESS).reasonCode, exec.reasonCode, `reason ${type} ${label}`);
        assert.strictEqual(cursorVerdict(project, type, PHASELESS), 'deny', `cursor ${type} ${label}`);
      }
      assert.strictEqual(claudeVerdict(project, 'gsd-verifier', {}, PHASELESS), 'allow', `a GSD role stays allowed ${label}`);
      assert.strictEqual(cursorVerdict(project, 'gsd-verifier', PHASELESS), 'allow', `a GSD role stays allowed (cursor) ${label}`);
    };

    test('malformed JSON, an empty file, an array and an unknown isolation value', () => {
      for (const [name, text] of [['broken.json', '{not json'], ['empty.json', ''], ['array.json', '[]'], ['bad-isolation.json', body({ isolation: 'x', phase: 'bad-isolation' })]]) {
        reset();
        fs.writeFileSync(path.join(dirPath(), name), text);
        expectFailClosed(name);
      }
    });

    test('a truncated record (cut mid-JSON)', () => {
      reset();
      fs.writeFileSync(phaseSentinelPath(project, '02'), body().slice(0, -12));
      expectFailClosed('truncated json');
    });

    test('an oversize record', () => {
      reset();
      fs.writeFileSync(phaseSentinelPath(project, '02'), body({ pad: 'x'.repeat(SENTINEL_MAX_BYTES) }));
      expectFailClosed('oversize');
    });

    test('a record whose contents disagree with its filename key', () => {
      reset();
      fs.writeFileSync(path.join(dirPath(), 'wrong-name.json'), body());
      expectFailClosed('key mismatch');
    });

    test('a record without a phase', () => {
      reset();
      fs.writeFileSync(path.join(dirPath(), 'nophase.json'), body({ phase: undefined }));
      expectFailClosed('no phase');
    });

    test('a hard-linked record', (t) => {
      reset();
      fs.writeFileSync(phaseSentinelPath(project, '02'), body());
      try { fs.linkSync(phaseSentinelPath(project, '02'), path.join(project, 'hardlink-6213')); } catch { t.skip('hard links unavailable'); return; }
      try {
        expectFailClosed('hard link');
      } finally {
        cleanup(path.join(project, 'hardlink-6213'));
      }
    });

    test('a symlinked record file', (t) => {
      reset();
      const target = path.join(project, 'target-6213.json');
      fs.writeFileSync(target, body());
      try { fs.symlinkSync(target, phaseSentinelPath(project, '02')); } catch { t.skip('symlinks unavailable'); return; }
      try {
        expectFailClosed('symlinked record');
      } finally {
        cleanup(target);
      }
    });

    test('a mode-000 record file', { skip: !canChmod ? 'win32 or root ignores file mode bits' : false }, () => {
      reset();
      const file = phaseSentinelPath(project, '02');
      fs.writeFileSync(file, body());
      fs.chmodSync(file, 0o000);
      try {
        expectFailClosed('mode-000 record');
      } finally {
        fs.chmodSync(file, 0o644);
      }
    });

    test('a malformed legacy slot', () => {
      reset();
      fs.writeFileSync(legacyPath(), '{not json');
      expectFailClosed('malformed legacy slot');
    });

    test('a symlinked legacy slot', (t) => {
      reset();
      const target = path.join(project, 'legacy-target-6213.json');
      fs.writeFileSync(target, body({ executor_type: A }));
      try { fs.symlinkSync(target, legacyPath()); } catch { t.skip('symlinks unavailable'); return; }
      try {
        expectFailClosed('symlinked legacy slot');
      } finally {
        cleanup(target);
      }
    });

    test('an absent legacy slot (ENOENT) and an mtime-aged malformed legacy slot are not a fail-closed case', () => {
      reset();
      assert.strictEqual(claudeVerdict(project, 'acme-x', {}, PHASELESS), 'allow', 'claude, absent');
      assert.strictEqual(cursorVerdict(project, 'acme-x', PHASELESS), 'allow', 'cursor, absent');
      // The injected clock is anchored to the seeded mtime so the legacy slot really is aged.
      const now = Date.now();
      const clock = { now: () => now };
      fs.writeFileSync(legacyPath(), '{not json');
      const OLD = (now - 2 * AGED_NONE_MAX_MS) / 1000;
      fs.utimesSync(legacyPath(), OLD, OLD);
      assert.strictEqual(dispatchesAt('acme-x', clock).claude.action, 'allow', 'claude, aged');
      assert.strictEqual(dispatchesAt('acme-x', clock).cur.action, 'allow', 'cursor, aged');
    });
  });

  test('a hand-written record listing more than MAX_EXECUTOR_TYPES valid entries cannot rule the dropped names out', () => {
    cleanup(path.join(project, '.gsd'));
    const many = Array.from({ length: MAX_EXECUTOR_TYPES + 1 }, (_, i) => `acme-w${String(i).padStart(3, '0')}`);
    writeKeyed(phaseSentinelPath(project, '02'), { executor_types: many });
    // Read the record the way the guards do for a phase-02 dispatch (the keyed record is chosen only with dispatch identity).
    const dispatchIds = extractDispatchIdentifiers('Execute plan 01 of phase 02.');
    const read = readSentinel(project, { clock: fresh, dispatchIds });
    assert.strictEqual(read.executorTypes.length, MAX_EXECUTOR_TYPES, 'the reader keeps at most MAX_EXECUTOR_TYPES');
    assert.strictEqual(read.executorTypesTruncated, true, 'dropping a valid entry marks the record truncated');
    const dropped = many[MAX_EXECUTOR_TYPES];
    assert.ok(!read.executorTypes.includes(dropped), 'the 65th entry is the dropped one');
    const exec = assertSameAsExecutor(project, dropped, PHASELESS, 'dropped 65th entry');
    assert.strictEqual(exec.action, 'block', 'gsd-executor is blocked');
    assert.strictEqual(claudeVerdict(project, dropped, {}, PHASELESS), 'block', 'claude');
    assert.strictEqual(cursorVerdict(project, dropped, PHASELESS), 'deny', 'cursor');
    assert.strictEqual(claudeVerdict(project, 'gsd-verifier', {}, PHASELESS), 'allow', 'a GSD role stays allowed');
    // Exactly MAX_EXECUTOR_TYPES entries is not truncated.
    writeKeyed(phaseSentinelPath(project, '02'), { executor_types: many.slice(0, MAX_EXECUTOR_TYPES) });
    assert.strictEqual(readSentinel(project, { clock: fresh, dispatchIds }).executorTypesTruncated, false);
    assert.strictEqual(claudeVerdict(project, dropped, {}, PHASELESS), 'allow', 'claude, at the limit');
  });

  test('a heavy day of records stays under the overflow bound: host built-in agents stay allowed, GSD roles never classified', () => {
    // Up to MAX_SCANNED_RECORDS recent records naming gsd-executor: no overflow, so host agents are not
    // forced into a worktree; MAX_SCANNED_RECORDS + 1 is the first count past the bound.
    const ask = 'Find where X is defined.';
    for (const [count, overflow] of [[64, false], [65, false], [MAX_SCANNED_RECORDS - 1, false], [MAX_SCANNED_RECORDS, false], [MAX_SCANNED_RECORDS + 1, true]]) {
      cleanup(path.join(project, '.gsd'));
      writeKeyed(phaseSentinelPath(project, '02'), {});
      for (let i = 1; i < count; i++) {
        const plan = `02-${String(i).padStart(4, '0')}`;
        writeKeyed(keyedSentinelPath(project, '02', plan), { plan, executor_type: 'gsd-executor' });
      }
      for (const type of ['Explore', 'general-purpose', 'Plan']) {
        assert.strictEqual(claudeVerdict(project, type, {}, ask), overflow ? 'block' : 'allow', `claude ${type}, ${count} records`);
        assert.strictEqual(cursorVerdict(project, type, ask), overflow ? 'deny' : 'allow', `cursor ${type}, ${count} records`);
      }
      assert.strictEqual(claudeVerdict(project, 'gsd-verifier', {}, ask), 'allow', `gsd-verifier, ${count} records`);
      assert.strictEqual(cursorVerdict(project, 'gsd-verifier', ask), 'allow', `gsd-verifier cursor, ${count} records`);
    }
  });

  function dispatchesAt(type, clock, text = PHASELESS) {
    const claude = guard.evaluateDispatch({ tool_name: 'Agent', cwd: project, tool_input: { subagent_type: type, prompt: text } }, { clock });
    const cur = cursor.resolveIsolationDecision({ subagent_type: type, task: text, workspace_roots: [project] }, { clock });
    return { claude, cur };
  }

  // MAX_SCANNED_RECORDS equals MAX_SCANNED_DIR_ENTRIES (every parsed record is a directory entry), so
  // MAX_SCANNED_RECORDS + 1 recent record files is the one boundary where the record bound and the entry
  // bound coincide. This test pins that boundary with recent records; the directory-entry test below pins
  // the entry bound with non-record entries, so each bound is exercised through its own kind of entry.
  test('fresh-candidate overflow at MAX_SCANNED_RECORDS fails closed (limit-1 / limit / limit+1)', () => {
    assert.strictEqual(MAX_SCANNED_RECORDS, MAX_SCANNED_DIR_ENTRIES);
    assert.strictEqual(MAX_SCANNED_RECORDS, 1024);
    for (const count of [MAX_SCANNED_RECORDS - 1, MAX_SCANNED_RECORDS, MAX_SCANNED_RECORDS + 1]) {
      cleanup(path.join(project, '.gsd'));
      // No record names A: only an overflowed scan (unread fresh records) can classify it.
      for (let i = 0; i < count; i++) {
        const phase = `f${String(i).padStart(3, '0')}`;
        writeKeyed(phaseSentinelPath(project, phase), { phase, executor_types: [] });
      }
      const overflow = count > MAX_SCANNED_RECORDS;
      assert.strictEqual(claudeVerdict(project, A, {}, PHASELESS), overflow ? 'block' : 'allow', `claude, ${count} files`);
      assert.strictEqual(cursorVerdict(project, A, PHASELESS), overflow ? 'deny' : 'allow', `cursor, ${count} files`);
    }
  });

  test('a scan holding exactly MAX_SCANNED_RECORDS records still reads the one naming the type', () => {
    cleanup(path.join(project, '.gsd'));
    for (let i = 0; i < MAX_SCANNED_RECORDS - 1; i++) {
      const phase = `f${String(i).padStart(3, '0')}`;
      writeKeyed(phaseSentinelPath(project, phase), { phase, executor_types: [] });
    }
    writeKeyed(phaseSentinelPath(project, 'zz'), { phase: 'zz', executor_types: [A] });
    assert.strictEqual(claudeVerdict(project, A, {}, PHASELESS), 'block');
    assert.strictEqual(cursorVerdict(project, A, PHASELESS), 'deny');
  });

  test('directory-entry bound: MAX_SCANNED_DIR_ENTRIES entries scan normally, one more fails closed (limit-1 / limit / limit+1)', () => {
    assert.strictEqual(MAX_SCANNED_DIR_ENTRIES, 1024);
    for (const count of [MAX_SCANNED_DIR_ENTRIES - 1, MAX_SCANNED_DIR_ENTRIES, MAX_SCANNED_DIR_ENTRIES + 1]) {
      cleanup(path.join(project, '.gsd'));
      const dir = path.join(project, '.gsd', 'dispatch-isolation');
      fs.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < count; i++) fs.writeFileSync(path.join(dir, `x${String(i).padStart(4, '0')}.txt`), '');
      const overflow = count > MAX_SCANNED_DIR_ENTRIES;
      assert.strictEqual(claudeVerdict(project, A, {}, PHASELESS), overflow ? 'block' : 'allow', `claude, ${count} entries`);
      assert.strictEqual(cursorVerdict(project, A, PHASELESS), overflow ? 'deny' : 'allow', `cursor, ${count} entries`);
    }
  });

  test('overflow never classifies a GSD role or an invalid name', () => {
    cleanup(path.join(project, '.gsd'));
    for (let i = 0; i < MAX_SCANNED_RECORDS + 1; i++) {
      const phase = `f${String(i).padStart(3, '0')}`;
      writeKeyed(phaseSentinelPath(project, phase), { phase, executor_types: [] });
    }
    assert.strictEqual(claudeVerdict(project, A, {}, PHASELESS), 'block', 'precondition: the scan overflowed');
    for (const type of ['gsd-verifier', 'GSD-Planner', 'bad name', 'a/b', '..', '-x', 'x'.repeat(129)]) {
      assert.strictEqual(claudeVerdict(project, type, {}, PHASELESS), 'allow', `claude ${type}`);
      assert.strictEqual(cursorVerdict(project, type, PHASELESS), 'allow', `cursor ${type}`);
    }
    assert.strictEqual(claudeVerdict(project, 'gsd-executor', {}, PHASELESS), 'block', 'gsd-executor itself stays guarded');
  });

  test('a gsd-prefixed custom executor fails closed under overflow exactly as a non-gsd custom executor does', () => {
    cleanup(path.join(project, '.gsd'));
    for (let i = 0; i < MAX_SCANNED_RECORDS + 1; i++) {
      const phase = `f${String(i).padStart(3, '0')}`;
      writeKeyed(phaseSentinelPath(project, phase), { phase, executor_types: [] });
    }
    for (const type of ['gsd-rails-executor', 'gsd-unknown-role', 'acme-x']) {
      assert.strictEqual(claudeVerdict(project, type, {}, PHASELESS), 'block', `claude ${type}`);
      assert.strictEqual(cursorVerdict(project, type, PHASELESS), 'deny', `cursor ${type}`);
      assertSameAsExecutor(project, type, PHASELESS, type);
    }
  });

  describe('a keyed directory the scan cannot enumerate fails closed; a missing one is empty', () => {
    const canChmod = process.platform !== 'win32' && !(typeof process.getuid === 'function' && process.getuid() === 0);
    const dirPath = () => path.join(project, '.gsd', 'dispatch-isolation');
    const expectBlocked = (label) => {
      for (const type of ['acme-x', 'gsd-rails-executor']) {
        assert.strictEqual(claudeVerdict(project, type, {}, PHASELESS), 'block', `claude ${type} ${label}`);
        assert.strictEqual(cursorVerdict(project, type, PHASELESS), 'deny', `cursor ${type} ${label}`);
        assertSameAsExecutor(project, type, PHASELESS, `${type} ${label}`);
      }
      assert.strictEqual(claudeVerdict(project, 'gsd-verifier', {}, PHASELESS), 'allow', `a GSD role stays allowed ${label}`);
    };

    test('ENOENT: no directory is an empty scan, not an overflow', () => {
      cleanup(path.join(project, '.gsd'));
      fs.mkdirSync(path.join(project, '.gsd'), { recursive: true });
      assert.strictEqual(claudeVerdict(project, 'acme-x', {}, PHASELESS), 'allow', 'claude');
      assert.strictEqual(cursorVerdict(project, 'acme-x', PHASELESS), 'allow', 'cursor');
    });

    test('the directory is a symlink to a real directory', (t) => {
      cleanup(path.join(project, '.gsd'));
      const real = path.join(project, 'elsewhere');
      fs.mkdirSync(real, { recursive: true });
      fs.mkdirSync(path.join(project, '.gsd'), { recursive: true });
      try { fs.symlinkSync(real, dirPath(), 'dir'); } catch { t.skip('symlinks unavailable'); return; }
      expectBlocked('symlinked directory');
    });

    test('case C: .gsd itself is a symlink to a real directory', (t) => {
      cleanup(path.join(project, '.gsd'));
      const real = path.join(project, 'elsewhere-gsd');
      fs.mkdirSync(path.join(real, 'dispatch-isolation'), { recursive: true });
      try { fs.symlinkSync(real, path.join(project, '.gsd'), 'dir'); } catch { t.skip('symlinks unavailable'); return; }
      expectBlocked('symlinked .gsd');
    });

    test('.gsd is a regular file', () => {
      cleanup(path.join(project, '.gsd'));
      fs.writeFileSync(path.join(project, '.gsd'), 'not a directory');
      expectBlocked('file at .gsd');
    });

    test('a regular file sits at the directory path', () => {
      cleanup(path.join(project, '.gsd'));
      fs.mkdirSync(path.join(project, '.gsd'), { recursive: true });
      fs.writeFileSync(dirPath(), 'not a directory');
      expectBlocked('file at directory path');
    });

    test('a mode-000 directory cannot be read', { skip: !canChmod ? 'win32 or root ignores directory mode bits' : false }, () => {
      cleanup(path.join(project, '.gsd'));
      writeKeyed(phaseSentinelPath(project, '02'), { executor_types: [A] });
      fs.chmodSync(dirPath(), 0o000);
      try {
        expectBlocked('mode-000 directory');
      } finally {
        fs.chmodSync(dirPath(), 0o755);
      }
    });

    test('a mode-444 directory (readable, not searchable) cannot be enumerated: every lstat fails', { skip: !canChmod ? 'win32 or root ignores directory mode bits' : false }, () => {
      cleanup(path.join(project, '.gsd'));
      writeKeyed(phaseSentinelPath(project, '02'), { executor_types: [A], written_at: fresh.now() });
      fs.chmodSync(dirPath(), 0o444);
      try {
        expectBlocked('mode-444 directory');
      } finally {
        fs.chmodSync(dirPath(), 0o755);
      }
    });

    test('an upper-case .JSON record is still scanned: its type is classified as an executor', () => {
      cleanup(path.join(project, '.gsd'));
      fs.mkdirSync(dirPath(), { recursive: true });
      fs.writeFileSync(path.join(dirPath(), '02.JSON'), JSON.stringify({
        isolation: 'harness-worktree', harness_flag: FLAG, phase: '02', plan: null, written_at: WRITTEN_AT, executor_types: [A],
      }));
      // On a case-insensitive volume the key resolves to the same file (dev/ino match) and the record names
      // the type; on a case-sensitive one the name is a key mismatch, which fails closed. Either way the
      // type is an executor dispatch; before the case-insensitive suffix check the entry was skipped (allowed).
      assert.strictEqual(claudeVerdict(project, A, {}, PHASELESS), 'block', 'claude');
      assert.strictEqual(cursorVerdict(project, A, PHASELESS), 'deny', 'cursor');
      assert.strictEqual(claudeVerdict(project, 'gsd-verifier', {}, PHASELESS), 'allow', 'a GSD role stays allowed');
    });

    test('a record whose suffix is spelled with U+017F (long s) is still scanned: fail-closed on every volume', () => {
      cleanup(path.join(project, '.gsd'));
      fs.mkdirSync(dirPath(), { recursive: true });
      fs.writeFileSync(path.join(dirPath(), '02.jſon'), JSON.stringify({
        isolation: 'harness-worktree', harness_flag: FLAG, phase: '02', plan: null, written_at: WRITTEN_AT, executor_types: [A],
      }));
      // A case-insensitive volume folds U+017F to `s`, so the entry resolves as 02.json; a case-sensitive one
      // sees a key mismatch. Either way the entry must be scanned, not skipped.
      assert.strictEqual(claudeVerdict(project, A, {}, PHASELESS), 'block', 'claude');
      assert.strictEqual(cursorVerdict(project, A, PHASELESS), 'deny', 'cursor');
      assert.strictEqual(claudeVerdict(project, 'gsd-verifier', {}, PHASELESS), 'allow', 'a GSD role stays allowed');
    });

    test('hasJsonSuffix: matches every spelling that folds to .json, rejects the rest', () => {
      assert.strictEqual(hasJsonSuffix('02.json'), true);
      assert.strictEqual(hasJsonSuffix('02.JSON'), true);
      assert.strictEqual(hasJsonSuffix('02.jſon'), true);
      assert.strictEqual(hasJsonSuffix('02.jsonx'), false);
      assert.strictEqual(hasJsonSuffix('json'), false);
      for (const v of [undefined, null, 42, {}, ['a.json']]) assert.strictEqual(hasJsonSuffix(v), false, String(typeof v));
    });
  });

  describe('a truncated applicable record cannot rule a type out', () => {
    const rec = (over) => {
      cleanup(path.join(project, '.gsd'));
      writeKeyed(phaseSentinelPath(project, '10'), { phase: '10', executor_types: [A], ...over });
    };
    const PROSE = 'Execute plan 01 of phase 10.';

    test('executor_types_truncated true: an unlisted valid non-role name is classified as gsd-executor is; false: allowed', () => {
      rec({ executor_types_truncated: true });
      for (const type of ['acme-z', 'gsd-rails-executor']) {
        assert.strictEqual(claudeVerdict(project, type, {}, PROSE), 'block', `claude ${type}`);
        assert.strictEqual(cursorVerdict(project, type, PROSE), 'deny', `cursor ${type}`);
        assertSameAsExecutor(project, type, PROSE, `${type} truncated`);
      }
      assert.strictEqual(claudeVerdict(project, 'gsd-verifier', {}, PROSE), 'allow', 'a GSD role is never classified');
      rec({ executor_types_truncated: false });
      assert.strictEqual(claudeVerdict(project, 'acme-z', {}, PROSE), 'allow', 'claude, not truncated');
      assert.strictEqual(cursorVerdict(project, 'acme-z', PROSE), 'allow', 'cursor, not truncated');
      assert.strictEqual(claudeVerdict(project, A, {}, PROSE), 'block', 'a listed name is still guarded');
    });

    test('a truncated record of another phase applies too', () => {
      rec({ executor_types_truncated: true });
      const exec = assertSameAsExecutor(project, 'acme-z', 'Execute plan 01 of phase 11.', 'truncated, other phase');
      assert.strictEqual(exec.action, 'block', 'gsd-executor is blocked');
      assert.strictEqual(claudeVerdict(project, 'acme-z', {}, 'Execute plan 01 of phase 11.'), 'block', 'claude');
      assert.strictEqual(cursorVerdict(project, 'acme-z', 'Execute plan 01 of phase 11.'), 'deny', 'cursor');
    });

    test('an aged truncated record (case B) classifies a dropped name; past AGED_NONE_MAX_MS it does not', () => {
      rec({ executor_types_truncated: true, written_at: fresh.now() - 30 * 60 * 1000 });
      const exec = assertSameAsExecutor(project, 'acme-z', PROSE, 'aged truncated');
      assert.strictEqual(exec.action, 'block', 'gsd-executor is blocked');
      assert.strictEqual(claudeVerdict(project, 'acme-z', {}, PROSE), 'block', 'claude');
      assert.strictEqual(cursorVerdict(project, 'acme-z', PROSE), 'deny', 'cursor');
      for (const [age, blocked] of [[AGED_NONE_MAX_MS - 1, true], [AGED_NONE_MAX_MS, true], [AGED_NONE_MAX_MS + 1, false]]) {
        rec({ executor_types_truncated: true, written_at: fresh.now() - age });
        assert.strictEqual(claudeVerdict(project, 'acme-z', {}, PROSE), blocked ? 'block' : 'allow', `claude age ${age}`);
        assert.strictEqual(cursorVerdict(project, 'acme-z', PROSE), blocked ? 'deny' : 'allow', `cursor age ${age}`);
      }
    });
  });

  test('aged records filling the directory do not hide a recent later-phase record (mtime pre-filter)', () => {
    // Wall-clock only seeds file mtimes (the filesystem stamps real time); every verdict uses this injected clock.
    const now = Date.now();
    const clock = { now: () => now };
    const OLD = now - 2 * AGED_NONE_MAX_MS;
    cleanup(path.join(project, '.gsd'));
    // MAX_SCANNED_DIR_ENTRIES - 1 records older than AGED_NONE_MAX_MS whose names sort BEFORE the recent one:
    // with the recent record the directory holds exactly MAX_SCANNED_DIR_ENTRIES entries, so no bound is hit.
    for (let i = 0; i < MAX_SCANNED_DIR_ENTRIES - 1; i++) {
      const phase = `0${String(i).padStart(3, '0')}`;
      const file = phaseSentinelPath(project, phase);
      writeKeyed(file, { phase, executor_types: [], written_at: OLD });
      fs.utimesSync(file, OLD / 1000, OLD / 1000);
    }
    writeKeyed(keyedSentinelPath(project, '10', '10-01'), { phase: '10', plan: '10-01', executor_type: A, written_at: now });
    // The legacy slot is fresh and names another executor.
    writeSentinel(project, { phase: '10', plan: '10-01', executor_type: 'acme-y', written_at: now });
    const exec = dispatchesAt('gsd-executor', clock);
    const spec = dispatchesAt(A, clock);
    assert.strictEqual(exec.claude.action, 'block', 'gsd-executor blocked');
    assert.strictEqual(spec.claude.action, 'block', 'claude');
    assert.strictEqual(spec.claude.reasonCode, exec.claude.reasonCode, 'same reason as gsd-executor');
    assert.strictEqual(spec.cur.action, 'deny', 'cursor');
    assert.strictEqual(spec.cur.action, dispatchesAt('gsd-executor', clock).cur.action);
    assert.strictEqual(dispatchesAt('acme-unlisted', clock).claude.action, 'allow', 'an unlisted agent stays allowed (no overflow: aged records were dropped)');
  });

  test('mtime pre-filter boundary: older than AGED_NONE_MAX_MS + skew is skipped, at or inside it is read (limit-1 / limit / limit+1)', () => {
    // clock.now is injected; file mtimes are whole seconds, so ages are exact. CLOCK_SKEW_MS is the
    // reader's clock-skew allowance (hooks/lib/isolation-sentinel.js).
    const SKEW = CLOCK_SKEW_MS;
    const T = 1_700_000_000;
    for (const [delta, read] of [[-1, true], [0, true], [1, false]]) {
      const nowMs = T * 1000 + AGED_NONE_MAX_MS + SKEW + delta;
      const clock = { now: () => nowMs };
      const label = `mtime age AGED+SKEW${delta >= 0 ? '+' : ''}${delta}`;
      cleanup(path.join(project, '.gsd'));
      // The target record names A and is the only record: it is classified only when the mtime
      // pre-filter keeps it, so skipping it changes the verdict for A.
      const target = phaseSentinelPath(project, '02');
      writeKeyed(target, { executor_types: [A], written_at: nowMs });
      fs.utimesSync(target, T, T);
      assert.strictEqual(dispatchesAt(A, clock).claude.action, read ? 'block' : 'allow', `claude, ${label}`);
      assert.strictEqual(dispatchesAt(A, clock).cur.action, read ? 'deny' : 'allow', `cursor, ${label}`);
    }
  });

  test('a record of another phase names the type: a dispatch of phase 09 gets the verdict gsd-executor gets', () => {
    recordPhaseThenPlans();
    const exec = assertSameAsExecutor(project, A, 'Execute plan 01 of phase 09.', 'record of another phase');
    assert.strictEqual(exec.action, 'block', 'gsd-executor is blocked');
    assert.strictEqual(claudeVerdict(project, A, {}, 'Execute plan 01 of phase 09.'), 'block', 'claude');
    assert.strictEqual(cursorVerdict(project, A, 'Execute plan 01 of phase 09.'), 'deny', 'cursor');
  });

  test('a GSD role and an unnamed agent stay allowed with recent records naming others, whatever the phase', () => {
    recordPhaseThenPlans();
    for (const text of ['Execute plan 01 of phase 09.', PHASELESS, 'execute plan 01 of phase 2']) {
      for (const type of ['gsd-verifier', 'acme-unnamed']) {
        assert.strictEqual(claudeVerdict(project, type, {}, text), 'allow', `claude ${type} ${text}`);
        assert.strictEqual(cursorVerdict(project, type, text), 'allow', `cursor ${type} ${text}`);
      }
    }
  });

  test('a recent record whose written_at is more than CLOCK_SKEW_MS in the future is an unusable recent entry (limit-1 / limit / limit+1, keyed and legacy)', () => {
    // Real mtimes are recent; every verdict uses this injected clock, anchored to them.
    const now = Date.now();
    const clock = { now: () => now };
    for (const legacy of [false, true]) {
      for (const [delta, failClosed] of [[-1, false], [0, false], [1, true]]) {
        const label = `${legacy ? 'legacy slot' : 'keyed record'}, written_at = now + skew${delta >= 0 ? '+' : ''}${delta}`;
        cleanup(path.join(project, '.gsd'));
        const over = { executor_types: [B], written_at: now + CLOCK_SKEW_MS + delta };
        if (legacy) writeSentinel(project, { plan: null, ...over });
        else writeKeyed(phaseSentinelPath(project, '02'), over);
        // A is named by no record: it is held only when the future-dated record cannot be ruled out.
        const exec = dispatchesAt('gsd-executor', clock);
        assert.strictEqual(exec.claude.action, 'block', `gsd-executor, ${label}`);
        const a = dispatchesAt(A, clock);
        assert.strictEqual(a.claude.action, failClosed ? 'block' : 'allow', `claude ${A}, ${label}`);
        assert.strictEqual(a.cur.action, failClosed ? 'deny' : 'allow', `cursor ${A}, ${label}`);
        if (failClosed) assert.strictEqual(a.claude.reasonCode, exec.claude.reasonCode, `same reason as gsd-executor, ${label}`);
        // B is named by the record: classified while the record counts as recent, fail-closed beyond it.
        assert.strictEqual(dispatchesAt(B, clock).claude.action, 'block', `claude ${B}, ${label}`);
        assert.strictEqual(dispatchesAt('gsd-verifier', clock).claude.action, 'allow', `gsd-verifier claude, ${label}`);
        assert.strictEqual(dispatchesAt('gsd-verifier', clock).cur.action, 'allow', `gsd-verifier cursor, ${label}`);
      }
    }
  });

  describe('a dispatch that names a phase but no plan is classified like any other', () => {
    const PHASE_ONLY = 'execute plan 01 of phase 02';

    function onlyPlanRecordNamesA() {
      cleanup(path.join(project, '.gsd'));
      writeKeyed(keyedSentinelPath(project, '02', '02-01'), { plan: '02-01', executor_type: A });
      // The legacy slot names another plan of the same phase and gsd-executor only.
      writeSentinel(project, { phase: '02', plan: '02-02', executor_type: 'gsd-executor' });
    }

    test('the only record naming the type is a plan-keyed record of the phase: the type gets the verdict and reason gsd-executor gets', () => {
      onlyPlanRecordNamesA();
      const exec = assertSameAsExecutor(project, A, PHASE_ONLY, 'phase-only prose');
      assert.strictEqual(exec.action, 'block', 'gsd-executor is blocked');
      const spec = claudeDecision(project, A, {}, PHASE_ONLY);
      assert.strictEqual(spec.action, 'block', 'claude');
      assert.strictEqual(spec.reasonCode, REASON_CODE.HARNESS_FLAG_MISSING, 'reason');
      assert.strictEqual(cursorVerdict(project, A, PHASE_ONLY), 'deny', 'cursor');
      assert.strictEqual(claudeVerdict(project, A, { isolation: 'worktree' }, PHASE_ONLY), 'allow', 'with the flag');
    });

    test('a GSD role stays allowed', () => {
      onlyPlanRecordNamesA();
      assert.strictEqual(claudeVerdict(project, 'gsd-verifier', {}, PHASE_ONLY), 'allow', 'claude');
      assert.strictEqual(cursorVerdict(project, 'gsd-verifier', PHASE_ONLY), 'allow', 'cursor');
    });

    test('a plan record of another phase classifies, and another phase\'s overflow fails closed', () => {
      cleanup(path.join(project, '.gsd'));
      writeKeyed(keyedSentinelPath(project, '03', '03-01'), { phase: '03', plan: '03-01', executor_type: A });
      const exec = assertSameAsExecutor(project, A, PHASE_ONLY, 'other phase record');
      assert.strictEqual(exec.action, 'block', 'gsd-executor is blocked');
      assert.strictEqual(claudeVerdict(project, A, {}, PHASE_ONLY), 'block', 'claude, other phase record');
      assert.strictEqual(cursorVerdict(project, A, PHASE_ONLY), 'deny', 'cursor, other phase record');
      for (let i = 0; i < MAX_SCANNED_RECORDS + 1; i++) {
        const plan = `03-${String(i + 2).padStart(3, '0')}`;
        writeKeyed(keyedSentinelPath(project, '03', plan), { phase: '03', plan, executor_types: [] });
      }
      const overflowed = assertSameAsExecutor(project, 'acme-x', PHASE_ONLY, 'other phase overflowing');
      assert.strictEqual(overflowed.action, 'block', 'gsd-executor is blocked');
      assert.strictEqual(claudeVerdict(project, 'acme-x', {}, PHASE_ONLY), 'block', 'claude, other phase overflowing');
      assert.strictEqual(cursorVerdict(project, 'acme-x', PHASE_ONLY), 'deny', 'cursor, other phase overflowing');
      assert.strictEqual(claudeVerdict(project, 'gsd-verifier', {}, PHASE_ONLY), 'allow', 'a GSD role stays allowed');
    });

    test('case A: a 30-minute-old plan record is the only one naming the type, with phase-only prose', () => {
      cleanup(path.join(project, '.gsd'));
      const aged = fresh.now() - 30 * 60 * 1000;
      const file = keyedSentinelPath(project, '02', '02-01');
      writeKeyed(file, { plan: '02-01', executor_type: A, written_at: aged });
      writeSentinel(project, { phase: '02', plan: '02-02', executor_type: 'gsd-executor' });
      const exec = assertSameAsExecutor(project, A, PHASE_ONLY, 'case A');
      assert.strictEqual(exec.action, 'block', 'gsd-executor is blocked');
      assert.strictEqual(claudeVerdict(project, A, {}, PHASE_ONLY), 'block', 'claude');
      assert.strictEqual(claudeDecision(project, A, {}, PHASE_ONLY).reasonCode, exec.reasonCode, 'same reason');
      assert.strictEqual(cursorVerdict(project, A, PHASE_ONLY), 'deny', 'cursor');
    });

    test('case M: "phase 2" prose against records keyed "02"', () => {
      cleanup(path.join(project, '.gsd'));
      writeKeyed(keyedSentinelPath(project, '02', '02-01'), { plan: '02-01', executor_type: A });
      writeKeyed(phaseSentinelPath(project, '02'), { executor_types: [A] });
      writeSentinel(project, { phase: '02', plan: '02-01', executor_type: A });
      const text = 'execute plan 01 of phase 2';
      const exec = assertSameAsExecutor(project, A, text, 'case M');
      assert.strictEqual(exec.action, 'block', 'gsd-executor is blocked');
      assert.strictEqual(claudeVerdict(project, A, {}, text), 'block', 'claude');
      assert.strictEqual(cursorVerdict(project, A, text), 'deny', 'cursor');
    });

    test('entries of other phases count toward the directory bound: limit-1 / limit allow, limit+1 fails closed like gsd-executor', () => {
      const UNNAMED = 'acme-x';
      for (const [count, overflow] of [[MAX_SCANNED_DIR_ENTRIES - 1, false], [MAX_SCANNED_DIR_ENTRIES, false], [MAX_SCANNED_DIR_ENTRIES + 1, true]]) {
        cleanup(path.join(project, '.gsd'));
        const keyedPath = keyedSentinelPath(project, '02', '02-01');
        writeKeyed(keyedPath, { plan: '02-01', executor_type: A });
        const dir = path.dirname(keyedPath);
        for (let i = 1; i < count; i++) fs.writeFileSync(path.join(dir, `03--filler-${i}.txt`), '');
        assert.strictEqual(fs.readdirSync(dir).length, count, 'directory holds exactly the planned entry count');
        assert.strictEqual(claudeVerdict(project, UNNAMED, {}, PHASE_ONLY), overflow ? 'block' : 'allow', `claude, ${count} entries`);
        assert.strictEqual(cursorVerdict(project, UNNAMED, PHASE_ONLY), overflow ? 'deny' : 'allow', `cursor, ${count} entries`);
        assert.strictEqual(claudeVerdict(project, 'gsd-verifier', {}, PHASE_ONLY), 'allow', `a GSD role stays allowed, ${count} entries`);
        if (overflow) {
          const exec = assertSameAsExecutor(project, UNNAMED, PHASE_ONLY, 'phase-only directory overflow');
          assert.strictEqual(claudeDecision(project, UNNAMED, {}, PHASE_ONLY).reasonCode, exec.reasonCode, 'same reason as gsd-executor');
        }
      }
    });

    test('the phase\'s own overflow fails closed (limit / limit+1)', () => {
      for (const [count, overflow] of [[MAX_SCANNED_RECORDS, false], [MAX_SCANNED_RECORDS + 1, true]]) {
        cleanup(path.join(project, '.gsd'));
        for (let i = 0; i < count; i++) {
          const plan = `02-${String(i + 1).padStart(3, '0')}`;
          writeKeyed(keyedSentinelPath(project, '02', plan), { plan, executor_types: [] });
        }
        assert.strictEqual(claudeVerdict(project, A, {}, PHASE_ONLY), overflow ? 'block' : 'allow', `claude, ${count} files`);
        assert.strictEqual(cursorVerdict(project, A, PHASE_ONLY), overflow ? 'deny' : 'allow', `cursor, ${count} files`);
        assert.strictEqual(claudeVerdict(project, 'gsd-verifier', {}, PHASE_ONLY), 'allow', `a GSD role stays allowed, ${count} files`);
      }
    });
  });
});

describe('reader-side GSD role predicate and deny-message names', () => {
  test('isGsdRoleName parity: the reader set equals the MODEL_PROFILES keys other than gsd-executor, in both directions', () => {
    const { MODEL_PROFILES } = require('../gsd-core/bin/lib/model-profiles.cjs');
    const keys = Object.keys(MODEL_PROFILES);
    assert.ok(keys.length > 0);
    const writerRoles = new Set(keys.map((k) => k.toLowerCase()).filter((k) => k !== 'gsd-executor'));
    // writer -> reader: every refused role is a reader role, whatever its spacing and case.
    for (const key of keys) {
      const expected = writerRoles.has(key.toLowerCase());
      assert.strictEqual(isGsdRoleName(key), expected, key);
      assert.strictEqual(isGsdRoleName(` ${key.toUpperCase()} `), expected, `${key} spacing/case`);
    }
    // reader -> writer: the reader names no role the writer would route (a gsd-* custom executor is not a role).
    assert.deepStrictEqual([...GSD_ROLE_NAMES].sort(), [...writerRoles].sort());
    for (const name of GSD_ROLE_NAMES) assert.ok(writerRoles.has(name), `reader-only role ${name}`);
    for (const custom of ['gsd-rails-executor', 'gsd-unknown-role', 'GSD-Rails-Executor']) assert.strictEqual(isGsdRoleName(custom), false, custom);
    assert.strictEqual(isGsdRoleName('acme-x'), false);
    assert.strictEqual(isGsdRoleName(undefined), false);
  });

  describe('a subagent_type that is not a valid name never enters a deny message', () => {
    const MARKED = '[gsd:dispatch phase="02" plan="02-01-api"] Execute plan 01 of phase 02.';
    const hostile = `${'x\n'.repeat(150)}`; // 300 characters over multiple lines
    let project;
    before(() => {
      project = createFixture({ prefix: 'gsd-hinted-exec-name-', planning: true, git: true, projectDoc: false });
      fs.writeFileSync(path.join(project, '.planning', 'config.json'), JSON.stringify({ runtime: 'claude' }));
      writeSentinel(project);
    });
    after(() => { cleanup(project); });

    test('the fixture name is invalid, 300 characters and multi-line', () => {
      assert.strictEqual(hostile.length, 300);
      assert.ok(hostile.includes('\n'));
      assert.strictEqual(isValidExecutorType(hostile), false);
    });

    test('Claude guard: the canonical marker classifies it; the message shows the placeholder', () => {
      const d = claudeDecision(project, hostile, {}, MARKED);
      assert.strictEqual(d.action, 'block');
      assert.strictEqual(d.agentName, '<invalid agent name>');
      assert.ok(d.reason.includes(`subagent_type="${d.agentName}"`), d.reason);
      assert.ok(!d.reason.includes('x\nx'), 'the raw name is absent');
    });

    test('Cursor hook: the canonical marker classifies it; the message shows the placeholder', () => {
      const d = cursorDecision(project, hostile, MARKED);
      assert.strictEqual(d.action, 'deny');
      assert.strictEqual(d.agentName, '<invalid agent name>');
      assert.ok(d.reason.includes(`subagent_type="${d.agentName}"`), d.reason);
      assert.ok(!d.reason.includes('x\nx'), 'the raw name is absent');
    });

    test('displayAgentName maps a hostile name to the fixed placeholder and a valid name to itself', () => {
      assert.strictEqual(displayAgentName(hostile), '<invalid agent name>');
      assert.strictEqual(displayAgentName(HINTED), HINTED);
    });

    test('a valid name is still shown verbatim', () => {
      const d = claudeDecision(project, HINTED, {}, MARKED);
      assert.strictEqual(d.action, 'block');
      assert.strictEqual(d.agentName, HINTED);
      assert.strictEqual(cursorDecision(project, HINTED, MARKED).agentName, HINTED);
    });
  });
});

describe('cursor hook classifies a dispatch once across every workspace root', () => {
  const A = 'acme-a';
  let rootX;
  let rootY;
  before(() => {
    const mk = (prefix) => {
      const p = createFixture({ prefix, planning: true, git: true, projectDoc: false });
      fs.writeFileSync(path.join(p, '.planning', 'config.json'), JSON.stringify({ runtime: 'cursor' }));
      return p;
    };
    rootX = mk('gsd-hinted-exec-rootx-');
    rootY = mk('gsd-hinted-exec-rooty-');
  });
  after(() => { cleanup(rootX); cleanup(rootY); });

  const decide = (type, roots) => cursor.resolveIsolationDecision({ subagent_type: type, task: 'Run the plan.', workspace_roots: roots }, { clock: fresh });

  test('a record in one root naming the type makes every root enforce gsd-executor\'s verdict (a root with no record resolves its own isolation)', () => {
    // X records a sequential decision naming A; Y has no record and resolves to a host worktree.
    writeSentinel(rootX, { isolation: 'none', harness_flag: null, phase: '02', plan: null, executor_type: A });
    const exec = decide('gsd-executor', [rootX, rootY]);
    assert.strictEqual(exec.action, 'deny', 'gsd-executor is denied by root Y');
    const spec = decide(A, [rootX, rootY]);
    assert.strictEqual(spec.action, 'deny', 'the specialist is denied by root Y');
    assert.strictEqual(spec.reasonCode, exec.reasonCode, 'same reason as gsd-executor');
    assert.strictEqual(exec.agentName, 'gsd-executor');
    assert.strictEqual(spec.agentName, A, 'the deny names the specialist');
    assert.strictEqual(decide(A, [rootY]).action, 'allow', 'with only root Y no record names the type');
    assert.strictEqual(decide('gsd-verifier', [rootX, rootY]).action, 'allow', 'a GSD role is never classified');
  });
});

describe('the reader tolerates a writer\'s atomic rename and judges a record by file identity', () => {
  const A = 'acme-a';
  const IDS = { phase: '02', plan: null };
  let project;
  before(() => {
    project = createFixture({ prefix: 'gsd-hinted-exec-rename-', planning: true, git: true, projectDoc: false });
    fs.writeFileSync(path.join(project, '.planning', 'config.json'), JSON.stringify({ runtime: 'claude' }));
  });
  after(() => { cleanup(project); });

  const dirPath = () => path.join(project, '.gsd', 'dispatch-isolation');
  const legacyPath = () => path.join(project, SENTINEL_RELATIVE_PATH);
  const body = (over = {}) => JSON.stringify({ isolation: 'harness-worktree', harness_flag: FLAG, phase: '03', plan: null, written_at: WRITTEN_AT, executor_types: [A], ...over });
  const reset = () => {
    cleanup(path.join(project, '.gsd'));
    fs.mkdirSync(dirPath(), { recursive: true });
  };

  // A replacement for the reader's file read. `script` maps a file's basename to the outcome of each
  // successive read of it: 'refuse' (a refused read, as a rename straddling the read produces), 'vanish'
  // (the file is removed, then the read is refused) or 'ok' (the real contents; the default).
  function scripted(script) {
    const calls = {};
    const readText = (file) => {
      const base = path.basename(file);
      calls[base] = (calls[base] || 0) + 1;
      const outcome = (script[base] || [])[calls[base] - 1] || 'ok';
      if (outcome === 'refuse') return null;
      try {
        if (outcome === 'vanish') {
          fs.unlinkSync(file);
          return null;
        }
        return fs.readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    };
    return { readText, calls };
  }

  const read = (readText) => readSentinel(project, { clock: fresh, dispatchIds: IDS, readText });
  const namesA = (sentinel) => isExecutorDispatch(A, sentinel, IDS, { clock: fresh });
  const namesOther = (sentinel) => isExecutorDispatch('Explore', sentinel, IDS, { clock: fresh });

  describe('a keyed record in the scan', () => {
    test('refused once then readable: normal classification, no overflow (Explore allowed, the named type classified)', () => {
      reset();
      fs.writeFileSync(path.join(dirPath(), '03.json'), body());
      const { readText, calls } = scripted({ '03.json': ['refuse', 'ok'] });
      const sentinel = read(readText);
      assert.notStrictEqual(sentinel.scanOverflow, true, 'no overflow');
      assert.strictEqual(namesOther(sentinel), false, 'Explore is not an executor dispatch');
      assert.strictEqual(namesA(sentinel), true, 'the record read on the second attempt names the type');
      assert.strictEqual(calls['03.json'], 2);
    });

    test('refused, then the file is gone (ENOENT): absent, not overflow', () => {
      reset();
      fs.writeFileSync(path.join(dirPath(), '03.json'), body());
      const { readText, calls } = scripted({ '03.json': ['refuse', 'vanish'] });
      const sentinel = read(readText);
      assert.notStrictEqual(sentinel.scanOverflow, true, 'a vanished entry is absent');
      assert.strictEqual(namesA(sentinel), false, 'nothing names the type');
      assert.strictEqual(calls['03.json'], 2);
    });

    test('refused twice while the file is still there: overflow, after at most two attempts', () => {
      reset();
      fs.writeFileSync(path.join(dirPath(), '03.json'), body());
      const { readText, calls } = scripted({ '03.json': ['refuse', 'refuse', 'refuse'] });
      const sentinel = read(readText);
      assert.strictEqual(sentinel.scanOverflow, true, 'a recent entry that stays unreadable cannot be ruled out');
      assert.strictEqual(calls['03.json'], 2, 'bounded at two attempts');
    });
  });

  describe('the legacy slot', () => {
    const writeLegacy = () => {
      fs.mkdirSync(path.dirname(legacyPath()), { recursive: true });
      fs.writeFileSync(legacyPath(), body({ phase: '02', executor_types: [] }));
    };

    test('refused once then readable: the slot is read normally, no overflow', () => {
      reset();
      writeLegacy();
      const { readText, calls } = scripted({ 'dispatch-isolation-sentinel.json': ['refuse', 'ok'] });
      const sentinel = read(readText);
      assert.strictEqual(sentinel.present, true);
      assert.strictEqual(sentinel.phase, '02');
      assert.notStrictEqual(sentinel.scanOverflow, true);
      assert.strictEqual(namesOther(sentinel), false);
      assert.strictEqual(calls['dispatch-isolation-sentinel.json'], 2);
    });

    test('refused, then the file is gone (ENOENT): absent, not overflow', () => {
      reset();
      writeLegacy();
      const { readText } = scripted({ 'dispatch-isolation-sentinel.json': ['refuse', 'vanish'] });
      const sentinel = read(readText);
      assert.strictEqual(sentinel.present, false);
      assert.notStrictEqual(sentinel.scanOverflow, true);
    });

    test('refused twice while the file is still there: overflow', () => {
      reset();
      writeLegacy();
      const { readText, calls } = scripted({ 'dispatch-isolation-sentinel.json': ['refuse', 'refuse', 'refuse'] });
      const sentinel = read(readText);
      assert.strictEqual(sentinel.scanOverflow, true);
      assert.strictEqual(calls['dispatch-isolation-sentinel.json'], 2, 'bounded at two attempts');
    });
  });

  describe('a record whose contents key to a different filename', () => {
    test('is judged by file identity: a case-insensitive volume reads phase1.json holding Phase1 normally, a case-sensitive one overflows', () => {
      reset();
      fs.writeFileSync(path.join(dirPath(), 'phase1.json'), body({ phase: 'Phase1' }));
      // The volume decides: does the expected name resolve to the file just written under another case?
      const caseInsensitive = fs.existsSync(path.join(dirPath(), 'Phase1.json'));
      const sentinel = readSentinel(project, { clock: fresh, dispatchIds: IDS });
      if (caseInsensitive) {
        assert.notStrictEqual(sentinel.scanOverflow, true, 'same file object: a normal record');
        assert.strictEqual(namesA(sentinel), true, 'its executor_types are read');
      } else {
        assert.strictEqual(sentinel.scanOverflow, true, 'a different name is a different file: key mismatch');
      }
    });

    test('a different file object under a mismatching name is overflow on every volume', () => {
      reset();
      fs.writeFileSync(path.join(dirPath(), 'other.json'), body({ phase: 'Phase1' }));
      const sentinel = readSentinel(project, { clock: fresh, dispatchIds: IDS });
      assert.strictEqual(sentinel.scanOverflow, true);
    });
  });

  describe('a gsd-executor dispatch does not run the classification scan', () => {
    test('no directory is opened for gsd-executor, one is for a specialist, and the enforced record is identical', () => {
      reset();
      fs.writeFileSync(path.join(dirPath(), '03.json'), body());
      writeSentinel(project, { phase: '02', plan: null, executor_type: 'gsd-executor' });
      const opendir = mock.method(fs, 'opendirSync');
      try {
        const exec = readSentinel(project, { clock: fresh, dispatchIds: IDS, subagentType: 'gsd-executor' });
        assert.strictEqual(opendir.mock.callCount(), 0, 'gsd-executor: no scan');
        const spec = readSentinel(project, { clock: fresh, dispatchIds: IDS, subagentType: A });
        assert.ok(opendir.mock.callCount() > 0, 'a specialist is scanned');
        assert.deepStrictEqual({ ...exec }, { ...spec }, 'the enforced record does not depend on the scan');
        assert.strictEqual(exec.scanOverflow, undefined);
      } finally {
        opendir.mock.restore();
      }
    });

    test('a GSD role never reaches the scan in either hook: no directory is opened, and a record directory that would fail closed still allows it', (t) => {
      reset();
      const real = path.join(project, 'elsewhere-6213');
      fs.mkdirSync(real, { recursive: true });
      cleanup(dirPath());
      try { fs.symlinkSync(real, dirPath(), 'dir'); } catch { t.skip('symlinks unavailable'); return; }
      const opendir = mock.method(fs, 'opendirSync');
      try {
        assert.strictEqual(claudeVerdict(project, 'acme-x', {}, 'Run the plan.'), 'block', 'control: a specialist fails closed on the symlinked directory');
        assert.strictEqual(cursorVerdict(project, 'acme-x', 'Run the plan.'), 'deny', 'control: cursor');
        opendir.mock.resetCalls();
        const readSpy = mock.method(fs, 'lstatSync');
        try {
          for (const role of ['gsd-verifier', 'gsd-planner']) {
            assert.strictEqual(claudeVerdict(project, role, {}, 'Run the plan.'), 'allow', `claude ${role}`);
            assert.strictEqual(cursorVerdict(project, role, 'Run the plan.'), 'allow', `cursor ${role}`);
          }
          assert.strictEqual(readSpy.mock.callCount(), 0, 'no record-directory lstat for a GSD role');
        } finally {
          readSpy.mock.restore();
        }
        assert.strictEqual(opendir.mock.callCount(), 0, 'no scan for a GSD role');
      } finally {
        opendir.mock.restore();
      }
    });

    test('gsd-executor with an unreadable record directory gets its recorded-decision verdict, guard and cursor', (t) => {
      const canChmod = process.platform !== 'win32' && !(typeof process.getuid === 'function' && process.getuid() === 0);
      if (!canChmod) { t.skip('cannot make a directory unreadable here'); return; }
      reset();
      writeSentinel(project, { phase: '02', plan: null });
      fs.chmodSync(dirPath(), 0o000);
      try {
        assert.strictEqual(claudeVerdict(project, 'gsd-executor'), 'block', 'claude: the recorded harness-worktree decision applies');
        assert.strictEqual(claudeVerdict(project, 'gsd-executor', { isolation: 'worktree' }), 'allow', 'claude, with the flag');
        assert.strictEqual(cursorVerdict(project, 'gsd-executor'), 'deny', 'cursor');
      } finally {
        fs.chmodSync(dirPath(), 0o755);
      }
    });
  });
});
