#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// SessionStart hook: put the installed gsd-core `bin/` directory (which holds `gsd_run`) on the
// PATH of every later Bash tool call in this Claude Code session (#5465).
//
// Why a hook: the resolver snippet (gsd-core/workflows/_runtime-launcher.snippet.sh) persists its
// PATH export through $CLAUDE_ENV_FILE, but Claude Code provides that variable only to SessionStart,
// Setup, CwdChanged and FileChanged hooks, never to a workflow Bash block. So the write never fired
// and a later block that called `gsd_run` without re-including the resolver got "command not found"
// (hidden by `2>/dev/null || echo <fallback>`). This hook writes the same line from the one place
// the variable exists. The snippet's in-block write stays for users who export the variable
// themselves.
//
// Fail-open and side-effect-minimal by design: it only ever appends one line to the file Claude Code
// hands to SessionStart hooks, only for a directory that contains an installed `gsd_run`, and any
// problem (no variable, no gsd_run, unwritable file) exits 0 without output.

'use strict';

const fs = require('fs');
const path = require('path');
const { allow } = require('./lib/hook-exit.js');

/**
 * The `bin/` directory next to this hook's install root: hooks live in `<root>/hooks/` and the
 * runtime in `<root>/gsd-core/` for global, project-local and plugin layouts alike. Returns the
 * real path, or null when `gsd_run` is not there.
 */
function resolveBinDir(hookDir) {
  try {
    const bin = fs.realpathSync(path.join(hookDir, '..', 'gsd-core', 'bin'));
    return fs.statSync(path.join(bin, 'gsd_run')).isFile() ? bin : null;
  } catch {
    return null;
  }
}

/**
 * The directory as the bash that sources $CLAUDE_ENV_FILE spells it. On Windows the env file is
 * sourced by Git Bash, where `:` separates PATH entries and a drive letter is `/c/...`, which is
 * also what the resolver snippet writes (it derives the directory from bash's `$GSD_TOOLS`). A
 * native `C:\Users\x\...` would split at the colon and never resolve.
 */
function shellPath(dir, platform = process.platform) {
  if (platform !== 'win32') return dir;
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(dir);
  const rest = (m ? m[2] : dir.replace(/^[\\/]+/, '')).replace(/\\/g, '/');
  return m ? `/${m[1].toLowerCase()}/${rest}` : dir.replace(/\\/g, '/');
}

/** The exact line the resolver snippet writes: `export PATH='<dir>':"$PATH"` with `'` escaped. */
function exportLine(binDir, platform = process.platform) {
  return `export PATH='${shellPath(binDir, platform).replace(/'/g, "'\\''")}':"$PATH"`;
}

/**
 * Append the export to `envFile` unless it is already there. Returns true when it wrote.
 * Never throws.
 */
function persistPath(envFile, binDir) {
  try {
    const line = exportLine(binDir);
    let existing = '';
    try {
      existing = fs.readFileSync(envFile, 'utf8');
    } catch (e) {
      if (e && e.code !== 'ENOENT') return false;
    }
    if (existing.split(/\r?\n/).includes(line)) return false;
    const prefix = existing === '' || existing.endsWith('\n') ? '' : '\n';
    fs.appendFileSync(envFile, `${prefix}${line}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function main() {
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (typeof envFile !== 'string' || envFile.trim() === '') return;
  const binDir = resolveBinDir(__dirname);
  if (binDir === null) return;
  persistPath(envFile, binDir);
}

if (require.main === module) {
  try {
    main();
  } catch {
    // A PATH convenience must never fail session start.
  }
  allow();
}

module.exports = { resolveBinDir, shellPath, exportLine, persistPath };
