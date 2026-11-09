# How to resolve baseline-notation findings in a plan

**Goal:** Fix each criterion that `verify plan-structure` flags as already true at HEAD, so every count or match gate in the plan can fail if the work is not done.

**Prerequisites:** A `PLAN.md` that `/gsd-plan-phase` wrote, or that you wrote by hand. The planner records a baseline beside each count/match gate, and the plan checker runs `verify plan-structure` for you. To run it yourself:

```bash
gsd-tools verify plan-structure .planning/phases/03-auth/03-01-PLAN.md
```

For the grammar, see [PLAN.md → Baseline notation](../reference/plan-md.md#baseline-notation). For why the rule exists, see [ADR-4309](../adr/4309-criterion-baseline-notation.md).

---

## 1. Read the verdict

The JSON verdict has three fields for this rule:

- `baseline_notation_count`: how many notations the checker found.
- `baseline_findings`: one entry per problem. `rule` is `B1` (error) or `B2` (warning), and `line` is the plan line.
- `baseline_statuses`: notations it could not read. These never change the exit code.

Tell "nothing to report" apart from "could not look":

| You see | It means |
|---|---|
| `baseline_notation_count: 0`, no statuses | The plan has no notation. Nothing was judged. If the plan has count/match gates, their baselines were never recorded. Run each gate and add one. |
| count > 0, no findings, no statuses | Every notation was read, and each one can fail. |
| statuses only | A notation was written but could not be judged. The plan is still valid, but that gate is unchecked until you fix its notation (step 4). |

## 2. Fix a B1 finding: the criterion already holds at HEAD

`[HEAD=6 EXPECT>=1]` says the command printed 6 before any work, and the criterion asks for at least 1. It passes whether or not the task runs. Pick one fix:

- **Anchor the gate to what the task creates.** Count the new heading, key, or line instead of a word that already appears elsewhere: `` `grep -c "^## Agent roster" PROJECT.md` -ge 1 [HEAD=0 EXPECT>=1] ``.
- **Assert the delta.** Keep the command, but expect more than the baseline: `[HEAD=6 EXPECT>=7]`.
- **For a negative gate, show there was something to remove:** `[HEAD=3 EXPECT==0]`.
- **For a deliberate regression guard** (a criterion that must hold before and after the change), keep it and name the mutation that would turn it red: `[HEAD=4 EXPECT>=4 GUARD MUTATION: deleting any route in routes.ts drops the count]`. `GUARD` on its own does not count; the `MUTATION:` reference must be present and non-empty.

Measure `HEAD` again after changing the command. A notation copied from the old command records the wrong baseline.

## 3. Fix a B2 warning: the old free-form comment

`# baseline at HEAD: 0` is the form planners used before the notation existed. Nothing checks it. Replace it in place:

```diff
- grep -c "## Quickstart" README.md   # baseline at HEAD: 0
+ grep -c "## Quickstart" README.md   # [HEAD=0 EXPECT>=1]
```

## 4. Fix a status

| `code` | Fix |
|---|---|
| `malformed` | Write `HEAD=<value> EXPECT<op><value>`. The operator is one of `==` `!=` `>=` `>` `<=` `<` (`=`, `=>` and `≥` are not operators). |
| `bad_value` | Use an integer, `absent`, `present`, or `error:<exit code 1-255>`. A missing file is `error:2`, not `0`. |
| `ordering_needs_integer` | `>`, `>=`, `<` and `<=` need an integer `EXPECT`. For presence, use `EXPECT==present`. |
| `bad_rev` | Write `@` with the commit sha you measured at (`git rev-parse --short HEAD`), not `HEAD~1` or a branch name. |
| `pin_conflict` | Keep either `@<sha>` or `UNPINNED`, not both. |
| `unrecognized_trailing` | Check the spelling after `EXPECT`. Only `@<sha>`, `GUARD MUTATION: <ref>` and `UNPINNED` are allowed, in that order. |
| `unterminated` | Close the bracket on the same line. |
| `outside_criteria_zone` | Move the notation into `<acceptance_criteria>`, `<automated>` or `<verify>`. Elsewhere it is not judged. |
| `scanner_error` | Report it as a bug with the plan attached. Validation continued without the baseline check. |

## 5. When the finding is wrong for this plan

If you have a reason the rule does not apply, record it in the plan instead of deleting the notation:

```html
<!-- plan-criteria-allow: B1 - the count is pinned by an adjacent grep -n proof -->
```

The reason must not be empty. The marker turns off that rule for the whole plan, so prefer `GUARD MUTATION:` for a single criterion.
