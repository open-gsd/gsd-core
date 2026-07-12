// allow-test-rule: source-text-is-the-product (see #1936)
// The OpenCode reviewer reconstructs its review from opencode's --format json
// event stream using two embedded jq programs in gsd-core/workflows/review.md.
// Those programs ARE the runtime contract; this test extracts them verbatim from
// the workflow and exercises the real jq (not a reimplementation) so the shipped
// reconstruction logic is what gets property-tested.
//
// ARCHITECTURE (#2099): the shipped jq program is run over a WHOLE fast-check corpus
// in ONE jq process, not once per generated case. Each generated event stream is
// written as one compact-JSON array per line to a temp file, then `jq -c <PROGRAM>`
// (no `-s`) applies PROGRAM to each array — `.` is that array, exactly what
// production's `jq -rs` sees after slurping opencode's one-value-per-line stream —
// emitting one compact-JSON result per line. This is empirically identical to the
// per-stream `-rs` form (verified across embedded-newline/empty/quote/unicode/
// null-drop cases) AND reads from a file like production (`jq -rs '…' <file>`), so
// there is no stdin pipe to deadlock on large I/O. The prior design spawned ~600
// synchronous jq subprocesses (numRuns × 3 properties); a single one freezing on a
// contended CI runner hung the whole unit-test chunk to its 600s kill (macOS CI,
// #2099). `node --test`'s --test-force-exit cannot interrupt a synchronous
// execFileSync, so the cure is to stop spawning per case — not just to time-bound it.
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { cleanup } = require('./helpers.cjs');

const reviewPath = path.resolve(__dirname, '..', 'gsd-core', 'workflows', 'review.md');
const workflow = fs.readFileSync(reviewPath, 'utf-8');

// Extract the two shipped jq programs verbatim. If review.md changes their shape,
// these throw and the test fails loudly (intended coupling — #1936).
function extractJqProgram(varName) {
  const re = new RegExp(`${varName}=\\$\\(jq -rs '([^']*)'`);
  const m = workflow.match(re);
  assert.ok(m, `review.md must define ${varName} via jq -rs '<program>' (#1936)`);
  return m[1];
}
const TEXT_PROGRAM = extractJqProgram('OPENCODE_REVIEW'); // review reconstruction
const DIAG_PROGRAM = extractJqProgram('OPENCODE_DIAG');    // empty-output diagnostic

// This suite shells out to `jq`. On Windows, Node's child_process argument quoting
// mangles the jq program (it embeds quotes) — jq then raises a parse error — and
// jq isn't guaranteed on the host regardless. The reconstruction logic is
// platform-independent (the review workflow runs jq in its Unix-y runtime), so gate
// the suite to jq-present non-Windows hosts, mirroring golden-install-parity's win32
// skip. The assertions run in full on every macOS/Linux CI leg.
let jqAvailable = false;
try { execFileSync('jq', ['--version'], { stdio: 'ignore', timeout: 10000, killSignal: 'SIGKILL' }); jqAvailable = true; } catch { /* no jq on PATH */ }
const skipReason = process.platform === 'win32'
  ? 'jq invocation is not portable under Node child_process arg-quoting on Windows; logic is platform-independent and asserted on macOS/Linux'
  : (jqAvailable ? false : 'jq not on PATH');
const opts = { skip: skipReason };

// Bound each jq subprocess so a frozen spawn on a contended runner fails fast +
// diagnosably (ETIMEDOUT) rather than hanging the chunk. jq over this corpus
// completes in ~10ms, so 30s is an enormous margin that never trips on a healthy run.
const JQ_EXEC_OPTS = { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 };

