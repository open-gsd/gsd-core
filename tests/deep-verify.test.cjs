'use strict';

/**
 * deep-verify capability — #3858
 *
 * Approved shape (maintainer ruling 2026-11-08): a default-off capability beside
 * live-dom-uat, NOT an edit to verify-work.md. It owns an activation key, a
 * second key that widens it from UI phases to every phase, one purpose-built
 * agent carrying the browser grants on its own tools: line, and one additive
 * `verify:pre` step whose `produces` artifact holds only what a human must still
 * confirm (the seam #3866 reads name + expected and nothing else).
 *
 * Risk zone under test (in order):
 *   1. Containment — nothing renders unless the activation key is on; the widen
 *      key alone never activates anything.
 *   2. The produced artifact never carries passes to the human (seam parses
 *      every listed artifact as checkpoints).
 *   3. Keys must not parse-and-do-nothing (config whitelist).
 *   4. No regression of live-dom-uat / playwright gating or the executor surface.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

const realRegistry = require('../gsd-core/bin/lib/capability-registry.cjs');
const { resolveLoopHooks } = require('../gsd-core/bin/lib/loop-resolver.cjs');
const { isValidConfigKey } = require('../gsd-core/bin/lib/config-schema.cjs');
const { loadConfig } = require('../gsd-core/bin/lib/config-loader.cjs');

const REPO_ROOT = path.join(__dirname, '..');

const CAP_ID = 'deep-verify';
const KEY = 'workflow.deep_verify';
const WIDEN_KEY = 'workflow.deep_verify_all_phases';
const LIVE_DOM_KEY = 'workflow.live_dom_uat';
const AGENT = 'gsd-behavior-verifier';
const POINT = 'verify:pre';
const CHECKPOINT_ARTIFACT = 'DEEP-VERIFY-CHECKPOINTS.md';
const RESULTS_ARTIFACT = 'DEEP-VERIFY.md';

const PLAYWRIGHT_GLOB = 'mcp__playwright__*';
const CHROME_GLOBS = ['mcp__chrome-devtools__*', 'mcp__claude-in-chrome__*'];

const AGENT_PATH = path.join(REPO_ROOT, 'agents', `${AGENT}.md`);
const DOM_VERIFIER_PATH = path.join(REPO_ROOT, 'agents', 'gsd-dom-verifier.md');
const EXECUTOR_PATH = path.join(REPO_ROOT, 'agents', 'gsd-executor.md');
const MANIFEST_PATH = path.join(REPO_ROOT, 'capabilities', CAP_ID, 'capability.json');
const VERIFY_WORK_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'verify-work.md');
const UI_VERIFY_PATH = path.join(
  REPO_ROOT, 'gsd-core', 'workflows', 'verify-work', 'steps', 'automated-ui-verification.md',
);

/** The seam's artifact-name grammar (verify-work.md, #3866). */
const SEAM_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const ACTIVE = { [CAP_ID]: { enabled: true, active: true } };

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

function ourHook(result) {
  return result.activeHooks.find((h) => h.capId === CAP_ID);
}

function resolveWith(config, capabilityStatesById) {
  return resolveLoopHooks({
    point: POINT, registry: realRegistry, config, capabilityStatesById,
  });
}

/** Extract the `tools:` declaration from an agent's frontmatter as a token list. */
function agentTools(agentPath) {
  const src = fs.readFileSync(agentPath, 'utf8');
  const nl = src.indexOf('\n---', 3);
  const fm = src.slice(0, nl < 0 ? src.length : nl);
  const lines = fm.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.startsWith('tools:'));
  if (idx === -1) return [];
  const inline = lines[idx].slice('tools:'.length).trim();
  if (inline) return inline.split(',').map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (let i = idx + 1; i < lines.length; i += 1) {
    const m = /^\s*-\s*(.+?)\s*$/.exec(lines[i]);
    if (!m) break;
    out.push(m[1]);
  }
  return out;
}

function mcpGlobsOf(agentPath) {
  return agentTools(agentPath).filter((t) => t.startsWith('mcp__') && !t.includes('context7')).sort();
}

