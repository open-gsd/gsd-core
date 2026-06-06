'use strict';
// check-npm-integrity.cjs — Node.js port of scripts/check-npm-integrity.sh
// Shell-agnostic replacement for the "Dependency integrity gate" CI step.
// Invoked as: node scripts/check-npm-integrity.cjs [--ignore-extraneous]
//
// Parses package-lock.json in cwd and exits non-zero if any package is:
//   INVALID    — resolved version does not satisfy declared semver range
//   MISSING    — declared in package.json but absent from lockfile packages map
//   EXTRANEOUS — marked extraneous: true in lockfile (unless --ignore-extraneous)
//
// Exit codes:
//   0 = clean
//   1 = integrity drift detected
//   2 = tool error (lockfile missing, JSON parse failure, unknown arg)

const fs = require('fs');
const path = require('path');

const { ExitError, runMain } = require('./lib/cli-exit.cjs');

// ---- Minimal semver satisfies -----------------------------------------------

function parseVersion(v) {
  const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

function cmpVersion(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function satisfies(installed, range) {
  range = String(range).trim();
  if (!range || range === '*' || range === 'latest') return true;
  if (/^\d/.test(range)) {
    const iv = parseVersion(installed);
    const rv = parseVersion(range);
    if (!iv || !rv) return installed === range;
    return cmpVersion(iv, rv) === 0;
  }
  if (range[0] === '^') {
    const base = parseVersion(range.slice(1));
    const inst = parseVersion(installed);
    if (!base || !inst) return false;
    if (cmpVersion(inst, base) < 0) return false;
    if (base[0] > 0) return inst[0] === base[0];
    if (base[1] > 0) return inst[0] === 0 && inst[1] === base[1];
    return inst[0] === 0 && inst[1] === 0 && inst[2] === base[2];
  }
  if (range[0] === '~') {
    const tbase = parseVersion(range.slice(1));
    const tinst = parseVersion(installed);
    if (!tbase || !tinst) return false;
    if (cmpVersion(tinst, tbase) < 0) return false;
    return tinst[0] === tbase[0] && tinst[1] === tbase[1];
  }
  const opMatch = range.match(/^(>=|<=|>|<|=)\s*(.+)/);
  if (opMatch) {
    const op = opMatch[1];
    const ov = parseVersion(opMatch[2]);
    const iv2 = parseVersion(installed);
    if (!ov || !iv2) return false;
    const c = cmpVersion(iv2, ov);
    if (op === '>=') return c >= 0;
    if (op === '<=') return c <= 0;
    if (op === '>')  return c > 0;
    if (op === '<')  return c < 0;
    if (op === '=')  return c === 0;
  }
  if (range.includes(' ')) {
    return range.split(/\s+/).every(part => satisfies(installed, part));
  }
  return installed === range;
}

function main() {
  // ---- Argument parsing -------------------------------------------------------

  let ignoreExtraneous = false;

  for (const arg of process.argv.slice(2)) {
    if (arg === '--ignore-extraneous') {
      ignoreExtraneous = true;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: node scripts/check-npm-integrity.cjs [--ignore-extraneous]\n'
      );
      return 0;
    } else {
      process.stderr.write(`ERROR: Unknown argument: ${arg}\n`);
      throw new ExitError(2);
    }
  }

  // ---- Locate lockfile --------------------------------------------------------

  const lockfilePath = path.join(process.cwd(), 'package-lock.json');

  if (!fs.existsSync(lockfilePath)) {
    process.stderr.write(`ERROR: package-lock.json not found in ${process.cwd()}\n`);
    throw new ExitError(2);
  }

  // ---- Parse lockfile ---------------------------------------------------------

  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(lockfilePath, 'utf-8'));
  } catch (e) {
    process.stderr.write(`ERROR: Failed to parse package-lock.json: ${e.message}\n`);
    throw new ExitError(2);
  }

  const lockVersion = lock.lockfileVersion || 1;
  if (lockVersion < 2) {
    process.stderr.write(
      `ERROR: package-lock.json lockfileVersion ${lockVersion} is not supported. ` +
      'Run `npm install` to upgrade to v3.\n'
    );
    throw new ExitError(2);
  }

  const packages = lock.packages || {};
  const rootEntry = packages[''] || {};

  // Collect declared dependency ranges from root entry.
  const declaredRanges = {};
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, range] of Object.entries(rootEntry[field] || {})) {
      if (!declaredRanges[name]) declaredRanges[name] = range;
    }
  }

  // ---- Walk packages map ------------------------------------------------------

  const invalids = [];
  const missings = [];
  const extraneousFound = [];

  for (const [key, entry] of Object.entries(packages)) {
    if (!key.startsWith('node_modules/')) continue;
    const rest = key.slice('node_modules/'.length);
    const isScoped = rest[0] === '@';
    const slashCount = (rest.match(/\//g) || []).length;
    if (isScoped && slashCount > 1) continue;
    if (!isScoped && slashCount > 0) continue;

    const pkgName = rest;
    const installedVersion = entry.version || '';

    if (entry.extraneous) {
      extraneousFound.push({ name: pkgName, version: installedVersion });
      continue;
    }

    if (!declaredRanges[pkgName]) continue;

    if (!satisfies(installedVersion, declaredRanges[pkgName])) {
      invalids.push({ name: pkgName, version: installedVersion, declared: declaredRanges[pkgName] });
    }
  }

  for (const name of Object.keys(declaredRanges)) {
    if (!packages[`node_modules/${name}`]) {
      missings.push({ name, required: declaredRanges[name] });
    }
  }

  // ---- Verdict ----------------------------------------------------------------

  const failInvalid = invalids.length > 0;
  const failMissing = missings.length > 0;
  const failExtra   = !ignoreExtraneous && extraneousFound.length > 0;

  if (!failInvalid && !failMissing && !failExtra) {
    process.stderr.write('check-npm-integrity.cjs: clean\n');
    return 0;
  }

  const lines = ['FAIL: dependency integrity drift detected', ''];

  if (failInvalid) {
    lines.push('  INVALID (installed version does not satisfy declared range):');
    for (const { name, declared, version } of invalids) {
      lines.push(`    ${name}: declared=${declared}  installed=${version}`);
    }
    lines.push('');
  }

  if (failMissing) {
    lines.push('  MISSING (declared but absent from lockfile packages map):');
    for (const { name, required } of missings) {
      lines.push(`    ${name}@${required}`);
    }
    lines.push('');
  }

  if (failExtra) {
    lines.push('  EXTRANEOUS (in lockfile but not declared as a dependency):');
    for (const { name, version } of extraneousFound) {
      lines.push(`    ${name}@${version}`);
    }
    lines.push('');
  }

  lines.push('Remediation: rm -rf node_modules && npm ci');
  process.stderr.write(lines.join('\n') + '\n');
  throw new ExitError(1);
}

runMain(main);
