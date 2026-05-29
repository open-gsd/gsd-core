#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// Background worker spawned by gsd-check-update.js (SessionStart hook).
// Checks for GSD updates and stale hooks, writes result to cache file.
// Receives paths via environment variables set by the parent hook.
//
// Using a separate file (rather than node -e '<inline code>') avoids the
// template-literal regex-escaping problem: regex source is plain JS here.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { isSemverNewer } = require('../get-shit-done/bin/lib/semver-compare.cjs');
// Derive the published package name from package.json so this survives
// future renames and always matches the actual registry entry (#378).
const PACKAGE_NAME = require('../package.json').name;
// Authoritative list of managed hooks — shared with tests to retire source-grep
// assertions (pending-migration-to-typed-ir [#455]).
const { MANAGED_HOOKS } = require('./managed-hooks-registry.cjs');

const cacheFile = process.env.GSD_CACHE_FILE;
const projectVersionFile = process.env.GSD_PROJECT_VERSION_FILE;
const globalVersionFile = process.env.GSD_GLOBAL_VERSION_FILE;

// Check project directory first (local install), then global
let installed = '0.0.0';
let configDir = '';
try {
  if (fs.existsSync(projectVersionFile)) {
    installed = fs.readFileSync(projectVersionFile, 'utf8').trim();
    configDir = path.dirname(path.dirname(projectVersionFile));
  } else if (fs.existsSync(globalVersionFile)) {
    installed = fs.readFileSync(globalVersionFile, 'utf8').trim();
    configDir = path.dirname(path.dirname(globalVersionFile));
  }
} catch (e) {}

// Check for stale hooks — compare hook version headers against installed VERSION
// Hooks are installed at configDir/hooks/ (e.g. ~/.claude/hooks/) (#1421)
// Only check hooks that GSD currently ships — orphaned files from removed features
// (e.g., gsd-intel-*.js) must be ignored to avoid permanent stale warnings (#1750)
// MANAGED_HOOKS is imported from ./managed-hooks-registry.cjs above.

let staleHooks = [];
if (configDir) {
  const hooksDir = path.join(configDir, 'hooks');
  try {
    if (fs.existsSync(hooksDir)) {
      const hookFiles = fs.readdirSync(hooksDir).filter(f => MANAGED_HOOKS.includes(f));
      for (const hookFile of hookFiles) {
        try {
          const content = fs.readFileSync(path.join(hooksDir, hookFile), 'utf8');
          // Match both JS (//) and bash (#) comment styles
          const versionMatch = content.match(/(?:\/\/|#) gsd-hook-version:\s*(.+)/);
          if (versionMatch) {
            const hookVersion = versionMatch[1].trim();
            if (isSemverNewer(installed, hookVersion) && !hookVersion.includes('{{')) {
              staleHooks.push({ file: hookFile, hookVersion, installedVersion: installed });
            }
          } else {
            // No version header at all — definitely stale (pre-version-tracking)
            staleHooks.push({ file: hookFile, hookVersion: 'unknown', installedVersion: installed });
          }
        } catch (e) {}
      }
    }
  } catch (e) {}
}

let latest = null;
try {
  latest = execFileSync('npm', ['view', PACKAGE_NAME, 'version'], {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
    // On Windows, 'npm' is distributed as npm.cmd. Node's execFileSync does
    // not apply PATHEXT resolution and looks for a literal 'npm' binary,
    // failing with ENOENT. Setting shell:true on Windows routes through
    // cmd.exe which resolves npm.cmd via PATHEXT.
    // POSIX (Linux/macOS) is left untouched — no shell spawn, no extra
    // signal/exit-code semantics, no overhead.
    shell: process.platform === 'win32',
  }).trim();
} catch (e) {}

const result = {
  update_available: latest && isSemverNewer(latest, installed),
  installed,
  latest: latest || 'unknown',
  checked: Math.floor(Date.now() / 1000),
  stale_hooks: staleHooks.length > 0 ? staleHooks : undefined,
};

if (cacheFile) {
  try { fs.writeFileSync(cacheFile, JSON.stringify(result)); } catch (e) {}
}
