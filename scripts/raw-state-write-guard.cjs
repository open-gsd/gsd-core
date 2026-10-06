'use strict';

// Raw STATE.md write check, installed for the whole suite by scripts/run-tests.cjs (#5120).
//
// Why this exists. ADR-4629's guard roster row "No raw STATE.md write outside the seam" was
// enforced only by the Axis-2 string match in scripts/lint-state-write-path-drift.cjs, which
// reads variable names, not values. A target held in a Map key filled in another function (the
// roadmap-upgrade cross-reference loop, #5104 miss 3) is invisible to it. A raw write skips the
// STATE.md lock, and ADR-3473 section 8.6's amendment names the cost: "That is not a preservation
// bypass, it is a lock bypass", the #500/#905/#1230 lost-update family. This module checks the
// VALUE at run time instead: the destination's basename, whatever the variable is called.
//
// What it enforces. A write whose destination basename is exactly `STATE.md` is a violation when
// the nearest caller frame outside node internals and this file is product code (a `.cjs` file in
// a `gsd-core/bin/` directory: the compiled `gsd-core/bin/lib/*.cjs`, `gsd-tools.cjs`, or an
// installed copy of either; the repo-root `bin/*.js` launchers are not payload) and the write is
// not made by the write seam, `platformWriteSync` in `shell-command-projection.cjs` (it writes a
// tmp file and renames it, and falls back to a direct write). The seam is identified by that
// function being on the stack, not by the module alone: the module's other exports, such as
// `retryRenameSync`, can land raw bytes on STATE.md too. A rename or copy whose source is itself a
// file named `STATE.md` relocates an existing STATE.md (a workstream migration, an archive) and
// authors no bytes, so it is not recorded; one from any other file (`STATE.md.tmp`, a backup) is.
// Test code writing STATE.md fixtures is not product code and is never recorded. There is no
// allowlist (ADR-4629 Decision 5).
//
// How it is installed. run-tests.cjs puts `--require "<this file>"` into NODE_OPTIONS (so the
// gsd-tools subprocesses a test spawns load it too, not only the test-file children) and names a
// ledger file in GSD_STATE_WRITE_LEDGER. Each recorded write appends one JSON line; after the last
// chunk the runner reads the ledger and fails the run on any violation. Seam writes are recorded
// as well, with whether this process held the STATE.md lock, so the report never states the zero
// alone (ADR-3408 Decision 5).
//
// Limits, stated plainly. It sees only code paths the suite executes. It wraps the fs entry points
// listed in WRAPPED and WRAPPED_PROMISES; a write through fs.openSync + fs.writeSync, a FileHandle,
// fs.promises.cp, a write stream, or a native addon is not seen. A test that replaces NODE_OPTIONS,
// or spawns node with an env that drops it, runs its child unguarded. The caller is the nearest JS
// frame, so a write is attributed to whatever function is closest to the fs call: product code
// that hands a STATE.md path to a helper outside `gsd-core/bin/` is attributed to that helper, and
// a test that mocks an fs function with a JS wrapper (mock.method) puts its own frame nearest, so a
// product write made under that mock is not recorded. The basename match is case-sensitive. Without
// a ledger path the module installs nothing.

const fs = require('fs');
const path = require('path');

const LEDGER_ENV = 'GSD_STATE_WRITE_LEDGER';
// Set by the first test-file child that loads this file, so subprocesses it spawns inherit the
// name of the test file whose run produced their writes.
const TEST_FILE_ENV = 'GSD_STATE_WRITE_TEST_FILE';
const SEAM_MODULE = 'shell-command-projection.cjs';
const SEAM_FUNCTION = 'platformWriteSync';
const PRODUCT_SEGMENT = '/gsd-core/bin/';

/** fs entry point -> index of its destination argument (rename/copy/cp take the source at 0). */
const WRAPPED = Object.freeze({
  writeFileSync: 0,
  appendFileSync: 0,
  renameSync: 1,
  copyFileSync: 1,
  cpSync: 1,
  writeFile: 0,
  appendFile: 0,
  rename: 1,
  copyFile: 1,
  cp: 1,
});
const WRAPPED_PROMISES = Object.freeze({ writeFile: 0, appendFile: 0, rename: 1, copyFile: 1 });

