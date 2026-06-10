#!/usr/bin/env node
'use strict';

/**
 * sync-manifest-versions.cjs
 *
 * Stamps the package.json version into every runtime-integration manifest whose
 * top-level `version` field MUST track the package version.  Called automatically
 * by the `version` npm lifecycle script so that `npm version X.Y.Z` keeps all
 * registered manifests in sync.
 *
 * Usage:
 *   node scripts/sync-manifest-versions.cjs           # stamp + report
 *   node scripts/sync-manifest-versions.cjs --stage   # stamp + git-stage manifests
 *   node scripts/sync-manifest-versions.cjs --check   # report drift, exit 1 if any
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// Single source of truth: runtime-integration manifests whose top-level `version`
// MUST track package.json. Add a new manifest here so `npm version` keeps it in
// sync — the regression guard test (issue 844) fails if you forget.
const VERSIONED_MANIFESTS = [
  '.claude-plugin/plugin.json',
  'gemini-extension.json',
];

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function getPackageVersion(root) {
  const r = root || ROOT;
  return readJson(path.join(r, 'package.json')).version;
}

// Stamp `version` into each registered manifest, preserving field order and
// 2-space + trailing-newline formatting. Returns the list of changed rel paths.
function syncManifestVersions(opts) {
  const root = (opts && opts.root) || ROOT;
  const v = (opts && opts.version) != null ? opts.version : getPackageVersion(root);
  const changed = [];
  for (const rel of VERSIONED_MANIFESTS) {
    const abs = path.join(root, rel);
    const manifest = readJson(abs);
    if (manifest.version !== v) {
      manifest.version = v;
      fs.writeFileSync(abs, JSON.stringify(manifest, null, 2) + '\n');
      changed.push(rel);
    }
  }
  return changed;
}

// Registered manifests whose version != package version.
function findDrift(opts) {
  const root = (opts && opts.root) || ROOT;
  const v = (opts && opts.version) != null ? opts.version : getPackageVersion(root);
  const drift = [];
  for (const rel of VERSIONED_MANIFESTS) {
    const found = readJson(path.join(root, rel)).version;
    if (found !== v) drift.push({ manifest: rel, found, expected: v });
  }
  return drift;
}

// Best-effort outside git; fail-closed inside a work tree so a release never
// ships a stale manifest that the working-tree test already accepted.
function stageManifests(opts) {
  const root = (opts && opts.root) || ROOT;
  let insideWorkTree = false;
  try {
    insideWorkTree = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim() === 'true';
  } catch {}
  if (!insideWorkTree) {
    console.warn('sync-manifest-versions: not a git work tree; skipping staging.');
    return;
  }
  try {
    execFileSync('git', ['add', '--', ...VERSIONED_MANIFESTS], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    const detail = err && err.stderr ? err.stderr.toString().trim() : (err && err.message) || 'unknown error';
    throw new Error(`sync-manifest-versions: failed to git-add manifests inside a work tree: ${detail}`);
  }
}

module.exports = { VERSIONED_MANIFESTS, syncManifestVersions, findDrift, getPackageVersion, stageManifests };

if (require.main === module) {
  const args = process.argv.slice(2);
  const version = getPackageVersion();
  if (args.includes('--check')) {
    const drift = findDrift({ version });
    if (drift.length) {
      for (const d of drift) {
        console.error('Manifest ' + d.manifest + ' version ' + d.found + ' != package.json ' + d.expected);
      }
      console.error('Run `node scripts/sync-manifest-versions.cjs` to fix.');
      process.exitCode = 1;
    } else {
      console.log('All ' + VERSIONED_MANIFESTS.length + ' versioned manifests in sync at ' + version + '.');
    }
  } else {
    const changed = syncManifestVersions({ version });
    if (changed.length) {
      console.log('Stamped ' + version + ' into: ' + changed.join(', '));
    } else {
      console.log('Versioned manifests already at ' + version + '.');
    }
    if (args.includes('--stage')) stageManifests();
  }
}
