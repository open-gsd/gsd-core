'use strict';

/**
 * C1, C2, C3, C4, C5 — #4978: the top-level `context_coverage_gate` fallback stops being honoured
 * (#5139, epic #5056, ADR-5057 Phase 6 entry, design D5). The same CLASS covers `check auto-mode`'s
 * top-level `auto_advance` / `_auto_chain_active` (C4): a top-level alias `config-get` and the loader
 * reject stops being honoured. C5: a gate reads config quietly (a malformed config.json is "key
 * absent" with nothing written to stderr, as the pre-#5139 readers behaved).
 *
 * Contract: `workflow.context_coverage_gate` is read through the Configuration Module's dot-path
 * reader (the one `config-get workflow.*` uses). The nested key wins; the top-level
 * `context_coverage_gate` is never read; an absent or unreadable config leaves the gate enabled;
 * the skip payload is unchanged. `check auto-mode` follows the same rule for
 * `workflow.auto_advance` / `workflow._auto_chain_active`: it answers exactly what
 * `config-get` answers.
 *
 * Kinds (probed by EXECUTING origin/next a2c43db270 in scratch fixtures):
 *   C1  RED   top-level-only `context_coverage_gate` is read today (gate is skipped).
 *   C2  CHAR  nested false / 'false' skip with the exact payload; absent / unreadable config
 *             and nested true / 'true' keep the gate enabled.
 *   C3  CHAR  nested wins over top-level, both orders (today `wf ?? parsed`).
 *   C4  RED   PROBE RESULT: with a top-level-only `auto_advance: true`, `config-get
 *             workflow.auto_advance` fails with "Key not found: workflow.auto_advance" (an
 *             absent key, i.e. false) while `check auto-mode` answers {active:true,
 *             source:'auto_advance', auto_advance:true} — the two disagree, so the top-level
 *             `auto_advance` and `_auto_chain_active` forms are the RED arm. The nested forms
 *             (`config-get` finds them) are CHAR.
 *
 * Everything runs through the real CLI in temp projects (no source inspection).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempGitProject, cleanup } = require('./helpers.cjs');

const PHASE_DIR = '.planning/phases/01-x';
const CONTEXT = '.planning/phases/01-x/01-CONTEXT.md';
const SKIP_REASON = 'workflow.context_coverage_gate is false';

const PLAN_SKIP = JSON.stringify({
  passed: true,
  skipped: true,
  reason: SKIP_REASON,
  total: 0,
  covered: 0,
  uncovered: [],
  message: 'Decision coverage gate disabled by config.',
});
const VERIFY_SKIP = JSON.stringify({
  skipped: true,
  blocking: false,
  reason: SKIP_REASON,
  total: 0,
  honored: 0,
  not_honored: [],
  message: 'Decision coverage gate disabled by config.',
});

/** Temp project with one uncited decision, so an ENABLED gate is observable (it reports a gap). */
function withProject(configText, fn) {
  const dir = createTempGitProject('gate-config-');
  try {
    fs.mkdirSync(path.join(dir, PHASE_DIR), { recursive: true });
    fs.writeFileSync(
      path.join(dir, CONTEXT),
      ['<decisions>', '- **D-01:** Use PostgreSQL for the primary datastore layer', '</decisions>', ''].join('\n'),
    );
    fs.writeFileSync(path.join(dir, PHASE_DIR, '01-01-PLAN.md'), '<objective>Unrelated work</objective>\n');
    if (configText !== null) fs.writeFileSync(path.join(dir, '.planning', 'config.json'), configText);
    return fn(dir);
  } finally {
    cleanup(dir);
  }
}

function checkJson(dir, args) {
  const result = runGsdTools(['check', ...args], dir);
  assert.equal(result.success, true, `check ${args.join(' ')} failed: ${result.error}`);
  return { text: JSON.stringify(JSON.parse(result.output)), value: JSON.parse(result.output) };
}

function planGate(dir) {
  return checkJson(dir, ['decision-coverage-plan', PHASE_DIR, '--context', CONTEXT]);
}
function verifyGate(dir) {
  return checkJson(dir, ['decision-coverage-verify', PHASE_DIR, CONTEXT]);
}

