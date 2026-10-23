'use strict';

/**
 * In-process unit rows for hooks/gsd-cursor-subagent-start.js (#4885 review:
 * the hook half is held to the mutation-matrix floor).
 *
 * tests/cursor-subagent-isolation.test.cjs drives the hook mostly as a
 * subprocess, which Stryker cannot attribute to a mutant, so the decision
 * table is pinned here through the exported functions: which dispatches and
 * workspace roots are evaluated, which recorded or derived decision applies,
 * what counts as an isolated Cursor worktree, and the deny each fail-closed
 * branch reports. An allow where a deny belongs lets an executor edit the
 * user's primary checkout.
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
const { PassThrough } = require('node:stream');
const {
  main,
  hookOutputFor,
  resolveIsolationDecision,
  evaluateRootIsolation,
  resolveFallbackIsolation,
  resolveIsolationEvidence,
  getWorkspaceRoots,
  _setInstallRuntimeMarkerForTests,
} = require('../hooks/gsd-cursor-subagent-start.js');

const NOW = 1_700_000_000_000;
const clock = { now: () => NOW };
const MSG_PRESENT = 'GSD: Subagent session started — review .planning/STATE.md for the current phase and any blockers before acting.';
const MSG_ABSENT = 'GSD: Subagent session started — no .planning/ workflow found.';

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
 * A git-backed GSD project with no runtime signal unless a test supplies one,
 * and a Cursor config dir of its own (so the managed worktree root is known).
 */
function project(t, config = {}) {
  const dir = fs.realpathSync.native(createFixture({ prefix: 'gsd-cur-unit-', planning: true, git: true, projectDoc: false }));
  t.after(() => cleanup(dir));
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cur-unit-home-')));
  t.after(() => cleanup(home));
  const cursorDir = path.join(home, '.cursor');
  fs.mkdirSync(path.join(cursorDir, 'worktrees'), { recursive: true });
  withEnv(t, { GSD_RUNTIME: undefined, GSD_HOME: home, CURSOR_CONFIG_DIR: cursorDir });
  _setInstallRuntimeMarkerForTests(null);
  t.after(() => _setInstallRuntimeMarkerForTests(undefined));
  return { dir, home, managed: path.join(cursorDir, 'worktrees') };
}

function writeSentinel(dir, fields) {
  const p = path.join(dir, SENTINEL_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ harness_flag: null, phase: null, plan: null, written_at: NOW, ...fields }));
}

const NOT_ISOLATED_REASON = (root) =>
  'GSD subagent isolation guard: this project\'s dispatch isolation resolves to "harness-worktree", ' +
  `but subagent_type="gsd-executor" is about to spawn in "${root}", which is not an isolated Cursor worktree — ` +
  'it would edit the user\'s primary checkout directly, with no consent and no warning. Start an isolated ' +
  'session first (the "--worktree" CLI flag or the "/worktree" chat command; Cursor manages these worktrees ' +
  'under "~/.cursor/worktrees/") and retry.';

describe('getWorkspaceRoots: only absolute, non-empty string roots are evaluated', () => {
  test('relative, empty and non-string entries are dropped; order is kept', () => {
    const a = path.resolve('/abs/a');
    const b = path.resolve('/abs/b');
    assert.deepEqual(getWorkspaceRoots({ workspace_roots: [a, '', 'rel/dir', 7, null, b] }), [a, b]);
  });

  test('a missing or non-array workspace_roots is no roots', () => {
    assert.deepEqual(getWorkspaceRoots({}), []);
    assert.deepEqual(getWorkspaceRoots({ workspace_roots: '/abs/a' }), []);
  });
});

