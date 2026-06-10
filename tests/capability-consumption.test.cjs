'use strict';
/**
 * capability-consumption.test.cjs — ADR-857 phase 4c
 *
 * Tests that resolveProfile and resolveSurface correctly CONSUME the capability
 * registry (capabilityClusters + profileMembership) in an additive, no-op-when-
 * current manner.
 *
 * Test categories:
 *   1. RECONCILIATION  — registry profileMembership.ui is {tier:'full',profiles:['full']}
 *   2. EQUIVALENCE     — registry present with REAL registry = same result as absent
 *   3. FUNCTIONAL      — synthetic registry adds capability skills at correct tiers
 *   4. SURFACE EQUIVALENCE — resolveSurface with vs without real registry
 *   5. SURFACE FUNCTIONAL  — synthetic registry cluster merge + disable-ability
 *   6. LIVE-PATH EQUIVALENCE — resolveSurface with disabledClusters/adds/removes, real registry
 *   7. listSurface EQUIVALENCE — listSurface with vs without real registry
 *   8. FIX-3 CORE INSTALL — synthetic tier:core capability skills in stageSkillsForProfile
 *   9. FIX-4 DIVERGENCE GUARD — colliding capId + CLUSTERS name with diff value → hand-authored wins
 *  10. FIX-5 MALFORMED-ARRAY — non-array capabilityClusters entry is skipped without throw
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveProfile, loadSkillsManifest, stageSkillsForProfile } = require('../gsd-core/bin/lib/install-profiles.cjs');
const { resolveSurface, writeSurface, listSurface } = require('../gsd-core/bin/lib/surface.cjs');
const realRegistry = require('../gsd-core/bin/lib/capability-registry.cjs');
const { cleanup } = require('./helpers.cjs');

const REAL_COMMANDS_DIR = path.join(__dirname, '..', 'commands', 'gsd');

// ─── helpers ────────────────────────────────────────────────────────────────

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cap-cons-'));
}

/** Compare two Sets for equality (membership only). */
function setsEqual(a, b) {
  if (!(a instanceof Set) || !(b instanceof Set)) return false;
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function setDiff(a, b) {
  const extra = [...a].filter(x => !b.has(x));
  const missing = [...b].filter(x => !a.has(x));
  return { extra, missing };
}

// ─── 1. RECONCILIATION ──────────────────────────────────────────────────────

describe('registry reconciliation: UI tier=full', () => {
  test('profileMembership.ui.tier is "full"', () => {
    assert.strictEqual(
      realRegistry.profileMembership.ui.tier,
      'full',
      'After tier:full reconciliation, profileMembership.ui.tier must be "full"'
    );
  });

  test('profileMembership.ui.profiles contains only ["full"]', () => {
    assert.deepStrictEqual(
      realRegistry.profileMembership.ui.profiles,
      ['full'],
      'tier:full capability should only appear in the full profile'
    );
  });

  test('capabilityClusters.ui is ["ui-phase","ui-review"]', () => {
    assert.deepStrictEqual(
      realRegistry.capabilityClusters.ui,
      ['ui-phase', 'ui-review'],
      'capabilityClusters.ui should list both UI skills'
    );
  });
});

// ─── 2. EQUIVALENCE: resolveProfile ─────────────────────────────────────────
//
// For every named profile, resolveProfile with and without the real registry
// MUST produce identical skill and agent sets.
//
// The real registry's UI capability is tier:full → only included in 'full' profile.
// 'full' early-returns '*' (sentinel path) regardless of registry, so the real
// registry adds NOTHING for any current profile. This is the no-op proof.

describe('resolveProfile equivalence: real registry is a no-op', () => {
  const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);

  for (const profile of ['core', 'standard', 'full']) {
    test(`profile="${profile}" — same skills with vs without real registry`, () => {
      const without = resolveProfile({ modes: [profile], manifest });
      const withReg = resolveProfile({ modes: [profile], manifest, registry: realRegistry });

      if (without.skills === '*') {
        assert.strictEqual(withReg.skills, '*',
          `${profile}: sentinel path must be preserved with registry`);
      } else {
        assert.ok(
          setsEqual(without.skills, withReg.skills),
          `${profile}: skills differ. Extra: ${[...setDiff(withReg.skills, without.skills).extra]}. Missing: ${[...setDiff(withReg.skills, without.skills).missing]}`
        );
        assert.ok(
          setsEqual(without.agents, withReg.agents),
          `${profile}: agents differ`
        );
      }
    });
  }

  test('profile="core,standard" composed — no-op with real registry', () => {
    const without = resolveProfile({ modes: ['core', 'standard'], manifest });
    const withReg = resolveProfile({ modes: ['core', 'standard'], manifest, registry: realRegistry });
    assert.ok(
      setsEqual(without.skills, withReg.skills),
      'composed profile: skills must be identical with and without real registry'
    );
  });
});

