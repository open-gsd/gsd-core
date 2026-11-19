'use strict';

/**
 * #6301 (Phase 2 of #3711, ADR-3711): characterization locks for cross-runtime plan execution.
 *
 * These assertions pass on the code as it stands and pin what Phases 3 and 4 must keep true:
 * a plan that declares `executor_runtime` makes the same dispatch decision while the feature is off
 * (#6303 adds the `executorRuntime` and `fallback` report keys without changing that decision),
 * the host's model has no path into a spawned argv on a harness host, and the per-runtime
 * `orchestratorExec` descriptors a foreign dispatch will reuse keep their argv shape. The
 * failing-first arms (unknown target, absent binary, checkpoint and `agent_hint` refusals) land
 * with the code that makes them pass.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { resolveOrchestratorExec } = require('../gsd-core/bin/lib/host-integration.cjs');

const HOST_MODEL = 'HOSTMODEL-6301-XYZ';
const PHASE = '03';
const PLAN = '03-05';

let project;
let worktreeTarget;

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

/** Run `query dispatch-isolation --json` for the fixture plan and return the parsed output and the plan record. */
function dispatch(runtime, extraEnv = {}) {
  // GSD_OPENCODE_GENERATION is always set: unset, the child probes a real `opencode --version`, so the
  // opencode argv would depend on the machine. Generation 1 keeps the descriptor's own argv.
  const env = { HOME: project, USERPROFILE: project, GSD_HOME: project, GSD_RUNTIME: runtime, GSD_OPENCODE_GENERATION: '1', ...extraEnv };
  // The record write is best-effort; remove the previous one so a silent write failure cannot leave a stale file to read.
  const recordPath = path.join(project, '.gsd', 'dispatch-isolation', `${PHASE}--${PLAN}.json`);
  cleanup(recordPath);
  const result = runGsdTools(
    ['query', 'dispatch-isolation', '--phase', PHASE, '--plan', PLAN, '--cwd-target', worktreeTarget, '--prompt', 'go', '--json'],
    project,
    env,
  );
  assert.equal(result.success, true, result.error);
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  // A fresh decision is decided as it is written (#4904), so both are the write's own clock reading:
  // pin that, then drop both so two runs compare equal.
  assert.equal(record.decided_at, record.written_at, 'a fresh decision is decided when it is written');
  delete record.written_at;
  delete record.decided_at;
  return { output: JSON.parse(result.output), raw: result.output, record };
}

before(() => {
  project = createTempProject('gsd-6301-');
  worktreeTarget = path.join(project, 'wt');
  fs.mkdirSync(worktreeTarget);
});
after(() => { cleanup(project); });

describe('#6301 a plan that declares executor_runtime dispatches identically while the feature is off', () => {
  const gateStates = [
    ['the gate key is unset', {}],
    ['the gate is false', { workflow: { cross_runtime_execution: false } }],
    ['the gate is the string "true" (non-boolean)', { workflow: { cross_runtime_execution: 'true' } }],
    ['the gate is the number 1 (non-boolean)', { workflow: { cross_runtime_execution: 1 } }],
  ];

  for (const [label, extra] of gateStates) {
    test(`claude host: ${label}`, () => {
      writeConfig({ runtime: 'claude', ...extra });
      writePlan({});
      const plain = dispatch('claude');
      writePlan({ executor_runtime: 'codex' });
      const declared = dispatch('claude');
      // #6303: the route now names the plan's declaration and the one reason it was not honored; the
      // dispatch decision itself (every other field) and the recorded decision stay identical.
      const { executorRuntime, fallback, ...declaredDecision } = declared.output;
      // `held` / `decidedAt` (#4904) are part of the decision too.
      assert.deepEqual(declaredDecision, { runtime: plain.output.runtime, isolation: plain.output.isolation, exec: plain.output.exec, harnessFlag: plain.output.harnessFlag, held: plain.output.held, decidedAt: plain.output.decidedAt }, 'the dispatch decision is identical');
      assert.equal(executorRuntime, 'codex');
      assert.equal(fallback, 'gate_off');
      assert.equal(plain.output.executorRuntime, null);
      assert.equal(plain.output.fallback, null);
      assert.deepEqual(declared.record, plain.record, 'the recorded decision is identical');
      assert.equal(declared.output.isolation, 'harness-worktree');
      assert.equal(declared.output.exec, null, 'no foreign process is described');
    });
  }

  test('a plan that also declares a checkpoint gate still dispatches natively today', () => {
    writeConfig({ runtime: 'claude' });
    writePlan({ autonomous: false, executor_runtime: 'codex' });
    const declared = dispatch('claude');
    assert.equal(declared.output.isolation, 'harness-worktree');
    assert.equal(declared.output.exec, null);
  });

  test('the --json output carries exactly runtime, executorRuntime, isolation, exec, harnessFlag, fallback, held and decidedAt', () => {
    writeConfig({ runtime: 'claude' });
    writePlan({ executor_runtime: 'codex' });
    // `held` / `decidedAt` report a held caller degrade (#4904); a fresh dispatch is never held.
    const { output } = dispatch('claude');
    assert.deepEqual(Object.keys(output).sort(), ['decidedAt', 'exec', 'executorRuntime', 'fallback', 'harnessFlag', 'held', 'isolation', 'runtime']);
    assert.equal(output.held, false);
    assert.equal(output.decidedAt, null);
  });
});

