'use strict';

/**
 * #6213: `query dispatch-isolation --phase <p> --plan <id>` derives the executor it records from
 * the plan's own `agent_hint` (the parser `phase-plan-index` uses) under the same resolution
 * `resolve-agent` applies. The recorder must not depend on a value a workflow carried across
 * Bash tool calls (shell state does not survive between them), so it takes no executor flag.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runGsdTools, createTempProject, createTempGitProject, homeSandboxEnv, cleanup, TOOLS_PATH } = require('./helpers.cjs');
const { PROBE_TIMEOUT_MS, GIT_FIXTURE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { runNode, runGit, formatSeamResult, OUTCOME } = require('./helpers/process-seam.cjs');
const { SENTINEL_RELATIVE_PATH, SENTINEL_MAX_BYTES, readSentinel } = require('../hooks/lib/isolation-sentinel.js');
const { REASON_CODE } = require('../hooks/lib/isolation-deny-reason.js');
const guard = require('../hooks/gsd-agent-isolation-guard.js');
const cursor = require('../hooks/gsd-cursor-subagent-start.js');

const HINTED = 'acme-rails-executor';
const WRITTEN_AT = 1_000_000;
const fresh = { now: () => WRITTEN_AT + 1000 };
const FLAG_ARG = { isolation: 'worktree' };
const PHASE = '02';
// Carries no canonical marker, so a dispatch is classified an executor dispatch only by the record.
const PLAIN_PROMPT = 'Execute the plan.';

describe('#6213 dispatch-isolation derives the recorded executor from the plan', () => {
  let root;
  let agentsDir;
  let env;

  before(() => {
    root = createTempProject('gsd-derived-exec-');
    agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-derived-exec-agents-'));
    for (const name of [HINTED, 'gsd-verifier', 'gsd-executor']) {
      fs.writeFileSync(path.join(agentsDir, `${name}.md`), `---\nname: ${name}\n---\nbody\n`);
    }
    env = { ...homeSandboxEnv(root), GSD_AGENTS_DIR: agentsDir, GSD_NOW_MS: String(WRITTEN_AT) };
    fs.mkdirSync(path.join(root, '.planning', 'phases', '02-api'), { recursive: true });
  });
  // The tests share one fixture, and one of them records a forced `none`: a caller's decision that a later
  // plain query at the same scope holds for ten minutes instead of overwriting (#4561). Each test reads the
  // record its own query writes, so each starts from no record.
  beforeEach(() => {
    cleanup(path.join(root, SENTINEL_RELATIVE_PATH));
    cleanup(path.join(root, '.gsd', 'dispatch-isolation'));
  });
  after(() => { cleanup(root); cleanup(agentsDir); });

  function setConfig(config) {
    fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify({ runtime: 'claude', ...config }));
  }

  function writePlan(planNumber, hintLine) {
    const frontmatter = [
      '---',
      'phase: 02-api',
      `plan: ${planNumber}`,
      'type: execute',
      'wave: 1',
      'depends_on: []',
      'files_modified: [a.txt]',
      'autonomous: true',
      ...(hintLine === null ? [] : [hintLine]),
      '---',
      '',
    ].join('\n');
    const body = '<objective>\nDo it\n</objective>\n\n<tasks>\n<task type="auto"><name>t</name><action>x</action><done>y</done></task>\n</tasks>\n';
    fs.writeFileSync(path.join(root, '.planning', 'phases', '02-api', `02-${planNumber}-PLAN.md`), frontmatter + body);
  }

  function recordedFor(planId, extraArgs = []) {
    const r = runGsdTools(['dispatch-isolation', '--raw', '--phase', PHASE, '--plan', planId, ...extraArgs], root, env);
    assert.ok(r.success, r.error);
    return JSON.parse(fs.readFileSync(path.join(root, SENTINEL_RELATIVE_PATH), 'utf-8')).executor_type;
  }

  function resolveAgent(name) {
    const r = runGsdTools(['resolve-agent', '--name', name, '--raw'], root, env);
    assert.ok(r.success, r.error);
    return r.output;
  }

  test('an installed hinted executor is recorded, with no executor flag', () => {
    setConfig({});
    writePlan('01', `agent_hint: ${HINTED}`);
    assert.strictEqual(recordedFor('02-01'), HINTED);
  });

  test('--force-isolation none still records the plan\'s hinted executor', () => {
    setConfig({});
    writePlan('01', `agent_hint: ${HINTED}`);
    assert.strictEqual(recordedFor('02-01', ['--force-isolation', 'none']), HINTED);
  });

  test('workflow.agent_hint_routing false or the string "false" records gsd-executor; true or "true" keeps the hint', () => {
    writePlan('01', `agent_hint: ${HINTED}`);
    setConfig({ workflow: { agent_hint_routing: false } });
    assert.strictEqual(recordedFor('02-01'), 'gsd-executor');
    setConfig({ workflow: { agent_hint_routing: 'false' } });
    assert.strictEqual(recordedFor('02-01'), 'gsd-executor', 'the string "false" turns routing off');
    setConfig({ workflow: { agent_hint_routing: ' False ' } });
    assert.strictEqual(recordedFor('02-01'), 'gsd-executor', 'trimmed, case-insensitive');
    setConfig({ workflow: { agent_hint_routing: 'true' } });
    assert.strictEqual(recordedFor('02-01'), HINTED);
    setConfig({ workflow: { agent_hint_routing: true } });
    assert.strictEqual(recordedFor('02-01'), HINTED);
  });

  test('a hint naming a GSD non-executor role records gsd-executor, whatever its case', () => {
    setConfig({});
    for (const hint of ['gsd-verifier', 'GSD-Verifier', '"gsd-verifier"']) {
      writePlan('01', `agent_hint: ${hint}`);
      assert.strictEqual(recordedFor('02-01'), 'gsd-executor', hint);
    }
  });

  test('a hint that names no installed agent records gsd-executor', () => {
    setConfig({});
    writePlan('01', 'agent_hint: no-such-agent-6213');
    assert.strictEqual(recordedFor('02-01'), 'gsd-executor');
  });

  test('a plan with no hint, an unknown plan id, an unknown phase, and a missing --plan record gsd-executor', () => {
    setConfig({});
    writePlan('01', null);
    assert.strictEqual(recordedFor('02-01'), 'gsd-executor', 'no hint');
    writePlan('01', `agent_hint: ${HINTED}`);
    assert.strictEqual(recordedFor('02-99'), 'gsd-executor', 'unknown plan id');
    const unknownPhase = runGsdTools(['dispatch-isolation', '--raw', '--phase', '77', '--plan', '02-01'], root, env);
    assert.ok(unknownPhase.success, unknownPhase.error);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, SENTINEL_RELATIVE_PATH), 'utf-8')).executor_type, 'gsd-executor', 'unknown phase');
    const noPlan = runGsdTools(['dispatch-isolation', '--raw', '--phase', PHASE], root, env);
    assert.ok(noPlan.success, noPlan.error);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, SENTINEL_RELATIVE_PATH), 'utf-8')).executor_type, 'gsd-executor', 'no --plan');
  });

  test('parity: with routing on, the recorded executor equals what resolve-agent prints for the same hint', () => {
    setConfig({});
    for (const hint of [HINTED, 'gsd-verifier', 'GSD-Verifier', 'gsd-executor', 'no-such-agent-6213']) {
      writePlan('01', `agent_hint: ${hint}`);
      assert.strictEqual(recordedFor('02-01'), resolveAgent(hint), hint);
    }
  });

  test('end to end: the CLI-written record makes the guard block the hinted Agent() without the flag', () => {
    setConfig({});
    writePlan('01', `agent_hint: ${HINTED}`);
    assert.strictEqual(recordedFor('02-01'), HINTED);
    // PLAIN_PROMPT carries no marker, so the block below proves the record-based classification.
    const decide = (subagentType, extra = {}) => guard.evaluateDispatch({
      tool_name: 'Agent',
      cwd: root,
      tool_input: { subagent_type: subagentType, prompt: PLAIN_PROMPT, ...extra },
    }, { clock: fresh });

    assert.strictEqual(decide(HINTED).action, 'block', 'hinted executor without the flag');
    assert.strictEqual(decide(HINTED, FLAG_ARG).action, 'allow', 'hinted executor with the flag');
    const decideTexted = (subagentType, text) => guard.evaluateDispatch({
      tool_name: 'Agent', cwd: root, tool_input: { subagent_type: subagentType, prompt: text },
    }, { clock: fresh });
    assert.strictEqual(decideTexted('gsd-verifier', PLAIN_PROMPT).action, 'allow', 'a non-executor without the marker is not guarded');
  });

  test('end to end: a hint that resolved to gsd-executor leaves the hinted name unguarded unless the dispatch carries the marker', () => {
    // Earlier tests leave phase-level records naming HINTED in this shared project; the classification scan reads every recent record.
    cleanup(path.join(root, '.gsd'));
    setConfig({ workflow: { agent_hint_routing: false } });
    writePlan('01', `agent_hint: ${HINTED}`);
    assert.strictEqual(recordedFor('02-01'), 'gsd-executor');
    const dispatch = (prompt) => guard.evaluateDispatch({
      tool_name: 'Agent', cwd: root, tool_input: { subagent_type: HINTED, prompt },
    }, { clock: fresh }).action;
    assert.strictEqual(dispatch(PLAIN_PROMPT), 'allow', 'no marker, record names gsd-executor');
    assert.strictEqual(dispatch(`[gsd:dispatch phase="${PHASE}" plan="02-01"] Execute plan 01 of phase ${PHASE}.`), 'block', 'the canonical marker makes it an executor dispatch');
  });
});

describe('#6213 a phase-level record, and a plan given without its phase, still name the hinted executor', () => {
  const OTHER = 'acme-go-executor';
  const MARKER = `[gsd:dispatch phase="${PHASE}" plan="02-01"] Execute plan 01 of phase ${PHASE}.`;
  let root;
  let agentsDir;
  let env;

  before(() => {
    root = createTempGitProject('gsd-phase-level-exec-');
    // This branch re-derives the #683 base-check degrade on a query with no --plan (#4222): a git fixture
    // with no fork base reads `fork-ref-unknown` and records `none`. Give it a fork base at HEAD, so the
    // phase-level records stay on the natural capability these tests are about.
    const forkBase = runGit(['update-ref', 'refs/remotes/origin/HEAD', 'HEAD'], { cwd: root, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
    assert.equal(forkBase.exitCode, 0, forkBase.stderr);
    agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-phase-level-exec-agents-'));
    for (const name of [HINTED, OTHER, 'gsd-verifier', 'gsd-executor']) {
      fs.writeFileSync(path.join(agentsDir, `${name}.md`), `---\nname: ${name}\n---\nbody\n`);
    }
    env = { ...homeSandboxEnv(root), GSD_AGENTS_DIR: agentsDir, GSD_NOW_MS: String(WRITTEN_AT) };
    setConfig({});
  });
  after(() => { cleanup(root); cleanup(agentsDir); });

  function setConfig(config) {
    fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify({ runtime: 'claude', ...config }));
  }

  function resetPhases() {
    cleanup(path.join(root, '.planning', 'phases'));
    fs.mkdirSync(path.join(root, '.planning', 'phases', '02-api'), { recursive: true });
  }

  function writePlanIn(slug, phaseNumber, planNumber, hint) {
    const frontmatter = [
      '---', `phase: ${slug}`, `plan: ${planNumber}`, 'type: execute', 'wave: 1', 'depends_on: []',
      'files_modified: [a.txt]', 'autonomous: true', ...(hint === null ? [] : [`agent_hint: ${hint}`]), '---', '',
    ].join('\n');
    const body = '<objective>\nDo it\n</objective>\n\n<tasks>\n<task type="auto"><name>t</name><action>x</action><done>y</done></task>\n</tasks>\n';
    const dir = path.join(root, '.planning', 'phases', slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${phaseNumber}-${planNumber}-PLAN.md`), frontmatter + body);
  }

  function record(args) {
    const r = runGsdTools(['dispatch-isolation', '--raw', ...args], root, env);
    assert.ok(r.success, r.error);
    return JSON.parse(fs.readFileSync(path.join(root, SENTINEL_RELATIVE_PATH), 'utf-8'));
  }

  function resolveAgent(args) {
    const r = runGsdTools(['resolve-agent', ...args, '--raw'], root, env);
    assert.ok(r.success, r.error);
    return r.output;
  }

  test('the phase-level record lists the sorted, de-duplicated routed executors other than gsd-executor', () => {
    resetPhases();
    writePlanIn('02-api', '02', '01', HINTED);
    writePlanIn('02-api', '02', '02', 'gsd-verifier');
    writePlanIn('02-api', '02', '03', null);
    writePlanIn('02-api', '02', '04', OTHER);
    writePlanIn('02-api', '02', '05', HINTED);
    writePlanIn('02-api', '02', '06', 'no-such-agent-6213');
    const body = record(['--phase', PHASE]);
    assert.strictEqual(body.plan, null);
    assert.strictEqual(body.executor_type, 'gsd-executor');
    assert.deepStrictEqual(body.executor_types, [OTHER, HINTED].sort());
    assert.ok(!('executor_types_truncated' in body), 'a list that fits carries no truncation flag');
  });

  test('a plan-scoped record carries executor_type and no executor_types list', () => {
    const body = record(['--phase', PHASE, '--plan', '02-01']);
    assert.strictEqual(body.executor_type, HINTED);
    assert.ok(!('executor_types' in body));
  });

  test('end to end: the CLI-written phase-level record blocks the hinted Agent() without the flag and allows it with the flag', () => {
    const body = record(['--phase', PHASE]);
    assert.strictEqual(body.isolation, 'harness-worktree');
    // Seed the plan-scoped record by hand AFTER the phase-level write, with the same written_at, so
    // the tie is really exercised: the plan-scoped record (no executor_types) must not hide OTHER.
    const planScoped = path.join(root, '.gsd', 'dispatch-isolation', `${PHASE}--02-01.json`);
    fs.writeFileSync(planScoped, JSON.stringify({
      isolation: body.isolation, harness_flag: body.harness_flag, phase: PHASE, plan: '02-01',
      executor_type: HINTED, written_at: body.written_at,
    }));
    assert.ok(fs.existsSync(planScoped), 'the tying plan-scoped record is present before the guards run');
    assert.strictEqual(JSON.parse(fs.readFileSync(planScoped, 'utf-8')).written_at, body.written_at, 'a real written_at tie');
    const decide = (subagentType, extra = {}, prompt = PLAIN_PROMPT) => guard.evaluateDispatch({
      tool_name: 'Agent', cwd: root, tool_input: { subagent_type: subagentType, prompt, ...extra },
    }, { clock: fresh });
    const blocked = decide(HINTED);
    assert.strictEqual(blocked.action, 'block', 'hinted executor without the flag');
    assert.strictEqual(blocked.reasonCode, REASON_CODE.HARNESS_FLAG_MISSING);
    assert.strictEqual(decide(OTHER).action, 'block', 'every listed executor is guarded');
    assert.strictEqual(decide(HINTED, FLAG_ARG).action, 'allow', 'hinted executor with the flag');
    assert.strictEqual(decide('gsd-executor').action, 'block', 'gsd-executor stays guarded');
    assert.strictEqual(decide('gsd-verifier').action, 'allow', 'a non-executor without the marker is not guarded');
    assert.strictEqual(decide(OTHER, {}, MARKER).action, 'block', 'marker-bearing dispatch');
    const cursorDecide = (subagentType, task = PLAIN_PROMPT) => cursor.resolveIsolationDecision({
      subagent_type: subagentType, task, workspace_roots: [root],
    }, { clock: fresh }).action;
    assert.strictEqual(cursorDecide(HINTED), 'deny', 'cursor hook');
    assert.strictEqual(cursorDecide(OTHER), 'deny', 'cursor hook, every listed executor');
    assert.strictEqual(cursorDecide('gsd-verifier'), 'allow', 'cursor hook, non-executor');
  });

  test('routing strictly off leaves the phase-level list empty', () => {
    setConfig({ workflow: { agent_hint_routing: false } });
    try {
      assert.deepStrictEqual(record(['--phase', PHASE]).executor_types, []);
    } finally {
      setConfig({});
    }
  });

  test('a plan given without --phase records the plan\'s hinted executor', () => {
    const body = record(['--plan', '02-01']);
    assert.strictEqual(body.phase, null);
    assert.strictEqual(body.plan, '02-01');
    assert.strictEqual(body.executor_type, HINTED);
    const decision = guard.evaluateDispatch({
      tool_name: 'Agent', cwd: root, tool_input: { subagent_type: HINTED, prompt: MARKER },
    }, { clock: fresh });
    assert.strictEqual(decision.action, 'block');
  });

  test('a plan id carried by two phases, and one carried by none, record gsd-executor when --phase is absent', () => {
    writePlanIn('03-ui', '02', '01', HINTED);
    assert.strictEqual(record(['--plan', '02-01']).executor_type, 'gsd-executor', 'ambiguous plan id');
    assert.strictEqual(record(['--plan', '02-99']).executor_type, 'gsd-executor', 'unknown plan id');
    cleanup(path.join(root, '.planning', 'phases', '03-ui'));
    assert.strictEqual(record(['--plan', '02-01']).executor_type, HINTED, 'unique again once the duplicate is gone');
  });

  test('a record with neither --phase nor --plan names the hinted executors of every milestone phase, and the guard blocks them', () => {
    resetPhases();
    writePlanIn('02-api', '02', '01', HINTED);
    writePlanIn('03-ui', '03', '01', OTHER);
    writePlanIn('03-ui', '03', '02', 'gsd-verifier');
    writePlanIn('03-ui', '03', '03', null);
    const body = record([]);
    assert.strictEqual(body.phase, null);
    assert.strictEqual(body.plan, null);
    assert.strictEqual(body.executor_type, 'gsd-executor');
    assert.deepStrictEqual(body.executor_types, [OTHER, HINTED].sort());
    assert.ok(!('executor_types_truncated' in body));
    const decide = (subagentType, extra = {}) => guard.evaluateDispatch({
      tool_name: 'Agent', cwd: root, tool_input: { subagent_type: subagentType, prompt: PLAIN_PROMPT, ...extra },
    }, { clock: fresh });
    assert.strictEqual(decide(HINTED).action, 'block', 'hinted executor without the flag');
    assert.strictEqual(decide(OTHER).action, 'block', 'a hinted executor of another phase, without the flag');
    assert.strictEqual(decide(HINTED, FLAG_ARG).action, 'allow', 'with the flag');
    assert.strictEqual(decide('gsd-verifier').action, 'allow', 'a non-executor is not guarded');
    setConfig({ workflow: { agent_hint_routing: false } });
    try {
      assert.deepStrictEqual(record([]).executor_types, [], 'routing strictly off');
    } finally {
      setConfig({});
    }
    resetPhases();
    writePlanIn('02-api', '02', '01', HINTED);
  });

  test('parity: resolve-agent --phase --plan equals the recorded executor, with and without --phase', () => {
    for (const config of [{}, { workflow: { agent_hint_routing: false } }]) {
      setConfig(config);
      for (const hint of [HINTED, OTHER, 'gsd-verifier', 'GSD-Verifier', 'gsd-executor', 'no-such-agent-6213', null]) {
        resetPhases();
        writePlanIn('02-api', '02', '01', hint);
        const label = `${JSON.stringify(hint)} ${JSON.stringify(config)}`;
        assert.strictEqual(resolveAgent(['--phase', PHASE, '--plan', '02-01']), record(['--phase', PHASE, '--plan', '02-01']).executor_type, label);
        assert.strictEqual(resolveAgent(['--plan', '02-01']), record(['--plan', '02-01']).executor_type, `no phase ${label}`);
      }
    }
    setConfig({});
  });

  test('resolve-agent --name keeps resolving the named agent regardless of any plan', () => {
    assert.strictEqual(resolveAgent(['--name', HINTED, '--plan', '02-99']), HINTED);
    assert.strictEqual(resolveAgent(['--name', 'no-such-agent-6213']), 'gsd-executor');
  });
});

describe('#6213 an executor_types list that cannot fit the record is truncated visibly', () => {
  const COUNT = 40;
  const nn = (i) => String(i + 1).padStart(2, '0');
  const agentName = (i) => `acme-${nn(i)}-`.padEnd(128, 'x');
  const planOf = (name) => `02-${name.slice(5, 7)}`;
  let root;
  let agentsDir;
  let env;

  before(() => {
    root = createTempGitProject('gsd-phase-level-trunc-');
    // This branch re-derives the #683 base-check degrade on a query with no --plan (#4222): a git fixture
    // with no fork base reads `fork-ref-unknown` and records `none`. Give it a fork base at HEAD, so the
    // phase-level records stay on the natural capability these tests are about.
    const forkBase = runGit(['update-ref', 'refs/remotes/origin/HEAD', 'HEAD'], { cwd: root, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
    assert.equal(forkBase.exitCode, 0, forkBase.stderr);
    agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-phase-level-trunc-agents-'));
    fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify({ runtime: 'claude' }));
    const phaseDir = path.join(root, '.planning', 'phases', '02-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    for (let i = 0; i < COUNT; i += 1) {
      const name = agentName(i);
      assert.strictEqual(name.length, 128);
      fs.writeFileSync(path.join(agentsDir, `${name}.md`), `---\nname: ${name}\n---\nbody\n`);
      const frontmatter = `---\nphase: 02-api\nplan: ${nn(i)}\ntype: execute\nwave: 1\ndepends_on: []\nfiles_modified: [a.txt]\nautonomous: true\nagent_hint: ${name}\n---\n`;
      const body = '<objective>\nDo it\n</objective>\n\n<tasks>\n<task type="auto"><name>t</name><action>x</action><done>y</done></task>\n</tasks>\n';
      fs.writeFileSync(path.join(phaseDir, `02-${nn(i)}-PLAN.md`), frontmatter + body);
    }
    env = { ...process.env, ...homeSandboxEnv(root), GSD_TEST_MODE: '1', GSD_AGENTS_DIR: agentsDir, GSD_NOW_MS: String(WRITTEN_AT) };
  });
  after(() => { cleanup(root); cleanup(agentsDir); });

  function dispatch(args) {
    const r = runNode([TOOLS_PATH, 'dispatch-isolation', '--raw', ...args], { cwd: root, env, timeoutMs: PROBE_TIMEOUT_MS });
    assert.strictEqual(r.outcome, OUTCOME.EXITED, formatSeamResult(r));
    assert.strictEqual(r.exitCode, 0, r.stderr);
    return r;
  }

  const decide = (subagentType, plan) => guard.evaluateDispatch({
    tool_name: 'Agent',
    cwd: root,
    tool_input: { subagent_type: subagentType, prompt: `[gsd:dispatch phase="${PHASE}" plan="${plan}"] Execute plan of phase ${PHASE}.` },
  }, { clock: fresh });

  test('the record parses within SENTINEL_MAX_BYTES, flags the truncation, and the warning names every dropped executor', () => {
    const r = dispatch(['--phase', PHASE]);
    assert.strictEqual(r.stdout, 'harness-worktree', 'stdout contract is unchanged');
    const file = path.join(root, SENTINEL_RELATIVE_PATH);
    assert.ok(fs.statSync(file).size <= SENTINEL_MAX_BYTES, `record is ${fs.statSync(file).size} bytes`);
    const body = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.strictEqual(body.executor_types_truncated, true);

    const read = readSentinel(root, { clock: fresh });
    assert.strictEqual(read.malformed, false);
    const kept = read.executorTypes;
    const all = Array.from({ length: COUNT }, (_, i) => agentName(i)).sort();
    assert.ok(kept.length > 0 && kept.length < COUNT, `kept ${kept.length} of ${COUNT}`);
    assert.deepStrictEqual(kept, all.slice(0, kept.length), 'the kept names are a prefix of the sorted list');

    const named = all.slice(kept.length);
    for (const name of named) assert.ok(r.stderr.includes(name), `stderr names the dropped executor ${name}: ${r.stderr}`);

    assert.strictEqual(decide(kept[0], planOf(kept[0])).action, 'block', 'first kept name is guarded');
    assert.strictEqual(decide(kept[kept.length - 1], planOf(kept[kept.length - 1])).action, 'block', 'last kept name is guarded');
    assert.strictEqual(decide(named[0], planOf(named[0])).action, 'block', 'a dropped name is guarded when the dispatch carries the canonical marker');
    const noMarker = (subagentType) => guard.evaluateDispatch({
      tool_name: 'Agent', cwd: root, tool_input: { subagent_type: subagentType, prompt: 'Execute the plan.' },
    }, { clock: fresh });
    assert.strictEqual(noMarker(named[0]).action, 'block', 'the same dropped name without a marker is guarded: the truncated record cannot rule it out');
    assert.strictEqual(noMarker(kept[0]).action, 'block', 'a kept name is guarded whatever the dispatch carries');
  });

  test('--json reports executor_types_truncated', () => {
    const r = runNode([TOOLS_PATH, 'dispatch-isolation', '--json', '--phase', PHASE], { cwd: root, env, timeoutMs: PROBE_TIMEOUT_MS });
    assert.strictEqual(r.outcome, OUTCOME.EXITED, formatSeamResult(r));
    assert.strictEqual(r.exitCode, 0, r.stderr);
    assert.strictEqual(JSON.parse(r.stdout).executor_types_truncated, true);
  });

  test('a plan-scoped record for a dropped plan still names its executor and guards it', () => {
    dispatch(['--phase', PHASE]);
    const kept = readSentinel(root, { clock: fresh }).executorTypes;
    const dropped = Array.from({ length: COUNT }, (_, i) => agentName(i)).sort().slice(kept.length)[0];
    const plan = planOf(dropped);
    const r = dispatch(['--phase', PHASE, '--plan', plan]);
    assert.strictEqual(r.stderr, '', 'a plan-scoped record never warns');
    const body = JSON.parse(fs.readFileSync(path.join(root, SENTINEL_RELATIVE_PATH), 'utf-8'));
    assert.strictEqual(body.executor_type, dropped);
    assert.ok(!('executor_types' in body) && !('executor_types_truncated' in body));
    assert.strictEqual(decide(dropped, plan).action, 'block');
  });
});

describe('#6213 the routing block prints only an executor name the record can carry', () => {
  const UNRECORDABLE = ['_acme-exec', '.acme', 'acme exec', `a${'b'.repeat(128)}`];
  let root;
  let agentsDir;
  let env;

  before(() => {
    root = createTempGitProject('gsd-unrecordable-exec-');
    agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-unrecordable-exec-agents-'));
    for (const name of [...UNRECORDABLE, 'gsd-executor']) {
      fs.writeFileSync(path.join(agentsDir, `${name}.md`), `---\nname: ${name}\n---\nbody\n`);
    }
    fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify({ runtime: 'claude' }));
    fs.mkdirSync(path.join(root, '.planning', 'phases', '02-api'), { recursive: true });
    env = { ...process.env, ...homeSandboxEnv(root), GSD_TEST_MODE: '1', GSD_AGENTS_DIR: agentsDir, GSD_NOW_MS: String(WRITTEN_AT) };
  });
  after(() => { cleanup(root); cleanup(agentsDir); });

  function tools(args) {
    const r = runNode([TOOLS_PATH, ...args], { cwd: root, env, timeoutMs: PROBE_TIMEOUT_MS });
    assert.strictEqual(r.outcome, OUTCOME.EXITED, formatSeamResult(r));
    assert.strictEqual(r.exitCode, 0, r.stderr);
    return r.stdout.trim();
  }

  function writePlan(hint) {
    const frontmatter = `---\nphase: 02-api\nplan: 01\ntype: execute\nwave: 1\ndepends_on: []\nfiles_modified: [a.txt]\nautonomous: true\nagent_hint: "${hint}"\n---\n`;
    const body = '<objective>\nDo it\n</objective>\n\n<tasks>\n<task type="auto"><name>t</name><action>x</action><done>y</done></task>\n</tasks>\n';
    fs.writeFileSync(path.join(root, '.planning', 'phases', '02-api', '02-01-PLAN.md'), frontmatter + body);
  }

  test('an installed agent whose name fails the executor grammar resolves to gsd-executor by --name, by --plan and in the record', () => {
    for (const name of UNRECORDABLE) {
      const label = `${name.slice(0, 20)} (${name.length} chars)`;
      writePlan(name);
      assert.strictEqual(tools(['resolve-agent', '--name', name, '--raw']), 'gsd-executor', `--name ${label}`);
      const byName = JSON.parse(tools(['resolve-agent', '--name', name, '--json']));
      assert.strictEqual(byName.fallback, true, `--name fallback ${label}`);
      assert.ok(!('refused' in byName), `--name no refusal ${label}`);
      assert.strictEqual(tools(['resolve-agent', '--phase', PHASE, '--plan', '02-01', '--raw']), 'gsd-executor', `--plan ${label}`);
      tools(['dispatch-isolation', '--raw', '--phase', PHASE, '--plan', '02-01']);
      const body = JSON.parse(fs.readFileSync(path.join(root, SENTINEL_RELATIVE_PATH), 'utf-8'));
      assert.strictEqual(body.executor_type, 'gsd-executor', `record ${label}`);
      tools(['dispatch-isolation', '--raw', '--phase', PHASE]);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, SENTINEL_RELATIVE_PATH), 'utf-8')).executor_types, [], `phase-level record ${label}`);
    }
  });
});

describe('#6213 the executor_types byte budget and entry cap (limit-1 / limit / limit+1)', () => {
  const nn = (i) => String(i + 1).padStart(2, '0');
  const ENTRY_MIN = 8; // `acme-NN-`
  let root;
  let agentsDir;
  let env;
  let baseBytes;

  before(() => {
    root = createTempGitProject('gsd-budget-exec-');
    agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-budget-exec-agents-'));
    fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify({ runtime: 'claude' }));
    env = { ...process.env, ...homeSandboxEnv(root), GSD_TEST_MODE: '1', GSD_AGENTS_DIR: agentsDir, GSD_NOW_MS: String(WRITTEN_AT) };
    fs.mkdirSync(path.join(root, '.planning', 'phases', '02-api'), { recursive: true });
    baseBytes = dispatch().size;
  });
  after(() => { cleanup(root); cleanup(agentsDir); });

  function dispatch() {
    const r = runNode([TOOLS_PATH, 'dispatch-isolation', '--raw', '--phase', PHASE], { cwd: root, env, timeoutMs: PROBE_TIMEOUT_MS });
    assert.strictEqual(r.outcome, OUTCOME.EXITED, formatSeamResult(r));
    assert.strictEqual(r.exitCode, 0, r.stderr);
    const file = path.join(root, SENTINEL_RELATIVE_PATH);
    return { size: fs.statSync(file).size, body: JSON.parse(fs.readFileSync(file, 'utf-8')), stderr: r.stderr };
  }

  /** Install one hinted agent and plan per name, replacing every earlier one. */
  function install(names) {
    cleanup(agentsDir);
    fs.mkdirSync(agentsDir, { recursive: true });
    const phaseDir = path.join(root, '.planning', 'phases', '02-api');
    cleanup(phaseDir);
    fs.mkdirSync(phaseDir, { recursive: true });
    names.forEach((name, i) => {
      fs.writeFileSync(path.join(agentsDir, `${name}.md`), `---\nname: ${name}\n---\nbody\n`);
      const frontmatter = `---\nphase: 02-api\nplan: ${nn(i)}\ntype: execute\nwave: 1\ndepends_on: []\nfiles_modified: [a.txt]\nautonomous: true\nagent_hint: ${name}\n---\n`;
      const body = '<objective>\nDo it\n</objective>\n\n<tasks>\n<task type="auto"><name>t</name><action>x</action><done>y</done></task>\n</tasks>\n';
      fs.writeFileSync(path.join(phaseDir, `02-${nn(i)}-PLAN.md`), frontmatter + body);
    });
  }

  /**
   * Names (each `acme-NN-` then `x` padding, 8..128 chars) whose record serializes to exactly `target` bytes:
   * the record with `n` entries is `baseBytes + sum(len + 2) + (n - 1)` (the empty list's `[]` stays).
   */
  function namesForRecordBytes(target) {
    const n = Math.ceil((target - baseBytes + 1) / 131);
    let cut = 131 * n - (target - baseBytes + 1);
    const lengths = Array(n).fill(128);
    for (let i = n - 1; i >= 0 && cut > 0; i -= 1) {
      const take = Math.min(cut, 128 - ENTRY_MIN);
      lengths[i] -= take;
      cut -= take;
    }
    assert.strictEqual(cut, 0, 'the target is reachable');
    return lengths.map((len, i) => `acme-${nn(i)}-`.padEnd(len, 'x'));
  }

  test('a record of exactly SENTINEL_MAX_BYTES keeps every name and carries no truncation flag', () => {
    const names = namesForRecordBytes(SENTINEL_MAX_BYTES);
    install(names);
    const { size, body, stderr } = dispatch();
    assert.strictEqual(size, SENTINEL_MAX_BYTES);
    assert.deepStrictEqual(body.executor_types, [...names].sort());
    assert.ok(!('executor_types_truncated' in body));
    assert.strictEqual(stderr, '');
    const read = readSentinel(root, { clock: fresh });
    assert.strictEqual(read.malformed, false, 'the reader accepts a record of exactly the limit');
    assert.strictEqual(read.executorTypes.length, names.length);
    assert.strictEqual(read.executorTypesTruncated, false);
  });

  test('a record that would be SENTINEL_MAX_BYTES + 1 is truncated, flagged, and the kept prefix is maximal', () => {
    const names = namesForRecordBytes(SENTINEL_MAX_BYTES + 1);
    install(names);
    const sorted = [...names].sort();
    const { size, body, stderr } = dispatch();
    assert.strictEqual(body.executor_types_truncated, true);
    assert.ok(size <= SENTINEL_MAX_BYTES, `record is ${size} bytes`);
    const kept = body.executor_types;
    assert.ok(kept.length > 0 && kept.length < names.length, `kept ${kept.length} of ${names.length}`);
    assert.deepStrictEqual(kept, sorted.slice(0, kept.length), 'the kept names are a prefix of the sorted list');
    const withNext = JSON.stringify({ ...body, executor_types: [...kept, sorted[kept.length]] });
    assert.ok(Buffer.byteLength(withNext) > SENTINEL_MAX_BYTES, 'keeping one more name would exceed the limit');
    for (const name of sorted.slice(kept.length)) assert.ok(stderr.includes(name), `stderr names the dropped executor ${name}: ${stderr}`);
    assert.strictEqual(readSentinel(root, { clock: fresh }).executorTypesTruncated, true);
  });

  test('a record of SENTINEL_MAX_BYTES - 1 keeps every name, carries no truncation flag and warns of nothing', () => {
    const names = namesForRecordBytes(SENTINEL_MAX_BYTES - 1);
    install(names);
    const { size, body, stderr } = dispatch();
    assert.strictEqual(size, SENTINEL_MAX_BYTES - 1);
    assert.deepStrictEqual(body.executor_types, [...names].sort());
    assert.ok(!('executor_types_truncated' in body));
    assert.strictEqual(stderr, '');
  });

  test('63, 64 and 65 distinct hinted agents in a phase record 63, 64 and 64 names; only the 65th is flagged and named', () => {
    const all = Array.from({ length: 65 }, (_, i) => `acme-${nn(i)}`);
    for (const [count, kept] of [[63, 63], [64, 64], [65, 64]]) {
      install(all.slice(0, count));
      const { body, stderr } = dispatch();
      assert.strictEqual(body.executor_types.length, kept, `count ${count}`);
      assert.deepStrictEqual(body.executor_types, all.slice(0, kept), `count ${count}`);
      if (count <= 64) {
        assert.ok(!('executor_types_truncated' in body), `count ${count}`);
        assert.strictEqual(stderr, '', `count ${count}`);
      } else {
        assert.strictEqual(body.executor_types_truncated, true, `count ${count}`);
        assert.ok(stderr.includes(all[64]), `stderr names the dropped executor ${all[64]} (count ${count}): ${stderr}`);
      }
    }
  });
});
