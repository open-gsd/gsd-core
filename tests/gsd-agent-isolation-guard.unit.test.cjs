'use strict';

/**
 * In-process unit rows for hooks/gsd-agent-isolation-guard.js (#4885 review:
 * the hook half is held to the mutation-matrix floor).
 *
 * tests/gsd-agent-isolation-guard.test.cjs drives the hook mostly as a
 * subprocess, which Stryker cannot attribute to a mutant, so the decision
 * table is pinned here through the exported functions: which payloads are
 * inspected at all, which recorded or derived decision applies, and the
 * block reason and code each fail-closed branch reports. An allow where a
 * block belongs runs an executor unisolated in the primary checkout.
 */

process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { cleanup } = require('./helpers.cjs');
const { createFixture } = require('./fixtures/index.cjs');
const { SENTINEL_RELATIVE_PATH } = require('../hooks/lib/isolation-sentinel.js');
const { REASON_CODE, describeSentinelDiscard } = require('../hooks/lib/isolation-deny-reason.js');
const { resolveRuntimeNameFromCandidates } = require('../gsd-core/bin/lib/runtime-name-policy.cjs');
const { PassThrough } = require('node:stream');
const { HOOK_ON_CRASH } = require('../hooks/lib/hook-exit.js');
const {
  main,
  evaluateDispatch,
  blockOutputFor,
  resolveIsolationState,
  resolveRuntimeIdentity,
  resolveHarnessFlag,
  resolveRegistryIsolation,
  parseHarnessFlag,
  _setInstallRuntimeMarkerForTests,
} = require('../hooks/gsd-agent-isolation-guard.js');

const NOW = 1_700_000_000_000;
const clock = { now: () => NOW };
const CLAUDE_FLAG = 'isolation="worktree"';

/** Set env vars for one test (undefined deletes), restored afterwards. */
function withEnv(t, vars) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
}

/**
 * A git-backed GSD project (the guard degrades to 'none' outside a
 * repository, #4734) with no runtime signal unless a test supplies one:
 * GSD_RUNTIME unset, GSD_HOME an empty store, no install marker.
 */
function project(t, config = {}) {
  const dir = createFixture({ prefix: 'gsd-aig-unit-', planning: true, git: true, projectDoc: false });
  t.after(() => cleanup(dir));
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-aig-unit-home-'));
  t.after(() => cleanup(home));
  withEnv(t, { GSD_RUNTIME: undefined, GSD_HOME: home });
  _setInstallRuntimeMarkerForTests(null);
  t.after(() => _setInstallRuntimeMarkerForTests(undefined));
  return { dir, home };
}

function writeSentinel(dir, fields) {
  const p = path.join(dir, SENTINEL_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ harness_flag: null, phase: null, plan: null, written_at: NOW, ...fields }));
}

const dispatch = (cwd, toolInput = {}, extra = {}) => ({
  tool_name: 'Agent',
  cwd,
  tool_input: { subagent_type: 'gsd-executor', ...toolInput },
  ...extra,
});

describe('evaluateDispatch: which payloads are inspected at all', () => {
  for (const [label, data] of [['null', null], ['a string', 'Agent'], ['a number', 7], ['undefined', undefined]]) {
    test(`a ${label} payload is allowed without inspection`, () => {
      assert.deepEqual(evaluateDispatch(data, { clock }), { action: 'allow' });
    });
  }

  test('both subagent tool names are inspected; any other tool is not', (t) => {
    const { dir } = project(t);
    writeSentinel(dir, { isolation: 'harness-worktree', harness_flag: CLAUDE_FLAG });
    for (const tool of ['Agent', 'Task']) {
      assert.equal(evaluateDispatch(dispatch(dir, {}, { tool_name: tool }), { clock }).action, 'block', tool);
    }
    for (const tool of ['Read', 'agent', '', undefined]) {
      assert.deepEqual(evaluateDispatch(dispatch(dir, {}, { tool_name: tool }), { clock }), { action: 'allow' }, String(tool));
    }
  });

  test('only an executor subagent_type is inspected; a missing or non-object tool_input is not an executor', (t) => {
    const { dir } = project(t);
    writeSentinel(dir, { isolation: 'harness-worktree', harness_flag: CLAUDE_FLAG });
    assert.deepEqual(evaluateDispatch(dispatch(dir, { subagent_type: 'gsd-planner' }), { clock }), { action: 'allow' });
    assert.deepEqual(evaluateDispatch(dispatch(dir, { subagent_type: 7 }), { clock }), { action: 'allow' });
    assert.deepEqual(evaluateDispatch({ tool_name: 'Agent', cwd: dir }, { clock }), { action: 'allow' });
    assert.deepEqual(evaluateDispatch({ tool_name: 'Agent', cwd: dir, tool_input: 'gsd-executor' }, { clock }), { action: 'allow' });
  });

  test('a dispatch outside any GSD project is allowed', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-aig-unit-none-'));
    t.after(() => cleanup(dir));
    assert.deepEqual(evaluateDispatch(dispatch(dir), { clock }), { action: 'allow' });
  });
});

