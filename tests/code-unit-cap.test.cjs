'use strict';

/**
 * Behaviour of the shared surrogate-safe UTF-16 cap (#5639).
 *
 * `capCodeUnits` in `src/code-unit-cap.cts` serves `prefixedCap` (gate-predicate-evaluator),
 * the Pi description cap (runtime-artifact-conversion) and the raw-status token cut (verification).
 * Caller behaviour is covered by tests/verification-status.test.cjs, tests/pi-workflow-handoff.test.cjs
 * and tests/install-runtime-artifacts.test.cjs.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const { capCodeUnits } = require('../gsd-core/bin/lib/code-unit-cap.cjs');

const isLoneSurrogateFree = (s) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

describe('capCodeUnits', () => {
  test('keeps text that fits, whole', () => {
    assert.equal(capCodeUnits('abc', 3, 'head'), 'abc');
    assert.equal(capCodeUnits('abc', 3, 'tail'), 'abc');
  });

  test('cuts one unit below and above the budget', () => {
    assert.equal(capCodeUnits('ab', 3, 'head'), 'ab');
    assert.equal(capCodeUnits('ab', 3, 'tail'), 'ab');
    assert.equal(capCodeUnits('abc', 2, 'head'), 'ab');
    assert.equal(capCodeUnits('abc', 2, 'tail'), 'bc');
  });

  test('a non-positive budget keeps nothing', () => {
    assert.equal(capCodeUnits('abc', 0, 'head'), '');
    assert.equal(capCodeUnits('abc', 0, 'tail'), '');
    assert.equal(capCodeUnits('abc', -4, 'tail'), '');
  });

  test('head cut drops the orphaned high surrogate', () => {
    assert.equal(capCodeUnits('a\u{1F600}b', 2, 'head'), 'a');
  });

  test('tail cut drops the orphaned low surrogate', () => {
    assert.equal(capCodeUnits('a\u{1F600}b', 2, 'tail'), 'b');
  });

  test('property: within budget, a suffix or prefix of the input, no lone surrogate', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.string({ maxLength: 1 }), fc.constant('\u{1F600}')), { maxLength: 30 }).map((a) => a.join('')),
        fc.integer({ min: -2, max: 40 }),
        fc.constantFrom('head', 'tail'),
        (text, max, keep) => {
          const out = capCodeUnits(text, max, keep);
          assert.ok(out.length <= Math.max(0, max));
          // A cut drops at most one orphaned surrogate half, so an empty result for a cut input fails.
          assert.ok(out.length >= Math.min(max, text.length) - 1);
          assert.ok(keep === 'head' ? text.startsWith(out) : text.endsWith(out));
          if (isLoneSurrogateFree(text)) assert.ok(isLoneSurrogateFree(out));
        },
      ),
    );
  });
});

// One parity test (#5593 "Related sites"): each caller, fed text whose cut lands inside a surrogate
// pair, returns what `capCodeUnits` returns. A caller that goes back to an inline cut fails here.
describe('callers of capCodeUnits agree with it at a surrogate boundary', () => {
  const { evaluatePredicate, COMMAND_MAX_OUTPUT_CHARS } = require('../gsd-core/bin/lib/gate-predicate-evaluator.cjs');
  const { convertClaudeCommandToPiSkill } = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');
  const { VerificationStatusError } = require('../gsd-core/bin/lib/verification.cjs');
  const { formatDiagnosticToken } = require('../gsd-core/bin/lib/io.cjs');
  const EMOJI = '\u{1F600}';
  // Pi's skill description cap and the raw-status token cap are private constants of their modules
  // (tests/pi-workflow-handoff.test.cjs and tests/verification-status.test.cjs pin the same numbers).
  const PI_DESCRIPTION_MAX = 1024;
  const RAW_STATUS_TOKEN_LIMIT = 120;

  test('prefixedCap (gate message): the tail cut starts inside a pair', () => {
    const prefix = 'command exited 1: ';
    const budget = COMMAND_MAX_OUTPUT_CHARS - prefix.length;
    const stderr = EMOJI + 'b'.repeat(budget - 1);
    const res = evaluatePredicate(
      { kind: 'command-exit-zero', command: 'x' },
      { cwd: '/proj' },
      { runBoundedShell: () => ({ exitCode: 1, stdout: '', stderr, signal: null, timedOut: false }) },
    );
    assert.equal(res.message, prefix + capCodeUnits(stderr, budget, 'tail'));
    assert.notEqual(res.message, prefix + stderr.slice(-budget), 'the plain cut would leave a lone low surrogate');
  });

  test('Pi description cap: the head cut ends inside a pair', () => {
    const description = `${'a'.repeat(PI_DESCRIPTION_MAX - 1)}${EMOJI}tail`;
    const skill = convertClaudeCommandToPiSkill(`---\nname: gsd:x\ndescription: ${description}\n---\nbody\n`, 'gsd-x', 'pi', ['x']);
    const line = skill.split(/\r?\n/).find((l) => l.startsWith('description: '));
    assert.equal(JSON.parse(line.slice('description: '.length)), capCodeUnits(description, PI_DESCRIPTION_MAX, 'head'));
  });

  test('raw-status token cap: the head cut ends inside a pair', () => {
    const raw = `${'a'.repeat(RAW_STATUS_TOKEN_LIMIT - 2)}${EMOJI}tail`;
    const rendered = formatDiagnosticToken(raw);
    const kept = capCodeUnits(rendered, RAW_STATUS_TOKEN_LIMIT, 'head');
    assert.equal(kept.length, RAW_STATUS_TOKEN_LIMIT - 1, 'the pair straddles the limit, so its high half goes');
    const { message } = new VerificationStatusError(raw, '/p/01-VERIFICATION.md');
    assert.ok(message.includes(`${kept}…(${rendered.length - kept.length} more)`));
  });
});