describe('resolveIsolationDecision: which dispatches are evaluated', () => {
  test('a confirmed non-executor is allowed before any root is read', (t) => {
    const { dir } = project(t, '{ not json');
    assert.deepEqual(resolveIsolationDecision({ subagent_type: 'gsd-planner', workspace_roots: [dir] }, { clock }), { action: 'allow' });
  });

  test('no usable workspace root is allowed', () => {
    assert.deepEqual(resolveIsolationDecision({ subagent_type: 'gsd-executor', workspace_roots: ['relative'] }, { clock }), { action: 'allow' });
  });

  // #3045 finding 1: every root is reachable by the subagent, whatever its position.
  test('a GSD project in the SECOND root is still denied', (t) => {
    const { dir } = project(t);
    writeSentinel(dir, { isolation: 'harness-worktree' });
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cur-unit-other-'));
    t.after(() => cleanup(other));
    const r = resolveIsolationDecision({ subagent_type: 'gsd-executor', workspace_roots: [other, dir] }, { clock });
    assert.deepEqual([r.action, r.reasonCode], ['deny', REASON_CODE.NOT_ISOLATED_WORKTREE]);
    assert.equal(r.reason, NOT_ISOLATED_REASON(dir));
  });

  test('a missing or empty subagent_type is not ruled out: denied as no_subagent_type on a harness-worktree project', (t) => {
    const { dir } = project(t);
    writeSentinel(dir, { isolation: 'harness-worktree' });
    for (const data of [{ workspace_roots: [dir] }, { subagent_type: '', workspace_roots: [dir] }, { subagent_type: 3, workspace_roots: [dir] }]) {
      const r = resolveIsolationDecision(data, { clock });
      assert.deepEqual([r.action, r.reasonCode, r.sentinelDiscarded], ['deny', REASON_CODE.NO_SUBAGENT_TYPE, null], JSON.stringify(data));
      assert.match(r.reason, /carries no usable subagent_type/);
    }
  });

  // #3045 SECURITY F2: the dispatch's own `task` text identifies its plan.
  test('a decision recorded for another phase is set aside, and the deny names it', (t) => {
    const { dir } = project(t, { runtime: 'cursor' });
    writeSentinel(dir, { isolation: 'none', phase: '3' });
    const r = resolveIsolationDecision({ subagent_type: 'gsd-executor', workspace_roots: [dir], task: '[gsd:dispatch phase="4" plan="04-01"] go' }, { clock });
    const discarded = { sentinel: { phase: '3', plan: null }, dispatch: { phase: '4', plan: '04-01' } };
    assert.deepEqual([r.action, r.reasonCode, r.sentinelDiscarded], ['deny', REASON_CODE.NOT_ISOLATED_WORKTREE, discarded]);
    assert.equal(r.reason, NOT_ISOLATED_REASON(dir) + describeSentinelDiscard(discarded));
  });
});

