// allow-test-rule: source-text-is-the-product agent .md instruction surface see #1205
// agents/gsd-roadmapper.md is the deployed agent — the Granularity Calibration table
// AND the phase_id_convention instructions ARE the deployed behavior. Asserting on
// their prose asserts what runs in production (#163, #1205).
'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');
const { currentMilestoneRawRanges } = require('../gsd-core/bin/lib/roadmap-parser.cjs');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const AGENTS_DIR = path.join(__dirname, '..', 'agents');

function readAgent(name) {
  return fs.readFileSync(path.join(AGENTS_DIR, `${name}.md`), 'utf8');
}

// Extract the "## Granularity Calibration" section (up to the next "## " heading)
// so number-range assertions are scoped and cannot be satisfied by unrelated text
// elsewhere in the agent file.
function granularitySection(content) {
  const start = content.indexOf('## Granularity Calibration');
  assert.ok(start !== -1, 'Granularity Calibration section must exist');
  const rest = content.slice(start + '## Granularity Calibration'.length);
  const nextHeading = rest.indexOf('\n## ');
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}

// Extract a named XML-tag block (e.g. <phase_identification>…</phase_identification>)
function extractBlock(content, tag) {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = content.indexOf(open);
  const end = content.indexOf(close);
  assert.ok(start !== -1, `<${tag}> block must exist in agent`);
  assert.ok(end !== -1, `</${tag}> must close the block`);
  return content.slice(start + open.length, end);
}

describe('gsd-roadmapper granularity calibration (#163)', () => {
  const section = granularitySection(readAgent('gsd-roadmapper'));

  test('Coarse bucket is tightened to 2-4', () => {
    assert.ok(/\|\s*Coarse\s*\|\s*2-4\s*\|/.test(section), 'Coarse must be 2-4');
  });

  test('Standard bucket is tightened to 4-6', () => {
    assert.ok(/\|\s*Standard\s*\|\s*4-6\b/.test(section), 'Standard must be 4-6');
  });

  test('Fine bucket is tightened to 6-10', () => {
    assert.ok(/\|\s*Fine\s*\|\s*6-10\s*\|/.test(section), 'Fine must be 6-10');
  });

  test('no granularity row maps to an old bucket (3-5 / 5-8 / 8-12)', () => {
    // Scope to the second ("Typical Phases") column of each row so the approved
    // explanatory footnote mentioning "5-8" in the third column does not false-fail.
    assert.ok(!/\|\s*Coarse\s*\|\s*3-5\b/.test(section), 'Coarse must not map to 3-5');
    assert.ok(!/\|\s*Standard\s*\|\s*5-8\b/.test(section), 'Standard must not map to 5-8');
    assert.ok(!/\|\s*Fine\s*\|\s*8-12\b/.test(section), 'Fine must not map to 8-12');
  });

  test('Key paragraph names the thin-phase pattern and prefers folding into a neighbor', () => {
    assert.ok(
      section.includes('fold it into the most-related neighbor'),
      'Key guidance must instruct folding thin phases into the most-related neighbor'
    );
  });
});

