'use strict';

/**
 * text-contracts.batch9.test.cjs
 *
 * Detection cases for the 33 text contracts of ADR-6315 item 19 batch 9 (#6573, #6337): each contract against a
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
const SHIPPED = require('./helpers/text-contracts-batch9-ids.cjs');

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
const inStepOf = (name, edit) => within(`<step name="${name}">`, '</step>', edit);
const yamlEdit = (edit) => (text) => {
  const workflow = yaml.load(text);
  edit(workflow);
  return yaml.dump(workflow, { lineWidth: -1 });
};

describe('the batch 9 contracts hold on the real files, and fail when a contracted phrase goes', () => {
  // The files each contract reads, copied into a temporary root so one phrase can be removed.
  const FILES = [
    '.github/rulesets/main-protection.json',
    '.github/workflows/auto-backmerge.yml',
    '.github/workflows/auto-branch.yml',
    '.github/workflows/auto-close-unsolicited-prs.yml',
    '.github/workflows/auto-label-issues.yml',
    '.github/workflows/branch-cleanup.yml',
    '.github/workflows/branch-naming.yml',
    '.github/workflows/changeset-required.yml',
    '.github/workflows/ci-timeout-report.yml',
    '.github/workflows/close-draft-prs-sweep.yml',
    '.github/workflows/close-draft-prs.yml',
    '.github/workflows/default-flip-documentation.yml',
    '.github/workflows/dependabot-auto-merge.yml',
    '.github/workflows/dependabot-vendor-refresh.yml',
    '.github/workflows/discord-changelog.yml',
    '.github/workflows/dismiss-unauthorized-pr-approvals.yml',
    '.github/workflows/docs-required.yml',
    '.github/workflows/duplicate-check.yml',
    '.github/workflows/duplicate-sweep.yml',
    '.github/workflows/fix-next-rerun.yml',
    '.github/workflows/install-smoke.yml',
    '.github/workflows/mutation.yml',
    '.github/workflows/pr-mergeable-preflight.yml',
    '.github/workflows/pr-target-validator.yml',
    '.github/workflows/pr-template-format.yml',
    '.github/workflows/pr-title-validator.yml',
    '.github/workflows/release.yml',
    '.github/workflows/remove-duplicate-label.yml',
    '.github/workflows/require-issue-link.yml',
    '.github/workflows/reviewed-or-maintainer.yml',
    '.github/workflows/security-scan.yml',
    '.github/workflows/self-test-report.yml',
    '.github/workflows/stale.yml',
    '.github/workflows/test.yml',
    '.github/workflows/version-gate.yml',
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
    'commands/gsd/execute-phase.md',
    'commands/gsd/extract-learnings.md',
    'commands/gsd/phase.md',
    'commands/gsd/progress.md',
    'docs/CONFIGURATION.md',
    'docs/adr/550-spec-phase-probe-contract.md',
    'docs/ja-JP/reference/state-md.md',
    'docs/ko-KR/reference/state-md.md',
    'docs/pt-BR/reference/state-md.md',
    'docs/reference/plan-md.md',
    'docs/reference/state-md.md',
    'docs/zh-CN/reference/state-md.md',
    'gsd-core/bin/shared/config-defaults.manifest.json',
    'gsd-core/references/artifact-types.md',
    'gsd-core/references/debugger-bug-taxonomy.md',
    'gsd-core/references/debugger-fix-acceptance.md',
    'gsd-core/references/debugger-philosophy.md',
    'gsd-core/references/debugger-rca-branching.md',
    'gsd-core/references/debugger-sbfl.md',
    'gsd-core/references/edge-probe-fixtures/01-round-half-even/expected-coverage.json',
    'gsd-core/references/edge-probe-fixtures/02-merge-intervals/expected-coverage.json',
    'gsd-core/references/edge-probe-fixtures/03-truncate-graphemes/expected-coverage.json',
    'gsd-core/references/edge-probe-fixtures/04-money-rounding/expected-coverage.json',
    'gsd-core/references/edge-probe-fixtures/05-list-dedupe/expected-coverage.json',
    'gsd-core/references/edge-probe-fixtures/06-resolved-mixed/expected-coverage.json',
    'gsd-core/references/edge-probe.md',
    'gsd-core/references/executor-examples.md',
    'gsd-core/references/few-shot-examples/plan-checker.md',
    'gsd-core/references/few-shot-examples/verifier.md',
    'gsd-core/references/planner-antipatterns.md',
    'gsd-core/references/planner-gap-closure.md',
    'gsd-core/references/tdd.md',
    'gsd-core/templates/DEBUG.md',
    'gsd-core/templates/planner-subagent-prompt.md',
    'gsd-core/templates/research.md',
    'gsd-core/templates/spec.md',
    'gsd-core/workflows/add-backlog.md',
    'gsd-core/workflows/add-phase.md',
    'gsd-core/workflows/add-tests.md',
    'gsd-core/workflows/add-todo.md',
    'gsd-core/workflows/ai-integration-phase.md',
    'gsd-core/workflows/analyze-dependencies.md',
    'gsd-core/workflows/audit-fix.md',
    'gsd-core/workflows/audit-milestone.md',
    'gsd-core/workflows/audit-uat.md',
    'gsd-core/workflows/autonomous.md',
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
    'gsd-core/workflows/new-project.md',
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
    'gsd-core/workflows/plan-phase.md',
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
    'gsd-core/workflows/review.md',
    'gsd-core/workflows/review/steps/reviewer-instances-note-1.md',
    'gsd-core/workflows/review/steps/reviewer-instances-note-2.md',
    'gsd-core/workflows/scan.md',
    'gsd-core/workflows/section-manifest.json',
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
    'gsd-core/workflows/ui-phase.md',
    'gsd-core/workflows/ui-review.md',
    'gsd-core/workflows/ultraplan-phase.md',
    'gsd-core/workflows/undo.md',
    'gsd-core/workflows/update.md',
    'gsd-core/workflows/update/steps/channel-banner.md',
    'gsd-core/workflows/validate-phase.md',
    'gsd-core/workflows/verify-work.md',
    'gsd-core/workflows/verify-work/detail/elaboration.md',
    'gsd-core/workflows/verify-work/steps/automated-ui-verification.md',
    'gsd-core/workflows/verify-work/steps/mvp-uat-framing.md',
    'hooks/gsd-agent-isolation-guard.js',
    'hooks/gsd-check-update-worker.js',
    'hooks/gsd-check-update.js',
    'hooks/gsd-config-reload.js',
    'hooks/gsd-context-monitor.js',
    'hooks/gsd-cursor-post-tool.js',
    'hooks/gsd-cursor-pre-tool.js',
    'hooks/gsd-cursor-session-start.js',
    'hooks/gsd-cursor-stop.js',
    'hooks/gsd-cursor-subagent-start.js',
    'hooks/gsd-cursor-subagent-stop.js',
    'hooks/gsd-ensure-canonical-path.js',
    'hooks/gsd-path-export.js',
    'hooks/gsd-prompt-guard.js',
    'hooks/gsd-read-guard.js',
    'hooks/gsd-read-injection-scanner.js',
    'hooks/gsd-secret-read-guard.js',
    'hooks/gsd-statusline.js',
    'hooks/gsd-update-banner.js',
    'hooks/gsd-windsurf-pre-command.js',
    'hooks/gsd-windsurf-pre-write.js',
    'hooks/gsd-workflow-guard.js',
    'hooks/gsd-worktree-path-guard.js',
    'hooks/gsd-write-guard.js',
    'hooks/lib/cli-exit.js',
    'hooks/lib/config-read.js',
    'hooks/lib/cursor-workspace.js',
    'hooks/lib/dispatch-identity.js',
    'hooks/lib/exit-code-registry.js',
    'hooks/lib/filename-classification.js',
    'hooks/lib/git-cmd.js',
    'hooks/lib/git-head-tree.js',
    'hooks/lib/git-probe.js',
    'hooks/lib/hook-exit.js',
    'hooks/lib/injection-patterns.js',
    'hooks/lib/isolation-deny-reason.js',
    'hooks/lib/isolation-sentinel.js',
    'hooks/lib/secret-read-exemptions.js',
  ];

  // Files the contracts read that are too large to copy into every case; a case that needs one passes HEAVY.
  const HEAVY = [
    'CONTEXT.md',
    'docs/CONTEXT-INDEX.json',
  ];

  function copyOfRepoFiles(t, extra = []) {
    const root = tempDir(t, 'gsd-text-contracts-b9-');
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

  test('an untouched copy of the files satisfies every batch 9 contract', (t) => {
    assert.deepEqual(runShipped(copyOfRepoFiles(t, HEAVY)), []);
  });

  for (const [title, rel, edit, contract, expected] of [
        // docs-state-md-locale-parity
        ['the Status lifecycle heading renamed in the English reference', 'docs/reference/state-md.md', swap('### Status lifecycle (ADR-2207)', '### Status lifecycle'), 'docs-state-md-locale-parity', /must declare "### Status lifecycle \(ADR-2207\)"/],
        ['every heading of the English reference removed', 'docs/reference/state-md.md', (text) => text.split('\n').map((line) => (line.startsWith('#') && !line.startsWith('# Phase') && !line.startsWith('# Additional') ? 'x' : line)).join('\n'), 'docs-state-md-locale-parity', /must declare at least one heading/],
        ['the last level-3 section dropped from the ja-JP reference', 'docs/ja-JP/reference/state-md.md', (text) => { const lines = text.split('\n'); lines.splice(lines.map((line) => line.startsWith('### ')).lastIndexOf(true), 1); return lines.join('\n'); }, 'docs-state-md-locale-parity', /the ja-JP reference must keep every section.*missing "### /],
        ['the first level-2 section dropped from the ja-JP reference', 'docs/ja-JP/reference/state-md.md', (text) => { const lines = text.split('\n'); lines.splice(lines.map((line) => line.startsWith('## ')).indexOf(true), 1); return lines.join('\n'); }, 'docs-state-md-locale-parity', /the ja-JP reference must keep every section.*missing "## /],
        ['the last level-3 section dropped from the zh-CN reference', 'docs/zh-CN/reference/state-md.md', (text) => { const lines = text.split('\n'); lines.splice(lines.map((line) => line.startsWith('### ')).lastIndexOf(true), 1); return lines.join('\n'); }, 'docs-state-md-locale-parity', /the zh-CN reference must keep every section.*missing "### /],
        ['the first level-2 section dropped from the zh-CN reference', 'docs/zh-CN/reference/state-md.md', (text) => { const lines = text.split('\n'); lines.splice(lines.map((line) => line.startsWith('## ')).indexOf(true), 1); return lines.join('\n'); }, 'docs-state-md-locale-parity', /the zh-CN reference must keep every section.*missing "## /],
        ['the last level-3 section dropped from the ko-KR reference', 'docs/ko-KR/reference/state-md.md', (text) => { const lines = text.split('\n'); lines.splice(lines.map((line) => line.startsWith('### ')).lastIndexOf(true), 1); return lines.join('\n'); }, 'docs-state-md-locale-parity', /the ko-KR reference must keep every section.*missing "### /],
        ['the first level-2 section dropped from the ko-KR reference', 'docs/ko-KR/reference/state-md.md', (text) => { const lines = text.split('\n'); lines.splice(lines.map((line) => line.startsWith('## ')).indexOf(true), 1); return lines.join('\n'); }, 'docs-state-md-locale-parity', /the ko-KR reference must keep every section.*missing "## /],
        ['the last level-3 section dropped from the pt-BR reference', 'docs/pt-BR/reference/state-md.md', (text) => { const lines = text.split('\n'); lines.splice(lines.map((line) => line.startsWith('### ')).lastIndexOf(true), 1); return lines.join('\n'); }, 'docs-state-md-locale-parity', /the pt-BR reference must keep every section.*missing "### /],
        ['the first level-2 section dropped from the pt-BR reference', 'docs/pt-BR/reference/state-md.md', (text) => { const lines = text.split('\n'); lines.splice(lines.map((line) => line.startsWith('## ')).indexOf(true), 1); return lines.join('\n'); }, 'docs-state-md-locale-parity', /the pt-BR reference must keep every section.*missing "## /],
        // spawn-liveness-banner
        ['a diamond spawn line without the liveness phrase', 'gsd-core/workflows/audit-fix.md', append('\u25c6 Spawning the planner...'), 'spawn-liveness-banner', /every diamond spawn announcement line must carry the liveness phrase/],
        ['a diamond line naming the word spawn', 'gsd-core/workflows/audit-fix.md', append('\u25c6 Time to spawn the planner'), 'spawn-liveness-banner', /every diamond spawn announcement line must carry the liveness phrase/],
        ['a diamond line with the word spawn after a second diamond', 'gsd-core/workflows/audit-fix.md', append('\u25c6 Ready \u25c6 spawn the planner'), 'spawn-liveness-banner', /every diamond spawn announcement line must carry the liveness phrase/],
        ['a step fragment of a workflow with a diamond spawn line without the phrase', 'gsd-core/workflows/quick-batch/steps/batch-init.md', append('\u25c6 Spawning the batch planner...'), 'spawn-liveness-banner', /every diamond spawn announcement line must carry the liveness phrase/],
        ['the liveness phrase removed from a host workflow that names subagent_type', 'gsd-core/workflows/audit-fix.md', eraseAll('runs in a subagent'), 'spawn-liveness-banner', /never the liveness phrase/],
        ['the liveness phrase removed from a second host workflow', 'gsd-core/workflows/ship.md', eraseAll('runs in a subagent'), 'spawn-liveness-banner', /never the liveness phrase/],
        // model-routing-spawn-threading
        ['the analyzer model resolve gone from discuss-phase-assumptions', 'gsd-core/workflows/discuss-phase-assumptions.md', eraseAll('resolve-model gsd-assumptions-analyzer'), 'model-routing-spawn-threading', /discuss-phase-assumptions\.md must resolve the routed model/],
        ['the analyzer spawn no longer threading ANALYZER_MODEL', 'gsd-core/workflows/discuss-phase-assumptions.md', swap('model="{ANALYZER_MODEL}"', 'model="{OTHER_MODEL}"'), 'model-routing-spawn-threading', /must thread the resolved model="\{ANALYZER_MODEL\}"/],
        ['the reviewer model resolve gone from code-review', 'gsd-core/workflows/code-review.md', eraseAll('resolve-model gsd-code-reviewer'), 'model-routing-spawn-threading', /code-review\.md must resolve the routed model/],
        ['the reviewer spawn of code-review no longer threading REVIEWER_MODEL', 'gsd-core/workflows/code-review.md', swap('model="{REVIEWER_MODEL}"', 'model="{OTHER_MODEL}"'), 'model-routing-spawn-threading', /gsd-code-reviewer spawn of code-review\.md must thread model="\{REVIEWER_MODEL\}"/],
        ['the reviewer model resolve gone from code-review-fix', 'gsd-core/workflows/code-review-fix.md', eraseAll('resolve-model gsd-code-reviewer'), 'model-routing-spawn-threading', /the code-review-fix\.md re-review must resolve the routed model/],
        ['the re-review spawn of code-review-fix no longer threading REVIEWER_MODEL', 'gsd-core/workflows/code-review-fix.md', swap('model="{REVIEWER_MODEL}"', 'model="{OTHER_MODEL}"'), 'model-routing-spawn-threading', /re-review spawn of code-review-fix\.md must thread model="\{REVIEWER_MODEL\}"/],
        ['the fixer model resolve gone from code-review-fix', 'gsd-core/workflows/code-review-fix.md', eraseAll('resolve-model gsd-code-fixer'), 'model-routing-spawn-threading', /code-review-fix\.md must resolve the fixer model/],
        ['one of the two fixer spawns no longer threading FIXER_MODEL', 'gsd-core/workflows/code-review-fix.md', (text) => text.replace('subagent_type="gsd-code-fixer", model="{FIXER_MODEL}"', 'subagent_type="gsd-code-fixer", model="{OTHER_MODEL}"'), 'model-routing-spawn-threading', /both gsd-code-fixer spawns of code-review-fix\.md must thread FIXER_MODEL.*found 1/],
        ['a third fixer spawn threading FIXER_MODEL', 'gsd-core/workflows/code-review-fix.md', append('Agent(subagent_type="gsd-code-fixer", model="{FIXER_MODEL}", prompt="x")'), 'model-routing-spawn-threading', /both gsd-code-fixer spawns of code-review-fix\.md must thread FIXER_MODEL.*found 3/],
        ['both fixer spawns no longer threading FIXER_MODEL', 'gsd-core/workflows/code-review-fix.md', swap('subagent_type="gsd-code-fixer", model="{FIXER_MODEL}"', 'subagent_type="gsd-code-fixer", model="{OTHER_MODEL}"'), 'model-routing-spawn-threading', /both gsd-code-fixer spawns of code-review-fix\.md must thread FIXER_MODEL.*found 0/],
        ['the quick reviewer spawn no longer threading reviewer_model', 'gsd-core/workflows/quick.md', swap('model="{reviewer_model}"', 'model="{other_model}"'), 'model-routing-spawn-threading', /must thread the reviewer's own model="\{reviewer_model\}"/],
        ['the quick reviewer spawn reusing executor_model', 'gsd-core/workflows/quick.md', swap('model="{reviewer_model}"', 'model="{executor_model}"'), 'model-routing-spawn-threading', /the reviewer reuses executor_model/],
        ['the quick reviewer model on the same line as the subagent type', 'gsd-core/workflows/quick.md', (text) => text.replace(/(subagent_type="gsd-code-reviewer"),\s*\n\s*(model="\{reviewer_model\}")/, '$1, $2'), 'model-routing-spawn-threading', /must thread the reviewer's own model="\{reviewer_model\}"/],
        ['a routed reviewer spawn without a model param in a workflow', 'gsd-core/workflows/quick.md', append('Agent(subagent_type="gsd-code-reviewer", prompt="x")'), 'model-routing-spawn-threading', /gsd-code-reviewer spawn missing model=/],
        ['a routed analyzer spawn without a model param in a workflow', 'gsd-core/workflows/quick.md', append('Agent(subagent_type="gsd-assumptions-analyzer", prompt="x")'), 'model-routing-spawn-threading', /gsd-assumptions-analyzer spawn missing model=/],
        ['a routed fixer spawn without a model param in a workflow', 'gsd-core/workflows/quick.md', append('Agent(subagent_type="gsd-code-fixer", prompt="x")'), 'model-routing-spawn-threading', /gsd-code-fixer spawn missing model=/],
        ['a routed spawn whose only model-like param is a longer name', 'gsd-core/workflows/quick.md', append('Agent(subagent_type="gsd-code-fixer", xmodel="{M}", prompt="x")'), 'model-routing-spawn-threading', /gsd-code-fixer spawn missing model=/],
        ['a routed spawn whose prompt mentions model= inside the quotes of a following call', 'gsd-core/workflows/quick.md', append('Agent(subagent_type="gsd-code-fixer", prompt="x")\nAgent(subagent_type="other", model="{M}")'), 'model-routing-spawn-threading', /gsd-code-fixer spawn missing model=/],
        // context-enrichment
        ['CONTEXT_WINDOW gone from execute-phase', 'gsd-core/workflows/execute-phase.md', eraseAll('CONTEXT_WINDOW'), 'context-enrichment', /execute-phase\.md should reference the CONTEXT_WINDOW variable/],
        ['the context_window config read gone from execute-phase', 'gsd-core/workflows/execute-phase.md', eraseAll('config-get context_window'), 'context-enrichment', /execute-phase\.md should read context_window via config-get/],
        ['the 200000 default gone from execute-phase', 'gsd-core/workflows/execute-phase.md', eraseAll('|| echo "200000"'), 'context-enrichment', /execute-phase\.md should default CONTEXT_WINDOW to 200000/],
        ['the 500000 gate changed in execute-phase', 'gsd-core/workflows/execute-phase.md', swap('CONTEXT_WINDOW >= 500000', 'CONTEXT_WINDOW > 500000'), 'context-enrichment', /execute-phase\.md should gate enrichment on CONTEXT_WINDOW >= 500000/],
        ['prior_wave_summaries gone from execute-phase', 'gsd-core/workflows/execute-phase.md', eraseAll('prior_wave_summaries'), 'context-enrichment', /include prior_wave_summaries in the enrichment block/],
        ['CONTEXT.md gone from execute-phase', 'gsd-core/workflows/execute-phase.md', eraseAll('CONTEXT.md'), 'context-enrichment', /execute-phase\.md should reference CONTEXT\.md in the conditional enrichment/],
        ['RESEARCH.md gone from execute-phase', 'gsd-core/workflows/execute-phase.md', eraseAll('RESEARCH.md'), 'context-enrichment', /execute-phase\.md should reference RESEARCH\.md in the conditional enrichment/],
        ['CONTEXT.md gone from the executor enrichment block only', 'gsd-core/workflows/execute-phase.md', (text) => { const at = text.indexOf('CONTEXT_WINDOW >= 500000'); return text.slice(0, at) + text.slice(at, at + 500).split('CONTEXT.md').join('X') + text.slice(at + 500); }, 'context-enrichment', /the executor enrichment block should include CONTEXT\.md/],
        ['RESEARCH.md gone from the executor enrichment block only', 'gsd-core/workflows/execute-phase.md', (text) => { const at = text.indexOf('CONTEXT_WINDOW >= 500000'); return text.slice(0, at) + text.slice(at, at + 500).split('RESEARCH.md').join('X') + text.slice(at + 500); }, 'context-enrichment', /the executor enrichment block should include RESEARCH\.md/],
        ['the required_reading opening tag renamed in the verifier step', 'gsd-core/workflows/execute-phase/steps/verify-phase-goal.md', swap('<required_reading>', '<required_read>'), 'context-enrichment', /should contain the <required_reading> opening tag/],
        ['the required_reading closing tag renamed in the verifier step', 'gsd-core/workflows/execute-phase/steps/verify-phase-goal.md', swap('</required_reading>', '</required_read>'), 'context-enrichment', /should contain the <\/required_reading> closing tag/],
        ['PLAN.md gone from the last required_reading block of the verifier step', 'gsd-core/workflows/execute-phase/steps/verify-phase-goal.md', (text) => { const at = text.lastIndexOf('<required_reading>'); return text.slice(0, at) + text.slice(at).split('PLAN.md').join('X'); }, 'context-enrichment', /the verifier files_to_read should reference PLAN\.md/],
        ['SUMMARY.md gone from the last required_reading block of the verifier step', 'gsd-core/workflows/execute-phase/steps/verify-phase-goal.md', (text) => { const at = text.lastIndexOf('<required_reading>'); return text.slice(0, at) + text.slice(at).split('SUMMARY.md').join('X'); }, 'context-enrichment', /the verifier files_to_read should reference SUMMARY\.md/],
        ['requirements_path gone from the last required_reading block of the verifier step', 'gsd-core/workflows/execute-phase/steps/verify-phase-goal.md', (text) => { const at = text.lastIndexOf('<required_reading>'); return text.slice(0, at) + text.slice(at).split('{requirements_path}').join('X'); }, 'context-enrichment', /the verifier files_to_read should reference the REQUIREMENTS\.md path/],
        ['CONTEXT_WINDOW gone from plan-phase', 'gsd-core/workflows/plan-phase.md', eraseAll('CONTEXT_WINDOW'), 'context-enrichment', /plan-phase\.md should reference the CONTEXT_WINDOW variable/],
        ['the context_window config read gone from plan-phase', 'gsd-core/workflows/plan-phase.md', eraseAll('config-get context_window'), 'context-enrichment', /plan-phase\.md should read context_window via config-get/],
        ['the 500000 gate changed in plan-phase', 'gsd-core/workflows/plan-phase.md', swap('CONTEXT_WINDOW >= 500000', 'CONTEXT_WINDOW > 500000'), 'context-enrichment', /plan-phase\.md should gate cross-phase context on CONTEXT_WINDOW >= 500000/],
        ['CONTEXT.md gone from plan-phase', 'gsd-core/workflows/plan-phase.md', eraseAll('CONTEXT.md'), 'context-enrichment', /plan-phase\.md should reference CONTEXT\.md in the cross-phase enrichment/],
        ['cross-phase gone from plan-phase', 'gsd-core/workflows/plan-phase.md', (text) => text.split('cross-phase').join('x').split('Cross-phase').join('x'), 'context-enrichment', /plan-phase\.md should mention cross-phase context/],
        ['SUMMARY.md gone from plan-phase', 'gsd-core/workflows/plan-phase.md', eraseAll('SUMMARY.md'), 'context-enrichment', /plan-phase\.md should reference prior SUMMARY\.md files/],
        ['the 200000 default gone from plan-phase', 'gsd-core/workflows/plan-phase.md', eraseAll('|| echo "200000"'), 'context-enrichment', /plan-phase\.md should default CONTEXT_WINDOW to 200000/],
        // kimi-guard-typed-payload-reads
        ['the payload path-field read gone from gsd-prompt-guard.js', 'hooks/gsd-prompt-guard.js', (text) => text.replace(/(tool_input|tool_info|toolInfo)\s*\??\./g, 'x.'), 'kimi-guard-typed-payload-reads', /gsd-prompt-guard\.js must still match the path-field read pattern/],
        ['the payload path-field read gone from gsd-read-guard.js', 'hooks/gsd-read-guard.js', (text) => text.replace(/(tool_input|tool_info|toolInfo)\s*\??\./g, 'x.'), 'kimi-guard-typed-payload-reads', /gsd-read-guard\.js must still match the path-field read pattern/],
        ['the payload path-field read gone from gsd-read-injection-scanner.js', 'hooks/gsd-read-injection-scanner.js', (text) => text.replace(/(tool_input|tool_info|toolInfo)\s*\??\./g, 'x.'), 'kimi-guard-typed-payload-reads', /gsd-read-injection-scanner\.js must still match the path-field read pattern/],
        ['the payload path-field read gone from gsd-secret-read-guard.js', 'hooks/gsd-secret-read-guard.js', (text) => text.replace(/(tool_input|tool_info|toolInfo)\s*\??\./g, 'x.'), 'kimi-guard-typed-payload-reads', /gsd-secret-read-guard\.js must still match the path-field read pattern/],
        ['the payload path-field read gone from gsd-windsurf-pre-write.js', 'hooks/gsd-windsurf-pre-write.js', (text) => text.replace(/(tool_input|tool_info|toolInfo)\s*\??\./g, 'x.'), 'kimi-guard-typed-payload-reads', /gsd-windsurf-pre-write\.js must still match the path-field read pattern/],
        ['the payload path-field read gone from gsd-workflow-guard.js', 'hooks/gsd-workflow-guard.js', (text) => text.replace(/(tool_input|tool_info|toolInfo)\s*\??\./g, 'x.'), 'kimi-guard-typed-payload-reads', /gsd-workflow-guard\.js must still match the path-field read pattern/],
        ['the payload path-field read gone from gsd-worktree-path-guard.js', 'hooks/gsd-worktree-path-guard.js', (text) => text.replace(/(tool_input|tool_info|toolInfo)\s*\??\./g, 'x.'), 'kimi-guard-typed-payload-reads', /gsd-worktree-path-guard\.js must still match the path-field read pattern/],
        ['an untyped file_path read', 'hooks/gsd-prompt-guard.js', append('const leaked = payload.tool_input.file_path;'), 'kimi-guard-typed-payload-reads', /must not read a model-supplied payload path field without a typeof string test/],
        ['an untyped path read through optional chaining', 'hooks/gsd-prompt-guard.js', append('const leaked = payload.tool_info?.path;'), 'kimi-guard-typed-payload-reads', /must not read a model-supplied payload path field/],
        ['an untyped read through the camel-case container', 'hooks/gsd-prompt-guard.js', append('const leaked = payload.toolInfo.file_path;'), 'kimi-guard-typed-payload-reads', /must not read a model-supplied payload path field/],
        ['an untyped read with whitespace around the dot', 'hooks/gsd-prompt-guard.js', append('const leaked = payload.tool_input  .  file_path;'), 'kimi-guard-typed-payload-reads', /must not read a model-supplied payload path field/],
        ['an untyped read in the last statement with no semicolon', 'hooks/gsd-prompt-guard.js', append('const leaked = payload.tool_input.path'), 'kimi-guard-typed-payload-reads', /must not read a model-supplied payload path field/],
        ['a typeof test in a different statement than the read', 'hooks/gsd-prompt-guard.js', append('const kind = typeof payload;\nconst leaked = payload.tool_input.file_path;'), 'kimi-guard-typed-payload-reads', /must not read a model-supplied payload path field/],
        // debug-manager-blocking-spawn
        ['full variant: the debugger spawn made non-blocking', 'agents/gsd-debug-session-manager.md', (text) => text.replace('run_in_background=false', 'run_in_background=true'), 'debug-manager-blocking-spawn', /full variant: the debugger spawn must be blocking/],
        ['full variant: the flag removed from the debugger spawn', 'agents/gsd-debug-session-manager.md', (text) => text.replace(/^ +run_in_background=false\n/m, ''), 'debug-manager-blocking-spawn', /full variant must declare the run_in_background flag at all/],
        ['full variant: the flag removed means the spawn is not blocking', 'agents/gsd-debug-session-manager.md', (text) => text.replace(/^ +run_in_background=false\n/m, ''), 'debug-manager-blocking-spawn', /full variant: the debugger spawn must be blocking/],
        ['full variant: a second debugger spawn block', 'agents/gsd-debug-session-manager.md', append('Agent(\n  subagent_type="gsd-debugger",\n  run_in_background=false\n)'), 'debug-manager-blocking-spawn', /full variant: expected exactly one gsd-debugger spawn block/],
        ['full variant: a second spawn literal of another agent', 'agents/gsd-debug-session-manager.md', append('Agent(\n  subagent_type="gsd-planner",\n  run_in_background=false\n)'), 'debug-manager-blocking-spawn', /full variant: exactly one Agent\(\) spawn literal may exist/],
        ['full variant: a one-line second spawn literal', 'agents/gsd-debug-session-manager.md', append('Agent(subagent_type="gsd-planner")'), 'debug-manager-blocking-spawn', /full variant: exactly one Agent\(\) spawn literal may exist/],
        ['full variant: the Step 2 format reference gone', 'agents/gsd-debug-session-manager.md', eraseAll('Step 2 format'), 'debug-manager-blocking-spawn', /full variant: at least one continuation site must still name Step 2/],
        ['full variant: the no-Bash rule heading gone', 'agents/gsd-debug-session-manager.md', eraseAll('Never spawn the debugger through Bash'), 'debug-manager-blocking-spawn', /full variant: the rule heading must stay/],
        ['full variant: the forbidden shape gone', 'agents/gsd-debug-session-manager.md', eraseAll('claude --agent gsd-debugger'), 'debug-manager-blocking-spawn', /full variant: the rule must name the forbidden shape/],
        ['full variant: the shell-spawn instruction gone', 'agents/gsd-debug-session-manager.md', eraseAll('do not improvise a shell spawn'), 'debug-manager-blocking-spawn', /full variant: the rule must say what to do when Agent fails/],
        ['compact variant: the debugger spawn made non-blocking', 'agents/gsd-debug-session-manager.compact.md', (text) => text.replace('run_in_background=false', 'run_in_background=true'), 'debug-manager-blocking-spawn', /compact variant: the debugger spawn must be blocking/],
        ['compact variant: the flag removed from the debugger spawn', 'agents/gsd-debug-session-manager.compact.md', (text) => text.replace(/^ +run_in_background=false\n/m, ''), 'debug-manager-blocking-spawn', /compact variant must declare the run_in_background flag at all/],
        ['compact variant: the flag removed means the spawn is not blocking', 'agents/gsd-debug-session-manager.compact.md', (text) => text.replace(/^ +run_in_background=false\n/m, ''), 'debug-manager-blocking-spawn', /compact variant: the debugger spawn must be blocking/],
        ['compact variant: a second debugger spawn block', 'agents/gsd-debug-session-manager.compact.md', append('Agent(\n  subagent_type="gsd-debugger",\n  run_in_background=false\n)'), 'debug-manager-blocking-spawn', /compact variant: expected exactly one gsd-debugger spawn block/],
        ['compact variant: a second spawn literal of another agent', 'agents/gsd-debug-session-manager.compact.md', append('Agent(\n  subagent_type="gsd-planner",\n  run_in_background=false\n)'), 'debug-manager-blocking-spawn', /compact variant: exactly one Agent\(\) spawn literal may exist/],
        ['compact variant: a one-line second spawn literal', 'agents/gsd-debug-session-manager.compact.md', append('Agent(subagent_type="gsd-planner")'), 'debug-manager-blocking-spawn', /compact variant: exactly one Agent\(\) spawn literal may exist/],
        ['compact variant: the Step 2 format reference gone', 'agents/gsd-debug-session-manager.compact.md', eraseAll('Step 2 format'), 'debug-manager-blocking-spawn', /compact variant: at least one continuation site must still name Step 2/],
        ['compact variant: the no-Bash rule heading gone', 'agents/gsd-debug-session-manager.compact.md', eraseAll('Never spawn the debugger through Bash'), 'debug-manager-blocking-spawn', /compact variant: the rule heading must stay/],
        ['compact variant: the forbidden shape gone', 'agents/gsd-debug-session-manager.compact.md', eraseAll('claude --agent gsd-debugger'), 'debug-manager-blocking-spawn', /compact variant: the rule must name the forbidden shape/],
        ['compact variant: the shell-spawn instruction gone', 'agents/gsd-debug-session-manager.compact.md', eraseAll('do not improvise a shell spawn'), 'debug-manager-blocking-spawn', /compact variant: the rule must say what to do when Agent fails/],
        ['the full variant spawning non-blocking while the compact variant blocks', 'agents/gsd-debug-session-manager.md', (text) => text.replace('run_in_background=false', 'run_in_background=true'), 'debug-manager-blocking-spawn', /the compact sibling must not diverge from the canonical agent on spawn semantics/],
        ['the compact variant spawning non-blocking while the full variant blocks', 'agents/gsd-debug-session-manager.compact.md', (text) => text.replace('run_in_background=false', 'run_in_background=true'), 'debug-manager-blocking-spawn', /the compact sibling must not diverge from the canonical agent on spawn semantics/],
        ['the non-terminal marker gone from the manager', 'agents/gsd-debug-session-manager.md', swap('## CONTINUE_REQUIRED', '## CONTINUE_NEEDED'), 'debug-manager-blocking-spawn', /the non-terminal marker must remain/],
        ['the terminal marker gone from the manager', 'agents/gsd-debug-session-manager.md', swap('## DEBUG SESSION COMPLETE', '## DEBUG DONE'), 'debug-manager-blocking-spawn', /the terminal marker must remain/],
        ['the abandoned disposition gone from the manager', 'agents/gsd-debug-session-manager.md', eraseAll('ABANDONED'), 'debug-manager-blocking-spawn', /the abandoned disposition must remain/],
        ['the blocking-hop mandate phrase gone from debug.md', 'gsd-core/workflows/debug.md', swap('Claude Code backgrounds subagents by default', 'Claude Code may background subagents'), 'debug-manager-blocking-spawn', /debug\.md must keep the #2196 mandate that the session-manager spawn blocks/],
        ['the blocking-hop mandate flag made true in debug.md', 'gsd-core/workflows/debug.md', swap('run_in_background: false`', 'run_in_background: true`'), 'debug-manager-blocking-spawn', /debug\.md must keep the #2196 mandate/],
        ['the blocking-hop mandate dash changed in debug.md', 'gsd-core/workflows/debug.md', swap('\u2014 Claude Code backgrounds', '- Claude Code backgrounds'), 'debug-manager-blocking-spawn', /debug\.md must keep the #2196 mandate/],
        ['an agent file with a one-line spawn that never states run_in_background', 'agents/gsd-executor.md', append('Agent(subagent_type="gsd-planner")'), 'debug-manager-blocking-spawn', /an agent that spawns a subagent must decide whether that spawn blocks/],
        ['an agent file with a multi-line spawn that never states run_in_background', 'agents/gsd-executor.md', append('Agent(\n  subagent_type="gsd-planner",\n  prompt="x"\n)'), 'debug-manager-blocking-spawn', /an agent that spawns a subagent must decide whether that spawn blocks/],
        ['an agent file whose spawn states run_in_background with a value that is neither true nor false', 'agents/gsd-executor.md', append('Agent(subagent_type="gsd-planner", run_in_background=maybe)'), 'debug-manager-blocking-spawn', /an agent that spawns a subagent must decide whether that spawn blocks/],
        // debugger-bug-taxonomy
        ['the @-include of the taxonomy gone from the debugger agent', 'agents/gsd-debugger.md', eraseAll('@~/.claude/gsd-core/references/debugger-bug-taxonomy.md'), 'debugger-bug-taxonomy', /gsd-debugger\.md must @-include the bug-taxonomy reference/],
        ['bug_class gone from the DEBUG template', 'gsd-core/templates/DEBUG.md', eraseAll('bug_class'), 'debugger-bug-taxonomy', /the DEBUG\.md Current Focus must carry a bug_class field/],
        ['Bohrbug gone from the reference', 'gsd-core/references/debugger-bug-taxonomy.md', erase(/bohrbug/gi), 'debugger-bug-taxonomy', /the reference must define the class Bohrbug/],
        ['Heisenbug and Mandelbug gone from the reference', 'gsd-core/references/debugger-bug-taxonomy.md', erase(/heisenbug|mandelbug/gi), 'debugger-bug-taxonomy', /the reference must define the class Heisenbug\/Mandelbug/],
        ['Concurrency gone from the reference', 'gsd-core/references/debugger-bug-taxonomy.md', erase(/concurrency/gi), 'debugger-bug-taxonomy', /the reference must define the class Concurrency/],
        ['route and routing gone from the reference', 'gsd-core/references/debugger-bug-taxonomy.md', erase(/rout/gi), 'debugger-bug-taxonomy', /the word route\/routing must appear/],
        ['every pipe gone from the reference', 'gsd-core/references/debugger-bug-taxonomy.md', swap('|', '/'), 'debugger-bug-taxonomy', /there must be a markdown table/],
        ['the class rows gone from the routing table', 'gsd-core/references/debugger-bug-taxonomy.md', (text) => text.split('\n').filter((line) => !line.startsWith('| **')).join('\n'), 'debugger-bug-taxonomy', /the routing table must have at least 3 class rows/],
        ['reproduction gone from the Bohrbug row', 'gsd-core/references/debugger-bug-taxonomy.md', swap('deterministic reproduction', 'deterministic repro'), 'debugger-bug-taxonomy', /the Bohrbug row must include reproduction/],
        ['SBFL gone from the Bohrbug row', 'gsd-core/references/debugger-bug-taxonomy.md', swap('**SBFL (Phase 1.25)**', '**spectrum (Phase 1.25)**'), 'debugger-bug-taxonomy', /the Bohrbug row must include SBFL/],
        ['bisect gone from the Bohrbug row', 'gsd-core/references/debugger-bug-taxonomy.md', swap('git bisect', 'git search'), 'debugger-bug-taxonomy', /the Bohrbug row must include git bisect/],
        ['record-replay and stability-stress gone from the Heisenbug row', 'gsd-core/references/debugger-bug-taxonomy.md', swap('record-replay (`rr`) \u2192 stability-stress \u2192 ', ''), 'debugger-bug-taxonomy', /the Heisenbug row must include record-replay \(rr\) and\/or stability-stress/],
        ['SBFL gone from the Heisenbug row', 'gsd-core/references/debugger-bug-taxonomy.md', (text) => text.split('\n').map((line) => (line.startsWith('| **Heisenbug') ? line.split('**SBFL**').join('**spectrum**') : line)).join('\n'), 'debugger-bug-taxonomy', /the Heisenbug row must reference SBFL/],
        ['the revoke wording gone from the Heisenbug row', 'gsd-core/references/debugger-bug-taxonomy.md', (text) => text.split('\n').map((line) => (line.startsWith('| **Heisenbug') ? line.replace(/revok|revocat/gi, 'drop') : line)).join('\n'), 'debugger-bug-taxonomy', /the Heisenbug row must state SBFL is REVOKED/],
        ['atomicity gone from the Concurrency row', 'gsd-core/references/debugger-bug-taxonomy.md', swap('atomicity / order / deadlock', 'order / deadlock'), 'debugger-bug-taxonomy', /the Concurrency row must include atomicity/],
        ['order gone from the Concurrency row', 'gsd-core/references/debugger-bug-taxonomy.md', swap('atomicity / order / deadlock', 'atomicity / deadlock'), 'debugger-bug-taxonomy', /the Concurrency row must include order/],
        ['order only a substring of another word in the Concurrency row', 'gsd-core/references/debugger-bug-taxonomy.md', swap('atomicity / order / deadlock', 'atomicity / border / deadlock'), 'debugger-bug-taxonomy', /the Concurrency row must include order/],
        ['deadlock gone from the Concurrency row', 'gsd-core/references/debugger-bug-taxonomy.md', swap('atomicity / order / deadlock', 'atomicity / order'), 'debugger-bug-taxonomy', /the Concurrency row must include deadlock/],
        ['the technique "rubber duck" gone from the reference', 'gsd-core/references/debugger-bug-taxonomy.md', erase(/rubber duck/gi), 'debugger-bug-taxonomy', /the technique "rubber duck" must appear in the bug-taxonomy reference/],
        ['the technique "delta debugging" gone from the reference', 'gsd-core/references/debugger-bug-taxonomy.md', erase(/delta debugging/gi), 'debugger-bug-taxonomy', /the technique "delta debugging" must appear in the bug-taxonomy reference/],
        ['the technique "working backwards" gone from the reference', 'gsd-core/references/debugger-bug-taxonomy.md', erase(/working backwards/gi), 'debugger-bug-taxonomy', /the technique "working backwards" must appear in the bug-taxonomy reference/],
        ['the technique "differential" gone from the reference', 'gsd-core/references/debugger-bug-taxonomy.md', erase(/differential/gi), 'debugger-bug-taxonomy', /the technique "differential" must appear in the bug-taxonomy reference/],
        ['the technique "comment out everything" gone from the reference', 'gsd-core/references/debugger-bug-taxonomy.md', erase(/comment out everything/gi), 'debugger-bug-taxonomy', /the technique "comment out everything" must appear in the bug-taxonomy reference/],
        ['the technique "follow the indirection" gone from the reference', 'gsd-core/references/debugger-bug-taxonomy.md', erase(/follow the indirection/gi), 'debugger-bug-taxonomy', /the technique "follow the indirection" must appear in the bug-taxonomy reference/],
        ['every replace, supersede and not-append wording gone from the reference', 'gsd-core/references/debugger-bug-taxonomy.md', (text) => text.replace(/replace|supersede|routed? selection/gi, 'x').replace(/append/gi, 'y'), 'debugger-bug-taxonomy', /the reference must state the flat menu is replaced or superseded/],
        // debugger-sbfl
        ['the @-include of the SBFL reference gone from the debugger agent', 'agents/gsd-debugger.md', eraseAll('@~/.claude/gsd-core/references/debugger-sbfl.md'), 'debugger-sbfl', /gsd-debugger\.md must @-include the SBFL reference/],
        ['Ochiai gone from the reference', 'gsd-core/references/debugger-sbfl.md', erase(/ochiai/gi), 'debugger-sbfl', /the reference must name the Ochiai formula/],
        ['sqrt gone from the reference', 'gsd-core/references/debugger-sbfl.md', erase(/sqrt/gi), 'debugger-sbfl', /the reference must document the sqrt-based formula/],
        ['failed gone from the reference', 'gsd-core/references/debugger-sbfl.md', erase(/failed/gi), 'debugger-sbfl', /the reference must reference the failed\(s\) term/],
        ['passed gone from the reference', 'gsd-core/references/debugger-sbfl.md', erase(/passed/gi), 'debugger-sbfl', /the reference must reference the passed\(s\) term/],
        ['Tarantula gone from the reference', 'gsd-core/references/debugger-sbfl.md', erase(/tarantula/gi), 'debugger-sbfl', /the reference must mention Tarantula as a documented fallback/],
        ['top-N gone from the reference', 'gsd-core/references/debugger-sbfl.md', erase(/top-?n/gi), 'debugger-sbfl', /the reference must document top-N shortlist seeding/],
        ['every no-coverage wording gone from the reference', 'gsd-core/references/debugger-sbfl.md', erase(/no coverage|no test suite|coverage (?:is )?(?:absent|unavailable)/gi), 'debugger-sbfl', /the reference must document the no-coverage skip path/],
        ['every log and note wording gone from the reference', 'gsd-core/references/debugger-sbfl.md', (text) => text.replace(/log/gi, 'x').replace(/note/gi, 'y'), 'debugger-sbfl', /a skip must be logged/],
        ['every skip wording gone from the reference', 'gsd-core/references/debugger-sbfl.md', (text) => text.replace(/skip/gi, 'x'), 'debugger-sbfl', /a skip must be logged/],
        ['Evidence gone from the reference', 'gsd-core/references/debugger-sbfl.md', erase(/evidence/gi), 'debugger-sbfl', /the reference must document that the ranking lands in the Evidence section/],
        ['every determinism wording gone from the reference', 'gsd-core/references/debugger-sbfl.md', erase(/bohrbug|deterministic|flaky|heisenbug|mandelbug/gi), 'debugger-sbfl', /the reference must note SBFL suits deterministic bugs/],
        // release-shard-lane-sharding
        ['rc: a numerator missing from the shard set', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['rc-test'].strategy.matrix.shard = ['1/3', '2/3']; }), 'release-shard-lane-sharding', /are not a complete set/],
        ['rc: a duplicated numerator in the shard set', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['rc-test'].strategy.matrix.shard = ['1/3', '2/3', '2/3']; }), 'release-shard-lane-sharding', /are not a complete set/],
        ['rc: mixed denominators in the shard set', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['rc-test'].strategy.matrix.shard = ['1/3', '2/3', '3/4']; }), 'release-shard-lane-sharding', /are not a complete set/],
        ['rc: a single-entry shard set', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['rc-test'].strategy.matrix.shard = ['1/1']; }), 'release-shard-lane-sharding', /rc-test is not actually sharded/],
        ['rc: no matrix on the test job', '.github/workflows/release.yml', yamlEdit((w) => { delete w.jobs['rc-test'].strategy; }), 'release-shard-lane-sharding', /rc-test is not actually sharded/],
        ['rc: the test job removed', '.github/workflows/release.yml', yamlEdit((w) => { delete w.jobs['rc-test']; }), 'release-shard-lane-sharding', /release\.yml declares no rc-test job/],
        ['rc: the unit step no longer passes the shard', '.github/workflows/release.yml', yamlEdit((w) => { const step = w.jobs['rc-test'].steps.find((s) => typeof s.run === 'string' && s.run.includes('test:coverage:unit:raw')); step.run = step.run.split('--shard ${{ matrix.shard }}').join(''); }), 'release-shard-lane-sharding', /the unit step does not pass matrix\.shard through to run-tests/],
        ['rc: the unit step removed', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['rc-test'].steps = w.jobs['rc-test'].steps.filter((s) => !(typeof s.run === 'string' && s.run.includes('test:coverage:unit:raw'))); }), 'release-shard-lane-sharding', /no step in rc-test runs the raw unit coverage script/],
        ['rc: the artifact upload renamed', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['rc-test'].steps.find((s) => String(s.uses || '').includes('upload-artifact')).with.name = 'coverage-tmp-other-${{ strategy.job-index }}'; }), 'release-shard-lane-sharding', /does not start with coverage-tmp-rc-shard-/],
        ['rc: the artifact upload without a name', '.github/workflows/release.yml', yamlEdit((w) => { delete w.jobs['rc-test'].steps.find((s) => String(s.uses || '').includes('upload-artifact')).with.name; }), 'release-shard-lane-sharding', /does not start with coverage-tmp-rc-shard-/],
        ['rc: the artifact upload removed', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['rc-test'].steps = w.jobs['rc-test'].steps.filter((s) => !String(s.uses || '').includes('upload-artifact')); }), 'release-shard-lane-sharding', /no upload-artifact step in rc-test/],
        ['rc: the coverage gate removed', '.github/workflows/release.yml', yamlEdit((w) => { delete w.jobs['rc-coverage-gate']; }), 'release-shard-lane-sharding', /release\.yml declares no rc-coverage-gate job/],
        ['rc: the coverage gate no longer needs the test job', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['rc-coverage-gate'].needs = ['validate-version']; }), 'release-shard-lane-sharding', /rc-coverage-gate does not depend on rc-test/],
        ['rc: the coverage gate with no needs', '.github/workflows/release.yml', yamlEdit((w) => { delete w.jobs['rc-coverage-gate'].needs; }), 'release-shard-lane-sharding', /rc-coverage-gate does not depend on rc-test/],
        ['rc: the shard artifacts downloaded without merge-multiple', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['rc-coverage-gate'].steps.find((s) => String(s.uses || '').includes('download-artifact')).with['merge-multiple'] = false; }), 'release-shard-lane-sharding', /shard artifacts with merge-multiple/],
        ['rc: the shard artifacts downloaded by another pattern', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['rc-coverage-gate'].steps.find((s) => String(s.uses || '').includes('download-artifact')).with.pattern = 'coverage-tmp-other-*'; }), 'release-shard-lane-sharding', /shard artifacts with merge-multiple/],
        ['rc: the shard artifact download removed', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['rc-coverage-gate'].steps = w.jobs['rc-coverage-gate'].steps.filter((s) => !String(s.uses || '').includes('download-artifact')); }), 'release-shard-lane-sharding', /shard artifacts with merge-multiple/],
        ['rc: the coverage report step removed', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['rc-coverage-gate'].steps = w.jobs['rc-coverage-gate'].steps.filter((s) => !(typeof s.run === 'string' && s.run.includes('test:coverage:report'))); }), 'release-shard-lane-sharding', /rc-coverage-gate never runs the coverage report and gate script/],
        ['rc: the final job no longer needs the coverage gate', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['rc'].needs = ['validate-version']; }), 'release-shard-lane-sharding', /rc does not depend on rc-coverage-gate/],
        ['rc: the final job removed', '.github/workflows/release.yml', yamlEdit((w) => { delete w.jobs['rc']; }), 'release-shard-lane-sharding', /release\.yml declares no rc job/],
        ['finalize: a numerator missing from the shard set', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['finalize-test'].strategy.matrix.shard = ['1/3', '2/3']; }), 'release-shard-lane-sharding', /are not a complete set/],
        ['finalize: a duplicated numerator in the shard set', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['finalize-test'].strategy.matrix.shard = ['1/3', '2/3', '2/3']; }), 'release-shard-lane-sharding', /are not a complete set/],
        ['finalize: mixed denominators in the shard set', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['finalize-test'].strategy.matrix.shard = ['1/3', '2/3', '3/4']; }), 'release-shard-lane-sharding', /are not a complete set/],
        ['finalize: a single-entry shard set', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['finalize-test'].strategy.matrix.shard = ['1/1']; }), 'release-shard-lane-sharding', /finalize-test is not actually sharded/],
        ['finalize: no matrix on the test job', '.github/workflows/release.yml', yamlEdit((w) => { delete w.jobs['finalize-test'].strategy; }), 'release-shard-lane-sharding', /finalize-test is not actually sharded/],
        ['finalize: the test job removed', '.github/workflows/release.yml', yamlEdit((w) => { delete w.jobs['finalize-test']; }), 'release-shard-lane-sharding', /release\.yml declares no finalize-test job/],
        ['finalize: the unit step no longer passes the shard', '.github/workflows/release.yml', yamlEdit((w) => { const step = w.jobs['finalize-test'].steps.find((s) => typeof s.run === 'string' && s.run.includes('test:coverage:unit:raw')); step.run = step.run.split('--shard ${{ matrix.shard }}').join(''); }), 'release-shard-lane-sharding', /the unit step does not pass matrix\.shard through to run-tests/],
        ['finalize: the unit step removed', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['finalize-test'].steps = w.jobs['finalize-test'].steps.filter((s) => !(typeof s.run === 'string' && s.run.includes('test:coverage:unit:raw'))); }), 'release-shard-lane-sharding', /no step in finalize-test runs the raw unit coverage script/],
        ['finalize: the artifact upload renamed', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['finalize-test'].steps.find((s) => String(s.uses || '').includes('upload-artifact')).with.name = 'coverage-tmp-other-${{ strategy.job-index }}'; }), 'release-shard-lane-sharding', /does not start with coverage-tmp-finalize-shard-/],
        ['finalize: the artifact upload without a name', '.github/workflows/release.yml', yamlEdit((w) => { delete w.jobs['finalize-test'].steps.find((s) => String(s.uses || '').includes('upload-artifact')).with.name; }), 'release-shard-lane-sharding', /does not start with coverage-tmp-finalize-shard-/],
        ['finalize: the artifact upload removed', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['finalize-test'].steps = w.jobs['finalize-test'].steps.filter((s) => !String(s.uses || '').includes('upload-artifact')); }), 'release-shard-lane-sharding', /no upload-artifact step in finalize-test/],
        ['finalize: the coverage gate removed', '.github/workflows/release.yml', yamlEdit((w) => { delete w.jobs['finalize-coverage-gate']; }), 'release-shard-lane-sharding', /release\.yml declares no finalize-coverage-gate job/],
        ['finalize: the coverage gate no longer needs the test job', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['finalize-coverage-gate'].needs = ['validate-version']; }), 'release-shard-lane-sharding', /finalize-coverage-gate does not depend on finalize-test/],
        ['finalize: the coverage gate with no needs', '.github/workflows/release.yml', yamlEdit((w) => { delete w.jobs['finalize-coverage-gate'].needs; }), 'release-shard-lane-sharding', /finalize-coverage-gate does not depend on finalize-test/],
        ['finalize: the shard artifacts downloaded without merge-multiple', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['finalize-coverage-gate'].steps.find((s) => String(s.uses || '').includes('download-artifact')).with['merge-multiple'] = false; }), 'release-shard-lane-sharding', /shard artifacts with merge-multiple/],
        ['finalize: the shard artifacts downloaded by another pattern', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['finalize-coverage-gate'].steps.find((s) => String(s.uses || '').includes('download-artifact')).with.pattern = 'coverage-tmp-other-*'; }), 'release-shard-lane-sharding', /shard artifacts with merge-multiple/],
        ['finalize: the shard artifact download removed', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['finalize-coverage-gate'].steps = w.jobs['finalize-coverage-gate'].steps.filter((s) => !String(s.uses || '').includes('download-artifact')); }), 'release-shard-lane-sharding', /shard artifacts with merge-multiple/],
        ['finalize: the coverage report step removed', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['finalize-coverage-gate'].steps = w.jobs['finalize-coverage-gate'].steps.filter((s) => !(typeof s.run === 'string' && s.run.includes('test:coverage:report'))); }), 'release-shard-lane-sharding', /finalize-coverage-gate never runs the coverage report and gate script/],
        ['finalize: the final job no longer needs the coverage gate', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['finalize'].needs = ['validate-version']; }), 'release-shard-lane-sharding', /finalize does not depend on finalize-coverage-gate/],
        ['finalize: the final job removed', '.github/workflows/release.yml', yamlEdit((w) => { delete w.jobs['finalize']; }), 'release-shard-lane-sharding', /release\.yml declares no finalize job/],
        // release-tarball-smoke-workflow
        ['the workflow_call trigger removed', '.github/workflows/install-smoke.yml', yamlEdit((w) => { delete w.on.workflow_call; }), 'release-tarball-smoke-workflow', /must keep the workflow_call trigger/],
        ['every trigger removed', '.github/workflows/install-smoke.yml', yamlEdit((w) => { delete w.on; }), 'release-tarball-smoke-workflow', /must keep the workflow_call trigger/],
        ['the lifecycle smoke step removed', '.github/workflows/install-smoke.yml', yamlEdit((w) => { w.jobs.smoke.steps = w.jobs.smoke.steps.filter((s) => !(typeof s.run === 'string' && s.run.includes('release-tarball-smoke.cjs'))); }), 'release-tarball-smoke-workflow', /the lifecycle smoke step must call release-tarball-smoke\.cjs/],
        ['the --json flag removed from the lifecycle smoke step', '.github/workflows/install-smoke.yml', yamlEdit((w) => { const step = w.jobs.smoke.steps.find((s) => typeof s.run === 'string' && s.run.includes('release-tarball-smoke.cjs')); step.run = step.run.split('--json').join(''); }), 'release-tarball-smoke-workflow', /must invoke the script with the --json flag/],
        ['the jq check removed from the lifecycle smoke step', '.github/workflows/install-smoke.yml', yamlEdit((w) => { const step = w.jobs.smoke.steps.find((s) => typeof s.run === 'string' && s.run.includes('release-tarball-smoke.cjs')); step.run = step.run.split('jq').join('x'); }), 'release-tarball-smoke-workflow', /must be checked via jq/],
        ['the smoke script removed from the pull_request path filter', '.github/workflows/install-smoke.yml', yamlEdit((w) => { w.on.pull_request.paths = w.on.pull_request.paths.filter((p) => p !== 'scripts/release-tarball-smoke.cjs'); }), 'release-tarball-smoke-workflow', /path filter must include scripts\/release-tarball-smoke\.cjs/],
        ['the install test removed from the pull_request path filter', '.github/workflows/install-smoke.yml', yamlEdit((w) => { w.on.pull_request.paths = w.on.pull_request.paths.filter((p) => p !== 'tests/release-tarball-smoke.install.test.cjs'); }), 'release-tarball-smoke-workflow', /path filter must include tests\/release-tarball-smoke\.install\.test\.cjs/],
        ['the pull_request path filter removed', '.github/workflows/install-smoke.yml', yamlEdit((w) => { delete w.on.pull_request.paths; }), 'release-tarball-smoke-workflow', /path filter must include scripts\/release-tarball-smoke\.cjs/],
        ['the upload-artifact step removed', '.github/workflows/install-smoke.yml', yamlEdit((w) => { for (const job of Object.values(w.jobs)) job.steps = (job.steps || []).filter((s) => !String(s.uses || '').startsWith('actions/upload-artifact')); }), 'release-tarball-smoke-workflow', /an actions\/upload-artifact step must exist/],
        ['the upload-artifact action replaced by another that merely contains the name', '.github/workflows/install-smoke.yml', yamlEdit((w) => { for (const job of Object.values(w.jobs)) for (const s of job.steps || []) if (String(s.uses || '').startsWith('actions/upload-artifact')) s.uses = 'other/actions/upload-artifact@v1'; }), 'release-tarball-smoke-workflow', /an actions\/upload-artifact step must exist/],
        // review round 1
        ['rc: the coverage gate needs a longer job name as a string', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['rc-coverage-gate'].needs = 'rc-test-extra'; }), 'release-shard-lane-sharding', /rc-coverage-gate does not depend on rc-test/],
        ['rc: the final job needs a longer gate name as a string', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['rc'].needs = 'rc-coverage-gate-extra'; }), 'release-shard-lane-sharding', /rc does not depend on rc-coverage-gate/],
        ['rc: the coverage gate needs only a longer job name in a list', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['rc-coverage-gate'].needs = ['rc-test-extra']; }), 'release-shard-lane-sharding', /rc-coverage-gate does not depend on rc-test/],
        ['finalize: the coverage gate needs a longer job name as a string', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['finalize-coverage-gate'].needs = 'finalize-test-extra'; }), 'release-shard-lane-sharding', /finalize-coverage-gate does not depend on finalize-test/],
        ['finalize: the final job needs a longer gate name as a string', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['finalize'].needs = 'finalize-coverage-gate-extra'; }), 'release-shard-lane-sharding', /finalize does not depend on finalize-coverage-gate/],
        ['finalize: the coverage gate needs only a longer job name in a list', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['finalize-coverage-gate'].needs = ['finalize-test-extra']; }), 'release-shard-lane-sharding', /finalize-coverage-gate does not depend on finalize-test/],
        ['triggers written as a list without workflow_call', '.github/workflows/install-smoke.yml', yamlEdit((w) => { w.on = ['push']; }), 'release-tarball-smoke-workflow', /must keep the workflow_call trigger/],
        ['triggers written as the string push', '.github/workflows/install-smoke.yml', yamlEdit((w) => { w.on = 'push'; }), 'release-tarball-smoke-workflow', /must keep the workflow_call trigger/],
        ['a URL before an untyped read on the same line is not a comment', 'hooks/gsd-prompt-guard.js', append("const u = 'http://x'; const leaked = payload.tool_input.file_path;"), 'kimi-guard-typed-payload-reads', /must not read a model-supplied payload path field/],
        ['a line comment ended by a carriage return before an untyped read', 'hooks/gsd-prompt-guard.js', append('// c\rconst leaked = payload.tool_input.file_path;'), 'kimi-guard-typed-payload-reads', /must not read a model-supplied payload path field/],
        ['a line comment ended by a line separator before an untyped read', 'hooks/gsd-prompt-guard.js', append('// c\u2028const leaked = payload.tool_input.file_path;'), 'kimi-guard-typed-payload-reads', /must not read a model-supplied payload path field/],
        ['a line comment ended by a paragraph separator before an untyped read', 'hooks/gsd-prompt-guard.js', append('// c\u2029const leaked = payload.tool_input.file_path;'), 'kimi-guard-typed-payload-reads', /must not read a model-supplied payload path field/],
        ['a line comment ended by a line feed before an untyped read', 'hooks/gsd-prompt-guard.js', append('// c\nconst leaked = payload.tool_input.file_path;'), 'kimi-guard-typed-payload-reads', /must not read a model-supplied payload path field/],
        ['typeofx beside an untyped read', 'hooks/gsd-prompt-guard.js', append('const leaked = typeofx + payload.tool_input.file_path;'), 'kimi-guard-typed-payload-reads', /must not read a model-supplied payload path field/],
        ['xtypeof beside an untyped read', 'hooks/gsd-prompt-guard.js', append('const leaked = xtypeof + payload.tool_input.file_path;'), 'kimi-guard-typed-payload-reads', /must not read a model-supplied payload path field/],
        ['typeof_ beside an untyped read', 'hooks/gsd-prompt-guard.js', append('const leaked = typeof_ + payload.tool_input.file_path;'), 'kimi-guard-typed-payload-reads', /must not read a model-supplied payload path field/],
        ['three pipes spread across a line separator are not a table', 'gsd-core/references/debugger-bug-taxonomy.md', (text) => text.split('|').join('/') + '\na|b|\u2028|c\n', 'debugger-bug-taxonomy', /there must be a markdown table/],
        ['a not-append wording split across a line separator', 'gsd-core/references/debugger-bug-taxonomy.md', (text) => text.replace(/replace|supersede|routed? selection/gi, 'x').replace(/append/gi, 'y') + '\nnot\u2028append\n', 'debugger-bug-taxonomy', /the reference must state the flat menu is replaced or superseded/],
        ['a skip and a log wording split across a line separator', 'gsd-core/references/debugger-sbfl.md', (text) => text.replace(/skip|log|note/gi, 'x') + '\nskip\u2028log\n', 'debugger-sbfl', /a skip must be logged/],
        ['a word merely containing rr does not name record-replay in the Heisenbug row', 'gsd-core/references/debugger-bug-taxonomy.md', swap('record-replay (`rr`) \u2192 stability-stress \u2192 ', '(err) \u2192 '), 'debugger-bug-taxonomy', /the Heisenbug row must include record-replay \(rr\) and\/or stability-stress/],
        ['the Bohrbug row removed from the routing table', 'gsd-core/references/debugger-bug-taxonomy.md', (text) => text.split('\n').filter((line) => !line.startsWith('| **Bohrbug')).join('\n'), 'debugger-bug-taxonomy', /no bohrbug row/],
        ['the Heisenbug row removed from the routing table', 'gsd-core/references/debugger-bug-taxonomy.md', (text) => text.split('\n').filter((line) => !line.startsWith('| **Heisenbug')).join('\n'), 'debugger-bug-taxonomy', /no heisenbug row/],
        ['the Concurrency row removed from the routing table', 'gsd-core/references/debugger-bug-taxonomy.md', (text) => text.split('\n').filter((line) => !line.startsWith('| **Concurrency')).join('\n'), 'debugger-bug-taxonomy', /no concurrency row/],
        ['full variant: a true flag then a false flag in the spawn still blocks but its first flag differs from the sibling', 'agents/gsd-debug-session-manager.md', (text) => text.replace('run_in_background=false', 'run_in_background=true\n  run_in_background=false'), 'debug-manager-blocking-spawn', /the compact sibling must not diverge from the canonical agent on spawn semantics/],
        ['full variant: only true flags in the spawn', 'agents/gsd-debug-session-manager.md', (text) => text.replace('run_in_background=false', 'run_in_background=true\n  run_in_background=true'), 'debug-manager-blocking-spawn', /full variant: the debugger spawn must be blocking/],
        ['full variant: no spawn block names gsd-debugger', 'agents/gsd-debug-session-manager.md', eraseAll('subagent_type="gsd-debugger"'), 'debug-manager-blocking-spawn', /full variant: expected exactly one gsd-debugger spawn block/],
        ['compact variant: a true flag then a false flag in the spawn still blocks but its first flag differs from the sibling', 'agents/gsd-debug-session-manager.compact.md', (text) => text.replace('run_in_background=false', 'run_in_background=true\n  run_in_background=false'), 'debug-manager-blocking-spawn', /the compact sibling must not diverge from the canonical agent on spawn semantics/],
        ['compact variant: only true flags in the spawn', 'agents/gsd-debug-session-manager.compact.md', (text) => text.replace('run_in_background=false', 'run_in_background=true\n  run_in_background=true'), 'debug-manager-blocking-spawn', /compact variant: the debugger spawn must be blocking/],
        ['compact variant: no spawn block names gsd-debugger', 'agents/gsd-debug-session-manager.compact.md', eraseAll('subagent_type="gsd-debugger"'), 'debug-manager-blocking-spawn', /compact variant: expected exactly one gsd-debugger spawn block/],
        ['the compact variant first flag differs from the full variant first flag with a later false flag', 'agents/gsd-debug-session-manager.compact.md', (text) => text.replace('run_in_background=false', 'run_in_background=true\n  run_in_background=false'), 'debug-manager-blocking-spawn', /the compact sibling must not diverge from the canonical agent on spawn semantics/],
        // review round 2
        ['a one-line debugger spawn with a nested call in the manager', 'agents/gsd-debug-session-manager.md', append('Agent(prompt=f(x), subagent_type="gsd-debugger")'), 'debug-manager-blocking-spawn', /full variant: expected exactly one gsd-debugger spawn block/],
        ['a one-line debugger spawn with a parenthesis in a quoted prompt in the manager', 'agents/gsd-debug-session-manager.md', append('Agent(prompt="a ) b", subagent_type="gsd-debugger")'), 'debug-manager-blocking-spawn', /full variant: expected exactly one gsd-debugger spawn block/],
        ['an agent file with a nested-call spawn that never states run_in_background', 'agents/gsd-executor.md', append('Agent(prompt=f(x), subagent_type="gsd-planner")'), 'debug-manager-blocking-spawn', /an agent that spawns a subagent must decide whether that spawn blocks/],
        ['an agent file with a quoted-parenthesis spawn that never states run_in_background', 'agents/gsd-executor.md', append('Agent(prompt="a ) b", subagent_type="gsd-planner")'), 'debug-manager-blocking-spawn', /an agent that spawns a subagent must decide whether that spawn blocks/],
        // review round 3
        ['a prose line with an unmatched Agent( before a one-line spawn that never states run_in_background', 'agents/gsd-executor.md', append('See the Agent( call below\nAgent(subagent_type="gsd-planner")'), 'debug-manager-blocking-spawn', /an agent that spawns a subagent must decide whether that spawn blocks/],
        ['a multi-line spawn with an unbalanced parenthesis before a one-line spawn that never states run_in_background', 'agents/gsd-executor.md', append('Agent(\n  prompt=f(x,\n  subagent_type="gsd-planner",\n  run_in_background=false\n)\nAgent(subagent_type="gsd-planner")'), 'debug-manager-blocking-spawn', /an agent that spawns a subagent must decide whether that spawn blocks/],
        ['a prose line with an unmatched Agent( before a second one-line spawn literal in the manager', 'agents/gsd-debug-session-manager.md', append('See the Agent( call below\nAgent(subagent_type="gsd-planner")'), 'debug-manager-blocking-spawn', /exactly one Agent\(\) spawn literal may exist/],
        // review round 4
        ['an unbalanced one-line debugger spawn whose continuation holds the flag is still counted as a spawn block', 'agents/gsd-debug-session-manager.md', append('Agent(subagent_type="gsd-debugger", prompt=f(x)\n  , run_in_background=false)'), 'debug-manager-blocking-spawn', /full variant: expected exactly one gsd-debugger spawn block/],
        ['an unbalanced one-line spawn whose continuation holds the flag is still read without the flag', 'agents/gsd-executor.md', append('Agent(subagent_type="gsd-planner", prompt=f(x)\n  , run_in_background=false)'), 'debug-manager-blocking-spawn', /an agent that spawns a subagent must decide whether that spawn blocks/],
        // tdd-reference-correctness
        ['a cited section name gone from the execute-plan pointer (Red-Green-Refactor Cycle)', 'gsd-core/workflows/execute-plan.md', within('<tdd_plan_execution>', '</tdd_plan_execution>', swap('"Red-Green-Refactor Cycle"', '"Cycle"')), 'tdd-reference-correctness', /execute-plan\.md: the commit-scope contract must cite "Red-Green-Refactor Cycle"/],
        ['a cited section name gone from the execute-plan pointer (Fail-Fast Rules)', 'gsd-core/workflows/execute-plan.md', within('<tdd_plan_execution>', '</tdd_plan_execution>', swap('"Fail-Fast Rules"', '"Fast"')), 'tdd-reference-correctness', /execute-plan\.md: the fail-fast rule must cite "Fail-Fast Rules" by its literal section name/],
        ['a cited section name gone from the execute-plan pointer (Error Handling)', 'gsd-core/workflows/execute-plan.md', within('<tdd_plan_execution>', '</tdd_plan_execution>', swap('"Error Handling"', '"Errors"')), 'tdd-reference-correctness', /execute-plan\.md: error handling must cite "Error Handling" by its literal section name/],
        ['the tdd_plan_execution block renamed in execute-plan', 'gsd-core/workflows/execute-plan.md', swap('<tdd_plan_execution>', '<tdd_plan_run>'), 'tdd-reference-correctness', /marker .*<tdd_plan_execution>.* not found/],
        ['the tdd_plan_execution block unterminated in execute-plan', 'gsd-core/workflows/execute-plan.md', swap('</tdd_plan_execution>', '</tdd_plan_run>'), 'tdd-reference-correctness', /closing marker .* not found/],
        ['a cited section name gone from the executor pointer (Red-Green-Refactor Cycle)', 'agents/gsd-executor.md', within('<tdd_execution>', '## Plan-Level', swap('"Red-Green-Refactor Cycle"', '"Cycle"')), 'tdd-reference-correctness', /gsd-executor\.md: the commit-scope contract must cite "Red-Green-Refactor Cycle"/],
        ['a cited section name gone from the executor pointer (Fail-Fast Rules)', 'agents/gsd-executor.md', within('<tdd_execution>', '## Plan-Level', swap('"Fail-Fast Rules"', '"Fast"')), 'tdd-reference-correctness', /gsd-executor\.md: the fail-fast rule must cite "Fail-Fast Rules" by its literal section name/],
        ['a cited section name gone from the executor pointer (Error Handling)', 'agents/gsd-executor.md', within('<tdd_execution>', '## Plan-Level', swap('"Error Handling"', '"Errors"')), 'tdd-reference-correctness', /gsd-executor\.md: error handling must cite "Error Handling" by its literal section name/],
        ['the tdd_execution block renamed in the executor', 'agents/gsd-executor.md', swap('<tdd_execution>', '<tdd_run>'), 'tdd-reference-correctness', /gsd-executor\.md has no <tdd_execution> block/],
        ['the executor pointer block with no end marker', 'agents/gsd-executor.md', (text) => text.split('## Plan-Level').join('## Level').split('</tdd_execution>').join('</tdd_run>'), 'tdd-reference-correctness', /the <tdd_execution> pointer block has no end/],
        ['the Fail-Fast Rules section renamed in tdd.md', 'gsd-core/references/tdd.md', swap('### Fail-Fast Rules', '### Fast'), 'tdd-reference-correctness', /marker .*### Fail-Fast Rules.* not found/],
        ['the Fail-Fast Rules section unterminated in tdd.md', 'gsd-core/references/tdd.md', swap('### Executor Gate Validation', '### Gate Validation'), 'tdd-reference-correctness', /closing marker .* not found/],
        ['the unexpected-GREEN-in-RED rule gone from the Fail-Fast Rules section', 'gsd-core/references/tdd.md', within('### Fail-Fast Rules', '### Executor Gate Validation', erase(/Unexpected GREEN in RED phase/gi)), 'tdd-reference-correctness', /the Fail-Fast Rules section must describe the unexpected-pass-in-RED rule/],
        ['the Error Handling section renamed in tdd.md', 'gsd-core/references/tdd.md', swap('## Error Handling', '## Errors'), 'tdd-reference-correctness', /marker .*## Error Handling.* not found/],
        ['the Error Handling section unterminated in tdd.md', 'gsd-core/references/tdd.md', swap('## Commit Pattern for TDD Plans', '## Commit Pattern'), 'tdd-reference-correctness', /closing marker .* not found/],
        ['the word fail gone from the Error Handling section', 'gsd-core/references/tdd.md', within('## Error Handling', '## Commit Pattern for TDD Plans', erase(/fail/gi)), 'tdd-reference-correctness', /the Error Handling section must describe fail-in-RED\/GREEN\/REFACTOR guidance \(fail\)/],
        ['the phase names gone from the Error Handling section', 'gsd-core/references/tdd.md', within('## Error Handling', '## Commit Pattern for TDD Plans', erase(/RED|GREEN|REFACTOR/g)), 'tdd-reference-correctness', /the Error Handling section must describe fail-in-RED\/GREEN\/REFACTOR guidance \(a phase name\)/],
        ['the old RED gate-sequence wording restated in the executor', 'agents/gsd-executor.md', append('A `test(...)` commit exists (RED gate)'), 'tdd-reference-correctness', /gsd-executor\.md must not restate the old RED gate-sequence wording/],
        ['the old GREEN gate-sequence wording restated in the executor', 'agents/gsd-executor.md', append('A `feat(...)` commit exists after it (GREEN gate)'), 'tdd-reference-correctness', /gsd-executor\.md must not restate the old GREEN gate-sequence wording/],
        ['the tdd.md reference gone from the executor', 'agents/gsd-executor.md', eraseAll('references/tdd.md'), 'tdd-reference-correctness', /gsd-executor\.md must point at tdd\.md's Gate Enforcement Rules \(the tdd\.md reference\)/],
        ['the Gate Enforcement Rules pointer gone from the executor', 'agents/gsd-executor.md', eraseAll('Gate Enforcement Rules'), 'tdd-reference-correctness', /gsd-executor\.md must point at tdd\.md's "Gate Enforcement Rules" section/],
        ['the Plan-Level TDD Gate Enforcement heading gone from the executor', 'agents/gsd-executor.md', swap('## Plan-Level TDD Gate Enforcement', '## Plan-Level TDD Gate'), 'tdd-reference-correctness', /the "## Plan-Level TDD Gate Enforcement" heading must still exist as an anchor/],
        ['the plan-level gate section grown past a short pointer', 'agents/gsd-executor.md', within('## Plan-Level TDD Gate Enforcement', '</tdd_execution>', (section) => `${section}\nline a\nline b\nline c\nline d\nline e\nline f\nline g\nline h\n`), 'tdd-reference-correctness', /the plan-level gate section must be a short pointer \(at most 6 non-blank lines\)/],
        ['the fail-fast rule gone from tdd.md', 'gsd-core/references/tdd.md', erase(/Unexpected GREEN in RED phase/g), 'tdd-reference-correctness', /tdd\.md must carry the fail-fast rule/],
        ['the git-log gate validation script gone from tdd.md', 'gsd-core/references/tdd.md', erase(/git log --oneline -E --grep/g), 'tdd-reference-correctness', /tdd\.md must carry the git-log gate validation script/],
        ['the TDD Gate Compliance contract gone from tdd.md', 'gsd-core/references/tdd.md', erase(/## TDD Gate Compliance/g), 'tdd-reference-correctness', /tdd\.md must carry the TDD Gate Compliance SUMMARY\.md contract/],
        ['the git-log gate validation script restated in the executor', 'agents/gsd-executor.md', append('git log --oneline -E --grep="x"'), 'tdd-reference-correctness', /gsd-executor\.md must not restate the git-log gate validation script/],
        ['the fail-fast prose restated in the executor', 'agents/gsd-executor.md', append('If a test passes unexpectedly during RED, STOP'), 'tdd-reference-correctness', /gsd-executor\.md must not restate the fail-fast rule prose/],
        // summary-commit-verification
        ['the HEAD ledger gone from the executor', 'agents/gsd-executor.md', eraseAll('gsd-plan-head-before'), 'summary-commit-verification', /the ledger must persist on disk/],
        ['the rev-list count gone from the executor', 'agents/gsd-executor.md', eraseAll('git rev-list --count'), 'summary-commit-verification', /the SUMMARY commit count must come from git rev-list --count/],
        ['plan_head_before gone from the executor frontmatter', 'agents/gsd-executor.md', eraseAll('plan_head_before: ${PLAN_HEAD_BEFORE}'), 'summary-commit-verification', /the base is recorded in the frontmatter/],
        ['the SUMMARY halt gone from the executor', 'agents/gsd-executor.md', erase(/HALT — do not write the\s{1,20}SUMMARY/gi), 'summary-commit-verification', /a measured zero with uncommitted code changes must halt the SUMMARY write/],
        ['the measured actuals line gone from the executor', 'agents/gsd-executor.md', erase(/commits: 7 .{0,500}MEASURED/g), 'summary-commit-verification', /the actuals block sources its count from the measurement/],
        ['plan_head_after gone from the executor frontmatter', 'agents/gsd-executor.md', eraseAll('plan_head_after: ${PLAN_HEAD_AFTER}'), 'summary-commit-verification', /the SUMMARY frontmatter must carry plan_head_after/],
        ['the PLAN_HEAD_AFTER capture gone from the executor', 'agents/gsd-executor.md', eraseAll('PLAN_HEAD_AFTER=$(git rev-parse HEAD)'), 'summary-commit-verification', /PLAN_HEAD_AFTER must be captured from HEAD/],
        ['the commit-claim reconciliation gone from verify-work', 'gsd-core/workflows/verify-work.md', eraseAll('Commit-claim reconciliation'), 'summary-commit-verification', /verify-work must run a commit-claim reconciliation over each SUMMARY/],
        ['the reconciliation instrument gone from verify-work', 'gsd-core/workflows/verify-work.md', eraseAll('ACTUAL=$(git rev-list --count "${BASE}"..HEAD)'), 'summary-commit-verification', /the reconciliation uses the SAME instrument as the executor/],
        ['the bounded reconciliation rule gone from verify-work', 'gsd-core/workflows/verify-work.md', eraseAll('Bounded reconciliation (#4670)'), 'summary-commit-verification', /the bounded exact-equality reconciliation is the shipped rule/],
        ['the retired +1 tolerance sentence gone from verify-work', 'gsd-core/workflows/verify-work.md', eraseAll('`ACTUAL == CLAIMED + 1` tolerance was a guess'), 'summary-commit-verification', /the \+1 tolerance appears only as the retired legacy rule/],
        ['the retired +1 tolerance sentence ahead of the reconciliation in verify-work', 'gsd-core/workflows/verify-work.md', (text) => `\`ACTUAL == CLAIMED + 1\` tolerance was a guess\n${text}`, 'summary-commit-verification', /the \+1 tolerance appears only as the retired legacy rule/],
        ['BLOCKER gone from the reconciliation block of verify-work', 'gsd-core/workflows/verify-work.md', (text) => {
          const at = text.indexOf('Commit-claim reconciliation');
          return text.slice(0, at) + text.slice(at, at + 1800).split('BLOCKER').join('BLOCKED') + text.slice(at + 1800);
        }, 'summary-commit-verification', /a mismatch must be flagged BLOCKER: the phase must not read as done/],
        ['the plan_head_after extraction gone from verify-work', 'gsd-core/workflows/verify-work.md', eraseAll('AFTER=$(grep -oE \'^plan_head_after: [0-9a-f]{7,40}\' "$SUMMARY_FILE" | awk \'{print $2}\')'), 'summary-commit-verification', /the reconciliation must extract plan_head_after/],
        ['the ancestor check gone from verify-work', 'gsd-core/workflows/verify-work.md', eraseAll('git merge-base --is-ancestor "$AFTER" HEAD'), 'summary-commit-verification', /the plan end must be verified to still be in history/],
        ['the bounded count gone from verify-work', 'gsd-core/workflows/verify-work.md', eraseAll('git rev-list --count "${BASE}..${AFTER}"'), 'summary-commit-verification', /the measured count must be bounded to the plan own window/],
        ['the #4670 section gone from verify-work', 'gsd-core/workflows/verify-work.md', eraseAll('#4670'), 'summary-commit-verification', /a bounded mismatch must remain a BLOCKER and keep the commit_claim_mismatch verdict name/],
        ['the commit_claim_mismatch verdict name gone from verify-work', 'gsd-core/workflows/verify-work.md', eraseAll('commit_claim_mismatch'), 'summary-commit-verification', /no commit_claim_mismatch within 2400 characters of #4670/],
        ['plan_head_after gone from verify-work', 'gsd-core/workflows/verify-work.md', eraseAll('plan_head_after'), 'summary-commit-verification', /plan_head_after must appear in verify-work/],
        ['the WARNING fallback gone from verify-work', 'gsd-core/workflows/verify-work.md', erase(/WARNING[\s\S]{0,400}plan_head_after/g), 'summary-commit-verification', /SUMMARYs without plan_head_after must fall back to the WARNING path/],
        ['the porcelain call gone from pause-work', 'gsd-core/workflows/pause-work.md', eraseAll('git status --porcelain'), 'summary-commit-verification', /uncommitted_files must be populated from an actual git status --porcelain call/],
        ['the porcelain definition of uncommitted_files gone from pause-work', 'gsd-core/workflows/pause-work.md', (text) => `${text.split('porcelain').join('plain')}\ngit status --porcelain\n`, 'summary-commit-verification', /the uncommitted_files field is defined by the porcelain command, not a narrated \[\]/],
        // prohibition-probe.spec-phase-contract
        ['the Step 5.6 heading renamed in spec-phase', 'gsd-core/workflows/spec-phase.md', swap('## Step 5.6', '## Step 5.7'), 'prohibition-probe.spec-phase-contract', /marker .*## Step 5\.6.* not found/],
        ['Step 5.6 of spec-phase with no next heading', 'gsd-core/workflows/spec-phase.md', (text) => {
          const at = text.indexOf('## Step 5.6');
          return text.slice(0, at) + text.slice(at).split('\n## ').join('\n### ');
        }, 'prohibition-probe.spec-phase-contract', /closing marker .* not found/],
        ['a prohibition-probe.cjs engine wired into Step 5.6', 'gsd-core/workflows/spec-phase.md', within('## Step 5.6', '\n## ', (block) => `${block}\nnode prohibition-probe.cjs\n`), 'prohibition-probe.spec-phase-contract', /Step 5\.6 must NOT reference a prohibition-probe\.cjs engine/],
        ['the adversarial recall question gone from Step 5.6', 'gsd-core/workflows/spec-phase.md', within('## Step 5.6', '\n## ', erase(/silently become|would NOT want|must.?not|adversarial/gi)), 'prohibition-probe.spec-phase-contract', /Step 5\.6 must pose the adversarial recall question \(PROB-01\)/],
        ['the precision stage gone from Step 5.6', 'gsd-core/workflows/spec-phase.md', within('## Step 5.6', '\n## ', erase(/engineering|precision/gi)), 'prohibition-probe.spec-phase-contract', /Step 5\.6 must describe a precision classifier that drops routine engineering items \(PROB-02\)/],
        ['the soft gate gone from Step 5.6', 'gsd-core/workflows/spec-phase.md', within('## Step 5.6', '\n## ', erase(/write.?anyway|soft.?gate|with.?flags/gi)), 'prohibition-probe.spec-phase-contract', /Step 5\.6 must be a soft gate \(write-anyway-with-flags\)/],
        ['the dismissal reason gone from Step 5.6', 'gsd-core/workflows/spec-phase.md', within('## Step 5.6', '\n## ', erase(/dismiss[a-z]{0,30}|reason/gi)), 'prohibition-probe.spec-phase-contract', /Step 5\.6 must require a non-empty reason when dismissing a prohibition \(PROB-05\)/],
        ['--auto never auto-dismissing gone from Step 5.6', 'gsd-core/workflows/spec-phase.md', within('## Step 5.6', '\n## ', erase(/--auto|never auto.?dismiss/gi)), 'prohibition-probe.spec-phase-contract', /Step 5\.6 must specify that --auto never auto-dismisses prohibitions \(PROB-06\)/],
        ['text-mode handling gone from Step 5.6', 'gsd-core/workflows/spec-phase.md', within('## Step 5.6', '\n## ', erase(/text.?mode|non-?Claude|AskUserQuestion/gi)), 'prohibition-probe.spec-phase-contract', /Step 5\.6 must handle text-mode/],
        ['the SPEC Prohibitions section gone from Step 5.6', 'gsd-core/workflows/spec-phase.md', within('## Step 5.6', '\n## ', erase(/Prohibitions/g)), 'prohibition-probe.spec-phase-contract', /Step 5\.6 must populate a SPEC Prohibitions section/],
        ['the canon-referral breadcrumb gone from Step 5.6', 'gsd-core/workflows/spec-phase.md', within('## Step 5.6', '\n## ', erase(/secure-phase|canon|OWASP|GDPR/gi)), 'prohibition-probe.spec-phase-contract', /Step 5\.6 must emit a canon-referral breadcrumb/],
        ['the prohibition-probe.md @-include gone from Step 5.6', 'gsd-core/workflows/spec-phase.md', within('## Step 5.6', '\n## ', erase(/references\/prohibition-probe\.md/g)), 'prohibition-probe.spec-phase-contract', /Step 5\.6 must @-include references\/prohibition-probe\.md/],
        // section-marker-inversion-guard
        ['the auto-advance-dispatch section renamed in discuss-phase-assumptions', 'gsd-core/workflows/discuss-phase-assumptions.md', eraseAll('auto-advance-dispatch'), 'section-marker-inversion-guard', /the gated section must exist and be when="state:auto-advance-active"/],
        ['the fallback text gone from discuss-phase-assumptions', 'gsd-core/workflows/discuss-phase-assumptions.md', eraseAll('End here — `confirm_creation` already ran; do not route back to it.'), 'section-marker-inversion-guard', /the flag-absent "End here" fallback must exist verbatim in the host file/],
        ['the fallback text duplicated in discuss-phase-assumptions', 'gsd-core/workflows/discuss-phase-assumptions.md', append('End here — `confirm_creation` already ran; do not route back to it.'), 'section-marker-inversion-guard', /the fallback text must appear exactly once in the host file/],
        ['a resolver line gone from discuss-phase-assumptions', 'gsd-core/workflows/discuss-phase-assumptions.md', eraseAll('gsd_run query config-set workflow._auto_chain_active'), 'section-marker-inversion-guard', /every resolver line \(--auto parse, config-set, AUTO_MODE read\) must lie OUTSIDE the gated marker/],
        ['the gated section of verify-work renamed', 'gsd-core/workflows/verify-work.md', eraseAll('mvp-uat-framing'), 'section-marker-inversion-guard', /the gated section must exist and be when="state:phase-mvp-mode"/],
        ['the MVP false-branch note gone from verify-work', 'gsd-core/workflows/verify-work.md', eraseAll('When `MVP_MODE=false` (mode is null, absent, or the phase has no `**Mode:**` line in ROADMAP.md), fall back to the standard UAT generation path — no behavioral change.'), 'section-marker-inversion-guard', /the MVP=false fallback note must be present in the host file/],
        // planner-estimate-emission
        ['the estimate block gone from the planner template', 'agents/gsd-planner.md', erase(/^estimate:/gm), 'planner-estimate-emission', /the template must declare an `estimate:` block/],
        ['the estimate row gone from the planner field table', 'agents/gsd-planner.md', erase(/\|\s*`estimate`\s*\|/g), 'planner-estimate-emission', /the field reference table must have an `estimate` row/],
        ['the calibration surface gone from the planner', 'agents/gsd-planner.md', eraseAll('estimate-calibration'), 'planner-estimate-emission', /the planner must consume the calibration surface/],
        ['the sample count derivation gone from the planner', 'agents/gsd-planner.md', eraseAll('sample count'), 'planner-estimate-emission', /the planner must be told confidence is derived from the sample count/],
        ['the planner frontmatter template gone', 'agents/gsd-planner.md', eraseAll('must_haves:'), 'planner-estimate-emission', /the template must declare an `estimate:` block \(the PLAN\.md frontmatter template is not in the planner\)/],
        ['the configured budget gone from the plan-checker', 'agents/gsd-plan-checker.md', eraseAll('workflow.smart_zone_tokens'), 'planner-estimate-emission', /the checker must read the configured budget, not hardcode one/],
        ['the estimate-check verb gone from the plan-checker', 'agents/gsd-plan-checker.md', eraseAll('estimate-check'), 'planner-estimate-emission', /the flag must be computed by the estimate-check verb/],
        ['the split recommendation gone from the plan-checker', 'agents/gsd-plan-checker.md', eraseAll('re-slic'), 'planner-estimate-emission', /an over-budget plan must recommend splitting \(re-slice\)/],
        ['the advisory wording gone from the plan-checker', 'agents/gsd-plan-checker.md', eraseAll('WARNING, never a blocker'), 'planner-estimate-emission', /the over-budget flag is advisory: WARNING, never a blocker/],
        ['Dimension 5 gone from the plan-checker', 'agents/gsd-plan-checker.md', eraseAll('Dimension 5'), 'planner-estimate-emission', /Dimension 5 \(Scope Sanity\) must consult the emitted estimate \(no Dimension 5 section\)/],
        ['the estimate gone from Dimension 5 of the plan-checker', 'agents/gsd-plan-checker.md', (text) => {
          const at = text.indexOf('Dimension 5');
          return text.slice(0, at) + text.slice(at, at + 2500).replace(/estimate/gi, 'figure') + text.slice(at + 2500);
        }, 'planner-estimate-emission', /Dimension 5 \(Scope Sanity\) must consult the emitted estimate/],
        ['the estimate row gone from plan-md.md', 'docs/reference/plan-md.md', erase(/\|\s*`estimate`\s*\|/g), 'planner-estimate-emission', /plan-md\.md must document `estimate`/],
        ['the estimate row of plan-md.md no longer says No', 'docs/reference/plan-md.md', (text) => text.split('\n').map((line) => (/\|\s*`estimate`\s*\|/.test(line) ? line.replace(/\bNo\b/g, 'Yes') : line)).join('\n'), 'planner-estimate-emission', /estimate must be documented as NOT required/],
        ['the smart_zone_tokens default gone from the manifest', 'gsd-core/bin/shared/config-defaults.manifest.json', (text) => text.replace(/"smart_zone_tokens":\s*\d+/, '"smart_zone_tokens": 0'), 'planner-estimate-emission', /the manifest must ship a usable smart_zone_tokens default/],
        ['the manifest no longer valid JSON', 'gsd-core/bin/shared/config-defaults.manifest.json', (text) => `${text}}`, 'planner-estimate-emission', /the manifest is not valid JSON/],
        ['the documented smart_zone_tokens default drifted in CONFIGURATION.md', 'docs/CONFIGURATION.md', (text) => text.split('\n').map((line) => (line.includes('workflow.smart_zone_tokens') ? line.replace(/\d[\d,_]*/g, '1') : line)).join('\n'), 'planner-estimate-emission', /the documented smart_zone_tokens default must be the shipped one/],
        ['smart_zone_tokens undocumented in CONFIGURATION.md', 'docs/CONFIGURATION.md', eraseAll('workflow.smart_zone_tokens'), 'planner-estimate-emission', /the documented smart_zone_tokens default must be the shipped one \(CONFIGURATION\.md does not document the key\)/],
        // edge-probe-planner-contract
        ['the SPEC_PATH resolution gone from plan-phase', 'gsd-core/workflows/plan-phase.md', eraseAll('SPEC_PATH=$(_gsd_field "$INIT" spec_path)'), 'edge-probe-planner-contract', /plan-phase\.md must resolve SPEC_PATH from the init payload spec_path/],
        ['the SPEC_PATH entry gone from the planner required_reading block', 'gsd-core/workflows/plan-phase.md', eraseAll('{SPEC_PATH}'), 'edge-probe-planner-contract', /the planner <required_reading> block \(containing \{UI_SPEC_PATH\}\) must also contain \{SPEC_PATH\}/],
        ['the Edge Coverage label gone from the SPEC_PATH entry', 'gsd-core/workflows/plan-phase.md', erase(/([{]SPEC_PATH[}][^\n]{0,500})Edge Coverage/), 'edge-probe-planner-contract', /\{SPEC_PATH\} entry in the planner files_to_read must be labelled as carrying the ## Edge Coverage section/],
        ['the SPEC resolution moved into the AI-SPEC artifact section', 'gsd-core/workflows/plan-phase.md', within('## 4.5. Resolve AI-SPEC Artifact', '\n## ', (section) => `${section}\nSPEC_PATH=$(_gsd_field "$INIT" spec_path)\n`), 'edge-probe-planner-contract', /SPEC_FILE resolution must NOT live inside the §4\.5 AI-SPEC artifact block/],
        ['the AI-SPEC artifact section renamed in plan-phase', 'gsd-core/workflows/plan-phase.md', eraseAll('## 4.5. Resolve AI-SPEC Artifact'), 'edge-probe-planner-contract', /non-AI phases \(no "## 4\.5\. Resolve AI-SPEC Artifact" section\)/],
        ['the downstream_consumer block renamed in plan-phase', 'gsd-core/workflows/plan-phase.md', eraseAll('<downstream_consumer>'), 'edge-probe-planner-contract', /the <downstream_consumer> block must reference ## Edge Coverage \(no <downstream_consumer> block\)/],
        ['Edge Coverage gone from the downstream_consumer block', 'gsd-core/workflows/plan-phase.md', within('<downstream_consumer>', '</downstream_consumer>', erase(/##\s*Edge Coverage/g)), 'edge-probe-planner-contract', /the <downstream_consumer> block must reference ## Edge Coverage/],
        ['must_haves.truths gone from the downstream_consumer block', 'gsd-core/workflows/plan-phase.md', within('<downstream_consumer>', '</downstream_consumer>', erase(/must_haves\.truths/g)), 'edge-probe-planner-contract', /the <downstream_consumer> block must reference must_haves\.truths as the lift target/],
        ['the Edge Coverage lift instruction back in the orphaned planner prompt', 'gsd-core/templates/planner-subagent-prompt.md', append('## Edge Coverage'), 'edge-probe-planner-contract', /planner-subagent-prompt\.md is not loaded at runtime/],
        ['the quality_gate item gone from plan-phase', 'gsd-core/workflows/plan-phase.md', (text) => {
          const at = text.lastIndexOf('<quality_gate>');
          const end = text.indexOf('</quality_gate>', at);
          return text.slice(0, at) + text.slice(at, end).replace(/resolved.{0,500}edge.{0,500}must_haves/gi, 'checked') + text.slice(end);
        }, 'edge-probe-planner-contract', /the planner quality_gate must contain a checklist item tying resolved edges to must_haves/],
        // anti-pattern-enforcement
        ['the Severity column gone from pause-work', 'gsd-core/workflows/pause-work.md', erase(/Severity|severity/g), 'anti-pattern-enforcement', /the template must include a Severity column in the anti-patterns table/],
        ['blocking gone from pause-work', 'gsd-core/workflows/pause-work.md', eraseAll('blocking'), 'anti-pattern-enforcement', /pause-work\.md must document "blocking" as a valid severity value/],
        ['advisory gone from pause-work', 'gsd-core/workflows/pause-work.md', eraseAll('advisory'), 'anti-pattern-enforcement', /pause-work\.md must document "advisory" as a valid severity value/],
        ['the understanding check gone from pause-work', 'gsd-core/workflows/pause-work.md', eraseAll('understanding check'), 'anti-pattern-enforcement', /pause-work\.md must explain that blocking anti-patterns trigger an understanding check at resume/],
        ['.continue-here.md gone from discuss-phase', 'gsd-core/workflows/discuss-phase.md', eraseAll('.continue-here.md'), 'anti-pattern-enforcement', /discuss-phase\.md must check \.continue-here\.md before proceeding/],
        ['blocking gone from discuss-phase', 'gsd-core/workflows/discuss-phase.md', eraseAll('blocking'), 'anti-pattern-enforcement', /discuss-phase\.md must check for blocking anti-patterns/],
        ['the understanding demonstration gone from discuss-phase', 'gsd-core/workflows/discuss-phase.md', eraseAll('demonstrate understanding'), 'anti-pattern-enforcement', /discuss-phase\.md must include a mandatory understanding verification step/],
        ['the first understanding question gone from discuss-phase', 'gsd-core/workflows/discuss-phase.md', eraseAll('What is this anti-pattern'), 'anti-pattern-enforcement', /discuss-phase\.md must ask "What is this anti-pattern\?"/],
        ['the second understanding question gone from discuss-phase', 'gsd-core/workflows/discuss-phase.md', eraseAll('How did it manifest'), 'anti-pattern-enforcement', /discuss-phase\.md must ask "How did it manifest\?"/],
        ['the third understanding question gone from discuss-phase', 'gsd-core/workflows/discuss-phase.md', eraseAll('structural mechanism'), 'anti-pattern-enforcement', /discuss-phase\.md must ask "What structural mechanism prevents it\?"/],
        ['the mandatory marker gone from discuss-phase', 'gsd-core/workflows/discuss-phase.md', eraseAll('MANDATORY'), 'anti-pattern-enforcement', /discuss-phase\.md must indicate that the blocking anti-pattern understanding check cannot be skipped/],
        ['.continue-here.md gone from execute-phase', 'gsd-core/workflows/execute-phase.md', eraseAll('.continue-here.md'), 'anti-pattern-enforcement', /execute-phase\.md must check \.continue-here\.md before proceeding/],
        ['blocking gone from execute-phase', 'gsd-core/workflows/execute-phase.md', eraseAll('blocking'), 'anti-pattern-enforcement', /execute-phase\.md must check for blocking anti-patterns/],
        ['the understanding demonstration gone from execute-phase', 'gsd-core/workflows/execute-phase.md', eraseAll('demonstrate understanding'), 'anti-pattern-enforcement', /execute-phase\.md must include a mandatory understanding verification step/],
        ['the first understanding question gone from execute-phase', 'gsd-core/workflows/execute-phase.md', eraseAll('What is this anti-pattern'), 'anti-pattern-enforcement', /execute-phase\.md must ask "What is this anti-pattern\?"/],
        ['the second understanding question gone from execute-phase', 'gsd-core/workflows/execute-phase.md', eraseAll('How did it manifest'), 'anti-pattern-enforcement', /execute-phase\.md must ask "How did it manifest\?"/],
        ['the third understanding question gone from execute-phase', 'gsd-core/workflows/execute-phase.md', eraseAll('structural mechanism'), 'anti-pattern-enforcement', /execute-phase\.md must ask "What structural mechanism prevents it\?"/],
        ['the mandatory marker gone from execute-phase', 'gsd-core/workflows/execute-phase.md', eraseAll('MANDATORY'), 'anti-pattern-enforcement', /execute-phase\.md must indicate that the blocking anti-pattern understanding check cannot be skipped/],
        // executor-isolation-prompt-contract
        ['required_reading gone from the executor prompt', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', eraseAll('<required_reading>'), 'executor-isolation-prompt-contract', /the prompt must carry the required-reading contract/],
        ['the explicit plan path gone from the executor prompt', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', eraseAll('{phase_dir}/{plan_file}'), 'executor-isolation-prompt-contract', /the prompt must name the explicit plan path/],
        ['project_rel gone from the executor prompt', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', eraseAll('{project_rel}'), 'executor-isolation-prompt-contract', /project context is required reading/],
        ['STATE.md back in the executor required reading (#6388)', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', swap('- ${PROJECT_ROOT}/{config_rel} (Config, if exists)', '- ${PROJECT_ROOT}/STATE.md (State)\n- ${PROJECT_ROOT}/{config_rel} (Config, if exists)'), 'executor-isolation-prompt-contract', /state is not required reading \(#6388\)/],
        ['the state_rel placeholder back in the executor prompt and its substitution instruction (#6388)', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', (text) => swap('`{project_rel}`, `{config_rel}`', '`{project_rel}`, `{state_rel}`, `{config_rel}`')(text).replace('```text\n', '```text\nState: {state_rel}\n'), 'executor-isolation-prompt-contract', /no \{state_rel\} placeholder is left to substitute \(#6388\)/],
        ['config_rel gone from the executor prompt', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', eraseAll('{config_rel}'), 'executor-isolation-prompt-contract', /config is required reading/],
        ['a root .planning/ literal in the executor prompt', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', (text) => text.replace('```text\n', '```text\n.planning/PROJECT.md\n'), 'executor-isolation-prompt-contract', /no root \.planning\/ literal in required reading/],
        ['execution_context gone from the executor prompt', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', eraseAll('<execution_context>'), 'executor-isolation-prompt-contract', /the prompt must carry an execution_context block/],
        ['execute-plan.md gone from the executor prompt', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', eraseAll('execute-plan.md'), 'executor-isolation-prompt-contract', /execute-plan\.md must be embedded/],
        ['worktree-path-safety.md gone from the executor prompt', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', eraseAll('worktree-path-safety.md'), 'executor-isolation-prompt-contract', /worktree path safety must be embedded/],
        ['skipped_gitignored gone from the executor prompt', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', eraseAll('skipped_gitignored'), 'executor-isolation-prompt-contract', /skipped_gitignored must be named as an intentional success path/],
        ['the git add -f ban gone from the executor prompt', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', eraseAll('git add -f'), 'executor-isolation-prompt-contract', /force-staging must be explicitly forbidden/],
        ['the bare created-and-committed criterion back in the executor prompt', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', (text) => text.replace('```text\n', '```text\n- SUMMARY.md created AND committed\n'), 'executor-isolation-prompt-contract', /the unconditional "created AND committed" criterion that drove git add -f must not appear bare/],
        ['the role definition gone from the executor prompt', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', eraseAll('agents/gsd-executor.md'), 'executor-isolation-prompt-contract', /the role definition file must be named as an embedded source/],
        ['the step pointer gone from the executor prompt', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', erase(/steps\s{0,20}0\/0a\/0b/g), 'executor-isolation-prompt-contract', /the per-commit HEAD\/cwd-drift\/path-guard discipline must be pointed at/],
        ['prior_wave_summaries gone from the executor prompt', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', eraseAll('prior_wave_summaries'), 'executor-isolation-prompt-contract', /prior-wave SUMMARY files must be required reading/],
        ['AGENT_SKILLS gone from the executor prompt', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', eraseAll('${AGENT_SKILLS}'), 'executor-isolation-prompt-contract', /the gsd-executor persona variable must be spliced into the prompt/],
        ['the substitution instruction gone', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', eraseAll('Before running each bash block below'), 'executor-isolation-prompt-contract', /the substitution instruction must name every placeholder any fenced block of the fragment uses \(the substitution instruction does not exist\)/],
        ['the template marker moved into a bash block', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', append('```bash\necho "<objective>"\n```'), 'executor-isolation-prompt-contract', /the template text must sit in no bash block/],
        ['the file-writing instruction gone', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', eraseAll('with your file-writing tool and never through the shell'), 'executor-isolation-prompt-contract', /the template is written with the file tool, never through the shell/],
        ['a guard marker gone from the template', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', eraseAll('Inline the actual contents'), 'executor-isolation-prompt-contract', /the template must carry the two markers that only the read-and-check guards look for/],
        ['the conditional embed line gone from the template', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', eraseAll('${TDD_APPLICABLE ? "- tdd.md" : ""}'), 'executor-isolation-prompt-contract', /the template must hold the conditional embed line with its trailing comment/],
        ['the whole-line replacement instruction gone', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', eraseAll('replace the whole line, its trailing `#` comment included, with `- tdd.md` when the verdict is `true` and with nothing otherwise'), 'executor-isolation-prompt-contract', /the instruction must replace the whole conditional line/],
        ['the substitution list gone from the dispatch fragment', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', eraseAll("Substitute this plan's"), 'executor-isolation-prompt-contract', /the fragment's substitution list must name at least the 7 known placeholders/],
        ['the wave manifest name gone from execute-phase', 'gsd-core/workflows/execute-phase.md', eraseAll('mktemp "${TMPDIR:-/tmp}/gsd-worktree-wave-XXXXXX"'), 'executor-isolation-prompt-contract', /the manifest must be named gsd-worktree-wave-XXXXXX/],
        ['the orchestrator-worktree bullet gone from the quick-batch step', 'gsd-core/workflows/quick-batch/steps/worktree-dispatch.md', eraseAll('**`isolation == "orchestrator-worktree"`:**'), 'executor-isolation-prompt-contract', /marker .*orchestrator-worktree.* not found/],
        ['a placeholder gone from the quick-batch bullet', 'gsd-core/workflows/quick-batch/steps/worktree-dispatch.md', within('**`isolation == "orchestrator-worktree"`:**', '**`isolation == "none"`:**', eraseAll('{phase_dir}')), 'executor-isolation-prompt-contract', /the quick-batch step must name every placeholder the reused fragment substitutes/],
        ['a placeholder with neither a value nor a not-applicable in the quick-batch bullet', 'gsd-core/workflows/quick-batch/steps/worktree-dispatch.md', within('**`isolation == "orchestrator-worktree"`:**', '**`isolation == "none"`:**', (bullet) => bullet.replace(/`\{plan_file\}`\s{0,20}=\s{0,20}`[^`\n]{1,80}`/, '{plan_file}').replace(/`\{plan_file\}`[^\n]{0,500}\b(?:is|are) not applicable\b/, '{plan_file}')), 'executor-isolation-prompt-contract', /has neither a mapped value nor a stated "not applicable"/],
        ['the quick item header gone from the quick-batch bullet', 'gsd-core/workflows/quick-batch/steps/worktree-dispatch.md', eraseAll('Execute quick item ${quick_id}'), 'executor-isolation-prompt-contract', /the prompt header for a quick item must be stated/],
        ['the omitted dispatch marker gone from the quick-batch bullet', 'gsd-core/workflows/quick-batch/steps/worktree-dispatch.md', within('**`isolation == "orchestrator-worktree"`:**', '**`isolation == "none"`:**', erase(/omit[^\n]{0,500}\[gsd:dispatch/gi)), 'executor-isolation-prompt-contract', /the \[gsd:dispatch \.\.\.\] marker line must be stated as omitted for a quick item/],
        ['the plan_padded mapping gone from the quick-batch bullet', 'gsd-core/workflows/quick-batch/steps/worktree-dispatch.md', erase(/`\{plan_padded\}`\s{0,20}=\s{0,20}`\$\{quick_id\}`/g), 'executor-isolation-prompt-contract', /\{plan_padded\} must map to the quick id/],
        ['the worker-record summary path gone from the quick-batch bullet', 'gsd-core/workflows/quick-batch/steps/worktree-dispatch.md', eraseAll('${ITEM_DIR}/${quick_id}-SUMMARY.md'), 'executor-isolation-prompt-contract', /the worker-record summary path must be spelled out/],
        ['the reconciliation heading gone from verify-work', "gsd-core/workflows/verify-work.md", eraseAll('Commit-claim reconciliation'), "summary-commit-verification", /no Commit-claim reconciliation block/],
        ['the #4670 marker gone from verify-work', "gsd-core/workflows/verify-work.md", eraseAll('#4670'), "summary-commit-verification", /no #4670 section/],
        ['the planner estimate block with only two fields', 'agents/gsd-planner.md', (text) => text.replace(/^(\s{1,20})confidence:[^\n]*\n/m, ''), 'planner-estimate-emission', /the estimate block must carry tokens, tasks and confidence/],
        ['the planner with an unterminated frontmatter fence pair', 'agents/gsd-planner.md', (text) => text.split('\n---\n').join('\n----\n'), 'planner-estimate-emission', /the template must declare an `estimate:` block/],
        ['no required_reading block with UI_SPEC_PATH in plan-phase', 'gsd-core/workflows/plan-phase.md', eraseAll('{UI_SPEC_PATH}'), 'edge-probe-planner-contract', /no planner <required_reading> block holds \{UI_SPEC_PATH\}/],
        ['the fallback only inside the gated body of discuss-phase-assumptions', 'gsd-core/workflows/discuss-phase-assumptions.md', (text) => within("<!-- gsd:section id=\"auto-advance-dispatch\"", "<!-- /gsd:section -->", (body) => `${body}${"End here — `confirm_creation` already ran; do not route back to it."}\n`)(eraseAll("End here — `confirm_creation` already ran; do not route back to it.")(text)), 'section-marker-inversion-guard', /the flag-absent fallback must be part of an always-composed gap section/],
        ['the fallback duplicated inside the gated body of discuss-phase-assumptions', 'gsd-core/workflows/discuss-phase-assumptions.md', within("<!-- gsd:section id=\"auto-advance-dispatch\"", "<!-- /gsd:section -->", (body) => `${body}${"End here — `confirm_creation` already ran; do not route back to it."}\n`), 'section-marker-inversion-guard', /the flag-absent fallback must live OUTSIDE the gated marker/],
        ['the gated section of discuss-phase-assumptions with another when condition', 'gsd-core/workflows/discuss-phase-assumptions.md', swap('when="state:auto-advance-active"', 'when="state:other"'), 'section-marker-inversion-guard', /the gated section must exist and be when="state:auto-advance-active"/],
        ['the MVP note only inside the gated body of verify-work', "gsd-core/workflows/verify-work.md", (text) => within("<!-- gsd:section id=\"mvp-uat-framing\"", "<!-- /gsd:section -->", (body) => `${body}${"When `MVP_MODE=false` (mode is null, absent, or the phase has no `**Mode:**` line in ROADMAP.md), fall back to the standard UAT generation path — no behavioral change."}\n`)(eraseAll("When `MVP_MODE=false` (mode is null, absent, or the phase has no `**Mode:**` line in ROADMAP.md), fall back to the standard UAT generation path — no behavioral change.")(text)), 'section-marker-inversion-guard', /the MVP=false fallback note must be present in the unconditionally-composed gap text/],
        ['the MVP note duplicated inside the gated body of verify-work', "gsd-core/workflows/verify-work.md", within("<!-- gsd:section id=\"mvp-uat-framing\"", "<!-- /gsd:section -->", (body) => `${body}${"When `MVP_MODE=false` (mode is null, absent, or the phase has no `**Mode:**` line in ROADMAP.md), fall back to the standard UAT generation path — no behavioral change."}\n`), 'section-marker-inversion-guard', /gating mvp-uat-framing away \(MVP_MODE=false\) must not delete the note that documents exactly that fallback/],
        ['the gated section of verify-work with another when condition', "gsd-core/workflows/verify-work.md", swap('when="state:phase-mvp-mode"', 'when="state:other"'), 'section-marker-inversion-guard', /the gated section must exist and be when="state:phase-mvp-mode"/],
        ['the gated section of discuss-phase-assumptions twice', 'gsd-core/workflows/discuss-phase-assumptions.md', (text) => `${text}\n${"<!-- gsd:section id=\"auto-advance-dispatch\""} when="state:auto-advance-active" -->\nx\n${"<!-- /gsd:section -->"}\n`, 'section-marker-inversion-guard', /the sections of the workflow cannot be parsed: workflow-fragments: duplicate section id "auto-advance-dispatch"/],
        ['the confidence enumeration offers a value the parser rejects', 'agents/gsd-planner.md', swap('# low | med | high', '# low | medium | high'), 'planner-estimate-emission', /the planner offers medium but CONFIDENCE_VALUES does not accept it/],
        ['the confidence line enumerates no allowed values', 'agents/gsd-planner.md', (text) => text.replace(/^(\s+confidence: low)\s+#[^\n]*/m, '$1'), 'planner-estimate-emission', /the confidence line must enumerate the allowed values/],
        ['the confidence line gone from the template', 'agents/gsd-planner.md', erase(/^\s+confidence:[^\n]*\n/m), 'planner-estimate-emission', /\(the template must show the confidence field\)/],
        ['tokens gone from the planner estimate block', 'agents/gsd-planner.md', erase(/^(\s+)tokens:/gm), 'planner-estimate-emission', /the estimate block must carry tokens, tasks and confidence \(missing tokens\)/],
        ['confidence gone from the planner estimate block', 'agents/gsd-planner.md', erase(/^(\s+)confidence:/gm), 'planner-estimate-emission', /the estimate block must carry tokens, tasks and confidence \(missing confidence\)/],
        ['the manifest is JSON null', 'gsd-core/bin/shared/config-defaults.manifest.json', () => 'null', 'planner-estimate-emission', /the manifest must ship a usable smart_zone_tokens default \(workflow\.smart_zone_tokens is undefined\)/],
        ['the manifest is an array', 'gsd-core/bin/shared/config-defaults.manifest.json', () => '[]', 'planner-estimate-emission', /workflow\.smart_zone_tokens is undefined/],
        ['the manifest has no workflow mapping', 'gsd-core/bin/shared/config-defaults.manifest.json', () => '{}', 'planner-estimate-emission', /workflow\.smart_zone_tokens is undefined/],
        ['the manifest workflow is a number', 'gsd-core/bin/shared/config-defaults.manifest.json', () => '{"workflow": 5}', 'planner-estimate-emission', /workflow\.smart_zone_tokens is undefined/],
        ['the manifest workflow is a list', 'gsd-core/bin/shared/config-defaults.manifest.json', () => '{"workflow": []}', 'planner-estimate-emission', /workflow\.smart_zone_tokens is undefined/],
        ['the manifest smart_zone_tokens is not an integer', 'gsd-core/bin/shared/config-defaults.manifest.json', () => '{"workflow": {"smart_zone_tokens": 1.5}}', 'planner-estimate-emission', /workflow\.smart_zone_tokens is 1\.5/],
        ['the manifest smart_zone_tokens is negative', 'gsd-core/bin/shared/config-defaults.manifest.json', () => '{"workflow": {"smart_zone_tokens": -1}}', 'planner-estimate-emission', /workflow\.smart_zone_tokens is -1/],
        ['a bash block using a placeholder the instruction does not name', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', append('```bash\necho {zz_unnamed}\n```'), 'executor-isolation-prompt-contract', /a placeholder of a fenced block is missing from the instruction/],
        ['a bash block holding the mcp_tools marker', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', append('```bash\necho "<mcp_tools>"\n```'), 'executor-isolation-prompt-contract', /<mcp_tools> sits in a bash block/],
        ['a bash block holding the dispatch marker', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', append('```bash\necho "[gsd:dispatch"\n```'), 'executor-isolation-prompt-contract', /\[gsd:dispatch sits in a bash block/],
        ['the TDD_APPLICABLE marker gone from the template', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', eraseAll('${TDD_APPLICABLE'), 'executor-isolation-prompt-contract', /the template does not carry \$\{TDD_APPLICABLE/],
        ['the Inline marker gone from the template', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', eraseAll('Inline the actual contents'), 'executor-isolation-prompt-contract', /the template does not carry Inline the actual contents/],
        ['the instruction names no placeholders', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', (text) => text.split('\n').map((line) => (line.includes('Before running each bash block below') ? 'Before running each bash block below' : line)).join('\n'), 'executor-isolation-prompt-contract', /the instruction names no placeholders/],
        ['the fragment holds no bash blocks', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', swap('```bash', '```sh'), 'executor-isolation-prompt-contract', /the fragment holds no bash blocks/],
        ['the closing fence of the one text fence gone', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', (text) => text.slice(0, text.indexOf('```text\n') + 8) + 'the prompt never closes\n', 'executor-isolation-prompt-contract', /the text fence must close/],
        ['the Parse --auto resolver gone from discuss-phase-assumptions', 'gsd-core/workflows/discuss-phase-assumptions.md', eraseAll('Parse `--auto` flag from $ARGUMENTS'), 'section-marker-inversion-guard', /"Parse `--auto` flag from \$ARGUMENTS" is not in the gap text/],
        ['the config-set resolver gone from discuss-phase-assumptions (the gap text)', 'gsd-core/workflows/discuss-phase-assumptions.md', eraseAll('gsd_run query config-set workflow._auto_chain_active'), 'section-marker-inversion-guard', /"gsd_run query config-set workflow\._auto_chain_active" is not in the gap text/],
        ['the AUTO_MODE resolver gone from discuss-phase-assumptions', 'gsd-core/workflows/discuss-phase-assumptions.md', eraseAll('AUTO_MODE=$(gsd_run query check auto-mode --pick active'), 'section-marker-inversion-guard', /"AUTO_MODE=\$\(gsd_run query check auto-mode --pick active" is not in the gap text/],

        ['tasks gone from the planner estimate block', 'agents/gsd-planner.md', erase(/^(\s+)tasks:/gm), 'planner-estimate-emission', /the estimate block must carry tokens, tasks and confidence \(missing tasks\)/],
        ['no indent before confidence: in the planner template', 'agents/gsd-planner.md', (text) => text.replace(/^ {2}confidence:/m, 'confidence:'), 'planner-estimate-emission', /the estimate block must carry tokens, tasks and confidence \(missing confidence\)/],
        ['no indent before confidence: leaves the confidence line unshown', 'agents/gsd-planner.md', (text) => text.replace(/^ {2}confidence:/m, 'confidence:'), 'planner-estimate-emission', /\(the template must show the confidence field\)/],
        ['the gated section of discuss-phase-assumptions with no matching id', 'gsd-core/workflows/discuss-phase-assumptions.md', swap('id="auto-advance-dispatch"', 'id="auto-advance-other"'), 'section-marker-inversion-guard', /expected exactly one parsed section with id "auto-advance-dispatch", found 0/],
        ['the Step 5.6 of spec-phase as the last section', 'gsd-core/workflows/spec-phase.md', (text) => text.slice(0, text.indexOf('## Step 5.6') + 12), 'prohibition-probe.spec-phase-contract', /closing marker .* not found/],
        ['a marker on the last line of an unclosed bash block', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', (text) => `${text}\n\`\`\`bash\necho "<objective>"`, 'executor-isolation-prompt-contract', /<objective> sits in a bash block/],
        ['a marker in an upper-case BASH block', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', append('```BASH\necho "<objective>"\n```'), 'executor-isolation-prompt-contract', /<objective> sits in a bash block/],
        ['a marker in a bash block with a title word', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', append('```bash title=x\necho "<mcp_tools>"\n```'), 'executor-isolation-prompt-contract', /<mcp_tools> sits in a bash block/],
        // debugger-rca-branching
        ['the RCA reference unlinked from the debugger agent', 'agents/gsd-debugger.md', swap('@~/.claude/gsd-core/references/debugger-rca-branching.md', '@~/.claude/gsd-core/references/rca.md'), 'debugger-rca-branching', /gsd-debugger\.md must @-include the RCA-branching reference from Phase 2 \(or the reasoning checkpoint\)/],
        ['candidate_causes gone from the reasoning checkpoint', 'agents/gsd-debugger.md', swap('candidate_causes', 'candidates'), 'debugger-rca-branching', /the reasoning_checkpoint must include a candidate_causes field \(the >=2-category branches\)/],
        ['and_gate gone from the reasoning checkpoint', 'agents/gsd-debugger.md', swap('and_gate', 'gate'), 'debugger-rca-branching', /the reasoning_checkpoint must include an and_gate field \(the AND-gate answer\)/],
        ['the code category gone from the RCA reference', 'gsd-core/references/debugger-rca-branching.md', erase(/^- \*\*code\*\*/gm), 'debugger-rca-branching', /the reference must document the code category/],
        ['the config category gone from the RCA reference', 'gsd-core/references/debugger-rca-branching.md', erase(/^- \*\*config\*\*/gm), 'debugger-rca-branching', /the reference must document the config category/],
        ['the environment category gone from the RCA reference', 'gsd-core/references/debugger-rca-branching.md', erase(/^- \*\*environment\*\*/gm), 'debugger-rca-branching', /the reference must document the environment category/],
        ['the data category gone from the RCA reference', 'gsd-core/references/debugger-rca-branching.md', erase(/^- \*\*data\*\*/gm), 'debugger-rca-branching', /the reference must document the data category/],
        ['the Ishikawa branching rule gone from the RCA reference', 'gsd-core/references/debugger-rca-branching.md', swap('Ishikawa (fishbone)', 'Cause analysis'), 'debugger-rca-branching', /the reference must require branching across >=2 categories \(Ishikawa\/fishbone\)/],
        ['the single-cause bias failure mode gone from the RCA reference', 'gsd-core/references/debugger-rca-branching.md', erase(/5-Whys single-cause\s{1,20}bias/g), 'debugger-rca-branching', /the reference must name the 5-Whys \/ single-cause bias failure mode being guarded against/],
        ['the AND-gate check gone from the RCA reference', 'gsd-core/references/debugger-rca-branching.md', swap('AND-gate check', 'gate check'), 'debugger-rca-branching', /the reference must name the AND-gate check/],
        ['the AND-gate question gone from the RCA reference', 'gsd-core/references/debugger-rca-branching.md', swap('Could this failure require more than one contributing condition simultaneously?', 'Could this fail?'), 'debugger-rca-branching', /the reference must ask whether the failure requires multiple contributing conditions simultaneously/],
        ['the set-valued root_cause note gone from the RCA reference', 'gsd-core/references/debugger-rca-branching.md', erase(/root_cause[^\n]{0,500}one cause OR a small\s{1,20}set of contributing causes/g), 'debugger-rca-branching', /the reference must document that root_cause can record multiple contributing causes when the AND-gate fires/],
        ['the backward-compatibility note gone from the RCA reference', 'gsd-core/references/debugger-rca-branching.md', erase(/single-cause sessions are\s{1,20}byte-for-byte unchanged|shape unchanged/g), 'debugger-rca-branching', /the reference must document that single-cause sessions are unaffected \(backward compatible\)/],
        ['root_cause gone from the DEBUG.md template', 'gsd-core/templates/DEBUG.md', swap('root_cause', 'cause'), 'debugger-rca-branching', /the template must still have the root_cause field/],
        ['the set note gone from the DEBUG.md root_cause field', 'gsd-core/templates/DEBUG.md', erase(/root_cause:[^\n]{0,500}small set of contributing causes/g), 'debugger-rca-branching', /the DEBUG\.md root_cause field must note it may hold one or more contributing causes \(per RCA branching\)/],
        ['the single-cause bias note gone from the debugger philosophy', 'gsd-core/references/debugger-philosophy.md', erase(/single[\s-]?cause|5-?\s{0,20}whys|root[\s-]?cause bias/gi), 'debugger-rca-branching', /debugger-philosophy\.md must note the single-cause-bias \/ 5-Whys trap alongside the existing cognitive-bias guidance/],

        // few-shot-calibration
        ['the plan-checker component gone from its frontmatter', 'gsd-core/references/few-shot-examples/plan-checker.md', swap('component: plan-checker', 'component: other'), 'few-shot-calibration', /plan-checker\.md frontmatter must name its component/],
        ['the plan-checker component moved from the frontmatter to the body', 'gsd-core/references/few-shot-examples/plan-checker.md', (text) => text.replace('component: plan-checker\n', '') + '\ncomponent: plan-checker\n', 'few-shot-calibration', /plan-checker\.md frontmatter must name its component/],
        ['the verifier component gone from its frontmatter', 'gsd-core/references/few-shot-examples/verifier.md', swap('component: verifier', 'component: other'), 'few-shot-calibration', /verifier\.md frontmatter must name its component/],
        ['the plan-checker version gone from its frontmatter', 'gsd-core/references/few-shot-examples/plan-checker.md', erase(/^version: \d+\n/m), 'few-shot-calibration', /plan-checker\.md frontmatter must carry a numeric version/],
        ['the plan-checker version not numeric', 'gsd-core/references/few-shot-examples/plan-checker.md', (text) => text.replace(/^version: \d+\n/m, 'version: next\n'), 'few-shot-calibration', /plan-checker\.md frontmatter must carry a numeric version/],
        ['the plan-checker calibration date gone from its frontmatter', 'gsd-core/references/few-shot-examples/plan-checker.md', erase(/^last_calibrated: [^\n]+\n/m), 'few-shot-calibration', /plan-checker\.md frontmatter must carry a last_calibrated date/],
        ['the plan-checker calibration date not a date', 'gsd-core/references/few-shot-examples/plan-checker.md', (text) => text.replace(/^last_calibrated: [^\n]+\n/m, 'last_calibrated: March 2026\n'), 'few-shot-calibration', /plan-checker\.md frontmatter must carry a last_calibrated date/],
        ['the verifier calibration date gone from its frontmatter', 'gsd-core/references/few-shot-examples/verifier.md', erase(/^last_calibrated: [^\n]+\n/m), 'few-shot-calibration', /verifier\.md frontmatter must carry a last_calibrated date/],
        ['a version key renamed in the plan-checker frontmatter', 'gsd-core/references/few-shot-examples/plan-checker.md', (text) => text.replace(/^version:/m, 'calibration_version:'), 'few-shot-calibration', /plan-checker\.md frontmatter must carry a numeric version/],
        ['a component key renamed in the plan-checker frontmatter', 'gsd-core/references/few-shot-examples/plan-checker.md', (text) => text.replace(/^component:/m, 'subcomponent:'), 'few-shot-calibration', /plan-checker\.md frontmatter must name its component/],
        ['a component value on the line after its key', 'gsd-core/references/few-shot-examples/plan-checker.md', swap('component: plan-checker', 'component:\nplan-checker'), 'few-shot-calibration', /plan-checker\.md frontmatter must name its component/],
        ['a version value on the line after its key', 'gsd-core/references/few-shot-examples/plan-checker.md', (text) => text.replace(/^version: /m, 'version:\n'), 'few-shot-calibration', /plan-checker\.md frontmatter must carry a numeric version/],
        ['a date value on the line after its key', 'gsd-core/references/few-shot-examples/plan-checker.md', (text) => text.replace(/^last_calibrated: /m, 'last_calibrated:\n'), 'few-shot-calibration', /plan-checker\.md frontmatter must carry a last_calibrated date/],
        ['a fifth example in the plan-checker reference', 'gsd-core/references/few-shot-examples/plan-checker.md', append('### Example 9'), 'few-shot-calibration', /plan-checker\.md must contain exactly 4 examples/],
        ['a third example gone from the plan-checker reference', 'gsd-core/references/few-shot-examples/plan-checker.md', erase(/^### Example \d+/m), 'few-shot-calibration', /plan-checker\.md must contain exactly 4 examples/],
        ['an eighth example in the verifier reference', 'gsd-core/references/few-shot-examples/verifier.md', append('### Example 9'), 'few-shot-calibration', /verifier\.md must contain exactly 7 examples/],
        ['an example gone from the verifier reference', 'gsd-core/references/few-shot-examples/verifier.md', erase(/^### Example 3/m), 'few-shot-calibration', /verifier\.md must contain exactly 7 examples/],
        ['the plan-checker Negative section before the Positive one', 'gsd-core/references/few-shot-examples/plan-checker.md', (text) => text.replace('## Positive Examples', '@@P@@').replace('## Negative Examples', '## Positive Examples').replace('@@P@@', '## Negative Examples'), 'few-shot-calibration', /plan-checker\.md must have a Positive Examples section before a Negative Examples section/],
        ['the plan-checker Positive section renamed', 'gsd-core/references/few-shot-examples/plan-checker.md', swap('## Positive Examples', '## Good Examples'), 'few-shot-calibration', /no Positive Examples section/],
        ['the verifier Negative section renamed', 'gsd-core/references/few-shot-examples/verifier.md', swap('## Negative Examples', '## Bad Examples'), 'few-shot-calibration', /no Negative Examples section/],
        ['a WHY annotation gone from a plan-checker example', 'gsd-core/references/few-shot-examples/plan-checker.md', erase(/^\*\*Why this is (good|bad):\*\*/m), 'few-shot-calibration', /every plan-checker example must have a WHY annotation/],
        ['a WHY annotation gone from a verifier example', 'gsd-core/references/few-shot-examples/verifier.md', erase(/^\*\*Why this is (good|bad):\*\*/m), 'few-shot-calibration', /every verifier example must have a WHY annotation/],
        ['an Input block gone from a plan-checker example', 'gsd-core/references/few-shot-examples/plan-checker.md', erase(/^\*\*Input:\*\*/m), 'few-shot-calibration', /plan-checker examples must include Input blocks/],
        ['an Output block gone from a plan-checker example', 'gsd-core/references/few-shot-examples/plan-checker.md', erase(/^\*\*Output:\*\*/m), 'few-shot-calibration', /plan-checker examples must include Output blocks/],
        ['an Input block gone from a verifier example', 'gsd-core/references/few-shot-examples/verifier.md', erase(/^\*\*Input:\*\*/m), 'few-shot-calibration', /verifier examples must include Input blocks/],
        ['an Output block gone from a verifier example', 'gsd-core/references/few-shot-examples/verifier.md', erase(/^\*\*Output:\*\*/m), 'few-shot-calibration', /verifier examples must include Output blocks/],
        ['the gap patterns heading gone from the verifier reference', 'gsd-core/references/few-shot-examples/verifier.md', swap('## Calibration-Derived Gap Patterns', '## Gap Patterns'), 'few-shot-calibration', /verifier\.md must include the calibration-derived gap patterns table/],
        ['Missing wiring gone from the verifier gap patterns', 'gsd-core/references/few-shot-examples/verifier.md', swap('Missing wiring', 'Unconnected code'), 'few-shot-calibration', /the gap patterns table must name Missing wiring/],
        ['Missing tests gone from the verifier gap patterns', 'gsd-core/references/few-shot-examples/verifier.md', swap('Missing tests', 'Untested code'), 'few-shot-calibration', /the gap patterns table must name Missing tests/],
        ['the plan-checker reference gone from the plan-checker agent', 'agents/gsd-plan-checker.md', swap('@~/.claude/gsd-core/references/few-shot-examples/plan-checker.md', '@~/.claude/gsd-core/references/other.md'), 'few-shot-calibration', /gsd-plan-checker\.md must reference the plan-checker few-shot examples/],
        ['the verifier reference gone from the verifier agent', 'agents/gsd-verifier.md', swap('@~/.claude/gsd-core/references/few-shot-examples/verifier.md', '@~/.claude/gsd-core/references/other.md'), 'few-shot-calibration', /gsd-verifier\.md must reference the verifier few-shot examples/],

        // edge-probe-docs-fixtures
        ['the edge-probe tags gone from the reference doc', 'gsd-core/references/edge-probe.md', swap('```json edge-probe:', '```json probe:'), 'edge-probe-docs-fixtures', /the doc must embed one tagged fixture block for every expected-coverage\.json fixture \(count equality\)/],
        ['a tagged block naming a parent directory', 'gsd-core/references/edge-probe.md', (text) => text.replace('```json edge-probe:02-merge-intervals/expected-coverage.json', '```json edge-probe:../02-merge-intervals/expected-coverage.json'), 'edge-probe-docs-fixtures', /which is not a plain <dir>\/<file> fixture reference/],
        ['a tagged block naming a dot segment as its file', 'gsd-core/references/edge-probe.md', (text) => text.replace('```json edge-probe:02-merge-intervals/expected-coverage.json', '```json edge-probe:02-merge-intervals/..'), 'edge-probe-docs-fixtures', /which is not a plain <dir>\/<file> fixture reference/],
        ['a tagged block naming a path with a space', 'gsd-core/references/edge-probe.md', (text) => text.replace('```json edge-probe:02-merge-intervals/expected-coverage.json', '```json edge-probe:02 merge-intervals/expected-coverage.json'), 'edge-probe-docs-fixtures', /which is not a plain <dir>\/<file> fixture reference/],
        ['a tagged block naming three path parts', 'gsd-core/references/edge-probe.md', (text) => text.replace('```json edge-probe:02-merge-intervals/expected-coverage.json', '```json edge-probe:fixtures/02-merge-intervals/expected-coverage.json'), 'edge-probe-docs-fixtures', /which is not a plain <dir>\/<file> fixture reference/],
        ['a doc block that differs from its fixture', 'gsd-core/references/edge-probe.md', within('```json edge-probe:02-merge-intervals/expected-coverage.json', '\n```', swap('"R1"', '"R9"')), 'edge-probe-docs-fixtures', /the doc block edge-probe:02-merge-intervals\/expected-coverage\.json must parse and deep-equal its fixture file[^]{0,60}the doc block differs from the fixture/],
        ['a doc block that is not JSON', 'gsd-core/references/edge-probe.md', within('```json edge-probe:02-merge-intervals/expected-coverage.json', '\n```', swap('{', '(')), 'edge-probe-docs-fixtures', /the doc block edge-probe:02-merge-intervals\/expected-coverage\.json must parse and deep-equal its fixture file[^]{0,60}not valid JSON/],
        ['a block retagged to another file of its fixture directory', 'gsd-core/references/edge-probe.md', (text) => text.replace('```json edge-probe:01-round-half-even/expected-coverage.json', '```json edge-probe:01-round-half-even/requirements.json'), 'edge-probe-docs-fixtures', /no tagged block embeds the fixture "01-round-half-even\/expected-coverage\.json"/],
        ['a block retagged to a file that is not an expected-coverage fixture', 'gsd-core/references/edge-probe.md', (text) => text.replace('```json edge-probe:01-round-half-even/expected-coverage.json', '```json edge-probe:01-round-half-even/requirements.json'), 'edge-probe-docs-fixtures', /the tag "01-round-half-even\/requirements\.json" names no expected-coverage\.json fixture/],
        ['a block retagged to another fixture of the set', 'gsd-core/references/edge-probe.md', (text) => text.replace('```json edge-probe:01-round-half-even/expected-coverage.json', '```json edge-probe:02-merge-intervals/expected-coverage.json'), 'edge-probe-docs-fixtures', /no tagged block embeds the fixture "01-round-half-even\/expected-coverage\.json"/],
        ['a tag longer than 500 characters', 'gsd-core/references/edge-probe.md', (text) => text.replace('```json edge-probe:01-round-half-even/expected-coverage.json', `\`\`\`json edge-probe:${'a'.repeat(501)}`), 'edge-probe-docs-fixtures', /which is not a plain <dir>\/<file> fixture reference/],
        ['covered to resolved/explicit gone from the ADR', 'docs/adr/550-spec-phase-probe-contract.md', erase(/covered\b[^.]{0,500}resolved[^.]{0,500}explicit/gi), 'edge-probe-docs-fixtures', /the ADR must document covered -> \{resolved, explicit\}/],
        ['backstop to resolved/backstop gone from the ADR', 'docs/adr/550-spec-phase-probe-contract.md', erase(/backstop\b[^.]{0,500}resolved[^.]{0,500}backstop/gi), 'edge-probe-docs-fixtures', /the ADR must document backstop -> \{resolved, backstop\}/],
        ['the count-preserved statement gone from the ADR', 'docs/adr/550-spec-phase-probe-contract.md', erase(/count-for-count|count-preserved/gi), 'edge-probe-docs-fixtures', /the ADR must state coverage\.resolved is count-preserved across the migration/],
        ['the covered label gone from the spec template legend', 'gsd-core/templates/spec.md', erase(/\bcovered\b/gi), 'edge-probe-docs-fixtures', /the spec\.md Edge Coverage legend must render the "covered" label/],
        ['the backstop label gone from the spec template legend', 'gsd-core/templates/spec.md', erase(/\bbackstop\b/gi), 'edge-probe-docs-fixtures', /the spec\.md Edge Coverage legend must render the "backstop" label/],
        ['the dismissed label gone from the spec template legend', 'gsd-core/templates/spec.md', erase(/\bdismissed\b/gi), 'edge-probe-docs-fixtures', /the spec\.md Edge Coverage legend must render the "dismissed" label/],
        ['the unresolved label gone from the spec template legend', 'gsd-core/templates/spec.md', erase(/\bunresolved\b/gi), 'edge-probe-docs-fixtures', /the spec\.md Edge Coverage legend must render the "unresolved" label/],
        ['the resolved/explicit tier gone from the reference mapping', 'gsd-core/references/edge-probe.md', erase(/resolved`?\/`?explicit/gi), 'edge-probe-docs-fixtures', /the reference must name the resolved\/explicit tier in the mapping table/],
        ['the resolved/backstop tier gone from the reference mapping', 'gsd-core/references/edge-probe.md', erase(/resolved`?\/`?backstop/gi), 'edge-probe-docs-fixtures', /the reference must name the resolved\/backstop tier in the mapping table/],

        // ci-merge-group-wiring
        ['a metadata workflow without the merge_group trigger', '.github/workflows/branch-naming.yml', yamlEdit((workflow) => { delete workflow.on.merge_group; }), 'ci-merge-group-wiring', /branch-naming\.yml must trigger on merge_group with checks_requested/],
        ['a metadata workflow whose only merge_group type is another one', '.github/workflows/changeset-required.yml', yamlEdit((workflow) => { workflow.on.merge_group = { types: ['other'] }; }), 'ci-merge-group-wiring', /changeset-required\.yml must trigger on merge_group with checks_requested/],
        ['a metadata workflow with other merge_group types', '.github/workflows/changeset-required.yml', yamlEdit((workflow) => { workflow.on.merge_group = { types: ['checks_requested', 'other'] }; }), 'ci-merge-group-wiring', /changeset-required\.yml must trigger on merge_group with checks_requested/],
        ['a metadata workflow whose merge_group has no types', '.github/workflows/docs-required.yml', yamlEdit((workflow) => { workflow.on.merge_group = null; }), 'ci-merge-group-wiring', /docs-required\.yml must trigger on merge_group with checks_requested/],
        ['a metadata workflow with no guard on a job or its steps', '.github/workflows/docs-required.yml', yamlEdit((workflow) => { for (const job of Object.values(workflow.jobs)) { delete job.if; for (const step of job.steps || []) delete step.if; } }), 'ci-merge-group-wiring', /docs-required\.yml: every job or step must be skipped on merge_group/],
        ['a metadata job guard that an or can re-open', '.github/workflows/pr-template-format.yml', yamlEdit((workflow) => { for (const job of Object.values(workflow.jobs)) { job.if = "github.event_name != 'merge_group' || always()"; for (const step of job.steps || []) delete step.if; } }), 'ci-merge-group-wiring', /pr-template-format\.yml: every job or step must be skipped on merge_group/],
        ['a metadata job guard that is another condition', '.github/workflows/changeset-required.yml', yamlEdit((workflow) => { for (const job of Object.values(workflow.jobs)) { job.if = "github.event_name == 'pull_request'"; for (const step of job.steps || []) delete step.if; } }), 'ci-merge-group-wiring', /changeset-required\.yml: every job or step must be skipped on merge_group/],
        ['a guard that is not a string', '.github/workflows/branch-naming.yml', yamlEdit((workflow) => { for (const job of Object.values(workflow.jobs)) { job.if = true; for (const step of job.steps || []) delete step.if; } }), 'ci-merge-group-wiring', /branch-naming\.yml: every job or step must be skipped on merge_group/],
        ['the require-issue-link job skipped as a whole', '.github/workflows/require-issue-link.yml', yamlEdit((workflow) => { for (const job of Object.values(workflow.jobs)) job.if = "github.event_name != 'merge_group'"; }), 'ci-merge-group-wiring', /require-issue-link\.yml: the job must stay unconditional and each step carry the guard \(#1389\)/],
        ['one require-issue-link step without the guard', '.github/workflows/require-issue-link.yml', yamlEdit((workflow) => { for (const job of Object.values(workflow.jobs)) delete job.steps[0].if; }), 'ci-merge-group-wiring', /require-issue-link\.yml: every job or step must be skipped on merge_group/],
        ['a require-issue-link step that is null', '.github/workflows/require-issue-link.yml', yamlEdit((workflow) => { for (const job of Object.values(workflow.jobs)) job.steps[1] = null; }), 'ci-merge-group-wiring', /require-issue-link\.yml: every job or step must be skipped on merge_group/],
        ['a require-issue-link job with no steps', '.github/workflows/require-issue-link.yml', yamlEdit((workflow) => { for (const job of Object.values(workflow.jobs)) job.steps = []; }), 'ci-merge-group-wiring', /require-issue-link\.yml: every job or step must be skipped on merge_group/],
        ['a metadata job that is null', '.github/workflows/docs-required.yml', yamlEdit((workflow) => { workflow.jobs[Object.keys(workflow.jobs)[0]] = null; }), 'ci-merge-group-wiring', /docs-required\.yml: every job or step must be skipped on merge_group[^]{0,60}is not a mapping/],
        ['a metadata workflow with a jobs list', '.github/workflows/docs-required.yml', yamlEdit((workflow) => { workflow.jobs = ['a']; }), 'ci-merge-group-wiring', /docs-required\.yml: every job or step must be skipped on merge_group/],
        ['a metadata workflow with no jobs', '.github/workflows/docs-required.yml', yamlEdit((workflow) => { delete workflow.jobs; }), 'ci-merge-group-wiring', /docs-required\.yml: every job or step must be skipped on merge_group[^]{0,60}no jobs mapping/],
        ['a metadata workflow that is not a mapping', '.github/workflows/changeset-required.yml', () => '- a\n- b\n', 'ci-merge-group-wiring', /the workflow must parse[^]{0,60}the workflow is not a mapping/],
        ['a metadata workflow that is not YAML', '.github/workflows/changeset-required.yml', () => 'a: [\n', 'ci-merge-group-wiring', /the workflow must parse[^]{0,60}not valid YAML/],
        ['an unparseable metadata workflow stays one finding per assertion', '.github/workflows/branch-naming.yml', () => 'a: [\n', 'ci-merge-group-wiring', /branch-naming\.yml must trigger on merge_group with checks_requested[^]{0,60}not valid YAML/],
        ['a required context whose supplier lost the merge_group trigger', '.github/workflows/branch-naming.yml', yamlEdit((workflow) => { delete workflow.on.merge_group; }), 'ci-merge-group-wiring', /the required context "check-branch" must have exactly one supplier that triggers on merge_group[^]{0,80}does not trigger on merge_group/],
        ['a required context with no supplier', '.github/workflows/docs-required.yml', yamlEdit((workflow) => { workflow.jobs['docs-lint'].name = 'docs-lint-renamed'; }), 'ci-merge-group-wiring', /the required context "docs-lint" must have exactly one supplier that triggers on merge_group[^]{0,80}found 0/],
        ['a required context with two suppliers', '.github/workflows/docs-required.yml', yamlEdit((workflow) => { workflow.jobs['docs-lint-twin'] = { name: 'docs-lint', 'runs-on': 'ubuntu-latest', steps: [] }; }), 'ci-merge-group-wiring', /the required context "docs-lint" must have exactly one supplier that triggers on merge_group[^]{0,80}found 2/],
        ['the ruleset that is not JSON', '.github/rulesets/main-protection.json', () => '{', 'ci-merge-group-wiring', /the ruleset must list required contexts[^]{0,60}not valid JSON/],
        ['the ruleset with no required_status_checks rule', '.github/rulesets/main-protection.json', swap('"required_status_checks"', '"other_checks"'), 'ci-merge-group-wiring', /the ruleset must list required contexts[^]{0,80}no required_status_checks rule/],
        ['the ruleset that is a list', '.github/rulesets/main-protection.json', () => '[]', 'ci-merge-group-wiring', /the ruleset must list required contexts[^]{0,80}no required_status_checks rule/],
        ['the ruleset whose required_status_checks is not a list', '.github/rulesets/main-protection.json', () => JSON.stringify({ rules: [{ type: 'required_status_checks', parameters: { required_status_checks: {} } }] }), 'ci-merge-group-wiring', /the ruleset must list required contexts[^]{0,100}no required_status_checks rule with a list of checks/],
        ['a require-issue-link step that is null names the step', '.github/workflows/require-issue-link.yml', yamlEdit((workflow) => { for (const job of Object.values(workflow.jobs)) job.steps[1] = null; }), 'ci-merge-group-wiring', /require-issue-link\.yml: every job or step must be skipped on merge_group[^]{0,60}step 2 is not a mapping/],
        ['the ruleset with no required contexts', '.github/rulesets/main-protection.json', () => JSON.stringify({ rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [] } }] }), 'ci-merge-group-wiring', /the ruleset must list required contexts[^]{0,60}no required contexts/],
        ['the concurrency group of the target validator without the ref fallback', '.github/workflows/pr-target-validator.yml', yamlEdit((workflow) => { workflow.concurrency.group = '${{ github.workflow }}-${{ github.event.pull_request.number }}'; }), 'ci-merge-group-wiring', /pr-target-validator\.yml: queue runs must not share one concurrency group/],
        ['the target validator without a concurrency mapping', '.github/workflows/pr-target-validator.yml', yamlEdit((workflow) => { delete workflow.concurrency; }), 'ci-merge-group-wiring', /pr-target-validator\.yml: queue runs must not share one concurrency group/],
        ['a workflow outside the metadata set that is not YAML', '.github/workflows/test.yml', () => 'a: [\n', 'ci-merge-group-wiring', /the workflow must parse[^]{0,60}not valid YAML/],

        // resolver-hoist-guard
        ['the section manifest that is not JSON', 'gsd-core/workflows/section-manifest.json', () => '{', 'resolver-hoist-guard', /the shipped section manifest must parse and list workflows[^]{0,60}not valid JSON/],
        ['the section manifest with a workflows list', 'gsd-core/workflows/section-manifest.json', () => '{"workflows": []}', 'resolver-hoist-guard', /the shipped section manifest must parse and list workflows[^]{0,80}no workflows mapping/],
        ['the section manifest that is a list', 'gsd-core/workflows/section-manifest.json', () => '[]', 'resolver-hoist-guard', /the shipped section manifest must parse and list workflows[^]{0,80}no workflows mapping/],
        ['a workflow whose sections are not a list', 'gsd-core/workflows/section-manifest.json', (text) => { const manifest = JSON.parse(text); manifest.workflows[Object.keys(manifest.workflows)[0]] = 'x'; return JSON.stringify(manifest, null, 2); }, 'resolver-hoist-guard', /the sections of [^ ]+ are not a list/],
        ['a section that is not a mapping', 'gsd-core/workflows/section-manifest.json', (text) => { const manifest = JSON.parse(text); manifest.workflows[Object.keys(manifest.workflows)[0]].push(5); return JSON.stringify(manifest, null, 2); }, 'resolver-hoist-guard', /a section of [^ ]+ is not a mapping/],
        ['a manifest whose sections gate on no atom of the map', 'gsd-core/workflows/section-manifest.json', (text) => text.replace(/"when": "state:(fallow-enabled|git-create-tag|chunked-mode|worktrees-enabled|reviewer-instances-configured|phase-mvp-mode|ui-phase-active)"/g, '"when": "state:other"'), 'resolver-hoist-guard', /the forbidden-substring map must exercise at least one atom the shipped manifest actually gates a section on/],
        ['a fenced resolver call in the fallow-gated step', 'gsd-core/workflows/code-review/steps/structural-pre-pass.md', append('```bash\ngsd-sdk query config-get code_quality.fallow.enabled\n```'), 'resolver-hoist-guard', /must not itself call the resolver for that fact: a circular, self-disabling section/],
        ['a fenced resolver call in the git-tag-gated step', 'gsd-core/workflows/complete-milestone/steps/git-tag.md', append('```bash\ngsd-sdk query config-get git.create_tag\n```'), 'resolver-hoist-guard', /must not itself call the resolver for that fact: a circular, self-disabling section/],
        ['a fenced resolver call in the chunked-mode-gated step', 'gsd-core/workflows/plan-phase/steps/chunked-planning-mode.md', append('```bash\ngsd-sdk query config-get workflow.plan_chunked\n```'), 'resolver-hoist-guard', /must not itself call the resolver for that fact: a circular, self-disabling section/],
        ['a fenced resolver call in the worktrees-gated step', 'gsd-core/workflows/quick/steps/worktree-pre-dispatch-commit.md', append('```bash\ngsd-sdk query config-get workflow.use_worktrees\n```'), 'resolver-hoist-guard', /must not itself call the resolver for that fact: a circular, self-disabling section/],
        ['a fenced resolver call in the reviewer-instances-gated step', 'gsd-core/workflows/review/steps/reviewer-instances-note-1.md', append('```bash\ngsd-sdk query config-get review.reviewer_instances\n```'), 'resolver-hoist-guard', /must not itself call the resolver for that fact: a circular, self-disabling section/],
        ['a fenced resolver call in the mvp-display step', 'gsd-core/workflows/progress/steps/mvp-display.md', append('```bash\ngsd-sdk query config-get phase.mvp-mode\n```'), 'resolver-hoist-guard', /must not itself call the resolver for that fact: a circular, self-disabling section/],
        ['a fenced resolver call in the mvp-uat-framing step', 'gsd-core/workflows/verify-work/steps/mvp-uat-framing.md', append('```bash\ngsd-sdk query config-get phase.mvp-mode\n```'), 'resolver-hoist-guard', /must not itself call the resolver for that fact: a circular, self-disabling section/],
        ['a fenced resolver call in the ui-phase-gated step', 'gsd-core/workflows/verify-work/steps/automated-ui-verification.md', append('```bash\ngsd-sdk query render-hooks plan:pre\n```'), 'resolver-hoist-guard', /must not itself call the resolver for that fact: a circular, self-disabling section/],
        ['a tilde fenced resolver call in the fallow-gated step', 'gsd-core/workflows/code-review/steps/structural-pre-pass.md', append('~~~bash\ngsd-sdk query config-get code_quality.fallow.enabled\n~~~'), 'resolver-hoist-guard', /must not itself call the resolver for that fact: a circular, self-disabling section/],
        ['a four backtick fenced resolver call in the fallow-gated step', 'gsd-core/workflows/code-review/steps/structural-pre-pass.md', append('````bash\ngsd-sdk query config-get code_quality.fallow.enabled\n````'), 'resolver-hoist-guard', /must not itself call the resolver for that fact: a circular, self-disabling section/],
        ['a stray fence marker in prose before a fenced resolver call', 'gsd-core/workflows/code-review/steps/structural-pre-pass.md', append('A stray ``` in prose.\n```bash\ngsd-sdk query config-get code_quality.fallow.enabled\n```'), 'resolver-hoist-guard', /must not itself call the resolver for that fact: a circular, self-disabling section/],
        ['a four space indented fenced resolver call in the fallow-gated step', 'gsd-core/workflows/code-review/steps/structural-pre-pass.md', append('    ```bash\n    gsd-sdk query config-get code_quality.fallow.enabled\n    ```'), 'resolver-hoist-guard', /must not itself call the resolver for that fact: a circular, self-disabling section/],
        ['a tab indented fenced resolver call in the fallow-gated step', 'gsd-core/workflows/code-review/steps/structural-pre-pass.md', append('\t```bash\n\tgsd-sdk query config-get code_quality.fallow.enabled\n\t```'), 'resolver-hoist-guard', /must not itself call the resolver for that fact: a circular, self-disabling section/],
        ['a list item fence holding a resolver call in the fallow-gated step', 'gsd-core/workflows/code-review/steps/structural-pre-pass.md', append('- ```bash\n  gsd-sdk query config-get code_quality.fallow.enabled\n  ```'), 'resolver-hoist-guard', /must not itself call the resolver for that fact: a circular, self-disabling section/],
        ['a numbered list item fence holding a resolver call in the fallow-gated step', 'gsd-core/workflows/code-review/steps/structural-pre-pass.md', append('1. ```bash\n   gsd-sdk query config-get code_quality.fallow.enabled\n   ```'), 'resolver-hoist-guard', /must not itself call the resolver for that fact: a circular, self-disabling section/],
        ['a list item fence marker line inside a fenced block before a resolver call', 'gsd-core/workflows/code-review/steps/structural-pre-pass.md', append('```bash\n- ```\ngsd-sdk query config-get code_quality.fallow.enabled\n```'), 'resolver-hoist-guard', /must not itself call the resolver for that fact: a circular, self-disabling section/],
        ['two list item fenced blocks in sequence with a resolver call in each', 'gsd-core/workflows/code-review/steps/structural-pre-pass.md', append('- ```bash\n  gsd-sdk query config-get code_quality.fallow.enabled\n  ```\n- ```bash\n  gsd-sdk query config-get code_quality.fallow.enabled\n  ```'), 'resolver-hoist-guard', /must not itself call the resolver for that fact: a circular, self-disabling section/],
        ['a one line triple backtick span holding a resolver call', 'gsd-core/workflows/code-review/steps/structural-pre-pass.md', append('```gsd-sdk query config-get code_quality.fallow.enabled```'), 'resolver-hoist-guard', /must not itself call the resolver for that fact: a circular, self-disabling section/],
        ['a tilde opener holding a resolver call', 'gsd-core/workflows/code-review/steps/structural-pre-pass.md', append('~~~\ngsd-sdk query config-get code_quality.fallow.enabled\n~~~'), 'resolver-hoist-guard', /must not itself call the resolver for that fact: a circular, self-disabling section/],
        ['a closer shorter than its opener leaves the fence open', 'gsd-core/workflows/code-review/steps/structural-pre-pass.md', append('````bash\n```\ngsd-sdk query config-get code_quality.fallow.enabled'), 'resolver-hoist-guard', /must not itself call the resolver for that fact: a circular, self-disabling section/],
        ['a closer with trailing text leaves the fence open', 'gsd-core/workflows/code-review/steps/structural-pre-pass.md', append('```bash\n``` done\ngsd-sdk query config-get code_quality.fallow.enabled'), 'resolver-hoist-guard', /must not itself call the resolver for that fact: a circular, self-disabling section/],
        ['a closer of the other character leaves the fence open', 'gsd-core/workflows/code-review/steps/structural-pre-pass.md', append('```bash\n~~~\ngsd-sdk query config-get code_quality.fallow.enabled'), 'resolver-hoist-guard', /must not itself call the resolver for that fact: a circular, self-disabling section/],
        ['an opener whose info string holds a backtick is content and its resolver call is found', 'gsd-core/workflows/code-review/steps/structural-pre-pass.md', append('```x `y` gsd-sdk query config-get code_quality.fallow.enabled'), 'resolver-hoist-guard', /must not itself call the resolver for that fact: a circular, self-disabling section/],
        ['an unterminated fence holding a resolver call', 'gsd-core/workflows/code-review/steps/structural-pre-pass.md', append('```bash\ngsd-sdk query config-get code_quality.fallow.enabled'), 'resolver-hoist-guard', /must not itself call the resolver for that fact: a circular, self-disabling section/],
        ['a duplicate section id in autonomous.md', 'gsd-core/workflows/autonomous.md', swap('id="converge-banner"', 'id="converge-fail-fast"'), 'resolver-hoist-guard', /the fragment parser failed: workflow-fragments: duplicate section id/],
        ['the default-local assignment gone from autonomous.md', 'gsd-core/workflows/autonomous.md', swap('PLAN_STRATEGY="local"', 'PLAN_STRATEGY="other"'), 'resolver-hoist-guard', /the default-local assignment must survive the converge-hoist/],
        ['the converge assignment gone from autonomous.md', 'gsd-core/workflows/autonomous.md', swap('PLAN_STRATEGY="converge"', 'PLAN_STRATEGY="other"'), 'resolver-hoist-guard', /the converge-branch assignment must survive the converge-hoist/],
        ['the local consumer text gone from autonomous.md', 'gsd-core/workflows/autonomous.md', swap('If `PLAN_STRATEGY=local`, run the regular planner:', 'Run the regular planner:'), 'resolver-hoist-guard', /the ungated local-strategy consumer text must exist in the host file/],
        ['no converge-gated section in autonomous.md', 'gsd-core/workflows/autonomous.md', swap(' when="state:plan-strategy-converge"', ''), 'resolver-hoist-guard', /autonomous\.md must have at least one state:plan-strategy-converge gated section/],
        ['the local consumer inside a converge-gated section', 'gsd-core/workflows/autonomous.md', (text) => text.replace('<!-- /gsd:section -->\n\nIf `PLAN_STRATEGY=local`, run the regular planner:', 'If `PLAN_STRATEGY=local`, run the regular planner:\n<!-- /gsd:section -->\n'), 'resolver-hoist-guard', /the ungated PLAN_STRATEGY=local consumer must not live inside a gated converge section: deleting that section must never remove the local-planning path/],
        ['the local consumer only inside a converge-gated section', 'gsd-core/workflows/autonomous.md', (text) => text.replace('<!-- /gsd:section -->\n\nIf `PLAN_STRATEGY=local`, run the regular planner:', 'If `PLAN_STRATEGY=local`, run the regular planner:\n<!-- /gsd:section -->\n'), 'resolver-hoist-guard', /the PLAN_STRATEGY=local consumer must be present outside every converge-gated section/],
        ['the local resolver moved into a converge-gated section', 'gsd-core/workflows/autonomous.md', (text) => swap('PLAN_STRATEGY="local"\nif echo', 'PLAN_STRATEGY=""\nif echo')(text).replace('<!-- gsd:section id="converge-loop" when="state:plan-strategy-converge" -->\n', '<!-- gsd:section id="converge-loop" when="state:plan-strategy-converge" -->\nPLAN_STRATEGY="local"\n'), 'resolver-hoist-guard', /the PLAN_STRATEGY="local" resolver must be present outside every converge-gated section/],

        // prompt-thinning
        ['a tagged block named __proto__ beside the six fixture blocks', 'gsd-core/references/edge-probe.md', append('```json edge-probe:__proto__\n{}\n```'), 'edge-probe-docs-fixtures', /which is not a plain <dir>\/<file> fixture reference/],
        ['a tagged block named __proto__ in place of a fixture block', 'gsd-core/references/edge-probe.md', (text) => text.replace('```json edge-probe:01-round-half-even/expected-coverage.json', '```json edge-probe:__proto__'), 'edge-probe-docs-fixtures', /a tagged block names "__proto__", which is not a plain <dir>\/<file> fixture reference/],
        ['two blocks with the same tag', 'gsd-core/references/edge-probe.md', (text) => text.replace('```json edge-probe:01-round-half-even/expected-coverage.json', '```json edge-probe:02-merge-intervals/expected-coverage.json'), 'edge-probe-docs-fixtures', /the tag "02-merge-intervals\/expected-coverage.json" is used by more than one block, so the earlier block would never be compared/],
        ['the Good example reordered with the re-check and open before internal review', 'gsd-core/references/planner-antipatterns.md', swap('Wave 1: Run internal review\nWave 2: Apply accepted fixes\nWave 3: If applicable, re-check the open-time property; then immediately open PR', 'Wave 1: If applicable, re-check the open-time property; then immediately open PR\nWave 2: Run internal review\nWave 3: Apply accepted fixes'), 'prompt-thinning', /the example must show Good: internal review, accepted fixes, then the re-check and immediate open/],
        ['the fixes ordered after the final open in assign_waves', 'agents/gsd-planner.md', inStepOf('assign_waves', swap('accepted internal-review fixes before the final open', 'accepted internal-review fixes after the final open')), 'prompt-thinning', /assign_waves must state internal review and its fixes come before the final open/],
        ['the sub-200K thinning conditional gone from execute-phase', 'gsd-core/workflows/execute-phase.md', erase(/CONTEXT_WINDOW ?< 200000/g), 'prompt-thinning', /execute-phase\.md must contain a CONTEXT_WINDOW < 200000 conditional for prompt thinning/],
        ['the 500K enrichment conditional gone from execute-phase', 'gsd-core/workflows/execute-phase.md', swap('CONTEXT_WINDOW >= 500000', 'CONTEXT_WINDOW >= 400000'), 'prompt-thinning', /execute-phase\.md must preserve the existing 500K enrichment conditional/],
        ['the executor-examples reference gone from execute-phase', 'gsd-core/workflows/execute-phase.md', swap('executor-examples.md', 'examples.md'), 'prompt-thinning', /the execute-phase\.md thinning block must reference executor-examples\.md/],
        ['the executor-examples reference gone from the executor agent', 'agents/gsd-executor.md', swap('executor-examples.md', 'examples.md'), 'prompt-thinning', /gsd-executor\.md must reference executor-examples\.md for extended deviation and checkpoint examples/],
        ['the antipatterns reference gone from the planner agent', 'agents/gsd-planner.md', swap('planner-antipatterns.md', 'antipatterns.md'), 'prompt-thinning', /gsd-planner\.md must reference planner-antipatterns\.md for extended checkpoint anti-patterns and specificity examples/],
        ['the assign_waves step renamed in the planner', 'agents/gsd-planner.md', swap('<step name="assign_waves">', '<step name="assign">'), 'prompt-thinning', /marker .*assign_waves.* not found/],
        ['the known external review gone from assign_waves', 'agents/gsd-planner.md', inStepOf('assign_waves', erase(/known automatic external review/gi)), 'prompt-thinning', /assign_waves must name the known automatic external review/],
        ['the internal review lanes condition gone from assign_waves', 'agents/gsd-planner.md', inStepOf('assign_waves', erase(/plan includes internal review lanes/gi)), 'prompt-thinning', /assign_waves must condition the ordering on internal review lanes/],
        ['the accepted fixes before the open gone from assign_waves', 'agents/gsd-planner.md', inStepOf('assign_waves', erase(/accepted internal-review fixes[^.]{0,500}before[^.]{0,500}open/gi)), 'prompt-thinning', /assign_waves must put the accepted internal-review fixes before the open/],
        ['the internal review sentence gone from assign_waves', 'agents/gsd-planner.md', inStepOf('assign_waves', erase(/run internal review and apply the accepted internal-review fixes before the final open/gi)), 'prompt-thinning', /assign_waves must state internal review and its fixes come before the final open/],
        ['the open-time re-check gone from assign_waves', 'agents/gsd-planner.md', inStepOf('assign_waves', erase(/if an open-time property exists[^.]{0,500}re-check it immediately before opening[^.]{0,500}nothing intervening/gi)), 'prompt-thinning', /assign_waves must re-check an open-time property immediately before opening, with nothing intervening/],
        ['the post-open work gone from assign_waves', 'agents/gsd-planner.md', inStepOf('assign_waves', erase(/post-open CI[^.]{0,500}review[^.]{0,500}tracking may follow/gi)), 'prompt-thinning', /assign_waves must allow post-open CI, review and tracking to follow/],
        ['the antipatterns pointer gone from assign_waves', 'agents/gsd-planner.md', inStepOf('assign_waves', swap('planner-antipatterns.md ("External Review Before PR Open (#4107)")', 'planner-antipatterns.md')), 'prompt-thinning', /assign_waves must point at the antipatterns example/],
        ['the ordering text only outside assign_waves', 'agents/gsd-planner.md', (text) => inStepOf('assign_waves', erase(/known automatic external review/gi))(text) + '\nknown automatic external review\n', 'prompt-thinning', /assign_waves must name the known automatic external review/],
        ['the deviation rules gone from executor-examples', 'gsd-core/references/executor-examples.md', erase(/Rule 1|RULE 1/g), 'prompt-thinning', /executor-examples\.md must contain deviation rule examples/],
        ['the checkpoint examples gone from executor-examples', 'gsd-core/references/executor-examples.md', erase(/checkpoint|Checkpoint/g), 'prompt-thinning', /executor-examples\.md must contain checkpoint examples/],
        ['the edge case guidance gone from executor-examples', 'gsd-core/references/executor-examples.md', erase(/Edge case|edge case|Edge Case/g), 'prompt-thinning', /executor-examples\.md must contain edge case guidance/],
        ['the anti-pattern examples gone from planner-antipatterns', 'gsd-core/references/planner-antipatterns.md', erase(/anti-pattern|Anti-Pattern|Bad/g), 'prompt-thinning', /planner-antipatterns\.md must contain checkpoint anti-pattern examples/],
        ['the specificity examples gone from planner-antipatterns', 'gsd-core/references/planner-antipatterns.md', erase(/TOO VAGUE|Specificity|specificity/g), 'prompt-thinning', /planner-antipatterns\.md must contain specificity examples/],
        ['the external review example heading renamed', 'gsd-core/references/planner-antipatterns.md', swap('## External Review Before PR Open (#4107)', '## Review Before PR Open'), 'prompt-thinning', /no "External Review Before PR Open \(#4107\)" section/],
        ['the Bad example not opening the PR', 'gsd-core/references/planner-antipatterns.md', swap('Wave 1: Open PR; automatic external review starts', 'Wave 1: Run lint'), 'prompt-thinning', /the example must show Bad: open the PR, then internal review/],
        ['the Good example without internal review', 'gsd-core/references/planner-antipatterns.md', swap('Wave 1: Run internal review', 'Wave 1: Run review'), 'prompt-thinning', /the example must show Good: internal review, accepted fixes, then the re-check and immediate open/],
        ['the Good example without the accepted fixes', 'gsd-core/references/planner-antipatterns.md', swap('Wave 2: Apply accepted fixes\nWave 3: If applicable', 'Wave 2: Apply fixes\nWave 3: If applicable'), 'prompt-thinning', /the example must show Good: internal review, accepted fixes, then the re-check and immediate open/],
        ['the Good example without the immediate open', 'gsd-core/references/planner-antipatterns.md', swap('then immediately open PR', 'then open PR'), 'prompt-thinning', /the example must show Good: internal review, accepted fixes, then the re-check and immediate open/],
        ['the Good example without the re-check', 'gsd-core/references/planner-antipatterns.md', swap('re-check the open-time property', 'check the open-time property'), 'prompt-thinning', /the example must show Good: internal review, accepted fixes, then the re-check and immediate open/],
        ['the nothing-may-intervene sentence gone from the example', 'gsd-core/references/planner-antipatterns.md', swap('Nothing may intervene between an applicable re-check and the open.', 'Be quick.'), 'prompt-thinning', /the example must say nothing may intervene between the re-check and the open/],
        ['the post-open work sentence gone from the example', 'gsd-core/references/planner-antipatterns.md', swap('Post-open work may follow', 'Later work may follow'), 'prompt-thinning', /the example must allow post-open work to follow/],
        ['the post-open work sentence only after the example section', 'gsd-core/references/planner-antipatterns.md', (text) => swap('Post-open work may follow', 'Later work may follow')(text) + '\n## Elsewhere\n\nPost-open work may follow.\n', 'prompt-thinning', /the example must allow post-open work to follow/],
        ['the nothing-may-intervene sentence only after the example section', 'gsd-core/references/planner-antipatterns.md', (text) => swap('Nothing may intervene between an applicable re-check and the open.', 'Be quick.')(text) + '\n## Elsewhere\n\nNothing may intervene between an applicable re-check and the open.\n', 'prompt-thinning', /the example must say nothing may intervene between the re-check and the open/],

        // do-routing-specificity
        ['the onboard route gone from do.md', 'gsd-core/workflows/do.md', swap('/gsd:onboard', '/gsd:zz-onboard'), 'do-routing-specificity', /do\.md must route to \/gsd:onboard/],
        ['the new-project route gone from do.md', 'gsd-core/workflows/do.md', swap('/gsd:new-project', '/gsd:zz-new-project'), 'do-routing-specificity', /do\.md must route to \/gsd:new-project/],
        ['the onboard rule after the new-project rule', 'gsd-core/workflows/do.md', (text) => swap('/gsd:onboard', '/gsd:zz-onboard')(text) + '\n/gsd:onboard\n', 'do-routing-specificity', /the brownfield onboarding rule must precede the greenfield "set up" rule, so "set up this existing codebase" matches onboarding first/],
        ['the spike wrap-up route gone from do.md', 'gsd-core/workflows/do.md', swap('/gsd:spike --wrap-up', '/gsd:spike --wrapup'), 'do-routing-specificity', /do\.md must route spike wrap-up to \/gsd:spike --wrap-up/],
        ['the sketch wrap-up route gone from do.md', 'gsd-core/workflows/do.md', swap('/gsd:sketch --wrap-up', '/gsd:sketch --wrapup'), 'do-routing-specificity', /do\.md must route sketch wrap-up to \/gsd:sketch --wrap-up/],
        ['the generic spike route gone from do.md', 'gsd-core/workflows/do.md', swap('| `/gsd:spike` |', '| `/gsd:zz-spike` |'), 'do-routing-specificity', /do\.md must keep the generic \/gsd:spike route/],
        ['the generic sketch route gone from do.md', 'gsd-core/workflows/do.md', swap('| `/gsd:sketch` |', '| `/gsd:zz-sketch` |'), 'do-routing-specificity', /do\.md must keep the generic \/gsd:sketch route/],
        ['the spike wrap-up rule after the generic spike rule', 'gsd-core/workflows/do.md', (text) => swap('/gsd:spike --wrap-up', '/gsd:spike --wrapup')(text) + '\n/gsd:spike --wrap-up\n', 'do-routing-specificity', /the spike wrap-up rule must precede the generic spike rule/],
        ['the sketch wrap-up rule after the generic sketch rule', 'gsd-core/workflows/do.md', (text) => swap('/gsd:sketch --wrap-up', '/gsd:sketch --wrapup')(text) + '\n/gsd:sketch --wrap-up\n', 'do-routing-specificity', /the sketch wrap-up rule must precede the generic sketch rule/],
        ['the code-review route gone from do.md', 'gsd-core/workflows/do.md', swap('/gsd:code-review', '/gsd:zz-code-review'), 'do-routing-specificity', /do\.md must route source review to \/gsd:code-review/],
        ['the generic verify-work route gone from do.md', 'gsd-core/workflows/do.md', swap('| `/gsd:verify-work` |', '| `/gsd:zz-verify-work` |'), 'do-routing-specificity', /do\.md must keep the generic \/gsd:verify-work route/],
        ['the code-review rule after the verify-work rule', 'gsd-core/workflows/do.md', (text) => swap('/gsd:code-review', '/gsd:zz-code-review')(text) + '\n/gsd:code-review\n', 'do-routing-specificity', /the source code review rule must precede the generic verify-work quality rule/],
        ['the review route gone from the routing table', 'gsd-core/workflows/do.md', swap('/gsd:review', '/gsd:zz-review'), 'do-routing-specificity', /the routing table must cover plan review \(cross-AI peer review\) via \/gsd:review/],
        ['the docs-update route gone from the routing table', 'gsd-core/workflows/do.md', swap('/gsd:docs-update', '/gsd:zz-docs-update'), 'do-routing-specificity', /the routing table must cover documentation update via \/gsd:docs-update/],
        ['the audit-milestone route gone from the routing table', 'gsd-core/workflows/do.md', swap('/gsd:audit-milestone', '/gsd:zz-audit-milestone'), 'do-routing-specificity', /the routing table must cover milestone audit via \/gsd:audit-milestone/],
        ['the audit-fix route gone from the routing table', 'gsd-core/workflows/do.md', swap('/gsd:audit-fix', '/gsd:zz-audit-fix'), 'do-routing-specificity', /the routing table must cover autonomous audit-to-fix pass via \/gsd:audit-fix/],
        ['the ui-review route gone from the routing table', 'gsd-core/workflows/do.md', swap('/gsd:ui-review', '/gsd:zz-ui-review'), 'do-routing-specificity', /the routing table must cover UI review via \/gsd:ui-review/],
        ['the secure-phase route gone from the routing table', 'gsd-core/workflows/do.md', swap('/gsd:secure-phase', '/gsd:zz-secure-phase'), 'do-routing-specificity', /the routing table must cover security verification via \/gsd:secure-phase/],
        ['the execute-phase route gone from the routing table', 'gsd-core/workflows/do.md', swap('/gsd:execute-phase', '/gsd:zz-execute-phase'), 'do-routing-specificity', /the routing table must cover SDD phase execution via \/gsd:execute-phase/],
        ['the phase route gone from the routing table', 'gsd-core/workflows/do.md', swap('/gsd:phase', '/gsd:zz-phase'), 'do-routing-specificity', /the routing table must cover multi-phase \(roadmap CRUD\) management via \/gsd:phase/],
        ['the generic debug route gone from do.md', 'gsd-core/workflows/do.md', swap('| `/gsd:debug` |', '| `/gsd:zz-debug` |'), 'do-routing-specificity', /do\.md must keep routing bug investigation \(\| `\/gsd:debug` \|\)/],
        ['the generic quick route gone from do.md', 'gsd-core/workflows/do.md', swap('| `/gsd:quick` |', '| `/gsd:zz-quick` |'), 'do-routing-specificity', /do\.md must keep routing small actionable task \(\| `\/gsd:quick` \|\)/],
        ['the generic explore route gone from do.md', 'gsd-core/workflows/do.md', swap('| `/gsd:explore` |', '| `/gsd:zz-explore` |'), 'do-routing-specificity', /do\.md must keep routing research \/ how-does-X-work \(\| `\/gsd:explore` \|\)/],
        ['the generic progress route gone from do.md', 'gsd-core/workflows/do.md', swap('| `/gsd:progress` |', '| `/gsd:zz-progress` |'), 'do-routing-specificity', /do\.md must keep routing status check \(\| `\/gsd:progress` \|\)/],
        ['the generic capture route gone from do.md', 'gsd-core/workflows/do.md', swap('| `/gsd:capture` |', '| `/gsd:zz-capture` |'), 'do-routing-specificity', /do\.md must keep routing note capture \(\| `\/gsd:capture` \|\)/],
        ['the generic new-project route gone from do.md', 'gsd-core/workflows/do.md', swap('| `/gsd:new-project` |', '| `/gsd:zz-new-project` |'), 'do-routing-specificity', /do\.md must keep routing greenfield project setup \(\| `\/gsd:new-project` \|\)/],
        ['the display step gone from do.md', 'gsd-core/workflows/do.md', swap('<step name="display">', '<step name="show">'), 'do-routing-specificity', /do\.md must have a display step/],
        ['the dispatch step gone from do.md', 'gsd-core/workflows/do.md', swap('<step name="dispatch">', '<step name="run">'), 'do-routing-specificity', /do\.md must have a dispatch step/],
        ['the confirm step gone from do.md', 'gsd-core/workflows/do.md', swap('<step name="confirm">', '<step name="check">'), 'do-routing-specificity', /do\.md must have a confirm step \(REQ-DO-03: confirm before executing\)/],
        ['the confirm step before the display step', 'gsd-core/workflows/do.md', (text) => swap('<step name="confirm">', '<step name="check">')(text).replace('<step name="display">', '<step name="confirm">\n</step>\n<step name="display">'), 'do-routing-specificity', /the confirm step must sit after the display step/],
        ['the confirm step after the dispatch step', 'gsd-core/workflows/do.md', (text) => swap('<step name="confirm">', '<step name="check">')(text) + '\n<step name="confirm">\n</step>\n', 'do-routing-specificity', /the confirm step must sit before the dispatch step/],
        ['AskUserQuestion gone from the confirm step', 'gsd-core/workflows/do.md', within('<step name="confirm">', '<step name="dispatch">', erase(/AskUserQuestion/g)), 'do-routing-specificity', /the confirm step must ask via AskUserQuestion/],
        ['TEXT_MODE gone from the confirm step', 'gsd-core/workflows/do.md', within('<step name="confirm">', '<step name="dispatch">', erase(/TEXT_MODE/g)), 'do-routing-specificity', /the confirm step must provide a TEXT_MODE numbered-list equivalent/],
        ['the proceed choice gone from the confirm step', 'gsd-core/workflows/do.md', within('<step name="confirm">', '<step name="dispatch">', erase(/proceed|dispatch/gi)), 'do-routing-specificity', /the confirm step must offer a proceed choice/],
        ['the cancel choice gone from the confirm step', 'gsd-core/workflows/do.md', within('<step name="confirm">', '<step name="dispatch">', erase(/cancel|stop/gi)), 'do-routing-specificity', /the confirm step must offer a cancel choice/],
        ['AskUserQuestion only outside the confirm step', 'gsd-core/workflows/do.md', (text) => within('<step name="confirm">', '<step name="dispatch">', erase(/AskUserQuestion/g))(text) + '\nAskUserQuestion\n', 'do-routing-specificity', /the confirm step must ask via AskUserQuestion/],
        ['the argument derivation gone from the dispatch step', 'gsd-core/workflows/do.md', (text) => { const at = text.indexOf('<step name="dispatch">'); return text.slice(0, at) + text.slice(at).replace(/argument-hint|accepted argument/gi, ''); }, 'do-routing-specificity', /the dispatch step must derive arguments from the target command argument-hint or accepted arguments/],
        ['the wholesale argument forwarding in the dispatch step', 'gsd-core/workflows/do.md', within('<step name="dispatch">', '</step>', (section) => `${section}\npassing $ARGUMENTS as args\n`), 'do-routing-specificity', /the dispatch step must not forward \$ARGUMENTS wholesale/],
        ['the freeform carve-out gone from the dispatch step', 'gsd-core/workflows/do.md', (text) => { const at = text.indexOf('<step name="dispatch">'); return text.slice(0, at) + text.slice(at).replace(/freeform task description|freeform description/gi, ''); }, 'do-routing-specificity', /the dispatch step must carve out commands that explicitly accept a freeform task description/],
        ['SDD gone from the execute-phase description', 'commands/gsd/execute-phase.md', (text) => text.replace(/description:[^\n]*/, (line) => line.replace(/SDD|spec-driven|specification-driven/gi, 'plain')), 'do-routing-specificity', /the execute-phase description must name SDD or spec-driven execution/],
        ['the wave wording gone from the execute-phase description', 'commands/gsd/execute-phase.md', (text) => text.replace(/description:[^\n]*/, (line) => line.replace(/wave|parallel|dependency/gi, 'plain')), 'do-routing-specificity', /the execute-phase description must name wave, parallel or dependency-aware execution/],
        ['the execute-phase description key renamed in the frontmatter and written in the body', 'commands/gsd/execute-phase.md', (text) => `${text.replace(/^description:/m, 'summary:')}\ndescription: SDD wave\n`, 'do-routing-specificity', /the execute-phase description must name SDD or spec-driven execution/],
        ['the phase description key renamed in the frontmatter and written in the body', 'commands/gsd/phase.md', (text) => `${text.replace(/^description:/m, 'summary:')}\ndescription: multi-phase\n`, 'do-routing-specificity', /the phase description must name multi-phase management/],
        ['multi-phase gone from the phase description', 'commands/gsd/phase.md', (text) => text.replace(/description:[^\n]*/, (line) => line.replace(/multi-phase|phase management|add, insert, remove, or edit phases/gi, 'plain')), 'do-routing-specificity', /the phase description must name multi-phase management/],
        ['confirm gone from the success criteria', 'gsd-core/workflows/do.md', within('<success_criteria>', '</success_criteria>', erase(/confirm/gi)), 'do-routing-specificity', /the success criteria must require confirming the route before dispatch/],
        ['argument gone from the success criteria', 'gsd-core/workflows/do.md', within('<success_criteria>', '</success_criteria>', erase(/argument/gi)), 'do-routing-specificity', /the success criteria must require argument-aware dispatch/],
        // debugger-fix-acceptance
        ['the reference @-include gone from gsd-debugger (#1958)', 'agents/gsd-debugger.md',
          eraseAll('@~/.claude/gsd-core/references/debugger-fix-acceptance.md'), 'debugger-fix-acceptance', /gsd-debugger\.md must @-include the fix-acceptance reference/],
        ['the guardrail-rejection return gone from gsd-debugger (#1958)', 'agents/gsd-debugger.md',
          eraseAll('FIX REJECTED BY GUARDRAIL'), 'debugger-fix-acceptance', /gsd-debugger\.md must define the guardrail-rejection structured return/],
        ['the guardrail-rejection return gone from the session manager (#1958)', 'agents/gsd-debug-session-manager.md',
          eraseAll('FIX REJECTED BY GUARDRAIL'), 'debugger-fix-acceptance', /the session manager must handle the FIX REJECTED BY GUARDRAIL return/],
        ['per-signal recording gone from the DEBUG.md template (#1958)', 'gsd-core/templates/DEBUG.md',
          erase(/per-signal|guardrail|fix-acceptance/gi), 'debugger-fix-acceptance', /DEBUG\.md Resolution\.verification must note structured per-signal recording/],
        ['signal 1 (the target test) gone from the reference (#1958)', 'gsd-core/references/debugger-fix-acceptance.md',
          erase(/target test/gi), 'debugger-fix-acceptance', /signal 1: the target test greens/],
        ['signal 2 (the mutation check) gone from the reference (#1958)', 'gsd-core/references/debugger-fix-acceptance.md',
          erase(/mutation/gi), 'debugger-fix-acceptance', /signal 2: the mutation check/],
        ['signal 3 (the no-op/deletion detector) gone from the reference (#1958)', 'gsd-core/references/debugger-fix-acceptance.md',
          erase(/no-op|deletion|behavior-deleting/gi), 'debugger-fix-acceptance', /signal 3: the no-op\/deletion detector/],
        ['signal 4 (adjacent/held-out tests) gone from the reference (#1958)', 'gsd-core/references/debugger-fix-acceptance.md',
          erase(/adjacent|held-out/gi), 'debugger-fix-acceptance', /signal 4: adjacent\/held-out tests/],
        ['signal 5 (revert-and-reconfirm) gone from the reference (#1958)', 'gsd-core/references/debugger-fix-acceptance.md',
          erase(/revert[\s-]{0,20}and[\s-]{0,20}reconfirm/gi), 'debugger-fix-acceptance', /signal 5: revert-and-reconfirm/],
        ['the Stryker-absent skip gone from the reference (#1958)', 'gsd-core/references/debugger-fix-acceptance.md',
          erase(/no Stryker|stryker (?:is )?(?:absent|unavailable|not configured)/gi), 'debugger-fix-acceptance', /skipping the mutation check when Stryker is absent/],
        ['the no-test-suite path gone from the reference (#1958)', 'gsd-core/references/debugger-fix-acceptance.md',
          erase(/no test suite/gi), 'debugger-fix-acceptance', /the no-suite reduction path/],
        ['every skip wording gone from the reference, so a skipped signal is not logged (#1958)', 'gsd-core/references/debugger-fix-acceptance.md',
          erase(/skip/gi), 'debugger-fix-acceptance', /skipped signals must be logged or recorded in the debug file/],
        ['guardrail_verdict gone from the reference (#1958)', 'gsd-core/references/debugger-fix-acceptance.md',
          eraseAll('guardrail_verdict'), 'debugger-fix-acceptance', /must define the guardrail_verdict field/],
        ['the per-signal verification keys gone from the reference (#1958)', 'gsd-core/references/debugger-fix-acceptance.md',
          erase(/target_test|mutation_check|no_op_deletion|adjacent_tests|revert_and_reconfirm/g), 'debugger-fix-acceptance', /must enumerate the per-signal verification keys/],
        ['the surviving-mutant rule gone from the reference (#1958)', 'gsd-core/references/debugger-fix-acceptance.md',
          erase(/surviv/gi), 'debugger-fix-acceptance', /a surviving mutant rejects the fix/],
        ['the deletion rule gone from the reference (#1958)', 'gsd-core/references/debugger-fix-acceptance.md',
          erase(/delet/gi), 'debugger-fix-acceptance', /a deletion-only diff must be rejected unless the RCA justifies removal/],
        ['the rejection words only before the first delet (#1958)', 'gsd-core/references/debugger-fix-acceptance.md',
          (text) => `${text.replace(/delet/gi, 'remov').replace(/reject|justif|rca|root cause/gi, 'x')}\n\nno-op: reject justif rca root cause then delet\n`, 'debugger-fix-acceptance', /a deletion-only diff must be rejected unless the RCA justifies removal/],
        ['skipped and log split by a lone CR do not log the skip (#1958)', 'gsd-core/references/debugger-fix-acceptance.md',
          (text) => `${text.replace(/skip/gi, 'drop').replace(/log/gi, 'lg').replace(/record/gi, 'rcd')}\nskipped\rlog\n`, 'debugger-fix-acceptance', /skipped signals must be logged or recorded/],
        ['mutant and surviv split by U+2028 do not state the surviving-mutant rule (#1958)', 'gsd-core/references/debugger-fix-acceptance.md',
          (text) => `${text.replace(/surviv/gi, 'living')}\nmutant\u2028surviv\n`, 'debugger-fix-acceptance', /a surviving mutant rejects the fix/],
        ['mutant and surviv split by U+2029 do not state the surviving-mutant rule (#1958)', 'gsd-core/references/debugger-fix-acceptance.md',
          (text) => `${text.replace(/surviv/gi, 'living')}\nmutant\u2029surviv\n`, 'debugger-fix-acceptance', /a surviving mutant rejects the fix/],
        ['the deletion-rule words gone from the signal 3 paragraph while they remain elsewhere (#1958)', 'gsd-core/references/debugger-fix-acceptance.md',
          within('3. **No-op', '4. **Adjacent', erase(/reject|justif|rca|root cause/gi)), 'debugger-fix-acceptance', /a deletion-only diff must be rejected unless the RCA justifies removal/],
        ['the before-accept sentence gone from the signal 5 paragraph while the words remain elsewhere (#1958)', 'gsd-core/references/debugger-fix-acceptance.md',
          erase(/Must run \*\*before\*\* a fix is\s{1,10}accepted\./), 'debugger-fix-acceptance', /revert-and-reconfirm must run before a fix is accepted/],
        ['the mvp-display section marker moved to a section that does not load the step', 'gsd-core/workflows/progress.md',
          (text) => swap('<!-- gsd:section id="mvp-display" when="state:phase-mvp-mode" -->', '<!-- gsd:section id="mvp-display" when="state:other" -->')(text) + '\n<!-- gsd:section id="other" when="state:phase-mvp-mode" -->\nnothing here\n<!-- /gsd:section -->\n',
          'progress-mvp-display', /marker .* not found/],
        ['the mvp-display step path gone from its section', 'gsd-core/workflows/progress.md',
          within('<!-- gsd:section id="mvp-display" when="state:phase-mvp-mode" -->', '<!-- /gsd:section -->', eraseAll('progress/steps/mvp-display.md')), 'progress-mvp-display', /must load the mvp-display step/],
        ['phase: moved from the template block to the end of the workflow (extract-learnings)', 'gsd-core/workflows/extract-learnings.md',
          (text) => `${swap('\nphase: {PHASE_NUMBER}', '\nnumber: {PHASE_NUMBER}')(text)}\nphase: 1\n`, 'extract-learnings', /must include phase \(no such line/],
        ['the write_learnings step renamed, so the template block is not found (extract-learnings)', 'gsd-core/workflows/extract-learnings.md',
          swap('<step name="write_learnings">', '<step name="write-learnings">'), 'extract-learnings', /must include phase_name \(no such line/],
        ['the template block fence info string changed from yaml (extract-learnings)', 'gsd-core/workflows/extract-learnings.md',
          swap('```yaml\n---\nphase:', '```text\n---\nphase:'), 'extract-learnings', /must include generated \(no such line/],
        ['<phase-number> only in the description, not in the argument-hint (extract-learnings)', 'commands/gsd/extract-learnings.md',
          (text) => swap('description: Extract', 'description: <phase-number> Extract')(swap('argument-hint: <phase-number>', 'argument-hint: <phase>')(text)), 'extract-learnings', /the argument-hint must reference <phase-number>/],
        ['description: only inside another key line (extract-learnings)', 'commands/gsd/extract-learnings.md',
          swap('\ndescription:', '\nsummary: description:'), 'extract-learnings', /the command must have description frontmatter/],
        ['the step marker gone from the Step 1.5 line start in gsd-phase-researcher (#1988)', 'agents/gsd-phase-researcher.md',
          swap('\n## Step 1.5:', '\n see ## Step 1.5:'), 'gsd-researcher-app-aware', /no Step 1\.5 heading names the Architectural Responsibility Map/],
        ['a stray [ outside any label leaves the array unclosed (#1516)', 'gsd-core/workflows/new-project.md',
          append('options: [ { label: "b" }, [ ]'), 'new-project-mvp-prompt', /options array #\d{1,4} is never closed/],
        ['a ] inside a quoted label does not close a five-label array early (#1516)', 'gsd-core/workflows/new-project.md',
          append('options: [ {label:"a"},{label:"b]"},{label:"c"},{label:"d"},{label:"e"} ]'), 'new-project-mvp-prompt', /has 5 options/],
        ['a [ inside a quoted label does not hide a five-label array (#1516)', 'gsd-core/workflows/new-project.md',
          append('options: [ {label:"a"},{label:"b["},{label:"c"},{label:"d"},{label:"e"} ]'), 'new-project-mvp-prompt', /has 5 options/],
        ['an escaped quote then ] inside a label does not close a five-label array early (#1516)', 'gsd-core/workflows/new-project.md',
          append('options: [ {label:"a"},{label:"b\\"]"},{label:"c"},{label:"d"},{label:"e"} ]'), 'new-project-mvp-prompt', /has 5 options/],
        ['x_timeout is not a standalone timeout (#1958)', 'gsd-core/references/debugger-fix-acceptance.md',
          (text) => text.replace(/\btimeout\b/gi, 'x_timeout'), 'debugger-fix-acceptance', /the reference must mention a timeout/],
        ['GSD_TIMEOUT is not a standalone timeout (#1958)', 'gsd-core/references/debugger-fix-acceptance.md',
          (text) => text.replace(/\btimeout\b/gi, 'GSD_TIMEOUT'), 'debugger-fix-acceptance', /the reference must mention a timeout/],
        ['my_git is not a standalone git (#1958)', 'gsd-core/references/debugger-fix-acceptance.md',
          (text) => text.replace(/\bgit\b/gi, 'my_git'), 'debugger-fix-acceptance', /must bound the git subprocess/],
        ['_60s is not a standalone 60s bound (#1958)', 'gsd-core/references/debugger-fix-acceptance.md',
          swap('60s', '_60s'), 'debugger-fix-acceptance', /the 60s npm\/Stryker bound/],
        ['the standalone word git gone from the reference, only digit remains (#1958)', 'gsd-core/references/debugger-fix-acceptance.md',
          erase(/\bgit\b/gi), 'debugger-fix-acceptance', /must bound the git subprocess/],
        ['the standalone word timeout gone, only timeouts remains (#1958)', 'gsd-core/references/debugger-fix-acceptance.md',
          (text) => text.replace(/\btimeout\b/gi, 'timeouts'), 'debugger-fix-acceptance', /the reference must mention a timeout/],
        ['60s only inside 160s (#1958)', 'gsd-core/references/debugger-fix-acceptance.md',
          swap('60s', '160s'), 'debugger-fix-acceptance', /the 60s npm\/Stryker bound/],
        ['Agent commented out of the block list (extract-learnings)', 'commands/gsd/extract-learnings.md',
          swap('  - Agent\n', '  # - Agent\n'), 'extract-learnings', /allowed-tools must include Agent/],
        ['Agent missing from a multi-line flow list (extract-learnings)', 'commands/gsd/extract-learnings.md',
          (text) => text.replace(/allowed-tools:\n(?: {2}- [A-Za-z]{1,10}\n){1,6}/, 'allowed-tools: [Read,\n  Write, Bash,\n  Grep, Glob]\n'), 'extract-learnings', /allowed-tools must include Agent/],
        ['the rejection words gone after the deletion rule (#1958)', 'gsd-core/references/debugger-fix-acceptance.md',
          erase(/reject|justif|rca|root cause/gi), 'debugger-fix-acceptance', /a deletion-only diff must be rejected unless the RCA justifies removal/],
        ['every accept wording gone, so revert-and-reconfirm has no ordering rule (#1958)', 'gsd-core/references/debugger-fix-acceptance.md',
          erase(/accept/gi), 'debugger-fix-acceptance', /revert-and-reconfirm must run before a fix is accepted/],
        ['the timeout bound gone from the reference (#1958)', 'gsd-core/references/debugger-fix-acceptance.md',
          erase(/timeout/gi), 'debugger-fix-acceptance', /the reference must mention a timeout/],
        ['the 60s bound gone from the reference (#1958)', 'gsd-core/references/debugger-fix-acceptance.md',
          erase(/60s|60.?second/gi), 'debugger-fix-acceptance', /the 60s npm\/Stryker bound/],
        ['the git bound gone from the reference (#1958)', 'gsd-core/references/debugger-fix-acceptance.md',
          erase(/git/gi), 'debugger-fix-acceptance', /must bound the git subprocess/],
        // methodology-artifact
        ['the methodology artifact type gone from artifact-types.md (#1488)', 'gsd-core/references/artifact-types.md',
          erase(/[Mm]ethodology/g), 'methodology-artifact', /artifact-types\.md must document the methodology artifact type/],
        ['the standing-reference shape gone from artifact-types.md (#1488)', 'gsd-core/references/artifact-types.md',
          erase(/[Ss]tanding reference|reusable interpretive|interpretive framework/g), 'methodology-artifact', /standing reference \/ interpretive framework/],
        ['the Created to Active to Superseded lifecycle gone from artifact-types.md (#1488)', 'gsd-core/references/artifact-types.md',
          eraseAll('Created → Active → Superseded'), 'methodology-artifact', /lifecycle must read Created/],
        ['METHODOLOGY.md gone from artifact-types.md (#1488)', 'gsd-core/references/artifact-types.md',
          eraseAll('METHODOLOGY.md'), 'methodology-artifact', /must document \.planning\/METHODOLOGY\.md as the location/],
        ['the consumption wording gone from artifact-types.md (#1488)', 'gsd-core/references/artifact-types.md',
          erase(/consumed by|consumption/gi), 'methodology-artifact', /must document its consumption mechanism/],
        ['METHODOLOGY.md gone from discuss-phase-assumptions (#1488)', 'gsd-core/workflows/discuss-phase-assumptions.md',
          eraseAll('METHODOLOGY.md'), 'methodology-artifact', /must reference METHODOLOGY\.md as a consumable artifact/],
        ['the METHODOLOGY.md read gone from discuss-phase-assumptions (#1488)', 'gsd-core/workflows/discuss-phase-assumptions.md',
          eraseAll('cat .planning/METHODOLOGY.md'), 'methodology-artifact', /discuss-phase-assumptions\.md must read METHODOLOGY\.md/],
        ['the exists condition gone from discuss-phase-assumptions (#1488)', 'gsd-core/workflows/discuss-phase-assumptions.md',
          eraseAll('If METHODOLOGY.md exists'), 'methodology-artifact', /apply METHODOLOGY\.md only when it exists/],
        ['METHODOLOGY.md gone from the pause-work Required Reading template (#1488)', 'gsd-core/workflows/pause-work.md',
          eraseAll('METHODOLOGY.md'), 'methodology-artifact', /Required Reading template must include METHODOLOGY\.md/],
        // progress-mvp-display (the folded #14 guard; the combined-file assertions are in the extras)
        ['the mvp-display section condition gone from progress.md', 'gsd-core/workflows/progress.md',
          eraseAll('when="state:phase-mvp-mode"'), 'progress-mvp-display', /marker .* not found/],
        ['--auto gone from commands/gsd/progress.md (#14)', 'commands/gsd/progress.md',
          eraseAll('--auto'), 'progress-mvp-display', /progress\.md must document the --auto flag in the <flags> section/],
        ['--auto gone from the progress.md <process> block only (#14)', 'commands/gsd/progress.md',
          within('<process>', '</process>', eraseAll('--auto')), 'progress-mvp-display', /<process> block must explicitly mention --auto/],
        ['--auto gone from next.md (#14)', 'gsd-core/workflows/next.md',
          eraseAll('--auto'), 'progress-mvp-display', /next\.md must handle the --auto flag/],
        ['the --next --auto re-invocation gone from next.md (#14)', 'gsd-core/workflows/next.md',
          eraseAll('--next --auto'), 'progress-mvp-display', /must instruct re-invocation of \/gsd:progress --next --auto/],
        ['the opening <process> marker of progress.md gone (#14)', 'commands/gsd/progress.md',
          eraseAll('<process>'), 'progress-mvp-display', /<process>.* not found/],
        ['the <process> block of progress.md gone, so its end marker is missing (#14)', 'commands/gsd/progress.md',
          eraseAll('</process>'), 'progress-mvp-display', /closing marker .* not found/],
        // verifier-deferred-items
        ['Step 9b gone from the verifier (#1624)', 'agents/gsd-verifier.md',
          erase(/Step 9b|Filter Deferred/g), 'verifier-deferred-items', /Step 9b or a "Filter Deferred" section/],
        ['the roadmap analyze reference gone from the verifier (#1624)', 'agents/gsd-verifier.md',
          erase(/roadmap analyze|roadmap\.analyze/g), 'verifier-deferred-items', /should reference roadmap analyze/],
        ['the deferred: frontmatter section gone from the verifier (#1624)', 'agents/gsd-verifier.md',
          eraseAll('deferred:'), 'verifier-deferred-items', /should include a deferred: section in frontmatter/],
        ['addressed_in gone from the verifier (#1624)', 'agents/gsd-verifier.md',
          eraseAll('addressed_in'), 'verifier-deferred-items', /should include an addressed_in field/],
        ['the evidence field gone from the verifier (#1624)', 'agents/gsd-verifier.md',
          eraseAll('evidence:'), 'verifier-deferred-items', /should include an evidence field/],
        ['the deferred-section condition gone from the verifier (#1624)', 'agents/gsd-verifier.md',
          erase(/if deferred items exist|If deferred items exist|Only if deferred/g), 'verifier-deferred-items', /should be conditional: only included when deferred items exist/],
        ['the status rule gone from the verifier (#1624)', 'agents/gsd-verifier.md',
          erase(/do NOT affect the status|do not affect status|Deferred items do NOT affect/g), 'verifier-deferred-items', /deferred items do not affect status/],
        ['the conservative guidance gone from the verifier (#1624)', 'agents/gsd-verifier.md',
          erase(/conservative|when in doubt/g), 'verifier-deferred-items', /should be conservative when matching gaps/],
        ['the Deferred Items table gone from the verifier (#1624)', 'agents/gsd-verifier.md',
          eraseAll('### Deferred Items'), 'verifier-deferred-items', /report body template should include a Deferred Items section/],
        ['the deferred success criteria gone from the verifier (#1624)', 'agents/gsd-verifier.md',
          erase(/Deferred items filtered|deferred items filtered|Deferred items structured/g), 'verifier-deferred-items', /success criteria should reference deferred item filtering/],
        ['skipping gone from planner-gap-closure (#1624)', 'gsd-core/references/planner-gap-closure.md',
          erase(/skip/gi), 'verifier-deferred-items', /should mention skipping deferred items/],
        ['deferred gone from planner-gap-closure (#1624)', 'gsd-core/references/planner-gap-closure.md',
          erase(/deferred/gi), 'verifier-deferred-items', /should mention skipping deferred items/],
        ['the gaps: section gone from planner-gap-closure (#1624)', 'gsd-core/references/planner-gap-closure.md',
          eraseAll('gaps:'), 'verifier-deferred-items', /should reference the gaps: section/],
        ['the deferred: section gone from planner-gap-closure (#1624)', 'gsd-core/references/planner-gap-closure.md',
          eraseAll('deferred:'), 'verifier-deferred-items', /should reference the deferred: section/],
        ['the not-actionable wording gone from planner-gap-closure (#1624)', 'gsd-core/references/planner-gap-closure.md',
          erase(/NOT gaps|not gaps|must be ignored/g), 'verifier-deferred-items', /deferred items are not actionable gaps/],
        // extract-learnings
        ['the command renamed (extract-learnings)', 'commands/gsd/extract-learnings.md',
          swap('name: gsd:extract-learnings', 'name: gsd:other'), 'extract-learnings', /the command must have name: gsd:extract-learnings/],
        ['the command description gone (extract-learnings)', 'commands/gsd/extract-learnings.md',
          swap('description:', 'summary:'), 'extract-learnings', /the command must have description frontmatter/],
        ['the argument-hint gone (extract-learnings)', 'commands/gsd/extract-learnings.md',
          swap('argument-hint:', 'hint:'), 'extract-learnings', /the command must have argument-hint/],
        ['the phase-number argument gone (extract-learnings)', 'commands/gsd/extract-learnings.md',
          swap('<phase-number>', '<phase>'), 'extract-learnings', /the argument-hint must reference <phase-number>/],
        ['allowed-tools gone (extract-learnings)', 'commands/gsd/extract-learnings.md',
          swap('allowed-tools:', 'tools:'), 'extract-learnings', /the command must have allowed-tools/],
        ['Read dropped from the command allowed-tools (extract-learnings)', 'commands/gsd/extract-learnings.md',
          within('---', '\n---', swap('- Read', '- Other')), 'extract-learnings', /allowed-tools must include Read/],
        ['Write dropped from the command allowed-tools (extract-learnings)', 'commands/gsd/extract-learnings.md',
          within('---', '\n---', swap('- Write', '- Other')), 'extract-learnings', /allowed-tools must include Write/],
        ['Bash dropped from the command allowed-tools (extract-learnings)', 'commands/gsd/extract-learnings.md',
          within('---', '\n---', swap('- Bash', '- Other')), 'extract-learnings', /allowed-tools must include Bash/],
        ['Grep dropped from the command allowed-tools (extract-learnings)', 'commands/gsd/extract-learnings.md',
          within('---', '\n---', swap('- Grep', '- Other')), 'extract-learnings', /allowed-tools must include Grep/],
        ['Glob dropped from the command allowed-tools (extract-learnings)', 'commands/gsd/extract-learnings.md',
          within('---', '\n---', swap('- Glob', '- Other')), 'extract-learnings', /allowed-tools must include Glob/],
        ['Agent dropped from the command allowed-tools (extract-learnings)', 'commands/gsd/extract-learnings.md',
          within('---', '\n---', swap('- Agent', '- Other')), 'extract-learnings', /allowed-tools must include Agent/],
        ['Glob only in the description, not in allowed-tools (extract-learnings)', 'commands/gsd/extract-learnings.md',
          (text) => swap('description: Extract', 'description: Glob Extract')(within('---', '\n---', swap('- Glob', '- Other'))(text)), 'extract-learnings', /allowed-tools must include Glob/],
        ['Read only in the requires line, not in allowed-tools (extract-learnings)', 'commands/gsd/extract-learnings.md',
          (text) => swap('requires: [phase]', 'requires: [Read]')(within('---', '\n---', swap('- Read', '- Other'))(text)), 'extract-learnings', /allowed-tools must include Read/],
        ['GlobX in allowed-tools is not Glob (extract-learnings)', 'commands/gsd/extract-learnings.md',
          swap('  - Glob\n', '  - GlobX\n'), 'extract-learnings', /allowed-tools must include Glob/],
        ['phase: after a lone CR is not a line start (extract-learnings)', 'gsd-core/workflows/extract-learnings.md',
          swap('\nphase: {PHASE_NUMBER}', '\rphase: {PHASE_NUMBER}'), 'extract-learnings', /must include phase \(no such line/],
        ['phase_name: after U+2028 is not a line start (extract-learnings)', 'gsd-core/workflows/extract-learnings.md',
          swap('\nphase_name:', '\u2028phase_name:'), 'extract-learnings', /frontmatter must include phase_name/],
        ['generated: after U+2029 is not a line start (extract-learnings)', 'gsd-core/workflows/extract-learnings.md',
          swap('\ngenerated:', '\u2029generated:'), 'extract-learnings', /frontmatter must include generated/],
        ['missing_artifacts: after a lone CR is not a line start (extract-learnings)', 'gsd-core/workflows/extract-learnings.md',
          swap('\nmissing_artifacts:', '\rmissing_artifacts:'), 'extract-learnings', /frontmatter must include missing_artifacts/],
        ['Agent dropped from allowed-tools but named in the prose (extract-learnings)', 'commands/gsd/extract-learnings.md',
          (text) => append('The Agent is mentioned here.')(within('---', '\n---', swap('- Agent', '- Other'))(text)), 'extract-learnings', /allowed-tools must include Agent/],
        ['type: prompt gone from the command (extract-learnings)', 'commands/gsd/extract-learnings.md',
          swap('type: prompt', 'type: agent'), 'extract-learnings', /the command must have type: prompt/],
        ['the workflow reference gone from the command (extract-learnings)', 'commands/gsd/extract-learnings.md',
          eraseAll('workflows/extract-learnings.md'), 'extract-learnings', /must reference workflows\/extract-learnings\.md/],
        ['<objective> gone from the workflow (extract-learnings)', 'gsd-core/workflows/extract-learnings.md',
          eraseAll('<objective>'), 'extract-learnings', /must have a <objective> tag/],
        ['</objective> gone from the workflow (extract-learnings)', 'gsd-core/workflows/extract-learnings.md',
          eraseAll('</objective>'), 'extract-learnings', /must close the <objective> tag/],
        ['<process> gone from the workflow (extract-learnings)', 'gsd-core/workflows/extract-learnings.md',
          eraseAll('<process>'), 'extract-learnings', /must have a <process> tag/],
        ['</process> gone from the workflow (extract-learnings)', 'gsd-core/workflows/extract-learnings.md',
          eraseAll('</process>'), 'extract-learnings', /must close the <process> tag/],
        ['<success_criteria> gone from the workflow (extract-learnings)', 'gsd-core/workflows/extract-learnings.md',
          eraseAll('<success_criteria>'), 'extract-learnings', /must have a <success_criteria> tag/],
        ['</success_criteria> gone from the workflow (extract-learnings)', 'gsd-core/workflows/extract-learnings.md',
          eraseAll('</success_criteria>'), 'extract-learnings', /must close the <success_criteria> tag/],
        ['<critical_rules> gone from the workflow (extract-learnings)', 'gsd-core/workflows/extract-learnings.md',
          eraseAll('<critical_rules>'), 'extract-learnings', /must have a <critical_rules> tag/],
        ['</critical_rules> gone from the workflow (extract-learnings)', 'gsd-core/workflows/extract-learnings.md',
          eraseAll('</critical_rules>'), 'extract-learnings', /must close the <critical_rules> tag/],
        ['the named step tags gone from the workflow (extract-learnings)', 'gsd-core/workflows/extract-learnings.md',
          eraseAll('<step name='), 'extract-learnings', /must have named step tags/],
        ['</step> gone from the workflow (extract-learnings)', 'gsd-core/workflows/extract-learnings.md',
          eraseAll('</step>'), 'extract-learnings', /must close its step tags/],
        ['the hyphenated step name changed (extract-learnings)', 'gsd-core/workflows/extract-learnings.md',
          swap('<step name="extract-learnings">', '<step name="extract_learnings">'), 'extract-learnings', /must use the hyphen convention/],
        ['PLAN.md gone from the workflow (extract-learnings)', 'gsd-core/workflows/extract-learnings.md',
          eraseAll('PLAN.md'), 'extract-learnings', /the workflow must reference PLAN\.md/],
        ['SUMMARY.md gone from the workflow (extract-learnings)', 'gsd-core/workflows/extract-learnings.md',
          eraseAll('SUMMARY.md'), 'extract-learnings', /the workflow must reference SUMMARY\.md/],
        ['VERIFICATION.md gone from the workflow (extract-learnings)', 'gsd-core/workflows/extract-learnings.md',
          eraseAll('VERIFICATION.md'), 'extract-learnings', /the workflow must reference VERIFICATION\.md/],
        ['UAT.md gone from the workflow (extract-learnings)', 'gsd-core/workflows/extract-learnings.md',
          eraseAll('UAT.md'), 'extract-learnings', /the workflow must reference UAT\.md/],
        ['STATE.md gone from the workflow (extract-learnings)', 'gsd-core/workflows/extract-learnings.md',
          eraseAll('STATE.md'), 'extract-learnings', /the workflow must reference STATE\.md/],
        ['decisions gone from the workflow (extract-learnings)', 'gsd-core/workflows/extract-learnings.md',
          erase(/decision/gi), 'extract-learnings', /the workflow must extract decisions/],
        ['lessons gone from the workflow (extract-learnings)', 'gsd-core/workflows/extract-learnings.md',
          erase(/lesson/gi), 'extract-learnings', /the workflow must extract lessons/],
        ['patterns gone from the workflow (extract-learnings)', 'gsd-core/workflows/extract-learnings.md',
          erase(/pattern/gi), 'extract-learnings', /the workflow must extract patterns/],
        ['surprises gone from the workflow (extract-learnings)', 'gsd-core/workflows/extract-learnings.md',
          erase(/surprise/gi), 'extract-learnings', /the workflow must extract surprises/],
        ['capture_thought gone from the workflow (extract-learnings)', 'gsd-core/workflows/extract-learnings.md',
          eraseAll('capture_thought'), 'extract-learnings', /must reference the capture_thought tool/],
        ['the capture_thought fallback gone from the workflow (extract-learnings)', 'gsd-core/workflows/extract-learnings.md',
          eraseAll('If not available'), 'extract-learnings', /must degrade gracefully when capture_thought is unavailable/],
        ['LEARNINGS.md gone from the workflow (extract-learnings)', 'gsd-core/workflows/extract-learnings.md',
          eraseAll('LEARNINGS.md'), 'extract-learnings', /the workflow must output LEARNINGS\.md/],
        ['the missing-artifact skip gone from the workflow (extract-learnings)', 'gsd-core/workflows/extract-learnings.md',
          eraseAll('skip if not found'), 'extract-learnings', /must skip missing optional artifacts/],
        ['the source attribution gone from the workflow (extract-learnings)', 'gsd-core/workflows/extract-learnings.md',
          eraseAll('attribution to'), 'extract-learnings', /must include source attribution for extracted items/],
        ['the phase frontmatter field gone from the workflow (extract-learnings)', 'gsd-core/workflows/extract-learnings.md',
          swap('phase: {PHASE_NUMBER}', 'number: {PHASE_NUMBER}'), 'extract-learnings', /frontmatter must include phase/],
        ['the phase_name frontmatter field gone from the workflow (extract-learnings)', 'gsd-core/workflows/extract-learnings.md',
          swap('phase_name: "{PHASE_NAME}"', 'name: "{PHASE_NAME}"'), 'extract-learnings', /frontmatter must include phase_name/],
        ['the generated frontmatter field gone from the workflow (extract-learnings)', 'gsd-core/workflows/extract-learnings.md',
          swap('generated: "{ISO_DATE}"', 'created: "{ISO_DATE}"'), 'extract-learnings', /frontmatter must include generated/],
        ['the missing_artifacts frontmatter field gone from the workflow (extract-learnings)', 'gsd-core/workflows/extract-learnings.md',
          swap('missing_artifacts:', 'absent_artifacts:'), 'extract-learnings', /frontmatter must include missing_artifacts/],
        ['the overwrite rule gone from the workflow (extract-learnings)', 'gsd-core/workflows/extract-learnings.md',
          eraseAll('overwrite it'), 'extract-learnings', /must overwrite a previous LEARNINGS\.md on re-run/],
        // gsd-researcher-app-aware
        ['the map gone from gsd-phase-researcher (#1988)', 'agents/gsd-phase-researcher.md',
          eraseAll('Architectural Responsibility Map'), 'gsd-researcher-app-aware', /gsd-phase-researcher\.md must contain "Architectural Responsibility Map"/],
        ['Step 1.5 ahead of Step 1 in gsd-phase-researcher (#1988)', 'agents/gsd-phase-researcher.md',
          (text) => `## Step 1.5: placed first\n${text}`, 'gsd-researcher-app-aware', /Step 1\.5 .* must come after Step 1/],
        ['Step 2 renamed in gsd-phase-researcher (#1988)', 'agents/gsd-phase-researcher.md',
          swap('## Step 2:', '## Phase 2:'), 'gsd-researcher-app-aware', /Step 1\.5 .* must come before Step 2/],
        ['no Step 1.5 heading names the map in gsd-phase-researcher (#1988)', 'agents/gsd-phase-researcher.md',
          (text) => text.split('\n').map((line) => (line.startsWith('## Step 1.5') ? line.split('Architectural Responsibility Map').join('Mapping') : line)).join('\n'),
          'gsd-researcher-app-aware', /no Step 1\.5 heading names the Architectural Responsibility Map/],
        ['no Step 2 heading after the map step (#1988)', 'agents/gsd-phase-researcher.md',
          swap('## Step 2:', '## Phase 2:'), 'gsd-researcher-app-aware', /no "## Step 2:" heading after the step/],
        ['two of the standard tiers gone from the map step (#1988)', 'agents/gsd-phase-researcher.md',
          within('## Step 1.5:', '## Step 2:', (section) => section.replace(/browser/gi, 'x').replace(/frontend/gi, 'x')), 'gsd-researcher-app-aware', /must mention at least 3 standard architectural tiers/],
        ['the table gone from the map step (#1988)', 'agents/gsd-phase-researcher.md',
          within('## Step 1.5:', '## Step 2:', (section) => section.split('|').join(':')), 'gsd-researcher-app-aware', /must specify a table output format with a Capability column/],
        ['the Capability column gone from the map step (#1988)', 'agents/gsd-phase-researcher.md',
          within('## Step 1.5:', '## Step 2:', (section) => section.split('Capability').join('Item')), 'gsd-researcher-app-aware', /must specify a table output format with a Capability column/],
        ['the map gone from gsd-planner (#1988)', 'agents/gsd-planner.md',
          eraseAll('Architectural Responsibility Map'), 'gsd-researcher-app-aware', /gsd-planner\.md must reference the Architectural Responsibility Map/],
        ['the sanity check gone from gsd-planner (#1988)', 'agents/gsd-planner.md',
          erase(/sanity[ -]check/g), 'gsd-researcher-app-aware', /gsd-planner\.md must include a sanity check/],
        ['the tier dimension gone from gsd-plan-checker (#1988)', 'agents/gsd-plan-checker.md',
          erase(/Architectural Responsibility Map|Architectural Tier/g), 'gsd-researcher-app-aware', /must have a verification dimension for architectural tier mapping/],
        ['the tier mismatch check gone from gsd-plan-checker (#1988)', 'agents/gsd-plan-checker.md',
          erase(/tier owner|tier mismatch|responsibility map/g), 'gsd-researcher-app-aware', /must check for tier mismatches against the responsibility map/],
        ['the map section gone from the research template (#1988)', 'gsd-core/templates/research.md',
          eraseAll('Architectural Responsibility Map'), 'gsd-researcher-app-aware', /must include an Architectural Responsibility Map section/],
        ['the table gone from the research template map section (#1988)', 'gsd-core/templates/research.md',
          (text) => { const at = text.indexOf('Architectural Responsibility Map'); const end = text.indexOf('##', at + 10); return text.slice(0, at) + text.slice(at, end !== -1 ? end : at + 500).split('|').join(':') + text.slice(end !== -1 ? end : at + 500); },
          'gsd-researcher-app-aware', /must include a table format with a Tier column/],
        ['the Tier column gone from the research template map section (#1988)', 'gsd-core/templates/research.md',
          (text) => { const at = text.indexOf('Architectural Responsibility Map'); const end = text.indexOf('##', at + 10); const stop = end !== -1 ? end : at + 500; return text.slice(0, at) + text.slice(at, stop).replace(/[Tt]ier/g, 'Level') + text.slice(stop); },
          'gsd-researcher-app-aware', /must include a table format with a Tier column/],
        // new-project-mvp-prompt
        ['Vertical MVP gone from the new-project workflow (#1516)', 'gsd-core/workflows/new-project.md',
          erase(/vertical mvp/gi), 'new-project-mvp-prompt', /must mention the Vertical MVP option in the mode prompt/],
        ['Horizontal Layers gone from the new-project workflow (#1516)', 'gsd-core/workflows/new-project.md',
          erase(/horizontal layers/gi), 'new-project-mvp-prompt', /must mention the Horizontal Layers option in the mode prompt/],
        ['**Mode:** mvp gone from the new-project workflow (#1516)', 'gsd-core/workflows/new-project.md',
          erase(/\*\*mode:\*\* mvp/gi), 'new-project-mvp-prompt', /must emit \*\*Mode:\*\* mvp on the initial roadmap phases/],
        ['the standard fallback gone from the new-project workflow (#1516)', 'gsd-core/workflows/new-project.md',
          erase(/standard/gi), 'new-project-mvp-prompt', /fallback to the standard template when Horizontal Layers is picked/],
        ['the step-file AI Models prompt gone (#1516)', 'gsd-core/workflows/new-project/steps/auto-mode-config.md',
          swap('header: "AI Models"', 'header: "Models"'), 'new-project-mvp-prompt', /at least two AI Models prompts/],
        ['the host AI Models prompt gone (#1516)', 'gsd-core/workflows/new-project.md',
          swap('header: "AI Models"', 'header: "Models"'), 'new-project-mvp-prompt', /at least two AI Models prompts/],
        ['Adaptive gone from the host AI Models prompt (#1516)', 'gsd-core/workflows/new-project.md',
          swap('label: "Adaptive (Recommended)"', 'label: "Auto (Recommended)"'), 'new-project-mvp-prompt', /each AI Models prompt must include an Adaptive option/],
        ['Adaptive gone from the step AI Models prompt (#1516)', 'gsd-core/workflows/new-project/steps/auto-mode-config.md',
          swap('label: "Adaptive (Recommended)"', 'label: "Auto (Recommended)"'), 'new-project-mvp-prompt', /each AI Models prompt must include an Adaptive option/],
        ['adaptive gone from the host model_profile enum (#1516)', 'gsd-core/workflows/new-project.md',
          swap('"quality|balanced|budget|adaptive|inherit"', '"quality|balanced|budget|inherit"'), 'new-project-mvp-prompt', /both config-new-project example payloads must list adaptive/],
        ['adaptive gone from the step model_profile enum (#1516)', 'gsd-core/workflows/new-project/steps/auto-mode-config.md',
          swap('"quality|balanced|budget|adaptive|inherit"', '"quality|balanced|budget|inherit"'), 'new-project-mvp-prompt', /both config-new-project example payloads must list adaptive/],
        ['one example payload gone, so only one remains (#1516)', 'gsd-core/workflows/new-project/steps/auto-mode-config.md',
          swap('model_profile":"quality|balanced|budget|adaptive|inherit"', 'model_profile_x":"x"'), 'new-project-mvp-prompt', /found 1 config-new-project example payloads/],
        ['an example payload with an empty model_profile (#1516)', 'gsd-core/workflows/new-project.md',
          swap('model_profile":"quality|balanced|budget|adaptive|inherit"', 'model_profile":""'), 'new-project-mvp-prompt', /model_profile enum is ""/],
        ['an unbalanced opening brace in the new-project workflow (#1516)', 'gsd-core/workflows/new-project.md',
          append('{'), 'new-project-mvp-prompt', /must have balanced braces/],
        ['an unbalanced closing brace in the new-project workflow (#1516)', 'gsd-core/workflows/new-project.md',
          append('}'), 'new-project-mvp-prompt', /must have balanced braces/],
  ]) {
    test(`mutation: ${title} fails ${contract}`, (t) => {
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
    passes('a diamond line that names respawn, not spawn', 'gsd-core/workflows/audit-fix.md', append('\u25c6 Respawning is not announced here'), 'spawn-liveness-banner');
    passes('a diamond line whose spawn word comes after a carriage return', 'gsd-core/workflows/audit-fix.md', append('\u25c6 Done\rspawning later'), 'spawn-liveness-banner');
    passes('a spawn word on a line with no diamond', 'gsd-core/workflows/audit-fix.md', append('Spawning the planner'), 'spawn-liveness-banner');
    passes('a diamond spawn line that carries the phrase', 'gsd-core/workflows/audit-fix.md', append('\u25c6 Spawning the planner (runs in a subagent)'), 'spawn-liveness-banner');
    passes('a routed spawn with spaces around the equals sign', 'gsd-core/workflows/quick.md', append('Agent(subagent_type="gsd-code-fixer", model = "{M}", prompt="x")'), 'model-routing-spawn-threading');
    passes('a routed spawn with the model param before the type', 'gsd-core/workflows/quick.md', append('Agent(model="{M}", subagent_type="gsd-code-fixer", prompt="x")'), 'model-routing-spawn-threading');
    passes('a routed spawn whose prompt holds parentheses and quotes', 'gsd-core/workflows/quick.md', append('Agent(subagent_type="gsd-code-fixer", model="{M}", prompt="""a ) b "q" ( c""")'), 'model-routing-spawn-threading');
    passes('a spawn of an unrouted agent without a model', 'gsd-core/workflows/quick.md', append('Agent(subagent_type="gsd-planner", prompt="x")'), 'model-routing-spawn-threading');
    passes('Cross-phase capitalised and cross-phase lowercase each suffice', 'gsd-core/workflows/plan-phase.md', (text) => text.split('Cross-phase').join('cross-phase'), 'context-enrichment');
    gapCases('execute-phase CONTEXT.md and RESEARCH.md after the gate', 'gsd-core/workflows/execute-phase.md', 'context-enrichment', (text, gap) => text.replace('CONTEXT_WINDOW >= 500000', `CONTEXT_WINDOW >= 500000${'x'.repeat(gap)}`), 324, /the executor enrichment block should include RESEARCH\.md/);
    passes('a read guarded by a typeof test in the same statement', 'hooks/gsd-prompt-guard.js', append('const safe = typeof payload.tool_input.file_path === "string" ? payload.tool_input.file_path : "";'), 'kimi-guard-typed-payload-reads');
    passes('a read in a line comment', 'hooks/gsd-prompt-guard.js', append('// const leaked = payload.tool_input.file_path;'), 'kimi-guard-typed-payload-reads');
    passes('a read in a block comment', 'hooks/gsd-prompt-guard.js', append('/* const leaked = payload.tool_input.file_path; */'), 'kimi-guard-typed-payload-reads');
    passes('a longer field name that merely starts with path', 'hooks/gsd-prompt-guard.js', append('const other = payload.tool_input.path_hint;'), 'kimi-guard-typed-payload-reads');
    passes('a container name that is part of a longer word', 'hooks/gsd-prompt-guard.js', append('const other = payload.my_tool_input.file_path;'), 'kimi-guard-typed-payload-reads');
    passes('full variant: the flag spelled with spaces around the equals sign', 'agents/gsd-debug-session-manager.md', (text) => text.replace('run_in_background=false', 'run_in_background = false'), 'debug-manager-blocking-spawn');
    passes('compact variant: the flag spelled with spaces around the equals sign', 'agents/gsd-debug-session-manager.compact.md', (text) => text.replace('run_in_background=false', 'run_in_background = false'), 'debug-manager-blocking-spawn');
    passes('the blocking-hop mandate with a no-break space after the colon', 'gsd-core/workflows/debug.md', swap('run_in_background: false`', 'run_in_background:\u00a0false`'), 'debug-manager-blocking-spawn');
    passes('an agent file whose one-line spawn states run_in_background', 'agents/gsd-executor.md', append('Agent(subagent_type="gsd-planner", run_in_background=false)'), 'debug-manager-blocking-spawn');
    passes('an agent file whose multi-line spawn states run_in_background with spaces', 'agents/gsd-executor.md', append('Agent(\n  subagent_type="gsd-planner",\n  run_in_background = true\n)'), 'debug-manager-blocking-spawn');
    passes('an agent file with an Agent call that names no subagent', 'agents/gsd-executor.md', append('Agent(x)'), 'debug-manager-blocking-spawn');
    passes('replace and supersede wording gone while a not-append line remains', 'gsd-core/references/debugger-bug-taxonomy.md', (text) => text.replace(/replace|supersede|routed? selection/gi, 'x'), 'debugger-bug-taxonomy');
    passes('append wording gone while replace and supersede wording remain', 'gsd-core/references/debugger-bug-taxonomy.md', (text) => text.replace(/append/gi, 'y'), 'debugger-bug-taxonomy');
    passes('record-replay gone from the Heisenbug row while stability-stress remains', 'gsd-core/references/debugger-bug-taxonomy.md', swap('record-replay (`rr`) \u2192 ', ''), 'debugger-bug-taxonomy');
    passes('stability-stress gone from the Heisenbug row while record-replay remains', 'gsd-core/references/debugger-bug-taxonomy.md', swap(' \u2192 stability-stress', ''), 'debugger-bug-taxonomy');
    passes('note wording gone while log wording remains on the skip lines', 'gsd-core/references/debugger-sbfl.md', (text) => text.replace(/note/gi, 'y'), 'debugger-sbfl');
    passes('log wording gone while note wording remains on the skip lines', 'gsd-core/references/debugger-sbfl.md', (text) => text.replace(/log/gi, 'x'), 'debugger-sbfl');
    passes('rc: the coverage gate needs written as a single string', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['rc-coverage-gate'].needs = 'rc-test'; }), 'release-shard-lane-sharding');
    passes('rc: the final job needs the coverage gate written as a single string', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['rc'].needs = 'rc-coverage-gate'; }), 'release-shard-lane-sharding');
    passes('rc: a fourth shard with a matching denominator', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['rc-test'].strategy.matrix.shard = ['1/4', '2/4', '3/4', '4/4']; }), 'release-shard-lane-sharding');
    passes('finalize: the coverage gate needs written as a single string', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['finalize-coverage-gate'].needs = 'finalize-test'; }), 'release-shard-lane-sharding');
    passes('finalize: the final job needs the coverage gate written as a single string', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['finalize'].needs = 'finalize-coverage-gate'; }), 'release-shard-lane-sharding');
    passes('finalize: a fourth shard with a matching denominator', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['finalize-test'].strategy.matrix.shard = ['1/4', '2/4', '3/4', '4/4']; }), 'release-shard-lane-sharding');
    passes('the lifecycle smoke step moved to another job', '.github/workflows/install-smoke.yml', yamlEdit((w) => { const step = w.jobs.smoke.steps.find((s) => typeof s.run === 'string' && s.run.includes('release-tarball-smoke.cjs')); w.jobs.smoke.steps = w.jobs.smoke.steps.filter((s) => s !== step); w.jobs['smoke-unpacked'].steps.push(step); }), 'release-tarball-smoke-workflow');
    passes('the triggers written as a mapping with workflow_call first', '.github/workflows/install-smoke.yml', yamlEdit((w) => { const paths = w.on.pull_request.paths; w.on = { workflow_call: null, pull_request: { paths } }; }), 'release-tarball-smoke-workflow');
    passes('an extra pull_request path and trigger', '.github/workflows/install-smoke.yml', yamlEdit((w) => { w.on.pull_request.paths.push('docs/**'); w.on.workflow_dispatch = null; }), 'release-tarball-smoke-workflow');
    findsOne('a prompt-first spawn with parentheses and a quote inside a triple-quoted prompt and no model', 'gsd-core/workflows/quick.md', append('Agent(prompt="""x ) ( "q" """, subagent_type="gsd-code-reviewer")'), 'model-routing-spawn-threading', /gsd-code-reviewer spawn missing model=/);
    findsOne('a spawn whose single-quoted prompt holds an escaped quote and a closing parenthesis and no model', 'gsd-core/workflows/quick.md', append('Agent(prompt="a \\" ) b", subagent_type="gsd-code-fixer")'), 'model-routing-spawn-threading', /gsd-code-fixer spawn missing model=/);
    findsOne('a spawn whose prompt holds a nested call and no model', 'gsd-core/workflows/quick.md', append('Agent(prompt=f(x), subagent_type="gsd-code-fixer")'), 'model-routing-spawn-threading', /gsd-code-fixer spawn missing model=/);
    findsOne('a spawn whose model param follows a closing parenthesis inside the prompt is read to its end', 'gsd-core/workflows/quick.md', append('Agent(prompt="a ) b", subagent_type="gsd-code-fixer")\nAgent(subagent_type="gsd-planner", model="{M}")'), 'model-routing-spawn-threading', /gsd-code-fixer spawn missing model=/);
    passes('a prompt-first spawn with parentheses and a quote inside a triple-quoted prompt and a model after it', 'gsd-core/workflows/quick.md', append('Agent(prompt="""x ) ( "q" """, subagent_type="gsd-code-reviewer", model="{M}")'), 'model-routing-spawn-threading');
    passes('a spawn whose single-quoted prompt holds an escaped quote and a model after it', 'gsd-core/workflows/quick.md', append('Agent(prompt="a \\" ) b", subagent_type="gsd-code-fixer", model="{M}")'), 'model-routing-spawn-threading');
    passes('a spawn whose prompt holds a nested call and a model after it', 'gsd-core/workflows/quick.md', append('Agent(prompt=f(x), subagent_type="gsd-code-fixer", model="{M}")'), 'model-routing-spawn-threading');
    passes('rc: the coverage gate needs a longer job name beside the real one in a list', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['rc-coverage-gate'].needs = ['rc-test-extra', 'rc-test']; }), 'release-shard-lane-sharding');
    passes('finalize: the coverage gate needs a longer job name beside the real one in a list', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs['finalize-coverage-gate'].needs = ['finalize-test-extra', 'finalize-test']; }), 'release-shard-lane-sharding');
    {
      const caseOf = (title, onValue) => test(title, (t) => {
        const root = copyOfRepoFiles(t);
        const abs = path.join(root, '.github/workflows/install-smoke.yml');
        fs.writeFileSync(abs, yamlEdit((w) => { w.on = onValue; })(fs.readFileSync(abs, 'utf8')));
        const findings = runShipped(root, ['release-tarball-smoke-workflow']);
        assert.equal(findings.length, 2, JSON.stringify(findings));
        assert.ok(findings.every((f) => /path filter must include/.test(f.message)), JSON.stringify(findings));
        assert.ok(!findings.some((f) => /workflow_call/.test(f.message)), JSON.stringify(findings));
      });
      caseOf('triggers written as a list holding workflow_call leave only the path-filter findings', ['workflow_call']);
      caseOf('triggers written as the string workflow_call leave only the path-filter findings', 'workflow_call');
      caseOf('triggers written as a list holding workflow_call and pull_request leave only the path-filter findings', ['workflow_call', 'pull_request']);
    }
    passes('a comment at the very start of the file holding a read', 'hooks/gsd-prompt-guard.js', (text) => '// payload.tool_input.file_path\n' + text, 'kimi-guard-typed-payload-reads');
    passes('a comment with a double slash after a non-colon holding a read', 'hooks/gsd-prompt-guard.js', append('const ok = 1; // payload.tool_input.file_path;'), 'kimi-guard-typed-payload-reads');
    passes('a read typed by typeof as a whole word', 'hooks/gsd-prompt-guard.js', append('const safe = typeof (payload.tool_input.file_path);'), 'kimi-guard-typed-payload-reads');
    passes('a not-append wording on one line is enough', 'gsd-core/references/debugger-bug-taxonomy.md', (text) => text.replace(/replace|supersede|routed? selection/gi, 'x').replace(/append/gi, 'y') + '\nnot append\n', 'debugger-bug-taxonomy');
    passes('only one line pairs skip then log', 'gsd-core/references/debugger-sbfl.md', (text) => text.replace(/skip|log|note/gi, 'x') + '\nskip log\n', 'debugger-sbfl');
    passes('only one line pairs log then skip', 'gsd-core/references/debugger-sbfl.md', (text) => text.replace(/skip|log|note/gi, 'x') + '\nlog skip\n', 'debugger-sbfl');
    passes('only one line pairs skip then note', 'gsd-core/references/debugger-sbfl.md', (text) => text.replace(/skip|log|note/gi, 'x') + '\nskip note\n', 'debugger-sbfl');
    passes('only one line pairs note then skip', 'gsd-core/references/debugger-sbfl.md', (text) => text.replace(/skip|log|note/gi, 'x') + '\nnote skip\n', 'debugger-sbfl');
    passes('only "no coverage" names the no-coverage skip path', 'gsd-core/references/debugger-sbfl.md', (text) => text.replace(/no coverage|no test suite|coverage (?:is )?(?:absent|unavailable)/gi, 'x') + '\nno coverage\n', 'debugger-sbfl');
    passes('only "no test suite" names the no-coverage skip path', 'gsd-core/references/debugger-sbfl.md', (text) => text.replace(/no coverage|no test suite|coverage (?:is )?(?:absent|unavailable)/gi, 'x') + '\nno test suite\n', 'debugger-sbfl');
    passes('only "coverage is absent" names the no-coverage skip path', 'gsd-core/references/debugger-sbfl.md', (text) => text.replace(/no coverage|no test suite|coverage (?:is )?(?:absent|unavailable)/gi, 'x') + '\ncoverage is absent\n', 'debugger-sbfl');
    passes('only "coverage absent" names the no-coverage skip path', 'gsd-core/references/debugger-sbfl.md', (text) => text.replace(/no coverage|no test suite|coverage (?:is )?(?:absent|unavailable)/gi, 'x') + '\ncoverage absent\n', 'debugger-sbfl');
    passes('only "coverage is unavailable" names the no-coverage skip path', 'gsd-core/references/debugger-sbfl.md', (text) => text.replace(/no coverage|no test suite|coverage (?:is )?(?:absent|unavailable)/gi, 'x') + '\ncoverage is unavailable\n', 'debugger-sbfl');
    passes('only "coverage unavailable" names the no-coverage skip path', 'gsd-core/references/debugger-sbfl.md', (text) => text.replace(/no coverage|no test suite|coverage (?:is )?(?:absent|unavailable)/gi, 'x') + '\ncoverage unavailable\n', 'debugger-sbfl');
    passes('only "bohrbug" notes where SBFL suits', 'gsd-core/references/debugger-sbfl.md', (text) => text.replace(/bohrbug|deterministic|flaky|heisenbug|mandelbug/gi, 'x') + '\nbohrbug\n', 'debugger-sbfl');
    passes('only "deterministic" notes where SBFL suits', 'gsd-core/references/debugger-sbfl.md', (text) => text.replace(/bohrbug|deterministic|flaky|heisenbug|mandelbug/gi, 'x') + '\ndeterministic\n', 'debugger-sbfl');
    passes('only "flaky" notes where SBFL suits', 'gsd-core/references/debugger-sbfl.md', (text) => text.replace(/bohrbug|deterministic|flaky|heisenbug|mandelbug/gi, 'x') + '\nflaky\n', 'debugger-sbfl');
    passes('only "heisenbug" notes where SBFL suits', 'gsd-core/references/debugger-sbfl.md', (text) => text.replace(/bohrbug|deterministic|flaky|heisenbug|mandelbug/gi, 'x') + '\nheisenbug\n', 'debugger-sbfl');
    passes('only "mandelbug" notes where SBFL suits', 'gsd-core/references/debugger-sbfl.md', (text) => text.replace(/bohrbug|deterministic|flaky|heisenbug|mandelbug/gi, 'x') + '\nmandelbug\n', 'debugger-sbfl');
    passes('only the bare word rr names record-replay in the Heisenbug row', 'gsd-core/references/debugger-bug-taxonomy.md', swap('record-replay (`rr`) \u2192 stability-stress \u2192 ', '(rr) \u2192 '), 'debugger-bug-taxonomy');
    passes('full variant: a false flag then a true flag in the spawn still blocks and agrees', 'agents/gsd-debug-session-manager.md', (text) => text.replace('run_in_background=false', 'run_in_background=false\n  run_in_background=true'), 'debug-manager-blocking-spawn');
    passes('compact variant: a false flag then a true flag in the spawn still blocks and agrees', 'agents/gsd-debug-session-manager.compact.md', (text) => text.replace('run_in_background=false', 'run_in_background=false\n  run_in_background=true'), 'debug-manager-blocking-spawn');
    passes('a spawn with a flag after the closing paren of a call-like text', 'agents/gsd-executor.md', append('Agent(subagent_type="gsd-planner", run_in_background = false, prompt="a")'), 'debug-manager-blocking-spawn');
    {
      const frags = ['batch-init', 'completion', 'merge-wave', 'plan-checker-loop', 'verification-wave'].map((n) => 'gsd-core/workflows/quick-batch/steps/' + n + '.md');
      const run = (t, keep) => {
        const root = copyOfRepoFiles(t);
        for (const rel of frags) {
          const abs = path.join(root, rel);
          if (rel !== keep && fs.existsSync(abs)) fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').split('runs in a subagent').join('runs elsewhere'));
        }
        return runShipped(root, ['spawn-liveness-banner']).filter((f) => f.file === 'gsd-core/workflows/quick-batch.md');
      };
      test('a host whose fragments all lack the liveness phrase while naming subagent_type is a finding', (t) => {
        const findings = run(t, null);
        assert.equal(findings.length, 1, JSON.stringify(findings));
        assert.match(findings[0].message, /never the liveness phrase/);
      });
      test('a host with the liveness phrase in one steps fragment only has no finding', (t) => {
        assert.deepEqual(run(t, 'gsd-core/workflows/quick-batch/steps/verification-wave.md'), []);
      });
    }
    passes('a heading of seven marks in the English reference is no heading', 'docs/reference/state-md.md', append('####### seven marks'), 'docs-state-md-locale-parity');
    passes('a heading with no space after the marks in the English reference is no heading', 'docs/reference/state-md.md', append('#nospace'), 'docs-state-md-locale-parity');
    passes('a fenced heading in the English reference is no heading', 'docs/reference/state-md.md', append('```\n# fenced\n```'), 'docs-state-md-locale-parity');
    passes('a heading holding a line separator in the English reference is skipped', 'docs/reference/state-md.md', append('# a\u2028b'), 'docs-state-md-locale-parity');
    passes('a heading holding a paragraph separator in the English reference is skipped', 'docs/reference/state-md.md', append('# a\u2029b'), 'docs-state-md-locale-parity');
    passes('an extra heading in a locale reference is no missing section', 'docs/ja-JP/reference/state-md.md', append('## An extra section'), 'docs-state-md-locale-parity');
    passes('a translated heading text in a locale reference is no missing section', 'docs/ja-JP/reference/state-md.md', (text) => text.replace(/^## .*$/m, '## Translated again'), 'docs-state-md-locale-parity');
    findsOne('release.yml that is not YAML', '.github/workflows/release.yml', () => '{{{', 'release-shard-lane-sharding', /release\.yml is not valid YAML/);
    findsOne('release.yml that is a sequence', '.github/workflows/release.yml', () => '- a\n- b\n', 'release-shard-lane-sharding', /release\.yml has no jobs mapping/);
    findsOne('release.yml with no jobs', '.github/workflows/release.yml', () => 'name: x\n', 'release-shard-lane-sharding', /release\.yml has no jobs mapping/);
    findsOne('release.yml with a null jobs value', '.github/workflows/release.yml', () => 'jobs:\n', 'release-shard-lane-sharding', /release\.yml has no jobs mapping/);
    findsOne('release.yml that is only a comment', '.github/workflows/release.yml', () => '# nothing\n', 'release-shard-lane-sharding', /release\.yml has no jobs mapping/);
    findsOne('install-smoke.yml that is not YAML', '.github/workflows/install-smoke.yml', () => '{{{', 'release-tarball-smoke-workflow', /install-smoke\.yml is not valid YAML/);
    findsOne('install-smoke.yml that is a sequence', '.github/workflows/install-smoke.yml', () => '- a\n', 'release-tarball-smoke-workflow', /install-smoke\.yml is not a mapping/);
    findsOne('install-smoke.yml that is only a comment', '.github/workflows/install-smoke.yml', () => '# nothing\n', 'release-tarball-smoke-workflow', /install-smoke\.yml is not a mapping/);
    findsOne('install-smoke.yml with no jobs', '.github/workflows/install-smoke.yml', () => 'on:\n  workflow_call:\n', 'release-tarball-smoke-workflow', /install-smoke\.yml has no jobs mapping/);
    findsOne('install-smoke.yml with a null jobs value', '.github/workflows/install-smoke.yml', () => 'on:\n  workflow_call:\njobs:\n', 'release-tarball-smoke-workflow', /install-smoke\.yml has no jobs mapping/);
    passes('an agent file with a nested-call spawn that states run_in_background after the nested call', 'agents/gsd-executor.md', append('Agent(prompt=f(x), subagent_type="gsd-planner", run_in_background=false)'), 'debug-manager-blocking-spawn');
    passes('an agent file with a call that holds only whitespace between its parentheses', 'agents/gsd-executor.md', append('Agent(\n\n)'), 'debug-manager-blocking-spawn');
    {
      const hookCase = (title, rel, swept) => test(title, (t) => {
        const root = copyOfRepoFiles(t);
        const abs = path.join(root, ...rel.split('/'));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, 'const leaked = payload.tool_input.file_path;\n');
        const findings = runShipped(root, ['kimi-guard-typed-payload-reads']);
        assert.equal(findings.some((f) => f.file === rel), swept, JSON.stringify(findings));
      });
      hookCase('a new top-level hook outside the known readers is swept in', 'hooks/gsd-new-hook.js', true);
      hookCase('a file in a nested hooks directory is not swept in', 'hooks/lib/gsd-new-nested.js', false);
    }
    passes('a question mark separated from the dot by whitespace is no read', 'hooks/gsd-prompt-guard.js', append('const other = payload.tool_info?  .path;'), 'kimi-guard-typed-payload-reads');
    passes('a double slash inside a string hides the rest of its line, as the old comment stripper did', 'hooks/gsd-prompt-guard.js', append('const u = "a//b"; const leaked = payload.tool_input.file_path;'), 'kimi-guard-typed-payload-reads');
    passes('only "replace" states the flat menu is superseded', 'gsd-core/references/debugger-bug-taxonomy.md', (text) => text.replace(/replace|supersede|routed? selection/gi, 'x').replace(/append/gi, 'y') + '\nreplace\n', 'debugger-bug-taxonomy');
    passes('only "supersede" states the flat menu is superseded', 'gsd-core/references/debugger-bug-taxonomy.md', (text) => text.replace(/replace|supersede|routed? selection/gi, 'x').replace(/append/gi, 'y') + '\nsupersede\n', 'debugger-bug-taxonomy');
    passes('only "routed selection" states the flat menu is superseded', 'gsd-core/references/debugger-bug-taxonomy.md', (text) => text.replace(/replace|supersede|routed? selection/gi, 'x').replace(/append/gi, 'y') + '\nrouted selection\n', 'debugger-bug-taxonomy');
    passes('only "route selection" states the flat menu is superseded', 'gsd-core/references/debugger-bug-taxonomy.md', (text) => text.replace(/replace|supersede|routed? selection/gi, 'x').replace(/append/gi, 'y') + '\nroute selection\n', 'debugger-bug-taxonomy');
    passes('Heisenbug alone, with Mandelbug erased, defines the class', 'gsd-core/references/debugger-bug-taxonomy.md', erase(/mandelbug/gi), 'debugger-bug-taxonomy');
    findsOne('a fixer spawn whose prompt names the reviewer type is labelled by the first routed agent in list order', 'gsd-core/workflows/quick.md', append('Agent(subagent_type="gsd-code-fixer", prompt="""x subagent_type="gsd-code-reviewer" y""")'), 'model-routing-spawn-threading', /gsd-code-reviewer spawn missing model=/);
    passes('a model= written inside the prompt string satisfies the model param check, as in the old test', 'gsd-core/workflows/quick.md', append('Agent(subagent_type="gsd-code-fixer", prompt="""use model=x""")'), 'model-routing-spawn-threading');
    passes('a multi-line spawn that closes on its last argument line is claimed by neither form, so it is not checked', 'agents/gsd-executor.md', append('Agent(\n  subagent_type="gsd-planner",\n  prompt="x")'), 'debug-manager-blocking-spawn');
  }

  {
    // summary-commit-verification: windows and bounds pinned at limit-1, limit and limit+1
    const SCV = 'summary-commit-verification';
    const VERIFY_WORK = 'gsd-core/workflows/verify-work.md';
    const EXECUTOR = 'agents/gsd-executor.md';
    const PAUSE_WORK = 'gsd-core/workflows/pause-work.md';
    // Overwrites `token.length` characters of `text` so the token starts at `at`, keeping the length.
    const overwriteAt = (text, at, token) => text.slice(0, at) + token + text.slice(at + token.length);
    // Replaces every occurrence of `word` inside [from, to) by `dead`, a word of the same length.
    const scrub = (text, from, to, word, dead) => text.slice(0, from) + text.slice(from, to).split(word).join(dead) + text.slice(to);
    gapCases('a BLOCKER ending the given distance after the reconciliation heading', VERIFY_WORK, SCV, (text, gap) => {
      const at = text.indexOf('Commit-claim reconciliation');
      const keep = text.indexOf('#4670');
      let out = scrub(text, at, keep, 'BLOCKER', 'BLOCKED');
      out = scrub(out, keep, at + 2600, 'BLOCKER', 'BLOCKED');
      out = overwriteAt(out, keep + 2000, 'BLOCKER');
      return overwriteAt(out, at + gap - 'BLOCKER'.length, 'BLOCKER');
    }, 1800, /no BLOCKER within 1800 characters/);
    gapCases('a BLOCKER ending the given distance after the #4670 marker', VERIFY_WORK, SCV, (text, gap) => {
      const at = text.indexOf('#4670');
      const recon = text.indexOf('Commit-claim reconciliation');
      let out = scrub(text, at, at + 2600, 'BLOCKER', 'BLOCKED');
      out = overwriteAt(out, recon + 40, 'BLOCKER');
      return overwriteAt(out, at + gap - 'BLOCKER'.length, 'BLOCKER');
    }, 2400, /no BLOCKER within 2400 characters of #4670/);
    gapCases('a commit_claim_mismatch ending the given distance after the #4670 marker', VERIFY_WORK, SCV, (text, gap) => {
      const at = text.indexOf('#4670');
      const out = scrub(text, at, at + 2600, 'commit_claim_mismatch', 'commit_claim_mismatcX');
      return overwriteAt(out, at + gap - 'commit_claim_mismatch'.length, 'commit_claim_mismatch');
    }, 2400, /no commit_claim_mismatch within 2400 characters of #4670/);
    gapCases('a WARNING the given number of characters before plan_head_after', VERIFY_WORK, SCV, (text, gap) => `${text.split('WARNING').join('WARNINX')}\nWARNING${'x'.repeat(gap)}plan_head_after\n`, 400, /SUMMARYs without plan_head_after must fall back to the WARNING path/);
    gapCases('a porcelain mention ending the given distance after uncommitted_files', PAUSE_WORK, SCV, (text, gap) => {
      const at = text.indexOf('uncommitted_files');
      const dead = text.split('porcelain').join('porcelaix');
      return `${overwriteAt(dead, at + gap - 'porcelain'.length, 'porcelain')}\ngit status --porcelain\n`;
    }, 3000, /the uncommitted_files field is defined by the porcelain command/);
    gapCases('a porcelain mention starting the given distance before uncommitted_files', PAUSE_WORK, SCV, (text, gap) => {
      const at = text.indexOf('uncommitted_files');
      const dead = text.split('porcelain').join('porcelaix');
      return `${overwriteAt(dead, at - gap, 'porcelain')}\ngit status --porcelain\n`;
    }, 3000, /the uncommitted_files field is defined by the porcelain command/);
    gapCases('a MEASURED marker the given number of characters after the commits: 7 actuals line', EXECUTOR, SCV, (text, gap) => text.replace(/commits: 7 .{0,500}MEASURED/, `commits: 7 ${'x'.repeat(gap)}MEASURED`), 500, /the actuals block sources its count from the measurement/);
    gapCases('whitespace of the given width inside the SUMMARY halt', EXECUTOR, SCV, (text, gap) => text.replace(/HALT — do not write the\s{1,20}SUMMARY/i, `HALT — do not write the${' '.repeat(gap)}SUMMARY`), 20, /a measured zero with uncommitted code changes must halt the SUMMARY write/);
    passes('a single tab inside the SUMMARY halt', EXECUTOR, (text) => text.replace(/HALT — do not write the\s{1,20}SUMMARY/i, 'HALT — do not write the\tSUMMARY'), SCV);
    findsOne('no whitespace inside the SUMMARY halt', EXECUTOR, (text) => text.replace(/HALT — do not write the\s{1,20}SUMMARY/i, 'HALT — do not write theSUMMARY'), SCV, /a measured zero with uncommitted code changes must halt the SUMMARY write/);
    passes('pause-work without any uncommitted_files field', PAUSE_WORK, (text) => `${text.split('uncommitted_files').join('uncommitted_fileX')}\n`, SCV);
    // planner-estimate-emission: the Dimension 5 window
    gapCases('an estimate mention ending the given distance after Dimension 5', 'agents/gsd-plan-checker.md', 'planner-estimate-emission', (text, gap) => {
      const at = text.indexOf('Dimension 5');
      const out = text.slice(0, at) + text.slice(at, at + 2700).replace(/estimate/gi, 'estimatX') + text.slice(at + 2700);
      return overwriteAt(out, at + gap - 'estimate'.length, 'estimate');
    }, 2500, /Dimension 5 \(Scope Sanity\) must consult the emitted estimate/);
    findsOne('the Dimension 5 section gone from the plan-checker', 'agents/gsd-plan-checker.md', eraseAll('Dimension 5'), 'planner-estimate-emission', /no Dimension 5 section/);
    // tdd-reference-correctness: the plan-level pointer length
    gapCases('a plan-level gate section of the given number of non-blank lines', EXECUTOR, 'tdd-reference-correctness', (text, gap) => within('## Plan-Level TDD Gate Enforcement', '</tdd_execution>', () => `## Plan-Level TDD Gate Enforcement\nDetails live in references/tdd.md "Gate Enforcement Rules".\n${Array.from({ length: gap - 2 }, (_, i) => `pointer line ${i}`).join('\n')}\n\n`)(text), 6, /the plan-level gate section must be a short pointer/);
    // edge-probe-planner-contract: bounded gaps inside one line
    gapCases('an Edge Coverage label the given distance after the SPEC_PATH entry', 'gsd-core/workflows/plan-phase.md', 'edge-probe-planner-contract', (text, gap) => {
      let from = 0;
      for (;;) {
        const start = text.indexOf('<required_reading>', from);
        const end = text.indexOf('</required_reading>', start);
        const block = text.slice(start, end);
        if (block.includes('{UI_SPEC_PATH}')) {
          const s = start + block.indexOf('{SPEC_PATH} (Phase SPEC');
          const lineEnd = text.indexOf('\n', s);
          return `${text.slice(0, s)}{SPEC_PATH}${'x'.repeat(gap)}Edge Coverage${text.slice(lineEnd)}`;
        }
        from = end + 1;
      }
    }, 500, /\{SPEC_PATH\} entry in the planner files_to_read must be labelled as carrying the ## Edge Coverage section/);
    const qualityGate = (text, line) => {
      const start = text.lastIndexOf('<quality_gate>');
      const end = text.indexOf('</quality_gate>', start);
      return `${text.slice(0, start)}<quality_gate>\n${line}\n${text.slice(end)}`;
    };
    gapCases('an edge mention the given distance after resolved in the quality gate', 'gsd-core/workflows/plan-phase.md', 'edge-probe-planner-contract', (text, gap) => qualityGate(text, `resolved${'q'.repeat(gap)}edge must_haves`), 500, /the planner quality_gate must contain a checklist item tying resolved edges to must_haves/);
    gapCases('a must_haves mention the given distance after edge in the quality gate', 'gsd-core/workflows/plan-phase.md', 'edge-probe-planner-contract', (text, gap) => qualityGate(text, `resolved edge${'q'.repeat(gap)}must_haves`), 500, /the planner quality_gate must contain a checklist item tying resolved edges to must_haves/);
    findsOne('no quality_gate block in plan-phase', 'gsd-core/workflows/plan-phase.md', (text) => text.split('<quality_gate>').join('<quality_gat>'), 'edge-probe-planner-contract', /no <quality_gate> block/);
    // prohibition-probe.spec-phase-contract: the gaps of the bounded sentences, over a Step 5.6 block that carries every other phrase
    const PROBE_BASE = ['adversarial', 'soft gate', 'text mode', 'Prohibitions', 'references/prohibition-probe.md'];
    const probeBlock = (lines) => (text) => within('## Step 5.6', '\n## ', () => `## Step 5.6\n${[...PROBE_BASE, ...lines].map((line) => `${line}.`).join('\n')}\n`)(text);
    gapCases('a classifier mention the given distance after precision', 'gsd-core/workflows/spec-phase.md', 'prohibition-probe.spec-phase-contract', (text, gap) => probeBlock(['dismiss reason', 'never auto-dismiss', 'secure-phase', `precision${'x'.repeat(gap)}classif`])(text), 500, /Step 5\.6 must describe a precision classifier that drops routine engineering items/);
    gapCases('a reason the given distance after dismiss', 'gsd-core/workflows/spec-phase.md', 'prohibition-probe.spec-phase-contract', (text, gap) => probeBlock(['routine engineering', 'never auto-dismiss', 'secure-phase', `dismiss ${'x'.repeat(gap - 1)}reason`])(text), 500, /Step 5\.6 must require a non-empty reason when dismissing a prohibition/);
    gapCases('a never the given distance after --auto', 'gsd-core/workflows/spec-phase.md', 'prohibition-probe.spec-phase-contract', (text, gap) => probeBlock(['routine engineering', 'dismiss reason', 'secure-phase', `--auto${'x'.repeat(gap)}never dismiss`])(text), 500, /Step 5\.6 must specify that --auto never auto-dismisses prohibitions/);
    gapCases('a dismiss the given distance after never following --auto', 'gsd-core/workflows/spec-phase.md', 'prohibition-probe.spec-phase-contract', (text, gap) => probeBlock(['routine engineering', 'dismiss reason', 'secure-phase', `--auto never${'x'.repeat(gap)}dismiss`])(text), 500, /Step 5\.6 must specify that --auto never auto-dismisses prohibitions/);
    gapCases('a security mention the given distance after canon', 'gsd-core/workflows/spec-phase.md', 'prohibition-probe.spec-phase-contract', (text, gap) => probeBlock(['routine engineering', 'dismiss reason', 'never auto-dismiss', `canon${'x'.repeat(gap)}security`])(text), 500, /Step 5\.6 must emit a canon-referral breadcrumb/);
    // section-marker-inversion-guard: text inside the gated body, and unparseable sections
    const GATED_OPEN = '<!-- gsd:section id="auto-advance-dispatch"';
    const GATED_CLOSE = '<!-- /gsd:section -->';
    findsOne('a resolver line inside the gated body of discuss-phase-assumptions', 'gsd-core/workflows/discuss-phase-assumptions.md', within(GATED_OPEN, GATED_CLOSE, (body) => `${body}gsd_run query config-set workflow._auto_chain_active\n`), 'section-marker-inversion-guard', /every resolver line \(--auto parse, config-set, AUTO_MODE read\) must lie OUTSIDE the gated marker/);
    // executor-isolation-prompt-contract: the placeholder floor, the substitution gap and the mapped-value length
    const DISPATCH_FRAGMENT = 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md';
    const QUICK_FRAGMENT = 'gsd-core/workflows/quick-batch/steps/worktree-dispatch.md';
    const PLACEHOLDER_NAMES = ['plan_number', 'phase_number', 'phase_name', 'phase_dir', 'plan_file', 'plan_id', 'plan_padded', 'project_rel', 'config_rel'];
    const substitutionList = (count) => (text) => text.replace(/Substitute this plan's[\s\S]{0,400}?placeholders/, `Substitute this plan's ${PLACEHOLDER_NAMES.slice(0, count).map((name) => `{${name}}`).join(', ')} placeholders`);
    findsOne('a substitution list of one placeholder under the floor', DISPATCH_FRAGMENT, substitutionList(6), 'executor-isolation-prompt-contract', /the substitution list names 6 placeholders, expected at least 7/);
    passes('a substitution list of exactly the floor', DISPATCH_FRAGMENT, substitutionList(7), 'executor-isolation-prompt-contract');
    gapCases('a substitution list gap of the given width before the word placeholders', DISPATCH_FRAGMENT, 'executor-isolation-prompt-contract', (text, gap) => {
      const names = PLACEHOLDER_NAMES.map((name) => `{${name}}`).join(', ');
      return text.replace(/Substitute this plan's[\s\S]{0,400}?placeholders/, `Substitute this plan's ${names}${' '.repeat(gap - names.length - 1)}placeholders`);
    }, 400, /the fragment's substitution list must name at least the 7 known placeholders/);
    const mappedValue = (length) => swap('`{plan_file}` = `${quick_id}-PLAN.md`', `\`{plan_file}\` = \`${'v'.repeat(length)}\``);
    gapCases('a mapped value of the given length for plan_file', QUICK_FRAGMENT, 'executor-isolation-prompt-contract', (text, gap) => mappedValue(gap)(text), 80, /every orchestrator-worktree placeholder must have a mapped value or a stated not-applicable for a quick item/);
    passes('a mapped value of one character for plan_file', QUICK_FRAGMENT, mappedValue(1), 'executor-isolation-prompt-contract');
    findsOne('an empty mapped value for plan_file', QUICK_FRAGMENT, swap('`{plan_file}` = `${quick_id}-PLAN.md`', '`{plan_file}` = ``'), 'executor-isolation-prompt-contract', /has neither a mapped value nor a stated "not applicable"/);
    passes('a not-applicable statement standing for plan_file', QUICK_FRAGMENT, swap('`{plan_file}` = `${quick_id}-PLAN.md`', '`{plan_file}` is not applicable'), 'executor-isolation-prompt-contract');
    findsOne('a bash block holding the objective marker', DISPATCH_FRAGMENT, append('```bash\necho "<objective>"\n```'), 'executor-isolation-prompt-contract', /the template text must sit in no bash block/);
    findsOne('a fenced block that never closes', DISPATCH_FRAGMENT, append('```bash\necho hi'), 'executor-isolation-prompt-contract', /the substitution instruction must name every placeholder any fenced block of the fragment uses/);
    passes('the unconditional criterion followed by OR on its line', DISPATCH_FRAGMENT, (text) => text.replace('```text\n', '```text\n- SUMMARY.md created AND committed OR skipped_gitignored\n'), 'executor-isolation-prompt-contract');
    findsOne('the conditional embed line without its trailing comment', DISPATCH_FRAGMENT, (text) => text.split('\n').map((line) => (line.startsWith('${TDD_APPLICABLE ? "- tdd.md" : ""}') ? '${TDD_APPLICABLE ? "- tdd.md" : ""}' : line)).join('\n'), 'executor-isolation-prompt-contract', /the template must hold the conditional embed line with its trailing comment/);

    // planner-estimate-emission: the estimate row, the field indents and the fence owner (pinned at its edges)
    const PLANNER = 'agents/gsd-planner.md';
    const PLAN_MD = 'docs/reference/plan-md.md';
    gapCases('whitespace of the given width before `estimate` in the planner field table', PLANNER, 'planner-estimate-emission', (text, gap) => text.replace(/\|\s{0,20}`estimate`\s{0,20}\|/, `|${' '.repeat(gap)}\`estimate\`|`), 20, /the field reference table must have an `estimate` row/);
    gapCases('whitespace of the given width after `estimate` in the planner field table', PLANNER, 'planner-estimate-emission', (text, gap) => text.replace(/\|\s{0,20}`estimate`\s{0,20}\|/, `|\`estimate\`${' '.repeat(gap)}|`), 20, /the field reference table must have an `estimate` row/);
    gapCases('whitespace of the given width before `estimate` in plan-md.md', PLAN_MD, 'planner-estimate-emission', (text, gap) => text.replace(/\|\s{0,20}`estimate`\s{0,20}\|/, `|${' '.repeat(gap)}\`estimate\`|`), 20, /plan-md\.md must document `estimate`/);
    gapCases('whitespace of the given width after `estimate` in plan-md.md', PLAN_MD, 'planner-estimate-emission', (text, gap) => text.replace(/\|\s{0,20}`estimate`\s{0,20}\|/, `|\`estimate\`${' '.repeat(gap)}|`), 20, /plan-md\.md must document `estimate`/);
    for (const field of ['tokens', 'tasks', 'confidence']) {
      gapCases(`an indent of the given width before ${field}: in the planner template`, PLANNER, 'planner-estimate-emission', (text, gap) => text.replace(new RegExp(`^ {2}${field}:`, 'm'), `${' '.repeat(gap)}${field}:`), 20, new RegExp(`the estimate block must carry tokens, tasks and confidence \\(missing ${field}\\)`));
      if (field !== 'confidence') findsOne(`no indent before ${field}: in the planner template`, PLANNER, (text) => text.replace(new RegExp(`^ {2}${field}:`, 'm'), `${field}:`), 'planner-estimate-emission', new RegExp(`\\(missing ${field}\\)`));
    }
    const PLANNER_BLOCK = (fence, bodyExtra = '') => `---\nphase: x\nmust_haves: y\nestimate:\n  tokens: 1\n  tasks: 1\n  confidence: low           # low | med | high\n${bodyExtra}${fence}\n| \`estimate\` | No |\nestimate-calibration sample count\n`;
    const fenceFindings = (t, content) => {
      const root = copyOfRepoFiles(t);
      fs.writeFileSync(path.join(root, 'agents', 'gsd-planner.md'), content);
      return runShipped(root, ['planner-estimate-emission']).map((finding) => finding.message).filter((message) => /frontmatter template is not in the planner/.test(message));
    };
    test('a template closed by --- is found by planner-estimate-emission', (t) => assert.deepEqual(fenceFindings(t, PLANNER_BLOCK('---')), []));
    test('a CRLF template closed by --- is found by planner-estimate-emission', (t) => assert.deepEqual(fenceFindings(t, PLANNER_BLOCK('---').split('\n').join('\r\n')), []));
    test('a template closed by --- and trailing spaces is found (the fence owner accepts them)', (t) => assert.deepEqual(fenceFindings(t, PLANNER_BLOCK('---  ')), []));
    test('a template closed by ---- is found when no exact closer follows (the fence owner is lenient)', (t) => assert.deepEqual(fenceFindings(t, PLANNER_BLOCK('----')), []));
    test('a template closed by ---- while an exact closer follows closes at the exact one', (t) => assert.deepEqual(fenceFindings(t, PLANNER_BLOCK('----', '').replace('estimate-calibration', '---\nestimate-calibration')), []));
    test('an unclosed template block is not found', (t) => assert.equal(fenceFindings(t, '---\nphase: x\nmust_haves: y\nestimate:\n  tokens: 1\n').length > 0, true));
    test('consecutive blocks: the second one holding phase and must_haves is the template', (t) => assert.deepEqual(fenceFindings(t, `---\na: 1\n---\n${PLANNER_BLOCK('---')}`), []));
    test('a block that declares only phase is not the template', (t) => assert.equal(fenceFindings(t, '---\nphase: x\n---\nnothing\n').length > 0, true));
    // edge-probe-planner-contract: the Edge Coverage heading gap
    gapCases('whitespace of the given width between ## and Edge Coverage in the downstream_consumer block', 'gsd-core/workflows/plan-phase.md', 'edge-probe-planner-contract', (text, gap) => within('<downstream_consumer>', '</downstream_consumer>', (block) => block.split('## Edge Coverage').join(`##${' '.repeat(gap)}Edge Coverage`))(text), 20, /the <downstream_consumer> block must reference ## Edge Coverage/);
    passes('## directly followed by Edge Coverage in the downstream_consumer block', 'gsd-core/workflows/plan-phase.md', (text) => within('<downstream_consumer>', '</downstream_consumer>', (block) => block.split('## Edge Coverage').join('##Edge Coverage'))(text), 'edge-probe-planner-contract');
    // executor-isolation-prompt-contract: the remaining bounded patterns
    gapCases('whitespace of the given width between steps and 0/0a/0b', DISPATCH_FRAGMENT, 'executor-isolation-prompt-contract', (text, gap) => text.replace(/steps\s{0,20}0\/0a\/0b/, `steps${' '.repeat(gap)}0/0a/0b`), 20, /the per-commit HEAD\/cwd-drift\/path-guard discipline must be pointed at/);
    const QUICK_BULLET = (edit) => within('**`isolation == "orchestrator-worktree"`:**', '**`isolation == "none"`:**', edit);
    gapCases('an omit marker the given distance before [gsd:dispatch', QUICK_FRAGMENT, 'executor-isolation-prompt-contract', (text, gap) => QUICK_BULLET((bullet) => bullet.replace(/Omit[^\n]{0,500}\[gsd:dispatch/, `Omit${'x'.repeat(gap)}[gsd:dispatch`))(text), 500, /the \[gsd:dispatch \.\.\.\] marker line must be stated as omitted for a quick item/);
    gapCases('whitespace of the given width before = in the plan_padded mapping', QUICK_FRAGMENT, 'executor-isolation-prompt-contract', (text, gap) => text.replace(/`\{plan_padded\}`\s{0,20}=\s{0,20}`\$\{quick_id\}`/, `\`{plan_padded}\`${' '.repeat(gap)}= \`\${quick_id}\``), 20, /\{plan_padded\} must map to the quick id/);
    gapCases('whitespace of the given width after = in the plan_padded mapping', QUICK_FRAGMENT, 'executor-isolation-prompt-contract', (text, gap) => text.replace(/`\{plan_padded\}`\s{0,20}=\s{0,20}`\$\{quick_id\}`/, `\`{plan_padded}\` =${' '.repeat(gap)}\`\${quick_id}\``), 20, /\{plan_padded\} must map to the quick id/);
    test('the executor isolation contract and tdd-walk agree on the dispatch step and the embed line', () => {
      const walk = require(path.join(REPO_ROOT, 'tests', 'qa', 'tdd-walk.cjs'));
      assert.equal(path.relative(REPO_ROOT, walk.DISPATCH_STEP_PATH).split(path.sep).join('/'), 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md');
      assert.equal(walk.TDD_EMBED_TERNARY, '${TDD_APPLICABLE ? "- tdd.md" : ""}');
      const dispatch = fs.readFileSync(path.join(REPO_ROOT, 'gsd-core', 'workflows', 'execute-phase', 'steps', 'executor-isolation-dispatch.md'), 'utf8');
      assert.ok(dispatch.split(/\r?\n/).some((line) => line.startsWith(walk.TDD_EMBED_TERNARY)));
    });
    // prohibition-probe.spec-phase-contract: the bounded stems, the second dismissal branch and every alternative as the sole satisfier
    gapCases('a word stem of the given length after drop', 'gsd-core/workflows/spec-phase.md', 'prohibition-probe.spec-phase-contract', (text, gap) => probeBlock(['dismiss reason', 'never auto-dismiss', 'secure-phase', `drop${'a'.repeat(gap)} engineering`])(text), 30, /Step 5\.6 must describe a precision classifier that drops routine engineering items/);
    gapCases('a word stem of the given length after dismiss', 'gsd-core/workflows/spec-phase.md', 'prohibition-probe.spec-phase-contract', (text, gap) => probeBlock(['routine engineering', 'never auto-dismiss', 'secure-phase', `dismiss${'a'.repeat(gap)} reason`])(text), 30, /Step 5\.6 must require a non-empty reason when dismissing a prohibition/);
    gapCases('a dismiss the given distance after reason', 'gsd-core/workflows/spec-phase.md', 'prohibition-probe.spec-phase-contract', (text, gap) => probeBlock(['routine engineering', 'never auto-dismiss', 'secure-phase', `reason${'x'.repeat(gap)}dismiss`])(text), 500, /Step 5\.6 must require a non-empty reason when dismissing a prohibition/);
    const PROBE_DEFAULTS = { adversarial: 'adversarial', precision: 'routine engineering', soft: 'soft gate', dismiss: 'dismiss reason', auto: 'never auto-dismiss', text: 'text mode', canon: 'secure-phase' };
    const soleBranch = (key, phrase) => passes(`${phrase} alone satisfies the ${key} sentence of Step 5.6`, 'gsd-core/workflows/spec-phase.md', (text) => within('## Step 5.6', '\n## ', () => `## Step 5.6\n${Object.entries(PROBE_DEFAULTS).map(([name, line]) => `${name === key ? phrase : line}.`).join('\n')}\nProhibitions.\nreferences/prohibition-probe.md.\n`)(text), 'prohibition-probe.spec-phase-contract');
    for (const phrase of ['silently become', 'would NOT want', 'must not', 'mustnot']) soleBranch('adversarial', phrase);
    for (const phrase of ['routine engineering', 'drops the engineering', 'precision classif']) soleBranch('precision', phrase);
    for (const phrase of ['write anyway', 'writeanyway', 'soft-gate', 'with flags']) soleBranch('soft', phrase);
    for (const phrase of ['dismiss the reason', 'reason to dismiss']) soleBranch('dismiss', phrase);
    for (const phrase of ['--auto will never dismiss', '--auto may not dismiss', 'never auto dismiss']) soleBranch('auto', phrase);
    for (const phrase of ['text-mode', 'non-Claude', 'nonClaude', 'AskUserQuestion']) soleBranch('text', phrase);
    for (const phrase of ['canon of security', 'OWASP', 'GDPR']) soleBranch('canon', phrase);

    gapCases('a gap of the given width after drop before engineering', 'gsd-core/workflows/spec-phase.md', 'prohibition-probe.spec-phase-contract', (text, gap) => probeBlock(['dismiss reason', 'never auto-dismiss', 'secure-phase', `drop ${'x'.repeat(gap - 1)}engineering`])(text), 500, /Step 5\.6 must describe a precision classifier that drops routine engineering items/);
    const FENCE_CASES = [['a lone CR opening the template', '---\rphase: x\rmust_haves: y\restimate:\r---\r'], ['a U+2028 opening the template', '---\u2028phase: x\u2028must_haves: y\u2028estimate:\u2028---\u2028'], ['a lone CR closing the template', '---\nphase: x\nmust_haves: y\nestimate:\n---\r'], ['a U+2028 closing the template', '---\nphase: x\nmust_haves: y\nestimate:\n---\u2028']];
    for (const [title, content] of FENCE_CASES) test(`${title} does not make a template (the fence owner needs LF or CRLF)`, (t) => assert.equal(fenceFindings(t, content).length > 0, true));
    passes('the Severity word in lowercase alone satisfies the pause-work column check', 'gsd-core/workflows/pause-work.md', swap('Severity', 'Sevxrity'), 'anti-pattern-enforcement');
    passes('the Severity word capitalised alone satisfies the pause-work column check', 'gsd-core/workflows/pause-work.md', swap('severity', 'sevxrity'), 'anti-pattern-enforcement');
    findsOne('the text fence of the dispatch fragment gone is one finding', DISPATCH_FRAGMENT, swap('```text', '```txt'), 'executor-isolation-prompt-contract', /the prompt template must be exactly one closed text fence \(the fragment must hold exactly one text fence \(the prompt template\), found 0\)/);
    findsOne('a second text fence in the dispatch fragment is one finding', DISPATCH_FRAGMENT, append('```text\nx\n```'), 'executor-isolation-prompt-contract', /the prompt template must be exactly one closed text fence \(the fragment must hold exactly one text fence \(the prompt template\), found 2\)/);
    test('a template closed by --- and a tab is found (the fence owner accepts trailing tabs)', (t) => assert.deepEqual(fenceFindings(t, PLANNER_BLOCK('---\t')), []));
    for (const pad of [2, 5, 6, 7, 20, 100]) test(`a template opened by --- and ${pad} trailing spaces is not a template (only an exact --- opens a block)`, (t) => assert.equal(fenceFindings(t, PLANNER_BLOCK('---').replace('---\n', `---${' '.repeat(pad)}\n`)).length > 0, true));
    findsOne('a tilde text fence beside the backtick one is two prompt templates', DISPATCH_FRAGMENT, append('~~~text\nx\n~~~'), 'executor-isolation-prompt-contract', /the prompt template must be exactly one closed text fence \(the fragment must hold exactly one text fence \(the prompt template\), found 2\)/);
    findsOne('an upper-case TEXT fence beside the backtick one is two prompt templates', DISPATCH_FRAGMENT, append('```TEXT\nx\n```'), 'executor-isolation-prompt-contract', /found 2\)/);
    findsOne('a text fence inside another fence still counts as a second prompt template (the old test counted every such line)', DISPATCH_FRAGMENT, append('~~~md\n```text\nx\n```\n~~~'), 'executor-isolation-prompt-contract', /found 2\)/);
    findsOne('a four-space indented text fence counts as a second prompt template', DISPATCH_FRAGMENT, append('    ```text\n    x\n    ```'), 'executor-isolation-prompt-contract', /found 2\)/);
    findsOne('a tab indented text fence counts as a second prompt template', DISPATCH_FRAGMENT, append('\t```text\n\tx\n\t```'), 'executor-isolation-prompt-contract', /found 2\)/);
  }

  {
    // ---- group 3 controls and boundaries
    const readRepo3 = (rel) => fs.readFileSync(path.join(REPO_ROOT, ...rel.split('/')), 'utf8');
    // Replaces the gap at `slotNo` of the first match of `re` (literal, gap, literal, ...) with `gap` characters of `fill`.
    const gapAt = (re, slotNo, fill, scope = (edit) => edit) => (text, gap) => scope((section) => section.replace(re, (...args) => {
      const parts = args.slice(1, -2);
      parts[slotNo * 2 - 1] = fill.repeat(gap);
      return parts.join('');
    }))(text);
    // A word boundary must survive in front of a gap: the gap starts with a space.
    const spaced = (gap) => ` ${'x'.repeat(gap - 1)}`;

    // A file a contract reads through ctx.exists, removed from the tree, is a finding of its own.
    for (const [rel, contract, why] of [
      ['gsd-core/references/debugger-rca-branching.md', 'debugger-rca-branching', 'debugger-rca-branching.md reference must exist'],
      ['gsd-core/references/executor-examples.md', 'prompt-thinning', 'gsd-core/references/executor-examples.md must exist'],
      ['gsd-core/references/planner-antipatterns.md', 'prompt-thinning', 'gsd-core/references/planner-antipatterns.md must exist'],
      ['gsd-core/references/edge-probe.md', 'edge-probe-docs-fixtures', 'the edge-probe reference doc must exist'],
      ['gsd-core/references/few-shot-examples/plan-checker.md', 'few-shot-calibration', 'plan-checker.md must exist in references/few-shot-examples/'],
      ['gsd-core/references/few-shot-examples/verifier.md', 'few-shot-calibration', 'verifier.md must exist in references/few-shot-examples/'],
    ]) {
      test(`${rel} removed from the tree fails the existence assertion of ${contract}`, (t) => {
        const root = copyOfRepoFiles(t);
        fs.unlinkSync(path.join(root, ...rel.split('/')));
        const findings = runShipped(root, [contract]);
        assert.ok(findings.some((f) => f.message.includes(why)), JSON.stringify(findings));
      });
    }

    // debugger-rca-branching: the whitespace gaps are bounded at 20 and the same-line gaps at 500.
    const RCA_REF = 'gsd-core/references/debugger-rca-branching.md';
    gapCases('whitespace between "single-cause" and "bias"', RCA_REF, 'debugger-rca-branching',
      gapAt(/(5-Whys single-cause)(\s{1,20})(bias)/, 1, ' '), 20, /the reference must name the 5-Whys \/ single-cause bias failure mode/);
    gapCases('characters between root_cause and "one cause OR a small"', RCA_REF, 'debugger-rca-branching',
      gapAt(/(root_cause)([^\n]{0,500})(one cause OR a small)(\s{1,20})(set of contributing causes)/, 1, 'x'), 500, /the reference must document that root_cause can record multiple contributing causes/);
    gapCases('whitespace between "small" and "set of contributing causes"', RCA_REF, 'debugger-rca-branching',
      gapAt(/(root_cause)([^\n]{0,500})(one cause OR a small)(\s{1,20})(set of contributing causes)/, 2, ' '), 20, /the reference must document that root_cause can record multiple contributing causes/);
    gapCases('whitespace between "single-cause sessions are" and "byte-for-byte unchanged"', RCA_REF, 'debugger-rca-branching',
      (text, gap) => gapAt(/(single-cause sessions are)(\s{1,20})(byte-for-byte unchanged)/, 1, ' ')(text.split('shape unchanged').join('shape kept'), gap), 20, /the reference must document that single-cause sessions are unaffected/);
    gapCases('characters between "root_cause:" and "small set of contributing causes" in the DEBUG.md template', 'gsd-core/templates/DEBUG.md', 'debugger-rca-branching',
      gapAt(/(root_cause:)([^\n]{0,500})(small set of contributing causes)/, 1, 'x'), 500, /the DEBUG.md root_cause field must note it may hold one or more contributing causes/);
    gapCases('whitespace between "5-" and "whys" in the debugger philosophy', 'gsd-core/references/debugger-philosophy.md', 'debugger-rca-branching',
      (text, gap) => `${text.replace(/single[\s-]?cause|5-?\s{0,20}whys|root[\s-]?cause bias/gi, '')}\n5-${' '.repeat(gap)}whys\n`, 20, /debugger-philosophy.md must note the single-cause-bias/);
    passes('the shape-unchanged wording alone states the compatibility', RCA_REF, erase(/single-cause sessions are\s{1,20}byte-for-byte unchanged/g), 'debugger-rca-branching');
    passes('the byte-for-byte wording alone states the compatibility', RCA_REF, erase(/shape unchanged/g), 'debugger-rca-branching');

    // few-shot-calibration: the frontmatter fields allow up to 20 whitespace characters after the colon.
    const PLAN_CHECKER = 'gsd-core/references/few-shot-examples/plan-checker.md';
    gapCases('whitespace after "component:"', PLAN_CHECKER, 'few-shot-calibration', gapAt(/(component:)(\s{0,20})(plan-checker)/, 1, ' '), 20, /plan-checker.md frontmatter must name its component/);
    gapCases('whitespace after "version:"', PLAN_CHECKER, 'few-shot-calibration', gapAt(/(version:)(\s{0,20})(\d)/, 1, ' '), 20, /plan-checker.md frontmatter must carry a numeric version/);
    gapCases('whitespace after "last_calibrated:"', PLAN_CHECKER, 'few-shot-calibration', gapAt(/(last_calibrated:)(\s{0,20})(\d{4}-\d{2}-\d{2})/, 1, ' '), 20, /plan-checker.md frontmatter must carry a last_calibrated date/);
    // More Input and Output blocks than examples still satisfy the "at least" assertions.
    passes('an extra Input block in the plan-checker reference', PLAN_CHECKER, append('**Input:**'), 'few-shot-calibration');
    passes('an extra Output block in the plan-checker reference', PLAN_CHECKER, append('**Output:**'), 'few-shot-calibration');
    passes('an extra Input block in the verifier reference', 'gsd-core/references/few-shot-examples/verifier.md', append('**Input:**'), 'few-shot-calibration');
    passes('an extra Output block in the verifier reference', 'gsd-core/references/few-shot-examples/verifier.md', append('**Output:**'), 'few-shot-calibration');
    passes('a version with more than one digit in the plan-checker reference', PLAN_CHECKER, (text) => text.replace(/^version: \d+\n/m, 'version: 12\n'), 'few-shot-calibration');
    test('few-shot-calibration holds a reformatted frontmatter that keeps the three fields', (t) => {
      const root = copyOfRepoFiles(t);
      const abs = path.join(root, ...PLAN_CHECKER.split('/'));
      const text = fs.readFileSync(abs, 'utf8');
      const after = text.replace('component: plan-checker', 'component:    plan-checker');
      assert.notEqual(after, text);
      fs.writeFileSync(abs, after);
      assert.deepEqual(runShipped(root, ['few-shot-calibration']), []);
    });

    // edge-probe-docs-fixtures: the ADR phrases hold a gap of up to 500 characters (no full stop) at each slot.
    const ADR_550 = 'docs/adr/550-spec-phase-probe-contract.md';
    const COVERED = /covered\b[^.]{0,500}resolved[^.]{0,500}explicit/gi;
    const BACKSTOP = /backstop\b[^.]{0,500}resolved[^.]{0,500}backstop/gi;
    gapCases('characters between covered and resolved', ADR_550, 'edge-probe-docs-fixtures', (text, gap) => `${text.replace(COVERED, '')}\ncovered${spaced(gap)}resolved, explicit\n`, 500, /the ADR must document covered -> \{resolved, explicit\}/);
    gapCases('characters between resolved and explicit', ADR_550, 'edge-probe-docs-fixtures', (text, gap) => `${text.replace(COVERED, '')}\ncovered resolved${'x'.repeat(gap)}explicit\n`, 500, /the ADR must document covered -> \{resolved, explicit\}/);
    gapCases('characters between backstop and resolved', ADR_550, 'edge-probe-docs-fixtures', (text, gap) => `${text.replace(BACKSTOP, '')}\nbackstop${spaced(gap)}resolved, backstop\n`, 500, /the ADR must document backstop -> \{resolved, backstop\}/);
    gapCases('characters between resolved and the second backstop', ADR_550, 'edge-probe-docs-fixtures', (text, gap) => `${text.replace(BACKSTOP, '')}\nbackstop resolved${'x'.repeat(gap)}backstop\n`, 500, /the ADR must document backstop -> \{resolved, backstop\}/);
    passes('the count-preserved wording alone states the migration contract', ADR_550, swap('count-for-count', 'count-preserved'), 'edge-probe-docs-fixtures');

    // A tagged ref of plain characters is held to 100 characters per part; a longer part is a finding, never a read.
    for (const [part, make] of [
      ['directory', (n) => `${'a'.repeat(n)}/expected-coverage.json`],
      ['file', (n) => `02-merge-intervals/${'a'.repeat(n)}`],
    ]) {
      for (const [n, plain] of [[99, true], [100, true], [101, false]]) {
        test(`a tagged block naming a ${part} of ${n} characters ${plain ? 'is a plain' : 'is past the bound of a plain'} fixture reference for edge-probe-docs-fixtures`, (t) => {
          const root = copyOfRepoFiles(t);
          const abs = path.join(root, 'gsd-core', 'references', 'edge-probe.md');
          const text = fs.readFileSync(abs, 'utf8');
          const after = text.replace('```json edge-probe:02-merge-intervals/expected-coverage.json', `\`\`\`json edge-probe:${make(n)}`);
          assert.notEqual(after, text);
          fs.writeFileSync(abs, after);
          const findings = runShipped(root, ['edge-probe-docs-fixtures']);
          assert.equal(findings.some((f) => f.message.includes('which is not a plain <dir>/<file> fixture reference')), !plain, JSON.stringify(findings));
        });
      }
    }
    test('a fixture directory with an expected-coverage.json and no tagged block fails the count of edge-probe-docs-fixtures', (t) => {
      const root = copyOfRepoFiles(t);
      write(root, 'gsd-core/references/edge-probe-fixtures/07-extra/expected-coverage.json', '{}\n');
      const findings = runShipped(root, ['edge-probe-docs-fixtures']);
      assert.ok(findings.some((f) => f.message.includes('the doc must embed one tagged fixture block for every expected-coverage.json fixture (count equality)')), JSON.stringify(findings));
    });
    test('an expected-coverage.json nested below a fixture directory is not counted by edge-probe-docs-fixtures', (t) => {
      const root = copyOfRepoFiles(t);
      write(root, 'gsd-core/references/edge-probe-fixtures/06-resolved-mixed/nested/expected-coverage.json', '{}\n');
      assert.deepEqual(runShipped(root, ['edge-probe-docs-fixtures']), []);
    });
    passes('a doc block reformatted as compact JSON with the same data', 'gsd-core/references/edge-probe.md', within('```json edge-probe:02-merge-intervals/expected-coverage.json', '\n```', (section) => {
      const at = section.indexOf('\n');
      return `${section.slice(0, at + 1)}${JSON.stringify(JSON.parse(section.slice(at + 1)))}`;
    }), 'edge-probe-docs-fixtures');
    passes('a fixture file reformatted as compact JSON with the same data', 'gsd-core/references/edge-probe-fixtures/02-merge-intervals/expected-coverage.json', (text) => JSON.stringify(JSON.parse(text)), 'edge-probe-docs-fixtures');
    findsOne('a fixture file whose data differs from its doc block', 'gsd-core/references/edge-probe-fixtures/02-merge-intervals/expected-coverage.json', swap('"R1"', '"R9"'), 'edge-probe-docs-fixtures', 'the doc block edge-probe:02-merge-intervals/expected-coverage.json must parse and deep-equal its fixture file');
    findsOne('a fixture file that is not JSON', 'gsd-core/references/edge-probe-fixtures/02-merge-intervals/expected-coverage.json', () => '{', 'edge-probe-docs-fixtures', 'the doc block edge-probe:02-merge-intervals/expected-coverage.json must parse and deep-equal its fixture file');

    // ci-merge-group-wiring: only the workflows directly under .github/workflows are read.
    test('a workflow nested below .github/workflows is not read by ci-merge-group-wiring', (t) => {
      const root = copyOfRepoFiles(t);
      write(root, '.github/workflows/nested/garbage.yml', 'a: [\n');
      write(root, '.github/workflows/nested/deeper/garbage.yml', 'a: [\n');
      assert.deepEqual(runShipped(root, ['ci-merge-group-wiring']), []);
    });
    passes('a second job supplying no required context in a metadata workflow that is also guarded', '.github/workflows/docs-required.yml', yamlEdit((workflow) => {
      workflow.jobs['extra-job'] = { 'runs-on': 'ubuntu-latest', if: "github.event_name != 'merge_group' && github.event_name == 'pull_request'", steps: [{ run: 'true' }] };
    }), 'ci-merge-group-wiring');
    passes('every step of a metadata job guarded in place of the job', '.github/workflows/branch-naming.yml', yamlEdit((workflow) => {
      for (const job of Object.values(workflow.jobs)) {
        const guard = job.if;
        delete job.if;
        job.steps = (job.steps || [{ run: 'true' }]).map((step) => ({ ...step, if: guard }));
      }
    }), 'ci-merge-group-wiring');
    findsOne('a guard that or-s in another event on a metadata job', '.github/workflows/branch-naming.yml', yamlEdit((workflow) => {
      for (const job of Object.values(workflow.jobs)) job.if = "github.event_name != 'merge_group' || github.event_name == 'merge_group'";
    }), 'ci-merge-group-wiring', 'branch-naming.yml: every job or step must be skipped on merge_group');

    // resolver-hoist-guard: the step file named by the manifest must be a plain gsd-core/workflows path.
    const MANIFEST3 = 'gsd-core/workflows/section-manifest.json';
    const withRead = (read) => (text) => {
      const manifest = JSON.parse(text);
      for (const sections of Object.values(manifest.workflows)) for (const section of sections) if (section.id === 'structural-pre-pass') section.read = read;
      return JSON.stringify(manifest, null, 2);
    };
    for (const [label, read] of [
      ['a parent directory segment', 'gsd-core/workflows/../../README.md'],
      ['a dot segment', 'gsd-core/workflows/./code-review/steps/structural-pre-pass.md'],
      ['a path outside gsd-core/workflows', 'docs/README.md'],
      ['a space', 'gsd-core/workflows/a b.md'],
      ['no .md suffix', 'gsd-core/workflows/code-review/steps/structural-pre-pass.txt'],
      ['an absolute path', '/etc/passwd'],
      ['a number', 7],
    ]) {
      test(`a manifest step file with ${label} is a finding of resolver-hoist-guard, never a read`, (t) => {
        const root = copyOfRepoFiles(t);
        const abs = path.join(root, ...MANIFEST3.split('/'));
        fs.writeFileSync(abs, withRead(read)(fs.readFileSync(abs, 'utf8')));
        const findings = runShipped(root, ['resolver-hoist-guard']);
        assert.ok(findings.some((f) => f.message.includes('which is not a plain gsd-core/workflows step path')), JSON.stringify(findings));
        assert.ok(!findings.some((f) => /cannot read the file/.test(f.message)), JSON.stringify(findings));
      });
    }
    for (const [part, make] of [
      ['file stem', (n) => `gsd-core/workflows/${'a'.repeat(n)}.md`],
      ['directory depth', (n) => `gsd-core/workflows/${'d/'.repeat(n)}x.md`],
    ]) {
      for (const [n, plain] of part === 'file stem' ? [[99, true], [100, true], [101, false]] : [[5, true], [6, true], [7, false]]) {
        test(`a manifest step file with a ${part} of ${n} ${plain ? 'is a plain' : 'is past the bound of a plain'} step path for resolver-hoist-guard`, (t) => {
          const root = copyOfRepoFiles(t);
          const abs = path.join(root, ...MANIFEST3.split('/'));
          fs.writeFileSync(abs, withRead(make(n))(fs.readFileSync(abs, 'utf8')));
          const findings = runShipped(root, ['resolver-hoist-guard']);
          assert.equal(findings.some((f) => f.message.includes('which is not a plain gsd-core/workflows step path')), !plain, JSON.stringify(findings));
        });
      }
    }
    passes('a forbidden resolver substring in prose of a gated step file is not a call', 'gsd-core/workflows/code-review/steps/structural-pre-pass.md', append('The code_quality.fallow.enabled fact is resolved before this section is read.'), 'resolver-hoist-guard');
    passes('a resolver call for an atom the map does not know in a gated step file', 'gsd-core/workflows/code-review/steps/structural-pre-pass.md', append('```bash\ngsd-sdk query config-get some.other.key\n```'), 'resolver-hoist-guard');

    // prompt-thinning: every gap of the external review patterns is held to 500 characters without a full stop.
    const planner = 'agents/gsd-planner.md';
    const inWaves = (edit) => inStepOf('assign_waves', edit);
    const OPEN_PROP = /(if an open-time property exists)([^.]{0,500})(re-check it immediately before opening)([^.]{0,500})(nothing intervening)/i;
    gapCases('characters between "exists" and the re-check', planner, 'prompt-thinning', gapAt(OPEN_PROP, 1, 'x', inWaves), 500, /assign_waves must re-check an open-time property immediately before opening/);
    gapCases('characters between the re-check and "nothing intervening"', planner, 'prompt-thinning', gapAt(OPEN_PROP, 2, 'x', inWaves), 500, /assign_waves must re-check an open-time property immediately before opening/);
    const POST_OPEN = /(post-open CI)([^.]{0,500})(review)([^.]{0,500})(tracking may follow)/i;
    gapCases('characters between "post-open CI" and "review"', planner, 'prompt-thinning', gapAt(POST_OPEN, 1, 'x', inWaves), 500, /assign_waves must allow post-open CI, review and tracking to follow/);
    gapCases('characters between "review" and "tracking may follow"', planner, 'prompt-thinning', gapAt(POST_OPEN, 2, 'x', inWaves), 500, /assign_waves must allow post-open CI, review and tracking to follow/);
    const ANTI = 'gsd-core/references/planner-antipatterns.md';
    gapCases('characters between "Open" and "PR" in the Bad example', ANTI, 'prompt-thinning',
      (text, gap) => text.replace('Wave 1: Open PR; automatic external review starts', `Wave 1: Open${'x'.repeat(gap)}PR; automatic external review starts`), 500, /the example must show Bad: open the PR, then internal review/);
    const RECHECK = /(If applicable)([^\n]{0,500})(re-check)([^\n]{0,500})(then immediately open PR)/i;
    gapCases('characters between "If applicable" and "re-check" in the Good example', ANTI, 'prompt-thinning', gapAt(RECHECK, 1, 'x'), 500, /the example must show Good: internal review, accepted fixes, then the re-check and immediate open/);
    gapCases('characters between "re-check" and "then immediately open PR" in the Good example', ANTI, 'prompt-thinning', gapAt(RECHECK, 2, 'x'), 500, /the example must show Good: internal review, accepted fixes, then the re-check and immediate open/);
    const INTERVENE = /(Nothing may intervene)([^.]{0,500})(re-check)([^.]{0,500})(open)/i;
    gapCases('characters between "Nothing may intervene" and "re-check"', ANTI, 'prompt-thinning', gapAt(INTERVENE, 1, 'x'), 500, /the example must say nothing may intervene between the re-check and the open/);
    gapCases('characters between the example "re-check" and "open"', ANTI, 'prompt-thinning', gapAt(INTERVENE, 2, 'x'), 500, /the example must say nothing may intervene between the re-check and the open/);
    passes('the Bad example opening in lower case with a lower case pr', ANTI, swap('Wave 1: Open PR; automatic external review starts', 'Wave 1: open pr; automatic external review starts'), 'prompt-thinning');

    // do-routing-specificity: a description is read up to 2000 characters of its line.
    gapCases('characters in the execute-phase description', 'commands/gsd/execute-phase.md', 'do-routing-specificity',
      (text, gap) => text.replace(/description:[^\n]*/, `description: wave ${'x'.repeat(gap - 8)}SDD`), 2000, /the execute-phase description must name SDD or spec-driven execution/);
    gapCases('characters in the phase description', 'commands/gsd/phase.md', 'do-routing-specificity',
      (text, gap) => text.replace(/description:[^\n]*/, `description: ${'x'.repeat(gap - 11)}multi-phase`), 2000, /the phase description must name multi-phase management/);
    passes('the wholesale forwarding phrase before the dispatch step is outside the slice', 'gsd-core/workflows/do.md', (text) => `passing $ARGUMENTS as args\n${text}`, 'do-routing-specificity');
    passes('a second spike wrap-up route after the generic spike route', 'gsd-core/workflows/do.md', append('/gsd:spike --wrap-up'), 'do-routing-specificity');

    // context-index-sync: the index is compared with a fresh parse of CONTEXT.md; both are large, so a case copies them with HEAVY.
    const { parsePredicates } = require(path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', 'context-predicates.cjs'));
    const FIRST_PREDICATE = parsePredicates(readRepo3('CONTEXT.md')).predicates[0];
    const jsonEdit = (edit) => (text) => {
      const parsed = JSON.parse(text);
      edit(parsed);
      return `${JSON.stringify(parsed, null, 2)}\n`;
    };
    const heavyCase = (title, rel, edit, check) => test(`context-index-sync: ${title}`, (t) => {
      const root = copyOfRepoFiles(t, HEAVY);
      const abs = path.join(root, ...rel.split('/'));
      const before = fs.readFileSync(abs, 'utf8');
      const after = edit(before);
      assert.notEqual(after, before, 'the edit changed the file');
      fs.writeFileSync(abs, after);
      check(runShipped(root, ['context-index-sync']));
    });
    const someFinding = (expected) => (findings) => assert.ok(findings.some((f) => (typeof expected === 'function' ? expected(f.message) : expected.test(f.message))), `expected ${expected}, got ${JSON.stringify(findings.map((f) => f.message))}`);
    const INDEX_WHY = /docs\/CONTEXT-INDEX\.json must match a fresh parse of CONTEXT\.md, predicate by predicate/;
    heavyCase('a diverged value in the committed index', 'docs/CONTEXT-INDEX.json', jsonEdit((index) => { index.predicates[0].value = `${index.predicates[0].value}!`; }), someFinding(/: value diverged \(committed docs\/CONTEXT-INDEX\.json=/));
    heavyCase('a diverged klass in the committed index', 'docs/CONTEXT-INDEX.json', jsonEdit((index) => { index.predicates[0].klass = 'OTHER'; }), someFinding(/: klass diverged \(committed docs\/CONTEXT-INDEX\.json=/));
    heavyCase('a predicate missing from the committed index', 'docs/CONTEXT-INDEX.json', jsonEdit((index) => { index.predicates.shift(); }), someFinding(/present in fresh CONTEXT\.md parse but absent from committed docs\/CONTEXT-INDEX\.json/));
    heavyCase('a predicate only in the committed index', 'docs/CONTEXT-INDEX.json', jsonEdit((index) => { index.predicates.push({ id: 'ZZZ.extra.id', klass: 'ZZZ', value: 'v' }); }), someFinding(/ZZZ\.extra\.id: present in committed docs\/CONTEXT-INDEX\.json but absent from fresh CONTEXT\.md parse/));
    heavyCase('a predicate count that differs', 'docs/CONTEXT-INDEX.json', jsonEdit((index) => { index.count += 1; }), someFinding(/the predicate count must match between the committed index and the fresh parse/));
    heavyCase('a class count that differs', 'docs/CONTEXT-INDEX.json', jsonEdit((index) => { index.classes[Object.keys(index.classes)[0]] += 1; }), someFinding(/the class-count map must match between the committed index and the fresh parse/));
    heavyCase('a class only in the committed index', 'docs/CONTEXT-INDEX.json', jsonEdit((index) => { index.classes.ZZZ = 1; }), someFinding(/the class-count map must match between the committed index and the fresh parse/));
    heavyCase('a changed value in CONTEXT.md', 'CONTEXT.md', (text) => text.replace(`${FIRST_PREDICATE.id}=`, `${FIRST_PREDICATE.id}=CHANGED `), someFinding((message) => message.includes(`${FIRST_PREDICATE.id}: value diverged`)));
    heavyCase('a predicate removed from CONTEXT.md', 'CONTEXT.md', (text) => text.replace(`${FIRST_PREDICATE.id}=`, 'REMOVED-'), someFinding(/: present in committed docs\/CONTEXT-INDEX\.json but absent from fresh CONTEXT\.md parse/));
    heavyCase('a predicate added to CONTEXT.md', 'CONTEXT.md', (text) => `${text}\n\`SEAM.zzz-new-predicate.owns=a new fact\`\n`, someFinding(/SEAM\.zzz-new-predicate\.owns: present in fresh CONTEXT\.md parse but absent from committed docs\/CONTEXT-INDEX\.json/));
    heavyCase('an index that is not JSON', 'docs/CONTEXT-INDEX.json', () => '{', someFinding((message) => INDEX_WHY.test(message) && message.includes('not valid JSON')));
    for (const [label, body] of [
      ['a list', '[]'],
      ['an object without predicates', '{"count": 1}'],
      ['predicates that are not entries', '{"predicates": [1]}'],
      ['an entry without a string id', '{"predicates": [{"klass": "X"}]}'],
      ['predicates that are not a list', '{"predicates": {}}'],
    ]) {
      heavyCase(`an index that is ${label}`, 'docs/CONTEXT-INDEX.json', () => body, someFinding(/the index has no predicates list of \{id, klass, value\} entries/));
    }
    test('an untouched copy with HEAVY satisfies context-index-sync', (t) => {
      assert.deepEqual(runShipped(copyOfRepoFiles(t, HEAVY), ['context-index-sync']), []);
    });

    passes('a Bad example whose open PR line is followed by internal review of the PR on the same line', 'gsd-core/references/planner-antipatterns.md', swap('Wave 1: Open PR; automatic external review starts', 'Wave 1: Open PR, then internal review of the PR'), 'prompt-thinning');
    passes('the thinning conditional written without a space before the less-than sign', 'gsd-core/workflows/execute-phase.md', swap('CONTEXT_WINDOW < 200000', 'CONTEXT_WINDOW< 200000'), 'prompt-thinning');

    // few-shot-calibration: a value may be followed by up to 20 blanks on its line.
    gapCases('trailing blanks after the component', PLAN_CHECKER, 'few-shot-calibration', (text, gap) => text.replace('component: plan-checker', `component: plan-checker${' '.repeat(gap)}`), 20, /plan-checker.md frontmatter must name its component/);
    gapCases('trailing blanks after the version', PLAN_CHECKER, 'few-shot-calibration', (text, gap) => text.replace(/^version: (\d+)/m, (_, digits) => `version: ${digits}${' '.repeat(gap)}`), 20, /plan-checker.md frontmatter must carry a numeric version/);
    gapCases('trailing blanks after the calibration date', PLAN_CHECKER, 'few-shot-calibration', (text, gap) => text.replace(/^last_calibrated: (\S+)/m, (_, date) => `last_calibrated: ${date}${' '.repeat(gap)}`), 20, /plan-checker.md frontmatter must carry a last_calibrated date/);
    passes('a nine digit version in the plan-checker reference', PLAN_CHECKER, (text) => text.replace(/^version: \d+\n/m, 'version: 123456789\n'), 'few-shot-calibration');
    findsOne('a ten digit version in the plan-checker reference', PLAN_CHECKER, (text) => text.replace(/^version: \d+\n/m, 'version: 1234567890\n'), 'few-shot-calibration', 'plan-checker.md frontmatter must carry a numeric version');

    // resolver-hoist-guard: many list item fences are read in one pass and give the verdict of one.
    const MANY_STEP = 'gsd-core/workflows/code-review/steps/structural-pre-pass.md';
    for (const [label, count] of [['one', 1], ['two', 2], ['200', 200]]) {
      test(`${label} list item fenced blocks holding a resolver call are findings of resolver-hoist-guard`, (t) => {
        const root = copyOfRepoFiles(t);
        const abs = path.join(root, ...MANY_STEP.split('/'));
        const block = '- ```bash\n  gsd-sdk query config-get code_quality.fallow.enabled\n  ```\n';
        fs.writeFileSync(abs, `${fs.readFileSync(abs, 'utf8')}\n${block.repeat(count)}`);
        const findings = runShipped(root, ['resolver-hoist-guard']);
        assert.equal(findings.filter((f) => f.message.includes('must not itself call the resolver for that fact')).length, 1, JSON.stringify(findings));
      });
    }
    test('200 list item fence marker lines without a call leave resolver-hoist-guard satisfied', (t) => {
      const root = copyOfRepoFiles(t);
      const abs = path.join(root, ...MANY_STEP.split('/'));
      fs.writeFileSync(abs, `${fs.readFileSync(abs, 'utf8')}\n${'- ```bash\n  echo ok\n  ```\n'.repeat(200)}`);
      assert.deepEqual(runShipped(root, ['resolver-hoist-guard']), []);
    });
    passes('an opener whose info string holds a backtick is content, so the prose after it is not code', 'gsd-core/workflows/code-review/steps/structural-pre-pass.md', append('```x `y`\nProse that mentions code_quality.fallow.enabled.\n```'), 'resolver-hoist-guard');
  }

  {
    // Group 4: debugger-fix-acceptance, methodology-artifact, progress-mvp-display, verifier-deferred-items,
    // extract-learnings, gsd-researcher-app-aware, new-project-mvp-prompt.
    const REVERT_RE = /revert[\s-]{0,20}and[\s-]{0,20}reconfirm/gi;
    const DEBUGGER_REF = 'gsd-core/references/debugger-fix-acceptance.md';
    const PROGRESS = 'gsd-core/workflows/progress.md';
    const PROGRESS_STEP = 'gsd-core/workflows/progress/steps/mvp-display.md';
    const NEW_PROJECT = 'gsd-core/workflows/new-project.md';
    const NEW_PROJECT_STEP = 'gsd-core/workflows/new-project/steps/auto-mode-config.md';

    // An edit across several files of one contract; a finding matching `expected` (or none, for `ok`) is the verdict.
    const editFiles = (title, edits, contract, expected, extraFiles = []) => test(title, (t) => {
      const root = copyOfRepoFiles(t);
      for (const [rel, edit] of edits) {
        const abs = path.join(root, ...rel.split('/'));
        const before = fs.readFileSync(abs, 'utf8');
        const after = edit(before);
        assert.notEqual(after, before, `the edit changed ${rel}`);
        fs.writeFileSync(abs, after);
      }
      for (const [rel, text] of extraFiles) write(root, rel, text);
      const findings = runShipped(root, [contract]);
      if (expected === null) assert.deepEqual(findings, []);
      else assert.ok(findings.some((f) => expected.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
    });

    // debugger-fix-acceptance: the revert-and-reconfirm gaps are bounded at 20 characters each; the surviving-mutant
    // word run is bounded at 50.
    gapCases('the first revert-and-reconfirm gap', DEBUGGER_REF, 'debugger-fix-acceptance',
      (text, gap) => `${text.replace(REVERT_RE, 'a revert then a reconfirmation')}\n\nrevert${'-'.repeat(gap)}and reconfirm must run before a fix is accepted\n`, 20, /signal 5: revert-and-reconfirm/);
    gapCases('the second revert-and-reconfirm gap', DEBUGGER_REF, 'debugger-fix-acceptance',
      (text, gap) => `${text.replace(REVERT_RE, 'a revert then a reconfirmation')}\n\nrevert and${'-'.repeat(gap)}reconfirm must run before a fix is accepted\n`, 20, /signal 5: revert-and-reconfirm/);
    gapCases('the word run after "surviv"', DEBUGGER_REF, 'debugger-fix-acceptance',
      (text, gap) => `${text.replace(/surviv/gi, 'living')}\nsurviv${'a'.repeat(gap)} mutant\n`, 50, /a surviving mutant rejects the fix/);
    passes('a mutant line before a surviv line still states the surviving-mutant rule', DEBUGGER_REF,
      (text) => `${text.replace(/surviv/gi, 'living')}\nthe mutant is surviving here\n`, 'debugger-fix-acceptance');
    passes('a deletion rule worded as justified by the RCA satisfies debugger-fix-acceptance', DEBUGGER_REF,
      (text) => `${text.replace(/delet/gi, 'remov')}\n\nno-op: A deletion is justified.\n`, 'debugger-fix-acceptance');
    passes('accept after the revert word satisfies the revert-before-accept order', DEBUGGER_REF,
      (text) => `${text.replace(/accept/gi, 'take').replace(/before/gi, 'ahead of')}\n\nrevert-and-reconfirm: accept the fix after the revert\n`, 'debugger-fix-acceptance');
    passes('a prior to accept wording satisfies the revert-before-accept order', DEBUGGER_REF,
      (text) => `${text.replace(/accept/gi, 'take').replace(/before/gi, 'ahead of')}\n\nrevert-and-reconfirm: run it prior to accept.\n`, 'debugger-fix-acceptance');
    passes('a surviving-mutant word run of one character satisfies debugger-fix-acceptance', DEBUGGER_REF,
      (text) => `${text.replace(/surviv/gi, 'living')}\nsurvivA mutant\n`, 'debugger-fix-acceptance');
    findsOne('a surviving-mutant word run of zero characters is not the surviving-mutant rule', DEBUGGER_REF,
      (text) => `${text.replace(/surviv/gi, 'living')}\nsurviv mutant\n`, 'debugger-fix-acceptance', /a surviving mutant rejects the fix/);
    for (const [pair, line] of [['skipped then log', 'skipped then log'], ['log then skip', 'log then skip'], ['recorded then skip', 'recorded then skip'], ['skip then record', 'skip then record']]) {
      passes(`the pair ${pair} on one line logs the skip`, DEBUGGER_REF,
        (text) => `${text.replace(/skip/gi, 'drop').replace(/log/gi, 'lg').replace(/record/gi, 'rcd')}\n${line}\n`, 'debugger-fix-acceptance');
    }
    for (const word of ['reject', 'justif', 'rca', 'root cause']) {
      passes(`${word} after the first delet satisfies the deletion rule`, DEBUGGER_REF,
        (text) => `${text.replace(/delet/gi, 'remov').replace(/reject|justif|rca|root cause/gi, 'x')}\n\nno-op: delet then ${word}\n`, 'debugger-fix-acceptance');
    }
    findsOne('a skipped line with no log or record word is not logged for debugger-fix-acceptance', DEBUGGER_REF,
      (text) => text.replace(/skip/gi, 'drop').replace(/log/gi, 'lg').replace(/record/gi, 'rcd'), 'debugger-fix-acceptance', /skipped signals must be logged or recorded/);

    // progress-mvp-display: the host and the step files read as one; the contract needs each phrase in at least one.
    editFiles('MVP_MODE gone from the host and the mvp-display step fails progress-mvp-display',
      [[PROGRESS, erase(/mvp_mode/gi)], [PROGRESS_STEP, erase(/mvp_mode/gi)]], 'progress-mvp-display', /the progress workflow must declare MVP_MODE/);
    passes('MVP_MODE only in the host (gone from the step) satisfies progress-mvp-display', PROGRESS_STEP,
      erase(/mvp_mode/gi), 'progress-mvp-display');
    editFiles('the phase.mvp-mode verb moved from the step to the host still satisfies progress-mvp-display',
      [[PROGRESS_STEP, erase(/phase\.mvp-mode/gi)], [PROGRESS, append('phase.mvp-mode')]], 'progress-mvp-display', null);
    editFiles('the phase.mvp-mode verb gone from the mvp-display step fails progress-mvp-display',
      [[PROGRESS_STEP, erase(/phase\.mvp-mode/gi)]], 'progress-mvp-display', /resolve MVP mode via the centralized phase\.mvp-mode verb/);
    editFiles('user-flow framing gone from the mvp-display step fails progress-mvp-display',
      [[PROGRESS_STEP, erase(/user-flow|user-visible/gi)]], 'progress-mvp-display', /MVP display must use user-flow framing/);
    editFiles('PLAN.md gone from the mvp-display step fails progress-mvp-display',
      [[PROGRESS_STEP, erase(/plan\.md/gi)]], 'progress-mvp-display', /MVP display must source user-flow status from PLAN\.md tasks/);
    editFiles('a PLAN.md line and a task line apart do not source the status from PLAN.md tasks',
      [[PROGRESS_STEP, (text) => text.split('\n').map((line) => (/plan\.md/i.test(line) ? line.replace(/task/gi, 'item') : line)).join('\n')]],
      'progress-mvp-display', /MVP display must source user-flow status from PLAN\.md tasks/);
    editFiles('a nested step directory file does not stand in for the mvp-display step',
      [[PROGRESS_STEP, erase(/phase\.mvp-mode/gi)]], 'progress-mvp-display', /resolve MVP mode via the centralized phase\.mvp-mode verb/,
      [['gsd-core/workflows/progress/steps/nested/other.md', 'phase.mvp-mode\n']]);
    editFiles('a README-like file in the steps directory holding the verb stands in for the mvp-display step',
      [[PROGRESS_STEP, erase(/phase\.mvp-mode/gi)]], 'progress-mvp-display', null,
      [['gsd-core/workflows/progress/steps/extra.md', 'phase.mvp-mode\n']]);
    editFiles('the process block ending before --auto leaves --auto outside the commands/gsd/progress.md process block',
      [['commands/gsd/progress.md', (text) => {
        const at = text.indexOf('<process>');
        const end = text.indexOf('</process>', at);
        return text.slice(0, at) + text.slice(at, end).split('--auto').join('') + text.slice(end);
      }]], 'progress-mvp-display', /<process> block must explicitly mention --auto/);

    // new-project-mvp-prompt
    for (const [label, expected] of [['Quality', /not selectable: quality/], ['Balanced', /not selectable: balanced/], ['Budget', /not selectable: budget/]]) {
      editFiles(`the ${label} label gone from both model prompts leaves the profile unselectable`,
        [[NEW_PROJECT, swap(`label: "${label}"`, 'label: "Other"')], [NEW_PROJECT_STEP, swap(`label: "${label}"`, 'label: "Other"')]],
        'new-project-mvp-prompt', expected);
    }
    editFiles('the Inherit label gone from both AI Models prompts leaves inherit unselectable',
      [[NEW_PROJECT, swap('label: "Inherit"', 'label: "Other"')], [NEW_PROJECT_STEP, swap('label: "Inherit"', 'label: "Other"')]],
      'new-project-mvp-prompt', /not selectable: inherit/);
    passes('the Inherit label gone from the host only stays selectable through the step AI Models prompt', NEW_PROJECT,
      swap('label: "Inherit"', 'label: "Other"'), 'new-project-mvp-prompt');
    // The AI Models block ends at the next fence or 4800 characters after its header, whichever comes first.
    for (const gap of [4799, 4800, 4801]) {
      editFiles(`the Budget label ending ${gap} characters after the AI Models header ${gap <= 4800 ? 'is read' : 'is past the window'}`,
        [[NEW_PROJECT, swap('label: "Budget"', 'label: "Other"')], [NEW_PROJECT_STEP, (text) => {
          const at = text.indexOf('header: "AI Models"');
          const labelEnd = text.indexOf('label: "Budget"', at) + 'label: "Budget"'.length - at;
          const insert = at + 'header: "AI Models"'.length;
          return text.slice(0, insert) + ' '.repeat(gap - labelEnd) + text.slice(insert);
        }]], 'new-project-mvp-prompt', gap <= 4800 ? null : /not selectable: budget/);
    }
    const options = (count, key = 'options') => `${key}: [${Array.from({ length: count }, (_, i) => `{ label: "opt${i}" }`).join(', ')}]`;
    passes('an options array of exactly four labels satisfies new-project-mvp-prompt', NEW_PROJECT, append(options(4)), 'new-project-mvp-prompt');
    findsOne('an options array of five labels exceeds the AskUserQuestion cap', NEW_PROJECT, append(options(5)), 'new-project-mvp-prompt', /has 5 options/);
    passes('a suboptions array of five labels is not an options array', NEW_PROJECT, append(options(5, 'suboptions')), 'new-project-mvp-prompt');
    findsOne('an options array with a space before the colon and five labels exceeds the cap', NEW_PROJECT, append(options(5, 'options ')), 'new-project-mvp-prompt', /has 5 options/);
    findsOne('an options array with a newline before the bracket and five labels exceeds the cap', NEW_PROJECT,
      append(options(5).split('[').join('\n[')), 'new-project-mvp-prompt', /has 5 options/);
    editFiles('a five-label options array in a nested steps file is not read',
      [[NEW_PROJECT_STEP, append('{ label: "nested" }')]], 'new-project-mvp-prompt', null,
      [['gsd-core/workflows/new-project/steps/nested/big.md', `${options(5)}\n`]]);
    editFiles('a five-label options array in a step file directly under steps is read',
      [[NEW_PROJECT_STEP, append('{ label: "again" }')]], 'new-project-mvp-prompt', /has 5 options/,
      [['gsd-core/workflows/new-project/steps/big.md', `${options(5)}\n`]]);
    // gsd-researcher-app-aware: the Step 1.5 section is pure reasoning.
    for (const pattern of ['```bash', 'node "$HOME', 'gsd-tools.cjs', 'WebSearch', 'Context7', 'mcp__']) {
      findsOne(`${pattern} inside the Architectural Responsibility Mapping step is a tool call`, 'agents/gsd-phase-researcher.md',
        swap('## Step 2:', `${pattern}\n\n## Step 2:`), 'gsd-researcher-app-aware', `found ${pattern}`);
    }
    passes('one tier gone from the map step leaves three standard tiers', 'agents/gsd-phase-researcher.md',
      within('Architectural Responsibility Map', '## Step 2:', (section) => section.replace(/browser/gi, 'x')), 'gsd-researcher-app-aware');
    passes('a lowercase tier name counts as a standard tier', 'agents/gsd-phase-researcher.md',
      within('Architectural Responsibility Map', '## Step 2:', (section) => section.replace(/Frontend/g, 'frontend').replace(/Browser/g, 'browser')), 'gsd-researcher-app-aware');

    // Both steps directories are listed through ctx.list: an empty or missing directory is a finding.
    for (const [dir, contract, why] of [
      ['gsd-core/workflows/progress/steps', 'progress-mvp-display', /cannot read the directory/],
      ['gsd-core/workflows/new-project/steps', 'new-project-mvp-prompt', /cannot read the directory/],
    ]) {
      test(`${dir} removed from the tree is a finding for ${contract}`, (t) => {
        const root = copyOfRepoFiles(t);
        cleanup(path.join(root, ...dir.split('/')));
        const findings = runShipped(root, [contract]);
        assert.ok(findings.some((f) => why.test(f.message)), JSON.stringify(findings.map((f) => f.message)));
      });
    }

    // The research template: the map section runs to the next line starting with "## " or, with none, 500 characters.
    const TEMPLATE = 'gsd-core/templates/research.md';
    const mapHeading = 'Architectural Responsibility Map';
    gapCases('the Tier table end after the map heading', TEMPLATE, 'gsd-researcher-app-aware', (text, gap) => {
      const at = text.indexOf(mapHeading);
      const tail = ' Tier |';
      return text.slice(0, at) + mapHeading + ' '.repeat(gap - mapHeading.length - tail.length) + tail;
    }, 500, /table format with a Tier column/);
    passes('a table under a ### subheading inside the map section satisfies gsd-researcher-app-aware', TEMPLATE,
      (text) => `${text.slice(0, text.indexOf(mapHeading))}${mapHeading}\n\n### Detail\n\n| Tier | Owner |\n\n## Next\n`, 'gsd-researcher-app-aware');
    findsOne('a table after the next ## heading is outside the map section', TEMPLATE,
      (text) => `${text.slice(0, text.indexOf(mapHeading))}${mapHeading}\n\n## Next\n\n| Tier | Owner |\n`, 'gsd-researcher-app-aware', /table format with a Tier column/);

    // An empty steps directory (it exists, with no .md file) is a finding as well.
    for (const [dir, contract] of [
      ['gsd-core/workflows/progress/steps', 'progress-mvp-display'],
      ['gsd-core/workflows/new-project/steps', 'new-project-mvp-prompt'],
    ]) {
      test(`${dir} holding no .md file is a finding for ${contract}`, (t) => {
        const root = copyOfRepoFiles(t);
        const abs = path.join(root, ...dir.split('/'));
        for (const name of fs.readdirSync(abs)) fs.unlinkSync(path.join(abs, name));
        fs.writeFileSync(path.join(abs, 'notes.txt'), 'no step here\n');
        const findings = runShipped(root, [contract]);
        assert.ok(findings.some((f) => f.file === dir && f.message.includes('no .md file under')), JSON.stringify(findings.map((f) => [f.file, f.message])));
      });
    }

    // progress-mvp-display: the standard-display fallback wording (any line naming the mode with null, absent or not mvp, or
    // naming standard and display) is read across the host and the steps.
    const fallbackLine = (line) => { const l = line.toLowerCase(); return (l.includes('mode') && (l.includes('null') || l.includes('absent') || l.includes('not mvp'))) || (l.includes('standard') && l.includes('display')); };
    const dropFallback = (text) => text.split('\n').map((line) => (fallbackLine(line) ? 'x' : line)).join('\n');
    editFiles('the fallback wording gone from the host and every step fails progress-mvp-display',
      [[PROGRESS, dropFallback], ['gsd-core/workflows/progress/steps/forensic-audit.md', dropFallback]], 'progress-mvp-display', /standard-display fallback/);
    editFiles('the fallback wording only in a step satisfies progress-mvp-display',
      [[PROGRESS, dropFallback]], 'progress-mvp-display', null);

    // extract-learnings: allowed-tools items may be quoted and the list may hold blank and comment lines.
    passes('a single-quoted allowed-tools item still counts', 'commands/gsd/extract-learnings.md', swap('  - Read\n', "  - 'Read'\n"), 'extract-learnings');
    passes('a double-quoted allowed-tools item still counts', 'commands/gsd/extract-learnings.md', swap('  - Write\n', '  - "Write"\n'), 'extract-learnings');
    passes('a blank line inside the allowed-tools list does not end it', 'commands/gsd/extract-learnings.md', swap('  - Read\n', '  - Read\n\n'), 'extract-learnings');
    passes('a comment line inside the allowed-tools list does not end it', 'commands/gsd/extract-learnings.md', swap('  - Read\n', '  - Read\n  # kept\n'), 'extract-learnings');
    passes('a flow-style allowed-tools list with quoted items counts', 'commands/gsd/extract-learnings.md',
      (text) => text.replace(/allowed-tools:\n(?: {2}- [A-Za-z]{1,10}\n){1,6}/, 'allowed-tools: ["Read", Write, Bash, Grep, Glob, Agent]\n'), 'extract-learnings');

    // gsd-researcher-app-aware: an earlier Step 1.5 heading that does not name the map is skipped (the loop's next heading).
    passes('a Step 1.5 heading that does not name the map before the real one is skipped', 'agents/gsd-phase-researcher.md',
      swap('## Step 1.3:', '## Step 1.5: Something else\n\nnothing\n\n## Step 1.3:'), 'gsd-researcher-app-aware');
    passes('a mid-line mention of Step 1.5 and the map in earlier prose does not start the section', 'agents/gsd-phase-researcher.md',
      swap('## Step 1: ', 'see ## Step 1.5 Architectural Responsibility Map\n\n## Step 1: '), 'gsd-researcher-app-aware');

    // new-project-mvp-prompt: an unclosed options array is a finding and does not hide a later one.
    findsOne('an unclosed options array alone is a finding', NEW_PROJECT, append('options: [ { label: "a" }'), 'new-project-mvp-prompt', /is never closed/);
    findsOne('an unclosed options array followed by a five-label array still flags the five labels', NEW_PROJECT,
      append(`options: [ { label: "a" }\n${options(5)}`), 'new-project-mvp-prompt', /has 5 options/);
    findsOne('a mid-line Step 2 mention inside the map step does not end it before a later tool call', 'agents/gsd-phase-researcher.md',
      swap('\n## Step 2:', '\nsee ## Step 2: in prose, then WebSearch\n\n## Step 2:'), 'gsd-researcher-app-aware', 'found WebSearch');
    passes('a trailing comment after an allowed-tools item still counts', 'commands/gsd/extract-learnings.md', swap('  - Read\n', '  - Read # needed\n'), 'extract-learnings');
    passes('a flow-style allowed-tools list split over lines counts', 'commands/gsd/extract-learnings.md',
      (text) => text.replace(/allowed-tools:\n(?: {2}- [A-Za-z]{1,10}\n){1,6}/, 'allowed-tools: [Read,\n  "Write", Bash, # shell\n  Grep, Glob,\n  Agent]\n'), 'extract-learnings');
    passes('a [ and a ] inside quoted labels leave a four-label options array closed', NEW_PROJECT,
      append('options: [ {label:"a["},{label:"b]"},{label:"c"},{label:"d"} ]'), 'new-project-mvp-prompt');
    passes('an unterminated quote in prose does not hide the brackets of the next line', NEW_PROJECT,
      append('a stray " quote here\n' + options(4)), 'new-project-mvp-prompt');
    const FIVE = '{label:"a"},{label:"b"},{label:"c"},{label:"d"},{label:"e"}';
    findsOne('an odd quote earlier on the line does not hide a five-label options array', NEW_PROJECT,
      append(`say "hi options: [ ${FIVE} ]`), 'new-project-mvp-prompt', /has 5 options/);
    findsOne('a single-quoted label holding ] does not close a five-label array early', NEW_PROJECT,
      append('options: [ {label:"a"},{label:\'b]\'},{label:"c"},{label:"d"},{label:"e"},{label:"f"} ]'), 'new-project-mvp-prompt', /has 5 options/);
    findsOne('a backtick label holding ] does not close a five-label array early', NEW_PROJECT,
      append('options: [ {label:"a"},{label:`b]`},{label:"c"},{label:"d"},{label:"e"},{label:"f"} ]'), 'new-project-mvp-prompt', /has 5 options/);
    findsOne('a string ends at the line end even after a trailing backslash', NEW_PROJECT,
      append('options: [ {label:"a\\' + '\nx}, {label:"b]"}, {label:"c"}, {label:"d"}, {label:"e"}, {label:"f"} ]'), 'new-project-mvp-prompt', /has 5 options/);
    passes('a quote in prose outside any options array is not skipped', NEW_PROJECT,
      append(`it's a "quote\n${options(4)}`), 'new-project-mvp-prompt');

    // extract-learnings: an unclosed flow list ends at the frontmatter fence and has no items.
    const unclosedFlow = (text) => text.replace(/allowed-tools:\n(?: {2}- [A-Za-z]{1,10}\n){1,6}/, 'allowed-tools: [Read, Write, Bash, Grep, Glob, Agent\n');
    editFiles('an unclosed allowed-tools flow list reads no items', [['commands/gsd/extract-learnings.md', unclosedFlow]], 'extract-learnings', /allowed-tools must include Read \(the allowed-tools list is \[\]\)/);
    editFiles('a ] in the prose after the frontmatter does not close an unclosed allowed-tools flow list', [['commands/gsd/extract-learnings.md', (text) => `${unclosedFlow(text)}\nsee [the docs] for more\n`]], 'extract-learnings', /allowed-tools must include Read \(the allowed-tools list is \[\]\)/);

    // debugger-fix-acceptance: an underscore does not join a word to its neighbours (timeout_ms, GSD_TIMEOUT, git_dir, 60s_).
    passes('timeout_ms stands alone as a timeout mention', DEBUGGER_REF,
      (text) => text.replace(/timeout/gi, 'timeout_ms'), 'debugger-fix-acceptance');
    passes('git_dir stands alone as a git mention', DEBUGGER_REF,
      (text) => text.replace(/\bgit\b/gi, 'git_dir'), 'debugger-fix-acceptance');
    passes('60s_ stands alone as the 60s bound', DEBUGGER_REF, swap('60s', '60s_'), 'debugger-fix-acceptance');
    passes('60 seconds stands alone as the bound', DEBUGGER_REF, swap('60s', '60 seconds'), 'debugger-fix-acceptance');
    passes('a column-0 comment line inside a multi-line allowed-tools flow list does not end it', 'commands/gsd/extract-learnings.md',
      (text) => text.replace(/allowed-tools:\n(?: {2}- [A-Za-z]{1,10}\n){1,6}/, 'allowed-tools: [Read,\n# a comment at column 0\n  Write, Bash, Grep, Glob, Agent]\n'), 'extract-learnings');
  }

  // A file a batch 9 contract reads that is gone from the tree is one finding for that file.
  for (const [rel, contract] of [
    ['docs/reference/state-md.md', 'docs-state-md-locale-parity'],
    ['docs/ja-JP/reference/state-md.md', 'docs-state-md-locale-parity'],
    ['docs/zh-CN/reference/state-md.md', 'docs-state-md-locale-parity'],
    ['docs/ko-KR/reference/state-md.md', 'docs-state-md-locale-parity'],
    ['docs/pt-BR/reference/state-md.md', 'docs-state-md-locale-parity'],
    ['.github/workflows/release.yml', 'release-shard-lane-sharding'],
    ['.github/workflows/install-smoke.yml', 'release-tarball-smoke-workflow'],
    ['gsd-core/workflows/discuss-phase-assumptions.md', 'model-routing-spawn-threading'],
    ['gsd-core/workflows/code-review.md', 'model-routing-spawn-threading'],
    ['gsd-core/workflows/code-review-fix.md', 'model-routing-spawn-threading'],
    ['gsd-core/workflows/quick.md', 'model-routing-spawn-threading'],
    ['gsd-core/workflows/execute-phase.md', 'context-enrichment'],
    ['gsd-core/workflows/execute-phase/steps/verify-phase-goal.md', 'context-enrichment'],
    ['gsd-core/workflows/plan-phase.md', 'context-enrichment'],
    ['hooks/gsd-prompt-guard.js', 'kimi-guard-typed-payload-reads'],
    ['hooks/gsd-read-guard.js', 'kimi-guard-typed-payload-reads'],
    ['hooks/gsd-read-injection-scanner.js', 'kimi-guard-typed-payload-reads'],
    ['hooks/gsd-secret-read-guard.js', 'kimi-guard-typed-payload-reads'],
    ['hooks/gsd-windsurf-pre-write.js', 'kimi-guard-typed-payload-reads'],
    ['hooks/gsd-workflow-guard.js', 'kimi-guard-typed-payload-reads'],
    ['hooks/gsd-worktree-path-guard.js', 'kimi-guard-typed-payload-reads'],
    ['agents/gsd-debug-session-manager.md', 'debug-manager-blocking-spawn'],
    ['agents/gsd-debug-session-manager.compact.md', 'debug-manager-blocking-spawn'],
    ['gsd-core/workflows/debug.md', 'debug-manager-blocking-spawn'],
    ['gsd-core/references/debugger-bug-taxonomy.md', 'debugger-bug-taxonomy'],
    ['agents/gsd-debugger.md', 'debugger-bug-taxonomy'],
    ['gsd-core/templates/DEBUG.md', 'debugger-bug-taxonomy'],
    ['gsd-core/references/debugger-sbfl.md', 'debugger-sbfl'],
    ['agents/gsd-debugger.md', 'debugger-sbfl'],
    ['agents/gsd-executor.md', 'tdd-reference-correctness'],
    ['gsd-core/references/tdd.md', 'tdd-reference-correctness'],
    ['gsd-core/workflows/execute-plan.md', 'tdd-reference-correctness'],
    ['agents/gsd-executor.md', 'summary-commit-verification'],
    ['gsd-core/workflows/pause-work.md', 'summary-commit-verification'],
    ['gsd-core/workflows/verify-work.md', 'summary-commit-verification'],
    ['gsd-core/workflows/spec-phase.md', 'prohibition-probe.spec-phase-contract'],
    ['gsd-core/workflows/discuss-phase-assumptions.md', 'section-marker-inversion-guard'],
    ['gsd-core/workflows/verify-work.md', 'section-marker-inversion-guard'],
    ['agents/gsd-plan-checker.md', 'planner-estimate-emission'],
    ['agents/gsd-planner.md', 'planner-estimate-emission'],
    ['docs/CONFIGURATION.md', 'planner-estimate-emission'],
    ['docs/reference/plan-md.md', 'planner-estimate-emission'],
    ['gsd-core/bin/shared/config-defaults.manifest.json', 'planner-estimate-emission'],
    ['gsd-core/templates/planner-subagent-prompt.md', 'edge-probe-planner-contract'],
    ['gsd-core/workflows/plan-phase.md', 'edge-probe-planner-contract'],
    ['gsd-core/workflows/discuss-phase.md', 'anti-pattern-enforcement'],
    ['gsd-core/workflows/execute-phase.md', 'anti-pattern-enforcement'],
    ['gsd-core/workflows/pause-work.md', 'anti-pattern-enforcement'],
    ['gsd-core/workflows/execute-phase.md', 'executor-isolation-prompt-contract'],
    ['gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', 'executor-isolation-prompt-contract'],
    ['gsd-core/workflows/quick-batch/steps/worktree-dispatch.md', 'executor-isolation-prompt-contract'],
    ['gsd-core/references/debugger-rca-branching.md', 'debugger-rca-branching'],
    ['agents/gsd-debugger.md', 'debugger-rca-branching'],
    ['gsd-core/templates/DEBUG.md', 'debugger-rca-branching'],
    ['gsd-core/references/debugger-philosophy.md', 'debugger-rca-branching'],
    ['gsd-core/references/few-shot-examples/plan-checker.md', 'few-shot-calibration'],
    ['gsd-core/references/few-shot-examples/verifier.md', 'few-shot-calibration'],
    ['agents/gsd-plan-checker.md', 'few-shot-calibration'],
    ['agents/gsd-verifier.md', 'few-shot-calibration'],
    ['gsd-core/references/edge-probe.md', 'edge-probe-docs-fixtures'],
    ['gsd-core/references/edge-probe-fixtures/01-round-half-even/expected-coverage.json', 'edge-probe-docs-fixtures'],
    ['docs/adr/550-spec-phase-probe-contract.md', 'edge-probe-docs-fixtures'],
    ['gsd-core/templates/spec.md', 'edge-probe-docs-fixtures'],
    ['.github/rulesets/main-protection.json', 'ci-merge-group-wiring'],
    ['.github/workflows/branch-naming.yml', 'ci-merge-group-wiring'],
    ['.github/workflows/pr-target-validator.yml', 'ci-merge-group-wiring'],
    ['.github/workflows/require-issue-link.yml', 'ci-merge-group-wiring'],
    ['gsd-core/workflows/section-manifest.json', 'resolver-hoist-guard'],
    ['gsd-core/workflows/autonomous.md', 'resolver-hoist-guard'],
    ['gsd-core/workflows/code-review/steps/structural-pre-pass.md', 'resolver-hoist-guard'],
    ['gsd-core/workflows/execute-phase.md', 'prompt-thinning'],
    ['agents/gsd-executor.md', 'prompt-thinning'],
    ['agents/gsd-planner.md', 'prompt-thinning'],
    ['gsd-core/references/executor-examples.md', 'prompt-thinning'],
    ['gsd-core/references/planner-antipatterns.md', 'prompt-thinning'],
    ['gsd-core/workflows/do.md', 'do-routing-specificity'],
    ['commands/gsd/execute-phase.md', 'do-routing-specificity'],
    ['commands/gsd/phase.md', 'do-routing-specificity'],
    ['CONTEXT.md', 'context-index-sync'],
    ['docs/CONTEXT-INDEX.json', 'context-index-sync'],
    ['agents/gsd-debugger.md', 'debugger-fix-acceptance'],
    ['agents/gsd-debug-session-manager.md', 'debugger-fix-acceptance'],
    ['gsd-core/references/debugger-fix-acceptance.md', 'debugger-fix-acceptance'],
    ['gsd-core/templates/DEBUG.md', 'debugger-fix-acceptance'],
    ['gsd-core/references/artifact-types.md', 'methodology-artifact'],
    ['gsd-core/workflows/discuss-phase-assumptions.md', 'methodology-artifact'],
    ['gsd-core/workflows/pause-work.md', 'methodology-artifact'],
    ['gsd-core/workflows/progress.md', 'progress-mvp-display'],
    ['commands/gsd/progress.md', 'progress-mvp-display'],
    ['gsd-core/workflows/next.md', 'progress-mvp-display'],
    ['agents/gsd-verifier.md', 'verifier-deferred-items'],
    ['gsd-core/references/planner-gap-closure.md', 'verifier-deferred-items'],
    ['commands/gsd/extract-learnings.md', 'extract-learnings'],
    ['gsd-core/workflows/extract-learnings.md', 'extract-learnings'],
    ['agents/gsd-phase-researcher.md', 'gsd-researcher-app-aware'],
    ['agents/gsd-planner.md', 'gsd-researcher-app-aware'],
    ['agents/gsd-plan-checker.md', 'gsd-researcher-app-aware'],
    ['gsd-core/templates/research.md', 'gsd-researcher-app-aware'],
    ['gsd-core/workflows/new-project.md', 'new-project-mvp-prompt'],
  ]) {
    test(`${rel} removed from the tree is a finding for ${contract}`, (t) => {
      const root = copyOfRepoFiles(t, HEAVY.includes(rel) ? HEAVY : []);
      fs.unlinkSync(path.join(root, ...rel.split('/')));
      const findings = runShipped(root, [contract]);
      assert.ok(findings.some((f) => f.file === rel && /cannot read the file/.test(f.message)), JSON.stringify(findings));
    });
  }
});