/** The generated registry's step for this capability at verify:pre. */
function registryStep() {
  return realRegistry.byLoopPoint[POINT].steps.find((s) => s.capId === CAP_ID);
}

function fragmentText() {
  const step = registryStep();
  assert.ok(step, `registry must carry a ${CAP_ID} step at ${POINT}`);
  assert.ok(step.fragment && typeof step.fragment.inline === 'string' && step.fragment.inline.length > 0,
    'the generated registry must embed the fragment inline (path-only fragments are not rendered)');
  return step.fragment.inline;
}

// ─── 1. Manifest and registry projection ─────────────────────────────────────

describe('deep-verify: capability manifest and registry projection', () => {
  test('manifestDeclaresDefaultOffActivationKey', () => {
    const m = readManifest();
    assert.equal(m.id, CAP_ID);
    assert.equal(m.activationKey, KEY, 'capability must be gated by its own activation key');
    assert.equal(m.config[KEY].type, 'boolean');
    assert.equal(m.config[KEY].default, false, 'default-OFF is the containment');
  });

  test('manifestDeclaresDefaultOffWidenKey', () => {
    const slice = readManifest().config[WIDEN_KEY];
    assert.ok(slice, 'the widen key must be declared by the capability, not by core');
    assert.equal(slice.type, 'boolean');
    assert.equal(slice.default, false, 'widening to every phase is opt-in');
  });

  test('manifestOwnsTheAgentAndDeclaresOneAdditiveStep', () => {
    const m = readManifest();
    assert.deepStrictEqual(m.agents, [AGENT]);
    assert.equal(m.steps.length, 1);
    const step = m.steps[0];
    assert.equal(step.point, POINT);
    assert.deepStrictEqual(step.ref, { agent: AGENT });
    assert.equal(step.when, KEY, 'the step must carry the activation key');
    assert.equal(step.onError, 'skip', 'an advisory step must never halt UAT');
    assert.deepStrictEqual(step.consumes, ['PLAN.md']);
  });

  test('producesNamesOnlyTheCheckpointArtifact', () => {
    const { produces } = readManifest().steps[0];
    assert.deepStrictEqual(produces, [CHECKPOINT_ARTIFACT],
      'only the human-checkpoint artifact is produced; listing the results file would make the seam parse passes as checkpoints');
    assert.ok(!produces.includes(RESULTS_ARTIFACT));
  });

  test('producedNamesSatisfyTheSeamNameGrammar', () => {
    for (const name of readManifest().steps[0].produces) {
      assert.match(name, SEAM_NAME_RE, `produces name ${name} must pass the seam's in-context validation`);
    }
  });

  test('manifestCannotBlockTheHost', () => {
    const m = readManifest();
    assert.deepStrictEqual(m.gates, [], 'deep verification is advisory, never blocking');
    assert.deepStrictEqual(m.contributions, [], 'contributions carry prose only; results travel through produces');
  });

  test('fragmentPathResolvesOnDisk', () => {
    const rel = readManifest().steps[0].fragment.path;
    const abs = path.join(REPO_ROOT, 'capabilities', CAP_ID, rel);
    assert.ok(fs.statSync(abs).isFile(), `declared fragment must exist: ${rel}`);
    assert.ok(fs.statSync(abs).size > 0, 'fragment must not be empty');
  });

  test('generatedRegistryProjectsKeysAgentAndLoopPoint', () => {
    for (const key of [KEY, WIDEN_KEY]) {
      assert.equal(realRegistry.configSchema[key].owner, CAP_ID);
      assert.equal(realRegistry.configSchema[key].type, 'boolean');
      assert.equal(realRegistry.configSchema[key].default, false);
    }
    assert.ok(realRegistry.byAgent[AGENT], 'registry must index the agent');
    assert.ok(registryStep(), `registry must carry a ${CAP_ID} step at ${POINT}`);
  });

  test('exactlyOneCapabilityOwnsEachKey', () => {
    for (const key of [KEY, WIDEN_KEY]) {
      const owners = Object.entries(realRegistry.configSchema)
        .filter(([k]) => k === key)
        .map(([, v]) => v.owner);
      assert.deepStrictEqual(owners, [CAP_ID], `${key} must have exactly one owner`);
    }
  });
});

