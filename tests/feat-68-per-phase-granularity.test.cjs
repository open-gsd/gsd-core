/**
 * Feature test for issue #68 — per-phase granularity.
 *
 * Adds a `granularities` block to .planning/config.json that accepts phase-type
 * keys (planning / discuss / research / execution / verification /
 * completion). Resolution precedence:
 *
 *   1. granularities[phaseType]  — per-phase override (enum-guarded)
 *   2. top-level `granularity`   — global override (new-project / legacy depth)
 *   3. planning.granularity      — canonical global default (always present post-merge)
 *   4. 'standard'                — hard fallback
 *
 * Tests are typed-IR / structural — assert on the value returned by
 * resolveGranularityInternal, not stdout/grep. Each test seeds a temp project
 * with a fixture .planning/config.json and asserts the resolver picks
 * the right granularity for each phase type.
 *
 * Structure mirrors tests/feat-3023-model-phase-types.test.cjs exactly.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  resolveGranularityInternal,
  VALID_GRANULARITIES,
} = require('../get-shit-done/bin/lib/core.cjs');
const commands = require('../get-shit-done/bin/lib/commands.cjs');
const {
  VALID_PHASE_TYPES,
} = require('../get-shit-done/bin/lib/model-profiles.cjs');
const { isValidConfigKey } = require('../get-shit-done/bin/lib/config-schema.cjs');

const { createTempDir, runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const makeTmp = (prefix) => createTempDir(`gsd-68-${prefix}-`);

function writeConfig(projectDir, config) {
  const planningDir = path.join(projectDir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify(config, null, 2));
}

// ─── Export check ────────────────────────────────────────────────────────────

describe('#68 exports: resolveGranularityInternal and VALID_GRANULARITIES are exported', () => {
  test('resolveGranularityInternal is a function', () => {
    assert.equal(typeof resolveGranularityInternal, 'function');
  });

  test('VALID_GRANULARITIES is a Set containing coarse, standard, fine', () => {
    assert.ok(VALID_GRANULARITIES instanceof Set);
    assert.deepStrictEqual(
      [...VALID_GRANULARITIES].sort(),
      ['coarse', 'fine', 'standard'].sort()
    );
  });
});

// ─── Schema: granularities.<phase_type> validation ──────────────────────────

describe('#68 config-schema: granularities.<phase_type> validation', () => {
  test('granularities.planning is a valid config key', () => {
    assert.equal(isValidConfigKey('granularities.planning'), true);
  });

  test('all six phase-type slots are valid config keys', () => {
    for (const slot of ['planning', 'discuss', 'research', 'execution', 'verification', 'completion']) {
      assert.equal(isValidConfigKey(`granularities.${slot}`), true,
        `granularities.${slot} must be a valid config key`);
    }
  });

  test('unknown phase-type is rejected', () => {
    assert.equal(isValidConfigKey('granularities.bogus'), false,
      'unknown phase-type must NOT be accepted');
    assert.equal(isValidConfigKey('granularities.deployment'), false,
      'unknown phase-type must NOT be accepted');
  });

  test('granularities alone (without a slot) is not a valid config-set key — mirrors models behavior', () => {
    // Setting the whole block isn't a granular set; users edit JSON directly.
    assert.equal(isValidConfigKey('granularities'), false);
  });
});

// ─── Resolver behavior: per-phase override wins ──────────────────────────────

describe('#68 resolver: granularities.<phase_type> overrides global granularity', () => {
  let projectDir;
  beforeEach(() => { projectDir = makeTmp('resolver'); });
  afterEach(() => { cleanup(projectDir); });

  test('per-phase override wins: granularities.planning=fine resolves to fine', () => {
    writeConfig(projectDir, {
      granularity: 'standard',
      granularities: { planning: 'fine' },
    });
    assert.equal(resolveGranularityInternal(projectDir, 'planning'), 'fine');
  });

  test('phase type with no per-phase override falls back to global granularity', () => {
    writeConfig(projectDir, {
      granularity: 'coarse',
      granularities: { planning: 'fine' },
    });
    // 'execution' has no per-phase override → falls back to top-level granularity
    assert.equal(resolveGranularityInternal(projectDir, 'execution'), 'coarse');
  });

  test('all six phase types can be overridden independently', () => {
    writeConfig(projectDir, {
      granularity: 'standard',
      granularities: {
        planning: 'fine',
        discuss: 'coarse',
        research: 'fine',
        execution: 'coarse',
        verification: 'fine',
        completion: 'coarse',
      },
    });
    assert.equal(resolveGranularityInternal(projectDir, 'planning'), 'fine');
    assert.equal(resolveGranularityInternal(projectDir, 'discuss'), 'coarse');
    assert.equal(resolveGranularityInternal(projectDir, 'research'), 'fine');
    assert.equal(resolveGranularityInternal(projectDir, 'execution'), 'coarse');
    assert.equal(resolveGranularityInternal(projectDir, 'verification'), 'fine');
    assert.equal(resolveGranularityInternal(projectDir, 'completion'), 'coarse');
  });
});

// ─── Resolver: invalid per-phase value falls through ─────────────────────────

describe('#68 resolver: invalid per-phase value falls through to global (typo safety)', () => {
  let projectDir;
  beforeEach(() => { projectDir = makeTmp('invalid'); });
  afterEach(() => { cleanup(projectDir); });

  test('invalid value ultra falls through to global granularity', () => {
    writeConfig(projectDir, {
      granularity: 'coarse',
      granularities: { planning: 'ultra' }, // not a valid enum value
    });
    // Falls through to top-level granularity
    assert.equal(resolveGranularityInternal(projectDir, 'planning'), 'coarse');
  });

  test('invalid value empty-string falls through to global granularity', () => {
    writeConfig(projectDir, {
      granularity: 'fine',
      granularities: { planning: '' },
    });
    assert.equal(resolveGranularityInternal(projectDir, 'planning'), 'fine');
  });
});

// ─── Resolver: malformed granularities block doesn't throw ───────────────────

describe('#68 resolver: malformed granularities value does not throw', () => {
  let projectDir;
  beforeEach(() => { projectDir = makeTmp('malformed'); });
  afterEach(() => { cleanup(projectDir); });

  test('granularities as a string does not throw, returns global fallback', () => {
    writeConfig(projectDir, {
      granularity: 'coarse',
      granularities: 'fine', // string, not an object
    });
    assert.doesNotThrow(() => resolveGranularityInternal(projectDir, 'planning'));
    assert.equal(resolveGranularityInternal(projectDir, 'planning'), 'coarse');
  });

  test('granularities as null does not throw, returns global fallback', () => {
    writeConfig(projectDir, {
      granularity: 'coarse',
      granularities: null,
    });
    assert.doesNotThrow(() => resolveGranularityInternal(projectDir, 'planning'));
    assert.equal(resolveGranularityInternal(projectDir, 'planning'), 'coarse');
  });

  test('granularities as an array does not throw, returns global fallback', () => {
    writeConfig(projectDir, {
      granularity: 'fine',
      granularities: ['fine'],
    });
    assert.doesNotThrow(() => resolveGranularityInternal(projectDir, 'planning'));
    assert.equal(resolveGranularityInternal(projectDir, 'planning'), 'fine');
  });
});

// ─── Backward-compat (Hyrum): no granularities key mirrors pre-feature behavior

describe('#68 backward-compat: no granularities key resolves identically to pre-feature global', () => {
  let projectDir;
  beforeEach(() => { projectDir = makeTmp('compat'); });
  afterEach(() => { cleanup(projectDir); });

  test('top-level granularity=fine resolves to fine for all six phase types (no granularities key)', () => {
    writeConfig(projectDir, {
      granularity: 'fine',
    });
    for (const phaseType of ['planning', 'discuss', 'research', 'execution', 'verification', 'completion']) {
      assert.equal(resolveGranularityInternal(projectDir, phaseType), 'fine',
        `${phaseType} must resolve to fine`);
    }
  });

  test('no granularity key at all → all phase types resolve to standard (canonical default)', () => {
    writeConfig(projectDir, {});
    for (const phaseType of ['planning', 'discuss', 'research', 'execution', 'verification', 'completion']) {
      assert.equal(resolveGranularityInternal(projectDir, phaseType), 'standard',
        `${phaseType} must resolve to standard (canonical default)`);
    }
  });
});

// ─── Global precedence chain ─────────────────────────────────────────────────

describe('#68 resolver: global fallback precedence chain', () => {
  let projectDir;
  beforeEach(() => { projectDir = makeTmp('precedence'); });
  afterEach(() => { cleanup(projectDir); });

  test('top-level granularity honored when present', () => {
    writeConfig(projectDir, {
      granularity: 'coarse',
      planning: { granularity: 'fine' }, // planning.granularity is lower precedence
    });
    assert.equal(resolveGranularityInternal(projectDir, 'execution'), 'coarse');
  });

  test('planning.granularity honored when top-level granularity absent', () => {
    writeConfig(projectDir, {
      planning: { granularity: 'fine' },
    });
    assert.equal(resolveGranularityInternal(projectDir, 'execution'), 'fine');
  });

  test('hard default standard when neither top-level nor planning.granularity present', () => {
    writeConfig(projectDir, {});
    assert.equal(resolveGranularityInternal(projectDir, 'execution'), 'standard');
  });

  test('per-phase override beats all global sources', () => {
    writeConfig(projectDir, {
      granularity: 'coarse',
      planning: { granularity: 'coarse' },
      granularities: { planning: 'fine' },
    });
    assert.equal(resolveGranularityInternal(projectDir, 'planning'), 'fine');
  });
});

// ─── VALID_PHASE_TYPES consistency ──────────────────────────────────────────

describe('#68 VALID_PHASE_TYPES covers all six slots used by granularities', () => {
  test('the six granularities slots are all valid phase types', () => {
    for (const slot of ['planning', 'discuss', 'research', 'execution', 'verification', 'completion']) {
      assert.ok(VALID_PHASE_TYPES.has(slot),
        `${slot} must be in VALID_PHASE_TYPES`);
    }
  });
});

// ─── CMD-level: cmdResolveGranularity export + CLI behavior ─────────────────
// Mirrors the resolve-model command tests in tests/commands.test.cjs (CMD-03).

describe('#68 exports: cmdResolveGranularity is exported as a function', () => {
  test('cmdResolveGranularity is a function', () => {
    assert.equal(typeof commands.cmdResolveGranularity, 'function');
  });
});

describe('#68 resolve-granularity command: CLI behavior', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('(a) missing phase-type arg → command exits with error mentioning phase-type required', () => {
    const result = runGsdTools('resolve-granularity', tmpDir);
    assert.ok(!result.success, 'should fail without phase-type');
    assert.ok(result.error.includes('phase-type required'), `error should mention phase-type required; got: ${result.error}`);
  });

  test('(b) unknown phase type → result includes unknown_phase_type: true', () => {
    const result = runGsdTools('resolve-granularity nonexistent-phase', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.unknown_phase_type, true, 'should flag unknown phase type');
    assert.ok(output.granularity, 'should still return a granularity');
  });

  test('(c) valid phase type with granularities override → returns override granularity', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({
        granularity: 'standard',
        granularities: { planning: 'fine' },
      })
    );
    const result = runGsdTools('resolve-granularity planning', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.granularity, 'fine', 'granularities.planning override should win');
    assert.strictEqual(output.phase_type, 'planning');
    assert.strictEqual(output.unknown_phase_type, undefined, 'known phase type must not have unknown_phase_type');
  });
});