describe('evaluateDispatch: a fresh recorded decision is authoritative', () => {
  test('harness-worktree with its flag: the flag allows, its absence or another value blocks naming the flag', (t) => {
    const { dir } = project(t);
    writeSentinel(dir, { isolation: 'harness-worktree', harness_flag: CLAUDE_FLAG });
    assert.deepEqual(evaluateDispatch(dispatch(dir, { isolation: 'worktree' }), { clock }), { action: 'allow' });
    for (const input of [{}, { isolation: 'none' }]) {
      const r = evaluateDispatch(dispatch(dir, input), { clock });
      assert.equal(r.action, 'block');
      assert.equal(r.reasonCode, REASON_CODE.HARNESS_FLAG_MISSING);
      assert.equal(r.sentinelDiscarded, null);
      assert.equal(r.reason,
        'Agent isolation guard: this project\'s dispatch isolation resolves to "harness-worktree", ' +
        'but the Agent() dispatch for subagent_type="gsd-executor" is missing isolation="worktree". ' +
        'Add isolation="worktree" to the Agent() call so the executor runs in an isolated worktree ' +
        'instead of the primary checkout (gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md).');
    }
  });

  for (const isolation of ['none', 'orchestrator-worktree']) {
    test(`a recorded "${isolation}" allows a flag-less executor`, (t) => {
      const { dir } = project(t);
      writeSentinel(dir, { isolation });
      assert.deepEqual(evaluateDispatch(dispatch(dir), { clock }), { action: 'allow' });
      assert.deepEqual(resolveIsolationState(dir, { clock }), {
        gsdProject: true, isolation, harnessFlag: null, error: null, sentinelDiscarded: null, root: dir,
      });
    });
  }

  // #3045 BLOCKER 2: the recorded decision proved isolation is required.
  test('a recorded harness-worktree with no flag blocks as unreadable, never degrades to allow', (t) => {
    const { dir } = project(t);
    writeSentinel(dir, { isolation: 'harness-worktree' });
    const state = resolveIsolationState(dir, { clock });
    assert.deepEqual([state.gsdProject, state.isolation, state.root, state.sentinelDiscarded], [true, null, dir, null]);
    assert.match(state.error.message, /resolved "harness-worktree" but recorded no harness_flag/);
    const r = evaluateDispatch(dispatch(dir), { clock });
    assert.deepEqual([r.action, r.reasonCode, r.sentinelDiscarded], ['block', REASON_CODE.CONFIG_UNREADABLE, null]);
    assert.equal(r.reason,
      'Agent isolation guard: could not read or resolve this project\'s dispatch-isolation configuration ' +
      `('.planning/config.json' under '${dir}'). Refusing to dispatch subagent_type="gsd-executor" without ` +
      'being able to verify whether isolation is required — a guard that cannot verify must not answer "safe" ' +
      '(#3050). Retry once the project configuration is readable.');
  });

  test('a recorded flag the Agent tool cannot carry (not key="value") has nothing to check: allow', (t) => {
    const { dir } = project(t);
    writeSentinel(dir, { isolation: 'harness-worktree', harness_flag: '--worktree' });
    assert.deepEqual(evaluateDispatch(dispatch(dir), { clock }), { action: 'allow' });
  });

  // #3045 SECURITY F2 / #4594: a decision recorded for another plan is not
  // this dispatch's; the fallback decides, and the block names what it set aside.
  test('a decision recorded for another phase falls back, and a fallback block names the discarded decision', (t) => {
    const { dir } = project(t, { runtime: 'claude' });
    writeSentinel(dir, { isolation: 'none', phase: '3' });
    const prompt = '[gsd:dispatch phase="4" plan="04-01"] execute';
    const r = evaluateDispatch(dispatch(dir, { prompt }), { clock });
    const discarded = { sentinel: { phase: '3', plan: null }, dispatch: { phase: '4', plan: '04-01' } };
    assert.deepEqual([r.action, r.reasonCode, r.sentinelDiscarded], ['block', REASON_CODE.HARNESS_FLAG_MISSING, discarded]);
    assert.ok(r.reason.endsWith(describeSentinelDiscard(discarded)), r.reason);
    assert.deepEqual(evaluateDispatch(dispatch(dir, { prompt, isolation: 'worktree' }), { clock }), { action: 'allow' });
  });

  test('a stale recorded decision falls back to the registry', (t) => {
    const { dir } = project(t, { runtime: 'claude' });
    writeSentinel(dir, { isolation: 'none', written_at: NOW - 60 * 60 * 1000 });
    assert.equal(evaluateDispatch(dispatch(dir), { clock }).reasonCode, REASON_CODE.HARNESS_FLAG_MISSING);
  });
});