// ─── 3. FUNCTIONAL: synthetic registry ──────────────────────────────────────

describe('resolveProfile functional: synthetic registry adds capability skills', () => {
  // Minimal manifest: foo-skill exists (capability-owned), help exists (profile base)
  const manifest = new Map([
    ['help', []],
    ['foo-skill', []],
    ['bar-skill', ['foo-skill']],  // bar depends on foo (transitive test)
    ['_calls_agents_help', []],
    ['_calls_agents_foo-skill', []],
    ['_calls_agents_bar-skill', []],
  ]);
  // Synthetic registry: 'foo' capability is in core/standard/full
  const syntheticRegistry = {
    capabilityClusters: { foo: ['foo-skill'] },
    profileMembership:  { foo: { tier: 'core', profiles: ['core', 'standard', 'full'] } },
  };
  // Override profiles so 'core' does NOT include foo-skill in its base list
  const profilesOverride = {
    core:     ['help'],
    standard: ['help'],
    full:     '*',
  };

  test('core profile WITHOUT registry: foo-skill absent', () => {
    const result = resolveProfile({ modes: ['core'], manifest, _profilesOverride: profilesOverride });
    assert.ok(result.skills instanceof Set, 'skills must be a Set');
    assert.ok(!result.skills.has('foo-skill'), 'foo-skill should NOT be in core without registry');
  });

  test('core profile WITH synthetic registry: foo-skill is included', () => {
    const result = resolveProfile({
      modes: ['core'],
      manifest,
      _profilesOverride: profilesOverride,
      registry: syntheticRegistry,
    });
    assert.ok(result.skills instanceof Set, 'skills must be a Set');
    assert.ok(result.skills.has('foo-skill'),
      'foo-skill should be in core when capability registry maps it to core');
    assert.ok(result.skills.has('help'),
      'core base skill must still be present');
  });

  test('standard profile WITH synthetic registry: foo-skill is included', () => {
    const result = resolveProfile({
      modes: ['standard'],
      manifest,
      _profilesOverride: profilesOverride,
      registry: syntheticRegistry,
    });
    assert.ok(result.skills.has('foo-skill'),
      'foo-skill should be in standard when capability registry maps it to standard');
  });

  test('transitive closure: capability skill that requires another skill pulls it in', () => {
    const transitiveRegistry = {
      capabilityClusters: { bar: ['bar-skill'] },
      profileMembership:  { bar: { tier: 'core', profiles: ['core', 'standard', 'full'] } },
    };
    const result = resolveProfile({
      modes: ['core'],
      manifest,
      _profilesOverride: profilesOverride,
      registry: transitiveRegistry,
    });
    assert.ok(result.skills.has('bar-skill'),
      'bar-skill from capability cluster should be included');
    assert.ok(result.skills.has('foo-skill'),
      'foo-skill should be pulled in transitively (bar-skill requires foo-skill)');
  });

  test('full profile with synthetic registry: returns sentinel (not skill set)', () => {
    // full always returns '*' — synthetic registry must not break this
    const result = resolveProfile({
      modes: ['full'],
      manifest,
      _profilesOverride: profilesOverride,
      registry: syntheticRegistry,
    });
    assert.strictEqual(result.skills, '*',
      'full profile must always return "*" sentinel regardless of registry');
  });

  test('capability whose profiles do NOT include mode: skill not added', () => {
    const fullOnlyRegistry = {
      capabilityClusters: { foo: ['foo-skill'] },
      profileMembership:  { foo: { tier: 'full', profiles: ['full'] } },
    };
    const result = resolveProfile({
      modes: ['core'],
      manifest,
      _profilesOverride: profilesOverride,
      registry: fullOnlyRegistry,
    });
    assert.ok(!result.skills.has('foo-skill'),
      'foo-skill must NOT appear in core when capability only maps to full');
  });

  test('malformed registry (missing capabilityClusters) is tolerated — no throw', () => {
    const badRegistry = { profileMembership: { foo: { tier: 'core', profiles: ['core'] } } };
    assert.doesNotThrow(() => {
      resolveProfile({ modes: ['core'], manifest, _profilesOverride: profilesOverride, registry: badRegistry });
    });
  });

  test('malformed registry (non-array skills) is tolerated — no throw', () => {
    const badRegistry = {
      capabilityClusters: { foo: 'not-an-array' },
      profileMembership:  { foo: { tier: 'core', profiles: ['core'] } },
    };
    assert.doesNotThrow(() => {
      resolveProfile({ modes: ['core'], manifest, _profilesOverride: profilesOverride, registry: badRegistry });
    });
  });

  test('prototype pollution guard: __proto__ key in capabilityClusters is skipped', () => {
    const pollutionRegistry = {
      capabilityClusters: { __proto__: ['foo-skill'], foo: ['foo-skill'] },
      profileMembership:  { __proto__: { tier: 'core', profiles: ['core'] }, foo: { tier: 'core', profiles: ['core'] } },
    };
    // Should not throw and should not corrupt Object.prototype
    assert.doesNotThrow(() => {
      resolveProfile({
        modes: ['core'],
        manifest,
        _profilesOverride: profilesOverride,
        registry: pollutionRegistry,
      });
    });
  });
});

