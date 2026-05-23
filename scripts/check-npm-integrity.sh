#!/usr/bin/env bash
# check-npm-integrity.sh -- Enforce npm dependency integrity baseline
#
# Detects invalid, missing, and extraneous packages by parsing the
# package-lock.json in the current directory (lockfileVersion 2 or 3).
# Exits non-zero when any integrity problem is found, emitting a structured
# report to stderr listing every offender.
#
# Source: https://docs.npmjs.com/cli/v10/commands/npm-ls
#   lockfileVersion 3 "packages" map records every resolved package under
#   "node_modules/<name>" with its resolved version.  The root entry "" holds
#   the declared dependency ranges.  This script compares the two without
#   requiring node_modules to be present on disk, making it safe to run in
#   CI environments before `npm ci`.
#
# Detection rules (all derived from package-lock.json):
#   - MISSING    : declared in root dependencies but absent from packages map
#   - INVALID    : in packages map but installed version does not satisfy the
#                  declared semver range
#   - EXTRANEOUS : appears in packages map with "extraneous": true, OR present
#                  in packages map but not declared in any root dependency field
#
# Workspace behaviour: if the root package.json declares a "workspaces" field,
# npm ls traverses all workspace packages automatically (npm >=7). This script
# runs at the directory where it is invoked; for workspace repos, invoke from
# the root. The sdk/ sub-package in this repo is NOT a declared workspace and
# is therefore out of scope for this single invocation.
#
# Security context:
#   NIST SSDF PW.4.1 -- use components from well-governed, secure sources:
#     https://csrc.nist.gov/publications/detail/sp/800-218/final
#   OpenSSF Scorecard "Pinned-Dependencies" rationale:
#     https://github.com/ossf/scorecard/blob/main/docs/checks.md#pinned-dependencies
#
# Usage:
#   ./scripts/check-npm-integrity.sh [--ignore-extraneous] [--help]
#
# Exit codes:
#   0 = clean (no integrity problems, or only extraneous and --ignore-extraneous set)
#   1 = integrity drift detected (invalid, missing, or extraneous packages)
#   2 = tool error (node not found, JSON parse failure, missing lockfile, or usage error)

set -euo pipefail

SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"
IGNORE_EXTRANEOUS=false

# ---- Usage ------------------------------------------------------------------

usage() {
  cat >&2 <<'USAGE'
Usage: check-npm-integrity.sh [OPTIONS]

Verify that the npm lockfile in the current directory is internally consistent.

Parses package-lock.json and fails if any package is:
  - invalid    (resolved version does not satisfy the declared semver range)
  - missing    (declared in package.json / lockfile root but absent from packages map)
  - extraneous (present in packages map but not declared as a dependency,
                or marked extraneous: true in the lockfile)

Options:
  --ignore-extraneous   Allow extraneous packages; only fail on invalid/missing
  --help                Print this help message and exit 0

Exit codes:
  0  Clean -- no integrity problems
  1  Drift detected -- see stderr for details
  2  Tool error -- node not found, JSON parse failure, missing lockfile, or usage error

Remediation:
  rm -rf node_modules && npm ci

Sources:
  npm lockfile docs: https://docs.npmjs.com/cli/v10/configuring-npm/package-lock-json
  NIST SSDF PW.4.1: https://csrc.nist.gov/publications/detail/sp/800-218/final
USAGE
}

# ---- Argument parsing -------------------------------------------------------

for arg in "$@"; do
  case "$arg" in
    --ignore-extraneous)
      IGNORE_EXTRANEOUS=true
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: Unknown argument: $arg" >&2
      usage
      exit 2
      ;;
  esac
done

# ---- Prerequisite check -----------------------------------------------------

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not found on PATH" >&2
  exit 2
fi

# ---- Locate lockfile --------------------------------------------------------

LOCKFILE="$(pwd)/package-lock.json"

if [ ! -f "$LOCKFILE" ]; then
  echo "ERROR: package-lock.json not found in $(pwd)" >&2
  exit 2
fi

# ---- Parse lockfile via Node.js ---------------------------------------------
#
# Write the parser to a temp file to avoid heredoc/stdin conflicts.
# The lockfile path and ignore-extraneous flag are passed as argv.

GATE_TMP=$(mktemp -d)
trap 'rm -rf "$GATE_TMP"' EXIT

