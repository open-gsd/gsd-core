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
// not made by the write seam in `shell-command-projection.cjs`: `platformWriteSync` (it writes a
// tmp file and renames it, and falls back to a direct write) or `platformRestoreFileSync` (#5831,
// the byte-exact restore of a file's prior bytes, publishing through the same tmp-and-rename path;
// the engine's own write-failure rollback inside readModifyWriteStateMd uses it). The seam is
// identified by one of those two functions being on the stack, not by the module alone: the
// module's other exports, such as `retryRenameSync`, can land raw bytes on STATE.md too. Whether
// the restore primitive belongs to the seam under #5120's approved rule (which names
// platformWriteSync) is recorded in the PR for the maintainer. A rename or copy whose source is itself a
// file named `STATE.md` relocates an existing STATE.md (a workstream migration, an archive) and
// authors no bytes, so it is not recorded; one from any other file (`STATE.md.tmp`, a backup) is.
// Test code writing STATE.md fixtures is not product code and is never recorded. There is no
// allowlist (ADR-4629 Decision 5).
//
// How it is installed. run-tests.cjs writes a one-line preload shim into its run directory that
// sets GSD_STATE_WRITE_LEDGER to the run's ledger file and requires this file, and puts
// `--require "<shim>"` into NODE_OPTIONS, so the gsd-tools subprocesses a test spawns load it too,
// not only the test-file children. The ledger path rides inside the shim because the repo's child
// environment helper (tests/helpers/isolated-env.cjs) strips every GSD_* variable; NODE_OPTIONS
// survives it. Each recorded write appends one JSON line; after the last
// chunk the runner reads the ledger and fails the run on any violation. Seam writes are recorded
// as well, with whether this process held the STATE.md lock, so the report never states the zero
// alone (ADR-3408 Decision 5). Each process that installs the wrappers also appends one install
// sentinel line, marked as a preload only when the runner's shim (preloadShimSource) set its
// marker before requiring this file; every chunk the runner spawns is itself a node process that
// loads the shim, so the runner fails a run whose ledger holds fewer preload sentinels than
// chunks spawned: a chunk whose preload never loaded leaves no preload sentinel, and an empty
// ledger alone would otherwise read as zero violations. A test file that requires this file
// directly (the guard's own tests) installs too, on the ledger the runner also passes in the
// env, but its sentinel is not a preload and cannot vouch for its chunk.
//
// Limits, stated plainly. It sees only code paths the suite executes. It wraps the fs entry points
// listed in WRAPPED and WRAPPED_PROMISES (fs.promises.cp is seen through the fs.promises.copyFile
// it calls); a write through fs.openSync + fs.writeSync, a FileHandle,
// a write stream, or a native addon is not seen (the seam's own direct fallback writes through a
// descriptor, so a fallback write is not counted among the seam writes). A test that replaces
// NODE_OPTIONS, or spawns node with an env that drops it, runs its child unguarded. A child built
// with isolated-env.cjs keeps the guard but loses the test-file attribution (GSD_STATE_WRITE_TEST_FILE
// is stripped), so its violation reads `test: unknown`. The caller is the nearest JS
// frame, so a write is attributed to whatever function is closest to the fs call: product code
// that hands a STATE.md path to a helper outside `gsd-core/bin/` is attributed to that helper, and
// a test that mocks an fs function with a JS wrapper (mock.method) puts its own frame nearest, so a
// product write made under that mock is not recorded. The basename match is case-sensitive. Without
// a ledger path the module installs nothing. A ledger line a killed process left torn is counted
// and printed beside the zero, never silently dropped. The install sentinels prove the preload
// loaded in at least as many processes as chunks were spawned, not in every child a test spawns:
// a test-file child or a gsd-tools subprocess whose env replaced NODE_OPTIONS leaves no sentinel
// and no records, and its absence is not told apart from one more chunk-level sentinel, so such
// a child stays unguarded and unseen.

const fs = require('fs');
const path = require('path');

