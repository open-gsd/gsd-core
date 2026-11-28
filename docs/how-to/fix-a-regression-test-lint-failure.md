# Fix a regression-test-name or duplicate-fold lint failure

You pushed a change and `npm run lint:regression-names` or `local/no-duplicate-fold-marker`
failed. This page says what to do for each. The reasoning is in
[Why the test suites are guarded the way they are](../explanation/testing-suites-design.md#why-regression-tests-are-folded-not-filed-one-per-bug).

## A new `bug-*`, `fix-*` or `issue-*` file fails the ratchet

Fold it into the owning module's test file (for example a `describe('regressions')` block in
`tests/<module>.test.cjs`) and delete the new file. Files named `feat-NNNN-*` and
`enh-NNNN-*` are feature test files and are not covered by the ratchet.

## You deleted or consolidated a grandfathered file

Prune its entry from `scripts/lint-regression-test-names.allowlist.json`, so the baseline only
ever shrinks.

## The failure names files your PR did not add

Inherited drift (the failure names files your PR didn't add — e.g. the
base branch merged `bug-*`/`fix-*`/`issue-*` files without feeding the
allowlist, or you rebased and carried a pre-rebase allowlist): run
`node scripts/lint-regression-test-names.cjs --update` and commit the
regenerated allowlist. Snapshot artifacts like this allowlist (and
`docs/INVENTORY.md`) must be regenerated **after** rebasing, never carried
through a rebase.

## `local/no-duplicate-fold-marker` fires

The rule reports the second and every later occurrence of a `folded:<marker>` title in one
file, naming the line the first occurrence sits on. Delete the copy it points at. The two
blocks are the same suite, so the fix is removal, never an `eslint-disable`.
