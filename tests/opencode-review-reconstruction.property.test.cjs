// allow-test-rule: source-text-is-the-product (see #1936)
// The OpenCode reviewer reconstructs its review from opencode's --format json
// event stream using two embedded jq programs in gsd-core/workflows/review.md.
// Those programs ARE the runtime contract; this test extracts them verbatim from
// the workflow and exercises the real jq (not a reimplementation) so the shipped
// reconstruction logic is what gets property-tested.
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');

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

// The review workflow runs `jq` in its (installed) runtime, but the test host may
// not have it — GitHub's windows-latest runners ship no `jq` (macOS/Linux do). The
// reconstruction logic is platform-independent, so skip rather than ENOENT-fail
// where `jq` is absent; the assertions run in full on every jq-present runner.
let jqAvailable = false;
try { execFileSync('jq', ['--version'], { stdio: 'ignore' }); jqAvailable = true; } catch { /* no jq on PATH */ }
const opts = { skip: jqAvailable ? false : 'jq not on PATH (e.g. GitHub windows-latest); jq behavior is platform-independent and asserted on jq-present runners' };

// Run a shipped jq program against a stream of events serialized exactly as
// opencode emits them: one JSON value per line (jq -s slurps them into an array).
// jq -r appends a single trailing newline to the (single) string result; strip it
// to recover the value the workflow's `$(…)` capture would see.
function runJq(program, events) {
  const jsonl = events.map((e) => JSON.stringify(e)).join('\n');
  const out = execFileSync('jq', ['-rs', program], { input: jsonl, encoding: 'utf8' });
  return out.endsWith('\n') ? out.slice(0, -1) : out;
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

describe('#1936 OpenCode review reconstruction — jq properties', () => {
  test('review == the newline-join of every assistant text part (order preserved)', opts, () => {
    fc.assert(
      fc.property(eventStream, (events) => {
        const expected = events
          .filter((e) => e.type === 'text' && e.part && typeof e.part.text === 'string')
          .map((e) => e.part.text)
          .join('\n');
        assert.equal(runJq(TEXT_PROGRAM, events), expected);
      }),
    );
  });

  test('a stream with no assistant text part reconstructs to empty (drives the #1936 stub)', opts, () => {
    fc.assert(
      fc.property(fc.array(nonTextEvent, { minLength: 1, maxLength: 20 }), (events) => {
        // This is the exact failure the bug describes: the agent runs tool calls
        // and ends with step_finish, emitting no text. Reconstruction must be empty
        // so the content-gate (`[ -n "$OPENCODE_REVIEW" ]`) falls through to the stub.
        assert.equal(runJq(TEXT_PROGRAM, events), '');
      }),
    );
  });

  test('text parts that are null/absent are dropped, never rendered as "null"', opts, () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.record({ type: fc.constant('text'), part: fc.record({ text: fc.constant(null) }) }),
            fc.record({ type: fc.constant('text'), part: fc.record({}) }),
          ),
          { minLength: 1, maxLength: 10 },
        ),
        (events) => {
          const out = runJq(TEXT_PROGRAM, events);
          assert.equal(out, '');
          assert.doesNotMatch(out, /null/);
        },
      ),
    );
  });

  // Diagnostic path (empty-output stub). The finding calls out `missing .tokens.output`
  // and no-step_finish as real edges — pin them with examples against the shipped jq.
  describe('diagnostic reconstruction (stop reason + output tokens)', () => {
    test('reports reason and output tokens from the LAST step_finish', opts, () => {
      const events = [
        { type: 'step_finish', part: { reason: 'tool_calls', tokens: { output: 5 } } },
        { type: 'tool_use', part: {} },
        { type: 'step_finish', part: { reason: 'stop', tokens: { output: 0 } } },
      ];
      assert.equal(runJq(DIAG_PROGRAM, events), 'stop reason=stop, output tokens=0');
    });

    test('missing .tokens.output degrades to "?" rather than null/garbage', opts, () => {
      const events = [{ type: 'step_finish', part: { reason: 'stop', tokens: {} } }];
      assert.equal(runJq(DIAG_PROGRAM, events), 'stop reason=stop, output tokens=?');
    });

    test('no step_finish at all degrades both fields to "?"', opts, () => {
      const events = [{ type: 'tool_use', part: { tool: 'read' } }];
      assert.equal(runJq(DIAG_PROGRAM, events), 'stop reason=?, output tokens=?');
    });
  });

  // The primary reconstruction runs before any content gate; on non-JSON stdout
  // (e.g. an opencode crash that printed a plain-text error) jq must fail rather
  // than emit that text as a "review" — the workflow's `2>/dev/null` + empty
  // capture then routes to the diagnostic stub.
  test('non-JSON stdout does not masquerade as a reconstructed review', opts, () => {
    let threw = false;
    try {
      execFileSync('jq', ['-rs', TEXT_PROGRAM], { input: 'auth token expired\n', encoding: 'utf8' });
    } catch {
      threw = true;
    }
    assert.ok(threw, 'jq must reject non-JSON input so it cannot be captured as a review');
  });
});
