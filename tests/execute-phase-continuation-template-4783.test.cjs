'use strict';

/**
 * #4783: execute-phase checkpoint handling step 6 told the orchestrator to spawn the continuation
 * agent "using continuation-prompt.md template", a file that does not ship. The placeholders
 * the step lists are the whole contract, so the step or its shipped continuation part must state
 * them instead of pointing at a missing file. A workflow may not name a `*-prompt.md` template that does not exist in the package.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readFileNormalized } = require('./helpers.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const ROOT = path.join(__dirname, '..', 'gsd-core');
const EXECUTE = path.join(ROOT, 'workflows', 'execute-phase.md');
const EXECUTOR = path.join(__dirname, '..', 'agents', 'gsd-executor.md');
const CONTINUATION_PART = path.join(ROOT, 'workflows', 'execute-phase', 'steps', 'checkpoint-continuation.md');
const PI_EXECUTOR = path.join(__dirname, '..', 'pi', 'package-agents', 'gsd-executor.md');
const START_PART = path.join(ROOT, 'workflows', 'execute-plan', 'steps', 'record-start-time.md');

function shippedFileNames(dir, out = new Set()) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) shippedFileNames(path.join(dir, entry.name), out);
    else out.add(entry.name);
  }
  return out;
}

describe('#4783 execute-phase continuation spawn does not point at a missing template', () => {
  test('step 6 does not reference a *-prompt.md template that does not ship', () => {
    const text = readFileNormalized(EXECUTE) + '\n' + readFileNormalized(CONTINUATION_PART);
    const shipped = shippedFileNames(ROOT);
    const dangling = [...new Set(text.match(/\b[a-z][a-z-]*-prompt\.md\b/g) || [])].filter((name) => !shipped.has(name));
    assert.deepEqual(dangling, [], `execute-phase.md names template file(s) that do not ship: ${dangling.join(', ')}`);
  });

  test('step 6 delegates to the shipped continuation contract after the user response', () => {
    const text = readFileNormalized(EXECUTE);
    const delegation = '6. Read and execute `gsd-core/workflows/execute-phase/steps/checkpoint-continuation.md`';
    assert.ok(text.includes(delegation), 'step 6 must delegate to the shipped part');
    assert.ok(text.indexOf(delegation) > text.indexOf('5. User responds:'), 'continuation follows the user response');
    assert.ok(text.indexOf(delegation) < text.indexOf('7. Continuation agent verifies'), 'continuation precedes commit verification');
    const step = readFileNormalized(CONTINUATION_PART);
    assert.ok(step.includes('**Spawn continuation agent (NOT resume, except `harness-worktree`)'), 'part must own the continuation dispatch');
    for (const placeholder of ['{completed_tasks_table}', '{resume_task_number}', '{resume_task_name}', '{user_response}', '{resume_instructions}', '{worktree_path}']) {
      assert.ok(step.includes(placeholder), `step 6 must state ${placeholder}`);
    }
    assert.ok(step.includes('<completed_tasks>'), 'step 6 must name the <completed_tasks> tag the executor keys on');
    assert.ok(step.includes('<completed_tasks></completed_tasks>'), 'an empty first-task checkpoint must still select continuation');
    assert.ok(step.includes('original executor worktree'), 'step 6 must preserve the worktree that owns continuation metadata');
    assert.ok(step.includes('main checkout'), 'step 6 must define an empty worktree path as the main checkout');
    assert.ok(step.includes('non-empty') && step.includes('fail closed'),
      'step 6 must refuse only a missing non-empty continuation worktree');
  });

  test('checkpoint returns carry the worktree metadata consumed by step 6', () => {
    const text = readFileNormalized(EXECUTOR);
    const start = text.indexOf('<checkpoint_return_format>');
    const end = text.indexOf('</checkpoint_return_format>', start);
    assert.ok(start !== -1 && end > start, 'executor must define checkpoint_return_format');
    const checkpoint = text.slice(start, end);
    assert.match(checkpoint, /<worktree_metadata>/);
    assert.match(checkpoint, /"worktree_path":"\{captured_worktree_path\}"/);
    assert.match(checkpoint, /"branch":"\{captured_branch\}"/);
    assert.match(checkpoint, /"expected_base":"\{captured_expected_base\}"/);
  });

  test('the executor and the start-time part select continuation by the tag, so an empty tag still continues', () => {
    for (const file of [EXECUTOR, PI_EXECUTOR, START_PART]) {
      const rule = splitLines(readFileNormalized(file)).find((line) => line.includes('{timing_attempt}') && line.includes('<completed_tasks>'));
      assert.ok(rule, `${path.basename(path.dirname(file))}/${path.basename(file)} must state the {timing_attempt} rule next to the <completed_tasks> tag`);
      assert.match(rule, /even an empty/, 'an empty <completed_tasks></completed_tasks> must still select continuation');
      assert.doesNotMatch(rule, /payload/, 'the rule keys on the tag, not on whether it carries rows');
    }
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
    // #5212 moved step 6's body into the continuation part the spine delegates to.
    assert.ok(readFileNormalized(EXECUTE).includes('6. Read and execute `gsd-core/workflows/execute-phase/steps/checkpoint-continuation.md`'));
    const step = readFileNormalized(CONTINUATION_PART);
    assert.ok(step.includes('`harness-worktree` plan'), 'step 6 names the harness-worktree case');
    assert.ok(step.includes('worktree-recovery-policy.md'), 'step 6 points at the policy section that owns the path');
    // The policy continues when the harness removed a clean worktree, so no fail-closed rule may cover that mode.
    for (const line of splitLines(step).filter((l) => l.includes('fail closed'))) {
      assert.ok(/except for `harness-worktree`/i.test(line),
        `a fail-closed rule must exempt harness-worktree: ${line.trim().slice(0, 80)}`);
    }
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
