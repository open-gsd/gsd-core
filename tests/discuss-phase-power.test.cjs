// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * GSD Tools Tests - discuss-phase power user mode
 *
 * Validates that the --power flag workflow documentation is present and
 * correctly describes the bulk question generation/answering flow.
 *
 * Closes: #1513
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('discuss-phase power user mode (#1513)', () => {
  const commandPath = path.join(__dirname, '..', 'commands', 'gsd', 'discuss-phase.md');
  const workflowPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'discuss-phase.md');
  const powerWorkflowPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'discuss-phase-power.md');

  describe('command file (discuss-phase.md)', () => {
    test('mentions --power flag in argument-hint or description', () => {
      const content = fs.readFileSync(commandPath, 'utf8');
      assert.ok(
        content.includes('--power'),
        'commands/gsd/discuss-phase.md should document the --power flag'
      );
    });

    test('references the power workflow file', () => {
      const content = fs.readFileSync(commandPath, 'utf8');
      assert.ok(
        content.includes('discuss-phase-power'),
        'command file should reference discuss-phase-power workflow'
      );
    });
  });

  describe('main workflow file (discuss-phase.md)', () => {
    test('has power_user_mode section or references discuss-phase-power.md', () => {
      // After the discuss-phase/modes split (#717), the power dispatch lives in discuss-phase/modes/power.md and
      // the parent references it via the dispatch table.
      const parentContent = fs.readFileSync(workflowPath, 'utf8');
      const powerModePath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'discuss-phase', 'modes', 'power.md');
      const powerMode = fs.existsSync(powerModePath) ? fs.readFileSync(powerModePath, 'utf8') : '';
      const content = parentContent + '\n' + powerMode;
      const hasPowerSection = content.includes('power_user_mode') || content.includes('power user mode') || content.includes('modes/power.md');
      const hasReference = content.includes('discuss-phase-power');
      assert.ok(
        hasPowerSection || hasReference,
        'discuss-phase.md (or modes/power.md after the discuss-phase/modes split) should have power_user_mode section or reference discuss-phase-power.md'
      );
    });

    test('describes --power flag routing', () => {
      const content = fs.readFileSync(workflowPath, 'utf8');
      assert.ok(
        content.includes('--power'),
        'discuss-phase.md should describe --power flag handling'
      );
    });
  });

  describe('power workflow file (discuss-phase-power.md)', () => {
    test('file exists', () => {
      assert.ok(
        fs.existsSync(powerWorkflowPath),
        'gsd-core/workflows/discuss-phase-power.md should exist'
      );
    });

    test('describes the generate step', () => {
      const content = fs.readFileSync(powerWorkflowPath, 'utf8');
      assert.ok(
        content.includes('generate') || content.includes('Generate'),
        'power workflow should describe generating questions'
      );
    });

    test('describes the wait/notify step', () => {
      const content = fs.readFileSync(powerWorkflowPath, 'utf8');
      const hasWait = content.includes('wait') || content.includes('Wait');
      const hasNotify = content.includes('notify') || content.includes('Notify') || content.includes('notif');
      assert.ok(
        hasWait || hasNotify,
        'power workflow should describe the wait/notify step after generating files'
      );
    });

    test('describes the refresh step', () => {
      const content = fs.readFileSync(powerWorkflowPath, 'utf8');
      assert.ok(
        content.includes('refresh') || content.includes('Refresh'),
        'power workflow should describe the refresh step for processing answers'
      );
    });

    test('describes the finalize step', () => {
      const content = fs.readFileSync(powerWorkflowPath, 'utf8');
      assert.ok(
        content.includes('finalize') || content.includes('Finalize'),
        'power workflow should describe the finalize step for generating CONTEXT.md'
      );
    });

    test('QUESTIONS.json structure has required fields', () => {
      const content = fs.readFileSync(powerWorkflowPath, 'utf8');
      assert.ok(content.includes('QUESTIONS.json'), 'should mention QUESTIONS.json file');
      assert.ok(content.includes('"phase"'), 'JSON structure should include phase field');
      assert.ok(content.includes('"stats"'), 'JSON structure should include stats field');
      assert.ok(content.includes('"sections"'), 'JSON structure should include sections field');
      assert.ok(
        content.includes('"id"') && content.includes('"title"'),
        'JSON structure should include question id and title fields'
      );
      assert.ok(
        content.includes('"options"'),
        'JSON structure should include options array'
      );
      assert.ok(
        content.includes('"answer"'),
        'JSON structure should include answer field'
      );
      assert.ok(
        content.includes('"status"'),
        'JSON structure should include status field'
      );
    });

    test('describes HTML generation step', () => {
      const content = fs.readFileSync(powerWorkflowPath, 'utf8');
      assert.ok(
        content.includes('QUESTIONS.html') || content.includes('.html'),
        'power workflow should describe generating the HTML companion file'
      );
      assert.ok(
        content.includes('HTML') || content.includes('html'),
        'power workflow should mention HTML output'
      );
    });

    test('QUESTIONS.json file naming uses padded phase number', () => {
      const content = fs.readFileSync(powerWorkflowPath, 'utf8');
      assert.ok(
        content.includes('padded_phase') || content.includes('{padded_phase}') || content.includes('QUESTIONS.json'),
        'power workflow should describe file naming with padded phase number'
      );
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/issue-2771-advisor-subagent-type.test.cjs — H3 Wave 6 (#3338)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe('folded:issue-2771-advisor-subagent-type', () => {
// allow-test-rule: structural-implementation-guard (#2771)
'use strict';

// Regression guard for #2771: the discuss-phase advisor mode must spawn the REGISTERED
// `gsd-advisor-researcher` subagent (auto-loads the agent def), not `general-purpose` —
// which contradicts universal-anti-patterns rule 10 (injected into discuss-phase via
// <required_reading>): "NEVER use non-GSD agent types — ALWAYS use gsd-{agent}".
// Spawning general-purpose + a manual "read the agent def" prompt re-specifies what the
// def already owns (a drift risk; the same shape assumptions's answer_validation hit).

const ADVISOR_MD = path.join(
  __dirname, '..', 'gsd-core', 'workflows', 'discuss-phase', 'modes', 'advisor.md'
);

test('advisor mode spawns the registered gsd-advisor-researcher subagent, not general-purpose (#2771)', () => {
  const src = fs.readFileSync(ADVISOR_MD, 'utf8');

  // Locate the Agent() block that researches gray areas.
  const agentIdx = src.indexOf('subagent_type=');
  assert.ok(agentIdx !== -1, 'advisor.md must contain an Agent() subagent_type declaration');

  assert.ok(
    src.includes('subagent_type="gsd-advisor-researcher"'),
    'advisor mode must spawn subagent_type="gsd-advisor-researcher" (the registered agent def auto-loads) — not general-purpose (#2771, universal-anti-patterns rule 10)'
  );
  assert.ok(
    !src.includes('subagent_type="general-purpose"'),
    'advisor mode must NOT spawn subagent_type="general-purpose" (contradicts universal-anti-patterns rule 10, injected into the same context) (#2771)'
  );
  // The manual "read @.../gsd-advisor-researcher.md" prompt line must be gone —
  // spawning by type auto-loads the def; re-specifying it is a drift risk. Deny the
  // full class (any "read @" lead-in, case-insensitive) so a phrasing variant can't
  // sneak the drift back in.
  assert.ok(
    !/read\s+@.*gsd-advisor-researcher\.md/i.test(src),
    'advisor mode must not manually instruct reading the agent def — spawning by type auto-loads it (#2771)'
  );
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/issue-2772-discuss-phase-text-inconsistencies.test.cjs — H3 Wave 6 (#3338)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe('folded:issue-2772-discuss-phase-text-inconsistencies', () => {
// allow-test-rule: structural-implementation-guard (#2772)
'use strict';

// Regression guard for #2772: four self-contained text inconsistencies in the
// discuss-phase surface, each a literal-instruction hazard. The shipped markdown IS
// the runtime contract, so structural inspection is the correct guard.

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('auto.md does not read the dead MAX_PASSES / max_discuss_passes config (#2772.1)', () => {
  const src = read('gsd-core/workflows/discuss-phase/modes/auto.md');
  assert.ok(/single pass/i.test(src), 'auto.md must still mandate the single-pass rule');
  assert.ok(!/MAX_PASSES=/.test(src), 'auto.md must not read MAX_PASSES (dead config — single-pass rule governs) (#2772)');
  assert.ok(!/max_discuss_passes/.test(src), 'auto.md must not reference max_discuss_passes (contradicts the single-pass rule) (#2772)');
});

test('gate-prompts context-handling matches the actual check_existing options (#2772.2)', () => {
  const src = read('gsd-core/references/gate-prompts.md');
  const ctx = src.slice(src.indexOf('## Pattern: context-handling'), src.indexOf('## Pattern: gray-area-option'));
  assert.ok(/Update it \| View it \| Skip/.test(ctx), 'context-handling options must be "Update it | View it | Skip" (the actual check_existing flow) (#2772)');
  assert.ok(!/Overwrite \| Append \| Cancel/.test(ctx), 'context-handling must NOT document the obsolete "Overwrite | Append | Cancel" (#2772)');
});

test('gate-prompts gray-area-option does not mandate "Let Claude decide" (#2772.2)', () => {
  const src = read('gsd-core/references/gate-prompts.md');
  const gray = src.slice(src.indexOf('## Pattern: gray-area-option'));
  assert.ok(!/Always include "Let Claude decide"/i.test(gray), 'gray-area-option must NOT mandate "Let Claude decide" — it contradicts discuss-phase.md:353 ("Do NOT include a skip or you decide option") (#2772)');
});

test('discuss-phase auto_advance fallback ends the workflow, not routes back to confirm_creation (#2772.3)', () => {
  const src = read('gsd-core/workflows/discuss-phase.md');
  const step = src.slice(src.indexOf('<step name="auto_advance">'), src.indexOf('</step>', src.indexOf('<step name="auto_advance">')));
  assert.ok(!/route to `confirm_creation`/.test(step), 'auto_advance fallback must not route back to confirm_creation (it already ran earlier in the step order — circular) (#2772)');
  assert.ok(/end here|workflow is complete/i.test(step), 'auto_advance fallback must explicitly END the workflow (positive anchor — a re-phrased regression should not slip past) (#2772)');
});

test('discuss-phase-assumptions auto_advance fallback also ends the workflow (sibling of #2772.3)', () => {
  const src = read('gsd-core/workflows/discuss-phase-assumptions.md');
  const step = src.slice(src.indexOf('<step name="auto_advance">'), src.indexOf('</step>', src.indexOf('<step name="auto_advance">')));
  assert.ok(!/Route to confirm_creation step/.test(step), 'assumptions auto_advance fallback must not route back to confirm_creation (same circularity as the parent) (#2772)');
  assert.ok(/end here|workflow is complete/i.test(step), 'assumptions auto_advance fallback must explicitly END the workflow (#2772)');
});

test('discuss-phase-assumptions answer_validation matches the parent canonical content (#2772.4)', () => {
  const parent = read('gsd-core/workflows/discuss-phase.md');
  const assumptions = read('gsd-core/workflows/discuss-phase-assumptions.md');
  // The parent's canonical answer_validation includes the "Other" empty-text branch.
  const parentBlock = parent.slice(parent.indexOf('<answer_validation>'), parent.indexOf('</answer_validation>') + '</answer_validation>'.length);
  const assumptionsBlock = assumptions.slice(assumptions.indexOf('<answer_validation>'), assumptions.indexOf('</answer_validation>') + '</answer_validation>'.length);
  assert.ok(/"Other" with empty text/.test(assumptionsBlock), 'assumptions answer_validation must include the "Other" empty-text branch (was drifted) (#2772)');
  // The two blocks must now agree on the empty-response handling.
  assert.strictEqual(assumptionsBlock, parentBlock, 'discuss-phase-assumptions answer_validation must match the parent canonical block exactly (single source of truth) (#2772)');
});
  });
}

// #5629: every discuss mode honours a phase SPEC the same way. The default flow always did (check_spec);
// assumptions mode and --power (dispatched past check_spec) never read it, so CONTEXT.md could lock decisions
// that contradict it. The SPEC is now an init fact (`has_spec` / `spec_path`, one shared predicate) and each
// flow carries the same check_spec step; this parity test fails if any mode drops it.
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

describe('discuss-phase modes honour the phase SPEC (#5629)', () => {
  const readSrc = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const FLOWS = {
    default: 'gsd-core/workflows/discuss-phase.md',
    assumptions: 'gsd-core/workflows/discuss-phase-assumptions.md',
    power: 'gsd-core/workflows/discuss-phase-power.md',
  };
  const stepBody = (src, name) => {
    const open = `<step name="${name}">`;
    const start = src.indexOf(open);
    if (start === -1) return null;
    return src.slice(start, src.indexOf('</step>', start) + '</step>'.length);
  };

  // The text where each flow decides WHAT to discuss: the HOW-only restriction must live there.
  const howRegion = (mode, src) => {
    if (mode === 'default') return src.slice(src.indexOf('2b. **SPEC.md awareness**'), src.indexOf('3. **Gray areas**'));
    if (mode === 'assumptions') return src.slice(src.indexOf('Agent(subagent_type="gsd-assumptions-analyzer"'), src.indexOf('${AGENT_SKILLS_ANALYZER}\n""")'));
    return stepBody(src, 'analyze');
  };

  test('every discuss mode carries the SPEC contract (#5629)', () => {
    for (const [mode, rel] of Object.entries(FLOWS)) {
      const src = readSrc(rel);
      const step = stepBody(src, 'check_spec');
      assert.ok(step, `${mode}: ${rel} must carry a check_spec step`);
      assert.ok(step.includes('has_spec') && step.includes('spec_path'), `${mode}: check_spec reads the init facts has_spec / spec_path`);
      assert.ok(step.includes('spec_loaded = true'), `${mode}: check_spec sets spec_loaded`);
      assert.ok(/locked_requirements/.test(step), `${mode}: check_spec stores the locked requirements`);
      assert.ok(src.includes('<spec_lock>'), `${mode}: the CONTEXT.md it writes carries <spec_lock>`);
      assert.ok(/Locked requirements — MUST read before planning/.test(src), `${mode}: the SPEC is listed in canonical_refs`);
      const how = howRegion(mode, src);
      assert.ok(how && /\bHOW\b/.test(how) && /\bWHAT\b/.test(how), `${mode}: the step that picks what to discuss restricts it to HOW (WHAT is already locked)`);
    }
    const bodies = Object.values(FLOWS).map((rel) => stepBody(readSrc(rel), 'check_spec'));
    assert.strictEqual(bodies[1], bodies[0], 'assumptions check_spec matches the default flow exactly (single source of truth)');
    assert.strictEqual(bodies[2], bodies[0], 'power check_spec matches the default flow exactly (single source of truth)');
  });

  test('the power flow loads the SPEC itself, before it analyzes (#5629)', () => {
    const src = readSrc(FLOWS.power);
    const check = src.indexOf('<step name="check_spec">');
    const analyze = src.indexOf('<step name="analyze">');
    assert.ok(check !== -1 && analyze !== -1, 'power carries both check_spec and analyze');
    assert.ok(check < analyze, 'check_spec runs before analyze: --power is dispatched past discuss-phase.md check_spec');
  });

  test('assumptions mode hands the locked requirements to the analyzer as already answered (#5629)', () => {
    const src = readSrc(FLOWS.assumptions);
    const check = src.indexOf('<step name="check_spec">');
    const analysis = src.indexOf('<step name="deep_codebase_analysis">');
    assert.ok(check !== -1 && check < analysis, 'check_spec runs before the analyzer step');
    const prompt = src.slice(src.indexOf('Agent(subagent_type="gsd-assumptions-analyzer"'), src.indexOf('${AGENT_SKILLS_ANALYZER}\n""")'));
    assert.ok(/Locked requirements/.test(prompt) && /{locked_requirements}/.test(prompt), 'the analyzer prompt carries the locked requirements');
    assert.ok(/HOW/.test(prompt), 'the analyzer is told to form assumptions about HOW only');
  });

  test('no workflow globs for the phase SPEC itself (#5629)', () => {
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : (p.endsWith('.md') ? [p] : []);
    });
    const offenders = walk(path.join(__dirname, '..', 'gsd-core', 'workflows'))
      .filter((p) => splitLines(fs.readFileSync(p, 'utf8')).some((line) => /\bls\b/.test(line) && line.includes('*-SPEC.md')))
      .map((p) => path.relative(path.join(__dirname, '..'), p));
    assert.deepStrictEqual(offenders, [], 'workflows read has_spec / spec_path from init instead of an ls over *-SPEC.md');
  });

  test('discuss-phase and plan-phase read the SPEC from init (#5629)', () => {
    const discuss = readSrc(FLOWS.default);
    assert.ok(!/ls \$\{phase_dir\}\/\*-SPEC\.md/.test(discuss), 'discuss-phase.md reads has_spec / spec_path from init instead of its own ls');
    const plan = readSrc('gsd-core/workflows/plan-phase.md');
    assert.ok(!/\*-SPEC\.md" 2>\/dev\/null \| grep/.test(plan), 'plan-phase.md does not filter SPEC names itself');
    assert.ok(plan.includes('_gsd_field "$INIT" spec_path'), 'plan-phase.md reads spec_path from its init payload');
  });
});
