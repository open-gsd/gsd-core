'use strict';

/**
 * text-contracts.batch11.test.cjs
 *
 * Detection cases for the 6 text contracts of ADR-6315 item 19 batch 11 (#6583, #6337): each contract against a
 * copy of the files it reads with one phrase removed or added, the bounds of its patterns at limit - 1, the limit and
 * limit + 1, and a removed-file case. The real files are checked once, in scripts/run-static-checks.cjs. The engine and
 * the earlier contracts are in tests/text-contracts.test.cjs.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');

const { cleanup } = require('./helpers.cjs');
const textContracts = require('../scripts/static-checks/text-contracts.cjs');
const SHIPPED = require('./helpers/text-contracts-batch11-ids.cjs');

const REPO_ROOT = path.join(__dirname, '..');

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => cleanup(dir));
  return dir;
}

function write(root, rel, text) {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

const erase = (pattern) => (text) => text.replace(pattern, '');
const eraseAll = (phrase) => (text) => text.split(phrase).join('');
const swap = (from, to) => (text) => text.split(from).join(to);
const append = (line) => (text) => `${text}\n${line}\n`;
const within = (from, to, edit) => (text) => {
  const at = text.indexOf(from);
  const end = text.indexOf(to, at + from.length);
  return text.slice(0, at) + edit(text.slice(at, end)) + text.slice(end);
};
const yamlEdit = (edit) => (text) => {
  const workflow = yaml.load(text);
  edit(workflow);
  return yaml.dump(workflow, { lineWidth: -1 });
};

describe('the batch 11 contracts hold on the real files, and fail when a contracted phrase goes', () => {
  // The files each contract reads, copied into a temporary root so one phrase can be removed.
  const FILES = [
    '.github/workflows/auto-backmerge.yml',
    '.github/workflows/close-draft-prs-sweep.yml',
    '.github/workflows/close-draft-prs.yml',
    '.github/workflows/pr-target-validator.yml',
    '.github/workflows/pr-title-validator.yml',
    '.github/workflows/require-issue-link.yml',
    'commands/gsd/discuss-phase.md',
    'commands/gsd/update.md',
    'gsd-core/references/autonomous-ui-design-contract.md',
    'gsd-core/references/gate-prompts.md',
    'gsd-core/workflows/autonomous.md',
    'gsd-core/workflows/discuss-phase-assumptions.md',
    'gsd-core/workflows/discuss-phase-power.md',
    'gsd-core/workflows/discuss-phase.md',
    'gsd-core/workflows/discuss-phase/modes/advisor.md',
    'gsd-core/workflows/discuss-phase/modes/auto.md',
    'gsd-core/workflows/discuss-phase/modes/power.md',
    'gsd-core/workflows/new-project.md',
    'gsd-core/workflows/plan-phase.md',
    'gsd-core/workflows/review.md',
    'gsd-core/workflows/ui-phase.md',
    'gsd-core/workflows/update.md',
  ];

  // Files the contracts read that are too large to copy into every case; a case that needs one passes HEAVY.
  const HEAVY = [
    'gsd-core/workflows/add-backlog.md',
    'gsd-core/workflows/add-phase.md',
    'gsd-core/workflows/add-tests.md',
    'gsd-core/workflows/add-todo.md',
    'gsd-core/workflows/ai-integration-phase.md',
    'gsd-core/workflows/analyze-dependencies.md',
    'gsd-core/workflows/audit-fix.md',
    'gsd-core/workflows/audit-milestone.md',
    'gsd-core/workflows/audit-uat.md',
    'gsd-core/workflows/autonomous/steps/converge-banner.md',
    'gsd-core/workflows/autonomous/steps/converge-dispatch-bg.md',
    'gsd-core/workflows/autonomous/steps/converge-dispatch-inline.md',
    'gsd-core/workflows/autonomous/steps/converge-fail-fast.md',
    'gsd-core/workflows/autonomous/steps/converge-loop.md',
    'gsd-core/workflows/autonomous/templates/minimal-context.md',
    'gsd-core/workflows/check-todos.md',
    'gsd-core/workflows/cleanup.md',
    'gsd-core/workflows/code-review-fix.md',
    'gsd-core/workflows/code-review.md',
    'gsd-core/workflows/code-review/steps/dispatch-fix.md',
    'gsd-core/workflows/code-review/steps/structural-pre-pass.md',
    'gsd-core/workflows/complete-milestone.md',
    'gsd-core/workflows/complete-milestone/detail/elaboration.md',
    'gsd-core/workflows/complete-milestone/steps/git-tag.md',
    'gsd-core/workflows/complete-milestone/steps/project-md-evolution-review.md',
    'gsd-core/workflows/complete-milestone/steps/release-map.md',
    'gsd-core/workflows/debug.md',
    'gsd-core/workflows/diagnose-issues.md',
    'gsd-core/workflows/discuss-phase-assumptions/steps/auto-advance-dispatch.md',
    'gsd-core/workflows/discuss-phase/modes/all.md',
    'gsd-core/workflows/discuss-phase/modes/analyze.md',
    'gsd-core/workflows/discuss-phase/modes/batch.md',
    'gsd-core/workflows/discuss-phase/modes/chain.md',
    'gsd-core/workflows/discuss-phase/modes/default.md',
    'gsd-core/workflows/discuss-phase/modes/text.md',
    'gsd-core/workflows/discuss-phase/templates/context.md',
    'gsd-core/workflows/discuss-phase/templates/discussion-log.md',
    'gsd-core/workflows/do.md',
    'gsd-core/workflows/docs-update.md',
    'gsd-core/workflows/docs-update/detail/elaboration.md',
    'gsd-core/workflows/docs-update/steps/dispatch-monorepo-packages.md',
    'gsd-core/workflows/edit-phase.md',
    'gsd-core/workflows/eval-review.md',
    'gsd-core/workflows/execute-phase.md',
    'gsd-core/workflows/execute-phase/detail/elaboration.md',
    'gsd-core/workflows/execute-phase/steps/code-review-disposition.md',
    'gsd-core/workflows/execute-phase/steps/codebase-drift-gate.md',
    'gsd-core/workflows/execute-phase/steps/completion-reconciliation.md',
    'gsd-core/workflows/execute-phase/steps/cross-runtime-executor-dispatch.md',
    'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md',
    'gsd-core/workflows/execute-phase/steps/executor-progress-policy.md',
    'gsd-core/workflows/execute-phase/steps/gap-closure-artifacts.md',
    'gsd-core/workflows/execute-phase/steps/partial-wave.md',
    'gsd-core/workflows/execute-phase/steps/per-plan-executor-routing.md',
    'gsd-core/workflows/execute-phase/steps/per-plan-worktree-gate.md',
    'gsd-core/workflows/execute-phase/steps/post-merge-gate.md',
    'gsd-core/workflows/execute-phase/steps/post-wave-requirements.md',
    'gsd-core/workflows/execute-phase/steps/pre-execute-gate-hooks.md',
    'gsd-core/workflows/execute-phase/steps/protected-branch.md',
    'gsd-core/workflows/execute-phase/steps/ready-wave-gate.md',
    'gsd-core/workflows/execute-phase/steps/regression-gate-run.md',
    'gsd-core/workflows/execute-phase/steps/regression-gate.md',
    'gsd-core/workflows/execute-phase/steps/sequential-root-pin.md',
    'gsd-core/workflows/execute-phase/steps/tdd-applicability-resolution.md',
    'gsd-core/workflows/execute-phase/steps/threat-id-gate.md',
    'gsd-core/workflows/execute-phase/steps/verify-phase-goal.md',
    'gsd-core/workflows/execute-phase/steps/wave-post-gate-hooks.md',
    'gsd-core/workflows/execute-phase/steps/worktree-base-check.md',
    'gsd-core/workflows/execute-phase/steps/worktree-recovery-policy.md',
    'gsd-core/workflows/execute-plan.md',
    'gsd-core/workflows/explore.md',
    'gsd-core/workflows/extract-learnings.md',
    'gsd-core/workflows/fast.md',
    'gsd-core/workflows/forensics.md',
    'gsd-core/workflows/graduation.md',
    'gsd-core/workflows/health.md',
    'gsd-core/workflows/help.md',
    'gsd-core/workflows/help/modes/brief.md',
    'gsd-core/workflows/help/modes/default.md',
    'gsd-core/workflows/help/modes/full.compact.md',
    'gsd-core/workflows/help/modes/full.md',
    'gsd-core/workflows/help/modes/topic.md',
    'gsd-core/workflows/import.md',
    'gsd-core/workflows/inbox.md',
    'gsd-core/workflows/ingest-docs.md',
    'gsd-core/workflows/insert-phase.md',
    'gsd-core/workflows/list-phase-assumptions.md',
    'gsd-core/workflows/list-seeds.md',
    'gsd-core/workflows/list-workspaces.md',
    'gsd-core/workflows/manager.md',
    'gsd-core/workflows/map-codebase.md',
    'gsd-core/workflows/milestone-summary.md',
    'gsd-core/workflows/mvp-phase.md',
    'gsd-core/workflows/new-milestone.md',
    'gsd-core/workflows/new-milestone/steps/project-md-milestone-write.md',
    'gsd-core/workflows/new-milestone/steps/reset-phase-safety.md',
    'gsd-core/workflows/new-project/detail/elaboration.md',
    'gsd-core/workflows/new-project/steps/auto-mode-config.md',
    'gsd-core/workflows/new-project/steps/auto-mode-detection.md',
    'gsd-core/workflows/new-project/steps/codebase-map-offer.md',
    'gsd-core/workflows/new-workspace.md',
    'gsd-core/workflows/next.md',
    'gsd-core/workflows/node-repair.md',
    'gsd-core/workflows/note.md',
    'gsd-core/workflows/onboard.md',
    'gsd-core/workflows/pause-work.md',
    'gsd-core/workflows/plan-phase/detail/elaboration.md',
    'gsd-core/workflows/plan-phase/steps/adr-ingest-express-path.md',
    'gsd-core/workflows/plan-phase/steps/auto-advance-check.md',
    'gsd-core/workflows/plan-phase/steps/chunked-planning-mode.md',
    'gsd-core/workflows/plan-phase/steps/closed-phase-gate.md',
    'gsd-core/workflows/plan-phase/steps/plan-pre-dispatch.md',
    'gsd-core/workflows/plan-phase/steps/prd-express-gate.md',
    'gsd-core/workflows/plan-phase/steps/prd-express-path.md',
    'gsd-core/workflows/plan-phase/steps/research-only-early-exit.md',
    'gsd-core/workflows/plan-phase/steps/research-only-modifiers.md',
    'gsd-core/workflows/plan-phase/steps/reviews-prerequisite.md',
    'gsd-core/workflows/plan-phase/steps/stall-detection-helpers.md',
    'gsd-core/workflows/plan-phase/steps/windows-troubleshooting.md',
    'gsd-core/workflows/plan-review-convergence.md',
    'gsd-core/workflows/plant-seed.md',
    'gsd-core/workflows/pr-branch.md',
    'gsd-core/workflows/profile-user.md',
    'gsd-core/workflows/progress.md',
    'gsd-core/workflows/progress/steps/forensic-audit.md',
    'gsd-core/workflows/progress/steps/mvp-display.md',
    'gsd-core/workflows/quick-batch.md',
    'gsd-core/workflows/quick-batch/steps/batch-init.md',
    'gsd-core/workflows/quick-batch/steps/completion.md',
    'gsd-core/workflows/quick-batch/steps/merge-wave.md',
    'gsd-core/workflows/quick-batch/steps/plan-checker-loop.md',
    'gsd-core/workflows/quick-batch/steps/planner-wave.md',
    'gsd-core/workflows/quick-batch/steps/research-phase.md',
    'gsd-core/workflows/quick-batch/steps/resume-mode.md',
    'gsd-core/workflows/quick-batch/steps/verification-wave.md',
    'gsd-core/workflows/quick-batch/steps/worktree-dispatch.md',
    'gsd-core/workflows/quick.md',
    'gsd-core/workflows/quick/steps/discussion-phase.md',
    'gsd-core/workflows/quick/steps/plan-checker-loop.md',
    'gsd-core/workflows/quick/steps/quick-verification.md',
    'gsd-core/workflows/quick/steps/research-phase.md',
    'gsd-core/workflows/quick/steps/worktree-pre-dispatch-commit.md',
    'gsd-core/workflows/reapply-patches.md',
    'gsd-core/workflows/remove-phase.md',
    'gsd-core/workflows/remove-workspace.md',
    'gsd-core/workflows/resume-project.md',
    'gsd-core/workflows/review/steps/reviewer-instances-note-1.md',
    'gsd-core/workflows/review/steps/reviewer-instances-note-2.md',
    'gsd-core/workflows/scan.md',
    'gsd-core/workflows/secure-phase.md',
    'gsd-core/workflows/session-report.md',
    'gsd-core/workflows/settings-advanced.md',
    'gsd-core/workflows/settings-integrations.md',
    'gsd-core/workflows/settings.md',
    'gsd-core/workflows/ship.md',
    'gsd-core/workflows/sketch-wrap-up.md',
    'gsd-core/workflows/sketch.md',
    'gsd-core/workflows/smart-entry.md',
    'gsd-core/workflows/spec-phase.md',
    'gsd-core/workflows/spike-wrap-up.md',
    'gsd-core/workflows/spike.md',
    'gsd-core/workflows/stats.md',
    'gsd-core/workflows/sync-skills.md',
    'gsd-core/workflows/thread.md',
    'gsd-core/workflows/transition.md',
    'gsd-core/workflows/transition/steps/workstream-collision-check.md',
    'gsd-core/workflows/ui-review.md',
    'gsd-core/workflows/ultraplan-phase.md',
    'gsd-core/workflows/undo.md',
    'gsd-core/workflows/update/steps/channel-banner.md',
    'gsd-core/workflows/validate-phase.md',
    'gsd-core/workflows/verify-work.md',
    'gsd-core/workflows/verify-work/detail/elaboration.md',
    'gsd-core/workflows/verify-work/steps/automated-ui-verification.md',
    'gsd-core/workflows/verify-work/steps/mvp-uat-framing.md',
  ];

  function copyOfRepoFiles(t, extra = []) {
    const root = tempDir(t, 'gsd-text-contracts-b11-');
    for (const rel of [...FILES, ...extra]) write(root, rel, fs.readFileSync(path.join(REPO_ROOT, ...rel.split('/')), 'utf8'));
    return root;
  }

  // The pinned minimum counts the whole directory; a run limited to some contracts must find those.
  const runShipped = (root, only = SHIPPED) => textContracts.run({ root, only, minContracts: only.length });

  const passes = (title, rel, edit, contract) => test(title, (t) => {
    const root = copyOfRepoFiles(t);
    const abs = path.join(root, ...rel.split('/'));
    const before = fs.readFileSync(abs, 'utf8');
    const after = edit(before);
    assert.notEqual(after, before, 'the edit changed the file');
    fs.writeFileSync(abs, after);
    assert.deepEqual(runShipped(root, [contract]), []);
  });

  const findsOne = (title, rel, edit, contract, expected) => test(title, (t) => {
    const root = copyOfRepoFiles(t);
    const abs = path.join(root, ...rel.split('/'));
    const before = fs.readFileSync(abs, 'utf8');
    const after = edit(before);
    assert.notEqual(after, before, 'the edit changed the file');
    fs.writeFileSync(abs, after);
    const findings = runShipped(root, [contract]);
    assert.equal(findings.length, 1, JSON.stringify(findings));
    // A string is matched literally (no regex is built from data); a RegExp is matched as given.
    if (typeof expected === 'string') assert.ok(findings[0].message.includes(expected), `expected "${expected}" in ${findings[0].message}`);
    else assert.match(findings[0].message, expected);
  });

  test('an untouched copy of the files satisfies every batch 11 contract', (t) => {
    assert.deepEqual(runShipped(copyOfRepoFiles(t, HEAVY)), []);
  });

  for (const [title, rel, edit, contract, expected] of [
    // autonomous-ui-steps
    ['the pointer to the reference gone from the host', 'gsd-core/workflows/autonomous.md', swap('Read and execute: `$HOME/.claude/gsd-core/references/autonomous-ui-design-contract.md`', 'Read the reference.'), 'autonomous-ui-steps', /autonomous\.md must still contain the §3a\.5 reference pointer/],
    ['the §3a.5 heading renamed', 'gsd-core/workflows/autonomous.md', swap('**3a.5.', '**3a.6.'), 'autonomous-ui-steps', /the §3a\.5 section must be delimited/],
    ['every **3b. heading after §3a.5 renamed', 'gsd-core/workflows/autonomous.md', (text) => { const at = text.indexOf('**3a.5.'); return text.slice(0, at) + text.slice(at).split('**3b.').join('**3c.'); }, 'autonomous-ui-steps', /the §3a\.5 section must be delimited/],
    ['loop render-hooks plan:pre gone from the reference', 'gsd-core/references/autonomous-ui-design-contract.md', eraseAll('loop render-hooks plan:pre'), 'autonomous-ui-steps', /§3a\.5 must dispatch `loop render-hooks plan:pre` to resolve active capability hooks/],
    ['check ui-plan-gate gone from the reference', 'gsd-core/references/autonomous-ui-design-contract.md', eraseAll('check ui-plan-gate'), 'autonomous-ui-steps', /§3a\.5 must call `check ui-plan-gate` to gate on frontend indicators and existing UI-SPEC/],
    ['the frontend field gone from the reference', 'gsd-core/references/autonomous-ui-design-contract.md', eraseAll('frontend'), 'autonomous-ui-steps', /§3a\.5 must read the `frontend` field from the gate result/],
    ['the hasUiSpec field gone from the reference', 'gsd-core/references/autonomous-ui-design-contract.md', eraseAll('hasUiSpec'), 'autonomous-ui-steps', /§3a\.5 must read the `hasUiSpec` field from the gate result/],
    ['the gsd- prefix dispatch gone from the reference', 'gsd-core/references/autonomous-ui-design-contract.md', eraseAll('gsd-${ref.skill}'), 'autonomous-ui-steps', /§3a\.5 must construct skill name via `gsd-\$\{ref\.skill\}` prefix \(matches §3d\.5 style\)/],
    ['ui-safety-gate.cjs inlined in the reference', 'gsd-core/references/autonomous-ui-design-contract.md', append('node ui-safety-gate.cjs'), 'autonomous-ui-steps', /§3a\.5 must NOT inline ui-safety-gate\.cjs \(replaced by check ui-plan-gate\)/],
    ['a RUNTIME_DIR probe in the reference', 'gsd-core/references/autonomous-ui-design-contract.md', append('RUNTIME_DIR=/x'), 'autonomous-ui-steps', /§3a\.5 must NOT probe RUNTIME_DIR \(replaced by check ui-plan-gate via capability registry\)/],
    ['config-get workflow.ui_phase inlined in the reference', 'gsd-core/references/autonomous-ui-design-contract.md', append('gsd_run query config-get workflow.ui_phase'), 'autonomous-ui-steps', /§3a\.5 must NOT inline `config-get workflow\.ui_phase` — toggle is owned by the capability registry/],
    ['EXIT in the reference', 'gsd-core/references/autonomous-ui-design-contract.md', append('EXIT here'), 'autonomous-ui-steps', /§3a\.5 must NOT introduce any gate-halt or exit — it is step-only and non-blocking/],
    ['exit the in the reference', 'gsd-core/references/autonomous-ui-design-contract.md', append('exit the workflow'), 'autonomous-ui-steps', /§3a\.5 must NOT introduce any gate-halt or exit — it is step-only and non-blocking/],
    ['halt in the reference', 'gsd-core/references/autonomous-ui-design-contract.md', append('halt now'), 'autonomous-ui-steps', /§3a\.5 must NOT introduce any gate-halt or exit — it is step-only and non-blocking/],
    ['the kind == "step" filter gone from the reference', 'gsd-core/references/autonomous-ui-design-contract.md', eraseAll('kind == "step"'), 'autonomous-ui-steps', /§3a\.5 must gate the skip decision on kind=="step" entries/],
    ['the no-active-step phrase gone from the reference', 'gsd-core/references/autonomous-ui-design-contract.md', (text) => [eraseAll('NO active step'), eraseAll('no active step')].reduce((value, edit) => edit(value), text), 'autonomous-ui-steps', /§3a\.5 skip condition must reference "no active step hook\(s\)" — not just empty activeHooks/],
    ['"empty or absent" used as the skip condition', 'gsd-core/references/autonomous-ui-design-contract.md', append('Skip when activeHooks is empty or absent.'), 'autonomous-ui-steps', /§3a\.5 must NOT use "empty or absent" as the skip condition — that misses gate-only sets/],
    ['the gate-only case undocumented in the reference', 'gsd-core/references/autonomous-ui-design-contract.md', (text) => [eraseAll('ui_phase'), eraseAll('ui_safety_gate'), eraseAll('gate-only')].reduce((value, edit) => edit(value), text), 'autonomous-ui-steps', /§3a\.5 must document the gate-only \/ ui_phase=false silent-skip case/],
    ['check ui-plan-gate named before the step filter', 'gsd-core/references/autonomous-ui-design-contract.md', (text) => 'check ui-plan-gate ' + text, 'autonomous-ui-steps', /§3a\.5 must check for active step hooks BEFORE running check ui-plan-gate/],
    ['gate entries no longer ignored', 'gsd-core/references/autonomous-ui-design-contract.md', (text) => [eraseAll('silently'), eraseAll('ignored')].reduce((value, edit) => edit(value), text), 'autonomous-ui-steps', /§3a\.5 must explicitly note kind=="gate" entries are silently ignored/],
    ['**3b. Plan** named before the §3a.5 heading', 'gsd-core/workflows/autonomous.md', (text) => '**3b. Plan** ' + text, 'autonomous-ui-steps', /step 3a\.5 \(UI design contract\) should appear before step 3b \(plan\)/],
    ['the §3d.5 step gone', 'gsd-core/workflows/autonomous.md', eraseAll('3d.5'), 'autonomous-ui-steps', /the §3d\.5 step must be present/],
    ['no closing step tag after §3d.5', 'gsd-core/workflows/autonomous.md', (text) => { const at = text.indexOf('3d.5'); return text.slice(0, at) + text.slice(at).split('</step>').join(''); }, 'autonomous-ui-steps', /<\/step> must follow §3d\.5/],
    ['the verify:post dispatch gone from §3d.5', 'gsd-core/workflows/autonomous.md', within('3d.5', '</step>', eraseAll('loop render-hooks verify:post')), 'autonomous-ui-steps', /§3d\.5 must dispatch `loop render-hooks verify:post` to resolve active capability hooks/],
    ['the gsd- prefix dispatch gone from §3d.5', 'gsd-core/workflows/autonomous.md', within('3d.5', '</step>', eraseAll('gsd-${ref.skill}')), 'autonomous-ui-steps', /§3d\.5 must construct skill name via `gsd-\$\{ref\.skill\}` prefix \(capability-driven dispatch\)/],
    ['UI_SPEC_FILE gone from §3d.5', 'gsd-core/workflows/autonomous.md', within('3d.5', '</step>', eraseAll('UI_SPEC_FILE')), 'autonomous-ui-steps', /§3d\.5 must gate on UI_SPEC_FILE for hooks that consume UI-SPEC\.md/],
    ['§3d.5 no longer advisory', 'gsd-core/workflows/autonomous.md', within('3d.5', '</step>', (text) => [eraseAll('advisory'), eraseAll('non-blocking'), eraseAll('regardless of result')].reduce((value, edit) => edit(value), text)), 'autonomous-ui-steps', /§3d\.5 must be explicitly advisory\/non-blocking/],
    ['consumes gone after §3d.5', 'gsd-core/workflows/autonomous.md', (text) => { const at = text.indexOf('3d.5'); return text.slice(0, at) + text.slice(at).split('consumes').join(''); }, 'autonomous-ui-steps', /UI review step should reference hook consumes array for the UI-SPEC gate/],
    ['config-get workflow.ui_review inlined in §3d.5', 'gsd-core/workflows/autonomous.md', within('3d.5', '</step>', append('gsd_run query config-get workflow.ui_review')), 'autonomous-ui-steps', /§3d\.5 must NOT inline `config-get workflow\.ui_review` — the toggle is owned by the capability registry/],
    ['the 3d heading moved after §3d.5', 'gsd-core/workflows/autonomous.md', (text) => text.split('**3d. Post-Execution Routing**').join('') + '\n**3d. Post-Execution Routing**\n', 'autonomous-ui-steps', /step 3d\.5 \(UI review\) should appear after step 3d \(post-execution routing\)/],
    ['the 3d heading gone', 'gsd-core/workflows/autonomous.md', eraseAll('**3d. Post-Execution Routing**'), 'autonomous-ui-steps', /\*\*3d\. Post-Execution Routing\*\* not found/],
    ['the **3b. Plan** heading gone', 'gsd-core/workflows/autonomous.md', swap('**3b. Plan**', '**3b.Plan**'), 'autonomous-ui-steps', /\*\*3b\. Plan\*\* not found/],
    ['ui-review gone from the host', 'gsd-core/workflows/autonomous.md', eraseAll('ui-review'), 'autonomous-ui-steps', /success criteria should reference ui-phase and ui-review/],
    ['Frontend phases gone from the host', 'gsd-core/workflows/autonomous.md', eraseAll('Frontend phases'), 'autonomous-ui-steps', /success criteria should mention frontend phases/],
    ['the success criteria block gone', 'gsd-core/workflows/autonomous.md', swap('<success_criteria>', '<criteria>'), 'autonomous-ui-steps', /the success criteria block must be present/],
    ['the success criteria no longer advisory', 'gsd-core/workflows/autonomous.md', (text) => { const at = text.indexOf('<success_criteria>'); return text.slice(0, at) + text.slice(at).split('advisory').join('').split('non-blocking').join(''); }, 'autonomous-ui-steps', /success criteria should note UI review is advisory\/non-blocking/],
    // discuss-phase-power
    ['--power gone from the command', 'commands/gsd/discuss-phase.md', eraseAll('--power'), 'discuss-phase-power', /commands\/gsd\/discuss-phase\.md should document the --power flag/],
    ['discuss-phase-power gone from the command', 'commands/gsd/discuss-phase.md', eraseAll('discuss-phase-power'), 'discuss-phase-power', /command file should reference discuss-phase-power workflow/],
    ['--power gone from the workflow', 'gsd-core/workflows/discuss-phase.md', eraseAll('--power'), 'discuss-phase-power', /discuss-phase\.md should describe --power flag handling/],
    ['the generate_json step renamed', 'gsd-core/workflows/discuss-phase-power.md', swap('<step name="generate_json">', '<step name="build_json">'), 'discuss-phase-power', /power workflow should describe generating questions/],
    ['the notify_user step renamed', 'gsd-core/workflows/discuss-phase-power.md', swap('<step name="notify_user">', '<step name="tell_user">'), 'discuss-phase-power', /power workflow should describe the notify step after generating files/],
    ['the wait_loop step renamed', 'gsd-core/workflows/discuss-phase-power.md', swap('<step name="wait_loop">', '<step name="listen">'), 'discuss-phase-power', /marker "<step name=\\"wait_loop\\">" not found/],
    ['the refresh handler gone from the wait loop', 'gsd-core/workflows/discuss-phase-power.md', swap('**"refresh"**', '**"reload"**'), 'discuss-phase-power', /power workflow should describe the refresh step for processing answers/],
    ['the finalize step renamed', 'gsd-core/workflows/discuss-phase-power.md', swap('<step name="finalize">', '<step name="wrap_up">'), 'discuss-phase-power', /power workflow should describe the finalize step for generating CONTEXT\.md/],
    ['QUESTIONS.json gone', 'gsd-core/workflows/discuss-phase-power.md', eraseAll('QUESTIONS.json'), 'discuss-phase-power', /should mention QUESTIONS\.json file/],
    ['"phase" gone', 'gsd-core/workflows/discuss-phase-power.md', eraseAll('"phase"'), 'discuss-phase-power', /JSON structure should include phase field/],
    ['"stats" gone', 'gsd-core/workflows/discuss-phase-power.md', eraseAll('"stats"'), 'discuss-phase-power', /JSON structure should include stats field/],
    ['"sections" gone', 'gsd-core/workflows/discuss-phase-power.md', eraseAll('"sections"'), 'discuss-phase-power', /JSON structure should include sections field/],
    ['"id" gone', 'gsd-core/workflows/discuss-phase-power.md', eraseAll('"id"'), 'discuss-phase-power', /JSON structure should include question id and title fields/],
    ['"title" gone', 'gsd-core/workflows/discuss-phase-power.md', eraseAll('"title"'), 'discuss-phase-power', /JSON structure should include question id and title fields/],
    ['"options" gone', 'gsd-core/workflows/discuss-phase-power.md', eraseAll('"options"'), 'discuss-phase-power', /JSON structure should include options array/],
    ['"answer" gone', 'gsd-core/workflows/discuss-phase-power.md', eraseAll('"answer"'), 'discuss-phase-power', /JSON structure should include answer field/],
    ['"status" gone', 'gsd-core/workflows/discuss-phase-power.md', eraseAll('"status"'), 'discuss-phase-power', /JSON structure should include status field/],
    ['QUESTIONS.html gone', 'gsd-core/workflows/discuss-phase-power.md', eraseAll('QUESTIONS.html'), 'discuss-phase-power', /power workflow should describe generating the HTML companion file/],
    ['HTML gone', 'gsd-core/workflows/discuss-phase-power.md', eraseAll('HTML'), 'discuss-phase-power', /power workflow should mention HTML output/],
    ['{padded_phase} gone', 'gsd-core/workflows/discuss-phase-power.md', eraseAll('{padded_phase}'), 'discuss-phase-power', /power workflow should describe file naming with padded phase number/],
    ['the subagent_type declaration gone from advisor mode', 'gsd-core/workflows/discuss-phase/modes/advisor.md', eraseAll('subagent_type='), 'discuss-phase-power', /advisor\.md must contain an Agent\(\) subagent_type declaration/],
    ['the registered advisor agent gone', 'gsd-core/workflows/discuss-phase/modes/advisor.md', swap('subagent_type="gsd-advisor-researcher"', 'subagent_type="gsd-other"'), 'discuss-phase-power', /advisor mode must spawn subagent_type="gsd-advisor-researcher" \(the registered agent def auto-loads\) — not general-purpose \(#2771\)/],
    ['advisor mode spawns general-purpose', 'gsd-core/workflows/discuss-phase/modes/advisor.md', append('Agent(subagent_type="general-purpose")'), 'discuss-phase-power', /advisor mode must NOT spawn subagent_type="general-purpose" \(#2771\)/],
    ['advisor mode reads the agent definition by hand', 'gsd-core/workflows/discuss-phase/modes/advisor.md', append('Read @~/.claude/agents/gsd-advisor-researcher.md first'), 'discuss-phase-power', /advisor mode must not manually instruct reading the agent def — spawning by type auto-loads it \(#2771\)/],
    ['the single-pass rule gone from auto mode', 'gsd-core/workflows/discuss-phase/modes/auto.md', (text) => text.replace(/single pass/gi, "one round"), 'discuss-phase-power', /auto\.md must still mandate the single-pass rule/],
    ['MAX_PASSES= read in auto mode', 'gsd-core/workflows/discuss-phase/modes/auto.md', append('MAX_PASSES=3'), 'discuss-phase-power', /auto\.md must not read MAX_PASSES \(dead config — single-pass rule governs\) \(#2772\)/],
    ['max_discuss_passes referenced in auto mode', 'gsd-core/workflows/discuss-phase/modes/auto.md', append('config max_discuss_passes'), 'discuss-phase-power', /auto\.md must not reference max_discuss_passes \(contradicts the single-pass rule\) \(#2772\)/],
    ['the check_existing options gone from context-handling', 'gsd-core/references/gate-prompts.md', swap('Update it | View it | Skip', 'Update | View | Skip'), 'discuss-phase-power', /context-handling options must be "Update it \| View it \| Skip" \(the actual check_existing flow\) \(#2772\)/],
    ['the obsolete options documented in context-handling', 'gsd-core/references/gate-prompts.md', within('## Pattern: context-handling', '## Pattern: gray-area-option', (text) => `${text}Overwrite | Append | Cancel\n\n`), 'discuss-phase-power', /context-handling must NOT document the obsolete "Overwrite \| Append \| Cancel" \(#2772\)/],
    ['the context-handling marker gone', 'gsd-core/references/gate-prompts.md', swap('## Pattern: context-handling', '## Pattern: contexts'), 'discuss-phase-power', /marker "## Pattern: context-handling" not found/],
    ['the gray-area-option marker gone', 'gsd-core/references/gate-prompts.md', swap('## Pattern: gray-area-option', '## Pattern: gray-areas'), 'discuss-phase-power', /marker "## Pattern: gray-area-option" not found/],
    ['gray-area-option mandates Let Claude decide', 'gsd-core/references/gate-prompts.md', append('Always include "Let Claude decide" as the last option.'), 'discuss-phase-power', /gray-area-option must NOT mandate "Let Claude decide" \(#2772\)/],
    ['auto_advance of discuss-phase routes back', 'gsd-core/workflows/discuss-phase.md', within('<step name="auto_advance">', '</step>', (text) => `${text}route to \`confirm_creation\`\n`), 'discuss-phase-power', /discuss-phase auto_advance fallback must not route back to confirm_creation \(circular\) \(#2772\)/],
    ['auto_advance of discuss-phase no longer ends', 'gsd-core/workflows/discuss-phase.md', within('<step name="auto_advance">', '</step>', (text) => text.replace(/end here|workflow is complete/gi, "stop")), 'discuss-phase-power', /discuss-phase auto_advance fallback must explicitly END the workflow \(#2772\)/],
    ['auto_advance of assumptions routes back', 'gsd-core/workflows/discuss-phase-assumptions.md', within('<step name="auto_advance">', '</step>', (text) => `${text}Route to confirm_creation step\n`), 'discuss-phase-power', /discuss-phase-assumptions auto_advance fallback must not route back to confirm_creation \(circular\) \(#2772\)/],
    ['auto_advance of assumptions no longer ends', 'gsd-core/workflows/discuss-phase-assumptions.md', within('<step name="auto_advance">', '</step>', (text) => text.replace(/end here|workflow is complete/gi, "stop")), 'discuss-phase-power', /discuss-phase-assumptions auto_advance fallback must explicitly END the workflow \(#2772\)/],
    ['the Other empty-text branch gone from the assumptions answer_validation', 'gsd-core/workflows/discuss-phase-assumptions.md', within('<answer_validation>', '</answer_validation>', eraseAll('"Other" with empty text')), 'discuss-phase-power', /assumptions answer_validation must include the "Other" empty-text branch \(was drifted\) \(#2772\)/],
    ['the parent answer_validation drifted from the assumptions copy', 'gsd-core/workflows/discuss-phase.md', within('<answer_validation>', '</answer_validation>', (text) => `${text} (drift)`), 'discuss-phase-power', /discuss-phase-assumptions answer_validation must match the parent canonical block exactly \(single source of truth\) \(#2772\)/],
    ['the answer_validation block gone from the parent', 'gsd-core/workflows/discuss-phase.md', swap('<answer_validation>', '<validation>'), 'discuss-phase-power', /marker "<answer_validation>" not found/],
    ['the check_spec step of default renamed', 'gsd-core/workflows/discuss-phase.md', swap('<step name="check_spec">', '<step name="spec_check">'), 'discuss-phase-power', /marker "<step name=\\"check_spec\\">" not found/],
    ['has_spec gone from check_spec of default', 'gsd-core/workflows/discuss-phase.md', within('<step name="check_spec">', '</step>', eraseAll('has_spec')), 'discuss-phase-power', /default: check_spec reads the init facts has_spec \/ spec_path/],
    ['spec_path gone from check_spec of default', 'gsd-core/workflows/discuss-phase.md', within('<step name="check_spec">', '</step>', eraseAll('spec_path')), 'discuss-phase-power', /default: check_spec reads the init facts has_spec \/ spec_path/],
    ['spec_loaded gone from check_spec of default', 'gsd-core/workflows/discuss-phase.md', within('<step name="check_spec">', '</step>', eraseAll('spec_loaded = true')), 'discuss-phase-power', /default: check_spec sets spec_loaded/],
    ['locked_requirements gone from check_spec of default', 'gsd-core/workflows/discuss-phase.md', within('<step name="check_spec">', '</step>', eraseAll('locked_requirements')), 'discuss-phase-power', /default: check_spec stores the locked requirements/],
    ['<spec_lock> gone from default', 'gsd-core/workflows/discuss-phase.md', eraseAll('<spec_lock>'), 'discuss-phase-power', /default: the CONTEXT\.md it writes carries <spec_lock>/],
    ['the canonical_refs line gone from default', 'gsd-core/workflows/discuss-phase.md', eraseAll('Locked requirements — MUST read before planning'), 'discuss-phase-power', /default: the SPEC is listed in canonical_refs/],
    ['the check_spec step of assumptions renamed', 'gsd-core/workflows/discuss-phase-assumptions.md', swap('<step name="check_spec">', '<step name="spec_check">'), 'discuss-phase-power', /marker "<step name=\\"check_spec\\">" not found/],
    ['has_spec gone from check_spec of assumptions', 'gsd-core/workflows/discuss-phase-assumptions.md', within('<step name="check_spec">', '</step>', eraseAll('has_spec')), 'discuss-phase-power', /assumptions: check_spec reads the init facts has_spec \/ spec_path/],
    ['spec_path gone from check_spec of assumptions', 'gsd-core/workflows/discuss-phase-assumptions.md', within('<step name="check_spec">', '</step>', eraseAll('spec_path')), 'discuss-phase-power', /assumptions: check_spec reads the init facts has_spec \/ spec_path/],
    ['spec_loaded gone from check_spec of assumptions', 'gsd-core/workflows/discuss-phase-assumptions.md', within('<step name="check_spec">', '</step>', eraseAll('spec_loaded = true')), 'discuss-phase-power', /assumptions: check_spec sets spec_loaded/],
    ['locked_requirements gone from check_spec of assumptions', 'gsd-core/workflows/discuss-phase-assumptions.md', within('<step name="check_spec">', '</step>', eraseAll('locked_requirements')), 'discuss-phase-power', /assumptions: check_spec stores the locked requirements/],
    ['<spec_lock> gone from assumptions', 'gsd-core/workflows/discuss-phase-assumptions.md', eraseAll('<spec_lock>'), 'discuss-phase-power', /assumptions: the CONTEXT\.md it writes carries <spec_lock>/],
    ['the canonical_refs line gone from assumptions', 'gsd-core/workflows/discuss-phase-assumptions.md', eraseAll('Locked requirements — MUST read before planning'), 'discuss-phase-power', /assumptions: the SPEC is listed in canonical_refs/],
    ['the check_spec step of power renamed', 'gsd-core/workflows/discuss-phase-power.md', swap('<step name="check_spec">', '<step name="spec_check">'), 'discuss-phase-power', /marker "<step name=\\"check_spec\\">" not found/],
    ['has_spec gone from check_spec of power', 'gsd-core/workflows/discuss-phase-power.md', within('<step name="check_spec">', '</step>', eraseAll('has_spec')), 'discuss-phase-power', /power: check_spec reads the init facts has_spec \/ spec_path/],
    ['spec_path gone from check_spec of power', 'gsd-core/workflows/discuss-phase-power.md', within('<step name="check_spec">', '</step>', eraseAll('spec_path')), 'discuss-phase-power', /power: check_spec reads the init facts has_spec \/ spec_path/],
    ['spec_loaded gone from check_spec of power', 'gsd-core/workflows/discuss-phase-power.md', within('<step name="check_spec">', '</step>', eraseAll('spec_loaded = true')), 'discuss-phase-power', /power: check_spec sets spec_loaded/],
    ['locked_requirements gone from check_spec of power', 'gsd-core/workflows/discuss-phase-power.md', within('<step name="check_spec">', '</step>', eraseAll('locked_requirements')), 'discuss-phase-power', /power: check_spec stores the locked requirements/],
    ['<spec_lock> gone from power', 'gsd-core/workflows/discuss-phase-power.md', eraseAll('<spec_lock>'), 'discuss-phase-power', /power: the CONTEXT\.md it writes carries <spec_lock>/],
    ['the canonical_refs line gone from power', 'gsd-core/workflows/discuss-phase-power.md', eraseAll('Locked requirements — MUST read before planning'), 'discuss-phase-power', /power: the SPEC is listed in canonical_refs/],
    ['HOW gone from the default what-to-discuss step', 'gsd-core/workflows/discuss-phase.md', within('2b. **SPEC.md awareness**', '3. **Gray areas**', swap('HOW', 'how')), 'discuss-phase-power', /default: the step that picks what to discuss restricts it to HOW \(WHAT is already locked\)/],
    ['WHAT gone from the default what-to-discuss step', 'gsd-core/workflows/discuss-phase.md', within('2b. **SPEC.md awareness**', '3. **Gray areas**', swap('WHAT', 'what')), 'discuss-phase-power', /default: the step that picks what to discuss restricts it to HOW \(WHAT is already locked\)/],
    ['HOW gone from the assumptions analyzer prompt', 'gsd-core/workflows/discuss-phase-assumptions.md', within('Agent(subagent_type="gsd-assumptions-analyzer"', '${AGENT_SKILLS_ANALYZER}\n""")', swap('HOW', 'how')), 'discuss-phase-power', /assumptions: the step that picks what to discuss restricts it to HOW \(WHAT is already locked\)/],
    ['WHAT gone from the assumptions analyzer prompt', 'gsd-core/workflows/discuss-phase-assumptions.md', within('Agent(subagent_type="gsd-assumptions-analyzer"', '${AGENT_SKILLS_ANALYZER}\n""")', swap('WHAT', 'what')), 'discuss-phase-power', /assumptions: the step that picks what to discuss restricts it to HOW \(WHAT is already locked\)/],
    ['HOW gone from the power analyze step', 'gsd-core/workflows/discuss-phase-power.md', within('<step name="analyze">', '</step>', swap('HOW', 'how')), 'discuss-phase-power', /power: the step that picks what to discuss restricts it to HOW \(WHAT is already locked\)/],
    ['WHAT gone from the power analyze step', 'gsd-core/workflows/discuss-phase-power.md', within('<step name="analyze">', '</step>', swap('WHAT', 'what')), 'discuss-phase-power', /power: the step that picks what to discuss restricts it to HOW \(WHAT is already locked\)/],
    ['the assumptions check_spec drifted from the default', 'gsd-core/workflows/discuss-phase-assumptions.md', within('<step name="check_spec">', '</step>', (text) => `${text} (drift)`), 'discuss-phase-power', /assumptions check_spec matches the default flow exactly \(single source of truth\)/],
    ['the power check_spec drifted from the default', 'gsd-core/workflows/discuss-phase-power.md', within('<step name="check_spec">', '</step>', (text) => `${text} (drift)`), 'discuss-phase-power', /power check_spec matches the default flow exactly \(single source of truth\)/],
    ['the analyze step named before check_spec in power', 'gsd-core/workflows/discuss-phase-power.md', (text) => '<step name="analyze">\n</step>\n' + text, 'discuss-phase-power', /check_spec runs before analyze: --power is dispatched past discuss-phase\.md check_spec/],
    ['the analyzer step named before check_spec in assumptions', 'gsd-core/workflows/discuss-phase-assumptions.md', (text) => '<step name="deep_codebase_analysis">\n</step>\n' + text, 'discuss-phase-power', /check_spec runs before the analyzer step/],
    ['the locked requirements gone from the analyzer prompt', 'gsd-core/workflows/discuss-phase-assumptions.md', within('Agent(subagent_type="gsd-assumptions-analyzer"', '${AGENT_SKILLS_ANALYZER}\n""")', eraseAll('{locked_requirements}')), 'discuss-phase-power', /the analyzer prompt carries the locked requirements/],
    ['plan-phase no longer reads spec_path from init', 'gsd-core/workflows/plan-phase.md', eraseAll('_gsd_field "$INIT" spec_path'), 'discuss-phase-power', /plan-phase\.md reads spec_path from its init payload/],
    ['plan-phase filters SPEC names itself', 'gsd-core/workflows/plan-phase.md', append('find x -name "*-SPEC.md" 2>/dev/null | grep y'), 'discuss-phase-power', /workflows read has_spec \/ spec_path from init instead of an ls over \*-SPEC\.md/],
    ['plan-phase lists the SPEC with ls', 'gsd-core/workflows/plan-phase.md', append('ls $d/*-SPEC.md'), 'discuss-phase-power', /workflows read has_spec \/ spec_path from init instead of an ls over \*-SPEC\.md/],
    ['discuss-phase lists the SPEC with its own ls', 'gsd-core/workflows/discuss-phase.md', append('ls ${phase_dir}/*-SPEC.md'), 'discuss-phase-power', /workflows read has_spec \/ spec_path from init instead of an ls over \*-SPEC\.md/],
    ['a workflow globs for the SPEC', 'gsd-core/workflows/discuss-phase/modes/auto.md', append('ls .planning/phases/*/*-SPEC.md'), 'discuss-phase-power', /workflows read has_spec \/ spec_path from init instead of an ls over \*-SPEC\.md/],
    // workflow-maintainer-skip
    ['the draft condition gone from close-draft-prs', '.github/workflows/close-draft-prs.yml', eraseAll('github.event.pull_request.draft == true'), 'workflow-maintainer-skip', /draft PR auto-close must act on draft PRs/],
    ['the maintainer carve-out gone from close-draft-prs', '.github/workflows/close-draft-prs.yml', swap('contains(fromJSON(\'["OWNER","MEMBER","COLLABORATOR"]\'), github.event.pull_request.author_association) == false', 'true'), 'workflow-maintainer-skip', /Expected workflow to include maintainer skip expression/],
    ['the maintainer carve-out gone from the target validator', '.github/workflows/pr-target-validator.yml', swap('contains(fromJSON(\'["OWNER","MEMBER","COLLABORATOR"]\'), github.event.pull_request.author_association) == false', 'true'), 'workflow-maintainer-skip', /Expected workflow to include maintainer skip expression/],
    ['close-draft-prs back on the bare pull_request trigger', '.github/workflows/close-draft-prs.yml', swap('pull_request_target:', 'pull_request:'), 'workflow-maintainer-skip', /draft PR auto-close triggers on pull_request_target so fork PRs cannot bypass it/],
    ['close-draft-prs gains a bare pull_request trigger', '.github/workflows/close-draft-prs.yml', append('  pull_request:'), 'workflow-maintainer-skip', /draft PR auto-close must not use the bypassable pull_request trigger/],
    ['PR title validator on the bare pull_request trigger', '.github/workflows/pr-title-validator.yml', swap('pull_request_target:', 'pull_request:'), 'workflow-maintainer-skip', /PR title validator triggers on pull_request_target so fork PRs get the verdict, not a 403/],
    ['PR title validator gains a bare pull_request trigger', '.github/workflows/pr-title-validator.yml', append('  pull_request:'), 'workflow-maintainer-skip', /PR title validator must not use the bare pull_request trigger \(a fork's read-only token 403s the comment\)/],
    ['PR title validator loses its write scope', '.github/workflows/pr-title-validator.yml', swap('pull-requests: write', 'pull-requests: read'), 'workflow-maintainer-skip', /PR title validator keeps the one write scope its comment call needs/],
    ['PR title validator gains the other write scope', '.github/workflows/pr-title-validator.yml', append('  issues: write'), 'workflow-maintainer-skip', /\.github\/workflows\/pr-title-validator\.yml does not call a issues\.\* API — do not grant it write on a pull_request_target workflow/],
    ['PR title validator without its try block', '.github/workflows/pr-title-validator.yml', swap('try {', 'if (true) {'), 'workflow-maintainer-skip', /PR title validator cannot let a failed comment suppress its verdict: the comment sits in a try/],
    ['PR title validator without the catch warning', '.github/workflows/pr-title-validator.yml', swap('core.warning', 'core.info'), 'workflow-maintainer-skip', /PR title validator cannot let a failed comment suppress its verdict: the catch warns/],
    ['PR title validator without the Could not post catch text', '.github/workflows/pr-title-validator.yml', swap('Could not post', 'Failed to post'), 'workflow-maintainer-skip', /core\.setFailed must sit AFTER the catch block, not inside the try — otherwise a thrown comment error skips the verdict \(#2331\)/],
    ['PR title validator with the verdict before the catch', '.github/workflows/pr-title-validator.yml', (text) => "core.setFailed('x');\n" + text, 'workflow-maintainer-skip', /core\.setFailed must sit AFTER the catch block, not inside the try — otherwise a thrown comment error skips the verdict \(#2331\)/],
    ['PR title validator sanitizer renamed', '.github/workflows/pr-title-validator.yml', swap('const titleForMarkdown = String(', 'const safeValue = String('), 'workflow-maintainer-skip', /PR title validator strips backticks before echoing untrusted text into the comment/],
    ['PR title validator renders the raw value', '.github/workflows/pr-title-validator.yml', swap('\\`${titleForMarkdown}', '\\`${raw}'), 'workflow-maintainer-skip', /PR title validator renders the sanitized titleForMarkdown, never the raw value/],
    ['PR target validator on the bare pull_request trigger', '.github/workflows/pr-target-validator.yml', swap('pull_request_target:', 'pull_request:'), 'workflow-maintainer-skip', /PR target validator triggers on pull_request_target so fork PRs get the verdict, not a 403/],
    ['PR target validator gains a bare pull_request trigger', '.github/workflows/pr-target-validator.yml', append('  pull_request:'), 'workflow-maintainer-skip', /PR target validator must not use the bare pull_request trigger \(a fork's read-only token 403s the comment\)/],
    ['PR target validator loses its write scope', '.github/workflows/pr-target-validator.yml', swap('pull-requests: write', 'pull-requests: read'), 'workflow-maintainer-skip', /PR target validator keeps the one write scope its comment call needs/],
    ['PR target validator gains the other write scope', '.github/workflows/pr-target-validator.yml', append('  issues: write'), 'workflow-maintainer-skip', /\.github\/workflows\/pr-target-validator\.yml does not call a issues\.\* API — do not grant it write on a pull_request_target workflow/],
    ['PR target validator without its try block', '.github/workflows/pr-target-validator.yml', swap('try {', 'if (true) {'), 'workflow-maintainer-skip', /PR target validator cannot let a failed comment suppress its verdict: the comment sits in a try/],
    ['PR target validator without the catch warning', '.github/workflows/pr-target-validator.yml', swap('core.warning', 'core.info'), 'workflow-maintainer-skip', /PR target validator cannot let a failed comment suppress its verdict: the catch warns/],
    ['PR target validator without the Could not post catch text', '.github/workflows/pr-target-validator.yml', swap('Could not post', 'Failed to post'), 'workflow-maintainer-skip', /core\.setFailed must sit AFTER the catch block, not inside the try — otherwise a thrown comment error skips the verdict \(#2331\)/],
    ['PR target validator with the verdict before the catch', '.github/workflows/pr-target-validator.yml', (text) => "core.setFailed('x');\n" + text, 'workflow-maintainer-skip', /core\.setFailed must sit AFTER the catch block, not inside the try — otherwise a thrown comment error skips the verdict \(#2331\)/],
    ['PR target validator sanitizer renamed', '.github/workflows/pr-target-validator.yml', swap('const headForMarkdown = String(', 'const safeValue = String('), 'workflow-maintainer-skip', /PR target validator strips backticks before echoing untrusted text into the comment/],
    ['PR target validator renders the raw value', '.github/workflows/pr-target-validator.yml', swap('\\`${headForMarkdown}', '\\`${raw}'), 'workflow-maintainer-skip', /PR target validator renders the sanitized headForMarkdown, never the raw value/],
    ['Require issue link on the bare pull_request trigger', '.github/workflows/require-issue-link.yml', swap('pull_request_target:', 'pull_request:'), 'workflow-maintainer-skip', /Require issue link triggers on pull_request_target so fork PRs get the verdict, not a 403/],
    ['Require issue link gains a bare pull_request trigger', '.github/workflows/require-issue-link.yml', append('  pull_request:'), 'workflow-maintainer-skip', /Require issue link must not use the bare pull_request trigger \(a fork's read-only token 403s the comment\)/],
    ['Require issue link loses its write scope', '.github/workflows/require-issue-link.yml', swap('issues: write', 'issues: read'), 'workflow-maintainer-skip', /Require issue link keeps the one write scope its comment call needs/],
    ['Require issue link gains the other write scope', '.github/workflows/require-issue-link.yml', append('  pull-requests: write'), 'workflow-maintainer-skip', /\.github\/workflows\/require-issue-link\.yml does not call a pull-requests\.\* API — do not grant it write on a pull_request_target workflow/],
    ['Require issue link without its try block', '.github/workflows/require-issue-link.yml', swap('try {', 'if (true) {'), 'workflow-maintainer-skip', /Require issue link cannot let a failed comment suppress its verdict: the comment sits in a try/],
    ['Require issue link without the catch warning', '.github/workflows/require-issue-link.yml', swap('core.warning', 'core.info'), 'workflow-maintainer-skip', /Require issue link cannot let a failed comment suppress its verdict: the catch warns/],
    ['Require issue link without the Could not post catch text', '.github/workflows/require-issue-link.yml', swap('Could not post', 'Failed to post'), 'workflow-maintainer-skip', /core\.setFailed must sit AFTER the catch block, not inside the try — otherwise a thrown comment error skips the verdict \(#2331\)/],
    ['Require issue link with the verdict before the catch', '.github/workflows/require-issue-link.yml', (text) => "core.setFailed('x');\n" + text, 'workflow-maintainer-skip', /core\.setFailed must sit AFTER the catch block, not inside the try — otherwise a thrown comment error skips the verdict \(#2331\)/],
    ['the sweep without a schedule', '.github/workflows/close-draft-prs-sweep.yml', eraseAll('schedule:'), 'workflow-maintainer-skip', /the draft sweep is timer-driven/],
    ['the sweep on another cron', '.github/workflows/close-draft-prs-sweep.yml', swap('\'0 */6 * * *\'', '\'0 */8 * * *\''), 'workflow-maintainer-skip', /the draft sweep runs every six hours/],
    ['the sweep without a manual dispatch', '.github/workflows/close-draft-prs-sweep.yml', eraseAll('workflow_dispatch:'), 'workflow-maintainer-skip', /the draft sweep has a manual dispatch for testing/],
    ['the sweep gains a pull_request trigger', '.github/workflows/close-draft-prs-sweep.yml', append('  pull_request:'), 'workflow-maintainer-skip', /the draft sweep must not be a fork-triggered event/],
    ['the sweep gains a pull_request_target trigger', '.github/workflows/close-draft-prs-sweep.yml', append('  pull_request_target:'), 'workflow-maintainer-skip', /the draft sweep must not be a fork-triggered event/],
    ['the sweep loses its write token', '.github/workflows/close-draft-prs-sweep.yml', swap('pull-requests: write', 'pull-requests: read'), 'workflow-maintainer-skip', /the draft sweep needs a write-capable token to close PRs/],
    ['the sweep without the carve-out set', '.github/workflows/close-draft-prs-sweep.yml', eraseAll('new Set([\'OWNER\', \'MEMBER\', \'COLLABORATOR\'])'), 'workflow-maintainer-skip', /the draft sweep keeps the maintainer carve-out set/],
    ['the sweep without the association test', '.github/workflows/close-draft-prs-sweep.yml', swap('.author_association)', '.author)'), 'workflow-maintainer-skip', /the draft sweep skips maintainer-authored PRs/],
    ['the sweep without pagination', '.github/workflows/close-draft-prs-sweep.yml', eraseAll('github.paginate(github.rest.pulls.list'), 'workflow-maintainer-skip', /the draft sweep paginates over open PRs/],
    ['the sweep listing closed PRs', '.github/workflows/close-draft-prs-sweep.yml', swap('\'open\'', '\'closed\''), 'workflow-maintainer-skip', /the draft sweep lists open PRs/],
    ['the sweep without the draft filter', '.github/workflows/close-draft-prs-sweep.yml', eraseAll('pr.draft === true'), 'workflow-maintainer-skip', /the draft sweep filters to drafts/],
    ['the sweep without the policy heading', '.github/workflows/close-draft-prs-sweep.yml', eraseAll('## Draft PRs are not accepted'), 'workflow-maintainer-skip', /the sweep keeps the policy message of close-draft-prs\.yml/],
    ['the sweep without the coverage instruction', '.github/workflows/close-draft-prs-sweep.yml', eraseAll('npm run test:coverage'), 'workflow-maintainer-skip', /the sweep keeps the coverage instruction of the policy message/],
    ['the sweep without the guidelines link', '.github/workflows/close-draft-prs-sweep.yml', eraseAll('CONTRIBUTING.md#pull-request-guidelines'), 'workflow-maintainer-skip', /the sweep keeps the guidelines link of the policy message/],
    ['the issue-link step if gone', '.github/workflows/require-issue-link.yml', swap('if: steps.policy.outputs.ok != \'true\'', 'if: always()'), 'workflow-maintainer-skip', /the failing step `if:` is keyed on the policy output and is step-level \(#1389\)/],
    ['the issue-link policy module call gone', '.github/workflows/require-issue-link.yml', swap('node scripts/require-issue-link-policy.cjs', 'node scripts/other.cjs'), 'workflow-maintainer-skip', /the workflow delegates the verdict to the policy module/],
    ['the legacy closing-keyword grep gone', '.github/workflows/require-issue-link.yml', swap('(closes|fixes|resolves)', '(closes|fixes)'), 'workflow-maintainer-skip', /the bootstrap fallback keeps the legacy closing-keyword grep/],
    ['the issue-link job gains an if:', '.github/workflows/require-issue-link.yml', yamlEdit((workflow) => { workflow.jobs['check-issue-link'].if = 'github.actor != 0'; }), 'workflow-maintainer-skip', /a job-level `if:` would report "skipped" on an exempt PR and block branch protection \(#1389\)/],
    ['the issue-link workflow is not YAML', '.github/workflows/require-issue-link.yml', () => 'a: [unclosed', 'workflow-maintainer-skip', /a job-level `if:` would report "skipped" on an exempt PR and block branch protection \(#1389\)/],
    ['the issue-link workflow is a bare string', '.github/workflows/require-issue-link.yml', () => 'just text', 'workflow-maintainer-skip', /a job-level `if:` would report "skipped" on an exempt PR and block branch protection \(#1389\)/],
    ['the issue-link workflow has no check-issue-link job', '.github/workflows/require-issue-link.yml', yamlEdit((workflow) => { workflow.jobs = { other: { 'runs-on': 'ubuntu-latest' } }; }), 'workflow-maintainer-skip', /a job-level `if:` would report "skipped" on an exempt PR and block branch protection \(#1389\)/],
    ['the version stamp list changed', '.github/workflows/auto-backmerge.yml', swap('VERSION_STAMP_MANIFESTS=\'package.json package-lock.json .claude-plugin/plugin.json .claude-plugin/marketplace.json\'', 'VERSION_STAMP_MANIFESTS=\'package.json\''), 'workflow-maintainer-skip', /auto-backmerge\.yml must version-only-filter all version-bearing manifests \(incl\. marketplace\.json #1855\)/],
    ['the version-only grep gone', '.github/workflows/auto-backmerge.yml', swap('grep -vE \'^[+-][[:space:]]*"version":\'', 'grep -v x'), 'workflow-maintainer-skip', /auto-backmerge\.yml must filter version-only diffs via the "version" grep/],
    ['the lockfile excluded globally', '.github/workflows/auto-backmerge.yml', append('git diff -- \':(exclude)package-lock.json\''), 'workflow-maintainer-skip', /package-lock\.json must not be globally excluded; rely on version-only filtering \(#1404\)/],
        // update-workflow: the get_installed_version step (#4153)
        ['UPDATE_TARGET_UNRESOLVED erased', 'gsd-core/workflows/update.md', eraseAll('UPDATE_TARGET_UNRESOLVED'), 'update-workflow', /the unresolved target must have a typed result/],
        ['TARGET_RUNTIME="" erased', 'gsd-core/workflows/update.md', eraseAll('TARGET_RUNTIME=""'), 'update-workflow', /the unresolved fallback must empty TARGET_RUNTIME/],
        ['GSD_DIR="" erased', 'gsd-core/workflows/update.md', eraseAll('GSD_DIR=""'), 'update-workflow', /the unresolved fallback must empty GSD_DIR/],
        ['"otherwise leave it empty" erased', 'gsd-core/workflows/update.md', erase(/otherwise leave (it )?empty/g), 'update-workflow', /an unrecognized execution_context path must not infer Claude/],
        ['the /.claude/ mapping erased', 'gsd-core/workflows/update.md', eraseAll('`/.claude/` -> `claude`'), 'update-workflow', /must map \/\.claude\/ to claude/],
        ['the /.windsurf/ and /.devin/ mapping erased', 'gsd-core/workflows/update.md', eraseAll('`/.windsurf/`, `/.devin/` -> `windsurf`'), 'update-workflow', /must map \/\.windsurf\/ and \/\.devin\/ to windsurf/],
        ['a fallback to claude added to the step', 'gsd-core/workflows/update.md', within('<step name="get_installed_version">', '</step>', append('otherwise claude.')), 'update-workflow', /must not fall back to claude for an unrecognized path/],
        ['a backticked fallback to claude added to the step', 'gsd-core/workflows/update.md', within('<step name="get_installed_version">', '</step>', append('otherwise `claude`.')), 'update-workflow', /must not fall back to claude for an unrecognized path/],
        ['the GSD_DIR condition dropped from the gate', 'gsd-core/workflows/update.md', swap('`TARGET_RUNTIME` is empty, or `GSD_DIR` is empty', '`TARGET_RUNTIME` is empty'), 'update-workflow', /the unresolved gate must name its three conditions/],
        ['the rerun wording erased in every case', 'gsd-core/workflows/update.md', erase(/rerun from a valid installed runtime/gi), 'update-workflow', /the unresolved result must tell the user to rerun from a valid installed runtime/],
        ['the rerun instruction lower-cased', 'gsd-core/workflows/update.md', swap('Rerun from a valid installed runtime: `/gsd:update`.', 'rerun from a valid installed runtime: `/gsd:update`.'), 'update-workflow', /the unresolved block must carry the rerun instruction/],
        ['the fresh-install command erased', 'gsd-core/workflows/update.md', eraseAll('npx -y --package=@opengsd/gsd-core@latest -- gsd-core --global'), 'update-workflow', /the unresolved block must offer the fresh-install command/],
        ['the runtime list erased from the output contract', 'gsd-core/workflows/update.md', swap('target runtime (`claude`, `opencode`, `kilo`, `codex`, `antigravity`, `windsurf`)', 'target runtime'), 'update-workflow', /the output contract must list the target runtimes/],
        ['Exit. erased from the step', 'gsd-core/workflows/update.md', within('<step name="get_installed_version">', '</step>', eraseAll('Exit.')), 'update-workflow', /the unresolved target must exit before the next step/],
        ['the VERSION-missing bullet named before the unresolved gate', 'gsd-core/workflows/update.md', swap('Detect the installed GSD version, scope, runtime, and config dir.', 'Detect the installed GSD version, scope, runtime, and config dir. VERSION file missing'), 'update-workflow', /must precede the VERSION-missing bullet/],
        ['the VERSION-missing bullet erased', 'gsd-core/workflows/update.md', eraseAll('VERSION file missing'), 'update-workflow', /must precede the VERSION-missing bullet/],
        ['the VERSION-missing bullet no longer scoped to the resolved target', 'gsd-core/workflows/update.md', swap('but the target above resolved', 'but the target resolved'), 'update-workflow', /the VERSION-missing bullet must be explicitly scoped to exclude the unresolved-target case/],
        ['the VERSION-missing scope moved to the next line', 'gsd-core/workflows/update.md', swap('(version resolves to `0.0.0`) but the target above resolved', '(version resolves to `0.0.0`)\nbut the target above resolved'), 'update-workflow', /the VERSION-missing bullet must be explicitly scoped to exclude the unresolved-target case/],
        // update-workflow: the check_latest_version step
        ['jq added to the latest-version bash block', 'gsd-core/workflows/update.md', swap('```bash\nuc_field() {', '```bash\necho x | jq .\nuc_field() {'), 'update-workflow', /latest-result parsing must not invoke jq/],
        ['the latest-version bash block turned into an sh block', 'gsd-core/workflows/update.md', swap('```bash\nuc_field() {', '```sh\nuc_field() {'), 'update-workflow', /check_latest_version must contain a bash block/],
        ['uc_field not defined in the latest-version step', 'gsd-core/workflows/update.md', within('<step name="check_latest_version">', '</step>', eraseAll('uc_field() {')), 'update-workflow', /must define its JSON parser \(uc_field\)/],
        ['the errexit-safe status capture changed', 'gsd-core/workflows/update.md', within('<step name="check_latest_version">', '</step>', swap('LATEST_STATUS=0', 'LATEST_STATUS=1')), 'update-workflow', /latest-version failure must be captured when errexit is active/],
        ['the false default of LATEST_OK erased', 'gsd-core/workflows/update.md', eraseAll('LATEST_OK="${LATEST_OK:-false}"'), 'update-workflow', /the latest-version step must default ok to false/],
        ['the ok read erased', 'gsd-core/workflows/update.md', eraseAll('LATEST_OK="$(uc_field ok "$LATEST_RESULT")"'), 'update-workflow', /the latest-version step must read ok through uc_field/],
        ['the version read erased', 'gsd-core/workflows/update.md', eraseAll('LATEST_VERSION="$(uc_field version "$LATEST_RESULT")"'), 'update-workflow', /the latest-version step must read version through uc_field/],
        ['the reason read erased', 'gsd-core/workflows/update.md', eraseAll('LATEST_REASON="$(uc_field reason "$LATEST_RESULT")"'), 'update-workflow', /the latest-version step must read reason through uc_field/],
        // update-workflow: the backup step (#498)
        ['RUNTIME_DIR no longer assigned from GSD_DIR', 'gsd-core/workflows/update.md', swap('RUNTIME_DIR="$GSD_DIR"', 'RUNTIME_DIR=""'), 'update-workflow', /backup_custom_files must set RUNTIME_DIR="\$GSD_DIR"/],
        ['RUNTIME_DIR assigned from LOCAL_DIR', 'gsd-core/workflows/update.md', append('RUNTIME_DIR="$LOCAL_DIR"'), 'update-workflow', /update\.md still reads LOCAL_DIR/],
        ['RUNTIME_DIR assigned from GLOBAL_DIR', 'gsd-core/workflows/update.md', append('RUNTIME_DIR="$GLOBAL_DIR"'), 'update-workflow', /update\.md still reads GLOBAL_DIR/],
        ['the RUNTIME_DIR gate erased', 'gsd-core/workflows/update.md', eraseAll('[ -n "$RUNTIME_DIR" ]'), 'update-workflow', /the backup must still skip when RUNTIME_DIR is empty/],
        ['detect-custom-files erased from the backup', 'gsd-core/workflows/update.md', eraseAll('detect-custom-files --config-dir "$RUNTIME_DIR"'), 'update-workflow', /the backup must still skip when RUNTIME_DIR is empty/],
        // update-workflow: the release channel (#815) and the install forms (#2470, #3130)
        ['--next erased from the workflow', 'gsd-core/workflows/update.md', eraseAll('--next'), 'update-workflow', /the workflow must parse --next/],
        ['--rc erased from the workflow', 'gsd-core/workflows/update.md', eraseAll('--rc'), 'update-workflow', /the workflow must parse --rc/],
        ['TAG="next" erased', 'gsd-core/workflows/update.md', eraseAll('TAG="next"'), 'update-workflow', /the workflow must set TAG="next"/],
        ['TAG="latest" erased', 'gsd-core/workflows/update.md', eraseAll('TAG="latest"'), 'update-workflow', /the workflow must default TAG="latest"/],
        ['the tag no longer passed to check-latest-version', 'gsd-core/workflows/update.md', swap(' --json --tag "$TAG"', ' --json'), 'update-workflow', /the version check must thread the tag through check-latest-version\.cjs/],
        ['one install no longer tag-parameterized', 'gsd-core/workflows/update.md', swap('@"$TAG" -- gsd-core "$RUNTIME_FLAG" --local', '@"${TAG}" -- gsd-core "$RUNTIME_FLAG" --local'), 'update-workflow', /at least 2 tag-parameterized npx invocations, found 1/],
        ['a hardcoded @latest install added to run_update', 'gsd-core/workflows/update.md', within('<step name="run_update">', '</step>', append('npx -y --package=@opengsd/gsd-core@latest -- gsd-core')), 'update-workflow', /never a hardcoded dist-tag literal/],
        ['a hardcoded @next install added to run_update', 'gsd-core/workflows/update.md', within('<step name="run_update">', '</step>', append('npx -y --package=@opengsd/gsd-core@next -- gsd-core')), 'update-workflow', /never a hardcoded dist-tag literal/],
        ['a hardcoded @beta install added to run_update', 'gsd-core/workflows/update.md', within('<step name="run_update">', '</step>', append('npx -y --package=@opengsd/gsd-core@beta -- gsd-core')), 'update-workflow', /never a hardcoded dist-tag literal/],
        ['a hardcoded @canary install added to run_update', 'gsd-core/workflows/update.md', within('<step name="run_update">', '</step>', append('npx -y --package=@opengsd/gsd-core@canary -- gsd-core')), 'update-workflow', /never a hardcoded dist-tag literal/],
        ['a hardcoded @rc install added to run_update', 'gsd-core/workflows/update.md', within('<step name="run_update">', '</step>', append('npx -y --package=@opengsd/gsd-core@rc -- gsd-core')), 'update-workflow', /never a hardcoded dist-tag literal/],
        ['one resolved install of run_update no longer matches the form', 'gsd-core/workflows/update.md', swap('-- gsd-core "$RUNTIME_FLAG" --local', '-- gsd "$RUNTIME_FLAG" --local'), 'update-workflow', /run_update must hold exactly two resolved-install npx invocations \(found 1\)/],
        ['a third resolved install added to run_update', 'gsd-core/workflows/update.md', within('<step name="run_update">', '</step>', append('npx -y --package=@opengsd/gsd-core@"$TAG" -- gsd-core')), 'update-workflow', /run_update must hold exactly two resolved-install npx invocations \(found 3\)/],
        ['a bare ~/.claude path added', 'gsd-core/workflows/update.md', append('see ~/.claude for the config'), 'update-workflow', /must not contain a bare ~\/\.claude/],
        ['a bare $HOME/.claude path added', 'gsd-core/workflows/update.md', append('see $HOME/.claude for the config'), 'update-workflow', /must not contain a bare ~\/\.claude/],
        ['a bare ~/.claude at the very end of the file', 'gsd-core/workflows/update.md', (text) => `${text.replace(/\s+$/, '')}\n~/.claude`, 'update-workflow', /must not contain a bare ~\/\.claude/],
        ['the stale npx form added', 'gsd-core/workflows/update.md', append('npx -y @opengsd/gsd-core@latest'), 'update-workflow', /must use the --package= form of npx/],
        // update-workflow: the PREFERRED_RUNTIME prose against RUNTIME_DIRS (#4153)
        ['the codex pair dropped from the prose', 'gsd-core/workflows/update.md', swap('`/.codex/` -> `codex`; ', ''), 'update-workflow', /only in RUNTIME_DIRS: \["codex:\.codex"\]/],
        ['a pair added to the prose', 'gsd-core/workflows/update.md', swap('`/.claude/` -> `claude`;', '`/.claude/` -> `claude`; `/.zed/` -> `zed`;'), 'update-workflow', /only in the prose: \["zed:\.zed"\]/],
        ['the inference line reworded', 'gsd-core/workflows/update.md', swap('Infer `PREFERRED_RUNTIME` from the path', 'Infer the runtime from the path'), 'update-workflow', /the PREFERRED_RUNTIME inference line must exist/],
        ['a clause that names no runtime', 'gsd-core/workflows/update.md', swap('`/.codex/` -> `codex`', '`/.codex/` -> codex'), 'update-workflow', /clause must name a runtime/],
        // update-workflow: the command
        ['--next erased from the command', 'commands/gsd/update.md', eraseAll('--next'), 'update-workflow', /the command must document --next/],
        ['--rc erased from the command', 'commands/gsd/update.md', eraseAll('--rc'), 'update-workflow', /the command must document --rc/],
        ['--next dropped from the argument-hint only', 'commands/gsd/update.md', swap('--reapply | --next | --rc', '--reapply | --rc'), 'update-workflow', /the command argument-hint must list --next/],
        ['the argument-hint value moved to the next line', 'commands/gsd/update.md', swap('argument-hint: "', 'argument-hint:\n"'), 'update-workflow', /the command argument-hint must list --next/],
        // plan-phase-ui-redirect: the legacy patterns and the section boundaries
        ['a hard Generate-UI-SPEC-first redirect added', 'gsd-core/workflows/plan-phase.md', append('Generate UI-SPEC first, then Exit workflow'), 'plan-phase-ui-redirect', /plan-phase\.md must not contain a hard "Generate UI-SPEC first -> Exit workflow" redirect/],
        ['the §5.6 heading renumbered', 'gsd-core/workflows/plan-phase.md', swap('## 5.6.', '## 5.6'), 'plan-phase-ui-redirect', /marker "## 5\.6\." not found/],
        ['the heading after §5.6 renumbered', 'gsd-core/workflows/plan-phase.md', swap('\n## 6.', '\n## six.'), 'plan-phase-ui-redirect', /closing marker "\\n## 6\." not found/],
        ['the old shell path-search added to §5.6', 'gsd-core/workflows/plan-phase.md', within('## 5.6.', '\n## 6.', append('UI_GATE_JS=$(for _c in a b; do :; done)')), 'plan-phase-ui-redirect', /must NOT contain the old shell-based ui-safety-gate\.cjs path-search/],
        // plan-phase-ui-redirect: capability-driven dispatch
        ['loop render-hooks plan:pre erased', 'gsd-core/workflows/plan-phase.md', eraseAll('loop render-hooks plan:pre'), 'plan-phase-ui-redirect', /must dispatch `loop render-hooks plan:pre` to resolve active capability hooks/],
        ['check ui-plan-gate erased', 'gsd-core/workflows/plan-phase.md', eraseAll('check ui-plan-gate'), 'plan-phase-ui-redirect', /must run `gsd_run check ui-plan-gate` unconditionally/],
        ['the step-only case wording erased', 'gsd-core/workflows/plan-phase.md', eraseAll('step-only case'), 'plan-phase-ui-redirect', /must document "step-only case"/],
        ['the GATE= assignment renamed', 'gsd-core/workflows/plan-phase.md', swap('GATE=$(gsd_run check ui-plan-gate', 'GATE_X=$(gsd_run check ui-plan-gate'), 'plan-phase-ui-redirect', /must contain the `GATE=\$\(gsd_run check ui-plan-gate` assignment/],
        ['Branch 5 erased', 'gsd-core/workflows/plan-phase.md', eraseAll('Branch 5'), 'plan-phase-ui-redirect', /§5\.6 must contain Branch 5/],
        ['Branch 5 named before the GATE= assignment', 'gsd-core/workflows/plan-phase.md', swap('Run the UI deterministic gate whenever', 'Branch 5 Run the UI deterministic gate whenever'), 'plan-phase-ui-redirect', /GATE= check must appear BEFORE Branch 5 step dispatch/],
        ['frontend erased', 'gsd-core/workflows/plan-phase.md', eraseAll('frontend'), 'plan-phase-ui-redirect', /must read `frontend` from gate result/],
        ['hasUiSpec erased', 'gsd-core/workflows/plan-phase.md', eraseAll('hasUiSpec'), 'plan-phase-ui-redirect', /must read `hasUiSpec` from gate result/],
        ['block erased', 'gsd-core/workflows/plan-phase.md', eraseAll('block'), 'plan-phase-ui-redirect', /must read `block` from gate result/],
        ['config-get workflow.ui_phase inlined in §5.6', 'gsd-core/workflows/plan-phase.md', within('## 5.6.', '\n## 6.', append('config-get workflow.ui_phase')), 'plan-phase-ui-redirect', /must NOT inline `config-get workflow\.ui_phase`/],
        ['config-get workflow.ui_safety_gate inlined in §5.6', 'gsd-core/workflows/plan-phase.md', within('## 5.6.', '\n## 6.', append('config-get workflow.ui_safety_gate')), 'plan-phase-ui-redirect', /must NOT inline `config-get workflow\.ui_safety_gate`/],
        // plan-phase-ui-redirect: the six branches
        ['activeHooks erased', 'gsd-core/workflows/plan-phase.md', eraseAll('activeHooks'), 'plan-phase-ui-redirect', /Branch 1 must reference activeHooks/],
        ['"step 6" erased from §5.6', 'gsd-core/workflows/plan-phase.md', within('## 5.6.', '\n## 6.', eraseAll('step 6')), 'plan-phase-ui-redirect', /Branch 1 \(both-off \/ empty activeHooks\) must skip to step 6, NOT §5\.7/],
        ['Branch 2 skipping to step 6', 'gsd-core/workflows/plan-phase.md', swap('**Branch 2 — no frontend indicators (`frontend` is `false`):** Skip silently to step 5.65.', '**Branch 2 — no frontend indicators (`frontend` is `false`):** Skip silently to step 6.'), 'plan-phase-ui-redirect', /Branch 2 must skip to step 5\.65/],
        ['Branch 2 target on the next line', 'gsd-core/workflows/plan-phase.md', swap('**Branch 2 — no frontend indicators (`frontend` is `false`):** Skip', '**Branch 2 — no frontend indicators (`frontend` is `false`):**\nSkip'), 'plan-phase-ui-redirect', /Branch 2 must skip to step 5\.65/],
        ['UI_SPEC_PATH erased', 'gsd-core/workflows/plan-phase.md', eraseAll('UI_SPEC_PATH'), 'plan-phase-ui-redirect', /Branch 3 must set UI_SPEC_PATH/],
        ['the using-contract message erased', 'gsd-core/workflows/plan-phase.md', eraseAll('Using UI design contract'), 'plan-phase-ui-redirect', /Branch 3 must display the using-contract message/],
        ['AUTO_CHAIN erased', 'gsd-core/workflows/plan-phase.md', eraseAll('AUTO_CHAIN'), 'plan-phase-ui-redirect', /Branches 5 and 6 must read the AUTO_CHAIN flag/],
        ['the gsd-${ref.skill} dispatch erased', 'gsd-core/workflows/plan-phase.md', eraseAll('gsd-${ref.skill}'), 'plan-phase-ui-redirect', /Branch 5 must dispatch step hooks via gsd-\$\{ref\.skill\}/],
        ['ref.skill erased', 'gsd-core/workflows/plan-phase.md', eraseAll('ref.skill'), 'plan-phase-ui-redirect', /Branch 5 must filter activeHooks by ref\.skill/],
        ['the independence wording erased', 'gsd-core/workflows/plan-phase.md', eraseAll('independently of whether a gate is active'), 'plan-phase-ui-redirect', /fire "independently of whether a gate is active"/],
        ['kind == "gate" renamed', 'gsd-core/workflows/plan-phase.md', swap('kind == "gate"', 'kind == "hook"'), 'plan-phase-ui-redirect', /Branch 6 must filter by kind=="gate"/],
        ['blocking erased', 'gsd-core/workflows/plan-phase.md', eraseAll('blocking'), 'plan-phase-ui-redirect', /Branch 6 must check `blocking` is true for the gate/],
        ['Exit the plan-phase workflow erased', 'gsd-core/workflows/plan-phase.md', eraseAll('Exit the plan-phase workflow'), 'plan-phase-ui-redirect', /Branch 6 must say "Exit the plan-phase workflow"/],
        ['Do not continue erased', 'gsd-core/workflows/plan-phase.md', eraseAll('Do not continue'), 'plan-phase-ui-redirect', /Branch 6 must say "Do not continue"/],
        ['both no-block phrases erased', 'gsd-core/workflows/plan-phase.md', (text) => text.split('no active blocking gate').join('').split('no block').join(''), 'plan-phase-ui-redirect', /no active blocking gate -> continue to step 6/],
        ['the warning heading erased', 'gsd-core/workflows/plan-phase.md', eraseAll('⚠ UI-SPEC.md missing for Phase'), 'plan-phase-ui-redirect', /must include the "⚠ UI-SPEC\.md missing for Phase" warning heading/],
        ['the recommendation label erased', 'gsd-core/workflows/plan-phase.md', eraseAll('Recommended next step'), 'plan-phase-ui-redirect', /must include the "Recommended next step" label/],
        ['the /gsd:ui-phase recommendation erased', 'gsd-core/workflows/plan-phase.md', eraseAll('/gsd:ui-phase'), 'plan-phase-ui-redirect', /must include the \/gsd:ui-phase recommendation in the block/],
        ['--skip-ui erased', 'gsd-core/workflows/plan-phase.md', eraseAll('--skip-ui'), 'plan-phase-ui-redirect', /must include --skip-ui as the bypass option/],
        ['Also available erased', 'gsd-core/workflows/plan-phase.md', eraseAll('Also available'), 'plan-phase-ui-redirect', /recommendation block must include the "Also available" section/],
        ['the dot-normalization documentation erased', 'gsd-core/workflows/plan-phase.md', (text) => text.split('ui.plan-gate').join('').split('normalizes dots').join('').split('dots to hyphens').join(''), 'plan-phase-ui-redirect', /must document that the check router normalizes dots to hyphens/],
        ['ui_phase erased', 'gsd-core/workflows/plan-phase.md', eraseAll('ui_phase'), 'plan-phase-ui-redirect', /must reference workflow\.ui_phase/],
        ['ui_safety_gate erased', 'gsd-core/workflows/plan-phase.md', eraseAll('ui_safety_gate'), 'plan-phase-ui-redirect', /must reference workflow\.ui_safety_gate/],
        // plan-phase-ui-redirect: the optional sketch/spike findings probes (#3072)
        ['the spike probe of plan-phase loses its guard', 'gsd-core/workflows/plan-phase.md', swap('SPIKE_FINDINGS_PATH=$(ls ./.claude/skills/spike-findings-*/SKILL.md 2>/dev/null | head -1 || true)', 'SPIKE_FINDINGS_PATH=$(ls ./.claude/skills/spike-findings-*/SKILL.md 2>/dev/null | head -1)'), 'plan-phase-ui-redirect', /plan-phase\.md:\d+ SPIKE_FINDINGS_PATH=/],
        ['the sketch probe of ui-phase loses its guard', 'gsd-core/workflows/ui-phase.md', swap('SKETCH_FINDINGS_PATH=$(ls ./.claude/skills/sketch-findings-*/SKILL.md 2>/dev/null | head -1 || true)', 'SKETCH_FINDINGS_PATH=$(ls ./.claude/skills/sketch-findings-*/SKILL.md 2>/dev/null | head -1)'), 'plan-phase-ui-redirect', /ui-phase\.md:\d+ SKETCH_FINDINGS_PATH=/],
        ['the spike probe of discuss-phase loses its guard', 'gsd-core/workflows/discuss-phase.md', swap('SPIKE_FINDINGS=$(ls ./.claude/skills/spike-findings-*/SKILL.md 2>/dev/null | head -1 || true)', 'SPIKE_FINDINGS=$(ls ./.claude/skills/spike-findings-*/SKILL.md 2>/dev/null | head -1)'), 'plan-phase-ui-redirect', /discuss-phase\.md:\d+ SPIKE_FINDINGS=/],
        ['an unguarded spike probe added to new-project', 'gsd-core/workflows/new-project.md', append('```bash\nSPIKE=$(ls ./.claude/skills/spike-findings-*/SKILL.md 2>/dev/null | head -1)\n```'), 'plan-phase-ui-redirect', /new-project\.md:\d+ SPIKE=/],
        // review-default-reviewers-workflow: default reviewer selection (#3079)
        ['review.default_reviewers erased', 'gsd-core/workflows/review.md', eraseAll('review.default_reviewers'), 'review-default-reviewers-workflow', /must reference review\.default_reviewers for no-flag selection/],
        ['Individual reviewer flags erased', 'gsd-core/workflows/review.md', eraseAll('Individual reviewer flags'), 'review-default-reviewers-workflow', /must document precedence: flags > --all > review\.default_reviewers/],
        ['--all erased', 'gsd-core/workflows/review.md', eraseAll('--all'), 'review-default-reviewers-workflow', /must document the --all override in the precedence order/],
        ['Unknown slugs warn erased', 'gsd-core/workflows/review.md', eraseAll('Unknown slugs warn'), 'review-default-reviewers-workflow', /must document unknown slug handling/],
        ['Known-but-undetected slugs erased', 'gsd-core/workflows/review.md', eraseAll('Known-but-undetected slugs'), 'review-default-reviewers-workflow', /must document undetected slug handling/],
        ['the actionable-message wording erased', 'gsd-core/workflows/review.md', eraseAll('fail with an actionable message'), 'review-default-reviewers-workflow', /the all-unavailable failure carries an actionable message/],
        ['the all-unavailable failure erased', 'gsd-core/workflows/review.md', eraseAll('all configured reviewers are unavailable'), 'review-default-reviewers-workflow', /must document the failure path when configured reviewers are unavailable/],
        // review-default-reviewers-workflow: the build_prompt Review Instructions region (#1318)
        ['the build_prompt step renamed', 'gsd-core/workflows/review.md', swap('<step name="build_prompt">', '<step name="build_prompt_x">'), 'review-default-reviewers-workflow', /build_prompt step must exist/],
        ['the prompt block no longer a markdown fence', 'gsd-core/workflows/review.md', swap('```markdown', '```text'), 'review-default-reviewers-workflow', /build_prompt must contain a ```markdown prompt block/],
        ['the prompt block never closed', 'gsd-core/workflows/review.md', (text) => text.slice(0, text.indexOf('Output your review in markdown format.')), 'review-default-reviewers-workflow', /build_prompt markdown fence must be closed/],
        ['the Review Instructions heading erased', 'gsd-core/workflows/review.md', eraseAll('## Review Instructions'), 'review-default-reviewers-workflow', /fenced prompt must contain a ## Review Instructions section/],
        ['"Verify against source" moved out of the region', 'gsd-core/workflows/review.md', (text) => `${text.split('Verify against source').join('Verify against')}\nVerify against source\n`, 'review-default-reviewers-workflow', /missing \["Verify against source"\]/],
        ['"check each claim against the actual code" moved out of the region', 'gsd-core/workflows/review.md', (text) => `${text.split('check each claim against the actual code').join('check each claim')}\ncheck each claim against the actual code\n`, 'review-default-reviewers-workflow', /missing \["check each claim against the actual code"\]/],
        ['the file:line evidence phrase moved out of the region', 'gsd-core/workflows/review.md', (text) => `${text.split('`path/to/file:line`').join('`path`')}\n\`path/to/file:line\`\n`, 'review-default-reviewers-workflow', /missing \["`path\/to\/file:line`"\]/],
        ['the no-file-access clause moved out of the region', 'gsd-core/workflows/review.md', (text) => `${text.split('If you cannot read the repo (no file access)').join('If you cannot read')}\nIf you cannot read the repo (no file access)\n`, 'review-default-reviewers-workflow', /missing \["If you cannot read the repo \(no file access\)"\]/],
        ['the open-question downgrade moved out of the region', 'gsd-core/workflows/review.md', (text) => `${text.split('downgrade that finding to an open question').join('downgrade that finding')}\ndowngrade that finding to an open question\n`, 'review-default-reviewers-workflow', /missing \["downgrade that finding to an open question"\]/],
  ]) {
    test(`mutation: ${title} (${rel}) fails ${contract}`, (t) => {
      const root = copyOfRepoFiles(t);
      const abs = path.join(root, ...rel.split('/'));
      const before = fs.readFileSync(abs, 'utf8');
      const after = edit(before);
      assert.notEqual(after, before, 'the mutation changed the file');
      fs.writeFileSync(abs, after);
      const findings = runShipped(root, [contract]);
      assert.ok(findings.some((f) => expected.test(f.message)), `expected a finding matching ${expected}, got ${JSON.stringify(findings.map((f) => f.message))}`);
    });
  }

  // Controls and boundaries, one block per group of contracts.
  {
    // ---- group 1 helpers: edits across several files, a count of findings, a file gone or empty.
    const applyEdits1 = (t, edits, heavy = false) => {
      const root = copyOfRepoFiles(t, heavy ? HEAVY : []);
      for (const [rel, edit] of edits) {
        const abs = path.join(root, ...rel.split('/'));
        const before = fs.readFileSync(abs, 'utf8');
        const after = edit(before);
        assert.notEqual(after, before, `the edit changed ${rel}`);
        fs.writeFileSync(abs, after);
      }
      return root;
    };
    const editFiles1 = (title, edits, contract, expected) => test(title, (t) => {
      const findings = runShipped(applyEdits1(t, edits), [contract]);
      if (expected === null) assert.deepEqual(findings, []);
      else assert.ok(findings.some((f) => expected.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
    });
    // The assertion named by `absent` is silent (the other assertions may still report).
    const quiet1 = (title, edits, contract, absent) => test(title, (t) => {
      const findings = runShipped(applyEdits1(t, edits), [contract]);
      assert.ok(!findings.some((f) => absent.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
    });
    const exactly1 = (title, edits, contract, count, expected) => test(title, (t) => {
      const findings = runShipped(applyEdits1(t, edits), [contract]);
      assert.equal(findings.length, count, JSON.stringify(findings.map((f) => f.message)));
      assert.match(findings[0].message, expected);
    });
    // Edit combinators: several edits in a row, the alternatives of an OR erased, a word added after the first line or at the end.
    const compose1 = (...edits) => (text) => edits.reduce((value, edit) => edit(value), text);
    const stripAlts1 = (alts) => (text) => alts.reduce((value, alt) => value.split(alt).join(''), text);
    const insertAfterFirstLine1 = (word) => (text) => { const at = text.indexOf('\n') + 1; return text.slice(0, at) + `${word} ` + text.slice(at); };
    const appendWord1 = (word) => (text) => `${text} ${word} `;
    const fromMarker1 = (marker, edit) => (text) => { const at = text.indexOf(marker); return text.slice(0, at) + edit(text.slice(at)); };
    // A file that is gone or empty is exactly one finding for that path, and nothing else.
    const goneOne1 = (rel, contract, how) => test(`${rel} ${how} is exactly one finding of ${contract}`, (t) => {
      const root = copyOfRepoFiles(t);
      const abs = path.join(root, ...rel.split('/'));
      if (how === 'removed') fs.unlinkSync(abs);
      else fs.writeFileSync(abs, '');
      const findings = runShipped(root, [contract]);
      assert.equal(findings.length, 1, JSON.stringify(findings.map((f) => f.message)));
      assert.equal(findings[0].file, rel);
      assert.match(findings[0].message, how === 'removed' ? /cannot read the file/ : /the file is empty/);
    });

    // ---- autonomous-ui-steps: one finding per cause, controls for each alternative, the splice, the walkers
    goneOne1('gsd-core/workflows/autonomous.md', 'autonomous-ui-steps', 'removed');
    goneOne1('gsd-core/workflows/autonomous.md', 'autonomous-ui-steps', 'emptied');
    goneOne1('gsd-core/references/autonomous-ui-design-contract.md', 'autonomous-ui-steps', 'removed');
    goneOne1('gsd-core/references/autonomous-ui-design-contract.md', 'autonomous-ui-steps', 'emptied');
    exactly1('the pointer gone is one finding', [['gsd-core/workflows/autonomous.md', swap('Read and execute: `$HOME/.claude/gsd-core/references/autonomous-ui-design-contract.md`', 'Read the reference.')]], 'autonomous-ui-steps', 1, /must still contain the §3a\.5 reference pointer/);
    exactly1('the §3a.5 heading renamed is one finding', [['gsd-core/workflows/autonomous.md', swap('**3a.5.', '**3a.6.')]], 'autonomous-ui-steps', 1, /the §3a\.5 section must be delimited/);
    exactly1('the §3d.5 step gone is one finding', [['gsd-core/workflows/autonomous.md', eraseAll('3d.5')]], 'autonomous-ui-steps', 1, /the §3d\.5 step must be present/);
    exactly1('no closing step tag after §3d.5 is one finding', [['gsd-core/workflows/autonomous.md', fromMarker1('3d.5', (text) => text.split('</step>').join(''))]], 'autonomous-ui-steps', 1, /<\/step> must follow §3d\.5/);
    exactly1('the success criteria block gone is one finding', [['gsd-core/workflows/autonomous.md', swap('<success_criteria>', '<criteria>')]], 'autonomous-ui-steps', 1, /the success criteria block must be present/);
    editFiles1('UI-SPEC.md gone from the whole §3a.5 section', [['gsd-core/workflows/autonomous.md', within('**3a.5.', '**3b.', eraseAll('UI-SPEC.md'))], ['gsd-core/references/autonomous-ui-design-contract.md', eraseAll('UI-SPEC.md')]], 'autonomous-ui-steps', /§3a\.5 must check for existing UI-SPEC\.md/);
    editFiles1('ui-phase gone from the host and the reference', [['gsd-core/workflows/autonomous.md', eraseAll('ui-phase')], ['gsd-core/references/autonomous-ui-design-contract.md', eraseAll('ui-phase')]], 'autonomous-ui-steps', /success criteria should reference ui-phase and ui-review/);
    editFiles1('non-blocking §3a.5: none of the alternatives is a finding', [['gsd-core/workflows/autonomous.md', within('**3a.5.', '**3b.', stripAlts1(['NON-BLOCKING', 'non-blocking', 'continue', 'proceed']))], ['gsd-core/references/autonomous-ui-design-contract.md', stripAlts1(['NON-BLOCKING', 'non-blocking', 'continue', 'proceed'])]], 'autonomous-ui-steps', /§3a\.5 must be explicitly non-blocking \(warning \+ continue\)/);
    quiet1('non-blocking §3a.5: NON-BLOCKING alone is enough', [['gsd-core/workflows/autonomous.md', within('**3a.5.', '**3b.', stripAlts1(['NON-BLOCKING', 'non-blocking', 'continue', 'proceed']))], ['gsd-core/references/autonomous-ui-design-contract.md', compose1(stripAlts1(['NON-BLOCKING', 'non-blocking', 'continue', 'proceed']), insertAfterFirstLine1('NON-BLOCKING'))]], 'autonomous-ui-steps', /§3a\.5 must be explicitly non-blocking \(warning \+ continue\)/);
    quiet1('non-blocking §3a.5: non-blocking alone is enough', [['gsd-core/workflows/autonomous.md', within('**3a.5.', '**3b.', stripAlts1(['NON-BLOCKING', 'non-blocking', 'continue', 'proceed']))], ['gsd-core/references/autonomous-ui-design-contract.md', compose1(stripAlts1(['NON-BLOCKING', 'non-blocking', 'continue', 'proceed']), insertAfterFirstLine1('non-blocking'))]], 'autonomous-ui-steps', /§3a\.5 must be explicitly non-blocking \(warning \+ continue\)/);
    quiet1('non-blocking §3a.5: continue alone is enough', [['gsd-core/workflows/autonomous.md', within('**3a.5.', '**3b.', stripAlts1(['NON-BLOCKING', 'non-blocking', 'continue', 'proceed']))], ['gsd-core/references/autonomous-ui-design-contract.md', compose1(stripAlts1(['NON-BLOCKING', 'non-blocking', 'continue', 'proceed']), insertAfterFirstLine1('continue'))]], 'autonomous-ui-steps', /§3a\.5 must be explicitly non-blocking \(warning \+ continue\)/);
    quiet1('non-blocking §3a.5: proceed alone is enough', [['gsd-core/workflows/autonomous.md', within('**3a.5.', '**3b.', stripAlts1(['NON-BLOCKING', 'non-blocking', 'continue', 'proceed']))], ['gsd-core/references/autonomous-ui-design-contract.md', compose1(stripAlts1(['NON-BLOCKING', 'non-blocking', 'continue', 'proceed']), insertAfterFirstLine1('proceed'))]], 'autonomous-ui-steps', /§3a\.5 must be explicitly non-blocking \(warning \+ continue\)/);
    editFiles1('the kind filter: none of the alternatives is a finding', [['gsd-core/references/autonomous-ui-design-contract.md', stripAlts1(['kind == "step"'])]], 'autonomous-ui-steps', /§3a\.5 must gate the skip decision on kind=="step" entries/);
    quiet1('the kind filter: kind == "step" alone is enough', [['gsd-core/references/autonomous-ui-design-contract.md', compose1(stripAlts1(['kind == "step"']), insertAfterFirstLine1('kind == "step"'))]], 'autonomous-ui-steps', /§3a\.5 must gate the skip decision on kind=="step" entries/);
    quiet1('the kind filter: kind == \'step\' alone is enough for the skip decision', [['gsd-core/references/autonomous-ui-design-contract.md', compose1(stripAlts1(['kind == "step"']), insertAfterFirstLine1('kind == \'step\''))]], 'autonomous-ui-steps', /§3a\.5 must gate the skip decision on kind=="step" entries/);
    quiet1('the kind filter: kind=="step" alone is enough for the skip decision', [['gsd-core/references/autonomous-ui-design-contract.md', compose1(stripAlts1(['kind == "step"']), insertAfterFirstLine1('kind=="step"'))]], 'autonomous-ui-steps', /§3a\.5 must gate the skip decision on kind=="step" entries/);
    editFiles1('the no-active-step phrase: none of the alternatives is a finding', [['gsd-core/references/autonomous-ui-design-contract.md', stripAlts1(['NO active step', 'no active step', 'no active UI step'])]], 'autonomous-ui-steps', /§3a\.5 skip condition must reference "no active step hook\(s\)" — not just empty activeHooks/);
    quiet1('the no-active-step phrase: NO active step alone is enough', [['gsd-core/references/autonomous-ui-design-contract.md', compose1(stripAlts1(['NO active step', 'no active step', 'no active UI step']), insertAfterFirstLine1('NO active step'))]], 'autonomous-ui-steps', /§3a\.5 skip condition must reference "no active step hook\(s\)" — not just empty activeHooks/);
    quiet1('the no-active-step phrase: no active step alone is enough', [['gsd-core/references/autonomous-ui-design-contract.md', compose1(stripAlts1(['NO active step', 'no active step', 'no active UI step']), insertAfterFirstLine1('no active step'))]], 'autonomous-ui-steps', /§3a\.5 skip condition must reference "no active step hook\(s\)" — not just empty activeHooks/);
    quiet1('the no-active-step phrase: no active UI step alone is enough', [['gsd-core/references/autonomous-ui-design-contract.md', compose1(stripAlts1(['NO active step', 'no active step', 'no active UI step']), insertAfterFirstLine1('no active UI step'))]], 'autonomous-ui-steps', /§3a\.5 skip condition must reference "no active step hook\(s\)" — not just empty activeHooks/);
    editFiles1('the gate-only case: none of the alternatives is a finding', [['gsd-core/references/autonomous-ui-design-contract.md', stripAlts1(['ui_phase', 'ui_safety_gate', 'gate-only'])]], 'autonomous-ui-steps', /§3a\.5 must document the gate-only \/ ui_phase=false silent-skip case/);
    quiet1('the gate-only case: ui_phase alone is enough', [['gsd-core/references/autonomous-ui-design-contract.md', compose1(stripAlts1(['ui_phase', 'ui_safety_gate', 'gate-only']), insertAfterFirstLine1('ui_phase'))]], 'autonomous-ui-steps', /§3a\.5 must document the gate-only \/ ui_phase=false silent-skip case/);
    quiet1('the gate-only case: ui_safety_gate alone is enough', [['gsd-core/references/autonomous-ui-design-contract.md', compose1(stripAlts1(['ui_phase', 'ui_safety_gate', 'gate-only']), insertAfterFirstLine1('ui_safety_gate'))]], 'autonomous-ui-steps', /§3a\.5 must document the gate-only \/ ui_phase=false silent-skip case/);
    quiet1('the gate-only case: gate-only alone is enough', [['gsd-core/references/autonomous-ui-design-contract.md', compose1(stripAlts1(['ui_phase', 'ui_safety_gate', 'gate-only']), insertAfterFirstLine1('gate-only'))]], 'autonomous-ui-steps', /§3a\.5 must document the gate-only \/ ui_phase=false silent-skip case/);
    editFiles1('gate entries ignored: none of the alternatives is a finding', [['gsd-core/references/autonomous-ui-design-contract.md', stripAlts1(['ignored', 'silently'])]], 'autonomous-ui-steps', /§3a\.5 must explicitly note kind=="gate" entries are silently ignored/);
    quiet1('gate entries ignored: ignored alone is enough', [['gsd-core/references/autonomous-ui-design-contract.md', compose1(stripAlts1(['ignored', 'silently']), insertAfterFirstLine1('ignored'))]], 'autonomous-ui-steps', /§3a\.5 must explicitly note kind=="gate" entries are silently ignored/);
    quiet1('gate entries ignored: silently alone is enough', [['gsd-core/references/autonomous-ui-design-contract.md', compose1(stripAlts1(['ignored', 'silently']), insertAfterFirstLine1('silently'))]], 'autonomous-ui-steps', /§3a\.5 must explicitly note kind=="gate" entries are silently ignored/);
    editFiles1('§3d.5 advisory: none of the alternatives is a finding', [['gsd-core/workflows/autonomous.md', within('3d.5', '</step>', stripAlts1(['advisory', 'non-blocking', 'regardless of result']))]], 'autonomous-ui-steps', /§3d\.5 must be explicitly advisory\/non-blocking/);
    quiet1('§3d.5 advisory: advisory alone is enough', [['gsd-core/workflows/autonomous.md', within('3d.5', '</step>', compose1(stripAlts1(['advisory', 'non-blocking', 'regardless of result']), appendWord1('advisory')))]], 'autonomous-ui-steps', /§3d\.5 must be explicitly advisory\/non-blocking/);
    quiet1('§3d.5 advisory: non-blocking alone is enough', [['gsd-core/workflows/autonomous.md', within('3d.5', '</step>', compose1(stripAlts1(['advisory', 'non-blocking', 'regardless of result']), appendWord1('non-blocking')))]], 'autonomous-ui-steps', /§3d\.5 must be explicitly advisory\/non-blocking/);
    quiet1('§3d.5 advisory: regardless of result alone is enough', [['gsd-core/workflows/autonomous.md', within('3d.5', '</step>', compose1(stripAlts1(['advisory', 'non-blocking', 'regardless of result']), appendWord1('regardless of result')))]], 'autonomous-ui-steps', /§3d\.5 must be explicitly advisory\/non-blocking/);
    editFiles1('the success criteria advisory note: none of the alternatives is a finding', [['gsd-core/workflows/autonomous.md', fromMarker1('<success_criteria>', stripAlts1(['advisory', 'non-blocking']))]], 'autonomous-ui-steps', /success criteria should note UI review is advisory\/non-blocking/);
    quiet1('the success criteria advisory note: advisory alone is enough', [['gsd-core/workflows/autonomous.md', fromMarker1('<success_criteria>', compose1(stripAlts1(['advisory', 'non-blocking']), appendWord1('advisory')))]], 'autonomous-ui-steps', /success criteria should note UI review is advisory\/non-blocking/);
    quiet1('the success criteria advisory note: non-blocking alone is enough', [['gsd-core/workflows/autonomous.md', fromMarker1('<success_criteria>', compose1(stripAlts1(['advisory', 'non-blocking']), appendWord1('non-blocking')))]], 'autonomous-ui-steps', /success criteria should note UI review is advisory\/non-blocking/);
    quiet1('Frontend phases: the lower-case spelling alone is enough', [['gsd-core/workflows/autonomous.md', swap('Frontend phases', 'frontend phases')]], 'autonomous-ui-steps', /success criteria should mention frontend phases/);
    test('the splice puts the reference in as text, whatever dollar sequences it holds', () => {
      const ui = require('../scripts/static-checks/text-contracts/autonomous-ui-steps.cjs').walkers;
      const pointer = 'Read and execute: `$HOME/.claude/gsd-core/references/autonomous-ui-design-contract.md`';
      assert.equal(ui.splice(`before ${pointer} after`, "$& $' $$ $1"), "before $& $' $$ $1 after");
      assert.equal(ui.splice('no pointer here', 'reference'), null);
    });
    {
      const fc = require('./helpers/fast-check-setup.cjs');
      const ui = require('../scripts/static-checks/text-contracts/autonomous-ui-steps.cjs').walkers;
      const pointer = 'Read and execute: `$HOME/.claude/gsd-core/references/autonomous-ui-design-contract.md`';
      const strings = (tokens, maxLength = 10) => fc.array(fc.constantFrom(...tokens), { maxLength }).map((parts) => parts.join(''));
      const agrees = (name, arbitrary, pair, isAccepted = (expected) => expected !== null) => {
        let accepted = 0;
        let rejected = 0;
        fc.assert(fc.property(arbitrary, (s) => {
          const [actual, expected] = pair(s);
          assert.deepEqual(actual, expected, JSON.stringify(s));
          if (isAccepted(expected)) accepted += 1;
          else rejected += 1;
        }));
        assert.ok(accepted > 0 && rejected > 0, `${name}: the property saw ${accepted} accepted and ${rejected} rejected strings`);
      };
      // A chain of parts with 0..6 filler characters after each: crosses the order checks of the markers.
      const chainOf = (parts) => fc.tuple(...parts.map(() => fc.nat(6))).map((pads) => parts.map((part, i) => part + 'x'.repeat(pads[i])).join(''));
      const markers = ['**3a.5.', '**3b.', '3d.5', '</step>', '<success_criteria>', '**3b. Plan**', 'x', '\n', ' '];
      const oldSection = (c) => { const start = c.indexOf('**3a.5.'); const end = c.indexOf('**3b.', start); return start === -1 || end === -1 ? null : c.slice(start, end); };
      const oldReview = (c) => { const start = c.indexOf('3d.5'); if (start === -1) return null; const end = c.indexOf('</step>', start); return { tail: c.slice(start), endRel: end === -1 ? -1 : end - start }; };
      const oldCriteria = (c) => (c.indexOf('<success_criteria>') === -1 ? null : c.slice(c.indexOf('<success_criteria>')));
      const inputs = fc.oneof(strings(markers, 12), chainOf(['**3a.5.', '**3b.']), chainOf(['x', '3d.5', '</step>']), chainOf(['<success_criteria>', 'advisory']));
      test('property: the section walks agree with the slices they replaced', () => {
        agrees('section', inputs, (s) => [ui.section3a5(s).text ?? null, oldSection(s)]);
        agrees('review', inputs, (s) => {
          const got = ui.review(s);
          return [got.error ? null : { tail: got.tail, endRel: got.bounded === null ? -1 : got.bounded.length }, oldReview(s)];
        });
        agrees('criteria', inputs, (s) => [ui.criteria(s), oldCriteria(s)]);
      });
      test('property: the splice agrees with the replacement it makes, over references free of dollar tokens', () => {
        const oldSplice = (raw, reference) => (raw.includes(pointer) ? raw.replace(pointer, () => reference) : null);
        const hosts = fc.oneof(strings([pointer, 'x', '\n', ' ', 'Read and execute:'], 6), chainOf([pointer, 'tail']));
        agrees('splice', fc.tuple(hosts, strings(['ref ', 'x', '\n', 'skill'], 5)), ([host, reference]) => [ui.splice(host, reference), oldSplice(host, reference)]);
      });
    }

    // ---- discuss-phase-power: one finding per cause, controls for each alternative, the swept workflows, the walkers
    goneOne1('commands/gsd/discuss-phase.md', 'discuss-phase-power', 'removed');
    goneOne1('commands/gsd/discuss-phase.md', 'discuss-phase-power', 'emptied');
    goneOne1('gsd-core/workflows/discuss-phase.md', 'discuss-phase-power', 'removed');
    goneOne1('gsd-core/workflows/discuss-phase.md', 'discuss-phase-power', 'emptied');
    goneOne1('gsd-core/workflows/discuss-phase-power.md', 'discuss-phase-power', 'removed');
    goneOne1('gsd-core/workflows/discuss-phase-power.md', 'discuss-phase-power', 'emptied');
    goneOne1('gsd-core/workflows/discuss-phase/modes/power.md', 'discuss-phase-power', 'removed');
    goneOne1('gsd-core/workflows/discuss-phase/modes/power.md', 'discuss-phase-power', 'emptied');
    goneOne1('gsd-core/workflows/discuss-phase/modes/advisor.md', 'discuss-phase-power', 'removed');
    goneOne1('gsd-core/workflows/discuss-phase/modes/advisor.md', 'discuss-phase-power', 'emptied');
    goneOne1('gsd-core/workflows/discuss-phase/modes/auto.md', 'discuss-phase-power', 'removed');
    goneOne1('gsd-core/workflows/discuss-phase/modes/auto.md', 'discuss-phase-power', 'emptied');
    goneOne1('gsd-core/references/gate-prompts.md', 'discuss-phase-power', 'removed');
    goneOne1('gsd-core/references/gate-prompts.md', 'discuss-phase-power', 'emptied');
    goneOne1('gsd-core/workflows/discuss-phase-assumptions.md', 'discuss-phase-power', 'removed');
    goneOne1('gsd-core/workflows/discuss-phase-assumptions.md', 'discuss-phase-power', 'emptied');
    goneOne1('gsd-core/workflows/plan-phase.md', 'discuss-phase-power', 'removed');
    goneOne1('gsd-core/workflows/plan-phase.md', 'discuss-phase-power', 'emptied');
    exactly1('the auto_advance step of discuss-phase renamed is one finding', [['gsd-core/workflows/discuss-phase.md', swap('<step name="auto_advance">', '<step name="advance">')]], 'discuss-phase-power', 1, /marker .*auto_advance.* not found/);
    exactly1('the auto_advance step of assumptions renamed is one finding', [['gsd-core/workflows/discuss-phase-assumptions.md', swap('<step name="auto_advance">', '<step name="advance">')]], 'discuss-phase-power', 1, /marker .*auto_advance.* not found/);
    exactly1('the check_spec step of default renamed is one finding', [['gsd-core/workflows/discuss-phase.md', swap('<step name="check_spec">', '<step name="spec_check">')]], 'discuss-phase-power', 1, /marker .*check_spec.* not found/);
    exactly1('the check_spec step of assumptions renamed is one finding', [['gsd-core/workflows/discuss-phase-assumptions.md', swap('<step name="check_spec">', '<step name="spec_check">')]], 'discuss-phase-power', 1, /marker .*check_spec.* not found/);
    exactly1('the check_spec step of power renamed is one finding', [['gsd-core/workflows/discuss-phase-power.md', swap('<step name="check_spec">', '<step name="spec_check">')]], 'discuss-phase-power', 1, /marker .*check_spec.* not found/);
    exactly1('the wait_loop step renamed is one finding', [['gsd-core/workflows/discuss-phase-power.md', swap('<step name="wait_loop">', '<step name="listen">')]], 'discuss-phase-power', 1, /marker .*wait_loop.* not found/);
    exactly1('the analyze step of the power flow renamed is one finding', [['gsd-core/workflows/discuss-phase-power.md', swap('<step name="analyze">', '<step name="study">')]], 'discuss-phase-power', 1, /marker .*analyze.* not found/);
    exactly1('the analyzer step of assumptions gone is one finding', [['gsd-core/workflows/discuss-phase-assumptions.md', swap('<step name="deep_codebase_analysis">', '<step name="analysis">')]], 'discuss-phase-power', 1, /check_spec runs before the analyzer step/);
    editFiles1('no power section and no reference in the workflow or its power mode', [['gsd-core/workflows/discuss-phase.md', stripAlts1(['power_user_mode', 'power user mode', 'modes/power.md', 'discuss-phase-power'])], ['gsd-core/workflows/discuss-phase/modes/power.md', stripAlts1(['power_user_mode', 'power user mode', 'modes/power.md', 'discuss-phase-power'])]], 'discuss-phase-power', /discuss-phase\.md \(or modes\/power\.md after the discuss-phase\/modes split\) should have power_user_mode section or reference discuss-phase-power\.md/);
    quiet1('power_user_mode alone satisfies the power section check', [['gsd-core/workflows/discuss-phase.md', compose1(stripAlts1(['power_user_mode', 'power user mode', 'modes/power.md', 'discuss-phase-power']), appendWord1('power_user_mode'))], ['gsd-core/workflows/discuss-phase/modes/power.md', stripAlts1(['power_user_mode', 'power user mode', 'modes/power.md', 'discuss-phase-power'])]], 'discuss-phase-power', /discuss-phase\.md \(or modes\/power\.md after the discuss-phase\/modes split\) should have power_user_mode section or reference discuss-phase-power\.md/);
    quiet1('power user mode alone satisfies the power section check', [['gsd-core/workflows/discuss-phase.md', compose1(stripAlts1(['power_user_mode', 'power user mode', 'modes/power.md', 'discuss-phase-power']), appendWord1('power user mode'))], ['gsd-core/workflows/discuss-phase/modes/power.md', stripAlts1(['power_user_mode', 'power user mode', 'modes/power.md', 'discuss-phase-power'])]], 'discuss-phase-power', /discuss-phase\.md \(or modes\/power\.md after the discuss-phase\/modes split\) should have power_user_mode section or reference discuss-phase-power\.md/);
    quiet1('modes/power.md alone satisfies the power section check', [['gsd-core/workflows/discuss-phase.md', compose1(stripAlts1(['power_user_mode', 'power user mode', 'modes/power.md', 'discuss-phase-power']), appendWord1('modes/power.md'))], ['gsd-core/workflows/discuss-phase/modes/power.md', stripAlts1(['power_user_mode', 'power user mode', 'modes/power.md', 'discuss-phase-power'])]], 'discuss-phase-power', /discuss-phase\.md \(or modes\/power\.md after the discuss-phase\/modes split\) should have power_user_mode section or reference discuss-phase-power\.md/);
    quiet1('discuss-phase-power alone satisfies the power section check', [['gsd-core/workflows/discuss-phase.md', compose1(stripAlts1(['power_user_mode', 'power user mode', 'modes/power.md', 'discuss-phase-power']), appendWord1('discuss-phase-power'))], ['gsd-core/workflows/discuss-phase/modes/power.md', stripAlts1(['power_user_mode', 'power user mode', 'modes/power.md', 'discuss-phase-power'])]], 'discuss-phase-power', /discuss-phase\.md \(or modes\/power\.md after the discuss-phase\/modes split\) should have power_user_mode section or reference discuss-phase-power\.md/);
    findsOne('upper case reads the agent definition', 'gsd-core/workflows/discuss-phase/modes/advisor.md', append('READ @x/GSD-ADVISOR-RESEARCHER.MD'), 'discuss-phase-power', 'advisor mode must not manually instruct reading the agent def — spawning by type auto-loads it (#2771)');
    findsOne('a newline between read and @ reads the agent definition', 'gsd-core/workflows/discuss-phase/modes/advisor.md', append('read\n@gsd-advisor-researcher.md'), 'discuss-phase-power', 'advisor mode must not manually instruct reading the agent def — spawning by type auto-loads it (#2771)');
    findsOne('no boundary before read reads the agent definition', 'gsd-core/workflows/discuss-phase/modes/advisor.md', append('bread @x gsd-advisor-researcher.md'), 'discuss-phase-power', 'advisor mode must not manually instruct reading the agent def — spawning by type auto-loads it (#2771)');
    findsOne('a no-break space after read reads the agent definition', 'gsd-core/workflows/discuss-phase/modes/advisor.md', append('Read\u00a0@y gsd-advisor-researcher.md'), 'discuss-phase-power', 'advisor mode must not manually instruct reading the agent def — spawning by type auto-loads it (#2771)');
    passes('the file name on the next line is not a manual read', 'gsd-core/workflows/discuss-phase/modes/advisor.md', append('read @x\ngsd-advisor-researcher.md'), 'discuss-phase-power');
    passes('no blank between read and @ is not a manual read', 'gsd-core/workflows/discuss-phase/modes/advisor.md', append('read@gsd-advisor-researcher.md'), 'discuss-phase-power');
    passes('a line separator before the file name is not a manual read', 'gsd-core/workflows/discuss-phase/modes/advisor.md', append('read @x\u2028gsd-advisor-researcher.md'), 'discuss-phase-power');
    passes('a long s in the file name is not a manual read', 'gsd-core/workflows/discuss-phase/modes/advisor.md', append('read @x gſd-advisor-researcher.md'), 'discuss-phase-power');
    passes('upper case SINGLE PASS alone mandates the single-pass rule', 'gsd-core/workflows/discuss-phase/modes/auto.md', (text) => text.replace(/single pass/gi, 'SINGLE PASS'), 'discuss-phase-power');
    findsOne('a long s is not an s in the single-pass phrase', 'gsd-core/workflows/discuss-phase/modes/auto.md', (text) => text.replace(/single pass/gi, 'ſingle pass'), 'discuss-phase-power', 'auto.md must still mandate the single-pass rule');
    findsOne('an upper-case Let Claude decide mandate is the same mandate', 'gsd-core/references/gate-prompts.md', append('ALWAYS INCLUDE "LET CLAUDE DECIDE" as the last option.'), 'discuss-phase-power', 'gray-area-option must NOT mandate "Let Claude decide" (#2772)');
    passes('END HERE alone ends the discuss-phase workflow', 'gsd-core/workflows/discuss-phase.md', within('<step name="auto_advance">', '</step>', (text) => text.replace(/end here|workflow is complete/gi, 'END HERE')), 'discuss-phase-power');
    passes('Workflow Is Complete alone ends the discuss-phase workflow', 'gsd-core/workflows/discuss-phase.md', within('<step name="auto_advance">', '</step>', (text) => text.replace(/end here|workflow is complete/gi, 'Workflow Is Complete')), 'discuss-phase-power');
    passes('END HERE alone ends the assumptions workflow', 'gsd-core/workflows/discuss-phase-assumptions.md', within('<step name="auto_advance">', '</step>', (text) => text.replace(/end here|workflow is complete/gi, 'END HERE')), 'discuss-phase-power');
    passes('Workflow Is Complete alone ends the assumptions workflow', 'gsd-core/workflows/discuss-phase-assumptions.md', within('<step name="auto_advance">', '</step>', (text) => text.replace(/end here|workflow is complete/gi, 'Workflow Is Complete')), 'discuss-phase-power');
    test('a glob in a workflow nothing else reads is one finding', (t) => {
      const root = applyEdits1(t, [['gsd-core/workflows/add-backlog.md', append('ls .planning/*-SPEC.md')]], true);
      const findings = runShipped(root, ['discuss-phase-power']);
      assert.equal(findings.length, 1, JSON.stringify(findings.map((f) => f.message)));
      assert.equal(findings[0].file, 'gsd-core/workflows/add-backlog.md');
      assert.match(findings[0].message, /workflows read has_spec \/ spec_path from init instead of an ls over \*-SPEC\.md/);
    });
    test('an empty workflow nothing else reads is one finding', (t) => {
      const root = copyOfRepoFiles(t, HEAVY);
      fs.writeFileSync(path.join(root, ...'gsd-core/workflows/add-backlog.md'.split('/')), '');
      const findings = runShipped(root, ['discuss-phase-power']);
      assert.equal(findings.length, 1, JSON.stringify(findings.map((f) => f.message)));
      assert.match(findings[0].message, /the file is empty/);
    });
    test('a workflow directory with no markdown file is one finding of its own', (t) => {
      const root = copyOfRepoFiles(t);
      const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.md') ? [path.join(dir, e.name)] : []));
      for (const file of walk(path.join(root, 'gsd-core', 'workflows'))) fs.unlinkSync(file);
      const findings = runShipped(root, ['discuss-phase-power']).filter((f) => /the workflows must exist/.test(f.message));
      assert.equal(findings.length, 1, JSON.stringify(findings));
    });
    // Both SPEC rules on one line are one finding: discuss-phase.md and plan-phase.md also keep their own literal out.
    exactly1('a line that breaks both SPEC rules of discuss-phase.md is one finding', [['gsd-core/workflows/discuss-phase.md', append('ls ${phase_dir}/*-SPEC.md')]], 'discuss-phase-power', 1, /workflows read has_spec \/ spec_path from init instead of an ls over \*-SPEC\.md/);
    exactly1('a line that breaks both SPEC rules of plan-phase.md is one finding', [['gsd-core/workflows/plan-phase.md', append('ls x | grep y *-SPEC.md" 2>/dev/null | grep z')]], 'discuss-phase-power', 1, /workflows read has_spec \/ spec_path from init instead of an ls over \*-SPEC\.md/);
    editFiles1('the plan-phase literal alone is a finding', [['gsd-core/workflows/plan-phase.md', append('find x -name "*-SPEC.md" 2>/dev/null | grep y')]], 'discuss-phase-power', /plan-phase\.md filters SPEC names itself/);
    editFiles1('the discuss-phase literal alone is a finding', [['gsd-core/workflows/discuss-phase.md', append('xls ${phase_dir}/*-SPEC.md')]], 'discuss-phase-power', /discuss-phase\.md reads has_spec \/ spec_path from init instead of its own ls/);
    passes('an ls without a SPEC glob on its line is not a glob', 'gsd-core/workflows/discuss-phase/modes/auto.md', append('ls .planning/\n*-SPEC.md'), 'discuss-phase-power');
    findsOne('a lone carriage return does not end the line (splitLines keeps ls and the glob together)', 'gsd-core/workflows/discuss-phase/modes/auto.md', append('ls x\r*-SPEC.md'), 'discuss-phase-power', 'workflows read has_spec / spec_path from init instead of an ls over *-SPEC.md');
    findsOne('a line separator does not end the line either', 'gsd-core/workflows/discuss-phase/modes/auto.md', append('ls x\u2028*-SPEC.md'), 'discuss-phase-power', 'workflows read has_spec / spec_path from init instead of an ls over *-SPEC.md');
    passes('a word that ends in ls is not ls', 'gsd-core/workflows/discuss-phase/modes/auto.md', append('tools *-SPEC.md'), 'discuss-phase-power');
    {
      const fc = require('./helpers/fast-check-setup.cjs');
      const power = require('../scripts/static-checks/text-contracts/discuss-phase-power.cjs').walkers;
      const strings = (tokens, maxLength = 10) => fc.array(fc.constantFrom(...tokens), { maxLength }).map((parts) => parts.join(''));
      const agrees = (name, arbitrary, pair, isAccepted = (expected) => Boolean(expected)) => {
        let accepted = 0;
        let rejected = 0;
        fc.assert(fc.property(arbitrary, (s) => {
          const [actual, expected] = pair(s);
          assert.equal(actual, expected, JSON.stringify(s));
          if (isAccepted(expected)) accepted += 1;
          else rejected += 1;
        }));
        assert.ok(accepted > 0 && rejected > 0, `${name}: the property saw ${accepted} accepted and ${rejected} rejected strings`);
      };
      const withFiller = (parts) => fc.tuple(...parts.map(() => fc.nat(2))).map((pads) => parts.map((part, i) => part + 'x'.repeat(pads[i])).join(''));
      test('property: the word walk agrees with the boundary patterns it replaced', () => {
        const inputs = fc.oneof(strings(['HOW', 'WHAT', 'HOWL', '_HOW', 'HOW_', 'how', ' ', '\n', 'é', '9', 'WHAT?'], 8), withFiller(['HOW', ' ', 'WHAT']));
        agrees('HOW', inputs, (s) => [power.hasWord(s, 'HOW'), /\bHOW\b/.test(s)]);
        agrees('WHAT', inputs, (s) => [power.hasWord(s, 'WHAT'), /\bWHAT\b/.test(s)]);
        agrees('ls', strings(['ls', 'tools', 'ls_', '_ls', ' ', '-', 'ls.', 'x'], 6), (s) => [power.hasWord(s, 'ls'), /\bls\b/.test(s)]);
      });
      test('property: the manual-read walk agrees with the pattern it replaced', () => {
        const inputs = fc.oneof(
          strings(['read', 'Read', 'READ', ' ', '\n', '\r', '\u2028', '\u2029', '\u00a0', '@', 'gsd-advisor-researcher.md', 'GSD-ADVISOR-RESEARCHER.MD', 'gſd-advisor-researcher.md', 'x', '\t'], 9),
          fc.tuple(fc.constantFrom('read', 'READ', 'already'), fc.constantFrom(' ', '\n', '\u00a0', '', '  '), fc.constantFrom('@', ' @'), fc.constantFrom('', 'x', ' x', '\nx', '\u2028'), fc.constantFrom('gsd-advisor-researcher.md', 'gsd-advisor-researcher.MD', 'gſd-advisor-researcher.md')).map((parts) => parts.join('')),
        );
        agrees('readsAgentDef', inputs, (s) => [power.readsAgentDef(s), /read\s+@.*gsd-advisor-researcher\.md/i.test(s)]);
      });
      test('property: the glob walk agrees with the per-line pattern it replaced', () => {
        const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
        const oldGlobs = (s) => splitLines(s).some((line) => /\bls\b/.test(line) && line.includes('*-SPEC.md'));
        const inputs = fc.oneof(strings(['ls', ' ', '*-SPEC.md', '\n', '\r\n', '\r', '\u2028', '\u2029', 'x', 'tools', 'ls_'], 8), withFiller(['ls ', '*-SPEC.md']));
        agrees('lsGlobsSpec', inputs, (s) => [power.lsGlobsSpec(s, splitLines), oldGlobs(s)]);
      });
      test('property: the upper-or-lower-case phrases agree with the patterns they replaced', () => {
        const tokens = ['single pass', 'SINGLE PASS', 'Single Pass', 'ſingle pass', 'single\npass', 'end here', 'END HERE', 'workflow is complete', 'Workflow Is Complete', 'always include "let claude decide"', 'ALWAYS INCLUDE "LET CLAUDE DECIDE"', 'always include "let claude decide', ' ', 'x'];
        const inputs = strings(tokens, 5);
        agrees('single pass', inputs, (s) => [power.mentions(s, 'single pass'), /single pass/i.test(s)]);
        agrees('ends', inputs, (s) => [power.mentions(s, 'end here') || power.mentions(s, 'workflow is complete'), /end here|workflow is complete/i.test(s)]);
        agrees('let claude decide', inputs, (s) => [power.mentions(s, 'always include "let claude decide"'), /Always include "Let Claude decide"/i.test(s)]);
      });
      test('property: the order check agrees with the index comparison it replaced', () => {
        const inputs = fc.oneof(strings(['A', 'B', 'x', ' '], 8), withFiller(['A', 'B']));
        agrees('precedes', inputs, (s) => [power.precedes(s, 'A', 'B') === true, s.indexOf('A') === -1 || s.indexOf('B') === -1 || s.indexOf('A') < s.indexOf('B')]);
      });
    }

    // ---- workflow-maintainer-skip: one finding per cause, the comment-stripped verdict order, the walkers
    goneOne1('.github/workflows/close-draft-prs.yml', 'workflow-maintainer-skip', 'removed');
    goneOne1('.github/workflows/close-draft-prs.yml', 'workflow-maintainer-skip', 'emptied');
    goneOne1('.github/workflows/close-draft-prs-sweep.yml', 'workflow-maintainer-skip', 'removed');
    goneOne1('.github/workflows/close-draft-prs-sweep.yml', 'workflow-maintainer-skip', 'emptied');
    goneOne1('.github/workflows/pr-target-validator.yml', 'workflow-maintainer-skip', 'removed');
    goneOne1('.github/workflows/pr-target-validator.yml', 'workflow-maintainer-skip', 'emptied');
    goneOne1('.github/workflows/pr-title-validator.yml', 'workflow-maintainer-skip', 'removed');
    goneOne1('.github/workflows/pr-title-validator.yml', 'workflow-maintainer-skip', 'emptied');
    goneOne1('.github/workflows/require-issue-link.yml', 'workflow-maintainer-skip', 'removed');
    goneOne1('.github/workflows/require-issue-link.yml', 'workflow-maintainer-skip', 'emptied');
    goneOne1('.github/workflows/auto-backmerge.yml', 'workflow-maintainer-skip', 'removed');
    goneOne1('.github/workflows/auto-backmerge.yml', 'workflow-maintainer-skip', 'emptied');
    // The contract is built with a js-yaml loader that throws: the failure is a finding of its own.
    const seamRun1 = (t, root, factory) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-seam-'));
      t.after(() => cleanup(dir));
      const real = path.join(REPO_ROOT, 'scripts', 'static-checks', 'text-contracts', 'workflow-maintainer-skip.cjs');
      fs.writeFileSync(path.join(dir, 'workflow-maintainer-skip.cjs'), `const real = require(${JSON.stringify(real)});\nmodule.exports = { id: real.id, check: ${factory} };\n`);
      return textContracts.run({ root, dir, only: ['workflow-maintainer-skip'], minContracts: 1 });
    };
    const throwingYaml1 = "real.walkers.buildCheck(() => { throw new Error('no module'); })";
    test('a js-yaml that cannot be loaded is one finding', (t) => {
      const findings = seamRun1(t, copyOfRepoFiles(t), throwingYaml1);
      assert.equal(findings.length, 1, JSON.stringify(findings.map((f) => f.message)));
      assert.match(findings[0].message, /js-yaml cannot be loaded: no module/);
    });
    test('a js-yaml that cannot be loaded does not hide a failing text check', (t) => {
      const root = applyEdits1(t, [['.github/workflows/close-draft-prs-sweep.yml', eraseAll('workflow_dispatch:')]]);
      const findings = seamRun1(t, root, throwingYaml1);
      assert.ok(findings.some((f) => /the draft sweep has a manual dispatch for testing/.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
      assert.ok(findings.some((f) => /js-yaml cannot be loaded/.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
    });
    exactly1('a failing job-level if: is one finding', [['.github/workflows/require-issue-link.yml', yamlEdit((workflow) => { workflow.jobs['check-issue-link'].if = 'github.actor != 0'; })]], 'workflow-maintainer-skip', 1, /a job-level `if:` would report "skipped"/);
    passes('a YAML comment naming core.setFailed( above the catch does not move the verdict (.github/workflows/pr-title-validator.yml)', '.github/workflows/pr-title-validator.yml', (text) => '# core.setFailed( is named in this comment\n' + text, 'workflow-maintainer-skip');
    passes('a YAML comment naming core.setFailed( above the catch does not move the verdict (.github/workflows/pr-target-validator.yml)', '.github/workflows/pr-target-validator.yml', (text) => '# core.setFailed( is named in this comment\n' + text, 'workflow-maintainer-skip');
    passes('a YAML comment naming core.setFailed( above the catch does not move the verdict (.github/workflows/require-issue-link.yml)', '.github/workflows/require-issue-link.yml', (text) => '# core.setFailed( is named in this comment\n' + text, 'workflow-maintainer-skip');
    passes('a pull_request: key with a trailing comment is not a bare trigger', '.github/workflows/close-draft-prs.yml', append('  pull_request: # not a trigger'), 'workflow-maintainer-skip');
    editFiles1('a pull_request: key under its own block is a bare trigger', [['.github/workflows/close-draft-prs.yml', append('on2:\n  pull_request:\n    types: [opened]')]], 'workflow-maintainer-skip', /draft PR auto-close must not use the bypassable pull_request trigger/);
    editFiles1('the other write scope on the next line is still a grant', [['.github/workflows/pr-title-validator.yml', append('  issues:\n    write')]], 'workflow-maintainer-skip', /does not call a issues\.\* API/);
    passes('a write scope followed by a comment is not a grant', '.github/workflows/pr-title-validator.yml', append('  issues: write # not a grant'), 'workflow-maintainer-skip');
    test('the verdict-ordering walk rejects the inversion it exists to catch', () => {
      const skip = require('../scripts/static-checks/text-contracts/workflow-maintainer-skip.cjs').walkers;
      const good = ['try {', '  await github.rest.issues.createComment({});', '} catch (err) {', '  core.warning(`Could not post the comment (${err.status}).`);', '}', "core.setFailed('nope');"].join('\n');
      const inverted = ['try {', '  await github.rest.issues.createComment({});', "  core.setFailed('nope');", '} catch (err) {', '  core.warning(`Could not post the comment (${err.status}).`);', '}'].join('\n');
      assert.equal(skip.verdictSurvivesCommentFailure(good), true);
      assert.equal(skip.verdictSurvivesCommentFailure(inverted), false);
      assert.equal(skip.verdictSurvivesCommentFailure("core.setFailed('x');"), false);
      assert.equal(skip.verdictSurvivesCommentFailure('core.warning(`Could not post`);'), false);
    });
    {
      const fc = require('./helpers/fast-check-setup.cjs');
      const skip = require('../scripts/static-checks/text-contracts/workflow-maintainer-skip.cjs').walkers;
      const strings = (tokens, maxLength = 10) => fc.array(fc.constantFrom(...tokens), { maxLength }).map((parts) => parts.join(''));
      const agrees = (name, arbitrary, pair, isAccepted = (expected) => Boolean(expected)) => {
        let accepted = 0;
        let rejected = 0;
        fc.assert(fc.property(arbitrary, (s) => {
          const [actual, expected] = pair(s);
          assert.equal(actual, expected, JSON.stringify(s));
          if (isAccepted(expected)) accepted += 1;
          else rejected += 1;
        }));
        assert.ok(accepted > 0 && rejected > 0, `${name}: the property saw ${accepted} accepted and ${rejected} rejected strings`);
      };
      // A chain of parts with a short filler after each: crosses the shapes the patterns accept.
      const chainOf = (parts, filler) => fc.tuple(...parts.map(() => fc.constantFrom(...filler))).map((fills) => parts.map((part, i) => part + fills[i]).join(''));
      const blanks = ['', ' ', '\n', '\t', '\r', '\u2028', '\u2029', '\u00a0', ' x'];
      test('property: the line-key walks agree with the multiline patterns they replaced', () => {
        const tokens = ['pull_request', '_target', ':', ' ', '\n', '\r', '\u2028', '\u2029', '\t', 'x', '#', '\u00a0'];
        const inputs = fc.oneof(strings(tokens, 10), chainOf(['', 'pull_request_target:', ''], blanks), chainOf(['', 'pull_request:', ''], blanks));
        agrees('pull_request_target', inputs, (s) => [skip.hasKeyLine(s, 'pull_request_target:'), /^\s*pull_request_target:/m.test(s)]);
        agrees('bare pull_request', inputs, (s) => [skip.hasBareKey(s, 'pull_request:'), /^\s*pull_request:\s*$/m.test(s)]);
        agrees('any pull_request trigger', inputs, (s) => [skip.hasPullRequestTrigger(s), /^\s*pull_request(_target)?:/m.test(s)]);
      });
      test('property: the write-scope walk agrees with the patterns it replaced', () => {
        const tokens = ['issues', 'pull-requests', ':', ' ', '\n', '\r', '\u2028', 'write', 'x', '#', '\u00a0', 'permissions'];
        const inputs = fc.oneof(strings(tokens, 10), chainOf(['', 'issues:', 'write', ''], blanks), chainOf(['', 'pull-requests:', 'write', ''], blanks));
        agrees('issues write', inputs, (s) => [skip.hasWriteScope(s, 'issues'), /^\s*issues:\s*write\s*$/m.test(s)]);
        agrees('pull-requests write', inputs, (s) => [skip.hasWriteScope(s, 'pull-requests'), /^\s*pull-requests:\s*write\s*$/m.test(s)]);
      });
      test('property: the try and catch walks agree with the patterns they replaced', () => {
        const tokens = ['try', 'retry', '{', '}', ' ', '\n', 'catch', '(err)', '(e)', 'core.warning', 'core.info', 'x', '_', '\u2028'];
        const inputs = fc.oneof(strings(tokens, 10), chainOf(['', 'try', '{', ''], blanks), chainOf(['', 'catch', '(err)', '{', 'core.warning'], blanks));
        agrees('try', inputs, (s) => [skip.hasTryBlock(s), /\btry\s*\{/.test(s)]);
        agrees('catch warning', inputs, (s) => [skip.hasCatchWarning(s), /catch\s*\(err\)\s*\{[\s\S]*?core\.warning/.test(s)]);
      });
      test('property: the comment-stripped verdict order agrees with the code it replaced', () => {
        const oldCode = (s) => s.split('\n').filter((line) => { const t = line.trim(); return t !== '' && !t.startsWith('#') && !t.startsWith('//'); }).join('\n');
        const oldSurvives = (code) => { const w = code.indexOf('Could not post'); const v = code.indexOf('core.setFailed('); return !(w === -1 || v === -1) && v > w; };
        const tokens = ['Could not post', 'core.setFailed(', '# ', '// ', '\n', ' ', 'x', '\t'];
        const inputs = fc.oneof(strings(tokens, 9), chainOf(['', 'Could not post', '\n', 'core.setFailed(', ''], ['', ' ', '# ']));
        agrees('code', inputs, (s) => [skip.codeOnly(s), oldCode(s)], (expected) => expected.length > 0);
        agrees('verdict order', inputs, (s) => [skip.verdictSurvivesCommentFailure(skip.codeOnly(s)), oldSurvives(oldCode(s))]);
      });
      test('property: the sanitizer and phrase walks agree with the patterns they replaced', () => {
        const sanitizer = ['const titleForMarkdown = String(', 'title', 'x_1', ')', '.replace(/`/g, "\'")', '.replace(/`/g,', ' ', '\n', '()'];
        agrees('sanitizer', fc.oneof(strings(sanitizer, 8), chainOf(['const titleForMarkdown = String(', 'x', ').replace(/`/g, "\'")'], ['', 'x', '_', ' '])), (s) => [skip.declaresSanitizer(s, 'titleForMarkdown'), /const titleForMarkdown = String\(\w+\)\.replace\(\/`\/g, "'"\)/.test(s)]);
        const cron = ['cron:', ' ', '\n', "'0 */6 * * *'", "'0 */8 * * *'", 'x'];
        agrees('cron', fc.oneof(strings(cron, 6), chainOf(['cron:', "'0 */6 * * *'"], blanks)), (s) => [skip.afterBlanks(s, 'cron:', "'0 */6 * * *'"), /cron:\s*'0 \*\/6 \* \* \*'/.test(s)]);
        const state = ['state:', ' ', '\n', "'open'", "'closed'", 'x'];
        agrees('state', fc.oneof(strings(state, 6), chainOf(['state:', "'open'"], blanks)), (s) => [skip.afterBlanks(s, 'state:', "'open'"), /state:\s*'open'/.test(s)]);
        const permissions = ['permissions:', ' ', '\n', 'pull-requests:', 'write', 'read', 'x', '\t'];
        agrees('permissions', fc.oneof(strings(permissions, 8), chainOf(['permissions:', 'pull-requests:', 'write'], blanks)), (s) => [skip.sweepWrites(s), /permissions:\s+pull-requests:\s*write/.test(s)]);
        const association = ['!MAINTAINER_ASSOCIATIONS.has(', 'pr', '.author_association', ')', 'x', '(', ' ', '\n'];
        agrees('association', fc.oneof(strings(association, 7), chainOf(['!MAINTAINER_ASSOCIATIONS.has(', 'pr', '.author_association', ')'], ['', 'x', ' ', ')'])), (s) => [skip.hasAssociationCheck(s), /!MAINTAINER_ASSOCIATIONS\.has\([^)]*\.author_association\)/.test(s)]);
      });
    }

    // ---- review round 1: one finding per cause for the gate prompt blocks, the default flow's HOW slice and the analyzer prompt
    exactly1('the gray-area-option marker gone is one finding', [['gsd-core/references/gate-prompts.md', swap('## Pattern: gray-area-option', '## Pattern: gray-areas')]], 'discuss-phase-power', 1, /marker "## Pattern: gray-area-option" not found/);
    exactly1('the context-handling marker gone is one finding', [['gsd-core/references/gate-prompts.md', swap('## Pattern: context-handling', '## Pattern: contexts')]], 'discuss-phase-power', 1, /marker "## Pattern: context-handling" not found/);
    exactly1('a gray-area-option marker only before context-handling is one finding (it closes no block)', [['gsd-core/references/gate-prompts.md', compose1(swap('## Pattern: gray-area-option', '## Pattern: other'), (text) => '## Pattern: gray-area-option\n' + text)]], 'discuss-phase-power', 1, /closing marker ## Pattern: gray-area-option precedes ## Pattern: context-handling/);
    exactly1('the SPEC.md awareness heading gone is one finding', [['gsd-core/workflows/discuss-phase.md', swap('2b. **SPEC.md awareness**', '2b. **SPEC awareness**')]], 'discuss-phase-power', 1, /marker "2b\. \*\*SPEC\.md awareness\*\*" not found/);
    exactly1('the Gray areas heading gone is one finding', [['gsd-core/workflows/discuss-phase.md', swap('3. **Gray areas**', '3. **Areas**')]], 'discuss-phase-power', 1, /3\. \*\*Gray areas\*\*/);
    exactly1('the analyzer spawn gone is one finding', [['gsd-core/workflows/discuss-phase-assumptions.md', swap('Agent(subagent_type="gsd-assumptions-analyzer"', 'Agent(subagent_type="gsd-other"')]], 'discuss-phase-power', 1, /gsd-assumptions-analyzer/);
    exactly1('the analyzer prompt close marker gone is one finding', [['gsd-core/workflows/discuss-phase-assumptions.md', swap('${AGENT_SKILLS_ANALYZER}\n""")', '${AGENT_SKILLS_ANALYZER}\n"""')]], 'discuss-phase-power', 1, /AGENT_SKILLS_ANALYZER/);

    // ---- review round 1: every shape the issue-link workflow's jobs can take is one finding, never a throw
    for (const [title, loadBody, expected] of [
      ['a document that is null', 'null', /the workflow has no jobs mapping/],
      ['a scalar document', "'text'", /the workflow has no jobs mapping/],
      ['jobs: null', '({ jobs: null })', /the workflow has no jobs mapping/],
      ['jobs as a scalar', "({ jobs: 'x' })", /the workflow has no jobs mapping/],
      ['jobs as a list', '({ jobs: [] })', /the workflow has no check-issue-link job/],
      ['jobs without the job', '({ jobs: {} })', /the workflow has no check-issue-link job/],
      ['check-issue-link: null', "({ jobs: { 'check-issue-link': null } })", /the workflow has no check-issue-link job/],
      ['check-issue-link as a scalar', "({ jobs: { 'check-issue-link': 'x' } })", /the workflow has no check-issue-link job/],
      ['a job with an if:', "({ jobs: { 'check-issue-link': { if: 'x' } } })", /the job has an if:/],
    ]) {
      test(`${title} is one finding of the job-level if check`, (t) => {
        const findings = seamRun1(t, copyOfRepoFiles(t), `real.walkers.buildCheck(() => ({ load: () => ${loadBody} }))`);
        assert.equal(findings.length, 1, JSON.stringify(findings.map((f) => f.message)));
        assert.match(findings[0].message, expected);
      });
    }
    test('a document that is not valid YAML is one finding of the job-level if check', (t) => {
      const findings = seamRun1(t, copyOfRepoFiles(t), "real.walkers.buildCheck(() => ({ load: () => { throw new Error('bad'); } }))");
      assert.equal(findings.length, 1, JSON.stringify(findings.map((f) => f.message)));
      assert.match(findings[0].message, /the workflow is not valid YAML: bad/);
    });

    // ---- review round 2: the text-lines loader seam, a gray-area-option marker before context-handling, an empty parent block
    const seamRunOf1 = (t, root, name, factory) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-seam-'));
      t.after(() => cleanup(dir));
      const real = path.join(REPO_ROOT, 'scripts', 'static-checks', 'text-contracts', `${name}.cjs`);
      fs.writeFileSync(path.join(dir, `${name}.cjs`), `const real = require(${JSON.stringify(real)});\nmodule.exports = { id: real.id, check: ${factory} };\n`);
      return textContracts.run({ root, dir, only: [name], minContracts: 1 });
    };
    const throwingLines1 = "real.walkers.buildCheck(() => { throw new Error('no module'); })";
    test('a text-lines module that cannot be loaded is one finding', (t) => {
      const findings = seamRunOf1(t, copyOfRepoFiles(t), 'discuss-phase-power', throwingLines1);
      assert.equal(findings.length, 1, JSON.stringify(findings.map((f) => f.message)));
      assert.match(findings[0].message, /gsd-core\/bin\/lib\/text-lines\.cjs cannot be loaded: no module/);
    });
    test('a text-lines module that cannot be loaded still runs the glob walk on a line feed split', (t) => {
      const root = applyEdits1(t, [['gsd-core/workflows/discuss-phase/modes/auto.md', append('ls .planning/*-SPEC.md')]]);
      const findings = seamRunOf1(t, root, 'discuss-phase-power', throwingLines1);
      assert.equal(findings.length, 2, JSON.stringify(findings.map((f) => f.message)));
      assert.ok(findings.some((f) => /cannot be loaded: no module/.test(f.message)));
      assert.ok(findings.some((f) => /workflows read has_spec \/ spec_path from init instead of an ls over \*-SPEC\.md/.test(f.message)));
    });
    exactly1('a gray-area-option marker before context-handling and another after it is one finding', [['gsd-core/references/gate-prompts.md', (text) => '## Pattern: gray-area-option\n' + text]], 'discuss-phase-power', 1, /closing marker ## Pattern: gray-area-option precedes ## Pattern: context-handling/);
    exactly1('an empty parent answer_validation block is one finding', [['gsd-core/workflows/discuss-phase.md', within('<answer_validation>', '</answer_validation>', () => '<answer_validation>')]], 'discuss-phase-power', 1, /answer_validation must match the parent canonical block exactly/);
  }

  {
    // update-workflow, plan-phase-ui-redirect and review-default-reviewers-workflow: the unresolved-path spies, controls, the exactly-one-finding
    // cases, the loader seams and a differential property for every linear walker.
    const UPDATE = 'gsd-core/workflows/update.md';
    const PLAN_PHASE = 'gsd-core/workflows/plan-phase.md';
    const REVIEW = 'gsd-core/workflows/review.md';
    const INSTALLED_STEP = '<step name="get_installed_version">';
    const rewrite = (root, rel, edit) => {
      const abs = path.join(root, ...rel.split('/'));
      const before = fs.readFileSync(abs, 'utf8');
      const after = edit(before);
      assert.notEqual(after, before, 'the edit changed the file');
      fs.writeFileSync(abs, after);
    };
    const runEdits = (t, edits, contract) => {
      const root = copyOfRepoFiles(t);
      for (const [rel, edit] of edits) rewrite(root, rel, edit);
      return runShipped(root, [contract]);
    };
    const messagesOf = (findings) => JSON.stringify(findings.map((f) => f.message));

    // The unresolved path must reach none of the six later mutations, and each must still follow the exit.
    const SPIES_LIST = [
      ['version check', 'check-latest-version.cjs'],
      ['custom-file detection', 'detect-custom-files --config-dir'],
      ['resolved installer', 'npx -y --package=@opengsd/gsd-core@"$TAG" -- gsd-core "$RUNTIME_FLAG"'],
      ['update-cache removal', 'rm -f "$HOME/.cache/gsd/gsd-update-check"'],
      ['restore apply', 'restore-custom-files --config-dir "$GSD_DIR" --apply'],
      ['patch check', 'check_local_patches'],
    ];
    const SPIES_NEEDLES = SPIES_LIST.map(([, needle]) => needle);
    for (const [name, needle] of SPIES_LIST) {
      test(`the unresolved path holding ${name} is exactly one finding`, (t) => {
        const findings = runEdits(t, [[UPDATE, within(INSTALLED_STEP, '</step>', append(needle))]], 'update-workflow');
        assert.equal(findings.length, 1, messagesOf(findings));
        assert.ok(findings[0].message.includes(`the unresolved path reaches ${name}`), messagesOf(findings));
      });
      test(`${name} removed after the exit is a finding`, (t) => {
        const edit = (text) => {
          const end = text.indexOf('</step>', text.indexOf(INSTALLED_STEP));
          return text.slice(0, end) + text.slice(end).split(needle).join('');
        };
        const findings = runEdits(t, [[UPDATE, edit]], 'update-workflow');
        assert.ok(findings.some((f) => f.message.includes(`${name} must remain after the exit`)), messagesOf(findings));
      });
    }

    // Controls.
    passes('a ~/.claude/ path with a trailing slash is not bare', UPDATE, append('see ~/.claude/gsd and $HOME/.claude/x'), 'update-workflow');
    passes('npx -y @opengsd/gsd-core@ followed by a blank is not the stale form', UPDATE, append('npx -y @opengsd/gsd-core@ x'), 'update-workflow');
    passes('a tag-parameterized install outside run_update does not change its count', UPDATE, append('npx -y --package=@opengsd/gsd-core@"$TAG" -- gsd-core'), 'update-workflow');
    passes('an unguarded sketch probe in a text fence is not scanned', PLAN_PHASE, append('```text\nX=$(ls ./.claude/skills/sketch-findings-*/SKILL.md)\n```'), 'plan-phase-ui-redirect');
    passes('an unguarded probe in a bash block that never closes is not scanned', 'gsd-core/workflows/new-project.md', append('```bash\nX=$(ls ./.claude/skills/sketch-findings-*/SKILL.md)'), 'plan-phase-ui-redirect');
    passes('a probe line of another skill path is not a findings probe', 'gsd-core/workflows/new-project.md', append('```bash\nX=$(ls ./.claude/skills/other/SKILL.md)\n```'), 'plan-phase-ui-redirect');
    passes('a guard with no blank before true is a guard', 'gsd-core/workflows/new-project.md', append('```bash\nX=$(ls ./.claude/skills/sketch-findings-*/SKILL.md ||true)\n```'), 'plan-phase-ui-redirect');
    passes('a guard with a tab before true is a guard', 'gsd-core/workflows/new-project.md', append('```bash\nX=$(ls ./.claude/skills/spike-findings-*/SKILL.md ||\ttrue)\n```'), 'plan-phase-ui-redirect');
    passes('a guarded probe in a tilde bash fence passes', 'gsd-core/workflows/new-project.md', append('~~~bash\nX=$(ls ./.claude/skills/spike-findings-*/SKILL.md || true)\n~~~'), 'plan-phase-ui-redirect');
    // The prompt block as a longer fence with a nested shorter fence: the instructions after the nested fence are still found.
    passes('a four-backtick prompt block with a nested bash fence still yields the instructions', REVIEW, (text) => swap('\n## Review Instructions\n', '\n```bash\necho hi\n```\n## Review Instructions\n')(
      swap('Output your review in markdown format.\n```', 'Output your review in markdown format.\n````')(
        swap('```markdown\n# Cross-AI Plan Review Request', '````markdown\n# Cross-AI Plan Review Request')(text))), 'review-default-reviewers-workflow');
    passes('an opening fence indented by three blanks is a fence', REVIEW, swap('```markdown\n# Cross-AI Plan Review Request', '   ```markdown\n# Cross-AI Plan Review Request'), 'review-default-reviewers-workflow');
    passes('trailing blanks after the markdown info string are allowed', REVIEW, swap('```markdown\n# Cross-AI Plan Review Request', '```markdown  \n# Cross-AI Plan Review Request'), 'review-default-reviewers-workflow');
    findsOne('a four-backtick opener with only three-backtick closers never closes', REVIEW, swap('```markdown\n# Cross-AI Plan Review Request', '````markdown\n# Cross-AI Plan Review Request'), 'review-default-reviewers-workflow', 'build_prompt markdown fence must be closed');
    findsOne('an opening fence indented by four blanks is not a fence', REVIEW, swap('\n```markdown', '\n    ```markdown'), 'review-default-reviewers-workflow', 'build_prompt must contain a ```markdown prompt block');
    findsOne('a line separator after the markdown info string is not the prompt block', REVIEW, swap('```markdown\n', '```markdown\u2028\n'), 'review-default-reviewers-workflow', 'build_prompt must contain a ```markdown prompt block');
    findsOne('a paragraph separator after the markdown info string is not the prompt block', REVIEW, swap('```markdown\n', '```markdown\u2029\n'), 'review-default-reviewers-workflow', 'build_prompt must contain a ```markdown prompt block');
    findsOne('a line separator after the closing fence is not a closing fence', REVIEW, (text) => {
      const end = 'Output your review in markdown format.\n```';
      return text.slice(0, text.indexOf(end) + end.length) + '\u2028\n';
    }, 'review-default-reviewers-workflow', 'build_prompt markdown fence must be closed');
    findsOne('a paragraph separator after the closing fence is not a closing fence', REVIEW, (text) => {
      const end = 'Output your review in markdown format.\n```';
      return text.slice(0, text.indexOf(end) + end.length) + '\u2029\n';
    }, 'review-default-reviewers-workflow', 'build_prompt markdown fence must be closed');
    findsOne('a tilde opener is not the prompt block', REVIEW, swap('\n```markdown', '\n~~~markdown'), 'review-default-reviewers-workflow', 'build_prompt must contain a ```markdown prompt block');
    findsOne('text after the markdown info string is not the prompt block', REVIEW, swap('```markdown\n', '```markdown x\n'), 'review-default-reviewers-workflow', 'build_prompt must contain a ```markdown prompt block');
    test('instructions after the next heading of the prompt are outside the region', (t) => {
      const findings = runEdits(t, [[REVIEW, swap('## Review Instructions\n', '## Review Instructions\n\n## Interlude\n')]], 'review-default-reviewers-workflow');
      assert.equal(findings.length, 2, messagesOf(findings));
      assert.ok(findings.every((f) => /missing \[/.test(f.message)), messagesOf(findings));
    });

    // Exactly one finding for a missing step, a missing marker, a removed or an emptied file.
    for (const step of ['get_installed_version', 'check_latest_version', 'run_update']) {
      findsOne(`the ${step} step renamed is one finding`, UPDATE, swap(`<step name="${step}">`, `<step name="${step}_x">`), 'update-workflow', `marker "<step name=\\"${step}\\">" not found`);
    }
    findsOne('the §5.6 heading renumbered is one finding', PLAN_PHASE, swap('## 5.6.', '## 5.6'), 'plan-phase-ui-redirect', 'marker "## 5.6." not found');
    findsOne('the heading after §5.6 renumbered is one finding', PLAN_PHASE, swap('\n## 6.', '\n## six.'), 'plan-phase-ui-redirect', 'closing marker');
    findsOne('the build_prompt step renamed is one finding', REVIEW, swap('<step name="build_prompt">', '<step name="build_prompt_x">'), 'review-default-reviewers-workflow', 'build_prompt step must exist');
    findsOne('the Review Instructions heading erased is one finding', REVIEW, eraseAll('## Review Instructions'), 'review-default-reviewers-workflow', 'fenced prompt must contain a ## Review Instructions section');
    findsOne('one spike probe losing its guard is one finding', PLAN_PHASE, swap('SPIKE_FINDINGS_PATH=$(ls ./.claude/skills/spike-findings-*/SKILL.md 2>/dev/null | head -1 || true)', 'SPIKE_FINDINGS_PATH=$(ls ./.claude/skills/spike-findings-*/SKILL.md 2>/dev/null | head -1)'), 'plan-phase-ui-redirect', 'plan-phase.md:');
    for (const [rel, contract] of [
      [UPDATE, 'update-workflow'],
      ['commands/gsd/update.md', 'update-workflow'],
      [PLAN_PHASE, 'plan-phase-ui-redirect'],
      ['gsd-core/workflows/ui-phase.md', 'plan-phase-ui-redirect'],
      ['gsd-core/workflows/discuss-phase.md', 'plan-phase-ui-redirect'],
      ['gsd-core/workflows/new-project.md', 'plan-phase-ui-redirect'],
      [REVIEW, 'review-default-reviewers-workflow'],
    ]) {
      test(`${rel} removed is exactly one finding for ${contract}`, (t) => {
        const root = copyOfRepoFiles(t);
        fs.unlinkSync(path.join(root, ...rel.split('/')));
        const findings = runShipped(root, [contract]);
        assert.equal(findings.length, 1, messagesOf(findings));
        assert.equal(findings[0].file, rel);
        assert.match(findings[0].message, /cannot read the file/);
      });
      test(`${rel} emptied is exactly one finding for ${contract}`, (t) => {
        const root = copyOfRepoFiles(t);
        fs.writeFileSync(path.join(root, ...rel.split('/')), '\n');
        const findings = runShipped(root, [contract]);
        assert.equal(findings.length, 1, messagesOf(findings));
        assert.equal(findings[0].file, rel);
        assert.match(findings[0].message, /the file is empty/);
      });
    }

    // A library that cannot be loaded is one finding of its own and the checks that do not need it still run.
    const seamRun = (t, id, factory) => {
      const root = copyOfRepoFiles(t);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-seam-'));
      t.after(() => cleanup(dir));
      const real = path.join(REPO_ROOT, 'scripts', 'static-checks', 'text-contracts', `${id}.cjs`);
      fs.writeFileSync(path.join(dir, `${id}.cjs`), `const real = require(${JSON.stringify(real)});\nmodule.exports = { id: real.id, check: ${factory} };\n`);
      return textContracts.run({ root, dir, only: [id], minContracts: 1 });
    };
    const UPDATE_CONTEXT_PATH = JSON.stringify(path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', 'update-context.cjs'));
    test('a markdown sectionizer that cannot be loaded is one finding of the update-workflow contract', (t) => {
      const findings = seamRun(t, 'update-workflow', `real.walkers.buildCheck({ loadSectionizer: () => { throw new Error('no build'); }, loadUpdateContext: () => require(${UPDATE_CONTEXT_PATH}) })`);
      assert.equal(findings.length, 1, messagesOf(findings));
      assert.match(findings[0].message, /markdown-sectionizer\.cjs cannot be loaded: no build/);
    });
    test('an update-context module that cannot be loaded is one finding of the update-workflow contract', (t) => {
      const sectionizer = JSON.stringify(path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', 'markdown-sectionizer.cjs'));
      const findings = seamRun(t, 'update-workflow', `real.walkers.buildCheck({ loadSectionizer: () => require(${sectionizer}), loadUpdateContext: () => { throw new Error('no module'); } })`);
      assert.equal(findings.length, 1, messagesOf(findings));
      assert.match(findings[0].message, /update-context\.cjs cannot be loaded: no module/);
    });
    test('a markdown sectionizer that cannot be loaded is one finding of the plan-phase-ui-redirect contract', (t) => {
      const findings = seamRun(t, 'plan-phase-ui-redirect', "real.walkers.buildCheck({ loadSectionizer: () => { throw new Error('no build'); } })");
      assert.equal(findings.length, 1, messagesOf(findings));
      assert.match(findings[0].message, /markdown-sectionizer\.cjs cannot be loaded: no build/);
    });
    test('a markdown sectionizer that cannot be loaded is one finding of the review-default-reviewers-workflow contract', (t) => {
      const findings = seamRun(t, 'review-default-reviewers-workflow', "real.walkers.buildCheck({ loadSectionizer: () => { throw new Error('no build'); } })");
      assert.equal(findings.length, 1, messagesOf(findings));
      assert.match(findings[0].message, /markdown-sectionizer\.cjs cannot be loaded: no build/);
    });

    // The PREFERRED_RUNTIME parity on its own: equal sets, a pair on one side only, a clause with no runtime, a table that is not a list.
    {
      const update = require('../scripts/static-checks/text-contracts/update-workflow.cjs').walkers;
      const LINE = 'Infer `PREFERRED_RUNTIME` from the path: `/.claude/` -> `claude`; `/.gemini/a/`, `/.agents/` -> `antigravity`; otherwise leave it empty';
      test('the PREFERRED_RUNTIME parity accepts equal sets and names the difference', () => {
        const dirs = [['claude', '.claude'], ['antigravity', '.gemini/a'], ['antigravity', '.agents']];
        assert.equal(update.parityProblems(LINE, dirs), true);
        assert.match(update.parityProblems(LINE, dirs.slice(1)), /only in the prose: \["claude:\.claude"\]; only in RUNTIME_DIRS: \[\]/);
        assert.match(update.parityProblems(LINE, [...dirs, ['codex', '.codex']]), /only in the prose: \[\]; only in RUNTIME_DIRS: \["codex:\.codex"\]/);
        assert.match(update.parityProblems('x `/.zed/` -> zed; y', dirs), /clause must name a runtime/);
        assert.match(update.parityProblems(LINE, 'not a list'), /RUNTIME_DIRS is not a list/);
        assert.match(update.parityProblems(LINE, [['claude']]), /RUNTIME_DIRS is not a list/);
      });
    }

    // Properties: each walker against the pattern or loop it replaced. The generators draw random tokens and chains of the pattern's own parts
    // (each part sometimes cut short, with padding), and every property fails unless it saw both an accepted and a rejected string, so it can
    // never compare false with false. Domains: the bash-fence property uses LF-joined lines (the engine normalises CRLF); the review-region
    // property draws fence lines ending in a blank, CR, tab, no-break space or form feed and lets the old code decide; U+2028 and U+2029 are the
    // one difference (the fence matcher's delimiter grammar does not accept a line holding one, where the old regexes took them as blanks) and have
    // their own cases.
    {
      const fc = require('./helpers/fast-check-setup.cjs');
      const update = require('../scripts/static-checks/text-contracts/update-workflow.cjs').walkers;
      const planPhase = require('../scripts/static-checks/text-contracts/plan-phase-ui-redirect.cjs').walkers;
      const review = require('../scripts/static-checks/text-contracts/review-default-reviewers-workflow.cjs').walkers;
      const { precedesWithin } = require('../scripts/static-checks/text-contracts/lib/precedes-within.cjs');
      const { LINE_ENDS } = require('../scripts/static-checks/text-contracts/lib/line-ends.cjs');
      const { asciiLower } = require('../scripts/static-checks/text-contracts/lib/ascii-lower.cjs');
      const sectionizer = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');
      const strings = (tokens, maxLength = 10) => fc.array(fc.constantFrom(...tokens), { maxLength }).map((parts) => parts.join(''));
      // The parts in order, each cut short one time in five, with a gap and 0..40 filler characters after it.
      const chain = (parts, gaps) => fc.tuple(...parts.map(() => fc.tuple(fc.integer({ min: 0, max: 4 }), fc.constantFrom(...gaps), fc.oneof({ weight: 5, arbitrary: fc.constant(0) }, { weight: 1, arbitrary: fc.integer({ min: 1, max: 40 }) }))))
        .map((picks) => picks.map(([cut, gap, pad], i) => (cut === 0 && parts[i].length > 1 ? parts[i].slice(0, -1) : parts[i]) + gap + 'x'.repeat(pad)).join(''));
      // The parts as whole lines in order, each cut short one time in five, with up to two filler lines after each.
      const lineChain = (parts, fillers) => fc.tuple(...parts.map(() => fc.tuple(fc.integer({ min: 0, max: 4 }), fc.array(fc.constantFrom(...fillers), { maxLength: 2 }))))
        .map((picks) => picks.map(([cut, extra], i) => [cut === 0 ? parts[i].slice(0, -1) : parts[i], ...extra].join('\n')).join('\n'));
      const agrees = (name, arbitrary, pair, isAccepted = (expected) => (Array.isArray(expected) ? expected.length > 0 : Boolean(expected))) => {
        let accepted = 0;
        let rejected = 0;
        fc.assert(fc.property(arbitrary, (s) => {
          const [actual, expected] = pair(s);
          assert.deepEqual(actual, expected, JSON.stringify(s));
          if (isAccepted(expected)) accepted += 1;
          else rejected += 1;
        }));
        assert.ok(accepted > 0 && rejected > 0, `${name}: the property saw ${accepted} accepted and ${rejected} rejected strings`);
      };
      const blanks = ['', ' ', '\n', '\t', '\u00a0', '\u2028', '\ufeff'];
      const stops = ['', ' ', 'x', '\n', '\r', '\u2028', '\u2029'];

      test('property: the update-workflow word and definition walks agree with the patterns they replaced', () => {
        agrees('jq word', strings(['jq', 'j', 'q', '_', 'a', '1', ' ', '\n', '|', '-', '.'], 8), (s) => [update.hasWord(s, 'jq'), /\bjq\b/.test(s)]);
        agrees('uc_field definition', fc.oneof(strings(['uc_field()', 'uc_field', '()', '{', ' ', '\n', '\t', '\u00a0', '\u2028', 'x'], 8), chain(['uc_field()', '{'], blanks)),
          (s) => [update.definesUcField(s), /uc_field\(\)\s*\{/.test(s)]);
        agrees('status capture', fc.oneof(strings(['if LATEST_RESULT="$(node ', ')"; then', 'LATEST_STATUS=0', 'else', 'LATEST_STATUS=$?', 'fi', ' ', '\n', 'a'], 10),
          chain(['if LATEST_RESULT="$(node ', ')"; then', 'LATEST_STATUS=0', 'else', 'LATEST_STATUS=$?', 'fi'], ['  ', '\n', '\t', '\n  '])),
        (s) => [update.capturesLatestStatus(s), /if LATEST_RESULT="\$\(node [^\n]+\)"; then\s+LATEST_STATUS=0\s+else\s+LATEST_STATUS=\$\?\s+fi/.test(s)]);
      });

      test('property: the update-workflow path and install walks agree with the patterns they replaced', () => {
        agrees('bare claude paths', fc.oneof(strings(['~/.claude', '$HOME/.claude', '/', 'x', ' ', '~', '$HOME', '.claude', '\n'], 8), chain(['~/.claude', '/'], ['', ' ', 'x'])),
          (s) => [update.bareClaudePaths(s), s.match(/(?:~|\$HOME)\/\.claude(?!\/)/g) || []]);
        agrees('stale npx forms', fc.oneof(strings(['npx -y @opengsd/gsd-core@', 'latest', '1.0', ' ', '\n', '\r', '\t', 'x'], 8), chain(['npx -y @opengsd/gsd-core@', 'latest'], blanks)),
          (s) => [update.staleNpxForms(s), s.match(/npx -y @opengsd\/gsd-core@\S+[^\r\n]*/g) || []]);
        agrees('resolved installs', fc.oneof(strings(['npx -y --package=@opengsd/gsd-core@', ' -- gsd-core', 'latest', '@"$TAG"', ' ', '\n', '\t', 'x', '  --'], 8),
          chain(['npx -y --package=@opengsd/gsd-core@', 'latest', ' -- gsd-core'], ['', ' ', '\t'])),
        (s) => [update.robustInstalls(s), (s.match(/npx -y --package=@opengsd\/gsd-core@\S+ -- gsd-core/g) || []).length]);
        const tagged = 'npx -y --package=@opengsd/gsd-core@"$TAG" -- gsd-core';
        agrees('tagged installs', strings([tagged, 'npx -y --package=@opengsd/gsd-core@"$TAG" -- gsd-cor', ' ', 'x', '\n'], 6),
          (s) => [update.countOf(s, tagged), (s.match(/npx -y --package=@opengsd\/gsd-core@"\$TAG" -- gsd-core/g) || []).length]);
      });

      test('property: the update-workflow clause walks agree with the patterns they replaced', () => {
        agrees('slash dirs', fc.oneof(strings(['`/', '/`', '`', '/', 'a', 'b', ' '], 8), chain(['`/', 'dir', '/`'], ['', ' '])),
          (s) => [update.slashDirs(s), [...s.matchAll(/`\/([^`]+)\/`/g)].map((m) => m[1])]);
        agrees('ticked word', strings(['`', 'a', 'b', 'z', 'A', '1', ' ', '_'], 8), (s) => [update.tickedWord(s), s.match(/`([a-z]+)`/)?.[1]], (expected) => expected !== undefined);
        const oldPairs = (line) => {
          const pairs = new Set();
          for (const clause of line.split(';')) {
            const arrow = clause.indexOf('->');
            if (arrow === -1) continue;
            const dirs = [...clause.slice(0, arrow).matchAll(/`\/([^`]+)\/`/g)].map((m) => m[1]);
            const runtime = clause.slice(arrow + 2).match(/`([a-z]+)`/)?.[1];
            if (!runtime) return { error: true };
            for (const dir of dirs) pairs.add(`${runtime}:${dir}`);
          }
          return { pairs: [...pairs].sort() };
        };
        const lines = fc.oneof(strings(['`/a/`', '`/b/c/`', '->', '`x`', '`y`', ';', ' ', ', ', '`', 'a', '/'], 9), chain(['`/a/`', ' -> ', '`x`', '; '], ['', ' ']));
        agrees('doc pairs', lines, (s) => {
          const actual = update.docPairsOf(s);
          return [actual.error ? { error: true } : { pairs: [...actual.pairs].sort() }, oldPairs(s)];
        }, (expected) => !expected.error && expected.pairs.length > 0);
        const tables = fc.tuple(lines, fc.constantFrom('same', 'drop', 'extra'));
        agrees('parity', tables, ([line, mode]) => {
          const old = oldPairs(line);
          const base = old.error ? [] : old.pairs.map((pair) => pair.split(':'));
          const table = mode === 'drop' ? base.slice(1) : mode === 'extra' ? [...base, ['zed', 'zed']] : base;
          const tablePairs = table.map(([runtime, dir]) => `${runtime}:${dir}`).sort();
          const expected = !old.error && JSON.stringify(old.pairs) === JSON.stringify([...new Set(tablePairs)]);
          return [update.parityProblems(line, table) === true, expected];
        });
      });

      test('property: the single-line gap walks agree with the patterns they replaced', () => {
        const A = 'Otherwise, if VERSION file missing';
        const B = 'but the target above resolved';
        agrees('version-missing scope', fc.oneof(strings([A, B, ' ', '\n', '\r', '\u2028', '\u2029', 'x'], 6), chain([A, B], stops)),
          (s) => [precedesWithin(s, A, B, LINE_ENDS), /Otherwise, if VERSION file missing.*but the target above resolved/.test(s)]);
        agrees('argument-hint', fc.oneof(strings(['argument-hint:', '--next', ' ', '\n', '\r', '\u2028', '\u2029', 'x'], 6), chain(['argument-hint:', '--next'], stops)),
          (s) => [precedesWithin(s, 'argument-hint:', '--next', LINE_ENDS), /argument-hint:.*--next/.test(s)]);
        agrees('Branch 2 target', fc.oneof(strings(['Branch 2', 'step 5.65', ' ', '\n', '\r', 'x'], 6), chain(['Branch 2', 'step 5.65'], ['', ' ', 'x', '\n', '\r'])),
          (s) => [precedesWithin(s, 'Branch 2', 'step 5.65', new Set(['\n'])), /Branch 2[^\n]*step 5\.65/.test(s)]);
        agrees('blocking true', fc.oneof(strings(['blocking', 'BLOCKING', 'true', 'TRUE', 'Block', ' ', '\n', '\r', 'x'], 6), chain(['blocking', 'true'], stops)),
          (s) => [precedesWithin(asciiLower(s), 'blocking', 'true', LINE_ENDS), /blocking.*true/i.test(s)]);
        agrees('skips to step 6', fc.oneof(strings(['activeHooks', 'empty', 'absent', 'Branch 1', 'step 6', '.', ' ', '\n', 'x'], 6), chain(['activeHooks', 'step 6'], ['', ' ', 'x', '.', '\n'])),
          (s) => [planPhase.skipsToStepSix(s), /activeHooks[^.]*?step 6/s.test(s) || /empty[^.]*?step 6/s.test(s) || /absent[^.]*?step 6/s.test(s) || /Branch 1[^.]*?step 6/s.test(s)]);
      });

      test('property: the plan-phase guard and probe walks agree with the patterns they replaced', () => {
        agrees('non-fatal guard', fc.oneof(strings(['||', '|', 'true', 'tru', ' ', '\t', '\n', '\u00a0', 'x', '&&'], 7), chain(['||', 'true'], blanks)),
          (s) => [planPhase.hasNonFatalGuard(s), /\|\|\s*true/.test(s)]);
        agrees('hard exit', fc.oneof(strings(['Generate UI-SPEC first', 'Exit workflow', ' ', '\n', 'x'], 6), chain(['Generate UI-SPEC first', 'Exit workflow'], ['', ' ', '\n', 'x'])),
          (s) => [planPhase.hasHardExit(s), /Generate UI-SPEC first.*Exit workflow/s.test(s)]);
        const oldOffenders = (file, markdown) => {
          const lines = markdown.split(/\r?\n/);
          const offenders = [];
          const bashBlocks = sectionizer.scanFencedBlocks(lines).filter((b) => b.closeLineIdx !== -1 && (b.infoString || '').trim() === 'bash');
          for (const fenced of bashBlocks) {
            lines.slice(fenced.openLineIdx + 1, fenced.closeLineIdx).forEach((line, idx) => {
              if (!line.includes('.claude/skills/')) return;
              const kind = line.includes('sketch-findings-*/SKILL.md') ? 'sketch' : line.includes('spike-findings-*/SKILL.md') ? 'spike' : null;
              if (!kind) return;
              if (!/\|\|\s*true/.test(line)) offenders.push(`${file}:${fenced.openLineIdx + 1 + idx} ${line.trim()}`);
            });
          }
          return offenders;
        };
        const probeLines = ['```bash', '```', '```text', '~~~bash', '~~~', '````bash', 'S=$(ls ./.claude/skills/spike-findings-*/SKILL.md 2>/dev/null | head -1 || true)',
          'K=$(ls ./.claude/skills/sketch-findings-*/SKILL.md 2>/dev/null | head -1)', 'O=$(ls ./.claude/skills/other/SKILL.md)', 'x ||true spike-findings-*/SKILL.md .claude/skills/', '', 'text'];
        agrees('unguarded probes', fc.oneof(fc.array(fc.constantFrom(...probeLines), { maxLength: 9 }).map((parts) => parts.join('\n')),
          lineChain(['```bash', probeLines[7], '```'], probeLines)),
        (s) => [planPhase.unguardedProbes('f.md', s, sectionizer.scanFencedBlocks), oldOffenders('f.md', s)]);
      });

      test('property: the review prompt region agrees with the code it replaced', () => {
        // The old extraction, with the closing-run test written without building a pattern from the opener's length.
        const oldRegion = (src) => {
          const stepIdx = src.indexOf('<step name="build_prompt">');
          if (stepIdx === -1) return 'ERR';
          const lines = src.slice(stepIdx).split('\n');
          const openRe = /^ {0,3}(`{3,})markdown\s*$/;
          let openLen = 0;
          let bodyStart = -1;
          for (let i = 0; i < lines.length; i++) {
            const m = openRe.exec(lines[i].replace(/\r$/, ''));
            if (m) { openLen = m[1].length; bodyStart = i + 1; break; }
          }
          if (bodyStart === -1) return 'ERR';
          let bodyEnd = -1;
          for (let i = bodyStart; i < lines.length; i++) {
            const m = /^ {0,3}(`+)\s*$/.exec(lines[i].replace(/\r$/, ''));
            if (m && m[1].length >= openLen) { bodyEnd = i; break; }
          }
          if (bodyEnd === -1) return 'ERR';
          const fenced = lines.slice(bodyStart, bodyEnd).join('\n');
          const hdr = fenced.indexOf('## Review Instructions');
          if (hdr === -1) return 'ERR';
          const after = fenced.indexOf('\n## ', hdr + 1);
          return after === -1 ? fenced.slice(hdr) : fenced.slice(hdr, after);
        };
        const promptLines = ['<step name="build_prompt">', '```markdown', '````markdown', '~~~markdown', '```markdown ', '```markdown x', '   ```markdown', '    ```markdown', '```', '````', '~~~',
          '## Review Instructions', '## Other', 'text', '```bash', 'Verify against source', '', '```markdown\r', '```\r',
          '```markdown\t', '```markdown\u00a0', '```markdown\f', '```\t', '```\u00a0', '```\f'];
        agrees('prompt region', fc.oneof(fc.array(fc.constantFrom(...promptLines), { maxLength: 9 }).map((parts) => parts.join('\n')),
          lineChain(['<step name="build_prompt">', '```markdown', '## Review Instructions', 'Verify against source', '```'], promptLines)),
        (s) => {
          const actual = review.reviewInstructionsOf(s, sectionizer.matchFenceDelimiter);
          return [actual.error ? 'ERR' : actual.region, oldRegion(s)];
        }, (expected) => expected !== 'ERR');
      });

      // Each alternative of an OR check is enough on its own.
      const SECTION = ['## 5.6.', '\n## 6.'];
      const swapIn = (from, to) => within(SECTION[0], SECTION[1], (text) => text.split(from).join(to));
      passes('kind=="gate" without spaces is enough', PLAN_PHASE, swapIn('kind == "gate"', 'kind=="gate"'), 'plan-phase-ui-redirect');
      passes('"no active blocking gate" is enough without "no block"', PLAN_PHASE, swapIn('no block', 'nothing'), 'plan-phase-ui-redirect');
      passes('"no block" is enough without "no active blocking gate"', PLAN_PHASE, swapIn('no active blocking gate', 'no gate'), 'plan-phase-ui-redirect');
      passes('"normalizes dots" is enough for the dot normalization', PLAN_PHASE, within(SECTION[0], SECTION[1], (text) => `${text.split('ui.plan-gate').join('ui plan gate')}\nnormalizes dots`), 'plan-phase-ui-redirect');
      passes('"dots to hyphens" is enough for the dot normalization', PLAN_PHASE, within(SECTION[0], SECTION[1], (text) => `${text.split('ui.plan-gate').join('ui plan gate')}\ndots to hyphens`), 'plan-phase-ui-redirect');

      // The status capture needs one character between the head and its tail.
      test('the status capture needs a character between the head and the tail', () => {
        const head = 'if LATEST_RESULT="$(node ';
        const tail = ')"; then';
        const chainText = '\nLATEST_STATUS=0\nelse\nLATEST_STATUS=$?\nfi';
        assert.equal(update.capturesLatestStatus(head + tail + chainText), false);
        assert.equal(update.capturesLatestStatus(`${head}x${tail}${chainText}`), true);
      });

      // One cause is one finding: a missing inference line, and a file that ends with the step.
      test('the PREFERRED_RUNTIME inference line removed is exactly one finding', (t) => {
        const findings = runEdits(t, [[UPDATE, (text) => text.split('\n').filter((line) => !line.includes('Infer `PREFERRED_RUNTIME` from the path')).join('\n')]], 'update-workflow');
        assert.equal(findings.length, 1, messagesOf(findings));
        assert.match(findings[0].message, /the PREFERRED_RUNTIME inference line must exist/);
      });
      test('every later mutation missing after get_installed_version is one finding of the spy family', (t) => {
        const edit = (text) => {
          const end = text.indexOf('</step>', text.indexOf(INSTALLED_STEP));
          return text.slice(0, end) + SPIES_NEEDLES.reduce((tail, needle) => tail.split(needle).join(''), text.slice(end));
        };
        const findings = runEdits(t, [[UPDATE, edit]], 'update-workflow');
        assert.equal(findings.filter((f) => /the later update steps must follow the get_installed_version step/.test(f.message)).length, 1, messagesOf(findings));
        assert.equal(findings.filter((f) => /must remain after the exit/.test(f.message)).length, 0, messagesOf(findings));
      });

      // The Branch 1 heads, each alone, and a full stop between a head and the step.
      test('Branch 1 is satisfied by each head alone and not across a full stop', () => {
        for (const head of ['activeHooks', 'empty', 'absent', 'Branch 1']) {
          assert.equal(planPhase.skipsToStepSix(`${head} is the head, so skip to step 6`), true, head);
          assert.equal(planPhase.skipsToStepSix(`${head}. Skip to step 6`), false, head);
        }
        assert.equal(planPhase.skipsToStepSix('nothing here'), false);
      });
    }
  }

  // A file a batch 11 contract reads that is gone from the tree is one finding for that file.
  for (const [rel, contract] of [
    ['gsd-core/workflows/autonomous.md', 'autonomous-ui-steps'],
    ['gsd-core/references/autonomous-ui-design-contract.md', 'autonomous-ui-steps'],
    ['commands/gsd/discuss-phase.md', 'discuss-phase-power'],
    ['gsd-core/workflows/discuss-phase.md', 'discuss-phase-power'],
    ['gsd-core/workflows/discuss-phase-power.md', 'discuss-phase-power'],
    ['gsd-core/workflows/discuss-phase/modes/power.md', 'discuss-phase-power'],
    ['gsd-core/workflows/discuss-phase/modes/advisor.md', 'discuss-phase-power'],
    ['gsd-core/workflows/discuss-phase/modes/auto.md', 'discuss-phase-power'],
    ['gsd-core/references/gate-prompts.md', 'discuss-phase-power'],
    ['gsd-core/workflows/discuss-phase-assumptions.md', 'discuss-phase-power'],
    ['gsd-core/workflows/plan-phase.md', 'discuss-phase-power'],
    ['.github/workflows/close-draft-prs.yml', 'workflow-maintainer-skip'],
    ['.github/workflows/close-draft-prs-sweep.yml', 'workflow-maintainer-skip'],
    ['.github/workflows/pr-target-validator.yml', 'workflow-maintainer-skip'],
    ['.github/workflows/pr-title-validator.yml', 'workflow-maintainer-skip'],
    ['.github/workflows/require-issue-link.yml', 'workflow-maintainer-skip'],
    ['.github/workflows/auto-backmerge.yml', 'workflow-maintainer-skip'],
  ]) {
    test(`${rel} removed from the tree is a finding for ${contract}`, (t) => {
      const root = copyOfRepoFiles(t, HEAVY.includes(rel) ? HEAVY : []);
      fs.unlinkSync(path.join(root, ...rel.split('/')));
      const findings = runShipped(root, [contract]);
      assert.ok(findings.some((f) => f.file === rel && /cannot read the file/.test(f.message)), JSON.stringify(findings));
    });
  }
});