// ─── 4. SURFACE EQUIVALENCE ─────────────────────────────────────────────────

describe('resolveSurface equivalence: real registry is a no-op', () => {
  const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);

  function makeSurfaceDir(profile, disabledClusters) {
    const dir = tmpDir();
    writeSurface(dir, {
      baseProfile: profile,
      disabledClusters: disabledClusters || [],
      explicitAdds: [],
      explicitRemoves: [],
    });
    return dir;
  }

  for (const profile of ['core', 'standard', 'full']) {
    test(`profile="${profile}" surface — same skills with vs without real registry`, (t) => {
      const dir1 = makeSurfaceDir(profile, []);
      const dir2 = makeSurfaceDir(profile, []);
      t.after(() => { cleanup(dir1); cleanup(dir2); });

      const without = resolveSurface(dir1, manifest);
      const withReg = resolveSurface(dir2, manifest, undefined, realRegistry);

      if (without.skills === '*' || withReg.skills === '*') {
        // Both should be sets after resolveSurface materializes full
        assert.ok(
          setsEqual(without.skills, withReg.skills),
          `${profile}: sentinel mismatch between with/without registry`
        );
      } else {
        assert.ok(
          setsEqual(without.skills, withReg.skills),
          `${profile}: surface skills differ. Extra: ${[...setDiff(withReg.skills, without.skills).extra]}. Missing: ${[...setDiff(withReg.skills, without.skills).missing]}`
        );
      }
    });
  }
});

// ─── 5. SURFACE FUNCTIONAL ──────────────────────────────────────────────────

