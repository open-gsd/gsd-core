'use strict';

/**
 * #4799 — a sequential executor sitting in a linked phase worktree must be able to commit on the
 * configured phase branch.
 *
 * The executor's Step 0 pre-commit assertion applied the per-agent branch allow-list whenever `.git`
 * was a file, i.e. in ANY linked worktree. A deliberately sequential run
 * (`workflow.use_worktrees: false`, phase branching) inside a linked worktree on `feature/phase-48`
 * is not an agent-isolated worktree, so the commit was refused after the work was done.
 *
 * The orchestrator tells each executor by value, in that executor's own prompt, which kind of
 * dispatch it is: a `<sequential_execution>` block on a sequential dispatch, a
 * `<worktree_branch_check>` block on an isolated one. The executor sets one literal in the Step 0
 * snippet from that block; with no block (unknown) the allow-list applies, so the guard still fails
 * closed. No shared state (a sentinel file, an environment variable) carries the decision, so two
 * plans in one wave cannot overwrite each other's.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

/** The first ```bash block after the "Pre-commit HEAD safety assertion" heading in the executor. */
function extractStep0Bash() {
  const lines = splitLines(read('agents/gsd-executor.md'));
  const heading = lines.findIndex((line) => line.includes('Pre-commit HEAD safety assertion'));
  assert.notEqual(heading, -1, 'executor Step 0 heading not found');
  const body = [];
  let inBash = false;
  for (const line of lines.slice(heading + 1)) {
    if (!inBash && /^\s*```bash\s*$/.test(line)) inBash = true;
    else if (inBash && /^\s*```\s*$/.test(line)) return body.join('\n');
    else if (inBash) body.push(line);
  }
  throw new Error('no bash block after the Step 0 heading');
}

const BASH = extractStep0Bash();

/** What the executor does with the snippet: set the literal from its prompt, then run it. */
function asExecutorWouldRun(sequentialBlockInPrompt) {
  if (!sequentialBlockInPrompt) return BASH;
  assert.match(BASH, /^SEQUENTIAL=false\b/m, 'Step 0 must expose the SEQUENTIAL literal the executor sets');
  return BASH.replace(/^SEQUENTIAL=false\b/m, 'SEQUENTIAL=true');
}

function runStep0(t, { branch, sequential, linkedWorktree = true, protectedBranch = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4799-'));
  t.after(() => cleanup(dir));
  if (linkedWorktree) fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /nonexistent\n');
  else fs.mkdirSync(path.join(dir, '.git'));
  const script = path.join(dir, 'guard.sh');
  fs.writeFileSync(script, [
    '#!/usr/bin/env bash',
    'git() {',
    '  if [ "$1" = symbolic-ref ]; then printf "%s\\n" "refs/heads/' + branch + '"; return 0',
    '  elif [ "$1" = rev-parse ] && [ "$2" = --abbrev-ref ]; then printf "%s\\n" "' + branch + '"; return 0',
    '  else printf "unexpected git invocation: %s\\n" "$*" >&2; return 97; fi',
    '}',
    'gsd_run() { printf "%s\\n" "' + (protectedBranch ? 'true' : 'false') + '"; }',
    asExecutorWouldRun(sequential),
    'printf "GUARD_PASSED\\n"',
  ].join('\n'), { mode: 0o755 });
  return spawnSync('bash', [script], { cwd: dir, encoding: 'utf-8', timeout: PROBE_TIMEOUT_MS });
}

describe('#4799 executor Step 0: the branch allow-list follows the dispatch, not the physical worktree', () => {
  test('sequential dispatch in a linked phase worktree on feature/phase-48 may commit', (t) => {
    const r = runStep0(t, { branch: 'feature/phase-48', sequential: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /GUARD_PASSED/);
  });

  test('sequential dispatch still refuses a protected branch', (t) => {
    const r = runStep0(t, { branch: 'main', sequential: true, protectedBranch: true });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /protected\/default branch/);
  });

  test('isolated dispatch (no sequential block) on a non-agent branch is still refused', (t) => {
    const r = runStep0(t, { branch: 'feature/phase-48', sequential: false });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not in the agent-\* \/ worktree-agent-\* \/ worktree-wf_\* namespace/);
  });

  test('isolated dispatch on an agent-* branch may commit', (t) => {
    const r = runStep0(t, { branch: 'agent-42', sequential: false });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /GUARD_PASSED/);
  });

  test('an executor that cannot tell which dispatch it is (literal left at its default) fails closed', (t) => {
    const r = runStep0(t, { branch: 'feature/phase-48', sequential: false });
    assert.equal(r.status, 1);
  });

  for (const [branch, expected] of [['agent-', 1], ['agent-x', 0], ['xagent-1', 1], ['worktree-agent-7', 0], ['worktree-wf_abc', 0]]) {
    test(`allow-list boundary: isolated worktree on '${branch}' ${expected === 0 ? 'passes' : 'is refused'}`, (t) => {
      assert.equal(runStep0(t, { branch, sequential: false }).status, expected);
    });
  }

  test('a main checkout (.git is a directory) is not subject to the allow-list in either mode', (t) => {
    assert.equal(runStep0(t, { branch: 'feature/phase-48', sequential: false, linkedWorktree: false }).status, 0);
  });
});

describe('#4799 the orchestrator tells each sequential executor, in its own prompt', () => {
  const sequentialBlock = /<sequential_execution>/;

  test('execute-phase sequential dispatch carries the block', () => {
    const doc = read('gsd-core/workflows/execute-phase.md');
    const sequentialMode = doc.slice(doc.indexOf('**Sequential mode**'));
    assert.match(sequentialMode.slice(0, 2500), sequentialBlock);
  });

  test('quick.md carries the block on a dispatch that is not isolated', () => {
    assert.match(read('gsd-core/workflows/quick.md'), sequentialBlock);
  });

  test('execute-plan Pattern B segment dispatches carry the block', () => {
    const doc = read('gsd-core/workflows/execute-plan.md');
    const patternB = doc.slice(doc.indexOf('**Pattern B: segments are NOT isolated'));
    assert.match(patternB.slice(0, 1500), sequentialBlock);
  });

  test('the executor sets the literal only from that block', () => {
    const doc = read('agents/gsd-executor.md');
    const step0 = doc.slice(doc.indexOf('Pre-commit HEAD safety assertion'));
    assert.match(step0.slice(0, 4500), /`<sequential_execution>`/);
    assert.match(step0.slice(0, 4500), /fail(s)? closed/i);
  });
});
