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

// #2304: Kimi's native hook bus delivers Kimi's tool vocabulary in the payload
// (Write → WriteFile, Edit/MultiEdit → StrReplaceFile) while the [[hooks]]
// matcher is registered pre-translated (runtime-hooks-surface.cts
// buildKimiHooksTomlBlock) — so without normalizing the payload too, the
// matcher fires but the tool_name check below exits 0 and the guard is dormant
// on Kimi. The tool_input field names differ as well (kimi-cli
// src/kimi_cli/tools/file/{write,replace}.py): WriteFile takes `path`/`content`,
// StrReplaceFile takes `path` + `edit: Edit | list[Edit]` with `old`/`new` —
// kimi-cli's hooks/events.py forwards tool_input verbatim, so both layers need
// mapping. Accepts bare and module-qualified ('kimi_cli.tools.file:WriteFile')
// names; unknown names fall through untouched. Inlined per guard (not
// hooks/lib/): hook scripts are staged as standalone files, and a sibling
// require is a staging dependency that can fail silently.
// A Map, not an object literal: bare bracket lookup resolves prototype keys
// ('constructor', '__proto__', 'toString') to truthy functions/objects, so the
// !mapped fall-through never fires for them; Map.get returns undefined (same
// shape as canonicalizeRuntimeName in src/runtime-name-policy.cts).
const KIMI_TOOL_NAMES = new Map([['WriteFile', 'Write'], ['StrReplaceFile', 'Edit'], ['ReadFile', 'Read'], ['Shell', 'Bash']]);
function normalizeKimiPayload(data) {
  const raw = data.tool_name;
  if (typeof raw !== 'string') return data;
  const mapped = KIMI_TOOL_NAMES.get(raw.slice(raw.lastIndexOf(':') + 1));
  if (!mapped) return data;
  data.tool_name = mapped;
  if (data.tool_response === undefined && data.tool_output !== undefined) {
    data.tool_response = data.tool_output;
  }
  const input = data.tool_input;
  if (input && typeof input === 'object') {
    if (input.file_path === undefined && typeof input.path === 'string') {
      input.file_path = input.path;
    }
    const edits = Array.isArray(input.edit) ? input.edit
      : (input.edit && typeof input.edit === 'object') ? [input.edit] : [];
    if (edits.length) {
      if (input.old_string === undefined) {
        input.old_string = edits.map((e) => String(e.old ?? '')).join('\n');
      }
      if (input.new_string === undefined) {
        input.new_string = edits.map((e) => String(e.new ?? '')).join('\n');
      }
    }
  }
  return data;
}

let input = '';
const stdinTimeout = setTimeout(() => process.exit(0), 3000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = normalizeKimiPayload(JSON.parse(input));
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

    // #1342: Only enforce inside a GSD-managed isolated executor worktree. Those
    // are always on an `agent-*` or legacy `worktree-agent-*` branch (the positive
    // allow-list enforced by worktree-branch-check.md, #2924, #1995). A manually-
    // created linked worktree (plain non-GSD work, e.g. Claude Code plan-mode) is
    // on the user's own branch, so the guard must be a no-op there. Detached HEAD
    // / error → not GSD-managed → no-op.
    const branchResult = git(['symbolic-ref', '--short', 'HEAD'], cwd);
    const branch = branchResult.status === 0 && branchResult.stdout ? branchResult.stdout.trim() : '';
    if (!/^(worktree-)?agent-[A-Za-z0-9._/-]+$/.test(branch)) {
      process.exit(0); // not a GSD-managed executor worktree — no-op
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
      // A path with no existing ancestor is not the #260 main-repo vector;
      // #260 is caught by the different-git-root branch below. Fail open. (#1342)
      process.exit(0);
    }

    // Ask git for the toplevel of the file's location.
    // Comparing two raw git --show-toplevel outputs avoids every
    // platform-specific path normalisation pitfall (Windows 8.3 short names,
    // case differences between realpathSync and path.resolve, forward- vs
    // back-slash inconsistencies) — both values come from the same git binary
    // in the same format by definition.
    const fileTopResult = git(['rev-parse', '--show-toplevel'], checkDir);

    if (fileTopResult.status !== 0 || !fileTopResult.stdout) {
      // The target's location is not a git work tree. Two sub-cases:
      //  - Inside a .git directory (e.g. /main-repo/.git/config or .git/hooks/*)
      //    → an absolute write into a repository's internals; still a #260-class
      //    escape (and dangerous) → BLOCK.
      //  - Truly outside all git repositories (e.g. ~/.claude/plans/) → not the
      //    main-repo vector → fail open. (#1342)
      const insideGitDir = git(['rev-parse', '--is-inside-git-dir'], checkDir);
      if (insideGitDir.status === 0 && insideGitDir.stdout && insideGitDir.stdout.trim() === 'true') {
        const output = {
          decision: 'block',
          reason:
            `Worktree path guard: '${filePath}' is inside a git internal (.git) directory, ` +
            `not the active worktree at '${wtTopRaw}'. Writing to repository internals via an ` +
            `absolute path is not permitted from an isolated executor worktree. Use a relative path.`,
        };
        process.stdout.write(JSON.stringify(output));
        // Kimi feeds stderr (not stdout) back to the model on exit 2.
        process.stderr.write(output.reason);
        process.exit(2);
      }
      // Outside all git repositories — fail open (#1342).
      process.exit(0);
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
    // Kimi feeds stderr (not stdout) back to the model on exit 2.
    process.stderr.write(output.reason);
    process.exit(2);
  } catch {
    // Silent fail — never block valid tool calls due to hook errors
    process.exit(0);
  }
});
