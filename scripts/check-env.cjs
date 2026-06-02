#!/usr/bin/env node
'use strict';
// scripts/check-env.cjs — Environment parity validator for contributors (issue #117).
//
// Node.js port of scripts/check-env.sh. Behaviorally identical output and
// exit codes; shell-agnostic so it runs on Windows, macOS, and Linux.
//
// Checks that the developer's environment matches project requirements before
// running tests or audits. Designed to catch mismatches early rather than
// through cryptic test failures.
//
// Exit codes:
//   0  All checks passed
//   1  One or more checks failed
//   2  Tool error (missing required tool, corrupt package.json, etc.)
//
// Usage:
//   node scripts/check-env.cjs           # Human-readable report
//   node scripts/check-env.cjs --json    # Structured JSON report
//   node scripts/check-env.cjs --help    # This message
//
// Sources:
//   npm engines:         https://docs.npmjs.com/cli/v10/configuring-npm/package-json#engines
//   Reproducible builds: https://reproducible-builds.org/docs/source-tree/
//   npm ci docs:         https://docs.npmjs.com/cli/v10/commands/npm-ci
//   gsd-test-runner:     https://github.com/open-gsd/gsd-test-runner

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

// On Windows, npm ships as npm.cmd (a batch wrapper); spawnSync without
// shell:true requires the exact filename including extension.
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
let jsonMode = false;