describe('gsd-roadmapper generated convention guidance (#1205, #5027)', () => {
  const content = readAgent('gsd-roadmapper');
  const gen = require('../scripts/gen-phase-id-convention.cjs');
  const owner = require('../gsd-core/bin/lib/phase-id-card.cjs');

  test('short generated region directs emission to the canonical full reference', () => {
    const region = gen.readRegion(content.replace(/\r\n/g, '\n'), { start: gen.START, end: gen.END }, 'agents/gsd-roadmapper.md');
    assert.equal(region.violation, undefined);
    assert.equal(region.body, owner.phaseIdConventionBlock());
    const referencePath = path.join(__dirname, '..', gen.REFERENCE.file);
    const reference = gen.readRegion(fs.readFileSync(referencePath, 'utf8').replace(/\r\n/g, '\n'), { start: gen.START, end: gen.END }, gen.REFERENCE.file);
    assert.equal(reference.violation, undefined);
    assert.equal(reference.body, owner.phaseIdConventionRules());
  });
  test('phase identification applies the generated guidance', () => {
    assert.match(extractBlock(content, 'phase_identification'), /Use resolved display identifiers and paths from the generated convention guidance/);
  });

  test('output skeletons use configured display identifiers and keep detail requirements', () => {
    const section = extractBlock(content, 'output_formats');
    assert.match(section, /- \[ \] \*\*\{phase_display\}:/);
    assert.match(section, /### \{phase_display\}:/);
    for (const field of ['**Goal**', '**Depends on**', '**Requirements**', '**Success Criteria**', '**Plans**']) assert.ok(section.includes(field));
  });
});

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-68-per-phase-granularity.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-68-per-phase-granularity (consolidation epic #1969 B3 #1972)", () => {
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
} = require('../gsd-core/bin/lib/model-resolver.cjs');
const commands = require('../gsd-core/bin/lib/commands.cjs');
const {
  VALID_PHASE_TYPES,
} = require('../gsd-core/bin/lib/model-profiles.cjs');
const { isValidConfigKey } = require('../gsd-core/bin/lib/config-schema.cjs');

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

// ─── #703 CLI override: --granularity flag ────────────────────────────────────

describe('#703 resolveGranularityInternal: CLI override param (3rd arg)', () => {
  let projectDir;
  beforeEach(() => { projectDir = makeTmp('cli-override'); });
  afterEach(() => { cleanup(projectDir); });

  test('override fine beats per-phase config granularities.planning=coarse', () => {
    writeConfig(projectDir, {
      granularity: 'standard',
      granularities: { planning: 'coarse' },
    });
    assert.equal(resolveGranularityInternal(projectDir, 'planning', 'fine'), 'fine',
      'CLI override must beat per-phase config');
  });

  test('override coarse beats top-level granularity=fine', () => {
    writeConfig(projectDir, {
      granularity: 'fine',
    });
    assert.equal(resolveGranularityInternal(projectDir, 'execution', 'coarse'), 'coarse',
      'CLI override must beat top-level granularity');
  });

  test('override standard beats planning.granularity=fine global fallback (regardless of phase type)', () => {
    writeConfig(projectDir, {
      planning: { granularity: 'fine' },
    });
    assert.equal(resolveGranularityInternal(projectDir, 'execution', 'standard'), 'standard',
      'CLI override must beat planning.granularity fallback');
  });

  test("override '' (empty string) falls through to config chain", () => {
    writeConfig(projectDir, {
      granularity: 'coarse',
    });
    assert.equal(resolveGranularityInternal(projectDir, 'planning', ''), 'coarse',
      'empty-string override must fall through to config chain');
  });

  test('override undefined falls through to config chain', () => {
    writeConfig(projectDir, {
      granularity: 'fine',
    });
    assert.equal(resolveGranularityInternal(projectDir, 'planning', undefined), 'fine',
      'undefined override must fall through to config chain');
  });

  test('override null falls through to config chain', () => {
    writeConfig(projectDir, {
      granularity: 'coarse',
    });
    assert.equal(resolveGranularityInternal(projectDir, 'planning', null), 'coarse',
      'null override must fall through to config chain');
  });

  test('invalid override value falls through to config chain (not rejected in resolver)', () => {
    writeConfig(projectDir, {
      granularity: 'standard',
    });
    // Invalid override reaches resolver → falls through (validation is CLI boundary's job)
    assert.equal(resolveGranularityInternal(projectDir, 'planning', 'ultra'), 'standard',
      'invalid override must fall through to config chain in resolver');
  });
});

describe('#703 cmdResolveGranularity: --granularity CLI flag', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('--granularity fine overrides config chain via CLI tool', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ granularity: 'coarse' })
    );
    const result = runGsdTools('resolve-granularity planning --granularity fine', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.granularity, 'fine', '--granularity fine must override config coarse');
  });

  test('--granularity coarse overrides per-phase granularities.planning=fine', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({
        granularity: 'standard',
        granularities: { planning: 'fine' },
      })
    );
    const result = runGsdTools('resolve-granularity planning --granularity coarse', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.granularity, 'coarse', '--granularity coarse must beat per-phase fine');
  });

  test('invalid --granularity value exits with error', () => {
    const result = runGsdTools('resolve-granularity planning --granularity ultra', tmpDir);
    assert.ok(!result.success, 'should fail with invalid granularity');
    assert.ok(
      result.error.includes('ultra') || result.error.includes('invalid'),
      `error should mention invalid value; got: ${result.error}`
    );
  });
});

