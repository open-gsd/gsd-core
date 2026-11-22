---
id: 4586
title: Validate-Only Verify Commands
group: v1.42.1 Features
---

**Command:** `/gsd-plan-phase` (automatic) (#4586)

**Behavior:** A stated `<fails_when>` (#3172) shows the planner understands what a check should detect. It cannot show that the command parses. In the motivating T-SQL phase every plan satisfied the `<fails_when>` contract and three still shipped commands that could not run: an unaliased derived-table column (`Msg 8155`), `CONCAT()` with one argument, and a batched query that never returned. Each executor then had to decide whether the check or the deliverable was wrong, and the wrong answer, adjusting the deliverable until the check passes, silently corrupts the thing being verified.

Where a validate-only mode exists for an `<automated>` command's language or tool, `gsd-planner` now runs it against the authored body and records the result inside the task's `<verify>`, after `<fails_when>`:

```xml
<verify>
  <automated>bash scripts/check-release.sh</automated>
  <fails_when>non-zero exit</fails_when>
  [VALIDATED: bash -n exit 0]
</verify>
```

A body that fails its validator blocks the plan. Where no validate-only mode applies, behavior is unchanged: the planner states the failing direction and writes `[UNVALIDATABLE: <reason>]`, so `gsd-plan-checker` can tell a considered answer from a skipped one. Check 8g raises a command with no record as a WARNING, and a record that does not hold up as a BLOCKER.

**The sanctioned set is closed, and it is smaller than it looks.** Validate-only means the form does not run the body, does not write to the tree, does not need the command's targets to exist, and needs no network or install. `bash -n`, `node --check`, a `python3` `ast.parse` one-liner, `SET PARSEONLY ON` (T-SQL, with a live session) and `cargo metadata --no-deps` (target shape) qualify. Four forms that read like validators do not, and the reference names them so the planner never reaches for them: `python -m py_compile` writes a `.pyc`; `cargo check` runs the crate's build scripts and procedural macros; `npm run <script> --dry-run` is ignored by `npm run` and executes the script; `terraform validate` needs an initialized directory.

**No schema change.** The record is a plain-text line inside `<verify>`. The `<automated>` and `<fails_when>` elements and the #2401 and #3172 probes are unchanged, and a test pins that.

**Known limits:**
- A command that hangs has no exit code and is not parse-detectable. The #4586 field case (eight correlated subqueries batched into one plan) is not caught by this tier.
- Enforcement is prompt-level. The checker reads the record and re-runs only the read-only forms; there is no deterministic CLI probe, and `SET PARSEONLY ON` cannot be re-run by the checker.
- A pass on an outer layer says nothing about an embedded payload in another language, so each layer is validated separately.
- A project cannot declare its own validate-only command; the sanctioned set is the closed table in the reference.
- Plans written before this shipped carry no record and draw a WARNING, never a BLOCKER.

See [Validate an automated command](how-to/validate-an-automated-command.md).