describe('evaluateDispatch: fail-closed reasons', () => {
  test('an unparseable config with no runtime override blocks as unreadable, naming the root', (t) => {
    const { dir } = project(t, '{ not json');
    const r = evaluateDispatch(dispatch(dir), { clock });
    assert.deepEqual([r.action, r.reasonCode], ['block', REASON_CODE.CONFIG_UNREADABLE]);
    assert.ok(r.reason.includes(`'.planning/config.json' under '${dir}'`), r.reason);
  });

  test('a discarded decision is named on an unreadable-config block too', (t) => {
    const { dir } = project(t, '{ not json');
    writeSentinel(dir, { isolation: 'none', phase: '3' });
    const r = evaluateDispatch(dispatch(dir, { prompt: '[gsd:dispatch phase="4" plan="04-01"] go' }), { clock });
    assert.equal(r.reasonCode, REASON_CODE.CONFIG_UNREADABLE);
    assert.ok(r.reason.endsWith(describeSentinelDiscard(r.sentinelDiscarded)), r.reason);
    assert.notEqual(r.sentinelDiscarded, null);
  });

  test('a subdirectory whose governing root cannot be resolved blocks, naming the cwd and the cause', (t) => {
    const { dir } = project(t, { runtime: 'claude' });
    const sub = path.join(dir, 'src');
    fs.mkdirSync(sub);
    const savedPath = process.env.PATH;
    process.env.PATH = path.join(dir, 'no-binaries-here');
    let r;
    let state;
    try {
      r = evaluateDispatch(dispatch(sub), { clock });
      state = resolveIsolationState(sub, { clock });
    } finally {
      process.env.PATH = savedPath;
    }
    assert.deepEqual([r.action, r.reasonCode, r.sentinelDiscarded], ['block', REASON_CODE.CONFIG_UNREADABLE, null]);
    assert.ok(r.reason.startsWith(`Agent isolation guard: '${sub}' is inside a GSD project, but which project root governs it could not be resolved (`), r.reason);
    assert.ok(r.reason.endsWith('Refusing to dispatch subagent_type="gsd-executor" without being able to verify whether isolation is required — a guard that cannot verify must not answer "safe" (#3050). Retry from the project root.'), r.reason);
    assert.deepEqual([state.gsdProject, state.unresolved, state.root], [true, true, null]);
  });

  test('a config.json that is a directory reads as no project config: allow', (t) => {
    const { dir } = project(t);
    cleanup(path.join(dir, '.planning', 'config.json'));
    fs.mkdirSync(path.join(dir, '.planning', 'config.json'));
    const state = resolveIsolationState(dir, { clock });
    assert.equal(state.gsdProject, true);
    assert.notEqual(state.error, null, 'a config path that cannot be read as JSON is a resolution failure');
  });
});

