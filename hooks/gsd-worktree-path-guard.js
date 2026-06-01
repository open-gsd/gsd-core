#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// GSD Worktree Path Guard — PreToolUse hook
// Blocks Edit/Write/MultiEdit tool calls that target absolute paths outside the worktree root.
//
// Problem: gsd-executor agents spawned with isolation="worktree" sometimes issue
// Edit/Write calls with absolute paths rooted at the MAIN repository instead of
// the worktree (issue #260). The prose guard in agents/gsd-executor.md step 0b
// is never enforced because the model under load skips it.
//
// This hook enforces the constraint at the tooling layer, making it HARD-BLOCKING.
//
// Triggers on: Edit, Write, and MultiEdit tool calls
// Action: BLOCK (exit 2) if file_path is absolute and outside the worktree root
// No-op: relative paths, non-worktree CWDs, hook errors (silent fail)

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SPAWNOPT = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 };

function git(args, cwd) {
  return spawnSync('git', args, { ...SPAWNOPT, cwd });
}

let input = '';
const stdinTimeout = setTimeout(() => process.exit(0), 3000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = JSON.parse(input);
    const toolName = data.tool_name;

    // Only guard Edit, Write, and MultiEdit tool calls
    if (toolName !== 'Edit' && toolName !== 'Write' && toolName !== 'MultiEdit') {
      process.exit(0);
    }

    const cwd = data.cwd || process.cwd();

    // Detect whether CWD is inside a linked git worktree by inspecting
    // the git-dir path. In a linked worktree, git rev-parse --git-dir
    // returns a path ending with .git/worktrees/<id>. In the main repo
    // or a submodule it returns .git (or a path without /worktrees/).
    // This approach works even when cwd is a subdirectory of the worktree.
    const gitDirResult = git(['rev-parse', '--git-dir'], cwd);
    if (gitDirResult.status !== 0 || !gitDirResult.stdout) {
      process.exit(0); // not a git repo — pass through
    }

    const gitDir = gitDirResult.stdout.trim();
    // A linked worktree's --git-dir contains .git/worktrees/ as a path component
    const isLinkedWorktree = /[/\\]\.git[/\\]worktrees[/\\]/.test(gitDir);
    if (!isLinkedWorktree) {
      process.exit(0); // main repo, submodule, or separate-git-dir — no-op
    }

    // Get the worktree root (canonical, resolves symlinks on the worktree side)
    const toplevelResult = git(['rev-parse', '--show-toplevel'], cwd);
    if (toplevelResult.status !== 0 || !toplevelResult.stdout) {
      process.exit(0); // can't determine root — fail open
    }

    // path.resolve() normalises git's forward-slash output (C:/repo) to the
    // platform separator (C:\repo on Windows) and collapses any .. segments.
    // We intentionally do NOT call realpathSync here: on Windows, realpathSync
    // returns the filesystem's canonical case (e.g. C:\Users\Runner) which may
    // differ from the case used in the file_path argument, causing false blocks.
    const wtRoot = path.resolve(toplevelResult.stdout.trim());

    const rawFilePath = data.tool_input?.file_path || '';
    if (!rawFilePath) {
      process.exit(0);
    }

    // Relative paths are always safe — they resolve relative to CWD which is inside the worktree
    if (!path.isAbsolute(rawFilePath)) {
      process.exit(0);
    }

    // Normalise the target path to collapse any `..` traversal sequences.
    // We do NOT call realpathSync here because the file may not exist yet
    // (Write creates new files). path.resolve with the raw value is sufficient
    // to eliminate traversal while leaving non-existent paths representable.
    const filePath = path.resolve(rawFilePath);

    // Containment check: filePath must equal wtRoot or be a strict descendant.
    // Using path.sep instead of '/' ensures correctness on Windows.
    if (filePath === wtRoot || filePath.startsWith(wtRoot + path.sep)) {
      process.exit(0);
    }

    // BLOCK: absolute path is outside the worktree root
    const output = {
      decision: 'block',
      reason:
        `Worktree path guard: attempted to write to '${filePath}' which is outside the ` +
        `worktree root '${wtRoot}'. This likely means an absolute path was derived from the ` +
        `orchestrator's main repository instead of the active worktree. ` +
        `To fix: use a relative path, or re-derive the base directory with ` +
        '`git rev-parse --show-toplevel` from within the worktree ' +
        `(hook cwd: '${cwd}').`,
    };

    process.stdout.write(JSON.stringify(output));
    process.exit(2);
  } catch {
    // Silent fail — never block valid tool calls due to hook errors
    process.exit(0);
  }
});
