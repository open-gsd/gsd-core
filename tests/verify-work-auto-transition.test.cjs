// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.
'use strict';


/**
 * verify-work auto-transition tests (#2018)
 *
 * Validates that verify-work.md calls the transition workflow to mark the
 * phase complete in ROADMAP.md and STATE.md when UAT passes with 0 issues.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const VERIFY_WORK = path.join(__dirname, '..', 'gsd-core', 'workflows', 'verify-work.md');
const SHARED_STEP = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase', 'steps', 'verify-phase-goal.md');
// The verify-work regeneration arm (#5118): the sentence that opens it.
const STALE_ARM_ANCHOR = "Run the owner's route — the ONE verification action — here when `VERIFICATION_ROUTE` is";

describe('verify-work.md — auto-transition after UAT passes with 0 issues', () => {
  test('workflow reads transition.md when issues == 0 and security gate cleared', () => {
    const content = fs.readFileSync(VERIFY_WORK, 'utf-8');
    assert.ok(
      content.includes('transition.md'),
      'verify-work.md must reference transition.md for phase completion when issues == 0'
    );
  });

  test('transition call appears after complete_session section', () => {
    const content = fs.readFileSync(VERIFY_WORK, 'utf-8');
    const completeSessionIdx = content.indexOf('complete_session');
    const transitionIdx = content.indexOf('transition.md');
    assert.ok(
      completeSessionIdx !== -1,
      'verify-work.md must contain a complete_session section'
    );
    assert.ok(
      transitionIdx !== -1,
      'verify-work.md must reference transition.md'
    );
    assert.ok(
      transitionIdx > completeSessionIdx,
      'transition.md reference must appear after the complete_session section'
    );
  });

  test('security gate check gates the transition (no auto-transition when security pending)', () => {
    const content = fs.readFileSync(VERIFY_WORK, 'utf-8');
    // The capability-resolved security check must appear before the transition reference.
    const securityHookIdx = content.indexOf('loop render-hooks verify:post');
    const transitionIdx = content.indexOf('transition.md');
    assert.ok(
      securityHookIdx !== -1,
      'verify-work.md must resolve verify:post capability hooks before transitioning'
    );
    assert.ok(
      securityHookIdx < transitionIdx,
      'verify:post capability hook check must appear before transition.md reference'
    );
  });

  test('transition is only invoked when security gate is cleared or disabled', () => {
    const content = fs.readFileSync(VERIFY_WORK, 'utf-8');
    // Transition must be guarded by security check:
    // Either no active secure-phase hook exists, or security file exists with 0 open threats.
    const hasGuardedTransition =
      content.includes('transition.md') &&
      (
        content.includes('loop render-hooks verify:post') &&
        content.includes('ref.skill == "secure-phase"') &&
        (content.includes('threats_open') || content.includes('SECURITY_FILE'))
      );
    assert.ok(
      hasGuardedTransition,
      'transition.md invocation must be guarded by security gate checks'
    );
  });

  test('auto-transition is gated by UAT plus canonical verification predicate', () => {
    const content = fs.readFileSync(VERIFY_WORK, 'utf-8');
    const predicateIdx = content.indexOf('phase uat-passed');
    const requireVerificationIdx = content.indexOf('--require-verification');
    const transitionIdx = content.indexOf('transition.md');

    assert.ok(predicateIdx !== -1, 'verify-work.md must call phase uat-passed before transition');
    assert.ok(
      requireVerificationIdx > predicateIdx,
      'verify-work.md must require canonical verification in the UAT predicate'
    );
    assert.ok(
      predicateIdx < transitionIdx,
      'UAT-plus-verification predicate must run before transition.md'
    );
  });

  test('human_needed verification is promoted to passed only after successful human UAT', () => {
    const content = fs.readFileSync(VERIFY_WORK, 'utf-8');
    const statusIdx = content.indexOf('VERIFICATION_STATUS=$(gsd_run query verification.status "$PHASE_DIR"');
    const humanNeededIdx = content.indexOf('if [ "$VERIFICATION_STATUS_VALUE" = "human_needed" ]; then');
    const setPassedIdx = content.indexOf('gsd_run query frontmatter.set "$VERIFICATION_FILE" --field status --value passed');
    const predicateIdx = content.indexOf('PHASE_COMPLETE=$(gsd_run phase uat-passed "{phase}" --require-verification)');

    assert.ok(statusIdx !== -1, 'verify-work.md must inspect canonical verification status');
    assert.ok(humanNeededIdx > statusIdx, 'status=passed promotion must be restricted to human_needed');
    assert.ok(setPassedIdx > humanNeededIdx, 'human_needed verification must be promoted after status check');
    assert.ok(setPassedIdx < predicateIdx, 'verification must be canonicalized before the required predicate runs');
  });

  // #5118: the stale arm is keyed on the owner's route, not the status word.
  test('stale verification blocks before phase transition', () => {
    const content = fs.readFileSync(VERIFY_WORK, 'utf-8');
    const staleIdx = content.indexOf(STALE_ARM_ANCHOR);
    const predicateIdx = content.indexOf('PHASE_COMPLETE=$(gsd_run phase uat-passed "{phase}" --require-verification)');
    const transitionIdx = content.indexOf('transition.md');

    assert.ok(staleIdx !== -1, 'verify-work.md must stop on stale verification');
    assert.ok(staleIdx < predicateIdx, 'stale verification must be checked before the required predicate');
    assert.ok(staleIdx < transitionIdx, 'stale verification must be checked before transition');
  });

  test('transition is NOT suggested when security enforcement is enabled and no SECURITY.md exists', () => {
    const content = fs.readFileSync(VERIFY_WORK, 'utf-8');
    // The workflow should suggest /gsd-secure-phase when security is enabled but no file exists
    assert.ok(
      content.includes('gsd-secure-phase') || content.includes('gsd:secure-phase'),
      'verify-work.md must suggest /gsd:secure-phase when security gate blocks transition'
    );
  });
});

// ── #4663 — the canonicalize flip requires the UAT predicate, not a vacuous zero ──
// "zero issues" is not pass evidence: blocked rows are not issues by this same
// workflow's rule, so a 0-passed / 0-issues / N-blocked session must NOT flip
// VERIFICATION.md to `passed`. The flip now consumes the SAME predicate the
// phase-close uses in its --uat-only form (the verification-status blocker
// is exactly what the flip removes, so the full predicate could never pass
// at pre-check time); the flagged call stays the later transition gate.
describe('verify-work.md — canonicalize flip is gated by the UAT predicate (#4663)', () => {
  test('canonicalize flips to passed only when the uat-passed predicate reports passed (#4663)', () => {
    const content = fs.readFileSync(VERIFY_WORK, 'utf-8');
    const humanNeededIdx = content.indexOf('if [ "$VERIFICATION_STATUS_VALUE" = "human_needed" ]; then');
    // #5118: stderr is kept (no 2>/dev/null) — a hard error must surface.
    const precheckIdx = content.indexOf('UAT_PRECHECK=$(gsd_run phase uat-passed "{phase}" --uat-only)');
    const flipGuardIdx = content.indexOf('if [ "$UAT_PRECHECK_PASSED" = "true" ]; then');
    const setPassedIdx = content.indexOf('gsd_run query frontmatter.set "$VERIFICATION_FILE" --field status --value passed');

    assert.ok(precheckIdx !== -1, 'the canonicalize block must run the uat-passed predicate before flipping');
    assert.ok(humanNeededIdx !== -1 && precheckIdx > humanNeededIdx, 'the pre-check must sit inside the human_needed branch');
    assert.ok(content.includes(".passed // false"), 'the verdict must be extracted from the typed report with a false default');
    assert.ok(flipGuardIdx !== -1 && flipGuardIdx > precheckIdx, 'the flip must be guarded on the extracted passed verdict');
    assert.ok(setPassedIdx > flipGuardIdx, 'frontmatter.set must sit INSIDE the passed==true guard');
  });

  test('the canonicalize pre-check runs uat-passed without --require-verification (#4663)', () => {
    const content = fs.readFileSync(VERIFY_WORK, 'utf-8');
    const precheckIdx = content.indexOf('UAT_PRECHECK=$(gsd_run phase uat-passed "{phase}" --uat-only)');
    const flaggedIdx = content.indexOf('PHASE_COMPLETE=$(gsd_run phase uat-passed "{phase}" --require-verification)');

    assert.ok(precheckIdx !== -1, 'the --uat-only pre-check must exist');
    assert.ok(
      !content.slice(precheckIdx, precheckIdx + 120).includes('--require-verification'),
      'the pre-check is the unflagged predicate - requiring verification there would evaluate the very report being written'
    );
    assert.ok(flaggedIdx !== -1 && flaggedIdx > precheckIdx, 'the flagged predicate remains the later transition gate');
  });

  test('refused canonicalization says the verification stays human_needed (#4663)', () => {
    const content = fs.readFileSync(VERIFY_WORK, 'utf-8');
    assert.match(content, /stays human_needed/, 'the refusal message must say verification stays human_needed');
    assert.match(content, /blockers \| length/, 'the refusal must carry the blocking-row count');
  });

  test('an indeterminate pre-check must not flip the report (fail closed) (#4663)', () => {
    const content = fs.readFileSync(VERIFY_WORK, 'utf-8');
    // jq -r '.passed // false' with an `|| echo "false"` fallback: empty or
    // failed gsd_run output must yield no-flip, never a flip.
    assert.ok(
      content.includes(`jq -r '.passed // false' 2>/dev/null || echo "false"`),
      'the extraction must default to false on empty/failed output'
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3381-verify-work-workstream.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3381-verify-work-workstream (consolidation epic #1969 B4 #1973)", () => {
// allow-test-rule: source-text-is-the-product — verify-work.md is a runtime workflow contract. (see #3381)

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('bug #1716: resume_from_file routes to complete_session when no [pending] tests remain', () => {
  test('resume_from_file step contains guard clause for zero-pending (all-blocked) case', () => {
    const workflow = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'verify-work.md'),
      'utf8',
    );

    const stepStart = workflow.indexOf('<step name="resume_from_file">');
    assert.ok(stepStart !== -1, 'resume_from_file step must exist');

    const stepEnd = workflow.indexOf('</step>', stepStart);
    const stepBody = workflow.slice(stepStart, stepEnd);

    // Guard must appear immediately after the find-pending instruction.
    // Without it, all-blocked sessions (pending_count==0, blocked_count>0)
    // silently terminate and never reach complete_session (#1716).
    const findIdx = stepBody.indexOf("Find first test with `result: [pending]`.");
    const guardIdx = stepBody.indexOf("If no `[pending]` test found → go to `complete_session`.");

    assert.ok(findIdx !== -1, 'find-pending instruction must be present');
    assert.ok(guardIdx !== -1, 'guard clause for zero-pending case must be present');
    assert.ok(guardIdx > findIdx, 'guard must appear after find-pending instruction');

    const between = stepBody
      .slice(findIdx + "Find first test with `result: [pending]`.".length, guardIdx)
      .trim();
    assert.strictEqual(between, '', 'guard must be the next non-whitespace line after find-pending');
  });
});

describe('bug #3381: verify-work forwards workstream context', () => {
  test('workflow forwards ${GSD_WS} to workstream-sensitive SDK queries', () => {
    // #2994 fragmentization moved the roadmap.get-phase user-story-format-guard
    // bash block out of verify-work.md into
    // gsd-core/workflows/verify-work/steps/mvp-uat-framing.md behind a section
    // marker (`state:phase-mvp-mode`). Read host + every step file combined so
    // this GSD_WS-forwarding guard keeps seeing the moved query.
    const VERIFY_WORK_MD = path.join(__dirname, '..', 'gsd-core', 'workflows', 'verify-work.md');
    const VERIFY_WORK_STEPS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows', 'verify-work', 'steps');
    let workflow = fs.readFileSync(VERIFY_WORK_MD, 'utf8');
    if (fs.existsSync(VERIFY_WORK_STEPS_DIR)) {
      for (const entry of fs.readdirSync(VERIFY_WORK_STEPS_DIR).sort()) {
        if (entry.endsWith('.md')) {
          workflow += '\n' + fs.readFileSync(path.join(VERIFY_WORK_STEPS_DIR, entry), 'utf8');
        }
      }
    }

    // The --ws capture character class was deliberately narrowed from
    // `[^[:space:]]+` to `[A-Za-z0-9._-]+` (workstream slugs are
    // alphanumeric/dot/underscore/hyphen; the old class captured any
    // non-space run, including shell metacharacters). Forwarding itself
    // (GSD_WS reaching every workstream-sensitive query below) is
    // unaffected by the narrower class, so only the literal pattern here
    // is updated — the asserted forwarding property is unchanged.
    assert.match(workflow, /GSD_WS=""/, 'verify-work must initialize GSD_WS');
    assert.match(
      workflow,
      /grep -qE -- '--ws\[\[:space:\]\]\+\[A-Za-z0-9\._-\]\+'/,
      'verify-work must detect --ws in $ARGUMENTS',
    );
    assert.match(
      workflow,
      /grep -oE -- '--ws\[\[:space:\]\]\+\[A-Za-z0-9\._-\]\+'/,
      'verify-work must extract the --ws flag pair from $ARGUMENTS',
    );
    assert.match(
      workflow,
      /PHASE_ARG=\$\(echo "\$ARGUMENTS" \| sed -E 's\/--ws\[\[:space:\]\]\+\[A-Za-z0-9\._-\]\+\/\/g' \| xargs\)/,
      'verify-work must derive PHASE_ARG after removing --ws',
    );
    // After #3797 architectural fix, callsites use gsd_run
    assert.match(
      workflow,
      /gsd_run query init\.verify-work "\$\{PHASE_ARG\}" \$\{GSD_WS:\+--ws=\$\{GSD_WS##\* \}\}/,
      'init.verify-work must receive GSD_WS so phase_dir resolves in workstreams',
    );
    assert.match(
      workflow,
      /gsd_run query phase\.mvp-mode "\$\{phase_number\}" \$\{GSD_WS:\+--ws=\$\{GSD_WS##\* \}\} --pick active/,
      'phase.mvp-mode must receive GSD_WS so roadmap mode is workstream-scoped',
    );
    assert.match(
      workflow,
      /gsd_run query roadmap\.get-phase "\$\{phase_number\}" \$\{GSD_WS:\+--ws=\$\{GSD_WS##\* \}\} --pick goal/,
      'roadmap.get-phase must receive GSD_WS so goals are workstream-scoped',
    );
  });
});
  });
}

// ── #4682 — the stale stop routes to the verifier, not to itself ─────────────
// A stale report means covered source files changed after the verifier ran;
// the only remedy is re-running the verifier. /gsd-verify-work never rewrites
// VERIFICATION.md, so advising it from its own stale block is an advice loop.
describe('verify-work.md — stale stop routes to the verifier (#4682)', () => {
  // #5118: the stale arm runs the ONE regeneration step execute-phase runs
  // (execute-phase/steps/verify-phase-goal.md, which dispatches gsd-verifier)
  // instead of an inline second copy of the verifier spawn.
  test('the stale stop instructs re-running the verifier, not verify-work (#4682)', () => {
    const content = fs.readFileSync(VERIFY_WORK, 'utf-8');
    const staleIdx = content.indexOf(STALE_ARM_ANCHOR);
    assert.ok(staleIdx !== -1, 'the stale stop must exist');
    const block = content.slice(staleIdx, content.indexOf('PHASE_COMPLETE=$(gsd_run phase uat-passed'));

    assert.match(block, /execute-phase\/steps\/verify-phase-goal\.md/, 'the stale stop must run the shared regeneration step');
    const step = fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase', 'steps', 'verify-phase-goal.md'), 'utf-8');
    assert.match(step, /subagent_type="gsd-verifier"/, 'the shared step dispatches the gsd-verifier agent');
    assert.match(block, /verification\.status/, 'it must re-check verification.status afterwards');
    assert.doesNotMatch(
      block, /`\/gsd:verify-work \{phase\}` — re-run verification/,
      'the self-referential re-run advice must be gone'
    );
  });
});

// ── #5118 review F1 — a `missing` report must not dispatch the regeneration
// on an unexecuted phase; the shared step loads the ROADMAP goal explicitly ──
describe('verify-work.md — the regeneration arm is guarded on a phase that can be verified (#5118)', () => {
  const content = fs.readFileSync(VERIFY_WORK, 'utf-8');
  const armIdx = content.indexOf(STALE_ARM_ANCHOR);
  const arm = content.slice(armIdx, content.indexOf('PHASE_COMPLETE=$(gsd_run phase uat-passed'));

  test('IMPLEMENTATION_COMPLETE is read from the verify-work init bundle before the arm', () => {
    const readIdx = content.indexOf("IMPLEMENTATION_COMPLETE=$(printf '%s' \"$INIT\" | jq -r '.phase_completion.implementation_complete // false')");
    assert.ok(readIdx !== -1, 'the phase_completion.implementation_complete field must be read from $INIT');
    assert.ok(readIdx < armIdx, 'it must be read before the arm that uses it');
  });

  test('the arm fires for stale, or for missing only once every plan has a SUMMARY', () => {
    const head = arm.slice(0, arm.indexOf('```bash'));
    assert.match(head, /`PHASE_VERIFICATION_STATUS` is `stale`/, 'stale regenerates');
    assert.match(head, /it is `missing` and `IMPLEMENTATION_COMPLETE` is `true`/, 'missing regenerates only on an executed phase');
    assert.match(head, /A `missing` report on a phase that is NOT fully executed does NOT\s+dispatch the step/, 'an unexecuted phase does not dispatch the step');
    assert.match(head, /falls? through to the completion predicate|fall through to the completion predicate/, 'the unexecuted case falls through to the predicate');
  });
});

describe('verify-phase-goal.md — the ROADMAP goal is loaded explicitly (#5118)', () => {
  const step = fs.readFileSync(SHARED_STEP, 'utf-8');

  test('PHASE_GOAL is resolved by roadmap.get-phase --pick goal', () => {
    assert.match(step, /PHASE_GOAL=\$\(gsd_run query roadmap\.get-phase "\$\{PHASE_NUMBER\}"[^\n]*--pick goal\)/);
  });

  test('the verifier prompt names {PHASE_GOAL}, not a goal the model must resolve', () => {
    assert.match(step, /Phase goal: \{PHASE_GOAL\}/);
    assert.doesNotMatch(step, /\{goal from ROADMAP\.md\}/);
  });
});

// ── #5118 review F1 — CLI-level route table: `missing` on an unexecuted phase
// vs an executed one vs `stale`, and the init field the arm reads ──────────
describe('verification route table and the init field the regeneration arm keys on (#5118)', () => {
  const { runGsdTools, createTempGitProject, cleanup } = require('./helpers.cjs');
  const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
  const { execFileSync } = require('child_process');

  function initBundle(projectDir) {
    const res = runGsdTools(['init', 'verify-work', '1'], projectDir);
    assert.ok(res.success, `init verify-work must run: ${res.error}`);
    let out = res.output;
    if (out.startsWith('@file:')) out = fs.readFileSync(out.slice('@file:'.length).trim(), 'utf-8');
    return JSON.parse(out);
  }

  function statusJson(projectDir, phaseDir) {
    const res = runGsdTools(['verification', 'status', phaseDir], projectDir);
    assert.ok(res.success, `verification status must run: ${res.error}`);
    return JSON.parse(res.output);
  }

  function phaseFixture(t, { summarized }) {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    if (summarized) fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');
    return { projectDir, phaseDir };
  }

  test('missing report, phase NOT executed: route execute-phase but implementation_complete is false (no dispatch)', (t) => {
    const { projectDir, phaseDir } = phaseFixture(t, { summarized: false });
    const status = statusJson(projectDir, phaseDir);
    assert.strictEqual(status.status, 'missing');
    assert.strictEqual(status.route, 'execute-phase');
    assert.strictEqual(initBundle(projectDir).phase_completion.implementation_complete, false);
  });

  test('missing report, phase executed: route execute-phase and implementation_complete is true (dispatch)', (t) => {
    const { projectDir, phaseDir } = phaseFixture(t, { summarized: true });
    const status = statusJson(projectDir, phaseDir);
    assert.strictEqual(status.status, 'missing');
    assert.strictEqual(status.route, 'execute-phase');
    assert.strictEqual(initBundle(projectDir).phase_completion.implementation_complete, true);
  });

  test('stale report: route execute-phase and implementation_complete is true (dispatch)', (t) => {
    const { projectDir, phaseDir } = phaseFixture(t, { summarized: true });
    const declared = ['.planning/phases/01-foo/01-01-PLAN.md', '.planning/phases/01-foo/01-01-SUMMARY.md'];
    const fp = runGsdTools(['verification', 'fingerprint', phaseDir, ...declared], projectDir);
    assert.ok(fp.success, `fingerprint must succeed: ${fp.error}`);
    const parsed = JSON.parse(fp.output);
    fs.writeFileSync(
      path.join(phaseDir, '01-VERIFICATION.md'),
      `---\nstatus: passed\ncovered_files:\n${parsed.covered_files.map((f) => `  - ${f}`).join('\n')}\ncovered_digest: "${parsed.covered_digest}"\n---\n`,
    );
    execFileSync('git', ['add', '-A'], { cwd: projectDir, timeout: GIT_TIMEOUT_MS });
    execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: projectDir, timeout: GIT_TIMEOUT_MS });
    assert.strictEqual(statusJson(projectDir, phaseDir).status, 'passed', 'sanity: fresh');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary changed\n');
    const status = statusJson(projectDir, phaseDir);
    assert.strictEqual(status.status, 'stale');
    assert.strictEqual(status.route, 'execute-phase');
    assert.strictEqual(initBundle(projectDir).phase_completion.implementation_complete, true);
  });
});