const LEDGER_ENV = 'GSD_STATE_WRITE_LEDGER';
// Set by the first test-file child that loads this file, so subprocesses it spawns inherit the
// name of the test file whose run produced their writes.
const TEST_FILE_ENV = 'GSD_STATE_WRITE_TEST_FILE';
const SEAM_MODULE = 'shell-command-projection.cjs';
const SEAM_FUNCTIONS = new Set(['platformWriteSync', 'platformRestoreFileSync']);
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
// fs.promises.cp is not wrapped: it copies through fs.promises.copyFile, which is, so a cp onto
// STATE.md is recorded once, as promises.copyFile.
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
 * true when one of the seam module's write functions (SEAM_FUNCTIONS) is on the stack of this write. Whether the
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

// Set by the runner's shim before it requires this file; the install sentinel records it.
const PRELOADED = Symbol.for('gsd.rawStateWriteGuard.preloaded');

/**
 * Source of the per-run preload shim run-tests.cjs writes into its events directory: names
 * the ledger (the path rides here, not only in the env, because isolated-env.cjs strips
 * GSD_*), sets the preload marker, and requires this file. The marker is what makes the
 * process's install sentinel count as a preload: only a chunk, or a child that inherited the
 * chunk's NODE_OPTIONS, reaches this file through the shim.
 */
function preloadShimSource(ledgerPath) {
  return (
    `process.env[${JSON.stringify(LEDGER_ENV)}] = ${JSON.stringify(String(ledgerPath))};\n` +
    `globalThis[Symbol.for(${JSON.stringify(PRELOADED.description)})] = true;\n` +
    `require(${JSON.stringify(__filename)});\n`
  );
}

/**
 * NODE_OPTIONS with `--require "<file>"` PREPENDED. Node runs --require preloads in order and the
 * guard installs once per process on the ledger named when it first loads, so the innermost
 * run-tests (a runner a test spawns, inside an outer run) must come first: its shim names its own
 * ledger before the outer run's shim does, and the inner run's product writes stay in the inner
 * ledger. Inside double quotes Node's NODE_OPTIONS parser treats a backslash as an escape, so a
 * Windows path is escaped, not passed raw.
 */
