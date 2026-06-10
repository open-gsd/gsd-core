#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
/**
 * SessionStart hook: ensure the canonical ~/.claude/gsd-core path exists when
 * GSD runs as a Claude Code marketplace plugin.
 *
 * Why this is needed
 * ------------------
 * GSD's agents, commands, and prompt templates @-include the canonical path
 * `~/.claude/gsd-core/...` (workflows, references, templates, contexts, bin).
 * In a classic `bin/install.js` install that directory is populated on disk.
 * In a Claude Code *marketplace plugin* install it is never created: the
 * plugin manager only unpacks the package into the version-pinned plugin cache
 * (`~/.claude/plugins/cache/<marketplace>/gsd-core/<version>/`) and never runs
 * install.js. So every @-include resolves to nothing and gsd agents fail with:
 *
 *   "executor prompt template @-references ~/.claude/gsd-core/... paths, but
 *    this is a plugin-based install where those paths are empty."
 *
 * Claude Code @-includes expand `~` and resolve absolute paths, but do NOT
 * expand environment variables, so the bundled files cannot reference
 * `${CLAUDE_PLUGIN_ROOT}` directly (that variable is only expanded in
 * hooks.json command strings, not in markdown bodies). This hook bridges the
 * gap by making `~/.claude/gsd-core` a real directory whose immutable bundled
 * subdirectories are symlinked to this plugin's bundled `gsd-core/` tree.
 *
 * Design notes
 * ------------
 * - The canonical target is `os.homedir()/.claude/gsd-core` (literal `~`),
 *   NOT CLAUDE_CONFIG_DIR: the bundled includes hardcode `@~/.claude/...`,
 *   which Claude Code expands to the home dir regardless of CLAUDE_CONFIG_DIR.
 * - No-op when the bundled tree already IS the canonical path (a classic
 *   install): nothing is linked.
 * - Real top-level entries (a user's USER-PROFILE.md, or a classic install)
 *   are NEVER clobbered: only symlinks are managed.
 * - Stale/dangling symlinks (entries renamed or dropped in a newer bundle, or
 *   links into a removed older version dir) are pruned, so the shim self-heals
 *   after `claude plugin update`.
 * - Plugin root is derived from __dirname (this file lives at
 *   <pluginRoot>/hooks/), so it does not depend on CLAUDE_PLUGIN_ROOT being
 *   propagated into the hook process environment.
 * - Best-effort and non-blocking: any failure is swallowed and the hook always
 *   exits 0, so a filesystem hiccup can never break SessionStart.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}
function isSymlink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch (_) { return false; }
}
function safeReaddir(p) {
  try { return fs.readdirSync(p); } catch (_) { return []; }
}

function main() {
  const pluginRoot = path.resolve(__dirname, '..');
  const bundled = path.join(pluginRoot, 'gsd-core');
  if (!isDir(bundled)) return; // nothing to link

  const canonical = path.join(os.homedir(), '.claude', 'gsd-core');

  // Classic install: the bundled tree already lives at the canonical path.
  if (path.resolve(bundled) === path.resolve(canonical)) return;

  // A previous shim may have left a whole-dir symlink; we manage per-entry.
  if (isSymlink(canonical)) {
    try { fs.unlinkSync(canonical); } catch (_) { /* ignore */ }
  }
  fs.mkdirSync(canonical, { recursive: true });

  // Prune our own dangling symlinks (only symlinks are touched; real entries,
  // i.e. user content or a classic install, are preserved).
  for (const name of safeReaddir(canonical)) {
    const p = path.join(canonical, name);
    if (isSymlink(p) && !fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch (_) { /* ignore */ }
    }
  }

  // Symlink each bundled entry into the canonical dir. Skip any entry already
  // present as a REAL (non-symlink) file/dir.
  const dirLinkType = process.platform === 'win32' ? 'junction' : 'dir';
  for (const name of safeReaddir(bundled)) {
    const src = path.join(bundled, name);
    const dest = path.join(canonical, name);
    if (fs.existsSync(dest) && !isSymlink(dest)) continue; // preserve real entry
    try {
      if (isSymlink(dest)) fs.unlinkSync(dest);
      fs.symlinkSync(src, dest, isDir(src) ? dirLinkType : 'file');
    } catch (_) { /* best-effort; never block the session */ }
  }
}

try { main(); } catch (_) { /* never block SessionStart */ }
process.exit(0);
