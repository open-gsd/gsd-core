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

  test('draft PR sweep enforces the same policy as the event-driven close', () => {
    const workflow = readWorkflow('.github/workflows/close-draft-prs-sweep.yml');

    // Timer-driven in base-repo context, plus a manual dispatch for testing.
    // It must NOT be a fork-triggered event (no pull_request / pull_request_target trigger).
    assert.match(workflow, /schedule:/);
    assert.match(workflow, /cron:\s*'0 \*\/6 \* \* \*'/);
    assert.match(workflow, /workflow_dispatch:/);
    assert.doesNotMatch(workflow, /^\s*pull_request(_target)?:/m);

    // Write-capable token (needed to close PRs from base context). Tolerant of
    // intervening blank lines or additional permission keys.
    assert.match(workflow, /permissions:\s+pull-requests:\s*write/);

    // Identical maintainer carve-out to close-draft-prs.yml — a Set membership
    // test over author_association, negated (no github.event.pull_request in a
    // scheduled run).
    assert.match(workflow, /new Set\(\['OWNER', 'MEMBER', 'COLLABORATOR'\]\)/);
    assert.match(workflow, /!MAINTAINER_ASSOCIATIONS\.has\([^)]*\.author_association\)/);

    // Paginates over open PRs and filters to drafts.
    assert.match(workflow, /github\.paginate\(github\.rest\.pulls\.list/);
    assert.match(workflow, /state:\s*'open'/);
    assert.match(workflow, /pr\.draft === true/);

    // Same user-facing policy message as close-draft-prs.yml (locks the core
    // content so the sweep cannot silently drift to a weaker message).
    assert.match(workflow, /## Draft PRs are not accepted/);
    assert.match(workflow, /npm run test:coverage/);
    assert.match(workflow, /CONTRIBUTING\.md#pull-request-guidelines/);
  });
});
