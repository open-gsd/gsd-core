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

```bash
node scripts/changeset/cli.cjs render --version vX.Y.Z --date YYYY-MM-DD
```

Reads every fragment, groups bullets by `type:`, replaces `## [Unreleased]` with a new `## [vX.Y.Z] - YYYY-MM-DD` block, opens a fresh `## [Unreleased]` above, deletes consumed fragments. Idempotent.

## Archived fragments

`.changeset/archived/` holds fragments for already-shipped releases (≤ 1.3.1), retained for provenance. Their content was hand-curated into the dated `## [1.x.y]` sections of `CHANGELOG.md` during the #690 backfill — they were never consumed by `render`. All changeset tooling enumerates `.changeset/` non-recursively, so archived fragments are never picked up or rendered. Do not move them back to the top level.
