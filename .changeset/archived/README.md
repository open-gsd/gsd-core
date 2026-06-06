# Archived changeset fragments

These fragments describe changes that shipped in **gsd-core ≤ 1.3.1**. Their
user-facing notes were already hand-curated into the dated `## [1.2.0]`,
`## [1.3.0]`, and `## [1.3.1]` sections of [`../../CHANGELOG.md`](../../CHANGELOG.md)
during the #690 backfill (PR #694) and the earlier 1.2.0 promotion.

They were never consumed by a `render` run (CHANGELOG promotion was a manual
operator step that was skipped — see [#690](https://github.com/open-gsd/gsd-core/issues/690)),
so they accumulated here. They are retained for provenance only.

## Do not render these

`render` (`scripts/changeset/cli.cjs`) and every other changeset tool enumerate
`.changeset/` **non-recursively**, so nothing in this `archived/` subdirectory is
ever picked up. That is deliberate: rendering these would duplicate and
mis-attribute work that already shipped. Do not move them back to the parent
directory.

Genuinely-unreleased fragments live one level up, in `.changeset/*.md`.