describe('evaluateRootIsolation: the per-root verdict', () => {
  test('outside any GSD project: allow', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cur-unit-none-'));
    t.after(() => cleanup(dir));
    assert.deepEqual(evaluateRootIsolation(dir, 'gsd-executor', { clock }), { action: 'allow' });
  });

  for (const isolation of ['none', 'orchestrator-worktree']) {
    test(`a recorded "${isolation}" allows`, (t) => {
      const { dir } = project(t);
      writeSentinel(dir, { isolation });
      assert.deepEqual(evaluateRootIsolation(dir, 'gsd-executor', { clock }), { action: 'allow' });
    });
  }

  test('a recorded harness-worktree outside the managed root is denied; under it, allowed', (t) => {
    const { dir, managed } = project(t);
    writeSentinel(dir, { isolation: 'harness-worktree' });
    const r = evaluateRootIsolation(dir, 'gsd-executor', { clock });
    assert.deepEqual([r.action, r.reasonCode, r.sentinelDiscarded], ['deny', REASON_CODE.NOT_ISOLATED_WORKTREE, null]);
    assert.equal(r.reason, NOT_ISOLATED_REASON(dir));

    const isolatedRoot = path.join(managed, 'wt-1');
    fs.mkdirSync(path.join(isolatedRoot, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(isolatedRoot, '.planning', 'config.json'), '{}');
    writeSentinel(isolatedRoot, { isolation: 'harness-worktree' });
    assert.deepEqual(evaluateRootIsolation(isolatedRoot, 'gsd-executor', { clock }), { action: 'allow' });
  });

  test('a stale recorded decision falls back to the registry: an explicit cursor runtime enforces', (t) => {
    const { dir } = project(t, { runtime: 'cursor' });
    writeSentinel(dir, { isolation: 'none', written_at: NOW - 60 * 60 * 1000 });
    assert.equal(evaluateRootIsolation(dir, 'gsd-executor', { clock }).reasonCode, REASON_CODE.NOT_ISOLATED_WORKTREE);
  });

  test('an unreadable config with no recorded decision is denied as unreadable, naming the root', (t) => {
    const { dir } = project(t, '{ not json');
    const r = evaluateRootIsolation(dir, 'gsd-executor', { clock });
    assert.deepEqual([r.action, r.reasonCode, r.sentinelDiscarded], ['deny', REASON_CODE.CONFIG_UNREADABLE, null]);
    assert.equal(r.reason,
      'GSD subagent isolation guard: could not read or resolve this project\'s dispatch-isolation configuration ' +
      `('.planning/config.json' exists under "${dir}"). Refusing to allow this subagent to spawn without being able ` +
      'to verify whether isolation is required — a guard that cannot verify must not answer "safe" (#3050). ' +
      'Retry once the project configuration is readable.');
  });

  test('an unreadable config names a discarded decision too', (t) => {
    const { dir } = project(t, '{ not json');
    writeSentinel(dir, { isolation: 'none', phase: '3' });
    const r = evaluateRootIsolation(dir, 'gsd-executor', { clock, dispatchIds: { phase: '4', plan: null } });
    assert.equal(r.reasonCode, REASON_CODE.CONFIG_UNREADABLE);
    assert.ok(r.reason.endsWith(describeSentinelDiscard(r.sentinelDiscarded)), r.reason);
  });

  test('a subdirectory whose governing root cannot be resolved is denied, naming the workspace root', (t) => {
    const { dir } = project(t, { runtime: 'cursor' });
    const sub = path.join(dir, 'src');
    fs.mkdirSync(sub);
    const savedPath = process.env.PATH;
    process.env.PATH = path.join(dir, 'no-binaries-here');
    let r;
    try {
      r = evaluateRootIsolation(sub, 'gsd-executor', { clock });
    } finally {
      process.env.PATH = savedPath;
    }
    assert.deepEqual([r.action, r.reasonCode, r.sentinelDiscarded], ['deny', REASON_CODE.CONFIG_UNREADABLE, null]);
    assert.ok(r.reason.startsWith(`GSD subagent isolation guard: workspace root "${sub}" is inside a GSD project, but which project root governs it could not be resolved (`), r.reason);
  });

  test('a root that cannot be resolved on disk is cannot-determine, never isolated', (t) => {
    const { dir } = project(t);
    writeSentinel(dir, { isolation: 'harness-worktree' });
    const realpath = (p) => { if (p === dir) throw new Error('ENOENT'); return fs.realpathSync(p); };
    const r = evaluateRootIsolation(dir, 'gsd-executor', { clock, realpath });
    assert.deepEqual([r.action, r.reasonCode, r.sentinelDiscarded], ['deny', REASON_CODE.CANNOT_DETERMINE_ISOLATION, null]);
    assert.ok(r.reason.includes(`whether "${dir}" is running in an isolated Cursor worktree could not be determined`), r.reason);
  });

  test('a non-git root is outside the threat model: allow', (t) => {
    const { managed } = project(t);
    const dir = fs.realpathSync.native(createFixture({ prefix: 'gsd-cur-unit-nogit-', planning: true, git: false }));
    t.after(() => cleanup(dir));
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), '{}');
    writeSentinel(dir, { isolation: 'harness-worktree' });
    assert.ok(!dir.startsWith(managed));
    assert.deepEqual(evaluateRootIsolation(dir, 'gsd-executor', { clock }), { action: 'allow' });
  });
});

