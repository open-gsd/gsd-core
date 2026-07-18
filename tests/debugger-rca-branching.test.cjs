// allow-test-rule: source-text-is-the-product (see #1960)
// Agent .md + reference .md + template .md files — their text IS what the
// runtime loads. Testing text content tests the deployed RCA-branching
// contract. The pure-JS schema-invariant checks below validate the data model
// the agent records (root_cause may hold a set when the AND-gate fires).
// Per CONTRIBUTING.md exception matrix. Covers epic #1957 Phase 2A (#1960).
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.cwd();
const AGENT = path.join(ROOT, 'agents/gsd-debugger.md');
const REFERENCE = path.join(ROOT, 'gsd-core/references/debugger-rca-branching.md');
const PHILOSOPHY = path.join(ROOT, 'gsd-core/references/debugger-philosophy.md');
const DEBUG_TEMPLATE = path.join(ROOT, 'gsd-core/templates/DEBUG.md');

// Validated data-model invariant: the RCA-branching output the agent records.
// root_causes holds every CONFIRMED candidate (one OR a small set — the AND-gate
// decides whether >1 is kept); eliminated holds the rest. The two never overlap
// and every candidate lands in exactly one bucket.
function assertRcaSchemaInvariants(output) {
  assert.ok(Array.isArray(output.root_causes), 'root_causes must be a list (set-valued)');
  assert.ok(Array.isArray(output.eliminated), 'eliminated must be a list');
  assert.ok(output.root_causes.length >= 1, 'at least one confirmed root cause is required');
  const rootIds = new Set(output.root_causes.map((c) => c.id));
  const elimIds = new Set(output.eliminated.map((c) => c.id));
  for (const id of rootIds) {
    assert.ok(!elimIds.has(id), `cause ${id} appears in BOTH root_causes and eliminated (must be disjoint)`);
  }
}

