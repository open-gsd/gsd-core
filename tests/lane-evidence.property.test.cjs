'use strict';

// #5019: one grammar for the persisted lane-evidence state, `<suffix>\n<auto|once>\n<block>` with
// suffix ^[A-Za-z0-9]{6}$. The property: persist accepts a suffix iff that regex matches it, the
// round trip returns any block unchanged, and the state key depends only on the resolved path.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { persistLaneEvidence, readLaneEvidence, laneStatePath } = require('../gsd-core/bin/lib/lane-evidence.cjs');

const SUFFIX_RE = /^[A-Za-z0-9]{6}$/;
const runs = { numRuns: 60 }; // every sample touches disk

const sandbox = require('./helpers/lane-sandbox.cjs');

describe('#5019 lane-evidence grammar (property)', () => {
  test('accepts iff ^[A-Za-z0-9]{6}$ (limit-1/limit/limit+1)', (t) => {
    const sb = sandbox(t);
    const near = fc.string({ unit: fc.constantFrom(...'aZ09\r\n /.é-_'), minLength: 5, maxLength: 7 });
    const alnum = fc.string({ unit: fc.constantFrom(...'aZ09bY'), minLength: 5, maxLength: 7 });
    fc.assert(fc.property(fc.oneof(near, alnum), fc.constantFrom('auto', 'once'), (suffix, mode) => {
      let accepted = true;
      try { persistLaneEvidence(sb.review, suffix, mode, 'b', sb.tmp); } catch (e) {
        assert.match(String(e.message), /Usage: lane-evidence-persist/);
        accepted = false;
      }
      assert.strictEqual(accepted, SUFFIX_RE.test(suffix), JSON.stringify(suffix));
      return true;
    }), runs);
  });

  test('accepts a mode iff ^(auto|once)$, including hostile multi-line values', (t) => {
    const sb = sandbox(t);
    const hostile = fc.string({ unit: fc.constantFrom(...'aunceto\r\nX '), minLength: 0, maxLength: 12 });
    fc.assert(fc.property(fc.oneof(hostile, fc.constantFrom('auto', 'once', 'auto\nX', 'once\n')), (mode) => {
      let accepted = true;
      try { persistLaneEvidence(sb.review, 'abc123', mode, 'b', sb.tmp); } catch (e) {
        assert.match(String(e.message), /Usage: lane-evidence-persist/);
        accepted = false;
      }
      assert.strictEqual(accepted, /^(auto|once)$/.test(mode), JSON.stringify(mode));
      return true;
    }), runs);
  });

  test('round trip for any block incl. CR/LF', (t) => {
    const sb = sandbox(t);
    fs.mkdirSync(path.join(sb.tmp, 'gsd-review-lanes-abc123'));
    const block = fc.string({ unit: fc.constantFrom(...'aZ \r\n\t<>é'), minLength: 1, maxLength: 40 });
    fc.assert(fc.property(block, (b) => {
      persistLaneEvidence(sb.review, 'abc123', 'auto', b, sb.tmp);
      assert.strictEqual(readLaneEvidence(sb.review, sb.tmp), `${b}\n\n`);
      return true;
    }), runs);
  });

  test('key stable under ./ and // variants, distinct for distinct paths', () => {
    const seg = fc.string({ unit: fc.constantFrom(...'abc01'), minLength: 1, maxLength: 4 });
    fc.assert(fc.property(fc.array(seg, { minLength: 1, maxLength: 4 }), seg, (segs, other) => {
      const base = `/p/${segs.join('/')}/01-REVIEW.md`;
      const key = laneStatePath(base, '/t');
      assert.strictEqual(laneStatePath(`/p/./${segs.join('//')}/./01-REVIEW.md`, '/t'), key);
      assert.notStrictEqual(laneStatePath(`/p/${segs.join('/')}/${other}x-REVIEW.md`, '/t'), key);
      return true;
    }), runs);
  });
});
