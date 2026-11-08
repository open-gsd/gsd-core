# ADR-4309: Criterion baseline notation for quantitative acceptance criteria

- **Status:** Accepted
- **Date:** 2026-11-08
- **Issue:** [#4309](https://github.com/open-gsd/gsd-core/issues/4309) (approved-feature; scope amended by the maintainer on 2026-11-08). It is half 2 of [#4024](https://github.com/open-gsd/gsd-core/issues/4024). Half 1 is the R1–R6 static ban list from #4288.
- **Amended by:** [ADR-4310](4310-criterion-replay.md): opt-in `--replay` executes each criterion's command under a no-shell quarantine and compares the printed value with the recorded `HEAD`. It is advisory only.
- **Relationship to prior work:** this ADR extends the plan-discipline scanner family in `cmdVerifyPlanStructure` (`src/verify.cts`): #429's comment-echo gate, #968's file-wide negative-gate conflict, and #4024's `scanQuantitativeCriteria`. It replaces the free-form `# baseline at HEAD: N` comment that #4927 introduced in planner guidance. [#4310](https://github.com/open-gsd/gsd-core/issues/4310) (opt-in `--replay`) consumes this grammar and is expected to amend this ADR. It is not decided here.

## Context

A quantitative criterion is a comparison: `grep -c 'foo' bar.ts` against `>= 3`. When the comparison already holds before any work starts, the criterion reads the same before and after the change. It measures nothing, and its verification arm passes whether or not the work happens. #4024 recorded twelve of these in two downstream phases. A field report on this issue added five more threshold-form gates (`-ge`, `-Fc`) in a single phase, none of which R1–R6 touch.

#4927 told the planner to run each count/match gate at HEAD and write `# baseline at HEAD: N` beside it. It told the plan checker to block a gate that already passes "with no recorded baseline". Nothing parses that comment. A recorded `N` cannot be compared with anything, so a vacuous gate with a comment on it passes the same as one without.

## Decision

### 1. A closed grammar, written beside the criterion

```
[HEAD=<value> EXPECT<op><value> [@<sha>] [GUARD MUTATION: <ref>] [UNPINNED]]
value ∈ <integer> | absent | present | error:<exit-code>
op    ∈ ==  !=  >=  >  <=  <
```

- `HEAD` is what the command prints now; `EXPECT` is what it must print after the change. `HEAD` is the printed value regardless of the counting flag that produced it (`-c`, `-Fc`, `rg --count`).
- `<integer>` is an optionally signed integer of at most 15 digits. `error:<exit-code>` carries a literal exit code from 1 to 255. A `grep -c` over a missing path exits 2 and prints nothing, which is not zero matches. The two kinds never compare equal, and an `error` or presence value never satisfies an ordering operator.
- `@<sha>` records the commit the baseline was measured at, as 7–40 lowercase hex characters. `UNPINNED` says no revision was recorded. The two exclude each other.
- The grammar is case-sensitive and closed. It has no expressions, no references to other plans, and no execution.

The notation may sit in `<acceptance_criteria>`, `<automated>` (inside a shell comment), or `<verify>`. These are the zones `scanQuantitativeCriteria` already judges.

### 2. One rule, two severities, and a separate status collection

| Id | Severity | Fires when |
|---|---|---|
| B1 | error | `compare(HEAD, op, EXPECT)` is already true, and the notation does not carry both `GUARD` and a non-empty `MUTATION:` reference |
| B2 | warning | a legacy `# baseline at HEAD:` comment sits in a criteria zone; the notation replaces it |

Anything that cannot be parsed or evaluated is a **status**: `malformed`, `bad_value`, `ordering_needs_integer`, `bad_rev`, `pin_conflict`, `unrecognized_trailing`, `unterminated`, `outside_criteria_zone`, `scanner_error`. Statuses go in `baseline_statuses` and never change the exit code. "I cannot evaluate this" looks the same on a correct criterion and a broken one, so treating it as a finding would block correct plans. A scanner crash is also a status, so the scanner fails open and never breaks plan authoring.

Text left over after a recognized tail is a status, but the notation is still judged. So a misspelled `GAURD` cannot disarm B1.

The legitimate exit is `<!-- plan-criteria-allow: B1 - <reason> -->`, the same marker grammar as R1–R6. One parser (`parseCriteriaAllowMarkers`) serves both rule families, so the two cannot drift.

### 3. Severity is set by construction, not by sampling

#4024 asked that severity be set against a counted false-positive rate. B1 is a decision procedure over values the author declared: given a parse, it fires exactly when the declared comparison holds, so it has no false positives by construction. A seeded property test over every value kind and operator asserts this. The remaining risk is misrecognition, meaning prose read as a notation. The opener is `[HEAD=` with `HEAD` in uppercase. Measured on `next` at `92415cf6ad`, the opener appears in 0 of the 1,964 tracked `.md` files, so the counted misrecognition rate is zero. B2 matches only the literal `# baseline at HEAD:` comment form, and only inside criteria zones, so it is a warning.

### 4. The ratchet holds by construction

#4024 asked that a new rule judge only lines a change added, and demote earlier findings to warnings, so a committed corpus is not condemned all at once. B1 fires only on the notation, and no plan written before this ADR can contain it. So every B1 finding is on a line added after the notation shipped, and `verify plan-structure` needs no git subprocess or diff scoping.

### 5. Placement

The grammar lives in a pure module, the Criterion Baseline Module (`src/criterion-baseline.cts`), not inside `src/verify.cts`. #4310 replay must import the same parser, and a pure module exposes typed values (`rule`, `code`, `kind`) for tests to assert on. Zone membership is decided by offset against `extractTaggedBlockSpans` (`src/markdown-sectionizer.cts`). Decoding by offset counts a notation inside `<verify><automated>` once, where scanning each zone body would count it twice.

## Consequences

- `verify plan-structure` gains three payload keys, appended after the existing ones: `baseline_notation_count`, `baseline_findings` and `baseline_statuses`. Existing keys and their order are unchanged.
- The planner reference (`planner-verify-command-grounding.md`), `gsd-planner.md`, and plan-checker step 4 now name the notation instead of the free-form comment. The checker reads the `verify plan-structure` findings instead of re-deriving the comparison.

## Alternatives rejected

- **Sibling-aware `EXPECT`** (for example, "after plan N's rows land"). The maintainer declined this on 2026-11-08: it brings cross-plan state into the grammar. A checker hint that cross-references counted literals against earlier-wave plans is a separate issue.
- **Malformed notation as an error.** Rejected because parse and evaluate failures change no exit code (fail open).
- **Parser inside `verify.cts`** (triage Lens A). Rejected for the reasons in decision 5.
- **Git diff-scoped ratchet.** Rejected by decision 4.

## Known limits

- `EXPECT` is not cross-checked against the shell command's own comparison (`-ge 8` against `EXPECT>=5`).
- `HEAD` is a declared value; nothing checks it was measured. That is #4310.
- A raw gate with no notation is not judged by B1.
- `@<rev>` takes only a commit sha. A tag or branch name is reported as `bad_rev`.
