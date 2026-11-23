'use strict';

// The portable reference doc (gsd-core/references/prohibition-probe.md) keeps its worked-example JSON blocks in sync
// with the source-of-truth fixtures under gsd-core/references/prohibition-probe-fixtures/: one tagged
// ```json prohibition-probe:<dir>/<file>``` block per fixture expected.json, each deep-equal to its fixture file. The
// comparison is on PARSED JSON, never raw text, so a reformat that preserves the data does not fail. A tag names the
// fixture as `<dir>/<file>` of plain characters; a tag that names anything else is a finding, never a path read.
// Was tests/prohibition-probe.docs-fixtures.test.cjs.

const { isDeepStrictEqual } = require('node:util');
const path = require('node:path');

const DOC = 'gsd-core/references/prohibition-probe.md';
const FIXTURES = 'gsd-core/references/prohibition-probe-fixtures';
const TAG = /^json prohibition-probe:([^\r\n]{1,500})$/;
const PLAIN_REF = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const isDotSegment = (segment) => segment === '.' || segment === '..';

// The tagged fenced blocks of the doc, keyed by ref; the fence rules have one owner (the markdown sectionizer).
function taggedJsonBlocks(markdown) {
  const { scanFencedBlocks } = require(path.join(__dirname, '..', '..', '..', 'gsd-core', 'bin', 'lib', 'markdown-sectionizer.cjs'));
  const lines = markdown.split('\n');
  const out = {};
  for (const block of scanFencedBlocks(lines)) {
    if (block.closeLineIdx === -1) continue;
    const tag = TAG.exec(block.infoString || '');
    if (!tag) continue;
    out[tag[1].trim()] = lines.slice(block.openLineIdx + 1, block.closeLineIdx).join('\n');
  }
  return out;
}

module.exports = {
  id: 'prohibition-probe.docs-fixtures',
  issue: '#644',
  check(ctx) {
    const doc = ctx.doc(DOC);
    const blocks = taggedJsonBlocks(doc.text);

    // Fixture directories (directly under the fixtures root) that carry an expected.json.
    const expected = ctx.list(FIXTURES, 'expected.json', 'the fixtures are what the doc blocks are checked against')
      .filter((rel) => rel.endsWith('/expected.json') && rel.split('/').length === FIXTURES.split('/').length + 2);
    doc.satisfies(() => Object.keys(blocks).length === expected.length
      || `the doc embeds ${Object.keys(blocks).length} tagged blocks, the fixtures carry ${expected.length}`,
    'the doc must embed one tagged fixture block for every expected.json fixture (count equality)');

    for (const [ref, body] of Object.entries(blocks)) {
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
      }, `the doc block prohibition-probe:${ref} must parse and deep-equal its fixture file`);
    }
  },
};
