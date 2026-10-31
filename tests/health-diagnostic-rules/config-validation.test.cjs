'use strict';

/**
 * Tests for `src/health-diagnostic-rules/config-validation.cts` (Phase 11,
 * #3309, ADR-3180 §8.2/§8.3/§8.5) — group "config.json validation": W003,
 * E005, W004, W008, W016, W012, W013, W014, W015, W022.
 *
 * Design: .gsd/phase/refactor-3309-health-diagnostic-rule-table/40-design.md
 * Test matrix: .gsd/phase/refactor-3309-health-diagnostic-rule-table/50-test-matrix.md
 *
 * Fixture provenance (§8.5 + CONTRIBUTING "Fixture provenance (#2371)"):
 *
 * - W003, W008, W016 are STRUCTURAL ABSENCE (a file, or a key, is missing) —
 *   exempt from external-citation provenance, mirrors
 *   tests/health-diagnostic-rules/root-existence.test.cjs's own framing.
 * - E005, W004, W012, W013, W014, W015, W022 are MECHANICAL MUTATION: each
 *   fixture starts from `gsd-core/templates/config.json` (the real shipped
 *   shape, parsed once as `BASE_CONFIG`) with exactly ONE field changed to
 *   the invalid value under test, per the design doc's Fixture provenance
 *   §4. `w022`'s `models` key and `branching_strategy`/`context_window`/
 *   `phase_branch_template`/`milestone_branch_template` are not present in
 *   the shipped default at all (they are optional, additive keys) — for
 *   those the "one field changed" mutation is adding exactly that one key
 *   with its invalid value, the generic-mutation equivalent when there is no
 *   existing value to corrupt.
 *
 * Every fixture is driven through the REAL `buildPlanningSnapshot(cwd)`
 * against a REAL temp `.planning/` directory with a REAL config.json file
 * written to disk — mirrors tests/planning-snapshot.test.cjs's own
 * `writeConfig` helper exactly (same shape, same call site convention).
 *
 * TDD RED: `src/health-diagnostic-rules/config-validation.cts` does not
 * exist yet at the start of this batch — this file's
 * `require('../../gsd-core/bin/lib/health-diagnostic-rules/config-validation.cjs')`
 * throws MODULE_NOT_FOUND until this batch's implementation lands.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const { createTempDir, createTempGitProject, cleanup } = require('../helpers.cjs');
const { gitOrThrow, isFsLegalName } = require('../helpers/git-fixture.cjs');
const { resolveInterpreter } = require('../helpers/process-seam.cjs');
const { GIT_TIMEOUT_MS } = require('../helpers/timeouts.cjs');

const configValidation = require('../../gsd-core/bin/lib/health-diagnostic-rules/config-validation.cjs');
const { RULES } = configValidation;

const { buildPlanningSnapshot } = require('../../gsd-core/bin/lib/planning-snapshot.cjs');
const { SEVERITY, REMEDY_ACTION, REMEDY_RISK, applyRepairs } = require('../../gsd-core/bin/lib/health-diagnostic.cjs');
const { SCOPE } = require('../../gsd-core/bin/lib/planning-scope.cjs');

// Real shipped default, parsed once — the mutation base for every
// MECHANICAL MUTATION fixture below (design doc Fixture provenance §4).
const TEMPLATE_CONFIG_PATH = path.join(__dirname, '..', '..', 'gsd-core', 'templates', 'config.json');
const BASE_CONFIG = JSON.parse(fs.readFileSync(TEMPLATE_CONFIG_PATH, 'utf-8'));

function planningDirOf(cwd) {
  return path.join(cwd, '.planning');
}

function writeConfig(cwd, obj) {
  fs.mkdirSync(planningDirOf(cwd), { recursive: true });
  fs.writeFileSync(path.join(planningDirOf(cwd), 'config.json'), JSON.stringify(obj));
}

function writeRawConfig(cwd, rawText) {
  fs.mkdirSync(planningDirOf(cwd), { recursive: true });
  fs.writeFileSync(path.join(planningDirOf(cwd), 'config.json'), rawText);
}

// Deep-clones BASE_CONFIG and applies exactly one mutation, mirroring the
// design doc's "mechanical, rule-blind mutation of the real shipped
// template" fixture class.
function mutatedConfig(mutate) {
  const clone = JSON.parse(JSON.stringify(BASE_CONFIG));
  mutate(clone);
  return clone;
}

function ruleFor(code) {
  const rule = RULES.find((r) => r.code === code);
  assert.ok(rule, `rule ${code} not found in RULES`);
  return rule;
}

// ─── RULES shape ────────────────────────────────────────────────────────────

describe('RULES (config-validation group)', () => {
  test('exports exactly 12 rules: W003, E005, W004, W008, W016, W012, W013, W014, W015, W022, W029, W031', () => {
    assert.deepEqual(
      RULES.map((r) => r.code).sort(),
      ['E005', 'W003', 'W004', 'W008', 'W012', 'W013', 'W014', 'W015', 'W016', 'W022', 'W029', 'W031'].sort(),
    );
  });

  test('E005 is severity ERROR; the rest are severity WARNING', () => {
    assert.equal(ruleFor('E005').severity, SEVERITY.ERROR);
    for (const code of ['W003', 'W004', 'W008', 'W012', 'W013', 'W014', 'W015', 'W016', 'W022', 'W029', 'W031']) {
      assert.equal(ruleFor(code).severity, SEVERITY.WARNING, `${code} should be WARNING`);
    }
  });
});

// ─── W003 — config.json not found ───────────────────────────────────────────

describe('W003 — config.json not found', () => {
  test('fires when config.json is absent (structural absence)', (t) => {
    const cwd = createTempDir('gsd-3309-w003-1-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(planningDirOf(cwd), { recursive: true });

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W003').check(snapshot);

    assert.deepEqual(diagnostics, [
      {
        code: 'W003',
        severity: SEVERITY.WARNING,
        message: 'config.json not found',
        remedy: { action: REMEDY_ACTION.CREATE_CONFIG, risk: REMEDY_RISK.NONE, args: {} },
      },
    ]);
  });

  test('does not fire when config.json exists', (t) => {
    const cwd = createTempDir('gsd-3309-w003-2-');
    t.after(() => cleanup(cwd));
    writeConfig(cwd, BASE_CONFIG);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W003').check(snapshot), []);
  });
});

// ─── E005 — config.json JSON parse error ────────────────────────────────────

describe('E005 — config.json invalid JSON', () => {
  test('fires when config.json exists but is unparseable', (t) => {
    const cwd = createTempDir('gsd-3309-e005-1-');
    t.after(() => cleanup(cwd));
    writeRawConfig(cwd, '{ not valid json');

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('E005').check(snapshot);

    assert.deepEqual(diagnostics, [
      {
        code: 'E005',
        severity: SEVERITY.ERROR,
        message: 'config.json: JSON parse error',
        remedy: { action: REMEDY_ACTION.RESET_CONFIG, risk: REMEDY_RISK.DESTRUCTIVE, args: {} },
      },
    ]);
  });

  test('does not fire when config.json is absent (that is W003s job)', (t) => {
    const cwd = createTempDir('gsd-3309-e005-2-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(planningDirOf(cwd), { recursive: true });

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('E005').check(snapshot), []);
    assert.equal(ruleFor('W003').check(snapshot).length, 1);
  });

  test('does not fire when config.json is well-formed', (t) => {
    const cwd = createTempDir('gsd-3309-e005-3-');
    t.after(() => cleanup(cwd));
    writeConfig(cwd, BASE_CONFIG);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('E005').check(snapshot), []);
  });
});

// ─── W004 — invalid model_profile ───────────────────────────────────────────

describe('W004 — invalid model_profile', () => {
  test('fires on an invalid model_profile value (mutated shipped config)', (t) => {
    const cwd = createTempDir('gsd-3309-w004-1-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.model_profile = 'not-a-real-profile';
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W004').check(snapshot);

    assert.deepEqual(diagnostics, [
      {
        code: 'W004',
        severity: SEVERITY.WARNING,
        message: 'config.json: invalid model_profile "not-a-real-profile"',
        remedy: {
          action: REMEDY_ACTION.ADVISE,
          risk: REMEDY_RISK.NONE,
          args: { command: 'Valid values: quality, balanced, budget, adaptive, inherit' },
        },
      },
    ]);
  });

  test('does not fire on a valid model_profile', (t) => {
    const cwd = createTempDir('gsd-3309-w004-2-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.model_profile = 'balanced';
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W004').check(snapshot), []);
  });

  test('does not fire when model_profile is absent', (t) => {
    const cwd = createTempDir('gsd-3309-w004-3-');
    t.after(() => cleanup(cwd));
    writeConfig(cwd, BASE_CONFIG);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W004').check(snapshot), []);
  });
});

// ─── W008 — workflow.nyquist_validation absent ──────────────────────────────

describe('W008 — workflow.nyquist_validation absent', () => {
  test('fires when workflow is present but nyquist_validation key is deleted', (t) => {
    const cwd = createTempDir('gsd-3309-w008-1-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      delete c.workflow.nyquist_validation;
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W008').check(snapshot);

    assert.deepEqual(diagnostics, [
      {
        code: 'W008',
        severity: SEVERITY.WARNING,
        message: 'config.json: workflow.nyquist_validation absent (defaults to enabled but agents may skip)',
        remedy: { action: REMEDY_ACTION.ADD_NYQUIST_KEY, risk: REMEDY_RISK.NONE, args: {} },
      },
    ]);
  });

  test('does not fire when nyquist_validation is present (shipped default)', (t) => {
    const cwd = createTempDir('gsd-3309-w008-2-');
    t.after(() => cleanup(cwd));
    writeConfig(cwd, BASE_CONFIG);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W008').check(snapshot), []);
  });

  test('does not fire when workflow itself is absent (guard mirrors original)', (t) => {
    const cwd = createTempDir('gsd-3309-w008-3-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      delete c.workflow;
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W008').check(snapshot), []);
  });
});

// ─── W016 — workflow.ai_integration_phase absent ────────────────────────────

describe('W016 — workflow.ai_integration_phase absent', () => {
  test('fires on the unmodified shipped default — ai_integration_phase is not in the template at all (structural absence)', (t) => {
    const cwd = createTempDir('gsd-3309-w016-1-');
    t.after(() => cleanup(cwd));
    writeConfig(cwd, BASE_CONFIG);

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W016').check(snapshot);

    assert.deepEqual(diagnostics, [
      {
        code: 'W016',
        severity: SEVERITY.WARNING,
        message:
          'config.json: workflow.ai_integration_phase absent (defaults to enabled — run /gsd-ai-integration-phase before planning AI system phases)',
        remedy: { action: REMEDY_ACTION.ADD_AI_INTEGRATION_PHASE_KEY, risk: REMEDY_RISK.NONE, args: {} },
      },
    ]);
  });

  test('does not fire when ai_integration_phase key is present', (t) => {
    const cwd = createTempDir('gsd-3309-w016-2-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.workflow.ai_integration_phase = true;
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W016').check(snapshot), []);
  });

  test('does not fire when workflow itself is absent (guard mirrors original)', (t) => {
    const cwd = createTempDir('gsd-3309-w016-3-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      delete c.workflow;
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W016').check(snapshot), []);
  });
});

// ─── W012 — invalid branching_strategy ──────────────────────────────────────

describe('W012 — invalid branching_strategy', () => {
  test('fires on an invalid branching_strategy value', (t) => {
    const cwd = createTempDir('gsd-3309-w012-1-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.branching_strategy = 'bogus-strategy';
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W012').check(snapshot);

    assert.deepEqual(diagnostics, [
      {
        code: 'W012',
        severity: SEVERITY.WARNING,
        message: 'config.json: invalid branching_strategy "bogus-strategy"',
        remedy: {
          action: REMEDY_ACTION.ADVISE,
          risk: REMEDY_RISK.NONE,
          args: { command: 'Valid values: none, phase, milestone' },
        },
      },
    ]);
  });

  for (const valid of ['none', 'phase', 'milestone']) {
    test(`does not fire on valid branching_strategy "${valid}"`, (t) => {
      const cwd = createTempDir('gsd-3309-w012-valid-');
      t.after(() => cleanup(cwd));
      const cfg = mutatedConfig((c) => {
        c.branching_strategy = valid;
      });
      writeConfig(cwd, cfg);

      const snapshot = buildPlanningSnapshot(cwd);
      assert.deepEqual(ruleFor('W012').check(snapshot), []);
    });
  }

  test('does not fire when branching_strategy is absent', (t) => {
    const cwd = createTempDir('gsd-3309-w012-2-');
    t.after(() => cleanup(cwd));
    writeConfig(cwd, BASE_CONFIG);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W012').check(snapshot), []);
  });
});

// ─── W013 — context_window not a positive integer ───────────────────────────

describe('W013 — context_window not a positive integer', () => {
  test('fires on a non-integer context_window', (t) => {
    const cwd = createTempDir('gsd-3309-w013-1-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.context_window = 3.5;
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W013').check(snapshot);

    assert.deepEqual(diagnostics, [
      {
        code: 'W013',
        severity: SEVERITY.WARNING,
        message: 'config.json: context_window should be a positive integer, got "3.5"',
        remedy: {
          action: REMEDY_ACTION.ADVISE,
          risk: REMEDY_RISK.NONE,
          args: { command: 'Set to 200000 (default) or 1000000 (for 1M models)' },
        },
      },
    ]);
  });

  test('fires on a non-positive context_window (boundary: 0)', (t) => {
    const cwd = createTempDir('gsd-3309-w013-2-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.context_window = 0;
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.equal(ruleFor('W013').check(snapshot).length, 1);
  });

  test('fires on a negative context_window', (t) => {
    const cwd = createTempDir('gsd-3309-w013-3-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.context_window = -1;
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.equal(ruleFor('W013').check(snapshot).length, 1);
  });

  test('does not fire on a valid positive integer (boundary: 1)', (t) => {
    const cwd = createTempDir('gsd-3309-w013-4-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.context_window = 1;
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W013').check(snapshot), []);
  });

  test('does not fire on the conventional default (200000)', (t) => {
    const cwd = createTempDir('gsd-3309-w013-5-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.context_window = 200000;
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W013').check(snapshot), []);
  });

  test('does not fire when context_window is absent', (t) => {
    const cwd = createTempDir('gsd-3309-w013-6-');
    t.after(() => cleanup(cwd));
    writeConfig(cwd, BASE_CONFIG);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W013').check(snapshot), []);
  });
});

// ─── W014 — phase_branch_template missing {phase} ───────────────────────────

describe('W014 — phase_branch_template missing {phase} placeholder', () => {
  test('fires when the placeholder is stripped', (t) => {
    const cwd = createTempDir('gsd-3309-w014-1-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.phase_branch_template = 'phase/no-placeholder-here';
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W014').check(snapshot);

    assert.deepEqual(diagnostics, [
      {
        code: 'W014',
        severity: SEVERITY.WARNING,
        message: 'config.json: phase_branch_template missing {phase} placeholder',
        remedy: {
          action: REMEDY_ACTION.ADVISE,
          risk: REMEDY_RISK.NONE,
          args: { command: 'Template must include {phase} for phase number substitution' },
        },
      },
    ]);
  });

  test('does not fire when the placeholder is present', (t) => {
    const cwd = createTempDir('gsd-3309-w014-2-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.phase_branch_template = 'phase/{phase}';
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W014').check(snapshot), []);
  });

  test('does not fire when phase_branch_template is absent', (t) => {
    const cwd = createTempDir('gsd-3309-w014-3-');
    t.after(() => cleanup(cwd));
    writeConfig(cwd, BASE_CONFIG);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W014').check(snapshot), []);
  });
});

// ─── W015 — milestone_branch_template missing {milestone} ──────────────────

describe('W015 — milestone_branch_template missing {milestone} placeholder', () => {
  test('fires when the placeholder is stripped', (t) => {
    const cwd = createTempDir('gsd-3309-w015-1-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.milestone_branch_template = 'milestone/no-placeholder-here';
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W015').check(snapshot);

    assert.deepEqual(diagnostics, [
      {
        code: 'W015',
        severity: SEVERITY.WARNING,
        message: 'config.json: milestone_branch_template missing {milestone} placeholder',
        remedy: {
          action: REMEDY_ACTION.ADVISE,
          risk: REMEDY_RISK.NONE,
          args: { command: 'Template must include {milestone} for version substitution' },
        },
      },
    ]);
  });

  test('does not fire when the placeholder is present', (t) => {
    const cwd = createTempDir('gsd-3309-w015-2-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.milestone_branch_template = 'milestone/{milestone}';
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W015').check(snapshot), []);
  });

  test('does not fire when milestone_branch_template is absent', (t) => {
    const cwd = createTempDir('gsd-3309-w015-3-');
    t.after(() => cleanup(cwd));
    writeConfig(cwd, BASE_CONFIG);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W015').check(snapshot), []);
  });
});

// ─── W022 — models malformed (3 internal conditions, 1 code) ───────────────

describe('W022 — config.json models malformed', () => {
  test('(a) unknown phase type key fires', (t) => {
    const cwd = createTempDir('gsd-3309-w022a-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.models = { not_a_real_phase_type: 'sonnet' };
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W022').check(snapshot);

    assert.deepEqual(diagnostics, [
      {
        code: 'W022',
        severity: SEVERITY.WARNING,
        message: 'config.json: models has an unknown phase type "not_a_real_phase_type" which will be ignored',
        remedy: {
          action: REMEDY_ACTION.ADVISE,
          risk: REMEDY_RISK.NONE,
          args: {
            command: 'Valid phase types: planning, discuss, research, execution, verification, completion',
          },
        },
      },
    ]);
  });

  test('(b) known phase type with an invalid tier value fires', (t) => {
    const cwd = createTempDir('gsd-3309-w022b-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.models = { planning: 'not-a-real-tier' };
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W022').check(snapshot);

    assert.deepEqual(diagnostics, [
      {
        code: 'W022',
        severity: SEVERITY.WARNING,
        message: 'config.json: models.planning has an invalid tier value "not-a-real-tier" which will be ignored',
        remedy: {
          action: REMEDY_ACTION.ADVISE,
          risk: REMEDY_RISK.NONE,
          args: { command: 'Valid tiers: opus, sonnet, haiku, inherit' },
        },
      },
    ]);
  });

  test('(c) models present but not an object fires, and does NOT also run (a)/(b)', (t) => {
    const cwd = createTempDir('gsd-3309-w022c-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.models = 'not-an-object';
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W022').check(snapshot);

    assert.deepEqual(diagnostics, [
      {
        code: 'W022',
        severity: SEVERITY.WARNING,
        message:
          'config.json: models is set to "not-an-object", but must be an object mapping phase types to tiers — this value will be ignored',
        remedy: {
          action: REMEDY_ACTION.ADVISE,
          risk: REMEDY_RISK.NONE,
          args: {
            command: 'Set models to an object like {"planning": "sonnet"}, or remove the key to use profile defaults',
          },
        },
      },
    ]);
  });

  test('(c) an array also counts as "not an object" (Array.isArray guard)', (t) => {
    const cwd = createTempDir('gsd-3309-w022c-array-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.models = ['sonnet'];
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W022').check(snapshot);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, 'W022');
  });

  test('multiple malformed entries in one models object each produce their own diagnostic', (t) => {
    const cwd = createTempDir('gsd-3309-w022-multi-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.models = { planning: 'bogus-tier', not_a_real_phase_type: 'sonnet' };
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W022').check(snapshot);
    assert.equal(diagnostics.length, 2);
    for (const d of diagnostics) assert.equal(d.code, 'W022');
  });

  test('does not fire when models is a well-formed object', (t) => {
    const cwd = createTempDir('gsd-3309-w022-ok-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.models = { planning: 'sonnet', research: 'inherit' };
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W022').check(snapshot), []);
  });

  test('does not fire when models is absent', (t) => {
    const cwd = createTempDir('gsd-3309-w022-absent-');
    t.after(() => cleanup(cwd));
    writeConfig(cwd, BASE_CONFIG);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W022').check(snapshot), []);
  });

  test('does not fire when models is null', (t) => {
    const cwd = createTempDir('gsd-3309-w022-null-');
    t.after(() => cleanup(cwd));
    const cfg = mutatedConfig((c) => {
      c.models = null;
    });
    writeConfig(cwd, cfg);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W022').check(snapshot), []);
  });
});

// ─── W029 — .planning/ ignored but still tracked (#3586, epic #2292) ──────
//
// Group B of the test matrix (.gsd/phase/fix-3586-tracked-gitignored-planning/
// 50-test-matrix.md): the rule is a pure predicate over
// `snapshot.planningTracked` — every fixture here is driven through the REAL
// `buildPlanningSnapshot(cwd)` against a REAL temp git repo, mirroring
// tests/planning-snapshot.test.cjs's own A1-A12 fixtures (same helpers:
// createTempGitProject / gitOrThrow, no hand-built partial snapshots except
// B4, which specifically tests the field-absent-entirely case).

function writeGitignore(cwd, content) {
  fs.writeFileSync(path.join(cwd, '.gitignore'), content);
}

function commitAll(cwd, message) {
  gitOrThrow(['add', '-A'], { cwd });
  gitOrThrow(['commit', '-m', message], { cwd });
}

describe('W029 — .planning/ ignored but still tracked', () => {
  test('B1: fires when ignored AND tracked, carrying the git rm -r --cached remedy', (t) => {
    const cwd = createTempGitProject('gsd-3586-w029-b1-');
    t.after(() => cleanup(cwd));
    writeGitignore(cwd, '.planning/\n');
    commitAll(cwd, 'add gitignore');

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W029').check(snapshot);

    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, 'W029');
    assert.equal(diagnostics[0].severity, SEVERITY.WARNING);
    assert.deepEqual(diagnostics[0].remedy.action, REMEDY_ACTION.ADVISE);
    assert.deepEqual(diagnostics[0].remedy.risk, REMEDY_RISK.NONE);
    assert.match(diagnostics[0].remedy.args.command, /git rm -r --cached \.planning\//);
  });

  test('B2a: tracked + NOT ignored (the default project) is silent', (t) => {
    const cwd = createTempGitProject('gsd-3586-w029-b2a-');
    t.after(() => cleanup(cwd));
    // No .gitignore at all.

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W029').check(snapshot), []);
  });

  test('B2b: ignored + untracked (the healthy ignored state) is silent', (t) => {
    const cwd = createTempDir('gsd-3586-w029-b2b-');
    t.after(() => cleanup(cwd));
    gitOrThrow(['init'], { cwd });
    gitOrThrow(['config', 'user.email', 'test@test.com'], { cwd });
    gitOrThrow(['config', 'user.name', 'Test'], { cwd });
    gitOrThrow(['config', 'commit.gpgsign', 'false'], { cwd });
    writeGitignore(cwd, '.planning/\n');
    commitAll(cwd, 'initial (gitignore only)');
    fs.mkdirSync(path.join(cwd, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.planning', 'PROJECT.md'), '# Project\n');

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W029').check(snapshot), []);
  });

  test('B2c: neither tracked nor ignored (fresh project) is silent', (t) => {
    const cwd = createTempDir('gsd-3586-w029-b2c-');
    t.after(() => cleanup(cwd));
    gitOrThrow(['init'], { cwd });
    gitOrThrow(['config', 'user.email', 'test@test.com'], { cwd });
    gitOrThrow(['config', 'user.name', 'Test'], { cwd });
    gitOrThrow(['config', 'commit.gpgsign', 'false'], { cwd });
    gitOrThrow(['commit', '--allow-empty', '-m', 'initial'], { cwd });
    fs.mkdirSync(path.join(cwd, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.planning', 'PROJECT.md'), '# Project\n');

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W029').check(snapshot), []);
  });

  test('B3: a degraded (UNREADABLE) probe produces zero findings — never a finding from a failed probe', (t) => {
    const cwd = createTempDir('gsd-3586-w029-b3-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(path.join(cwd, '.planning'), { recursive: true });
    // No `git init` at all — the probe degrades to UNREADABLE/not_a_git_repo.

    const snapshot = buildPlanningSnapshot(cwd);
    assert.notEqual(snapshot.planningTracked.scope, 'complete');
    assert.deepEqual(ruleFor('W029').check(snapshot), []);
  });

  test('B4: field absent from the snapshot entirely is silent, no throw (forward/backward compat)', () => {
    const fakeSnapshot = {}; // deliberately missing `planningTracked`
    assert.doesNotThrow(() => {
      assert.deepEqual(ruleFor('W029').check(fakeSnapshot), []);
    });
  });

  test('B5: the RULES entry marks W029 non-repairable — ADVISE never auto-untracks', () => {
    assert.equal(ruleFor('W029').repairable, false);
  });

  // ─── ENOBUFS overflow (#3586 review F2) — the field reads COMPLETE/tracked
  // via the overflow-as-proof-of-tracking path, so the rule must still fire.
  // Discriminates by argv (mirrors tests/planning-snapshot.test.cjs's own
  // `mockGitSpawnEnobufs`) so `isGitIgnored`'s `check-ignore` call still runs
  // against the real fixture `.gitignore`.

  test('B1-enobufs: an ENOBUFS-overflowed ls-files still fires W029 (tracked is proof, not a failure)', (t) => {
    const cwd = createTempGitProject('gsd-3586-w029-b1-enobufs-');
    t.after(() => cleanup(cwd));
    writeGitignore(cwd, '.planning/\n');
    commitAll(cwd, 'add gitignore');

    const originalSpawnSync = childProcess.spawnSync;
    t.mock.method(childProcess, 'spawnSync', (cmd, args, opts) => {
      if (Array.isArray(args) && args.includes('ls-files')) {
        return {
          status: null,
          stdout: '',
          stderr: '',
          signal: null,
          error: Object.assign(new Error('spawnSync git ENOBUFS'), { code: 'ENOBUFS' }),
        };
      }
      return originalSpawnSync.call(childProcess, cmd, args, opts);
    });

    const snapshot = buildPlanningSnapshot(cwd);
    assert.strictEqual(snapshot.planningTracked.value.tracked, true);
    assert.strictEqual(snapshot.planningTracked.scope, SCOPE.COMPLETE);

    const diagnostics = ruleFor('W029').check(snapshot);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, 'W029');
  });

  // ─── C3 — negative-proof: --repair must NOT untrack anything ─────────────

  test('C3: applyRepairs never applies the W029 remedy, and .planning/ stays tracked afterward', (t) => {
    const cwd = createTempGitProject('gsd-3586-w029-c3-');
    t.after(() => cleanup(cwd));
    writeGitignore(cwd, '.planning/\n');
    commitAll(cwd, 'add gitignore');

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W029').check(snapshot);
    assert.equal(diagnostics.length, 1);

    const result = applyRepairs(cwd, diagnostics, /* repair */ true, /* backfill */ false);
    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.refused, []);
    assert.deepEqual(result.details, []);

    // The tracked file must still be in the index — nothing was untracked.
    const trackedAfter = gitOrThrow(['ls-files', '--', '.planning'], { cwd }).trim();
    assert.ok(trackedAfter.length > 0, '.planning/ must still be tracked after a --repair run');
  });
});