// ─── #703 end-to-end: init.plan-phase path forwards and resolves granularity ──
//
// Fixture mirrors tests/pattern-mapper.test.cjs: createTempProject() +
// minimal STATE.md + ROADMAP.md + phase directory — just enough for
// cmdInitPlanPhase to succeed without agents / git.

function makeInitPlanPhaseFixture(prefix) {
  const tmpDir = createTempProject(prefix);
  const planningDir = path.join(tmpDir, '.planning');
  fs.writeFileSync(path.join(planningDir, 'STATE.md'), [
    '# State',
    '',
    '## Current Phase',
    'Phase 1 — Foundation',
  ].join('\n'));
  fs.writeFileSync(path.join(planningDir, 'ROADMAP.md'), [
    '# Roadmap',
    '',
    '## Phase 1: Foundation',
    'Build the foundation.',
    '**Status:** Planning',
    '**Requirements:** [FOUND-01]',
  ].join('\n'));
  fs.mkdirSync(path.join(planningDir, 'phases', '01-foundation'), { recursive: true });
  return tmpDir;
}

describe('#703 init.plan-phase end-to-end: granularity resolution via CLI', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeInitPlanPhaseFixture('gsd-68-e2e-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('(1) --granularity fine overrides config granularities.planning=coarse end-to-end', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ granularity: 'standard', granularities: { planning: 'coarse' } })
    );
    const result = runGsdTools('init plan-phase 1 --granularity fine', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `init plan-phase failed: ${result.error}`);
    const data = JSON.parse(result.output);
    assert.strictEqual(data.granularity, 'fine',
      '--granularity fine override must win over granularities.planning=coarse end-to-end');
  });

  test('(2) no flag + config granularities.planning=fine → granularity=fine (Fix A: per-phase-type honored)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ granularity: 'coarse', granularities: { planning: 'fine' } })
    );
    const result = runGsdTools('init plan-phase 1', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `init plan-phase failed: ${result.error}`);
    const data = JSON.parse(result.output);
    assert.strictEqual(data.granularity, 'fine',
      'granularities.planning=fine must be honored (phaseType=planning in resolveGranularityInternal)');
  });

  test('(3) no flag + global granularity=coarse (no granularities.planning) → granularity=coarse', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ granularity: 'coarse' })
    );
    const result = runGsdTools('init plan-phase 1', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `init plan-phase failed: ${result.error}`);
    const data = JSON.parse(result.output);
    assert.strictEqual(data.granularity, 'coarse',
      'global granularity=coarse must be returned when no granularities.planning is set');
  });

  test('(4) --granularity ultra → command errors (invalid value rejected on plan-phase path)', () => {
    const result = runGsdTools('init plan-phase 1 --granularity ultra', tmpDir, { HOME: tmpDir });
    assert.ok(!result.success, 'should fail with invalid granularity ultra');
    assert.ok(
      result.error.includes('ultra') || result.error.includes('invalid'),
      `error should mention invalid value; got: ${result.error}`
    );
  });
});
  });
}