const toPosix = (p) => String(p).replace(/\\/g, '/');

/** A `.cjs` file in a `gsd-core/bin/` directory (the payload), never the repo-root `bin/*.js`. */
function isProductFile(file) {
  const posix = toPosix(file);
  return posix.includes(PRODUCT_SEGMENT) && posix.endsWith('.cjs');
}

/**
 * The rule, as a pure function. `recorded` is false for anything the check does not look at:
 * a basename other than exactly `STATE.md`, or a caller that is not product code. `viaSeam` is
 * true when `platformWriteSync` in the seam module is on the stack of this write. Whether the
 * STATE.md lock was held is recorded beside the verdict and never part of it: the approved rule
 * (#5120) is the seam, and the report prints the unlocked seam writes next to the zero.
 */
function classifyStateWrite({ destination, source, callerFile, viaSeam }) {
  const notRecorded = { recorded: false, violation: false, seam: false };
  if (path.posix.basename(toPosix(destination)) !== 'STATE.md') return notRecorded;
  if (source !== undefined && source !== null && path.posix.basename(toPosix(source)) === 'STATE.md') return notRecorded;
  if (!callerFile || !isProductFile(callerFile)) return notRecorded;
  const seam = viaSeam === true;
  return { recorded: true, violation: !seam, seam };
}

/**
 * NODE_OPTIONS with `--require "<file>"` appended. Inside double quotes Node's NODE_OPTIONS parser
 * treats a backslash as an escape, so a Windows path is escaped, not passed raw.
 */
