'use strict';

// #5894 — pin the merge-commit landing of the release pipeline's history PRs.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');
const yaml = require('js-yaml');

const {
  MERGE_COMMIT_PR_REASON,
  GH_MERGE_TIMEOUT_MS,
  releaseTagFor,
  parseArgs,
  mergeWithMergeCommit,
  main,
} = require('../scripts/merge-commit-pr.cjs');
const { RELEASE_PIPELINE_PR_KIND, releasePipelinePrKind } = require('../scripts/release-pipeline-pr.cjs');

const HEAD = 'a'.repeat(40);
const MERGE = 'b'.repeat(40);
const BASE_PARENT = 'c'.repeat(40);
const REPO = 'open-gsd/gsd-core';

function fakeGh({ pr, merge, commit, compare, tagCompare = { behind_by: 0 }, throwOn = {} }) {
  const calls = [];
  const gh = (args, opts) => {
    calls.push({ args, opts });
    const key = args[1] === '-X' ? 'merge' : (/\/compare\/v/.test(args[1]) ? 'tagCompare' : /\/compare\//.test(args[1]) ? 'compare' : (/\/commits\//.test(args[1]) ? 'commit' : 'pr'));
    if (throwOn[key]) { const e = new Error(throwOn[key]); e.stderr = throwOn[key]; throw e; }
    return JSON.stringify({ pr, merge, commit, compare, tagCompare }[key]);
  };
  return { gh, calls };
}

function backmergePr(overrides = {}) {
  return {
    state: 'open',
    merged: false,
    head: { ref: 'chore/backmerge-main-to-next-4dce9e8', sha: HEAD, repo: { full_name: REPO } },
    base: { ref: 'next' },
    ...overrides,
  };
}

function releasePr() {
  return backmergePr({
    head: { ref: 'release/1.20.0', sha: HEAD, repo: { full_name: REPO } },
    base: { ref: 'main' },
  });
}

const GOOD = {
  merge: { merged: true, sha: MERGE },
  commit: { parents: [{ sha: BASE_PARENT }, { sha: HEAD }] },
  compare: { behind_by: 0, status: 'ahead' },
};

function run(fixture) {
  const { gh, calls } = fakeGh({ ...GOOD, ...fixture });
  const result = mergeWithMergeCommit({ prNumber: 77, repo: REPO, gh });
  return { result, calls };
}

function mergeCalls(calls) {
  return calls.filter((c) => c.args[1] === '-X');
}

function sink() {
  return { buf: '', write(s) { this.buf += s; } };
}

describe('#5894: mergeWithMergeCommit', () => {
  test('lands a back-merge PR with merge_method=merge pinned to the head sha', () => {
    const { result, calls } = run({ pr: backmergePr() });
    assert.deepEqual(result, { ok: true, reason: MERGE_COMMIT_PR_REASON.MERGED, kind: 'main-to-next-backmerge', mergeSha: MERGE });
    const merges = mergeCalls(calls);
    assert.equal(merges.length, 1);
    assert.deepEqual(merges[0].args, ['api', '-X', 'PUT', 'repos/open-gsd/gsd-core/pulls/77/merge', '-f', 'merge_method=merge', '-f', `sha=${HEAD}`]);
    assert.equal(merges[0].opts.timeout, GH_MERGE_TIMEOUT_MS);
    for (const c of calls) {
      assert.ok(!c.args.some((a) => /squash|rebase/.test(String(a))));
    }
  });

  test('lands a release PR', () => {
    const { result } = run({ pr: releasePr() });
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'release-merge');
  });

  test('a release PR reads compare/<tag>...<base> and succeeds when the tag is in the base', () => {
    const { result, calls } = run({ pr: releasePr() });
    assert.equal(result.ok, true);
    assert.ok(calls.some((c) => c.args[1] === 'repos/open-gsd/gsd-core/compare/v1.20.0...main'));
  });

  test('a release PR whose tag is not in the base is TAG_NOT_IN_BASE', () => {
    const { result } = run({ pr: releasePr(), tagCompare: { behind_by: 1 } });
    assert.equal(result.reason, MERGE_COMMIT_PR_REASON.TAG_NOT_IN_BASE);
    assert.equal(result.detail, 'v1.20.0 behind_by=1');
  });

  test('an unreadable tag compare is VERIFY_UNREADABLE', () => {
    const { gh } = fakeGh({ ...GOOD, pr: releasePr() });
    const throwing = (args, opts) => {
      if (/\/compare\/v/.test(args[1])) { const e = new Error('HTTP 404'); e.stderr = 'HTTP 404'; throw e; }
      return gh(args, opts);
    };
    const result = mergeWithMergeCommit({ prNumber: 77, repo: REPO, gh: throwing });
    assert.equal(result.reason, MERGE_COMMIT_PR_REASON.VERIFY_UNREADABLE);
    assert.equal(result.mergeSha, MERGE);
  });

  test('a back-merge PR makes no tag compare call', () => {
    const { calls } = run({ pr: backmergePr() });
    assert.ok(!calls.some((c) => /\/compare\/v/.test(c.args[1])));
  });

  test('a one-parent (squash-shaped) result is NOT_A_MERGE_COMMIT', () => {
    const { result } = run({ pr: backmergePr(), commit: { parents: [{ sha: BASE_PARENT }] } });
    assert.equal(result.reason, MERGE_COMMIT_PR_REASON.NOT_A_MERGE_COMMIT);
  });

  test('two parents, neither the PR head, is NOT_A_MERGE_COMMIT', () => {
    const { result } = run({ pr: backmergePr(), commit: { parents: [{ sha: BASE_PARENT }, { sha: 'd'.repeat(40) }] } });
    assert.equal(result.reason, MERGE_COMMIT_PR_REASON.NOT_A_MERGE_COMMIT);
  });

  test('three parents including the head is NOT_A_MERGE_COMMIT', () => {
    const { result } = run({ pr: backmergePr(), commit: { parents: [{ sha: BASE_PARENT }, { sha: HEAD }, { sha: 'd'.repeat(40) }] } });
    assert.equal(result.reason, MERGE_COMMIT_PR_REASON.NOT_A_MERGE_COMMIT);
  });

  test('compare.behind_by boundary: 0 ok, 1 and undefined broken', () => {
    assert.equal(run({ pr: backmergePr(), compare: { behind_by: 0 } }).result.ok, true);
    assert.equal(run({ pr: backmergePr(), compare: { behind_by: 1 } }).result.reason, MERGE_COMMIT_PR_REASON.ANCESTRY_BROKEN);
    assert.equal(run({ pr: backmergePr(), compare: {} }).result.reason, MERGE_COMMIT_PR_REASON.ANCESTRY_BROKEN);
  });

  test('a refused merge PUT is MERGE_REFUSED with gh text', () => {
    const { result } = run({ pr: backmergePr(), throwOn: { merge: 'Pull Request is not mergeable' } });
    assert.equal(result.reason, MERGE_COMMIT_PR_REASON.MERGE_REFUSED);
    assert.ok(result.detail.includes('Pull Request is not mergeable'));
  });

  test('merged:false is MERGE_REFUSED', () => {
    const { result } = run({ pr: backmergePr(), merge: { merged: false } });
    assert.equal(result.reason, MERGE_COMMIT_PR_REASON.MERGE_REFUSED);
  });

  test('an unreadable PR is PR_UNREADABLE and nothing is merged', () => {
    const { result, calls } = run({ pr: backmergePr(), throwOn: { pr: 'HTTP 404' } });
    assert.equal(result.reason, MERGE_COMMIT_PR_REASON.PR_UNREADABLE);
    assert.equal(mergeCalls(calls).length, 0);
  });

  test('closed and already-merged PRs are NOT_OPEN and nothing is merged', () => {
    for (const overrides of [{ state: 'closed' }, { merged: true }]) {
      const { result, calls } = run({ pr: backmergePr(overrides) });
      assert.equal(result.reason, MERGE_COMMIT_PR_REASON.NOT_OPEN);
      assert.equal(mergeCalls(calls).length, 0);
    }
  });

  test('fork and deleted-fork heads are NOT_A_HISTORY_PR and nothing is merged', () => {
    const head = (repo) => ({ ref: 'chore/backmerge-main-to-next-4dce9e8', sha: HEAD, repo });
    for (const repo of [{ full_name: 'someone/gsd-core' }, null]) {
      const { result, calls } = run({ pr: backmergePr({ head: head(repo) }) });
      assert.equal(result.reason, MERGE_COMMIT_PR_REASON.NOT_A_HISTORY_PR);
      assert.equal(mergeCalls(calls).length, 0);
    }
  });

  test('version-sync and ordinary PRs are NOT_A_HISTORY_PR and nothing is merged', () => {
    for (const ref of ['chore/sync-next-version-1.20.0', 'fix/1-x']) {
      const { result, calls } = run({ pr: backmergePr({ head: { ref, sha: HEAD, repo: { full_name: REPO } } }) });
      assert.equal(result.reason, MERGE_COMMIT_PR_REASON.NOT_A_HISTORY_PR);
      assert.equal(mergeCalls(calls).length, 0);
    }
  });

  test('a back-merge branch against main is NOT_A_HISTORY_PR', () => {
    const { result } = run({ pr: backmergePr({ base: { ref: 'main' } }) });
    assert.equal(result.reason, MERGE_COMMIT_PR_REASON.NOT_A_HISTORY_PR);
  });

  test('the head repo comparison is case-insensitive', () => {
    const { result } = run({
      pr: backmergePr({ head: { ref: 'chore/backmerge-main-to-next-4dce9e8', sha: HEAD, repo: { full_name: 'Open-GSD/GSD-Core' } } }),
    });
    assert.equal(result.ok, true);
  });

  test('an unreadable merge commit is VERIFY_UNREADABLE with the merge sha', () => {
    const { result } = run({ pr: backmergePr(), throwOn: { commit: 'HTTP 502' } });
    assert.equal(result.reason, MERGE_COMMIT_PR_REASON.VERIFY_UNREADABLE);
    assert.equal(result.mergeSha, MERGE);
  });
});

