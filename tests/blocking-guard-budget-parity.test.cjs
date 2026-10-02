'use strict';

/**
 * Drift guard for blocking PreToolUse guard budgets (#5180, follow-up to
 * #3981 / #4175).
 *
 * Claude Code documents that a timed-out hook does NOT block the tool call, so
 * a blocking guard registered with a small host budget, or one whose own git
 * probe budget is sized to the happy path, silently allows the call it exists
 * to deny. #4175 raised the installer's budget for the blocking guards; this
 * file pins that every other registration surface agrees with the installer
 * (read from the REAL installer output, not a second hand-kept number) and that
 * the guards' internal probe budget x probe count fits inside both the host
 * budget and the test helper's bound.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const fc = require('./helpers/fast-check-setup.cjs');
const { runMinimalInstall } = require('./helpers/install-shared.cjs');
const { cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { STAGED_HOOK_SCRIPT_TIMEOUT_MS, GIT_FIXTURE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const {
  BLOCKING_GUARD_PROBE_TIMEOUT_MS,
  BLOCKING_GUARD_MAX_SEQUENTIAL_PROBES,
} = require('../hooks/lib/git-probe.js');

// The blocking-guard name lists and host budget come from the installer's own
// module (the single source every registration surface shares), not from
// literals restated here.
const {
  BLOCKING_GUARD_TIMEOUT_S: HOST_BUDGET_SECONDS,
  BLOCKING_GUARD_NAMES,
  KIMI_BLOCKING_GUARD_NAMES,
  KIMI_UNREGISTERED_BLOCKING_GUARDS,
} = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');

// Advisory hook: negative control (must NOT be raised to the blocking budget).
const ADVISORY_PRETOOL = ['gsd-read-guard'];

const HOOKS_DIR = path.join(__dirname, '..', 'hooks');
// `node --require` preload that records the `timeout` each git spawn receives.
const RECORDER = path.join(__dirname, 'helpers', 'spawn-timeout-recorder.cjs');

function hookName(command) {
  const m = /gsd-[a-z-]+(?=\.(?:js|sh))/.exec(command || '');
  return m ? m[0] : null;
}

function collect(hooksByEvent) {
  const out = new Map();
  for (const entries of Object.values(hooksByEvent)) {
    for (const entry of entries) {
      for (const h of entry.hooks) {
        const name = hookName(h.command);
        if (name) out.set(name, h.timeout);
      }
    }
  }
  return out;
}

function pluginTimeouts() {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8'));
  return collect(cfg.hooks);
}

function installerTimeouts(t) {
  const { configDir, root } = runMinimalInstall({ runtime: 'claude', scope: 'global' });
  t.after(() => cleanup(root));
  const settings = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8'));
  return collect(settings.hooks);
}

describe('blocking guard host budgets agree with the installer (#5180)', () => {
  test('installer registers the reference blocking guard at the host budget', (t) => {
    const installer = installerTimeouts(t);
    assert.strictEqual(HOST_BUDGET_SECONDS, 120);
    for (const name of BLOCKING_GUARD_NAMES) {
      assert.strictEqual(installer.get(name), HOST_BUDGET_SECONDS, `installer registers ${name} at ${installer.get(name)}s`);
    }
  });

  test('plugin hooks.json registers every blocking guard at exactly the installer budget', (t) => {
    const installer = installerTimeouts(t);
    const budget = installer.get('gsd-worktree-path-guard');
    const plugin = pluginTimeouts();
    // hooks/hooks.json registers a subset of the shared list (not the workflow
    // guard or commit validator, which the installer adds); every one it does
    // register must carry the host budget.
    const pluginBlocking = BLOCKING_GUARD_NAMES.filter((name) => plugin.has(name));
    assert.ok(pluginBlocking.includes('gsd-agent-isolation-guard') && pluginBlocking.length >= 5,
      `hooks/hooks.json must register the blocking guards; found ${pluginBlocking.join(', ')}`);
    for (const name of pluginBlocking) {
      assert.strictEqual(plugin.get(name), HOST_BUDGET_SECONDS,
        `hooks/hooks.json registers ${name} at ${plugin.get(name)}s; expected ${HOST_BUDGET_SECONDS}s ` +
        `(installer uses ${budget}s; a timed-out hook does not block, #3981)`);
      assert.ok(plugin.get(name) >= budget);
    }
  });

  test('negative control: an advisory hook is NOT held to the blocking budget', () => {
    const plugin = pluginTimeouts();
    for (const name of ADVISORY_PRETOOL) {
      assert.ok(plugin.get(name) < HOST_BUDGET_SECONDS,
        `${name} is advisory and must keep its small budget; the discriminator would be vacuous otherwise`);
    }
  });

  test('kimi config.toml registers every blocking guard at exactly the installer budget', (t) => {
    const { root } = runMinimalInstall({ runtime: 'kimi', scope: 'global' });
    t.after(() => cleanup(root));
    const toml = fs.readFileSync(path.join(root, '.kimi', 'config.toml'), 'utf8');
    const seen = new Map();
    for (const block of toml.split('[[hooks]]').slice(1)) {
      const name = hookName((/^command = "(.*)"$/m.exec(block) || [])[1]);
      const timeout = /^timeout = (\d+)$/m.exec(block);
      if (name) seen.set(name, timeout ? Number(timeout[1]) : undefined);
    }
    // Intentional divergence from the installer's set, stated by the module.
    assert.deepStrictEqual(
      BLOCKING_GUARD_NAMES.filter((name) => !KIMI_BLOCKING_GUARD_NAMES.includes(name)),
      [...KIMI_UNREGISTERED_BLOCKING_GUARDS],
    );
    for (const name of KIMI_UNREGISTERED_BLOCKING_GUARDS) {
      assert.ok(!seen.has(name), `kimi config.toml must not register ${name}`);
    }
    for (const name of KIMI_BLOCKING_GUARD_NAMES) {
      assert.strictEqual(seen.get(name), HOST_BUDGET_SECONDS,
        `kimi config.toml registers ${name} at ${seen.get(name)}s; expected ${HOST_BUDGET_SECONDS}s`);
    }
    assert.ok(seen.get('gsd-read-guard') < HOST_BUDGET_SECONDS, 'negative control: advisory read-guard stays small');
  });
});

// ---------------------------------------------------------------------------
// Behavioral binding of each guard to the shared probe budget. The guards run as
// REAL subprocesses with tests/helpers/spawn-timeout-recorder.cjs preloaded, which
// records the `timeout` every `git` spawn actually receives. Nothing here reads
// a guard's source: a guard that stops using BLOCKING_GUARD_PROBE_TIMEOUT_MS (a
// revert to a literal 2000, a new probe on a different option object) fails.
// ---------------------------------------------------------------------------

describe('guard git probes receive the shared budget at runtime (#5180)', () => {
  let root;
  let main;
  let other;
  let wt;
  let runCount = 0;

  before(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5180-')));
    main = path.join(root, 'main');
    other = path.join(root, 'other');
    wt = path.join(root, 'agent-wt');
    const git = (args, cwd) => gitOrThrow(args, { cwd, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
    for (const dir of [main, other]) {
      fs.mkdirSync(dir);
      git(['init', '-q'], dir);
      git(['-c', 'user.name=gsd', '-c', 'user.email=gsd@example.com', '-c', 'commit.gpgsign=false',
        'commit', '-q', '--allow-empty', '-m', 'seed'], dir);
    }
    // A linked worktree on an agent-* branch: the only context where the
    // worktree-path guard enforces and the workflow guard's force-add block fires.
    git(['worktree', 'add', '-q', '-b', 'agent-5180', wt], main);
    fs.mkdirSync(path.join(wt, '.planning'));
    fs.writeFileSync(path.join(wt, '.planning', 'config.json'), JSON.stringify({ hooks: { workflow_guard: true } }));
  });

  after(() => cleanup(root));

  /** Run a hook as a real subprocess with the recorder preloaded; return its result and recorded git probes. */
  function runRecorded(hookFile, payload, { cwd, env = {} }) {
    const recordFile = path.join(root, `probes-${runCount++}.jsonl`);
    const result = runNode(['--require', RECORDER, path.join(HOOKS_DIR, hookFile)], {
      cwd,
      input: JSON.stringify(payload),
      env: { ...process.env, GSD_SPAWN_RECORD_FILE: recordFile, ...env },
      timeoutMs: STAGED_HOOK_SCRIPT_TIMEOUT_MS,
    });
    const probes = fs.existsSync(recordFile)
      ? splitLines(fs.readFileSync(recordFile, 'utf8')).filter(Boolean).map((line) => JSON.parse(line))
      : [];
    return { result, probes };
  }

  const pathGuard = (filePath, tool = 'Write') =>
    runRecorded('gsd-worktree-path-guard.js', { tool_name: tool, cwd: wt, tool_input: { file_path: filePath } }, { cwd: wt });
  const windsurfGuard = (filePath) =>
    runRecorded('gsd-windsurf-pre-write.js', { agent_action_name: 'pre_write_code', tool_info: { file_path: filePath } }, { cwd: wt });
  const workflowGuard = (command, env) =>
    runRecorded('gsd-workflow-guard.js', { tool_name: 'Bash', cwd: wt, tool_input: { command } }, { cwd: wt, env });

  function assertProbesUseSharedBudget(probes, label) {
    assert.ok(probes.length > 0, `${label}: the scenario must reach at least one git probe`);
    assert.ok(probes.length <= BLOCKING_GUARD_MAX_SEQUENTIAL_PROBES,
      `${label}: ${probes.length} sequential probes exceeds BLOCKING_GUARD_MAX_SEQUENTIAL_PROBES (${BLOCKING_GUARD_MAX_SEQUENTIAL_PROBES})`);
    for (const probe of probes) {
      assert.strictEqual(probe.timeout, BLOCKING_GUARD_PROBE_TIMEOUT_MS,
        `${label}: git ${probe.args.join(' ')} was spawned with timeout=${probe.timeout}, expected ${BLOCKING_GUARD_PROBE_TIMEOUT_MS}`);
    }
  }

  test('exported probe constants are the agreed values', () => {
    assert.strictEqual(BLOCKING_GUARD_PROBE_TIMEOUT_MS, 5000);
    assert.strictEqual(BLOCKING_GUARD_MAX_SEQUENTIAL_PROBES, 3);
  });

  test('gsd-worktree-path-guard: deny after 2 probes (file in another repo) uses the shared budget', () => {
    const { result, probes } = pathGuard(path.join(main, 'file.txt'));
    assert.strictEqual(result.exitCode, 2, `expected a deny; stderr=${result.stderr}`);
    assert.strictEqual(probes.length, 2);
    assertProbesUseSharedBudget(probes, 'path-guard other-repo deny');
  });

  test('gsd-worktree-path-guard: deny after 3 probes (file inside .git internals) uses the shared budget', () => {
    const { result, probes } = pathGuard(path.join(main, '.git', 'config'));
    assert.strictEqual(result.exitCode, 2, `expected a deny; stderr=${result.stderr}`);
    assert.strictEqual(probes.length, 3);
    assertProbesUseSharedBudget(probes, 'path-guard .git deny');
  });

  test('gsd-windsurf-pre-write: deny after 2 probes (file in another repo) uses the shared budget', () => {
    const { result, probes } = windsurfGuard(path.join(other, 'file.txt'));
    assert.strictEqual(result.exitCode, 2, `expected a deny; stderr=${result.stderr}`);
    assert.strictEqual(probes.length, 2);
    assertProbesUseSharedBudget(probes, 'windsurf other-repo deny');
  });

  test('gsd-windsurf-pre-write: deny after 3 probes (file inside .git internals) uses the shared budget', () => {
    const { result, probes } = windsurfGuard(path.join(other, '.git', 'config'));
    assert.strictEqual(result.exitCode, 2, `expected a deny; stderr=${result.stderr}`);
    assert.strictEqual(probes.length, 3);
    assertProbesUseSharedBudget(probes, 'windsurf .git deny');
  });

  test('gsd-workflow-guard: force-add block on an agent branch probes the branch with the shared budget', () => {
    const { result, probes } = workflowGuard('git add -f ignored.txt');
    assert.strictEqual(result.exitCode, 2, `expected a deny; stderr=${result.stderr}`);
    assert.strictEqual(probes.length, 1);
    assertProbesUseSharedBudget(probes, 'workflow-guard force-add block');
  });

  test('gsd-workflow-guard: the fail-closed re-check probes the branch with the shared budget', () => {
    // GSD_TEST_MODE + the fault flag drive the guard's own test-only fault seam,
    // which throws after parsing so the outer catch's fail-closed branch (which
    // calls currentBranch itself) is the code under observation.
    const { result, probes } = workflowGuard('git status', { GSD_TEST_MODE: '1', GSD_TEST_WORKFLOW_GUARD_FAULT: '1' });
    assert.strictEqual(result.exitCode, 2, `expected a fail-closed deny; stderr=${result.stderr}`);
    assert.strictEqual(probes.length, 1);
    assertProbesUseSharedBudget(probes, 'workflow-guard fail-closed re-check');
  });

  test('negative control: a non-guarded tool spawns no git probe at all', () => {
    const { result, probes } = pathGuard(path.join(main, 'file.txt'), 'Read');
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(probes.length, 0, 'the recorder must not invent probes; otherwise the assertions above are vacuous');
  });

  test('the recorder reports a deviant budget (the assertion can fail)', () => {
    const deviant = [{ args: ['rev-parse'], timeout: BLOCKING_GUARD_PROBE_TIMEOUT_MS - 1 }];
    assert.throws(() => assertProbesUseSharedBudget(deviant, 'deviant'), /expected/);
  });

  test('property: any generated hook payload keeps every recorded git probe on the shared budget', () => {
    const totals = { probes: 0 };
    const targets = {
      inside: (name) => path.join(wt, name),
      mainRepo: (name) => path.join(main, name),
      mainGit: (name) => path.join(main, '.git', name),
      sibling: (name) => path.join(other, name),
      missing: (name) => path.join(root, `absent-${name}`, 'nested', name),
      relative: (name) => name,
    };
    const scenario = fc.record({
      guard: fc.constantFrom('path-guard', 'windsurf'),
      tool: fc.constantFrom('Write', 'Edit', 'MultiEdit', 'Read', 'Bash', 'Glob'),
      target: fc.constantFrom(...Object.keys(targets)),
      name: fc.string({ unit: fc.constantFrom(...'abcdefgh'), minLength: 1, maxLength: 6 }),
    });
    fc.assert(
      fc.property(scenario, ({ guard, tool, target, name }) => {
        const filePath = targets[target](name);
        const { probes } = guard === 'path-guard' ? pathGuard(filePath, tool) : windsurfGuard(filePath);
        totals.probes += probes.length;
        for (const probe of probes) assert.strictEqual(probe.timeout, BLOCKING_GUARD_PROBE_TIMEOUT_MS);
        assert.ok(probes.length <= BLOCKING_GUARD_MAX_SEQUENTIAL_PROBES);
      }),
      { numRuns: 20 },
    );
    assert.ok(totals.probes > 0, 'the generated scenarios must reach real git probes; zero would make the property vacuous');
  });

  test('boundary: worst recorded probe count x shared budget fits the staged-hook bound at limit-1 / limit and not at limit+1', () => {
    // The worst case is MEASURED from a real run (the 3-probe .git deny above),
    // not restated, and priced with the real constants.
    const { probes } = pathGuard(path.join(main, '.git', 'config'));
    const worst = probes.length;
    assert.strictEqual(worst, BLOCKING_GUARD_MAX_SEQUENTIAL_PROBES,
      'the documented worst case must be the count a real guard actually reaches');

    // node start + fs work + kill/reap observed on a starved Windows runner (~0.46 s).
    const overheadMs = 500;
    const priced = (probeCount) => probeCount * BLOCKING_GUARD_PROBE_TIMEOUT_MS + overheadMs;
    assert.ok(priced(worst - 1) < STAGED_HOOK_SCRIPT_TIMEOUT_MS, 'limit-1 probes fits the staged-hook bound');
    assert.ok(priced(worst) < STAGED_HOOK_SCRIPT_TIMEOUT_MS, 'limit probes fits the staged-hook bound');
    // limit+1 is priced from the measured worst case, one more probe, and checked
    // against the host budget only: it is deliberately NOT tied to the numeric
    // value of the staged-hook helper bound, so retuning that class norm cannot
    // break this test while the real guards still fit it (limit-1 / limit above).
    assert.strictEqual(priced(worst + 1) - priced(worst), BLOCKING_GUARD_PROBE_TIMEOUT_MS);
    assert.ok(priced(worst + 1) < HOST_BUDGET_SECONDS * 1000, 'limit+1 probes still sits inside the host budget');
  });
});

