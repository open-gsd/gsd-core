'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempGitProject, createTempDir, cleanup, runGsdTools } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');

const VERIFY_PATH = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'verify.cjs');
const { computeContextDrift } = require(VERIFY_PATH);

describe('computeContextDrift', () => {
  test('returns no stale artifacts when there is nothing to compare', () => {
    assert.deepStrictEqual(computeContextDrift(1000, []), []);
  });

  test('treats a newer upstream artifact as fresh', () => {
    const stale = computeContextDrift(1000, [{ file: '01-RESEARCH.md', effectiveMs: 2000 }]);
    assert.deepStrictEqual(stale, []);
  });

  test('flags an upstream artifact older than CONTEXT.md', () => {
    const stale = computeContextDrift(2000, [{ file: '01-RESEARCH.md', effectiveMs: 1000 }]);
    assert.deepStrictEqual(stale, ['01-RESEARCH.md']);
  });

  test('reports exactly the stale subset, not all entries', () => {
    const stale = computeContextDrift(2000, [
      { file: '01-RESEARCH.md', effectiveMs: 1000 },
      { file: '01-PATTERNS.md', effectiveMs: 3000 },
      { file: '01-VALIDATION.md', effectiveMs: 500 },
    ]);
    assert.deepStrictEqual(stale, ['01-RESEARCH.md', '01-VALIDATION.md']);
  });

  test('treats an equal timestamp as not stale (strict greater-than)', () => {
    const stale = computeContextDrift(2000, [{ file: '01-RESEARCH.md', effectiveMs: 2000 }]);
    assert.deepStrictEqual(stale, []);
  });

  test('flags an artifact exactly one second (1000ms) older', () => {
    const stale = computeContextDrift(2000, [{ file: '01-RESEARCH.md', effectiveMs: 1000 }]);
    assert.deepStrictEqual(stale, ['01-RESEARCH.md']);
  });

  test('treats an artifact exactly one second (1000ms) newer as fresh', () => {
    const stale = computeContextDrift(2000, [{ file: '01-RESEARCH.md', effectiveMs: 3000 }]);
    assert.deepStrictEqual(stale, []);
  });

  test('handles an empty entries array without throwing', () => {
    assert.doesNotThrow(() => computeContextDrift(0, []));
  });

  test('does not throw on a zero or negative timestamp', () => {
    assert.deepStrictEqual(computeContextDrift(0, [{ file: 'a.md', effectiveMs: -5 }]), ['a.md']);
    assert.deepStrictEqual(computeContextDrift(-5, [{ file: 'a.md', effectiveMs: 0 }]), []);
  });
});

