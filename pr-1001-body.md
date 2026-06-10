## Fix PR

## Linked Issue

Fixes #1001

The linked issue carries the `confirmed-bug` label.

## What was broken

`next` went red across the full-test matrix (macOS 22/24, Windows 22) and the ubuntu-24 coverage leg — `Required tests` failing, blocking **all** PRs from merging. Root-caused to `88e30d53` (PR #996, which closed #969). The commit immediately before it on `next` (`d617735b`) was green.

## Root cause

`#996` interacts badly with the concurrent `node --test` runner:

1. `tests/bug-969-test-infra-flake-hardening.test.cjs` had two tests that `fs.unlinkSync` the **real shared** `gsd-core/bin/lib/core.cjs` (and the real build tsbuildinfo) mid-run, restoring in `finally`. Files run concurrently, so any other test requiring `core.cjs` in that window fails with `Cannot find module .../gsd-core/bin/lib/core.cjs` — a **real-race test** (`RULESET.TESTS.delete-bad-tests`).
2. `tsBuildInfoFile` was placed at `gsd-core/bin/tsconfig.build.tsbuildinfo` — mutable build state **inside** the `gsd-core/bin/` tree that install tests copy recursively (`fs.cpSync`). A concurrent rebuild writing/unlinking it races the copy → `copyfile ENOENT`.

Reproduced locally on the first concurrent iteration of the bug-969 test + `state.test.cjs` + `install.test.cjs`.

## The fix

- **Hermetic tests:** `ensureBuiltArtifacts()` is now `ensureBuiltArtifacts(overrides = {})` (root/srcDir/outDir/tsBuildInfoPath/tsconfigPath overridable; production no-arg behavior unchanged). The bug-969 destructive tests (and the sentinel test) now build/delete/re-emit inside a throwaway temp TS project — they never touch real `gsd-core/bin/lib`.
- **Relocated build state:** `tsconfig.build.tsbuildinfo` moved to the repo root (gitignored), out of the copied/shipped tree. `ensureBuiltArtifacts` best-effort-purges any stale `gsd-core/bin/tsconfig.build.tsbuildinfo` so persistent workspaces/mirrors self-heal.

## Testing

- Regression reproduced on broken code (iter 1); **10× concurrent race check clean** after the fix.
- Full unit suite through the modified runner: **4775 pass / 0 fail**.
- `bug-969` suite 6/6; eslint + `lint-command-contract` clean.
- Independent codex adversarial review (findings — legacy-purge, sentinel hermeticity — folded in).

## Checklist

- [x] Linked issue carries `confirmed-bug`
- [x] Branch `fix/1001-bug969-real-race`
- [x] Conventional commits
- [x] Changeset fragment (`type: Fixed`)
- [x] Regression test made hermetic + fail-first reproduced
