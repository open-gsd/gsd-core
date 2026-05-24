# ADR-0175: Harden release-workflow version validation — reject leading zeros and pre-check npm

- **Status:** Accepted (2026-05-24)
- **Date:** 2026-05-24

## Context

### The leading-zero normalization incident

The release workflow's `validate-version` job used the regex `^[0-9]+\.[0-9]+\.0$` to gate the `version` input. This regex accepts leading zeros in any segment (`1.01.0`, `01.0.0`, etc.) because `[0-9]+` matches one or more digits without anchoring against a leading zero.

A maintainer triggered the workflow with `version=1.01.0`. The validator accepted it. Downstream steps called `npm version 1.01.0`, which silently normalized the string to `1.1.0` per the semver specification (leading zeros are stripped). From that point the pipeline had irreconcilably divergent state:

| Artifact | Value |
|---|---|
| npm registry (`@opengsd/get-shit-done-redux`, `@opengsd/gsd-sdk`) | `1.1.0` — published, immutable |
| git tag | `v1.01.0` |
| GitHub release title | `v1.1.0` |
| GitHub release tag | `v1.01.0` |
| Release branch | `release/1.01.0` |

The workflow run ultimately failed downstream. A subsequent attempt to re-run finalize for `version=1.1.0` failed at the `Dry-run publish validation` step because npm refuses to republish an already-published version.

A second typo (`version=1.03.0`) produced a similar orphan tag and branch but never published to npm.

### The duplicate-version late-failure hole

The validator only checked format. It did not check whether the requested version was already live on npm. A duplicate-version request (e.g. re-running `finalize` for an already-published version, or mistyping a version that normalizes to one already published) ran through the full checkout → install → build → test cycle — roughly 10 minutes — before failing at the `Dry-run publish validation` step.

## Decision

### 1. Tighten the format regex to forbid leading zeros

Replace `^[0-9]+\.[0-9]+\.0$` with `^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.0$`.

Each segment now matches either `0` exactly or a string starting with a non-zero digit followed by zero or more digits. `1.01.0` fails because the minor segment `01` matches neither alternative. The error message includes the offending value so maintainers can correct it immediately.

The `IS_MAJOR` detection regex is updated in parallel: `^[0-9]+\.0\.0$` → `^(0|[1-9][0-9]*)\.0\.0$`.

### 2. Add a duplicate-version precheck against npm at validation time

A new `Reject already-published versions` step runs immediately after format validation in the `validate-version` job. It calls `npm view "$pkg@$VERSION" version` for both `@opengsd/get-shit-done-redux` and `@opengsd/gsd-sdk`. If either resolves, the job fails in under 5 seconds with a clear error. No build or test cycle is wasted.

## Recovery sequence

The following steps recover the production state left by the `1.01.0` and `1.03.0` incidents. Include them here so future maintainers do not need to re-derive them.

### 1. Cancel any failing in-flight runs

```sh
gh run cancel <run-id> --repo open-gsd/get-shit-done-redux
```

### 2. Fix the v1.1.0 divergence (npm published, tag/release/branch on wrong name)

```sh
# Fetch the release branch that holds the correct package.json at 1.1.0
git fetch origin release/1.1.0

# Create a proper v1.1.0 tag at the head of release/1.1.0
git tag v1.1.0 <sha-of-release/1.1.0-head>
git push origin v1.1.0

# Retarget the existing GitHub release from the typo tag to the correct one
gh release edit v1.01.0 --repo open-gsd/get-shit-done-redux --tag v1.1.0
gh release edit v1.1.0  --repo open-gsd/get-shit-done-redux --verify-tag

# Delete the typo tag and branch
git push origin :refs/tags/v1.01.0
git push origin --delete release/1.01.0
```

### 3. Clean the unpublished v1.03.0 orphan

```sh
git push origin :refs/tags/v1.03.0
git push origin --delete release/1.03.0
```

### 4. Resume releases at 1.2.0

`1.1.0` is consumed on npm and the workflow only allows `.0` patch-component versions. The next valid release is `1.2.0`.

## Consequences

- **Valid inputs are unaffected.** The new regex accepts every version that the old regex accepted minus leading-zero forms. All existing release runs used well-formed versions; no regression for normal use.
- **Leading-zero inputs fail in under 5 seconds** at the `validate-version` job before any branch, install, or publish operation runs.
- **Duplicate-version inputs fail in under 5 seconds** at `validate-version` rather than after a full install-and-test cycle.
- **The late dry-run check in `finalize` is unchanged.** It remains a belt-and-suspenders guard; the new precheck does not remove it.