describe('resolveIsolationEvidence', () => {
  test('the managed root itself, and anything under it, is isolated; a sibling named like it is not', (t) => {
    const { managed } = project(t);
    const inside = path.join(managed, 'a', 'b');
    fs.mkdirSync(inside, { recursive: true });
    const sibling = `${managed}-evil`;
    fs.mkdirSync(sibling);
    t.after(() => cleanup(sibling));
    for (const root of [managed, inside]) {
      assert.deepEqual(resolveIsolationEvidence(root), { isolated: true, cannotDetermine: false, notApplicable: false }, root);
    }
    assert.equal(resolveIsolationEvidence(sibling).isolated, false);
  });

  test('a git checkout outside the managed root is confidently not isolated', (t) => {
    const { dir } = project(t);
    assert.deepEqual(resolveIsolationEvidence(dir), { isolated: false, cannotDetermine: false, notApplicable: false });
  });

  test('a managed root that cannot be resolved proves nothing', (t) => {
    const { dir, managed } = project(t);
    const realpath = (p) => { if (p === managed) throw new Error('ENOENT'); return fs.realpathSync(p); };
    assert.equal(resolveIsolationEvidence(dir, { realpath }).isolated, false);
  });
});

describe('resolveFallbackIsolation: an explicit runtime signal is required', () => {
  const cfgOf = (dir) => path.join(dir, '.planning', 'config.json');

  test('no signal anywhere is inert (never a guessed cursor)', (t) => {
    const { dir } = project(t);
    assert.equal(resolveFallbackIsolation(dir, cfgOf(dir)), 'none');
  });

  test('GSD_RUNTIME, the config key, the marker and the defaults store each name the runtime, in that order', (t) => {
    const { dir, home } = project(t, { runtime: 'codex' });
    withEnv(t, { GSD_RUNTIME: 'cursor' });
    assert.equal(resolveFallbackIsolation(dir, cfgOf(dir)), 'harness-worktree');
    withEnv(t, { GSD_RUNTIME: undefined });
    assert.equal(resolveFallbackIsolation(dir, cfgOf(dir)), 'orchestrator-worktree');
    fs.writeFileSync(cfgOf(dir), '{}');
    _setInstallRuntimeMarkerForTests('cursor');
    assert.equal(resolveFallbackIsolation(dir, cfgOf(dir)), 'harness-worktree');
    _setInstallRuntimeMarkerForTests(null);
    fs.mkdirSync(path.join(home, '.gsd'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gsd', 'defaults.json'), '{"runtime":"cursor"}');
    assert.equal(resolveFallbackIsolation(dir, cfgOf(dir)), 'harness-worktree');
    for (const content of ['{ nope', 'null', '{}', '{"runtime":""}']) {
      fs.writeFileSync(path.join(home, '.gsd', 'defaults.json'), content);
      assert.equal(resolveFallbackIsolation(dir, cfgOf(dir)), 'none', content);
    }
  });

  test('a config that is not an object, or names no runtime, is no signal', (t) => {
    const { dir } = project(t);
    for (const content of ['null', '"cursor"', '{"runtime":""}']) {
      fs.writeFileSync(cfgOf(dir), content);
      assert.equal(resolveFallbackIsolation(dir, cfgOf(dir)), 'none', content);
    }
  });

  test('workflow.use_worktrees: false opts a harness-worktree runtime out; true does not', (t) => {
    const { dir } = project(t, { runtime: 'cursor', workflow: { use_worktrees: false } });
    assert.equal(resolveFallbackIsolation(dir, cfgOf(dir)), 'none');
    for (const workflow of [{ use_worktrees: true }, {}, 'off']) {
      fs.writeFileSync(cfgOf(dir), JSON.stringify({ runtime: 'cursor', workflow }));
      assert.equal(resolveFallbackIsolation(dir, cfgOf(dir)), 'harness-worktree', JSON.stringify(workflow));
    }
  });

  test('a runtime that declares no known isolation mode is none', (t) => {
    const { dir } = project(t, { runtime: 'augment' });
    assert.equal(resolveFallbackIsolation(dir, cfgOf(dir)), 'none');
  });

  test('an unreadable config throws (evaluateRootIsolation turns it into a deny)', (t) => {
    const { dir } = project(t, '{ nope');
    assert.throws(() => resolveFallbackIsolation(dir, cfgOf(dir)));
  });
});

describe('hookOutputFor: what the hook writes', () => {
  test('a deny carries the reason, code, discard and the state reminder', (t) => {
    const { dir } = project(t);
    writeSentinel(dir, { isolation: 'harness-worktree' });
    fs.writeFileSync(path.join(dir, '.planning', 'STATE.md'), '# State\n');
    const out = hookOutputFor(JSON.stringify({ subagent_type: 'gsd-executor', workspace_roots: [dir] }), { clock });
    assert.deepEqual(out, {
      permission: 'deny',
      user_message: NOT_ISOLATED_REASON(dir),
      reason_code: REASON_CODE.NOT_ISOLATED_WORKTREE,
      sentinel_discarded: null,
      additional_context: MSG_PRESENT,
    });
  });

  test('an allow carries only the reminder, present or absent', (t) => {
    const { dir } = project(t);
    writeSentinel(dir, { isolation: 'none' });
    assert.deepEqual(hookOutputFor(JSON.stringify({ subagent_type: 'gsd-executor', workspace_roots: [dir] }), { clock }), { additional_context: MSG_ABSENT });
    fs.writeFileSync(path.join(dir, '.planning', 'STATE.md'), '# State\n');
    assert.deepEqual(hookOutputFor(JSON.stringify({ subagent_type: 'gsd-executor', workspace_roots: [dir] }), { clock }), { additional_context: MSG_PRESENT });
  });

  test('an unparseable or non-object payload is allowed', () => {
    for (const raw of ['{ nope', '"x"', '7', 'null']) {
      const out = hookOutputFor(raw, { clock });
      assert.equal(out.permission, undefined, raw);
    }
  });

  test('a failure outside the verdict paths is allowed, never a crash', (t) => {
    const { dir } = project(t);
    // A present sentinel, so the staleness check reaches the throwing clock.
    writeSentinel(dir, { isolation: 'harness-worktree' });
    let calls = 0;
    const throwing = () => { calls += 1; throw new Error('unexpected'); };
    const out = hookOutputFor(JSON.stringify({ subagent_type: 'gsd-executor', workspace_roots: [dir] }), { clock: { now: throwing } });
    assert.ok(calls > 0, 'the injected failure must actually be raised');
    assert.equal(out.permission, undefined);
  });
});

function loadHookWith(t, fakes) {
  const hookPath = require.resolve('../hooks/gsd-cursor-subagent-start.js');
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
const WORKTREE_SAFETY_PATH = require.resolve('../gsd-core/bin/lib/worktree-safety.cjs');

describe('main: the stdin adapter writes hookOutputFor\'s answer', () => {
  test('a payload split across chunks is read whole and answered once', async (t) => {
    const { dir } = project(t);
    writeSentinel(dir, { isolation: 'harness-worktree', written_at: Date.now() });
    const text = JSON.stringify({ subagent_type: 'gsd-executor', workspace_roots: [dir] });
    const written = await new Promise((resolve) => {
      const out = [];
      const stdin = new PassThrough();
      main({ stdin, write: (str) => { out.push(str); setImmediate(() => resolve(out)); }, allow: () => {} });
      stdin.write(text.slice(0, 7));
      stdin.end(text.slice(7));
    });
    assert.equal(written.length, 1);
    assert.deepEqual(JSON.parse(written[0]), hookOutputFor(text));
    assert.equal(JSON.parse(written[0]).permission, 'deny');
  });
});

describe('a runtime library that will not build', () => {
  class FakeRuntimeBuildError extends Error {}
  for (const [label, thrown, detail] of [
    ['the seam\'s own error', new FakeRuntimeBuildError('lib not built'), 'lib not built'],
    ['any other failure', new Error('EACCES'), 'EACCES'],
  ]) {
    test(`a project root is denied as runtime_build_failed, naming ${label}`, (t) => {
      const { dir } = project(t);
      const hook = loadHookWith(t, { [SEAM_PATH]: { RuntimeBuildError: FakeRuntimeBuildError, ensureRuntimeBuild: () => { throw thrown; } } });
      const r = hook.evaluateRootIsolation(dir, 'gsd-executor', { clock });
      assert.deepEqual([r.action, r.reasonCode, r.sentinelDiscarded], ['deny', REASON_CODE.RUNTIME_BUILD_FAILED, null]);
      assert.equal(r.reason,
        'GSD subagent isolation guard: cannot resolve this project\'s dispatch-isolation configuration because ' +
        `the GSD runtime library failed to self-build. ${detail} Refusing to allow this subagent to spawn until ` +
        'the runtime library is built — a guard that cannot verify must not answer "safe" (#3050).');
    });
  }

  test('a project subdirectory whose root cannot be resolved for a build failure names the build', (t) => {
    const { dir } = project(t);
    const sub = path.join(dir, 'src');
    fs.mkdirSync(sub);
    const hook = loadHookWith(t, { [SEAM_PATH]: { RuntimeBuildError: FakeRuntimeBuildError, ensureRuntimeBuild: () => { throw new FakeRuntimeBuildError('cold tree'); } } });
    const r = hook.evaluateRootIsolation(sub, 'gsd-executor', { clock });
    assert.equal(r.reasonCode, REASON_CODE.RUNTIME_BUILD_FAILED);
    assert.equal(r.reason,
      'GSD subagent isolation guard: cannot resolve this project\'s dispatch-isolation configuration because ' +
      'the GSD runtime library failed to self-build. cold tree Refusing to allow this subagent to spawn until ' +
      'the runtime library is built — a guard that cannot verify must not answer "safe" (#3050).');
  });
});

describe('exact deny reasons and remaining edges', () => {
  test('an unresolved root names the workspace root, the cause and the rule', (t) => {
    const { dir } = project(t, { runtime: 'cursor' });
    const sub = path.join(dir, 'src');
    fs.mkdirSync(sub);
    const savedPath = process.env.PATH;
    process.env.PATH = path.join(dir, 'no-binaries-here');
    let r;
    try {
      r = evaluateRootIsolation(sub, 'gsd-executor', { clock });
    } finally {
      process.env.PATH = savedPath;
    }
    assert.ok(r.reason.endsWith('). Refusing to allow this subagent to spawn without being able to verify whether isolation is required — a guard that cannot verify must not answer "safe" (#3050).'), r.reason);
  });

  test('no usable subagent_type: the full reason, with a discarded decision appended', (t) => {
    const { dir } = project(t, { runtime: 'cursor' });
    writeSentinel(dir, { isolation: 'none', phase: '3' });
    const ids = { phase: '4', plan: null };
    const r = evaluateRootIsolation(dir, undefined, { clock, dispatchIds: ids });
    const base = 'GSD subagent isolation guard: this project\'s dispatch isolation resolves to "harness-worktree", but ' +
      'the subagentStart payload for this dispatch carries no usable subagent_type. Refusing to allow it to spawn ' +
      'without being able to confirm whether it is a GSD executor — a guard that cannot verify must not answer "safe" (#3050).';
    assert.equal(r.reason, base + describeSentinelDiscard(r.sentinelDiscarded));
    writeSentinel(dir, { isolation: 'harness-worktree' });
    assert.equal(evaluateRootIsolation(dir, undefined, { clock }).reason, base);
  });

  test('cannot determine isolation: the full reason, with a discarded decision appended', (t) => {
    const { dir } = project(t, { runtime: 'cursor' });
    writeSentinel(dir, { isolation: 'none', phase: '3' });
    const realpath = (p) => { if (p === dir) throw new Error('ENOENT'); return fs.realpathSync(p); };
    const r = evaluateRootIsolation(dir, 'gsd-executor', { clock, realpath, dispatchIds: { phase: '4', plan: null } });
    const base = 'GSD subagent isolation guard: this project\'s dispatch isolation resolves to "harness-worktree", but ' +
      `whether "${dir}" is running in an isolated Cursor worktree could not be determined (git did not respond). ` +
      'Refusing to allow subagent_type="gsd-executor" to spawn without being able to verify isolation — a guard that ' +
      'cannot verify must not answer "safe" (#3050). Retry once git is responsive.';
    assert.equal(r.reason, base + describeSentinelDiscard(r.sentinelDiscarded));
  });

  test('git timing out on the linkage check is cannot-determine', (t) => {
    const { dir } = project(t);
    const hook = loadHookWith(t, { [WORKTREE_SAFETY_PATH]: { resolveWorktreeLinkage: () => ({ reason: 'git_timed_out' }) } });
    assert.deepEqual(hook.resolveIsolationEvidence(dir), { isolated: false, cannotDetermine: true, notApplicable: false });
  });

  test('a non-git root is not applicable, exactly', (t) => {
    project(t);
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cur-unit-plain-')));
    t.after(() => cleanup(dir));
    assert.deepEqual(resolveIsolationEvidence(dir), { isolated: false, cannotDetermine: false, notApplicable: true });
  });

  test('every root allowing is an allow', (t) => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cur-unit-a-'));
    t.after(() => cleanup(a));
    assert.deepEqual(resolveIsolationDecision({ subagent_type: 'gsd-executor', workspace_roots: [a] }, { clock }), { action: 'allow' });
  });

  test('a deny carries a discarded decision in the written output', (t) => {
    const { dir } = project(t, { runtime: 'cursor' });
    writeSentinel(dir, { isolation: 'none', phase: '3' });
    const out = hookOutputFor(JSON.stringify({ subagent_type: 'gsd-executor', workspace_roots: [dir], task: '[gsd:dispatch phase="4" plan="04-01"] go' }), { clock });
    assert.deepEqual(out.sentinel_discarded, { sentinel: { phase: '3', plan: null }, dispatch: { phase: '4', plan: '04-01' } });
  });

  test('the fallback reads a non-object config as no runtime signal, and still honors GSD_RUNTIME', (t) => {
    const { dir } = project(t);
    const cfg = path.join(dir, '.planning', 'config.json');
    withEnv(t, { GSD_RUNTIME: 'cursor' });
    for (const content of ['null', '"text"', '[]']) {
      fs.writeFileSync(cfg, content);
      assert.equal(resolveFallbackIsolation(dir, cfg), 'harness-worktree', content);
    }
  });

  test('an unknown runtime is inert; use_worktrees only ever opts a harness-worktree runtime out', (t) => {
    const { dir } = project(t, { runtime: 'not-a-runtime' });
    const cfg = path.join(dir, '.planning', 'config.json');
    assert.equal(resolveFallbackIsolation(dir, cfg), 'none');
    fs.writeFileSync(cfg, JSON.stringify({ runtime: 'codex', workflow: { use_worktrees: false } }));
    assert.equal(resolveFallbackIsolation(dir, cfg), 'orchestrator-worktree');
  });
});

