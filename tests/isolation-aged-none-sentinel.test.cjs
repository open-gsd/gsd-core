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

const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { cleanup, readFileNormalized } = require('./helpers.cjs');
const { runHook, OUTCOME } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { scanFencedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');
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

describe('the per-plan worktree gate records the isolation sentinel per dispatch, not per decision (#5516)', () => {
  const REPO = path.join(__dirname, '..');
  const GATE_PATH = path.join(REPO, 'gsd-core', 'workflows', 'execute-phase', 'steps', 'per-plan-worktree-gate.md');
  const EXECUTE_PHASE = path.join(REPO, 'gsd-core', 'workflows', 'execute-phase.md');
  const gateLines = readFileNormalized(GATE_PATH).split('\n');

  /** The bash fences under the `## ... Part N ...` heading of the gate reference. */
  function partFences(marker) {
    const start = gateLines.findIndex((l) => /^##\s/.test(l) && marker.test(l));
    assert.notEqual(start, -1, `per-plan-worktree-gate.md needs a "## ... ${marker.source}" part: the decision pass and the dispatch-time record are separate steps (#5516)`);
    let end = gateLines.findIndex((l, i) => i > start && /^##\s/.test(l));
    if (end === -1) end = gateLines.length;
    return scanFencedBlocks(gateLines)
      .filter((b) => b.closeLineIdx !== -1 && (b.infoString || '').trim() === 'bash' && b.openLineIdx > start && b.closeLineIdx < end)
      .map((b) => gateLines.slice(b.openLineIdx + 1, b.closeLineIdx).join('\n'));
  }

  let root;
  let project;
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5516-'));
    project = createFixture({ prefix: 'gsd-5516-', planning: true, git: true, projectDoc: false });
    fs.writeFileSync(path.join(project, '.planning', 'config.json'), JSON.stringify({ runtime: 'claude', workflow: { use_worktrees: true } }));
  });
  after(() => { cleanup(root); cleanup(project); });

  const env = (extra) => ({
    ...process.env, HOME: root, USERPROFILE: root, GSD_HOME: root, RUNTIME_DIR: REPO.replace(/\\/g, '/'), CLAUDE_ENV_FILE: '', ...extra,
  });

  // The harness sources the gate's bash fences, and Part 1 extracts plan fields with jq. Skip (never pass
  // vacuously) where either is missing, and on Windows, where the fences' POSIX path handling is not what
  // this harness measures; the prose-contract tests below still run there.
  const probe = (cmd) => { const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS }); return !r.error && r.status === 0; };
  const harnessSkipReason = () => {
    if (process.platform === 'win32') return 'bash-fence harness runs on POSIX hosts';
    if (!probe('bash')) return 'bash is not available';
    if (!probe('jq')) return 'jq is not available';
    return null;
  };

  function runBash(name, script, extra) {
    const scriptPath = path.join(root, `${name}.sh`);
    fs.writeFileSync(scriptPath, script);
    const r = runHook(scriptPath, [], { interpreter: 'bash', cwd: project, env: env(extra), timeoutMs: PROBE_TIMEOUT_MS });
    assert.equal(r.outcome, OUTCOME.EXITED, `${name}: ${r.stderr}`);
    assert.equal(r.exitCode, 0, `${name} exited ${r.exitCode}: ${r.stderr}`);
    return r.stdout;
  }

  /** Part 1, for ONE plan: the decision. Prints `<plan_id>=<USE_WORKTREES_FOR_PLAN>`. */
  function decide(planJson, extra) {
    const script = [`plan_json='${planJson}'`, ...partFences(/Part 1/), 'printf "%s=%s\\n" "$plan_id" "$USE_WORKTREES_FOR_PLAN"'].join('\n');
    const line = runBash('decide', script, extra).split('\n').find((l) => /^[^=\s]+=(true|false)$/.test(l));
    assert.ok(line, 'the decision part must leave USE_WORKTREES_FOR_PLAN set for the plan');
    const [planId, value] = line.split('=');
    return { planId, value };
  }

  /** Part 2: the plan-scoped record, from the plan id and the stored decision. */
  function record({ planId, value }) {
    const fences = partFences(/Part 2/);
    assert.equal(fences.length, 1, 'the record part is exactly one fence');
    runBash('record', [`plan_id='${planId}'`, `USE_WORKTREES_FOR_PLAN='${value}'`, 'PHASE_NUMBER=03', fences[0]].join('\n'), {});
  }

  const recordedPlan = () => JSON.parse(fs.readFileSync(path.join(project, SENTINEL_RELATIVE_PATH), 'utf8')).plan;
  const dispatch = (planId, isolated) => guard.evaluateDispatch({
    tool_name: 'Agent',
    cwd: project,
    tool_input: {
      subagent_type: 'gsd-executor',
      ...(isolated ? { isolation: 'worktree' } : {}),
      prompt: `[gsd:dispatch phase="03" plan="${planId}"] go`,
    },
  }, {}).action;
  const planJson = (id, files) => JSON.stringify({ id, files_modified: files });

  test('#683 base-check degrade: a two-plan wave decided up front is dispatched sequentially, each against its own record', (t) => {
    const skip = harnessSkipReason();
    if (skip) { t.skip(skip); return; }
    const wave = ['03-01-api', '03-02-docs'].map((id) => decide(planJson(id, ['src/a.js']), { USE_WORKTREES: 'false', SUBMODULE_PATHS: '' }));
    assert.deepEqual(wave.map((d) => d.value), ['false', 'false']);
    for (const d of wave) {
      record(d);
      assert.equal(recordedPlan(), d.planId, 'the record at dispatch time names the plan being dispatched');
      assert.equal(dispatch(d.planId, false), 'allow', `${d.planId}: a flag-less dispatch of a plan decided sequential is allowed`);
    }
  });

  test('#2772 submodule degrade: each plan is dispatched on its own stored decision', (t) => {
    const skip = harnessSkipReason();
    if (skip) { t.skip(skip); return; }
    const extra = { USE_WORKTREES: 'true', SUBMODULE_PATHS: 'vendor/lib' };
    const wave = [decide(planJson('03-01-vendor', ['vendor/lib/x.c']), extra), decide(planJson('03-02-docs', ['lib/y.js']), extra)];
    assert.deepEqual(wave.map((d) => d.value), ['false', 'true'], 'the submodule plan is sequential, the other keeps worktree isolation');
    record(wave[0]);
    assert.equal(recordedPlan(), '03-01-vendor');
    assert.equal(dispatch('03-01-vendor', false), 'allow');
    record(wave[1]);
    assert.equal(recordedPlan(), '03-02-docs');
    assert.equal(dispatch('03-02-docs', true), 'allow', 'the isolated plan carries isolation="worktree"');
    assert.equal(dispatch('03-02-docs', false), 'block', 'and is still denied without it: the record did not weaken the guard');
  });

  test('why the record is per dispatch: recording every plan before the first dispatch leaves the earlier plan denied', (t) => {
    const skip = harnessSkipReason();
    if (skip) { t.skip(skip); return; }
    const wave = ['03-01-api', '03-02-docs'].map((id) => decide(planJson(id, ['src/a.js']), { USE_WORKTREES: 'false', SUBMODULE_PATHS: '' }));
    for (const d of wave) record(d);
    assert.equal(recordedPlan(), '03-02-docs', 'the single slot holds the last plan');
    assert.equal(dispatch('03-01-api', false), 'block', 'the first plan is judged against the last plan\'s record');
  });

  test('re-running the extraction restores a plan\'s own PLAN_FILES and PLAN_DELETIONS after later plans overwrote them', (t) => {
    const skip = harnessSkipReason();
    if (skip) { t.skip(skip); return; }
    const extraction = partFences(/Part 1/)[0];
    const json = (id, files, deletions) => JSON.stringify({ id, files_modified: files, files_deleted: deletions });
    const a = json('03-01-api', ['src/a.js'], ['src/old.js']);
    const b = json('03-02-docs', ['lib/y.js'], []);
    const script = [`plan_json='${a}'`, extraction, `plan_json='${b}'`, extraction, `plan_json='${a}'`, extraction, 'printf "%s|%s|%s\\n" "$plan_id" "$PLAN_FILES" "$PLAN_DELETIONS"'].join('\n');
    assert.equal(runBash('reextract', script, {}).trim().split('\n').pop(), '03-01-api|src/a.js|src/old.js');
  });

  describe('execute-phase.md places the record at the dispatch point', () => {
    const lines = readFileNormalized(EXECUTE_PHASE).split('\n');
    const stepStart = /^\d+(\.\d+)?\.\s+\*\*/;
    function step(marker) {
      const from = lines.findIndex((l) => stepStart.test(l) && marker.test(l));
      assert.notEqual(from, -1, `execute-phase.md has no step matching ${marker}`);
      let to = lines.findIndex((l, i) => i > from && stepStart.test(l));
      if (to === -1) to = lines.length;
      return lines.slice(from, to).join('\n');
    }

    test('step 2.5 runs the decision part for the whole wave and does not write the record', () => {
      const body = step(/^2\.5\./);
      assert.match(body, /Part 1/, 'step 2.5 runs Part 1 (the decision) of the gate');
      assert.doesNotMatch(body, /Part 2\b[^\n]*\bfor each plan\b/i, 'step 2.5 does not run Part 2 for each plan');
      assert.match(body, /isolation record is \*\*not written here\*\*/i, 'step 2.5 says the isolation record is not written in the decision pass');
    });

    test('step 3 re-records the sentinel for the plan being dispatched, from that plan\'s stored decision', () => {
      const body = step(/Spawn executor agents/);
      assert.match(body, /Part 2/, 'step 3 runs Part 2 (the plan-scoped record) of the gate');
      assert.match(body, /stored decision|that plan's own decision/i, 'step 3 reads the dispatched plan\'s stored decision');
      assert.match(body, /PLAN_FILES[^\n]*PLAN_DELETIONS/, 'step 3 re-extracts PLAN_FILES / PLAN_DELETIONS for the dispatched plan');
    });
  });
});
