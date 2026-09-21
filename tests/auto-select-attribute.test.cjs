// allow-test-rule: source-text-is-the-product [#4095]
// Agent .md, workflow .md, reference .md, and docs/reference/*.md files — their text IS what
// the runtime loads. Per CONTRIBUTING.md exception matrix, asserting these files document the
// auto_select contract tests the deployed surface, not derived behavior. The behavioral test
// (cmdVerifyPlanStructure) asserts the validator's actual parse-time logic. Issue #4095.

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { lfByteCount } = require('../scripts/workflow-size.cjs');

const ROOT = path.resolve(__dirname, '..');
const PLAN_MD_DOC = path.join(ROOT, 'docs', 'reference', 'plan-md.md');
const EXECUTOR = path.join(ROOT, 'agents', 'gsd-executor.md');
const EXECUTE_PHASE_WORKFLOW = path.join(ROOT, 'gsd-core', 'workflows', 'execute-phase.md');
const CHECKPOINTS_REF = path.join(ROOT, 'gsd-core', 'references', 'checkpoints.md');

/** Agent-file hard red line (tests/agent-size-budget.test.cjs LARGE_CAP). */
const LARGE_CAP = 49152;

function read(file) {
  return fs.readFileSync(file, 'utf-8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

// ─── Schema documentation (docs/reference/plan-md.md) ────────────────────────

describe('issue #4095: plan-md.md documents auto_select', () => {
  test('plan-md.md has an Auto-select section', () => {
    const doc = read(PLAN_MD_DOC);
    assert.match(
      doc,
      /^## Auto-select$/m,
      'docs/reference/plan-md.md must have a "## Auto-select" section',
    );
  });

  test('plan-md.md states auto_select is optional', () => {
    const doc = read(PLAN_MD_DOC);
    assert.match(
      doc,
      /`auto_select`[^\n]*\*\*optional\*\*|\*\*optional\*\*[^\n]*`auto_select`/,
      'plan-md.md must describe auto_select as optional',
    );
  });

  test('plan-md.md documents that an unmatched auto_select fails at plan-parse time (not a silent fallback)', () => {
    const doc = read(PLAN_MD_DOC);
    assert.match(
      doc,
      /fails `verify plan-structure` at plan-parse time/,
      'plan-md.md must state an unmatched auto_select fails verify plan-structure at plan-parse time',
    );
    assert.match(
      doc,
      /[Nn]ever a silent fallback to the first option/,
      'plan-md.md must explicitly rule out silently falling back to the first option',
    );
  });
});

// ─── Executor bypass contract (agents/gsd-executor.md) ───────────────────────

describe('issue #4095: gsd-executor.md routes absent auto_select through checkpoint_return_format', () => {
  test('executor mentions auto_select', () => {
    const exec = read(EXECUTOR);
    assert.match(exec, /auto_select/, 'gsd-executor.md must reference auto_select');
  });

  test('checkpoint:decision auto-mode bullet routes an absent auto_select like blocking-human', () => {
    const exec = read(EXECUTOR);
    const bullet = exec.split('\n').find(
      (l) => l.includes('**checkpoint:decision**') && /[Aa]uto-select/.test(l),
    );
    assert.ok(bullet, 'gsd-executor.md must keep the checkpoint:decision auto-mode bullet');
    assert.match(
      bullet,
      /auto_select/,
      'the checkpoint:decision auto-mode bullet must mention auto_select',
    );
    assert.match(
      bullet,
      /blocking-human/,
      'the checkpoint:decision auto-mode bullet must route an absent auto_select the same way as blocking-human',
    );
  });

  test('executor is under the 49152-byte cap after adding auto_select content', () => {
    const bytes = lfByteCount(EXECUTOR);
    assert.ok(
      bytes < LARGE_CAP,
      `gsd-executor.md is ${bytes} bytes, must be < ${LARGE_CAP} (LF-normalized, measured the same way tests/agent-size-budget.test.cjs does)`,
    );
  });
});

// ─── Orchestrator contract (gsd-core/workflows/execute-phase.md) ─────────────

describe('issue #4095: execute-phase.md decision bullet and carve-out', () => {
  test('the decision bullet mentions auto_select', () => {
    const wf = read(EXECUTE_PHASE_WORKFLOW);
    const bullet = wf.split('\n').find((l) => l.trim().startsWith('- **decision** →'));
    assert.ok(bullet, 'execute-phase.md must keep the "- **decision** →" bullet');
    assert.match(bullet, /auto_select/, 'the decision bullet must mention auto_select');
  });

  test('the protected carve-out paragraph is unchanged', () => {
    const wf = read(EXECUTE_PHASE_WORKFLOW);
    assert.ok(
      wf.includes(
        '**Carve-out — overrides all branches above.** If the returned `Gate:` is `blocking-human`',
      ),
      'execute-phase.md must keep the carve-out paragraph verbatim — it is a <!-- gsd:protected --> '
      + 'section and must not be touched by the auto_select change',
    );
  });
});

// ─── checkpoints.md contract ──────────────────────────────────────────────────

describe('issue #4095: checkpoints.md golden rule 5 and checkpoint:decision example', () => {
  test('golden rule 5 no longer makes a bare unconditional "decision auto-selects first option" claim', () => {
    const ref = read(CHECKPOINTS_REF);
    assert.doesNotMatch(
      ref,
      /decision auto-selects first option/,
      'checkpoints.md must not claim decision checkpoints auto-select the first option unconditionally',
    );
  });

  test('golden rule 5 escalates to a human when auto_select is absent', () => {
    const ref = read(CHECKPOINTS_REF);
    const rule5 = ref.split('\n').find((l) => /^5\. \*\*Auto-mode bypasses/.test(l));
    assert.ok(rule5, 'checkpoints.md must keep golden rule 5');
    assert.match(rule5, /escalates to a human/, 'golden rule 5 must state that an absent auto_select escalates to a human');
    assert.match(rule5, /auto_select/, 'golden rule 5 must mention auto_select');
  });

  test('the checkpoint:decision example shows auto_select= on the opening <task> tag', () => {
    const ref = read(CHECKPOINTS_REF);
    assert.match(
      ref,
      /<task type="checkpoint:decision"[^\n>]*auto_select="[^"]+"/,
      'checkpoints.md must show an auto_select="…" attribute on a checkpoint:decision <task> tag',
    );
  });
});

// ─── Behavioral test: cmdVerifyPlanStructure additive + validating ───────────
//
// checkpoint:decision requires <decision>, <options>, <resume-signal> per the
// existing validator, and the plan frontmatter must set autonomous: false
// because the plan contains a checkpoint (src/verify.cts's
// "Has checkpoint tasks but autonomous is not false" rule).

function planWith({ autoSelect = undefined, optionIds = ['a', 'b', 'c'], includeOptions = true } = {}) {
  const attrs = ['type="checkpoint:decision"', 'gate="blocking"'];
  if (autoSelect !== undefined) {
    attrs.push(`auto_select="${autoSelect}"`);
  }
  const lines = [
    `<task ${attrs.join(' ')}>`,
    '  <name>Task 1: Pick the thing</name>',
    '  <decision>Pick the thing</decision>',
    '  <context>Later phases depend on this.</context>',
  ];
  if (includeOptions) {
    lines.push('  <options>');
    for (const id of optionIds) {
      lines.push(
        `    <option id="${id}">`,
        `      <name>Option ${id}</name>`,
        '      <pros>Pro</pros>',
        '      <cons>Con</cons>',
        '    </option>',
      );
    }
    lines.push('  </options>');
  }
  lines.push(
    '  <resume-signal>Select: ' + optionIds.join(', ') + '</resume-signal>',
    '</task>',
    '',
  );
  return [
    '---',
    'phase: 01-test',
    'plan: 01',
    'type: execute',
    'wave: 1',
    'depends_on: []',
    'files_modified: [src/x.ts]',
    'autonomous: false',
    'must_haves:',
    '  truths:',
    '    - "something is true"',
    '---',
    '',
    '<tasks>',
    '',
    ...lines,
    '</tasks>',
  ].join('\n');
}

function planWithAutoTask({ autoSelect } = {}) {
  const attrs = ['type="auto"'];
  if (autoSelect !== undefined) {
    attrs.push(`auto_select="${autoSelect}"`);
  }
  const lines = [
    `<task ${attrs.join(' ')}>`,
    '  <name>Task 1: Test</name>',
    '  <files>src/x.ts</files>',
    '  <action>Do the thing.</action>',
    '  <verify><automated>echo ok</automated></verify>',
    '  <done>Done</done>',
    '</task>',
    '',
  ];
  return [
    '---',
    'phase: 01-test',
    'plan: 01',
    'type: execute',
    'wave: 1',
    'depends_on: []',
    'files_modified: [src/x.ts]',
    'autonomous: true',
    'must_haves:',
    '  truths:',
    '    - "something is true"',
    '---',
    '',
    '<tasks>',
    '',
    ...lines,
    '</tasks>',
  ].join('\n');
}

function verifyPlan(tmpDir, content) {
  const rel = path.join('.planning', 'phases', '01-test', '01-01-PLAN.md');
  fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-test'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, rel), content);
  const result = runGsdTools(`verify plan-structure ${rel}`, tmpDir);
  assert.ok(result.success, `verify plan-structure failed to run: ${result.error}`);
  return JSON.parse(result.output);
}

describe('issue #4095: cmdVerifyPlanStructure validates auto_select', () => {
  test('auto_select absent, options present → valid, no errors (back-compat)', (t) => {
    const tmp = createTempProject();
    t.after(() => cleanup(tmp));

    const out = verifyPlan(tmp, planWith({ autoSelect: undefined }));
    assert.strictEqual(out.valid, true, `errors: ${JSON.stringify(out.errors)}`);
    assert.deepStrictEqual(out.errors, [], 'an absent auto_select must not be flagged (back-compat)');
  });

  test('auto_select="b" matches an existing <option id="b"> → valid, no auto_select errors', (t) => {
    const tmp = createTempProject();
    t.after(() => cleanup(tmp));

    const out = verifyPlan(tmp, planWith({ autoSelect: 'b', optionIds: ['a', 'b', 'c'] }));
    assert.strictEqual(out.valid, true, `errors: ${JSON.stringify(out.errors)}`);
    assert.ok(
      !out.errors.some((e) => /auto_select/i.test(e)),
      `a matching auto_select must not error; got: ${JSON.stringify(out.errors)}`,
    );
  });

  test('auto_select="nope" matches no option → invalid, error names auto_select and nope', (t) => {
    const tmp = createTempProject();
    t.after(() => cleanup(tmp));

    const out = verifyPlan(tmp, planWith({ autoSelect: 'nope', optionIds: ['a', 'b', 'c'] }));
    assert.strictEqual(out.valid, false, `errors: ${JSON.stringify(out.errors)}`);
    assert.ok(
      out.errors.some((e) => /auto_select/.test(e) && /nope/.test(e)),
      `an unmatched auto_select must produce an error naming auto_select and nope; got: ${JSON.stringify(out.errors)}`,
    );
  });

  test('auto_select="" (empty) → invalid, error mentions auto_select', (t) => {
    const tmp = createTempProject();
    t.after(() => cleanup(tmp));

    const out = verifyPlan(tmp, planWith({ autoSelect: '', optionIds: ['a', 'b', 'c'] }));
    assert.strictEqual(out.valid, false, `errors: ${JSON.stringify(out.errors)}`);
    assert.ok(
      out.errors.some((e) => /auto_select/i.test(e)),
      `an empty auto_select must produce an error mentioning auto_select; got: ${JSON.stringify(out.errors)}`,
    );
  });

  test('auto_select="a" with <options> entirely omitted → the existing missing <options> error still fires', (t) => {
    const tmp = createTempProject();
    t.after(() => cleanup(tmp));

    const out = verifyPlan(tmp, planWith({ autoSelect: 'a', includeOptions: false, optionIds: ['a'] }));
    assert.strictEqual(out.valid, false, `errors: ${JSON.stringify(out.errors)}`);
    assert.ok(
      out.errors.some((e) => /missing <options>/.test(e)),
      `omitting <options> must still produce the missing <options> error; got: ${JSON.stringify(out.errors)}`,
    );
  });

  test('a non-checkpoint:decision task carrying auto_select is ignored → valid, no error', (t) => {
    const tmp = createTempProject();
    t.after(() => cleanup(tmp));

    const out = verifyPlan(tmp, planWithAutoTask({ autoSelect: 'nope' }));
    assert.strictEqual(out.valid, true, `errors: ${JSON.stringify(out.errors)}`);
    assert.deepStrictEqual(out.errors, [], 'auto_select on a non-checkpoint:decision task must be inert');
  });
});

// ─── Parity: plan-md.md and checkpoints.md spell the attribute identically ───

describe('issue #4095: parity between plan-md.md and checkpoints.md', () => {
  test('both surfaces spell the attribute auto_select=', () => {
    const doc = read(PLAN_MD_DOC);
    const ref = read(CHECKPOINTS_REF);
    assert.ok(doc.includes('auto_select='), 'plan-md.md must spell auto_select=');
    assert.ok(ref.includes('auto_select='), 'checkpoints.md must spell auto_select=');
  });
});
