#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// GSD Worktree Path Guard — PreToolUse hook
// Blocks Edit/Write tool calls that target absolute paths outside the worktree root.
//
// Problem: gsd-executor agents spawned with isolation="worktree" sometimes issue
// Edit/Write calls with absolute paths rooted at the MAIN repository instead of
// the worktree (issue #260). The prose guard in agents/gsd-executor.md step 0b
// is never enforced because the model under load skips it.
//
// This hook enforces the constraint at the tooling layer, making it HARD-BLOCKING.
//
// Triggers on: Edit and Write tool calls
// Action: BLOCK (exit 2) if file_path is absolute and outside the worktree root
// No-op: relative paths, non-worktree CWDs, hook errors (silent fail)

const fs = require('fs');
const { spawnSync } = require('child_process');

let input = '';
const stdinTimeout = setTimeout(() => process.exit(0), 3000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = JSON.parse(input);
    const toolName = data.tool_name;

    // Only guard Edit and Write tool calls
    if (toolName !== 'Edit' && toolName !== 'Write') {
      process.exit(0);
    }

    const cwd = data.cwd || process.cwd();

    // Detect if CWD is inside a git worktree by checking if .git is a FILE (not a directory).
    // In the main repo, .git is a directory. In a worktree, .git is a file containing a gitdir pointer.
    const gitPath = require('path').join(cwd, '.git');
    let gitStat;
    try {
      gitStat = fs.statSync(gitPath);
    } catch {
      // No .git at all — not a git repo or .git is elsewhere; exit silently
      process.exit(0);
    }

    if (!gitStat.isFile()) {
      // .git is a directory → this is the main repo, not a worktree. No-op.
      process.exit(0);
    }

    // Get the worktree root via git
    const gitResult = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    if (gitResult.status !== 0 || !gitResult.stdout) {
      // Can't determine worktree root — fail open
      process.exit(0);
    }

    const wtRoot = gitResult.stdout.trim();

    const filePath = data.tool_input?.file_path || '';

    // Relative paths are always safe — they resolve relative to CWD which is inside the worktree
    if (!filePath.startsWith('/')) {
      process.exit(0);
    }

    // Check containment: file_path must equal wtRoot or be a descendant of it
    if (filePath === wtRoot || filePath.startsWith(wtRoot + '/')) {
      process.exit(0);
    }

    // BLOCK: absolute path is outside the worktree root
    const output = {
      decision: 'block',
      reason:
        `Path guard violation: attempted to write to '${filePath}' which is outside the ` +
        `worktree root '${wtRoot}'. This likely means an absolute path was derived from the ` +
        `main repository instead of the active worktree. To fix: use a relative path, or ` +
        `re-derive the base directory with \`git rev-parse --show-toplevel\` from within the ` +
        `worktree (cwd: '${cwd}').`,
    };

    process.stdout.write(JSON.stringify(output));
    process.exit(2);
  } catch {
    // Silent fail — never block valid tool calls due to hook errors
    process.exit(0);
  }
});
