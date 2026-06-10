## Summary

`next` is currently **red** across the full-test matrix (macOS 22/24, Windows 22) and the ubuntu-24 coverage leg. Root-caused to commit `88e30d53` (PR #996, which closed #969 "fix stale-build flake"). The commit right before it (`d617735b`) was green.

## Root cause

`#996` did two things that interact badly with the **concurrent** `node --test` runner:

1. Added `tests/bug-969-test-infra-flake-hardening.test.cjs` whose two destructive tests `fs.unlinkSync` the **real shared** `gsd-core/bin/lib/core.cjs` (and the real build tsbuildinfo) mid-run, rebuilding/restoring in `finally`. Because `node --test` runs files concurrently, any other test that `require`s `core.cjs` during that window fails with `Cannot find module .../gsd-core/bin/lib/core.cjs`. This is a textbook **real-race test** (forbidden by `RULESET.TESTS.delete-bad-tests`).
2. Set `tsBuildInfoFile: "gsd-core/bin/tsconfig.build.tsbuildinfo"` — placing mutable build state **inside `gsd-core/bin/`**, a directory install tests copy recursively via `fs.cpSync`. A concurrent rebuild writing/unlinking that file races the copy → `copyfile ENOENT`.

Symptom: ~40–50 tests fail per leg with `MODULE_NOT_FOUND`/`ENOENT`; leg-asymmetric (timing-sensitive). Reproduced locally on the first iteration of running the bug-969 test concurrently with `state.test.cjs` + `install.test.cjs`.

## Impact

`next` red ⇒ branch protection blocks **all** PRs from merging (Required tests fails).

## Fix (fix-forward)

- Make the two destructive `bug-969` tests **hermetic** — exercise a parameterized `ensureBuiltArtifacts(overrides)` against a throwaway temp TS project; never touch real `gsd-core/bin/lib`.
- Move `tsconfig.build.tsbuildinfo` **out of `gsd-core/bin/`** to the repo root (gitignored); self-heal stale bin-local copies on persistent workspaces.

## Verification

- 10× concurrent race check clean (was iter-1 repro before).
- Full unit suite: 4775 pass / 0 fail through the modified runner.
