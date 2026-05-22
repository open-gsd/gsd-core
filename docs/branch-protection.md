# Branch Protection Rollout

## Rulesets

Three ruleset specs live under `.github/rulesets/`. All are committed with
`enforcement: disabled` and activated in stages via the 3-PR rollout below.

### `main-protection`
Targets `~DEFAULT_BRANCH` (main). Enforces:
- No deletions or force pushes
- Required linear history (no merge commits)
- All changes via pull request (0 required approvals, stale-review dismissal, thread resolution required, squash/rebase only)
- 10 required status checks: lint, Node 22/24 matrix (ubuntu/mac/windows), Changeset Required, require-issue-link, pr-template-format

### `release-branches`
Targets `refs/heads/release/**` and `refs/heads/hotfix/**`. Same rules as
`main-protection` except `required_linear_history` is omitted (merge commits
are permitted on release/hotfix branches).

### `tag-immutability`
Targets all tags (`~ALL`). Blocks tag updates and deletions — tags are
immutable once created. Tag creation is unrestricted.

## 4-PR Rollout Plan

| PR | Branch | Action |
|----|--------|--------|
| PR-1 | `chore/branch-protection-specs` | Check in spec files; `enforcement: disabled` — no effect on repo |
| PR-2 | `chore/ci-skip-tests-on-docs` | Add path filter to `test.yml` + new `test-skip.yml` noop; doc-only PRs satisfy required checks in <30s |
| PR-3 | `chore/branch-protection-evaluate` | Run `sync-rulesets.sh` with `ENFORCEMENT=evaluate`; 1-week dry-run via rule-suite logs |
| PR-4 | `chore/branch-protection-active` | Run `sync-rulesets.sh` with `ENFORCEMENT=active`; protection live |

## Running `sync-rulesets.sh`

**Prerequisites:** `gh` authenticated with repo-admin scope, `jq` installed.

```bash
# Dry-run (evaluate mode — logs violations, does not block)
REPO=open-gsd/get-shit-done-redux ENFORCEMENT=evaluate bash scripts/sync-rulesets.sh

# Activate protection
REPO=open-gsd/get-shit-done-redux ENFORCEMENT=active bash scripts/sync-rulesets.sh

# Roll back to disabled
REPO=open-gsd/get-shit-done-redux ENFORCEMENT=disabled bash scripts/sync-rulesets.sh
```

The script is idempotent: running it twice with the same `ENFORCEMENT` value
is a no-op semantically (PUT with identical body).

## Reading evaluate-mode logs

After applying with `evaluate`, check which PRs/pushes would have been blocked:

```bash
REPO=open-gsd/get-shit-done-redux
RULESET_ID=$(gh api repos/$REPO/rulesets --jq '.[] | select(.name=="main-protection") | .id')
gh api repos/$REPO/rulesets/$RULESET_ID/rule-suites
```

Each entry shows the actor, ref, result (`pass`/`fail`), and which rules
triggered. Use this to validate no legitimate workflows are broken before
flipping to `active` in PR-3.


## Path filters

The `test.yml` workflow uses a `paths:` filter on its `pull_request:` trigger so
the 6-lane matrix only runs when code-touching files change. A companion workflow,
`test-skip.yml`, fires on the inverse (`paths-ignore:`) and emits instant noop
jobs with **identical job IDs and matrix dimensions**. This ensures the 7 required
status checks (`lint-tests` + 6× `test (...)`) are always satisfied — whether the
real matrix ran or the noop ran.

### Why dual workflow instead of paths-ignore alone?

GitHub required-status-checks expect a specific context string to appear as
"passed" on every PR. If `test.yml` is suppressed by `paths-ignore` on a doc-only
PR, those contexts never fire and the PR is permanently blocked. The noop workflow
produces the same context strings via matching job IDs + matrix, resolving the
deadlock.

### Canonical code-paths list

Both `test.yml` (`paths:`) and `test-skip.yml` (`paths-ignore:`) use this list:

```
bin/**
get-shit-done/**
agents/**
commands/**
hooks/**
sdk/**
tests/**
scripts/**
package.json
package-lock.json
tsconfig*.json
.github/workflows/test.yml
.github/workflows/test-skip.yml
```

This list also mirrors `changeset-required.yml`'s path filter. Keep all three in sync.

### Adding a new code path

When adding a directory or file that should trigger real tests:

1. Add the glob to `paths:` in `.github/workflows/test.yml`
2. Add the **same** glob to `paths-ignore:` in `.github/workflows/test-skip.yml`
3. Add the same glob to `changeset-required.yml` if changesets should be required
   for that path

Failure to update `test-skip.yml` means doc PRs that happen to touch the new
path will deadlock (real matrix never fires, noop never fires either).

## Phase-2 TODO

Enable the `required_signatures` rule (signed commits) once agent commits sign
uniformly. As of PR-1 this rule is intentionally omitted — unsigned agent
commits would be blocked by it. Track readiness in the issue linked to PR-3.