cat > "$GATE_TMP/parser.js" << 'ENDPARSER'
'use strict';
// argv[2] = absolute path to package-lock.json
// argv[3] = "true"|"false" for --ignore-extraneous
var fs = require('fs');
var path = require('path');

var lockfilePath = process.argv[2];
var ignoreExtraneous = process.argv[3] === 'true';

var raw;
try {
  raw = fs.readFileSync(lockfilePath, 'utf-8');
} catch (e) {
  process.stderr.write('ERROR: Cannot read ' + lockfilePath + ': ' + e.message + '\n');
  process.exit(2);
}

var lock;
try {
  lock = JSON.parse(raw);
} catch (e) {
  process.stderr.write('ERROR: Failed to parse package-lock.json: ' + e.message + '\n');
  process.exit(2);
}

// Only lockfileVersion 2+ uses the "packages" map we rely on.
var lockVersion = lock.lockfileVersion || 1;
if (lockVersion < 2) {
  process.stderr.write(
    'ERROR: package-lock.json lockfileVersion ' + lockVersion +
    ' is not supported. Run `npm install` to upgrade to v3.\n'
  );
  process.exit(2);
}

var packages = lock.packages || {};
var rootEntry = packages[''] || {};

// Collect all declared dependency ranges from root entry.
// Include dependencies, devDependencies, optionalDependencies, peerDependencies.
var declaredRanges = {};
var depFields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
for (var fi = 0; fi < depFields.length; fi++) {
  var field = depFields[fi];
  var deps = rootEntry[field] || {};
  var depNames = Object.keys(deps);
  for (var di = 0; di < depNames.length; di++) {
    var dname = depNames[di];
    if (!declaredRanges[dname]) {
      declaredRanges[dname] = deps[dname];
    }
  }
}

// ---- Minimal semver satisfies implementation --------------------------------
// Supports: exact version ("1.2.3"), caret ("^1.2.3"), tilde ("~1.2.3"),
// comparison operators (">=1.0.0 <2.0.0"), and wildcards ("*", "").
// For the integrity gate use-case (comparing lockfile resolved vs declared),
// full semver is rarely needed — exact-version and simple ranges cover ~99%.

