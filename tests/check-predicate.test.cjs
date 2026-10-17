'use strict';

/**
 * Integration tests for the `check predicate` subcommand wiring (#2008).
 *
 * These exercise the PRODUCTION stack: the real `buildPredicateDeps()` binding
 * (which wraps shell-command-projection.execTool → bounded `sh -c` spawnSync) and
 * the `parsePredicateFlags` arg parser. The pure evaluator logic is covered by
 * gate-predicate-evaluator.test.cjs; this file proves the wiring holds against
 * real subprocess exit codes and a real timeout kill.
 *
 * Commands run are instant (`true` / `false` / `exit 3`) or tightly bounded
 * (a 100ms timeout killing `sleep 1`), so there is no orphan/leak risk.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { evaluatePredicate, INTERPOLATION_VAR_NAMES } = require('../gsd-core/bin/lib/gate-predicate-evaluator.cjs');
const { evaluateCheckPredicate } = require('../gsd-core/bin/lib/gate-predicate.cjs');
const { buildPredicateDeps, parsePredicateFlags } = require('../gsd-core/bin/lib/check-command-router.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

/**
 * A real, bounded `sh -c` subprocess spawned via the production
 * runBoundedShell dependency -- the describe block's own name is "real
 * bounded sh -c subprocess."
 */
// #4378 (windows conformance lane): the local 5000ms bound timed out on a
// cold sh.exe spawn under windows-latest shard load while the identical code
// passed twice earlier the same day -- the probe now uses the class norm
// (tests/helpers/timeouts.cjs PROBE_TIMEOUT_MS) instead of a local override.
const BOUNDED_SHELL_PROBE_TIMEOUT_MS = PROBE_TIMEOUT_MS;

/**
 * The same runBoundedShell call as BOUNDED_SHELL_PROBE_TIMEOUT_MS, but
 * deliberately tiny (not generous headroom) to force a `sleep 1` command
 * past the bound within this test's own lifetime, proving "timeout kills
 * the subprocess (SIGTERM => timedOut:true)."
 */
const BOUNDED_SHELL_FORCED_TIMEOUT_MS = 100;

// ─── buildPredicateDeps: real subprocess exit mapping ─────────────────────────

describe('buildPredicateDeps — real bounded sh -c subprocess', () => {
  const deps = buildPredicateDeps();
  const cwd = process.cwd();

  test('`true` => exitCode 0, not timed out', () => {
    const r = deps.runBoundedShell({ command: 'true', cwd, timeoutMs: BOUNDED_SHELL_PROBE_TIMEOUT_MS });
    assert.equal(r.exitCode, 0);
    assert.equal(r.timedOut, false);
  });

  test('`false` => exitCode 1, not timed out', () => {
    const r = deps.runBoundedShell({ command: 'false', cwd, timeoutMs: BOUNDED_SHELL_PROBE_TIMEOUT_MS });
    assert.equal(r.exitCode, 1);
    assert.equal(r.timedOut, false);
  });

  test('`exit 3` => exitCode 3', () => {
    const r = deps.runBoundedShell({ command: 'exit 3', cwd, timeoutMs: BOUNDED_SHELL_PROBE_TIMEOUT_MS });
    assert.equal(r.exitCode, 3);
  });

  test('stderr is captured from the subprocess', () => {
    const r = deps.runBoundedShell({ command: 'echo oops >&2; exit 4', cwd, timeoutMs: BOUNDED_SHELL_PROBE_TIMEOUT_MS });
    assert.equal(r.exitCode, 4);
    assert.match(r.stderr, /oops/);
  });

  test('timeout kills the subprocess (SIGTERM => timedOut:true)', () => {
    const r = deps.runBoundedShell({ command: 'sleep 1', cwd, timeoutMs: BOUNDED_SHELL_FORCED_TIMEOUT_MS });
    assert.equal(r.timedOut, true);
    assert.equal(r.signal, 'SIGTERM');
  });
});

