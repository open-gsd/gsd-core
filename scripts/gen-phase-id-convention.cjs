#!/usr/bin/env node
'use strict';

// ADR-612 PR-6 / #5027: reviewed literal selection; never shrink from live prose.
const fs = require('node:fs');
const path = require('node:path');
const { locateFrontmatterFence } = require('../gsd-core/bin/lib/frontmatter-fence.cjs');
const { scanFencedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');
const START = '<!-- PHASE-ID-CONVENTION:START -->';
const END = '<!-- PHASE-ID-CONVENTION:END -->';
// Selection rule: files whose text is user-facing command output are not targets.
// Quick plan-checker-loop and quick-batch worktree-dispatch only forward quick task
// identities; references to phase executor placeholders do not emit phase IDs.
// These reviewed help-mode exclusions are output surfaces, not phase-emitting instructions.
const EXCLUDED_USER_OUTPUT = Object.freeze([
  'gsd-core/workflows/help/modes/brief.md',
  'gsd-core/workflows/help/modes/default.md',
  'gsd-core/workflows/help/modes/full.md',
]);
const EXCLUDED_ARTIFACTS = Object.freeze([
  'gsd-core/workflows/autonomous/templates/minimal-context.md',
  'gsd-core/templates/AI-SPEC.md',
  'gsd-core/templates/DEBUG.md',
  'gsd-core/templates/README.md',
  'gsd-core/templates/SECURITY.md',
  'gsd-core/templates/UAT.md',
  'gsd-core/templates/UI-SPEC.md',
  'gsd-core/templates/VALIDATION.md',
  'gsd-core/templates/codebase/architecture.md',
  'gsd-core/templates/codebase/stack.md',
  'gsd-core/templates/continue-here.md',
  'gsd-core/templates/copilot-instructions.md',
  'gsd-core/templates/dev-preferences.md',
  'gsd-core/templates/discussion-log.md',
  'gsd-core/templates/milestone-archive.md',
  'gsd-core/templates/milestone.md',
  'gsd-core/templates/project.md',
  'gsd-core/templates/requirements.md',
  'gsd-core/templates/research-project/ARCHITECTURE.md',
  'gsd-core/templates/research-project/FEATURES.md',
  'gsd-core/templates/research-project/PITFALLS.md',
  'gsd-core/templates/research-project/STACK.md',
  'gsd-core/templates/research-project/SUMMARY.md',
  'gsd-core/templates/retrospective.md',
  'gsd-core/templates/spec.md',
  'gsd-core/templates/summary-complex.md',
  'gsd-core/templates/summary-minimal.md',
  'gsd-core/templates/summary-standard.md',
  'gsd-core/templates/user-profile.md',
]);
const TARGETS = Object.freeze([
  Object.freeze({ file: 'agents/gsd-advisor-researcher.md', kind: 'agent' }),
  Object.freeze({ file: 'agents/gsd-ai-researcher.md', kind: 'agent' }),
  Object.freeze({ file: 'agents/gsd-assumptions-analyzer.md', kind: 'agent' }),
  Object.freeze({ file: 'agents/gsd-code-fixer.md', kind: 'agent' }),
  Object.freeze({ file: 'agents/gsd-code-reviewer.md', kind: 'agent' }),
  Object.freeze({ file: 'agents/gsd-codebase-mapper.md', kind: 'agent' }),
  Object.freeze({ file: 'agents/gsd-debug-session-manager.md', kind: 'agent' }),
  Object.freeze({ file: 'agents/gsd-debugger.md', kind: 'agent' }),
  Object.freeze({ file: 'agents/gsd-doc-classifier.md', kind: 'agent' }),
  Object.freeze({ file: 'agents/gsd-doc-synthesizer.md', kind: 'agent' }),
  Object.freeze({ file: 'agents/gsd-doc-verifier.md', kind: 'agent' }),
  Object.freeze({ file: 'agents/gsd-doc-writer.md', kind: 'agent' }),
  Object.freeze({ file: 'agents/gsd-dom-verifier.md', kind: 'agent' }),
  Object.freeze({ file: 'agents/gsd-domain-researcher.md', kind: 'agent' }),
  Object.freeze({ file: 'agents/gsd-eval-auditor.md', kind: 'agent' }),
  Object.freeze({ file: 'agents/gsd-eval-planner.md', kind: 'agent' }),
  Object.freeze({ file: 'agents/gsd-executor.md', kind: 'agent' }),
  Object.freeze({ file: 'agents/gsd-framework-selector.md', kind: 'agent' }),
  Object.freeze({ file: 'agents/gsd-integration-checker.md', kind: 'agent' }),
  Object.freeze({ file: 'agents/gsd-intel-updater.md', kind: 'agent' }),
  Object.freeze({ file: 'agents/gsd-mempalace-curator.md', kind: 'agent' }),
  Object.freeze({ file: 'agents/gsd-nyquist-auditor.md', kind: 'agent' }),
  Object.freeze({ file: 'agents/gsd-pattern-mapper.md', kind: 'agent' }),
  Object.freeze({ file: 'agents/gsd-phase-researcher.md', kind: 'agent' }),
  Object.freeze({ file: 'agents/gsd-plan-checker.md', kind: 'agent' }),
  Object.freeze({ file: 'agents/gsd-planner.md', kind: 'agent' }),
  Object.freeze({ file: 'agents/gsd-project-researcher.md', kind: 'agent' }),
  Object.freeze({ file: 'agents/gsd-research-synthesizer.md', kind: 'agent' }),
  Object.freeze({ file: 'agents/gsd-roadmapper.md', kind: 'agent' }),
  Object.freeze({ file: 'agents/gsd-security-auditor.md', kind: 'agent' }),
  Object.freeze({ file: 'agents/gsd-ui-auditor.md', kind: 'agent' }),
  Object.freeze({ file: 'agents/gsd-ui-checker.md', kind: 'agent' }),
  Object.freeze({ file: 'agents/gsd-ui-researcher.md', kind: 'agent' }),
  Object.freeze({ file: 'agents/gsd-user-profiler.md', kind: 'agent' }),
  Object.freeze({ file: 'agents/gsd-verifier.md', kind: 'agent' }),
  Object.freeze({ file: 'gsd-core/templates/context.md', kind: 'template' }),
  Object.freeze({ file: 'gsd-core/templates/phase-prompt.md', kind: 'template' }),
  Object.freeze({ file: 'gsd-core/templates/planner-subagent-prompt.md', kind: 'template' }),
  Object.freeze({ file: 'gsd-core/templates/research.md', kind: 'template' }),
  Object.freeze({ file: 'gsd-core/templates/roadmap.md', kind: 'template' }),
  Object.freeze({ file: 'gsd-core/templates/state.md', kind: 'template' }),
  Object.freeze({ file: 'gsd-core/templates/summary.md', kind: 'template' }),
  Object.freeze({ file: 'gsd-core/templates/user-setup.md', kind: 'template' }),
  Object.freeze({ file: 'gsd-core/templates/verification-report.md', kind: 'template' }),
  Object.freeze({ file: 'gsd-core/workflows/add-backlog.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/add-phase.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/add-tests.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/ai-integration-phase.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/analyze-dependencies.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/audit-fix.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/audit-milestone.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/audit-uat.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/autonomous.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/autonomous/steps/converge-dispatch-bg.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/autonomous/steps/converge-dispatch-inline.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/autonomous/steps/converge-loop.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/check-todos.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/cleanup.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/code-review-fix.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/code-review.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/code-review/steps/dispatch-fix.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/code-review/steps/structural-pre-pass.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/complete-milestone.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/complete-milestone/detail/elaboration.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/complete-milestone/steps/project-md-evolution-review.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/diagnose-issues.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/discuss-phase-assumptions.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/discuss-phase-assumptions/steps/auto-advance-dispatch.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/discuss-phase-power.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/discuss-phase.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/discuss-phase/modes/chain.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/discuss-phase/modes/default.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/discuss-phase/modes/power.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/discuss-phase/templates/context.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/discuss-phase/templates/discussion-log.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/do.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/edit-phase.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/eval-review.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/execute-phase.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/execute-phase/steps/code-review-disposition.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/execute-phase/steps/completion-reconciliation.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/execute-phase/steps/gap-closure-artifacts.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/execute-phase/steps/partial-wave.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/execute-phase/steps/per-plan-worktree-gate.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/execute-phase/steps/regression-gate.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/execute-phase/steps/tdd-applicability-resolution.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/execute-phase/steps/threat-id-gate.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/execute-phase/steps/verify-phase-goal.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/execute-phase/steps/wave-post-gate-hooks.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/execute-plan.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/extract-learnings.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/forensics.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/graduation.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/health.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/import.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/ingest-docs.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/insert-phase.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/list-phase-assumptions.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/manager.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/milestone-summary.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/mvp-phase.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/new-milestone.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/new-milestone/steps/reset-phase-safety.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/new-project.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/new-project/steps/auto-mode-config.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/next.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/pause-work.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/plan-phase.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/plan-phase/detail/elaboration.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/plan-phase/steps/adr-ingest-express-path.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/plan-phase/steps/auto-advance-check.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/plan-phase/steps/chunked-planning-mode.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/plan-phase/steps/closed-phase-gate.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/plan-phase/steps/plan-pre-dispatch.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/plan-phase/steps/prd-express-path.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/plan-phase/steps/research-only-early-exit.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/plan-phase/steps/research-only-modifiers.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/plan-phase/steps/reviews-prerequisite.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/plan-phase/steps/windows-troubleshooting.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/plan-review-convergence.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/plant-seed.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/pr-branch.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/progress.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/progress/steps/forensic-audit.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/progress/steps/mvp-display.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/remove-phase.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/resume-project.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/review.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/secure-phase.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/session-report.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/settings-advanced.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/ship.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/smart-entry.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/spec-phase.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/stats.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/transition.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/ui-phase.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/ui-review.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/ultraplan-phase.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/undo.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/validate-phase.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/verify-work.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/verify-work/detail/elaboration.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/verify-work/steps/automated-ui-verification.md', kind: 'workflow' }),
  Object.freeze({ file: 'gsd-core/workflows/verify-work/steps/mvp-uat-framing.md', kind: 'workflow' }),
]);
const REFERENCE = Object.freeze({
  file: 'gsd-core/references/phase-id-convention.md',
  regions: Object.freeze([
    Object.freeze({ start: '<!-- PHASE-ID-CARD:START -->', end: '<!-- PHASE-ID-CARD:END -->', render: owner => '```text\n' + owner.phaseIdCard() + '\n```' }),
    Object.freeze({ start: START, end: END, render: owner => owner.phaseIdConventionRules() }),
  ]),
});
const CONVENTION = { start: START, end: END, render: owner => owner.phaseIdConventionBlock() };

function violation(file, line, reason, evidence) {
  return { file, line, reason, ...(evidence === undefined ? {} : { evidence }) };
}

function fencedLineIndexes(lines) {
  const indexes = new Set();
  for (const block of scanFencedBlocks(lines)) {
    const end = block.closeLineIdx < 0 ? lines.length - 1 : block.closeLineIdx;
    for (let i = block.openLineIdx; i <= end; i++) indexes.add(i);
  }
  return indexes;
}

// Full-line markers only; do not repair malformed targets during regeneration.
function readRegion(text, descriptor, file) {
  const lines = text.split('\n');
  const starts = [], ends = [];
  lines.forEach((line, i) => {
    if (line === descriptor.start) starts.push(i);
    if (line === descriptor.end) ends.push(i);
  });
  const fail = reason => ({ violation: violation(file, (starts[0] ?? ends[0] ?? 0) + 1, reason) });
  if (starts.length > 1 || ends.length > 1) return fail('duplicate_marker');
  if (starts.length !== 1 || ends.length !== 1) return fail('missing_region');
  const start = starts[0], end = ends[0];
  if (end <= start) return fail('reversed_marker');
  let foreignDepth = 0, xmlDepth = 0, listContinuation = false;
  const fencedLines = fencedLineIndexes(lines);
  const frontmatter = locateFrontmatterFence(text);
  const startOffset = lines.slice(0, start).join('\n').length;
  const yaml = frontmatter && (!frontmatter.closed || startOffset < frontmatter.closingFenceEnd);
  for (let i = 0; i < start; i++) {
    const line = lines[i];
    if (fencedLines.has(i)) continue;
    if (/^\s*(?:[-+*]|\d+[.)])\s/.test(line)) listContinuation = true;
    else if (/^\S/.test(line)) listContinuation = false;
    if (/<!-- .*:START(?::|\s|--)/.test(line)) foreignDepth++;
    if (/<!-- .*:END(?::|\s|--)/.test(line)) foreignDepth--;
    if (/^\s*</.test(line)) {
      for (const tag of line.matchAll(/<(\/?)([a-z][\w-]*)\b[^>]*>/g)) {
        if (!tag[0].endsWith('/>')) xmlDepth += tag[1] ? -1 : 1;
      }
    }
  }
  const before = lines.slice(0, start).join('\n');
  const context = frontmatter?.closed ? before.slice(frontmatter.closingFenceEnd) : before;
  const preceding = context.split('\n').filter(line => line.trim()).at(-1) || '';
  // Placement decision table (also exercised as generated wrapper shapes):
  // Open YAML/fence/XML/foreign region       -> reject, even across blank lines.
  // List + indented continuation            -> reject until a top-level block.
  // Unfinished sentence/inline condition    -> reject, even across blank lines.
  // Closed wrappers/completed paragraph    -> accept at the next block boundary.
  const unfinishedProse = preceding
    && !/^(?:#{1,6} |\s*<|```|~~~)/.test(preceding)
    && !/[.!?][\x27"\x60)*\]]*$/.test(preceding);
  const continuation = listContinuation
    || /^\s*(?:[-+*]|\d+[.)])\s/.test(preceding)
    || unfinishedProse;
  const nestedMarker = lines.slice(start + 1, end)
    .some(line => /<!-- .*:(?:START|END)(?::|\s|--)/.test(line));
  if (continuation || fencedLines.has(start) || foreignDepth > 0 || xmlDepth > 0 || yaml || nestedMarker) {
    return fail('nested_region');
  }
  return { start, end, body: lines.slice(start + 1, end).join('\n') };
}

function prepare(root) {
  const violations = [], pending = [];
  const ownerFile = 'gsd-core/bin/lib/phase-id-card.cjs';
  const ownerPath = path.join(root, ownerFile);
  if (!fs.existsSync(ownerPath)) return { violations: [violation(ownerFile, 1, 'missing_compiled_owner')], pending };
  const owner = require(ownerPath);
  if (typeof owner.phaseIdConventionBlock !== 'function') return { violations: [violation(ownerFile, 1, 'missing_compiled_owner')], pending };
  for (const target of [...TARGETS, REFERENCE]) {
    const absolute = path.join(root, target.file);
    if (!fs.existsSync(absolute)) { violations.push(violation(target.file, 1, 'missing_file')); continue; }
    const original = fs.readFileSync(absolute, 'utf8');
    const normalized = original.replace(/\r\n/g, '\n');
    const replacements = [];
    for (const descriptor of target.regions || [CONVENTION]) {
      const region = readRegion(normalized, descriptor, target.file);
      if (region.violation) { violations.push(region.violation); continue; }
      const expected = descriptor.render(owner);
      if (region.body !== expected) replacements.push({ ...region, expected });
    }
    const physicalLines = original.match(/[^\n]*\n|[^\n]+$/g) || [];
    let output = original;
    for (const region of replacements.sort((a, b) => b.start - a.start)) {
      const eol = physicalLines[region.start].endsWith('\r\n') ? '\r\n' : '\n';
      const bodyStart = physicalLines.slice(0, region.start + 1).join('').length;
      const bodyEnd = physicalLines.slice(0, region.end).join('').length;
      output = output.slice(0, bodyStart) + region.expected.replace(/\n/g, eol) + eol + output.slice(bodyEnd);
    }
    pending.push({ file: target.file, absolute, original, output, replacements });
  }
  return { violations, pending };
}

function report(violations) { return { ok: violations.length === 0, targetCount: TARGETS.length, violations }; }
function check(root) {
  const { violations, pending } = prepare(root);
  for (const item of pending) for (const region of item.replacements) violations.push(violation(item.file, region.start + 1, 'stale_region'));
  return report(violations);
}
function write(root) {
  const { violations, pending } = prepare(root);
  const changedFiles = [];
  if (!violations.length) for (const item of pending) {
    if (item.output === item.original) continue;
    const temp = `${item.absolute}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, item.output, { flag: 'wx', mode: fs.statSync(item.absolute).mode });
      fs.renameSync(temp, item.absolute);
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    changedFiles.push(item.file);
  }
  return { ...report(violations), changedFiles };
}

// Evidence families deliberately identify source context, not the phase grammar.
const EMITTER = new RegExp([
  'phase_id_convention|milestone-prefixed',
  String.raw`\bphase_(?:num(?:ber)?|dir|id)\b`,
  String.raw`\$\{?(?:PHASE(?:_[A-Z_]+)?|phase(?:_[a-z_]+)?|padded_phase)\b`,
  String.raw`\{[A-Za-z_]*(?:phase|PHASE)[A-Za-z_]*\}|\.planning/phases/`,
  String.raw`Phase[ :]+(?:\{[^}\n]+\}|\[[^\]\n]+\]|[XN](?:\b|:))`,
  String.raw`/gsd[: -](?:plan-phase|execute-phase|discuss-phase|verify-work|add-phase|insert-phase|remove-phase|review)\s+(?:\d|[N{])`,
].join('|'));
// Numeric labels require heading/checklist context; ordinary bold procedure
// stages (such as the debugger's "Phase 0") do not emit project identities.
const CONCRETE_OUTPUT = /(?:#{1,6} |- \[[ x]\] \*\*)Phase\s+(?:\d|\[[^\]]+\]|\$?\{[^}]+\}|[NX])/i;
const EXTERNAL = [
  // One project-code family covers identity, directory and label prescriptions.
  /project_code.{0,160}(?:phase|dir|prefix|heading|header|checklist)|(?:phase|dir|prefix|heading|header|checklist).{0,160}project_code/i,
  /\bM-NN\b/,
  /(?:always|must|write|use).*phase.*heading.*sequential|(?:always|must|write|use).*sequential.*phase.*heading/i,
  /\[[A-Z][A-Z0-9_-]*\.\d+\]/i,
  /\bPhase\s+(?:[NX]|\d+)\b.{0,120}(?:number|heading)|(?:number|heading).{0,120}\bPhase\s+(?:[NX]|\d+)\b/i,
  /\.planning\/phases\/(?:\d|XX-name\b|\$?\{padded_phase\})/,
  CONCRETE_OUTPUT,
  /(?:^|\*\*)Phase\s+(?:\$?\{[^}]+\}|\[[A-Z]\])(?:\*\*|:|\s)/i,
  /^\s*- \[[ x]\] \d[\d.]*-\d+: /,
  /\*\*Depends on\*\*:\s*Phase \d/,
  /phase_id_convention|milestone-prefixed/i,
  /^#{1,6}\s+phase[- ](?:id|numbering|number)\b/i,
  /(?:prepend|omit|include|prefix|always|never)\s+(?:the\s+)?(?:literal\s+)?[`\x27\x22]?Phase\b.*(?:heading|header|identit|label)/,
];
const DISPATCH = /phase number or flags|planted_during:.*milestone\/phase/i;
const DISPATCH_COMMAND = /\/gsd[: -](?:discuss-phase|plan-phase|execute-phase|verify-work)\b.*(?:\$ARGUMENTS|argument|seed)|(?:dispatch|delegate|invoke).*phase.*(?:argument|seed)/i;
function markdownFiles(root, directory, recursive = true) {
  const base = path.join(root, directory);
  if (!fs.existsSync(base)) return [];
  const files = [];
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory() && recursive) files.push(...markdownFiles(root, relative));
    else if (entry.isFile() && entry.name.endsWith('.md') && !entry.name.endsWith('.compact.md')) files.push(relative);
  }
  return files.sort();
}
function historical(line) {
  return !/\b(?:always|must|never|ignore|write|use)\b/i.test(line)
    && /^\s*(?:Historical ADR:|Issue #\d+ discussed\b)/i.test(line);
}
function checkEvidence(root) {
  const violations = [];
  const listed = new Set(TARGETS.map(target => target.file));
  // Walk independently: an added workflow/agent must not evade a pinned manifest.
  const candidates = [
    ...markdownFiles(root, 'gsd-core/workflows'),
    ...markdownFiles(root, 'agents', false).filter(file => /\/gsd-/.test(file)),
    ...markdownFiles(root, 'gsd-core/templates'),
  ];
  for (const file of candidates) {
    if (listed.has(file)) continue;
    const lines = fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n').split('\n');
    const marker = lines.findIndex(text => text.includes('PHASE-ID-CONVENTION:'));
    if ((EXCLUDED_USER_OUTPUT.includes(file) || EXCLUDED_ARTIFACTS.includes(file)) && marker < 0) continue;
    const line = marker >= 0 ? marker : lines.findIndex(text => {
      if (historical(text)) return false;
      if (/Quick plans live under.*not|^\s*`\{plan_number\}`\/`\{phase_dir\}`\/`\{plan_file\}` placeholders\./.test(text)) return false;
      return EMITTER.test(text) || DISPATCH.test(text) || DISPATCH_COMMAND.test(text)
        || EXTERNAL.some(pattern => pattern.test(text));
    });
    if (file.startsWith('agents/') || line >= 0 || ['session-report.md', 'stats.md'].some(name => file === `gsd-core/workflows/${name}`)) {
      violations.push(violation(file, Math.max(0, line) + 1, 'unlisted_phase_emitter', lines[Math.max(0, line)] || file));
    }
  }
  for (const { file, kind } of TARGETS) {
    const absolute = path.join(root, file);
    if (!fs.existsSync(absolute)) {
      violations.push(violation(file, 1, 'missing_file'));
      continue;
    }
    const text = fs.readFileSync(absolute, 'utf8').replace(/\r\n/g, '\n');
    const region = readRegion(text, CONVENTION, file);
    if (region.violation) { violations.push(region.violation); continue; }
    // Retain original line offsets. Strip only a validated region, never a greedy span.
    const lines = text.split('\n');
    const artifactLines = kind === 'template' ? fencedLineIndexes(lines) : new Set();
    lines.forEach((line, i) => {
      if (artifactLines.has(i)) return;
      if (i >= region.start && i <= region.end) return;
      if (historical(line)) return;
      const legacyTitleOwner = ['agents/gsd-executor.md', 'gsd-core/workflows/execute-plan.md'].includes(file);
      if (legacyTitleOwner && /^(?:\*\*Title:\*\*|Title:) `# Phase \[X\] Plan \[Y\]: \[Name\] Summary`$/.test(line)
          && lines[i - 1] === 'Sequential-only legacy rendering (other conventions use the writer-returned plan identity):') return;
      // This section names phase ordering (integers versus inserted decimals),
      // not rendered identity syntax. Keep the original heading and scan its body.
      if (file === 'agents/gsd-roadmapper.md' && /^## Phase Numbering$/i.test(line)) return;
      // Wing selection is metadata, not a prescription for phase directories.
      if (file === 'agents/gsd-mempalace-curator.md'
          && line === '- **Wing:** `mempalace.wing` if non-empty, else `project_code`, else the repo directory name. Every call you make is scoped to this one wing.') return;
      const prescriptive = /\b(?:always|must|never|ignore)\b/i.test(line);
      // Config/CLI reads and JSON keys are operational inputs, not prose prescriptions.
      if (!prescriptive && /^\s*(?:Run )?(?:gsd-tools(?:\.cjs)?|gsd_run)\s+(?:query|mutate|phase|roadmap|init|config-get|config-set)\b/.test(line)) return;
      if (!prescriptive && /^\s*(?:cat|ls)\s+\.planning\/phases\/\d/.test(line)) return;
      if (!prescriptive && /^\s*PROJECT_CODE=\$\(gsd_run query config-get project_code\b/.test(line)) return;
      if (!prescriptive && /^\s*(?:[A-Z_]+=.*|"phase_id_convention"\s*:.*)$/.test(line)) return;
      if (!/(?:always|never|ignore|must|heading|numbering)/i.test(line) && /(?:gsd_run|gsd-tools|config-get|config-set|jq\s).*phase_id_convention/.test(line)) return;
      if (/^\| W\d+ \|/.test(line)) return; // Diagnostic descriptions document existing query output.
      if (EXTERNAL.some(pattern => pattern.test(line))) violations.push(violation(file, i + 1, 'external_convention_prose', line));
    });
  }
  return { ok: violations.length === 0, violations };
}
function main() {
  const args = process.argv.slice(2);
  if (args.includes('--write') === args.includes('--check')) throw new ExitError(1, 'Specify --write or --check');
  const rootAt = args.indexOf('--root');
  const root = path.resolve(rootAt < 0 ? path.join(__dirname, '..') : args[rootAt + 1]);
  const result = args.includes('--write') ? write(root) : check(root);
  if (args.includes('--check')) {
    result.violations.push(...checkEvidence(root).violations);
    result.ok = result.violations.length === 0;
  }
  console.log(args.includes('--json') ? JSON.stringify(result) : JSON.stringify(result, null, 2));
  if (!result.ok) throw new ExitError(1, 'Phase convention check failed');
}
module.exports = { TARGETS, EXCLUDED_USER_OUTPUT, EXCLUDED_ARTIFACTS, REFERENCE, START, END, readRegion, check, write, checkEvidence };
if (require.main === module) runMain(main);
