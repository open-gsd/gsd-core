'use strict';

/**
 * #4669 — the install-time and orchestrator seams that read a runtime-keyed `model_overrides` entry,
 * driven through the real seams rather than through the resolver they call:
 *
 *   - the descriptor-driven agents staging (runtime-artifact-layout -> createRuntimeArtifactInstallPlan)
 *     that bakes `model:` into OpenCode and Kilo agent frontmatter, so the runtime the layout threads
 *     down is what selects the key;
 *   - the orchestrator-worktree executor pin behind `dispatch-isolation`, which must select the host's
 *     key without loosening its explicit-pin-only rule.
 *
 * Deleting the wiring at any of the three sites fails a test here; the resolver-level behavior is in
 * model-overrides-runtime-key.test.cjs and the parity assertion in model-overrides-runtime-key-install.test.cjs.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const layoutModule = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');
const installProfiles = require('../gsd-core/bin/lib/install-profiles.cjs');
const installPlan = require('../gsd-core/bin/lib/runtime-artifact-install-plan.cjs');
const { extractFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');
const { createTempDir, cleanup, scrubConfigLocationEnv, runGsdTools } = require('./helpers.cjs');
const { createHermeticRoot, withHome } = require('./helpers/isolated-env.cjs');

const AGENT = 'gsd-planner';
const SANDBOXED = new WeakSet();

/** A sandboxed home plus a hermetic project whose config carries `config`. One sandbox per test. */
function project(t, config) {
  if (!SANDBOXED.has(t)) {
    SANDBOXED.add(t);
    const home = createTempDir('mo-wire-home-');
    t.after(() => cleanup(home));
    withHome(t, home);
    t.after(scrubConfigLocationEnv());
  }
  const root = createHermeticRoot('mo-wire-');
  t.after(() => cleanup(root));
  fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify(config));
  return root;
}

/** The `model` the real install staging bakes into the planner's agent file for `runtime`. */
function stagedAgentModel(t, runtime, modelOverrides) {
  const root = project(t, { model_overrides: modelOverrides });
  const layout = layoutModule.resolveRuntimeArtifactLayout(runtime, root, 'local');
  const result = installPlan.createRuntimeArtifactInstallPlan({
    layout,
    resolvedProfile: installProfiles.resolveProfile({ modes: ['full'] }),
    homedir: () => os.homedir(),
    resolveAttribution: () => undefined,
    projectDir: root,
  });
  assert.ok(result.ok, `staging ${runtime} agents failed: ${result.message}`);
  t.after(() => result.plan.cleanupDirs.forEach((dir) => cleanup(dir)));
  const agents = result.plan.items.find((item) => item.kind === 'agents');
  const content = fs.readFileSync(path.join(agents.sourceDir, `${AGENT}.md`), 'utf8');
  return extractFrontmatter(content).model ?? null;
}

describe('#4669 the descriptor-driven install bakes the model of the runtime being installed', () => {
  const PER_RUNTIME = { opencode: 'oc-planner-model', kilo: 'kilo-planner-model', codex: 'codex-only-model' };

  test('opencode agents carry the opencode key', (t) => {
    assert.equal(stagedAgentModel(t, 'opencode', { [AGENT]: PER_RUNTIME }), 'oc-planner-model');
  });

  test('kilo agents carry the kilo key from the same config', (t) => {
    assert.equal(stagedAgentModel(t, 'kilo', { [AGENT]: PER_RUNTIME }), 'kilo-planner-model');
  });

  test('an entry naming only another runtime bakes no model', (t) => {
    assert.equal(stagedAgentModel(t, 'opencode', { [AGENT]: { codex: 'codex-only-model' } }), null);
  });

  test('a string entry still bakes on both runtimes', (t) => {
    assert.equal(stagedAgentModel(t, 'opencode', { [AGENT]: 'plain-model' }), 'plain-model');
    assert.equal(stagedAgentModel(t, 'kilo', { [AGENT]: 'plain-model' }), 'plain-model');
  });
});

describe('#4669 the orchestrator-worktree executor pin selects the dispatched host\'s key', () => {
  /** The argv `dispatch-isolation` would exec for the executor on codex, as parsed JSON. */
  function execArgs(t, entry) {
    const root = project(t, { model_overrides: { 'gsd-executor': entry } });
    const target = createTempDir('mo-wire-wt-');
    t.after(() => cleanup(target));
    // The in-process CLI reads the env it is handed, not process.env, so the host is named here.
    const result = runGsdTools(
      ['dispatch-isolation', '--cwd-target', target, '--prompt', 'go', '--json'], root, { GSD_RUNTIME: 'codex' });
    assert.ok(result.success, `dispatch-isolation failed: ${result.error}`);
    const decision = JSON.parse(result.output);
    assert.equal(decision.isolation, 'orchestrator-worktree');
    return decision.exec.args;
  }

  test('a codex key becomes the --model argument', (t) => {
    const args = execArgs(t, { codex: 'gpt-6-astra', claude: 'opus' });
    assert.equal(args[args.indexOf('--model') + 1], 'gpt-6-astra');
  });

  test('an entry naming only another host passes no --model (explicit pins only)', (t) => {
    assert.equal(execArgs(t, { claude: 'opus' }).includes('--model'), false);
  });

  test('a string pin is unchanged', (t) => {
    const args = execArgs(t, 'gpt-6-astra');
    assert.equal(args[args.indexOf('--model') + 1], 'gpt-6-astra');
  });

  test('a flag-shaped value under the codex key is still refused by the pin policy', (t) => {
    t.mock.method(process.stderr, 'write', () => true);
    assert.equal(execArgs(t, { codex: '--sandbox' }).includes('--sandbox'), false);
  });
});
