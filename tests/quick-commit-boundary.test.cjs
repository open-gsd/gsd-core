/**
 * GSD Quick Workflow — Commit Boundary Tests (#1503)
 *
 * Validates that the quick workflow correctly separates executor
 * responsibilities (code commits) from orchestrator responsibilities
 * (docs artifact commit), preventing PLAN.md from being left untracked
 * when the executor runs without worktree isolation.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');

describe('quick workflow commit boundary (#1503)', () => {
  const quickPath = path.join(WORKFLOWS_DIR, 'quick.md');
  let content;

  test('quick.md exists', () => {
    assert.ok(fs.existsSync(quickPath), 'workflows/quick.md should exist');
    content = fs.readFileSync(quickPath, 'utf-8');
  });

  test('executor constraints prohibit committing docs artifacts', () => {
    assert.ok(
      content.includes('Do NOT commit docs artifacts'),
      'executor constraints should prohibit committing SUMMARY.md, STATE.md, PLAN.md'
    );
  });

  test('Step 8 explicitly stages artifacts with git add before commit', () => {
    assert.ok(
      content.includes('git add ${file_list}'),
      'Step 8 should explicitly git add the file list before gsd-tools commit'
    );
  });

  test('Step 8 includes PLAN.md in file list', () => {
    assert.ok(
      content.includes('${QUICK_DIR}/${quick_id}-PLAN.md'),
      'Step 8 file list must include PLAN.md'
    );
  });

  test('Step 8 runs unconditionally', () => {
    assert.ok(
      content.includes('MUST always run'),
      'Step 8 should state it must always run regardless of executor commits'
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2432-quick-plan-predispatch-commit.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2432-quick-plan-predispatch-commit (consolidation epic #1969 B4 #1973)", () => {
/**
 * Bug #2432: quick.md PLAN.md timing — worktree executor can't read PLAN.md
 *
 * The orchestrator must commit PLAN.md to the base branch BEFORE spawning the
 * worktree-isolated executor. Without this, the executor's first Read resolves
 * to a main-repo absolute path (not a worktree path), which primes CC's path
 * cache and causes subsequent Edit/Write calls to silently target the main repo
 * instead of the worktree (CC issue #36182 amplifier).
 *
 * Fix: Step 5.6 commits PLAN.md pre-dispatch when USE_WORKTREES is active.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const QUICK_MD = path.join(__dirname, '..', 'gsd-core', 'workflows', 'quick.md');
const REPO_ROOT_FOR_SECTIONS = path.join(__dirname, '..');

/**
 * #2994 fragmentization moved Steps 4.5/4.75/5.5/5.6/6.5 out of quick.md into
 * gsd-core/workflows/quick/steps/*.md behind section markers. A plain
 * `content.indexOf('Step 5.6')` against the host now matches an unrelated
 * later CROSS-REFERENCE to "Step 5.6" (a mention inside the worktree-branch
 * guard prose), not the real heading — silently vacuous, since that
 * mis-anchored slice still happens to contain USE_WORKTREES/commit_docs/
 * PLAN.md/git add/git commit substrings from unrelated surrounding text.
 * Expand each `<!-- gsd:section id="X" ... -->...<!-- /gsd:section -->`
 * marker IN PLACE with its step file's content so Step 5.5/5.6/6/6.5 land
 * back at their original logical positions and ordering/slicing assertions
 * see the real step bodies again.
 */
