'use strict';

/**
 * The runtime descriptor owns every runtime-specific fact, and an unknown id
 * refuses (#5169, ADR-5057 Phase 10, §5).
 *
 * Locks, behaviorally:
 *   - ONE host-behaviors accessor (`hostBehaviorsFor`): every registered
 *     runtime resolves to its descriptor; an absent, unregistered or retired
 *     label declares no behaviors (the generic path, never Claude's, and never a
 *     throw — it is read by guard and hook code on user-supplied labels); the
 *     #338 privacy floor survives a registry-load failure.
 *   - EVERY accessor whose fallthrough answer is a Claude Code value
 *     (`getDirName`, `getRuntimeLabel`, `getGlobalConfigHomeFragment`,
 *     `getGlobalConfigDir`, `getGlobalSkillsBase`) refuses an id it does not know —
 *     including prototype keys and near-misses — as a `fast-check` property, and
 *     refuses a retired id with the retirement error (retired is checked first).
 *   - The content-rewrite profile each runtime declares is one the rewrite
 *     engine actually handles (a typo in a descriptor cannot silently disable a
 *     runtime's path rewrites).
 *   - ONE install-runtime resolver chain (env > config > marker > default),
 *     shared by every consumer (#4690).
 *
 * Inputs here are the shapes production passes: canonical ids from argv/the
 * registry, the empty string for "no runtime", and hostile strings from argv.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');

const LIB = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib');
const policy = require(path.join(LIB, 'runtime-name-policy.cjs'));
const homes = require(path.join(LIB, 'runtime-homes.cjs'));
const registry = require(path.join(LIB, 'capability-registry.cjs'));
const conversion = require(path.join(LIB, 'runtime-artifact-conversion.cjs'));
const slash = require(path.join(LIB, 'runtime-slash.cjs'));

const {
  hostBehaviorsFor,
  isKnownRuntimeId,
  assertKnownRuntime,
  getDirName,
  getRuntimeLabel,
  getGlobalConfigHomeFragment,
  FALLBACK_HOST_BEHAVIORS,
  LEGACY_NON_REGISTRY_RUNTIME_IDS,
  RETIRED_RUNTIME_IDS,
} = policy;
const { getGlobalConfigDir, getGlobalSkillsBase } = homes;

const REGISTERED = Object.keys(registry.runtimes);
const ACCESSORS = {
  getDirName,
  getRuntimeLabel,
  getGlobalConfigHomeFragment,
  getGlobalConfigDir: (id) => getGlobalConfigDir(id),
  getGlobalSkillsBase,
  assertKnownRuntime,
};

const UNKNOWN = { name: 'UnknownRuntimeError', code: 'GSD_UNKNOWN_RUNTIME' };
const RETIRED = { name: 'RetiredRuntimeError' };

describe('hostBehaviorsFor — the single host-behaviors accessor', () => {
  test('every registered runtime resolves to its descriptor object (identity, not a copy)', () => {
    assert.ok(REGISTERED.length >= 19, 'the registry carries the shipped runtimes');
    for (const id of REGISTERED) {
      const declared = registry.runtimes[id].runtime.hostBehaviors;
      const got = hostBehaviorsFor(id);
      if (declared) assert.strictEqual(got, declared, `${id} must return the descriptor's own hostBehaviors`);
      else assert.deepEqual(got, FALLBACK_HOST_BEHAVIORS[id] || {}, `${id} declares none`);
    }
  });

  test('an absent id is the generic path', () => {
    for (const absent of ['', undefined, null, 0, 1, false, true, [], {}, () => 'claude', Symbol('claude')]) {
      assert.deepEqual(hostBehaviorsFor(absent), {}, `${String(typeof absent)} must be generic`);
    }
  });

  // hostBehaviorsFor is a PREDICATE source read by guard and hook code on
  // user-supplied runtime labels (a stale config value, a retired id). For a label
  // GSD does not know, "no declared behaviors" is the correct, generic answer — it
  // is never Claude Code's behaviors — and a throw would crash a session instead of
  // skipping a behavior. The path/label accessors, whose fallthrough IS a Claude
  // Code value, are the ones that refuse (next describe). ADR-5057 §5 amendment.
  test('a non-canonical id declares no behaviors: typo, case, whitespace, alias — and never Claude\'s', () => {
    const claude = hostBehaviorsFor('claude');
    assert.ok(Object.keys(claude).length > 0);
    for (const label of ['claud', 'Claude', 'CLAUDE', ' claude', 'claude ', 'claude-code', 'codex-cli', 'gemini-typo', 'x']) {
      const got = hostBehaviorsFor(label);
      assert.deepEqual(got, {}, JSON.stringify(label));
      assert.notStrictEqual(got, claude, `${JSON.stringify(label)} must not alias claude's descriptor`);
    }
  });

  test('a retired id declares no behaviors and does not throw (a stale config must not crash a hook)', () => {
    for (const retired of RETIRED_RUNTIME_IDS) assert.deepEqual(hostBehaviorsFor(retired), {});
  });

  test('prototype keys declare nothing: the lookup is an own-property check, never an index', () => {
    for (const key of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf']) {
      assert.deepEqual(hostBehaviorsFor(key), {}, key);
    }
  });

  test('property: hostBehaviorsFor never throws for any string, and an unregistered one declares nothing', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (label) => {
        const got = hostBehaviorsFor(label);
        assert.equal(typeof got, 'object');
        if (!isKnownRuntimeId(label)) assert.deepEqual(got, {});
      }),
      { seed: 5169, numRuns: 300 },
    );
  });

  test('known non-registry ids (grok) resolve to the generic behaviors rather than refusing', () => {
    assert.ok(LEGACY_NON_REGISTRY_RUNTIME_IDS.has('grok'));
    for (const id of LEGACY_NON_REGISTRY_RUNTIME_IDS) {
      assert.deepEqual(hostBehaviorsFor(id), {});
      assert.ok(isKnownRuntimeId(id));
    }
  });

  test('registry-load failure: the #338 privacy floor survives, and ONLY for the ids it covers', () => {
    assert.deepEqual(hostBehaviorsFor('claude', null), FALLBACK_HOST_BEHAVIORS.claude);
    assert.equal(hostBehaviorsFor('claude', null).settingsFileByScope.local, 'settings.local.json');
    assert.deepEqual(hostBehaviorsFor('antigravity', null), FALLBACK_HOST_BEHAVIORS.antigravity);
    assert.deepEqual(hostBehaviorsFor('codex', null), {});
    // A registry object with no runtimes map is the same failure.
    assert.deepEqual(hostBehaviorsFor('claude', {}), FALLBACK_HOST_BEHAVIORS.claude);
  });

  test('parity: every key the #338 floor carries equals the live descriptor value (the floor cannot rot away from the descriptor)', () => {
    assert.deepEqual(Object.keys(FALLBACK_HOST_BEHAVIORS).sort(), ['antigravity', 'claude']);
    for (const [id, floor] of Object.entries(FALLBACK_HOST_BEHAVIORS)) {
      const declared = registry.runtimes[id].runtime.hostBehaviors;
      for (const [key, value] of Object.entries(floor)) {
        assert.deepEqual(declared[key], value, `${id}.${key} must match the descriptor`);
      }
    }
  });

  test('a registered runtime whose descriptor declares no hostBehaviors degrades to the floor, not to a throw', () => {
    const fake = { runtimes: { claude: { runtime: {} }, codex: { runtime: {} } } };
    assert.deepEqual(hostBehaviorsFor('claude', fake), FALLBACK_HOST_BEHAVIORS.claude);
    assert.deepEqual(hostBehaviorsFor('codex', fake), {});
  });

  test('an injected registry is authoritative: an id it lacks declares nothing', () => {
    assert.deepEqual(hostBehaviorsFor('claude', { runtimes: { codex: { runtime: {} } } }), {});
  });
});

describe('every descriptor accessor refuses an unknown id', () => {
  test('near-miss and hostile ids refuse on every accessor', () => {
    const bad = ['claud', 'Claude', ' claude', 'definitely-not-a-runtime', '__proto__', 'constructor', 'toString', 'a/b', '..'];
    for (const [name, fn] of Object.entries(ACCESSORS)) {
      for (const id of bad) assert.throws(() => fn(id), UNKNOWN, `${name}(${JSON.stringify(id)})`);
    }
  });

  test('property: any string that is not a registered id refuses on every accessor', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 40 }).filter((s) => s.length > 0 && !isKnownRuntimeId(s) && !RETIRED_RUNTIME_IDS.has(s.toLowerCase())),
        (id) => {
          for (const [name, fn] of Object.entries(ACCESSORS)) {
            let threw = null;
            try {
              fn(id);
            } catch (err) {
              threw = err;
            }
            // A retired SPELLING (e.g. a cased or hyphenated variant) throws the
            // retirement error; every other unknown id throws the unknown error.
            assert.ok(threw && (threw.name === 'UnknownRuntimeError' || threw.name === 'RetiredRuntimeError'),
              `${name}(${JSON.stringify(id)}) must refuse`);
          }
        },
      ),
      { seed: 5169, numRuns: 300 },
    );
  });

  test('property: every registered id resolves on every accessor (no accessor over-refuses)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...REGISTERED), (id) => {
        assert.doesNotThrow(() => getDirName(id));
        assert.doesNotThrow(() => getRuntimeLabel(id));
        assert.doesNotThrow(() => getGlobalConfigHomeFragment(id));
        assert.doesNotThrow(() => getGlobalSkillsBase(id));
        assert.doesNotThrow(() => hostBehaviorsFor(id));
      }),
      { seed: 5169, numRuns: 100 },
    );
  });

  test('an absent id keeps the documented generic defaults on the accessors that have one', () => {
    assert.equal(getDirName(''), '.claude');
    assert.equal(getRuntimeLabel(''), 'Claude Code');
    assert.equal(getGlobalConfigHomeFragment(''), "'.claude'");
    assert.doesNotThrow(() => getGlobalConfigDir(''));
    assert.doesNotThrow(() => assertKnownRuntime(''));
    assert.doesNotThrow(() => assertKnownRuntime(undefined));
  });

  test('a retired id throws the retirement error, checked before the unknown check', () => {
    const retired = [...RETIRED_RUNTIME_IDS][0];
    assert.ok(retired, 'at least one retired runtime id is recorded');
    for (const [name, fn] of Object.entries(ACCESSORS)) {
      assert.throws(() => fn(retired), RETIRED, `${name}(${retired})`);
    }
  });

  test('an explicit config dir cannot mask an unknown runtime', () => {
    assert.throws(() => getGlobalConfigDir('nope-runtime', '/some/dir'), UNKNOWN);
  });

  test('grok still resolves (known, not registered)', () => {
    assert.doesNotThrow(() => getGlobalConfigDir('grok'));
  });

  test('the two documented cross-agent-default accessors keep their default for an unknown id (ADR-5057 §5 Phase 10 amendment)', () => {
    const layout = require(path.join(LIB, 'runtime-artifact-layout.cjs'));
    assert.equal(policy.getProjectInstructionFile('future-runtime-xyz'), 'AGENTS.md');
    assert.deepEqual(layout.resolveAdvertisedNewProject('future-runtime-xyz', 'global'), { kind: 'command', command: '/gsd-new-project' });
  });

  test('the content rewrite engine refuses an unknown runtime instead of rewriting for it', () => {
    assert.throws(() => conversion._applyRuntimeRewrites('~/.claude/x', 'not-a-runtime', '$HOME/.p/', true, undefined), UNKNOWN);
  });
});

describe('content rewrite profiles — declared by the descriptor, handled by the engine', () => {
  const SAMPLE = 'See ~/.claude/gsd-core/x and $HOME/.claude/gsd-core/y and ./.claude/z.';
  const rewrite = (rt) => conversion._applyRuntimeRewrites(SAMPLE, rt, '$HOME/.prefix/', true, undefined);

  test('every runtime declaring a path-rewriting profile actually rewrites the Claude paths', () => {
    let covered = 0;
    for (const id of REGISTERED) {
      const profile = hostBehaviorsFor(id).contentRewriteProfile;
      if (!profile || profile === 'attribution-only') continue;
      const out = rewrite(id);
      assert.ok(out.includes('$HOME/.prefix/gsd-core/x'), `${id} (${profile}) must rewrite ~/.claude/`);
      assert.ok(!out.includes('~/.claude/'), `${id} (${profile}) must not leave ~/.claude/ behind`);
      covered += 1;
    }
    assert.ok(covered >= 10, 'the path-rewriting profiles are exercised');
  });

  test('runtimes with no profile, and attribution-only runtimes, leave the paths unchanged', () => {
    for (const id of REGISTERED) {
      const profile = hostBehaviorsFor(id).contentRewriteProfile;
      if (profile && profile !== 'attribution-only') continue;
      assert.ok(rewrite(id).includes('~/.claude/gsd-core/x'), `${id} must not rewrite`);
    }
  });

  test('claude and zcode share a profile and produce identical output (one body, not two copies)', () => {
    assert.equal(hostBehaviorsFor('claude').contentRewriteProfile, hostBehaviorsFor('zcode').contentRewriteProfile);
    // dirName differs only in the `./.claude/` arm, which both derive from getDirName.
    const a = rewrite('claude').replace(/\.claude\//g, '.D/');
    const b = rewrite('zcode').replace(/\.zcode\//g, '.D/');
    assert.equal(a, b);
  });

  test('qwen and hermes share a profile; their own dot-dir is derived from the descriptor', () => {
    assert.equal(hostBehaviorsFor('qwen').contentRewriteProfile, hostBehaviorsFor('hermes').contentRewriteProfile);
    const own = (rt) => conversion._applyRuntimeRewrites(`~/${getDirName(rt)}/gsd-core/x ./${getDirName(rt)}/y`, rt, '$HOME/.p/', true, undefined);
    assert.ok(own('qwen').includes('$HOME/.p/gsd-core/x'));
    assert.ok(own('hermes').includes('$HOME/.p/gsd-core/x'));
  });

  test('a runtime that declares the stamp-skip flag is exactly the reference host', () => {
    const skipping = REGISTERED.filter((id) => hostBehaviorsFor(id).skipRuntimeDefaultsStamp === true);
    assert.deepEqual(skipping, ['claude']);
  });
});

describe('descriptor-declared install behaviors replaced the name tests', () => {
  const declares = (key) => REGISTERED.filter((id) => hostBehaviorsFor(id)[key] === true).sort();

  test('Hermes cleanup behaviors are declared by hermes and by no other runtime', () => {
    for (const key of ['legacyFlatSkillsCleanup', 'bareStemSkillsCleanup', 'categoryContainerCleanup']) {
      assert.deepEqual(declares(key), ['hermes'], key);
    }
  });

  test('Claude-only behaviors are declared by claude and by no other runtime', () => {
    for (const key of [
      'skipCompactAgents',
      'omitBashRunnerOnWindows',
      'specRootSkillPass',
      'restoreAtRefTildeInAgents',
      'restoreAtRefTildeInSpecTree',
    ]) {
      assert.deepEqual(declares(key), ['claude'], key);
    }
  });

  test('single-host behaviors are declared by their one host', () => {
    assert.deepEqual(declares('opencodePathPrefix'), ['opencode']);
    assert.deepEqual(declares('requiresSubagentPair'), ['kimi']);
    assert.deepEqual(declares('reclaimsKimiLegacyHooksRoot'), ['kimi-code']);
    assert.deepEqual(declares('rewriteClaudeAtIncludes'), ['codex']);
    // String-valued: declares() matches only `=== true`, so read the field itself.
    assert.deepEqual(
      REGISTERED.filter((id) => typeof hostBehaviorsFor(id).defaultHomeIncludeRoot === 'string').sort(),
      ['antigravity', 'copilot'],
    );
    assert.equal(hostBehaviorsFor('copilot').defaultHomeIncludeRoot, '.copilot');
    assert.equal(hostBehaviorsFor('antigravity').defaultHomeIncludeRoot, '.gemini/antigravity');
    assert.deepEqual(declares('retargetsGsdCoreProsePath'), ['kimi']);
    assert.deepEqual(declares('agentTomlFiles'), ['codex']);
  });

  test('native model aliases are declared by claude alone (the model resolver reads the descriptor, not a hand-kept set)', () => {
    assert.deepEqual(declares('nativeModelAliases'), ['claude']);
  });

  test('the static-bake runtimes are exactly the three that declare it, each with baked file extensions', () => {
    assert.deepEqual(declares('bakesStaticAgentModel'), ['codex', 'kilo', 'opencode']);
    for (const id of declares('bakesStaticAgentModel')) {
      const exts = hostBehaviorsFor(id).bakedAgentFileExtensions;
      assert.ok(Array.isArray(exts) && exts.length > 0 && exts.every((e) => e.startsWith('.')), id);
    }
  });

  test('the shell projection omits the bash runner only where the descriptor says so (win32 shell hook)', () => {
    const { shellHookOmitsBashRunner } = require(path.join(LIB, 'shell-command-projection.cjs'));
    assert.equal(shellHookOmitsBashRunner({ platform: 'win32', runtime: 'claude', isShellHook: true }), true);
    for (const id of REGISTERED.filter((r) => r !== 'claude')) {
      assert.equal(shellHookOmitsBashRunner({ platform: 'win32', runtime: id, isShellHook: true }), false, id);
    }
    assert.equal(shellHookOmitsBashRunner({ platform: 'linux', runtime: 'claude', isShellHook: true }), false);
    assert.equal(shellHookOmitsBashRunner({ platform: 'win32', runtime: 'claude', isShellHook: false }), false);
    // The documented default label and any unregistered label never omit the runner.
    assert.equal(shellHookOmitsBashRunner({ platform: 'win32', isShellHook: true }), false);
    assert.equal(shellHookOmitsBashRunner({ platform: 'win32', runtime: 'not-a-runtime', isShellHook: true }), false);
  });
});

describe('one install-runtime resolver chain (#4690)', () => {
  beforeEach(() => slash._setInstallRuntimeMarkerForTests(null));
  afterEach(() => slash._resetInstallRuntimeMarkerCacheForTests());

  test('env outranks config outranks marker outranks the claude default', () => {
    slash._setInstallRuntimeMarkerForTests('cursor');
    assert.equal(slash.resolveActiveRuntime({ runtime: 'kilo' }, { GSD_RUNTIME: 'codex' }), 'codex');
    assert.equal(slash.resolveActiveRuntime({ runtime: 'kilo' }, {}), 'kilo');
    assert.equal(slash.resolveActiveRuntime({}, {}), 'cursor');
    slash._setInstallRuntimeMarkerForTests(null);
    assert.equal(slash.resolveActiveRuntime({}, {}), 'claude');
  });

  test('a config that omits runtime resolves the marker runtime, not claude (the #4690 shape)', () => {
    slash._setInstallRuntimeMarkerForTests('codex');
    assert.equal(slash.resolveActiveRuntime({ model_profile: 'balanced', resolve_model_ids: false }, {}), 'codex');
  });

  test('garbage in any rung degrades to the next rung instead of throwing', () => {
    slash._setInstallRuntimeMarkerForTests('   ');
    for (const config of [null, undefined, {}, { runtime: 5 }, { runtime: null }, { runtime: {} }, { runtime: [] }, { runtime: '' }]) {
      assert.equal(slash.resolveActiveRuntime(config, { GSD_RUNTIME: '' }), 'claude');
    }
  });

  test('aliases and case variants canonicalize on every rung', () => {
    assert.equal(slash.resolveActiveRuntime({}, { GSD_RUNTIME: 'Codex-CLI' }), 'codex');
    assert.equal(slash.resolveActiveRuntime({ runtime: 'Claude-Code' }, {}), 'claude');
    slash._setInstallRuntimeMarkerForTests('Open-Code');
    assert.equal(slash.resolveActiveRuntime({}, {}), 'opencode');
  });

  test('resolveActiveRuntime agrees with resolveRuntime for every registered runtime named by env', () => {
    for (const id of REGISTERED) {
      const viaEnv = slash.resolveActiveRuntime({}, { GSD_RUNTIME: id });
      assert.equal(viaEnv, id);
    }
  });
});
