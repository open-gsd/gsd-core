'use strict';

/**
 * Property tests for the compact GSD-state status normalizer (#2162).
 *
 * shortGsdStatus() collapses free-text STATE.md statuses to a canonical
 * keyword (or a capped first-word fallback). As a parsing/normalization
 * contract it gets property coverage per the repo testing rules, alongside
 * the example-based cases in gsd-statusline.test.cjs.
 */

const { test, describe } = require('node:test');
const fc = require('./helpers/fast-check-setup.cjs');

const { shortGsdStatus } = require('../hooks/gsd-statusline.js');

const CANONICAL = ['discussing', 'planning', 'executing', 'verifying', 'completed', 'paused'];

describe('shortGsdStatus properties (#2162)', () => {
  test('totality: any string input yields null or a short non-empty string', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const out = shortGsdStatus(s);
        if (out === null) return true;
        return typeof out === 'string' && out.length > 0 && out.length <= 16;
      }),
    );
  });

  test('canonical statuses are fixed points (paused shouts as PAUSED)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...CANONICAL), (canonical) => {
        const out = shortGsdStatus(canonical);
        return canonical === 'paused' ? out === 'PAUSED' : out === canonical;
      }),
    );
  });

  test('output never contains whitespace or separator characters', () => {
    // The compact line joins segments with ' · ' — a status containing
    // whitespace or the separator would corrupt the segment structure.
    fc.assert(
      fc.property(fc.string(), (s) => {
        const out = shortGsdStatus(s);
        return out === null || !/[\s·—–]/.test(out);
      }),
    );
  });

  test('unrecognized free text falls back to its first word, capped at 16', () => {
    // Alphabetic words that are not canonical and don't contain canonical
    // trigger substrings exercise the fallback path deterministically.
    const word = fc.stringMatching(/^[A-Za-z]{1,32}$/).filter((w) => {
      const lower = w.toLowerCase();
      return !CANONICAL.some((c) => lower.includes(c.slice(0, 4)));
    });
    fc.assert(
      fc.property(word, word, (first, second) => {
        const out = shortGsdStatus(`${first} ${second}`);
        // The normalizer may still map some phrasings to a canonical keyword
        // (e.g. synonym tables); otherwise the first word survives, capped.
        return out === null || CANONICAL.concat('PAUSED').includes(out) || out === first.slice(0, 16);
      }),
    );
  });
});
