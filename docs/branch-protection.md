# Branch Protection Rollout

## Rulesets

Four ruleset specs live under `.github/rulesets/`. All are committed with
`enforcement: disabled` and activated in stages via the 4-PR rollout below.

### `main-protection`
Targets `~DEFAULT_BRANCH` (main). Enforces:
- No deletions or force pushes
- Required linear history (no merge commits)
- All changes via pull request (0 required approvals, stale-review dismissal, thread resolution required, squash/rebase only)
- Required status checks: the aggregate `Required tests` gate plus PR policy
  checks for size, branch name, changeset, docs, target branch, issue link, and
  PR template format

### `release-branches`
Targets `refs/heads/release/**` and `refs/heads/hotfix/**`. Same rules as
`main-protection` except `required_linear_history` is omitted (merge commits
are permitted on release/hotfix branches).

### `tag-immutability`
Targets all tags (`~ALL`). Blocks tag updates and deletions — tags are
immutable once created. Tag creation is unrestricted.

### `next-queue`
Targets `~DEFAULT_BRANCH`. A GitHub merge queue (#5605): approved, green PRs
join a queue, up to three are grouped (`ALLGREEN`: a PR with a failing
required check never joins a group), the full matrix runs once on the group's
merge commit, and each PR is **squash**-merged as its own commit
(`merge_method: SQUASH`, matching the one-commit-per-PR convention). The queue
waits up to 15 minutes to collect two PRs and up to 90 minutes for the checks
to respond. It carries no other rules and **no bypass actors yet**.

Two things must be settled before it is enforced:
- **The auto back-merge.** `auto-backmerge.yml` merges `main` into `next` as a
  merge commit so `main` stays an ancestor of `next`. A squash queue would
  flatten it. Decide the bypass actor before enforcing. The `evaluate` logs
  (below) may show whether the back-merge is caught, but whether GitHub
  evaluates a merge-queue rule in `evaluate` mode at all is unverified, so
  check the first run and be ready to test the back-merge another way.
- **The Windows/macOS lane.** Moving it off PR runs is a separate switch, the
  repo variable `GSD_PR_LINUX_ONLY` (#5604). Set it only once the queue is
  enforced; until then Windows and macOS would first run after merge.

**`sync-rulesets.sh` applies every file with one `ENFORCEMENT` value.** Its
default run (`ENFORCEMENT=evaluate`) creates `next-queue` in `evaluate` mode,
and running `ENFORCEMENT=active` to activate the other rulesets would activate
`next-queue` too. To activate only the others, PUT them one at a time with `gh api`, or
leave `next-queue` out until you intend to enforce it.

## Reviewed or maintainer (advisory check, #5607)

`.github/workflows/reviewed-or-maintainer.yml` reports a status context named
`Reviewed or maintainer`. A PR passes when **either**:

- its author is listed in [`.github/MAINTAINERS`](../.github/MAINTAINERS) (no
  second reviewer needed), **or**
- someone other than the author, with `write`, `maintain` or `admin`
  permission, has an `APPROVED` review as their latest standing review **on the
  PR's current head commit**.

A stale approval (older head), the author's own review, a read-only reviewer, a
later dismissal or change request by the same reviewer, an unreadable
maintainer file, and a failed review listing (the collect step errors, so the
job fails) all fail the check. A later plain comment does
not withdraw an approval. This is why it exists: a ruleset's review count is one
number for every author, so it cannot say "required unless the author is a
maintainer", and the sole maintainer cannot approve their own PR, which pushed
merges onto `--admin`.

The workflow checks out the **base** sha and runs the policy script and reads
`MAINTAINERS` from there, so a PR cannot add its own author to the list. (The
workflow *file* is loaded from the default branch on `pull_request_target`, but
from the PR's merge ref on `pull_request_review`; see the promotion note
below.) The check is **advisory**:
it is not a required context on any ruleset and `next`'s one-review classic
protection is unchanged. It is promoted only after it has been observed on real
PRs, because whether a check run created by a `pull_request_review` event
attaches to the PR head like a `pull_request_target` one is unverified.

Apps and bots (for example `github-actions[bot]`) never count as approvers. The
head commit is read live, not from the event payload. **Before making it
required:** on `pull_request_review` for a fork PR the workflow file is loaded
from the PR's merge ref, so a fork author could emit a passing job with this
name. Evaluate only on `pull_request_target` (re-triggered on review events from
a base-branch workflow) before requiring it.

## 4-PR Rollout Plan

| PR | Branch | Action |
|----|--------|--------|
| PR-1 | `chore/branch-protection-specs` | Check in spec files; `enforcement: disabled` — no effect on repo |
| PR-2 | `chore/tiered-ci-gate` | Add tiered test scope detection to `test.yml`; doc-only PRs satisfy `Required tests` without macOS/Windows noop queues |
| PR-3 | `chore/branch-protection-evaluate` | Run `sync-rulesets.sh` with `ENFORCEMENT=evaluate`; 1-week dry-run via rule-suite logs |
| PR-4 | `chore/branch-protection-active` | Run `sync-rulesets.sh` with `ENFORCEMENT=active`; protection live |

## Running `sync-rulesets.sh`

**Prerequisites:** `gh` authenticated with repo-admin scope, `jq` installed.

```bash
# Dry-run (evaluate mode — logs violations, does not block)
REPO=open-gsd/gsd-core ENFORCEMENT=evaluate bash scripts/sync-rulesets.sh

# Activate protection
REPO=open-gsd/gsd-core ENFORCEMENT=active bash scripts/sync-rulesets.sh

# Roll back to disabled
REPO=open-gsd/gsd-core ENFORCEMENT=disabled bash scripts/sync-rulesets.sh
```

The script is idempotent: running it twice with the same `ENFORCEMENT` value
is a no-op semantically (PUT with identical body).

## Reading evaluate-mode logs

After applying with `evaluate`, check which PRs/pushes would have been blocked:

```bash
REPO=open-gsd/gsd-core
RULESET_ID=$(gh api repos/$REPO/rulesets --jq '.[] | select(.name=="main-protection") | .id')
gh api repos/$REPO/rulesets/$RULESET_ID/rule-suites
```

Each entry shows the actor, ref, result (`pass`/`fail`), and which rules
triggered. Use this to validate no legitimate workflows are broken before
flipping to `active` in PR-3.


## Test scope detection

The `test.yml` workflow always runs, but its `changes` job classifies the PR
with `scripts/ci-test-scope.cjs` before starting expensive runners. The required
branch-protection context is the single aggregate `Required tests` job.

Doc-only PRs run the lightweight lint and aggregate jobs only. Code-touching PRs
run the default required matrix:

- Ubuntu / Node 24 scoped tests
- Ubuntu / Node 24 unit, integration, and security suites
- Windows / Node 24 scoped Windows/path/shell tests
- Ubuntu / Node 24 coverage

PRs that touch workflow, package, test-runner, install, release, or Windows
sensitive surfaces also run install/slow on the primary Ubuntu lane and the full
parity matrix:

- Windows / Node 24
- macOS / Node 24

### Canonical code-paths list

The `changes` job treats these paths as code-touching:

```
bin/**
gsd-core/**
agents/**
commands/**
hooks/**
tests/**
scripts/**
package.json
package-lock.json
tsconfig*.json
.github/workflows/**
.github/rulesets/**
```

This list should stay aligned with changeset/docs policy where those gates care
about the same user-facing surfaces.

### Adding a new code path

When adding a directory or file that should trigger real tests:

1. Add the path classifier to `scripts/ci-test-scope.cjs`.
2. Add targeted tests for that surface in the same classifier.
3. If it requires macOS/extra-Windows coverage, mark the classifier rule
   `fullMatrix: true`.
4. Add the same glob to `changeset-required.yml` if changesets should be required
   for that path

The old `test-skip.yml` inverse-path workflow was removed. Do not add required
checks for individual matrix jobs; require the aggregate `Required tests` context
instead.

## Phase-2 TODO

Enable the `required_signatures` rule (signed commits) once agent commits sign
uniformly. As of PR-1 this rule is intentionally omitted — unsigned agent
commits would be blocked by it. Track readiness in the issue linked to PR-3.