// Run a shipped jq program over an array of event streams in a SINGLE jq process.
// Returns one result per input stream (order preserved), decoded from jq's compact
// (`-c`) JSON output back to the raw string production's `-r` would have captured.
// Both shipped programs yield exactly one value per stream (join(...) / last|"...");
// the length assertion pins that invariant so a future program change that broke it
// (0 or >1 outputs) fails loudly instead of silently misaligning results.
function runJqBatch(program, streams) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-jq-batch-'));
  try {
    const file = path.join(dir, 'streams.jsonl');
    fs.writeFileSync(file, streams.map((events) => JSON.stringify(events)).join('\n') + '\n');
    const out = execFileSync('jq', ['-c', program, file], JQ_EXEC_OPTS);
    const lines = out.split('\n').filter((line) => line.length > 0);
    assert.equal(
      lines.length,
      streams.length,
      `jq must emit exactly one result per stream (got ${lines.length} for ${streams.length})`,
    );
    return lines.map((line) => JSON.parse(line));
  } finally {
    cleanup(dir);
  }
}

// The intended reconstruction, computed independently of jq. jq is the unit under
// test; this JS is the spec it must match on every generated case.
function expectedReview(events) {
  return events
    .filter((e) => e.type === 'text' && e.part && typeof e.part.text === 'string')
    .map((e) => e.part.text)
    .join('\n');
}

// Text values safe to round-trip through JSON → jq (utf8) → string. Excludes lone
// surrogates (which don't survive utf8) but keeps the interesting cases: newlines,
// quotes, backslashes, braces, unicode.
const safeText = fc
  .string({ minLength: 0, maxLength: 40 })
  .filter((s) => Buffer.from(s, 'utf8').toString('utf8') === s);

// A `text` event whose `.part.text` is a string, or null/absent (dropped by `// empty`).
const textEvent = fc.record({
  type: fc.constant('text'),
  part: fc.oneof(
    fc.record({ text: safeText }),
    fc.record({ text: fc.constant(null) }), // null → jq `// empty` drops it
    fc.record({}),                           // absent → jq `// empty` drops it
  ),
});
const stepFinishEvent = fc.record({
  type: fc.constant('step_finish'),
  part: fc.record({
    reason: fc.constantFrom('stop', 'length', 'tool_calls'),
    tokens: fc.record({ output: fc.integer({ min: 0, max: 100000 }) }),
  }),
});
const nonTextEvent = fc.oneof(
  stepFinishEvent,
  fc.record({ type: fc.constant('tool_use'), part: fc.record({ tool: safeText }) }),
  fc.record({ type: fc.constant('step_start'), part: fc.record({}) }),
);
// Weight text events higher so streams routinely mix real review text with noise,
// but also generate text-free streams (the #1936 zero-output case).
const eventStream = fc.array(fc.oneof(textEvent, textEvent, nonTextEvent), {
  minLength: 1,
  maxLength: 30,
});

// Corpus size per property. Matches the prior fast-check-setup numRuns:200 so
// coverage is unchanged; distinct seeds give each property an independent corpus,
// and fixed seeds keep the corpus deterministic across CI runs/OS legs.
const CORPUS = 200;

