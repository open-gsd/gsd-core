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
    assert.match(step0b, /`--sequential` beside it is\s+refused/);
    assert.doesNotMatch(step0b, /add `--sequential`/);
  });

  test('step 0a passes --toplevel back on step 0 runs, in the executor and in worktree-path-safety.md (#6216)', () => {
    assert.match(read('agents/gsd-executor.md'), /pass it back as `--toplevel` on every later step 0 run/);
    assert.match(read('gsd-core/references/worktree-path-safety.md'), /pass it on every later step 0 run, before every commit/);
  });

  test('the step texts halt on any non-zero exit, and steps 0a and 0b name a fallback for when gsd_run cannot run (#6216)', () => {
    const between = (doc, from, to) => {
      const start = doc.indexOf(from);
      const end = doc.indexOf(to, start);
      assert.ok(start !== -1 && end > start, `section ${from} … ${to} not found`);
      return doc.slice(start, end);
    };
    // The same toplevel exception, word for word, in executor step 0 and worktree-path-safety.md step 0a.
    const toplevelRetry = /When its only `FATAL:`\s+line is `toplevel`(?: \(step 0a\))?, `cd` back to the kept worktree root and run\s+it again\. On any other\s+non-zero exit, HALT/;
    // The step 0b fallback's root test, in both texts.
    const rootTest = /an absolute (?:one|path) is used only when it\s+begins with the\s+worktree root followed by a path separator and has no `\.` or `\.\.`\s+segment[;,] (?:and )?otherwise HALT/i;

    const executor = read('agents/gsd-executor.md');
    const step0b = between(executor, '**0b. absolute-path safety', '**0. Pre-commit HEAD safety assertion');
    assert.match(step0b, /```\s+On any non-zero exit, do not write to that path\./);
    assert.match(step0b, /If `gsd_run` cannot run, use a relative path; /);
    assert.match(step0b.replace(/\s+/g, ' '), new RegExp(rootTest.source.replace(/\\s\+/g, ' '), 'i'));
    assert.match(step0b, /root is the literal kept from the plan's first `git rev-parse --show-toplevel` run, here or in step\s+0's fallback, whichever came first; run it now if neither has run/);
    const step0 = between(executor, '**0. Pre-commit HEAD safety assertion', '**1. Check modified files:**');
    assert.match(step0, toplevelRetry);
    assert.match(step0, /The plan's first `git rev-parse --show-toplevel`\s+output, here or in step 0b's fallback, is kept as the worktree root, a literal/);
    assert.match(step0, /every later run must print that literal/);

    const fragment = read('gsd-core/references/worktree-branch-check.md');
    assert.match(fragment, /On any non-zero exit, HALT immediately/);

    const safety = read('gsd-core/references/worktree-path-safety.md');
    const safety0a = between(safety, '## cwd-drift check — step 0a', '## Absolute-path guard — step 0b');
    assert.match(safety0a, /when `gsd_run` cannot\s+run, the plan's first `git rev-parse --show-toplevel` output, here or in step 0b, is kept\s+as the root/);
    assert.match(safety0a, toplevelRetry);
    assert.match(safety0a, /HALT and do not commit/);
    const safety0b = between(safety, '## Absolute-path guard — step 0b', '## `<automated>` command guard — step 0c');
    assert.match(safety0b, /On any non-zero exit, do not\s+write to that path/);
    assert.match(safety0b, /If `gsd_run` cannot run, use a relative path\./);
    assert.match(safety0b.replace(/\s+/g, ' '), new RegExp(rootTest.source.replace(/\\s\+/g, ' '), 'i'));
    assert.match(safety0b, /That root is the plan's first `git rev-parse --show-toplevel`\s+output, here or in step 0a, kept as a literal; run it now if it has not run/);

    const adr = read('docs/adr/6216-executor-guard-verbs.md');
    assert.match(adr, /so the step texts halt on any non-zero exit, except that a pre-commit call whose only failed check is `toplevel` is re-run from the kept worktree root/);
    assert.match(adr, /The root it compares against is the plan's first `git rev-parse --show-toplevel` output, from step 0 or step 0b, whichever runs first, kept as a literal\. For step 0b it uses a relative path, and an absolute one only when it begins with that root followed by a path separator and has no `\.` or `\.\.` segment; otherwise it halts\./);
  });

  test('the sequential blocks name the --sequential flag of the Step 0 guard command (#6216)', () => {
    for (const rel of ['gsd-core/workflows/execute-phase.md', 'gsd-core/workflows/quick.md', 'gsd-core/workflows/execute-plan.md']) {
      assert.match(read(rel), /SEQUENTIAL executor agent on the main working tree \(add --sequential to your Step 0 commit guard/, rel);
    }
  });
});
