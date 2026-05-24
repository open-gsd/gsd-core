# PRD: README Continuity And Release Communications Update

## Linked Issue

- Closes #209

## Problem

The top-level README still mixes legacy transition language, personal attribution, and outdated migration framing. Users need one clear source of truth for:

- canonical repository and package identities
- current maintainer ownership/governance
- migration guidance away from legacy upstream artifacts
- security and audit status references

## Goals

1. Remove legacy personal maintainer attribution from README narrative sections.
2. Present open-gsd continuity messaging in concise, team-owned language.
3. Provide explicit migration guidance from legacy `gsd-build/*` packages to `@opengsd/*`.
4. Reference public announcement and security-audit discussions directly.
5. Keep changes docs-only and non-behavioral.

## Non-Goals

- Any runtime, CLI, or workflow behavior changes.
- Any package publishing process changes.
- Any new security policy implementation beyond documentation updates.

## Scope

- `README.md` top continuity notice
- `README.md` "Why" narrative section rewrite
- release/continuity cross-links and wording cleanup

## User Stories

- As a new user, I can quickly identify which repo/package is canonical.
- As an existing user, I can safely migrate away from legacy package names.
- As a security-conscious user, I can find the public audit status and continuity rationale in one place.

## Acceptance Criteria

1. README contains a continuity notice naming `open-gsd/get-shit-done-redux` as canonical.
2. README removes personal legacy attribution in origin-story prose.
3. README strongly recommends migration away from `gsd-build/*` artifacts.
4. README links to Discussions #109 and #119.
5. README states current audit posture with "no known active exploit" language.

## Risks

- Overstating security claims beyond published evidence.
  - Mitigation: keep wording scoped to publicly posted announcement text.
- Migration warning language may be interpreted as policy rather than recommendation.
  - Mitigation: phrase as a strong recommendation based on ownership and governance reality.

## Rollout

1. Update README content.
2. Open docs PR linked to #209.
3. Run CI and merge once green.