function nodeOptionsWithRequire(existing, file) {
  const quoted = `"${String(file).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const base = typeof existing === 'string' ? existing.trim() : '';
  return base ? `--require ${quoted} ${base}` : `--require ${quoted}`;
}

/**
 * `{ entries, installs, preloadInstalls, tornLines }`: the ledger's write entries, the count of
 * install sentinel lines (one per process that installed the wrappers), how many of those came
 * through the runner's preload shim, and the count of lines that did not parse to an object (a
 * line a killed process left torn), or `{ entries: null, installs: 0, preloadInstalls: 0,
 * tornLines: 0 }` when the ledger cannot be read (unreadable evidence, #5170).
 */
function readStateWriteLedger(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { entries: null, installs: 0, preloadInstalls: 0, tornLines: 0 };
  }
  const entries = [];
  let installs = 0;
  let preloadInstalls = 0;
  let tornLines = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      tornLines++;
      continue;
    }
    if (!parsed || typeof parsed !== 'object') {
      tornLines++;
      continue;
    }
    if (parsed.installed === true) {
      installs++;
      if (parsed.preload === true) preloadInstalls++;
    } else {
      entries.push(parsed);
    }
  }
  return { entries, installs, preloadInstalls, tornLines };
}

/**
 * `{ failed, lines }` for the runner to print, from readStateWriteLedger's result.
 * `chunksRun` is how many test chunks the runner spawned; each is a node process that loads the
 * shim, so fewer PRELOAD sentinels than chunks means a chunk whose preload never loaded, whose
 * empty ledger is not evidence of zero violations: the run fails, and the line names the shim
 * (`shimPath`) and the NODE_OPTIONS the chunks received (`nodeOptions`, bounded), because the
 * runner deletes its events directory, shim and ledger included, right after printing. A
 * sentinel from a direct require of this file is counted and shown, never compared: it cannot
 * vouch for a chunk (#5120 re-review NEW-1).
 */
function formatStateWriteReport({ entries, installs = 0, preloadInstalls = 0, tornLines }, { chunksRun, shimPath, nodeOptions } = {}) {
  if (entries === null) {
    return { failed: true, lines: ['run-tests: raw STATE.md write check: ledger unreadable, so the check did not run'] };
  }
  const violations = entries.filter((e) => e.violation);
  const seamWrites = entries.filter((e) => e.seam);
  const unlocked = seamWrites.filter((e) => !e.lockHeld).length;
  const torn = tornLines > 0 ? `, unreadable ledger lines: ${tornLines}` : '';
  const lines = [
    `run-tests: raw STATE.md writes in product code: ${violations.length} ` +
      `(seam writes onto STATE.md: ${seamWrites.length}, of which without the STATE.md lock: ${unlocked}${torn}); ` +
      `the check loaded in ${preloadInstalls} processes` +
      (installs > preloadInstalls ? ` (and in ${installs - preloadInstalls} more by a direct require)` : ''),
  ];
  const neverLoaded = Number.isInteger(chunksRun) && preloadInstalls < chunksRun;
  if (neverLoaded) {
    const options = String(nodeOptions == null ? '' : nodeOptions);
    const shown = options.length > 120 ? `${options.slice(0, 120)}... (${options.length} chars)` : options;
    const direct = installs > preloadInstalls
      ? ` (${installs - preloadInstalls} more installed it by a direct require, which does not vouch for a chunk)`
      : '';
    lines.push(
      `run-tests: raw STATE.md write check: ${chunksRun} chunk${chunksRun === 1 ? ' was' : 's were'} spawned but only ` +
        `${preloadInstalls} process${preloadInstalls === 1 ? '' : 'es'} recorded the preload${direct}, so the zero above is not evidence; ` +
        `the shim was ${shimPath == null ? 'unknown' : shimPath} and each chunk received NODE_OPTIONS ${shown}`,
    );
  }
  for (const v of violations) {
    lines.push(`  ${v.fn} ${v.destination} from ${v.callerFile}:${v.callerLine} (test: ${v.testFile || 'unknown'})`);
  }
  return { failed: violations.length > 0 || neverLoaded, lines };
}

/**
 * The nearest caller frame outside node internals and this file, from V8's structured callsites,
 * and whether one of the seam's write functions is on the stack.
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
    if (path.basename(file) === SEAM_MODULE && SEAM_FUNCTIONS.has(site.getFunctionName())) {
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

  // One install sentinel per process, written after the wrappers are in place. The runner
  // counts these against the chunks it spawned: a chunk whose preload never loaded leaves no
  // sentinel, and its empty ledger is not evidence of zero violations. Never thrown into the
  // process being loaded; a lost sentinel shares the one once-flag with a lost record (same
  // ledger, same cause), so the run hears about the first loss only.
  // `preload` is true only when the runner's shim (preloadShimSource) set its marker before
  // requiring this file: a test file that requires the guard directly also installs, but its
  // sentinel must not vouch for a chunk whose preload never loaded (#5120 re-review NEW-1).
  const preload = globalThis[PRELOADED] === true;
  try {
    originalAppend.call(fs, ledger, `${JSON.stringify({ installed: true, preload, pid: process.pid, testFile: testFile || null })}\n`);
  } catch (err) {
    if (!ledgerWarned) {
      ledgerWarned = true;
      try { process.stderr.write(`raw-state-write-guard: could not record the preload install (${err && err.message}); the run's check is incomplete\n`); } catch { /* nothing left to do */ }
    }
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
  SEAM_FUNCTIONS,
  classifyStateWrite,
  preloadShimSource,
  nodeOptionsWithRequire,
  readStateWriteLedger,
  formatStateWriteReport,
};