// ─── 2. Containment: hook activation ─────────────────────────────────────────

describe('deep-verify: the hook does not render unless the activation key is on', () => {
  test('hookAbsentWhenKeyDefaultsOff', () => {
    assert.equal(ourHook(resolveWith({}, ACTIVE)), undefined);
  });

  test('hookAbsentWhenKeyExplicitlyFalse', () => {
    assert.equal(ourHook(resolveWith({ workflow: { deep_verify: false } }, ACTIVE)), undefined);
  });

  test('hookRendersWhenKeyOnAndCapabilityActive', () => {
    const hook = ourHook(resolveWith({ workflow: { deep_verify: true } }, ACTIVE));
    assert.ok(hook, 'key on + capability active must render the step');
    assert.equal(hook.kind, 'step');
    assert.deepStrictEqual(hook.ref, { agent: AGENT });
    assert.equal(hook.onError, 'skip');
    assert.notEqual(hook.blocking, true);
  });

  test('hookAbsentWhenCapabilityConfigDisabled', () => {
    const hook = ourHook(resolveWith(
      { workflow: { deep_verify: true } },
      { [CAP_ID]: { enabled: true, active: false } },
    ));
    assert.equal(hook, undefined, 'installed-but-config-disabled must not render — fail-closed');
  });

  test('hookAbsentWhenCapabilityStateEntryMissing', () => {
    const hook = ourHook(resolveWith(
      { workflow: { deep_verify: true } },
      { 'some-other-cap': { enabled: true, active: true } },
    ));
    assert.equal(hook, undefined, 'a missing state entry is fail-closed, not permissive');
  });

  test('wideningKeyAloneNeverActivates', () => {
    const hook = ourHook(resolveWith({ workflow: { deep_verify_all_phases: true } }, ACTIVE));
    assert.equal(hook, undefined, 'widening scope must not switch the capability on');
  });

  test('bothKeysOnRendersExactlyOneHook', () => {
    const r = resolveWith({ workflow: { deep_verify: true, deep_verify_all_phases: true } }, ACTIVE);
    assert.equal(r.activeHooks.filter((h) => h.capId === CAP_ID).length, 1);
  });
});

// ─── 3. The keys must not parse-and-do-nothing ───────────────────────────────

describe('deep-verify: config key acceptance and coercion', () => {
  test('configKeysAreRecognisedByConfigValidation', () => {
    assert.equal(isValidConfigKey(KEY), true,
      'an unregistered key is silently dropped — the key would parse and do nothing');
    assert.equal(isValidConfigKey(WIDEN_KEY), true);
  });

  for (const key of [KEY, WIDEN_KEY]) {
    for (const value of ['true', 'false']) {
      test(`configSetAcceptsAndPersists_${key}_${value}`, (t) => {
        const tmpDir = createTempProject();
        t.after(() => cleanup(tmpDir));

        const result = runGsdTools(`config-set ${key} ${value}`, tmpDir);
        assert.ok(result.success, `config-set must accept ${key}: ${result.error}`);
        const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, '.planning', 'config.json'), 'utf8'));
        const leaf = key.split('.')[1];
        assert.strictEqual(cfg.workflow?.[leaf], value === 'true', 'value must persist as a boolean');
      });
    }

    test(`configSetRejectsANonBooleanValue_${key}`, (t) => {
      const tmpDir = createTempProject();
      t.after(() => cleanup(tmpDir));

      const result = runGsdTools(`config-set ${key} banana`, tmpDir);
      assert.ok(!result.success, 'config-set must reject a non-boolean for a boolean slice');
    });
  }

  for (const [label, value] of [
    ['stringTrue', '"true"'],
    ['stringFalse', '"false"'],
    ['numberOne', '1'],
    ['numberZero', '0'],
    ['nullValue', 'null'],
    ['emptyArray', '[]'],
    ['emptyObject', '{}'],
  ]) {
    test(`handWrittenNonBooleanNeverActivates_${label}`, (t) => {
      const tmpDir = createTempProject();
      t.after(() => cleanup(tmpDir));

      fs.writeFileSync(
        path.join(tmpDir, '.planning', 'config.json'),
        `{"workflow":{"deep_verify":${value},"deep_verify_all_phases":${value}}}`,
      );
      const cfg = loadConfig(tmpDir);
      assert.strictEqual(cfg.workflow?.deep_verify, false, `${label} must resolve to the slice default`);
      assert.strictEqual(cfg.workflow?.deep_verify_all_phases, false, `${label} must resolve to the slice default`);

      const r = resolveLoopHooks({
        point: POINT, registry: realRegistry, config: cfg, cwd: tmpDir, capabilityStatesById: ACTIVE,
      });
      assert.equal(ourHook(r), undefined, `${label} must not activate browser reach`);
    });
  }

  test('absentKeysResolveToTheSchemaDefault', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const cfg = loadConfig(tmpDir);
    assert.strictEqual(cfg.workflow?.deep_verify, false);
    assert.strictEqual(cfg.workflow?.deep_verify_all_phases, false);
  });

  test('property: no hand-written non-boolean ever activates the hook', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const configPath = path.join(tmpDir, '.planning', 'config.json');

    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(0),
          fc.constant(''),
          fc.string(),
          fc.integer(),
          fc.array(fc.integer()),
          fc.dictionary(fc.string(), fc.integer()),
        ),
        (value) => {
          fs.writeFileSync(configPath, JSON.stringify({ workflow: { deep_verify: value, deep_verify_all_phases: value } }));
          const cfg = loadConfig(tmpDir);
          if (cfg.workflow?.deep_verify !== false) return false;
          const r = resolveLoopHooks({
            point: POINT, registry: realRegistry, config: cfg, cwd: tmpDir, capabilityStatesById: ACTIVE,
          });
          return ourHook(r) === undefined;
        },
      ),
      { numRuns: 50, seed: 3858 },
    );
  });
});

