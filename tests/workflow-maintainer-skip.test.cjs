// allow-test-rule: source-text-is-the-product
// These workflow files are deployed policy; the tests lock the maintainer
// carve-out so future edits do not accidentally re-enable enforcement.
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAINTAINER_SKIP_EXPR = 'contains(fromJSON(\'["OWNER","MEMBER","COLLABORATOR"]\'), github.event.pull_request.author_association) == false';

function readWorkflow(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function assertMaintainerSkip(source) {
  assert.ok(
    source.includes(MAINTAINER_SKIP_EXPR),
    `Expected workflow to include maintainer skip expression: ${MAINTAINER_SKIP_EXPR}`
  );
}

describe('PR policy workflow maintainer carve-outs', () => {
  test('draft PR auto-close does not run for maintainer-authored PRs', () => {
    const workflow = readWorkflow('.github/workflows/close-draft-prs.yml');

    assert.match(workflow, /github\.event\.pull_request\.draft == true/);
    assertMaintainerSkip(workflow);
  });

  test('PR target validator does not run for maintainer-authored PRs', () => {
    const workflow = readWorkflow('.github/workflows/pr-target-validator.yml');

    assertMaintainerSkip(workflow);
  });
});
