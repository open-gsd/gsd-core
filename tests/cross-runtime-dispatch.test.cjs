'use strict';

/**
 * #6303 (Phase 4 of #3711, ADR-3711): `dispatch-isolation` routes a plan that declares
 * `executor_runtime` to the target runtime's `orchestratorExec` when the gate is on, and degrades to
 * the host's own dispatch, with one reason in `fallback`, in every unhappy case (D3).
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { isolatedEnv } = require('./helpers/isolated-env.cjs');

const HOST_MODEL = 'HOSTMODEL-6303-XYZ';
const TARGET_MODEL = 'target-model-6303';
const PHASE = '03';
const PLAN = '03-05';

let project;
let worktreeTarget;
let binWithRuntimes;
let binEmpty;

function writeConfig(config) {
  fs.writeFileSync(path.join(project, '.planning', 'config.json'), JSON.stringify(config));
}

function writePlan(fields) {
  const phaseDir = path.join(project, '.planning', 'phases', '03-x');
  fs.mkdirSync(phaseDir, { recursive: true });
  const base = { phase: '03-x', plan: '"05"', type: 'execute', wave: 1, depends_on: '[]', files_modified: '[]', autonomous: true, ...fields };
  const fm = Object.entries(base).map(([k, v]) => `${k}: ${v}`).join('\n');
  fs.writeFileSync(path.join(phaseDir, '03-05-PLAN.md'), `---\n${fm}\n---\n# plan\n`);
}

function recordPath() {
  return path.join(project, '.gsd', 'dispatch-isolation', `${PHASE}--${PLAN}.json`);
}

/** Run `query dispatch-isolation --json` for the fixture plan; `present` says whether the foreign binaries are on PATH. */
function dispatch(host, { present = true, argv = null } = {}) {
  const env = isolatedEnv({
    home: project, base: {}, path: present ? `${binWithRuntimes}${path.delimiter}${process.env.PATH}` : binEmpty,
    override: { GSD_HOME: project, GSD_RUNTIME: host, GSD_OPENCODE_GENERATION: '1' },
  });
  cleanup(recordPath());
  // #4904: a plain query holds a caller's fresh `none`, so a `--force-isolation none` an earlier row
  // recorded (in the legacy slot too) would hold this row's query; each row starts with no record.
  cleanup(path.join(project, '.gsd', 'dispatch-isolation-sentinel.json'));
  const result = runGsdTools(
    argv || ['query', 'dispatch-isolation', '--phase', PHASE, '--plan', PLAN, '--cwd-target', worktreeTarget, '--prompt', 'go', '--json'],
    project,
    env,
  );
  assert.equal(result.success, true, result.error);
  let record = null;
  try { record = JSON.parse(fs.readFileSync(recordPath(), 'utf8')); } catch { /* asserted by the callers that need it */ }
  return { output: JSON.parse(result.output), record };
}

