'use strict';

// The autonomous audit-to-fix pipeline: the command file (frontmatter name, description, allowed-tools with Agent,
// argument-hint showing `--source <audit-uat>` and not the unsupported verify source, `type: prompt`, the workflow
// reference, an <objective> section and the four flags) and the workflow file (its purpose, process, success-criteria and
// available-agent-types sections listing gsd-executor, the flag defaults, the auto-fixable and manual-only
// classification with its heuristics, --dry-run stopping before the fix loop, the atomic commit with the finding ID, the
// test-then-commit order, the revert and stop on a failed test). Where the old test looked for a bare word anywhere in the
// file (`5`, `medium`, `audit-uat`, `commit` with `finding`, `{ID}` with `commit`, `stop` with `fix-failed`, `dry-run` with
// `stop` or `exit`), the contract looks for the pair on one line, which is where the real file carries each; the frontmatter
// checks read the closed frontmatter block, where the test read the text between the first two `---`.
// Was tests/audit-fix-command.test.cjs.

const { asciiLower } = require('./lib/ascii-lower.cjs');

const COMMAND = 'commands/gsd/audit-fix.md';
const WORKFLOW = 'gsd-core/workflows/audit-fix.md';

// Some line holds every one of the words (the pair a bare whole-file word could not tie together).
const lineHasAll = (text, words) => text.split('\n').some((line) => words.every((word) => line.includes(word)));
// Some line holds `first` and one of `others`.
const lineHasAny = (text, first, others) => text.split('\n').some((line) => line.includes(first) && others.some((word) => line.includes(word)));

// The first `npm test` and the first `git commit` from the first `fix-loop` on, tests first (a missing fix-loop counts from
// the start of the file, as indexOf with -1 does).
function testBeforeCommit(text) {
  const start = text.indexOf('fix-loop');
  const testAt = text.indexOf('npm test', start);
  const commitAt = text.indexOf('git commit', start);
  // No `npm test` anywhere is reported by the assertion that asks for it; one only before the fix loop is reported here.
  if (testAt === -1) return !text.includes('npm test') || 'no `npm test` in the fix loop';
  if (commitAt === -1) return 'no `git commit` in the fix loop';
  return testAt < commitAt || '`npm test` comes after `git commit`';
}

// The first dry-run precedes the first fix-loop. No dry-run, or no fix-loop, is reported by the assertion that asks for it.
function dryRunBeforeFixLoop(text) {
  const dryRun = text.indexOf('dry-run');
  if (dryRun === -1) return true;
  const fixLoop = text.indexOf('fix-loop');
  if (fixLoop === -1) return true;
  return dryRun < fixLoop || 'dry-run comes after fix-loop';
}

module.exports = {
  id: 'audit-fix-command',
  walkers: { lineHasAll, lineHasAny, testBeforeCommit, dryRunBeforeFixLoop },
  check(ctx) {
    const command = ctx.doc(COMMAND);
    command.frontmatter()
      .has('name: gsd:audit-fix', 'the command name must be gsd:audit-fix')
      .has('description:', 'the command must have a description in its frontmatter')
      .has('allowed-tools:', 'the command must have allowed-tools in its frontmatter')
      .has('- Agent', 'allowed-tools must include Agent for spawning executor subagents')
      .has('argument-hint:', 'the command must have an argument-hint in its frontmatter for /gsd-help discoverability')
      .has('type: prompt', 'the command must have type: prompt in its frontmatter')
      .has('--source <audit-uat>', 'the argument-hint must show --source <audit-uat> (the only currently supported value)')
      // A hint that lost the supported value is reported once, by the line above.
      .satisfies((hint) => !hint.includes('--source <audit-uat>') || !hint.includes('--source <audit|verify>'), 'the argument-hint must not advertise the unsupported verify source');
    command
      .has('audit-fix.md', 'the command must reference the audit-fix.md workflow')
      .has('<objective>', 'the command must have an <objective> section')
      .has('</objective>', 'the command must close its <objective> section')
      .has('--max', 'the command must document the --max flag')
      .has('--severity', 'the command must document the --severity flag')
      .has('--dry-run', 'the command must document the --dry-run flag')
      .has('--source', 'the command must document the --source flag');

    ctx.doc(WORKFLOW)
      .has('<purpose>', 'the workflow must have a <purpose> section')
      .has('</purpose>', 'the workflow must close its <purpose> section')
      .has('<process>', 'the workflow must have a <process> section')
      .has('</process>', 'the workflow must close its <process> section')
      .has('<success_criteria>', 'the workflow must have a <success_criteria> section')
      .has('</success_criteria>', 'the workflow must close its <success_criteria> section')
      .has('<available_agent_types>', 'the workflow must have an <available_agent_types> section')
      .has('gsd-executor', 'the workflow must list gsd-executor as an available agent type')
      .satisfies((text) => lineHasAll(text, ['--max', '5']), 'the workflow must document the --max flag with its default of 5 on one line')
      .satisfies((text) => lineHasAll(text, ['--severity', 'medium']), 'the workflow must document the --severity flag with its default of medium on one line')
      .has('--dry-run', 'the workflow must document the --dry-run flag')
      .satisfies((text) => lineHasAll(text, ['--source', 'audit-uat']), 'the workflow must document the --source flag with audit-uat as the default source on one line')
      .has('auto-fixable', 'the workflow must document the auto-fixable classification')
      .has('manual-only', 'the workflow must document the manual-only classification')
      .satisfies((text) => asciiLower(text).includes('uncertain'), 'the workflow must say to err on manual-only when uncertain')
      .has('file path', 'the workflow must list a file path reference as an auto-fixable signal')
      .satisfies((text) => text.includes('missing test') || text.includes('Missing test'), 'the workflow must list a missing test as an auto-fixable signal')
      .has('design decision', 'the workflow must list design decisions as a manual-only signal')
      .satisfies((text) => text.includes('architecture') || text.includes('architectural'), 'the workflow must list architecture changes as a manual-only signal')
      .satisfies((text) => !text.includes('dry-run') || lineHasAny(text, 'dry-run', ['stop', 'exit']), 'the workflow must indicate on one line that --dry-run stops after classification')
      .has('fix-loop', 'the workflow must have a fix-loop step')
      .satisfies(dryRunBeforeFixLoop, 'the --dry-run stop must be documented before the fix-loop step')
      .satisfies((text) => lineHasAll(text, ['{ID}', 'commit']), 'the commit message template must include the {ID} placeholder for the finding ID')
      .satisfies((text) => lineHasAll(text, ['commit', 'finding']), 'the workflow must commit atomically per finding')
      .satisfies((text) => text.includes('traceability') || text.includes('finding ID'), 'the workflow must mention the finding ID for traceability')
      .has('npm test', 'the workflow must run npm test as part of the fix loop')
      .satisfies(testBeforeCommit, 'npm test must appear before the commit in the fix loop (test-then-commit)')
      .has('tests pass', 'the commit must be conditional on the tests passing')
      .satisfies((text) => text.includes('git checkout') || text.includes('revert'), 'the workflow must revert the changes on a test failure')
      .has('fix-failed', 'the workflow must mark failed fixes as fix-failed')
      .satisfies((text) => !text.includes('fix-failed') || lineHasAll(text, ['stop', 'fix-failed']), 'the workflow must stop the pipeline after the first test failure, on the line that marks fix-failed')
      .has('git checkout -- {changed_files}', 'the workflow must use git checkout -- {changed_files} to clean partial changes on failure');
  },
};
