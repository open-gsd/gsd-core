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
 * `<worktree_branch_check>` block on an isolated one. The executor adds `--sequential` to its Step 0
 * `gsd_run query executor.guard` command from that block; with no block (unknown) the allow-list
 * applies, so the guard still fails closed. No shared state (a sentinel file, an environment
 * variable) carries the decision, so two plans in one wave cannot overwrite each other's.
 *
 * #6216: Step 0 is no longer a bash snippet with a `SEQUENTIAL=false` literal, so the guard's
 * behaviour (sequential vs isolated, the allow-list boundary, a main checkout) is tested against
 * the real verb in tests/executor-guard.test.cjs § "#4799 / #3819 / #2924 behaviours". This file
 * keeps the prompt-side contract: each sequential dispatch carries the block, and the executor
 * keys `--sequential` on it alone.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

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

  test('the executor adds --sequential only from that block, and otherwise fails closed', () => {
    const doc = read('agents/gsd-executor.md');
    const step0 = doc.slice(doc.indexOf('Pre-commit HEAD safety assertion'));
    const window = step0.slice(0, 4500);
    assert.match(window, /gsd_run query executor\.guard/, 'Step 0 must run the executor.guard verb');
    assert.match(
      window,
      /Add `--sequential` ONLY if your prompt has a\s+`<sequential_execution>` block/,
      'Step 0 must key --sequential on the <sequential_execution> block alone',
    );
    assert.match(window, /fail(s)? closed/i);
  });

  test('worktree-path-safety.md: step 0a carries the --sequential rule, step 0b says --path alone runs only its check (#6216)', () => {
    const between = (doc, from, to) => {
      const start = doc.indexOf(from);
      const end = doc.indexOf(to, start);
      assert.ok(start !== -1 && end > start, `section ${from} … ${to} not found`);
      return doc.slice(start, end);
    };
    const safety = read('gsd-core/references/worktree-path-safety.md');
    const step0a = between(safety, '## cwd-drift check — step 0a', '## Absolute-path guard — step 0b');
    assert.match(step0a, /add `--sequential`\s+only when the executor's prompt has a `<sequential_execution>` block/);
    const step0b = between(safety, '## Absolute-path guard — step 0b', '## `<automated>` command guard — step 0c');
    assert.match(step0b, /Given alone, `--path` runs only this check/);
    assert.doesNotMatch(step0b, /--sequential/);
  });

  test('step 0a passes --toplevel back on step 0 runs, in the executor and in worktree-path-safety.md (#6216)', () => {
    assert.match(read('agents/gsd-executor.md'), /pass it back as `--toplevel` on every later step 0 run/);
    assert.match(read('gsd-core/references/worktree-path-safety.md'), /pass it on every later step 0 run, before every commit/);
  });

  test('the sequential blocks name the --sequential flag of the Step 0 guard command (#6216)', () => {
    for (const rel of ['gsd-core/workflows/execute-phase.md', 'gsd-core/workflows/quick.md', 'gsd-core/workflows/execute-plan.md']) {
      assert.match(read(rel), /SEQUENTIAL executor agent on the main working tree \(add --sequential to your Step 0 commit guard/, rel);
    }
  });
});
