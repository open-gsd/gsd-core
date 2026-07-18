# RCA Branching — Anti-Single-Cause Bias

Loaded by `gsd-debugger` via `@-include` from Phase 2 (form hypothesis) and the
pre-fix Structured Reasoning Checkpoint. A lightweight discipline that guards
against the best-known Root-Cause-Analysis failure mode: **5-Whys single-cause
bias** — a linear "why → why → why" chain tends to isolate ONE cause and stop,
even when a failure has several independent contributing causes.

## Why this exists

The agent already warns against confirmation bias and encourages "multiple
competing hypotheses." But the resolution still commits to a single
`Resolution.root_cause`, and there is no explicit guard against stopping at the
first plausible cause. A single-cause fix on a multi-cause failure passes
verification and then **recurs via the unaddressed second cause** — wasting a
whole future debug cycle. The fix is a few sentences of prompt discipline reusing
the existing hypothesis machinery and debug-file sections; it is **not** a
Fault-Tree-Analysis subsystem.

## The discipline

### 1. Branch, don't chain

Before committing `root_cause`, enumerate candidate causes across **≥2
Ishikawa (fishbone) categories** — not a single linear chain. The four
categories:

- **code** — logic error, off-by-one, wrong branch, missing null check, race in the code under investigation
- **config** — configuration value, feature flag, schema/migration, index/capacity setting
- **environment** — runtime version, OS/platform, timezone, network, dependencies, resource limits
- **data** — input shape, corrupt/partial record, ordering/encoding, volume/scale

A race or timing bug often **bridges categories** (e.g., a code race amplified by environment load, or by a config-driven scan window) — enumerate it in every category it spans, not just one. That cross-category enumeration is exactly what the AND-gate is designed to surface.

Record each candidate branch in `Current Focus` (under the `reasoning_checkpoint.candidate_causes` field). Two+ categories is the minimum bar — if every candidate lands in the same category, you have not branched; generate at least one candidate from a different category before proceeding.

### 2. AND-gate check (Fault Tree Analysis)

Explicitly answer one question before collapsing:

> **Could this failure require more than one contributing condition simultaneously?**

Record the answer in `reasoning_checkpoint.and_gate`. If **yes** (an AND-gate —
the symptom only manifests when two or more conditions co-occur), **every
contributing cause is recorded**, not just the most salient. If **no**, the
single confirmed cause suffices.

### 3. Collapse

Collapse to the confirmed `root_cause` — which may now be **one cause OR a small
set of contributing causes**. Append the eliminated branches to the `Eliminated`
section (never delete them — Kernighan auditability). The recorded set must be
non-empty (at least one confirmed cause) and disjoint from `Eliminated`.

**Self-consistency with the AND-gate:** the confirmed set must agree with the
AND-gate answer. If `and_gate: yes` (the failure requires ≥2 simultaneous
conditions), a single confirmed cause **cannot** fully account for the symptom —
investigation is incomplete; **return to Phase 3** and find the missing
co-occurring cause(s) before collapsing. If `and_gate: no`, the confirmed set
holds exactly one cause.

## Worked examples

**Single-cause (AND-gate no):** a counter shows 3 when clicked once. Candidate
branches: code (event handler fires twice) · config (none) · environment (none)
· data (none). AND-gate: no — the double-fire alone fully accounts for the
symptom. Collapse to one root cause: `event handler bound twice`. Recorded shape:
`root_causes: [double-fire]`. **Identical to today** — single-cause sessions are
byte-for-byte unchanged.

**Multi-cause (AND-gate yes):** intermittent database corruption under load.
Candidate branches: code (two async writers, no lock) · config (missing index →
full-table scan amplifies the race window) · environment (none) · data (none).
AND-gate: **yes** — the corruption only occurs when a writer races AND the scan
holds the read transaction open long enough for the interleaving. Collapse to a
set: `root_causes: [missing async lock, missing index]`. Eliminated: timezone
(reproduced in UTC), env-var (unset in repro). The fix must address BOTH;
addressing only the lock leaves the index-driven amplification, and the
corruption recurs under load.

## Backward compatibility

`Resolution.root_cause` may now hold one OR a small set of contributing causes.
For a single-cause session it still holds exactly one cause (shape unchanged);
the `reasoning_checkpoint` block gains two RCA fields (`candidate_causes`,
`and_gate`) that are populated in **every** session regardless of cause count.
There is no file-format break — readers that handled one cause continue to work
(a single-element set is the same shape as a lone value to a reader that
iterates).

## Scope boundary (Zawinski's Law)

This is a few sentences of prompt discipline. It is **not** a full FTA tree, not
an incident-management system, and not a new debug-file section — it reuses the
existing `Current Focus`, `Eliminated`, and `Resolution` sections and the
existing `reasoning_checkpoint` block. Where a bug genuinely has one cause, the
discipline costs two extra sentences (the empty non-code branches + an AND-gate
"no"); where it has many, it prevents a recurrence.
