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

  test('draft PR auto-close triggers on pull_request_target so fork PRs cannot bypass it', () => {
    const workflow = readWorkflow('.github/workflows/close-draft-prs.yml');

    // A bare `pull_request` trigger hands fork PRs (how first-time/external
    // contributors contribute) a read-only GITHUB_TOKEN, so the close/comment
    // API calls 403 and the draft PR survives — bypassing the auto-close.
    // `pull_request_target` runs in the base-repo context with a write-capable
    // token. Guard against a regression back to the bypassable trigger.
    assert.match(workflow, /^\s*pull_request_target:/m);
    assert.doesNotMatch(workflow, /^\s*pull_request:\s*$/m);
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

describe('Require Issue Link back-merge automation carve-out', () => {
  test('the fail step is skipped for same-repo auto-backmerge PRs', () => {
    const workflow = readWorkflow('.github/workflows/require-issue-link.yml');

    // Auto-backmerge PRs (chore/backmerge-main-to-next-*) map to no issue, and a
    // `Closes #N` would pollute the released CHANGELOG. The fail step must carve
    // them out — keyed on the workflow-authored branch name AND same-repo
    // identity so a fork PR cannot forge the exemption (#1389).
    assert.match(
      workflow,
      /startsWith\(github\.head_ref, 'chore\/backmerge-main-to-next-'\)/
    );
    assert.match(
      workflow,
      /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/
    );

    // The carve-out must live on the failing step's `if:` alongside the
    // found=='false' check (step-level, so the required check still reports
    // SUCCESS rather than a branch-protection-blocking "skipped").
    assert.match(workflow, /steps\.check\.outputs\.found == 'false'/);
  });
});

describe('Auto-backmerge needs_review version-manifest carve-out (#1404)', () => {
  const workflow = readWorkflow('.github/workflows/auto-backmerge.yml');

  test('all version-bearing manifests are filtered via version-only detection', () => {
    // package.json / package-lock.json / plugin.json / marketplace.json /
    // gemini-extension.json diverge every release; a drop that is ONLY
    // "version" lines must not park (parking is what lets the back-merge go
    // stale). A substantive change still parks. The grep matches the indented
    // "version": line for marketplace.json's plugins[0].version too. (#1404 / #1855)
    assert.ok(
      workflow.includes("VERSION_STAMP_MANIFESTS='package.json package-lock.json .claude-plugin/plugin.json .claude-plugin/marketplace.json gemini-extension.json'"),
      'auto-backmerge.yml must version-only-filter all version-bearing manifests (incl. marketplace.json #1855)'
    );
    assert.ok(
      workflow.includes(`grep -vE '^[+-][[:space:]]*"version":'`),
      'auto-backmerge.yml must filter version-only diffs via the "version" grep'
    );
  });

  test('package-lock.json is NOT blindly excluded (lockfile-only changes still park)', () => {
    // A lockfile-only substantive change (e.g. npm audit fix) rewrites
    // resolved/integrity lines, so version-only filtering lets it through to
    // review rather than dropping it silently. Guard against regression to a
    // blanket exclude. (#1404)
    assert.ok(
      !workflow.includes(":(exclude)package-lock.json"),
      'package-lock.json must not be globally excluded; rely on version-only filtering'
    );
  });
});