// ---------------------------------------------------------------------------
// The OpenCode / Kilo plugin adapters spawn the same guards through their own
// runHook, and a hook they kill on timeout is reported as exit 0 — an ALLOW. So
// the bound they spawn the git-probing guards with must hold the guards' worst
// case, or the gate is silently off. The plugin is driven in-process with
// child_process.spawnSync replaced by a recorder (no real hook runs), so what is
// asserted is the `timeout` the adapter actually hands to spawnSync.
// ---------------------------------------------------------------------------

describe('OpenCode / Kilo plugin bound for the git-probing guards holds their worst case (#5180)', () => {
  const childProcess = require('node:child_process');
  const PLUGINS = [
    path.join(__dirname, '..', '.opencode', 'plugins', 'gsd-core.js'),
    path.join(__dirname, '..', '.kilo', 'plugins', 'gsd-core.js'),
  ];
  const PROBING_GUARDS = ['gsd-worktree-path-guard.js', 'gsd-workflow-guard.js'];

  async function recordedHookTimeouts(pluginPath) {
    const original = childProcess.spawnSync;
    const seen = new Map();
    childProcess.spawnSync = (command, args, options) => {
      const hookFile = path.basename(String(args && args[0]));
      seen.set(hookFile, options && options.timeout);
      return { status: 0, signal: null, stdout: '', stderr: '' };
    };
    delete require.cache[require.resolve(pluginPath)];
    try {
      const plugin = require(pluginPath);
      const hooks = await plugin.server({ directory: os.tmpdir() });
      await hooks['tool.execute.before']({ tool: 'write' }, { args: { filePath: path.join(os.tmpdir(), 'x.txt') } });
      await hooks['tool.execute.before']({ tool: 'bash' }, { args: { command: 'git status' } });
    } finally {
      childProcess.spawnSync = original;
      delete require.cache[require.resolve(pluginPath)];
    }
    return seen;
  }

  for (const pluginPath of PLUGINS) {
    test(`${path.relative(path.join(__dirname, '..'), pluginPath)}: probing guards get at least probes x probe budget`, async () => {
      const seen = await recordedHookTimeouts(pluginPath);
      const worstCaseMs = BLOCKING_GUARD_MAX_SEQUENTIAL_PROBES * BLOCKING_GUARD_PROBE_TIMEOUT_MS;
      for (const guard of PROBING_GUARDS) {
        assert.ok(seen.has(guard), `${guard} must be spawned by the adapter for this scenario`);
        assert.ok(seen.get(guard) > worstCaseMs,
          `${guard} spawn bound ${seen.get(guard)} ms must exceed the guard's worst case ${worstCaseMs} ms, ` +
          'else a kill is reported as an allow');
      }
    });
  }
});
