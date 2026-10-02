'use strict';

// Registration ledger preload for scripts/run-tests.cjs (#4031).
//
// Why this exists. The runner passes `--test-force-exit` to every chunk (the
// Windows post-test hang backstop, #1051/#869). Under process isolation each
// test file's child streams its results to the `node --test` parent over a
// pipe, and a force-exit can end the parent while bytes of that pipe are still
// unread (nodejs/node#64833). The reporters never see the lost tail, so the
// run printed a smaller pass count and exited 0: a test that executed and
// passed (or failed) was indistinguishable from one that never existed.
//
// The parent cannot know what it did not receive, so the count of results the
// child produced has to come from the child, over a channel that does not
// share the pipe: this module is loaded into each test-file child with
// `--require` (`--test` forwards it to the file children) and counts the leaf
// `test:pass` / `test:fail` events the child's own reporter hands to the V8
// serializer that frames them onto that pipe, keyed by the `file` each event
// carries. When the child exits it appends one line per file to the file named
// by GSD_RUN_TESTS_LEDGER_FILE. The runner compares that per-file count with
// the leaf results its ndjson reporter actually received
// (analyzeChunkAccounting in run-tests.cjs) and fails the chunk when
// registered > reported.
//
// Why it taps the serializer and does NOT wrap `test()` / `it()`. node:test
// stamps every test with the location of the code that called it
// (`getCallerLocation()` in lib/internal/test_runner/harness.js) and reports
// that as the event's `file`. A wrapper around `test` is a JS frame between the
// test file and node:test, so every event would report THIS file as its
// location: spec-reporter failure locations would point here and no result
// could be matched back to its test file. Counting at the serializer adds no
// frame to the call and counts exactly what is put on the pipe, so the count
// and the parent's report are compared like for like: a skipped or todo test,
// a skipped suite and a test name/only filter need no special case
// (an excluded test emits no event on either side).
//
// Blind spots, stated plainly: a child that emits nothing counts 0 (no loss is
// visible); a SIGKILLed child never runs the `exit` handler below, so it leaves no
// ledger line; a file the parent reported but the ledger never saw is not flagged
// per file; and the whole count depends on node:test's child reporter framing its
// events through v8.DefaultSerializer.prototype.writeValue (true on Node 24). If a
// Node change moves that, every count becomes 0: the runner then fails a chunk whose
// ledger counted 0 while its reporter received results (analyzeChunkAccounting,
// `ledgerCountedNothing`), and tests/run-tests-accounting.test.cjs pins the hook.
//
// Inert unless it is inside a test-file child (NODE_TEST_CONTEXT is set by
// `node --test` for those, not for the runner parent), so requiring it anywhere
// else is a no-op. There it does two things: it makes the child's stdout pipe
// blocking (blockChildStdout: this is what stops `--test-force-exit` from
// discarding queued results, the loss this accounting exists to detect), and,
// when a ledger path was supplied, counts results. Never throws into the code it
// observes.

const fs = require('fs');
const path = require('path');
const { DefaultSerializer } = require('v8');

const RESULT_TYPES = new Set(['test:pass', 'test:fail']);

/**
 * The file a reporter event counts toward, or null when the event is not a leaf test result the
 * runner's ndjson reporter would record (anything but a pass/fail, a suite, an event with no file).
 * analyzeChunkAccounting applies the same three conditions to the events it reads back.
 */
function resultFileOf(item) {
  if (item === null || typeof item !== 'object' || !RESULT_TYPES.has(item.type)) return null;
  const data = item.data;
  if (data === null || typeof data !== 'object' || typeof data.file !== 'string') return null;
  if (data.details && data.details.type === 'suite') return null;
  return data.file;
}

/**
 * One spelling for every ledger line: the real path. node reports a result's `file` already resolved
 * through symlinks (macOS /var -> /private/var), while a zero-result child's only name is process.argv[1],
 * as given, so without this the two kinds of line disagree on the same file. Best-effort: a path that cannot
 * be resolved keeps its absolute spelling (analyzeChunkAccounting normalizes both sides again regardless).
 */
function canonicalPath(file) {
  const absolute = path.resolve(file);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function install(ledgerPath,serializerPrototype = DefaultSerializer.prototype) {
  const counts = new Map(); // file -> leaf results handed to the serializer

  const original = serializerPrototype.writeValue;
  serializerPrototype.writeValue = function writeValueCountingResults(value) {
    try {
      const file = resultFileOf(value);
      if (file !== null) counts.set(file, (counts.get(file) || 0) + 1);
    } catch {
      // Counting must never change what is serialized.
    }
    return Reflect.apply(original, this, arguments);
  };

  process.on('exit', () => {
    try {
      // A child that produced no result still records itself (count 0), so the runner can tell
      // "the preload ran and saw nothing" from "the preload never ran".
      if (counts.size === 0 && process.argv[1]) counts.set(process.argv[1], 0);
      const lines = [];
      for (const [file, count] of counts) {
        lines.push(JSON.stringify({ type: 'registered', file: canonicalPath(file), count }));
      }
      fs.appendFileSync(ledgerPath, `${lines.join('\n')}\n`);
    } catch {
      // Best-effort: the ledger is a diagnostic channel and must never change
      // the exit status of the test file it observes.
    }
  });
}

/**
 * Make the test-file child's stdout (the pipe its results travel to the `node --test` parent on)
 * blocking, so every frame it wrote has reached the OS when the child exits.
 *
 * Why: the runner passes `--test-force-exit`, and node forwards it to each file child. A forced
 * child calls process.exit() as soon as its root test ends; its stdout is a non-blocking pipe on
 * POSIX, so frames still queued in the Socket are discarded and the parent never receives those
 * results (nodejs/node#64833; the fix proposed there, nodejs/node#64875, does exactly this with
 * `_handle.setBlocking(true)` at force-exit). Measured on Node 24.18 / Linux with 20 files x 300
 * tests, `--test-force-exit --test-concurrency=8`: 5039-5139 of 6000 results reported without
 * this, 6000 of 6000 with it (and 6000 without force-exit). Doing it at load time rather than at
 * exit means nothing is ever queued. The Windows hang guard that force-exit exists for (#1051)
 * is untouched. Best-effort: a stdout with no pipe handle (a file, a TTY) is left alone.
 */
function blockChildStdout(stdout) {
  try {
    const target = stdout === undefined ? process.stdout : stdout;
    const handle = target && target._handle;
    if (handle && typeof handle.setBlocking === 'function') {
      handle.setBlocking(true);
      return true;
    }
  } catch {
    // Never throw into the test file this observes.
  }
  return false;
}

// Inside a test-file child only (NODE_TEST_CONTEXT is set by `node --test` for those, not for the
// runner parent): the blocking stdout needs no ledger path; the ledger count needs one.
if (process.env.NODE_TEST_CONTEXT) {
  blockChildStdout();
  const ledgerPath = process.env.GSD_RUN_TESTS_LEDGER_FILE;
  if (ledgerPath) install(ledgerPath);
}

module.exports = { install, resultFileOf, blockChildStdout };