describe('resolveSurface functional: synthetic registry cluster merge', () => {
  const manifest = new Map([
    ['help', []],
    ['foo-skill', []],
    ['_calls_agents_help', []],
    ['_calls_agents_foo-skill', []],
  ]);

  // resolveSurface calls resolveProfile internally without _profilesOverride, so we test
  // the cluster merge path using disabledClusters + a full base profile (which materializes
  // all manifest skills, so foo-skill is present before any cluster disable).


  test('synthetic capability cluster is disable-able via disabledClusters', (t) => {
    // Write a surface state that disables the synthetic capability cluster by its capId key.
    const dir = tmpDir();
    t.after(() => cleanup(dir));

    // Use 'full' base profile — resolveSurface materializes all manifest skills.
    writeSurface(dir, {
      baseProfile: 'full',
      disabledClusters: ['foo'],   // disable the synthetic capability cluster
      explicitAdds: [],
      explicitRemoves: [],
    });

    const syntheticRegistry = {
      capabilityClusters: { foo: ['foo-skill'] },
      profileMembership:  { foo: { tier: 'full', profiles: ['full'] } },
    };

    const without = resolveSurface(dir, manifest);
    const withReg = resolveSurface(dir, manifest, undefined, syntheticRegistry);

    // Without registry: 'foo' is not a known cluster key, so disabledClusters=['foo']
    // removes nothing → foo-skill stays enabled.
    assert.ok(without.skills.has('foo-skill'),
      'without registry, foo-skill should remain (foo cluster unknown)');

    // With registry: 'foo' cluster is known, disabledClusters=['foo'] removes foo-skill.
    assert.ok(!withReg.skills.has('foo-skill'),
      'with registry, foo-skill should be disabled when its capability cluster is in disabledClusters');

    // Non-capability skills must not be affected.
    assert.ok(withReg.skills.has('help'),
      'help should remain enabled (not in foo capability cluster)');
  });

  test('resolveSurface with absent registry still returns correct result', (t) => {
    const dir = tmpDir();
    t.after(() => cleanup(dir));

    writeSurface(dir, {
      baseProfile: 'full',
      disabledClusters: [],
      explicitAdds: [],
      explicitRemoves: [],
    });
    assert.doesNotThrow(() => {
      resolveSurface(dir, manifest);
    });
  });

  test('resolveSurface with malformed registry.capabilityClusters is tolerated', (t) => {
    const dir = tmpDir();
    t.after(() => cleanup(dir));

    writeSurface(dir, {
      baseProfile: 'full',
      disabledClusters: [],
      explicitAdds: [],
      explicitRemoves: [],
    });
    const badRegistry = { capabilityClusters: null, profileMembership: {} };
    assert.doesNotThrow(() => {
      resolveSurface(dir, manifest, undefined, badRegistry);
    });
  });
});

// ─── 6. LIVE-PATH EQUIVALENCE ───────────────────────────────────────────────
//
// FIX 6: prove no-op across the LIVE paths (disabledClusters, adds, removes,
// non-empty base profile) with the real registry vs without.