before(() => {
  project = createTempProject('gsd-6303-');
  worktreeTarget = path.join(project, 'wt');
  fs.mkdirSync(worktreeTarget);
  binWithRuntimes = path.join(project, 'bin-with');
  binEmpty = path.join(project, 'bin-empty');
  fs.mkdirSync(binWithRuntimes);
  fs.mkdirSync(binEmpty);
  for (const name of ['codex', 'opencode']) {
    // Windows resolves a command through PATHEXT, so the stand-in is a .cmd there and a shell script elsewhere.
    if (process.platform === 'win32') fs.writeFileSync(path.join(binWithRuntimes, `${name}.cmd`), '@echo off\r\nexit /b 0\r\n');
    else fs.writeFileSync(path.join(binWithRuntimes, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  // The child is started by absolute path, so the empty bin directory only has to hold no runtime binary;
  // a symlink needs a privilege Windows runners may lack.
  try { fs.symlinkSync(process.execPath, path.join(binEmpty, 'node')); } catch { /* not required */ }
});
after(() => { cleanup(project); });

describe('#4904 a query that holds a caller `none` still answers a foreign dispatch and records nothing', () => {
  const gateOn = { runtime: 'claude', workflow: { cross_runtime_execution: true } };
  const legacyPath = () => path.join(project, '.gsd', 'dispatch-isolation-sentinel.json');
  const env = () => isolatedEnv({
    home: project, base: {}, path: `${binWithRuntimes}${path.delimiter}${process.env.PATH}`,
    override: { GSD_HOME: project, GSD_RUNTIME: 'claude', GSD_OPENCODE_GENERATION: '1' },
  });
  const run = (extra) => {
    const result = runGsdTools(['query', 'dispatch-isolation', '--phase', PHASE, '--plan', PLAN, ...extra], project, env());
    assert.equal(result.success, true, result.error);
    return result.output;
  };
  // The caller's forced `none` for the plan, then the bytes of both decision records it wrote.
  const forceNone = () => {
    cleanup(recordPath());
    cleanup(legacyPath());
    run(['--force-isolation', 'none', '--json']);
    return { keyed: fs.readFileSync(recordPath(), 'utf8'), legacy: fs.readFileSync(legacyPath(), 'utf8') };
  };
  const held = ['--cwd-target', 'WT', '--prompt', 'go'];
  const heldArgs = (extra) => held.map((a) => (a === 'WT' ? worktreeTarget : a)).concat(extra);

  test('a plan that goes to another runtime: --json carries the target exec with held, and no record moves', () => {
    writeConfig(gateOn);
    writePlan({ executor_runtime: 'codex' });
    const before = forceNone();
    const output = JSON.parse(run(heldArgs(['--json'])));
    assert.equal(output.held, true, 'the query held the caller none');
    assert.equal(typeof output.decidedAt, 'number');
    assert.equal(output.executorRuntime, 'codex');
    assert.equal(output.fallback, null);
    assert.equal(output.isolation, 'orchestrator-worktree');
    assert.equal(output.harnessFlag, null);
    assert.equal(output.exec.command, 'codex');
    assert.equal(fs.readFileSync(recordPath(), 'utf8'), before.keyed, 'the keyed decision record is unchanged');
    assert.equal(fs.readFileSync(legacyPath(), 'utf8'), before.legacy, 'the legacy slot is unchanged');
  });

  test('a plan that goes to another runtime: --raw prints the foreign isolation', () => {
    writeConfig(gateOn);
    writePlan({ executor_runtime: 'codex' });
    forceNone();
    assert.equal(run(heldArgs(['--raw'])), 'orchestrator-worktree');
  });

  test('a plan that stays on the host: the held query answers none (control)', () => {
    writeConfig(gateOn);
    writePlan({});
    forceNone();
    const output = JSON.parse(run(heldArgs(['--json'])));
    assert.equal(output.held, true);
    assert.equal(output.executorRuntime, null);
    assert.equal(output.isolation, 'none');
    assert.equal(output.exec, null);
  });

  test('a plan that falls back: the held query names the reason and answers none', () => {
    writeConfig({ runtime: 'claude' });
    writePlan({ executor_runtime: 'codex' });
    forceNone();
    const output = JSON.parse(run(heldArgs(['--json'])));
    assert.equal(output.held, true);
    assert.equal(output.executorRuntime, 'codex');
    assert.equal(output.fallback, 'gate_off');
    assert.equal(output.isolation, 'none');
    assert.equal(output.exec, null);
  });
});

describe('#6303 a declared executor_runtime dispatches to the target runtime when the gate is on', () => {
  test('claude host, codex target: the exec is the target descriptor bound to the worktree', () => {
    writeConfig({ runtime: 'claude', workflow: { cross_runtime_execution: true } });
    writePlan({ executor_runtime: 'codex' });
    const { output } = dispatch('claude');
    assert.equal(output.runtime, 'claude', 'runtime stays the host');
    assert.equal(output.executorRuntime, 'codex');
    assert.equal(output.fallback, null);
    assert.equal(output.isolation, 'orchestrator-worktree');
    assert.equal(output.harnessFlag, null);
    assert.equal(output.exec.command, 'codex');
    assert.ok(output.exec.args.includes(worktreeTarget), 'the worktree is bound');
    assert.ok(output.exec.args.includes('go'), 'the prompt is carried');
  });

  test('the decision is recorded once, naming its producer and the target', () => {
    writeConfig({ runtime: 'claude', workflow: { cross_runtime_execution: true } });
    writePlan({ executor_runtime: 'codex' });
    const { record } = dispatch('claude');
    assert.equal(record.isolation, 'orchestrator-worktree');
    assert.equal(record.producer, 'dispatch-isolation');
    assert.equal(record.executor_runtime, 'codex');
    assert.equal(record.plan, PLAN);
  });

  test('a host that is not a harness host routes the same way: the branch is the resolved isolation (codex host, opencode target)', () => {
    writeConfig({ runtime: 'codex', workflow: { cross_runtime_execution: true } });
    writePlan({ executor_runtime: 'opencode' });
    const { output } = dispatch('codex');
    assert.equal(output.runtime, 'codex');
    assert.equal(output.executorRuntime, 'opencode');
    assert.equal(output.isolation, 'orchestrator-worktree');
    assert.equal(output.exec.command, 'opencode');
  });

  test('a plan without executor_runtime reports null and no fallback', () => {
    writeConfig({ runtime: 'claude', workflow: { cross_runtime_execution: true } });
    writePlan({});
    const { output, record } = dispatch('claude');
    assert.equal(output.executorRuntime, null);
    assert.equal(output.fallback, null);
    assert.equal(output.isolation, 'harness-worktree');
    assert.equal(output.exec, null);
    assert.equal('producer' in record, false, 'only a foreign dispatch names a producer');
    assert.equal('executor_runtime' in record, false);
  });
});

describe('#6303 model comes from the target runtime, never the host', () => {
  test('execute.models.<target> reaches the argv and the host pin does not', () => {
    writeConfig({
      runtime: 'claude',
      workflow: { cross_runtime_execution: true },
      execute: { models: { codex: TARGET_MODEL } },
      model_overrides: { 'gsd-executor': HOST_MODEL },
    });
    writePlan({ executor_runtime: 'codex' });
    const { output } = dispatch('claude');
    assert.equal(output.fallback, null);
    assert.ok(output.exec.args.includes(TARGET_MODEL), 'the target model is passed');
    assert.equal(output.exec.args.some((a) => a.includes(HOST_MODEL)), false, 'the host model never reaches argv');
  });

  test('without execute.models.<target> no model is passed and the host pin still stays out', () => {
    writeConfig({
      runtime: 'claude',
      workflow: { cross_runtime_execution: true },
      model_overrides: { 'gsd-executor': HOST_MODEL },
    });
    writePlan({ executor_runtime: 'codex' });
    const { output } = dispatch('claude');
    assert.equal(output.fallback, null);
    assert.equal(output.exec.args.some((a) => a.includes(HOST_MODEL)), false);
    assert.equal(output.exec.args.includes(TARGET_MODEL), false);
  });

  test('a flag-shaped execute.models value is dropped, not passed', () => {
    writeConfig({ runtime: 'claude', workflow: { cross_runtime_execution: true }, execute: { models: { codex: '--evil' } } });
    writePlan({ executor_runtime: 'codex' });
    const { output } = dispatch('claude');
    assert.equal(output.fallback, null);
    assert.equal(output.exec.args.includes('--evil'), false);
  });
});

describe('#6303 every unhappy case degrades to the host dispatch with one reason', () => {
  function assertDegraded(output, reason) {
    assert.equal(output.fallback, reason);
    assert.equal(output.executorRuntime !== null, true, 'the declared target is still reported');
  }

  test('gate_off: the gate is unset', () => {
    writeConfig({ runtime: 'claude' });
    writePlan({ executor_runtime: 'codex' });
    const { output } = dispatch('claude');
    assertDegraded(output, 'gate_off');
    assert.equal(output.exec, null);
    assert.equal(output.isolation, 'harness-worktree');
  });

  test('gate_off: the gate is false', () => {
    writeConfig({ runtime: 'claude', workflow: { cross_runtime_execution: false } });
    writePlan({ executor_runtime: 'codex' });
    assertDegraded(dispatch('claude').output, 'gate_off');
  });

  test('gate_off: the string "true" is not the boolean gate', () => {
    writeConfig({ runtime: 'claude', workflow: { cross_runtime_execution: 'true' } });
    writePlan({ executor_runtime: 'codex' });
    assertDegraded(dispatch('claude').output, 'gate_off');
  });

  test('worktrees_off: workflow.use_worktrees is false', () => {
    writeConfig({ runtime: 'claude', workflow: { cross_runtime_execution: true, use_worktrees: false } });
    writePlan({ executor_runtime: 'codex' });
    const { output } = dispatch('claude');
    assertDegraded(output, 'worktrees_off');
    assert.equal(output.isolation, 'none');
    assert.equal(output.exec, null);
  });

  test('unknown_runtime: the id is not in the registry', () => {
    writeConfig({ runtime: 'claude', workflow: { cross_runtime_execution: true } });
    writePlan({ executor_runtime: 'nonesuch' });
    const { output } = dispatch('claude');
    assertDegraded(output, 'unknown_runtime');
    assert.equal(output.exec, null);
    assert.equal(output.isolation, 'harness-worktree');
  });

  for (const inherited of ['constructor', 'toString']) {
    test(`unknown_runtime: ${inherited} is not looked up as an inherited property`, () => {
      writeConfig({ runtime: 'claude', workflow: { cross_runtime_execution: true } });
      writePlan({ executor_runtime: inherited });
      const { output } = dispatch('claude');
      assertDegraded(output, 'unknown_runtime');
      assert.equal(output.exec, null);
    });
  }

  test('unknown_runtime: __proto__ is not a runtime id, so it is neither looked up nor echoed', () => {
    writeConfig({ runtime: 'claude', workflow: { cross_runtime_execution: true } });
    writePlan({ executor_runtime: '__proto__' });
    const { output } = dispatch('claude');
    assert.equal(output.fallback, 'unknown_runtime');
    assert.equal(output.executorRuntime, null);
    assert.equal(output.exec, null);
  });

  test('same_runtime: the target is the host', () => {
    writeConfig({ runtime: 'codex', workflow: { cross_runtime_execution: true } });
    writePlan({ executor_runtime: 'codex' });
    const { output } = dispatch('codex');
    assert.equal(output.fallback, 'same_runtime');
    assert.equal(output.isolation, 'orchestrator-worktree', 'the host dispatch is unchanged');
    assert.equal(output.exec.command, 'codex');
    assert.equal(output.executorRuntime, 'codex');
  });

  test('descriptor_unresolved: the target does not declare orchestrator-worktree (claude as a target)', () => {
    writeConfig({ runtime: 'codex', workflow: { cross_runtime_execution: true } });
    writePlan({ executor_runtime: 'claude' });
    const { output } = dispatch('codex');
    assert.equal(output.fallback, 'descriptor_unresolved');
    assert.equal(output.isolation, 'orchestrator-worktree', 'the host dispatch is unchanged');
    assert.equal(output.exec.command, 'codex');
  });

  test('binary_absent: the target command is not on PATH', () => {
    writeConfig({ runtime: 'claude', workflow: { cross_runtime_execution: true } });
    writePlan({ executor_runtime: 'codex' });
    const { output } = dispatch('claude', { present: false });
    assertDegraded(output, 'binary_absent');
    assert.equal(output.exec, null);
    assert.equal(output.isolation, 'harness-worktree');
  });

  test('a degraded dispatch records the host decision with no producer or target', () => {
    writeConfig({ runtime: 'claude' });
    writePlan({ executor_runtime: 'codex' });
    const { record } = dispatch('claude');
    assert.equal(record.isolation, 'harness-worktree');
    assert.equal('producer' in record, false);
    assert.equal('executor_runtime' in record, false);
  });

  test('property: any id outside the registry degrades to unknown_runtime', () => {
    writeConfig({ runtime: 'claude', workflow: { cross_runtime_execution: true } });
    fc.assert(
      fc.property(fc.stringMatching(/^zz[a-z0-9_-]{2,12}$/), (id) => {
        writePlan({ executor_runtime: id });
        const { output } = dispatch('claude');
        return output.fallback === 'unknown_runtime' && output.exec === null && output.isolation === 'harness-worktree';
      }),
      { numRuns: 12, seed: 6303 },
    );
  });
});

describe('#6303 review hardening: forced isolation, no worktree yet, validation, model rules', () => {
  const gateOn = { runtime: 'claude', workflow: { cross_runtime_execution: true } };

  test('--force-isolation wins: the foreign dispatch never overrides a forced decision', () => {
    writeConfig(gateOn);
    writePlan({ executor_runtime: 'codex' });
    const { output, record } = dispatch('claude', { argv: ['query', 'dispatch-isolation', '--phase', PHASE, '--plan', PLAN, '--force-isolation', 'none', '--cwd-target', worktreeTarget, '--prompt', 'go', '--json'] });
    assert.equal(output.fallback, 'forced_isolation');
    assert.equal(output.isolation, 'none');
    assert.equal(output.exec, null);
    assert.equal('producer' in record, false);
  });

  test('before the worktree exists the plan decision is orchestrator-worktree with no exec', () => {
    writeConfig(gateOn);
    writePlan({ executor_runtime: 'codex' });
    const { output, record } = dispatch('claude', { argv: ['query', 'dispatch-isolation', '--phase', PHASE, '--plan', PLAN, '--json'] });
    assert.equal(output.executorRuntime, 'codex');
    assert.equal(output.fallback, null);
    assert.equal(output.isolation, 'orchestrator-worktree');
    assert.equal(output.exec, null);
    assert.equal(record.producer, 'dispatch-isolation');
  });

  test('without --plan nothing is declared', () => {
    writeConfig(gateOn);
    writePlan({ executor_runtime: 'codex' });
    const { output } = dispatch('claude', { argv: ['query', 'dispatch-isolation', '--phase', PHASE, '--cwd-target', worktreeTarget, '--prompt', 'go', '--json'] });
    assert.equal(output.executorRuntime, null);
    assert.equal(output.fallback, null);
    assert.equal(output.isolation, 'harness-worktree');
  });

  test('a padded id is trimmed to the registry key', () => {
    writeConfig(gateOn);
    writePlan({ executor_runtime: '"  codex  "' });
    const { output } = dispatch('claude');
    assert.equal(output.executorRuntime, 'codex');
    assert.equal(output.fallback, null);
  });

  for (const bad of ['"codex; echo pwned"', '"-codex"', '"co dex"']) {
    test(`a non-id value (${bad}) is unknown_runtime and its text is not echoed`, () => {
      writeConfig(gateOn);
      writePlan({ executor_runtime: bad });
      const { output } = dispatch('claude');
      assert.equal(output.fallback, 'unknown_runtime');
      assert.equal(output.executorRuntime, null);
      assert.equal(output.exec, null);
    });
  }

  test('argv order and cwd are pinned: exec, model, cd, prompt', () => {
    writeConfig({ ...gateOn, execute: { models: { codex: TARGET_MODEL } } });
    writePlan({ executor_runtime: 'codex' });
    const { output } = dispatch('claude');
    assert.deepEqual(output.exec.args, ['exec', '--model', TARGET_MODEL, '--cd', worktreeTarget, 'go']);
    assert.equal(output.exec.cwd, worktreeTarget);
  });

  test('an Anthropic-flavored model for a foreign target is kept (the Codex-host rule does not apply)', () => {
    writeConfig({ ...gateOn, execute: { models: { codex: 'anthropic/claude-sonnet-4' } } });
    writePlan({ executor_runtime: 'codex' });
    const { output } = dispatch('claude');
    assert.ok(output.exec.args.includes('anthropic/claude-sonnet-4'));
  });

  for (const [label, length, kept] of [['limit-1', 199, true], ['limit', 200, true], ['limit+1', 201, false]]) {
    test(`model id length ${label} (${length}) is ${kept ? 'passed' : 'dropped'}`, () => {
      const model = 'm'.repeat(length);
      writeConfig({ ...gateOn, execute: { models: { codex: model } } });
      writePlan({ executor_runtime: 'codex' });
      const { output } = dispatch('claude');
      assert.equal(output.fallback, null);
      assert.equal(output.exec.args.includes(model), kept);
    });
  }
});

describe('#6303 the foreign worker gets a lifecycle record naming its runtime', () => {
  function record(extra) {
    const wt = path.join(project, `wt-record-${extra.length}`);
    fs.mkdirSync(wt, { recursive: true });
    const result = runGsdTools(
      ['query', 'worktree.worker-record', '--path', wt, '--pid', String(process.pid), '--plan', PLAN, '--summary-path', path.join(wt, 'S.md'), ...extra],
      project,
    );
    assert.equal(result.success, true, result.error);
    return { wt, stored: JSON.parse(fs.readFileSync(`${wt}.worker.json`, 'utf8')) };
  }

  test('--executor-runtime is stored on the record and survives worker-complete', () => {
    const { wt, stored } = record(['--executor-runtime', 'codex']);
    assert.equal(stored.executorRuntime, 'codex');
    assert.equal(stored.state, 'running');
    const done = runGsdTools(['query', 'worktree.worker-complete', '--path', wt, '--exit-code', '0'], project);
    assert.equal(done.success, true, done.error);
    const after = JSON.parse(fs.readFileSync(`${wt}.worker.json`, 'utf8'));
    assert.equal(after.state, 'complete');
    assert.equal(after.executorRuntime, 'codex');
  });

  test('a host-runtime worker record carries no executorRuntime key', () => {
    const { stored } = record([]);
    assert.equal('executorRuntime' in stored, false);
  });
});
