'use strict';

/**
 * #5479 — a recorded sequential degrade (`none`) was forgotten once the sentinel was older than
 * SENTINEL_STALE_MS: the next flag-less executor dispatch of the same phase was denied because the
 * guard fell back to the registry capability ("this host CAN isolate"), which cannot see the
 * shell-side base-check degrade. #4317 reported the same mechanism.
 *
 * The recorded `none` for phase P keeps governing phase P's dispatches past the trust window. It
 * must never authorize another phase, a dispatch whose phase cannot be established, an aged
 * `harness-worktree` record, or a future-dated record. The Claude guard and the Cursor hook share
 * one predicate and must agree on every case.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const { createFixture } = require('./fixtures/index.cjs');
const {
  SENTINEL_RELATIVE_PATH,
  SENTINEL_STALE_MS,
  AGED_NONE_MAX_MS,
  agedNoneGovernsDispatch,
} = require('../hooks/lib/isolation-sentinel.js');
const guard = require('../hooks/gsd-agent-isolation-guard.js');
const cursor = require('../hooks/gsd-cursor-subagent-start.js');

const WRITTEN_AT = 1_000_000;
const clockAt = (ageMs) => ({ now: () => WRITTEN_AT + ageMs });
const dispatchFor = (phase) => ({ phase, plan: phase ? `${phase}-03` : null });

function writeSentinel(dir, { isolation, phase = '02', plan = null, harnessFlag = null, writtenAt = WRITTEN_AT }) {
  const p = path.join(dir, SENTINEL_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ isolation, harness_flag: harnessFlag, phase, plan, written_at: writtenAt }));
}

describe('agedNoneGovernsDispatch (#5479)', () => {
  const sentinel = (over = {}) => ({
    present: true, stale: true, malformed: false, isolation: 'none', harnessFlag: null,
    phase: '02', plan: null, writtenAt: WRITTEN_AT, ...over,
  });

  test('an aged none governs a dispatch for the same phase', () => {
    for (const age of [SENTINEL_STALE_MS, SENTINEL_STALE_MS + 1, 22 * 60 * 1000, 6 * 60 * 60 * 1000]) {
      assert.strictEqual(agedNoneGovernsDispatch(sentinel(), dispatchFor('02'), { clock: clockAt(age) }), true, `age ${age}`);
    }
  });

  test('it does not apply to a different phase, an unknown phase, or a sentinel with no phase', () => {
    assert.strictEqual(agedNoneGovernsDispatch(sentinel(), dispatchFor('03'), { clock: clockAt(SENTINEL_STALE_MS) }), false);
    assert.strictEqual(agedNoneGovernsDispatch(sentinel(), dispatchFor(null), { clock: clockAt(SENTINEL_STALE_MS) }), false);
    assert.strictEqual(agedNoneGovernsDispatch(sentinel(), null, { clock: clockAt(SENTINEL_STALE_MS) }), false);
    assert.strictEqual(agedNoneGovernsDispatch(sentinel({ phase: null }), dispatchFor('02'), { clock: clockAt(SENTINEL_STALE_MS) }), false);
  });

  test('a plan-scoped none speaks only for its own plan or a plan-less dispatch', () => {
    const planned = sentinel({ plan: '02-01' });
    const at = { clock: clockAt(SENTINEL_STALE_MS + 1) };
    assert.strictEqual(agedNoneGovernsDispatch(planned, { phase: '02', plan: '02-01' }, at), true);
    assert.strictEqual(agedNoneGovernsDispatch(planned, { phase: '02', plan: null }, at), true);
    assert.strictEqual(agedNoneGovernsDispatch(planned, { phase: '02', plan: '02-02' }, at), false, 'a different plan of the same phase');
    assert.strictEqual(agedNoneGovernsDispatch(sentinel(), { phase: '02', plan: '02-02' }, at), true, 'a phase-level record covers every plan');
  });

  test('a record older than the upper bound governs nothing, one just inside it still does', () => {
    assert.strictEqual(agedNoneGovernsDispatch(sentinel(), dispatchFor('02'), { clock: clockAt(AGED_NONE_MAX_MS) }), true);
    assert.strictEqual(agedNoneGovernsDispatch(sentinel(), dispatchFor('02'), { clock: clockAt(AGED_NONE_MAX_MS + 1) }), false);
    assert.strictEqual(agedNoneGovernsDispatch(sentinel({ writtenAt: 0 }), dispatchFor('02'), { clock: { now: () => Date.now() } }), false, 'an epoch-0 record');
  });

  test('it only ever speaks for a recorded none', () => {
    assert.strictEqual(agedNoneGovernsDispatch(sentinel({ isolation: 'harness-worktree', harnessFlag: 'isolation="worktree"' }), dispatchFor('02'), { clock: clockAt(SENTINEL_STALE_MS) }), false);
    assert.strictEqual(agedNoneGovernsDispatch(sentinel({ isolation: 'orchestrator-worktree' }), dispatchFor('02'), { clock: clockAt(SENTINEL_STALE_MS) }), false);
  });

  test('a future-dated, malformed or absent record is never trusted', () => {
    assert.strictEqual(agedNoneGovernsDispatch(sentinel(), dispatchFor('02'), { clock: clockAt(-6000) }), false);
    assert.strictEqual(agedNoneGovernsDispatch(sentinel({ malformed: true }), dispatchFor('02'), { clock: clockAt(SENTINEL_STALE_MS) }), false);
    assert.strictEqual(agedNoneGovernsDispatch({ present: false }, dispatchFor('02'), { clock: clockAt(SENTINEL_STALE_MS) }), false);
    assert.strictEqual(agedNoneGovernsDispatch(null, dispatchFor('02'), { clock: clockAt(SENTINEL_STALE_MS) }), false);
  });
});

describe('an aged none keeps governing its phase in the Claude guard and the Cursor hook (#5479)', () => {
  let project; // runtime claude: the registry fallback resolves harness-worktree
  before(() => {
    project = createFixture({ prefix: 'gsd-5479-', planning: true, git: true, projectDoc: false });
    fs.writeFileSync(path.join(project, '.planning', 'config.json'), JSON.stringify({ runtime: 'claude' }));
  });
  after(() => { cleanup(project); });

  const guardIsolation = (ageMs, phase) => guard.resolveIsolationState(project, { clock: clockAt(ageMs), dispatchIds: dispatchFor(phase) }).isolation;
  const cursorAllows = (ageMs, phase) => cursor.evaluateRootIsolation(project, 'gsd-executor', { clock: clockAt(ageMs), dispatchIds: dispatchFor(phase) });

  test('the same-phase dispatch is governed by the recorded none at TTL-1ms, TTL, TTL+1ms and 22 minutes', () => {
    writeSentinel(project, { isolation: 'none', phase: '02' });
    for (const age of [SENTINEL_STALE_MS - 1, SENTINEL_STALE_MS, SENTINEL_STALE_MS + 1, 22 * 60 * 1000]) {
      assert.strictEqual(guardIsolation(age, '02'), 'none', `claude guard at age ${age}`);
    }
  });

  test('a plan-scoped none governs its own plan but not a later plan of the same phase', () => {
    writeSentinel(project, { isolation: 'none', phase: '02', plan: '02-01' });
    const state = (plan) => guard.resolveIsolationState(project, { clock: clockAt(SENTINEL_STALE_MS + 1), dispatchIds: { phase: '02', plan } }).isolation;
    assert.strictEqual(state('02-01'), 'none');
    assert.strictEqual(state('02-02'), 'harness-worktree', 'plan B of the phase must not inherit plan A\'s degrade');
  });

  test('another phase, an unknown phase, an aged harness-worktree record and a future-dated none fall back to the registry', () => {
    writeSentinel(project, { isolation: 'none', phase: '02' });
    assert.strictEqual(guardIsolation(SENTINEL_STALE_MS + 1, '03'), 'harness-worktree', 'different phase');
    assert.strictEqual(guardIsolation(SENTINEL_STALE_MS + 1, null), 'harness-worktree', 'phase cannot be established');
    assert.strictEqual(guardIsolation(-6000, '02'), 'harness-worktree', 'future-dated');
    writeSentinel(project, { isolation: 'harness-worktree', phase: '02', harnessFlag: 'isolation="worktree"' });
    assert.strictEqual(guardIsolation(SENTINEL_STALE_MS + 1, '02'), 'harness-worktree', 'no degrade recorded');
  });

  test('a genuine harness-worktree dispatch missing the flag is still blocked, and the aged none is what lets the sequential one through', () => {
    const payload = (phase) => ({
      tool_name: 'Agent',
      cwd: project,
      tool_input: { subagent_type: 'gsd-executor', prompt: `[gsd:dispatch phase="${phase}" plan="${phase}-03"] go` },
    });
    writeSentinel(project, { isolation: 'none', phase: '02' });
    const aged = clockAt(22 * 60 * 1000);
    assert.strictEqual(guard.evaluateDispatch(payload('02'), { clock: aged }).action, 'allow');
    assert.strictEqual(guard.evaluateDispatch(payload('03'), { clock: aged }).action, 'block');
  });

  test('the Cursor hook gives the same verdicts as the Claude guard for every case above', () => {
    // The Cursor hook decides on the workspace root's effective state when isolation is required, so
    // the comparable verdict is "does the recorded none govern": allow on none, deny otherwise.
    const verdict = (ageMs, phase) => cursorAllows(ageMs, phase).action;
    writeSentinel(project, { isolation: 'none', phase: '02' });
    for (const age of [SENTINEL_STALE_MS - 1, SENTINEL_STALE_MS, SENTINEL_STALE_MS + 1, 22 * 60 * 1000]) {
      assert.strictEqual(verdict(age, '02'), 'allow', `cursor at age ${age}`);
    }
    assert.notStrictEqual(verdict(SENTINEL_STALE_MS + 1, '03'), 'allow', 'different phase');
    assert.notStrictEqual(verdict(SENTINEL_STALE_MS + 1, null), 'allow', 'phase cannot be established');
    assert.notStrictEqual(verdict(-6000, '02'), 'allow', 'future-dated');
    writeSentinel(project, { isolation: 'harness-worktree', phase: '02', harnessFlag: 'isolation="worktree"' });
    assert.notStrictEqual(verdict(SENTINEL_STALE_MS + 1, '02'), 'allow', 'no degrade recorded');
  });
});

describe('the per-plan worktree gate never re-persists harness-worktree over a recorded degrade (#5479)', () => {
  const GATE = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase', 'steps', 'per-plan-worktree-gate.md');
  const text = fs.readFileSync(GATE, 'utf-8');
  // The last fenced bash block after the "Re-record the dispatch-isolation sentinel" heading.
  const afterHeading = text.slice(text.indexOf('Re-record the dispatch-isolation sentinel'));
  const block = afterHeading.slice(afterHeading.indexOf('```bash'));
  const recordBlock = block.slice(0, block.indexOf('```', 8));

  test('only an explicit USE_WORKTREES_FOR_PLAN=true re-resolves; a value lost with the shell leaves the recorded decision alone', () => {
    assert.match(recordBlock, /if \[ "\$\{USE_WORKTREES_FOR_PLAN:-\}" = "false" \]/, 'false still forces none for this plan');
    assert.match(recordBlock, /elif \[ -n "\$\{USE_WORKTREES_FOR_PLAN:-\}" \]/, 're-resolve whenever the plan state is known (any non-empty value); an empty one writes nothing');
    const lines = splitLines(recordBlock).map((l) => l.trim());
    lines.forEach((line, i) => {
      if (line !== 'else') return;
      const next = lines.slice(i + 1).find((l) => l !== '' && !l.startsWith('#'));
      assert.ok(!(next ?? '').includes('dispatch-isolation'), 'no unconditional else branch may write dispatch-isolation');
    });
  });
});
