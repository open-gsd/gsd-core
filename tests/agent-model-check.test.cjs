'use strict';

/**
 * hooks/lib/agent-model-check.js — the Agent() model check behind hooks/gsd-agent-isolation-guard.js (#5328).
 *
 * Seam: `evaluateDispatch`, the exported core of the guard (isolation verdict first, then this check), the hook
 * process itself, and the `resolve-execution` / `init --ws` CLI writers of the records the check reads. The isolation
 * rows of the same hook stay in tests/gsd-agent-isolation-guard.test.cjs; the hook runner and fixtures are shared
 * through tests/helpers/agent-isolation-guard-fixtures.cjs.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { runHook: runHookSeam, runGit, runNode } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS, GIT_FIXTURE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { createTempDir, runGsdTools, cleanup, TOOLS_PATH } = require('./helpers.cjs');
const { REASON_CODE, REASON_INTERPOLATION_MAX_LEN } = require('../hooks/lib/isolation-deny-reason.js');
const { runHook, mkProject, writeConfig } = require('./helpers/agent-isolation-guard-fixtures.cjs');

describe('gsd-agent-isolation-guard.js: #5328 — Agent() model vs resolved model', () => {
  const guardModule = require('../hooks/gsd-agent-isolation-guard.js');
  const { ESCALATION_WINDOW_MS, ESCALATION_SKEW_MS, escalationFile } = require('../gsd-core/bin/lib/model-escalation.cjs');
  // adaptive + dynamic_routing: executor/verifier resolve sonnet at first
  // spawn (opus on attempt 1), plan-checker is pinned sonnet, planner opus.
  const ISSUE_CONFIG = {
    runtime: 'claude',
    model_profile: 'adaptive',
    model_overrides: { 'gsd-plan-checker': 'sonnet' },
    dynamic_routing: {
      enabled: true,
      tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
      escalate_on_failure: true,
      max_escalations: 1,
    },
  };
  const WORKTREE = { isolation: 'worktree' };
  let project;
  let savedGsdRuntime;

  before(() => {
    savedGsdRuntime = process.env.GSD_RUNTIME;
    delete process.env.GSD_RUNTIME;
  });
  after(() => {
    if (savedGsdRuntime === undefined) delete process.env.GSD_RUNTIME;
    else process.env.GSD_RUNTIME = savedGsdRuntime;
  });

  function setup(t, config = ISSUE_CONFIG) {
    project = mkProject('gsd-aig-model-');
    writeConfig(project, JSON.stringify(config));
    t.after(() => cleanup(project));
    return project;
  }
  const dispatch = (subagent_type, model, extra = {}) =>
    ({ hook_event_name: 'PreToolUse', tool_name: 'Agent', cwd: project, tool_input: { subagent_type, ...(model ? { model } : {}), ...extra } });
  const plantEscalation = (root, agent, rec) => {
    fs.mkdirSync(path.join(root, '.gsd'), { recursive: true });
    fs.writeFileSync(escalationFile(root, agent), typeof rec === 'string' ? rec : JSON.stringify(rec));
  };
  const evaluate = (payload, clock) => guardModule.evaluateDispatch(payload, { clock: clock || { now: () => PIN } });
  const dispatchVerdict = (m) => evaluate(dispatch('gsd-planner', m));
  // RULESET.TESTS.clock-seam: subprocesses stamp records at PIN (GSD_TEST_MODE + GSD_NOW_MS pin realClock)
  // and the check evaluates at PIN, so no test depends on the wall clock.
  const PIN = 1_700_000_000_000;
  const PINNED = { GSD_TEST_MODE: '1', GSD_NOW_MS: String(PIN) };
  const atPin = { now: () => PIN };

  test('mismatch warns; matching alias or full id allows', (t) => {
    setup(t);
    const w = evaluate(dispatch('gsd-executor', 'opus', WORKTREE));
    assert.equal(w.action, 'warn');
    assert.equal(w.reasonCode, REASON_CODE.AGENT_MODEL_MISMATCH);
    assert.equal(evaluate(dispatch('gsd-executor', 'sonnet', WORKTREE)).action, 'allow');
    assert.equal(evaluate(dispatch('gsd-executor', 'claude-sonnet-4-6', WORKTREE)).action, 'allow');
    assert.equal(evaluate(dispatch('gsd-verifier', 'opus')).action, 'warn');
    assert.equal(evaluate(dispatch('gsd-plan-checker', 'opus')).action, 'warn');
    assert.equal(evaluate(dispatch('gsd-plan-checker', 'sonnet')).action, 'allow');
    assert.equal(evaluate(dispatch('gsd-planner', 'opus')).action, 'allow');
    assert.equal(evaluate(dispatch('gsd-planner', 'sonnet')).action, 'warn');
  });

  test('omitted model warns; unguarded agent types and tools are untouched', (t) => {
    setup(t);
    assert.equal(evaluate(dispatch('gsd-executor', null, WORKTREE)).action, 'warn');
    assert.equal(evaluate({ ...dispatch('gsd-planner', 'sonnet'), tool_name: 'Bash' }).action, 'allow');
  });

  test('resolve-execution --attempt 1 records the escalated model; guard allows it only for that agent', (t) => {
    setup(t);
    const r = runGsdTools(['resolve-execution', 'gsd-executor', '--attempt', '1'], project, PINNED);
    assert.ok(r.success, r.error);
    assert.equal(JSON.parse(r.output).model, 'opus');
    assert.equal(evaluate(dispatch('gsd-executor', 'opus', WORKTREE), atPin).action, 'allow');
    assert.equal(evaluate(dispatch('gsd-verifier', 'opus'), atPin).action, 'warn', 'record is per agent type');
  });

  test('resolve-execution without --attempt writes no escalation record', (t) => {
    setup(t);
    const r = runGsdTools(['resolve-execution', 'gsd-executor'], project);
    assert.ok(r.success, r.error);
    assert.equal(fs.existsSync(escalationFile(project, 'gsd-executor')), false);
  });

  test('stale escalation record is ignored (clock seam)', (t) => {
    setup(t);
    const writtenAt = 1_000_000;
    plantEscalation(project, 'gsd-executor', { model: 'opus', written_at: writtenAt });
    const at = (ms) => ({ now: () => writtenAt + ms });
    assert.equal(evaluate(dispatch('gsd-executor', 'opus', WORKTREE), at(ESCALATION_WINDOW_MS - 1)).action, 'allow');
    assert.equal(evaluate(dispatch('gsd-executor', 'opus', WORKTREE), at(ESCALATION_WINDOW_MS)).action, 'warn');
    assert.equal(evaluate(dispatch('gsd-executor', 'opus', WORKTREE), at(ESCALATION_WINDOW_MS + 1)).action, 'warn');
  });

  test('future-dated record tolerance: allowed above -ESCALATION_SKEW_MS, refused at and below', (t) => {
    setup(t);
    const writtenAt = 1_000_000;
    plantEscalation(project, 'gsd-executor', { model: 'opus', written_at: writtenAt });
    const at = (age) => ({ now: () => writtenAt + age });
    for (const [age, want] of [[-(ESCALATION_SKEW_MS - 1), 'allow'], [-ESCALATION_SKEW_MS, 'warn'], [-(ESCALATION_SKEW_MS + 1), 'warn']]) {
      assert.equal(evaluate(dispatch('gsd-executor', 'opus', WORKTREE), at(age)).action, want, `age ${age}`);
    }
  });

  test('echoed model cap: limit-1 and limit characters shown whole, limit+1 cut to the limit', (t) => {
    setup(t);
    const cap = REASON_INTERPOLATION_MAX_LEN;
    for (const n of [cap - 1, cap, cap + 1]) {
      assert.equal(dispatchVerdict('y'.repeat(n)).passed, 'y'.repeat(Math.min(n, cap)), `n=${n}`);
    }
  });

  test('property: an escalation record is honoured iff -ESCALATION_SKEW_MS < age < ESCALATION_WINDOW_MS', (t) => {
    setup(t);
    const writtenAt = 1_000_000;
    plantEscalation(project, 'gsd-executor', { model: 'opus', written_at: writtenAt });
    fc.assert(fc.property(fc.integer({ min: -20_000, max: ESCALATION_WINDOW_MS + 20_000 }), (age) => {
      const got = evaluate(dispatch('gsd-executor', 'opus', WORKTREE), { now: () => writtenAt + age }).action;
      return got === (age > -ESCALATION_SKEW_MS && age < ESCALATION_WINDOW_MS ? 'allow' : 'warn');
    }));
  });

  test('an escalation record is honoured unless both sides know different sessions', (t) => {
    setup(t);
    const now = 1_000_000;
    plantEscalation(project, 'gsd-executor', { model: 'opus', written_at: now, session: 's1' });
    const at = { now: () => now };
    const as = (session_id) => evaluate({ ...dispatch('gsd-executor', 'opus', WORKTREE), session_id }, at).action;
    assert.equal(as('s1'), 'allow');
    assert.equal(as('s2'), 'warn');
    assert.equal(as(undefined), 'allow', 'unknown dispatching session never narrows');
    plantEscalation(project, 'gsd-executor', { model: 'opus', written_at: now });
    assert.equal(as('s2'), 'allow', 'a session-less record counts: only two known, different sessions refuse');
    assert.equal(as(undefined), 'allow', 'neither side has a session');
  });

  test('resolve-execution --attempt records the session it ran in', (t) => {
    setup(t);
    assert.ok(runGsdTools(['resolve-execution', 'gsd-executor', '--attempt', '1'], project, { CLAUDE_CODE_SESSION_ID: 'sess-x' }).success);
    assert.equal(JSON.parse(fs.readFileSync(escalationFile(project, 'gsd-executor'), 'utf8')).session, 'sess-x');
  });

  test('non-claude runtime and non-GSD project are skipped', (t) => {
    setup(t, { ...ISSUE_CONFIG, runtime: 'codex' });
    assert.equal(evaluate(dispatch('gsd-planner', 'sonnet')).action, 'allow');
    const plain = createTempDir('gsd-aig-model-nogsd-');
    t.after(() => cleanup(plain));
    assert.equal(evaluate({ tool_name: 'Agent', cwd: plain, tool_input: { subagent_type: 'gsd-planner', model: 'sonnet' } }).action, 'allow');
  });

  test('GSD_RUNTIME outranks config.runtime: one runtime chain decides whether the guard runs', (t) => {
    setup(t, { ...ISSUE_CONFIG, runtime: 'codex' });
    process.env.GSD_RUNTIME = 'claude';
    t.after(() => { delete process.env.GSD_RUNTIME; });
    assert.equal(evaluate(dispatch('gsd-planner', 'sonnet')).action, 'warn');
  });

  test('isolation block wins over a model mismatch', (t) => {
    setup(t, { ...ISSUE_CONFIG, hooks: { agent_model_guard: 'deny' } });
    const d = evaluate(dispatch('gsd-executor', 'opus'));
    assert.equal(d.action, 'block');
    assert.equal(d.reasonCode, REASON_CODE.HARNESS_FLAG_MISSING);
  });

  test('deny blocks a wrong or an omitted model', (t) => {
    setup(t, { ...ISSUE_CONFIG, hooks: { agent_model_guard: 'deny' } });
    const d = evaluate(dispatch('gsd-planner', null));
    assert.equal(d.action, 'block');
    assert.equal(d.passed, '');
    assert.equal(evaluate(dispatch('gsd-planner', 'sonnet')).action, 'block');
    assert.equal(evaluate(dispatch('gsd-planner', 'opus')).action, 'allow');
  });

  // Set (or, with undefined, clear) GSD_WORKSTREAM for one test; the runner's value comes back after it.
  function pinWorkstreamEnv(t, value) {
    const ambient = process.env.GSD_WORKSTREAM;
    if (value === undefined) delete process.env.GSD_WORKSTREAM; else process.env.GSD_WORKSTREAM = value;
    t.after(() => { if (ambient === undefined) delete process.env.GSD_WORKSTREAM; else process.env.GSD_WORKSTREAM = ambient; });
  }

  function setupWorkstream(t, rootConfig, wsConfig) {
    setup(t, rootConfig);
    const dir = path.join(project, '.planning', 'workstreams', 'alpha');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(wsConfig));
    pinWorkstreamEnv(t, 'alpha');
  }

  test('workstream runtime decides the native-alias gate, like the expected-model path', (t) => {
    setupWorkstream(t, ISSUE_CONFIG, { runtime: 'codex' });
    assert.equal(evaluate({ ...dispatch('gsd-planner', 'sonnet'), session_id: 'sess-p' }).action, 'allow');
  });

  test('hooks.agent_model_guard is read from the root config only (documented, like the other hooks.* keys)', (t) => {
    setupWorkstream(t, ISSUE_CONFIG, { hooks: { agent_model_guard: false } });
    assert.equal(evaluate({ ...dispatch('gsd-planner', 'sonnet'), session_id: 'sess-p' }).action, 'warn');
  });

  test('corrupt and future-dated records are ignored; Task tool name is guarded', (t) => {
    setup(t);
    plantEscalation(project, 'gsd-executor', '{not json');
    assert.equal(evaluate(dispatch('gsd-executor', 'opus', WORKTREE)).action, 'warn');
    plantEscalation(project, 'gsd-executor', { model: 'opus', written_at: 10_000_000 });
    assert.equal(evaluate(dispatch('gsd-executor', 'opus', WORKTREE), { now: () => 1_000_000 }).action, 'warn');
    assert.equal(evaluate({ ...dispatch('gsd-planner', 'sonnet'), tool_name: 'Task' }).action, 'warn');
  });

  test('resolve-execution from a subdir records at the root the hook reads', (t) => {
    setup(t);
    const sub = path.join(project, 'sub', 'dir');
    fs.mkdirSync(sub, { recursive: true });
    const r = runGsdTools(['resolve-execution', 'gsd-executor', '--attempt', '1'], sub, PINNED);
    assert.ok(r.success, r.error);
    assert.equal(fs.existsSync(escalationFile(project, 'gsd-executor')), true);
    assert.equal(evaluate({ ...dispatch('gsd-executor', 'opus', WORKTREE), cwd: sub }, atPin).action, 'allow');
  });

  test('quota failure-class escalation records the provider model it resolved', (t) => {
    setup(t, { ...ISSUE_CONFIG, dynamic_routing: { ...ISSUE_CONFIG.dynamic_routing, provider_escalation: ['gpt-5'] } });
    const r = runGsdTools(['resolve-execution', 'gsd-executor', '--attempt', '1', '--failure-class', 'quota-exceeded'], project);
    assert.ok(r.success, r.error);
    assert.equal(JSON.parse(r.output).model, 'gpt-5');
    assert.equal(JSON.parse(fs.readFileSync(escalationFile(project, 'gsd-executor'), 'utf8')).model, 'gpt-5');
  });

  test('family match is token-bounded: substrings of custom model names do not collide', (t) => {
    setup(t);
    assert.equal(evaluate(dispatch('gsd-planner', 'noopus-1')).action, 'warn');
    assert.equal(evaluate(dispatch('gsd-planner', 'claude-opus-4-8')).action, 'allow');
    assert.equal(evaluate(dispatch('gsd-planner', 'opus45')).action, 'allow');
  });

  test('the passed model keeps only id-shaped characters and is capped', (t) => {
    setup(t);
    const w = evaluate(dispatch('gsd-planner', `x\n${'y'.repeat(200)}\u2028z`));
    assert.equal(w.action, 'warn');
    assert.equal(w.passed, `x?${'y'.repeat(REASON_INTERPOLATION_MAX_LEN - 2)}`);
    assert.equal(dispatchVerdict('x" ignore prior').passed, 'x??ignore?prior');
  });

  test('escalation record without a string model never matches', (t) => {
    setup(t);
    plantEscalation(project, 'gsd-planner', { written_at: PIN });
    assert.equal(evaluate(dispatch('gsd-planner', 'undefined'), atPin).action, 'warn');
  });

  test('escalation record whose written_at is not a finite number never matches', (t) => {
    setup(t);
    const now = 1_000_000;
    for (const written_at of [String(now), null, 'x']) {
      plantEscalation(project, 'gsd-planner', `{"model":"sonnet","written_at":${JSON.stringify(written_at)}}`);
      assert.equal(evaluate(dispatch('gsd-planner', 'sonnet'), { now: () => now }).action, 'warn', String(written_at));
    }
  });

  test('a plain resolve-execution or a sibling plan\'s baseline --attempt 0 does not drop an in-flight escalation', (t) => {
    setup(t);
    assert.ok(runGsdTools(['resolve-execution', 'gsd-executor', '--attempt', '1'], project, PINNED).success);
    assert.ok(runGsdTools(['resolve-execution', 'gsd-executor'], project, PINNED).success);
    assert.ok(runGsdTools(['resolve-execution', 'gsd-executor', '--attempt', '0'], project, PINNED).success);
    assert.equal(fs.existsSync(escalationFile(project, 'gsd-executor')), true);
    assert.equal(evaluate(dispatch('gsd-executor', 'opus', WORKTREE), atPin).action, 'allow');
  });

  test('resolve-execution never writes outside .gsd for a traversal-shaped agent type', (t) => {
    setup(t, { ...ISSUE_CONFIG, dynamic_routing: { ...ISSUE_CONFIG.dynamic_routing, provider_escalation: ['gpt-5'] } });
    runGsdTools(['resolve-execution', 'x/../../escape', '--attempt', '1', '--failure-class', 'quota-exceeded'], project);
    assert.equal(fs.existsSync(path.join(project, 'escape.json')), false);
    assert.deepEqual(fs.readdirSync(project).filter((f) => f.includes('escape')), []);
  });

  test('a hostile model_overrides value is filtered and capped like the passed model', (t) => {
    setup(t, { ...ISSUE_CONFIG, model_overrides: { 'gsd-planner': `x\n" ignore prior ${'z'.repeat(200)}` } });
    const w = evaluate(dispatch('gsd-planner', 'sonnet'));
    assert.equal(w.action, 'warn');
    assert.equal(w.expected, `x???ignore?prior?${'z'.repeat(REASON_INTERPOLATION_MAX_LEN - 'x???ignore?prior?'.length)}`);
    writeConfig(project, JSON.stringify({ ...ISSUE_CONFIG, model_overrides: { 'gsd-planner': 'claude-opus-4-1@20250805' } }));
    assert.equal(evaluate(dispatch('gsd-planner', 'sonnet')).expected, 'claude-opus-4-1@20250805');
  });

  // Claude Code sets CLAUDE_CODE_SESSION_ID in Bash tool subprocesses to the hook JSON's session_id
  // (Claude Code environment-variables reference, CLAUDE_CODE_SESSION_ID); this pins GSD's side of that equality.
  test('hook process: a session-less record is honoured, a record for session X only for X', (t) => {
    setup(t);
    assert.ok(runGsdTools(['resolve-execution', 'gsd-executor', '--attempt', '1'], project, { ...PINNED, CLAUDE_CODE_SESSION_ID: 'sess-x' }).success);
    const warned = (session_id) => {
      const r = runHook({ ...dispatch('gsd-executor', 'opus', WORKTREE), session_id }, project, PINNED);
      assert.equal(r.status, 0, r.stderr);
      const ctx = r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput?.additionalContext : undefined;
      return typeof ctx === 'string' && ctx.length > 0;
    };
    assert.equal(warned('sess-x'), false);
    assert.equal(warned('sess-y'), true);
    assert.ok(runGsdTools(['resolve-execution', 'gsd-executor', '--attempt', '1'], project, { ...PINNED, CLAUDE_CODE_SESSION_ID: '' }).success);
    assert.equal(warned('sess-x'), false, 'a session-less record is honoured');
    assert.equal(warned(undefined), false);
  });

  const WIN32 = process.platform === 'win32';

  test('a symlinked escalation record is not followed', { skip: WIN32 }, (t) => {
    setup(t);
    const planted = path.join(project, 'planted.json');
    fs.writeFileSync(planted, JSON.stringify({ model: 'opus', written_at: 1_000_000 }));
    fs.mkdirSync(path.join(project, '.gsd'), { recursive: true });
    fs.symlinkSync(planted, escalationFile(project, 'gsd-executor'));
    assert.equal(evaluate(dispatch('gsd-executor', 'opus', WORKTREE), { now: () => 1_000_000 }).action, 'warn');
  });

  test('a FIFO escalation record is refused without hanging', { skip: WIN32 }, (t) => {
    setup(t);
    fs.mkdirSync(path.join(project, '.gsd'), { recursive: true });
    const made = runHookSeam(escalationFile(project, 'gsd-executor'), [], { interpreter: 'mkfifo', timeoutMs: PROBE_TIMEOUT_MS });
    if (made.exitCode !== 0) return t.skip('mkfifo unavailable');
    assert.equal(evaluate(dispatch('gsd-executor', 'opus', WORKTREE)).action, 'warn');
  });

  test('a non-regular config.json fails open without an unbounded read', { skip: WIN32 || !fs.existsSync('/dev/zero') }, (t) => {
    setup(t);
    const config = path.join(project, '.planning', 'config.json');
    fs.unlinkSync(config);
    fs.symlinkSync('/dev/zero', config);
    assert.equal(evaluate(dispatch('gsd-planner', 'sonnet')).action, 'allow');
  });

  // Regression pin, not a fix proof: POSIX tmp+rename never followed it; win32 cannot plant symlinks unprivileged.
  test('resolve-execution never writes through a symlink planted at the record path', { skip: WIN32 }, (t) => {
    setup(t);
    const victim = path.join(project, 'victim.txt');
    fs.writeFileSync(victim, 'keep');
    fs.mkdirSync(path.join(project, '.gsd'), { recursive: true });
    fs.symlinkSync(victim, escalationFile(project, 'gsd-executor'));
    assert.ok(runGsdTools(['resolve-execution', 'gsd-executor', '--attempt', '1'], project, PINNED).success);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
    assert.equal(fs.lstatSync(escalationFile(project, 'gsd-executor')).isSymbolicLink(), false);
    assert.equal(evaluate(dispatch('gsd-executor', 'opus', WORKTREE), atPin).action, 'allow');
  });

  test('writeEscalation stamps the injected clock and recovers from a stale tmp file', (t) => {
    setup(t);
    const esc = require('../gsd-core/bin/lib/model-escalation.cjs');
    const tmp = `${escalationFile(project, 'gsd-executor')}.${process.pid}.tmp`;
    fs.mkdirSync(path.join(project, '.gsd'), { recursive: true });
    fs.writeFileSync(tmp, 'left by a crashed writer');
    esc.writeEscalation(project, 'gsd-executor', 'opus', undefined, { now: () => 42 });
    assert.deepEqual(JSON.parse(fs.readFileSync(escalationFile(project, 'gsd-executor'), 'utf8')), { model: 'opus', written_at: 42 });
    assert.equal(fs.existsSync(tmp), false);
  });

  test('writeEscalation throws when the record cannot be written, leaving no tmp file', { skip: WIN32 }, (t) => {
    setup(t);
    const esc = require('../gsd-core/bin/lib/model-escalation.cjs');
    const file = escalationFile(project, 'gsd-executor');
    fs.mkdirSync(file, { recursive: true }); // rename of a file onto a directory fails
    assert.throws(() => esc.writeEscalation(project, 'gsd-executor', 'opus'));
    assert.equal(fs.existsSync(`${file}.${process.pid}.tmp`), false);
  });

  test('resolve-execution with a symlinked .gsd still resolves and writes no record through the link', { skip: WIN32 }, (t) => {
    setup(t);
    const elsewhere = createTempDir('gsd-aig-elsewhere-');
    t.after(() => cleanup(elsewhere));
    fs.symlinkSync(elsewhere, path.join(project, '.gsd'));
    const r = runNode([TOOLS_PATH, 'resolve-execution', 'gsd-executor', '--attempt', '1'], { cwd: project, timeoutMs: PROBE_TIMEOUT_MS });
    assert.equal(r.exitCode, 0, 'the escalation itself proceeds');
    assert.equal(JSON.parse(r.stdout).model, 'opus');
    assert.equal(fs.existsSync(escalationFile(project, 'gsd-executor')), false, 'no record');
    assert.deepEqual(fs.readdirSync(elsewhere), []);
  });

  test('a symlinked .gsd/.gitignore refuses the escalation record as it refuses the dispatch sentinel; the target is left alone', { skip: WIN32 }, (t) => {
    setup(t);
    const outside = createTempDir('gsd-aig-target-');
    t.after(() => cleanup(outside));
    const target = path.join(outside, 'target.txt');
    fs.writeFileSync(target, 'unchanged\n');
    fs.mkdirSync(path.join(project, '.gsd'));
    fs.symlinkSync(target, path.join(project, '.gsd', '.gitignore'));
    const esc = runGsdTools(['resolve-execution', 'gsd-executor', '--attempt', '1'], project, PINNED);
    assert.ok(esc.success, esc.error);
    assert.equal(fs.existsSync(escalationFile(project, 'gsd-executor')), false, 'no record beside a symlinked ignore file');
    const sen = runGsdTools(['record-dispatch-isolation', '--isolation', 'harness-worktree'], project);
    assert.ok(sen.success, sen.error);
    assert.equal(JSON.parse(sen.output).recorded, false);
    assert.equal(fs.readFileSync(target, 'utf8'), 'unchanged\n');
  });

  test('read caps: limit-1 and limit are read, limit+1 is not (escalation record 64 KiB, config 1 MiB)', (t) => {
    setup(t);
    const esc = require('../gsd-core/bin/lib/model-escalation.cjs');
    const cap = esc.MAX_READ_BYTES;
    const configCap = require('../gsd-core/bin/lib/config-file-read.cjs').CONFIG_MAX_BYTES;
    assert.equal(cap, 64 * 1024);
    assert.equal(configCap, 1024 * 1024);
    const rec = JSON.stringify({ model: 'opus', written_at: PIN });
    for (const [delta, ok] of [[-1, true], [0, true], [1, false]]) {
      plantEscalation(project, 'gsd-executor', rec + ' '.repeat(cap + delta - rec.length));
      assert.equal(esc.readEscalation(project, 'gsd-executor') !== null, ok, `record cap${delta}`);
      const cfg = JSON.stringify(ISSUE_CONFIG);
      writeConfig(project, cfg + ' '.repeat(configCap + delta - cfg.length));
      // wrong model: warns while the config is read, allows (fails open) once it is over the cap
      assert.equal(evaluate(dispatch('gsd-planner', 'sonnet')).action, ok ? 'warn' : 'allow', `config cap${delta}`);
    }
  });

  test('the model check never rewrites .planning/config.json (legacy keys stay unmigrated on disk)', (t) => {
    setup(t, { ...ISSUE_CONFIG, depth: 'standard' });
    const config = path.join(project, '.planning', 'config.json');
    const before = fs.readFileSync(config, 'utf8');
    const { checkAgentModel } = require('../hooks/lib/agent-model-check.js');
    assert.equal(checkAgentModel(dispatch('gsd-planner', 'sonnet')).action, 'warn');
    assert.equal(fs.readFileSync(config, 'utf8'), before);
  });

  test('an escalation record swapped for a symlink after the lstat is still not followed', { skip: WIN32 }, (t) => {
    setup(t);
    const planted = path.join(project, 'planted.json');
    fs.writeFileSync(planted, JSON.stringify({ model: 'opus', written_at: 1_000_000 }));
    fs.mkdirSync(path.join(project, '.gsd'), { recursive: true });
    const record = escalationFile(project, 'gsd-executor');
    fs.symlinkSync(planted, record);
    // Simulate the race: the lstat sees a regular file, the open then meets the link.
    const realLstat = fs.lstatSync;
    t.mock.method(fs, 'lstatSync', (p, ...rest) => (p === record ? realLstat(planted, ...rest) : realLstat(p, ...rest)));
    assert.equal(evaluate(dispatch('gsd-executor', 'opus', WORKTREE), { now: () => 1_000_000 }).action, 'warn');
  });

  test('writeEscalation refuses a planted .gsd symlink', { skip: WIN32 }, (t) => {
    setup(t);
    const elsewhere = createTempDir('gsd-aig-elsewhere-');
    t.after(() => cleanup(elsewhere));
    fs.symlinkSync(elsewhere, path.join(project, '.gsd'));
    assert.throws(() => require('../gsd-core/bin/lib/model-escalation.cjs').writeEscalation(project, 'gsd-executor', 'opus'));
    assert.deepEqual(fs.readdirSync(elsewhere), []);
  });

  // ensure-runtime-build.test.cjs pins that tscScript null throws without spawning tsc.
  test('the model check calls its build seam with tscScript null', (t) => {
    setup(t);
    const seam = require('../gsd-core/bin/ensure-runtime-build.cjs');
    const spy = t.mock.method(seam, 'ensureRuntimeBuild');
    evaluate(dispatch('gsd-planner', 'sonnet'));
    assert.ok(spy.mock.callCount() > 0);
    assert.ok(spy.mock.calls.every((c) => c.arguments[0] && c.arguments[0].tscScript === null), 'a cold tree is skipped, never built inside the hook');
  });

  test('an unguarded subagent type is allowed before any build seam or built-artifact load', (t) => {
    setup(t);
    const seam = require('../gsd-core/bin/ensure-runtime-build.cjs');
    const spy = t.mock.method(seam, 'ensureRuntimeBuild');
    assert.equal(evaluate(dispatch('gsd-codebase-mapper', 'opus')).action, 'allow');
    assert.equal(spy.mock.callCount(), 0);
  });

  test('the hook\'s literal guarded-type pre-filter matches GUARDED_AGENT_TYPES', () => {
    const { GUARDED_TYPES } = require('../hooks/lib/agent-model-check.js');
    assert.deepEqual([...GUARDED_TYPES].sort(), [...require('../gsd-core/bin/lib/model-escalation.cjs').GUARDED_AGENT_TYPES].sort());
  });

  test('a workstream activated only by the stored pointer decides the expected model, as init resolves it', (t) => {
    pinWorkstreamEnv(t, undefined); // the pointer alone must select the workstream
    setup(t);
    const ws = path.join(project, '.planning', 'workstreams', 'alpha');
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'config.json'), JSON.stringify({ model_overrides: { 'gsd-planner': 'haiku' } }));
    // The shared pointer. A session-scoped pointer lives under os.tmpdir() keyed by this fresh project's
    // path, so none exists and the shared one is read whatever session env the runner has.
    fs.writeFileSync(path.join(project, '.planning', 'active-workstream'), 'alpha');
    const r = runGsdTools(['resolve-model', 'gsd-planner'], project, { GSD_WORKSTREAM: '' });
    assert.ok(r.success, r.error);
    assert.equal(JSON.parse(r.output).model, 'haiku', 'init resolves the pointer-selected workstream');
    assert.equal(evaluate({ ...dispatch('gsd-planner', 'haiku'), session_id: 'sess-p' }).action, 'allow');
    assert.equal(evaluate({ ...dispatch('gsd-planner', 'opus'), session_id: 'sess-p' }).action, 'warn');
    assert.equal(process.env.GSD_WORKSTREAM, undefined, 'the hook restores the environment');
  });

  test('a session-scoped pointer selects the workstream from the payload session_id, as init resolves it', (t) => {
    const keys = ['GSD_WORKSTREAM', 'GSD_SESSION_KEY', 'CODEX_THREAD_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID'];
    const ambient = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    t.after(() => { for (const k of keys) { if (ambient[k] === undefined) delete process.env[k]; else process.env[k] = ambient[k]; } });
    setup(t);
    const ws = path.join(project, '.planning', 'workstreams', 'alpha');
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'config.json'), JSON.stringify({ model_overrides: { 'gsd-planner': 'haiku' } }));
    const store = require('../gsd-core/bin/lib/active-workstream-store.cjs');
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-ws';
    store.setActiveWorkstream(project, 'alpha');
    delete process.env.CLAUDE_CODE_SESSION_ID;
    t.after(() => {
      process.env.CLAUDE_CODE_SESSION_ID = 'sess-ws';
      store.setActiveWorkstream(project, null);
      delete process.env.CLAUDE_CODE_SESSION_ID;
    });
    const r = runGsdTools(['resolve-model', 'gsd-planner'], project, { GSD_WORKSTREAM: '', CLAUDE_CODE_SESSION_ID: 'sess-ws' });
    assert.ok(r.success, r.error);
    assert.equal(JSON.parse(r.output).model, 'haiku', 'init resolves the session-pointed workstream');
    assert.equal(evaluate({ ...dispatch('gsd-planner', 'haiku'), session_id: 'sess-ws' }).action, 'allow');
    assert.equal(evaluate({ ...dispatch('gsd-planner', 'haiku'), session_id: 'other' }).action, 'warn');
    process.env.GSD_SESSION_KEY = 'hook-env'; // ranks above CLAUDE_CODE_SESSION_ID in WORKSTREAM_SESSION_ENV_KEYS
    assert.equal(evaluate({ ...dispatch('gsd-planner', 'haiku'), session_id: 'sess-ws' }).action, 'allow', 'the payload session keys the pointer, not GSD_SESSION_KEY');
    assert.equal(process.env.GSD_SESSION_KEY, 'hook-env', 'the hook restores the environment');
    assert.equal(process.env.CLAUDE_CODE_SESSION_ID, undefined, 'the hook restores the environment');
    assert.equal(process.env.GSD_WORKSTREAM, undefined, 'the hook restores the environment');
  });

  // The init --ws carry lives under os.tmpdir(), keyed by project and session: clear every one a test makes.
  const carryStore = () => require('../gsd-core/bin/lib/active-workstream-store.cjs');
  function clearCarries(t, ...sessions) {
    t.after(() => { for (const s of sessions) carryStore().createSessionScopedPointerAdapter(project, `${carryStore().INIT_WORKSTREAM_KEY_PREFIX}${s}`).clear(); });
  }
  function setupCarry(t, rootConfig, ...sessions) {
    pinWorkstreamEnv(t, undefined);
    setup(t, rootConfig);
    const ws = path.join(project, '.planning', 'workstreams', 'alpha');
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'config.json'), JSON.stringify({ model_overrides: { 'gsd-planner': 'haiku' } }));
    clearCarries(t, ...sessions);
  }
  const initQuick = (session, withWs = true) =>
    runGsdTools(['query', 'init.quick', 't', ...(withWs ? ['--ws=alpha'] : [])], project, { ...PINNED, GSD_WORKSTREAM: '', CLAUDE_CODE_SESSION_ID: session });
  const inSession = (model, session) => ({ ...dispatch('gsd-planner', model), session_id: session });

  test('init --ws carries the workstream to the hook: its baseline passes, another model warns, deny blocks', (t) => {
    setupCarry(t, ISSUE_CONFIG, 'sess-ws');
    const r = initQuick('sess-ws');
    assert.ok(r.success, r.error);
    assert.equal(JSON.parse(r.output).planner_model, 'haiku');
    assert.equal(evaluate(inSession('haiku', 'sess-ws')).action, 'allow');
    assert.equal(evaluate(inSession('sonnet', 'sess-ws')).action, 'warn');
    assert.equal(evaluate(inSession('haiku', 'other')).action, 'warn', 'another session has no carry');
    writeConfig(project, JSON.stringify({ ...ISSUE_CONFIG, hooks: { agent_model_guard: 'deny' } }));
    assert.equal(evaluate(inSession('sonnet', 'sess-ws')).action, 'block');
  });

  test('a carried workstream and the session pointer: a model matching either baseline passes, the verdict names both', (t) => {
    const keys = ['GSD_WORKSTREAM', 'GSD_SESSION_KEY', 'CODEX_THREAD_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID'];
    const ambient = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    t.after(() => { for (const k of keys) { if (ambient[k] === undefined) delete process.env[k]; else process.env[k] = ambient[k]; } });
    setupCarry(t, ISSUE_CONFIG, 'sess-ws');
    const beta = path.join(project, '.planning', 'workstreams', 'beta');
    fs.mkdirSync(beta, { recursive: true });
    fs.writeFileSync(path.join(beta, 'config.json'), JSON.stringify({ model_overrides: { 'gsd-planner': 'sonnet' } }));
    const store = carryStore();
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-ws';
    store.setActiveWorkstream(project, 'beta');
    delete process.env.CLAUDE_CODE_SESSION_ID;
    t.after(() => {
      process.env.CLAUDE_CODE_SESSION_ID = 'sess-ws';
      store.setActiveWorkstream(project, null);
      delete process.env.CLAUDE_CODE_SESSION_ID;
    });
    assert.ok(initQuick('sess-ws').success);
    assert.equal(evaluate(inSession('haiku', 'sess-ws')).action, 'allow');
    assert.equal(evaluate(inSession('sonnet', 'sess-ws')).action, 'allow');
    const v = evaluate(inSession('opus', 'sess-ws'));
    assert.equal(v.action, 'warn');
    assert.equal(v.expected, 'haiku or sonnet');
    assert.ok(v.reason.includes('but GSD resolved model="haiku" or model="sonnet". Pass one of them'), v.reason);
    assert.equal(process.env.GSD_WORKSTREAM, undefined, 'the hook restores the environment');
  });

  function setupNonNativePointer(t, rootConfig) {
    const keys = ['GSD_WORKSTREAM', 'GSD_SESSION_KEY', 'CODEX_THREAD_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID'];
    const ambient = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    t.after(() => { for (const k of keys) { if (ambient[k] === undefined) delete process.env[k]; else process.env[k] = ambient[k]; } });
    setupCarry(t, rootConfig, 'sess-ws');
    const beta = path.join(project, '.planning', 'workstreams', 'beta');
    fs.mkdirSync(beta, { recursive: true });
    fs.writeFileSync(path.join(beta, 'config.json'), JSON.stringify({ runtime: 'codex' }));
    const store = carryStore();
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-ws';
    store.setActiveWorkstream(project, 'beta');
    delete process.env.CLAUDE_CODE_SESSION_ID;
    t.after(() => {
      process.env.CLAUDE_CODE_SESSION_ID = 'sess-ws';
      store.setActiveWorkstream(project, null);
      delete process.env.CLAUDE_CODE_SESSION_ID;
    });
    assert.ok(initQuick('sess-ws').success);
  }

  test("a non-native pointer workstream does not veto the carried workstream's baseline", (t) => {
    setupNonNativePointer(t, { ...ISSUE_CONFIG, hooks: { agent_model_guard: 'deny' } });
    assert.equal(evaluate(inSession('haiku', 'sess-ws')).action, 'allow', 'the carried baseline still passes');
    assert.equal(evaluate(inSession('opus', 'sess-ws')).action, 'block');
  });

  test('every candidate workstream non-native: the guard does not apply', (t) => {
    setupNonNativePointer(t, { ...ISSUE_CONFIG, runtime: 'codex', hooks: { agent_model_guard: 'deny' } });
    assert.equal(evaluate(inSession('opus', 'sess-ws')).action, 'allow');
  });

  test('workstreams exist and the dispatch has no session id: allow', (t) => {
    setupCarry(t, ISSUE_CONFIG);
    assert.equal(evaluate(dispatch('gsd-planner', 'sonnet')).action, 'allow');
  });

  test('an init without --ws neither writes nor clears the carry', (t) => {
    setupCarry(t, ISSUE_CONFIG, 'sess-ws', 'fresh');
    assert.ok(initQuick('sess-ws').success);
    assert.ok(initQuick('sess-ws', false).success);
    assert.equal(evaluate(inSession('haiku', 'sess-ws')).action, 'allow', 'the unflagged init left the carry');
    assert.ok(initQuick('fresh', false).success);
    assert.equal(carryStore().peekInitWorkstream(project, 'fresh', PIN), null);
    assert.equal(carryStore().createSessionScopedPointerAdapter(project, `${carryStore().INIT_WORKSTREAM_KEY_PREFIX}fresh`).read(), null, 'no carry file');
  });

  test('init --ws naming no workstream directory records no carry; an existing workstream still does', (t) => {
    setupCarry(t, ISSUE_CONFIG, 'sess-ws', 'sess-nope');
    const r = runGsdTools(['query', 'init.quick', 't', '--ws=nope'], project, { ...PINNED, GSD_WORKSTREAM: '', CLAUDE_CODE_SESSION_ID: 'sess-nope' });
    assert.ok(r.success, r.error);
    assert.equal(carryStore().createSessionScopedPointerAdapter(project, `${carryStore().INIT_WORKSTREAM_KEY_PREFIX}sess-nope`).read(), null, 'no carry file');
    assert.ok(initQuick('sess-ws').success);
    assert.deepEqual(carryStore().peekInitWorkstream(project, 'sess-ws', PIN), ['alpha']);
  });

  test('init --ws spelled in another case carries it where the filesystem resolves that spelling to the directory', (t) => {
    setupCarry(t, ISSUE_CONFIG, 'sess-upper');
    const { planningDir } = require('../gsd-core/bin/lib/planning-workspace.cjs');
    if (fs.statSync(planningDir(project, 'ALPHA'), { throwIfNoEntry: false })?.isDirectory() !== true) {
      t.skip('case-sensitive filesystem: ALPHA resolves to no workstream directory, the missing-workstream row covers it');
      return;
    }
    const r = runGsdTools(['query', 'init.quick', 't', '--ws=ALPHA'], project, { ...PINNED, GSD_WORKSTREAM: '', CLAUDE_CODE_SESSION_ID: 'sess-upper' });
    assert.ok(r.success, r.error);
    assert.equal(JSON.parse(r.output).planner_model, 'haiku');
    assert.deepEqual(carryStore().peekInitWorkstream(project, 'sess-upper', PIN), ['ALPHA']);
    assert.equal(evaluate(inSession('haiku', 'sess-upper')).action, 'allow');
  });

  test('init --ws naming a symlinked workstream directory carries it', (t) => {
    setupCarry(t, ISSUE_CONFIG, 'sess-link');
    const target = createTempDir('gsd-aig-ws-target-');
    t.after(() => cleanup(target));
    fs.writeFileSync(path.join(target, 'config.json'), JSON.stringify({ model_overrides: { 'gsd-planner': 'sonnet' } }));
    fs.symlinkSync(target, path.join(project, '.planning', 'workstreams', 'beta'), 'junction');
    const r = runGsdTools(['query', 'init.quick', 't', '--ws=beta'], project, { ...PINNED, GSD_WORKSTREAM: '', CLAUDE_CODE_SESSION_ID: 'sess-link' });
    assert.ok(r.success, r.error);
    assert.equal(JSON.parse(r.output).planner_model, 'sonnet');
    assert.deepEqual(carryStore().peekInitWorkstream(project, 'sess-link', PIN), ['beta']);
    assert.equal(evaluate(inSession('sonnet', 'sess-link')).action, 'allow');
  });

  test('an invalid carried name allows', (t) => {
    setupCarry(t, ISSUE_CONFIG, 'sess-bad');
    carryStore().createSessionScopedPointerAdapter(project, `${carryStore().INIT_WORKSTREAM_KEY_PREFIX}sess-bad`).write(`../x ${PIN}`);
    assert.equal(evaluate(inSession('sonnet', 'sess-bad')).action, 'allow');
  });

  test('a carry older than INIT_WORKSTREAM_MAX_AGE_MS cannot establish the workstream: the hook allows, even under deny', (t) => {
    setupCarry(t, ISSUE_CONFIG, 'sess-ws');
    writeConfig(project, JSON.stringify({ ...ISSUE_CONFIG, hooks: { agent_model_guard: 'deny' } }));
    const r = runGsdTools(['query', 'init.quick', 't', '--ws=alpha'], project, { ...PINNED, GSD_WORKSTREAM: '', CLAUDE_CODE_SESSION_ID: 'sess-ws' });
    assert.ok(r.success, r.error);
    const W = carryStore().INIT_WORKSTREAM_MAX_AGE_MS;
    assert.equal(evaluate(inSession('haiku', 'sess-ws'), { now: () => PIN + W - 1 }).action, 'allow');
    assert.equal(evaluate(inSession('sonnet', 'sess-ws'), { now: () => PIN + W - 1 }).action, 'block', 'positive control: a live carry still judges');
    assert.equal(evaluate(inSession('sonnet', 'sess-ws'), { now: () => PIN + W }).action, 'allow');
    assert.equal(evaluate(inSession('haiku', 'sess-ws'), { now: () => PIN + W }).action, 'allow');
    // alpha expired but a read-only init --ws beta is fresh: still cannot tell the run's workstream, so allow
    fs.mkdirSync(path.join(project, '.planning', 'workstreams', 'beta'), { recursive: true });
    assert.equal(carryStore().recordInitWorkstream(project, 'sess-ws', 'beta', PIN + W - 1), true);
    assert.equal(evaluate(inSession('gpt-9', 'sess-ws'), { now: () => PIN + W - 1 }).action, 'block', 'positive control: both entries still fresh');
    assert.equal(evaluate(inSession('gpt-9', 'sess-ws'), { now: () => PIN + W }).action, 'allow');
  });

  test('a forged carry (no valid entry, or an entry the resolver cannot use) allows instead of failing the dispatch', (t) => {
    setupCarry(t, ISSUE_CONFIG, 'sess-bad');
    writeConfig(project, JSON.stringify({ ...ISSUE_CONFIG, hooks: { agent_model_guard: 'deny' } }));
    const carry = carryStore().createSessionScopedPointerAdapter(project, `${carryStore().INIT_WORKSTREAM_KEY_PREFIX}sess-bad`);
    for (const text of ['garbage', `alpha\n../x ${PIN}`, `alpha ${PIN}\n../x ${PIN}`]) {
      carry.write(text);
      assert.equal(evaluate(inSession('sonnet', 'sess-bad')).action, 'allow', text.slice(0, 40));
    }
  });

  test('an interleaved read-only init --ws beta does not displace the alpha carry (both baselines stay accepted)', (t) => {
    setupCarry(t, ISSUE_CONFIG, 'sess-ws');
    const beta = path.join(project, '.planning', 'workstreams', 'beta');
    fs.mkdirSync(beta, { recursive: true });
    fs.writeFileSync(path.join(beta, 'config.json'), JSON.stringify({ model_overrides: { 'gsd-planner': 'sonnet' } }));
    writeConfig(project, JSON.stringify({ ...ISSUE_CONFIG, hooks: { agent_model_guard: 'deny' } }));
    assert.ok(initQuick('sess-ws').success);
    assert.ok(runGsdTools(['query', 'init.quick', 't', '--ws=beta'], project, { ...PINNED, GSD_WORKSTREAM: '', CLAUDE_CODE_SESSION_ID: 'sess-ws' }).success);
    assert.deepEqual(carryStore().peekInitWorkstream(project, 'sess-ws', PIN), ['alpha', 'beta']);
    assert.equal(evaluate(inSession('haiku', 'sess-ws')).action, 'allow', 'the alpha executor dispatch still passes');
    assert.equal(evaluate(inSession('sonnet', 'sess-ws')).action, 'allow');
    const v = evaluate(inSession('gpt-9', 'sess-ws'));
    assert.equal(v.action, 'block');
    assert.equal(v.expected, 'haiku or sonnet or opus', 'the verdict names the root baseline too');
  });

  test('init --ws records no carry where the guard does not apply (another runtime, or the guard off)', (t) => {
    const off = [{ ...ISSUE_CONFIG, runtime: 'codex' }, { ...ISSUE_CONFIG, hooks: { agent_model_guard: false } }];
    for (const config of [ISSUE_CONFIG, ...off]) {
      setupCarry(t, config, 'sess-ws');
      assert.ok(initQuick('sess-ws').success);
      const carry = carryStore().peekInitWorkstream(project, 'sess-ws', PIN);
      assert.deepEqual(carry, config === ISSUE_CONFIG ? ['alpha'] : null, `${JSON.stringify(config.hooks || config.runtime)}`);
    }
  });

  test('every init where the guard applies sweeps carry files older than the prune window: P-1 stays, P and P+1 go; the guard off sweeps nothing', (t) => {
    const P = carryStore().INIT_WORKSTREAM_PRUNE_AGE_MS;
    const sessions = ['sw-minus', 'sw-at', 'sw-plus'];
    for (const config of [ISSUE_CONFIG, { ...ISSUE_CONFIG, hooks: { agent_model_guard: false } }, { ...ISSUE_CONFIG, runtime: 'codex' }]) {
      setupCarry(t, config, 'sess-ws', ...sessions);
      const adapter = (s) => carryStore().createSessionScopedPointerAdapter(project, `${carryStore().INIT_WORKSTREAM_KEY_PREFIX}${s}`);
      adapter('sw-minus').write(`alpha ${PIN - P + 1}`);
      adapter('sw-at').write(`alpha ${PIN - P}`);
      adapter('sw-plus').write(`alpha ${PIN - P - 1}`);
      assert.ok(initQuick('sess-ws', false).success);
      const kept = sessions.filter((s) => adapter(s).read() !== null);
      assert.deepEqual(kept, config === ISSUE_CONFIG ? ['sw-minus'] : sessions, JSON.stringify(config.hooks || config.runtime));
      // a flagged init with no session id records nothing but sweeps all the same
      adapter('sw-at').write(`alpha ${PIN - P}`);
      adapter('sw-plus').write(`alpha ${PIN - P - 1}`);
      assert.ok(runGsdTools(['query', 'init.quick', 't', '--ws=alpha'], project, { ...PINNED, GSD_WORKSTREAM: '', CLAUDE_CODE_SESSION_ID: '' }).success);
      assert.deepEqual(sessions.filter((s) => adapter(s).read() !== null), config === ISSUE_CONFIG ? ['sw-minus'] : sessions, `flagged, no session: ${JSON.stringify(config.hooks || config.runtime)}`);
    }
  });

  test('resolve-execution writes no escalation record where the guard does not apply (a runtime without native tier aliases)', (t) => {
    setup(t, { ...ISSUE_CONFIG, runtime: 'codex' });
    const r = runGsdTools(['resolve-execution', 'gsd-executor', '--attempt', '1'], project, { ...PINNED, GSD_RUNTIME: '' });
    assert.ok(r.success, r.error);
    assert.equal(fs.existsSync(path.join(project, '.gsd')), false);
  });

  test('init --ws without a session id records nothing and leaves the init output unchanged', (t) => {
    const run = (session) => runNode([TOOLS_PATH, 'query', 'init.quick', 't', '--ws=alpha'],
      { cwd: project, env: { ...process.env, ...PINNED, GSD_WORKSTREAM: '', CLAUDE_CODE_SESSION_ID: session }, timeoutMs: PROBE_TIMEOUT_MS });
    setupCarry(t, ISSUE_CONFIG, 'sess-ws');
    const bare = run('');
    assert.equal(bare.exitCode, 0, bare.stderr);
    const withSession = run('sess-ws');
    assert.equal(withSession.exitCode, 0, withSession.stderr);
    assert.deepEqual(JSON.parse(bare.stdout), JSON.parse(withSession.stdout));
    assert.deepEqual(carryStore().peekInitWorkstream(project, 'sess-ws', PIN), ['alpha']);
    for (const config of [{ ...ISSUE_CONFIG, runtime: 'codex' }, { ...ISSUE_CONFIG, hooks: { agent_model_guard: false } }]) {
      setupCarry(t, config);
      const quiet = run('');
      assert.equal(quiet.exitCode, 0, quiet.stderr);
    }
  });

  test('both .gsd/.gitignore writers: the dispatch sentinel and the escalation record are git-ignored whichever writes first', (t) => {
    for (const order of [['sentinel', 'escalation'], ['escalation', 'sentinel']]) {
      for (const pre of [null, '# user\n/notes\n', '*\n', '']) {
        setup(t);
        if (pre !== null) {
          fs.mkdirSync(path.join(project, '.gsd'), { recursive: true });
          fs.writeFileSync(path.join(project, '.gsd', '.gitignore'), pre);
        }
        for (const w of order) {
          const r = w === 'sentinel'
            ? runGsdTools(['record-dispatch-isolation', '--isolation', 'harness-worktree'], project)
            : runGsdTools(['resolve-execution', 'gsd-executor', '--attempt', '1'], project, PINNED);
          assert.ok(r.success, `${w}: ${r.error}`);
        }
        for (const f of ['dispatch-isolation-sentinel.json', 'model-escalation-gsd-executor.json', '.gitignore', '.gitignore.tmp-1-ab']) {
          if (!f.startsWith('.gitignore')) assert.equal(fs.existsSync(path.join(project, '.gsd', f)), true, f);
          const ci = runGit(['check-ignore', '-q', path.join('.gsd', f)], { cwd: project, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
          assert.equal(ci.exitCode, 0, `${order.join(' then ')}, pre ${JSON.stringify(pre)}: ${f} is ignored`);
        }
      }
    }
  });

  test('both .gsd writers refuse a symlinked .gsd and a symlinked .gsd/.gitignore through the one owner (ensureToolOwnedGsdDir)', { skip: WIN32 }, (t) => {
    const outside = createTempDir('gsd-aig-parity-');
    t.after(() => cleanup(outside));
    const target = path.join(outside, 'target.txt');
    const writers = {
      sentinel: { file: 'dispatch-isolation-sentinel.json', run: () => runGsdTools(['record-dispatch-isolation', '--isolation', 'harness-worktree'], project) },
      escalation: { file: 'model-escalation-gsd-executor.json', run: () => runGsdTools(['resolve-execution', 'gsd-executor', '--attempt', '1'], project, PINNED) },
    };
    for (const w of Object.values(writers)) {
      setup(t);
      fs.symlinkSync(outside, path.join(project, '.gsd'));
      w.run();
      assert.equal(fs.existsSync(path.join(outside, w.file)), false, `.gsd symlink: ${w.file}`);
      setup(t);
      fs.writeFileSync(target, 'unchanged\n');
      fs.mkdirSync(path.join(project, '.gsd'));
      fs.symlinkSync(target, path.join(project, '.gsd', '.gitignore'));
      w.run();
      assert.equal(fs.readFileSync(target, 'utf8'), 'unchanged\n', `.gitignore symlink: ${w.file}`);
    }
  });

  test('a guard that is off: resolve-execution writes nothing and the hook allows; warn writes the record', (t) => {
    setup(t, { ...ISSUE_CONFIG, hooks: { agent_model_guard: false } });
    const r = runGsdTools(['resolve-execution', 'gsd-executor', '--attempt', '1'], project, PINNED);
    assert.ok(r.success, r.error);
    assert.equal(JSON.parse(r.output).model, 'opus');
    assert.equal(fs.existsSync(path.join(project, '.gsd')), false);
    assert.equal(evaluate(dispatch('gsd-executor', 'opus', WORKTREE)).action, 'allow');
    writeConfig(project, JSON.stringify({ ...ISSUE_CONFIG, hooks: { agent_model_guard: 'warn' } }));
    assert.ok(runGsdTools(['resolve-execution', 'gsd-executor', '--attempt', '1'], project, PINNED).success);
    assert.equal(fs.existsSync(escalationFile(project, 'gsd-executor')), true);
  });

  test('--project-dir naming another project records nothing; escalationRoot equals the hook\'s resolveSentinelRoot', (t) => {
    setup(t);
    const other = mkProject('gsd-aig-other-');
    t.after(() => cleanup(other));
    writeConfig(other, JSON.stringify(ISSUE_CONFIG));
    const r = runGsdTools(['resolve-execution', 'gsd-executor', '--attempt', '1', '--project-dir', other], project, PINNED);
    assert.ok(r.success, r.error);
    assert.equal(fs.existsSync(escalationFile(other, 'gsd-executor')), false, 'the hook in this session never reads there');
    assert.equal(fs.existsSync(escalationFile(project, 'gsd-executor')), false, 'the escalation was resolved for the other project');
    const { escalationRoot } = require('../gsd-core/bin/lib/model-escalation.cjs');
    const { resolveSentinelRoot } = require('../hooks/lib/isolation-sentinel.js');
    const sub = path.join(project, 'sub');
    fs.mkdirSync(sub);
    for (const dir of [project, sub, other]) assert.equal(escalationRoot(dir), resolveSentinelRoot(dir), dir);
  });

  test('one model-id charset: the CLI and the hook both read MODEL_ID_CHARSET_BODY from model-escalation, the hook adding [ and ]', (t) => {
    setup(t);
    const { MODEL_ID_CHARSET_BODY } = require('../gsd-core/bin/lib/model-escalation.cjs');
    const cli = require('../gsd-core/bin/gsd-tools.cjs');
    assert.equal(cli.MODEL_ID_CHARSET_BODY, MODEL_ID_CHARSET_BODY, 'gsd-tools reads the owner');
    for (let c = 0x20; c < 0x7f; c++) {
      const ch = String.fromCharCode(c);
      const keep = !cli.MODEL_ID_SANITIZE_STRIP_RE.test(ch) || ch === '[' || ch === ']';
      assert.equal(dispatchVerdict(`x${ch}`).passed, `x${keep ? ch : '?'}`, JSON.stringify(ch));
    }
  });

  test('a mismatch verdict carries its structured fields', (t) => {
    setup(t);
    const v = evaluate(dispatch('gsd-planner', 'sonnet'));
    assert.equal(v.action, 'warn');
    assert.equal(v.reasonCode, REASON_CODE.AGENT_MODEL_MISMATCH);
    assert.equal(v.passed, 'sonnet');
    assert.equal(v.expected, 'opus');
  });

  test('resolve-execution from a linked git worktree records at the root the hook reads', (t) => {
    setup(t);
    const parent = createTempDir('gsd-aig-linked-');
    t.after(() => cleanup(parent));
    const wt = path.join(parent, 'wt');
    const add = runGit(['worktree', 'add', '--detach', wt], { cwd: project, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
    assert.equal(add.exitCode, 0, add.stderr);
    cleanup(path.join(wt, '.planning')); // force the worktree-root remap branch (no-op when .planning is untracked)
    const r = runGsdTools(['resolve-execution', 'gsd-executor', '--attempt', '1'], wt, PINNED);
    assert.ok(r.success, r.error);
    assert.equal(fs.existsSync(escalationFile(project, 'gsd-executor')), true);
    assert.equal(evaluate({ ...dispatch('gsd-executor', 'opus', WORKTREE), cwd: wt }, atPin).action, 'allow');
  });

  test('one baseline resolution: for every guarded agent the hook expects exactly what resolve-model reports', (t) => {
    setup(t);
    for (const agent of require('../gsd-core/bin/lib/model-escalation.cjs').GUARDED_AGENT_TYPES) {
      const r = runGsdTools(['resolve-model', agent], project);
      assert.ok(r.success, r.error);
      const w = evaluate(dispatch(agent, 'claude-haiku-4-5', agent === 'gsd-executor' ? WORKTREE : {}));
      assert.equal(w.action, 'warn', agent);
      assert.equal(w.expected, JSON.parse(r.output).model, agent);
    }
  });

  test('a runtime without native tier aliases is skipped by the hook', (t) => {
    setup(t, { ...ISSUE_CONFIG, runtime: 'codex' });
    assert.equal(evaluate(dispatch('gsd-planner', 'sonnet')).action, 'allow');
  });

  test('hook process: warn exits 0 with additionalContext; deny exits 2', (t) => {
    setup(t);
    const w = runHook(dispatch('gsd-planner', 'sonnet'), project);
    assert.equal(w.status, 0, w.stderr);
    const out = JSON.parse(w.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(typeof out.hookSpecificOutput.additionalContext, 'string');
    writeConfig(project, JSON.stringify({ ...ISSUE_CONFIG, hooks: { agent_model_guard: 'deny' } }));
    const d = runHook(dispatch('gsd-planner', 'sonnet'), project);
    assert.equal(d.status, 2);
    assert.equal(JSON.parse(d.stdout).reason_code, REASON_CODE.AGENT_MODEL_MISMATCH);
  });
});