function parseVersion(v) {
  var m = String(v).match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

function cmpVersion(a, b) {
  for (var i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function satisfies(installed, range) {
  range = String(range).trim();
  // Wildcard / empty
  if (!range || range === '*' || range === 'latest') return true;
  // Exact version (no operator)
  if (/^\d/.test(range)) {
    var iv = parseVersion(installed);
    var rv = parseVersion(range);
    if (!iv || !rv) return installed === range;
    return cmpVersion(iv, rv) === 0;
  }
  // Caret range: ^X.Y.Z  → >=X.Y.Z <(X+1).0.0  (major must match for X>0)
  if (range.charAt(0) === '^') {
    var base = parseVersion(range.slice(1));
    var inst = parseVersion(installed);
    if (!base || !inst) return false;
    if (cmpVersion(inst, base) < 0) return false;
    if (base[0] > 0) return inst[0] === base[0];
    if (base[1] > 0) return inst[0] === 0 && inst[1] === base[1];
    return inst[0] === 0 && inst[1] === 0 && inst[2] === base[2];
  }
  // Tilde range: ~X.Y.Z → >=X.Y.Z <X.(Y+1).0
  if (range.charAt(0) === '~') {
    var tbase = parseVersion(range.slice(1));
    var tinst = parseVersion(installed);
    if (!tbase || !tinst) return false;
    if (cmpVersion(tinst, tbase) < 0) return false;
    return tinst[0] === tbase[0] && tinst[1] === tbase[1];
  }
  // Simple comparison operators: >=, <=, >, <, =
  var opMatch = range.match(/^(>=|<=|>|<|=)\s*(.+)/);
  if (opMatch) {
    var op = opMatch[1];
    var ov = parseVersion(opMatch[2]);
    var iv2 = parseVersion(installed);
    if (!ov || !iv2) return false;
    var c = cmpVersion(iv2, ov);
    if (op === '>=') return c >= 0;
    if (op === '<=') return c <= 0;
    if (op === '>')  return c > 0;
    if (op === '<')  return c < 0;
    if (op === '=')  return c === 0;
  }
  // Compound range (space-separated, e.g. ">=1.0.0 <2.0.0")
  if (range.indexOf(' ') !== -1) {
    var parts = range.split(/\s+/);
    for (var pi = 0; pi < parts.length; pi++) {
      if (!satisfies(installed, parts[pi])) return false;
    }
    return true;
  }
  // Fallback: string equality
  return installed === range;
}

// ---- Walk packages map ------------------------------------------------------

var invalids = [];
var missings = [];
var extraneousFound = [];

// Check each node_modules/<name> entry in the lockfile.
var pkgKeys = Object.keys(packages);
for (var ki = 0; ki < pkgKeys.length; ki++) {
  var key = pkgKeys[ki];
  if (!key.startsWith('node_modules/')) continue;
  // Skip workspace sub-packages (contain a second slash after node_modules/)
  var rest = key.slice('node_modules/'.length);
  // Scoped packages (@scope/name) have one slash; skip nested like node_modules/a/node_modules/b
  var slashCount = (rest.match(/\//g) || []).length;
  var isScoped = rest.charAt(0) === '@';
  if (isScoped && slashCount > 1) continue;
  if (!isScoped && slashCount > 0) continue;

  var pkgName = rest;
  var entry = packages[key];
  var installedVersion = entry.version || '';

  // Explicitly marked extraneous by npm in the lockfile.
  if (entry.extraneous) {
    extraneousFound.push({ name: pkgName, version: installedVersion });
    continue;
  }

  // Not declared in root deps → extraneous.
  if (!declaredRanges[pkgName]) {
    extraneousFound.push({ name: pkgName, version: installedVersion });
    continue;
  }

  // Declared — check version satisfies range.
  var declaredRange = declaredRanges[pkgName];
  if (!satisfies(installedVersion, declaredRange)) {
    invalids.push({
      name: pkgName,
      version: installedVersion,
      declared: declaredRange,
    });
  }
}

// Check for declared deps that have no lockfile entry (MISSING).
var declaredNames = Object.keys(declaredRanges);
for (var mi = 0; mi < declaredNames.length; mi++) {
  var mname = declaredNames[mi];
  var lockKey = 'node_modules/' + mname;
  if (!packages[lockKey]) {
    missings.push({ name: mname, required: declaredRanges[mname] });
  }
}

// ---- Verdict ----------------------------------------------------------------

var failInvalid = invalids.length > 0;
var failMissing = missings.length > 0;
var failExtra   = !ignoreExtraneous && extraneousFound.length > 0;

if (!failInvalid && !failMissing && !failExtra) {
  process.exit(0);
}

var lines = [];
lines.push('FAIL: dependency integrity drift detected');
lines.push('');

if (failInvalid) {
  lines.push('  INVALID (installed version does not satisfy declared range):');
  for (var j = 0; j < invalids.length; j++) {
    var iv = invalids[j];
    lines.push('    ' + iv.name + ': declared=' + iv.declared + '  installed=' + iv.version);
  }
  lines.push('');
}

if (failMissing) {
  lines.push('  MISSING (declared but absent from lockfile packages map):');
  for (var k = 0; k < missings.length; k++) {
    var mv = missings[k];
    lines.push('    ' + mv.name + '@' + mv.required);
  }
  lines.push('');
}

if (failExtra) {
  lines.push('  EXTRANEOUS (in lockfile but not declared as a dependency):');
  for (var l = 0; l < extraneousFound.length; l++) {
    var ev = extraneousFound[l];
    lines.push('    ' + ev.name + '@' + ev.version);
  }
  lines.push('');
}

lines.push('Remediation: rm -rf node_modules && npm ci');
process.stderr.write(lines.join('\n') + '\n');
process.exit(1);
ENDPARSER

PARSE_EXIT=0
node "$GATE_TMP/parser.js" "$LOCKFILE" "$IGNORE_EXTRANEOUS" 2>"$GATE_TMP/parse_err" || PARSE_EXIT=$?

# Forward parser stderr to our stderr
if [ -s "$GATE_TMP/parse_err" ]; then
  cat "$GATE_TMP/parse_err" >&2
fi

if [ "$PARSE_EXIT" -eq 0 ]; then
  echo "$SCRIPT_NAME: clean" >&2
fi

exit "$PARSE_EXIT"
