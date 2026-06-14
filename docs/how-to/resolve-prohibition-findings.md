# How to resolve prohibition findings while writing a spec

**Goal:** Turn each must-NOT the spec phase surfaces into an explicit, checkable spec decision — so a constraint the author assumed but never wrote (the reminder that must not shame the user, the model that must not proxy on protected attributes, the log that must not store raw PII) becomes an acceptance criterion the verifier can enforce *before* any code exists, instead of an unwritten intent a literal `✅ done` can silently violate.

**Prerequisites:** A phase whose `/gsd-spec-phase` run has passed the ambiguity gate and the edge-completeness probe (Step 5.5). The prohibition probe (Step 5.6) then runs automatically over the same requirements and presents its findings — you do not invoke it separately.

For the two-stage recall→precision protocol, the canon-referral rule, and the `status × verification` schema, see [Spec-Phase Prohibition Probe](../FEATURES.md#146-spec-phase-prohibition-probe). This guide covers only how to *act* on the findings.

---

## Read a finding

Each finding is one **bespoke** must-NOT for one requirement — a values, safety, fairness, privacy, or transparency constraint the probe kept after dropping routine-engineering noise. A finding is phrased as a must-NOT statement, for example:

> **R1 · values** — MUST NOT use shaming, guilt, or loss-aversion streak framing (e.g. "Don't lose your streak!") — the reminder must encourage without penalty framing

You resolve each finding into one of three states. Claude presents them as a numbered choice (or an `AskUserQuestion` menu).

---

## Keep it — write a negative acceptance criterion

**Choose this when the prohibition is genuine for this feature.** Claude writes a must-NOT line into the spec's **Acceptance Criteria**, marks the prohibition `resolved`, and you pick its **verification tier**:

- **`test`** — a mechanical check can prove it: a negative test, a lint rule, an assertion that the audit log contains no raw SSN. Choose this when a green/red check exists.
- **`judgment`** — the prohibition is real but cannot be reduced to a mechanical test (e.g. "the framing is not manipulative"). It records intent and routes to a judgment-based review rather than a passing test.

> - [ ] MUST NOT use shaming or loss-aversion framing in the reminder copy *(judgment)*

Pick the tier honestly — see [what happens downstream](#what-happens-to-resolved-findings-downstream) for why a `test`-tier prohibition is held to a stricter bar.

---

## Dismiss it — record why it does not apply

**Choose this when the prohibition genuinely does not apply** — and say why. A dismissal **requires a non-empty reason**; silence is rejected.

> ⛔ dismissed — pure integer utility; no user-facing surface, no values/safety/privacy dimension

A wrong dismissal is the exact silent failure this probe exists to prevent, so dismiss only when the reason is solid. The reason string is the audit trail.

---

## Defer it — leave it unresolved and flagged

**Choose this only when you are not ready to decide.** The prohibition stays `unresolved` and is flagged. Unlike a dismissal, deferring makes no claim that the prohibition is safe — it is an explicit, visible assumption the planner must surface, not silently drop.

---

## When a finding is canon, not yours

Some candidates are **canon** security/compliance constraints a dedicated tool already owns (OWASP / prototype-pollution / path-traversal / injection → `/gsd-secure-phase` + eslint; GDPR retention / consent → `/gsd-secure-phase`). The probe does not surface these as findings to resolve — it emits a one-line breadcrumb and drops them, so the list you triage stays the ~2–3 **bespoke** prohibitions no other tool would catch. You do not act on a breadcrumb here; pick it up in `/gsd-secure-phase`.

---

## Clear the soft gate

After you have worked through the findings, the probe runs a **soft gate**:

- **All applicable prohibitions resolved** → the spec proceeds to the next step.
- **One or more still `unresolved`** → Claude asks what to do:
  - **Resolve now** — loop back and resolve the remaining prohibitions.
  - **Write the spec anyway** — the spec is written with those rows marked `⚠ Prohibition unresolved — planner must treat as assumption`. Use this deliberately; you are choosing to ship a known gap.
  - **Keep probing** — continue surfacing.

The gate is *soft*: it never blocks you, but every unresolved prohibition stays visible in the spec's `## Prohibitions` section.

---

## Let Claude resolve them for you

**If the prohibitions are low-stakes or already settled by earlier phases**, run the spec phase in auto mode:

```bash
/gsd-spec-phase 3 --auto
```

In `--auto`, Claude marks a prohibition `resolved` where it can write a defensible negative acceptance criterion (at the `test` or `judgment` tier), and leaves it `unresolved` otherwise. It **never auto-dismisses** — dismissing a prohibition requires a human reason, because a wrong auto-dismissal is precisely the silent failure being eliminated. Claude logs the tally, for example:

```
[auto] prohibitions: 2 resolved, 1 unresolved
```

Review the logged choices afterwards; auto mode is a fast first pass, not a substitute for judgement on a prohibition that carries risk.

---

## What happens to resolved findings downstream

When you next run `/gsd-plan-phase`, the planner reads the spec's `## Prohibitions` section and:

- lifts every confirmed prohibition into the plan's `must_haves.prohibitions`,
- carries the `test`-tier and `judgment`-tier distinction with it,
- surfaces every `unresolved` prohibition as an explicit assumption.

At verify time, a `test`-tier prohibition whose mechanical check is not yet wired is held **fail-closed** — it reports as flagged/unverified, never as a silent pass — so a prohibition can never quietly disappear between spec and verification. A `judgment`-tier prohibition routes to a judgment-based review rather than a green/red test.

This is the payoff: a resolved prohibition becomes a checkable negative the goal-backward verifier accounts for, extending its reach to the must-NOT the requirement prose never stated.

---

## Related

- [Spec-Phase Prohibition Probe](../FEATURES.md#146-spec-phase-prohibition-probe) — protocol, schema, host-mapping table, and the front-of-pipeline rationale
- [Resolve edge-coverage findings](resolve-edge-coverage-findings.md) — the sibling probe on the data/behavior-shape axis
- [`/gsd-spec-phase`](../COMMANDS.md#gsd-spec-phase) — command reference and flags
- [Plan a phase](plan-a-phase.md) — where resolved prohibitions become `must_haves.prohibitions`
- [docs index](../README.md)
</content>
</invoke>