describe('resolveRuntimeIdentity: explicit signals only, in precedence order', () => {
  const configAt = (t, content) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-aig-unit-rt-'));
    t.after(() => cleanup(dir));
    const p = path.join(dir, 'config.json');
    fs.writeFileSync(p, content);
    return { dir, p };
  };
  const isolate = (t, extra = {}) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-aig-unit-rt-home-'));
    t.after(() => cleanup(home));
    withEnv(t, { GSD_RUNTIME: undefined, GSD_HOME: home, ...extra });
    _setInstallRuntimeMarkerForTests(null);
    t.after(() => _setInstallRuntimeMarkerForTests(undefined));
    return home;
  };
  const writeDefaults = (home, content) => {
    fs.mkdirSync(path.join(home, '.gsd'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gsd', 'defaults.json'), content);
  };

  test('GSD_RUNTIME wins over the config key, and the config is not read', (t) => {
    isolate(t, { GSD_RUNTIME: 'codex' });
    assert.deepEqual(resolveRuntimeIdentity('/x', '/does/not/exist.json', resolveRuntimeNameFromCandidates), { runtimeId: 'codex', confident: true });
  });

  test('a config runtime key is confident; a config with none, or an unknown one, is not', (t) => {
    isolate(t);
    assert.deepEqual(resolveRuntimeIdentity('/x', configAt(t, '{"runtime":"cursor"}').p, resolveRuntimeNameFromCandidates), { runtimeId: 'cursor', confident: true });
    for (const content of ['{}', 'null', '"claude"', '{"runtime":""}']) {
      assert.deepEqual(resolveRuntimeIdentity('/x', configAt(t, content).p, resolveRuntimeNameFromCandidates), { runtimeId: null, confident: false }, content);
    }
  });

  // Future-runtime tolerance: a well-formed name the registry does not know yet
  // is still an explicit signal (the registry lookup then finds no isolation).
  test('an unknown but well-formed runtime name is an explicit signal', (t) => {
    isolate(t);
    assert.deepEqual(resolveRuntimeIdentity('/x', configAt(t, '{"runtime":"not-a-runtime"}').p, resolveRuntimeNameFromCandidates), { runtimeId: 'not-a-runtime', confident: true });
  });

  test('an unreadable config throws (the caller folds it into a block)', (t) => {
    isolate(t);
    assert.throws(() => resolveRuntimeIdentity('/x', configAt(t, '{ nope').p, resolveRuntimeNameFromCandidates));
  });

  test('the per-install marker comes before the host-wide defaults', (t) => {
    const home = isolate(t);
    writeDefaults(home, '{"runtime":"codex"}');
    _setInstallRuntimeMarkerForTests('claude');
    assert.deepEqual(resolveRuntimeIdentity('/x', configAt(t, '{}').p, resolveRuntimeNameFromCandidates), { runtimeId: 'claude', confident: true });
  });

  test('the defaults store is the last rung; a malformed or runtime-less one is no signal', (t) => {
    const home = isolate(t);
    const cfg = configAt(t, '{}').p;
    writeDefaults(home, '{"runtime":"codex"}');
    assert.deepEqual(resolveRuntimeIdentity('/x', cfg, resolveRuntimeNameFromCandidates), { runtimeId: 'codex', confident: true });
    for (const content of ['{ nope', 'null', '"codex"', '{}', '{"runtime":""}']) {
      writeDefaults(home, content);
      assert.deepEqual(resolveRuntimeIdentity('/x', cfg, resolveRuntimeNameFromCandidates), { runtimeId: null, confident: false }, content);
    }
  });
});

