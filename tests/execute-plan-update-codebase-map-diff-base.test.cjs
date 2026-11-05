// allow-test-rule: source-text-is-the-product (see #4459)
// Workflow markdown is the installed orchestration contract — this file's
// text IS what the executor runs at runtime.

'use strict';

/**
 * Regression coverage for #4459 (carried through #5164, epic #5056 Phase 7):
 * execute-plan.md's `update_codebase_map` step must scope the codebase-map
 * update to THIS phase's files. A phase NUMBER is unique within a MILESTONE,
 * not a repository — on a project that reuses a phase number across
 * milestones, the old commit-subject grep dragged the previous milestone's
 * same-numbered phase's files into the diff, and its successor, a
 * `PHASE_START^..HEAD` range, still folded in every unrelated commit landed
 * since.
 *
 * The step now asks the evaluation-scope resolver, keyed on the phase's own
 * DIRECTORY (`--phase-dir`): the union of the phase's task commits when its
 * SUMMARY records them, else the range from the parent of the first commit
 * that added the directory — reported as `degraded`, never as an empty scope.
 *
 * This test extracts the step's real bash fence from the workflow file and
 * runs it against a constructed git fixture that reproduces the issue's
 * exact scenario — two milestones, phase number reused with a different
 * slug — so a regression is caught by real git behavior, not text matching.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { GIT_FIXTURE_TIMEOUT_MS, LOOP_HOOK_POINT_CLI_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const WORKFLOW_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-plan.md');
const TOOLS_PATH = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

function extractNamedBlock(markdown, blockName) {
  const openStep = `<step name="${blockName}">`;
  const start = markdown.indexOf(openStep);
  assert.ok(start !== -1, `execute-plan.md must contain a <step name="${blockName}"> block`);
  const end = markdown.indexOf('</step>', start + openStep.length);
  assert.ok(end !== -1, `<step name="${blockName}"> must be closed with </step>`);
  return markdown.slice(start + openStep.length, end);
}

function extractFirstBashBlock(block) {
  const lines = block.split('\n');
  let inFence = false;
  const buffer = [];
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('```bash')) {
      inFence = true;
      continue;
    }
    if (inFence && trimmed.startsWith('```')) break;
    if (inFence) buffer.push(line);
  }
  assert.ok(buffer.length > 0, 'update_codebase_map must contain a ```bash fence');
  return buffer.join('\n');
}

function seedFixtureRepo(dir) {
  gitOrThrow(['init', '-q'], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
  gitOrThrow(['config', 'user.email', 't@example.com'], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
  gitOrThrow(['config', 'user.name', 'T'], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
  gitOrThrow(['config', 'commit.gpgsign', 'false'], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
}

function writeAndCommit(dir, relPath, content, message) {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  gitOrThrow(['add', '-A'], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
  gitOrThrow(['commit', '-q', '-m', message], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
  return gitOrThrow(['rev-parse', 'HEAD'], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS }).trim();
}

function seedTwoMilestones(tmpDir) {
  seedFixtureRepo(tmpDir);
  writeAndCommit(tmpDir, 'README.md', '# init\n', 'chore: init');

  // Milestone 1, phase 03 (slug "alpha") — this occupant must NOT leak into milestone 2's scope.
  writeAndCommit(tmpDir, '.planning/phases/03-alpha/03-01-PLAN.md', '# plan\n', 'feat(03-01): milestone-1 phase 3 first task');
  writeAndCommit(tmpDir, 'm1/alpha.js', 'm1 alpha\n', 'feat(03-01): milestone-1 phase 3 work');
  writeAndCommit(tmpDir, 'm1/beta.js', 'm1 beta\n', 'test(03-01): milestone-1 phase 3 tests');

  // Unrelated intervening work (a later phase in milestone 1).
  for (let i = 1; i <= 3; i++) {
    writeAndCommit(tmpDir, `src/f${i}.js`, `f${i}\n`, `feat(07-0${i}): unrelated later work ${i}`);
  }

  // Milestone 2 reuses phase NUMBER 03 with a DIFFERENT slug ("beta").
  writeAndCommit(tmpDir, '.planning/phases/03-beta/03-01-PLAN.md', '# plan\n', 'feat(03-01): milestone-2 phase 3 first task');
}

function runFence(bashFence, tmpDir) {
  // The workflow's own launcher defines gsd_run; the fixture points it at this checkout's CLI.
  // #5861: the fence names the phase through init's `{phase_dir}` (the selected project's or workstream's).
  const script = [`gsd_run() { node "${TOOLS_PATH}" "$@"; }`, bashFence.replace('{phase_dir}', '.planning/phases/03-beta')].join('\n');
  const scriptPath = path.join(tmpDir, '.diff-base-script.sh');
  fs.writeFileSync(scriptPath, script);
  const output = execFileSync('bash', [scriptPath], {
    cwd: tmpDir,
    encoding: 'utf8',
    timeout: LOOP_HOOK_POINT_CLI_TIMEOUT_MS,
  });
  return output.split('\n').map((l) => l.trim()).filter(Boolean).sort();
}

describe('#4459 / #5164: update_codebase_map scopes to the phase through the evaluation-scope resolver', () => {
  const workflowContent = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
  const stepBlock = extractNamedBlock(workflowContent, 'update_codebase_map');
  const bashFence = extractFirstBashBlock(stepBlock);

  test('the fence derives no commit range or phase-start anchor of its own', () => {
    assert.ok(!/git (?:diff|log)/.test(bashFence), 'update_codebase_map must not run its own git diff / git log');
    assert.ok(!bashFence.includes('--diff-filter=A'), 'update_codebase_map must not hand-roll the phase-start anchor');
    assert.ok(!bashFence.includes('--grep='), 'update_codebase_map must not derive its scope from a commit-subject grep');
  });

  test('the fence asks the resolver, keyed on the phase directory', () => {
    assert.ok(
      /gsd_run check evaluation-scope --phase-dir "\{phase_dir\}"/.test(bashFence),
      'update_codebase_map must call the evaluation-scope resolver with the phase directory',
    );
  });

  test('real execution: milestone-2 reusing phase 03 scopes to milestone-2\'s own files, not milestone-1\'s (issue #4459 repro; degraded to the phase-directory range)', () => {
    const tmpDir = fs.realpathSync(createTempDir('gsd-4459-'));
    try {
      seedTwoMilestones(tmpDir);
      writeAndCommit(tmpDir, 'm2/gamma.js', 'm2 gamma\n', 'feat(03-01): milestone-2 phase 3 work');
      writeAndCommit(tmpDir, 'm2/delta.js', 'm2 delta\n', 'test(03-01): milestone-2 phase 3 tests');

      const files = runFence(bashFence, tmpDir);

      assert.deepEqual(
        files,
        ['m2/delta.js', 'm2/gamma.js'],
        `scope must be milestone-2's own phase 03-beta files only, got: ${JSON.stringify(files)}`,
      );
      assert.ok(!files.includes('m1/alpha.js'), 'milestone-1 files must not appear in the scope');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('real execution: with the phase\'s task commits recorded, an interleaved unrelated commit stays out of scope', () => {
    const tmpDir = fs.realpathSync(createTempDir('gsd-5164-'));
    try {
      seedTwoMilestones(tmpDir);
      const gamma = writeAndCommit(tmpDir, 'm2/gamma.js', 'm2 gamma\n', 'feat(03-01): milestone-2 phase 3 work');
      writeAndCommit(tmpDir, 'other/interleaved.js', 'x\n', 'fix(quick): somebody else, mid-phase');
      const delta = writeAndCommit(tmpDir, 'm2/delta.js', 'm2 delta\n', 'test(03-01): milestone-2 phase 3 tests');
      writeAndCommit(
        tmpDir,
        '.planning/phases/03-beta/03-01-SUMMARY.md',
        `# Summary\n\n## Task Commits\n\n1. **Task 1: work** - \`${gamma}\`\n2. **Task 2: tests** - \`${delta}\`\n\n## Next\n`,
        'docs(03-01): summary',
      );

      const files = runFence(bashFence, tmpDir);

      assert.deepEqual(files, ['m2/delta.js', 'm2/gamma.js'], `got: ${JSON.stringify(files)}`);
    } finally {
      cleanup(tmpDir);
    }
  });
});