describe('#1936 OpenCode review reconstruction — jq properties', () => {
  test('review == the newline-join of every assistant text part, over a generated corpus (order preserved)', opts, () => {
    const streams = fc.sample(eventStream, { numRuns: CORPUS, seed: 42 });
    const actual = runJqBatch(TEXT_PROGRAM, streams); // one jq process for the whole corpus
    streams.forEach((events, i) => {
      assert.equal(
        actual[i],
        expectedReview(events),
        `case ${i}: shipped jq review must equal the spec for events=${JSON.stringify(events)}`,
      );
    });
  });

  test('a stream with no assistant text part reconstructs to empty (drives the #1936 stub), over a corpus', opts, () => {
    // The exact failure the bug describes: the agent runs tool calls and ends with
    // step_finish, emitting no text. Reconstruction must be empty so the content-gate
    // (`[ -n "$OPENCODE_REVIEW" ]`) falls through to the stub.
    const streams = fc.sample(fc.array(nonTextEvent, { minLength: 1, maxLength: 20 }), { numRuns: CORPUS, seed: 43 });
    const actual = runJqBatch(TEXT_PROGRAM, streams);
    streams.forEach((events, i) => {
      assert.equal(actual[i], '', `case ${i}: text-free stream must reconstruct to '' for ${JSON.stringify(events)}`);
    });
  });

  test('text parts that are null/absent are dropped, never rendered as "null", over a corpus', opts, () => {
    const nullish = fc.array(
      fc.oneof(
        fc.record({ type: fc.constant('text'), part: fc.record({ text: fc.constant(null) }) }),
        fc.record({ type: fc.constant('text'), part: fc.record({}) }),
      ),
      { minLength: 1, maxLength: 10 },
    );
    const streams = fc.sample(nullish, { numRuns: CORPUS, seed: 44 });
    const actual = runJqBatch(TEXT_PROGRAM, streams);
    streams.forEach((events, i) => {
      assert.equal(actual[i], '', `case ${i}: null/absent text must drop to ''`);
      assert.doesNotMatch(actual[i], /null/, `case ${i}: must never render "null"`);
    });
  });

  // Explicit boundary + happy examples (deterministic, not sampled) — all in one
  // batched jq spawn. Pins the exact contract the corpus only covers probabilistically.
  test('boundary + happy example streams reconstruct exactly (batched)', opts, () => {
    const cases = [
      { events: [{ type: 'text', part: { text: 'only' } }], expect: 'only' },                       // single text part
      { events: [{ type: 'text', part: { text: '' } }], expect: '' },                                // empty-string text is kept
      { events: [{ type: 'text', part: { text: 'a' } }, { type: 'tool_use', part: { tool: 'r' } }, { type: 'text', part: { text: 'b' } }], expect: 'a\nb' }, // text interleaved with noise
      { events: [{ type: 'text', part: { text: 'x\ny' } }], expect: 'x\ny' },                        // embedded newline preserved
      { events: [{ type: 'tool_use', part: { tool: 'read' } }, { type: 'step_finish', part: { reason: 'stop', tokens: { output: 3 } } }], expect: '' }, // no text at all
      { events: Array.from({ length: 30 }, (_v, i) => ({ type: 'text', part: { text: `p${i}` } })), expect: Array.from({ length: 30 }, (_v, i) => `p${i}`).join('\n') }, // max-size all-text stream
    ];
    const actual = runJqBatch(TEXT_PROGRAM, cases.map((c) => c.events));
    cases.forEach((c, i) => assert.equal(actual[i], c.expect, `example ${i}: ${JSON.stringify(c.events)}`));
  });

  // Diagnostic path (empty-output stub). The finding calls out `missing .tokens.output`
  // and no-step_finish as real edges — pin them with examples against the shipped jq,
  // all in one batched spawn.
  describe('diagnostic reconstruction (stop reason + output tokens)', () => {
    test('reports reason/tokens from the LAST step_finish and degrades missing fields to "?"', opts, () => {
      const cases = [
        { events: [
          { type: 'step_finish', part: { reason: 'tool_calls', tokens: { output: 5 } } },
          { type: 'tool_use', part: {} },
          { type: 'step_finish', part: { reason: 'stop', tokens: { output: 0 } } },
        ], expect: 'stop reason=stop, output tokens=0' },                                   // LAST step_finish wins
        { events: [{ type: 'step_finish', part: { reason: 'stop', tokens: {} } }], expect: 'stop reason=stop, output tokens=?' }, // missing .tokens.output → "?"
        { events: [{ type: 'tool_use', part: { tool: 'read' } }], expect: 'stop reason=?, output tokens=?' }, // no step_finish at all → both "?"
      ];
      const actual = runJqBatch(DIAG_PROGRAM, cases.map((c) => c.events));
      cases.forEach((c, i) => assert.equal(actual[i], c.expect, `diag ${i}: ${JSON.stringify(c.events)}`));
    });
  });

  // The primary reconstruction runs before any content gate; on non-JSON stdout
  // (e.g. an opencode crash that printed a plain-text error) jq must fail rather
  // than emit that text as a "review" — the workflow's `2>/dev/null` + empty
  // capture then routes to the diagnostic stub.
  test('non-JSON stdout does not masquerade as a reconstructed review', opts, () => {
    let threw = false;
    try {
      execFileSync('jq', ['-rs', TEXT_PROGRAM], { ...JQ_EXEC_OPTS, input: 'auth token expired\n' });
    } catch {
      threw = true;
    }
    assert.ok(threw, 'jq must reject non-JSON input so it cannot be captured as a review');
  });
});