describe('resolveHarnessFlag / parseHarnessFlag', () => {
  test('a declared non-empty flag string is returned; anything else is null', () => {
    assert.equal(resolveHarnessFlag('claude', { claude: { runtime: { harnessIsolationFlag: CLAUDE_FLAG } } }), CLAUDE_FLAG);
    for (const runtimes of [null, undefined, {}, { claude: {} }, { claude: { runtime: {} } },
      { claude: { runtime: { harnessIsolationFlag: '' } } }, { claude: { runtime: { harnessIsolationFlag: 5 } } }]) {
      assert.equal(resolveHarnessFlag('claude', runtimes), null, JSON.stringify(runtimes));
    }
  });

  test('only a whole key="value" string parses', () => {
    assert.deepEqual(parseHarnessFlag('isolation="worktree"'), { param: 'isolation', value: 'worktree' });
    assert.deepEqual(parseHarnessFlag('_a-b="x y"'), { param: '_a-b', value: 'x y' });
    for (const flag of [null, 42, '--worktree', ' isolation="worktree"', 'isolation="worktree" ', 'isolation=worktree', '9a="x"']) {
      assert.equal(parseHarnessFlag(flag), null, String(flag));
    }
  });
});

describe('resolveRegistryIsolation: the conservative fallback', () => {
  test('no confident runtime is inert, never Claude\'s flag on an unknown host', (t) => {
    const { dir } = project(t);
    assert.deepEqual(resolveRegistryIsolation(dir, path.join(dir, '.planning', 'config.json')), { isolation: 'none', harnessFlag: null });
  });

  test('a harness-worktree runtime with a key="value" flag enforces it', (t) => {
    const { dir } = project(t, { runtime: 'claude' });
    assert.deepEqual(resolveRegistryIsolation(dir, path.join(dir, '.planning', 'config.json')), { isolation: 'harness-worktree', harnessFlag: CLAUDE_FLAG });
  });

  for (const [runtime, isolation] of [['codex', 'orchestrator-worktree'], ['pi', 'none'], ['augment', 'none']]) {
    test(`runtime ${runtime} declares ${isolation === 'none' ? 'no enforceable harness isolation' : isolation}: ${isolation}`, (t) => {
      const { dir } = project(t, { runtime });
      assert.deepEqual(resolveRegistryIsolation(dir, path.join(dir, '.planning', 'config.json')), { isolation, harnessFlag: null });
    });
  }

  test('workflow.use_worktrees: false opts out; true or absent keeps enforcing', (t) => {
    const { dir } = project(t, { runtime: 'claude', workflow: { use_worktrees: false } });
    const cfg = path.join(dir, '.planning', 'config.json');
    assert.equal(resolveRegistryIsolation(dir, cfg).isolation, 'none');
    fs.writeFileSync(cfg, JSON.stringify({ runtime: 'claude', workflow: { use_worktrees: true } }));
    assert.equal(resolveRegistryIsolation(dir, cfg).isolation, 'harness-worktree');
  });

  // #4734: no worktree can be created outside a repository with a commit.
  test('a project that is not a git repository degrades to none', (t) => {
    const dir = createFixture({ prefix: 'gsd-aig-unit-nogit-', planning: true, git: false });
    t.after(() => cleanup(dir));
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ runtime: 'claude' }));
    withEnv(t, { GSD_RUNTIME: undefined });
    assert.equal(resolveRegistryIsolation(dir, path.join(dir, '.planning', 'config.json')).isolation, 'none');
  });
});

describe('blockOutputFor: what the hook writes on a block', () => {
  test('a block is the decision, reason, code and discard; an allow is null', (t) => {
    const { dir } = project(t);
    writeSentinel(dir, { isolation: 'harness-worktree', harness_flag: CLAUDE_FLAG });
    const out = blockOutputFor(JSON.stringify(dispatch(dir)), { clock });
    const decision = evaluateDispatch(dispatch(dir), { clock });
    assert.deepEqual(out, { decision: 'block', reason: decision.reason, reason_code: REASON_CODE.HARNESS_FLAG_MISSING, sentinel_discarded: null });
    assert.equal(blockOutputFor(JSON.stringify(dispatch(dir, { isolation: 'worktree' })), { clock }), null);
  });

  test('a discard rides along on the block', (t) => {
    const { dir } = project(t, { runtime: 'claude' });
    writeSentinel(dir, { isolation: 'none', phase: '3' });
    const out = blockOutputFor(JSON.stringify(dispatch(dir, { prompt: '[gsd:dispatch phase="4" plan="04-01"] go' })), { clock });
    assert.deepEqual(out.sentinel_discarded, { sentinel: { phase: '3', plan: null }, dispatch: { phase: '4', plan: '04-01' } });
  });

  test('an unparseable payload throws, for main() to fail open', () => {
    assert.throws(() => blockOutputFor('{ nope', { clock }), SyntaxError);
  });
});