// ─── evaluatePredicate + production deps: end-to-end exit mapping ─────────────

describe('evaluatePredicate + production deps — command-exit-zero e2e', () => {
  const deps = buildPredicateDeps();
  const ctx = { cwd: process.cwd() };

  test('command `true` => block:false', () => {
    const res = evaluatePredicate({ kind: 'command-exit-zero', command: 'true' }, ctx, deps);
    assert.equal(res.block, false);
  });

  test('command `false` => block:true', () => {
    const res = evaluatePredicate({ kind: 'command-exit-zero', command: 'false' }, ctx, deps);
    assert.equal(res.block, true);
    assert.match(res.message, /1/);
  });

  test('interpolation reaches the real shell ($PHASE_NUMBER via flag context)', () => {
    const res = evaluatePredicate(
      { kind: 'command-exit-zero', command: 'test "${PHASE_NUMBER}" = "07" && true || false' },
      { cwd: process.cwd(), phaseNumber: '07' },
      deps,
    );
    assert.equal(res.block, false);
  });
});

// ─── parsePredicateFlags ───────────────────────────────────────────────────────

describe('parsePredicateFlags', () => {
  test('extracts --flag value pairs, skips positional + bare --flags', () => {
    const out = parsePredicateFlags(['check', 'predicate', '--predicate', '{"kind":"x"}', '--phase-number', '03', '--raw']);
    assert.deepEqual(out, { predicate: '{"kind":"x"}', 'phase-number': '03' });
  });

  test('last write wins for repeated flags', () => {
    const out = parsePredicateFlags(['--phase-number', '01', '--phase-number', '02']);
    assert.equal(out['phase-number'], '02');
  });

  test('value that starts with -- is not consumed (treated as a flag)', () => {
    const out = parsePredicateFlags(['--predicate', '--phase-number']);
    assert.equal('predicate' in out, false);
  });

  test('empty args => empty map', () => {
    assert.deepEqual(parsePredicateFlags([]), {});
  });
});

// ─── #4130 follow-up: partitionPredicateArgs (flags + positionals, one parser) ─

/**
 * `partitionPredicateArgs` is the single pass behind `parsePredicateFlags`:
 * it returns BOTH the --flag value map AND the non-consumed positional tokens
 * under the exact same skip/consume/last-wins semantics. `check
 * decision-coverage-plan --context <path>` uses it so the flag and the
 * positional surface share one parser with `check predicate` — the two
 * parsers cannot diverge because there is only one.
 */
describe('partitionPredicateArgs (#4130 follow-up)', () => {
  const { partitionPredicateArgs } = require('../gsd-core/bin/lib/check-command-router.cjs');

  test('splits --flag value pairs from positionals', () => {
    const { flags, positionals } = partitionPredicateArgs(
      ['check', 'decision-coverage-plan', '--context', '/tmp/CONTEXT.md', 'phases/01-init'],
    );
    assert.deepEqual(flags, { context: '/tmp/CONTEXT.md' });
    assert.deepEqual(positionals, ['check', 'decision-coverage-plan', 'phases/01-init']);
  });

  test('parsePredicateFlags is exactly the flags half (one source of truth)', () => {
    const vectors = [
      ['check', 'predicate', '--predicate', '{"kind":"x"}', '--phase-number', '03', '--raw'],
      ['--phase-number', '01', '--phase-number', '02'],
      ['--predicate', '--phase-number'],
      [],
      ['--context'],
      ['a', '--context', 'b', '--context', 'c', 'd'],
    ];
    for (const v of vectors) {
      assert.deepEqual(partitionPredicateArgs(v).flags, parsePredicateFlags(v),
        `flags half must equal parsePredicateFlags for ${JSON.stringify(v)}`);
    }
  });

  test('value that starts with -- is not consumed: both stay flags, neither becomes positional', () => {
    const { flags, positionals } = partitionPredicateArgs(['--context', '--other']);
    assert.deepEqual(flags, {});
    assert.deepEqual(positionals, ['--context', '--other']);
  });

  test('last write wins; flag values never leak into positionals', () => {
    const { flags, positionals } = partitionPredicateArgs(['p1', '--context', 'a', 'p2', '--context', 'b', 'p3']);
    assert.equal(flags.context, 'b');
    assert.deepEqual(positionals, ['p1', 'p2', 'p3']);
  });
});

