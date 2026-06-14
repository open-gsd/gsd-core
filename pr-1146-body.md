## Fix PR

---

## Linked Issue

Fixes #1146

> The linked issue must have the `confirmed-bug` label. If it doesn't, ask a maintainer to confirm the bug before continuing.

---

## What was broken

Five forking workflows (`execute-phase`, `quick`, `ship`, `complete-milestone`, `pr-branch`) detected the default branch with duplicated per-workflow bash that only consulted `git symbolic-ref --short refs/remotes/origin/HEAD` then hardcoded a `:-main` fallback. `origin/HEAD` is unset in common cases (git init + remote add + fetch without set-head, most CI checkouts, many worktrees). Detection fell through to hardcoded `main` even on `master` repos, causing GSD to fork phase and quick branches off a non-existent `main` base and target PRs at the wrong branch.

## What this fix does

Introduces a single `git-base-branch.cjs` CJS module (TypeScript source `src/git-base-branch.cts`) that exposes `gsd_run query git.base-branch`. Workflows call this one resolver instead of each duplicating their own detection bash. The resolver implements the full precedence ladder:

1. `git.base_branch` config override from `.planning/config.json`
2. `git symbolic-ref --short refs/remotes/origin/HEAD` (fast, no network)
3. `git remote show origin` HEAD branch — **authoritative when origin/HEAD unset**
4. Local branch existence (`master` present and `main` absent → `master`; `main` present → `main`)
5. `"main"` (last-resort default)

All git subprocesses are bounded with timeouts (5–15 s) and degrade gracefully to the next tier — the function never throws.

## Root cause

`git symbolic-ref refs/remotes/origin/HEAD` returns nothing when the remote-tracking HEAD pointer was never set. This happens with `git init && git remote add origin && git fetch` (the most common CI pattern) without `git remote set-head origin -a`. The previous code then applied `${DEFAULT_BRANCH:-main}`, producing an incorrect fallback for any non-`main` default branch.

## Testing

### How I verified the fix

- Test C ("KEY REGRESSION — master repo, origin/HEAD unset → returns `master` not `main`") was the canonical regression proof. It sets up a bare `master` repo, adds it as a remote, fetches (then explicitly deletes `origin/HEAD`), and asserts `gsd_run query git.base-branch` returns `master`, not `main`.
- Test G (anti-regression guard) asserts that none of the five affected workflow files contain the `:-main`/`:-master` fallback pattern and that all five call `gsd_run query git.base-branch`.

### Regression test added?

- [x] Yes — added a test that would have caught this bug

`tests/git-base-branch.test.cjs` — 7 tests covering the full precedence ladder. All tests were written first and failed before the implementation, confirming TDD.

### Platforms tested

- [x] macOS
- [ ] Windows (including backslash path handling)
- [ ] Linux
- [ ] N/A (not platform-specific)

### Runtimes tested

- [x] Claude Code
- [ ] Gemini CLI
- [ ] OpenCode
- [x] N/A — resolver is pure git/CJS, not runtime-specific

---

## Checklist

- [x] Issue linked above with `Fixes #1146` — **PR will be auto-closed if missing**
- [x] Linked issue has the `confirmed-bug` label
- [x] Fix is scoped to the reported bug — no unrelated changes included
- [x] Regression test added (or explained why not)
- [x] All existing tests pass (`npm test`) — 886 pass, 0 fail
- [x] `.changeset/` fragment added (`brave-foxes-leap.md`, type: Fixed)
- [x] No unnecessary dependencies added

## Breaking changes

None