/** Feed `input` to main() through a stream; resolves with the exit calls it made. */
function runMain(input) {
  return new Promise((resolve) => {
    const calls = [];
    const stdin = new PassThrough();
    const done = () => setImmediate(() => resolve(calls));
    main({
      stdin,
      allow: (payload) => { calls.push(['allow', payload]); done(); },
      deny: (payload, stderr) => { calls.push(['deny', payload, stderr]); },
      crash: (policy, payload) => { calls.push(['crash', policy, payload]); done(); },
    });
    stdin.end(input);
  });
}

describe('main: the stdin adapter', () => {
  test('a blocked dispatch is denied with the block payload on both streams', async (t) => {
    const { dir } = project(t);
    writeSentinel(dir, { isolation: 'harness-worktree', harness_flag: CLAUDE_FLAG, written_at: Date.now() });
    const calls = await runMain(JSON.stringify(dispatch(dir)));
    assert.equal(calls[0][0], 'deny');
    assert.equal(calls[0][1].decision, 'block');
    assert.equal(calls[0][1].reason_code, REASON_CODE.HARNESS_FLAG_MISSING);
    assert.equal(calls[0][2], calls[0][1].reason);
  });

  test('an allowed dispatch only allows', async (t) => {
    const { dir } = project(t);
    writeSentinel(dir, { isolation: 'none', written_at: Date.now() });
    assert.deepEqual(await runMain(JSON.stringify(dispatch(dir))), [['allow', undefined]]);
  });

  test('a payload split across chunks is read whole', async (t) => {
    const { dir } = project(t);
    writeSentinel(dir, { isolation: 'harness-worktree', harness_flag: CLAUDE_FLAG, written_at: Date.now() });
    const calls = await new Promise((resolve) => {
      const got = [];
      const stdin = new PassThrough();
      main({ stdin, allow: (p) => { got.push(['allow', p]); setImmediate(() => resolve(got)); }, deny: (p) => got.push(['deny', p.reason_code]), crash: () => {} });
      const text = JSON.stringify(dispatch(dir));
      stdin.write(text.slice(0, 10));
      stdin.end(text.slice(10));
    });
    assert.deepEqual(calls[0], ['deny', REASON_CODE.HARNESS_FLAG_MISSING]);
  });

  test('an unparseable payload takes the fail-open crash path', async () => {
    assert.deepEqual(await runMain('{ nope'), [['crash', HOOK_ON_CRASH.ALLOW, undefined]]);
  });
});

/**
 * Load a fresh copy of the hook with `fakes` (absolute module path -> exports)
 * substituted in require.cache, restoring every entry afterwards.
 */
function loadHookWith(t, fakes) {
  const hookPath = require.resolve('../hooks/gsd-agent-isolation-guard.js');
  const keys = [hookPath, ...Object.keys(fakes)];
  const saved = keys.map((k) => [k, require.cache[k]]);
  t.after(() => {
    for (const [k, v] of saved) { if (v) require.cache[k] = v; else delete require.cache[k]; }
  });
  for (const [k, exportsObj] of Object.entries(fakes)) {
    require.cache[k] = { id: k, filename: k, loaded: true, exports: exportsObj, children: [], paths: [] };
  }
  delete require.cache[hookPath];
  return require(hookPath);
}
const SEAM_PATH = require.resolve('../gsd-core/bin/ensure-runtime-build.cjs');
const WORKSPACE_PATH = require.resolve('../gsd-core/bin/lib/planning-workspace.cjs');

