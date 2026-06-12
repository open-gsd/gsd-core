// allow-test-rule: source-text-is-the-product
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MANUAL_PATH = path.join(ROOT, 'docs', 'how-to', 'develop-a-capability.md');
const DOCS_README_PATH = path.join(ROOT, 'docs', 'README.md');

function readManual() {
  return fs.readFileSync(MANUAL_PATH, 'utf8');
}

describe('ADR-857 phase 6 capability documentation', () => {
  test('Capability developer manual exists', () => {
    assert.ok(fs.existsSync(MANUAL_PATH), 'docs/how-to/develop-a-capability.md must exist');
  });

  test('docs index links the Capability developer manual', () => {
    const readme = fs.readFileSync(DOCS_README_PATH, 'utf8');
    assert.match(readme, /how-to\/develop-a-capability\.md/);
  });

  test('manual uses ADR-857 terminology and names plugin as packaging only', () => {
    const manual = readManual();
    assert.match(manual, /Capability/);
    assert.match(manual, /ADR-857/);
    assert.match(manual, /plugin is a packaging or host-runtime term/i);
  });

  test('manual documents the GSD 1.5 capability development loop', () => {
    const manual = readManual();
    assert.match(manual, /GSD 1\.5/);
    assert.match(manual, /capabilities\/<id>\/capability\.json/);
    assert.match(manual, /node scripts\/gen-capability-registry\.cjs --write/);
    assert.match(manual, /node scripts\/gen-capability-registry\.cjs --check/);
  });

  test('manual documents plan:pre hook fragments and render-hooks verification', () => {
    const manual = readManual();
    assert.match(manual, /plan:pre/);
    assert.match(manual, /fragment\.path/);
    assert.match(manual, /fragment\.inline/);
    assert.match(manual, /gsd-tools loop render-hooks plan:pre/);
  });

  test('manual documents phase 6 planning capability cutovers', () => {
    const manual = readManual();
    assert.match(manual, /research/);
    assert.match(manual, /ai-integration/);
    assert.match(manual, /pattern-mapper/);
  });
});
