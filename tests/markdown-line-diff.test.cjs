/**
 * Line alignment for scoped Markdown normalization — markdown-line-diff.test.cjs
 *
 * #5165: `matchLines` aligns the document being written against the one it
 * replaces; `writeScope` says which line junctions the write left alone. The
 * `.md` write normalizer (shell-command-projection) is the only production
 * consumer, and its tests pin the spacing outcome; these pin the pure contract
 * underneath: a valid longest-common-subsequence alignment, a hard edit-distance
 * cap, and the junction classification.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const { matchLines, writeScope, MAX_SCOPED_EDIT_DISTANCE } = require('../gsd-core/bin/lib/markdown-line-diff.cjs');

/** Length of the longest common subsequence, by the textbook DP (the oracle). */
function lcsLength(a, b) {
  const row = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1]);
      diagonal = above;
    }
  }
  return row[b.length];
}

describe('#5165 matchLines', () => {
  test('identical documents match line for line', () => {
    const doc = ['a', 'b', 'c'];
    assert.deepEqual(Array.from(matchLines(doc, doc)), [0, 1, 2]);
  });

  test('an added line is -1 and the rest keep their prior index', () => {
    assert.deepEqual(Array.from(matchLines(['a', 'c'], ['a', 'b', 'c'])), [0, -1, 1]);
  });

  test('a deleted line leaves a gap in the prior indices', () => {
    assert.deepEqual(Array.from(matchLines(['a', 'b', 'c'], ['a', 'c'])), [0, 2]);
  });

  test('a replaced line is -1', () => {
    assert.deepEqual(Array.from(matchLines(['a', 'b', 'c'], ['a', 'X', 'c'])), [0, -1, 2]);
  });

  test('empty and one-sided documents', () => {
    assert.deepEqual(Array.from(matchLines([], [])), []);
    assert.deepEqual(Array.from(matchLines([], ['a'])), [-1]);
    assert.deepEqual(Array.from(matchLines(['a'], [])), []);
  });

  describe('edit-distance cap (limit-1 / limit / limit+1)', () => {
    // Replacing a line is a delete plus an insert: 2 edits. Replacing every other
    // line keeps the untouched lines from collapsing into the common prefix/suffix.
    const build = (edits) => {
      assert.equal(edits % 2, 0, 'fixture builds whole replacements');
      const prev = Array.from({ length: 1000 }, (_, i) => `Item ${i}`);
      const next = prev.slice();
      for (let r = 0; r < edits / 2; r++) next[r * 2] = `Changed ${r}`;
      return { prev, next };
    };

    test('the cap is 400 edits', () => {
      assert.equal(MAX_SCOPED_EDIT_DISTANCE, 400);
    });

    // Pure insertions cost one edit each, so odd counts reach the cap too.
    for (const [inserted, aligned] of [[399, true], [400, true], [401, false]]) {
      test(`${inserted} inserted lines ${aligned ? 'are aligned' : 'exceed the cap and return null'}`, () => {
        const prev = Array.from({ length: 1000 }, (_, i) => `Item ${i}`);
        const next = [];
        prev.forEach((line, i) => {
          if (i % 2 === 0 && i / 2 < inserted) next.push(`Inserted ${i}`);
          next.push(line);
        });
        const match = matchLines(prev, next);
        if (!aligned) {
          assert.equal(match, null);
          return;
        }
        assert.notEqual(match, null);
        assert.equal(Array.from(match).filter((m) => m < 0).length, inserted);
      });
    }

    for (const [edits, aligned] of [[398, true], [400, true], [402, false]]) {
      test(`${edits} edits ${aligned ? 'are aligned' : 'exceed the cap and return null'}`, () => {
        const { prev, next } = build(edits);
        const match = matchLines(prev, next);
        if (!aligned) {
          assert.equal(match, null);
          return;
        }
        assert.notEqual(match, null);
        assert.equal(Array.from(match).filter((m) => m >= 0).length, next.length - edits / 2);
      });
    }
  });

  // Alphabet kept small so repeated lines (the hard case for any diff) are common.
  const token = fc.constantFrom('', 'a', 'b', 'c', '## h', '- x');
  const doc = fc.array(token, { maxLength: 24 });

  test('property: the alignment is a valid common subsequence and a longest one', () => {
    fc.assert(
      fc.property(doc, doc, (prev, next) => {
        const match = Array.from(matchLines(prev, next));
        assert.equal(match.length, next.length);
        let last = -1;
        let matched = 0;
        match.forEach((m, i) => {
          if (m < 0) return;
          assert.equal(prev[m], next[i], 'a matched line is identical to its counterpart');
          assert.ok(m > last, 'matches are strictly increasing in the prior document');
          last = m;
          matched++;
        });
        assert.equal(matched, lcsLength(prev, next), 'the alignment is as long as an LCS');
      }),
      { seed: 5165, numRuns: 500, endOnFailure: true },
    );
  });
});

describe('#5165 writeScope', () => {
  const scopeOf = (prev, next) => writeScope(matchLines(prev, next), prev.length);

  test('junctions between kept, previously-adjacent lines are kept', () => {
    const scope = scopeOf(['a', 'b', 'c'], ['a', 'b', 'c']);
    assert.equal(scope.junctionKept(0), true);
    assert.equal(scope.junctionKept(1), true);
    assert.equal(scope.lineWritten(0), false);
  });

  test('a deletion between two kept lines makes that junction the write\'s own', () => {
    const scope = scopeOf(['a', 'gone', 'b', 'c'], ['a', 'b', 'c']);
    assert.equal(scope.junctionKept(0), false, 'a and b were not adjacent before');
    assert.equal(scope.junctionKept(1), true, 'b and c were');
  });

  test('a pure insertion owns the junctions on both sides', () => {
    const scope = scopeOf(['a', 'b'], ['a', 'new', 'b']);
    assert.equal(scope.lineWritten(1), true);
    assert.equal(scope.junctionKept(0), false);
    assert.equal(scope.junctionKept(1), false);
  });

  test('an in-place replacement inherits the junctions on both sides', () => {
    const scope = scopeOf(['a', 'old', 'b'], ['a', 'new', 'b']);
    assert.equal(scope.lineWritten(1), true);
    assert.equal(scope.junctionKept(0), true);
    assert.equal(scope.junctionKept(1), true);
  });

  test('a replaced line reports the prior line it replaced; an added line reports none', () => {
    const replaced = scopeOf(['a', 'old', 'b'], ['a', 'new', 'b']);
    assert.equal(replaced.replacedPriorIndex(1), 1);
    assert.equal(replaced.replacedPriorIndex(0), -1, 'a kept line replaced nothing');
    const added = scopeOf(['a', 'b'], ['a', 'new', 'b']);
    assert.equal(added.replacedPriorIndex(1), -1);
    const longer = scopeOf(['a', 'old', 'b'], ['a', 'new1', 'new2', 'b']);
    assert.equal(longer.replacedPriorIndex(1), 1);
    assert.equal(longer.replacedPriorIndex(2), -1, 'the extra written line replaced nothing');
  });

  test('a junction inside added text is the write\'s own', () => {
    const scope = scopeOf(['a'], ['a', 'x', 'y']);
    assert.equal(scope.junctionKept(1), false);
  });
});
