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

  // #2331: same defect class as the close-draft-prs.yml trigger lock above,
  // swept across the three PR-policy workflows it had never covered. Each one
  // comments on the PR and THEN emits its verdict; on a bare `pull_request`
  // trigger a fork PR's read-only GITHUB_TOKEN 403s the comment call, the
  // unhandled rejection kills the github-script step, and the verdict
  // (core.setFailed) never runs — the contributor gets an API stack trace
  // instead of the instructions the comment exists to deliver.
  for (const { file, name } of [
    { file: '.github/workflows/pr-title-validator.yml', name: 'PR title validator' },
    { file: '.github/workflows/pr-target-validator.yml', name: 'PR target validator' },
    { file: '.github/workflows/require-issue-link.yml', name: 'Require issue link' },
  ]) {
    test(`${name} triggers on pull_request_target so fork PRs get the verdict, not a 403`, () => {
      const workflow = readWorkflow(file);

      assert.match(workflow, /^\s*pull_request_target:/m);
      assert.doesNotMatch(workflow, /^\s*pull_request:\s*$/m);
    });

    test(`${name} declares a write permission for the endpoint it calls`, () => {
      const workflow = readWorkflow(file);

      // pull_request_target only grants what `permissions:` declares. These
      // workflows comment via the issue-comments endpoint, so the write scope
      // must be present or the trigger change alone would not fix the 403.
      assert.match(workflow, /^\s*(issues|pull-requests):\s*write\s*$/m);
    });

    test(`${name} cannot let a failed comment suppress its verdict`, () => {
      const workflow = readWorkflow(file);

      // Defense in depth: the comment is a courtesy, the verdict is the gate.
      // Guard the inversion (comment throws -> setFailed skipped) that #2331
      // fixed, so a future permission change degrades the diagnostic only.
      assert.match(workflow, /\btry\s*\{/);
      assert.match(workflow, /catch\s*\(err\)\s*\{[\s\S]*?core\.warning/);

      // Assert the ORDER, not just the presence: core.setFailed must appear
      // AFTER the catch block's core.warning. If the verdict were moved inside
      // the try, it would textually precede the catch — which is exactly the
      // regression this locks. Presence-only assertions pass either way.
      const catchWarning = workflow.indexOf('Could not post');
      const verdict = workflow.indexOf('core.setFailed');
      assert.ok(catchWarning !== -1, 'expected the catch-block core.warning');
      assert.ok(verdict !== -1, 'expected a core.setFailed verdict');
      assert.ok(
        verdict > catchWarning,
        'core.setFailed must sit AFTER the catch block, not inside the try — ' +
          'otherwise a thrown comment error skips the verdict (#2331)'
      );
    });
  }

  // #2331: these two workflows echo attacker-controlled text (PR title / fork
  // branch name) into a bot-authored comment posted with a write token. Raw
  // interpolation into an inline-code span lets a single backtick close the span
  // so the remainder renders as live Markdown — on a PR title (no charset limit)
  // that is enough to autolink an arbitrary URL from github-actions[bot].
  for (const { file, name, varName } of [
    { file: '.github/workflows/pr-title-validator.yml', name: 'PR title validator', varName: 'titleForMarkdown' },
    { file: '.github/workflows/pr-target-validator.yml', name: 'PR target validator', varName: 'headForMarkdown' },
  ]) {
    test(`${name} strips backticks before echoing untrusted text into the comment`, () => {
      const workflow = readWorkflow(file);

      // The sanitizer exists and removes the one character that can break out
      // of an inline-code span.
      assert.match(workflow, new RegExp(`const ${varName} = String\\(\\w+\\)\\.replace\\(/\`/g, "'"\\)`));
      // The rendered comment interpolates the SANITIZED value, never the raw one.
      assert.match(workflow, new RegExp(`\\\\\`\\$\\{${varName}\\}`));
    });
  }

  test('the backtick sanitizer actually neutralizes the inline-code breakout', () => {
    // Behavioral check of the transform the workflows apply, rather than only
    // asserting the source text contains it.
    const sanitize = (v) => String(v).replace(/`/g, "'");
    const hostile = 'bad`See https://evil.example/ci-status for details x';

    assert.match('`' + hostile + '`', /`bad`See/, 'pre-fix: the span breaks out');
    assert.doesNotMatch('`' + sanitize(hostile) + '`', /`bad`/, 'post-fix: it cannot');
    assert.equal(sanitize(hostile).includes('`'), false, 'no backtick survives');
    // Boundary: no backtick, one backtick, many backticks.
    assert.equal(sanitize('plain'), 'plain');
    assert.equal(sanitize('`'), "'");
    assert.equal(sanitize('``a``'), "''a''");
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
    // package.json / package-lock.json / plugin.json / marketplace.json
    // diverge every release; a drop that is ONLY "version" lines must not park
    // (parking is what lets the back-merge go stale). A substantive change
    // still parks. The grep matches the indented "version": line for
    // marketplace.json's plugins[0].version too. (#1404 / #1855)
    // #1928: gemini-extension.json was removed with the sunset gemini runtime.
    assert.ok(
      workflow.includes("VERSION_STAMP_MANIFESTS='package.json package-lock.json .claude-plugin/plugin.json .claude-plugin/marketplace.json'"),
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