// ─── #4354: `check predicate --phase-dir` containment boundary ───────────────
//
// cmdCheckPredicate passes the `--phase-dir` flag VERBATIM into PredicateContext
// (src/gate-predicate.cts) with no containment validation. Both predicate
// kinds read/interpolate that value: `artifact-frontmatter-equals` resolves it
// as `targetDir` for `findPhaseArtifact`, and `command-exit-zero` interpolates
// it into `${PHASE_DIR}` in the shelled-out command. These tests reproduce the
// issue's exact repro and prove the boundary is currently unconfined.

describe('check predicate --phase-dir — containment boundary (#4354)', () => {
  let projDir;
  let outsideDir;

  beforeEach(() => {
    projDir = createTempProject();
    fs.mkdirSync(path.join(projDir, '.planning', 'phases', '05-x'), { recursive: true });
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-predicate-outside-'));
  });

  afterEach(() => {
    cleanup(projDir);
    cleanup(outsideDir);
  });

  test('[RED #4354] the issue\'s exact repro: artifact-frontmatter-equals against a foreign SECURITY.md via an outside --phase-dir must be rejected, not evaluated', () => {
    fs.writeFileSync(
      path.join(outsideDir, 'SECURITY.md'),
      '---\nstatus: passed\n---\n# Security\n',
    );

    const predicate = JSON.stringify({
      kind: 'artifact-frontmatter-equals',
      artifact: 'SECURITY.md',
      field: 'status',
      equals: 'passed',
    });

    const result = runGsdTools(
      ['--json-errors', 'check', 'predicate', '--predicate', predicate, '--phase-dir', outsideDir, '--raw'],
      projDir,
    );

    // CURRENT BUG (documented, not asserted as desired): this command today
    // succeeds and prints {"block":false,...} — a BLOCKING gate passing on
    // foreign evidence read from OUTSIDE the project. REQUIRED behavior:
    // the outside --phase-dir must be rejected before evaluation.
    assert.strictEqual(
      result.success,
      false,
      `an outside --phase-dir must be rejected before evaluating the predicate ` +
        `(currently: ${result.success ? `SUCCEEDED with output ${result.output}` : 'failed for an unrelated reason'})`,
    );
  });

  test('[RED #4354] a command-exit-zero predicate interpolating ${PHASE_DIR} with an outside --phase-dir must also be rejected', () => {
    fs.writeFileSync(path.join(outsideDir, 'marker.txt'), 'outside-marker\n');

    const predicate = JSON.stringify({
      kind: 'command-exit-zero',
      command: 'test -f "${PHASE_DIR}/marker.txt"',
    });

    const result = runGsdTools(
      ['--json-errors', 'check', 'predicate', '--predicate', predicate, '--phase-dir', outsideDir, '--raw'],
      projDir,
    );

    assert.strictEqual(
      result.success,
      false,
      `a command-exit-zero predicate interpolating an outside --phase-dir must be rejected ` +
        `(currently: ${result.success ? `SUCCEEDED with output ${result.output}` : 'failed for an unrelated reason'})`,
    );
  });

  test('[regression] a valid in-project --phase-dir still evaluates', () => {
    const phaseDir = path.join(projDir, '.planning', 'phases', '05-x');
    fs.writeFileSync(
      path.join(phaseDir, 'SECURITY.md'),
      '---\nstatus: passed\n---\n# Security\n',
    );
    const predicate = JSON.stringify({
      kind: 'artifact-frontmatter-equals',
      artifact: 'SECURITY.md',
      field: 'status',
      equals: 'passed',
    });

    const result = runGsdTools(
      ['check', 'predicate', '--predicate', predicate, '--phase-dir', phaseDir, '--raw'],
      projDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.block, false, 'in-project phase-dir evaluation must still pass');
  });

  test('[regression #4652] a relative --phase-dir must resolve against --cwd, not the real process cwd, and must not leak the outside file', () => {
    // The real process cwd (outsideDir) contains a foreign SECURITY.md; the
    // CLI is told --cwd projDir with a relative --phase-dir '.'. Before #4652,
    // cmdCheckPredicate validated the joined (projDir + '.') path but passed
    // the RAW, un-joined '.' into ctx.phaseDir, which findPhaseArtifact then
    // resolved against the real process cwd (outsideDir) — leaking foreign
    // frontmatter. The fix must reject this, and the leaked value must never
    // appear in the output.
    fs.writeFileSync(
      path.join(outsideDir, 'SECURITY.md'),
      '---\nstatus: LEAKED_VALUE\n---\n# Security\n',
    );

    const predicate = JSON.stringify({
      kind: 'artifact-frontmatter-equals',
      artifact: 'SECURITY.md',
      field: 'status',
      equals: 'NOPE',
    });

    const result = runGsdTools(
      ['--json-errors', 'check', 'predicate', '--cwd', projDir, '--predicate', predicate, '--phase-dir', '.', '--raw'],
      outsideDir,
    );

    const combinedOutput = `${result.output || ''}${result.error || ''}`;
    assert.ok(
      !combinedOutput.includes('LEAKED_VALUE'),
      `the outside file's frontmatter value must never leak into the output (got: ${combinedOutput})`,
    );
    assert.strictEqual(
      result.success && JSON.parse(result.output).block === false,
      false,
      `a relative --phase-dir must not resolve against the real process cwd and must not pass ` +
        `(currently: ${combinedOutput})`,
    );
  });

  test('[#4652] a --phase-dir that is a symlink inside the project resolving outside the project is rejected', (t) => {
    fs.writeFileSync(
      path.join(outsideDir, 'SECURITY.md'),
      '---\nstatus: passed\n---\n# Security\n',
    );
    const linkPath = path.join(projDir, '.planning', 'phases', 'linked-out');
    try {
      fs.symlinkSync(outsideDir, linkPath, 'dir');
    } catch (e) {
      if (e.code === 'EPERM') {
        t.skip('symlink creation is not permitted on this platform (EPERM)');
        return;
      }
      throw e;
    }

    const predicate = JSON.stringify({
      kind: 'artifact-frontmatter-equals',
      artifact: 'SECURITY.md',
      field: 'status',
      equals: 'passed',
    });

    const result = runGsdTools(
      ['--json-errors', 'check', 'predicate', '--predicate', predicate, '--phase-dir', linkPath, '--raw'],
      projDir,
    );

    assert.strictEqual(
      result.success,
      false,
      `a --phase-dir symlink resolving outside the project must be rejected ` +
        `(currently: ${result.success ? `SUCCEEDED with output ${result.output}` : 'failed for an unrelated reason'})`,
    );
  });

  test('[#4652] a relative --phase-dir interpolates ${PHASE_DIR} as the resolved ABSOLUTE path, not the relative value', () => {
    const phaseDir = path.join(projDir, '.planning', 'phases', '05-x');
    fs.writeFileSync(path.join(phaseDir, 'marker.txt'), 'marker\n');

    const predicate = JSON.stringify({
      kind: 'command-exit-zero',
      command: 'echo "${PHASE_DIR}" > "${PHASE_DIR}/interpolated.txt"',
    });

    const result = runGsdTools(
      ['check', 'predicate', '--predicate', predicate, '--phase-dir', '.planning/phases/05-x', '--raw'],
      projDir,
    );

    assert.ok(result.success, `Command failed: ${result.error}`);
    const interpolated = fs.readFileSync(path.join(phaseDir, 'interpolated.txt'), 'utf-8').trim();
    assert.strictEqual(
      interpolated,
      fs.realpathSync(phaseDir),
      `${'${PHASE_DIR}'} must interpolate the resolved absolute path, not the relative --phase-dir value`,
    );
  });

  test('[regression] no --phase-dir at all still falls back to cwd and evaluates', () => {
    fs.writeFileSync(
      path.join(projDir, 'SECURITY.md'),
      '---\nstatus: passed\n---\n# Security\n',
    );
    const predicate = JSON.stringify({
      kind: 'artifact-frontmatter-equals',
      artifact: 'SECURITY.md',
      field: 'status',
      equals: 'passed',
    });

    const result = runGsdTools(
      ['check', 'predicate', '--predicate', predicate, '--raw'],
      projDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.block, false, 'cwd-fallback evaluation must still pass');
  });
});