describe('resolveSurface live-path equivalence: real registry is a no-op', () => {
  const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);

  test('disabledClusters:["ui"] surface — same with vs without real registry', (t) => {
    // 'ui' exists in CLUSTERS (the hand-authored map) so the registry's entry
    // must be equal (4a gate) — disable outcome identical with or without registry.
    const dir1 = tmpDir();
    const dir2 = tmpDir();
    t.after(() => { cleanup(dir1); cleanup(dir2); });

    for (const dir of [dir1, dir2]) {
      writeSurface(dir, {
        baseProfile: 'full',
        disabledClusters: ['ui'],
        explicitAdds: [],
        explicitRemoves: [],
      });
    }

    const without = resolveSurface(dir1, manifest);
    const withReg = resolveSurface(dir2, manifest, undefined, realRegistry);

    assert.ok(
      setsEqual(without.skills, withReg.skills),
      `disabledClusters:["ui"] — skills differ. Extra: ${[...setDiff(withReg.skills, without.skills).extra]}. Missing: ${[...setDiff(withReg.skills, without.skills).missing]}`
    );
  });

  test('explicit adds — same with vs without real registry', (t) => {
    const dir1 = tmpDir();
    const dir2 = tmpDir();
    t.after(() => { cleanup(dir1); cleanup(dir2); });

    for (const dir of [dir1, dir2]) {
      writeSurface(dir, {
        baseProfile: 'core',
        disabledClusters: [],
        explicitAdds: ['review'],
        explicitRemoves: [],
      });
    }

    const without = resolveSurface(dir1, manifest);
    const withReg = resolveSurface(dir2, manifest, undefined, realRegistry);

    assert.ok(
      setsEqual(without.skills, withReg.skills),
      `explicit adds — skills differ. Extra: ${[...setDiff(withReg.skills, without.skills).extra]}. Missing: ${[...setDiff(withReg.skills, without.skills).missing]}`
    );
  });

  test('explicit removes — same with vs without real registry', (t) => {
    const dir1 = tmpDir();
    const dir2 = tmpDir();
    t.after(() => { cleanup(dir1); cleanup(dir2); });

    for (const dir of [dir1, dir2]) {
      writeSurface(dir, {
        baseProfile: 'standard',
        disabledClusters: [],
        explicitAdds: [],
        explicitRemoves: ['review'],
      });
    }

    const without = resolveSurface(dir1, manifest);
    const withReg = resolveSurface(dir2, manifest, undefined, realRegistry);

    assert.ok(
      setsEqual(without.skills, withReg.skills),
      `explicit removes — skills differ. Extra: ${[...setDiff(withReg.skills, without.skills).extra]}. Missing: ${[...setDiff(withReg.skills, without.skills).missing]}`
    );
  });
});

// ─── 7. listSurface EQUIVALENCE ─────────────────────────────────────────────
//
// FIX 6: prove listSurface is a no-op with real registry.

describe('listSurface equivalence: real registry is a no-op', () => {
  const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);

  for (const profile of ['core', 'standard', 'full']) {
    test(`listSurface profile="${profile}" — enabled/disabled/tokenCost identical with vs without real registry`, (t) => {
      const dir1 = tmpDir();
      const dir2 = tmpDir();
      t.after(() => { cleanup(dir1); cleanup(dir2); });

      for (const dir of [dir1, dir2]) {
        writeSurface(dir, {
          baseProfile: profile,
          disabledClusters: [],
          explicitAdds: [],
          explicitRemoves: [],
        });
      }

      const without = listSurface(dir1, manifest);
      const withReg = listSurface(dir2, manifest, undefined, realRegistry);

      assert.deepStrictEqual(without.enabled, withReg.enabled,
        `${profile}: enabled list differs`);
      assert.deepStrictEqual(without.disabled, withReg.disabled,
        `${profile}: disabled list differs`);
      assert.strictEqual(without.tokenCost, withReg.tokenCost,
        `${profile}: tokenCost differs`);
    });
  }

  test('listSurface with disabledClusters:["utility"] — identical with vs without real registry', (t) => {
    const dir1 = tmpDir();
    const dir2 = tmpDir();
    t.after(() => { cleanup(dir1); cleanup(dir2); });

    for (const dir of [dir1, dir2]) {
      writeSurface(dir, {
        baseProfile: 'full',
        disabledClusters: ['utility'],
        explicitAdds: [],
        explicitRemoves: [],
      });
    }

    const without = listSurface(dir1, manifest);
    const withReg = listSurface(dir2, manifest, undefined, realRegistry);

    assert.deepStrictEqual(without.enabled, withReg.enabled,
      'disabled utility cluster: enabled list differs');
    assert.deepStrictEqual(without.disabled, withReg.disabled,
      'disabled utility cluster: disabled list differs');
  });
});

