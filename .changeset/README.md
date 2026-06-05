# Changeset Fragments

This directory holds **per-PR CHANGELOG fragments**. Every PR with user-facing changes drops one (or more) `<random-name>.md` files here describing its CHANGELOG entry. Fragments are consolidated into the top-level `CHANGELOG.md` at release time.

## Why

Two PRs that both edit the `### Fixed` block of `CHANGELOG.md` always conflict on merge — git can't pick a serialization order without human input. Two PRs that each add a fresh `.changeset/<unique-name>.md` never conflict because they don't share lines.

See [#2975](https://github.com/open-gsd/get-shit-done-redux/issues/2975) for the full rationale.

## Adding a fragment

```bash
node scripts/changeset/new.cjs \
  --type Fixed \
  --pr 1234 \
  --body "fix the thing — explain the user-visible change in one sentence"
```

This writes `.changeset/<adjective>-<noun>-<noun>.md` with frontmatter and a body. Three random words → concurrent PRs don't collide.

## Format

```md
---
type: Fixed
pr: 1234
---
**`/gsd-foo` no longer drops trailing slashes** — explain the user-visible change.
```

Allowed `type:` values follow [Keep a Changelog](https://keepachangelog.com/): `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.

## Opting out

PRs that legitimately have no user-facing impact can add the `no-changelog` label. CI honors it. When unsure, add the fragment.

## At release time

Promotion is **automatic**. The release workflow's `finalize` job runs:

```bash
node scripts/changeset/cli.cjs render --version vX.Y.Z --date YYYY-MM-DD --allow-empty
```

This reads every fragment, groups bullets by `type:`, replaces `## [Unreleased]` with a new `## [vX.Y.Z] - YYYY-MM-DD` block, opens a fresh `## [Unreleased]` above, and deletes consumed fragments. The `--allow-empty` flag ensures a no-change release still gets a dated heading (with a `_No notable changes._` placeholder). A subsequent `verify` step confirms the promotion landed correctly. Maintainers do **not** run this by hand.