// ─── Call-site parity: every shipped dispatch of `check predicate` (#4483) ────
//
// `check predicate` interpolates each name in the evaluator's INTERPOLATION_VAR_NAMES into a
// capability-declared command, and a name the caller does not pass as a flag becomes the empty
// string without any error. Each workflow writes its flags by hand, so the call sites drifted
// apart. The flags a site owes are therefore derived from the evaluator, not listed here: every
// placeholder must be forwarded unless the site's row excludes it with a reason. A placeholder
// added to the evaluator fails every site until it is forwarded or excluded, and an exclusion
// the site no longer needs fails as stale.
//
// The shipped prompt text is the product the agent runtime loads, so it is the object under test
// (`source-text-is-the-product`).

const REPO_ROOT = path.join(__dirname, '..');
// The markdown roots package.json ships to a runtime; reference documentation is not a prompt.
const SHIPPED_MARKDOWN_ROOTS = ['gsd-core', 'commands', 'agents', 'skills'];
// A dispatch is a line that invokes the subcommand (via the gsd_run shim, the gsd-tools(.cjs)
// file or "$GSD_TOOLS", with any whitespace between the words) AND passes `--predicate`; prose
// that only names the subcommand is not one. Out of reach: a command wrapped across lines, whose
// flags sit on lines this per-line scan does not join.
const PREDICATE_INVOCATION = /(?:\bgsd_run|\bgsd-tools(?:\.cjs)?"?|\$\{?GSD_TOOLS\}?"?)\s+check\s+predicate\b/;
// Forwarded context is read only as `--flag "${VAR}"` or `--flag "$VAR"` on the dispatch line
// itself: the CLI parser takes no `--flag=value`, and an unquoted value word-splits (the
// requirement IDs hold ", "), so neither spelling forwards anything.
const FORWARDED_FLAG = /(--[a-z][a-z0-9-]*) "\$(?:\{([A-Z][A-Z0-9_]*)\}|([A-Z][A-Z0-9_]*))"/g;

