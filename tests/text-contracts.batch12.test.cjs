'use strict';

/**
 * text-contracts.batch12.test.cjs
 *
 * Detection cases for the 13 text contracts of ADR-6315 item 19 batch 12 (#6654, #6337): each contract against a
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
const SHIPPED = require('./helpers/text-contracts-batch12-ids.cjs');

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

describe('the batch 12 contracts hold on the real files, and fail when a contracted phrase goes', () => {
  // The files each contract reads, copied into a temporary root so one phrase can be removed.
  const FILES = [
    '.github/workflows/pr-target-validator.yml',
    '.github/workflows/release.yml',
    'agents/gsd-executor.md',
    'agents/gsd-phase-researcher.md',
    'agents/gsd-plan-checker.md',
    'agents/gsd-planner.md',
    'commands/gsd/audit-fix.md',
    'commands/gsd/explore.md',
    'commands/gsd/phase.md',
    'commands/gsd/progress.md',
    'docs/COMMANDS.md',
    'docs/INVENTORY-MANIFEST.json',
    'docs/INVENTORY.md',
    'docs/reference/agents.md',
    'gsd-core/references/agent-contracts.md',
    'gsd-core/references/edge-probe.md',
    'gsd-core/references/execute-mvp-tdd.md',
    'gsd-core/references/planner-coupling.md',
    'gsd-core/references/revision-loop.md',
    'gsd-core/references/specless-probe-fallback.md',
    'gsd-core/references/tdd.md',
    'gsd-core/workflows/audit-fix.md',
    'gsd-core/workflows/code-review-fix.md',
    'gsd-core/workflows/code-review.md',
    'gsd-core/workflows/edit-phase.md',
    'gsd-core/workflows/execute-phase.md',
    'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md',
    'gsd-core/workflows/execute-plan.md',
    'gsd-core/workflows/explore.md',
    'gsd-core/workflows/import.md',
    'gsd-core/workflows/plan-phase.md',
    'gsd-core/workflows/plant-seed.md',
    'gsd-core/workflows/progress.md',
    'gsd-core/workflows/progress/steps/forensic-audit.md',
    'gsd-core/workflows/quick/steps/plan-checker-loop.md',
    'gsd-core/workflows/spec-phase.md',
    'gsd-core/workflows/ui-phase.md',
    'gsd-core/workflows/verify-work.md',
  ];

  // Files the contracts read that are too large to copy into every case; a case that needs one passes HEAVY.
  const HEAVY = [
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
  ];

  function copyOfRepoFiles(t, extra = []) {
    const root = tempDir(t, 'gsd-text-contracts-b12-');
    for (const rel of [...FILES, ...extra]) write(root, rel, fs.readFileSync(path.join(REPO_ROOT, ...rel.split('/')), 'utf8'));
    return root;
  }

  // The pinned minimum counts the whole directory; a run limited to some contracts must find those.
  const runShipped = (root, only = SHIPPED) => textContracts.run({ root, only, minContracts: only.length });

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
  void gapCases;

  test('an untouched copy of the files satisfies every batch 12 contract', (t) => {
    assert.deepEqual(runShipped(copyOfRepoFiles(t, HEAVY)), []);
  });

  for (const [title, rel, edit, contract, expected] of [
    // adr-230-pr-target-policy
    ['the checkout ref pinned to main', '.github/workflows/pr-target-validator.yml', swap('ref: ${{ github.event.pull_request.base.ref }}', 'ref: main'), 'adr-230-pr-target-policy', /the checkout step must pin ref to github\.event\.pull_request\.base\.ref/],
    ['the checkout ref pinned to the head ref', '.github/workflows/pr-target-validator.yml', swap('ref: ${{ github.event.pull_request.base.ref }}', 'ref: ${{ github.event.pull_request.head.ref }}'), 'adr-230-pr-target-policy', /the checkout step must pin ref to github\.event\.pull_request\.base\.ref/],
    ['the pinned checkout SHA replaced by a tag', '.github/workflows/pr-target-validator.yml', swap('actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd', 'actions/checkout@v4'), 'adr-230-pr-target-policy', /the checkout must use the repo-standard pinned SHA/],
    ['the policy module path changed', '.github/workflows/pr-target-validator.yml', swap('scripts/pr-target-policy.cjs', 'scripts/other-policy.cjs'), 'adr-230-pr-target-policy', /the github-script must require scripts\/pr-target-policy\.cjs/],
    ['the policy call renamed', '.github/workflows/pr-target-validator.yml', swap('classifyPrTarget(base, head)', 'decide(base, head)'), 'adr-230-pr-target-policy', /the github-script must call classifyPrTarget\(\)/],
    ['the inline mainAllowed array back', '.github/workflows/pr-target-validator.yml', append('const mainAllowed = [\'release/*\'];'), 'adr-230-pr-target-policy', /the old inline mainAllowed array must not appear in the rewired workflow/],
    ['the WARN_ONLY env gone', '.github/workflows/pr-target-validator.yml', eraseAll('WARN_ONLY'), 'adr-230-pr-target-policy', /the WARN_ONLY env must still be present/],
    ['core.setFailed gone', '.github/workflows/pr-target-validator.yml', eraseAll('core.setFailed'), 'adr-230-pr-target-policy', /core\.setFailed must still be called on block/],
    ['the warning-only wording changed', '.github/workflows/pr-target-validator.yml', swap('warning-only mode', 'warn-only'), 'adr-230-pr-target-policy', /the WARN_ONLY warning message \(warning-only mode\) must be preserved on the core\.warning line/],
    ['the comment marker renamed', '.github/workflows/pr-target-validator.yml', swap('<!-- pr-target-validator -->', '<!-- marker -->'), 'adr-230-pr-target-policy', /the comment marker must still reference pr-target-validator/],
    ['listComments gone', '.github/workflows/pr-target-validator.yml', eraseAll('listComments'), 'adr-230-pr-target-policy', /the listComments call must be preserved/],
    ['updateComment gone', '.github/workflows/pr-target-validator.yml', eraseAll('updateComment'), 'adr-230-pr-target-policy', /the updateComment call must be preserved/],
    ['createComment gone', '.github/workflows/pr-target-validator.yml', eraseAll('createComment'), 'adr-230-pr-target-policy', /the createComment call must be preserved/],
    ['OWNER gone from the carve-out', '.github/workflows/pr-target-validator.yml', eraseAll('OWNER'), 'adr-230-pr-target-policy', /the maintainer association carve-out \(OWNER, MEMBER, COLLABORATOR\) must still be present/],
    ['MEMBER gone from the carve-out', '.github/workflows/pr-target-validator.yml', eraseAll('MEMBER'), 'adr-230-pr-target-policy', /the maintainer association carve-out \(OWNER, MEMBER, COLLABORATOR\) must still be present/],
    ['COLLABORATOR gone from the carve-out', '.github/workflows/pr-target-validator.yml', eraseAll('COLLABORATOR'), 'adr-230-pr-target-policy', /the maintainer association carve-out \(OWNER, MEMBER, COLLABORATOR\) must still be present/],
    // code-review-summary-parser
    ['code-review: the first boundary site matches the raw content', 'gsd-core/workflows/code-review.md', (text) => { const at = text.indexOf('content.replace(/\\r\\n/g, \'\\n\').match('); return text.slice(0, at) + 'content.match(' + text.slice(at + 37); }, 'code-review-summary-parser', /every frontmatter-boundary site must normalize CRLF before matching/],
    ['code-review: only two boundary sites remain', 'gsd-core/workflows/code-review.md', (text) => { const parts = text.split('/^---\\n([\\s\\S]*?)\\n---/)'); return parts.map((part, i) => (i === 0 ? part : (i <= 2 ? '/^---\\n([\\s\\S]*?)\\n---/)' : '/^x/)') + part)).join(''); }, 'code-review-summary-parser', /expected at least 3 frontmatter-boundary sites/],
    ['code-review-fix: the first boundary site matches the raw content', 'gsd-core/workflows/code-review-fix.md', (text) => { const at = text.indexOf('content.replace(/\\r\\n/g, \'\\n\').match('); return text.slice(0, at) + 'content.match(' + text.slice(at + 37); }, 'code-review-summary-parser', /every frontmatter-boundary site must normalize CRLF before matching/],
    ['code-review-fix: only two boundary sites remain', 'gsd-core/workflows/code-review-fix.md', (text) => { const parts = text.split('/^---\\n([\\s\\S]*?)\\n---/)'); return parts.map((part, i) => (i === 0 ? part : (i <= 2 ? '/^---\\n([\\s\\S]*?)\\n---/)' : '/^x/)') + part)).join(''); }, 'code-review-summary-parser', /expected at least 3 frontmatter-boundary sites/],
    // audit-fix-command
    ['the command renamed', 'commands/gsd/audit-fix.md', swap('name: gsd:audit-fix', 'name: gsd:fix'), 'audit-fix-command', /the command name must be gsd:audit-fix/],
    ['the description key gone', 'commands/gsd/audit-fix.md', eraseAll('description:'), 'audit-fix-command', /the command must have a description in its frontmatter/],
    ['the allowed-tools key gone', 'commands/gsd/audit-fix.md', eraseAll('allowed-tools:'), 'audit-fix-command', /the command must have allowed-tools in its frontmatter/],
    ['Agent gone from the allowed tools', 'commands/gsd/audit-fix.md', swap('  - Agent\n', ''), 'audit-fix-command', /allowed-tools must include Agent for spawning executor subagents/],
    ['the argument-hint key gone', 'commands/gsd/audit-fix.md', eraseAll('argument-hint:'), 'audit-fix-command', /the command must have an argument-hint in its frontmatter/],
    ['the command type changed', 'commands/gsd/audit-fix.md', swap('type: prompt', 'type: skill'), 'audit-fix-command', /the command must have type: prompt in its frontmatter/],
    ['the hint shows the generic source', 'commands/gsd/audit-fix.md', swap('--source <audit-uat>', '--source <audit>'), 'audit-fix-command', /the argument-hint must show --source <audit-uat>/],
    ['the hint advertises the verify source', 'commands/gsd/audit-fix.md', swap('--source <audit-uat>', '--source <audit-uat> --source <audit|verify>'), 'audit-fix-command', /the argument-hint must not advertise the unsupported verify source/],
    ['the workflow reference gone', 'commands/gsd/audit-fix.md', eraseAll('audit-fix.md'), 'audit-fix-command', /the command must reference the audit-fix\.md workflow/],
    ['the objective opening tag gone', 'commands/gsd/audit-fix.md', eraseAll('<objective>'), 'audit-fix-command', /the command must have an <objective> section/],
    ['the objective closing tag gone', 'commands/gsd/audit-fix.md', eraseAll('</objective>'), 'audit-fix-command', /the command must close its <objective> section/],
    ['the --max flag gone', 'commands/gsd/audit-fix.md', eraseAll('--max'), 'audit-fix-command', /the command must document the --max flag/],
    ['the --severity flag gone', 'commands/gsd/audit-fix.md', eraseAll('--severity'), 'audit-fix-command', /the command must document the --severity flag/],
    ['the --dry-run flag gone', 'commands/gsd/audit-fix.md', eraseAll('--dry-run'), 'audit-fix-command', /the command must document the --dry-run flag/],
    ['the --source flag gone', 'commands/gsd/audit-fix.md', eraseAll('--source'), 'audit-fix-command', /the command must document the --source flag/],
    ['the purpose opening tag gone', 'gsd-core/workflows/audit-fix.md', eraseAll('<purpose>'), 'audit-fix-command', /the workflow must have a <purpose> section/],
    ['the purpose closing tag gone', 'gsd-core/workflows/audit-fix.md', eraseAll('</purpose>'), 'audit-fix-command', /the workflow must close its <purpose> section/],
    ['the process opening tag gone', 'gsd-core/workflows/audit-fix.md', eraseAll('<process>'), 'audit-fix-command', /the workflow must have a <process> section/],
    ['the process closing tag gone', 'gsd-core/workflows/audit-fix.md', eraseAll('</process>'), 'audit-fix-command', /the workflow must close its <process> section/],
    ['the success criteria opening tag gone', 'gsd-core/workflows/audit-fix.md', eraseAll('<success_criteria>'), 'audit-fix-command', /the workflow must have a <success_criteria> section/],
    ['the success criteria closing tag gone', 'gsd-core/workflows/audit-fix.md', eraseAll('</success_criteria>'), 'audit-fix-command', /the workflow must close its <success_criteria> section/],
    ['the agent types section gone', 'gsd-core/workflows/audit-fix.md', eraseAll('<available_agent_types>'), 'audit-fix-command', /the workflow must have an <available_agent_types> section/],
    ['gsd-executor gone', 'gsd-core/workflows/audit-fix.md', eraseAll('gsd-executor'), 'audit-fix-command', /the workflow must list gsd-executor as an available agent type/],
    ['the --max default gone', 'gsd-core/workflows/audit-fix.md', swap('(default: **5**)', '(default: **n**)'), 'audit-fix-command', /the workflow must document the --max flag with its default of 5 on one line/],
    ['the --severity default gone', 'gsd-core/workflows/audit-fix.md', (text) => text.split('high|medium|all').join('high|all').split('(default: **medium**)').join('(default: **mid**)'), 'audit-fix-command', /the workflow must document the --severity flag with its default of medium on one line/],
    ['the --dry-run flag gone', 'gsd-core/workflows/audit-fix.md', eraseAll('--dry-run'), 'audit-fix-command', /the workflow must document the --dry-run flag/],
    ['the --source default gone', 'gsd-core/workflows/audit-fix.md', swap('(default: **audit-uat**)', '(default: **x**)'), 'audit-fix-command', /the workflow must document the --source flag with audit-uat as the default source on one line/],
    ['auto-fixable gone', 'gsd-core/workflows/audit-fix.md', eraseAll('auto-fixable'), 'audit-fix-command', /the workflow must document the auto-fixable classification/],
    ['manual-only gone', 'gsd-core/workflows/audit-fix.md', eraseAll('manual-only'), 'audit-fix-command', /the workflow must document the manual-only classification/],
    ['uncertain gone', 'gsd-core/workflows/audit-fix.md', eraseAll('uncertain'), 'audit-fix-command', /the workflow must say to err on manual-only when uncertain/],
    ['file path gone', 'gsd-core/workflows/audit-fix.md', eraseAll('file path'), 'audit-fix-command', /the workflow must list a file path reference as an auto-fixable signal/],
    ['missing test gone', 'gsd-core/workflows/audit-fix.md', eraseAll('missing test'), 'audit-fix-command', /the workflow must list a missing test as an auto-fixable signal/],
    ['design decision gone', 'gsd-core/workflows/audit-fix.md', eraseAll('design decision'), 'audit-fix-command', /the workflow must list design decisions as a manual-only signal/],
    ['architecture gone', 'gsd-core/workflows/audit-fix.md', (text) => text.split('architecture').join('').split('architectural').join(''), 'audit-fix-command', /the workflow must list architecture changes as a manual-only signal/],
    ['the dry-run stop gone', 'gsd-core/workflows/audit-fix.md', swap('**stop here and exit**', '**halt**'), 'audit-fix-command', /the workflow must indicate on one line that --dry-run stops after classification/],
    ['the dry-run mention moved behind the fix loop', 'gsd-core/workflows/audit-fix.md', (text) => text.split('dry-run').join('dryrun') + '\ndry-run\n', 'audit-fix-command', /the --dry-run stop must be documented before the fix-loop step/],
    ['the fix-loop step renamed', 'gsd-core/workflows/audit-fix.md', swap('fix-loop', 'fixloop'), 'audit-fix-command', /the workflow must have a fix-loop step/],
    ['the {ID} placeholder gone from the commit', 'gsd-core/workflows/audit-fix.md', swap('resolve {ID} —', 'resolve F-01 —'), 'audit-fix-command', /the commit message template must include the \{ID\} placeholder for the finding ID/],
    ['commit and finding apart', 'gsd-core/workflows/audit-fix.md', (text) => text.split('commits atomically with finding IDs for traceability.').join('commits atomically with IDs.').split('The commit message **must** include the finding ID (e.g., F-01) for traceability.').join('The commit message **must** include the ID (e.g., F-01).').split('Every commit message contains the finding ID').join('Every commit message contains the ID'), 'audit-fix-command', /the workflow must commit atomically per finding/],
    ['the finding ID traceability gone', 'gsd-core/workflows/audit-fix.md', (text) => text.split('traceability').join('').split('finding ID').join('ID'), 'audit-fix-command', /the workflow must mention the finding ID for traceability/],
    ['npm test gone', 'gsd-core/workflows/audit-fix.md', eraseAll('npm test'), 'audit-fix-command', /the workflow must run npm test as part of the fix loop/],
    ['git commit before npm test in the fix loop', 'gsd-core/workflows/audit-fix.md', swap('<step name="fix-loop">', '<step name="fix-loop">\ngit commit\n'), 'audit-fix-command', /npm test must appear before the commit in the fix loop \(test-then-commit\)/],
    ['tests pass gone', 'gsd-core/workflows/audit-fix.md', eraseAll('tests pass'), 'audit-fix-command', /the commit must be conditional on the tests passing/],
    ['revert gone', 'gsd-core/workflows/audit-fix.md', (text) => text.split('git checkout').join('').split('revert').join(''), 'audit-fix-command', /the workflow must revert the changes on a test failure/],
    ['fix-failed gone', 'gsd-core/workflows/audit-fix.md', eraseAll('fix-failed'), 'audit-fix-command', /the workflow must mark failed fixes as fix-failed/],
    ['stop gone from the fix-failed line', 'gsd-core/workflows/audit-fix.md', swap('**stop the pipeline**', '**halt the pipeline**'), 'audit-fix-command', /the workflow must stop the pipeline after the first test failure, on the line that marks fix-failed/],
    ['the checkout of the changed files gone', 'gsd-core/workflows/audit-fix.md', eraseAll('git checkout -- {changed_files}'), 'audit-fix-command', /the workflow must use git checkout -- \{changed_files\} to clean partial changes on failure/],
    // progress-forensic
    ['the --forensic flag gone from the command', 'commands/gsd/progress.md', eraseAll('--forensic'), 'progress-forensic', /the progress command argument-hint must include --forensic/],
    ['the arguments line decorated', 'commands/gsd/progress.md', swap('<arguments>$ARGUMENTS</arguments>', '<arguments>$ARGUMENTS</arguments> '), 'progress-forensic', /the raw arguments must sit on a line of their own before the routing parse/],
    ['the arguments line behind the process tag', 'commands/gsd/progress.md', (text) => text.split('<arguments>$ARGUMENTS</arguments>').join('') + '\n<arguments>$ARGUMENTS</arguments>\n', 'progress-forensic', /the raw arguments must sit on a line of their own before the routing parse/],
    ['the labeled-block pointer gone', 'commands/gsd/progress.md', swap('Arguments provided: see the `<arguments>` block above.', 'Arguments provided: see above.'), 'progress-forensic', /the routing parse must point at the labeled block instead of interpolating the text/],
    ['the interpolating parse instruction back', 'commands/gsd/progress.md', append('Parse the first token of $ARGUMENTS:'), 'progress-forensic', /progress\.md must keep the parse instructions independent from argument interpolation/],
    ['the forensic_audit step renamed', 'gsd-core/workflows/progress/steps/forensic-audit.md', swap('<step name="forensic_audit">', '<step name="audit">'), 'progress-forensic', /progress\/steps\/forensic-audit\.md must have a forensic_audit step/],
    ['the --forensic gate gone', 'gsd-core/workflows/progress/steps/forensic-audit.md', eraseAll('--forensic'), 'progress-forensic', /the forensic_audit step must be gated on the --forensic flag/],
    ['the skip wording gone', 'gsd-core/workflows/progress/steps/forensic-audit.md', (text) => text.split('Skip').join('').split('skip').join('').split('exit').join(''), 'progress-forensic', /the forensic_audit step must skip when --forensic is not present/],
    ['STATE gone from check 1', 'gsd-core/workflows/progress/steps/forensic-audit.md', eraseAll('STATE'), 'progress-forensic', /the forensic step must check STATE against the artifacts \(check 1\)/],
    ['artifact and consistent gone from check 1', 'gsd-core/workflows/progress/steps/forensic-audit.md', (text) => text.split('artifact').join('').split('consistent').join(''), 'progress-forensic', /the forensic step must check STATE against the artifacts \(check 1\)/],
    ['the handoff wording gone from check 2', 'gsd-core/workflows/progress/steps/forensic-audit.md', (text) => text.split('HANDOFF').join('').split('handoff').join(''), 'progress-forensic', /the forensic step must check for orphaned handoff files \(check 2\)/],
    ['defer gone from check 3', 'gsd-core/workflows/progress/steps/forensic-audit.md', eraseAll('defer'), 'progress-forensic', /the forensic step must check for deferred scope drift \(check 3\)/],
    ['the memory wording gone from check 4', 'gsd-core/workflows/progress/steps/forensic-audit.md', (text) => text.split('MEMORY').join('').split('memory').join('').split('pending').join(''), 'progress-forensic', /the forensic step must check memory-flagged pending work \(check 4\)/],
    ['the todo wording gone from check 5', 'gsd-core/workflows/progress/steps/forensic-audit.md', (text) => text.split('todo').join('').split('Todo').join('').split('TODO').join(''), 'progress-forensic', /the forensic step must check blocking operational todos \(check 5\)/],
    ['the uncommitted wording gone from check 6', 'gsd-core/workflows/progress/steps/forensic-audit.md', (text) => text.split('uncommitted').join('').split('git status').join(''), 'progress-forensic', /the forensic step must check for uncommitted code \(check 6\)/],
    ['CLEAN gone', 'gsd-core/workflows/progress/steps/forensic-audit.md', eraseAll('CLEAN'), 'progress-forensic', /the forensic step must produce a CLEAN verdict when all checks pass/],
    ['the integrity verdict gone', 'gsd-core/workflows/progress/steps/forensic-audit.md', (text) => text.split('INTEGRITY ISSUE').join('').split('integrity issue').join(''), 'progress-forensic', /the forensic step must surface INTEGRITY ISSUE when checks fail/],
    ['the unchanged wording gone', 'gsd-core/workflows/progress/steps/forensic-audit.md', (text) => text.split('unchanged').join('').split('standard report').join(''), 'progress-forensic', /the forensic step must clarify that the default behaviour is unchanged/],
    ['the --forensic flag gone from COMMANDS.md', 'docs/COMMANDS.md', eraseAll('--forensic'), 'progress-forensic', /COMMANDS\.md must document the --forensic flag for gsd-progress/],
    ['the forensic-audit section marker gone', 'gsd-core/workflows/progress.md', eraseAll('id="forensic-audit"'), 'progress-forensic', /progress\.md must wire up the forensic-audit section marker/],
    ['the verification.status query gone', 'gsd-core/workflows/progress.md', eraseAll('verification.status'), 'progress-forensic', /the progress workflow must query verification\.status/],
    ['the verification_status tracking gone', 'gsd-core/workflows/progress.md', eraseAll('verification_status'), 'progress-forensic', /the progress workflow must track a verification_status value for routing/],
    ['the stale verification wording gone', 'gsd-core/workflows/progress.md', eraseAll('stale verification'), 'progress-forensic', /the progress workflow must document that verification\.status projects stale verification/],
    ['the gaps_found row gone', 'gsd-core/workflows/progress.md', eraseAll('verification_status = gaps_found'), 'progress-forensic', /the routing table must have a gaps_found row/],
    ['the human_needed row gone', 'gsd-core/workflows/progress.md', eraseAll('verification_status = human_needed'), 'progress-forensic', /the routing table must have a human_needed row/],
    ['the non-passed row gone', 'gsd-core/workflows/progress.md', eraseAll('verification_status ≠ passed'), 'progress-forensic', /the routing table must have one non-passed verification row \(Route V\)/],
    ['the generic complete row gone', 'gsd-core/workflows/progress.md', eraseAll('Phase complete (verification passed)'), 'progress-forensic', /the routing table must keep a generic complete row/],
    ['the generic complete row before the specific ones', 'gsd-core/workflows/progress.md', swap('verification_status = gaps_found', 'Phase complete (verification passed) verification_status = gaps_found'), 'progress-forensic', /the routing rows must be in first-match-wins order/],
    ['the human_needed row after the non-passed row', 'gsd-core/workflows/progress.md', (text) => text.split('verification_status = human_needed').join('verification_status = hn') + '\nverification_status = human_needed\n', 'progress-forensic', /the routing rows must be in first-match-wins order/],
    ['the unknown status row back', 'gsd-core/workflows/progress.md', append('verification_status = unknown'), 'progress-forensic', /unknown is no longer a status \(#5118\)/],
    ['the stale status row back', 'gsd-core/workflows/progress.md', append('verification_status = stale'), 'progress-forensic', /stale is routed by the owner, not a row of its own \(#5118\)/],
    ['the Route V.gaps heading gone', 'gsd-core/workflows/progress.md', eraseAll('**Route V.gaps:'), 'progress-forensic', /the workflow must define a Route V\.gaps section/],
    ['the Route V.human heading gone', 'gsd-core/workflows/progress.md', eraseAll('**Route V.human:'), 'progress-forensic', /the workflow must define a Route V\.human section/],
    ['the Route V heading gone', 'gsd-core/workflows/progress.md', eraseAll('**Route V:'), 'progress-forensic', /the workflow must define the single non-passed Route V/],
    ['the Route V.stale heading back', 'gsd-core/workflows/progress.md', append('**Route V.stale: stale verification**'), 'progress-forensic', /Route V\.stale is deleted \(#5118\)/],
    ['the missing-as-complete wording back', 'gsd-core/workflows/progress.md', append('verification passed, missing, or n/a'), 'progress-forensic', /missing or unknown verification must not be documented as complete/],
    ['plan-phase gone from Route V.gaps', 'gsd-core/workflows/progress.md', within('**Route V.gaps:', '**Route V.human:', eraseAll('plan-phase')), 'progress-forensic', /gaps_found must route to plan-phase --gaps/],
    ['--gaps gone from Route V.gaps', 'gsd-core/workflows/progress.md', within('**Route V.gaps:', '**Route V.human:', eraseAll('--gaps')), 'progress-forensic', /gaps_found must route to plan-phase --gaps/],
    ['verify-work gone from Route V.human', 'gsd-core/workflows/progress.md', within('**Route V.human:', '**Step 3', eraseAll('verify-work')), 'progress-forensic', /human_needed must route to verify-work/],
    ['the next command gone from Route V', 'gsd-core/workflows/progress.md', within('**Route V:', '**Route V.gaps:', eraseAll('VERIFICATION_NEXT_COMMAND')), 'progress-forensic', /a non-passed verification must present the owner's next_command/],
    ['/gsd:verify-work named in Route V', 'gsd-core/workflows/progress.md', within('**Route V:', '**Route V.gaps:', append('/gsd:verify-work')), 'progress-forensic', /a non-passed verification must present the owner's next_command/],
    ['/gsd-verify-work named in Route V', 'gsd-core/workflows/progress.md', within('**Route V:', '**Route V.gaps:', append('/gsd-verify-work')), 'progress-forensic', /a non-passed verification must present the owner's next_command/],
    ['/gsd:execute-phase named in Route V', 'gsd-core/workflows/progress.md', within('**Route V:', '**Route V.gaps:', append('/gsd:execute-phase')), 'progress-forensic', /a non-passed verification must present the owner's next_command/],
    ['/gsd-execute-phase named in Route V', 'gsd-core/workflows/progress.md', within('**Route V:', '**Route V.gaps:', append('/gsd-execute-phase')), 'progress-forensic', /a non-passed verification must present the owner's next_command/],
    ['the quote markers gone from the report step', 'gsd-core/workflows/progress.md', within('<step name="report">', '**Generate progress bar', swap('> ', '')), 'progress-forensic', /the report step must contain at least one blockquote/],
    ['the context authority label gone', 'gsd-core/workflows/progress.md', within('<step name="report">', '**Generate progress bar', (text) => text.split('Context authority').join('Context').split('context authority').join('context')), 'progress-forensic', /the report step must contain a blockquote whose text includes "Context authority"/],
    ['PROJECT.md gone from the directive', 'gsd-core/workflows/progress.md', within('<step name="report">', '**Generate progress bar', eraseAll('PROJECT.md')), 'progress-forensic', /the context-authority directive must name PROJECT\.md as authoritative/],
    ['STATE.md gone from the directive', 'gsd-core/workflows/progress.md', within('<step name="report">', '**Generate progress bar', eraseAll('STATE.md')), 'progress-forensic', /the context-authority directive must name STATE\.md as authoritative/],
    ['ROADMAP.md gone from the directive', 'gsd-core/workflows/progress.md', within('<step name="report">', '**Generate progress bar', eraseAll('ROADMAP.md')), 'progress-forensic', /the context-authority directive must name ROADMAP\.md as authoritative/],
    ['authoritative gone from the directive', 'gsd-core/workflows/progress.md', within('<step name="report">', '**Generate progress bar', (text) => { let out = text; for (const word of ['authoritative']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }), 'progress-forensic', /the context-authority directive must describe these files as authoritative/],
    ['CLAUDE.md gone from the directive', 'gsd-core/workflows/progress.md', within('<step name="report">', '**Generate progress bar', eraseAll('CLAUDE.md')), 'progress-forensic', /the context-authority directive must explicitly mention CLAUDE\.md/],
    ['the prohibition gone from the directive', 'gsd-core/workflows/progress.md', within('<step name="report">', '**Generate progress bar', swap('do NOT use', 'use')), 'progress-forensic', /the context-authority directive must contain an explicit prohibition/],
    ['the ## Project call-out gone from the directive', 'gsd-core/workflows/progress.md', within('<step name="report">', '**Generate progress bar', eraseAll('## Project')), 'progress-forensic', /the context-authority directive must call out the CLAUDE\.md "## Project" block specifically/],
    // edit-phase
    ['the command renamed', 'commands/gsd/phase.md', swap('name: gsd:phase', 'name: gsd:other'), 'edit-phase', /the consolidated phase\.md must have name gsd:phase \(#2790\)/],
    ['the description key gone', 'commands/gsd/phase.md', eraseAll('description:'), 'edit-phase', /the command must have a description in its frontmatter/],
    ['the workflow reference gone', 'commands/gsd/phase.md', eraseAll('edit-phase.md'), 'edit-phase', /the command must reference the edit-phase workflow/],
    ['the --edit and --force flags gone', 'commands/gsd/phase.md', (text) => text.split('--edit').join('').split('--force').join(''), 'edit-phase', /the command must document the --edit flag \(which supports --force\)/],
    ['the --force flag gone', 'gsd-core/workflows/edit-phase.md', (text) => { let out = text; for (const word of ['--force']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, 'edit-phase', /the workflow must handle the --force flag/],
    ['current values gone', 'gsd-core/workflows/edit-phase.md', (text) => { let out = text; for (const word of ['current']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, 'edit-phase', /the workflow must present current field values before editing/],
    ['individual fields gone', 'gsd-core/workflows/edit-phase.md', (text) => { let out = text; for (const word of ['field']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, 'edit-phase', /the workflow must support editing individual fields/],
    ['the title field gone', 'gsd-core/workflows/edit-phase.md', (text) => { let out = text; for (const word of ['title']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, 'edit-phase', /the workflow must mention the title field/],
    ['the goal field gone', 'gsd-core/workflows/edit-phase.md', (text) => { let out = text; for (const word of ['goal']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, 'edit-phase', /the workflow must mention the goal field/],
    ['the depends_on field gone', 'gsd-core/workflows/edit-phase.md', (text) => { let out = text; for (const word of ['depends_on']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, 'edit-phase', /the workflow must mention the depends_on field/],
    ['the requirements field gone', 'gsd-core/workflows/edit-phase.md', (text) => { let out = text; for (const word of ['requirements']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, 'edit-phase', /the workflow must mention the requirements field/],
    ['the success_criteria field gone', 'gsd-core/workflows/edit-phase.md', (text) => { let out = text; for (const word of ['success_criteria']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, 'edit-phase', /the workflow must mention the success_criteria field/],
    ['regeneration gone', 'gsd-core/workflows/edit-phase.md', (text) => { let out = text; for (const word of ['regenerate','clarified','rewrite']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, 'edit-phase', /the workflow must support full regeneration from a clarified intent/],
    ['the clarified intent prompt gone', 'gsd-core/workflows/edit-phase.md', (text) => { let out = text; for (const word of ['clarifie','revised']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, 'edit-phase', /the workflow must prompt the user for a clarified intent during full regeneration/],
    ['depends_on validation gone', 'gsd-core/workflows/edit-phase.md', (text) => { let out = text; for (const word of ['depends']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, 'edit-phase', /the workflow must validate depends_on references against the existing phases/],
    ['the invalid reference block (the words) gone', 'gsd-core/workflows/edit-phase.md', (text) => { let out = text; for (const word of ['exit','block','error']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, 'edit-phase', /the workflow must block the write when depends_on references an invalid phase/],
    ['the self reference gone', 'gsd-core/workflows/edit-phase.md', (text) => { let out = text; for (const word of ['circular','self-reference','itself']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, 'edit-phase', /the workflow must prevent a self-referencing depends_on/],
    ['the phase status check gone', 'gsd-core/workflows/edit-phase.md', (text) => { let out = text; for (const word of ['status']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, 'edit-phase', /the workflow must check the phase status before allowing an edit/],
    ['the in-progress guard gone', 'gsd-core/workflows/edit-phase.md', (text) => { let out = text; for (const word of ['progress']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, 'edit-phase', /the workflow must refuse in_progress edits without --force/],
    ['the completed guard gone', 'gsd-core/workflows/edit-phase.md', (text) => { let out = text; for (const word of ['completed']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, 'edit-phase', /the workflow must refuse completed phase edits without --force/],
    ['the phase not found error gone', 'gsd-core/workflows/edit-phase.md', (text) => { let out = text; for (const word of ['found','does not exist']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, 'edit-phase', /the workflow must error clearly when the phase number does not exist/],
    ['the missing argument error gone', 'gsd-core/workflows/edit-phase.md', (text) => { let out = text; for (const word of ['required','argument']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, 'edit-phase', /the workflow must error when the phase number argument is missing/],
    ['the diff gone', 'gsd-core/workflows/edit-phase.md', (text) => { let out = text; for (const word of ['diff','change']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, 'edit-phase', /the workflow must show a diff of the changes before writing/],
    ['the confirmation gone', 'gsd-core/workflows/edit-phase.md', (text) => { let out = text; for (const word of ['confirm','y/n','change','yes']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, 'edit-phase', /the workflow must ask for confirmation before writing/],
    ['the decline gone', 'gsd-core/workflows/edit-phase.md', (text) => { let out = text; for (const word of ['without writing','says','user','exit']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, 'edit-phase', /the workflow must exit without writing if the user declines the confirmation/],
    ['the preserved number gone', 'gsd-core/workflows/edit-phase.md', (text) => { let out = text; for (const word of ['preserve','number and position']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, 'edit-phase', /the workflow must preserve the phase number and position/],
    ['the write in place gone', 'gsd-core/workflows/edit-phase.md', (text) => { let out = text; for (const word of ['place','replace']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, 'edit-phase', /the workflow must write the phase back in place \(section replacement\)/],
    ['the roadmap evolution update gone', 'gsd-core/workflows/edit-phase.md', (text) => { let out = text; for (const word of ['state.add-roadmap-evolution','roadmap evolution']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, 'edit-phase', /the workflow must update the STATE\.md Roadmap Evolution after an edit/],
    ['the invalid phase wording gone (the block needs it)', 'gsd-core/workflows/edit-phase.md', (text) => { let out = text; for (const word of ['invalid']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, 'edit-phase', /the workflow must block the write when depends_on references an invalid phase/],
    ['the anti_patterns section renamed', 'gsd-core/workflows/edit-phase.md', swap('<anti_patterns>', '<antipatterns>'), 'edit-phase', /the workflow must have an <anti_patterns> section that blocks renumbering/],
    ['the renumbering prohibition gone from the anti_patterns', 'gsd-core/workflows/edit-phase.md', within('<anti_patterns>', '</anti_patterns>', (text) => { let out = text; for (const word of ['renumber','preserved','preserve']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }), 'edit-phase', /the workflow must have an <anti_patterns> section that blocks renumbering/],
    ['the write step milestone-scope probe gone', 'gsd-core/workflows/edit-phase.md', within('<step name="write_updated_phase">', '</step>', eraseAll('milestone-scope')), 'edit-phase', /write_updated_phase must run the roadmap milestone-scope probe before writing/],
    ['SCOPE_BEFORE gone from the write step', 'gsd-core/workflows/edit-phase.md', within('<step name="write_updated_phase">', '</step>', (text) => { let out = text; for (const word of ['scope_before']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }), 'edit-phase', /the pre-write capture must be named SCOPE_BEFORE for the post-write comparison/],
    ['SCOPE_AFTER gone from the write step', 'gsd-core/workflows/edit-phase.md', within('<step name="write_updated_phase">', '</step>', (text) => { let out = text; for (const word of ['scope_after']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }), 'edit-phase', /the post-write re-derivation \(SCOPE_AFTER\) must be present/],
    ['the rollback wording gone from the write step', 'gsd-core/workflows/edit-phase.md', within('<step name="write_updated_phase">', '</step>', (text) => { let out = text; for (const word of ['rollback','restore','revert','rolled back']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }), 'edit-phase', /a scope or phase-set mismatch must trigger a rollback/],
    ['the scope changed error gone from the write step', 'gsd-core/workflows/edit-phase.md', within('<step name="write_updated_phase">', '</step>', (text) => { let out = text; for (const word of ['scope changed']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }), 'edit-phase', /the rollback path must surface an explicit milestone scope changed error/],
    ['the milestone scope check gone from the success criteria', 'gsd-core/workflows/edit-phase.md', within('<success_criteria>', '</success_criteria>', (text) => { let out = text; for (const word of ['milestone scope']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }), 'edit-phase', /the success criteria must include the milestone-scope verification \(#3262\)/],
    ['the row cites the deleted command', 'docs/INVENTORY.md', swap('preserving number and position. | `/gsd-phase --edit` |', 'preserving number and position. | `/gsd-edit-phase` |'), 'edit-phase', /the edit-phase\.md row must list "\/gsd-phase --edit" as its caller/],
    ['edit-phase.md gone from the inventory', 'docs/INVENTORY.md', eraseAll('edit-phase.md'), 'edit-phase', /the edit-phase\.md row must list "\/gsd-phase --edit" as its caller/],
    ['/gsd-phase gone from the manifest commands', 'docs/INVENTORY-MANIFEST.json', (text) => { const m = JSON.parse(text); m.families.commands = m.families.commands.filter((entry) => entry !== '/gsd-phase'); return JSON.stringify(m); }, 'edit-phase', /INVENTORY-MANIFEST\.json must list \/gsd-phase in commands/],
    ['edit-phase.md gone from the manifest workflows', 'docs/INVENTORY-MANIFEST.json', (text) => { const m = JSON.parse(text); m.families.workflows = m.families.workflows.filter((entry) => entry !== 'edit-phase.md'); return JSON.stringify(m); }, 'edit-phase', /INVENTORY-MANIFEST\.json must list edit-phase\.md in workflows/],
    ['/gsd-phase gone from COMMANDS.md', 'docs/COMMANDS.md', eraseAll('/gsd-phase'), 'edit-phase', /COMMANDS\.md must document \/gsd-phase/],
        // adr-218-release-version-validation: the version gate of release.yml (#1186)
        ['every grep -qE call turned into grep -q', '.github/workflows/release.yml', swap('grep -qE', 'grep -q'), 'adr-218-release-version-validation', /at least 2 leading-zero-aware grep -qE version patterns \(found 0/],
        ['the duplicate-version step erased', '.github/workflows/release.yml', eraseAll('Reject already-published versions'), 'adr-218-release-version-validation', /must contain a step named "Reject already-published versions"/],
        ['the npm view pre-check erased', '.github/workflows/release.yml', eraseAll('npm view'), 'adr-218-release-version-validation', /must contain an `npm view` call/],
        ['the format step renamed', '.github/workflows/release.yml', swap('name: Validate version format', 'name: Check the version'), 'adr-218-release-version-validation', /no "Validate version format" step/],
        ['the duplicate step named before the format step', '.github/workflows/release.yml', swap('- name: Validate version format', '# Reject already-published versions\n      - name: Validate version format'), 'adr-218-release-version-validation', /is at offset \d+, "Validate version format" at \d+/],
        ['release.yml no longer YAML', '.github/workflows/release.yml', append('foo: [unclosed'), 'adr-218-release-version-validation', /release\.yml is not valid YAML/],
        ['jobs turned into a list', '.github/workflows/release.yml', swap('\njobs:\n', '\njobs: []\nold:\n'), 'adr-218-release-version-validation', /release\.yml is not a workflow with a jobs mapping/],
        ['the validate-version job renamed', '.github/workflows/release.yml', swap('\n  validate-version:\n', '\n  validate-versions:\n'), 'adr-218-release-version-validation', /must define a `validate-version:` job \(ADR-218 requires it as the gate\) \(no such job\)/],
        ['the create job renamed', '.github/workflows/release.yml', swap('\n  create:\n', '\n  created:\n'), 'adr-218-release-version-validation', /must have a `create:` job \(no such job\)/],
        ['the rc job renamed', '.github/workflows/release.yml', swap('\n  rc:\n', '\n  rcx:\n'), 'adr-218-release-version-validation', /must have a `rc:` job \(no such job\)/],
        ['the finalize job renamed', '.github/workflows/release.yml', swap('\n  finalize:\n', '\n  finalized:\n'), 'adr-218-release-version-validation', /must have a `finalize:` job \(no such job\)/],
        ['the rc job a scalar', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs.rc = 'x'; }), 'adr-218-release-version-validation', /must have a `rc:` job \(the job is not a mapping\)/],
        ['create without needs', '.github/workflows/release.yml', yamlEdit((w) => { delete w.jobs.create.needs; }), 'adr-218-release-version-validation', /the `create` job must list validate-version in its `needs:`/],
        ['rc without the gate in needs', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs.rc.needs = ['install-smoke-rc']; }), 'adr-218-release-version-validation', /the `rc` job must list validate-version in its `needs:`/],
        ['finalize without the gate in needs', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs.finalize.needs = ['finalize-test']; }), 'adr-218-release-version-validation', /the `finalize` job must list validate-version in its `needs:`/],
        ['create needs a name that only starts with the gate', '.github/workflows/release.yml', yamlEdit((w) => { w.jobs.create.needs = 'validate-version-x'; }), 'adr-218-release-version-validation', /the `create` job must list validate-version in its `needs:` \(ADR-218 gate must run before create\) \(needs is "validate-version-x"\)/],
        ['the gate declared after the create job', '.github/workflows/release.yml', yamlEdit((w) => { const { create, ...rest } = w.jobs; const gate = rest['validate-version']; delete rest['validate-version']; w.jobs = { create, 'validate-version': gate, ...rest }; }), 'adr-218-release-version-validation', /validate-version must be declared before the create job/],
        ['the gate declared after the rc job', '.github/workflows/release.yml', yamlEdit((w) => { const names = Object.keys(w.jobs).filter((name) => name !== 'validate-version'); const at = names.indexOf('rc') + 1; const order = [...names.slice(0, at), 'validate-version', ...names.slice(at)]; w.jobs = Object.fromEntries(order.map((name) => [name, w.jobs[name]])); }), 'adr-218-release-version-validation', /validate-version must be declared before the rc job/],
        ['the gate declared last', '.github/workflows/release.yml', yamlEdit((w) => { const gate = w.jobs['validate-version']; delete w.jobs['validate-version']; w.jobs['validate-version'] = gate; }), 'adr-218-release-version-validation', /validate-version must be declared before the finalize job/],
        // tdd-single-statement: the cycle is stated once, in tdd.md (#3990, #4268, #4302, #5274)
        ['the canonical section heading erased', 'gsd-core/references/tdd.md', eraseAll('## Red-Green-Refactor Cycle'), 'tdd-single-statement', /tdd\.md carries the canonical Red-Green-Refactor Cycle section/],
        ['the RED commit-scope contract erased', 'gsd-core/references/tdd.md', eraseAll('Commit: `test({phase}-{plan})'), 'tdd-single-statement', /the canonical section carries the RED commit-scope contract/],
        ['the GREEN feat commit-scope contract erased', 'gsd-core/references/tdd.md', eraseAll('Commit: `feat({phase}-{plan})'), 'tdd-single-statement', /the canonical section carries the GREEN commit-scope contract/],
        ['the GREEN fix alternative erased', 'gsd-core/references/tdd.md', swap('or `fix({phase}-{plan})', 'or `chore({phase}-{plan})'), 'tdd-single-statement', /the canonical section carries the GREEN commit-scope contract/],
        ['the executor restating a feat GREEN commit', 'agents/gsd-executor.md', append('1. commit: `test({phase}-{plan}): x`\n2. commit: `feat({phase}-{plan}): y`'), 'tdd-single-statement', /<tdd_execution> must not restate the numbered RED\/GREEN commit protocol/],
        ['the executor restating a fix GREEN commit', 'agents/gsd-executor.md', append('1. commit: `test({phase}-{plan}): x`\n2. commit: `fix({phase}-{plan}): y`'), 'tdd-single-statement', /<tdd_execution> must not restate the numbered RED\/GREEN commit protocol/],
        ['the executor pointer to tdd.md erased', 'agents/gsd-executor.md', eraseAll('references/tdd.md'), 'tdd-single-statement', /the executor points at the canonical reference/],
        ['the executor cycle sentence cut loose from its citation', 'agents/gsd-executor.md', within('**2-4. RED', '## Plan-Level TDD', (text) => text.split('tdd.md').join('x').split('canonical').join('x')), 'tdd-single-statement', /agents\/gsd-executor\.md's compact citation of RED\/GREEN\/REFACTOR must not be flagged as a restatement/],
        ['execute-plan restating a feat GREEN commit', 'gsd-core/workflows/execute-plan.md', append('1. commit: `test({phase}-{plan}): x`\n2. commit: `feat({phase}-{plan}): y`'), 'tdd-single-statement', /<tdd_plan_execution> must not restate the numbered RED\/GREEN commit protocol/],
        ['execute-plan restating a fix GREEN commit', 'gsd-core/workflows/execute-plan.md', append('1. commit: `test({phase}-{plan}): x`\n2. commit: `fix({phase}-{plan}): y`'), 'tdd-single-statement', /<tdd_plan_execution> must not restate the numbered RED\/GREEN commit protocol/],
        ['the plan-execution pointer to tdd.md erased', 'gsd-core/workflows/execute-plan.md', within('<tdd_plan_execution>', '</tdd_plan_execution>', eraseAll('references/tdd.md')), 'tdd-single-statement', /the plan-execution section points at the canonical reference \(the section does not point at it\)/],
        ['the execute-plan cycle sentence cut loose from its citation', 'gsd-core/workflows/execute-plan.md', within('<tdd_plan_execution>', '</tdd_plan_execution>', (text) => text.split('tdd.md').join('x').split('canonical').join('x')), 'tdd-single-statement', /gsd-core\/workflows\/execute-plan\.md's compact citation of RED\/GREEN\/REFACTOR must not be flagged/],
        ['execute-plan cycle itemised as three list items', 'gsd-core/workflows/execute-plan.md', swap('For `type: tdd` plans — RED-GREEN-REFACTOR:', 'RED:\n- RED: write the failing test\n- GREEN: make it pass\n- REFACTOR: tidy'), 'tdd-single-statement', /gsd-core\/workflows\/execute-plan\.md's compact citation of RED\/GREEN\/REFACTOR must not be flagged/],
        ['the check-3 GREEN types cut to feat alone', 'gsd-core/references/execute-mvp-tdd.md', swap('No `feat({phase}-{plan})` or `fix({phase}-{plan})` commit may exist', 'No `feat({phase}-{plan})` commit may exist'), 'tdd-single-statement', /check 3 names both GREEN commit types/],
        ['the check-3 GREEN types cut to fix alone', 'gsd-core/references/execute-mvp-tdd.md', swap('No `feat({phase}-{plan})` or `fix({phase}-{plan})` commit may exist', 'No `fix({phase}-{plan})` commit may exist'), 'tdd-single-statement', /check 3 names both GREEN commit types/],
        ['the halt reason impl_before_test erased', 'gsd-core/references/execute-mvp-tdd.md', eraseAll('impl_before_test'), 'tdd-single-statement', /the check-3 halt reason must name impl_before_test/],
        ['a halt reason naming a GREEN type alone added', 'gsd-core/references/execute-mvp-tdd.md', append('Reason: {feat_before_test}'), 'tdd-single-statement', /the check-3 halt reason must not name a GREEN type alone/],
        ['the TDD_APPLICABLE condition dropped from execute-phase', 'gsd-core/workflows/execute-phase.md', swap("${TDD_APPLICABLE ? '- `~/.claude/gsd-core/references/tdd.md`' : ''}", "'- `~/.claude/gsd-core/references/tdd.md`'  # when TDD_APPLICABLE"), 'tdd-single-statement', /execute-phase\.md must list tdd\.md as an embed entry conditional on TDD_APPLICABLE/],
        ['the TDD_APPLICABLE condition dropped from the isolation dispatch', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', swap('${TDD_APPLICABLE ? "- tdd.md" : ""}', '- tdd.md  # TDD_APPLICABLE'), 'tdd-single-statement', /executor-isolation-dispatch\.md must list tdd\.md as an embed entry conditional on TDD_APPLICABLE/],
        ['the tdd.md embed entry erased from execute-phase', 'gsd-core/workflows/execute-phase.md', swap("${TDD_APPLICABLE ? '- `~/.claude/gsd-core/references/tdd.md`' : ''}", ''), 'tdd-single-statement', /execute-phase\.md must list tdd\.md as an embed entry conditional on TDD_APPLICABLE/],
    ['files_modified erased from the planner', 'agents/gsd-planner.md', eraseAll('files_modified'), 'parallel-dependent-plans', /the planner must reference files_modified/],
    ['both later-wave phrasings erased from the planner', 'agents/gsd-planner.md', (text) => [eraseAll('files_modified overlap'), eraseAll('later wave')].reduce((s, f) => f(s), text), 'parallel-dependent-plans', /the planner must explicitly require a later wave when files_modified overlap exists/],
    ['overlap erased from the assign_waves step', 'agents/gsd-planner.md', within('<step name="assign_waves">', '</step>', eraseAll('overlap')), 'parallel-dependent-plans', /the assign_waves step must handle file overlap as a wave-bumping condition/],
    ['the Rule marker erased from the assign_waves step', 'agents/gsd-planner.md', within('<step name="assign_waves">', '</step>', eraseAll('**Rule:**')), 'parallel-dependent-plans', /missing: \*\*Rule:\*\* paragraph/],
    ['the wave scope dropped from the rule sentence', 'agents/gsd-planner.md', swap('Same-wave plans must have zero', 'Plans must have zero'), 'parallel-dependent-plans', /\(missing: wave scope\)/],
    ['wave as part of a longer word does not scope the rule', 'agents/gsd-planner.md', swap('Same-wave plans must have zero', 'Same-waves plans must have zero'), 'parallel-dependent-plans', /\(missing: wave scope\)/],
    ['the files_modified subject dropped from the rule sentence', 'agents/gsd-planner.md', swap('`files_modified`/`files_deleted` overlap.', '`files_deleted` overlap.'), 'parallel-dependent-plans', /\(missing: files_modified subject\)/],
    ['the prohibition dropped from the rule sentence', 'agents/gsd-planner.md', swap('must have zero', 'have'), 'parallel-dependent-plans', /\(missing: prohibition\)/],
    ['a prohibition inside a longer word is no prohibition', 'agents/gsd-planner.md', swap('must have zero', 'must have nothing'), 'parallel-dependent-plans', /\(missing: prohibition\)/],
    ['the overlap predicate dropped from the rule sentence', 'agents/gsd-planner.md', swap('`files_deleted` overlap.', '`files_deleted` use.'), 'parallel-dependent-plans', /\(missing: overlap predicate\)/],
    ['the clauses spread over two sentences', 'agents/gsd-planner.md', swap('must have zero `files_modified`/`files_deleted` overlap.', 'must have `files_modified`/`files_deleted` overlap. Zero tolerance.'), 'parallel-dependent-plans', /\(missing: prohibition\)/],
    ['a blank line cuts the prohibition off the rule paragraph', 'agents/gsd-planner.md', swap('must have zero `files_modified`/`files_deleted` overlap.', 'must have `files_modified`/`files_deleted` overlap.\n\nzero'), 'parallel-dependent-plans', /\(missing: prohibition\)/],
    ['a whitespace-only line cuts the overlap off the rule paragraph', 'agents/gsd-planner.md', swap('must have zero `files_modified`/`files_deleted` overlap.', 'must have zero `files_modified`/`files_deleted` entries in common.\n   \noverlap'), 'parallel-dependent-plans', /\(missing: overlap predicate\)/],
    ['files_modified erased from execute-phase', 'gsd-core/workflows/execute-phase.md', eraseAll('files_modified'), 'parallel-dependent-plans', /the workflow must check for files_modified overlap within a wave before spawning/],
    ['overlap and intra-wave erased from execute-phase', 'gsd-core/workflows/execute-phase.md', (text) => [eraseAll('overlap'), eraseAll('intra-wave')].reduce((s, f) => f(s), text), 'parallel-dependent-plans', /missing: overlap or intra-wave/],
    ['the spawn heading moved before the overlap check', 'gsd-core/workflows/execute-phase.md', (text) => 'Spawn executor agents\n' + text, 'parallel-dependent-plans', /the overlap check must appear before the "Spawn executor agents" section/],
    ['the spawn heading erased from execute-phase', 'gsd-core/workflows/execute-phase.md', eraseAll('Spawn executor agents'), 'parallel-dependent-plans', /the "Spawn executor agents" heading is missing/],
    ['sequential erased from the overlap check', 'gsd-core/workflows/execute-phase.md', within('files_modified overlap', 'Spawn executor agents', eraseAll('sequential')), 'parallel-dependent-plans', /the workflow must direct sequential execution when overlap is detected/],
    ['warn erased from the overlap check in any case', 'gsd-core/workflows/execute-phase.md', within('files_modified overlap', 'Spawn executor agents', erase(/warn/gi)), 'parallel-dependent-plans', /log a warning when files_modified overlap is detected in a wave \(missing: warn\)/],
    ['overlap erased from an intra-wave overlap check', 'gsd-core/workflows/execute-phase.md', (text) => [swap('Intra-wave', 'intra-wave'), eraseAll('overlap')].reduce((s, f) => f(s), text), 'parallel-dependent-plans', /log a warning when files_modified overlap is detected in a wave \(missing: overlap\)/],
    ['every plan-pair phrase erased from the overlap check', 'gsd-core/workflows/execute-phase.md', (text) => [eraseAll('all plans in'), eraseAll('all plans within'), eraseAll('each pair'), eraseAll('any two plans')].reduce((s, f) => f(s), text), 'parallel-dependent-plans', /the overlap check must cover every plan pair in the wave/],
    ['name erased from the command frontmatter', 'commands/gsd/explore.md', eraseAll('name: gsd:explore'), 'explore-command', /the command must have name frontmatter/],
    ['description erased from the command frontmatter', 'commands/gsd/explore.md', eraseAll('description:'), 'explore-command', /the command must have description frontmatter/],
    ['allowed-tools erased from the command frontmatter', 'commands/gsd/explore.md', eraseAll('allowed-tools:'), 'explore-command', /the command must have allowed-tools frontmatter/],
    ['the name moved out of the command frontmatter into the body', 'commands/gsd/explore.md', (text) => [swap('name: gsd:explore', 'name: gsd:other'), append('name: gsd:explore')].reduce((s, f) => f(s), text), 'explore-command', /the command must have name frontmatter/],
    ['the workflow reference erased from the command', 'commands/gsd/explore.md', eraseAll('workflows/explore.md'), 'explore-command', /the command must reference workflows\/explore\.md in execution_context/],
    ['questioning.md erased', 'gsd-core/workflows/explore.md', eraseAll('questioning.md'), 'explore-command', /the workflow must reference questioning\.md/],
    ['domain-probes.md erased', 'gsd-core/workflows/explore.md', eraseAll('domain-probes.md'), 'explore-command', /the workflow must reference domain-probes\.md/],
    ['Note erased', 'gsd-core/workflows/explore.md', eraseAll('Note'), 'explore-command', /the workflow must document the Note output type/],
    ['Todo erased', 'gsd-core/workflows/explore.md', eraseAll('Todo'), 'explore-command', /the workflow must document the Todo output type/],
    ['Seed erased', 'gsd-core/workflows/explore.md', eraseAll('Seed'), 'explore-command', /the workflow must document the Seed output type/],
    ['Research question erased', 'gsd-core/workflows/explore.md', eraseAll('Research question'), 'explore-command', /the workflow must document the Research question output type/],
    ['Requirement erased', 'gsd-core/workflows/explore.md', eraseAll('Requirement'), 'explore-command', /the workflow must document the Requirement output type/],
    ['New phase erased', 'gsd-core/workflows/explore.md', eraseAll('New phase'), 'explore-command', /the workflow must document the New phase output type/],
    ['one question at a time erased', 'gsd-core/workflows/explore.md', eraseAll('one question at a time'), 'explore-command', /the workflow must mention the "one question at a time" principle/],
    ['both confirmation phrasings erased', 'gsd-core/workflows/explore.md', (text) => [eraseAll('explicit user selection'), eraseAll('Never write artifacts without')].reduce((s, f) => f(s), text), 'explore-command', /the workflow must require user confirmation before writing artifacts/],
    ['commit_docs erased', 'gsd-core/workflows/explore.md', eraseAll('commit_docs'), 'explore-command', /the workflow must respect the commit_docs configuration/],
    ['the Step 4 heading renamed', 'gsd-core/workflows/explore.md', swap('## Step 4', '## Stage 4'), 'explore-command', /the Step 3, Step 4 and Step 6 headings must exist in that order/],
    ['the Step 6 heading renamed', 'gsd-core/workflows/explore.md', swap('## Step 6', '## Stage 6'), 'explore-command', /the Step 3, Step 4 and Step 6 headings must exist in that order/],
    ['the Step 4 heading moved before Step 3', 'gsd-core/workflows/explore.md', swap('## Step 3', '## Step 4: placeholder\n\n## Step 3'), 'explore-command', /the headings are out of order/],
    ['the ledger anchor erased', 'gsd-core/workflows/explore.md', eraseAll('put it in the **Unresolved ledger**, **never smoothed into the narrative**'), 'explore-command', /the Step-3 region must state that an abstained claim is routed to the Unresolved ledger/],
    ['the ledger anchor moved out of Step 3', 'gsd-core/workflows/explore.md', (text) => [eraseAll('put it in the **Unresolved ledger**, **never smoothed into the narrative**'), append('put it in the **Unresolved ledger**, **never smoothed into the narrative**')].reduce((s, f) => f(s), text), 'explore-command', /the Step-3 region must state that an abstained claim is routed to the Unresolved ledger/],
    ['[admit: erased from the spawn prompt', 'gsd-core/workflows/explore.md', within('Agent(', 'subagent_type="gsd-phase-researcher"', eraseAll('[admit:')), 'explore-command', /the spawn prompt must ask the researcher for the \[admit:\/\[refute:\/\[abstain: tags \(missing: \[admit:\)/],
    ['[refute: erased from the spawn prompt', 'gsd-core/workflows/explore.md', within('Agent(', 'subagent_type="gsd-phase-researcher"', eraseAll('[refute:')), 'explore-command', /the spawn prompt must ask the researcher for the \[admit:\/\[refute:\/\[abstain: tags \(missing: \[refute:\)/],
    ['[abstain: erased from the spawn prompt', 'gsd-core/workflows/explore.md', within('Agent(', 'subagent_type="gsd-phase-researcher"', eraseAll('[abstain:')), 'explore-command', /the spawn prompt must ask the researcher for the \[admit:\/\[refute:\/\[abstain: tags \(missing: \[abstain:\)/],
    ['AUTHORITATIVE erased from the spawn prompt', 'gsd-core/workflows/explore.md', within('Agent(', 'subagent_type="gsd-phase-researcher"', eraseAll('AUTHORITATIVE')), 'explore-command', /the spawn prompt's refute arm must require the contradicting source be AUTHORITATIVE for the claim/],
    ['the authority qualifier moved out of the parentheses', 'gsd-core/workflows/explore.md', swap('(a source AUTHORITATIVE FOR THIS CLAIM contradicts it)', 'a source AUTHORITATIVE FOR THIS CLAIM contradicts it'), 'explore-command', /the spawn prompt's refute arm must require the contradicting source be AUTHORITATIVE for the claim/],
    ['the authority word put after the refute parentheses', 'gsd-core/workflows/explore.md', swap('[refute: <source>] (a source AUTHORITATIVE FOR THIS CLAIM contradicts it)', '[refute: <source>] (a source contradicts it) AUTHORITATIVE'), 'explore-command', /the spawn prompt's refute arm must require the contradicting source be AUTHORITATIVE for the claim/],
    ['the spawn agent marker erased', 'gsd-core/workflows/explore.md', eraseAll('subagent_type="gsd-phase-researcher"'), 'explore-command', /the researcher spawn must be found/],
    ['--pick tier erased', 'gsd-core/workflows/explore.md', eraseAll('--pick tier'), 'explore-command', /the tier floor needs the resolved tier as its trigger/],
    ['--pick model erased', 'gsd-core/workflows/explore.md', eraseAll('--pick model'), 'explore-command', /the spawn must bind the researcher model per model-profile-resolution\.md/],
    ['the model attribute erased from the spawn', 'gsd-core/workflows/explore.md', eraseAll('model="{RESEARCHER_MODEL}"'), 'explore-command', /the Agent\(\) spawn must pass the bound model/],
    ['the omit-on-inherit rule replaced', 'gsd-core/workflows/explore.md', swap('Omit `model=` entirely when `RESEARCHER_MODEL` is `inherit` or empty', 'Always pass `model=`'), 'explore-command', /#2517 requires the omit-on-inherit\/empty rule to ride with any model= binding/],
    ['the Tier floor bullet renamed', 'gsd-core/workflows/explore.md', swap('- **Tier floor**', '- **Tier cap**'), 'explore-command', /the Tier floor bullet must exist/],
    ['RESEARCHER_TIER erased', 'gsd-core/workflows/explore.md', eraseAll('RESEARCHER_TIER'), 'explore-command', /the floor must reference RESEARCHER_TIER, the single signal/],
    ['haiku erased', 'gsd-core/workflows/explore.md', eraseAll('haiku'), 'explore-command', /the floor must name `haiku` as the budget tier for gsd-phase-researcher/],
    ['unknown erased from the floor', 'gsd-core/workflows/explore.md', eraseAll('unknown'), 'explore-command', /the floor must cover an unreadable tier: unknown, inherit and empty \(missing: unknown\)/],
    ['inherit erased from the floor', 'gsd-core/workflows/explore.md', eraseAll('inherit'), 'explore-command', /the floor must cover an unreadable tier: unknown, inherit and empty \(missing: inherit\)/],
    ['empty erased from the floor', 'gsd-core/workflows/explore.md', eraseAll('empty'), 'explore-command', /the floor must cover an unreadable tier: unknown, inherit and empty \(missing: empty\)/],
    ['the floor turned into an unchanged admit', 'gsd-core/workflows/explore.md', swap('would-be **admit** as an **abstain**', 'would-be **admit** as an **admit**, unchanged'), 'explore-command', /the floor must state that a would-be admit is presented as an abstain/],
    ['an inverted floor phrase added to the clause', 'gsd-core/workflows/explore.md', swap('**Untagged findings.**', 'do not suppress **Untagged findings.**'), 'explore-command', /an inverted floor must fail/],
    ['model_overrides erased from the residual', 'gsd-core/workflows/explore.md', eraseAll('model_overrides'), 'explore-command', /the disclosed residual must name both the model_overrides and the model_profile_overrides cases \(missing: model_overrides\)/],
    ['model_profile_overrides erased from the residual', 'gsd-core/workflows/explore.md', eraseAll('model_profile_overrides'), 'explore-command', /the disclosed residual must name both the model_overrides and the model_profile_overrides cases \(missing: model_profile_overrides\)/],
    ['two cases erased', 'gsd-core/workflows/explore.md', eraseAll('two cases'), 'explore-command', /the residual must be counted as "two cases"/],
    ['the stale one case remains heading added', 'gsd-core/workflows/explore.md', swap('**Untagged findings.**', 'one case remains **Untagged findings.**'), 'explore-command', /the stale "one case remains" heading must not survive alongside the second disclosed case/],
    ['the unaffected sentence erased', 'gsd-core/workflows/explore.md', eraseAll('`refute` and `abstain` are unaffected'), 'explore-command', /the floor suppresses unearned confidence only/],
    ['authoritative erased in every case', 'gsd-core/workflows/explore.md', erase(/authoritative/gi), 'explore-command', /refute versus abstain needs a discriminator: source authority for the claim/],
    ['never authoritative erased', 'gsd-core/workflows/explore.md', erase(/never\s+authoritative/g), 'explore-command', /a "strong prior" must be stated as never authoritative alone/],
    ['the preamble erased', 'gsd-core/workflows/explore.md', eraseAll('_GSD_SHIM_NAME="gsd-tools.cjs"'), 'explore-command', /gsd_run must be bootstrapped before the tier-floor probe runs/],
    ['a tier probe put before the preamble', 'gsd-core/workflows/explore.md', swap('## Step 1: Open the conversation', 'X=resolve-model gsd-phase-researcher --pick tier\n## Step 1: Open the conversation'), 'explore-command', /gsd_run must be bootstrapped before the tier-floor probe runs/],
    ['the preamble inlined twice', 'gsd-core/workflows/explore.md', append('_GSD_SHIM_NAME="gsd-tools.cjs"'), 'explore-command', /the launcher preamble must be inlined exactly once/],
    ['gsd_run used before the preamble', 'gsd-core/workflows/explore.md', swap('## Step 1: Open the conversation', 'gsd_run x\n## Step 1: Open the conversation'), 'explore-command', /the preamble that DEFINES gsd_run must appear before the first USE of gsd_run anywhere in the file/],
    ['the preamble moved behind Step 3', 'gsd-core/workflows/explore.md', (text) => { const at = text.indexOf('_GSD_SHIM_NAME="gsd-tools.cjs"'); const start = text.lastIndexOf('\n', at) + 1; const end = text.indexOf('\n', at); return text.slice(0, start) + text.slice(end + 1) + '\n' + text.slice(start, end) + '\n'; }, 'explore-command', /the launcher preamble must be bootstrapped before Step 3/],
    ['unresolved never crystallized erased', 'gsd-core/workflows/explore.md', eraseAll('crystalliz'), 'explore-command', /Steps 4-5 must forbid crystallizing an unresolved-ledger claim as a flat assertion/],
    ['carry disposition erased', 'gsd-core/workflows/explore.md', erase(/carry/gi), 'explore-command', /Steps 4-5 must carry the research disposition into the durable artifact/],
    ['the untrusted-input reference erased from Step 4', 'gsd-core/workflows/explore.md', eraseAll('untrusted-input-boundary'), 'explore-command', /Step 4 must reference @gsd-core\/references\/untrusted-input-boundary\.md/],
    ['the per-wrap delimiter wording erased', 'gsd-core/workflows/explore.md', erase(/fresh random|data_/gi), 'explore-command', /Step 4 must require a fresh\/random per-wrap delimiter/],
    ['the guard intro erased', 'gsd-core/workflows/explore.md', eraseAll('Two guards ride with it:'), 'explore-command', /the guard-list intro must read "Two guards ride with it:"/],
    ['the guard intro turned into Three guards', 'gsd-core/workflows/explore.md', swap('Two guards ride with it:', 'Three guards ride with it:'), 'explore-command', /"Three guards" must not appear/],
    ['a third top-level guard bullet added', 'gsd-core/workflows/explore.md', swap('**Untagged findings.**', '- **Third guard** — extra.\n\n**Untagged findings.**'), 'explore-command', /exactly 2 top-level guard bullets are expected \(found 3 top-level guard bullets\)/],
    ['a guard bullet turned into prose', 'gsd-core/workflows/explore.md', swap('- **Conflict-abstention**', 'Conflict-abstention'), 'explore-command', /exactly 2 top-level guard bullets are expected \(found 1 top-level guard bullets\)/],
    ['the seed command erased', 'gsd-core/workflows/explore.md', eraseAll('/gsd:capture --seed'), 'explore-command', /explore step 5 must delegate seeds via \/gsd:capture --seed/],
    ['trigger_condition added', 'gsd-core/workflows/explore.md', append('trigger_condition'), 'explore-command', /the divergent trigger_condition field name must be gone/],
    ['planted_date added', 'gsd-core/workflows/explore.md', append('planted_date'), 'explore-command', /the divergent planted_date field name must be gone/],
    ['the hand-written seed file shape added', 'gsd-core/workflows/explore.md', append('Create `.planning/seeds/{slug}.md`'), 'explore-command', /the hand-written seeds\/\{slug\}\.md shape must be gone/],
    ['list-seeds erased', 'gsd-core/workflows/explore.md', eraseAll('list-seeds'), 'explore-command', /the seed instruction must name list-seeds/],
    ['audit-open erased', 'gsd-core/workflows/explore.md', eraseAll('audit-open'), 'explore-command', /the seed instruction must name audit-open/],
    ['new-milestone erased', 'gsd-core/workflows/explore.md', eraseAll('new-milestone'), 'explore-command', /the seed instruction must name new-milestone/],
    ['claim-disposition mode erased from the researcher agent', 'agents/gsd-phase-researcher.md', erase(/claim-disposition mode/gi), 'explore-command', /gsd-phase-researcher\.md must document the claim-disposition mode/],
    ['[admit: erased from the researcher agent', 'agents/gsd-phase-researcher.md', eraseAll('[admit:'), 'explore-command', /the researcher agent must define the \[admit:\/\[refute:\/\[abstain: disposition tags \(missing: \[admit:\)/],
    ['[refute: erased from the researcher agent', 'agents/gsd-phase-researcher.md', eraseAll('[refute:'), 'explore-command', /the researcher agent must define the \[admit:\/\[refute:\/\[abstain: disposition tags \(missing: \[refute:\)/],
    ['[abstain: erased from the researcher agent', 'agents/gsd-phase-researcher.md', eraseAll('[abstain:'), 'explore-command', /the researcher agent must define the \[admit:\/\[refute:\/\[abstain: disposition tags \(missing: \[abstain:\)/],
    ['the first enum copy of the researcher agent drifted', 'agents/gsd-phase-researcher.md', swap('`source-vs-prior conflict` | `non-authoritative source`', '`source-vs-prior conflict` | `non-authoritative sources`'), 'explore-command', /the ledger-reason enum in the researcher agent must match explore\.md/],
    ['the researcher agent enum erased', 'agents/gsd-phase-researcher.md', swap('`untagged — disposition not reported`', '`untagged`'), 'explore-command', /agents\/gsd-phase-researcher\.md must carry at least one copy of the 5-value ledger-reason enum/],
    ['the first enum copy of explore.md drifted', 'gsd-core/workflows/explore.md', (text) => { const at = text.indexOf(' | non-authoritative source | '); return text.slice(0, at) + ' | non-authoritative sources | ' + text.slice(at + 30); }, 'explore-command', /the copies within explore\.md are not byte-identical/],
    ['SEED- erased from plant-seed', 'gsd-core/workflows/plant-seed.md', eraseAll('SEED-'), 'explore-command', /plant-seed must mint SEED- ids/],
    ['status: dormant erased from plant-seed', 'gsd-core/workflows/plant-seed.md', eraseAll('status: dormant'), 'explore-command', /plant-seed must write status: dormant/],
    ['trigger_when erased from plant-seed', 'gsd-core/workflows/plant-seed.md', eraseAll('trigger_when'), 'explore-command', /plant-seed must write trigger_when/],
    ['source-vs-prior and conflict erased', 'gsd-core/workflows/explore.md', erase(/source-vs-prior|conflict/gi), 'explore-command', /the abstain arm must cover a source-vs-prior conflict \(conflict-abstention\), routing to the ledger/],
    ['the exempt tier flow line replaced in the revision loop', 'gsd-core/references/revision-loop.md', swap('If PASSED or only INFO-level issues', 'If PASSED or any issues'), 'plan-checker-coupling', /revision-loop\.md must state its exempt severity tier in the flow/],
    ['the Dimension 3b heading renamed', 'agents/gsd-plan-checker.md', swap('## Dimension 3b: ', '## Dimension 3c: '), 'plan-checker-coupling', /agents\/gsd-plan-checker\.md must define a "## Dimension 3b:" heading naming coupling as its subject/],
    ['coupling dropped from the Dimension 3b title', 'agents/gsd-plan-checker.md', swap('Undeclared / Temporal Coupling', 'Undeclared / Temporal Ordering'), 'plan-checker-coupling', /agents\/gsd-plan-checker\.md must define a "## Dimension 3b:" heading naming coupling as its subject/],
    ['the Dimension 4 heading renamed', 'agents/gsd-plan-checker.md', swap('## Dimension 4: ', '## Dimension 4b: '), 'plan-checker-coupling', /Dimensions 3, 3b and 4 must all be present/],
    ['a Dimension 4 heading placed before Dimension 3', 'agents/gsd-plan-checker.md', swap('## Dimension 3: ', '## Dimension 4: placeholder\n\n## Dimension 3: '), 'plan-checker-coupling', /Dimension 3b must precede Dimension 4: it extends Dimension 3/],
    ['a Dimension 3b heading placed before Dimension 3', 'agents/gsd-plan-checker.md', (text) => `## Dimension 3b: early coupling\n${text}`, 'plan-checker-coupling', /Dimension 3b must follow Dimension 3/],
    ['the plan-pair scope erased', 'agents/gsd-plan-checker.md', eraseAll('PLAN pairs, not tasks'), 'plan-checker-coupling', /Dimension 3b must state that the comparison is plan-pair scoped/],
    ['a trigger condition dropped', 'agents/gsd-plan-checker.md', swap('\n3. their actions', '\nthree their actions'), 'plan-checker-coupling', /found 2 ordered items/],
    ['a fourth trigger condition added', 'agents/gsd-plan-checker.md', swap('\n\n**Do NOT flag:**', '\n4. a fourth condition.\n\n**Do NOT flag:**'), 'plan-checker-coupling', /found 4 ordered items/],
    ['the info severity replaced by a warning in Dimension 3b', 'agents/gsd-plan-checker.md', within('## Dimension 3b: ', '## Dimension 4: ', swap('severity: info', 'severity: warning')), 'plan-checker-coupling', /example issue must carry the tier revision-loop\.md exempts/],
    ['a second yaml example with another tier', 'agents/gsd-plan-checker.md', within('## Dimension 3b: ', '## Dimension 4: ', swap('  severity: info\n', '  severity: info\n  other: 1\n```\n\n```yaml\nissue:\n  severity: warning\n')), 'plan-checker-coupling', /carries severity: warning, the exempt tier is info/],
    ['a blocker severity in Dimension 3b', 'agents/gsd-plan-checker.md', within('## Dimension 3b: ', '## Dimension 4: ', swap('severity: info', 'severity: blocker')), 'plan-checker-coupling', /a blocker-severity example is present/],
    ['the yaml example turned into text', 'agents/gsd-plan-checker.md', within('## Dimension 3b: ', '## Dimension 4: ', swap('```yaml', '```text')), 'plan-checker-coupling', /no severity-tagged yaml example/],
    ['never a blocker erased', 'agents/gsd-plan-checker.md', within('## Dimension 3b: ', '## Dimension 4: ', eraseAll('never a blocker')), 'plan-checker-coupling', /Dimension 3b must state that the finding is never a blocker/],
    ['the Dimension 3 blocker severity erased', 'agents/gsd-plan-checker.md', within('## Dimension 3: ', '## Dimension 3b: ', eraseAll('severity: blocker')), 'plan-checker-coupling', /Dimension 3's own example issue must still be severity: blocker/],
    ['the circular dependency example erased', 'agents/gsd-plan-checker.md', within('## Dimension 3: ', '## Dimension 3b: ', eraseAll('Circular dependency')), 'plan-checker-coupling', /Dimension 3 must still carry its circular-dependency example/],
    ['the dependency_correctness key erased', 'agents/gsd-plan-checker.md', within('## Dimension 3b: ', '## Dimension 4: ', eraseAll('dependency_correctness')), 'plan-checker-coupling', /Dimension 3b's example issue must reuse the dependency_correctness dimension key/],
    ['the non-triggering list erased', 'agents/gsd-plan-checker.md', within('## Dimension 3b: ', '## Dimension 4: ', eraseAll('Do NOT flag')), 'plan-checker-coupling', /Dimension 3b must carry an explicit non-triggering list/],
    ['depends_on erased from the non-triggering list', 'agents/gsd-plan-checker.md', within('## Dimension 3b: ', '## Dimension 4: ', eraseAll('depends_on')), 'plan-checker-coupling', /\(missing: depends_on\)/],
    ['files_modified erased from the non-triggering list', 'agents/gsd-plan-checker.md', within('## Dimension 3b: ', '## Dimension 4: ', eraseAll('files_modified')), 'plan-checker-coupling', /\(missing: files_modified\)/],
    ['different wave erased from the non-triggering list', 'agents/gsd-plan-checker.md', within('## Dimension 3b: ', '## Dimension 4: ', erase(/different wave/gi)), 'plan-checker-coupling', /\(missing: different wave\)/],
    ['READ erased from the non-triggering list', 'agents/gsd-plan-checker.md', within('## Dimension 3b: ', '## Dimension 4: ', eraseAll('READ')), 'plan-checker-coupling', /\(missing: READ\)/],
    ['the Dimension 9 deferral erased', 'agents/gsd-plan-checker.md', within('## Dimension 3b: ', '## Dimension 4: ', eraseAll('Dimension 9')), 'plan-checker-coupling', /Dimension 3b must defer incompatible-transform findings to Dimension 9/],
    ['the coupling_justified exemption erased', 'agents/gsd-plan-checker.md', within('## Dimension 3b: ', '## Dimension 4: ', eraseAll('declared `coupling_justified` in either plan\'s frontmatter')), 'plan-checker-coupling', /Dimension 3b must exempt a coupling_justified pair/],
    ['coupling_justified dropped from the fix hint', 'agents/gsd-plan-checker.md', swap('or set coupling_justified"', 'or set it"'), 'plan-checker-coupling', /the 3b fix_hint must name coupling_justified/],
    ['the info advisory of an applied exemption erased', 'agents/gsd-plan-checker.md', within('## Dimension 3b: ', '## Dimension 4: ', eraseAll('as its own `info` advisory')), 'plan-checker-coupling', /Dimension 3b must surface an applied coupling_justified exemption as an info advisory/],
    ['the INFO-only result exclusion from passed erased', 'agents/gsd-plan-checker.md', eraseAll('An INFO-only result is NOT `passed`'), 'plan-checker-coupling', /step 10 must exclude an INFO-only result from `passed`/],
    ['the INFO-only routing to ISSUES FOUND erased', 'agents/gsd-plan-checker.md', eraseAll('Return `## ISSUES FOUND` even when every issue is INFO'), 'plan-checker-coupling', /step 10 must route an INFO-only result to ## ISSUES FOUND/],
    ['the advisories section erased', 'agents/gsd-plan-checker.md', eraseAll('### Advisories (info)'), 'plan-checker-coupling', /the ISSUES FOUND template must carry an advisories section/],
    ['the advisory-only recommendation erased', 'agents/gsd-plan-checker.md', eraseAll('Advisory only — no revision required'), 'plan-checker-coupling', /the recommendation must not claim a planner return for an INFO-only result/],
    ['a duplicate dimension heading added', 'agents/gsd-plan-checker.md', append('## Dimension 3b: Another coupling heading'), 'plan-checker-coupling', /duplicate dimension labels/],
    ['the coupling line erased from the success criteria', 'agents/gsd-plan-checker.md', swap('- [ ] Undeclared/temporal coupling checked (same-wave plan pairs, advisory)', '- [ ] Something checked'), 'plan-checker-coupling', /the <success_criteria> checklist must carry a line for the coupling check/],
    ['the 3b row erased from the docs table', 'docs/reference/agents.md', erase(/^\| 3b \| .*\n/m), 'plan-checker-coupling', /omits dimension\(s\): 3b/],
    ['coupling erased from the docs', 'docs/reference/agents.md', erase(/coupling/gi), 'plan-checker-coupling', /docs\/reference\/agents\.md's gsd-plan-checker section must document the coupling check/],
    ['the parse-issue-count line renamed', 'gsd-core/workflows/plan-phase.md', swap('Parse issue count from checker return:', 'Parse the count:'), 'plan-checker-coupling', /plan-phase\.md step 12 must carry the parse-issue-count paragraph/],
    ['the INFO-only accept erased from step 12', 'gsd-core/workflows/plan-phase.md', eraseAll('likewise when every entry in the block is explicitly INFO (display them as advisories)'), 'plan-checker-coupling', /step 12 must accept only an explicitly-INFO issues block/],
    ['the BLOCKER and WARNING gate erased', 'gsd-core/workflows/plan-phase.md', eraseAll('count BLOCKER + WARNING entries in the YAML issues block'), 'plan-checker-coupling', /step 12 must keep gating the revision loop on BLOCKER \+ WARNING counts/],
    ['the iteration cap arm renamed', 'gsd-core/workflows/plan-phase.md', swap('**If iteration_count >= 3:**', '**If iteration_count >= 4:**'), 'plan-checker-coupling', /plan-phase\.md must carry the iteration_count >= 3 arm/],
    ['the recount erased from the iteration cap arm', 'gsd-core/workflows/plan-phase.md', eraseAll('Recount BLOCKER + WARNING'), 'plan-checker-coupling', /the iteration cap arm lacks: Recount BLOCKER \+ WARNING/],
    ['the INFO-only accept erased from the iteration cap arm', 'gsd-core/workflows/plan-phase.md', eraseAll('explicitly INFO — display any advisories and proceed to step 13'), 'plan-checker-coupling', /the iteration cap arm lacks: explicitly INFO/],
    ['the fail-closed clause erased from the first arm', 'gsd-core/workflows/plan-phase.md', (text) => { const at = text.indexOf('an entry whose severity is missing or unrecognized counts as a BLOCKER (fail closed)'); return text.slice(0, at) + '' + text.slice(at + 84); }, 'plan-checker-coupling', /the plan-phase iteration_count < 3 arm must carry the fail-closed clause verbatim/],
    ['the fail-closed clause erased from the iteration cap arm', 'gsd-core/workflows/plan-phase.md', (text) => { const at = text.lastIndexOf('an entry whose severity is missing or unrecognized counts as a BLOCKER (fail closed)'); return text.slice(0, at) + '' + text.slice(at + 84); }, 'plan-checker-coupling', /the plan-phase iteration_count >= 3 arm must carry the fail-closed clause verbatim/],
    ['the verify-work handler line renamed', 'gsd-core/workflows/verify-work.md', swap('- **ISSUES FOUND:**', '- **ISSUES:**'), 'plan-checker-coupling', /verify-work\.md must carry the ISSUES FOUND handler line/],
    ['the count erased from the verify-work handler', 'gsd-core/workflows/verify-work.md', eraseAll('Count BLOCKER + WARNING'), 'plan-checker-coupling', /the verify_gap_plans handler lacks: Count BLOCKER \+ WARNING/],
    ['the INFO-only accept erased from the verify-work handler', 'gsd-core/workflows/verify-work.md', eraseAll('every entry is explicitly INFO'), 'plan-checker-coupling', /the verify_gap_plans handler lacks: every entry is explicitly INFO/],
    ['the fail-closed clause erased from the verify-work handler', 'gsd-core/workflows/verify-work.md', eraseAll('an entry whose severity is missing or unrecognized counts as a BLOCKER (fail closed)'), 'plan-checker-coupling', /the verify_gap_plans handler lacks: an entry whose severity is missing/],
    ['the quick-mode handler line renamed', 'gsd-core/workflows/quick/steps/plan-checker-loop.md', swap('- **`## ISSUES FOUND`:**', '- **`## ISSUES`:**'), 'plan-checker-coupling', /plan-checker-loop\.md must carry the ISSUES FOUND handler line/],
    ['the INFO-only accept erased from the quick-mode handler', 'gsd-core/workflows/quick/steps/plan-checker-loop.md', eraseAll('every entry is explicitly INFO'), 'plan-checker-coupling', /the quick-mode handler lacks: every entry is explicitly INFO/],
    ['the proceed step erased from the quick-mode handler', 'gsd-core/workflows/quick/steps/plan-checker-loop.md', eraseAll('proceed to step 6'), 'plan-checker-coupling', /the quick-mode handler lacks: proceed to step 6/],
    ['the fail-closed clause erased from the quick-mode handler', 'gsd-core/workflows/quick/steps/plan-checker-loop.md', eraseAll('an entry whose severity is missing or unrecognized counts as a BLOCKER (fail closed)'), 'plan-checker-coupling', /the quick-mode handler lacks: an entry whose severity is missing/],
    ['the import handler paragraph renamed', 'gsd-core/workflows/import.md', swap('Handle the checker return by severity', 'Handle the return'), 'plan-checker-coupling', /import\.md plan_validate must carry the severity-aware handler paragraph/],
    ['the never-blocks sentence erased from the import handler', 'gsd-core/workflows/import.md', eraseAll('never blocks an import'), 'plan-checker-coupling', /the import handler lacks: never blocks an import/],
    ['the fail-closed clause erased from the import handler', 'gsd-core/workflows/import.md', eraseAll('an entry whose severity is missing or unrecognized counts as a BLOCKER (fail closed)'), 'plan-checker-coupling', /the import handler lacks: an entry whose severity is missing/],
    ['the plan-checker row renamed in agent-contracts', 'gsd-core/references/agent-contracts.md', swap('| gsd-plan-checker |', '| gsd-plan-check |'), 'plan-checker-coupling', /agent-contracts\.md must carry the gsd-plan-checker row/],
    ['import.md erased from the plan-checker row', 'gsd-core/references/agent-contracts.md', (text) => text.split('\n').map((line) => (line.startsWith('| gsd-plan-checker |') ? line.split('gsd-core/workflows/import.md').join('') : line)).join('\n'), 'plan-checker-coupling', /agent-contracts\.md must list import\.md as a gsd-plan-checker sentinel consumer/],
    ['the coupling pointer erased from the planner', 'agents/gsd-planner.md', eraseAll('@~/.claude/gsd-core/references/planner-coupling.md'), 'plan-checker-coupling', /gsd-planner\.md must point at the planner-coupling reference/],
    ['the mutable resource rule erased from the coupling reference', 'gsd-core/references/planner-coupling.md', erase(/mutable\s+resource/gi), 'plan-checker-coupling', /planner-coupling\.md must state the shared-mutable-resource rule/],
    ['coupling_justified erased from the coupling reference', 'gsd-core/references/planner-coupling.md', eraseAll('coupling_justified'), 'plan-checker-coupling', /planner-coupling\.md must document the coupling_justified declaration/],
    ['Dimension 3b erased from the coupling reference', 'gsd-core/references/planner-coupling.md', eraseAll('Dimension 3b'), 'plan-checker-coupling', /planner-coupling\.md must name the verifying side \(Dimension 3b\)/],
    ['Step 5.5 erased from spec-phase', 'gsd-core/workflows/spec-phase.md', eraseAll('Step 5.5'), 'edge-probe-spec-phase-contract', /the Step 5\.5 block must be extractable from spec-phase\.md/],
    ['edge-probe.cjs erased from Step 5.5', 'gsd-core/workflows/spec-phase.md', eraseAll('edge-probe.cjs'), 'edge-probe-spec-phase-contract', /Step 5\.5 must reference edge-probe\.cjs as the artifact being resolved/],
    ['the node invocation replaced', 'gsd-core/workflows/spec-phase.md', swap('node "$EDGE_PROBE_JS"', 'run "$EDGE_PROBE_JS"'), 'edge-probe-spec-phase-contract', /Step 5\.5 must invoke edge-probe\.cjs via node/],
    ['the REQS_JSON write redirected elsewhere', 'gsd-core/workflows/spec-phase.md', swap('cat > "$REQS_JSON"', 'cat > "$OTHER_JSON"'), 'edge-probe-spec-phase-contract', /Step 5\.5 must WRITE requirements into \$REQS_JSON/],
    ['the REQS_JSON write moved behind the engine call', 'gsd-core/workflows/spec-phase.md', (text) => [swap('cat > "$REQS_JSON" <<\'JSON\'', 'cat <<\'JSON\''), swap('# Exit-0-but-garbage guard', 'cat > "$REQS_JSON"\n# Exit-0-but-garbage guard')].reduce((s, f) => f(s), text), 'edge-probe-spec-phase-contract', /Step 5\.5 must populate \$REQS_JSON BEFORE invoking edge-probe\.cjs/],
    ['the empty guard erased', 'gsd-core/workflows/spec-phase.md', (text) => [eraseAll('Array.isArray'), eraseAll('empty')].reduce((s, f) => f(s), text), 'edge-probe-spec-phase-contract', /Step 5\.5 must guard against an empty\/invalid \$REQS_JSON before invoking/],
    ['the not-found branch erased', 'gsd-core/workflows/spec-phase.md', (text) => [eraseAll('build:lib'), eraseAll('not found'), eraseAll('ERROR')].reduce((s, f) => f(s), text), 'edge-probe-spec-phase-contract', /Step 5\.5 must have an explicit not-found branch/],
    ['the build prefix pin erased', 'gsd-core/workflows/spec-phase.md', swap('npm --prefix "$_GSD_RT" run build:lib', 'npm run build:lib'), 'edge-probe-spec-phase-contract', /build:lib must be pinned with `npm --prefix "\$_GSD_RT"`/],
    ['the npm build invocation replaced', 'gsd-core/workflows/spec-phase.md', swap('npm --prefix "$_GSD_RT" run build:lib', 'echo build'), 'edge-probe-spec-phase-contract', /Step 5\.5 must contain at least one npm build:lib invocation/],
    ['the source checkout gate erased', 'gsd-core/workflows/spec-phase.md', eraseAll('tsconfig.build.json'), 'edge-probe-spec-phase-contract', /Step 5\.5 must gate the build behind a GSD source checkout/],
    ['the engine exit check erased', 'gsd-core/workflows/spec-phase.md', swap('if ! COVERAGE=$(node "$EDGE_PROBE_JS"', 'COVERAGE=$(node "$EDGE_PROBE_JS"'), 'edge-probe-spec-phase-contract', /Step 5\.5 must exit-check the engine invocation/],
    ['JSON.parse erased', 'gsd-core/workflows/spec-phase.md', eraseAll('JSON.parse'), 'edge-probe-spec-phase-contract', /Step 5\.5 must validate \$COVERAGE parses as JSON before use/],
    ['coverage.applicable erased', 'gsd-core/workflows/spec-phase.md', eraseAll('coverage.applicable'), 'edge-probe-spec-phase-contract', /Step 5\.5 must read coverage\.applicable/],
    ['the bare render turned into a capture', 'gsd-core/workflows/spec-phase.md', swap('printf \'%s\\n\' "$COVERAGE"', 'X=$(printf \'%s\\n\' "$COVERAGE")'), 'edge-probe-spec-phase-contract', /Step 5\.5 must RENDER \$COVERAGE to the model context/],
    ['the bare render piped into node', 'gsd-core/workflows/spec-phase.md', swap('printf \'%s\\n\' "$COVERAGE"', 'printf \'%s\\n\' "$COVERAGE" | node -e 1'), 'edge-probe-spec-phase-contract', /Step 5\.5 must RENDER \$COVERAGE to the model context/],
    ['the bare render turned into a comment', 'gsd-core/workflows/spec-phase.md', swap('printf \'%s\\n\' "$COVERAGE"', '# printf \'%s\\n\' "$COVERAGE"'), 'edge-probe-spec-phase-contract', /Step 5\.5 must RENDER \$COVERAGE to the model context/],
    ['floor erased in any case', 'gsd-core/workflows/spec-phase.md', erase(/floor/gi), 'edge-probe-spec-phase-contract', /Step 5\.5 resolution loop must describe the rendered engine rows as a FLOOR/],
    ['every not-a-ceiling phrasing erased', 'gsd-core/workflows/spec-phase.md', erase(/recall gap|never a ceiling|not a ceiling|add(ing)? (any|the missed|categor)/gi), 'edge-probe-spec-phase-contract', /the floor must NOT be a ceiling/],
    ['the retired covered status added', 'gsd-core/workflows/spec-phase.md', append('mark the edge `covered`'), 'edge-probe-spec-phase-contract', /spec-phase\.md must not instruct agents to mark edges as "covered"/],
    ['the retired backstop status added', 'gsd-core/workflows/spec-phase.md', append('mark `backstop` now'), 'edge-probe-spec-phase-contract', /spec-phase\.md must not instruct agents to mark edges as "backstop"/],
    ['verification: explicit erased from spec-phase', 'gsd-core/workflows/spec-phase.md', eraseAll('verification: explicit'), 'edge-probe-spec-phase-contract', /spec-phase\.md must use "resolved" with "verification: explicit" for specified edges/],
    ['verification: backstop erased from spec-phase', 'gsd-core/workflows/spec-phase.md', eraseAll('verification: backstop'), 'edge-probe-spec-phase-contract', /spec-phase\.md must use "resolved" with "verification: backstop" for backstopped edges/],
    ['response_language erased from Step 5.5', 'gsd-core/workflows/spec-phase.md', eraseAll('response_language'), 'edge-probe-spec-phase-contract', /Step 5\.5 must name `response_language`/],
    ['translat erased from Step 5.5', 'gsd-core/workflows/spec-phase.md', erase(/translat/gi), 'edge-probe-spec-phase-contract', /Step 5\.5 must instruct that the probe input carries a translation/],
    ['English erased from Step 5.5', 'gsd-core/workflows/spec-phase.md', eraseAll('English'), 'edge-probe-spec-phase-contract', /Step 5\.5 must say the translation target is English/],
    ['the SPEC original language statement erased', 'gsd-core/workflows/spec-phase.md', erase(/original language|stays in|keeps/gi), 'edge-probe-spec-phase-contract', /Step 5\.5 must state the SPEC keeps the original language/],
    ['the id stability statement erased', 'gsd-core/workflows/spec-phase.md', erase(/unchanged|not translated|never translated|stable/gi), 'edge-probe-spec-phase-contract', /Step 5\.5 must state requirement ids are NOT translated or renumbered/],
    ['the shapes override erased', 'gsd-core/workflows/spec-phase.md', eraseAll('`shapes`'), 'edge-probe-spec-phase-contract', /Step 5\.5 must name the authored `shapes` override/],
    ['response_language moved behind the write', 'gsd-core/workflows/spec-phase.md', (text) => [eraseAll('response_language'), swap('JSON\n# Guard — never invoke', 'JSON\n# response_language\n# Guard — never invoke')].reduce((s, f) => f(s), text), 'edge-probe-spec-phase-contract', /the translation instruction must come BEFORE the \$REQS_JSON write/],
    ['the mktemp erased', 'gsd-core/workflows/spec-phase.md', eraseAll('REQS_JSON=$(mktemp'), 'edge-probe-spec-phase-contract', /Step 5\.5 must create \$REQS_JSON via mktemp/],
    ['the unconditional cleanup erased', 'gsd-core/workflows/spec-phase.md', swap('fi\nrm -f "$REQS_JSON"\n# Exit-0-but-garbage', 'fi\n# Exit-0-but-garbage'), 'edge-probe-spec-phase-contract', /Step 5\.5 must unconditionally rm -f "\$REQS_JSON" after the engine run/],
    ['the cleanup erased from the empty guard exit', 'gsd-core/workflows/spec-phase.md', (text) => { const at = text.indexOf('  rm -f "$REQS_JSON"\n  echo "ERROR: edge-probe requirements JSON'); return text.slice(0, at) + '  echo "ERROR: edge-probe requirements JSON' + text.slice(at + 64); }, 'edge-probe-spec-phase-contract', /leaking exits:/],
    ['text_en erased', 'gsd-core/workflows/spec-phase.md', eraseAll('text_en'), 'edge-probe-spec-phase-contract', /Step 5\.5 must name the text_en field/],
    ['the text original language statement erased', 'gsd-core/workflows/spec-phase.md', erase(/original language|SPEC's own|requirement's own|unchanged/gi), 'edge-probe-spec-phase-contract', /Step 5\.5 must state that text carries the SPEC requirement in its own \(original\) language/],
    ['coverage.unclassified erased from spec-phase', 'gsd-core/workflows/spec-phase.md', eraseAll('coverage.unclassified'), 'edge-probe-spec-phase-contract', /step 5\.5 must extract the unclassified sibling count/],
    ['the all-unclassified comparison erased from spec-phase', 'gsd-core/workflows/spec-phase.md', eraseAll('[ "$UNCLASSIFIED" = "$APPLICABLE" ]'), 'edge-probe-spec-phase-contract', /the guard must fire when every requirement is unclassified/],
    ['the widened guard confirmation erased from spec-phase', 'gsd-core/workflows/spec-phase.md', eraseAll('If the guard above fired'), 'edge-probe-spec-phase-contract', /the mandatory AskUserQuestion confirmation must key on the widened guard/],
    ['English erased from the edge-probe reference', 'gsd-core/references/edge-probe.md', eraseAll('English'), 'edge-probe-spec-phase-contract', /the edge-probe reference `## Inputs` contract must state that the heuristic classifier is English-cue based/],
    ['response_language erased from the edge-probe reference', 'gsd-core/references/edge-probe.md', eraseAll('response_language'), 'edge-probe-spec-phase-contract', /the edge-probe reference must point non-English projects at the translated-input requirement/],
    ['text_en erased from the edge-probe reference', 'gsd-core/references/edge-probe.md', eraseAll('text_en'), 'edge-probe-spec-phase-contract', /the edge-probe reference `## Inputs` contract must document the optional text_en field/],
    ['a covered edge status added to plan-phase', 'gsd-core/workflows/plan-phase.md', append('`covered` edge'), 'edge-probe-spec-phase-contract', /plan-phase\.md must not reference "covered" edges as a status/],
    ['a backstop edge status added to plan-phase', 'gsd-core/workflows/plan-phase.md', append('`backstop` edge'), 'edge-probe-spec-phase-contract', /plan-phase\.md must not reference "backstop" edges as a status/],
    ['the resolved lift rule erased from plan-phase', 'gsd-core/workflows/plan-phase.md', eraseAll('resolved (verification: explicit)'), 'edge-probe-spec-phase-contract', /plan-phase\.md lift rule must use "resolved \(verification: explicit\)"/],
    ['a covered resolution added to ui-phase', 'gsd-core/workflows/ui-phase.md', append('→ `covered`'), 'edge-probe-spec-phase-contract', /ui-phase\.md must not use "covered" as a resolution status/],
    ['verification: explicit erased from ui-phase', 'gsd-core/workflows/ui-phase.md', eraseAll('verification: explicit'), 'edge-probe-spec-phase-contract', /ui-phase\.md resolution must use "resolved" with "verification: explicit"/],
    ['coverage.unclassified erased from ui-phase', 'gsd-core/workflows/ui-phase.md', eraseAll('coverage.unclassified'), 'edge-probe-spec-phase-contract', /ui-phase\.md guard must be widened identically \(#4656\): the unclassified count/],
    ['the all-unclassified comparison erased from ui-phase', 'gsd-core/workflows/ui-phase.md', eraseAll('[ "$UNCLASSIFIED" = "$APPLICABLE" ]'), 'edge-probe-spec-phase-contract', /ui-phase\.md guard must be widened identically \(#4656\): the all-unclassified comparison/],
    ['the widened guard confirmation erased from ui-phase', 'gsd-core/workflows/ui-phase.md', eraseAll('If the guard above fired'), 'edge-probe-spec-phase-contract', /ui-phase confirmation prose must key on the widened guard too/],
    ['an auto covered status added to the fallback', 'gsd-core/references/specless-probe-fallback.md', append('auto-`covered`'), 'edge-probe-spec-phase-contract', /specless-probe-fallback\.md must not use auto-"covered"/],
    ['an auto backstop status added to the fallback', 'gsd-core/references/specless-probe-fallback.md', append('auto-`backstop`'), 'edge-probe-spec-phase-contract', /specless-probe-fallback\.md must not use auto-"backstop" as a status/],
    ['a covered edge status added to the fallback', 'gsd-core/references/specless-probe-fallback.md', append('`covered` edge'), 'edge-probe-spec-phase-contract', /specless-probe-fallback\.md must not reference "covered" edges as a status/],
    ['the auto resolved status erased from the fallback', 'gsd-core/references/specless-probe-fallback.md', eraseAll('auto-`resolved`'), 'edge-probe-spec-phase-contract', /specless-probe-fallback\.md must use auto-"resolved"/],
    ['verification: explicit erased from the fallback', 'gsd-core/references/specless-probe-fallback.md', eraseAll('verification: explicit'), 'edge-probe-spec-phase-contract', /specless-probe-fallback\.md must reference "verification: explicit"/],
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
    // Edit combinators: several edits in a row, a word added at the end.
    const compose1 = (...edits) => (text) => edits.reduce((value, edit) => edit(value), text);
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

    // ---- group 1 additions: an edited JSON document, a contract built over a loader that throws.
    const jsonEdit1 = (edit) => (text) => { const value = JSON.parse(text); edit(value); return JSON.stringify(value); };
    const seamRun1 = (t, root, factory) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-seam-'));
      t.after(() => cleanup(dir));
      const real = path.join(REPO_ROOT, 'scripts', 'static-checks', 'text-contracts', 'edit-phase.cjs');
      fs.writeFileSync(path.join(dir, 'edit-phase.cjs'), `const real = require(${JSON.stringify(real)});\nmodule.exports = { id: real.id, check: ${factory} };\n`);
      return textContracts.run({ root, dir, only: ['edit-phase'], minContracts: 1 });
    };

    // ---- adr-230-pr-target-policy
    goneOne1('.github/workflows/pr-target-validator.yml', 'adr-230-pr-target-policy', 'removed');
    goneOne1('.github/workflows/pr-target-validator.yml', 'adr-230-pr-target-policy', 'emptied');
    exactly1('the ref pin gone is one finding', [['.github/workflows/pr-target-validator.yml', swap('ref: ${{ github.event.pull_request.base.ref }}', 'ref: main')]], 'adr-230-pr-target-policy', 1, /the checkout step must pin ref to github\.event\.pull_request\.base\.ref/);
    exactly1('the policy call gone is one finding', [['.github/workflows/pr-target-validator.yml', swap('classifyPrTarget(base, head)', 'decide(base, head)')]], 'adr-230-pr-target-policy', 1, /the github-script must call classifyPrTarget\(\)/);
    exactly1('the WARN_ONLY env gone is one finding', [['.github/workflows/pr-target-validator.yml', eraseAll('WARN_ONLY')]], 'adr-230-pr-target-policy', 1, /the WARN_ONLY env must still be present/);
    exactly1('the inline array back is one finding', [['.github/workflows/pr-target-validator.yml', append('const mainAllowed = [\'release/*\'];')]], 'adr-230-pr-target-policy', 1, /the old inline mainAllowed array must not appear in the rewired workflow/);
    exactly1('the carve-out gone is one finding', [['.github/workflows/pr-target-validator.yml', eraseAll('COLLABORATOR')]], 'adr-230-pr-target-policy', 1, /the maintainer association carve-out \(OWNER, MEMBER, COLLABORATOR\) must still be present/);
    quiet1('ref pin: no blank between the tokens is enough', [['.github/workflows/pr-target-validator.yml', swap('ref: ${{ github.event.pull_request.base.ref }}', 'ref:${{github.event.pull_request.base.ref}}')]], 'adr-230-pr-target-policy', /the checkout step must pin ref to github\.event\.pull_request\.base\.ref/);
    quiet1('ref pin: tabs and a no-break space between the tokens are enough', [['.github/workflows/pr-target-validator.yml', swap('ref: ${{ github.event.pull_request.base.ref }}', 'ref:\t${{\u00a0github.event.pull_request.base.ref\t}}')]], 'adr-230-pr-target-policy', /the checkout step must pin ref to github\.event\.pull_request\.base\.ref/);
    quiet1('ref pin: a newline between the tokens is enough', [['.github/workflows/pr-target-validator.yml', swap('ref: ${{ github.event.pull_request.base.ref }}', 'ref:\n${{\ngithub.event.pull_request.base.ref\n}}')]], 'adr-230-pr-target-policy', /the checkout step must pin ref to github\.event\.pull_request\.base\.ref/);
    editFiles1('ref pin: another ref expression is a finding', [['.github/workflows/pr-target-validator.yml', swap('ref: ${{ github.event.pull_request.base.ref }}', 'ref: ${{ github.event.pull_request.base.sha }}')]], 'adr-230-pr-target-policy', /the checkout step must pin ref to github\.event\.pull_request\.base\.ref/);
    editFiles1('ref pin: a single closing brace is a finding', [['.github/workflows/pr-target-validator.yml', swap('ref: ${{ github.event.pull_request.base.ref }}', 'ref: ${{ github.event.pull_request.base.ref }')]], 'adr-230-pr-target-policy', /the checkout step must pin ref to github\.event\.pull_request\.base\.ref/);
    editFiles1('ref pin: the key renamed is a finding', [['.github/workflows/pr-target-validator.yml', swap('ref: ${{ github.event.pull_request.base.ref }}', 'refs: ${{ github.event.pull_request.base.ref }}')]], 'adr-230-pr-target-policy', /the checkout step must pin ref to github\.event\.pull_request\.base\.ref/);
    quiet1('require: any text between require( and the path is enough', [['.github/workflows/pr-target-validator.yml', swap('require(`${process.env.GITHUB_WORKSPACE}/scripts/pr-target-policy.cjs`)', 'require(`x/y/z/scripts/pr-target-policy.cjs`)')]], 'adr-230-pr-target-policy', /the github-script must require scripts\/pr-target-policy\.cjs/);
    editFiles1('require: the path on the next line is a finding', [['.github/workflows/pr-target-validator.yml', swap('require(`${process.env.GITHUB_WORKSPACE}/scripts/pr-target-policy.cjs`)', 'require(\n`${process.env.GITHUB_WORKSPACE}/scripts/pr-target-policy.cjs`)')]], 'adr-230-pr-target-policy', /the github-script must require scripts\/pr-target-policy\.cjs/);
    editFiles1('require: the path after a U+2028 is a finding', [['.github/workflows/pr-target-validator.yml', swap('require(`${process.env.GITHUB_WORKSPACE}/scripts/pr-target-policy.cjs`)', 'require(\u2028`${process.env.GITHUB_WORKSPACE}/scripts/pr-target-policy.cjs`)')]], 'adr-230-pr-target-policy', /the github-script must require scripts\/pr-target-policy\.cjs/);
    editFiles1('require: the path after a U+2029 is a finding', [['.github/workflows/pr-target-validator.yml', swap('require(`${process.env.GITHUB_WORKSPACE}/scripts/pr-target-policy.cjs`)', 'require(\u2029`${process.env.GITHUB_WORKSPACE}/scripts/pr-target-policy.cjs`)')]], 'adr-230-pr-target-policy', /the github-script must require scripts\/pr-target-policy\.cjs/);
    editFiles1('require: the path after a lone CR is a finding', [['.github/workflows/pr-target-validator.yml', swap('require(`${process.env.GITHUB_WORKSPACE}/scripts/pr-target-policy.cjs`)', 'require(\r`${process.env.GITHUB_WORKSPACE}/scripts/pr-target-policy.cjs`)')]], 'adr-230-pr-target-policy', /the github-script must require scripts\/pr-target-policy\.cjs/);
    editFiles1('require: the path before the require( is a finding', [['.github/workflows/pr-target-validator.yml', swap('require(`${process.env.GITHUB_WORKSPACE}/scripts/pr-target-policy.cjs`)', 'load(`scripts/pr-target-policy.cjs`) /* require( */')]], 'adr-230-pr-target-policy', /the github-script must require scripts\/pr-target-policy\.cjs/);
    editFiles1('mainAllowed: a tab before the equals sign is the old declaration', [['.github/workflows/pr-target-validator.yml', append('const mainAllowed\t= [];')]], 'adr-230-pr-target-policy', /the old inline mainAllowed array must not appear in the rewired workflow/);
    editFiles1('mainAllowed: no blank before the equals sign is the old declaration', [['.github/workflows/pr-target-validator.yml', append('const mainAllowed= [];')]], 'adr-230-pr-target-policy', /the old inline mainAllowed array must not appear in the rewired workflow/);
    editFiles1('mainAllowed: the equals sign on the next line is the old declaration', [['.github/workflows/pr-target-validator.yml', append('const mainAllowed\n= [];')]], 'adr-230-pr-target-policy', /the old inline mainAllowed array must not appear in the rewired workflow/);
    editFiles1('mainAllowed: a comparison is read as the old declaration', [['.github/workflows/pr-target-validator.yml', append('const mainAllowed == x')]], 'adr-230-pr-target-policy', /the old inline mainAllowed array must not appear in the rewired workflow/);
    quiet1('mainAllowed: a longer name is not the old declaration', [['.github/workflows/pr-target-validator.yml', append('const mainAllowedList = [];')]], 'adr-230-pr-target-policy', /the old inline mainAllowed array must not appear in the rewired workflow/);
    quiet1('mainAllowed: a declaration without an equals sign is not the old declaration', [['.github/workflows/pr-target-validator.yml', append('const mainAllowed;')]], 'adr-230-pr-target-policy', /the old inline mainAllowed array must not appear in the rewired workflow/);
    quiet1('mainAllowed: a different keyword is not the old declaration', [['.github/workflows/pr-target-validator.yml', append('let mainAllowed = [];')]], 'adr-230-pr-target-policy', /the old inline mainAllowed array must not appear in the rewired workflow/);
    editFiles1('warning: the wording on the line after the call is a finding', [['.github/workflows/pr-target-validator.yml', swap('core.warning(`PR target mismatch (warning-only mode): ${head} → ${base}`);', 'core.warning(`PR target mismatch\n(warning-only mode): ${head} → ${base}`);')]], 'adr-230-pr-target-policy', /the WARN_ONLY warning message \(warning-only mode\) must be preserved on the core\.warning line/);
    editFiles1('warning: the wording before the call is a finding', [['.github/workflows/pr-target-validator.yml', swap('core.warning(`PR target mismatch (warning-only mode): ${head} → ${base}`);', '/* warning-only mode */ core.warning(`PR target mismatch: ${head} → ${base}`);')]], 'adr-230-pr-target-policy', /the WARN_ONLY warning message \(warning-only mode\) must be preserved on the core\.warning line/);
    editFiles1('warning: the wording after a U+2028 is a finding', [['.github/workflows/pr-target-validator.yml', swap('core.warning(`PR target mismatch (warning-only mode): ${head} → ${base}`);', 'core.warning(`PR target mismatch\u2028(warning-only mode): ${head} → ${base}`);')]], 'adr-230-pr-target-policy', /the WARN_ONLY warning message \(warning-only mode\) must be preserved on the core\.warning line/);
    quiet1('warning: any core.warning line may hold the wording', [['.github/workflows/pr-target-validator.yml', compose1(swap('(warning-only mode): ${head}', '(warn): ${head}'), swap('core.warning(`Unusual PR target: ${base}`)', 'core.warning(`Unusual PR target (warning-only mode): ${base}`)'))]], 'adr-230-pr-target-policy', /the WARN_ONLY warning message \(warning-only mode\) must be preserved on the core\.warning line/);
    quiet1('carve-out: COLLABORATOR, MEMBER, OWNER in that order is enough', [['.github/workflows/pr-target-validator.yml', (text) => text.split('non-OWNER/MEMBER/COLLABORATOR authors').join('non-maintainer authors').split('["OWNER","MEMBER","COLLABORATOR"]').join('["COLLABORATOR","MEMBER","OWNER"]')]], 'adr-230-pr-target-policy', /the maintainer association carve-out \(OWNER, MEMBER, COLLABORATOR\) must still be present/);
    editFiles1('carve-out: MEMBER, COLLABORATOR, OWNER in that order is a finding', [['.github/workflows/pr-target-validator.yml', (text) => text.split('non-OWNER/MEMBER/COLLABORATOR authors').join('non-maintainer authors').split('["OWNER","MEMBER","COLLABORATOR"]').join('["MEMBER","COLLABORATOR","OWNER"]')]], 'adr-230-pr-target-policy', /the maintainer association carve-out \(OWNER, MEMBER, COLLABORATOR\) must still be present/);
    editFiles1('carve-out: OWNER, COLLABORATOR, MEMBER in that order is a finding', [['.github/workflows/pr-target-validator.yml', (text) => text.split('non-OWNER/MEMBER/COLLABORATOR authors').join('non-maintainer authors').split('["OWNER","MEMBER","COLLABORATOR"]').join('["OWNER","COLLABORATOR","MEMBER"]')]], 'adr-230-pr-target-policy', /the maintainer association carve-out \(OWNER, MEMBER, COLLABORATOR\) must still be present/);
    {
      const fc = require('./helpers/fast-check-setup.cjs');
      const adr = require('../scripts/static-checks/text-contracts/adr-230-pr-target-policy.cjs').walkers;
      const strings = (tokens, maxLength = 10) => fc.array(fc.constantFrom(...tokens), { maxLength }).map((parts) => parts.join(''));
      const agrees = (name, arbitrary, pair) => {
        let accepted = 0;
        let rejected = 0;
        fc.assert(fc.property(arbitrary, (s) => {
          const [actual, expected] = pair(s);
          assert.equal(actual, expected, JSON.stringify(s));
          if (expected) accepted += 1;
          else rejected += 1;
        }));
        assert.ok(accepted > 0 && rejected > 0, `${name}: the property saw ${accepted} accepted and ${rejected} rejected strings`);
      };
      // The parts in order (the last ones cut short at random), each followed by 0..3 filler characters.
      const chainOf = (parts, fillers) => fc.tuple(fc.nat(parts.length), ...parts.map(() => fc.array(fc.constantFrom(...fillers), { maxLength: 3 }))).map(([keep, ...pads]) => parts.slice(0, keep).map((part, i) => part + pads[i].join('')).join(''));
      const BLANKS = [' ', '\t', '\u00a0', '\n', '\r', '\u2028', '\u2029', 'x'];
      const BASE = 'github.event.pull_request.base.ref';
      test('property: the ref pin agrees with /ref:\\s*\\$\\{\\{\\s*github...base\\.ref\\s*\\}\\}/', () => {
        const oracle = (s) => /ref:\s*\$\{\{\s*github\.event\.pull_request\.base\.ref\s*\}\}/.test(s);
        const inputs = fc.oneof(strings(['ref:', '${{', BASE, '}}', ' ', '\t', '\u00a0', '\n', 'x'], 12), chainOf(['ref:', '${{', BASE, '}}'], BLANKS), chainOf(['x', 'ref:', '${{', BASE, '}}'], [' ', '\t', '\u00a0', '\n']));
        agrees('ref pin', inputs, (s) => [adr.refPinnedToBase(s), oracle(s)]);
      });
      test('property: the require walk agrees with /require\\(.*scripts\\/pr-target-policy\\.cjs/', () => {
        const oracle = (s) => /require\(.*scripts\/pr-target-policy\.cjs/.test(s);
        const inputs = fc.oneof(strings(['require(', 'scripts/pr-target-policy.cjs', 'x', ' ', '\n', '\r', '\u2028', '\u2029'], 10), chainOf(['require(', 'scripts/pr-target-policy.cjs'], BLANKS), chainOf(['x', 'require(', 'require(', 'scripts/pr-target-policy.cjs'], BLANKS));
        agrees('require', inputs, (s) => [adr.requiresPolicy(s), oracle(s)]);
      });
      test('property: the declaration walk agrees with /const mainAllowed\\s*=/', () => {
        const oracle = (s) => /const mainAllowed\s*=/.test(s);
        const inputs = fc.oneof(strings(['const mainAllowed', '=', 'x', ' ', '\t', '\u00a0', '\n'], 10), chainOf(['const mainAllowed', '='], BLANKS), chainOf(['const mainAllowed', 'const mainAllowed', '='], BLANKS));
        agrees('declaration', inputs, (s) => [adr.declaresMainAllowed(s), oracle(s)]);
      });
      test('property: the warning walk agrees with /core\\.warning.*warning-only mode/', () => {
        const oracle = (s) => /core\.warning.*warning-only mode/.test(s);
        const inputs = fc.oneof(strings(['core.warning', 'warning-only mode', 'x', ' ', '\n', '\r', '\u2028', '\u2029'], 10), chainOf(['core.warning', 'warning-only mode'], BLANKS), chainOf(['core.warning', 'core.warning', 'warning-only mode'], BLANKS));
        agrees('warning', inputs, (s) => [adr.warnsInWarningOnlyMode(s), oracle(s)]);
      });
      test('property: the carve-out walk agrees with /OWNER.*MEMBER.*COLLABORATOR|COLLABORATOR.*MEMBER.*OWNER/s', () => {
        const oracle = (s) => /OWNER.*MEMBER.*COLLABORATOR|COLLABORATOR.*MEMBER.*OWNER/s.test(s);
        const orders = [['OWNER', 'MEMBER', 'COLLABORATOR'], ['COLLABORATOR', 'MEMBER', 'OWNER'], ['MEMBER', 'OWNER', 'COLLABORATOR'], ['OWNER', 'COLLABORATOR', 'MEMBER'], ['MEMBER', 'COLLABORATOR', 'OWNER']];
        const inputs = fc.oneof(strings(['OWNER', 'MEMBER', 'COLLABORATOR', 'x', '\n'], 8), fc.oneof(...orders.map((order) => chainOf(order, ['x', '\n', ' ']))), chainOf(['OWNER', 'MEMBER', 'COLLABORATOR', 'MEMBER', 'OWNER'], ['x', '\n']));
        agrees('carve-out', inputs, (s) => [adr.hasMaintainerAssociations(s), oracle(s)]);
      });
    }
    // ---- code-review-summary-parser
    goneOne1('gsd-core/workflows/code-review.md', 'code-review-summary-parser', 'removed');
    goneOne1('gsd-core/workflows/code-review.md', 'code-review-summary-parser', 'emptied');
    goneOne1('gsd-core/workflows/code-review-fix.md', 'code-review-summary-parser', 'removed');
    goneOne1('gsd-core/workflows/code-review-fix.md', 'code-review-summary-parser', 'emptied');
    exactly1('code-review: one raw site is one finding', [['gsd-core/workflows/code-review.md', (text) => { const at = text.indexOf('content.replace(/\\r\\n/g, \'\\n\').match('); return text.slice(0, at) + 'content.match(' + text.slice(at + 37); }]], 'code-review-summary-parser', 1, /every frontmatter-boundary site must normalize CRLF before matching/);
    exactly1('code-review-fix: one raw site is one finding', [['gsd-core/workflows/code-review-fix.md', (text) => { const at = text.indexOf('content.replace(/\\r\\n/g, \'\\n\').match('); return text.slice(0, at) + 'content.match(' + text.slice(at + 37); }]], 'code-review-summary-parser', 1, /every frontmatter-boundary site must normalize CRLF before matching/);
    exactly1('code-review: two sites are one finding', [['gsd-core/workflows/code-review.md', (text) => { const parts = text.split('/^---\\n([\\s\\S]*?)\\n---/)'); return parts.map((part, i) => (i === 0 ? part : (i <= 2 ? '/^---\\n([\\s\\S]*?)\\n---/)' : '/^x/)') + part)).join(''); }]], 'code-review-summary-parser', 1, /expected at least 3 frontmatter-boundary sites/);
    exactly1('code-review-fix: two sites are one finding', [['gsd-core/workflows/code-review-fix.md', (text) => { const parts = text.split('/^---\\n([\\s\\S]*?)\\n---/)'); return parts.map((part, i) => (i === 0 ? part : (i <= 2 ? '/^---\\n([\\s\\S]*?)\\n---/)' : '/^x/)') + part)).join(''); }]], 'code-review-summary-parser', 1, /expected at least 3 frontmatter-boundary sites/);
    editFiles1('code-review: two sites (limit - 1) are too few', [['gsd-core/workflows/code-review.md', compose1(append('const m = content.replace(/\\r\\n/g, \'\\n\').match(/^---\\n([\\s\\S]*?)\\n---/);'), (text) => { const parts = text.split('/^---\\n([\\s\\S]*?)\\n---/)'); return parts.map((part, i) => (i === 0 ? part : (i <= 2 ? '/^---\\n([\\s\\S]*?)\\n---/)' : '/^x/)') + part)).join(''); })]], 'code-review-summary-parser', /expected at least 3 frontmatter-boundary sites/);
    quiet1('code-review: three sites (the limit) are enough', [['gsd-core/workflows/code-review.md', compose1(append('const m = content.replace(/\\r\\n/g, \'\\n\').match(/^---\\n([\\s\\S]*?)\\n---/);'), (text) => { const parts = text.split('/^---\\n([\\s\\S]*?)\\n---/)'); return parts.map((part, i) => (i === 0 ? part : (i <= 3 ? '/^---\\n([\\s\\S]*?)\\n---/)' : '/^x/)') + part)).join(''); })]], 'code-review-summary-parser', /expected at least 3 frontmatter-boundary sites/);
    quiet1('code-review: four sites (limit + 1) are enough', [['gsd-core/workflows/code-review.md', compose1(append('const m = content.replace(/\\r\\n/g, \'\\n\').match(/^---\\n([\\s\\S]*?)\\n---/);'), (text) => { const parts = text.split('/^---\\n([\\s\\S]*?)\\n---/)'); return parts.map((part, i) => (i === 0 ? part : (i <= 4 ? '/^---\\n([\\s\\S]*?)\\n---/)' : '/^x/)') + part)).join(''); })]], 'code-review-summary-parser', /expected at least 3 frontmatter-boundary sites/);
    exactly1('two raw sites in code-review are one finding that names both lines', [['gsd-core/workflows/code-review.md', compose1(append('const a = content.match(/^---\\n([\\s\\S]*?)\\n---/);'), append('const a = content.match(/^---\\n([\\s\\S]*?)\\n---/);'))]], 'code-review-summary-parser', 1, /\(lines \d+, \d+\)/);
    exactly1('one raw site in code-review is one finding that names the line', [['gsd-core/workflows/code-review.md', append('const a = content.match(/^---\\n([\\s\\S]*?)\\n---/);')]], 'code-review-summary-parser', 1, /\(line \d+\)/);
    quiet1('code-review-fix: three sites (the limit) are enough', [['gsd-core/workflows/code-review-fix.md', (text) => { const parts = text.split('/^---\\n([\\s\\S]*?)\\n---/)'); return parts.map((part, i) => (i === 0 ? part : (i <= 3 ? '/^---\\n([\\s\\S]*?)\\n---/)' : '/^x/)') + part)).join(''); }]], 'code-review-summary-parser', /expected at least 3 frontmatter-boundary sites/);
    editFiles1('code-review-fix: two sites (limit - 1) are too few', [['gsd-core/workflows/code-review-fix.md', (text) => { const parts = text.split('/^---\\n([\\s\\S]*?)\\n---/)'); return parts.map((part, i) => (i === 0 ? part : (i <= 2 ? '/^---\\n([\\s\\S]*?)\\n---/)' : '/^x/)') + part)).join(''); }]], 'code-review-summary-parser', /expected at least 3 frontmatter-boundary sites/);
    editFiles1('code-review-fix: one site is too few', [['gsd-core/workflows/code-review-fix.md', (text) => { const parts = text.split('/^---\\n([\\s\\S]*?)\\n---/)'); return parts.map((part, i) => (i === 0 ? part : (i <= 1 ? '/^---\\n([\\s\\S]*?)\\n---/)' : '/^x/)') + part)).join(''); }]], 'code-review-summary-parser', /expected at least 3 frontmatter-boundary sites/);
    editFiles1('code-review-fix: no site is too few', [['gsd-core/workflows/code-review-fix.md', (text) => { const parts = text.split('/^---\\n([\\s\\S]*?)\\n---/)'); return parts.map((part, i) => (i === 0 ? part : (i <= 0 ? '/^---\\n([\\s\\S]*?)\\n---/)' : '/^x/)') + part)).join(''); }]], 'code-review-summary-parser', /expected at least 3 frontmatter-boundary sites/);
    quiet1('code-review-fix: four sites (limit + 1) are enough', [['gsd-core/workflows/code-review-fix.md', (text) => { const parts = text.split('/^---\\n([\\s\\S]*?)\\n---/)'); return parts.map((part, i) => (i === 0 ? part : (i <= 4 ? '/^---\\n([\\s\\S]*?)\\n---/)' : '/^x/)') + part)).join(''); }]], 'code-review-summary-parser', /expected at least 3 frontmatter-boundary sites/);
    quiet1('code-review: a fourth, normalized site added is enough', [['gsd-core/workflows/code-review.md', append('const m = content.replace(/\\r\\n/g, \'\\n\').match(/^---\\n([\\s\\S]*?)\\n---/);')]], 'code-review-summary-parser', /expected at least 3 frontmatter-boundary sites/);
    quiet1('sites: blanks between the normalize tokens are any whitespace', [['gsd-core/workflows/code-review.md', append('const m = content.replace( /\\r\\n/g , \'\\n\' ).match(/^---\\n([\\s\\S]*?)\\n---/);')]], 'code-review-summary-parser', /every frontmatter-boundary site must normalize CRLF before matching/);
    quiet1('sites: tabs and a no-break space between the normalize tokens are enough', [['gsd-core/workflows/code-review.md', append('const m = content.replace(\t/\\r\\n/g\u00a0,\t\'\\n\'\u00a0).match(/^---\\n([\\s\\S]*?)\\n---/);')]], 'code-review-summary-parser', /every frontmatter-boundary site must normalize CRLF before matching/);
    quiet1('sites: no blank at all between the normalize tokens is enough', [['gsd-core/workflows/code-review.md', append('const m = content.replace(/\\r\\n/g,\'\\n\').match(/^---\\n([\\s\\S]*?)\\n---/);')]], 'code-review-summary-parser', /every frontmatter-boundary site must normalize CRLF before matching/);
    quiet1('sites: a content.match preceded by a dot on a normalized line is not raw', [['gsd-core/workflows/code-review.md', append('const m = content.replace(/\\r\\n/g, \'\\n\').match(/^---\\n([\\s\\S]*?)\\n---/); const n = x.content.match(/^---\\n([\\s\\S]*?)\\n---/);')]], 'code-review-summary-parser', /every frontmatter-boundary site must normalize CRLF before matching/);
    quiet1('sites: a content.match preceded by a word character on a normalized line is not raw', [['gsd-core/workflows/code-review.md', append('const m = content.replace(/\\r\\n/g, \'\\n\').match(/^---\\n([\\s\\S]*?)\\n---/); const n = _content.match(/^---\\n([\\s\\S]*?)\\n---/);')]], 'code-review-summary-parser', /every frontmatter-boundary site must normalize CRLF before matching/);
    editFiles1('sites: a raw content.match on a normalized line is a finding', [['gsd-core/workflows/code-review.md', append('const m = content.replace(/\\r\\n/g, \'\\n\').match(/^---\\n([\\s\\S]*?)\\n---/); const n = content.match(/^---\\n([\\s\\S]*?)\\n---/);')]], 'code-review-summary-parser', /every frontmatter-boundary site must normalize CRLF before matching/);
    editFiles1('sites: a raw content.match after an opening parenthesis is a finding', [['gsd-core/workflows/code-review.md', append('const m = content.replace(/\\r\\n/g, \'\\n\').match(/^---\\n([\\s\\S]*?)\\n---/); const n = (content.match(/^---\\n([\\s\\S]*?)\\n---/));')]], 'code-review-summary-parser', /every frontmatter-boundary site must normalize CRLF before matching/);
    editFiles1('sites: a raw content.match with a tab before the regex is a finding', [['gsd-core/workflows/code-review.md', append('const m = content.replace(/\\r\\n/g, \'\\n\').match(/^---\\n([\\s\\S]*?)\\n---/); const n = content.match(\t/^---\\n([\\s\\S]*?)\\n---/);')]], 'code-review-summary-parser', /every frontmatter-boundary site must normalize CRLF before matching/);
    editFiles1('sites: the line feed written in double quotes is not the normalize', [['gsd-core/workflows/code-review.md', append('const m = content.replace(/\\r\\n/g, "\\n").match(/^---\\n([\\s\\S]*?)\\n---/);')]], 'code-review-summary-parser', /every frontmatter-boundary site must normalize CRLF before matching/);
    editFiles1('sites: an extra flag on the normalize regex is not the normalize', [['gsd-core/workflows/code-review.md', append('const m = content.replace(/\\r\\n/gi, \'\\n\').match(/^---\\n([\\s\\S]*?)\\n---/);')]], 'code-review-summary-parser', /every frontmatter-boundary site must normalize CRLF before matching/);
    editFiles1('sites: the normalize and the match on separate lines is a finding on the match line', [['gsd-core/workflows/code-review.md', append('const m = content.replace(/\\r\\n/g, \'\\n\')\n  .match(/^---\\n([\\s\\S]*?)\\n---/);')]], 'code-review-summary-parser', /every frontmatter-boundary site must normalize CRLF before matching/);
    editFiles1('sites: the normalize after the match is a finding', [['gsd-core/workflows/code-review.md', append('const m = content.match(/^---\\n([\\s\\S]*?)\\n---/) || content.replace(/\\r\\n/g, \'\\n\');')]], 'code-review-summary-parser', /every frontmatter-boundary site must normalize CRLF before matching/);
    {
      const fc = require('./helpers/fast-check-setup.cjs');
      const parser = require('../scripts/static-checks/text-contracts/code-review-summary-parser.cjs').walkers;
      const strings = (tokens, maxLength = 10) => fc.array(fc.constantFrom(...tokens), { maxLength }).map((parts) => parts.join(''));
      const agrees = (name, arbitrary, pair, isAccepted = (expected) => Boolean(expected)) => {
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
      // The parts in order (the last ones cut short at random), each followed by 0..3 filler characters.
      const chainOf = (parts, fillers, minKeep = 0) => fc.tuple(fc.integer({ min: minKeep, max: parts.length }), ...parts.map(() => fc.array(fc.constantFrom(...fillers), { maxLength: 3 }))).map(([keep, ...pads]) => parts.slice(0, keep).map((part, i) => part + pads[i].join('')).join(''));
      const BLANKS = [' ', '\t', '\u00a0', '\n', 'x'];
      const BOUNDARY = String.raw`/^---\n([\s\S]*?)\n---/)`;
      const CRLF = String.raw`/\r\n/g`;
      const LF = String.raw`'\n'`;
      const RAW = String.raw`/^---\n`;
      const oldBoundary = (line) => /\/\^---\\n\(\[\\s\\S\]\*\?\)\\n---\/\)/.test(line);
      const oldNormalized = (line) => /content\.replace\(\s*\/\\r\\n\/g\s*,\s*'\\n'\s*\)\.match\(/.test(line);
      const oldRaw = (line) => /(^|[^.])\bcontent\.match\(\s*\/\^---\\n/.test(line);
      const lineInputs = fc.oneof(
        strings(['content.replace(', CRLF, ',', LF, ').match(', 'content.match(', RAW, BOUNDARY, ' ', '\t', '\u00a0', 'x', '.', '_', '('], 10),
        chainOf(['content.replace(', CRLF, ',', LF, ').match('], BLANKS),
        chainOf(['content.replace(', CRLF, ',', LF, ').match('], [' ', '\t', '\u00a0', '\n'], 5),
        chainOf(['x', 'content.match(', RAW], [' ', '\t', '\u00a0', '\n', 'x', '.', '_', '(']),
        chainOf(['content.replace(', CRLF, ',', LF, ').match(', BOUNDARY, ' ', 'content.match(', RAW], [' ', '\t', '.', '_', 'x', '(']),
      );
      test('property: the boundary site agrees with /\\/\\^---\\\\n\\(\\[\\\\s\\\\S\\]\\*\\?\\)\\\\n---\\/\\)/', () => {
        const inputs = fc.oneof(strings([BOUNDARY, RAW, '([\\s\\S]*?)', '\\n---/)', 'x', ' '], 6), chainOf([RAW, String.raw`([\s\S]*?)`, String.raw`\n---/)`], ['x', ' ']));
        agrees('boundary', inputs, (s) => [parser.isBoundarySite(s), oldBoundary(s)]);
      });
      test('property: the normalize walk agrees with /content\\.replace\\(\\s*\\/\\\\r\\\\n\\/g\\s*,\\s*\'\\\\n\'\\s*\\)\\.match\\(/', () => {
        agrees('normalize', lineInputs, (s) => [parser.isNormalizedMatch(s), oldNormalized(s)]);
      });
      test('property: the raw match walk agrees with /(^|[^.])\\bcontent\\.match\\(\\s*\\/\\^---\\\\n/', () => {
        agrees('raw match', lineInputs, (s) => [parser.isRawContentMatch(s), oldRaw(s)]);
      });
      test('property: the site scan agrees with the loop over the lines it replaced', () => {
        const oldScan = (src) => {
          const sites = [];
          const unsafe = [];
          src.split(/\r?\n/).forEach((line, i) => {
            if (!oldBoundary(line)) return;
            sites.push(i + 1);
            if (!oldNormalized(line) || oldRaw(line)) unsafe.push(i + 1);
          });
          return { sites, unsafe };
        };
        const site = fc.constantFrom(
          `const m = content.replace(/\\r\\n/g, '\\n').match(${BOUNDARY.slice(0, -1)});`,
          `const m = content.match(${BOUNDARY.slice(0, -1)});`,
          `const m = x.content.match(${BOUNDARY.slice(0, -1)}); const n = content.replace(/\\r\\n/g, '\\n').match(${BOUNDARY.slice(0, -1)});`,
          'const other = 1;',
          '',
        );
        const lineBreaks = fc.constantFrom('\n', '\r\n', '\r', '\u2028', '\u2029');
        const sources = fc.array(fc.tuple(site, lineBreaks), { maxLength: 6 }).map((parts) => parts.map(([line, br]) => line + br).join(''));
        let both = 0;
        let clean = 0;
        fc.assert(fc.property(sources, (src) => {
          const got = parser.scanSites(src.split('\r\n').join('\n'));
          const want = oldScan(src);
          assert.deepEqual(got, want, JSON.stringify(src));
          if (want.unsafe.length > 0) both += 1;
          else if (want.sites.length > 0) clean += 1;
        }));
        assert.ok(both > 0 && clean > 0, `the property saw ${both} sources with an unsafe site and ${clean} with only safe ones`);
      });
    }
    // ---- audit-fix-command
    goneOne1('commands/gsd/audit-fix.md', 'audit-fix-command', 'removed');
    goneOne1('commands/gsd/audit-fix.md', 'audit-fix-command', 'emptied');
    goneOne1('gsd-core/workflows/audit-fix.md', 'audit-fix-command', 'removed');
    goneOne1('gsd-core/workflows/audit-fix.md', 'audit-fix-command', 'emptied');
    exactly1('the command renamed is one finding', [['commands/gsd/audit-fix.md', swap('name: gsd:audit-fix', 'name: gsd:fix')]], 'audit-fix-command', 1, /the command name must be gsd:audit-fix/);
    exactly1('the hint that lost audit-uat is one finding', [['commands/gsd/audit-fix.md', swap('--source <audit-uat>', '--source <audit|verify>')]], 'audit-fix-command', 1, /the argument-hint must show --source <audit-uat>/);
    exactly1('the verify source advertised next to audit-uat is one finding', [['commands/gsd/audit-fix.md', swap('--source <audit-uat>', '--source <audit-uat> --source <audit|verify>')]], 'audit-fix-command', 1, /the argument-hint must not advertise the unsupported verify source/);
    exactly1('the dry-run flag gone is one finding', [['gsd-core/workflows/audit-fix.md', eraseAll('dry-run')]], 'audit-fix-command', 1, /the workflow must document the --dry-run flag/);
    exactly1('fix-failed gone is one finding', [['gsd-core/workflows/audit-fix.md', eraseAll('fix-failed')]], 'audit-fix-command', 1, /the workflow must mark failed fixes as fix-failed/);
    exactly1('no fix-loop marker is one finding', [['gsd-core/workflows/audit-fix.md', swap('fix-loop', 'fixloop')]], 'audit-fix-command', 1, /the workflow must have a fix-loop step/);
    exactly1('dry-run gone and fix-loop renamed are two findings, one per cause', [['gsd-core/workflows/audit-fix.md', compose1(eraseAll('dry-run'), swap('fix-loop', 'fixloop'))]], 'audit-fix-command', 2, /the workflow must (document the --dry-run flag|have a fix-loop step)/);
    exactly1('the workflow reference gone is one finding', [['commands/gsd/audit-fix.md', eraseAll('audit-fix.md')]], 'audit-fix-command', 1, /the command must reference the audit-fix\.md workflow/);
    exactly1('npm test gone is one finding', [['gsd-core/workflows/audit-fix.md', eraseAll('npm test')]], 'audit-fix-command', 1, /the workflow must run npm test as part of the fix loop/);
    exactly1('git commit before npm test is one finding', [['gsd-core/workflows/audit-fix.md', swap('<step name="fix-loop">', '<step name="fix-loop">\ngit commit\n')]], 'audit-fix-command', 1, /npm test must appear before the commit/);
    editFiles1('frontmatter: an Agent entry in the body is not an allowed tool', [['commands/gsd/audit-fix.md', compose1(swap('  - Agent\n', ''), append('- Agent'))]], 'audit-fix-command', /allowed-tools must include Agent/);
    editFiles1('frontmatter: the audit-uat hint in the body is not the argument-hint', [['commands/gsd/audit-fix.md', compose1(swap('--source <audit-uat>', '--source <x>'), append('--source <audit-uat>'))]], 'audit-fix-command', /the argument-hint must show --source <audit-uat>/);
    quiet1('frontmatter: the verify source in the body is not the argument-hint', [['commands/gsd/audit-fix.md', append('--source <audit|verify>')]], 'audit-fix-command', /the argument-hint must not advertise the unsupported verify source/);
    editFiles1('frontmatter: type: prompt in the body is not the command type', [['commands/gsd/audit-fix.md', compose1(swap('type: prompt', 'type: skill'), append('type: prompt'))]], 'audit-fix-command', /the command must have type: prompt/);
    editFiles1('--max and 5 on separate lines is a finding', [['gsd-core/workflows/audit-fix.md', swap('- `--max N` — maximum findings to fix (default: **5**)', '- `--max N` — maximum findings to fix\n(default: **5**)')]], 'audit-fix-command', /the workflow must document the --max flag with its default of 5 on one line/);
    editFiles1('--severity and medium on separate lines is a finding', [['gsd-core/workflows/audit-fix.md', (text) => text.split('high|medium|all').join('high|all').split('- `--severity high|all` — minimum severity to process (default: **medium**)').join('- `--severity high|all` — minimum severity to process\n(default: **medium**)')]], 'audit-fix-command', /the workflow must document the --severity flag with its default of medium on one line/);
    editFiles1('--source and audit-uat on separate lines is a finding', [['gsd-core/workflows/audit-fix.md', swap('- `--source <audit>` — which audit to run (default: **audit-uat**)', '- `--source <audit>` — which audit to run\n(default: **audit-uat**)')]], 'audit-fix-command', /the workflow must document the --source flag with audit-uat as the default source on one line/);
    editFiles1('the dry-run stop on the next line is a finding', [['gsd-core/workflows/audit-fix.md', swap('If `--dry-run` was specified, **stop here and exit**.', 'If `--dry-run` was specified,\n**stop here and exit**.')]], 'audit-fix-command', /the workflow must indicate on one line that --dry-run stops after classification/);
    quiet1('the dry-run stop: stop alone is enough', [['gsd-core/workflows/audit-fix.md', swap('**stop here and exit**', '**stop here**')]], 'audit-fix-command', /the workflow must indicate on one line that --dry-run stops/);
    quiet1('the dry-run stop: exit alone is enough', [['gsd-core/workflows/audit-fix.md', swap('**stop here and exit**', '**exit**')]], 'audit-fix-command', /the workflow must indicate on one line that --dry-run stops/);
    editFiles1('{ID} and commit on separate lines is a finding', [['gsd-core/workflows/audit-fix.md', swap('git commit -m "fix({scope}): resolve {ID} — {description}"', 'git commit -m "fix({scope}): resolve\n{ID} — {description}"')]], 'audit-fix-command', /the commit message template must include the \{ID\} placeholder/);
    editFiles1('stop and fix-failed on separate lines is a finding', [['gsd-core/workflows/audit-fix.md', swap('mark finding as `fix-failed`, and **stop the pipeline**:', 'mark finding as `fix-failed`,\nand **stop the pipeline**:')]], 'audit-fix-command', /the workflow must stop the pipeline after the first test failure/);
    editFiles1('a stop elsewhere does not stand in for the fix-failed line', [['gsd-core/workflows/audit-fix.md', swap('**stop the pipeline**', '**halt the pipeline**')]], 'audit-fix-command', /the workflow must stop the pipeline after the first test failure/);
    quiet1('missing test: missing test alone is enough', [['gsd-core/workflows/audit-fix.md', compose1((text) => text.split('missing test').join('').split('Missing test').join(''), append('missing test'))]], 'audit-fix-command', /the workflow must list a missing test as an auto-fixable signal/);
    quiet1('missing test: Missing test alone is enough', [['gsd-core/workflows/audit-fix.md', compose1((text) => text.split('missing test').join('').split('Missing test').join(''), append('Missing test'))]], 'audit-fix-command', /the workflow must list a missing test as an auto-fixable signal/);
    quiet1('architecture: architecture alone is enough', [['gsd-core/workflows/audit-fix.md', compose1((text) => text.split('architecture').join('').split('architectural').join(''), append('architecture'))]], 'audit-fix-command', /the workflow must list architecture changes as a manual-only signal/);
    quiet1('architecture: architectural alone is enough', [['gsd-core/workflows/audit-fix.md', compose1((text) => text.split('architecture').join('').split('architectural').join(''), append('architectural'))]], 'audit-fix-command', /the workflow must list architecture changes as a manual-only signal/);
    quiet1('traceability: traceability alone is enough', [['gsd-core/workflows/audit-fix.md', compose1((text) => text.split('traceability').join('').split('finding ID').join('ID'), append('traceability'))]], 'audit-fix-command', /the workflow must mention the finding ID for traceability/);
    quiet1('traceability: finding ID alone is enough', [['gsd-core/workflows/audit-fix.md', compose1((text) => text.split('traceability').join('').split('finding ID').join('ID'), append('finding ID'))]], 'audit-fix-command', /the workflow must mention the finding ID for traceability/);
    quiet1('revert: git checkout alone is enough', [['gsd-core/workflows/audit-fix.md', compose1((text) => text.split('git checkout').join('').split('revert').join(''), append('git checkout'))]], 'audit-fix-command', /the workflow must revert the changes on a test failure/);
    quiet1('revert: revert alone is enough', [['gsd-core/workflows/audit-fix.md', compose1((text) => text.split('git checkout').join('').split('revert').join(''), append('revert'))]], 'audit-fix-command', /the workflow must revert the changes on a test failure/);
    quiet1('uncertain: the upper-case spelling is enough (ASCII lower-casing)', [['gsd-core/workflows/audit-fix.md', compose1(eraseAll('uncertain'), append('UNCERTAIN'))]], 'audit-fix-command', /the workflow must say to err on manual-only when uncertain/);
    quiet1('test-then-commit: with no fix-loop marker the order is read from the start of the file', [['gsd-core/workflows/audit-fix.md', swap('fix-loop', 'fixloop')]], 'audit-fix-command', /npm test must appear before the commit in the fix loop/);
    editFiles1('test-then-commit: no git commit in the fix loop is a finding', [['gsd-core/workflows/audit-fix.md', compose1(eraseAll('git commit'), append('no commit here'))]], 'audit-fix-command', /npm test must appear before the commit in the fix loop/);
    exactly1('test-then-commit: npm test only before the fix loop is one finding', [['gsd-core/workflows/audit-fix.md', (text) => 'npm test\n' + text.split('npm test').join('')]], 'audit-fix-command', 1, /npm test must appear before the commit in the fix loop/);
    {
      const fc = require('./helpers/fast-check-setup.cjs');
      const audit = require('../scripts/static-checks/text-contracts/audit-fix-command.cjs').walkers;
      const strings = (tokens, maxLength = 10) => fc.array(fc.constantFrom(...tokens), { maxLength }).map((parts) => parts.join(''));
      const agrees = (name, arbitrary, pair) => {
        let accepted = 0;
        let rejected = 0;
        fc.assert(fc.property(arbitrary, (s) => {
          const [actual, expected] = pair(s);
          assert.equal(actual, expected, JSON.stringify(s));
          if (expected) accepted += 1;
          else rejected += 1;
        }));
        assert.ok(accepted > 0 && rejected > 0, `${name}: the property saw ${accepted} accepted and ${rejected} rejected strings`);
      };
      // The parts in order (the last ones cut short at random), each followed by 0..3 filler characters.
      const chainOf = (parts, fillers) => fc.tuple(fc.nat(parts.length), ...parts.map(() => fc.array(fc.constantFrom(...fillers), { maxLength: 3 }))).map(([keep, ...pads]) => parts.slice(0, keep).map((part, i) => part + pads[i].join('')).join(''));
      const FILL = ['\n', ' ', 'x', '\r', '\u2028'];
      // Some line holds both words (in either order): the same reading, written as one pattern per line.
      test('property: a line holding every word agrees with the per-line pattern', () => {
        const pairs = [
          [['--max', '5'], (line) => /--max[^]*5|5[^]*--max/.test(line)],
          [['--severity', 'medium'], (line) => /--severity[^]*medium|medium[^]*--severity/.test(line)],
          [['--source', 'audit-uat'], (line) => /--source[^]*audit-uat|audit-uat[^]*--source/.test(line)],
          [['{ID}', 'commit'], (line) => /\{ID\}[^]*commit|commit[^]*\{ID\}/.test(line)],
          [['commit', 'finding'], (line) => /commit[^]*finding|finding[^]*commit/.test(line)],
          [['stop', 'fix-failed'], (line) => /stop[^]*fix-failed|fix-failed[^]*stop/.test(line)],
        ];
        for (const [words, linePattern] of pairs) {
          const oracle = (text) => text.split('\n').some((line) => linePattern(line));
          const inputs = fc.oneof(strings([...words, '\n', ' ', 'x', '\r'], 8), chainOf(words, FILL), chainOf([words[1], words[0]], FILL));
          agrees(words.join(' + '), inputs, (s) => [audit.lineHasAll(s, words), oracle(s)]);
        }
      });
      test('property: a line holding the first word and one of the others agrees with the per-line pattern', () => {
        const oracle = (text) => text.split('\n').some((line) => /dry-run[^]*(stop|exit)|(stop|exit)[^]*dry-run/.test(line));
        const inputs = fc.oneof(strings(['dry-run', 'stop', 'exit', '\n', ' ', 'x'], 8), chainOf(['dry-run', 'stop'], FILL), chainOf(['exit', 'dry-run'], FILL), chainOf(['dry-run', 'exit'], FILL));
        agrees('dry-run', inputs, (s) => [audit.lineHasAny(s, 'dry-run', ['stop', 'exit']), oracle(s)]);
      });
      test('property: the test-then-commit order agrees with the index comparison it replaced', () => {
        const oracle = (text) => {
          const start = text.indexOf('fix-loop');
          const testAt = text.indexOf('npm test', start);
          const commitAt = text.indexOf('git commit', start);
          // No npm test at all is the finding of the assertion that asks for it, not of the order check.
          if (!text.includes('npm test')) return true;
          return testAt > -1 && commitAt > -1 && testAt < commitAt;
        };
        const parts = ['fix-loop', 'npm test', 'git commit'];
        const orders = [parts, ['npm test', 'fix-loop', 'git commit'], ['git commit', 'fix-loop', 'npm test'], ['fix-loop', 'git commit', 'npm test'], ['git commit', 'npm test', 'fix-loop'], ['npm test', 'git commit', 'fix-loop']];
        const inputs = fc.oneof(strings([...parts, 'x', '\n', ' '], 8), fc.oneof(...orders.map((order) => chainOf(order, ['x', '\n']))));
        agrees('test then commit', inputs, (s) => [audit.testBeforeCommit(s) === true, oracle(s)]);
      });
    }
    // ---- progress-forensic
    goneOne1('commands/gsd/progress.md', 'progress-forensic', 'removed');
    goneOne1('commands/gsd/progress.md', 'progress-forensic', 'emptied');
    goneOne1('gsd-core/workflows/progress/steps/forensic-audit.md', 'progress-forensic', 'removed');
    goneOne1('gsd-core/workflows/progress/steps/forensic-audit.md', 'progress-forensic', 'emptied');
    goneOne1('gsd-core/workflows/progress.md', 'progress-forensic', 'removed');
    goneOne1('gsd-core/workflows/progress.md', 'progress-forensic', 'emptied');
    goneOne1('docs/COMMANDS.md', 'progress-forensic', 'removed');
    goneOne1('docs/COMMANDS.md', 'progress-forensic', 'emptied');
    exactly1('the arguments line decorated is one finding', [['commands/gsd/progress.md', swap('<arguments>$ARGUMENTS</arguments>', '<arguments>$ARGUMENTS</arguments> ')]], 'progress-forensic', 1, /the raw arguments must sit on a line of their own/);
    exactly1('the forensic_audit step renamed is one finding', [['gsd-core/workflows/progress/steps/forensic-audit.md', swap('<step name="forensic_audit">', '<step name="audit">')]], 'progress-forensic', 1, /must have a forensic_audit step/);
    exactly1('the report step gone is one finding', [['gsd-core/workflows/progress.md', swap('<step name="report">', '<step name="reports">')]], 'progress-forensic', 1, /marker "<step name=\\"report\\">" not found/);
    exactly1('the Route V.gaps heading gone is one finding', [['gsd-core/workflows/progress.md', eraseAll('**Route V.gaps:')]], 'progress-forensic', 1, /the workflow must define a Route V\.gaps section/);
    exactly1('the Route V.human heading gone is one finding', [['gsd-core/workflows/progress.md', eraseAll('**Route V.human:')]], 'progress-forensic', 1, /the workflow must define a Route V\.human section/);
    exactly1('the Route V heading gone is one finding', [['gsd-core/workflows/progress.md', eraseAll('**Route V:')]], 'progress-forensic', 1, /the workflow must define the single non-passed Route V/);
    exactly1('the Step 3 heading gone is one finding (the Route V.human section has no end)', [['gsd-core/workflows/progress.md', swap('**Step 3: Check milestone status', '**Step Three: Check milestone status')]], 'progress-forensic', 1, /the closing marker "\*\*Step 3" is not found after "\*\*Route V\.human:"/);
    exactly1('the non-passed row gone is one finding', [['gsd-core/workflows/progress.md', eraseAll('verification_status ≠ passed')]], 'progress-forensic', 1, /the routing table must have one non-passed verification row/);
    exactly1('the report directive stripped of every marker is one finding', [['gsd-core/workflows/progress.md', within('<step name="report">', '**Generate progress bar', swap('> ', ''))]], 'progress-forensic', 1, /the report step must contain at least one blockquote/);
    exactly1('PROJECT.md gone from the directive is one finding', [['gsd-core/workflows/progress.md', within('<step name="report">', '**Generate progress bar', eraseAll('PROJECT.md'))]], 'progress-forensic', 1, /must name PROJECT\.md as authoritative/);
    editFiles1('the first block that names the context authority is the one that is read', [['gsd-core/workflows/progress.md', within('<step name="report">', '**Generate progress bar', compose1(eraseAll('STATE.md'), append('> Context authority: STATE.md')))]], 'progress-forensic', /the context-authority directive must name STATE\.md as authoritative/);
    quiet1('a prohibition: must not alone is enough', [['gsd-core/workflows/progress.md', within('<step name="report">', '**Generate progress bar', swap('do NOT use', 'must not use'))]], 'progress-forensic', /must contain an explicit prohibition/);
    quiet1('a prohibition: never alone is enough', [['gsd-core/workflows/progress.md', within('<step name="report">', '**Generate progress bar', swap('do NOT use', 'never use'))]], 'progress-forensic', /must contain an explicit prohibition/);
    quiet1('a prohibition: do not alone is enough', [['gsd-core/workflows/progress.md', within('<step name="report">', '**Generate progress bar', swap('do NOT use', 'do not use'))]], 'progress-forensic', /must contain an explicit prohibition/);
    quiet1('a prohibition: MUST NOT alone is enough', [['gsd-core/workflows/progress.md', within('<step name="report">', '**Generate progress bar', swap('do NOT use', 'MUST NOT use'))]], 'progress-forensic', /must contain an explicit prohibition/);
    quiet1('a prohibition: a tab between do and not is enough', [['gsd-core/workflows/progress.md', within('<step name="report">', '**Generate progress bar', swap('do NOT use', 'do\tNOT use'))]], 'progress-forensic', /must contain an explicit prohibition/);
    quiet1('a prohibition: a no-break space between do and not is enough', [['gsd-core/workflows/progress.md', within('<step name="report">', '**Generate progress bar', swap('do NOT use', 'do\u00a0NOT use'))]], 'progress-forensic', /must contain an explicit prohibition/);
    editFiles1('a prohibition: donot written together is a finding', [['gsd-core/workflows/progress.md', within('<step name="report">', '**Generate progress bar', swap('do NOT use', 'donot use'))]], 'progress-forensic', /must contain an explicit prohibition/);
    quiet1('context authority: a tab between the two words is enough', [['gsd-core/workflows/progress.md', within('<step name="report">', '**Generate progress bar', swap('Context authority:', 'Context\tauthority:'))]], 'progress-forensic', /must contain a blockquote whose text includes "Context authority"/);
    quiet1('context authority: lower case is enough', [['gsd-core/workflows/progress.md', within('<step name="report">', '**Generate progress bar', swap('Context authority:', 'context authority:'))]], 'progress-forensic', /must contain a blockquote whose text includes "Context authority"/);
    editFiles1('context authority: the two words together are a finding', [['gsd-core/workflows/progress.md', within('<step name="report">', '**Generate progress bar', swap('Context authority:', 'Contextauthority:'))]], 'progress-forensic', /must contain a blockquote whose text includes "Context authority"/);
    quiet1('authoritative: upper case is enough', [['gsd-core/workflows/progress.md', within('<step name="report">', '**Generate progress bar', swap('authoritative', 'AUTHORITATIVE'))]], 'progress-forensic', /must describe these files as authoritative/);
    quiet1('the skip wording: Skip alone is enough', [['gsd-core/workflows/progress/steps/forensic-audit.md', compose1((text) => text.split('Skip').join('').split('skip').join('').split('exit').join(''), append('Skip'))]], 'progress-forensic', /the forensic_audit step must skip when --forensic is not present/);
    quiet1('the skip wording: skip alone is enough', [['gsd-core/workflows/progress/steps/forensic-audit.md', compose1((text) => text.split('Skip').join('').split('skip').join('').split('exit').join(''), append('skip'))]], 'progress-forensic', /the forensic_audit step must skip when --forensic is not present/);
    quiet1('the skip wording: exit alone is enough', [['gsd-core/workflows/progress/steps/forensic-audit.md', compose1((text) => text.split('Skip').join('').split('skip').join('').split('exit').join(''), append('exit'))]], 'progress-forensic', /the forensic_audit step must skip when --forensic is not present/);
    quiet1('check 1: artifact alone is enough', [['gsd-core/workflows/progress/steps/forensic-audit.md', compose1((text) => text.split('artifact').join('').split('consistent').join(''), append('artifact'))]], 'progress-forensic', /the forensic step must check STATE against the artifacts \(check 1\)/);
    quiet1('check 1: consistent alone is enough', [['gsd-core/workflows/progress/steps/forensic-audit.md', compose1((text) => text.split('artifact').join('').split('consistent').join(''), append('consistent'))]], 'progress-forensic', /the forensic step must check STATE against the artifacts \(check 1\)/);
    quiet1('check 2: HANDOFF alone is enough', [['gsd-core/workflows/progress/steps/forensic-audit.md', compose1((text) => text.split('HANDOFF').join('').split('handoff').join(''), append('HANDOFF'))]], 'progress-forensic', /the forensic step must check for orphaned handoff files \(check 2\)/);
    quiet1('check 2: handoff alone is enough', [['gsd-core/workflows/progress/steps/forensic-audit.md', compose1((text) => text.split('HANDOFF').join('').split('handoff').join(''), append('handoff'))]], 'progress-forensic', /the forensic step must check for orphaned handoff files \(check 2\)/);
    quiet1('check 4: MEMORY alone is enough', [['gsd-core/workflows/progress/steps/forensic-audit.md', compose1((text) => text.split('MEMORY').join('').split('memory').join('').split('pending').join(''), append('MEMORY'))]], 'progress-forensic', /the forensic step must check memory-flagged pending work \(check 4\)/);
    quiet1('check 4: memory alone is enough', [['gsd-core/workflows/progress/steps/forensic-audit.md', compose1((text) => text.split('MEMORY').join('').split('memory').join('').split('pending').join(''), append('memory'))]], 'progress-forensic', /the forensic step must check memory-flagged pending work \(check 4\)/);
    quiet1('check 4: pending alone is enough', [['gsd-core/workflows/progress/steps/forensic-audit.md', compose1((text) => text.split('MEMORY').join('').split('memory').join('').split('pending').join(''), append('pending'))]], 'progress-forensic', /the forensic step must check memory-flagged pending work \(check 4\)/);
    quiet1('check 5: todo alone is enough', [['gsd-core/workflows/progress/steps/forensic-audit.md', compose1((text) => text.split('todo').join('').split('Todo').join('').split('TODO').join(''), append('todo'))]], 'progress-forensic', /the forensic step must check blocking operational todos \(check 5\)/);
    quiet1('check 5: Todo alone is enough', [['gsd-core/workflows/progress/steps/forensic-audit.md', compose1((text) => text.split('todo').join('').split('Todo').join('').split('TODO').join(''), append('Todo'))]], 'progress-forensic', /the forensic step must check blocking operational todos \(check 5\)/);
    quiet1('check 5: TODO alone is enough', [['gsd-core/workflows/progress/steps/forensic-audit.md', compose1((text) => text.split('todo').join('').split('Todo').join('').split('TODO').join(''), append('TODO'))]], 'progress-forensic', /the forensic step must check blocking operational todos \(check 5\)/);
    quiet1('check 6: uncommitted alone is enough', [['gsd-core/workflows/progress/steps/forensic-audit.md', compose1((text) => text.split('uncommitted').join('').split('git status').join(''), append('uncommitted'))]], 'progress-forensic', /the forensic step must check for uncommitted code \(check 6\)/);
    quiet1('check 6: git status alone is enough', [['gsd-core/workflows/progress/steps/forensic-audit.md', compose1((text) => text.split('uncommitted').join('').split('git status').join(''), append('git status'))]], 'progress-forensic', /the forensic step must check for uncommitted code \(check 6\)/);
    quiet1('the integrity verdict: INTEGRITY ISSUE alone is enough', [['gsd-core/workflows/progress/steps/forensic-audit.md', compose1((text) => text.split('INTEGRITY ISSUE').join('').split('integrity issue').join(''), append('INTEGRITY ISSUE'))]], 'progress-forensic', /the forensic step must surface INTEGRITY ISSUE when checks fail/);
    quiet1('the integrity verdict: integrity issue alone is enough', [['gsd-core/workflows/progress/steps/forensic-audit.md', compose1((text) => text.split('INTEGRITY ISSUE').join('').split('integrity issue').join(''), append('integrity issue'))]], 'progress-forensic', /the forensic step must surface INTEGRITY ISSUE when checks fail/);
    quiet1('the default behaviour: unchanged alone is enough', [['gsd-core/workflows/progress/steps/forensic-audit.md', compose1((text) => text.split('unchanged').join('').split('standard report').join(''), append('unchanged'))]], 'progress-forensic', /the forensic step must clarify that the default behaviour is unchanged/);
    quiet1('the default behaviour: standard report alone is enough', [['gsd-core/workflows/progress/steps/forensic-audit.md', compose1((text) => text.split('unchanged').join('').split('standard report').join(''), append('standard report'))]], 'progress-forensic', /the forensic step must clarify that the default behaviour is unchanged/);
    editFiles1('routing: the non-passed row before the gaps_found row is a finding', [['gsd-core/workflows/progress.md', (text) => text.split('verification_status = gaps_found').join('verification_status = gf') + '\nverification_status = gaps_found\n']], 'progress-forensic', /the routing rows must be in first-match-wins order/);
    editFiles1('routing: the non-passed row after the generic row is a finding', [['gsd-core/workflows/progress.md', (text) => text.split('verification_status ≠ passed').join('verification_status ≠ ok') + '\nverification_status ≠ passed\n']], 'progress-forensic', /the routing rows must be in first-match-wins order/);
    editFiles1('Route V names its own command: /gsd-verify-work is a finding', [['gsd-core/workflows/progress.md', within('**Route V:', '**Route V.gaps:', append('/gsd-verify-work'))]], 'progress-forensic', /a non-passed verification must present the owner's next_command/);
    {
      const fc = require('./helpers/fast-check-setup.cjs');
      const progress = require('../scripts/static-checks/text-contracts/progress-forensic.cjs').walkers;
      const strings = (tokens, maxLength = 10) => fc.array(fc.constantFrom(...tokens), { maxLength }).map((parts) => parts.join(''));
      const agrees = (name, arbitrary, pair, isAccepted = (expected) => Boolean(expected)) => {
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
      // The parts in order (the last ones cut short at random), each followed by 0..3 filler characters.
      const chainOf = (parts, fillers) => fc.tuple(fc.nat(parts.length), ...parts.map(() => fc.array(fc.constantFrom(...fillers), { maxLength: 3 }))).map(([keep, ...pads]) => parts.slice(0, keep).map((part, i) => part + pads[i].join('')).join(''));
      const BLANKS = [' ', '\t', '\u00a0', '\n', 'x'];
      test('property: the spaced-words walk agrees with /first\\s+second/ over lower-cased text', () => {
        const pairs = [['context', 'authority', (low) => /context\s+authority/.test(low)], ['do', 'not', (low) => /do\s+not/.test(low)], ['must', 'not', (low) => /must\s+not/.test(low)]];
        for (const [first, second, oracle] of pairs) {
          const inputs = fc.oneof(strings([first, second, ' ', '\t', '\u00a0', '\n', '\u2028', 'x'], 8), chainOf([first, second], BLANKS), chainOf(['x', first, first, second], BLANKS));
          agrees(`${first} ${second}`, inputs, (s) => [progress.wordsSpaced(s, first, second), oracle(s)]);
        }
      });
      test('property: naming the context authority agrees with /context\\s+authority/i', () => {
        const inputs = fc.oneof(strings(['context', 'Context', 'CONTEXT', 'authority', 'AUTHORITY', ' ', '\t', '\u00a0', '\n', 'x'], 8), chainOf(['Context', 'authority'], BLANKS), chainOf(['CONTEXT', 'Authority'], BLANKS));
        agrees('context authority', inputs, (s) => [progress.namesContextAuthority(s), /context\s+authority/i.test(s)]);
      });
      test('property: the prohibition walk agrees with /(do\\s+NOT|do\\s+not|must\\s+NOT|must\\s+not|never)/i', () => {
        const oracle = (s) => /(do\s+NOT|do\s+not|must\s+NOT|must\s+not|never)/i.test(s);
        const inputs = fc.oneof(strings(['do', 'DO', 'must', 'Must', 'not', 'NOT', 'never', 'NEVER', ' ', '\t', '\u00a0', '\n', 'x'], 8), chainOf(['do', 'NOT'], BLANKS), chainOf(['MUST', 'Not'], BLANKS), chainOf(['x', 'Never'], BLANKS));
        agrees('prohibition', inputs, (s) => [progress.hasProhibition(s), oracle(s)]);
      });
      test('property: the blockquote extraction agrees with the one the test defined', () => {
        const oldExtract = (md) => {
          const blocks = [];
          let current = null;
          for (const line of md.split(/\r?\n/)) {
            const m = line.match(/^\s*>\s?(.*)$/);
            if (m) {
              if (current === null) current = [];
              current.push(m[1]);
            } else if (current !== null) {
              blocks.push(current.join('\n'));
              current = null;
            }
          }
          if (current !== null) blocks.push(current.join('\n'));
          return blocks;
        };
        const lines = fc.oneof(
          fc.constantFrom('> a', '>b', '  > c', 'text', '', '>', '> ', '>  two', '\t>tab', '\u2028> after', '>\u2028x', '>\u2028\u2028x', '>x\u2028', '>a\rb', '>>', ' \u00a0> nbsp'),
          strings(['>', ' ', '\t', 'a', '\u00a0', '\u2028', '\u2029', '\r'], 6),
        );
        const sources = fc.array(fc.tuple(lines, fc.constantFrom('\n', '\r\n')), { maxLength: 6 }).map((parts) => parts.map(([line, br]) => line + br).join(''));
        agrees('blockquotes', sources, (s) => [progress.extractBlockquotes(s.split('\r\n').join('\n')), oldExtract(s)], (expected) => expected.length > 0);
      });
      test('property: the routing order agrees with the index comparison it replaced', () => {
        const markers = ['verification_status = gaps_found', 'verification_status = human_needed', 'verification_status ≠ passed', 'Phase complete (verification passed)'];
        const oracle = (text) => {
          const [gaps, human, notPassed, complete] = markers.map((marker) => text.indexOf(marker));
          if (gaps === -1 || human === -1 || notPassed === -1 || complete === -1) return true;
          return gaps < notPassed && human < notPassed && notPassed < complete;
        };
        const shuffles = [markers, [markers[3], markers[2], markers[1], markers[0]], [markers[1], markers[0], markers[2], markers[3]], [markers[0], markers[2], markers[1], markers[3]], [markers[0], markers[1], markers[3], markers[2]]];
        const inputs = fc.oneof(strings([...markers, 'x', '\n'], 6), fc.oneof(...shuffles.map((order) => chainOf(order, ['x', '\n']))), chainOf([markers[0], markers[1], markers[2], markers[3], markers[0]], ['x', '\n']));
        agrees('routing order', inputs, (s) => [progress.routeOrder(s) === true, oracle(s)]);
      });
      test('property: the route sections agree with the slices they replaced, where the closing marker exists', () => {
        const cases = [
          ['**Route V.gaps:', '**Route V.human:', false, true],
          ['**Route V:', '**Route V.gaps:', false, true],
          ['**Route V.human:', '**Step 3', true, false],
        ];
        const markers = ['**Route V:', '**Route V.gaps:', '**Route V.human:', '**Step 3'];
        const shuffles = [markers, [markers[3], markers[2], markers[1], markers[0]], [markers[1], markers[2], markers[3], markers[0]], [markers[0], markers[2], markers[1], markers[3]], [markers[2], markers[0], markers[1], markers[3]]];
        for (const [open, close, fromOpen, closeAsserted] of cases) {
          const oracle = (text) => {
            const start = text.indexOf(open);
            if (start === -1) return { kind: 'skip' };
            const end = text.indexOf(close, fromOpen ? start : 0);
            if (end === -1) return closeAsserted ? { kind: 'skip' } : { kind: 'error' };
            return { kind: 'text', text: text.slice(start, end) };
          };
          const inputs = fc.oneof(strings([...markers, 'x', '\n'], 6), fc.oneof(...shuffles.map((order) => chainOf(order, ['x', '\n']))), chainOf([markers[3], markers[1], markers[0], markers[1], markers[3]], ['x']));
          let text = 0;
          let other = 0;
          fc.assert(fc.property(inputs, (s) => {
            // A closing marker before the opening one and again after it reads the section to the later one; the slice read ''.
            fc.pre(!(close !== '**Step 3' && s.indexOf(open) !== -1 && s.indexOf(close) < s.indexOf(open) && s.indexOf(close, s.indexOf(open) + open.length) !== -1));
            const got = progress.routeSection(s, open, close, closeAsserted);
            const want = oracle(s);
            const kind = got.skip ? 'skip' : got.error ? 'error' : 'text';
            assert.equal(kind, want.kind, JSON.stringify(s));
            if (kind === 'text') {
              assert.equal(got.text, want.text, JSON.stringify(s));
              text += 1;
            } else other += 1;
          }));
          assert.ok(text > 0 && other > 0, `${open}: the property saw ${text} sections and ${other} skipped or failed ones`);
        }
      });
    }
    // ---- edit-phase
    quiet1('current values: current value alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['current']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('current value'))]], 'edit-phase', /the workflow must present current field values before editing/);
    quiet1('current values: present current alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['current']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('present current'))]], 'edit-phase', /the workflow must present current field values before editing/);
    quiet1('current values: display current alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['current']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('display current'))]], 'edit-phase', /the workflow must present current field values before editing/);
    quiet1('current values: current_value alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['current']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('current_value'))]], 'edit-phase', /the workflow must present current field values before editing/);
    quiet1('current values: current\u00a0value alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['current']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('current\u00a0value'))]], 'edit-phase', /the workflow must present current field values before editing/);
    quiet1('individual fields: specific field alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['field']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('specific field'))]], 'edit-phase', /the workflow must support editing individual fields/);
    quiet1('individual fields: individual field alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['field']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('individual field'))]], 'edit-phase', /the workflow must support editing individual fields/);
    quiet1('individual fields: edit field alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['field']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('edit field'))]], 'edit-phase', /the workflow must support editing individual fields/);
    quiet1('regeneration: regenerate alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['regenerate','clarified','rewrite']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('regenerate'))]], 'edit-phase', /the workflow must support full regeneration from a clarified intent/);
    quiet1('regeneration: rewrite all alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['regenerate','clarified','rewrite']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('rewrite all'))]], 'edit-phase', /the workflow must support full regeneration from a clarified intent/);
    quiet1('regeneration: all from clarified alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['regenerate','clarified','rewrite']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('all from clarified'))]], 'edit-phase', /the workflow must support full regeneration from a clarified intent/);
    quiet1('regeneration: clarified intent alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['regenerate','clarified','rewrite']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('clarified intent'))]], 'edit-phase', /the workflow must support full regeneration from a clarified intent/);
    quiet1('the clarified intent prompt: clarified intent alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['clarifie','revised']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('clarified intent'))]], 'edit-phase', /the workflow must prompt the user for a clarified intent during full regeneration/);
    quiet1('the clarified intent prompt: clarifie intent alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['clarifie','revised']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('clarifie intent'))]], 'edit-phase', /the workflow must prompt the user for a clarified intent during full regeneration/);
    quiet1('the clarified intent prompt: revised intent alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['clarifie','revised']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('revised intent'))]], 'edit-phase', /the workflow must prompt the user for a clarified intent during full regeneration/);
    quiet1('the clarified intent prompt: describe revised alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['clarifie','revised']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('describe revised'))]], 'edit-phase', /the workflow must prompt the user for a clarified intent during full regeneration/);
    quiet1('the clarified intent prompt: clarified\nintent alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['clarifie','revised']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('clarified\nintent'))]], 'edit-phase', /the workflow must prompt the user for a clarified intent during full regeneration/);
    quiet1('depends_on validation: validate depends alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['depends']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('validate depends'))]], 'edit-phase', /the workflow must validate depends_on references against the existing phases/);
    quiet1('depends_on validation: depends valid alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['depends']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('depends valid'))]], 'edit-phase', /the workflow must validate depends_on references against the existing phases/);
    quiet1('depends_on validation: invalid depends alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['depends']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('invalid depends'))]], 'edit-phase', /the workflow must validate depends_on references against the existing phases/);
    quiet1('the invalid reference block (the words): exit alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['exit','block','error']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('exit'))]], 'edit-phase', /the workflow must block the write when depends_on references an invalid phase/);
    quiet1('the invalid reference block (the words): block alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['exit','block','error']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('block'))]], 'edit-phase', /the workflow must block the write when depends_on references an invalid phase/);
    quiet1('the invalid reference block (the words): error alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['exit','block','error']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('error'))]], 'edit-phase', /the workflow must block the write when depends_on references an invalid phase/);
    quiet1('the self reference: circular alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['circular','self-reference','itself']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('circular'))]], 'edit-phase', /the workflow must prevent a self-referencing depends_on/);
    quiet1('the self reference: self-reference alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['circular','self-reference','itself']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('self-reference'))]], 'edit-phase', /the workflow must prevent a self-referencing depends_on/);
    quiet1('the self reference: itself alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['circular','self-reference','itself']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('itself'))]], 'edit-phase', /the workflow must prevent a self-referencing depends_on/);
    quiet1('the phase status check: disk_status alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['status']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('disk_status'))]], 'edit-phase', /the workflow must check the phase status before allowing an edit/);
    quiet1('the phase status check: phase status alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['status']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('phase status'))]], 'edit-phase', /the workflow must check the phase status before allowing an edit/);
    quiet1('the phase status check: status check alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['status']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('status check'))]], 'edit-phase', /the workflow must check the phase status before allowing an edit/);
    quiet1('the in-progress guard: in progress alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['progress']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('in progress'))]], 'edit-phase', /the workflow must refuse in_progress edits without --force/);
    quiet1('the in-progress guard: in_progress alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['progress']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('in_progress'))]], 'edit-phase', /the workflow must refuse in_progress edits without --force/);
    quiet1('the in-progress guard: in-progress alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['progress']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('in-progress'))]], 'edit-phase', /the workflow must refuse in_progress edits without --force/);
    quiet1('the in-progress guard: in\u00a0progress alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['progress']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('in\u00a0progress'))]], 'edit-phase', /the workflow must refuse in_progress edits without --force/);
    quiet1('the in-progress guard: in\tprogress alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['progress']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('in\tprogress'))]], 'edit-phase', /the workflow must refuse in_progress edits without --force/);
    quiet1('the phase not found error: not found alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['found','does not exist']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('not found'))]], 'edit-phase', /the workflow must error clearly when the phase number does not exist/);
    quiet1('the phase not found error: does not exist alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['found','does not exist']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('does not exist'))]], 'edit-phase', /the workflow must error clearly when the phase number does not exist/);
    quiet1('the missing argument error: no argument alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['required','argument']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('no argument'))]], 'edit-phase', /the workflow must error when the phase number argument is missing/);
    quiet1('the missing argument error: required alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['required','argument']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('required'))]], 'edit-phase', /the workflow must error when the phase number argument is missing/);
    quiet1('the diff: diff alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['diff','change']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('diff'))]], 'edit-phase', /the workflow must show a diff of the changes before writing/);
    quiet1('the diff: proposed change alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['diff','change']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('proposed change'))]], 'edit-phase', /the workflow must show a diff of the changes before writing/);
    quiet1('the diff: show change alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['diff','change']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('show change'))]], 'edit-phase', /the workflow must show a diff of the changes before writing/);
    quiet1('the confirmation: confirm alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['confirm','y/n','change','yes']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('confirm'))]], 'edit-phase', /the workflow must ask for confirmation before writing/);
    quiet1('the confirmation: apply change alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['confirm','y/n','change','yes']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('apply change'))]], 'edit-phase', /the workflow must ask for confirmation before writing/);
    quiet1('the confirmation: y/n alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['confirm','y/n','change','yes']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('y/n'))]], 'edit-phase', /the workflow must ask for confirmation before writing/);
    quiet1('the confirmation: yes no alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['confirm','y/n','change','yes']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('yes no'))]], 'edit-phase', /the workflow must ask for confirmation before writing/);
    quiet1('the decline: says n alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['without writing','says','user','exit']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('says n'))]], 'edit-phase', /the workflow must exit without writing if the user declines the confirmation/);
    quiet1('the decline: if user n alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['without writing','says','user','exit']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('if user n'))]], 'edit-phase', /the workflow must exit without writing if the user declines the confirmation/);
    quiet1('the decline: exit without  writing alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['without writing','says','user','exit']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('exit without  writing'))]], 'edit-phase', /the workflow must exit without writing if the user declines the confirmation/);
    quiet1('the decline: without writing alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['without writing','says','user','exit']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('without writing'))]], 'edit-phase', /the workflow must exit without writing if the user declines the confirmation/);
    quiet1('the preserved number: number preserved alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['preserve','number and position']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('number preserved'))]], 'edit-phase', /the workflow must preserve the phase number and position/);
    quiet1('the preserved number: preserve number alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['preserve','number and position']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('preserve number'))]], 'edit-phase', /the workflow must preserve the phase number and position/);
    quiet1('the preserved number: position preserved alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['preserve','number and position']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('position preserved'))]], 'edit-phase', /the workflow must preserve the phase number and position/);
    quiet1('the preserved number: number and position alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['preserve','number and position']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('number and position'))]], 'edit-phase', /the workflow must preserve the phase number and position/);
    quiet1('the write in place: in place alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['place','replace']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('in place'))]], 'edit-phase', /the workflow must write the phase back in place \(section replacement\)/);
    quiet1('the write in place: replace section alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['place','replace']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('replace section'))]], 'edit-phase', /the workflow must write the phase back in place \(section replacement\)/);
    quiet1('the write in place: section replace alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['place','replace']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('section replace'))]], 'edit-phase', /the workflow must write the phase back in place \(section replacement\)/);
    quiet1('the roadmap evolution update: state.add-roadmap-evolution alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['state.add-roadmap-evolution','roadmap evolution']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('state.add-roadmap-evolution'))]], 'edit-phase', /the workflow must update the STATE\.md Roadmap Evolution after an edit/);
    quiet1('the roadmap evolution update: roadmap evolution alone is enough', [['gsd-core/workflows/edit-phase.md', compose1((text) => { let out = text; for (const word of ['state.add-roadmap-evolution','roadmap evolution']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('roadmap evolution'))]], 'edit-phase', /the workflow must update the STATE\.md Roadmap Evolution after an edit/);
    quiet1('the rollback wording: rollback alone is enough', [['gsd-core/workflows/edit-phase.md', within('<step name="write_updated_phase">', '</step>', compose1((text) => { let out = text; for (const word of ['rollback','restore','revert','rolled back']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('rollback')))]], 'edit-phase', /a scope or phase-set mismatch must trigger a rollback/);
    quiet1('the rollback wording: restore alone is enough', [['gsd-core/workflows/edit-phase.md', within('<step name="write_updated_phase">', '</step>', compose1((text) => { let out = text; for (const word of ['rollback','restore','revert','rolled back']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('restore')))]], 'edit-phase', /a scope or phase-set mismatch must trigger a rollback/);
    quiet1('the rollback wording: revert alone is enough', [['gsd-core/workflows/edit-phase.md', within('<step name="write_updated_phase">', '</step>', compose1((text) => { let out = text; for (const word of ['rollback','restore','revert','rolled back']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('revert')))]], 'edit-phase', /a scope or phase-set mismatch must trigger a rollback/);
    quiet1('the rollback wording: rolled back alone is enough', [['gsd-core/workflows/edit-phase.md', within('<step name="write_updated_phase">', '</step>', compose1((text) => { let out = text; for (const word of ['rollback','restore','revert','rolled back']) { for (;;) { const at = out.toLowerCase().indexOf(word); if (at === -1) break; out = out.slice(0, at) + out.slice(at + word.length); } } return out; }, append('rolled back')))]], 'edit-phase', /a scope or phase-set mismatch must trigger a rollback/);
    goneOne1('commands/gsd/phase.md', 'edit-phase', 'removed');
    goneOne1('commands/gsd/phase.md', 'edit-phase', 'emptied');
    goneOne1('gsd-core/workflows/edit-phase.md', 'edit-phase', 'removed');
    goneOne1('gsd-core/workflows/edit-phase.md', 'edit-phase', 'emptied');
    goneOne1('docs/INVENTORY.md', 'edit-phase', 'removed');
    goneOne1('docs/INVENTORY.md', 'edit-phase', 'emptied');
    goneOne1('docs/INVENTORY-MANIFEST.json', 'edit-phase', 'removed');
    goneOne1('docs/INVENTORY-MANIFEST.json', 'edit-phase', 'emptied');
    goneOne1('docs/COMMANDS.md', 'edit-phase', 'removed');
    goneOne1('docs/COMMANDS.md', 'edit-phase', 'emptied');
    const killCi1 = (words) => (text) => {
      let out = text;
      for (const word of words) {
        for (;;) {
          const at = out.toLowerCase().indexOf(word);
          if (at === -1) break;
          out = out.slice(0, at) + out.slice(at + word.length);
        }
      }
      return out;
    };
    const FORCE_WHY = /the workflow must allow editing when --force is passed/;
    const FORCE_KILL = ['proceed', 'continue', 'allow', 'override', 'passed'];
    // The word is put right after the first --force, with `gap` filler characters in front of it.
    const afterForce1 = (word, gap) => (text) => {
      const killed = killCi1(FORCE_KILL)(text);
      const at = killed.toLowerCase().indexOf('--force') + '--force'.length;
      return killed.slice(0, at) + 'x'.repeat(gap) + word + killed.slice(at);
    };
    // the --force window: the first --force and the 300 characters after it must hold the word whole (limit - 1, limit, limit + 1)
    gapCases('proceed after --force', 'gsd-core/workflows/edit-phase.md', 'edit-phase', (text, gap) => afterForce1('proceed', gap)(text), 293, FORCE_WHY);
    gapCases('allow after --force', 'gsd-core/workflows/edit-phase.md', 'edit-phase', (text, gap) => afterForce1('allow', gap)(text), 295, FORCE_WHY);
    gapCases('continue after --force', 'gsd-core/workflows/edit-phase.md', 'edit-phase', (text, gap) => afterForce1('continue', gap)(text), 292, FORCE_WHY);
    gapCases('override after --force', 'gsd-core/workflows/edit-phase.md', 'edit-phase', (text, gap) => afterForce1('override', gap)(text), 292, FORCE_WHY);
    for (const word of ['proceed', 'continue', 'allow', 'override', 'PROCEED', 'Override']) {
      quiet1(`the --force window: ${word} alone is enough`, [['gsd-core/workflows/edit-phase.md', afterForce1(word, 1)]], 'edit-phase', FORCE_WHY);
    }
    quiet1('the --force window: force and passed on one line is enough without a word in the window', [['gsd-core/workflows/edit-phase.md', compose1(killCi1(FORCE_KILL), append('force passed'))]], 'edit-phase', FORCE_WHY);
    quiet1('the --force window: force, was and passed on one line is enough', [['gsd-core/workflows/edit-phase.md', compose1(killCi1(FORCE_KILL), append('--force was passed'))]], 'edit-phase', FORCE_WHY);
    editFiles1('the --force window: passed on the line after force is a finding', [['gsd-core/workflows/edit-phase.md', compose1(killCi1(FORCE_KILL), append('force\npassed'))]], 'edit-phase', FORCE_WHY);
    editFiles1('the --force window: passed before force is a finding', [['gsd-core/workflows/edit-phase.md', compose1(killCi1(FORCE_KILL), append('passed force'))]], 'edit-phase', FORCE_WHY);
    editFiles1('the --force window: a word after a later --force is a finding (the first one is read)', [['gsd-core/workflows/edit-phase.md', compose1(killCi1(FORCE_KILL), append('--force proceed'))]], 'edit-phase', FORCE_WHY);
    exactly1('the --force window with no word is one finding', [['gsd-core/workflows/edit-phase.md', killCi1(FORCE_KILL)]], 'edit-phase', 1, FORCE_WHY);
    // the command: the frontmatter keys are read from the closed frontmatter block, at the start of a line
    exactly1('the frontmatter name key indented is one finding', [['commands/gsd/phase.md', swap('\nname: gsd:phase', '\n name: gsd:phase')]], 'edit-phase', 1, /the consolidated phase\.md must have name gsd:phase/);
    quiet1('the frontmatter name: no blank after the colon is enough', [['commands/gsd/phase.md', swap('name: gsd:phase', 'name:gsd:phase')]], 'edit-phase', /must have name gsd:phase/);
    quiet1('the frontmatter name: a tab after the colon is enough', [['commands/gsd/phase.md', swap('name: gsd:phase', 'name:\tgsd:phase')]], 'edit-phase', /must have name gsd:phase/);
    quiet1('the frontmatter name: a no-break space after the colon is enough', [['commands/gsd/phase.md', swap('name: gsd:phase', 'name:\u00a0gsd:phase')]], 'edit-phase', /must have name gsd:phase/);
    quiet1('the frontmatter name: a newline after the colon is enough (the old pattern read \\s*)', [['commands/gsd/phase.md', swap('name: gsd:phase', 'name:\ngsd:phase')]], 'edit-phase', /must have name gsd:phase/);
    quiet1('the frontmatter name: after a lone CR it starts a line', [['commands/gsd/phase.md', swap('\nname: gsd:phase', '\rname: gsd:phase')]], 'edit-phase', /must have name gsd:phase/);
    quiet1('the frontmatter name: after a U+2028 it starts a line', [['commands/gsd/phase.md', swap('\nname: gsd:phase', '\u2028name: gsd:phase')]], 'edit-phase', /must have name gsd:phase/);
    exactly1('the frontmatter name after a word character is one finding', [['commands/gsd/phase.md', swap('\nname: gsd:phase', '\nxname: gsd:phase')]], 'edit-phase', 1, /the consolidated phase\.md must have name gsd:phase/);
    exactly1('a different command name is one finding', [['commands/gsd/phase.md', swap('name: gsd:phase', 'name: gsd:other')]], 'edit-phase', 1, /the consolidated phase\.md must have name gsd:phase/);
    exactly1('the frontmatter description indented is one finding', [['commands/gsd/phase.md', swap('\ndescription:', '\n description:')]], 'edit-phase', 1, /the command must have a description in its frontmatter/);
    quiet1('the frontmatter description after a U+2029 starts a line', [['commands/gsd/phase.md', swap('\ndescription:', '\u2029description:')]], 'edit-phase', /must have a description in its frontmatter/);
    exactly1('a description in the body only is one finding', [['commands/gsd/phase.md', compose1(swap('\ndescription:', '\nsummary:'), append('description: in the body'))]], 'edit-phase', 1, /the command must have a description in its frontmatter/);
    quiet1('the command flag: --edit alone is enough', [['commands/gsd/phase.md', compose1(eraseAll('--edit'), eraseAll('--force'), append('--edit'))]], 'edit-phase', /must document the --edit flag/);
    quiet1('the command flag: --force alone is enough', [['commands/gsd/phase.md', compose1(eraseAll('--edit'), eraseAll('--force'), append('--force'))]], 'edit-phase', /must document the --edit flag/);
    // the word boundaries of title and goal, the optional d of clarified, the blank of current value
    for (const [word, why] of [['title', /the workflow must mention the title field/], ['goal', /the workflow must mention the goal field/]]) {
      for (const around of [`sub${word}`, `_${word}`, `${word}_`, `${word}1`, `x${word}`, `${word}s`]) {
        editFiles1(`${word}: ${around} is not the word`, [['gsd-core/workflows/edit-phase.md', compose1(killCi1([word]), append(around))]], 'edit-phase', why);
      }
      for (const around of [`a ${word}.`, `(${word})`, `${word.toUpperCase()}`, `x-${word}`, `${word}\u00a0x`, `/${word}/`]) {
        quiet1(`${word}: ${around} is the word`, [['gsd-core/workflows/edit-phase.md', compose1(killCi1([word]), append(around))]], 'edit-phase', why);
      }
    }
    editFiles1('the clarified intent prompt: no blank between the words is a finding', [['gsd-core/workflows/edit-phase.md', compose1(killCi1(['clarifie', 'revised']), append('clarifiedintent'))]], 'edit-phase', /must prompt the user for a clarified intent/);
    editFiles1('the clarified intent prompt: a doubled d is a finding', [['gsd-core/workflows/edit-phase.md', compose1(killCi1(['clarifie', 'revised']), append('clarifiedd intent'))]], 'edit-phase', /must prompt the user for a clarified intent/);
    editFiles1('current value: no blank between the words is a finding', [['gsd-core/workflows/edit-phase.md', compose1(killCi1(['current']), append('currentvalue'))]], 'edit-phase', /must present current field values before editing/);
    quiet1('current value: a U+2028 between the words is enough (\\s+ matches it)', [['gsd-core/workflows/edit-phase.md', compose1(killCi1(['current']), append('current\u2028value'))]], 'edit-phase', /must present current field values before editing/);
    quiet1('current value: a newline between the words is enough (\\s+ crosses lines)', [['gsd-core/workflows/edit-phase.md', compose1(killCi1(['current']), append('current\nvalue'))]], 'edit-phase', /must present current field values before editing/);
    for (const gap of ['inprogress', 'in\nprogress', 'in\rprogress', 'in\u2028progress', 'in\u2029progress']) {
      editFiles1(`the in-progress guard: ${JSON.stringify(gap)} is not in.progress`, [['gsd-core/workflows/edit-phase.md', compose1(killCi1(['progress']), append(gap))]], 'edit-phase', /must refuse in_progress edits without --force/);
    }
    quiet1('the in-progress guard: a line that holds only in_progress is enough', [['gsd-core/workflows/edit-phase.md', compose1(killCi1(['progress']), append('IN_PROGRESS'))]], 'edit-phase', /must refuse in_progress edits without --force/);
    exactly1('--force gone from the workflow is one finding (the guards defer to it)', [['gsd-core/workflows/edit-phase.md', killCi1(['--force'])]], 'edit-phase', 1, /the workflow must handle the --force flag/);
    // the rules that read two words on one line: the words on two lines are a finding
    editFiles1('depends_on validation: the words on two lines are a finding', [['gsd-core/workflows/edit-phase.md', compose1(killCi1(['depends']), append('validate\ndepends'))]], 'edit-phase', /must validate depends_on references against the existing phases/);
    editFiles1('the diff: the words on two lines are a finding', [['gsd-core/workflows/edit-phase.md', compose1(killCi1(['diff', 'change']), append('show\nchange'))]], 'edit-phase', /must show a diff of the changes before writing/);
    editFiles1('the decline: says and n on two lines are a finding', [['gsd-core/workflows/edit-phase.md', compose1(killCi1(['without writing', 'says', 'user', 'exit']), append('says\nn'))]], 'edit-phase', /must exit without writing if the user declines the confirmation/);
    editFiles1('the write in place: the words on two lines are a finding', [['gsd-core/workflows/edit-phase.md', compose1(killCi1(['place', 'replace']), append('in\nplace'))]], 'edit-phase', /must write the phase back in place/);
    editFiles1('the invalid reference block: invalid and phase on two lines are a finding', [['gsd-core/workflows/edit-phase.md', compose1(killCi1(['invalid']), append('invalid\nphase'))]], 'edit-phase', /must block the write when depends_on references an invalid phase/);
    quiet1('the invalid reference block: the upper-case words are enough', [['gsd-core/workflows/edit-phase.md', compose1(killCi1(['invalid']), append('INVALID PHASE'))]], 'edit-phase', /must block the write when depends_on references an invalid phase/);
    // the anti_patterns section
    editFiles1('anti_patterns: the closing tag gone is a finding', [['gsd-core/workflows/edit-phase.md', swap('</anti_patterns>', '')]], 'edit-phase', /must have an <anti_patterns> section that blocks renumbering/);
    quiet1('anti_patterns: upper-case tags are the section', [['gsd-core/workflows/edit-phase.md', compose1(swap('<anti_patterns>', '<ANTI_PATTERNS>'), swap('</anti_patterns>', '</ANTI_PATTERNS>'))]], 'edit-phase', /must have an <anti_patterns> section that blocks renumbering/);
    for (const line of ['renumber', 'number preserved', 'preserve number']) {
      quiet1(`anti_patterns: ${line} alone is enough`, [['gsd-core/workflows/edit-phase.md', within('<anti_patterns>', '</anti_patterns>', compose1(killCi1(['renumber', 'preserved', 'preserve']), append(line)))]], 'edit-phase', /must have an <anti_patterns> section that blocks renumbering/);
    }
    editFiles1('anti_patterns: the wording outside the section does not count', [['gsd-core/workflows/edit-phase.md', compose1(within('<anti_patterns>', '</anti_patterns>', killCi1(['renumber', 'preserved', 'preserve'])), append('renumber'))]], 'edit-phase', /must have an <anti_patterns> section that blocks renumbering/);
    exactly1('anti_patterns: the opening tag renamed is one finding', [['gsd-core/workflows/edit-phase.md', swap('<anti_patterns>', '<antipatterns>')]], 'edit-phase', 1, /must have an <anti_patterns> section that blocks renumbering/);
    // the write step and the success criteria
    exactly1('the write_updated_phase step renamed is one finding', [['gsd-core/workflows/edit-phase.md', swap('<step name="write_updated_phase">', '<step name="write">')]], 'edit-phase', 1, /write_updated_phase/);
    exactly1('the success criteria block renamed is one finding', [['gsd-core/workflows/edit-phase.md', swap('<success_criteria>', '<criteria>')]], 'edit-phase', 1, /success_criteria/);
    editFiles1('the success criteria: the milestone scope wording outside the block does not count', [['gsd-core/workflows/edit-phase.md', compose1(within('<success_criteria>', '</success_criteria>', killCi1(['milestone scope'])), append('milestone scope'))]], 'edit-phase', /the success criteria must include the milestone-scope verification/);
    editFiles1('the write step: the wording outside the step does not count', [['gsd-core/workflows/edit-phase.md', compose1(within('<step name="write_updated_phase">', '</step>', killCi1(['scope changed'])), append('scope changed'))]], 'edit-phase', /must surface an explicit milestone scope changed error/);
    quiet1('the write step: SCOPE_BEFORE in lower case is enough', [['gsd-core/workflows/edit-phase.md', within('<step name="write_updated_phase">', '</step>', swap('SCOPE_BEFORE', 'scope_before'))]], 'edit-phase', /the pre-write capture must be named SCOPE_BEFORE/);
    editFiles1('the write step: milestone-scope in upper case is not the probe (the old pattern read it exactly)', [['gsd-core/workflows/edit-phase.md', within('<step name="write_updated_phase">', '</step>', swap('milestone-scope', 'MILESTONE-SCOPE'))]], 'edit-phase', /must run the roadmap milestone-scope probe before writing/);
    // the inventory row: the caller cell, read from the row whose first cell is `edit-phase.md`
    const INV_ROW = 'preserving number and position. | `/gsd-phase --edit` |';
    const invCell1 = (cell) => swap(INV_ROW, `preserving number and position. | ${cell} |`);
    const INV_WHY = /the edit-phase\.md row must list "\/gsd-phase --edit" as its caller/;
    exactly1('the row citing the deleted command is one finding', [['docs/INVENTORY.md', invCell1('`/gsd-edit-phase`')]], 'edit-phase', 1, INV_WHY);
    exactly1('the row citing both commands is one finding', [['docs/INVENTORY.md', invCell1('`/gsd-phase --edit`, `/gsd-edit-phase`')]], 'edit-phase', 1, INV_WHY);
    editFiles1('the row citing the deleted command before a full stop is a finding', [['docs/INVENTORY.md', invCell1('`/gsd-phase --edit` /gsd-edit-phase.')]], 'edit-phase', INV_WHY);
    editFiles1('the row citing the deleted command before a hyphen is a finding', [['docs/INVENTORY.md', invCell1('`/gsd-phase --edit` /gsd-edit-phase-x')]], 'edit-phase', INV_WHY);
    quiet1('the row: a longer name that starts with the deleted command is not a citation', [['docs/INVENTORY.md', invCell1('`/gsd-phase --edit` /gsd-edit-phases')]], 'edit-phase', INV_WHY);
    quiet1('the row: a name that continues with an underscore is not a citation', [['docs/INVENTORY.md', invCell1('`/gsd-phase --edit` /gsd-edit-phase_x')]], 'edit-phase', INV_WHY);
    quiet1('the row: two blanks between /gsd-phase and --edit are enough', [['docs/INVENTORY.md', invCell1('`/gsd-phase  --edit`')]], 'edit-phase', INV_WHY);
    quiet1('the row: a tab between /gsd-phase and --edit is enough', [['docs/INVENTORY.md', invCell1('`/gsd-phase\t--edit`')]], 'edit-phase', INV_WHY);
    quiet1('the row: a no-break space between /gsd-phase and --edit is enough', [['docs/INVENTORY.md', invCell1('`/gsd-phase\u00a0--edit`')]], 'edit-phase', INV_WHY);
    exactly1('the row: no blank between /gsd-phase and --edit is one finding', [['docs/INVENTORY.md', invCell1('`/gsd-phase--edit`')]], 'edit-phase', 1, INV_WHY);
    exactly1('the row with another first cell is one finding (the file still names edit-phase.md)', [['docs/INVENTORY.md', swap('| `edit-phase.md` |', '| `edit-phase.mdx` |')]], 'edit-phase', 1, INV_WHY);
    exactly1('the row without a leading pipe is one finding', [['docs/INVENTORY.md', swap('| `edit-phase.md` |', 'x `edit-phase.md` |')]], 'edit-phase', 1, INV_WHY);
    exactly1('edit-phase.md gone from the whole inventory is one finding', [['docs/INVENTORY.md', eraseAll('edit-phase.md')]], 'edit-phase', 1, INV_WHY);
    const ONE_CELL = '| `edit-phase.md` | Edit any field of an existing phase in ROADMAP.md in place, preserving number and position. | `/gsd-phase --edit` |';
    exactly1('a row with two cells is one finding (the caller cell is missing)', [['docs/INVENTORY.md', swap(ONE_CELL, '| `edit-phase.md` | text |')]], 'edit-phase', 1, INV_WHY);
    exactly1('a row with one cell is one finding', [['docs/INVENTORY.md', swap(ONE_CELL, '| `edit-phase.md` |')]], 'edit-phase', 1, INV_WHY);
    editFiles1('a row without a caller cell hides neither the manifest nor the COMMANDS.md assertion', [['docs/INVENTORY.md', swap(ONE_CELL, '| `edit-phase.md` | text |')], ['docs/COMMANDS.md', eraseAll('/gsd-phase')]], 'edit-phase', /COMMANDS\.md must document \/gsd-phase/);
    // the manifest: invalid JSON, a missing or mistyped families mapping and a mistyped list are one finding each
    exactly1('a manifest that is not JSON is one finding', [['docs/INVENTORY-MANIFEST.json', (text) => `${text}}`]], 'edit-phase', 1, /the manifest is not valid JSON/);
    exactly1('a manifest that is null is one finding', [['docs/INVENTORY-MANIFEST.json', () => 'null']], 'edit-phase', 1, /the manifest has no families mapping/);
    exactly1('a manifest that is an array is one finding', [['docs/INVENTORY-MANIFEST.json', () => '[]']], 'edit-phase', 1, /the manifest has no families mapping/);
    exactly1('a manifest without families is one finding', [['docs/INVENTORY-MANIFEST.json', () => '{}']], 'edit-phase', 1, /the manifest has no families mapping/);
    exactly1('a manifest whose families is null is one finding', [['docs/INVENTORY-MANIFEST.json', () => '{"families":null}']], 'edit-phase', 1, /the manifest has no families mapping/);
    exactly1('a manifest whose families is a list is one finding', [['docs/INVENTORY-MANIFEST.json', () => '{"families":[]}']], 'edit-phase', 1, /the manifest has no families mapping/);
    exactly1('a manifest whose commands is not a list is one finding', [['docs/INVENTORY-MANIFEST.json', jsonEdit1((m) => { m.families.commands = '/gsd-phase'; })]], 'edit-phase', 1, /families\.commands is not a list/);
    exactly1('a manifest whose workflows is not a list is one finding', [['docs/INVENTORY-MANIFEST.json', jsonEdit1((m) => { m.families.workflows = { 'edit-phase.md': true }; })]], 'edit-phase', 1, /families\.workflows is not a list/);
    exactly1('a manifest without /gsd-phase in commands is one finding', [['docs/INVENTORY-MANIFEST.json', jsonEdit1((m) => { m.families.commands = m.families.commands.filter((entry) => entry !== '/gsd-phase'); })]], 'edit-phase', 1, /INVENTORY-MANIFEST\.json must list \/gsd-phase in commands/);
    exactly1('a manifest without edit-phase.md in workflows is one finding', [['docs/INVENTORY-MANIFEST.json', jsonEdit1((m) => { m.families.workflows = m.families.workflows.filter((entry) => entry !== 'edit-phase.md'); })]], 'edit-phase', 1, /INVENTORY-MANIFEST\.json must list edit-phase\.md in workflows/);
    exactly1('COMMANDS.md without /gsd-phase is one finding', [['docs/COMMANDS.md', eraseAll('/gsd-phase')]], 'edit-phase', 1, /COMMANDS\.md must document \/gsd-phase/);
    // the shared table splitter that cannot be loaded is one finding of its own and hides no text check
    const throwingTable1 = "real.walkers.buildCheck(() => { throw new Error('no module'); })";
    test('a table splitter that cannot be loaded is one finding', (t) => {
      const findings = seamRun1(t, copyOfRepoFiles(t), throwingTable1);
      assert.equal(findings.length, 1, JSON.stringify(findings.map((f) => f.message)));
      assert.equal(findings[0].file, 'gsd-core/bin/lib/markdown-table.cjs');
      assert.match(findings[0].message, /gsd-core\/bin\/lib\/markdown-table\.cjs cannot be loaded: no module/);
    });
    test('a table splitter that cannot be loaded does not hide a failing text check', (t) => {
      const root = applyEdits1(t, [['gsd-core/workflows/edit-phase.md', killCi1(['confirm', 'y/n', 'change', 'yes'])], ['docs/INVENTORY.md', eraseAll('edit-phase.md')]]);
      const messages = seamRun1(t, root, throwingTable1).map((f) => f.message);
      assert.ok(messages.some((m) => /cannot be loaded: no module/.test(m)), JSON.stringify(messages));
      assert.ok(messages.some((m) => /the workflow must ask for confirmation before writing/.test(m)), JSON.stringify(messages));
      assert.ok(messages.some((m) => /INVENTORY\.md must contain the edit-phase\.md workflow row/.test(m)), JSON.stringify(messages));
    });
    test('a table splitter that loads reads the real inventory row', (t) => {
      const findings = seamRun1(t, copyOfRepoFiles(t), `real.walkers.buildCheck(() => require(${JSON.stringify(path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', 'markdown-table.cjs'))}))`);
      assert.deepEqual(findings, []);
    });
    {
      const fc = require('./helpers/fast-check-setup.cjs');
      const phase = require('../scripts/static-checks/text-contracts/edit-phase.cjs').walkers;
      const { asciiLower } = require('../scripts/static-checks/text-contracts/lib/ascii-lower.cjs');
      const { splitTableRow } = require('../gsd-core/bin/lib/markdown-table.cjs');
      const strings = (tokens, maxLength = 10) => fc.array(fc.constantFrom(...tokens), { maxLength }).map((parts) => parts.join(''));
      const agrees = (name, arbitrary, pair, isAccepted = (expected) => Boolean(expected)) => {
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
      // The parts in order (the last ones cut short at random), each followed by 0..3 filler characters.
      const chainOf = (parts, fillers) => fc.tuple(fc.nat(parts.length), ...parts.map(() => fc.array(fc.constantFrom(...fillers), { maxLength: 3 }))).map(([keep, ...pads]) => parts.slice(0, keep).map((part, i) => part + pads[i].join('')).join(''));
      const SEPARATORS = [' ', '\t', '\u00a0', '\n', '\r', '\u2028', '\u2029', 'x'];
      const cases = (s) => [s, s.toUpperCase()];
      // Every workflow rule, against the patterns it replaced (the old test took each over the whole file, case-insensitively).
      // A rule that also needs --force defers to the assertion that reports a missing --force: its oracle is true without it.
      const OLD = {
        presentsCurrentValues: [(c) => /current\s+value/i.test(c) || /present.*current/i.test(c) || /display.*current/i.test(c) || /current_value/i.test(c), ['current', 'value', 'present', 'display', 'current_value']],
        editsIndividualFields: [(c) => /specific\s+field/i.test(c) || /individual\s+field/i.test(c) || /edit.*field/i.test(c), ['specific', 'individual', 'field', 'edit']],
        mentionsTitle: [(c) => /\btitle\b/i.test(c), ['title', 'Title', 'subtitle', '_', '-', '1']],
        mentionsGoal: [(c) => /\bgoal\b/i.test(c), ['goal', 'GOAL', 'goals', '_', '-', '1']],
        mentionsDependsOn: [(c) => /depends_on/i.test(c), ['depends_on', 'DEPENDS', '_on', 'depends']],
        mentionsRequirements: [(c) => /requirements/i.test(c), ['requirements', 'REQUIREMENTS', 'require']],
        mentionsSuccessCriteria: [(c) => /success_criteria/i.test(c), ['success_criteria', 'SUCCESS', 'success', 'criteria']],
        regeneratesFromIntent: [(c) => /regenerate/i.test(c) || /rewrite.*all/i.test(c) || /all.*from.*clarified/i.test(c) || /clarified.*intent/i.test(c), ['regenerate', 'rewrite', 'all', 'from', 'clarified', 'intent']],
        promptsClarifiedIntent: [(c) => /clarified?\s+intent/i.test(c) || /revised\s+intent/i.test(c) || /describe.*revised/i.test(c), ['clarified', 'clarifie', 'intent', 'revised', 'describe']],
        validatesDependsOn: [(c) => /validate.*depends/i.test(c) || /depends.*valid/i.test(c) || /invalid.*depends/i.test(c) || /depends_on.*valid/i.test(c), ['validate', 'depends', 'valid', 'invalid', 'depends_on']],
        blocksInvalidReference: [(c) => /invalid.*phase/i.test(c) && /exit|block|error/i.test(c), ['invalid', 'phase', 'exit', 'block', 'error']],
        preventsSelfReference: [(c) => /not reference itself/i.test(c) || /circular/i.test(c) || /self-reference/i.test(c) || /itself/i.test(c), ['circular', 'self-reference', 'itself', 'self', 'reference']],
        checksPhaseStatus: [(c) => /disk_status/i.test(c) || /phase.*status/i.test(c) || /status.*check/i.test(c), ['disk_status', 'phase', 'status', 'check']],
        refusesInProgress: [(c) => !/--force/i.test(c) || /in.progress/i.test(c), ['--force', 'in', 'progress', '_', ' ', '-']],
        refusesCompleted: [(c) => !/--force/i.test(c) || /completed/i.test(c), ['--force', 'completed', 'COMPLETED', 'complete']],
        errorsWhenPhaseMissing: [(c) => /not.*found/i.test(c) || /phase.*not.*found/i.test(c) || /does not exist/i.test(c), ['not', 'found', 'does not exist', 'phase']],
        errorsOnMissingArgument: [(c) => /no.*argument/i.test(c) || /required/i.test(c) || /phase number required/i.test(c), ['no', 'argument', 'required', 'phase number required']],
        showsDiff: [(c) => /diff/i.test(c) || /proposed.*change/i.test(c) || /show.*change/i.test(c), ['diff', 'DIFF', 'proposed', 'show', 'change']],
        asksConfirmation: [(c) => /confirm/i.test(c) || /apply.*change/i.test(c) || /y\/n/i.test(c) || /yes.*no/i.test(c), ['confirm', 'apply', 'change', 'y/n', 'yes', 'no']],
        exitsOnDecline: [(c) => /says.*n/i.test(c) || /user says.*n/i.test(c) || /if.*user.*n/i.test(c) || /exit.*without.*writing/i.test(c) || /without writing/i.test(c), ['says', 'n', 'if', 'user', 'exit', 'without', 'writing', 'without writing']],
        preservesNumber: [(c) => /number.*preserved/i.test(c) || /preserve.*number/i.test(c) || /position.*preserved/i.test(c) || /number and position/i.test(c), ['number', 'preserved', 'preserve', 'position', 'number and position']],
        writesInPlace: [(c) => /in.*place/i.test(c) || /replace.*section/i.test(c) || /section.*replace/i.test(c) || /replace.*old.*section/i.test(c), ['in', 'place', 'replace', 'section', 'old']],
        updatesRoadmapEvolution: [(c) => /state\.add-roadmap-evolution/i.test(c) || /Roadmap Evolution/i.test(c), ['state.add-roadmap-evolution', 'roadmap evolution', 'Roadmap Evolution', 'roadmap']],
      };
      test('property: every workflow rule agrees with the patterns it replaced', () => {
        assert.deepEqual([...Object.keys(OLD), 'allowsForce'].sort(), Object.keys(phase.RULES).sort());
        for (const [name, [oracle, words]] of Object.entries(OLD)) {
          const tokens = [...words, ' ', '\n', 'x'];
          const inputs = fc.oneof(strings(tokens, 8), strings([...tokens, '\r', '\u2028', '\u2029', '\t'], 12), fc.array(fc.constantFrom(...words.flatMap(cases)), { maxLength: 4 }).map((parts) => parts.join(' ')));
          agrees(name, inputs, (s) => [phase.RULES[name][1](asciiLower(s)), oracle(s)]);
        }
      });
      test('property: the --force window agrees with /--force[\\s\\S]{0,300}/ and the words in it', () => {
        const oracle = (c) => {
          const window = c.match(/--force[\s\S]{0,300}/i);
          if (window === null) return true;
          return /proceed|continue|allow|override/i.test(window[0]) || /force.*was.*passed/i.test(c) || /force.*passed/i.test(c);
        };
        const words = ['proceed', 'continue', 'allow', 'override', 'PROCEED', 'Allow'];
        const structured = fc.tuple(fc.constantFrom('', 'x', '--force ', 'passed '), fc.constantFrom('--force', '--FORCE', '--Force'), fc.integer({ min: 280, max: 305 }), fc.constantFrom(...words), fc.constantFrom('', ' tail', '\nforce passed', ' --force allow')).map(([before, flag, gap, word, tail]) => `${before}${flag}${'x'.repeat(gap)}${word}${tail}`);
        const inputs = fc.oneof(structured, strings(['--force', 'proceed', 'allow', 'passed', 'force', 'was', ' ', '\n', 'x'], 10));
        agrees('force window', inputs, (s) => [phase.forceAllowsEdit(asciiLower(s)), oracle(s)]);
      });
      test('property: the scope rules agree with the patterns they replaced', () => {
        const OLD_SCOPE = {
          capturesScopeBefore: [(c) => /milestone-scope/.test(c), ['milestone-scope', 'MILESTONE-SCOPE', 'milestone']],
          namesScopeBefore: [(c) => /SCOPE_BEFORE/i.test(c), ['SCOPE_BEFORE', 'scope_before', 'SCOPE']],
          rederivesScopeAfter: [(c) => /SCOPE_AFTER/i.test(c), ['SCOPE_AFTER', 'scope_after', 'SCOPE']],
          rollsBack: [(c) => /rollback|restore|revert|rolled back/i.test(c), ['rollback', 'restore', 'revert', 'rolled back', 'ROLLBACK', 'roll']],
          surfacesScopeError: [(c) => /milestone scope changed|scope changed/i.test(c), ['milestone scope changed', 'scope changed', 'Scope Changed', 'scope']],
        };
        assert.deepEqual(Object.keys(OLD_SCOPE).sort(), Object.keys(phase.SCOPE_RULES).sort());
        for (const [name, [oracle, words]] of Object.entries(OLD_SCOPE)) {
          agrees(name, strings([...words, ' ', 'x'], 4), (s) => [phase.SCOPE_RULES[name][1](s), oracle(s)]);
        }
      });
      test('property: the anti_patterns walk agrees with the section and the pattern it replaced', () => {
        const oracle = (c) => {
          const m = c.match(/<anti_patterns>([\s\S]*?)<\/anti_patterns>/i);
          if (m === null) return null;
          return /renumber|number.*preserved|preserve.*number/i.test(m[1]);
        };
        const inputs = fc.oneof(
          strings(['<anti_patterns>', '</anti_patterns>', '<ANTI_PATTERNS>', 'renumber', 'number', 'preserved', 'preserve', ' ', '\n', 'x'], 9),
          chainOf(['<anti_patterns>', 'renumber', '</anti_patterns>'], SEPARATORS),
          chainOf(['<anti_patterns>', 'number', 'preserved', '</anti_patterns>'], SEPARATORS),
          chainOf(['renumber', '</anti_patterns>', '<anti_patterns>'], SEPARATORS),
        );
        agrees('anti_patterns', inputs, (s) => {
          const got = phase.antiPatternsBlockRenumbering(asciiLower(s));
          return [got.missing ? null : got.ok, oracle(s)];
        }, (expected) => expected === true);
        let missing = 0;
        fc.assert(fc.property(inputs, (s) => { if (oracle(s) === null) missing += 1; }));
        assert.ok(missing > 0, 'the property saw no text without the section');
      });
      test('property: the frontmatter key walks agree with /^name:\\s*gsd:phase/m and /^description:/m', () => {
        const inputs = fc.oneof(
          strings(['name:', 'gsd:phase', 'description:', ' ', '\t', '\u00a0', '\n', '\r', '\u2028', '\u2029', 'x'], 8),
          chainOf(['name:', 'gsd:phase'], SEPARATORS),
          chainOf(['x', '\n', 'name:', 'gsd:phase'], SEPARATORS),
          chainOf(['\u2028', 'description:'], SEPARATORS),
        );
        agrees('name', inputs, (s) => [phase.namesGsdPhase(s), /^name:\s*gsd:phase/m.test(s)]);
        agrees('description', inputs, (s) => [phase.keyLineAt(s, 'description:') !== -1, /^description:/m.test(s)]);
      });
      test('property: the inventory row and the caller cell agree with the splitter and patterns they replaced', () => {
        const oldRow = (inventory) => {
          const row = inventory.split(/\r?\n/).map((line) => (line.trim().startsWith('|') ? splitTableRow(line) : null)).find((cells) => cells && cells[0] === '`edit-phase.md`');
          return row === undefined ? null : row;
        };
        const rows = fc.constantFrom('| `edit-phase.md` | a | `/gsd-phase --edit` |', '|`edit-phase.md`|a|b|', 'text', '  | x | y |', '', '| `other.md` | a | b |', '\t| `edit-phase.md` | a | c |', '| `edit-phase.md` |', '| `edit-phase.mdx` | a | b |', '\u00a0| `edit-phase.md` | a | d |', '`edit-phase.md` | a | e |');
        const sources = fc.array(fc.tuple(rows, fc.constantFrom('\n', '\r\n')), { maxLength: 5 }).map((parts) => parts.map(([line, br]) => line + br).join(''));
        agrees('row', sources, (s) => [phase.editPhaseRow(s.split('\r\n').join('\n'), splitTableRow), oldRow(s)], (expected) => expected !== null);
        const cellTokens = ['/gsd-phase', '--edit', '/gsd-edit-phase', ' ', '\t', '\u00a0', '\n', 'x', '_', '-', '.', 's'];
        const cells = fc.oneof(strings(cellTokens, 8), chainOf(['/gsd-phase', '--edit'], SEPARATORS), chainOf(['x', '/gsd-edit-phase'], ['.', '_', '-', 's', 'x', ' ']));
        agrees('phase edit', cells, (s) => [phase.citesPhaseEdit(s), /\/gsd-phase\s+--edit/.test(s)]);
        agrees('deleted command', cells, (s) => [phase.citesDeletedCommand(s), /\/gsd-edit-phase\b/.test(s)]);
      });
      test('property: the manifest family walk agrees with reading families.<name> directly', () => {
        const oracle = (text, family) => {
          try {
            const list = JSON.parse(text).families[family];
            return Array.isArray(list) ? list : null;
          } catch {
            return null;
          }
        };
        const entries = fc.constantFrom(['/gsd-phase'], ['edit-phase.md', 'x'], [], 'x', null, { a: 1 }, 5);
        const manifests = fc.oneof(
          fc.record({ families: fc.record({ commands: entries, workflows: entries }) }),
          fc.constantFrom({ families: null }, { families: [] }, { families: 'x' }, {}, [], null, 5, 'text'),
        ).map((value) => JSON.stringify(value));
        const texts = fc.oneof(manifests, fc.constantFrom('', '{', 'not json', '{"families":'));
        agrees('manifest', texts, (s) => {
          const got = phase.manifestFamily(s, 'commands');
          return [got.list === undefined ? null : got.list, oracle(s, 'commands')];
        }, (expected) => expected !== null);
      });
    }
    {
      const fc = require('./helpers/fast-check-setup.cjs');
      const audit = require('../scripts/static-checks/text-contracts/audit-fix-command.cjs').walkers;
      const strings = (tokens, maxLength = 10) => fc.array(fc.constantFrom(...tokens), { maxLength }).map((parts) => parts.join(''));
      test('property: the dry-run order agrees with the index comparison it replaced, where the flag is named', () => {
        // No dry-run, or no fix-loop, is the finding of the assertion that asks for it, so the order check is silent there.
        const oracle = (text) => {
          const dryRun = text.indexOf('dry-run');
          const fixLoop = text.indexOf('fix-loop');
          if (dryRun === -1 || fixLoop === -1) return true;
          return dryRun < fixLoop;
        };
        let accepted = 0;
        let rejected = 0;
        fc.assert(fc.property(strings(['dry-run', 'fix-loop', 'x', '\n', ' '], 8), (s) => {
          const expected = oracle(s);
          assert.equal(audit.dryRunBeforeFixLoop(s) === true, expected, JSON.stringify(s));
          if (expected) accepted += 1;
          else rejected += 1;
        }));
        assert.ok(accepted > 0 && rejected > 0, `the property saw ${accepted} accepted and ${rejected} rejected strings`);
      });
    }
  }

  {
    // adr-218-release-version-validation, tdd-single-statement, mcp-tool-inheritance and agent-classification-parity: controls, the exactly-one-finding
    // cases, the bounds of every limit, the loader seams and a differential property for every linear walker.
    const RELEASE = '.github/workflows/release.yml';
    const TDD = 'gsd-core/references/tdd.md';
    const EXECUTOR = 'agents/gsd-executor.md';
    const EXECUTE_PLAN = 'gsd-core/workflows/execute-plan.md';
    const MVP = 'gsd-core/references/execute-mvp-tdd.md';
    const EXECUTE_PHASE = 'gsd-core/workflows/execute-phase.md';
    const ISOLATION = 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md';
    const AGENTS_MD = 'docs/reference/agents.md';
    const INVENTORY_MD = 'docs/INVENTORY.md';
    const rewrite = (root, rel, edit) => {
      const abs = path.join(root, ...rel.split('/'));
      const before = fs.readFileSync(abs, 'utf8');
      const after = edit(before);
      assert.notEqual(after, before, 'the edit changed the file');
      fs.writeFileSync(abs, after);
    };
    // A run over a copy of the tree with some files edited; `heavy` copies the agent roster and the two docs too.
    const runEdits = (t, edits, contract, heavy = false) => {
      const root = copyOfRepoFiles(t, heavy ? HEAVY : []);
      for (const [rel, edit] of edits) rewrite(root, rel, edit);
      return runShipped(root, [contract]);
    };
    const messagesOf = (findings) => JSON.stringify(findings.map((f) => f.message));
    const exactlyOne = (title, edits, contract, expected, heavy = false) => test(title, (t) => {
      const findings = runEdits(t, edits, contract, heavy);
      assert.equal(findings.length, 1, messagesOf(findings));
      assert.ok(findings[0].message.includes(expected), `expected "${expected}" in ${findings[0].message}`);
    });
    const someFinding = (title, edits, contract, expected, heavy = false) => test(title, (t) => {
      const findings = runEdits(t, edits, contract, heavy);
      assert.ok(findings.some((f) => f.message.includes(expected)), `expected "${expected}" in ${messagesOf(findings)}`);
    });
    const holds = (title, edits, contract, heavy = false) => test(title, (t) => {
      assert.deepEqual(runEdits(t, edits, contract, heavy), []);
    });
    const inToolsLine = (edit) => (text) => {
      const at = text.indexOf('\ntools:') + 1;
      const end = text.indexOf('\n', at);
      return text.slice(0, at) + edit(text.slice(at, end)) + text.slice(end);
    };
    // A contract wrapped so its loader throws: the real check, run through the engine, with the library it loads replaced.
    const seamRun = (t, id, factory, heavy = false, edits = []) => {
      const root = copyOfRepoFiles(t, heavy ? HEAVY : []);
      for (const [rel, edit] of edits) rewrite(root, rel, edit);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-seam-'));
      t.after(() => cleanup(dir));
      const real = path.join(REPO_ROOT, 'scripts', 'static-checks', 'text-contracts', `${id}.cjs`);
      fs.writeFileSync(path.join(dir, `${id}.cjs`), `const real = require(${JSON.stringify(real)});\nmodule.exports = { id: real.id, check: ${factory} };\n`);
      return textContracts.run({ root, dir, only: [id], minContracts: 1 });
    };

    // A removed or emptied file is exactly one finding for that path, in every contract that reads it.
    for (const [contract, rels, heavy] of [
      ['adr-218-release-version-validation', [RELEASE], false],
      ['tdd-single-statement', [TDD, EXECUTOR, EXECUTE_PLAN, MVP, EXECUTE_PHASE, ISOLATION], false],
      ['agent-classification-parity', [AGENTS_MD, INVENTORY_MD], true],
      ['mcp-tool-inheritance', [EXECUTOR, 'agents/gsd-planner.md', 'agents/gsd-phase-researcher.md', 'agents/gsd-project-researcher.md', 'agents/gsd-ui-researcher.md'], true],
    ]) {
      for (const rel of rels) {
        test(`${rel} removed is exactly one finding for ${contract}`, (t) => {
          const root = copyOfRepoFiles(t, heavy ? HEAVY : []);
          fs.unlinkSync(path.join(root, ...rel.split('/')));
          const findings = runShipped(root, [contract]);
          assert.equal(findings.length, 1, messagesOf(findings));
          assert.equal(findings[0].file, rel);
          assert.match(findings[0].message, /cannot read the file/);
        });
        test(`${rel} emptied is exactly one finding for ${contract}`, (t) => {
          const root = copyOfRepoFiles(t, heavy ? HEAVY : []);
          fs.writeFileSync(path.join(root, ...rel.split('/')), '');
          const findings = runShipped(root, [contract]);
          assert.equal(findings.length, 1, messagesOf(findings));
          assert.equal(findings[0].file, rel);
          assert.match(findings[0].message, /the file is empty/);
        });
      }
    }

    // adr-218: one finding per cause, the count of grep -qE patterns at 1, 2 and 3, a list in needs.
    exactlyOne('release.yml no longer YAML is exactly one finding', [[RELEASE, append('foo: [unclosed')]], 'adr-218-release-version-validation', 'release.yml is not valid YAML');
    exactlyOne('jobs as a list is exactly one finding', [[RELEASE, swap('\njobs:\n', '\njobs: []\nold:\n')]], 'adr-218-release-version-validation', 'release.yml is not a workflow with a jobs mapping');
    exactlyOne('a missing duplicate-version step is exactly one finding', [[RELEASE, eraseAll('Reject already-published versions')]], 'adr-218-release-version-validation', 'must contain a step named "Reject already-published versions"');
    exactlyOne('a missing format step is exactly one finding', [[RELEASE, swap('name: Validate version format', 'name: Check the version')]], 'adr-218-release-version-validation', 'no "Validate version format" step');
    exactlyOne('a renamed gate job is exactly one finding', [[RELEASE, swap('\n  validate-version:\n', '\n  validate-versions:\n')]], 'adr-218-release-version-validation', 'must define a `validate-version:` job');
    exactlyOne('a renamed rc job is exactly one finding', [[RELEASE, swap('\n  rc:\n', '\n  rcx:\n')]], 'adr-218-release-version-validation', 'must have a `rc:` job');
    exactlyOne('a scalar rc job is exactly one finding', [[RELEASE, yamlEdit((w) => { w.jobs.rc = 'x'; })]], 'adr-218-release-version-validation', 'the job is not a mapping');
    exactlyOne('a create job without needs is exactly one finding', [[RELEASE, yamlEdit((w) => { delete w.jobs.create.needs; })]], 'adr-218-release-version-validation', 'the `create` job must list validate-version');
    exactlyOne('a gate declared after the create job is exactly one finding', [[RELEASE, yamlEdit((w) => { const { create, ...rest } = w.jobs; const gate = rest['validate-version']; delete rest['validate-version']; w.jobs = { create, 'validate-version': gate, ...rest }; })]], 'adr-218-release-version-validation', 'validate-version must be declared before the create job');
    holds('needs as a list holding the gate is accepted', [[RELEASE, yamlEdit((w) => { w.jobs.create.needs = ['install-smoke-rc', 'validate-version']; })]], 'adr-218-release-version-validation');
    holds('needs as a one-item list is accepted', [[RELEASE, yamlEdit((w) => { w.jobs.create.needs = ['validate-version']; })]], 'adr-218-release-version-validation');
    {
      const walkers = require('../scripts/static-checks/text-contracts/adr-218-release-version-validation.cjs').walkers;
      // Keeps the first `keep` patterns of release.yml as grep -qE calls and turns the others into grep -q.
      const keepPatterns = (keep) => (text) => {
        let seen = 0;
        return text.split('grep -qE').reduce((out, part, i) => (i === 0 ? part : `${out}${seen++ < keep ? 'grep -qE' : 'grep -q'}${part}`), '');
      };
      for (const [keep, ok] of [[1, false], [2, true], [3, true]]) {
        test(`release.yml with ${keep} grep -qE pattern(s) ${ok ? 'satisfies' : 'is below the minimum of'} the adr-218 contract`, (t) => {
          const root = copyOfRepoFiles(t);
          rewrite(root, RELEASE, keepPatterns(keep));
          assert.equal(walkers.extractGrepPatterns(fs.readFileSync(path.join(root, ...RELEASE.split('/')), 'utf8')).length, keep);
          const findings = runShipped(root, ['adr-218-release-version-validation']);
          if (ok) assert.deepEqual(findings, []);
          else {
            assert.equal(findings.length, 1, messagesOf(findings));
            assert.match(findings[0].message, /at least 2 leading-zero-aware grep -qE version patterns \(found 1:/);
          }
        });
      }
      test('a js-yaml that cannot be loaded is one finding of the adr-218 contract', (t) => {
        const findings = seamRun(t, 'adr-218-release-version-validation', "(ctx) => real.check(ctx, () => { throw new Error('no yaml'); })");
        assert.equal(findings.length, 1, messagesOf(findings));
        assert.equal(findings[0].file, 'package.json');
        assert.match(findings[0].message, /js-yaml cannot be loaded: no yaml/);
      });
      test('a js-yaml that cannot be loaded leaves the text checks of release.yml running', (t) => {
        const findings = seamRun(t, 'adr-218-release-version-validation', "(ctx) => real.check(ctx, () => { throw new Error('no yaml'); })", false, [[RELEASE, eraseAll('Reject already-published versions')]]);
        assert.equal(findings.length, 2, messagesOf(findings));
        assert.ok(findings.some((f) => f.message.includes('js-yaml cannot be loaded: no yaml')), messagesOf(findings));
        assert.ok(findings.some((f) => f.message.includes('must contain a step named "Reject already-published versions"')), messagesOf(findings));
      });
      test('a js-yaml that cannot be loaded and a removed release.yml are two causes and two findings', (t) => {
        const root = copyOfRepoFiles(t);
        fs.unlinkSync(path.join(root, ...RELEASE.split('/')));
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-seam-'));
        t.after(() => cleanup(dir));
        const real = path.join(REPO_ROOT, 'scripts', 'static-checks', 'text-contracts', 'adr-218-release-version-validation.cjs');
        fs.writeFileSync(path.join(dir, 'adr-218-release-version-validation.cjs'), `const real = require(${JSON.stringify(real)});\nmodule.exports = { id: real.id, check: (ctx) => real.check(ctx, () => { throw new Error('no yaml'); }) };\n`);
        const findings = textContracts.run({ root, dir, only: ['adr-218-release-version-validation'], minContracts: 1 });
        assert.equal(findings.length, 2, messagesOf(findings));
      });
      exactlyOne('a needs list without the gate names its items', [[RELEASE, yamlEdit((w) => { w.jobs.create.needs = ['x', 'y']; })]], 'adr-218-release-version-validation', 'needs is [x, y]');
      exactlyOne('a needs mapping is described as an object', [[RELEASE, yamlEdit((w) => { w.jobs.create.needs = { a: 1 }; })]], 'adr-218-release-version-validation', 'needs is an object');
      exactlyOne('a circular needs list is one finding and does not throw', [[RELEASE, swap('  create:\n    needs: validate-version\n', '  create:\n    needs: &n [*n]\n')]], 'adr-218-release-version-validation', 'needs is [a list]');
      test('the grep -qE walk takes both quote forms, skips an empty pattern and an unquoted one, and continues after a miss', () => {
        assert.deepEqual(walkers.extractGrepPatterns("grep -qE '^a$' && grep -qE \"^b\" && grep -qE '' && grep -qE x && grep  -qE\t'c'"), ['^a$', '^b', 'c']);
        assert.deepEqual(walkers.extractGrepPatterns('grep -qEx "a" grep -qE "unterminated'), []);
        assert.deepEqual(walkers.extractGrepPatterns("grep grep -qE 'a'"), ['a']);
      });
    }

    // tdd-single-statement: one finding per cause, the bounds of the three limits, the fixtures of the old test on the exported walks.
    exactlyOne('a missing canonical heading is exactly one finding', [[TDD, eraseAll('## Red-Green-Refactor Cycle')]], 'tdd-single-statement', 'tdd.md carries the canonical Red-Green-Refactor Cycle section');
    exactlyOne('a missing RED commit-scope contract is exactly one finding', [[TDD, eraseAll('Commit: `test({phase}-{plan})')]], 'tdd-single-statement', 'the canonical section carries the RED commit-scope contract');
    exactlyOne('a missing GREEN commit-scope contract is exactly one finding', [[TDD, eraseAll('Commit: `feat({phase}-{plan})')]], 'tdd-single-statement', 'the canonical section carries the GREEN commit-scope contract');
    exactlyOne('an executor restating the commits is exactly one finding', [[EXECUTOR, append('1. commit: `test({phase}-{plan}): x`\n2. commit: `fix({phase}-{plan}): y`')]], 'tdd-single-statement', '<tdd_execution> must not restate the numbered RED/GREEN commit protocol');
    exactlyOne('an executor without the pointer is exactly one finding', [[EXECUTOR, eraseAll('references/tdd.md')]], 'tdd-single-statement', 'the executor points at the canonical reference');
    exactlyOne('a plan-execution section that cannot be found is exactly one finding', [[EXECUTE_PLAN, eraseAll('tdd_plan_execution')]], 'tdd-single-statement', 'no tdd_plan_execution section');
    exactlyOne('a missing halt reason is exactly one finding', [[MVP, eraseAll('impl_before_test')]], 'tdd-single-statement', 'the check-3 halt reason must name impl_before_test');
    exactlyOne('an unconditional embed entry is exactly one finding', [[ISOLATION, swap('${TDD_APPLICABLE ? "- tdd.md" : ""}', '- tdd.md  # TDD_APPLICABLE')]], 'tdd-single-statement', 'executor-isolation-dispatch.md must list tdd.md as an embed entry conditional on TDD_APPLICABLE');
    exactlyOne('a missing embed entry is exactly one finding', [[EXECUTE_PHASE, swap("${TDD_APPLICABLE ? '- `~/.claude/gsd-core/references/tdd.md`' : ''}", '')]], 'tdd-single-statement', 'execute-phase.md must list tdd.md as an embed entry conditional on TDD_APPLICABLE');
    // A restatement is a finding on its own signal: the literal commit lines alone, the missing citation alone, the span alone, three list items alone.
    someFinding('the structural signal fires on a cycle cut loose from every citation of the executor, not only on the literal commit lines', [[EXECUTOR, within('**2-4. RED', '## Plan-Level TDD', (text) => text.split('tdd.md').join('x').split('canonical').join('x'))]], 'tdd-single-statement', "compact citation of RED/GREEN/REFACTOR must not be flagged");

    // The commit-scope gap between the feat and fix lines of tdd.md stops at 200 characters on one line.
    gapCases('the gap between the feat and the fix commit lines of tdd.md', TDD, 'tdd-single-statement', (text, gap) => {
      const start = 'Commit: `feat({phase}-{plan})';
      const at = text.indexOf(start);
      return text.slice(0, at + start.length) + 'x'.repeat(gap) + text.slice(text.indexOf('or `fix({phase}-{plan})', at));
    }, 200, /the canonical section carries the GREEN commit-scope contract/);
    // The span from RED to REFACTOR may be 200 characters; 201 is a restatement, whatever else the text cites.
    gapCases('the RED to REFACTOR span of the executor', EXECUTOR, 'tdd-single-statement',
      (text, gap) => swap('RED → GREEN → REFACTOR (#3990', `RED → GREEN →${'.'.repeat(gap - 14)} REFACTOR (#3990`)(text), 200,
      /compact citation of RED\/GREEN\/REFACTOR must not be flagged/);
    gapCases('the RED to REFACTOR span of execute-plan', EXECUTE_PLAN, 'tdd-single-statement',
      (text, gap) => swap('plans — RED-GREEN-REFACTOR:', `plans — RED-GREEN-${'.'.repeat(gap - 10)}REFACTOR:`)(text), 200,
      /compact citation of RED\/GREEN\/REFACTOR must not be flagged/);

    {
      const fc = require('./helpers/fast-check-setup.cjs');
      const tdd = require('../scripts/static-checks/text-contracts/tdd-single-statement.cjs').walkers;
      const THRESHOLD = tdd.RESTATEMENT_SPAN_THRESHOLD;

      test('the literal commit lines: a fix-only GREEN is a restatement, a GREEN before the RED line and a pointer are not', () => {
        assert.ok(tdd.restatesCycle('commit: `test({phase}-{plan}): x`\ncommit: `fix({phase}-{plan}): y`'), 'fix-only GREEN');
        assert.ok(tdd.restatesCycle('commit: `test({phase}-{plan}): x`\ncommit: `feat({phase}-{plan}): y`'), 'feat GREEN');
        assert.ok(!tdd.restatesCycle('commit: `fix({phase}-{plan}): y`\ncommit: `test({phase}-{plan}): x`'), 'a GREEN before the RED anchor');
        assert.ok(!tdd.restatesCycle('commit: `test({phase}-{plan}): x`'), 'a RED line alone');
        assert.ok(!tdd.restatesCycle('see references/tdd.md'), 'a pointer');
      });

      test('a reworded multi-step re-derivation of RED/GREEN/REFACTOR is a restatement the literal detector cannot see', () => {
        const fixture = [
          '## TDD procedure for this task',
          '',
          '1. RED: write a failing test that captures the missing behavior, run the',
          '   suite, and confirm it fails for the expected reason before touching any',
          '   implementation code. Commit the failing test on its own.',
          '2. GREEN: write the minimal implementation needed to make that test pass,',
          '   run the full suite again, and confirm every test is green before moving',
          '   on. Commit the passing implementation separately from the test.',
          '3. REFACTOR: clean up the implementation and tests while keeping the suite',
          '   green throughout, committing only if something actually changed.',
        ].join('\n');
        assert.ok(tdd.restatesCycleStructurally(fixture));
        assert.ok(!tdd.restatesCycle(fixture));
      });

      test('a compact restatement with no list marker that never cites tdd.md is flagged', () => {
        const fixture = 'RED: write a failing test proving the bug exists. GREEN: write the '
          + 'smallest change that makes the test pass and keep the suite green. '
          + 'REFACTOR: clean the code up now that everything passes.';
        assert.equal(fixture.length, 189);
        assert.ok(tdd.restatesCycleStructurally(fixture));
      });

      // The span of RED to REFACTOR: 199 and 200 are inside, 201 is past the limit.
      for (const [span, fires] of [[THRESHOLD - 1, false], [THRESHOLD, false], [THRESHOLD + 1, true]]) {
        test(`a cycle spanning ${span} characters ${fires ? 'is past' : 'is inside'} the restatement span limit`, () => {
          const fixture = `RED GREEN ${'.'.repeat(span - 'RED GREEN '.length)}REFACTOR`;
          const cycle = tdd.measureCycleSpan(fixture);
          assert.equal(cycle.span, span);
          assert.equal(cycle.span > THRESHOLD, fires);
          if (fires) assert.ok(tdd.restatesCycleStructurally(fixture));
        });
        test(`a cycle spanning ${span} characters that cites tdd.md is ${fires ? 'a restatement' : 'a pointer'}`, () => {
          const fixture = `RED GREEN ${'.'.repeat(span - 'RED GREEN '.length)}REFACTOR tdd.md`;
          assert.equal(tdd.restatesCycleStructurally(fixture), fires);
        });
      }

      // The citation must lie wholly inside the 500 characters after REFACTOR: the last start offset is 500 minus the marker length.
      for (const [marker, limit] of [['tdd.md', 494], ['references/tdd', 486], ['canonical', 491]]) {
        for (const [offset, restates] of [[limit - 1, false], [limit, false], [limit + 1, true]]) {
          test(`${marker} starting ${offset} characters after REFACTOR ${restates ? 'is past' : 'is inside'} the citation window`, () => {
            assert.equal(tdd.restatesCycleStructurally(`RED GREEN REFACTOR${'.'.repeat(offset)}${marker}`), restates);
          });
        }
      }
      test('each citation marker alone is enough, and no marker is a restatement', () => {
        for (const marker of ['tdd.md', 'references/tdd', 'canonical']) assert.equal(tdd.restatesCycleStructurally(`RED GREEN REFACTOR ${marker}`), false, marker);
        assert.equal(tdd.restatesCycleStructurally('RED GREEN REFACTOR'), true);
        assert.equal(tdd.restatesCycleStructurally('GREEN REFACTOR tdd.md'), false);
        assert.equal(tdd.restatesCycleStructurally('RED REFACTOR GREEN tdd.md'), false);
      });

      test('three distinct list items each carrying one of the words are a restatement even with a citation', () => {
        assert.equal(tdd.restatesCycleStructurally('RED\n- RED a\n- GREEN b\n- REFACTOR c tdd.md'), true);
        assert.equal(tdd.restatesCycleStructurally('RED\n- RED a GREEN b\n- REFACTOR c tdd.md'), false);
        assert.equal(tdd.restatesCycleStructurally('RED\n- RED a\n- GREEN b REFACTOR c tdd.md'), false);
        assert.equal(tdd.restatesCycleStructurally('RED\n- RED a\n- GREEN b\nREFACTOR c tdd.md'), false);
      });

      test('a filler of any length never lets a citation-free, list-free restatement through, and a citation counts only inside the span limit', () => {
        const fillerArb = fc.string({ maxLength: 300 }).map((s) => s
          .replace(/[\r\n]/g, ' ')
          .replace(/[-*]/g, '.')
          .replace(/\bRED\b/gi, 'xxx')
          .replace(/\bGREEN\b/gi, 'xxx')
          .replace(/\bREFACTOR\b/gi, 'xxx')
          .replace(/tdd/gi, 'xxx')
          .replace(/canonical/gi, 'xxx'));
        let withinLimit = 0;
        let pastLimit = 0;
        const lengths = fc.integer({ min: 0, max: 300 }).map((n) => 'x'.repeat(n));
        fc.assert(fc.property(fc.oneof(fillerArb, lengths), (filler) => {
          const fixture = [`RED: write a failing test. ${filler}`, `GREEN: make it pass. ${filler}`, 'REFACTOR: clean it up.'].join(' ');
          assert.equal(tdd.restatesCycleStructurally(fixture), true, 'no citation');
          const cited = `${fixture} tdd.md`;
          const past = tdd.measureCycleSpan(cited).span > THRESHOLD;
          assert.equal(tdd.restatesCycleStructurally(cited), past, 'a citation is a pointer unless the span is past the limit');
          if (past) pastLimit += 1;
          else withinLimit += 1;
        }));
        assert.ok(withinLimit > 0 && pastLimit > 0, `the property saw ${withinLimit} spans inside and ${pastLimit} past the limit`);
      });

      test('a citation of a later heading-bounded section is not borrowed', () => {
        const fixture = [
          'RED: write a failing test proving the bug exists and record it with a test-scoped commit.',
          'GREEN: implement the smallest change that makes the test pass and record that with a',
          'feat-scoped commit. REFACTOR: simplify the implementation now that it is proven correct,',
          'without changing observable behavior.',
          '',
          '## Unrelated Section',
          '',
          'This paragraph cites the canonical `gsd-core/references/tdd.md` reference for a completely',
          'different purpose and must not be borrowed by the restatement above.',
        ].join('\n');
        assert.ok(tdd.restatesCycleStructurally(fixture));
        assert.ok(tdd.restatesCycleStructurally(fixture.split('\n\n## Unrelated Section\n\n').join('\n## Unrelated Section\n')));
      });

      test('a citation of a later paragraph with no heading is not borrowed', () => {
        const fixture = [
          'RED: write a failing test. GREEN: make it pass. REFACTOR: clean it up.',
          '',
          'This unrelated paragraph mentions the canonical tdd.md reference for a totally different reason.',
        ].join('\n');
        assert.ok(tdd.restatesCycleStructurally(fixture));
        assert.ok(tdd.restatesCycleStructurally(fixture.split('\n\n').join('\n \t\n')));
      });

      test('a blank line followed by a list item is the same block: the execute-plan shape is a pointer', () => {
        const fixture = [
          'For `type: tdd` plans — RED-GREEN-REFACTOR:',
          '',
          '1. Some unrelated setup step.',
          '2. Execute the cycle exactly as the canonical `references/tdd.md` reference specifies.',
        ].join('\n');
        assert.equal(tdd.restatesCycleStructurally(fixture), false);
        for (const marker of ['- ', '* ', '1. ', '2) ']) {
          assert.equal(tdd.restatesCycleStructurally(`RED GREEN REFACTOR\n\n${marker}see tdd.md`), false, marker);
        }
        assert.equal(tdd.restatesCycleStructurally('RED GREEN REFACTOR\n\n-see tdd.md'), true);
      });

      test('the list marker grammar: a dash, a star or a number with a dot or a bracket, then a blank', () => {
        for (const line of ['- x', '* x', '1. x', '2) x', '  - x', '\t* x', '10) x', '-\tx', '- ']) assert.equal(tdd.isListMarkerLine(line), true, JSON.stringify(line));
        for (const line of ['-x', '*x', '1.x', '1 x', '. x', 'x - y', '', '-', '1.']) assert.equal(tdd.isListMarkerLine(line), false, JSON.stringify(line));
      });

      test('the halt reason must be a whole word on the Reason line before its closing brace', () => {
        for (const text of ['Reason: {impl_before_test}', 'Reason: {a | impl_before_test | b}', 'Reason: {impl_before_test', 'x Reason: {a}\nReason: {impl_before_test}']) assert.equal(tdd.namesHaltReason(text), true, text);
        assert.equal(tdd.namesHaltReason('Reason: {Reason: {impl_before_test}'), true);
        assert.equal(tdd.namesHaltReason('Reason: {Reason: {x}\nReason: {impl_before_test}'), true);
        assert.equal(tdd.namesHaltReason('Reason: {Reason: {impl_before_test_}'), false);
        for (const text of ['Reason: {impl_before_test_x}', 'Reason: {x_impl_before_test}', 'Reason: {a\nimpl_before_test}', 'Reason: {a} impl_before_test', 'impl_before_test', 'Reason: impl_before_test']) assert.equal(tdd.namesHaltReason(text), false, text);
      });

      test('the embed entry check names its three outcomes', () => {
        assert.equal(tdd.embedEntryProblem('a\n${TDD_APPLICABLE ? "- tdd.md" : ""}\nb'), true);
        assert.match(tdd.embedEntryProblem('a\n- tdd.md  # TDD_APPLICABLE\nb'), /the entry is not conditional: - tdd\.md {2}# TDD_APPLICABLE/);
        assert.equal(tdd.embedEntryProblem('tdd.md here\nTDD_APPLICABLE there'), 'no embed entry names tdd.md with TDD_APPLICABLE');
        assert.equal(tdd.embedEntryProblem('prose tdd.md and TDD_APPLICABLE\n${TDD_APPLICABLE ? "tdd.md" : ""}'), 'the entry is not conditional: prose tdd.md and TDD_APPLICABLE');
      });
    }

    // agent-classification-parity: every assertion has a mutation of the real docs, the alternatives of the prose counts are controls, and a roster that
    // loses or gains a file is a finding. These cases copy the agent roster and the two docs, so they run over the heavy file set.
    {
      const ACP = 'agent-classification-parity';
      const walkers = require('../scripts/static-checks/text-contracts/agent-classification-parity.cjs').walkers;
      const EXECUTOR_ROW = '| gsd-executor | Executes GSD plans with atomic commits and deviation handling. | `/gsd-execute-phase`, `/gsd-quick`, `/gsd-quick-batch` | primary |';
      const EXECUTOR_TOOLS_ROW = '| **Tools** | Read, Write, Edit, Bash, Grep, Glob, Skill, mcp__context7__*, mcp__plugin_context7_context7__* |';
      const PAREN = '(pattern-mapper, debug-session-manager,';
      const mutates = (title, rel, edit, expected) => someFinding(`mutation: ${title}`, [[rel, edit]], ACP, expected, true);

      mutates('a primary heading renamed: the primary count disagrees', AGENTS_MD, swap('\n### gsd-executor\n', '\n### executor\n'), 'the agents.md prose count of primary agents must equal the primary headings (the prose says 23 primary agents; 22 ### gsd-* headings');
      mutates('a primary heading renamed: the INVENTORY row now disagrees', AGENTS_MD, swap('\n### gsd-executor\n', '\n### executor\n'), 'gsd-executor: INVENTORY says "primary", agents.md placement says "inventory only"');
      mutates('an advanced heading renamed: the additional count disagrees', AGENTS_MD, swap('\n### gsd-pattern-mapper\n', '\n### pattern-mapper\n'), 'the prose says "thirteen additional shipped agents"; 12 ### gsd-* headings');
      mutates('an advanced heading renamed: the slug list disagrees', AGENTS_MD, swap('\n### gsd-pattern-mapper\n', '\n### pattern-mapper\n'), 'extra in the prose: ["pattern-mapper"]');
      mutates('the advanced section heading renamed', AGENTS_MD, swap('\n## Advanced and Specialized Agents\n', '\n## Other Agents\n'), 'agents.md must list the advanced agents as ### gsd-* headings inside');
      exactlyOne('an advanced section that lost its heading is exactly one finding', [[AGENTS_MD, swap('\n## Advanced and Specialized Agents\n', '\n## Other Agents\n')]], ACP, 'agents.md must list the advanced agents as ### gsd-* headings inside', true);
      exactlyOne('a primary section with no agent headings is exactly one finding', [[AGENTS_MD, swap('\n### gsd-', '\n### ')]], ACP, 'agents.md must list the primary agents as ### gsd-* headings before', true);
      test('an emptied agent file named by two headings is one finding for that file', (t) => {
        const root = copyOfRepoFiles(t, HEAVY);
        rewrite(root, AGENTS_MD, swap('\n### gsd-executor\n', '\n### gsd-executor\n\n### gsd-executor\n'));
        fs.writeFileSync(path.join(root, EXECUTOR), '');
        const findings = runShipped(root, [ACP]).filter((f) => f.file === EXECUTOR);
        assert.equal(findings.length, 1, messagesOf(findings));
        assert.match(findings[0].message, /the file is empty/);
      });
      mutates('the primary section emptied of agent headings', AGENTS_MD, swap('\n### gsd-', '\n### '), 'agents.md must list the primary agents as ### gsd-* headings before');
      mutates('an agent listed as both primary and advanced', AGENTS_MD, swap('\n## Advanced and Specialized Agents\n', '\n## Advanced and Specialized Agents\n\n### gsd-executor\n'), 'in both the primary and the advanced sections: ["gsd-executor"]');
      mutates('an advanced agent also listed in primary: the counts no longer add up', AGENTS_MD, swap('\n## Advanced and Specialized Agents\n', '\n### gsd-pattern-mapper\n\n## Advanced and Specialized Agents\n'), 'must add up to the shipped agent files');
      mutates('the primary agent count prose wrong', AGENTS_MD, swap('**23 primary agents**', '**22 primary agents**'), 'the prose says 22 primary agents; 23 ### gsd-* headings');
      mutates('the primary agent count prose missing', AGENTS_MD, swap('**23 primary agents**', '23 primary agents'), 'no "**N primary agents**" in the prose');
      mutates('the additional agent count prose wrong', AGENTS_MD, swap('Thirteen additional shipped agents', 'Twelve additional shipped agents'), 'the prose says "twelve additional shipped agents"; 13 ### gsd-* headings');
      mutates('the additional agent count a number nobody wrote a word for', AGENTS_MD, swap('Thirteen additional shipped agents', 'Fourteen additional shipped agents'), 'no "N additional shipped agents" in the prose');
      mutates('the additional agent count as a wrong digit', AGENTS_MD, swap('Thirteen additional shipped agents', '14 additional shipped agents'), 'the prose says "14 additional shipped agents"; 13 ### gsd-* headings');
      mutates('a slug missing from the parenthetical list', AGENTS_MD, swap(PAREN, '(debug-session-manager,'), 'missing from the prose: ["pattern-mapper"]');
      mutates('a slug added to the parenthetical list', AGENTS_MD, swap(PAREN, '(zed-agent, pattern-mapper, debug-session-manager,'), 'extra in the prose: ["zed-agent"]');
      mutates('the parenthetical list without its closing phrase', AGENTS_MD, swap(' have concise stubs', ' have short stubs'), 'no "(slug, slug, ...) have concise stubs" in the prose');
      mutates('the INVENTORY Primary doc value changed', INVENTORY_MD, swap(EXECUTOR_ROW, EXECUTOR_ROW.split('| primary |').join('| advanced stub |')), 'gsd-executor: INVENTORY says "advanced stub", agents.md placement says "primary"');
      mutates('an INVENTORY row removed', INVENTORY_MD, swap(`${EXECUTOR_ROW}\n`, ''), 'shipped agents with no INVENTORY row: ["gsd-executor"]');
      mutates('an INVENTORY row for an agent nobody ships', INVENTORY_MD, swap('| gsd-advisor-researcher | ', '| gsd-ghost | x | y | primary |\n| gsd-advisor-researcher | '), 'INVENTORY rows with no agents/gsd-*.md file: ["gsd-ghost"]');
      mutates('a compact variant row that is not marked compact', INVENTORY_MD, swap('| gsd-advisor-researcher.compact |', '| gsd-advisor-researcher.compactx |'), 'INVENTORY rows with no agents/gsd-*.md file: ["gsd-advisor-researcher.compactx"]');
      mutates('the executor Tools row differs from its frontmatter', AGENTS_MD, swap(EXECUTOR_TOOLS_ROW, '| **Tools** | Read, Write, Edit, Bash, Grep, Glob, Skill, mcp (context7) |'), 'says "Read, Write, Edit, Bash, Grep, Glob, Skill, mcp (context7)", the frontmatter says "Read, Write, Edit, Bash, Grep, Glob, Skill, mcp__context7__*, mcp__plugin_context7_context7__*"');
      mutates('the executor Tools row removed', AGENTS_MD, swap(`${EXECUTOR_TOOLS_ROW}\n`, ''), 'its agents.md section has no "| **Tools** |" row, so its parity assertion would vanish');
      mutates('the executor frontmatter drops Skill', EXECUTOR, inToolsLine((line) => line.split(', Skill').join('')), 'the frontmatter says "Read, Write, Edit, Bash, Grep, Glob, mcp__context7__*, mcp__plugin_context7_context7__*"');

      // Roster: a shipped file with no heading, a heading with no shipped file, files the roster ignores.
      test('a shipped agent with no heading and no INVENTORY row is a finding, not a count mismatch', (t) => {
        const root = copyOfRepoFiles(t, HEAVY);
        write(root, 'agents/gsd-newcomer.md', '---\nname: gsd-newcomer\n---\nbody\n');
        const findings = runShipped(root, [ACP]);
        assert.equal(findings.length, 1, messagesOf(findings));
        assert.ok(findings[0].message.includes('shipped agents with no INVENTORY row: ["gsd-newcomer"]'), messagesOf(findings));
      });
      test('a shipped agent with an inventory-only row and no heading holds the roster', (t) => {
        const root = copyOfRepoFiles(t, HEAVY);
        write(root, 'agents/gsd-newcomer.md', '---\nname: gsd-newcomer\n---\nbody\n');
        rewrite(root, INVENTORY_MD, swap('| gsd-advisor-researcher | ', '| gsd-newcomer | x | y | inventory only |\n| gsd-advisor-researcher | '));
        assert.deepEqual(runShipped(root, [ACP]), []);
      });
      test('an agent file that is gone leaves a phantom heading and a phantom row, two findings', (t) => {
        const root = copyOfRepoFiles(t, HEAVY);
        fs.unlinkSync(path.join(root, 'agents', 'gsd-intel-updater.md'));
        const findings = runShipped(root, [ACP]);
        assert.equal(findings.length, 2, messagesOf(findings));
        assert.ok(findings.some((f) => f.message.includes('INVENTORY rows with no agents/gsd-*.md file: ["gsd-intel-updater"]')), messagesOf(findings));
        assert.ok(findings.some((f) => f.message.includes('the classification counts must add up to the shipped agent files (primary(23) + advanced(13) + inventory-only(0) = 36, not the 35 agent files)')), messagesOf(findings));
      });
      for (const [name, text] of [['agents/gsd-extra.compact.md', 'compact\n'], ['agents/README.md', '# readme\n'], ['agents/notes.txt', 'x\n']]) {
        test(`${name} added to agents/ does not change the roster`, (t) => {
          const root = copyOfRepoFiles(t, HEAVY);
          write(root, name, text);
          assert.deepEqual(runShipped(root, [ACP]), []);
        });
      }
      test('a nested agents file is not part of the flat roster', (t) => {
        const root = copyOfRepoFiles(t, HEAVY);
        write(root, 'agents/sub/gsd-nested.md', 'x\n');
        assert.deepEqual(runShipped(root, [ACP]), []);
      });
      test('an agents directory with no gsd agents is one finding for the directory', (t) => {
        const root = copyOfRepoFiles(t, HEAVY);
        for (const name of fs.readdirSync(path.join(root, 'agents'))) fs.unlinkSync(path.join(root, 'agents', name));
        write(root, 'agents/README.md', '# readme\n');
        const findings = runShipped(root, [ACP]);
        assert.ok(findings.some((f) => f.message.includes('no agents/gsd-*.md files found')), messagesOf(findings));
      });
      test('a missing agents directory is a finding', (t) => {
        const root = copyOfRepoFiles(t, HEAVY);
        for (const name of fs.readdirSync(path.join(root, 'agents'))) fs.unlinkSync(path.join(root, 'agents', name));
        fs.rmdirSync(path.join(root, 'agents'));
        const findings = runShipped(root, [ACP]);
        assert.ok(findings.some((f) => /cannot read the directory/.test(f.message)), messagesOf(findings));
      });

      // Controls: the spellings the old patterns accepted.
      holds('the additional count as the digits of its word', [[AGENTS_MD, swap('Thirteen additional shipped agents', '13 additional shipped agents')]], ACP, true);
      holds('the additional count in capitals', [[AGENTS_MD, swap('Thirteen additional shipped agents', 'THIRTEEN additional shipped agents')]], ACP, true);
      holds('the additional count with the words split over lines and runs of blanks', [[AGENTS_MD, swap('Thirteen additional shipped agents', 'Thirteen  additional\n\tshipped   agent')]], ACP, true);
      holds('the additional count with a singular agent', [[AGENTS_MD, swap('additional shipped agents', 'additional shipped agent')]], ACP, true);
      holds('the primary count with a line break and runs of blanks', [[AGENTS_MD, swap('**23 primary agents**', '**23  primary\nagent**')]], ACP, true);
      holds('the slug list in capitals and with other blanks', [[AGENTS_MD, swap(PAREN, '(Pattern-Mapper ,  DEBUG-SESSION-MANAGER ,')]], ACP, true);
      holds('the slug list followed by a line break before the closing phrase', [[AGENTS_MD, swap(') have concise stubs', ')\n\thave concise stubs')]], ACP, true);
      holds('an executor tools: block sequence equal to its row', [[EXECUTOR, (text) => {
        const at = text.indexOf('\ntools:') + 1;
        const end = text.indexOf('\n', at);
        const items = text.slice(at + 'tools:'.length, end).trim().split(', ');
        return `${text.slice(0, at)}tools:\n${items.map((item) => `  - ${item}`).join('\n')}${text.slice(end)}`;
      }]], ACP, true);
      holds('an executor with no tools: key has nothing to agree with', [[EXECUTOR, (text) => {
        const at = text.indexOf('\ntools:') + 1;
        return text.slice(0, at) + text.slice(text.indexOf('\n', at) + 1);
      }]], ACP, true);
      holds('the advanced section followed by a later h2 whose agent headings are ignored', [[AGENTS_MD, append('## Appendix\n\n### gsd-appendix-agent\n')]], ACP, true);
      holds('a primary heading with trailing blanks', [[AGENTS_MD, swap('\n### gsd-executor\n', '\n###\tgsd-executor \t\n')]], ACP, true);

      // Loader seams: a frontmatter library that cannot be loaded, and one whose parser throws.
      test('a frontmatter library that cannot be loaded is one finding of the agent-classification-parity contract', (t) => {
        const findings = seamRun(t, ACP, "(ctx) => real.check(ctx, () => { throw new Error('no build'); })", true);
        assert.equal(findings.length, 1, messagesOf(findings));
        assert.equal(findings[0].file, 'gsd-core/bin/lib/frontmatter.cjs');
        assert.match(findings[0].message, /frontmatter\.cjs cannot be loaded: no build/);
      });
      test('a frontmatter parser that throws is one finding for each agent section it reads', (t) => {
        const findings = seamRun(t, ACP, "(ctx) => real.check(ctx, () => ({ parseFrontmatter() { throw new Error('boom'); } }))", true);
        assert.ok(findings.length > 0 && findings.every((f) => f.message.includes('the frontmatter cannot be parsed: boom')), messagesOf(findings));
        assert.equal(new Set(findings.map((f) => f.file)).size, findings.length, 'one finding per agent file');
      });

      // The roster rule is the shared test helper's rule (tests/helpers/agent-roster.cjs), which a shipped contract cannot require.
      test('the contract roster equals the helper roster on the real agents/ directory', () => {
        const { listAgentFiles } = require('./helpers/agent-roster.cjs');
        const listed = fs.readdirSync(path.join(REPO_ROOT, 'agents')).filter((name) => name.endsWith('.md')).sort().map((name) => `agents/${name}`);
        assert.deepEqual([...walkers.rosterOf(listed)].sort(), listAgentFiles(path.join(REPO_ROOT, 'agents')));
      });
      test('property: the contract roster equals the helper roster on random directories', (t) => {
        const fc = require('./helpers/fast-check-setup.cjs');
        const { listAgentFiles } = require('./helpers/agent-roster.cjs');
        const names = ['gsd-a.md', 'gsd-b.md', 'gsd-a.compact.md', 'gsd-c.compact.md', 'README.md', 'notes.txt', 'gsd-d.txt', 'x.md', 'gsd-.md', 'gsd-e.md.bak', 'GSD-f.md', 'gsd-g.compact.md.md'];
        let nonEmpty = 0;
        let empty = 0;
        fc.assert(fc.property(fc.subarray(names), (subset) => {
          const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-roster-'));
          t.after(() => cleanup(dir));
          for (const name of subset) fs.writeFileSync(path.join(dir, name), 'x\n');
          const expected = listAgentFiles(dir);
          assert.deepEqual([...walkers.rosterOf([...subset].sort().filter((name) => name.endsWith('.md')).map((name) => `agents/${name}`))].sort(), expected, JSON.stringify(subset));
          if (expected.length > 0) nonEmpty += 1;
          else empty += 1;
        }), { numRuns: 40 });
        assert.ok(nonEmpty > 0 && empty > 0, `the property saw ${nonEmpty} non-empty and ${empty} empty rosters`);
      });

      // The parsers on small documents.
      test('agent headings are classified by the section they sit in, and a later h2 ends the advanced region', () => {
        const doc = ['# Title', '## Overview', '### gsd-a', '## Advanced and Specialized Agents', '### gsd-b', '### gsd-c extra', '#### gsd-d', '## Appendix', '### gsd-e',
          '## Advanced and Specialized Agents', '### gsd-f'].join('\n');
        assert.deepEqual(walkers.parseAgentsMd(doc), { primaryHeadings: ['gsd-a'], advancedHeadings: ['gsd-b', 'gsd-f'] });
        assert.deepEqual(walkers.parseAgentsMd('### gsd-a\r\n## Advanced and Specialized Agents\r\n### gsd-b\r\n'), { primaryHeadings: ['gsd-a'], advancedHeadings: ['gsd-b'] });
      });
      test('the slug list is lower-cased in ASCII only: a Kelvin sign stays itself', () => {
        assert.deepEqual(walkers.parentheticalSlugs('(\u212a, B) have concise stubs'), ['\u212a', 'b']);
      });
      test('the INVENTORY table is read between its Agents heading and the next h2, by the Primary doc column', () => {
        const doc = ['## Agents (3 shipped)', '', '| Agent | Role | Primary doc |', '|---|---|---|', '| gsd-a | r | primary |', '| gsd-b | | advanced stub |',
          '| gsd-b.compact | r | inventory only |', '| other | r | primary |', '| gsd-c |', '## Commands', '| gsd-z | r | primary |'].join('\n');
        assert.deepEqual([...walkers.parseInventoryMd(doc)], [['gsd-a', 'primary'], ['gsd-b', 'advanced stub']]);
        assert.equal(walkers.parseInventoryMd('## Agents\n| gsd-a | r | primary |\n'), null);
        assert.equal(walkers.parseInventoryMd('## Roster\n| Agent | Primary doc |\n| gsd-a | primary |\n'), null);
        assert.equal(walkers.parseInventoryMd('## Agentsx\n| Agent | Primary doc |\n| gsd-a | primary |\n'), null);
      });
      test('the Tools rows of the sections are found and the first one of a section wins', () => {
        const doc = ['### gsd-a', '| **Tools** | Read, Bash |', '| **Tools** | x |', '### gsd-b', 'text', '### gsd-c', '|  **Tools**  |   a | b  | ', '| **Tools** | open'].join('\r\n');
        assert.deepEqual(walkers.toolsSections(doc), [
          { slug: 'gsd-a', row: { value: 'Read, Bash', line: 2 } },
          { slug: 'gsd-b', row: null },
          { slug: 'gsd-c', row: { value: 'a | b', line: 7 } },
        ]);
      });
    }

    // mcp-tool-inheritance: every assertion has a mutation of the real agents, the alternatives of the guidance check are controls, the agent count is
    // pinned at 19, 20 and 21, and the grant parser keeps the negative controls of the old test. These cases copy the whole agent roster.
    {
      const MCP = 'mcp-tool-inheritance';
      const mcp = require('../scripts/static-checks/text-contracts/mcp-tool-inheritance.cjs').walkers;
      const frontmatter = require('../gsd-core/bin/lib/frontmatter.cjs');
      const PLANNER = 'agents/gsd-planner.md';
      const PLAN_CHECKER = 'agents/gsd-plan-checker.md';
      const RESEARCHERS = ['agents/gsd-project-researcher.md', 'agents/gsd-phase-researcher.md', 'agents/gsd-ui-researcher.md'];
      const STEP_C = ['agents/gsd-phase-researcher.md', 'agents/gsd-project-researcher.md'];
      const REQUIRED = ['mcp__context7__*', 'mcp__exa__*', 'mcp__firecrawl__*', 'mcp__tavily__*', 'mcp__ref__*', 'mcp__jina__*'];
      const mutates = (title, rel, edit, expected) => someFinding(`mutation: ${title}`, [[rel, edit]], MCP, expected, true);
      const stripGuidance = (text) => text.split(/mcp/gi).join('xyz').split('context7').join('xyz').split('available tools').join('xyz');
      const whole = (text) => () => text;

      // The guidance of the executor and the planner: each alternative alone is enough, and none is a finding.
      exactlyOne('an executor that loses every mention of MCP is exactly one finding', [[EXECUTOR, stripGuidance]], MCP, 'gsd-executor.md should mention MCP tool availability/usage', true);
      mutates('the planner loses every mention of MCP', PLANNER, stripGuidance, 'gsd-planner.md should mention MCP tool availability/usage');
      for (const [text, ok] of [['mcp', true], ['MCP', true], ['mCp', true], ['x context7 x', true], ['the available tools of the runtime', true], ['Context7', false], ['Available tools', false], ['m c p', false]]) {
        test(`a planner whose text is ${JSON.stringify(text)} ${ok ? 'mentions MCP' : 'does not mention MCP'}`, (t) => {
          const findings = runEdits(t, [[PLANNER, whole(text)]], MCP, true);
          if (ok) assert.deepEqual(findings, []);
          else {
            assert.equal(findings.length, 1, messagesOf(findings));
            assert.ok(findings[0].message.includes('gsd-planner.md should mention MCP tool availability/usage'));
          }
        });
      }
      for (const [text, findingsOf] of [['MCP', []], ['mcp__', []], ['mcp', ['should reference MCP tools']], ['context7', ['should reference MCP tools']], ['', ['the file is empty']]]) {
        test(`an executor whose text is ${JSON.stringify(text)} is ${findingsOf.length === 0 ? 'accepted' : 'one finding'}`, (t) => {
          const findings = runEdits(t, [[EXECUTOR, whole(text)]], MCP, true);
          assert.equal(findings.length, findingsOf.length, messagesOf(findings));
          findingsOf.forEach((expected, i) => assert.ok(findings[i].message.includes(expected), messagesOf(findings)));
        });
      }

      // The tools: line of the researchers: missing is one finding, every required grant is needed, order and blanks are free.
      for (const rel of RESEARCHERS) {
        exactlyOne(`${rel} without a tools: line is exactly one finding`, [[rel, swap('\ntools:', '\ntoolz:')]], MCP, 'must have a tools: frontmatter line', true);
        for (const tool of REQUIRED) {
          mutates(`${rel} without ${tool}`, rel, inToolsLine((line) => line.split(tool).join('')), `missing ${tool}`);
        }
        exactlyOne(`${rel} whose frontmatter lost tools: while its body carries the line is exactly one finding`, [[rel, (text) => {
          const at = text.indexOf('\ntools:') + 1;
          const end = text.indexOf('\n', at);
          return `${text.slice(0, at)}toolz:${text.slice(at + 'tools:'.length, end)}${text.slice(end)}\n${text.slice(at, end)}\n`;
        }]], MCP, 'must have a tools: frontmatter line', true);
        holds(`${rel} with its tools reversed and padded is accepted`, [[rel, inToolsLine((line) => `tools:      ${line.slice('tools:'.length).trim().split(', ').reverse().join(', ')}   `)]], MCP, true);
      }
      mutates('a researcher without two required tools names both', RESEARCHERS[1], inToolsLine((line) => line.split('mcp__exa__*').join('').split('mcp__jina__*').join('')), 'missing mcp__exa__*, mcp__jina__*');

      // The Step-C dispatch table: every provider is granted, the section and the table must exist.
      for (const rel of STEP_C) {
        mutates(`${rel} without the perplexity grant of its Step-C table`, rel, inToolsLine((line) => line.split(', mcp__perplexity__*').join('')), 'not granted in tools: frontmatter: perplexity');
        mutates(`${rel} without the tavily grant of its Step-C table`, rel, inToolsLine((line) => line.split('mcp__tavily__*').join('')), 'not granted in tools: frontmatter: tavily');
        exactlyOne(`${rel} without its Step-C section is exactly one finding`, [[rel, swap('### Step C', '### Step D')]], MCP, 'no "### Step C" section', true);
        exactlyOne(`${rel} whose Step-C table lost its pipes is exactly one finding`, [[rel, within('### Step C', '\n### ', (text) => text.split('|').join(' '))]], MCP, 'the table references no mcp__ provider', true);
        mutates(`${rel} with a new provider in the Step-C table`, rel, within('### Step C', '\n### ', append('| `new` | `mcp__newprov__*` |')), 'not granted in tools: frontmatter: newprov');
        holds(`${rel} with a prose placeholder and a plugin namespace outside the table rows is accepted`, [[rel, within('### Step C', '\n### ', append('Use `mcp__<provider>__*` for any other provider, or `mcp__plugin_context7_context7__query`.'))]], MCP, true);
        holds(`${rel} with a table row naming a plugin namespace is accepted`, [[rel, within('### Step C', '\n### ', append('| `p` | `mcp__plugin_context7_context7__query` |'))]], MCP, true);
        holds(`${rel} with its table in capitals is accepted`, [[rel, within('### Step C', '\n### ', swap('`mcp__exa__web_search_exa`', '`MCP__EXA__web_search_exa`'))]], MCP, true);
      }

      // An agent that documents an MCP namespace its allowlist withholds (#2526), through the real roster.
      for (const [body, server] of [['Use mcp__playwright__navigate() here.', 'playwright'], ['mcp__chrome-devtools__take_screenshot()', 'chrome-devtools'], ['For any provider `SERVER`: use `mcp__SERVER__*`.', 'server'], ['mcp__ab__foo()', 'ab'], ['mcp__a_b__foo()', 'a_b']]) {
        exactlyOne(`${PLAN_CHECKER} documenting ${JSON.stringify(body)} is exactly one finding`, [[PLAN_CHECKER, append(body)]], MCP, `documents mcp__${server}__* but its tools: allowlist grants none of them`, true);
      }
      for (const body of ['the mcp__playwright server', 'use `mcp__<SERVER>__*` when configured', 'For any other provider id `X`: use `mcp__X__*` if available', 'mcp____foo()', 'Use Write and Bash to Edit the file']) {
        holds(`${PLAN_CHECKER} documenting ${JSON.stringify(body)} is accepted`, [[PLAN_CHECKER, append(body)]], MCP, true);
      }
      exactlyOne(`${PLAN_CHECKER} naming a namespace in its description is exactly one finding`, [[PLAN_CHECKER, within('name: gsd-plan-checker', '\ntools:', swap('description: ', 'description: mcp__playwright__x '))]], MCP, 'documents mcp__playwright__*', true);
      exactlyOne(`${PLAN_CHECKER} whose grant is commented out is exactly one finding`, [[PLAN_CHECKER, (text) => inToolsLine((line) => `${line} # mcp__playwright__*`)(`${text}\nmcp__playwright__navigate()\n`)]], MCP, 'documents mcp__playwright__*', true);
      for (const grant of ['mcp__playwright__*', 'mcp__playwright__navigate', 'mcp__playwright', 'mcp__*']) {
        holds(`${PLAN_CHECKER} granted ${grant} may document the playwright namespace`, [[PLAN_CHECKER, (text) => inToolsLine((line) => `${line}, ${grant}`)(`${text}\nmcp__playwright__navigate()\n`)]], MCP, true);
      }
      exactlyOne(`${PLAN_CHECKER} granted a bare mcp__ without a wildcard is one finding`, [[PLAN_CHECKER, (text) => inToolsLine((line) => `${line}, mcp__`)(`${text}\nmcp__playwright__navigate()\n`)]], MCP, 'documents mcp__playwright__*', true);
      exactlyOne(`${PLAN_CHECKER} granted MCP__PLAYWRIGHT__* in capitals is one finding: a grant must start with mcp__ in lower case`, [[PLAN_CHECKER, (text) => inToolsLine((line) => `${line}, MCP__PLAYWRIGHT__*`)(`${text}\nmcp__playwright__navigate()\n`)]], MCP, 'documents mcp__playwright__*', true);
      holds('an agent with no tools: key inherits everything and documents any namespace', [[PLAN_CHECKER, (text) => `${text.split('\ntools:').join('\ntoolz:')}\nmcp__playwright__navigate()\n`]], MCP, true);

      // The roster: 20 agents are the minimum; a nested file is outside the flat roster.
      for (const [count, ok] of [[19, false], [20, true], [21, true]]) {
        test(`an agents directory of ${count} files ${ok ? 'satisfies' : 'is below the minimum of'} the mcp-tool-inheritance contract`, (t) => {
          const root = copyOfRepoFiles(t, HEAVY);
          const keep = new Set([EXECUTOR, PLANNER, ...RESEARCHERS].map((rel) => path.basename(rel)));
          const others = fs.readdirSync(path.join(root, 'agents')).filter((name) => !keep.has(name)).sort();
          for (const name of others.slice(count - keep.size)) fs.unlinkSync(path.join(root, 'agents', name));
          assert.equal(fs.readdirSync(path.join(root, 'agents')).length, count);
          const findings = runShipped(root, [MCP]);
          if (ok) assert.deepEqual(findings, []);
          else {
            assert.equal(findings.length, 1, messagesOf(findings));
            assert.ok(findings[0].message.includes('expected agents/ to hold the agent definitions, found 19 (at least 20)'), messagesOf(findings));
          }
        });
      }
      test('a nested agents file is outside the flat roster, a flat one is checked', (t) => {
        const root = copyOfRepoFiles(t, HEAVY);
        const body = '---\nname: x\ntools: Read\n---\nmcp__playwright__navigate()\n';
        write(root, 'agents/sub/gsd-nested.md', body);
        assert.deepEqual(runShipped(root, [MCP]), []);
        write(root, 'agents/gsd-flat.md', body);
        const findings = runShipped(root, [MCP]);
        assert.equal(findings.length, 1, messagesOf(findings));
        assert.equal(findings[0].file, 'agents/gsd-flat.md');
      });

      // Loader seams.
      test('a frontmatter library that cannot be loaded is one finding of the mcp-tool-inheritance contract', (t) => {
        const findings = seamRun(t, MCP, "(ctx) => real.check(ctx, () => { throw new Error('no build'); })", true);
        assert.equal(findings.length, 1, messagesOf(findings));
        assert.equal(findings[0].file, 'gsd-core/bin/lib/frontmatter.cjs');
        assert.match(findings[0].message, /frontmatter\.cjs cannot be loaded: no build/);
      });
      test('a frontmatter parser that throws is one finding for each agent', (t) => {
        const findings = seamRun(t, MCP, "(ctx) => real.check(ctx, () => ({ parseFrontmatter() { throw new Error('boom'); } }))", true);
        assert.ok(findings.length > 20 && findings.every((f) => f.message.includes('the frontmatter cannot be parsed: boom')), messagesOf(findings));
        assert.equal(new Set(findings.map((f) => f.file)).size, findings.length, 'one finding per agent file');
      });
      test('a grant parser that matches nothing is one finding, not one per agent', (t) => {
        const findings = seamRun(t, MCP, "(ctx) => real.check(ctx, () => ({ parseFrontmatter: () => ({ tools: 'Read' }), stripFrontmatter: () => '' }))", true);
        assert.equal(findings.length, 1, messagesOf(findings));
        assert.match(findings[0].message, /no agent grants any mcp__ namespace: the grant parser is not matching/);
      });

      // The negative controls of the old test, on the exported check.
      {
        const agent = (fm, body) => ['---', ...fm, '---', '', ...body].join('\n');
        const ungranted = (fm, body) => mcp.ungrantedServers(agent(fm, body), frontmatter).ungranted;
        const cases = [
          ['the #2526 shape: an MCP block under an MCP-less allowlist', ['name: gsd-ui-auditor', 'tools: Read, Write, Bash, Grep, Glob, Skill'], ['Check whether `mcp__playwright__*` tools are available in this session.', 'mcp__playwright__navigate(url="http://localhost:3000")'], ['playwright']],
          ['the same body once the namespace is granted', ['name: a', 'tools: Read, mcp__playwright__*'], ['mcp__playwright__navigate(url="http://localhost:3000")'], []],
          ['an exact-tool grant covers its server', ['name: a', 'tools: mcp__playwright__navigate'], ['mcp__playwright__screenshot(name="desktop")'], []],
          ['a bare server-wide grant', ['name: a', 'tools: Read, mcp__playwright'], ['mcp__playwright__navigate()'], []],
          ['a bare mcp__* wildcard grants every server', ['name: a', 'tools: Read, mcp__*'], ['mcp__playwright__navigate()', 'mcp__chrome-devtools__take_screenshot()'], []],
          ['a run of stars is still a wildcard', ['name: a', 'tools: Read, mcp__***'], ['mcp__playwright__navigate()'], []],
          ['a bare mcp__ without a wildcard is a typo', ['name: a', 'tools: Read, mcp__'], ['mcp__playwright__navigate()'], ['playwright']],
          ['a block-sequence tools: list', ['name: a', 'tools:', '  - Read', '  - mcp__context7__*', 'color: pink'], ['Use mcp__context7__resolve-library-id, never mcp__tavily__search.'], ['tavily']],
          ['a flow array', ['name: a', 'tools: [Read, mcp__context7__*]'], ['mcp__context7__get-library-docs()'], []],
          ['a quoted scalar', ['name: a', 'tools: "Read, mcp__playwright__*"'], ['mcp__playwright__navigate()'], []],
          ['server ids with hyphens', ['name: a', 'tools: Read'], ['mcp__chrome-devtools__take_screenshot()'], ['chrome-devtools']],
          ['a commented-out grant on a full line', ['name: a', 'tools: Read', '# tools: mcp__playwright__*'], ['mcp__playwright__navigate()'], ['playwright']],
          ['a commented-out grant after the value', ['name: a', 'tools: Read # mcp__playwright__* withheld'], ['mcp__playwright__navigate()'], ['playwright']],
          ['a bare prose mention of a server', ['name: a', 'tools: Read'], ['Screenshots come from the mcp__playwright server when configured.'], []],
          ['built-in tool names in prose', ['name: a', 'tools: Read'], ['Use Write and Bash to Edit the file, then Grep and Glob for the results.'], []],
          ['a one-character metavariable', ['name: a', 'tools: Read, mcp__exa__*'], ['For any other provider id `X`: use `mcp__X__*` if available, else WebSearch.'], []],
          ['the angle-bracket placeholder', ['name: a', 'tools: Read'], ['For any provider: use `mcp__<SERVER>__*` when it is configured.'], []],
          ['a bare all-caps placeholder', ['name: a', 'tools: Read'], ['For any provider `SERVER`: use `mcp__SERVER__*` when configured.'], ['server']],
          ['a two-character server id', ['name: a', 'tools: Read'], ['mcp__ab__foo()'], ['ab']],
          ['a zero-length server id', ['name: a', 'tools: Read'], ['mcp____foo()'], []],
          ['an ungranted namespace in the description', ['name: a', 'description: Captures screens via mcp__playwright__navigate.', 'tools: Read'], ['The body names no MCP tool at all.'], ['playwright']],
          ['the tools: line is never read as a body reference', ['name: a', 'tools: Read, mcp__context7__*'], ['No MCP call appears in this body.'], []],
          ['an agent with no tools: key inherits everything', ['name: a'], ['mcp__playwright__navigate()'], []],
          ['an underscore inside a server id', ['name: a', 'tools: Read'], ['mcp__a_b__foo() and mcp__a-b__bar()'], ['a-b', 'a_b']],
          ['a grant in capitals is no grant, and a reference in capitals is lower-cased', ['name: a', 'tools: Read, MCP__Exa__*'], ['mcp__EXA__search() mcp__Tavily__x()'], ['exa', 'tavily']],
        ];
        for (const [title, fm, body, expected] of cases) test(title, () => assert.deepEqual(ungranted(fm, body), expected));
        test('a missing tools: key reports no tokens, a commented value reports the value without the comment', () => {
          assert.equal(mcp.ungrantedServers(agent(['name: a'], ['x']), frontmatter).tokens, null);
          assert.deepEqual(mcp.ungrantedServers(agent(['name: a', 'tools: Read, Bash # mcp__x__*'], ['x']), frontmatter).tokens, ['Read', 'Bash']);
        });
      }
    }

    // Properties: each walker against the pattern or loop it replaced, copied below as the oracle. The generators draw random tokens and chains of the
    // pattern's own parts (each part sometimes cut short, with padding), and every property fails unless it saw both an accepted and a rejected string,
    // so it can never compare false with false. Domains: the lower-casing of a grant token is ASCII-only in the walk (the old code used toLowerCase, which
    // folds the Kelvin sign to k), so grant tokens carry no non-ASCII letters; every other difference is stated in the ADR.
    {
      const fc = require('./helpers/fast-check-setup.cjs');
      const adr218 = require('../scripts/static-checks/text-contracts/adr-218-release-version-validation.cjs').walkers;
      const tdd = require('../scripts/static-checks/text-contracts/tdd-single-statement.cjs').walkers;
      const mcp = require('../scripts/static-checks/text-contracts/mcp-tool-inheritance.cjs').walkers;
      const acp = require('../scripts/static-checks/text-contracts/agent-classification-parity.cjs').walkers;
      const frontmatter = require('../gsd-core/bin/lib/frontmatter.cjs');
      const strings = (tokens, maxLength = 10) => fc.array(fc.constantFrom(...tokens), { maxLength }).map((parts) => parts.join(''));
      // The parts in order, each cut short one time in five, with a gap and 0..260 filler characters after it.
      const chain = (parts, gaps, maxPad = 40) => fc.tuple(...parts.map(() => fc.tuple(fc.integer({ min: 0, max: 4 }), fc.constantFrom(...gaps), fc.oneof({ weight: 5, arbitrary: fc.constant(0) }, { weight: 1, arbitrary: fc.integer({ min: 1, max: maxPad }) }))))
        .map((picks) => picks.map(([cut, gap, pad], i) => (cut === 0 && parts[i].length > 1 ? parts[i].slice(0, -1) : parts[i]) + gap + 'x'.repeat(pad)).join(''));
      // The parts as whole lines in order, each cut short one time in five, with up to two filler lines after each.
      const lineChain = (parts, fillers) => fc.tuple(...parts.map(() => fc.tuple(fc.integer({ min: 0, max: 4 }), fc.array(fc.constantFrom(...fillers), { maxLength: 2 }))))
        .map((picks) => picks.map(([cut, extra], i) => [cut === 0 ? parts[i].slice(0, -1) : parts[i], ...extra].join('\n')).join('\n'));
      const lines = (parts, maxLength = 9) => fc.array(fc.constantFrom(...parts), { maxLength }).map((items) => items.join('\n'));
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
      const sorted = (set) => [...set].sort();

      test('property: the adr-218 grep -qE walk agrees with the pattern it replaced', () => {
        const old = (text) => [...text.matchAll(/grep\s+-qE\s+(?:'([^']+)'|"([^"]+)")/g)].map((m) => (m[1] !== undefined ? m[1] : m[2]));
        agrees('grep patterns', fc.oneof(strings(['grep', '-qE', ' ', '\n', "'", '"', 'x', '^[0-9]', '\t', '\u00a0'], 10), chain(['grep', '-qE', "'^a'", ' && grep', '-qE', '"b"'], blanks, 5)),
          (s) => [adr218.extractGrepPatterns(s), old(s)]);
      });

      test('property: the tdd detector walks agree with the patterns and loops they replaced', () => {
        const LIST_MARKER_RE = /^\s*(?:[-*]|\d+[.)])\s/;
        const WORDS = { RED: /\bRED\b/, GREEN: /\bGREEN\b/, REFACTOR: /\bREFACTOR\b/ };
        agrees('list marker', fc.oneof(strings(['-', '*', '1', '23', '.', ')', ' ', '\t', '\u00a0', '\n', 'x', '\u2028'], 7), chain(['  ', '-', ' ', 'x'], blanks, 3)), (s) => [tdd.isListMarkerLine(s), LIST_MARKER_RE.test(s)]);
        agrees('word', fc.tuple(fc.constantFrom('RED', 'GREEN', 'REFACTOR'), fc.oneof(strings(['RED', 'GREEN', 'REFACTOR', 'RE', '_', 'x', '1', ' ', '-', '\n', 'red', 'REDX'], 8), chain(['RED', 'GREEN', 'REFACTOR'], ['', ' ', '_', 'x', '-', '1']))),
          ([word, s]) => [tdd.hasWord(s, word), WORDS[word].test(s)]);
        const oldRestates = (text) => {
          const red = text.indexOf('commit: `test({phase}-{plan})');
          if (red === -1) return false;
          return text.indexOf('commit: `feat({phase}-{plan})', red) !== -1 || text.indexOf('commit: `fix({phase}-{plan})', red) !== -1;
        };
        agrees('literal commit lines', fc.oneof(strings(['commit: `test({phase}-{plan})', 'commit: `feat({phase}-{plan})', 'commit: `fix({phase}-{plan})', 'commit: `test({phase}-{plan}', ' ', '\n', 'x'], 6),
          chain(['commit: `test({phase}-{plan})', 'commit: `feat({phase}-{plan})'], ['', ' ', '\n'])), (s) => [tdd.restatesCycle(s), oldRestates(s)]);
        const oldMeasure = (text) => {
          const redIdx = text.search(/\bRED\b/);
          if (redIdx === -1) return null;
          const greenRel = text.slice(redIdx).search(/\bGREEN\b/);
          if (greenRel === -1) return null;
          const greenIdx = redIdx + greenRel;
          const refactorRel = text.slice(greenIdx).search(/\bREFACTOR\b/);
          if (refactorRel === -1) return null;
          const refactorIdx = greenIdx + refactorRel;
          return { redIdx, greenIdx, refactorIdx, refactorEndIdx: refactorIdx + 'REFACTOR'.length, span: refactorIdx - redIdx };
        };
        const cycleParts = ['RED', 'GREEN', 'REFACTOR', 'tdd.md', 'canonical', 'references/tdd', 'x', ' ', '.', '\n', '\n\n', '## H', '\n#', '- ', '1. ', '2) ', '* ', '\t', 'RED:', ' GREEN '];
        const cycleText = fc.oneof(strings(cycleParts, 14), chain(['RED', 'GREEN', 'REFACTOR', 'tdd.md'], ['', ' ', '\n', '\n\n', '\n- '], 260), lineChain(['- RED a', '- GREEN b', '- REFACTOR c', 'see tdd.md'], ['', '- x', 'text', '## H']));
        agrees('cycle span', cycleText, (s) => [tdd.measureCycleSpan(s), oldMeasure(s)], (expected) => expected !== null);
        const oldBoundary = (text, fromIdx, capIdx) => {
          const region = text.slice(fromIdx, capIdx);
          const BLANK_RE = /\n[ \t]*\n/g;
          let m;
          while ((m = BLANK_RE.exec(region))) {
            const afterBlank = region.slice(m.index + m[0].length);
            const nextLine = afterBlank.slice(0, afterBlank.indexOf('\n') === -1 ? undefined : afterBlank.indexOf('\n'));
            if (LIST_MARKER_RE.test(nextLine)) continue;
            return fromIdx + m.index;
          }
          return -1;
        };
        agrees('blank-line boundary', fc.tuple(fc.oneof(strings(['\n', ' ', '\t', '- ', '1. ', 'x', '\n\n', '*', ')'], 12), lines(['', ' ', '\t', '- a', '1. a', 'text', '  * b', '2) c'], 10)), fc.integer({ min: 0, max: 30 }), fc.integer({ min: 0, max: 60 })),
          ([text, from, cap]) => [tdd.findListAwareBlankBoundary(text, from, cap), oldBoundary(text, from, cap)], (expected) => expected !== -1);
        const oldStructural = (text) => {
          const cycle = oldMeasure(text);
          if (!cycle) return false;
          const cappedEnd = Math.min(text.length, cycle.refactorEndIdx + 500);
          const region = text.slice(cycle.refactorEndIdx, cappedEnd);
          const headingMatch = region.match(/\n#/);
          const headingEnd = headingMatch ? cycle.refactorEndIdx + headingMatch.index : cappedEnd;
          const blankBoundary = oldBoundary(text, cycle.refactorEndIdx, cappedEnd);
          const windowEnd = Math.min(headingEnd, blankBoundary === -1 ? cappedEnd : blankBoundary);
          if (!/tdd\.md|references\/tdd|canonical/.test(text.slice(cycle.redIdx, windowEnd))) return true;
          if (cycle.span > 200) return true;
          const segLines = text.slice(cycle.redIdx, cycle.refactorEndIdx).split('\n');
          const own = (word) => segLines.findIndex((l) => LIST_MARKER_RE.test(l) && WORDS[word].test(l));
          const redLine = own('RED');
          const greenLine = own('GREEN');
          const refactorLine = own('REFACTOR');
          if (redLine === -1 || greenLine === -1 || refactorLine === -1) return false;
          return redLine !== greenLine && greenLine !== refactorLine && redLine !== refactorLine;
        };
        agrees('structural restatement', cycleText, (s) => [tdd.restatesCycleStructurally(s), oldStructural(s)]);
        const listShaped = lineChain(['RED', '- RED a', '- GREEN b', '- REFACTOR c tdd.md'], ['', '- x', 'text', '1. RED', '2) GREEN']);
        agrees('structural restatement over list-shaped text', listShaped, (s) => [tdd.restatesCycleStructurally(s), oldStructural(s)]);
        agrees('halt reason', fc.oneof(strings(['Reason: {', 'impl_before_test', '}', '\n', ' ', '|', 'x', '_', 'impl_before_tes', '-'], 9), chain(['Reason: {', 'impl_before_test', '}'], ['', ' ', '|', '_', 'x', '\n', '}'], 3), chain(['Reason: {', 'Reason: {', 'impl_before_test', '}'], ['', ' ', '|', '_', 'x', '\n', '}'], 260), chain(['Reason: {', 'x', 'impl_before_test'], ['', ' ', '|', '_', '\n'], 260)),
          (s) => [tdd.namesHaltReason(s), /Reason: \{[^}\n]*\bimpl_before_test\b/.test(s)]);
        const oldEmbed = (text) => {
          const line = text.split('\n').find((l) => /tdd\.md/.test(l) && /TDD_APPLICABLE/.test(l));
          return Boolean(line) && /TDD_APPLICABLE \?/.test(line);
        };
        agrees('embed entry', fc.oneof(strings(['tdd.md', 'TDD_APPLICABLE', 'TDD_APPLICABLE ?', ' ', '\n', 'x', '${', '}'], 8), lineChain(['a tdd.md TDD_APPLICABLE', '${TDD_APPLICABLE ? "tdd.md" : ""}'], ['', 'x', 'tdd.md'])),
          (s) => [tdd.embedEntryProblem(s) === true, oldEmbed(s)], (expected) => expected);
      });

      test('property: the mcp-tool-inheritance walks agree with the patterns and loops they replaced', () => {
        agrees('tools line', fc.oneof(strings(['tools:', ' ', '\n', '\r', '\u2028', '\u2029', 'x', 'a, b', '\t', '\u00a0', '#', 'tools: '], 9), chain(['tools:', 'Read'], [' ', '', '\n', '\r\n', ' \u00a0', '\u2028', '\n\n'], 3)),
          (s) => [mcp.toolsLine(s), (s.match(/^tools:\s*(.+)$/m) || [])[1] ?? null], (expected) => expected !== null);
        const oldServers = (text) => {
          const servers = new Set();
          const re = /mcp__([a-z0-9]+)__/gi;
          let m;
          while ((m = re.exec(text)) !== null) servers.add(m[1].toLowerCase());
          return [...servers].sort();
        };
        const serverTokens = ['mcp__', '__', 'MCP__', 'a', 'B', '1', 'ab', '_', '-', ' ', '\n', 'x', 'K', '*', 'mcp__ab__', 'Mcp__Cd__'];
        agrees('mcp servers', fc.oneof(strings(serverTokens, 9), chain(['mcp__', 'ab', '__', 'mcp__', 'cd', '__'], ['', '_', 'x', ' ', '-'], 3)), (s) => [sorted(mcp.mcpServersIn(s)), oldServers(s)]);
        const oldStepC = (content) => {
          const start = content.indexOf('### Step C');
          if (start === -1) return null;
          const rest = content.slice(start + 1);
          const nextHeading = rest.indexOf('\n### ');
          const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
          return section.split('\n').filter((line) => line.trimStart().startsWith('|')).join('\n');
        };
        agrees('step C rows', fc.oneof(lines(['### Step C', '### Step C — x', '### Step D', '| a | mcp__x__ |', '  | b |', 'text |', '', '|', '\t| t'], 9), lineChain(['### Step C', '| a | mcp__ab__y |', '### Step D'], ['', '| z |', 'text'])),
          (s) => [mcp.stepCTableRows(s), oldStepC(s)], (expected) => expected !== null && expected !== '');
        const oldReferenced = (body) => {
          const servers = new Set();
          for (const m of body.matchAll(/mcp__([A-Za-z0-9_-]+?)__/g)) {
            if (m[1].length === 1) continue;
            servers.add(m[1].toLowerCase());
          }
          return [...servers].sort();
        };
        const refTokens = ['mcp__', '__', 'a', 'Ab', '1', '_', '-', ' ', '\n', 'x', '<', '>', '*', 'mcp__a__', 'mcp__ab__', 'mcp__a_b__', 'mcp__a-b__c', 'mcp____', 'mcp__a___'];
        agrees('referenced servers', fc.oneof(strings(refTokens, 9), chain(['mcp__', 'ab', '__', 'mcp__', 'c_d', '__', 'mcp__', 'e', '__'], ['', '_', 'x', ' ', '-', '__'], 3)), (s) => [sorted(mcp.referencedServers(s)), oldReferenced(s)]);
        const oldStrip = (s) => String(s).replace(/\s+#.*$/, '');
        agrees('inline comment', fc.oneof(strings(['#', ' ', '\t', '\n', '\r', '\u2028', '\u2029', 'a', 'mcp__x__*', ',', '\u00a0'], 10), chain(['Read', ' ', '#', 'x'], ['', ' ', '\n', '\u2028', '\t'], 3)),
          (s) => [mcp.stripInlineComment(s), oldStrip(s)], (expected) => expected.length > 0 && !expected.includes('#'));
        const oldTokens = (tools) => {
          if (tools === undefined || tools === null) return null;
          const items = Array.isArray(tools) ? tools : [tools];
          return items.flatMap((t) => oldStrip(t).split(/[,\s]+/)).map((t) => t.trim()).filter(Boolean);
        };
        const toolItem = strings(['Read', ',', ' ', '  ', 'mcp__a__*', '#', ' # c', '\n', '\u00a0', '\t', 'mcp__'], 8);
        agrees('tool tokens', fc.oneof(toolItem, fc.array(toolItem, { maxLength: 3 }), fc.constantFrom(undefined, null)), (tools) => [mcp.toolTokens(tools), oldTokens(tools)], (expected) => expected !== null && expected.length > 0);
        const oldGranted = (tokens) => {
          const servers = new Set();
          for (const token of tokens) {
            if (!token.startsWith('mcp__')) continue;
            if (/^mcp__\*+$/.test(token)) { servers.add('*'); continue; }
            const rest = token.slice('mcp__'.length).replace(/\*+$/, '');
            const server = rest.includes('__') ? rest.slice(0, rest.indexOf('__')) : rest;
            if (server) servers.add(server.toLowerCase());
          }
          return servers;
        };
        const grantTokens = ['mcp__', 'mcp__*', 'mcp__**', 'mcp__a__*', 'mcp__Ab__x', 'mcp__ab', 'MCP__ab__*', 'mcp__*a', 'mcp__a*__b', 'mcp__a__b__c', 'mcp____x', 'Read', 'mcp__*__*', 'mcp__a**'];
        agrees('granted servers', fc.array(fc.constantFrom(...grantTokens), { maxLength: 5 }), (tokens) => [sorted(mcp.grantedServers(tokens)), sorted(oldGranted(tokens))], (expected) => expected.length > 0);
        const oldUngranted = (content) => {
          const fm = frontmatter.parseFrontmatter(content) || {};
          const tokens = oldTokens(fm.tools);
          if (tokens === null) return [];
          const granted = oldGranted(tokens);
          if (granted.has('*')) return [];
          return [...oldReferenced(`${String(fm.description ?? '')}\n${frontmatter.stripFrontmatter(content)}`)].filter((s) => !granted.has(s)).sort();
        };
        const fmLines = ['name: a', 'tools: Read', 'tools: Read, mcp__ab__*', 'tools: mcp__*', 'tools: Read, mcp__', 'tools: mcp__cd__navigate', 'tools: Read # mcp__ab__*', 'tools: [Read, mcp__ef__*]', 'tools: "Read, mcp__gh__*"', 'tools:', '  - mcp__ij__*',
          '  - Read', 'description: uses mcp__kl__x', 'description: plain', '# tools: mcp__mn__*', 'color: pink'];
        const bodyLines = ['mcp__ab__x()', 'mcp__AB__y', 'mcp__a__z', 'mcp__<S>__*', 'mcp__cd__', 'mcp__ef-gh__q', 'text', 'mcp____x', 'mcp__ab', 'mcp__kl__w', 'mcp__op__*', 'mcp__gh__t', 'mcp__ij_x__q'];
        agrees('ungranted servers', fc.tuple(fc.array(fc.constantFrom(...fmLines), { maxLength: 4 }), fc.array(fc.constantFrom(...bodyLines), { maxLength: 5 })),
          ([fm, body]) => [mcp.ungrantedServers(['---', ...fm, '---', '', ...body].join('\n'), frontmatter).ungranted, oldUngranted(['---', ...fm, '---', '', ...body].join('\n'))], (expected) => expected.length > 0);
        const oldMentions = (content) => content.toLowerCase().includes('mcp') || content.includes('context7') || content.includes('available tools') || content.includes('MCP tool');
        agrees('mentions mcp', strings(['mcp', 'MCP', 'McP', 'context7', 'Context7', 'available tools', 'Available tools', 'MCP tool', ' ', '\n', 'x', 'm', 'c', 'p', 'K'], 6), (s) => [mcp.mentionsMcp(s), oldMentions(s)]);
      });

      test('property: the agent-classification-parity parsers agree with the patterns and loops they replaced', () => {
        const H2 = /^##(?!#)\s+\S/;
        const GSD_H3 = /^###\s+(gsd-[\w-]+)\s*$/;
        const ADVANCED_SECTION = /^##\s+Advanced and Specialized Agents\s*$/;
        const AGENTS_SECTION = /^##\s+Agents\b/;
        const headingTokens = ['#', '##', '###', ' ', '\t', '\u00a0', '\ufeff', 'gsd-a', 'gsd-', 'b-c', '_', 'x', '\r', '\u2028', 'Agents', 'agents', 'Advanced and Specialized Agents', '-', 'gsd-a b'];
        agrees('h2 line', fc.oneof(strings(headingTokens, 7), chain(['##', ' ', 'x'], blanks, 3)), (s) => [acp.isH2(s), H2.test(s)]);
        agrees('agent heading', fc.oneof(strings(headingTokens, 7), chain(['###', ' ', 'gsd-ab', '-c'], blanks, 3)), (s) => [acp.agentHeading(s), (GSD_H3.exec(s) || [])[1] ?? null], (expected) => expected !== null);
        agrees('agents section line', fc.oneof(strings(headingTokens, 7), chain(['##', ' ', 'Agents', ' (3)'], ['', ' ', '\t', '_', 'x'], 3)), (s) => [acp.isAgentsSection(s), AGENTS_SECTION.test(s)]);
        const oldAgentsMd = (raw) => {
          const primaryHeadings = [];
          const advancedHeadings = [];
          let state = 'before';
          for (const line of raw.split('\n')) {
            if (ADVANCED_SECTION.test(line)) { state = 'advanced'; continue; }
            if (state === 'advanced' && H2.test(line)) { state = 'past'; continue; }
            const m = GSD_H3.exec(line);
            if (m) {
              if (state === 'before') primaryHeadings.push(m[1]);
              else if (state === 'advanced') advancedHeadings.push(m[1]);
            }
          }
          return { primaryHeadings, advancedHeadings };
        };
        const agentLines = ['## Advanced and Specialized Agents', '## Advanced and Specialized Agents  ', '##  Advanced and Specialized Agents\r', '### Advanced and Specialized Agents', '## Other', '##', '## ', '###\tgsd-a', '### gsd-b-c', '### gsd-',
          '### gsd-a b', '#### gsd-q', '### gsd-d\r', 'text', '', '##\u00a0X', '### gsd-e\u2028'];
        agrees('agents.md headings', fc.oneof(lines(agentLines, 10), lineChain(['### gsd-a', '## Advanced and Specialized Agents', '### gsd-b', '## Appendix', '### gsd-c'], agentLines)),
          (s) => [acp.parseAgentsMd(s), oldAgentsMd(s)], (expected) => expected.primaryHeadings.length + expected.advancedHeadings.length > 0);
        const oldInventory = (raw) => {
          const result = new Map();
          let inAgentsSection = false;
          let primaryDocColIndex = -1;
          for (const line of raw.split('\n')) {
            if (AGENTS_SECTION.test(line)) { inAgentsSection = true; primaryDocColIndex = -1; continue; }
            if (inAgentsSection && H2.test(line)) break;
            if (!inAgentsSection) continue;
            if (!line.startsWith('|')) continue;
            const cells = line.split('|').slice(1, -1).map((c) => c.trim());
            if (primaryDocColIndex === -1) {
              const pdIdx = cells.findIndex((c) => c === 'Primary doc');
              if (pdIdx !== -1 && cells[0] === 'Agent') primaryDocColIndex = pdIdx;
              continue;
            }
            if (cells.every((c) => /^[-: ]+$/.test(c))) continue;
            if (!cells[0].startsWith('gsd-')) continue;
            if (cells.length <= primaryDocColIndex) continue;
            if (cells[0].endsWith('.compact')) continue;
            result.set(cells[0], cells[primaryDocColIndex]);
          }
          return primaryDocColIndex === -1 ? null : [...result];
        };
        const inventoryLines = ['## Agents', '## Agents (33 shipped)', '## Agentsx', '##  Agents', '### Agents', '## Other', '| Agent | Role | Spawned by | Primary doc |', '| Agent | Primary doc |', '|---|---|', '| --- | :-: |', '| gsd-a | r | s | primary |',
          '| gsd-a.compact | r | s | inventory only |', '| gsd-b | | | advanced stub |', '| x | y |', '| gsd-c |', 'text', '| Agent | Primary doc', '|', '||', '| gsd-d | primary |', '| Agent | Role | Primary doc |'];
        agrees('inventory table', fc.oneof(lines(inventoryLines, 10), lineChain(['## Agents', '| Agent | Role | Primary doc |', '|---|---|---|', '| gsd-a | r | primary |', '## Other'], inventoryLines)),
          (s) => { const actual = acp.parseInventoryMd(s); return [actual === null ? null : [...actual], oldInventory(s)]; }, (expected) => expected !== null && expected.length > 0);
        const oldCount = (text) => { const m = text.match(/\*\*(\d+)\s+primary\s+agents?\*\*/); return m ? parseInt(m[1], 10) : null; };
        agrees('primary count', fc.oneof(strings(['**', '23', ' ', '\n', 'primary', 'agent', 's', 'x', '\u00a0', '*', '1'], 9), chain(['**', '23', ' ', 'primary', ' ', 'agents', '**'], ['', ' ', '\n', '\u00a0', '*'], 3)), (s) => [acp.proseCount(s), oldCount(s)], (expected) => expected !== null);
        const CARDINALS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13 };
        const oldAdvanced = (text) => {
          const m = text.match(/\b((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen))\s+additional\s+shipped\s+agents?\b/i);
          if (!m) return null;
          const word = m[1].toLowerCase();
          return { word, count: CARDINALS[word] !== undefined ? CARDINALS[word] : parseInt(word, 10) };
        };
        agrees('additional count', fc.oneof(strings(['twelve', 'Thirteen', 'THREE', '12', 'additional', 'shipped', 'agent', 'agents', ' ', '\n', 'x', '_', 'a1', 'fourteen', 'one', 'ten'], 9),
          chain(['Thirteen', ' ', 'additional', ' ', 'shipped', ' ', 'agents'], ['', ' ', '\n', '\t', '_', 'x'], 3)), (s) => [acp.proseAdvancedCount(s), oldAdvanced(s)], (expected) => expected !== null);
        const oldParen = (text) => { const m = text.match(/\(([^)]+)\)\s+have concise stubs/); return m ? m[1].split(',').map((s) => s.trim().toLowerCase()) : null; };
        agrees('parenthetical list', fc.oneof(strings(['(', ')', 'a, B', ',', ' ', '\n', 'have concise stubs', 'have concise stub', 'x', '()'], 9), chain(['(', 'a, b', ')', ' ', 'have concise stubs'], ['', ' ', '\n', '(', ')'], 3)),
          (s) => [acp.parentheticalSlugs(s), oldParen(s)], (expected) => expected !== null);
        const TOOLS_ROW = /^\|\s*\*\*Tools\*\*\s*\|\s*(.*?)\s*\|\s*$/;
        agrees('tools row', fc.oneof(strings(['|', ' ', '**Tools**', 'Read', ', ', '\t', '\u2028', '\r', 'x', '\u00a0', '**'], 9), chain(['|', ' ', '**Tools**', ' ', '|', ' Read, Bash ', '|'], ['', ' ', '\t', '\u00a0', '\u2028', '|'], 2)),
          (s) => [acp.toolsRowValue(s), (TOOLS_ROW.exec(s) || [])[1] ?? null], (expected) => expected !== null);
        const oldSections = (raw) => {
          const sourceLines = raw.split(/\r?\n/);
          const sections = [];
          sourceLines.forEach((line, i) => {
            const m = GSD_H3.exec(line);
            if (m) sections.push({ slug: m[1], start: i });
          });
          sections.forEach((s, i) => { s.end = i + 1 < sections.length ? sections[i + 1].start : sourceLines.length; });
          return sections.map((section) => {
            for (let i = section.start; i < section.end; i += 1) {
              const m = TOOLS_ROW.exec(sourceLines[i]);
              if (m) return { slug: section.slug, row: { value: m[1], line: i + 1 } };
            }
            return { slug: section.slug, row: null };
          });
        };
        const sectionLines = ['### gsd-a', '### gsd-b', '| **Tools** | Read, Bash |', '| **Tools** | x', '|  **Tools**  |   a | b  | ', 'text', '', '#### gsd-q', '| **Tools** |  |'];
        agrees('tools sections', fc.tuple(fc.oneof(lines(sectionLines, 9), lineChain(['### gsd-a', '| **Tools** | Read |', '### gsd-b'], sectionLines)), fc.constantFrom('\n', '\r\n')),
          ([text, eol]) => [acp.toolsSections(text.split('\n').join(eol)), oldSections(text.split('\n').join(eol))], (expected) => expected.some((s) => s.row !== null));
      });
    }
  }

  {
    // parallel-dependent-plans, explore-command, plan-checker-coupling and edge-probe-spec-phase-contract: controls, the bounds of every
    // window, the exactly-one-finding cases, the loader seams and a differential property for every linear walker.
    const PLANNER = 'agents/gsd-planner.md';
    const EXECUTE = 'gsd-core/workflows/execute-phase.md';
    const COMMAND = 'commands/gsd/explore.md';
    const EXPLORE = 'gsd-core/workflows/explore.md';
    const RESEARCHER = 'agents/gsd-phase-researcher.md';
    const PLANT_SEED = 'gsd-core/workflows/plant-seed.md';
    const CONTEXT = 'CONTEXT.md';
    const CHECKER = 'agents/gsd-plan-checker.md';
    const DOCS_AGENTS = 'docs/reference/agents.md';
    const REVISION_LOOP = 'gsd-core/references/revision-loop.md';
    const PLAN_PHASE = 'gsd-core/workflows/plan-phase.md';
    const COUPLING_REF = 'gsd-core/references/planner-coupling.md';
    const VERIFY_WORK = 'gsd-core/workflows/verify-work.md';
    const QUICK_LOOP = 'gsd-core/workflows/quick/steps/plan-checker-loop.md';
    const IMPORT = 'gsd-core/workflows/import.md';
    const AGENT_CONTRACTS = 'gsd-core/references/agent-contracts.md';
    const SPEC_PHASE = 'gsd-core/workflows/spec-phase.md';
    const EDGE_PROBE_REF = 'gsd-core/references/edge-probe.md';
    const UI_PHASE = 'gsd-core/workflows/ui-phase.md';
    const FALLBACK = 'gsd-core/references/specless-probe-fallback.md';
    const PARALLEL = 'parallel-dependent-plans';
    const EXPLORE_ID = 'explore-command';
    const COUPLING = 'plan-checker-coupling';
    const EDGE = 'edge-probe-spec-phase-contract';
    const rewrite = (root, rel, edit) => {
      const abs = path.join(root, ...rel.split('/'));
      const before = fs.readFileSync(abs, 'utf8');
      const after = edit(before);
      assert.notEqual(after, before, 'the edit changed the file');
      fs.writeFileSync(abs, after);
    };
    const runEdits = (t, edits, contract) => {
      const root = copyOfRepoFiles(t, HEAVY);
      for (const [rel, edit] of edits) rewrite(root, rel, edit);
      return runShipped(root, [contract]);
    };
    const messagesOf = (findings) => JSON.stringify(findings.map((f) => f.message));
    // An edit after which one named message must not be reported: an alternative of an OR check that is enough on its own.
    const noMessage = (title, rel, edit, contract, pattern) => test(title, (t) => {
      const findings = runEdits(t, [[rel, edit]], contract);
      assert.ok(!findings.some((f) => pattern.test(f.message)), messagesOf(findings));
    });
    const oneFinding = (title, rel, edit, contract, expected) => test(title, (t) => {
      const findings = runEdits(t, [[rel, edit]], contract);
      assert.equal(findings.length, 1, messagesOf(findings));
      assert.ok(findings[0].message.includes(expected), messagesOf(findings));
    });
    const passesHeavy = (title, rel, edit, contract) => test(title, (t) => {
      assert.deepEqual(runEdits(t, [[rel, edit]], contract), []);
    });
    // The bounds of a window with the real files copied (CONTEXT.md included): limit - 1 and limit are matched, limit + 1 is past the bound.
    const heavyGaps = (label, rel, contract, build, limit, whyMatch) => {
      for (const [gap, ok] of [[limit - 1, true], [limit, true], [limit + 1, false]]) {
        test(`${label} with a gap of ${gap} characters ${ok ? 'satisfies' : 'is past the bound of'} ${contract}`, (t) => {
          const root = copyOfRepoFiles(t, HEAVY);
          const abs = path.join(root, ...rel.split('/'));
          const text = fs.readFileSync(abs, 'utf8');
          const after = build(text, gap);
          assert.notEqual(after, text);
          fs.writeFileSync(abs, after);
          const findings = runShipped(root, [contract]);
          if (ok) assert.deepEqual(findings, [], messagesOf(findings));
          else assert.ok(findings.some((f) => whyMatch.test(f.message)), messagesOf(findings));
        });
      }
    };

    // ---- parallel-dependent-plans: each alternative of the rule clauses and of the overlap check is enough, the window is the region
    const PLANNER_STEP = ['<step name="assign_waves">', '</step>'];
    const REGION = ['files_modified overlap', 'Spawn executor agents'];
    const RULE_HEAD = 'must have zero `files_modified`/`files_deleted` overlap.';
    for (const word of ['no', 'not', 'never']) {
      passesHeavy(`the prohibition ${word} alone satisfies the rule`, PLANNER, swap('must have zero', `must have ${word}`), PARALLEL);
    }
    for (const word of ['share', 'sharing', 'conflict', 'touch']) {
      passesHeavy(`the overlap predicate ${word} alone satisfies the rule`, PLANNER, swap('`files_deleted` overlap.', `\`files_deleted\` ${word}.`), PARALLEL);
    }
    passesHeavy('the rule paragraph continues on the next line', PLANNER, swap('must have zero `files_modified`', 'must have zero\n`files_modified`'), PARALLEL);
    passesHeavy('a line of prose joins the rule paragraph without changing its verdict', PLANNER, swap('to the next wave and repeat.', 'to the next wave and repeat.\nTies break by plan id.'), PARALLEL);
    passesHeavy('files_modified overlap alone is enough for the later-wave requirement', PLANNER, eraseAll('later wave'), PARALLEL);
    passesHeavy('later wave alone is enough for the later-wave requirement', PLANNER, eraseAll('files_modified overlap'), PARALLEL);
    passesHeavy('shared file alone is enough for the wave-bumping condition', PLANNER, within(PLANNER_STEP[0], PLANNER_STEP[1], (step) => `${step.split('overlap').join('conflict')} shared file`), PARALLEL);
    passesHeavy('sequential without the ly is enough', EXECUTE, swap('sequentially', 'sequential'), PARALLEL);
    passesHeavy('an upper-case WARN in the overlap check is enough', EXECUTE, within(REGION[0], REGION[1], (region) => `${region.replace(/warn/gi, 'note')} WARN`), PARALLEL);
    {
      const PHRASES = ['all plans in', 'all plans within', 'each pair', 'any two plans'];
      for (const phrase of PHRASES) {
        passesHeavy(`"${phrase}" alone satisfies the plan-pair coverage`, EXECUTE, within(REGION[0], REGION[1], (region) => `${PHRASES.reduce((text, one) => text.split(one).join(''), region)} ${phrase}`), PARALLEL);
      }
    }
    oneFinding('a lower-case intra-wave after the spawn heading moves the marker behind it', EXECUTE, append('intra-wave'), PARALLEL, 'the overlap check must appear before the "Spawn executor agents" section');
    oneFinding('the spawn heading erased is one finding', EXECUTE, eraseAll('Spawn executor agents'), PARALLEL, 'the "Spawn executor agents" heading is missing');
    oneFinding('every files_modified overlap marker erased is one finding', EXECUTE, eraseAll('files_modified overlap'), PARALLEL, 'neither "intra-wave" nor "files_modified overlap" is present');
    oneFinding('the assign_waves step renamed is one finding', PLANNER, swap(PLANNER_STEP[0], '<step name="assign_waves_x">'), PARALLEL, 'marker "<step name=\\"assign_waves\\">" not found');
    oneFinding('every step close erased is one finding', PLANNER, eraseAll('</step>'), PARALLEL, 'closing marker "</step>" not found');
    oneFinding('the Rule marker erased is one finding', PLANNER, within(PLANNER_STEP[0], PLANNER_STEP[1], eraseAll('**Rule:**')), PARALLEL, 'missing: **Rule:** paragraph');
    oneFinding('the wave scope dropped from the rule is one finding', PLANNER, swap('Same-wave plans must have zero', 'Plans must have zero'), PARALLEL, 'missing: wave scope');
    oneFinding('the closest sentence names its single shortfall', PLANNER, swap(RULE_HEAD, 'must have `files_modified`/`files_deleted` overlap. Zero tolerance.'), PARALLEL, 'missing: prohibition');
    test('the rule with every clause missing names all four', (t) => {
      const findings = runEdits(t, [[PLANNER, within(PLANNER_STEP[0], PLANNER_STEP[1], swap('**Rule:** Same-wave plans must have zero `files_modified`/`files_deleted` overlap. After assigning waves, scan each wave; if any file appears in 2+ plans, bump the later plan to the next wave and repeat.', '**Rule:** Plans.'))]], PARALLEL);
      assert.equal(findings.length, 1, messagesOf(findings));
      assert.ok(findings[0].message.includes('missing: wave scope, files_modified subject, prohibition, overlap predicate'), messagesOf(findings));
    });
    for (const [rel, contract, heavy] of [
      [PLANNER, PARALLEL], [EXECUTE, PARALLEL],
      [COMMAND, EXPLORE_ID], [EXPLORE, EXPLORE_ID], [RESEARCHER, EXPLORE_ID], [PLANT_SEED, EXPLORE_ID], [CONTEXT, EXPLORE_ID],
      [CHECKER, COUPLING], [DOCS_AGENTS, COUPLING], [REVISION_LOOP, COUPLING], [PLAN_PHASE, COUPLING], [PLANNER, COUPLING], [COUPLING_REF, COUPLING],
      [VERIFY_WORK, COUPLING], [QUICK_LOOP, COUPLING], [IMPORT, COUPLING], [AGENT_CONTRACTS, COUPLING],
      [SPEC_PHASE, EDGE], [EDGE_PROBE_REF, EDGE], [PLAN_PHASE, EDGE], [UI_PHASE, EDGE], [FALLBACK, EDGE],
    ]) {
      void heavy;
      test(`${rel} removed is exactly one finding for ${contract}`, (t) => {
        const root = copyOfRepoFiles(t, HEAVY);
        fs.unlinkSync(path.join(root, ...rel.split('/')));
        const findings = runShipped(root, [contract]);
        assert.equal(findings.length, 1, messagesOf(findings));
        assert.equal(findings[0].file, rel);
        assert.match(findings[0].message, /cannot read the file/);
      });
      test(`${rel} emptied is exactly one finding for ${contract}`, (t) => {
        const root = copyOfRepoFiles(t, HEAVY);
        fs.writeFileSync(path.join(root, ...rel.split('/')), '\n');
        const findings = runShipped(root, [contract]);
        assert.equal(findings.length, 1, messagesOf(findings));
        assert.equal(findings[0].file, rel);
        assert.match(findings[0].message, /the file is empty/);
      });
    }

    // ---- explore-command: alternatives, the windows at their bounds, the ledger enum and the exactly-one cases
    const SPAWN = ['Agent(', 'subagent_type="gsd-phase-researcher"'];
    const MARKER = 'subagent_type="gsd-phase-researcher"';
    const ATTRIBUTE = 'model="{RESEARCHER_MODEL}"';
    const MODEL_LIMIT = 200 - MARKER.length - 1 - ATTRIBUTE.length;
    noMessage('"explicit user selection" alone is enough for the confirmation', EXPLORE, eraseAll('Never write artifacts without'), EXPLORE_ID, /require user confirmation before writing artifacts/);
    noMessage('"Never write artifacts without" alone is enough for the confirmation', EXPLORE, eraseAll('explicit user selection'), EXPLORE_ID, /require user confirmation before writing artifacts/);
    noMessage('"conflict-abstention" alone is enough for the conflict abstention', EXPLORE, (text) => text.replace(/source-vs-prior/g, 'srcprior').replace(/conflict(?!-abstention)/gi, 'clash'), EXPLORE_ID, /abstain arm must cover a source-vs-prior conflict/);
    noMessage('a conflict sentence naming the ledger is enough for the conflict abstention', EXPLORE, (text) => text.replace(/source-vs-prior/g, 'srcprior').replace(/conflict-abstention/gi, 'clash-abstention'), EXPLORE_ID, /abstain arm must cover a source-vs-prior conflict/);
    noMessage('conflict then ledger in one sentence alone is enough for the conflict abstention', EXPLORE, (text) => `${text.replace(/source-vs-prior/g, 'srcprior').replace(/conflict/gi, 'clash')}\nA conflict goes to the ledger.\n`, EXPLORE_ID, /abstain arm must cover a source-vs-prior conflict/);
    noMessage('ledger then conflict in one sentence alone is enough for the conflict abstention', EXPLORE, (text) => `${text.replace(/source-vs-prior/g, 'srcprior').replace(/conflict/gi, 'clash')}\nThe ledger takes a conflict.\n`, EXPLORE_ID, /abstain arm must cover a source-vs-prior conflict/);
    test('conflict and ledger in different sentences are no conflict abstention', (t) => {
      const findings = runEdits(t, [[EXPLORE, (text) => `${text.replace(/source-vs-prior/g, 'srcprior').replace(/conflict/gi, 'clash')}\nA conflict. The ledger.\n`]], EXPLORE_ID);
      assert.ok(findings.some((f) => /the abstain arm must cover a source-vs-prior conflict/.test(f.message)), messagesOf(findings));
    });
    noMessage('fresh random alone is enough for the per-wrap delimiter', EXPLORE, eraseAll('DATA_'), EXPLORE_ID, /per-wrap delimiter/);
    noMessage('DATA_ alone is enough for the per-wrap delimiter', EXPLORE, erase(/fresh random/g), EXPLORE_ID, /per-wrap delimiter/);
    noMessage('a lower-case data_ alone is enough for the per-wrap delimiter', EXPLORE, (text) => text.replace(/fresh random/g, 'x').split('DATA_').join('data_'), EXPLORE_ID, /per-wrap delimiter/);
    passesHeavy('a lower-case authoritative in the spawn refute arm is enough', EXPLORE, within(SPAWN[0], SPAWN[1], swap('AUTHORITATIVE FOR THIS CLAIM', 'authoritative for this claim')), EXPLORE_ID);
    passesHeavy('the first ledger enum copy wrapped over lines is the same copy', EXPLORE, (text) => {
      const at = text.indexOf(' | non-authoritative source | ');
      return text.slice(0, at) + ' |\n   non-authoritative source |\n   ' + text.slice(at + ' | non-authoritative source | '.length);
    }, EXPLORE_ID);
    passesHeavy('a lower-case opening of the omit rule is enough', EXPLORE, swap('Omit `model=` entirely', 'omit `model=` entirely'), EXPLORE_ID);
    oneFinding('a decoy bullet above the Tier floor bullet is a third guard', EXPLORE, swap('- **Tier floor**', '- **Something else** — an unrelated guard bullet.\n- **Tier floor**'), EXPLORE_ID, '(found 3 top-level guard bullets)');
    oneFinding('the Tier floor bullet renamed is one finding', EXPLORE, swap('- **Tier floor**', '- **Tier cap**'), EXPLORE_ID, 'the Tier floor bullet must exist');
    oneFinding('the researcher spawn marker erased is one finding', EXPLORE, eraseAll(MARKER), EXPLORE_ID, 'the researcher spawn must be found');
    oneFinding('the preamble erased is one finding', EXPLORE, eraseAll('_GSD_SHIM_NAME="gsd-tools.cjs"'), EXPLORE_ID, 'gsd_run must be bootstrapped before the tier-floor probe runs');
    oneFinding('the Step 4 heading renamed is one finding', EXPLORE, swap('## Step 4', '## Stage 4'), EXPLORE_ID, 'the Step 3, Step 4 and Step 6 headings must exist in that order');
    oneFinding('the guard intro erased is one finding', EXPLORE, eraseAll('Two guards ride with it:'), EXPLORE_ID, 'the guard-list intro must read "Two guards ride with it:"');
    test('the guard intro turned into Three guards is the two findings of its two assertions', (t) => {
      const findings = runEdits(t, [[EXPLORE, swap('Two guards ride with it:', 'Three guards ride with it:')]], EXPLORE_ID);
      assert.equal(findings.length, 2, messagesOf(findings));
      assert.ok(findings.some((f) => f.message.includes('"Three guards" must not appear')), messagesOf(findings));
      assert.ok(findings.some((f) => f.message.includes('the guard-list intro must read "Two guards ride with it:"')), messagesOf(findings));
    });
    oneFinding('every ledger enum copy of explore.md erased is one finding', EXPLORE, eraseAll('untagged — disposition not reported'), EXPLORE_ID, 'explore.md must carry at least one copy of the 5-value ledger-reason enum');
    oneFinding('the second ledger enum copy of explore.md broken is one finding', EXPLORE, (text) => {
      const at = text.lastIndexOf('untagged — disposition not reported');
      return text.slice(0, at) + 'x' + text.slice(at + 'untagged — disposition not reported'.length);
    }, EXPLORE_ID, 'explore.md must carry at least 2 copies of the 5-value ledger-reason enum; found 1');
    oneFinding('the researcher agent ledger enum erased is one finding', RESEARCHER, swap('`untagged — disposition not reported`', '`untagged`'), EXPLORE_ID, 'agents/gsd-phase-researcher.md must carry at least one copy of the 5-value ledger-reason enum');
    oneFinding('the CONTEXT.md ledger enum drifted is one finding', CONTEXT, swap('| `non-authoritative source` | `tier-floor: unearned confidence` |', '| `non-authoritative sources` | `tier-floor: unearned confidence` |'), EXPLORE_ID, 'CONTEXT.md has drifted from explore.md');
    oneFinding('the CONTEXT.md ledger enum erased is one finding', CONTEXT, swap('`untagged — disposition not reported`)', '`untagged`)'), EXPLORE_ID, 'CONTEXT.md must carry at least one copy of the 5-value ledger-reason enum');
    passesHeavy('a later differing copy of CONTEXT.md is not compared: only the first copy is', CONTEXT, append('`unverifiable` | `a` | `b` | `c` | `untagged — disposition not reported`'), EXPLORE_ID);
    heavyGaps('the model attribute behind the spawn marker', EXPLORE, EXPLORE_ID,
      (text, gap) => text.split(`${MARKER},\n  ${ATTRIBUTE}`).join(`${MARKER},${'x'.repeat(gap)}${ATTRIBUTE}`), MODEL_LIMIT, /the Agent\(\) spawn must pass the bound model/);
    heavyGaps('the never of an unresolved-never-crystallize chain', EXPLORE, EXPLORE_ID,
      (text, gap) => text.split('**Unresolved ledger** must never be crystallized').join(`**Unresolved${'x'.repeat(gap)}never be crystallized`), 60, /must forbid crystallizing an unresolved-ledger claim/);
    heavyGaps('the crystalliz of an unresolved-never-crystallize chain', EXPLORE, EXPLORE_ID,
      (text, gap) => text.split('**Unresolved ledger** must never be crystallized').join(`**Unresolved ledger** must never${'x'.repeat(gap)}crystallized`), 60, /must forbid crystallizing an unresolved-ledger claim/);
    heavyGaps('the disposition of a carry-disposition pair', EXPLORE, EXPLORE_ID,
      (text, gap) => text.split('**Carry the research disposition into every').join(`**Carry${'x'.repeat(gap)}disposition into every`), 60, /must carry the research disposition into the durable artifact/);

    // ---- plan-checker-coupling: the gaps of the whitespace patterns, the exemption tier, the exactly-one cases
    const D3B_HEADING = '## Dimension 3b: ';
    const D4_HEADING = '## Dimension 4: ';
    const inThreeB = (edit) => within(D3B_HEADING, D4_HEADING, edit);
    passesHeavy('Scope: with no blank before the pair text is enough', CHECKER, inThreeB(swap('Scope: PLAN pairs', 'Scope:PLAN pairs')), COUPLING);
    passesHeavy('Scope: with several blanks before the pair text is enough', CHECKER, inThreeB(swap('Scope: PLAN pairs', 'Scope:   \t PLAN pairs')), COUPLING);
    passesHeavy('never blocker without the article is enough', CHECKER, inThreeB(swap('never a blocker', 'never blocker')), COUPLING);
    passesHeavy('never a blocker over a line break is enough', CHECKER, inThreeB(swap('never a blocker', 'never\n a\n\tblocker')), COUPLING);
    passesHeavy('severity with no blank before the tier is enough', CHECKER, inThreeB(swap('severity: info', 'severity:info')), COUPLING);
    passesHeavy('a dimension key with no blank before it is enough', CHECKER, inThreeB(swap('dimension: dependency_correctness', 'dimension:dependency_correctness')), COUPLING);
    passesHeavy('mutable and resource over a tab are enough in the coupling reference', COUPLING_REF, (text) => text.replace(/mutable\s+resource/i, 'mutable\tresource'), COUPLING);
    oneFinding('mutable resource run together is no resource rule', COUPLING_REF, (text) => text.replace(/mutable\s+resource/gi, 'mutableresource'), COUPLING, 'planner-coupling.md must state the shared-mutable-resource rule');
    oneFinding('the applied exemption note run together is one finding', CHECKER, inThreeB(swap('note the applied\nexemption', 'note the appliedexemption')), COUPLING, 'Dimension 3b must surface an applied coupling_justified exemption as an info advisory');
    oneFinding('a trailing blank after the plan-checker docs heading is one finding', DOCS_AGENTS, swap('### gsd-plan-checker\n', '### gsd-plan-checker \n'), COUPLING, 'the plan-checker and integration-checker sections must exist in order');
    oneFinding('the integration-checker docs heading renamed is one finding', DOCS_AGENTS, swap('### gsd-integration-checker', '### gsd-integration-checker2'), COUPLING, 'end heading not found: ### gsd-integration-checker');
    oneFinding('the Dimension 3b heading renamed is one finding', CHECKER, swap(D3B_HEADING, '## Dimension three: '), COUPLING, 'must define a "## Dimension 3b:" heading');
    oneFinding('the Dimension 4 heading renamed is one finding', CHECKER, swap(D4_HEADING, '## Dimension four: '), COUPLING, 'Dimensions 3, 3b and 4 must all be present');
    oneFinding('the Dimension 3 heading renamed is one finding', CHECKER, swap('## Dimension 3: ', '## Dimension three: '), COUPLING, 'Dimensions 3, 3b and 4 must all be present');
    oneFinding('the success criteria opening erased is one finding', CHECKER, eraseAll('<success_criteria>'), COUPLING, 'marker "<success_criteria>" not found');
    oneFinding('the success criteria closing erased is one finding', CHECKER, eraseAll('</success_criteria>'), COUPLING, 'closing marker "</success_criteria>" not found');
    oneFinding('the exempt tier flow line replaced is one finding', REVISION_LOOP, swap('If PASSED or only INFO-level issues', 'If PASSED or any issues'), COUPLING, 'revision-loop.md must state its exempt severity tier in the flow');
    test('a warning exempt tier turns the info example into one finding', (t) => {
      const findings = runEdits(t, [[REVISION_LOOP, swap('If PASSED or only INFO-level issues', 'If PASSED or only WARNING-level issues')]], COUPLING);
      assert.equal(findings.length, 1, messagesOf(findings));
      assert.ok(/example issue must carry the tier revision-loop\.md exempts \(no severity: warning\)/.test(findings[0].message), messagesOf(findings));
    });
    oneFinding('the plan-phase parse line missing is one finding', PLAN_PHASE, swap('Parse issue count from checker return:', 'Parse the count:'), COUPLING, 'plan-phase.md step 12 must carry the parse-issue-count paragraph');
    oneFinding('the quick-mode handler missing is one finding', QUICK_LOOP, swap('- **`## ISSUES FOUND`:**', '- **`## ISSUES`:**'), COUPLING, 'plan-checker-loop.md must carry the ISSUES FOUND handler line');
    test('a fenced yaml severity inside a text fence of Dimension 3b is not an example', (t) => {
      const findings = runEdits(t, [[CHECKER, inThreeB(append('```text\nseverity: warning\n```'))]], COUPLING);
      assert.deepEqual(findings, [], messagesOf(findings));
    });
    test('a fenced yaml block that never closes still counts its severities', (t) => {
      const findings = runEdits(t, [[CHECKER, inThreeB((span) => `${span}\n\`\`\`yaml\nseverity: warning\n`)]], COUPLING);
      assert.equal(findings.length, 1, messagesOf(findings));
      assert.ok(findings[0].message.includes('carries severity: warning'), messagesOf(findings));
    });
    test('a fenced dimension heading is not a numbered dimension', (t) => {
      const findings = runEdits(t, [[CHECKER, append('```\n## Dimension 3b: Not real\n```')]], COUPLING);
      assert.deepEqual(findings, [], messagesOf(findings));
    });

    // ---- edge-probe-spec-phase-contract: alternatives, windows at their bounds, leak and render cases
    const STEP_HEAD = '## Step 5.5';
    const RENDER_LINE = "printf '%s\\n' \"$COVERAGE\"";
    const inStep55 = (edit) => within(STEP_HEAD, '\n## ', edit);
    const GUARD_ALTERNATIVES = [['Array.isArray', 'Array.isArray'], ['empty/invalid', 'empty/invalid'], ['empty or invalid', 'empty or invalid'], ['REQS_JSON then empty', 'a REQS_JSON file that is empty']];
    for (const [name, added] of GUARD_ALTERNATIVES) {
      noMessage(`${name} alone is enough for the empty-input guard`, SPEC_PHASE, inStep55((block) => `${block.replace(/array\.isarray|empty/gi, 'x')}\n${added}\n`), EDGE, /guard against an empty\/invalid \$REQS_JSON/);
    }
    noMessage('build:lib alone is enough for the not-found branch', SPEC_PHASE, inStep55((block) => block.replace(/not found|error/gi, 'x')), EDGE, /explicit not-found branch/);
    noMessage('not found alone is enough for the not-found branch', SPEC_PHASE, inStep55((block) => block.split('build:lib').join('x').replace(/error/gi, 'x')), EDGE, /explicit not-found branch/);
    noMessage('an ERROR line naming edge-probe alone is enough for the not-found branch', SPEC_PHASE, inStep55((block) => `${block.split('build:lib').join('x').replace(/not found|error/gi, 'x')}\nERROR: edge-probe is gone\n`), EDGE, /explicit not-found branch/);
    for (const alternative of ['recall gap', 'never a ceiling', 'not a ceiling', 'add any', 'add the missed', 'add categor', 'adding any', 'adding the missed', 'adding categor']) {
      noMessage(`"${alternative}" alone is enough for the not-a-ceiling check`, SPEC_PHASE,
        inStep55((block) => `${block.replace(/recall gap|never a ceiling|not a ceiling|add(ing)? (any|the missed|categor)/gi, 'x')}\n${alternative}\n`), EDGE, /the floor must NOT be a ceiling/);
    }
    for (const [alternative, line] of [['original language', 'The SPEC stays in the source tongue'], ['stays in', 'The SPEC stays in the source tongue'], ['keeps', 'The SPEC keeps its words'], ['original language before the SPEC', 'the original language is what the SPEC holds']]) {
      noMessage(`"${alternative}" alone is enough for the SPEC language statement`, SPEC_PHASE,
        inStep55((block) => `${block.replace(/original language|stays in|keeps/gi, 'x')}\n${line}\n`), EDGE, /the SPEC keeps the original language/);
    }
    for (const [alternative, line] of [['unchanged', 'the ids stay unchanged'], ['not translated', 'ids are not translated'], ['never translated', 'ids are never translated'], ['stable', 'ids are stable']]) {
      noMessage(`"${alternative}" alone is enough for the id statement`, SPEC_PHASE,
        inStep55((block) => `${block.replace(/unchanged|not translated|never translated|stable/gi, 'x')}\n${line}\n`), EDGE, /requirement ids are NOT translated or renumbered/);
    }
    for (const [alternative, line] of [['original language', 'text is in the original language'], ["SPEC's own", "text is the SPEC's own words"], ["requirement's own", "text is the requirement's own words"], ['unchanged', 'text is unchanged'], ['original language before text', 'the original language is kept in text']]) {
      noMessage(`"${alternative}" alone is enough for the text statement`, SPEC_PHASE,
        inStep55((block) => `${block.replace(/original language|spec's own|requirement's own|unchanged/gi, 'x')}\n${line}\n`), EDGE, /text carries the SPEC requirement in its own \(original\) language/);
    }
    for (const [name, edit] of [['echo', swap(RENDER_LINE, 'echo "$COVERAGE"')], ['cat', swap(RENDER_LINE, 'cat <<< "$COVERAGE"')], ['a pipe into nodejs', swap(RENDER_LINE, `${RENDER_LINE} | nodejs`)]]) {
      passesHeavy(`${name} as the bare render is enough`, SPEC_PHASE, edit, EDGE);
    }
    for (const [name, edit] of [
      ['a printf with a longer name', swap(RENDER_LINE, 'printfx "$COVERAGE"')],
      ['a longer variable name', swap(RENDER_LINE, "printf '%s\\n' \"$COVERAGEX\"")],
      ['a capture with a blank before the substitution', swap(RENDER_LINE, `${RENDER_LINE} y=\t$(z)`)],
      ['a pipe into node over a tab', swap(RENDER_LINE, `${RENDER_LINE} |\tnode`)],
    ]) {
      oneFinding(`${name} is no bare render`, SPEC_PHASE, edit, EDGE, 'Step 5.5 must RENDER $COVERAGE to the model context');
    }
    for (const [name, pinned] of [['a braced prefix', 'npm --prefix "${_GSD_RT}" run build:lib'], ['an unquoted prefix', 'npm --prefix $_GSD_RT run build:lib'], ['a prefix over two blanks', 'npm  --prefix   "$_GSD_RT" run build:lib'], ['a brace without a dollar', 'npm --prefix {_GSD_RT} run build:lib']]) {
      passesHeavy(`${name} is a pinned build`, SPEC_PHASE, swap('npm --prefix "$_GSD_RT" run build:lib', pinned), EDGE);
    }
    for (const [name, unpinned] of [['a prefix of another directory', 'npm --prefix "$HOME" run build:lib'], ['the prefix flag run together', 'npm --prefix"$_GSD_RT" run build:lib'], ['a second unpinned build line', 'npm run build:lib']]) {
      test(`${name} is an unpinned build`, (t) => {
        const findings = runEdits(t, [[SPEC_PHASE, name === 'a second unpinned build line' ? swap('npm --prefix "$_GSD_RT" run build:lib', `npm --prefix "$_GSD_RT" run build:lib\n    ${unpinned}`) : swap('npm --prefix "$_GSD_RT" run build:lib', unpinned)]], EDGE);
        assert.equal(findings.length, 1, messagesOf(findings));
        assert.ok(findings[0].message.includes('build:lib must be pinned with'), messagesOf(findings));
      });
    }
    passesHeavy('an echo mention of npm run build:lib is no invocation', SPEC_PHASE, swap('npm --prefix "$_GSD_RT" run build:lib', 'npm --prefix "$_GSD_RT" run build:lib\n    echo npm run build:lib'), EDGE);
    passesHeavy('an exit after a new then branch that cleans up first passes', SPEC_PHASE, swap('fi\nrm -f "$REQS_JSON"\n# Exit-0-but-garbage', 'fi\nif [ -z "$X" ]; then\n  rm -f "$REQS_JSON"\n  exit 1\nfi\nrm -f "$REQS_JSON"\n# Exit-0-but-garbage'), EDGE);
    oneFinding('an exit in a new branch that has not cleaned up leaks', SPEC_PHASE, swap('fi\nrm -f "$REQS_JSON"\n# Exit-0-but-garbage', 'fi\nif [ -z "$X" ]; then\n  exit 3\nfi\nrm -f "$REQS_JSON"\n# Exit-0-but-garbage'), EDGE, 'leaking exits:');
    passesHeavy('an exit after the unconditional cleanup is not a leak', SPEC_PHASE, swap('# Exit-0-but-garbage guard', 'if [ -z "$X" ]; then\n  exit 3\nfi\n# Exit-0-but-garbage guard'), EDGE);
    oneFinding('a cleanup of an earlier branch does not cover a later else branch', SPEC_PHASE, swap('fi\nrm -f "$REQS_JSON"\n# Exit-0-but-garbage', 'fi\nif [ -z "$X" ]; then\n  rm -f "$REQS_JSON"\n  exit 1\nelse\n  exit 4\nfi\nrm -f "$REQS_JSON"\n# Exit-0-but-garbage'), EDGE, 'leaking exits:');
    oneFinding('the temp-file leak cases of the unconditional cleanup erased are one finding', SPEC_PHASE, swap('fi\nrm -f "$REQS_JSON"\n# Exit-0-but-garbage', 'fi\n# Exit-0-but-garbage'), EDGE, 'Step 5.5 must unconditionally rm -f "$REQS_JSON" after the engine run');
    oneFinding('the Step 5.5 marker erased is one finding', SPEC_PHASE, eraseAll('Step 5.5'), EDGE, 'the Step 5.5 block must be extractable from spec-phase.md');
    {
      const reach = 500;
      // The first arm: COVERAGE then JSON.parse; the pair is the only one left in the block.
      const arm1 = (text, gap) => inStep55((block) => `${block.split('JSON.parse').join('JSON_parse')}\nCOVERAGE${'x'.repeat(gap)}JSON.parse\n`)(text);
      const arm2 = (text, gap) => inStep55((block) => `${block.split('JSON.parse').join('JSON_parse')}\nJSON.parse${'x'.repeat(gap)}$COVERAGE\n`)(text);
      gapCases('COVERAGE then JSON.parse', SPEC_PHASE, EDGE, arm1, reach, /must validate \$COVERAGE parses as JSON before use/);
      gapCases('JSON.parse then $COVERAGE', SPEC_PHASE, EDGE, arm2, reach, /must validate \$COVERAGE parses as JSON before use/);
    }

    // ---- loader seams: a library that cannot be loaded is one finding and the other checks still run
    const seamRun = (t, id, factory) => {
      const root = copyOfRepoFiles(t, HEAVY);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-seam-'));
      t.after(() => cleanup(dir));
      const real = path.join(REPO_ROOT, 'scripts', 'static-checks', 'text-contracts', `${id}.cjs`);
      fs.writeFileSync(path.join(dir, `${id}.cjs`), `const real = require(${JSON.stringify(real)});\nmodule.exports = { id: real.id, check: ${factory} };\n`);
      return textContracts.run({ root, dir, only: [id], minContracts: 1 });
    };
    const LIB = (name) => JSON.stringify(path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', name));
    test('a markdown sectionizer that cannot be loaded is one finding of the plan-checker-coupling contract', (t) => {
      const findings = seamRun(t, COUPLING, `real.walkers.buildCheck({ loadSectionizer: () => { throw new Error('no build'); }, loadTextLines: () => require(${LIB('text-lines.cjs')}) })`);
      assert.equal(findings.length, 1, messagesOf(findings));
      assert.match(findings[0].message, /markdown-sectionizer\.cjs cannot be loaded: no build/);
      assert.equal(findings[0].file, 'gsd-core/bin/lib/markdown-sectionizer.cjs');
    });
    test('a text-lines module that cannot be loaded is one finding of the plan-checker-coupling contract', (t) => {
      const findings = seamRun(t, COUPLING, `real.walkers.buildCheck({ loadSectionizer: () => require(${LIB('markdown-sectionizer.cjs')}), loadTextLines: () => { throw new Error('no lines'); } })`);
      assert.equal(findings.length, 1, messagesOf(findings));
      assert.match(findings[0].message, /text-lines\.cjs cannot be loaded: no lines/);
      assert.equal(findings[0].file, 'gsd-core/bin/lib/text-lines.cjs');
    });
    test('both libraries failing are two findings of the plan-checker-coupling contract', (t) => {
      const findings = seamRun(t, COUPLING, "real.walkers.buildCheck({ loadSectionizer: () => { throw new Error('a'); }, loadTextLines: () => { throw new Error('b'); } })");
      assert.equal(findings.length, 2, messagesOf(findings));
      assert.deepEqual(findings.map((f) => f.file).sort(), ['gsd-core/bin/lib/markdown-sectionizer.cjs', 'gsd-core/bin/lib/text-lines.cjs']);
    });
    test('a text-lines module that cannot be loaded is one finding of the edge-probe-spec-phase-contract contract', (t) => {
      const findings = seamRun(t, EDGE, "real.walkers.buildCheck({ loadTextLines: () => { throw new Error('no lines'); } })");
      assert.equal(findings.length, 1, messagesOf(findings));
      assert.match(findings[0].message, /text-lines\.cjs cannot be loaded: no lines/);
      assert.equal(findings[0].file, 'gsd-core/bin/lib/text-lines.cjs');
    });

    // ---- review round 1: the bounds of the arm window and the dimension floor, one finding per cause, the guard region, indented fences, library calls that throw
    const couplingWalkers = require('../scripts/static-checks/text-contracts/plan-checker-coupling.cjs').walkers;
    const sectionizerLib = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');
    const ARM = '**If iteration_count >= 3:**';
    // The arm checks read the arm line and the four lines after it: with gap blank lines the carrying line is line gap + 2, so gap 3 is the fifth line.
    gapCases('blank lines between the iteration cap arm line and the line that carries its text', PLAN_PHASE, COUPLING,
      (text, gap) => text.split(`${ARM}\n\n`).join(`${ARM}\n${'\n'.repeat(gap)}`), 3, /the iteration cap arm lacks/);
    // The numbered dimensions kept: the later headings lose their label (the heading text stays).
    const keepLabels = (count) => (text) => {
      const labels = couplingWalkers.dimensionLabels(sectionizerLib.stripFencedCode(text).text);
      assert.ok(labels.length >= count, `the agent has ${labels.length} numbered dimensions`);
      return labels.slice(count).reduce((out, label) => out.split(`\n## Dimension ${label}: `).join(`\n## Dimension ${label} `), text);
    };
    for (const [count, ok] of [[11, false], [12, true], [13, true]]) {
      test(`${count} numbered dimensions ${ok ? 'satisfy' : 'are below the floor of'} plan-checker-coupling`, (t) => {
        const findings = runEdits(t, [[CHECKER, keepLabels(count)]], COUPLING);
        if (ok) {
          assert.deepEqual(findings, [], messagesOf(findings));
        } else {
          assert.equal(findings.length, 1, messagesOf(findings));
          assert.ok(findings[0].message.includes('expected at least 12 numbered dimensions, found 11'), messagesOf(findings));
        }
      });
    }
    oneFinding('the tier probe erased is one finding', EXPLORE, eraseAll('--pick tier'), EXPLORE_ID, 'the tier floor needs the resolved tier as its trigger');
    oneFinding('RESEARCHER_TIER erased is one finding', EXPLORE, eraseAll('RESEARCHER_TIER'), EXPLORE_ID, 'the floor must reference RESEARCHER_TIER, the single signal');
    oneFinding('a non-exempt tier in the Dimension 3b example is one finding', CHECKER, inThreeB(swap('severity: info', 'severity: warning')), COUPLING, 'example issue must carry the tier revision-loop.md exempts');
    oneFinding('a drifted first enum copy of explore.md is one finding and blames nobody else', EXPLORE, (text) => {
      const from = ' | non-authoritative source | ';
      const at = text.indexOf(from);
      return text.slice(0, at) + ' | non-authoritative sources | ' + text.slice(at + from.length);
    }, EXPLORE_ID, 'the copies within explore.md are not byte-identical');
    passesHeavy('the guard-list end marker at the top of the file is searched after the start marker', EXPLORE, (text) => `**Untagged findings.**\n${text}`, EXPLORE_ID);
    oneFinding('an indented yaml fence with a warning severity is counted', CHECKER, inThreeB(append('    ```yaml\n    severity: warning\n    ```')), COUPLING, 'carries severity: warning');
    passesHeavy('the real yaml example opened under a list-item indent still counts', CHECKER, inThreeB(swap('```yaml', '    ```yaml')), COUPLING);
    const SECTIONIZER_PATH = 'gsd-core/bin/lib/markdown-sectionizer.cjs';
    const TEXT_LINES_PATH = 'gsd-core/bin/lib/text-lines.cjs';
    const throwing = (name, member) => `({ ...require(${LIB(name)}), ${member}: () => { throw new Error('boom'); } })`;
    for (const [title, factory, file] of [
      ['a stripFencedCode that throws', `real.walkers.buildCheck({ loadSectionizer: () => ${throwing('markdown-sectionizer.cjs', 'stripFencedCode')}, loadTextLines: () => require(${LIB('text-lines.cjs')}) })`, SECTIONIZER_PATH],
      ['a scanFencedBlocks that throws', `real.walkers.buildCheck({ loadSectionizer: () => ${throwing('markdown-sectionizer.cjs', 'scanFencedBlocks')}, loadTextLines: () => require(${LIB('text-lines.cjs')}) })`, SECTIONIZER_PATH],
      ['a splitLines that throws', `real.walkers.buildCheck({ loadSectionizer: () => require(${LIB('markdown-sectionizer.cjs')}), loadTextLines: () => ${throwing('text-lines.cjs', 'splitLines')} })`, TEXT_LINES_PATH],
    ]) {
      test(`${title} is one finding of the plan-checker-coupling contract`, (t) => {
        const findings = seamRun(t, COUPLING, factory);
        assert.equal(findings.length, 1, messagesOf(findings));
        assert.equal(findings[0].file, file);
        assert.match(findings[0].message, /threw: boom/);
      });
    }
    test('a library that throws null is one finding on the library path', (t) => {
      const findings = seamRun(t, COUPLING, `real.walkers.buildCheck({ loadSectionizer: () => ({ ...require(${LIB('markdown-sectionizer.cjs')}), stripFencedCode: () => { throw null; } }), loadTextLines: () => require(${LIB('text-lines.cjs')}) })`);
      assert.equal(findings.length, 1, messagesOf(findings));
      assert.equal(findings[0].file, SECTIONIZER_PATH);
      assert.match(findings[0].message, /threw: null/);
    });
    // Fence shapes where the owner's grammar and the old exact-line loop differ: a tilde or four-backtick yaml fence counts for the owner (stricter,
    // harmless), and a yaml-looking line inside a text block is not an example for the owner (the old loop counted it).
    oneFinding('a tilde yaml fence with a warning severity is counted', CHECKER, inThreeB(append('~~~yaml\nseverity: warning\n~~~')), COUPLING, 'carries severity: warning');
    oneFinding('a four-backtick yaml fence with a warning severity is counted', CHECKER, inThreeB(append('````yaml\nseverity: warning\n````')), COUPLING, 'carries severity: warning');
    passesHeavy('a yaml-looking line inside a text block is not an example', CHECKER, inThreeB(append('```text\n```yaml\nseverity: warning\n```')), COUPLING);
    test('a splitLines that throws is one finding of the edge-probe-spec-phase-contract contract', (t) => {
      const findings = seamRun(t, EDGE, `real.walkers.buildCheck({ loadTextLines: () => ${throwing('text-lines.cjs', 'splitLines')} })`);
      assert.equal(findings.length, 1, messagesOf(findings));
      assert.equal(findings[0].file, TEXT_LINES_PATH);
      assert.match(findings[0].message, /threw: boom/);
    });

    // ---- properties: each walker against the pattern or loop it replaced. The generators draw random tokens and chains of the pattern's own
    // parts (each sometimes cut short, with padding across every bound), and every property fails unless it saw both an accepted and a
    // rejected string, so it can never compare false with false. Domain notes: the contracts read LF text (the engine normalises CRLF), so
    // the generated texts hold no CR LF pair; the severity tiers of the yaml blocks are compared on simple fences, where the old loop and the
    // fence owner agree.
    {
      const fc = require('./helpers/fast-check-setup.cjs');
      const walks = require('../scripts/static-checks/text-contracts/lib/bounded-walks.cjs');
      const parallel = require('../scripts/static-checks/text-contracts/parallel-dependent-plans.cjs').walkers;
      const explore = require('../scripts/static-checks/text-contracts/explore-command.cjs').walkers;
      const coupling = require('../scripts/static-checks/text-contracts/plan-checker-coupling.cjs').walkers;
      const edge = require('../scripts/static-checks/text-contracts/edge-probe-spec-phase-contract.cjs').walkers;
      const { asciiLower } = require('../scripts/static-checks/text-contracts/lib/ascii-lower.cjs');
      const { LINE_ENDS } = require('../scripts/static-checks/text-contracts/lib/line-ends.cjs');
      const sectionizer = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');
      const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
      const strings = (tokens, maxLength = 10) => fc.array(fc.constantFrom(...tokens), { maxLength }).map((parts) => parts.join(''));
      // The parts in order, each cut short one time in five, with a gap and 0..270 filler characters after it.
      const chain = (parts, gaps, maxPad = 270) => fc.tuple(...parts.map(() => fc.tuple(fc.integer({ min: 0, max: 4 }), fc.constantFrom(...gaps), fc.oneof({ weight: 4, arbitrary: fc.constant(0) }, { weight: 2, arbitrary: fc.integer({ min: 1, max: maxPad }) }))))
        .map((picks) => picks.map(([cut, gap, pad], i) => (cut === 0 && parts[i].length > 1 ? parts[i].slice(0, -1) : parts[i]) + gap + 'x'.repeat(pad)).join(''));
      const lineChain = (parts, fillers) => fc.tuple(...parts.map(() => fc.tuple(fc.integer({ min: 0, max: 4 }), fc.array(fc.constantFrom(...fillers), { maxLength: 2 }))))
        .map((picks) => picks.map(([cut, extra], i) => [cut === 0 ? parts[i].slice(0, -1) : parts[i], ...extra].join('\n')).join('\n'));
      const lf = (s) => s.split('\r\n').join('\n');
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
      const stops = ['', ' ', 'x', '.', '\n', '\r', '\u2028', '\u2029'];
      const DOT = new Set(['.']);
      const NONE = new Set();

      test('property: the shared bounded walks agree with the patterns they replaced', () => {
        agrees('collapse', strings(['a', ' ', '\n', '\t', '\r', '\u00a0', '\u2028', '\ufeff', '\u3000', 'b'], 9), (s) => [walks.collapseWhitespace(s), s.replace(/\s+/g, ' ')], (expected) => expected.includes(' '));
        agrees('word run', fc.oneof(strings(['zero', 'no', 'not', 'never', 'z', 'nothing', '_', '-', ' ', '1', '.'], 7), chain(['zero'], ['', ' ', '_', '-', 'x'], 3)),
          (s) => [walks.hasWordRun(s, ['zero', 'no', 'not', 'never']), /\b(?:zero|no|not|never)\b/.test(s)]);
        agrees('word-bounded phrase', fc.oneof(strings(['RESEARCHER_TIER', 'x', '_', '-', ' ', '1', 'RESEARCHER', 'TIER'], 7), chain(['RESEARCHER_TIER'], ['', ' ', '_', '-', 'x'], 3)),
          (s) => [walks.includesBounded(s, 'RESEARCHER_TIER'), /\bRESEARCHER_TIER\b/.test(s)]);
        agrees('word-bounded phrase with blanks', strings(['do not suppress', 'do not', 'suppress', ' ', 'x', '_', '.'], 7), (s) => [walks.includesBounded(s, 'do not suppress'), /\bdo not suppress\b/.test(s)]);
        agrees('line-bounded pair', fc.oneof(strings(['first', 'second', 'a', ' ', '\n', '\r', '\u2028', '_', '.'], 8), chain(['first', 'second'], stops)),
          (s) => [walks.precedesBounded(s, 'first', 'second', LINE_ENDS), /first[^\n\r\u2028\u2029]*second/.test(s)]);
        agrees('bounded pair, both word-bounded', fc.oneof(strings(['first', 'second', 'a', ' ', '\n', '_', '.', '1'], 8), chain(['first', 'second'], ['', ' ', '_', 'x', '.', '1'])),
          (s) => [walks.precedesBounded(s, 'first', 'second', DOT, { first: true, second: true }), /\bfirst\b[^.]*\bsecond\b/.test(s)]);
        agrees('bounded pair, second word-bounded', fc.oneof(strings(['first', 'second', 'a', ' ', '_', '.', '1'], 8), chain(['first', 'second'], ['', ' ', '_', 'x', '.', '1'])),
          (s) => [walks.precedesBounded(s, 'first', 'second', DOT, { second: true }), /first[^.]*\bsecond\b/.test(s)]);
        agrees('window of 60 without a full stop', fc.oneof(strings(['unresolved', 'never', 'crystalliz', 'x', '.', ' '], 8), chain(['unresolved', 'never', 'crystalliz'], ['', ' ', '.', 'x'], 70)),
          (s) => [walks.windowChain(s, ['unresolved', 'never', 'crystalliz'], 60, DOT), /unresolved[^.]{0,60}never[^.]{0,60}crystalliz/.test(s)]);
        agrees('window of 60, two parts', fc.oneof(strings(['carry', 'disposition', 'x', '.', ' '], 8), chain(['carry', 'disposition'], ['', ' ', '.', 'x'], 70)),
          (s) => [walks.windowChain(s, ['carry', 'disposition'], 60, DOT), /carry[^.]{0,60}disposition/.test(s)]);
        agrees('window of 500 over any character', fc.oneof(strings(['COVERAGE', 'JSON.parse', 'x', '.', '\n'], 8), chain(['COVERAGE', 'JSON.parse'], ['', ' ', '.', '\n'], 520)),
          (s) => [walks.windowChain(s, ['COVERAGE', 'JSON.parse'], 500, NONE), /COVERAGE[\s\S]{0,500}JSON\.parse/.test(s)]);
        agrees('window of 500, the reversed arm', fc.oneof(strings(['COVERAGE', '$COVERAGE', 'JSON.parse', 'x', '\n'], 8), chain(['JSON.parse', '$COVERAGE'], ['', ' ', '\n'], 520)),
          (s) => [walks.windowChain(s, ['JSON.parse', '$COVERAGE'], 500, NONE), /JSON\.parse[\s\S]{0,500}\$COVERAGE/.test(s)]);
      });

      test('property: the parallel-dependent-plans walkers agree with the code they replaced', () => {
        const oldParagraph = (body) => {
          const lines = body.split(/\r?\n/);
          const first = lines.findIndex((line) => line.trimStart().startsWith('**Rule:**'));
          if (first === -1) return null;
          const paragraph = [];
          for (let i = first; i < lines.length && lines[i].trim() !== ''; i += 1) paragraph.push(lines[i].trim());
          return paragraph.join(' ');
        };
        const oldSentences = (paragraph) => paragraph.split(/(?<=[.;])\s+/).filter((sentence) => sentence.trim() !== '');
        const CLAUSES = [
          ['wave scope', /\bwave\b/i], ['files_modified subject', /files_modified/], ['prohibition', /\b(?:zero|no|not|never)\b/i],
          ['overlap predicate', /overlap|shar(?:e|es|ing)|conflict|touch(?:es|ing)?/i],
        ];
        const oldMissing = (body) => {
          const paragraph = oldParagraph(body);
          if (paragraph === null) return ['**Rule:** paragraph'];
          let closest = CLAUSES.map(([name]) => name);
          for (const sentence of oldSentences(paragraph)) {
            const missing = CLAUSES.filter(([, pattern]) => !pattern.test(sentence)).map(([name]) => name);
            if (missing.length < closest.length) closest = missing;
            if (closest.length === 0) break;
          }
          return closest;
        };
        const words = ['**Rule:**', 'Same-wave', 'wave', 'Wave', 'waves', 'files_modified', 'zero', 'No', 'nothing', 'overlap', 'shares', 'conflicting', 'touches', ' ', ' ', '.', ';', '\n', '\n\n', '   \n', '\t', '\u00a0', 'x', 'plans'];
        const bodies = fc.oneof(strings(words, 14).map(lf), chain(['**Rule:** Same-wave plans', ' must have zero', ' files_modified', ' overlap.'], ['', ' ', '\n', '. ', '; '], 3).map(lf));
        agrees('paragraph', bodies, (s) => [parallel.ruleParagraph(s), oldParagraph(s)], (expected) => expected !== null);
        agrees('sentences', strings(words, 14), (s) => [parallel.ruleSentences(s), oldSentences(s)], (expected) => expected.length > 1);
        agrees('missing clauses', bodies, (s) => [parallel.missingRuleClauses(s), oldMissing(s)], (expected) => expected.length === 0);
        const oldRegion = (text) => {
          const marker = text.indexOf('intra-wave') !== -1 ? text.indexOf('intra-wave') : text.indexOf('files_modified overlap');
          const spawn = text.indexOf('Spawn executor agents');
          if (marker === -1) return { missing: 'marker' };
          if (spawn === -1) return { error: true };
          if (marker >= spawn) return { error: true };
          return { text: text.slice(marker, spawn) };
        };
        agrees('overlap region', fc.oneof(strings(['intra-wave', 'files_modified overlap', 'Spawn executor agents', 'x', '\n'], 7), chain(['files_modified overlap', 'Spawn executor agents'], ['', 'x', '\n'], 5)),
          (s) => {
            const actual = parallel.overlapRegion(s);
            return [actual.error === undefined ? actual : { error: true }, oldRegion(s)];
          }, (expected) => expected.text !== undefined);
      });

      test('property: the explore-command walkers agree with the patterns they replaced', () => {
        const oldRegion = (text, a, b) => {
          const start = text.indexOf(a);
          const end = text.indexOf(b);
          return start !== -1 && end !== -1 && start < end ? text.slice(start, end) : null;
        };
        agrees('region', strings(['## Step 3', '## Step 4', 'x', '\n'], 7), (s) => [explore.regionOf(s, '## Step 3', '## Step 4').text ?? null, oldRegion(s, '## Step 3', '## Step 4')], (expected) => expected !== null);
        agrees('spawn', strings(['Agent(', 'subagent_type="gsd-phase-researcher"', 'x', '\n'], 7), (s) => {
          const spawn = explore.spawnOf(s);
          const agent = s.indexOf('Agent(');
          const type = s.indexOf('subagent_type="gsd-phase-researcher"');
          const ok = agent !== -1 && type !== -1 && agent < type;
          return [spawn.error === undefined ? [spawn.prompt, spawn.reach] : null, ok ? [s.slice(agent, type), s.slice(agent, type + 200)] : null];
        }, (expected) => expected !== null);
        agrees('guard region', strings(['Two guards ride with it:', '**Untagged findings.**', 'x', '\n'], 7), (s) => {
          const start = s.indexOf('Two guards ride with it:');
          const end = s.indexOf('**Untagged findings.**', start);
          const valid = start !== -1 && end !== -1 && start < end;
          return [explore.regionAfter(s, 'Two guards ride with it:', '**Untagged findings.**').text ?? null, valid ? s.slice(start, end) : null];
        }, (expected) => expected !== null);
        const ENUM = /`?unverifiable`?(?: \| `?[^`|{}()]+`?){3} \| `?untagged — disposition not reported`?/g;
        const oldEnums = (text) => [...text.replace(/\s+/g, ' ').matchAll(ENUM)].map((m) => m[0].replace(/`/g, '').split('|').map((part) => part.trim()));
        const TAIL = 'untagged — disposition not reported';
        agrees('ledger enums', fc.oneof(strings(['unverifiable', '`', ' | ', '|', 'a', 'b c', TAIL, '{', '(', ')', ' ', '\n', '\t', 'x'], 12),
          chain(['unverifiable', ' | a', ' | b c', ' | d', ` | ${TAIL}`], ['', '`', ' ', '\n', ' `', '` ', '(', '|'], 3)),
        (s) => [explore.ledgerEnums(s), oldEnums(s)], (expected) => expected.length > 0);
        const oldClause = (text) => {
          const marker = '- **Tier floor**';
          const start = text.indexOf(marker);
          if (start === -1) return null;
          const rest = text.slice(start + 1);
          const end = rest.indexOf('\n- **');
          return (end === -1 ? rest : rest.slice(0, end)).replace(/\s+/g, ' ');
        };
        agrees('tier floor clause', strings(['- **Tier floor**', '\n- **', '- **', 'x', ' ', '\n', '\t'], 8), (s) => [explore.tierFloorClause(s), oldClause(s)], (expected) => expected !== null);
        agrees('authoritative refute', fc.oneof(strings(['[refute:', ']', '(', ')', ' ', 'authoritative', 'AUTHORITATIVE', 'x', '\n', '['], 9),
          chain(['[refute: s]', ' (', 'a source AUTHORITATIVE', ')'], ['', ' ', '\n', ']', ')'], 3)),
        (s) => [explore.hasAuthoritativeRefute(s), /\[refute:[^\]]*\]\s*\([^)]*authoritative[^)]*\)/i.test(s)]);
        agrees('conflict and ledger', fc.oneof(strings(['conflict', 'ledger', 'xledger', 'ledgerx', '_ledger', '.', ' ', 'x'], 8), chain(['conflict', 'ledger'], ['', ' ', '.', 'x', '_'], 3)),
          (s) => [explore.conflictLedger(s), /conflict[^.]*\bledger\b|\bledger\b[^.]*conflict/.test(s)]);
        agrees('top-level bullets', strings(['- **', '  - **', '-', '**', 'x', '\n', '\r', '\u2028', '\u2029', ' '], 9), (s) => [explore.topLevelBullets(s), (s.match(/^- \*\*/gm) || []).length], (expected) => expected > 0);
      });

      test('property: the plan-checker-coupling walkers agree with the patterns they replaced', () => {
        const headings = ['## Dimension 3: ', '## Dimension 3b: ', '## Dimension 4: ', 'x', '\n', '\r', '\u2028', '\u2029', ' ', '## Dimension 3b:', 'Undeclared Coupling'];
        const search = (pattern) => (text) => text.search(pattern);
        agrees('heading index', strings(headings, 7), (s) => [coupling.headingIndex(s, '## Dimension 3: '), search(/^## Dimension 3: /m)(s)], (expected) => expected !== -1);
        agrees('heading index of 3b', strings(headings, 7), (s) => [coupling.headingIndex(s, '## Dimension 3b: '), search(/^## Dimension 3b: /m)(s)], (expected) => expected !== -1);
        agrees('exact line index', strings(['### gsd-plan-checker', ' ', 'x', '\n', '\r', '\u2028', '\u2029', '### gsd-plan-checker2'], 7), (s) => [coupling.exactLineIndex(s, '### gsd-plan-checker'), search(/^### gsd-plan-checker$/m)(s)], (expected) => expected !== -1);
        agrees('coupled title', strings(headings, 7), (s) => [coupling.coupledTitle(s), s.match(/^## Dimension 3b: (.+)$/m)?.[1] ?? null], (expected) => expected !== null);
        const gapDomain = (parts) => fc.oneof(strings([...parts, ' ', '\n', '\t', '\r', '\u00a0', '\u2028', 'x', ':'], 8), chain(parts, ['', ' ', '\n', '\t', '\u00a0', 'x'], 3));
        agrees('Scope pair', gapDomain(['Scope:', 'PLAN pairs, not tasks']), (s) => [coupling.leadGapTail(s, 'Scope:', 'PLAN pairs, not tasks', 0), /Scope:\s*PLAN pairs, not tasks/.test(s)]);
        agrees('severity tier', gapDomain(['severity:', 'blocker']), (s) => [coupling.leadGapTail(s, 'severity:', 'blocker', 0), /severity:\s*blocker/.test(s)]);
        agrees('dimension key', gapDomain(['dimension:', 'dependency_correctness']), (s) => [coupling.leadGapTail(s, 'dimension:', 'dependency_correctness', 0), /dimension:\s*dependency_correctness/.test(s)]);
        agrees('applied exemption', gapDomain(['note the applied', 'exemption as its own `info` advisory']), (s) => [coupling.leadGapTail(s, 'note the applied', 'exemption as its own `info` advisory', 1), /note the applied\s+exemption as its own `info` advisory/.test(s)]);
        agrees('mutable resource', gapDomain(['mutable', 'resource']).map((s) => s), (s) => [coupling.leadGapTail(asciiLower(s), 'mutable', 'resource', 1), /mutable\s+resource/i.test(s)]);
        agrees('never blocker', fc.oneof(strings(['never', 'NEVER', 'a', 'A', 'blocker', 'Blocker', ' ', '\n', '\t', 'x', '\u00a0'], 8), chain(['never', 'a', 'blocker'], ['', ' ', '\n', '\t', ' \n ', 'x'], 3)),
          (s) => [coupling.neverBlocker(asciiLower(s)), /never\s+(a\s+)?blocker/i.test(s)]);
        agrees('ordered items', strings(['1. ', '12. ', '1.', '1 ', '. ', 'x', '\n', '\r', '\u2028', '\u2029', ' ', '9'], 9), (s) => [coupling.countOrderedItems(s), (s.match(/^\d+\. /gm) || []).length], (expected) => expected > 0);
        agrees('coupling checklist', fc.oneof(strings(['- [ ] ', 'coupling', 'COUPLING', 'x', ' ', '\n', '\r', '\u2028', '\u2029', '- [x] '], 8), lineChain(['- [ ] coupling'], ['- [ ] x', 'coupling', ''])),
          (s) => [coupling.hasCouplingChecklist(s), /^- \[ \] .*coupling.*$/im.test(s)]);
        agrees('severity of a line', fc.oneof(strings(['severity:', 'info', 'Blocker', ' ', '\t', '\r', '\u2028', 'x', '_', ':'], 8), chain(['severity:', 'Info'], ['', ' ', '\t', ':', 'x'], 3)),
          (s) => [coupling.severityOf(s), s.match(/severity:\s*(\w+)/)?.[1].toLowerCase() ?? null], (expected) => expected !== null);
        agrees('exempt tier', fc.oneof(strings(['If PASSED or only ', 'INFO', '-level issues', '-level', ' ', 'x', '_'], 7), chain(['If PASSED or only ', 'INFO', '-level issues'], ['', ' ', '_', 'x'], 3)),
          (s) => [coupling.exemptTier(s), s.match(/If PASSED or only (\w+)-level issues/)?.[1].toLowerCase() ?? null], (expected) => expected !== null);
        agrees('dimension labels', fc.oneof(strings(['## Dimension ', '3', '12', 'b', 'B', ': ', ':', 'x', '\n', '\r', '\u2028', ' '], 10), chain(['## Dimension ', '3b', ': x'], ['', '\n', '\r', ' ', 'x'], 2)), (s) => [coupling.dimensionLabels(s), [...s.matchAll(/^## Dimension ([0-9]+[a-z]?): /gm)].map((m) => m[1])], (expected) => expected.length > 0);
        agrees('table labels', strings(['| ', '3', '12', 'b', ' | ', '|', 'x', '\n', '\r', '\u2028', ' '], 10), (s) => [coupling.tableLabels(s), [...s.matchAll(/^\| ([0-9]+[a-z]?) \| /gm)].map((m) => m[1])], (expected) => expected.length > 0);
        const oldTiers = (span) => {
          const tiers = [];
          let inYaml = false;
          for (const line of splitLines(span)) {
            if (line.trim() === '```yaml') { inYaml = true; continue; }
            if (inYaml && line.trim() === '```') { inYaml = false; continue; }
            const m = inYaml ? line.match(/severity:\s*(\w+)/) : null;
            if (m) tiers.push(m[1].toLowerCase());
          }
          return tiers;
        };
        // Well-formed fences: a bare ``` opens a block for the fence owner, where the old loop only toggled on a yaml opener, so the domain
        // holds yaml and text blocks (the last one possibly never closed) and plain lines between them; fence lines carry any indent (the
        // contract trims leading blanks before scanning, as the old loop trimmed every line).
        const yamlContent = fc.array(fc.constantFrom('  severity: info', 'severity: BLOCKER', '  severity:', 'x', '', 'issue:', 'severity: warning'), { maxLength: 3 });
        const fenced = fc.tuple(fc.array(fc.tuple(fc.constantFrom('yaml', 'text', 'plain'), yamlContent, fc.constantFrom('', '  ', '    ', '\t')), { maxLength: 4 }), fc.boolean()).map(([blocks, closeLast]) => {
          const lines = [];
          blocks.forEach(([kind, content, indent], i) => {
            if (kind === 'plain') lines.push(...content);
            else lines.push(`${indent}\`\`\`${kind}`, ...content, ...(i === blocks.length - 1 && !closeLast ? [] : [`${indent}\`\`\``]));
          });
          return lines.join('\n');
        });
        agrees('yaml severity tiers', fenced,
          (s) => [coupling.yamlSeverityTiers(s, { splitLines, scanFencedBlocks: sectionizer.scanFencedBlocks }), oldTiers(s)], (expected) => expected.length > 0);
        agrees('arm window', fc.array(fc.constantFrom('**If iteration_count >= 3:**', 'a', 'b', ''), { maxLength: 8 }), (lines) => {
          const at = lines.findIndex((line) => line.startsWith('**If iteration_count >= 3:**'));
          return [coupling.armWindow(lines, '**If iteration_count >= 3:**', 5), at === -1 ? null : lines.slice(at, at + 5).join(' ')];
        }, (expected) => expected !== null);
      });

      test('property: the edge-probe-spec-phase-contract walkers agree with the code they replaced', () => {
        const oldBlock = (content) => {
          const startIdx = content.indexOf('## Step 5.5');
          if (startIdx === -1) {
            const altIdx = content.indexOf('Step 5.5');
            if (altIdx === -1) return '';
            const rest = content.slice(altIdx + 'Step 5.5'.length);
            const nextHeading = rest.search(/\n## |\nStep \d/);
            if (nextHeading === -1) return content.slice(altIdx);
            return content.slice(altIdx, altIdx + 'Step 5.5'.length + nextHeading);
          }
          const rest = content.slice(startIdx + '## Step 5.5'.length);
          const nextHeading = rest.search(/\n## /);
          if (nextHeading === -1) return content.slice(startIdx);
          return content.slice(startIdx, startIdx + '## Step 5.5'.length + nextHeading);
        };
        agrees('Step 5.5 block', strings(['## Step 5.5', 'Step 5.5', '\n## ', '\nStep 1', '\nStep x', 'x', ' ', '\n'], 8), (s) => [edge.step55Block(s) ?? '', oldBlock(s)], (expected) => expected !== '');
        const NODE = /node\s+["$].*[Ee][Dd][Gg][Ee][-_][Pp][Rr][Oo][Bb][Ee]/;
        agrees('node invocation', fc.oneof(strings(['node', ' ', '"', '$', 'edge-probe', 'EDGE_PROBE', 'Edge_Probe', 'edge probe', 'x', '\n', '\r', '\u2028', '\u2029'], 8),
          chain(['node', ' "', 'x', 'edge-probe'], ['', ' ', '\n', '\r', '\u2028'], 3)),
        (s) => [edge.nodeInvocationIndex(s), s.search(NODE)], (expected) => expected !== -1);
        agrees('redirect', strings(['>', ' ', '\n', '\t', '"$REQS_JSON"', '"$REQS_JSO"', 'x', '>>', '\u00a0'], 8), (s) => [edge.redirectIndex(s, '"$REQS_JSON"'), s.search(/>\s*"\$REQS_JSON"/)], (expected) => expected !== -1);
        agrees('pinned prefix', fc.oneof(strings(['npm', ' ', '--prefix', '"', '$', '{', '_', 'GSD_RT', 'x', '\t'], 9), chain(['npm', ' --prefix', ' "', '$', '{', '_', 'GSD_RT'], ['', ' ', '\t', '"', 'x'], 2)),
          (s) => [edge.pinsPrefix(s), /npm\s+--prefix\s+"?\$?\{?_?GSD_RT/.test(s)]);
        agrees('coverage reference', strings(['$COVERAGE', '$COVERAGEX', 'COVERAGE', '_', ' ', '1', 'x', '$'], 7), (s) => [edge.refsCoverage(s), /\$COVERAGE\b/.test(s)]);
        agrees('backstop mark', strings(['mark `backstop`', ';', ' ', 'x', '\n'], 6), (s) => [edge.marksBackstop(s), /mark `backstop`[^;]/.test(s)]);
        const oldRenders = (lines) => lines.some((raw) => {
          const line = raw.trim();
          if (!/\$COVERAGE\b/.test(line)) return false;
          if (line.startsWith('#')) return false;
          if (!/^(printf|echo|cat)\b/.test(line)) return false;
          if (/=\s*\$\(/.test(line)) return false;
          if (/\|\s*node\b/.test(line)) return false;
          return true;
        });
        const renderLines = ['printf \'%s\\n\' "$COVERAGE"', 'echo "$COVERAGE"', 'cat "$COVERAGE"', 'printfx "$COVERAGE"', '# printf "$COVERAGE"', 'X=$(printf "$COVERAGE")', 'printf "$COVERAGE" | node -e 1',
          'printf "$COVERAGE" |\tnode', 'printf "$COVERAGE" | nodejs', 'printf "$COVERAGE" y= $(z)', 'x "$COVERAGE"', '  echo "$COVERAGE"  ', '\u00a0cat "$COVERAGE"', 'echo "$COVERAGEX"', ''];
        agrees('bare render', fc.array(fc.constantFrom(...renderLines), { maxLength: 4 }), (lines) => [edge.rendersReport(lines), oldRenders(lines)]);
        const oldLeaks = (lines) => {
          const createIdx = lines.findIndex((l) => /REQS_JSON=\$\(mktemp/.test(l));
          if (createIdx === -1) return { error: true };
          const afterCreate = lines.slice(createIdx + 1);
          const endOffset = afterCreate.findIndex((l) => /^rm -f "\$REQS_JSON"/.test(l));
          if (endOffset === -1) return { error: true };
          let cleanedInBranch = false;
          const leaks = [];
          for (const line of afterCreate.slice(0, endOffset)) {
            if (/\bthen\b|^\s*else\b|^\s*elif\b/.test(line)) cleanedInBranch = false;
            if (/rm -f "\$REQS_JSON"/.test(line)) cleanedInBranch = true;
            if (/^\s*exit\s+\d+/.test(line) && !cleanedInBranch) leaks.push(line.trim());
          }
          return { leaks };
        };
        const leakLines = ['REQS_JSON=$(mktemp x)', 'rm -f "$REQS_JSON"', '  rm -f "$REQS_JSON"', 'if x; then', 'else', '  else', 'elif y; then', '  exit 1', 'exit 2', 'exit', 'exit x', '  exit  7', 'x', 'thence', '# then', 'elsewhere', '\telse', 'then'];
        agrees('exit leaks', fc.oneof(fc.array(fc.constantFrom(...leakLines), { maxLength: 10 }), lineChain(['REQS_JSON=$(mktemp x)', 'if x; then', '  exit 1', 'rm -f "$REQS_JSON"'], leakLines).map((text) => text.split('\n'))),
          (lines) => {
            const actual = edge.exitLeaks(lines);
            return [actual.error === undefined ? actual : { error: true }, oldLeaks(lines)];
          }, (expected) => expected.leaks !== undefined && expected.leaks.length > 0);
        agrees('build invocations', fc.array(fc.constantFrom('npm --prefix x run build:lib', '  npm run build:lib', 'echo npm run build:lib', 'npm run other', '', 'npm', '\tnpm build:lib'), { maxLength: 6 }),
          (lines) => [edge.buildInvocations(splitLines(lines.join('\n'))), lines.join('\n').split('\n').filter((l) => l.trim().startsWith('npm') && l.includes('build:lib'))], (expected) => expected.length > 0);
      });
    }
  }

  // A file a batch 12 contract reads that is gone from the tree is one finding for that file.
  for (const [rel, contract] of [
    ['.github/workflows/pr-target-validator.yml', 'adr-230-pr-target-policy'],
    ['gsd-core/workflows/code-review.md', 'code-review-summary-parser'],
    ['gsd-core/workflows/code-review-fix.md', 'code-review-summary-parser'],
    ['commands/gsd/audit-fix.md', 'audit-fix-command'],
    ['gsd-core/workflows/audit-fix.md', 'audit-fix-command'],
    ['commands/gsd/progress.md', 'progress-forensic'],
    ['gsd-core/workflows/progress.md', 'progress-forensic'],
    ['gsd-core/workflows/progress/steps/forensic-audit.md', 'progress-forensic'],
    ['docs/COMMANDS.md', 'progress-forensic'],
    ['commands/gsd/phase.md', 'edit-phase'],
    ['gsd-core/workflows/edit-phase.md', 'edit-phase'],
    ['docs/INVENTORY.md', 'edit-phase'],
    ['docs/INVENTORY-MANIFEST.json', 'edit-phase'],
    ['.github/workflows/release.yml', 'adr-218-release-version-validation'],
    ['gsd-core/references/tdd.md', 'tdd-single-statement'],
    ['agents/gsd-executor.md', 'tdd-single-statement'],
    ['gsd-core/workflows/execute-plan.md', 'tdd-single-statement'],
    ['gsd-core/references/execute-mvp-tdd.md', 'tdd-single-statement'],
    ['gsd-core/workflows/execute-phase.md', 'tdd-single-statement'],
    ['gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md', 'tdd-single-statement'],
    ['agents/gsd-executor.md', 'mcp-tool-inheritance'],
    ['agents/gsd-planner.md', 'mcp-tool-inheritance'],
    ['agents/gsd-phase-researcher.md', 'mcp-tool-inheritance'],
    ['agents/gsd-project-researcher.md', 'mcp-tool-inheritance'],
    ['agents/gsd-ui-researcher.md', 'mcp-tool-inheritance'],
    ['docs/reference/agents.md', 'agent-classification-parity'],
    ['docs/INVENTORY.md', 'agent-classification-parity'],
  ]) {
    test(`${rel} removed from the tree is a finding for ${contract}`, (t) => {
      const root = copyOfRepoFiles(t, HEAVY.includes(rel) ? HEAVY : []);
      fs.unlinkSync(path.join(root, ...rel.split('/')));
      const findings = runShipped(root, [contract]);
      assert.ok(findings.some((f) => f.file === rel && /cannot read the file/.test(f.message)), JSON.stringify(findings));
    });
  }
});
