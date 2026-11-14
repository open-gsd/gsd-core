# ADR-3628: Milestone release mapping — a GSD milestone version is not a repository release version

- **Status:** Accepted
- **Date:** 2026-10-25
- **Issue:** [#3628](https://github.com/open-gsd/gsd-core/issues/3628) (epic); this ADR is Phase 0, [#5704](https://github.com/open-gsd/gsd-core/issues/5704)

## Context

`/gsd-complete-milestone` ends by creating one annotated tag `v[X.Y]` in the current working directory (`gsd-core/workflows/complete-milestone/steps/git-tag.md`) and asking whether to push it. Whether that step runs is one boolean, `git.create_tag` (`src/config.cts`, boolean-only per #3086; exposed to the workflow as `git_create_tag` by `cmdInitCompleteMilestone`, `src/init.cts`).

That model assumes one milestone maps to one repository whose version sequence is the milestone's. A project that declares `planning.sub_repos` (`gsd-core/references/git-integration.md`) breaks the assumption: one milestone delivers a feature across several independently versioned repositories, some released, some only deployed to a development environment, each with its own version sequence. Today the developer must create a tag that is true for none of them, disable tagging and lose the trace, or tag outside GSD.

The multi-repository half of GSD already exists for commits: `detectSubRepos`, `groupFilesBySubrepo` and `cmdCommitToSubrepo` (`src/commands.cts`) fan one logical operation out across repositories and return a per-repository result. Neither `complete-milestone.md` nor `git-tag.md` references `sub_repos`.

Two facts constrain the design:

1. **`loadConfig` rewrites `planning.sub_repos` from the filesystem** on every load, adding new repositories and removing deleted ones (`git-integration.md`, "Auto-detection"). A record keyed by repository and derived from that list at read time can change without user action.
2. **Milestone identity is bound to one canonical locator** (#3216, specified by ADR-3180 §7.2). A milestone-scoped record must use that identity, not mint a second key.

## Decision

1. **Two distinct concepts.** The *milestone version* names a unit of planned work in `.planning/` (`v1.2`). A *repository release version* names what one repository published. They are not required to be equal, related, or drawn from one sequence. Documentation must say so wherever a milestone tag is described.

2. **A release mapping is a milestone-scoped record.** For each repository that took part in the milestone it holds: the release version or tag, a commit or PR reference, the target environment, the delivery status, and whether a tag was created or skipped. A repository with no release remains in the mapping with an explicit skip.

3. **The mapping is archived by recorded value.** At completion the full mapping is written into the milestone archive and `MILESTONES.md` as data. Reading history never re-derives it from `planning.sub_repos`. A repository that later leaves `planning.sub_repos`, or is deleted on disk, stays in the archived mapping exactly as recorded; a repository added later does not appear in the mapping of a milestone completed before it existed.

4. **The mapping binds to the canonical milestone locator** (ADR-3180 §7.2), not to a new key.

5. **Opt-in, additive.** The existing `git.create_tag` boolean keeps its current single-repository semantics and its pinned regression tests (the `#3086: git.create_tag config key` block in `tests/config.test.cjs`). A project without `planning.sub_repos`, or without the new repository-tagging mode, behaves exactly as before. Existing archives without a mapping continue to parse.

6. **The transactional half is a command, not workflow prose.** Preflight of every requested tag before the first write, per-repository results that name tags already created on partial failure, no overwrite of an existing tag, and idempotent retry are guarantees. They are implemented as a `gsd-tools` verb modeled on `cmdCommitToSubrepo`, and the workflow step only calls it. Every git operation runs with the target repository as its working directory, so the result does not depend on the invoking directory. Every git subprocess is bounded by a timeout and degrades to a per-repository result entry; none throws.

7. **No implicit push.** Creating tags never pushes. A push is a separate explicit confirmation per repository that names the repository and its remote.

8. **One repository-resolution path.** The new verb reuses `detectSubRepos` and the `commit-to-subrepo` resolution rather than adding a second multi-repository resolver. A parity assertion test guards any constant or parser two surfaces share.

9. **A new configuration key is registered where `loadConfig` reads it.** It lands in the config schema (`VALID_CONFIG_KEYS`, built from the generated schema manifest in `src/configuration.cts`) and, if it has a legacy placement, in `normalizeLegacyKeys`, in the same change as the key. The generated defaults and schema manifests are produced by `npm run regen:derived`, so the key cannot read as absent.

## Phase ownership

Each behavioral acceptance criterion of #3628 is owned by exactly one phase. The criterion requiring automated tests is not a deliverable of its own: each phase carries the tests for the behavior it owns.

| Phase | Deliverable | Acceptance criteria of #3628 |
|---|---|---|
| 0 (#5704) | This ADR | Design lock for all phases |
| 1 (#5705) | Repository-scoped preflight and tag command | Preflight of every requested repository path, ref and tag value before the first tag; existing tags never overwritten; correct repository regardless of invoking directory; per-repository failure reporting and idempotent retry |
| 2 (#5706) | Config key, release-map schema, archive persistence | `create_tag: true` and `false` projects unchanged; independent tag value or explicit skip per repository; tag/version, reference, environment and status recorded; skipped repositories stay in the archived mapping; archives preserve the complete mapping |
| 3 (#5707) | Workflow routing, push confirmation, English documentation | No push without explicit confirmation naming repository and remote; documentation states that a milestone version may differ from repository release versions |
| 4 (#5708) | Translated `CONFIGURATION.md` locales | Locale parity for Phase 3 documentation |

The criterion requiring automated tests (single-repository compatibility, mixed per-repository values, duplicate tags, invalid repository paths, detached HEAD, partial failure, retries, push refusal) is carried by Phases 1, 2 and 3 for the behavior each introduces.

## Rejected alternatives

- **Use the milestone version as the tag in every repository.** Independently released repositories share no version sequence and not all are released.
- **Tie the milestone number to one primary repository.** It privileges one repository and misrepresents the rest.
- **Keep `git.create_tag: false` and maintain a table by hand.** The safe workaround, but it loses validation and consistent archival and drifts from planning history.
- **Run an external release script after completion.** Tag creation works, but the versions and statuses never become milestone evidence.
- **One GSD project per repository.** Rejected for features whose requirements and phases are intentionally cross-repository.
- **Ship release tagging as an environment plugin capability.** It would put a seam through one domain concept (commit routing stays in core while tagging leaves) and stake a transactional guarantee on the capability-dispatch substrate. The milestone archive would also have to accept third-party-written state.
- **Derive the mapping from `planning.sub_repos` at read time.** Contradicts decision 3, because that list rewrites itself from the filesystem.

## Consequences

**Positive:** a milestone can record what each repository actually released, including repositories deliberately left untagged. The archive remains a faithful history after repositories are added or removed. Atomic-looking behavior (preflight, no overwrite, idempotent retry) is testable because it lives in a command.

**Cost:** a new planning concept (the release mapping) and a new archive section to keep backward compatible; partial-failure and retry semantics across N repositories to maintain; a new configuration key with generated manifests, SDK type, and translated documentation to keep in sync; a new CLI verb with its inventory, glossary and size-baseline ripples.

**Known limit:** the push confirmation remains an instruction followed by the agent in a workflow, as the single-repository prompt is today. The safe default is no push, and the verb never pushes, which bounds the exposure; this ADR does not add a machine-enforced push gate.