/** The `check predicate` flag a placeholder is read from (PHASE_REQ_IDS -> --phase-req-ids). */
const flagFor = (name) => `--${name.toLowerCase().replaceAll('_', '-')}`;
const contextPair = (name) => `${flagFor(name)}=${name}`;

// Rows are keyed by file, not by a heading: the discovery scan is the one locator for both, and
// each file holds exactly one dispatch, so rewording prose cannot break a row.
const PREDICATE_DISPATCH_SITES = [
  { point: 'execute:post', file: 'gsd-core/workflows/execute-phase/steps/verify-phase-goal.md', excluded: {} },
  { point: 'plan:post', file: 'gsd-core/workflows/plan-phase.md', excluded: {} },
  { point: 'ship:pre', file: 'gsd-core/workflows/ship.md', excluded: {
    PHASE_REQ_IDS: 'ship.md loads only init.phase-op, which emits no phase_req_ids',
  } },
  { point: 'verify:pre', file: 'gsd-core/workflows/verify-work.md', excluded: {
    // Known gap #5289, split out of #4507 by the maintainer. When verify:pre forwards the
    // phase number, this exclusion turns stale and the row fails on purpose: delete it then.
    PHASE_NUMBER: 'known gap #5289: init.verify-work returns phase_number, the dispatch omits it',
    PHASE_REQ_IDS: 'verify:pre loads only init.verify-work, which emits no phase_req_ids',
  } },
];
const WAVE_POST_PART = 'gsd-core/workflows/execute-phase/steps/wave-post-gate-hooks.md';

