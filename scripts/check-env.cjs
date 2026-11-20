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
const { spawnSync } = require('child_process');

const { ExitError, runMain } = require('./lib/cli-exit.cjs');
const { describeNpmVersionCheckFailure } = require('./lib/npm-version-check-diagnosis.cjs');

// #4460 follow-up: check-env.cjs runs as its own standalone CI step BEFORE
// `npm ci` / `npm run build:lib` (a deliberate pre-flight, run before there
// is even a node_modules to build with) -- confirmed the hard way, by a
// MODULE_NOT_FOUND crash on every real CI platform after a first attempt at
// this fix routed the npm-version check through the canonical execNpm seam
// (gsd-core/bin/lib/shell-command-projection.cjs), a tsc-compiled artifact
// that plain does not exist yet at that point in the pipeline. This file
// must stay self-contained: no requires reaching into gsd-core/bin/lib.
//
// On Windows, npm ships as npm.cmd (a batch wrapper); spawnSync without
// shell:true requires the exact filename including extension.
const npmCommandFor = (platform) => (platform === 'win32' ? 'npm.cmd' : 'npm');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

  // Compared part by part: folding the three into one number made 1.1000.0
  // equal 2.0.0.
  const v = parseTuple(version);
  const r = parseTuple(reqVer);
  let order = 0;
  for (let i = 0; i < 3 && order === 0; i += 1) order = Math.sign(v[i] - r[i]);

  switch (op) {
    case '>=': return order >= 0;
    case '>':  return order >  0;
    case '<=': return order <= 0;
    case '<':  return order <  0;
    case '=':  return order === 0;
    default:   return false;
  }
}

/**
 * Read a field from package.json using dot-notation (e.g. 'engines.node').
 * Returns the string value or empty string if absent.
 * Uses './package.json' so Node resolves relative to CWD on all platforms.
 */
function pkgField(fieldPath, PROJECT_ROOT) {
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

/**
 * The arguments this script hands to npm. Tests pin them, because they are the
 * whole of the script's contract with npm.
 */
const NPM_VERSION_ARGS = Object.freeze(['--version']);
const NPM_LOCKFILE_SYNC_ARGS = Object.freeze(['ci', '--dry-run', '--ignore-scripts']);

function main(argv = process.argv.slice(2)) {
  // ---------------------------------------------------------------------------
  // Argument parsing
  // ---------------------------------------------------------------------------
  let jsonMode = false;

  for (const arg of argv) {
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
      return 0;
    } else {
      process.stderr.write(`Unknown option: ${arg}\n`);
      throw new ExitError(2);
    }
  }

  // ---------------------------------------------------------------------------
  // Locate the project root (directory containing package.json)
  // ---------------------------------------------------------------------------
  const PROJECT_ROOT = process.cwd();
  const PACKAGE_JSON = path.join(PROJECT_ROOT, 'package.json');

  if (!fs.existsSync(PACKAGE_JSON)) {
    process.stderr.write(`ERROR: package.json not found in ${PROJECT_ROOT}\n`);
    throw new ExitError(2);
  }

  const { checks, pass: overallPass } = collectChecks({ projectRoot: PROJECT_ROOT, run: spawnSync });

  // ---------------------------------------------------------------------------
  // Output
  // ---------------------------------------------------------------------------
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

  return overallPass ? 0 : 1;
}

/**
 * Run every check against one project directory and return the rows.
 *
 * Everything the checks read from outside the directory is an argument, so a
 * test can call this in its own process: `run` stands in for `spawnSync` (the
 * only way this script reaches npm), and `nodeVersion`, `env` and `platform`
 * stand in for the running Node. `run` has no default: a caller that forgot it
 * would start the real npm without saying so (#6375).
 *
 * @param {{projectRoot: string, run: typeof spawnSync, nodeVersion?: string,
 *   env?: Record<string, string|undefined>, platform?: string}} deps
 * @returns {{pass: boolean, checks: Array<{name: string, status: 'pass'|'fail'|'skip', message: string}>}}
 */