describe('verify context-drift CLI', () => {
  let tmp;
  beforeEach(() => {
    tmp = createTempGitProject('gsd-context-drift-cli-');
  });
  afterEach(() => cleanup(tmp));

  function phaseDirPath(name) {
    return path.join(tmp, '.planning', 'phases', name);
  }

  test('errors with usage message on missing phase arg', () => {
    const r = runGsdTools(['verify', 'context-drift'], tmp);
    assert.strictEqual(r.success, false);
    assert.match(r.error || '', /Usage: verify context-drift <phase>/);
  });

  test('treats an empty phase arg as missing', () => {
    const r = runGsdTools(['verify', 'context-drift', ''], tmp);
    assert.strictEqual(r.success, false);
    assert.match(r.error || '', /Usage: verify context-drift <phase>/);
  });

  test('treats a whitespace phase arg as not found, not a usage error', () => {
    const r = runGsdTools(['verify', 'context-drift', '   '], tmp);
    assert.strictEqual(r.exitCode, 69, `a phase that does not resolve is could-not-look: UNAVAILABLE with the non-blocking JSON (#5170): ${r.error}`);
    const data = JSON.parse(r.output);
    assert.strictEqual(data.skipped, true);
    assert.strictEqual(data.reason, 'phase-not-found');
  });

  test('degrades gracefully for an unresolvable phase', () => {
    const r = runGsdTools(['verify', 'context-drift', '99'], tmp);
    assert.strictEqual(r.exitCode, 69, `a phase that does not resolve is could-not-look: UNAVAILABLE with the non-blocking JSON (#5170): ${r.error}`);
    const data = JSON.parse(r.output);
    assert.strictEqual(data.skipped, true);
    assert.strictEqual(data.reason, 'phase-not-found');
    assert.strictEqual(data.block, false);
  });

  test('does not interpret shell metacharacters in the phase arg', () => {
    const r = runGsdTools(['verify', 'context-drift', '1; echo pwned'], tmp);
    assert.strictEqual(r.exitCode, 69, `a phase that does not resolve is could-not-look: UNAVAILABLE with the non-blocking JSON (#5170): ${r.error}`);
    const data = JSON.parse(r.output);
    assert.strictEqual(data.skipped, true);
    assert.strictEqual(data.reason, 'phase-not-found');
  });

  test('does not path-traverse via a hostile phase arg', () => {
    const r = runGsdTools(['verify', 'context-drift', '../../etc'], tmp);
    assert.strictEqual(r.exitCode, 69, `a phase that does not resolve is could-not-look: UNAVAILABLE with the non-blocking JSON (#5170): ${r.error}`);
    const data = JSON.parse(r.output);
    assert.strictEqual(data.skipped, true);
    assert.strictEqual(data.reason, 'phase-not-found');
  });

  test('does not escape phasesDir via a deep traversal payload that would otherwise resolve to a real path', () => {
    // Deep enough that path.join's .. collapsing would reach outside the temp
    // sandbox entirely (unlike a shallow '../../etc', which lands harmlessly
    // inside the sandbox as a nonexistent path and would pass for the wrong
    // reason). validatePath must reject this by real-path containment, not by
    // accidental non-existence.
    const r = runGsdTools(['verify', 'context-drift', '../../../../../../../../../../etc'], tmp);
    assert.strictEqual(r.exitCode, 69, `a phase that does not resolve is could-not-look: UNAVAILABLE with the non-blocking JSON (#5170): ${r.error}`);
    const data = JSON.parse(r.output);
    assert.strictEqual(data.skipped, true);
    assert.strictEqual(data.reason, 'phase-not-found');
  });

  test('skips when no CONTEXT.md exists', () => {
    const dir = phaseDirPath('01-setup');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '01-RESEARCH.md'), '# research\n');
    const r = runGsdTools(['verify', 'context-drift', '01-setup'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    assert.strictEqual(data.skipped, true);
    assert.strictEqual(data.reason, 'no-context-md');
    assert.strictEqual(data.block, false);
  });

  test('skips when no upstream artifacts exist', () => {
    const dir = phaseDirPath('01-setup');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '01-CONTEXT.md'), '# context\n');
    const r = runGsdTools(['verify', 'context-drift', '01-setup'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    assert.strictEqual(data.skipped, true);
    assert.strictEqual(data.reason, 'no-upstream-artifacts');
  });

  test('excludes AI-SPEC.md and UI-SPEC.md from the SPEC.md comparison', () => {
    const dir = phaseDirPath('01-setup');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '01-CONTEXT.md'), '# context\n');
    fs.writeFileSync(path.join(dir, '01-AI-SPEC.md'), '# ai spec\n');
    fs.writeFileSync(path.join(dir, '01-UI-SPEC.md'), '# ui spec\n');
    const r = runGsdTools(['verify', 'context-drift', '01-setup'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    assert.strictEqual(data.skipped, true);
    assert.strictEqual(data.reason, 'no-upstream-artifacts');
  });

  test('degrades to mtime comparison outside a git repo', () => {
    const plain = createTempDir('gsd-context-drift-nogit-');
    try {
      const dir = path.join(plain, '.planning', 'phases', '01-setup');
      fs.mkdirSync(dir, { recursive: true });
      // Deterministic mtimes (CONTRIBUTING.md: never assert elapsed wall-clock
      // time) — two back-to-back writeFileSync calls can land in the SAME
      // mtime granularity tick on a fast filesystem, producing a tie that
      // computeContextDrift's strict `<` correctly treats as not-stale. Set
      // distinct mtimes explicitly instead of relying on real timing.
      const now = Date.now();
      fs.writeFileSync(path.join(dir, '01-RESEARCH.md'), '# research\n');
      fs.utimesSync(path.join(dir, '01-RESEARCH.md'), new Date(now - 5000), new Date(now - 5000));
      fs.writeFileSync(path.join(dir, '01-CONTEXT.md'), '# context\n');
      fs.utimesSync(path.join(dir, '01-CONTEXT.md'), new Date(now), new Date(now));
      const r = runGsdTools(['verify', 'context-drift', '01-setup'], plain);
      assert.strictEqual(r.success, true, r.error);
      const data = JSON.parse(r.output);
      assert.strictEqual(data.skipped, false);
      assert.deepStrictEqual(data.stale_artifacts, ['01-RESEARCH.md']);
    } finally {
      cleanup(plain);
    }
  });

  test('degrades to mtime comparison in a repo with no commits', () => {
    const dir = phaseDirPath('01-setup');
    fs.mkdirSync(dir, { recursive: true });
    // Deterministic mtimes — see the identical rationale in 'degrades to mtime
    // comparison outside a git repo' above.
    const now = Date.now();
    fs.writeFileSync(path.join(dir, '01-RESEARCH.md'), '# research\n');
    fs.utimesSync(path.join(dir, '01-RESEARCH.md'), new Date(now - 5000), new Date(now - 5000));
    fs.writeFileSync(path.join(dir, '01-CONTEXT.md'), '# context\n');
    fs.utimesSync(path.join(dir, '01-CONTEXT.md'), new Date(now), new Date(now));
    const r = runGsdTools(['verify', 'context-drift', '01-setup'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    assert.strictEqual(data.skipped, false);
    assert.deepStrictEqual(data.stale_artifacts, ['01-RESEARCH.md']);
  });

  test('fresh RESEARCH.md (committed after CONTEXT.md) is not flagged', () => {
    const dir = phaseDirPath('01-setup');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '01-CONTEXT.md'), '# context\nD-01\n');
    gitOrThrow(['add', '.'], { cwd: tmp });
    gitOrThrow(['commit', '-m', 'context'], { cwd: tmp });
    fs.writeFileSync(path.join(dir, '01-RESEARCH.md'), '# research\n');
    gitOrThrow(['add', '.'], { cwd: tmp });
    gitOrThrow(['commit', '-m', 'research'], { cwd: tmp });
    const r = runGsdTools(['verify', 'context-drift', '01-setup'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    assert.strictEqual(data.skipped, false);
    assert.deepStrictEqual(data.stale_artifacts, []);
    assert.strictEqual(data.block, false);
  });

  test('uses mtime, not a stale commit time, for a dirty CONTEXT.md', () => {
    const dir = phaseDirPath('01-setup');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '01-CONTEXT.md'), '# context\nD-01\n');
    fs.writeFileSync(path.join(dir, '01-RESEARCH.md'), '# research\n');
    gitOrThrow(['add', '.'], { cwd: tmp });
    gitOrThrow(['commit', '-m', 'context+research'], { cwd: tmp });
    fs.appendFileSync(path.join(dir, '01-CONTEXT.md'), 'D-02\n');
    const r = runGsdTools(['verify', 'context-drift', '01-setup'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    assert.strictEqual(data.skipped, false);
    assert.deepStrictEqual(data.stale_artifacts, ['01-RESEARCH.md']);
  });

  test('#3348 regression: uncommitted new decisions flag existing RESEARCH and PATTERNS as stale', () => {
    const dir = phaseDirPath('03-feature');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '03-CONTEXT.md'), '# context\nD-01\nD-02\n...\nD-09\n');
    fs.writeFileSync(path.join(dir, '03-RESEARCH.md'), '# research from D-01..D-09\n');
    fs.writeFileSync(path.join(dir, '03-PATTERNS.md'), '# patterns from D-01..D-09\n');
    gitOrThrow(['add', '.'], { cwd: tmp });
    gitOrThrow(['commit', '-m', 'phase 3: context, research, patterns'], { cwd: tmp });
    fs.appendFileSync(path.join(dir, '03-CONTEXT.md'), 'D-10\nD-11\nD-12\nD-13\n');
    const r = runGsdTools(['verify', 'context-drift', '03-feature'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    assert.strictEqual(data.skipped, false);
    assert.deepStrictEqual(
      data.stale_artifacts.slice().sort(),
      ['03-PATTERNS.md', '03-RESEARCH.md'],
    );
  });

  test('defaults to warn when config.json is absent', () => {
    const dir = phaseDirPath('03-feature');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '03-CONTEXT.md'), '# context\n');
    fs.writeFileSync(path.join(dir, '03-RESEARCH.md'), '# research\n');
    gitOrThrow(['add', '.'], { cwd: tmp });
    gitOrThrow(['commit', '-m', 'research'], { cwd: tmp });
    fs.appendFileSync(path.join(dir, '03-CONTEXT.md'), 'D-99\n');
    assert.ok(!fs.existsSync(path.join(tmp, '.planning', 'config.json')));
    const r = runGsdTools(['verify', 'context-drift', '03-feature'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    assert.strictEqual(data.action, 'warn');
    assert.strictEqual(data.block, false);
  });

  test('defaults to warn when config.json is malformed', () => {
    const dir = phaseDirPath('03-feature');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(tmp, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.planning', 'config.json'), '{ not valid json');
    fs.writeFileSync(path.join(dir, '03-CONTEXT.md'), '# context\n');
    fs.writeFileSync(path.join(dir, '03-RESEARCH.md'), '# research\n');
    gitOrThrow(['add', '.'], { cwd: tmp });
    gitOrThrow(['commit', '-m', 'research'], { cwd: tmp });
    fs.appendFileSync(path.join(dir, '03-CONTEXT.md'), 'D-99\n');
    const r = runGsdTools(['verify', 'context-drift', '03-feature'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    assert.strictEqual(data.action, 'warn');
    assert.strictEqual(data.block, false);
  });

  test('falls back to warn for an unrecognized context_drift_action value', () => {
    const dir = phaseDirPath('03-feature');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(tmp, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.planning', 'config.json'),
      JSON.stringify({ workflow: { context_drift_action: 'yolo' } }),
    );
    fs.writeFileSync(path.join(dir, '03-CONTEXT.md'), '# context\n');
    fs.writeFileSync(path.join(dir, '03-RESEARCH.md'), '# research\n');
    gitOrThrow(['add', '.'], { cwd: tmp });
    gitOrThrow(['commit', '-m', 'research'], { cwd: tmp });
    fs.appendFileSync(path.join(dir, '03-CONTEXT.md'), 'D-99\n');
    const r = runGsdTools(['verify', 'context-drift', '03-feature'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    assert.strictEqual(data.action, 'warn');
    assert.strictEqual(data.block, false);
  });

  test('sets block:true when context_drift_action is block and drift is found', () => {
    const dir = phaseDirPath('03-feature');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(tmp, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.planning', 'config.json'),
      JSON.stringify({ workflow: { context_drift_action: 'block' } }),
    );
    fs.writeFileSync(path.join(dir, '03-CONTEXT.md'), '# context\n');
    fs.writeFileSync(path.join(dir, '03-RESEARCH.md'), '# research\n');
    gitOrThrow(['add', '.'], { cwd: tmp });
    gitOrThrow(['commit', '-m', 'research'], { cwd: tmp });
    fs.appendFileSync(path.join(dir, '03-CONTEXT.md'), 'D-99\n');
    const r = runGsdTools(['verify', 'context-drift', '03-feature'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    assert.strictEqual(data.action, 'block');
    assert.strictEqual(data.block, true);
  });

  test('never blocks when nothing is stale, even with action:block', () => {
    const dir = phaseDirPath('03-feature');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(tmp, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.planning', 'config.json'),
      JSON.stringify({ workflow: { context_drift_action: 'block' } }),
    );
    fs.writeFileSync(path.join(dir, '03-CONTEXT.md'), '# context\n');
    gitOrThrow(['add', '.'], { cwd: tmp });
    gitOrThrow(['commit', '-m', 'context'], { cwd: tmp });
    fs.writeFileSync(path.join(dir, '03-RESEARCH.md'), '# research\n');
    gitOrThrow(['add', '.'], { cwd: tmp });
    gitOrThrow(['commit', '-m', 'research'], { cwd: tmp });
    const r = runGsdTools(['verify', 'context-drift', '03-feature'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    assert.deepStrictEqual(data.stale_artifacts, []);
    assert.strictEqual(data.block, false);
  });

  test('honors --raw', () => {
    const dir = phaseDirPath('01-setup');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '01-CONTEXT.md'), '# context\n');
    const r = runGsdTools(['verify', 'context-drift', '01-setup', '--raw'], tmp);
    assert.strictEqual(r.success, true, r.error);
  });

  // The CLI's own workstream policy rejects a bad GSD_WORKSTREAM before any verb runs, so the
  // verb's non-blocking arm is reached by calling the command function directly in a child
  // process (planningDir is what throws on '../x').
  function runVerbDirect(env) {
    const { spawnSync } = require('node:child_process');
    const { TEST_ENV_BASE } = require('./helpers.cjs');
    const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
    const script = `require(${JSON.stringify(VERIFY_PATH)}).cmdVerifyContextDrift(${JSON.stringify(tmp)}, '01-setup', false);`;
    return spawnSync(process.execPath, ['-e', script], {
      cwd: tmp,
      encoding: 'utf-8',
      timeout: PROBE_TIMEOUT_MS,
      env: { ...process.env, ...TEST_ENV_BASE, HOME: tmp, USERPROFILE: tmp, GSD_WORKSTREAM: '', ...env },
    });
  }

  test('an invalid GSD_WORKSTREAM is the non-blocking skip payload, exit 0 (planningDir throws)', () => {
    const r = runVerbDirect({ GSD_WORKSTREAM: '../x' });
    assert.strictEqual(r.status, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.strictEqual(data.block, false);
    assert.strictEqual(data.skipped, true);
    assert.match(data.reason, /^exception: .*GSD_WORKSTREAM contains invalid path characters/);
    assert.deepStrictEqual(data.stale_artifacts, []);
    assert.strictEqual(data.message, '');
  });

  test('a valid GSD_WORKSTREAM still resolves that workstream (control)', () => {
    const dir = path.join(tmp, '.planning', 'workstreams', 'ws1', 'phases', '01-setup');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '01-CONTEXT.md'), '# context\n');
    const r = runVerbDirect({ GSD_WORKSTREAM: 'ws1' });
    assert.strictEqual(r.status, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.strictEqual(data.skipped, true);
    assert.strictEqual(data.reason, 'no-upstream-artifacts');
  });

  test('never exits with a failure code: a phase that does not resolve is UNAVAILABLE, not an error (#5170)', () => {
    // A missing phase arg is a DIFFERENT, already-covered contract ('errors with usage message on
    // missing phase arg' above asserts exitCode !== 0 / r.success === false for exactly that case).
    // A phase that does not resolve is the gate saying "could not look": the non-blocking JSON is
    // printed and the exit status is UNAVAILABLE (69) — which the plan-phase consumer treats as a
    // skipped, advisory check (it never halts planning), not as a command error.
    const cases = [
      ['verify', 'context-drift', '99'],
    ];
    for (const args of cases) {
      const r = runGsdTools(args, tmp);
      assert.strictEqual(r.exitCode, 69, `args=${JSON.stringify(args)} exitCode=${r.exitCode}`);
      assert.strictEqual(JSON.parse(r.output).block, false, 'the payload stays non-blocking');
    }
  });

  // The `none` policy is shared with `verify schema-drift`: an ABSENT `.planning/phases` is the
  // documented skip (nothing to compare), never "could not look".
  test('an absent .planning/phases is the documented skip, exit 0 — the same answer schema-drift gives (#5170)', () => {
    cleanup(path.join(tmp, '.planning', 'phases'));
    assert.ok(!fs.existsSync(path.join(tmp, '.planning', 'phases')), 'precondition: no phases tree');
    const ctx = runGsdTools(['verify', 'context-drift', '01'], tmp);
    assert.strictEqual(ctx.exitCode, 0, ctx.error);
    const data = JSON.parse(ctx.output);
    assert.strictEqual(data.skipped, true);
    assert.strictEqual(data.reason, 'no-phases-directory');
    assert.strictEqual(data.block, false);
    const schema = runGsdTools(['verify', 'schema-drift', '01'], tmp);
    assert.strictEqual(schema.exitCode, ctx.exitCode, 'both drift gates agree on the policy for an absent phases tree');
    assert.strictEqual(JSON.parse(schema.output).message, 'No phases directory');
    assert.strictEqual(JSON.parse(schema.output).block, false);
  });

  test('a phases tree that exists but cannot be examined is unreadable, not a skip (#5170)', () => {
    const { spawnSync } = require('node:child_process');
    const { TEST_ENV_BASE } = require('./helpers.cjs');
    const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
    const phasesDir = path.join(tmp, '.planning', 'phases');
    fs.mkdirSync(phasesDir, { recursive: true });
    // The failure is injected by monkeypatching fs.statSync in the child (never a chmod: root ignores
    // mode bits); the patch is local to that process.
    const script = [
      "const fs = require('node:fs');",
      'const real = fs.statSync;',
      `fs.statSync = function (p, ...rest) { if (String(p) === ${JSON.stringify(phasesDir)}) { throw Object.assign(new Error('EACCES: injected'), { code: 'EACCES' }); } return real.call(fs, p, ...rest); };`,
      `require(${JSON.stringify(VERIFY_PATH)}).cmdVerifyContextDrift(${JSON.stringify(tmp)}, '01', false);`,
    ].join('\n');
    const r = spawnSync(process.execPath, ['-e', script], {
      cwd: tmp,
      encoding: 'utf-8',
      timeout: PROBE_TIMEOUT_MS,
      env: { ...process.env, ...TEST_ENV_BASE, HOME: tmp, USERPROFILE: tmp, GSD_WORKSTREAM: '' },
    });
    const data = JSON.parse(r.stdout);
    assert.strictEqual(data.skipped, true);
    assert.strictEqual(data.reason, 'phases-dir-unreadable', 'the unreadable arm, not the documented skip (no-phases-directory)');
    assert.strictEqual(data.block, false, 'the payload stays non-blocking');
  });
});

// `verify context-drift` reads `workflow.context_drift_action` through the quiet gate-config reader
// (#5139, epic #5056, ADR-5057 Phase 6 review finding: it parsed config.json by hand, the same
// class as the router's old `readWorkflowConfig`). The nested key is validated exactly as before
// (`block`, anything else -> `warn`); a missing or MALFORMED config.json is "key absent" and writes
// NOTHING to stderr; and config is workstream-aware through the resolver `config-get` shares: with
// GSD_WORKSTREAM the workstream's config.json is read first, then the project root's.
describe('verify context-drift: workflow.context_drift_action through the gate-config reader (#5139)', () => {
  const { spawnSync } = require('node:child_process');
  const { TEST_ENV_BASE } = require('./helpers.cjs');
  const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
  const TOOLS = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

  let tmp;
  beforeEach(() => { tmp = createTempGitProject('gsd-ctx-drift-cfg-'); });
  afterEach(() => cleanup(tmp));

  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
    fs.writeFileSync(path.join(tmp, rel), text);
  };

  /** A phase whose RESEARCH is older than its CONTEXT (stale), under `planning` ('.planning' or a workstream dir). */
  function stalePhase(planning = '.planning') {
    const dir = `${planning}/phases/03-feature`;
    write(`${dir}/03-CONTEXT.md`, '# context\n');
    write(`${dir}/03-RESEARCH.md`, '# research\n');
    gitOrThrow(['add', '-A'], { cwd: tmp });
    gitOrThrow(['commit', '-m', 'context and research'], { cwd: tmp });
    fs.appendFileSync(path.join(tmp, dir, '03-CONTEXT.md'), 'D-99\n');
  }

  function drift(workstream) {
    const r = spawnSync(process.execPath, [TOOLS, 'verify', 'context-drift', '03-feature'], {
      cwd: tmp,
      encoding: 'utf-8',
      timeout: PROBE_TIMEOUT_MS,
      env: { ...process.env, ...TEST_ENV_BASE, HOME: tmp, USERPROFILE: tmp, GSD_WORKSTREAM: workstream ?? '' },
    });
    assert.equal(r.status, 0, `verify context-drift failed: ${r.stderr}`);
    return { data: JSON.parse(r.stdout), stderr: r.stderr };
  }

  test('nested block is honoured: stale drift blocks, nothing on stderr', () => {
    write('.planning/config.json', JSON.stringify({ workflow: { context_drift_action: 'block' } }));
    stalePhase();
    const { data, stderr } = drift();
    assert.equal(data.action, 'block');
    assert.equal(data.block, true);
    assert.deepStrictEqual(data.stale_artifacts, ['03-RESEARCH.md']);
    assert.equal(stderr, '');
  });

  for (const [label, text] of [
    ['an unrecognised value', JSON.stringify({ workflow: { context_drift_action: 'yolo' } })],
    ['a non-string value', JSON.stringify({ workflow: { context_drift_action: true } })],
    ['a TOP-LEVEL key (not a workflow.* key)', JSON.stringify({ context_drift_action: 'block' })],
    ['an empty config', '{}'],
  ]) {
    test(`${label} -> warn, no block`, () => {
      write('.planning/config.json', text);
      stalePhase();
      const { data } = drift();
      assert.equal(data.action, 'warn');
      assert.equal(data.block, false);
    });
  }

  for (const text of ['{ not json', '', '{"workflow": ', '[1, 2', 'null']) {
    test(`a malformed config.json ${JSON.stringify(text)} -> warn, nothing on stderr`, () => {
      write('.planning/config.json', text);
      stalePhase();
      const { data, stderr } = drift();
      assert.equal(data.action, 'warn');
      assert.equal(data.block, false);
      assert.equal(stderr, '', 'a malformed config is an absent key, not a warning');
    });
  }

  test('workstream: the workstream config.json is read (block) when GSD_WORKSTREAM is set', () => {
    write('.planning/config.json', '{}');
    write('.planning/workstreams/ws1/config.json', JSON.stringify({ workflow: { context_drift_action: 'block' } }));
    stalePhase('.planning/workstreams/ws1');
    const { data, stderr } = drift('ws1');
    assert.equal(data.action, 'block');
    assert.equal(data.block, true);
    assert.equal(stderr, '');
  });

  test('workstream: the workstream value wins over the project root value', () => {
    write('.planning/config.json', JSON.stringify({ workflow: { context_drift_action: 'block' } }));
    write('.planning/workstreams/ws1/config.json', JSON.stringify({ workflow: { context_drift_action: 'warn' } }));
    stalePhase('.planning/workstreams/ws1');
    assert.equal(drift('ws1').data.action, 'warn');
  });

  test('workstream: a workstream config without the key falls back to the project root (as config-get does)', () => {
    write('.planning/config.json', JSON.stringify({ workflow: { context_drift_action: 'block' } }));
    write('.planning/workstreams/ws1/config.json', '{}');
    stalePhase('.planning/workstreams/ws1');
    assert.equal(drift('ws1').data.action, 'block');
  });

  test('workstream: a malformed workstream config is an absent key and the root value still applies, silently', () => {
    write('.planning/config.json', JSON.stringify({ workflow: { context_drift_action: 'block' } }));
    write('.planning/workstreams/ws1/config.json', '{ not json');
    stalePhase('.planning/workstreams/ws1');
    const { data, stderr } = drift('ws1');
    assert.equal(data.action, 'block');
    assert.equal(stderr, '');
  });
});