describe('#5894: releaseTagFor', () => {
  test('maps release and hotfix heads to their tag', () => {
    const table = [
      ['release/1.20.0', 'v1.20.0'],
      ['hotfix/1.20.1', 'v1.20.1'],
      ['release/1.20', null],
      ['release/01.20.0', null],
      ['chore/x', null],
      [undefined, null],
    ];
    for (const [ref, tag] of table) assert.equal(releaseTagFor(ref), tag, String(ref));
  });
});

describe('#5894: merge-commit-pr parseArgs', () => {
  test('defaults and --repo', () => {
    assert.deepEqual(parseArgs(['77'], {}), { prNumber: 77, repo: 'open-gsd/gsd-core' });
    assert.equal(parseArgs(['77'], { GITHUB_REPOSITORY: 'o/r' }).repo, 'o/r');
    assert.equal(parseArgs(['77', '--repo', 'x/y'], {}).repo, 'x/y');
  });

  test('rejects malformed input', () => {
    for (const argv of [[], ['0'], ['-1'], ['07'], ['abc'], ['77', '78'], ['77', '--repo'], ['77', '--repo', 'bad']]) {
      assert.ok(parseArgs(argv, {}).error, `expected an error for ${JSON.stringify(argv)}`);
    }
  });

  test('PR number boundary: 1 and 10 accepted, 0 rejected', () => {
    assert.equal(parseArgs(['1'], {}).prNumber, 1);
    assert.equal(parseArgs(['10'], {}).prNumber, 10);
    assert.equal(parseArgs(['0'], {}).prNumber, undefined);
  });

  test('property: a PR number is accepted exactly when it is a positive integer without leading zeros', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.nat().map(String), fc.nat().map((n) => '0' + n)),
        (s) => (parseArgs([s], {}).prNumber !== undefined) === /^[1-9][0-9]*$/.test(s),
      ),
      { numRuns: 300 },
    );
  });
});

