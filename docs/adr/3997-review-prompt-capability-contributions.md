# ADR-3997: Review-prompt capability contributions — `review:pre` and the `reviewer` role

- **Status:** Accepted
- **Date:** 2026-11-22
- **Issue:** [#3997](https://github.com/open-gsd/gsd-core/issues/3997) (approved-feature, Go-with-conditions 2026-11-08)
- **Amends:** [ADR-857](857-capability-system.md) (adds a thirteenth loop point, additive-only) · [ADR-894](894-capability-declaration-format.md) (adds a fourth role family) · [ADR-2363](2363-capability-instruction-surface-trust.md) (adds a second instruction-surface class)
- **Unchanged and explicitly out of scope:** [ADR-2782](2782-reviewer-lane-capability-surface.md) (lane descriptors, invocation, consent) · [ADR-0011](0011-review-default-reviewers.md) (reviewer selection precedence) · the `REVIEWS.md` format and synthesis contract

## Context

An enabled capability's planning and execution guidance reaches the planner, checker, executor and
verifier roles through loop contributions. The external reviewers `/gsd-review` invokes receive only
the core review prompt, and `/gsd-plan-review-convergence` delegates every cycle to `/gsd-review`.
The plan can therefore comply with an active capability's constraints while reviewers judge it
without them.

## Decision

**D1. One new canonical point, `review:pre`, hosted by `review.md`.** The vocabulary stays closed and
additive-only: the original twelve do not move and the point list is still generated from the
`gsd:loop-host` markers (a sixth `review` step). Three hand-kept mirrors (`registry-schema`,
`gen-capability-matrix`, the resolver's fallback list) gain the same entry, each pinned by a parity
test.

**D2. A new role, `reviewer`, in a new family, `review`.** The external review lanes are not a gsd
agent, so the role has no agent file. The family is its own, expected only by the `review` step:
placing `reviewer` in `orchestration` would let `discuss`, `verify` and `ship` publish it and loosen
the partition ADR-894 §3 established. The generator's agent-presence cross-check names the exemption
explicitly (`ROLES_WITHOUT_AGENT_FILE`: `orchestrator`, `reviewer`) so every other role must still
map to an agent file and an unmapped role fails closed.

**D3. Only contributions are wired at `review:pre`.** Admission is by the host contract (`into` must
be `reviewer`). The generator proves the host dispatches `kind == "contribution"` hooks targeted
`into == "reviewer"` (`requiredDispatch`), so a `step` or `gate` at this point fails the registry
build through the existing wired-kind check.

**D4. One insertion at the shared prompt boundary.** `review.md` renders `review:pre`, keeps entries
with `kind == "contribution" && into == "reviewer"` and an inline fragment, and appends one
`<capability_reviewer_rules>` block to `gsd-review-prompt.md`, the single file every lane reads. Order
is the registry's. With nothing to insert, nothing is appended and the prompt is byte-identical.
Since #4559 no lane's prompt is trimmed, so the block cannot be trimmed away; it counts toward each
lane's cap and can turn a lane into a `prompt_exceeds_context` refusal, which is the designed
outcome. Delivery is advisory and a closing tag inside a fragment is escaped.

**D5. Engine range is validated by the registry, not only documented.** A capability declaring any
hook at a point listed in `POINT_MIN_ENGINE` (`review:pre` → `1.23.0`) must declare an `engines.gsd`
range that no earlier core satisfies. The check probes `0.0.0` and the `X.Y.0` / `X.Y.99` of every
earlier minor line.

**D6. Trust.** A reviewer contribution is a trusted, unscanned instruction surface (ADR-2363) that
crosses the reviewer-lane egress boundary: it is sent to every consented external lane with the plan.
The install summary discloses it by point and target (`reviewer-contribution: review:pre (reviewer)`)
and names the egress. It does not enter the v1 `disclosureSignature` or `hasExecutable`; changing
that encoding requires the versioned-v2 migration ADR-2363 already mandates. Project installs stay
bound by the full-bundle `contentHash`. Lane consent and destination pinning are not bypassed.

## Alternatives considered

- Reuse `plan:pre` `into: checker` — leaks one role's instructions into another.
- Per-adapter patches or a `review.extra_instructions` key — duplicates activation, ordering,
  provenance and consent, and leaves future lanes uncovered.
- Host-native subagent hooks — `/gsd-review` spans several external transports.
- Hard-coding one capability's text in `review.md` — couples core to an optional capability.
- Putting `reviewer` in the `orchestration` family — loosens the partition (D2).

## Consequences

- One more row in the conformance matrix and the disclosure surface; no dependency.
- No first-party capability ships a reviewer contribution in this change; the core stays
  capability-neutral and authors opt in later, with an `engines.gsd` range that excludes older cores.
- Known limit: the engine-range check probes release lines instead of proving range intersection.
- Known limit: contributions deliver inline fragments only, matching the other landing sites.
