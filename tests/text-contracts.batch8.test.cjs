'use strict';

/**
 * text-contracts.batch8.test.cjs
 *
 * Detection cases for the 46 text contracts of ADR-6315 item 19 batch 8 (#6566, #6337): each contract against a
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
const SHIPPED = require('./helpers/text-contracts-batch8-ids.cjs');

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

describe('the batch 8 contracts hold on the real files, and fail when a contracted phrase goes', () => {
  // The files each contract reads, copied into a temporary root so one phrase can be removed.
  const FILES = [
    '.github/rulesets/main-protection.json',
    '.github/rulesets/next-queue.json',
    '.github/rulesets/release-branches.json',
    '.github/rulesets/tag-immutability.json',
    '.github/workflows/changeset-required.yml',
    '.github/workflows/dependabot-auto-merge.yml',
    '.github/workflows/docs-required.yml',
    '.github/workflows/release.yml',
    '.github/workflows/reviewed-or-maintainer.yml',
    '.github/workflows/test.yml',
    'CONTEXT.md',
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
    'commands/gsd/discuss-phase.md',
    'commands/gsd/mvp-phase.md',
    'commands/gsd/new-project.md',
    'commands/gsd/quick.md',
    'docs/COMMANDS.md',
    'docs/CONFIGURATION.md',
    'docs/INVENTORY.md',
    'docs/installer-migrations.md',
    'docs/ja-JP/ARCHITECTURE.md',
    'docs/ja-JP/INVENTORY.md',
    'docs/ko-KR/ARCHITECTURE.md',
    'docs/ko-KR/INVENTORY.md',
    'docs/pt-BR/ARCHITECTURE.md',
    'docs/pt-BR/CONFIGURATION.md',
    'docs/pt-BR/INVENTORY.md',
    'docs/reference/planning-artifacts.md',
    'docs/zh-CN/ARCHITECTURE.md',
    'docs/zh-CN/CONFIGURATION.md',
    'docs/zh-CN/INVENTORY.md',
    'gsd-core/bin/lib/frontmatter.cjs',
    'gsd-core/bin/lib/milestone.cjs',
    'gsd-core/bin/lib/phase.cjs',
    'gsd-core/bin/shared/config-defaults.manifest.json',
    'gsd-core/references/debugger-prevention.md',
    'gsd-core/references/debugger-repro-hardening.md',
    'gsd-core/references/debugger-semantic-recall.md',
    'gsd-core/references/domain-probes.md',
    'gsd-core/references/planner-mvp-mode.md',
    'gsd-core/references/planning-config.md',
    'gsd-core/references/prohibition-probe-fixtures/01-streak-reminder/expected.json',
    'gsd-core/references/prohibition-probe-fixtures/02-clean-utility/expected.json',
    'gsd-core/references/prohibition-probe-fixtures/03-multi-prohibition/expected.json',
    'gsd-core/references/prohibition-probe.md',
    'gsd-core/references/research-documentation-lookup.md',
    'gsd-core/references/skeleton-template.md',
    'gsd-core/references/ui-consideration-probe.md',
    'gsd-core/references/verify-mvp-mode.md',
    'gsd-core/templates/DEBUG.md',
    'gsd-core/templates/UI-SPEC.md',
    'gsd-core/templates/phase-prompt.md',
    'gsd-core/templates/planner-subagent-prompt.md',
    'gsd-core/workflows/add-todo.md',
    'gsd-core/workflows/cleanup.md',
    'gsd-core/workflows/code-review.md',
    'gsd-core/workflows/debug.md',
    'gsd-core/workflows/diagnose-issues.md',
    'gsd-core/workflows/discuss-phase.md',
    'gsd-core/workflows/execute-phase.md',
    'gsd-core/workflows/execute-phase/steps/pre-execute-gate-hooks.md',
    'gsd-core/workflows/execute-phase/steps/verify-phase-goal.md',
    'gsd-core/workflows/execute-phase/steps/wave-post-gate-hooks.md',
    'gsd-core/workflows/execute-plan.md',
    'gsd-core/workflows/manager.md',
    'gsd-core/workflows/map-codebase.md',
    'gsd-core/workflows/mvp-phase.md',
    'gsd-core/workflows/new-project.md',
    'gsd-core/workflows/pause-work.md',
    'gsd-core/workflows/plan-phase.md',
    'gsd-core/workflows/plan-phase/steps/auto-advance-check.md',
    'gsd-core/workflows/plan-phase/steps/plan-pre-dispatch.md',
    'gsd-core/workflows/progress.md',
    'gsd-core/workflows/quick.md',
    'gsd-core/workflows/resume-project.md',
    'gsd-core/workflows/settings-advanced.md',
    'gsd-core/workflows/settings-integrations.md',
    'gsd-core/workflows/ship.md',
    'gsd-core/workflows/sync-skills.md',
    'gsd-core/workflows/thread.md',
    'gsd-core/workflows/transition.md',
    'gsd-core/workflows/ui-review.md',
    'gsd-core/workflows/verify-work.md',
    'hooks/gsd-phase-boundary.sh',
    'hooks/gsd-session-state.sh',
    'hooks/gsd-validate-commit.sh',
    'package.json',
    'skills/gsd-discuss-phase/SKILL.md',
    'skills/gsd-new-project/SKILL.md',
  ];

  function copyOfRepoFiles(t) {
    const root = tempDir(t, 'gsd-text-contracts-b8-');
    for (const rel of FILES) write(root, rel, fs.readFileSync(path.join(REPO_ROOT, ...rel.split('/')), 'utf8'));
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
    fs.writeFileSync(abs, edit(fs.readFileSync(abs, 'utf8')));
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

  test('an untouched copy of the files satisfies every batch 8 contract', (t) => {
    assert.deepEqual(runShipped(copyOfRepoFiles(t)), []);
  });

  for (const [title, rel, edit, contract, expected] of [
        // workflow-token-permissions
        ['contents: write dropped from the dependabot auto-merge job (#5136)', '.github/workflows/dependabot-auto-merge.yml',
          yamlEdit((wf) => { delete wf.jobs['auto-merge'].permissions.contents; }), 'workflow-token-permissions', /job "auto-merge" must grant contents: write/],
        ['pull-requests: write dropped from the dependabot auto-merge job (#5136)', '.github/workflows/dependabot-auto-merge.yml',
          yamlEdit((wf) => { delete wf.jobs['auto-merge'].permissions['pull-requests']; }), 'workflow-token-permissions', /job "auto-merge" must grant pull-requests: write/],
        ['the job-level block removed, so the empty workflow-level block applies (#5136)', '.github/workflows/dependabot-auto-merge.yml',
          yamlEdit((wf) => { delete wf.jobs['auto-merge'].permissions; }), 'workflow-token-permissions', /job "auto-merge" must grant contents: write/],
        ['no permissions block at either level (#5136)', '.github/workflows/dependabot-auto-merge.yml',
          yamlEdit((wf) => { delete wf.jobs['auto-merge'].permissions; delete wf.permissions; }), 'workflow-token-permissions', /job "auto-merge" must declare explicit permissions/],
        ['the auto-merge command gone from the dependabot workflow (#5136)', '.github/workflows/dependabot-auto-merge.yml',
          swap('gh pr merge --auto --squash "$PR_URL"', 'gh pr merge --squash "$PR_URL"'), 'workflow-token-permissions', /dependabot-auto-merge\.yml must enable auto-merge/],
        ['a second auto-merge job in the dependabot workflow (#5136)', '.github/workflows/dependabot-auto-merge.yml',
          yamlEdit((wf) => { wf.jobs.second = { 'runs-on': 'ubuntu-latest', permissions: { contents: 'write', 'pull-requests': 'write' }, steps: [{ run: 'gh pr merge 1 --auto' }] }; }), 'workflow-token-permissions', /dependabot-auto-merge\.yml must enable auto-merge/],
        ['an auto-merge job without write permissions in another workflow (#5136)', '.github/workflows/test.yml',
          yamlEdit((wf) => { wf.jobs.sneaky = { 'runs-on': 'ubuntu-latest', permissions: { contents: 'read' }, steps: [{ run: 'gh pr merge 7 --auto' }] }; }), 'workflow-token-permissions', /job "sneaky" must grant contents: write \(has "read"\)/],
        ['a wrapped gh pr merge --auto in another workflow, with no permissions (#5136)', '.github/workflows/test.yml',
          yamlEdit((wf) => { wf.jobs.wrapped = { 'runs-on': 'ubuntu-latest', steps: [{ run: 'gh pr merge 7 \\\n  --auto' }] }; delete wf.permissions; for (const job of Object.values(wf.jobs)) delete job.permissions; }), 'workflow-token-permissions', /job "wrapped" must declare explicit permissions/],

        // verifier-gsd-run-all-modes
        ['the resolver include gone from the verifier (#5004)', 'agents/gsd-verifier.md',
          eraseAll('references/gsd-run-resolver.md'), 'verifier-gsd-run-all-modes', /the agent must include the shared resolver reference/],
        ['the Step 0 heading renamed in the verifier (#5004)', 'agents/gsd-verifier.md',
          swap('## Step 0:', '## Stage 0:'), 'verifier-gsd-run-all-modes', /the Step 0 heading must exist/],
        ['the resolver include moved after Step 0 (#5004)', 'agents/gsd-verifier.md',
          (text) => text.replace('@~/.claude/gsd-core/references/gsd-run-resolver.md\n', '').replace('## Step 1:', '@~/.claude/gsd-core/references/gsd-run-resolver.md\n## Step 1:'), 'verifier-gsd-run-all-modes', /the resolver include must precede Step 0/],
        ['a second resolver include in the verifier (#5004)', 'agents/gsd-verifier.md',
          append('@~/.claude/gsd-core/references/gsd-run-resolver.md'), 'verifier-gsd-run-all-modes', /there must be exactly one resolver include/],
        ['the resolver include also in Step 1 (#5004)', 'agents/gsd-verifier.md',
          swap('## Step 1: Load Context (Initial Mode Only)\n', '## Step 1: Load Context (Initial Mode Only)\n@~/.claude/gsd-core/references/gsd-run-resolver.md\n'), 'verifier-gsd-run-all-modes', /Step 1 is initial-mode only and must not be the resolver definition site/],
        ['a gsd_run call ahead of the resolver include (#5004)', 'agents/gsd-verifier.md',
          swap('## Resolver Bootstrap (Every Mode)\n', '## Resolver Bootstrap (Every Mode)\ngsd_run query state\n'), 'verifier-gsd-run-all-modes', /the first gsd_run invocation must come after the resolver include/],
        ['the Step 1 heading renamed in the verifier (#5004)', 'agents/gsd-verifier.md',
          swap('## Step 1:', '## Stage 1:'), 'verifier-gsd-run-all-modes', /marker .*Step 1:.* not found/],
        ['the Resolver Bootstrap heading renamed in the verifier (#5004)', 'agents/gsd-verifier.md',
          swap('## Resolver Bootstrap', '## Bootstrap'), 'verifier-gsd-run-all-modes', /marker .*Resolver Bootstrap.* not found/],
        ['the preamble loses the resolver include (#5004)', 'agents/gsd-verifier.md',
          within('## Resolver Bootstrap', '\n## ', eraseAll('@~/.claude/gsd-core/references/gsd-run-resolver.md')), 'verifier-gsd-run-all-modes', /the preamble must hold the resolver include/],
        ['the preamble stops naming the forbidden find / (#5004)', 'agents/gsd-verifier.md',
          within('## Resolver Bootstrap', '\n## ', eraseAll('find /')), 'verifier-gsd-run-all-modes', /the preamble must name the disk-wide find it forbids/],
        ['the preamble stops naming the config-dir gsd-tools path (#5004)', 'agents/gsd-verifier.md',
          within('## Resolver Bootstrap', '\n## ', eraseAll('${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/gsd-tools.cjs')), 'verifier-gsd-run-all-modes', /the preamble must require the resolver per Bash call/],

        // prohibition-probe.docs-fixtures
        ['a tagged fixture block untagged in the doc (#644)', 'gsd-core/references/prohibition-probe.md',
          swap('```json prohibition-probe:03-multi-prohibition/expected.json', '```json'), 'prohibition-probe.docs-fixtures', /one tagged fixture block for every expected\.json fixture/],
        ['a tagged block that names no fixture (#644)', 'gsd-core/references/prohibition-probe.md',
          append('```json prohibition-probe:04-extra/expected.json\n{}\n```'), 'prohibition-probe.docs-fixtures', /one tagged fixture block for every expected\.json fixture/],
        ['a tag that names a path outside the fixtures (#644)', 'gsd-core/references/prohibition-probe.md',
          swap('prohibition-probe:02-clean-utility/expected.json', 'prohibition-probe:../../x/expected.json'), 'prohibition-probe.docs-fixtures', /a tagged block names "\.\.\/\.\.\/x\/expected\.json", which is not a plain <dir>\/<file> fixture reference/],
        ['a doc block that drifted from its fixture (#644)', 'gsd-core/references/prohibition-probe.md',
          within('```json prohibition-probe:01-streak-reminder/expected.json', '\n```', (block) => block.replace('"resolved"', '"drifted"')), 'prohibition-probe.docs-fixtures', /prohibition-probe:01-streak-reminder\/expected\.json must parse and deep-equal its fixture file/],
        ['a doc block that is not valid JSON (#644)', 'gsd-core/references/prohibition-probe.md',
          within('```json prohibition-probe:03-multi-prohibition/expected.json', '\n```', (block) => `${block},}`), 'prohibition-probe.docs-fixtures', /prohibition-probe:03-multi-prohibition\/expected\.json must parse and deep-equal its fixture file/],
        ['a fixture file that drifted from its doc block (#644)', 'gsd-core/references/prohibition-probe-fixtures/02-clean-utility/expected.json',
          (text) => JSON.stringify({ ...JSON.parse(text), extra: true }, null, 2), 'prohibition-probe.docs-fixtures', /prohibition-probe:02-clean-utility\/expected\.json must parse and deep-equal its fixture file/],
        ['a fixture file that is not valid JSON (#644)', 'gsd-core/references/prohibition-probe-fixtures/01-streak-reminder/expected.json',
          (text) => `${text}}`, 'prohibition-probe.docs-fixtures', /prohibition-probe:01-streak-reminder\/expected\.json must parse and deep-equal its fixture file/],

        ['a tag that names a parent-directory fixture (#644)', 'gsd-core/references/prohibition-probe.md',
          swap('prohibition-probe:02-clean-utility/expected.json', 'prohibition-probe:../prohibition-probe.md'), 'prohibition-probe.docs-fixtures', /a tagged block names "\.\.\/prohibition-probe\.md", which is not a plain <dir>\/<file> fixture reference/],
        ['a tag that names a current-directory fixture (#644)', 'gsd-core/references/prohibition-probe.md',
          swap('prohibition-probe:02-clean-utility/expected.json', 'prohibition-probe:./expected.json'), 'prohibition-probe.docs-fixtures', /a tagged block names "\.\/expected\.json", which is not a plain <dir>\/<file> fixture reference/],

        // inline-plan-threshold-default
        ['the manifest default changed (#3801)', 'gsd-core/bin/shared/config-defaults.manifest.json',
          swap('"inline_plan_threshold": 2,', '"inline_plan_threshold": 3,'), 'inline-plan-threshold-default', /the defaults manifest must own workflow\.inline_plan_threshold/],
        ['the manifest key renamed (#3801)', 'gsd-core/bin/shared/config-defaults.manifest.json',
          swap('"inline_plan_threshold"', '"inline_plan_limit"'), 'inline-plan-threshold-default', /not registered in config-defaults\.manifest\.json/],
        ['the settings prompt default drifted to 3 (#3801)', 'gsd-core/workflows/settings-advanced.md',
          swap('inline_plan_threshold` (default: `2`', 'inline_plan_threshold` (default: `3`'), 'inline-plan-threshold-default', /settings-advanced\.md must name the inline_plan_threshold default and agree with the manifest's 2 \(documents the default as 3\)/],
        ['the settings read_current line drifted to 3 (#3923)', 'gsd-core/workflows/settings-advanced.md',
          swap('(current: <value or 2>)', '(current: <value or 3>)'), 'inline-plan-threshold-default', /settings-advanced\.md must name the inline_plan_threshold default and agree with the manifest's 2 \(documents the default as 3\)/],
        ['the settings prompt "Default:" drifted to 3 (#3923)', 'gsd-core/workflows/settings-advanced.md',
          (text) => { const at = text.indexOf('Inline plan threshold'); const d = text.indexOf('Default: 2', at); return `${text.slice(0, d)}Default: 3${text.slice(d + 'Default: 2'.length)}`; }, 'inline-plan-threshold-default', /settings-advanced\.md must name the inline_plan_threshold default and agree with the manifest's 2 \(documents the default as 3\)/],
        ['the settings prompt stops naming a default (#3801)', 'gsd-core/workflows/settings-advanced.md',
          swap('(current: <value or 2>)', '(current: <value>)'), 'inline-plan-threshold-default', /the surface does not name the inline_plan_threshold default/],
        ...[
          ['docs/CONFIGURATION.md', /docs\/CONFIGURATION\.md must name the inline_plan_threshold default and agree with the manifest's 2 \(documents the default as 3\)/],
          ['docs/zh-CN/CONFIGURATION.md', /docs\/zh-CN\/CONFIGURATION\.md must name the inline_plan_threshold default and agree with the manifest's 2 \(documents the default as 3\)/],
          ['docs/pt-BR/CONFIGURATION.md', /docs\/pt-BR\/CONFIGURATION\.md must name the inline_plan_threshold default and agree with the manifest's 2 \(documents the default as 3\)/],
        ].map(([rel, why]) => [`${rel} documents the default as 3 (#3923)`, rel,
          swap('`workflow.inline_plan_threshold` | number | `2`', '`workflow.inline_plan_threshold` | number | `3`'), 'inline-plan-threshold-default', why]),
        ['planning-config documents the default as 3 (#3801)', 'gsd-core/references/planning-config.md',
          swap('| `workflow.inline_plan_threshold` | `2` |', '| `workflow.inline_plan_threshold` | `3` |'), 'inline-plan-threshold-default', /planning-config\.md must document inline_plan_threshold and agree with the manifest's 2 \(documents the default as 3\)/],
        ['planning-config stops documenting inline_plan_threshold (#3801)', 'gsd-core/references/planning-config.md',
          swap('workflow.inline_plan_threshold', 'workflow.other_threshold'), 'inline-plan-threshold-default', /planning-config\.md must document inline_plan_threshold and agree with the manifest's 2 \(no inline_plan_threshold row\)/],
        ['the execute-plan shell fallback drifted to 3 (#3801)', 'gsd-core/workflows/execute-plan.md',
          swap('workflow.inline_plan_threshold --raw 2>/dev/null || echo "2")', 'workflow.inline_plan_threshold --raw 2>/dev/null || echo "3")'), 'inline-plan-threshold-default', /execute-plan\.md must fetch the key with a shell fallback that agrees with the manifest default/],
        ['the execute-plan config-get line gone (#3801)', 'gsd-core/workflows/execute-plan.md',
          swap('config-get workflow.inline_plan_threshold', 'config-get workflow.other_threshold'), 'inline-plan-threshold-default', /no config-get workflow\.inline_plan_threshold line/],
        ['the execute-plan prose default drifted to 3 (#3801)', 'gsd-core/workflows/execute-plan.md',
          swap('default: 2, set to `0` to always spawn', 'default: 3, set to `0` to always spawn'), 'inline-plan-threshold-default', /the prose default must stay 2/],

        // todos-done-rename-guard
        ['a todos/done path in a doc (#2491)', 'docs/CONFIGURATION.md',
          append('Closed todos are archived to .planning/todos/done/ for later.'), 'todos-done-rename-guard', /a stale todos\/done reference: the canonical archive dir is todos\/completed/],
        ['a todos/done path in a workflow (#2491)', 'gsd-core/workflows/execute-plan.md',
          append('mv "$TODO" .planning/todos/done/'), 'todos-done-rename-guard', /a stale todos\/done reference: the canonical archive dir is todos\/completed/],

        // ui-consideration-probe-docs-fixtures
        ['a taxonomy id renamed in the doc (ADPT-02)', 'gsd-core/references/ui-consideration-probe.md',
          swap('| loading | Loading', '| spinner | Loading'), 'ui-consideration-probe-docs-fixtures', /the doc taxonomy ids must equal the code UI_TAXONOMY ids, in order/],
        ['two taxonomy ids swapped in the doc (ADPT-02)', 'gsd-core/references/ui-consideration-probe.md',
          (text) => text.replace('| empty | Empty', '| @@ | Empty').replace('| loading | Loading', '| empty | Loading').replace('| @@ | Empty', '| loading | Empty'), 'ui-consideration-probe-docs-fixtures', /the doc taxonomy ids must equal the code UI_TAXONOMY ids, in order/],
        ['the Taxonomy section renamed in the doc (ADPT-02)', 'gsd-core/references/ui-consideration-probe.md',
          swap('## Taxonomy (8 categories)', '## Categories (8)'), 'ui-consideration-probe-docs-fixtures', /no ## Taxonomy section/],
        ['domain-probes.md no longer named in the doc (ADPT-02)', 'gsd-core/references/ui-consideration-probe.md',
          eraseAll('domain-probes.md'), 'ui-consideration-probe-docs-fixtures', /the doc must name domain-probes\.md as the companion open-prose bank/],
        ['text_en gone from the Inputs section (#4657)', 'gsd-core/references/ui-consideration-probe.md',
          within('## Inputs', '\n## ', eraseAll('text_en')), 'ui-consideration-probe-docs-fixtures', /the Inputs section must document the optional text_en field/],
        ['English gone from the Inputs section (#4657)', 'gsd-core/references/ui-consideration-probe.md',
          within('## Inputs', '\n## ', eraseAll('English')), 'ui-consideration-probe-docs-fixtures', /the Inputs section must document the optional text_en field/],
        ['the Inputs section renamed (#4657)', 'gsd-core/references/ui-consideration-probe.md',
          swap('## Inputs', '## Fields'), 'ui-consideration-probe-docs-fixtures', /no ## Inputs section/],
        ['a domain-probes topic that is a taxonomy id (ADPT-02)', 'gsd-core/references/domain-probes.md',
          append('## Loading'), 'ui-consideration-probe-docs-fixtures', /no taxonomy id may overlap a domain-probes\.md open-prose topic .* \(overlapping ids: loading\)/],
        ['the UI Considerations section gone from the UI-SPEC template (WIRE-02)', 'gsd-core/templates/UI-SPEC.md',
          swap('## UI Considerations', '## UI Notes'), 'ui-consideration-probe-docs-fixtures', /no ## UI Considerations section/],
        ['the Copywriting Contract section gone from the UI-SPEC template (WIRE-02)', 'gsd-core/templates/UI-SPEC.md',
          swap('## Copywriting Contract', '## Copy'), 'ui-consideration-probe-docs-fixtures', /no ## Copywriting Contract section/],

        // localized-inventory-agent-counts
        ['a count in the ja-JP coverage note (#5601)', 'docs/ja-JP/INVENTORY.md',
          (text) => { const lines = text.split(/\r?\n/); const i = lines.findIndex((l) => l.includes('`docs/reference/agents.md`') && l.includes('`agents/gsd-*.md`')); lines[i] += ' 21'; return lines.join('\n'); }, 'localized-inventory-agent-counts', /ja-JP\/INVENTORY\.md must have a coverage note that states no agent counts \(the coverage note states a count/],
        ['the ko-KR coverage note not found (#5601)', 'docs/ko-KR/INVENTORY.md',
          swap('`agents/gsd-*.md`', 'agents/gsd-*.md'), 'localized-inventory-agent-counts', /ko-KR\/INVENTORY\.md must have a coverage note that states no agent counts \(the coverage note was not found/],
        ['a count in a ja-JP section heading (#5601)', 'docs/ja-JP/INVENTORY.md',
          swap('## エージェント', '## エージェント (21 件)'), 'localized-inventory-agent-counts', /ja-JP\/INVENTORY\.md section headings must carry no "\(N shipped\)" count/],
        ['a count in a zh-CN section heading (#5601)', 'docs/zh-CN/INVENTORY.md',
          append('## 命令 (59 个)'), 'localized-inventory-agent-counts', /zh-CN\/INVENTORY\.md section headings must carry no "\(N shipped\)" count/],
        ['a dead INVENTORY anchor in a ja-JP page (#5601)', 'docs/ja-JP/ARCHITECTURE.md',
          append('[x](INVENTORY.md#no-such-heading)'), 'localized-inventory-agent-counts', /ja-JP: a link to an INVENTORY\.md anchor that matches no heading \(#no-such-heading\)/],
        ['a dead INVENTORY anchor reached through ./ in a pt-BR page (#5601)', 'docs/pt-BR/ARCHITECTURE.md',
          append('[x](./INVENTORY.md#no-such-heading)'), 'localized-inventory-agent-counts', /pt-BR: a link to an INVENTORY\.md anchor that matches no heading/],

        ['an undecodable INVENTORY anchor in a ja-JP page (#5601)', 'docs/ja-JP/ARCHITECTURE.md',
          append('[x](INVENTORY.md#%zz)'), 'localized-inventory-agent-counts', /ja-JP: a link to an INVENTORY\.md anchor that matches no heading \(#%zz \(not a decodable anchor\)\)/],

        // mvp-phase-command
        ['the mvp-phase command renamed', 'commands/gsd/mvp-phase.md',
          swap('name: gsd:mvp-phase', 'name: gsd:other'), 'mvp-phase-command', /the frontmatter must declare the command name gsd:mvp-phase/],
        ['the mvp-phase argument-hint stops mentioning the phase', 'commands/gsd/mvp-phase.md',
          swap('argument-hint: "<phase-number>"', 'argument-hint: "<n>"'), 'mvp-phase-command', /the argument-hint must mention the phase number/],
        ...[['Read', /^ {2}- Read\n/m], ['Write', /^ {2}- Write\n/m], ['Bash', /^ {2}- Bash\n/m], ['AskUserQuestion', /^ {2}- AskUserQuestion\n/m]].map(([tool, line]) => [`${tool} dropped from the mvp-phase allowed-tools`, 'commands/gsd/mvp-phase.md',
          erase(line), 'mvp-phase-command', /allowed-tools must include Read, Write, Bash and AskUserQuestion \(missing/]),
        ['neither Task nor Agent in the mvp-phase allowed-tools', 'commands/gsd/mvp-phase.md',
          erase(/^ {2}- Agent\n/m), 'mvp-phase-command', /allowed-tools must include Task or Agent for delegation/],
        ['the workflow gone from the mvp-phase execution_context', 'commands/gsd/mvp-phase.md',
          eraseAll('@~/.claude/gsd-core/workflows/mvp-phase.md'), 'mvp-phase-command', /execution_context must include workflows\/mvp-phase\.md/],
        ['the mvp-phase frontmatter fence gone', 'commands/gsd/mvp-phase.md',
          (text) => text.replace(/^---\r?\n/, ''), 'mvp-phase-command', /the command must start with YAML frontmatter/],

        // prohibition-probe.planner-contract
        ['the plan-phase downstream_consumer block renamed (#644)', 'gsd-core/workflows/plan-phase.md',
          eraseAll('<downstream_consumer>'), 'prohibition-probe.planner-contract', /marker .*downstream_consumer.* not found/],
        ['Prohibitions gone from the downstream_consumer block (PROB-04)', 'gsd-core/workflows/plan-phase.md',
          within('<downstream_consumer>', '</downstream_consumer>', eraseAll('Prohibitions')), 'prohibition-probe.planner-contract', /the <downstream_consumer> block must reference the SPEC Prohibitions section/],
        ['must_haves.prohibitions gone from the downstream_consumer block (PROB-04)', 'gsd-core/workflows/plan-phase.md',
          within('<downstream_consumer>', '</downstream_consumer>', eraseAll('must_haves.prohibitions')), 'prohibition-probe.planner-contract', /must lift resolved prohibitions into must_haves\.prohibitions/],
        ['a lift of prohibitions into must_haves.truths in the downstream_consumer block (ADR-550 D2)', 'gsd-core/workflows/plan-phase.md',
          within('<downstream_consumer>', '</downstream_consumer>', (block) => `${block}\nLift every prohibition into must_haves.truths.\n`), 'prohibition-probe.planner-contract', /prohibitions must NOT be lifted into must_haves\.truths/],
        ['the truths wording the other way round in the downstream_consumer block (ADR-550 D2)', 'gsd-core/workflows/plan-phase.md',
          within('<downstream_consumer>', '</downstream_consumer>', (block) => `${block}\nmust_haves.truths also takes the prohibition.\n`), 'prohibition-probe.planner-contract', /prohibitions must NOT be lifted into must_haves\.truths/],
        ['prohibition gone from the last quality_gate (PROB-04)', 'gsd-core/workflows/plan-phase.md',
          (text) => { const s = text.lastIndexOf('<quality_gate>'); const e = text.indexOf('</quality_gate>', s); return text.slice(0, s) + text.slice(s, e).replace(/prohibition/gi, 'rule') + text.slice(e); }, 'prohibition-probe.planner-contract', /the planner quality_gate must contain a checklist item covering SPEC prohibitions/],
        ['must_haves.prohibitions gone from the last quality_gate (PROB-04)', 'gsd-core/workflows/plan-phase.md',
          (text) => { const s = text.lastIndexOf('<quality_gate>'); const e = text.indexOf('</quality_gate>', s); return text.slice(0, s) + text.slice(s, e).replace(/must_haves\.prohibitions/g, 'must_haves.rules') + text.slice(e); }, 'prohibition-probe.planner-contract', /the planner quality_gate must tie SPEC prohibitions to must_haves\.prohibitions/],
        ['a later quality_gate block without the prohibition item becomes the last one (PROB-04)', 'gsd-core/workflows/plan-phase.md',
          append('<quality_gate>\n- [ ] nothing\n</quality_gate>'), 'prohibition-probe.planner-contract', /the planner quality_gate must contain a checklist item covering SPEC prohibitions/],
        ['the prohibitions lift in the orphaned planner-subagent-prompt (PROB-04)', 'gsd-core/templates/planner-subagent-prompt.md',
          append('Lift prohibitions into must_haves.prohibitions.'), 'prohibition-probe.planner-contract', /planner-subagent-prompt\.md is not loaded at runtime/],

        // debugger-semantic-recall
        ...[
          [/mempalace/gi, /it must name MemPalace as the semantic-memory surface/], [/semantic/gi, /it must document semantic \(not keyword\) recall/],
          [/top-?k|meaning.similar|semantically.similar/gi, /it must document surfacing top-k meaning-similar prior resolutions/],
          [/different.{0,30}word|lexically|same root cause|wording/gi, /it must state that semantic recall catches same-root-cause, different-wording cases/],
          [/index|archive|store|capture/gi, /it must document that resolved sessions are indexed into MemPalace at archive time/],
          [/fall[\s-]?back|fallback|when[^\n]{0,500}(?:absent|unavailable)|degrade/gi, /it must document degradation to keyword matching when MemPalace is absent/],
          [/keyword/gi, /it must name keyword matching as the fallback/], [/error patterns/gi, /the fallback must scan the Error patterns field/],
          [/2\+ token overlap/gi, /the fallback must keep the 2\+ token overlap threshold/], [/identifier/gi, /the fallback must keep identifier extraction/],
          [/case[-]insensitive/gi, /the fallback must keep the case[-]insensitive qualifier/],
          [/knowledge-base\.md|durable|plain[\s-]?text|source of truth/gi, /it must state that knowledge-base\.md remains the durable plain-text source of truth/],
          [/reuse|no new|without adding|existing[^\n]{0,500}(?:semantic|memory|capability)/gi, /it must state that MemPalace is reused rather than adding new embedding or vector infrastructure/],
        ].map(([pattern, why]) => [`${pattern} gone from the debugger-semantic-recall reference (#1964)`, 'gsd-core/references/debugger-semantic-recall.md', erase(pattern), 'debugger-semantic-recall', why]),
        ['the semantic-recall @-include gone from gsd-debugger (#1964)', 'agents/gsd-debugger.md',
          eraseAll('@~/.claude/gsd-core/references/debugger-semantic-recall.md'), 'debugger-semantic-recall', /gsd-debugger\.md must @-include the semantic-recall reference/],
        ['semantic gone from gsd-debugger (#1964)', 'agents/gsd-debugger.md',
          erase(/semantic/gi), 'debugger-semantic-recall', /the agent must reference semantic recall/],
        ['MemPalace gone from gsd-debugger (#1964)', 'agents/gsd-debugger.md',
          erase(/mempalace/gi), 'debugger-semantic-recall', /the agent must name MemPalace/],
        ['the keyword fallback gone from gsd-debugger (#1964)', 'agents/gsd-debugger.md',
          erase(/fall[\s-]?back|fallback/gi), 'debugger-semantic-recall', /the agent must describe the keyword fallback/],
        ['the stale keyword-overlap claim back in gsd-debugger (#1964)', 'agents/gsd-debugger.md',
          append('Matching is keyword overlap, not semantic similarity.'), 'debugger-semantic-recall', /the old "Matching is keyword overlap, not semantic similarity" claim must be removed/],

        // atomic-write-coverage
        ...[
          ['milestone.cjs', /milestone\.cjs must not contain a bare fs\.writeFileSync/, /milestone\.cjs must import from shell-command-projection\.cjs/, /milestone\.cjs must contain at least one platformWriteSync call/],
          ['phase.cjs', /phase\.cjs must not contain a bare fs\.writeFileSync/, /phase\.cjs must import from shell-command-projection\.cjs/, /phase\.cjs must contain at least one platformWriteSync call/],
          ['frontmatter.cjs', /frontmatter\.cjs must not contain a bare fs\.writeFileSync/, /frontmatter\.cjs must import from shell-command-projection\.cjs/, /frontmatter\.cjs must contain at least one platformWriteSync call/],
        ].flatMap(([file, bare, importing, calling]) => [
          [`a bare fs.writeFileSync in ${file} (#1972)`, `gsd-core/bin/lib/${file}`, append('fs.writeFileSync(planningPath, content);'), 'atomic-write-coverage', bare],
          [`a bare fs.writeFileSync with a space before the paren in ${file} (#1972)`, `gsd-core/bin/lib/${file}`, append('fs.writeFileSync (statePath, content);'), 'atomic-write-coverage', bare],
          [`the shell-command-projection import gone from ${file} (#1972)`, `gsd-core/bin/lib/${file}`, eraseAll('require("./shell-command-projection.cjs")'), 'atomic-write-coverage', importing],
          [`every platformWriteSync gone from ${file} (#1972)`, `gsd-core/bin/lib/${file}`, eraseAll('platformWriteSync'), 'atomic-write-coverage', calling],
        ]),

        // close-phase-todos-stage-deletion
        ['the close_phase_todos step renamed (#2415)', 'gsd-core/workflows/execute-phase.md',
          swap('<step name="close_phase_todos">', '<step name="close_todos">'), 'close-phase-todos-stage-deletion', /marker .*close_phase_todos.* not found/],
        ['--files-removed gone from the close_phase_todos commit (#2415, #4208)', 'gsd-core/workflows/execute-phase.md',
          inStepOf('close_phase_todos', swap(' --files-removed "${REMOVED[@]}"', '')), 'close-phase-todos-stage-deletion', /close_phase_todos must stage the completed\/ destinations .* \(no --files-removed "\$\{REMOVED\[@\]\}"\)/],
        ['the ADDED array gone from the close_phase_todos --files (#4208)', 'gsd-core/workflows/execute-phase.md',
          inStepOf('close_phase_todos', swap('--files "${ADDED[@]}"', '--files "$COMPLETED_DIR"')), 'close-phase-todos-stage-deletion', /commit --files does not carry the ADDED array/],
        ['the {state_path} placeholder gone from the close_phase_todos --files (#5861)', 'gsd-core/workflows/execute-phase.md',
          inStepOf('close_phase_todos', swap(' "{state_path}"', '')), 'close-phase-todos-stage-deletion', /no \{state_path\} placeholder/],
        ['the close_phase_todos commit gone (#2415)', 'gsd-core/workflows/execute-phase.md',
          inStepOf('close_phase_todos', swap('gsd_run query commit', 'gsd_run query save')), 'close-phase-todos-stage-deletion', /no gsd_run query commit \.\.\. --files invocation/],
        ['ADDED built from the pending dir (#2415)', 'gsd-core/workflows/execute-phase.md',
          inStepOf('close_phase_todos', swap('ADDED+=("$COMPLETED_DIR/$f")', 'ADDED+=("$PENDING_DIR/$f")')), 'close-phase-todos-stage-deletion', /ADDED must be built from \$COMPLETED_DIR, the destination of the move/],
        ['REMOVED built from the completed dir (#2415)', 'gsd-core/workflows/execute-phase.md',
          inStepOf('close_phase_todos', swap('REMOVED+=("$PENDING_DIR/$f")', 'REMOVED+=("$COMPLETED_DIR/$f")')), 'close-phase-todos-stage-deletion', /REMOVED must be built from \$PENDING_DIR, the source whose deletion #2415 requires/],
        ['the plain mv replaced by cp in close_phase_todos (#2415)', 'gsd-core/workflows/execute-phase.md',
          inStepOf('close_phase_todos', swap('mv "$TODO_FILE" "$COMPLETED_DIR/"', 'cp "$TODO_FILE" "$COMPLETED_DIR/"')), 'close-phase-todos-stage-deletion', /close_phase_todos must use plain shell mv to move the file/],
        ['git mv in close_phase_todos (#2415)', 'gsd-core/workflows/execute-phase.md',
          inStepOf('close_phase_todos', swap('mv "$TODO_FILE" "$COMPLETED_DIR/"', 'git mv "$TODO_FILE" "$COMPLETED_DIR/"')), 'close-phase-todos-stage-deletion', /close_phase_todos must NOT use git mv as the move command/],
        ['the pending directory moved to --files in the cleanup archive commit (#4208)', 'gsd-core/workflows/cleanup.md',
          swap('--files "${PLANNING_ROOT}/milestones/"', '--files "${PLANNING_ROOT}/phases/" "${PLANNING_ROOT}/milestones/"'), 'close-phase-todos-stage-deletion', /the archive commit must route the moved-away directories through --files-removed, not --files/],
        ['the quick directory gone from --files-removed in the cleanup archive commit (#4208)', 'gsd-core/workflows/cleanup.md',
          swap(' "${PLANNING_ROOT}/quick/"', ''), 'close-phase-todos-stage-deletion', /the archive commit must route the moved-away directories through --files-removed, not --files/],
        ['--files-removed gone from the cleanup archive commit (#4208)', 'gsd-core/workflows/cleanup.md',
          eraseAll('--files-removed'), 'close-phase-todos-stage-deletion', /cleanup\.md must commit the archive via gsd_run query commit \.\.\. --files-removed/],
        ['STATE.md gone from the cleanup archive --files (#4208)', 'gsd-core/workflows/cleanup.md',
          swap(' "${PLANNING_ROOT}/STATE.md" --files-removed', ' --files-removed'), 'close-phase-todos-stage-deletion', /the destinations and STATE\.md must stay under --files/],
        ['the milestones destination gone from the cleanup archive --files (#4208)', 'gsd-core/workflows/cleanup.md',
          swap('"${PLANNING_ROOT}/milestones/" ', ''), 'close-phase-todos-stage-deletion', /the destinations and STATE\.md must stay under --files/],
        ['--files itself gone from the cleanup archive commit (#4208)', 'gsd-core/workflows/cleanup.md',
          swap('--files "${PLANNING_ROOT}/milestones/" "${PLANNING_ROOT}/STATE.md"', '"${PLANNING_ROOT}/milestones/" "${PLANNING_ROOT}/STATE.md"'), 'close-phase-todos-stage-deletion', /the destinations and STATE\.md must stay under --files/],

        // second round: malformed input is a finding, not a throw
        ['an invalid YAML dependabot workflow (#5136)', '.github/workflows/dependabot-auto-merge.yml',
          append('jobs: [unclosed'), 'workflow-token-permissions', /dependabot-auto-merge\.yml must enable auto-merge .*the workflow does not parse/],
        ['an invalid YAML workflow file is a finding for that file (#5136)', '.github/workflows/test.yml',
          append('this: is: not: valid: [yaml'), 'workflow-token-permissions', /the workflow does not parse/],
        ['a workflow that is a list, not a mapping (#5136)', '.github/workflows/test.yml',
          () => '- a\n- b\n', 'workflow-token-permissions', /the workflow is not a mapping/],
        ['jobs that is a string, not a mapping (#5136)', '.github/workflows/test.yml',
          yamlEdit((wf) => { wf.jobs = 'x'; }), 'workflow-token-permissions', /jobs is not a mapping/],
        ['a null job (#5136)', '.github/workflows/test.yml',
          yamlEdit((wf) => { wf.jobs.broken = null; }), 'workflow-token-permissions', /job "broken" is not a mapping/],
        ['a job whose steps are a string (#5136)', '.github/workflows/test.yml',
          yamlEdit((wf) => { wf.jobs.broken = { 'runs-on': 'ubuntu-latest', steps: 'echo hi' }; }), 'workflow-token-permissions', /job "broken" has steps that are not a list/],
        ['a null step (#5136)', '.github/workflows/test.yml',
          yamlEdit((wf) => { wf.jobs.broken = { 'runs-on': 'ubuntu-latest', steps: [null, { run: 'echo hi' }] }; }), 'workflow-token-permissions', /job "broken" has a step that is not a mapping/],
        ['a null job in the dependabot workflow (#5136)', '.github/workflows/dependabot-auto-merge.yml',
          yamlEdit((wf) => { wf.jobs.broken = null; }), 'workflow-token-permissions', /dependabot-auto-merge\.yml must enable auto-merge .*job "broken" is not a mapping/],
        ['a manifest that is not valid JSON (#3801)', 'gsd-core/bin/shared/config-defaults.manifest.json',
          append('}'), 'inline-plan-threshold-default', /the manifest is not valid JSON/],
        ['a manifest that is null (#3801)', 'gsd-core/bin/shared/config-defaults.manifest.json',
          () => 'null\n', 'inline-plan-threshold-default', /not registered in config-defaults\.manifest\.json/],
        ['a manifest whose workflow section is a list (#3801)', 'gsd-core/bin/shared/config-defaults.manifest.json',
          () => '{"workflow": []}\n', 'inline-plan-threshold-default', /not registered in config-defaults\.manifest\.json/],
        ['planning-config with no parseable table (#3801)', 'gsd-core/references/planning-config.md',
          swap('|', ':'), 'inline-plan-threshold-default', /planning-config\.md must document inline_plan_threshold and agree with the manifest's 2 \(no parseable defaults table\)/],

        // third round
        ['a double-quoted --auto flag on an under-permissioned job (#5136)', '.github/workflows/test.yml',
          yamlEdit((wf) => { wf.jobs.quoted = { 'runs-on': 'ubuntu-latest', permissions: { contents: 'read' }, steps: [{ run: 'gh pr merge 7 "--auto"' }] }; }), 'workflow-token-permissions', /job "quoted" must grant contents: write/],
        ['a single-quoted --auto flag on an under-permissioned job (#5136)', '.github/workflows/test.yml',
          yamlEdit((wf) => { wf.jobs.quoted = { 'runs-on': 'ubuntu-latest', permissions: { contents: 'read' }, steps: [{ run: "gh pr merge 7 '--auto'" }] }; }), 'workflow-token-permissions', /job "quoted" must grant contents: write/],
        ['a flag glued to merge on an under-permissioned job (#5136)', '.github/workflows/test.yml',
          yamlEdit((wf) => { wf.jobs.glued = { 'runs-on': 'ubuntu-latest', permissions: { contents: 'read' }, steps: [{ run: 'gh pr merge--auto 7' }] }; }), 'workflow-token-permissions', /job "glued" must grant contents: write/],
        ['a non-breaking space between gh and pr on an under-permissioned job (#5136)', '.github/workflows/test.yml',
          yamlEdit((wf) => { wf.jobs.nbsp = { 'runs-on': 'ubuntu-latest', permissions: { contents: 'read' }, steps: [{ run: 'gh\u00a0pr merge 7 --auto' }] }; }), 'workflow-token-permissions', /job "nbsp" must grant contents: write/],
        ['an ideographic space between pr and merge on an under-permissioned job (#5136)', '.github/workflows/test.yml',
          yamlEdit((wf) => { wf.jobs.wide = { 'runs-on': 'ubuntu-latest', permissions: { contents: 'read' }, steps: [{ run: 'gh pr\u3000merge 7 --auto' }] }; }), 'workflow-token-permissions', /job "wide" must grant contents: write/],
        ['a line separator before --auto on an under-permissioned job (#5136)', '.github/workflows/test.yml',
          yamlEdit((wf) => { wf.jobs.sep = { 'runs-on': 'ubuntu-latest', permissions: { contents: 'read' }, steps: [{ run: 'gh pr merge 7\u2028--auto' }] }; }), 'workflow-token-permissions', /job "sep" must grant contents: write/],
        ['a blank line after the continuation backslash on an under-permissioned job (#5136)', '.github/workflows/test.yml',
          yamlEdit((wf) => { wf.jobs.blank = { 'runs-on': 'ubuntu-latest', permissions: { contents: 'read' }, steps: [{ run: 'gh pr merge 7 \\\n\n  --auto' }] }; }), 'workflow-token-permissions', /job "blank" must grant contents: write/],
        ['a command ending in a continuation backslash on an under-permissioned job (#5136)', '.github/workflows/test.yml',
          yamlEdit((wf) => { wf.jobs.trailing = { 'runs-on': 'ubuntu-latest', permissions: { contents: 'read' }, steps: [{ run: 'gh pr merge 7 --auto \\' }] }; }), 'workflow-token-permissions', /job "trailing" must grant contents: write/],
        ['a wrapped command in a CRLF workflow file on an under-permissioned job (#5136)', '.github/workflows/test.yml',
          (text) => yamlEdit((wf) => { wf.jobs.crlf = { 'runs-on': 'ubuntu-latest', permissions: { contents: 'read' }, steps: [{ run: 'gh pr merge 7 \\\r\n  --auto' }] }; })(text).split('\n').join('\r\n'), 'workflow-token-permissions', /job "crlf" must grant contents: write/],
        ['a comment-only workflow file (#5136)', '.github/workflows/test.yml',
          () => '# nothing here\n', 'workflow-token-permissions', /the workflow is not a mapping/],
        ['form feed before a gsd_run call ahead of the resolver (#5004)', 'agents/gsd-verifier.md',
          swap('## Resolver Bootstrap (Every Mode)\n', '## Resolver Bootstrap (Every Mode)\n\fgsd_run query state\n'), 'verifier-gsd-run-all-modes', /the first gsd_run invocation must come after the resolver include/],
        ['vertical tab before a gsd_run call ahead of the resolver (#5004)', 'agents/gsd-verifier.md',
          swap('## Resolver Bootstrap (Every Mode)\n', '## Resolver Bootstrap (Every Mode)\n\vgsd_run query state\n'), 'verifier-gsd-run-all-modes', /the first gsd_run invocation must come after the resolver include/],
        ['a non-breaking space between git and mv in close_phase_todos (#2415)', 'gsd-core/workflows/execute-phase.md',
          inStepOf('close_phase_todos', (block) => `${block}\ngit\u00a0mv a b\n`), 'close-phase-todos-stage-deletion', /close_phase_todos must NOT use git mv as the move command/],
        ['a line separator between git and mv in close_phase_todos (#2415)', 'gsd-core/workflows/execute-phase.md',
          inStepOf('close_phase_todos', (block) => `${block}\ngit\u2028mv a b\n`), 'close-phase-todos-stage-deletion', /close_phase_todos must NOT use git mv as the move command/],
        ['an ideographic space between git and mv in close_phase_todos (#2415)', 'gsd-core/workflows/execute-phase.md',
          inStepOf('close_phase_todos', (block) => `${block}\ngit\u3000mv a b\n`), 'close-phase-todos-stage-deletion', /close_phase_todos must NOT use git mv as the move command/],

        // fourth round
        ['a token ending in gh (xgh) before pr merge on an under-permissioned job (#5136)', '.github/workflows/test.yml',
          yamlEdit((wf) => { wf.jobs.xgh = { 'runs-on': 'ubuntu-latest', permissions: { contents: 'read' }, steps: [{ run: 'xgh pr merge 7 --auto' }] }; }), 'workflow-token-permissions', /job "xgh" must grant contents: write/],
        ['a path ending in gh before pr merge on an under-permissioned job (#5136)', '.github/workflows/test.yml',
          yamlEdit((wf) => { wf.jobs.path = { 'runs-on': 'ubuntu-latest', permissions: { contents: 'read' }, steps: [{ run: '/usr/bin/gh pr merge 7 --auto' }] }; }), 'workflow-token-permissions', /job "path" must grant contents: write/],
        ['an underscored name ending in gh before pr merge on an under-permissioned job (#5136)', '.github/workflows/test.yml',
          yamlEdit((wf) => { wf.jobs.under = { 'runs-on': 'ubuntu-latest', permissions: { contents: 'read' }, steps: [{ run: 'my_gh pr merge 7 --auto' }] }; }), 'workflow-token-permissions', /job "under" must grant contents: write/],
        ['--automatic ahead of the real --auto flag on an under-permissioned job (#5136)', '.github/workflows/test.yml',
          yamlEdit((wf) => { wf.jobs.second = { 'runs-on': 'ubuntu-latest', permissions: { contents: 'read' }, steps: [{ run: 'gh pr merge 7 --automatic --auto' }] }; }), 'workflow-token-permissions', /job "second" must grant contents: write/],
        ['--auto-merge as the flag on an under-permissioned job (#5136)', '.github/workflows/test.yml',
          yamlEdit((wf) => { wf.jobs.hyphen = { 'runs-on': 'ubuntu-latest', permissions: { contents: 'read' }, steps: [{ run: 'gh pr merge 7 --auto-merge' }] }; }), 'workflow-token-permissions', /job "hyphen" must grant contents: write/],
        ['a lone carriage return before a gsd_run call ahead of the resolver (#5004)', 'agents/gsd-verifier.md',
          swap('## Resolver Bootstrap (Every Mode)\n', '## Resolver Bootstrap (Every Mode)\rgsd_run query state\n'), 'verifier-gsd-run-all-modes', /the first gsd_run invocation must come after the resolver include/],
        ['a line separator before a gsd_run call ahead of the resolver (#5004)', 'agents/gsd-verifier.md',
          swap('## Resolver Bootstrap (Every Mode)\n', '## Resolver Bootstrap (Every Mode)\u2028gsd_run query state\n'), 'verifier-gsd-run-all-modes', /the first gsd_run invocation must come after the resolver include/],
        ['a paragraph separator before a gsd_run call ahead of the resolver (#5004)', 'agents/gsd-verifier.md',
          swap('## Resolver Bootstrap (Every Mode)\n', '## Resolver Bootstrap (Every Mode)\u2029gsd_run query state\n'), 'verifier-gsd-run-all-modes', /the first gsd_run invocation must come after the resolver include/],
        // add-todo
        ['the infer_severity step gone from add-todo (#2337)', 'gsd-core/workflows/add-todo.md', eraseAll('<step name="infer_severity">'), 'add-todo', /add-todo\.md must define an infer_severity step/],
        ['create_file ahead of infer_severity in add-todo (#2337)', 'gsd-core/workflows/add-todo.md', (text) => `<step name="create_file">\n${text}`, 'add-todo', /infer_severity must precede create_file/],
        ['the severity field gone from the add-todo frontmatter template (#2337)', 'gsd-core/workflows/add-todo.md', erase(/^severity:[ \t]{0,20}\[blocker\|major\|minor\|cosmetic/gm), 'add-todo', /frontmatter template must include a severity field/],
        ['AskUserQuestion gone from infer_severity (#2337)', 'gsd-core/workflows/add-todo.md', inStepOf('infer_severity', erase(/AskUserQuestion/g)), 'add-todo', /severity must be confirmed via AskUserQuestion/],
        ['TEXT_MODE gone from infer_severity (#2337)', 'gsd-core/workflows/add-todo.md', inStepOf('infer_severity', erase(/TEXT_MODE/g)), 'add-todo', /non-Claude-runtime numbered-list fallback/],
        ...[['blocker', /taxonomy must include "blocker"/], ['major', /taxonomy must include "major"/], ['minor', /taxonomy must include "minor"/], ['cosmetic', /taxonomy must include "cosmetic"/]].map(([level, why]) => [`${level} gone from the infer_severity taxonomy (#2337)`, 'gsd-core/workflows/add-todo.md', inStepOf('infer_severity', eraseAll(level)), 'add-todo', why]),
        // progress-debt-segmentation-guard
        ['the step 1.6 heading renamed in progress (#3782)', 'gsd-core/workflows/progress.md', eraseAll('**Step 1.6: Cross-phase health check**'), 'progress-debt-segmentation-guard', /marker .*Step 1\.6.* not found/],
        ['the step 1.7 marker gone from progress (#3782)', 'gsd-core/workflows/progress.md', eraseAll('**Step 1.7:'), 'progress-debt-segmentation-guard', /closing marker .* not found/],
        ['the non-archived selection gone from step 1.6 (#3782)', 'gsd-core/workflows/progress.md', within('**Step 1.6: Cross-phase health check**', '**Step 1.7:', erase(/select\(has\("archived_milestone"\)\s{0,20}\|\s{0,20}not\)/g)), 'progress-debt-segmentation-guard', /select results WITHOUT the archived_milestone stamp/],
        ['outstanding_debt read from summary.total_items in step 1.6 (#3782)', 'gsd-core/workflows/progress.md', within('**Step 1.6: Cross-phase health check**', '**Step 1.7:', (step) => `${step}\nTrack: \`outstanding_debt\` — \`summary.total_items\`\n`), 'progress-debt-segmentation-guard', /outstanding_debt must not read the cross-population summary\.total_items/],
        ['the false milestone-boundaries claim back in step 1.6 (#3782)', 'gsd-core/workflows/progress.md', within('**Step 1.6: Cross-phase health check**', '**Step 1.7:', (step) => `${step}\nwhich respects milestone boundaries\n`), 'progress-debt-segmentation-guard', /milestone-boundaries claim must stay corrected/],
        ['archived_debt gone from step 1.6 (#3782)', 'gsd-core/workflows/progress.md', within('**Step 1.6: Cross-phase health check**', '**Step 1.7:', eraseAll('archived_debt')), 'progress-debt-segmentation-guard', /archived debt must be tracked as its own value/],
        ['the archived-milestones label gone from step 1.6 (#3782)', 'gsd-core/workflows/progress.md', within('**Step 1.6: Cross-phase health check**', '**Step 1.7:', erase(/items still open in archived milestones\)/g)), 'progress-debt-segmentation-guard', /warning header must label the archived segment/],
        // execute-phase-human-needed-uat-merge
        ['the Step A heading renamed in execute-phase (#5845)', 'gsd-core/workflows/execute-phase.md', eraseAll('**Step A: Persist human verification items'), 'execute-phase-human-needed-uat-merge', /marker .*Step A.* not found/],
        ['the Step B heading renamed in execute-phase (#5845)', 'gsd-core/workflows/execute-phase.md', eraseAll('**Step B: Present to user**'), 'execute-phase-human-needed-uat-merge', /closing marker .* not found/],
        ['the test -f check gone from Step A (#5845)', 'gsd-core/workflows/execute-phase.md', within('**Step A: Persist human verification items', '**Step B: Present to user**', eraseAll('test -f')), 'execute-phase-human-needed-uat-merge', /Step A must run a literal `test -f` existence check/],
        ['the template gone from Step A (#5845)', 'gsd-core/workflows/execute-phase.md', within('**Step A: Persist human verification items', '**Step B: Present to user**', eraseAll('status: testing')), 'execute-phase-human-needed-uat-merge', /Step A must still carry the template/],
        ['the template ahead of the existence check in Step A (#5845)', 'gsd-core/workflows/execute-phase.md', within('**Step A: Persist human verification items', '**Step B: Present to user**', (step) => step.replace('\n', '\nstatus: testing\n')), 'execute-phase-human-needed-uat-merge', /existence check must precede the create-from-template block/],
        ['"keep every recorded result" gone from Step A (#5845)', 'gsd-core/workflows/execute-phase.md', within('**Step A: Persist human verification items', '**Step B: Present to user**', erase(/keep every recorded result/gi)), 'execute-phase-human-needed-uat-merge', /must keep every recorded result/],
        ['"Keep status and started unchanged" gone from Step A (#5845)', 'gsd-core/workflows/execute-phase.md', within('**Step A: Persist human verification items', '**Step B: Present to user**', erase(/Keep `status` and `started` unchanged/g)), 'execute-phase-human-needed-uat-merge', /must keep status and started unchanged/],
        ['"never reset/overwrite/replace" gone from Step A (#5845)', 'gsd-core/workflows/execute-phase.md', within('**Step A: Persist human verification items', '**Step B: Present to user**', erase(/never (reset|overwrite|replace)/gi)), 'execute-phase-human-needed-uat-merge', /must never be reset, overwritten or replaced/],
        ['"not already present" gone from Step A (#5845)', 'gsd-core/workflows/execute-phase.md', within('**Step A: Persist human verification items', '**Step B: Present to user**', erase(/not already present/gi)), 'execute-phase-human-needed-uat-merge', /only items not already present are appended/],
        ['"matched by description" gone from Step A (#5845)', 'gsd-core/workflows/execute-phase.md', within('**Step A: Persist human verification items', '**Step B: Present to user**', erase(/matched by description/gi)), 'execute-phase-human-needed-uat-merge', /items must be matched by description/],
        ['"result: [pending]" gone from Step A (#5845)', 'gsd-core/workflows/execute-phase.md', within('**Step A: Persist human verification items', '**Step B: Present to user**', erase(/result: \[pending\]/g)), 'execute-phase-human-needed-uat-merge', /appended items must be pending/],
        ['the Summary recompute gone from Step A (#5845)', 'gsd-core/workflows/execute-phase.md', within('**Step A: Persist human verification items', '**Step B: Present to user**', erase(/recompute the `## Summary` counts/gi)), 'execute-phase-human-needed-uat-merge', /Summary counts must be recomputed/],
        ['the nothing-to-append rule gone from Step A (#5845)', 'gsd-core/workflows/execute-phase.md', within('**Step A: Persist human verification items', '**Step B: Present to user**', erase(/nothing to append[^.]{0,500}(no write|do not write|skip)[^.]{0,500}commit/gi)), 'execute-phase-human-needed-uat-merge', /nothing to append must mean no write or commit/],
        ['"passed: 0" gone from Step A (#5845)', 'gsd-core/workflows/execute-phase.md', within('**Step A: Persist human verification items', '**Step B: Present to user**', erase(/passed: 0/g)), 'execute-phase-human-needed-uat-merge', /still create the template with passed: 0/],
        ['the original commit message gone from Step A (#5845)', 'gsd-core/workflows/execute-phase.md', within('**Step A: Persist human verification items', '**Step B: Present to user**', eraseAll('test({phase_num}): persist human verification items as UAT')), 'execute-phase-human-needed-uat-merge', /commit with the original message/],
        ['a mv of the old file added to Step A (#5845)', 'gsd-core/workflows/execute-phase.md', within('**Step A: Persist human verification items', '**Step B: Present to user**', (step) => `${step}\nmv old-UAT.md old-UAT.md.bak\n`), 'execute-phase-human-needed-uat-merge', /old file must never be renamed aside/],
        ['"do not rename" gone from Step A (#5845)', 'gsd-core/workflows/execute-phase.md', within('**Step A: Persist human verification items', '**Step B: Present to user**', erase(/do not rename/gi)), 'execute-phase-human-needed-uat-merge', /say not to rename the old file/],
        // secure-phase-single-writer
        ['Write added to the security auditor tools (#2119)', 'agents/gsd-security-auditor.md', (text) => text.replace('  - Read\n', '  - Read\n  - Write\n'), 'secure-phase-single-writer', /Write must not be in auditor tools/],
        ['Edit added to the security auditor tools (#2119)', 'agents/gsd-security-auditor.md', (text) => text.replace('  - Read\n', '  - Read\n  - Edit\n'), 'secure-phase-single-writer', /Edit must not be in auditor tools/],
        ['the security auditor tools list emptied (#2119)', 'agents/gsd-security-auditor.md', (text) => ['Read', 'Bash', 'Glob', 'Grep', 'Skill'].reduce((acc, name) => acc.split(`  - ${name}\n`).join(''), text), 'secure-phase-single-writer', /tools list should be non-empty/],
        ['the security auditor description claims to produce SECURITY.md (#2119)', 'agents/gsd-security-auditor.md', (text) => text.replace('Returns structured', 'Produces SECURITY.md. Returns structured'), 'secure-phase-single-writer', /must not claim to produce SECURITY\.md/],
        ['"Returns structured" gone from the security auditor description (#2119)', 'agents/gsd-security-auditor.md', swap('Returns structured', 'Reports a'), 'secure-phase-single-writer', /should state the auditor returns a structured verdict/],
        ['the security auditor description line gone (#2119)', 'agents/gsd-security-auditor.md', erase(/^description:.*$/m), 'secure-phase-single-writer', /description field must exist/],
        // mvp-phase-spidr
        ...[
          [/in_progress/gi, /reference the in_progress status guard/], [/completed/gi, /reference the completed status guard/], [/--force/gi, /mention the --force override/],
          [/status guard/gi, /name its status guard/], [/as a/gi, /story prompt must ask "As a"/], [/i want to/gi, /ask "I want to"/], [/so that/gi, /ask "So that"/],
          [/## 4\. spidr splitting check/gi, /must define an SPIDR step/], [/spidr-splitting\.md/gi, /reference the SPIDR rules file/], [/\*\*mode:\*\* mvp/gi, /specify the \*\*Mode:\*\* mvp line/],
          [/roadmap\.md/gi, /reference ROADMAP\.md/], [/\*\*goal:\*\*/gi, /update the \*\*Goal:\*\* line/], [/## 7\. delegate to \/gsd:plan-phase/gi, /plan-phase delegation step must be present/],
          [/user-story-template\.md/gi, /reference user-story-template\.md/],
        ].map(([pattern, why]) => [`${pattern} gone from mvp-phase`, 'gsd-core/workflows/mvp-phase.md', erase(pattern), 'mvp-phase-spidr', why]),
        ['the AskUserQuestion prompts gone from mvp-phase', 'gsd-core/workflows/mvp-phase.md', erase(/askuserquestion|vscode_askquestions/gi), 'mvp-phase-spidr', /at least 3 lines for the story prompts/],
        ['plan-phase delegation ahead of the SPIDR step in mvp-phase', 'gsd-core/workflows/mvp-phase.md', (text) => `## 7. Delegate to /gsd:plan-phase\n${text}`, 'mvp-phase-spidr', /plan-phase delegation must come AFTER the SPIDR check/],
        // ui-researcher-inventory-self-check
        ...[['full', 'agents/gsd-ui-researcher.md'], ['compact', 'agents/gsd-ui-researcher.compact.md']].flatMap(([variant, rel]) => [
          [/cross-check/gi, /first tool answer must be cross-checked/], [/\bls\b|filesystem/gi, /cross-check must be a filesystem count/], [/always/gi, /cross-check must be unconditional/],
          [/mismatch|disagree/gi, /mismatched first-tier count must be recorded/], [/No components installed/gi, /zero first-tier count must be recorded/],
          [/package-lock\.json/g, /fall back to package-lock\.json/], [/pnpm-lock\.yaml/g, /must name pnpm-lock\.yaml/], [/yarn\.lock/g, /must name yarn\.lock/],
          [/empty output/gi, /empty output must be a failure/], [/non-zero exit/gi, /non-zero exit must be a failure/], [/undefined/g, /"undefined" must be a failure/],
          [/caret range/gi, /caret range is still not a resolved version/], [/Could not enumerate: <reason>\./g, /could-not-enumerate line must stay/],
        ].map(([pattern, why]) => [`${pattern} gone from the ${variant} UI researcher inventory gate (#4929)`, rel, within('<component_inventory_gate>', '</component_inventory_gate>', erase(pattern)), 'ui-researcher-inventory-self-check', why])),
        ...[['full', 'agents/gsd-ui-researcher.md'], ['compact', 'agents/gsd-ui-researcher.compact.md']].map(([variant, rel]) => [`the lockfile packages entry gone from the ${variant} UI researcher gate (#4929)`, rel, within('<component_inventory_gate>', '</component_inventory_gate>', eraseAll("packages['node_modules/<pkg>']")), 'ui-researcher-inventory-self-check', /lockfile lookup must show the packages entry/]),
        ...[['full', 'agents/gsd-ui-researcher.md'], ['compact', 'agents/gsd-ui-researcher.compact.md']].map(([variant, rel]) => [`the provenance line moved in the ${variant} UI researcher (#4929)`, rel, swap('Enumerated by `<command>` — <N> components', 'Enumerated by `<command>` - <N> components'), 'ui-researcher-inventory-self-check', /recorded-line grammar moved/]),
        ...[['full', 'agents/gsd-ui-researcher.md'], ['compact', 'agents/gsd-ui-researcher.compact.md']].map(([variant, rel]) => [`the inventory gate block renamed in the ${variant} UI researcher (#4929)`, rel, eraseAll('<component_inventory_gate>'), 'ui-researcher-inventory-self-check', /marker .*component_inventory_gate.* not found/]),
        ['the provenance grammar moved in the UI checker (#4929)', 'agents/gsd-ui-checker.md', swap('Enumerated by `<command>` — <N> components', 'Enumerated by `<command>` - <N> components'), 'ui-researcher-inventory-self-check', /Dimension 7 of the checker must quote the same provenance grammar/],
        // init-debug-workflow-contract
        ['a second init.debug call in debug.md (#3149)', 'gsd-core/workflows/debug.md', append('gsd_run query init.debug'), 'init-debug-workflow-contract', /must make exactly one init\.debug round-trip/],
        ['the init.debug call gone from debug.md (#3149)', 'gsd-core/workflows/debug.md', eraseAll('gsd_run query init.debug'), 'init-debug-workflow-contract', /must make exactly one init\.debug round-trip/],
        ['state.load back in debug.md (#3149)', 'gsd-core/workflows/debug.md', append('gsd_run query state.load'), 'init-debug-workflow-contract', /state\.load is replaced by init\.debug/],
        ['resolve-model gsd-debugger back in debug.md (#3149)', 'gsd-core/workflows/debug.md', append('resolve-model gsd-debugger'), 'init-debug-workflow-contract', /debugger_model now rides the init bundle/],
        ['config-get workflow.tdd_mode back in debug.md (#3149)', 'gsd-core/workflows/debug.md', append('config-get workflow.tdd_mode'), 'init-debug-workflow-contract', /tdd_mode now rides the init bundle/],
        ['config.response_language back in debug.md (#2402)', 'gsd-core/workflows/debug.md', append('config.response_language'), 'init-debug-workflow-contract', /response_language is injected at the top level/],
        ['`response_language` gone from debug.md (#3149)', 'gsd-core/workflows/debug.md', eraseAll('`response_language`'), 'init-debug-workflow-contract', /response_language field is still documented/],
        ['the @file: unwrap gone from debug.md (#3149)', 'gsd-core/workflows/debug.md', eraseAll('@file:'), 'init-debug-workflow-contract', /init payloads can spill to a file/],
        ['section_manifest gone from debug.md (#3149)', 'gsd-core/workflows/debug.md', eraseAll('section_manifest'), 'init-debug-workflow-contract', /section_manifest field is documented/],
        ['the null-manifest read-everything rule gone from debug.md (#3149)', 'gsd-core/workflows/debug.md', erase(/`null`[^\r\n]{0,500}read this workflow in full/gi), 'init-debug-workflow-contract', /null section_manifest must be documented as "read everything"/],
        // agent-tracked-source-rule
        ['the tracked_source_paths block gone from plan-phase (#3645)', 'gsd-core/workflows/plan-phase.md', eraseAll('<tracked_source_paths>'), 'agent-tracked-source-rule', /marker .*tracked_source_paths.* not found/],
        ...[
          [/files_modified/g, /block must govern files_modified paths/], [/must_haves/g, /block must govern must_haves paths/], [/git ls-files/g, /block must instruct git ls-files verification/],
          [/\.gsd\/capabilities/g, /block must name the gitignored install-mirror shape/], [/plugins\//g, /block must point at tracked plugin-source fallback locations/],
          [/PATTERNS_PATH/g, /block must cover paths inherited from \{PATTERNS_PATH\}/], [/inherit/g, /block must cover paths inherited from prior phases/],
        ].map(([pattern, why]) => [`${pattern} gone from the plan-phase tracked_source_paths block (#3645)`, 'gsd-core/workflows/plan-phase.md', within('<tracked_source_paths>', '</tracked_source_paths>', erase(pattern)), 'agent-tracked-source-rule', why]),
        ...[
          [/git ls-files/g, /pattern-mapper\.md must verify analog paths via git ls-files/], [/gitignored install\/runtime mirror/g, /mapper must name the gitignored-mirror rejection explicitly/],
          [/never emit mirror paths/g, /must be required to never carry mirror paths/], [/plugins\//g, /mapper must name the plugins\/ tracked-origin fallback location/], [/capabilities\//g, /mapper must name the capabilities\/ tracked-origin fallback location/],
        ].map(([pattern, why]) => [`${pattern} gone from the pattern-mapper (#3645)`, 'agents/gsd-pattern-mapper.md', erase(pattern), 'agent-tracked-source-rule', why]),
        ['"Tracked-source" added to the frozen planner (#3645)', 'agents/gsd-planner.md', append('Tracked-source rule'), 'agent-tracked-source-rule', /belongs in the spawn contract, not the frozen agent file/],
        // discuss-all-flag
        ['--all gone from the discuss-phase argument-hint (#2188)', 'commands/gsd/discuss-phase.md', (text) => text.replace(/^argument-hint:.*$/m, 'argument-hint: "<phase> [--auto]"'), 'discuss-all-flag', /argument-hint should include --all/],
        ['--all gone from the discuss-phase command (#2188)', 'commands/gsd/discuss-phase.md', eraseAll('--all'), 'discuss-all-flag', /command should mention the --all flag/],
        ['--all gone from the discuss-phase workflow (#2188)', 'gsd-core/workflows/discuss-phase.md', eraseAll('--all'), 'discuss-all-flag', /workflow should handle the --all flag/],
        ['--all gone from present_gray_areas (#2188)', 'gsd-core/workflows/discuss-phase.md', inStepOf('present_gray_areas', eraseAll('--all')), 'discuss-all-flag', /present_gray_areas step should handle --all/],
        ['the auto-select wording gone from present_gray_areas (#2188)', 'gsd-core/workflows/discuss-phase.md', inStepOf('present_gray_areas', erase(/Auto-select|auto-select/g)), 'discuss-all-flag', /should auto-select areas when --all is set/],
        ['--all made an auto-advance trigger in auto_advance (#2188)', 'gsd-core/workflows/discuss-phase.md', inStepOf('auto_advance', (step) => `${step}\nIf --all is present, advance to plan-phase.\n`), 'discuss-all-flag', /--all must not trigger auto-advance in the auto_advance step/],
        ['--all gone from the initialize step (#2188)', 'gsd-core/workflows/discuss-phase.md', within('<step name="initialize"', '</step>', eraseAll('--all')), 'discuss-all-flag', /initialize step should document the --all flag/],
        ['the discuss-phase section heading gone from COMMANDS.md (#2188)', 'docs/COMMANDS.md', eraseAll('### `/gsd-discuss-phase`'), 'discuss-all-flag', /marker .*gsd-discuss-phase.* not found/],
        ['--all gone from the discuss-phase section of COMMANDS.md (#2188)', 'docs/COMMANDS.md', within('### `/gsd-discuss-phase`', '\n### ', eraseAll('`--all`')), 'discuss-all-flag', /COMMANDS\.md should document --all in the discuss-phase section/],
        // ui-review-next-guidance
        ['the ui-review Next heading gone (#1528)', 'gsd-core/workflows/ui-review.md', eraseAll('## ▶ Next'), 'ui-review-next-guidance', /marker .*Next.* not found/],
        ['verify-work {N} gone from the ui-review Next block (#1528)', 'gsd-core/workflows/ui-review.md', within('## ▶ Next', '## Automated UI Verification', eraseAll('verify-work {N}')), 'ui-review-next-guidance', /ui-review must route to current-phase UAT/],
        ['plan-phase {N+1} added to the ui-review Next block (#1528)', 'gsd-core/workflows/ui-review.md', within('## ▶ Next', '## Automated UI Verification', (block) => `${block}\nplan-phase {N+1}\n`), 'ui-review-next-guidance', /must not present next-phase planning before current-phase verification passes/],
        ['verify-work {N} duplicated in the ui-review Next block (#1528)', 'gsd-core/workflows/ui-review.md', within('## ▶ Next', '## Automated UI Verification', (block) => `${block}\nverify-work {N}\n`), 'ui-review-next-guidance', /next block must not duplicate verify-work guidance/],
        ['the security-blocked start anchor gone from verify-work (#1528)', 'gsd-core/workflows/verify-work.md', eraseAll('If `SECURITY_FILE` is still empty, stop before phase advancement'), 'ui-review-next-guidance', /marker .*still empty.* not found/],
        ['the security-blocked end anchor gone from verify-work (#1528)', 'gsd-core/workflows/verify-work.md', eraseAll('If `SECURITY_FILE` exists'), 'ui-review-next-guidance', /closing marker .* not found/],
        ['secure-phase {phase} gone from the security-blocked block (#1528)', 'gsd-core/workflows/verify-work.md', within('If `SECURITY_FILE` is still empty, stop before phase advancement', 'If `SECURITY_FILE` exists', eraseAll('secure-phase {phase}')), 'ui-review-next-guidance', /route to the current-phase secure-phase fix/],
        ['plan-phase {next} added to the security-blocked block (#1528)', 'gsd-core/workflows/verify-work.md', within('If `SECURITY_FILE` is still empty, stop before phase advancement', 'If `SECURITY_FILE` exists', (block) => `${block}\nplan-phase {next}\n`), 'ui-review-next-guidance', /must not offer next-phase planning while advancement is blocked/],
        ['execute-phase {next} added to the security-blocked block (#1528)', 'gsd-core/workflows/verify-work.md', within('If `SECURITY_FILE` is still empty, stop before phase advancement', 'If `SECURITY_FILE` exists', (block) => `${block}\nexecute-phase {next}\n`), 'ui-review-next-guidance', /must not offer next-phase execution while advancement is blocked/],
        ['the marked-complete anchor gone from verify-work (#1528)', 'gsd-core/workflows/verify-work.md', eraseAll('Phase {phase} marked complete.'), 'ui-review-next-guidance', /marker .*marked complete.* not found/],
        ['plan-phase {next} gone from the post-completion block (#1528)', 'gsd-core/workflows/verify-work.md', within('Phase {phase} marked complete.', '<step name="scan_phase_artifacts">', eraseAll('plan-phase {next}')), 'ui-review-next-guidance', /post-completion presentation must still offer next-phase planning/],
        ['the manager Compound Action heading gone (#1523)', 'gsd-core/workflows/manager.md', eraseAll('### Compound Action'), 'ui-review-next-guidance', /marker .*Compound Action.* not found/],
        ['the command field gone from the manager compound action (#1523)', 'gsd-core/workflows/manager.md', within('### Compound Action', '### Discuss Phase N', erase(/recommended action's `command`/g)), 'ui-review-next-guidance', /verify recommendations must dispatch through their command field/],
        ['gsd-execute-phase gone from the manager compound action (#1523)', 'gsd-core/workflows/manager.md', within('### Compound Action', '### Discuss Phase N', eraseAll('gsd-execute-phase')), 'ui-review-next-guidance', /compound action must name gsd-execute-phase/],
        ['gsd-verify-work gone from the manager compound action (#1523)', 'gsd-core/workflows/manager.md', within('### Compound Action', '### Discuss Phase N', eraseAll('gsd-verify-work')), 'ui-review-next-guidance', /compound action must name gsd-verify-work/],
        ['an inline verification fence added to the manager compound action (#1523)', 'gsd-core/workflows/manager.md', within('### Compound Action', '### Discuss Phase N', (block) => `${block}\nInline verification:\n\`\`\`\nSkill(skill="gsd-verify-work", args="{PHASE_NUM}")\n\`\`\`\n`), 'ui-review-next-guidance', /must not carry an inline verification fence/],
        // debug-symptoms-prefilled-arguments
        ['the Gather Symptoms heading gone from debug.md (#5012)', 'gsd-core/workflows/debug.md', eraseAll('## 2. Gather Symptoms'), 'debug-symptoms-prefilled-arguments', /marker .*Gather Symptoms.* not found/],
        ['the heading after Step 2 gone from debug.md (#5012)', 'gsd-core/workflows/debug.md', (text) => text.split('\n## ').join('\n### '), 'debug-symptoms-prefilled-arguments', /closing marker .* not found/],
        ['$ARGUMENTS gone from Step 2 (#5012)', 'gsd-core/workflows/debug.md', within('## 2. Gather Symptoms', '\n## ', erase(/\$ARGUMENTS/g)), 'debug-symptoms-prefilled-arguments', /Step 2 must reference \$ARGUMENTS/],
        ['"show it back" gone from Step 2 (#5012)', 'gsd-core/workflows/debug.md', within('## 2. Gather Symptoms', '\n## ', erase(/show it back/gi)), 'debug-symptoms-prefilled-arguments', /showing a supplied value back to the user/],
        ['"instead of asking the open question" gone from Step 2 (#5012)', 'gsd-core/workflows/debug.md', within('## 2. Gather Symptoms', '\n## ', erase(/instead of asking the open question/gi)), 'debug-symptoms-prefilled-arguments', /INSTEAD OF asking the open question/],
        ['the per-field rule gone from Step 2 (#5012)', 'gsd-core/workflows/debug.md', within('## 2. Gather Symptoms', '\n## ', (step) => step.replace(/for each of the five (fields|symptom)/gi, 'x').replace(/each field/gi, 'x')), 'debug-symptoms-prefilled-arguments', /rule must be stated per field/],
        ['"missing" gone from Step 2 (#5012)', 'gsd-core/workflows/debug.md', within('## 2. Gather Symptoms', '\n## ', erase(/missing/gi)), 'debug-symptoms-prefilled-arguments', /fields not supplied in \$ARGUMENTS are still asked/],
        ...[['Expected behavior', /original Expected behavior bullet must survive unchanged/], ['Actual behavior', /original Actual behavior bullet must survive unchanged/], ['Error messages', /original Error messages bullet must survive unchanged/], ['Timeline', /original Timeline bullet must survive unchanged/], ['Reproduction', /original Reproduction bullet must survive unchanged/]].map(([label, why]) => [`the ${label} bullet changed in Step 2 (#5012)`, 'gsd-core/workflows/debug.md', within('## 2. Gather Symptoms', '\n## ', eraseAll(`**${label}**`)), 'debug-symptoms-prefilled-arguments', why]),
        ['"semicolon" gone from Step 2 (#5012)', 'gsd-core/workflows/debug.md', within('## 2. Gather Symptoms', '\n## ', erase(/semicolon/gi)), 'debug-symptoms-prefilled-arguments', /splitting happens on a semicolon that precedes a recognized label/],
        ['the empty-value rule gone from Step 2 (#5012)', 'gsd-core/workflows/debug.md', within('## 2. Gather Symptoms', '\n## ', erase(/empty/gi)), 'debug-symptoms-prefilled-arguments', /label present with an empty value counts as not supplied/],
        ['"skip Steps 2 and 3" gone from debug.md (#5012)', 'gsd-core/workflows/debug.md', eraseAll('skip Steps 2 and 3'), 'debug-symptoms-prefilled-arguments', /Section 1c must still skip Step 2 wholesale/],
        ['a third symptoms_prefilled: true block in debug.md (#5012)', 'gsd-core/workflows/debug.md', append('symptoms_prefilled: true'), 'debug-symptoms-prefilled-arguments', /exactly two session_params spawn blocks/],
        ['one symptoms_prefilled: true block gone from debug.md (#5012)', 'gsd-core/workflows/debug.md', (text) => text.replace('\nsymptoms_prefilled: true\n', '\n'), 'debug-symptoms-prefilled-arguments', /exactly two session_params spawn blocks/],
        // reviewed-or-maintainer-workflow
        ['the workflow no longer valid YAML (#5607)', '.github/workflows/reviewed-or-maintainer.yml', (text) => `${text}\n- [`, 'reviewed-or-maintainer-workflow', /not valid YAML/],
        ['the reviewed-or-maintainer job gone (#5607)', '.github/workflows/reviewed-or-maintainer.yml', yamlEdit((d) => { delete d.jobs['reviewed-or-maintainer']; d.jobs.other = { 'runs-on': 'ubuntu-latest', steps: [] }; }), 'reviewed-or-maintainer-workflow', /no reviewed-or-maintainer job/],
        ['the job renamed (#5607)', '.github/workflows/reviewed-or-maintainer.yml', yamlEdit((d) => { d.jobs['reviewed-or-maintainer'].name = 'Reviewed'; }), 'reviewed-or-maintainer-workflow', /job must be named for the status context it reports/],
        ['a push trigger added (#5607)', '.github/workflows/reviewed-or-maintainer.yml', yamlEdit((d) => { d.on.push = {}; }), 'reviewed-or-maintainer-workflow', /must trigger on target, review and merge_group events only/],
        ['the merge_group trigger gone (#5607)', '.github/workflows/reviewed-or-maintainer.yml', yamlEdit((d) => { delete d.on.merge_group; }), 'reviewed-or-maintainer-workflow', /must trigger on target, review and merge_group events only/],
        ['the review types narrowed (#5607)', '.github/workflows/reviewed-or-maintainer.yml', yamlEdit((d) => { d.on.pull_request_review.types = ['submitted']; }), 'reviewed-or-maintainer-workflow', /must trigger on target, review and merge_group events only/],
        ['the merge_group types changed (#5607)', '.github/workflows/reviewed-or-maintainer.yml', yamlEdit((d) => { d.on.merge_group.types = ['destroyed']; }), 'reviewed-or-maintainer-workflow', /must trigger on target, review and merge_group events only/],
        ['the plain pull_request trigger added (#5607)', '.github/workflows/reviewed-or-maintainer.yml', yamlEdit((d) => { d.on.pull_request = {}; }), 'reviewed-or-maintainer-workflow', /plain pull_request trigger, whose workflow file the PR controls, must never be used/],
        ['a write scope added to the token (#5607)', '.github/workflows/reviewed-or-maintainer.yml', yamlEdit((d) => { d.permissions.contents = 'write'; }), 'reviewed-or-maintainer-workflow', /token must be read-only/],
        ['a job-level permissions block added (#5607)', '.github/workflows/reviewed-or-maintainer.yml', yamlEdit((d) => { d.jobs['reviewed-or-maintainer'].permissions = { contents: 'read' }; }), 'reviewed-or-maintainer-workflow', /token must be read-only/],
        ['the merge_group skip gone (#5607)', '.github/workflows/reviewed-or-maintainer.yml', yamlEdit((d) => { delete d.jobs['reviewed-or-maintainer'].if; }), 'reviewed-or-maintainer-workflow', /job must be skipped on merge_group/],
        ['the checkout moved to the merge ref (#5607)', '.github/workflows/reviewed-or-maintainer.yml', yamlEdit((d) => { d.jobs['reviewed-or-maintainer'].steps.find((s) => String(s.uses).startsWith('actions/checkout@')).with.ref = '${{ github.sha }}'; }), 'reviewed-or-maintainer-workflow', /check out the base sha and persist no credentials/],
        ['credentials persisted by the checkout (#5607)', '.github/workflows/reviewed-or-maintainer.yml', yamlEdit((d) => { d.jobs['reviewed-or-maintainer'].steps.find((s) => String(s.uses).startsWith('actions/checkout@')).with['persist-credentials'] = true; }), 'reviewed-or-maintainer-workflow', /check out the base sha and persist no credentials/],
        ['an action pinned to a tag (#5607)', '.github/workflows/reviewed-or-maintainer.yml', yamlEdit((d) => { d.jobs['reviewed-or-maintainer'].steps.find((s) => String(s.uses).startsWith('actions/checkout@')).uses = 'actions/checkout@v4'; }), 'reviewed-or-maintainer-workflow', /actions must be pinned to a full commit sha/],
        ['a run script interpolating an expression (#5607)', '.github/workflows/reviewed-or-maintainer.yml', yamlEdit((d) => { const s = d.jobs['reviewed-or-maintainer'].steps.find((x) => x.name === 'Evaluate'); s.run = `${s.run}\necho $` + '{{ github.event.pull_request.title }}'; }), 'reviewed-or-maintainer-workflow', /no run: script may interpolate a \$\{\{ \}\} expression/],
        ['PR_AUTHOR_LOGIN no longer from the event (#5607)', '.github/workflows/reviewed-or-maintainer.yml', yamlEdit((d) => { d.jobs['reviewed-or-maintainer'].steps.find((s) => s.name === 'Evaluate').env.PR_AUTHOR_LOGIN = 'someone'; }), 'reviewed-or-maintainer-workflow', /PR-controlled values must reach the policy only through env/],
        ['HEAD_SHA no longer read in the collect step (#5607)', '.github/workflows/reviewed-or-maintainer.yml', yamlEdit((d) => { d.jobs['reviewed-or-maintainer'].steps.find((s) => s.name === 'Evaluate').env.HEAD_SHA = '${{ github.event.pull_request.head.sha }}'; }), 'reviewed-or-maintainer-workflow', /PR-controlled values must reach the policy only through env/],
        ['the [bot] filter gone from the collect step (#5607)', '.github/workflows/reviewed-or-maintainer.yml', yamlEdit((d) => { const s = d.jobs['reviewed-or-maintainer'].steps.find((x) => x.name === 'Collect reviews and reviewer permissions'); s.run = s.run.split('[bot]').join(''); }), 'reviewed-or-maintainer-workflow', /reviewer bots must never be looked up for a role/],
        ['a [bot] suffix admitted by the collect filter (#5607)', '.github/workflows/reviewed-or-maintainer.yml', yamlEdit((d) => { const s = d.jobs['reviewed-or-maintainer'].steps.find((x) => x.name === 'Collect reviews and reviewer permissions'); s.run = `${s.run}\n(\\[bot\\])?$`; }), 'reviewed-or-maintainer-workflow', /reviewer bots must never be looked up for a role/],
        ['the ::warning:: gone from the collect step (#5607)', '.github/workflows/reviewed-or-maintainer.yml', yamlEdit((d) => { const s = d.jobs['reviewed-or-maintainer'].steps.find((x) => x.name === 'Collect reviews and reviewer permissions'); s.run = s.run.split('::warning::').join(''); }), 'reviewed-or-maintainer-workflow', /failed role lookup must be reported/],
        ['the policy script run from a PR path (#5607)', '.github/workflows/reviewed-or-maintainer.yml', yamlEdit((d) => { d.jobs['reviewed-or-maintainer'].steps.find((s) => s.name === 'Evaluate').run = 'node pr/policy.cjs'; }), 'reviewed-or-maintainer-workflow', /policy script must run from the checked-out base/],
        ['the concurrency group shared by queue runs (#5607)', '.github/workflows/reviewed-or-maintainer.yml', yamlEdit((d) => { d.concurrency.group = 'reviewed-or-maintainer'; }), 'reviewed-or-maintainer-workflow', /queue runs must not share one concurrency group/],
        ['the event name gone from the concurrency group (#5607)', '.github/workflows/reviewed-or-maintainer.yml', yamlEdit((d) => { d.concurrency.group = 'x-${{ github.event.pull_request.number || github.ref }}'; }), 'reviewed-or-maintainer-workflow', /event types must not cancel each other/],
        ['the workflow made a required status check on a ruleset (#5607)', '.github/rulesets/next-queue.json', (text) => { const spec = JSON.parse(text); spec.rules.push({ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'Reviewed or maintainer' }] } }); return JSON.stringify(spec, null, 2); }, 'reviewed-or-maintainer-workflow', /must not be a required status check before the trial/],
        ['a ruleset no longer valid JSON (#5607)', '.github/rulesets/next-queue.json', (text) => `${text}}`, 'reviewed-or-maintainer-workflow', /not valid JSON/],
        ['the top-level permissions block gone (#5607)', '.github/workflows/reviewed-or-maintainer.yml', yamlEdit((d) => { delete d.permissions; }), 'reviewed-or-maintainer-workflow', /no top-level permissions block/],
        ['a ruleset without a rules array (#5607)', '.github/rulesets/next-queue.json', () => '{}', 'reviewed-or-maintainer-workflow', /no rules array/],
        ['a required_status_checks rule without its checks list (#5607)', '.github/rulesets/next-queue.json', (text) => { const spec = JSON.parse(text); spec.rules.push({ type: 'required_status_checks' }); return JSON.stringify(spec, null, 2); }, 'reviewed-or-maintainer-workflow', /a required_status_checks rule without its checks list/],
        ['a mv indented 60 spaces in Step A (#5845)', 'gsd-core/workflows/execute-phase.md', within('**Step A: Persist human verification items', '**Step B: Present to user**', (step) => `${step}\n${' '.repeat(60)}mv old-UAT.md old-UAT.md.bak\n`), 'execute-phase-human-needed-uat-merge', /old file must never be renamed aside/],
        ['a git mv with 30 spaces after git in Step A (#5845)', 'gsd-core/workflows/execute-phase.md', within('**Step A: Persist human verification items', '**Step B: Present to user**', (step) => `${step}\ngit${' '.repeat(30)}mv old-UAT.md old-UAT.md.bak\n`), 'execute-phase-human-needed-uat-merge', /old file must never be renamed aside/],
        ['a Track outstanding_debt line with 50 spaces after Track: in step 1.6 (#3782)', 'gsd-core/workflows/progress.md', within('**Step 1.6: Cross-phase health check**', '**Step 1.7:', (step) => `${step}\nTrack:${' '.repeat(50)}\`outstanding_debt\`${' '.repeat(50)}\u2014${' '.repeat(50)}\`summary.total_items\`\n`), 'progress-debt-segmentation-guard', /outstanding_debt must not read the cross-population summary\.total_items/],
        ['an inline verification fence 300 whitespace characters after its label in the manager (#1523)', 'gsd-core/workflows/manager.md', within('### Compound Action', '### Discuss Phase N', (block) => `${block}\nInline verification:${' '.repeat(300)}\`\`\`\nSkill(skill="gsd-verify-work", args="{PHASE_NUM}")\n\`\`\`\n`), 'ui-review-next-guidance', /must not carry an inline verification fence/],
        ['a null pull_request_review trigger (#5607)', '.github/workflows/reviewed-or-maintainer.yml', yamlEdit((d) => { d.on.pull_request_review = null; }), 'reviewed-or-maintainer-workflow', /must trigger on target, review and merge_group events only \(pull_request_review has no configuration\)/],
        ['a null merge_group trigger (#5607)', '.github/workflows/reviewed-or-maintainer.yml', yamlEdit((d) => { d.on.merge_group = null; }), 'reviewed-or-maintainer-workflow', /must trigger on target, review and merge_group events only \(merge_group has no configuration\)/],
        ['a collect step with no run script (#5607)', '.github/workflows/reviewed-or-maintainer.yml', yamlEdit((d) => { delete d.jobs['reviewed-or-maintainer'].steps.find((s) => s.name === 'Collect reviews and reviewer permissions').run; }), 'reviewed-or-maintainer-workflow', /reviewer bots must never be looked up for a role/],
        ['a ruleset that is JSON null (#5607)', '.github/rulesets/next-queue.json', () => 'null', 'reviewed-or-maintainer-workflow', /no rules array/],
        ['a null rule in a ruleset (#5607)', '.github/rulesets/next-queue.json', (text) => { const spec = JSON.parse(text); spec.rules.push(null); return JSON.stringify(spec, null, 2); }, 'reviewed-or-maintainer-workflow', /a rule that is not an object/],
        ['a null entry in a required checks list (#5607)', '.github/rulesets/next-queue.json', (text) => { const spec = JSON.parse(text); spec.rules.push({ type: 'required_status_checks', parameters: { required_status_checks: [null] } }); return JSON.stringify(spec, null, 2); }, 'reviewed-or-maintainer-workflow', /a required status check that is not an object/],
        ['a mv after a form feed in Step A (#5845)', 'gsd-core/workflows/execute-phase.md', within('**Step A: Persist human verification items', '**Step B: Present to user**', (step) => `${step}\n\fmv old-UAT.md old-UAT.md.bak\n`), 'execute-phase-human-needed-uat-merge', /old file must never be renamed aside/],
        ['a mv after a vertical tab in Step A (#5845)', 'gsd-core/workflows/execute-phase.md', within('**Step A: Persist human verification items', '**Step B: Present to user**', (step) => `${step}\n\vmv old-UAT.md old-UAT.md.bak\n`), 'execute-phase-human-needed-uat-merge', /old file must never be renamed aside/],
        ['a git mv separated by a form feed in Step A (#5845)', 'gsd-core/workflows/execute-phase.md', within('**Step A: Persist human verification items', '**Step B: Present to user**', (step) => `${step}\ngit\fmv old-UAT.md old-UAT.md.bak\n`), 'execute-phase-human-needed-uat-merge', /old file must never be renamed aside/],
        // ---- group 3: doc-writer-no-run-mode (both variants, every asserted phrase)
        ...['agents/gsd-doc-writer.md', 'agents/gsd-doc-writer.compact.md'].flatMap((rel) => [
          [`no standalone run mode gone from getting-started in ${rel} (#4928)`, rel, within('<template_getting_started>', '</template_getting_started>', erase(/no\s+standalone\s+run\s+mode/gi)), 'doc-writer-no-run-mode', /getting-started "First run" must fall back to an explicit/],
          [`the build/test fallback gone from getting-started in ${rel} (#4928)`, rel, within('<template_getting_started>', '</template_getting_started>', erase(/build[\s\S]{0,80}test|test[\s\S]{0,80}build/gi)), 'doc-writer-no-run-mode', /must fall back to build\/test first/],
          [`scripts.start gone from getting-started in ${rel} (#4928)`, rel, within('<template_getting_started>', '</template_getting_started>', erase(/scripts\.start/g)), 'doc-writer-no-run-mode', /start scripts are still the first choice in getting-started/],
          [`no standalone run mode gone from the README template in ${rel} (#4928)`, rel, within('<template_readme>', '</template_readme>', erase(/no\s+standalone\s+run\s+mode/gi)), 'doc-writer-no-run-mode', /README "Quick start" and "Usage examples" must not require a literal run command/],
          [`scripts.start gone from the README template in ${rel} (#4928)`, rel, within('<template_readme>', '</template_readme>', erase(/scripts\.start/g)), 'doc-writer-no-run-mode', /start scripts are still the first choice in the README/],
          [`no standalone run mode gone from the per-package README in ${rel} (#4928)`, rel, within('<template_readme_per_package>', '</template_readme_per_package>', erase(/no\s+standalone\s+run\s+mode/gi)), 'doc-writer-no-run-mode', /per-package README "Usage" must state there is no standalone run mode/],
          [`event-triggered handlers gone from the per-package README in ${rel} (#4928)`, rel, within('<template_readme_per_package>', '</template_readme_per_package>', erase(/event|handler|Lambda/gi)), 'doc-writer-no-run-mode', /must name event-triggered handlers/],
          [`fixture gone from the critical rules in ${rel} (#4928)`, rel, within('<critical_rules>', '</critical_rules>', erase(/fixture/gi)), 'doc-writer-no-run-mode', /only presented as working when fixtures exist/],
          [`inputs gone from the critical rules in ${rel} (#4928)`, rel, within('<critical_rules>', '</critical_rules>', erase(/inputs/gi)), 'doc-writer-no-run-mode', /only presented as working when its inputs exist/],
          [`Makefile/package.json script gone from the critical rules in ${rel} (#4928)`, rel, within('<critical_rules>', '</critical_rules>', erase(/Makefile|package\.json script/gi)), 'doc-writer-no-run-mode', /must cover a Makefile target or a package\.json script/],
          [`VERIFY gone from the critical rules in ${rel} (#4928)`, rel, within('<critical_rules>', '</critical_rules>', erase(/VERIFY/g)), 'doc-writer-no-run-mode', /must mark unverifiable claims VERIFY/],
          [`the getting-started section tag renamed in ${rel} (#4928)`, rel, eraseAll('<template_getting_started>'), 'doc-writer-no-run-mode', /marker .*template_getting_started.* not found/],
          [`the README section tag renamed in ${rel} (#4928)`, rel, eraseAll('<template_readme>'), 'doc-writer-no-run-mode', /marker .*template_readme>.* not found/],
          [`the per-package README section tag renamed in ${rel} (#4928)`, rel, eraseAll('<template_readme_per_package>'), 'doc-writer-no-run-mode', /marker .*template_readme_per_package.* not found/],
          [`the critical rules section tag renamed in ${rel} (#4928)`, rel, eraseAll('<critical_rules>'), 'doc-writer-no-run-mode', /marker .*critical_rules.* not found/],
          [`the getting-started closing tag gone in ${rel} (#4928)`, rel, eraseAll('</template_getting_started>'), 'doc-writer-no-run-mode', /closing marker .*template_getting_started.* not found/],
          [`the README closing tag gone in ${rel} (#4928)`, rel, eraseAll('</template_readme>'), 'doc-writer-no-run-mode', /closing marker .*template_readme>.* not found/],
          [`the per-package README closing tag gone in ${rel} (#4928)`, rel, eraseAll('</template_readme_per_package>'), 'doc-writer-no-run-mode', /closing marker .*template_readme_per_package.* not found/],
          [`the critical rules closing tag gone in ${rel} (#4928)`, rel, eraseAll('</critical_rules>'), 'doc-writer-no-run-mode', /closing marker .*critical_rules.* not found/],
        ]),
        // ---- release-finalize-notes-5922
        ['--generate-notes back in the finalize Create GitHub Release step (#5922)', '.github/workflows/release.yml',
          within('      - name: Create GitHub Release\n', '\n      - name:', (step) => step.replace('--latest', '--generate-notes --latest')), 'release-finalize-notes-5922', /must no longer be fed by --generate-notes/],
        ['format-github-release-notes called from the finalize create step (#5922)', '.github/workflows/release.yml',
          within('      - name: Create GitHub Release\n', '\n      - name:', (step) => `${step}\n          node scripts/release-notes/format-github-release-notes.cjs --tag x --apply`), 'release-finalize-notes-5922', /must not call format-github-release-notes/],
        ['the notes built inside the finalize create step (#5922)', '.github/workflows/release.yml',
          within('      - name: Create GitHub Release\n', '\n      - name:', (step) => `${step}\n          node scripts/release-notes/changelog-release-notes.cjs --version x`), 'release-finalize-notes-5922', /only publishes: it must not build the notes/],
        ['the create step reads another notes file (#5922)', '.github/workflows/release.yml',
          within('      - name: Create GitHub Release\n', '\n      - name:', swap('--notes-file "${RUNNER_TEMP}/release-notes.md"', '--notes-file "other.md"')), 'release-finalize-notes-5922', /must consume the notes from the same path/],
        ['the build step writes another notes file (#5922)', '.github/workflows/release.yml',
          swap('--output "${RUNNER_TEMP}/release-notes.md"', '--output "other.md"'), 'release-finalize-notes-5922', /must write the notes file the create step reads/],
        ['the finalize create step renamed (#5922)', '.github/workflows/release.yml',
          swap('      - name: Create GitHub Release\n', '      - name: Publish GitHub Release\n'), 'release-finalize-notes-5922', /must have a "Create GitHub Release" step with a run script/],
        ['the finalize build step renamed (#5922)', '.github/workflows/release.yml',
          swap('      - name: Build GitHub Release notes\n', '      - name: Make the notes\n'), 'release-finalize-notes-5922', /must have a "Build GitHub Release notes" step/],
        ['the notes built after the tag and publish steps (#5922)', '.github/workflows/release.yml',
          (text) => text.replace('- name: Build GitHub Release notes', '- name: @@').replace('- name: Publish to npm (latest)', '- name: Build GitHub Release notes').replace('- name: @@', '- name: Publish to npm (latest)'), 'release-finalize-notes-5922', /must be built before Tag and push/],
        ['the notes built after the npm publish step (#5922)', '.github/workflows/release.yml',
          (text) => text.replace('- name: Build GitHub Release notes', '- name: @@').replace('- name: Publish to npm (latest)', '- name: Build GitHub Release notes').replace('- name: @@', '- name: Publish to npm (latest)'), 'release-finalize-notes-5922', /must be built before the npm publish/],
        ['the notes built before the CHANGELOG is promoted (#5922)', '.github/workflows/release.yml',
          (text) => text.replace('- name: Verify CHANGELOG promoted', '- name: @@').replace('- name: Build GitHub Release notes', '- name: Verify CHANGELOG promoted').replace('- name: @@', '- name: Build GitHub Release notes'), 'release-finalize-notes-5922', /must be built from the promoted CHANGELOG/],
        ['a dry_run guard on the build step (#5922)', '.github/workflows/release.yml',
          swap('      - name: Build GitHub Release notes\n', '      - name: Build GitHub Release notes\n        if: ${{ !inputs.dry_run }}\n'), 'release-finalize-notes-5922', /must have no dry_run guard/],
        ['the rc pre-release step loses --generate-notes (#5922)', '.github/workflows/release.yml',
          within('      - name: Create GitHub pre-release\n', '\n      - name:', erase(/--generate-notes/g)), 'release-finalize-notes-5922', /rc job \(X\.Y\.0 only, hotfix rcs are rejected\) must keep GitHub-generated notes/],
        ['the rc pre-release step renamed (#5922)', '.github/workflows/release.yml',
          swap('      - name: Create GitHub pre-release\n', '      - name: Create GitHub prerelease\n'), 'release-finalize-notes-5922', /rc job \(X\.Y\.0 only, hotfix rcs are rejected\) must keep GitHub-generated notes/],
        ['the "Verify CHANGELOG promoted" step renamed (#5922)', '.github/workflows/release.yml',
          swap('      - name: Verify CHANGELOG promoted\n', '      - name: Check the CHANGELOG\n'), 'release-finalize-notes-5922', /must be built from the promoted CHANGELOG, after the "Verify CHANGELOG promoted" step/],
        ['release.yml no longer valid YAML (#5922)', '.github/workflows/release.yml', (text) => `: [\n${text}`, 'release-finalize-notes-5922', /release\.yml is not valid YAML/],
        ['the jobs key gone from release.yml (#5922)', '.github/workflows/release.yml',
          yamlEdit((workflow) => { delete workflow.jobs; }), 'release-finalize-notes-5922', /must have a "Create GitHub Release" step with a run script/],
        ['the finalize job gone from release.yml (#5922)', '.github/workflows/release.yml',
          yamlEdit((workflow) => { delete workflow.jobs.finalize; }), 'release-finalize-notes-5922', /must have a "Build GitHub Release notes" step/],
        ['the rc job gone from release.yml (#5922)', '.github/workflows/release.yml',
          yamlEdit((workflow) => { delete workflow.jobs.rc; }), 'release-finalize-notes-5922', /rc job \(X\.Y\.0 only, hotfix rcs are rejected\) must keep GitHub-generated notes/],
        // Malformed structures are findings, not exceptions that end the contract after one finding.
        ['a null step in the finalize job of release.yml (#5922)', '.github/workflows/release.yml',
          yamlEdit((workflow) => { workflow.jobs.finalize.steps.splice(1, 0, null); }), 'release-finalize-notes-5922', /finalize\.steps\[1\] is not a mapping/],
        ['a null step in the rc job of release.yml (#5922)', '.github/workflows/release.yml',
          yamlEdit((workflow) => { workflow.jobs.rc.steps.splice(0, 0, null); }), 'release-finalize-notes-5922', /rc\.steps\[0\] is not a mapping/],
        ['the finalize steps no longer a list in release.yml (#5922)', '.github/workflows/release.yml',
          yamlEdit((workflow) => { workflow.jobs.finalize.steps = 'x'; }), 'release-finalize-notes-5922', /finalize\.steps is not a list/],
        ['the rc steps no longer a list in release.yml (#5922)', '.github/workflows/release.yml',
          yamlEdit((workflow) => { workflow.jobs.rc.steps = { not: 'a list' }; }), 'release-finalize-notes-5922', /rc\.steps is not a list/],
        ['the finalize job null in release.yml (#5922)', '.github/workflows/release.yml',
          yamlEdit((workflow) => { workflow.jobs.finalize = null; }), 'release-finalize-notes-5922', /finalize is not a mapping/],
        ['the rc job null in release.yml (#5922)', '.github/workflows/release.yml',
          yamlEdit((workflow) => { workflow.jobs.rc = null; }), 'release-finalize-notes-5922', /rc is not a mapping/],
        ['the finalize job a list in release.yml (#5922)', '.github/workflows/release.yml',
          yamlEdit((workflow) => { workflow.jobs.finalize = ['x']; }), 'release-finalize-notes-5922', /finalize is not a mapping/],
        ['the jobs key null in release.yml (#5922)', '.github/workflows/release.yml',
          yamlEdit((workflow) => { workflow.jobs = null; }), 'release-finalize-notes-5922', /jobs is not a mapping/],
        ['release.yml a list instead of a mapping (#5922)', '.github/workflows/release.yml', () => '- a\n- b\n', 'release-finalize-notes-5922', /release\.yml is not a mapping/],
        ['release.yml a scalar instead of a mapping (#5922)', '.github/workflows/release.yml', () => 'just text\n', 'release-finalize-notes-5922', /release\.yml is not a mapping/],
        ['package.json null instead of an object (#1852)', 'package.json', () => 'null', 'package-manifest', /package\.json is not a JSON object/],
        ['package.json an array instead of an object (#1852)', 'package.json', () => '[]', 'package-manifest', /package\.json is not a JSON object/],
        ['package.json files a string instead of an array (#1852)', 'package.json',
          (text) => { const pkg = JSON.parse(text); pkg.files = 'hooks'; return JSON.stringify(pkg, null, 2); }, 'package-manifest', /package\.json has no "files" array/],
        // The manifest-schema section ends at the next `###` heading too: the words only after a sibling heading do not count.
        ...[
          [/contract/gi, 'contract', /manifest must be framed as a stability contract/],
          [/find .planning\/async-jobs|grep -lE/g, 'grep -lE', /glob-safe matching probe must be documented/],
          [/2>\/dev\/null|\|\| true/g, '|| true', /probe must be null-safe/],
          [/untrusted/gi, 'untrusted', /schema must state manifest commands are untrusted/],
          [/confirm/gi, 'confirm', /user confirmation must be required before executing manifest commands/],
          [/exact `?plan_id`?|match.{0,20}plan_id/gi, 'exact plan_id', /schema must specify exact plan_id matching/],
          [/fail closed|fail-closed/gi, 'fail closed', /fail-closed must be required on multiple or malformed manifests/],
          [/every dispatch path/gi, 'every dispatch path', /discovery must exclude waiting plans beyond has_summary/],
        ].map(([pattern, sample, why]) => [`${pattern} only after a sibling ### heading of the manifest-schema section (#1165)`, 'docs/reference/planning-artifacts.md',
          (text) => within('### `.planning/async-jobs/<job>.json`', '\n## ', erase(pattern))(text).replace('\n## Naming conventions', `\n### Sibling\n${sample}\n\n## Naming conventions`), 'external-job-waiting', why]),
        // ---- check-predicate-dispatch-phase-flags-4483
        ...[
          ['execute-phase/steps/verify-phase-goal.md', ['--phase-dir', '--phase-number']],
          ['plan-phase.md', ['--phase-dir', '--phase-number', '--phase-req-ids']],
          ['plan-phase/steps/plan-pre-dispatch.md', ['--phase-dir', '--phase-number', '--phase-req-ids']],
          ['ship.md', ['--phase-dir', '--phase-number']],
          ['verify-work.md', ['--phase-dir', '--phase-number']],
          ['execute-phase/steps/wave-post-gate-hooks.md', ['--phase-dir', '--phase-number']],
          ['execute-phase/steps/pre-execute-gate-hooks.md', ['--phase-dir', '--phase-number']],
        ].flatMap(([file, flags]) => [
          ...flags.map((flag) => [`${flag} dropped from the check predicate dispatch of ${file} (#4483)`, `gsd-core/workflows/${file}`,
            (text) => text.split('\n').map((line) => (line.includes('gsd_run check predicate') ? line.split(`${flag} "`).join('--other "') : line)).join('\n'),
            'check-predicate-dispatch-phase-flags-4483', ({ '--phase-dir': /dispatch omits --phase-dir "\$\{PHASE_DIR\}"/, '--phase-number': /dispatch omits --phase-number "\$\{PHASE_NUMBER\}"/, '--phase-req-ids': /dispatch omits --phase-req-ids "\$\{PHASE_REQ_IDS\}"/ })[flag]]),
          [`every check predicate dispatch gone from ${file} (#4483)`, `gsd-core/workflows/${file}`, eraseAll('gsd_run check predicate'), 'check-predicate-dispatch-phase-flags-4483', /no check predicate dispatch line found/],
        ]),
        ['an unlisted workflow dispatches check predicate (#4483)', 'gsd-core/workflows/transition.md', append('gsd_run check predicate --id x'), 'check-predicate-dispatch-phase-flags-4483', /a new check predicate dispatch site must be added to DISPATCHES/],
        ['verify-work no longer assigns PHASE_DIR (#5289)', 'gsd-core/workflows/verify-work.md', eraseAll('PHASE_DIR=$('), 'check-predicate-dispatch-phase-flags-4483', /PHASE_DIR must be assigned before the dispatch/],
        ['verify-work assigns PHASE_DIR only after the dispatch (#5289)', 'gsd-core/workflows/verify-work.md',
          (text) => `${eraseAll('PHASE_DIR=$(')(text)}\nPHASE_DIR=$(x)\n`, 'check-predicate-dispatch-phase-flags-4483', /PHASE_DIR must be assigned before the dispatch/],
        ['verify-work no longer assigns PHASE_NUMBER from the init JSON (#5289)', 'gsd-core/workflows/verify-work.md', eraseAll("PHASE_NUMBER=$(printf '%s' \"$INIT\""), 'check-predicate-dispatch-phase-flags-4483', /PHASE_NUMBER must be assigned from the init JSON before the dispatch/],
        // ---- package-manifest
        ['hooks/dist back in package.json files (#1852)', 'package.json',
          (text) => { const pkg = JSON.parse(text); pkg.files.push('hooks/dist'); return JSON.stringify(pkg, null, 2); }, 'package-manifest', /"hooks\/dist" must not appear alone in package\.json "files"/],
        ['hooks gone from package.json files (#1852)', 'package.json',
          (text) => { const pkg = JSON.parse(text); pkg.files = pkg.files.filter((entry) => entry !== 'hooks'); return JSON.stringify(pkg, null, 2); }, 'package-manifest', /"hooks" must be listed in package\.json "files"/],
        ['package.json without a files array (#1852)', 'package.json',
          (text) => { const pkg = JSON.parse(text); delete pkg.files; return JSON.stringify(pkg, null, 2); }, 'package-manifest', /package\.json has no "files" array/],
        ['package.json no longer valid JSON (#1852)', 'package.json', (text) => `${text}}`, 'package-manifest', /package\.json is not valid JSON/],
        // ---- ship-note
        ['the ship-note push gone from track_shipping (#2138)', 'gsd-core/workflows/ship.md', within('<step name="track_shipping">', '</step>', erase(/git push origin \$\{CURRENT_BRANCH\}/g)), 'ship-note', /must push the ship-note commit onto the PR branch/],
        ['the [ci skip] trailer gone from track_shipping (#2138)', 'gsd-core/workflows/ship.md', within('<step name="track_shipping">', '</step>', erase(/\[ci skip\]|\[skip ci\]/g)), 'ship-note', /must carry a \[ci skip\] trailer/],
        ['the wedged-PR handling gone from track_shipping (#2783)', 'gsd-core/workflows/ship.md', within('<step name="track_shipping">', '</step>', erase(/mergeStateStatus|BLOCKED|trigger CI/g)), 'ship-note', /self-healing or check handling for wedged PRs/],
        ['the phase + PR-number ship-note gone from track_shipping (#2138)', 'gsd-core/workflows/ship.md', within('<step name="track_shipping">', '</step>', erase(/ship phase \$\{PHASE_NUMBER\}[^\n]{0,500}PR #\$\{PR_NUMBER\}/g)), 'ship-note', /must still commit the phase \+ PR-number ship-note into STATE/],
        ['the activity-line update gone from track_shipping (#5165)', 'gsd-core/workflows/ship.md',
          within('<step name="track_shipping">', '</step>', erase(/state\.update \$\{GSD_WS:\+--ws=\$\{GSD_WS##\* \}\} "Last Activity" "\$\(date \+%Y-%m-%d\) -- Phase \$\{PHASE_NUMBER\} shipped as PR #\$\{PR_NUMBER\}"/g)), 'ship-note', /activity line must carry the phase \+ PR description/],
        ['a Status update back in track_shipping (#5165)', 'gsd-core/workflows/ship.md', within('<step name="track_shipping">', '</step>', (step) => `${step}\nstate.update "Status" "shipped"\n`), 'ship-note', /must write the activity line only, no Status/],
        ['the track_shipping step renamed (#2138)', 'gsd-core/workflows/ship.md', swap('<step name="track_shipping">', '<step name="track">'), 'ship-note', /marker .*track_shipping.* not found/],
        // ---- external-job-waiting
        ...[
          ['gsd-core/workflows/execute-plan.md', /only legal half-state is mid-production-commits/g, /sync invariant \(bug-3212\) must be preserved/],
          ['gsd-core/workflows/execute-plan.md', /\.planning\/async-jobs\//g, /invariant must reference the async-job manifest path/],
          ['gsd-core/workflows/execute-plan.md', /legal deferred/gi, /described as a legal deferred state/],
          ['gsd-core/workflows/execute-plan.md', /external_job_waiting/g, /the invariant must name the external_job_waiting half-state/],
          ['gsd-core/workflows/execute-plan.md', /async-jobs/g, /plan selection must reference the manifest/],
          ['gsd-core/workflows/execute-plan.md', /skip|exclude/gi, /must skip or exclude waiting plans/],
          ['gsd-core/workflows/execute-phase.md', /<step name="safe_resume_gate"/g, /safe_resume_gate step must exist/],
          ['gsd-core/workflows/execute-phase.md', /SUMMARY.md is missing/g, /existing illegal-partial branch must be preserved/],
          ['gsd-core/workflows/execute-phase.md', /async-jobs/g, /gate must reference async-job manifests/],
          ['gsd-core/workflows/execute-phase.md', /external_job_waiting/g, /gate must name the legal half-state/],
          ['gsd-core/workflows/execute-phase.md', /never re-?dispatch/gi, /gate must forbid re-dispatch/],
          ['gsd-core/workflows/execute-phase.md', /planning-artifacts/g, /gate must point to the manifest contract reference/],
          ['gsd-core/workflows/resume-project.md', /async-jobs/g, /resume must probe async-job manifests/],
          ['gsd-core/workflows/resume-project.md', /external_job_waiting/g, /resume must recognise the half-state/],
          ['gsd-core/workflows/resume-project.md', /completed-unverified/g, /resume must handle the completed-unverified state/],
          ['gsd-core/workflows/resume-project.md', /verif/gi, /completed jobs require verification before close/],
          ['gsd-core/workflows/pause-work.md', /async/gi, /pause gather must mention async external jobs/],
          ['gsd-core/workflows/pause-work.md', /async_jobs|async-jobs/g, /HANDOFF must record async job manifests/],
          ['docs/reference/planning-artifacts.md', /### `\.planning\/async-jobs\/<job>\.json`/g, /marker .*async-jobs.* not found/],
          ['docs/reference/planning-artifacts.md', /contract/gi, /manifest must be framed as a stability contract/],
          ['docs/reference/planning-artifacts.md', /find .planning\/async-jobs|grep -lE/g, /glob-safe matching probe must be documented/],
          ['docs/reference/planning-artifacts.md', /2>\/dev\/null|\|\| true/g, /probe must be null-safe/],
          ['docs/reference/planning-artifacts.md', /untrusted|confirm/gi, /must be surfaced or confirmed, not auto-run/],
          ['docs/reference/planning-artifacts.md', /fail closed|fail-closed|surface the conflict/gi, /multiple or malformed manifests must fail closed/],
          ['docs/reference/planning-artifacts.md', /untrusted/gi, /schema must state manifest commands are untrusted/],
          ['docs/reference/planning-artifacts.md', /confirm/gi, /user confirmation must be required before executing manifest commands/],
          ['docs/reference/planning-artifacts.md', /exact `?plan_id`?|match.{0,20}plan_id/gi, /schema must specify exact plan_id matching/],
          ['docs/reference/planning-artifacts.md', /fail closed|fail-closed/gi, /fail-closed must be required on multiple or malformed manifests/],
          ['docs/reference/planning-artifacts.md', /every dispatch path/gi, /discovery must exclude waiting plans beyond has_summary/],
          ['CONTEXT.md', /external_job_waiting|External-job-waiting/g, /glossary must define the external_job_waiting domain term/],
          ['CONTEXT.md', /async-jobs/g, /glossary entry must reference the manifest/],
        ].map(([rel, pattern, why]) => [`${pattern} gone from ${rel} (#1165)`, rel, erase(pattern), 'external-job-waiting', why]),
        // The manifest-schema section must carry these words itself: a copy of the word elsewhere on the page does not count.
        ...[
          [/contract/gi, 'contract', /manifest must be framed as a stability contract/],
          [/find .planning\/async-jobs|grep -lE/g, 'grep -lE', /glob-safe matching probe must be documented/],
          [/2>\/dev\/null|\|\| true/g, '|| true', /probe must be null-safe/],
          [/untrusted/gi, 'untrusted', /schema must state manifest commands are untrusted/],
          [/confirm/gi, 'confirm', /user confirmation must be required before executing manifest commands/],
          [/exact `?plan_id`?|match.{0,20}plan_id/gi, 'exact plan_id', /schema must specify exact plan_id matching/],
          [/fail closed|fail-closed/gi, 'fail closed', /fail-closed must be required on multiple or malformed manifests/],
          [/every dispatch path/gi, 'every dispatch path', /discovery must exclude waiting plans beyond has_summary/],
        ].map(([pattern, sample, why]) => [`${pattern} only outside the manifest-schema section of planning-artifacts.md (#1165)`, 'docs/reference/planning-artifacts.md',
          (text) => `${sample}\n${within('### `.planning/async-jobs/<job>.json`', '\n## ', erase(pattern))(text)}`, 'external-job-waiting', why]),
        // ---- partial-init-routing
        ['init_incomplete gone from progress.md (#4040)', 'gsd-core/workflows/progress.md', eraseAll('init_incomplete'), 'partial-init-routing', /progress\.md must branch on init_incomplete/],
        ['the Route F definition gone from progress.md (#4040)', 'gsd-core/workflows/progress.md', eraseAll('Route F: Between milestones'), 'partial-init-routing', /Route F definition must exist/],
        ['Route F ahead of the init_incomplete recovery branch in progress.md (#4040)', 'gsd-core/workflows/progress.md', (text) => `Route F: Between milestones\n${text}`, 'partial-init-routing', /recovery branch must appear before the Route F \(between milestones\) definition/],
        ...['REQUIREMENTS.md', 'ROADMAP.md', 'STATE.md'].map((name) => [`${name} gone from the init_incomplete recovery branch of progress.md (#4040)`, 'gsd-core/workflows/progress.md',
          (text) => { const at = text.indexOf('init_incomplete'); return text.slice(0, at) + text.slice(at, at + 1200).split(name).join('') + text.slice(at + 1200); },
          'partial-init-routing', /recovery branch must name the missing REQUIREMENTS\.md \/ ROADMAP\.md \/ STATE\.md artifacts/]),
        ['new-project gone from the init_incomplete recovery branch of progress.md (#4040)', 'gsd-core/workflows/progress.md',
          (text) => { const at = text.indexOf('init_incomplete'); return text.slice(0, at) + text.slice(at, at + 1200).split('new-project').join('') + text.slice(at + 1200); }, 'partial-init-routing', /recovery branch must route to \/gsd:new-project/],
        ['the no-planning branch gone from progress.md (#4040)', 'gsd-core/workflows/progress.md', eraseAll('No planning structure found'), 'partial-init-routing', /no-planning branch must exist/],
        ['planning_exists gone from before the no-planning branch of progress.md (#4040)', 'gsd-core/workflows/progress.md',
          (text) => { const at = text.indexOf('No planning structure found'); const from = Math.max(0, at - 600); return text.slice(0, from) + text.slice(from, at).split('planning_exists').join('') + text.slice(at); },
          'partial-init-routing', /no-planning branch must check planning_exists/],
        ['init_incomplete gone from resume-project.md (#4040)', 'gsd-core/workflows/resume-project.md', eraseAll('init_incomplete'), 'partial-init-routing', /resume-project\.md must branch on init_incomplete/],
        ['the STATE reconstruction branch gone from resume-project.md (#4040)', 'gsd-core/workflows/resume-project.md', eraseAll('Offer to reconstruct STATE.md'), 'partial-init-routing', /STATE reconstruction branch must exist/],
        ['the reconstruction branch ahead of the recovery branch in resume-project.md (#4040)', 'gsd-core/workflows/resume-project.md', (text) => `Offer to reconstruct STATE.md\n${text}`, 'partial-init-routing', /recovery branch must appear before the reconstruct-STATE\.md branch/],
        ['init_incomplete gone from the resume parse list (#4040)', 'gsd-core/workflows/resume-project.md',
          (text) => { const at = text.indexOf('Parse JSON for'); return text.slice(0, at) + text.slice(at, at + 400).split('init_incomplete').join('') + text.slice(at + 400); }, 'partial-init-routing', /resume parse list must include init_incomplete/],
        ['the project_exists gate gone from new-project.md (#4040)', 'gsd-core/workflows/new-project.md', (text) => text.split('project_already').join('').split('If `project_exists` is true').join(''), 'partial-init-routing', /project_exists gate must exist/],
        ['init_incomplete gone from the new-project project_exists gate (#4040)', 'gsd-core/workflows/new-project.md',
          (text) => { const named = text.indexOf('project_already'); const at = named > -1 ? named : text.indexOf('If `project_exists` is true'); return text.slice(0, at) + text.slice(at, at + 1500).split('init_incomplete').join('') + text.slice(at + 1500); },
          'partial-init-routing', /project_exists gate must discriminate on init_incomplete/],
        // ---- debugger-repro-hardening
        ['the repro-hardening @-include gone from gsd-debugger (#1962)', 'agents/gsd-debugger.md', eraseAll('@~/.claude/gsd-core/references/debugger-repro-hardening.md'), 'debugger-repro-hardening', /gsd-debugger\.md must @-include the repro-hardening reference/],
        ...[
          [/shrink/gi, /must document shrinking/], [/fast-check/gi, /must name fast-check/], [/hypothesis/gi, /must name Hypothesis/], [/minimi[sz]/gi, /must reference minimization/],
          [/regression seed|store[^\n]{0,500}minimi|minimi[^\n]{0,500}store/gi, /stored as the regression seed/], [/no PBT framework/gi, /degradation when no PBT framework is present/],
          [/manual minimi/gi, /fall back to manual minimization/], [/specified/gi, /oracle type "specified" must be named/], [/derived/gi, /oracle type "derived" \(contract\/model\) must be named/],
          [/metamorphic/gi, /oracle type "metamorphic" must be named/], [/implicit/gi, /oracle type "implicit" \(crash\) must be named/],
          [/implicit[^\n]{0,500}(?:crash|weakest|weaker)|(?:crash|weakest|weaker)[^\n]{0,500}implicit/gi, /flag implicit\/crash as the weakest oracle/],
          [/off-by-one|off by one|n\s{0,20}[+-]\s{0,20}1/gi, /off-by-one \(N\+-1\) must be documented/], [/min\/max|empty\/singleton/gi, /min\/max or empty\/singleton must be documented/],
          [/equivalence class/gi, /tied to the fixed defect's equivalence class/], [/root[\s-]?cause check/gi, /root-cause check/],
        ].map(([pattern, why]) => [`${pattern} gone from the repro-hardening reference (#1962)`, 'gsd-core/references/debugger-repro-hardening.md', erase(pattern), 'debugger-repro-hardening', why]),
        ['oracle_type gone from the DEBUG.md template (#1962)', 'gsd-core/templates/DEBUG.md', eraseAll('oracle_type'), 'debugger-repro-hardening', /DEBUG\.md Resolution must carry an oracle_type field/],
        // ---- thread-session-management
        ...[
          [/list --open|LIST-OPEN/g, /missing the list --open filter/], [/CLOSE|close <slug>/g, /missing the close subcommand/], [/STATUS|status <slug>/g, /missing the status subcommand/],
          [/status: open/g, /missing the frontmatter status field/], [/security_notes/g, /missing the security_notes section/], [/sanitiz|\[a-z0-9/g, /missing slug sanitization/],
          [/Write tool/g, /should use the Write tool instead of a heredoc/], [/frontmatter get|frontmatter\.get/g, /read the status via frontmatter get/], [/resolved/g, /close mode should set the status to resolved/],
          [/list --resolved|LIST-RESOLVED/g, /missing the list --resolved filter/], [/reject/g, /missing path traversal rejection for slugs/], [/slug:/g, /missing the slug frontmatter field/],
          [/title:/g, /missing the title frontmatter field/], [/status:/g, /missing the status frontmatter field/], [/created:/g, /missing the created frontmatter field/], [/updated:/g, /missing the updated frontmatter field/],
        ].map(([pattern, why]) => [`${pattern} gone from the thread workflow (#2156)`, 'gsd-core/workflows/thread.md', erase(pattern), 'thread-session-management', why]),
        ['a quoted heredoc back in the thread workflow (#2156)', 'gsd-core/workflows/thread.md', append("cat > f << 'EOF'"), 'thread-session-management', /still uses a quoted heredoc: injection risk/],
        ['a heredoc back in the thread workflow (#2156)', 'gsd-core/workflows/thread.md', append('cat > f << EOF'), 'thread-session-management', /still uses a heredoc: injection risk/],
        // ---- context7-tool-name-parity
        ['get-library-docs back in an agent (#2943)', 'agents/gsd-planner.md', append('Call mcp__context7__get-library-docs to fetch docs.'), 'context7-tool-name-parity', /must not instruct agents to call mcp__context7__get-library-docs/],
        ['get-library-docs back in a nested workflow file (#2943)', 'gsd-core/workflows/plan-phase/steps/auto-advance-check.md', append('Call mcp__context7__get-library-docs to fetch docs.'), 'context7-tool-name-parity', /must not instruct agents to call mcp__context7__get-library-docs/],
        ['get-library-docs back in a docs page (#2943)', 'docs/COMMANDS.md', append('Call mcp__context7__get-library-docs to fetch docs.'), 'context7-tool-name-parity', /must not instruct agents to call mcp__context7__get-library-docs/],
        ['get-library-docs back in a command (#2943)', 'commands/gsd/new-project.md', append('Call mcp__context7__get-library-docs to fetch docs.'), 'context7-tool-name-parity', /must not instruct agents to call mcp__context7__get-library-docs/],
        ['get-library-docs back in a skill (#2943)', 'skills/gsd-new-project/SKILL.md', append('Call mcp__context7__get-library-docs to fetch docs.'), 'context7-tool-name-parity', /must not instruct agents to call mcp__context7__get-library-docs/],
        ['get-library-docs back in a reference (#2943)', 'gsd-core/references/verify-mvp-mode.md', append('Call mcp__context7__get-library-docs to fetch docs.'), 'context7-tool-name-parity', /must not instruct agents to call mcp__context7__get-library-docs/],
        ['query-docs gone from the canonical lookup reference (#2943)', 'gsd-core/references/research-documentation-lookup.md', eraseAll('mcp__context7__query-docs'), 'context7-tool-name-parity', /research-documentation-lookup\.md must name mcp__context7__query-docs/],
        ['the libraryId / query params gone from the canonical lookup reference (#2943)', 'gsd-core/references/research-documentation-lookup.md', erase(/query-docs` with `libraryId`|libraryId` and `query`/g), 'context7-tool-name-parity', /query-docs must be documented with the libraryId \/ query params/],
        // ---- debugger-prevention
        ['the prevention @-include gone from gsd-debugger (#1963)', 'agents/gsd-debugger.md', eraseAll('@~/.claude/gsd-core/references/debugger-prevention.md'), 'debugger-prevention', /gsd-debugger\.md must @-include the prevention reference/],
        ['why_not_caught gone from gsd-debugger (#1963)', 'agents/gsd-debugger.md', erase(/why.not.caught/gi), 'debugger-prevention', /KB entry format must include a why_not_caught field/],
        ['recurrence_guard gone from gsd-debugger (#1963)', 'agents/gsd-debugger.md', erase(/recurrence.guard/gi), 'debugger-prevention', /KB entry format must include a recurrence_guard field/],
        ['the Phase 0 block renamed in gsd-debugger (#1963)', 'agents/gsd-debugger.md', eraseAll('**Phase 0: Check knowledge base**'), 'debugger-prevention', /Phase 0 Evidence line must include why_not_caught \+ recurrence_guard/],
        ...[
          [/5-?\s*whys|five whys|causal chain/gi, /must document a 5-Whys causal chain/], [/blame|blameless|blame-free/gi, /chain is blame-free/], [/branch/gi, /postmortem must branch/],
          [/single[\s-]?cause|agent error|why was that (?:error|possible)/gi, /must treat "agent error" as a prompt/],
          [/why (?:wasn'?t|was not|didn'?t)[^\n]{0,500}(?:caught|prevent)|why[\s-]?not[\s-]?caught/gi, /must document the "why wasn't this caught\?" question/],
          [/recurrence guard|recurrence-guard/gi, /must name the recurrence guard/], [/regression test/gi, /guard option "regression test" must be named/], [/lint rule|assertion|precondition/gi, /lint rule \/ assertion \/ precondition must be named/],
          [/backward|back.compat|old entries|without[^\n]{0,500}fields[^\n]{0,500}load|absent[^\n]{0,500}field/gi, /old KB entries without the new fields still load/],
          [/not an incident-management subsystem/gi, /prevention block adds no subsystem/], [/reuses the existing/gi, /reuses the existing debug file \+ knowledge base/],
        ].map(([pattern, why]) => [`${pattern} gone from the prevention reference (#1963)`, 'gsd-core/references/debugger-prevention.md', erase(pattern), 'debugger-prevention', why]),
        ['the prevention summary gone from the session manager (#1963)', 'agents/gsd-debug-session-manager.md', erase(/recurrence guard|why not caught/gi), 'debugger-prevention', /session manager compact summary must surface the prevention summary/],
        ['why_not_caught gone from the Phase 0 block (#1963)', 'agents/gsd-debugger.md',
          (text) => { const at = text.indexOf('**Phase 0: Check knowledge base**'); return text.slice(0, at) + text.slice(at, at + 1600).replace(/why.?not.?caught/gi, '') + text.slice(at + 1600); }, 'debugger-prevention', /Phase 0 Evidence line must include why_not_caught \+ recurrence_guard/],
        ['recurrence_guard gone from the Phase 0 block (#1963)', 'agents/gsd-debugger.md',
          (text) => { const at = text.indexOf('**Phase 0: Check knowledge base**'); return text.slice(0, at) + text.slice(at, at + 1600).replace(/recurrence.?guard/gi, '') + text.slice(at + 1600); }, 'debugger-prevention', /Phase 0 Evidence line must include why_not_caught \+ recurrence_guard/],
    // policy-lint-shallow-checkout
    ...['docs-required.yml', 'changeset-required.yml'].flatMap((name) => [
      [`fetch-depth: 50 gone from ${name}`, `.github/workflows/${name}`, swap('fetch-depth: 50', 'fetch-depth: 1'), 'policy-lint-shallow-checkout', /checkout must use fetch-depth: 50/],
      [`fetch-depth: 0 added to ${name}`, `.github/workflows/${name}`, append('          fetch-depth: 0'), 'policy-lint-shallow-checkout', /fetch-depth: 0 \(full-history clone\) must be replaced with fetch-depth: 50/],
      [`the base-ref fetch step gone from ${name}`, `.github/workflows/${name}`, swap('Fetch base ref for diff', 'Fetch the base'), 'policy-lint-shallow-checkout', /explicit "Fetch base ref for diff" step/],
    ]),
    // planner-mvp-mode
    ['MVP mode gone from the planner', 'agents/gsd-planner.md', erase(/MVP\s*Mode|MVP_MODE/gi), 'planner-mvp-mode', /must reference MVP mode/],
    ['vertical-slice terminology gone from the planner', 'agents/gsd-planner.md', erase(/vertical[\s-]?slice/gi), 'planner-mvp-mode', /must use vertical-slice terminology/],
    ['Walking Skeleton gone from the planner', 'agents/gsd-planner.md', erase(/Walking\s*Skeleton/gi), 'planner-mvp-mode', /must mention Walking Skeleton/],
    ['SKELETON.md gone from the planner', 'agents/gsd-planner.md', eraseAll('SKELETON.md'), 'planner-mvp-mode', /must mention SKELETON\.md output/],
    ['the planner-mvp-mode.md reference gone from the planner', 'agents/gsd-planner.md', eraseAll('references/planner-mvp-mode.md'), 'planner-mvp-mode', /must reference the MVP-mode rules file/],
    ['mixing language added to the planner (mix ... horizontal ... MVP)', 'agents/gsd-planner.md', append('We mix horizontal and MVP tasks within one phase.'), 'planner-mvp-mode', /agent must enforce all-or-nothing per phase/],
    ['mixing language added to the planner (MVP ... and ... horizontal ... tasks)', 'agents/gsd-planner.md', append('MVP work and horizontal layers become tasks.'), 'planner-mvp-mode', /agent must enforce all-or-nothing per phase/],
    ['Phase Goal gone from the planner', 'agents/gsd-planner.md', erase(/Phase\s*Goal/gi), 'planner-mvp-mode', /must mention the "Phase Goal" header/],
    ['the bolded user-story format gone from the planner', 'agents/gsd-planner.md', erase(/\*\*As a\*\*[^\n]*\*\*I want to\*\*[^\n]*\*\*so that\*\*/gi), 'planner-mvp-mode', /must specify the bolded user-story format/],
    ['the user-story-template reference gone from the planner', 'agents/gsd-planner.md', eraseAll('user-story-template.md'), 'planner-mvp-mode', /must reference the user-story-template reference file/],
    // codebase-mapper-date-restamp
    ['the overwrite instruction gone from the mapper (#2279)', 'agents/gsd-codebase-mapper.md', erase(/overwrit(?:e|ing)\s+(?:any|whatever)[^.\n]*date/gi), 'codebase-mapper-date-restamp', /gsd-codebase-mapper\.md must tell the agent to overwrite a prior concrete date/],
    ['a placeholder-only instruction back in the mapper (#2279)', 'agents/gsd-codebase-mapper.md', append('Replace [YYYY-MM-DD] with the date.'), 'codebase-mapper-date-restamp', /gsd-codebase-mapper\.md still contains a placeholder-only date instruction/],
    ['a backtick-wrapped placeholder-only instruction back in the mapper (#2279)', 'agents/gsd-codebase-mapper.md', append('Replace `[YYYY-MM-DD]` with the date.'), 'codebase-mapper-date-restamp', /gsd-codebase-mapper\.md still contains a placeholder-only date instruction/],
    ['the overwrite instruction gone from map-codebase (#2279)', 'gsd-core/workflows/map-codebase.md', erase(/overwrit(?:e|ing)\s+(?:any|whatever)[^.\n]*date/gi), 'codebase-mapper-date-restamp', /map-codebase\.md must instruct overwriting an existing date/],
    ['a placeholder-only instruction back in map-codebase (#2279)', 'gsd-core/workflows/map-codebase.md', append('Use {date} for all [YYYY-MM-DD] date placeholders'), 'codebase-mapper-date-restamp', /map-codebase\.md still contains a placeholder-only date instruction/],
    ['the sequential-fallback placeholder-only phrasing back in map-codebase (#2279)', 'gsd-core/workflows/map-codebase.md', append('Use `{date}` from init context for all `[YYYY-MM-DD]` date placeholders'), 'codebase-mapper-date-restamp', /map-codebase\.md still contains a placeholder-only date instruction/],
    ['the overwrite sites gone from map-codebase (#2279)', 'gsd-core/workflows/map-codebase.md', erase(/overwrit(?:e|ing) any existing date/gi), 'codebase-mapper-date-restamp', /must carry the overwrite instruction at every date-instruction site/],
    // quick-session-management
    ['the list subcommand routing gone from quick (#2155)', 'commands/gsd/quick.md', eraseAll('SUBCMD=list'), 'quick-session-management', /missing list subcommand routing/],
    ['the status subcommand routing gone from quick (#2155)', 'commands/gsd/quick.md', eraseAll('SUBCMD=status'), 'quick-session-management', /missing status subcommand routing/],
    ['the resume subcommand routing gone from quick (#2155)', 'commands/gsd/quick.md', eraseAll('SUBCMD=resume'), 'quick-session-management', /missing resume subcommand routing/],
    ['slug sanitization gone from quick (#2155)', 'commands/gsd/quick.md', erase(/sanitiz|\[a-z0-9/g), 'quick-session-management', /missing slug sanitization/],
    ['security_notes gone from quick (#2155)', 'commands/gsd/quick.md', eraseAll('security_notes'), 'quick-session-management', /missing security_notes section/],
    ['"STOP after displaying the list" gone from quick (#2155)', 'commands/gsd/quick.md', eraseAll('STOP after displaying the list'), 'quick-session-management', /list subcommand should stop after display/],
    ['the path traversal rejection gone from quick (#2155)', 'commands/gsd/quick.md', erase(/reject[^\n]*\.\./gi), 'quick-session-management', /missing path traversal rejection for slugs/],
    ['display sanitization gone from quick (#2155)', 'commands/gsd/quick.md', erase(/non-printable|ANSI/g), 'quick-session-management', /missing directory name sanitization for display/],
    ['frontmatter get gone from quick (#2155)', 'commands/gsd/quick.md', erase(/frontmatter get|frontmatter\.get/g), 'quick-session-management', /should use frontmatter get \/ frontmatter\.get to read status/],
    ['the complete status gone from quick (#2155)', 'commands/gsd/quick.md', eraseAll('complete ✓'), 'quick-session-management', /list should show the complete status/],
    // diagnose-issues-workflow
    ['the removed template named again in diagnose-issues (#5203)', 'gsd-core/workflows/diagnose-issues.md', append('Fill the debug-subagent-prompt template.'), 'diagnose-issues-workflow', /the removed debug-subagent-prompt template is still named/],
    ['a DEBUG-{slug}.md name back in diagnose-issues (#5203)', 'gsd-core/workflows/diagnose-issues.md', append('Write DEBUG-{slug}.md.'), 'diagnose-issues-workflow', /a DEBUG-\{slug\}\.md name contradicts/],
    ['the Agent() prompt variable gone from diagnose-issues (#5203)', 'gsd-core/workflows/diagnose-issues.md', eraseAll('prompt=filled_debug_prompt + '), 'diagnose-issues-workflow', /Agent\(\) does not pass filled_debug_prompt/],
    ['the old prompt variable name back in diagnose-issues (#5203)', 'gsd-core/workflows/diagnose-issues.md', append('prompt=filled_debug_subagent_prompt'), 'diagnose-issues-workflow', /the old variable name is still used/],
    ['the inline prompt anchor renamed in diagnose-issues (#5203)', 'gsd-core/workflows/diagnose-issues.md', eraseAll('fill this prompt'), 'diagnose-issues-workflow', /marker .*fill this prompt.* not found/],
    ['the inline prompt <objective> gone from diagnose-issues (#5203)', 'gsd-core/workflows/diagnose-issues.md', eraseAll('<objective>'), 'diagnose-issues-workflow', /marker .*<objective>.* not found/],
    ['a placeholder only between the anchor and <objective> in diagnose-issues (#5203)', 'gsd-core/workflows/diagnose-issues.md',
      (text) => {
        const anchor = text.indexOf('fill this prompt');
        const open = text.indexOf('<objective>', anchor);
        const end = text.indexOf('</debug_file>', open);
        return `${text.slice(0, open)}{truth} ${text.slice(open, end).split('{truth}').join('')}${text.slice(end)}`;
      }, 'diagnose-issues-workflow', /the inline prompt lacks \{truth\}/],
    ['symptoms_prefilled gone from the inline prompt (#5203)', 'gsd-core/workflows/diagnose-issues.md', within('fill this prompt', '</debug_file>', erase(/symptoms_prefilled: true/g)), 'diagnose-issues-workflow', /must carry symptoms_prefilled: true/],
    ['the goal gone from the inline prompt (#5203)', 'gsd-core/workflows/diagnose-issues.md', within('fill this prompt', '</debug_file>', erase(/goal: find_root_cause_only/g)), 'diagnose-issues-workflow', /must carry goal: find_root_cause_only/],
    ['the debug-file target changed in the inline prompt (#5203)', 'gsd-core/workflows/diagnose-issues.md', swap('Create: .planning/debug/{slug}.md', 'Create: .planning/debug/session.md'), 'diagnose-issues-workflow', /the inline prompt must carry the debug-file target/],
    ['the debug_file block no longer closes (#5203)', 'gsd-core/workflows/diagnose-issues.md', eraseAll('</debug_file>'), 'diagnose-issues-workflow', /closing marker .* not found/],
    ['{truth} gone from the inline prompt (#5203)', 'gsd-core/workflows/diagnose-issues.md', within('fill this prompt', '</debug_file>', eraseAll('{truth}')), 'diagnose-issues-workflow', /the inline prompt lacks \{truth\}/],
    ['{expected} gone from the inline prompt (#5203)', 'gsd-core/workflows/diagnose-issues.md', within('fill this prompt', '</debug_file>', eraseAll('{expected}')), 'diagnose-issues-workflow', /the inline prompt lacks \{expected\}/],
    ['{actual} gone from the inline prompt (#5203)', 'gsd-core/workflows/diagnose-issues.md', within('fill this prompt', '</debug_file>', eraseAll('{actual}')), 'diagnose-issues-workflow', /the inline prompt lacks \{actual\}/],
    ['{errors} gone from the inline prompt (#5203)', 'gsd-core/workflows/diagnose-issues.md', within('fill this prompt', '</debug_file>', eraseAll('{errors}')), 'diagnose-issues-workflow', /the inline prompt lacks \{errors\}/],
    ['{reproduction} gone from the inline prompt (#5203)', 'gsd-core/workflows/diagnose-issues.md', within('fill this prompt', '</debug_file>', eraseAll('{reproduction}')), 'diagnose-issues-workflow', /the inline prompt lacks \{reproduction\}/],
    ['{timeline} gone from the inline prompt (#5203)', 'gsd-core/workflows/diagnose-issues.md', within('fill this prompt', '</debug_file>', eraseAll('{timeline}')), 'diagnose-issues-workflow', /the inline prompt lacks \{timeline\}/],
    ['{slug} gone from the inline prompt (#5203)', 'gsd-core/workflows/diagnose-issues.md', within('fill this prompt', '</debug_file>', eraseAll('{slug}')), 'diagnose-issues-workflow', /the inline prompt lacks \{slug\}/],
    ['a workflow that fills a template that does not exist (#5203)', 'gsd-core/workflows/diagnose-issues.md', append('Then fill the nonexistent-thing template.'), 'diagnose-issues-workflow', /must resolve to templates\/nonexistent-thing\.md/],
    // auto-chain-transition-delegation
    ['the delegation step gone from execute-phase (#1526)', 'gsd-core/workflows/execute-phase.md', eraseAll('delegate_post_completion_to_transition'), 'auto-chain-transition-delegation', /execute-phase must have a delegation step/],
    ['the transition include gone from execute-phase (#1526)', 'gsd-core/workflows/execute-phase.md', eraseAll('@~/.claude/gsd-core/workflows/transition.md'), 'auto-chain-transition-delegation', /execute-phase must @-include transition\.md/],
    ['the transition include ahead of the delegation step in execute-phase (#1526)', 'gsd-core/workflows/execute-phase.md',
      (text) => `@~/.claude/gsd-core/workflows/transition.md\n${text.split('@~/.claude/gsd-core/workflows/transition.md').join('')}`, 'auto-chain-transition-delegation', /the transition include must be inside the delegation step/],
    ['the standalone update_project_md step back in execute-phase (#1526)', 'gsd-core/workflows/execute-phase.md', append('<step name="update_project_md">'), 'auto-chain-transition-delegation', /the standalone update_project_md step must be removed/],
    ['the delegation step tag renamed in execute-phase (#1526)', 'gsd-core/workflows/execute-phase.md', eraseAll('<step name="delegate_post_completion_to_transition'), 'auto-chain-transition-delegation', /marker .*delegate_post_completion_to_transition.* not found/],
    ['post-completion mode gone from the delegation step (#1526)', 'gsd-core/workflows/execute-phase.md', within('<step name="delegate_post_completion_to_transition', '</step>', erase(/post-completion mode/gi)), 'auto-chain-transition-delegation', /the delegation step must name post-completion mode/],
    ['verify_completion gone from the delegation step (#1526)', 'gsd-core/workflows/execute-phase.md', within('<step name="delegate_post_completion_to_transition', '</step>', eraseAll('verify_completion')), 'auto-chain-transition-delegation', /must reference the verify step to skip/],
    ['update_roadmap_and_state gone from the delegation step (#1526)', 'gsd-core/workflows/execute-phase.md', within('<step name="delegate_post_completion_to_transition', '</step>', eraseAll('update_roadmap_and_state')), 'auto-chain-transition-delegation', /must reference the roadmap\/state step to skip/],
    ['evolve_project gone from the delegation step (#1526)', 'gsd-core/workflows/execute-phase.md', within('<step name="delegate_post_completion_to_transition', '</step>', eraseAll('evolve_project')), 'auto-chain-transition-delegation', /must name evolve_project as the delegation start/],
    ['the post_completion_mode step tag renamed in transition (#1526)', 'gsd-core/workflows/transition.md', eraseAll('<step name="post_completion_mode"'), 'auto-chain-transition-delegation', /marker .*post_completion_mode.* not found/],
    ['the skip set gone from the transition mode (#1526)', 'gsd-core/workflows/transition.md', within('<step name="post_completion_mode"', '</step>', erase(/SKIP\s+`verify_completion`\s+and\s+`update_roadmap_and_state`/gi)), 'auto-chain-transition-delegation', /the mode must name the exact skip set/],
    ['evolve_project gone from the transition mode (#1526)', 'gsd-core/workflows/transition.md', within('<step name="post_completion_mode"', '</step>', eraseAll('evolve_project')), 'auto-chain-transition-delegation', /the mode must begin at evolve_project/],
    ['standalone mode gone from the transition mode (#1526)', 'gsd-core/workflows/transition.md', within('<step name="post_completion_mode"', '</step>', erase(/Standalone transition/gi)), 'auto-chain-transition-delegation', /standalone \(mode 1\) must still be documented/],
    // config-get-raw-guard
    ['a config-get substitution without --raw in a workflow (#3763)', 'gsd-core/workflows/execute-phase.md', append('RUNTIME=$(gsd_run query config-get runtime)'), 'config-get-raw-guard', /a config-get command substitution without --raw/],
    ['a config-get substitution whose --raw sits after the || fallback (#3763)', 'gsd-core/workflows/execute-phase.md', append('RUNTIME=$(gsd_run query config-get runtime || echo "" --raw)'), 'config-get-raw-guard', /a config-get command substitution without --raw/],
    ['a config-get substitution without --raw in a command (#3763)', 'commands/gsd/discuss-phase.md', append('RUNTIME=$(gsd_run query config-get runtime)'), 'config-get-raw-guard', /a config-get command substitution without --raw/],
    ['a config-get substitution without --raw in an agent (#3763)', 'agents/gsd-executor.md', append('RUNTIME=$(gsd_run query config-get runtime)'), 'config-get-raw-guard', /a config-get command substitution without --raw/],
    ['a config-get substitution without --raw in a skill (#3763)', 'skills/gsd-discuss-phase/SKILL.md', append('RUNTIME=$(gsd_run query config-get runtime)'), 'config-get-raw-guard', /a config-get command substitution without --raw/],
    ['a config-get substitution without --raw and without an assignment (#3763)', 'gsd-core/workflows/execute-phase.md', append('echo "$(gsd_run query config-get runtime)"'), 'config-get-raw-guard', /a config-get command substitution without --raw/],
    // next-queue-ruleset
    ['the ruleset renamed', '.github/rulesets/next-queue.json', swap('"name": "next-queue"', '"name": "queue"'), 'next-queue-ruleset', /must target the default branch and be named for sync-rulesets\.sh to find/],
    ['the ruleset target changed', '.github/rulesets/next-queue.json', swap('"target": "branch"', '"target": "tag"'), 'next-queue-ruleset', /must target the default branch and be named for sync-rulesets\.sh to find/],
    ['the ruleset no longer includes the default branch', '.github/rulesets/next-queue.json', swap('"~DEFAULT_BRANCH"', '"main"'), 'next-queue-ruleset', /must target the default branch and be named for sync-rulesets\.sh to find/],
    ['the ruleset excludes a branch', '.github/rulesets/next-queue.json', swap('"exclude": []', '"exclude": ["main"]'), 'next-queue-ruleset', /must target the default branch and be named for sync-rulesets\.sh to find/],
    ['a second rule in the queue ruleset', '.github/rulesets/next-queue.json', swap('"rules": [', '"rules": [\n    { "type": "required_signatures" },'), 'next-queue-ruleset', /must carry exactly one rule, the merge queue/],
    ['no merge_queue rule in the queue ruleset', '.github/rulesets/next-queue.json', swap('"merge_queue"', '"pull_request"'), 'next-queue-ruleset', /must carry exactly one rule, the merge queue/],
    ['the ruleset committed as active', '.github/rulesets/next-queue.json', swap('"enforcement": "disabled"', '"enforcement": "active"'), 'next-queue-ruleset', /must never be committed as active/],
    ['the bypass actor changed', '.github/rulesets/next-queue.json', swap('"actor_id": 5', '"actor_id": 6'), 'next-queue-ruleset', /exactly one bypass actor, the repository Admin role/],
    ['a second bypass actor', '.github/rulesets/next-queue.json', swap('"bypass_actors": [', '"bypass_actors": [\n    { "actor_id": 1, "actor_type": "Team", "bypass_mode": "always" },'), 'next-queue-ruleset', /exactly one bypass actor, the repository Admin role/],
    ['the merge method changed', '.github/rulesets/next-queue.json', swap('"SQUASH"', '"MERGE"'), 'next-queue-ruleset', /the queue must squash/],
    ['the grouping strategy changed', '.github/rulesets/next-queue.json', swap('"ALLGREEN"', '"HEADGREEN"'), 'next-queue-ruleset', /only merge groups whose members all passed/],
    ['the check response timeout a string', '.github/rulesets/next-queue.json', swap('"check_response_timeout_minutes": 90', '"check_response_timeout_minutes": "90"'), 'next-queue-ruleset', /check_response_timeout_minutes must be an integer within the REST range 1\.\.360/],
    ['a fractional check response timeout', '.github/rulesets/next-queue.json', swap('"check_response_timeout_minutes": 90', '"check_response_timeout_minutes": 90.5'), 'next-queue-ruleset', /check_response_timeout_minutes must be an integer within the REST range 1\.\.360/],
    ['min_entries_to_merge above max_entries_to_merge', '.github/rulesets/next-queue.json', swap('"min_entries_to_merge": 2', '"min_entries_to_merge": 4'), 'next-queue-ruleset', /group sizing must be coherent/],
    ['min_entries_to_merge zero', '.github/rulesets/next-queue.json', swap('"min_entries_to_merge": 2', '"min_entries_to_merge": 0'), 'next-queue-ruleset', /group sizing must be coherent/],
    ['max_entries_to_build zero', '.github/rulesets/next-queue.json', swap('"max_entries_to_build": 2', '"max_entries_to_build": 0'), 'next-queue-ruleset', /group sizing must be coherent/],
    ['a negative wait', '.github/rulesets/next-queue.json', swap('"min_entries_to_merge_wait_minutes": 15', '"min_entries_to_merge_wait_minutes": -1'), 'next-queue-ruleset', /group sizing must be coherent/],
    ['an unknown merge_queue parameter', '.github/rulesets/next-queue.json', swap('"merge_method": "SQUASH",', '"merge_method": "SQUASH",\n        "extra": 1,'), 'next-queue-ruleset', /use no unknown merge_queue parameters/],
    ['a merge_queue parameter gone', '.github/rulesets/next-queue.json', swap('"grouping_strategy": "ALLGREEN",', ''), 'next-queue-ruleset', /use no unknown merge_queue parameters/],
    ['the queue ruleset without a parameters object', '.github/rulesets/next-queue.json', swap('"parameters": {', '"parameters_x": {'), 'next-queue-ruleset', /merge_queue has no parameters/],
    ['the queue ruleset a JSON null', '.github/rulesets/next-queue.json', () => 'null', 'next-queue-ruleset', /not a JSON object/],
    ['another ruleset a JSON null', '.github/rulesets/release-branches.json', () => 'null', 'next-queue-ruleset', /not a JSON object/],
    ['the queue ruleset a JSON array', '.github/rulesets/next-queue.json', () => '[]', 'next-queue-ruleset', /not a JSON object/],
    ['the queue ruleset with a rules value that is not an array', '.github/rulesets/next-queue.json', swap('"rules": [', '"rules_x": ['), 'next-queue-ruleset', /must carry exactly one rule, the merge queue/],
    ['the queue ruleset no longer valid JSON', '.github/rulesets/next-queue.json', append('}'), 'next-queue-ruleset', /not valid JSON/],
    ['two rulesets with the same name', '.github/rulesets/main-protection.json', swap('"name": "main-protection"', '"name": "next-queue"'), 'next-queue-ruleset', /ruleset names must be unique across files/],
    ['a ruleset with an unknown target', '.github/rulesets/main-protection.json', swap('"target": "branch"', '"target": "repo"'), 'next-queue-ruleset', /main-protection\.json must have a name, a target and a rules array/],
    ['a ruleset with an empty name', '.github/rulesets/release-branches.json', swap('"name": "release-branches"', '"name": ""'), 'next-queue-ruleset', /release-branches\.json must have a name, a target and a rules array/],
    ['a ruleset without a rules array', '.github/rulesets/tag-immutability.json', swap('"rules": [', '"rules_x": ['), 'next-queue-ruleset', /tag-immutability\.json must have a name, a target and a rules array/],
    // sync-skills-cross-runtime-refuse
    ['the destination comparison gone from sync-skills (#3025)', 'gsd-core/workflows/sync-skills.md', eraseAll('!= "$FROM_RUNTIME"'), 'sync-skills-cross-runtime-refuse', /the guard must precede the cp -r copy/],
    ['the refusal wording gone from sync-skills (#3025)', 'gsd-core/workflows/sync-skills.md', eraseAll('cross-runtime skill sync is not supported'), 'sync-skills-cross-runtime-refuse', /refusal must name the unsupported operation/],
    ['the installer command gone from sync-skills (#3025)', 'gsd-core/workflows/sync-skills.md', eraseAll('npx -y @opengsd/gsd-core@latest --global --<runtime>'), 'sync-skills-cross-runtime-refuse', /refusal must print the installer command/],
    ['the destination name gone from sync-skills (#3025)', 'gsd-core/workflows/sync-skills.md', erase(/\$DEST/g), 'sync-skills-cross-runtime-refuse', /refusal must name the refused destination runtime/],
    ['the grok note gone from sync-skills (#3025)', 'gsd-core/workflows/sync-skills.md', eraseAll('grok has no dedicated installer flag'), 'sync-skills-cross-runtime-refuse', /refusal must note grok aliasing/],
    ['the copy ahead of the guard in sync-skills (#3025)', 'gsd-core/workflows/sync-skills.md', (text) => `cp -r "$SRC_SKILLS_ROOT/$SKILL"\n${text}`, 'sync-skills-cross-runtime-refuse', /the guard must precede the cp -r copy/],
    ['the guard loop gone from sync-skills (#3025)', 'gsd-core/workflows/sync-skills.md', eraseAll('for DEST in "${TO_RUNTIMES[@]}"'), 'sync-skills-cross-runtime-refuse', /the guard must iterate the destination set/],
    ['--to all gone from sync-skills (#3025)', 'gsd-core/workflows/sync-skills.md', eraseAll('--to all'), 'sync-skills-cross-runtime-refuse', /the all expansion must stay part of the interface/],
    ['the identity no-op message gone from sync-skills (#3025)', 'gsd-core/workflows/sync-skills.md', eraseAll('[no-op: source and destination are the same runtime]'), 'sync-skills-cross-runtime-refuse', /the identity no-op message must remain/],
    ['the identity handling gone from sync-skills (#3025)', 'gsd-core/workflows/sync-skills.md', erase(/If .--from. == .--to./g), 'sync-skills-cross-runtime-refuse', /identity handling must be retained in validation/],
    ['the runtime-id predicate gone from sync-skills (#3025)', 'gsd-core/workflows/sync-skills.md', eraseAll('is_runtime_id()'), 'sync-skills-cross-runtime-refuse', /a runtime-id shape predicate must exist/],
    ['the runtime-id shape gone from sync-skills (#3025)', 'gsd-core/workflows/sync-skills.md', erase(/\^\[a-z0-9\]\[a-z0-9-\]\*\$/g), 'sync-skills-cross-runtime-refuse', /predicate must require a lowercase-alphanumeric shape/],
    ['the cross-runtime guard marker ahead of the shape predicate in sync-skills (#3025)', 'gsd-core/workflows/sync-skills.md', (text) => `#3025: refuse cross-runtime skill sync\n${text}`, 'sync-skills-cross-runtime-refuse', /shape validation must precede the cross-runtime guard/],
    ['exit 1 gone from the sync-skills guard loop (#3025)', 'gsd-core/workflows/sync-skills.md', within('for DEST in "${TO_RUNTIMES[@]}"', 'done', eraseAll('exit 1')), 'sync-skills-cross-runtime-refuse', /the guard loop itself must exit non-zero/],
    // template-phase-prompt-dependson-3427
    ['a short-form depends_on example in the phase-prompt template (#3427)', 'gsd-core/templates/phase-prompt.md', (text) => text.replace(/depends_on: \["(\d{2})-\d{2}"\]/, 'depends_on: ["$1"]'), 'template-phase-prompt-dependson-3427', /every non-empty depends_on example must list full-form plan ids/],
    ['a two-token short-form depends_on example added (#3427)', 'gsd-core/templates/phase-prompt.md', append('depends_on: ["01", "02"]'), 'template-phase-prompt-dependson-3427', /line \d+: token "01"/],
    ['every depends_on example gone from the template (#3427)', 'gsd-core/templates/phase-prompt.md', (text) => text.split('\n').map((line) => (/^\s*depends_on:/.test(line) ? 'x' : line)).join('\n'), 'template-phase-prompt-dependson-3427', /the template must carry depends_on examples to check/],
    ['every non-empty depends_on example emptied (#3427)', 'gsd-core/templates/phase-prompt.md', (text) => text.replace(/depends_on: \[[^\]]+\]/g, 'depends_on: []'), 'template-phase-prompt-dependson-3427', /no non-empty depends_on example/],
    ['a depends_on line the example pattern cannot parse (#3427)', 'gsd-core/templates/phase-prompt.md', append('depends_on: ["01"'), 'template-phase-prompt-dependson-3427', /cannot be parsed by the example pattern/],
    ['a YAML list item depends_on line the example pattern does not parse (#3427)', 'gsd-core/templates/phase-prompt.md', append('- depends_on: ["01"]'), 'template-phase-prompt-dependson-3427', /cannot be parsed by the example pattern/],
    ['an indented YAML list item depends_on line (#3427)', 'gsd-core/templates/phase-prompt.md', append('    - depends_on: ["01"]'), 'template-phase-prompt-dependson-3427', /cannot be parsed by the example pattern/],
    ['a depends_on line indented past the pattern bound (#3427)', 'gsd-core/templates/phase-prompt.md', append(`${' '.repeat(60)}depends_on: ["01"]`), 'template-phase-prompt-dependson-3427', /cannot be parsed by the example pattern/],
    // release-finalize-syncs-next-version
    ['release.yml with no jobs at all (#2423)', '.github/workflows/release.yml', () => 'name: Release\n', 'release-finalize-syncs-next-version', /the rc job must exist/],
    ['the rc job renamed in release.yml (#2423)', '.github/workflows/release.yml', swap('\n  rc:\n', '\n  rcx:\n'), 'release-finalize-syncs-next-version', /the rc job must exist/],
    ['the sync script gone from the rc job (#2423)', '.github/workflows/release.yml', within('\n  rc:\n', '\n  install-smoke-finalize:', eraseAll('scripts/sync-next-version.cjs')), 'release-finalize-syncs-next-version', /the rc job must call scripts\/sync-next-version\.cjs/],
    ['the finalize job renamed in release.yml (#2423)', '.github/workflows/release.yml', swap('\n  finalize:\n', '\n  finalizex:\n'), 'release-finalize-syncs-next-version', /the finalize job must exist/],
    ['the sync script gone from the finalize job (#2423)', '.github/workflows/release.yml',
      (text) => { const at = text.indexOf('\n  finalize:\n'); return text.slice(0, at) + text.slice(at).split('scripts/sync-next-version.cjs').join('scripts/other.cjs'); }, 'release-finalize-syncs-next-version', /the finalize job must call scripts\/sync-next-version\.cjs/],
    ['the dry-run gate gone from the finalize job (#2423)', '.github/workflows/release.yml',
      (text) => { const at = text.indexOf('\n  finalize:\n'); return text.slice(0, at) + text.slice(at).split('!inputs.dry_run').join('true'); }, 'release-finalize-syncs-next-version', /the sync-next-version step itself must be gated on !inputs\.dry_run/],
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
      // ─── batch 8, group 1: controls ───────────────────────────────────────────────────────────────────────────────────────
      passes('a line naming the retired package with done/ stays exempt from todos-done-rename-guard', 'docs/CONFIGURATION.md',
        append(`The old package ${'get-shit' + '-done'}/ directory is historical.`), 'todos-done-rename-guard');
      passes('a line with the gsd-allow-legacy-name marker stays exempt from todos-done-rename-guard', 'docs/CONFIGURATION.md',
        append('See .planning/todos/done/ <!-- gsd-allow-legacy-name -->'), 'todos-done-rename-guard');
      passes('installer-migrations.md, a historical record, is skipped by todos-done-rename-guard', 'docs/installer-migrations.md',
        append('The old layout archived to .planning/todos/done/.'), 'todos-done-rename-guard');
      passes('a workflow with an auto-merge job granting both write scopes satisfies workflow-token-permissions', '.github/workflows/test.yml',
        yamlEdit((wf) => { wf.jobs.fine = { 'runs-on': 'ubuntu-latest', permissions: { contents: 'write', 'pull-requests': 'write' }, steps: [{ run: 'gh pr merge 7 --auto' }] }; }), 'workflow-token-permissions');
      passes('a gh pr merge without --auto and without permissions satisfies workflow-token-permissions', '.github/workflows/test.yml',
        yamlEdit((wf) => { wf.jobs.plain = { 'runs-on': 'ubuntu-latest', steps: [{ run: 'gh pr merge 7 --squash' }] }; }), 'workflow-token-permissions');
      passes('a doc block reformatted but data-equal still satisfies prohibition-probe.docs-fixtures', 'gsd-core/references/prohibition-probe.md',
        within('```json prohibition-probe:01-streak-reminder/expected.json', '\n```', (block) => {
          const lineEnd = block.indexOf('\n');
          return `${block.slice(0, lineEnd + 1)}${JSON.stringify(JSON.parse(block.slice(lineEnd + 1)))}`;
        }), 'prohibition-probe.docs-fixtures');
      passes('a link to a different INVENTORY.md is not a locale anchor for localized-inventory-agent-counts', 'docs/ja-JP/ARCHITECTURE.md',
        append('[x](../INVENTORY.md#no-such-heading)'), 'localized-inventory-agent-counts');
      passes('a link to an existing ja-JP INVENTORY heading satisfies localized-inventory-agent-counts', 'docs/ja-JP/ARCHITECTURE.md',
        append('[x](INVENTORY.md#エージェント)'), 'localized-inventory-agent-counts');
      passes('a comment naming git mv does not count for close-phase-todos-stage-deletion', 'gsd-core/workflows/execute-phase.md',
        inStepOf('close_phase_todos', (block) => `${block}\n  # git mv would fail on untracked todos\n`), 'close-phase-todos-stage-deletion');
      passes('a bare fs.writeFileSync of a .gitkeep stays allowed for atomic-write-coverage', 'gsd-core/bin/lib/phase.cjs',
        append("fs.writeFileSync(path.join(dir, '.gitkeep'), '');"), 'atomic-write-coverage');
      passes('a bare fs.writeFileSync into the archive directory stays allowed for atomic-write-coverage', 'gsd-core/bin/lib/milestone.cjs',
        append("fs.writeFileSync(path.join(archiveDir, 'x.md'), content);"), 'atomic-write-coverage');
      passes('a quality_gate earlier in plan-phase that lacks the prohibition item is not the last one for prohibition-probe.planner-contract', 'gsd-core/workflows/plan-phase.md',
        (text) => `<quality_gate>\n- [ ] nothing\n</quality_gate>\n${text}`, 'prohibition-probe.planner-contract');

      test('with ko-KR INVENTORY.md removed only three localized pages remain and localized-inventory-agent-counts says so', (t) => {
        const root = copyOfRepoFiles(t);
        fs.unlinkSync(path.join(root, 'docs', 'ko-KR', 'INVENTORY.md'));
        const findings = runShipped(root, ['localized-inventory-agent-counts']);
        assert.ok(findings.some((f) => /at least 4 localized INVENTORY pages .* must exist to be checked \(found 3:/.test(f.message)), JSON.stringify(findings));
      });
      test('with the fixtures directory emptied of expected.json files prohibition-probe.docs-fixtures reports it', (t) => {
        const root = copyOfRepoFiles(t);
        for (const dir of ['01-streak-reminder', '02-clean-utility', '03-multi-prohibition']) fs.unlinkSync(path.join(root, 'gsd-core', 'references', 'prohibition-probe-fixtures', dir, 'expected.json'));
        const findings = runShipped(root, ['prohibition-probe.docs-fixtures']);
        assert.ok(findings.some((f) => /no expected\.json file under gsd-core\/references\/prohibition-probe-fixtures/.test(f.message)), JSON.stringify(findings));
      });

      // ─── batch 8, group 1: bounds (limit - 1 and limit are matched, limit + 1 is the stated edge) ──────────────────────────
      // The auto-merge command is read whatever the whitespace between gh, pr and merge and whatever lies before --auto on
      // the line (a token walk, no bound): the dependabot workflow keeps its one auto-merge job, and a job in another
      // workflow that hides the command behind a long gap is still held to its permissions.
      for (const gap of [19, 20, 21, 300]) {
        passes(`${gap} spaces between gh and pr still read as the auto-merge command in workflow-token-permissions`, '.github/workflows/dependabot-auto-merge.yml',
          (text) => text.replace('gh pr merge --auto --squash "$PR_URL"', `gh${' '.repeat(gap)}pr merge --auto --squash "$PR_URL"`), 'workflow-token-permissions');
        passes(`${gap} spaces between pr and merge still read as the auto-merge command in workflow-token-permissions`, '.github/workflows/dependabot-auto-merge.yml',
          (text) => text.replace('gh pr merge --auto --squash "$PR_URL"', `gh pr${' '.repeat(gap)}merge --auto --squash "$PR_URL"`), 'workflow-token-permissions');
        findsOne(`an under-permissioned job with ${gap} spaces between gh and pr is not hidden from workflow-token-permissions`, '.github/workflows/test.yml',
          yamlEdit((wf) => { wf.jobs.evader = { 'runs-on': 'ubuntu-latest', permissions: { contents: 'read' }, steps: [{ run: `gh${' '.repeat(gap)}pr merge 7 --auto` }] }; }), 'workflow-token-permissions', 'job "evader" must grant contents: write');
        findsOne(`an under-permissioned job with ${gap} spaces between pr and merge is not hidden from workflow-token-permissions`, '.github/workflows/test.yml',
          yamlEdit((wf) => { wf.jobs.evader = { 'runs-on': 'ubuntu-latest', permissions: { contents: 'read' }, steps: [{ run: `gh pr${' '.repeat(gap)}merge 7 --auto` }] }; }), 'workflow-token-permissions', 'job "evader" must grant contents: write');
      }
      for (const gap of [1999, 2000, 2001, 5000]) {
        passes(`${gap} characters between merge and --auto still read as the auto-merge command in workflow-token-permissions`, '.github/workflows/dependabot-auto-merge.yml',
          (text) => text.replace('gh pr merge --auto --squash "$PR_URL"', `gh pr merge ${'x'.repeat(gap - 2)} --auto --squash "$PR_URL"`), 'workflow-token-permissions');
        findsOne(`an under-permissioned job with ${gap} characters between merge and --auto is not hidden from workflow-token-permissions`, '.github/workflows/test.yml',
          yamlEdit((wf) => { wf.jobs.evader = { 'runs-on': 'ubuntu-latest', permissions: { contents: 'read' }, steps: [{ run: `gh pr merge 7 ${'x'.repeat(gap - 2)} --auto` }] }; }), 'workflow-token-permissions', 'job "evader" must grant contents: write');
      }

      gapCases('spaces after default: and before the opening backtick of the settings default', 'gsd-core/workflows/settings-advanced.md', 'inline-plan-threshold-default',
        (text, gap) => text.replace('inline_plan_threshold` (default: `2`', `inline_plan_threshold\` (default:${' '.repeat(gap)}\`2\``), 20, /settings-advanced\.md must name the inline_plan_threshold default/);
      gapCases('spaces between the key and (default: in the settings text', 'gsd-core/workflows/settings-advanced.md', 'inline-plan-threshold-default',
        (text, gap) => text.replace('inline_plan_threshold` (default: `2`', `inline_plan_threshold\`${' '.repeat(gap)}(default: \`2\``), 20, /settings-advanced\.md must name the inline_plan_threshold default/);
      gapCases('characters between the settings prompt title and (current:', 'gsd-core/workflows/settings-advanced.md', 'inline-plan-threshold-default',
        (text, gap) => {
          const at = text.indexOf('Inline plan threshold');
          const current = text.indexOf('(current: <value or 2>)', at);
          const early = ' Default: 2';
          const filler = gap - early.length - (current - (at + 'Inline plan threshold'.length));
          assert.ok(filler >= 0, 'the real distance is under the bound');
          // The 2 for the Default: pattern now sits right after the title, so only the (current: pattern sees the filler.
          return `${text.slice(0, at + 'Inline plan threshold'.length)}${early}${'x'.repeat(filler)}${text.slice(at + 'Inline plan threshold'.length)}`;
        }, 500, /settings-advanced\.md must name the inline_plan_threshold default/);
      gapCases('characters between the settings prompt title and Default:', 'gsd-core/workflows/settings-advanced.md', 'inline-plan-threshold-default',
        (text, gap) => {
          const at = text.indexOf('Inline plan threshold');
          const defaults = text.indexOf('Default: 2', at);
          const filler = gap - (defaults - (at + 'Inline plan threshold'.length));
          assert.ok(filler >= 0, 'the real distance is under the bound');
          return `${text.slice(0, at + 'Inline plan threshold'.length)}${'x'.repeat(filler)}${text.slice(at + 'Inline plan threshold'.length)}`;
        }, 400, /settings-advanced\.md must name the inline_plan_threshold default/);
      for (const [label, from, build] of [
        ['the key and the first pipe', '`workflow.inline_plan_threshold` | number | `2`', (gap) => `\`workflow.inline_plan_threshold\`${' '.repeat(gap)}| number | \`2\``],
        ['number and its pipes', '`workflow.inline_plan_threshold` | number | `2`', (gap) => `\`workflow.inline_plan_threshold\` | number${' '.repeat(gap)}| \`2\``],
        ['the last pipe and the default', '`workflow.inline_plan_threshold` | number | `2`', (gap) => `\`workflow.inline_plan_threshold\` | number |${' '.repeat(gap)}\`2\``],
      ]) {
        gapCases(`whitespace between ${label} in the CONFIGURATION default row`, 'docs/CONFIGURATION.md', 'inline-plan-threshold-default',
          (text, gap) => text.replace(from, build(gap)), 20, /docs\/CONFIGURATION\.md must name the inline_plan_threshold default/);
      }

      // A gsd_run call ahead of the resolver include is found whatever the indent, the upper-case name before =$( or the
      // whitespace before its argument (a linear scan, no bound), so a long gap cannot hide it.
      for (const [label, line, sizes] of [
        ['whitespace before the gsd_run argument', (gap) => `gsd_run${' '.repeat(gap)}query state`, [19, 20, 21, 300]],
        ['indent before gsd_run', (gap) => `${' '.repeat(gap)}gsd_run query state`, [199, 200, 201, 300]],
        ['upper-case variable name before =$(', (gap) => `${'A'.repeat(gap)}=$(gsd_run query state)`, [59, 60, 61, 300]],
      ]) {
        for (const gap of sizes) {
          test(`${label} of ${gap} characters ahead of the resolver fails verifier-gsd-run-all-modes`, (t) => {
            const root = copyOfRepoFiles(t);
            const abs = path.join(root, 'agents', 'gsd-verifier.md');
            const text = fs.readFileSync(abs, 'utf8');
            fs.writeFileSync(abs, text.replace('## Resolver Bootstrap (Every Mode)\n', `## Resolver Bootstrap (Every Mode)\n${line(gap)}\n`));
            const findings = runShipped(root, ['verifier-gsd-run-all-modes']);
            assert.ok(findings.some((f) => /the first gsd_run invocation must come after the resolver include/.test(f.message)), JSON.stringify(findings));
          });
        }
      }

      // The localized INVENTORY heading count pattern: a heading is flagged with up to 500 characters of title, up to 200
      // characters after the opening digit and up to 20 trailing whitespace characters; past a bound it is not flagged.
      for (const [label, limit, heading] of [
        ['title characters before the count', 500, (gap) => `## ${'a'.repeat(gap - 1)} (3)`],
        ['characters after the count digit', 200, (gap) => `## 見出し (3${'x'.repeat(gap)})`],
        ['trailing whitespace after the count', 20, (gap) => `## 見出し (3)${' '.repeat(gap)}`],
      ]) {
        for (const [gap, flagged] of [[limit - 1, true], [limit, true], [limit + 1, false]]) {
          test(`${gap} ${label} in a zh-CN heading ${flagged ? 'is flagged by' : 'is past the bound of'} localized-inventory-agent-counts`, (t) => {
            const root = copyOfRepoFiles(t);
            const abs = path.join(root, 'docs', 'zh-CN', 'INVENTORY.md');
            fs.writeFileSync(abs, `${fs.readFileSync(abs, 'utf8')}\n${heading(gap)}\n`);
            const findings = runShipped(root, ['localized-inventory-agent-counts']);
            if (flagged) assert.ok(findings.some((f) => /section headings must carry no "\(N shipped\)" count/.test(f.message)), JSON.stringify(findings));
            else assert.deepEqual(findings, []);
          });
        }
      }
      for (const [gap, stripped] of [[499, true], [500, true], [501, false]]) {
        test(`an inline code span of ${gap} characters holding a digit in the ko-KR coverage note ${stripped ? 'is stripped, so no count is seen' : 'is past the bound and reads as a count'} for localized-inventory-agent-counts`, (t) => {
          const root = copyOfRepoFiles(t);
          const abs = path.join(root, 'docs', 'ko-KR', 'INVENTORY.md');
          const text = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
          const i = text.findIndex((l) => l.includes('`docs/reference/agents.md`') && l.includes('`agents/gsd-*.md`'));
          text[i] = `${text[i]} \`${'7'.repeat(gap)}\``;
          fs.writeFileSync(abs, text.join('\n'));
          const findings = runShipped(root, ['localized-inventory-agent-counts']);
          if (stripped) assert.deepEqual(findings, []);
          else assert.ok(findings.some((f) => /ko-KR\/INVENTORY\.md must have a coverage note that states no agent counts/.test(f.message)), JSON.stringify(findings));
        });
      }

      // A prohibition and must_haves.truths on one line are a lift into truths; 500 characters between them is the bound.
      for (const [gap, flagged] of [[499, true], [500, true], [501, false]]) {
        test(`${gap} characters between prohibition and must_haves.truths ${flagged ? 'is flagged by' : 'is past the bound of'} prohibition-probe.planner-contract`, (t) => {
          const root = copyOfRepoFiles(t);
          const abs = path.join(root, 'gsd-core', 'workflows', 'plan-phase.md');
          const text = fs.readFileSync(abs, 'utf8');
          fs.writeFileSync(abs, within('<downstream_consumer>', '</downstream_consumer>', (block) => `${block}\nLift each prohibition${'x'.repeat(gap)}must_haves.truths.\n`)(text));
          const findings = runShipped(root, ['prohibition-probe.planner-contract']);
          if (flagged) assert.ok(findings.some((f) => /prohibitions must NOT be lifted into must_haves\.truths/.test(f.message)), JSON.stringify(findings));
          else assert.deepEqual(findings, []);
        });
      }

      // atomic-write-coverage: a bare write with up to 20 whitespace characters before the parenthesis is seen; a platformWriteSync call with up to 50 ) or whitespace before its parenthesis is seen.
      for (const [gap, seen] of [[19, true], [20, true], [21, false]]) {
        test(`fs.writeFileSync with ${gap} spaces before the parenthesis ${seen ? 'is flagged by' : 'is past the bound of'} atomic-write-coverage`, (t) => {
          const root = copyOfRepoFiles(t);
          const abs = path.join(root, 'gsd-core', 'bin', 'lib', 'phase.cjs');
          fs.writeFileSync(abs, `${fs.readFileSync(abs, 'utf8')}\nfs.writeFileSync${' '.repeat(gap)}(planningPath, content);\n`);
          const findings = runShipped(root, ['atomic-write-coverage']);
          if (seen) assert.ok(findings.some((f) => /phase\.cjs must not contain a bare fs\.writeFileSync/.test(f.message)), JSON.stringify(findings));
          else assert.deepEqual(findings, []);
        });
      }
      gapCases('closing parentheses and spaces before the platformWriteSync call parenthesis', 'gsd-core/bin/lib/frontmatter.cjs', 'atomic-write-coverage',
        (text, gap) => `${text.split('platformWriteSync').join('platformWrite')}\nplatformWriteSync${')'.repeat(gap)}(x);\n`, 50, /frontmatter\.cjs must contain at least one platformWriteSync call/);

      // debugger-semantic-recall: the `when ... absent` fallback wording and the `existing ... memory` reuse wording bound their gap at 500.
      gapCases('characters between "when" and "absent" in the debugger reference', 'gsd-core/references/debugger-semantic-recall.md', 'debugger-semantic-recall',
        (text, gap) => `${text.replace(/fall[\s-]?back|fallback|degrade/gi, 'x').replace(/when[^\n]{0,500}(?:absent|unavailable)/gi, 'x')}\nwhen${'y'.repeat(gap)}absent\n`, 500, /it must document degradation to keyword matching when MemPalace is absent/);
      gapCases('characters between "existing" and "memory" in the debugger reference', 'gsd-core/references/debugger-semantic-recall.md', 'debugger-semantic-recall',
        (text, gap) => `${text.replace(/reuse|no new|without adding|existing[^\n]{0,500}(?:semantic|memory|capability)/gi, 'x')}\nexisting${'y'.repeat(gap)}memory\n`, 500, /it must state that MemPalace is reused/);

      // close-phase-todos-stage-deletion: the commit line is found with up to 2000 characters between "commit" and "--files", up to 20 whitespace characters inside "gsd_run query commit", and a comment is stripped with up to 200 spaces of indent.
      gapCases('characters between commit and --files in close_phase_todos', 'gsd-core/workflows/execute-phase.md', 'close-phase-todos-stage-deletion',
        (text, gap) => inStepOf('close_phase_todos', (block) => {
          const commit = block.indexOf('gsd_run query commit');
          const files = block.indexOf('--files', commit);
          const filler = gap - (files - (commit + 'gsd_run query commit'.length));
          assert.ok(filler >= 0, 'the real distance is under the bound');
          return `${block.slice(0, commit + 'gsd_run query commit'.length)} ${'x'.repeat(filler - 1)}${block.slice(commit + 'gsd_run query commit'.length)}`;
        })(text), 2000, /no gsd_run query commit \.\.\. --files invocation/);
      gapCases('whitespace between gsd_run and query in close_phase_todos', 'gsd-core/workflows/execute-phase.md', 'close-phase-todos-stage-deletion',
        (text, gap) => inStepOf('close_phase_todos', (block) => block.replace('gsd_run query commit', `gsd_run${' '.repeat(gap)}query commit`))(text), 20, /no gsd_run query commit \.\.\. --files invocation/);
      gapCases('spaces of indent before a git mv comment in close_phase_todos', 'gsd-core/workflows/execute-phase.md', 'close-phase-todos-stage-deletion',
        (text, gap) => inStepOf('close_phase_todos', (block) => `${block}\n${' '.repeat(gap)}# git mv would fail\n`)(text), 200, /close_phase_todos must NOT use git mv as the move command/);

      // ─── batch 8, group 1: second round ───────────────────────────────────────────────────────────────────────────────────
      // A fixture tag names <dir>/<file>: each part of at most 100 plain characters is read as a fixture (missing here, so
      // it cannot be read); 101 is not a plain reference. A whole tag of at most 500 characters is a tagged block; 501 is ignored.
      for (const [label, tag] of [
        ['directory', (gap) => `${'a'.repeat(gap)}/expected.json`],
        ['file name', (gap) => `01-streak-reminder/${'a'.repeat(gap)}`],
      ]) {
        for (const [gap, plain] of [[99, true], [100, true], [101, false]]) {
          test(`a fixture tag ${label} of ${gap} characters ${plain ? 'is read as a plain reference by' : 'is not a plain reference for'} prohibition-probe.docs-fixtures`, (t) => {
            const root = copyOfRepoFiles(t);
            const abs = path.join(root, 'gsd-core', 'references', 'prohibition-probe.md');
            fs.writeFileSync(abs, `${fs.readFileSync(abs, 'utf8')}\n\`\`\`json prohibition-probe:${tag(gap)}\n{}\n\`\`\`\n`);
            const findings = runShipped(root, ['prohibition-probe.docs-fixtures']);
            assert.equal(findings.some((f) => /is not a plain <dir>\/<file> fixture reference/.test(f.message)), !plain, JSON.stringify(findings));
            assert.equal(findings.some((f) => /cannot read the file/.test(f.message)), plain, JSON.stringify(findings));
          });
        }
      }
      for (const [gap, tagged] of [[499, true], [500, true], [501, false]]) {
        test(`a fixture tag of ${gap} characters ${tagged ? 'is a tagged block for' : 'is past the bound of'} prohibition-probe.docs-fixtures`, (t) => {
          const root = copyOfRepoFiles(t);
          const abs = path.join(root, 'gsd-core', 'references', 'prohibition-probe.md');
          fs.writeFileSync(abs, `${fs.readFileSync(abs, 'utf8')}\n\`\`\`json prohibition-probe:${'x'.repeat(gap)}\n{}\n\`\`\`\n`);
          const findings = runShipped(root, ['prohibition-probe.docs-fixtures']);
          if (tagged) assert.ok(findings.some((f) => /is not a plain <dir>\/<file> fixture reference/.test(f.message)), JSON.stringify(findings));
          else assert.deepEqual(findings, []);
        });
      }
      test('a not-expected.json file in a fixture directory is not an expected.json fixture for prohibition-probe.docs-fixtures', (t) => {
        const root = copyOfRepoFiles(t);
        const dir = path.join(root, 'gsd-core', 'references', 'prohibition-probe-fixtures', '04-extra');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'not-expected.json'), '{}\n');
        assert.deepEqual(runShipped(root, ['prohibition-probe.docs-fixtures']), []);
      });
      test('an OLD-INVENTORY.md in place of the ko-KR INVENTORY.md is not a localized inventory for localized-inventory-agent-counts', (t) => {
        const root = copyOfRepoFiles(t);
        fs.renameSync(path.join(root, 'docs', 'ko-KR', 'INVENTORY.md'), path.join(root, 'docs', 'ko-KR', 'OLD-INVENTORY.md'));
        const findings = runShipped(root, ['localized-inventory-agent-counts']);
        assert.ok(findings.some((f) => /\(found 3: /.test(f.message)), JSON.stringify(findings));
      });

      // The CONFIGURATION default row: the gap between the first pipe and "number" (the other three gaps are pinned above).
      gapCases('whitespace between the first pipe and number in the CONFIGURATION default row', 'docs/CONFIGURATION.md', 'inline-plan-threshold-default',
        (text, gap) => text.replace('`workflow.inline_plan_threshold` | number | `2`', `\`workflow.inline_plan_threshold\` |${' '.repeat(gap)}number | \`2\``), 20, /docs\/CONFIGURATION\.md must name the inline_plan_threshold default/);

      // The reverse order of the truths lift: must_haves.truths before prohibition, up to 500 characters apart on one line.
      for (const [gap, flagged] of [[499, true], [500, true], [501, false]]) {
        test(`${gap} characters between must_haves.truths and prohibition ${flagged ? 'is flagged by' : 'is past the bound of'} prohibition-probe.planner-contract`, (t) => {
          const root = copyOfRepoFiles(t);
          const abs = path.join(root, 'gsd-core', 'workflows', 'plan-phase.md');
          const text = fs.readFileSync(abs, 'utf8');
          fs.writeFileSync(abs, within('<downstream_consumer>', '</downstream_consumer>', (block) => `${block}\nmust_haves.truths${'x'.repeat(gap)}prohibition.\n`)(text));
          const findings = runShipped(root, ['prohibition-probe.planner-contract']);
          if (flagged) assert.ok(findings.some((f) => /prohibitions must NOT be lifted into must_haves\.truths/.test(f.message)), JSON.stringify(findings));
          else assert.deepEqual(findings, []);
        });
      }

      // workflow-token-permissions: a .yaml workflow is scanned like a .yml one, a workflow in a subdirectory is not, and
      // up to 20 whitespace characters between pr and the next word still read as the auto-merge command.
      const UNDERPERMISSIONED = 'name: x\non: push\njobs:\n  lift:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n    steps:\n      - run: gh pr merge 1 --auto\n';
      test('an under-permissioned auto-merge job in x.yaml is a finding for workflow-token-permissions', (t) => {
        const root = copyOfRepoFiles(t);
        fs.writeFileSync(path.join(root, '.github', 'workflows', 'x.yaml'), UNDERPERMISSIONED);
        const findings = runShipped(root, ['workflow-token-permissions']);
        assert.ok(findings.some((f) => f.file === '.github/workflows/x.yaml' && /job "lift" must grant contents: write/.test(f.message)), JSON.stringify(findings));
      });
      test('an under-permissioned auto-merge job in a workflows subdirectory is not scanned by workflow-token-permissions', (t) => {
        const root = copyOfRepoFiles(t);
        fs.mkdirSync(path.join(root, '.github', 'workflows', 'sub'), { recursive: true });
        fs.writeFileSync(path.join(root, '.github', 'workflows', 'sub', 'x.yml'), UNDERPERMISSIONED);
        assert.deepEqual(runShipped(root, ['workflow-token-permissions']), []);
      });
      test('a file in .github/workflows that is neither .yml nor .yaml is not scanned by workflow-token-permissions', (t) => {
        const root = copyOfRepoFiles(t);
        fs.writeFileSync(path.join(root, '.github', 'workflows', 'x.txt'), UNDERPERMISSIONED);
        assert.deepEqual(runShipped(root, ['workflow-token-permissions']), []);
      });


      // close-phase-todos-stage-deletion: every bound of the commit, mv and comment patterns, at limit - 1, limit and limit + 1.
      const closePhase = (edit) => (text) => inStepOf('close_phase_todos', edit)(text);
      const closeWhy = /close_phase_todos must stage the completed\/ destinations/;
      const noCommit = /no gsd_run query commit \.\.\. --files invocation/;
      gapCases('whitespace between query and commit in close_phase_todos', 'gsd-core/workflows/execute-phase.md', 'close-phase-todos-stage-deletion',
        (text, gap) => closePhase((block) => block.replace('gsd_run query commit', `gsd_run query${' '.repeat(gap)}commit`))(text), 20, noCommit);
      gapCases('whitespace after --files-removed in close_phase_todos', 'gsd-core/workflows/execute-phase.md', 'close-phase-todos-stage-deletion',
        (text, gap) => closePhase((block) => block.replace('--files-removed "${REMOVED[@]}"', `--files-removed${' '.repeat(gap)}"` + '${REMOVED[@]}"'))(text), 20, closeWhy);
      gapCases('characters of the --files list up to the end of the REMOVED array in close_phase_todos', 'gsd-core/workflows/execute-phase.md', 'close-phase-todos-stage-deletion',
        (text, gap) => closePhase((block) => {
          const start = block.indexOf('--files "${ADDED[@]}"') + '--files '.length;
          const removedEnd = block.indexOf('"${REMOVED[@]}"') + '"${REMOVED[@]}"'.length;
          const filler = gap - (removedEnd - start);
          assert.ok(filler >= 1, 'the real list is under the bound');
          return block.replace(' --files-removed', ` ${'x'.repeat(filler - 1)} --files-removed`);
        })(text), 2000, closeWhy);
      gapCases('whitespace between mv and "$TODO_FILE" in close_phase_todos', 'gsd-core/workflows/execute-phase.md', 'close-phase-todos-stage-deletion',
        (text, gap) => closePhase((block) => block.replace('mv "$TODO_FILE" "$COMPLETED_DIR/"', `mv${' '.repeat(gap)}"$TODO_FILE" "$COMPLETED_DIR/"`))(text), 20, /close_phase_todos must use plain shell mv to move the file/);
      gapCases('whitespace between "$TODO_FILE" and "$COMPLETED_DIR/" in close_phase_todos', 'gsd-core/workflows/execute-phase.md', 'close-phase-todos-stage-deletion',
        (text, gap) => closePhase((block) => block.replace('mv "$TODO_FILE" "$COMPLETED_DIR/"', `mv "$TODO_FILE"${' '.repeat(gap)}"$COMPLETED_DIR/"`))(text), 20, /close_phase_todos must use plain shell mv to move the file/);
      gapCases('characters of a git mv comment after the hash in close_phase_todos', 'gsd-core/workflows/execute-phase.md', 'close-phase-todos-stage-deletion',
        (text, gap) => closePhase((block) => `${block}\n#${'x'.repeat(gap - ' git mv'.length)} git mv\n`)(text), 2000, /close_phase_todos must NOT use git mv as the move command/);
      // `git` and `mv` are found whatever the whitespace between them (a word walk, no bound): a long gap does not evade the ban.
      for (const gap of [19, 20, 21, 300]) {
        test(`git and mv ${gap} whitespace characters apart is banned by close-phase-todos-stage-deletion`, (t) => {
          const root = copyOfRepoFiles(t);
          const abs = path.join(root, 'gsd-core', 'workflows', 'execute-phase.md');
          fs.writeFileSync(abs, closePhase((block) => `${block}\ngit${' '.repeat(gap)}mv a b\n`)(fs.readFileSync(abs, 'utf8')));
          const findings = runShipped(root, ['close-phase-todos-stage-deletion']);
          assert.ok(findings.some((f) => /close_phase_todos must NOT use git mv as the move command/.test(f.message)), JSON.stringify(findings));
        });
      }
      test('git and mv on different lines are banned by close-phase-todos-stage-deletion', (t) => {
        const root = copyOfRepoFiles(t);
        const abs = path.join(root, 'gsd-core', 'workflows', 'execute-phase.md');
        fs.writeFileSync(abs, closePhase((block) => `${block}\ngit\n\n   mv a b\n`)(fs.readFileSync(abs, 'utf8')));
        assert.ok(runShipped(root, ['close-phase-todos-stage-deletion']).some((f) => /must NOT use git mv/.test(f.message)));
      });
      const archiveCommit = /cleanup\.md must commit the archive via gsd_run query commit/;
      gapCases('whitespace between gsd_run and query in the cleanup archive commit', 'gsd-core/workflows/cleanup.md', 'close-phase-todos-stage-deletion',
        (text, gap) => text.replace('gsd_run query commit "chore: archive', `gsd_run${' '.repeat(gap)}query commit "chore: archive`), 20, archiveCommit);
      gapCases('whitespace between query and commit in the cleanup archive commit', 'gsd-core/workflows/cleanup.md', 'close-phase-todos-stage-deletion',
        (text, gap) => text.replace('gsd_run query commit "chore: archive', `gsd_run query${' '.repeat(gap)}commit "chore: archive`), 20, archiveCommit);

      test('an invalid YAML workflow does not stop the other workflow files from being checked by workflow-token-permissions', (t) => {
        const root = copyOfRepoFiles(t);
        fs.writeFileSync(path.join(root, '.github', 'workflows', 'test.yml'), 'this: is: not: valid: [yaml\n');
        fs.writeFileSync(path.join(root, '.github', 'workflows', 'x.yaml'), UNDERPERMISSIONED);
        const findings = runShipped(root, ['workflow-token-permissions']);
        assert.ok(findings.some((f) => f.file === '.github/workflows/test.yml' && /the workflow does not parse/.test(f.message)), JSON.stringify(findings));
        assert.ok(findings.some((f) => f.file === '.github/workflows/x.yaml' && /job "lift" must grant contents: write/.test(f.message)), JSON.stringify(findings));
      });

      // third round: continuation edge cases of the auto-merge walk
      passes('a run ending in a continuation backslash that is not an auto-merge command is clean for workflow-token-permissions', '.github/workflows/test.yml',
        yamlEdit((wf) => { wf.jobs.trailing = { 'runs-on': 'ubuntu-latest', steps: [{ run: 'echo hi \\' }] }; }), 'workflow-token-permissions');
      passes('a long chain of continuation lines that is not an auto-merge command is clean for workflow-token-permissions', '.github/workflows/test.yml',
        yamlEdit((wf) => { wf.jobs.chain = { 'runs-on': 'ubuntu-latest', steps: [{ run: `${'echo hi \\\n'.repeat(5000)}echo done` }] }; }), 'workflow-token-permissions');
      findsOne('a long chain of continuation lines ending in the auto-merge command is read as one command by workflow-token-permissions', '.github/workflows/test.yml',
        yamlEdit((wf) => { wf.jobs.chain = { 'runs-on': 'ubuntu-latest', permissions: { contents: 'read' }, steps: [{ run: `${'gh \\\n'.repeat(5000)}pr merge 7 --auto` }] }; }), 'workflow-token-permissions', 'job "chain" must grant contents: write');
      passes('a gh pr merge without a flag on its line is clean even when --auto sits on the next line of workflow-token-permissions', '.github/workflows/test.yml',
        yamlEdit((wf) => { wf.jobs.nextline = { 'runs-on': 'ubuntu-latest', steps: [{ run: 'gh pr merge 7\necho --auto' }] }; }), 'workflow-token-permissions');
      passes('a word that only contains --auto before a word character is not the flag for workflow-token-permissions', '.github/workflows/test.yml',
        yamlEdit((wf) => { wf.jobs.word = { 'runs-on': 'ubuntu-latest', steps: [{ run: 'gh pr merge 7 --automatic' }] }; }), 'workflow-token-permissions');

      // fourth round: a backslash is a continuation only right before the newline (`\ ` is an escaped space in shell)
      passes('a backslash followed by a space does not join the next line, so --auto there is not the command of workflow-token-permissions', '.github/workflows/test.yml',
        yamlEdit((wf) => { wf.jobs.escaped = { 'runs-on': 'ubuntu-latest', permissions: { contents: 'read' }, steps: [{ run: 'gh pr merge 7 \\ \n--auto' }] }; }), 'workflow-token-permissions');
      passes('a backslash followed by a tab does not join the next line, so --auto there is not the command of workflow-token-permissions', '.github/workflows/test.yml',
        yamlEdit((wf) => { wf.jobs.escaped = { 'runs-on': 'ubuntu-latest', permissions: { contents: 'read' }, steps: [{ run: 'gh pr merge 7 \\\t\n--auto' }] }; }), 'workflow-token-permissions');
  }

  {
      // ── batch 8, group 2 ──────────────────────────────────────────────────────────────────────────────────────────
      // execute-phase-human-needed-uat-merge: `nothing to append[^.]{0,500}(no write|do not write|skip)[^.]{0,500}commit`, both gaps.
      const STEP_A = '**Step A: Persist human verification items';
      const STEP_B = '**Step B: Present to user**';
      const withoutNothingToAppend = (step) => step.replace(/nothing to append[^.]{0,500}(no write|do not write|skip)[^.]{0,500}commit/gi, '');
      gapCases('"nothing to append" and "skip"', 'gsd-core/workflows/execute-phase.md', 'execute-phase-human-needed-uat-merge',
        (text, gap) => within(STEP_A, STEP_B, (step) => `${withoutNothingToAppend(step)}\nnothing to append${'x'.repeat(gap)}skip y commit\n`)(text), 500, /nothing to append must mean no write or commit/);
      gapCases('"skip" and "commit"', 'gsd-core/workflows/execute-phase.md', 'execute-phase-human-needed-uat-merge',
        (text, gap) => within(STEP_A, STEP_B, (step) => `${withoutNothingToAppend(step)}\nnothing to append skip${'y'.repeat(gap)}commit\n`)(text), 500, /nothing to append must mean no write or commit/);

      // init-debug-workflow-contract: `null` ... read this workflow in full, one gap.
      gapCases('`null` and "read this workflow in full"', 'gsd-core/workflows/debug.md', 'init-debug-workflow-contract',
        (text, gap) => `${text.replace(/`null`[^\r\n]{0,500}read this workflow in full/gi, '')}\n\`null\`${'x'.repeat(gap)}read this workflow in full\n`, 500, /null section_manifest must be documented as "read everything"/);

      // debug-symptoms-prefilled-arguments: the five bullets tolerate 20 whitespace characters on each side of the dash; two [^.]{0,500} gaps for the semicolon rule; one for the empty-value rule.
      const STEP_TWO = '## 2. Gather Symptoms';
      for (const [label, rest, bullet, why] of [
        ['Expected behavior', 'What should happen?', /\*\*Expected behavior\*\*\s{0,20}-\s{0,20}What should happen\?/, /original Expected behavior bullet must survive unchanged/],
        ['Actual behavior', 'What happens instead?', /\*\*Actual behavior\*\*\s{0,20}-\s{0,20}What happens instead\?/, /original Actual behavior bullet must survive unchanged/],
        ['Error messages', 'Any errors? (paste or describe)', /\*\*Error messages\*\*\s{0,20}-\s{0,20}Any errors\? \(paste or describe\)/, /original Error messages bullet must survive unchanged/],
        ['Timeline', 'When did this start? Ever worked?', /\*\*Timeline\*\*\s{0,20}-\s{0,20}When did this start\? Ever worked\?/, /original Timeline bullet must survive unchanged/],
        ['Reproduction', 'How do you trigger it?', /\*\*Reproduction\*\*\s{0,20}-\s{0,20}How do you trigger it\?/, /original Reproduction bullet must survive unchanged/],
      ]) {
        gapCases(`whitespace before the dash of the ${label} bullet`, 'gsd-core/workflows/debug.md', 'debug-symptoms-prefilled-arguments',
          (text, gap) => within(STEP_TWO, '\n## ', (step) => step.replace(bullet, `**${label}**${' '.repeat(gap)}- ${rest}`))(text), 20, why);
        gapCases(`whitespace after the dash of the ${label} bullet`, 'gsd-core/workflows/debug.md', 'debug-symptoms-prefilled-arguments',
          (text, gap) => within(STEP_TWO, '\n## ', (step) => step.replace(bullet, `**${label}** -${' '.repeat(gap)}${rest}`))(text), 20, why);
      }
      const withoutSemicolonRule = (step) => step.replace(/semicolon[^.]{0,500}(?:precede|before)[^.]{0,500}(?:label|field)/gi, '');
      gapCases('"semicolon" and "precede"', 'gsd-core/workflows/debug.md', 'debug-symptoms-prefilled-arguments',
        (text, gap) => within(STEP_TWO, '\n## ', (step) => `${withoutSemicolonRule(step)}\nsemicolon${'x'.repeat(gap)}precede y label\n`)(text), 500, /splitting happens on a semicolon that precedes a recognized label/);
      gapCases('"precede" and "label"', 'gsd-core/workflows/debug.md', 'debug-symptoms-prefilled-arguments',
        (text, gap) => within(STEP_TWO, '\n## ', (step) => `${withoutSemicolonRule(step)}\nsemicolon x precede${'y'.repeat(gap)}label\n`)(text), 500, /splitting happens on a semicolon that precedes a recognized label/);
      gapCases('"empty" and "value"', 'gsd-core/workflows/debug.md', 'debug-symptoms-prefilled-arguments',
        (text, gap) => within(STEP_TWO, '\n## ', (step) => `${step.replace(/empty/gi, 'blank')}\nempty${'z'.repeat(gap)}value\n`)(text), 500, /label present with an empty value counts as not supplied/);

      // agent-tracked-source-rule: the planner stays under 49152 characters (49151 passes, 49152 and 49153 fail).
      for (const [length, ok] of [[49151, true], [49152, false], [49153, false]]) {
        test(`the planner at ${length} characters ${ok ? 'satisfies' : 'fails'} agent-tracked-source-rule`, (t) => {
          const root = copyOfRepoFiles(t);
          const abs = path.join(root, 'agents', 'gsd-planner.md');
          const text = fs.readFileSync(abs, 'utf8');
          assert.ok(!text.includes('\r') && text.length < 49151, 'the real planner leaves room to pad to the boundary');
          fs.writeFileSync(abs, text + 'x'.repeat(length - text.length));
          const findings = runShipped(root, ['agent-tracked-source-rule']);
          assert.equal(findings.length, ok ? 0 : 1, JSON.stringify(findings));
        });
      }

      // mvp-phase-spidr: at least three lines name AskUserQuestion (two fails, three and four pass).
      const withAskLines = (keep) => (text) => {
        let seen = 0;
        return text.split('\n').map((line) => {
          if (!/askuserquestion|vscode_askquestions/i.test(line)) return line;
          seen += 1;
          return seen <= keep ? line : line.replace(/askuserquestion|vscode_askquestions/gi, 'a prompt');
        }).join('\n');
      };
      findsOne('mvp-phase with 2 lines naming AskUserQuestion fails mvp-phase-spidr', 'gsd-core/workflows/mvp-phase.md', withAskLines(2), 'mvp-phase-spidr', /at least 3 lines for the story prompts \(found 2\)/);
      passes('mvp-phase with 3 lines naming AskUserQuestion satisfies mvp-phase-spidr', 'gsd-core/workflows/mvp-phase.md', withAskLines(3), 'mvp-phase-spidr');
      passes('mvp-phase with 4 lines naming AskUserQuestion satisfies mvp-phase-spidr', 'gsd-core/workflows/mvp-phase.md', withAskLines(4), 'mvp-phase-spidr');

      // discuss-all-flag: either stated exemption keeps --all out of the auto-advance trigger conditions.
      passes('--all with the "does not trigger auto-advance" note in auto_advance satisfies discuss-all-flag', 'gsd-core/workflows/discuss-phase.md',
        inStepOf('auto_advance', (step) => `${step}\n--all does not trigger auto-advance\n`), 'discuss-all-flag');
      passes('--all with the "is NOT an auto-advance trigger" note in auto_advance satisfies discuss-all-flag', 'gsd-core/workflows/discuss-phase.md',
        inStepOf('auto_advance', (step) => `${step}\n--all is NOT an auto-advance trigger\n`), 'discuss-all-flag');

      // ui-review-next-guidance: an inline verification fence is caught after any amount of whitespace following its label (no bound).
      for (const gap of [199, 200, 201, 1000]) {
        findsOne(`an inline verification fence ${gap} whitespace characters after its label fails ui-review-next-guidance`, 'gsd-core/workflows/manager.md',
          (text) => within('### Compound Action', '### Discuss Phase N', (block) => `${block}\nInline verification:${' '.repeat(gap)}\`\`\`\nSkill(skill="gsd-verify-work", args="{PHASE_NUM}")\n\`\`\`\n`)(text),
          'ui-review-next-guidance', /must not carry an inline verification fence/);
      }

      // secure-phase-single-writer: a comment line inside the tools list does not end it.
      passes('a comment line inside the auditor tools list satisfies secure-phase-single-writer', 'agents/gsd-security-auditor.md',
        (text) => text.replace('  - Read\n', '  - Read\n  # keep the list short\n'), 'secure-phase-single-writer');

      // reviewed-or-maintainer-workflow: a ruleset requiring some other status check is fine.
      passes('a ruleset requiring another status check satisfies reviewed-or-maintainer-workflow', '.github/rulesets/next-queue.json',
        (text) => { const spec = JSON.parse(text); spec.rules.push({ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'some other check' }] } }); return JSON.stringify(spec, null, 2); }, 'reviewed-or-maintainer-workflow');

      // add-todo: `severity:[ \t]{0,20}\[blocker|...` tolerates 20 spaces or tabs after the colon.
      gapCases('whitespace after "severity:" in the add-todo template', 'gsd-core/workflows/add-todo.md', 'add-todo',
        (text, gap) => text.replace(/^severity:[ \t]{0,20}\[blocker\|major\|minor\|cosmetic/gm, `severity:${' '.repeat(gap)}[blocker|major|minor|cosmetic`), 20, /frontmatter template must include a severity field/);

      // progress-debt-segmentation-guard: the non-archived selection tolerates 20 whitespace characters on each side of the pipe.
      gapCases('whitespace before the pipe of the non-archived selection', 'gsd-core/workflows/progress.md', 'progress-debt-segmentation-guard',
        (text, gap) => within('**Step 1.6: Cross-phase health check**', '**Step 1.7:', (step) => step.replace(/select\(has\("archived_milestone"\)\s{0,20}\|\s{0,20}not\)/g, `select(has("archived_milestone")${' '.repeat(gap)}| not)`))(text), 20, /select results WITHOUT the archived_milestone stamp/);
      gapCases('whitespace after the pipe of the non-archived selection', 'gsd-core/workflows/progress.md', 'progress-debt-segmentation-guard',
        (text, gap) => within('**Step 1.6: Cross-phase health check**', '**Step 1.7:', (step) => step.replace(/select\(has\("archived_milestone"\)\s{0,20}\|\s{0,20}not\)/g, `select(has("archived_milestone")|${' '.repeat(gap)}not)`))(text), 20, /select results WITHOUT the archived_milestone stamp/);

      // discuss-all-flag: `argument-hint:[^\n]{0,500}--all` tolerates 500 characters between the key and the flag.
      gapCases('characters between "argument-hint:" and "--all"', 'commands/gsd/discuss-phase.md', 'discuss-all-flag',
        (text, gap) => text.replace(/^argument-hint:.*$/m, `argument-hint:${'x'.repeat(gap)}--all`), 500, /argument-hint should include --all/);

      // secure-phase-single-writer: the frontmatter is found through the shared fence rules (opening fence at byte 0, a BOM tolerated), where the test accepted a `---` pair anywhere.
      findsOne('a blank line before the auditor frontmatter leaves no tools list for secure-phase-single-writer', 'agents/gsd-security-auditor.md', (text) => `\n${text}`, 'secure-phase-single-writer', /tools list should be non-empty/);
      passes('a BOM before the auditor frontmatter still satisfies secure-phase-single-writer', 'agents/gsd-security-auditor.md', (text) => `\uFEFF${text}`, 'secure-phase-single-writer');
      findsOne('an auditor file with no frontmatter fences has no tools list (secure-phase-single-writer)', 'agents/gsd-security-auditor.md', (text) => text.split('\n').filter((line) => line.trim() !== '---').join('\n'), 'secure-phase-single-writer', /tools list should be non-empty/);

      // reviewed-or-maintainer-workflow: an empty rulesets directory is a finding; a ruleset below a subdirectory is not scanned.
      test('no ruleset file under .github/rulesets is a finding for reviewed-or-maintainer-workflow', (t) => {
        const root = copyOfRepoFiles(t);
        // The copy holds every ruleset any batch 8 contract reads: remove them all.
        const rulesetsDir = path.join(root, '.github', 'rulesets');
        for (const name of fs.readdirSync(rulesetsDir)) fs.unlinkSync(path.join(rulesetsDir, name));
        const findings = runShipped(root, ['reviewed-or-maintainer-workflow']);
        assert.ok(findings.some((f) => /no \.json file under \.github\/rulesets/.test(f.message)), JSON.stringify(findings));
      });
      test('a ruleset below a subdirectory of .github/rulesets is not scanned by reviewed-or-maintainer-workflow', (t) => {
        const root = copyOfRepoFiles(t);
        const nested = path.join(root, '.github', 'rulesets', 'sub');
        fs.mkdirSync(nested, { recursive: true });
        fs.writeFileSync(path.join(nested, 'requires-it.json'), JSON.stringify({ rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'Reviewed or maintainer' }] } }] }));
        assert.deepEqual(runShipped(root, ['reviewed-or-maintainer-workflow']), []);
      });

      // reviewed-or-maintainer-workflow: a null entry among the steps does not stop the contract and is not a finding.
      passes('a null step entry in the reviewed-or-maintainer job satisfies reviewed-or-maintainer-workflow', '.github/workflows/reviewed-or-maintainer.yml',
        yamlEdit((d) => { d.jobs['reviewed-or-maintainer'].steps.push(null); }), 'reviewed-or-maintainer-workflow');
  }

  {
      // ---- group 3 controls and boundaries
      const readRepo = (rel) => fs.readFileSync(path.join(REPO_ROOT, ...rel.split('/')), 'utf8');
      // The largest insertion for which `ok(gap)` still holds (the contract's own window, replicated), so the boundary cases follow the real file.
      const maxGap = (ok) => { let gap = 0; while (ok(gap + 1) && gap < 3000) gap += 1; return gap; };

      // doc-writer-no-run-mode: each whitespace gap of "no standalone run mode" is bounded at 20.
      for (const slot of [1, 2, 3]) {
        gapCases(`whitespace gap ${slot} of "no standalone run mode" in the getting-started template`, 'agents/gsd-doc-writer.md', 'doc-writer-no-run-mode',
          (text, gap) => within('<template_getting_started>', '</template_getting_started>', (section) => section.replace(/no\s+standalone\s+run\s+mode/gi,
            ['no', 'standalone', 'run', 'mode'].reduce((joined, word, i) => (i === 0 ? word : `${joined}${' '.repeat(i === slot ? gap : 1)}${word}`), '')))(text), 20, /getting-started "First run" must fall back to an explicit/);
      }

      // package-manifest: a hook file removed from the tree is one finding for that file.
      for (const hook of ['gsd-session-state.sh', 'gsd-validate-commit.sh', 'gsd-phase-boundary.sh']) {
        test(`hooks/${hook} removed from the tree is a finding for package-manifest`, (t) => {
          const root = copyOfRepoFiles(t);
          fs.unlinkSync(path.join(root, 'hooks', hook));
          const findings = runShipped(root, ['package-manifest']);
          assert.ok(findings.some((f) => f.file === `hooks/${hook}` && f.message.includes(`${hook} must exist at hooks/${hook}`)), JSON.stringify(findings));
        });
      }

      // external-job-waiting: every manifest field and status the schema documents, in the manifest-schema section itself
      // (the word is removed there and put back at the top of the page, where it must not count).
      for (const [kind, words] of [['field', ['version', 'job_id', 'plan_id', 'backend', 'status', 'expected_artifacts', 'verification_command', 'resume_command', 'terminal_details']], ['state', ['submitted', 'running', 'completed-unverified', 'failed', 'cancelled', 'timeout']]]) {
        for (const word of words) {
          for (const [where, place] of [
            ['at the top of the page', (scoped) => `${word}\n${scoped}`],
            ['after a sibling ### heading', (scoped) => scoped.replace('\n## Naming conventions', `\n### Sibling\n${word}\n\n## Naming conventions`)],
          ]) {
            test(`${word} only ${where} (outside the planning-artifacts manifest-schema section) fails external-job-waiting (${kind})`, (t) => {
              const root = copyOfRepoFiles(t);
              const abs = path.join(root, 'docs', 'reference', 'planning-artifacts.md');
              const text = fs.readFileSync(abs, 'utf8');
              const scoped = within('### `.planning/async-jobs/<job>.json`', '\n## ', (section) => section.split(word).join(''))(text);
              assert.notEqual(scoped, text, 'the real section carries the word');
              const placed = place(scoped);
              assert.notEqual(placed, scoped, 'the word was placed outside the section');
              fs.writeFileSync(abs, placed);
              const findings = runShipped(root, ['external-job-waiting']);
              assert.ok(findings.some((f) => f.message.includes(kind === 'field' ? `must document the field ${word}` : `must document the state ${word}`)), JSON.stringify(findings));
            });
          }
        }
      }

      // The reference extracts exist: a removed one is a finding.
      for (const [rel, contract, needle] of [
        ['gsd-core/references/debugger-repro-hardening.md', 'debugger-repro-hardening', 'the debugger-repro-hardening.md reference must exist'],
        ['gsd-core/references/debugger-prevention.md', 'debugger-prevention', 'the debugger-prevention.md reference must exist'],
      ]) {
        test(`${rel} removed from the tree is a finding for ${contract}`, (t) => {
          const root = copyOfRepoFiles(t);
          fs.unlinkSync(path.join(root, ...rel.split('/')));
          assert.ok(runShipped(root, [contract]).some((f) => f.message.includes(needle)));
        });
      }

      // debugger-prevention: every Entry-Format KB field appears at least twice (Entry Format and the archive append template).
      const dropAllButFirst = (token) => (text) => {
        const lower = text.toLowerCase();
        const needle = token.toLowerCase();
        const first = lower.indexOf(needle);
        let out = text.slice(0, first + needle.length);
        let from = first + needle.length;
        for (let next = lower.indexOf(needle, from); next !== -1; next = lower.indexOf(needle, from)) {
          out += `${text.slice(from, next)}**x`;
          from = next + needle.length;
        }
        return out + text.slice(from);
      };
      for (const field of ['Date', 'Error patterns', 'Root cause', 'Fix', 'Files changed', 'Why not caught', 'Recurrence guard']) {
        findsOne(`one occurrence of the KB field "${field}" fails debugger-prevention`, 'agents/gsd-debugger.md', dropAllButFirst(`**${field}`), 'debugger-prevention', `the KB field "${field}" must appear in BOTH the Entry Format and the archive append template`);
      }
      // The Phase 0 block is the 1500 characters after its heading.
      {
        const phase0Heading = '**Phase 0: Check knowledge base**';
        const debuggerText = readRepo('agents/gsd-debugger.md');
        const phase0At = debuggerText.indexOf(phase0Heading);
        const phase0Limit = maxGap((gap) => {
          const block = `${phase0Heading}${'x'.repeat(gap)}${debuggerText.slice(phase0At + phase0Heading.length)}`.slice(0, phase0Heading.length + 1500);
          return /why.?not.?caught/i.test(block) && /recurrence.?guard/i.test(block);
        });
        gapCases('characters between the Phase 0 heading and its prevention fields', 'agents/gsd-debugger.md', 'debugger-prevention',
          (text, gap) => text.replace(phase0Heading, `${phase0Heading}${'x'.repeat(gap)}`), phase0Limit, /Phase 0 Evidence line must include why_not_caught \+ recurrence_guard/);
      }
      gapCases('whitespace between "5-" and "whys" in the prevention reference', 'gsd-core/references/debugger-prevention.md', 'debugger-prevention',
        (text, gap) => `${text.replace(/5-?\s*whys|five whys|causal chain/gi, 'x')}\n5-${' '.repeat(gap)}whys\n`, 20, /must document a 5-Whys causal chain/);
      gapCases('characters between "why wasn\'t" and "caught" in the prevention reference', 'gsd-core/references/debugger-prevention.md', 'debugger-prevention',
        (text, gap) => `${text.replace(/why[\s-]?not[\s-]?caught/gi, 'x').replace(/why (?:wasn'?t|was not|didn'?t)[^\n]*(?:caught|prevent)/gi, 'x')}\nwhy wasn't${'y'.repeat(gap)}caught\n`, 500, /must document the "why wasn't this caught\?" question/);

      // debugger-repro-hardening: implicit and crash on one line, within 500 characters.
      gapCases('characters between "implicit" and "weakest" in the repro-hardening reference', 'gsd-core/references/debugger-repro-hardening.md', 'debugger-repro-hardening',
        (text, gap) => `${text.replace(/implicit[^\n]*(?:crash|weakest|weaker)|(?:crash|weakest|weaker)[^\n]*implicit/gi, 'x')}\nimplicit${'y'.repeat(gap)}weakest\n`, 500, /flag implicit\/crash as the weakest oracle/);

      // thread-session-management: path traversal rejection, "reject" and ".." within 200 characters on one line.
      gapCases('characters between "reject" and ".." in the thread workflow', 'gsd-core/workflows/thread.md', 'thread-session-management',
        (text, gap) => `${text.replace(/reject[^\n]*\.\.|\.\.[^\n]*reject/g, 'x').split('..').join('.')}\nreject${'y'.repeat(gap)}..\n`, 200, /missing path traversal rejection for slugs/);

      // ship-note: the phase and PR number on one ship-note line, within 500 characters.
      gapCases('characters between "ship phase ${PHASE_NUMBER}" and "PR #${PR_NUMBER}" in track_shipping', 'gsd-core/workflows/ship.md', 'ship-note',
        (text, gap) => within('<step name="track_shipping">', '</step>', (step) => `${step.replace(/ship phase \$\{PHASE_NUMBER\}[^\n]*PR #\$\{PR_NUMBER\}/g, 'x')}\nship phase \${PHASE_NUMBER}${'y'.repeat(gap)}PR #\${PR_NUMBER}\n`)(text), 500, /must still commit the phase \+ PR-number ship-note into STATE/);

      // partial-init-routing: the windows of the recovery branch (1200 characters after init_incomplete), the planning_exists check
      // (the 600 characters before the no-planning branch), the parse list (400 after "Parse JSON for") and the project_exists gate (1500).
      {
        const progress = readRepo('gsd-core/workflows/progress.md');
        const recoveryAt = progress.indexOf('init_incomplete');
        const recoveryLimit = maxGap((gap) => {
          const text = progress.slice(0, recoveryAt + 'init_incomplete'.length) + 'x'.repeat(gap) + progress.slice(recoveryAt + 'init_incomplete'.length);
          const slice = text.slice(recoveryAt, recoveryAt + 1200);
          return /REQUIREMENTS\.md/.test(slice) && /ROADMAP\.md/.test(slice) && /STATE\.md/.test(slice) && slice.includes('new-project');
        });
        gapCases('characters inside the init_incomplete recovery branch of progress.md', 'gsd-core/workflows/progress.md', 'partial-init-routing',
          (text, gap) => text.replace('init_incomplete', `init_incomplete${'x'.repeat(gap)}`), recoveryLimit, /recovery branch must (name the missing|route to)/);

        const noPlanningAt = progress.indexOf('No planning structure found');
        const noPlanningLimit = maxGap((gap) => (progress.slice(0, noPlanningAt) + 'x'.repeat(gap)).slice(-600).includes('planning_exists'));
        gapCases('characters between planning_exists and the no-planning branch of progress.md', 'gsd-core/workflows/progress.md', 'partial-init-routing',
          (text, gap) => text.replace('No planning structure found', `${'x'.repeat(gap)}No planning structure found`), noPlanningLimit, /no-planning branch must check planning_exists/);

        const resume = readRepo('gsd-core/workflows/resume-project.md');
        const parseAt = resume.indexOf('Parse JSON for');
        const parseLimit = maxGap((gap) => (resume.slice(0, parseAt + 'Parse JSON for'.length) + 'x'.repeat(gap) + resume.slice(parseAt + 'Parse JSON for'.length)).slice(parseAt, parseAt + 400).includes('init_incomplete'));
        gapCases('characters after "Parse JSON for" in resume-project.md', 'gsd-core/workflows/resume-project.md', 'partial-init-routing',
          (text, gap) => text.replace('Parse JSON for', `Parse JSON for${'x'.repeat(gap)}`), parseLimit, /resume parse list must include init_incomplete/);

        const newProject = readRepo('gsd-core/workflows/new-project.md');
        const gateAnchor = newProject.indexOf('project_already') > -1 ? 'project_already' : 'If `project_exists` is true';
        const gateAt = newProject.indexOf(gateAnchor);
        const gateLimit = maxGap((gap) => (newProject.slice(0, gateAt + gateAnchor.length) + 'x'.repeat(gap) + newProject.slice(gateAt + gateAnchor.length)).slice(gateAt, gateAt + 1500).includes('init_incomplete'));
        gapCases('characters inside the project_exists gate of new-project.md', 'gsd-core/workflows/new-project.md', 'partial-init-routing',
          (text, gap) => text.replace(gateAnchor, `${gateAnchor}${'x'.repeat(gap)}`), gateLimit, /project_exists gate must discriminate on init_incomplete/);
      }

      // Both directions of every two-sided bound, with every other alternative of the assertion removed so only the bounded one can satisfy it.
      // debugger-repro-hardening: "store ... minimi" and "minimi ... store" within 500 characters on one line.
      const withoutSeedAlternatives = (text) => text.replace(/regression seed|store[^\n]*minimi|minimi[^\n]*store/gi, 'x');
      gapCases('characters between "store" and "minimize" in the repro-hardening reference', 'gsd-core/references/debugger-repro-hardening.md', 'debugger-repro-hardening',
        (text, gap) => `${withoutSeedAlternatives(text)}\nstore${'y'.repeat(gap)}minimize\n`, 500, /stored as the regression seed/);
      gapCases('characters between "minimize" and "store" in the repro-hardening reference', 'gsd-core/references/debugger-repro-hardening.md', 'debugger-repro-hardening',
        (text, gap) => `${withoutSeedAlternatives(text)}\nminimi${'y'.repeat(gap)}store\n`, 500, /stored as the regression seed/);
      // "n + 1": each whitespace gap bounded at 20, with the off-by-one spellings removed.
      const withoutOffByOne = (text) => text.replace(/off-by-one|off by one|n\s*[+-]\s*1/gi, 'x');
      gapCases('whitespace between "n" and the sign in the repro-hardening reference', 'gsd-core/references/debugger-repro-hardening.md', 'debugger-repro-hardening',
        (text, gap) => `${withoutOffByOne(text)}\nn${' '.repeat(gap)}+ 1\n`, 20, /off-by-one \(N\+-1\) must be documented/);
      gapCases('whitespace between the sign and "1" in the repro-hardening reference', 'gsd-core/references/debugger-repro-hardening.md', 'debugger-repro-hardening',
        (text, gap) => `${withoutOffByOne(text)}\nn +${' '.repeat(gap)}1\n`, 20, /off-by-one \(N\+-1\) must be documented/);
      // "implicit ... weakest" in the other order: "weakest ... implicit".
      const withoutImplicitPairs = (text) => text.replace(/implicit[^\n]*(?:crash|weakest|weaker)|(?:crash|weakest|weaker)[^\n]*implicit/gi, 'x');
      gapCases('characters between "weakest" and "implicit" in the repro-hardening reference', 'gsd-core/references/debugger-repro-hardening.md', 'debugger-repro-hardening',
        (text, gap) => `${withoutImplicitPairs(text)}\nweakest${'y'.repeat(gap)}implicit\n`, 500, /flag implicit\/crash as the weakest oracle/);
      // thread-session-management: ".." before "reject", within 200 characters.
      gapCases('characters between ".." and "reject" in the thread workflow', 'gsd-core/workflows/thread.md', 'thread-session-management',
        (text, gap) => `${text.replace(/reject[^\n]*\.\.|\.\.[^\n]*reject/g, 'x').split('..').join('.')}\n..${'y'.repeat(gap)}reject\n`, 200, /missing path traversal rejection for slugs/);
      // debugger-prevention: old KB entries still load: "without ... fields ... load" (two gaps) and "absent ... field", each within 500.
      const withoutCompatAlternatives = (text) => text.replace(/backward|back.compat|old entries|without[^\n]*fields[^\n]*load|absent[^\n]*field/gi, 'x');
      gapCases('characters between "without" and "fields" in the prevention reference', 'gsd-core/references/debugger-prevention.md', 'debugger-prevention',
        (text, gap) => `${withoutCompatAlternatives(text)}\nwithout${'y'.repeat(gap)}fields load\n`, 500, /old KB entries without the new fields still load/);
      gapCases('characters between "fields" and "load" in the prevention reference', 'gsd-core/references/debugger-prevention.md', 'debugger-prevention',
        (text, gap) => `${withoutCompatAlternatives(text)}\nwithout fields${'y'.repeat(gap)}load\n`, 500, /old KB entries without the new fields still load/);
      gapCases('characters between "absent" and "field" in the prevention reference', 'gsd-core/references/debugger-prevention.md', 'debugger-prevention',
        (text, gap) => `${withoutCompatAlternatives(text)}\nabsent${'y'.repeat(gap)}field\n`, 500, /old KB entries without the new fields still load/);
      // debugger-prevention: "why wasn't ... prevent" (the other end of the alternative that ends in caught).
      const withoutWhyCaught = (text) => text.replace(/why[\s-]?not[\s-]?caught/gi, 'x').replace(/why (?:wasn'?t|was not|didn'?t)[^\n]*(?:caught|prevent)/gi, 'x');
      gapCases('characters between "why wasn\'t" and "prevent" in the prevention reference', 'gsd-core/references/debugger-prevention.md', 'debugger-prevention',
        (text, gap) => `${withoutWhyCaught(text)}\nwhy wasn't${'y'.repeat(gap)}prevent\n`, 500, /must document the "why wasn't this caught\?" question/);

      // context7-tool-name-parity: the historical release notes are out of the scan, the kept tool name must survive somewhere,
      // and the scan surface must hold more than 50 files (51 passes, 50 and 49 fail).
      test('the banned tool name in docs/RELEASE-NOTES-LEGACY.md (a historical record) is outside the context7 scan', (t) => {
        const root = copyOfRepoFiles(t);
        fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(root, 'docs', 'RELEASE-NOTES-LEGACY.md'), 'Old note: call mcp__context7__get-library-docs.\n');
        assert.deepEqual(runShipped(root, ['context7-tool-name-parity']), []);
      });
      const scanSurface = (root) => {
        const found = [];
        const walk = (dir) => {
          for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
            const rel = `${dir}/${entry.name}`;
            if (entry.isDirectory()) walk(rel);
            else if (entry.isFile() && entry.name.endsWith('.md')) found.push(rel);
          }
        };
        for (const dir of ['agents', 'gsd-core/references', 'gsd-core/workflows', 'commands/gsd', 'skills', 'docs']) walk(dir);
        return found.sort();
      };
      test('resolve-library-id named nowhere in the scan surface fails context7-tool-name-parity', (t) => {
        const root = copyOfRepoFiles(t);
        for (const rel of scanSurface(root)) {
          const abs = path.join(root, ...rel.split('/'));
          const text = fs.readFileSync(abs, 'utf8');
          if (text.includes('mcp__context7__resolve-library-id')) fs.writeFileSync(abs, text.split('mcp__context7__resolve-library-id').join('mcp__context7__resolve'));
        }
        assert.ok(runShipped(root, ['context7-tool-name-parity']).some((f) => f.message.includes('mcp__context7__resolve-library-id must still appear in shipped artifacts')));
      });
      for (const [surface, ok] of [[49, false], [50, false], [51, true]]) {
        test(`a scan surface of ${surface} markdown files ${ok ? 'satisfies' : 'fails'} context7-tool-name-parity`, (t) => {
          const root = copyOfRepoFiles(t);
          const keep = new Set(['gsd-core/references/research-documentation-lookup.md']);
          for (const rel of scanSurface(root)) {
            if (fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8').includes('mcp__context7__resolve-library-id')) keep.add(rel);
          }
          // Any scan-surface file may go (only this contract runs here), except the ones the contract needs.
          const removable = scanSurface(root).filter((rel) => !keep.has(rel));
          const excess = scanSurface(root).length - surface;
          assert.ok(excess >= 0 && excess <= removable.length, 'the copy can be trimmed to the boundary');
          for (const rel of removable.slice(0, excess)) fs.unlinkSync(path.join(root, ...rel.split('/')));
          assert.equal(scanSurface(root).length, surface);
          const findings = runShipped(root, ['context7-tool-name-parity']);
          if (ok) assert.deepEqual(findings, []);
          else assert.ok(findings.some((f) => f.message.includes('the scan surface must hold more than 50 markdown files')), JSON.stringify(findings));
        });
      }
  }

  {
    {
      // Batch 8, group 4: controls and boundaries. Helpers are local to this block.
      const g4LacksGapCases = (label, rel, contract, build, limit, whyMatch) => {
        for (const [gap, caught] of [[limit - 1, true], [limit, true], [limit + 1, false]]) {
          test(`${label} with a gap of ${gap} characters ${caught ? 'is caught by' : 'is past the bound of'} ${contract}`, (t) => {
            const root = copyOfRepoFiles(t);
            const abs = path.join(root, ...rel.split('/'));
            fs.writeFileSync(abs, build(fs.readFileSync(abs, 'utf8'), gap));
            const findings = runShipped(root, [contract]);
            if (caught) assert.ok(findings.some((f) => whyMatch.test(f.message)), JSON.stringify(findings));
            else assert.deepEqual(findings, []);
          });
        }
      };
      const g4Spaces = (n) => ' '.repeat(n);
      // Past a bound the line is still a finding (not silently dropped): limit - 1 and limit are caught by whyAtLimit, limit + 1 by whyPast.
      const g4BoundCases = (label, rel, contract, build, limit, whyAtLimit, whyPast) => {
        for (const [gap, why] of [[limit - 1, whyAtLimit], [limit, whyAtLimit], [limit + 1, whyPast]]) {
          test(`${label} with a gap of ${gap} characters is a finding of ${contract}`, (t) => {
            const root = copyOfRepoFiles(t);
            const abs = path.join(root, ...rel.split('/'));
            fs.writeFileSync(abs, build(fs.readFileSync(abs, 'utf8'), gap));
            const findings = runShipped(root, [contract]);
            assert.ok(findings.some((f) => why.test(f.message)), JSON.stringify(findings));
          });
        }
      };

      // planner-mvp-mode: the two referenced files exist
      for (const rel of ['gsd-core/references/planner-mvp-mode.md', 'gsd-core/references/skeleton-template.md']) {
        test(`${rel} removed from the tree is a finding for planner-mvp-mode`, (t) => {
          const root = copyOfRepoFiles(t);
          fs.unlinkSync(path.join(root, ...rel.split('/')));
          const name = rel.split('/').pop();
          assert.ok(runShipped(root, ['planner-mvp-mode']).some((f) => f.message.includes(`${name} must exist`)));
        });
      }
      // planner-mvp-mode: bounds (limit - 1, limit, limit + 1)
      gapCases('whitespace inside "MVP Mode"', 'agents/gsd-planner.md', 'planner-mvp-mode',
        (text, gap) => `${text.replace(/MVP\s*Mode|MVP_MODE/gi, '')}\nMVP${g4Spaces(gap)}Mode\n`, 20, /must reference MVP mode/);
      gapCases('whitespace inside "Walking Skeleton"', 'agents/gsd-planner.md', 'planner-mvp-mode',
        (text, gap) => `${text.replace(/Walking\s*Skeleton/gi, '')}\nWalking${g4Spaces(gap)}Skeleton\n`, 20, /must mention Walking Skeleton/);
      gapCases('whitespace inside "Phase Goal"', 'agents/gsd-planner.md', 'planner-mvp-mode',
        (text, gap) => `${text.replace(/Phase\s*Goal/gi, '')}\nPhase${g4Spaces(gap)}Goal\n`, 20, /must mention the "Phase Goal" header/);
      gapCases('hyphens inside "vertical-slice"', 'agents/gsd-planner.md', 'planner-mvp-mode',
        (text, gap) => `${text.replace(/vertical[\s-]?slice/gi, '')}\nvertical${'-'.repeat(gap)}slice\n`, 2, /must use vertical-slice terminology/);
      gapCases('the gap between "**As a**" and "**I want to**"', 'agents/gsd-planner.md', 'planner-mvp-mode',
        (text, gap) => `${text.replace(/\*\*As a\*\*[^\n]*\*\*I want to\*\*[^\n]*\*\*so that\*\*/gi, '')}\n**As a**${'x'.repeat(gap)}**I want to** y **so that**\n`, 500, /must specify the bolded user-story format/);
      gapCases('the gap between "**I want to**" and "**so that**"', 'agents/gsd-planner.md', 'planner-mvp-mode',
        (text, gap) => `${text.replace(/\*\*As a\*\*[^\n]*\*\*I want to\*\*[^\n]*\*\*so that\*\*/gi, '')}\n**As a** x **I want to**${'y'.repeat(gap)}**so that**\n`, 500, /must specify the bolded user-story format/);
      g4LacksGapCases('the gap between "mix" and "horizontal"', 'agents/gsd-planner.md', 'planner-mvp-mode',
        (text, gap) => `${text}\nmix${g4Spaces(gap)}horizontal MVP\n`, 500, /agent must enforce all-or-nothing per phase/);
      g4LacksGapCases('the gap between "horizontal" and "MVP"', 'agents/gsd-planner.md', 'planner-mvp-mode',
        (text, gap) => `${text}\nmix horizontal${g4Spaces(gap)}MVP\n`, 500, /agent must enforce all-or-nothing per phase/);
      g4LacksGapCases('the gap between "MVP" and "and"', 'agents/gsd-planner.md', 'planner-mvp-mode',
        (text, gap) => `${text}\nMVP${g4Spaces(gap)}and horizontal tasks\n`, 500, /agent must enforce all-or-nothing per phase/);
      g4LacksGapCases('the gap between "and" and "horizontal"', 'agents/gsd-planner.md', 'planner-mvp-mode',
        (text, gap) => `${text}\nMVP and${g4Spaces(gap)}horizontal tasks\n`, 500, /agent must enforce all-or-nothing per phase/);
      g4LacksGapCases('the gap between "horizontal" and "tasks"', 'agents/gsd-planner.md', 'planner-mvp-mode',
        (text, gap) => `${text}\nMVP and horizontal${g4Spaces(gap)}tasks\n`, 500, /agent must enforce all-or-nothing per phase/);

      // codebase-mapper-date-restamp: the overwrite-site floor of five (four: fails, five: passes)
      const g4KeepSites = (keep) => (text) => {
        let seen = 0;
        return text.replace(/overwrit(?:e|ing) any existing date/gi, (match) => { seen += 1; return seen <= keep ? match : 'XX'; });
      };
      findsOne('map-codebase with four overwrite sites fails codebase-mapper-date-restamp', 'gsd-core/workflows/map-codebase.md', g4KeepSites(4), 'codebase-mapper-date-restamp', /found 4, expected at least 5/);
      passes('map-codebase with five overwrite sites satisfies codebase-mapper-date-restamp', 'gsd-core/workflows/map-codebase.md', (text) => `${g4KeepSites(5)(text)}\nNotes on the date instructions.\n`, 'codebase-mapper-date-restamp');
      // codebase-mapper-date-restamp: bounds
      gapCases('whitespace between "overwrite" and "any"', 'agents/gsd-codebase-mapper.md', 'codebase-mapper-date-restamp',
        (text, gap) => `${text.replace(/overwrit(?:e|ing)\s+(?:any|whatever)[^.\n]*date/gi, '')}\noverwrite${g4Spaces(gap)}any date\n`, 20, /must tell the agent to overwrite a prior concrete date/);
      gapCases('characters between "any" and "date"', 'agents/gsd-codebase-mapper.md', 'codebase-mapper-date-restamp',
        (text, gap) => `${text.replace(/overwrit(?:e|ing)\s+(?:any|whatever)[^.\n]*date/gi, '')}\noverwrite any${'x'.repeat(gap)}date\n`, 500, /must tell the agent to overwrite a prior concrete date/);

      // quick-session-management: the reject ... ".." bound
      gapCases('characters between "reject" and ".."', 'commands/gsd/quick.md', 'quick-session-management',
        (text, gap) => `${text.replace(/reject[^\n]*\.\./gi, '')}\nreject${'x'.repeat(gap)}..\n`, 200, /missing path traversal rejection for slugs/);

      // diagnose-issues-workflow: bounds and the template scan
      const g4DebugBlock = '<debug_file>\nCreate: .planning/debug/{slug}.md\n</debug_file>';
      gapCases('whitespace between <debug_file> and Create', 'gsd-core/workflows/diagnose-issues.md', 'diagnose-issues-workflow',
        (text, gap) => text.replace(g4DebugBlock, `<debug_file>${g4Spaces(gap)}Create: .planning/debug/{slug}.md\n</debug_file>`), 20, /the inline prompt must carry the debug-file target/);
      gapCases('whitespace between {slug}.md and </debug_file>', 'gsd-core/workflows/diagnose-issues.md', 'diagnose-issues-workflow',
        (text, gap) => text.replace(g4DebugBlock, `<debug_file>\nCreate: .planning/debug/{slug}.md${g4Spaces(gap)}</debug_file>`), 20, /the inline prompt must carry the debug-file target/);
      g4LacksGapCases('a template name', 'gsd-core/workflows/diagnose-issues.md', 'diagnose-issues-workflow',
        (text, gap) => `${text}\nfill the ${'a'.repeat(gap)} template\n`, 100, /must resolve to templates\//);
      passes('a workflow that fills a template that exists satisfies diagnose-issues-workflow', 'gsd-core/workflows/diagnose-issues.md', append('Then fill the phase-prompt template.'), 'diagnose-issues-workflow');
      test('a nested workflow that fills a template that does not exist fails diagnose-issues-workflow', (t) => {
        const root = copyOfRepoFiles(t);
        write(root, 'gsd-core/workflows/sub/deep.md', 'Then fill the nonexistent-thing template.\n');
        assert.ok(runShipped(root, ['diagnose-issues-workflow']).some((f) => /sub\/deep\.md: .* must resolve to templates\/nonexistent-thing\.md/.test(f.message)));
      });

      // auto-chain-transition-delegation: the three whitespace gaps of the skip set are bounded at 20
      const g4SkipSet = (slot) => (text, gap) => text.replace(/SKIP\s+`verify_completion`\s+and\s+`update_roadmap_and_state`/i, () => {
        const gaps = [1, 1, 1];
        gaps[slot] = gap;
        return `SKIP${g4Spaces(gaps[0])}\`verify_completion\`${g4Spaces(gaps[1])}and${g4Spaces(gaps[2])}\`update_roadmap_and_state\``;
      });
      for (const [slot, name] of [[0, 'SKIP and `verify_completion`'], [1, '`verify_completion` and "and"'], [2, '"and" and `update_roadmap_and_state`']]) {
        gapCases(`whitespace between ${name}`, 'gsd-core/workflows/transition.md', 'auto-chain-transition-delegation', g4SkipSet(slot), 20, /the mode must name the exact skip set/);
      }

      // config-get-raw-guard: exempt shapes and bounds
      const g4Execute = 'gsd-core/workflows/execute-phase.md';
      for (const [title, line] of [
        ['a substitution with --raw', 'MODE=$(gsd_run query config-get mode --raw)'],
        ['a substitution into a variable ending in _JSON', 'CFG_JSON=$(gsd_run query config-get cfg)'],
        ["a substitution with a '[]' default", "LIST=$(gsd_run query config-get list --default '[]')"],
        ['a substitution with a "[]" default', 'LIST=$(gsd_run query config-get list --default "[]")'],
        ['a substitution with --raw before a || fallback', 'MODE=$(gsd_run query config-get mode --raw || echo "")'],
        ['a prose mention of config-get', 'Run config-get to read the mode.'],
      ]) {
        passes(`${title} satisfies config-get-raw-guard`, g4Execute, append(line), 'config-get-raw-guard');
      }
      g4LacksGapCases('characters before config-get inside the substitution', g4Execute, 'config-get-raw-guard',
        (text, gap) => `${text}\nX=$(${'a'.repeat(gap)}config-get)\n`, 2000, /a config-get command substitution without --raw/);
      g4LacksGapCases('characters after config-get inside the substitution', g4Execute, 'config-get-raw-guard',
        (text, gap) => `${text}\nX=$(config-get${'a'.repeat(gap)})\n`, 2000, /a config-get command substitution without --raw/);
      // The receiving variable name (exempt as *_JSON) is read from at most 201 characters, indented by at most 50.
      gapCases('the length of a *_JSON variable name', g4Execute, 'config-get-raw-guard',
        (text, gap) => `${text}\n${'A'.repeat(gap - 5)}_JSON=$(gsd_run query config-get k)\n`, 201, /a config-get command substitution without --raw/);
      gapCases('the indentation before a *_JSON assignment', g4Execute, 'config-get-raw-guard',
        (text, gap) => `${text}\n${g4Spaces(gap)}K_JSON=$(gsd_run query config-get k)\n`, 50, /a config-get command substitution without --raw/);
      gapCases('whitespace between --default and its [] value', g4Execute, 'config-get-raw-guard',
        (text, gap) => `${text}\nX=$(gsd_run query config-get k --default${g4Spaces(gap)}'[]')\n`, 20, /a config-get command substitution without --raw/);
      // The self-check floor: more than 20 substitutions must be scanned (19 and 20 fail, 21 passes).
      for (const [count, ok] of [[19, false], [20, false], [21, true]]) {
        test(`${count} config-get substitutions in the scanned roots ${ok ? 'satisfy' : 'fail'} the self-check of config-get-raw-guard`, (t) => {
          const root = tempDir(t, 'gsd-g4-config-get-');
          write(root, 'gsd-core/workflows/a.md', `${Array.from({ length: count }, (_, i) => `V${i}=$(gsd_run query config-get k${i} --raw)`).join('\n')}\n`);
          for (const rel of ['commands/c.md', 'agents/a.md', 'skills/s.md']) write(root, rel, 'nothing here\n');
          const findings = runShipped(root, ['config-get-raw-guard']);
          if (ok) assert.deepEqual(findings, []);
          else assert.ok(findings.some((f) => /guard self-check/.test(f.message)), JSON.stringify(findings));
        });
      }
      test('a missing scan root is a finding for config-get-raw-guard', (t) => {
        const root = tempDir(t, 'gsd-g4-config-get-');
        for (const rel of ['commands/c.md', 'agents/a.md', 'skills/s.md']) write(root, rel, 'nothing here\n');
        assert.ok(runShipped(root, ['config-get-raw-guard']).some((f) => f.file === 'gsd-core/workflows' && /cannot read the directory/.test(f.message)));
      });

      // next-queue-ruleset: ranges and sizing (a value below the floor fails, the floor and above pass)
      const g4Queue = '.github/rulesets/next-queue.json';
      for (const [value, ok] of [[0, false], [1, true], [360, true], [361, false]]) {
        const edit = swap('"check_response_timeout_minutes": 90', `"check_response_timeout_minutes": ${value}`);
        if (ok) passes(`check_response_timeout_minutes ${value} satisfies next-queue-ruleset`, g4Queue, edit, 'next-queue-ruleset');
        else findsOne(`check_response_timeout_minutes ${value} fails next-queue-ruleset`, g4Queue, edit, 'next-queue-ruleset', 'check_response_timeout_minutes must be an integer within the REST range 1..360');
      }
      for (const [key, from, value, ok] of [
        ['min_entries_to_merge', '"min_entries_to_merge": 2', 0, false], ['min_entries_to_merge', '"min_entries_to_merge": 2', 1, true],
        ['min_entries_to_merge equal to max_entries_to_merge', '"min_entries_to_merge": 2', 3, true], ['min_entries_to_merge one above max_entries_to_merge', '"min_entries_to_merge": 2', 4, false],
        ['max_entries_to_build', '"max_entries_to_build": 2', 0, false], ['max_entries_to_build', '"max_entries_to_build": 2', 1, true],
        ['min_entries_to_merge_wait_minutes', '"min_entries_to_merge_wait_minutes": 15', -1, false], ['min_entries_to_merge_wait_minutes', '"min_entries_to_merge_wait_minutes": 15', 0, true],
      ]) {
        const name = from.split('"')[1];
        const edit = swap(from, `"${name}": ${value}`);
        if (ok) passes(`${key} at ${value} satisfies next-queue-ruleset`, g4Queue, edit, 'next-queue-ruleset');
        else findsOne(`${key} at ${value} fails next-queue-ruleset`, g4Queue, edit, 'next-queue-ruleset', 'group sizing must be coherent');
      }
      // The bypass actor is compared field by field, whatever the key order of the committed file.
      passes('a bypass actor with its keys in another order satisfies next-queue-ruleset', g4Queue,
        swap('{ "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }', '{ "bypass_mode": "always", "actor_type": "RepositoryRole", "actor_id": 5 }'), 'next-queue-ruleset');
      findsOne('a bypass actor with an extra field fails next-queue-ruleset', g4Queue,
        swap('"bypass_mode": "always" }', '"bypass_mode": "always", "note": "x" }'), 'next-queue-ruleset', 'exactly one bypass actor, the repository Admin role');
      test('a merge_queue rule with null parameters is a finding for each parameter check of next-queue-ruleset, not a crash', (t) => {
        const root = copyOfRepoFiles(t);
        const abs = path.join(root, ...g4Queue.split('/'));
        fs.writeFileSync(abs, swap('"parameters": {', '"parameters": null, "parameters_x": {')(fs.readFileSync(abs, 'utf8')));
        const findings = runShipped(root, ['next-queue-ruleset']);
        assert.equal(findings.filter((f) => f.message.includes('merge_queue has no parameters')).length, 5, JSON.stringify(findings));
      });
      // sync-skills-cross-runtime-refuse needs no bound case: its regexes are literal.

      // template-phase-prompt-dependson-3427: the example floor of eight (seven fails, eight and nine pass) and the line bounds
      const g4KeepExamples = (keep) => (text) => {
        let seen = 0;
        return text.split('\n').map((line) => (/^[ \t]*depends_on:[ \t]*\[/.test(line) ? ((seen += 1) <= keep ? line : 'x') : line)).join('\n');
      };
      findsOne('a template with seven depends_on examples fails template-phase-prompt-dependson-3427', 'gsd-core/templates/phase-prompt.md', g4KeepExamples(7), 'template-phase-prompt-dependson-3427', /found 7 depends_on examples, expected at least 8/);
      passes('a template with eight depends_on examples satisfies template-phase-prompt-dependson-3427', 'gsd-core/templates/phase-prompt.md', g4KeepExamples(8), 'template-phase-prompt-dependson-3427');
      passes('a template with nine depends_on examples satisfies template-phase-prompt-dependson-3427', 'gsd-core/templates/phase-prompt.md', g4KeepExamples(9), 'template-phase-prompt-dependson-3427');
      const g4Shape = /every non-empty depends_on example must list full-form plan ids/;
      const g4Template = 'gsd-core/templates/phase-prompt.md';
      g4BoundCases('the indentation before a short-form depends_on', g4Template, 'template-phase-prompt-dependson-3427',
        (text, gap) => `${text}\n${g4Spaces(gap)}depends_on: ["01"]\n`, 50, g4Shape, /cannot be parsed by the example pattern/);
      g4BoundCases('the whitespace after "depends_on:"', g4Template, 'template-phase-prompt-dependson-3427',
        (text, gap) => `${text}\ndepends_on:${g4Spaces(gap)}["01"]\n`, 50, g4Shape, /cannot be parsed by the example pattern/);
      g4BoundCases('the length of the depends_on list', g4Template, 'template-phase-prompt-dependson-3427',
        (text, gap) => `${text}\ndepends_on: ["01"${g4Spaces(gap - 4)}]\n`, 500, g4Shape, /cannot be parsed by the example pattern/);
      g4BoundCases('the whitespace after the depends_on list', g4Template, 'template-phase-prompt-dependson-3427',
        (text, gap) => `${text}\ndepends_on: ["01"]${g4Spaces(gap)}\n`, 50, g4Shape, /cannot be parsed by the example pattern/);
      g4BoundCases('the trailing comment of a short-form depends_on', g4Template, 'template-phase-prompt-dependson-3427',
        (text, gap) => `${text}\ndepends_on: ["01"] #${'c'.repeat(gap)}\n`, 500, g4Shape, /cannot be parsed by the example pattern/);
      passes('the real phase-prompt template has no unparsed depends_on line', g4Template, append('Notes on depends_on usage.'), 'template-phase-prompt-dependson-3427');
      test('good and bad depends_on samples classify correctly (the helper of template-phase-prompt-dependson-3427)', () => {
        const { extractDependsOnExamples, shortFormTokens } = textContracts.loadContracts().find((c) => c.id === 'template-phase-prompt-dependson-3427');
        const good = extractDependsOnExamples(['depends_on: []', 'depends_on: ["03-01"]', 'depends_on: ["03-01", "03-02"]  # trailing comment', 'depends_on: ["01-01"]'].join('\n'));
        assert.deepEqual(shortFormTokens(good), []);
        const bad = extractDependsOnExamples(['depends_on: ["01"]', 'depends_on: ["01", "02"]'].join('\n'));
        assert.equal(shortFormTokens(bad).length, 3); // both tokens of line 2 and the one of line 1
      });

      // release-finalize-syncs-next-version: the gate is read from the sync step itself, not from the whole finalize job
      const g4EditSyncStep = (edit) => (text) => {
        const lines = text.split('\n');
        const finalizeAt = lines.findIndex((line) => line.trimEnd() === '  finalize:');
        const hit = lines.findIndex((line, i) => i > finalizeAt && line.includes('scripts/sync-next-version.cjs'));
        let start = hit;
        while (start > finalizeAt && !/^\s{6}- name:/.test(lines[start])) start -= 1;
        let end = hit + 1;
        while (end < lines.length && !/^\s{6}- name:/.test(lines[end])) end += 1;
        return [...lines.slice(0, start), ...edit(lines.slice(start, end)), ...lines.slice(end)].join('\n');
      };
      findsOne('the gate removed from the finalize sync step only (another step keeps its gate) fails release-finalize-syncs-next-version', '.github/workflows/release.yml',
        g4EditSyncStep((step) => step.map((line) => line.split('!inputs.dry_run').join('true'))), 'release-finalize-syncs-next-version', /the sync-next-version step itself must be gated on !inputs\.dry_run/);
    }
  }

  // A file a batch 8 contract reads that is gone from the tree is one finding for that file.
  for (const [rel, contract] of [
    ['.github/workflows/dependabot-auto-merge.yml', 'workflow-token-permissions'],
    ['agents/gsd-verifier.md', 'verifier-gsd-run-all-modes'],
    ['gsd-core/references/prohibition-probe.md', 'prohibition-probe.docs-fixtures'],
    ['gsd-core/references/prohibition-probe-fixtures/01-streak-reminder/expected.json', 'prohibition-probe.docs-fixtures'],
    ['gsd-core/bin/shared/config-defaults.manifest.json', 'inline-plan-threshold-default'],
    ['gsd-core/workflows/settings-advanced.md', 'inline-plan-threshold-default'],
    ['gsd-core/references/planning-config.md', 'inline-plan-threshold-default'],
    ['gsd-core/references/ui-consideration-probe.md', 'ui-consideration-probe-docs-fixtures'],
    ['gsd-core/references/domain-probes.md', 'ui-consideration-probe-docs-fixtures'],
    ['gsd-core/templates/UI-SPEC.md', 'ui-consideration-probe-docs-fixtures'],
    ['docs/INVENTORY.md', 'localized-inventory-agent-counts'],
    ['commands/gsd/mvp-phase.md', 'mvp-phase-command'],
    ['gsd-core/workflows/plan-phase.md', 'prohibition-probe.planner-contract'],
    ['gsd-core/templates/planner-subagent-prompt.md', 'prohibition-probe.planner-contract'],
    ['gsd-core/references/debugger-semantic-recall.md', 'debugger-semantic-recall'],
    ['agents/gsd-debugger.md', 'debugger-semantic-recall'],
    ['gsd-core/bin/lib/milestone.cjs', 'atomic-write-coverage'],
    ['gsd-core/bin/lib/phase.cjs', 'atomic-write-coverage'],
    ['gsd-core/bin/lib/frontmatter.cjs', 'atomic-write-coverage'],
    ['gsd-core/workflows/execute-phase.md', 'close-phase-todos-stage-deletion'],
    ['gsd-core/workflows/cleanup.md', 'close-phase-todos-stage-deletion'],
    ['gsd-core/workflows/add-todo.md', 'add-todo'],
    ['gsd-core/workflows/progress.md', 'progress-debt-segmentation-guard'],
    ['gsd-core/workflows/execute-phase.md', 'execute-phase-human-needed-uat-merge'],
    ['agents/gsd-security-auditor.md', 'secure-phase-single-writer'],
    ['gsd-core/workflows/mvp-phase.md', 'mvp-phase-spidr'],
    ['agents/gsd-ui-researcher.md', 'ui-researcher-inventory-self-check'],
    ['agents/gsd-ui-researcher.compact.md', 'ui-researcher-inventory-self-check'],
    ['agents/gsd-ui-checker.md', 'ui-researcher-inventory-self-check'],
    ['gsd-core/workflows/debug.md', 'init-debug-workflow-contract'],
    ['gsd-core/workflows/plan-phase.md', 'agent-tracked-source-rule'],
    ['agents/gsd-pattern-mapper.md', 'agent-tracked-source-rule'],
    ['agents/gsd-planner.md', 'agent-tracked-source-rule'],
    ['commands/gsd/discuss-phase.md', 'discuss-all-flag'],
    ['gsd-core/workflows/discuss-phase.md', 'discuss-all-flag'],
    ['docs/COMMANDS.md', 'discuss-all-flag'],
    ['gsd-core/workflows/ui-review.md', 'ui-review-next-guidance'],
    ['gsd-core/workflows/verify-work.md', 'ui-review-next-guidance'],
    ['gsd-core/workflows/manager.md', 'ui-review-next-guidance'],
    ['gsd-core/workflows/debug.md', 'debug-symptoms-prefilled-arguments'],
    ['.github/workflows/reviewed-or-maintainer.yml', 'reviewed-or-maintainer-workflow'],
    ['agents/gsd-doc-writer.md', 'doc-writer-no-run-mode'],
    ['agents/gsd-doc-writer.compact.md', 'doc-writer-no-run-mode'],
    ['.github/workflows/release.yml', 'release-finalize-notes-5922'],
    ['gsd-core/workflows/ship.md', 'check-predicate-dispatch-phase-flags-4483'],
    ['gsd-core/workflows/verify-work.md', 'check-predicate-dispatch-phase-flags-4483'],
    ['gsd-core/workflows/ship.md', 'ship-note'],
    ['package.json', 'package-manifest'],
    ['gsd-core/workflows/execute-plan.md', 'external-job-waiting'],
    ['docs/reference/planning-artifacts.md', 'external-job-waiting'],
    ['CONTEXT.md', 'external-job-waiting'],
    ['gsd-core/workflows/progress.md', 'partial-init-routing'],
    ['gsd-core/workflows/resume-project.md', 'partial-init-routing'],
    ['gsd-core/workflows/new-project.md', 'partial-init-routing'],
    ['agents/gsd-debugger.md', 'debugger-repro-hardening'],
    ['gsd-core/references/debugger-repro-hardening.md', 'debugger-repro-hardening'],
    ['gsd-core/templates/DEBUG.md', 'debugger-repro-hardening'],
    ['gsd-core/workflows/thread.md', 'thread-session-management'],
    ['gsd-core/references/research-documentation-lookup.md', 'context7-tool-name-parity'],
    ['agents/gsd-debugger.md', 'debugger-prevention'],
    ['gsd-core/references/debugger-prevention.md', 'debugger-prevention'],
    ['agents/gsd-debug-session-manager.md', 'debugger-prevention'],
    ['.github/workflows/docs-required.yml', 'policy-lint-shallow-checkout'],
    ['.github/workflows/changeset-required.yml', 'policy-lint-shallow-checkout'],
    ['agents/gsd-planner.md', 'planner-mvp-mode'],
    ['agents/gsd-codebase-mapper.md', 'codebase-mapper-date-restamp'],
    ['gsd-core/workflows/map-codebase.md', 'codebase-mapper-date-restamp'],
    ['commands/gsd/quick.md', 'quick-session-management'],
    ['gsd-core/workflows/diagnose-issues.md', 'diagnose-issues-workflow'],
    ['gsd-core/workflows/transition.md', 'auto-chain-transition-delegation'],
    ['gsd-core/workflows/execute-phase.md', 'auto-chain-transition-delegation'],
    ['.github/rulesets/next-queue.json', 'next-queue-ruleset'],
    ['gsd-core/workflows/sync-skills.md', 'sync-skills-cross-runtime-refuse'],
    ['gsd-core/templates/phase-prompt.md', 'template-phase-prompt-dependson-3427'],
    ['.github/workflows/release.yml', 'release-finalize-syncs-next-version'],
  ]) {
    test(`${rel} removed from the tree is a finding for ${contract}`, (t) => {
      const root = copyOfRepoFiles(t);
      fs.unlinkSync(path.join(root, ...rel.split('/')));
      const findings = runShipped(root, [contract]);
      assert.ok(findings.some((f) => f.file === rel && /cannot read the file/.test(f.message)), JSON.stringify(findings));
    });
  }
});
