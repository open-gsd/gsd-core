// allow-test-rule: source-text-is-the-product (see #2279)
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

// The pre-fix framing: substitute-the-placeholder-only, which never fires on an
// Update run because the placeholder was already replaced by a concrete date.
const STALE_PLACEHOLDER_ONLY = /Use \{date\} for all \[YYYY-MM-DD\] date placeholders/;

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

  test('no date-instruction site retains the placeholder-only framing', () => {
    // Every site must carry the overwrite instruction: the per-spawn Agent()
    // prompts in spawn_agents (the primary path) regressed independently of
    // the sequential_mapping fallback, so a whole-file "fix appears somewhere"
    // match is not enough.
    assert.doesNotMatch(
      MAPPER,
      STALE_PLACEHOLDER_ONLY,
      'gsd-codebase-mapper.md still contains a placeholder-only date instruction',
    );
    assert.doesNotMatch(
      WORKFLOW,
      STALE_PLACEHOLDER_ONLY,
      'map-codebase.md still contains a placeholder-only date instruction',
    );
    const overwriteSites = WORKFLOW.match(/OVERWRIT(E|ING) any existing date/gi) ?? [];
    assert.ok(
      overwriteSites.length >= 5,
      `expected the overwrite instruction at every date-instruction site in map-codebase.md (4 per-spawn prompts + the sequential fallback), found ${overwriteSites.length}`,
    );
  });
});
