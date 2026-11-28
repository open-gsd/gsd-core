'use strict';

/**
 * text-contracts.batch10.test.cjs
 *
 * Detection cases for the 28 text contracts of ADR-6315 item 19 batch 10 (#6577, #6337): each contract against a
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
const SHIPPED = require('./helpers/text-contracts-batch10-ids.cjs');

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

describe('the batch 10 contracts hold on the real files, and fail when a contracted phrase goes', () => {
  // The files each contract reads, copied into a temporary root so one phrase can be removed.
  const FILES = [
    '.github/workflows/auto-backmerge.yml',
    '.github/workflows/release.yml',
    '.gitignore',
    'CONTRIBUTING.md',
    'agents/gsd-advisor-researcher.compact.md',
    'agents/gsd-advisor-researcher.md',
    'agents/gsd-ai-researcher.compact.md',
    'agents/gsd-ai-researcher.md',
    'agents/gsd-assumptions-analyzer.compact.md',
    'agents/gsd-assumptions-analyzer.md',
    'agents/gsd-behavior-verifier.md',
    'agents/gsd-code-fixer.compact.md',
    'agents/gsd-code-fixer.md',
    'agents/gsd-code-reviewer.compact.md',
    'agents/gsd-code-reviewer.md',
    'agents/gsd-codebase-mapper.compact.md',
    'agents/gsd-codebase-mapper.md',
    'agents/gsd-debug-session-manager.compact.md',
    'agents/gsd-debug-session-manager.md',
    'agents/gsd-debugger.md',
    'agents/gsd-doc-classifier.compact.md',
    'agents/gsd-doc-classifier.md',
    'agents/gsd-doc-synthesizer.compact.md',
    'agents/gsd-doc-synthesizer.md',
    'agents/gsd-doc-verifier.compact.md',
    'agents/gsd-doc-verifier.md',
    'agents/gsd-doc-writer.compact.md',
    'agents/gsd-doc-writer.md',
    'agents/gsd-dom-verifier.compact.md',
    'agents/gsd-dom-verifier.md',
    'agents/gsd-domain-researcher.compact.md',
    'agents/gsd-domain-researcher.md',
    'agents/gsd-eval-auditor.compact.md',
    'agents/gsd-eval-auditor.md',
    'agents/gsd-eval-planner.compact.md',
    'agents/gsd-eval-planner.md',
    'agents/gsd-executor.md',
    'agents/gsd-framework-selector.compact.md',
    'agents/gsd-framework-selector.md',
    'agents/gsd-integration-checker.compact.md',
    'agents/gsd-integration-checker.md',
    'agents/gsd-intel-updater.compact.md',
    'agents/gsd-intel-updater.md',
    'agents/gsd-mempalace-curator.compact.md',
    'agents/gsd-mempalace-curator.md',
    'agents/gsd-nyquist-auditor.compact.md',
    'agents/gsd-nyquist-auditor.md',
    'agents/gsd-pattern-mapper.compact.md',
    'agents/gsd-pattern-mapper.md',
    'agents/gsd-phase-researcher.md',
    'agents/gsd-plan-checker.md',
    'agents/gsd-planner.md',
    'agents/gsd-project-researcher.compact.md',
    'agents/gsd-project-researcher.md',
    'agents/gsd-research-synthesizer.compact.md',
    'agents/gsd-research-synthesizer.md',
    'agents/gsd-roadmapper.compact.md',
    'agents/gsd-roadmapper.md',
    'agents/gsd-security-auditor.compact.md',
    'agents/gsd-security-auditor.md',
    'agents/gsd-ui-auditor.compact.md',
    'agents/gsd-ui-auditor.md',
    'agents/gsd-ui-checker.compact.md',
    'agents/gsd-ui-checker.md',
    'agents/gsd-ui-researcher.compact.md',
    'agents/gsd-ui-researcher.md',
    'agents/gsd-user-profiler.compact.md',
    'agents/gsd-user-profiler.md',
    'agents/gsd-verifier.md',
    'capabilities/live-dom-uat/fragments/execute-wave-post.md',
    'capabilities/mempalace/fragments/capture-problems.md',
    'commands/gsd/add-tests.md',
    'commands/gsd/debug.md',
    'commands/gsd/mempalace-capture.md',
    'commands/gsd/mempalace-recall.md',
    'commands/gsd/progress.md',
    'commands/gsd/review.md',
    'commands/gsd/ultraplan-phase.md',
    'docs/COMMANDS.md',
    'docs/FEATURES.md',
    'docs/contributor-standards.md',
    'docs/ja-JP/COMMANDS.md',
    'docs/ja-JP/FEATURES.md',
    'docs/ko-KR/COMMANDS.md',
    'docs/ko-KR/FEATURES.md',
    'docs/reference/agents.md',
    'gsd-core/references/agent-skills-bootstrap.md',
    'gsd-core/references/artifact-types.md',
    'gsd-core/references/common-bug-patterns.md',
    'gsd-core/references/continuation-format.md',
    'gsd-core/references/gsd-run-resolver.md',
    'gsd-core/references/planner-gap-closure.md',
    'gsd-core/references/planner-guidance.md',
    'gsd-core/references/planner-reviews.md',
    'gsd-core/references/planner-revision.md',
    'gsd-core/references/thinking-models-debug.md',
    'gsd-core/references/thinking-models-execution.md',
    'gsd-core/references/thinking-models-planning.md',
    'gsd-core/references/thinking-models-research.md',
    'gsd-core/references/thinking-models-verification.md',
    'gsd-core/references/ui-brand.md',
    'gsd-core/references/verification-overrides.md',
    'gsd-core/references/verifier-phase-gates.md',
    'gsd-core/templates/DEBUG.md',
    'gsd-core/templates/verification-report.md',
    'gsd-core/workflows/ai-integration-phase.md',
    'gsd-core/workflows/audit-fix.md',
    'gsd-core/workflows/autonomous.md',
    'gsd-core/workflows/cleanup.md',
    'gsd-core/workflows/code-review.md',
    'gsd-core/workflows/code-review/steps/dispatch-fix.md',
    'gsd-core/workflows/debug.md',
    'gsd-core/workflows/eval-review.md',
    'gsd-core/workflows/execute-phase.md',
    'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md',
    'gsd-core/workflows/execute-phase/steps/post-merge-gate.md',
    'gsd-core/workflows/execute-phase/steps/regression-gate-run.md',
    'gsd-core/workflows/execute-phase/steps/regression-gate.md',
    'gsd-core/workflows/execute-phase/steps/tdd-applicability-resolution.md',
    'gsd-core/workflows/execute-phase/steps/verify-phase-goal.md',
    'gsd-core/workflows/execute-phase/steps/worktree-recovery-policy.md',
    'gsd-core/workflows/help/modes/full.md',
    'gsd-core/workflows/new-milestone.md',
    'gsd-core/workflows/next.md',
    'gsd-core/workflows/plan-phase.md',
    'gsd-core/workflows/plant-seed.md',
    'gsd-core/workflows/quick.md',
    'gsd-core/workflows/quick/steps/worktree-pre-dispatch-commit.md',
    'gsd-core/workflows/resume-project.md',
    'gsd-core/workflows/review.md',
    'gsd-core/workflows/settings.md',
    'gsd-core/workflows/ship.md',
    'gsd-core/workflows/sketch.md',
    'gsd-core/workflows/spec-phase.md',
    'gsd-core/workflows/spike-wrap-up.md',
    'gsd-core/workflows/spike.md',
    'gsd-core/workflows/ui-phase.md',
    'gsd-core/workflows/ui-review.md',
    'gsd-core/workflows/ultraplan-phase.md',
    'gsd-core/workflows/update.md',
    'gsd-core/workflows/verify-work.md',
    'gsd-core/workflows/verify-work/steps/automated-ui-verification.md',
    'gsd-core/workflows/verify-work/steps/mvp-uat-framing.md',
    'skills/gsd-mempalace-capture/SKILL.md',
    'skills/gsd-mempalace-recall/SKILL.md',
  ];

  // Files the contracts read that are too large to copy into every case; a case that needs one passes HEAVY.
  const HEAVY = [
    'CONTEXT.md',
    'capabilities/ai-integration/fragments/api-coverage-plan-pre.md',
    'capabilities/assumption-delta/fragments/plan-pre.md',
    'capabilities/claude-orchestration/docs/workflow-backend-dispatch.md',
    'capabilities/claude-orchestration/fragments/plan-post.md',
    'capabilities/deep-verify/fragments/verify-pre.md',
    'capabilities/external-job/fragments/execute-wave-post.md',
    'capabilities/external-job/fragments/plan-post.md',
    'capabilities/mempalace/fragments/recall-discuss.md',
    'capabilities/pattern-mapper/fragments/plan-pre.md',
    'capabilities/research/fragments/plan-pre.md',
    'capabilities/schema-gate/fragments/plan-pre.md',
    'commands/gsd/ai-integration-phase.md',
    'commands/gsd/audit-fix.md',
    'commands/gsd/audit-milestone.md',
    'commands/gsd/audit-uat.md',
    'commands/gsd/autonomous.md',
    'commands/gsd/capture.md',
    'commands/gsd/cleanup.md',
    'commands/gsd/code-review.md',
    'commands/gsd/complete-milestone.md',
    'commands/gsd/config.md',
    'commands/gsd/discuss-phase.md',
    'commands/gsd/docs-update.md',
    'commands/gsd/eval-review.md',
    'commands/gsd/execute-phase.md',
    'commands/gsd/explore.md',
    'commands/gsd/extract-learnings.md',
    'commands/gsd/fast.md',
    'commands/gsd/forensics.md',
    'commands/gsd/graphify.md',
    'commands/gsd/health.md',
    'commands/gsd/help.md',
    'commands/gsd/import.md',
    'commands/gsd/inbox.md',
    'commands/gsd/ingest-docs.md',
    'commands/gsd/manager.md',
    'commands/gsd/map-codebase.md',
    'commands/gsd/milestone-summary.md',
    'commands/gsd/mvp-phase.md',
    'commands/gsd/new-milestone.md',
    'commands/gsd/new-project.md',
    'commands/gsd/next.md',
    'commands/gsd/ns-context.md',
    'commands/gsd/ns-ideate.md',
    'commands/gsd/ns-manage.md',
    'commands/gsd/ns-project.md',
    'commands/gsd/ns-review.md',
    'commands/gsd/ns-workflow.md',
    'commands/gsd/onboard.md',
    'commands/gsd/pause-work.md',
    'commands/gsd/phase.md',
    'commands/gsd/plan-phase.md',
    'commands/gsd/plan-review-convergence.md',
    'commands/gsd/pr-branch.md',
    'commands/gsd/profile-user.md',
    'commands/gsd/quick-batch.md',
    'commands/gsd/quick.md',
    'commands/gsd/resume-work.md',
    'commands/gsd/review-backlog.md',
    'commands/gsd/secure-phase.md',
    'commands/gsd/settings.md',
    'commands/gsd/ship.md',
    'commands/gsd/sketch.md',
    'commands/gsd/spec-phase.md',
    'commands/gsd/spike.md',
    'commands/gsd/stats.md',
    'commands/gsd/surface.md',
    'commands/gsd/thread.md',
    'commands/gsd/ui-phase.md',
    'commands/gsd/ui-review.md',
    'commands/gsd/undo.md',
    'commands/gsd/update.md',
    'commands/gsd/validate-phase.md',
    'commands/gsd/verify-work.md',
    'commands/gsd/workspace.md',
    'commands/gsd/workstreams.md',
    'gsd-core/references/agent-contracts.md',
    'gsd-core/references/ai-evals.md',
    'gsd-core/references/ai-frameworks.md',
    'gsd-core/references/api-coverage.md',
    'gsd-core/references/autonomous-smart-discuss.md',
    'gsd-core/references/autonomous-ui-design-contract.md',
    'gsd-core/references/checkpoints.md',
    'gsd-core/references/cicd-review-patterns.md',
    'gsd-core/references/compact-content-gate.md',
    'gsd-core/references/context-budget.md',
    'gsd-core/references/debugger-bug-taxonomy.md',
    'gsd-core/references/debugger-fix-acceptance.md',
    'gsd-core/references/debugger-philosophy.md',
    'gsd-core/references/debugger-prevention.md',
    'gsd-core/references/debugger-rca-branching.md',
    'gsd-core/references/debugger-repro-hardening.md',
    'gsd-core/references/debugger-sbfl.md',
    'gsd-core/references/debugger-semantic-recall.md',
    'gsd-core/references/debugger-techniques.md',
    'gsd-core/references/decimal-phase-calculation.md',
    'gsd-core/references/dispatch-isolation-gate.md',
    'gsd-core/references/doc-conflict-engine.md',
    'gsd-core/references/domain-probes.md',
    'gsd-core/references/edge-probe.md',
    'gsd-core/references/execute-mvp-tdd.md',
    'gsd-core/references/execute-phase-between-wave-reset.md',
    'gsd-core/references/execute-phase-context-guard.md',
    'gsd-core/references/execute-phase-quota-recovery.md',
    'gsd-core/references/execute-phase-requirement-revert.md',
    'gsd-core/references/execute-phase-response-language.md',
    'gsd-core/references/execute-phase-wave-guard.md',
    'gsd-core/references/executor-examples.md',
    'gsd-core/references/failing-direction.md',
    'gsd-core/references/few-shot-examples/plan-checker.md',
    'gsd-core/references/few-shot-examples/verifier.md',
    'gsd-core/references/gate-prompts.md',
    'gsd-core/references/gates.md',
    'gsd-core/references/git-integration.md',
    'gsd-core/references/git-planning-commit.md',
    'gsd-core/references/honest-verifier.md',
    'gsd-core/references/ios-scaffold.md',
    'gsd-core/references/loop-hook-dispatch.md',
    'gsd-core/references/mandatory-initial-read.md',
    'gsd-core/references/model-profile-resolution.md',
    'gsd-core/references/model-profiles.md',
    'gsd-core/references/mvp-concepts.md',
    'gsd-core/references/necessity-review.md',
    'gsd-core/references/nyquist-compliance.md',
    'gsd-core/references/offer-next.md',
    'gsd-core/references/phase-argument-parsing.md',
    'gsd-core/references/phase-id-convention.md',
    'gsd-core/references/plan-checker-examples.md',
    'gsd-core/references/planner-antipatterns.md',
    'gsd-core/references/planner-chunked.md',
    'gsd-core/references/planner-coupling.md',
    'gsd-core/references/planner-failing-direction.md',
    'gsd-core/references/planner-graphify-auto-update.md',
    'gsd-core/references/planner-human-verify-mode.md',
    'gsd-core/references/planner-interface-context.md',
    'gsd-core/references/planner-load-graph-context.md',
    'gsd-core/references/planner-mvp-mode.md',
    'gsd-core/references/planner-preconditions.md',
    'gsd-core/references/planner-quick-batch.md',
    'gsd-core/references/planner-reversibility.md',
    'gsd-core/references/planner-source-audit.md',
    'gsd-core/references/planner-verify-command-grounding.md',
    'gsd-core/references/planner-verify-command-validation.md',
    'gsd-core/references/planning-config.md',
    'gsd-core/references/prohibition-probe.md',
    'gsd-core/references/project-skills-discovery.md',
    'gsd-core/references/questioning.md',
    'gsd-core/references/research-documentation-lookup.md',
    'gsd-core/references/research-philosophy.md',
    'gsd-core/references/research-verification-protocol.md',
    'gsd-core/references/response-language-directive.md',
    'gsd-core/references/reviewer-instances.md',
    'gsd-core/references/revision-loop.md',
    'gsd-core/references/runtime-aware-dispatch.md',
    'gsd-core/references/scout-codebase.md',
    'gsd-core/references/security-asvs-levels.md',
    'gsd-core/references/skeleton-template.md',
    'gsd-core/references/sketch-interactivity.md',
    'gsd-core/references/sketch-theme-system.md',
    'gsd-core/references/sketch-tooling.md',
    'gsd-core/references/sketch-variant-patterns.md',
    'gsd-core/references/specless-probe-fallback.md',
    'gsd-core/references/spidr-splitting.md',
    'gsd-core/references/tdd.md',
    'gsd-core/references/thinking-partner.md',
    'gsd-core/references/ui-consideration-probe.md',
    'gsd-core/references/universal-anti-patterns.md',
    'gsd-core/references/untrusted-input-boundary.md',
    'gsd-core/references/user-profiling.md',
    'gsd-core/references/user-story-template.md',
    'gsd-core/references/verification-patterns.md',
    'gsd-core/references/verifier-evidence-gate.md',
    'gsd-core/references/verifier-wiring-patterns.md',
    'gsd-core/references/verify-command-path-resolvability.md',
    'gsd-core/references/verify-mvp-mode.md',
    'gsd-core/references/workstream-flag.md',
    'gsd-core/references/worktree-branch-check.md',
    'gsd-core/references/worktree-path-safety.md',
    'gsd-core/templates/AI-SPEC.md',
    'gsd-core/templates/README.md',
    'gsd-core/templates/SECURITY.md',
    'gsd-core/templates/UAT.md',
    'gsd-core/templates/UI-SPEC.md',
    'gsd-core/templates/VALIDATION.md',
    'gsd-core/templates/codebase/architecture.md',
    'gsd-core/templates/codebase/stack.md',
    'gsd-core/templates/context.md',
    'gsd-core/templates/continue-here.md',
    'gsd-core/templates/copilot-instructions.md',
    'gsd-core/templates/dev-preferences.md',
    'gsd-core/templates/discussion-log.md',
    'gsd-core/templates/milestone-archive.md',
    'gsd-core/templates/milestone.md',
    'gsd-core/templates/phase-prompt.md',
    'gsd-core/templates/planner-subagent-prompt.md',
    'gsd-core/templates/project.md',
    'gsd-core/templates/requirements.md',
    'gsd-core/templates/research-project/ARCHITECTURE.md',
    'gsd-core/templates/research-project/FEATURES.md',
    'gsd-core/templates/research-project/PITFALLS.md',
    'gsd-core/templates/research-project/STACK.md',
    'gsd-core/templates/research-project/SUMMARY.md',
    'gsd-core/templates/research.md',
    'gsd-core/templates/retrospective.md',
    'gsd-core/templates/roadmap.md',
    'gsd-core/templates/spec.md',
    'gsd-core/templates/state.md',
    'gsd-core/templates/summary-complex.md',
    'gsd-core/templates/summary-minimal.md',
    'gsd-core/templates/summary-standard.md',
    'gsd-core/templates/summary.compact.md',
    'gsd-core/templates/summary.md',
    'gsd-core/templates/user-profile.md',
    'gsd-core/templates/user-setup.compact.md',
    'gsd-core/templates/user-setup.md',
    'gsd-core/workflows/add-backlog.md',
    'gsd-core/workflows/add-phase.md',
    'gsd-core/workflows/add-tests.md',
    'gsd-core/workflows/add-todo.md',
    'gsd-core/workflows/analyze-dependencies.md',
    'gsd-core/workflows/audit-milestone.md',
    'gsd-core/workflows/audit-uat.md',
    'gsd-core/workflows/autonomous/steps/converge-banner.md',
    'gsd-core/workflows/autonomous/steps/converge-dispatch-bg.md',
    'gsd-core/workflows/autonomous/steps/converge-dispatch-inline.md',
    'gsd-core/workflows/autonomous/steps/converge-fail-fast.md',
    'gsd-core/workflows/autonomous/steps/converge-loop.md',
    'gsd-core/workflows/autonomous/templates/minimal-context.md',
    'gsd-core/workflows/check-todos.md',
    'gsd-core/workflows/code-review-fix.md',
    'gsd-core/workflows/code-review/steps/structural-pre-pass.md',
    'gsd-core/workflows/complete-milestone.md',
    'gsd-core/workflows/complete-milestone/detail/elaboration.md',
    'gsd-core/workflows/complete-milestone/steps/git-tag.md',
    'gsd-core/workflows/complete-milestone/steps/project-md-evolution-review.md',
    'gsd-core/workflows/complete-milestone/steps/release-map.md',
    'gsd-core/workflows/diagnose-issues.md',
    'gsd-core/workflows/discuss-phase-assumptions.md',
    'gsd-core/workflows/discuss-phase-assumptions/steps/auto-advance-dispatch.md',
    'gsd-core/workflows/discuss-phase-power.md',
    'gsd-core/workflows/discuss-phase.md',
    'gsd-core/workflows/discuss-phase/modes/advisor.md',
    'gsd-core/workflows/discuss-phase/modes/all.md',
    'gsd-core/workflows/discuss-phase/modes/analyze.md',
    'gsd-core/workflows/discuss-phase/modes/auto.md',
    'gsd-core/workflows/discuss-phase/modes/batch.md',
    'gsd-core/workflows/discuss-phase/modes/chain.md',
    'gsd-core/workflows/discuss-phase/modes/default.md',
    'gsd-core/workflows/discuss-phase/modes/power.md',
    'gsd-core/workflows/discuss-phase/modes/text.md',
    'gsd-core/workflows/discuss-phase/templates/context.md',
    'gsd-core/workflows/discuss-phase/templates/discussion-log.md',
    'gsd-core/workflows/do.md',
    'gsd-core/workflows/docs-update.md',
    'gsd-core/workflows/docs-update/detail/elaboration.md',
    'gsd-core/workflows/docs-update/steps/dispatch-monorepo-packages.md',
    'gsd-core/workflows/edit-phase.md',
    'gsd-core/workflows/execute-phase/detail/elaboration.md',
    'gsd-core/workflows/execute-phase/steps/code-review-disposition.md',
    'gsd-core/workflows/execute-phase/steps/codebase-drift-gate.md',
    'gsd-core/workflows/execute-phase/steps/completion-reconciliation.md',
    'gsd-core/workflows/execute-phase/steps/cross-runtime-executor-dispatch.md',
    'gsd-core/workflows/execute-phase/steps/executor-progress-policy.md',
    'gsd-core/workflows/execute-phase/steps/gap-closure-artifacts.md',
    'gsd-core/workflows/execute-phase/steps/partial-wave.md',
    'gsd-core/workflows/execute-phase/steps/per-plan-executor-routing.md',
    'gsd-core/workflows/execute-phase/steps/per-plan-worktree-gate.md',
    'gsd-core/workflows/execute-phase/steps/post-wave-requirements.md',
    'gsd-core/workflows/execute-phase/steps/pre-execute-gate-hooks.md',
    'gsd-core/workflows/execute-phase/steps/protected-branch.md',
    'gsd-core/workflows/execute-phase/steps/ready-wave-gate.md',
    'gsd-core/workflows/execute-phase/steps/sequential-root-pin.md',
    'gsd-core/workflows/execute-phase/steps/threat-id-gate.md',
    'gsd-core/workflows/execute-phase/steps/wave-post-gate-hooks.md',
    'gsd-core/workflows/execute-phase/steps/worktree-base-check.md',
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
    'gsd-core/workflows/new-milestone/steps/project-md-milestone-write.md',
    'gsd-core/workflows/new-milestone/steps/reset-phase-safety.md',
    'gsd-core/workflows/new-project.md',
    'gsd-core/workflows/new-project/detail/elaboration.md',
    'gsd-core/workflows/new-project/steps/auto-mode-config.md',
    'gsd-core/workflows/new-project/steps/auto-mode-detection.md',
    'gsd-core/workflows/new-project/steps/codebase-map-offer.md',
    'gsd-core/workflows/new-workspace.md',
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
    'gsd-core/workflows/quick/steps/discussion-phase.md',
    'gsd-core/workflows/quick/steps/plan-checker-loop.md',
    'gsd-core/workflows/quick/steps/quick-verification.md',
    'gsd-core/workflows/quick/steps/research-phase.md',
    'gsd-core/workflows/reapply-patches.md',
    'gsd-core/workflows/remove-phase.md',
    'gsd-core/workflows/remove-workspace.md',
    'gsd-core/workflows/review/steps/reviewer-instances-note-1.md',
    'gsd-core/workflows/review/steps/reviewer-instances-note-2.md',
    'gsd-core/workflows/scan.md',
    'gsd-core/workflows/secure-phase.md',
    'gsd-core/workflows/session-report.md',
    'gsd-core/workflows/settings-advanced.md',
    'gsd-core/workflows/settings-integrations.md',
    'gsd-core/workflows/sketch-wrap-up.md',
    'gsd-core/workflows/smart-entry.md',
    'gsd-core/workflows/stats.md',
    'gsd-core/workflows/sync-skills.md',
    'gsd-core/workflows/thread.md',
    'gsd-core/workflows/transition.md',
    'gsd-core/workflows/transition/steps/workstream-collision-check.md',
    'gsd-core/workflows/undo.md',
    'gsd-core/workflows/update/steps/channel-banner.md',
    'gsd-core/workflows/validate-phase.md',
    'gsd-core/workflows/verify-work/detail/elaboration.md',
  ];

  function copyOfRepoFiles(t, extra = []) {
    const root = tempDir(t, 'gsd-text-contracts-b10-');
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

  // The bounds of a pattern: limit - 1 and limit are matched, limit + 1 is the stated edge.
  const gapCases = (label, rel, contract, build, limit, whyMatch) => {
    for (const [gap, ok] of [[limit - 1, true], [limit, true], [limit + 1, false]]) {
      test(`${label} with a gap of ${gap} characters ${ok ? 'satisfies' : 'is past the bound of'} ${contract}`, (t) => {
        const root = copyOfRepoFiles(t);
        const abs = path.join(root, ...rel.split('/'));
        const text = fs.readFileSync(abs, 'utf8');
        const after = build(text, gap);
        assert.notEqual(after, text);
        fs.writeFileSync(abs, after);
        const findings = runShipped(root, [contract]);
        if (ok) assert.deepEqual(findings, []);
        else assert.ok(findings.some((f) => whyMatch.test(f.message)), JSON.stringify(findings));
      });
    }
  };

  test('an untouched copy of the files satisfies every batch 10 contract', (t) => {
    assert.deepEqual(runShipped(copyOfRepoFiles(t, HEAVY)), []);
  });

  for (const [title, rel, edit, contract, expected] of [
        // next-safety-gates
        ['the safety_gates step tag removed', 'gsd-core/workflows/next.md', eraseAll('<step name="safety_gates">'), 'next-safety-gates', /workflow should have a safety_gates step/],
        ['the determine_next_action step moved before safety_gates', 'gsd-core/workflows/next.md', (text) => `name="determine_next_action"\n${text}`, 'next-safety-gates', /safety_gates must appear before the determine_next_action step/],
        ['the safety_gates name moved before detect_state', 'gsd-core/workflows/next.md', (text) => `name="safety_gates"\n${text}`, 'next-safety-gates', /safety_gates must appear after the detect_state step/],
        ['the detect_state step renamed', 'gsd-core/workflows/next.md', swap('name="detect_state"', 'name="detect"'), 'next-safety-gates', /safety_gates must appear after the detect_state step/],
        ['.continue-here.md removed', 'gsd-core/workflows/next.md', eraseAll('.continue-here.md'), 'next-safety-gates', /Gate 1 should check for \.planning\/\.continue-here\.md/],
        ['Unresolved checkpoint removed', 'gsd-core/workflows/next.md', eraseAll('Unresolved checkpoint'), 'next-safety-gates', /Gate 1 should display "Unresolved checkpoint" message/],
        ['status: error removed', 'gsd-core/workflows/next.md', (text) => ['status: error', 'status: failed'].reduce((acc, phrase) => acc.split(phrase).join(''), text), 'next-safety-gates', /Gate 2 should check for error\/failed status in STATE\.md/],
        ['Project in error state removed', 'gsd-core/workflows/next.md', eraseAll('Project in error state'), 'next-safety-gates', /Gate 2 should display "Project in error state" message/],
        ['VERIFICATION.md removed', 'gsd-core/workflows/next.md', eraseAll('VERIFICATION.md'), 'next-safety-gates', /Gate 3 should check VERIFICATION\.md/],
        ['FAIL removed', 'gsd-core/workflows/next.md', eraseAll('FAIL'), 'next-safety-gates', /Gate 3 should look for FAIL items/],
        ['Unchecked verification failures removed', 'gsd-core/workflows/next.md', eraseAll('Unchecked verification failures'), 'next-safety-gates', /Gate 3 should display "Unchecked verification failures" message/],
        ['Prior-phase completeness scan removed', 'gsd-core/workflows/next.md', eraseAll('Prior-phase completeness scan'), 'next-safety-gates', /workflow should have a prior-phase completeness scan section/],
        ['.next-call-count added', 'gsd-core/workflows/next.md', append('.next-call-count'), 'next-safety-gates', /workflow must not reference the old \.next-call-count counter file/],
        ['run consecutively added', 'gsd-core/workflows/next.md', append('run consecutively'), 'next-safety-gates', /workflow must not reference consecutive call counting/],
        ['Plans without summaries removed', 'gsd-core/workflows/next.md', (text) => ['Plans without summaries', 'no SUMMARY.md'].reduce((acc, phrase) => acc.split(phrase).join(''), text), 'next-safety-gates', /completeness scan should detect plans that ran without producing summaries/],
        ['Verification failures not overridden removed', 'gsd-core/workflows/next.md', (text) => ['Verification failures not overridden', 'VERIFICATION.md with `FAIL`'].reduce((acc, phrase) => acc.split(phrase).join(''), text), 'next-safety-gates', /completeness scan should detect unoverridden FAIL items in prior phase VERIFICATION\.md/],
        ['CONTEXT.md without plans removed', 'gsd-core/workflows/next.md', (text) => ['CONTEXT.md without plans', 'CONTEXT.md but no PLAN.md'].reduce((acc, phrase) => acc.split(phrase).join(''), text), 'next-safety-gates', /completeness scan should detect phases with discussion but no planning/],
        ['[C] removed', 'gsd-core/workflows/next.md', eraseAll('[C]'), 'next-safety-gates', /completeness scan should offer \[C\] Continue option/],
        ['[S] removed', 'gsd-core/workflows/next.md', eraseAll('[S]'), 'next-safety-gates', /completeness scan should offer \[S\] Stop option/],
        ['[F] removed', 'gsd-core/workflows/next.md', eraseAll('[F]'), 'next-safety-gates', /completeness scan should offer \[F\] Force option/],
        ['999. removed', 'gsd-core/workflows/next.md', eraseAll('999.'), 'next-safety-gates', /deferral should use the 999\.x backlog numbering scheme/],
        ['Backlog removed', 'gsd-core/workflows/next.md', (text) => ['Backlog', 'BACKLOG'].reduce((acc, phrase) => acc.split(phrase).join(''), text), 'next-safety-gates', /deferral should write to the Backlog section of ROADMAP\.md/],
        ['silently removed', 'gsd-core/workflows/next.md', (text) => ['silently', 'no interruption'].reduce((acc, phrase) => acc.split(phrase).join(''), text), 'next-safety-gates', /workflow should route without interruption when prior phases are clean/],
        ['--force removed', 'gsd-core/workflows/next.md', eraseAll('--force'), 'next-safety-gates', /workflow should document --force flag/],
        ['skipping safety gates removed', 'gsd-core/workflows/next.md', eraseAll('skipping safety gates'), 'next-safety-gates', /workflow should print warning when --force is used/],
        ['Exit on first hit removed', 'gsd-core/workflows/next.md', eraseAll('Exit on first hit'), 'next-safety-gates', /safety gates should exit on first hit/],
        ['--next removed', 'commands/gsd/progress.md', eraseAll('--next'), 'next-safety-gates', /progress\.md must document the --next flag \(absorbed from the standalone next command in #2790\)/],
        ['--force removed', 'commands/gsd/progress.md', eraseAll('--force'), 'next-safety-gates', /progress\.md must document the --force escape hatch for --next/],
        ['the completeness routing removed from progress.md', 'commands/gsd/progress.md', (text) => text.replace(/completeness|next workflow|scans? all prior phases/gi, 'x'), 'next-safety-gates', /progress\.md must document the completeness scan \/ next-workflow routing for --next/],
        // release-backmerge-invariants
        ['auto-backmerge.yml that is not valid YAML', '.github/workflows/auto-backmerge.yml', () => 'a: [\n', 'release-backmerge-invariants', /auto-backmerge\.yml is not valid YAML/],
        ['auto-backmerge.yml that is a sequence', '.github/workflows/auto-backmerge.yml', () => '- a\n- b\n', 'release-backmerge-invariants', /auto-backmerge\.yml must be a workflow with a jobs mapping/],
        ['auto-backmerge.yml with no jobs mapping', '.github/workflows/auto-backmerge.yml', () => 'name: x\n', 'release-backmerge-invariants', /auto-backmerge\.yml must be a workflow with a jobs mapping/],
        ['release.yml that is not valid YAML', '.github/workflows/release.yml', () => 'a: [\n', 'release-backmerge-invariants', /release\.yml is not valid YAML/],
        ['release.yml that is a sequence', '.github/workflows/release.yml', () => '- a\n- b\n', 'release-backmerge-invariants', /release\.yml must be a workflow with a jobs mapping/],
        ['release.yml with no jobs mapping', '.github/workflows/release.yml', () => 'name: x\n', 'release-backmerge-invariants', /release\.yml must be a workflow with a jobs mapping/],
        ['the backmerge steps replaced by a string', '.github/workflows/auto-backmerge.yml', yamlEdit((w) => { w.jobs.backmerge.steps = 'x'; }), 'release-backmerge-invariants', /jobs\.backmerge\.steps must be an array/],
        ['the backmerge job removed', '.github/workflows/auto-backmerge.yml', yamlEdit((w) => { delete w.jobs.backmerge; }), 'release-backmerge-invariants', /jobs\.backmerge\.steps must be an array/],
        ['the version-sync step removed', '.github/workflows/auto-backmerge.yml', yamlEdit((w) => { const steps = w.jobs.backmerge.steps; steps.splice(steps.findIndex((s) => typeof s.name === 'string' && s.name.includes('Sync next\'s version')), 1); }), 'release-backmerge-invariants', /expected a step named like "Sync next's version"/],
        ['the version-sync step no longer continue-on-error', '.github/workflows/auto-backmerge.yml', yamlEdit((w) => { const steps = w.jobs.backmerge.steps; steps.find((s) => typeof s.name === 'string' && s.name.includes('Sync next\'s version'))['continue-on-error'] = false; }), 'release-backmerge-invariants', /version-sync must be continue-on-error so a sync failure never blocks the back-merge PR/],
        ['the version-sync continue-on-error removed', '.github/workflows/auto-backmerge.yml', yamlEdit((w) => { const steps = w.jobs.backmerge.steps; delete steps.find((s) => typeof s.name === 'string' && s.name.includes('Sync next\'s version'))['continue-on-error']; }), 'release-backmerge-invariants', /version-sync must be continue-on-error so a sync failure never blocks the back-merge PR/],
        ['the build:lib step removed', '.github/workflows/auto-backmerge.yml', yamlEdit((w) => { const steps = w.jobs.backmerge.steps; steps.splice(steps.findIndex((s) => typeof s.run === 'string' && s.run.includes('npm run build:lib')), 1); }), 'release-backmerge-invariants', /expected a step running `npm run build:lib` before the version sync/],
        ['the build:lib step no longer continue-on-error', '.github/workflows/auto-backmerge.yml', yamlEdit((w) => { const steps = w.jobs.backmerge.steps; steps.find((s) => typeof s.run === 'string' && s.run.includes('npm run build:lib'))['continue-on-error'] = false; }), 'release-backmerge-invariants', /the build:lib step is only a prerequisite of the best-effort version-sync/],
        ['the build:lib step moved after the version-sync', '.github/workflows/auto-backmerge.yml', yamlEdit((w) => { const steps = w.jobs.backmerge.steps; const at = steps.findIndex((s) => typeof s.run === 'string' && s.run.includes('npm run build:lib')); steps.push(...steps.splice(at, 1)); }), 'release-backmerge-invariants', /the build:lib step must precede the version-sync step/],
        ['the Open or update PR step removed', '.github/workflows/auto-backmerge.yml', yamlEdit((w) => { const steps = w.jobs.backmerge.steps; steps.splice(steps.findIndex((s) => typeof s.name === 'string' && s.name.includes('Open or update PR')), 1); }), 'release-backmerge-invariants', /expected an 'Open or update PR' step/],
        ['the merge step removed', '.github/workflows/auto-backmerge.yml', yamlEdit((w) => { const steps = w.jobs.backmerge.steps; steps.splice(steps.findIndex((s) => typeof s.name === 'string' && s.name.includes('Merge the back-merge PR as a merge commit')), 1); }), 'release-backmerge-invariants', /expected a 'Merge the back-merge PR as a merge commit' step/],
        ['the Open or update PR step gated on a step outcome', '.github/workflows/auto-backmerge.yml', yamlEdit((w) => { const steps = w.jobs.backmerge.steps; steps.find((s) => typeof s.name === 'string' && s.name.includes('Open or update PR')).if = "steps.sync.outcome == 'success'"; }), 'release-backmerge-invariants', /'Open or update PR' must not gate on a step outcome\/conclusion/],
        ['the merge step gated on a step conclusion', '.github/workflows/auto-backmerge.yml', yamlEdit((w) => { const steps = w.jobs.backmerge.steps; steps.find((s) => typeof s.name === 'string' && s.name.includes('Merge the back-merge PR as a merge commit')).if = "steps.sync.conclusion == 'success'"; }), 'release-backmerge-invariants', /'Merge the back-merge PR as a merge commit' must not gate on a step outcome\/conclusion/],
        ['the merge step no longer runs merge-commit-pr.cjs', '.github/workflows/auto-backmerge.yml', yamlEdit((w) => { const steps = w.jobs.backmerge.steps; const step = steps.find((s) => typeof s.name === 'string' && s.name.includes('Merge the back-merge PR as a merge commit')); step.run = step.run.split('node scripts/merge-commit-pr.cjs "$PR"').join('echo skipped'); }), 'release-backmerge-invariants', /the back-merge must land through merge-commit-pr\.cjs/],
        ['the merge step runs gh pr merge', '.github/workflows/auto-backmerge.yml', yamlEdit((w) => { const steps = w.jobs.backmerge.steps; const step = steps.find((s) => typeof s.name === 'string' && s.name.includes('Merge the back-merge PR as a merge commit')); step.run = `${step.run}\ngh pr merge "$PR"\n`; }), 'release-backmerge-invariants', /the back-merge must never use `gh pr merge`/],
        ['the merge step reads a literal token flag', '.github/workflows/auto-backmerge.yml', yamlEdit((w) => { const steps = w.jobs.backmerge.steps; steps.find((s) => typeof s.name === 'string' && s.name.includes('Merge the back-merge PR as a merge commit')).env.HAS_ADMIN_TOKEN = 'true'; }), 'release-backmerge-invariants', /the back-merge step must read HAS_ADMIN_TOKEN from the secret/],
        ['the merge step has no env', '.github/workflows/auto-backmerge.yml', yamlEdit((w) => { const steps = w.jobs.backmerge.steps; delete steps.find((s) => typeof s.name === 'string' && s.name.includes('Merge the back-merge PR as a merge commit')).env; }), 'release-backmerge-invariants', /the back-merge step must read HAS_ADMIN_TOKEN from the secret/],
        ['the reconcile step no longer merges with -s ours', '.github/workflows/auto-backmerge.yml', swap('git merge -s ours', 'git merge -s recursive'), 'release-backmerge-invariants', /expected a `git merge -s ours` reconcile step keeping next's tree wholesale/],
        ['the finalize job removed', '.github/workflows/release.yml', yamlEdit((w) => { delete w.jobs.finalize; }), 'release-backmerge-invariants', /expected a finalize job in release\.yml/],
        ['the finalize cap one below the rc budget', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs.finalize['timeout-minutes'] = 29; }), 'release-backmerge-invariants', /the finalize job cap must be at least the rc budget/],
        ['the finalize cap removed', '.github/workflows/release.yml', yamlEdit((w) => { delete w.jobs.finalize['timeout-minutes']; }), 'release-backmerge-invariants', /the finalize job cap must be at least the rc budget/],
        ['the finalize cap written as a string', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs.finalize['timeout-minutes'] = '30'; }), 'release-backmerge-invariants', /the finalize job cap must be at least the rc budget/],
        ['the auto-merge step removed', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs.finalize.steps.splice(w.jobs.finalize.steps.findIndex((s) => typeof s.name === 'string' && s.name.includes('Auto-merge the release')), 1); }), 'release-backmerge-invariants', /expected a finalize step named like 'Auto-merge the release → main PR'/],
        ['the auto-merge step no longer runs merge-commit-pr.cjs', '.github/workflows/release.yml', yamlEdit((w) => { const step = w.jobs.finalize.steps.find((s) => typeof s.name === 'string' && s.name.includes('Auto-merge the release')); step.run = step.run.split('node scripts/merge-commit-pr.cjs "$PR"').join('echo skipped'); }), 'release-backmerge-invariants', /the auto-merge step must land the merge-back PR through merge-commit-pr\.cjs/],
        ['the auto-merge step runs gh pr merge', '.github/workflows/release.yml', yamlEdit((w) => { const step = w.jobs.finalize.steps.find((s) => typeof s.name === 'string' && s.name.includes('Auto-merge the release')); step.run = `${step.run}\ngh pr merge "$PR"\n`; }), 'release-backmerge-invariants', /the auto-merge step must never use `gh pr merge`/],
        ['the auto-merge step reads a literal token flag', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs.finalize.steps.find((s) => typeof s.name === 'string' && s.name.includes('Auto-merge the release')).env.HAS_ADMIN_TOKEN = 'true'; }), 'release-backmerge-invariants', /the auto-merge step must read HAS_ADMIN_TOKEN from the secret/],
        ['the auto-merge step has no env', '.github/workflows/release.yml', yamlEdit((w) => { delete w.jobs.finalize.steps.find((s) => typeof s.name === 'string' && s.name.includes('Auto-merge the release')).env; }), 'release-backmerge-invariants', /the auto-merge step must read HAS_ADMIN_TOKEN from the secret/],
        ['the auto-merge step no longer mentions MERGEABLE', '.github/workflows/release.yml', yamlEdit((w) => { const step = w.jobs.finalize.steps.find((s) => typeof s.name === 'string' && s.name.includes('Auto-merge the release')); step.run = step.run.split('MERGEABLE').join('READY'); }), 'release-backmerge-invariants', /the auto-merge must gate on the PR being MERGEABLE/],
        ['the auto-merge step no longer continue-on-error', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs.finalize.steps.find((s) => typeof s.name === 'string' && s.name.includes('Auto-merge the release'))['continue-on-error'] = false; }), 'release-backmerge-invariants', /the merge-back auto-merge must be continue-on-error/],
        ['the auto-merge step moved before Verify publish', '.github/workflows/release.yml', yamlEdit((w) => { const at = w.jobs.finalize.steps.findIndex((s) => typeof s.name === 'string' && s.name.includes('Auto-merge the release')); w.jobs.finalize.steps.unshift(...w.jobs.finalize.steps.splice(at, 1)); }), 'release-backmerge-invariants', /the auto-merge must run after "Verify publish"/],
        ['the Verify publish step removed', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs.finalize.steps.splice(w.jobs.finalize.steps.findIndex((s) => typeof s.name === 'string' && s.name.includes('Verify publish')), 1); }), 'release-backmerge-invariants', /expected a 'Verify publish' step/],
        ['the validate-version job removed', '.github/workflows/release.yml', yamlEdit((w) => { delete w.jobs['validate-version']; }), 'release-backmerge-invariants', /expected a validate-version job in release\.yml/],
        ['the ancestry step removed', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['validate-version'].steps.splice(w.jobs['validate-version'].steps.findIndex((s) => typeof s.name === 'string' && s.name.includes('Require main to be an ancestor of next')), 1); }), 'release-backmerge-invariants', /expected a 'Require main to be an ancestor of next' step/],
        ['the published-version check removed', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['validate-version'].steps.splice(w.jobs['validate-version'].steps.findIndex((s) => typeof s.name === 'string' && s.name.includes('Reject already-published versions')), 1); }), 'release-backmerge-invariants', /expected a 'Reject already-published versions' step/],
        ['the ancestry step moved before the published-version check', '.github/workflows/release.yml', yamlEdit((w) => { const at = w.jobs['validate-version'].steps.findIndex((s) => typeof s.name === 'string' && s.name.includes('Require main to be an ancestor of next')); w.jobs['validate-version'].steps.splice(1, 0, ...w.jobs['validate-version'].steps.splice(at, 1)); }), 'release-backmerge-invariants', /validate-version must require main to be an ancestor of next after the published-version check/],
        ['the ancestry step no longer runs release-ancestry.cjs', '.github/workflows/release.yml', yamlEdit((w) => { const step = w.jobs['validate-version'].steps.find((s) => typeof s.name === 'string' && s.name.includes('Require main to be an ancestor of next')); step.run = 'echo skipped'; }), 'release-backmerge-invariants', /the ancestry step must run release-ancestry\.cjs against origin\/main and origin\/next/],
        ['the ancestry step gated on rc runs only', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['validate-version'].steps.find((s) => typeof s.name === 'string' && s.name.includes('Require main to be an ancestor of next')).if = "inputs.action != 'rc'"; }), 'release-backmerge-invariants', /validate-version must gate the ancestry step on non-rc, non-hotfix runs/],
        ['the ancestry step with no gate', '.github/workflows/release.yml', yamlEdit((w) => { delete w.jobs['validate-version'].steps.find((s) => typeof s.name === 'string' && s.name.includes('Require main to be an ancestor of next')).if; }), 'release-backmerge-invariants', /validate-version must gate the ancestry step on non-rc, non-hotfix runs/],
        ['a job that does not need validate-version', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['rc-coverage-gate'].needs = ['rc-test']; }), 'release-backmerge-invariants', /every other job needs validate-version/],
        ['a job with no needs at all', '.github/workflows/release.yml', yamlEdit((w) => { delete w.jobs['install-smoke-rc'].needs; }), 'release-backmerge-invariants', /every other job needs validate-version/],
        // cursor-reviewer
        ['command -v cursor-agent removed', 'gsd-core/workflows/review.md', eraseAll('command -v cursor-agent'), 'cursor-reviewer', /review\.md should detect cursor CLI via "command -v cursor-agent" \(not the cursor IDE launcher\)/],
        ['--cursor removed', 'gsd-core/workflows/review.md', eraseAll('--cursor'), 'cursor-reviewer', /review\.md should parse --cursor flag/],
        ['CURSOR_SESSION_ID removed', 'gsd-core/workflows/review.md', eraseAll('CURSOR_SESSION_ID'), 'cursor-reviewer', /review\.md should detect self-CLI via CURSOR_SESSION_ID env var/],
        ['Run cursor agent -p to review. added', 'gsd-core/workflows/review.md', append('Run cursor agent -p to review.'), 'cursor-reviewer', /review\.md must NOT contain the broken two-token form "cursor agent " \(use "cursor-agent" instead\)/],
        ['a prompt piped into a cursor command', 'gsd-core/workflows/review.md', append('cat prompt.md | cursor --print'), 'cursor-reviewer', /review\.md must NOT pipe the prompt to a cursor command via stdin/],
        ['a prompt piped into a cursor command with no blank after the pipe', 'gsd-core/workflows/review.md', append('cat prompt.md |cursor --print'), 'cursor-reviewer', /review\.md must NOT pipe the prompt to a cursor command via stdin/],
        ['a prompt piped into a cursor command after several blanks', 'gsd-core/workflows/review.md', append('cat prompt.md |    cursor --print'), 'cursor-reviewer', /review\.md must NOT pipe the prompt to a cursor command via stdin/],
        ['cursor taken out of the reviewers array', 'gsd-core/workflows/review.md', swap('qwen, cursor, antigravity', 'qwen, antigravity'), 'cursor-reviewer', /review\.md should list cursor in the reviewers array/],
        ['the reviewers array split from cursor by U+2028', 'gsd-core/workflows/review.md', swap('reviewers: [claude,', 'reviewers:\u2028[claude,'), 'cursor-reviewer', /review\.md should list cursor in the reviewers array/],
        ['the reviewers array split from cursor by a carriage return', 'gsd-core/workflows/review.md', swap('reviewers: [claude,', 'reviewers:\r[claude,'), 'cursor-reviewer', /review\.md should list cursor in the reviewers array/],
        ['--cursor removed', 'commands/gsd/review.md', eraseAll('--cursor'), 'cursor-reviewer', /commands\/gsd\/review\.md should mention --cursor flag/],
        ['Cursor removed', 'commands/gsd/review.md', eraseAll('Cursor'), 'cursor-reviewer', /commands\/gsd\/review\.md should mention Cursor/],
        ['--cursor removed', 'gsd-core/workflows/help/modes/full.md', eraseAll('--cursor'), 'cursor-reviewer', /help\.md should list --cursor in the \/gsd-review command signature/],
        ['--cursor removed', 'docs/COMMANDS.md', eraseAll('--cursor'), 'cursor-reviewer', /docs\/COMMANDS\.md should have a --cursor flag row/],
        ['--cursor removed', 'docs/FEATURES.md', eraseAll('--cursor'), 'cursor-reviewer', /docs\/FEATURES\.md should include --cursor in the review command signature/],
        ['Cursor removed', 'docs/FEATURES.md', eraseAll('Cursor'), 'cursor-reviewer', /docs\/FEATURES\.md should mention Cursor in the review section/],
        ['--cursor removed', 'docs/ja-JP/COMMANDS.md', eraseAll('--cursor'), 'cursor-reviewer', /docs\/ja-JP\/COMMANDS\.md should have a --cursor flag row/],
        ['--cursor removed', 'docs/ja-JP/FEATURES.md', eraseAll('--cursor'), 'cursor-reviewer', /docs\/ja-JP\/FEATURES\.md should include --cursor in the review command signature/],
        ['every Cursor mention of the ja-JP FEATURES.md removed', 'docs/ja-JP/FEATURES.md', (text) => text.replace(/cursor/gi, 'x'), 'cursor-reviewer', /docs\/ja-JP\/FEATURES\.md should mention Cursor in the review section/],
        ['--cursor removed', 'docs/ko-KR/COMMANDS.md', eraseAll('--cursor'), 'cursor-reviewer', /docs\/ko-KR\/COMMANDS\.md should have a --cursor flag row/],
        ['--cursor removed', 'docs/ko-KR/FEATURES.md', eraseAll('--cursor'), 'cursor-reviewer', /docs\/ko-KR\/FEATURES\.md should include --cursor in the review command signature/],
        ['every Cursor mention of the ko-KR FEATURES.md removed', 'docs/ko-KR/FEATURES.md', (text) => text.replace(/cursor/gi, 'x'), 'cursor-reviewer', /docs\/ko-KR\/FEATURES\.md should mention Cursor in the review section/],
        // ask-user-questions-fallback
        ['every text mode mention of ui-phase.md removed', 'gsd-core/workflows/ui-phase.md', (text) => text.replace(/text[_ ]mode/gi, 'x'), 'ask-user-questions-fallback', /every workflow that uses AskUserQuestion must include a TEXT_MODE fallback/],
        ['every plain-text and numbered list mention of ui-phase.md removed', 'gsd-core/workflows/ui-phase.md', (text) => text.replace(/plain[- ]text|numbered list/gi, 'x'), 'ask-user-questions-fallback', /every workflow that uses AskUserQuestion must include a TEXT_MODE fallback/],
        ['a fifth label added to the first options array of settings.md', 'gsd-core/workflows/settings.md', (text) => { const ask = text.indexOf('AskUserQuestion(['); const at = text.indexOf('options: [', ask) + 'options: ['.length; return `${text.slice(0, at)} { label: "x1" }, { label: "x2" }, { label: "x3" }, { label: "x4" }, { label: "x5" },${text.slice(at)}`; }, 'ask-user-questions-fallback', /every AskUserQuestion options array must have at most 4 options/],
        ['ui-phase.md: every --auto arm removed', 'gsd-core/workflows/ui-phase.md', swap('**If `--auto`:**', '**If auto:**'), 'ask-user-questions-fallback', /ui-phase\.md: the --auto arm must reuse the existing artifact, before any prompt \(the artifact-exists branch has no --auto arm/],
        ['ui-phase.md: a prompt before the --auto arm', 'gsd-core/workflows/ui-phase.md', swap('## 4. Check Existing UI-SPEC', '## 4. Check Existing UI-SPEC\nUse AskUserQuestion first.\n'), 'ask-user-questions-fallback', /ui-phase\.md: the --auto arm must reuse the existing artifact, before any prompt \(the --auto arm must resolve BEFORE the prompt/],
        ['ui-phase.md: the prompt removed', 'gsd-core/workflows/ui-phase.md', eraseAll('Use AskUserQuestion'), 'ask-user-questions-fallback', /ui-phase\.md: the --auto arm must reuse the existing artifact, before any prompt \(expected a `Use AskUserQuestion` prompt/],
        ['ui-phase.md: the anchor renamed', 'gsd-core/workflows/ui-phase.md', swap('## 4. Check Existing UI-SPEC', '## Renamed'), 'ask-user-questions-fallback', /ui-phase\.md: the --auto arm must reuse the existing artifact, before any prompt \(anchor not found/],
        ['ui-phase.md: the arm selects the regenerating option', 'gsd-core/workflows/ui-phase.md', swap('Auto-select "Skip"', 'Auto-select "Update"'), 'ask-user-questions-fallback', /ui-phase\.md: the --auto arm must reuse the existing artifact, before any prompt \(the --auto arm must select "Skip"/],
        ['ui-phase.md: the arm names the regenerating option as well', 'gsd-core/workflows/ui-phase.md', swap('Auto-select "Skip"', 'Auto-select "Skip" or "Update"'), 'ask-user-questions-fallback', /ui-phase\.md: the --auto arm must reuse the existing artifact, before any prompt \(auto-selecting "Update" regenerates/],
        ['ui-phase.md: the reuse option moved to the next line', 'gsd-core/workflows/ui-phase.md', swap('Auto-select "Skip"', 'Auto-select\n"Skip"'), 'ask-user-questions-fallback', /ui-phase\.md: the --auto arm must reuse the existing artifact, before any prompt \(the --auto arm must select "Skip"/],
        ['spec-phase.md: every --auto arm removed', 'gsd-core/workflows/spec-phase.md', swap('**If `--auto`:**', '**If auto:**'), 'ask-user-questions-fallback', /spec-phase\.md: the --auto arm must reuse the existing artifact, before any prompt \(the artifact-exists branch has no --auto arm/],
        ['spec-phase.md: a prompt before the --auto arm', 'gsd-core/workflows/spec-phase.md', swap('**Check for existing SPEC.md:**', '**Check for existing SPEC.md:**\nUse AskUserQuestion first.\n'), 'ask-user-questions-fallback', /spec-phase\.md: the --auto arm must reuse the existing artifact, before any prompt \(the --auto arm must resolve BEFORE the prompt/],
        ['spec-phase.md: the prompt removed', 'gsd-core/workflows/spec-phase.md', eraseAll('Use AskUserQuestion'), 'ask-user-questions-fallback', /spec-phase\.md: the --auto arm must reuse the existing artifact, before any prompt \(expected a `Use AskUserQuestion` prompt/],
        ['spec-phase.md: the anchor renamed', 'gsd-core/workflows/spec-phase.md', swap('**Check for existing SPEC.md:**', '## Renamed'), 'ask-user-questions-fallback', /spec-phase\.md: the --auto arm must reuse the existing artifact, before any prompt \(anchor not found/],
        ['spec-phase.md: the arm selects the regenerating option', 'gsd-core/workflows/spec-phase.md', swap('Auto-select "Skip"', 'Auto-select "Update"'), 'ask-user-questions-fallback', /spec-phase\.md: the --auto arm must reuse the existing artifact, before any prompt \(the --auto arm must select "Skip"/],
        ['spec-phase.md: the arm names the regenerating option as well', 'gsd-core/workflows/spec-phase.md', swap('Auto-select "Skip"', 'Auto-select "Skip" or "Update"'), 'ask-user-questions-fallback', /spec-phase\.md: the --auto arm must reuse the existing artifact, before any prompt \(auto-selecting "Update" regenerates/],
        ['spec-phase.md: the reuse option moved to the next line', 'gsd-core/workflows/spec-phase.md', swap('Auto-select "Skip"', 'Auto-select\n"Skip"'), 'ask-user-questions-fallback', /spec-phase\.md: the --auto arm must reuse the existing artifact, before any prompt \(the --auto arm must select "Skip"/],
        ['ai-integration-phase.md: every --auto arm removed', 'gsd-core/workflows/ai-integration-phase.md', swap('**If `--auto`:**', '**If auto:**'), 'ask-user-questions-fallback', /ai-integration-phase\.md: the --auto arm must reuse the existing artifact, before any prompt \(the artifact-exists branch has no --auto arm/],
        ['ai-integration-phase.md: a prompt before the --auto arm', 'gsd-core/workflows/ai-integration-phase.md', swap('## 4. Check Existing AI-SPEC', '## 4. Check Existing AI-SPEC\nUse AskUserQuestion first.\n'), 'ask-user-questions-fallback', /ai-integration-phase\.md: the --auto arm must reuse the existing artifact, before any prompt \(the --auto arm must resolve BEFORE the prompt/],
        ['ai-integration-phase.md: the prompt removed', 'gsd-core/workflows/ai-integration-phase.md', eraseAll('Use AskUserQuestion'), 'ask-user-questions-fallback', /ai-integration-phase\.md: the --auto arm must reuse the existing artifact, before any prompt \(expected a `Use AskUserQuestion` prompt/],
        ['ai-integration-phase.md: the anchor renamed', 'gsd-core/workflows/ai-integration-phase.md', swap('## 4. Check Existing AI-SPEC', '## Renamed'), 'ask-user-questions-fallback', /ai-integration-phase\.md: the --auto arm must reuse the existing artifact, before any prompt \(anchor not found/],
        ['ai-integration-phase.md: the arm selects the regenerating option', 'gsd-core/workflows/ai-integration-phase.md', swap('Auto-select "Skip"', 'Auto-select "Update"'), 'ask-user-questions-fallback', /ai-integration-phase\.md: the --auto arm must reuse the existing artifact, before any prompt \(the --auto arm must select "Skip"/],
        ['ai-integration-phase.md: the arm names the regenerating option as well', 'gsd-core/workflows/ai-integration-phase.md', swap('Auto-select "Skip"', 'Auto-select "Skip" or "Update"'), 'ask-user-questions-fallback', /ai-integration-phase\.md: the --auto arm must reuse the existing artifact, before any prompt \(auto-selecting "Update" regenerates/],
        ['ai-integration-phase.md: the reuse option moved to the next line', 'gsd-core/workflows/ai-integration-phase.md', swap('Auto-select "Skip"', 'Auto-select\n"Skip"'), 'ask-user-questions-fallback', /ai-integration-phase\.md: the --auto arm must reuse the existing artifact, before any prompt \(the --auto arm must select "Skip"/],
        ['eval-review.md: every --auto arm removed', 'gsd-core/workflows/eval-review.md', swap('**If `--auto`:**', '**If auto:**'), 'ask-user-questions-fallback', /eval-review\.md: the --auto arm must reuse the existing artifact, before any prompt \(the artifact-exists branch has no --auto arm/],
        ['eval-review.md: a prompt before the --auto arm', 'gsd-core/workflows/eval-review.md', swap('**If `EVAL_REVIEW_FILE` non-empty:**', '**If `EVAL_REVIEW_FILE` non-empty:**\nUse AskUserQuestion first.\n'), 'ask-user-questions-fallback', /eval-review\.md: the --auto arm must reuse the existing artifact, before any prompt \(the --auto arm must resolve BEFORE the prompt/],
        ['eval-review.md: the prompt removed', 'gsd-core/workflows/eval-review.md', eraseAll('Use AskUserQuestion'), 'ask-user-questions-fallback', /eval-review\.md: the --auto arm must reuse the existing artifact, before any prompt \(expected a `Use AskUserQuestion` prompt/],
        ['eval-review.md: the anchor renamed', 'gsd-core/workflows/eval-review.md', swap('**If `EVAL_REVIEW_FILE` non-empty:**', '## Renamed'), 'ask-user-questions-fallback', /eval-review\.md: the --auto arm must reuse the existing artifact, before any prompt \(anchor not found/],
        ['eval-review.md: the arm selects the regenerating option', 'gsd-core/workflows/eval-review.md', swap('Auto-select "View"', 'Auto-select "Re-audit"'), 'ask-user-questions-fallback', /eval-review\.md: the --auto arm must reuse the existing artifact, before any prompt \(the --auto arm must select "View"/],
        ['eval-review.md: the arm names the regenerating option as well', 'gsd-core/workflows/eval-review.md', swap('Auto-select "View"', 'Auto-select "View" or "Re-audit"'), 'ask-user-questions-fallback', /eval-review\.md: the --auto arm must reuse the existing artifact, before any prompt \(auto-selecting "Re-audit" regenerates/],
        ['eval-review.md: the reuse option moved to the next line', 'gsd-core/workflows/eval-review.md', swap('Auto-select "View"', 'Auto-select\n"View"'), 'ask-user-questions-fallback', /eval-review\.md: the --auto arm must reuse the existing artifact, before any prompt \(the --auto arm must select "View"/],
        ['ui-review.md: every --auto arm removed', 'gsd-core/workflows/ui-review.md', swap('**If `--auto`:**', '**If auto:**'), 'ask-user-questions-fallback', /ui-review\.md: the --auto arm must reuse the existing artifact, before any prompt \(the artifact-exists branch has no --auto arm/],
        ['ui-review.md: a prompt before the --auto arm', 'gsd-core/workflows/ui-review.md', swap('**If `UI_REVIEW_FILE` non-empty:**', '**If `UI_REVIEW_FILE` non-empty:**\nUse AskUserQuestion first.\n'), 'ask-user-questions-fallback', /ui-review\.md: the --auto arm must reuse the existing artifact, before any prompt \(the --auto arm must resolve BEFORE the prompt/],
        ['ui-review.md: the prompt removed', 'gsd-core/workflows/ui-review.md', eraseAll('Use AskUserQuestion'), 'ask-user-questions-fallback', /ui-review\.md: the --auto arm must reuse the existing artifact, before any prompt \(expected a `Use AskUserQuestion` prompt/],
        ['ui-review.md: the anchor renamed', 'gsd-core/workflows/ui-review.md', swap('**If `UI_REVIEW_FILE` non-empty:**', '## Renamed'), 'ask-user-questions-fallback', /ui-review\.md: the --auto arm must reuse the existing artifact, before any prompt \(anchor not found/],
        ['ui-review.md: the arm selects the regenerating option', 'gsd-core/workflows/ui-review.md', swap('Auto-select "View"', 'Auto-select "Re-audit"'), 'ask-user-questions-fallback', /ui-review\.md: the --auto arm must reuse the existing artifact, before any prompt \(the --auto arm must select "View"/],
        ['ui-review.md: the arm names the regenerating option as well', 'gsd-core/workflows/ui-review.md', swap('Auto-select "View"', 'Auto-select "View" or "Re-audit"'), 'ask-user-questions-fallback', /ui-review\.md: the --auto arm must reuse the existing artifact, before any prompt \(auto-selecting "Re-audit" regenerates/],
        ['ui-review.md: the reuse option moved to the next line', 'gsd-core/workflows/ui-review.md', swap('Auto-select "View"', 'Auto-select\n"View"'), 'ask-user-questions-fallback', /ui-review\.md: the --auto arm must reuse the existing artifact, before any prompt \(the --auto arm must select "View"/],
        ['an --auto arm beside the force-approve escalation', 'gsd-core/workflows/ui-phase.md', swap('Force approve', '**If `--auto`:** Force approve'), 'ask-user-questions-fallback', /the max-revision-iterations escalation must keep blocking for a human under --auto/],
        ['the force-approve escalation removed', 'gsd-core/workflows/ui-phase.md', eraseAll('Force approve'), 'ask-user-questions-fallback', /the max-revision-iterations escalation must keep blocking for a human under --auto \(ui-phase\.md: expected the max-iterations escalation to still exist/],
        ['an --auto arm 584 characters before the escalation is inside the window', 'gsd-core/workflows/ui-phase.md', (text) => { const at = text.indexOf('Force approve'); return text.slice(0, at) + '**If `--auto`:**' + 'x'.repeat(584) + text.slice(at); }, 'ask-user-questions-fallback', /the max-revision-iterations escalation must keep blocking for a human under --auto/],
        ['an --auto arm 571 characters after the escalation is inside the window', 'gsd-core/workflows/ui-phase.md', (text) => { const at = text.indexOf('Force approve') + 'Force approve'.length; return text.slice(0, at) + 'x'.repeat(571) + '**If `--auto`:**' + text.slice(at); }, 'ask-user-questions-fallback', /the max-revision-iterations escalation must keep blocking for a human under --auto/],
        // next-up-clear-order
        ['ui-brand.md with a <sub>/clear</sub> footnote', 'gsd-core/references/ui-brand.md', append('<sub>/clear</sub>'), 'next-up-clear-order', /ui-brand\.md must not contain a <sub>\/clear<\/sub> pattern: \/clear should appear before the command/],
        ['ui-brand.md with an upper-case footnote', 'gsd-core/references/ui-brand.md', append('<SUB>a /CLEAR b</Sub>'), 'next-up-clear-order', /ui-brand\.md must not contain a <sub>\/clear<\/sub> pattern: \/clear should appear before the command/],
        ['continuation-format.md with a footnote', 'gsd-core/references/continuation-format.md', append('<sub>/clear</sub>'), 'next-up-clear-order', /continuation-format\.md must not contain a <sub>\/clear<\/sub> pattern: \/clear should appear before the command/],
        ['a workflow with a footnote', 'gsd-core/workflows/plan-phase.md', append('<sub>/clear</sub>'), 'next-up-clear-order', /gsd-core\/workflows\/plan-phase\.md must not contain a <sub>\/clear<\/sub> pattern: \/clear should appear before the command/],
        ['a reference with a footnote', 'gsd-core/references/ui-brand.md', append('<sub>/clear</sub>'), 'next-up-clear-order', /gsd-core\/references\/ui-brand\.md must not contain a <sub>\/clear<\/sub> pattern: \/clear should appear before the command/],
        ['the clear command taken out of the Next Up block', 'gsd-core/references/ui-brand.md', within('## Next Up Block', '## Error Panel', eraseAll('/clear')), 'next-up-clear-order', /the Next Up block template must show \/clear before \{copy-paste command\}/],
        ['the copy-paste command taken out of the Next Up block', 'gsd-core/references/ui-brand.md', within('## Next Up Block', '## Error Panel', eraseAll('{copy-paste command}')), 'next-up-clear-order', /the Next Up block template must show \/clear before \{copy-paste command\}/],
        ['the clear and command lines swapped in the Next Up block', 'gsd-core/references/ui-brand.md', within('## Next Up Block', '## Error Panel', (section) => swap('@@A', '`{copy-paste command}`')(swap('`{copy-paste command}`', '`/clear` then:')(swap('`/clear` then:', '@@A')(section)))), 'next-up-clear-order', /the Next Up block template must show \/clear before \{copy-paste command\}/],
        ['the section start renamed', 'gsd-core/references/ui-brand.md', swap('## Next Up Block', '## Up Block'), 'next-up-clear-order', /marker "## Next Up Block" not found/],
        ['the section end renamed', 'gsd-core/references/ui-brand.md', swap('## Error Panel', '## Faults'), 'next-up-clear-order', /closing marker "## Error Panel" not found after "## Next Up Block"/],
        ['the resume route gains the clear-then template', 'gsd-core/workflows/resume-project.md', within('<step name="route_to_workflow">', '</step>', (step) => step + '\n`/clear` then: next\n'), 'next-up-clear-order', /resume route templates must not include `\/clear` then:/],
        ['the route step renamed', 'gsd-core/workflows/resume-project.md', swap('<step name="route_to_workflow">', '<step name="routes">'), 'next-up-clear-order', /route_to_workflow.{1,20}not found/],
        ['the exception note removed from the route', 'gsd-core/workflows/resume-project.md', within('<step name="route_to_workflow">', '</step>', (step) => step.replace(/exception/gi, 'x')), 'next-up-clear-order', /the route_to_workflow block must include an exception note explaining resume behavior/],
        ['the resume word removed from the route', 'gsd-core/workflows/resume-project.md', within('<step name="route_to_workflow">', '</step>', (step) => step.replace(/resume/gi, 'x')), 'next-up-clear-order', /the route_to_workflow block must include an exception note explaining resume behavior/],
        ['the exception and resume words on different lines', 'gsd-core/workflows/resume-project.md', (text) => swap('Resume is already', 'It is already')(swap('Resume-specific exception:', 'Resume-specific\nexception:')(text)), 'next-up-clear-order', /the route_to_workflow block must include an exception note explaining resume behavior/],
        ['the GAPS_MODE assignment renamed', 'gsd-core/workflows/plan-phase.md', swap('GAPS_MODE=true', 'GAPS_MODE=on'), 'next-up-clear-order', /the plan-phase\.md preamble must set GAPS_MODE from the captured arguments/],
        ['the captured arguments variable renamed', 'gsd-core/workflows/plan-phase.md', swap('$GSD_ARGS', '$ARGS'), 'next-up-clear-order', /the plan-phase\.md preamble must set GAPS_MODE from the captured arguments/],
        ['the GAPS_MODE default removed', 'gsd-core/workflows/plan-phase.md', swap('GAPS_MODE=false', 'GAPS_MODE=""'), 'next-up-clear-order', /the plan-phase\.md preamble must set GAPS_MODE from the captured arguments/],
        ['the gaps-only assignment removed', 'gsd-core/workflows/plan-phase.md', swap('GAPS_EXEC_FLAG="--gaps-only"', 'GAPS_EXEC_FLAG="--gaps"'), 'next-up-clear-order', /the plan-phase\.md preamble must derive GAPS_EXEC_FLAG="--gaps-only" from GAPS_MODE/],
        ['the derivation default removed', 'gsd-core/workflows/plan-phase.md', swap('GAPS_EXEC_FLAG=""', 'GAPS_EXEC_FLAG=none'), 'next-up-clear-order', /the plan-phase\.md preamble must derive GAPS_EXEC_FLAG="--gaps-only" from GAPS_MODE/],
        ['the derivation names reviews', 'gsd-core/workflows/plan-phase.md', swap('GAPS_EXEC_FLAG=""', 'GAPS_EXEC_FLAG="" # reviews'), 'next-up-clear-order', /the --gaps-only derivation must be gated on GAPS_MODE alone/],
        ['the derivation names reviews in capitals', 'gsd-core/workflows/plan-phase.md', swap('GAPS_EXEC_FLAG=""', 'GAPS_EXEC_FLAG="" # REVIEWS'), 'next-up-clear-order', /the --gaps-only derivation must be gated on GAPS_MODE alone/],
        ['the derivation block does not name GAPS_MODE', 'gsd-core/workflows/plan-phase.md', (text) => { const start = text.indexOf('GAPS_EXEC_FLAG=""'); const end = text.indexOf('GAPS_EXEC_FLAG="--gaps-only"', start); return text.slice(0, start) + swap('GAPS_MODE', 'MODE')(text.slice(start, end)) + text.slice(end); }, 'next-up-clear-order', /the plan-phase\.md preamble must derive GAPS_EXEC_FLAG="--gaps-only" from GAPS_MODE/],
        ['the offer_next block renamed', 'gsd-core/workflows/plan-phase.md', swap('\n<offer_next>', '\n<offer_done>'), 'next-up-clear-order', /plan-phase\.md must have a closed <offer_next> block/],
        ['the offer_next block left open', 'gsd-core/workflows/plan-phase.md', swap('\n</offer_next>', '\n</offer_done>'), 'next-up-clear-order', /plan-phase\.md must have a closed <offer_next> block/],
        ['the execute command without the flag placeholder', 'gsd-core/workflows/plan-phase.md', within('\n<offer_next>', '\n</offer_next>', eraseAll('${GAPS_EXEC_FLAG}')), 'next-up-clear-order', /<offer_next> execute-phase command must substitute \$\{GAPS_EXEC_FLAG\} after \{X\}/],
        ['the execute command without the workspace placeholder', 'gsd-core/workflows/plan-phase.md', within('\n<offer_next>', '\n</offer_next>', eraseAll('${GSD_WS}')), 'next-up-clear-order', /<offer_next> command must keep the bare \/gsd:execute-phase \{X\} form with \$\{GSD_WS\}/],
        ['the gaps-only scope removed from the offer_next block', 'gsd-core/workflows/plan-phase.md', within('\n<offer_next>', '\n</offer_next>', swap('--gaps-only', '--gaps')), 'next-up-clear-order', /<offer_next> must reference the --gaps-only execute-phase scope/],
        ['the --gaps flag after the captured arguments with a gap of 81 characters', 'gsd-core/workflows/plan-phase.md', () => `GAPS_MODE=false\n$GSD_ARGSxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx--gapsGAPS_MODE=true\nGAPS_EXEC_FLAG=""GAPS_MODEGAPS_EXEC_FLAG="--gaps-only"\n\n<offer_next>\n/gsd:execute-phase {X} \${GAPS_EXEC_FLAG} \${GSD_WS}\n--gaps-only\n</offer_next>\n`, 'next-up-clear-order', /the plan-phase\.md preamble must set GAPS_MODE from the captured arguments/],
        ['the GAPS_MODE=true assignment after the --gaps flag with a gap of 41 characters', 'gsd-core/workflows/plan-phase.md', () => `GAPS_MODE=false\n$GSD_ARGS--gapsyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyGAPS_MODE=true\nGAPS_EXEC_FLAG=""GAPS_MODEGAPS_EXEC_FLAG="--gaps-only"\n\n<offer_next>\n/gsd:execute-phase {X} \${GAPS_EXEC_FLAG} \${GSD_WS}\n--gaps-only\n</offer_next>\n`, 'next-up-clear-order', /the plan-phase\.md preamble must set GAPS_MODE from the captured arguments/],
        ['the gaps-only assignment after GAPS_MODE with a gap of 61 characters', 'gsd-core/workflows/plan-phase.md', () => `GAPS_MODE=false\n$GSD_ARGS--gapsGAPS_MODE=true\nGAPS_EXEC_FLAG=""GAPS_MODEzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzGAPS_EXEC_FLAG="--gaps-only"\n\n<offer_next>\n/gsd:execute-phase {X} \${GAPS_EXEC_FLAG} \${GSD_WS}\n--gaps-only\n</offer_next>\n`, 'next-up-clear-order', /the plan-phase\.md preamble must derive GAPS_EXEC_FLAG="--gaps-only" from GAPS_MODE/],
        ['the gaps-only assignment after the empty flag with a gap of 192 characters', 'gsd-core/workflows/plan-phase.md', () => `GAPS_MODE=false\n$GSD_ARGS--gapsGAPS_MODE=true\nGAPS_EXEC_FLAG=""qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqGAPS_MODEGAPS_EXEC_FLAG="--gaps-only"\n\n<offer_next>\n/gsd:execute-phase {X} \${GAPS_EXEC_FLAG} \${GSD_WS}\n--gaps-only\n</offer_next>\n`, 'next-up-clear-order', /expected a GAPS_EXEC_FLAG derivation block/],
        // agent-skills-bootstrap
        ['the <agent_skills> block no longer named in the bootstrap', 'gsd-core/references/agent-skills-bootstrap.md', eraseAll('<agent_skills>'), 'agent-skills-bootstrap', /the bootstrap must name the <agent_skills> block/],
        ['"skip" gone from the dedup guard', 'gsd-core/references/agent-skills-bootstrap.md', erase(/skip/gi), 'agent-skills-bootstrap', /dedup guard[^]{0,200}\(missing skip\)/],
        ['"already" gone from the dedup guard', 'gsd-core/references/agent-skills-bootstrap.md', erase(/already/gi), 'agent-skills-bootstrap', /dedup guard[^]{0,200}\(missing already\)/],
        ['"frontmatter" gone from the bootstrap', 'gsd-core/references/agent-skills-bootstrap.md', erase(/frontmatter/gi), 'agent-skills-bootstrap', /query agent-skills using the frontmatter name[^]{0,60}expected \/frontmatter\/i/],
        ['"query agent-skills" gone from the bootstrap', 'gsd-core/references/agent-skills-bootstrap.md', erase(/query agent-skills/gi), 'agent-skills-bootstrap', /the bootstrap must carry the query command/],
        ['the query command renamed', 'gsd-core/references/agent-skills-bootstrap.md', swap('gsd_run query agent-skills', 'gsd_run query skills'), 'agent-skills-bootstrap', /the bootstrap must carry the query command/],
        ['--skills-only gone from the query command line', 'gsd-core/references/agent-skills-bootstrap.md', swap('<your-agent-type> --skills-only)', '<your-agent-type>)'), 'agent-skills-bootstrap', /the self-load query must pass --skills-only/],
        ['stderr hidden on the query command line', 'gsd-core/references/agent-skills-bootstrap.md', swap('<your-agent-type> --skills-only)', '<your-agent-type> --skills-only 2>/dev/null)'), 'agent-skills-bootstrap', /stderr and the exit status must stay visible/],
        ['a swallowed exit status on the query command line', 'gsd-core/references/agent-skills-bootstrap.md', swap('<your-agent-type> --skills-only)', '<your-agent-type> --skills-only || true)'), 'agent-skills-bootstrap', /stderr and the exit status must stay visible/],
        ['"agent type" gone from the bootstrap', 'gsd-core/references/agent-skills-bootstrap.md', erase(/agent type/gi), 'agent-skills-bootstrap', /use the type stated in its own file[^]{0,60}expected \/agent type\/i/],
        ['the resolver pointer gone from the bootstrap', 'gsd-core/references/agent-skills-bootstrap.md', eraseAll('gsd-run-resolver.md'), 'agent-skills-bootstrap', /must point at the shared resolver reference/],
        ['the assumed-launcher claim added', 'gsd-core/references/agent-skills-bootstrap.md', append('Your own init already defines gsd_run.'), 'agent-skills-bootstrap', /gsd_run is not defined by every agent init/],
        ['gsd_run no longer defined by the resolver', 'gsd-core/references/gsd-run-resolver.md', eraseAll('gsd_run() {'), 'agent-skills-bootstrap', /the referenced resolver must define gsd_run/],
        ['--skills-only gone from the whole bootstrap', 'gsd-core/references/agent-skills-bootstrap.md', eraseAll('--skills-only'), 'agent-skills-bootstrap', /the self-load query must pass --skills-only/],
        ['"non-Claude" gone from the bootstrap', 'gsd-core/references/agent-skills-bootstrap.md', eraseAll('non-Claude'), 'agent-skills-bootstrap', /non-Claude runtime returns the agent persona[^]{0,60}\(missing non-Claude\)/],
        ['"persona" gone from the bootstrap', 'gsd-core/references/agent-skills-bootstrap.md', erase(/persona/gi), 'agent-skills-bootstrap', /non-Claude runtime returns the agent persona[^]{0,60}\(missing persona\)/],
        ['the unscoped empty-block claim added with two spaces', 'gsd-core/references/agent-skills-bootstrap.md', append('A plain query exits 0 with an empty  block when nothing is configured for your type.'), 'agent-skills-bootstrap', /the empty-block claim must be scoped to --skills-only/],
        ['the unscoped empty-block claim added across a line break', 'gsd-core/references/agent-skills-bootstrap.md', append('A plain query exits 0 with an empty\nblock when nothing is configured for your type.'), 'agent-skills-bootstrap', /the empty-block claim must be scoped to --skills-only/],
        ['the unscoped empty-block claim added across a tab', 'gsd-core/references/agent-skills-bootstrap.md', append('A plain query exits 0 with an empty\tblock when nothing is configured for your type.'), 'agent-skills-bootstrap', /the empty-block claim must be scoped to --skills-only/],
        ['the unscoped empty-block claim added across a no-break space', 'gsd-core/references/agent-skills-bootstrap.md', append('A plain query exits 0 with an empty\u00a0block when nothing is configured for your type.'), 'agent-skills-bootstrap', /the empty-block claim must be scoped to --skills-only/],
        ['the unscoped empty-block claim added in capitals', 'gsd-core/references/agent-skills-bootstrap.md', append('EXITS 0 WITH AN EMPTY BLOCK WHEN NOTHING IS CONFIGURED FOR YOUR TYPE.'), 'agent-skills-bootstrap', /the empty-block claim must be scoped to --skills-only/],
        ['the unscoped empty-block claim added after an earlier partial mention', 'gsd-core/references/agent-skills-bootstrap.md', append('exits 0 with an empty set. It also exits 0 with an empty\nblock when nothing is configured for your type.'), 'agent-skills-bootstrap', /the empty-block claim must be scoped to --skills-only/],
        ['the frontmatter-name instruction added with one space', 'gsd-core/references/agent-skills-bootstrap.md', append('Read the `name:` value in your frontmatter.'), 'agent-skills-bootstrap', /must not send the agent to the frontmatter it may not be able to see/],
        ['the frontmatter-name instruction added across a line break', 'gsd-core/references/agent-skills-bootstrap.md', append('Read the `name:` value in\nyour frontmatter.'), 'agent-skills-bootstrap', /must not send the agent to the frontmatter it may not be able to see/],
        ['the frontmatter-name instruction added with a long gap', 'gsd-core/references/agent-skills-bootstrap.md', append(`Read the \`name:\` value in${' '.repeat(300)}your frontmatter.`), 'agent-skills-bootstrap', /must not send the agent to the frontmatter it may not be able to see/],
        ['"Claude Code" gone from the bootstrap', 'gsd-core/references/agent-skills-bootstrap.md', eraseAll('Claude Code'), 'agent-skills-bootstrap', /explain why the type is not read from frontmatter[^]{0,40}expected \/Claude Code\//],
        ['a consumer agent without the bootstrap pointer', 'agents/gsd-planner.md', eraseAll('agent-skills-bootstrap.md'), 'agent-skills-bootstrap', /gsd-planner must @-include references\/agent-skills-bootstrap\.md/],
        ['a non-consumer canonical agent carrying the pointer', 'agents/gsd-intel-updater.md', append('**agent_skills:** self-load per @~/.claude/gsd-core/references/agent-skills-bootstrap.md (agent type: `gsd-intel-updater`)'), 'agent-skills-bootstrap', /agents\/gsd-intel-updater\.md carries the bootstrap pointer but is not a consumer agent/],
        ['a second bootstrap pointer line in a consumer agent', 'agents/gsd-planner.md', append('Also see agent-skills-bootstrap.md again.'), 'agent-skills-bootstrap', /agents\/gsd-planner\.md must carry exactly one bootstrap pointer \(found 2\)/],
        ['a consumer agent stating another agent type', 'agents/gsd-planner.md', swap('(agent type: `gsd-planner`)', '(agent type: `gsd-other`)'), 'agent-skills-bootstrap', /agents\/gsd-planner\.md pointer must state "\(agent type: `gsd-planner`\)"/],
        ['a consumer agent whose pointer states no type', 'agents/gsd-planner.md', swap(' (agent type: `gsd-planner`)', ''), 'agent-skills-bootstrap', /agents\/gsd-planner\.md pointer must state "\(agent type: `gsd-planner`\)"/],
        ['a compact sibling stating another agent type', 'agents/gsd-code-fixer.compact.md', swap('(agent type: `gsd-code-fixer`)', '(agent type: `gsd-code-reviewer`)'), 'agent-skills-bootstrap', /agents\/gsd-code-fixer\.compact\.md pointer must state "\(agent type: `gsd-code-fixer`\)"/],
        ['a compact sibling with two pointer lines', 'agents/gsd-code-fixer.compact.md', append('Also agent-skills-bootstrap.md.'), 'agent-skills-bootstrap', /agents\/gsd-code-fixer\.compact\.md must carry exactly one bootstrap pointer \(found 2\)/],
        ['a frontmatter name that differs from the stated type', 'agents/gsd-planner.md', swap('name: gsd-planner', 'name: gsd-other'), 'agent-skills-bootstrap', /agents\/gsd-planner\.md frontmatter name gsd-other must match the stated type gsd-planner/],
        ['a quoted frontmatter name that differs from the stated type', 'agents/gsd-planner.md', swap('name: gsd-planner', 'name: "gsd-other"'), 'agent-skills-bootstrap', /agents\/gsd-planner\.md frontmatter name gsd-other must match the stated type gsd-planner/],
        // spike-manifest-scoping
        ['"idea key" gone from spike.md', 'gsd-core/workflows/spike.md', erase(/idea key/gi), 'spike-manifest-scoping', /create_manifest must introduce an explicit "idea key" concept/],
        ['"idea key" in capitals still satisfies the any-case check', 'gsd-core/workflows/spike.md', erase(/idea key/g), 'spike-manifest-scoping', /create_manifest must introduce an explicit "idea key" concept/],
        ['the `## Ideas` heading gone', 'gsd-core/workflows/spike.md', erase(/##\s*Ideas\b/g), 'spike-manifest-scoping', /must have a `## Ideas` section \(plural\)/],
        ['the `## Ideas` heading singular again', 'gsd-core/workflows/spike.md', swap('## Ideas', '## Idea'), 'spike-manifest-scoping', /must have a `## Ideas` section \(plural\)/],
        ['the `## Ideas` heading with a word character after it', 'gsd-core/workflows/spike.md', swap('## Ideas', '## Ideasx'), 'spike-manifest-scoping', /must have a `## Ideas` section \(plural\)/],
        ['the `### {idea-key}` subsection gone', 'gsd-core/workflows/spike.md', erase(/###\s*\{idea-key\}/g), 'spike-manifest-scoping', /scope each idea under its own `### \{idea-key\}` subsection/],
        ['the `### {idea-key}` subsection without its braces', 'gsd-core/workflows/spike.md', swap('### {idea-key}', '### idea-key'), 'spike-manifest-scoping', /scope each idea under its own `### \{idea-key\}` subsection/],
        ['"append" gone from the spike workflow', 'gsd-core/workflows/spike.md', erase(/append/gi), 'spike-manifest-scoping', /a new idea must append a new idea section rather than overwrite/],
        ['"new idea key" gone from the spike workflow', 'gsd-core/workflows/spike.md', erase(/new idea key/gi), 'spike-manifest-scoping', /a new idea must append a new idea section rather than overwrite/],
        ['the never-touch rule gone', 'gsd-core/workflows/spike.md', erase(/never touch/gi), 'spike-manifest-scoping', /forbid touching another idea's section/],
        ['the never-touch rule without its target', 'gsd-core/workflows/spike.md', erase(/(?:another|other) idea/gi), 'spike-manifest-scoping', /forbid touching another idea's section/],
        ['the old flat shape no longer migrated', 'gsd-core/workflows/spike.md', erase(/old flat/gi), 'spike-manifest-scoping', /migrate a pre-#1700 flat-shape MANIFEST\.md in place/],
        ['"shape" gone after the old flat shape', 'gsd-core/workflows/spike.md', swap('old flat shape', 'old flat'), 'spike-manifest-scoping', /migrate a pre-#1700 flat-shape MANIFEST\.md in place/],
        ['the Idea column gone from the Spikes table', 'gsd-core/workflows/spike.md', swap('| # | Idea | Name | Type | Validates | Verdict | Tags |', '| # | Name | Type | Validates | Verdict | Tags |'), 'spike-manifest-scoping', /Spikes` table header must include an Idea column/],
        ['the Name column gone from the Spikes table', 'gsd-core/workflows/spike.md', swap('| # | Idea | Name | Type | Validates | Verdict | Tags |', '| # | Idea | Type | Validates | Verdict | Tags |'), 'spike-manifest-scoping', /Spikes` table header must include an Idea column/],
        ['the Type column gone from the Spikes table', 'gsd-core/workflows/spike.md', swap('| # | Idea | Name | Type | Validates | Verdict | Tags |', '| # | Idea | Name | Validates | Verdict | Tags |'), 'spike-manifest-scoping', /Spikes` table header must include an Idea column/],
        ['the Validates column gone from the Spikes table', 'gsd-core/workflows/spike.md', swap('| # | Idea | Name | Type | Validates | Verdict | Tags |', '| # | Idea | Name | Type | Verdict | Tags |'), 'spike-manifest-scoping', /Spikes` table header must include an Idea column/],
        ['the Verdict column gone from the Spikes table', 'gsd-core/workflows/spike.md', swap('| # | Idea | Name | Type | Validates | Verdict | Tags |', '| # | Idea | Name | Type | Validates | Tags |'), 'spike-manifest-scoping', /Spikes` table header must include an Idea column/],
        ['the Tags column gone from the Spikes table', 'gsd-core/workflows/spike.md', swap('| # | Idea | Name | Type | Validates | Verdict | Tags |', '| # | Idea | Name | Type | Validates | Verdict |'), 'spike-manifest-scoping', /Spikes` table header must include an Idea column/],
        ['the first column of the Spikes table no longer the number', 'gsd-core/workflows/spike.md', swap('| # | Idea | Name | Type | Validates | Verdict | Tags |', '| Idea | # | Name | Type | Validates | Verdict | Tags |'), 'spike-manifest-scoping', /Spikes` table header must include an Idea column/],
        ['the Spikes table header with a differently cased Idea column', 'gsd-core/workflows/spike.md', swap('| # | Idea | Name | Type | Validates | Verdict | Tags |', '| # | idea | Name | Type | Validates | Verdict | Tags |'), 'spike-manifest-scoping', /Spikes` table header must include an Idea column/],
        ['the idea field gone from the README frontmatter template', 'gsd-core/workflows/spike.md', swap('idea: {idea-key}\n', ''), 'spike-manifest-scoping', /README frontmatter template must record the owning idea key/],
        ['the idea field moved away from the spike field', 'gsd-core/workflows/spike.md', swap('spike: NNN\nidea: {idea-key}', 'spike: NNN\n\nidea: {idea-key}'), 'spike-manifest-scoping', /README frontmatter template must record the owning idea key/],
        ['trailing blanks after the spike number', 'gsd-core/workflows/spike.md', swap('spike: NNN\nidea: {idea-key}', 'spike: NNN \nidea: {idea-key}'), 'spike-manifest-scoping', /README frontmatter template must record the owning idea key/],
        ['the idea field without a key placeholder', 'gsd-core/workflows/spike.md', swap('idea: {idea-key}', 'idea: key'), 'spike-manifest-scoping', /README frontmatter template must record the owning idea key/],
        ['"current idea\'s" gone from the reground step', 'gsd-core/workflows/spike.md', erase(/current idea's/gi), 'spike-manifest-scoping', /reground must scope its established-requirements check to the idea being spiked/],
        ['"every idea section" gone from frontier mode', 'gsd-core/workflows/spike.md', erase(/every idea section/gi), 'spike-manifest-scoping', /frontier mode's MANIFEST\.md load step must read every idea's scoped section/],
        ['the success criterion gone from spike.md', 'gsd-core/workflows/spike.md', eraseAll('scoped to the idea key'), 'spike-manifest-scoping', /success criteria must call out that Requirements are tracked per idea key/],
        ['the success criterion in capitals', 'gsd-core/workflows/spike.md', swap('scoped to the idea key', 'SCOPED TO THE IDEA KEY'), 'spike-manifest-scoping', /success criteria must call out that Requirements are tracked per idea key/],
        ['"idea key" gone from spike-wrap-up.md', 'gsd-core/workflows/spike-wrap-up.md', erase(/idea key/gi), 'spike-manifest-scoping', /spike-wrap-up\.md must resolve an idea key per spike/],
        ['the synthesize scoping sentence gone', 'gsd-core/workflows/spike-wrap-up.md', eraseAll('ONLY from the Requirements list of the idea key'), 'spike-manifest-scoping', /synthesize step must pull Requirements only from the idea key/],
        ['the synthesize scoping sentence in lower case', 'gsd-core/workflows/spike-wrap-up.md', swap('ONLY from the Requirements list of the idea key', 'only from the Requirements list of the idea key'), 'spike-manifest-scoping', /synthesize step must pull Requirements only from the idea key/],
        ['the no-leak rule gone', 'gsd-core/workflows/spike-wrap-up.md', eraseAll('ever include a requirement from an idea key that has no spike in this group'), 'spike-manifest-scoping', /synthesize step must forbid leaking an unrelated idea's requirement/],
        ['the no-leak rule without "has no spike"', 'gsd-core/workflows/spike-wrap-up.md', swap('that has no spike in this group', 'in this group'), 'spike-manifest-scoping', /synthesize step must forbid leaking an unrelated idea's requirement/],
        ['"never the whole MANIFEST.md" gone', 'gsd-core/workflows/spike-wrap-up.md', swap('never the whole MANIFEST.md', 'the whole MANIFEST.md'), 'spike-manifest-scoping', /write_skill requirements block must be built from only the wrapped idea keys/],
        ['"never the whole MANIFEST.md" with another character for the dot', 'gsd-core/workflows/spike-wrap-up.md', swap('never the whole MANIFEST.md', 'never the whole MANIFESTxmd'), 'spike-manifest-scoping', /write_skill requirements block must be built from only the wrapped idea keys/],
        ['the blending rule gone from the success criteria', 'gsd-core/workflows/spike-wrap-up.md', eraseAll('never blended with an unrelated idea'), 'spike-manifest-scoping', /success criteria must forbid blending requirements across idea keys/],
        ['the per-spike label back on MANIFEST.md', 'gsd-core/references/artifact-types.md', append('- MANIFEST.md (per-spike index)'), 'spike-manifest-scoping', /must not describe the project-level MANIFEST\.md as "per-spike"/],
        ['the per-project index label gone', 'gsd-core/references/artifact-types.md', swap('MANIFEST.md (per-project index', 'MANIFEST.md (index'), 'spike-manifest-scoping', /label MANIFEST\.md as the per-project durable index/],
        ['the legacy colon form changed', 'gsd-core/references/artifact-types.md', swap('via /gsd:spike', 'via /gsd-spike'), 'spike-manifest-scoping', /legacy \/gsd:spike colon form is outside this fix \(#2903\) and must stay/],
        ['the per-idea sections gone from sketch.md', 'gsd-core/workflows/sketch.md', swap('separate `### {idea-key}` sections', 'one flat section'), 'spike-manifest-scoping', /sketch\.md must read the per-idea requirement sections/],
        // seed-scan-new-milestone
        ['the seeds directory gone from new-milestone', 'gsd-core/workflows/new-milestone.md', eraseAll('.planning/seeds/'), 'seed-scan-new-milestone', /must contain instructions about scanning \.planning\/seeds\//],
        ['the SEED-*.md pattern gone from new-milestone', 'gsd-core/workflows/new-milestone.md', eraseAll('SEED-*.md'), 'seed-scan-new-milestone', /must reference the SEED-\*\.md file pattern/],
        ['the no-seeds condition gone from new-milestone', 'gsd-core/workflows/new-milestone.md', erase(/no seed files exist/gi), 'seed-scan-new-milestone', /must mention skipping when no seed files exist/],
        ['the skip instruction gone from new-milestone', 'gsd-core/workflows/new-milestone.md', erase(/skip/gi), 'seed-scan-new-milestone', /must mention skipping when no seed files exist/],
        ['the skip instruction moved to the next line', 'gsd-core/workflows/new-milestone.md', swap('**If no seed files exist:** Skip', '**If no seed files exist:**\nSkip'), 'seed-scan-new-milestone', /must mention skipping when no seed files exist/],
        ['the skip instruction moved past a carriage return', 'gsd-core/workflows/new-milestone.md', swap('**If no seed files exist:** Skip', '**If no seed files exist:**\rSkip'), 'seed-scan-new-milestone', /must mention skipping when no seed files exist/],
        ['the skip instruction moved past a line separator', 'gsd-core/workflows/new-milestone.md', swap('**If no seed files exist:** Skip', '**If no seed files exist:**\u2028Skip'), 'seed-scan-new-milestone', /must mention skipping when no seed files exist/],
        ['the skip instruction moved past a paragraph separator', 'gsd-core/workflows/new-milestone.md', swap('**If no seed files exist:** Skip', '**If no seed files exist:**\u2029Skip'), 'seed-scan-new-milestone', /must mention skipping when no seed files exist/],
        ['the skip instruction written before the condition', 'gsd-core/workflows/new-milestone.md', swap('**If no seed files exist:** Skip this step silently', '**Skip this step silently if no seed files exist:**'), 'seed-scan-new-milestone', /must mention skipping when no seed files exist/],
        ['--auto gone from new-milestone', 'gsd-core/workflows/new-milestone.md', eraseAll('--auto'), 'seed-scan-new-milestone', /must mention --auto mode in the seed scanning step/],
        ['the auto-selection rule without "select"', 'gsd-core/workflows/new-milestone.md', swap('Auto-select ALL matching seeds', 'Auto-pick ALL matching seeds'), 'seed-scan-new-milestone', /must instruct auto-selecting all matching seeds in --auto mode/],
        ['the auto-selection rule without "all"', 'gsd-core/workflows/new-milestone.md', swap('Auto-select ALL matching seeds', 'Auto-select matching seeds'), 'seed-scan-new-milestone', /must instruct auto-selecting all matching seeds in --auto mode/],
        ['the auto-selection rule without any "matching"', 'gsd-core/workflows/new-milestone.md', erase(/matching/gi), 'seed-scan-new-milestone', /must instruct auto-selecting all matching seeds in --auto mode/],
        ['the auto-selection rule broken across lines', 'gsd-core/workflows/new-milestone.md', swap('Auto-select ALL matching seeds', 'Auto-select ALL\nmatching seeds'), 'seed-scan-new-milestone', /must instruct auto-selecting all matching seeds in --auto mode/],
        ['the auto-selection rule reordered', 'gsd-core/workflows/new-milestone.md', swap('Auto-select ALL matching seeds', 'matching seeds ALL Auto-select'), 'seed-scan-new-milestone', /must instruct auto-selecting all matching seeds in --auto mode/],
        ['new-milestone gone from plant-seed', 'gsd-core/workflows/plant-seed.md', eraseAll('new-milestone'), 'seed-scan-new-milestone', /must reference new-milestone as the surfacing mechanism for seeds/],
        ['the auto-surfacing promise gone from plant-seed', 'gsd-core/workflows/plant-seed.md', (text) => text.replace(/auto.surface/gi, 'x').replace(/auto.present/gi, 'x'), 'seed-scan-new-milestone', /must describe seeds as auto-surfacing or auto-presenting/],
        ['the write-seed step renamed with an underscore', 'gsd-core/workflows/plant-seed.md', swap('<step name="write-seed"', '<step name="write_seed"'), 'seed-scan-new-milestone', /must contain a <step name="write-seed"> \(hyphens, not underscores\)/],
        ['the write-seed step gone', 'gsd-core/workflows/plant-seed.md', swap('<step name="write-seed"', '<step name="save-seed"'), 'seed-scan-new-milestone', /must contain a <step name="write-seed"> \(hyphens, not underscores\)/],
        ['a Trigger question before the write-seed step', 'gsd-core/workflows/plant-seed.md', swap('<step name="parse-idea">', 'header: "Trigger"\n<step name="parse-idea">'), 'seed-scan-new-milestone', /write-seed \(offset \d+\) must precede the Trigger question/],
        ['a Why question before the write-seed step', 'gsd-core/workflows/plant-seed.md', swap('<step name="parse-idea">', 'header: "Why"\n<step name="parse-idea">'), 'seed-scan-new-milestone', /write-seed \(offset \d+\) must precede the Why question/],
        ['a Scope question before the write-seed step', 'gsd-core/workflows/plant-seed.md', swap('<step name="parse-idea">', 'header: "Scope"\n<step name="parse-idea">'), 'seed-scan-new-milestone', /write-seed \(offset \d+\) must precede the Scope question/],
        ['every trigger_when default gone from plant-seed', 'gsd-core/workflows/plant-seed.md', erase(/default|when relevant|when scope matches|unspecified/gi), 'seed-scan-new-milestone', /must document a default for trigger_when when the user provides no Trigger/],
        ['the trigger_when default stated across two lines', 'gsd-core/workflows/plant-seed.md', (text) => `${text.replace(/default|when relevant|when scope matches|unspecified/gi, '')}\ntrigger_when\ndefault\n`, 'seed-scan-new-milestone', /must document a default for trigger_when when the user provides no Trigger/],
        ['every scope default gone from plant-seed', 'gsd-core/workflows/plant-seed.md', erase(/default|unknown|unspecified/gi), 'seed-scan-new-milestone', /must document a default for scope when the user provides no Scope/],
        ['the scope default stated across two lines', 'gsd-core/workflows/plant-seed.md', (text) => `${text.replace(/default|unknown|unspecified/gi, '')}\nscope\ndefault\ndefault\nscope\n`, 'seed-scan-new-milestone', /must document a default for scope when the user provides no Scope/],
        ['an enrich step placed before the write-seed step', 'gsd-core/workflows/plant-seed.md', swap('<step name="parse-idea">', '<step name="enrich-seed">\n</step>\n<step name="parse-idea">'), 'seed-scan-new-milestone', /write-seed \(step index \d+\) must appear before gather\/enrich \(index \d+\)/],
        ['a gather-context step placed before the write-seed step', 'gsd-core/workflows/plant-seed.md', swap('<step name="parse-idea">', '<step name="gather-context">\n</step>\n<step name="parse-idea">'), 'seed-scan-new-milestone', /write-seed \(step index \d+\) must appear before gather\/enrich \(index \d+\)/],
        ['a gather_context step placed before the write-seed step', 'gsd-core/workflows/plant-seed.md', swap('<step name="parse-idea">', '<step name="gather_context">\n</step>\n<step name="parse-idea">'), 'seed-scan-new-milestone', /write-seed \(step index \d+\) must appear before gather\/enrich \(index \d+\)/],
        ['an enrich_seed step placed before the write-seed step', 'gsd-core/workflows/plant-seed.md', swap('<step name="parse-idea">', '<step name="enrich_seed">\n</step>\n<step name="parse-idea">'), 'seed-scan-new-milestone', /write-seed \(step index \d+\) must appear before gather\/enrich \(index \d+\)/],
        ['the optional enrichment path gone from plant-seed', 'gsd-core/workflows/plant-seed.md', (text) => text.replace(/enrich|gather.context|gather_context/gi, 'x').split('header: "Trigger"').join('header: "T"'), 'seed-scan-new-milestone', /must preserve an optional enrichment path/],
        // agent-required-reading-consistency
        ['an agent with the legacy opening tag', 'agents/gsd-verifier.md', append('<files_to_read>'), 'agent-required-reading-consistency', /gsd-verifier still has the legacy <files_to_read> opening tag: migrate/],
        ['an agent with the legacy closing tag', 'agents/gsd-verifier.md', append('</files_to_read>'), 'agent-required-reading-consistency', /gsd-verifier still has the legacy <\/files_to_read> closing tag: migrate/],
        ['an agent with the legacy tag in backticks', 'agents/gsd-verifier.md', append('Read the `<files_to_read>` block.'), 'agent-required-reading-consistency', /gsd-verifier still has the legacy <files_to_read> opening tag: migrate/],
        ['an agent that still names files_to_read as a bare word', 'agents/gsd-verifier.md', append('See files_to_read.'), 'agent-required-reading-consistency', /gsd-verifier still uses files_to_read: it must be migrated to required_reading/],
        ['an agent that moved to the legacy name only', 'agents/gsd-verifier.md', swap('required_reading', 'files_to_read'), 'agent-required-reading-consistency', /gsd-verifier has reading instructions but does not use required_reading/],
        ['the common-bug-patterns title gone', 'gsd-core/references/common-bug-patterns.md', swap('# Common Bug Patterns', '# Bug Patterns'), 'agent-required-reading-consistency', /must start with the "# Common Bug Patterns" title/],
        ['a blank line before the common-bug-patterns title', 'gsd-core/references/common-bug-patterns.md', (text) => `\n${text}`, 'agent-required-reading-consistency', /must start with the "# Common Bug Patterns" title/],
        ['the --- separator gone from common-bug-patterns', 'gsd-core/references/common-bug-patterns.md', eraseAll('---'), 'agent-required-reading-consistency', /must contain a --- separator after the intro/],
        ['no expected category left in common-bug-patterns', 'gsd-core/references/common-bug-patterns.md', erase(/off-by-one|null|async|state management|import|environment|data shape|string handling|file system|error handling/gi), 'agent-required-reading-consistency', /must name at least 5 of the 10 expected bug categories/],
        ['the <patterns> block gone from common-bug-patterns', 'gsd-core/references/common-bug-patterns.md', swap('<patterns>', '<patternz>'), 'agent-required-reading-consistency', /expected at least 5 pattern sections, got 0/],
        ['no bold bullet in any pattern section', 'gsd-core/references/common-bug-patterns.md', swap('\n- **', '\n- x'), 'agent-required-reading-consistency', /pattern section\(s\) with no "- \*\*" bullet item/],
        ['no bold bullet in the first pattern section', 'gsd-core/references/common-bug-patterns.md', within('## Null / Undefined Access', '## Off-by-One / Boundary', (section) => section.split('\n- **').join('\n- x')), 'agent-required-reading-consistency', /pattern section\(s\) with no "- \*\*" bullet item: Null \/ Undefined Access/],
        ['no bold bullet in the last pattern section', 'gsd-core/references/common-bug-patterns.md', within('## Scope / Closure', '</patterns>', (section) => section.split('\n- **').join('\n- x')), 'agent-required-reading-consistency', /pattern section\(s\) with no "- \*\*" bullet item: Scope \/ Closure/],
        ['the debugger no longer references common-bug-patterns', 'agents/gsd-debugger.md', eraseAll('common-bug-patterns.md'), 'agent-required-reading-consistency', /the debugger agent must reference common-bug-patterns\.md/],
        ['the debugger references common-bug-patterns outside the required_reading block', 'agents/gsd-debugger.md', (text) => `${within('<required_reading>', '</required_reading>', (block) => block.split('common-bug-patterns.md').join('x'))(text)}\ncommon-bug-patterns.md\n`, 'agent-required-reading-consistency', /common-bug-patterns\.md must be inside the <required_reading> block/],
        ['the debugger without a required_reading block', 'agents/gsd-debugger.md', swap('<required_reading>', '<required_readings>'), 'agent-required-reading-consistency', /marker "<required_reading>" not found/],
        ['a workflow with the legacy opening tag', 'gsd-core/workflows/new-milestone.md', append('<files_to_read>'), 'agent-required-reading-consistency', /gsd-core\/workflows\/new-milestone\.md still emits <files_to_read>: migrate/],
        ['a workflow with the legacy closing tag', 'gsd-core/workflows/new-milestone.md', append('</files_to_read>'), 'agent-required-reading-consistency', /gsd-core\/workflows\/new-milestone\.md still emits <\/files_to_read>: migrate/],
        ['a command with the legacy tag', 'commands/gsd/add-tests.md', append('<files_to_read>'), 'agent-required-reading-consistency', /commands\/gsd\/add-tests\.md still emits <files_to_read>: migrate/],
        ['a reference with the legacy tag', 'gsd-core/references/agent-skills-bootstrap.md', append('<files_to_read>'), 'agent-required-reading-consistency', /gsd-core\/references\/agent-skills-bootstrap\.md still emits <files_to_read>: migrate/],
        ['a template with the legacy tag', 'gsd-core/templates/DEBUG.md', append('<files_to_read>'), 'agent-required-reading-consistency', /gsd-core\/templates\/DEBUG\.md still emits <files_to_read>: migrate/],
        ['a capability fragment with the legacy tag', 'capabilities/live-dom-uat/fragments/execute-wave-post.md', append('<files_to_read>'), 'agent-required-reading-consistency', /capabilities\/live-dom-uat\/fragments\/execute-wave-post\.md still emits <files_to_read>: migrate/],
        // planner-decomposition
        ['the gap-closure pointer gone from the planner', 'agents/gsd-planner.md', eraseAll('planner-gap-closure.md'), 'planner-decomposition', /gsd-planner\.md must reference planner-gap-closure\.md/],
        ['the revision pointer gone from the planner', 'agents/gsd-planner.md', eraseAll('planner-revision.md'), 'planner-decomposition', /gsd-planner\.md must reference planner-revision\.md/],
        ['the reviews pointer gone from the planner', 'agents/gsd-planner.md', eraseAll('planner-reviews.md'), 'planner-decomposition', /gsd-planner\.md must reference planner-reviews\.md/],
        ['the retired gap-closure marker back in the planner', 'agents/gsd-planner.md', append('## GAP CLOSURE PLANS CREATED'), 'planner-decomposition', /gsd-planner\.md must not emit the retired gap-closure marker/],
        ['the fenced-code ban gone from the planner', 'agents/gsd-planner.md', eraseAll('NEVER place fenced code blocks (```) inside `<action>`'), 'planner-decomposition', /gsd-planner\.md must explicitly forbid fenced implementation code in <action>/],
        ['the fenced-code ban in lower case', 'agents/gsd-planner.md', swap('NEVER place fenced code blocks (```) inside `<action>`', 'never place fenced code blocks (```) inside `<action>`'), 'planner-decomposition', /gsd-planner\.md must explicitly forbid fenced implementation code in <action>/],
        ['the code-excerpt routing gone from the planner', 'agents/gsd-planner.md', eraseAll('Code excerpts belong in `<read_first>` source files or referenced context'), 'planner-decomposition', /gsd-planner\.md must route code excerpts to context and read-first material/],
        ['no gap-closure content left in planner-gap-closure.md', 'gsd-core/references/planner-gap-closure.md', erase(/gap_closure|gap closure|--gaps/gi), 'planner-decomposition', /planner-gap-closure\.md must contain gap closure mode content/],
        ['no revision content left in planner-revision.md', 'gsd-core/references/planner-revision.md', erase(/revision/gi), 'planner-decomposition', /planner-revision\.md must contain revision mode content/],
        ['revision in mixed case only', 'gsd-core/references/planner-revision.md', (text) => text.replace(/revision/gi, 'rEvIsIoN'), 'planner-decomposition', /planner-revision\.md must contain revision mode content/],
        ['no reviews content left in planner-reviews.md', 'gsd-core/references/planner-reviews.md', erase(/reviews/gi), 'planner-decomposition', /planner-reviews\.md must contain reviews mode content/],
        ['reviews in mixed case only', 'gsd-core/references/planner-reviews.md', (text) => text.replace(/reviews/gi, 'rEvIeWs'), 'planner-decomposition', /planner-reviews\.md must contain reviews mode content/],
        ['the retired marker back in planner-guidance', 'gsd-core/references/planner-guidance.md', append('## GAP CLOSURE PLANS CREATED'), 'planner-decomposition', /planner-guidance\.md must not emit the retired gap-closure marker/],
        ['the artifact return contract gone from planner-guidance', 'gsd-core/references/planner-guidance.md', eraseAll('gap_closure: true'), 'planner-decomposition', /planner-guidance\.md must document the artifact return contract/],
        ['the consumer route gone from planner-guidance', 'gsd-core/references/planner-guidance.md', eraseAll('--gaps-only'), 'planner-decomposition', /planner-guidance\.md must name the consumer route/],
        ['the verbatim-copy instruction back in deep_work_rules', 'gsd-core/workflows/plan-phase.md', within('<deep_work_rules>', '</deep_work_rules>', (block) => `${block}\ncopy them into the action verbatim\n`), 'planner-decomposition', /deep_work_rules must not tell planners to copy source material verbatim/],
        ['the action-alone instruction back in deep_work_rules', 'gsd-core/workflows/plan-phase.md', within('<deep_work_rules>', '</deep_work_rules>', (block) => `${block}\ncomplete the task from the action text alone\n`), 'planner-decomposition', /deep_work_rules must not make <action> self-sufficient/],
        ['the code-dump bound gone from deep_work_rules', 'gsd-core/workflows/plan-phase.md', swap('Do not include full file contents, fenced code blocks, or complete implementations in `<action>`', 'Include whatever helps in `<action>`'), 'planner-decomposition', /deep_work_rules must explicitly bound concrete values to avoid code dumping/],
        ['behavior assertions gone from deep_work_rules', 'gsd-core/workflows/plan-phase.md', within('<deep_work_rules>', '</deep_work_rules>', (block) => block.split('behavior assertion').join('check')), 'planner-decomposition', /acceptance criteria must allow behavior assertions, not just grep checks/],
        ['test commands gone from deep_work_rules', 'gsd-core/workflows/plan-phase.md', within('<deep_work_rules>', '</deep_work_rules>', (block) => block.split('test command').join('check')), 'planner-decomposition', /acceptance criteria must allow test-command assertions/],
        ['the deep_work_rules block opening renamed', 'gsd-core/workflows/plan-phase.md', swap('<deep_work_rules>', '<deep_work_ruless>'), 'planner-decomposition', /marker "<deep_work_rules>" not found/],
        ['the deep_work_rules block closing renamed', 'gsd-core/workflows/plan-phase.md', swap('</deep_work_rules>', '</deep_work_rulez>'), 'planner-decomposition', /closing marker "<\/deep_work_rules>" not found/],
        ['the quality gate narrowed back to grep checks', 'gsd-core/workflows/plan-phase.md', eraseAll('Every task has `<acceptance_criteria>` with behavior, test-command, CLI, or source assertions'), 'planner-decomposition', /the quality gate must not narrow acceptance criteria back to grep-only checks/],
        ['the quality gate without the no-dump rule', 'gsd-core/workflows/plan-phase.md', eraseAll('Every `<action>` contains concrete identifiers without fenced code blocks or full implementations'), 'planner-decomposition', /the quality gate must enforce concrete prose without implementation dumps/],
        // mempalace-capture-gate-default
        ['the capture skill without capture_artifacts === false', 'skills/gsd-mempalace-capture/SKILL.md', eraseAll('capture_artifacts === false'), 'mempalace-capture-gate-default', /skills\/gsd-mempalace-capture\/SKILL\.md must use capture_artifacts === false/],
        ['the capture command without capture_artifacts === false', 'commands/gsd/mempalace-capture.md', eraseAll('capture_artifacts === false'), 'mempalace-capture-gate-default', /commands\/gsd\/mempalace-capture\.md must use capture_artifacts === false/],
        ['the inverted capture_artifacts check back in the skill', 'skills/gsd-mempalace-capture/SKILL.md', append('or `config.mempalace.capture_artifacts !== true`'), 'mempalace-capture-gate-default', /skills\/gsd-mempalace-capture\/SKILL\.md must not use the inverted capture_artifacts !== true check/],
        ['the inverted capture_artifacts check back in the command', 'commands/gsd/mempalace-capture.md', append('or `config.mempalace.capture_artifacts !== true`'), 'mempalace-capture-gate-default', /commands\/gsd\/mempalace-capture\.md must not use the inverted capture_artifacts !== true check/],
        ['the capture skill without the mirror_kg === false gate', 'skills/gsd-mempalace-capture/SKILL.md', eraseAll('config.mempalace.mirror_kg === false'), 'mempalace-capture-gate-default', /skills\/gsd-mempalace-capture\/SKILL\.md must mirror KG facts unless config\.mempalace\.mirror_kg === false/],
        ['the capture command without the mirror_kg === false gate', 'commands/gsd/mempalace-capture.md', eraseAll('config.mempalace.mirror_kg === false'), 'mempalace-capture-gate-default', /commands\/gsd\/mempalace-capture\.md must mirror KG facts unless config\.mempalace\.mirror_kg === false/],
        ['mirror_kg gated on positive presence in the capture skill', 'skills/gsd-mempalace-capture/SKILL.md', append('Mirror when `config.mempalace.mirror_kg` is true.'), 'mempalace-capture-gate-default', /skills\/gsd-mempalace-capture\/SKILL\.md must not gate mirror_kg on positive presence/],
        ['mirror_kg gated on positive presence in the capture command', 'commands/gsd/mempalace-capture.md', append('Mirror when `config.mempalace.mirror_kg` is true.'), 'mempalace-capture-gate-default', /commands\/gsd\/mempalace-capture\.md must not gate mirror_kg on positive presence/],
        ['the capture master gate gone from the skill', 'skills/gsd-mempalace-capture/SKILL.md', eraseAll('config.mempalace.enabled !== true'), 'mempalace-capture-gate-default', /the capture master gate must keep treating an absent mempalace\.enabled as disabled/],
        ['the recall skill without the mirror_kg !== false gate', 'skills/gsd-mempalace-recall/SKILL.md', eraseAll('config.mempalace.mirror_kg !== false'), 'mempalace-capture-gate-default', /skills\/gsd-mempalace-recall\/SKILL\.md KG-facts step must gate on config\.mempalace\.mirror_kg !== false/],
        ['the recall command without the mirror_kg !== false gate', 'commands/gsd/mempalace-recall.md', eraseAll('config.mempalace.mirror_kg !== false'), 'mempalace-capture-gate-default', /commands\/gsd\/mempalace-recall\.md KG-facts step must gate on config\.mempalace\.mirror_kg !== false/],
        ['mirror_kg gated on positive presence in the recall skill', 'skills/gsd-mempalace-recall/SKILL.md', append('Query when `config.mempalace.mirror_kg` is true.'), 'mempalace-capture-gate-default', /skills\/gsd-mempalace-recall\/SKILL\.md must not gate mirror_kg on positive presence/],
        ['mirror_kg gated on positive presence in the recall command', 'commands/gsd/mempalace-recall.md', append('Query when `config.mempalace.mirror_kg` is true.'), 'mempalace-capture-gate-default', /commands\/gsd\/mempalace-recall\.md must not gate mirror_kg on positive presence/],
        ['the curator without the diary_journal gate', 'agents/gsd-mempalace-curator.md', eraseAll('mempalace.diary_journal !== false'), 'mempalace-capture-gate-default', /diary gate must run when mempalace\.diary_journal !== false/],
        ['the curator without the mirror_kg gate', 'agents/gsd-mempalace-curator.md', eraseAll('mempalace.mirror_kg !== false'), 'mempalace-capture-gate-default', /KG-mirror gate must run when mempalace\.mirror_kg !== false/],
        ['diary_journal gated on positive presence in the curator', 'agents/gsd-mempalace-curator.md', append('Write when `mempalace.diary_journal` is true.'), 'mempalace-capture-gate-default', /must not gate diary_journal on positive presence/],
        ['mirror_kg gated on positive presence in the curator', 'agents/gsd-mempalace-curator.md', append('Mirror when `mempalace.mirror_kg` is true.'), 'mempalace-capture-gate-default', /must not gate mirror_kg on positive presence/],
        ['the curator master gate gone', 'agents/gsd-mempalace-curator.md', eraseAll('mempalace.enabled !== true'), 'mempalace-capture-gate-default', /the curator master gate must keep treating an absent mempalace\.enabled as disabled/],
        ['the cross_project_tunnels positive gate gone', 'agents/gsd-mempalace-curator.md', eraseAll('mempalace.cross_project_tunnels` is true'), 'mempalace-capture-gate-default', /cross_project_tunnels \(default: false\) must keep its positive-presence gate/],
        ['another default-true key gated on positive presence in the capture skill', 'skills/gsd-mempalace-capture/SKILL.md', append('Run when `config.mempalace.recall_on_plan` is true.'), 'mempalace-capture-gate-default', /gates `mempalace\.recall_on_plan` on positive presence, but the registry declares default: true/],
        ['a default-true key gated on positive presence by its bare name in the curator', 'agents/gsd-mempalace-curator.md', append('Run when `mempalace.recall_on_discuss` is true.'), 'mempalace-capture-gate-default', /gates `mempalace\.recall_on_discuss` on positive presence, but the registry declares default: true/],
        ['capture_artifacts gated on positive presence by its bare name in the recall command', 'commands/gsd/mempalace-recall.md', append('Run when `mempalace.capture_artifacts` is true.'), 'mempalace-capture-gate-default', /gates `mempalace\.capture_artifacts` on positive presence, but the registry declares default: true/],
        ['"unless" back in front of the mirror_kg gate in the recall command', 'commands/gsd/mempalace-recall.md', swap('(when `config.mempalace.mirror_kg !== false`', '(unless `config.mempalace.mirror_kg !== false`'), 'mempalace-capture-gate-default', /introduces `config\.mempalace\.mirror_kg !== false` with "unless"/],
        ['"unless" back in front of the mirror_kg gate in the recall skill', 'skills/gsd-mempalace-recall/SKILL.md', swap('(when `config.mempalace.mirror_kg !== false`', '(unless `config.mempalace.mirror_kg !== false`'), 'mempalace-capture-gate-default', /introduces `config\.mempalace\.mirror_kg !== false` with "unless"/],
        ['"unless" back in front of the diary gate in the curator', 'agents/gsd-mempalace-curator.md', swap('(when `mempalace.diary_journal !== false`', '(unless `mempalace.diary_journal !== false`'), 'mempalace-capture-gate-default', /introduces `mempalace\.diary_journal !== false` with "unless"/],
        ['"unless" back in front of the KG gate in the curator', 'agents/gsd-mempalace-curator.md', swap('(when `mempalace.mirror_kg !== false`', '(unless `mempalace.mirror_kg !== false`'), 'mempalace-capture-gate-default', /introduces `mempalace\.mirror_kg !== false` with "unless"/],
        ['the unless double negative anywhere in the capture command', 'commands/gsd/mempalace-capture.md', append('Skip unless `config.x !== false`.'), 'mempalace-capture-gate-default', /commands\/gsd\/mempalace-capture\.md must not pair "unless" with a `!== false` predicate/],
        ['the unless double negative in the compact curator', 'agents/gsd-mempalace-curator.compact.md', append('Skip unless (`mempalace.x !== false`).'), 'mempalace-capture-gate-default', /agents\/gsd-mempalace-curator\.compact\.md must not pair "unless" with a `!== false` predicate/],
        ['a gate introduced by neither when nor only if', 'commands/gsd/mempalace-recall.md', swap('(when `config.mempalace.mirror_kg !== false`', '(if `config.mempalace.mirror_kg !== false`'), 'mempalace-capture-gate-default', /must introduce its `config\.mempalace\.mirror_kg !== false` gate with "when" or "only if" \(found: if\)/],
        ['a gate whose predicate is no longer in backticks', 'agents/gsd-mempalace-curator.md', swap('`mempalace.diary_journal !== false`', 'mempalace.diary_journal !== false'), 'mempalace-capture-gate-default', /must still carry the `mempalace\.diary_journal !== false` gate/],
        ['an unless gate added next to a when gate in the recall command', 'commands/gsd/mempalace-recall.md', append('Skip it (unless `config.mempalace.mirror_kg !== false`).'), 'mempalace-capture-gate-default', /introduces `config\.mempalace\.mirror_kg !== false` with "unless"/],
        ['the correct unless === false form gone from the capture skill', 'skills/gsd-mempalace-capture/SKILL.md', eraseAll('unless'), 'mempalace-capture-gate-default', /skills\/gsd-mempalace-capture\/SKILL\.md must keep its "unless `… === false`" gate/],
        ['the correct unless === false form gone from the capture command', 'commands/gsd/mempalace-capture.md', eraseAll('unless'), 'mempalace-capture-gate-default', /commands\/gsd\/mempalace-capture\.md must keep its "unless `… === false`" gate/],
        ['the correct unless === false form gone from the compact curator', 'agents/gsd-mempalace-curator.compact.md', eraseAll('unless'), 'mempalace-capture-gate-default', /agents\/gsd-mempalace-curator\.compact\.md must keep its "unless `… === false`" gate/],
        // verifier-coincidental-reliance
        ['the coincidental-reliance advisory gone from the verifier', 'agents/gsd-verifier.md', eraseAll('coincidental-reliance'), 'verifier-coincidental-reliance', /the verifier must define the coincidental-reliance advisory/],
        ['the undeclared-precondition trigger gone from the verifier', 'agents/gsd-verifier.md', eraseAll('undeclared-precondition'), 'verifier-coincidental-reliance', /the verifier must name the 'undeclared-precondition' trigger/],
        ['the incidental-ordering trigger gone from the verifier', 'agents/gsd-verifier.md', eraseAll('incidental-ordering'), 'verifier-coincidental-reliance', /the verifier must name the 'incidental-ordering' trigger/],
        ['the fixture-only trigger gone from the verifier', 'agents/gsd-verifier.md', eraseAll('fixture-only'), 'verifier-coincidental-reliance', /the verifier must name the 'fixture-only' trigger/],
        ['the VERIFIED scoping gone from the rule', 'agents/gsd-verifier.md', erase(/✓ VERIFIED truth/g), 'verifier-coincidental-reliance', /the advisory must apply only to truths that reached VERIFIED/],
        ['PRESENT_BEHAVIOR_UNVERIFIED gone from the rule', 'agents/gsd-verifier.md', erase(/PRESENT_BEHAVIOR_UNVERIFIED/g), 'verifier-coincidental-reliance', /must not double-report truths already routed to human verification \(PRESENT_BEHAVIOR_UNVERIFIED\)/],
        ['insufficient_spec gone from the rule', 'agents/gsd-verifier.md', erase(/insufficient_spec/g), 'verifier-coincidental-reliance', /must not double-report truths already routed to human verification \(insufficient_spec\)/],
        ['the override clause gone from the rule', 'agents/gsd-verifier.md', erase(/override/gi), 'verifier-coincidental-reliance', /an accepted override must not be re-flagged/],
        ['the do-not-flag list gone from the rule', 'agents/gsd-verifier.md', erase(/(do not flag|don't flag|never flag)/gi), 'verifier-coincidental-reliance', /the rule must carry a do-not-flag list bounding the false-positive surface/],
        ['enforced ordering gone from the do-not-flag list', 'agents/gsd-verifier.md', erase(/(enforce|await|explicit sequenc)/gi), 'verifier-coincidental-reliance', /the do-not-flag list must name code-established preconditions and enforced ordering/],
        ['defaults gone from the do-not-flag list', 'agents/gsd-verifier.md', erase(/default/gi), 'verifier-coincidental-reliance', /the do-not-flag list must name defaults/],
        ['honest-verifier gone from the rule', 'agents/gsd-verifier.md', erase(/honest-verifier/g), 'verifier-coincidental-reliance', /the rule must route on recorded evidence, citing honest-verifier/],
        ['the confidence clause gone from the rule', 'agents/gsd-verifier.md', erase(/confiden/gi), 'verifier-coincidental-reliance', /the rule must say it does not route on self-rated confidence/],
        ['the score clause gone from the rule', 'agents/gsd-verifier.md', erase(/score/gi), 'verifier-coincidental-reliance', /the rule must speak to the score/],
        ['the unchanged-score invariant gone from the rule', 'agents/gsd-verifier.md', erase(/(not the score|never the score|does not (change|affect) the score|no score)/gi), 'verifier-coincidental-reliance', /the advisory must not change the verified score/],
        ['the unchanged-status invariant gone from the rule', 'agents/gsd-verifier.md', erase(/(not the status|never the status|does not (change|affect) the status|status is unchanged)/gi), 'verifier-coincidental-reliance', /the advisory must not change the overall status/],
        ['the no-human-verification-item invariant gone from the rule', 'agents/gsd-verifier.md', erase(/never[^.]{0,80}human-verification item/gi), 'verifier-coincidental-reliance', /the advisory must never emit a human-verification item/],
        ['the only-excluded-state invariant gone', 'agents/gsd-verifier.md', eraseAll('PRESENT_BEHAVIOR_UNVERIFIED truths are the *only* ones excluded from `verified_truths`'), 'verifier-coincidental-reliance', /PRESENT_BEHAVIOR_UNVERIFIED must remain the only score-excluded truth state/],
        ['the advisory leaking into the status union', 'agents/gsd-verifier.md', swap('status: passed | gaps_found | human_needed', 'status: passed | gaps_found | human_needed | coincidental_reliance'), 'verifier-coincidental-reliance', /the per-truth advisory leaked into the status vocabulary: status: passed \| gaps_found \| human_needed \| coincidental_reliance/],
        ['a status gone from the union', 'agents/gsd-verifier.md', swap('status: passed | gaps_found | human_needed', 'status: passed | gaps_found'), 'verifier-coincidental-reliance', /the status union must still contain human_needed/],
        ['the status union gone', 'agents/gsd-verifier.md', swap('status: passed | gaps_found | human_needed', 'status: passed'), 'verifier-coincidental-reliance', /expected at least one status union line/],
        ['a union line ended by a capitalised word', 'agents/gsd-verifier.md', swap('status: passed | gaps_found | human_needed', 'status: passed | gaps_found | human_needed | Gaps'), 'verifier-coincidental-reliance', /expected at least one status union line/],
        ['a bare qualifier in a verifier verdict cell', 'agents/gsd-verifier.md', swap('| ✓ VERIFIED (coincidental-reliance) |', '| (coincidental-reliance) |'), 'verifier-coincidental-reliance', /a verdict cell must render as "✓ VERIFIED \(coincidental-reliance\)": \(coincidental-reliance\)/],
        ['the qualifier before VERIFIED in a verifier verdict cell', 'agents/gsd-verifier.md', swap('| ✓ VERIFIED (coincidental-reliance) |', '| (coincidental-reliance) ✓ VERIFIED |'), 'verifier-coincidental-reliance', /a verdict cell must render as "✓ VERIFIED \(coincidental-reliance\)": \(coincidental-reliance\) ✓ VERIFIED/],
        ['the suffixed verdict form never shown by the agent', 'agents/gsd-verifier.md', eraseAll('✓ VERIFIED (coincidental-reliance)'), 'verifier-coincidental-reliance', /the agent must show the suffixed verdict form at least once/],
        ['the items key gone from the agent', 'agents/gsd-verifier.md', eraseAll('coincidental_reliance_items'), 'verifier-coincidental-reliance', /the report frontmatter must carry coincidental_reliance_items/],
        ['the only-if convention gone from the items key line', 'agents/gsd-verifier.md', swap('coincidental_reliance_items: # Only if', 'coincidental_reliance_items: # Whenever'), 'verifier-coincidental-reliance', /the items list must be omitted when nothing is flagged/],
        ['the frontmatter key line without its comment marker', 'agents/gsd-verifier.md', swap('coincidental_reliance_items: #', 'coincidental_reliance_items:'), 'verifier-coincidental-reliance', /the frontmatter must carry the `coincidental_reliance_items: #` key line/],
        ['the truth field gone from the items shape', 'agents/gsd-verifier.md', erase(/truth:/g), 'verifier-coincidental-reliance', /an item must name the truth/],
        ['the reason field gone from the items shape', 'agents/gsd-verifier.md', erase(/reason:/g), 'verifier-coincidental-reliance', /an item must name the reason/],
        ['the hardening gone from the items shape', 'agents/gsd-verifier.md', erase(/(harden|fix|precondition)/gi), 'verifier-coincidental-reliance', /an item must name the hardening/],
        ['the survival rule gone from the items shape', 'agents/gsd-verifier.md', erase(/(regardless of (overall )?status|survive|never lost)/gi), 'verifier-coincidental-reliance', /the items must survive a gaps_found phase/],
        ['the items list gone from the template', 'gsd-core/templates/verification-report.md', eraseAll('coincidental_reliance_items'), 'verifier-coincidental-reliance', /the standalone template must carry the frontmatter items list/],
        ['the advisory token gone from the template', 'gsd-core/templates/verification-report.md', eraseAll('coincidental-reliance'), 'verifier-coincidental-reliance', /the standalone template must carry 'coincidental-reliance'/],
        ['the undeclared-precondition trigger gone from the template', 'gsd-core/templates/verification-report.md', eraseAll('undeclared-precondition'), 'verifier-coincidental-reliance', /the standalone template must carry 'undeclared-precondition'/],
        ['the incidental-ordering trigger gone from the template', 'gsd-core/templates/verification-report.md', eraseAll('incidental-ordering'), 'verifier-coincidental-reliance', /the standalone template must carry 'incidental-ordering'/],
        ['the fixture-only trigger gone from the template', 'gsd-core/templates/verification-report.md', eraseAll('fixture-only'), 'verifier-coincidental-reliance', /the standalone template must carry 'fixture-only'/],
        ['a bare qualifier in a template verdict cell', 'gsd-core/templates/verification-report.md', swap('| ✓ VERIFIED (coincidental-reliance) |', '| (coincidental-reliance) |'), 'verifier-coincidental-reliance', /a verdict cell must render as "✓ VERIFIED \(coincidental-reliance\)": \(coincidental-reliance\)/],
        ['the per-truth states marker gone from the template', 'gsd-core/templates/verification-report.md', swap('**Per-truth states', '**Per-truth rows'), 'verifier-coincidental-reliance', /marker "\*\*Per-truth states" not found/],
        ['the advisory gone from the template guidelines', 'gsd-core/templates/verification-report.md', (text) => { const at = text.indexOf('**Per-truth states'); return text.slice(0, at) + text.slice(at).split('coincidental-reliance').join('x'); }, 'verifier-coincidental-reliance', /the template guidelines must document the advisory per-truth state/],
        ['the imperative check gone from the template guidelines', 'gsd-core/templates/verification-report.md', swap('apply the reliance check to every `✓ VERIFIED` truth', 'apply it'), 'verifier-coincidental-reliance', /the template Guidelines must carry the imperative check, not just the row shape/],
        ['the template pointer gone from the verifier gate reference', 'gsd-core/references/verifier-phase-gates.md', swap('gsd-core/templates/verification-report.md', 'gsd-core/templates/other-report.md'), 'verifier-coincidental-reliance', /verifier-phase-gates\.md must point at the verification-report template/],
        ['a second copy of the rule in the verifier gate reference', 'gsd-core/references/verifier-phase-gates.md', append('The coincidental-reliance check applies.'), 'verifier-coincidental-reliance', /verifier-phase-gates\.md must not grow a second copy of the rule/],
        ['the advisory gone from docs/reference/agents.md', 'docs/reference/agents.md', eraseAll('coincidental-reliance'), 'verifier-coincidental-reliance', /docs\/reference\/agents\.md must document the coincidental-reliance advisory/],
        // execute-phase-step-5-5-deviation-doc
        ['the step 5.5 marker gone', 'gsd-core/workflows/execute-phase.md', swap('\n5.5. **Worktree cleanup', '\nStep 5.5 **Worktree cleanup'), 'execute-phase-step-5-5-deviation-doc', /marker "\\n5\.5\." not found/],
        ['the step 5.6 marker gone after step 5.5', 'gsd-core/workflows/execute-phase.md', swap('\n5.6. **Post-merge', '\n5.7. **Post-merge'), 'execute-phase-step-5-5-deviation-doc', /closing marker "\\n5\.6\." not found after "\\n5\.5\."/],
        ['the standard wave contract gone from step 5.5', 'gsd-core/workflows/execute-phase.md', within('\n5.5.', '\n5.6.', (block) => block.split('Standard wave contract').join('Normal wave rule')), 'execute-phase-step-5-5-deviation-doc', /step 5\.5 must name the standard wave contract explicitly/],
        ['the standard wave contract only after step 5.5', 'gsd-core/workflows/execute-phase.md', (text) => `${within('\n5.5.', '\n5.6.', (block) => block.split('Standard wave contract').join('Normal wave rule'))(text)}\nStandard wave contract\n`, 'execute-phase-step-5-5-deviation-doc', /step 5\.5 must name the standard wave contract explicitly/],
        ['the cross-wave deviation gone from step 5.5', 'gsd-core/workflows/execute-phase.md', within('\n5.5.', '\n5.6.', (block) => block.split('Cross-wave dependency deviation').join('Other deviation')), 'execute-phase-step-5-5-deviation-doc', /step 5\.5 must name the cross-wave dependency deviation as a supported mode/],
        ['git worktree prune gone from step 5.5', 'gsd-core/workflows/execute-phase.md', within('\n5.5.', '\n5.6.', (block) => block.split('git worktree prune').join('git gc')), 'execute-phase-step-5-5-deviation-doc', /the step 5\.5 cleanup-tail snippet must include git worktree prune/],
        ['git worktree remove gone from step 5.5', 'gsd-core/workflows/execute-phase.md', within('\n5.5.', '\n5.6.', (block) => block.split('git worktree remove').join('git worktree rm')), 'execute-phase-step-5-5-deviation-doc', /the step 5\.5 cleanup-tail snippet must include git worktree remove --force/],
        ['--force gone from step 5.5', 'gsd-core/workflows/execute-phase.md', within('\n5.5.', '\n5.6.', (block) => block.split('--force').join('-f')), 'execute-phase-step-5-5-deviation-doc', /the step 5\.5 cleanup-tail snippet must include git worktree remove --force/],
        ['git worktree unlock gone from step 5.5', 'gsd-core/workflows/execute-phase.md', within('\n5.5.', '\n5.6.', (block) => block.split('git worktree unlock').join('git worktree lock')), 'execute-phase-step-5-5-deviation-doc', /the step 5\.5 cleanup-tail snippet must include git worktree unlock/],
        ['git branch -D gone from step 5.5', 'gsd-core/workflows/execute-phase.md', within('\n5.5.', '\n5.6.', (block) => block.split('git branch -D').join('git branch -d')), 'execute-phase-step-5-5-deviation-doc', /the step 5\.5 cleanup-tail snippet must include git branch -D/],
        ['WAVE_WORKTREE_PLANS gone from step 5.5', 'gsd-core/workflows/execute-phase.md', within('\n5.5.', '\n5.6.', (block) => block.split('WAVE_WORKTREE_PLANS').join('WAVE_PLANS')), 'execute-phase-step-5-5-deviation-doc', /step 5\.5 must document the empty-WAVE_WORKTREE_PLANS skip condition/],
        ['cleanup-tail gone from step 5.5', 'gsd-core/workflows/execute-phase.md', within('\n5.5.', '\n5.6.', (block) => block.split('cleanup-tail').join('cleanup')), 'execute-phase-step-5-5-deviation-doc', /step 5\.5 must document the custom-merge-deviation skip condition with a pointer to the cleanup-tail/],
        ['WAVE_WORKTREE_MANIFEST gone from step 5.5', 'gsd-core/workflows/execute-phase.md', within('\n5.5.', '\n5.6.', (block) => block.split('WAVE_WORKTREE_MANIFEST').join('WAVE_MANIFEST')), 'execute-phase-step-5-5-deviation-doc', /the cleanup-tail must consume the current wave manifest/],
        ['the manifest-scope reason gone from step 5.5', 'gsd-core/workflows/execute-phase.md', within('\n5.5.', '\n5.6.', (block) => block.split('avoid touching unrelated active agents').join('be careful')), 'execute-phase-step-5-5-deviation-doc', /the cleanup-tail must document why manifest-scoped cleanup is required/],
        ['the line-by-line manifest read gone from step 5.5', 'gsd-core/workflows/execute-phase.md', within('\n5.5.', '\n5.6.', (block) => block.split('IFS= read -r').join('read')), 'execute-phase-step-5-5-deviation-doc', /the cleanup-tail must still read manifest paths line by line/],
        ['global agent worktree discovery in the cleanup-tail', 'gsd-core/workflows/execute-phase.md', within('\n5.5.', '\n5.6.', (block) => `${block}\ngit worktree list --porcelain | grep '.claude/worktrees/agent-'\n`), 'execute-phase-step-5-5-deviation-doc', /the cleanup-tail must not parse global git worktree list output for agent worktrees/],
        ['global agent worktree discovery spread over many lines', 'gsd-core/workflows/execute-phase.md', within('\n5.5.', '\n5.6.', (block) => `${block}\ngit worktree list --porcelain\n${'filler line\n'.repeat(500)}.claude/worktrees/agent-x\n`), 'execute-phase-step-5-5-deviation-doc', /the cleanup-tail must not parse global git worktree list output for agent worktrees/],
        ['the human_needed branch gone', 'gsd-core/workflows/execute-phase.md', eraseAll('human_needed'), 'execute-phase-step-5-5-deviation-doc', /execute-phase\.md must contain a human_needed branch/],
        ['the approved shortcut back in the workflow', 'gsd-core/workflows/execute-phase.md', append('Reply "approved" → continue to advance.'), 'execute-phase-step-5-5-deviation-doc', /the human_needed branch must not offer "approved" → continue/],
        ['the gaps_found section ahead of the human_needed section', 'gsd-core/workflows/execute-phase.md', (text) => `**If gaps_found:**\n${text}`, 'execute-phase-step-5-5-deviation-doc', /the human_needed section must appear before the gaps_found section/],
        ['the gaps_found section marker gone', 'gsd-core/workflows/execute-phase.md', eraseAll('**If gaps_found:**'), 'execute-phase-step-5-5-deviation-doc', /closing marker "\*\*If gaps_found:\*\*" not found after "\*\*If human_needed:\*\*"/],
        ['update_roadmap reachable from the human_needed branch', 'gsd-core/workflows/execute-phase.md', within('**If human_needed:**', '**If gaps_found:**', (section) => `${section}\nThen update_roadmap.\n`), 'execute-phase-step-5-5-deviation-doc', /update_roadmap must not be reachable directly from the human_needed branch/],
        ['verify-work gone from the human_needed branch', 'gsd-core/workflows/execute-phase.md', within('**If human_needed:**', '**If gaps_found:**', (section) => section.split('verify-work').join('verification')), 'execute-phase-step-5-5-deviation-doc', /the human_needed branch must direct the user to \/gsd:verify-work/],
        ['the UAT file name gone from the human_needed branch', 'gsd-core/workflows/execute-phase.md', within('**If human_needed:**', '**If gaps_found:**', (section) => section.split('-UAT.md').join('.md')), 'execute-phase-step-5-5-deviation-doc', /the human_needed branch must create a \{phase_num\}-UAT\.md file/],
        ['HUMAN-UAT.md back in the human_needed branch', 'gsd-core/workflows/execute-phase.md', within('**If human_needed:**', '**If gaps_found:**', (section) => `${section}\nWrite {phase_num}-HUMAN-UAT.md.\n`), 'execute-phase-step-5-5-deviation-doc', /the human_needed branch must not create HUMAN-UAT\.md/],
    // ultraplan-phase
    ['the command name changed', 'commands/gsd/ultraplan-phase.md', swap('name: gsd:ultraplan-phase', 'name: gsd:ultraplan'), 'ultraplan-phase', /the command must have name: gsd:ultraplan-phase/],
    ['BETA gone from the command description', 'commands/gsd/ultraplan-phase.md', swap('[BETA]', '[ALPHA]'), 'ultraplan-phase', /the description must mark the feature as BETA/],
    ['the argument-hint gone', 'commands/gsd/ultraplan-phase.md', erase(/^argument-hint:[^\n]*\n/m), 'ultraplan-phase', /the command must have an argument-hint/],
    ['the workflow reference gone from the command', 'commands/gsd/ultraplan-phase.md', swap('@~/.claude/gsd-core/workflows/ultraplan-phase.md', '@~/.claude/gsd-core/workflows/other.md'), 'ultraplan-phase', /the command must reference the ultraplan-phase workflow/],
    ['ui-brand gone from the command', 'commands/gsd/ultraplan-phase.md', eraseAll('ui-brand'), 'ultraplan-phase', /the command must reference ui-brand/],
    ['BETA gone from the workflow', 'gsd-core/workflows/ultraplan-phase.md', eraseAll('BETA'), 'ultraplan-phase', /the workflow must display a BETA warning/],
    ['research preview gone from the workflow', 'gsd-core/workflows/ultraplan-phase.md', eraseAll('research preview'), 'ultraplan-phase', /the workflow must note ultraplan is in research preview/],
    ['both runtime marker variables gone', 'gsd-core/workflows/ultraplan-phase.md', (text) => text.split('CLAUDE_CODE_ENTRYPOINT').join('OTHER').split('CLAUDECODE').join('OTHER'), 'ultraplan-phase', /the workflow must gate on a Claude Code runtime marker variable/],
    ['a gate on CLAUDE_CODE_VERSION added', 'gsd-core/workflows/ultraplan-phase.md', append('if [ -n "$CLAUDE_CODE_VERSION" ]; then'), 'ultraplan-phase', /the workflow must not gate on CLAUDE_CODE_VERSION/],
    ['the local plan-phase alternative gone', 'gsd-core/workflows/ultraplan-phase.md', swap('gsd:plan-phase', 'gsd:plan'), 'ultraplan-phase', /the error message must direct users to \/gsd-plan-phase as the local alternative/],
    ['gsd_run query init.plan-phase gone', 'gsd-core/workflows/ultraplan-phase.md', swap('gsd_run query init.plan-phase', 'query init.plan-phase'), 'ultraplan-phase', /the workflow must load phase context through gsd_run query init\.plan-phase/],
    ['the new-project route gone', 'gsd-core/workflows/ultraplan-phase.md', swap('gsd:new-project', 'gsd:np'), 'ultraplan-phase', /the workflow must direct the user to \/gsd-new-project when \.planning is missing/],
    ['the ROADMAP phase scope heading gone', 'gsd-core/workflows/ultraplan-phase.md', swap('## Phase Scope (from ROADMAP.md)', '## Phase Scope'), 'ultraplan-phase', /the ultraplan prompt must include the phase scope from ROADMAP\.md/],
    ['REQUIREMENTS gone from the workflow', 'gsd-core/workflows/ultraplan-phase.md', eraseAll('REQUIREMENTS'), 'ultraplan-phase', /the ultraplan prompt must include the requirements context/],
    ['RESEARCH.md gone from the workflow', 'gsd-core/workflows/ultraplan-phase.md', eraseAll('RESEARCH.md'), 'ultraplan-phase', /the ultraplan prompt must include the existing research/],
    ['the /ultraplan trigger gone', 'gsd-core/workflows/ultraplan-phase.md', swap('/ultraplan', 'ultraplan'), 'ultraplan-phase', /the workflow must trigger \/ultraplan/],
    ['Cancel gone from the workflow', 'gsd-core/workflows/ultraplan-phase.md', eraseAll('Cancel'), 'ultraplan-phase', /the workflow must tell the user to choose Cancel to save the plan to a file/],
    ['the import command gone from the workflow', 'gsd-core/workflows/ultraplan-phase.md', swap('gsd:import', 'gsd:imp'), 'ultraplan-phase', /the workflow must direct the user to run \/gsd-import --from after ultraplan completes/],
    ['--from gone from the workflow', 'gsd-core/workflows/ultraplan-phase.md', eraseAll('--from'), 'ultraplan-phase', /the workflow must reference \/gsd-import --from <file-path>/],
    ['the /ultraplan trigger placed before the import command', 'gsd-core/workflows/ultraplan-phase.md', (text) => `/ultraplan first\n${text}`, 'ultraplan-phase', /the import command first appears after the \/ultraplan trigger/],
    ['write PLAN.md added', 'gsd-core/workflows/ultraplan-phase.md', append('Then write PLAN.md for the phase.'), 'ultraplan-phase', /the workflow must not directly write PLAN\.md/],
    ["a Write('.planning call added", 'gsd-core/workflows/ultraplan-phase.md', append("Write('.planning/phase/PLAN.md')"), 'ultraplan-phase', /the workflow must not write \.planning files directly/],
    ['ultrareview mentioned', 'gsd-core/workflows/ultraplan-phase.md', append('Use ultrareview afterwards.'), 'ultraplan-phase', /the workflow must not reference ultrareview/],
    // verify-mvp-uat
    ['phase.mvp-mode gone from the host', 'gsd-core/workflows/verify-work.md', swap('phase.mvp-mode', 'phase.mode'), 'verify-mvp-uat', /the workflow must resolve MVP mode via the centralized phase\.mvp-mode verb/],
    ['the verify-mvp-mode.md reference gone', 'gsd-core/workflows/verify-work/steps/mvp-uat-framing.md', swap('verify-mvp-mode.md', 'verify-other.md'), 'verify-mvp-uat', /the workflow must reference the UAT framing file verify-mvp-mode\.md/],
    ['the standard UAT fallback gone', 'gsd-core/workflows/verify-work.md', swap('fall back to the standard UAT generation path', 'proceed'), 'verify-mvp-uat', /the workflow must specify the standard UAT fallback when the mode is not mvp/],
    ['the user-flow-first ordering words gone', 'gsd-core/workflows/verify-work/steps/mvp-uat-framing.md', (text) => text.replace(/first|before|precede/gi, 'xx'), 'verify-mvp-uat', /the workflow must specify user-flow-first ordering/],
    ['the technical-checks deferral words gone', 'gsd-core/workflows/verify-work/steps/mvp-uat-framing.md', (text) => text.replace(/defer|after|second/gi, 'xx'), 'verify-mvp-uat', /the workflow must defer technical checks under MVP mode/],
    ['the infrastructure/foundation scoping gone', 'gsd-core/references/verifier-phase-gates.md', swap('infrastructure/foundation phase', 'infrastructure phase'), 'verify-mvp-uat', /the identify_human_verification step must explicitly handle infrastructure\/foundation phases/],
    ['auto-pass UAT gone', 'gsd-core/references/verifier-phase-gates.md', swap('auto-pass UAT', 'pass UAT'), 'verify-mvp-uat', /the identify_human_verification step must contain language about auto-passing UAT/],
    ['the prohibition on inventing manual steps gone', 'gsd-core/references/verifier-phase-gates.md', swap('Do NOT invent artificial manual steps', 'Prefer fewer manual steps'), 'verify-mvp-uat', /the identify_human_verification step must explicitly prohibit inventing artificial manual UAT steps/],
    ['the N/A state gone', 'gsd-core/references/verifier-phase-gates.md', swap('Mark human verification as **N/A**', 'Mark human verification as skipped'), 'verify-mvp-uat', /the identify_human_verification step must include a not-applicable UAT state/],
    ['the identify_human_verification section marker gone', 'gsd-core/references/verifier-phase-gates.md', swap('identify_human_verification', 'identify_verification'), 'verify-mvp-uat', /marker "identify_human_verification" not found/],
    ['auto-pass UAT moved out of the section', 'gsd-core/references/verifier-phase-gates.md', (text) => `${text.split('auto-pass UAT').join('xx')}\nauto-pass UAT\n`, 'verify-mvp-uat', /the identify_human_verification step must contain language about auto-passing UAT/],
    ['the identify_human_verification section unterminated', 'gsd-core/references/verifier-phase-gates.md', (text) => text.slice(0, text.indexOf('\n## ', text.indexOf('identify_human_verification'))), 'verify-mvp-uat', /closing marker "\\n## " not found after "identify_human_verification"/],
    // workflow-jq-dependency
    ['the ship.md status read renamed', 'gsd-core/workflows/ship.md', swap('STATUS=$(gsd_run query verification.status', 'STATUS=$(gsd_run query verification.stat'), 'workflow-jq-dependency', /ship\.md must read verification\.status --pick status/],
    ['a fourth verification.status pick added to ship.md', 'gsd-core/workflows/ship.md', append('X=$(gsd_run query verification.status "${PHASE_DIR}" --pick status)'), 'workflow-jq-dependency', /ship\.md should read status once plus the two message fields, found 4/],
    ['a verification.status pick of ship.md gone', 'gsd-core/workflows/ship.md', swap('gsd_run query verification.status "${PHASE_DIR}" --pick next_command', 'echo none'), 'workflow-jq-dependency', /ship\.md should read status once plus the two message fields, found 2/],
    ['the block decision placed before the status read in ship.md', 'gsd-core/workflows/ship.md', (text) => `PHASE_VERIFICATION_INCOMPLETE\n${text}`, 'workflow-jq-dependency', /the block decision must follow the status read/],
    ['next_action read before the gate decides in ship.md', 'gsd-core/workflows/ship.md', (text) => `--pick next_action\n${text}`, 'workflow-jq-dependency', /next_action must be read only on the blocking path/],
    ['next_command no longer surfaced by ship.md', 'gsd-core/workflows/ship.md', swap('--pick next_command', '--pick nc'), 'workflow-jq-dependency', /ship\.md must still surface next_command/],
    ['the jq probe gone from review.md', 'gsd-core/workflows/review.md', swap('command -v jq >/dev/null 2>&1 && echo "jq:available" || echo "jq:missing"', 'true'), 'workflow-jq-dependency', /review\.md detect_clis must probe jq alongside the other reviewer prerequisites/],
    ['the jq-dependent lanes declaration gone from review.md', 'gsd-core/workflows/review.md', swap('jq-dependent reviewer lanes', 'jq reviewers'), 'workflow-jq-dependency', /review\.md must declare the jq-dependent reviewer lanes/],
    ['ollama gone from review.md', 'gsd-core/workflows/review.md', swap('ollama', 'xx'), 'workflow-jq-dependency', /review\.md must name ollama as a jq-dependent lane/],
    ['lm_studio gone from review.md', 'gsd-core/workflows/review.md', swap('lm_studio', 'xx'), 'workflow-jq-dependency', /review\.md must name lm_studio as a jq-dependent lane/],
    ['llama_cpp gone from review.md', 'gsd-core/workflows/review.md', swap('llama_cpp', 'xx'), 'workflow-jq-dependency', /review\.md must name llama_cpp as a jq-dependent lane/],
    ['opencode named only before the declaration in review.md', 'gsd-core/workflows/review.md', (text) => `opencode\n${text.split('opencode').join('xx')}`, 'workflow-jq-dependency', /review\.md must name opencode as a jq-dependent lane/],
    ['antigravity only part of a longer word in review.md', 'gsd-core/workflows/review.md', swap('antigravity', 'antigravityx'), 'workflow-jq-dependency', /review\.md must name antigravity as a jq-dependent lane/],
    ['a line-number citation of review.md in plan-phase.md', 'gsd-core/workflows/plan-phase.md', append('See review.md:244 for the prerequisite.'), 'workflow-jq-dependency', /plan-phase\.md must cite review\.md by section name, not a line number/],
    ['a line-number citation of review.md in review.md itself', 'gsd-core/workflows/review.md', append('See review.md:7.'), 'workflow-jq-dependency', /review\.md must cite review\.md by section name, not a line number/],
    ['installedVersion no longer resolved by update.md', 'gsd-core/workflows/update.md', swap('uc_field installedVersion', 'uc_field x'), 'workflow-jq-dependency', /update\.md must still resolve installedVersion from the update-context projection/],
    ['scope no longer resolved by update.md', 'gsd-core/workflows/update.md', swap('uc_field scope', 'uc_field x'), 'workflow-jq-dependency', /update\.md must still resolve scope from the update-context projection/],
    ['runtime no longer resolved by update.md', 'gsd-core/workflows/update.md', swap('uc_field runtime', 'uc_field x'), 'workflow-jq-dependency', /update\.md must still resolve runtime from the update-context projection/],
    ['gsdDir no longer resolved by update.md', 'gsd-core/workflows/update.md', swap('uc_field gsdDir', 'uc_field x'), 'workflow-jq-dependency', /update\.md must still resolve gsdDir from the update-context projection/],
    ['scope only part of a longer word in update.md', 'gsd-core/workflows/update.md', swap('uc_field scope', 'uc_field scopes'), 'workflow-jq-dependency', /update\.md must still resolve scope from the update-context projection/],
    // verification-overrides
    ['the Override Format heading gone', 'gsd-core/references/verification-overrides.md', swap('## Override Format', '## Format'), 'verification-overrides', /the reference should contain an "Override Format" section/],
    ['the Matching Rules heading gone', 'gsd-core/references/verification-overrides.md', swap('## Matching Rules', '## Matching'), 'verification-overrides', /the reference should contain a "Matching Rules" section/],
    ['the Verifier Behavior heading gone', 'gsd-core/references/verification-overrides.md', swap('## Verifier Behavior', '## Behavior'), 'verification-overrides', /the reference should contain a "Verifier Behavior" section/],
    ['the overrides block gone', 'gsd-core/references/verification-overrides.md', eraseAll('overrides:'), 'verification-overrides', /the reference should document the YAML frontmatter overrides block/],
    ['the must_have field gone', 'gsd-core/references/verification-overrides.md', eraseAll('must_have:'), 'verification-overrides', /the reference should document the must_have field of an override/],
    ['the reason field gone', 'gsd-core/references/verification-overrides.md', eraseAll('reason:'), 'verification-overrides', /the reference should document the reason field of an override/],
    ['an indented criterion field added', 'gsd-core/references/verification-overrides.md', append('overrides:\n  criterion: "x"'), 'verification-overrides', /the reference should use the must_have field, not a criterion field/],
    ['a tab-indented criterion field added', 'gsd-core/references/verification-overrides.md', append('\tcriterion: x'), 'verification-overrides', /the reference should use the must_have field, not a criterion field/],
    ['accepted_by gone', 'gsd-core/references/verification-overrides.md', eraseAll('accepted_by'), 'verification-overrides', /the reference should document the accepted_by field/],
    ['accepted_at gone', 'gsd-core/references/verification-overrides.md', eraseAll('accepted_at'), 'verification-overrides', /the reference should document the accepted_at field/],
    ['accepted_by no longer marked required', 'gsd-core/references/verification-overrides.md', swap('Who accepted the override (username or role). Required.', 'Who accepted the override (username or role). Optional.'), 'verification-overrides', /accepted_by should be described as a required field/],
    ['accepted_at no longer marked required', 'gsd-core/references/verification-overrides.md', swap('ISO timestamp of when the override was accepted. Required.', 'ISO timestamp of when the override was accepted. Optional.'), 'verification-overrides', /accepted_at should be described as a required field/],
    ['fuzzy matching gone', 'gsd-core/references/verification-overrides.md', eraseAll('fuzzy matching'), 'verification-overrides', /the reference should describe fuzzy matching/],
    ['the case matching description gone', 'gsd-core/references/verification-overrides.md', (text) => text.replace(/case-insens[i]tive/gi, 'exact'), 'verification-overrides', /the reference should describe \w+-insensitive matching/],
    ['the 80% threshold gone', 'gsd-core/references/verification-overrides.md', eraseAll('80%'), 'verification-overrides', /the reference should describe the 80% word overlap matching threshold/],
    ['a 60% token overlap threshold added', 'gsd-core/references/verification-overrides.md', append('Match threshold: 60% token overlap.'), 'verification-overrides', /the reference should not describe a 60% matching threshold/],
    ['a 60% word overlap threshold added', 'gsd-core/references/verification-overrides.md', append('Match threshold: 60% word overlap.'), 'verification-overrides', /the reference should not describe a 60% matching threshold/],
    ['PASSED (override) gone', 'gsd-core/references/verification-overrides.md', eraseAll('PASSED (override)'), 'verification-overrides', /the reference should document the PASSED \(override\) status marker/],
    ['the example section gone', 'gsd-core/references/verification-overrides.md', swap('## Example VERIFICATION.md', '## Example'), 'verification-overrides', /the reference should include an example VERIFICATION\.md section/],
    ['the When to Use heading gone', 'gsd-core/references/verification-overrides.md', swap('## When to Use', '## Use'), 'verification-overrides', /the reference should contain a "When to Use" section/],
    ['the When NOT to Use heading gone', 'gsd-core/references/verification-overrides.md', swap('## When NOT to Use', '## Guardrails'), 'verification-overrides', /the reference should contain guardrails explaining when overrides are not appropriate/],
    ['overrides_applied gone from the reference', 'gsd-core/references/verification-overrides.md', eraseAll('overrides_applied'), 'verification-overrides', /the reference should document the overrides_applied counter field in frontmatter/],
    ['carry forward gone', 'gsd-core/references/verification-overrides.md', eraseAll('carry forward'), 'verification-overrides', /the reference should document that overrides carry forward during re-verification/],
    ['audit-milestone gone', 'gsd-core/references/verification-overrides.md', eraseAll('audit-milestone'), 'verification-overrides', /the reference should document that overrides are surfaced during milestone audit/],
    ['the reference link gone from the verifier', 'agents/gsd-verifier.md', swap('verification-overrides.md', 'other.md'), 'verification-overrides', /gsd-verifier\.md should reference verification-overrides\.md/],
    ['required_reading placed before </role>', 'agents/gsd-verifier.md', (text) => `<required_reading>\n${text}`, 'verification-overrides', /<required_reading> is not between <\/role> and <project_context>/],
    ['required_reading placed after <project_context>', 'agents/gsd-verifier.md', (text) => `<project_context>\n${text}`, 'verification-overrides', /<required_reading> is not between <\/role> and <project_context>/],
    ['the </role> tag gone', 'agents/gsd-verifier.md', swap('</role>', '</r>'), 'verification-overrides', /the <\/role> tag is missing/],
    ['the <project_context> tag gone', 'agents/gsd-verifier.md', swap('<project_context>', '<pc>'), 'verification-overrides', /the <project_context> tag is missing/],
    ['the line-start <required_reading> tag gone (a prose mention stays)', 'agents/gsd-verifier.md', (text) => text.replace(/^<required_reading>/m, '<rr>'), 'verification-overrides', /the <required_reading> tag is missing/],
    ['Step 3b gone from the verifier', 'agents/gsd-verifier.md', swap('Step 3b', 'Step 3c'), 'verification-overrides', /marker "## Step 3b" not found/],
    ['must_have gone from the Step 3b section', 'agents/gsd-verifier.md', within('## Step 3b', '\n## Step 4', eraseAll('must_have')), 'verification-overrides', /Step 3b should reference the must_have field/],
    ['the Step 4 heading after Step 3b gone', 'agents/gsd-verifier.md', swap('\n## Step 4', '\n## Stage 4'), 'verification-overrides', /closing marker "\\n## Step 4" not found after "## Step 3b"/],
    ['overrides_applied gone from the verifier', 'agents/gsd-verifier.md', eraseAll('overrides_applied'), 'verification-overrides', /the gsd-verifier\.md frontmatter template should include the overrides_applied counter/],
    // mempalace-capture-headless-invocation
    ...['skills/gsd-mempalace-capture/SKILL.md', 'commands/gsd/mempalace-capture.md'].flatMap((rel) => [
      [`--room added to the daemon mine of ${rel}`, rel, swap('mempalace mine "$STAGE" --wing <wing> --daemon --background', 'mempalace mine "$STAGE" --wing <wing> --room x --daemon --background'), 'mempalace-capture-headless-invocation', /a "mempalace mine" command must not include --room \(mine has no such flag/],
      [`--room added to the plain mine of ${rel}`, rel, swap('mempalace mine "$STAGE" --wing <wing> ${DIRECT:+--direct} &&', 'mempalace mine "$STAGE" --wing <wing> --room x &&'), 'mempalace-capture-headless-invocation', /a "mempalace mine" command must not include --room \(mine has no such flag/],
      [`mempalace.yaml gone from ${rel}`, rel, eraseAll('mempalace.yaml'), 'mempalace-capture-headless-invocation', /must reference mempalace\.yaml for room taxonomy/],
      [`detect_room gone from ${rel}`, rel, eraseAll('detect_room'), 'mempalace-capture-headless-invocation', /must reference detect_room\(\) as the room-assignment mechanism/],
      [`.mempalace-stage gone from ${rel}`, rel, eraseAll('.mempalace-stage'), 'mempalace-capture-headless-invocation', /must use the \.mempalace-stage staging directory/],
      [`a bare-string rooms entry in ${rel} is a forbidden shape`, rel, swap('- name: decisions', '- decisions'), 'mempalace-capture-headless-invocation', /the rooms: block must not contain bare-string entries[^]*offenders: \[" +- decisions"\]/],
      [`a rooms entry without a name in ${rel}`, rel, swap('- name: general', '- title: general'), 'mempalace-capture-headless-invocation', /every rooms: entry must be a dict with a name key[^]*rooms:\[4\] must have a non-empty name string/],
      [`only four rooms in ${rel}`, rel, erase(/ {5}- name: general\n/), 'mempalace-capture-headless-invocation', /at least 5 rooms\), got 4/],
      [`the rooms: line gone from ${rel}`, rel, swap('rooms:\n     - name: decisions', 'items:\n     - name: decisions'), 'mempalace-capture-headless-invocation', /could not locate a rooms: YAML block/],
      [`the YAML sentinel gone from ${rel}`, rel, swap('   YAML\n   # Suppress', '   # Suppress'), 'mempalace-capture-headless-invocation', /could not locate a rooms: YAML block/],
      [`invalid YAML in the rooms block of ${rel}`, rel, swap('- name: decisions', '- name: [decisions'), 'mempalace-capture-headless-invocation', /the rooms: block is not valid YAML/],
      [`rooms that is a mapping in ${rel}`, rel, swap('     - name: decisions\n     - name: planning\n     - name: milestones\n     - name: problems\n     - name: general\n', '     decisions: 1\n     planning: 2\n'), 'mempalace-capture-headless-invocation', /rooms: must parse to an array/],
      [`a third mempalace mine line in ${rel}`, rel, append('mempalace mine "$STAGE" --wing w'), 'mempalace-capture-headless-invocation', /found 3 mempalace mine lines, expected one guarded daemon mine and one plain mine/],
      [`the plain mine line gone from ${rel}`, rel, swap('mempalace mine "$STAGE" --wing <wing> ${DIRECT:+--direct} &&', 'true &&'), 'mempalace-capture-headless-invocation', /found 1 mempalace mine lines/],
      [`a mine line outside the daemon guard in ${rel}`, rel, (text) => `${swap('mempalace mine "$STAGE" --wing <wing> ${DIRECT:+--direct} &&', 'true &&')(text)}\nmempalace mine "$STAGE" --wing w\n`, 'mempalace-capture-headless-invocation', /the daemon guard holds 1 mempalace mine lines, expected 2/],
      [`the #6266 comment gone from ${rel}`, rel, swap('#6266: use the daemon route only when', '#6266: x'), 'mempalace-capture-headless-invocation', /the #6266 daemon-route comment must be present/],
      [`the daemon guard of ${rel} not closed by fi`, rel, (text) => within('#6266: use the daemon route only when', '```', (section) => section.split('fi\n').join('done\n'))(text), 'mempalace-capture-headless-invocation', /the daemon guard must be closed by fi/],
      [`queued gone from ${rel}`, rel, eraseAll('queued'), 'mempalace-capture-headless-invocation', /the report must name queued captures/],
      [`skipped gone from ${rel}`, rel, (text) => text.replace(/skipped/gi, 'x'), 'mempalace-capture-headless-invocation', /the report must name skipped captures/],
      [`the interactive daemon rule gone from ${rel}`, rel, swap('interactive run must never start the daemon', 'x'), 'mempalace-capture-headless-invocation', /the surface must say an interactive run never starts the daemon/],
    ]),
    ['a --room mine line in the problems fragment', 'capabilities/mempalace/fragments/capture-problems.md', append('mempalace mine /x --wing w --room r'), 'mempalace-capture-headless-invocation', /capture-problems\.md: a "mempalace mine" command must not include --room/],
    ['the daemon route sentence gone from the problems fragment', 'capabilities/mempalace/fragments/capture-problems.md', swap('`--daemon --background` only when `mempalace daemon status` already reports a running daemon, never starting one', '`--daemon --background`'), 'mempalace-capture-headless-invocation', /the execute:post problems fragment must take the same daemon route and never start a daemon/],
    ['the queue claim back in the problems fragment', 'capabilities/mempalace/fragments/capture-problems.md', append('the background queue defers the write'), 'mempalace-capture-headless-invocation', /the queue claim is true only with a running daemon/],
    ['the unconditional daemon invocation back in the problems fragment', 'capabilities/mempalace/fragments/capture-problems.md', append('mempalace mine --daemon --background'), 'mempalace-capture-headless-invocation', /the unconditional daemon invocation must not return/],
    ['the staging directory gone from .gitignore', '.gitignore', swap('.mempalace-stage/', 'x/'), 'mempalace-capture-headless-invocation', /\.gitignore must exclude \.planning\/\.mempalace-stage\//],
    // no-hardcoded-home-gsd-tools
    ...['agents/gsd-verifier.md', 'commands/gsd/mempalace-capture.md', 'gsd-core/references/verification-overrides.md'].flatMap((rel) => [
      ['double-quoted', 'node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" state'],
      ['single-quoted', "node '$HOME/.claude/gsd-core/bin/gsd-tools.cjs' state"],
      ['backtick-quoted', 'node `~/.claude/gsd-core/bin/gsd-tools.cjs` state'],
      ['braced HOME', 'node "${HOME}/.claude/gsd-core/bin/gsd-tools.cjs" state'],
      ['tilde', 'node ~/.claude/gsd-core/bin/gsd-tools.cjs state'],
      ['unquoted HOME with a long gap', 'node $HOME/a/very/long/path/that/goes/on/and/on/and/on/gsd-tools.cjs state'],
      ['a tab after node', 'node\t"$HOME/.claude/gsd-core/bin/gsd-tools.cjs" state'],
    ].map(([form, line]) => [`a ${form} $HOME gsd-tools call in a bash block of ${rel}`, rel, append(`\`\`\`bash\n${line}\n\`\`\``), 'no-hardcoded-home-gsd-tools', /a bash block must not hardcode a \$HOME gsd-tools\.cjs call \(resolve it through gsd_run\)/])),
    ['a hardcoded call in an sh block', 'agents/gsd-verifier.md', append('```sh\nnode ~/x/gsd-tools.cjs state\n```'), 'no-hardcoded-home-gsd-tools', /a bash block must not hardcode a \$HOME gsd-tools\.cjs call/],
    ['a hardcoded call in a bash block with an info string', 'agents/gsd-verifier.md', append('```bash title="run"\nnode ~/x/gsd-tools.cjs state\n```'), 'no-hardcoded-home-gsd-tools', /a bash block must not hardcode a \$HOME gsd-tools\.cjs call/],
    ['a hardcoded call in an unterminated bash block at the end of the file', 'agents/gsd-verifier.md', append('```bash\nnode ~/x/gsd-tools.cjs state'), 'no-hardcoded-home-gsd-tools', /a bash block must not hardcode a \$HOME gsd-tools\.cjs call/],
    ['a quoted $HOME gsd-tools call in a workflow', 'gsd-core/workflows/ship.md', append('node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" state'), 'no-hardcoded-home-gsd-tools', /a workflow must invoke gsd-tools via the resolved gsd_run launcher, not a hardcoded node "\$HOME\/\.\.\.\/gsd-tools\.cjs" path/],
    ['a quoted $HOME gsd-tools call after other words in a workflow', 'gsd-core/workflows/ship.md', append('Run: node   "$HOME/x/gsd-tools.cjs" init now'), 'no-hardcoded-home-gsd-tools', /a workflow must invoke gsd-tools via the resolved gsd_run launcher/],
    ['a mktemp template with a .json suffix in a workflow', 'gsd-core/workflows/ship.md', append('TMP=$(mktemp /tmp/gsd-XXXXXX.json)'), 'no-hardcoded-home-gsd-tools', /a workflow mktemp template must keep XXXXXX as the final path component/],
    ['a quoted mktemp template with a suffix', 'gsd-core/workflows/ship.md', append('TMP=$(mktemp "/tmp/gsd-XXXXXX.md")'), 'no-hardcoded-home-gsd-tools', /a workflow mktemp template must keep XXXXXX as the final path component/],
    ['a mktemp template with an underscore suffix', 'gsd-core/workflows/ship.md', append('mktemp /tmp/gsd-XXXXXX_tmp'), 'no-hardcoded-home-gsd-tools', /a workflow mktemp template must keep XXXXXX as the final path component/],
    ['a mktemp template with a hyphen suffix and a longer run', 'gsd-core/workflows/ship.md', append('mktemp -q /tmp/gsd-XXXXXXXX-a || mktemp /tmp/gsd-XXXXXXXX-a'), 'no-hardcoded-home-gsd-tools', /a workflow mktemp template must keep XXXXXX as the final path component/],
    ['a mktemp template in a step file of another workflow', 'gsd-core/workflows/verify-work/steps/mvp-uat-framing.md', append('mktemp /tmp/x-XXXXXX.txt'), 'no-hardcoded-home-gsd-tools', /a workflow mktemp template must keep XXXXXX as the final path component/],
    // thinking-model-guidance
    ...['debug', 'execution', 'planning', 'research', 'verification'].flatMap((context) => [
      [`the When NOT to Think heading gone from thinking-models-${context}.md`, `gsd-core/references/thinking-models-${context}.md`, swap('## When NOT to Think', '## Stop'), 'thinking-model-guidance', /must have a "When NOT to Think" section/],
      [`the Conflict Resolution heading gone from thinking-models-${context}.md`, `gsd-core/references/thinking-models-${context}.md`, swap('## Conflict Resolution', '## Order'), 'thinking-model-guidance', /must have a Conflict Resolution section \(sequencing rules\)/],
    ]),
    ['the planning Occam sentence on scope gone', 'gsd-core/references/thinking-models-planning.md', swap('must never reduce requested scope', 'may reduce scope'), 'thinking-model-guidance', /the planning Occam check must say it must never reduce requested scope/],
    ['the plan checker sentence gone', 'gsd-core/references/thinking-models-planning.md', swap('the plan checker flags a new abstraction or dependency only when a higher rung is demonstrably sufficient', 'the plan checker reviews plans'), 'thinking-model-guidance', /the planning Occam check must ask the plan checker to flag avoidable new surface only when a higher rung is sufficient/],
    ['the Gap Closure Mode heading gone', 'gsd-core/references/thinking-models-planning.md', swap('## Gap Closure Mode', '## Gap Mode'), 'thinking-model-guidance', /marker "## Gap Closure Mode" not found/],
    ['the gaps_found trigger gone', 'gsd-core/references/thinking-models-planning.md', (text) => text.split('gaps_found').join('x').split('gap closure mode').join('y'), 'thinking-model-guidance', /the Gap Closure Mode section must name its trigger condition/],
        // quick-commit-boundary-context-research
        ['DISCUSS_MODE gone from the pre-dispatch commit step (#4996)', 'gsd-core/workflows/quick/steps/worktree-pre-dispatch-commit.md',
          eraseAll('DISCUSS_MODE'), 'quick-commit-boundary-context-research', /must reference DISCUSS_MODE so it stages CONTEXT\.md/],
        ['CONTEXT.md gone from the pre-dispatch commit step (#4996)', 'gsd-core/workflows/quick/steps/worktree-pre-dispatch-commit.md',
          eraseAll('CONTEXT.md'), 'quick-commit-boundary-context-research', /must reference CONTEXT\.md so it stages it/],
        ['RESEARCH_MODE gone from the pre-dispatch commit step (#4996)', 'gsd-core/workflows/quick/steps/worktree-pre-dispatch-commit.md',
          eraseAll('RESEARCH_MODE'), 'quick-commit-boundary-context-research', /must reference RESEARCH_MODE so it stages RESEARCH\.md/],
        ['RESEARCH.md gone from the pre-dispatch commit step (#4996)', 'gsd-core/workflows/quick/steps/worktree-pre-dispatch-commit.md',
          eraseAll('RESEARCH.md'), 'quick-commit-boundary-context-research', /must reference RESEARCH\.md so it stages it/],
        ['the CONTEXT.md file-existence test gone (mode flag alone) (#4996)', 'gsd-core/workflows/quick/steps/worktree-pre-dispatch-commit.md',
          swap('[ -f "${QUICK_DIR}/${quick_id}-CONTEXT.md" ]', '[ -e "${QUICK_DIR}/${quick_id}-CONTEXT.md" ]'), 'quick-commit-boundary-context-research', /CONTEXT\.md staging must be guarded by a file-existence test, not mode alone/],
        ['the RESEARCH.md file-existence test gone (mode flag alone) (#4996)', 'gsd-core/workflows/quick/steps/worktree-pre-dispatch-commit.md',
          swap('[ -f "${QUICK_DIR}/${quick_id}-RESEARCH.md" ]', '[ -e "${QUICK_DIR}/${quick_id}-RESEARCH.md" ]'), 'quick-commit-boundary-context-research', /RESEARCH\.md staging must be guarded by a file-existence test, not mode alone/],
        ['a CONTEXT.md test on the next line after a line terminator is not on the same line (U+2028)', 'gsd-core/workflows/quick/steps/worktree-pre-dispatch-commit.md',
          swap('[ -f "${QUICK_DIR}/${quick_id}-CONTEXT.md" ]', '[ -f ${QUICK_DIR}/${quick_id}-\u2028CONTEXT.md ]'), 'quick-commit-boundary-context-research', /CONTEXT\.md staging must be guarded by a file-existence test/],
        ['a RESEARCH.md test on the next line after a CR is not on the same line', 'gsd-core/workflows/quick/steps/worktree-pre-dispatch-commit.md',
          swap('[ -f "${QUICK_DIR}/${quick_id}-RESEARCH.md" ]', '[ -f ${QUICK_DIR}/${quick_id}-\rRESEARCH.md ]'), 'quick-commit-boundary-context-research', /RESEARCH\.md staging must be guarded by a file-existence test/],
        ['PLAN.md gone from the pre-dispatch commit step (#4996)', 'gsd-core/workflows/quick/steps/worktree-pre-dispatch-commit.md',
          eraseAll('PLAN.md'), 'quick-commit-boundary-context-research', /must still reference PLAN\.md unconditionally/],
        ['the executor spawn marker gone from quick.md (#4996)', 'gsd-core/workflows/quick.md',
          swap('subagent_type="gsd-executor"', 'subagent_type="gsd-runner"'), 'quick-commit-boundary-context-research', /the executor Agent\(\)\/Task\(\) spawn is missing/],
        ['every required_reading closing tag gone from quick.md (#4996)', 'gsd-core/workflows/quick.md',
          eraseAll('</required_reading>'), 'quick-commit-boundary-context-research', /the executor required_reading block is missing/],
        ['CONTEXT.md conditional gone from the executor required_reading (#4996)', 'gsd-core/workflows/quick.md',
          within('<required_reading>\n- ${QUICK_DIR}/${quick_id}-PLAN.md (Plan)', '</required_reading>', eraseAll('DISCUSS_MODE')), 'quick-commit-boundary-context-research', /must list CONTEXT\.md conditionally on \$DISCUSS_MODE/],
        ['CONTEXT.md gone from the executor required_reading (#4996)', 'gsd-core/workflows/quick.md',
          within('<required_reading>\n- ${QUICK_DIR}/${quick_id}-PLAN.md (Plan)', '</required_reading>', eraseAll('CONTEXT.md')), 'quick-commit-boundary-context-research', /must list CONTEXT\.md conditionally on \$DISCUSS_MODE/],
        ['RESEARCH.md conditional gone from the executor required_reading (#4996)', 'gsd-core/workflows/quick.md',
          within('<required_reading>\n- ${QUICK_DIR}/${quick_id}-PLAN.md (Plan)', '</required_reading>', eraseAll('RESEARCH_MODE')), 'quick-commit-boundary-context-research', /must list RESEARCH\.md conditionally on \$RESEARCH_MODE/],
        ['RESEARCH.md gone from the executor required_reading (#4996)', 'gsd-core/workflows/quick.md',
          within('<required_reading>\n- ${QUICK_DIR}/${quick_id}-PLAN.md (Plan)', '</required_reading>', eraseAll('RESEARCH.md')), 'quick-commit-boundary-context-research', /must list RESEARCH\.md conditionally on \$RESEARCH_MODE/],
        ['CONTEXT.md gone from the executor prompt (#4996)', 'gsd-core/workflows/quick.md',
          within('Execute quick task', 'subagent_type="gsd-executor"', eraseAll('CONTEXT.md')), 'quick-commit-boundary-context-research', /it names no CONTEXT\.md/],
        ['QUICK_PLAN_COMMIT gone from the executor prompt (#4996)', 'gsd-core/workflows/quick.md',
          within('Execute quick task', 'subagent_type="gsd-executor"', eraseAll('QUICK_PLAN_COMMIT')), 'quick-commit-boundary-context-research', /it names no QUICK_PLAN_COMMIT/],
        ['git show after the required_reading in the executor prompt (#4996)', 'gsd-core/workflows/quick.md',
          within('Execute quick task', 'subagent_type="gsd-executor"', (section) => `${section.split('git show').join('git sh0w')}\ngit show\n`), 'quick-commit-boundary-context-research', /git show does not come before the required_reading block/],
        ['git show gone from the executor prompt (#4996)', 'gsd-core/workflows/quick.md',
          within('Execute quick task', 'subagent_type="gsd-executor"', eraseAll('git show')), 'quick-commit-boundary-context-research', /the PLAN\.md materialization via git show of the plan commit must remain/],
        ['RESEARCH.md gone from the executor prompt (#4996)', 'gsd-core/workflows/quick.md',
          within('Execute quick task', 'subagent_type="gsd-executor"', eraseAll('RESEARCH.md')), 'quick-commit-boundary-context-research', /it names no RESEARCH\.md/],
        ['the planner block start marker gone from quick.md (#4996)', 'gsd-core/workflows/quick.md',
          swap('<required_reading>\n- ${STATE_PATH} (Project State)', '<required_reading>\n- ${STATE_PATH} (State)'), 'quick-commit-boundary-context-research', /the planner required_reading block is missing/],
        ['the executor block start marker gone from quick.md (#4996)', 'gsd-core/workflows/quick.md',
          swap('<required_reading>\n- ${QUICK_DIR}/${quick_id}-PLAN.md (Plan)', '<required_reading>\n- ${QUICK_DIR}/${quick_id}-PLAN.md (The plan)'), 'quick-commit-boundary-context-research', /the executor required_reading block is missing/],
        ['the CONTEXT.md line gone from the planner block (anti-drift)', 'gsd-core/workflows/quick.md',
          within('<required_reading>\n- ${STATE_PATH} (Project State)', '</required_reading>', swap("${DISCUSS_MODE ? '- ' + QUICK_DIR + '/' + quick_id + '-CONTEXT.md (User decisions — locked, do not revisit)' : ''}", '')), 'quick-commit-boundary-context-research', /the planner block lacks the canonical CONTEXT\.md conditional line/],
        ['the RESEARCH.md line gone from the planner block (anti-drift)', 'gsd-core/workflows/quick.md',
          within('<required_reading>\n- ${STATE_PATH} (Project State)', '</required_reading>', swap("${RESEARCH_MODE ? '- ' + QUICK_DIR + '/' + quick_id + '-RESEARCH.md (Research findings — use to inform implementation choices)' : ''}", '')), 'quick-commit-boundary-context-research', /the planner block lacks the canonical RESEARCH\.md conditional line/],
        ['the CONTEXT.md line differs in the executor block (anti-drift)', 'gsd-core/workflows/quick.md',
          within('<required_reading>\n- ${QUICK_DIR}/${quick_id}-PLAN.md (Plan)', '</required_reading>', swap('(User decisions — locked, do not revisit)', '(User decisions)')), 'quick-commit-boundary-context-research', /the executor block lacks the CONTEXT\.md conditional line the planner carries/],
        ['the RESEARCH.md line differs in the executor block (anti-drift)', 'gsd-core/workflows/quick.md',
          within('<required_reading>\n- ${QUICK_DIR}/${quick_id}-PLAN.md (Plan)', '</required_reading>', swap('(Research findings — use to inform implementation choices)', '(Research findings)')), 'quick-commit-boundary-context-research', /the executor block lacks the RESEARCH\.md conditional line the planner carries/],
        // spec-phase-probe-reachability
        ['the prohibition probe step no longer named a probe (#2733)', 'gsd-core/workflows/spec-phase.md',
          swap('## Step 5.6: Prohibition-Completeness Probe (must-NOT)', '## Step 5.6: Prohibition-Completeness (must-NOT)'), 'spec-phase-probe-reachability', /must define at least the edge-completeness and prohibition-completeness probe steps \(found 1: 5\.5\)/],
        ['a gate-passed jump past both probes (#2733)', 'gsd-core/workflows/spec-phase.md',
          swap('**If `--auto`:** Jump to Step 5.5.', '**If `--auto`:** Jump to Step 6.'), 'spec-phase-probe-reachability', /not past it \(2 probe-skipping jump\(s\)/],
        ['the edge probe soft gate proceeding past the prohibition probe (#2733)', 'gsd-core/workflows/spec-phase.md',
          swap('All applicable edges resolved → proceed to Step 5.6.', 'All applicable edges resolved → proceed to Step 6.'), 'spec-phase-probe-reachability', /skipping mandatory Step 5\.6 \(Prohibition-Completeness Probe/],
        ['no transition instruction left in spec-phase.md', 'gsd-core/workflows/spec-phase.md',
          erase(/\b(?:jump|proceed|continue|go|return|skip) to Step/gi), 'spec-phase-probe-reachability', /it contains no jump instructions to assert on/],
        ['no jump reaches the first probe (#2733)', 'gsd-core/workflows/spec-phase.md',
          swap('to Step 5.5', 'to Step 5.6'), 'spec-phase-probe-reachability', /Step 5\.5 \(Edge-Completeness Probe\) is defined but no jump reaches it; targets found:/],
        ['the max-rounds block redirected into a probe (#2733)', 'gsd-core/workflows/spec-phase.md',
          swap('**If `--auto`:** Write SPEC.md anyway', '**If `--auto`:** proceed to Step 5.5; Write SPEC.md anyway'), 'spec-phase-probe-reachability', /must not be redirected into a probe: it never passed the ambiguity gate \(line \d+ redirects into Step 5\.5\)/],
        ['the max-rounds marker gone (#2733)', 'gsd-core/workflows/spec-phase.md',
          swap('If max rounds reached', 'When max rounds were reached'), 'spec-phase-probe-reachability', /no "If max rounds reached" block/],
        ['the max-rounds block no longer writes SPEC.md (#2733)', 'gsd-core/workflows/spec-phase.md',
          within('**If max rounds reached (6) and gate not passed:**', '## Step 5:', eraseAll('Write SPEC.md')), 'spec-phase-probe-reachability', /the max-rounds bypass must still route to SPEC generation \(the block never writes SPEC\.md\)/],
        ['the edge probe lost its onward exit (#2733)', 'gsd-core/workflows/spec-phase.md',
          swap('→ proceed to Step 5.6.', '→ go on to Step 5.6.'), 'spec-phase-probe-reachability', /Step 5\.5 \(Edge-Completeness Probe\) has no "proceed to Step N" exit/],
        ['the prohibition probe lost its onward exit (#2733)', 'gsd-core/workflows/spec-phase.md',
          swap('→ proceed to Step 6.', '→ go on to Step 6.'), 'spec-phase-probe-reachability', /Step 5\.6 \(Prohibition-Completeness Probe \(must-NOT\)\) has no "proceed to Step N" exit/],
        ['no step names a probe, so no jump can reach the first one (#2733)', 'gsd-core/workflows/spec-phase.md',
          erase(/Probe/g), 'spec-phase-probe-reachability', /\(found 0: \)/],
        // test-gate-watch-mode
        ...[
          ['regression gate', 'gsd-core/workflows/execute-phase/steps/regression-gate-run.md'],
          ['post-merge gate', 'gsd-core/workflows/execute-phase/steps/post-merge-gate.md'],
          ['audit-fix gate', 'gsd-core/workflows/audit-fix.md'],
        ].flatMap(([label, file]) => [
          [`normalize-test-command gone from the ${label} (#1857)`, file, eraseAll('normalize-test-command'), 'post-merge-gate-watch-mode', /must call the shared normalize-test-command helper/],
          [`the timeout budget key gone from the ${label} (#1857)`, file, eraseAll('workflow.test_gate_timeout'), 'post-merge-gate-watch-mode', /must read workflow\.test_gate_timeout/],
          [`the run-with-timeout wrapper gone from the ${label} (#1857)`, file, eraseAll('run-with-timeout "$TEST_GATE_TIMEOUT"'), 'post-merge-gate-watch-mode', /must wrap the test command in run-with-timeout with the configured budget/],
          [`the exit 124 handling gone from the ${label} (#1857)`, file, eraseAll('-eq 124'), 'post-merge-gate-watch-mode', /must handle the timeout exit code \(124\)/],
          [`the watch/dev hint gone from the ${label} (#1857)`, file, eraseAll('watch/dev mode'), 'post-merge-gate-watch-mode', /must name watch\/dev mode as the likely cause on timeout/],
          [`the shared normalizer verb renamed in the ${label} (#1857)`, file, swap('gsd_run query normalize-test-command', 'gsd_run  query normalize-test-command'), 'post-merge-gate-watch-mode', /must invoke the shared normalizer by the same verb name/],
          [`--raw gone from the build/test_command config-get of the ${label} (#2350)`, file, swap(' --default "" --raw', ' --default ""'), 'post-merge-gate-watch-mode', /every build\/test_command config-get must pass --raw so an unset key is empty/],
          [`no build/test_command config-get left in the ${label} (#2350)`, file, swap('config-get workflow.', 'config-set workflow.'), 'post-merge-gate-watch-mode', /resolves no build\/test command via config-get/],
        ]),
        ['REGRESSION GATE ABORTED gone from the regression gate (#1857)', 'gsd-core/workflows/execute-phase/steps/regression-gate.md',
          eraseAll('REGRESSION GATE ABORTED'), 'post-merge-gate-watch-mode', /the regression gate must abort \(not continue\) on a watch-mode timeout/],
        ['the discovery-failure HALT gone from the regression gate (#6813)', 'gsd-core/workflows/execute-phase/steps/regression-gate.md',
          eraseAll('If this block exits non-zero, HALT'), 'post-merge-gate-watch-mode', /the regression gate must halt when its discovery block fails, not read the failure as no prior phases/],
        ['the shared verification step include gone from execute-phase.md (#5118)', 'gsd-core/workflows/execute-phase.md',
          eraseAll('steps/verify-phase-goal.md'), 'post-merge-gate-watch-mode', /execute-phase\.md must include the shared verification step/],
        ['the regression-gate step reference gone from the shared verification step (#5118)', 'gsd-core/workflows/execute-phase/steps/verify-phase-goal.md',
          eraseAll('steps/regression-gate.md'), 'post-merge-gate-watch-mode', /the shared verification step must reference the extracted regression-gate step/],
        ['-project gone from one xcodebuild construction (#4784)', 'gsd-core/workflows/execute-phase/steps/post-merge-gate.md',
          swap("xcodebuild build -project '$XCODEPROJ' -destination", 'xcodebuild build -destination'), 'post-merge-gate-watch-mode', /every constructed xcodebuild command must carry -project '\$XCODEPROJ' \(no -project in: xcodebuild build -destination/],
        ['fewer than four xcodebuild constructions (#4784)', 'gsd-core/workflows/execute-phase/steps/post-merge-gate.md',
          swap('xcodebuild test -project', 'xcrun test -project'), 'post-merge-gate-watch-mode', /expected the four Xcode command constructions, got 2/],
        ['simctl list devices available gone from the post-merge gate (#4784)', 'gsd-core/workflows/execute-phase/steps/post-merge-gate.md',
          eraseAll('simctl list devices available'), 'post-merge-gate-watch-mode', /the Xcode destination must resolve from simctl list devices available/],
        ['the simulator id destination gone from the post-merge gate (#4784)', 'gsd-core/workflows/execute-phase/steps/post-merge-gate.md',
          eraseAll('id=$XCODE_SIM'), 'post-merge-gate-watch-mode', /the destination must reference the resolved simulator id/],
        ['a hardcoded simulator name back in the post-merge gate (#4784)', 'gsd-core/workflows/execute-phase/steps/post-merge-gate.md',
          append('xcodebuild -destination name=iPhone 16'), 'post-merge-gate-watch-mode', /the hardcoded simulator name must be gone/],
        ['the build-arm skip echo no longer names workflow.build_command (#4784)', 'gsd-core/workflows/execute-phase/steps/post-merge-gate.md',
          swap('Set workflow.build_command to run it anyway.', 'Set the build command to run it anyway.'), 'post-merge-gate-watch-mode', /the build-arm skip must name workflow\.build_command/],
        ['the test-arm skip echo no longer names workflow.test_command (#4784)', 'gsd-core/workflows/execute-phase/steps/post-merge-gate.md',
          swap('Set workflow.test_command to run it anyway.', 'Set the test command to run it anyway.'), 'post-merge-gate-watch-mode', /the test-arm skip must name workflow\.test_command/],
        ['the first skip arm no longer assigns its command variable (#4784)', 'gsd-core/workflows/execute-phase/steps/post-merge-gate.md',
          within('if [ -z "$XCODE_SIM" ]; then', '\n    fi', eraseAll('BUILD_CMD=""')), 'post-merge-gate-watch-mode', /\(a skip arm assigns no command variable\)/],
        ['no skip arm left in the post-merge gate (#4784)', 'gsd-core/workflows/execute-phase/steps/post-merge-gate.md',
          eraseAll('if [ -z "$XCODE_SIM" ]; then'), 'post-merge-gate-watch-mode', /expected both skip arms, got 0/],
        ['the diagnostics collector flag gone from the post-merge gate (#4784)', 'gsd-core/workflows/execute-phase/steps/post-merge-gate.md',
          eraseAll('-collect-test-diagnostics never'), 'post-merge-gate-watch-mode', /the gate must mention -collect-test-diagnostics never for Xcode suites/],
        ['workflow.build_command gone from the post-merge gate (#5346)', 'gsd-core/workflows/execute-phase/steps/post-merge-gate.md',
          eraseAll('workflow.build_command'), 'post-merge-gate-watch-mode', /the post-merge gate must recommend workflow\.build_command/],
        ['the sniffed build script no longer logged (#5346)', 'gsd-core/workflows/execute-phase/steps/post-merge-gate.md',
          swap("running this project's", 'running the'), 'post-merge-gate-watch-mode', /a sniffed build script must be logged/],
        ['the build package-manager call gone from the post-merge gate (#5346)', 'gsd-core/workflows/execute-phase/steps/post-merge-gate.md',
          eraseAll('resolve-package-manager build'), 'post-merge-gate-watch-mode', /post-merge-gate \(build\) must resolve through "resolve-package-manager build"/],
        ['the npm run build fallback gone from the post-merge gate (#5346)', 'gsd-core/workflows/execute-phase/steps/post-merge-gate.md',
          swap('"npm run build"', '"pnpm run build"'), 'post-merge-gate-watch-mode', /post-merge-gate \(build\) must keep the literal "npm run build" fallback/],
        ['the test package-manager call gone from the post-merge gate (#5346)', 'gsd-core/workflows/execute-phase/steps/post-merge-gate.md',
          eraseAll('resolve-package-manager test'), 'post-merge-gate-watch-mode', /post-merge-gate \(test\) must resolve through "resolve-package-manager test"/],
        ['the npm test fallback gone from the post-merge gate (#5346)', 'gsd-core/workflows/execute-phase/steps/post-merge-gate.md',
          swap('"npm test"', '"pnpm test"'), 'post-merge-gate-watch-mode', /post-merge-gate \(test\) must keep the literal "npm test" fallback/],
        ['the package-manager call gone from the regression-gate run step (#5346)', 'gsd-core/workflows/execute-phase/steps/regression-gate-run.md',
          eraseAll('resolve-package-manager test'), 'post-merge-gate-watch-mode', /regression-gate-run must resolve through "resolve-package-manager test"/],
        ['the npm test fallback gone from the regression-gate run step (#5346)', 'gsd-core/workflows/execute-phase/steps/regression-gate-run.md',
          swap('"npm test"', '"pnpm test"'), 'post-merge-gate-watch-mode', /regression-gate-run must keep the literal "npm test" fallback/],
        ['the package-manager call gone from audit-fix (#5346)', 'gsd-core/workflows/audit-fix.md',
          eraseAll('resolve-package-manager test'), 'post-merge-gate-watch-mode', /audit-fix must resolve through "resolve-package-manager test"/],
        ['the npm test fallback gone from audit-fix (#5346)', 'gsd-core/workflows/audit-fix.md',
          swap('"npm test"', '"pnpm test"'), 'post-merge-gate-watch-mode', /audit-fix must keep the literal "npm test" fallback/],
        // execute-phase-worktree-artifacts
        ['STATE.md in the worktree executor success_criteria (#1571)', 'gsd-core/workflows/execute-phase.md',
          within('**Worktree mode**', '</success_criteria>', swap('- [ ] SUMMARY.md created in plan directory', '- [ ] SUMMARY.md created in plan directory\n       - [ ] STATE.md updated')), 'execute-phase-worktree-artifacts', /the worktree executor success_criteria must not reference STATE\.md/],
        ['ROADMAP.md in the worktree executor success_criteria (#1571)', 'gsd-core/workflows/execute-phase.md',
          within('**Worktree mode**', '</success_criteria>', swap('- [ ] SUMMARY.md created in plan directory', '- [ ] SUMMARY.md created in plan directory\n       - [ ] ROADMAP.md updated')), 'execute-phase-worktree-artifacts', /the worktree executor success_criteria must not reference ROADMAP\.md/],
        ['SUMMARY.md gone from the worktree executor success_criteria (#1571)', 'gsd-core/workflows/execute-phase.md',
          within('**Worktree mode**', '</success_criteria>', eraseAll('SUMMARY.md')), 'execute-phase-worktree-artifacts', /the worktree executor success_criteria must still require SUMMARY\.md creation/],
        ['STATE.md gone from the sequential executor success_criteria (#1571)', 'gsd-core/workflows/execute-phase.md',
          within('**Sequential mode**', '</success_criteria>', eraseAll('STATE.md')), 'execute-phase-worktree-artifacts', /the sequential executor success_criteria must still require the STATE\.md update/],
        ['ROADMAP.md gone from the sequential executor success_criteria (#1571)', 'gsd-core/workflows/execute-phase.md',
          within('**Sequential mode**', '</success_criteria>', eraseAll('ROADMAP.md')), 'execute-phase-worktree-artifacts', /the sequential executor success_criteria must still require the ROADMAP\.md update/],
        ['no success_criteria block in execute-phase.md (#1571)', 'gsd-core/workflows/execute-phase.md',
          eraseAll('<success_criteria>'), 'execute-phase-worktree-artifacts', /no success_criteria block follows \*\*Worktree mode\*\*/],
        ['the worktree mode marker renamed (#1571)', 'gsd-core/workflows/execute-phase.md',
          swap('**Worktree mode**', '**Worktree-mode**'), 'execute-phase-worktree-artifacts', /no success_criteria block follows \*\*Worktree mode\*\*/],
        ['the sequential mode marker renamed (#1571)', 'gsd-core/workflows/execute-phase.md',
          swap('**Sequential mode**', '**Sequential-mode**'), 'execute-phase-worktree-artifacts', /no success_criteria block follows \*\*Sequential mode\*\*/],
        ['roadmap update-plan-progress gone from execute-phase.md (#1571)', 'gsd-core/workflows/execute-phase.md',
          eraseAll('roadmap update-plan-progress'), 'execute-phase-worktree-artifacts', /must contain the orchestrator-owned roadmap update-plan-progress command/],
        ['roadmap update-plan-progress inside the worktree agent prompt (#1571)', 'gsd-core/workflows/execute-phase.md',
          swap('A prior `Agent(isolation="worktree")` dispatch', 'A prior `Agent(isolation="worktree")` roadmap update-plan-progress dispatch'), 'execute-phase-worktree-artifacts', /roadmap update-plan-progress must appear outside the worktree agent prompt \(orchestrator-owned\) \(it sits inside the worktree agent prompt\)/],
        ['the ghost state update-position back (#1627)', 'gsd-core/workflows/execute-phase.md',
          append('state update-position'), 'execute-phase-worktree-artifacts', /state update-position was a ghost reference/],
        ['the recovery policy fragment reference gone from execute-phase.md (#1292)', 'gsd-core/workflows/execute-phase.md',
          eraseAll('execute-phase/steps/worktree-recovery-policy.md'), 'execute-phase-worktree-artifacts', /must reference the extracted worktree-recovery-policy\.md fragment/],
        ['#1292 gone from execute-phase.md', 'gsd-core/workflows/execute-phase.md',
          eraseAll('#1292'), 'execute-phase-worktree-artifacts', /execute-phase\.md must reference #1292 in the worktree recovery policy pointer/],
        ['the decline trigger gone from execute-phase.md (#1292)', 'gsd-core/workflows/execute-phase.md',
          eraseAll('declines to merge a worktree'), 'execute-phase-worktree-artifacts', /must mention "declines to merge a worktree" as the trigger/],
        ['never default to editing gone from execute-phase.md (#1292)', 'gsd-core/workflows/execute-phase.md',
          eraseAll('never default to editing'), 'execute-phase-worktree-artifacts', /must state "never default to editing" main/],
        ['the ISOLATED-RUN RECOVERY label gone from the recovery fragment (#1292)', 'gsd-core/workflows/execute-phase/steps/worktree-recovery-policy.md',
          eraseAll('ISOLATED-RUN RECOVERY'), 'execute-phase-worktree-artifacts', /the fragment must contain the ISOLATED-RUN RECOVERY guardrail label/],
        ['#1292 gone from the recovery fragment', 'gsd-core/workflows/execute-phase/steps/worktree-recovery-policy.md',
          eraseAll('#1292'), 'execute-phase-worktree-artifacts', /the ISOLATED-RUN RECOVERY guardrail must reference #1292/],
        ['never the proposed or default gone from the recovery fragment (#1292)', 'gsd-core/workflows/execute-phase/steps/worktree-recovery-policy.md',
          eraseAll('never the proposed or default'), 'execute-phase-worktree-artifacts', /the guardrail must state editing main is "never the proposed or default" option/],
        ['the fresh worktree recovery path gone from the recovery fragment (#1292)', 'gsd-core/workflows/execute-phase/steps/worktree-recovery-policy.md',
          eraseAll('fresh, narrowly-scoped worktree'), 'execute-phase-worktree-artifacts', /the guardrail must offer a "fresh, narrowly-scoped worktree" as the recovery path/],
        ['the explicit confirmation requirement gone from the recovery fragment (#1292)', 'gsd-core/workflows/execute-phase/steps/worktree-recovery-policy.md',
          eraseAll('explicit, clearly-labeled confirmation'), 'execute-phase-worktree-artifacts', /the guardrail must require "explicit, clearly-labeled confirmation"/],
        ['worktree_branch_check gone from the recovery fragment (#48)', 'gsd-core/workflows/execute-phase/steps/worktree-recovery-policy.md',
          eraseAll('worktree_branch_check'), 'execute-phase-worktree-artifacts', /the fragment must contain "worktree_branch_check" from the FAIL-CLOSED rule/],
        ['exit 42 gone from the recovery fragment (#48)', 'gsd-core/workflows/execute-phase/steps/worktree-recovery-policy.md',
          eraseAll('42'), 'execute-phase-worktree-artifacts', /the fragment must contain "42" \(exit 42\)/],
        ['the ISOLATED-RUN RECOVERY label gone from quick.md (#1292)', 'gsd-core/workflows/quick.md',
          eraseAll('ISOLATED-RUN RECOVERY'), 'execute-phase-worktree-artifacts', /quick\.md must contain the ISOLATED-RUN RECOVERY guardrail label/],
        ['#1292 gone from quick.md', 'gsd-core/workflows/quick.md',
          eraseAll('#1292'), 'execute-phase-worktree-artifacts', /the quick\.md ISOLATED-RUN RECOVERY guardrail must reference #1292/],
        ['never the proposed or default gone from quick.md (#1292)', 'gsd-core/workflows/quick.md',
          eraseAll('never the proposed or default'), 'execute-phase-worktree-artifacts', /the quick\.md guardrail must state editing main is "never the proposed or default" option/],
        ['the fresh worktree recovery path gone from quick.md (#1292)', 'gsd-core/workflows/quick.md',
          eraseAll('fresh, narrowly-scoped worktree'), 'execute-phase-worktree-artifacts', /the quick\.md guardrail must offer a "fresh, narrowly-scoped worktree"/],
        ['the explicit confirmation requirement gone from quick.md (#1292)', 'gsd-core/workflows/quick.md',
          eraseAll('explicit, clearly-labeled confirmation'), 'execute-phase-worktree-artifacts', /the quick\.md guardrail must require "explicit, clearly-labeled confirmation"/],
        // tdd-backend-wiring
        ['the harness TDD_APPLICABLE assignment gone from the fragment (#4266)', 'gsd-core/workflows/execute-phase/steps/tdd-applicability-resolution.md',
          swap('TDD_APPLICABLE="$TDD_APPLICABLE_RAW"', 'TDD_APPLICABLE_X="$TDD_APPLICABLE_RAW"'), 'tdd-backend-wiring', /execute-phase\.md: TDD_APPLICABLE must be assigned from a phase\.tdd-applicable call within a few lines above it \(it has no TDD_APPLICABLE assignment\)/],
        ['phase.tdd-applicable gone from the harness fragment (#4266)', 'gsd-core/workflows/execute-phase/steps/tdd-applicability-resolution.md',
          eraseAll('phase.tdd-applicable'), 'tdd-backend-wiring', /no phase\.tdd-applicable call within eight lines above the assignment/],
        ['the worktree TDD_APPLICABLE assignment gone (#4266)', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md',
          swap('TDD_APPLICABLE="$_TDD_APPLICABLE_RAW"', 'TDD_APPLICABLE_X="$_TDD_APPLICABLE_RAW"'), 'tdd-backend-wiring', /executor-isolation-dispatch\.md: TDD_APPLICABLE must be assigned from a phase\.tdd-applicable call within a few lines above it \(it has no TDD_APPLICABLE assignment\)/],
        ['phase.tdd-applicable gone from the worktree backend (#4266)', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md',
          eraseAll('phase.tdd-applicable'), 'tdd-backend-wiring', /executor-isolation-dispatch\.md: TDD_APPLICABLE must be assigned from a phase\.tdd-applicable call within a few lines above it \(no phase\.tdd-applicable call within eight lines/],
        ['the harness call is phase-scoped, not plan-scoped (#4266)', 'gsd-core/workflows/execute-phase/steps/tdd-applicability-resolution.md',
          swap('phase.tdd-applicable "{phase_dir}/{plan_file}"', 'phase.tdd-applicable "{phase_dir}"'), 'tdd-backend-wiring', /execute-phase\.md: the phase\.tdd-applicable call must be plan-scoped/],
        ['the worktree call is phase-scoped, not plan-scoped (#4266)', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md',
          swap('phase.tdd-applicable "{phase_dir}/{plan_file}"', 'phase.tdd-applicable "{phase_dir}"'), 'tdd-backend-wiring', /executor-isolation-dispatch\.md: the phase\.tdd-applicable call must be plan-scoped/],
        ['no gsd_run query phase.tdd-applicable call left in the harness fragment (#4266)', 'gsd-core/workflows/execute-phase/steps/tdd-applicability-resolution.md',
          swap('gsd_run query phase.tdd-applicable', 'gsd_run query phase.tdd_applicable'), 'tdd-backend-wiring', /no phase\.tdd-applicable call within eight lines above the assignment/],
        ['a use of TDD_APPLICABLE before the worktree assignment (#4266)', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md',
          swap('# Resolve TDD-applicability for THIS plan (#4266/#4272)', 'echo "${TDD_APPLICABLE}"\n# Resolve TDD-applicability for THIS plan (#4266/#4272)'), 'tdd-backend-wiring', /executor-isolation-dispatch\.md must assign TDD_APPLICABLE before every \$\{TDD_APPLICABLE\.\.\.\} use \(TDD_APPLICABLE is used at line \d+ before it is assigned at line \d+\)/],
        ['no TDD_APPLICABLE use left in the worktree backend (#4266)', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md',
          eraseAll('${TDD_APPLICABLE'), 'tdd-backend-wiring', /executor-isolation-dispatch\.md must assign TDD_APPLICABLE before every \$\{TDD_APPLICABLE\.\.\.\} use \(it has no \$\{TDD_APPLICABLE\.\.\.\} use to check ordering against\)/],
        ['a TDD_APPLICABLE use before the harness reference (#4266)', 'gsd-core/workflows/execute-phase.md',
          swap('**TDD-applicability resolution (#4266/#4272).**', 'echo "${TDD_APPLICABLE}"\n\n   **TDD-applicability resolution (#4266/#4272).**'), 'tdd-backend-wiring', /execute-phase\.md must reference the TDD-applicability resolution before every \$\{TDD_APPLICABLE\.\.\.\} use \(TDD_APPLICABLE is used at line \d+ before the reference to its resolution at line \d+\)/],
        ['the harness reference to the resolution fragment gone (#4266)', 'gsd-core/workflows/execute-phase.md',
          swap('TDD-applicability resolution (#4266/#4272)', 'TDD resolution (#4266/#4272)'), 'tdd-backend-wiring', /it has no one-line reference to tdd-applicability-resolution\.md/],
        ['no TDD_APPLICABLE use left in execute-phase.md (#4266)', 'gsd-core/workflows/execute-phase.md',
          eraseAll('${TDD_APPLICABLE'), 'tdd-backend-wiring', /execute-phase\.md must reference the TDD-applicability resolution before every \$\{TDD_APPLICABLE\.\.\.\} use \(it has no \$\{TDD_APPLICABLE\.\.\.\} use to check ordering against\)/],
        ['the literal Agent( dispatch line gone from execute-phase.md (#4266)', 'gsd-core/workflows/execute-phase.md',
          swap('\n   Agent(\n', '\n   Agent(x\n'), 'tdd-backend-wiring', /it has no literal Agent\( dispatch-call line/],
        ['the fragment is not referenced before the Agent( call (#4266)', 'gsd-core/workflows/execute-phase.md',
          eraseAll('execute-phase/steps/tdd-applicability-resolution.md'), 'tdd-backend-wiring', /the fragment is not referenced before the Agent\( call/],
        ['the MANDATORY pre-dispatch check gone from the fragment (#4266)', 'gsd-core/workflows/execute-phase/steps/tdd-applicability-resolution.md',
          eraseAll('MANDATORY'), 'tdd-backend-wiring', /it states no MANDATORY pre-dispatch check/],
        ['CONTEXT_WINDOW gone from the pre-dispatch check (#4266)', 'gsd-core/workflows/execute-phase/steps/tdd-applicability-resolution.md',
          eraseAll('CONTEXT_WINDOW'), 'tdd-backend-wiring', /the check does not name CONTEXT_WINDOW/],
        ['AGENT_SKILLS gone from the pre-dispatch check (#4266)', 'gsd-core/workflows/execute-phase/steps/tdd-applicability-resolution.md',
          eraseAll('AGENT_SKILLS'), 'tdd-backend-wiring', /the check does not name AGENT_SKILLS/],
        ['TDD_APPLICABLE gone from the pre-dispatch check (#4266)', 'gsd-core/workflows/execute-phase/steps/tdd-applicability-resolution.md',
          within('MANDATORY', '\n```', eraseAll('TDD_APPLICABLE')), 'tdd-backend-wiring', /the check does not name TDD_APPLICABLE/],
        ['the HALT instruction gone from the pre-dispatch check (#4266)', 'gsd-core/workflows/execute-phase/steps/tdd-applicability-resolution.md',
          erase(/halt/gi), 'tdd-backend-wiring', /the check does not instruct an explicit halt/],
        ['plan type: tdd gone from the harness embed comment (#4265)', 'gsd-core/workflows/execute-phase.md',
          swap('type: tdd, tdd="true"', 'tdd="true"'), 'tdd-backend-wiring', /execute-phase\.md: the tdd\.md embed-line comment must describe the same three sources \(#4265\) \(the comment lacks plan type: tdd/],
        ['tdd="true" gone from the harness embed comment (#4265)', 'gsd-core/workflows/execute-phase.md',
          swap('type: tdd, tdd="true", or', 'type: tdd, or'), 'tdd-backend-wiring', /execute-phase\.md: the tdd\.md embed-line comment must describe the same three sources \(#4265\) \(the comment lacks the tdd="true" task attribute/],
        ['the workflow.tdd_mode default gone from the harness embed comment (#4265)', 'gsd-core/workflows/execute-phase.md',
          swap('or workflow.tdd_mode', 'or the default'), 'tdd-backend-wiring', /execute-phase\.md: the tdd\.md embed-line comment must describe the same three sources \(#4265\) \(the comment lacks the workflow\.tdd_mode config default/],
        ['plan type: tdd gone from the worktree embed comment (#4265)', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md',
          swap('(plan type: tdd, a', '(a'), 'tdd-backend-wiring', /executor-isolation-dispatch\.md: the tdd\.md embed-line comment must describe the same three sources \(#4265\) \(the comment lacks plan type: tdd/],
        ['tdd="true" gone from the worktree embed comment (#4265)', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md',
          swap('a tdd="true" task, or', 'a task, or'), 'tdd-backend-wiring', /executor-isolation-dispatch\.md: the tdd\.md embed-line comment must describe the same three sources \(#4265\) \(the comment lacks the tdd="true" task attribute/],
        ['the workflow.tdd_mode config default gone from the worktree embed comment (#4265)', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md',
          swap('or workflow.tdd_mode config)', 'or the default)'), 'tdd-backend-wiring', /executor-isolation-dispatch\.md: the tdd\.md embed-line comment must describe the same three sources \(#4265\) \(the comment lacks the workflow\.tdd_mode config default/],
        ['the harness tdd.md embed entry no longer conditional (#3990)', 'gsd-core/workflows/execute-phase.md',
          swap("${TDD_APPLICABLE ? '- `~/.claude/gsd-core/references/tdd.md`'", "${TDD_APPLICABLE_X ? '- `~/.claude/gsd-core/references/tdd.md`'"), 'tdd-backend-wiring', /execute-phase\.md: the tdd\.md entry must stay conditional on TDD_APPLICABLE \(#3990\) \(the entry is not conditional/],
        ['the worktree tdd.md embed entry no longer conditional (#3990)', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md',
          swap('${TDD_APPLICABLE ? "- tdd.md"', '${TDD_APPLICABLE_X ? "- tdd.md"'), 'tdd-backend-wiring', /executor-isolation-dispatch\.md: the tdd\.md entry must stay conditional on TDD_APPLICABLE \(#3990\) \(the entry is not conditional/],
        ['no tdd.md embed entry left in execute-phase.md (#3990)', 'gsd-core/workflows/execute-phase.md',
          eraseAll('tdd.md'), 'tdd-backend-wiring', /execute-phase\.md: the tdd\.md embed-line comment must describe the same three sources \(#4265\) \(it lists no tdd\.md conditional embed entry/],
        ['the AGENT_SKILLS fail-closed check gone from the worktree backend (#3637)', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md',
          swap("grep -q '\\${AGENT_SKILLS}'", "grep -q 'x'"), 'tdd-backend-wiring', /it no longer carries the \$\{AGENT_SKILLS\} fail-closed check/],
        ['the TDD_APPLICABLE fail-closed check gone from the worktree backend (#4266)', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md',
          swap("grep -q '\\${TDD_APPLICABLE", "grep -q 'x"), 'tdd-backend-wiring', /it carries no fail-closed grep check for an unresolved \$\{TDD_APPLICABLE marker/],
        ['no FATAL message in the TDD_APPLICABLE check (#4266)', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md',
          within("grep -q '\\${TDD_APPLICABLE", '\nfi', eraseAll('FATAL:')), 'tdd-backend-wiring', /the check emits no FATAL message/],
        ['no exit 1 in the TDD_APPLICABLE check (#4266)', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md',
          within("grep -q '\\${TDD_APPLICABLE", '\nfi', eraseAll('exit 1')), 'tdd-backend-wiring', /the check does not exit 1/],
        ['the harness and worktree phase.tdd-applicable calls differ by one token (#4268)', 'gsd-core/workflows/execute-phase/steps/tdd-applicability-resolution.md',
          swap('--pick applicable 2>/dev/null)', '--pick applicable)'), 'tdd-backend-wiring', /the harness and worktree backends must issue byte-identical phase\.tdd-applicable command-substitution calls \(#4268\) \(the harness call is/],
        ['the worktree call line gone (#4268)', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md',
          swap('=$(gsd_run query phase.tdd-applicable', '=$(gsd_run query phase.tdd_applicable'), 'tdd-backend-wiring', /the harness and worktree backends must issue byte-identical phase\.tdd-applicable command-substitution calls \(#4268\) \(it carries no gsd_run query phase\.tdd-applicable assignment call/],
        ['the harness call line gone (#4268)', 'gsd-core/workflows/execute-phase/steps/tdd-applicability-resolution.md',
          swap('=$(gsd_run query phase.tdd-applicable', '=$(gsd_run query phase.tdd_applicable'), 'tdd-backend-wiring', /the harness backend must carry a gsd_run query phase\.tdd-applicable call \(it carries no gsd_run query phase\.tdd-applicable assignment call/],
        // cleanup-branch-pruning
        ['the prune_local_branches step renamed (#40)', 'gsd-core/workflows/cleanup.md',
          swap('<step name="prune_local_branches">', '<step name="prune_branches">'), 'cleanup-branch-pruning', /cleanup\.md must contain a <prune_local_branches> step \(the <prune_local_branches> block is missing\)/],
        ['git fetch --prune gone from show_dry_run (#40)', 'gsd-core/workflows/cleanup.md',
          within('<step name="show_dry_run">', '</step>', swap('git fetch --prune 2>/dev/null || true', 'git fetch 2>/dev/null || true')), 'cleanup-branch-pruning', /show_dry_run must run `git fetch --prune` so the candidate list matches the execution step \(it runs no git fetch --prune\)/],
        ['git fetch --prune re-run in prune_local_branches (#40)', 'gsd-core/workflows/cleanup.md',
          swap('| xargs -r git branch -D', '| xargs -r git branch -D\ngit fetch --prune'), 'cleanup-branch-pruning', /prune_local_branches must not re-run `git fetch --prune`[^]{0,80}\(it runs git fetch --prune\)/],
        ['git branch -vv gone from prune_local_branches (#40)', 'gsd-core/workflows/cleanup.md',
          within('<step name="prune_local_branches">', '</step>', swap('git branch -vv |', 'git branch |')), 'cleanup-branch-pruning', /prune_local_branches must run `git branch -vv` to find branches with a gone upstream \(it runs no git branch -vv\)/],
        ['git branch -D gone from prune_local_branches (#40)', 'gsd-core/workflows/cleanup.md',
          swap('xargs -r git branch -D', 'xargs -r git branch -d'), 'cleanup-branch-pruning', /prune_local_branches must run `git branch -D` to delete stale local branches \(it runs no git branch -D\)/],
        ['xargs -r gone from prune_local_branches (#40)', 'gsd-core/workflows/cleanup.md',
          within('<step name="prune_local_branches">', '</step>', eraseAll('xargs -r')), 'cleanup-branch-pruning', /prune_local_branches must use `xargs -r` to handle an empty branch list safely \(no xargs -r\)/],
        ['the archive_phases step renamed (#40)', 'gsd-core/workflows/cleanup.md',
          swap('<step name="archive_phases">', '<step name="archive_x">'), 'cleanup-branch-pruning', /prune_local_branches must appear between archive_phases and commit in <process> \(the archive_phases step is missing\)/],
        ['the commit step renamed (#40)', 'gsd-core/workflows/cleanup.md',
          swap('<step name="commit">', '<step name="commit_x">'), 'cleanup-branch-pruning', /prune_local_branches must appear between archive_phases and commit in <process> \(the commit step is missing\)/],
        ['prune_local_branches before archive_phases (#40)', 'gsd-core/workflows/cleanup.md',
          (text) => text.split('<step name="archive_phases">').join('<<A>>').split('<step name="prune_local_branches">').join('<step name="archive_phases">').split('<<A>>').join('<step name="prune_local_branches">'), 'cleanup-branch-pruning', /\(the order is not archive_phases, prune_local_branches, commit\)/],
        ['the gone-upstream mention gone from show_dry_run (#40)', 'gsd-core/workflows/cleanup.md',
          within('<step name="show_dry_run">', '</step>', eraseAll('gone')), 'cleanup-branch-pruning', /show_dry_run must mention gone-upstream branches in the dry-run summary \(no gone-upstream mention\)/],
        ['pruning gone from the show_dry_run prompt (#40)', 'gsd-core/workflows/cleanup.md',
          within('<step name="show_dry_run">', '</step>', erase(/prune|branch/g)), 'cleanup-branch-pruning', /the confirmation prompt must cover both phase archival and branch pruning/],
        ['archiving gone from the show_dry_run prompt (#40)', 'gsd-core/workflows/cleanup.md',
          within('<step name="show_dry_run">', '</step>', eraseAll('archive')), 'cleanup-branch-pruning', /the confirmation prompt must cover both phase archival and branch pruning/],
        ['the pruned count gone from the report (#40)', 'gsd-core/workflows/cleanup.md',
          within('<step name="report">', '</step>', erase(/[Pp]runed/g)), 'cleanup-branch-pruning', /the report step must include the pruned-branch count in the final summary \(no pruned count\)/],
        ['the current-branch guard gone from the awk filter (#40)', 'gsd-core/workflows/cleanup.md',
          within('<step name="prune_local_branches">', '</step>', swap('$1 !~', '$1 ~')), 'cleanup-branch-pruning', /must explicitly exclude the current-branch marker[^]{0,80}\(no guard against the \* marker\)/],
        ['a git branch command in identify_completed_milestones (#40)', 'gsd-core/workflows/cleanup.md',
          within('<step name="identify_completed_milestones">', '</step>', (section) => `${section}\n\`\`\`bash\ngit branch -vv\n\`\`\`\n`), 'cleanup-branch-pruning', /identify_completed_milestones must not run git branch commands[^]{0,60}\(it runs a git branch command\)/],
        ['main no longer excluded from the awk filter (#40)', 'gsd-core/workflows/cleanup.md',
          within('<step name="prune_local_branches">', '</step>', swap('^main$', '^zzz$')), 'cleanup-branch-pruning', /the prune_local_branches awk must exclude "main" from the deletion candidates \(main is not excluded\)/],
        ['neither next nor trunk excluded from the awk filter (#40)', 'gsd-core/workflows/cleanup.md',
          within('<step name="prune_local_branches">', '</step>', (section) => swap('^trunk$', '^xxx$')(swap('^next$', '^yyy$')(section))), 'cleanup-branch-pruning', /the prune_local_branches awk must exclude the integration branch names \(next or trunk\) \(neither next nor trunk is excluded\)/],
        ['mv gone from archive_phases (#40)', 'gsd-core/workflows/cleanup.md',
          within('<step name="archive_phases">', '</step>', eraseAll('mv')), 'cleanup-branch-pruning', /the original archive_phases step must still exist and move phase directories \(it no longer moves phase directories under \.planning\/phases\/\)/],
        ['the phases path gone from archive_phases (#40)', 'gsd-core/workflows/cleanup.md',
          within('<step name="archive_phases">', '</step>', eraseAll('phases/')), 'cleanup-branch-pruning', /the original archive_phases step must still exist and move phase directories/],
        ['the show_dry_run step renamed (#40)', 'gsd-core/workflows/cleanup.md',
          swap('<step name="show_dry_run">', '<step name="dry_run">'), 'cleanup-branch-pruning', /the <show_dry_run> block is missing/],
        ['the report step renamed (#40)', 'gsd-core/workflows/cleanup.md',
          swap('<step name="report">', '<step name="summary">'), 'cleanup-branch-pruning', /the <report> block is missing/],
        ['the identify_completed_milestones step renamed (#40)', 'gsd-core/workflows/cleanup.md',
          swap('<step name="identify_completed_milestones">', '<step name="identify_milestones">'), 'cleanup-branch-pruning', /the <identify_completed_milestones> block is missing/],
        ['the process block renamed (#40)', 'gsd-core/workflows/cleanup.md',
          swap('<process>', '<procedure>'), 'cleanup-branch-pruning', /the <process> block is missing/],
        ['the isolation="worktree" marker gone from execute-phase.md (#1571)', 'gsd-core/workflows/execute-phase.md',
          eraseAll('isolation="worktree"'), 'execute-phase-worktree-artifacts', /\(the isolation="worktree" marker is missing\)/],
        ['the initialize step of code-review.md renamed (#3727)', 'gsd-core/workflows/code-review.md',
          swap('<step name="initialize">', '<step name="init">'), 'code-review-flags', /the workflow has no initialize step/],
        ['the initialize step no longer names code-review-flags.cjs (#3727)', 'gsd-core/workflows/code-review.md',
          within('<step name="initialize">', '</step>', eraseAll('code-review-flags.cjs')), 'code-review-flags', /the initialize step must reference code-review-flags\.cjs to parse the --fix\/--all\/--auto flags \(the initialize step does not name it\)/],
        ['the gated dispatch-fix section marker gone (#3727)', 'gsd-core/workflows/code-review.md',
          eraseAll('<!-- gsd:section id="dispatch-fix" when="flag:--fix" -->'), 'code-review-flags', /code-review\.md must gate a dispatch-fix section on flag:--fix/],
        ['the dispatch-fix step file pointer gone from code-review.md (#3727)', 'gsd-core/workflows/code-review.md',
          eraseAll('gsd-core/workflows/code-review/steps/dispatch-fix.md'), 'code-review-flags', /the gated dispatch-fix section must point at the dispatch-fix\.md step file/],
        ['the dispatch_fix step gone from its step file (#3727)', 'gsd-core/workflows/code-review/steps/dispatch-fix.md',
          eraseAll('<step name="dispatch_fix">'), 'code-review-flags', /the dispatch-fix\.md step file must contain the dispatch_fix step/],
        ['code-review-fix.md gone from the dispatch_fix step (#3727)', 'gsd-core/workflows/code-review/steps/dispatch-fix.md',
          eraseAll('code-review-fix.md'), 'code-review-flags', /the dispatch_fix step must reference the code-review-fix\.md workflow/],
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
    passes('Gate 2: status: error alone suffices', 'gsd-core/workflows/next.md', eraseAll('status: failed'), 'next-safety-gates');
    passes('Gate 2: status: failed alone suffices', 'gsd-core/workflows/next.md', eraseAll('status: error'), 'next-safety-gates');
    passes('completeness scan: Plans without summaries alone suffices', 'gsd-core/workflows/next.md', eraseAll('no SUMMARY.md'), 'next-safety-gates');
    passes('completeness scan: no SUMMARY.md alone suffices', 'gsd-core/workflows/next.md', eraseAll('Plans without summaries'), 'next-safety-gates');
    passes('completeness scan: Verification failures not overridden alone suffices', 'gsd-core/workflows/next.md', eraseAll('VERIFICATION.md with `FAIL`'), 'next-safety-gates');
    passes('completeness scan: VERIFICATION.md with `FAIL` alone suffices', 'gsd-core/workflows/next.md', eraseAll('Verification failures not overridden'), 'next-safety-gates');
    passes('completeness scan: CONTEXT.md without plans alone suffices', 'gsd-core/workflows/next.md', eraseAll('CONTEXT.md but no PLAN.md'), 'next-safety-gates');
    passes('completeness scan: CONTEXT.md but no PLAN.md alone suffices', 'gsd-core/workflows/next.md', eraseAll('CONTEXT.md without plans'), 'next-safety-gates');
    passes('deferral: Backlog alone suffices', 'gsd-core/workflows/next.md', eraseAll('BACKLOG'), 'next-safety-gates');
    passes('deferral: BACKLOG alone suffices', 'gsd-core/workflows/next.md', eraseAll('Backlog'), 'next-safety-gates');
    passes('clean prior phases: silently alone suffices', 'gsd-core/workflows/next.md', eraseAll('no interruption'), 'next-safety-gates');
    passes('clean prior phases: no interruption alone suffices', 'gsd-core/workflows/next.md', eraseAll('silently'), 'next-safety-gates');
    passes('progress.md: next workflow alone documents the routing', 'commands/gsd/progress.md', (text) => text.replace(/scans? all prior phases/gi, 'x'), 'next-safety-gates');
    passes('progress.md: scans all prior phases alone documents the routing', 'commands/gsd/progress.md', (text) => text.replace(/next workflow/gi, 'x'), 'next-safety-gates');
    // contributor-standards reads CONTEXT.md: every case here copies the heavy files.
    test('the CONTEXT.md heading of the standards doc renamed', (t) => {
      const root = copyOfRepoFiles(t, HEAVY);
      for (const [rel, edit] of [['docs/contributor-standards.md', swap('## CONTEXT.md', '## Notes')]]) {
        const abs = path.join(root, ...rel.split('/'));
        const before = fs.readFileSync(abs, 'utf8');
        const after = edit(before);
        assert.notEqual(after, before, 'the edit changed the file');
        fs.writeFileSync(abs, after);
      }
      const findings = runShipped(root, ['contributor-standards']);
      assert.ok(findings.some((f) => /has required CONTEXT\.md section/.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
    });
    test('the ADRs heading of the standards doc renamed', (t) => {
      const root = copyOfRepoFiles(t, HEAVY);
      for (const [rel, edit] of [['docs/contributor-standards.md', swap('## ADRs', '## Records')]]) {
        const abs = path.join(root, ...rel.split('/'));
        const before = fs.readFileSync(abs, 'utf8');
        const after = edit(before);
        assert.notEqual(after, before, 'the edit changed the file');
        fs.writeFileSync(abs, after);
      }
      const findings = runShipped(root, ['contributor-standards']);
      assert.ok(findings.some((f) => /has required ADR section/.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
    });
    test('the AI-agent heading of the standards doc renamed', (t) => {
      const root = copyOfRepoFiles(t, HEAVY);
      for (const [rel, edit] of [['docs/contributor-standards.md', swap('## AI-agent-assisted work', '## Work')]]) {
        const abs = path.join(root, ...rel.split('/'));
        const before = fs.readFileSync(abs, 'utf8');
        const after = edit(before);
        assert.notEqual(after, before, 'the edit changed the file');
        fs.writeFileSync(abs, after);
      }
      const findings = runShipped(root, ['contributor-standards']);
      assert.ok(findings.some((f) => /has required AI-agent section/.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
    });
    test('every CONTEXT.md reference removed from the standards doc', (t) => {
      const root = copyOfRepoFiles(t, HEAVY);
      for (const [rel, edit] of [['docs/contributor-standards.md', eraseAll('CONTEXT.md')]]) {
        const abs = path.join(root, ...rel.split('/'));
        const before = fs.readFileSync(abs, 'utf8');
        const after = edit(before);
        assert.notEqual(after, before, 'the edit changed the file');
        fs.writeFileSync(abs, after);
      }
      const findings = runShipped(root, ['contributor-standards']);
      assert.ok(findings.some((f) => /docs\/contributor-standards\.md must reference CONTEXT\.md/.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
    });
    test('every docs/adr/ reference removed from the standards doc', (t) => {
      const root = copyOfRepoFiles(t, HEAVY);
      for (const [rel, edit] of [['docs/contributor-standards.md', eraseAll('docs/adr/')]]) {
        const abs = path.join(root, ...rel.split('/'));
        const before = fs.readFileSync(abs, 'utf8');
        const after = edit(before);
        assert.notEqual(after, before, 'the edit changed the file');
        fs.writeFileSync(abs, after);
      }
      const findings = runShipped(root, ['contributor-standards']);
      assert.ok(findings.some((f) => /docs\/contributor-standards\.md must reference docs\/adr\//.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
    });
    test('the backticks of the CONTEXT.md section removed', (t) => {
      const root = copyOfRepoFiles(t, HEAVY);
      for (const [rel, edit] of [['docs/contributor-standards.md', within('## CONTEXT.md', '## ADRs', (section) => section.split('`').join(''))]]) {
        const abs = path.join(root, ...rel.split('/'));
        const before = fs.readFileSync(abs, 'utf8');
        const after = edit(before);
        assert.notEqual(after, before, 'the edit changed the file');
        fs.writeFileSync(abs, after);
      }
      const findings = runShipped(root, ['contributor-standards']);
      assert.ok(findings.some((f) => /the standards doc must name at least one CONTEXT\.md heading/.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
    });
    test('an ADR body heading named in the CONTEXT.md section', (t) => {
      const root = copyOfRepoFiles(t, HEAVY);
      for (const [rel, edit] of [['docs/contributor-standards.md', within('## CONTEXT.md', '## ADRs', (section) => section + '\nSee `## Decision` for the body.\n')]]) {
        const abs = path.join(root, ...rel.split('/'));
        const before = fs.readFileSync(abs, 'utf8');
        const after = edit(before);
        assert.notEqual(after, before, 'the edit changed the file');
        fs.writeFileSync(abs, after);
      }
      const findings = runShipped(root, ['contributor-standards']);
      assert.ok(findings.some((f) => /must not treat ADR or PR body headings as CONTEXT\.md claims/.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
    });
    test('a PR body heading named in the CONTEXT.md section', (t) => {
      const root = copyOfRepoFiles(t, HEAVY);
      for (const [rel, edit] of [['docs/contributor-standards.md', within('## CONTEXT.md', '## ADRs', (section) => section + '\nSee `## Standards followed` for the body.\n')]]) {
        const abs = path.join(root, ...rel.split('/'));
        const before = fs.readFileSync(abs, 'utf8');
        const after = edit(before);
        assert.notEqual(after, before, 'the edit changed the file');
        fs.writeFileSync(abs, after);
      }
      const findings = runShipped(root, ['contributor-standards']);
      assert.ok(findings.some((f) => /must not treat ADR or PR body headings as CONTEXT\.md claims/.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
    });
    test('a heading that CONTEXT.md does not have named in the section', (t) => {
      const root = copyOfRepoFiles(t, HEAVY);
      for (const [rel, edit] of [['docs/contributor-standards.md', within('## CONTEXT.md', '## ADRs', (section) => section + '\nAdd it under `## Phantom section`.\n')]]) {
        const abs = path.join(root, ...rel.split('/'));
        const before = fs.readFileSync(abs, 'utf8');
        const after = edit(before);
        assert.notEqual(after, before, 'the edit changed the file');
        fs.writeFileSync(abs, after);
      }
      const findings = runShipped(root, ['contributor-standards']);
      assert.ok(findings.some((f) => /every CONTEXT\.md heading named by the standards doc must exist in CONTEXT\.md/.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
    });
    test('a six-hash reference whose CONTEXT.md heading has seven hashes', (t) => {
      const root = copyOfRepoFiles(t, HEAVY);
      for (const [rel, edit] of [['docs/contributor-standards.md', within('## CONTEXT.md', '## ADRs', (section) => section + '\nSee `###### Deep`.\n')], ['CONTEXT.md', append('####### Deep')]]) {
        const abs = path.join(root, ...rel.split('/'));
        const before = fs.readFileSync(abs, 'utf8');
        const after = edit(before);
        assert.notEqual(after, before, 'the edit changed the file');
        fs.writeFileSync(abs, after);
      }
      const findings = runShipped(root, ['contributor-standards']);
      assert.ok(findings.some((f) => /every CONTEXT\.md heading named by the standards doc must exist in CONTEXT\.md/.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
    });
    test('the glossary heading of CONTEXT.md renamed', (t) => {
      const root = copyOfRepoFiles(t, HEAVY);
      for (const [rel, edit] of [['CONTEXT.md', swap('## Glossary — Domain modules and seams', '## Glossary')]]) {
        const abs = path.join(root, ...rel.split('/'));
        const before = fs.readFileSync(abs, 'utf8');
        const after = edit(before);
        assert.notEqual(after, before, 'the edit changed the file');
        fs.writeFileSync(abs, after);
      }
      const findings = runShipped(root, ['contributor-standards']);
      assert.ok(findings.some((f) => /the glossary heading is the one the standards doc points Module authors at/.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
    });
    test('the Test rules and lint section of CONTEXT.md renamed', (t) => {
      const root = copyOfRepoFiles(t, HEAVY);
      for (const [rel, edit] of [['CONTEXT.md', swap('## Test rules and lint', '## Test rules')]]) {
        const abs = path.join(root, ...rel.split('/'));
        const before = fs.readFileSync(abs, 'utf8');
        const after = edit(before);
        assert.notEqual(after, before, 'the edit changed the file');
        fs.writeFileSync(abs, after);
      }
      const findings = runShipped(root, ['contributor-standards']);
      assert.ok(findings.some((f) => /RULESET\.EMITTED_ATTRIBUTION must be a sibling of the other test rules/.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
    });
    test('the emitted-attribution ruleset removed from CONTEXT.md', (t) => {
      const root = copyOfRepoFiles(t, HEAVY);
      for (const [rel, edit] of [['CONTEXT.md', eraseAll('RULESET.EMITTED_ATTRIBUTION=')]]) {
        const abs = path.join(root, ...rel.split('/'));
        const before = fs.readFileSync(abs, 'utf8');
        const after = edit(before);
        assert.notEqual(after, before, 'the edit changed the file');
        fs.writeFileSync(abs, after);
      }
      const findings = runShipped(root, ['contributor-standards']);
      assert.ok(findings.some((f) => /RULESET\.EMITTED_ATTRIBUTION must be a sibling of the other test rules/.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
    });
    test('the glossary section of CONTEXT.md renamed so the provenance entry leaves it', (t) => {
      const root = copyOfRepoFiles(t, HEAVY);
      for (const [rel, edit] of [['CONTEXT.md', swap('## Glossary — Domain modules and seams', '## Glossary')]]) {
        const abs = path.join(root, ...rel.split('/'));
        const before = fs.readFileSync(abs, 'utf8');
        const after = edit(before);
        assert.notEqual(after, before, 'the edit changed the file');
        fs.writeFileSync(abs, after);
      }
      const findings = runShipped(root, ['contributor-standards']);
      assert.ok(findings.some((f) => /the emitted-artifact family must be registered in the glossary/.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
    });
    test('the provenance entry renamed in CONTEXT.md', (t) => {
      const root = copyOfRepoFiles(t, HEAVY);
      for (const [rel, edit] of [['CONTEXT.md', swap('### Emitted Artifact Provenance', '### Emitted Provenance')]]) {
        const abs = path.join(root, ...rel.split('/'));
        const before = fs.readFileSync(abs, 'utf8');
        const after = edit(before);
        assert.notEqual(after, before, 'the edit changed the file');
        fs.writeFileSync(abs, after);
      }
      const findings = runShipped(root, ['contributor-standards']);
      assert.ok(findings.some((f) => /the emitted-artifact family must be registered in the glossary/.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
    });
    test('a Module-suffixed provenance heading added to CONTEXT.md', (t) => {
      const root = copyOfRepoFiles(t, HEAVY);
      for (const [rel, edit] of [['CONTEXT.md', append('### Emitted Artifact Provenance Module')]]) {
        const abs = path.join(root, ...rel.split('/'));
        const before = fs.readFileSync(abs, 'utf8');
        const after = edit(before);
        assert.notEqual(after, before, 'the edit changed the file');
        fs.writeFileSync(abs, after);
      }
      const findings = runShipped(root, ['contributor-standards']);
      assert.ok(findings.some((f) => /Emitted Artifact Provenance is a concept, not a module/.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
    });
    test('CONTRIBUTING.md no longer links the standards doc', (t) => {
      const root = copyOfRepoFiles(t, HEAVY);
      for (const [rel, edit] of [['CONTRIBUTING.md', eraseAll('contributor-standards.md')]]) {
        const abs = path.join(root, ...rel.split('/'));
        const before = fs.readFileSync(abs, 'utf8');
        const after = edit(before);
        assert.notEqual(after, before, 'the edit changed the file');
        fs.writeFileSync(abs, after);
      }
      const findings = runShipped(root, ['contributor-standards']);
      assert.ok(findings.some((f) => /CONTRIBUTING\.md must link to docs\/contributor-standards\.md/.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
    });
    test('both documents checked out with CRLF line endings', (t) => {
      const root = copyOfRepoFiles(t, HEAVY);
      for (const [rel, edit] of [['docs/contributor-standards.md', (text) => text.split('\n').join('\r\n')], ['CONTEXT.md', (text) => text.split('\n').join('\r\n')]]) {
        const abs = path.join(root, ...rel.split('/'));
        const before = fs.readFileSync(abs, 'utf8');
        const after = edit(before);
        assert.notEqual(after, before, 'the edit changed the file');
        fs.writeFileSync(abs, after);
      }
      assert.deepEqual(runShipped(root, ['contributor-standards']), []);
    });
    test('a one-hash backticked reference is not a heading reference', (t) => {
      const root = copyOfRepoFiles(t, HEAVY);
      for (const [rel, edit] of [['docs/contributor-standards.md', within('## CONTEXT.md', '## ADRs', (section) => section + '\nNot a heading: `# Phantom`.\n')]]) {
        const abs = path.join(root, ...rel.split('/'));
        const before = fs.readFileSync(abs, 'utf8');
        const after = edit(before);
        assert.notEqual(after, before, 'the edit changed the file');
        fs.writeFileSync(abs, after);
      }
      assert.deepEqual(runShipped(root, ['contributor-standards']), []);
    });
    test('a seven-hash backticked reference is not a heading reference', (t) => {
      const root = copyOfRepoFiles(t, HEAVY);
      for (const [rel, edit] of [['docs/contributor-standards.md', within('## CONTEXT.md', '## ADRs', (section) => section + '\nNot a heading: `####### Phantom`.\n')]]) {
        const abs = path.join(root, ...rel.split('/'));
        const before = fs.readFileSync(abs, 'utf8');
        const after = edit(before);
        assert.notEqual(after, before, 'the edit changed the file');
        fs.writeFileSync(abs, after);
      }
      assert.deepEqual(runShipped(root, ['contributor-standards']), []);
    });
    test('a placeholder heading is skipped', (t) => {
      const root = copyOfRepoFiles(t, HEAVY);
      for (const [rel, edit] of [['docs/contributor-standards.md', within('## CONTEXT.md', '## ADRs', (section) => section + '\nA template: `### <Phantom Name>`.\n')]]) {
        const abs = path.join(root, ...rel.split('/'));
        const before = fs.readFileSync(abs, 'utf8');
        const after = edit(before);
        assert.notEqual(after, before, 'the edit changed the file');
        fs.writeFileSync(abs, after);
      }
      assert.deepEqual(runShipped(root, ['contributor-standards']), []);
    });
    test('a foreign heading named outside the CONTEXT.md section is not a claim', (t) => {
      const root = copyOfRepoFiles(t, HEAVY);
      for (const [rel, edit] of [['docs/contributor-standards.md', append('See `## Phantom outside` in the ADR body.')]]) {
        const abs = path.join(root, ...rel.split('/'));
        const before = fs.readFileSync(abs, 'utf8');
        const after = edit(before);
        assert.notEqual(after, before, 'the edit changed the file');
        fs.writeFileSync(abs, after);
      }
      assert.deepEqual(runShipped(root, ['contributor-standards']), []);
    });
    test('the CONTEXT.md section heading with trailing blanks', (t) => {
      const root = copyOfRepoFiles(t, HEAVY);
      for (const [rel, edit] of [['docs/contributor-standards.md', swap('## CONTEXT.md\n', '## CONTEXT.md   \n')]]) {
        const abs = path.join(root, ...rel.split('/'));
        const before = fs.readFileSync(abs, 'utf8');
        const after = edit(before);
        assert.notEqual(after, before, 'the edit changed the file');
        fs.writeFileSync(abs, after);
      }
      assert.deepEqual(runShipped(root, ['contributor-standards']), []);
    });
    test('a six-hash reference whose CONTEXT.md heading has six hashes', (t) => {
      const root = copyOfRepoFiles(t, HEAVY);
      for (const [rel, edit] of [['docs/contributor-standards.md', within('## CONTEXT.md', '## ADRs', (section) => section + '\nSee `###### Deep`.\n')], ['CONTEXT.md', append('###### Deep')]]) {
        const abs = path.join(root, ...rel.split('/'));
        const before = fs.readFileSync(abs, 'utf8');
        const after = edit(before);
        assert.notEqual(after, before, 'the edit changed the file');
        fs.writeFileSync(abs, after);
      }
      assert.deepEqual(runShipped(root, ['contributor-standards']), []);
    });
    test('a heading whose hashes are followed by a tab', (t) => {
      const root = copyOfRepoFiles(t, HEAVY);
      for (const [rel, edit] of [['docs/contributor-standards.md', within('## CONTEXT.md', '## ADRs', (section) => section + '\nSee `##\tTabbed`.\n')], ['CONTEXT.md', append('##\tTabbed')]]) {
        const abs = path.join(root, ...rel.split('/'));
        const before = fs.readFileSync(abs, 'utf8');
        const after = edit(before);
        assert.notEqual(after, before, 'the edit changed the file');
        fs.writeFileSync(abs, after);
      }
      assert.deepEqual(runShipped(root, ['contributor-standards']), []);
    });
    passes('a finalize cap at the rc budget', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs.finalize['timeout-minutes'] = 30; }), 'release-backmerge-invariants');
    passes('a finalize cap above the rc budget', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs.finalize['timeout-minutes'] = 31; }), 'release-backmerge-invariants');
    passes('a job whose needs is the validate-version string', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['rc-coverage-gate'].needs = 'validate-version'; }), 'release-backmerge-invariants');
    passes('an Open or update PR step with no gate', '.github/workflows/auto-backmerge.yml', yamlEdit((w) => { delete w.jobs.backmerge.steps.find((s) => s.name === 'Open or update PR').if; }), 'release-backmerge-invariants');
    passes('a gate on a longer name that merely starts with outcome', '.github/workflows/auto-backmerge.yml', yamlEdit((w) => { w.jobs.backmerge.steps.find((s) => s.name === 'Open or update PR').if = "steps.sync.outcomes != 'x'"; }), 'release-backmerge-invariants');
    passes('a gate on a longer name that merely starts with conclusion', '.github/workflows/auto-backmerge.yml', yamlEdit((w) => { w.jobs.backmerge.steps.find((s) => s.name === 'Open or update PR').if = "steps.sync.conclusion_x != 'x'"; }), 'release-backmerge-invariants');
    passes('a reconcile step with extra blanks between the words', '.github/workflows/auto-backmerge.yml', swap('git merge -s ours', 'git merge  \t-s   ours'), 'release-backmerge-invariants');
    passes('a reconcile merge command in a longer word', '.github/workflows/auto-backmerge.yml', swap('git merge -s ours', 'git xmerge -s oursy'), 'release-backmerge-invariants');
    passes('the back-merge step renamed with the same words around', '.github/workflows/auto-backmerge.yml', swap('Merge the back-merge PR as a merge commit', 'Merge the back-merge PR as a merge commit (admin)'), 'release-backmerge-invariants');
    passes('ja-JP FEATURES.md: a lower-case cursor alone suffices', 'docs/ja-JP/FEATURES.md', (text) => text.replace(/Cursor/g, 'cursor'), 'cursor-reviewer');
    passes('ko-KR FEATURES.md: a lower-case cursor alone suffices', 'docs/ko-KR/FEATURES.md', (text) => text.replace(/Cursor/g, 'cursor'), 'cursor-reviewer');
    passes('a pipe into cursor-agent is the single binary, not a cursor command', 'gsd-core/workflows/review.md', append('cat prompt.md | cursor-agent -p'), 'cursor-reviewer');
    passes('a pipe with no blank into cursor-agent', 'gsd-core/workflows/review.md', append('cat prompt.md |cursor-agent -p'), 'cursor-reviewer');
    passes('the words cursor agent with no trailing blank', 'gsd-core/workflows/review.md', append('cursor agent'), 'cursor-reviewer');
    passes('a second reviewers key without cursor does not hide the first', 'gsd-core/workflows/review.md', append('reviewers: [claude]'), 'cursor-reviewer');
    passes('cursor kept only on the refused_reviewers line', 'gsd-core/workflows/review.md', (text) => text.split('qwen, cursor, antigravity').join('qwen, antigravity') + '\nrefused_reviewers: [cursor]\n', 'cursor-reviewer');
    test('a workflow that uses AskUserQuestion with no fallback', (t) => {
      const root = copyOfRepoFiles(t);
      write(root, 'gsd-core/workflows/zz-fixture.md', 'Use AskUserQuestion to ask.\n');
      const findings = runShipped(root, ['ask-user-questions-fallback']);
      assert.ok(findings.some((f) => /every workflow that uses AskUserQuestion must include a TEXT_MODE fallback/.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
    });
    test('a workflow with TEXT_MODE but no plain-text wording', (t) => {
      const root = copyOfRepoFiles(t);
      write(root, 'gsd-core/workflows/zz-fixture.md', 'Use AskUserQuestion. TEXT_MODE is mentioned.\n');
      const findings = runShipped(root, ['ask-user-questions-fallback']);
      assert.ok(findings.some((f) => /every workflow that uses AskUserQuestion must include a TEXT_MODE fallback/.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
    });
    test('a workflow with plain text wording but no text mode', (t) => {
      const root = copyOfRepoFiles(t);
      write(root, 'gsd-core/workflows/zz-fixture.md', 'Use AskUserQuestion. Reply in plain text.\n');
      const findings = runShipped(root, ['ask-user-questions-fallback']);
      assert.ok(findings.some((f) => /every workflow that uses AskUserQuestion must include a TEXT_MODE fallback/.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
    });
    test('a workflow with TEXT_MODE and plain-text wording', (t) => {
      const root = copyOfRepoFiles(t);
      write(root, 'gsd-core/workflows/zz-fixture.md', 'Use AskUserQuestion. When TEXT_MODE is set, use a plain-text list.\n');
      const findings = runShipped(root, ['ask-user-questions-fallback']);
      assert.deepEqual(findings, []);
    });
    test('a workflow with the text_mode key and a numbered list', (t) => {
      const root = copyOfRepoFiles(t);
      write(root, 'gsd-core/workflows/zz-fixture.md', 'Use AskUserQuestion. When text_mode is true, print a numbered list.\n');
      const findings = runShipped(root, ['ask-user-questions-fallback']);
      assert.deepEqual(findings, []);
    });
    test('a workflow with the words text mode and plain text in any case', (t) => {
      const root = copyOfRepoFiles(t);
      write(root, 'gsd-core/workflows/zz-fixture.md', 'Use AskUserQuestion. In Text Mode, answer in Plain Text.\n');
      const findings = runShipped(root, ['ask-user-questions-fallback']);
      assert.deepEqual(findings, []);
    });
    test('a workflow that does not use AskUserQuestion', (t) => {
      const root = copyOfRepoFiles(t);
      write(root, 'gsd-core/workflows/zz-fixture.md', 'Ask the user a question in prose.\n');
      const findings = runShipped(root, ['ask-user-questions-fallback']);
      assert.deepEqual(findings, []);
    });
    test('a nested step file that uses AskUserQuestion with no fallback is not a top-level workflow', (t) => {
      const root = copyOfRepoFiles(t);
      write(root, 'gsd-core/workflows/zz-steps/step.md', 'Use AskUserQuestion to ask.\n');
      const findings = runShipped(root, ['ask-user-questions-fallback']);
      assert.deepEqual(findings, []);
    });
    test('an options array with four labels', (t) => {
      const root = copyOfRepoFiles(t);
      write(root, 'gsd-core/workflows/zz-fixture.md', 'TEXT_MODE plain-text fallback.\nAskUserQuestion([\n  {\n    question: "Pick one",\n    options: [\n      { label: "L1", description: "d" },\n      { label: "L2", description: "d" },\n      { label: "L3", description: "d" },\n      { label: "L4", description: "d" }\n    ]\n  }\n])\n');
      const findings = runShipped(root, ['ask-user-questions-fallback']);
      assert.deepEqual(findings, []);
    });
    test('an options array with five labels', (t) => {
      const root = copyOfRepoFiles(t);
      write(root, 'gsd-core/workflows/zz-fixture.md', 'TEXT_MODE plain-text fallback.\nAskUserQuestion([\n  {\n    question: "Pick one",\n    options: [\n      { label: "L1", description: "d" },\n      { label: "L2", description: "d" },\n      { label: "L3", description: "d" },\n      { label: "L4", description: "d" },\n      { label: "L5", description: "d" }\n    ]\n  }\n])\n');
      const findings = runShipped(root, ['ask-user-questions-fallback']);
      assert.ok(findings.some((f) => /every AskUserQuestion options array must have at most 4 options/.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
    });
    test('an options array with five labels in a nested step file', (t) => {
      const root = copyOfRepoFiles(t);
      write(root, 'gsd-core/workflows/zz-steps/step.md', 'AskUserQuestion([\n  {\n    question: "Pick one",\n    options: [\n      { label: "L1", description: "d" },\n      { label: "L2", description: "d" },\n      { label: "L3", description: "d" },\n      { label: "L4", description: "d" },\n      { label: "L5", description: "d" }\n    ]\n  }\n])\n');
      const findings = runShipped(root, ['ask-user-questions-fallback']);
      assert.ok(findings.some((f) => /every AskUserQuestion options array must have at most 4 options/.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
    });
    test('five labels where one has an empty value counts four', (t) => {
      const root = copyOfRepoFiles(t);
      write(root, 'gsd-core/workflows/zz-fixture.md', 'TEXT_MODE plain-text fallback.\nAskUserQuestion([\n  {\n    question: "Pick one",\n    options: [\n      { label: "L1", description: "d" },\n      { label: "L2", description: "d" },\n      { label: "L3", description: "d" },\n      { label: "L4", description: "d" },\n      { label: "", description: "d" }\n    ]\n  }\n])\n');
      const findings = runShipped(root, ['ask-user-questions-fallback']);
      assert.deepEqual(findings, []);
    });
    test('five entries where one key is labels counts four', (t) => {
      const root = copyOfRepoFiles(t);
      write(root, 'gsd-core/workflows/zz-fixture.md', 'TEXT_MODE plain-text fallback.\nAskUserQuestion([\n  {\n    question: "Pick one",\n    options: [\n      { label: "L1", description: "d" },\n      { label: "L2", description: "d" },\n      { label: "L3", description: "d" },\n      { label: "L4", description: "d" },\n      { labels: "x", description: "d" }\n    ]\n  }\n])\n');
      const findings = runShipped(root, ['ask-user-questions-fallback']);
      assert.deepEqual(findings, []);
    });
    test('five entries where one key has a word character before label counts four', (t) => {
      const root = copyOfRepoFiles(t);
      write(root, 'gsd-core/workflows/zz-fixture.md', 'TEXT_MODE plain-text fallback.\nAskUserQuestion([\n  {\n    question: "Pick one",\n    options: [\n      { label: "L1", description: "d" },\n      { label: "L2", description: "d" },\n      { label: "L3", description: "d" },\n      { label: "L4", description: "d" },\n      { xlabel: "x", description: "d" }\n    ]\n  }\n])\n');
      const findings = runShipped(root, ['ask-user-questions-fallback']);
      assert.deepEqual(findings, []);
    });
    test('a fifth label written with blanks around the colon', (t) => {
      const root = copyOfRepoFiles(t);
      write(root, 'gsd-core/workflows/zz-fixture.md', 'TEXT_MODE plain-text fallback.\nAskUserQuestion([\n  {\n    question: "Pick one",\n    options: [\n      { label: "L1", description: "d" },\n      { label: "L2", description: "d" },\n      { label: "L3", description: "d" },\n      { label: "L4", description: "d" },\n      { label  :   "L5", description: "d" }\n    ]\n  }\n])\n');
      const findings = runShipped(root, ['ask-user-questions-fallback']);
      assert.ok(findings.some((f) => /every AskUserQuestion options array must have at most 4 options/.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
    });
    test('the call written with blanks before the paren and bracket', (t) => {
      const root = copyOfRepoFiles(t);
      write(root, 'gsd-core/workflows/zz-fixture.md', 'TEXT_MODE plain-text fallback.\nAskUserQuestion  (  [\n  {\n    question: "Pick one",\n    options: [\n      { label: "L1", description: "d" },\n      { label: "L2", description: "d" },\n      { label: "L3", description: "d" },\n      { label: "L4", description: "d" },\n      { label: "L5", description: "d" }\n    ]\n  }\n])\n');
      const findings = runShipped(root, ['ask-user-questions-fallback']);
      assert.ok(findings.some((f) => /every AskUserQuestion options array must have at most 4 options/.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
    });
    test('a longer word that ends in AskUserQuestion is not the call', (t) => {
      const root = copyOfRepoFiles(t);
      write(root, 'gsd-core/workflows/zz-fixture.md', 'TEXT_MODE plain-text fallback.\nxAskUserQuestion([\n  {\n    question: "Pick one",\n    options: [\n      { label: "L1", description: "d" },\n      { label: "L2", description: "d" },\n      { label: "L3", description: "d" },\n      { label: "L4", description: "d" },\n      { label: "L5", description: "d" }\n    ]\n  }\n])\n');
      const findings = runShipped(root, ['ask-user-questions-fallback']);
      assert.deepEqual(findings, []);
    });
    test('an options key with a word character before it is not an options array', (t) => {
      const root = copyOfRepoFiles(t);
      write(root, 'gsd-core/workflows/zz-fixture.md', 'TEXT_MODE plain-text fallback.\nAskUserQuestion([\n  {\n    question: "Pick one",\n    myoptions: [\n      { label: "L1", description: "d" },\n      { label: "L2", description: "d" },\n      { label: "L3", description: "d" },\n      { label: "L4", description: "d" },\n      { label: "L5", description: "d" }\n    ]\n  }\n])\n');
      const findings = runShipped(root, ['ask-user-questions-fallback']);
      assert.deepEqual(findings, []);
    });
    test('a call whose array is never closed is skipped', (t) => {
      const root = copyOfRepoFiles(t);
      write(root, 'gsd-core/workflows/zz-fixture.md', 'TEXT_MODE plain-text fallback.\nAskUserQuestion([\n  {\n    question: "Pick one",\n    options: [\n      { label: "L1", description: "d" },\n      { label: "L2", description: "d" },\n      { label: "L3", description: "d" },\n      { label: "L4", description: "d" },\n      { label: "L5", description: "d" }\n');
      const findings = runShipped(root, ['ask-user-questions-fallback']);
      assert.deepEqual(findings, []);
    });
    test('a second options array of five labels is found and named by its line', (t) => {
      const root = copyOfRepoFiles(t);
      write(root, 'gsd-core/workflows/zz-fixture.md', 'TEXT_MODE plain-text fallback.\nAskUserQuestion([\n  {\n    question: "Pick one",\n    options: [\n      { label: "L1", description: "d" },\n      { label: "L2", description: "d" },\n      { label: "L3", description: "d" }\n    ]\n  }\n])\nAskUserQuestion([\n  {\n    question: "Pick one",\n    options: [\n      { label: "L1", description: "d" },\n      { label: "L2", description: "d" },\n      { label: "L3", description: "d" },\n      { label: "L4", description: "d" },\n      { label: "L5", description: "d" }\n    ]\n  }\n])\n');
      const findings = runShipped(root, ['ask-user-questions-fallback']);
      assert.ok(findings.some((f) => /line 15: 5 options/.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
    });
    test('a right bracket inside a label ends the array early, as the old scan did', (t) => {
      const root = copyOfRepoFiles(t);
      write(root, 'gsd-core/workflows/zz-fixture.md', 'TEXT_MODE plain-text fallback.\nAskUserQuestion([\n  {\n    question: "Pick one",\n    options: [\n      { label: "L1", description: "d" },\n      { label: "L2]", description: "d" },\n      { label: "L3", description: "d" },\n      { label: "L4", description: "d" },\n      { label: "L5", description: "d" }\n    ]\n  }\n])\n');
      const findings = runShipped(root, ['ask-user-questions-fallback']);
      assert.deepEqual(findings, []);
    });
    test('a workflows directory with no workflow is a finding', (t) => {
      const root = copyOfRepoFiles(t);
      cleanup(path.join(root, 'gsd-core', 'workflows'));
      const findings = runShipped(root, ['ask-user-questions-fallback']);
      assert.ok(findings.some((f) => /cannot read the directory/.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
    });
    passes('ui-phase.md: a regenerating word that is not a quoted option', 'gsd-core/workflows/ui-phase.md', swap('Auto-select "Skip"', 'Auto-select "Skip" and never Update'), 'ask-user-questions-fallback');
    passes('spec-phase.md: a regenerating word that is not a quoted option', 'gsd-core/workflows/spec-phase.md', swap('Auto-select "Skip"', 'Auto-select "Skip" and never Update'), 'ask-user-questions-fallback');
    passes('ai-integration-phase.md: a regenerating word that is not a quoted option', 'gsd-core/workflows/ai-integration-phase.md', swap('Auto-select "Skip"', 'Auto-select "Skip" and never Update'), 'ask-user-questions-fallback');
    passes('eval-review.md: a regenerating word that is not a quoted option', 'gsd-core/workflows/eval-review.md', swap('Auto-select "View"', 'Auto-select "View" and never Re-audit'), 'ask-user-questions-fallback');
    passes('ui-review.md: a regenerating word that is not a quoted option', 'gsd-core/workflows/ui-review.md', swap('Auto-select "View"', 'Auto-select "View" and never Re-audit'), 'ask-user-questions-fallback');
    passes('an --auto arm 585 characters before the escalation is outside the window', 'gsd-core/workflows/ui-phase.md', (text) => { const at = text.indexOf('Force approve'); return text.slice(0, at) + '**If `--auto`:**' + 'x'.repeat(585) + text.slice(at); }, 'ask-user-questions-fallback');
    passes('an --auto arm 572 characters after the escalation is outside the window', 'gsd-core/workflows/ui-phase.md', (text) => { const at = text.indexOf('Force approve') + 'Force approve'.length; return text.slice(0, at) + 'x'.repeat(572) + '**If `--auto`:**' + text.slice(at); }, 'ask-user-questions-fallback');
    test('a nested workflow step file with a footnote', (t) => {
      const root = copyOfRepoFiles(t);
      write(root, 'gsd-core/workflows/zz-steps/step.md', 'Next:\n<sub>/clear</sub>\n');
      const findings = runShipped(root, ['next-up-clear-order']);
      assert.ok(findings.some((f) => /gsd-core\/workflows\/zz-steps\/step\.md must not contain a <sub>\/clear<\/sub> pattern: \/clear should appear before the command/.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
    });
    test('a nested reference with a footnote', (t) => {
      const root = copyOfRepoFiles(t);
      write(root, 'gsd-core/references/zz/ref.md', 'Next:\n<sub>/clear</sub>\n');
      const findings = runShipped(root, ['next-up-clear-order']);
      assert.ok(findings.some((f) => /gsd-core\/references\/zz\/ref\.md must not contain a <sub>\/clear<\/sub> pattern: \/clear should appear before the command/.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
    });
    passes('a footnote with no closing tag', 'gsd-core/references/ui-brand.md', append('<sub>/clear and more'), 'next-up-clear-order');
    passes('a footnote whose run holds another tag', 'gsd-core/references/ui-brand.md', append('<sub>a <b>/clear</b></sub>'), 'next-up-clear-order');
    passes('a footnote that names clear without the slash', 'gsd-core/references/ui-brand.md', append('<sub>clear</sub>'), 'next-up-clear-order');
    passes('a footnote of another command', 'gsd-core/references/ui-brand.md', append('<sub>/other</sub>'), 'next-up-clear-order');
    passes('a second opening tag before the closing one', 'gsd-core/references/ui-brand.md', append('<sub>/clear <sub>x</sub>'), 'next-up-clear-order');
    for (const [rel, dir] of [['workflows', 'gsd-core/workflows'], ['references', 'gsd-core/references']]) {
      test(`a ${rel} directory with no markdown file is a finding`, (t) => {
        const root = copyOfRepoFiles(t);
        cleanup(path.join(root, ...dir.split('/')));
        const findings = runShipped(root, ['next-up-clear-order']);
        assert.ok(findings.some((f) => /cannot read the directory/.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
      });
    }
    passes('the exception note with resume after exception', 'gsd-core/workflows/resume-project.md', swap('Resume-specific exception: do **not** emit', 'An exception, for resume: do **not** emit'), 'next-up-clear-order');
    passes('the exception note split by U+2028 with both words on the second line', 'gsd-core/workflows/resume-project.md', swap('Resume-specific exception:', 'Note\u2028Resume-specific exception:'), 'next-up-clear-order');
    passes('the execute command separated by tabs and newlines', 'gsd-core/workflows/plan-phase.md', swap('/gsd:execute-phase {X} ${GAPS_EXEC_FLAG} ${GSD_WS}', '/gsd:execute-phase\t{X}\n${GAPS_EXEC_FLAG}  ${GSD_WS}'), 'next-up-clear-order');
    passes('a plan-phase document of the minimal shape', 'gsd-core/workflows/plan-phase.md', () => `GAPS_MODE=false\n$GSD_ARGS--gapsGAPS_MODE=true\nGAPS_EXEC_FLAG=""GAPS_MODEGAPS_EXEC_FLAG="--gaps-only"\n\n<offer_next>\n/gsd:execute-phase {X} \${GAPS_EXEC_FLAG} \${GSD_WS}\n--gaps-only\n</offer_next>\n`, 'next-up-clear-order');
    passes('the --gaps flag after the captured arguments with a gap of 79 characters', 'gsd-core/workflows/plan-phase.md', () => `GAPS_MODE=false\n$GSD_ARGSxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx--gapsGAPS_MODE=true\nGAPS_EXEC_FLAG=""GAPS_MODEGAPS_EXEC_FLAG="--gaps-only"\n\n<offer_next>\n/gsd:execute-phase {X} \${GAPS_EXEC_FLAG} \${GSD_WS}\n--gaps-only\n</offer_next>\n`, 'next-up-clear-order');
    passes('the --gaps flag after the captured arguments with a gap of 80 characters', 'gsd-core/workflows/plan-phase.md', () => `GAPS_MODE=false\n$GSD_ARGSxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx--gapsGAPS_MODE=true\nGAPS_EXEC_FLAG=""GAPS_MODEGAPS_EXEC_FLAG="--gaps-only"\n\n<offer_next>\n/gsd:execute-phase {X} \${GAPS_EXEC_FLAG} \${GSD_WS}\n--gaps-only\n</offer_next>\n`, 'next-up-clear-order');
    passes('the GAPS_MODE=true assignment after the --gaps flag with a gap of 39 characters', 'gsd-core/workflows/plan-phase.md', () => `GAPS_MODE=false\n$GSD_ARGS--gapsyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyGAPS_MODE=true\nGAPS_EXEC_FLAG=""GAPS_MODEGAPS_EXEC_FLAG="--gaps-only"\n\n<offer_next>\n/gsd:execute-phase {X} \${GAPS_EXEC_FLAG} \${GSD_WS}\n--gaps-only\n</offer_next>\n`, 'next-up-clear-order');
    passes('the GAPS_MODE=true assignment after the --gaps flag with a gap of 40 characters', 'gsd-core/workflows/plan-phase.md', () => `GAPS_MODE=false\n$GSD_ARGS--gapsyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyGAPS_MODE=true\nGAPS_EXEC_FLAG=""GAPS_MODEGAPS_EXEC_FLAG="--gaps-only"\n\n<offer_next>\n/gsd:execute-phase {X} \${GAPS_EXEC_FLAG} \${GSD_WS}\n--gaps-only\n</offer_next>\n`, 'next-up-clear-order');
    passes('the gaps-only assignment after GAPS_MODE with a gap of 59 characters', 'gsd-core/workflows/plan-phase.md', () => `GAPS_MODE=false\n$GSD_ARGS--gapsGAPS_MODE=true\nGAPS_EXEC_FLAG=""GAPS_MODEzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzGAPS_EXEC_FLAG="--gaps-only"\n\n<offer_next>\n/gsd:execute-phase {X} \${GAPS_EXEC_FLAG} \${GSD_WS}\n--gaps-only\n</offer_next>\n`, 'next-up-clear-order');
    passes('the gaps-only assignment after GAPS_MODE with a gap of 60 characters', 'gsd-core/workflows/plan-phase.md', () => `GAPS_MODE=false\n$GSD_ARGS--gapsGAPS_MODE=true\nGAPS_EXEC_FLAG=""GAPS_MODEzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzGAPS_EXEC_FLAG="--gaps-only"\n\n<offer_next>\n/gsd:execute-phase {X} \${GAPS_EXEC_FLAG} \${GSD_WS}\n--gaps-only\n</offer_next>\n`, 'next-up-clear-order');
    passes('the gaps-only assignment after the empty flag with a gap of 190 characters', 'gsd-core/workflows/plan-phase.md', () => `GAPS_MODE=false\n$GSD_ARGS--gapsGAPS_MODE=true\nGAPS_EXEC_FLAG=""qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqGAPS_MODEGAPS_EXEC_FLAG="--gaps-only"\n\n<offer_next>\n/gsd:execute-phase {X} \${GAPS_EXEC_FLAG} \${GSD_WS}\n--gaps-only\n</offer_next>\n`, 'next-up-clear-order');
    passes('the gaps-only assignment after the empty flag with a gap of 191 characters', 'gsd-core/workflows/plan-phase.md', () => `GAPS_MODE=false\n$GSD_ARGS--gapsGAPS_MODE=true\nGAPS_EXEC_FLAG=""qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqGAPS_MODEGAPS_EXEC_FLAG="--gaps-only"\n\n<offer_next>\n/gsd:execute-phase {X} \${GAPS_EXEC_FLAG} \${GSD_WS}\n--gaps-only\n</offer_next>\n`, 'next-up-clear-order');
    // Round 1 review: exactly one finding per cause, and the branches that had no case.
    const g1Abs = (root, rel) => path.join(root, ...rel.split('/'));
    const g1One = (title, contract, heavy, prepare, expected) => test(title, (t) => {
      const root = copyOfRepoFiles(t, heavy ? HEAVY : []);
      prepare(root);
      const findings = runShipped(root, [contract]);
      assert.equal(findings.length, 1, JSON.stringify(findings.map((f) => f.message)));
      assert.match(findings[0].message, expected);
    });
    const g1None = (title, contract, heavy, prepare) => test(title, (t) => {
      const root = copyOfRepoFiles(t, heavy ? HEAVY : []);
      prepare(root);
      assert.deepEqual(runShipped(root, [contract]), []);
    });
    const g1Rm = (rel) => (root) => fs.unlinkSync(g1Abs(root, rel));
    const g1Empty = (rel) => (root) => fs.writeFileSync(g1Abs(root, rel), '');
    const g1Put = (rel, text) => (root) => write(root, rel, text);
    const g1Edit = (rel, edit) => (root) => {
      const abs = g1Abs(root, rel);
      const before = fs.readFileSync(abs, 'utf8');
      const after = edit(before);
      assert.notEqual(after, before, 'the edit changed the file');
      fs.writeFileSync(abs, after);
    };
    const G1_GONE = /cannot read the file: ENOENT/;
    const G1_EMPTY = /the file is empty/;
    const G1_WF = 'gsd-core/workflows';
    const G1_UI = `${G1_WF}/ui-phase.md`;
    const G1_ARM = '**If `--auto`:**';
    const G1_PAD = 'pad '.repeat(200);

    // contributor-standards and cursor-reviewer: a removed or empty file is one finding.
    g1One('docs/contributor-standards.md removed is exactly one finding', 'contributor-standards', true, g1Rm('docs/contributor-standards.md'), G1_GONE);
    g1One('docs/contributor-standards.md emptied is exactly one finding', 'contributor-standards', true, g1Empty('docs/contributor-standards.md'), G1_EMPTY);
    g1One('CONTEXT.md removed is exactly one finding for contributor-standards', 'contributor-standards', true, g1Rm('CONTEXT.md'), G1_GONE);
    g1One('CONTRIBUTING.md removed is exactly one finding for contributor-standards', 'contributor-standards', true, g1Rm('CONTRIBUTING.md'), G1_GONE);
    g1One('gsd-core/workflows/review.md removed is exactly one finding', 'cursor-reviewer', false, g1Rm(`${G1_WF}/review.md`), G1_GONE);
    g1One('gsd-core/workflows/review.md emptied is exactly one finding', 'cursor-reviewer', false, g1Empty(`${G1_WF}/review.md`), G1_EMPTY);
    g1None('a backtick with no closing backtick after it adds no heading reference', 'contributor-standards', true, g1Edit('docs/contributor-standards.md', within('## CONTEXT.md', '## ADRs', (section) => `${section}\nSee \`## Phantom with no close\n`)));
    g1None('a one-character span of a heading marker adds no heading reference', 'contributor-standards', true, g1Edit('docs/contributor-standards.md', within('## CONTEXT.md', '## ADRs', (section) => `${section}\nAn empty span \`## \` here.\n`)));

    // ask-user-questions-fallback: one handle per path, so one finding per cause.
    for (const file of ['ui-phase.md', 'spec-phase.md', 'ai-integration-phase.md', 'eval-review.md', 'ui-review.md']) {
      g1One(`${file} removed is exactly one finding`, 'ask-user-questions-fallback', false, g1Rm(`${G1_WF}/${file}`), G1_GONE);
      g1One(`${file} emptied is exactly one finding`, 'ask-user-questions-fallback', false, g1Empty(`${G1_WF}/${file}`), G1_EMPTY);
    }
    test('the two causes of that workflow are separate findings', (t) => {
      const root = copyOfRepoFiles(t);
      write(root, `${G1_WF}/zz-fixture.md`, 'Use AskUserQuestion.\nAskUserQuestion([ { options: [ { label: "a" }, { label: "b" }, { label: "c" }, { label: "d" }, { label: "e" } ] } ])\n');
      const findings = runShipped(root, ['ask-user-questions-fallback']);
      assert.equal(findings.length, 2, JSON.stringify(findings.map((f) => f.message)));
      assert.ok(findings.some((f) => /no TEXT_MODE plain-text fallback/.test(f.message)));
      assert.ok(findings.some((f) => /5 options/.test(f.message)));
    });
    g1None('an options array of three labels satisfies the cap', 'ask-user-questions-fallback', false,
      g1Put(`${G1_WF}/zz-fixture.md`, 'TEXT_MODE plain-text fallback.\nAskUserQuestion([ { options: [ { label: "a" }, { label: "b" }, { label: "c" } ] } ])\n'));
    g1None('a label with an unclosed quote inside an options slice ends that scan with the labels counted so far', 'ask-user-questions-fallback', false,
      g1Put(`${G1_WF}/zz-fixture.md`, 'TEXT_MODE plain-text fallback.\nAskUserQuestion([ { options: [ { label: "a" }, { label: "b" }, { label: "c" }, { label: "d" }, { label: "e } ] } ])\n'));
    const G1_DECISION_HEAD = '## 4. Check Existing UI-SPEC\n';
    const G1_FLAGS = 'TEXT_MODE plain-text.\n';
    g1None('a decision section ended by a level-one heading keeps the arm and prompt inside it', 'ask-user-questions-fallback', false,
      g1Put(G1_UI, `${G1_FLAGS}Force approve\n${G1_PAD}\n${G1_DECISION_HEAD}${G1_ARM} Auto-select "Skip"\nUse AskUserQuestion.\n# Other\n`));
    g1One('an --auto arm after the level-one heading that ends the section is outside it', 'ask-user-questions-fallback', false,
      g1Put(G1_UI, `${G1_FLAGS}Force approve\n${G1_PAD}\n${G1_DECISION_HEAD}Use AskUserQuestion.\n# Other\n${G1_ARM} Auto-select "Skip"\n`), /the artifact-exists branch has no --auto arm/);
    g1None('a decision section ended by the end of the file', 'ask-user-questions-fallback', false,
      g1Put(G1_UI, `${G1_FLAGS}Force approve\n${G1_PAD}\n${G1_DECISION_HEAD}${G1_ARM} Auto-select "Skip"\nUse AskUserQuestion.\n`));
    g1None('an --auto arm on the last line with no newline reads to the end of the file', 'ask-user-questions-fallback', false,
      g1Put(G1_UI, `${G1_FLAGS}Force approve\n${G1_PAD}\n${G1_DECISION_HEAD}${G1_ARM} Auto-select "Skip"; Use AskUserQuestion`));

    // next-up-clear-order: one handle per path, so one finding per cause.
    for (const rel of ['gsd-core/references/ui-brand.md', 'gsd-core/references/continuation-format.md']) {
      g1One(`${rel} with a footnote is exactly one finding`, 'next-up-clear-order', false, g1Edit(rel, (text) => `${text}\n<sub>/clear</sub>\n`), /must not contain a <sub>\/clear<\/sub> pattern/);
    }
    for (const rel of ['gsd-core/references/ui-brand.md', 'gsd-core/workflows/resume-project.md', 'gsd-core/workflows/plan-phase.md', 'gsd-core/references/continuation-format.md']) {
      g1One(`${rel} removed is exactly one finding`, 'next-up-clear-order', false, g1Rm(rel), G1_GONE);
      g1One(`${rel} emptied is exactly one finding`, 'next-up-clear-order', false, g1Empty(rel), G1_EMPTY);
    }

    // release-backmerge-invariants: a missing or malformed job is one finding that skips the checks depending on it.
    findsOne('the finalize job removed is exactly one finding', '.github/workflows/release.yml', yamlEdit((w) => { delete w.jobs.finalize; }), 'release-backmerge-invariants', 'expected a finalize job in release.yml');
    findsOne('the finalize steps replaced by a string is exactly one finding', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs.finalize.steps = 'x'; }), 'release-backmerge-invariants', 'expected a finalize job in release.yml');
    findsOne('the finalize job replaced by a string is exactly one finding', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs.finalize = 'x'; }), 'release-backmerge-invariants', 'expected a finalize job in release.yml');
    findsOne('the validate-version job removed is exactly one finding', '.github/workflows/release.yml', yamlEdit((w) => { delete w.jobs['validate-version']; }), 'release-backmerge-invariants', 'expected a validate-version job in release.yml');
    findsOne('the validate-version steps replaced by a string is exactly one finding', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['validate-version'].steps = 'x'; }), 'release-backmerge-invariants', 'expected a validate-version job in release.yml');
    passes('a job that is not a mapping is skipped by the needs scan', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs.zz = null; }), 'release-backmerge-invariants');
    passes('a null step among the back-merge steps is skipped by the name scans', '.github/workflows/auto-backmerge.yml', yamlEdit((w) => { w.jobs.backmerge.steps.unshift(null); }), 'release-backmerge-invariants');
    passes('a null step among the finalize steps is skipped by the name scans', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs.finalize.steps.unshift(null); }), 'release-backmerge-invariants');
    findsOne('a later .outcome after a longer .outcomes name is still a gate', '.github/workflows/auto-backmerge.yml', yamlEdit((w) => { w.jobs.backmerge.steps.find((s) => s.name === 'Open or update PR').if = "steps.a.outcomes != 'x' && steps.b.outcome == 'success'"; }), 'release-backmerge-invariants', "'Open or update PR' must not gate on a step outcome/conclusion");
    findsOne('the safety_gates step removed is exactly one finding', 'gsd-core/workflows/next.md', eraseAll('name="safety_gates"'), 'next-safety-gates', 'workflow should have a safety_gates step');
    findsOne('the detect_state step renamed is exactly one finding', 'gsd-core/workflows/next.md', swap('name="detect_state"', 'name="detect"'), 'next-safety-gates', 'safety_gates must appear after the detect_state step');
    findsOne('the determine_next_action step renamed is exactly one finding', 'gsd-core/workflows/next.md', swap('name="determine_next_action"', 'name="route"'), 'next-safety-gates', 'safety_gates must appear before the determine_next_action step');
    findsOne('the empty GAPS_EXEC_FLAG declaration removed is exactly one finding', 'gsd-core/workflows/plan-phase.md', swap('GAPS_EXEC_FLAG=""', 'GAPS_EXEC_FLAG=none'), 'next-up-clear-order', 'the plan-phase.md preamble must derive GAPS_EXEC_FLAG="--gaps-only" from GAPS_MODE');
    findsOne('the route exception note with overlapping words does not count', 'gsd-core/workflows/resume-project.md', within('<step name="route_to_workflow">', '</step>', (step) => step.split('Resume-specific exception:').join('resumexception:').split('Resume is already').join('It is already').split('resume').join('xx').split('Resume').join('Xx')), 'next-up-clear-order', 'the route_to_workflow block must include an exception note explaining resume behavior');
    passes('resume and exception sharing no letters on one line count', 'gsd-core/workflows/resume-project.md', swap('Resume-specific exception:', 'Resume-specific exception: resume exception'), 'next-up-clear-order');

    g1One('a derivation block that names no GAPS_MODE is one finding even when a later GAPS_MODE derives the flag', 'next-up-clear-order', false,
      g1Put('gsd-core/workflows/plan-phase.md', `GAPS_MODE=false\n$GSD_ARGS --gaps GAPS_MODE=true\nGAPS_EXEC_FLAG=""\nGAPS_EXEC_FLAG="--gaps-only"\n${'x'.repeat(300)}\nGAPS_MODE GAPS_EXEC_FLAG="--gaps-only"\n\n<offer_next>\n/gsd:execute-phase {X} \${GAPS_EXEC_FLAG} \${GSD_WS}\n--gaps-only\n</offer_next>\n`), /the derivation does not mention GAPS_MODE/);
    g1None('the same document with GAPS_MODE inside the first derivation block has no finding', 'next-up-clear-order', false,
      g1Put('gsd-core/workflows/plan-phase.md', `GAPS_MODE=false\n$GSD_ARGS --gaps GAPS_MODE=true\nGAPS_EXEC_FLAG=""\nif GAPS_MODE; then GAPS_EXEC_FLAG="--gaps-only"\n\n<offer_next>\n/gsd:execute-phase {X} \${GAPS_EXEC_FLAG} \${GSD_WS}\n--gaps-only\n</offer_next>\n`));

    // Differential properties (CLAUDE.md: parsers get a fast-check property): each linear walker of the group's contracts is compared
    // with the regex or algorithm of the deleted test, copied here as the oracle. Every property draws two kinds of input, random
    // strings of the characters the walker reads and a chain of its parts with random fillers (some parts broken), and records the
    // outcomes it saw: it fails when the generator reached only a positive or only a negative result. The one deliberate difference,
    // the heading scan of contributor-standards reading a heading within its own line, is outside the domain of its property
    // (strings where a heading marker is followed by blanks and a line end are discarded).
    {
      const fc = require(path.join(REPO_ROOT, 'tests', 'helpers', 'fast-check-setup.cjs'));
      const CONTRACTS = path.join(REPO_ROOT, 'scripts', 'static-checks', 'text-contracts');
      const load = (name) => require(path.join(CONTRACTS, `${name}.cjs`));
      const nextUp = load('next-up-clear-order');
      const release = load('release-backmerge-invariants');
      const ask = load('ask-user-questions-fallback');
      const standards = load('contributor-standards');
      const cursor = load('cursor-reviewer');
      const RUNS = { numRuns: 1000 };
      const tokens = (list, max = 24) => fc.array(fc.constantFrom(...list), { maxLength: max }).map((parts) => parts.join(''));
      // check(value) asserts the walker against its oracle and returns whether the oracle's result was positive.
      const property = (title, arbitrary, check) => test(`property: ${title}`, () => {
        const seen = new Set();
        fc.assert(fc.property(arbitrary, (value) => { seen.add(Boolean(check(value))); }), RUNS);
        assert.deepEqual([...seen].sort(), [false, true], `${title}: the generator reached only ${[...seen].join(', ')}`);
      });
      const FILLER = ['x', '\n', '\u2028', ' '];
      // The parts in order, each after a filler of 0 to maxPad characters, one part possibly cut short.
      const chain = (parts, maxPad) => fc.tuple(
        fc.array(fc.integer({ min: 0, max: maxPad }), { minLength: parts.length, maxLength: parts.length }),
        fc.array(fc.constantFrom(...FILLER), { minLength: parts.length, maxLength: parts.length }),
        fc.option(fc.integer({ min: 0, max: parts.length - 1 }), { nil: -1, freq: 2 }),
      ).map(([pads, chars, broken]) => parts.map((part, i) => `${chars[i].repeat(pads[i])}${i === broken ? part.slice(0, -1) : part}`).join(''));
      // The words in order, each pair separated by blanks of every kind or by none, one word possibly cut short.
      const BLANKS = [' ', '  ', '\t', '\n', '\u00a0', '\u2028', '', 'x'];
      const sequence = (words) => fc.tuple(
        fc.array(fc.constantFrom(...BLANKS), { minLength: words.length - 1, maxLength: words.length - 1 }),
        fc.option(fc.integer({ min: 0, max: words.length - 1 }), { nil: -1, freq: 2 }),
        tokens(['x', ' ', '\n'], 3),
      ).map(([seps, broken, prefix]) => `${prefix}${words.map((word, i) => `${i === broken ? word.slice(0, -1) : word}${i < seps.length ? seps[i] : ''}`).join('')}`);

      // contributor-standards.
      const oldRefs = (scope) => {
        const refs = new Set();
        for (const m of scope.matchAll(/`(#{2,6}\s+[^`]+)`/g)) {
          const heading = m[1].trim();
          if (heading.includes('<')) continue;
          refs.add(heading);
        }
        return [...refs];
      };
      const headingSpans = fc.array(fc.tuple(fc.integer({ min: 0, max: 8 }), fc.constantFrom(' ', '\t', '\n', ''), fc.constantFrom('x', '<x', 'ab', ' ', ''), fc.boolean(), tokens(['x', ' ', '\n', '`'], 2)), { minLength: 1, maxLength: 3 })
        .map((items) => items.map(([hashes, blank, title, closed, junk]) => `${junk}\`${'#'.repeat(hashes)}${blank}${title}${closed ? '`' : ''}`).join(''));
      property('backtickedHeadings equals the old backtick heading regex', fc.oneof(tokens(['`', '#', '##', '###', '#######', ' ', '\n', '\u2028', 'x', '<', '\t', 'ab'], 28), headingSpans), (text) => {
        const refs = standards.backtickedHeadings(text);
        assert.deepEqual(refs, oldRefs(text), JSON.stringify(text));
        return refs.length > 0;
      });
      const oldHeadings = (text) => new Set([...text.matchAll(/^#{2,6}\s+.*$/gm)].map((m) => m[0].trim()));
      const headingLines = fc.array(fc.tuple(fc.integer({ min: 0, max: 8 }), fc.constantFrom(' ', '\t', '  ', ''), fc.constantFrom('x', 'ab', ' ', ''), fc.constantFrom('\n', '\r', '\u2028', '\u2029')), { minLength: 1, maxLength: 4 })
        .map((lines) => lines.map(([hashes, blank, title, end]) => `${'#'.repeat(hashes)}${blank}${title}${end}`).join(''));
      property('actualHeadings equals the old heading regex outside heading markers followed by a line end', fc.oneof(tokens(['#', '##', '###', '#######', ' ', '\n', '\r', '\u2028', '\u2029', 'x', '\t', 'ab'], 28), headingLines), (text) => {
        fc.pre(!/^#{2,6}[^\S\n\r\u2028\u2029]*[\n\r\u2028\u2029]/m.test(text));
        const found = [...standards.actualHeadings(text)].sort();
        assert.deepEqual(found, [...oldHeadings(text)].sort(), JSON.stringify(text));
        return found.length > 0;
      });

      // ask-user-questions-fallback.
      const oldClose = (text, openIndex, openCh, closeCh) => {
        let depth = 0;
        for (let i = openIndex; i < text.length; i += 1) {
          if (text[i] === openCh) depth += 1;
          else if (text[i] === closeCh) {
            depth -= 1;
            if (depth === 0) return i;
          }
        }
        return -1;
      };
      const oldViolations = (text) => {
        const violations = [];
        const askRe = /\bAskUserQuestion\s*\(\s*\[/g;
        let askMatch;
        while ((askMatch = askRe.exec(text)) !== null) {
          const arrayOpen = text.indexOf('[', askMatch.index);
          if (arrayOpen === -1) continue;
          const arrayClose = oldClose(text, arrayOpen, '[', ']');
          if (arrayClose === -1) continue;
          const askBlock = text.slice(arrayOpen, arrayClose + 1);
          const optionsRe = /\boptions\s*:\s*\[/g;
          let optionsMatch;
          while ((optionsMatch = optionsRe.exec(askBlock)) !== null) {
            const openInBlock = optionsMatch.index + optionsMatch[0].length - 1;
            const closeInBlock = oldClose(askBlock, openInBlock, '[', ']');
            if (closeInBlock === -1) continue;
            const labelCount = (askBlock.slice(openInBlock, closeInBlock + 1).match(/\blabel\s*:\s*"[^"]+"/g) || []).length;
            if (labelCount > 4) violations.push({ line: text.slice(0, arrayOpen + optionsMatch.index).split('\n').length, count: labelCount });
          }
        }
        return violations;
      };
      const askTokens = ['AskUserQuestion', '([', ' (', 'options', ':', ' : ', '[', ']', 'label', '"', '"a"', 'x', '\n', '{', '}', 'xAskUserQuestion', 'labels', ' ', '{ label: "a" }', '{ label: "b" }', '{ label: "c" }', '{ label: "d" }', '{ label: "e" }'];
      // A call of 0 to 8 labelled options with the spacing and one flaw varied: a longer word, a missing colon, another key, an unclosed array.
      const askCall = fc.tuple(
        fc.integer({ min: 0, max: 8 }),
        fc.array(fc.constantFrom('', ' ', '\n'), { minLength: 5, maxLength: 5 }),
        fc.integer({ min: 0, max: 6 }),
        tokens(['x', '\n', ' '], 2),
      ).map(([count, seps, variant, prefix]) => {
        const label = variant === 5 ? '{ labels: "a" }' : variant === 6 ? '{ label: "" }' : '{ label: "a" }';
        const labels = Array.from({ length: count }, () => label).join(', ');
        const name = variant === 1 ? 'xAskUserQuestion' : 'AskUserQuestion';
        const key = variant === 2 ? 'myoptions' : 'options';
        return `${prefix}${name}${seps[0]}(${seps[1]}[ { ${key}${seps[2]}${variant === 3 ? '' : ':'}${seps[3]}[${seps[4]}${labels} ${variant === 4 ? '' : ']'} } ])`;
      });
      // Nests of 0 to 4 opening brackets, a filler (a quote among them) and 0 to 4 closing brackets, one to three times.
      const bracketNests = fc.array(fc.tuple(fc.integer({ min: 0, max: 4 }), fc.constantFrom('', 'x', '"', ' ', '\n'), fc.integer({ min: 0, max: 4 })), { minLength: 1, maxLength: 3 })
        .map((items) => items.map(([opens, filler, closes]) => `${'['.repeat(opens)}${filler}${']'.repeat(closes)}`).join(''));
      property('bracketPartners pairs each opening bracket with the old balanced close', fc.oneof(tokens(['[', ']', 'x', '[', ']', '\n'], 20), bracketNests), (text) => {
        const partner = ask.bracketPartners(text);
        for (let i = 0; i < text.length; i += 1) {
          if (text[i] === '[') assert.equal(partner.has(i) ? partner.get(i) : -1, oldClose(text, i, '[', ']'), `${JSON.stringify(text)} at ${i}`);
        }
        return partner.size > 0;
      });
      const labelParts = fc.array(fc.tuple(fc.constantFrom('label', 'xlabel', 'labels'), fc.constantFrom('', ' ', '\n'), fc.constantFrom(':', ''), fc.constantFrom('', ' '), fc.constantFrom('', 'a', 'ab', ' '), fc.boolean()), { minLength: 1, maxLength: 5 })
        .map((parts) => parts.map(([name, before, colon, after, body, closed]) => `${name}${before}${colon}${after}"${body}${closed ? '"' : ''}`).join(' '));
      property('labelCount equals the old labelled-option regex', fc.oneof(tokens(['label', ':', ' ', '"', 'a', '"a"', '""', 'x', '\n', 'labels', 'xlabel'], 24), labelParts), (text) => {
        const count = ask.labelCount(text);
        assert.equal(count, (text.match(/\blabel\s*:\s*"[^"]+"/g) || []).length, JSON.stringify(text));
        return count > 0;
      });
      property('optionCapViolations equals the old AskUserQuestion options scan', fc.oneof(tokens(askTokens, 30), askCall), (text) => {
        const found = ask.optionCapViolations(text);
        assert.deepEqual(found, oldViolations(text), JSON.stringify(text));
        return found.length > 0;
      });
      // An anchor (or a cut one), a body, the next heading of either level or none, and a tail.
      const sections = fc.tuple(tokens(['x', '\n'], 3), fc.constantFrom('ZZ', 'Z'), fc.constantFrom('', ' x', '\n'), fc.constantFrom('\n# h', '\n## h', '\n#h', ''), tokens(['x', '\n##', ' '], 3))
        .map(([prefix, anchor, body, heading, tail]) => `${prefix}${anchor}${body}${heading}${tail}`);
      property('sectionAfter equals the old section extraction', fc.oneof(tokens(['ZZ', '\n# ', '\n## ', '\n#', '#', ' ', 'x', '\n', 'ZZ', 'x'], 20), sections), (text) => {
        const start = text.indexOf('ZZ');
        const expected = start === -1 ? null : (() => {
          const rest = text.slice(start + 2);
          const end = rest.search(/\n##? /);
          return rest.slice(0, end === -1 ? rest.length : end);
        })();
        const found = ask.sectionAfter(text, 'ZZ');
        assert.equal(found, expected, JSON.stringify(text));
        return found !== null && found.length > 0;
      });

      // next-up-clear-order.
      const KELVIN = 'K';
      const LONG_S = 'ſ';
      const DOTLESS_I = 'ı';
      const DOTTED_I = 'İ';
      const NON_ASCII = [KELVIN, LONG_S, DOTLESS_I, DOTTED_I, '\u00a0'];
      const subTags = fc.tuple(
        fc.constantFrom('<sub>', '<SUB>', '<sub', '<su>'),
        fc.integer({ min: 0, max: 60 }), fc.constantFrom('x', ' ', ...NON_ASCII),
        fc.constantFrom('/clear', '/CLEAR', '/clea', '/ clear'),
        fc.integer({ min: 0, max: 60 }), fc.constantFrom('x', ' ', ...NON_ASCII),
        fc.constantFrom('</sub>', '</SUB>', '</su', '<b></sub>'),
      ).map(([open, a, aChar, mid, b, bChar, close]) => `${open}${aChar.repeat(a)}${mid}${bChar.repeat(b)}${close}`);
      property('hasSubClear equals the old footnote regex', fc.oneof(tokens(['<sub>', '</sub>', '<SUB>', '</Sub>', '/clear', '/CLEAR', '<', 'x', ' ', '\n', '/clea', KELVIN, DOTLESS_I], 18), subTags),
        (text) => {
          const found = nextUp.hasSubClear(text);
          assert.equal(found, /<sub>[^<]*\/clear[^<]*<\/sub>/gi.test(text), JSON.stringify(text));
          return found;
        });
      property('hasSequence equals the old three-word execute-phase regex', fc.oneof(tokens(['/gsd:execute-phase', '{X}', '${GAPS_EXEC_FLAG}', ' ', '\t', '\n', 'x', '\u00a0'], 14), sequence(['/gsd:execute-phase', '{X}', '${GAPS_EXEC_FLAG}'])), (text) => {
        const found = nextUp.hasSequence(text, ['/gsd:execute-phase', '{X}', '${GAPS_EXEC_FLAG}']);
        assert.equal(found, /\/gsd:execute-phase\s+\{X\}\s+\$\{GAPS_EXEC_FLAG\}/.test(text), JSON.stringify(text));
        return found;
      });
      property('hasSequence equals the old four-word execute-phase regex', fc.oneof(tokens(['/gsd:execute-phase', '{X}', '${GAPS_EXEC_FLAG}', '${GSD_WS}', ' ', '\t', '\n', 'x', '\u00a0'], 14), sequence(['/gsd:execute-phase', '{X}', '${GAPS_EXEC_FLAG}', '${GSD_WS}'])), (text) => {
        const found = nextUp.hasSequence(text, ['/gsd:execute-phase', '{X}', '${GAPS_EXEC_FLAG}', '${GSD_WS}']);
        assert.equal(found, /\/gsd:execute-phase\s+\{X\}\s+\$\{GAPS_EXEC_FLAG\}\s+\$\{GSD_WS\}/.test(text), JSON.stringify(text));
        return found;
      });
      const SET = 'GAPS_EXEC_FLAG="--gaps-only"';
      const EMPTY = 'GAPS_EXEC_FLAG=""';
      const gapsTokens = ['GAPS_MODE=false', '$GSD_ARGS', '--gaps', 'GAPS_MODE=true', EMPTY, 'GAPS_MODE', SET, 'x', 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', '\n', ' '];
      property('capturesGapsMode equals the old preamble regex across its 80 and 40 character windows', fc.oneof(tokens(gapsTokens, 16), chain(['GAPS_MODE=false', '$GSD_ARGS', '--gaps', 'GAPS_MODE=true'], 100)), (text) => {
        const found = nextUp.capturesGapsMode(text);
        assert.equal(found, /GAPS_MODE=false[\s\S]*\$GSD_ARGS[\s\S]{0,80}?--gaps[\s\S]{0,40}?GAPS_MODE=true/.test(text), JSON.stringify(text));
        return found;
      });
      property('derivesExecFlag equals the old derivation regex across its 60 character window', fc.oneof(tokens(gapsTokens, 16), chain([EMPTY, 'GAPS_MODE', SET], 100)), (text) => {
        const found = nextUp.derivesExecFlag(text);
        assert.equal(found, /GAPS_EXEC_FLAG=""[\s\S]*GAPS_MODE[\s\S]{0,60}?GAPS_EXEC_FLAG="--gaps-only"/.test(text), JSON.stringify(text));
        return found;
      });
      property('derivationBlock equals the old derivation block regex across its 200 character window', fc.oneof(tokens(gapsTokens, 16), chain([EMPTY, SET], 260), chain([EMPTY, 'GAPS_MODE', SET], 260)), (text) => {
        const block = text.match(/GAPS_EXEC_FLAG=""[\s\S]{0,200}?GAPS_EXEC_FLAG="--gaps-only"/);
        const found = nextUp.derivationBlock(text);
        assert.equal(found, block ? block[0] : null, JSON.stringify(text));
        return found !== null;
      });
      const resumeFirst = ['resume', 'Resume', 'RESUME', 'resum', 'exception', 'EXCEPTION', 'resumexception'];
      const resumeSecond = ['exception', 'EXCEPTION', 'exceptio', 'resume', 'xception', 'e'];
      const resumeLine = fc.tuple(fc.constantFrom(...resumeFirst), tokens([' ', 'x', '\n', '\r', '\u2028', '\u2029', ''], 3), fc.constantFrom(...resumeSecond))
        .map(([first, gap, second]) => `${first}${gap}${second}`);
      property('explainsResumeException equals the old resume and exception regex', fc.oneof(tokens(['resume', 'Resume', 'exception', 'EXCEPTION', 'e', 'x', ' ', '\n', '\r', '\u2028', '\u2029', 'resumexception', KELVIN, DOTTED_I], 10), resumeLine), (text) => {
        const found = nextUp.explainsResumeException(text);
        assert.equal(found, /resume.*exception|exception.*resume/i.test(text), JSON.stringify(text));
        return found;
      });

      // cursor-reviewer.
      const pipes = fc.tuple(tokens(['x', ' ', '\n'], 3), fc.integer({ min: 0, max: 4 }), fc.constantFrom('cursor', 'cursor-agent', 'cursor-agen', 'cursorx', 'curso', ' cursor'), tokens(['x', ' ', '|'], 2))
        .map(([prefix, blanks, tail, suffix]) => `${prefix}|${' '.repeat(blanks)}${tail}${suffix}`);
      property('pipesIntoCursor equals the old pipe regex', fc.oneof(tokens(['|', ' ', 'cursor', '-agent', 'cursor-agent', 'x', '\n', '\t'], 12), pipes), (text) => {
        const found = cursor.pipesIntoCursor(text);
        assert.equal(found, /\| *cursor(?!-agent)/.test(text), JSON.stringify(text));
        return found;
      });
      const reviewers = fc.tuple(fc.constantFrom('reviewers:', 'reviewers', 'reviewer:'), fc.integer({ min: 0, max: 30 }), fc.constantFrom('', ' ', '\n', '\r', '\u2028', '\u2029'), fc.constantFrom('cursor', 'curso', 'claude, cursor'))
        .map(([key, pad, end, word]) => `${key}${'x'.repeat(pad)}${end}${word}`);
      property('listsCursorAmongReviewers equals the old reviewers regex', fc.oneof(tokens(['reviewers:', 'cursor', ' ', 'x', '\n', '\r', '\u2028', '\u2029', '[', ','], 12), reviewers), (text) => {
        const found = cursor.listsCursorAmongReviewers(text);
        assert.equal(found, /reviewers:.*cursor/.test(text), JSON.stringify(text));
        return found;
      });

      // release-backmerge-invariants.
      const gates = fc.tuple(tokens(['x', ' ', '.outcome'], 2), fc.constantFrom('.', 'x'), fc.constantFrom('outcome', 'conclusion', 'outcomes', 'conclusion_x', 'outcom', 'conclusio'), fc.constantFrom('', ' ', '_', 'x', '.', '1', '\n'), tokens(['.outcome', 'x'], 2))
        .map(([prefix, dot, name, next, suffix]) => `${prefix}${dot}${name}${next}${suffix}`);
      property('gatesOnOutcome equals the old outcome regex', fc.oneof(tokens(['.outcome', '.conclusion', '.outcomes', '.conclusion_x', 'x', ' ', '.', '_', '1'], 10), gates), (text) => {
        const found = release.gatesOnOutcome(text);
        assert.equal(found, /\.(outcome|conclusion)\b/.test(text), JSON.stringify(text));
        return found;
      });
      property('hasSequence equals the old merge -s ours regex', fc.oneof(tokens(['merge', '-s', 'ours', ' ', '\t', '\n', 'x', 'xmerge', 'oursx'], 10), sequence(['merge', '-s', 'ours'])), (text) => {
        const found = release.hasSequence(text, ['merge', '-s', 'ours']);
        assert.equal(found, /merge\s+-s\s+ours/.test(text), JSON.stringify(text));
        return found;
      });
      test('the shared hasSequence is the one both contracts export', () => {
        assert.equal(release.hasSequence, nextUp.hasSequence);
      });
    }

    test('a js-yaml that cannot be loaded is one finding for both workflows, and a parse error is reported for its workflow', () => {
      const release = require(path.join(REPO_ROOT, 'scripts', 'static-checks', 'text-contracts', 'release-backmerge-invariants.cjs'));
      const findings = [];
      const ctx = { fail: (file, message) => findings.push({ file, message }), doc: () => { throw new Error('no workflow is read when the parser cannot be loaded'); } };
      release.check(ctx, () => { throw new Error('boom'); });
      assert.deepEqual(findings, [{ file: '.github/workflows', message: 'js-yaml cannot be loaded: boom' }]);
      assert.match(release.parse('a: [\n', 'x.yml', yaml).error, /^x\.yml is not valid YAML: /);
      assert.deepEqual(release.parse('jobs: { a: {} }', 'x.yml', yaml).workflow, { jobs: { a: {} } });
    });
  }

  {
    // agent-skills-bootstrap: the sweep floor of 36 files, the 64-character name bound, the depth filter, the missing directory.
    {
      const POINTER_FILE = 'gsd-core/references/agent-skills-bootstrap.md';
      const rewrite = (root, rel, edit) => {
        const abs = path.join(root, ...rel.split('/'));
        const before = fs.readFileSync(abs, 'utf8');
        const after = edit(before);
        assert.notEqual(after, before, 'the edit changed the file');
        fs.writeFileSync(abs, after);
      };
      const carryingCompact = (root) => fs.readdirSync(path.join(root, 'agents'))
        .filter((name) => name.endsWith('.compact.md'))
        .filter((name) => fs.readFileSync(path.join(root, 'agents', name), 'utf8').includes('agent-skills-bootstrap.md'));
      const SWEEP_FLOOR = 36;
      for (const target of [SWEEP_FLOOR - 1, SWEEP_FLOOR, SWEEP_FLOOR + 1]) {
        test(`${target} agent files carrying the bootstrap pointer ${target >= SWEEP_FLOOR ? 'satisfy' : 'fall short of'} the sweep floor of ${SWEEP_FLOOR}`, (t) => {
          const root = copyOfRepoFiles(t);
          const compact = carryingCompact(root);
          const canonical = 22;
          const drop = canonical + compact.length - target;
          assert.ok(drop >= 0 && drop <= compact.length, `cannot reach ${target} carrying files from ${canonical + compact.length}`);
          for (const name of compact.slice(0, drop)) rewrite(root, `agents/${name}`, (text) => text.split('agent-skills-bootstrap.md').join('the-bootstrap.md'));
          const findings = runShipped(root, ['agent-skills-bootstrap']);
          if (target >= SWEEP_FLOOR) assert.deepEqual(findings, []);
          else assert.ok(findings.some((f) => /only 35 agent files carry the bootstrap pointer/.test(f.message)), JSON.stringify(findings));
        });
      }
      for (const [length, read] of [[63, true], [64, true], [65, false]]) {
        test(`a frontmatter name of ${length} characters is ${read ? 'read and compared with the stated type' : 'not a plain name, so it is not compared'}`, (t) => {
          const root = copyOfRepoFiles(t);
          rewrite(root, 'agents/gsd-planner.md', (text) => text.split('name: gsd-planner').join(`name: ${'a'.repeat(length)}`));
          const findings = runShipped(root, ['agent-skills-bootstrap']);
          if (read) assert.ok(findings.some((f) => /frontmatter name a+ must match the stated type gsd-planner/.test(f.message)), JSON.stringify(findings));
          else assert.deepEqual(findings, []);
        });
      }
      test('the first plain name line decides: an earlier line that is not a plain name is skipped', (t) => {
        const root = copyOfRepoFiles(t);
        rewrite(root, 'agents/gsd-planner.md', (text) => text.split('name: gsd-planner').join('name: two words\nname: gsd-planner'));
        assert.deepEqual(runShipped(root, ['agent-skills-bootstrap']), []);
      });
      test('a frontmatter name written in double quotes is read', (t) => {
        const root = copyOfRepoFiles(t);
        rewrite(root, 'agents/gsd-planner.md', (text) => text.split('name: gsd-planner').join('name: "gsd-planner"'));
        assert.deepEqual(runShipped(root, ['agent-skills-bootstrap']), []);
      });
      test('a nested file under agents/ is outside the sweep, as the flat readdir was', (t) => {
        const root = copyOfRepoFiles(t);
        fs.mkdirSync(path.join(root, 'agents', 'nested'), { recursive: true });
        fs.writeFileSync(path.join(root, 'agents', 'nested', 'gsd-nested.md'), 'agent-skills-bootstrap.md twice agent-skills-bootstrap.md\n');
        assert.deepEqual(runShipped(root, ['agent-skills-bootstrap']), []);
      });
      test('a compact sibling of a non-consumer may carry the pointer when it states its type', (t) => {
        const root = copyOfRepoFiles(t);
        rewrite(root, 'agents/gsd-intel-updater.compact.md', (text) => `${text}\n**agent_skills:** self-load per @~/.claude/gsd-core/references/${'agent-skills-bootstrap.md'} (agent type: \`gsd-intel-updater\`)\n`);
        assert.deepEqual(runShipped(root, ['agent-skills-bootstrap']), []);
      });
      test('the agents directory gone from the tree is a finding', (t) => {
        const root = copyOfRepoFiles(t);
        cleanup(path.join(root, 'agents'));
        const findings = runShipped(root, ['agent-skills-bootstrap']);
        assert.ok(findings.some((f) => /cannot read the directory/.test(f.message)), JSON.stringify(findings));
      });
      test('the bootstrap query line is the first line naming the query command', (t) => {
        const root = copyOfRepoFiles(t);
        rewrite(root, POINTER_FILE, (text) => `Run gsd_run query agent-skills now, without flags.\n${text}`);
        const findings = runShipped(root, ['agent-skills-bootstrap']);
        assert.ok(findings.some((f) => /the self-load query must pass --skills-only/.test(f.message)), JSON.stringify(findings));
      });
    }

    // spike-manifest-scoping: the four bounded windows at limit - 1 / limit / limit + 1 and the whitespace runs of the linear walks.
    {
      const SPIKE_MD = 'gsd-core/workflows/spike.md';
      const HEADER = '| # | Idea | Name | Type | Validates | Verdict | Tags |';
      gapCases('"new idea key" to "append"', SPIKE_MD, 'spike-manifest-scoping',
        (text, gap) => `${text.replace(/new idea key/gi, 'NEWKEY').replace(/append/gi, 'add')}\nnew idea key${'x'.repeat(gap)}append\n`,
        200, /a new idea must append a new idea section rather than overwrite/);
      gapCases('"Never touch" to "another idea"', SPIKE_MD, 'spike-manifest-scoping',
        (text, gap) => `${text.replace(/never touch/gi, 'Never')}\nNever touch${'x'.repeat(gap)}another idea\n`,
        80, /forbid touching another idea's section/);
      gapCases('"NEVER TOUCH" to "OTHER IDEA"', SPIKE_MD, 'spike-manifest-scoping',
        (text, gap) => `${text.replace(/never touch/gi, 'Never')}\nNEVER TOUCH${'x'.repeat(gap)}OTHER IDEA\n`,
        80, /forbid touching another idea's section/);
      gapCases('"old flat" to "shape"', SPIKE_MD, 'spike-manifest-scoping',
        (text, gap) => `${text.replace(/old flat/gi, 'oldflat')}\nold flat${'x'.repeat(gap)}shape\n`,
        40, /migrate a pre-#1700 flat-shape MANIFEST\.md in place/);
      gapCases('"current idea\'s" to "Requirements"', SPIKE_MD, 'spike-manifest-scoping',
        (text, gap) => `${text.replace(/current idea's/gi, 'current ideas')}\ncurrent idea's${'x'.repeat(gap)}Requirements\n`,
        80, /reground must scope its established-requirements check to the idea being spiked/);
      for (const [label, gapText] of [['300 spaces', ' '.repeat(300)], ['line breaks', '\n\n\n'], ['a tab and a no-break space', '\t\u00a0'], ['a form feed', '\f']]) {
        passes(`## Ideas with ${label} between the hashes and the word`, SPIKE_MD, (text) => text.split('## Ideas').join(`##${gapText}Ideas`), 'spike-manifest-scoping');
        passes(`### {idea-key} with ${label} between the hashes and the key`, SPIKE_MD, (text) => text.split('### {idea-key}').join(`###${gapText}{idea-key}`), 'spike-manifest-scoping');
        passes(`the Spikes table header with ${label} around every cell`, SPIKE_MD, (text) => text.split(HEADER).join(HEADER.split(' ').join(gapText)), 'spike-manifest-scoping');
        passes(`the README frontmatter with ${label} after "spike:" and "idea:"`, SPIKE_MD,
          (text) => text.split('spike: NNN\nidea: {idea-key}').join(`spike:${gapText}NNN\nidea:${gapText}{idea-key}`), 'spike-manifest-scoping');
      }
      passes('the Spikes table header without any space', SPIKE_MD, (text) => text.split(HEADER).join('|#|Idea|Name|Type|Validates|Verdict|Tags|'), 'spike-manifest-scoping');
      passes('the frontmatter placeholder written without a space after "idea:"', SPIKE_MD, (text) => text.split('idea: {idea-key}').join('idea:{idea-key}'), 'spike-manifest-scoping');
      passes('the idea heading written in capitals still names an idea key', SPIKE_MD, (text) => text.split('idea key').join('IDEA KEY').split('scoped to the IDEA KEY').join('scoped to the idea key'), 'spike-manifest-scoping');
      passes('a lower-case never-touch rule still satisfies the any-case check', SPIKE_MD, (text) => text.split('Never touch').join('never touch'), 'spike-manifest-scoping');
      passes('"every idea section" in capitals satisfies the any-case check', SPIKE_MD, (text) => text.split('every idea section').join('EVERY IDEA SECTION'), 'spike-manifest-scoping');
      passes('the lower-case never-include rule satisfies the [Nn] check', 'gsd-core/workflows/spike-wrap-up.md', (text) => text.split('Never include a requirement').join('never include a requirement'), 'spike-manifest-scoping');
    }

    // seed-scan-new-milestone: each alternative of an old disjunction alone satisfies its assertion; same-line chains take any gap and any case.
    {
      const NEW_MILESTONE_MD = 'gsd-core/workflows/new-milestone.md';
      const PLANT_SEED_MD = 'gsd-core/workflows/plant-seed.md';
      const CONTRACT = 'seed-scan-new-milestone';
      passes('the skip instruction 5000 characters after the condition on one line', NEW_MILESTONE_MD, (text) => text.split('**If no seed files exist:** Skip').join(`**If no seed files exist:**${'x'.repeat(5000)}Skip`), CONTRACT);
      passes('the no-seeds condition in capitals', NEW_MILESTONE_MD, (text) => text.split('no seed files exist').join('NO SEED FILES EXIST'), CONTRACT);
      passes('the auto-selection rule in capitals', NEW_MILESTONE_MD, (text) => text.split('Auto-select ALL matching seeds').join('AUTO-SELECT ALL MATCHING SEEDS'), CONTRACT);
      passes('the auto-selection rule with long gaps on one line', NEW_MILESTONE_MD,
        (text) => text.split('Auto-select ALL matching seeds').join(`Auto ${'-'.repeat(400)} select ${'.'.repeat(400)} all ${'.'.repeat(400)} matching ${'.'.repeat(400)} seed`), CONTRACT);
      passes('only "auto-surface" left of the two auto-surfacing patterns', PLANT_SEED_MD, (text) => text.replace(/auto.present/gi, 'x'), CONTRACT);
      passes('only "auto-present" left of the two auto-surfacing patterns', PLANT_SEED_MD, (text) => text.replace(/auto.surface/gi, 'x'), CONTRACT);
      passes('"auto surface" with a space is an auto-surfacing spelling', PLANT_SEED_MD, (text) => text.replace(/auto-surface/gi, 'auto surface').replace(/auto.present/gi, 'x'), CONTRACT);
      passes('"auto_present" with an underscore is an auto-surfacing spelling', PLANT_SEED_MD, (text) => text.replace(/auto.surface/gi, 'x').replace(/auto-present/gi, 'auto_present'), CONTRACT);
      passes('only "when relevant" left of the trigger_when defaults', PLANT_SEED_MD, (text) => text.replace(/default|when scope matches|unspecified/gi, ''), CONTRACT);
      passes('only "when scope matches" left of the trigger_when defaults', PLANT_SEED_MD, (text) => `${text.replace(/default|when relevant|unspecified/gi, '')}\nwhen scope matches\n`, CONTRACT);
      passes('only "unspecified" left of the trigger_when defaults', PLANT_SEED_MD, (text) => `${text.replace(/default|when relevant|when scope matches/gi, '')}\nUNSPECIFIED\n`, CONTRACT);
      passes('only the trigger_when-then-default line left of the trigger_when defaults', PLANT_SEED_MD, (text) => text.replace(/when relevant|when scope matches|unspecified/gi, ''), CONTRACT);
      passes('only a default-then-trigger line left of the trigger_when defaults', PLANT_SEED_MD, (text) => `${text.replace(/default|when relevant|when scope matches|unspecified/gi, '')}\nDefault for the Trigger\n`, CONTRACT);
      passes('only "unknown" left of the scope defaults', PLANT_SEED_MD, (text) => text.replace(/default|unspecified/gi, ''), CONTRACT);
      passes('only "unspecified" left of the scope defaults', PLANT_SEED_MD, (text) => `${text.replace(/default|unknown/gi, '')}\nunspecified\n`, CONTRACT);
      passes('only the scope-then-default line left of the scope defaults', PLANT_SEED_MD, (text) => text.replace(/unknown|unspecified/gi, ''), CONTRACT);
      passes('only a default-then-scope line left of the scope defaults', PLANT_SEED_MD, (text) => `${text.replace(/default|unknown|unspecified/gi, '')}\nDefault for the scope\n`, CONTRACT);
      passes('no Trigger, Why or Scope question at all', PLANT_SEED_MD, (text) => text.split('header: "Trigger"').join('header: "T"').split('header: "Why"').join('header: "W"').split('header: "Scope"').join('header: "S"'), CONTRACT);
      passes('no enrich or gather step: the one-shot path', PLANT_SEED_MD, (text) => text.split('<step name="enrich-seed">').join('<step name="confirm-extra">'), CONTRACT);
      passes('only a gather-context step left of the enrichment path', PLANT_SEED_MD,
        (text) => `${text.replace(/enrich/gi, 'x').split('header: "Trigger"').join('header: "T"')}\n<step name="gather-context">\n</step>\n`, CONTRACT);
      passes('only the word "gather_context" left of the enrichment path', PLANT_SEED_MD,
        (text) => `${text.replace(/enrich/gi, 'x').split('header: "Trigger"').join('header: "T"')}\ngather_context\n`, CONTRACT);
      passes('only the Trigger question left of the enrichment path', PLANT_SEED_MD, (text) => text.replace(/enrich|gather.context|gather_context/gi, 'x'), CONTRACT);
    }

    // agent-required-reading-consistency: the four floors (20 agents, 5 categories, 5 pattern sections, 100 spawner files) at limit - 1 / limit / limit + 1, and controls.
    {
      const CONTRACT = 'agent-required-reading-consistency';
      const PATTERNS_FILE = 'gsd-core/references/common-bug-patterns.md';
      const SPAWNER_DIRS = ['gsd-core/workflows', 'commands', 'gsd-core/references', 'gsd-core/templates', 'capabilities'];
      const markdownUnder = (root, rel) => fs.readdirSync(path.join(root, ...rel.split('/')), { withFileTypes: true })
        .flatMap((entry) => (entry.isDirectory() ? markdownUnder(root, `${rel}/${entry.name}`) : entry.name.endsWith('.md') ? [`${rel}/${entry.name}`] : []));
      const rewrite = (root, rel, edit) => {
        const abs = path.join(root, ...rel.split('/'));
        const before = fs.readFileSync(abs, 'utf8');
        const after = edit(before);
        assert.notEqual(after, before, 'the edit changed the file');
        fs.writeFileSync(abs, after);
      };
      const fullPasses = (title, edits) => test(title, (t) => {
        const root = copyOfRepoFiles(t, HEAVY);
        for (const [rel, edit] of edits) rewrite(root, rel, edit);
        assert.deepEqual(runShipped(root, [CONTRACT]), []);
      });
      const agentsWithReading = (root) => fs.readdirSync(path.join(root, 'agents'))
        .filter((name) => name.startsWith('gsd-') && name.endsWith('.md') && !name.endsWith('.compact.md'))
        .filter((name) => /required_reading|files_to_read/.test(fs.readFileSync(path.join(root, 'agents', name), 'utf8')));

      const AGENT_FLOOR = 20;
      for (const target of [AGENT_FLOOR - 1, AGENT_FLOOR, AGENT_FLOOR + 1]) {
        test(`${target} agents with reading instructions ${target >= AGENT_FLOOR ? 'satisfy' : 'fall short of'} the floor of ${AGENT_FLOOR}`, (t) => {
          const root = copyOfRepoFiles(t, HEAVY);
          const carrying = agentsWithReading(root).filter((name) => name !== 'gsd-debugger.md');
          const total = agentsWithReading(root).length;
          assert.ok(carrying.length >= total - target, `only ${carrying.length} strippable agents of ${total}`);
          for (const name of carrying.slice(0, total - target)) rewrite(root, `agents/${name}`, (text) => text.split('required_reading').join('required_rea_ding'));
          const findings = runShipped(root, [CONTRACT]);
          if (target >= AGENT_FLOOR) assert.deepEqual(findings, []);
          else assert.ok(findings.some((f) => /expected at least 20 agents with reading instructions, found 19/.test(f.message)), JSON.stringify(findings));
        });
      }

      const SPAWNER_FLOOR = 101;
      for (const target of [SPAWNER_FLOOR - 1, SPAWNER_FLOOR, SPAWNER_FLOOR + 1]) {
        test(`${target} spawner surface files ${target >= SPAWNER_FLOOR ? 'satisfy' : 'fall short of'} the sweep floor of more than 100`, (t) => {
          const root = copyOfRepoFiles(t, HEAVY);
          const files = SPAWNER_DIRS.flatMap((dir) => markdownUnder(root, dir)).sort();
          assert.ok(files.length >= target, `only ${files.length} spawner files in the copy`);
          const keep = new Set([PATTERNS_FILE, ...SPAWNER_DIRS.map((dir) => files.find((file) => file.startsWith(`${dir}/`)))]);
          for (const rel of files.filter((file) => !keep.has(file)).slice(0, files.length - target)) fs.unlinkSync(path.join(root, ...rel.split('/')));
          const findings = runShipped(root, [CONTRACT]);
          if (target >= SPAWNER_FLOOR) assert.deepEqual(findings, []);
          else assert.ok(findings.some((f) => /expected a large spawner surface \(more than 100 files\), found 100/.test(f.message)), JSON.stringify(findings));
        });
      }

      const CATEGORIES = ['Off-by-One', 'Null', 'Async', 'State Management', 'Import', 'Environment', 'Data Shape', 'String Handling', 'File System', 'Error Handling'];
      const keepOnly = (count) => (text) => {
        const stripped = text.replace(/off-by-one|null|async|state management|import|environment|data shape|string handling|file system|error handling/gi, 'zz');
        return `${stripped}\n${CATEGORIES.slice(0, count).join(' ')}\n`;
      };
      for (const [count, ok] of [[4, false], [5, true], [6, true]]) {
        test(`${count} expected bug categories ${ok ? 'satisfy' : 'fall short of'} the floor of 5`, (t) => {
          const root = copyOfRepoFiles(t, HEAVY);
          rewrite(root, PATTERNS_FILE, keepOnly(count));
          const findings = runShipped(root, [CONTRACT]);
          if (ok) assert.deepEqual(findings, []);
          else assert.ok(findings.some((f) => /expected at least 5 categories, found 4/.test(f.message)), JSON.stringify(findings));
        });
      }
      fullPasses('category names in capitals still count', [[PATTERNS_FILE, (text) => text.replace(/off-by-one/gi, 'OFF-BY-ONE').replace(/async/gi, 'ASYNC').replace(/environment/gi, 'ENVIRONMENT')]]);

      // The first <patterns> block has 11 sections; fold the later ones into the previous section to reach each count.
      const withSections = (count) => (text) => {
        let seen = 0;
        const open = text.indexOf('<patterns>');
        const close = text.indexOf('</patterns>');
        const block = text.slice(open, close).split('\n').map((line) => {
          if (!line.startsWith('## ')) return line;
          seen += 1;
          return seen <= count ? line : `#${line}`;
        }).join('\n');
        return text.slice(0, open) + block + text.slice(close);
      };
      for (const [count, ok] of [[4, false], [5, true], [6, true]]) {
        test(`${count} pattern sections ${ok ? 'satisfy' : 'fall short of'} the floor of 5`, (t) => {
          const root = copyOfRepoFiles(t, HEAVY);
          rewrite(root, PATTERNS_FILE, withSections(count));
          const findings = runShipped(root, [CONTRACT]);
          if (ok) assert.deepEqual(findings, []);
          else assert.ok(findings.some((f) => /expected at least 5 pattern sections, got 4/.test(f.message)), JSON.stringify(findings));
        });
      }
      fullPasses('a usage section after the patterns block needs no bold bullet', [[PATTERNS_FILE, (text) => `${text}\n<usage>\n## Plain usage heading\nNo bullets here.\n</usage>\n`]]);
      fullPasses('a second <patterns> block is not read', [[PATTERNS_FILE, (text) => `${text}\n<patterns>\n## Second block\nNo bold bullet here.\n</patterns>\n`]]);
      fullPasses('a compact sibling may still carry the legacy tag', [['agents/gsd-code-fixer.compact.md', (text) => `${text}\n<files_to_read>\n</files_to_read>\n`]]);
      test('files outside the roster (a nested agent file, a non-gsd file) may mention the legacy tag', (t) => {
        const root = copyOfRepoFiles(t, HEAVY);
        fs.mkdirSync(path.join(root, 'agents', 'nested'), { recursive: true });
        fs.writeFileSync(path.join(root, 'agents', 'nested', 'gsd-nested.md'), '<files_to_read>\n');
        fs.writeFileSync(path.join(root, 'agents', 'notes.md'), '<files_to_read>\n</files_to_read>\n');
        assert.deepEqual(runShipped(root, [CONTRACT]), []);
      });
      test('a non-markdown file in a spawner directory may mention the legacy tag', (t) => {
        const root = copyOfRepoFiles(t, HEAVY);
        fs.writeFileSync(path.join(root, 'commands', 'gsd', 'notes.txt'), '<files_to_read>\n');
        assert.deepEqual(runShipped(root, [CONTRACT]), []);
      });
      test('a nested markdown file in a spawner directory is swept', (t) => {
        const root = copyOfRepoFiles(t, HEAVY);
        fs.mkdirSync(path.join(root, 'capabilities', 'deep', 'er'), { recursive: true });
        fs.writeFileSync(path.join(root, 'capabilities', 'deep', 'er', 'notes.md'), '<files_to_read>\n');
        const findings = runShipped(root, [CONTRACT]);
        assert.ok(findings.some((f) => /capabilities\/deep\/er\/notes\.md still emits <files_to_read>: migrate/.test(f.message)), JSON.stringify(findings));
      });
      test('a spawner directory gone from the tree is a finding', (t) => {
        const root = copyOfRepoFiles(t, HEAVY);
        cleanup(path.join(root, 'capabilities'));
        const findings = runShipped(root, [CONTRACT]);
        assert.ok(findings.some((f) => /cannot read the directory/.test(f.message)), JSON.stringify(findings));
      });
    }

    // planner-decomposition: the two size limits at limit - 1 / limit / limit + 1 and the alternatives of the mode-content checks.
    {
      const CONTRACT = 'planner-decomposition';
      const PLANNER_MD = 'agents/gsd-planner.md';
      const REVISION_MD = 'gsd-core/references/planner-revision.md';
      const REVIEWS_MD = 'gsd-core/references/planner-reviews.md';
      const GAP_MD = 'gsd-core/references/planner-gap-closure.md';
      const PLAN_PHASE_MD = 'gsd-core/workflows/plan-phase.md';
      const EXTRACTED_LIMIT = 48 * 1024;
      const AGENT_LIMIT = 100 * 1024;
      const padTo = (length) => (text) => {
        assert.ok(length > text.length, `the planner is already ${text.length} characters`);
        return `${text}${'x'.repeat(length - text.length)}`;
      };
      const sizeCase = (label, length, expectExtracted, expectAgent) => test(`a planner of ${length} characters (${label})`, (t) => {
        const root = copyOfRepoFiles(t);
        const abs = path.join(root, ...PLANNER_MD.split('/'));
        fs.writeFileSync(abs, padTo(length)(fs.readFileSync(abs, 'utf8')));
        const messages = runShipped(root, [CONTRACT]).map((f) => f.message);
        assert.equal(messages.some((m) => /must stay under 48K characters/.test(m)), expectExtracted, JSON.stringify(messages));
        assert.equal(messages.some((m) => /must stay under the 100K agent file threshold/.test(m)), expectAgent, JSON.stringify(messages));
      });
      sizeCase('one below the 48K limit', EXTRACTED_LIMIT - 1, false, false);
      sizeCase('at the 48K limit', EXTRACTED_LIMIT, true, false);
      sizeCase('one above the 48K limit', EXTRACTED_LIMIT + 1, true, false);
      sizeCase('one below the 100K limit', AGENT_LIMIT - 1, true, false);
      sizeCase('at the 100K limit', AGENT_LIMIT, true, true);
      sizeCase('one above the 100K limit', AGENT_LIMIT + 1, true, true);
      passes('a planner written with CRLF line endings is measured after normalisation', PLANNER_MD, (text) => text.split('\n').join('\r\n'), CONTRACT);
      passes('only "--gaps" left of the gap-closure content', GAP_MD, (text) => text.replace(/gap_closure|gap closure/gi, 'x'), CONTRACT);
      passes('only "GAP CLOSURE" in capitals left of the gap-closure content', GAP_MD, (text) => text.replace(/gap_closure|--gaps|gap closure/gi, 'x').concat('\nGAP CLOSURE\n'), CONTRACT);
      passes('only "gap_closure" left of the gap-closure content', GAP_MD, (text) => `${text.replace(/gap_closure|gap closure|--gaps/gi, 'x')}\ngap_closure\n`, CONTRACT);
      passes('only "REVISION" in capitals left of the revision content', REVISION_MD, (text) => text.replace(/revision/gi, 'REVISION'), CONTRACT);
      passes('only "Revision" left of the revision content', REVISION_MD, (text) => text.replace(/revision/gi, 'Revision'), CONTRACT);
      passes('only "REVIEWS" in capitals left of the reviews content', REVIEWS_MD, (text) => text.replace(/reviews/gi, 'REVIEWS'), CONTRACT);
      passes('only "Reviews" left of the reviews content', REVIEWS_MD, (text) => text.replace(/reviews/gi, 'Reviews'), CONTRACT);
      passes('the forbidden deep_work_rules phrases after the block are not read', PLAN_PHASE_MD, append('copy them into the action verbatim\ncomplete the task from the action text alone'), CONTRACT);
      passes('a second deep_work_rules block is not read', PLAN_PHASE_MD, append('<deep_work_rules>copy them into the action verbatim</deep_work_rules>'), CONTRACT);
    }

    // mempalace-capture-gate-default: the shapes the linear "unless" walk and the connective reader accept and refuse, and the controls.
    {
      const CONTRACT = 'mempalace-capture-gate-default';
      const RECALL_COMMAND_MD = 'commands/gsd/mempalace-recall.md';
      const CAPTURE_COMMAND_MD = 'commands/gsd/mempalace-capture.md';
      const GATE = '(when `config.mempalace.mirror_kg !== false`';
      const unlessShapes = [
        ['unless and a backticked predicate on one line', 'Skip unless `k !== false`.'],
        ['unless, an opening parenthesis and the predicate', 'Skip unless (`k !== false`).'],
        ['unless and the predicate on the next line', 'Skip unless\n`k !== false`.'],
        ['unless and 5000 spaces before the predicate', `Skip unless${' '.repeat(5000)}\`k !== false\`.`],
        ['a line break between the operator and false', 'Skip unless `k !==\nfalse`.'],
        ['no space between the operator and false', 'Skip unless `k !==false`.'],
        ['an earlier comparison before the last operator', 'Skip unless `a !== b && c !== false`.'],
        ['a predicate with no left-hand text', 'Skip unless `!== false`.'],
      ];
      for (const [label, line] of unlessShapes) {
        test(`${label} is an unless gate over !== false`, (t) => {
          const root = copyOfRepoFiles(t);
          const abs = path.join(root, ...CAPTURE_COMMAND_MD.split('/'));
          fs.writeFileSync(abs, `${fs.readFileSync(abs, 'utf8')}\n${line}\n`);
          const findings = runShipped(root, [CONTRACT]);
          assert.ok(findings.some((f) => /must not pair "unless" with a `!== false` predicate/.test(f.message)), JSON.stringify(findings));
        });
      }
      const notUnlessGates = [
        ['a predicate that continues after false', 'Skip unless `k !== false && x`.'],
        ['a longer word than false', 'Skip unless `k !== falsey`.'],
        ['unless as the end of a longer word', 'Skip preunless `k !== false`.'],
        ['unless as the start of a longer word', 'Skip unlessx `k !== false`.'],
        ['a closed span before the predicate', 'Skip unless `k` and `j !== false`.'],
        ['an unclosed span', 'Skip unless `k !== false'],
        ['the strict operator in place of !==', 'Skip unless `k != false`.'],
        ['a capitalised Unless is not the lower-case word the pattern names', 'Skip Unless `k !== false`.'],
      ];
      for (const [label, line] of notUnlessGates) {
        passes(`${label} is not an unless gate`, CAPTURE_COMMAND_MD, append(line), CONTRACT);
      }
      passes('"only if" before the predicate is a when-style connective', RECALL_COMMAND_MD, swap(GATE, '(only if `config.mempalace.mirror_kg !== false`'), CONTRACT);
      passes('"only  if" with two spaces is a when-style connective', RECALL_COMMAND_MD, swap(GATE, '(only  if `config.mempalace.mirror_kg !== false`'), CONTRACT);
      passes('"only" and "if" on separate lines is a when-style connective', RECALL_COMMAND_MD, swap(GATE, '(only\nif `config.mempalace.mirror_kg !== false`'), CONTRACT);
      passes('markdown emphasis around "when" does not change what is read', RECALL_COMMAND_MD, swap(GATE, '(**when** `config.mempalace.mirror_kg !== false`'), CONTRACT);
      passes('"WHEN" in capitals is a when-style connective', RECALL_COMMAND_MD, swap(GATE, '(WHEN `config.mempalace.mirror_kg !== false`'), CONTRACT);
      test('"Unless" in capitals before the gate is read as unless', (t) => {
        const root = copyOfRepoFiles(t);
        const abs = path.join(root, ...RECALL_COMMAND_MD.split('/'));
        fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').split(GATE).join('(Unless `config.mempalace.mirror_kg !== false`'));
        const findings = runShipped(root, [CONTRACT]);
        assert.ok(findings.some((f) => /introduces `config\.mempalace\.mirror_kg !== false` with "unless"/.test(f.message)), JSON.stringify(findings));
      });
      passes('an explanatory mention of the predicate next to a when gate is not a failing gate', RECALL_COMMAND_MD, append('The predicate is `config.mempalace.mirror_kg !== false` when read.'), CONTRACT);
      passes('the capture command may use unless with the correct === false form', CAPTURE_COMMAND_MD, append('Skip unless `k === false`.'), CONTRACT);
    }

    // verifier-coincidental-reliance: the 1400- and 500-character windows at limit - 1 / limit / limit + 1, the status-union parse and the controls.
    {
      const CONTRACT = 'verifier-coincidental-reliance';
      const VERIFIER_MD = 'agents/gsd-verifier.md';
      const RULE_ANCHOR = 'coincidental-reliance';
      const ITEMS_ANCHOR = 'coincidental_reliance_items: #';
      const RULE_FILLER = '✓ VERIFIED truth PRESENT_BEHAVIOR_UNVERIFIED override do not flag enforce default honest-verifier confidence score not the score not the status never emits a human-verification item';
      const ITEMS_FILLER = 'truth: harden survive';
      const RULE_LIMIT = 1400 - 'insufficient_spec'.length;
      const ITEMS_LIMIT = 500 - 'reason:'.length;
      // The tested phrase sits `gap` characters after the first mention (the rest of the rule just before it), or before it.
      gapCases('insufficient_spec after the first coincidental-reliance', VERIFIER_MD, CONTRACT,
        (text, gap) => `${RULE_FILLER} ${RULE_ANCHOR}${'x'.repeat(gap)}insufficient_spec\n${text}`, RULE_LIMIT,
        /must not double-report truths already routed to human verification \(insufficient_spec\)/);
      gapCases('insufficient_spec before the first coincidental-reliance', VERIFIER_MD, CONTRACT,
        (text, gap) => `insufficient_spec${'x'.repeat(gap)}${RULE_ANCHOR} ${RULE_FILLER}\n${text}`, RULE_LIMIT,
        /must not double-report truths already routed to human verification \(insufficient_spec\)/);
      gapCases('reason: after the frontmatter key', VERIFIER_MD, CONTRACT,
        (text, gap) => `${ITEMS_FILLER} ${ITEMS_ANCHOR}${'x'.repeat(gap)}reason:\n${text}`, ITEMS_LIMIT,
        /an item must name the reason/);
      gapCases('reason: before the frontmatter key', VERIFIER_MD, CONTRACT,
        (text, gap) => `reason:${'x'.repeat(gap)}${ITEMS_ANCHOR} ${ITEMS_FILLER}\n${text}`, ITEMS_LIMIT,
        /an item must name the reason/);
      passes('the first mention at the very start of the file clips the window', VERIFIER_MD, (text) => `${RULE_ANCHOR} ${RULE_FILLER} insufficient_spec\n${text}`, CONTRACT);

      const UNION = 'status: passed | gaps_found | human_needed';
      const unionShapes = [
        ['extra blanks around the bars', 'status:   passed  |  gaps_found |human_needed   '],
        ['no blanks around the bars', 'status: passed|gaps_found|human_needed'],
        ['a union broken over lines', 'status: passed |\ngaps_found |\nhuman_needed'],
        ['the first status on the next line', 'status:\n  passed | gaps_found | human_needed'],
        ['a carriage return after the union', `${UNION}\rnext`],
        ['a line separator after the union', `${UNION}\u2028next`],
        ['a paragraph separator after the union', `${UNION}\u2029next`],
      ];
      for (const [label, shape] of unionShapes) passes(`a status union with ${label} is still a union line`, VERIFIER_MD, swap(UNION, shape), CONTRACT);
      test('an indented status union is not at a line start, so no union line is found', (t) => {
        const root = copyOfRepoFiles(t);
        const abs = path.join(root, ...VERIFIER_MD.split('/'));
        fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').split(UNION).join(`  ${UNION}`));
        const findings = runShipped(root, [CONTRACT]);
        assert.ok(findings.some((f) => /expected at least one status union line/.test(f.message)), JSON.stringify(findings));
      });
      test('a leak of the advisory into a union that spans lines is found', (t) => {
        const root = copyOfRepoFiles(t);
        const abs = path.join(root, ...VERIFIER_MD.split('/'));
        fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').split(UNION).join('status: passed | gaps_found |\nhuman_needed | coincidental_x'));
        const findings = runShipped(root, [CONTRACT]);
        assert.ok(findings.some((f) => /the per-truth advisory leaked into the status vocabulary/.test(f.message)), JSON.stringify(findings));
      });
      test('a second cell of a row that mentions the advisory must be suffixed too', (t) => {
        const root = copyOfRepoFiles(t);
        const abs = path.join(root, ...VERIFIER_MD.split('/'));
        const cell = '| ✓ VERIFIED (coincidental-reliance) |';
        fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').split(cell).join('| ✓ VERIFIED (coincidental-reliance) | (coincidental-reliance) |'));
        const findings = runShipped(root, [CONTRACT]);
        assert.ok(findings.some((f) => /a verdict cell must render as "✓ VERIFIED \(coincidental-reliance\)": \(coincidental-reliance\)/.test(f.message)), JSON.stringify(findings));
      });
      passes('a line that mentions the advisory without a table bar is not a verdict cell', VERIFIER_MD, append('The coincidental-reliance advisory is a qualifier.'), CONTRACT);
      passes('"only if" in lower case after the items key satisfies the convention', VERIFIER_MD, swap('coincidental_reliance_items: # Only if', 'coincidental_reliance_items: # only if'), CONTRACT);
      test('"only if" before the items key on the line is not the convention', (t) => {
        const root = copyOfRepoFiles(t);
        const abs = path.join(root, ...VERIFIER_MD.split('/'));
        fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').split('coincidental_reliance_items: # Only if').join('only if coincidental_reliance_items: # Whenever'));
        const findings = runShipped(root, [CONTRACT]);
        assert.ok(findings.some((f) => /the items list must be omitted when nothing is flagged/.test(f.message)), JSON.stringify(findings));
      });
      passes('the pointer to the template may sit after other text on its line', 'gsd-core/references/verifier-phase-gates.md', append('see @~/x/gsd-core/templates/verification-report.md here'), CONTRACT);
      passes('the imperative check in capitals satisfies the any-case pattern', 'gsd-core/templates/verification-report.md',
        swap('apply the reliance check to every `✓ VERIFIED` truth', 'APPLY THE RELIANCE CHECK TO EVERY `✓ VERIFIED` TRUTH'), CONTRACT);
    }

    // execute-phase-step-5-5-deviation-doc: the dot-all worktree-discovery probe takes any distance; the human_needed section is bounded by its two markers.
    {
      const CONTRACT = 'execute-phase-step-5-5-deviation-doc';
      const WORKFLOW_MD = 'gsd-core/workflows/execute-phase.md';
      const inBlock = (edit) => within('\n5.5.', '\n5.6.', edit);
      const inHumanNeeded = (edit) => within('**If human_needed:**', '**If gaps_found:**', edit);
      passes('an agent worktree path before the worktree list command is not discovery', WORKFLOW_MD, inBlock((block) => `${block.split('git worktree list --porcelain').join('git worktree show')}\n.claude/worktrees/agent-a\ngit worktree list --porcelain\n`), CONTRACT);
      passes('a worktree list command with no agent path after it is not discovery', WORKFLOW_MD, inBlock((block) => `${block}\ngit worktree list --porcelain\n`), CONTRACT);
      passes('an agent path after step 5.5 is outside the probe', WORKFLOW_MD, (text) => `${inBlock((block) => `${block}\ngit worktree list --porcelain\n`)(text)}\n.claude/worktrees/agent-a\n`, CONTRACT);
      test('a worktree list command followed by an agent path 100000 characters later is still discovery', (t) => {
        const root = copyOfRepoFiles(t);
        const abs = path.join(root, ...WORKFLOW_MD.split('/'));
        fs.writeFileSync(abs, inBlock((block) => `${block}\ngit worktree list --porcelain${'x'.repeat(100000)}.claude/worktrees/agent-a\n`)(fs.readFileSync(abs, 'utf8')));
        const findings = runShipped(root, [CONTRACT]);
        assert.ok(findings.some((f) => /the cleanup-tail must not parse global git worktree list output for agent worktrees/.test(f.message)), JSON.stringify(findings));
      });
      test('a worktree list command followed by an agent path after a blank line is still discovery', (t) => {
        const root = copyOfRepoFiles(t);
        const abs = path.join(root, ...WORKFLOW_MD.split('/'));
        fs.writeFileSync(abs, inBlock((block) => `${block}\ngit worktree list --porcelain\n\n\n.claude/worktrees/agent-a\n`)(fs.readFileSync(abs, 'utf8')));
        const findings = runShipped(root, [CONTRACT]);
        assert.ok(findings.some((f) => /the cleanup-tail must not parse global git worktree list output for agent worktrees/.test(f.message)), JSON.stringify(findings));
      });
      passes('HUMAN-UAT.md after the gaps_found marker is outside the human_needed section', WORKFLOW_MD, append('Legacy name: HUMAN-UAT.md.'), CONTRACT);
      passes('update_roadmap after the gaps_found marker is outside the human_needed section', WORKFLOW_MD, append('Then update_roadmap.'), CONTRACT);
      test('verify-work only after the gaps_found marker does not satisfy the human_needed branch', (t) => {
        const root = copyOfRepoFiles(t);
        const abs = path.join(root, ...WORKFLOW_MD.split('/'));
        fs.writeFileSync(abs, `${inHumanNeeded((section) => section.split('verify-work').join('verification'))(fs.readFileSync(abs, 'utf8'))}\nverify-work\n`);
        const findings = runShipped(root, [CONTRACT]);
        assert.ok(findings.some((f) => /the human_needed branch must direct the user to \/gsd:verify-work/.test(f.message)), JSON.stringify(findings));
      });
      passes('text appended inside the human_needed section is read as part of it', WORKFLOW_MD, inHumanNeeded((section) => `${section}\nSee verify-work and the -UAT.md file.\n`), CONTRACT);
    }

    // Round 1 review of group 2: one finding for one missing file, the frontmatter name read, the connective lookback, the step-name guards, the end-of-file heading, the registry and status-enum seams.
    {
      const contractModule = (id) => require(path.join(REPO_ROOT, 'scripts', 'static-checks', 'text-contracts', `${id}.cjs`));
      const editFile = (root, rel, edit) => {
        const abs = path.join(root, ...rel.split('/'));
        const before = fs.readFileSync(abs, 'utf8');
        const after = edit(before);
        assert.notEqual(after, before, 'the edit changed the file');
        fs.writeFileSync(abs, after);
      };
      const OWN_FILES = {
        'agent-skills-bootstrap': ['gsd-core/references/agent-skills-bootstrap.md', 'gsd-core/references/gsd-run-resolver.md', 'agents/gsd-planner.md'],
        'agent-required-reading-consistency': ['gsd-core/references/common-bug-patterns.md', 'agents/gsd-debugger.md'],
        'planner-decomposition': ['agents/gsd-planner.md', 'gsd-core/references/planner-gap-closure.md', 'gsd-core/references/planner-revision.md',
          'gsd-core/references/planner-reviews.md', 'gsd-core/references/planner-guidance.md', 'gsd-core/workflows/plan-phase.md'],
        'execute-phase-step-5-5-deviation-doc': ['gsd-core/workflows/execute-phase.md'],
        'mempalace-capture-gate-default': ['skills/gsd-mempalace-capture/SKILL.md', 'commands/gsd/mempalace-capture.md', 'skills/gsd-mempalace-recall/SKILL.md',
          'commands/gsd/mempalace-recall.md', 'agents/gsd-mempalace-curator.md', 'agents/gsd-mempalace-curator.compact.md'],
        'verifier-coincidental-reliance': ['agents/gsd-verifier.md', 'gsd-core/templates/verification-report.md', 'docs/reference/agents.md', 'gsd-core/references/verifier-phase-gates.md'],
        'spike-manifest-scoping': ['gsd-core/workflows/spike.md', 'gsd-core/workflows/spike-wrap-up.md', 'gsd-core/workflows/sketch.md', 'gsd-core/references/artifact-types.md'],
        'seed-scan-new-milestone': ['gsd-core/workflows/new-milestone.md', 'gsd-core/workflows/plant-seed.md'],
      };
      for (const [contract, files] of Object.entries(OWN_FILES)) {
        for (const rel of files) {
          test(`${rel} removed from the tree is exactly one finding for that file under ${contract}`, (t) => {
            const root = copyOfRepoFiles(t, HEAVY);
            fs.unlinkSync(path.join(root, ...rel.split('/')));
            const own = runShipped(root, [contract]).filter((f) => f.file === rel);
            assert.equal(own.length, 1, JSON.stringify(own));
            assert.match(own[0].message, /cannot read the file/);
          });
        }
      }

      // The frontmatter name is read the way the old multiline pattern read it: whitespace, line breaks included, may precede the value.
      const AGENT = 'agents/gsd-planner.md';
      const NAME_LINE = 'name: gsd-planner';
      const nameMismatch = /frontmatter name gsd-other must match the stated type gsd-planner/;
      for (const [label, written] of [
        ['on the next line', 'name:\n  gsd-other'],
        ['after several blank lines', 'name:\n\n\n  gsd-other'],
        ['in double quotes with trailing blanks', 'name:   "gsd-other"   '],
        ['on the next line in double quotes', 'name:\n  "gsd-other"'],
        ['before a line separator', `name: gsd-other${String.fromCharCode(0x2028)}`],
        ['before a carriage return', 'name: gsd-other\r'],
      ]) {
        test(`a frontmatter name ${label} is read and compared with the stated type`, (t) => {
          const root = copyOfRepoFiles(t);
          editFile(root, AGENT, (text) => text.split(NAME_LINE).join(written));
          const findings = runShipped(root, ['agent-skills-bootstrap']);
          assert.ok(findings.some((f) => nameMismatch.test(f.message)), JSON.stringify(findings));
        });
      }
      passes('a frontmatter name on the next line that matches the stated type', AGENT, (text) => text.split(NAME_LINE).join('name:\n  gsd-planner'), 'agent-skills-bootstrap');
      passes('a name value followed by more words is not a plain name', AGENT, (text) => text.split(NAME_LINE).join('name: gsd-other extra words'), 'agent-skills-bootstrap');
      passes('a name value ending in a quote and text is not a plain name', AGENT, (text) => text.split(NAME_LINE).join('name: "gsd-other" tail'), 'agent-skills-bootstrap');
      passes('a name key that is not at a line start is not read', AGENT, (text) => text.split(NAME_LINE).join(' name: gsd-other'), 'agent-skills-bootstrap');

      // The connective before a `!== false` gate is read from the 80 characters before the predicate: "when" ends 76 characters before it at the limit.
      gapCases('the connective before the mirror_kg gate', 'commands/gsd/mempalace-recall.md', 'mempalace-capture-gate-default',
        (text, gap) => text.split('(when `config.mempalace.mirror_kg !== false`').join(`(when${'-'.repeat(gap)}\`config.mempalace.mirror_kg !== false\``), 76,
        /must introduce its `config\.mempalace\.mirror_kg !== false` gate with "when" or "only if" \(found: hen\)/);

      // seed-scan-new-milestone: a step tag with an empty name or no closing quote is skipped.
      passes('a step with an empty name is skipped', 'gsd-core/workflows/plant-seed.md', (text) => text.split('<step name="parse-idea">').join('<step name="">\n</step>\n<step name="parse-idea">'), 'seed-scan-new-milestone');
      passes('a step tag with no closing quote at the very end of the file is skipped', 'gsd-core/workflows/plant-seed.md', (text) => `${text}\n<step name="`, 'seed-scan-new-milestone');

      // spike-manifest-scoping: the `## Ideas` heading as the last bytes of the file satisfies the section check by itself.
      passes('## Ideas as the last bytes of the file, with every other heading word changed', 'gsd-core/workflows/spike.md', (text) => `${text.split('Ideas').join('Ideax')}\n## Ideas`, 'spike-manifest-scoping');
      test('## Ideas followed by a word character as the last bytes of the file is not the heading', (t) => {
        const root = copyOfRepoFiles(t);
        editFile(root, 'gsd-core/workflows/spike.md', (text) => `${text.split('Ideas').join('Ideax')}\n## Ideasx`);
        const findings = runShipped(root, ['spike-manifest-scoping']);
        assert.ok(findings.some((f) => /must have a `## Ideas` section \(plural\)/.test(f.message)), JSON.stringify(findings));
      });

      // The registry and status-enum checks are functions of the shipped module, so other shapes can be fed to them.
      const mempalace = contractModule('mempalace-capture-gate-default');
      const settings = (overrides = {}) => ({
        'mempalace.enabled': { type: 'boolean', default: false },
        'mempalace.capture_artifacts': { type: 'boolean', default: true },
        'mempalace.mirror_kg': { type: 'boolean', default: true },
        'mempalace.diary_journal': { type: 'boolean', default: true },
        'mempalace.cross_project_tunnels': { type: 'boolean', default: false },
        ...overrides,
      });
      const registryOf = (schema) => ({ capabilities: { mempalace: { group: { nested: schema } } } });
      const SCHEMA_PROBLEM = 'the capability registry must expose a mempalace settings schema';
      test('a registry with the declared defaults has no problem and reports its default-true keys', () => {
        const result = mempalace.registryProblems(registryOf(settings()));
        assert.deepEqual(result.problems, []);
        assert.deepEqual([...result.defaultTrue].sort(), ['mempalace.capture_artifacts', 'mempalace.diary_journal', 'mempalace.mirror_kg']);
      });
      for (const [label, registry] of [
        ['no registry', undefined], ['a null registry', null], ['a string registry', 'registry'], ['a registry with no capabilities', {}],
        ['null capabilities', { capabilities: null }], ['capabilities without a mempalace node', { capabilities: {} }], ['a null mempalace node', { capabilities: { mempalace: null } }],
        ['a mempalace node with no settings schema', { capabilities: { mempalace: { other: { type: 'boolean' } } } }],
      ]) {
        test(`${label} is a problem, not a throw`, () => assert.deepEqual(mempalace.registryProblems(registry).problems, [SCHEMA_PROBLEM]));
      }
      for (const entry of [null, 'text', 7, undefined]) {
        test(`a ${entry === null ? 'null' : typeof entry} entry in the settings schema is skipped`, () => {
          assert.deepEqual(mempalace.registryProblems(registryOf(settings({ 'mempalace.extra': entry }))).problems, []);
        });
      }
      for (const key of ['mempalace.capture_artifacts', 'mempalace.mirror_kg', 'mempalace.diary_journal']) {
        test(`${key} declared default false is a problem`, () => {
          assert.deepEqual(mempalace.registryProblems(registryOf(settings({ [key]: { type: 'boolean', default: false } }))).problems, [`${key} must declare default: true in the capability registry`]);
        });
        test(`${key} declared as a string is not a default-true boolean`, () => {
          assert.deepEqual(mempalace.registryProblems(registryOf(settings({ [key]: { type: 'string', default: true } }))).problems, [`${key} must declare default: true in the capability registry`]);
        });
      }
      test('mempalace.enabled declared default true is a problem', () => {
        assert.deepEqual(mempalace.registryProblems(registryOf(settings({ 'mempalace.enabled': { type: 'boolean', default: true } }))).problems, ['mempalace.enabled must stay default: false: the master switch is opt-in']);
      });
      test('mempalace.enabled missing from the schema is a problem', () => {
        const { 'mempalace.enabled': omitted, ...rest } = settings();
        assert.equal(omitted.default, false);
        assert.deepEqual(mempalace.registryProblems(registryOf(rest)).problems, ['mempalace.enabled must stay default: false: the master switch is opt-in']);
      });
      test('a settings schema nested six levels deep is still found', () => {
        const deep = { capabilities: { mempalace: { a: { b: { c: { d: { e: settings() } } } } } } };
        assert.deepEqual(mempalace.registryProblems(deep).problems, []);
      });

      const verifier = contractModule('verifier-coincidental-reliance');
      const STATUS_PROBLEM = 'the VERIFIER_STATUSES set must be present';
      test('the expected overall-status set has no problem', () => assert.deepEqual(verifier.statusEnumProblems({ VERIFIER_STATUSES: new Set(['human_needed', 'passed', 'gaps_found']) }), []));
      for (const [label, verification] of [['no module', undefined], ['a null module', null], ['a module with an array', { VERIFIER_STATUSES: ['passed', 'gaps_found', 'human_needed'] }], ['a module with a plain object', { VERIFIER_STATUSES: {} }], ['a module with no set', {}]]) {
        test(`${label} is a problem, not a throw`, () => assert.deepEqual(verifier.statusEnumProblems(verification), [STATUS_PROBLEM]));
      }
      for (const [label, statuses] of [
        ['an extra status', ['passed', 'gaps_found', 'human_needed', 'other']],
        ['a missing status', ['passed', 'gaps_found']],
        ['the advisory as a status', ['passed', 'gaps_found', 'human_needed', 'coincidental_reliance']],
        ['the advisory in place of a status', ['passed', 'gaps_found', 'coincidental']],
      ]) {
        test(`${label} in the overall-status set is a problem`, () => {
          const problems = verifier.statusEnumProblems({ VERIFIER_STATUSES: new Set(statuses) });
          assert.equal(problems.length, 1, JSON.stringify(problems));
          assert.match(problems[0], /the overall-status enum must stay gaps_found, human_needed, passed \(found: /);
        });
      }

      // ---- Round 2 review of group 2 ----
      // Emptied files: one handle per path, so an empty file is exactly one finding for that file.
      for (const [contract, files] of Object.entries(OWN_FILES)) {
        for (const rel of files) {
          test(`${rel} emptied is exactly one finding for that file under ${contract}`, (t) => {
            const root = copyOfRepoFiles(t, HEAVY);
            editFile(root, rel, () => '');
            const own = runShipped(root, [contract]).filter((f) => f.file === rel);
            assert.equal(own.length, 1, JSON.stringify(own));
            assert.match(own[0].message, /the file is empty/);
          });
        }
      }

      // One finding per cause.
      const exactlyOne = (title, contract, rel, edit, message) => test(title, (t) => {
        const root = copyOfRepoFiles(t, HEAVY);
        editFile(root, rel, edit);
        const own = runShipped(root, [contract]).filter((f) => f.file === rel);
        assert.equal(own.length, 1, JSON.stringify(own));
        assert.match(own[0].message, message);
      });
      const BOOT_MD = 'gsd-core/references/agent-skills-bootstrap.md';
      exactlyOne('every "frontmatter" gone from the bootstrap is one finding', 'agent-skills-bootstrap', BOOT_MD, (text) => text.split('frontmatter').join('header').split('Frontmatter').join('Header'), /instruct query agent-skills using the frontmatter name/);
      exactlyOne('the query command gone from the bootstrap is one finding', 'agent-skills-bootstrap', BOOT_MD, (text) => text.split('query agent-skills').join('query skills'), /the bootstrap must carry the query command/);
      exactlyOne('--skills-only gone from the whole bootstrap is one finding', 'agent-skills-bootstrap', BOOT_MD, (text) => text.split('--skills-only').join(''), /the self-load query must pass --skills-only/);
      exactlyOne('"skip" and "already" both gone from the bootstrap is one finding', 'agent-skills-bootstrap', BOOT_MD, (text) => text.replace(/skip|already/gi, 'x'), /dedup guard.*\(missing skip, already\)/);
      exactlyOne('"non-Claude" and "persona" both gone from the bootstrap is one finding', 'agent-skills-bootstrap', BOOT_MD, (text) => text.split('non-Claude').join('other').replace(/persona/gi, 'x'), /\(missing non-Claude\)/);
      const CAPTURE_SKILL_MD = 'skills/gsd-mempalace-capture/SKILL.md';
      const CURATOR_MD = 'agents/gsd-mempalace-curator.md';
      const RECALL_COMMAND_MD = 'commands/gsd/mempalace-recall.md';
      exactlyOne('mirror_kg gated on positive presence in the capture skill is one finding', 'mempalace-capture-gate-default', CAPTURE_SKILL_MD, (text) => `${text}\nMirror when \`config.mempalace.mirror_kg\` is true.\n`, /must not gate mirror_kg on positive presence/);
      exactlyOne('diary_journal gated on positive presence by its bare name in the curator is one finding', 'mempalace-capture-gate-default', CURATOR_MD, (text) => `${text}\nRun when \`mempalace.diary_journal\` is true.\n`, /must not gate diary_journal on positive presence/);
      exactlyOne('the diary gate gone from the curator is one finding', 'mempalace-capture-gate-default', CURATOR_MD, (text) => text.split('mempalace.diary_journal !== false').join('mempalace.diary_journal'), /diary gate must run when mempalace\.diary_journal !== false/);
      exactlyOne('the mirror_kg gate gone from the recall command is one finding', 'mempalace-capture-gate-default', RECALL_COMMAND_MD, (text) => text.split('config.mempalace.mirror_kg !== false').join('config.mempalace.mirror_kg'), /KG-facts step must gate on config\.mempalace\.mirror_kg !== false/);
      exactlyOne('a gate predicate without its backticks is one finding', 'mempalace-capture-gate-default', CURATOR_MD, (text) => text.split('`mempalace.diary_journal !== false`').join('mempalace.diary_journal !== false'), /must still carry the `mempalace\.diary_journal !== false` gate in backticks/);
      const EXECUTE_PHASE_MD = 'gsd-core/workflows/execute-phase.md';
      exactlyOne('the gaps_found marker gone from execute-phase is one finding', 'execute-phase-step-5-5-deviation-doc', EXECUTE_PHASE_MD, (text) => text.split('**If gaps_found:**').join('**Gaps found:**'), /closing marker "\*\*If gaps_found:\*\*" not found/);
      exactlyOne('the human_needed marker gone from execute-phase is one finding', 'execute-phase-step-5-5-deviation-doc', EXECUTE_PHASE_MD, (text) => text.split('**If human_needed:**').join('**Needs a human:**'), /marker "\*\*If human_needed:\*\*" not found/);
      exactlyOne('one backticked legacy tag in an agent is one finding', 'agent-required-reading-consistency', 'agents/gsd-verifier.md', (text) => `${text}\nRead the \`<files_to_read>\` block.\n`, /still has the legacy <files_to_read> opening tag: migrate/);
      exactlyOne('a legacy block in an agent is one finding naming both tags', 'agent-required-reading-consistency', 'agents/gsd-verifier.md', (text) => `${text}\n<files_to_read>\nfoo\n</files_to_read>\n`, /still has the legacy <files_to_read> opening tag and <\/files_to_read> closing tag/);
      exactlyOne('the bare word in an agent is one finding', 'agent-required-reading-consistency', 'agents/gsd-verifier.md', (text) => `${text}\nSee files_to_read.\n`, /still uses files_to_read/);
      exactlyOne('a legacy block in a spawner surface is one finding naming both tags', 'agent-required-reading-consistency', 'gsd-core/workflows/new-milestone.md', (text) => `${text}\n<files_to_read>\nfoo\n</files_to_read>\n`, /still emits <files_to_read> and <\/files_to_read>/);
      exactlyOne('a legacy opening tag in a spawner surface is one finding', 'agent-required-reading-consistency', 'commands/gsd/add-tests.md', (text) => `${text}\n<files_to_read>\n`, /still emits <files_to_read>: migrate/);

      // The frontmatter name is read from the frontmatter alone.
      passes('a body name line is not read when the frontmatter name matches', AGENT, (text) => `${text}\nname: gsd-other\n`, 'agent-skills-bootstrap');
      passes('a frontmatter without a name line is not compared even when the body names another agent', AGENT, (text) => `${text.split('name: gsd-planner\n').join('')}\nname: gsd-other\n`, 'agent-skills-bootstrap');
      test('a pointer-carrying agent with no closed frontmatter is a finding', (t) => {
        const root = copyOfRepoFiles(t);
        editFile(root, AGENT, (text) => text.slice(text.indexOf('\n') + 1));
        const findings = runShipped(root, ['agent-skills-bootstrap']);
        assert.ok(findings.some((f) => f.file === AGENT && /no closed YAML frontmatter block/.test(f.message)), JSON.stringify(findings));
      });

      // verifier-coincidental-reliance: the branches of the status-union walk that skip a line.
      const VERIFIER_MD = 'agents/gsd-verifier.md';
      const STATUS_LINE = 'status: passed | gaps_found | human_needed';
      for (const [label, written] of [['no blank after status:', 'status:passed | gaps_found | human_needed'], ['a capitalised first status', 'status: Passed | gaps_found | human_needed'], ['no bar after the first status', 'status: passed gaps_found human_needed']]) {
        test(`a status line with ${label} is not a union line`, (t) => {
          const root = copyOfRepoFiles(t);
          editFile(root, VERIFIER_MD, (text) => text.split(STATUS_LINE).join(written));
          const findings = runShipped(root, ['verifier-coincidental-reliance']);
          assert.ok(findings.some((f) => /expected at least one status union line/.test(f.message)), JSON.stringify(findings));
        });
      }
      passes('a union followed by a line of bars still reads the first line', VERIFIER_MD, (text) => text.split(STATUS_LINE).join(`${STATUS_LINE}\n| x y`), 'verifier-coincidental-reliance');

      // The loader seams: a library that cannot be loaded is one problem naming the file, not a throw.
      const FAILING = () => { throw new Error('boom'); };
      test('a throwing loader is one problem naming the registry file', () => {
        assert.deepEqual(mempalace.loadLib(FAILING, 'gsd-core/bin/lib/capability-registry.cjs'), { error: 'gsd-core/bin/lib/capability-registry.cjs cannot be loaded: boom' });
      });
      test('a working loader returns the library', () => assert.deepEqual(mempalace.loadLib(() => 7, 'x'), { lib: 7 }));
      test('a throwing loader is one problem naming the library in the verifier contract', () => {
        assert.deepEqual(verifier.loadLib(FAILING, 'gsd-core/bin/lib/markdown-table.cjs'), { error: 'gsd-core/bin/lib/markdown-table.cjs cannot be loaded: boom' });
      });
      test('a working loader returns the library in the verifier contract', () => assert.deepEqual(verifier.loadLib(() => 'ok', 'x'), { lib: 'ok' }));
      test('a registry that refers back to itself ends the walk without a settings schema', () => {
        const loop = {};
        loop.self = loop;
        loop.nested = { loop };
        assert.deepEqual(mempalace.registryProblems({ capabilities: { mempalace: loop } }).problems, [SCHEMA_PROBLEM]);
      });
      test('a cyclic schema node that holds the settings is found', () => {
        const schema = settings();
        schema.loop = schema;
        assert.deepEqual(mempalace.registryProblems({ capabilities: { mempalace: { group: schema } } }).problems, []);
      });

      // Differential properties: each walker against the pattern or loop it replaced, on random strings. Two kinds of input
      // are drawn: tokens the pattern reads, in any order, and a chain of its parts with random fillers (some parts broken,
      // some in another case, some with a Kelvin sign, a long s or a dotless i in place of a letter), so that both outcomes are
      // reached; every property records the outcomes it saw and fails when the generator reached only one. The walks lower-case
      // with the shared ASCII helper, which is what the i flag did for a pattern of ASCII letters, so the only input left out of
      // the domain is a carriage return before the line feed of the README frontmatter pattern (the engine reads LF text).
      const fc = require('./helpers/fast-check-setup.cjs');
      const U2028 = String.fromCharCode(0x2028);
      const U2029 = String.fromCharCode(0x2029);
      const NBSP = String.fromCharCode(0xa0);
      const KELVIN = String.fromCharCode(0x212a);
      const LONG_S = String.fromCharCode(0x17f);
      const DOTLESS_I = String.fromCharCode(0x131);
      const tokens = (list, max = 8) => fc.array(fc.constantFrom(...list), { maxLength: max }).map((parts) => parts.join(''));
      const SPACES = [' ', '  ', '\t', '\n', '\r', '\r\n', U2028, U2029, NBSP, ''];
      const RUNS = { numRuns: 1000 };
      const crossing = () => {
        const seen = new Set();
        return {
          note: (outcome) => { seen.add(Boolean(outcome)); },
          assertBoth: (label) => assert.deepEqual([...seen].sort(), [false, true], `${label}: the generator reached only ${[...seen].join(', ')}`),
        };
      };
      // A part of a pattern as written, in upper case, or with a letter swapped for one that only a naive case fold matches.
      const respell = (part, variant) => {
        if (variant === 1) return part.toUpperCase();
        if (variant === 2) return part.split('k').join(KELVIN);
        if (variant === 3) return part.split('s').join(LONG_S).split('i').join(DOTLESS_I);
        return part;
      };
      const VARIANTS = fc.constantFrom(0, 0, 0, 0, 0, 1, 2, 3);
      const FILLER = fc.tuple(fc.integer({ min: 0, max: 260 }), fc.constantFrom(...Array(12).fill(''), '\n', '\r', U2028, U2029));
      // The parts in order, each after a filler of 0 to 260 characters (some ending in a line terminator), one part possibly broken.
      const chain = (parts) => fc.tuple(
        fc.array(FILLER, { minLength: parts.length, maxLength: parts.length }),
        fc.option(fc.integer({ min: 0, max: parts.length - 1 }), { nil: -1, freq: 2 }),
        fc.array(VARIANTS, { minLength: parts.length, maxLength: parts.length }),
        tokens(['x', ' ', '\n'], 3),
      ).map(([fillers, broken, variants, tail]) => `${parts.map((part, i) => `${'x'.repeat(fillers[i][0])}${fillers[i][1]}${respell(i === broken ? part.slice(0, -1) : part, variants[i])}`).join('')}${tail}`);
      const BLANKS = [' ', '\n', '\t', '', U2028, NBSP];
      // The items of a walk (literals and the whitespace marker) with a random gap at each marker and one item possibly broken.
      const sequenceOf = (items, marker) => fc.tuple(
        tokens(['x', '\n', ' '], 2),
        fc.array(tokens(BLANKS, 2), { minLength: items.length, maxLength: items.length }),
        fc.option(fc.integer({ min: 0, max: items.length - 1 }), { nil: -1, freq: 2 }),
        tokens(['s', 'x', ' ', '\n', '_', '#'], 2),
      ).map(([prefix, gaps, broken, tail]) => `${prefix}${items.map((item, i) => {
        if (item === marker) return i === broken ? 'q' : gaps[i];
        return i === broken ? 'x' : item;
      }).join('')}${tail}`);

      test('property: frontmatterNameOf reads what the multiline name pattern read', () => {
        const { frontmatterNameOf } = contractModule('agent-skills-bootstrap');
        const oracle = (text) => { const match = /^name:\s*"?([A-Za-z0-9-]{1,64})"?\s*$/m.exec(text); return match === null ? null : match[1]; };
        const seen = crossing();
        const check = (text) => {
          const expected = oracle(text);
          seen.note(expected !== null);
          assert.equal(frontmatterNameOf(text), expected);
        };
        const structured = fc.tuple(tokens(['x', '\n', ' ', 'name: other', U2028]), tokens(SPACES, 3), fc.constantFrom('', '"'),
          fc.constantFrom('gsd-planner', 'a', 'x'.repeat(64), 'x'.repeat(65), 'a b', '', '-', 'é', 'gsd_planner'), fc.constantFrom('', '"'), tokens(SPACES, 3), tokens(['x', '\n', 'name: y', ' '], 3))
          .map(([noise, gap, open, name, close, tail, rest]) => `${noise}name:${gap}${open}${name}${close}${tail}${rest}`);
        fc.assert(fc.property(structured, check), RUNS);
        fc.assert(fc.property(tokens(['name:', 'name: ', '"', 'gsd-planner', 'x', '-', ':', ...SPACES], 12), check), RUNS);
        seen.assertBoth('frontmatterNameOf');
      });

      test('property: statusUnionLines finds what the status union pattern matched', () => {
        const { statusUnionLines } = contractModule('verifier-coincidental-reliance');
        const oracle = (text) => text.match(/^status:\s+[a-z_]+(?:\s*\|\s*[a-z_]+)+\s*$/gm) || [];
        const seen = crossing();
        const check = (text) => {
          const expected = oracle(text);
          seen.note(expected.length > 0);
          assert.deepEqual(statusUnionLines(text), expected);
        };
        const structured = fc.tuple(tokens(['x', '\n', '\r', ' '], 2), fc.constantFrom('status:', 'status: ', 'status:  ', 'status:\n', 'Status: ', 'status'),
          fc.array(fc.constantFrom('passed', 'gaps_found', 'human_needed', 'Passed', 'x_y', ''), { minLength: 1, maxLength: 5 }),
          fc.array(fc.constantFrom(' | ', '|', ' |\n', '\n| ', ' || ', ' '), { minLength: 5, maxLength: 5 }),
          tokens(['', '\n', ' ', '\r', U2028, ' z', '\n| x y', '\nstatus: a | b', ' |'], 2))
          .map(([noise, key, words, separators, tail]) => `${noise}${key}${words.map((word, i) => (i === 0 ? word : `${separators[i]}${word}`)).join('')}${tail}`);
        fc.assert(fc.property(structured, check), RUNS);
        fc.assert(fc.property(tokens(['status: ', 'status:', 'passed', 'gaps_found', 'human_needed', 'x', 'Passed', ' | ', '|', '\n', '\r', U2028, U2029, ':', '-', '_', ' ', '\t'], 14), check), RUNS);
        seen.assertBoth('statusUnionLines');
      });

      test('property: hasUnlessGate reads what the unless patterns read', () => {
        const { hasUnlessGate } = contractModule('mempalace-capture-gate-default');
        const notFalse = /\bunless\s+\(?`[^`]*!==\s*false`/;
        const equalFalse = /\bunless\s+\(?`[^`]*===\s*false`/;
        const seenNot = crossing();
        const seenEqual = crossing();
        const check = (text) => {
          seenNot.note(notFalse.test(text));
          seenEqual.note(equalFalse.test(text));
          assert.equal(hasUnlessGate(text, '!=='), notFalse.test(text));
          assert.equal(hasUnlessGate(text, '==='), equalFalse.test(text));
        };
        const structured = fc.tuple(tokens(['x', ' ', '\n'], 2), fc.constantFrom('unless', 'unless', 'Unless', 'preunless', 'unlessx'), tokens([' ', '\n', ' ', ''], 2),
          fc.constantFrom('', '(', '( '), fc.constantFrom('`', '`', '`', ''), tokens(['k ', 'a b', 'x', '`', '!== '], 2), fc.constantFrom('!==', '===', '!=', '!===', '=='),
          tokens([' ', '', '\n'], 2), fc.constantFrom('false', 'false', 'falsey', 'fals'), fc.constantFrom('`', '`', ''), tokens(['', ' x', '`'], 1))
          .map((parts) => parts.join(''));
        const free = tokens(['unless ', 'unless (', 'unless', ' ', '\n', '`k !== false`', '`k === false`', '`k !== f', 'alse`', '`', '!==', '===', 'false', 'x', 'preunless ', 'Unless '], 10);
        fc.assert(fc.property(structured, check), RUNS);
        fc.assert(fc.property(free, check), RUNS);
        seenNot.assertBoth('hasUnlessGate (!==)');
        seenEqual.assertBoth('hasUnlessGate (===)');
      });

      test('property: connectivesBefore reads what the connective reader read', () => {
        const { connectivesBefore } = contractModule('mempalace-capture-gate-default');
        const oracle = (text, predicate) => {
          const needle = `\`${predicate}\``;
          const found = [];
          for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
            const words = text.slice(Math.max(0, at - 80), at).match(/[A-Za-z]+/g) || [];
            const last = (words[words.length - 1] || '').toLowerCase();
            const prior = (words[words.length - 2] || '').toLowerCase();
            found.push(prior === 'only' && last === 'if' ? 'only if' : last);
          }
          return found;
        };
        const seen = crossing();
        const check = (text) => {
          const expected = oracle(text, 'k !== false');
          seen.note(expected.some((word) => word === 'when' || word === 'only if'));
          assert.deepEqual(connectivesBefore(text, 'k !== false'), expected);
        };
        const structured = fc.tuple(tokens(['x ', '\n', '(', '**'], 4), fc.constantFrom('when', 'only if', 'only  if', 'unless', 'Only If', 'WHEN', 'if', 'when-'),
          fc.integer({ min: 0, max: 90 }), tokens(['', ' more ', '`k !== false`', 'xx'], 2))
          .map(([prefix, connective, dashes, tail]) => `${prefix}${connective}${'-'.repeat(dashes)}\`k !== false\`${tail}`);
        const list = ['`k !== false`', 'when', 'only', 'if', 'unless', ' ', '-', '(', '**', 'xx', '\n', 'x'.repeat(30), 'WHEN', 'Only If'];
        fc.assert(fc.property(structured, check), RUNS);
        fc.assert(fc.property(tokens(list, 14), check), RUNS);
        seen.assertBoth('connectivesBefore');
      });

      test('property: hasWhitespaceGap reads what the whitespace-run patterns read', () => {
        const { hasWhitespaceGap } = contractModule('agent-skills-bootstrap');
        const emptyBlock = /exits 0 with an empty\s+block when nothing is configured for your type/i;
        const nameValue = /the `name:` value in\s+your frontmatter/i;
        const seenEmpty = crossing();
        const seenName = crossing();
        const check = (text) => {
          seenEmpty.note(emptyBlock.test(text));
          seenName.note(nameValue.test(text));
          assert.equal(hasWhitespaceGap(text, 'exits 0 with an empty', 'block when nothing is configured for your type'), emptyBlock.test(text));
          assert.equal(hasWhitespaceGap(text, 'the `name:` value in', 'your frontmatter'), nameValue.test(text));
        };
        const gapped = (before, after) => fc.tuple(tokens(['x', ' ', '\n'], 3), tokens(SPACES, 3), VARIANTS, VARIANTS, fc.boolean())
          .map(([prefix, gap, beforeVariant, afterVariant, broken]) => `${prefix}${respell(before, beforeVariant)}${gap}${respell(broken ? after.slice(0, -1) : after, afterVariant)}`);
        const list = ['exits 0 with an empty', 'block when nothing is configured for your type', 'EXITS 0 WITH AN EMPTY', 'Block When Nothing Is Configured For Your Type', 'the `name:` value in', 'your frontmatter', 'YOUR FRONTMATTER', 'x', ...SPACES];
        fc.assert(fc.property(gapped('exits 0 with an empty', 'block when nothing is configured for your type'), check), RUNS);
        fc.assert(fc.property(gapped('the `name:` value in', 'your frontmatter'), check), RUNS);
        fc.assert(fc.property(tokens(list, 8), check), RUNS);
        seenEmpty.assertBoth('hasWhitespaceGap (empty block)');
        seenName.assertBoth('hasWhitespaceGap (name value)');
      });

      test('property: hasPatternWalk reads what the spike patterns read', () => {
        const { hasPatternWalk, WS, SPIKES_TABLE_HEADER } = contractModule('spike-manifest-scoping');
        const cases = [
          ['## Ideas', ['##', WS, 'Ideas'], true, (text) => /##\s*Ideas\b/.test(text)],
          ['### {idea-key}', ['###', WS, '{idea-key}'], false, (text) => /###\s*\{idea-key\}/.test(text)],
          // The README frontmatter pattern also took a carriage return before the line feed; the engine reads LF text.
          ['spike and idea fields', ['spike:', WS, 'NNN', '\nidea:', WS, '{idea-key}'], false, (text) => /spike:\s*NNN\r?\nidea:\s*\{idea-key\}/.test(text)],
          ['the Spikes table header', SPIKES_TABLE_HEADER, false, (text) => /\|\s*#\s*\|\s*Idea\s*\|\s*Name\s*\|\s*Type\s*\|\s*Validates\s*\|\s*Verdict\s*\|\s*Tags\s*\|/.test(text)],
        ];
        for (const [label, items, wordEnd, oracle] of cases) {
          const seen = crossing();
          fc.assert(fc.property(sequenceOf(items, WS), (text) => {
            const expected = oracle(text);
            seen.note(expected);
            assert.equal(hasPatternWalk(text, items, wordEnd), expected);
          }), RUNS);
          seen.assertBoth(`hasPatternWalk (${label})`);
        }
        const free = tokens(['##', '#', 'Ideas', 'Idea', 's', 'x', ...BLANKS], 8);
        fc.assert(fc.property(free, (text) => assert.equal(hasPatternWalk(text, ['##', WS, 'Ideas'], true), /##\s*Ideas\b/.test(text))), RUNS);
      });

      test('property: lineHasInOrder and stepNames read what the seed patterns and the step extraction read', () => {
        const { lineHasInOrder, stepNames } = contractModule('seed-scan-new-milestone');
        const seenSkip = crossing();
        const seenAuto = crossing();
        const check = (text) => {
          seenSkip.note(/no seed files exist.*skip/i.test(text));
          seenAuto.note(/auto.*select.*all.*matching.*seed/i.test(text));
          assert.equal(lineHasInOrder(text, ['no seed files exist', 'skip']), /no seed files exist.*skip/i.test(text));
          assert.equal(lineHasInOrder(text, ['auto', 'select', 'all', 'matching', 'seed']), /auto.*select.*all.*matching.*seed/i.test(text));
        };
        fc.assert(fc.property(chain(['no seed files exist', 'skip']), check), RUNS);
        fc.assert(fc.property(chain(['auto', 'select', 'all', 'matching', 'seed']), check), RUNS);
        fc.assert(fc.property(tokens(['no seed files exist', 'skip', 'SKIP', 'auto', 'Auto', 'select', 'all', 'matching', 'seed', 'x', ' ', '\n', '\r', U2028, U2029], 12), check), RUNS);
        seenSkip.assertBoth('lineHasInOrder (skip)');
        seenAuto.assertBoth('lineHasInOrder (auto-select)');
        const oldStepNames = (source) => {
          const names = [];
          const pattern = /<step name="([^"]+)"/g;
          let match;
          while ((match = pattern.exec(source)) !== null) names.push(match[1]);
          return names;
        };
        const seenSteps = crossing();
        fc.assert(fc.property(tokens(['<step name="', '"', 'a', 'write-seed', '<', '>', ' ', '\n', 'name=', 'b'], 10), (text) => {
          seenSteps.note(oldStepNames(text).length > 0);
          assert.deepEqual(stepNames(text), oldStepNames(text));
        }), RUNS);
        seenSteps.assertBoth('stepNames');
      });

      test('a Kelvin sign, a long s and a dotless i are not letters to the walks that fold case, as they were not to the patterns', () => {
        const { lineHasInOrder } = contractModule('seed-scan-new-milestone');
        const { hasWhitespaceGap } = contractModule('agent-skills-bootstrap');
        const skipLines = [`no seed files exist s${KELVIN}ip`, `no seed files exist ${LONG_S}kip`, `no seed file${LONG_S} exist skip`, `no seed f${DOTLESS_I}les exist skip`];
        for (const line of skipLines) {
          assert.equal(/no seed files exist.*skip/i.test(line), false, line);
          assert.equal(lineHasInOrder(line, ['no seed files exist', 'skip']), false, line);
        }
        const blockLine = `exits 0 with an empty bloc${KELVIN} when nothing is configured for your type`;
        assert.equal(/exits 0 with an empty\s+block when nothing is configured for your type/i.test(blockLine), false);
        assert.equal(hasWhitespaceGap(blockLine, 'exits 0 with an empty', 'block when nothing is configured for your type'), false);
        const nameLine = `the \`name:\` value ${DOTLESS_I}n your frontmatter`;
        assert.equal(/the `name:` value in\s+your frontmatter/i.test(nameLine), false);
        assert.equal(hasWhitespaceGap(nameLine, 'the `name:` value in', 'your frontmatter'), false);
      });

      // The old test's bijection property and its compact-sibling rule, over rosters the contract is fed: stripping the pointer
      // from consumers and from carrying compact siblings, and adding it to other canonical agents and to compact siblings
      // (with the right type or a wrong one), is a finding for exactly the files the rules name: a consumer without it, a
      // canonical non-consumer with it, a compact sibling with a wrong type, and the floor when fewer than 36 files carry it.
      test('property: the bootstrap pointer follows the roster rules of the old test, compact siblings included', (t) => {
        const root = copyOfRepoFiles(t);
        const POINTER = 'agent-skills-bootstrap.md';
        const agentsDir = path.join(root, 'agents');
        const names = fs.readdirSync(agentsDir).filter((name) => name.endsWith('.md'));
        const original = new Map(names.map((name) => [name, fs.readFileSync(path.join(agentsDir, name), 'utf8')]));
        const carries = (name) => original.get(name).includes(POINTER);
        const canonical = names.filter((name) => !name.endsWith('.compact.md'));
        const compact = names.filter((name) => name.endsWith('.compact.md'));
        const consumers = canonical.filter(carries);
        const others = canonical.filter((name) => !carries(name));
        const carryingCompact = compact.filter(carries);
        const bareCompact = compact.filter((name) => !carries(name));
        assert.equal(consumers.length, 22);
        assert.equal(carryingCompact.length, 16);
        assert.ok(bareCompact.length > 0);
        const typeOf = (name) => name.replace(/\.compact\.md$/, '').replace(/\.md$/, '');
        const pointerLine = (type) => `**agent_skills:** self-load per @~/.claude/gsd-core/references/${POINTER} (agent type: \`${type}\`)`;
        const write = (name, text) => fs.writeFileSync(path.join(agentsDir, name), text);
        fc.assert(fc.property(fc.subarray(consumers), fc.subarray(others), fc.subarray(carryingCompact), fc.subarray(bareCompact), fc.subarray(bareCompact), (strip, add, stripCompact, addRight, addWrong) => {
          const wrong = new Set(addWrong);
          const right = addRight.filter((name) => !wrong.has(name));
          const touched = [...strip, ...add, ...stripCompact, ...right, ...addWrong];
          try {
            for (const name of [...strip, ...stripCompact]) write(name, original.get(name).split(POINTER).join('x-bootstrap.md'));
            for (const name of add) write(name, `${original.get(name)}\nSee ${POINTER}.\n`);
            for (const name of right) write(name, `${original.get(name)}\n${pointerLine(typeOf(name))}\n`);
            for (const name of addWrong) write(name, `${original.get(name)}\n${pointerLine('gsd-other')}\n`);
            const messages = runShipped(root, ['agent-skills-bootstrap']).map((f) => f.message);
            const expected = [
              ...strip.map((name) => `${typeOf(name)} must @-include`),
              ...add.map((name) => `agents/${name} carries the bootstrap pointer but is not a consumer agent`),
              ...addWrong.map((name) => `agents/${name} pointer must state "(agent type: \`${typeOf(name)}\`)"`),
            ];
            const carrying = consumers.length + carryingCompact.length - strip.length - stripCompact.length + add.length + right.length + addWrong.length;
            if (carrying < 36) expected.push(`only ${carrying} agent files carry the bootstrap pointer`);
            assert.equal(messages.length, expected.length, JSON.stringify(messages));
            for (const piece of expected) assert.ok(messages.some((message) => message.includes(piece)), `${piece} not reported: ${JSON.stringify(messages)}`);
          } finally {
            for (const name of touched) write(name, original.get(name));
          }
        }), { numRuns: 30 });
      });

      // verifier-coincidental-reliance: the bound of the clause that forbids a human-verification item (the other clauses of the
      // rule come from a filler placed before the first mention, so this clause is the only variable).
      gapCases('"never" to "human-verification item"', 'agents/gsd-verifier.md', 'verifier-coincidental-reliance',
        (text, gap) => `✓ VERIFIED truth PRESENT_BEHAVIOR_UNVERIFIED insufficient_spec override do not flag enforce default honest-verifier confidence score not the score not the status coincidental-reliance never${'x'.repeat(gap)}human-verification item\n${text.replace(/never[^.]{0,80}human-verification item/gi, 'x')}`,
        80, /the advisory must never emit a human-verification item/);

      // mempalace-capture-gate-default: with no settings schema the positive-presence check still runs over the three keys the test named.
      test('a registry with no settings schema still reports the three default-true keys the test named', () => {
        for (const registry of [undefined, null, {}, { capabilities: null }, { capabilities: {} }, { capabilities: { mempalace: null } }, { capabilities: { mempalace: { other: 1 } } }]) {
          assert.deepEqual([...mempalace.registryProblems(registry).defaultTrue].sort(), ['mempalace.capture_artifacts', 'mempalace.diary_journal', 'mempalace.mirror_kg']);
        }
      });

      // execute-phase-step-5-5-deviation-doc: the markers in the wrong order are one finding.
      test('the gaps_found marker before the human_needed marker is exactly one finding', (t) => {
        const root = copyOfRepoFiles(t, HEAVY);
        editFile(root, EXECUTE_PHASE_MD, (text) => `**If gaps_found:**\n${text}`);
        const own = runShipped(root, ['execute-phase-step-5-5-deviation-doc']).filter((f) => f.file === EXECUTE_PHASE_MD);
        assert.equal(own.length, 1, JSON.stringify(own));
        assert.match(own[0].message, /the human_needed section must appear before the gaps_found section/);
      });

      // mempalace-capture-gate-default through the contract's own check with a registry that has no schema or cannot be loaded:
      // the registry is one finding and the positive-presence checks still run over the three keys the test named.
      const runWithRegistry = (t, loaderSource, edits) => {
        const root = copyOfRepoFiles(t);
        for (const [rel, edit] of edits) editFile(root, rel, edit);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-text-contracts-wrap-'));
        t.after(() => cleanup(dir));
        const real = path.join(REPO_ROOT, 'scripts', 'static-checks', 'text-contracts', 'mempalace-capture-gate-default.cjs');
        fs.writeFileSync(path.join(dir, 'wrapper.cjs'), `'use strict';\nconst real = require(${JSON.stringify(real)});\nmodule.exports = { id: real.id, check: (ctx) => real.check(ctx, ${loaderSource}) };\n`);
        return textContracts.run({ root, dir, minContracts: 1, only: ['mempalace-capture-gate-default'] }).map((f) => f.message);
      };
      const SCHEMA_LESS = '() => ({ capabilities: { mempalace: { other: 1 } } })';
      const THROWING = "() => { throw new Error('boom'); }";
      const CAPTURE_SKILL_FILE = 'skills/gsd-mempalace-capture/SKILL.md';
      test('a registry with no mempalace schema is one finding over the untouched files', (t) => {
        const messages = runWithRegistry(t, SCHEMA_LESS, []);
        assert.equal(messages.length, 1, JSON.stringify(messages));
        assert.match(messages[0], /the capability registry must expose a mempalace settings schema/);
      });
      test('a registry with no mempalace schema still runs the positive-presence check over the three named keys', (t) => {
        const messages = runWithRegistry(t, SCHEMA_LESS, [[CAPTURE_SKILL_FILE, (text) => `${text}\nRun when \`config.mempalace.diary_journal\` is true.\n`]]);
        assert.equal(messages.length, 2, JSON.stringify(messages));
        assert.ok(messages.some((m) => /the capability registry must expose a mempalace settings schema/.test(m)), JSON.stringify(messages));
        assert.ok(messages.some((m) => /gates `mempalace\.diary_journal` on positive presence, but the registry declares default: true/.test(m)), JSON.stringify(messages));
      });
      test('a registry with no mempalace schema checks only the three named keys', (t) => {
        const messages = runWithRegistry(t, SCHEMA_LESS, [[CAPTURE_SKILL_FILE, (text) => `${text}\nRun when \`config.mempalace.recall_on_plan\` is true.\n`]]);
        assert.equal(messages.length, 1, JSON.stringify(messages));
      });
      test('a registry that cannot be loaded is one finding and the positive-presence check still runs', (t) => {
        const messages = runWithRegistry(t, THROWING, [[CAPTURE_SKILL_FILE, (text) => `${text}\nRun when \`config.mempalace.diary_journal\` is true.\n`]]);
        assert.equal(messages.length, 2, JSON.stringify(messages));
        assert.ok(messages.some((m) => /gsd-core\/bin\/lib\/capability-registry\.cjs cannot be loaded: boom/.test(m)), JSON.stringify(messages));
        assert.ok(messages.some((m) => /gates `mempalace\.diary_journal` on positive presence/.test(m)), JSON.stringify(messages));
      });
      // seed-scan-new-milestone: every misplaced question is named by the one finding.
      test('two questions before the write-seed step are named by one finding', (t) => {
        const root = copyOfRepoFiles(t);
        editFile(root, 'gsd-core/workflows/plant-seed.md', (text) => text.split('<step name="parse-idea">').join('header: "Trigger"\nheader: "Why"\n<step name="parse-idea">'));
        const own = runShipped(root, ['seed-scan-new-milestone']).filter((f) => f.file === 'gsd-core/workflows/plant-seed.md');
        assert.equal(own.length, 1, JSON.stringify(own));
        assert.match(own[0].message, /must precede the Trigger question[^]*must precede the Why question/);
        assert.doesNotMatch(own[0].message, /must precede the Scope question/);
      });
      test('all three questions before the write-seed step are named by one finding', (t) => {
        const root = copyOfRepoFiles(t);
        editFile(root, 'gsd-core/workflows/plant-seed.md', (text) => text.split('<step name="parse-idea">').join('header: "Scope"\nheader: "Why"\nheader: "Trigger"\n<step name="parse-idea">'));
        const own = runShipped(root, ['seed-scan-new-milestone']).filter((f) => f.file === 'gsd-core/workflows/plant-seed.md');
        assert.equal(own.length, 1, JSON.stringify(own));
        assert.match(own[0].message, /Trigger question[^]*Why question[^]*Scope question/);
      });
    }
  }

  {
    // ---- group 3 controls and boundaries
    // Edits several files of one root at once (a contract that reads the union of several files fails only when every copy is gone).
    const editFiles3 = (title, edits, contract, expected) => test(title, (t) => {
      const root = copyOfRepoFiles(t);
      for (const [rel, edit] of edits) {
        const abs = path.join(root, ...rel.split('/'));
        const before = fs.readFileSync(abs, 'utf8');
        const after = edit(before);
        assert.notEqual(after, before, `the edit changed ${rel}`);
        fs.writeFileSync(abs, after);
      }
      const findings = runShipped(root, [contract]);
      if (expected === null) assert.deepEqual(findings, []);
      else assert.ok(findings.some((f) => expected.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
    });
    // ultraplan-phase: each alternative the old test accepted still satisfies alone, the name field bound, a removed file.
    passes('only CLAUDECODE is enough for the runtime gate', 'gsd-core/workflows/ultraplan-phase.md', swap('CLAUDE_CODE_ENTRYPOINT', 'OTHER'), 'ultraplan-phase');
    passes('only CLAUDE_CODE_ENTRYPOINT is enough for the runtime gate', 'gsd-core/workflows/ultraplan-phase.md', swap('CLAUDECODE', 'OTHER'), 'ultraplan-phase');
    passes('the hyphenated plan-phase form is enough for the local alternative', 'gsd-core/workflows/ultraplan-phase.md', swap('gsd:plan-phase', 'gsd-plan-phase'), 'ultraplan-phase');
    passes('the hyphenated new-project form is enough', 'gsd-core/workflows/ultraplan-phase.md', swap('gsd:new-project', 'gsd-new-project'), 'ultraplan-phase');
    passes('the hyphenated import form is enough, and still before the trigger', 'gsd-core/workflows/ultraplan-phase.md', swap('gsd:import', 'gsd-import'), 'ultraplan-phase');

    // verify-mvp-uat: MVP_MODE lives in two files, the bounds of the two 80-character patterns, the steps directory.
    editFiles3('MVP_MODE gone from the host and the framing step', [
      ['gsd-core/workflows/verify-work.md', eraseAll('MVP_MODE')],
      ['gsd-core/workflows/verify-work/steps/mvp-uat-framing.md', eraseAll('MVP_MODE')],
    ], 'verify-mvp-uat', /the workflow must declare MVP_MODE/);
    passes('MVP_MODE only in the framing step is enough', 'gsd-core/workflows/verify-work.md', eraseAll('MVP_MODE'), 'verify-mvp-uat');
    // The framing step with only the line that carries the verify-mvp-mode.md reference and one probe body.
    const framingBody3 = (text, body) => `${text.split('\n')[0]}\n\n${body}\n`;
    gapCases('characters between user-flow and the ordering word', 'gsd-core/workflows/verify-work/steps/mvp-uat-framing.md', 'verify-mvp-uat',
      (text, gap) => framingBody3(text, `user-flow${'x'.repeat(gap)}first\ntechnical checks defer`), 80, /the workflow must specify user-flow-first ordering/);
    gapCases('characters between technical checks and the deferral word', 'gsd-core/workflows/verify-work/steps/mvp-uat-framing.md', 'verify-mvp-uat',
      (text, gap) => framingBody3(text, `user-flow first\ntechnical checks${'x'.repeat(gap)}defer`), 80, /the workflow must defer technical checks under MVP mode/);
    for (const word of ['first', 'before', 'precede']) {
      passes(`${word} alone satisfies the user-flow ordering`, 'gsd-core/workflows/verify-work/steps/mvp-uat-framing.md', (text) => framingBody3(text, `user-flow ${word}\ntechnical checks defer`), 'verify-mvp-uat');
    }
    for (const word of ['after', 'defer', 'second']) {
      passes(`${word} alone satisfies the technical-checks deferral`, 'gsd-core/workflows/verify-work/steps/mvp-uat-framing.md', (text) => framingBody3(text, `user-flow first\ntechnical checks ${word}`), 'verify-mvp-uat');
    }
    test('the verify-work steps directory removed from the tree is a finding', (t) => {
      const root = copyOfRepoFiles(t);
      cleanup(path.join(root, 'gsd-core', 'workflows', 'verify-work', 'steps'));
      const findings = runShipped(root, ['verify-mvp-uat']);
      assert.ok(findings.some((f) => /cannot read the directory/.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
    });
    test('the verify-work steps directory holding no .md file is a finding', (t) => {
      const root = copyOfRepoFiles(t);
      const abs = path.join(root, 'gsd-core', 'workflows', 'verify-work', 'steps');
      for (const name of fs.readdirSync(abs)) fs.unlinkSync(path.join(abs, name));
      fs.writeFileSync(path.join(abs, 'notes.txt'), 'no step here\n');
      const findings = runShipped(root, ['verify-mvp-uat']);
      assert.ok(findings.some((f) => f.message.includes('no .md file under')), JSON.stringify(findings.map((f) => f.message)));
    });

    // workflow-jq-dependency: shapes the old patterns did not match stay unmatched.
    for (const [title, line] of [
      ['the keyword and the pipe on different lines', 'config-get workflow.x\nsomething | jq .x'],
      ['a longer word after the keyword', 'config-getx workflow.x | jq .x'],
      ['a double pipe before jq', 'config-get workflow.x || jq .x'],
      ['a longer word after jq', 'config-get workflow.x | jqx .x'],
      ['a pipe to something else', 'config-get workflow.x | grep jq'],
      ['a longer word after update-context', 'update-contextual | jq .x'],
      ['a verification.status prefix word', 'verification.statuses | jq .x'],
      ['gsd_run query with a family outside the list', 'gsd_run query state-load | jq .x'],
    ]) {
      passes(`${title} is not a jq pipe`, 'gsd-core/workflows/review.md', append(line), 'workflow-jq-dependency');
    }
    passes('a citation of review.md without a line number', 'gsd-core/workflows/plan-phase.md', append('See review.md:x for the prerequisite.'), 'workflow-jq-dependency');
    passes('extra blanks between the call and the field of update.md', 'gsd-core/workflows/update.md', swap('uc_field scope', 'uc_field \t scope'), 'workflow-jq-dependency');
    test('the workflows directory removed from the tree is a finding', (t) => {
      const root = copyOfRepoFiles(t);
      cleanup(path.join(root, 'gsd-core', 'workflows'));
      const findings = runShipped(root, ['workflow-jq-dependency']);
      assert.ok(findings.some((f) => /cannot read the directory/.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
    });

    // verification-overrides: shapes the old patterns did not match stay unmatched.
    passes('criterion: at column 0 is not an indented field', 'gsd-core/references/verification-overrides.md', append('criterion: x'), 'verification-overrides');
    passes('criterion: in the middle of a line is not a field', 'gsd-core/references/verification-overrides.md', append('the criterion: x applies'), 'verification-overrides');
    passes('a backticked required_reading mention does not stop the real tag counting', 'agents/gsd-verifier.md', append('Read the `<required_reading>` block.'), 'verification-overrides');
    passes('a 60% threshold in other words is allowed', 'gsd-core/references/verification-overrides.md', append('A 60% weighting is unrelated.'), 'verification-overrides');

    // mempalace-capture-headless-invocation: shapes the old patterns did not match stay unmatched; the room count bound.
    for (const rel of ['skills/gsd-mempalace-capture/SKILL.md', 'commands/gsd/mempalace-capture.md']) {
      passes(`prose that mentions mine with --room is not a command line in ${rel}`, rel, append('Run `mempalace mine x --room y` only in a test.'), 'mempalace-capture-headless-invocation');
      passes(`a longer word after mine is not a mine command in ${rel}`, rel, append('mempalace minefield --room x'), 'mempalace-capture-headless-invocation');
      passes(`a sixth room is allowed in ${rel}`, rel, swap('     - name: general\n', '     - name: general\n     - name: sixth\n'), 'mempalace-capture-headless-invocation');
      passes(`extra keys on a room entry are allowed in ${rel}`, rel, swap('- name: general', '- name: general\n       description: anything'), 'mempalace-capture-headless-invocation');
      passes(`a hyphenated word list item outside the rooms block is not a bare entry in ${rel}`, rel, append('- note-taking'), 'mempalace-capture-headless-invocation');
      passes(`the YAML sentinel with surrounding blanks still ends the block in ${rel}`, rel, swap('   YAML\n', '   \tYAML  \n'), 'mempalace-capture-headless-invocation');
    }

    // no-hardcoded-home-gsd-tools: shapes the old patterns did not match stay unmatched; the per-directory bash-block floor.
    for (const [title, text, rel] of [
      ['the preamble marker _GSD_SHIM_NAME on the line', '```bash\nnode ~/x/gsd-tools.cjs # _GSD_SHIM_NAME\n```', 'agents/gsd-verifier.md'],
      ['the preamble marker GSD_TOOLS= on the line', '```bash\nGSD_TOOLS="x"; node ~/x/gsd-tools.cjs\n```', 'agents/gsd-verifier.md'],
      ['the preamble marker [ -f on the line', '```bash\n[ -f ~/x/gsd-tools.cjs ] && node ~/x/gsd-tools.cjs\n```', 'agents/gsd-verifier.md'],
      ['the same call in prose outside a fence', 'node ~/x/gsd-tools.cjs state', 'agents/gsd-verifier.md'],
      ['the same call in a text block', '```text\nnode ~/x/gsd-tools.cjs state\n```', 'agents/gsd-verifier.md'],
      ['the same call in a tilde block', '~~~bash\nnode ~/x/gsd-tools.cjs state\n~~~', 'agents/gsd-verifier.md'],
      ['the same call in a longer fence', '````bash\nnode ~/x/gsd-tools.cjs state\n````', 'agents/gsd-verifier.md'],
      ['the same call in a block tagged bashx', '```bashx\nnode ~/x/gsd-tools.cjs state\n```', 'agents/gsd-verifier.md'],
      ['a node call that does not name gsd-tools.cjs', '```bash\nnode ~/x/other.cjs state\n```', 'agents/gsd-verifier.md'],
      ['a node call through gsd_run', '```bash\ngsd_run query state\n```', 'agents/gsd-verifier.md'],
      ['node as part of a longer path with no space', '```bash\nnodemodules ~/x/gsd-tools.cjs\n```', 'agents/gsd-verifier.md'],
      ['an empty unterminated bash block', '```bash', 'agents/gsd-verifier.md'],
    ]) {
      passes(`${title} is not a hardcoded call`, rel, append(text), 'no-hardcoded-home-gsd-tools');
    }
    for (const [title, line] of [
      ['an unquoted HOME call', 'node $HOME/x/gsd-tools.cjs state'],
      ['a braced HOME call', 'node "${HOME}/x/gsd-tools.cjs" state'],
      ['a quoted path to another script', 'node "$HOME/x/other.cjs" state'],
      ['a quote between HOME and gsd-tools.cjs', 'node "$HOME/a" "gsd-tools.cjs"'],
      ['a call with no blank after node', 'node"$HOME/x/gsd-tools.cjs"'],
    ]) {
      passes(`${title} is not the quoted workflow form`, 'gsd-core/workflows/ship.md', append(line), 'no-hardcoded-home-gsd-tools');
    }
    for (const [title, line] of [
      ['a path-final template', 'TMP=$(mktemp /tmp/gsd-XXXXXX)'],
      ['a quoted path-final template', 'TMP="$(mktemp "/tmp/gsd-XXXXXX")"'],
      ['a bare mktemp', 'TMP=$(mktemp)'],
      ['prose that mentions a run of X in a later token', 'mktemp only randomizes XXXXXX.json files'],
      ['a run of two X before a suffix', 'mktemp /tmp/gsd-XX.json'],
      ['an option before the template', 'mktemp -d /tmp/gsd-XXXXXX.d'],
      ['a longer path-final run in a command substitution', 'D=$(mktemp -d "${TMPDIR:-/tmp}/gsd-XXXXXXXX")'],
    ]) {
      passes(`${title} is not a suffixed mktemp template`, 'gsd-core/workflows/ship.md', append(line), 'no-hardcoded-home-gsd-tools');
    }
    // A directory whose bash blocks are all gone has none left to scan: one finding per directory.
    const walkMd3 = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walkMd3(path.join(dir, entry.name)) : (entry.name.endsWith('.md') ? [path.join(dir, entry.name)] : [])));
    for (const dir of ['agents', 'commands', 'gsd-core/references']) {
      test(`${dir} with no bash block left is a finding`, (t) => {
        const root = copyOfRepoFiles(t);
        for (const file of walkMd3(path.join(root, ...dir.split('/')))) {
          fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('```bash').join('```text').split('```sh').join('```text'));
        }
        const findings = runShipped(root, ['no-hardcoded-home-gsd-tools']);
        assert.ok(findings.some((f) => f.file === dir && /contains 0 bash blocks/.test(f.message)), JSON.stringify(findings.map((f) => [f.file, f.message])));
      });
      test(`${dir} removed from the tree is a finding`, (t) => {
        const root = copyOfRepoFiles(t);
        cleanup(path.join(root, ...dir.split('/')));
        const findings = runShipped(root, ['no-hardcoded-home-gsd-tools']);
        assert.ok(findings.some((f) => f.file === dir), JSON.stringify(findings.map((f) => [f.file, f.message])));
      });
    }

    // thinking-model-guidance: per-model headings and Counters lines, the option order, the boundaries and the agent wiring.
    const findsSome3 = (title, rel, edit, contract, expected) => test(title, (t) => {
      const root = copyOfRepoFiles(t);
      const abs = path.join(root, ...rel.split('/'));
      const before = fs.readFileSync(abs, 'utf8');
      const after = edit(before);
      assert.notEqual(after, before, 'the edit changed the file');
      fs.writeFileSync(abs, after);
      const findings = runShipped(root, [contract]);
      assert.ok(findings.some((f) => f.message.includes(expected)), `expected "${expected}" in ${JSON.stringify(findings.map((f) => f.message))}`);
    });
    const NAMED_MODELS3 = {
      debug: ['Fault Tree Analysis', 'Hypothesis-Driven Investigation', "Occam's Razor", 'Counterfactual Thinking'],
      execution: ['Circle of Concern vs Circle of Control', 'Forcing Function', 'First Principles Thinking', "Occam's Razor", "Chesterton's Fence"],
      planning: ['Pre-Mortem Analysis', 'MECE Decomposition', 'Constraint Analysis', 'Reversibility Test', "Occam's Razor"],
      research: ['First Principles Thinking', "Simpson's Paradox Awareness", 'Survivorship Bias', 'Confirmation Bias Counter', 'Steel Man'],
      verification: ['Inversion', "Chesterton's Fence", 'Confirmation Bias Counter', 'Planning Fallacy Calibration', 'Counterfactual Thinking'],
    };
    // The heading line of a model renamed, or the Counters line of its section dropped.
    const renameHeading3 = (model) => (text) => text.split('\n').map((line) => (line.startsWith('## ') && line.includes(model) ? '## x' : line)).join('\n');
    const dropCounters3 = (model) => (text) => {
      const lines = text.split('\n');
      const start = lines.findIndex((line) => line.startsWith('## ') && line.includes(model));
      const end = lines.findIndex((line, at) => at > start && line.startsWith('## '));
      return lines.map((line, at) => (at > start && (end === -1 || at < end) ? line.split('**Counters:**').join('Counters') : line)).join('\n');
    };
    for (const [context, models] of Object.entries(NAMED_MODELS3)) {
      for (const model of models) {
        const rel = `gsd-core/references/thinking-models-${context}.md`;
        findsOne(`the heading of ${model} gone from thinking-models-${context}.md`, rel, renameHeading3(model), 'thinking-model-guidance', `must name the model "${model}" in a heading with a **Counters:** line (the failure mode it counters) (no heading names it)`);
        findsOne(`the Counters line of ${model} gone from thinking-models-${context}.md`, rel, dropCounters3(model), 'thinking-model-guidance', `must name the model "${model}" in a heading with a **Counters:** line (the failure mode it counters) (its section has no **Counters:** line)`);
      }
    }
    passes('a named model mentioned only in prose is not a heading but the heading stays', 'gsd-core/references/thinking-models-debug.md', append('Fault Tree Analysis is discussed again here.'), 'thinking-model-guidance');
    const PLANNING3 = 'gsd-core/references/thinking-models-planning.md';
    for (const option of ['Existing project behavior, helper, or established pattern', 'Standard-library capability', 'Native platform capability', 'Already-installed dependency', 'Minimum new implementation']) {
      findsOne(`the option "${option}" gone from the planning Occam check`, PLANNING3, eraseAll(option), 'thinking-model-guidance', `missing option: ${option}`);
    }
    findsOne('two options of the planning Occam check swapped', PLANNING3,
      swap('2. Standard-library capability\n3. Native platform capability', '2. Native platform capability\n3. Standard-library capability'), 'thinking-model-guidance', 'option out of order: Native platform capability');
    findsOne('the first option moved after the second', PLANNING3,
      swap('1. Existing project behavior, helper, or established pattern\n2. Standard-library capability', '1. Standard-library capability\n2. Existing project behavior, helper, or established pattern'), 'thinking-model-guidance', 'option out of order: Standard-library capability');
    for (const reference of ['dont_hand_roll', 'Dimension 12 (Pattern Compliance)', 'thinking-models-execution.md']) {
      findsOne(`the cross-reference ${reference} gone from the planning Occam check`, PLANNING3, eraseAll(reference), 'thinking-model-guidance', `the planning Occam check must cross-reference ${reference}`);
    }
    for (const boundary of ['locked user decisions', 'requirement coverage', 'security', 'validation', 'accessibility', 'error handling', 'verification']) {
      findsOne(`${boundary} gone from the sentence that bounds the planning Occam check`, PLANNING3,
        (text) => text.split('\n').map((line) => (line.includes('must never reduce requested scope') ? line.split(boundary).join('x') : line)).join('\n'),
        'thinking-model-guidance', `that sentence does not name ${boundary}`);
    }
    passes('a boundary word elsewhere in the file does not stand in for the sentence', PLANNING3, append('security validation accessibility error handling verification'), 'thinking-model-guidance');
    const AGENT_WIRING3 = {
      'gsd-debugger': ['thinking-models-debug.md', 'step name="investigation_loop"', 'At investigation decision points, apply structured reasoning'],
      'gsd-executor': ['thinking-models-execution.md', 'step name="execute_tasks"', 'At execution decision points, apply structured reasoning'],
      'gsd-planner': ['thinking-models-planning.md', 'step name="break_into_tasks"', 'At decision points during plan creation, apply structured reasoning'],
      'gsd-phase-researcher': ['thinking-models-research.md', 'execution_flow', 'At research decision points, apply structured reasoning'],
      'gsd-plan-checker': ['thinking-models-planning.md', 'verification_dimensions', 'At decision points during plan verification, apply structured reasoning'],
      'gsd-verifier': ['thinking-models-verification.md', 'verification_process', 'At verification decision points, apply structured reasoning'],
    };
    for (const [agent, [ref, block, annotation]] of Object.entries(AGENT_WIRING3)) {
      const rel = `agents/${agent}.md`;
      findsSome3(`${ref} gone from ${agent}.md`, rel, eraseAll(ref), 'thinking-model-guidance', `${agent}.md must reference ${ref}`);
      findsSome3(`the block ${block} gone from ${agent}.md`, rel, eraseAll(block), 'thinking-model-guidance', `${agent}.md must contain the block ${block}`);
      findsSome3(`the annotation gone from ${agent}.md`, rel, eraseAll(annotation), 'thinking-model-guidance', `${agent}.md must carry the decision-point annotation`);
      findsSome3(`the annotation placed before the block in ${agent}.md`, rel, (text) => `${annotation}\n${text}`, 'thinking-model-guidance', `${agent}.md must place the decision-point annotation after the block ${block}`);
      findsSome3(`${ref} added to a required_reading block of ${agent}.md`, rel, append(`<required_reading>\n@~/.claude/gsd-core/references/${ref}\n</required_reading>`), 'thinking-model-guidance', `${agent}.md must not put ${ref} inside a <required_reading> block`);
      passes(`an unclosed required_reading block holding ${ref} is not a required_reading block of ${agent}.md`, rel, append(`<required_reading>\n@~/.claude/gsd-core/references/${ref}`), 'thinking-model-guidance');
      passes(`a closed required_reading block without ${ref} is allowed in ${agent}.md`, rel, append('<required_reading>\n@~/.claude/gsd-core/references/other.md\n</required_reading>'), 'thinking-model-guidance');
    }

    // ---- review round 1: bash block rule, bound of the X run, one finding per cause, branches and depth filters.
    // A column-0 bash or sh fence line opens a block even after an unclosed fence of another language or inside a longer fence.
    findsOne('a bash block after an unclosed js fence is still read', 'agents/gsd-verifier.md', append('```js\nlet x;\n```bash\nnode ~/x/gsd-tools.cjs state\n```'), 'no-hardcoded-home-gsd-tools', 'a bash block must not hardcode a $HOME gsd-tools.cjs call');
    findsOne('a bash fence inside a longer markdown example is still read', 'agents/gsd-verifier.md', append('````markdown\n```bash\nnode ~/x/gsd-tools.cjs state\n```\n````'), 'no-hardcoded-home-gsd-tools', 'a bash block must not hardcode a $HOME gsd-tools.cjs call');
    // The bound of the X run: two X are not a run, three and four are.
    passes('a run of two X before a suffix is not a template run (limit - 1)', 'gsd-core/workflows/ship.md', append('mktemp /tmp/gsd-XX.json'), 'no-hardcoded-home-gsd-tools');
    findsOne('a run of three X before a suffix is a suffixed template (limit)', 'gsd-core/workflows/ship.md', append('mktemp /tmp/gsd-XXX.json'), 'no-hardcoded-home-gsd-tools', 'a workflow mktemp template must keep XXXXXX as the final path component');
    findsOne('a run of four X before a suffix is a suffixed template (limit + 1)', 'gsd-core/workflows/ship.md', append('mktemp /tmp/gsd-XXXX.json'), 'no-hardcoded-home-gsd-tools', 'a workflow mktemp template must keep XXXXXX as the final path component');
    // One finding for one cause.
    findsOne('a missing rooms: line in the skill is one finding', 'skills/gsd-mempalace-capture/SKILL.md', swap('rooms:\n     - name: decisions', 'items:\n     - name: decisions'), 'mempalace-capture-headless-invocation', 'could not locate a rooms: YAML block');
    findsOne('a missing YAML sentinel in the command is one finding', 'commands/gsd/mempalace-capture.md', swap('   YAML\n   # Suppress', '   # Suppress'), 'mempalace-capture-headless-invocation', 'could not locate a rooms: YAML block');
    findsOne('the import command gone from the ultraplan workflow is one finding', 'gsd-core/workflows/ultraplan-phase.md', swap('gsd:import', 'gsd:imp'), 'ultraplan-phase', 'the workflow must direct the user to run /gsd-import --from after ultraplan completes');
    findsOne('the /ultraplan trigger gone from the ultraplan workflow is one finding', 'gsd-core/workflows/ultraplan-phase.md', swap('/ultraplan', 'ultraplan'), 'ultraplan-phase', 'the workflow must trigger /ultraplan');
    findsOne('the jq-dependent lanes declaration gone from review.md is one finding', 'gsd-core/workflows/review.md', swap('jq-dependent reviewer lanes', 'jq reviewers'), 'workflow-jq-dependency', 'review.md must declare the jq-dependent reviewer lanes');
    // Branches of the jq scans.
    passes('gsd_run query with a longer verification.status word is not a jq pipe', 'gsd-core/workflows/review.md', append('gsd_run query verification.statuses | jq .x'), 'workflow-jq-dependency');
    findsOne('a lane name that is the tail of a longer word does not count', 'gsd-core/workflows/review.md', swap('ollama', 'myollama'), 'workflow-jq-dependency', 'review.md must name ollama as a jq-dependent lane');
    findsOne('a lane name glued to the end of the declaration does not count', 'gsd-core/workflows/review.md',
      (text) => text.split('ollama').join('x').split('jq-dependent reviewer lanes').join('jq-dependent reviewer lanesollama'), 'workflow-jq-dependency', 'review.md must name ollama as a jq-dependent lane');
    // Only the files directly under a directory are read.
    test('a nested verify-work step carrying the user-flow phrase is not read', (t) => {
      const root = copyOfRepoFiles(t);
      const framing = path.join(root, 'gsd-core', 'workflows', 'verify-work', 'steps', 'mvp-uat-framing.md');
      fs.writeFileSync(framing, framingBody3(fs.readFileSync(framing, 'utf8'), 'technical checks defer'));
      write(root, 'gsd-core/workflows/verify-work/steps/nested/extra.md', 'user-flow first\n');
      const findings = runShipped(root, ['verify-mvp-uat']);
      assert.ok(findings.some((f) => f.message.includes('the workflow must specify user-flow-first ordering')), JSON.stringify(findings.map((f) => f.message)));
    });
    test('a nested workflow citing review.md by line number is not read', (t) => {
      const root = copyOfRepoFiles(t);
      write(root, 'gsd-core/workflows/nested/extra.md', 'See review.md:12 for the prerequisite.\n');
      assert.deepEqual(runShipped(root, ['workflow-jq-dependency']), []);
    });
    // Smaller branches.
    passes('a carriage return before the required_reading tag still starts a line', 'agents/gsd-verifier.md', swap('\n<required_reading>', '\r<required_reading>'), 'verification-overrides');
    passes('a line separator before the required_reading tag still starts a line', 'agents/gsd-verifier.md', swap('\n<required_reading>', '\u2028<required_reading>'), 'verification-overrides');
    passes('mempalace glued to mine is not a mine command', 'commands/gsd/mempalace-capture.md', append('mempalacemine --room x'), 'mempalace-capture-headless-invocation');
    test('a rooms entry with no blank after the hyphen is not a bare-string entry (it is not valid as a dict either)', (t) => {
      const root = copyOfRepoFiles(t);
      const abs = path.join(root, 'commands', 'gsd', 'mempalace-capture.md');
      fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').split('- name: decisions').join('-decisions'));
      const findings = runShipped(root, ['mempalace-capture-headless-invocation']);
      assert.ok(findings.length > 0 && !findings.some((f) => f.message.includes('bare-string entries')), JSON.stringify(findings.map((f) => f.message)));
    });
    // A fenced `## ` line inside a model section is example text and does not end the section.
    passes('a fenced ## line before the Counters line does not end the section', 'gsd-core/references/thinking-models-debug.md',
      (text) => { const at = text.indexOf('**Counters:**'); return `${text.slice(0, at)}\`\`\`\n## fake heading\n\`\`\`\n${text.slice(at)}`; }, 'thinking-model-guidance');
    // The general gsd_run query guard needs a blank on each side of query: the per-family probes still see the pipe, the guard does not.
    for (const [title, line] of [['gsd_runquery with no blank', 'gsd_runquery config-get x | jq .x'], ['gsd_run queryconfig-get with no blank', 'gsd_run queryconfig-get x | jq .x']]) {
      test(`${title} is not a gsd_run query for the general guard`, (t) => {
        const root = copyOfRepoFiles(t);
        const abs = path.join(root, 'gsd-core', 'workflows', 'review.md');
        fs.writeFileSync(abs, `${fs.readFileSync(abs, 'utf8')}\n${line}\n`);
        const findings = runShipped(root, ['workflow-jq-dependency']);
        assert.ok(findings.some((f) => f.message.includes('config-get lookups must use --raw')), JSON.stringify(findings.map((f) => f.message)));
        assert.ok(!findings.some((f) => f.message.includes('no gsd_run query (config-get')), JSON.stringify(findings.map((f) => f.message)));
      });
    }
    passes('an indented bash fence is not a block, as before', 'agents/gsd-verifier.md', append('  ```bash\n  node ~/x/gsd-tools.cjs state\n  ```'), 'no-hardcoded-home-gsd-tools');



    // ---- review round 2: one finding for one cause, the pipeline walk, the remaining branches, and differential properties.
    // A path a contract reads, gone from the tree or empty, is exactly one finding however many assertions read it.
    for (const [contract, rels] of [
      ['ultraplan-phase', ['commands/gsd/ultraplan-phase.md', 'gsd-core/workflows/ultraplan-phase.md']],
      ['verify-mvp-uat', ['gsd-core/workflows/verify-work.md', 'gsd-core/references/verifier-phase-gates.md']],
      ['verification-overrides', ['gsd-core/references/verification-overrides.md', 'agents/gsd-verifier.md']],
      ['thinking-model-guidance', [
        'gsd-core/references/thinking-models-debug.md', 'gsd-core/references/thinking-models-execution.md', 'gsd-core/references/thinking-models-planning.md',
        'gsd-core/references/thinking-models-research.md', 'gsd-core/references/thinking-models-verification.md',
        'agents/gsd-debugger.md', 'agents/gsd-executor.md', 'agents/gsd-planner.md', 'agents/gsd-phase-researcher.md', 'agents/gsd-plan-checker.md', 'agents/gsd-verifier.md',
      ]],
      ['workflow-jq-dependency', [
        'review', 'plan-phase', 'ship', 'debug', 'autonomous', 'ai-integration-phase', 'eval-review', 'update',
      ].map((name) => `gsd-core/workflows/${name}.md`)],
      ['mempalace-capture-headless-invocation', ['skills/gsd-mempalace-capture/SKILL.md', 'commands/gsd/mempalace-capture.md', 'capabilities/mempalace/fragments/capture-problems.md', '.gitignore']],
    ]) {
      for (const rel of rels) {
        for (const [state, apply] of [['removed from the tree', (abs) => fs.unlinkSync(abs)], ['emptied', (abs) => fs.writeFileSync(abs, '')]]) {
          test(`${rel} ${state} is exactly one finding for ${contract}`, (t) => {
            const root = copyOfRepoFiles(t);
            apply(path.join(root, ...rel.split('/')));
            const findings = runShipped(root, [contract]);
            assert.equal(findings.length, 1, JSON.stringify(findings.map((f) => [f.file, f.message])));
            assert.equal(findings[0].file, rel);
          });
        }
      }
    }
    // One cause, one finding inside a contract.
    findsOne('accepted_by gone from the reference is one finding', 'gsd-core/references/verification-overrides.md', eraseAll('accepted_by'), 'verification-overrides', 'the reference should document the accepted_by field');
    findsOne('accepted_at gone from the reference is one finding', 'gsd-core/references/verification-overrides.md', eraseAll('accepted_at'), 'verification-overrides', 'the reference should document the accepted_at field');
    findsOne('Step 3b gone from the verifier is one finding', 'agents/gsd-verifier.md', swap('Step 3b', 'Step 3c'), 'verification-overrides', 'marker "## Step 3b" not found');
    findsOne('the scope sentence gone from the planning reference is one finding', 'gsd-core/references/thinking-models-planning.md', swap('must never reduce requested scope', 'may reduce scope'), 'thinking-model-guidance', 'the planning Occam check must say it must never reduce requested scope');
    findsOne('the decision-point block gone from an agent is one finding', 'agents/gsd-debugger.md', eraseAll('step name="investigation_loop"'), 'thinking-model-guidance', 'gsd-debugger.md must contain the block step name="investigation_loop"');
    // The two thinking-model tightenings and their alternatives.
    passes('the plan checker sentence wrapped across lines still counts', 'gsd-core/references/thinking-models-planning.md', swap('the plan checker flags a new abstraction', 'the plan checker\nflags a new\nabstraction'), 'thinking-model-guidance');
    passes('gaps_found alone names the gap closure trigger', 'gsd-core/references/thinking-models-planning.md', (text) => text.split('gap closure mode').join('x'), 'thinking-model-guidance');
    passes('gap closure mode alone names the gap closure trigger', 'gsd-core/references/thinking-models-planning.md', (text) => text.split('gaps_found').join('x'), 'thinking-model-guidance');
    // The jq walk reads every pipe of the line.
    passes('a pipeline with no jq stage is not a jq pipe', 'gsd-core/workflows/review.md', append('X=$(gsd_run query config-get k | tr -d x | sort)'), 'workflow-jq-dependency');
    passes('a jq stage on a later line is not this line\'s pipe', 'gsd-core/workflows/review.md', append('X=$(gsd_run query config-get k | sort)\nother | jq .'), 'workflow-jq-dependency');
    test('gsd_runx query is not a gsd_run query for the general guard', (t) => {
      const root = copyOfRepoFiles(t);
      const abs = path.join(root, 'gsd-core', 'workflows', 'review.md');
      fs.writeFileSync(abs, `${fs.readFileSync(abs, 'utf8')}\ngsd_runx query config-get x | jq .x\n`);
      const findings = runShipped(root, ['workflow-jq-dependency']);
      assert.ok(findings.some((f) => f.message.includes('config-get lookups must use --raw')), JSON.stringify(findings.map((f) => f.message)));
      assert.ok(!findings.some((f) => f.message.includes('no gsd_run query (config-get')), JSON.stringify(findings.map((f) => f.message)));
    });
    findsOne('uc_field glued to its field is not a call that resolves it', 'gsd-core/workflows/update.md', swap('uc_field scope', 'uc_fieldscope'), 'workflow-jq-dependency', 'update.md must still resolve scope from the update-context projection');
    // One finding for one pipe to jq, whichever of the family probes and the general guard could see it.
    for (const [title, rel, line, expected] of [
      ['a config-get lookup piped to jq in review.md', 'gsd-core/workflows/review.md', 'VALUE=$(gsd_run query config-get review.model | jq -r .)', 'config-get lookups must use --raw, not a jq pipe'],
      ['a resolve-model lookup piped to jq in plan-phase.md', 'gsd-core/workflows/plan-phase.md', 'MODEL=$(gsd_run query resolve-model planner | jq -r .model)', 'resolve-model lookups must use --pick, not a jq pipe'],
      ['a verification.status lookup piped to jq in ship.md', 'gsd-core/workflows/ship.md', 'S=$(gsd_run query verification.status "$DIR" | jq -r .status)', 'verification.status lookups must use --pick, not a jq pipe'],
      ['an update-context lookup piped to jq in update.md', 'gsd-core/workflows/update.md', "V=$(gsd_run query update-context --json | jq -r '.installedVersion')", 'update-context lookups must not pipe to jq'],
      ['a resolve-execution lookup piped to jq in debug.md', 'gsd-core/workflows/debug.md', 'E=$(gsd_run query resolve-execution debugger | jq -r .effort)', 'resolve-execution lookups must use --pick, not a jq pipe'],
      ['a gsd_run query with extra blanks piped to jq in autonomous.md', 'gsd-core/workflows/autonomous.md', 'X=$(gsd_run   query   config-get workflow.x | jq -r .)', 'config-get lookups must use --raw, not a jq pipe'],
      ['a pipe to jq on the line after the pipe character in ai-integration-phase.md', 'gsd-core/workflows/ai-integration-phase.md', 'config-get workflow.y |\n   jq -r .', 'config-get lookups must use --raw, not a jq pipe'],
      ['a pipe to jq with tab blanks in eval-review.md', 'gsd-core/workflows/eval-review.md', 'resolve-model reviewer |\t\tjq .model', 'resolve-model lookups must use --pick, not a jq pipe'],
      ['a pipe to jq reached after other arguments in review.md', 'gsd-core/workflows/review.md', 'gsd_run query verification.status "$D" --pick status --raw | jq .', 'verification.status lookups must use --pick, not a jq pipe'],
      ['a tr stage before jq in review.md', 'gsd-core/workflows/review.md', 'X=$(gsd_run query config-get k | tr -d \'"\' | jq -r .)', 'config-get lookups must use --raw, not a jq pipe'],
      ['a query family with no word boundary piped to jq (only the general guard sees it)', 'gsd-core/workflows/review.md', 'gsd_run query config-getx k | jq .x', 'no gsd_run query (config-get|resolve-model|resolve-execution|verification.status) may pipe to jq'],
    ]) {
      findsOne(`${title} is one finding`, rel, append(line), 'workflow-jq-dependency', expected);
    }
    findsOne('a bare-string rooms entry in the skill is one finding', 'skills/gsd-mempalace-capture/SKILL.md', swap('- name: decisions', '- decisions'), 'mempalace-capture-headless-invocation', 'the rooms: block must not contain bare-string entries');
    findsOne('a bare-string rooms entry in the command is one finding', 'commands/gsd/mempalace-capture.md', swap('- name: decisions', '- decisions'), 'mempalace-capture-headless-invocation', 'the rooms: block must not contain bare-string entries');
    // The guarded loaders report a load failure as a finding of their own.
    test('a markdown sectionizer that cannot be loaded is a reported error, not a throw', () => {
      const thinking = require('../scripts/static-checks/text-contracts/thinking-model-guidance.cjs').walkers;
      const failed = thinking.loadFenceScanner(() => { throw new Error('no build'); });
      assert.match(failed.error, /the markdown sectionizer cannot be loaded: no build/);
      assert.equal(typeof thinking.loadFenceScanner(() => ({ scanFencedBlocks: () => [] })).scan, 'function');
      assert.equal(typeof thinking.loadFenceScanner().scan, 'function');
    });
    test('a js-yaml that cannot be loaded is a reported error, not a parse error', () => {
      const mempalace = require('../scripts/static-checks/text-contracts/mempalace-capture-headless-invocation.cjs').walkers;
      assert.match(mempalace.loadYaml(() => { throw new Error('no module'); }).error, /js-yaml cannot be loaded: no module/);
      assert.equal(typeof mempalace.loadYaml().yaml.load, 'function');
    });
    // Differential properties: each linear walker against the pattern or algorithm it replaced, over strings made of composite
    // tokens that make both outcomes frequent. A property counts the strings the old version accepts and rejects and requires
    // both, so it can never compare false with false. Domains: the jq pipe walks are compared with the old patterns with the
    // first-pipe restriction lifted and exclude strings holding || (the shell operator the walker skips on purpose); the bash
    // block walk excludes carriage returns, U+2028 and U+2029 (the old dot did not match them); every other walker is
    // compared over its whole alphabet.
    {
      const fc = require('./helpers/fast-check-setup.cjs');
      const jq = require('../scripts/static-checks/text-contracts/workflow-jq-dependency.cjs').walkers;
      const home = require('../scripts/static-checks/text-contracts/no-hardcoded-home-gsd-tools.cjs').walkers;
      const ultraplan = require('../scripts/static-checks/text-contracts/ultraplan-phase.cjs').walkers;
      const mempalace = require('../scripts/static-checks/text-contracts/mempalace-capture-headless-invocation.cjs').walkers;
      const overrides = require('../scripts/static-checks/text-contracts/verification-overrides.cjs').walkers;
      const strings = (tokens, maxLength = 10) => fc.array(fc.constantFrom(...tokens), { maxLength }).map((parts) => parts.join(''));
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

      test('property: the jq pipe walks agree with the pipe patterns they replaced', () => {
        const pipeline = strings(['config-get', 'config-get k', 'resolve-model', 'resolve-execution', 'verification.status', 'verification.statuses', 'update-context', 'gsd_run query ', 'gsd_run  query\t', 'gsd_run', 'query', ' | jq', ' | tr x', ' |\njq', ' | jqx', ' | grep jq', '\n', '\r', '\u2028', ' ', 'x', ' --raw'], 9).filter((s) => !s.includes('||'));
        agrees('config-get', pipeline, (s) => [jq.wordPipedToJq(s, 'config-get'), /config-get\b[^\n]*\|\s*jq\b/.test(s)]);
        agrees('verification.status', pipeline, (s) => [jq.wordPipedToJq(s, 'verification.status'), /verification\.status\b[^\n]*\|\s*jq\b/.test(s)]);
        agrees('update-context', pipeline, (s) => [jq.wordPipedToJq(s, 'update-context'), /update-context\b[^\n]*\|\s*jq\b/.test(s)]);
        const queries = strings(['gsd_run query config-get', 'gsd_run  query\tresolve-execution', 'gsd_run query resolve-model', 'gsd_run query verification.status', 'gsd_run query verification.statuses', 'gsd_run query config-getx', 'gsd_runx query config-get', 'gsd_run queryconfig-get', ' k', ' | jq', ' | tr x', ' |\njq', ' | jqx', '\n', ' ', 'x'], 6).filter((s) => !s.includes('||'));
        agrees('query families', queries, (s) => [jq.queryPipedToJq(s), /gsd_run\s+query\s+(?:config-get|resolve-model|resolve-execution|verification\.status\b)[^\n]*\|\s*jq\b/.test(s)]);
      });

      test('property: the field and lane walks agree with the patterns they replaced', () => {
        agrees('uc_field', strings(['uc_field scope', 'uc_field ', 'uc_field\n', 'scope', 'scopes', ' ', '\n', 'x', '_'], 5), (s) => [jq.callsWithField(s, 'uc_field', 'scope'), /uc_field\s+scope\b/.test(s)]);
        agrees('lanes', strings(['jq-dependent reviewer lanes', ' ollama', 'ollama', 'myollama', 'ollamax', 'x', ' ', '\n'], 5), (s) => [jq.laneAfterDeclaration(s, 'ollama'), !s.includes('jq-dependent reviewer lanes') || /jq-dependent reviewer lanes[\s\S]*\bollama\b/.test(s)]);
      });

      test('property: the $HOME and mktemp walks agree with the patterns they replaced', () => {
        const call = strings(['node ', 'node  `~', 'node "$HOME/', 'node ~/', 'node ${HOME}', '$HOME/', 'gsd-tools.cjs"', 'gsd-tools.cjs', 'x', ' ', '"', '\r'], 6);
        agrees('hardcoded node call', call, (s) => [home.hardcodedNodeCall(s), /node\s+[`"']?(?:\$HOME|\$\{HOME\}|~)[^\n]*?gsd-tools\.cjs/.test(s)]);
        agrees('quoted home node call', call, (s) => [home.quotedHomeNodeCall(s), /node\s+"\$HOME\/[^"]*gsd-tools\.cjs"/.test(s)]);
        agrees('suffixed mktemp', strings(['mktemp /tmp/aXXX', 'mktemp "', 'mktemp ', 'XXX', 'XX', 'X', '.json', 'a', '-', ' ', '\t', '/', '\r'], 6), (s) => [home.suffixedMktemp(s), /mktemp\s+["']?\S*?X{3,}(?!X)[.A-Za-z0-9_-]/.test(s)]);
      });

      // The old extractor of the bash blocks, copied from the deleted test.
      function oldBashBlocks(content) {
        const lines = content.split(/\r?\n/);
        const blocks = [];
        let inBash = false;
        let blockLines = [];
        for (let i = 0; i < lines.length; i++) {
          const lineText = lines[i];
          if (!inBash) {
            if (/^```(?:bash|sh)(?:\s.*)?$/.test(lineText)) {
              inBash = true;
              blockLines = [];
            }
          } else if (/^```\s*$/.test(lineText)) {
            blocks.push(blockLines);
            inBash = false;
            blockLines = [];
          } else {
            blockLines.push({ line: lineText, number: i + 1 });
          }
        }
        if (inBash && blockLines.length > 0) blocks.push(blockLines);
        return blocks;
      }
      test('property: the bash block walk agrees with the extractor it replaced', () => {
        const lines = fc.array(fc.constantFrom('```bash', '```sh', '```', '``` ', '```bash x', '```bashx', '```shx', '```bash\u00a0y', '```js', '  ```bash', 'node ~/x', 'x', ''), { maxLength: 12 }).map((parts) => parts.join('\n'));
        agrees('bash blocks', lines, (s) => [home.bashBlocks(s), oldBashBlocks(s)]);
      });

      test('property: the command name walk agrees with the pattern it replaced', () => {
        agrees('name line', strings(['name:', 'name: gsd:ultraplan-phase', 'gsd:ultraplan-phase', ' ', '\t', '\n', '\r', '\u2028', '\u2029', '\u00a0', 'x'], 6), (s) => [ultraplan.hasNameLine(s), /^name:\s*gsd:ultraplan-phase$/m.test(s)]);
      });

      test('property: the mempalace walks agree with the patterns they replaced', () => {
        agrees('mine command', strings(['mempalace', ' mine', 'mine', 'minefield', '  ', '\t', 'x', ' --room x', '-'], 4), (s) => [mempalace.isMineCommand(s), /^\s*mempalace\s+mine\b/.test(s)]);
        agrees('bare entry', strings(['-', ' ', '\t', 'decisions', 'a-b', '1x', 'x y', ':', ' - decisions', '  - name: x'], 4), (s) => [mempalace.isBareEntry(s), /^\s*-\s+[A-Za-z][A-Za-z0-9_-]*\s*$/.test(s)]);
        const oldRoomsYaml = (content) => {
          const lines = content.split(/\r?\n/);
          const start = lines.findIndex((l) => /^\s*rooms:\s*$/.test(l));
          if (start === -1) return null;
          let end = -1;
          for (let i = start + 1; i < lines.length; i++) {
            if (/^\s*YAML\s*$/.test(lines[i])) { end = i; break; }
          }
          if (end === -1) return null;
          return lines.slice(start, end).join('\n');
        };
        const roomsLines = fc.array(fc.constantFrom('rooms:', '  rooms:', ' rooms: ', 'YAML', '  YAML ', '- name: a', '  - name: b', 'x', ''), { maxLength: 8 }).map((parts) => parts.join('\n'));
        agrees('rooms block', roomsLines, (s) => [mempalace.roomsBlock(s), oldRoomsYaml(s)], (expected) => expected !== null);
      });

      test('property: the required_reading and criterion walks agree with the patterns they replaced', () => {
        agrees('required_reading', strings(['<required_reading>', '\n', '\r', '\u2028', '\u2029', ' ', 'x', '`<required_reading>`'], 6), (s) => {
          const match = s.match(/^<required_reading>/m);
          return [overrides.requiredReadingAt(s), match ? match.index : -1];
        }, (expected) => expected > 0); // an index: -1 is no match and 0 is the trivial one, so a match after a line break is what must occur
        agrees('criterion field', strings(['criterion:', ' ', '\t', '\u00a0', 'x', '\n', 'the criterion: x'], 6), (s) => [overrides.hasCriterionField(s), s.split('\n').filter((l) => /^\s+criterion:/.test(l)).length > 0]);
      });
    }

    // ---- review round 4: quoted, commented and flow-list rooms entries, contract-level loader seams, an unclosed fence, two causes.
    for (const [title, edit] of [
      ['a double-quoted rooms entry', swap('- name: decisions', '- "decisions"')],
      ['a single-quoted rooms entry', swap('- name: decisions', "- 'decisions'")],
      ['a rooms entry with a trailing comment', swap('- name: decisions', '- decisions # note')],
      ['a flow list of bare rooms', swap('     - name: decisions\n     - name: planning\n     - name: milestones\n     - name: problems\n     - name: general\n', '     [decisions, planning, milestones, problems, general]\n')],
    ]) {
      for (const rel of ['skills/gsd-mempalace-capture/SKILL.md', 'commands/gsd/mempalace-capture.md']) {
        findsOne(`${title} in ${rel} is one finding`, rel, edit, 'mempalace-capture-headless-invocation', 'every rooms: entry must be a dict with a name key');
      }
    }
    // A contract whose loader fails is a finding of its own; the seam builds the contract with a loader that throws.
    const seamRun3 = (t, id, factory) => {
      const root = copyOfRepoFiles(t);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-seam-'));
      t.after(() => cleanup(dir));
      const real = path.join(REPO_ROOT, 'scripts', 'static-checks', 'text-contracts', `${id}.cjs`);
      fs.writeFileSync(path.join(dir, `${id}.cjs`), `const real = require(${JSON.stringify(real)});\nmodule.exports = { id: real.id, check: ${factory} };\n`);
      return textContracts.run({ root, dir, only: [id], minContracts: 1 });
    };
    test('a markdown sectionizer that cannot be loaded is one finding of the thinking-model contract', (t) => {
      const findings = seamRun3(t, 'thinking-model-guidance', "real.walkers.buildCheck(() => real.walkers.loadFenceScanner(() => { throw new Error('no build'); }))");
      assert.equal(findings.length, 1, JSON.stringify(findings.map((f) => f.message)));
      assert.match(findings[0].message, /the markdown sectionizer cannot be loaded: no build/);
    });
    test('a js-yaml that cannot be loaded is one finding for each surface of the mempalace contract', (t) => {
      const findings = seamRun3(t, 'mempalace-capture-headless-invocation', "real.walkers.buildCheck(() => real.walkers.loadYaml(() => { throw new Error('no module'); }))");
      assert.equal(findings.length, 2, JSON.stringify(findings.map((f) => f.message)));
      assert.ok(findings.every((f) => /js-yaml cannot be loaded: no module/.test(f.message) && !/not valid YAML/.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
    });
    // A model heading inside an unclosed fence is example text, so the model has no heading.
    findsOne('a model heading inside an unclosed fence is not a heading', 'gsd-core/references/thinking-models-debug.md', swap('## 4. Counterfactual Thinking', '```\n## 4. Counterfactual Thinking'), 'thinking-model-guidance', 'must name the model "Counterfactual Thinking" in a heading');
    // Two distinct pipes to jq in one file are two findings (the family probe and the general guard each report their own).
    editFiles3('a no-boundary family pipe and a family probe pipe are two causes', [['gsd-core/workflows/review.md', append('gsd_run query config-getx k | jq .x\nMODEL=$(gsd_run query resolve-model planner | jq -r .model)')]], 'workflow-jq-dependency', /no gsd_run query \(config-get\|resolve-model\|resolve-execution\|verification\.status\) may pipe to jq/);
    test('the two pipes of one file are exactly two findings', (t) => {
      const root = copyOfRepoFiles(t);
      const abs = path.join(root, 'gsd-core', 'workflows', 'review.md');
      fs.writeFileSync(abs, `${fs.readFileSync(abs, 'utf8')}\ngsd_run query config-getx k | jq .x\nMODEL=$(gsd_run query resolve-model planner | jq -r .model)\n`);
      const findings = runShipped(root, ['workflow-jq-dependency']);
      assert.equal(findings.length, 2, JSON.stringify(findings.map((f) => f.message)));
    });

    // ---- review round 5: null and boolean bare entries, the gap closure trigger inside its section.
    for (const [title, entry] of [['a null', '- null'], ['a true', '- true'], ['a capitalised True', '- True'], ['a false', '- false']]) {
      for (const rel of ['skills/gsd-mempalace-capture/SKILL.md', 'commands/gsd/mempalace-capture.md']) {
        findsOne(`${title} rooms entry in ${rel} is one finding`, rel, swap('- name: decisions', entry), 'mempalace-capture-headless-invocation', 'the rooms: block must not contain bare-string entries');
      }
    }
    findsOne('a gap closure trigger outside its section does not count', 'gsd-core/references/thinking-models-planning.md',
      (text) => {
        const from = text.indexOf('## Gap Closure Mode');
        const to = text.indexOf('\n## ', from + 1);
        const section = text.slice(from, to).split('gaps_found').join('x').split('gap closure mode').join('y');
        return `gaps_found\n${text.slice(0, from)}${section}${text.slice(to)}`;
      }, 'thinking-model-guidance', 'the Gap Closure Mode section must name its trigger condition');
    findsOne('the When NOT to Think heading gone from the planning reference is one finding', 'gsd-core/references/thinking-models-planning.md', swap('\n## When NOT to Think', '\n## Stop'), 'thinking-model-guidance', 'must have a "When NOT to Think" section');
  }

  {
    // Group 4 helper: some finding of the contract contains `expected` (an edit may cause several findings).
    const findsAmong = (title, rel, edit, contract, expected) => test(title, (t) => {
      const root = copyOfRepoFiles(t);
      const abs = path.join(root, ...rel.split('/'));
      const before = fs.readFileSync(abs, 'utf8');
      const after = edit(before);
      assert.notEqual(after, before, 'the edit changed the file');
      fs.writeFileSync(abs, after);
      const findings = runShipped(root, [contract]);
      assert.ok(findings.some((f) => f.message.includes(expected)), JSON.stringify(findings.map((f) => f.message)));
    });

    // quick-commit-boundary-context-research: either form of the file-existence test guards a file, with no bound on the
    // blanks after -f or on the quote-free run before the name (the old `\s+` and `[^"]*` were unbounded).
    const QUICK_STEP = 'gsd-core/workflows/quick/steps/worktree-pre-dispatch-commit.md';
    for (const name of ['CONTEXT', 'RESEARCH']) {
      const guard = `[ -f "\${QUICK_DIR}/\${quick_id}-${name}.md" ]`;
      passes(`the quoted -f form alone guards ${name}.md`, QUICK_STEP, swap(guard, `test -f "\${QUICK_DIR}/\${quick_id}-${name}.md"`), 'quick-commit-boundary-context-research');
      passes(`the bracket form alone guards ${name}.md`, QUICK_STEP, swap(guard, `[ -f \${QUICK_DIR}/\${quick_id}-${name}.md ]`), 'quick-commit-boundary-context-research');
      passes(`a newline between -f and the quoted ${name}.md path still guards it`, QUICK_STEP, swap(guard, `test -f\n  "\${QUICK_DIR}/\${quick_id}-${name}.md" ]`), 'quick-commit-boundary-context-research');
      passes(`a hundred blanks between -f and the quoted ${name}.md path still guard it`, QUICK_STEP, swap(guard, `test -f${' '.repeat(100)}"\${QUICK_DIR}/\${quick_id}-${name}.md" ]`), 'quick-commit-boundary-context-research');
      passes(`a 600-character quote-free run before ${name}.md still guards it`, QUICK_STEP, swap(guard, `test -f "${'x'.repeat(600)}-${name}.md" ]`), 'quick-commit-boundary-context-research');
      passes(`a 600-character run between [ -f and ${name}.md on one line still guards it`, QUICK_STEP, swap(guard, `[ -f ${'x'.repeat(600)} ${name}.md ]`), 'quick-commit-boundary-context-research');
      findsOne(`a quote inside the run before ${name}.md ends the quoted form`, QUICK_STEP, swap(guard, `test -f "x" "\${QUICK_DIR}/\${quick_id}-${name}.md" ]`), 'quick-commit-boundary-context-research', `${name}.md staging must be guarded by a file-existence test`);
    }

    // spec-phase-probe-reachability: the transition verbs, the heading shapes and the step-id order.
    const SPEC_PHASE = 'gsd-core/workflows/spec-phase.md';
    for (const verb of ['Proceed', 'Continue', 'Go', 'Return', 'Skip', 'JUMP', 'jump']) {
      passes(`"${verb} to Step 5.5" is a transition that reaches the first probe`, SPEC_PHASE, swap('Jump to Step 5.5', `${verb} to Step 5.5`), 'spec-phase-probe-reachability');
    }
    passes('a no-break space between the words of a transition still counts', SPEC_PHASE, swap('Jump to Step 5.5', 'Jump\u00a0to\u00a0Step\u00a05.5'), 'spec-phase-probe-reachability');
    findsOne('a transition split over two lines is not a transition', SPEC_PHASE, swap('Jump to Step 5.5', 'Jump to\nStep 5.5'), 'spec-phase-probe-reachability', 'is defined but no jump reaches it');
    findsOne('a verb inside a longer word counts: no left word boundary', SPEC_PHASE, swap('**If `--auto`:** Jump to Step 5.5.', '**If `--auto`:** forgo to Step 6.'), 'spec-phase-probe-reachability', 'skipping mandatory Step 5.5');
    passes('a verb followed by letters is not a transition', SPEC_PHASE, swap('**If `--auto`:** Jump to Step 5.5.', '**If `--auto`:** going to Step 6.'), 'spec-phase-probe-reachability');
    passes('a jump to Step 5.4 does not skip a probe', SPEC_PHASE, swap('**If `--auto`:** Jump to Step 5.5.', 'Jump to Step 5.4.\n\n**If `--auto`:** Jump to Step 5.5.'), 'spec-phase-probe-reachability');
    passes('a jump to Step 5 followed by a full stop does not skip a probe', SPEC_PHASE, swap('**If `--auto`:** Jump to Step 5.5.', 'Jump to Step 5.\n\n**If `--auto`:** Jump to Step 5.5.'), 'spec-phase-probe-reachability');
    findsOne('Step 5.10 sorts after Step 5.6, not before', SPEC_PHASE, swap('**If `--auto`:** Jump to Step 5.5.', 'Jump to Step 5.10.\n\n**If `--auto`:** Jump to Step 5.5.'), 'spec-phase-probe-reachability', 'skipping mandatory Step 5.6');
    passes('a heading without the colon is a step', SPEC_PHASE, swap('## Step 5.6: Prohibition', '## Step 5.6 Prohibition'), 'spec-phase-probe-reachability');
    passes('a heading with the title right after the colon is a step', SPEC_PHASE, swap('## Step 5.6: Prohibition', '## Step 5.6:Prohibition'), 'spec-phase-probe-reachability');
    passes('the word probe is matched ignoring ASCII case', SPEC_PHASE, swap('Prohibition-Completeness Probe', 'Prohibition-Completeness PROBE'), 'spec-phase-probe-reachability');
    findsOne('a heading whose title holds a line separator is not a step', SPEC_PHASE, swap('## Step 5.6: Prohibition-Completeness Probe', '## Step 5.6: Prohibition-Completeness\u2028 Probe'), 'spec-phase-probe-reachability', 'found 1: 5.5');
    findsOne('a heading without a space after the hashes is not a step', SPEC_PHASE, swap('## Step 5.6: Prohibition', '##Step 5.6: Prohibition'), 'spec-phase-probe-reachability', 'found 1: 5.5');
    findsOne('a level-three heading is not a step', SPEC_PHASE, swap('## Step 5.6: Prohibition', '### Step 5.6: Prohibition'), 'spec-phase-probe-reachability', 'found 1: 5.5');
    passes('the exit may be spelled in any case', SPEC_PHASE, swap('→ proceed to Step 5.6.', '→ PROCEED TO STEP 5.6.'), 'spec-phase-probe-reachability');
    findsOne('the exit needs a digit after Step', SPEC_PHASE, swap('→ proceed to Step 6.', '→ proceed to Step six.'), 'spec-phase-probe-reachability', 'has no "proceed to Step N" exit');
    findsOne('the exit needs single spaces', SPEC_PHASE, swap('→ proceed to Step 6.', '→ proceed  to Step 6.'), 'spec-phase-probe-reachability', 'has no "proceed to Step N" exit');
    passes('the max-rounds block ends at the next level-two heading: a later jump to a probe is outside it', SPEC_PHASE, swap('## Step 5: (covered inline', '## Step 4.9: Elsewhere\n\nproceed to Step 5.5.\n\n## Step 5: (covered inline'), 'spec-phase-probe-reachability');

    // test-gate-watch-mode: how the config-get, xcodebuild, skip-arm and sniffed-script scans read a line.
    const POST_MERGE_GATE = 'gsd-core/workflows/execute-phase/steps/post-merge-gate.md';
    const REGRESSION_GATE_RUN = 'gsd-core/workflows/execute-phase/steps/regression-gate-run.md';
    passes('tabs and runs of blanks between the config-get tokens still count as the command read', REGRESSION_GATE_RUN,
      swap('config-get workflow.test_command --default "" --raw', 'config-get\t workflow.test_command \t --default\t"" --raw'), 'post-merge-gate-watch-mode');
    passes('a config-get of another key is not a build/test command read', REGRESSION_GATE_RUN,
      append('OTHER=$(gsd_run query config-get workflow.other --default "")'), 'post-merge-gate-watch-mode');
    passes('a config-get with a non-empty default is not a build/test command read', REGRESSION_GATE_RUN,
      append('OTHER=$(gsd_run query config-get workflow.test_command --default "make")'), 'post-merge-gate-watch-mode');
    findsOne('a second build/test command read without --raw is offending', REGRESSION_GATE_RUN,
      append('SECOND=$(gsd_run query config-get workflow.build_command --default "")'), 'post-merge-gate-watch-mode', 'offending: SECOND=$(gsd_run query config-get workflow.build_command --default "")');
    passes('--raw anywhere on the line is enough', REGRESSION_GATE_RUN,
      append('SECOND=$(gsd_run query config-get workflow.build_command --default "" 2>/dev/null --raw)'), 'post-merge-gate-watch-mode');
    findsOne('a fifth xcodebuild construction without -project is offending', POST_MERGE_GATE,
      append("EXTRA=\"xcodebuild build -scheme 'App' -destination 'id=1'\""), 'post-merge-gate-watch-mode', "no -project in: xcodebuild build -scheme 'App' -destination 'id=1'");
    passes('an xcodebuild mention without a quote after it is not a construction', POST_MERGE_GATE,
      append('Run xcodebuild test with no quoting at all'), 'post-merge-gate-watch-mode');
    passes('the first xcodebuild run of a line is read to the last quote of the line', POST_MERGE_GATE,
      swap("xcodebuild test -project '$XCODEPROJ' -destination '${XCODE_DEST}'\"", "xcodebuild test -project '$XCODEPROJ' -destination '${XCODE_DEST}' # 'quoted' tail\""), 'post-merge-gate-watch-mode');
    findsOne('a second skip arm without a command variable is offending', POST_MERGE_GATE,
      append('if [ -z "$XCODE_SIM" ]; then\n  echo skipped\n    fi'), 'post-merge-gate-watch-mode', 'a skip arm assigns no command variable');
    passes('a skip-arm start without its closing fi is not an arm', POST_MERGE_GATE,
      append('if [ -z "$XCODE_SIM" ]; then'), 'post-merge-gate-watch-mode');
    passes('a fi indented by more than four spaces does not close an arm', POST_MERGE_GATE,
      append('if [ -z "$XCODE_SIM" ]; then\n  TEST_CMD=""\n      fi\n    fi'), 'post-merge-gate-watch-mode');
    passes('the skip echo is read ignoring what follows on other lines', POST_MERGE_GATE,
      append('No available iOS Simulator found. Set workflow.build_command and workflow.test_command'), 'post-merge-gate-watch-mode');
    findsOne('the skip echo and its workflow key on different lines do not count', POST_MERGE_GATE,
      swap('skipping the Xcode build gate. Set workflow.build_command to run it anyway.', 'skipping the Xcode build gate.\nSet workflow.build_command to run it anyway.'), 'post-merge-gate-watch-mode', 'the build-arm skip must name workflow.build_command');
    passes('the sniffed-script log is read ignoring ASCII case', POST_MERGE_GATE,
      swap("running this project's build script", "RUNNING THIS PROJECT'S BUILD SCRIPT"), 'post-merge-gate-watch-mode');
    passes('any amount of text may sit between "build" and " script" on the line', POST_MERGE_GATE,
      swap("running this project's build script", `running this project's build ${'x'.repeat(600)} script`), 'post-merge-gate-watch-mode');
    findsOne('"script" on the next line does not complete the sniffed-script log', POST_MERGE_GATE,
      swap("running this project's build script", "running this project's build\n script"), 'post-merge-gate-watch-mode', 'a sniffed build script must be logged');
    findsOne('a line separator inside the sniffed-script log splits the line', POST_MERGE_GATE,
      swap("running this project's build script", "running this project's build\u2028 script"), 'post-merge-gate-watch-mode', 'a sniffed build script must be logged');

    // execute-phase-worktree-artifacts: only the text inside the success_criteria block counts, and the block of a mode is
    // the first one after its marker.
    const EXECUTE_PHASE_FILE = 'gsd-core/workflows/execute-phase.md';
    passes('STATE.md and ROADMAP.md mentioned between the worktree marker and its success_criteria are not criteria', EXECUTE_PHASE_FILE,
      swap('**Worktree mode** (`USE_WORKTREES` and `USE_WORKTREES_FOR_PLAN` not `false`):', '**Worktree mode** (`USE_WORKTREES` and `USE_WORKTREES_FOR_PLAN` not `false`):\n\n   The orchestrator writes STATE.md and ROADMAP.md after each wave.'), 'execute-phase-worktree-artifacts');
    findsAmong('a worktree block whose closing tag is gone runs into the sequential block and sees its STATE.md', EXECUTE_PHASE_FILE,
      within('**Worktree mode**', '**Sequential mode**', swap('       </success_criteria>', '')), 'execute-phase-worktree-artifacts', 'the worktree executor success_criteria must not reference STATE.md');

    // tdd-backend-wiring: the eight-line window above an assignment, the four-line window of the fail-closed check, and how
    // the assignment, use, Agent( and tdd.md lines are read.
    const TDD_FRAGMENT = 'gsd-core/workflows/execute-phase/steps/tdd-applicability-resolution.md';
    const TDD_WORKTREE = 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md';
    const TDD_HARNESS = 'gsd-core/workflows/execute-phase.md';
    // The distance, in lines, between the query call and the assignment is `gap`; the FATAL echo that also names the
    // verb is renamed so only the call line counts.
    gapCases('lines between the phase.tdd-applicable call and the harness assignment', TDD_FRAGMENT, 'tdd-backend-wiring',
      (text, gap) => text.split("'gsd_run query phase.tdd-applicable' failed").join("'gsd_run query tdd-applicable' failed")
        .split('\nTDD_APPLICABLE="$TDD_APPLICABLE_RAW"').join(`${'\n'.repeat(gap - 6)}\nTDD_APPLICABLE="$TDD_APPLICABLE_RAW"`), 8,
      /execute-phase\.md: TDD_APPLICABLE must be assigned from a phase\.tdd-applicable call within a few lines above it/);
    gapCases('lines between the phase.tdd-applicable call and the worktree assignment', TDD_WORKTREE, 'tdd-backend-wiring',
      (text, gap) => text.split("'gsd_run query phase.tdd-applicable' failed").join("'gsd_run query tdd-applicable' failed")
        .split('\nTDD_APPLICABLE="$_TDD_APPLICABLE_RAW"').join(`${'\n'.repeat(gap - 6)}\nTDD_APPLICABLE="$_TDD_APPLICABLE_RAW"`), 8,
      /executor-isolation-dispatch\.md: TDD_APPLICABLE must be assigned from a phase\.tdd-applicable call within a few lines above it/);
    gapCases('lines before the FATAL message of the TDD_APPLICABLE fail-closed check', TDD_WORKTREE, 'tdd-backend-wiring',
      (text, gap) => within("grep -q '\\${TDD_APPLICABLE", '\nfi', (section) => `${section.slice(0, section.indexOf('\n'))}\n  exit 1${'\n'.repeat(gap - 2)}\n  echo FATAL:`)(text), 3, /the check emits no FATAL message/);
    gapCases('lines before the exit 1 of the TDD_APPLICABLE fail-closed check', TDD_WORKTREE, 'tdd-backend-wiring',
      (text, gap) => within("grep -q '\\${TDD_APPLICABLE", '\nfi', (section) => `${section.slice(0, section.indexOf('\n'))}\n  echo FATAL:${'\n'.repeat(gap - 2)}\n  exit 1`)(text), 3, /the check does not exit 1/);
    passes('an indented assignment is an assignment', TDD_FRAGMENT, swap('\nTDD_APPLICABLE="$TDD_APPLICABLE_RAW"', '\n\t  TDD_APPLICABLE="$TDD_APPLICABLE_RAW"'), 'tdd-backend-wiring');
    findsAmong('an assignment that does not start the line is not an assignment', TDD_FRAGMENT, swap('\nTDD_APPLICABLE="$TDD_APPLICABLE_RAW"', '\nexport TDD_APPLICABLE="$TDD_APPLICABLE_RAW"'), 'tdd-backend-wiring', 'it has no TDD_APPLICABLE assignment');
    passes('an assignment after a line separator counts as starting a line in the fragment', TDD_FRAGMENT, swap('\nTDD_APPLICABLE="$TDD_APPLICABLE_RAW"', '\n\u2028TDD_APPLICABLE="$TDD_APPLICABLE_RAW"'), 'tdd-backend-wiring');
    passes('a longer variable name after ${TDD_APPLICABLE is not a use', TDD_WORKTREE, swap('# Resolve TDD-applicability for THIS plan (#4266/#4272)', 'echo "${TDD_APPLICABLE_X}"\n# Resolve TDD-applicability for THIS plan (#4266/#4272)'), 'tdd-backend-wiring');
    passes('a tab-indented Agent( line is the dispatch call', TDD_HARNESS, swap('\n   Agent(\n', '\n\tAgent(\n'), 'tdd-backend-wiring');
    findsAmong('an Agent( line with trailing blanks is not the dispatch call', TDD_HARNESS, swap('\n   Agent(\n', '\n   Agent( \n'), 'tdd-backend-wiring', 'it has no literal Agent( dispatch-call line');
    passes('the HALT instruction is read ignoring case', TDD_FRAGMENT, swap('HALT', 'halt'), 'tdd-backend-wiring');
    passes('an earlier tdd.md line without the conditional does not hide the conditional entry for the comment check', TDD_HARNESS,
      swap('**TDD-applicability resolution (#4266/#4272).**', 'see tdd.md\n\n   **TDD-applicability resolution (#4266/#4272).**'), 'tdd-backend-wiring');
    findsAmong('an earlier line naming tdd.md and TDD_APPLICABLE without the conditional is read first by the entry check', TDD_HARNESS,
      swap('**TDD-applicability resolution (#4266/#4272).**', 'tdd.md TDD_APPLICABLE\n\n   **TDD-applicability resolution (#4266/#4272).**'), 'tdd-backend-wiring', 'the entry is not conditional');
    passes('the config word alone satisfies the tdd_mode default of the worktree comment', TDD_WORKTREE, swap('or workflow.tdd_mode config)', 'or project config)'), 'tdd-backend-wiring');
    passes('workflow.tdd_mode alone satisfies the tdd_mode default of the worktree comment', TDD_WORKTREE, swap('or workflow.tdd_mode config)', 'or workflow.tdd_mode)'), 'tdd-backend-wiring');
    findsAmong('only one trailing parenthesis is stripped before the calls are compared', TDD_FRAGMENT, swap('--pick applicable 2>/dev/null)', '--pick applicable 2>/dev/null))'), 'tdd-backend-wiring', 'byte-identical phase.tdd-applicable command-substitution calls');

    // cleanup-branch-pruning: how a fenced block is read as shell statements, and the alternatives of each phrase test.
    const CLEANUP = 'gsd-core/workflows/cleanup.md';
    const inStep = (name, edit) => within(`<step name="${name}">`, '</step>', edit);
    // A fetch written in one of the shapes the statement reader unwraps is still a fetch, in a step that must not run one.
    for (const [shape, fence] of [
      ['an assignment', 'X=$(git fetch --prune)'],
      ['a command substitution', '$(git fetch --prune)'],
      ['a nested substitution', '$($(git fetch --prune))'],
      ['an unclosed substitution', 'X=$(git fetch --prune'],
      ['an and-list', 'true && git fetch --prune'],
      ['an or-list', 'false || git fetch --prune'],
      ['a semicolon list', 'echo x; git fetch --prune'],
      ['tab-separated words', 'git\tfetch\t--prune'],
      ['a trailing parenthesis and blank', 'git fetch --prune ) '],
      ['the short flag', 'git fetch -p'],
    ]) {
      findsOne(`${shape} is a fetch in prune_local_branches`, CLEANUP, inStep('prune_local_branches', (section) => `${section}\n\`\`\`bash\n${fence}\n\`\`\`\n`), 'cleanup-branch-pruning', 'it runs git fetch --prune');
    }
    for (const [shape, fence] of [
      ['a command after a comment mark', 'echo ok # git fetch --prune'],
      ['a word before git', 'sudo git fetch --prune'],
      ['an assignment name that starts with a digit', '1X=git fetch --prune'],
      ['a fetch without the prune flag', 'git fetch origin'],
    ]) {
      passes(`${shape} is not a fetch in prune_local_branches`, CLEANUP, inStep('prune_local_branches', (section) => `${section}\n\`\`\`bash\n${fence}\n\`\`\`\n`), 'cleanup-branch-pruning');
    }
    passes('a fence that never closes is not read', CLEANUP, inStep('prune_local_branches', (section) => `${section}\n\`\`\`bash\ngit fetch --prune\n`), 'cleanup-branch-pruning');
    findsOne('an indented fence is read', CLEANUP, inStep('prune_local_branches', (section) => `${section}\n        \`\`\`bash\n        git fetch --prune\n        \`\`\`\n`), 'cleanup-branch-pruning', 'it runs git fetch --prune');
    passes('the verbose flag alone is a git branch -vv', CLEANUP, inStep('prune_local_branches', swap('git branch -vv |', 'git branch --verbose |')), 'cleanup-branch-pruning');
    passes('the delete flag alone is a git branch -D', CLEANUP, swap('xargs -r git branch -D', 'xargs -r git branch --delete'), 'cleanup-branch-pruning');
    passes('the long form of xargs -r is accepted', CLEANUP, inStep('prune_local_branches', swap('xargs -r', 'xargs --no-run-if-empty')), 'cleanup-branch-pruning');
    passes('the long fetch flag in show_dry_run may be the short one', CLEANUP, inStep('show_dry_run', swap('git fetch --prune 2>/dev/null || true', 'git fetch -p 2>/dev/null || true')), 'cleanup-branch-pruning');
    // Each guard against the * marker alone satisfies the test, once the real one is gone.
    for (const guard of ['$1 != "*"', '$1!="*"', '!/^\\*/', '!/^\\*', 'git branch --format', 'sed s/\\*//']) {
      passes(`the guard ${guard} alone excludes the current branch`, CLEANUP, inStep('prune_local_branches', (section) => `${swap('$1 !~', '$1 ~')(section)}\n${guard}\n`), 'cleanup-branch-pruning');
    }
    for (const name of ['"main"', "'main'", '^main|']) {
      passes(`${name} alone excludes main`, CLEANUP, inStep('prune_local_branches', (section) => `${swap('^main$', '^zzz$')(section)}\n${name}\n`), 'cleanup-branch-pruning');
    }
    for (const name of ['"next"', "'next'", '^next|', '"trunk"', "'trunk'", '^trunk|']) {
      passes(`${name} alone excludes an integration branch`, CLEANUP, inStep('prune_local_branches', (section) => `${swap('^trunk$', '^xxx$')(swap('^next$', '^yyy$')(section))}\n${name}\n`), 'cleanup-branch-pruning');
    }
    for (const mention of [': gone', 'gone]', 'upstream is gone']) {
      passes(`"${mention}" alone is the stale-branch mention in show_dry_run`, CLEANUP, inStep('show_dry_run', (section) => `${eraseAll('gone')(section)}\n${mention}\n`), 'cleanup-branch-pruning');
    }
    passes('the word prune alone covers pruning in the show_dry_run prompt', CLEANUP, inStep('show_dry_run', erase(/branch/g)), 'cleanup-branch-pruning');
    passes('the lower-case pruned alone is the report count', CLEANUP, inStep('report', (section) => `${erase(/Pruned/g)(section)}\npruned\n`), 'cleanup-branch-pruning');
    passes('^next$ alone excludes an integration branch', CLEANUP, inStep('prune_local_branches', swap('^trunk$', '^xxx$')), 'cleanup-branch-pruning');
    passes('^trunk$ alone excludes an integration branch', CLEANUP, inStep('prune_local_branches', swap('^next$', '^yyy$')), 'cleanup-branch-pruning');

    // code-review-flags: without a closing step tag the initialize section runs to the end of the file (the test's slice).
    findsAmong('with no closing step tag the initialize step is not closed', 'gsd-core/workflows/code-review.md',
      (text) => text.split('</step>').join(''), 'code-review-flags', 'the initialize step is not closed');

    // A file a group 4 contract reads, gone from the tree, is exactly one finding for that file (each file is one document).
    for (const [rel, contract] of [
      ['gsd-core/workflows/quick/steps/worktree-pre-dispatch-commit.md', 'quick-commit-boundary-context-research'],
      ['gsd-core/workflows/quick.md', 'quick-commit-boundary-context-research'],
      ['gsd-core/workflows/spec-phase.md', 'spec-phase-probe-reachability'],
      ['gsd-core/workflows/execute-phase/steps/regression-gate-run.md', 'post-merge-gate-watch-mode'],
      ['gsd-core/workflows/execute-phase/steps/post-merge-gate.md', 'post-merge-gate-watch-mode'],
      ['gsd-core/workflows/audit-fix.md', 'post-merge-gate-watch-mode'],
      ['gsd-core/workflows/execute-phase/steps/regression-gate.md', 'post-merge-gate-watch-mode'],
      ['gsd-core/workflows/execute-phase.md', 'post-merge-gate-watch-mode'],
      ['gsd-core/workflows/execute-phase/steps/verify-phase-goal.md', 'post-merge-gate-watch-mode'],
      ['gsd-core/workflows/execute-phase.md', 'execute-phase-worktree-artifacts'],
      ['gsd-core/workflows/execute-phase/steps/worktree-recovery-policy.md', 'execute-phase-worktree-artifacts'],
      ['gsd-core/workflows/quick.md', 'execute-phase-worktree-artifacts'],
      ['gsd-core/workflows/execute-phase/steps/tdd-applicability-resolution.md', 'tdd-backend-wiring'],
      ['gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', 'tdd-backend-wiring'],
      ['gsd-core/workflows/execute-phase.md', 'tdd-backend-wiring'],
      ['gsd-core/workflows/cleanup.md', 'cleanup-branch-pruning'],
      ['gsd-core/workflows/code-review.md', 'code-review-flags'],
      ['gsd-core/workflows/code-review/steps/dispatch-fix.md', 'code-review-flags'],
    ]) {
      test(`${rel} removed from the tree is exactly one finding for ${contract}`, (t) => {
        const root = copyOfRepoFiles(t);
        fs.unlinkSync(path.join(root, ...rel.split('/')));
        const findings = runShipped(root, [contract]);
        assert.equal(findings.length, 1, JSON.stringify(findings.map((f) => f.message)));
        assert.equal(findings[0].file, rel);
        assert.match(findings[0].message, /cannot read the file/);
      });
    }

    // spec-phase-probe-reachability: a third probe step passes; a heading at the end of the file keeps its title when a lone CR ends it.
    passes('three probe steps (a probe before the edge probe, jumped to) satisfy the two-probe minimum', 'gsd-core/workflows/spec-phase.md',
      (text) => text.split('Jump to Step 5.5').join('Jump to Step 5.4').split('## Step 5.5: Edge-Completeness Probe').join('## Step 5.4: Extra Probe\n\nproceed to Step 5.5.\n\n## Step 5.5: Edge-Completeness Probe'), 'spec-phase-probe-reachability');
    findsAmong('a probe heading that ends the file with a lone CR keeps its title', 'gsd-core/workflows/spec-phase.md',
      (text) => `${text}\n## Step 5.7: Extra Probe\r`, 'spec-phase-probe-reachability', 'Step 5.7 (Extra Probe) has no "proceed to Step N" exit');

    // post-merge-gate-watch-mode: the four-construction and two-arm minimums, and the whole-word fi that closes an arm.
    const MERGE_GATE = 'gsd-core/workflows/execute-phase/steps/post-merge-gate.md';
    findsAmong('three xcodebuild constructions are one short of the four', MERGE_GATE,
      swap("xcodebuild build -project '$XCODEPROJ' -destination", "xcrun build -project '$XCODEPROJ' -destination"), 'post-merge-gate-watch-mode', 'expected the four Xcode command constructions, got 3');
    passes('a fifth compliant xcodebuild construction passes', MERGE_GATE,
      append("EXTRA=\"xcodebuild build -project '$XCODEPROJ' -destination 'id=1'\""), 'post-merge-gate-watch-mode');
    findsAmong('one skip arm is one short of the two', MERGE_GATE,
      (text) => { const start = 'if [ -z "$XCODE_SIM" ]; then'; const at = text.lastIndexOf(start); return text.slice(0, at) + 'if [ -z "$XCODE_SIM2" ]; then' + text.slice(at + start.length); }, 'post-merge-gate-watch-mode', 'expected both skip arms, got 1');
    passes('a third skip arm that assigns its variable passes', MERGE_GATE,
      append('if [ -z "$XCODE_SIM" ]; then\n  BUILD_CMD=""\n    fi'), 'post-merge-gate-watch-mode');
    passes('a line that only begins with fi (fix) does not close a skip arm', MERGE_GATE,
      append('if [ -z "$XCODE_SIM" ]; then\n  echo x\n    fix\n    BUILD_CMD=""\n    fi'), 'post-merge-gate-watch-mode');

    // quick-commit-boundary-context-research: no prompt=" before the executor spawn is its own finding.
    findsAmong('no prompt= before the executor spawn', 'gsd-core/workflows/quick.md',
      swap('prompt="', 'prompt = "'), 'quick-commit-boundary-context-research', 'there is no prompt=" before the executor spawn');

    // cleanup-branch-pruning: where the sectionizer's fence rules differ from the old any-triple-backtick reading, and the
    // line-terminator branches of the shell reader.
    const CLEANUP_FILE = 'gsd-core/workflows/cleanup.md';
    const inPrune = (body) => inStep('prune_local_branches', (section) => `${section}\n${body}\n`);
    findsOne('a tilde fence is read as shell', CLEANUP_FILE, inPrune('~~~bash\ngit fetch --prune\n~~~'), 'cleanup-branch-pruning', 'it runs git fetch --prune');
    passes('a closing fence shorter than its opener does not close it, so the block is dropped', CLEANUP_FILE, inPrune('````bash\ngit fetch --prune\n```'), 'cleanup-branch-pruning');
    passes('a closing fence carrying text does not close it, so the block is dropped', CLEANUP_FILE, inPrune('```bash\ngit fetch --prune\n``` x'), 'cleanup-branch-pruning');
    passes('a backtick in the info string cannot open a fence', CLEANUP_FILE, inPrune('```a`b\ngit fetch --prune\n```'), 'cleanup-branch-pruning');
    findsOne('a # before a line terminator does not start a comment', CLEANUP_FILE, inPrune('```bash\ngit fetch # c\u2028--prune\n```'), 'cleanup-branch-pruning', 'it runs git fetch --prune');
    passes('an assignment whose value holds a line terminator is not unwrapped', CLEANUP_FILE, inPrune('```bash\nX=git fetch --prune\u2028y\n```'), 'cleanup-branch-pruning');
    passes('a nested substitution holding a line terminator is not unwrapped', CLEANUP_FILE, inPrune('```bash\n$($(git fetch --prune\u2028x))\n```'), 'cleanup-branch-pruning');

    // Differential properties: each linear walker of a group 4 contract against the old regex or algorithm of the deleted test,
    // copied here as the oracle, over random strings built from the pieces the walker treats specially (whole phrases, so a
    // positive input is common). Each property counts the inputs the oracle accepts and the ones it rejects and fails unless
    // both were seen, so it cannot pass by comparing nothing with nothing or by never meeting a negative. The domains leave out the deliberate differences stated in
    // the ADR: a four-space `fi` line followed by a word character (the skip arm walker), a spawn with no prompt= before it
    // (the executor prompt walker), and a line that does not hold the query string (the query call walker).
    {
      const fc = require(path.join(REPO_ROOT, 'tests', 'helpers', 'fast-check-setup.cjs'));
      const walkersOf = (name) => require(path.join(REPO_ROOT, 'scripts', 'static-checks', 'text-contracts', `${name}.cjs`)).walkers;
      const joined = (tokens, maxLength = 20) => fc.array(fc.constantFrom(...tokens), { maxLength }).map((parts) => parts.join(''));
      // Pieces in a fixed order, each present or absent, with random filler between them.
      const shaped = (pieces, filler) => fc.tuple(...pieces.flatMap((piece) => [joined(filler, 3), fc.constantFrom(piece, '')])).map((parts) => parts.join(''));
      const found = (value) => value !== null && value !== false && value !== undefined
        && !(Array.isArray(value) && value.length === 0)
        && !(typeof value === 'object' && !Array.isArray(value) && 'error' in value);
      // `onlyAccepted` is for a domain in which the oracle cannot reject (a line that holds the query string).
      const agree = (title, arbitrary, walker, oracle, { onlyAccepted = false } = {}) => test(title, () => {
        let accepted = 0;
        let rejected = 0;
        fc.assert(fc.property(arbitrary, (input) => {
          const expected = oracle(input);
          if (found(expected)) accepted += 1;
          else rejected += 1;
          assert.deepStrictEqual(walker(input), expected);
        }));
        assert.ok(accepted > 0, 'the oracle found something on no generated input: the property compares nothing');
        assert.ok(onlyAccepted || rejected > 0, 'the oracle rejected every generated input: a walker that accepts too much would pass');
      });

      // spec-phase-probe-reachability: the step heading and the transition instruction.
      {
        const w = walkersOf('spec-phase-probe-reachability');
        const STEP_HEADING_RE = /^## Step ([0-9]+(?:\.[0-9]+)*)\s*:?\s*(.*?)\r?$/;
        const TRANSITION_RE = /(?:jump|proceed|continue|go|return|skip)\s+to\s+Step\s+([0-9]+(?:\.[0-9]+)*)/i;
        agree('the step heading walker reads a line as the old pattern did',
          fc.tuple(fc.constantFrom('## Step ', '## Step ', '##Step ', '## step '), fc.constantFrom('5', '5.5', '12', '5.', 'x', ''), joined([' ', ':', 'x', '\r', '\t', '\u2028', '\u2029', 'Probe', '\u00a0'], 8)).map((parts) => parts.join('')),
          w.parseStepHeading, (line) => { const m = line.match(STEP_HEADING_RE); return m ? { id: m[1], title: m[2].trim() } : null; });
        agree('the transition walker finds the target the old pattern found',
          joined(['jump to Step ', 'Proceed to Step ', 'GO TO STEP ', 'skip  to  step ', 'to Step ', 'jump', ' ', '\t', '5', '5.5', '10', 'x', '\u2028', '\u00a0', 'continue to Step '], 6),
          w.transitionTarget, (line) => { const m = line.match(TRANSITION_RE); return m ? m[1] : null; });
        agree('the proceed-to-step walker agrees with the old pattern', joined(['proceed to Step ', 'PROCEED TO STEP ', '5', 'x', ' ', 'proceed', 'to', '\n'], 12), w.proceedsToStep, (text) => /proceed to Step [0-9]/i.test(text));
      }

      // post-merge-gate-watch-mode: the config-get read, the xcodebuild constructions, the skip arms, the skip echo and the sniffed-script log.
      {
        const w = walkersOf('post-merge-gate-watch-mode');
        agree('the config-get walker agrees with the old pattern',
          joined(['config-get workflow.build_command --default ""', 'config-get workflow.test_command --default ""', 'config-get', ' workflow.', 'build', 'test', '_command', ' --default', ' ""', ' ', '\t', '\u2028', 'x', '"'], 6),
          w.resolvesCommand, (line) => /config-get\s+workflow\.(build|test)_command\s+--default\s+""/.test(line));
        agree('the xcodebuild construction walker agrees with the old pattern', joined(['xcodebuild build', 'xcodebuild test', "xcodebuild test -project 'a'", 'xcodebuild ', "'", ' ', '\n', 'x', '\r'], 10),
          w.constructedCommands, (text) => text.match(/xcodebuild (?:build|test)[^\n]*'/g) || []);
        agree('the skip arm walker agrees with the old pattern where no four-space fi line is followed by a word character',
          joined(['if [ -z "$XCODE_SIM" ]; then', '\n    fi', '\n     fi', '\n', 'x', ' ', 'BUILD_CMD=""', '\n  fi'], 10).filter((text) => !/\n {4}fi[A-Za-z0-9_]/.test(text)),
          w.skipArms, (text) => text.match(/if \[ -z "\$XCODE_SIM" \]; then[\s\S]*?\n {4}fi/g) || []);
        agree('the skip echo walker agrees with the old pattern', joined(['No available iOS Simulator', 'workflow.build_command', 'workflow.test_command', ' skipping workflow.build_command', '\n', ' ', 'x'], 8),
          (text) => w.skipEchoNames(text, 'workflow.build_command'), (text) => /No available iOS Simulator[^\n]*workflow\.build_command/.test(text));
        agree('the sniffed-script log walker agrees with the old pattern', joined(["running this project's build script", "RUNNING THIS PROJECT'S BUILD SCRIPT", "running this project's ", 'build ', ' script', ' ', 'x', '\n', '\r', '\u2028'], 6),
          w.logsSniffedBuildScript, (text) => /running this project's .*build.* script/i.test(text));
      }

      // tdd-backend-wiring: the assignment line, the use lines and the query call.
      {
        const w = walkersOf('tdd-backend-wiring');
        agree('the assignment walker agrees with the old pattern', joined(['TDD_APPLICABLE=', 'export ', ' ', '\t', '\u2028', 'x'], 5), w.isAssignment, (line) => /^\s*TDD_APPLICABLE=/.test(line));
        agree('the use walker agrees with the old pattern', joined(['${TDD_APPLICABLE', '${TDD_APPLICABLE}', '_X', '}', ' ', 'x', '$', '{', '\n'], 10).map((text) => text.split('\n')),
          w.useLines, (lines) => { const hits = []; lines.forEach((l, i) => { if (/\$\{TDD_APPLICABLE\b/.test(l)) hits.push(i); }); return hits; });
        const QUERY = 'gsd_run query phase.tdd-applicable';
        agree('the query call walker agrees with the old extraction on a line that holds the query string', joined([QUERY, ' --pick applicable', ' 2>/dev/null', ')', '(', 'X=$(', ' ', 'x'], 8).filter((line) => line.includes(QUERY)),
          w.queryCall, (line) => { const start = line.indexOf(QUERY); let call = line.slice(start); if (call.endsWith(')')) call = call.slice(0, -1); return call; }, { onlyAccepted: true });
      }

      // quick-commit-boundary-context-research: the guard tests and the executor blocks.
      {
        const w = walkersOf('quick-commit-boundary-context-research');
        const GUARDS = new Map([
          ['CONTEXT.md', [/-f\s+"[^"]*CONTEXT\.md"/, /\[ -f .*CONTEXT\.md/]],
          ['RESEARCH.md', [/-f\s+"[^"]*RESEARCH\.md"/, /\[ -f .*RESEARCH\.md/]],
        ]);
        for (const [name, [quoted, bracket]] of GUARDS) {
          agree(`the ${name} quoted guard walker agrees with the old patterns`, joined(['-f "', `${name}"`, '-f ', '"', name, ' ', '\t', '\n', 'x', '\r'], 8), (text) => w.guarded(text, name), (text) => quoted.test(text) || bracket.test(text));
          agree(`the ${name} bracket guard walker agrees with the old patterns`, joined(['[ -f ', name, ' ', '\n', 'x', '\r', '\u2028', '"'], 8), (text) => w.guarded(text, name), (text) => quoted.test(text) || bracket.test(text));
        }
        const FILLER = ['x', '\n', ' '];
        const SPAWN = 'subagent_type="gsd-executor"';
        agree('the executor required_reading walker agrees with the old slice', fc.tuple(shaped(['<required_reading>', SPAWN, '</required_reading>'], FILLER), joined(['<required_reading>', 'x'], 2)).map(([a, b]) => a + b), w.executorReading, (c) => {
          const idx = c.indexOf(SPAWN);
          if (idx === -1) return { error: 'the executor Agent()/Task() spawn is missing' };
          const start = c.lastIndexOf('<required_reading>', idx);
          const end = c.indexOf('</required_reading>', start);
          return start === -1 || end === -1 ? { error: 'the executor required_reading block is missing' } : { block: c.slice(start, end) };
        });
        agree('the executor prompt walker agrees with the old slice where a prompt= precedes the spawn', shaped(['prompt="', SPAWN, 'prompt="'], FILLER).filter((c) => c.indexOf(SPAWN) === -1 || c.lastIndexOf('prompt="', c.indexOf(SPAWN)) !== -1),
          w.executorPrompt, (c) => {
            const idx = c.indexOf(SPAWN);
            if (idx === -1) return { error: 'the executor Agent()/Task() spawn is missing' };
            const start = c.lastIndexOf('prompt="', idx);
            return { prompt: c.slice(start, c.indexOf(SPAWN, start)) };
          });
        agree('the block walker agrees with the old slice between a start marker and its closing tag', shaped(['<required_reading>\n- A', '</required_reading>'], FILLER),
          (text) => w.blockAt(text, '<required_reading>\n- A', 'x'), (text) => {
            const start = text.indexOf('<required_reading>\n- A');
            const end = start === -1 ? -1 : text.indexOf('</required_reading>', start);
            return start === -1 || end === -1 ? { error: 'the x required_reading block is missing' } : { block: text.slice(start, end) };
          });
      }

      // execute-phase-worktree-artifacts: the success_criteria block of a mode.
      {
        const w = walkersOf('execute-phase-worktree-artifacts');
        agree('the success_criteria walker agrees with the old lazy pattern', shaped(['**Worktree mode**', '<success_criteria>', '</success_criteria>'], ['a', '\n', '**Worktree mode**']),
          (text) => { const hit = w.criteriaOf(text, '**Worktree mode**'); return hit.error ? null : hit.criteria; },
          (text) => { const m = text.match(/\*\*Worktree mode\*\*[\s\S]*?<success_criteria>([\s\S]*?)<\/success_criteria>/); return m ? m[1] : null; });
      }

      // cleanup-branch-pruning: the named block and the shell statements.
      {
        const w = walkersOf('cleanup-branch-pruning');
        agree('the named block walker agrees with the old extraction', joined(['<step name="x">', '</step>', '<x>', '</x>', 'a', '\n'], 10), (text) => w.namedBlock(text, 'x'), (markdown) => {
          const openStep = '<step name="x">';
          let start = markdown.indexOf(openStep);
          if (start !== -1) {
            const end = markdown.indexOf('</step>', start + openStep.length);
            if (end !== -1) return markdown.slice(start + openStep.length, end);
          }
          const openBare = '<x>';
          start = markdown.indexOf(openBare);
          if (start === -1) return null;
          const end = markdown.indexOf('</x>', start + openBare.length);
          if (end === -1) return null;
          return markdown.slice(start + openBare.length, end);
        });
        const oldShellStatements = (script) => {
          const statements = [];
          for (const raw of script.split('\n')) {
            const line = raw.replace(/#.*$/, '').trim();
            if (!line) continue;
            for (const part of line.split(/(?:&&|\|\||;)/)) {
              let trimmed = part.trim();
              if (!trimmed) continue;
              const assignMatch = trimmed.match(/^[A-Za-z_][A-Za-z0-9_]*=(.*)$/);
              if (assignMatch) trimmed = assignMatch[1];
              const subMatch = trimmed.match(/^\$\((.*?)\)?$/);
              if (subMatch) trimmed = subMatch[1];
              if (trimmed.startsWith('$(')) trimmed = trimmed.slice(2);
              trimmed = trimmed.replace(/\)+\s*$/, '').trim();
              if (!trimmed) continue;
              statements.push(trimmed.split(/\s+/).filter(Boolean));
            }
          }
          return statements;
        };
        agree('the shell statement walker agrees with the old regex chain', joined(['git fetch --prune', 'git branch -vv', 'X=', '$(', ')', ' && ', ' || ', ';', '# c', '\n', '\r', '\u2028', '"', ' ', '\t', 'a'], 10),
          w.shellStatements, oldShellStatements);
      }

      // cleanup-branch-pruning: a sectionizer build that cannot be loaded is one finding, not a throw.
      test('a sectionizer build that cannot be loaded is one finding for the contract and a reason for the walker', (t) => {
        const contractPath = path.join(REPO_ROOT, 'scripts', 'static-checks', 'text-contracts', 'cleanup-branch-pruning.cjs');
        const reason = 'gsd-core/bin/lib/markdown-sectionizer.cjs cannot be loaded: boom';
        assert.equal(walkersOf('cleanup-branch-pruning').fencedBodies('x', () => { throw new Error('boom'); }).error, reason);
        const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gsd-b10-loader-'));
        t.after(() => cleanup(dir));
        fs.writeFileSync(path.join(dir, 'cleanup-branch-pruning.cjs'), `module.exports = require(${JSON.stringify(contractPath)}).withLoader(() => { throw new Error('boom'); });\n`);
        const findings = textContracts.run({ root: copyOfRepoFiles(t), dir, only: ['cleanup-branch-pruning'], minContracts: 1 });
        assert.equal(findings.length, 1, JSON.stringify(findings.map((f) => f.message)));
        assert.ok(findings[0].message.includes(reason), findings[0].message);
      });
    }

    // One cause is one finding: each edit below breaks one thing that several assertions of a contract depend on, and the
    // count of findings is exact (the shared cause is reported once, where two blocks are involved each is reported once).
    {
      const findsCount = (title, rel, edit, contract, count, expected) => test(title, (t) => {
        const root = copyOfRepoFiles(t);
        const abs = path.join(root, ...rel.split('/'));
        const before = fs.readFileSync(abs, 'utf8');
        const after = edit(before);
        assert.notEqual(after, before, 'the edit changed the file');
        fs.writeFileSync(abs, after);
        const findings = runShipped(root, [contract]);
        assert.equal(findings.length, count, JSON.stringify(findings.map((f) => f.message)));
        assert.ok(findings.some((f) => f.message.includes(expected)), JSON.stringify(findings.map((f) => f.message)));
      });
      const STEPS_DIR = 'gsd-core/workflows/execute-phase/steps/';
      findsCount('no executor spawn in quick.md is one finding', 'gsd-core/workflows/quick.md', swap('subagent_type="gsd-executor"', 'subagent_type="gsd-runner"'), 'quick-commit-boundary-context-research', 1, 'the executor Agent()/Task() spawn is missing');
      findsCount('no prompt= before the executor spawn is one finding', 'gsd-core/workflows/quick.md', swap('prompt="', 'prompt = "'), 'quick-commit-boundary-context-research', 1, 'there is no prompt=" before the executor spawn');
      findsCount('no closing required_reading tag is one finding per block read', 'gsd-core/workflows/quick.md', eraseAll('</required_reading>'), 'quick-commit-boundary-context-research', 2, 'required_reading block is missing');
      findsCount('no success_criteria block in either mode is one finding per mode', 'gsd-core/workflows/execute-phase.md', eraseAll('<success_criteria>'), 'execute-phase-worktree-artifacts', 2, 'no success_criteria block follows **Worktree mode**');
      findsCount('a renamed worktree mode marker is one finding', 'gsd-core/workflows/execute-phase.md', swap('**Worktree mode**', '**Worktree-mode**'), 'execute-phase-worktree-artifacts', 1, 'no success_criteria block follows **Worktree mode**');
      findsCount('a renamed sequential mode marker is one finding', 'gsd-core/workflows/execute-phase.md', swap('**Sequential mode**', '**Sequential-mode**'), 'execute-phase-worktree-artifacts', 1, 'no success_criteria block follows **Sequential mode**');
      findsCount('no probe step at all is one finding', 'gsd-core/workflows/spec-phase.md', erase(/Probe/g), 'spec-phase-probe-reachability', 1, '(found 0: )');
      findsCount('no max-rounds block is one finding', 'gsd-core/workflows/spec-phase.md', swap('If max rounds reached', 'When max rounds were reached'), 'spec-phase-probe-reachability', 1, 'no "If max rounds reached" block');
      findsCount('a removed TDD_APPLICABLE assignment in the fragment is one finding', `${STEPS_DIR}tdd-applicability-resolution.md`, swap('TDD_APPLICABLE="$TDD_APPLICABLE_RAW"', 'TDD_APPLICABLE_X="$TDD_APPLICABLE_RAW"'), 'tdd-backend-wiring', 1, 'it has no TDD_APPLICABLE assignment');
      findsCount('a removed TDD_APPLICABLE assignment in the worktree backend is one finding', `${STEPS_DIR}executor-isolation-dispatch.md`, swap('TDD_APPLICABLE="$_TDD_APPLICABLE_RAW"', 'TDD_APPLICABLE_X="$_TDD_APPLICABLE_RAW"'), 'tdd-backend-wiring', 1, 'it has no TDD_APPLICABLE assignment');
      findsCount('no phase.tdd-applicable call in the fragment is one finding', `${STEPS_DIR}tdd-applicability-resolution.md`, eraseAll('phase.tdd-applicable'), 'tdd-backend-wiring', 1, 'no phase.tdd-applicable call within eight lines');
      findsCount('no phase.tdd-applicable call in the worktree backend is one finding', `${STEPS_DIR}executor-isolation-dispatch.md`, eraseAll('phase.tdd-applicable'), 'tdd-backend-wiring', 1, 'no phase.tdd-applicable call within eight lines');
      findsCount('a missing prune_local_branches block is one finding', 'gsd-core/workflows/cleanup.md', swap('<step name="prune_local_branches">', '<step name="prune_branches">'), 'cleanup-branch-pruning', 1, 'the <prune_local_branches> block is missing');
      findsCount('a missing show_dry_run block is one finding', 'gsd-core/workflows/cleanup.md', swap('<step name="show_dry_run">', '<step name="dry_run">'), 'cleanup-branch-pruning', 1, 'the <show_dry_run> block is missing');
      findsCount('a gate that never names the normalizer helper is one finding', `${STEPS_DIR}regression-gate-run.md`, eraseAll('normalize-test-command'), 'post-merge-gate-watch-mode', 1, 'must call the shared normalize-test-command helper');
      findsCount('dropping QUICK_PLAN_COMMIT from the executor prompt is one finding', 'gsd-core/workflows/quick.md', within('Execute quick task', 'subagent_type="gsd-executor"', eraseAll('QUICK_PLAN_COMMIT')), 'quick-commit-boundary-context-research', 1, 'it names no QUICK_PLAN_COMMIT');
      findsCount('dropping git show from the executor prompt is one finding', 'gsd-core/workflows/quick.md', within('Execute quick task', 'subagent_type="gsd-executor"', eraseAll('git show')), 'quick-commit-boundary-context-research', 1, 'it has no git show of the plan commit');
      findsCount('a tdd.md line holding TDD_APPLICABLE without the conditional is one finding for the backend', 'gsd-core/workflows/execute-phase.md', swap("${TDD_APPLICABLE ? '- `~/.claude/gsd-core/references/tdd.md`'", "${TDD_APPLICABLE  ? '- `~/.claude/gsd-core/references/tdd.md`'"), 'tdd-backend-wiring', 1, 'the entry is not conditional');
      findsCount('no tdd.md entry in a backend is one finding for the backend', 'gsd-core/workflows/execute-phase.md', eraseAll('tdd.md'), 'tdd-backend-wiring', 1, 'it lists no tdd.md conditional embed entry');
      findsCount('a spec-phase.md with no transition at all is two findings: no jump, and no probe exit', 'gsd-core/workflows/spec-phase.md', erase(/\b(?:jump|proceed|continue|go|return|skip) to Step/gi), 'spec-phase-probe-reachability', 2, 'it contains no jump instructions to assert on');
      findsCount('an initialize step with no closing tag is one finding', 'gsd-core/workflows/code-review.md', eraseAll('</step>'), 'code-review-flags', 1, 'the initialize step is not closed');
    }
  }

  // A file a batch 10 contract reads that is gone from the tree is one finding for that file.
  for (const [rel, contract] of [
    ['gsd-core/workflows/next.md', 'next-safety-gates'],
    ['commands/gsd/progress.md', 'next-safety-gates'],
    ['docs/contributor-standards.md', 'contributor-standards'],
    ['CONTEXT.md', 'contributor-standards'],
    ['CONTRIBUTING.md', 'contributor-standards'],
    ['.github/workflows/auto-backmerge.yml', 'release-backmerge-invariants'],
    ['.github/workflows/release.yml', 'release-backmerge-invariants'],
    ['gsd-core/workflows/review.md', 'cursor-reviewer'],
    ['commands/gsd/review.md', 'cursor-reviewer'],
    ['gsd-core/workflows/help/modes/full.md', 'cursor-reviewer'],
    ['docs/COMMANDS.md', 'cursor-reviewer'],
    ['docs/FEATURES.md', 'cursor-reviewer'],
    ['docs/ja-JP/COMMANDS.md', 'cursor-reviewer'],
    ['docs/ja-JP/FEATURES.md', 'cursor-reviewer'],
    ['docs/ko-KR/COMMANDS.md', 'cursor-reviewer'],
    ['docs/ko-KR/FEATURES.md', 'cursor-reviewer'],
    ['gsd-core/workflows/ui-phase.md', 'ask-user-questions-fallback'],
    ['gsd-core/workflows/spec-phase.md', 'ask-user-questions-fallback'],
    ['gsd-core/workflows/ai-integration-phase.md', 'ask-user-questions-fallback'],
    ['gsd-core/workflows/eval-review.md', 'ask-user-questions-fallback'],
    ['gsd-core/workflows/ui-review.md', 'ask-user-questions-fallback'],
    ['gsd-core/references/ui-brand.md', 'next-up-clear-order'],
    ['gsd-core/references/continuation-format.md', 'next-up-clear-order'],
    ['gsd-core/workflows/resume-project.md', 'next-up-clear-order'],
    ['gsd-core/workflows/plan-phase.md', 'next-up-clear-order'],
    ['gsd-core/references/agent-skills-bootstrap.md', 'agent-skills-bootstrap'],
    ['gsd-core/references/gsd-run-resolver.md', 'agent-skills-bootstrap'],
    ['agents/gsd-planner.md', 'agent-skills-bootstrap'],
    ['gsd-core/workflows/spike.md', 'spike-manifest-scoping'],
    ['gsd-core/workflows/spike-wrap-up.md', 'spike-manifest-scoping'],
    ['gsd-core/workflows/sketch.md', 'spike-manifest-scoping'],
    ['gsd-core/references/artifact-types.md', 'spike-manifest-scoping'],
    ['gsd-core/workflows/new-milestone.md', 'seed-scan-new-milestone'],
    ['gsd-core/workflows/plant-seed.md', 'seed-scan-new-milestone'],
    ['gsd-core/references/common-bug-patterns.md', 'agent-required-reading-consistency'],
    ['agents/gsd-debugger.md', 'agent-required-reading-consistency'],
    ['agents/gsd-planner.md', 'planner-decomposition'],
    ['gsd-core/references/planner-gap-closure.md', 'planner-decomposition'],
    ['gsd-core/references/planner-revision.md', 'planner-decomposition'],
    ['gsd-core/references/planner-reviews.md', 'planner-decomposition'],
    ['gsd-core/references/planner-guidance.md', 'planner-decomposition'],
    ['gsd-core/workflows/plan-phase.md', 'planner-decomposition'],
    ['skills/gsd-mempalace-capture/SKILL.md', 'mempalace-capture-gate-default'],
    ['commands/gsd/mempalace-capture.md', 'mempalace-capture-gate-default'],
    ['skills/gsd-mempalace-recall/SKILL.md', 'mempalace-capture-gate-default'],
    ['commands/gsd/mempalace-recall.md', 'mempalace-capture-gate-default'],
    ['agents/gsd-mempalace-curator.md', 'mempalace-capture-gate-default'],
    ['agents/gsd-mempalace-curator.compact.md', 'mempalace-capture-gate-default'],
    ['agents/gsd-verifier.md', 'verifier-coincidental-reliance'],
    ['gsd-core/templates/verification-report.md', 'verifier-coincidental-reliance'],
    ['docs/reference/agents.md', 'verifier-coincidental-reliance'],
    ['gsd-core/references/verifier-phase-gates.md', 'verifier-coincidental-reliance'],
    ['gsd-core/workflows/execute-phase.md', 'execute-phase-step-5-5-deviation-doc'],
    ['commands/gsd/ultraplan-phase.md', 'ultraplan-phase'],
    ['gsd-core/workflows/ultraplan-phase.md', 'ultraplan-phase'],
    ['gsd-core/workflows/verify-work.md', 'verify-mvp-uat'],
    ['gsd-core/references/verifier-phase-gates.md', 'verify-mvp-uat'],
    ['gsd-core/workflows/review.md', 'workflow-jq-dependency'],
    ['gsd-core/workflows/plan-phase.md', 'workflow-jq-dependency'],
    ['gsd-core/workflows/ship.md', 'workflow-jq-dependency'],
    ['gsd-core/workflows/debug.md', 'workflow-jq-dependency'],
    ['gsd-core/workflows/autonomous.md', 'workflow-jq-dependency'],
    ['gsd-core/workflows/ai-integration-phase.md', 'workflow-jq-dependency'],
    ['gsd-core/workflows/eval-review.md', 'workflow-jq-dependency'],
    ['gsd-core/workflows/update.md', 'workflow-jq-dependency'],
    ['gsd-core/references/verification-overrides.md', 'verification-overrides'],
    ['agents/gsd-verifier.md', 'verification-overrides'],
    ['skills/gsd-mempalace-capture/SKILL.md', 'mempalace-capture-headless-invocation'],
    ['commands/gsd/mempalace-capture.md', 'mempalace-capture-headless-invocation'],
    ['capabilities/mempalace/fragments/capture-problems.md', 'mempalace-capture-headless-invocation'],
    ['.gitignore', 'mempalace-capture-headless-invocation'],
    ['gsd-core/references/thinking-models-debug.md', 'thinking-model-guidance'],
    ['gsd-core/references/thinking-models-execution.md', 'thinking-model-guidance'],
    ['gsd-core/references/thinking-models-planning.md', 'thinking-model-guidance'],
    ['gsd-core/references/thinking-models-research.md', 'thinking-model-guidance'],
    ['gsd-core/references/thinking-models-verification.md', 'thinking-model-guidance'],
    ['agents/gsd-debugger.md', 'thinking-model-guidance'],
    ['agents/gsd-executor.md', 'thinking-model-guidance'],
    ['agents/gsd-planner.md', 'thinking-model-guidance'],
    ['agents/gsd-phase-researcher.md', 'thinking-model-guidance'],
    ['agents/gsd-plan-checker.md', 'thinking-model-guidance'],
    ['agents/gsd-verifier.md', 'thinking-model-guidance'],
    ['gsd-core/workflows/quick/steps/worktree-pre-dispatch-commit.md', 'quick-commit-boundary-context-research'],
    ['gsd-core/workflows/quick.md', 'quick-commit-boundary-context-research'],
    ['gsd-core/workflows/spec-phase.md', 'spec-phase-probe-reachability'],
    ['gsd-core/workflows/execute-phase/steps/regression-gate-run.md', 'post-merge-gate-watch-mode'],
    ['gsd-core/workflows/execute-phase/steps/post-merge-gate.md', 'post-merge-gate-watch-mode'],
    ['gsd-core/workflows/audit-fix.md', 'post-merge-gate-watch-mode'],
    ['gsd-core/workflows/execute-phase/steps/regression-gate.md', 'post-merge-gate-watch-mode'],
    ['gsd-core/workflows/execute-phase.md', 'post-merge-gate-watch-mode'],
    ['gsd-core/workflows/execute-phase/steps/verify-phase-goal.md', 'post-merge-gate-watch-mode'],
    ['gsd-core/workflows/execute-phase.md', 'execute-phase-worktree-artifacts'],
    ['gsd-core/workflows/execute-phase/steps/worktree-recovery-policy.md', 'execute-phase-worktree-artifacts'],
    ['gsd-core/workflows/quick.md', 'execute-phase-worktree-artifacts'],
    ['gsd-core/workflows/execute-phase/steps/tdd-applicability-resolution.md', 'tdd-backend-wiring'],
    ['gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', 'tdd-backend-wiring'],
    ['gsd-core/workflows/execute-phase.md', 'tdd-backend-wiring'],
    ['gsd-core/workflows/cleanup.md', 'cleanup-branch-pruning'],
    ['gsd-core/workflows/code-review.md', 'code-review-flags'],
    ['gsd-core/workflows/code-review/steps/dispatch-fix.md', 'code-review-flags'],
  ]) {
    test(`${rel} removed from the tree is a finding for ${contract}`, (t) => {
      const root = copyOfRepoFiles(t, HEAVY.includes(rel) ? HEAVY : []);
      fs.unlinkSync(path.join(root, ...rel.split('/')));
      const findings = runShipped(root, [contract]);
      assert.ok(findings.some((f) => f.file === rel && /cannot read the file/.test(f.message)), JSON.stringify(findings));
    });
  }
});
