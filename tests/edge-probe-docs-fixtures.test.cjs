// allow-test-rule: docs-parity
// Asserts the portable reference doc (gsd-core/references/edge-probe.md) keeps its
// worked-example JSON blocks in sync with the source-of-truth fixture files under
// gsd-core/references/edge-probe-fixtures/. The fixtures are the canonical data; the
// doc embeds copies. Per the CONTRIBUTING.md exception matrix this is `docs-parity`: a
// reference doc must mirror source-defined data and there is no runtime enumeration API.
// The comparison is PARSED JSON (deepEqual of JSON.parse on both sides), never a raw-text
// substring match — so a reformat that preserves the data does not fail, and any semantic
// drift between doc and fixture does.
'use strict';
process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const docPath = path.join(__dirname, '..', 'gsd-core', 'references', 'edge-probe.md');
const fixturesRoot = path.join(__dirname, '..', 'gsd-core', 'references', 'edge-probe-fixtures');

// Extract fenced blocks tagged ```json edge-probe:<dir>/<file> from the doc, keyed by ref.
// The \n? before the closing fence allows blocks whose closing fence has no preceding newline
// (fixes the silent-skip bug where a trailing-fence-with-no-newline was not matched).
function taggedJsonBlocks(md) {
  const re = /```json edge-probe:([^\n]+)\n([\s\S]*?)\n?```/g;
  const out = {};
  let m;
  while ((m = re.exec(md))) out[m[1].trim()] = m[2];
  return out;
}

describe('edge-probe doc/fixture sync', () => {
  test('reference doc exists', () => {
    assert.ok(fs.existsSync(docPath), `${docPath} must exist`);
  });

  test('doc embeds tagged fixture blocks for every expected-coverage.json fixture (count-equality)', () => {
    const md = fs.readFileSync(docPath, 'utf8');
    const blocks = taggedJsonBlocks(md);
    // Count the expected-coverage.json files under the fixtures root (one per fixture dir).
    const expectedCount = fs.readdirSync(fixturesRoot, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .filter(dir => fs.existsSync(path.join(fixturesRoot, dir.name, 'expected-coverage.json')))
      .length;
    assert.strictEqual(
      Object.keys(blocks).length,
      expectedCount,
      `edge-probe.md must embed exactly ${expectedCount} tagged blocks (one per fixture expected-coverage.json)`
    );
  });

  test('every tagged doc block parses and deepEquals its fixture file', () => {
    const md = fs.readFileSync(docPath, 'utf8');
    const blocks = taggedJsonBlocks(md);
    for (const [ref, body] of Object.entries(blocks)) {
      const fixtureFile = path.join(fixturesRoot, ref);
      const onDisk = fs.readFileSync(fixtureFile, 'utf8');
      assert.deepEqual(JSON.parse(body), JSON.parse(onDisk),
        `doc block edge-probe:${ref} must deepEqual ${fixtureFile}`);
    }
  });
});