const UNCOVERED = [{ id: 'D-01', text: 'Use PostgreSQL for the primary datastore layer', category: '' }];

function assertPlanGateRan(gate) {
  assert.equal(gate.value.passed, false);
  assert.equal(gate.value.skipped, false);
  assert.equal(gate.value.total, 1);
  assert.equal(gate.value.covered, 0);
  assert.deepStrictEqual(gate.value.uncovered, UNCOVERED);
  assert.equal('reason' in gate.value, false);
}
function assertVerifyGateRan(gate) {
  assert.equal(gate.value.skipped, false);
  assert.equal(gate.value.blocking, false);
  assert.equal(gate.value.total, 1);
  assert.equal(gate.value.honored, 0);
  assert.deepStrictEqual(gate.value.not_honored, UNCOVERED);
  assert.equal('reason' in gate.value, false);
}

describe('C1 #4978: a top-level-only context_coverage_gate is ignored (RED)', () => {
  for (const topLevel of ['false', '"false"', 'true']) {
    test(`C1: {"context_coverage_gate": ${topLevel}} leaves decision-coverage-plan enabled`, () => {
      withProject(`{"context_coverage_gate": ${topLevel}}`, (dir) => {
        const gate = planGate(dir);
        assertPlanGateRan(gate);
        assert.equal(gate.text.includes(SKIP_REASON), false, 'the skip reason must never claim the key is set');
      });
    });

    test(`C1: {"context_coverage_gate": ${topLevel}} leaves decision-coverage-verify enabled`, () => {
      withProject(`{"context_coverage_gate": ${topLevel}}`, (dir) => {
        const gate = verifyGate(dir);
        assertVerifyGateRan(gate);
        assert.equal(gate.text.includes(SKIP_REASON), false, 'the skip reason must never claim the key is set');
      });
    });
  }

  test('C1: a top-level key beside unrelated nested workflow keys is still ignored', () => {
    withProject('{"context_coverage_gate": false, "workflow": {"auto_advance": false}}', (dir) => {
      assertPlanGateRan(planGate(dir));
      assertVerifyGateRan(verifyGate(dir));
    });
  });
});

describe('C2 nested key and default behaviour are unchanged (CHAR)', () => {
  for (const nested of ['false', '"false"']) {
    test(`C2: nested workflow.context_coverage_gate ${nested} skips with the exact payload (plan)`, () => {
      withProject(`{"workflow": {"context_coverage_gate": ${nested}}}`, (dir) => {
        assert.equal(planGate(dir).text, PLAN_SKIP);
      });
    });

    test(`C2: nested workflow.context_coverage_gate ${nested} skips with the exact payload (verify)`, () => {
      withProject(`{"workflow": {"context_coverage_gate": ${nested}}}`, (dir) => {
        assert.equal(verifyGate(dir).text, VERIFY_SKIP);
      });
    });
  }

  for (const nested of ['true', '"true"']) {
    test(`C2: nested workflow.context_coverage_gate ${nested} keeps the gate enabled`, () => {
      withProject(`{"workflow": {"context_coverage_gate": ${nested}}}`, (dir) => {
        assertPlanGateRan(planGate(dir));
        assertVerifyGateRan(verifyGate(dir));
      });
    });
  }

  test('C2: an absent config.json leaves the gate enabled', () => {
    withProject(null, (dir) => {
      assert.equal(fs.existsSync(path.join(dir, '.planning', 'config.json')), false);
      assertPlanGateRan(planGate(dir));
      assertVerifyGateRan(verifyGate(dir));
    });
  });

  test('C2: an unreadable (non-JSON) config.json leaves the gate enabled', () => {
    withProject('{ not json', (dir) => {
      assertPlanGateRan(planGate(dir));
      assertVerifyGateRan(verifyGate(dir));
    });
  });

  test('C2: an empty workflow section leaves the gate enabled', () => {
    withProject('{"workflow": {}}', (dir) => {
      assertPlanGateRan(planGate(dir));
      assertVerifyGateRan(verifyGate(dir));
    });
  });
});