function collectChecks({
  projectRoot: PROJECT_ROOT,
  run,
  nodeVersion = process.version,
  env = process.env,
  platform = process.platform,
}) {
  if (typeof run !== 'function') {
    throw new TypeError('collectChecks: run (the process runner, spawnSync in the CLI) is required');
  }
  const npmCmd = npmCommandFor(platform);
  const viaShell = platform === 'win32';

  /** @type {Array<{name: string, status: 'pass'|'fail'|'skip', message: string}>} */
  const checks = [];

  function addCheck(name, status, message) {
    checks.push({ name, status, message });
  }

  // ---------------------------------------------------------------------------
  // Check 1: Node version vs engines.node
  // ---------------------------------------------------------------------------
  const enginesNode = pkgField('engines.node', PROJECT_ROOT);
  const currentNode = String(nodeVersion || '').replace(/^v/, '');

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
  const enginesNpm = pkgField('engines.npm', PROJECT_ROOT);
  // #4460: 15_000ms, not the original 10_000 -- matches the default this
  // repo's canonical (but here unusable, see the file-header note above)
  // execNpm seam already uses for npm subprocess calls generally, rather
  // than inventing a new number. Confirmed via real Windows CI: a 10s
  // window was insufficient twice under ~51-file concurrent test load.
  const NPM_VERSION_TIMEOUT_MS = 15_000;
  // No try/catch needed: spawnSync's documented contract routes ENOENT and a
  // timeout-triggered kill through the RETURNED result's `.error` field, not
  // a thrown exception -- there is nothing here for a catch to intercept.
  const npmVersionSpawn = run(npmCmd, [...NPM_VERSION_ARGS], { encoding: 'utf8', timeout: NPM_VERSION_TIMEOUT_MS, shell: viaShell });
  const npmVersionResult = {
    exitCode: npmVersionSpawn.status ?? 1,
    stdout: (npmVersionSpawn.stdout || '').toString().trim(),
    signal: npmVersionSpawn.signal ?? null,
    error: npmVersionSpawn.error ?? null,
    // Canonical cross-platform timeout predicate (matches this repo's
    // execNpm/isSpawnTimeout convention, src/shell-command-projection.cts):
    // error.code === 'ETIMEDOUT', which Node's spawnSync guarantees when its
    // own `timeout` option fires. Checking `signal === 'SIGTERM'` instead
    // (what an earlier version of this fix did) is platform-fragile -- that
    // module's own docstring flags a Windows-specific false-negative risk,
    // the exact platform this bug was discovered on.
    timedOut: (npmVersionSpawn.error && npmVersionSpawn.error.code === 'ETIMEDOUT') === true,
  };
  const currentNpm = npmVersionResult.exitCode === 0 && npmVersionResult.stdout ? npmVersionResult.stdout : '';

  if (!enginesNpm) {
    addCheck('npm-version', 'skip', 'engines.npm not set in package.json — skipping');
  } else if (!currentNpm) {
    addCheck('npm-version', 'fail', describeNpmVersionCheckFailure(npmVersionResult));
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
      const res = run(npmCmd, [...NPM_LOCKFILE_SYNC_ARGS], {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        shell: viaShell,
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
  } else if (env.CI === 'true') {
    addCheck('version-manager-pin', 'skip', 'CI=true — version-manager pin check skipped (matrix tests multiple Node majors)');
  } else {
    const activeMajor = currentNode.split('.')[0];
    if (activeMajor === pinnedMajor) {
      addCheck('version-manager-pin', 'pass', `Active Node major (${activeMajor}) matches ${pinSource} pin (${pinnedMajor})`);
    } else {
      addCheck('version-manager-pin', 'fail', `Active Node major (${activeMajor}) does NOT match ${pinSource} pin (${pinnedMajor}) — run 'nvm use' or equivalent`);
    }
  }

  return { pass: checks.every(c => c.status !== 'fail'), checks };
}

module.exports = { main, collectChecks, satisfiesConstraint };

// Run only as the entry script, so a test can require the checks without running them.
if (require.main === module) runMain(() => main());
