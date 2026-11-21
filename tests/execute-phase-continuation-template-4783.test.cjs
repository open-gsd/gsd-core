'use strict';

/**
 * #4783: execute-phase checkpoint handling step 6 told the orchestrator to spawn the continuation
 * agent "using continuation-prompt.md template", a file that does not ship. The placeholders
 * the step lists are the whole contract, so the step must state it itself instead of pointing at a
 * missing file. A workflow may not name a `*-prompt.md` template that does not exist in the package.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readFileNormalized } = require('./helpers.cjs');

const ROOT = path.join(__dirname, '..', 'gsd-core');
const EXECUTE = path.join(ROOT, 'workflows', 'execute-phase.md');

function shippedFileNames(dir, out = new Set()) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) shippedFileNames(path.join(dir, entry.name), out);
    else out.add(entry.name);
  }
  return out;
}

describe('#4783 execute-phase continuation spawn does not point at a missing template', () => {
  test('step 6 does not reference a *-prompt.md template that does not ship', () => {
    const text = readFileNormalized(EXECUTE);
    const shipped = shippedFileNames(ROOT);
    const dangling = [...new Set(text.match(/\b[a-z][a-z-]*-prompt\.md\b/g) || [])].filter((name) => !shipped.has(name));
    assert.deepEqual(dangling, [], `execute-phase.md names template file(s) that do not ship: ${dangling.join(', ')}`);
  });

  test('step 6 still states the continuation placeholders and the <completed_tasks> tag itself', () => {
    const text = readFileNormalized(EXECUTE);
    const step = /\*\*Spawn continuation agent \(NOT resume[^)]*\)\*\*[\s\S]*?\n7\. /.exec(text);
    assert.ok(step, 'could not locate the continuation spawn step');
    for (const placeholder of ['{completed_tasks_table}', '{resume_task_number}', '{resume_task_name}', '{user_response}', '{resume_instructions}']) {
      assert.ok(step[0].includes(placeholder), `step 6 must state ${placeholder}`);
    }
    assert.ok(step[0].includes('<completed_tasks>'), 'step 6 must name the <completed_tasks> tag the executor keys on');
  });
});

// ─── #6118 — a harness-worktree continuation keeps the paused plan's commits reachable ───────────────────────────
//
// A paused `isolation="worktree"` executor commits on its own unmerged agent branch. A fresh worktree forks from the
// orchestrator HEAD, so the continuation can only see those commits if it fast-forwards onto the paused branch. The
// contract is carried by three shipped documents (the step, the recovery policy, the executor); the git behaviour
// the executor is told to perform is exercised against a real repository.
describe('#6118 harness-worktree checkpoint continuation', () => {
  const { runGit, runNode } = require('./helpers/process-seam.cjs');
  const { createTempGitProject, cleanup } = require('./helpers.cjs');
  const { collectSection } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');
  const POLICY = path.join(ROOT, 'workflows', 'execute-phase', 'steps', 'worktree-recovery-policy.md');
  const EXECUTOR = path.join(__dirname, '..', 'agents', 'gsd-executor.md');

  function git(cwd, ...args) {
    const r = runGit(args, { cwd });
    return { status: r.exitCode, out: r.stdout.trim(), err: r.stderr };
  }

  test('step 6 routes a harness-worktree plan to the recovery policy section', () => {
    const step = /\*\*Spawn continuation agent \(NOT resume[^)]*\)\*\*[\s\S]*?\n7\. /.exec(readFileNormalized(EXECUTE));
    assert.ok(step, 'could not locate the continuation spawn step');
    assert.ok(step[0].includes('`harness-worktree` plan'), 'step 6 names the harness-worktree case');
    assert.ok(step[0].includes('worktree-recovery-policy.md'), 'step 6 points at the policy section that owns the path');
  });

  test('the policy documents resume-by-agent-id and the paused-branch fast-forward, and keeps the manifest-scoped merge', () => {
    const policy = readFileNormalized(POLICY);
    const section = collectSection(policy, (h) => h.text.startsWith('CHECKPOINT CONTINUATION IN HARNESS-WORKTREE MODE (#6118)'));
    assert.ok(section, 'the policy must carry the #6118 section');
    for (const needle of ['`agent_id`', '`SendMessage`', '<paused_branch>', 'fast-forwards', 'expected_base', 'drop A', 'git worktree prune', 'git branch -d', 'manifest-scoped cleanup']) {
      assert.ok(section.body.includes(needle), `the #6118 section must state ${needle}`);
    }
  });

  test('the executor fast-forwards onto <paused_branch> first and halts instead of rewriting', () => {
    const handling = /<continuation_handling>[\s\S]*?<\/continuation_handling>/.exec(readFileNormalized(EXECUTOR));
    assert.ok(handling, 'executor continuation_handling block');
    assert.ok(handling[0].includes('<paused_branch>') && handling[0].includes('git merge --ff-only <paused_branch>'), 'ff onto the paused branch');
    assert.ok(handling[0].indexOf('<paused_branch>') < handling[0].indexOf('git log --oneline -5'), 'the fast-forward precedes the commit verification');
    assert.ok(/HALT/.test(handling[0]) && handling[0].includes('never reset'), 'a failed fast-forward halts and never rewrites');
  });

  test('a continuation that fast-forwards onto the paused branch merges through cleanup-wave only when the paused entry is dropped', (t) => {
    const fs2 = require('node:fs');
    const os = require('node:os');
    const { TOOLS_PATH } = require('./helpers.cjs');
    const proj = createTempGitProject();
    const holder = fs2.mkdtempSync(path.join(os.tmpdir(), 'gsd-6118-'));
    t.after(() => { cleanup(proj); cleanup(holder); });
    const orchestrator = git(proj, 'rev-parse', '--abbrev-ref', 'HEAD').out;
    const base = git(proj, 'rev-parse', 'HEAD').out;

    // the paused executor's worktree: two plan commits on its own agent branch, forked from the orchestrator HEAD
    const pausedDir = path.join(holder, 'paused');
    git(proj, 'worktree', 'add', '-q', '-b', 'worktree-agent-paused', pausedDir, base);
    git(pausedDir, 'commit', '-q', '--allow-empty', '-m', 'test(08-02): paused task one');
    git(pausedDir, 'commit', '-q', '--allow-empty', '-m', 'feat(08-02): paused task two');
    const pausedTip = git(pausedDir, 'rev-parse', 'HEAD').out;
    cleanup(pausedDir); // the harness removes the clean worktree directory; git still registers it (#4415)

    // the fresh continuation forks from the orchestrator HEAD and cannot see them until it fast-forwards onto the branch
    const contDir = path.join(holder, 'cont');
    git(proj, 'worktree', 'add', '-q', '-b', 'worktree-agent-cont', contDir, base);
    assert.equal(git(contDir, 'log', '--oneline', '-5', '--grep=(08-02)').out, '', 'invisible before the fast-forward');
    const ff = git(contDir, 'merge', '--ff-only', 'worktree-agent-paused');
    assert.equal(ff.status, 0, ff.err);
    assert.equal(git(contDir, 'rev-parse', 'HEAD').out, pausedTip);
    assert.equal(git(contDir, 'log', '--oneline', '-5', '--grep=(08-02)').out.split('\n').length, 2, 'both paused commits visible');
    git(contDir, 'commit', '-q', '--allow-empty', '-m', 'feat(08-02): continuation task three');

    const cleanupWave = (entries) => {
      const manifest = path.join(holder, 'manifest.json');
      fs2.writeFileSync(manifest, JSON.stringify({ orchestrator_root: proj, worktrees: entries }));
      const r = runNode([TOOLS_PATH, 'worktree', 'cleanup-wave', '--manifest', manifest], { cwd: proj });
      return { status: r.exitCode, out: r.stdout };
    };
    const entryB = { agent_id: 'b', worktree_path: contDir, branch: 'worktree-agent-cont', expected_base: base };

    // the documented route: only the continuation's entry, recorded with the paused entry's expected_base
    const merged = cleanupWave([entryB]);
    assert.equal(merged.status, 0, merged.out);
    assert.equal(git(proj, 'log', '--oneline', orchestrator, '--grep=(08-02)').out.split('\n').length, 3, 'all three plan commits reached the orchestrator branch');
    assert.notEqual(git(proj, 'branch', '-d', 'worktree-agent-paused').status, 0, 'git refuses while the removed directory is still registered');
    git(proj, 'worktree', 'prune');
    assert.equal(git(proj, 'branch', '-d', 'worktree-agent-paused').status, 0, 'after the prune the paused branch is an ancestor, so it deletes cleanly');
  });

  test('recording both the paused and the continuation entry blocks the second merge, which is why the policy drops the paused entry', (t) => {
    const fs2 = require('node:fs');
    const os = require('node:os');
    const { TOOLS_PATH } = require('./helpers.cjs');
    const proj = createTempGitProject();
    const holder = fs2.mkdtempSync(path.join(os.tmpdir(), 'gsd-6118b-'));
    t.after(() => { cleanup(proj); cleanup(holder); });
    const base = git(proj, 'rev-parse', 'HEAD').out;
    const pausedDir = path.join(holder, 'paused');
    git(proj, 'worktree', 'add', '-q', '-b', 'worktree-agent-paused', pausedDir, base);
    git(pausedDir, 'commit', '-q', '--allow-empty', '-m', 'test(08-02): paused task one');
    const contDir = path.join(holder, 'cont');
    git(proj, 'worktree', 'add', '-q', '-b', 'worktree-agent-cont', contDir, base);
    git(contDir, 'merge', '-q', '--ff-only', 'worktree-agent-paused');
    git(contDir, 'commit', '-q', '--allow-empty', '-m', 'feat(08-02): continuation task');
    const manifest = path.join(holder, 'manifest.json');
    fs2.writeFileSync(manifest, JSON.stringify({ orchestrator_root: proj, worktrees: [
      { agent_id: 'a', worktree_path: pausedDir, branch: 'worktree-agent-paused', expected_base: base },
      { agent_id: 'b', worktree_path: contDir, branch: 'worktree-agent-cont', expected_base: base },
    ] }));
    const r = runNode([TOOLS_PATH, 'worktree', 'cleanup-wave', '--manifest', manifest], { cwd: proj });
    assert.notEqual(r.exitCode, 0, 'a double entry cannot merge cleanly');
    assert.ok(r.stdout.includes('base_mismatch'), r.stdout);
  });
});
