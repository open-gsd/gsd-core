// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * GSD Tools Tests - Route 0 resume-incomplete-phase invariant (#160)
 *
 * Validates that BOTH next.md and progress.md contain the Route 0 cross-phase
 * incomplete-execution scan that runs BEFORE any current_phase-based routing.
 * This prevents the data-loss scenario where a crashed session advances
 * current_phase past a phase that has PLAN.md files without matching
 * SUMMARY.md files, causing /gsd-next or /gsd-progress to silently skip
 * partially-executed work.
 *
 * Closes: #160
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('Route 0: resume_incomplete_phase invariant (#160)', () => {
  const nextMdPath = path.join(__dirname, '..', 'get-shit-done', 'workflows', 'next.md');
  const progressMdPath = path.join(__dirname, '..', 'get-shit-done', 'workflows', 'progress.md');

  // ── next.md ───────────────────────────────────────────────────────────────

  describe('next.md', () => {
    test('contains a resume_incomplete_phase step', () => {
      const content = fs.readFileSync(nextMdPath, 'utf8');
      assert.ok(
        content.includes('name="resume_incomplete_phase"'),
        'next.md must have a step named resume_incomplete_phase (Route 0)'
      );
    });

    test('resume_incomplete_phase step appears BEFORE determine_next_action', () => {
      const content = fs.readFileSync(nextMdPath, 'utf8');
      const route0Idx = content.indexOf('name="resume_incomplete_phase"');
      const routeIdx = content.indexOf('name="determine_next_action"');
      assert.ok(route0Idx > -1, 'resume_incomplete_phase step must exist');
      assert.ok(routeIdx > -1, 'determine_next_action step must exist');
      assert.ok(
        route0Idx < routeIdx,
        'resume_incomplete_phase (Route 0) must appear before determine_next_action'
      );
    });

    test('resume_incomplete_phase step appears AFTER safety_gates', () => {
      const content = fs.readFileSync(nextMdPath, 'utf8');
      const gatesIdx = content.indexOf('name="safety_gates"');
      const route0Idx = content.indexOf('name="resume_incomplete_phase"');
      assert.ok(gatesIdx > -1, 'safety_gates step must exist');
      assert.ok(route0Idx > -1, 'resume_incomplete_phase step must exist');
      assert.ok(
        gatesIdx < route0Idx,
        'resume_incomplete_phase must appear after safety_gates'
      );
    });

    test('scans ALL phases (not just current_phase) for incomplete execution', () => {
      const content = fs.readFileSync(nextMdPath, 'utf8');
      // Must describe a cross-phase scan independent of current_phase
      assert.ok(
        content.includes('Scan ALL phases') || content.includes('scan ALL phases'),
        'Route 0 in next.md must scan ALL phases, not just current_phase'
      );
    });

    test('detects plans without summaries across all phases', () => {
      const content = fs.readFileSync(nextMdPath, 'utf8');
      assert.ok(
        content.includes('plans.length > summaries.length') ||
          content.includes('plans without summaries') ||
          content.includes('plans-without-summaries'),
        'Route 0 in next.md must detect phases where plans outnumber summaries'
      );
    });

    test('routes to lowest-numbered incomplete phase via execute-phase', () => {
      const content = fs.readFileSync(nextMdPath, 'utf8');
      assert.ok(
        content.includes('INCOMPLETE_PHASE'),
        'Route 0 must record the lowest incomplete phase number'
      );
      assert.ok(
        content.includes('gsd-execute-phase') || content.includes('gsd:execute-phase'),
        'Route 0 must route to execute-phase to resume the incomplete phase'
      );
    });

    test('provides --no-resume opt-out', () => {
      const content = fs.readFileSync(nextMdPath, 'utf8');
      assert.ok(
        content.includes('--no-resume'),
        'Route 0 in next.md must provide --no-resume opt-out'
      );
    });

    test('--force also bypasses Route 0', () => {
      const content = fs.readFileSync(nextMdPath, 'utf8');
      // The --force skip must be mentioned within or near the Route 0 step
      const route0Start = content.indexOf('name="resume_incomplete_phase"');
      const route0End = content.indexOf('</step>', route0Start);
      const route0Block = content.slice(route0Start, route0End);
      assert.ok(
        route0Block.includes('--force'),
        'Route 0 step in next.md must mention --force as a bypass'
      );
    });

    test('success_criteria includes Route 0 entry', () => {
      const content = fs.readFileSync(nextMdPath, 'utf8');
      assert.ok(
        content.includes('Route 0') || content.includes('resume_incomplete_phase'),
        'success_criteria must reference the Route 0 / resume_incomplete_phase invariant'
      );
    });

    test('explains why Route 0 must precede current_phase routing', () => {
      const content = fs.readFileSync(nextMdPath, 'utf8');
      // Must contain the rationale: invariant independent of current_phase
      assert.ok(
        content.includes('independent of') ||
          content.includes('before any routing rule that reads current_phase') ||
          content.includes('before any current-phase'),
        'Route 0 must explain it is independent of current_phase value'
      );
    });

    // ── SHOULD-FIX 1: Route 0 ordering relative to prior-phase defer prompt ──

    test('resume_incomplete_phase runs BEFORE the prior-phase defer prompt (no double-decision)', () => {
      const content = fs.readFileSync(nextMdPath, 'utf8');
      // Route 0 must be ordered BEFORE the step that contains the prior-phase defer prompt.
      // After the rework, the prior-phase defer prompt lives in prior_phase_completeness.
      const route0Idx = content.indexOf('name="resume_incomplete_phase"');
      const deferPromptIdx = content.indexOf('name="prior_phase_completeness"');
      assert.ok(route0Idx > -1, 'resume_incomplete_phase step must exist');
      assert.ok(
        deferPromptIdx > -1,
        'prior_phase_completeness step must exist (holds the C/S/F defer prompt)'
      );
      assert.ok(
        route0Idx < deferPromptIdx,
        'resume_incomplete_phase (Route 0) must appear BEFORE prior_phase_completeness in next.md — prevents double-decision'
      );
    });

    test('safety_gates contains ONLY Gates 1-3 (no prior-phase defer prompt)', () => {
      const content = fs.readFileSync(nextMdPath, 'utf8');
      // Extract just the safety_gates step body
      const gatesStart = content.indexOf('<step name="safety_gates">');
      const gatesEnd = content.indexOf('</step>', gatesStart);
      const gatesBlock = content.slice(gatesStart, gatesEnd);
      // The defer prompt's C/S/F options must NOT be inside safety_gates
      assert.ok(
        !gatesBlock.includes('[C] Continue and defer'),
        'safety_gates must not contain the C/S/F prior-phase defer prompt — that belongs in prior_phase_completeness'
      );
      // Gates 1-3 must still be present
      assert.ok(gatesBlock.includes('Gate 1'), 'safety_gates must still contain Gate 1');
      assert.ok(gatesBlock.includes('Gate 2'), 'safety_gates must still contain Gate 2');
      assert.ok(gatesBlock.includes('Gate 3'), 'safety_gates must still contain Gate 3');
    });

    test('--no-resume routes to prior_phase_completeness (not silently skips)', () => {
      const content = fs.readFileSync(nextMdPath, 'utf8');
      const route0Start = content.indexOf('name="resume_incomplete_phase"');
      const route0End = content.indexOf('</step>', route0Start);
      const route0Block = content.slice(route0Start, route0End);
      // When --no-resume is passed, must send user to prior_phase_completeness (the defer prompt)
      assert.ok(
        route0Block.includes('prior_phase_completeness'),
        'Route 0 step must reference prior_phase_completeness as the --no-resume/--force fallthrough path'
      );
    });

    // ── --force flag-flow coherence (SHOULD-FIX: contradictory semantics) ──

    test('prior_phase_completeness does NOT claim to run under --force', () => {
      const content = fs.readFileSync(nextMdPath, 'utf8');
      const ppcStart = content.indexOf('name="prior_phase_completeness"');
      const ppcEnd = content.indexOf('</step>', ppcStart);
      const ppcBlock = content.slice(ppcStart, ppcEnd);
      // The step header must not say it runs "via --force" or "or --force"
      assert.ok(
        !ppcBlock.includes('--no-resume` or `--force`') &&
          !ppcBlock.includes('--force`, or'),
        'prior_phase_completeness must NOT claim to run when --force is passed ' +
          '(--force jumps directly to determine_next_action at safety_gates)'
      );
    });

    test('resume_incomplete_phase does NOT route --force through to prior_phase_completeness', () => {
      const content = fs.readFileSync(nextMdPath, 'utf8');
      const route0Start = content.indexOf('name="resume_incomplete_phase"');
      const route0End = content.indexOf('</step>', route0Start);
      const route0Block = content.slice(route0Start, route0End);
      // Must NOT say "--force or --no-resume … proceed to prior_phase_completeness"
      assert.ok(
        !route0Block.includes('`--force` or `--no-resume`') &&
          !route0Block.includes('--force` was passed.** On those flags, proceed directly to `prior_phase_completeness`'),
        'resume_incomplete_phase must NOT route --force to prior_phase_completeness; ' +
          '--force already jumped to determine_next_action at safety_gates'
      );
    });

    test('safety_gates --force description makes explicit it skips Route 0 and prior_phase_completeness', () => {
      const content = fs.readFileSync(nextMdPath, 'utf8');
      const gatesStart = content.indexOf('<step name="safety_gates">');
      const gatesEnd = content.indexOf('</step>', gatesStart);
      const gatesBlock = content.slice(gatesStart, gatesEnd);
      // The --force jump description must mention Route 0 / prior_phase_completeness skip
      assert.ok(
        (gatesBlock.includes('Route 0') || gatesBlock.includes('prior-phase completeness')) &&
          gatesBlock.includes('determine_next_action'),
        'safety_gates --force description must explicitly state it skips Route 0 and/or ' +
          'prior_phase_completeness and routes to determine_next_action'
      );
    });

    test('success_criteria --force entry routes straight to determine_next_action (not prior_phase_completeness)', () => {
      const content = fs.readFileSync(nextMdPath, 'utf8');
      const scStart = content.indexOf('<success_criteria>');
      const scEnd = content.indexOf('</success_criteria>', scStart);
      const scBlock = content.slice(scStart, scEnd);
      // Must have a --force criterion pointing to determine_next_action
      assert.ok(
        scBlock.includes('--force') && scBlock.includes('determine_next_action'),
        'success_criteria must document --force as routing to determine_next_action'
      );
      // Must NOT group --force with --no-resume as both triggering prior_phase_completeness
      assert.ok(
        !scBlock.includes('`--no-resume`/`--force`: Route 0 skipped, prior_phase_completeness'),
        'success_criteria must not conflate --force and --no-resume as both running prior_phase_completeness'
      );
    });

    // ── SHOULD-FIX 2: SDK form and fail-closed error surfacing ──

    test('scan uses gsd_run (canonical resolver form, not bare gsd-sdk)', () => {
      const content = fs.readFileSync(nextMdPath, 'utf8');
      const route0Start = content.indexOf('name="resume_incomplete_phase"');
      const route0End = content.indexOf('</step>', route0Start);
      const route0Block = content.slice(route0Start, route0End);
      // Must use gsd_run, not bare gsd-sdk
      assert.ok(
        route0Block.includes('gsd_run'),
        'Route 0 scan must use gsd_run (canonical resolver), not bare gsd-sdk'
      );
      // Must NOT use bare gsd-sdk (without $)
      const bareGsdSdkPattern = /(?<!\$)gsd-sdk/;
      assert.ok(
        !bareGsdSdkPattern.test(route0Block),
        'Route 0 must not use bare gsd-sdk — use gsd_run to match the file convention'
      );
    });

    test('scan does NOT silently suppress errors with 2>/dev/null on the main query', () => {
      const content = fs.readFileSync(nextMdPath, 'utf8');
      const route0Start = content.indexOf('name="resume_incomplete_phase"');
      const route0End = content.indexOf('</step>', route0Start);
      const route0Block = content.slice(route0Start, route0End);
      // The roadmap.analyze call must not pipe to /dev/null (which causes fail-open data loss)
      assert.ok(
        !route0Block.includes('roadmap.analyze 2>/dev/null') &&
          !route0Block.includes('roadmap.analyze --pick phases 2>/dev/null'),
        'Route 0 must not suppress roadmap.analyze errors with 2>/dev/null — failure must surface, not fail open'
      );
    });

    test('scan surfaces an error warning when roadmap query fails (fail-closed)', () => {
      const content = fs.readFileSync(nextMdPath, 'utf8');
      const route0Start = content.indexOf('name="resume_incomplete_phase"');
      const route0End = content.indexOf('</step>', route0Start);
      const route0Block = content.slice(route0Start, route0End);
      // Must emit a warning when the scan cannot run — not silently no-op
      assert.ok(
        route0Block.includes('WARNING') || route0Block.includes('could not run') || route0Block.includes('could not be verified'),
        'Route 0 must emit a warning when the incomplete-phase scan fails, not silently proceed as if no incomplete phase exists'
      );
    });
  });

  // ── progress.md ───────────────────────────────────────────────────────────

  describe('progress.md', () => {
    test('contains a Step 0 / Route 0 resume-incomplete-phase invariant', () => {
      const content = fs.readFileSync(progressMdPath, 'utf8');
      assert.ok(
        content.includes('Step 0') || content.includes('Route 0'),
        'progress.md route step must contain a Step 0 / Route 0 invariant'
      );
    });

    test('Route 0 appears BEFORE Step 1 (current-phase counting)', () => {
      const content = fs.readFileSync(progressMdPath, 'utf8');
      const route0Idx = content.search(/Step 0[^9]/);
      const step1Idx = content.search(/Step 1:/);
      assert.ok(route0Idx > -1, 'Step 0 invariant must exist in progress.md');
      assert.ok(step1Idx > -1, 'Step 1 current-phase counting must exist');
      assert.ok(
        route0Idx < step1Idx,
        'Step 0 (Route 0) must appear before Step 1 in progress.md'
      );
    });

    test('scans all phases for incomplete execution before current-phase routing', () => {
      const content = fs.readFileSync(progressMdPath, 'utf8');
      assert.ok(
        content.includes('scan ALL phases') || content.includes('Scan ALL phases') ||
          content.includes('scan all phases') || content.includes('all phases for incomplete'),
        'Route 0 in progress.md must scan ALL phases (not just current_phase)'
      );
    });

    test('detects plans without summaries across all phases', () => {
      const content = fs.readFileSync(progressMdPath, 'utf8');
      assert.ok(
        content.includes('plans.length > summaries.length') ||
          content.includes('plans without summaries') ||
          content.includes('plans-without-summaries'),
        'Route 0 in progress.md must detect phases where plans outnumber summaries'
      );
    });

    test('routes to the lowest incomplete phase via execute-phase', () => {
      const content = fs.readFileSync(progressMdPath, 'utf8');
      assert.ok(
        content.includes('INCOMPLETE_PHASE'),
        'Route 0 in progress.md must record the lowest incomplete phase number'
      );
      assert.ok(
        content.includes('gsd-execute-phase') || content.includes('gsd:execute-phase'),
        'Route 0 in progress.md must route to execute-phase'
      );
    });

    test('provides --no-resume opt-out', () => {
      const content = fs.readFileSync(progressMdPath, 'utf8');
      assert.ok(
        content.includes('--no-resume'),
        'Route 0 in progress.md must provide --no-resume opt-out'
      );
    });

    test('--force also bypasses Route 0', () => {
      const content = fs.readFileSync(progressMdPath, 'utf8');
      // Find Route 0 block and verify --force is mentioned
      const route0Start = content.indexOf('Step 0: Resume-incomplete-phase');
      assert.ok(route0Start > -1, 'Route 0 step text must exist');
      const route0End = content.indexOf('Step 1:', route0Start);
      const route0Block = content.slice(route0Start, route0End);
      assert.ok(
        route0Block.includes('--force'),
        'Route 0 in progress.md must mention --force as a bypass'
      );
    });

    test('does not proceed to Step 1 when incomplete phase found', () => {
      const content = fs.readFileSync(progressMdPath, 'utf8');
      // Must explicitly state that Steps 1-F are skipped when Route 0 fires
      assert.ok(
        content.includes('Do NOT run Steps 1') ||
          content.includes('exit the route step') ||
          content.includes('Do not run Step 1'),
        'Route 0 in progress.md must exit before Steps 1-F when an incomplete phase is found'
      );
    });

    test('explains rationale: current_phase may have been advanced past unfinished work', () => {
      const content = fs.readFileSync(progressMdPath, 'utf8');
      assert.ok(
        content.includes('advanced past') ||
          content.includes('current_phase was advanced') ||
          content.includes("current_phase' was advanced"),
        'Route 0 in progress.md must explain the current_phase-advanced-past-unfinished scenario'
      );
    });

    // ── SHOULD-FIX 2: SDK form and fail-closed error surfacing (progress.md) ──

    test('scan uses $ROADMAP already loaded (not a fresh bare gsd-sdk call)', () => {
      const content = fs.readFileSync(progressMdPath, 'utf8');
      const route0Start = content.indexOf('Step 0: Resume-incomplete-phase');
      const route0End = content.indexOf('Step 1:', route0Start);
      const route0Block = content.slice(route0Start, route0End);
      // progress.md convention: data comes from $ROADMAP already loaded by analyze_roadmap
      assert.ok(
        route0Block.includes('$ROADMAP'),
        'Route 0 in progress.md must use the $ROADMAP variable already loaded, not issue a fresh bare SDK call'
      );
    });

    test('scan surfaces an error warning when $ROADMAP is empty (fail-closed)', () => {
      const content = fs.readFileSync(progressMdPath, 'utf8');
      const route0Start = content.indexOf('Step 0: Resume-incomplete-phase');
      const route0End = content.indexOf('Step 1:', route0Start);
      const route0Block = content.slice(route0Start, route0End);
      // Must NOT silently no-op when $ROADMAP is empty — must surface a warning
      assert.ok(
        route0Block.includes('WARNING') || route0Block.includes('could not run') || route0Block.includes('could not be verified'),
        'Route 0 in progress.md must emit a warning when $ROADMAP is empty, not silently proceed as if no incomplete phase exists'
      );
    });

    test('predicate uses plans-without-summaries consistent with determine_next_action Route 4', () => {
      const content = fs.readFileSync(progressMdPath, 'utf8');
      const route0Start = content.indexOf('Step 0: Resume-incomplete-phase');
      const route0End = content.indexOf('Step 1:', route0Start);
      const route0Block = content.slice(route0Start, route0End);
      // Must use the same predicate: plans.length > summaries.length
      assert.ok(
        route0Block.includes('plans.length > summaries.length') ||
          route0Block.includes('plans without summaries') ||
          route0Block.includes('plans-without-summaries'),
        'Route 0 in progress.md must use plans-without-summaries predicate consistent with determine_next_action Route 4'
      );
    });
  });
});
