# ADR-1517: Reviewer instances — bounded config surface for same-adapter multi-model review

- **Status:** Accepted
- **Date:** 2026-06-26
- **Issue:** #1517
- **Builds on:** Review Reviewer Selection Module, config-schema manifest (ADR-457 generated single source)

## Context

`/gsd:review` exposes one reviewer identity per built-in slug (`KNOWN_REVIEWER_SLUGS`).
This works when reviewers are independent CLIs (`codex`, `gemini`), but breaks down when a
single model-capable CLI can route to several models. The motivating adapter is **OpenCode**:
a solo developer who wants two OpenCode-backed reviews with different models must manually
flip `review.models.opencode`, rerun, and hand-merge `REVIEWS.md`. That is easy to forget,
easy to overwrite, and does not participate in one review/convergence pass.

The feature (#1517, `approved-feature`) adds a **bounded config surface** so one adapter can
run as several independent reviewer identities. The maintainer's spec-of-record resolved the
three blocking design questions; this ADR pins the resulting contract (field names,
REVIEWS.md section-header format, frontmatter shape) because, once shipped, these become a
depended-on interface (Hyrum's Law).

## Decision

### Config shape

A new `review.reviewer_instances` object under the existing `review` top-level config
namespace. Each entry maps an instance name to `{ cli, model?, agent? }`:

```json
{
  "review": {
    "reviewer_instances": {
      "opencode-deepseek": { "cli": "opencode", "model": "deepseek/deepseek-v4-pro", "agent": "review" },
      "opencode-mimo":     { "cli": "opencode", "model": "xiaomi/mimo-v2.5-pro" }
    },
    "default_reviewers": ["opencode-deepseek", "opencode-mimo", "codex"]
  }
}
```

- **Instance name:** `^[a-z0-9][a-z0-9-]*$`, MUST NOT equal a built-in slug. Validated at
  `config-set` time.
- **`cli`:** MUST be a known adapter from `KNOWN_REVIEWER_SLUGS` — never an arbitrary shell
  command (Kerckhoffs / Postel: strict at the invocation boundary).
- **`model`:** a single opaque `provider/model` string (OpenCode's native format). GSD does
  NOT parse model IDs; pass through verbatim.
- **`agent`:** opaque string; honoured only by adapters with a native agent concept
  (OpenCode `--agent` in v1). Ignored by other adapters.

### Resolution contract (single source)

Instance→cli resolution lives in ONE place: `resolveReviewerSelection` /
`normalizeReviewerInstances` in `review-reviewer-selection.cjs`. The `/gsd:review` workflow
applies the SAME rules. A parity test (`tests/review-reviewer-instances.test.cjs`) asserts the
resolved mapping never diverges from the configured `cli` field — the
`DEFECT.GENERATIVE-FIX` guard against two surfaces drifting.

Rules:
1. Instances participate ONLY via `review.default_reviewers` (no per-instance CLI flags).
2. Instance references expand BEFORE the built-in-slug check.
3. An instance is available iff its base `cli` is detected.
4. An entry that is neither a defined instance nor a built-in slug is a **hard error** when
   instances are configured (typo must be loud); legacy warn-and-drop when no instances are
   configured (backward compatibility).
5. ≥2 selected instances sharing a base `cli` set `sharedAdapterCaveat` and emit a one-line
   caveat in REVIEWS.md.

### REVIEWS.md contract

- **Frontmatter `reviewers:`** records actual identities: built-in slugs and instance names
  (e.g. `[opencode-deepseek, opencode-mimo, codex]`).
- **Section headers:** each instance gets its own section,
  `## <Adapter> Review (<instance-name>)`, e.g. `## OpenCode Review (opencode-deepseek)`.
  Same-cli instances are never collapsed.
- **Shared-adapter caveat:** a one-line note after the frontmatter when ≥2 instances share
  an adapter, so consensus is never silently overstated.

## Alternatives considered

1. **Per-instance CLI flags (`--opencode-1`/`--opencode-2`):** solves only one adapter, does
   not scale, clutters the flag surface. Rejected (spec-of-record, non-blocking decision).
2. **Arbitrary shell commands as reviewers:** maximally flexible but reintroduces quoting,
   portability, and injection risk. Rejected — bounded adapter config is safer.
3. **A parallel instance registry separate from the slug resolver:** rejected via Gall's Law
   / Choose Boring Technology — generalize the existing slug-resolution pattern rather than
   bolting on a second mechanism.

## Consequences

- **Forward-compatibility:** the field names (`cli`, `model`, `agent`), the REVIEWS.md
  section-header format, and the frontmatter identity list are now a depended-on contract.
  Changing them requires a migration + a new ADR amendment.
- **Maintenance:** a per-adapter "supported fields" matrix emerges (OpenCode: model+agent;
  others: model only). Bounded while the spec stays declarative.
- **Security:** the `cli` allow-list is the trust boundary. `model`/`agent`/instance-name
  are opaque and never interpolated into shell strings by the resolver; the workflow passes
  them as separate argv elements.

## Related

- #1517 — approved feature (spec-of-record in the triage comments)
- `src/review-reviewer-selection.cts` — `normalizeReviewerInstances`, `resolveReviewerSelection`
- `gsd-core/bin/shared/config-schema.manifest.json` — `review.reviewer_instances.*` dynamic pattern
