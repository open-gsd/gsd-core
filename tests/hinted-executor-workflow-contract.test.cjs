'use strict';

/**
 * #6213 workflow contract: the runtime-loaded execute-phase workflow records the plan's executor
 * through `dispatch-isolation` (which derives it from the plan, so the call carries no executor
 * value across tool calls), dispatches with the routed executor and its model, and lets a
 * refusal warning reach the orchestrator. These markdown files are the product an agent executes, so
 * the contract is asserted by running the documented blocks under bash with a stub `gsd_run` that
 * records its argv, never by matching their text.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const { cleanup } = require('./helpers.cjs');
const { skipUnless } = require('./helpers/bash-probe.cjs');
const { span, runBash } = require('./helpers/doc-bash-span.cjs');

const SKIP = skipUnless('bash', 'node');

const GATE = 'gsd-core/workflows/execute-phase/steps/per-plan-worktree-gate.md';

// A stub `gsd_run` for the documented blocks: it appends each call's argv (unit-separator joined, one
// call per line) to a log file, writes a refusal warning to stderr, and prints `acme-x` for resolve-agent.
function recordingStub(log) {
  return [
    `gsd_run() { { for a in "$@"; do printf '%s\\037' "$a"; done; printf '\\n'; } >> '${log}'; ` +
      'case "$2" in resolve-agent) echo "STUB-REFUSAL-WARNING" >&2; printf acme-x;; resolve-model) printf "%s" "$3:model-a";; esac; }',
  ];
}

function calls(log) {
  return splitLines(fs.readFileSync(log, 'utf8')).filter((l) => l.length > 0).map((l) => l.split('\u001f').slice(0, -1));
}

describe('#6213 execute-phase records the routed executor without a carried shell value', { skip: SKIP }, () => {
  let dir;
  let log;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-6213-wf-')); log = path.join(dir, 'argv.log'); });
  after(() => { cleanup(dir); });

  // The Part 2 block (the `if` that picks the forced-none or the re-resolve call), run per decision value.
  // Its `true` branch nests an `if` (the capability read), so the block ends at the comment after it.
  const part2 = () => span(GATE, 'if [ "${USE_WORKTREES_FOR_PLAN:-}" = "false" ]', '# An EMPTY value');
  const runGate = (decision) => {
    fs.writeFileSync(log, '');
    return runBash(part2(), { stdout: '', rc: 0 }, {
      preamble: [`PHASE_NUMBER=02; plan_id=02-01-api; USE_WORKTREES_FOR_PLAN=${decision}`, ...recordingStub(log)],
    });
  };

  test('the forced-none call carries --phase and --plan and no executor value', () => {
    const r = runGate('false');
    assert.equal(r.status, 0, r.stderr);
    const argv = calls(log);
    assert.equal(argv.length, 1);
    assert.deepEqual(argv[0], ['query', 'dispatch-isolation', '--raw', '--phase', '02', '--plan', '02-01-api', '--force-isolation', 'none']);
    assert.ok(!argv[0].includes('--executor-type'));
  });

  test('the re-resolve call carries --phase and --plan and no executor value', () => {
    const r = runGate('true');
    assert.equal(r.status, 0, r.stderr);
    const argv = calls(log);
    // #6303: the per-plan call asks for --json so the plan's executorRuntime and fallback are readable.
    // #4904: a plan not sent to another runtime then reads the host capability (the stub prints none,
    // so the record stays plain and nothing is forced).
    assert.deepEqual(argv.map((a) => a[1]), ['dispatch-isolation', 'inspect-dispatch-isolation']);
    assert.deepEqual(argv[0], ['query', 'dispatch-isolation', '--json', '--phase', '02', '--plan', '02-01-api']);
    assert.ok(!argv.some((a) => a.includes('--executor-type')));
  });

  test('an empty decision records nothing', () => {
    const r = runGate('""');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(calls(log), []);
  });

  // #6303 x #4904: the `true` branch forces the host's capability for every plan with an id, one that goes
  // to another runtime included, so a held `none` of its own never outlives the hold; PLAN_DISPATCH stays
  // the plain answer, which is where the orchestrator reads executorRuntime and fallback.
  // This stub answers the plain --json query with the given JSON and the capability read with a mode.
  const answeringStub = (dispatchJson) => [
    `gsd_run() { { for a in "$@"; do printf '%s\\037' "$a"; done; printf '\\n'; } >> '${log}'; ` +
      `case "$2" in dispatch-isolation) case " $* " in *" --json "*) printf '%s' '${dispatchJson}';; esac;; inspect-dispatch-isolation) printf harness-worktree;; esac; }`,
  ];
  const runTrue = (dispatchJson) => {
    fs.writeFileSync(log, '');
    return runBash(part2(), { stdout: '', rc: 0 }, {
      preamble: ['PHASE_NUMBER=02; plan_id=02-01-api; USE_WORKTREES_FOR_PLAN=true', ...answeringStub(dispatchJson)],
    });
  };
  const plainJson = ['query', 'dispatch-isolation', '--json', '--phase', '02', '--plan', '02-01-api'];

  for (const [label, json] of [
    ['goes to another runtime', '{"isolation":"orchestrator-worktree","executorRuntime":"codex","fallback":null,"held":false}'],
    ['goes to another runtime, held', '{"isolation":"orchestrator-worktree","executorRuntime":"codex","fallback":null,"held":true}'],
    ['stays on the host', '{"isolation":"harness-worktree","executorRuntime":null,"fallback":null,"held":false}'],
    ['falls back, held', '{"isolation":"none","executorRuntime":"codex","fallback":"binary_absent","held":true}'],
    // Any fallback reason means the host dispatches, whatever isolation field sits beside it.
    ['names a fallback', '{"isolation":"orchestrator-worktree","executorRuntime":"codex","fallback":"binary_absent","held":false}'],
  ]) {
    test(`a plan that ${label} is forced to the host capability, and PLAN_DISPATCH stays the plain answer`, () => {
      const r = runTrue(json);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(calls(log), [
        plainJson,
        ['query', 'inspect-dispatch-isolation', '--raw'],
        ['query', 'dispatch-isolation', '--raw', '--phase', '02', '--plan', '02-01-api', '--force-isolation', 'harness-worktree'],
      ]);
      assert.ok(r.stdout.includes(`PLAN_DISPATCH=${json}`), r.stdout);
    });
  }
});

describe('#6213 the dispatch-isolation calls that can truncate surface the warning', { skip: SKIP }, () => {
  const DISPATCH = 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md';

  test('a warning the call writes to stderr reaches the orchestrator, and the raw value is still captured', () => {
    // The block reads the decision and `held` from one --json call (#4904), then takes the mode from it.
    const lines = span(DISPATCH, '_ISOLATION_JSON=$(gsd_run query dispatch-isolation', '_ISOLATION_RAW=${_ISOLATION_FIELDS% *}');
    const r = runBash(lines, { stdout: '', rc: 0 }, {
      preamble: [
        'PHASE_NUMBER=02',
        'gsd_run() { echo "STUB-TRUNCATION-WARNING" >&2; printf \'{"isolation":"harness-worktree","held":false}\'; }',
      ],
      probe: 'printf "RAW=%s RC=%s\\n" "$_ISOLATION_RAW" "$_ISOLATION_RC"',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes('STUB-TRUNCATION-WARNING'), `the call's stderr must stay visible: ${r.stderr}`);
    assert.equal(r.stdout.trim(), 'RAW=harness-worktree RC=0', 'the warning does not leak into the captured value');
  });

  test('the dispatch-isolation gate\'s unscoped query lets the same warning reach the orchestrator (#4904)', () => {
    // dispatch-isolation-gate.md's query names no phase, so its record lists every phase's hinted executors
    // and is the one most likely to be truncated; its warning must not be discarded.
    const lines = span('gsd-core/references/dispatch-isolation-gate.md',
      '_ISOLATION_JSON=$(gsd_run query dispatch-isolation', '_ISOLATION_RAW=${_ISOLATION_FIELDS% *}');
    const r = runBash(lines, { stdout: '', rc: 0 }, {
      preamble: ['gsd_run() { echo "STUB-TRUNCATION-WARNING" >&2; printf \'{"isolation":"harness-worktree","held":false}\'; }'],
      probe: 'printf "RAW=%s RC=%s\\n" "$_ISOLATION_RAW" "$_ISOLATION_RC"',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes('STUB-TRUNCATION-WARNING'), `the call's stderr must stay visible: ${r.stderr}`);
    assert.equal(r.stdout.trim(), 'RAW=harness-worktree RC=0', 'the warning does not leak into the captured value');
  });

  test('the per-plan gate\'s plan-scoped query lets a held query\'s warning reach the orchestrator (#4904)', () => {
    // A held plan query writes its executor identity to a record of its own and warns on stderr when it cannot;
    // the per-plan gate's capture must not discard that warning.
    const lines = span(GATE, 'PLAN_DISPATCH_JSON=$(gsd_run query dispatch-isolation', 'PLAN_DISPATCH_JSON=$(gsd_run query dispatch-isolation');
    assert.equal(lines.length, 1, 'the capture is one line');
    const r = runBash(lines, { stdout: '', rc: 0 }, {
      preamble: ['PHASE_NUMBER=02; plan_id=02-01-api',
        'gsd_run() { echo "STUB-HELD-IDENTITY-WARNING" >&2; printf \'{"isolation":"none","held":true}\'; }'],
      probe: 'printf "JSON=%s\\n" "$PLAN_DISPATCH_JSON"',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes('STUB-HELD-IDENTITY-WARNING'), `the call's stderr must stay visible: ${r.stderr}`);
    assert.equal(r.stdout.trim(), 'JSON={"isolation":"none","held":true}', 'the warning does not leak into the captured value');
  });
});

describe('#6213 execute-phase dispatches with the routed executor and model', () => {
  let dir;
  let log;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-6213-route-')); log = path.join(dir, 'argv.log'); });
  after(() => { cleanup(dir); });

  const ROUTE = 'gsd-core/workflows/execute-phase/steps/per-plan-executor-routing.md';
  const routeLines = () => span(ROUTE, 'EXECUTOR_TYPE=$(gsd_run query resolve-agent', "printf 'EXECUTOR_TYPE=");

  test('routing resolves the executor from the plan on disk, passes no hint or effort, and lets the refusal warning reach stderr', { skip: SKIP }, () => {
    fs.writeFileSync(log, '');
    const r = runBash(routeLines(), { stdout: '', rc: 0 }, {
      preamble: ['PHASE_NUMBER=02; plan_id=02-01-api', ...recordingStub(log)],
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes('STUB-REFUSAL-WARNING'), `resolve-agent stderr must stay visible: ${r.stderr}`);
    const argv = calls(log);
    const resolve = argv.filter((a) => a[1] === 'resolve-agent');
    assert.equal(resolve.length, 1, 'one resolve-agent call');
    assert.deepEqual(resolve[0], ['query', 'resolve-agent', '--phase', '02', '--plan', '02-01-api', '--raw']);
    assert.ok(!resolve[0].includes('--name'), 'no hint is carried in from plan_json');
    for (const a of argv) assert.ok(!a.some((x) => /effort/i.test(x)), `no effort is passed: ${a.join(' ')}`);
    assert.deepEqual(argv.map((a) => a[1]), ['resolve-agent', 'resolve-model'], 'the model follows the routed executor');
    assert.equal(argv[1][2], 'acme-x');
  });

  // Behavioural: the documented resolution lines run under bash with `gsd_run` stubbed per verb.
  const ROUTING = 'gsd-core/workflows/execute-phase/steps/per-plan-executor-routing.md';
  const lines = () => span(ROUTING, 'EXECUTOR_TYPE=$(gsd_run query resolve-agent', "printf 'EXECUTOR_TYPE=");
  const stubbed = (modelOk) => runBash(lines(), { stdout: '', rc: modelOk ? 0 : 1 }, {
    preamble: [
      'PHASE_NUMBER=02; plan_id=02-01-api',
      // resolve-agent prints the routed type; resolve-model prints a model or fails per STUB_RC.
      'gsd_run() { case "$2" in resolve-agent) printf acme-x;; resolve-model) [ "$STUB_RC" = 0 ] || return 1; printf "%s" "$3:model-a";; *) return 2;; esac; }',
    ],
  });
  const parse = (out) => Object.fromEntries(splitLines(out.trim()).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

  test('a successful model resolve prints the routed type, its model and EXECUTOR_MODEL_SOURCE=resolved', { skip: SKIP }, () => {
    const r = stubbed(true);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(parse(r.stdout), { EXECUTOR_TYPE: 'acme-x', EXECUTOR_MODEL: 'acme-x:model-a', EXECUTOR_MODEL_SOURCE: 'resolved' });
  });

  test('a failed model resolve prints an empty EXECUTOR_MODEL and EXECUTOR_MODEL_SOURCE=init, still under set -e', { skip: SKIP }, () => {
    const r = stubbed(false);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(parse(r.stdout), { EXECUTOR_TYPE: 'acme-x', EXECUTOR_MODEL: '', EXECUTOR_MODEL_SOURCE: 'init' });
  });
});