describe('#5894: merge-commit-pr main()', () => {
  test('good path exits 0 with ok:true', () => {
    const { gh } = fakeGh({ ...GOOD, pr: backmergePr() });
    const stdout = sink();
    const stderr = sink();
    assert.equal(main(['77'], { gh, env: {}, stdout, stderr }), 0);
    assert.equal(JSON.parse(stdout.buf).ok, true);
  });

  test('a one-parent merge exits 1 and names #5894 on stderr', () => {
    const { gh } = fakeGh({ ...GOOD, pr: backmergePr(), commit: { parents: [{ sha: BASE_PARENT }] } });
    const stdout = sink();
    const stderr = sink();
    assert.equal(main(['77'], { gh, env: {}, stdout, stderr }), 1);
    assert.ok(stderr.buf.includes('::error::'));
    assert.ok(stderr.buf.includes('#5894'));
  });

  test('a usage error exits 1 with reason usage', () => {
    const stdout = sink();
    const stderr = sink();
    assert.equal(main([], { env: {}, stdout, stderr }), 1);
    assert.equal(JSON.parse(stdout.buf).reason, 'usage');
  });
});

describe('#5894: branch-naming check-branch refuses back-merge PRs', () => {
  const wf = yaml.load(fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'branch-naming.yml'), 'utf8'));
  const script = wf.jobs['check-branch'].steps.find((s) => s.name === 'Validate branch naming convention').with.script;
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const checker = new AsyncFunction('require', 'github', 'context', 'core', 'process', script);

  async function failureFor(ref, baseRef) {
    let failed = null;
    const core = { warning() {}, info() {}, setFailed(m) { failed = m; } };
    const context = { payload: { pull_request: { number: 77, head: { ref }, base: { ref: baseRef } } } };
    await checker(require, {}, context, core, process);
    return failed;
  }

  test('a back-merge branch against next fails and names the sanctioned merge command', async () => {
    const failed = await failureFor('chore/backmerge-main-to-next-4dce9e8', 'next');
    assert.match(failed, /merge-commit-pr\.cjs 77/);
  });

  test('parity: every back-merge branch the pipeline classifies fails check-branch', async () => {
    for (const headRef of ['chore/backmerge-main-to-next-4dce9e8', 'chore/backmerge-main-to-next-' + 'a'.repeat(40)]) {
      assert.equal(
        releasePipelinePrKind({ headRef, baseRef: 'next', sameRepo: true }),
        RELEASE_PIPELINE_PR_KIND.MAIN_TO_NEXT_BACKMERGE,
        `${headRef} must classify as a back-merge`,
      );
      assert.ok(await failureFor(headRef, 'next'), `${headRef} must fail check-branch`);
    }
  });

  test('the guard is a superset: a back-merge-named branch the classifier rejects still fails check-branch', async () => {
    const headRef = 'chore/backmerge-main-to-next-not-a-sha';
    assert.equal(releasePipelinePrKind({ headRef, baseRef: 'next', sameRepo: true }), null);
    assert.ok(await failureFor(headRef, 'next'), `${headRef} must fail check-branch`);
  });

  test('other PRs are not failed by the back-merge rule', async () => {
    assert.equal(await failureFor('chore/backmerge-main-to-next-4dce9e8', 'main'), null);
    assert.equal(await failureFor('chore/sync-next-version-1.20.0', 'next'), null);
    assert.equal(await failureFor('release/1.20.0', 'main'), null);
    assert.equal(await failureFor('fix/5894-x', 'next'), null);
  });
});
