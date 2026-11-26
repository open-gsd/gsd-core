'use strict';

/**
 * #4696 — execute-phase splits a `type: tdd` plan into a RED dispatch and a GREEN/REFACTOR dispatch when the
 * two gates resolve to different models. Part 1 of the step file is a shell block: these tests run it, with the
 * real CLI behind `gsd_run`, against temp projects. Part 2 is instruction text for the orchestrator; its
 * structure is pinned by section. Model resolution is pinned in tdd-gate-model-overrides.test.cjs.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('./helpers.cjs');
const { isolatedEnv, createHermeticRoot } = require('./helpers/isolated-env.cjs');
const { runHook, OUTCOME } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const { skipUnless } = require('./helpers/bash-probe.cjs');

const ROOT = path.join(__dirname, '..');
// Forward slashes: the path is spliced into a bash script, where a Windows backslash would be an escape.
const GSD_TOOLS = path.join(ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs').replace(/\\/g, '/');
const EXECUTE_PHASE = 'gsd-core/workflows/execute-phase.md';
const STEP = 'gsd-core/workflows/execute-phase/steps/tdd-gate-split-dispatch.md';
const PLAN_GATE = 'gsd-core/workflows/execute-phase/steps/per-plan-worktree-gate.md';
const ROOT_PIN = 'gsd-core/workflows/execute-phase/steps/sequential-root-pin.md';
const GATE_REF = 'gsd-core/references/tdd-gate-dispatch.md';
const EXECUTOR = 'agents/gsd-executor.md';
const PLAN_REL = '.planning/phases/01-x/01-01-PLAN.md';

function read(rel) {
  // allow-test-rule: source-text-is-the-product (#4696) — shipped workflow and reference text is what the orchestrator loads
  return splitLines(fs.readFileSync(path.join(ROOT, rel), 'utf8')).join('\n');
}

/** Text between two level-2 headings of the step file. */
function section(text, start, end) {
  const from = text.indexOf(start);
  assert.notEqual(from, -1, `missing heading ${start}`);
  const to = end ? text.indexOf(end, from) : text.length;
  assert.notEqual(to, -1, `missing heading ${end}`);
  return text.slice(from, to);
}

/** The Part 1 shell block with the bootstrap line replaced by a `gsd_run` bound to this checkout's CLI. */
function part1Script(stub) {
  const lines = splitLines(section(read(STEP), '## Part 1', '## Part 2'));
  const open = lines.indexOf('```bash');
  assert.notEqual(open, -1, 'Part 1 has a bash block');
  const close = lines.indexOf('```', open + 1);
  assert.notEqual(close, -1, 'the bash block is closed');
  const body = lines.slice(open + 1, close).filter((line) => !line.startsWith('_GSD_SHIM_NAME='));
  const gsdRun = stub || `gsd_run() { node "${GSD_TOOLS}" "$@"; }`;
  return [gsdRun, ...body].join('\n').replace('{phase_dir}/{plan_file}', PLAN_REL);
}

/** The numbered `1. **Title.**` steps of a section, each as its own text. */
function numberedSteps(text) {
  const steps = [];
  for (const line of splitLines(text)) {
    if (/^\d\. \*\*/.test(line)) steps.push([line]);
    else if (steps.length > 0) steps[steps.length - 1].push(line);
  }
  return steps.map((lines) => lines.join('\n'));
}

function project(t, { planType = 'tdd', config = {} } = {}) {
  const root = createHermeticRoot('tdd-split-');
  t.after(() => cleanup(root));
  fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify(config));
  const dir = path.join(root, '.planning', 'phases', '01-x');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '01-01-PLAN.md'),
    ['---', 'phase: 01-x', 'plan: 01', `type: ${planType}`, '---', '', '<objective>x</objective>', ''].join('\n'),
  );
  return root;
}