function readShipped(relPath) {
  return splitLines(fs.readFileSync(path.join(REPO_ROOT, ...relPath.split('/')), 'utf8'));
}

function shippedMarkdownFiles() {
  const files = [];
  for (const root of SHIPPED_MARKDOWN_ROOTS) {
    for (const entry of fs.readdirSync(path.join(REPO_ROOT, root), { recursive: true })) {
      const file = `${root}/${String(entry).split(path.sep).join('/')}`;
      if (file.endsWith('.md')) files.push(file);
    }
  }
  return files;
}

const isPredicateDispatch = (line) => PREDICATE_INVOCATION.test(line) && line.includes('--predicate');

function predicateDispatchLines(relPath) {
  return readShipped(relPath).filter(isPredicateDispatch);
}

function soleDispatchLine(relPath) {
  const lines = predicateDispatchLines(relPath);
  assert.equal(lines.length, 1, `expected exactly one predicate dispatch in ${relPath}`);
  return lines[0];
}

/** The `--flag "${VAR}"` pairs a command line forwards, as sorted `--flag=VAR` strings. */
function forwardedContext(line) {
  return [...line.matchAll(FORWARDED_FLAG)].map((m) => `${m[1]}=${m[2] ?? m[3]}`).sort();
}

/** Placeholders a dispatch neither forwards nor excludes, and exclusions it no longer needs. */
function contextGaps(line, excluded, names = INTERPOLATION_VAR_NAMES) {
  const forwarded = forwardedContext(line);
  return {
    missing: names.filter((name) => !Object.hasOwn(excluded, name) && !forwarded.includes(contextPair(name))),
    stale: Object.keys(excluded).filter((name) => !names.includes(name) || forwarded.includes(contextPair(name))),
  };
}