describe('#6301 the host model has no path into a spawned argv on a harness host', () => {
  test('a claude host with a configured executor model describes no argv at all', () => {
    writeConfig({ runtime: 'claude', model_overrides: { 'gsd-executor': HOST_MODEL }, models: { execution: HOST_MODEL } });
    writePlan({ executor_runtime: 'codex' });
    const out = dispatch('claude');
    assert.equal(out.output.exec, null);
    assert.equal(out.raw.includes(HOST_MODEL), false, 'the host model appears nowhere in the output');
  });

  test('a native codex host passes its own model, because the host is the executor', () => {
    writeConfig({ runtime: 'codex', model_overrides: { 'gsd-executor': HOST_MODEL }, models: { execution: HOST_MODEL } });
    writePlan({});
    const { exec } = dispatch('codex').output;
    assert.deepEqual(exec.args.slice(0, 3), ['exec', '--model', HOST_MODEL]);
  });
});

describe('#6301 the orchestratorExec descriptors a foreign dispatch reuses', () => {
  const natives = [
    ['codex', 'codex', (wt) => ['exec', '--cd', wt, 'go']],
    ['opencode', 'opencode', (wt) => ['run', '--dir', wt, 'go']],
    ['kimi-code', 'kimi', () => ['--prompt', 'go']],
    ['kimi', 'kimi', (wt) => ['--print', '--work-dir', wt, '--prompt', 'go']],
  ];

  for (const [runtime, command, argvFor] of natives) {
    test(`${runtime} resolves to orchestrator-worktree bound to the target worktree`, () => {
      writeConfig({});
      writePlan({});
      const { output } = dispatch(runtime);
      assert.equal(output.isolation, 'orchestrator-worktree');
      assert.equal(output.exec.command, command);
      assert.deepEqual(output.exec.args, argvFor(worktreeTarget));
      assert.equal(output.exec.cwd, worktreeTarget);
    });
  }

  test('opencode generation 2 drops --dir, since that CLI takes the directory another way', () => {
    writeConfig({});
    writePlan({});
    const { output } = dispatch('opencode', { GSD_OPENCODE_GENERATION: '2' });
    assert.deepEqual(output.exec.args, ['run', 'go']);
  });

  test('a native codex model pin is kept at 200 characters and dropped at 201', () => {
    writePlan({});
    for (const [length, kept] of [[199, true], [200, true], [201, false]]) {
      const model = 'm'.repeat(length);
      writeConfig({ model_overrides: { 'gsd-executor': model } });
      const { exec } = dispatch('codex').output;
      assert.equal(exec.args.includes(model), kept, `length ${length}`);
    }
  });

  test('an unknown runtime id degrades closed to none with no exec', () => {
    writeConfig({});
    writePlan({});
    const { output } = dispatch('no-such-runtime-6301');
    assert.equal(output.isolation, 'none');
    assert.equal(output.exec, null);
  });

  test('a project that opted out of worktrees gets none with no exec, even on an exec host', () => {
    writeConfig({ workflow: { use_worktrees: false } });
    writePlan({});
    const { output } = dispatch('codex');
    assert.equal(output.isolation, 'none');
    assert.equal(output.exec, null);
  });
});

describe('#6301 resolveOrchestratorExec model handling', () => {
  const withFlag = { command: 'x', args: ['run'], cwdFlag: '--cd', promptFlag: null, modelFlag: '--model' };
  const noFlag = { command: 'x', args: ['run'], cwdFlag: '--cd', promptFlag: null, modelFlag: null };

  test('limit-1, limit, limit+1 of the model argument: absent and empty omit it, a value is added, a leading dash is refused', () => {
    assert.deepEqual(resolveOrchestratorExec(withFlag, '/w', 'p').args, ['run', '--cd', '/w', 'p']);
    assert.deepEqual(resolveOrchestratorExec(withFlag, '/w', 'p', '').args, ['run', '--cd', '/w', 'p']);
    assert.deepEqual(resolveOrchestratorExec(withFlag, '/w', 'p', 'm').args, ['run', '--model', 'm', '--cd', '/w', 'p']);
    assert.deepEqual(resolveOrchestratorExec(withFlag, '/w', 'p', '-m'), { ok: false, reason: 'unsafe_leading_dash_model' });
  });

  test('a non-string model is refused', () => {
    for (const bad of [1, true, [], {}]) {
      assert.deepEqual(resolveOrchestratorExec(withFlag, '/w', 'p', bad), { ok: false, reason: 'invalid_model' });
    }
  });

  test('a descriptor without a modelFlag never emits the model', () => {
    assert.deepEqual(resolveOrchestratorExec(noFlag, '/w', 'p', 'm').args, ['run', '--cd', '/w', 'p']);
  });

  test('property: a model is in the argv exactly when the descriptor declares a modelFlag', () => {
    fc.assert(fc.property(
      fc.string({ minLength: 1, maxLength: 40 }).filter((m) => !m.startsWith('-') && m !== 'run' && m !== '/w' && m !== 'p' && m !== '--model' && m !== '--cd'),
      (model) => {
        const flagged = resolveOrchestratorExec(withFlag, '/w', 'p', model);
        const unflagged = resolveOrchestratorExec(noFlag, '/w', 'p', model);
        assert.equal(flagged.ok, true);
        assert.equal(unflagged.ok, true);
        const at = flagged.args.indexOf(model);
        assert.equal(flagged.args[at - 1], '--model');
        assert.equal(unflagged.args.includes(model), false);
      },
    ));
  });
});
