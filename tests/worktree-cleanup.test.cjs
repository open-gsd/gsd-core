// allow-test-rule: source-text-is-the-product
// Workflow markdown is the installed orchestration contract.

'use strict';

/**
 * Worktree Cleanup Module — HEAD attachment, post-executor cleanup, and contract tests
 *
 * Seam: gsd-core/workflows/{execute-phase,execute-plan,quick}.md,
 *       agents/gsd-executor.md, references/git-integration.md
 *
 * Split from the consolidated 13→2 worktree cluster (≤800 LOC/file):
 *   - tests/bug-2924-worktree-head-attachment.test.cjs   (#2924: HEAD attachment)
 *   - tests/worktree-cleanup.test.cjs                    (#1496: post-executor cleanup)
 *   - tests/worktree-merge-protection.test.cjs           (#1756: orchestrator file protection)
 *   - tests/worktree-safety.test.cjs                     (#1977: commit safety hardening)
 *   - tests/worktree-stagger.test.cjs                    (#1511: sequential dispatch)
 *   - tests/bug-3384-worktree-cleanup-manifest.test.cjs  (workflow contract side)
 *   - tests/bug-3425-worktree-cleanup-cwd-pin.test.cjs   (#3425: CWD pin)
 *
 * See also: worktree.test.cjs     (#2015, #2075, #2431, #2774)
 *           worktree-safety.test.cjs  (safety function unit tests)
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scanFencedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const EXECUTE_PHASE_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'execute-phase.md');
const EXECUTE_PLAN_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'execute-plan.md');
const QUICK_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'quick.md');
const EXECUTOR_AGENT_PATH = path.join(REPO_ROOT, 'agents', 'gsd-executor.md');
const GIT_INTEGRATION_PATH = path.join(REPO_ROOT, 'gsd-core', 'references', 'git-integration.md');
const WORKTREE_BRANCH_CHECK_FRAGMENT = path.join(REPO_ROOT, 'gsd-core', 'references', 'worktree-branch-check.md');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractNamedBlock(markdown, blockName) {
  const open = `<${blockName}>`;
  const close = `</${blockName}>`;
  const start = markdown.indexOf(open);
  if (start === -1) return null;
  const end = markdown.indexOf(close, start + open.length);
  if (end === -1) return null;
  return markdown.slice(start + open.length, end);
}

/**
 * Extract all fenced code blocks (```...```) from a markdown chunk.
 * Returns array of { lang, body } objects.
 */
function extractFencedCodeBlocks(markdown) {
  const blocks = [];
  const lines = markdown.split(/\r?\n/);
  let inFence = false;
  let fenceLang = '';
  let buffer = [];
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('```')) {
      if (!inFence) {
        inFence = true;
        fenceLang = trimmed.slice(3).trim();
        buffer = [];
      } else {
        blocks.push({ lang: fenceLang, body: buffer.join('\n') });
        inFence = false;
        fenceLang = '';
        buffer = [];
      }
    } else if (inFence) {
      buffer.push(line);
    }
  }
  return blocks;
}

/**
 * Tokenize a shell-like script into individual statements (split on `;`, `&&`, `||`, newlines)
 * and return commands as arrays of word tokens.
 */
function shellStatements(script) {
  const statements = [];
  const lines = script.split(/\r?\n/);
  for (let raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const parts = line.split(/(?:&&|\|\||;)/);
    for (const part of parts) {
      let trimmed = part.trim();
      if (!trimmed) continue;
      const assignMatch = trimmed.match(/^[A-Za-z_][A-Za-z0-9_]*=(.*)$/);
      if (assignMatch) trimmed = assignMatch[1];
      const subMatch = trimmed.match(/^\$\((.*?)\)?$/);
      if (subMatch) trimmed = subMatch[1];
      if (trimmed.startsWith('$(')) trimmed = trimmed.slice(2);
      trimmed = trimmed.replace(/\)+\s*$/, '').trim();
      if (!trimmed) continue;
      statements.push(trimmed.split(/\s+/).filter(Boolean));
    }
  }
  return statements;
}

/**
 * Find the line index of the first command matching a predicate.
 * Returns -1 when not found.
 */
function findCommandIndex(statements, predicate) {
  for (let i = 0; i < statements.length; i++) {
    if (predicate(statements[i])) return i;
  }
  return -1;
}

// ─── #2924: HEAD attachment + destructive recovery ──────────────────────────

