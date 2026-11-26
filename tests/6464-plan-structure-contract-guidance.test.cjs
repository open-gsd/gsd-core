'use strict';

/**
 * 6464-plan-structure-contract-guidance.test.cjs — pin that the planner-read
 * guidance states exactly what verify.plan-structure enforces (#6464).
 *
 * Rule universe from product exports' BEHAVIOR, not source-grep: the exit
 * grammar probe (parseCriteriaAllowMarkers) == scanner emission (corpus
 * through scanQuantitativeCriteria) == ids named in planner-guidance.md,
 * plus executor_runtime/agent_hint refusals and de-scoping the stale
 * "Plan-structure validation" section in planner-preconditions.md.
 * A scanner rule added without a corpus trap or a guidance line fails.
 *
 * guidance/preconditions are the shipped product documents: markdown is the product.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(REPO_ROOT, ...parts), 'utf8');

const GUIDANCE = read('gsd-core', 'references', 'planner-guidance.md');
const PRECONDITIONS = read('gsd-core', 'references', 'planner-preconditions.md');

const { scanQuantitativeCriteria } = require('../gsd-core/bin/lib/verify.cjs');
const { parseCriteriaAllowMarkers } = require('../gsd-core/bin/lib/criterion-baseline.cjs');

// ─── rule universe: what the legitimate exit knows ───────────────────────────

// Probe the shipped marker grammar with candidate ids; the accepted R-set is the
// rule universe the exit covers. Adding a rule without extending the exit (or
// extending the exit without the rule) moves this set and trips parity below.
function grammarRuleIds() {
  const accepted = new Set();
  for (const id of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11', 'R12', 'B1', 'B2', 'B3', 'B4', 'B5', 'X1']) {
    const markers = parseCriteriaAllowMarkers(`<!-- plan-criteria-allow: ${id} - probe reason -->`);
    if (markers.has(id)) accepted.add(id);
  }
  return accepted;
}

test('the exit grammar knows exactly the R rules, needs a reason, and rejects unknown ids', () => {
  const accepted = grammarRuleIds();
  assert.ok(accepted.has('R1') && accepted.has('R6'), `R1-R6 must be exitable, got ${[...accepted]}`);
  for (const bogus of ['R7', 'R8', 'R9', 'B3', 'X1']) {
    assert.ok(!accepted.has(bogus), `${bogus} must not be accepted by the grammar, got ${[...accepted]}`);
  }
  // The reason must be non-empty: `R1 - -->` is not an auditable exit.
  assert.deepStrictEqual(
    [...parseCriteriaAllowMarkers('<!-- plan-criteria-allow: R1 - -->')],
    [],
    'an empty reason must not exit the rule',
  );
});

// ─── corpus: what the scanner actually emits ─────────────────────────────────

// Plan harness copied from the #4024 block in tests/verify.test.cjs.
const PLAN_HEAD = [
  '---',
  'phase: 01-test', 'plan: 01', 'type: execute', 'wave: 1', 'depends_on: []',
  'files_modified: [some/file.ts]', 'autonomous: true',
  'must_haves:', '  truths:', '    - "something is true"',
  '---', '',
];
function plan(criteriaBody, taskVerify) {
  return PLAN_HEAD.concat([
    '<acceptance_criteria>', criteriaBody, '</acceptance_criteria>', '',
    '<task type="auto">',
    '  <name>Task 1: Do something</name>',
    '  <files>some/file.ts</files>',
    '  <action>Do the thing</action>',
    `  <verify><automated>${taskVerify || 'echo ok'}</automated></verify>`,
    '  <done>Thing is done</done>',
    '</task>',
  ]).join('\n');
}

// One trap shape per rule (shapes mirrored from the #4024 unit rows / scanner source).
const TRAPS = {
  R1: [plan("  - `grep -c 'unassignedTabs' store.ts` returns exactly 2.", ''), 'errors'],
  R2: [plan('  - All seven tests were observed FAILING before the implementation existed.', ''), 'errors'],
  R3: [plan('  - `$NOKEY npx tsx x.ts` exits 0.', ''), 'errors'],
  R4: [plan('  - see below.', 'git log --oneline | head -5'), 'warnings'],
  R5: [plan('  - `wc -l notes.md | grep -x 0` passes.', ''), 'errors'],
  R6: [plan('  - `git diff HEAD~1 --stat` shows the change.', ''), 'errors'],
};

function emittedRuleIds() {
  const emitted = new Set();
  for (const [content, bucket] of Object.values(TRAPS)) {
    const result = scanQuantitativeCriteria(content);
    for (const message of result[bucket]) {
      const m = /\[plan-criteria (R\d+)\]/.exec(message);
      if (m) emitted.add(m[1]);
    }
  }
  return emitted;
}

describe('#6464 scanner emission equals the exit grammar', () => {
  for (const [rule, [content, bucket]] of Object.entries(TRAPS)) {
    test(`the ${rule} trap shape emits [plan-criteria ${rule}] and nothing else`, () => {
      const result = scanQuantitativeCriteria(content);
      const ids = new Set();
      for (const message of result.errors.concat(result.warnings)) {
        const m = /\[plan-criteria (R\d+)\]/.exec(message);
        if (m) ids.add(m[1]);
      }
      assert.ok(result[bucket].some((msg) => msg.includes(`[plan-criteria ${rule}]`)),
        `${rule} must fire in ${bucket}: ${JSON.stringify(result)}`);
      assert.deepStrictEqual([...ids], [rule], `only ${rule} may fire on its own trap: ${JSON.stringify(result)}`);
    });
  }

  test('emitted rule ids are exitable (emitted ⊆ grammar)', () => {
    const grammar = grammarRuleIds();
    for (const id of emittedRuleIds()) {
      assert.ok(grammar.has(id), `scanner emits ${id} but the plan-criteria-allow grammar cannot exit it`);
    }
  });

  test('every exitable R rule fires on a corpus trap (grammar ⊆ emitted)', () => {
    const emitted = emittedRuleIds();
    const missing = [...grammarRuleIds()].filter((id) => id.startsWith('R') && !emitted.has(id));
    assert.deepStrictEqual(missing, [],
      'rules the exit knows but no corpus trap emits — add a trap shape (and a guidance line) for each');
  });
});

// ─── the planner-read guidance names the contract ────────────────────────────

describe('#6464 planner-guidance.md names every rule the validator can emit', () => {
  test('every exitable R rule has a contract line in the guidance', () => {
    const named = new Set();
    for (const m of GUIDANCE.matchAll(/\*\*(R\d+)\*\*/g)) named.add(m[1]);
    const missing = [...grammarRuleIds()].filter((id) => id.startsWith('R') && !named.has(id));
    assert.deepStrictEqual(missing, [],
      `planner-guidance.md must carry a **R<n>** contract line for each rule; missing: ${missing.join(', ')}`);
  });

  for (const [rule, trapWord] of [
    ['R1', 'grep -c'],
    ['R2', 'observed'],
    ['R3', 'command position'],
    ['R4', 'pipeline'],
    ['R5', 'wc'],
    ['R6', 'HEAD~'],
  ]) {
    test(`the ${rule} contract line states its trap (${trapWord})`, () => {
      const line = GUIDANCE.split('\n').find((l) => l.includes(`**${rule}**`));
      assert.ok(line, `no **${rule}** line in planner-guidance.md`);
      assert.ok(line.toLowerCase().includes(trapWord.toLowerCase()),
        `the ${rule} line must name the trap "${trapWord}": ${line}`);
    });
  }

  test('the guidance states the plan-criteria-allow exit with its required reason', () => {
    assert.ok(GUIDANCE.includes('plan-criteria-allow:'),
      'guidance must give the literal exit marker grammar');
    assert.match(GUIDANCE, /plan-criteria-allow:[^\n]*reason/i,
      'the exit line must state the non-empty reason requirement');
  });

  test('the guidance states the executor_runtime / agent_hint refusals', () => {
    assert.ok(GUIDANCE.includes('executor_runtime') && GUIDANCE.includes('agent_hint'),
      'guidance must name both frontmatter fields (#6302 refusals)');
    assert.match(GUIDANCE, /executor_runtime[^\n]*runtime id/i,
      'the bare-runtime-id rule must be stated');
    assert.match(GUIDANCE, /executor_runtime[^\n]*checkpoint/i,
      'the no-checkpoints / autonomous:false rule must be stated');
    assert.match(GUIDANCE, /both be set/i,
      'the executor_runtime+agent_hint mutual exclusion must be stated');
  });
});

// ─── the stale preconditions section no longer reads as complete ─────────────

test('planner-preconditions.md plan-structure section points at the contract (#6464)', () => {
  const start = PRECONDITIONS.indexOf('## Plan-structure validation');
  assert.ok(start !== -1, 'the section must still exist');
  const rest = PRECONDITIONS.slice(start + 3);
  const nextHeading = rest.search(/\n## /);
  const section = nextHeading === -1 ? PRECONDITIONS.slice(start) : PRECONDITIONS.slice(start, start + 3 + nextHeading);
  assert.ok(section.includes('planner-guidance.md'),
    'the section must point at the planner-guidance contract instead of reading as the whole validator');
  assert.ok(!section.includes('v1 ships prose-only'),
    'the stale "v1 ships prose-only / future ADR may add structured validation" completeness claim must be gone');
});
