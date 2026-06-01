// allow-test-rule: source-text-is-the-product
// Tests that every GSD workflow that spawns a subagent carries the liveness phrase
// "runs in a subagent" so users know silence during a subagent run is expected.
// Canonical phrase defined in get-shit-done/references/ui-brand.md § Spawning Indicators.
// Regression test for https://github.com/open-gsd/gsd-core/issues/558.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'get-shit-done', 'workflows');

function findMdFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findMdFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(full);
    }
  }
  return files;
}

describe('spawn-liveness-banner', () => {
  test('every workflow that spawns a subagent carries the liveness phrase "runs in a subagent"', () => {
    const SPAWN_MARKER = 'subagent_type';
    const LIVENESS_PHRASE = 'runs in a subagent';

    const mdFiles = findMdFiles(WORKFLOWS_DIR);
    const violations = mdFiles
      .filter(f => {
        const content = fs.readFileSync(f, 'utf-8');
        return content.includes(SPAWN_MARKER) && !content.includes(LIVENESS_PHRASE);
      })
      .map(f => path.relative(WORKFLOWS_DIR, f));

    assert.deepStrictEqual(
      violations,
      [],
      `The following workflow files contain "subagent_type" but are missing the liveness phrase "${LIVENESS_PHRASE}":\n` +
        violations.map(f => `  - ${f}`).join('\n') +
        '\n\nPer get-shit-done/references/ui-brand.md § "Spawning Indicators":\n' +
        'every spawn announcement must carry "runs in a subagent" so users know\n' +
        'that silence during a subagent run is expected and do not kill a healthy agent.\n' +
        'See https://github.com/open-gsd/gsd-core/issues/558'
    );
  });
});
