// allow-test-rule: source-text-is-the-product
// Agent .md, reference .md, and docs/reference/*.md files — their text IS what the
// runtime loads. Per CONTRIBUTING.md exception matrix, asserting these files
// document the <precondition> contract tests the deployed surface, not derived
// behavior. The behavioral test (cmdVerifyPlanStructure) asserts the validator
// stays additive. Issue #1949.

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const ROOT = path.resolve(__dirname, '..');
const PLANNER = path.join(ROOT, 'agents', 'gsd-planner.md');
const EXECUTOR = path.join(ROOT, 'agents', 'gsd-executor.md');
const PLAN_MD_DOC = path.join(ROOT, 'docs', 'reference', 'plan-md.md');
const PRECONDITIONS_REF = path.join(ROOT, 'gsd-core', 'references', 'planner-preconditions.md');

function read(rel) {
  return fs.readFileSync(rel, 'utf-8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

// ─── Schema documentation (docs/reference/plan-md.md) ────────────────────────

describe('issue #1949: plan-md.md documents <precondition>', () => {
  test('plan-md.md mentions <precondition> as an optional task element', () => {
    const doc = read(PLAN_MD_DOC);
    assert.match(
      doc,
      /<precondition>/,
      'docs/reference/plan-md.md must document the <precondition> element'
    );
  });

  test('plan-md.md states <precondition> is optional and does not break plans that omit it', () => {
    const doc = read(PLAN_MD_DOC);
    assert.ok(
      /optional/.test(doc) && /precondition/.test(doc),
      'plan-md.md must describe <precondition> as optional'
    );
  });
});

// ─── Planner emission contract (agents/gsd-planner.md) ──────────────────────

describe('issue #1949: gsd-planner.md declares <precondition> emission', () => {
  test('planner references the precondition reference file', () => {
    const planner = read(PLANNER);
    assert.ok(
      planner.includes('planner-preconditions.md'),
      'gsd-planner.md must @-reference planner-preconditions.md (progressive disclosure)'
    );
  });

  test('planner is under the 49152-char cap after adding <precondition> content', () => {
    const planner = read(PLANNER);
    assert.ok(
      planner.length < 49152,
      `gsd-planner.md is ${planner.length} chars, must be < 49152 (LF-normalized)`
    );
  });
});

// ─── Planner-preconditions reference file (progressive disclosure) ───────────

describe('issue #1949: planner-preconditions.md exists with the three emission cases', () => {
  test('reference file exists', () => {
    assert.ok(fs.existsSync(PRECONDITIONS_REF), `Missing: ${PRECONDITIONS_REF}`);
  });

  test('reference documents the user_setup emission case', () => {
    const ref = read(PRECONDITIONS_REF);
    assert.ok(
      /user_setup/.test(ref) || /external service setup/i.test(ref),
      'planner-preconditions.md must document the user_setup / external-setup emission case'
    );
  });

  test('reference documents the prior-phase artifact emission case', () => {
    const ref = read(PRECONDITIONS_REF);
    assert.ok(
      /prior.?phase artifact/i.test(ref) || /artifact from (a )?prior/i.test(ref),
      'planner-preconditions.md must document the prior-phase-artifact emission case'
    );
  });

  test('reference documents the env-var emission case', () => {
    const ref = read(PRECONDITIONS_REF);
    assert.ok(
      /env(ironment)? var/i.test(ref),
      'planner-preconditions.md must document the env-var emission case'
    );
  });

  test('reference maps the contract triad (precondition / postcondition / invariant)', () => {
    const ref = read(PRECONDITIONS_REF);
    assert.ok(
      /postcondition|<verify>|<done>/.test(ref),
      'planner-preconditions.md must map <precondition> to existing postconditions (<verify>/<done>)'
    );
  });
});

// ─── Executor assertion contract (agents/gsd-executor.md) ────────────────────

describe('issue #1949: gsd-executor.md asserts <precondition> before task execution', () => {
  test('executor mentions <precondition>', () => {
    const exec = read(EXECUTOR);
    assert.match(
      exec,
      /<precondition>/,
      'gsd-executor.md must reference <precondition>'
    );
  });

  test('executor routes an unmet precondition through checkpoint machinery (halt, no partial commit)', () => {
    const exec = read(EXECUTOR);
    assert.ok(
      /precondition/i.test(exec) && /checkpoint/.test(exec),
      'gsd-executor.md must route unmet <precondition> through checkpoint machinery'
    );
  });

  test('executor treats a met/absent precondition as a no-op (does not change flow)', () => {
    const exec = read(EXECUTOR);
    assert.ok(
      /no.op|no visible change|continue/i.test(exec),
      'gsd-executor.md must state that a met or absent precondition produces no visible change'
    );
  });

  test('executor is under the 49152-char cap after adding <precondition> content', () => {
    const exec = read(EXECUTOR);
    assert.ok(
      exec.length < 49152,
      `gsd-executor.md is ${exec.length} chars, must be < 49152 (LF-normalized)`
    );
  });
});

// ─── Behavioral test: validator stays additive (cmdVerifyPlanStructure) ──────
//
// `cmdVerifyPlanStructure` checks for PRESENCE of required tags. It must not
// reject unknown optional tags. This is the "does not break plans that omit it"
// plus "does not break plans that include it" guarantee from acceptance #1.

describe('issue #1949: cmdVerifyPlanStructure accepts <precondition> (additive)', () => {
  test('plan with <precondition> passes structural validation', () => {
    const tmp = createTempProject('precondition-present');
    try {
      const planPath = path.join(tmp, '01-PLAN.md');
      const planContent = [
        '---',
        'phase: 01-test',
        'plan: 01',
        'type: execute',
        'wave: 1',
        'depends_on: []',
        'files_modified: []',
        'autonomous: true',
        'must_haves:',
        '  truths: []',
        '---',
        '',
        '<tasks>',
        '<task type="auto">',
        '  <name>Test task</name>',
        '  <precondition>OPENAI_API_KEY is set in the environment</precondition>',
        '  <files>src/x.ts</files>',
        '  <action>Do the thing.</action>',
        '  <verify>true</verify>',
        '  <done>Done</done>',
        '</task>',
        '</tasks>',
        '',
      ].join('\n');
      fs.writeFileSync(planPath, planContent);

      const result = runGsdTools(['verify', 'plan-structure', planPath], tmp);
      assert.ok(result.success, `verify plan-structure should accept plan: ${result.stderr || ''}`);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.valid, true, `plan with <precondition> must be valid: ${JSON.stringify(parsed.errors || [])}`);
    } finally {
      cleanup(tmp);
    }
  });

  test('plan without <precondition> still passes structural validation (back-compat)', () => {
    const tmp = createTempProject('precondition-absent');
    try {
      const planPath = path.join(tmp, '02-PLAN.md');
      const planContent = [
        '---',
        'phase: 01-test',
        'plan: 02',
        'type: execute',
        'wave: 1',
        'depends_on: []',
        'files_modified: []',
        'autonomous: true',
        'must_haves:',
        '  truths: []',
        '---',
        '',
        '<tasks>',
        '<task type="auto">',
        '  <name>Test task</name>',
        '  <files>src/y.ts</files>',
        '  <action>Do another thing.</action>',
        '  <verify>true</verify>',
        '  <done>Done</done>',
        '</task>',
        '</tasks>',
        '',
      ].join('\n');
      fs.writeFileSync(planPath, planContent);

      const result = runGsdTools(['verify', 'plan-structure', planPath], tmp);
      assert.ok(result.success, `verify plan-structure should accept plan: ${result.stderr || ''}`);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.valid, true, `plan without <precondition> must be valid (back-compat): ${JSON.stringify(parsed.errors || [])}`);
    } finally {
      cleanup(tmp);
    }
  });
});

// ─── Parity: docs/reference/plan-md.md and planner-preconditions.md agree ────
//
// DEFECT.GENERATIVE-FIX-DIVERGENCE: two surfaces describing the same schema
// must agree on the canonical tag spelling. This is the parity guard against
// silent drift.

describe('issue #1949: parity between plan-md.md and planner-preconditions.md', () => {
  test('both surfaces spell the canonical tag <precondition>', () => {
    const doc = read(PLAN_MD_DOC);
    const ref = read(PRECONDITIONS_REF);
    assert.ok(doc.includes('<precondition>'), 'plan-md.md must spell <precondition>');
    assert.ok(ref.includes('<precondition>'), 'planner-preconditions.md must spell <precondition>');
  });
});
