# ADR 660: Release from the head of `next`; immutable release tags; `@next` dist-tag as the RC surface [Proposed]

- **Status:** Proposed
- **Date:** 2026-06-03

## Context

The release pipeline (`.github/workflows/release.yml`) is a three-mode `workflow_dispatch`
(`create` / `rc` / `finalize`) built around a **persistent, long-lived `release/<version>`
branch**:

- `create` cuts `release/<version>` from `next` and commits a version bump.
- `rc` checks out that same branch (`ref: release/<version>`), bumps to `-rc.N`, tags
  `v<version>-rc.N`, and publishes to the `@next` npm dist-tag.
- `finalize` checks out that same branch, bumps to the final version, tags `v<version>`,
  publishes to `@latest`, opens a PR back to `main`, and `auto-backmerge.yml` later merges
  `main` → `next`.

This has a structural defect. **No job ever brings post-`create` work from `next` into the
release branch** — there is no `git merge`/`rebase`/`cherry-pick` from `next` anywhere in
`release.yml`. So the moment RC testing surfaces a bug:

1. The fix is (correctly) committed to `next` — our trunk.
2. The `release/<version>` branch does **not** receive it.
3. `finalize` therefore ships the *rc-cut* tree, **missing every RC fix**.

To compensate, we have been **hand-moving the `v<version>` tag forward** to the head of
`next` each cycle. This is the "dance every release." It is two documented antipatterns
stacked:

- **Freezing a release branch you never backport into.** Trunk-based development requires fixes
  to flow *trunk → release branch* (fix on trunk, cherry-pick down), never "fix on trunk and
  leave the release branch behind"
  ([trunkbaseddevelopment.com/branch-for-release](https://trunkbaseddevelopment.com/branch-for-release/)).
  GitFlow's own author now steers continuous-delivery projects away from this model
  ([nvie.com](https://nvie.com/posts/a-successful-git-branching-model/)).
- **A movable release tag.** Git's manual ("On Re-tagging") and SemVer both forbid it —
  *"Once a versioned package has been released, the contents of that version MUST NOT be
  modified"* ([semver.org](https://semver.org/)). Moving a published tag breaks our SSH
  signatures, already-fetched clones, caches, and the GitHub Release; GitHub shipped
  *Immutable Releases* (GA 2025) specifically to stop this.

We have meaningful existing investment we want to **keep**: the homegrown changeset/CHANGELOG
fragment system (`scripts/changeset/*.cjs`, `changeset-required.yml`), the curated
release-notes formatter (`scripts/release-notes/format-github-release-notes.cjs`), the
inter-stage smoke-test gates, provenance publishing, and the `main`(@latest) / `next`(integration)
+ `auto-backmerge` topology — which is already the correct "main holds releases, next is
integration" shape.

## Decision

**Stop persisting/freezing the release branch. Always release from the current head of `next`,
create each release git tag exactly once, and treat the `@next` npm dist-tag — not a git branch
or a movable tag — as the RC surface.** Concretely:

1. **The release point is always `next`'s head at invocation time.** `rc` and `finalize` derive
   their tree from the current `origin/next` HEAD rather than reusing a stale `release/<version>`
   branch. Implementation: recreate (or hard-reset) an **ephemeral** `release/<version>` branch
   from `origin/next` HEAD at the *start* of each `rc`/`finalize` run. The final version-bump
   commit lands on this short-lived branch and reaches `main` via the release PR; the branch is
   a scratch staging area, not a frozen snapshot — so it *always* contains every RC fix.

2. **`next` carries a `-dev` prerelease version (the dev stream).** Between releases, `next`'s
   `package.json` no longer rests at the last-released number — it carries `X.Y.Z-dev.N` for the
   *anticipated* next version, so the trunk self-identifies as unreleased. Default floor after
   releasing `A.B.C` is the next patch, `A.B.(C+1)-dev.0` (precedence-safe: greater than `A.B.C`,
   and it never overstates the eventual release, which `finalize` may set higher). `@next`
   dist-tag publishes carry this `-dev` snapshot identity; `rc` overrides it with the chosen
   `-rc.N`; `finalize` sets the final number. After `finalize` + the `main`→`next` backmerge, a
   post-release step bumps `next` to the new `-dev` floor.

3. **Release tags are immutable, created once, by `finalize` only.** No tag is ever
   pre-created as a placeholder or force-moved. `finalize` mints `v<version>` on the final
   commit and pushes it once. (This also removes the manual step that currently *breaks*
   `finalize`, whose tag-existence guard hard-errors on any pre-existing `v<version>` tag.)
   RC tags `v<version>-rc.N` remain — each N is unique and never moved, so they are already
   immutable and serve the GitHub prerelease.

4. **RC = the `@next` dist-tag, full stop.** Testers run `npm i -g @opengsd/gsd-core@next`.
   Because each `rc` run is cut from `next` HEAD, every rc.N already includes all prior fixes.
   No long-lived branch, no tag movement. `finalize` promotes the released version to `@latest`
   (`@next` remains the prerelease channel managed exclusively by the `rc` job; `finalize` does not repoint it).

5. **Everything else stays:** custom changesets + CHANGELOG render, release-notes formatter,
   smoke-test gates, provenance, `main`/`next`, `auto-backmerge` (main→next).

In short: the immutable `v<version>` tag that `finalize` creates — landing on `main` via the
release→main PR — **is** the "historical marker for the release" we wanted. The intuition was
right; only the *movable placeholder* mechanic was wrong.

## Alternatives considered

- **Adopt `release-please`.** Auto-updating Release PR off `next` would also kill the freeze, and
  tags are immutable. **Rejected for now:** it generates CHANGELOG from conventional commits,
  displacing our custom changeset-fragment system; its prerelease→stable transition has known
  open bugs (googleapis/release-please #2515, #2447). Migration cost > the defect it fixes.
- **Adopt `@changesets/cli`.** Closest to our homegrown system and has a mature auto-updating
  Version PR. **Rejected for now:** would replace working in-house tooling, and its `pre`
  mode has real footguns (the `pre.json`-not-staged bug silently publishes stable under the
  `rc` dist-tag — changesets #1150).
- **Adopt `semantic-release`.** Lowest ceremony, native `next`→`main` channel promotion.
  **Rejected:** "auto-release on every conventional commit" removes the deliberate
  "decide to cut a release" gate we want, and again displaces our changeset/changelog system.
- **Keep the persistent branch but cherry-pick RC fixes into it.** The textbook trunk-based
  approach. **Rejected as primary:** for a single active version it is pure bookkeeping
  overhead, and "forgot to cherry-pick" is exactly the regression trap the literature warns
  about. Re-cutting from `next` HEAD gets the same result with zero manual cherry-picks.

## Consequences

**Positive**
- The "dance" is gone: RC fixes are included by construction; no manual tag moves; no frozen
  branch to reconcile.
- Tags become trustworthy and signature-valid — one commit, one immutable tag, per release.
- We keep all existing investment (changesets, formatter, smoke gates, backmerge) — small,
  low-risk diff to `release.yml`, no new third-party release dependency.

**Negative / costs**
- `release.yml` changes required: `rc`/`finalize` must recreate/reset the release branch from
  `origin/next` at start; remove any reliance on a pre-existing tag.
- `create` becomes near-vestigial (its only job — seed the branch + bump — folds into `rc`/
  `finalize` re-cutting from `next`). Decide whether to delete `create` or keep it as an
  optional "open the release branch early" convenience.
- One-version assumption is now explicit: this model does **not** support maintaining multiple
  live majors (LTS). If that need ever arises, revisit (long-lived `release/x.y` + cherry-pick
  is the escape hatch).

## Rollout

- **File this ADR first** (maintainer decision): land the proposing issue + ADR PR before any
  release action, so the model is documented before it is first exercised.
- **1.3.0 (first manual run):** ship it as the first *manual* application of this model —
  recreate `release/1.3.0` from `next` HEAD (`6bd7ceb2`), delete the hand-moved `v1.3.0` tag so
  `finalize` mints it fresh, then run `finalize` (dry-run first). This validates the model by
  hand before we codify it. Immediately after, bump `next` to its first `-dev` floor
  (`1.3.1-dev.0`).
- **Codify (1.4.0+):** update `release.yml` per the Decision (re-cut from `next`, `-dev` stream,
  post-release `-dev` bump); update `docs/branching.md`; delete or repurpose `create`.

## Resolved by maintainer (2026-06-03)

- **Approach:** re-cut from `next`'s head; keep the in-house tooling (no third-party release tool).
- **`next` version:** move to a `-dev` stream (Decision §2), *not* resting at last-released.
- **Sequencing:** file this ADR first, then ship 1.3.0 as the first manual run.

## Open questions (remaining)

1. Delete the `create` action, or keep it as an optional early-branch convenience? *(Recommend:
   delete; re-cut from `next` makes it redundant.)*
2. Keep immutable `v<version>-rc.N` git tags, or rely on the `@next` dist-tag alone for RCs?
   *(Recommend: keep the rc tags — harmless, immutable, and they anchor the GitHub prerelease.)*
3. `-dev` floor increment: next-patch (`A.B.(C+1)-dev.0`, the precedence-safe default above) or
   next-minor (`A.(B+1).0-dev.0`)? *(Recommend: next-patch floor.)*

## Amendment (2026-06-12, #1104): `next` tracks the last published release

**Supersedes** the §2 / "Resolved by maintainer" choice to rest `next` on a `-dev` stream.

The `-dev` floor (e.g. `1.3.1-dev.0`) was never published to npm, yet it became the
source-of-truth version on the default branch and leaked to the real world via source/dev
installs that report `package.json`'s version — a version no release ever bore. To eliminate
phantom versions, `next` now **rests at the last published release** and is synced
automatically by the release pipeline for **every** release type:

- **finalize / hotfix** (these push `main`): the existing `main → next` back-merge
  (`.github/workflows/auto-backmerge.yml`) sets `next`'s version to `main`'s released version,
  folded into the same back-merge PR.
- **rc** (publishes a pre-release to the `release/<version>` branch + `@next`; does **not** push
  `main`): the `rc` job in `.github/workflows/release.yml` opens and admin-merges a
  `chore: sync next package version` PR after a confirmed publish.

Both paths share `scripts/sync-next-version.cjs`, which sets `package.json` and stamps the
runtime manifests (`plugin.json`, `gemini-extension.json`) via the `version` lifecycle hook,
and **refuses any non-release version string** (fail-closed — a `-dev`/placeholder can never be
written to `next` again). Open question 3 (the `-dev` floor increment) is therefore moot: there
is no `-dev` floor.