describe('C3 the nested key wins over the top-level key, in both orders (CHAR)', () => {
  test('C3: nested true + top-level false -> enabled', () => {
    withProject('{"workflow": {"context_coverage_gate": true}, "context_coverage_gate": false}', (dir) => {
      assertPlanGateRan(planGate(dir));
      assertVerifyGateRan(verifyGate(dir));
    });
  });

  test('C3: top-level false written before nested true -> enabled', () => {
    withProject('{"context_coverage_gate": false, "workflow": {"context_coverage_gate": true}}', (dir) => {
      assertPlanGateRan(planGate(dir));
      assertVerifyGateRan(verifyGate(dir));
    });
  });

  test('C3: nested false + top-level true -> skipped with the exact payload', () => {
    withProject('{"workflow": {"context_coverage_gate": false}, "context_coverage_gate": true}', (dir) => {
      assert.equal(planGate(dir).text, PLAN_SKIP);
      assert.equal(verifyGate(dir).text, VERIFY_SKIP);
    });
  });

  test("C3: nested 'false' + top-level true -> skipped with the exact payload", () => {
    withProject('{"context_coverage_gate": true, "workflow": {"context_coverage_gate": "false"}}', (dir) => {
      assert.equal(planGate(dir).text, PLAN_SKIP);
      assert.equal(verifyGate(dir).text, VERIFY_SKIP);
    });
  });
});

describe('C4 check auto-mode answers exactly what config-get answers', () => {
  const NONE = { active: false, source: 'none', auto_chain_active: false, auto_advance: false };

  function autoMode(dir) {
    return checkJson(dir, ['auto-mode']).value;
  }

  /** What `config-get <key>` says, as a boolean: an absent key is false. */
  function configGetBoolean(dir, key) {
    const result = runGsdTools(['config-get', key], dir);
    if (!result.success) {
      assert.ok(result.error.includes(`Key not found: ${key}`), `config-get error names the key: ${result.error}`);
      return false;
    }
    return result.output === 'true';
  }

  test('C4 (RED): a top-level-only auto_advance is not read; auto-mode agrees with config-get', () => {
    withProject('{"auto_advance": true}', (dir) => {
      assert.equal(configGetBoolean(dir, 'workflow.auto_advance'), false);
      assert.deepStrictEqual(autoMode(dir), NONE);
    });
  });

  test('C4 (RED): a top-level-only _auto_chain_active is not read; auto-mode agrees with config-get', () => {
    withProject('{"_auto_chain_active": true}', (dir) => {
      assert.equal(configGetBoolean(dir, 'workflow._auto_chain_active'), false);
      assert.deepStrictEqual(autoMode(dir), NONE);
    });
  });

  test('C4 (RED): BOTH top-level flags together are not read; auto-mode answers none, as config-get does (same class as #4978)', () => {
    withProject('{"auto_advance": true, "_auto_chain_active": true}', (dir) => {
      assert.equal(configGetBoolean(dir, 'workflow.auto_advance'), false);
      assert.equal(configGetBoolean(dir, 'workflow._auto_chain_active'), false);
      assert.deepStrictEqual(autoMode(dir), NONE);
    });
  });

  test('C4: nested workflow.auto_advance is read', () => {
    withProject('{"workflow": {"auto_advance": true}}', (dir) => {
      assert.equal(configGetBoolean(dir, 'workflow.auto_advance'), true);
      assert.deepStrictEqual(autoMode(dir), { active: true, source: 'auto_advance', auto_chain_active: false, auto_advance: true });
    });
  });

  test('C4: nested workflow._auto_chain_active is read', () => {
    withProject('{"workflow": {"_auto_chain_active": true}}', (dir) => {
      assert.equal(configGetBoolean(dir, 'workflow._auto_chain_active'), true);
      assert.deepStrictEqual(autoMode(dir), { active: true, source: 'auto_chain', auto_chain_active: true, auto_advance: false });
    });
  });

  test('C4: both nested flags -> source both', () => {
    withProject('{"workflow": {"auto_advance": true, "_auto_chain_active": true}}', (dir) => {
      assert.deepStrictEqual(autoMode(dir), { active: true, source: 'both', auto_chain_active: true, auto_advance: true });
    });
  });

  test('C4: nested wins over top-level in both orders', () => {
    withProject('{"auto_advance": false, "workflow": {"auto_advance": true}}', (dir) => {
      assert.equal(configGetBoolean(dir, 'workflow.auto_advance'), true);
      assert.deepStrictEqual(autoMode(dir), { active: true, source: 'auto_advance', auto_chain_active: false, auto_advance: true });
    });
    withProject('{"auto_advance": true, "workflow": {"auto_advance": false}}', (dir) => {
      assert.equal(configGetBoolean(dir, 'workflow.auto_advance'), false);
      assert.deepStrictEqual(autoMode(dir), NONE);
    });
  });

  test('C4: absent and unreadable config answer none', () => {
    withProject(null, (dir) => {
      assert.deepStrictEqual(autoMode(dir), NONE);
    });
    withProject('{ not json', (dir) => {
      assert.deepStrictEqual(autoMode(dir), NONE);
    });
  });
});

