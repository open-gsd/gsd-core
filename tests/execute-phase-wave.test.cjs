/**
 * Execute-phase wave filter tests
 *
 * Validates the /gsd-execute-phase --wave feature contract:
 * - Command frontmatter advertises --wave
 * - Workflow parses WAVE_FILTER
 * - Workflow enforces lower-wave safety
 * - Partial wave runs do not mark the phase complete
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const COMMAND_PATH = path.join(__dirname, '..', 'commands', 'gsd', 'execute-phase.md');
const WORKFLOW_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md');
const COMMANDS_DOC_PATH = path.join(__dirname, '..', 'docs', 'COMMANDS.md');
// After #3039, the comprehensive command reference moved to help/modes/full.md.
const HELP_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'help', 'modes', 'full.md');

// allow-test-rule: source-text-is-the-product
// The workflow and command .md files are the installed AI instructions — their text content
// IS what executes. String presence tests guard against accidental deletion of critical clauses.
// See #2692 for the missing behavioral test for --wave N argument parsing.
describe('execute-phase command: --wave flag', () => {
  test('command file exists', () => {
    assert.ok(fs.existsSync(COMMAND_PATH), 'commands/gsd/execute-phase.md should exist');
  });

  test('argument-hint includes --wave, --gaps-only, and --interactive', () => {
    const content = fs.readFileSync(COMMAND_PATH, 'utf-8');
    const hintLine = content.split(/\r?\n/).find(l => l.includes('argument-hint'));
    assert.ok(hintLine, 'should have argument-hint line');
    assert.ok(hintLine.includes('--wave N'), 'argument-hint should include --wave N');
    assert.ok(hintLine.includes('--gaps-only'), 'argument-hint should keep --gaps-only');
    assert.ok(hintLine.includes('--interactive'), 'argument-hint should preserve --interactive');
  });

  test('objective describes wave-filter execution', () => {
    const content = fs.readFileSync(COMMAND_PATH, 'utf-8');
    // eslint-disable-next-line local/no-unbounded-quantifier -- parses this repo's own command .md content, fixed-size author-controlled content
    const objectiveMatch = content.match(/<objective>([\s\S]*?)<\/objective>/);
    assert.ok(objectiveMatch, 'should have <objective> section');
    assert.ok(objectiveMatch[1].includes('--wave N'), 'objective should mention --wave N');
    assert.ok(
      objectiveMatch[1].includes('no incomplete plans remain'),
      'objective should mention phase completion guardrail'
    );
  });
});

describe('execute-phase workflow: wave filtering', () => {
  test('workflow file exists', () => {
    assert.ok(fs.existsSync(WORKFLOW_PATH), 'workflows/execute-phase.md should exist');
  });

  test('workflow parses WAVE_FILTER from arguments', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    assert.ok(content.includes('WAVE_FILTER'), 'workflow should reference WAVE_FILTER');
    assert.ok(content.includes('Optional `--wave N`'), 'workflow should parse --wave N');
  });

  test('workflow enforces lower-wave safety', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    assert.ok(
      content.includes('Wave safety check'),
      'workflow should contain a wave safety check section'
    );
    assert.ok(
      content.includes('finish earlier waves first'),
      'workflow should block later-wave execution when lower waves are incomplete'
    );
  });

  test('workflow has partial-wave completion guardrail', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    // handle_partial_wave_execution was extracted to
    // gsd-core/workflows/execute-phase/steps/partial-wave.md. The parent now only
    // references it via a <gsd:section> pointer, so assert the pointer is present here
    // and then read the actual step body from the extracted file below.
    assert.ok(
      content.includes('gsd-core/workflows/execute-phase/steps/partial-wave.md'),
      'workflow should reference the extracted partial-wave step file'
    );

    const PARTIAL_WAVE_STEP_PATH = path.join(
      __dirname, '..', 'gsd-core', 'workflows', 'execute-phase', 'steps', 'partial-wave.md'
    );
    assert.ok(fs.existsSync(PARTIAL_WAVE_STEP_PATH), 'partial-wave step file should exist');
    const stepContent = fs.readFileSync(PARTIAL_WAVE_STEP_PATH, 'utf-8');

    assert.ok(
      stepContent.includes('<step name="handle_partial_wave_execution">'),
      'workflow should have a partial wave handling step'
    );
    assert.ok(
      stepContent.includes('Do NOT run phase verification'),
      'partial wave step should skip phase verification'
    );
    assert.ok(
      stepContent.includes('Do NOT mark the phase complete'),
      'partial wave step should skip phase completion'
    );
  });
});

// #2868: a phase whose plans are ALL summarized but which never reached
// verify_phase_goal (most commonly a retired checkpoint plan that still wrote a
// SUMMARY) must resume at the phase gates instead of exiting unconditionally —
// the prior behavior made `code_review_gate`, `regression_gate`, and
// `verify_phase_goal` (the only producer of *-VERIFICATION.md) unreachable.
describe('execute-phase workflow: #2868 stranded-phase resume on discover_and_group_plans', () => {
  test('W1: all-filtered outcome is no longer an unconditional exit; it consults verification status', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    assert.ok(
      !content.includes('If all filtered: "No matching incomplete plans" → exit.'),
      'the old unconditional all-filtered exit line must be gone (#2868)'
    );
    assert.ok(
      content.includes('VERIFY_STATUS'),
      'discover_and_group_plans should consult VERIFY_STATUS before exiting on all-filtered'
    );
    assert.ok(
      content.includes('verification all-summarized'),
      'discover_and_group_plans should call the verification all-summarized decision (#6096)'
    );
  });

  test('W2: the resume path names both code_review_gate and regression_gate', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    const discoverIdx = content.indexOf('<step name="discover_and_group_plans">');
    const discoverEnd = content.indexOf('</step>', discoverIdx) + '</step>'.length;
    assert.ok(discoverIdx >= 0, 'discover_and_group_plans step should exist');
    const discoverSection = content.substring(discoverIdx, discoverEnd);

    assert.ok(
      discoverSection.includes('code_review_gate'),
      'discover_and_group_plans should name code_review_gate as the resume target'
    );
    assert.ok(
      discoverSection.includes('regression_gate'),
      'discover_and_group_plans should name regression_gate so a future rename breaks this test ' +
        'instead of silently orphaning the resume path'
    );
  });

  test('W3: the resume path is gated off when a filter is active (--gaps-only or WAVE_FILTER)', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    const discoverIdx = content.indexOf('<step name="discover_and_group_plans">');
    const discoverEnd = content.indexOf('</step>', discoverIdx) + '</step>'.length;
    assert.ok(discoverIdx >= 0, 'discover_and_group_plans step should exist');
    const discoverSection = content.substring(discoverIdx, discoverEnd);

    const filterIdx = discoverSection.indexOf('**`exit-filtered`**');
    assert.ok(filterIdx >= 0, 'discover_and_group_plans should describe a filter-active branch (#6096: the exit-filtered decision)');
    // Both flags must be mentioned near the filter-active branch, not merely
    // anywhere in the step (e.g. in the pre-existing filtering prose above).
    const filterClause = discoverSection.substring(filterIdx, filterIdx + 200);
    assert.ok(
      filterClause.includes('--gaps-only'),
      'filter-active branch should mention --gaps-only'
    );
    assert.ok(
      filterClause.includes('WAVE_FILTER'),
      'filter-active branch should mention WAVE_FILTER'
    );
  });

  test('W4: the resume decision is gated on the absence of blocked_by-skipped plans', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    const discoverIdx = content.indexOf('<step name="discover_and_group_plans">');
    const discoverEnd = content.indexOf('</step>', discoverIdx) + '</step>'.length;
    assert.ok(discoverIdx >= 0, 'discover_and_group_plans step should exist');
    const discoverSection = content.substring(discoverIdx, discoverEnd);

    // Scope to the resume-decision text specifically (from the "If all filtered" marker
    // onward), not the pre-existing #2830 filtering prose above it that already mentions
    // blocked_by unconditionally — otherwise this assertion would be vacuous.
    const decisionIdx = discoverSection.indexOf('If all filtered');
    assert.ok(decisionIdx >= 0, 'discover_and_group_plans should have an all-filtered decision block');
    const decisionText = discoverSection.substring(decisionIdx);

    assert.ok(
      decisionText.includes('blocked_by'),
      'the resume-decision text must reference blocked_by so an all-blocked phase is never ' +
        'reported as finished (#2868 finding 1)'
    );
    assert.ok(
      /stuck/i.test(decisionText),
      'the resume-decision text must call out the blocked-and-incomplete case as stuck, ' +
        'distinct from genuinely finished'
    );
  });

  test('W5: the resume path enters at aggregate_results, not code_review_gate', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    const discoverIdx = content.indexOf('<step name="discover_and_group_plans">');
    const discoverEnd = content.indexOf('</step>', discoverIdx) + '</step>'.length;
    assert.ok(discoverIdx >= 0, 'discover_and_group_plans step should exist');
    const discoverSection = content.substring(discoverIdx, discoverEnd);

    const continueMatch = discoverSection.match(/continue (?:directly )?at\s+`([a-zA-Z_]+)`/);
    assert.ok(continueMatch, 'resume decision should state which step it continues at');
    assert.strictEqual(
      continueMatch[1],
      'aggregate_results',
      'the resume path must enter at aggregate_results (the only step running the ' +
        'SECURITY_FILE / secure-phase threats-open gate), not code_review_gate — skipping ' +
        'aggregate_results silently drops the only security gate (#2868 finding 3)'
    );
    assert.notStrictEqual(
      continueMatch[1],
      'code_review_gate',
      'resume entry point must not be code_review_gate'
    );
  });

  test('W6: RESUME_TAIL_ONLY (dead, write-only state) must not appear anywhere in the workflow', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    assert.ok(
      !content.includes('RESUME_TAIL_ONLY'),
      'RESUME_TAIL_ONLY was set but never read anywhere in the workflow or its steps files ' +
        '(#2868 finding 2) — remove it; the imperative instruction at the decision point is ' +
        'what actually carries control flow'
    );
  });
});

// #5843: the phase-start STATE.md write (`state.begin-phase`) must come after plan
// discovery and only when at least one plan will be dispatched. Every run that
// dispatches nothing (verify-only resume, blocked, not-ready, filtered-empty,
// finished) used to have rewritten Current Position / Status / Last activity to
// "Executing, Plan 1 of N" before discovery decided there was nothing to run.
// allow-test-rule: <runtime-contract-is-the-product> (see #5843) — the workflow .md is the
// installed AI instruction; step blocks are parsed structurally by <step name>.
describe('execute-phase workflow: #5843 phase-start STATE write follows plan discovery', () => {
  function workflow() {
    return fs.readFileSync(WORKFLOW_PATH, 'utf-8');
  }

  function stepBlock(content, name) {
    const open = `<step name="${name}">`;
    const start = content.indexOf(open);
    assert.ok(start >= 0, `step ${name} should exist`);
    const end = content.indexOf('</step>', start);
    assert.ok(end > start, `step ${name} should be closed`);
    return content.substring(start, end + '</step>'.length);
  }

  test('#5843 row 1: validate_phase contains no state.begin-phase call', () => {
    assert.ok(
      !/state\.begin-phase/.test(stepBlock(workflow(), 'validate_phase')),
      'validate_phase runs before plan discovery; the phase-start write must not live there'
    );
  });

  test('#5843 row 2: exactly one state.begin-phase call in the whole workflow', () => {
    const matches = workflow().match(/state\.begin-phase/g) || [];
    assert.strictEqual(matches.length, 1, 'the phase start is recorded exactly once');
  });

  test('#5843 row 3: the call lives in discover_and_group_plans after the Execution Plan report', () => {
    const step = stepBlock(workflow(), 'discover_and_group_plans');
    const callIdx = step.search(/state\.begin-phase/);
    assert.ok(callIdx >= 0, 'discover_and_group_plans should hold the state.begin-phase call');
    const reportIdx = step.indexOf('## Execution Plan');
    assert.ok(reportIdx >= 0, 'discover_and_group_plans should hold the Execution Plan report');
    assert.ok(callIdx > reportIdx, 'the call must come after the Execution Plan report');
  });

  test('#5843 row 4: the call is gated on at least one plan being dispatched', () => {
    const step = stepBlock(workflow(), 'discover_and_group_plans');
    const callIdx = step.search(/state\.begin-phase/);
    assert.ok(callIdx >= 0, 'discover_and_group_plans should hold the state.begin-phase call');
    const lead = step.substring(Math.max(0, callIdx - 700), callIdx);
    assert.match(
      lead,
      /at least one plan (?:will be|is about to be) dispatched/,
      'the text introducing the call must name the non-empty post-filter dispatch condition'
    );
  });

  test('#5843 row 5: the call precedes cross_ai_delegation and execute_waves', () => {
    const content = workflow();
    const callIdx = content.search(/state\.begin-phase/);
    assert.ok(callIdx >= 0, 'state.begin-phase call should exist');
    assert.ok(callIdx < content.indexOf('<step name="cross_ai_delegation">'));
    assert.ok(callIdx < content.indexOf('<step name="execute_waves">'));
  });

  test('#5843 row 6: the call keeps its --phase, --name and --plans arguments', () => {
    assert.ok(
      workflow().includes(
        // #5861: the verb carries the workstream token so the phase-start write lands in the scoped STATE.md
        'state.begin-phase ${GSD_WS:+--ws=${GSD_WS##* }} --phase "${PHASE_NUMBER}" --name "${PHASE_NAME}" --plans "${PLAN_COUNT}"'
      ),
      'the begin-phase arguments are unchanged by the move'
    );
  });

  test('#5843 row 7: verify-only, blocked and filtered-empty exits all precede the call', () => {
    const step = stepBlock(workflow(), 'discover_and_group_plans');
    const callIdx = step.search(/state\.begin-phase/);
    assert.ok(callIdx >= 0, 'discover_and_group_plans should hold the state.begin-phase call');
    const arms = [
      ['verify-only resume', 'continue directly at `aggregate_results`'],
      ['blocked exit', 'Phase stuck:'],
      ['filtered-empty exit', 'No matching incomplete plans'],
      ['2b not-ready exit', 'WAITING on incomplete predecessors'],
      ['#3684 resume arm', 'resuming at update_roadmap (#3684)'],
      ['gaps-only refusal STOP', '--gaps-only cannot read gap_closure'],
      ['wave-safety STOP', 'STOP and tell the user to finish earlier waves first'],
    ];
    for (const [label, marker] of arms) {
      const idx = step.lastIndexOf(marker);
      assert.ok(idx >= 0, `${label} arm (${marker}) should exist`);
      assert.ok(idx < callIdx, `${label} arm must appear before the state.begin-phase call`);
    }
  });
});

describe('execute-phase docs: user-facing wave flag', () => {
  test('COMMANDS.md documents --wave usage', () => {
    const content = fs.readFileSync(COMMANDS_DOC_PATH, 'utf-8');
    assert.ok(content.includes('`--wave N`'), 'COMMANDS.md should mention --wave N');
    assert.ok(
      content.includes('/gsd-execute-phase 1 --wave 2'),
      'COMMANDS.md should include a wave-filter example'
    );
  });

  test('help workflow documents --wave behavior', () => {
    const content = fs.readFileSync(HELP_PATH, 'utf-8');
    assert.ok(
      content.includes('Optional `--wave N` flag executes only Wave `N`'),
      'help.md should describe wave-specific execution'
    );
    assert.ok(
      content.includes('Usage: `/gsd:execute-phase 5 --wave 2`') || content.includes('Usage: `/gsd-execute-phase 5 --wave 2`'),
      'help.md should include wave-filter usage'
    );
  });

  test('workflow supports use_worktrees config toggle', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    assert.ok(
      content.includes('USE_WORKTREES'),
      'workflow should reference USE_WORKTREES variable'
    );
    assert.ok(
      content.includes('config-get workflow.use_worktrees'),
      'workflow should read use_worktrees from config'
    );
    assert.ok(
      content.includes('Sequential mode'),
      'workflow should document sequential mode when worktrees disabled'
    );
  });
});

describe('phase-plan-index: wave grouping behavior', () => {
  test('phase-plan-index groups plans by wave (DAG-bucketing: P002 depends on P001)', () => {
    const fs = require('fs');
    const path = require('path');
    const tmpDir = createTempProject();
    try {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-alpha');
      fs.mkdirSync(phaseDir, { recursive: true });

      // Wave 1 plan — no dependencies
      fs.writeFileSync(path.join(phaseDir, 'P001-PLAN.md'), [
        '---',
        'wave: 1',
        'objective: First wave task',
        'autonomous: true',
        'depends_on: []',
        '---',
        '',
        '# Plan 001',
        '',
        '<objective>First wave task</objective>',
        '',
        '<task>Do the thing</task>',
      ].join('\n'));

      // Wave 2 plan — depends on P001 so DAG places it in level 1 → wave 2
      fs.writeFileSync(path.join(phaseDir, 'P002-PLAN.md'), [
        '---',
        'wave: 2',
        'objective: Second wave task',
        'autonomous: true',
        'depends_on:',
        '  - P001',
        '---',
        '',
        '# Plan 002',
        '',
        '<objective>Second wave task</objective>',
        '',
        '<task>Do the other thing</task>',
      ].join('\n'));

      const result = runGsdTools(['phase-plan-index', '1', '--raw'], tmpDir);
      assert.ok(result.success, `phase-plan-index should succeed: ${result.error}`);

      const data = JSON.parse(result.output);

      // Wave grouping must be present
      assert.ok(data.waves, 'output should have a waves property');
      assert.deepEqual(data.waves['1'], ['P001'], 'wave 1 should contain P001');
      assert.deepEqual(data.waves['2'], ['P002'], 'wave 2 should contain P002');

      // Individual plan records must carry their wave numbers
      const p001 = data.plans.find(p => p.id === 'P001');
      const p002 = data.plans.find(p => p.id === 'P002');
      assert.ok(p001, 'P001 should be in plans array');
      assert.ok(p002, 'P002 should be in plans array');
      assert.equal(p001.wave, 1, 'P001 should have wave=1');
      assert.equal(p002.wave, 2, 'P002 should have wave=2');
      // No mismatch warning: declared wave 2 matches topo level 2
      assert.strictEqual(data.warnings, undefined, 'no warnings when declared wave matches DAG');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('phase-plan-index defaults missing wave frontmatter to wave 1', () => {
    const fs = require('fs');
    const path = require('path');
    const tmpDir = createTempProject();
    try {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-alpha');
      fs.mkdirSync(phaseDir, { recursive: true });

      // Plan with no wave field in frontmatter
      fs.writeFileSync(path.join(phaseDir, 'P001-PLAN.md'), [
        '---',
        'objective: No wave specified',
        'autonomous: true',
        '---',
        '',
        '# Plan 001',
        '',
        '<task>Some work</task>',
      ].join('\n'));

      const result = runGsdTools(['phase-plan-index', '1', '--raw'], tmpDir);
      assert.ok(result.success, `phase-plan-index should succeed: ${result.error}`);

      const data = JSON.parse(result.output);
      const p001 = data.plans.find(p => p.id === 'P001');
      assert.ok(p001, 'P001 should appear in plans');
      assert.equal(p001.wave, 1, 'plan with no wave frontmatter should default to wave 1');
      assert.deepEqual(data.waves['1'], ['P001'], 'defaulted plan should land in wave 1 group');
    } finally {
      cleanup(tmpDir);
    }
  });
});

describe('use_worktrees config: cross-workflow structural coverage', () => {
  const QUICK_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'quick.md');
  const DIAGNOSE_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'diagnose-issues.md');
  const EXECUTE_PLAN_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-plan.md');
  const PLANNING_CONFIG_PATH = path.join(__dirname, '..', 'gsd-core', 'references', 'planning-config.md');

  test('quick workflow reads USE_WORKTREES from config', () => {
    const content = fs.readFileSync(QUICK_PATH, 'utf-8');
    assert.ok(
      content.includes('config-get workflow.use_worktrees'),
      'quick.md should read use_worktrees from config'
    );
    assert.ok(
      content.includes('USE_WORKTREES'),
      'quick.md should reference USE_WORKTREES variable'
    );
  });

  test('diagnose-issues workflow reads USE_WORKTREES from config', () => {
    const content = fs.readFileSync(DIAGNOSE_PATH, 'utf-8');
    assert.ok(
      content.includes('config-get workflow.use_worktrees'),
      'diagnose-issues.md should read use_worktrees from config'
    );
    assert.ok(
      content.includes('USE_WORKTREES'),
      'diagnose-issues.md should reference USE_WORKTREES variable'
    );
  });

  test('execute-plan workflow references use_worktrees config', () => {
    const content = fs.readFileSync(EXECUTE_PLAN_PATH, 'utf-8');
    assert.ok(
      content.includes('workflow.use_worktrees'),
      'execute-plan.md should reference workflow.use_worktrees'
    );
  });

  test('planning-config reference documents use_worktrees', () => {
    const content = fs.readFileSync(PLANNING_CONFIG_PATH, 'utf-8');
    assert.ok(
      content.includes('workflow.use_worktrees'),
      'planning-config.md should document workflow.use_worktrees'
    );
    assert.ok(
      content.includes('worktree'),
      'planning-config.md should describe worktree behavior'
    );
  });

  test('config-set accepts workflow.use_worktrees', () => {
    const tmpDir = createTempProject();
    try {
      const result = runGsdTools('config-set workflow.use_worktrees true', tmpDir);
      assert.ok(result.success, `config-set should accept workflow.use_worktrees: ${result.error}`);
    } finally {
      cleanup(tmpDir);
    }
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2410-stream-checkpoint-heartbeats.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2410-stream-checkpoint-heartbeats (consolidation epic #1969 B4 #1973)", () => {
// allow-test-rule: source-text-is-the-product (see #2410)
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * Bug #2410 — /gsd:manager background execute-phase Task fails with
 * "Stream idle timeout" on multi-plan phases.
 *
 * Fix: execute-phase.md instructs the orchestrator to emit `[checkpoint]`
 * heartbeat lines at every wave boundary AND every plan boundary so the
 * Claude API SSE stream never idles long enough to trigger the platform
 * timeout. This test validates the workflow contract that backs that fix.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKFLOW_PATH = path.join(
  __dirname,
  '..',
  'gsd-core',
  'workflows',
  'execute-phase.md'
);
const COMMANDS_DOC_PATH = path.join(__dirname, '..', 'docs', 'COMMANDS.md');

describe('bug #2410: execute-phase emits checkpoint heartbeats', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf-8');

  test('workflow references the stream idle timeout symptom by name', () => {
    assert.ok(
      /Stream idle timeout/.test(workflow),
      'workflow should name the API error it is preventing'
    );
    assert.ok(
      workflow.includes('#2410'),
      'workflow should cite the tracking issue for future maintainers'
    );
  });

  test('workflow defines a [checkpoint] heartbeat line format', () => {
    assert.ok(
      workflow.includes('[checkpoint]'),
      'workflow should document the [checkpoint] marker prefix'
    );
  });

  test('workflow emits a wave-start heartbeat (A: wave-boundary checkpoint)', () => {
    assert.ok(
      // eslint-disable-next-line local/no-unbounded-quantifier -- parses maintainer-authored execute-phase.md workflow, bounded prose, not adversarial input
      /\[checkpoint\][^\r\n]*wave \{N\}\/\{M\} starting/.test(workflow),
      'workflow should emit a wave-start [checkpoint] marker before spawning agents'
    );
  });

  test('workflow emits a wave-complete heartbeat (A: wave-boundary checkpoint)', () => {
    assert.ok(
      // eslint-disable-next-line local/no-unbounded-quantifier -- parses maintainer-authored execute-phase.md workflow, bounded prose, not adversarial input
      /\[checkpoint\][^\r\n]*wave \{N\}\/\{M\} complete/.test(workflow),
      'workflow should emit a wave-complete [checkpoint] marker after spot-checks'
    );
  });

  test('workflow emits a plan-start heartbeat (B: plan-boundary checkpoint)', () => {
    assert.ok(
      // eslint-disable-next-line local/no-unbounded-quantifier -- parses maintainer-authored execute-phase.md workflow, bounded prose, not adversarial input
      /\[checkpoint\][^\r\n]*plan \{plan_id\} starting/.test(workflow),
      'workflow should emit a plan-start [checkpoint] marker before each Task() dispatch'
    );
  });

  test('workflow emits a plan-complete heartbeat (B: plan-boundary checkpoint)', () => {
    assert.ok(
      // eslint-disable-next-line local/no-unbounded-quantifier -- parses maintainer-authored execute-phase.md workflow, bounded prose, not adversarial input
      /\[checkpoint\][^\r\n]*plan \{plan_id\} complete/.test(workflow),
      'workflow should emit a plan-complete [checkpoint] marker after executor returns'
    );
  });

  test('workflow handles plan failure and checkpoint-gate heartbeats too', () => {
    assert.ok(
      // eslint-disable-next-line local/no-unbounded-quantifier -- parses maintainer-authored execute-phase.md workflow, bounded prose, not adversarial input
      /\[checkpoint\][^\r\n]*plan \{plan_id\} failed/.test(workflow),
      'workflow should emit a plan-failed [checkpoint] marker on executor error'
    );
    assert.ok(
      // eslint-disable-next-line local/no-unbounded-quantifier -- parses maintainer-authored execute-phase.md workflow, bounded prose, not adversarial input
      /\[checkpoint\][^\r\n]*plan \{plan_id\} checkpoint/.test(workflow),
      'workflow should emit a heartbeat when a plan returns a human-gate checkpoint'
    );
  });

  test('heartbeats include a monotonic plans-done counter', () => {
    // The {P}/{Q} counter lets grep-based recovery tools reconstruct progress
    // from a truncated transcript if the agent dies mid-phase.
    assert.ok(
      /\{P\}\/\{Q\} plans done/.test(workflow),
      'heartbeats should include a {P}/{Q} phase-wide completed-plan counter'
    );
  });

  test('wave-start heartbeat precedes the "Describe what\'s being built" text', () => {
    const describeIdx = workflow.indexOf("Describe what's being built");
    const heartbeatIdx = workflow.indexOf(
      '[checkpoint] phase {PHASE_NUMBER} wave {N}/{M} starting'
    );
    assert.ok(describeIdx !== -1, 'workflow should still have the describe step');
    assert.ok(heartbeatIdx !== -1, 'wave-start heartbeat template should be present');
    // The instruction to emit the heartbeat appears in step 2, which is the
    // step titled "Describe what's being built". The actual sentinel text we
    // look for is the inline literal template — it must be emitted BEFORE any
    // tool calls in that step.
    const step2 = workflow.slice(
      describeIdx,
      workflow.indexOf('3. **Spawn executor agents', describeIdx)
    );
    assert.ok(
      step2.includes('[checkpoint]'),
      'step 2 should instruct the orchestrator to emit a [checkpoint] heartbeat'
    );
    assert.ok(
      /before any further reasoning or spawning/i.test(step2) ||
        /before any tool call/i.test(step2) ||
        /no tool call/i.test(step2),
      'step 2 should make clear the heartbeat is an assistant-text line, not a tool call'
    );
  });

  test('plan-start heartbeat is inside the spawn step', () => {
    const spawnIdx = workflow.indexOf('3. **Spawn executor agents');
    const waitIdx = workflow.indexOf('4. **Wait for all agents', spawnIdx);
    assert.ok(spawnIdx !== -1 && waitIdx !== -1, 'spawn and wait steps must exist');
    const step3 = workflow.slice(spawnIdx, waitIdx);
    assert.ok(
      // eslint-disable-next-line local/no-unbounded-quantifier -- parses a slice of maintainer-authored execute-phase.md workflow, bounded prose, not adversarial input
      /\[checkpoint\][^\r\n]*plan \{plan_id\} starting/.test(step3),
      'plan-start heartbeat should be emitted inside step 3 (spawn executor agents)'
    );
  });

  test('plan-complete and wave-complete heartbeats are inside the wait/report steps', () => {
    const waitIdx = workflow.indexOf('4. **Wait for all agents');
    const hookIdx = workflow.indexOf('5. **Post-wave hook validation', waitIdx);
    assert.ok(waitIdx !== -1 && hookIdx !== -1, 'wait + hook steps must exist');
    const step4 = workflow.slice(waitIdx, hookIdx);
    assert.ok(
      // eslint-disable-next-line local/no-unbounded-quantifier -- parses a slice of maintainer-authored execute-phase.md workflow, bounded prose, not adversarial input
      /\[checkpoint\][^\r\n]*plan \{plan_id\} complete/.test(step4),
      'plan-complete heartbeat should be emitted in step 4 (wait for agents)'
    );

    const reportIdx = workflow.indexOf('6. **Report completion');
    const failureIdx = workflow.indexOf('7. **Handle failures', reportIdx);
    assert.ok(reportIdx !== -1 && failureIdx !== -1, 'report + failure steps must exist');
    const step6 = workflow.slice(reportIdx, failureIdx);
    assert.ok(
      // eslint-disable-next-line local/no-unbounded-quantifier -- parses a slice of maintainer-authored execute-phase.md workflow, bounded prose, not adversarial input
      /\[checkpoint\][^\r\n]*wave \{N\}\/\{M\} complete/.test(step6),
      'wave-complete heartbeat should be emitted in step 6 (report completion)'
    );
  });
});

describe('bug #2410: checkpoint heartbeat format is user-documented', () => {
  const commandsDoc = fs.readFileSync(COMMANDS_DOC_PATH, 'utf-8');

  test('COMMANDS.md documents the [checkpoint] format under /gsd-manager', () => {
    const managerIdx = commandsDoc.indexOf('### `/gsd-manager`');
    assert.ok(managerIdx !== -1, '/gsd-manager section should exist');
    const section = commandsDoc.slice(managerIdx, managerIdx + 4000);
    assert.ok(
      /\[checkpoint\]/.test(section),
      'COMMANDS.md /gsd-manager section should document [checkpoint] heartbeat markers'
    );
    assert.ok(
      /Stream idle timeout/i.test(section),
      'COMMANDS.md should explain what the heartbeats prevent'
    );
    assert.ok(
      /#2410/.test(section),
      'COMMANDS.md should reference the tracking issue'
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/fix-1369-wave-stale-base.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:fix-1369-wave-stale-base (consolidation epic #1969 B4 #1973)", () => {
// allow-test-rule: source-text-is-the-product #1369
// Workflow .md files are the installed AI instructions — their text IS what the runtime
// loads. Testing text content tests the deployed contract. Per CONTRIBUTING.md exception matrix.

/**
 * Regression tests for bug #1369: execute-phase worktree agents fork from stale base after
 * a wave merge advances orchestrator HEAD past origin/HEAD.
 *
 * Steps 0.5 and 7b+7c are extracted to reference files to satisfy the ADR-857 size cap.
 * execute-phase.md contains @-reference pointers; the reference files hold the content.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKFLOW_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md');
const WAVE_GUARD_PATH = path.join(__dirname, '..', 'gsd-core', 'references', 'execute-phase-wave-guard.md');
const BETWEEN_WAVE_PATH = path.join(__dirname, '..', 'gsd-core', 'references', 'execute-phase-between-wave-reset.md');

describe('execute-phase: inter-wave worktree base re-check (#1369)', () => {
  test('workflow file exists', () => {
    assert.ok(fs.existsSync(WORKFLOW_PATH), 'workflows/execute-phase.md should exist');
  });

  test('wave-guard reference file exists', () => {
    assert.ok(fs.existsSync(WAVE_GUARD_PATH), 'references/execute-phase-wave-guard.md should exist');
  });

  test('workflow contains @-reference pointer to wave-guard (step 0.5 injected at runtime)', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    assert.ok(
      content.includes('execute-phase-wave-guard.md'),
      'execute-phase.md must have an @-reference to execute-phase-wave-guard.md'
    );
  });

  test('workflow contains step 0.5 inter-wave base re-check section', () => {
    const content = fs.readFileSync(WAVE_GUARD_PATH, 'utf-8');
    assert.ok(
      content.includes('0.5.') && content.includes('Inter-wave worktree base re-check'),
      'execute-phase-wave-guard.md must have step 0.5 "Inter-wave worktree base re-check"'
    );
  });

  test('step 0.5 references #1369', () => {
    const content = fs.readFileSync(WAVE_GUARD_PATH, 'utf-8');
    assert.ok(content.includes('#1369'), 'step 0.5 must reference #1369 for traceability');
  });

  test('step 0.5 runs worktree.base-check inside the For-each-wave loop', () => {
    const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    const forEachIdx = workflow.indexOf('**For each wave:**');
    const refIdx = workflow.indexOf('execute-phase-wave-guard.md');
    assert.ok(forEachIdx !== -1, '"For each wave:" section must exist in execute-phase.md');
    assert.ok(refIdx !== -1, '@-reference to wave-guard must exist in execute-phase.md');
    assert.ok(refIdx > forEachIdx, 'wave-guard @-reference must appear AFTER "For each wave:" so step 0.5 runs per-wave');
  });

  test('step 0.5 runs worktree.base-check command', () => {
    const content = fs.readFileSync(WAVE_GUARD_PATH, 'utf-8');
    assert.ok(content.includes('worktree.base-check'), 'step 0.5 must invoke worktree.base-check');
  });

  test('step 0.5 sets USE_WORKTREES=false when shouldDegrade is true', () => {
    const content = fs.readFileSync(WAVE_GUARD_PATH, 'utf-8');
    assert.ok(content.includes('USE_WORKTREES=false'), 'step 0.5 must override USE_WORKTREES=false when base divergence is detected');
  });

  test('step 0.5 appears before step 1 (intra-wave overlap check)', () => {
    const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    const forEachIdx = workflow.indexOf('**For each wave:**');
    const refIdx = workflow.indexOf('execute-phase-wave-guard.md');
    const step1Idx = workflow.indexOf('1. **Intra-wave', forEachIdx);
    assert.ok(refIdx !== -1, 'wave-guard @-reference must exist');
    assert.ok(step1Idx !== -1, 'step 1 (intra-wave overlap check) must exist');
    assert.ok(refIdx < step1Idx, 'wave-guard @-reference must appear before step 1');
  });

  // #2652: previously required `RUNTIME = "claude"`, encoding the pre-#2584 premise
  // that worktree isolation is Claude-specific. #2584 replaced that with the
  // negotiated dispatch.isolation capability — Cursor declares harness-worktree too,
  // and the harness fork-base caching this guard exists for is a property of the
  // isolation model, not of the runtime name.
  test('step 0.5 guards on the negotiated capability, not a runtime id', () => {
    const content = fs.readFileSync(WAVE_GUARD_PATH, 'utf-8');
    assert.ok(
      content.includes('ISOLATION') && content.includes('harness-worktree'),
      'step 0.5 must guard on ISOLATION = harness-worktree'
    );
    assert.ok(
      !/\[\s*"\$RUNTIME"\s*=/.test(content),
      'step 0.5 must NOT branch on a RUNTIME literal (#2584/#2652)'
    );
    assert.ok(
      content.includes('ISOLATION=none'),
      'degrade must clear ISOLATION as well as USE_WORKTREES — dispatch reads ISOLATION (#2652)'
    );
  });

  test('step 0.5 explains root cause: wave merges advance HEAD past origin/HEAD', () => {
    const content = fs.readFileSync(WAVE_GUARD_PATH, 'utf-8');
    assert.ok(content.includes('origin/HEAD'), 'step 0.5 must name origin/HEAD as the stale fork base');
  });

  test('step 0.5 cross-references #683 for worktree.baseRef configuration', () => {
    const content = fs.readFileSync(WAVE_GUARD_PATH, 'utf-8');
    assert.ok(content.includes('#683'), 'step 0.5 must cross-reference #683');
  });

  test('step 0.5 mentions worktree.baseRef:"head" as permanent fix', () => {
    const content = fs.readFileSync(WAVE_GUARD_PATH, 'utf-8');
    assert.ok(
      content.includes('worktree.baseRef') && content.includes('head'),
      'step 0.5 must mention worktree.baseRef:"head"'
    );
  });
});

describe('execute-phase: between-wave manifest reset (#1369, #3384)', () => {
  test('between-wave reference file exists', () => {
    assert.ok(fs.existsSync(BETWEEN_WAVE_PATH), 'references/execute-phase-between-wave-reset.md should exist');
  });

  test('workflow contains @-reference pointer to between-wave-reset', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    assert.ok(
      content.includes('execute-phase-between-wave-reset.md'),
      'execute-phase.md must have an @-reference to execute-phase-between-wave-reset.md'
    );
  });

  test('step 7c exists with between-wave manifest reset (#1369)', () => {
    const content = fs.readFileSync(BETWEEN_WAVE_PATH, 'utf-8');
    assert.ok(
      content.includes('7c.') && content.includes('Between-wave manifest reset'),
      'execute-phase-between-wave-reset.md must have step 7c "Between-wave manifest reset"'
    );
  });

  test('step 7c unsets WAVE_WORKTREE_MANIFEST between waves', () => {
    const content = fs.readFileSync(BETWEEN_WAVE_PATH, 'utf-8');
    assert.ok(content.includes('unset WAVE_WORKTREE_MANIFEST'), 'step 7c must unset WAVE_WORKTREE_MANIFEST');
  });

  test('step 7c references #1369 and #3384 for traceability', () => {
    const content = fs.readFileSync(BETWEEN_WAVE_PATH, 'utf-8');
    assert.ok(content.includes('#1369'), 'step 7c must reference #1369');
    assert.ok(content.includes('#3384'), 'step 7c must reference #3384');
  });

  test('step 7c runs the mode-threaded base-check and does NOT re-assert set-baseref (#3659)', () => {
    // The former pin required the set-baseref re-assert, whose stated mechanism
    // (#1369: "so the Claude Code harness re-reads the live HEAD") was fiction at
    // the time (#48; upstream claude-code#44965). The harness honors the setting
    // now (#4588), but the re-assert stays dead for its own reason: a setting
    // already in place needs no re-write between waves, and one deliberately
    // absent must not be re-imposed. The between-wave re-check threads --mode.
    const content = fs.readFileSync(BETWEEN_WAVE_PATH, 'utf-8');
    assert.ok(content.includes('worktree.base-check --mode "$ISOLATION"'),
      'step 7c must thread the isolation mode through the base-check');
    assert.ok(!content.includes('worktree.set-baseref'),
      'step 7c must not re-assert set-baseref — a re-write between waves changes nothing (#3659/#4588)');
  });

  test('step 7c appears after step 7b and before step 8 in the wave loop', () => {
    const ref = fs.readFileSync(BETWEEN_WAVE_PATH, 'utf-8');
    const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    const idx7b = ref.indexOf('7b.');
    const idx7c = ref.indexOf('7c.');
    const refPtr = workflow.indexOf('execute-phase-between-wave-reset.md');
    const idx8 = workflow.indexOf('8. **Execute checkpoint', refPtr);
    assert.ok(idx7b !== -1, 'step 7b must exist in between-wave reference file');
    assert.ok(idx7c !== -1, 'step 7c must exist in between-wave reference file');
    assert.ok(idx8 !== -1, 'step 8 must exist in execute-phase.md after the between-wave @-reference');
    assert.ok(idx7b < idx7c, 'step 7c must appear after step 7b');
    assert.ok(refPtr < idx8, 'between-wave @-reference must appear before step 8');
  });

  // #2652: see the step 0.5 note above — migrated from the runtime-name premise to
  // the negotiated dispatch.isolation capability.
  test('step 7c guards on the negotiated capability, not a runtime id', () => {
    const content = fs.readFileSync(BETWEEN_WAVE_PATH, 'utf-8');
    assert.ok(
      content.includes('ISOLATION') && content.includes('harness-worktree'),
      'step 7c must guard on ISOLATION = harness-worktree'
    );
    assert.ok(
      !/\[\s*"\$RUNTIME"\s*=/.test(content),
      'step 7c must NOT branch on a RUNTIME literal (#2584/#2652)'
    );
    assert.ok(
      content.includes('ISOLATION=none'),
      'degrade must clear ISOLATION as well as USE_WORKTREES — dispatch reads ISOLATION (#2652)'
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3096-ai-integration-phase-parallel-race.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3096-ai-integration-phase-parallel-race (consolidation epic #1969 B4 #1973)", () => {
'use strict';
// allow-test-rule: source-text-is-the-product (see #3096)
// Reads product workflow markdown (ai-integration-phase.md) to verify
// structural ordering contract.

// Regression guard for bug #3096.
//
// ai-integration-phase.md listed Steps 7+8 (gsd-ai-researcher +
// gsd-domain-researcher) without an explicit sequential ordering constraint.
// An orchestrator optimizing for speed could reasonably parallelize them
// since the sections appeared disjoint. When parallelized, gsd-domain-researcher's
// Write call at finalization replaced the whole AI-SPEC.md file with its
// in-memory copy (pre-researcher state), silently overwriting Sections 3/4.
//
// Confirmed at 40% incidence rate on a real run (2 of 5 worktree agents hit it).
// Recovery cost: one extra ai-researcher dispatch (~18 min wall).
//
// Fix:
//   1. Explicit "MUST run sequentially" note on Steps 7 and 8
//   2. Edit-only tool discipline injected into both agent prompts

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(
  path.join(ROOT, 'gsd-core', 'workflows', 'ai-integration-phase.md'),
  'utf8',
);

describe('bug #3096: ai-integration-phase sequential ordering and Edit-only discipline', () => {
  test('Step 7 documents sequential ordering requirement', () => {
    assert.ok(
      src.includes('sequentially') || src.includes('sequential'),
      'Steps 7+8 ordering note is missing — parallel dispatch race can recur',
    );
  });

  test('Step 7 gsd-ai-researcher prompt includes Edit-only tool discipline', () => {
    // The discipline block must appear before </objective> for gsd-ai-researcher
    const step7Idx = src.indexOf('## 7. Spawn gsd-ai-researcher');
    const step8Idx = src.indexOf('## 8. Spawn gsd-domain-researcher');
    assert.ok(step7Idx !== -1, 'Step 7 not found');
    assert.ok(step8Idx !== -1, 'Step 8 not found');
    const step7Block = src.slice(step7Idx, step8Idx);
    assert.ok(
      step7Block.includes('Edit tool') && step7Block.includes('NEVER use Write'),
      'Step 7 agent prompt missing Edit-only tool discipline',
    );
  });

  test('Step 8 gsd-domain-researcher prompt includes Edit-only tool discipline', () => {
    const step8Idx = src.indexOf('## 8. Spawn gsd-domain-researcher');
    const step9Idx = src.indexOf('## 9. Spawn gsd-eval-planner');
    assert.ok(step8Idx !== -1, 'Step 8 not found');
    assert.ok(step9Idx !== -1, 'Step 9 not found');
    const step8Block = src.slice(step8Idx, step9Idx);
    assert.ok(
      step8Block.includes('Edit tool') && step8Block.includes('NEVER use Write'),
      'Step 8 agent prompt missing Edit-only tool discipline',
    );
  });

  test('Step 8 references the wait instruction', () => {
    const step8Idx = src.indexOf('## 8. Spawn gsd-domain-researcher');
    const step9Idx = src.indexOf('## 9. Spawn gsd-eval-planner');
    const step8Block = src.slice(step8Idx, step9Idx);
    assert.ok(
      step8Block.includes('Wait') || step8Block.includes('wait') || step8Block.includes('complete'),
      'Step 8 does not instruct orchestrator to wait for Step 7',
    );
  });
});
  });
}

// ─── Issue #3210: auto-mode carve-out exempts precondition-unmet checkpoints ─
//
// The checkpoint_handling auto-spawn rule dispatched on checkpoint type alone;
// a checkpoint returned because a task's <precondition> was unmet would have
// been auto-approved with a synthetic "approved" — re-approving the very
// checkpoint the executor refused to auto-approve (it reports Gate:
// blocking-human). This file owns the execute-phase.md host-workflow contract.

describe('issue #3210: execute-phase auto-mode carve-out exempts precondition-unmet checkpoints', () => {
  test('the checkpoint_handling auto-spawn rule names precondition-unmet checkpoints', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    const open = content.indexOf('<step name="checkpoint_handling">');
    assert.ok(open !== -1, 'checkpoint_handling step not found');
    const close = content.indexOf('</step>', open);
    const step = content.slice(open, close);
    const splitLines = require('../gsd-core/bin/lib/text-lines.cjs').splitLines;
    const carveOut = splitLines(step).find((l) => l.includes('Carve-out'));
    assert.ok(carveOut, 'checkpoint_handling must keep the blocking-human carve-out');
    assert.match(
      carveOut,
      /precondition/i,
      'the auto-mode carve-out must state that a precondition-unmet checkpoint reports ' +
      'blocking-human and is never auto-approved (#3210)'
    );
  });
});

// ─── #3684 — verified-but-never-marked-complete resume ───────────────────────
//
// #2868 covered stranding BEFORE verification; the symmetric gap one step later
// (VERIFICATION.md written, run died before update_roadmap) made condition 3's
// "genuinely finished" bullet exit cleanly forever — the phase stays verified on
// disk but permanently unticked, with update_roadmap / auto_copy_learnings /
// close_phase_todos / the transition handoff never running. The fix: that branch
// reads the ROADMAP's own completion marker (roadmap.analyze's roadmap_complete —
// the #2245-hardened, #3537-padding-tolerant read; NEVER a completion report
// field, which #3685 shows can claim a write that didn't happen) and resumes at
// update_roadmap when the marker is unticked, without redoing verification.

describe('execute-phase workflow: #3684 verified-unmarked resume', () => {
  function stepText() {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    const start = content.indexOf('<step name="discover_and_group_plans">');
    const end = content.indexOf('</step>', start);
    return content.slice(start, end);
  }

  test('condition 3 reads the roadmap marker, not VERIFY_STATUS alone', () => {
    const step = stepText();
    assert.ok(
      /roadmap\.analyze/.test(step),
      'the finished branch must query roadmap.analyze for the completion marker',
    );
    assert.ok(
      /roadmap_complete/.test(step),
      'the finished branch must read roadmap_complete — the authoritative checkbox state',
    );
    // Report fields may be NAMED in the prohibition prose — what is
    // forbidden is reading them as the signal (a command/jq consumption).
    const branchBash = step.split('\n').filter((l) => /jq|gsd_run|pick/.test(l)).join('\n');
    assert.ok(
      !/roadmap_updated|state_updated/.test(branchBash),
      'completion report fields must never be READ as the already-complete signal (#3685)',
    );
  });

  test('verified-unmarked resume continues at update_roadmap', () => {
    const step = stepText();
    // #5118: the arm is keyed on `passed` — the old `≠ missing` arm collapsed
    // gaps_found / human_needed / unparseable into "verified" (#4765).
    // #6096: the arm is the `update-roadmap` decision, which the code computes from a fresh `passed` report and
    // an unmarked phase (the #6096 block of tests/verification-status.test.cjs pins the computation).
    const anchor = '**`update-roadmap`**';
    assert.ok(step.includes(anchor), 'the verified-unmarked arm must be the update-roadmap decision');
    const branch = step.slice(step.indexOf(anchor));
    assert.ok(
      branch.includes('update_roadmap'),
      'the unmarked-resume branch must continue at update_roadmap',
    );
    assert.ok(
      /not.*redo|do not redo|without redoing|verification already|already exists/i.test(branch),
      'the branch must state verification is not redone',
    );
    assert.ok(
      branch.includes('#3684'),
      'the branch must cite #3684',
    );
  });

  test('genuinely-finished exit and the 2868 branch are unchanged', () => {
    const step = stepText();
    assert.ok(
      step.includes('"No matching incomplete plans"'),
      'the genuinely-finished clean exit text stays',
    );
    assert.ok(
      /`VERIFY_STATUS == missing`/.test(step),
      'the #2868 missing-verification branch stays',
    );
    assert.ok(
      step.includes('resuming at the phase gates (#2868)'),
      'the #2868 resume message stays byte-recognizable',
    );
  });

  function buildStrandedFixture(t, { ticked }) {
    const proj = createTempProject('gsd-3684-');
    t.after(() => cleanup(proj));
    const phaseDir = path.join(proj, '.planning', 'phases', '01-alpha');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, 'P001-PLAN.md'), [
      '---', 'wave: 1', 'objective: Do the thing', 'autonomous: true', 'depends_on: []', '---', '',
      '# Plan 001', '', '<objective>Do the thing</objective>', '', '<task>Do it</task>',
    ].join('\n'));
    fs.writeFileSync(path.join(phaseDir, 'P001-SUMMARY.md'), '# Summary\nDone.\n');
    fs.writeFileSync(path.join(phaseDir, '01-alpha-VERIFICATION.md'), [
      '---', 'status: passed', '---', '', '# Verification', '', 'PASS',
    ].join('\n'));
    // Heading-shaped ROADMAP (analyze's parser keys on "### Phase N:" under
    // a sections heading); the checkbox line carries the marked-complete
    // marker roadmap_complete reads (- [x]/**Phase 1** vs - [ ]).
    fs.writeFileSync(path.join(proj, '.planning', 'ROADMAP.md'), [
      '# Roadmap v1.0', '', '## Phases', '',
      '### Phase 1: Alpha', '**Goal:** First phase', '',
      `- [${ticked ? 'x' : ' '}] **Phase 1: Alpha** - First phase`, '',
    ].join('\n'));
    return { proj, phaseDir };
  }

  test('routing queries yield passed + unmarked on the stranded fixture', (t) => {
    const { proj } = buildStrandedFixture(t, { ticked: false });
    const verify = runGsdTools(`verification status ${path.join(proj, '.planning', 'phases', '01-alpha')} --pick status`, proj);
    const analyze = runGsdTools(['roadmap.analyze', '--json'], proj);
    assert.ok(analyze.success, `roadmap.analyze should succeed: ${analyze.error}`);
    const phases = JSON.parse(analyze.output).phases || [];
    const p1 = phases.find((p) => String(p.number) === '1');
    assert.ok(p1, `phase 1 should appear in analyze output: ${JSON.stringify(phases)}`);
    assert.equal(p1.roadmap_complete, false, 'unticked checkbox must read as not complete');
    // The step's decision inputs: VERIFY_STATUS != missing AND !PHASE_MARKED →
    // the #3684 resume route, not the finished exit.
    assert.ok(verify.success, `verification status query should succeed: ${verify.error}`);
    assert.notEqual(String(verify.output).trim(), 'missing', 'the stranded fixture has a verification artifact');
  });

  test('routing queries yield marked after completion', (t) => {
    const { proj } = buildStrandedFixture(t, { ticked: true });
    const analyze = runGsdTools(['roadmap.analyze', '--json'], proj);
    const phases = JSON.parse(analyze.output).phases || [];
    const p1 = phases.find((p) => String(p.number) === '1');
    assert.ok(p1, 'phase 1 should appear');
    assert.equal(p1.roadmap_complete, true, 'ticked checkbox must read as complete');
  });

  test('phase.complete is idempotent on the already-complete fixture', (t) => {
    const { proj } = buildStrandedFixture(t, { ticked: false });
    const first = runGsdTools('phase complete 1', proj);
    assert.ok(first.success, `first completion should succeed: ${first.error}`);
    const roadmapAfterFirst = fs.readFileSync(path.join(proj, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(/\[x\]/.test(roadmapAfterFirst), 'first completion ticks the checkbox');
    const second = runGsdTools('phase complete 1', proj);
    assert.ok(second.success, 'second completion should succeed (no-op)');
    const roadmapAfterSecond = fs.readFileSync(path.join(proj, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.equal(roadmapAfterSecond, roadmapAfterFirst, 'second run must leave ROADMAP byte-identical (criterion 3)');
  });
});

describe('execute-phase workflow: #3684 review findings — join normalization', () => {
  const WORKFLOW_JQ_RE = /PHASE_MARKED=\$\(echo "\$ANALYZE"\|jq -r --arg p "\$PHASE_NUMBER" '([^']+)'\|head -1\)/;

  function extractWorkflowJq() {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    const m = content.match(WORKFLOW_JQ_RE);
    assert.ok(m, 'the workflow must carry the PHASE_MARKED jq line');
    return m[1];
  }

  test('the join key is padding-normalized on both sides (drifted shapes route correctly)', (t) => {
    // The join must tolerate the real-world drift every other resolver in the
    // pipeline tolerates (#3537/#3572/#2528): directory token "01" vs ROADMAP
    // heading "1" and vice versa. An exact-string compare misroutes a
    // verified AND ticked phase into the resume branch forever — the same
    // "permanently stuck" shape #3684 exists to fix, one level up.
    const jqFilter = extractWorkflowJq();
    assert.ok(
      /sub\("\^0\+\(\?=\[0-9\]\)";""\)/.test(jqFilter),
      `the jq must strip leading zeros on both sides: ${jqFilter}`,
    );

    const proj = createTempProject('gsd-3684-pad-');
    t.after(() => cleanup(proj));
    const phaseDir = path.join(proj, '.planning', 'phases', '01-alpha');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, 'P001-SUMMARY.md'), '# Summary\n');
    // Heading UNPADDED while the directory token is PADDED — the drifted shape.
    fs.writeFileSync(path.join(proj, '.planning', 'ROADMAP.md'), [
      '# Roadmap v1.0', '', '## Phases', '',
      '### Phase 1: Alpha', '**Goal:** g', '',
      '- [x] **Phase 1: Alpha** - done', '',
    ].join('\n'));

    const analyze = runGsdTools('roadmap.analyze --json', proj);
    assert.ok(analyze.success, `roadmap.analyze should succeed: ${analyze.error}`);
    // Evaluate the extracted filter's join semantics via a node mirror of
    // `sub("^0+(?=[0-9])";"")` — the bench hosts no jq binary, so the
    // filter string itself is pinned structurally above and its normalization
    // semantics are replayed here against real analyze output.
    const stripPad = (s) => String(s).replace(/^0+(?=[0-9])/, '');
    const phases = JSON.parse(analyze.output).phases || [];
    const evalJoin = (p) => {
      const hit = phases.find((ph) => stripPad(ph.number ?? ph.phase_number) === stripPad(p));
      return hit ? String(hit.roadmap_complete) : '';
    };
    // $p as init derives it (directory token "01") and the unpadded form —
    // both must find the ticked phase under the unpadded heading.
    for (const p of ['01', '1']) {
      assert.equal(evalJoin(p), 'true', `padded $p=${p} must match the unpadded heading`);
    }
  });

  test('idempotency row carries STATE.md and tolerates only the last_updated delta', (t) => {
    // Criterion 3 says "no observable change to roadmap OR tracked progress
    // state". The ROADMAP half is byte-identity; the STATE half legitimately
    // touches only last_updated (the transition runs unconditionally — the
    // triage's own empirical finding). Assert both halves explicitly.
    const proj = createTempProject('gsd-3684-state-');
    t.after(() => cleanup(proj));
    const phaseDir = path.join(proj, '.planning', 'phases', '01-alpha');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, 'P001-PLAN.md'), [
      '---', 'wave: 1', 'objective: x', 'autonomous: true', 'depends_on: []', '---', '', '# P', '',
      '<objective>x</objective>', '', '<task>t</task>',
    ].join('\n'));
    fs.writeFileSync(path.join(phaseDir, 'P001-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phaseDir, '01-alpha-VERIFICATION.md'), '---\nstatus: passed\n---\n');
    fs.writeFileSync(path.join(proj, '.planning', 'ROADMAP.md'), [
      '# Roadmap v1.0', '', '## Phases', '',
      '### Phase 1: Alpha', '**Goal:** g', '',
      '- [ ] **Phase 1: Alpha** - todo', '',
    ].join('\n'));
    fs.writeFileSync(path.join(proj, '.planning', 'STATE.md'), [
      '---', 'current_phase: 1', 'current_phase_name: Alpha', 'status: executing', '',
      'last_updated: 2026-01-01', '---', '', '# STATE', '',
    ].join('\n'));

    const first = runGsdTools('phase complete 1', proj);
    assert.ok(first.success, `first completion should succeed: ${first.error}`);
    const roadmap1 = fs.readFileSync(path.join(proj, '.planning', 'ROADMAP.md'), 'utf-8');
    const state1 = fs.readFileSync(path.join(proj, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(/\[x\]/.test(roadmap1), 'first completion ticks the checkbox');

    const second = runGsdTools('phase complete 1', proj);
    assert.ok(second.success, 'second completion should succeed');
    const roadmap2 = fs.readFileSync(path.join(proj, '.planning', 'ROADMAP.md'), 'utf-8');
    const state2 = fs.readFileSync(path.join(proj, '.planning', 'STATE.md'), 'utf-8');
    assert.equal(roadmap2, roadmap1, 'ROADMAP byte-identical on re-run');
    // Characterized delta (empirically pinned): a re-run never rewrites or
    // removes existing STATE content — it may only refresh the last_updated
    // stamp and ADD metrics keys the first run withheld (percent: the #3318
    // withhold lifts once the scope reads complete). Assert state2 is an
    // ordered superset of state1 modulo the stamp.
    const keep = (s) => s.split('\n').filter((l) => !/^last_updated:/.test(l));
    const lines1 = keep(state1);
    const lines2 = keep(state2);
    let i2 = 0;
    for (const line of lines1) {
      const at = lines2.indexOf(line, i2);
      assert.ok(at !== -1, `re-run must not rewrite STATE content; missing after ${i2}: ${line}`);
      i2 = at + 1;
    }
  });
});

// ── #4218: a live executor must not be steered or cut short ──────────────────
//
// allow-test-rule: source-text-is-the-product (#4218) — the workflow .md IS
// the instruction the orchestrator executes; its text is the artifact under test.
//
// Reported on Codex: an executor with recent RED/GREEN/REFACTOR commits and
// passing verification had not yet written its SUMMARY because it was finishing
// closeout. The parent saw no local OS test/build process, inferred an "idle
// tail", and sent "Finalize immediately" into a working child. In CLI runs the
// same inference interrupted an executor before GREEN, leaving a RED commit and
// an uncommitted edit.
//
// The policy lives in a step fragment: execute-phase.md is 77 bytes under the
// frozen #1168 ceiling, and "extract, not bump" is the repo's stated remedy.
describe('execute-phase: stall surveillance must not steer a working executor (#4218)', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
  const FRAGMENT_PATH = path.join(
    __dirname, '..', 'gsd-core', 'workflows', 'execute-phase', 'steps', 'executor-progress-policy.md');
  const fragment = fs.existsSync(FRAGMENT_PATH) ? fs.readFileSync(FRAGMENT_PATH, 'utf-8') : '';

  test('the host routes to the policy before treating an executor as stalled', () => {
    assert.match(workflow, /A working executor is never steered \(#4218\)/,
      'the verdict must be visible where the orchestrator decides, not only in the fragment');
    assert.match(workflow, /time WITHOUT\s{1,10}PROGRESS, not total runtime/,
      'the threshold definition is the correction — it belongs in the host');
    assert.match(workflow, /before sending it\s{1,10}any message/,
      'the steering prohibition must be reachable before a message is sent, not after');
    assert.match(workflow, /execute-phase\/steps\/executor-progress-policy\.md/,
      'the host must point at the policy fragment');
  });

  test('the stall threshold is a period without progress, not a maximum runtime', () => {
    assert.ok(fragment.length > 0, 'execute-phase/steps/executor-progress-policy.md must exist');
    assert.match(fragment, /period \*\*without meaningful progress\*\*/,
      'the threshold must be defined by absence of progress');
    assert.match(fragment, /not a maximum\s{1,10}total runtime/,
      'a long-but-progressing plan must not be treated as stalled');
    assert.match(fragment, /from the LAST sign of progress, not from dispatch/,
      'measuring from dispatch is what turns a slow plan into a false stall');
  });

  test('commits + missing SUMMARY + recent activity resolves to KEEP WAITING', () => {
    assert.match(fragment, /KEEP\s{1,10}WAITING/, 'the verdict for a working executor must be explicit');
    assert.match(fragment, /Do not steer it, do not interrupt it, do not re-dispatch it/,
      'all three interventions the report describes must be named and forbidden');
  });

  test('urgency and finalization messages are forbidden outright', () => {
    assert.match(fragment, /Never inject urgency or finalization instructions into a live executor/,
      'the prohibition must be stated as a rule, not implied');
    assert.match(fragment, /Finalize immediately/,
      'the reported message must be named so it cannot be read as permitted');
  });

  test('a missing local OS process is not evidence of idleness', () => {
    assert.match(fragment, /absence of a local OS test\/build process is NOT idleness/,
      'the false signal the orchestrator acted on must be ruled out by name');
    assert.match(fragment, /A process listing is not one of them/,
      'the workflow must say which signals DO count, and that a process listing is not one');
  });

  test('the only sanctioned stop is the existing user-facing pause', () => {
    assert.match(fragment, /the pause in step 3 is the only route/,
      'stopping an executor must stay a user decision, not an orchestrator nudge');
    assert.match(fragment, /`kill and retry` is a\s{1,10}clean restart — not a nudge/,
      'the distinction between restarting and steering must be explicit');
  });

  test('the worktree-recovery arm moved with the policy, not left duplicated', () => {
    assert.match(fragment, /If a stalled executor ran in an isolated worktree/,
      'the recovery arm belongs with the stop policy it qualifies');
    assert.match(fragment, /worktree-recovery-policy\.md/,
      'it must still hand off to the worktree policy');
    assert.ok(
      !/kill and switch to inline execution` edits the primary checkout/.test(workflow),
      'the host must not keep a second copy of the arm that moved',
    );
    // The #3212 recovery options themselves stay in the host — tests/config.test.cjs
    // pins them there.
    for (const option of ['continue waiting', 'kill and retry', 'kill and switch to inline execution']) {
      assert.ok(workflow.includes(option), `the host must still offer "${option}"`);
    }
  });
});

// ─── #6102 — shared requirements in a parallel worktree wave are marked after the merge ───────────────────
//
// A worktree executor's `update_requirements` gate sees only its own SUMMARY, so a requirement ID declared by two
// plans of one wave is blocked in every executor and none marks it. The orchestrator's post-wave step evaluates
// the same gate once on the merged tree. The real fence of the step fragment runs here against a real project,
// real `requirements ready-ids` / `mark-complete` / `commit`, with only `jq` replaced (the Tester Image has none).
{
const { spawnSync: spawnPostWave } = require('node:child_process');
const { createTempGitProject: postWaveProject, cleanup: postWaveCleanup, TOOLS_PATH: POST_WAVE_TOOLS } = require('./helpers.cjs');
const { HOOK_FANOUT_TIMEOUT_MS: POST_WAVE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { splitLines: postWaveSplitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const FRAGMENT = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase', 'steps', 'post-wave-requirements.md');

// The two filters the fence uses, with jq's semantics for them; any other filter fails loudly.
const JQ_STUB = [
  'const f = process.argv[process.argv.length - 1];',
  "let s = ''; process.stdin.on('data', (d) => { s += d; }).on('end', () => {",
  '  const doc = JSON.parse(s);',
  "  const table = { '.requirements[]?': doc.requirements, '.ready[]': doc.ready };",
  '  if (!Object.prototype.hasOwnProperty.call(table, f)) { process.stderr.write("jq stub: unsupported filter " + f); process.exit(3); }',
  "  for (const v of table[f] || []) process.stdout.write(v + '\\n');",
  '});',
].join('\n');

function fenceOf() {
  const text = fs.readFileSync(FRAGMENT, 'utf8');
  const open = text.indexOf('```bash\n');
  assert.ok(open >= 0, 'the fragment must carry its bash fence');
  const close = text.indexOf('\n```', open + 8);
  // the launcher preamble `sync-runtime-launcher` prepends defines the real `gsd_run`; the test supplies its own
  return postWaveSplitLines(text.slice(open + 8, close)).filter((line) => !line.startsWith('_GSD_SHIM_NAME=')).join('\n');
}

// Plan layouts the orchestrator meets: root plans named by stem, and a slug id plus a nested `plans/PLAN-<n>.md`.
const POST_WAVE_LAYOUTS = {
  root: { one: { id: '01-01', plan: '01-01-PLAN.md', summary: '01-01-SUMMARY.md' }, two: { id: '01-02', plan: '01-02-PLAN.md', summary: '01-02-SUMMARY.md' } },
  slugAndNested: {
    one: { id: '01-01-api', plan: '01-01-api-PLAN.md', summary: '01-01-api-SUMMARY.md' },
    two: { id: 'plans/PLAN-2.md', plan: 'plans/PLAN-2.md', summary: 'plans/SUMMARY-2.md' },
  },
};

function waveFixture(t, { summaries, layout = 'root' }) {
  const proj = postWaveProject();
  t.after(() => postWaveCleanup(proj));
  const phaseDir = path.join(proj, '.planning', 'phases', '01-alpha');
  fs.mkdirSync(path.join(phaseDir, 'plans'), { recursive: true });
  const { one, two } = POST_WAVE_LAYOUTS[layout];
  const plan = (n, reqs) => `---\nphase: 01-alpha\nplan: ${n}\nwave: 1\nrequirements: [${reqs}]\n---\n# Plan ${n}\n`;
  fs.writeFileSync(path.join(phaseDir, one.plan), plan('01', 'REQ-01, REQ-02'));
  fs.writeFileSync(path.join(phaseDir, two.plan), plan('02', 'REQ-01'));
  for (const n of summaries) fs.writeFileSync(path.join(phaseDir, n === '01' ? one.summary : two.summary), '# Summary\n');
  fs.writeFileSync(path.join(proj, '.planning', 'REQUIREMENTS.md'), [
    '# Requirements', '', '- [ ] **REQ-01**: shared by both plans', '- [ ] **REQ-02**: plan one only', '',
    '## Traceability', '', '| Requirement | Phase | Status |', '|---|---|---|',
    '| REQ-01 | Phase 1 | Pending |', '| REQ-02 | Phase 1 | Pending |', '',
  ].join('\n'));
  fs.writeFileSync(path.join(proj, '.planning', 'ROADMAP.md'), '# Roadmap\n\n### Phase 1: Alpha\n\n**Goal**: g\n');
  fs.writeFileSync(path.join(proj, '.planning', 'config.json'), '{}');
  gitInProject(proj, ['add', '-A']);
  gitInProject(proj, ['commit', '-q', '-m', 'seed']);
  return { proj, phaseDir };
}
function gitInProject(proj, args) {
  const r = spawnPostWave('git', args, { cwd: proj, encoding: 'utf8', timeout: POST_WAVE_TIMEOUT_MS });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function runFence(proj, phaseDir, testExit, wavePlanIds = '01-01 01-02') {
  // the fence loops over `{completed_plan_ids}`: the orchestrator writes the completed plans out as a literal list
  const requirementsPath = path.join(proj, '.planning', 'REQUIREMENTS.md');
  const script = [
    `gsd_run() { node '${POST_WAVE_TOOLS}' "$@"; }`,
    `jq() { node -e '${JQ_STUB.replace(/'/g, "'\\''")}' -- "$@"; }`,
    `TEST_EXIT=${testExit} PHASE_DIR='${phaseDir}' PHASE_NUMBER=1 N=1`,
    fenceOf().split('{requirements_path}').join(requirementsPath).split('{completed_plan_ids}').join(wavePlanIds),
  ].join('\n');
  const r = spawnPostWave('bash', ['-c', script], { cwd: proj, encoding: 'utf8', timeout: POST_WAVE_TIMEOUT_MS });
  assert.equal(r.status, 0, `the fence must run clean: ${r.stderr}`);
  const text = fs.readFileSync(requirementsPath, 'utf8');
  return (id) => new RegExp(`- \\[x\\] \\*\\*${id}\\*\\*`).test(text);
}

describe('#6102: the orchestrator marks shared requirements complete once the wave has merged', () => {
  test('two plans declaring the same ID, both summarized: the shared ID and the single-plan ID are marked and committed', (t) => {
    const { proj, phaseDir } = waveFixture(t, { summaries: ['01', '02'] });
    const marked = runFence(proj, phaseDir, 0);
    assert.equal(marked('REQ-01'), true, 'the shared ID is complete');
    assert.equal(marked('REQ-02'), true, 'the single-plan ID is complete');
    assert.match(gitInProject(proj, ['log', '-1', '--format=%s']), /mark shared requirements complete after wave 1/);
    assert.equal(gitInProject(proj, ['status', '--porcelain', '--', '.planning/REQUIREMENTS.md']).trim(), '', 'the marked file is committed');
  });

  test('an ID with a declaring plan that has no summary is not marked; the ready ID still is', (t) => {
    // WAVE_PLAN_IDS lists the plans that COMPLETED in the wave: plan 02 produced no summary, so it is not in it
    const { proj, phaseDir } = waveFixture(t, { summaries: ['01'] });
    const marked = runFence(proj, phaseDir, 0, '01-01');
    assert.equal(marked('REQ-01'), false, 'plan 02 has no summary yet');
    assert.equal(marked('REQ-02'), true);
  });

  test('a slug plan id and a nested plan path resolve to their plan files: the shared ID is marked', (t) => {
    const { proj, phaseDir } = waveFixture(t, { summaries: ['01', '02'], layout: 'slugAndNested' });
    const marked = runFence(proj, phaseDir, 0, '01-01-api plans/PLAN-2.md');
    assert.equal(marked('REQ-01'), true, 'the shared ID is complete');
    assert.equal(marked('REQ-02'), true, 'the single-plan ID is complete');
  });

  test('a completed plan whose file cannot be found is skipped, never aborting the pass', (t) => {
    const { proj, phaseDir } = waveFixture(t, { summaries: ['01', '02'] });
    const marked = runFence(proj, phaseDir, 0, '09-99 01-01 01-02');
    assert.equal(marked('REQ-01'), true, 'the plans that exist are still settled');
    assert.equal(marked('REQ-02'), true);
  });

  test('nothing is marked when the post-merge tests failed or timed out', (t) => {
    for (const testExit of [1, 124]) {
      const { proj, phaseDir } = waveFixture(t, { summaries: ['01', '02'] });
      const marked = runFence(proj, phaseDir, testExit);
      assert.equal(marked('REQ-01') || marked('REQ-02'), false, `TEST_EXIT=${testExit}`);
      assert.equal(gitInProject(proj, ['log', '-1', '--format=%s']).trim(), 'seed', 'no commit either');
    }
  });

  test('a gaps_found revert still reverts what the post-wave pass marked', (t) => {
    const { proj, phaseDir } = waveFixture(t, { summaries: ['01', '02'] });
    runFence(proj, phaseDir, 0);
    const revert = spawnPostWave('node', [POST_WAVE_TOOLS, 'query', 'requirements.revert-phase', 'REQ-01', 'REQ-02'], { cwd: proj, encoding: 'utf8', timeout: POST_WAVE_TIMEOUT_MS });
    assert.equal(revert.status, 0, revert.stderr);
    const text = fs.readFileSync(path.join(proj, '.planning', 'REQUIREMENTS.md'), 'utf8');
    assert.equal(/- \[x\] \*\*REQ-0[12]\*\*/.test(text), false, 'both IDs are unchecked again');
  });

  test('the host step and execute-plan point at the fragment, and execute-plan no longer promises a worktree re-evaluation', () => {
    const host = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    assert.ok(host.includes('execute-phase/steps/post-wave-requirements.md'), 'step 5.7 must read the fragment');
    const executePlan = fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-plan.md'), 'utf-8');
    assert.ok(executePlan.includes('in the same tree'), 'the re-evaluation claim is qualified to one tree');
    assert.ok(executePlan.includes('post-wave-requirements.md'), 'execute-plan names the orchestrator pass that settles worktree-mode shared IDs');
  });
});
}

// ─── #6117 — the stall check sees a worktree executor's commits before the wave merges ──────────────────────
//
// An `isolation="worktree"` executor commits to its own unmerged agent branch, so the `${EXPECTED_BRANCH}` probe read
// no progress from a working executor and the stall pause fired. The progress policy asks the evaluation-scope
// resolver for the plan's commits across every local branch. The real fence runs here against a real git repository
// with the variables the ORCHESTRATOR has (`PHASE_NUMBER`, `DISPATCH_TS`, and the `{plan_padded}` placeholder it
// substitutes): an executor that has committed on an agent branch after dispatch is progress; one that has not, one
// whose only commits predate dispatch, and a different plan's commits are not. Every date is fixed, so no assertion
// depends on the clock.
{
const { spawnSync: spawnStall } = require('node:child_process');
const { createTempGitProject: stallProject, cleanup: stallCleanup, TOOLS_PATH: STALL_TOOLS } = require('./helpers.cjs');
const { HOOK_FANOUT_TIMEOUT_MS: STALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { splitLines: stallSplitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const POLICY = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase', 'steps', 'executor-progress-policy.md');
const POLICY_HEADING = "## A `harness-worktree` executor's commits are not on the expected branch (#6117)";

function probeFence() {
  const text = fs.readFileSync(POLICY, 'utf8');
  const heading = text.indexOf(POLICY_HEADING);
  assert.ok(heading >= 0, 'the progress policy must carry the #6117 section');
  const open = text.indexOf('```bash\n', heading);
  assert.ok(open >= 0, 'the #6117 section must carry the probe fence');
  // the launcher preamble `sync-runtime-launcher` prepends defines the real `gsd_run`; the test supplies its own
  return stallSplitLines(text.slice(open + 8, text.indexOf('\n```', open + 8))).filter((line) => !line.startsWith('_GSD_SHIM_NAME=')).join('\n');
}

function stallGit(proj, args, env = {}) {
  const r = spawnStall('git', args, { cwd: proj, encoding: 'utf8', timeout: STALL_TIMEOUT_MS, env: { ...process.env, ...env } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** A commit on `branch` (created off the current HEAD when new) with `subject`, dated `iso` (always explicit). */
function commitOn(proj, branch, subject, iso) {
  const exists = spawnStall('git', ['rev-parse', '--verify', '-q', branch], { cwd: proj, timeout: STALL_TIMEOUT_MS }).status === 0;
  stallGit(proj, exists ? ['checkout', '-q', branch] : ['checkout', '-q', '-b', branch]);
  stallGit(proj, ['commit', '-q', '--allow-empty', '-m', subject], { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso });
}

const epoch = (iso) => Math.floor(Date.parse(iso) / 1000);
const DISPATCH = '2026-03-10T10:00:00Z';
const AFTER = '2026-03-10T10:07:00Z';
const LATER = '2026-03-10T10:09:30Z';
const BEFORE = '2026-03-10T09:00:00Z';

/** The fence as the orchestrator runs it: `{plan_padded}` substituted, the orchestrator's own variables set. */
function runProbe(proj, { dispatchTs = DISPATCH, plan = '01', phase = '08', gsdRun = null, fence = probeFence() } = {}) {
  const run = gsdRun ?? `gsd_run() { node '${STALL_TOOLS}' "$@"; }`;
  const script = [run, `DISPATCH_TS='${dispatchTs}' PHASE_NUMBER='${phase}'`, fence.split('{plan_padded}').join(plan), 'printf "%s" "$LAST_PLAN_COMMIT"'].join('\n');
  const r = spawnStall('bash', ['-c', script], { cwd: proj, encoding: 'utf8', timeout: STALL_TIMEOUT_MS });
  assert.equal(r.status, 0, `the probe must run clean: ${r.stderr}`);
  return r.stdout.trim();
}

describe('#6117: the stall probe counts a worktree executor\'s unmerged commits as progress', () => {
  function repo(t) {
    const proj = stallProject();
    t.after(() => stallCleanup(proj));
    stallGit(proj, ['checkout', '-q', '-b', 'orchestrator']);
    return proj;
  }

  test('a commit for the plan on an unmerged agent branch after dispatch is progress, at exactly its commit time', (t) => {
    const proj = repo(t);
    commitOn(proj, 'worktree-agent-abc', 'test(08-01): add failing tests', AFTER);
    stallGit(proj, ['checkout', '-q', 'orchestrator']);
    assert.equal(runProbe(proj), String(epoch(AFTER)));
    assert.equal(stallGit(proj, ['log', 'orchestrator', `--since=${DISPATCH}`, '--grep=(08-01)', '-F', '--oneline']).trim(), '', 'the expected-branch probe alone reads nothing');
  });

  test('the latest of several commits, on several agent branches, wins', (t) => {
    const proj = repo(t);
    commitOn(proj, 'worktree-agent-abc', 'test(08-01): first', AFTER);
    commitOn(proj, 'worktree-agent-def', 'feat(08-01): second', LATER);
    stallGit(proj, ['checkout', '-q', 'orchestrator']);
    assert.equal(runProbe(proj), String(epoch(LATER)));
  });

  test('no commit for the plan on any branch is no progress', (t) => {
    const proj = repo(t);
    commitOn(proj, 'worktree-agent-abc', 'feat(08-02): a different plan', AFTER);
    assert.equal(runProbe(proj), '');
  });

  test('commits that predate dispatch are no progress', (t) => {
    const proj = repo(t);
    commitOn(proj, 'worktree-agent-abc', 'feat(08-01): earlier work', BEFORE);
    assert.equal(runProbe(proj), '');
  });

  test('a commit made after dispatch is progress and one made before it is not, across the dispatch instant', (t) => {
    const proj = repo(t);
    commitOn(proj, 'worktree-agent-abc', 'feat(08-01): one second before', '2026-03-10T09:59:59Z');
    assert.equal(runProbe(proj), '', 'one second before dispatch');
    commitOn(proj, 'worktree-agent-abc', 'feat(08-01): one second after', '2026-03-10T10:00:01Z');
    assert.equal(runProbe(proj), String(epoch('2026-03-10T10:00:01Z')), 'one second after dispatch');
  });

  test('the plan token is matched as the whole plan: another phase and a longer plan number are not progress', (t) => {
    const proj = repo(t);
    commitOn(proj, 'worktree-agent-abc', 'feat(18-01): another phase', AFTER);
    commitOn(proj, 'worktree-agent-abc', 'feat(08-011): a longer plan number', AFTER);
    assert.equal(runProbe(proj), '', 'only `(08-01)` itself counts');
  });

  test('an unpadded phase number finds the padded subject', (t) => {
    const proj = repo(t);
    commitOn(proj, 'worktree-agent-abc', 'feat(08-01): padded subject', AFTER);
    assert.equal(runProbe(proj, { phase: '8' }), String(epoch(AFTER)), 'phase 8 finds the (08-01) subject');
  });

  test('a scope the resolver cannot read is no progress and never an error exit', (t) => {
    const proj = repo(t);
    commitOn(proj, 'worktree-agent-abc', 'feat(08-01): work', AFTER);
    assert.equal(runProbe(proj, { gsdRun: 'gsd_run() { return 69; }' }), '', 'the resolver reports unavailable');
    assert.equal(runProbe(proj, { gsdRun: 'gsd_run() { echo not-json; }' }), '', 'a non-JSON answer');
    assert.equal(runProbe(proj, { gsdRun: 'gsd_run() { return 127; }' }), '', 'a missing gsd_run');
    assert.equal(runProbe(proj, { dispatchTs: '$(touch injected)' }), '', 'an unsafe dispatch timestamp is refused by the resolver, not executed');
    assert.equal(fs.existsSync(path.join(proj, 'injected')), false, 'nothing was executed');
  });

  test('the resolver keeps the reachable-from-ref contract without --all-branches, and the flag is for plan and quick units only', (t) => {
    const proj = repo(t);
    commitOn(proj, 'worktree-agent-abc', 'test(08-01): add failing tests', AFTER);
    stallGit(proj, ['checkout', '-q', 'orchestrator']);
    const scope = (...args) => {
      const r = spawnStall('node', [STALL_TOOLS, 'check', 'evaluation-scope', ...args, '--raw'], { cwd: proj, encoding: 'utf8', timeout: STALL_TIMEOUT_MS });
      return { status: r.status, json: r.stdout.trim() === '' ? null : JSON.parse(r.stdout) };
    };
    const plain = scope('--plan', '08-01', '--commits-only');
    assert.equal(plain.json.commits.length, 0, 'the unmerged agent branch is not reachable from the orchestrator ref (#5164 contract)');
    assert.equal('latestCommitTime' in plain.json, false, 'the field exists only with --all-branches');
    const wide = scope('--plan', '08-01', '--commits-only', '--all-branches');
    assert.equal(wide.json.commits.length, 1);
    assert.equal(wide.json.latestCommitTime, epoch(AFTER));
    assert.equal(scope('--plan', '08-02', '--commits-only', '--all-branches').json.latestCommitTime, null, 'null when nothing matched');
    const quick = scope('--quick', '260310-abc', '--commits-only', '--all-branches');
    assert.equal(quick.json.latestCommitTime, null, 'quick units take the flag too');
    for (const args of [['--phase', '08', '--all-branches'], ['--plan', '08-01', '--all-branches', '--milestone-bound']]) {
      const r = spawnStall('node', [STALL_TOOLS, 'check', 'evaluation-scope', ...args, '--raw'], { cwd: proj, encoding: 'utf8', timeout: STALL_TIMEOUT_MS });
      assert.notEqual(r.status, 0, `${args.join(' ')} is a usage failure`);
    }
  });

  test('the step names the probe and the policy keeps the sequential probe and the three-option pause', () => {
    const host = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    assert.ok(host.includes('`harness-worktree` plan: plan commits on any branch, #6117'), 'step 4 names the worktree-isolation probe');
    assert.ok(host.includes('`continue waiting`, `kill and retry`, or'), 'the three-option pause is unchanged');
    const policy = fs.readFileSync(POLICY, 'utf8');
    assert.ok(policy.includes('plans on `none` (sequential) keep the `${EXPECTED_BRANCH}` probe'), 'sequential and none isolation keep the expected-branch probe');
  });
});
}

// A degrade from the base re-check lasts for the remaining waves of the run (#6049).
// Each shipped shell fence runs under bash through the process seam, with `gsd_run` stubbed. The shell
// records what it did in files under a per-test temp dir (the guard calls `gsd_run` inside `$(...)`, a
// subshell, so a call count has to go through a file); rows assert on those parsed records.
describe('wave base re-check: a degrade covers the remaining waves (#6049)', { skip: process.platform === 'win32' }, () => {
  const { runHook } = require('./helpers/process-seam.cjs');
  const { createTempDir } = require('./helpers.cjs');
  const { scanFencedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');
  const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
  const REFS = path.join(__dirname, '..', 'gsd-core', 'references');

  // Both references carry exactly one bash fence: that fence is the shipped step, located by the fence
  // scanner and a count rather than by searching the text for a marker.
  function onlyBashFence(file) {
    const lines = splitLines(fs.readFileSync(path.join(REFS, file), 'utf-8'));
    const fences = scanFencedBlocks(lines).filter(b => b.closeLineIdx !== -1 && b.infoString.trim() === 'bash');
    assert.equal(fences.length, 1, `${file} must carry exactly one bash fence`);
    return lines.slice(fences[0].openLineIdx + 1, fences[0].closeLineIdx).join('\n');
  }

  const STEPS = [
    { name: 'wave guard (step 0.5)', script: onlyBashFence('execute-phase-wave-guard.md') },
    { name: 'between-wave reset (step 7c)', script: onlyBashFence('execute-phase-between-wave-reset.md') },
  ];

  // Runs `script` once per wave. The stub answers shouldDegrade with `true` from wave `degradeFrom` on
  // (`false` before it), or fails every call when `failing` is set. Returns one record per wave.
  function runWaves(t, script, waves, { degradeFrom = 1, failing = false, isolation = 'harness-worktree', useWorktrees = 'true' } = {}) {
    const dir = createTempDir('gsd-wave-degrade-');
    t.after(() => cleanup(dir));
    const prelude = [
      'gsd_run() {',
      '  printf "%s\\n" "$N" >> "$STATE_DIR/calls"',
      '  [ "$FAILING" = 1 ] && return 1',
      '  case "$*" in',
      '    *shouldDegrade*) if [ "$N" -ge "$DEGRADE_FROM" ]; then echo true; else echo false; fi;;',
      '    *) echo stub-base-check-message;;',
      '  esac',
      '}',
      `ISOLATION=${isolation}`,
      `USE_WORKTREES=${useWorktrees}`,
    ].join('\n');
    const body = [];
    for (let n = 1; n <= waves; n++) {
      // Each wave's own stderr/stdout go to per-wave files, so rows can assert on what the shell printed.
      body.push(`N=${n}`, `{\n${script}\n} >"$STATE_DIR/out.${n}" 2>"$STATE_DIR/err.${n}"`, 'printf "%s %s %s %s\\n" "$N" "$ISOLATION" "$USE_WORKTREES" "${_DEGRADE_SCOPE:--}" >> "$STATE_DIR/state"', 'printf "%s\\n" "${_DEGRADE_NOTICE:--}" >> "$STATE_DIR/notices"');
    }
    const r = runHook('-c', [`${prelude}\n${body.join('\n')}`], {
      interpreter: 'bash',
      env: { ...process.env, STATE_DIR: dir, DEGRADE_FROM: String(degradeFrom), FAILING: failing ? '1' : '0' },
    });
    assert.equal(r.exitCode, 0, r.stderr);
    const calls = splitLines(fs.readFileSync(path.join(dir, 'calls'), { encoding: 'utf-8', flag: 'a+' })).filter(Boolean);
    const state = splitLines(fs.readFileSync(path.join(dir, 'state'), 'utf-8')).filter(Boolean).map(l => l.split(' '));
    const notices = splitLines(fs.readFileSync(path.join(dir, 'notices'), 'utf-8')).filter(Boolean);
    const stream = (kind, n) => fs.readFileSync(path.join(dir, `${kind}.${n}`), 'utf-8');
    return {
      // What the shell wrote to stderr / stdout in each wave, in wave order.
      stderr: state.map(([n]) => stream('err', n)),
      stdout: state.map(([n]) => stream('out', n)),
      // The scope the step declared for its degrade ('-' while it has not degraded).
      scopes: state.map(([, , , ...scope]) => scope.join(' ')),
      // The degrade sentence the step built for the user, read from its variable ('-' before a degrade).
      notices,
      waves: state.map(([n, iso, wt]) => ({ isolation: iso, worktrees: wt, calls: calls.filter(c => c === n).length })),
    };
  }

  const SEQUENTIAL = { isolation: 'none', worktrees: 'false' };
  const ISOLATED = { isolation: 'harness-worktree', worktrees: 'true' };
  const wave = (state, calls) => ({ ...state, calls });

  for (const { name, script } of STEPS) {
    describe(name, () => {
      test('after a degrade in wave 1 the later waves skip the re-check and stay sequential', (t) => {
        const { waves } = runWaves(t, script, 3);
        assert.deepEqual(waves, [wave(SEQUENTIAL, 2), wave(SEQUENTIAL, 0), wave(SEQUENTIAL, 0)]);
      });

      test('a degrade in wave 2 leaves wave 1 isolated and wave 3 sequential', (t) => {
        const { waves } = runWaves(t, script, 3, { degradeFrom: 2 });
        assert.deepEqual(waves, [wave(ISOLATED, 1), wave(SEQUENTIAL, 2), wave(SEQUENTIAL, 0)]);
      });

      test('a base check that does not degrade keeps isolation and re-checks every wave', (t) => {
        const { waves } = runWaves(t, script, 3, { degradeFrom: 99 });
        assert.deepEqual(waves, [wave(ISOLATED, 1), wave(ISOLATED, 1), wave(ISOLATED, 1)]);
      });

      test('a failing base check does not degrade', (t) => {
        const { waves } = runWaves(t, script, 2, { failing: true });
        assert.deepEqual(waves, [wave(ISOLATED, 1), wave(ISOLATED, 1)]);
      });

      test('no check runs when worktrees are already off or isolation is not the harness worktree', (t) => {
        const off = runWaves(t, script, 2, { useWorktrees: 'false' }).waves;
        assert.deepEqual(off, [
          { isolation: 'harness-worktree', worktrees: 'false', calls: 0 },
          { isolation: 'harness-worktree', worktrees: 'false', calls: 0 },
        ]);
        const none = runWaves(t, script, 2, { isolation: 'none' }).waves;
        assert.deepEqual(none, [
          { isolation: 'none', worktrees: 'true', calls: 0 },
          { isolation: 'none', worktrees: 'true', calls: 0 },
        ]);
      });

      test('the degrade declares the remaining waves as its scope, and only once it degrades', (t) => {
        assert.deepEqual(runWaves(t, script, 3, { degradeFrom: 2 }).scopes, ['-', 'remaining waves', 'remaining waves']);
      });

      test('the degrade sentence the user reads names that scope, and only once it degrades', (t) => {
        const { scopes, notices } = runWaves(t, script, 3, { degradeFrom: 2 });
        assert.equal(notices[0], '-');
        // The sentence is built from the declared scope, so a literal that drifts from it fails here.
        assert.ok(notices[1].includes(`sequential mode for ${scopes[1]}`), notices[1]);
        assert.ok(!notices[1].includes('this wave'), notices[1]);
      });

      // What the shell actually prints (#6049 was the echo saying "for this wave"): the degrade wave's
      // stderr carries the sentence built from the scope; the other waves print no degrade sentence;
      // nothing goes to stdout.
      test('the degrade sentence is printed to stderr in the degrade wave only, and stdout stays empty', (t) => {
        const { scopes, notices, stderr, stdout } = runWaves(t, script, 3, { degradeFrom: 2 });
        const sentence = `sequential mode for ${scopes[1]}`;
        // The exact stderr, line by line: the base-check message then the sentence in the degrade wave,
        // nothing in the wave that checks and does not degrade, nothing in the wave that skips the re-check.
        // Compared as raw strings per wave, so a stray blank line fails too.
        assert.deepEqual(stderr, ['', `stub-base-check-message\n${notices[1]}\n`, '']);
        assert.ok(notices[1].includes(sentence), notices[1]);
        assert.ok(!stderr[1].includes('this wave'), stderr[1]);
        assert.deepEqual(stdout, ['', '', '']);
      });
    });
  }

  test('both steps declare the same degrade scope', (t) => {
    const [guard, reset] = STEPS.map(({ script }) => runWaves(t, script, 1).scopes[0]);
    assert.equal(guard, reset);
    assert.notEqual(guard, '-', 'the scope is declared at all');
  });

  // The step 0.5 paragraph that follows the fence states the lifetime of the degrade. Read it from the
  // markdown structure (the first paragraph after the fence) and check it names the scope the fence declares,
  // so the prose and the shell cannot drift apart unnoticed.
  test('the step 0.5 paragraph after the fence states the scope the fence declares', (t) => {
    const lines = splitLines(fs.readFileSync(path.join(REFS, 'execute-phase-wave-guard.md'), 'utf-8'));
    const fence = scanFencedBlocks(lines).find(b => b.closeLineIdx !== -1 && b.infoString.trim() === 'bash');
    const rest = lines.slice(fence.closeLineIdx + 1);
    const start = rest.findIndex(l => l.trim() !== '');
    assert.notEqual(start, -1, 'a paragraph follows the fence');
    const next = rest.findIndex((l, i) => i > start && l.trim() === '');
    const paragraph = rest.slice(start, next === -1 ? rest.length : next).join(' ');
    const scope = runWaves(t, STEPS[0].script, 1).scopes[0];
    assert.ok(paragraph.includes(`**${scope}**`), `the paragraph after the fence must bold the scope "${scope}"`);
    // The old claim must not survive in this paragraph or any other paragraph of the reference.
    const whole = lines.join(' ').replace(/\s+/g, ' ');
    const STALE_CLAIM = /\b(?:this|current|next) wave (?:only|alone)\b|\bjust (?:this|the current|the next) wave\b|\bper[- ]wave\b|\bre[- ]?enabl/i;
    assert.ok(!STALE_CLAIM.test(whole),'the reference must not say a degrade is per wave or that later waves re-enable isolation');
  });
});
