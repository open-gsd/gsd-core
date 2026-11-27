'use strict';

// The portable reference doc (gsd-core/references/edge-probe.md) keeps its worked-example JSON blocks in sync with
// the source-of-truth fixtures under gsd-core/references/edge-probe-fixtures/: one tagged ```json edge-probe:<dir>/<file>```
// block per fixture expected-coverage.json, each deep-equal to its fixture file. The comparison is on PARSED JSON,
// never raw text, so a reformat that preserves the data does not fail. A tag names the fixture as `<dir>/<file>` of
// plain characters; a tag that names anything else is a finding, never a path read. The machine-to-SPEC vocabulary
// mapping (ADR-550 Decision 7a) is grounded in the ADR, the SPEC template legend and the reference mapping table.
// The test's four-entry bijection check ran on a table literal defined in the test, not on repo text, and is not
// carried over. Was tests/edge-probe-docs-fixtures.test.cjs.

const { isDeepStrictEqual } = require('node:util');
const path = require('node:path');

const DOC = 'gsd-core/references/edge-probe.md';
const FIXTURES = 'gsd-core/references/edge-probe-fixtures';
const ADR = 'docs/adr/550-spec-phase-probe-contract.md';
const SPEC_TEMPLATE = 'gsd-core/templates/spec.md';
const TAG_PREFIX = 'json edge-probe:';
const PLAIN_REF = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const isDotSegment = (segment) => segment === '.' || segment === '..';

// The tagged fenced blocks of the doc as [ref, body] pairs in document order (a list, so a ref such as __proto__ or a repeated ref is never lost); the fence rules have one owner (the markdown sectionizer).
function taggedJsonBlocks(markdown) {
  const { scanFencedBlocks } = require(path.join(__dirname, '..', '..', '..', 'gsd-core', 'bin', 'lib', 'markdown-sectionizer.cjs'));
  const lines = markdown.split('\n');
  const out = [];
  for (const block of scanFencedBlocks(lines)) {
    if (block.closeLineIdx === -1) continue;
    const info = block.infoString || '';
    if (!info.startsWith(TAG_PREFIX)) continue;
    out.push([info.slice(TAG_PREFIX.length).trim(), lines.slice(block.openLineIdx + 1, block.closeLineIdx).join('\n')]);
  }
  return out;
}

module.exports = {
  id: 'edge-probe-docs-fixtures',
  issue: '#550',
  check(ctx) {
    ctx.exists(DOC, 'the edge-probe reference doc must exist');
    const doc = ctx.doc(DOC);
    const blocks = taggedJsonBlocks(doc.text);

    // Fixture directories (directly under the fixtures root) that carry an expected-coverage.json.
    const expected = ctx.list(FIXTURES, 'expected-coverage.json', 'the fixtures are what the doc blocks are checked against')
      .filter((rel) => rel.endsWith('/expected-coverage.json') && rel.split('/').length === FIXTURES.split('/').length + 2);
    doc.satisfies(() => blocks.length === expected.length
      || `the doc embeds ${blocks.length} tagged blocks, the fixtures carry ${expected.length}`,
    'the doc must embed one tagged fixture block for every expected-coverage.json fixture (count equality)');
    // The set of tagged refs must be the set of fixtures: a retagged block keeps the count but leaves a fixture unchecked.
    const expectedRefs = new Set(expected.map((rel) => rel.slice(FIXTURES.length + 1)));
    const taggedRefs = new Set(blocks.map(([ref]) => ref));
    for (const ref of expectedRefs) {
      if (!taggedRefs.has(ref)) ctx.fail(DOC, `no tagged block embeds the fixture "${ref}"`);
    }
    for (const ref of taggedRefs) {
      if (!expectedRefs.has(ref)) ctx.fail(DOC, `the tag "${ref}" names no expected-coverage.json fixture`);
    }

    const seen = new Set();
    for (const [ref, body] of blocks) {
      if (seen.has(ref)) {
        ctx.fail(DOC, `the tag "${ref}" is used by more than one block, so the earlier block would never be compared`);
        continue;
      }
      seen.add(ref);
      if (!PLAIN_REF.test(ref) || ref.split('/').some(isDotSegment)) {
        ctx.fail(DOC, `a tagged block names "${ref}", which is not a plain <dir>/<file> fixture reference`);
        continue;
      }
      ctx.doc(`${FIXTURES}/${ref}`).satisfies((fixtureText) => {
        let fromDoc;
        let fromDisk;
        try {
          fromDoc = JSON.parse(body);
          fromDisk = JSON.parse(fixtureText);
        } catch (err) {
          return `not valid JSON: ${err.message}`;
        }
        return isDeepStrictEqual(fromDoc, fromDisk) || 'the doc block differs from the fixture';
      }, `the doc block edge-probe:${ref} must parse and deep-equal its fixture file`);
    }

    ctx.doc(ADR)
      .has(/covered\b[^.]{0,500}resolved[^.]{0,500}explicit/i, 'the ADR must document covered -> {resolved, explicit}')
      .has(/backstop\b[^.]{0,500}resolved[^.]{0,500}backstop/i, 'the ADR must document backstop -> {resolved, backstop}')
      .has(/count-for-count|count-preserved/i, 'the ADR must state coverage.resolved is count-preserved across the migration');

    ctx.doc(SPEC_TEMPLATE)
      .has(/\bcovered\b/i, 'the spec.md Edge Coverage legend must render the "covered" label')
      .has(/\bbackstop\b/i, 'the spec.md Edge Coverage legend must render the "backstop" label')
      .has(/\bdismissed\b/i, 'the spec.md Edge Coverage legend must render the "dismissed" label')
      .has(/\bunresolved\b/i, 'the spec.md Edge Coverage legend must render the "unresolved" label');

    doc
      .has(/resolved`?\/`?explicit/i, 'the reference must name the resolved/explicit tier in the mapping table')
      .has(/resolved`?\/`?backstop/i, 'the reference must name the resolved/backstop tier in the mapping table');
  },
};