describe('C5 a gate reads its config quietly: a malformed config.json is "key absent", nothing on stderr', () => {
  const { evaluateDecisionCoveragePlan } = require('../gsd-core/bin/lib/gate-decision-coverage-plan.cjs');
  const { evaluateDecisionCoverageVerify } = require('../gsd-core/bin/lib/gate-decision-coverage-verify.cjs');
  const { readAutoModeState } = require('../gsd-core/bin/lib/check-auto-mode.cjs');
  const { readWorkflowConfigValue } = require('../gsd-core/bin/lib/gate-config.cjs');
  const { resolveConfigKey } = require('../gsd-core/bin/lib/capability-activation.cjs');

  /** Run `fn` with process.stderr.write / stdout.write spied; returns { result, writes }. */
  function spied(fn) {
    const writes = [];
    const errWrite = process.stderr.write;
    const outWrite = process.stdout.write;
    process.stderr.write = (chunk) => { writes.push({ stream: 'stderr', chunk: String(chunk) }); return true; };
    process.stdout.write = (chunk) => { writes.push({ stream: 'stdout', chunk: String(chunk) }); return true; };
    try {
      return { result: fn(), writes };
    } finally {
      process.stderr.write = errWrite;
      process.stdout.write = outWrite;
    }
  }

  const MALFORMED = ['{ not json', '', '{"workflow": ', '[1, 2', 'null'];

  for (const text of MALFORMED) {
    test(`C5: config.json ${JSON.stringify(text)} -> both gates enabled, auto-mode none, no write to stdout/stderr`, () => {
      withProject(text, (dir) => {
        const plan = spied(() => evaluateDecisionCoveragePlan({ projectDir: dir, args: [PHASE_DIR, '--context', CONTEXT] }));
        assert.deepStrictEqual(plan.writes, []);
        assert.equal(plan.result.outcome, 'block', 'an enabled plan gate reports the uncovered decision');
        assert.equal(plan.result.payload.skipped, false);

        const verify = spied(() => evaluateDecisionCoverageVerify({ projectDir: dir, args: [PHASE_DIR, CONTEXT] }));
        assert.deepStrictEqual(verify.writes, []);
        assert.equal(verify.result.payload.skipped, false);

        const auto = spied(() => readAutoModeState(dir));
        assert.deepStrictEqual(auto.writes, []);
        assert.deepStrictEqual(auto.result, { active: false, source: 'none', auto_chain_active: false, auto_advance: false });

        const raw = spied(() => readWorkflowConfigValue(dir, 'workflow.context_coverage_gate'));
        assert.deepStrictEqual(raw.writes, []);
        assert.deepStrictEqual(raw.result, { found: false, value: undefined });
      });
    });
  }

  test('C5 control: the default (non-quiet) resolver DOES warn once about the same malformed file, so the spy is live', () => {
    withProject('{ not json', (dir) => {
      const loud = spied(() => resolveConfigKey('workflow.context_coverage_gate', { config: {}, cwd: dir, registry: {} }));
      assert.deepStrictEqual(loud.result, { found: false, value: undefined });
      assert.equal(loud.writes.length, 1);
      assert.equal(loud.writes[0].stream, 'stderr');
      assert.match(loud.writes[0].chunk, /config\.json exists but could not be read or parsed/);
      const quiet = spied(() => resolveConfigKey('workflow.context_coverage_gate', { config: {}, cwd: dir, registry: {}, quiet: true }));
      assert.deepStrictEqual(quiet.writes, []);
    });
  });
});