// #5027: exercise the deployed prompt artifacts with actual runtime identities.
describe('#5027 convention consumer contracts', () => {
  let root;
  beforeEach(() => { root = createTempProject('gsd-5027-consumers-'); });
  afterEach(() => cleanup(root));
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  for (const convention of ['sequential', 'bracket']) test(`${convention}: init.plan-phase paths survive prompt substitution`, () => {
    const planning = path.join(root, '.planning');
    fs.writeFileSync(path.join(planning, 'config.json'), JSON.stringify({ phase_id_convention: convention, project_code: 'GSD' }));
    fs.writeFileSync(path.join(planning, 'STATE.md'), '---\nmilestone: v2.0\n---\n');
    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), convention === 'bracket' ? '# Roadmap\n\n## [GSD.02] Active\n\n### [GSD.02] 01: Foundation\n**Goal:** Setup\n' : '# Roadmap\n\n## v2.0 Active\n\n### Phase 1: Foundation\n**Goal:** Setup\n');
    const dir = path.join(planning, 'phases', convention === 'bracket' ? 'GSD.02-01-foundation' : '01-foundation');
    fs.mkdirSync(dir, { recursive: true });
    const result = runGsdTools('init plan-phase 1', root, { HOME: root });
    assert.ok(result.success, result.error);
    const data = JSON.parse(result.output);
    const found = runGsdTools(`query find-phase ${path.basename(dir)}`, root, { HOME: root });
    assert.ok(found.success, found.error);
    assert.equal(JSON.parse(found.output).phase_number, data.phase_number);
    assert.ok(path.isAbsolute(data.phase_dir));
    for (const suffix of ['CONTEXT', 'RESEARCH', 'VERIFICATION', 'UAT']) fs.writeFileSync(path.join(dir, `${data.phase_number}-${suffix}.md`), suffix);
    for (const file of ['gsd-core/templates/planner-subagent-prompt.md', 'agents/gsd-verifier.md']) {
      const template = read(file).replaceAll('{phase_dir}', data.phase_dir).replaceAll('{phase_num}', data.phase_number);
      const artifactPaths = [...template.matchAll(/(?:@|`|\*\*Report:\*\* )([^\s`]*\/(?:01)-(?:CONTEXT|RESEARCH|VERIFICATION|UAT)\.md)/g)].map(match => match[1]);
      assert.ok(artifactPaths.length >= (file.startsWith('agents/') ? 2 : 4), file);
      artifactPaths.forEach(artifact => assert.ok(fs.existsSync(artifact), `${file}: ${artifact}`));
    }
  });
  test('rendered milestone examples bind the active window and stop before planned', () => {
    const template = read('gsd-core/templates/roadmap.md');
    const source = template.slice(template.indexOf('<summary>✅ {shipped_milestone_display}'));
    const active = source.split('\n').find(line => /^#{2,3} .*\{active_milestone_display\}/.test(line));
    const planned = source.split('\n').find(line => /^#{2,3} .*\{planned_milestone_display\}/.test(line));
    assert.ok(active && planned);
    const render = (line, key, value) => line.replace(`{${key}}`, value).replace('[Name]', 'Name');
    const roadmap = ['# Roadmap', render(active, 'active_milestone_display', '[GSD.02]'), '### [GSD.02] 01: Active', '**Goal:** Active only', render(planned, 'planned_milestone_display', '[GSD.03]'), '### [GSD.03] 01: Planned', '**Goal:** Future only'].join('\n');
    fs.writeFileSync(path.join(root, '.planning/config.json'), JSON.stringify({ phase_id_convention: 'bracket', project_code: 'GSD' }));
    fs.writeFileSync(path.join(root, '.planning/STATE.md'), '---\nmilestone: v2.0\n---\n');
    fs.writeFileSync(path.join(root, '.planning/ROADMAP.md'), roadmap);
    const ranges = currentMilestoneRawRanges(roadmap, root, 'bracket');
    assert.ok(ranges, roadmap);
    assert.equal(ranges.primary.start, roadmap.indexOf(render(active, 'active_milestone_display', '[GSD.02]')), 'scope must bind the milestone, not its first phase heading');
    const scoped = roadmap.slice(ranges.primary.start, ranges.primary.end);
    assert.ok(scoped.includes('Active only'));
    assert.ok(!scoped.includes('Future only'));
    assert.ok(!scoped.includes('[GSD.03]'), 'scope must terminate at the planned milestone heading itself');
  });
  test('remaining report surfaces use display identities and review scope resolves canonically', () => {
    for (const file of ['agents/gsd-eval-auditor.md', 'agents/gsd-ui-checker.md', 'agents/gsd-verifier.md', 'gsd-core/workflows/progress/steps/mvp-display.md']) {
      const text = read(file);
      assert.doesNotMatch(text, /Phase \{N\}|^Phase 1 — User Auth MVP/m, file);
      assert.match(text, /\{phase_display\}/, file);
    }
    for (const file of ['agents/gsd-code-reviewer.md']) {
      const text = read(file);
      assert.doesNotMatch(text, /leading digits of.*phase_dir/);
      assert.match(text, /query find-phase/);
    }
  });
});