/** Run Part 1 and parse its KEY=VALUE lines. */
function decide(t, root, vars = {}, stub) {
  const home = createTempDir('tdd-split-home-');
  t.after(() => cleanup(home));
  const scriptDir = createTempDir('tdd-split-script-');
  t.after(() => cleanup(scriptDir));
  const script = path.join(scriptDir, 'part1.sh');
  fs.writeFileSync(script, part1Script(stub));
  const env = {
    ...isolatedEnv({ home, path: process.env.PATH }),
    TDD_MODE: 'true',
    plan_id: '01-01',
    PHASE_NUMBER: '1',
    ISOLATION: 'harness-worktree',
    USE_WORKTREES_FOR_PLAN: 'true',
    plan_json: '{}',
    ...vars,
  };
  const r = runHook(script, [], { cwd: root, env, interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS * 4 });
  assert.equal(r.outcome, OUTCOME.EXITED);
  assert.equal(r.exitCode, 0, r.stderr);
  const out = Object.fromEntries(
    r.stdout.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  return { out, stderr: r.stderr };
}

const SPLIT_CONFIG = { model_overrides: { 'gsd-executor:tdd-red': 'opus', 'gsd-executor': 'sonnet' } };

describe('#4696 Part 1 decides the split', { skip: skipUnless('bash', 'node') }, () => {
  test('different gate models split the plan, take it out of its worktree, and name both models', (t) => {
    const { out } = decide(t, project(t, { config: SPLIT_CONFIG }));
    assert.equal(out.TDD_GATE_SPLIT, 'true');
    assert.equal(out.TDD_RED_MODEL, 'opus');
    assert.equal(out.TDD_GREEN_MODEL, 'sonnet');
    assert.equal(out.USE_WORKTREES_FOR_PLAN, 'false');
  });

  test('only the green key set splits too, with RED on the executor model', (t) => {
    const config = { model_overrides: { 'gsd-executor:tdd-green-refactor': 'haiku', 'gsd-executor': 'opus' } };
    const { out } = decide(t, project(t, { config }));
    assert.equal(out.TDD_GATE_SPLIT, 'true');
    assert.equal(out.TDD_RED_MODEL, 'opus');
    assert.equal(out.TDD_GREEN_MODEL, 'haiku');
  });

  test('inherit on one gate against a named executor model splits', (t) => {
    const config = { model_overrides: { 'gsd-executor:tdd-red': 'inherit', 'gsd-executor': 'sonnet' } };
    const { out } = decide(t, project(t, { config }));
    assert.equal(out.TDD_GATE_SPLIT, 'true');
    assert.equal(out.TDD_RED_MODEL, 'inherit');
  });

  test('no gate keys: one dispatch, worktree decision untouched, no models named', (t) => {
    const { out } = decide(t, project(t, { config: { model_overrides: { 'gsd-executor': 'sonnet' } } }));
    assert.equal(out.TDD_GATE_SPLIT, 'false');
    assert.equal(out.USE_WORKTREES_FOR_PLAN, 'true');
    assert.equal(out.TDD_RED_MODEL, 'sonnet');
    assert.equal(out.TDD_GREEN_MODEL, 'sonnet');
  });

  test('both keys naming the same model do not split', (t) => {
    const config = { model_overrides: { 'gsd-executor:tdd-red': 'opus', 'gsd-executor:tdd-green-refactor': 'opus' } };
    assert.equal(decide(t, project(t, { config })).out.TDD_GATE_SPLIT, 'false');
  });

  test('a blank or non-string gate entry sets nothing, so it does not split', (t) => {
    for (const bad of ['  ', '', true, 5, {}]) {
      const config = { model_overrides: { 'gsd-executor:tdd-red': bad, 'gsd-executor': 'sonnet' } };
      assert.equal(decide(t, project(t, { config })).out.TDD_GATE_SPLIT, 'false', JSON.stringify(bad));
    }
  });

  test('TDD mode off never splits', (t) => {
    const { out } = decide(t, project(t, { config: SPLIT_CONFIG }), { TDD_MODE: 'false' });
    assert.equal(out.TDD_GATE_SPLIT, 'false');
    assert.equal(out.USE_WORKTREES_FOR_PLAN, 'true');
  });

  test('a plan that is not type: tdd never splits', (t) => {
    const { out } = decide(t, project(t, { planType: 'execute', config: SPLIT_CONFIG }));
    assert.equal(out.TDD_GATE_SPLIT, 'false');
    assert.equal(out.USE_WORKTREES_FOR_PLAN, 'true');
  });

  test('the orchestrator-worktree backend keeps one dispatch and says so', (t) => {
    const { out, stderr } = decide(t, project(t, { config: SPLIT_CONFIG }), { ISOLATION: 'orchestrator-worktree' });
    assert.equal(out.TDD_GATE_SPLIT, 'false');
    assert.ok(stderr.includes('keeps a single dispatch'), stderr);
  });

  test('an executor_runtime plan keeps one dispatch and says so', (t) => {
    const planJson = JSON.stringify({ id: '01-01', executorRuntime: 'codex' });
    const { out, stderr } = decide(t, project(t, { config: SPLIT_CONFIG }), { plan_json: planJson });
    assert.equal(out.TDD_GATE_SPLIT, 'false');
    assert.ok(stderr.includes('keeps a single dispatch'), stderr);
  });

  test('a plan JSON that is not JSON is read as no executor_runtime', (t) => {
    const { out } = decide(t, project(t, { config: SPLIT_CONFIG }), { plan_json: 'not json' });
    assert.equal(out.TDD_GATE_SPLIT, 'true');
  });

  test('a failed gate-model resolve keeps one dispatch, names no models, and does not fail the step', (t) => {
    const stub = [
      'gsd_run() {',
      '  case "$*" in *tdd-red*) return 1;; esac',
      `  node "${GSD_TOOLS}" "$@"`,
      '}',
    ].join('\n');
    const { out, stderr } = decide(t, project(t, { config: SPLIT_CONFIG }), {}, stub);
    assert.equal(out.TDD_GATE_SPLIT, 'false');
    assert.equal(out.TDD_RED_MODEL, '');
    assert.equal(out.TDD_GREEN_MODEL, '');
    assert.equal(out.USE_WORKTREES_FOR_PLAN, 'true');
    assert.ok(stderr.includes('could not resolve its TDD gate models'), stderr);
  });
});

describe('#4696 Part 2 dispatches in order', () => {
  const part2 = () => section(read(STEP), '## Part 2');
  const steps = () => numberedSteps(part2());

  test('Part 2 is five ordered steps', () => {
    assert.equal(steps().length, 5);
  });

  test('step 1 skips RED only when a RED commit exists and no SUMMARY does', () => {
    const [resume] = steps();
    assert.ok(resume.startsWith('1. **Resume check.**'));
    assert.ok(resume.includes('no `SUMMARY.md`'));
  });

  test('step 2 runs RED on the RED model with no SUMMARY, STATE or ROADMAP work', () => {
    const red = steps()[1];
    assert.ok(red.includes('TDD_RED_MODEL') && red.includes('TDD_GATE=red'));
    assert.ok(red.includes('REQUIRED ORDER: Write SUMMARY.md'));
    assert.ok(red.includes('`<success_criteria>`'));
    assert.ok(red.includes('no `SUMMARY.md`, `STATE.md` or `ROADMAP.md` write'));
  });

  test('step 3 halts the plan on a missing RED commit, a RED halt, a SUMMARY, or an implementation commit', () => {
    const verify = steps()[2];
    for (const needle of ['prints nothing', 'INVALID_RED', '`SUMMARY.md` exists', 'implementation commit']) {
      assert.ok(verify.includes(needle), needle);
    }
    assert.ok(verify.includes('start no GREEN'));
  });

  test('step 4 runs GREEN/REFACTOR on the GREEN model and finishes the plan', () => {
    const green = steps()[3];
    assert.ok(green.includes('TDD_GREEN_MODEL') && green.includes('TDD_GATE=green-refactor'));
    assert.ok(green.includes('`STATE.md` and `ROADMAP.md` success criteria'));
  });

  test('both dispatches are foreground and follow step 3 Sequential mode', () => {
    const text = part2();
    assert.ok(text.includes('do not set `run_in_background`'));
    assert.ok(text.includes('sequential-root-pin.md'));
    assert.ok(text.includes('Sequential-mode'));
  });

  test('the per-plan gate runs Part 1 before a plan joins the worktree accumulator', () => {
    const gate = read(PLAN_GATE);
    const part1At = gate.indexOf('run Part 1 of `gsd-core/workflows/execute-phase/steps/tdd-gate-split-dispatch.md`');
    const accumulatorAt = gate.indexOf('After running this for the plan, the dispatch branches');
    assert.notEqual(part1At, -1, 'the gate points at Part 1');
    assert.ok(part1At < accumulatorAt, 'Part 1 runs before the accumulator rule');
  });

  test('Sequential mode points at Part 2', () => {
    assert.ok(read(ROOT_PIN).includes('Part 2 of\n`gsd-core/workflows/execute-phase/steps/tdd-gate-split-dispatch.md`'));
  });

  test('execute-phase.md itself is untouched by this change', () => {
    assert.ok(!read(EXECUTE_PHASE).includes('tdd-gate-split-dispatch'));
  });
});

describe('#4696 gate dispatch reference', () => {
  test('RED stops before SUMMARY and implementation; GREEN never reruns RED and halts without a RED commit', () => {
    const text = read(GATE_REF);
    const red = section(text, '## TDD_GATE=red', '## TDD_GATE=green-refactor');
    const green = section(text, '## TDD_GATE=green-refactor', '## Both dispatches');
    assert.ok(red.includes('Do not write `SUMMARY.md`'));
    assert.ok(red.includes('Write no implementation'));
    assert.ok(green.includes('Never rerun or repeat the RED gate'));
    assert.ok(green.includes('halt and report that the RED'));
  });

  test('the executor agent carries no restatement of the gate dispatch', () => {
    const agent = read(EXECUTOR);
    assert.ok(!agent.includes('TDD_GATE=red'));
    assert.ok(!agent.includes('TDD_GATE=green-refactor'));
  });
});