for (const arg of process.argv.slice(2)) {
  if (arg === '--json') {
    jsonMode = true;
  } else if (arg === '--help' || arg === '-h') {
    process.stdout.write(
      'scripts/check-env.cjs — Environment parity validator for contributors (issue #117).\n' +
      '\n' +
      'Checks that the developer\'s environment matches project requirements before\n' +
      'running tests or audits. Designed to catch mismatches early rather than\n' +
      'through cryptic test failures.\n' +
      '\n' +
      'Exit codes:\n' +
      '  0  All checks passed\n' +
      '  1  One or more checks failed\n' +
      '  2  Tool error (missing required tool, corrupt package.json, etc.)\n' +
      '\n' +
      'Usage:\n' +
      '  node scripts/check-env.cjs           # Human-readable report\n' +
      '  node scripts/check-env.cjs --json    # Structured JSON report\n' +
      '  node scripts/check-env.cjs --help    # This message\n'
    );
    process.exit(0);
  } else {
    process.stderr.write(`Unknown option: ${arg}\n`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Locate the project root (directory containing package.json)
// ---------------------------------------------------------------------------
const PROJECT_ROOT = process.cwd();
const PACKAGE_JSON = path.join(PROJECT_ROOT, 'package.json');

if (!fs.existsSync(PACKAGE_JSON)) {
  process.stderr.write(`ERROR: package.json not found in ${PROJECT_ROOT}\n`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @type {Array<{name: string, status: 'pass'|'fail'|'skip', message: string}>} */
const checks = [];

function addCheck(name, status, message) {
  checks.push({ name, status, message });
}

/**
 * Semver comparison: does `version` satisfy `constraint`?
 * Constraint forms: >=X.Y.Z, >X.Y.Z, <=X.Y.Z, <X.Y.Z, =X.Y.Z, X.Y.Z
 * Returns true if satisfied, false otherwise.
 */
function satisfiesConstraint(version, constraint) {
  // Strip leading 'v' and pre-release/build suffixes
  version = version.replace(/^v/, '').replace(/-.*$/, '').replace(/\+.*$/, '');

  let op, reqVer;
  const opMatch = constraint.match(/^(>=|>|<=|<|=)(.+)$/);
  if (opMatch) {
    op = opMatch[1];
    reqVer = opMatch[2];
  } else {
    op = '=';
    reqVer = constraint;
  }
  reqVer = reqVer.replace(/^v/, '').replace(/-.*$/, '').replace(/\+.*$/, '');

  function parseTuple(v) {
    const parts = (v + '.0.0').split('.');
    return [
      parseInt(parts[0], 10) || 0,
      parseInt(parts[1], 10) || 0,
      parseInt(parts[2], 10) || 0,
    ];
  }

  const [vMaj, vMin, vPat] = parseTuple(version);
  const [rMaj, rMin, rPat] = parseTuple(reqVer);

  const vNum = vMaj * 1_000_000 + vMin * 1_000 + vPat;
  const rNum = rMaj * 1_000_000 + rMin * 1_000 + rPat;

  switch (op) {
    case '>=': return vNum >= rNum;
    case '>':  return vNum >  rNum;
    case '<=': return vNum <= rNum;
    case '<':  return vNum <  rNum;
    case '=':  return vNum === rNum;
    default:   return false;
  }
}

/**
 * Read a field from package.json using dot-notation (e.g. 'engines.node').
 * Returns the string value or empty string if absent.
 * Uses './package.json' so Node resolves relative to CWD on all platforms.
 */
function pkgField(fieldPath) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
    let val = pkg;
    for (const key of fieldPath.split('.')) {
      if (val == null || typeof val !== 'object') return '';
      val = val[key];
    }
    return val != null ? String(val) : '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Check 1: Node version vs engines.node
// ---------------------------------------------------------------------------
const enginesNode = pkgField('engines.node');
let currentNode = '';
try {
  currentNode = process.version.replace(/^v/, '');
} catch { /* ignore */ }

if (!currentNode) {
  addCheck('node-version', 'fail', 'node binary not found on PATH');
} else if (!enginesNode) {
  addCheck('node-version', 'fail', 'engines.node missing from package.json — add it (see D2 in docs/contributing/bootstrap.md)');
} else {
  if (satisfiesConstraint(currentNode, enginesNode)) {
    addCheck('node-version', 'pass', `Node ${currentNode} satisfies ${enginesNode}`);
  } else {
    addCheck('node-version', 'fail', `Node ${currentNode} does NOT satisfy engines.node ${enginesNode}`);
  }
}

// ---------------------------------------------------------------------------
// Check 2: npm version vs engines.npm (skip if field absent)
// ---------------------------------------------------------------------------
const enginesNpm = pkgField('engines.npm');
let currentNpm = '';
try {
  const res = spawnSync(npmCmd, ['--version'], { encoding: 'utf8', timeout: 10_000, shell: process.platform === 'win32' });
  if (res.status === 0 && res.stdout) {
    currentNpm = res.stdout.trim();
  }
} catch { /* ignore */ }

if (!enginesNpm) {
  addCheck('npm-version', 'skip', 'engines.npm not set in package.json — skipping');
} else if (!currentNpm) {
  addCheck('npm-version', 'fail', 'npm binary not found on PATH');
} else {
  if (satisfiesConstraint(currentNpm, enginesNpm)) {
    addCheck('npm-version', 'pass', `npm ${currentNpm} satisfies ${enginesNpm}`);
  } else {
    addCheck('npm-version', 'fail', `npm ${currentNpm} does NOT satisfy engines.npm ${enginesNpm}`);
  }
}

// ---------------------------------------------------------------------------
// Check 3: Lockfile presence
// ---------------------------------------------------------------------------
const LOCKFILE = path.join(PROJECT_ROOT, 'package-lock.json');
if (fs.existsSync(LOCKFILE)) {
  addCheck('lockfile-present', 'pass', 'package-lock.json exists');
} else {
  addCheck('lockfile-present', 'fail', "package-lock.json missing — run 'npm install' to generate it");
}

// ---------------------------------------------------------------------------
// Check 4: Lockfile sync (npm ci --dry-run)
// ---------------------------------------------------------------------------
if (fs.existsSync(LOCKFILE)) {
  try {
    // --ignore-scripts: this is a lockfile-vs-package.json sync check, not a
    // build. Without it, npm would run the `prepare` lifecycle (build:lib via
    // tsc) — which fails when check:env runs before deps are installed (tsc
    // absent), misreporting an out-of-sync lockfile. ADR-457 build-at-publish.
    const res = spawnSync(npmCmd, ['ci', '--dry-run', '--ignore-scripts'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    if (res.status === 0) {
      addCheck('lockfile-sync', 'pass', 'package-lock.json is in sync with package.json');
    } else {
      addCheck('lockfile-sync', 'fail', "package-lock.json is out of sync — run 'npm ci' to restore");
    }
  } catch {
    addCheck('lockfile-sync', 'fail', "package-lock.json is out of sync — run 'npm ci' to restore");
  }
} else {
  addCheck('lockfile-sync', 'skip', 'skipped — lockfile missing');
}

// ---------------------------------------------------------------------------
// Check 5: Version manager pin vs active Node
// Looks for .nvmrc, .node-version, or .tool-versions at project root.
// ---------------------------------------------------------------------------
const NVMRC = path.join(PROJECT_ROOT, '.nvmrc');
const NODE_VERSION_FILE = path.join(PROJECT_ROOT, '.node-version');
const TOOL_VERSIONS = path.join(PROJECT_ROOT, '.tool-versions');

let pinnedMajor = '';
let pinSource = '';

if (fs.existsSync(NVMRC)) {
  const content = fs.readFileSync(NVMRC, 'utf8').split('\n')[0].trim().replace(/^v/, '');
  pinnedMajor = content.split('.')[0];
  pinSource = '.nvmrc';
} else if (fs.existsSync(NODE_VERSION_FILE)) {
  const content = fs.readFileSync(NODE_VERSION_FILE, 'utf8').split('\n')[0].trim().replace(/^v/, '');
  pinnedMajor = content.split('.')[0];
  pinSource = '.node-version';
} else if (fs.existsSync(TOOL_VERSIONS)) {
  const lines = fs.readFileSync(TOOL_VERSIONS, 'utf8').split('\n');
  const nodeLine = lines.find(l => /^nodejs\s+/.test(l));
  if (nodeLine) {
    const ver = nodeLine.split(/\s+/)[1] || '';
    pinnedMajor = ver.replace(/^v/, '').split('.')[0];
    pinSource = '.tool-versions';
  }
}

if (!pinnedMajor) {
  addCheck('version-manager-pin', 'skip', 'no .nvmrc, .node-version, or .tool-versions found — skipping');
} else if (process.env.CI === 'true') {
  addCheck('version-manager-pin', 'skip', 'CI=true — version-manager pin check skipped (matrix tests multiple Node majors)');
} else {
  const activeMajor = process.version.replace(/^v/, '').split('.')[0];
  if (activeMajor === pinnedMajor) {
    addCheck('version-manager-pin', 'pass', `Active Node major (${activeMajor}) matches ${pinSource} pin (${pinnedMajor})`);
  } else {
    addCheck('version-manager-pin', 'fail', `Active Node major (${activeMajor}) does NOT match ${pinSource} pin (${pinnedMajor}) — run 'nvm use' or equivalent`);
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
const overallPass = checks.every(c => c.status !== 'fail');

if (jsonMode) {
  // Structured JSON: {pass: bool, checks: [{name, status, message}]}
  const out = {
    pass: overallPass,
    checks: checks.map(c => ({ name: c.name, status: c.status, message: c.message })),
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
} else {
  // Human-readable report
  process.stdout.write('=== Environment Check ===\n');
  for (const { name, status, message } of checks) {
    const icon = status === 'pass' ? '[PASS]' : status === 'fail' ? '[FAIL]' : '[SKIP]';
    const namePadded = name.padEnd(25);
    process.stdout.write(`  ${icon}  ${namePadded}  ${message}\n`);
  }
  process.stdout.write('\n');
  if (overallPass) {
    process.stdout.write('Result: ALL CHECKS PASSED\n');
  } else {
    process.stdout.write('Result: ONE OR MORE CHECKS FAILED — see above\n');
  }
}

process.exit(overallPass ? 0 : 1);
