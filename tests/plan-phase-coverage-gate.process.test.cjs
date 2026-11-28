'use strict';

/**
 * #6814: plan-phase step 13 (Requirements Coverage Gate) collects the requirement IDs that each live
 * plan's `requirements` frontmatter claims, one ID per line.
 *
 * The documented `PLAN_REQS=$(...)` line is extracted from plan-phase.md and run under bash against the
 * real CLI. It is a shell pipeline over two CLI verbs and jq, so what it captures is what crosses those
 * process boundaries: this is a process-contract test. Where the host has no jq (the Tester Image), the
 * line runs against tests/helpers/jq-subset-stub.cjs, whose two filters for it are pinned below with
 * values measured from real jq 1.8.1, and compared with real jq wherever it is on PATH: row by row and
 * over generated documents.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');
const { skipUnless } = require('./helpers/bash-probe.cjs');
const { span, runBash } = require('./helpers/doc-bash-span.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { isolatedEnv } = require('./helpers/isolated-env.cjs');
const { createTempProject, cleanup, TOOLS_PATH } = require('./helpers.cjs');
const processSeam = require('./helpers/process-seam.cjs');

const SKIP = skipUnless('bash', 'node');
// skipUnless, not have(): under CI the real-jq cross-check must run, never skip (#6677).
const JQ_SKIP = skipUnless('jq');
const PLAN_PHASE = 'gsd-core/workflows/plan-phase.md';
const STUB = path.join(__dirname, 'helpers', 'jq-subset-stub.cjs');
const LIST_PLANS = '.plans[]';
const NORMALIZE = String.raw`(arrays|.[]),.|strings|splits("[,\\s]+")|select(.!="")`;
// The flag the documented line passes to both jq calls.
const JQ_FLAGS = '-r';

/**
 * The bound for one run of the line over `plans` plan files. Each process it starts is one short CLI
 * query or one jq run, the class PROBE_TIMEOUT_MS bounds (tests/helpers/timeouts.cjs): one list-plans
 * query and its jq, then one frontmatter.get and its jq per plan. The run's bound is their sum; the `tr`
 * and `sort` stages (and the CRLF wrapper's awk) run alongside those, so they add no term.
 */
const fanOutTimeoutMs = (plans) => (2 * plans + 2) * PROBE_TIMEOUT_MS;

/** A single-quoted bash word for `s`. */
const sq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

/** One plan file: its frontmatter lines, then an optional body. */
function writePlan(phaseDir, rel, frontmatter, body = '') {
  const file = path.join(phaseDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, ['---', ...frontmatter, '---', '', body].join('\n'));
}

/** A temporary project, removed when the test ends. */
function project(t, prefix = 'gsd-6814-') {
  const dir = createTempProject(prefix);
  t.after(() => cleanup(dir));
  return dir;
}

// A `jq` that ends every line it prints with CR, as a native Windows jq.exe does, wrapping whichever jq the
// run has (the real one, or the stub function runBash defines where there is none).
const CRLF_JQ = [
  'if declare -F jq >/dev/null; then eval "lf_jq() $(declare -f jq | tail -n +2)"; else lf_jq() { command jq "$@"; }; fi',
  'jq() { lf_jq "$@" | awk \'{ printf "%s\\r\\n", $0 }\'; }',
];

/**
 * Run step 13's documented PLAN_REQS line for phase 1 of `root` with `gsd_run` bound to the real CLI:
 * from `cwd` (a directory under the project; the root by default), with `ws` as the `GSD_WS` that step 1
 * derives from `--ws <name>`, and with `crlf` a jq that writes CRLF. `plans` is the number of plan files
 * the phase holds (the fan-out the timeout is sized for).
 */
function runPlanReqs(root, { plans, cwd = root, ws = '', crlf = false }) {
  const lines = span(PLAN_PHASE, 'PLAN_REQS=$(', 'PLAN_REQS=$(')
    .map((l) => l.replaceAll('{phase_number}', '1').replaceAll('{project_root}', root));
  const preamble = [
    `cd ${sq(cwd)}`,
    `gsd_run() { "$STUB_NODE" ${sq(TOOLS_PATH)} "$@"; }`,
    ...(ws ? [`GSD_WS=${sq(`--ws ${ws}`)}`] : []),
    ...(crlf ? CRLF_JQ : []),
  ];
  return runBash(lines, { stdout: '', rc: 0 }, {
    preamble,
    probe: 'printf "%s\\n" "$PLAN_REQS"',
    timeoutMs: fanOutTimeoutMs(plans),
    env: isolatedEnv({ home: root }),
  });
}