// ─── 4. Shipped-text contracts ───────────────────────────────────────────────

describe('deep-verify: shipped agent, fragment and core-surface contracts', () => {
  test('deepVerifierCarriesBrowserGlobsAndNoShell', () => {
    // An agent's frontmatter IS its tool grant at runtime; there is no API to
    // enumerate a not-yet-spawned agent's permissions.
    assert.deepStrictEqual(mcpGlobsOf(AGENT_PATH), [PLAYWRIGHT_GLOB, ...CHROME_GLOBS].sort());
    const tools = agentTools(AGENT_PATH);
    for (const banned of ['Bash', 'Edit', 'NotebookEdit']) {
      assert.ok(!tools.includes(banned),
        `${AGENT} must not carry ${banned}: browser reach next to a shell or in-place editor widens the hostile-plan-text surface`);
    }
  });

  test('browserGlobParityAcrossAgentsAndFragment', () => {
    // The chrome-family list is one shared constant across three surfaces now
    // (gsd-dom-verifier tools, this agent's tools, this fragment): divergence
    // class DEFECT.GENERATIVE-FIX-DIVERGENCE.
    const domChrome = mcpGlobsOf(DOM_VERIFIER_PATH);
    assert.deepStrictEqual(domChrome, [...CHROME_GLOBS].sort(), 'gsd-dom-verifier chrome families changed');
    const ours = mcpGlobsOf(AGENT_PATH).filter((g) => g !== PLAYWRIGHT_GLOB);
    assert.deepStrictEqual(ours, domChrome);
    const text = fragmentText();
    for (const glob of [PLAYWRIGHT_GLOB, ...CHROME_GLOBS]) {
      assert.ok(text.includes(glob), `fragment must name ${glob}`);
    }
  });

  test('fragmentKeepsTheTwoFamilyGateContract', () => {
    // Playwright works today on presence + UI phase; chrome-family only behind
    // workflow.live_dom_uat. The fragment must keep both halves of that contract.
    const text = fragmentText();
    // A bullet runs until the next line that starts a new bullet; continuation lines belong to it.
    const bullets = text.split(/\n(?=- )/).filter((b) => b.startsWith('- `mcp__'));
    const chromeBullet = bullets.find((l) => CHROME_GLOBS.every((g) => l.includes(g)));
    assert.ok(chromeBullet, 'the fragment must carry one bullet naming both Chrome-family globs');
    assert.ok(chromeBullet.includes(LIVE_DOM_KEY),
      'the Chrome-family bullet itself must tie reach to workflow.live_dom_uat');
    const playwrightBullet = bullets.find((l) => l.includes(PLAYWRIGHT_GLOB));
    assert.ok(playwrightBullet, 'the fragment must carry a Playwright bullet');
    assert.ok(!playwrightBullet.includes(LIVE_DOM_KEY),
      'Playwright reach must not be gated behind workflow.live_dom_uat (Hyrum: it works today without it)');
  });

  test('checkpointArtifactIsBareNamedAndAlwaysRewritten', () => {
    // The seam looks the artifact up by the bare `produces` name, and the agent has
    // no delete tool, so a stale file can only be retired by overwriting it.
    const agentSrc = fs.readFileSync(AGENT_PATH, 'utf8');
    for (const [label, text] of [['fragment', fragmentText()], ['agent', agentSrc]]) {
      assert.ok(text.includes(`{phase_dir}/${CHECKPOINT_ARTIFACT}`),
        `${label} must write the bare declared name ${CHECKPOINT_ARTIFACT}`);
      assert.ok(!/\{phase_num\}-DEEP-VERIFY-CHECKPOINTS/.test(text),
        `${label} must not write a phase-prefixed checkpoint file the seam would not find`);
      assert.ok(text.includes('No checkpoints.'),
        `${label} must define the empty checkpoint file so a stale one is overwritten`);
    }
    assert.ok(readManifest().steps[0].produces.includes(CHECKPOINT_ARTIFACT));
  });

  test('scopeDoesNotDependOnAnOrchestratorRelay', () => {
    // Nothing in core relays ui_phase_active to a ref.agent step, so neither shipped
    // surface may depend on it; the agent resolves scope from files it can read.
    const agentSrc = fs.readFileSync(AGENT_PATH, 'utf8');
    for (const [label, text] of [['fragment', fragmentText()], ['agent', agentSrc]]) {
      assert.ok(!text.includes('ui_phase_active'), `${label} must not depend on a relayed ui_phase_active`);
      assert.ok(text.includes('{planning_root}/config.json'), `${label} must read the two keys from the scoped config itself`);
      assert.ok(!text.includes('.planning/config.json'), `${label} must not name the root config path (workstream-scoped runs)`);
      assert.ok(text.includes('UI-SPEC.md'), `${label} must derive a UI phase from the phase-scoped UI-SPEC`);
    }
  });

  test('fragmentNamesTheUiGateAndOutcomeReasons', () => {
    const text = fragmentText();
    for (const needle of [
      WIDEN_KEY, 'not_ui_phase', 'no_browser_mcp', 'no_behaviors', 'profile_locked', 'target_unreachable',
      CHECKPOINT_ARTIFACT, '{phase_num}-DEEP-VERIFY.md', 'nothing_to_report', 'could_not_look',
    ]) {
      assert.ok(text.includes(needle), `fragment must name ${needle}`);
    }
  });

  test('agentTreatsPlanAndPageTextAsData', () => {
    const src = fs.readFileSync(AGENT_PATH, 'utf8');
    assert.ok(src.includes('<untrusted-input>'), 'agent must carry an untrusted-input boundary section');
    assert.ok(src.includes('DATA'), 'plan, summary and live-page text must be declared data');
  });

  test('executorSurfaceIsUnchanged', () => {
    const tools = agentTools(EXECUTOR_PATH);
    assert.ok(!tools.some((t) => t.startsWith('mcp__') && !t.includes('context7')),
      'gsd-executor may carry no MCP family beyond context7');
  });

  test('coreWorkflowsStayFree', () => {
    // Maintainer ruling: "Nothing in core changes." The capability wires in through
    // the #3866 seam alone, so neither core workflow may name this capability.
    for (const p of [VERIFY_WORK_PATH, UI_VERIFY_PATH]) {
      const src = fs.readFileSync(p, 'utf8');
      assert.ok(!src.includes('deep_verify') && !src.includes('deep-verify'),
        `${path.basename(p)} must not reference the capability`);
    }
  });
});