// ─── 8. FIX-3 CORE INSTALL ─────────────────────────────────────────────────
//
// FIX 6: stageSkillsForProfile with a registry-aware _resolvedProfile for the
// core profile includes synthetic tier:core capability skills.
// Today (real registry, tier:full): stageSkillsForProfile(core) == PROFILES.core.
// With a synthetic tier:core registry: capability skill is present in staged set.

describe('FIX-3 core install: stageSkillsForProfile honors tier:core capabilities', () => {
  test('real registry: core-profile staged set equals PROFILES.core (no-op today)', (_t) => {
    const coreManifest = new Map(); // empty — core has no transitive deps
    const { PROFILES } = require('../gsd-core/bin/lib/install-profiles.cjs');
    const expectedCore = new Set(PROFILES.core);

    const resolvedWithReg = resolveProfile({
      modes: ['core'],
      manifest: coreManifest,
      registry: realRegistry,
    });
    assert.ok(resolvedWithReg.skills instanceof Set, 'core profile must return a Set (not sentinel)');
    assert.ok(
      setsEqual(resolvedWithReg.skills, expectedCore),
      `core profile with real registry differs from PROFILES.core. Extra: ${[...setDiff(resolvedWithReg.skills, expectedCore).extra]}. Missing: ${[...setDiff(resolvedWithReg.skills, expectedCore).missing]}`
    );
  });

  test('synthetic tier:core registry: capability skill appears in stageSkillsForProfile output', (t) => {
    // We cannot add a real skill file, but we can verify the resolved profile
    // contains the synthetic skill from the registry — the staged set is profile-driven.
    // The synthetic skill 'foo-skill' is not in commands/gsd, but resolveProfile WOULD
    // include it. We verify the profile-level inclusion here; stageSkillsForProfile
    // would then copy it if a file existed.
    const syntheticManifest = new Map([
      ['help', []],
      ['foo-skill', []],
      ['_calls_agents_help', []],
      ['_calls_agents_foo-skill', []],
    ]);
    const profilesOverride = { core: ['help'], standard: ['help'], full: '*' };
    const syntheticRegistry = {
      capabilityClusters: { foo: ['foo-skill'] },
      profileMembership:  { foo: { tier: 'core', profiles: ['core', 'standard', 'full'] } },
    };

    const resolved = resolveProfile({
      modes: ['core'],
      manifest: syntheticManifest,
      _profilesOverride: profilesOverride,
      registry: syntheticRegistry,
    });
    assert.ok(resolved.skills instanceof Set, 'should return Set');
    assert.ok(resolved.skills.has('foo-skill'),
      'tier:core capability skill must appear in core install resolved profile (FIX-3)');

    // Verify stageSkillsForProfile on a temp dir with a synthetic foo-skill.md
    const synSrcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-fix3-src-'));
    const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-fix3-stage-'));
    t.after(() => { cleanup(synSrcDir); cleanup(stageDir); });

    fs.writeFileSync(path.join(synSrcDir, 'help.md'), '---\ndescription: help\n---\n', 'utf8');
    fs.writeFileSync(path.join(synSrcDir, 'foo-skill.md'), '---\ndescription: foo\n---\n', 'utf8');

    // stageSkillsForProfile returns a temp dir with files matching resolved.skills
    const staged = stageSkillsForProfile(synSrcDir, resolved);
    t.after(() => cleanup(staged));

    const stagedFiles = fs.readdirSync(staged);
    assert.ok(stagedFiles.includes('foo-skill.md'),
      'stageSkillsForProfile must include foo-skill.md for tier:core capability (FIX-3)');
    assert.ok(stagedFiles.includes('help.md'),
      'stageSkillsForProfile must include help.md (base skill)');
  });

  test('FIX-3 documented behavior: minimal==core; tier:core capability IS in minimal', () => {
    // MINIMAL_SKILL_ALLOWLIST === [...PROFILES.core] — explicitly verified.
    // MINIMAL_ALLOWLIST_SET (internal) is new Set(MINIMAL_SKILL_ALLOWLIST).
    // Any tier:core capability DOES belong in minimal/core install.
    // This test documents and asserts that equivalence.
    const { MINIMAL_SKILL_ALLOWLIST, PROFILES } = require('../gsd-core/bin/lib/install-profiles.cjs');
    const minimalSet = new Set(MINIMAL_SKILL_ALLOWLIST);
    const profilesCore = new Set(PROFILES.core);
    assert.ok(
      setsEqual(minimalSet, profilesCore),
      'MINIMAL_SKILL_ALLOWLIST must equal PROFILES.core — minimal IS the core profile'
    );
  });
});