// ─── W031 — derived state.json still tracked by git (#5505 Case B) ─────────
//
// Pure predicate over `snapshot.stateJsonTracked`, which runs its own bounded
// `git ls-files` probe (`buildStateJsonTracked`), separate from W029's. Driven through the REAL buildPlanningSnapshot against
// a REAL temp git repo, like the W029 group above.

describe('W031 — derived state.json still tracked by git', () => {
  function trackStateJson(cwd, rels) {
    for (const rel of rels) {
      fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
      fs.writeFileSync(path.join(cwd, rel), '{}\n');
    }
    commitAll(cwd, 'track state.json');
  }

  test('W031 fires naming every tracked publish path, with an idempotent git rm --cached remedy', (t) => {
    const cwd = createTempGitProject('gsd-5505-w031-fire-');
    t.after(() => cleanup(cwd));
    trackStateJson(cwd, ['.planning/state.json', '.planning/workstreams/ws1/state.json']);

    const diagnostics = ruleFor('W031').check(buildPlanningSnapshot(cwd));
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, 'W031');
    assert.equal(diagnostics[0].severity, SEVERITY.WARNING);
    assert.equal(diagnostics[0].remedy.action, REMEDY_ACTION.ADVISE);
    assert.ok(diagnostics[0].remedy.args.command.startsWith('From the project directory (the one holding `.planning/`), run `git'), diagnostics[0].remedy.args.command);
    assert.ok(
      diagnostics[0].remedy.args.command.includes(
        '`git --literal-pathspecs rm --cached --ignore-unmatch -- .planning/state.json .planning/workstreams/ws1/state.json`',
      ),
      diagnostics[0].remedy.args.command,
    );
  });

  test('W031 single-quotes a path the shell would split or expand, so the advised command pastes safely', (t) => {
    const cwd = createTempGitProject('gsd-5505-w031-quote-');
    t.after(() => cleanup(cwd));
    trackStateJson(cwd, [".planning/my $proj's/state.json", ".planning/my $proj's/STATE.md"]);

    const [diagnostic] = ruleFor('W031').check(buildPlanningSnapshot(cwd));
    assert.ok(
      diagnostic.remedy.args.command.includes(`\`git --literal-pathspecs rm --cached --ignore-unmatch -- '.planning/my $proj'\\''s/state.json'\``),
      diagnostic.remedy.args.command,
    );
  });

  test('W031 escapes control characters in a tracked name: no raw newline in the message, ANSI-C quoting in the command', { skip: !isFsLegalName('\n') && 'Windows rejects a newline in a file name' }, (t) => {
    const cwd = createTempGitProject('gsd-5505-w031-ctrl-');
    t.after(() => cleanup(cwd));
    trackStateJson(cwd, ['.planning/a\nb/state.json', '.planning/a\nb/STATE.md']);

    const [diagnostic] = ruleFor('W031').check(buildPlanningSnapshot(cwd));
    assert.equal(diagnostic.code, 'W031');
    assert.equal(diagnostic.severity, SEVERITY.WARNING);
    assert.equal(diagnostic.remedy.action, REMEDY_ACTION.ADVISE);
    assert.ok(!/[\n\r]/.test(diagnostic.message), 'no raw newline reaches the message');
    assert.ok(diagnostic.remedy.args.command.includes("-- $'.planning/a\\nb/state.json'`"), diagnostic.remedy.args.command);
  });

  test('W031 is silent when state.json is untracked, or only an unrelated state.json is tracked', (t) => {
    const cwd = createTempGitProject('gsd-5505-w031-silent-');
    t.after(() => cleanup(cwd));
    trackStateJson(cwd, ['.planning/phases/01-x/state.json']);
    fs.writeFileSync(path.join(cwd, '.planning', 'state.json'), '{}\n'); // untracked publish

    assert.deepEqual(ruleFor('W031').check(buildPlanningSnapshot(cwd)), []);
  });

  test('W031 ignores a state.json in a directory that is not a project (no planning files beside it)', (t) => {
    const cwd = createTempGitProject('gsd-5505-w031-reserved-');
    t.after(() => cleanup(cwd));
    trackStateJson(cwd, ['phases', 'milestones', 'codebase', 'workstreams', 'quick', 'todos', 'debug', 'research', 'intel', 'archive', 'seeds'].map((d) => `.planning/${d}/state.json`));

    assert.deepEqual(ruleFor('W031').check(buildPlanningSnapshot(cwd)), []);
  });

  test('W031 names a project-scoped copy, with and without a workstream, once the project holds planning files', (t) => {
    const cwd = createTempGitProject('gsd-5505-w031-project-');
    t.after(() => cleanup(cwd));
    trackStateJson(cwd, ['.planning/proj/state.json', '.planning/proj/ROADMAP.md', '.planning/proj/workstreams/ws1/state.json']);

    const [diagnostic] = ruleFor('W031').check(buildPlanningSnapshot(cwd));
    assert.ok(diagnostic.message.startsWith('Tracked by git: .planning/proj/state.json, .planning/proj/workstreams/ws1/state.json'), diagnostic.message);
  });

  // Property: for any single-segment name, `.planning/<name>[/workstreams/ws1]/state.json` is a publish path
  // exactly when `<name>` holds a marker file or directory from the owner's own export (a workstream
  // directory is itself the `workstreams` marker); the matcher has no reserved-name list to drift.
  test('W031 property: publish-path matcher over the owner\'s markers', (t) => {
    const fc = require('fast-check');
    const { PLANNING_PROJECT_MARKERS } = require('../../gsd-core/bin/lib/core-utils.cjs');
    const cwd = createTempGitProject('gsd-5505-w031-prop-');
    t.after(() => cleanup(cwd));
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z][a-z0-9_-]{0,11}$/).filter((n) => n !== 'workstreams'),
        fc.subarray([...PLANNING_PROJECT_MARKERS]),
        fc.boolean(),
        (name, markers, ws) => {
          const dir = path.join(cwd, '.planning', name);
          cleanup(dir);
          const rel = ws ? `.planning/${name}/workstreams/ws1/state.json` : `.planning/${name}/state.json`;
          fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
          fs.writeFileSync(path.join(cwd, rel), '{}\n');
          for (const m of markers) {
            if (m === 'phases' || m === 'workstreams') fs.mkdirSync(path.join(dir, m), { recursive: true });
            else fs.writeFileSync(path.join(dir, m), '# s\n');
          }
          gitOrThrow(['add', '-f', '--', `.planning/${name}`], { cwd });
          const named = ruleFor('W031').check(buildPlanningSnapshot(cwd)).some((d) => d.message.includes(rel));
          gitOrThrow(['rm', '-rq', '--cached', '--', `.planning/${name}`], { cwd });
          return named === (markers.length > 0 || ws);
        },
      ),
      { numRuns: 40, seed: 5505 },
    );
  });

  // The wording holds for one path and for several, and the remedy's exclude promise is conditional:
  // with commit_docs false GSD writes no exclude entry.
  test('W031 wording agrees for one path and for several; remedy conditions the exclude promise on commit_docs', () => {
    for (const value of [['.planning/state.json'], ['.planning/state.json', '.planning/workstreams/ws1/state.json']]) {
      const [diagnostic] = ruleFor('W031').check({ stateJsonTracked: { value, scope: SCOPE.COMPLETE, reason: 'ok' } });
      assert.ok(diagnostic.message.startsWith(`Tracked by git: ${value.join(', ')}. state.json is a derived cache`), diagnostic.message);
      assert.ok(!/ (is|are) tracked by git/.test(diagnostic.message), diagnostic.message);
      assert.ok(diagnostic.remedy.args.command.includes('with commit_docs on GSD'), diagnostic.remedy.args.command);
    }
  });

  // Property: over every `.planning/<segments>/state.json` shape, git lists a path through the owner's
  // STATE_JSON_PATHSPECS exactly when the owner's matcher accepts it (every possible project directory
  // holds a marker, so only the path shape decides); the pathspecs and the matcher are one grammar.
  test('W031 property: STATE_JSON_PATHSPECS and the matcher accept the same paths (one scope list)', (t) => {
    const fc = require('fast-check');
    const { STATE_JSON_PATHSPECS, isStateJsonPublishPath } = require('../../gsd-core/bin/lib/core-utils.cjs');
    const names = ['p', 'workstreams', 'w'];
    const shapes = [[]];
    for (let depth = 1; depth <= 3; depth++) {
      for (const prefix of shapes.filter((s) => s.length === depth - 1)) for (const n of names) shapes.push([...prefix, n]);
    }
    const candidates = shapes.map((s) => ['.planning', ...s, 'state.json'].join('/'));
    const cwd = createTempGitProject('gsd-5505-w031-grammar-');
    t.after(() => cleanup(cwd));
    fc.assert(
      fc.property(fc.subarray(candidates), (chosen) => {
        cleanup(path.join(cwd, '.planning'));
        for (const rel of chosen) {
          fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
          fs.writeFileSync(path.join(cwd, rel), '{}\n');
        }
        for (const n of names) {
          fs.mkdirSync(path.join(cwd, '.planning', n), { recursive: true });
          fs.writeFileSync(path.join(cwd, '.planning', n, 'config.json'), '{}\n');
        }
        gitOrThrow(['add', '-f', '--', '.planning'], { cwd });
        const listed = gitOrThrow(['ls-files', '-z', '--', ...STATE_JSON_PATHSPECS], { cwd }).split('\0').filter(Boolean).sort();
        gitOrThrow(['rm', '-rq', '--cached', '--', '.planning'], { cwd });
        return JSON.stringify(listed) === JSON.stringify(chosen.filter((rel) => isStateJsonPublishPath(cwd, rel)).sort());
      }),
      { numRuns: 25, seed: 5505 },
    );
  });

  // Property: the quoted remedy argument is read back by bash as exactly the tracked name
  // (U+0080-U+009F as the UTF-8 bytes git tracks, C0/DEL, quotes and backslashes included).
  test('W031 property: quoted remedy round-trips through bash', (t) => {
    const fc = require('fast-check');
    const { spawnSync } = require('node:child_process');
    const bash = resolveInterpreter('bash');
    if (bash === null || spawnSync(bash, ['-c', 'true'], { timeout: GIT_TIMEOUT_MS }).status !== 0) { t.skip('bash unavailable'); return; }
    const alphabet = ['a', 'Z', '0', ' ', "'", '\\', '"', '$', '\n', '\t', '\x1b', '\x7f', '\u0080', '\u0085', '\u009f', '\x01', 'é', '-', '/'];
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...alphabet), { minLength: 1, maxLength: 8 }), (chars) => {
        const name = chars.join('');
        const [diagnostic] = ruleFor('W031').check({ stateJsonTracked: { value: [name], scope: SCOPE.COMPLETE, reason: 'ok' } });
        const quoted = /-- (.*)` once/s.exec(diagnostic.remedy.args.command)[1];
        // The script goes in on stdin: Windows re-quotes argv for a child process, which mangles a newline next to a backslash.
        const out = spawnSync(bash, ['-s'], { input: `printf %s ${quoted}`, encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
        return out.status === 0 && out.stdout === name;
      }),
      { numRuns: 100, seed: 5505 },
    );
  });

  test('W031 is silent when git could not list the tracked files (a failed listing is not a finding)', () => {
    const field = { value: ['.planning/state.json'], scope: SCOPE.UNREADABLE, reason: 'git_list_failed' };
    assert.deepEqual(ruleFor('W031').check({ stateJsonTracked: field }), []);
  });

  test('W031: no git repo, or the field absent, produces zero findings', (t) => {
    const cwd = createTempDir('gsd-5505-w031-nogit-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(path.join(cwd, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.planning', 'state.json'), '{}\n');

    assert.deepEqual(ruleFor('W031').check(buildPlanningSnapshot(cwd)), []);
    assert.deepEqual(ruleFor('W031').check({}), []);
  });

  test('W031 is non-repairable — --repair never untracks', () => {
    assert.equal(ruleFor('W031').repairable, false);
  });
});
