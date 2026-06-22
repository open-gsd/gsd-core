/**
 * Deterministic property-style parser tests (#3594).
 *
 * Follows TEST-EXAMPLES.md §"Deterministic Property-Style Parser Test":
 * a bounded, seeded loop generates many malformed inputs and asserts a
 * single invariant against each. On failure the seed and case index
 * are printed so the failing input can be reproduced exactly.
 *
 * The generator is a small mulberry32 PRNG so this file has zero
 * external dependencies and is fully reproducible across Node versions.
 * Each test pins its own seed and case count; bumping either is a
 * deliberate test change, not a flake source.
 *
 * Invariant tested (frontmatter): for any random text the parser must
 * either return a plain object or throw — never return null/undefined,
 * never hang, never propagate "Cannot read properties of …" V8 prose.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { extractFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');

/**
 * mulberry32 — small fast deterministic PRNG. Seed in, [0,1) out.
 * Same input always produces the same sequence across Node versions.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a single malformed-ish frontmatter input. Components are mixed
 * deterministically by the supplied PRNG.
 */
function makeInput(rng) {
  const fragments = [
    '---\n',
    'title: Generated\n',
    'phase: 99\n',
    'plans:\n  - a\n  - b\n',
    'extra: \xff\xfe\xfd\n',          // invalid UTF-8 bytes
    'unicode: 日本語\n',
    'crlf: ends\r\nin\rcr\n',
    '   indented_key: value\n',
    'duplicate: first\nduplicate: second\n',
    'sparse:\n\n\n',
    'malformed_array: [a, "b", c\n',  // unclosed inline array
    'null_byte: before\x00after\n',
  ];
  // Pick a random subset of fragments in random order. Always include
  // the opening `---`. Closing `---` is included by 50% of cases so we
  // exercise both well-formed and unclosed shapes.
  const head = fragments[0];
  const rest = shuffle(fragments.slice(1), rng).slice(0, 1 + Math.floor(rng() * 6));
  const closing = rng() < 0.5 ? '---\n' : '';
  return head + rest.join('') + closing + '\nBody.\n';
}

/**
 * Fisher-Yates shuffle driven by the supplied PRNG. Returns a new
 * array; does not mutate the input. Replaces the previous
 * `arr.sort(() => rng() - 0.5)` which was non-transitive — the
 * resulting order depended on V8's sort implementation, not only on
 * the seed, so failing cases were unreproducible across Node versions.
 * Fisher-Yates is O(n), transitive (no comparator), and depends only
 * on the RNG output. Codex review on PR #3633 / #3594.
 */
function shuffle(arr, rng) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

test('extractFrontmatter is total over 500 deterministic random inputs (seed=1234)', () => {
  const seed = 1234;
  const rng = mulberry32(seed);
  const count = 500;
  for (let i = 0; i < count; i++) {
    const input = makeInput(rng);
    let result;
    try {
      result = extractFrontmatter(input);
    } catch (err) {
      // If the parser throws, the failure must be a controlled one —
      // not a V8 "Cannot read properties of undefined" that signals a
      // null-deref bug. Print the seed and case index so the input
      // can be reproduced exactly.
      const msg = String((err && err.message) || err);
      assert.doesNotMatch(
        msg,
        /Cannot read propert/i,
        `seed=${seed} case=${i}: parser must not propagate null-deref TypeError; input=${JSON.stringify(input)}`,
      );
      continue;
    }
    // No throw: result MUST be a plain object (not null, not array, not
    // primitive). Print enough on failure to reproduce.
    assert.equal(typeof result, 'object', `seed=${seed} case=${i}: result must be object, got ${typeof result}`);
    assert.notEqual(result, null, `seed=${seed} case=${i}: result must not be null`);
    assert.equal(Array.isArray(result), false, `seed=${seed} case=${i}: result must not be an array`);
  }
});

test('extractFrontmatter handles large frontmatter blocks without body bleed', () => {
  // Deterministic large-input coverage replaces the former wall-clock ratio
  // guard. Timing assertions are host-sensitive; this pins the parser contract
  // instead: parse every frontmatter line once and stop at the first closing
  // delimiter before the body.

  /** Build a frontmatter string with exactly `lineCount` key:value lines. */
  function buildScaleInput(lineCount) {
    let s = '---\n';
    for (let i = 0; i < lineCount; i++) {
      s += `key${i}: value${i}\n`;
    }
    return s + '---\nBody.\n';
  }

  for (const lineCount of [20, 200, 2000]) {
    const result = extractFrontmatter(buildScaleInput(lineCount) + 'body_key: not-frontmatter\n');
    assert.equal(Object.keys(result).length, lineCount);
    assert.equal(result.key0, 'value0');
    assert.equal(result[`key${lineCount - 1}`], `value${lineCount - 1}`);
    assert.equal(result.body_key, undefined);
  }
});
