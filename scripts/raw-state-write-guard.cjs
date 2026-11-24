'use strict';

// Raw STATE.md write check, installed for the whole suite by scripts/run-tests.cjs (#5120; ADR-4629
// guard roster, Amendment 2). The Axis-2 lint (scripts/lint-state-write-path-drift.cjs) reads names;
// this checks the value at run time: a product write whose destination basename is STATE.md. A raw
// write it records fails the run, and so does a seam write (platformWriteSync or
// platformRestoreFileSync on the stack) or a relocation (a rename or copy from a file named STATE.md)
// made without the STATE.md lock (ADR-3473 section 8.6). classifyStateWrite is the rule. What is recorded, how the runner installs it, the report and
// the limits are stated in docs/TESTING-SUITES.md, "The raw STATE.md write check"; change that
// section with this file.

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
const WRAPPED_PROMISES = Object.freeze({ writeFile: 0, appendFile: 0, rename: 1, copyFile: 1 });

const toPosix = (p) => String(p).replace(/\\/g, '/');

/** A `.cjs` file in a `gsd-core/bin/` directory (the payload), never the repo-root `bin/*.js`. */
function isProductFile(file) {
  const posix = toPosix(file);
  return posix.includes(PRODUCT_SEGMENT) && posix.endsWith('.cjs');
}

/**
 * The rule, as a pure function. `recorded` is false for a basename other than exactly
 * `STATE.md`, or a caller that is not product code. `viaSeam` is true
 * when one of the seam module's write functions (SEAM_FUNCTIONS) is on the stack of this write.
 * A rename or copy whose source is itself a file named `STATE.md` is a `relocation`, held to
 * the lock rule like a seam write (#5120 review Major 3). A recorded write is a violation:
 * - `reason: 'raw'` when it is neither a seam write nor a relocation;
 * - `reason: 'unlocked'` when it is a seam write or a relocation and this process did not hold
 *   the STATE.md lock on the destination (`lockHeld`) and, for a relocation, on the source too
 *   (`sourceLockHeld`) (#5120 review Major 1).
 */
function classifyStateWrite({ destination, source, callerFile, viaSeam, lockHeld, sourceLockHeld }) {
  const notRecorded = { recorded: false, violation: false, seam: false, relocation: false, reason: null };
  if (path.posix.basename(toPosix(destination)) !== 'STATE.md') return notRecorded;
  if (!callerFile || !isProductFile(callerFile)) return notRecorded;
  const seam = viaSeam === true;
  const relocation = !seam && source !== undefined && source !== null && path.posix.basename(toPosix(source)) === 'STATE.md';
  if (!seam && !relocation) return { recorded: true, violation: true, seam, relocation, reason: 'raw' };
  const locked = lockHeld === true && (!relocation || sourceLockHeld === true);
  return { recorded: true, violation: !locked, seam, relocation, reason: locked ? null : 'unlocked' };
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

const hasExactKeys = (o, keys) => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
};
const isPlainObject = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const isStringOrNull = (v) => v === null || typeof v === 'string';

/** The install sentinel as `install` appends it. */
function isInstallSentinel(o) {
  return isPlainObject(o) && hasExactKeys(o, ['installed', 'preload', 'pid', 'testFile'])
    && o.installed === true && typeof o.preload === 'boolean' && Number.isInteger(o.pid) && isStringOrNull(o.testFile);
}

/** The write entry as `observe` appends it. */
function isWriteEntry(o) {
  return isPlainObject(o)
    && hasExactKeys(o, ['fn', 'destination', 'source', 'callerFile', 'callerLine', 'lockHeld', 'sourceLockHeld', 'violation', 'reason', 'seam', 'relocation', 'testFile', 'pid'])
    && typeof o.fn === 'string' && typeof o.destination === 'string' && isStringOrNull(o.source) && typeof o.callerFile === 'string'
    && (o.callerLine === null || Number.isInteger(o.callerLine))
    && typeof o.lockHeld === 'boolean' && (o.sourceLockHeld === null || typeof o.sourceLockHeld === 'boolean')
    && typeof o.violation === 'boolean' && (o.reason === null || o.reason === 'raw' || o.reason === 'unlocked')
    && typeof o.seam === 'boolean' && typeof o.relocation === 'boolean' && isStringOrNull(o.testFile) && Number.isInteger(o.pid);
}

/**
 * `{ entries, installs, preloadInstalls, preloadTestFiles, tornLines }` from the ledger (#5170).
 */
function readStateWriteLedger(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { entries: null, installs: 0, preloadInstalls: 0, preloadTestFiles: [], tornLines: 0 };
  }
  const entries = [];
  let installs = 0;
  let preloadInstalls = 0;
  const preloadTestFiles = new Set();
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
    const sentinel = isInstallSentinel(parsed);
    if (!sentinel && !isWriteEntry(parsed)) {
      tornLines++;
      continue;
    }
    if (sentinel) {
      installs++;
      if (parsed.preload === true) {
        preloadInstalls++;
        if (typeof parsed.testFile === 'string' && parsed.testFile) preloadTestFiles.add(parsed.testFile);
      }
    } else {
      entries.push(parsed);
    }
  }
  return { entries, installs, preloadInstalls, preloadTestFiles: [...preloadTestFiles].sort(), tornLines };
}