describe('check predicate call sites forward their phase context (#4483)', () => {
  for (const site of PREDICATE_DISPATCH_SITES) {
    test(`${site.point} (${site.file}) forwards every placeholder it does not exclude`, () => {
      for (const [name, reason] of Object.entries(site.excluded)) {
        assert.ok(typeof reason === 'string' && reason.trim() !== '', `${site.point}: exclusion ${name} needs a reason`);
      }
      assert.deepEqual(contextGaps(soleDispatchLine(site.file), site.excluded), { missing: [], stale: [] });
    });
  }

  test('negative controls: a dropped flag, a stale exclusion and a new placeholder are each reported', () => {
    const line = soleDispatchLine('gsd-core/workflows/plan-phase.md');
    const dropped = line.replace(/ --phase-dir "\$\{PHASE_DIR\}"/, '');
    assert.notEqual(dropped, line, 'the control must actually drop the flag');
    assert.deepEqual(contextGaps(dropped, {}), { missing: ['PHASE_DIR'], stale: [] });
    assert.deepEqual(contextGaps(line, { PHASE_DIR: 'control' }), { missing: [], stale: ['PHASE_DIR'] });
    assert.deepEqual(contextGaps(line, {}, [...INTERPOLATION_VAR_NAMES, 'PHASE_SLUG']), { missing: ['PHASE_SLUG'], stale: [] });
  });

  test('the dispatch matcher takes every invocation spelling and skips prose that only names it', () => {
    const spellings = [
      'GATE_RESULT=$(gsd_run  check\tpredicate --predicate \'{}\' --raw)',
      'node "$GSD_DIR/bin/gsd-tools.cjs" check predicate --predicate \'{}\'',
      'gsd-tools check predicate --predicate \'{}\'',
      '"$GSD_TOOLS" check predicate --predicate \'{}\'',
    ];
    for (const line of spellings) assert.ok(isPredicateDispatch(line), `not matched: ${line}`);
    assert.equal(isPredicateDispatch('the `gsd_run check predicate` subcommand evaluates a gate'), false);
  });

  test('every shipped predicate dispatch has a row, and every row a dispatch', () => {
    const dispatching = {};
    for (const file of shippedMarkdownFiles()) {
      const count = predicateDispatchLines(file).length;
      if (count > 0) dispatching[file] = count;
    }
    const declared = {};
    for (const { file } of PREDICATE_DISPATCH_SITES) declared[file] = (declared[file] ?? 0) + 1;
    const sorted = (counts) => Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
    assert.deepEqual(sorted(dispatching), sorted(declared));
  });

  // Known gap #5290, split out of #4507: the part runs only the named-query form and has no
  // predicate dispatch of its own. Fixing #5290 adds one, which fails this test and the discovery
  // test on purpose: then add an execute:wave:post row to the table and delete this test.
  test('execute:wave:post has no predicate dispatch yet, only the named-query form (#5290)', () => {
    assert.deepEqual(predicateDispatchLines(WAVE_POST_PART), [],
      'wave-post-gate-hooks.md gained a predicate dispatch: add a row for execute:wave:post');
    const queryDispatch = readShipped(WAVE_POST_PART).filter((line) => line.includes('gsd_run check ${hook.check.query}'));
    assert.equal(queryDispatch.length, 1, 'expected exactly one named-query dispatch');
    assert.deepEqual(forwardedContext(queryDispatch[0]), []);
  });
});

// The same dispatch lines, run through the real flag parsing and evaluator in-process: each
// placeholder a site forwards must reach the command non-empty, and each one it excludes stays
// empty. This also proves flagFor() names the flag `check predicate` actually reads.
describe('check predicate call sites resolve their placeholders through the real CLI (#4483)', () => {
  const SENTINELS = {
    PHASE_NUMBER: '07',
    PHASE_DIR: path.join('.planning', 'phases', '07-sentinel'),
    PHASE_REQ_IDS: 'REQ-01, REQ-02',
  };
  let projDir;

  beforeEach(() => {
    projDir = createTempProject();
    fs.mkdirSync(path.join(projDir, SENTINELS.PHASE_DIR), { recursive: true });
  });

  afterEach(() => {
    cleanup(projDir);
  });

  for (const site of PREDICATE_DISPATCH_SITES) {
    test(`${site.point}: forwarded placeholders resolve non-empty, excluded ones stay empty`, () => {
      const flagArgs = forwardedContext(soleDispatchLine(site.file)).flatMap((pair) => {
        const [flag, name] = pair.split('=');
        return [flag, SENTINELS[name]];
      });
      for (const name of INTERPOLATION_VAR_NAMES) {
        assert.ok(Object.hasOwn(SENTINELS, name), `no sentinel value for placeholder ${name}`);
        const predicate = JSON.stringify({ kind: 'command-exit-zero', command: `test -n "\${${name}}"` });
        const verdict = evaluateCheckPredicate({ projectDir: projDir, args: ['--predicate', predicate, ...flagArgs, '--raw'] });
        assert.equal(verdict.failure, undefined, `${site.point}: check predicate failed: ${JSON.stringify(verdict.failure)}`);
        assert.equal(verdict.block, Object.hasOwn(site.excluded, name),
          `${site.point}: \${${name}} must be ${Object.hasOwn(site.excluded, name) ? 'empty (excluded)' : 'non-empty'}`);
      }
    });
  }
});