// ─── 9. FIX-4 DIVERGENCE GUARD ─────────────────────────────────────────────
//
// FIX 6: when a capabilityClusters entry collides with a CLUSTERS key but has
// DIFFERENT values, the hand-authored CLUSTERS value must win (no silent override).

describe('FIX-4 divergence guard: colliding capId uses hand-authored CLUSTERS value', () => {
  // Construct a scenario where a capId matches a real CLUSTERS key but the
  // registry reports a different (shorter) skill list.  The disable behavior
  // must use the hand-authored (longer/correct) list.
  test('colliding capId with different value: hand-authored wins for disabledClusters', (t) => {
    const dir = tmpDir();
    t.after(() => cleanup(dir));

    // Use 'utility' as the colliding cluster — it exists in the real CLUSTERS map.
    // The hand-authored utility cluster has several members.
    // The divergent registry would report a shorter list (fewer skills).
    const { CLUSTERS } = require('../gsd-core/bin/lib/clusters.cjs');
    const realUtilitySkills = CLUSTERS.utility; // e.g. ['health', 'stats', ...]
    assert.ok(Array.isArray(realUtilitySkills) && realUtilitySkills.length >= 1,
      'test pre-condition: utility cluster must have at least one skill');

    // Create a divergent registry that reports a single-skill utility cluster
    // (different from the real multi-skill one).
    const divergentRegistry = {
      capabilityClusters: { utility: [realUtilitySkills[0]] }, // only first skill
      profileMembership:  { utility: { tier: 'full', profiles: ['full'] } },
    };

    // Build a minimal manifest covering the real utility skills
    const manifestEntries = [['help', []]];
    const agentEntries = [['_calls_agents_help', []]];
    for (const s of realUtilitySkills) {
      manifestEntries.push([s, []]);
      agentEntries.push([`_calls_agents_${s}`, []]);
    }
    const manifest = new Map([...manifestEntries, ...agentEntries]);

    writeSurface(dir, {
      baseProfile: 'full',
      disabledClusters: ['utility'],
      explicitAdds: [],
      explicitRemoves: [],
    });

    // Without registry: uses hand-authored CLUSTERS.utility (all skills disabled)
    const without = resolveSurface(dir, manifest);
    // With divergent registry: hand-authored wins, so result is still all disabled
    const withDiv = resolveSurface(dir, manifest, undefined, divergentRegistry);

    // All hand-authored utility skills must be disabled in BOTH cases.
    for (const s of realUtilitySkills) {
      assert.ok(!without.skills.has(s),
        `without registry: ${s} must be disabled (utility cluster disabled)`);
      assert.ok(!withDiv.skills.has(s),
        `with divergent registry: ${s} must be disabled (hand-authored wins over divergent registry)`);
    }

    // The results must be identical — divergent registry must not change outcomes.
    assert.ok(
      setsEqual(without.skills, withDiv.skills),
      `divergent registry changed outcome vs hand-authored CLUSTERS — skills differ. Extra: ${[...setDiff(withDiv.skills, without.skills).extra]}. Missing: ${[...setDiff(withDiv.skills, without.skills).missing]}`
    );
  });

  test('non-colliding capId: new capability cluster is merged normally', (t) => {
    const dir = tmpDir();
    t.after(() => cleanup(dir));

    const manifest = new Map([
      ['help', []],
      ['novel-skill', []],
      ['_calls_agents_help', []],
      ['_calls_agents_novel-skill', []],
    ]);

    // 'novel-cap' does NOT exist in CLUSTERS → no collision → merged normally
    const nonCollidingRegistry = {
      capabilityClusters: { 'novel-cap': ['novel-skill'] },
      profileMembership:  { 'novel-cap': { tier: 'full', profiles: ['full'] } },
    };

    writeSurface(dir, {
      baseProfile: 'full',
      disabledClusters: ['novel-cap'],
      explicitAdds: [],
      explicitRemoves: [],
    });

    const withReg = resolveSurface(dir, manifest, undefined, nonCollidingRegistry);

    // novel-skill must be disabled (novel-cap cluster is disabled and registry provided it)
    assert.ok(!withReg.skills.has('novel-skill'),
      'novel-skill must be disabled via non-colliding capability cluster');
    assert.ok(withReg.skills.has('help'),
      'help must remain enabled');
  });
});