describe('evaluateDispatch: a runtime library that will not build', () => {
  test('blocks as runtime_build_failed with the seam\'s own message', (t) => {
    const { dir } = project(t, { runtime: 'claude' });
    class FakeRuntimeBuildError extends Error {}
    const hook = loadHookWith(t, {
      [SEAM_PATH]: { RuntimeBuildError: FakeRuntimeBuildError, ensureRuntimeBuild: () => { throw new FakeRuntimeBuildError('lib not built: run npm run build:lib'); } },
    });
    const r = hook.evaluateDispatch(dispatch(dir), { clock });
    assert.deepEqual([r.action, r.reasonCode, r.sentinelDiscarded], ['block', REASON_CODE.RUNTIME_BUILD_FAILED, null]);
    assert.equal(r.reason,
      'Agent isolation guard: cannot resolve this project\'s dispatch-isolation configuration because the GSD ' +
      'runtime library failed to self-build. lib not built: run npm run build:lib Refusing to dispatch ' +
      'subagent_type="gsd-executor" until the runtime library is built — a guard that cannot verify must not ' +
      'answer "safe" (#3050).');
  });
});

describe('resolveRegistryIsolation: the flat-config fallback when the opt-out ladder is unreachable', () => {
  const ladderDown = (t) => loadHookWith(t, {
    [WORKSPACE_PATH]: { worktreesOptedOut: () => { throw new Error('ladder unavailable'); } },
  });

  for (const [label, config, isolation] of [
    ['use_worktrees: false opts out', { runtime: 'claude', workflow: { use_worktrees: false } }, 'none'],
    ['use_worktrees: true keeps enforcing', { runtime: 'claude', workflow: { use_worktrees: true } }, 'harness-worktree'],
    ['no workflow block keeps enforcing', { runtime: 'claude' }, 'harness-worktree'],
    ['a non-object workflow keeps enforcing', { runtime: 'claude', workflow: 'off' }, 'harness-worktree'],
    ['a string use_worktrees keeps enforcing', { runtime: 'claude', workflow: { use_worktrees: 'false' } }, 'harness-worktree'],
  ]) {
    test(label, (t) => {
      const { dir } = project(t, config);
      const hook = ladderDown(t);
      assert.equal(hook.resolveRegistryIsolation(dir, path.join(dir, '.planning', 'config.json')).isolation, isolation);
    });
  }
});

describe('the remaining decision edges', () => {
  test('not a GSD project: the state says so in full', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-aig-unit-none2-'));
    t.after(() => cleanup(dir));
    assert.deepEqual(resolveIsolationState(dir, { clock }), {
      gsdProject: false, isolation: null, harnessFlag: null, error: null, sentinelDiscarded: null, root: null,
    });
  });

  test('a recorded harness-worktree with no flag names exactly what is missing', (t) => {
    const { dir } = project(t);
    writeSentinel(dir, { isolation: 'harness-worktree' });
    assert.equal(resolveIsolationState(dir, { clock }).error.message,
      'dispatch-isolation sentinel resolved "harness-worktree" but recorded no harness_flag — ' +
      'cannot verify what parameter the dispatch must carry.');
  });

  test('a runtime name the registry does not know is inert, not a crash', (t) => {
    const { dir } = project(t, { runtime: 'not-a-runtime' });
    assert.deepEqual(resolveRegistryIsolation(dir, path.join(dir, '.planning', 'config.json')), { isolation: 'none', harnessFlag: null });
  });

  test('outside a repository only a harness-worktree decision degrades; orchestrator-worktree stands', (t) => {
    const dir = createFixture({ prefix: 'gsd-aig-unit-nogit2-', planning: true, git: false });
    t.after(() => cleanup(dir));
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ runtime: 'codex' }));
    withEnv(t, { GSD_RUNTIME: undefined });
    assert.equal(resolveRegistryIsolation(dir, path.join(dir, '.planning', 'config.json')).isolation, 'orchestrator-worktree');
  });

  test('a flag value that only stringifies like key="value" is not a flag', () => {
    assert.equal(parseHarnessFlag({ toString: () => 'isolation="worktree"' }), null);
  });
});

