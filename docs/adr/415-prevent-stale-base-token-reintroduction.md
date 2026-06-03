# ADR 415: Prevent stale-base reintroduction of retired runtime tokens

- **Status:** Accepted (2026-05-28)
- **Date:** 2026-05-28
- **Tracking issue:** [#415](https://github.com/open-gsd/get-shit-done-redux/issues/415) (incident #411; fix #412; culprit #406; rename #373/#379)

## Context

### The `$GSD_SDK` → `gsd_run` rename (#373/#379)

PRs #373 and #379 renamed the runtime resolver from the unquoted `$GSD_SDK` shell variable to a single-line, space-safe `gsd_run` launcher. The launcher is defined in `gsd-core/workflows/_runtime-launcher.snippet.sh`, propagated to all workflow `.md` files by `scripts/sync-runtime-launcher.cjs`, and enforced by `tests/runtime-launcher-parity.test.cjs` (which forbids any `$GSD_SDK` token in workflow markdown).

### The silent regression (#406)

During a multi-PR merge sweep, PR #406 (`fix(#160)`) — branched **before** #379 — re-introduced 5 `$GSD_SDK` occurrences into `gsd-core/workflows/next.md`. Because it edited a **different** region of the file than #379, the merge produced no textual conflict and Git accepted it silently.

#406's own CI was green because its base predated the parity test, and nothing re-checked the merge result against current `next`. #406 also carried a stale companion assertion (`tests/policy-160-route0-resume.test.cjs`) that **required** `$GSD_SDK` to be present.

### Discovery and fix

The regression surfaced only when all PRs co-resided on `next` and the parity gate went red. Fixed in #411 and #412.

### Root cause

A green PR on a stale base can still regress the integration branch via a **semantic** change that has no textual conflict. Textual conflicts are loud; semantic regressions are silent. Only a test run against the **merge result** catches them — which never happened because the base was stale and up-to-date-with-base was not required before merge.

## Decision

1. **Require up-to-date base before merge.** Enable `required_status_checks.strict = true` on `next` (already applied). Every PR must be up to date with the base before merging, forcing CI — including `runtime-launcher-parity` and the full suite — to run against the actual merge result, catching silent semantic regressions before they land.

2. **The canonical propagator is the single source of truth for the runtime launcher.** Never hand-author or hand-edit the launcher token in workflow `.md` files. Changes to the launcher form go through `_runtime-launcher.snippet.sh` + `scripts/sync-runtime-launcher.cjs`, gated by `runtime-launcher-parity.test.cjs`. The retired `$GSD_SDK` token must never reappear.

3. **Companion tests must track the canonical form.** A test asserting the presence of a resolver token must assert the **current** canonical token (`gsd_run`), never a retired one; update propagated files and token-pinning tests in the same change.

4. **Admin-override caveat (process).** `enforce_admins` remains `false` so maintainers keep `--admin` for routine flow. But because this incident was caused by `--admin` batch-merging stale-base PRs, maintainers **must not** `--admin`-bypass the up-to-date requirement for any PR touching workflow `.md` files (or other parity-gated, propagated artifacts): rebase and re-run the gate first. When batch-merging, merge structural-rename/propagation PRs **last**, or re-run the parity gate on the integration branch after the batch.

## Consequences

### Positive

- Silent stale-base semantic regressions (not just `$GSD_SDK`) are caught pre-merge for normal merges.
- The canonical-propagator rule and parity test give a single testable source of truth and an unambiguous reviewer/agent rule.
- Decision 4 names the exact failure mode for admin-bypass merges.

### Negative

- `strict = true` adds rebase/CI churn: PRs behind `next` must update before merging.
- The guard is not absolute. `--admin` can still bypass `strict` (`enforce_admins = false`), so admin merges rely on the Decision-4 discipline rather than a hard block.
- Making it absolute would require `enforce_admins = true`, intentionally **not** adopted — it would block the maintainer's routine `--admin` flow.

## Alternatives Considered

**(a) Documentation and discipline only** — rejected. Discipline alone proved insufficient under batch merges.

**(b) `enforce_admins = true`** — rejected. Too heavy for a solo-maintainer repo dependent on `--admin`. Decision 4 addresses the admin path instead.

**(c) A bespoke "retired-token" CI check diffing sync-script output** — rejected as redundant. `runtime-launcher-parity` already forbids the token; the real gap was running it against the merge result, which Decision 1 fixes generally.

## References

- Incident: #411
- Fix: #412
- Culprit PR: #406 (`fix(#160)`)
- Rename PRs: #373, #379 (`gsd_run`)
- Propagator: `scripts/sync-runtime-launcher.cjs`
- Parity test: `tests/runtime-launcher-parity.test.cjs`
- Launcher snippet: `gsd-core/workflows/_runtime-launcher.snippet.sh`
- Tracking issue: #415
