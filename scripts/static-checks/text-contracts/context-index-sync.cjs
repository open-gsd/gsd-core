'use strict';

// docs/CONTEXT-INDEX.json is a committed generated artifact: it must match a fresh parse of CONTEXT.md, predicate by
// predicate (#2944: a concurrent-merge race landed one PR's CONTEXT.md beside another PR's index, each green alone and
// red together). A divergence names the exact predicate id (present on one side only, a diverged value, a diverged
// klass), then the predicate count and the class-count map are compared. The parse uses the shipped parser
// (gsd-core/bin/lib/context-predicates.cjs), as the test did; the test's second case, a mutated copy of the index that
// the detector must name, is the mutation rows of tests/text-contracts.batch9.test.cjs. Was tests/context-index-sync.test.cjs.

const { isDeepStrictEqual } = require('node:util');
const path = require('node:path');

const CONTEXT = 'CONTEXT.md';
const INDEX = 'docs/CONTEXT-INDEX.json';

const isMapping = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Divergences between two `{id, klass, value}` lists, by id, each naming the exact predicate.
function diffPredicatesById(leftPredicates, rightPredicates, leftLabel, rightLabel) {
  const left = new Map(leftPredicates.map((predicate) => [predicate.id, predicate]));
  const right = new Map(rightPredicates.map((predicate) => [predicate.id, predicate]));
  const diffs = [];
  for (const id of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const l = left.get(id);
    const r = right.get(id);
    if (l && !r) diffs.push(`${id}: present in ${leftLabel} but absent from ${rightLabel}`);
    else if (!l && r) diffs.push(`${id}: present in ${rightLabel} but absent from ${leftLabel}`);
    else if (l.value !== r.value) diffs.push(`${id}: value diverged (${leftLabel}=${JSON.stringify(l.value)}, ${rightLabel}=${JSON.stringify(r.value)})`);
    else if (l.klass !== r.klass) diffs.push(`${id}: klass diverged (${leftLabel}=${JSON.stringify(l.klass)}, ${rightLabel}=${JSON.stringify(r.klass)})`);
  }
  return diffs;
}

module.exports = {
  id: 'context-index-sync',
  issue: '#2944',
  check(ctx) {
    const markdown = ctx.doc(CONTEXT);
    const index = ctx.doc(INDEX);
    // The fresh parse, computed once; a parser fault is a finding, not a throw.
    let fresh = null;
    let parseError = null;
    markdown.satisfies((text) => {
      try {
        const { parsePredicates, buildIndex } = require(path.join(__dirname, '..', '..', '..', 'gsd-core', 'bin', 'lib', 'context-predicates.cjs'));
        fresh = buildIndex(parsePredicates(text).predicates);
      } catch (err) {
        parseError = `the CONTEXT.md parse failed: ${err.message}`;
        return parseError;
      }
      return true;
    }, 'CONTEXT.md must parse');

    const committedOf = (text) => {
      let committed;
      try {
        committed = JSON.parse(text);
      } catch (err) {
        return { error: `not valid JSON: ${err.message}` };
      }
      if (!isMapping(committed) || !Array.isArray(committed.predicates) || !committed.predicates.every((p) => isMapping(p) && typeof p.id === 'string')) {
        return { error: 'the index has no predicates list of {id, klass, value} entries' };
      }
      return { committed };
    };
    const againstFresh = (check) => (text) => {
      if (fresh === null) return parseError || 'no fresh parse to compare with';
      if (!isMapping(fresh) || !Array.isArray(fresh.predicates)) return 'the fresh CONTEXT.md parse has no predicates list';
      const { committed, error } = committedOf(text);
      return error || check(committed);
    };

    index
      .satisfies(againstFresh((committed) => {
        const diffs = diffPredicatesById(committed.predicates, fresh.predicates, 'committed docs/CONTEXT-INDEX.json', 'fresh CONTEXT.md parse');
        return diffs.length === 0 || diffs.join('; ');
      }), 'docs/CONTEXT-INDEX.json must match a fresh parse of CONTEXT.md, predicate by predicate (run `node scripts/gen-context-index.cjs --write` to refresh)')
      .satisfies(againstFresh((committed) => committed.count === fresh.count || `committed=${committed.count} fresh=${fresh.count}`),
        'the predicate count must match between the committed index and the fresh parse')
      .satisfies(againstFresh((committed) => isDeepStrictEqual(committed.classes, fresh.classes)
        || `committed=${JSON.stringify(committed.classes)} fresh=${JSON.stringify(fresh.classes)}`),
      'the class-count map must match between the committed index and the fresh parse');
  },
};