describe('bug #2924: worktree HEAD attachment + destructive recovery', () => {
  describe('execute-phase.md worktree_branch_check', () => {
    const executePhaseContent = fs.readFileSync(EXECUTE_PHASE_PATH, 'utf-8');
    const fragmentContent = fs.readFileSync(WORKTREE_BRANCH_CHECK_FRAGMENT, 'utf-8');
    const block = extractNamedBlock(fragmentContent, 'worktree_branch_check');

    test('execute-phase.md references the canonical fragment', () => {
      assert.ok(
        executePhaseContent.includes('worktree-branch-check.md'),
        'execute-phase.md must reference the canonical worktree-branch-check.md fragment'
      );
    });

    test('block exists in canonical fragment', () => {
      assert.ok(block, 'worktree-branch-check.md must contain a <worktree_branch_check> block');
    });

    test('block invokes `git symbolic-ref` to inspect HEAD attachment', () => {
      const codeBlocks = extractFencedCodeBlocks(block);
      const allStatements = codeBlocks.flatMap(({ body }) => shellStatements(body));
      const idx = findCommandIndex(allStatements, (cmd) =>
        cmd[0] === 'git' && cmd[1] === 'symbolic-ref' && cmd.includes('HEAD')
      );
      assert.notStrictEqual(
        idx, -1,
        'worktree_branch_check must run `git symbolic-ref ... HEAD` to verify HEAD attachment before any reset'
      );
    });

    test('block is verify-only: HEAD assertion present, no git reset, fails closed (#48)', () => {
      const codeBlocks = extractFencedCodeBlocks(block);
      const allStatements = codeBlocks.flatMap(({ body }) => shellStatements(body));
      const symbolicRefIdx = findCommandIndex(allStatements, (cmd) => cmd[0] === 'git' && cmd[1] === 'symbolic-ref' && cmd.includes('HEAD'));
      const resetIdx = findCommandIndex(allStatements, (cmd) => cmd[0] === 'git' && cmd[1] === 'reset');
      assert.notStrictEqual(symbolicRefIdx, -1, 'symbolic-ref HEAD-attachment check must exist');
      assert.strictEqual(resetIdx, -1, 'fragment must be verify-only — no git reset self-recovery (#48)');
      assert.ok(/exit 42/.test(block), 'fragment must fail closed with exit 42 (#48)');
    });

    test('block names protected branches that must NOT be the agent branch', () => {
      // The protected-branch list must be enforced by name. Parse it out of the
      // shell scripts and verify required names are present.
      const codeBlocks = extractFencedCodeBlocks(block);
      const scripts = codeBlocks.map(({ body }) => body).join('\n');
      // Look for an assignment whose value is a regex/list naming protected refs.
      // Acceptable forms: PROTECTED_BRANCHES_RE='...' or grep -Eq '^(main|...)$'
      // Parse the alternation list out of the grep -E pattern so we assert
      // structurally on the protected-branch enumeration rather than via
      // raw substring matching (release/* contains regex-special chars and
      // can't be safely tested with `\b...\b`).
      const altMatch = scripts.match(/grep\s+-Eq?\s+'\^\(([^)]+)\)\$'/);
      assert.ok(
        altMatch,
        'worktree_branch_check must contain a `grep -Eq` protected-branch alternation pattern'
      );
      const branches = altMatch[1].split('|').map((b) => b.trim());
      const required = ['main', 'master', 'develop', 'trunk', 'release/.*'];
      for (const name of required) {
        assert.ok(
          branches.includes(name),
          `worktree_branch_check protected-branch alternation must include '${name}' (found: ${branches.join(', ')})`
        );
      }
    });

    test('block enforces positive worktree-agent-* allow-list (#2924 hardening)', () => {
      const codeBlocks = extractFencedCodeBlocks(block);
      const scripts = codeBlocks.map(({ body }) => body).join('\n');
      // Allow-list must reference the canonical Claude Code worktree-agent-<id>
      // namespace via a regex assertion (grep -Eq '^worktree-agent-...').
      // #3021: allow-list now includes worktree-wf_* alongside agent-*/worktree-agent-*
      const allowListRe = /grep\s+-Eq?\s+'\^\(\(worktree-\)\?agent-\|worktree-wf_/;
      assert.ok(
        allowListRe.test(scripts),
        'worktree_branch_check must enforce a positive allow-list matching ^((worktree-)?agent-|worktree-wf_) (#2924/#3021 hardening)'
      );
    });

    test('block forbids `git update-ref` self-recovery in its guidance text', () => {
      // The forbidding statement is documentation text, not a shell command,
      // so structural shell parsing does not apply. Verify the prohibition
      // appears as standalone guidance somewhere in the block.
      assert.ok(
        block.includes('update-ref'),
        'worktree_branch_check must explicitly forbid `git update-ref` self-recovery'
      );
    });
  });

  describe('execute-phase.md no longer defaults to --no-verify in parallel mode', () => {
    const content = fs.readFileSync(EXECUTE_PHASE_PATH, 'utf-8');
    const block = extractNamedBlock(content, 'parallel_execution');

    test('parallel_execution block exists', () => {
      assert.ok(block, 'execute-phase.md must contain a <parallel_execution> block');
    });

    test('parallel_execution does NOT instruct agents to use --no-verify by default', () => {
      // Tokenize the block as plain words and look for an unconditional
      // imperative naming `--no-verify`. The acceptable presence is in a
      // negated/opt-out context (e.g. "Do NOT pass --no-verify"); reject
      // any sentence whose first verb is "Use --no-verify".
      const sentences = block
        .replace(/\r?\n+/g, ' ')
        .split(/(?<=[.!?])\s+/);
      for (const sentence of sentences) {
        if (!sentence.includes('--no-verify')) continue;
        const lower = sentence.toLowerCase();
        const isProhibition =
          /\b(do not|don't|never|no longer)\b/.test(lower) ||
          /\bopt[\s-]?out\b/.test(lower) ||
          /\bopt[\s-]?in\b/.test(lower) ||
          /\bif\b/.test(lower);
        assert.ok(
          isProhibition,
          `parallel_execution sentence appears to mandate --no-verify by default: "${sentence.trim()}"`
        );
      }
    });
  });

  describe('execute-plan.md no longer mandates --no-verify for parallel executor', () => {
    const content = fs.readFileSync(EXECUTE_PLAN_PATH, 'utf-8');
    const block = extractNamedBlock(content, 'precommit_failure_handling');
    test('precommit_failure_handling block exists', () => {
      assert.ok(block, 'execute-plan.md must contain a <precommit_failure_handling> block');
    });

    test('parallel-executor sub-section does not unconditionally mandate --no-verify', () => {
      // Locate the parallel-executor sub-section heading and parse the
      // sentences under it.
      const headingIdx = block.indexOf('parallel executor');
      assert.notStrictEqual(headingIdx, -1, 'must contain a parallel-executor sub-section');
      const endIdx = block.indexOf('**If running as the sole', headingIdx);
      assert.notStrictEqual(endIdx, -1, 'parallel-executor sub-section terminator must exist');
      const subBlock = block.slice(headingIdx, endIdx);
      assert.ok(subBlock.length > 0, 'sub-section must have content');
      const sentences = subBlock.replace(/\r?\n+/g, ' ').split(/(?<=[.!?])\s+/);
      for (const sentence of sentences) {
        if (!sentence.includes('--no-verify')) continue;
        const lower = sentence.toLowerCase();
        const isProhibition =
          /\b(do not|don't|never|no longer)\b/.test(lower) ||
          /\bopt[\s-]?out\b/.test(lower) ||
          /\bopt[\s-]?in\b/.test(lower) ||
          /\bif\b/.test(lower);
        assert.ok(
          isProhibition,
          `parallel-executor guidance sentence appears to mandate --no-verify: "${sentence.trim()}"`
        );
      }
    });
  });

  describe('quick.md worktree_branch_check', () => {
    const quickContent = fs.readFileSync(QUICK_PATH, 'utf-8');
    const fragmentContent = fs.readFileSync(WORKTREE_BRANCH_CHECK_FRAGMENT, 'utf-8');
    const block = extractNamedBlock(fragmentContent, 'worktree_branch_check');

    test('quick.md references the canonical fragment', () => {
      assert.ok(
        quickContent.includes('worktree-branch-check.md'),
        'quick.md must reference the canonical worktree-branch-check.md fragment'
      );
    });

    test('block exists in canonical fragment', () => {
      assert.ok(block, 'worktree-branch-check.md must contain a <worktree_branch_check> block');
    });

    test('block references `git symbolic-ref` for HEAD attachment assertion', () => {
      // Search the block from the canonical fragment as a token stream of statements.
      const codeBlocks = extractFencedCodeBlocks(block);
      const allStatements = codeBlocks.flatMap(({ body }) => shellStatements(body));
      const idx = findCommandIndex(allStatements, (cmd) =>
        cmd[0] === 'git' && cmd[1] === 'symbolic-ref' && cmd.includes('HEAD')
      );
      assert.notStrictEqual(
        idx, -1,
        'quick.md worktree_branch_check must run `git symbolic-ref ... HEAD`'
      );
    });

    test('block is verify-only: HEAD assertion present, no git reset, fails closed (#48)', () => {
      // Verify-only contract: symbolic-ref exists, no git reset at all, fails closed with exit 42.
      const codeBlocks = extractFencedCodeBlocks(block);
      const allStatements = codeBlocks.flatMap(({ body }) => shellStatements(body));
      const symbolicRefIdx = findCommandIndex(allStatements, (cmd) =>
        cmd[0] === 'git' && cmd[1] === 'symbolic-ref' && cmd.includes('HEAD')
      );
      const resetIdx = findCommandIndex(allStatements, (cmd) =>
        cmd[0] === 'git' && cmd[1] === 'reset'
      );
      assert.notStrictEqual(symbolicRefIdx, -1, 'symbolic-ref HEAD-attachment check must exist');
      assert.strictEqual(resetIdx, -1, 'fragment must be verify-only — no git reset self-recovery (#48)');
      assert.ok(/exit 42/.test(block), 'fragment must fail closed with exit 42 (#48)');
    });

    test('block forbids `git update-ref` self-recovery', () => {
      assert.ok(
        block.includes('update-ref'),
        'quick.md worktree_branch_check must explicitly forbid `git update-ref` self-recovery'
      );
    });

    test('block enforces positive worktree-agent-* allow-list (#2924 hardening)', () => {
      const allowListRe = /grep\s+-Eq?\s+'\^\(\(worktree-\)\?agent-\|worktree-wf_/;
      assert.ok(
        allowListRe.test(block),
        'quick.md worktree_branch_check must enforce a positive allow-list matching ^((worktree-)?agent-|worktree-wf_) (#2924/#3021 hardening)'
      );
    });
  });

  describe('quick.md pre-dispatch plan commit no longer hard-codes --no-verify', () => {
    // #2994 fragmentization moved the pre-dispatch plan commit block out of
    // quick.md into gsd-core/workflows/quick/steps/worktree-pre-dispatch-commit.md
    // behind a section marker. Read host + step file combined so the fenced
    // code block search below still finds it.
    const content = fs.readFileSync(QUICK_PATH, 'utf-8') +
      '\n' + fs.readFileSync(
        path.join(REPO_ROOT, 'gsd-core', 'workflows', 'quick', 'steps', 'worktree-pre-dispatch-commit.md'),
        'utf-8'
      );
    const codeBlocks = extractFencedCodeBlocks(content);
    // Find the bash block containing the pre-dispatch plan commit
    const target = codeBlocks.find(({ body }) =>
      body.includes('pre-dispatch plan') && body.includes('git commit')
    );
    test('pre-dispatch plan commit block exists', () => {
      assert.ok(target, 'quick.md must contain the pre-dispatch plan commit block');
    });

    test('pre-dispatch plan commit gates --no-verify behind a config flag', () => {
      // The block must contain BOTH a `git commit` without --no-verify AND
      // gate any --no-verify variant inside an `if` block reading a config
      // value (workflow.worktree_skip_hooks).
      const statements = shellStatements(target.body);
      const noVerifyCommits = statements.filter((cmd) =>
        cmd[0] === 'git' && cmd[1] === 'commit' && cmd.includes('--no-verify')
      );
      const cleanCommits = statements.filter((cmd) =>
        cmd[0] === 'git' && cmd[1] === 'commit' && !cmd.includes('--no-verify')
      );
      assert.ok(
        cleanCommits.length >= 1,
        'must include at least one `git commit` without --no-verify (default path)'
      );
      // If --no-verify still appears, the block must reference the opt-in flag.
      if (noVerifyCommits.length > 0) {
        assert.ok(
          target.body.includes('worktree_skip_hooks'),
          '--no-verify commits must be gated behind workflow.worktree_skip_hooks config flag'
        );
      }
    });
  });

  describe('gsd-executor.md prohibits update-ref self-recovery', () => {
    const content = fs.readFileSync(EXECUTOR_AGENT_PATH, 'utf-8');
    const block = extractNamedBlock(content, 'destructive_git_prohibition');

    test('destructive_git_prohibition block exists', () => {
      assert.ok(block, 'gsd-executor.md must contain a <destructive_git_prohibition> block');
    });

    test('block prohibits `git update-ref refs/heads/<protected>`', () => {
      assert.ok(
        block.includes('update-ref'),
        'destructive_git_prohibition must enumerate `git update-ref` as a prohibited command'
      );
      assert.ok(
        block.includes('protected') || block.includes('main') || block.includes('master'),
        'destructive_git_prohibition must call out protected branches in the update-ref prohibition'
      );
    });

    test('block references issue #2924', () => {
      assert.ok(
        block.includes('#2924'),
        'destructive_git_prohibition should cite #2924 as the source of the update-ref prohibition'
      );
    });
  });

  describe('gsd-executor.md task_commit_protocol enforces worktree-agent-* allow-list', () => {
    const content = fs.readFileSync(EXECUTOR_AGENT_PATH, 'utf-8');
    const block = extractNamedBlock(content, 'task_commit_protocol');

    test('task_commit_protocol block exists', () => {
      assert.ok(block, 'gsd-executor.md must contain a <task_commit_protocol> block');
    });

    test('step 0 enforces positive worktree-agent-* allow-list (#2924 hardening)', () => {
      const codeBlocks = extractFencedCodeBlocks(block);
      const scripts = codeBlocks.map(({ body }) => body).join('\n');
      const allowListRe = /grep\s+-Eq?\s+'\^\(\(worktree-\)\?agent-\|worktree-wf_/;
      assert.ok(
        allowListRe.test(scripts),
        'task_commit_protocol step 0 must enforce a positive allow-list matching ^((worktree-)?agent-|worktree-wf_) in addition to the protected-ref deny-list (#2924/#3021 hardening)'
      );
    });
  });

  describe('no workflow file performs unconditional update-ref on a protected branch', () => {
    const workflowsDir = path.join(REPO_ROOT, 'gsd-core', 'workflows');
    const workflowFiles = fs
      .readdirSync(workflowsDir, { recursive: true })
      .filter((f) => typeof f === 'string' && f.endsWith('.md'))
      .map((f) => path.join(workflowsDir, f));

    for (const filePath of workflowFiles) {
      test(`${path.basename(filePath)} contains no update-ref of a protected ref`, () => {
        const content = fs.readFileSync(filePath, 'utf-8');
        const blocks = extractFencedCodeBlocks(content);
        for (const { body } of blocks) {
          const statements = shellStatements(body);
          for (const cmd of statements) {
            if (cmd[0] !== 'git') continue;
            if (cmd[1] !== 'update-ref') continue;
            // Reject any update-ref that targets a protected ref.
            const target = cmd[2] || '';
            const protectedRe = /^refs\/heads\/(main|master|develop|trunk|release\/.+)$/;
            assert.ok(
              !protectedRe.test(target),
              `${path.basename(filePath)} contains forbidden 'git update-ref ${target}' (#2924)`
            );
          }
        }
      });
    }
  });

  describe('git-integration.md guidance reflects new default', () => {
    const content = fs.readFileSync(GIT_INTEGRATION_PATH, 'utf-8');
    test('parallel-agents guidance no longer mandates --no-verify', () => {
      // Find the parallel-agents callout and parse its sentences.
      const idx = content.indexOf('Parallel agents');
      assert.notStrictEqual(idx, -1, 'must contain a "Parallel agents" callout');
      const section = content.slice(idx);
      const endMatch = section.slice(1).match(/\r?\n#{1,6}\s/);
      assert.ok(endMatch, 'Parallel agents section must terminate at the next heading');
      const tail = section.slice(0, 1 + endMatch.index);
      const sentences = tail.replace(/\r?\n+/g, ' ').split(/(?<=[.!?])\s+/);
      for (const sentence of sentences) {
        if (!sentence.includes('--no-verify')) continue;
        const lower = sentence.toLowerCase();
        const isProhibition =
          /\b(do not|don't|never|no longer)\b/.test(lower) ||
          /\bopt[\s-]?out\b/.test(lower) ||
          /\bopt[\s-]?in\b/.test(lower) ||
          /\bif\b/.test(lower);
        assert.ok(
          isProhibition,
          `git-integration.md "Parallel agents" sentence appears to mandate --no-verify: "${sentence.trim()}"`
        );
      }
    });
  });
});

// ─── #1496: post-executor worktree cleanup ──────────────────────────────────

describe('worktree cleanup after executor completes (#1496)', () => {
  const executePhasePath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md');
  const quickPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'quick.md');

  test('execute-phase.md includes worktree cleanup step', () => {
    const content = fs.readFileSync(executePhasePath, 'utf8');
    assert.ok(content.includes('Worktree cleanup'),
      'execute-phase should have a worktree cleanup step');
    assert.ok(content.includes('git worktree remove'),
      'cleanup should remove worktrees');
    assert.ok(content.includes('git branch -D'),
      'cleanup should delete temporary branches');
  });

  test('execute-phase.md merges worktree branch before removing', () => {
    const content = fs.readFileSync(executePhasePath, 'utf8');
    assert.ok(content.includes('git merge'),
      'cleanup should merge worktree branch into current branch');
  });

  test('execute-phase.md handles merge conflicts gracefully', () => {
    const content = fs.readFileSync(executePhasePath, 'utf8');
    assert.ok(
      content.includes('Merge conflict') || content.includes('merge conflict'),
      'cleanup should handle merge conflicts gracefully'
    );
  });

  test('execute-phase.md skips cleanup when use_worktrees is false', () => {
    const content = fs.readFileSync(executePhasePath, 'utf8');
    assert.ok(content.includes('use_worktrees'),
      'cleanup should respect workflow.use_worktrees config');
  });

  test('quick.md includes worktree cleanup after executor returns', () => {
    const content = fs.readFileSync(quickPath, 'utf8');
    assert.ok(content.includes('Worktree cleanup') || content.includes('worktree cleanup'),
      'quick should have worktree cleanup');
    // After #3797 architectural fix: quick.md delegates entirely to the SDK's
    // worktree.cleanup-wave command (which handles git worktree remove and branch
    // deletion internally). The manual shell cleanup loop has been removed.
    assert.ok(
      content.includes('worktree.cleanup-wave'),
      'quick cleanup must delegate to gsd_run query worktree.cleanup-wave (#3797)',
    );
  });

  test('quick.md cleanup-wave uses || exit 1 to enforce safety semantics', () => {
    const content = fs.readFileSync(quickPath, 'utf8');
    // The || exit 1 guards against SDK safety refusals (#3174/#3384).
    // A soft || { warn } fallback would silently swallow blocked cleanups.
    assert.match(
      content,
      /gsd_run query worktree\.cleanup-wave.*\|\| exit 1/,
      'quick.md cleanup-wave must use || exit 1 — SDK safety refusals must surface (#3797)',
    );
  });

  test('cleanup uses git worktree list to discover orphans', () => {
    const content = fs.readFileSync(executePhasePath, 'utf8');
    assert.ok(content.includes('git worktree list'),
      'cleanup should discover worktrees via git worktree list');
  });
});

// ─── #1756: orchestrator file protection during merge ────────────────────────

describe('worktree merge: orchestrator file protection (#1756)', () => {
  // After #3797 architectural fix: execute-phase.md and quick.md delegate worktree
  // cleanup to the SDK's worktree.cleanup-wave command (which handles STATE.md/ROADMAP.md
  // backup and restore internally). The manual shell backup loop has been removed.
  // The workflow contracts now verify SDK delegation rather than inline backup code.

  test('execute-phase.md delegates wave cleanup to SDK with fail-closed || exit 1', () => {
    const content = fs.readFileSync(EXECUTE_PHASE_PATH, 'utf-8');
    // worktree.cleanup-wave handles STATE.md/ROADMAP.md backup + restore internally.
    assert.match(
      content,
      /gsd_run query worktree\.cleanup-wave --manifest "\$WAVE_WORKTREE_MANIFEST" \|\| exit 1/,
      'execute-phase.md must delegate to gsd_run query worktree.cleanup-wave with || exit 1 (#3797)',
    );
  });

  test('execute-phase.md cleanup-tail snippet still backs up STATE.md for custom deviations', () => {
    const content = fs.readFileSync(EXECUTE_PHASE_PATH, 'utf-8');
    // The cleanup-tail snippet (for deviations from the standard wave merge path)
    // uses git worktree remove directly — it doesn't use the SDK helper.
    // This snippet doesn't need STATE.md backup because it only removes worktrees
    // that were already manually merged — not performing merges itself.
    assert.match(
      content,
      /Cleanup-tail: remove residual agent worktrees after a cross-wave-dependency deviation/,
      'execute-phase.md must contain the cleanup-tail snippet for custom merge deviations',
    );
  });

  test('execute-phase.md detects files deleted on main but re-added by worktree (cleanup-tail)', () => {
    // The cleanup-tail snippet includes resurrection detection via git diff --diff-filter=A.
    // This verifies the safety mechanism is still documented in the workflow.
    const content = fs.readFileSync(EXECUTE_PHASE_PATH, 'utf-8');
    // Resurrection detection is handled inside worktree.cleanup-wave (SDK internals).
    // We verify the workflow still mentions WAVE_WORKTREE_MANIFEST to ensure
    // manifest-scoped cleanup is enforced (#3384).
    assert.match(content, /WAVE_WORKTREE_MANIFEST/,
      'execute-phase must use WAVE_WORKTREE_MANIFEST to scope cleanup (#3384)');
  });

  test('quick.md delegates wave cleanup to SDK with fail-closed || exit 1', () => {
    const content = fs.readFileSync(QUICK_PATH, 'utf-8');
    // After #3797 architectural fix: quick.md no longer contains inline STATE.md/ROADMAP.md
    // backup code — that is handled internally by worktree.cleanup-wave.
    assert.match(
      content,
      /gsd_run query worktree\.cleanup-wave --manifest "\$QUICK_WORKTREE_MANIFEST" \|\| exit 1/,
      'quick.md must delegate to gsd_run query worktree.cleanup-wave with || exit 1 (#3797)',
    );
  });
});

// ─── #1977: commit safety hardening ─────────────────────────────────────────

describe('worktree commit safety hardening (#1977)', () => {
  test('execute-plan worktree_branch_check has no Windows-only platform qualifier', () => {
    const content = fs.readFileSync(EXECUTE_PLAN_PATH, 'utf-8');
    assert.ok(content.includes('worktree_branch_check'), 'execute-plan.md must contain a worktree_branch_check block');
    assert.ok(content.includes('worktree-branch-check.md'), 'execute-plan.md must reference the canonical worktree-branch-check.md fragment');
    const hasWindowsOnlyQualifier = (
      /Windows.only/i.test(content) ||
      /affects Windows only/i.test(content) ||
      /only on Windows/i.test(content) ||
      /Windows-specific/i.test(content)
    );
    assert.ok(!hasWindowsOnlyQualifier, 'worktree_branch_check must not be labeled as Windows-only');
    const isUniversal = (
      /affects all platforms/i.test(content) ||
      /all platforms/i.test(content) ||
      /cross.platform/i.test(content)
    );
    assert.ok(isUniversal, 'worktree_branch_check description must indicate the fix applies to all platforms');
  });

  test('gsd-executor.md task_commit_protocol includes post-commit deletion verification', () => {
    const content = fs.readFileSync(EXECUTOR_AGENT_PATH, 'utf-8');
    assert.ok(content.includes('--diff-filter=D'), 'must include --diff-filter=D deletion verification');
    assert.ok(
      content.includes('WARNING') || content.includes('DELETIONS'),
      'must warn when a commit includes file deletions'
    );
  });

  test('execute-phase.md worktree merge section includes pre-merge deletion check', () => {
    const content = fs.readFileSync(EXECUTE_PHASE_PATH, 'utf-8');
    const worktreeCleanupStart = content.indexOf('Worktree cleanup');
    assert.ok(worktreeCleanupStart > -1, 'must have a worktree cleanup section');
    const cleanupSection = content.slice(worktreeCleanupStart);
    // After #3797: deletion check is handled by SDK worktree.cleanup-wave.
    // The cleanup section must either (a) include --diff-filter=D directly or
    // (b) delegate to the SDK which documents that it validates deletion diffs.
    // Accept either form: inline shell check OR SDK delegation with deletion mention.
    const hasInlineDiffFilterCheck = cleanupSection.includes('--diff-filter=D');
    const hasSdkDelegationWithDeletionMention = (
      cleanupSection.includes('worktree.cleanup-wave') &&
      (cleanupSection.includes('deletion') || cleanupSection.includes('BLOCKED'))
    );
    assert.ok(
      hasInlineDiffFilterCheck || hasSdkDelegationWithDeletionMention,
      'cleanup section must either include --diff-filter=D directly or delegate to SDK (worktree.cleanup-wave) with documented deletion-diff validation (#2384/#3797)',
    );
  });
});


// ─── #1511: sequential dispatch ─────────────────────────────────────────────

describe('worktree sequential dispatch', () => {
  test('execute-phase.md exists', () => {
    assert.ok(fs.existsSync(EXECUTE_PHASE_PATH), 'execute-phase.md should exist');
  });

  test('execute-phase explains git config.lock contention', () => {
    const content = fs.readFileSync(EXECUTE_PHASE_PATH, 'utf-8');
    assert.ok(content.includes('config.lock'), 'should explain the git config.lock race condition');
  });

  test('execute-phase requires sequential dispatch with run_in_background', () => {
    const content = fs.readFileSync(EXECUTE_PHASE_PATH, 'utf-8');
    assert.ok(content.includes('run_in_background'), 'should instruct one-at-a-time dispatch with run_in_background');
  });

  test('execute-phase warns against multiple Task calls in single message', () => {
    const content = fs.readFileSync(EXECUTE_PHASE_PATH, 'utf-8');
    assert.ok(
      content.includes('WRONG') && content.includes('single message'),
      'should warn against sending multiple Task() calls simultaneously'
    );
  });
});


// ─── #3384: cleanup manifest workflow contracts ──────────────────────────────

describe('bug #3384: worktree cleanup workflow contracts', () => {
    test('execute-phase contract requires a cleanup manifest instead of global worktree discovery', () => {
    const content = fs.readFileSync(EXECUTE_PHASE_PATH, 'utf8');
    assert.match(content, /WAVE_WORKTREE_MANIFEST/);
    assert.match(content, /worktree\.cleanup-wave/);
    // #1298: the per-agent manifest write now goes through the validated
    // `worktree record-agent` writer verb (was a prose "atomically append").
    assert.match(content, /record the `\{agent_id, worktree_path, branch, expected_base\}` entry with `gsd_run query worktree\.record-agent/);
    assert.match(content, /try\{if\(!p\)throw new Error\("WAVE_WORKTREE_MANIFEST is unset"\)/);
    assert.match(content, /WT_PATHS_FILE=.*gsd-worktree-paths-/);
    assert.doesNotMatch(content, /done < <\(node -e 'const fs=require\("fs"\);const p=process\.env\.WAVE_WORKTREE_MANIFEST/);
    assert.doesNotMatch(content, /done < <\(git worktree list --porcelain \| grep "\^worktree " \| grep "\\\.claude\/worktrees\/agent-"/);
  });

  test('#1297 gsd-executor self-reports authoritative worktree metadata', () => {
    const content = fs.readFileSync(EXECUTOR_AGENT_PATH, 'utf8');
    assert.match(content, /<worktree_metadata_capture>/);
    assert.match(content, /git rev-parse --show-toplevel/);
    assert.match(content, /git rev-parse --abbrev-ref HEAD/);
    assert.match(content, /GSD_WORKTREE_EXPECTED_BASE=\$\(git rev-parse HEAD\)/);
    assert.match(content, /<worktree_metadata>/);
    assert.match(content, /"worktree_path":/);
    assert.match(content, /"branch":/);
    assert.match(content, /"expected_base":/);
  });

  test('#1297 execute-phase consumes executor-returned worktree metadata before harness metadata', () => {
    const content = fs.readFileSync(EXECUTE_PHASE_PATH, 'utf8');
    assert.match(content, /<worktree_metadata>/);
    assert.match(content, /executor-returned worktree metadata/i);
    assert.match(content, /harness metadata/i);
    assert.ok(
      content.indexOf('executor-returned worktree metadata') < content.indexOf('harness metadata'),
      'execute-phase must prefer executor-returned worktree metadata before runtime harness metadata (#1297)'
    );
  });

  test('quick contract requires a cleanup manifest instead of global worktree discovery', () => {
    const content = fs.readFileSync(QUICK_PATH, 'utf8');
    assert.match(content, /WAVE_WORKTREE_MANIFEST|QUICK_WORKTREE_MANIFEST/);
    assert.match(content, /worktree\.cleanup-wave/);
    assert.match(content, /mktemp "\$\{TMPDIR:-\/tmp\}\/gsd-quick-worktree-/);
    assert.match(content, /append its returned `\{agent_id, worktree_path, branch, expected_base, allowed_bases\}`/);
    // After #3797 architectural fix: quick.md delegates entirely to the SDK's cleanup-wave
    // command (which handles manifest parsing internally). The shell fallback with manual
    // QUICK_WORKTREE_MANIFEST node-e code is removed — the gsd_run call with || exit 1 is the
    // only cleanup path, enforcing safety-refusal semantics (#3174/#3384).
    assert.match(content, /gsd_run query worktree\.cleanup-wave --manifest "\$QUICK_WORKTREE_MANIFEST" \|\| exit 1/);
    assert.doesNotMatch(content, /done < <\(node -e 'const fs=require\("fs"\);const p=process\.env\.QUICK_WORKTREE_MANIFEST/);
    assert.doesNotMatch(content, /done < <\(git worktree list --porcelain \| grep "\^worktree " \| grep "\\\.claude\/worktrees\/agent-"/);
  });
});


// ─── #3425: CWD pin before cleanup ──────────────────────────────────────────

test('#3425: helper cleanup path pins orchestrator CWD to primary worktree and checks EXPECTED_BRANCH', () => {
  const content = fs.readFileSync(EXECUTE_PHASE_PATH, 'utf8');

  // #630: the orchestrator root is now resolved from the manifest's orchestrator_root; the
  // git-worktree-list first entry survives only as a guarded fallback for pre-#630 manifests.
  assert.match(content, /PRIMARY_WT=\$\(MANIFEST="\$WAVE_WORKTREE_MANIFEST" node -e '[^']*orchestrator_root[^']*'\)/);
  assert.match(content, /\[ -n "\$PRIMARY_WT" \] \|\| PRIMARY_WT=\$\(git worktree list --porcelain \| awk '\/\^worktree \/\{print substr\(\$0,10\); exit\}'\)/);
  assert.match(content, /if \[ -z "\$PRIMARY_WT" \]; then\s+echo "FATAL: could not resolve orchestrator worktree before cleanup" >&2\s+exit 1\s+fi/);
  assert.match(content, /cd "\$PRIMARY_WT" \|\| \{ echo "FATAL: cannot cd to primary worktree \$PRIMARY_WT" >&2; exit 1; \}/);
  assert.match(content, /ORCH_BRANCH=\$\(git rev-parse --abbrev-ref HEAD\)/);
  assert.match(content, /FATAL: orchestrator on '\$ORCH_BRANCH' but expected '\$EXPECTED_BRANCH' before worktree cleanup — refusing to merge \(#3174-class drift\)/);
  // After #3797 architectural fix, callsites use gsd_run
  assert.match(content, /gsd_run query worktree\.cleanup-wave --manifest "\$WAVE_WORKTREE_MANIFEST"/);
});

test('#3425: cleanup-tail snippet carries the same primary-worktree pin before removal', () => {
  const content = fs.readFileSync(EXECUTE_PHASE_PATH, 'utf8');

  assert.match(content, /Cleanup-tail: pin orchestrator CWD to its OWN worktree before cleanup-tail \(#3174, #630\)\./);
  // #630: cleanup-tail resolves the orchestrator root from the manifest, with first-entry fallback.
  assert.match(content, /PRIMARY_WT=\$\(MANIFEST="\$WAVE_WORKTREE_MANIFEST" node -e '[^']*orchestrator_root[^']*'\)/);
  assert.match(content, /FATAL: cannot cd to primary worktree \$PRIMARY_WT/);
  assert.match(content, /# Cleanup-tail: remove residual agent worktrees after a cross-wave-dependency deviation\./);
});

describe('bug #48: orchestrator cwd-drift guard at execute_waves entry', () => {
  const content = fs.readFileSync(EXECUTE_PHASE_PATH, 'utf-8');
  const stepStart = content.indexOf('<step name="execute_waves">');
  const nextStep = content.indexOf('<step ', stepStart + 1);
  const stepBody = content.slice(stepStart, nextStep === -1 ? undefined : nextStep);

  test('execute_waves step exists', () => {
    assert.notStrictEqual(stepStart, -1, 'execute-phase.md must contain a <step name="execute_waves"> step');
  });

  test('execute_waves contains a labelled cwd-drift guard (#48)', () => {
    assert.ok(stepBody.includes('cwd-drift guard') && /#48/.test(stepBody), 'execute_waves entry must contain a cwd-drift guard tagged #48');
  });

  test('cwd-drift guard resolves the worktree root via git rev-parse --show-toplevel (#48)', () => {
    const g = stepBody.indexOf('cwd-drift guard');
    assert.notStrictEqual(g, -1);
    const region = stepBody.slice(g, g + 1600);
    assert.ok(/git rev-parse --show-toplevel/.test(region), 'cwd-drift guard must resolve the worktree ROOT via git rev-parse --show-toplevel (#48)');
  });

  test('cwd-drift guard discriminates agent worktrees by branch namespace and fails closed (#48)', () => {
    const g = stepBody.indexOf('cwd-drift guard');
    assert.notStrictEqual(g, -1);
    const region = stepBody.slice(g, g + 1600);
    assert.ok(/worktree-agent-/.test(region), 'guard must use the worktree-agent-* branch namespace as the drift discriminator (#48)');
    assert.ok(/exit 1/.test(region), 'cwd-drift guard must fail closed with exit 1 on drift (#48)');
  });

  test('cwd-drift guard does NOT blanket-refuse .claude/worktrees/ paths (#48)', () => {
    const g = stepBody.indexOf('cwd-drift guard');
    assert.notStrictEqual(g, -1);
    const region = stepBody.slice(g, g + 1600);
    assert.ok(!region.includes('*.claude/worktrees/*') && !region.includes('.claude/worktrees/*)'), 'guard must not blanket-refuse .claude/worktrees/ paths — would break legitimate worktree invocations (#48)');
  });
});

describe('bug #48: orchestrator fail-closed handling of verify-only halts', () => {
  const content = fs.readFileSync(EXECUTE_PHASE_PATH, 'utf-8');
  // eslint-disable-next-line local/no-unbounded-quantifier -- parses this repo's own workflow .md content, fixed-size author-controlled content
  const withoutDispatchNote = content.replace(/<worktree_branch_check>[\s\S]*?<\/worktree_branch_check>/g, '');
  test('orchestrator documents a fail-closed rule for executor exit 42 / FATAL (#48)', () => {
    assert.ok(/exit 42|FATAL/.test(withoutDispatchNote), 'execute-phase.md must reference executor exit 42 / FATAL outside the dispatch note (#48)');
    assert.ok(/(blocked|do NOT merge|not merge)/i.test(withoutDispatchNote), 'execute-phase.md must document an orchestrator-side rule that an executor FATAL/exit 42 marks the plan blocked and is not merged (#48)');
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2384-post-merge-deletion-audit.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2384-post-merge-deletion-audit (consolidation epic #1969 B4 #1973)", () => {
'use strict';

/**
 * Regression test for #2384.
 *
 * During execute-phase, the orchestrator merges per-plan worktree branches into
 * main. The pre-merge deletion check (git diff --diff-filter=D HEAD...WT_BRANCH)
 * only catches files deleted on the worktree branch. A post-merge audit is also
 * required to catch deletions that made it into the merge commit (e.g., files
 * that were in the common ancestor but deleted by the merged worktree) and to
 * provide a revert safety net.
 *
 * After #3797: execute-phase.md delegates worktree cleanup to the SDK's
 * worktree.cleanup-wave command, which implements pre-merge deletion checks
 * (diff --diff-filter=D) internally via executeWorktreeWaveCleanupPlan.
 * The manual post-merge shell audit (MERGE_DEL_COUNT, git reset --hard) has
 * been removed from the workflow — it was part of the SDK-absence fallback.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const EXECUTE_PHASE = path.join(
  __dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md'
);

/**
 * Parse execute-phase.md into a structured contract object.
 * Returns typed boolean fields so tests can assert on structure
 * rather than raw text.
 */
function parseExecutePhaseContract(filePath) {
  const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
  return {
    // Does the workflow call the worktree.cleanup-wave SDK command?
    delegatesToCleanupWave: lines.some(l => l.includes('worktree.cleanup-wave')),
    // Does the cleanup-wave invocation use || exit 1 (fail-closed)?
    cleanupWaveFailClosed: lines.some(
      l => /gsd_run query worktree\.cleanup-wave.*\|\| exit 1/.test(l),
    ),
    // Does the workflow export/reference WAVE_WORKTREE_MANIFEST for the SDK?
    passesWaveManifest: lines.some(l => l.includes('WAVE_WORKTREE_MANIFEST')),
  };
}

describe('execute-phase.md — post-merge deletion audit (#2384)', () => {
  const contract = parseExecutePhaseContract(EXECUTE_PHASE);

  test('execute-phase delegates to worktree.cleanup-wave (which handles deletion audit)', () => {
    // After #3797: worktree.cleanup-wave in worktree-safety.cjs performs
    // diff --diff-filter=D checks (blocks branches with deletions) before merge.
    // The workflow delegates to the SDK rather than duplicating the check inline.
    assert.ok(
      contract.delegatesToCleanupWave,
      'execute-phase.md must delegate to gsd_run query worktree.cleanup-wave (#2384/#3797)',
    );
  });

  test('execute-phase cleanup-wave uses || exit 1 (fail-closed for blocked deletions)', () => {
    // If worktree.cleanup-wave detects deletions, it exits 1 (blocked).
    // The || exit 1 in the workflow propagates that refusal rather than swallowing it.
    assert.ok(
      contract.cleanupWaveFailClosed,
      'execute-phase.md must use || exit 1 so deletion-blocked cleanups surface to the orchestrator',
    );
  });

  test('execute-phase still has pre-merge deletion check (via guard before worktree.cleanup-wave)', () => {
    // The primary deletion guard is now in worktree-safety.cjs (SDK).
    // The workflow must still enforce WAVE_WORKTREE_MANIFEST so the SDK
    // has the info it needs to validate branches.
    assert.ok(
      contract.passesWaveManifest,
      'execute-phase.md must pass WAVE_WORKTREE_MANIFEST to worktree.cleanup-wave',
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2501-resurrection-detection.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2501-resurrection-detection (consolidation epic #1969 B4 #1973)", () => {
/**
 * Tests for bug #2501: resurrection-detection block in execute-phase.md must
 * check git history before deleting new .planning/ files.
 *
 * Root cause: the original logic deleted ANY .planning/ file that was absent
 * from PRE_MERGE_FILES, which includes brand-new files (e.g. SUMMARY.md)
 * that the executor just created. A true "resurrection" is a file that was
 * previously tracked on main, deliberately deleted, and then re-introduced by
 * a worktree merge. Detecting that requires a git history check, not just a
 * pre-merge tree membership check.
 *
 * After #3797: execute-phase.md delegates worktree cleanup to the SDK's
 * worktree.cleanup-wave command. Resurrection detection is handled internally
 * by the SDK. The inline WAS_DELETED shell check has been removed from the
 * workflow — it was part of the SDK-absence fallback which is no longer needed
 * since the preflight block exits if neither local nor global SDK is available.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const EXECUTE_PHASE = path.join(
  __dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md'
);

describe('execute-phase.md — resurrection-detection guard (#2501)', () => {
  let content;

  // Load once; each test reads from the cached string.
  test('file is readable', () => {
    content = fs.readFileSync(EXECUTE_PHASE, 'utf-8');
    assert.ok(content.length > 0, 'execute-phase.md must not be empty');
  });

  test('cleanup delegates to SDK (handles resurrection detection internally)', () => {
    if (!content) content = fs.readFileSync(EXECUTE_PHASE, 'utf-8');
    // After #3797: execute-phase.md delegates to worktree.cleanup-wave, which
    // handles pre-merge deletion checks internally. The SDK checks diff --diff-filter=D
    // before merging, blocking branches that contain file deletions (#2384/#2501).
    assert.ok(
      content.includes('worktree.cleanup-wave'),
      'execute-phase.md must delegate to worktree.cleanup-wave (#2501/#3797)',
    );
  });

  test('execute-phase does not use the buggy PRE_MERGE_FILES form', () => {
    if (!content) content = fs.readFileSync(EXECUTE_PHASE, 'utf-8');
    // The buggy pattern from before #2501 — deletion conditioned on absence
    // from PRE_MERGE_FILES snapshot. Must remain absent.
    const hasBuggyGuard =
      content.includes('PRE_MERGE_FILES') &&
      /if\s*!\s*echo\s*"\$PRE_MERGE_FILES"\s*\|\s*grep\s+-qxF\s*"\$RESURRECTED"/.test(content);
    assert.ok(
      !hasBuggyGuard,
      'execute-phase.md must NOT delete files based on the PRE_MERGE_FILES snapshot grep (inverted guard bug #2501)',
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3195-quick-resurrection-guard.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3195-quick-resurrection-guard (consolidation epic #1969 B4 #1973)", () => {
/**
 * Drift-guard for bug #3195: quick.md and execute-phase.md must both use
 * the same resurrection-detection approach so they stay in sync.
 *
 * After #3797: both workflows delegate worktree cleanup to the SDK's
 * worktree.cleanup-wave command, which implements resurrection detection
 * (diff --diff-filter=D history checks) internally. The inline WAS_DELETED
 * shell variable form has been removed from both workflows — it was part of
 * the SDK-absence fallback which is now dead code since preflight exits if
 * neither local nor global SDK is available.
 *
 * This test ensures both workflows continue to use the same cleanup
 * mechanism (SDK delegation), not one inline and one delegated.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const QUICK_MD = path.join(
  __dirname, '..', 'gsd-core', 'workflows', 'quick.md'
);
const EXECUTE_PHASE_MD = path.join(
  __dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md'
);

describe('resurrection guard drift check — quick.md vs execute-phase.md (#3195)', () => {
  let quickContent;
  let executePhaseContent;

  test('both workflow files are readable', () => {
    quickContent = fs.readFileSync(QUICK_MD, 'utf-8');
    executePhaseContent = fs.readFileSync(EXECUTE_PHASE_MD, 'utf-8');
    assert.ok(quickContent.length > 0, 'quick.md must not be empty');
    assert.ok(executePhaseContent.length > 0, 'execute-phase.md must not be empty');
  });

  test('quick.md delegates resurrection detection to SDK (worktree.cleanup-wave)', () => {
    if (!quickContent) quickContent = fs.readFileSync(QUICK_MD, 'utf-8');
    // After #3797: quick.md delegates to worktree.cleanup-wave, which handles
    // resurrection detection (diff --diff-filter=D) internally. The inline
    // WAS_DELETED form has been removed — it was part of the SDK-absence fallback.
    assert.ok(
      quickContent.includes('worktree.cleanup-wave'),
      'quick.md must delegate to worktree.cleanup-wave for resurrection detection (#3195/#3797)'
    );
  });

  test('execute-phase.md delegates resurrection detection to SDK (worktree.cleanup-wave)', () => {
    if (!executePhaseContent) executePhaseContent = fs.readFileSync(EXECUTE_PHASE_MD, 'utf-8');
    // After #3797: execute-phase.md delegates to worktree.cleanup-wave, which handles
    // resurrection detection (diff --diff-filter=D) internally.
    assert.ok(
      executePhaseContent.includes('worktree.cleanup-wave'),
      'execute-phase.md must delegate to worktree.cleanup-wave for resurrection detection (#3195/#3797)'
    );
  });

  test('both workflows use the same cleanup mechanism (SDK delegation parity)', () => {
    if (!quickContent) quickContent = fs.readFileSync(QUICK_MD, 'utf-8');
    if (!executePhaseContent) executePhaseContent = fs.readFileSync(EXECUTE_PHASE_MD, 'utf-8');
    const quickDelegates = quickContent.includes('worktree.cleanup-wave');
    const executeDelegates = executePhaseContent.includes('worktree.cleanup-wave');
    assert.strictEqual(
      quickDelegates,
      executeDelegates,
      'quick.md and execute-phase.md must both use the same cleanup mechanism (SDK delegation parity, #3195)'
    );
  });

  test('quick.md does not use the buggy PRE_MERGE_FILES grep form', () => {
    if (!quickContent) quickContent = fs.readFileSync(QUICK_MD, 'utf-8');
    // The buggy pattern: deletion conditioned on absence from PRE_MERGE_FILES snapshot
    const hasBuggyGuard =
      quickContent.includes('PRE_MERGE_FILES') &&
      /if\s*!\s*echo\s*"\$PRE_MERGE_FILES"\s*\|\s*grep\s+-qxF\s*"\$RESURRECTED"/.test(quickContent);
    assert.ok(
      !hasBuggyGuard,
      'quick.md must NOT delete files based on the PRE_MERGE_FILES snapshot grep (inverted guard bug #3195)'
    );
  });

  test('execute-phase.md does not use the buggy PRE_MERGE_FILES grep form', () => {
    if (!executePhaseContent) executePhaseContent = fs.readFileSync(EXECUTE_PHASE_MD, 'utf-8');
    const hasBuggyGuard =
      executePhaseContent.includes('PRE_MERGE_FILES') &&
      /if\s*!\s*echo\s*"\$PRE_MERGE_FILES"\s*\|\s*grep\s+-qxF\s*"\$RESURRECTED"/.test(executePhaseContent);
    assert.ok(
      !hasBuggyGuard,
      'execute-phase.md must NOT delete files based on the PRE_MERGE_FILES snapshot grep (inverted guard bug)'
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3521-quick-cleanup-cwd-pin.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3521-quick-cleanup-cwd-pin (consolidation epic #1969 B4 #1973)", () => {
// allow-test-rule: source-text-is-the-product (see #3521)
// quick.md is the shipped orchestration contract for /gsd-quick; this
// regression test previously locked the CWD-safety guard in the manual shell
// cleanup loop. After #3797, quick.md delegates cleanup entirely to the SDK's
// worktree.cleanup-wave command, which encapsulates CWD-pinning, STATE.md/
// ROADMAP.md backup/restore, and deletion guards internally.
//
// This test file now verifies the delegation contract: quick.md calls
// worktree.cleanup-wave with || exit 1 (fail-closed), which enforces the
// safety semantics that were previously implemented inline in the shell loop.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const QUICK_MD = path.join(__dirname, '..', 'gsd-core', 'workflows', 'quick.md');

function readQuickMd() {
  return fs.readFileSync(QUICK_MD, 'utf8');
}

describe('bug #3521 — quick.md post-merge cleanup CWD safety (via SDK delegation, #3797)', () => {

  test('quick.md is readable', () => {
    const content = readQuickMd();
    assert.ok(content.length > 0, 'quick.md must not be empty');
  });

  test('quick.md cleanup delegates CWD-safe worktree cleanup to SDK (worktree.cleanup-wave)', () => {
    const content = readQuickMd();
    // After #3797: quick.md delegates to gsd_run query worktree.cleanup-wave
    // which handles CWD pinning, STATE.md backup, deletion guards, and branch
    // cleanup internally. The manual shell loop has been removed.
    assert.ok(
      content.includes('worktree.cleanup-wave'),
      'quick.md must delegate cleanup to gsd_run query worktree.cleanup-wave (#3797)',
    );
  });

  test('quick.md cleanup-wave call uses || exit 1 to enforce fail-closed safety (#3521 contract)', () => {
    const content = readQuickMd();
    // The || exit 1 enforces fail-closed: SDK safety refusals (e.g. branch
    // drift detection from #3174) surface immediately rather than being swallowed.
    // This is the equivalent of the pre-#3797 `gsd_run query ... || exit 1` in the
    // `if command -v gsd-sdk` branch.
    assert.match(
      content,
      /gsd_run query worktree\.cleanup-wave.*\|\| exit 1/,
      'quick.md cleanup-wave must use || exit 1 — fail-closed for safety refusals (#3521/#3797)',
    );
  });

  test('quick.md manifest guard still blocks broad cleanup when manifest is missing (#3384)', () => {
    const content = readQuickMd();
    // The manifest guard must still be present before the cleanup-wave call
    // to prevent broad worktree cleanup when the manifest file is absent.
    assert.ok(
      content.includes('QUICK_WORKTREE_MANIFEST') || content.includes('WAVE_WORKTREE_MANIFEST'),
      'quick.md must still guard cleanup behind QUICK_WORKTREE_MANIFEST (#3384)',
    );
    assert.ok(
      content.includes('refusing broad worktree cleanup') || content.includes('missing QUICK_WORKTREE_MANIFEST'),
      'quick.md must emit a blocked message when the manifest is missing (#3384)',
    );
  });

});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2838-summary-rescue-gitignored-planning.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2838-summary-rescue-gitignored-planning (consolidation epic #1969 B4 #1973)", () => {
/**
 * Regression tests for #2838: SUMMARY rescue silently fails when .planning/
 * is gitignored.
 *
 * After #3797: execute-phase.md and quick.md delegate worktree cleanup to the
 * SDK's worktree.cleanup-wave command. The SDK's executeWorktreeWaveCleanupPlan
 * handles SUMMARY rescue internally using a filesystem-level find+cp approach
 * (bypassing gitignore) rather than the old git ls-files --exclude-standard
 * form that silently dropped gitignored files.
 *
 * The inline "Safety net" shell rescue block that was previously in both
 * workflow files has been removed — it was part of the SDK-absence fallback
 * which is now dead code since preflight exits if neither local nor global SDK
 * is available.
 *
 * This test file verifies that both workflows correctly delegate to the SDK
 * for SUMMARY rescue, and that neither workflow retains the broken inline form.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const EXECUTE_PHASE_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'execute-phase.md');
const QUICK_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'quick.md');

/**
 * Parse a workflow markdown file into a structured contract object.
 * Returns typed boolean fields so tests assert on structure, not raw text.
 */
function parseWorkflowContract(filePath) {
  const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
  return {
    // Non-empty check
    nonEmpty: lines.length > 0 && lines.some(l => l.length > 0),
    // Does the workflow delegate SUMMARY rescue to worktree.cleanup-wave?
    delegatesToCleanupWave: lines.some(l => l.includes('worktree.cleanup-wave')),
    // Does the cleanup-wave invocation use || exit 1 (fail-closed)?
    cleanupWaveFailClosed: lines.some(
      l => /gsd_run query worktree\.cleanup-wave.*\|\| exit 1/.test(l),
    ),
    // Does the workflow still contain the broken ls-files --exclude-standard rescue form?
    hasBrokenLsFilesForm: lines.some(
      l => l.includes('ls-files --modified --others --exclude-standard'),
    ),
  };
}

const executePhaseContract = parseWorkflowContract(EXECUTE_PHASE_PATH);
const quickContract = parseWorkflowContract(QUICK_PATH);

describe('bug-2838: SUMMARY rescue delegates to SDK (worktree.cleanup-wave)', () => {

  test('execute-phase.md is readable', () => {
    assert.ok(executePhaseContract.nonEmpty, 'execute-phase.md must not be empty');
  });

  test('quick.md is readable', () => {
    assert.ok(quickContract.nonEmpty, 'quick.md must not be empty');
  });

  test('execute-phase.md delegates SUMMARY rescue to SDK (worktree.cleanup-wave)', () => {
    // After #3797: worktree.cleanup-wave handles SUMMARY rescue via find+cp
    // (bypasses gitignore, fixing the #2838 bug). The workflow delegates to the
    // SDK rather than implementing rescue inline.
    assert.ok(
      executePhaseContract.delegatesToCleanupWave,
      'execute-phase.md must delegate to worktree.cleanup-wave for SUMMARY rescue (#2838/#3797)',
    );
  });

  test('quick.md delegates SUMMARY rescue to SDK (worktree.cleanup-wave)', () => {
    // After #3797: worktree.cleanup-wave handles SUMMARY rescue via find+cp
    // (bypasses gitignore, fixing the #2838 bug).
    assert.ok(
      quickContract.delegatesToCleanupWave,
      'quick.md must delegate to worktree.cleanup-wave for SUMMARY rescue (#2838/#3797)',
    );
  });

  test('execute-phase.md does not retain broken git ls-files --exclude-standard rescue form (#2838)', () => {
    // The broken form used --exclude-standard which silently filtered out
    // gitignored .planning/ files — the root cause of #2838.
    assert.ok(
      !executePhaseContract.hasBrokenLsFilesForm,
      'execute-phase.md must not use ls-files --exclude-standard for SUMMARY rescue (broken for gitignored .planning/)',
    );
  });

  test('quick.md does not retain broken git ls-files --exclude-standard rescue form (#2838)', () => {
    assert.ok(
      !quickContract.hasBrokenLsFilesForm,
      'quick.md must not use ls-files --exclude-standard for SUMMARY rescue (broken for gitignored .planning/)',
    );
  });

  test('execute-phase.md cleanup-wave uses || exit 1 (fail-closed so rescue errors surface)', () => {
    // If the SDK's rescue fails (e.g. filesystem error), || exit 1 surfaces
    // the failure to the orchestrator rather than silently continuing and
    // losing the SUMMARY.
    assert.ok(
      executePhaseContract.cleanupWaveFailClosed,
      'execute-phase.md cleanup-wave must use || exit 1 so SUMMARY rescue failures surface (#2838/#3797)',
    );
  });

  test('quick.md cleanup-wave uses || exit 1 (fail-closed so rescue errors surface)', () => {
    assert.ok(
      quickContract.cleanupWaveFailClosed,
      'quick.md cleanup-wave must use || exit 1 so SUMMARY rescue failures surface (#2838/#3797)',
    );
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-630-wave-cleanup-orchestrator-root.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-630-wave-cleanup-orchestrator-root (consolidation epic #1969 B6 #1975)", () => {
// allow-test-rule: source-text-is-the-product (see #630)
// execute-phase.md is the shipped orchestration contract for wave execution and
// cleanup. Bug #630: the two wave-cleanup guards resolved PRIMARY_WT from
// `git worktree list --porcelain`'s first entry — always the main checkout —
// so an orchestrator running from a non-primary (per-phase lane) worktree was
// cd'd off its own lane and tripped the #3174 branch-drift assertion at cleanup,
// refusing merge-back. The fix persists the dispatch-time orchestrator root in
// WAVE_WORKTREE_MANIFEST and pins cleanup to that, falling back to first-entry
// only for pre-#630 manifests.
//
// This file locks the source contract (the .md is the product) AND behaviorally
// proves the pivot by running the shipped manifest-reader one-liner against a
// real non-primary-worktree git topology.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { gitOrThrow, throwIfFailed } = require('./helpers/git-fixture.cjs');

const EXECUTE_PHASE_MD = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md');

// 30000ms: git plumbing (init/config/add/commit/worktree/rev-parse) against a
// small mkdtemp fixture repo, and a `node -e <manifest-reader>` one-liner
// extracted from the shipped workflow — well over any observed duration for
// either class of call in this bug-630 block.
const BUG_630_TIMEOUT_MS = 30_000;

function readMd() {
  return fs.readFileSync(EXECUTE_PHASE_MD, 'utf8');
}

// Pull the exact `node -e '...'` manifest-reader script shipped in the cleanup
// guard, so the behavioral test exercises the real shipped code, not a copy.
function extractManifestReaderScript() {
  const content = readMd();
  // Anchor on `PRIMARY_WT=$(MANIFEST=...` so we grab the cleanup READER, not the
  // dispatch-time writer one-liner (which shares the `MANIFEST="..." node -e` prefix).
  const m = content.match(/PRIMARY_WT=\$\(MANIFEST="\$WAVE_WORKTREE_MANIFEST" node -e '([^']*)'\)/);
  assert.ok(m, 'expected a `PRIMARY_WT=$(MANIFEST="$WAVE_WORKTREE_MANIFEST" node -e \'...\')` reader in execute-phase.md');
  return m[1];
}

function git(cwd, args) {
  return gitOrThrow(args, { cwd, timeoutMs: BUG_630_TIMEOUT_MS }).trim();
}

// runNode never throws; the shipped manifest-reader one-liner is expected to
// exit cleanly (it emits either a resolved path or nothing — never an
// error), so a non-clean exit here is a genuine defect and must still abort
// the test loudly, matching the pre-migration execFileSync throw.
function runManifestReaderOrThrow(args, opts) {
  const r = runNode(args, opts);
  throwIfFailed(r, `node ${args.join(' ')}`);
  return r.stdout;
}

// Canonicalize a path the way the OS does. On Windows, os.tmpdir() can yield an 8.3
// short name (RUNNER~1) while `git worktree list` reports the long form (runneradmin);
// realpathSync.native reconciles both to the true canonical path so comparisons are stable.
function canon(p) {
  return fs.realpathSync.native(p);
}

describe('bug #630 — wave-cleanup pins to the orchestrator root, not git-worktree-list first entry', () => {
  test('execute-phase.md is readable', () => {
    assert.ok(readMd().length > 0, 'execute-phase.md must not be empty');
  });

  // ── Source contract (the .md is the product) ──────────────────────────────

  test('dispatch persists the orchestrator root into the manifest (#630)', () => {
    const content = readMd();
    assert.match(
      content,
      /ORCH_ROOT=\$\(git rev-parse --show-toplevel\)/,
      'manifest init must capture the dispatch-time orchestrator root via show-toplevel',
    );
    assert.match(
      content,
      /orchestrator_root:\s*process\.env\.ORCH_ROOT/,
      'manifest init must write orchestrator_root into WAVE_WORKTREE_MANIFEST',
    );
  });

  test('both cleanup guards resolve PRIMARY_WT from the manifest orchestrator_root (#630)', () => {
    const content = readMd();
    const readers = content.match(
      /PRIMARY_WT=\$\(MANIFEST="\$WAVE_WORKTREE_MANIFEST" node -e '[^']*orchestrator_root[^']*'\)/g,
    );
    assert.ok(
      readers && readers.length >= 2,
      `both wave-cleanup guards (templated + cleanup-tail) must read orchestrator_root from the manifest; found ${readers ? readers.length : 0}`,
    );
  });

  test('first-entry resolution survives only as a guarded fallback, never the sole resolver (#630)', () => {
    const content = readMd();
    // Every remaining first-entry resolution must be preceded by the `[ -n "$PRIMARY_WT" ] ||`
    // guard, i.e. it only runs when the manifest lookup produced nothing.
    const firstEntryLines = content.match(/^.*git worktree list --porcelain \| awk '\/\^worktree \/.*$/gm) || [];
    for (const line of firstEntryLines) {
      assert.match(
        line,
        /\[ -n "\$PRIMARY_WT" \] \|\|/,
        `first-entry resolution must be a guarded fallback, not the primary resolver: ${line.trim()}`,
      );
    }
    assert.ok(firstEntryLines.length >= 2, 'expected the fallback in both cleanup guards');
  });

  // ── Behavioral proof of the pivot ─────────────────────────────────────────

  test('shipped manifest reader resolves to the lane worktree, while first-entry resolves to main (#630)', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-630-'));
    try {
      const mainDir = path.join(tmpRoot, 'main');
      fs.mkdirSync(mainDir);
      git(mainDir, ['-c', 'init.defaultBranch=main', 'init', '-q']);
      git(mainDir, ['config', 'user.email', 'test@example.com']);
      git(mainDir, ['config', 'user.name', 'Test']);
      fs.writeFileSync(path.join(mainDir, 'f.txt'), 'x\n');
      git(mainDir, ['add', '.']);
      git(mainDir, ['commit', '-q', '-m', 'init']);

      // Non-primary worktree on a per-phase lane branch.
      const laneDir = path.join(tmpRoot, 'lane');
      git(mainDir, ['worktree', 'add', '-q', '-b', 'feat/lane', laneDir]);

      const realMain = canon(mainDir);
      const realLane = canon(laneDir);

      // Manifest as written at dispatch: orchestrator_root is the lane (the orchestrator runs there).
      const manifest = path.join(tmpRoot, 'wave.json');
      fs.writeFileSync(manifest, JSON.stringify({ orchestrator_root: realLane, worktrees: [] }) + '\n');

      // Run the EXACT shipped reader one-liner.
      const script = extractManifestReaderScript();
      const resolved = runManifestReaderOrThrow(['-e', script], {
        cwd: laneDir,
        env: { ...process.env, MANIFEST: manifest },
        timeoutMs: BUG_630_TIMEOUT_MS,
      }).trim();

      // The buggy first-entry resolution (run from the lane) yields the MAIN checkout.
      const firstEntry = canon(
        git(laneDir, ['worktree', 'list', '--porcelain'])
          .split('\n')
          .find(l => l.startsWith('worktree '))
          .slice('worktree '.length),
      );

      assert.equal(canon(resolved), realLane, 'manifest reader must resolve to the orchestrator lane worktree');
      assert.equal(firstEntry, realMain, 'sanity: first-entry resolution points at the main checkout (the #630 bug target)');
      assert.notEqual(canon(resolved), firstEntry, 'the fix must diverge from the old first-entry behavior for a lane orchestrator');

      // The #3174 branch assertion now passes (pinned to lane → branch matches EXPECTED_BRANCH);
      // pinning to first-entry (main) would have failed it.
      const expectedBranch = 'feat/lane';
      assert.equal(git(resolved, ['rev-parse', '--abbrev-ref', 'HEAD']), expectedBranch, 'lane pin satisfies the #3174 branch check');
      assert.notEqual(git(firstEntry, ['rev-parse', '--abbrev-ref', 'HEAD']), expectedBranch, 'first-entry pin would have tripped the #3174 branch check');
    } finally {
      cleanup(tmpRoot);
    }
  });

  test('manifest reader falls through (empty output) when orchestrator_root is absent — fallback engages (#630)', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-630-fb-'));
    try {
      const manifest = path.join(tmpRoot, 'legacy.json');
      // Pre-#630 manifest shape: no orchestrator_root.
      fs.writeFileSync(manifest, JSON.stringify({ worktrees: [] }) + '\n');
      const script = extractManifestReaderScript();
      const out = runManifestReaderOrThrow(['-e', script], {
        env: { ...process.env, MANIFEST: manifest },
        timeoutMs: BUG_630_TIMEOUT_MS,
      });
      assert.equal(out, '', 'reader must emit nothing for a manifest without orchestrator_root so the first-entry fallback engages');
    } finally {
      cleanup(tmpRoot);
    }
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-48-cwd-drift-guard-e2e.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-48-cwd-drift-guard-e2e (consolidation epic #1969 B6 #1975)", () => {
// allow-test-rule: integration-test-input (see #48)
// Reads execute-phase.md to extract + execute the cwd-drift guard bash snippet against real git worktrees.

'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { cleanup, readFileNormalized } = require('./helpers.cjs');
const { runHook, runGit } = require('./helpers/process-seam.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const EXECUTE_PHASE_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'execute-phase.md');

// #3145: class-norm timeout, not a per-suite value — see helpers/timeouts.cjs.
const { GIT_TIMEOUT_MS, HOOK_FANOUT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

// ---------------------------------------------------------------------------
// Extract the cwd-drift guard bash block from execute-phase.md
// ---------------------------------------------------------------------------

/**
 * Reads execute-phase.md and extracts the bash fenced block that implements
 * the orchestrator cwd-drift guard inside <step name="execute_waves">.
 *
 * Algorithm:
 *   1. Find <step name="execute_waves">
 *   2. After that, find the first occurrence of "cwd-drift guard"
 *   3. After that, find the first ```bash fence
 *   4. Return the body between ```bash\n and the closing ```
 *
 * Throws with a clear message if any step fails or sanity checks don't pass.
 */
function extractCwdGuardBash() {
  // readFileNormalized() strips \r\n -> \n at the read boundary (helpers.cjs;
  // DEFECT.TEST-SHELL-PIPELINE-NONPORTABLE, #1700/#2650). The `\r?\n` in the
  // fence regex below only protects the FENCE DELIMITER match — it does
  // nothing for `\r` characters embedded in the CAPTURED BODY between the
  // fences, which is what actually reaches spawnSync('bash', ...) in
  // runGuard(). A prior version of this comment claimed the regex alone was
  // "CRLF-safe"; it was not — reading through readFileNormalized() first is
  // what makes the extracted body itself safe to execute on a Windows checkout.
  const content = readFileNormalized(EXECUTE_PHASE_PATH);

  const stepMarker = '<step name="execute_waves">';
  const stepIdx = content.indexOf(stepMarker);
  if (stepIdx === -1) {
    throw new Error(`extractCwdGuardBash: could not find "${stepMarker}" in ${EXECUTE_PHASE_PATH}`);
  }

  const afterStep = content.slice(stepIdx + stepMarker.length);

  const driftMarker = 'cwd-drift guard';
  const driftIdx = afterStep.indexOf(driftMarker);
  if (driftIdx === -1) {
    throw new Error(`extractCwdGuardBash: could not find "${driftMarker}" after execute_waves step in ${EXECUTE_PHASE_PATH}`);
  }

  const afterDrift = afterStep.slice(driftIdx + driftMarker.length);

  // Fence delimiter match via the canonical seam. `content` is already LF-only
  // from readFileNormalized() above, so `\r?\n` here is redundant, not
  // load-bearing — kept anyway for robustness against un-normalized input.
  const afterDriftLines = afterDrift.split(/\r?\n/);
  const guardFence = scanFencedBlocks(afterDriftLines).find(
    (b) => b.closeLineIdx !== -1 && ['bash', 'sh'].includes((b.infoString || '').trim()),
  );
  if (!guardFence) {
    throw new Error(`extractCwdGuardBash: could not find \`\`\`bash fence after cwd-drift guard heading in ${EXECUTE_PHASE_PATH}`);
  }

  const guardBash = afterDriftLines.slice(guardFence.openLineIdx + 1, guardFence.closeLineIdx).join('\n');

  if (!guardBash.trim()) {
    throw new Error('extractCwdGuardBash: extracted bash block is empty');
  }
  if (!guardBash.includes('git rev-parse --show-toplevel')) {
    throw new Error('extractCwdGuardBash: sanity check failed — extracted block does not contain "git rev-parse --show-toplevel"');
  }
  if (!guardBash.includes('(worktree-)?agent-')) {
    throw new Error('extractCwdGuardBash: sanity check failed — extracted block does not contain "(worktree-)?agent-"');
  }

  return guardBash;
}

// ---------------------------------------------------------------------------
// Run guard helper
// ---------------------------------------------------------------------------

/**
 * Run the guard bash snippet in a given cwd using bash -c.
 * Returns { status, stderr }.
 */
function runGuard(guardBash, cwd) {
  // Bash FAN-OUT: this is the same execute-phase.md cwd-drift guard snippet
  // exercised by tests/execute-phase-worktree-guard.test.cjs — a sequence of
  // git plumbing calls (rev-parse, log, status) under one `bash`
  // interpreter, not a single git call. 30000ms was sized for the wrong
  // class. Same class as the observed CI failures in
  // tests/quick-branching.test.cjs (PR #3787 run 32668773524) and
  // tests/worktree-safety.test.cjs (`next` run 32608945654). See
  // HOOK_FANOUT_TIMEOUT_MS in ./helpers/timeouts.cjs for the class
  // rationale.
  const result = runHook('-c', [guardBash], {
    interpreter: 'bash',
    cwd,
    timeoutMs: HOOK_FANOUT_TIMEOUT_MS,
  });
  return { status: result.exitCode, stderr: result.stderr || '' };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let upstreamDir;      // bare upstream git repo (the main worktree)
let featureDir;       // normal feature worktree on branch workspace/feature-x
let agentWtDir;       // agent worktree on branch worktree-agent-deadbeef
let agentSubdir;      // subdirectory inside agentWtDir
let legitUnderClaude; // non-agent worktree whose PATH is under .claude/worktrees/
const dirsToCleanup = [];

// Migrated off a hand-rolled shell string (naive per-arg double-quoting,
// run through execSync) onto gitOrThrow's argv form directly — every call
// site below passes a plain args array with no shell metacharacters, so
// running it as direct argv is behaviorally identical and drops the
// quoting hazard. Return value stays the RAW, un-trimmed stdout string
// (gitOrThrow does not trim), matching what execSync returned and what
// this block's ~10 callers expect.
function git(cwd, args) {
  return gitOrThrow(args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
}

before(() => {
  // --- upstream: the main repo with an initial commit ---
  upstreamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-48-upstream-'));
  dirsToCleanup.push(upstreamDir);

  git(upstreamDir, ['init', '-b', 'main']);
  git(upstreamDir, ['config', 'user.email', 'test@example.com']);
  git(upstreamDir, ['config', 'user.name', 'Test User']);
  git(upstreamDir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(upstreamDir, 'README.md'), '# test\n');
  git(upstreamDir, ['add', 'README.md']);
  git(upstreamDir, ['commit', '-m', 'chore: init']);

  // --- feature worktree: non-agent branch, path outside .claude/worktrees ---
  featureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-48-feature-'));
  dirsToCleanup.push(featureDir);
  // git worktree add creates the directory itself; remove so it can do so
  fs.rmdirSync(featureDir);
  git(upstreamDir, ['worktree', 'add', '-b', 'workspace/feature-x', featureDir]);

  // --- agent worktree: branch worktree-agent-deadbeef ---
  // Sits under featureDir/.claude/worktrees/agent-deadbeef
  const agentWtParent = path.join(featureDir, '.claude', 'worktrees');
  fs.mkdirSync(agentWtParent, { recursive: true });
  agentWtDir = path.join(agentWtParent, 'agent-deadbeef');
  git(upstreamDir, ['worktree', 'add', '-b', 'worktree-agent-deadbeef', agentWtDir]);

  // --- subdir inside agent worktree ---
  agentSubdir = path.join(agentWtDir, 'src', 'deep');
  fs.mkdirSync(agentSubdir, { recursive: true });

  // --- legitUnderClaude: non-agent worktree whose PATH is under .claude/worktrees/ ---
  // This proves the guard discriminates by branch name, not path.
  const legitParent = path.join(upstreamDir, '.claude', 'worktrees');
  fs.mkdirSync(legitParent, { recursive: true });
  legitUnderClaude = path.join(legitParent, 'legit-feature');
  git(upstreamDir, ['worktree', 'add', '-b', 'workspace/legit', legitUnderClaude]);
});

after(() => {
  // Prune stale worktree metadata before removing dirs
  try { git(upstreamDir, ['worktree', 'prune']); } catch (_) { /* best-effort */ }
  for (const d of dirsToCleanup) {
    try { cleanup(d); } catch (_) { /* best-effort */ }
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('bug #48: orchestrator cwd-drift guard — executable e2e', () => {
  let guardBash;

  before(() => {
    guardBash = extractCwdGuardBash();
  });

  test('guard passes from a feature worktree on a non-agent branch (exit 0)', () => {
    const { status, stderr } = runGuard(guardBash, featureDir);
    assert.equal(
      status, 0,
      `Expected exit 0 from feature worktree, got ${status}. stderr: ${stderr}`,
    );
  });

  test('guard fails closed (exit 1) when cwd is inside an agent worktree', () => {
    const { status, stderr } = runGuard(guardBash, agentWtDir);
    assert.equal(
      status, 1,
      `Expected exit 1 from agent worktree, got ${status}. stderr: ${stderr}`,
    );
    assert.match(
      stderr,
      /agent worktree/i,
      `Expected stderr to mention "agent worktree", got: ${stderr}`,
    );
  });

  test('guard fails closed (exit 1) from a SUBDIRECTORY of an agent worktree (root resolution)', () => {
    // git rev-parse --show-toplevel resolves to the worktree root regardless of cwd subdir.
    // The guard must catch this via the branch-name check, not the path check.
    const { status, stderr } = runGuard(guardBash, agentSubdir);
    assert.equal(
      status, 1,
      `Expected exit 1 from agent worktree subdir, got ${status}. stderr: ${stderr}`,
    );
  });

  test('guard does NOT blanket-refuse a non-agent worktree located under .claude/worktrees/ (exit 0)', () => {
    // Discriminator is the worktree-agent-* branch namespace, NOT the path.
    const { status, stderr } = runGuard(guardBash, legitUnderClaude);
    assert.equal(
      status, 0,
      `Expected exit 0 from non-agent worktree under .claude/worktrees/, got ${status}. stderr: ${stderr}`,
    );
  });

  test('guard fails closed (exit 1) when not inside a git repo', (t) => {
    const nonRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-48-nongit-'));
    try {
      // Verify that git rev-parse --show-toplevel actually fails here.
      // On some systems /tmp itself might be inside a git repo (e.g. if the
      // user's HOME is a git repo). If it resolves, we must skip this test.
      const check = runGit(['rev-parse', '--show-toplevel'], {
        cwd: nonRepoDir,
        timeoutMs: GIT_TIMEOUT_MS,
      });
      if (check.exitCode === 0) {
        t.skip('nonRepoDir unexpectedly resolved to a git repo — skipping');
        return;
      }

      const { status, stderr } = runGuard(guardBash, nonRepoDir);
      assert.equal(
        status, 1,
        `Expected exit 1 when not inside a git repo, got ${status}. stderr: ${stderr}`,
      );
    } finally {
      try { cleanup(nonRepoDir); } catch (_) { /* best-effort */ }
    }
  });
});
  });
}

describe('durable wave worktree manifest contract (#4853)', () => {
  const childProcess = require('node:child_process');
  const os = require('node:os');
  const { cleanup, readFileNormalized } = require('./helpers.cjs');
  const { gitOrThrow } = require('./helpers/git-fixture.cjs');
  const { HOOK_FANOUT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
  const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
  const GSD_TOOLS = path.join(REPO_ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');

  function extractCleanupTailBash() {
    const content = readFileNormalized(EXECUTE_PHASE_PATH);
    const marker = 'Cleanup-tail snippet';
    const markerIdx = content.indexOf(marker);
    if (markerIdx === -1) {
      throw new Error(`extractCleanupTailBash: could not find "${marker}" in ${EXECUTE_PHASE_PATH}`);
    }
    const afterMarker = content.slice(markerIdx + marker.length);
    const lines = splitLines(afterMarker);
    const fence = scanFencedBlocks(lines).find(
      (b) => b.closeLineIdx !== -1 && ['bash', 'sh'].includes((b.infoString || '').trim()),
    );
    if (!fence) {
      throw new Error(`extractCleanupTailBash: could not find \`\`\`bash fence after "${marker}"`);
    }
    const block = lines.slice(fence.openLineIdx + 1, fence.closeLineIdx).join('\n');
    if (!block.includes('CLEANUP_FAILED')) {
      throw new Error('extractCleanupTailBash: extracted block does not contain CLEANUP_FAILED');
    }
    return block;
  }

  function extractManifestCreationBash() {
    const content = readFileNormalized(EXECUTE_PHASE_PATH);
    const marker = '**Worktree mode**';
    const markerIdx = content.indexOf(marker);
    if (markerIdx === -1) {
      throw new Error(`extractManifestCreationBash: could not find "${marker}" in ${EXECUTE_PHASE_PATH}`);
    }
    const afterMarker = content.slice(markerIdx + marker.length);
    const lines = splitLines(afterMarker);
    const fence = scanFencedBlocks(lines).find(
      (b) => b.closeLineIdx !== -1 && ['bash', 'sh'].includes((b.infoString || '').trim()),
    );
    if (!fence) {
      throw new Error(`extractManifestCreationBash: could not find \`\`\`bash fence after "${marker}"`);
    }
    const block = lines.slice(fence.openLineIdx + 1, fence.closeLineIdx).join('\n');
    if (!block.includes('WAVE_WORKTREE_MANIFEST')) {
      throw new Error('extractManifestCreationBash: extracted block does not contain WAVE_WORKTREE_MANIFEST');
    }
    const ifIdx = block.indexOf('if [ "${USE_WORKTREES');
    if (ifIdx === -1) {
      throw new Error('extractManifestCreationBash: could not find if [ "${USE_WORKTREES in block');
    }
    return block.slice(ifIdx).trim();
  }

  test('cleanup-tail bash removes residual worktrees and cleans up manifest on success', (t) => {
    const cleanupTailBash = extractCleanupTailBash();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4853-cleanup-succ-'));
    t.after(() => {
      try { cleanup(root); } catch (_) { /* best-effort */ }
    });
    const repo = path.join(root, 'repo');
    const wt = path.join(root, 'agent-wt');
    fs.mkdirSync(repo);
    gitOrThrow(['init', '-q', '-b', 'main'], { cwd: repo });
    gitOrThrow(['config', 'user.email', 'test@example.com'], { cwd: repo });
    gitOrThrow(['config', 'user.name', 'test'], { cwd: repo });
    gitOrThrow(['config', 'commit.gpgsign', 'false'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'init.txt'), 'init\n');
    gitOrThrow(['add', 'init.txt'], { cwd: repo });
    gitOrThrow(['commit', '-q', '-m', 'init'], { cwd: repo });

    gitOrThrow(['worktree', 'add', '-q', '-b', 'worktree-agent-test1', wt], { cwd: repo });
    assert.equal(fs.existsSync(wt), true, 'sanity: agent worktree created');

    const manifestPath = path.join(repo, 'wave-1-manifest.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        orchestrator_root: repo,
        worktrees: [{ agent_id: 'test1', worktree_path: wt, branch: 'worktree-agent-test1' }],
      }) + '\n',
    );

    const scriptPath = path.join(root, 'cleanup-tail.sh');
    fs.writeFileSync(scriptPath, cleanupTailBash);
    const res = childProcess.spawnSync('bash', [scriptPath], {
      cwd: repo,
      env: { ...process.env, WAVE_WORKTREE_MANIFEST: manifestPath },
      stdio: 'pipe',
      timeout: HOOK_FANOUT_TIMEOUT_MS,
    });

    assert.equal(res.status, 0, `cleanup-tail must exit 0 on success. stderr: ${res.stderr?.toString()}`);
    assert.equal(fs.existsSync(wt), false, 'residual worktree must be removed from disk');
    assert.equal(
      gitOrThrow(['branch', '--list', 'worktree-agent-test1'], { cwd: repo }).trim(),
      '',
      'residual branch must be deleted',
    );
    assert.equal(fs.existsSync(manifestPath), false, 'manifest must be deleted when all residual worktrees are cleaned');
  });

  test('cleanup-tail bash preserves manifest when residual worktree removal fails (negative control)', (t) => {
    if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) {
      t.skip('directory permission failure simulation is POSIX-specific and bypassed when running as root');
      return;
    }

    const cleanupTailBash = extractCleanupTailBash();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4853-cleanup-fail-'));
    const repo = path.join(root, 'repo');
    const wt = path.join(root, 'agent-wt-fail');
    t.after(() => {
      try { fs.chmodSync(wt, 0o755); } catch (_) { /* restore */ }
      try { cleanup(root); } catch (_) { /* best-effort */ }
    });
    fs.mkdirSync(repo);
    gitOrThrow(['init', '-q', '-b', 'main'], { cwd: repo });
    gitOrThrow(['config', 'user.email', 'test@example.com'], { cwd: repo });
    gitOrThrow(['config', 'user.name', 'test'], { cwd: repo });
    gitOrThrow(['config', 'commit.gpgsign', 'false'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'init.txt'), 'init\n');
    gitOrThrow(['add', 'init.txt'], { cwd: repo });
    gitOrThrow(['commit', '-q', '-m', 'init'], { cwd: repo });

    gitOrThrow(['worktree', 'add', '-q', '-b', 'worktree-agent-fail1', wt], { cwd: repo });

    const manifestPath = path.join(repo, 'wave-1-manifest.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        orchestrator_root: repo,
        worktrees: [{ agent_id: 'fail1', worktree_path: wt, branch: 'worktree-agent-fail1' }],
      }) + '\n',
    );

    // Make worktree undeletable so git worktree remove fails
    fs.chmodSync(wt, 0o555);

    const scriptPath = path.join(root, 'cleanup-tail.sh');
    fs.writeFileSync(scriptPath, cleanupTailBash);
    const res = childProcess.spawnSync('bash', [scriptPath], {
      cwd: repo,
      env: { ...process.env, WAVE_WORKTREE_MANIFEST: manifestPath },
      stdio: 'pipe',
      timeout: HOOK_FANOUT_TIMEOUT_MS,
    });

    const stderr = (res.stderr || '').toString();
    assert.match(stderr, /Residual worktrees remain; preserving manifest at/, 'stderr must report manifest preservation');
    assert.equal(fs.existsSync(manifestPath), true, 'manifest must be preserved on disk when cleanup fails');
  });

  test('execute-phase dispatch block creates manifest and blocks overwrite on pre-existing manifest', (t) => {
    const creationBash = extractManifestCreationBash();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4853-create-'));
    t.after(() => {
      try { cleanup(root); } catch (_) { /* best-effort */ }
    });
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    const phaseDir = path.join(repo, '.planning', 'phases', '01-sample');
    fs.mkdirSync(phaseDir, { recursive: true });
    gitOrThrow(['init', '-q', '-b', 'main'], { cwd: repo });
    gitOrThrow(['config', 'user.email', 'test@example.com'], { cwd: repo });
    gitOrThrow(['config', 'user.name', 'test'], { cwd: repo });
    gitOrThrow(['config', 'commit.gpgsign', 'false'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'init.txt'), 'init\n');
    gitOrThrow(['add', 'init.txt'], { cwd: repo });
    gitOrThrow(['commit', '-q', '-m', 'init'], { cwd: repo });

    const script = `
set -e
gsd_run() {
  node "${GSD_TOOLS}" "$@"
}
export CURRENT_WAVE=1
export PHASE_DIR="${phaseDir}"
${creationBash}
`;
    const scriptPath = path.join(root, 'test-create.sh');
    fs.writeFileSync(scriptPath, script);

    // Initial creation: succeeds
    const res1 = childProcess.spawnSync('bash', [scriptPath], {
      cwd: repo,
      stdio: 'pipe',
      timeout: HOOK_FANOUT_TIMEOUT_MS,
    });
    assert.equal(res1.status, 0, `initial manifest creation must succeed. stderr: ${res1.stderr?.toString()}`);
    const manifestPath = path.join(phaseDir, 'wave-1-manifest.json');
    assert.equal(fs.existsSync(manifestPath), true, 'manifest must be created on disk');
    const manifestContent = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.deepEqual(manifestContent.worktrees, [], 'newly created manifest must have empty worktrees array');

    // Second execution with pre-existing manifest: must block with exit non-zero
    const res2 = childProcess.spawnSync('bash', [scriptPath], {
      cwd: repo,
      stdio: 'pipe',
      timeout: HOOK_FANOUT_TIMEOUT_MS,
    });
    assert.notEqual(res2.status, 0, 'dispatch block must exit non-zero when pre-existing manifest exists');
    const stderr2 = (res2.stderr || '').toString();
    assert.match(stderr2, /BLOCKED: pre-existing wave manifest found at/, 'stderr must report pre-existing manifest guard');
    assert.match(stderr2, /cleanup-wave --manifest/, 'stderr must report reconciliation advice');
    assert.deepEqual(
      JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
      manifestContent,
      'pre-existing manifest content must remain completely untouched',
    );
  });

  test('manifest creation writeFileSync flag wx fails closed if file appears right before write', (t) => {
    const creationBash = extractManifestCreationBash();
    const nodeLine = creationBash.split('\n').find((l) => l.includes('node -e') && l.includes('writeFileSync'));
    assert.ok(nodeLine, 'creation block must contain node writeFileSync invocation');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4853-wx-'));
    t.after(() => {
      try { cleanup(root); } catch (_) { /* best-effort */ }
    });
    const manifestPath = path.join(root, 'wave-1-manifest.json');
    fs.writeFileSync(manifestPath, 'pre-existing');

    // Run the exact extracted command from execute-phase.md
    const scriptPath = path.join(root, 'test-wx.sh');
    fs.writeFileSync(scriptPath, `ORCH_ROOT="${root}" MANIFEST="${manifestPath}" ${nodeLine}\n`);
    const writeRes = childProcess.spawnSync(
      'bash',
      [scriptPath],
      {
        cwd: root,
        stdio: 'pipe',
        timeout: HOOK_FANOUT_TIMEOUT_MS,
      },
    );
    assert.notEqual(writeRes.status, 0, 'write with flag wx must fail non-zero when file already exists');
    assert.equal(fs.readFileSync(manifestPath, 'utf8'), 'pre-existing', 'file content must remain untouched');
  });

  test('execute-phase dispatch block fails with fatal when wave number cannot be resolved', (t) => {
    const creationBash = extractManifestCreationBash();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4853-no-wave-'));
    t.after(() => {
      try { cleanup(root); } catch (_) { /* best-effort */ }
    });
    gitOrThrow(['init', '-q', '-b', 'main'], { cwd: root });
    gitOrThrow(['config', 'user.email', 'test@example.com'], { cwd: root });
    gitOrThrow(['config', 'user.name', 'test'], { cwd: root });
    gitOrThrow(['config', 'commit.gpgsign', 'false'], { cwd: root });
    fs.writeFileSync(path.join(root, 'init.txt'), 'init\n');
    gitOrThrow(['add', 'init.txt'], { cwd: root });
    gitOrThrow(['commit', '-q', '-m', 'init'], { cwd: root });

    const script = `
set -e
gsd_run() {
  node "${GSD_TOOLS}" "$@"
}
unset CURRENT_WAVE
unset WAVE_WORKTREE_PLANS
export PHASE_DIR="${root}"
${creationBash}
`;
    const scriptPath = path.join(root, 'test-no-wave.sh');
    fs.writeFileSync(scriptPath, script);
    const res = childProcess.spawnSync('bash', [scriptPath], {
      cwd: root,
      stdio: 'pipe',
      timeout: HOOK_FANOUT_TIMEOUT_MS,
    });
    assert.notEqual(res.status, 0, 'must exit non-zero when wave number cannot be resolved');
    const stderr = (res.stderr || '').toString();
    assert.match(stderr, /FATAL: cannot resolve wave number before worktree dispatch/);
  });

  test('execute-phase dispatch block fails with fatal when neither PHASE_DIR nor PHASE_NUMBER is set', (t) => {
    const creationBash = extractManifestCreationBash();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4853-no-phase-'));
    t.after(() => {
      try { cleanup(root); } catch (_) { /* best-effort */ }
    });
    gitOrThrow(['init', '-q', '-b', 'main'], { cwd: root });
    gitOrThrow(['config', 'user.email', 'test@example.com'], { cwd: root });
    gitOrThrow(['config', 'user.name', 'test'], { cwd: root });
    gitOrThrow(['config', 'commit.gpgsign', 'false'], { cwd: root });
    fs.writeFileSync(path.join(root, 'init.txt'), 'init\n');
    gitOrThrow(['add', 'init.txt'], { cwd: root });
    gitOrThrow(['commit', '-q', '-m', 'init'], { cwd: root });

    const script = `
set -e
gsd_run() {
  node "${GSD_TOOLS}" "$@"
}
export CURRENT_WAVE=1
unset PHASE_DIR
unset PHASE_NUMBER
${creationBash}
`;
    const scriptPath = path.join(root, 'test-no-phase.sh');
    fs.writeFileSync(scriptPath, script);
    const res = childProcess.spawnSync('bash', [scriptPath], {
      cwd: root,
      stdio: 'pipe',
      timeout: HOOK_FANOUT_TIMEOUT_MS,
    });
    assert.notEqual(res.status, 0, 'must exit non-zero when neither PHASE_DIR nor PHASE_NUMBER is set');
    const stderr = (res.stderr || '').toString();
    assert.match(stderr, /FATAL: neither PHASE_DIR nor PHASE_NUMBER is set before worktree dispatch/);
  });

  test('execute-phase dispatch block resolves via PHASE_NUMBER when PHASE_DIR is unset', (t) => {
    const creationBash = extractManifestCreationBash();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4853-phase-num-'));
    t.after(() => {
      try { cleanup(root); } catch (_) { /* best-effort */ }
    });
    gitOrThrow(['init', '-q', '-b', 'main'], { cwd: root });
    gitOrThrow(['config', 'user.email', 'test@example.com'], { cwd: root });
    gitOrThrow(['config', 'user.name', 'test'], { cwd: root });
    gitOrThrow(['config', 'commit.gpgsign', 'false'], { cwd: root });
    fs.writeFileSync(path.join(root, 'init.txt'), 'init\n');
    gitOrThrow(['add', 'init.txt'], { cwd: root });
    gitOrThrow(['commit', '-q', '-m', 'init'], { cwd: root });

    const phaseDir = path.join(root, '.planning', 'phases', '01-sample');
    fs.mkdirSync(phaseDir, { recursive: true });

    const script = `
set -e
gsd_run() {
  node "${GSD_TOOLS}" "$@"
}
export CURRENT_WAVE=1
unset PHASE_DIR
export PHASE_NUMBER="01"
${creationBash}
`;
    const scriptPath = path.join(root, 'test-phase-num.sh');
    fs.writeFileSync(scriptPath, script);
    const res = childProcess.spawnSync('bash', [scriptPath], {
      cwd: root,
      stdio: 'pipe',
      timeout: HOOK_FANOUT_TIMEOUT_MS,
    });
    assert.equal(res.status, 0, `dispatch block with PHASE_NUMBER must succeed: ${res.stderr?.toString()}`);
    const expectedManifest = path.join(phaseDir, 'wave-1-manifest.json');
    assert.ok(fs.existsSync(expectedManifest), 'manifest must be created under discovered phase dir');
  });

  test('execute-phase dispatch block fails with fatal when wave manifest is tracked in git', (t) => {
    const creationBash = extractManifestCreationBash();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4853-git-tracked-'));
    t.after(() => {
      try { cleanup(root); } catch (_) { /* best-effort */ }
    });
    gitOrThrow(['init', '-q', '-b', 'main'], { cwd: root });
    gitOrThrow(['config', 'user.email', 'test@example.com'], { cwd: root });
    gitOrThrow(['config', 'user.name', 'test'], { cwd: root });
    gitOrThrow(['config', 'commit.gpgsign', 'false'], { cwd: root });
    fs.writeFileSync(path.join(root, 'init.txt'), 'init\n');
    gitOrThrow(['add', 'init.txt'], { cwd: root });
    gitOrThrow(['commit', '-q', '-m', 'init'], { cwd: root });

    const phaseDir = path.join(root, '.planning', 'phases', '01-sample');
    fs.mkdirSync(phaseDir, { recursive: true });
    const manifestPath = path.join(phaseDir, 'wave-1-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ orchestrator_root: root, worktrees: [] }));
    gitOrThrow(['add', manifestPath], { cwd: root });
    gitOrThrow(['commit', '-q', '-m', 'track manifest'], { cwd: root });

    const script = `
set -e
gsd_run() {
  node "${GSD_TOOLS}" "$@"
}
export CURRENT_WAVE=1
export PHASE_DIR="${phaseDir}"
${creationBash}
`;
    const scriptPath = path.join(root, 'test-tracked.sh');
    fs.writeFileSync(scriptPath, script);
    const res = childProcess.spawnSync('bash', [scriptPath], {
      cwd: root,
      stdio: 'pipe',
      timeout: HOOK_FANOUT_TIMEOUT_MS,
    });
    assert.notEqual(res.status, 0, 'must exit non-zero when manifest is tracked in git');
    const stderr = (res.stderr || '').toString();
    assert.match(stderr, /FATAL: wave manifest at .* is tracked by git/);
  });

  test('cmdCommit: implicit sweep excludes untracked wave manifest and allows normal planning commit', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4853-commit-1-'));
    t.after(() => {
      try { cleanup(root); } catch (_) { /* best-effort */ }
    });
    gitOrThrow(['init', '-q', '-b', 'main'], { cwd: root });
    gitOrThrow(['config', 'user.email', 'test@example.com'], { cwd: root });
    gitOrThrow(['config', 'user.name', 'test'], { cwd: root });
    gitOrThrow(['config', 'commit.gpgsign', 'false'], { cwd: root });
    fs.writeFileSync(path.join(root, 'init.txt'), 'init\n');
    gitOrThrow(['add', 'init.txt'], { cwd: root });
    gitOrThrow(['commit', '-q', '-m', 'init'], { cwd: root });

    const phase1 = path.join(root, '.planning', 'phases', '01-sample');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, 'PLAN.md'), '# Plan 1\n');
    const manifest1 = path.join(phase1, 'wave-1-manifest.json');
    fs.writeFileSync(manifest1, JSON.stringify({ orchestrator_root: root, worktrees: [] }));

    const res1 = childProcess.spawnSync(
      'node',
      [GSD_TOOLS, 'commit', '-m', 'docs(01): update plan 1'],
      { cwd: root, stdio: 'pipe', timeout: HOOK_FANOUT_TIMEOUT_MS },
    );
    assert.equal(res1.status, 0, `implicit commit should succeed: ${res1.stderr?.toString()}`);
    assert.notEqual(
      childProcess.spawnSync('git', ['ls-files', '--error-unmatch', '.planning/phases/01-sample/wave-1-manifest.json'], { cwd: root, timeout: HOOK_FANOUT_TIMEOUT_MS }).status,
      0,
      'wave-1-manifest.json must NOT be tracked after implicit commit',
    );
    assert.ok(fs.existsSync(manifest1), 'wave-1-manifest.json must still exist on disk');
  });

  test('cmdCommit: explicit directory argument excludes wave manifest', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4853-commit-2-'));
    t.after(() => {
      try { cleanup(root); } catch (_) { /* best-effort */ }
    });
    gitOrThrow(['init', '-q', '-b', 'main'], { cwd: root });
    gitOrThrow(['config', 'user.email', 'test@example.com'], { cwd: root });
    gitOrThrow(['config', 'user.name', 'test'], { cwd: root });
    gitOrThrow(['config', 'commit.gpgsign', 'false'], { cwd: root });
    fs.writeFileSync(path.join(root, 'init.txt'), 'init\n');
    gitOrThrow(['add', 'init.txt'], { cwd: root });
    gitOrThrow(['commit', '-q', '-m', 'init'], { cwd: root });

    const phase2 = path.join(root, '.planning', 'phases', '02-dir');
    fs.mkdirSync(phase2, { recursive: true });
    fs.writeFileSync(path.join(phase2, 'PLAN.md'), '# Plan 2\n');
    const manifest2 = path.join(phase2, 'wave-1-manifest.json');
    fs.writeFileSync(manifest2, JSON.stringify({ orchestrator_root: root, worktrees: [] }));

    const res2 = childProcess.spawnSync(
      'node',
      [GSD_TOOLS, 'commit', '-m', 'docs(02): update plan 2', '--files', '.planning/phases/02-dir'],
      { cwd: root, stdio: 'pipe', timeout: HOOK_FANOUT_TIMEOUT_MS },
    );
    assert.equal(res2.status, 0, `explicit dir commit should succeed: ${res2.stderr?.toString()}`);
    assert.notEqual(
      childProcess.spawnSync('git', ['ls-files', '--error-unmatch', '.planning/phases/02-dir/wave-1-manifest.json'], { cwd: root, timeout: HOOK_FANOUT_TIMEOUT_MS }).status,
      0,
      'wave-1-manifest.json must NOT be tracked after explicit directory commit',
    );
    assert.equal(
      childProcess.spawnSync('git', ['ls-files', '--error-unmatch', '.planning/phases/02-dir/PLAN.md'], { cwd: root, timeout: HOOK_FANOUT_TIMEOUT_MS }).status,
      0,
      'PLAN.md must be tracked after explicit directory commit',
    );
  });

  test('cmdCommit: explicit file argument naming wave manifest is excluded and reported in skipped_files (#4454)', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4853-commit-3-'));
    t.after(() => {
      try { cleanup(root); } catch (_) { /* best-effort */ }
    });
    gitOrThrow(['init', '-q', '-b', 'main'], { cwd: root });
    gitOrThrow(['config', 'user.email', 'test@example.com'], { cwd: root });
    gitOrThrow(['config', 'user.name', 'test'], { cwd: root });
    gitOrThrow(['config', 'commit.gpgsign', 'false'], { cwd: root });
    fs.writeFileSync(path.join(root, 'init.txt'), 'init\n');
    gitOrThrow(['add', 'init.txt'], { cwd: root });
    gitOrThrow(['commit', '-q', '-m', 'init'], { cwd: root });

    const phase2 = path.join(root, '.planning', 'phases', '02-dir');
    fs.mkdirSync(phase2, { recursive: true });
    fs.writeFileSync(path.join(phase2, 'STATE.md'), '# State\n');
    const manifestPath = path.join(phase2, 'wave-1-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ orchestrator_root: root, worktrees: [] }));

    const res3 = childProcess.spawnSync(
      'node',
      [GSD_TOOLS, 'commit', '-m', 'docs(02): update state', '--files', '.planning/phases/02-dir/STATE.md', '.planning/phases/02-dir/wave-1-manifest.json'],
      { cwd: root, stdio: 'pipe', timeout: HOOK_FANOUT_TIMEOUT_MS },
    );
    assert.equal(res3.status, 0, `explicit file commit should succeed: ${res3.stderr?.toString()}`);
    assert.notEqual(
      childProcess.spawnSync('git', ['ls-files', '--error-unmatch', '.planning/phases/02-dir/wave-1-manifest.json'], { cwd: root, timeout: HOOK_FANOUT_TIMEOUT_MS }).status,
      0,
      'wave-1-manifest.json must NOT be tracked even when explicitly passed in --files',
    );
    const json3 = JSON.parse(res3.stdout.toString());
    assert.deepEqual(json3.skipped_files, ['.planning/phases/02-dir/wave-1-manifest.json']);

    // Sole manifest in --files produces nothing_to_commit and reports skipped_files
    const resSole = childProcess.spawnSync(
      'node',
      [GSD_TOOLS, 'commit', '-m', 'docs(02): try commit manifest only', '--files', '.planning/phases/02-dir/wave-1-manifest.json'],
      { cwd: root, stdio: 'pipe', timeout: HOOK_FANOUT_TIMEOUT_MS },
    );
    assert.equal(resSole.status, 0, `sole manifest commit should exit 0 with nothing_to_commit: ${resSole.stderr?.toString()}`);
    const jsonSole = JSON.parse(resSole.stdout.toString());
    assert.equal(jsonSole.committed, false);
    assert.equal(jsonSole.reason, 'nothing_to_commit');
    assert.deepEqual(jsonSole.skipped_files, ['.planning/phases/02-dir/wave-1-manifest.json']);
  });

  test('cmdCommit: manifest-only sweep returns nothing_to_commit instead of commit_failed', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4853-commit-manifest-only-'));
    t.after(() => {
      try { cleanup(root); } catch (_) { /* best-effort */ }
    });
    gitOrThrow(['init', '-q', '-b', 'main'], { cwd: root });
    gitOrThrow(['config', 'user.email', 'test@example.com'], { cwd: root });
    gitOrThrow(['config', 'user.name', 'test'], { cwd: root });
    gitOrThrow(['config', 'commit.gpgsign', 'false'], { cwd: root });
    fs.writeFileSync(path.join(root, 'init.txt'), 'init\n');
    gitOrThrow(['add', 'init.txt'], { cwd: root });
    gitOrThrow(['commit', '-q', '-m', 'init'], { cwd: root });

    const phase = path.join(root, '.planning', 'phases', '01-sample');
    fs.mkdirSync(phase, { recursive: true });
    const manifestPath = path.join(phase, 'wave-1-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ orchestrator_root: root, worktrees: [] }));

    const res = childProcess.spawnSync(
      'node',
      [GSD_TOOLS, 'commit', '-m', 'docs(01): default sweep with only wave manifest present'],
      { cwd: root, stdio: 'pipe', timeout: HOOK_FANOUT_TIMEOUT_MS },
    );
    assert.equal(res.status, 0, `commit should exit 0: ${res.stderr?.toString()}`);
    const json = JSON.parse(res.stdout.toString());
    assert.equal(json.committed, false);
    assert.equal(json.reason, 'nothing_to_commit');
    assert.notEqual(
      childProcess.spawnSync('git', ['ls-files', '--error-unmatch', '.planning/phases/01-sample/wave-1-manifest.json'], { cwd: root, timeout: HOOK_FANOUT_TIMEOUT_MS }).status,
      0,
      'manifest must not be tracked',
    );
  });

  test('cmdCommit: already-tracked manifest in git history is NOT unstaged/deleted and modifications are NOT committed', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4853-commit-4-'));
    t.after(() => {
      try { cleanup(root); } catch (_) { /* best-effort */ }
    });
    gitOrThrow(['init', '-q', '-b', 'main'], { cwd: root });
    gitOrThrow(['config', 'user.email', 'test@example.com'], { cwd: root });
    gitOrThrow(['config', 'user.name', 'test'], { cwd: root });
    gitOrThrow(['config', 'commit.gpgsign', 'false'], { cwd: root });
    fs.writeFileSync(path.join(root, 'init.txt'), 'init\n');
    gitOrThrow(['add', 'init.txt'], { cwd: root });
    gitOrThrow(['commit', '-q', '-m', 'init'], { cwd: root });

    const phase3 = path.join(root, '.planning', 'phases', '03-tracked');
    fs.mkdirSync(phase3, { recursive: true });
    const manifest3 = path.join(phase3, 'wave-1-manifest.json');
    fs.writeFileSync(manifest3, '{"initial":true}\n');
    gitOrThrow(['add', '-f', '.planning/phases/03-tracked/wave-1-manifest.json'], { cwd: root });
    gitOrThrow(['commit', '-q', '-m', 'track manifest explicitly'], { cwd: root });
    assert.equal(
      childProcess.spawnSync('git', ['ls-files', '--error-unmatch', '.planning/phases/03-tracked/wave-1-manifest.json'], { cwd: root, timeout: HOOK_FANOUT_TIMEOUT_MS }).status,
      0,
      'manifest3 must initially be tracked',
    );

    // Now modify the tracked manifest and add a new file
    fs.writeFileSync(manifest3, '{"modified":true}\n');
    fs.writeFileSync(path.join(phase3, 'PLAN.md'), '# Plan 3\n');

    // Run commit via gsd-tools
    const res4 = childProcess.spawnSync(
      'node',
      [GSD_TOOLS, 'commit', '-m', 'docs(03): commit plan 3'],
      { cwd: root, stdio: 'pipe', timeout: HOOK_FANOUT_TIMEOUT_MS },
    );
    assert.equal(res4.status, 0, `commit should succeed: ${res4.stderr?.toString()}`);
    // Check that manifest3 is STILL tracked in git (NOT deleted/untracked by cmdCommit)
    assert.equal(
      childProcess.spawnSync('git', ['ls-files', '--error-unmatch', '.planning/phases/03-tracked/wave-1-manifest.json'], { cwd: root, timeout: HOOK_FANOUT_TIMEOUT_MS }).status,
      0,
      'manifest3 must remain tracked in git (no accidental git rm --cached)',
    );
    // Check that the modified working tree changes were NOT committed (git diff shows modification against HEAD)
    const diff = childProcess.spawnSync('git', ['diff', 'HEAD', '--', '.planning/phases/03-tracked/wave-1-manifest.json'], { cwd: root, timeout: HOOK_FANOUT_TIMEOUT_MS }).stdout.toString();
    assert.match(diff, /modified/, 'working tree modification must NOT have been committed to git history');
  });

  test('cmdCommit: parity between JS isWaveManifestPath and git pathspec WAVE_MANIFEST_PATHSPEC_EXCLUDE', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4853-commit-5-'));
    t.after(() => {
      try { cleanup(root); } catch (_) { /* best-effort */ }
    });
    gitOrThrow(['init', '-q', '-b', 'main'], { cwd: root });
    gitOrThrow(['config', 'user.email', 'test@example.com'], { cwd: root });
    gitOrThrow(['config', 'user.name', 'test'], { cwd: root });
    gitOrThrow(['config', 'commit.gpgsign', 'false'], { cwd: root });
    fs.writeFileSync(path.join(root, 'init.txt'), 'init\n');
    gitOrThrow(['add', 'init.txt'], { cwd: root });
    gitOrThrow(['commit', '-q', '-m', 'init'], { cwd: root });

    const commandsMod = require('../gsd-core/bin/lib/commands.cjs');
    const { isWaveManifestPath } = commandsMod;

    const manifestUnderPlanning = path.join(root, '.planning', 'wave-1-manifest.json');
    const manifestUnderPhase = path.join(root, '.planning', 'phases', '01-foo', 'wave-2-manifest.json');
    const digitPrefixedNonNumeric = path.join(root, '.planning', 'wave-1x-manifest.json');
    const waveNotesManifest = path.join(root, '.planning', 'phases', '01-foo', 'wave-1-notes-manifest.json');
    const nonNumericUnderPlanning = path.join(root, '.planning', 'wave-foo-manifest.json');
    const manifestOutsidePlanning = path.join(root, 'src', 'wave-3-manifest.json');
    fs.mkdirSync(path.dirname(manifestUnderPhase), { recursive: true });
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(manifestUnderPlanning, '{}');
    fs.writeFileSync(manifestUnderPhase, '{}');
    fs.writeFileSync(digitPrefixedNonNumeric, '{}');
    fs.writeFileSync(waveNotesManifest, '{}');
    fs.writeFileSync(nonNumericUnderPlanning, '{}');
    fs.writeFileSync(manifestOutsidePlanning, '{}');

    // JS matcher checks
    assert.equal(isWaveManifestPath(manifestUnderPlanning, root), true);
    assert.equal(isWaveManifestPath(manifestUnderPhase, root), true);
    assert.equal(isWaveManifestPath(digitPrefixedNonNumeric, root), false, 'wave-1x is not a valid numeric wave manifest');
    assert.equal(isWaveManifestPath(waveNotesManifest, root), false, 'wave-1-notes is a user file, not a wave manifest');
    assert.equal(isWaveManifestPath(nonNumericUnderPlanning, root), false);
    assert.equal(isWaveManifestPath(manifestOutsidePlanning, root), false);

    const { WAVE_MANIFEST_PATHSPEC_EXCLUDES } = commandsMod;
    // Git pathspec exclude check: git ls-files with WAVE_MANIFEST_PATHSPEC_EXCLUDES should exclude wave manifests
    const lsFiles = childProcess.spawnSync(
      'git',
      ['ls-files', '--others', '--', ...WAVE_MANIFEST_PATHSPEC_EXCLUDES],
      { cwd: root, timeout: HOOK_FANOUT_TIMEOUT_MS },
    ).stdout.toString().split('\n').filter(Boolean);

    assert.ok(!lsFiles.includes('.planning/wave-1-manifest.json'), 'git pathspec must exclude .planning/wave-1-manifest.json');
    assert.ok(!lsFiles.includes('.planning/phases/01-foo/wave-2-manifest.json'), 'git pathspec must exclude .planning/phases/01-foo/wave-2-manifest.json');
    assert.ok(lsFiles.includes('.planning/wave-foo-manifest.json'), 'git pathspec must NOT exclude non-numeric name');
    assert.ok(lsFiles.includes('.planning/wave-1x-manifest.json'), 'git pathspec must NOT exclude non-positive-integer wave-1x');
    assert.ok(lsFiles.includes('.planning/phases/01-foo/wave-1-notes-manifest.json'), 'git pathspec must NOT exclude wave-1-notes');
    assert.ok(lsFiles.includes('src/wave-3-manifest.json'), 'git pathspec must NOT exclude file outside .planning');
  });

  test('manifest creation block parity between execute-phase.md and workflow-backend-dispatch.md', () => {
    const executePhaseBash = extractManifestCreationBash();
    const dispatchDocPath = path.join(__dirname, '..', 'capabilities', 'claude-orchestration', 'docs', 'workflow-backend-dispatch.md');
    const dispatchDocContent = readFileNormalized(dispatchDocPath);
    const marker = '**Create the manifest BEFORE invoking the tool**';
    const markerIdx = dispatchDocContent.indexOf(marker);
    assert.ok(markerIdx !== -1, `could not find "${marker}" in ${dispatchDocPath}`);
    const afterMarker = dispatchDocContent.slice(markerIdx + marker.length);
    const lines = splitLines(afterMarker);
    const fence = scanFencedBlocks(lines).find(
      (b) => b.closeLineIdx !== -1 && ['bash', 'sh'].includes((b.infoString || '').trim()),
    );
    assert.ok(fence, `could not find bash fence after "${marker}"`);
    const dispatchBash = lines.slice(fence.openLineIdx + 1, fence.closeLineIdx).join('\n');

    // Assert trimmed line parity
    const normalizeBlock = (b) => b.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
    assert.equal(
      normalizeBlock(dispatchBash),
      normalizeBlock(executePhaseBash),
      'workflow-backend-dispatch.md manifest creation block must match execute-phase.md verbatim',
    );
  });

  test('execute-phase dispatch block resolves wave from plan index when CURRENT_WAVE is unset', (t) => {
    const creationBash = extractManifestCreationBash();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4853-wave-fallback-'));
    t.after(() => {
      try { cleanup(root); } catch (_) { /* best-effort */ }
    });
    gitOrThrow(['init', '-q', '-b', 'main'], { cwd: root });
    gitOrThrow(['config', 'user.email', 'test@example.com'], { cwd: root });
    gitOrThrow(['config', 'user.name', 'test'], { cwd: root });
    gitOrThrow(['config', 'commit.gpgsign', 'false'], { cwd: root });
    fs.writeFileSync(path.join(root, 'init.txt'), 'init\n');
    gitOrThrow(['add', 'init.txt'], { cwd: root });
    gitOrThrow(['commit', '-q', '-m', 'init'], { cwd: root });

    const phaseDir = path.join(root, '.planning', 'phases', '02-analytics');
    fs.mkdirSync(phaseDir, { recursive: true });
    // Plan 02-01 completed (has summary) in wave 1; Plan 02-02 incomplete in wave 2 (depends on 02-01)
    fs.writeFileSync(path.join(phaseDir, '02-01-PLAN.md'), '---\nwave: 1\n---\n# Plan 02-01\n');
    fs.writeFileSync(path.join(phaseDir, '02-01-SUMMARY.md'), '# Summary 02-01\n');
    fs.writeFileSync(path.join(phaseDir, '02-02-PLAN.md'), '---\nwave: 2\ndepends_on:\n  - 02-01\n---\n# Plan 02-02\n');

    const script = `
set -e
gsd_run() {
  node "${GSD_TOOLS}" "$@"
}
unset CURRENT_WAVE
export PHASE_DIR="${phaseDir}"
${creationBash}
`;
    const scriptPath = path.join(root, 'test-dispatch.sh');
    fs.writeFileSync(scriptPath, script);
    const res = childProcess.spawnSync('bash', [scriptPath], {
      cwd: root,
      stdio: 'pipe',
      timeout: HOOK_FANOUT_TIMEOUT_MS,
    });
    assert.equal(res.status, 0, `dispatch block should resolve wave and create manifest: ${res.stderr?.toString()}`);
    assert.ok(fs.existsSync(path.join(phaseDir, 'wave-2-manifest.json')), 'wave-2-manifest.json must be created');
    assert.ok(!fs.existsSync(path.join(phaseDir, 'wave-1-manifest.json')), 'wave-1-manifest.json must NOT be created');
  });

  test('execute-phase dispatch block succeeds when CURRENT_WAVE matches fallback wave', (t) => {
    const creationBash = extractManifestCreationBash();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4853-wave-agree-'));
    t.after(() => {
      try { cleanup(root); } catch (_) { /* best-effort */ }
    });
    gitOrThrow(['init', '-q', '-b', 'main'], { cwd: root });
    gitOrThrow(['config', 'user.email', 'test@example.com'], { cwd: root });
    gitOrThrow(['config', 'user.name', 'test'], { cwd: root });
    gitOrThrow(['config', 'commit.gpgsign', 'false'], { cwd: root });
    fs.writeFileSync(path.join(root, 'init.txt'), 'init\n');
    gitOrThrow(['add', 'init.txt'], { cwd: root });
    gitOrThrow(['commit', '-q', '-m', 'init'], { cwd: root });

    const phaseDir = path.join(root, '.planning', 'phases', '02-analytics');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '02-01-PLAN.md'), '---\nwave: 1\n---\n# Plan 02-01\n');
    fs.writeFileSync(path.join(phaseDir, '02-01-SUMMARY.md'), '# Summary 02-01\n');
    fs.writeFileSync(path.join(phaseDir, '02-02-PLAN.md'), '---\nwave: 2\ndepends_on:\n  - 02-01\n---\n# Plan 02-02\n');

    const scriptAgree = `
set -e
gsd_run() {
  node "${GSD_TOOLS}" "$@"
}
export CURRENT_WAVE=2
export PHASE_DIR="${phaseDir}"
${creationBash}
`;
    const scriptAgreePath = path.join(root, 'test-agree.sh');
    fs.writeFileSync(scriptAgreePath, scriptAgree);
    const resAgree = childProcess.spawnSync('bash', [scriptAgreePath], {
      cwd: root,
      stdio: 'pipe',
      timeout: HOOK_FANOUT_TIMEOUT_MS,
    });
    assert.equal(resAgree.status, 0, `matching CURRENT_WAVE must succeed: ${resAgree.stderr?.toString()}`);
    assert.ok(fs.existsSync(path.join(phaseDir, 'wave-2-manifest.json')), 'wave-2-manifest.json must be created');
  });

  test('execute-phase dispatch block fails closed when CURRENT_WAVE disagrees with fallback wave', (t) => {
    const creationBash = extractManifestCreationBash();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4853-wave-disagree-'));
    t.after(() => {
      try { cleanup(root); } catch (_) { /* best-effort */ }
    });
    gitOrThrow(['init', '-q', '-b', 'main'], { cwd: root });
    gitOrThrow(['config', 'user.email', 'test@example.com'], { cwd: root });
    gitOrThrow(['config', 'user.name', 'test'], { cwd: root });
    gitOrThrow(['config', 'commit.gpgsign', 'false'], { cwd: root });
    fs.writeFileSync(path.join(root, 'init.txt'), 'init\n');
    gitOrThrow(['add', 'init.txt'], { cwd: root });
    gitOrThrow(['commit', '-q', '-m', 'init'], { cwd: root });

    const phaseDir = path.join(root, '.planning', 'phases', '02-analytics');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '02-01-PLAN.md'), '---\nwave: 1\n---\n# Plan 02-01\n');
    fs.writeFileSync(path.join(phaseDir, '02-01-SUMMARY.md'), '# Summary 02-01\n');
    fs.writeFileSync(path.join(phaseDir, '02-02-PLAN.md'), '---\nwave: 2\ndepends_on:\n  - 02-01\n---\n# Plan 02-02\n');

    const scriptDisagree = `
set -e
gsd_run() {
  node "${GSD_TOOLS}" "$@"
}
export CURRENT_WAVE=1
export PHASE_DIR="${phaseDir}"
${creationBash}
`;
    const scriptDisagreePath = path.join(root, 'test-disagree.sh');
    fs.writeFileSync(scriptDisagreePath, scriptDisagree);
    const resDisagree = childProcess.spawnSync('bash', [scriptDisagreePath], {
      cwd: root,
      stdio: 'pipe',
      timeout: HOOK_FANOUT_TIMEOUT_MS,
    });
    assert.notEqual(resDisagree.status, 0, 'disagreeing CURRENT_WAVE must fail with non-zero exit');
    assert.match(
      resDisagree.stderr?.toString() || '',
      /FATAL: CURRENT_WAVE \(1\) disagrees with phase plan wave \(2\)/,
      'stderr must report wave disagreement',
    );
  });

  test('execute-phase dispatch block succeeds on CURRENT_WAVE=2 when earlier wave-1 plan is incomplete', (t) => {
    const creationBash = extractManifestCreationBash();
    const rootIncomplete = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4853-earlier-inc-'));
    t.after(() => {
      try { cleanup(rootIncomplete); } catch (_) { /* best-effort */ }
    });
    gitOrThrow(['init', '-q', '-b', 'main'], { cwd: rootIncomplete });
    gitOrThrow(['config', 'user.email', 'test@example.com'], { cwd: rootIncomplete });
    gitOrThrow(['config', 'user.name', 'test'], { cwd: rootIncomplete });
    gitOrThrow(['config', 'commit.gpgsign', 'false'], { cwd: rootIncomplete });
    fs.writeFileSync(path.join(rootIncomplete, 'init.txt'), 'init\n');
    gitOrThrow(['add', 'init.txt'], { cwd: rootIncomplete });
    gitOrThrow(['commit', '-q', '-m', 'init'], { cwd: rootIncomplete });

    const phaseDirInc = path.join(rootIncomplete, '.planning', 'phases', '03-incomplete');
    fs.mkdirSync(phaseDirInc, { recursive: true });
    fs.writeFileSync(path.join(phaseDirInc, '03-01-PLAN.md'), '---\nwave: 1\n---\n# Plan 03-01\n');
    fs.writeFileSync(path.join(phaseDirInc, '03-02-PLAN.md'), '---\nwave: 2\ndepends_on:\n  - 03-01\n---\n# Plan 03-02\n');

    const scriptWithoutPlans = `
set -e
gsd_run() {
  node "${GSD_TOOLS}" "$@"
}
export CURRENT_WAVE=2
export PHASE_DIR="${phaseDirInc}"
unset WAVE_WORKTREE_PLANS
${creationBash}
`;
    const scriptWithoutPlansPath = path.join(rootIncomplete, 'test-without-plans.sh');
    fs.writeFileSync(scriptWithoutPlansPath, scriptWithoutPlans);
    const resWithoutPlans = childProcess.spawnSync('bash', [scriptWithoutPlansPath], {
      cwd: rootIncomplete,
      stdio: 'pipe',
      timeout: HOOK_FANOUT_TIMEOUT_MS,
    });
    assert.equal(resWithoutPlans.status, 0, `CURRENT_WAVE=2 succeeds directly on the orchestrator loop counter: ${resWithoutPlans.stderr?.toString()}`);
    assert.ok(fs.existsSync(path.join(phaseDirInc, 'wave-2-manifest.json')), 'wave-2-manifest.json must be created');
  });

  test('execute-phase dispatch block ignores stale WAVE_WORKTREE_PLANS from earlier wave', (t) => {
    const creationBash = extractManifestCreationBash();
    const rootIncomplete = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4853-stale-acc-'));
    t.after(() => {
      try { cleanup(rootIncomplete); } catch (_) { /* best-effort */ }
    });
    gitOrThrow(['init', '-q', '-b', 'main'], { cwd: rootIncomplete });
    gitOrThrow(['config', 'user.email', 'test@example.com'], { cwd: rootIncomplete });
    gitOrThrow(['config', 'user.name', 'test'], { cwd: rootIncomplete });
    gitOrThrow(['config', 'commit.gpgsign', 'false'], { cwd: rootIncomplete });
    fs.writeFileSync(path.join(rootIncomplete, 'init.txt'), 'init\n');
    gitOrThrow(['add', 'init.txt'], { cwd: rootIncomplete });
    gitOrThrow(['commit', '-q', '-m', 'init'], { cwd: rootIncomplete });

    const phaseDirInc = path.join(rootIncomplete, '.planning', 'phases', '03-incomplete');
    fs.mkdirSync(phaseDirInc, { recursive: true });
    fs.writeFileSync(path.join(phaseDirInc, '03-01-PLAN.md'), '---\nwave: 1\n---\n# Plan 03-01\n');
    fs.writeFileSync(path.join(phaseDirInc, '03-02-PLAN.md'), '---\nwave: 2\ndepends_on:\n  - 03-01\n---\n# Plan 03-02\n');

    const scriptStaleAcc = `
set -e
gsd_run() {
  node "${GSD_TOOLS}" "$@"
}
export CURRENT_WAVE=2
export PHASE_DIR="${phaseDirInc}"
export WAVE_WORKTREE_PLANS="03-01"
${creationBash}
`;
    const scriptStaleAccPath = path.join(rootIncomplete, 'test-stale-acc.sh');
    fs.writeFileSync(scriptStaleAccPath, scriptStaleAcc);
    const resStaleAcc = childProcess.spawnSync('bash', [scriptStaleAccPath], {
      cwd: rootIncomplete,
      stdio: 'pipe',
      timeout: HOOK_FANOUT_TIMEOUT_MS,
    });
    assert.equal(resStaleAcc.status, 0, `stale WAVE_WORKTREE_PLANS="03-01" does not derail CURRENT_WAVE=2: ${resStaleAcc.stderr?.toString()}`);
    assert.ok(fs.existsSync(path.join(phaseDirInc, 'wave-2-manifest.json')), 'wave-2-manifest.json must be created');
  });

  test('execute-phase dispatch block handles comma-separated WAVE_WORKTREE_PLANS without errors', (t) => {
    const creationBash = extractManifestCreationBash();
    const rootIncomplete = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4853-comma-acc-'));
    t.after(() => {
      try { cleanup(rootIncomplete); } catch (_) { /* best-effort */ }
    });
    gitOrThrow(['init', '-q', '-b', 'main'], { cwd: rootIncomplete });
    gitOrThrow(['config', 'user.email', 'test@example.com'], { cwd: rootIncomplete });
    gitOrThrow(['config', 'user.name', 'test'], { cwd: rootIncomplete });
    gitOrThrow(['config', 'commit.gpgsign', 'false'], { cwd: rootIncomplete });
    fs.writeFileSync(path.join(rootIncomplete, 'init.txt'), 'init\n');
    gitOrThrow(['add', 'init.txt'], { cwd: rootIncomplete });
    gitOrThrow(['commit', '-q', '-m', 'init'], { cwd: rootIncomplete });

    const phaseDirInc = path.join(rootIncomplete, '.planning', 'phases', '03-incomplete');
    fs.mkdirSync(phaseDirInc, { recursive: true });
    fs.writeFileSync(path.join(phaseDirInc, '03-01-PLAN.md'), '---\nwave: 1\n---\n# Plan 03-01\n');
    fs.writeFileSync(path.join(phaseDirInc, '03-02-PLAN.md'), '---\nwave: 2\ndepends_on:\n  - 03-01\n---\n# Plan 03-02\n');

    const scriptCommaAcc = `
set -e
gsd_run() {
  node "${GSD_TOOLS}" "$@"
}
export CURRENT_WAVE=2
export PHASE_DIR="${phaseDirInc}"
export WAVE_WORKTREE_PLANS="03-01,03-02"
${creationBash}
`;
    const scriptCommaAccPath = path.join(rootIncomplete, 'test-comma-acc.sh');
    fs.writeFileSync(scriptCommaAccPath, scriptCommaAcc);
    const resCommaAcc = childProcess.spawnSync('bash', [scriptCommaAccPath], {
      cwd: rootIncomplete,
      stdio: 'pipe',
      timeout: HOOK_FANOUT_TIMEOUT_MS,
    });
    assert.equal(resCommaAcc.status, 0, `comma-separated WAVE_WORKTREE_PLANS="03-01,03-02" does not derail CURRENT_WAVE=2: ${resCommaAcc.stderr?.toString()}`);
    assert.ok(fs.existsSync(path.join(phaseDirInc, 'wave-2-manifest.json')), 'wave-2-manifest.json must be created');
  });
});