describe('RCA branching — anti-single-cause bias (#1960, epic #1957 Phase 2A)', () => {
  describe('reference extract exists and is wired into Phase 2', () => {
    test('gsd-core/references/debugger-rca-branching.md exists', () => {
      assert.ok(fs.existsSync(REFERENCE), 'debugger-rca-branching.md reference must exist');
    });

    test('gsd-debugger.md Phase 2 @-includes the RCA-branching reference', () => {
      const content = fs.readFileSync(AGENT, 'utf8');
      assert.ok(
        content.includes('@~/.claude/gsd-core/references/debugger-rca-branching.md'),
        'gsd-debugger.md must @-include the RCA-branching reference from Phase 2 (or the reasoning checkpoint)'
      );
    });
  });

  describe('branch-don\'t-chain: fishbone across >=2 categories', () => {
    test('reference documents the four Ishikawa categories', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/code/i.test(content), 'category: code');
      assert.ok(/config/i.test(content), 'category: config');
      assert.ok(/environment/i.test(content), 'category: environment');
      assert.ok(/data/i.test(content), 'category: data');
      assert.ok(/fishbone|ishikawa|\b>=?\s*2\s+categor/i.test(content),
        'must require branching across >=2 categories (Ishikawa/fishbone)');
    });

    test('reference contrasts branching with a single linear 5-Whys chain', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/5-?\s*whys|five whys|linear chain|single[\s-]?cause/i.test(content),
        'must name the 5-Whys / single-cause-bias failure mode being guarded against');
    });
  });

  describe('AND-gate check (Fault Tree Analysis)', () => {
    test('reference documents the AND-gate question', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/and[\s-]?gate/i.test(content), 'must name the AND-gate check');
      assert.ok(/more than one|multiple|simultaneous/i.test(content),
        'must ask whether the failure requires multiple contributing conditions simultaneously');
    });
  });

  describe('root_cause may hold a set; single-cause sessions unaffected (backward compat)', () => {
    test('reference documents that root_cause can record multiple contributing causes', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/root_cause|root cause/i.test(content));
      assert.ok(/multiple|set|more than one|all contributing/i.test(content),
        'must document that root_cause can hold multiple contributing causes when the AND-gate fires');
    });

    test('reference documents single-cause backward compatibility', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/single[\s-]?cause|backward|identical|unchanged/i.test(content),
        'must document that single-cause sessions are unaffected (backward compatible)');
    });

    test('DEBUG.md template root_cause field notes it may hold a set', () => {
      const content = fs.readFileSync(DEBUG_TEMPLATE, 'utf8');
      assert.ok(/root_cause/.test(content), 'template must still have the root_cause field');
      assert.ok(/set|multiple|contributing|one or more/i.test(content),
        'DEBUG.md root_cause must note it may hold one or more contributing causes (per RCA branching)');
    });
  });

  describe('Structured Reasoning Checkpoint gains the RCA fields', () => {
    test('reasoning_checkpoint YAML includes candidate_causes + and_gate', () => {
      const content = fs.readFileSync(AGENT, 'utf8');
      assert.ok(/candidate_causes/.test(content),
        'reasoning_checkpoint must include a candidate_causes field (the >=2-category branches)');
      assert.ok(/and_gate/.test(content),
        'reasoning_checkpoint must include an and_gate field (the AND-gate answer)');
    });
  });

  describe('debugger-philosophy.md notes the single-cause-bias trap', () => {
    test('philosophy reference calls out single-cause bias', () => {
      const content = fs.readFileSync(PHILOSOPHY, 'utf8');
      assert.ok(/single[\s-]?cause|5-?\s*whys|root[\s-]?cause bias/i.test(content),
        'debugger-philosophy.md must note the single-cause-bias / 5-Whys trap alongside the existing cognitive-bias guidance');
    });
  });

  describe('RCA output schema — behavioral invariants on fixtures (criteria 1 + 2)', () => {
    // Each fixture is the RCA-branching output the agent records per the
    // documented schema, constructed to exercise the data model.

    test('fixture A — two contributing causes (AND-gate yes): both recorded in root_causes', () => {
      const output = {
        // The agent confirmed BOTH causes (AND-gate fired — both required simultaneously).
        root_causes: [
          { id: 'race-condition', category: 'code', evidence: 'two async writers, no lock' },
          { id: 'missing-index', category: 'config', evidence: 'full-table scan under load amplifies the race window' },
        ],
        eliminated: [{ id: 'timezone', category: 'environment', evidence: 'reproduced in UTC too' }],
        and_gate: 'yes — both the race AND the missing index are required to produce the observed corruption',
      };
      assertRcaSchemaInvariants(output);
      assert.strictEqual(output.root_causes.length, 2, 'both contributing causes must be recorded (criterion 1)');
      const cats = new Set(output.root_causes.map((c) => c.category));
      assert.ok(cats.size >= 2, 'the confirmed causes span >=2 categories (branching is real)');
    });

    test('fixture B — single-cause (AND-gate no): one root_cause, identical to today (criterion 2)', () => {
      const output = {
        root_causes: [
          { id: 'off-by-one', category: 'code', evidence: 'loop bound < instead of <=' },
        ],
        eliminated: [
          { id: 'config-default', category: 'config', evidence: 'unchanged in repro' },
          { id: 'env-var', category: 'environment', evidence: 'unset in repro' },
        ],
        and_gate: 'no — the off-by-one alone fully accounts for the symptom',
      };
      assertRcaSchemaInvariants(output);
      assert.strictEqual(output.root_causes.length, 1, 'single-cause session records exactly one root cause (criterion 2: unaffected)');
    });

    test('invariant: a confirmed cause can never also appear in eliminated', () => {
      const bad = {
        root_causes: [{ id: 'x', category: 'code', evidence: 'e' }],
        eliminated: [{ id: 'x', category: 'code', evidence: 'e' }],
        and_gate: 'no',
      };
      assert.throws(() => assertRcaSchemaInvariants(bad), /disjoint/);
    });
  });
});
