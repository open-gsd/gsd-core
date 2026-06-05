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

const SPAWNOPT = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000, windowsHide: true };

function git(args, cwd) {
  return spawnSync('git', args, { ...SPAWNOPT, cwd });
}

// Walk up from `start` to find the nearest existing directory.
// Returns null if we reach the filesystem root without finding one.
function nearestExistingDir(start) {
  let dir = start;
  let prev;
  do {
    prev = dir;
    try { fs.accessSync(dir, fs.constants.F_OK); return dir; } catch { /* keep walking */ }
    dir = path.dirname(dir);
  } while (dir !== prev);
  return null;
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
    // returns a path containing .git/worktrees/ as a component.
    // In the main repo or a submodule it returns .git (or a path without /worktrees/).
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

    // Get the raw --show-toplevel output for the worktree (cwd).
    // We keep it raw (not path.resolve'd) to compare directly with the
    // file's toplevel — same git binary, same format, no normalization needed.
    const wtTopResult = git(['rev-parse', '--show-toplevel'], cwd);
    if (wtTopResult.status !== 0 || !wtTopResult.stdout) {
      process.exit(0); // can't determine root — fail open
    }
    const wtTopRaw = wtTopResult.stdout.trim();

    const rawFilePath = data.tool_input?.file_path || '';
    if (!rawFilePath) {
      process.exit(0);
    }

    // Relative paths are always safe — they resolve relative to CWD inside the worktree
    if (!path.isAbsolute(rawFilePath)) {
      process.exit(0);
    }

    // Normalise .. traversal so /worktree/src/../../../main/file
    // resolves to its true location before we check containment.
    const filePath = path.resolve(rawFilePath);

    // Find the nearest existing ancestor of filePath so we can ask git
    // for its toplevel. The file itself may not exist yet (Write creates
    // new files), but at least one ancestor directory must exist.
    // We check the file itself first in case it already exists.
    const checkDir = nearestExistingDir(
      (() => {
        try {
          return fs.statSync(filePath).isDirectory() ? filePath : path.dirname(filePath);
        } catch {
          return path.dirname(filePath);
        }
      })()
    );

    if (!checkDir) {
      // Walked to root without finding any directory — path is synthetic.
      // Block conservatively.
      const output = {
        decision: 'block',
        reason:
          `Worktree path guard: '${filePath}' has no existing ancestor directory — ` +
          `cannot verify it is inside the worktree '${wtTopRaw}'. Use a relative path instead.`,
      };
      process.stdout.write(JSON.stringify(output));
      process.exit(2);
    }

    // Ask git for the toplevel of the file's location.
    // Comparing two raw git --show-toplevel outputs avoids every
    // platform-specific path normalisation pitfall (Windows 8.3 short names,
    // case differences between realpathSync and path.resolve, forward- vs
    // back-slash inconsistencies) — both values come from the same git binary
    // in the same format by definition.
    const fileTopResult = git(['rev-parse', '--show-toplevel'], checkDir);

    if (fileTopResult.status !== 0 || !fileTopResult.stdout) {
      // checkDir is not inside any git repo → cannot be inside the worktree.
      const output = {
        decision: 'block',
        reason:
          `Worktree path guard: '${filePath}' is not inside any git repository — ` +
          `it cannot be inside the worktree at '${wtTopRaw}'. Use a relative path instead.`,
      };
      process.stdout.write(JSON.stringify(output));
      process.exit(2);
    }

    const fileTopRaw = fileTopResult.stdout.trim();

    // Same git toplevel → file is inside the worktree → allow
    if (fileTopRaw === wtTopRaw) {
      process.exit(0);
    }

    // BLOCK: file resolves to a different git root than the active worktree
    const output = {
      decision: 'block',
      reason:
        `Worktree path guard: '${filePath}' resolves to git root '${fileTopRaw}' which ` +
        `differs from the active worktree root '${wtTopRaw}'. This likely means an ` +
        `absolute path was derived from the orchestrator's main repository instead of ` +
        `the active worktree. To fix: use a relative path, or re-derive the base ` +
        `directory with \`git rev-parse --show-toplevel\` from within the worktree ` +
        `(hook cwd: '${cwd}').`,
    };

    process.stdout.write(JSON.stringify(output));
    process.exit(2);
  } catch {
    // Silent fail — never block valid tool calls due to hook errors
    process.exit(0);
  }
});
