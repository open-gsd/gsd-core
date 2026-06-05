#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// GSD Workflow Guard — PreToolUse hook
// Detects when Claude attempts file edits outside a GSD workflow context
// (no active /gsd- skill or Task subagent) and injects an advisory warning.
//
// This is a SOFT guard — it advises, not blocks. The edit still proceeds.
// The warning nudges Claude to use /gsd:quick or /gsd:fast instead of
// making direct edits that bypass state tracking.
//
// Enable via config: hooks.workflow_guard: true (default: false)
// Only triggers on Write/Edit tool calls to non-.planning/ files.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tokenize } = require('./lib/git-cmd.js');

function forceGitAddCwds(command, defaultCwd) {
  const tokens = tokenize(command || '');
  const separators = new Set(['&&', '||', ';', '|']);
  const cwdList = [];
  for (let i = 0; i < tokens.length; i++) {
    if (path.basename(tokens[i]) !== 'git') continue;

    let j = i + 1;
    let gitCwd = defaultCwd;
    while (j < tokens.length) {
      const token = tokens[j];
      const flagName = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
      if (token === '-C' && tokens[j + 1]) {
        gitCwd = path.resolve(gitCwd, tokens[j + 1]);
        j += 2;
        continue;
      }
      if (['-C', '--git-dir', '--work-tree'].includes(flagName) && !token.includes('=')) {
        j += 2;
        continue;
      }
      if (['--git-dir', '--work-tree', '--no-pager', '-p', '-P'].includes(flagName)) {
        j++;
        continue;
      }
      break;
    }

    if (tokens[j] !== 'add') continue;
    for (let k = j + 1; k < tokens.length && !separators.has(tokens[k]); k++) {
      if (tokens[k] === '--') break;
      if (tokens[k] === '--force' || tokens[k] === '-f' || /^-[A-Za-z]*f[A-Za-z]*$/.test(tokens[k])) {
        cwdList.push(gitCwd);
        break;
      }
    }
  }
  return cwdList;
}

function currentBranch(cwd) {
  const result = spawnSync('git', ['branch', '--show-current'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  if (result.status !== 0) return '';
  return result.stdout.trim();
}

function workflowGuardEnabled(cwd) {
  const configPath = path.join(cwd, '.planning', 'config.json');
  if (!fs.existsSync(configPath)) return false;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return Boolean(config.hooks?.workflow_guard);
  } catch (e) {
    return false;
  }
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
    const cwd = data.cwd || process.cwd();
    const isWorkflowGuardEnabled = workflowGuardEnabled(cwd);

    if (toolName === 'Bash') {
      if (!isWorkflowGuardEnabled) {
        process.exit(0);
      }
      const command = data.tool_input?.command || '';
      for (const gitCwd of forceGitAddCwds(command, cwd)) {
        const branch = currentBranch(gitCwd);
        if (branch.startsWith('worktree-agent-')) {
          process.stdout.write(JSON.stringify({
            decision: 'block',
            code: 'WORKTREE_AGENT_FORCE_ADD_FORBIDDEN',
            reason: 'worktree-agent branches must not run git add -f or git add --force. Respect the SDK skipped_gitignored/skipped_commit_docs_false contract and leave gitignored files untracked.',
          }));
          process.exit(2);
        }
      }
      process.exit(0);
    }

    // Only guard Write, Edit, and MultiEdit tool calls
    if (!['Write', 'Edit', 'MultiEdit'].includes(toolName)) {
      process.exit(0);
    }

    // Check if we're inside a GSD workflow (Task subagent or /gsd- skill)
    // Subagents have a session_id that differs from the parent
    // and typically have a description field set by the orchestrator
    if (data.tool_input?.is_subagent || data.session_type === 'task') {
      process.exit(0);
    }

    // Check the file being edited
    const filePath = data.tool_input?.file_path || data.tool_input?.path || '';

    // Allow edits to .planning/ files (GSD state management)
    if (filePath.includes('.planning/') || filePath.includes('.planning\\')) {
      process.exit(0);
    }

    // Allow edits to common config/docs files that don't need GSD tracking
    const allowedPatterns = [
      /\.gitignore$/,
      /\.env/,
      /CLAUDE\.md$/,
      /AGENTS\.md$/,
      /GEMINI\.md$/,
      /settings\.json$/,
    ];
    if (allowedPatterns.some(p => p.test(filePath))) {
      process.exit(0);
    }

    if (!isWorkflowGuardEnabled) {
      process.exit(0); // Guard disabled (default) or no GSD project
    }

    // If we get here: GSD project, guard enabled, file edit outside .planning/,
    // not in a subagent context. Inject advisory warning.
    const output = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: `⚠️ WORKFLOW ADVISORY: You're editing ${path.basename(filePath)} directly without a GSD command. ` +
          'This edit will not be tracked in STATE.md or produce a SUMMARY.md. ' +
          'Consider using /gsd:fast for trivial fixes or /gsd:quick for larger changes ' +
          'to maintain project state tracking. ' +
          'If this is intentional (e.g., user explicitly asked for a direct edit), proceed normally.'
      }
    };

    process.stdout.write(JSON.stringify(output));
  } catch (e) {
    // Silent fail — never block tool execution
    process.exit(0);
  }
});
