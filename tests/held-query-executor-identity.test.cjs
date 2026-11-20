'use strict';

/**
 * #4904 (review 2026-11-17, option (c), ADR-4630): a plain `dispatch-isolation` query that HOLDS a caller's
 * `none` writes no decision record. It writes the executor identity it derives for its own scope to a record
 * of its own under `.gsd/dispatch-isolation-identity/`, which the guards' classification (`isExecutorDispatch`)
 * reads beside the decision records. Without it, a flag-less specialist dispatch that `next` blocks with
 * `harness_flag_missing` is allowed while the hold lasts (cases 1, 2, 4, 5 and 6 of the review).
 *
 * Every case runs the real guard (`evaluateDispatch`) on a dispatch for a phase no record applies to, with no
 * canonical marker, so only the executor types the recent records name decide whether it is guarded. Times
 * come from GSD_NOW_MS and the guard's clock seam, never the wall clock.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fc = require('./helpers/fast-check-setup.cjs');
const {
  runGsdTools, createTempGitProject, createTempDir, homeSandboxEnv, cleanup, TOOLS_PATH, isolateGitConfigEnv, readFileNormalized,
} = require('./helpers.cjs');
const { runNode, runHook, runGit } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const sentinel = require('../hooks/lib/isolation-sentinel.js');
const executorType = require('../gsd-core/bin/lib/executor-type.cjs');
const { REASON_CODE } = require('../hooks/lib/isolation-deny-reason.js');
const guard = require('../hooks/gsd-agent-isolation-guard.js');
const { span } = require('./helpers/doc-bash-span.cjs');
const { skipUnless } = require('./helpers/bash-probe.cjs');

const {
  SENTINEL_RELATIVE_PATH, KEYED_SENTINEL_DIR, IDENTITY_RECORD_DIR, IDENTITY_MAX_EXECUTOR_TYPES,
  IDENTITY_RECORD_MAX_BYTES, IDENTITY_RECORD_SCHEMA, SENTINEL_MAX_BYTES, MAX_EXECUTOR_TYPES, CLOCK_SKEW_MS, AGED_NONE_MAX_MS,
  identityRecordName, readSentinel, isExecutorDispatch,
} = sentinel;

const HINTED = 'acme-rails-executor';
const OTHER = 'acme-ui-executor';
const WRITTEN_AT = 1_000_000;
const LATER = WRITTEN_AT + 60_000; // one minute into the ten-minute hold
const clock = { now: () => LATER };
// A dispatch for a phase no record carries, with no canonical marker.
const promptFor = (phase) => `Execute plan 01 of phase ${phase}.`;

describe('#4904 writer/reader parity for the executor-identity record', () => {
  test('the hook mirrors the owner\'s directory, cap, byte budget and schema', () => {
    assert.equal(IDENTITY_RECORD_DIR, path.join('.gsd', executorType.EXECUTOR_IDENTITY_DIR));
    assert.equal(IDENTITY_MAX_EXECUTOR_TYPES, executorType.MAX_EXECUTOR_TYPES);
    assert.equal(IDENTITY_RECORD_MAX_BYTES, executorType.EXECUTOR_IDENTITY_MAX_BYTES);
    assert.equal(IDENTITY_RECORD_SCHEMA, executorType.EXECUTOR_IDENTITY_SCHEMA);
  });

  test('the cap and budget are the decision record\'s', () => {
    assert.equal(IDENTITY_MAX_EXECUTOR_TYPES, MAX_EXECUTOR_TYPES);
    assert.equal(IDENTITY_RECORD_MAX_BYTES, SENTINEL_MAX_BYTES);
  });

  test('the directory is a sibling of the keyed decision directory, never inside it', () => {
    assert.equal(path.dirname(IDENTITY_RECORD_DIR), path.dirname(KEYED_SENTINEL_DIR));
    assert.notEqual(IDENTITY_RECORD_DIR, KEYED_SENTINEL_DIR);
  });

  test('scope file names are distinct per scope and refuse unsafe keys', () => {
    assert.equal(identityRecordName(null, null), 'all.json');
    assert.equal(identityRecordName('02', null), 'phase+02.json');
    assert.equal(identityRecordName('02', '02-01'), 'plan+02+02-01.json');
    assert.equal(identityRecordName(null, '02-01'), 'plan++02-01.json');
    // `--` is legal inside a key, so a `<phase>--<plan>` name would be ambiguous; `+` is not.
    assert.notEqual(identityRecordName('a--b', 'c'), identityRecordName('a', 'b--c'));
    assert.equal(identityRecordName('../x', null), null);
    assert.equal(identityRecordName('02', 'a/b'), null);
  });
});

describe('#4904 a held query keeps the guards\' executor classification current', () => {
  let root;
  let agentsDir;
  const envAt = (now) => ({ ...homeSandboxEnv(root), GSD_TEST_MODE: '1', GSD_AGENTS_DIR: agentsDir, GSD_NOW_MS: String(now) });

  before(() => {
    // A git repository with a commit: on a root with no HEAD the guard's registry fallback degrades to `none`
    // (#4734), and these dispatches must reach the fallback's `harness_flag_missing`.
    root = createTempGitProject('gsd-4904-identity-');
    agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4904-identity-agents-'));
    for (const name of [HINTED, OTHER, 'gsd-executor']) {
      fs.writeFileSync(path.join(agentsDir, `${name}.md`), `---\nname: ${name}\n---\nbody\n`);
    }
  });
  beforeEach(() => {
    cleanup(path.join(root, '.gsd'));
    cleanup(path.join(root, '.planning', 'phases'));
    setRouting(true);
  });
  after(() => { cleanup(root); cleanup(agentsDir); });

  function setRouting(on) {
    fs.writeFileSync(path.join(root, '.planning', 'config.json'),
      JSON.stringify({ runtime: 'claude', ...(on ? {} : { workflow: { agent_hint_routing: false } }) }));
  }
  function writePlan(phaseDir, phase, planNumber, hint) {
    const dir = path.join(root, '.planning', 'phases', phaseDir);
    fs.mkdirSync(dir, { recursive: true });
    const fm = ['---', `phase: ${phaseDir}`, `plan: ${planNumber}`, 'type: execute', 'wave: 1', 'depends_on: []',
      'files_modified: [a.txt]', 'autonomous: true', ...(hint ? [`agent_hint: ${hint}`] : []), '---', ''].join('\n');
    fs.writeFileSync(path.join(dir, `${phase}-${planNumber}-PLAN.md`),
      `${fm}<objective>\nDo it\n</objective>\n\n<tasks>\n<task type="auto"><name>t</name><action>x</action><done>y</done></task>\n</tasks>\n`);
  }
  function gsd(args, now) {
    const r = runGsdTools(args, root, envAt(now));
    assert.ok(r.success, r.error);
    return r.output;
  }
  const heldQuery = (scopeArgs) => {
    const answer = JSON.parse(gsd(['dispatch-isolation', '--json', ...scopeArgs], LATER));
    assert.equal(answer.held, true, 'precondition: the plain query holds the caller\'s none');
    assert.equal(answer.isolation, 'none');
    return answer;
  };
  const decide = (subagentType, phase) => guard.evaluateDispatch({
    tool_name: 'Agent', cwd: root, tool_input: { subagent_type: subagentType, prompt: promptFor(phase) },
  }, { clock });
  // Every decision record the query must not touch: the legacy slot and the keyed directory, by bytes.
  function decisionBytes() {
    const out = { legacy: fs.readFileSync(path.join(root, SENTINEL_RELATIVE_PATH), 'utf8') };
    const keyed = path.join(root, KEYED_SENTINEL_DIR);
    // An unsafe scope has no keyed record, so the directory can be absent.
    if (!fs.existsSync(keyed)) return out;
    for (const name of fs.readdirSync(keyed).sort()) out[name] = fs.readFileSync(path.join(keyed, name), 'utf8');
    return out;
  }
  function assertGuarded(subagentType, phase) {
    const d = decide(subagentType, phase);
    assert.equal(d.action, 'block', `${subagentType} for phase ${phase} must be guarded`);
    assert.equal(d.reasonCode, REASON_CODE.HARNESS_FLAG_MISSING);
  }
  // `git check-ignore -q` answers 0 (ignored) or 1 (not ignored); anything else is a failed probe, never an answer.
  function ignoredByGit(rel) {
    const r = runGit(['check-ignore', '-q', rel], { cwd: root, timeoutMs: PROBE_TIMEOUT_MS });
    assert.ok(r.exitCode === 0 || r.exitCode === 1, `git check-ignore ${rel}: exit ${r.exitCode} ${r.stderr}`);
    return r.exitCode === 0;
  }
  // Every file under `.gsd` gets the mtime `ms`, so the recency reads judge it against a GSD_NOW_MS clock.
  function setGsdMtimes(ms) {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else fs.utimesSync(full, ms / 1000, ms / 1000);
      }
    };
    walk(path.join(root, '.gsd'));
  }

  test('case 1: the routed executor changes within the hold (routing switched on)', () => {
    writePlan('02-api', '02', '01', HINTED);
    setRouting(false);
    gsd(['dispatch-isolation', '--raw', '--phase', '02', '--plan', '02-01', '--force-isolation', 'none'], WRITTEN_AT);
    setRouting(true);
    assert.equal(decide(HINTED, '03').action, 'allow', 'precondition: no record names the routed executor yet');
    const before = decisionBytes();
    heldQuery(['--phase', '02', '--plan', '02-01']);
    assert.deepEqual(decisionBytes(), before, 'the held query touches no decision record');
    assertGuarded(HINTED, '03');
  });

  test('case 2: a phase query holding one plan\'s record records the other plans\' executors', () => {
    writePlan('02-api', '02', '01', HINTED);
    writePlan('02-api', '02', '02', OTHER);
    gsd(['dispatch-isolation', '--raw', '--phase', '02', '--plan', '02-01', '--force-isolation', 'none'], WRITTEN_AT);
    assert.equal(decide(OTHER, '03').action, 'allow', 'precondition: plan B\'s executor is not recorded');
    const before = decisionBytes();
    heldQuery(['--phase', '02']);
    assert.deepEqual(decisionBytes(), before, 'the held query touches no decision record');
    assertGuarded(OTHER, '03');
    assertGuarded(HINTED, '03');
  });

  test('case 4: an unscoped query holding a plan-scoped record records every phase\'s executors', () => {
    writePlan('02-api', '02', '01', HINTED);
    writePlan('03-ui', '03', '01', OTHER);
    gsd(['dispatch-isolation', '--raw', '--phase', '02', '--plan', '02-01', '--force-isolation', 'none'], WRITTEN_AT);
    assert.equal(decide(OTHER, '04').action, 'allow', 'precondition: phase 03\'s executor is not recorded');
    const before = decisionBytes();
    heldQuery([]);
    assert.deepEqual(decisionBytes(), before, 'the held query touches no decision record');
    assertGuarded(OTHER, '04');
  });

  test('case 5: a plan created during the hold is recorded by the next held query', () => {
    gsd(['dispatch-isolation', '--raw', '--phase', '02', '--force-isolation', 'none'], WRITTEN_AT);
    writePlan('02-api', '02', '01', OTHER);
    assert.equal(decide(OTHER, '03').action, 'allow', 'precondition: the new plan\'s executor is not recorded');
    heldQuery(['--phase', '02']);
    assertGuarded(OTHER, '03');
  });

  test('case 5: an agent_hint edited during the hold is recorded by the next held query', () => {
    writePlan('02-api', '02', '01', HINTED);
    gsd(['dispatch-isolation', '--raw', '--phase', '02', '--plan', '02-01', '--force-isolation', 'none'], WRITTEN_AT);
    writePlan('02-api', '02', '01', OTHER);
    assert.equal(decide(OTHER, '03').action, 'allow', 'precondition: the edited hint is not recorded');
    heldQuery(['--phase', '02', '--plan', '02-01']);
    assertGuarded(OTHER, '03');
  });

  test('case 6: record-dispatch-isolation without --executor-type is refilled by the next held query', () => {
    writePlan('02-api', '02', '01', HINTED);
    gsd(['record-dispatch-isolation', '--isolation', 'none', '--phase', '02', '--plan', '02-01'], WRITTEN_AT);
    const keyed = JSON.parse(fs.readFileSync(path.join(root, KEYED_SENTINEL_DIR, '02--02-01.json'), 'utf8'));
    assert.equal(keyed.executor_type, null, 'precondition: no executor recorded');
    assert.equal(decide(HINTED, '03').action, 'allow', 'precondition');
    heldQuery(['--phase', '02', '--plan', '02-01']);
    assertGuarded(HINTED, '03');
  });

  // A held query whose identity record cannot be written still holds and writes no decision record (the
  // 11-17 ruling, option (c)). The guards' reader sees the state that stopped the write and fails executor
  // classification closed, so the specialist below is guarded although no record names it.
  function plainJson(scopeArgs, now) {
    const r = runNode([TOOLS_PATH, 'dispatch-isolation', '--json', ...scopeArgs],
      { cwd: root, env: { ...process.env, ...envAt(now) }, timeoutMs: PROBE_TIMEOUT_MS });
    assert.equal(r.exitCode, 0, r.stderr);
    return { answer: JSON.parse(r.stdout), stderr: r.stderr };
  }

  test('a phase that is not a safe key: the query holds, writes no decision, and classification fails closed', () => {
    gsd(['dispatch-isolation', '--raw', '--phase', '2 ', '--force-isolation', 'none'], WRITTEN_AT);
    writePlan('02-api', '02', '01', OTHER);
    const before = decisionBytes();
    const { answer, stderr } = plainJson(['--phase', '2 '], LATER);
    assert.equal(answer.held, true, 'the caller\'s none stands');
    assert.equal(answer.isolation, 'none');
    assert.match(stderr, /could not record executor identity for a held decision; the decision stands unchanged/);
    assert.deepEqual(decisionBytes(), before, 'the held query touches no decision record');
    assert.equal(fs.existsSync(path.join(root, IDENTITY_RECORD_DIR)), false, 'an unsafe scope has no identity record');
    assertGuarded(OTHER, '03');
  });

  test('a directory at the scope\'s identity file name: the query holds, writes no decision, and classification fails closed', () => {
    writePlan('02-api', '02', '01', HINTED);
    writePlan('02-api', '02', '02', OTHER);
    gsd(['dispatch-isolation', '--raw', '--phase', '02', '--plan', '02-01', '--force-isolation', 'none'], WRITTEN_AT);
    fs.mkdirSync(path.join(root, IDENTITY_RECORD_DIR, 'phase+02.json'), { recursive: true });
    const before = decisionBytes();
    const { answer, stderr } = plainJson(['--phase', '02'], LATER);
    assert.equal(answer.held, true);
    assert.match(stderr, /could not record executor identity/);
    assert.deepEqual(decisionBytes(), before, 'the held query touches no decision record');
    assertGuarded(OTHER, '03');
  });

  test('an unheld query removes its scope\'s identity record, so a stale snapshot does not outlive the hold', () => {
    writePlan('02-api', '02', '01', HINTED);
    gsd(['dispatch-isolation', '--raw', '--phase', '02', '--force-isolation', 'none'], WRITTEN_AT);
    heldQuery(['--phase', '02']);
    const file = path.join(root, IDENTITY_RECORD_DIR, 'phase+02.json');
    assert.ok(fs.existsSync(file), 'precondition: the held query recorded the scope');
    setRouting(false);
    const AFTER_HOLD = WRITTEN_AT + 11 * 60 * 1000;
    assert.equal(plainJson(['--phase', '02'], AFTER_HOLD).answer.held, false, 'the hold has lapsed');
    assert.equal(fs.existsSync(file), false, 'the unheld write removed the scope\'s identity record');
    // As on `next`: routing is off and every current record is rewritten, so the specialist is not classified.
    const d = guard.evaluateDispatch({
      tool_name: 'Agent', cwd: root, tool_input: { subagent_type: HINTED, prompt: promptFor('03') },
    }, { clock: { now: () => AFTER_HOLD } });
    assert.equal(d.action, 'allow');
  });

  test('record-dispatch-isolation for a scope removes that scope\'s identity record too', () => {
    writePlan('02-api', '02', '01', HINTED);
    gsd(['dispatch-isolation', '--raw', '--phase', '02', '--force-isolation', 'none'], WRITTEN_AT);
    heldQuery(['--phase', '02']);
    const file = path.join(root, IDENTITY_RECORD_DIR, 'phase+02.json');
    assert.ok(fs.existsSync(file), 'precondition');
    gsd(['record-dispatch-isolation', '--isolation', 'harness-worktree', '--phase', '02'], LATER + 1000);
    assert.equal(fs.existsSync(file), false);
  });

  test('an unheld query writes no identity record; a held one writes exactly its own scope\'s', () => {
    writePlan('02-api', '02', '01', HINTED);
    gsd(['dispatch-isolation', '--raw', '--phase', '02', '--plan', '02-01'], WRITTEN_AT);
    assert.equal(fs.existsSync(path.join(root, IDENTITY_RECORD_DIR)), false, 'an unheld write records identity in the decision record');
    gsd(['dispatch-isolation', '--raw', '--phase', '02', '--plan', '02-01', '--force-isolation', 'none'], WRITTEN_AT);
    heldQuery(['--phase', '02', '--plan', '02-01']);
    assert.deepEqual(fs.readdirSync(path.join(root, IDENTITY_RECORD_DIR)), ['plan+02+02-01.json']);
    const body = JSON.parse(fs.readFileSync(path.join(root, IDENTITY_RECORD_DIR, 'plan+02+02-01.json'), 'utf8'));
    assert.deepEqual(body, {
      schema: 1, phase: '02', plan: '02-01', executor_type: HINTED, executor_types: [],
      executor_types_truncated: false, written_at: LATER,
    });
  });

  test('git ignores the held query\'s identity record (fresh .gsd)', (t) => {
    t.after(isolateGitConfigEnv());
    writePlan('02-api', '02', '01', HINTED);
    gsd(['dispatch-isolation', '--raw', '--phase', '02', '--plan', '02-01', '--force-isolation', 'none'], WRITTEN_AT);
    heldQuery(['--phase', '02', '--plan', '02-01']);
    assert.ok(fs.existsSync(path.join(root, IDENTITY_RECORD_DIR, 'plan+02+02-01.json')), 'precondition');
    assert.equal(ignoredByGit('.gsd/dispatch-isolation-identity/plan+02+02-01.json'), true);
  });

  test('a .gsd/.gitignore written before the identity directory existed gains its rule, so the record is ignored', (t) => {
    t.after(isolateGitConfigEnv());
    writePlan('02-api', '02', '01', HINTED);
    // The block an install without the identity directory seeded: every dispatch-sentinel rule but its own.
    fs.mkdirSync(path.join(root, '.gsd'), { recursive: true });
    fs.writeFileSync(path.join(root, '.gsd', '.gitignore'), ['# gsd-core dispatch sentinel', '/dispatch-isolation-sentinel.json',
      '/dispatch-isolation-sentinel.json.tmp-*', '/dispatch-isolation/', '/.gitignore', ''].join('\n'));
    // Control: git ignores only what the rules name, so the answer below is the rule's and not a global ignore's.
    fs.writeFileSync(path.join(root, '.gsd', 'untracked-control.txt'), 'x');
    t.after(() => cleanup(path.join(root, '.gsd', 'untracked-control.txt')));
    assert.equal(ignoredByGit('.gsd/untracked-control.txt'), false, 'control: .gsd is not ignored wholesale');
    gsd(['dispatch-isolation', '--raw', '--phase', '02', '--plan', '02-01', '--force-isolation', 'none'], WRITTEN_AT);
    heldQuery(['--phase', '02', '--plan', '02-01']);
    assert.ok(fs.existsSync(path.join(root, IDENTITY_RECORD_DIR, 'plan+02+02-01.json')), 'precondition');
    assert.ok(readFileNormalized(path.join(root, '.gsd', '.gitignore')).includes('\n/dispatch-isolation-identity/\n'),
      'the identity directory\'s rule was appended');
    assert.equal(ignoredByGit('.gsd/dispatch-isolation-identity/plan+02+02-01.json'), true);
    // The unscoped held query reads the legacy slot whatever scope it carries, and records `all.json`.
    heldQuery([]);
    assert.ok(fs.existsSync(path.join(root, IDENTITY_RECORD_DIR, 'all.json')), 'precondition');
    assert.equal(ignoredByGit('.gsd/dispatch-isolation-identity/all.json'), true);
  });

  test('a held query prunes other scopes\' identity records past the 24-hour window and keeps the rest', () => {
    // A GSD_NOW_MS clock whose window holds the planted mtimes; fs.utimesSync cannot set a time before 1970.
    const NOW = 2_000_000_000_000;
    writePlan('02-api', '02', '01', HINTED);
    gsd(['dispatch-isolation', '--raw', '--phase', '02', '--force-isolation', 'none'], NOW - 60_000);
    setGsdMtimes(NOW - 60_000);
    const dir = path.join(root, IDENTITY_RECORD_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const plantAt = (name, phase, mtimeMs) => {
      const { record } = executorType.buildExecutorIdentityRecord({ phase, plan: null }, null, [OTHER], NOW - 60_000);
      fs.writeFileSync(path.join(dir, name), JSON.stringify(record));
      fs.utimesSync(path.join(dir, name), mtimeMs / 1000, mtimeMs / 1000);
    };
    plantAt('phase+05.json', '05', NOW - AGED_NONE_MAX_MS - 60_000);
    plantAt('phase+06.json', '06', NOW - 1000);
    plantAt('phase+07.json.tmp-1-abcdef', '07', NOW - AGED_NONE_MAX_MS - 60_000);
    const answer = JSON.parse(gsd(['dispatch-isolation', '--json', '--phase', '02'], NOW));
    assert.equal(answer.held, true, 'precondition: the query holds');
    const left = fs.readdirSync(dir).sort();
    assert.ok(!left.includes('phase+05.json'), 'an aged record of another scope is pruned');
    assert.ok(!left.includes('phase+07.json.tmp-1-abcdef'), 'an aged leftover temp file is pruned');
    assert.ok(left.includes('phase+06.json'), 'a fresh record of another scope stays');
    // The own scope's file has the real write time, older than this clock's window, so only the own-scope skip keeps it.
    assert.ok(left.includes('phase+02.json'), 'the query\'s own record stays');
  });

  test('an empty derivation replaces the scope\'s record; the decision record still names what it named', () => {
    writePlan('02-api', '02', '01', HINTED);
    gsd(['dispatch-isolation', '--raw', '--phase', '02', '--force-isolation', 'none'], WRITTEN_AT);
    heldQuery(['--phase', '02']);
    const file = path.join(root, IDENTITY_RECORD_DIR, 'phase+02.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).executor_types, [HINTED]);
    setRouting(false);
    heldQuery(['--phase', '02']);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).executor_types, [], 'routing off: the snapshot is empty');
    // The phase-level decision written at WRITTEN_AT named HINTED; the reader takes the union, so it stays guarded.
    assertGuarded(HINTED, '03');
  });

  test('held --json keeps executor_types_truncated and the warning when the identity list is cut', (t) => {
    const extra = [];
    t.after(() => { for (const f of extra) cleanup(f); });
    for (let i = 0; i < IDENTITY_MAX_EXECUTOR_TYPES + 1; i += 1) {
      const name = `acme-${String(i).padStart(3, '0')}-executor`;
      extra.push(path.join(agentsDir, `${name}.md`));
      fs.writeFileSync(extra[extra.length - 1], `---\nname: ${name}\n---\nbody\n`);
      writePlan('02-api', '02', String(i + 1).padStart(2, '0'), name);
    }
    gsd(['dispatch-isolation', '--raw', '--phase', '02', '--plan', '02-01', '--force-isolation', 'none'], WRITTEN_AT);
    // The seam, not runGsdTools: the warning is on stderr, which runGsdTools drops on success.
    const r = runNode([TOOLS_PATH, 'dispatch-isolation', '--json', '--phase', '02'],
      { cwd: root, env: { ...process.env, ...envAt(LATER) }, timeoutMs: PROBE_TIMEOUT_MS });
    assert.equal(r.exitCode, 0, r.stderr);
    const answer = JSON.parse(r.stdout);
    assert.equal(answer.held, true);
    assert.equal(answer.executor_types_truncated, true);
    assert.match(r.stderr, /executor_types capped at 64 names/);
    const body = JSON.parse(fs.readFileSync(path.join(root, IDENTITY_RECORD_DIR, 'phase+02.json'), 'utf8'));
    assert.equal(body.executor_types.length, IDENTITY_MAX_EXECUTOR_TYPES);
    assert.equal(body.executor_types_truncated, true);
    // Truncated: every valid non-role name is classified an executor (fail closed).
    assertGuarded('some-unlisted-agent', '03');
  });
});

describe('#4904 identity record boundaries (writer)', () => {
  const build = (names) => executorType.buildExecutorIdentityRecord({ phase: '02', plan: null }, null, names, WRITTEN_AT);
  const namesOf = (n) => Array.from({ length: n }, (_, i) => `x-${String(i).padStart(3, '0')}`);

  for (const [n, truncated] of [[IDENTITY_MAX_EXECUTOR_TYPES - 1, false], [IDENTITY_MAX_EXECUTOR_TYPES, false], [IDENTITY_MAX_EXECUTOR_TYPES + 1, true]]) {
    test(`${n} names: ${truncated ? 'the 65th is dropped and the record says so' : 'all recorded, not truncated'}`, () => {
      const { record, dropped } = build(namesOf(n));
      assert.equal(record.executor_types.length, Math.min(n, IDENTITY_MAX_EXECUTOR_TYPES));
      assert.equal(record.executor_types_truncated, truncated);
      assert.deepEqual(dropped, truncated ? [namesOf(n)[n - 1]] : []);
    });
  }

  // Names whose untruncated record serializes to exactly `bytes`: 120-character names up to near the budget,
  // then one last name whose length makes up the difference (at most 128 characters, so it stays valid).
  function namesForBytes(bytes) {
    const size = (list) => Buffer.byteLength(JSON.stringify({
      schema: 1, phase: '02', plan: null, executor_type: null, executor_types: list, executor_types_truncated: false, written_at: WRITTEN_AT,
    }));
    const names = [];
    while (size([...names, `n${String(names.length).padStart(2, '0')}-${'a'.repeat(116)}`, 'z']) < bytes) {
      names.push(`n${String(names.length).padStart(2, '0')}-${'a'.repeat(116)}`);
    }
    const last = `z${'b'.repeat(Math.max(0, bytes - size([...names, 'z'])))}`;
    names.push(last);
    assert.equal(size(names), bytes, 'fixture arithmetic');
    assert.ok(executorType.isValidExecutorType(last), 'the tuned name stays valid');
    assert.ok(names.length <= IDENTITY_MAX_EXECUTOR_TYPES, 'under the name cap, so only the byte budget can cut');
    return names;
  }

  for (const [bytes, truncated] of [[IDENTITY_RECORD_MAX_BYTES - 1, false], [IDENTITY_RECORD_MAX_BYTES, false], [IDENTITY_RECORD_MAX_BYTES + 1, true]]) {
    test(`a record of ${bytes} bytes is ${truncated ? 'cut to fit, last name first' : 'written whole'}`, () => {
      const names = namesForBytes(bytes);
      const { record, dropped } = build(names);
      assert.equal(record.executor_types_truncated, truncated);
      assert.deepEqual(dropped, truncated ? [names[names.length - 1]] : []);
      assert.ok(Buffer.byteLength(JSON.stringify(record)) <= IDENTITY_RECORD_MAX_BYTES);
    });
  }
});

describe('#4904 identity record reader: boundaries and hostile files fail closed', () => {
  let root;
  const dir = () => path.join(root, IDENTITY_RECORD_DIR);
  const valid = (overrides = {}) => ({
    schema: 1, phase: '02', plan: null, executor_type: null, executor_types: [HINTED],
    executor_types_truncated: false, written_at: WRITTEN_AT, ...overrides,
  });
  const plant = (name, text) => {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(path.join(dir(), name), text);
  };
  const read = () => readSentinel(root, { clock, subagentType: 'some-agent', dispatchIds: { phase: '03', plan: null } });
  const classifies = (type) => isExecutorDispatch(type, read(), { phase: '03', plan: null }, { clock });

  before(() => {
    root = createTempDir('gsd-4904-identity-read-');
    fs.mkdirSync(path.join(root, '.planning'));
  });
  beforeEach(() => cleanup(path.join(root, '.gsd')));
  after(() => cleanup(root));

  test('control: a well-formed record names its executor and nothing else', () => {
    plant('phase+02.json', JSON.stringify(valid()));
    assert.equal(read().scanOverflow, undefined);
    assert.equal(classifies(HINTED), true);
    assert.equal(classifies(OTHER), false);
  });

  for (const [bytes, accepted] of [[IDENTITY_RECORD_MAX_BYTES - 1, true], [IDENTITY_RECORD_MAX_BYTES, true], [IDENTITY_RECORD_MAX_BYTES + 1, false]]) {
    test(`a ${bytes}-byte record is ${accepted ? 'read' : 'refused, and classification fails closed'}`, () => {
      const json = JSON.stringify(valid());
      plant('phase+02.json', json + ' '.repeat(bytes - Buffer.byteLength(json)));
      assert.equal(fs.statSync(path.join(dir(), 'phase+02.json')).size, bytes);
      assert.equal(read().scanOverflow, accepted ? undefined : true);
      assert.equal(classifies(OTHER), !accepted, 'an unlisted valid name is an executor only when the scan cannot rule it out');
    });
  }

  for (const [n, truncated] of [[IDENTITY_MAX_EXECUTOR_TYPES - 1, false], [IDENTITY_MAX_EXECUTOR_TYPES, false], [IDENTITY_MAX_EXECUTOR_TYPES + 1, true]]) {
    test(`a record listing ${n} names ${truncated ? 'reads as truncated' : 'reads whole'}`, () => {
      const names = Array.from({ length: n }, (_, i) => `y${i}`);
      plant('phase+02.json', JSON.stringify(valid({ executor_types: names })));
      const c = read().candidates.find((r) => r.identity);
      assert.equal(c.executorTypes.length, Math.min(n, IDENTITY_MAX_EXECUTOR_TYPES));
      assert.equal(c.executorTypesTruncated, truncated);
      assert.equal(classifies(OTHER), truncated);
    });
  }

  const hostile = [
    ['non-JSON', 'phase+02.json', '{not json'],
    ['a JSON array', 'phase+02.json', JSON.stringify([valid()])],
    ['schema 2', 'phase+02.json', JSON.stringify(valid({ schema: 2 }))],
    ['executor_types not an array', 'phase+02.json', JSON.stringify(valid({ executor_types: HINTED }))],
    ['an invalid name in executor_types', 'phase+02.json', JSON.stringify(valid({ executor_types: [HINTED, '../x'] }))],
    ['executor_type a number', 'phase+02.json', JSON.stringify(valid({ executor_type: 7 }))],
    ['executor_types_truncated a string', 'phase+02.json', JSON.stringify(valid({ executor_types_truncated: 'false' }))],
    ['written_at a string', 'phase+02.json', JSON.stringify(valid({ written_at: String(WRITTEN_AT) }))],
    ['an unsafe phase', 'phase+02.json', JSON.stringify(valid({ phase: '../02' }))],
    ['a filename for another scope', 'phase+03.json', JSON.stringify(valid())],
    ['a plan record under the phase name', 'phase+02.json', JSON.stringify(valid({ plan: '02-01' }))],
    ['written_at beyond the clock-skew allowance', 'phase+02.json', JSON.stringify(valid({ written_at: LATER + CLOCK_SKEW_MS + 1 }))],
  ];
  for (const [label, name, text] of hostile) {
    test(`${label}: scanOverflow, and an unlisted valid name is classified an executor`, () => {
      plant(name, text);
      assert.equal(read().scanOverflow, true);
      assert.equal(classifies(OTHER), true);
      assert.equal(classifies('gsd-verifier'), false, 'a GSD role is never an executor');
    });
  }

  test('written_at at the clock-skew allowance is still read', () => {
    plant('phase+02.json', JSON.stringify(valid({ written_at: LATER + CLOCK_SKEW_MS })));
    assert.equal(read().scanOverflow, undefined);
  });

  // The write-blocked states count only while a hold is possible: a hold-eligible caller `none` (safe keys
  // here, so only the planted state can set scanOverflow) is planted first, except in the gate's control.
  const plantHold = () => plantLegacy(legacyNone({ phase: '02', plan: '02-01' }));

  test('a directory at a record name fails closed while a hold is possible: it blocks that scope\'s write', () => {
    plantHold();
    fs.mkdirSync(path.join(dir(), 'phase+02.json'), { recursive: true });
    assert.equal(read().scanOverflow, true);
    assert.equal(classifies(OTHER), true);
  });

  test('a directory at a record name older than the recency window still fails closed', () => {
    // A 2033 clock, so the directory's mtime can sit past the window (fs.utimesSync cannot set a time before 1970).
    const NOW = 2_000_000_000_000;
    const at = { now: () => NOW };
    plantLegacy(legacyNone({ phase: '02', plan: '02-01', written_at: NOW - 1000, decided_at: NOW - 1000 }));
    const d = path.join(dir(), 'plan+02+02-01.json');
    fs.mkdirSync(d, { recursive: true });
    const aged = (NOW - AGED_NONE_MAX_MS - CLOCK_SKEW_MS - 3_600_000) / 1000;
    fs.utimesSync(d, aged, aged);
    const r = readSentinel(root, { clock: at, subagentType: 'some-agent', dispatchIds: { phase: '03', plan: null } });
    assert.equal(r.scanOverflow, true);
  });

  test('control: a directory named outside the record grammar (notes.json) is skipped', () => {
    plantHold();
    fs.mkdirSync(path.join(dir(), 'notes.json'), { recursive: true });
    assert.equal(read().scanOverflow, undefined);
    assert.equal(classifies(OTHER), false);
  });

  test('gate control: with no hold-eligible record, a directory at a record name changes nothing', () => {
    plantLegacy(legacyNone({ phase: '02', plan: '02-01', decided_by: 'resolver' }));
    fs.mkdirSync(path.join(dir(), 'phase+02.json'), { recursive: true });
    assert.equal(read().scanOverflow, undefined);
    assert.equal(classifies(OTHER), false);
  });

  // A fresh caller `none` in the legacy slot whose scope is not a safe key: a held query there has no identity
  // record name. The window is the resolver's hold (ten minutes from decided_at, SENTINEL_STALE_MS).
  const HOLD_MS = 10 * 60 * 1000;
  const legacyNone = (overrides) => JSON.stringify({
    isolation: 'none', harness_flag: null, phase: '2 ', plan: null, written_at: LATER - 1000,
    decided_by: 'caller', decided_at: LATER - 1000, ...overrides,
  });
  const plantLegacy = (text) => {
    fs.mkdirSync(path.join(root, '.gsd'), { recursive: true });
    fs.writeFileSync(path.join(root, SENTINEL_RELATIVE_PATH), text);
  };
  const legacyRows = [
    ['an unsafe phase', {}, true],
    ['an unsafe plan', { phase: '02', plan: 'a b' }, true],
    ['decided one millisecond inside the hold', { decided_at: LATER - HOLD_MS + 1 }, true],
    ['decided at the hold\'s end (control)', { decided_at: LATER - HOLD_MS }, undefined],
    ['decided by the resolver (control)', { decided_by: 'resolver' }, undefined],
    ['a non-none isolation (control)', { isolation: 'harness-worktree', harness_flag: 'isolation' }, undefined],
    ['safe keys (control)', { phase: '02', plan: '02-01' }, undefined],
  ];
  for (const [label, overrides, overflow] of legacyRows) {
    test(`a held-eligible caller none with ${label}: scanOverflow ${overflow === true ? 'set' : 'unset'}`, () => {
      plantLegacy(legacyNone(overrides));
      assert.equal(read().scanOverflow, overflow);
      assert.equal(classifies(OTHER), overflow === true);
    });
  }

  test('a directory past the entry bound fails closed', () => {
    plant('phase+02.json', JSON.stringify(valid()));
    for (let i = 0; i < sentinel.MAX_SCANNED_DIR_ENTRIES; i += 1) fs.writeFileSync(path.join(dir(), `f${i}.txt`), '');
    assert.equal(read().scanOverflow, true);
  });

  test('the identity scan runs on the classify path only: the hold read and a gsd-executor read skip it', () => {
    plant('phase+03.json', '{not json');
    const hold = sentinel.readSentinelAt(root, { clock, dispatchIds: { phase: '03', plan: null }, ownScope: true });
    assert.equal(hold.scanOverflow, undefined);
    assert.equal(readSentinel(root, { clock, subagentType: 'gsd-executor', dispatchIds: { phase: '03', plan: null } }).scanOverflow, undefined);
  });
});

describe('#4904 identity records outside the recency window are not read', () => {
  // A clock whose window holds the planted mtimes; fs.utimesSync cannot set a time before 1970. Every record's
  // written_at is fresh, so only the mtime can put a file outside the window.
  const NOW = 2_000_000_000_000;
  const at = { now: () => NOW };
  const WINDOW = AGED_NONE_MAX_MS + CLOCK_SKEW_MS;
  let root;
  const dir = () => path.join(root, IDENTITY_RECORD_DIR);
  const plantAged = (name, text, ageMs) => {
    fs.mkdirSync(dir(), { recursive: true });
    const file = path.join(dir(), name);
    fs.writeFileSync(file, text);
    fs.utimesSync(file, (NOW - ageMs) / 1000, (NOW - ageMs) / 1000);
  };
  const record = JSON.stringify({
    schema: 1, phase: '02', plan: null, executor_type: null, executor_types: [OTHER],
    executor_types_truncated: false, written_at: NOW - 1000,
  });
  const read = () => readSentinel(root, { clock: at, subagentType: 'some-agent', dispatchIds: { phase: '03', plan: null } });
  const classifies = (type) => isExecutorDispatch(type, read(), { phase: '03', plan: null }, { clock: at });

  before(() => {
    root = createTempDir('gsd-4904-identity-aged-');
    fs.mkdirSync(path.join(root, '.planning'));
  });
  beforeEach(() => cleanup(path.join(root, '.gsd')));
  after(() => cleanup(root));

  test('a record whose mtime is at the window\'s edge is read', () => {
    plantAged('phase+02.json', record, WINDOW);
    assert.equal(read().scanOverflow, undefined);
    assert.equal(classifies(OTHER), true);
  });

  test('a record one second past the window takes no slot: its names are not read', () => {
    plantAged('phase+02.json', record, WINDOW + 1000);
    assert.equal((read().candidates || []).filter((c) => c.identity).length, 0);
    assert.equal(read().scanOverflow, undefined);
    assert.equal(classifies(OTHER), false);
  });

  test('a hostile file at the window\'s edge fails closed; one second past it, it sets no scanOverflow', () => {
    plantAged('phase+02.json', '{not json', WINDOW);
    assert.equal(read().scanOverflow, true, 'control: the file fails closed while it is inside the window');
    plantAged('phase+02.json', '{not json', WINDOW + 1000);
    assert.equal(read().scanOverflow, undefined);
    assert.equal(classifies(OTHER), false);
  });
});

describe('#4904 the reader takes the union of the scopes\' latest snapshots (property)', () => {
  let root;
  before(() => {
    root = createTempDir('gsd-4904-identity-prop-');
    fs.mkdirSync(path.join(root, '.planning'));
  });
  after(() => cleanup(root));

  const SCOPES = [[null, null], ['02', null], ['03', null], ['02', '02-01'], [null, '03-01']];
  const POOL = Array.from({ length: 70 }, (_, i) => `p${String(i).padStart(2, '0')}-exec`);

  test('every name the last write per scope recorded classifies; no other does unless a record is truncated', () => {
    fc.assert(fc.property(
      fc.array(fc.record({
        scope: fc.integer({ min: 0, max: SCOPES.length - 1 }),
        names: fc.subarray(POOL),
      }), { minLength: 1, maxLength: 8 }),
      (writes) => {
        cleanup(path.join(root, '.gsd'));
        const dir = path.join(root, IDENTITY_RECORD_DIR);
        fs.mkdirSync(dir, { recursive: true });
        const last = new Map();
        writes.forEach(({ scope, names }, i) => {
          const [phase, plan] = SCOPES[scope];
          const { record } = executorType.buildExecutorIdentityRecord(
            { phase, plan }, plan ? names[0] : null, plan ? [] : names, WRITTEN_AT + i);
          fs.writeFileSync(path.join(dir, identityRecordName(phase, plan)), JSON.stringify(record));
          last.set(scope, record);
        });
        const expected = new Set();
        let truncated = false;
        for (const r of last.values()) {
          if (r.executor_type) expected.add(r.executor_type);
          for (const n of r.executor_types) expected.add(n);
          truncated = truncated || r.executor_types_truncated;
          assert.ok(r.executor_types.length <= IDENTITY_MAX_EXECUTOR_TYPES);
        }
        const sentinelRead = readSentinel(root, { clock, subagentType: 'p00-exec', dispatchIds: null });
        const identities = sentinelRead.candidates.filter((c) => c.identity);
        assert.equal(identities.length, last.size, 'one record per scope written');
        const union = new Set(identities.flatMap((c) => [c.executorType, ...c.executorTypes].filter(Boolean)));
        assert.deepEqual([...union].sort(), [...expected].sort());
        for (const c of identities) assert.ok(c.executorTypes.length <= IDENTITY_MAX_EXECUTOR_TYPES);
        for (const name of POOL) {
          assert.equal(isExecutorDispatch(name, sentinelRead, null, { clock }), truncated || expected.has(name), name);
        }
      },
    ), { numRuns: 60 });
  });
});

// #6303 x #4904: a held caller `none` of a plan that goes to another runtime must not outlive the hold. The
// per-plan gate forces the host's capability for it, so the exec read (never held by a non-`none` record)
// records `next`'s foreign decision, which the guard requires the flag under once it is stale. Run through
// the documented gate block and the real resolver; times come from GSD_NOW_MS and the guard's clock seam.
describe('#4904 a held foreign plan\'s caller none does not outlive the hold', {
  skip: process.platform === 'win32' ? 'runs the gate block under bash with a POSIX stand-in runtime binary' : skipUnless('bash'),
}, () => {
  const PHASE = '03';
  const PLAN = '03-05';
  const GATE_DOC = 'gsd-core/workflows/execute-phase/steps/per-plan-worktree-gate.md';
  const GATE_AT = WRITTEN_AT + 60_000;
  const ELEVEN_MIN_LATER = { now: () => GATE_AT + 11 * 60_000 };
  let root;
  let bin;
  const envAt = (now) => ({
    ...homeSandboxEnv(root), GSD_TEST_MODE: '1', GSD_RUNTIME: 'claude', GSD_NOW_MS: String(now),
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  });
  const gsd = (args, now) => {
    const r = runGsdTools(args, root, envAt(now));
    assert.ok(r.success, r.error);
    return r.output;
  };
  const keyedRecord = () => JSON.parse(fs.readFileSync(path.join(root, KEYED_SENTINEL_DIR, `${PHASE}--${PLAN}.json`), 'utf8'));

  before(() => {
    root = createTempGitProject('gsd-4904-foreign-');
    bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(root, '.planning', 'config.json'),
      JSON.stringify({ runtime: 'claude', workflow: { cross_runtime_execution: true } }));
    const dir = path.join(root, '.planning', 'phases', '03-x');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '03-05-PLAN.md'),
      '---\nphase: 03-x\nplan: "05"\ntype: execute\nwave: 1\ndepends_on: []\nfiles_modified: []\nautonomous: true\nexecutor_runtime: codex\n---\n# plan\n');
  });
  after(() => { cleanup(root); });

  test('after the gate and the exec read, a flag-less spawn of that plan\'s executor is blocked eleven minutes later', () => {
    gsd(['dispatch-isolation', '--raw', '--phase', PHASE, '--force-isolation', 'harness-worktree'], WRITTEN_AT);
    gsd(['dispatch-isolation', '--raw', '--phase', PHASE, '--plan', PLAN, '--force-isolation', 'none'], WRITTEN_AT);
    const block = span(GATE_DOC, 'if [ "${USE_WORKTREES_FOR_PLAN:-}" = "false" ]', '# An EMPTY value');
    const script = ['set -e', `gsd_run() { "${process.execPath}" "${TOOLS_PATH}" "$@"; }`,
      `PHASE_NUMBER=${PHASE}; plan_id=${PLAN}; USE_WORKTREES_FOR_PLAN=true`, ...block, ''].join('\n');
    const g = runHook('-c', [script], { interpreter: 'bash', cwd: root, env: envAt(GATE_AT), timeoutMs: PROBE_TIMEOUT_MS });
    assert.equal(g.exitCode, 0, g.stderr);
    const planDispatch = JSON.parse(g.stdout.slice(g.stdout.indexOf('PLAN_DISPATCH=') + 'PLAN_DISPATCH='.length));
    const afterGate = keyedRecord();

    const wt = path.join(root, 'wt');
    fs.mkdirSync(wt, { recursive: true });
    const exec = JSON.parse(gsd(['dispatch-isolation', '--json', '--phase', PHASE, '--plan', PLAN, '--cwd-target', wt, '--prompt', 'go'], GATE_AT));
    const rec = keyedRecord();
    const d = guard.evaluateDispatch({
      tool_name: 'Agent', cwd: root,
      tool_input: { subagent_type: 'gsd-executor', prompt: `[gsd:dispatch phase="${PHASE}" plan="${PLAN}"]\nrun` },
    }, { clock: ELEVEN_MIN_LATER });
    assert.equal(d.action, 'block', `the guard allowed the flag-less spawn (plan record ${rec.isolation}/${rec.decided_by})`);
    assert.equal(d.reasonCode, REASON_CODE.HARNESS_FLAG_MISSING);

    assert.equal(planDispatch.held, true, 'precondition: the gate\'s plain query held the caller\'s none');
    assert.equal(planDispatch.executorRuntime, 'codex');
    assert.equal(planDispatch.fallback, null, 'the plan still goes to its runtime');
    assert.notEqual(afterGate.isolation, 'none', 'the gate replaced the held none');
    assert.equal(exec.held, false, 'the exec read is not held');
    assert.equal(exec.isolation, 'orchestrator-worktree');
    assert.equal(exec.exec.command, 'codex');
    assert.equal(rec.isolation, 'orchestrator-worktree', 'the exec read recorded the foreign decision');
    assert.equal(rec.producer, 'dispatch-isolation');
  });
});