function nodeOptionsWithRequire(existing, file) {
  const quoted = `"${String(file).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const base = typeof existing === 'string' ? existing.trim() : '';
  return base ? `${base} --require ${quoted}` : `--require ${quoted}`;
}

/** Ledger entries, or null when the ledger cannot be read (unreadable evidence, #5170). */
function readStateWriteLedger(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch { /* a torn line from a killed process */ }
  }
  return entries;
}

/** `{ failed, lines }` for the runner to print. */
function formatStateWriteReport(entries) {
  if (entries === null) {
    return { failed: true, lines: ['run-tests: raw STATE.md write check: ledger unreadable, so the check did not run'] };
  }
  const violations = entries.filter((e) => e.violation);
  const seamWrites = entries.filter((e) => e.seam);
  const unlocked = seamWrites.filter((e) => !e.lockHeld).length;
  const lines = [
    `run-tests: raw STATE.md writes in product code: ${violations.length} ` +
      `(seam writes onto STATE.md: ${seamWrites.length}, of which without the STATE.md lock: ${unlocked})`,
  ];
  for (const v of violations) {
    lines.push(`  ${v.fn} ${v.destination} from ${v.callerFile}:${v.callerLine} (test: ${v.testFile || 'unknown'})`);
  }
  return { failed: violations.length > 0, lines };
}

/**
 * The nearest caller frame outside node internals and this file, from V8's structured callsites,
 * and whether the seam's write function is on the stack.
 */
function callerFrame() {
  const savedPrepare = Error.prepareStackTrace;
  const savedLimit = Error.stackTraceLimit;
  let sites = [];
  try {
    Error.stackTraceLimit = 30;
    Error.prepareStackTrace = (_err, callsites) => callsites;
    const holder = {};
    Error.captureStackTrace(holder, callerFrame);
    sites = Array.isArray(holder.stack) ? holder.stack : [];
  } catch {
    sites = [];
  } finally {
    Error.prepareStackTrace = savedPrepare;
    Error.stackTraceLimit = savedLimit;
  }
  let caller = null;
  let viaSeam = false;
  for (const site of sites) {
    let file = site.getFileName();
    if (!file || file.startsWith('node:')) continue;
    if (file.startsWith('file://')) {
      try { file = require('url').fileURLToPath(file); } catch { continue; }
    }
    if (file === __filename) continue;
    if (!caller) caller = { file, line: site.getLineNumber() };
    if (path.basename(file) === SEAM_MODULE && site.getFunctionName() === SEAM_FUNCTION) {
      viaSeam = true;
      break;
    }
  }
  return { file: caller ? caller.file : null, line: caller ? caller.line : null, viaSeam };
}

/** rename/copy/cp take (source, destination); the write calls take no source. */
function index0IsSource(fn) {
  return /(?:^|\.)(?:rename|renameSync|copyFile|copyFileSync|cp|cpSync)$/.test(fn);
}

function lockHeldByThisProcess(destination) {
  try {
    const body = fs.readFileSync(`${destination}.lock`, 'utf8');
    return Number.parseInt(body, 10) === process.pid;
  } catch {
    return false;
  }
}

function install(ledger) {
  const testFile = process.env[TEST_FILE_ENV] || (process.env.NODE_TEST_CONTEXT ? process.argv[1] : undefined);
  if (testFile && !process.env[TEST_FILE_ENV]) process.env[TEST_FILE_ENV] = testFile;
  const originalAppend = fs.appendFileSync;
  let ledgerWarned = false;

  const asPath = (p) => (p instanceof URL ? require('url').fileURLToPath(p) : String(p));
  const observe = (fn, rawDestination, rawSource) => {
    try {
      if (rawDestination === undefined || rawDestination === null) return;
      if (typeof rawDestination !== 'string' && !(rawDestination instanceof URL) && !Buffer.isBuffer(rawDestination)) return;
      const destination = rawDestination instanceof URL ? require('url').fileURLToPath(rawDestination) : String(rawDestination);
      if (path.basename(destination) !== 'STATE.md') return;
      const caller = callerFrame();
      const lockHeld = lockHeldByThisProcess(destination);
      const source = index0IsSource(fn) && rawSource !== undefined && rawSource !== null ? asPath(rawSource) : undefined;
      const verdict = classifyStateWrite({ destination, source, callerFile: caller.file, viaSeam: caller.viaSeam });
      if (!verdict.recorded) return;
      const entry = { fn, destination, callerFile: caller.file, callerLine: caller.line, lockHeld, violation: verdict.violation, seam: verdict.seam, testFile: testFile || null, pid: process.pid };
      originalAppend.call(fs, ledger, `${JSON.stringify(entry)}\n`);
    } catch (err) {
      // Never throw into the code under observation; say once that the check lost a record.
      if (!ledgerWarned) {
        ledgerWarned = true;
        try { process.stderr.write(`raw-state-write-guard: could not record a STATE.md write (${err && err.message}); the run's check is incomplete\n`); } catch { /* nothing left to do */ }
      }
    }
  };

  // Only the outermost call is observed: node's own fs.appendFileSync calls fs.writeFileSync
  // through the exported object, which would record one append twice.
  let depth = 0;
  for (const [name, index] of Object.entries(WRAPPED)) {
    const original = fs[name];
    if (typeof original !== 'function') continue;
    fs[name] = function rawStateWriteGuard(...args) {
      if (depth === 0) observe(name, args[index], args[0]);
      depth++;
      try {
        return original.apply(this, args);
      } finally {
        depth--;
      }
    };
  }
  for (const [name, index] of Object.entries(WRAPPED_PROMISES)) {
    const original = fs.promises[name];
    if (typeof original !== 'function') continue;
    fs.promises[name] = function rawStateWriteGuard(...args) {
      if (depth === 0) observe(`promises.${name}`, args[index], args[0]);
      return original.apply(this, args);
    };
  }
}

// One install per process, even if this file is reached under two paths: a second wrapper would
// record every write twice.
const INSTALLED = Symbol.for('gsd.rawStateWriteGuard.installed');
if (process.env[LEDGER_ENV] && !globalThis[INSTALLED]) {
  globalThis[INSTALLED] = true;
  install(process.env[LEDGER_ENV]);
}

module.exports = {
  LEDGER_ENV,
  TEST_FILE_ENV,
  classifyStateWrite,
  nodeOptionsWithRequire,
  readStateWriteLedger,
  formatStateWriteReport,
};
