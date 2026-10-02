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
// a skipped suite and a test name/only filter are all handled by construction
// (an excluded test emits no event on either side).
//
// Inert unless it is inside a test-file child (NODE_TEST_CONTEXT is set by
// `node --test` for those, not for the runner parent) AND a ledger path was
// supplied, so requiring it anywhere else is a no-op. Never throws into the
// code it observes.

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

function install(ledgerPath, serializerPrototype = DefaultSerializer.prototype) {
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
        lines.push(JSON.stringify({ type: 'registered', file: path.resolve(file), count }));
      }
      fs.appendFileSync(ledgerPath, `${lines.join('\n')}\n`);
    } catch {
      // Best-effort: the ledger is a diagnostic channel and must never change
      // the exit status of the test file it observes.
    }
  });
}

const ledgerPath = process.env.GSD_RUN_TESTS_LEDGER_FILE;
if (ledgerPath && process.env.NODE_TEST_CONTEXT) install(ledgerPath);

module.exports = { install, resultFileOf };