/**
 * One spelling per test file, for comparing the runner's list with the files the preload sentinels
 * name: resolved, then its real path when it exists (a symlinked temp root, such as macOS's /var to
 * /private/var, is followed on both sides), then case-folded on win32, whose file names are
 * case-insensitive (a drive letter can reach the two sides in different cases).
 */
function sameFileKey(file, platform = process.platform) {
  let key = path.resolve(String(file));
  try { key = fs.realpathSync.native(key); } catch { /* a file that is gone keeps its resolved path */ }
  return platform === 'win32' ? key.toLowerCase() : key;
}

/** At most 120 characters of `value`, then its full length, for a line that names a long value. */
function bounded(value) {
  const text = String(value == null ? '' : value);
  return text.length > 120 ? `${text.slice(0, 120)}... (${text.length} chars)` : text;
}

/**
 * `{ failed, lines }` for the runner to print, from readStateWriteLedger's result. The not-loaded
 * lines name the shim (`shimPath`) and the NODE_OPTIONS the chunks received (`nodeOptions`,
 * bounded), because the runner deletes its events directory, shim and ledger included, right after
 * printing.
 */
function formatStateWriteReport(
  { entries, installs = 0, preloadInstalls = 0, preloadTestFiles = [], tornLines = 0 },
  { chunksRun, testFilesRun, shimPath, nodeOptions } = {},
) {
  if (entries === null) {
    return { failed: true, lines: ['run-tests: raw STATE.md write check: ledger unreadable, so the check did not run'] };
  }
  const violations = entries.filter((e) => e.violation);
  const raw = violations.filter((e) => e.reason !== 'unlocked').length;
  const seamWrites = entries.filter((e) => e.seam).length;
  const relocations = entries.filter((e) => e.relocation).length;
  const unlocked = violations.length - raw;
  const lines = [
    `run-tests: raw STATE.md writes in product code: ${raw}; ` +
      `seam writes and relocations onto STATE.md: ${seamWrites + relocations} (${relocations} relocation${relocations === 1 ? '' : 's'}), ` +
      `of which without the STATE.md lock: ${unlocked}; unreadable ledger lines: ${tornLines}; ` +
      `the check loaded in ${preloadInstalls} process${preloadInstalls === 1 ? '' : 'es'}` +
      (installs > preloadInstalls ? ` (and in ${installs - preloadInstalls} more by a direct require)` : ''),
  ];
  const where = `the shim was ${shimPath == null ? 'unknown' : shimPath} and each chunk received NODE_OPTIONS ${bounded(nodeOptions)}`;
  const direct = installs > preloadInstalls
    ? ` (${installs - preloadInstalls} more installed it by a direct require, which does not vouch for a chunk)`
    : '';
  const neverLoaded = Number.isInteger(chunksRun) && preloadInstalls < chunksRun;
  if (neverLoaded) {
    lines.push(
      `run-tests: raw STATE.md write check: ${chunksRun} chunk${chunksRun === 1 ? ' was' : 's were'} spawned but only ` +
        `${preloadInstalls} process${preloadInstalls === 1 ? '' : 'es'} recorded the preload${direct}, so the counts above are not evidence; ${where}`,
    );
  }
  const seen = new Set(preloadTestFiles.map((f) => sameFileKey(f)));
  const unguarded = [];
  const listed = new Set();
  for (const f of Array.isArray(testFilesRun) ? testFilesRun : []) {
    const key = sameFileKey(f);
    if (listed.has(key)) continue;
    listed.add(key);
    if (!seen.has(key)) unguarded.push(path.resolve(String(f)));
  }
  if (unguarded.length > 0) {
    const shown = unguarded.slice(0, 10).join(', ') + (unguarded.length > 10 ? `, and ${unguarded.length - 10} more` : '');
    lines.push(
      `run-tests: raw STATE.md write check: ${unguarded.length} test file${unguarded.length === 1 ? '' : 's'} left no preload ` +
        `sentinel (unguarded, or never started), so the counts above do not cover ${unguarded.length === 1 ? 'it' : 'them'}: ${shown}; ${where}`,
    );
  }
  if (tornLines > 0) {
    lines.push(
      `run-tests: raw STATE.md write check: ${tornLines} ledger line${tornLines === 1 ? '' : 's'} did not parse ` +
        `(a process killed mid-record can cut off a violation), so the counts above are not evidence`,
    );
  }
  for (const v of violations) {
    let what = 'raw write';
    let target = v.destination;
    if (v.reason === 'unlocked' && v.relocation) {
      const ends = [v.sourceLockHeld === true ? null : 'the source', v.lockHeld === true ? null : 'the destination'].filter(Boolean);
      what = `relocation without the STATE.md lock on ${ends.join(' and ')}`;
      target = `${v.source} -> ${v.destination}`;
    } else if (v.reason === 'unlocked') {
      what = 'seam write without the STATE.md lock';
    }
    lines.push(`  ${what}: ${v.fn} ${target} from ${v.callerFile}:${v.callerLine} (test: ${v.testFile || 'unknown'})`);
  }
  return { failed: violations.length > 0 || neverLoaded || unguarded.length > 0 || tornLines > 0, lines };
}