/** The IDs PLAN_REQS held, one per line. */
const ids = (stdout) => stdout.split('\n').filter(Boolean);

describe('plan-phase step 13: PLAN_REQS holds the IDs each live plan claims, one per line', { skip: SKIP }, () => {
  test('the documented line, run in bash against the real CLI (it pipes two verbs through jq): every frontmatter form, live plans only', (t) => {
    const root = project(t);
    const phaseDir = path.join(root, '.planning', 'phases', '01-auth');
    fs.writeFileSync(path.join(root, '.planning', 'ROADMAP.md'), '# Roadmap\n\n### Phase 1: Auth\n**Goal:** x\n');
    writePlan(phaseDir, '01-01-PLAN.md', ['phase: 01', 'plan: 01', 'requirements: [AUTH-01, AUTH-02]']);
    writePlan(phaseDir, '01-02-PLAN.md', ['phase: 01', 'plan: 02', 'requirements:', '  - AUTH-03']);
    writePlan(phaseDir, '01-03-PLAN.md', ['phase: 01', 'plan: 03', 'requirements:', '- AUTH-04']);
    writePlan(phaseDir, '01-04-PLAN.md', ['phase: 01', 'plan: 04', 'requirements: []'], 'The body mentions requirements: AUTH-09 here.\n');
    writePlan(phaseDir, '01-05-PLAN.md', ['phase: 01', 'plan: 05', 'status: superseded', 'requirements: [AUTH-07]']);
    writePlan(phaseDir, '01-07-PLAN.md', ['phase: 01', 'plan: 07', 'requirements: AUTH-08']);
    writePlan(phaseDir, '01-08-PLAN.md', ['phase: 01', 'plan: 08', 'requirements: AUTH-10, AUTH-11']);
    writePlan(phaseDir, '01-09-PLAN.md', ['phase: 01', 'plan: 09']);
    writePlan(phaseDir, 'PLAN.md', ['phase: 01', 'requirements: [AUTH-06]']);
    writePlan(phaseDir, path.join('plans', 'PLAN-06.md'), ['phase: 01', 'plan: 06', 'requirements: [AUTH-05]']);

    const r = runPlanReqs(root, { plans: 10 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.deepEqual(ids(r.stdout), [
      'AUTH-01', 'AUTH-02', 'AUTH-03', 'AUTH-04', 'AUTH-05', 'AUTH-06', 'AUTH-08', 'AUTH-10', 'AUTH-11',
    ]);
  });

  test('the documented line, run in bash against the real CLI: a phase with no plans leaves PLAN_REQS empty', (t) => {
    const root = project(t);
    const phaseDir = path.join(root, '.planning', 'phases', '01-auth');
    fs.mkdirSync(phaseDir);
    const r = runPlanReqs(root, { plans: 0 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.equal(r.stdout, '\n');
  });

  test('the documented line, run in bash against the real CLI: CRLF, duplicate-key, quoted, empty, mapping-valued and unclosed frontmatter', (t) => {
    const root = project(t);
    const phaseDir = path.join(root, '.planning', 'phases', '01-auth');
    const crlf = (rel, frontmatter) => {
      fs.mkdirSync(path.dirname(path.join(phaseDir, rel)), { recursive: true });
      fs.writeFileSync(path.join(phaseDir, rel), ['---', ...frontmatter, '---', '', 'body', ''].join('\r\n'));
    };
    crlf('01-01-PLAN.md', ['phase: 01', 'plan: 01', 'requirements: [AUTH-01, AUTH-02]']);
    crlf('01-02-PLAN.md', ['phase: 01', 'plan: 02', 'requirements:', '  - AUTH-03']);
    crlf('01-03-PLAN.md', ['phase: 01', 'plan: 03', 'requirements: AUTH-04, AUTH-05']);
    writePlan(phaseDir, '01-04-PLAN.md', ['phase: 01', 'plan: 04', 'requirements: [AUTH-08]', 'requirements: [AUTH-06]']);
    writePlan(phaseDir, '01-05-PLAN.md', ['phase: 01', 'plan: 05', `requirements: ["AUTH-07", 'AUTH-09']`]);
    writePlan(phaseDir, '01-06-PLAN.md', ['phase: 01', 'plan: 06', 'requirements:']);
    writePlan(phaseDir, '01-07-PLAN.md', ['phase: 01', 'plan: 07', 'requirements:', '  path: AUTH-10']);
    fs.writeFileSync(path.join(phaseDir, '01-08-PLAN.md'), '---\nphase: 01\nplan: 08\nrequirements: [AUTH-11]\n\nbody\n');

    const r = runPlanReqs(root, { plans: 8 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.deepEqual(ids(r.stdout), [
      'AUTH-01', 'AUTH-02', 'AUTH-03', 'AUTH-04', 'AUTH-05', 'AUTH-06', 'AUTH-07', 'AUTH-09',
    ]);
  });

  test('the documented line, run in bash from a subdirectory: plan paths resolve against the project root, and an unreadable plan adds no IDs', (t) => {
    const root = project(t);
    const phaseDir = path.join(root, '.planning', 'phases', '01-auth');
    writePlan(phaseDir, '01-01-PLAN.md', ['phase: 01', 'plan: 01', 'requirements: [AUTH-01]']);
    writePlan(phaseDir, '01-02-PLAN.md', ['phase: 01', 'plan: 02', 'requirements: [AUTH-02']);
    writePlan(phaseDir, '01-03-PLAN.md', ['phase: 01', 'plan: 03', 'requirements: AUTH-03']);
    const subdir = path.join(root, 'src', 'deep');
    fs.mkdirSync(subdir, { recursive: true });

    const r = runPlanReqs(root, { plans: 3, cwd: subdir });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    // 01-02's requirements read as uncovered: the gate asks about AUTH-02 instead of hiding the gap.
    assert.deepEqual(ids(r.stdout), ['AUTH-01', 'AUTH-03']);
  });

  test('the documented line, run in bash with GSD_WS from --ws: the workstream\'s plans are read, not the root phase\'s', (t) => {
    const root = project(t);
    const phaseDir = path.join(root, '.planning', 'workstreams', 'feat', 'phases', '01-ws');
    writePlan(path.join(root, '.planning', 'phases', '01-root'), '01-01-PLAN.md', ['phase: 01', 'plan: 01', 'requirements: [ROOT-01]']);
    writePlan(phaseDir, '01-01-PLAN.md', ['phase: 01', 'plan: 01', 'requirements: [WS-01]']);

    const r = runPlanReqs(root, { plans: 1, ws: 'feat' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.deepEqual(ids(r.stdout), ['WS-01']);
  });

  test('the documented line, run in bash with a jq that ends each line with CR (a native Windows jq.exe): plan paths and IDs come out without it', (t) => {
    const root = project(t);
    const phaseDir = path.join(root, '.planning', 'phases', '01-auth');
    writePlan(phaseDir, '01-01-PLAN.md', ['phase: 01', 'plan: 01', 'requirements: [AUTH-01, AUTH-02]']);
    writePlan(phaseDir, '01-02-PLAN.md', ['phase: 01', 'plan: 02', 'requirements:', '  - AUTH-03']);

    const r = runPlanReqs(root, { plans: 2, crlf: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.deepEqual(ids(r.stdout), ['AUTH-01', 'AUTH-02', 'AUTH-03']);
  });

  test('the documented line, run in bash: IDs and plan paths are data, never shell code (blanks in the project and phase paths, a quote in a plan name)', (t) => {
    const root = project(t, 'gsd 6814 ');
    const phaseDir = path.join(root, '.planning', 'phases', '01-my auth');
    writePlan(phaseDir, '01-01 x-PLAN.md', ['phase: 01', 'plan: 01', String.raw`requirements: ["$(touch PWN)", "` + '`touch PWN`' + String.raw`", "A;touch PWN", "-n", "*", "a\\b", "it's"]`]);
    writePlan(phaseDir, "01-02 o'x-PLAN.md", ['phase: 01', 'plan: 02', 'requirements: [AUTH-02]']);

    const r = runPlanReqs(root, { plans: 2 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    // sort -u collates by the host's locale, so the set is compared, not the order.
    assert.deepEqual(ids(r.stdout).sort(), ['$(touch', '*', '-n', 'A;touch', 'AUTH-02', 'PWN', 'PWN)', 'PWN`', 'a\\b', "it's", '`touch'].sort());
    for (const dir of [root, phaseDir]) assert.equal(fs.existsSync(path.join(dir, 'PWN')), false, `no PWN file in ${dir}`);
  });
});

// The stub's stream filters for the line above. Each row was measured from real jq 1.8.1 (`jq -r <filter>`):
// the stdin, the lines printed, and the exit status (5 is a jq runtime error: "Cannot iterate"/"Cannot index").
// frontmatter.get answers an unreadable plan with `error` and `path`, a missing key with `error` and `field`:
// any object adds no ID.
const STREAM_PINS = [
  [NORMALIZE, '["AUTH-01","AUTH-02"]', ['AUTH-01', 'AUTH-02'], 0],
  [NORMALIZE, '"AUTH-08"', ['AUTH-08'], 0],
  [NORMALIZE, '"AUTH-10, AUTH-11"', ['AUTH-10', 'AUTH-11'], 0],
  [NORMALIZE, '[]', [], 0],
  [NORMALIZE, '{"error":"Field not found","field":"requirements"}', [], 0],
  [NORMALIZE, '{"error":"File not found","path":"p.md"}', [], 0],
  [NORMALIZE, '{\n  "error": "Frontmatter is not parseable YAML",\n  "path": "p.md"\n}\n', [], 0],
  [NORMALIZE, '{"path":"AUTH-P"}', [], 0],
  [NORMALIZE, '[{"error":"e","path":"p.md"},"A-3"]', ['A-3'], 0],
  [NORMALIZE, '5', [], 0],
  [NORMALIZE, '', [], 0],
  [NORMALIZE, '""', [], 0],
  [NORMALIZE, 'null', [], 0],
  [NORMALIZE, '[" A-1 ,A-2",3,{"x":"y"},null,["X"]]', ['A-1', 'A-2'], 0],
  [NORMALIZE, '"a\\tb\\nc,,d , e\\r"', ['a', 'b', 'c', 'd', 'e'], 0],
  [NORMALIZE, '"A\\u0085B"', ['A', 'B'], 0],
  [NORMALIZE, '"A\\ufeffB"', ['A\ufeffB'], 0],
  [LIST_PLANS, '{"plans":["a","b"]}', ['a', 'b'], 0],
  [LIST_PLANS, '{"plans":[]}', [], 0],
  [LIST_PLANS, '{"plans":{"x":"y"}}', ['y'], 0],
  [LIST_PLANS, '{}', [], 5],
  [LIST_PLANS, '{"plans":"s"}', [], 5],
  [LIST_PLANS, '[]', [], 5],
  [LIST_PLANS, '', [], 0],
];

/** The lines `jq -r` printed, each ended by a newline. */
const lines = (stdout) => (stdout === '' ? [] : stdout.replace(/\n$/, '').split('\n'));
const runStub = (filter, input) => processSeam.runNode([STUB, JQ_FLAGS, filter], { input, timeoutMs: PROBE_TIMEOUT_MS });
const runJq = (filter, input) => processSeam.runHook(JQ_FLAGS, [filter], { interpreter: 'jq', input, timeoutMs: PROBE_TIMEOUT_MS });

// Generated documents of the shapes the two verbs answer with. Strings draw on separators jq's `\s` does and does
// not split on (U+0085, U+00A0, U+2028 and U+3000 are White_Space; U+200B and U+FEFF are not). Objects never reach
// `.plans[]`'s output, and numbers never reach either filter's output: those print differently (see the stub's header).
const TEXT = fc.string({
  unit: fc.constantFrom('A', 'b', '-', '1', ',', ' ', '\t', '\n', '\r', '\v', '\f', '\u0085', '\u00a0', '\u2028', '\u3000', '\u200b', '\ufeff', '"', '\\', '/'),
  maxLength: 12,
});
const SCALAR = fc.oneof(TEXT, fc.integer({ min: -9, max: 99 }), fc.boolean(), fc.constant(null));
const REQUIREMENTS_ANSWER = fc.oneof(
  TEXT,
  SCALAR,
  fc.array(fc.oneof(SCALAR, fc.array(TEXT, { maxLength: 2 }), fc.dictionary(TEXT, TEXT, { maxKeys: 2 })), { maxLength: 5 }),
  fc.record({ error: TEXT, path: TEXT }),
  fc.record({ error: TEXT, field: fc.constant('requirements') }),
);
const LIST_PLANS_ANSWER = fc.oneof(
  fc.record({ plans: fc.array(TEXT, { maxLength: 4 }) }),
  fc.record({ plans: fc.dictionary(TEXT, TEXT, { maxKeys: 3 }) }),
  fc.record({ plans: fc.oneof(fc.constant(null), TEXT, fc.integer({ min: 0, max: 9 })) }),
  fc.constant({}),
);
/** A document as the CLI prints it: compact or indented. */
const printed = (value) => fc.boolean().map((indent) => JSON.stringify(value, null, indent ? 2 : 0));

describe('jq-subset-stub: the stream filters plan-phase step 13 uses agree with jq', () => {
  for (const [filter, doc, out, exit] of STREAM_PINS) {
    test(`a spawned stub (the stand-in a bash block calls): ${filter} over ${JSON.stringify(doc)} prints ${JSON.stringify(out)} and exits ${exit}`, () => {
      const r = runStub(filter, doc);
      assert.equal(r.exitCode, exit);
      assert.deepEqual(lines(r.stdout), out);
    });
  }

  // Two known divergences (the stub's header): real jq prints `1.0` and `1E+3`, and `B` before `ONE`. No answer
  // phase.list-plans gives reaches either, so they are pinned on the stub alone.
  for (const [doc, out] of [['{"plans":[1.0,1e3]}', ['1', '1000']], ['{"plans":{"b":"B","1":"ONE"}}', ['ONE', 'B']]]) {
    test(`a spawned stub, a known divergence: ${LIST_PLANS} over ${doc} prints ${JSON.stringify(out)}`, () => {
      const r = runStub(LIST_PLANS, doc);
      assert.equal(r.exitCode, 0);
      assert.deepEqual(lines(r.stdout), out);
    });
  }

  test('a spawned stub refuses -e with a stream filter (exit 3) rather than guess its status', () => {
    for (const filter of [LIST_PLANS, NORMALIZE]) {
      const r = processSeam.runNode([STUB, '-re', filter], { input: '{"plans":["a"]}', timeoutMs: PROBE_TIMEOUT_MS });
      assert.equal(r.exitCode, 3, filter);
      assert.equal(r.stdout, '', filter);
    }
  });

  test('real jq, spawned (the tool the stub stands in for), gives the pinned answer for every row', { skip: JQ_SKIP }, () => {
    for (const [filter, doc, out, exit] of STREAM_PINS) {
      const r = runJq(filter, doc);
      assert.equal(r.exitCode, exit, `${filter} over ${JSON.stringify(doc)}`);
      assert.deepEqual(lines(r.stdout), out, `${filter} over ${JSON.stringify(doc)}`);
    }
  });

  for (const [filter, answer, seed] of [[NORMALIZE, REQUIREMENTS_ANSWER, 6814], [LIST_PLANS, LIST_PLANS_ANSWER, 6815]]) {
    test(`property: over generated documents, the stub and real jq print the same lines and exit alike for ${filter}`, { skip: JQ_SKIP }, () => {
      fc.assert(
        fc.property(answer.chain(printed), (doc) => {
          const stub = runStub(filter, doc);
          const jq = runJq(filter, doc);
          assert.equal(stub.exitCode, jq.exitCode, doc);
          assert.equal(stub.stdout, jq.stdout, doc);
        }),
        { numRuns: 60, seed },
      );
    });
  }
});