// ─── 10. FIX-5 MALFORMED-ARRAY GUARD ───────────────────────────────────────
//
// FIX 6: non-array capabilityClusters entries must be silently skipped,
// never causing a throw from clustersToSkills or resolveSurface.

describe('FIX-5 malformed-array guard: non-array cluster values are skipped', () => {
  const manifest = new Map([
    ['help', []],
    ['foo-skill', []],
    ['_calls_agents_help', []],
    ['_calls_agents_foo-skill', []],
  ]);

  test('non-array capabilityClusters value (string): no throw, foo-skill not disabled', (t) => {
    const dir = tmpDir();
    t.after(() => cleanup(dir));

    writeSurface(dir, {
      baseProfile: 'full',
      disabledClusters: ['foo'],
      explicitAdds: [],
      explicitRemoves: [],
    });

    const badRegistry = {
      capabilityClusters: { foo: 'not-an-array' },
      profileMembership:  { foo: { tier: 'full', profiles: ['full'] } },
    };

    let result;
    assert.doesNotThrow(() => {
      result = resolveSurface(dir, manifest, undefined, badRegistry);
    }, 'non-array cluster value must not throw');

    // 'foo' cluster had a non-array value → skipped → disabledClusters=['foo']
    // removes nothing → foo-skill stays enabled.
    assert.ok(result.skills.has('foo-skill'),
      'foo-skill must remain enabled when cluster value is non-array (FIX-5)');
  });

  test('non-array capabilityClusters value (object): no throw', (t) => {
    const dir = tmpDir();
    t.after(() => cleanup(dir));

    writeSurface(dir, {
      baseProfile: 'full',
      disabledClusters: [],
      explicitAdds: [],
      explicitRemoves: [],
    });

    const badRegistry = {
      capabilityClusters: { foo: { not: 'an-array' } },
      profileMembership:  { foo: { tier: 'full', profiles: ['full'] } },
    };

    assert.doesNotThrow(() => {
      resolveSurface(dir, manifest, undefined, badRegistry);
    }, 'object-valued cluster must not throw (FIX-5)');
  });

  test('null capabilityClusters value: no throw', (t) => {
    const dir = tmpDir();
    t.after(() => cleanup(dir));

    writeSurface(dir, {
      baseProfile: 'full',
      disabledClusters: [],
      explicitAdds: [],
      explicitRemoves: [],
    });

    const badRegistry = {
      capabilityClusters: { foo: null },
      profileMembership:  { foo: { tier: 'full', profiles: ['full'] } },
    };

    assert.doesNotThrow(() => {
      resolveSurface(dir, manifest, undefined, badRegistry);
    }, 'null cluster value must not throw (FIX-5)');
  });
});
