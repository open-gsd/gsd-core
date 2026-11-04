'use strict';

/**
 * #5890: the release pipeline's own back-merge PRs carry no issue to link, so
 * `Issue link required` and `validate-title` must exempt them — and only them.
 *
 * Exempt (same-repo head only, exact head/base pair):
 *   release/X.Y.0 | hotfix/X.Y.Z   -> main  (release.yml "merge release back to main")
 *   chore/sync-next-version-<v>    -> next  (scripts/sync-next-version.cjs)
 *   chore/backmerge-main-to-next-* -> next  (auto-backmerge.yml, #1389)
 *
 * Every assertion is on the typed RELEASE_PIPELINE_PR_KIND / ISSUE_LINK_REASON
 * enums. The title-validator half executes the workflow's own github-script
 * body against fakes, so it measures behavior, not YAML text.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');
const fc = require('fast-check');
const { cleanup } = require('./helpers.cjs');

const {
  RELEASE_PIPELINE_PR_KIND,
  releasePipelinePrKind,
  isReleasePipelinePr,
} = require('../scripts/release-pipeline-pr.cjs');
const { evaluateIssueLink, ISSUE_LINK_REASON } = require('../scripts/require-issue-link-policy.cjs');
const { isReleaseVersion, syncBranchName } = require('../scripts/sync-next-version.cjs');

const REPO_ROOT = path.join(__dirname, '..');

const EXEMPT = [
  { headRef: 'release/1.20.0', baseRef: 'main', kind: RELEASE_PIPELINE_PR_KIND.RELEASE_MERGE },
  { headRef: 'release/2.0.0', baseRef: 'main', kind: RELEASE_PIPELINE_PR_KIND.RELEASE_MERGE },
  { headRef: 'hotfix/1.20.1', baseRef: 'main', kind: RELEASE_PIPELINE_PR_KIND.RELEASE_MERGE },
  { headRef: 'hotfix/1.20.10', baseRef: 'main', kind: RELEASE_PIPELINE_PR_KIND.RELEASE_MERGE },
  { headRef: 'chore/sync-next-version-1.20.0', baseRef: 'next', kind: RELEASE_PIPELINE_PR_KIND.NEXT_VERSION_SYNC },
  { headRef: 'chore/sync-next-version-1.21.0-rc.1', baseRef: 'next', kind: RELEASE_PIPELINE_PR_KIND.NEXT_VERSION_SYNC },
  { headRef: 'chore/sync-next-version-1.21.0-beta.2', baseRef: 'next', kind: RELEASE_PIPELINE_PR_KIND.NEXT_VERSION_SYNC },
  { headRef: 'chore/backmerge-main-to-next-4dce9e8', baseRef: 'next', kind: RELEASE_PIPELINE_PR_KIND.MAIN_TO_NEXT_BACKMERGE },
];

describe('releasePipelinePrKind (#5890)', () => {
  test('each release-pipeline head/base pair from the same repo is classified', () => {
    for (const { headRef, baseRef, kind } of EXEMPT) {
      assert.equal(releasePipelinePrKind({ headRef, baseRef, sameRepo: true }), kind, `${headRef} -> ${baseRef}`);
      assert.equal(isReleasePipelinePr({ headRef, baseRef, sameRepo: true }), true, `${headRef} -> ${baseRef}`);
    }
  });

  test('#1389 anti-forgery: the same branches from a fork are never exempt', () => {
    for (const { headRef, baseRef } of EXEMPT) {
      for (const sameRepo of [false, undefined, 'true', 1]) {
        assert.equal(
          releasePipelinePrKind({ headRef, baseRef, sameRepo }),
          null,
          `${headRef} -> ${baseRef} sameRepo=${JSON.stringify(sameRepo)}`,
        );
        assert.equal(isReleasePipelinePr({ headRef, baseRef, sameRepo }), false);
      }
    }
  });

  test('a release-pipeline branch against the wrong base is not exempt', () => {
    const wrongBase = [
      { headRef: 'release/1.20.0', baseRef: 'next' },
      { headRef: 'hotfix/1.20.1', baseRef: 'next' },
      { headRef: 'release/1.20.0', baseRef: 'release/1.20.0' },
      { headRef: 'chore/sync-next-version-1.20.0', baseRef: 'main' },
      { headRef: 'chore/backmerge-main-to-next-4dce9e8', baseRef: 'main' },
      { headRef: 'release/1.20.0', baseRef: '' },
      { headRef: 'release/1.20.0', baseRef: undefined },
    ];
    for (const { headRef, baseRef } of wrongBase) {
      assert.equal(releasePipelinePrKind({ headRef, baseRef, sameRepo: true }), null, `${headRef} -> ${baseRef}`);
    }
  });

  test('near-miss head branch names are not exempt', () => {
    const nearMiss = [
      // version segment count: 2 (limit-1) and 4 (limit+1) around the 3 the pipeline cuts
      ['release/1.20', 'main'],
      ['release/1.20.0.0', 'main'],
      // release/ is X.Y.0 only; Z>0 is hotfix/, and hotfix/ is never X.Y.0
      ['release/1.20.1', 'main'],
      ['hotfix/1.20.0', 'main'],
      // leading zeros the release.yml version check rejects
      ['release/01.20.0', 'main'],
      ['release/1.020.0', 'main'],
      ['hotfix/1.20.01', 'main'],
      // prerelease / prefix / suffix / nesting / case
      ['release/1.20.0-rc.1', 'main'],
      ['release/v1.20.0', 'main'],
      ['release/1.20.0/x', 'main'],
      ['xrelease/1.20.0', 'main'],
      ['feature/release/1.20.0', 'main'],
      ['release/1.20.0\n', 'main'],
      ['Release/1.20.0', 'main'],
      // sync: the version must be one isReleaseVersion accepts
      ['chore/sync-next-version-', 'next'],
      ['chore/sync-next-version-1.20', 'next'],
      ['chore/sync-next-version-1.20.0-dev.1', 'next'],
      ['chore/sync-next-version-1.20.0-rc', 'next'],
      ['chore/sync-next-version-1.20.0/x', 'next'],
      ['chore/sync-next-version-1.20.0\n', 'next'],
      ['sync-next-version-1.20.0', 'next'],
      ['x/chore/sync-next-version-1.20.0', 'next'],
      // backmerge: the prefix must lead and carry a suffix
      ['chore/backmerge-main-to-next-', 'next'],
      ['chore/backmerge-main-to-next', 'next'],
      ['x/chore/backmerge-main-to-next-4dce9e8', 'next'],
      ['chore/backmerge-main-to-next-4dce9e8/x', 'next'],
      ['chore/backmerge-main-to-next-4DCE9E8', 'next'],
      ['chore/backmerge-main-to-next-4dce9eg', 'next'],
      // ordinary work branches
      ['fix/5890-release-pipeline-pr-exemption', 'next'],
      ['', 'next'],
    ];
    for (const [headRef, baseRef] of nearMiss) {
      assert.equal(
        releasePipelinePrKind({ headRef, baseRef, sameRepo: true }),
        null,
        `${JSON.stringify(headRef)} -> ${baseRef}`,
      );
    }
  });

  test('BOUNDARY: the backmerge suffix is a 7..40-char short sha', () => {
    const at = (n) => releasePipelinePrKind({
      headRef: `chore/backmerge-main-to-next-${'a'.repeat(n)}`, baseRef: 'next', sameRepo: true,
    });
    assert.equal(at(6), null, '6 hex (limit-1 below the 7 floor)');
    assert.equal(at(7), RELEASE_PIPELINE_PR_KIND.MAIN_TO_NEXT_BACKMERGE, '7 hex (floor)');
    assert.equal(at(8), RELEASE_PIPELINE_PR_KIND.MAIN_TO_NEXT_BACKMERGE, '8 hex (floor+1)');
    assert.equal(at(39), RELEASE_PIPELINE_PR_KIND.MAIN_TO_NEXT_BACKMERGE, '39 hex (ceiling-1)');
    assert.equal(at(40), RELEASE_PIPELINE_PR_KIND.MAIN_TO_NEXT_BACKMERGE, '40 hex (ceiling)');
    assert.equal(at(41), null, '41 hex (ceiling+1)');
  });

  test('non-string and missing inputs fail closed', () => {
    assert.equal(releasePipelinePrKind({}), null);
    assert.equal(releasePipelinePrKind(), null);
    assert.equal(releasePipelinePrKind({ headRef: ['release/1.20.0'], baseRef: 'main', sameRepo: true }), null);
    assert.equal(releasePipelinePrKind({ headRef: 'release/1.20.0', baseRef: ['main'], sameRepo: true }), null);
  });

  test('PROPERTY: the branch sync-next-version.cjs opens is exempt exactly when the version is a release version', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.tuple(fc.nat(99), fc.nat(99), fc.nat(99)).map(([a, b, c]) => `${a}.${b}.${c}`),
          fc.tuple(fc.nat(99), fc.nat(99), fc.nat(99), fc.constantFrom('rc', 'beta', 'dev', 'alpha'), fc.nat(9))
            .map(([a, b, c, tag, n]) => `${a}.${b}.${c}-${tag}.${n}`),
        ),
        (version) => {
          const kind = releasePipelinePrKind({ headRef: syncBranchName(version), baseRef: 'next', sameRepo: true });
          assert.equal(kind !== null, isReleaseVersion(version), JSON.stringify(version));
        },
      ),
      { numRuns: 500 },
    );
  });

  test('PROPERTY: no head/base pair is ever exempt from a fork', () => {
    fc.assert(
      fc.property(fc.string(), fc.constantFrom('main', 'next', ''), (headRef, baseRef) => {
        assert.equal(releasePipelinePrKind({ headRef, baseRef, sameRepo: false }), null);
      }),
      { numRuns: 500 },
    );
  });

  test('PROPERTY: an exempt head/base pair is never exempt unless sameRepo is exactly true', () => {
    fc.assert(
      fc.property(fc.constantFrom(...EXEMPT), fc.anything().filter((v) => v !== true), ({ headRef, baseRef }, sameRepo) => {
        assert.equal(releasePipelinePrKind({ headRef, baseRef, sameRepo }), null);
      }),
      { numRuns: 500 },
    );
  });
});

describe('Issue link required honors the release-pipeline exemption (#5890)', () => {
  const sourceDiff = { changedFiles: ['package.json', 'src/init.cts'], changedFilesTotal: 2 };

  test('every release-pipeline PR passes with no issue reference in its body', () => {
    for (const { headRef, baseRef, kind } of EXEMPT) {
      const result = evaluateIssueLink({ prBody: 'Automated.', headRef, baseRef, sameRepo: true, ...sourceDiff });
      assert.equal(result.reason, ISSUE_LINK_REASON.OK_BACKMERGE_EXEMPT, `${headRef} -> ${baseRef}`);
      assert.equal(result.ok, true);
      assert.equal(result.kind, kind, `${headRef} -> ${baseRef}`);
    }
  });

  test('the same PRs from a fork or against the wrong base still need an issue', () => {
    for (const { headRef, baseRef } of EXEMPT) {
      const fork = evaluateIssueLink({ prBody: '', headRef, baseRef, sameRepo: false, ...sourceDiff });
      assert.equal(fork.reason, ISSUE_LINK_REASON.FAIL_NO_ISSUE_REFERENCE, `fork ${headRef}`);
      const otherBase = baseRef === 'main' ? 'next' : 'main';
      const wrong = evaluateIssueLink({ prBody: '', headRef, baseRef: otherBase, sameRepo: true, ...sourceDiff });
      assert.equal(wrong.reason, ISSUE_LINK_REASON.FAIL_NO_ISSUE_REFERENCE, `${headRef} -> ${otherBase}`);
    }
  });

  test('the workflow hands the policy the PR base branch', () => {
    const doc = yaml.load(fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/require-issue-link.yml'), 'utf8'));
    const step = doc.jobs['check-issue-link'].steps.find((s) => s.id === 'policy');
    assert.equal(step.env.BASE_REF, '${{ github.event.pull_request.base.ref }}');
    assert.equal(step.env.SAME_REPO, '${{ github.event.pull_request.head.repo.full_name == github.repository }}');
  });
});

// Run the `Validate PR title` github-script body the way actions/github-script
// does: an async function over (require, github, context, core, process).
function titleValidatorScript() {
  const doc = yaml.load(fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/pr-title-validator.yml'), 'utf8'));
  const step = doc.jobs['validate-title'].steps.find((s) => s.name === 'Validate PR title');
  return step.with.script;
}

async function runTitleValidator({ title, headRef, baseRef, headRepo = 'open-gsd/gsd-core', userLogin = 'trek-e', workspace = REPO_ROOT }) {
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const outcome = { failed: null, comments: 0 };
  const core = {
    info() {},
    warning() {},
    setFailed(msg) { outcome.failed = msg; },
  };
  const github = {
    rest: {
      issues: {
        listComments: async () => ({ data: [] }),
        createComment: async () => { outcome.comments += 1; },
        updateComment: async () => { outcome.comments += 1; },
      },
    },
  };
  const context = {
    repo: { owner: 'open-gsd', repo: 'gsd-core' },
    payload: {
      pull_request: {
        number: 1,
        title,
        user: { login: userLogin },
        head: { ref: headRef, repo: headRepo === null ? null : { full_name: headRepo } },
        base: { ref: baseRef },
      },
    },
  };
  const fakeProcess = { env: { GITHUB_WORKSPACE: workspace, WARN_ONLY: 'false' } };
  const fn = new AsyncFunction('require', 'github', 'context', 'core', 'process', titleValidatorScript());
  await fn(require, github, context, core, fakeProcess);
  return outcome;
}

describe('validate-title honors the release-pipeline exemption (#5890)', () => {
  const titles = {
    'release/1.20.0': 'chore: merge release v1.20.0 to main',
    'release/2.0.0': 'chore: merge release v2.0.0 to main',
    'hotfix/1.20.1': 'chore: merge release v1.20.1 to main',
    'hotfix/1.20.10': 'chore: merge release v1.20.10 to main',
    'chore/sync-next-version-1.20.0': 'chore: sync next package version to 1.20.0',
    'chore/sync-next-version-1.21.0-rc.1': 'chore: sync next package version to 1.21.0-rc.1',
    'chore/sync-next-version-1.21.0-beta.2': 'chore: sync next package version to 1.21.0-beta.2',
    'chore/backmerge-main-to-next-4dce9e8': 'chore: back-merge main → next (4dce9e8)',
  };

  test('each release-pipeline PR passes with its pipeline-generated title', async () => {
    for (const { headRef, baseRef } of EXEMPT) {
      const outcome = await runTitleValidator({ title: titles[headRef], headRef, baseRef });
      assert.equal(outcome.failed, null, `${headRef} -> ${baseRef}`);
      assert.equal(outcome.comments, 0, `${headRef} -> ${baseRef}`);
    }
  });

  test('the same title and branch from a fork still fails missing-issue-ref', async () => {
    for (const { headRef, baseRef } of EXEMPT) {
      const outcome = await runTitleValidator({ title: titles[headRef], headRef, baseRef, headRepo: 'someone/gsd-core' });
      assert.match(String(outcome.failed), /\(missing-issue-ref\)/, `${headRef} -> ${baseRef}`);
    }
  });

  test('a release-pipeline title on an ordinary branch still fails missing-issue-ref', async () => {
    const outcome = await runTitleValidator({
      title: 'chore: sync next package version to 1.20.0', headRef: 'chore/sync-next-version', baseRef: 'next',
    });
    assert.match(String(outcome.failed), /\(missing-issue-ref\)/);
  });

  test('an ordinary conforming title still passes and a dependabot PR is still exempt', async () => {
    const ok = await runTitleValidator({ title: 'fix(#5890): x', headRef: 'fix/5890-x', baseRef: 'next' });
    assert.equal(ok.failed, null);
    const bot = await runTitleValidator({
      title: 'chore(deps): bump x', headRef: 'dependabot/npm_and_yarn/x', baseRef: 'next', userLogin: 'dependabot[bot]',
    });
    assert.equal(bot.failed, null);
  });

  test('a release-pipeline branch against the wrong base still fails missing-issue-ref', async () => {
    for (const { headRef, baseRef } of EXEMPT) {
      const otherBase = baseRef === 'main' ? 'next' : 'main';
      const outcome = await runTitleValidator({ title: titles[headRef], headRef, baseRef: otherBase });
      assert.match(String(outcome.failed), /\(missing-issue-ref\)/, `${headRef} -> ${otherBase}`);
    }
  });

  test('the waiver covers missing-issue-ref only: a bad type prefix on an exempt branch still fails', async () => {
    for (const { headRef, baseRef } of EXEMPT) {
      const outcome = await runTitleValidator({ title: `[security] ${titles[headRef]}`, headRef, baseRef });
      assert.match(String(outcome.failed), /\(bad-prefix\)/, `${headRef} -> ${baseRef}`);
    }
  });

  test('the head repo comparison is case-insensitive, like SAME_REPO in require-issue-link.yml', async () => {
    const outcome = await runTitleValidator({
      title: titles['release/1.20.0'], headRef: 'release/1.20.0', baseRef: 'main', headRepo: 'Open-GSD/GSD-Core',
    });
    assert.equal(outcome.failed, null);
  });

  test('a deleted fork (head.repo null) is never waived', async () => {
    const outcome = await runTitleValidator({
      title: titles['release/1.20.0'], headRef: 'release/1.20.0', baseRef: 'main', headRepo: null,
    });
    assert.match(String(outcome.failed), /\(missing-issue-ref\)/);
  });

  test('bootstrap: with no release-pipeline-pr.cjs on the base branch, nothing is waived', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5890-bootstrap-'));
    t.after(() => cleanup(workspace));
    fs.mkdirSync(path.join(workspace, 'scripts', 'release-notes'), { recursive: true });
    fs.copyFileSync(
      path.join(REPO_ROOT, 'scripts', 'release-notes', 'conventional-title.cjs'),
      path.join(workspace, 'scripts', 'release-notes', 'conventional-title.cjs'),
    );
    const outcome = await runTitleValidator({
      title: titles['release/1.20.0'], headRef: 'release/1.20.0', baseRef: 'main', workspace,
    });
    assert.match(String(outcome.failed), /\(missing-issue-ref\)/);
  });
});