/**
 * The nearest caller frame outside node internals, this file and the seam module, from V8's
 * structured callsites, and whether one of the seam's write functions sits between that frame and
 * the fs call.
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
    if (path.basename(file) === SEAM_MODULE) {
      if (SEAM_FUNCTIONS.has(site.getFunctionName())) viaSeam = true;
      continue;
    }
    caller = { file, line: site.getLineNumber() };
    break;
  }
  return { file: caller ? caller.file : null, line: caller ? caller.line : null, viaSeam };
}

/** rename/copy/cp take (source, destination); the write calls take no source. */
function index0IsSource(fn) {
  return /(?:^|\.)(?:rename|renameSync|copyFile|copyFileSync|cp|cpSync)$/.test(fn);
}

function lockHeldByThisProcess(destination) {
  try {
    if (!fs.lstatSync(`${destination}.lock`).isFile()) return false;
    const body = fs.readFileSync(`${destination}.lock`, 'utf8');
    return Number.parseInt(body, 10) === process.pid;
  } catch {
    return false;
  }
}

function install(ledger) {
  // Resolved once, here, so the runner can compare it with the test files it passed to its chunks.
  const testFile = process.env[TEST_FILE_ENV]
    || (process.env.NODE_TEST_CONTEXT && process.argv[1] ? path.resolve(process.argv[1]) : undefined);
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
      const sourceLockHeld = source !== undefined && path.basename(source) === 'STATE.md' ? lockHeldByThisProcess(source) : null;
      const verdict = classifyStateWrite({ destination, source, callerFile: caller.file, viaSeam: caller.viaSeam, lockHeld, sourceLockHeld });
      if (!verdict.recorded) return;
      const entry = {
        fn, destination, source: source === undefined ? null : source, callerFile: caller.file, callerLine: caller.line,
        lockHeld, sourceLockHeld, violation: verdict.violation, reason: verdict.reason, seam: verdict.seam,
        relocation: verdict.relocation, testFile: testFile || null, pid: process.pid,
      };
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
    // cpSync and cp load node's cp module, which takes copyFile from the promises object once,
    // when it loads; reaching fs.promises first (they load it anyway) wraps it before then.
    const loadsCp = name === 'cpSync' || name === 'cp';
    fs[name] = function rawStateWriteGuard(...args) {
      if (loadsCp) void fs.promises;
      if (depth === 0) observe(name, args[index], args[0]);
      depth++;
      try {
        return original.apply(this, args);
      } finally {
        depth--;
      }
    };
  }
  // fs.promises is wrapped when something first reaches it, never here: reading it loads
  // internal/fs/promises, which loads node:os, and node:os picks its win32 or POSIX tmpdir branch
  // once, when it loads. Loaded from this preload, that branch was fixed before the process's own
  // code ran, so a child that presents itself as win32 (the #5848 install probe) read the TMPDIR it
  // inherited instead of its TEMP/TMP. Three routes to the one promises object wrap it: the
  // fs.promises getter, a CommonJS require of `fs/promises` or `node:fs/promises`, and
  // process.getBuiltinModule of either. The last two reach it through the real fs.promises getter,
  // so the object wrapped is the one fs.promises returns, even when a require hook installed
  // earlier hands back a stand-in for `fs/promises`.
  let promisesWrapped = false;
  const wrapPromises = (promises) => {
    if (promisesWrapped || !promises) return promises;
    promisesWrapped = true;
    for (const [name, index] of Object.entries(WRAPPED_PROMISES)) {
      const original = promises[name];
      if (typeof original !== 'function') continue;
      promises[name] = function rawStateWriteGuard(...args) {
        if (depth === 0) observe(`promises.${name}`, args[index], args[0]);
        return original.apply(this, args);
      };
    }
    return promises;
  };
  const promisesProperty = Object.getOwnPropertyDescriptor(fs, 'promises');
  if (promisesProperty && promisesProperty.configurable && typeof promisesProperty.get === 'function') {
    Object.defineProperty(fs, 'promises', { ...promisesProperty, get() { return wrapPromises(promisesProperty.get.call(this)); } });
  } else {
    wrapPromises(fs.promises);
  }
  const isPromisesId = (id) => id === 'fs/promises' || id === 'node:fs/promises';
  const Module = require('module');
  const originalLoad = Module._load;
  Module._load = function rawStateWriteGuardLoad(request) {
    const loaded = originalLoad.apply(this, arguments);
    if (isPromisesId(request)) void fs.promises;
    return loaded;
  };
  if (typeof process.getBuiltinModule === 'function') {
    const originalGetBuiltinModule = process.getBuiltinModule;
    process.getBuiltinModule = function rawStateWriteGuardGetBuiltinModule(id) {
      const loaded = originalGetBuiltinModule.apply(this, arguments);
      if (isPromisesId(id)) void fs.promises;
      return loaded;
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
  sameFileKey,
  formatStateWriteReport,
};