function expandWorkflowSections(workflowPath) {
  const raw = fs.readFileSync(workflowPath, 'utf8');
  const markerRe = /<!-- gsd:section id="[\w-]+" when="[^"]*" -->[\s\S]*?<!-- \/gsd:section -->/g;
  return raw.replace(markerRe, (block) => {
    const pathMatch = block.match(/`([^`]+\.md)`/);
    if (!pathMatch) return block;
    const stepPath = path.join(REPO_ROOT_FOR_SECTIONS, pathMatch[1]);
    if (!fs.existsSync(stepPath)) return block;
    return fs.readFileSync(stepPath, 'utf8');
  });
}

describe('quick.md pre-dispatch PLAN.md commit (#2432)', () => {
  let content;

  test('quick.md exists', () => {
    assert.ok(fs.existsSync(QUICK_MD), 'gsd-core/workflows/quick.md must exist');
    content = expandWorkflowSections(QUICK_MD);
  });

  test('Step 5.6 exists between Step 5.5 and Step 6', () => {
    const step55 = content.indexOf('Step 5.5');
    const step56 = content.indexOf('Step 5.6');
    const step6  = content.indexOf('Step 6:');
    assert.ok(step55 !== -1, 'Step 5.5 must exist');
    assert.ok(step56 !== -1, 'Step 5.6 must exist');
    assert.ok(step6  !== -1, 'Step 6 must exist');
    assert.ok(step56 > step55, 'Step 5.6 must appear after Step 5.5');
    assert.ok(step56 < step6,  'Step 5.6 must appear before Step 6');
  });

  test('Step 5.6 is gated on USE_WORKTREES', () => {
    const step56Start = content.indexOf('Step 5.6');
    const step6Start  = content.indexOf('Step 6:', step56Start);
    const step56Block = content.slice(step56Start, step6Start);
    assert.ok(
      step56Block.includes('USE_WORKTREES'),
      'Step 5.6 must be gated on USE_WORKTREES — only commit pre-dispatch in worktree mode'
    );
  });

  test('Step 5.6 is gated on commit_docs', () => {
    const step56Start = content.indexOf('Step 5.6');
    const step6Start  = content.indexOf('Step 6:', step56Start);
    const step56Block = content.slice(step56Start, step6Start);
    assert.ok(
      step56Block.includes('commit_docs'),
      'Step 5.6 must respect commit_docs config — skip pre-dispatch commit when commit_docs is false'
    );
  });

  test('Step 5.6 stages and commits PLAN.md', () => {
    const step56Start = content.indexOf('Step 5.6');
    const step6Start  = content.indexOf('Step 6:', step56Start);
    const step56Block = content.slice(step56Start, step6Start);
    assert.ok(
      step56Block.includes('PLAN.md'),
      'Step 5.6 must reference PLAN.md in the pre-dispatch commit'
    );
    assert.ok(
      step56Block.includes('git add') || step56Block.includes('git commit'),
      'Step 5.6 must include git add/commit to stage and commit PLAN.md'
    );
  });

  test('Step 5.6 uses --no-verify to avoid hook interference', () => {
    const step56Start = content.indexOf('Step 5.6');
    const step6Start  = content.indexOf('Step 6:', step56Start);
    const step56Block = content.slice(step56Start, step6Start);
    assert.ok(
      step56Block.includes('--no-verify'),
      'Step 5.6 pre-dispatch commit must use --no-verify to avoid hook interference'
    );
  });

  test('executor prompt references PLAN.md via relative (worktree-rooted) path', () => {
    // QUICK_DIR is always set to ".planning/quick/..." (relative) so ${QUICK_DIR}/...PLAN.md
    // resolves relative to the worktree root, not the main repo absolute path.
    // Verify the executor prompt uses QUICK_DIR variable (not a hardcoded absolute path).
    const executorTask = content.indexOf('subagent_type="gsd-executor"');
    assert.ok(executorTask !== -1, 'executor Task() spawn must exist');
    // Find the files_to_read block near the executor spawn
    const filesBlock = content.lastIndexOf('<required_reading>', executorTask);
    const filesBlockEnd = content.indexOf('</required_reading>', filesBlock);
    const filesContent = content.slice(filesBlock, filesBlockEnd);
    assert.ok(
      filesContent.includes('QUICK_DIR') || filesContent.includes('.planning/quick'),
      'executor files_to_read must reference PLAN.md via relative QUICK_DIR path'
    );
    assert.ok(
      !filesContent.match(/\/home\/|\/Users\/|\/root\//),
      'executor files_to_read must NOT contain hardcoded absolute paths'
    );
  });

  test('#1265 records both parent base and plan commit for worktree dispatch', () => {
    const step56Start = content.indexOf('Step 5.6');
    const step6Start = content.indexOf('Step 6:', step56Start);
    const step56Block = content.slice(step56Start, step6Start);
    const step6Block = content.slice(step6Start, content.indexOf('After executor returns:', step6Start));

    assert.ok(
      step56Block.includes('QUICK_PLAN_PARENT'),
      'quick worktree mode must record the pre-dispatch parent SHA before committing PLAN.md (#1265)'
    );
    assert.ok(
      step56Block.includes('QUICK_PLAN_COMMIT'),
      'quick worktree mode must record the PLAN.md commit SHA after the pre-dispatch commit (#1265)'
    );
    assert.ok(
      step6Block.includes('EXPECTED_BASE_ALTERNATE'),
      'executor guard embed must carry the alternate accepted base for parent-vs-plan worktree forks (#1265)'
    );
  });

  test('#1265 executor materializes PLAN.md from the plan commit when worktree starts at parent', () => {
    const executorTask = content.indexOf('subagent_type="gsd-executor"');
    assert.ok(executorTask !== -1, 'executor Task() spawn must exist');
    const promptStart = content.lastIndexOf('prompt="', executorTask);
    const promptEnd = content.indexOf('subagent_type="gsd-executor"', promptStart);
    const executorPrompt = content.slice(promptStart, promptEnd);

    assert.ok(
      executorPrompt.includes('git show') && executorPrompt.includes('QUICK_PLAN_COMMIT'),
      'executor prompt must materialize PLAN.md from git show <plan-commit>:<plan-path> when absent (#1265)'
    );
    assert.ok(
      executorPrompt.indexOf('git show') < executorPrompt.indexOf('<required_reading>'),
      'PLAN.md materialization must be a first action before files_to_read can prime paths (#1265)'
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2523-quick-deferred-items.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2523-quick-deferred-items (consolidation epic #1969 B4 #1973)", () => {
/**
 * Regression test for bug #2523
 *
 * workflows/quick.md Step 8 ("Build file list") listed PLAN.md, SUMMARY.md,
 * STATE.md, and mode-conditional CONTEXT.md / RESEARCH.md / VERIFICATION.md —
 * but omitted deferred-items.md. When an executor logs out-of-scope findings
 * to ${QUICK_DIR}/${quick_id}-deferred-items.md during task execution, that
 * file was left untracked after the final commit even with commit_docs: true.
 *
 * Fix: add a file-existence-gated entry for deferred-items.md to Step 8.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKFLOW_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'quick.md');

describe('bug #2523: quick-task final commit includes deferred-items.md', () => {
  const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');

  test('workflow file exists', () => {
    assert.ok(fs.existsSync(WORKFLOW_PATH), 'gsd-core/workflows/quick.md must exist');
  });

  test('Step 8 file list references deferred-items.md', () => {
    const step8Idx = content.indexOf('Step 8: Final commit');
    assert.notEqual(step8Idx, -1, 'Step 8 section must exist in quick.md');

    const step8Section = content.slice(step8Idx, step8Idx + 2000);
    assert.ok(
      step8Section.includes('deferred-items.md'),
      'Step 8 file list must include deferred-items.md. ' +
      'Without this, any out-of-scope findings logged by the executor to ' +
      '${QUICK_DIR}/${quick_id}-deferred-items.md are left untracked after commit (bug #2523).'
    );
  });

  test('deferred-items.md entry is conditional on file existence', () => {
    const deferredIdx = content.indexOf('deferred-items.md');
    assert.notEqual(deferredIdx, -1, 'deferred-items.md must be mentioned in the workflow');

    const surroundingContext = content.slice(Math.max(0, deferredIdx - 200), deferredIdx + 200);
    const isConditional =
      surroundingContext.toLowerCase().includes('exist') ||
      surroundingContext.toLowerCase().includes('if ');
    assert.ok(
      isConditional,
      'The deferred-items.md entry must be gated on file existence (not a mode flag). ' +
      'deferred-items.md can be created in any quick-task run, regardless of mode.'
    );
  });
});
  });
}

// ─── #5085: an isolated executor is handed a worktree-relative SUMMARY path ───
//
// `init.quick` reports `quick_dir` as an ABSOLUTE path in the primary checkout.
// Under `isolation="worktree"` the executor was told to write its SUMMARY there,
// which `gsd-worktree-path-guard` blocks (it is outside the worktree root), and
// the guard does not cover Bash, so the denied write got copied around the
// block. The isolated executor now writes a worktree-relative path (the guard
// ignores relative paths); `worktree.cleanup-wave` already rescues an
// uncommitted `*SUMMARY.md` from the worktree into the same relative path in
// the primary checkout, so the orchestrator's later `${QUICK_DIR}` check holds.
{
  const { runHook } = require('./helpers/process-seam.cjs');
  const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
  const { createTempGitProject, cleanup } = require('./helpers.cjs');
  const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
  const quickMd = fs.readFileSync(path.join(WORKFLOWS_DIR, 'quick.md'), 'utf-8');

  describe('#5085: quick executor SUMMARY path under worktree isolation', () => {
    // The shell block that derives QUICK_DIR_REL: from its first `_QTOP=` line to its one-line fallback.
    function derivationBlock() {
      const lines = splitLines(quickMd);
      const start = lines.findIndex((l) => /^_QTOP=/.test(l));
      assert.notStrictEqual(start, -1, 'Step 4 must define the QUICK_DIR_REL derivation');
      const end = lines.findIndex((l, n) => n > start && /^if \[ -z "\$QUICK_DIR_REL" \]/.test(l));
      assert.notStrictEqual(end, -1, 'the derivation must end with its fallback line');
      return lines.slice(start, end + 1).join('\n');
    }

    test('Step 4 derives a repo-relative QUICK_DIR_REL by asking git, not by string-stripping a path', () => {
      const block = derivationBlock();
      assert.match(block, /git -C "\$QUICK_DIR" rev-parse --show-prefix/);
      assert.match(block, /^QUICK_DIR_REL=/m);
    });

    test('the derivation yields .planning-relative paths however the path is spelled, and leaves a path outside the checkout alone', (t) => {
      const block = derivationBlock();
      const dir = createTempGitProject('gsd-5085-');
      t.after(() => cleanup(dir));
      const root = fs.realpathSync(dir);
      const taskDir = path.join(root, '.planning', 'quick', '261016-abc-x');
      fs.mkdirSync(taskDir, { recursive: true });
      const run = (quickDir) => runHook('-c', [`QUICK_DIR="$1"\n${block}\nprintf '%s' "$QUICK_DIR_REL"`, 'sh', quickDir], {
        interpreter: 'bash', cwd: root, timeoutMs: PROBE_TIMEOUT_MS,
      });
      assert.strictEqual(run(taskDir).stdout, '.planning/quick/261016-abc-x', 'plain spelling');
      if (process.platform !== 'win32') {
        // A symlinked spelling of the same directory (macOS /var -> /private/var): a string prefix strip misses it.
        const link = path.join(path.dirname(root), `${path.basename(root)}-link`);
        fs.symlinkSync(root, link);
        t.after(() => cleanup(link));
        assert.strictEqual(run(path.join(link, '.planning', 'quick', '261016-abc-x')).stdout, '.planning/quick/261016-abc-x', 'symlinked spelling');
      }
      assert.strictEqual(run('/elsewhere/.planning/quick/x').stdout, '/elsewhere/.planning/quick/x', 'not under the checkout -> unchanged');
    });

    test('the executor SUMMARY target is the relative path when isolated, the absolute one otherwise', () => {
      const m = quickMd.match(/- Create summary at: (.+?)\/\$\{quick_id\}-SUMMARY\.md/);
      assert.ok(m, 'executor constraints must name the SUMMARY target');
      assert.match(m[1], /ISOLATION === "harness-worktree" \? QUICK_DIR_REL : QUICK_DIR/);
    });

    test('a denied write is reported and stops the run — never copied around with Bash', () => {
      assert.match(quickMd, /denied by gsd-worktree-path-guard[\s\S]{0,300}stop and report/i);
      assert.match(quickMd, /not (?:to )?(?:route|work) around[\s\S]{0,120}(?:cp|mv)/i);
    });
  });
}

// #5209: the shipped step-5.6 shell must record the plan commit's immediate
// parent as QUICK_PLAN_PARENT in BOTH orderings (planner already committed the
// plan / step 5.6 creates the commit). It is the value the worktree branch
// guard accepts as the alternate base and that quick.md lists in allowed_bases.
{
  const { describe, test } = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { runHook } = require('./helpers/process-seam.cjs');
  const { gitOrThrow } = require('./helpers/git-fixture.cjs');
  const { createTempGitProject, cleanup, TEST_ENV_BASE } = require('./helpers.cjs');

  const STEP_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'quick', 'steps', 'worktree-pre-dispatch-commit.md');
  const OPEN = '```bash\n';

  /** The step's runnable bash, minus the gsd-tools resolver preamble (replaced by a stub). */
  function stepScript() {
    const md = fs.readFileSync(STEP_PATH, 'utf-8');
    const start = md.indexOf(OPEN) + OPEN.length;
    const body = md.slice(start, md.indexOf('\n```', start));
    return body.slice(body.indexOf('QUICK_PLAN_PARENT=""'));
  }

  /** Run the step in `dir`; returns { parent, commit } as the script left them. */
  function runStep(dir, { commitDocs = 'true' } = {}) {
    const script = [
      'set -u',
      'gsd_run() { case "$*" in *config-get\\ commit_docs*) echo "$STUB_COMMIT_DOCS";; *config-get\\ workflow.worktree_skip_hooks*) echo "true";; esac; }',
      stepScript(),
      'printf "PARENT=%s\\nCOMMIT=%s\\n" "${QUICK_PLAN_PARENT}" "${QUICK_PLAN_COMMIT}"',
    ].join('\n');
    const file = path.join(os.tmpdir(), `gsd-5209-${process.pid}-${Date.now()}.sh`);
    fs.writeFileSync(file, script);
    try {
      const r = runHook(file, [], {
        interpreter: 'bash',
        cwd: dir,
        env: {
          ...process.env,
          ...TEST_ENV_BASE,
          USE_WORKTREES: 'true',
          QUICK_DIR: '.planning/quick',
          quick_id: '261021-abc',
          DISCUSS_MODE: 'false',
          RESEARCH_MODE: 'false',
          DESCRIPTION: 'fix thing',
          STUB_COMMIT_DOCS: commitDocs,
        },
      });
      assert.equal(r.exitCode, 0, `step 5.6 script failed: ${r.stderr}`);
      // The step also prints git/info chatter; read only the two marker lines.
      const lines = r.stdout.split(/\r?\n/);
      const pick = (key) => (lines.find((l) => l.startsWith(`${key}=`)) || `${key}=`).slice(key.length + 1);
      return { parent: pick('PARENT'), commit: pick('COMMIT') };
    } finally {
      cleanup(file);
    }
  }

  const git = (dir, ...args) => gitOrThrow(args, { cwd: dir }).trim();
  const writePlan = (dir) => {
    fs.mkdirSync(path.join(dir, '.planning', 'quick'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.planning', 'quick', '261021-abc-PLAN.md'), '# Plan\n');
  };

  describe('quick step 5.6 records the plan commit\'s parent as QUICK_PLAN_PARENT (#5209)', () => {
    test('planner-committed plan: the alternate is the plan commit\'s parent and differs from HEAD', (t) => {
      const dir = createTempGitProject();
      t.after(() => cleanup(dir));
      const before = git(dir, 'rev-parse', 'HEAD');
      writePlan(dir);
      git(dir, 'add', '.planning/quick/261021-abc-PLAN.md');
      git(dir, 'commit', '-m', 'docs(261021-abc): create phase plan');
      const head = git(dir, 'rev-parse', 'HEAD');
      const { parent, commit } = runStep(dir);
      assert.equal(commit, head, 'the plan commit is HEAD');
      assert.equal(parent, before, 'the alternate must be the plan commit\'s immediate parent');
      assert.notEqual(parent, head);
    });

    test('pre-dispatch-created plan commit: the alternate is that commit\'s parent', (t) => {
      const dir = createTempGitProject();
      t.after(() => cleanup(dir));
      const before = git(dir, 'rev-parse', 'HEAD');
      writePlan(dir);
      const { parent, commit } = runStep(dir);
      assert.equal(git(dir, 'rev-parse', 'HEAD'), commit, 'step 5.6 created the plan commit');
      assert.notEqual(commit, before);
      assert.equal(parent, before);
    });

    test('docs commits disabled: the alternate stays empty', (t) => {
      const dir = createTempGitProject();
      t.after(() => cleanup(dir));
      writePlan(dir);
      const { parent } = runStep(dir, { commitDocs: 'false' });
      assert.equal(parent, '');
    });

    test('a root plan commit yields an empty alternate without failing the step', (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5209-root-'));
      t.after(() => cleanup(dir));
      git(dir, 'init', '-q');
      git(dir, 'config', 'user.email', 't@example.com');
      git(dir, 'config', 'user.name', 'T');
      writePlan(dir);
      git(dir, 'add', '.planning/quick/261021-abc-PLAN.md');
      git(dir, 'commit', '-q', '-m', 'docs(261021-abc): create phase plan');
      const { parent, commit } = runStep(dir);
      assert.equal(commit, git(dir, 'rev-parse', 'HEAD'));
      assert.equal(parent, '');
    });

    test('the plan was committed earlier and a later commit sits on top: the alternate is still the plan commit\'s parent', (t) => {
      const dir = createTempGitProject();
      t.after(() => cleanup(dir));
      const before = git(dir, 'rev-parse', 'HEAD');
      writePlan(dir);
      git(dir, 'add', '.planning/quick/261021-abc-PLAN.md');
      git(dir, 'commit', '-m', 'docs(261021-abc): create phase plan');
      fs.writeFileSync(path.join(dir, 'later.txt'), 'later\n');
      git(dir, 'add', 'later.txt');
      git(dir, 'commit', '-m', 'chore: unrelated later commit');
      const { parent } = runStep(dir);
      assert.equal(parent, before, 'the alternate must follow the commit that added PLAN.md, not HEAD^');
    });
  });
}
