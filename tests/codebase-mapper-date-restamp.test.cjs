// allow-test-rule: source-text-is-the-product
// The gsd-codebase-mapper agent and map-codebase workflow .md files ARE the
// contract the model loads at runtime. Regression lock for #2279: on an Update
// run the agent must restamp the codebase-doc dates unconditionally, not merely
// substitute the [YYYY-MM-DD] placeholder (absent once a doc holds a real date).

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MAPPER = fs.readFileSync(path.join(ROOT, 'agents', 'gsd-codebase-mapper.md'), 'utf-8');
const WORKFLOW = fs.readFileSync(path.join(ROOT, 'gsd-core', 'workflows', 'map-codebase.md'), 'utf-8');

describe('map-codebase date restamp (#2279)', () => {
  test('mapper instructs overwriting an existing date on update runs', () => {
    assert.match(
      MAPPER,
      /overwrite the old date|already exists with a concrete date/i,
      'gsd-codebase-mapper.md must tell the agent to overwrite a prior concrete date, not only fill [YYYY-MM-DD]',
    );
  });

  test('workflow reminder requires overwriting an existing date', () => {
    assert.match(
      WORKFLOW,
      /overwrite any existing date/i,
      'map-codebase.md must instruct overwriting an existing date, not only [YYYY-MM-DD] placeholders',
    );
  });
});
