# verify-work.md — deferred elaboration

Read in full when `workflow.compact_content` is `false` (the default) — see
`gsd-core/references/compact-content-gate.md` for the check and resolution rule this
spine defers to. Each `§` below is the full text the spine condenses at the point it
names.

## § 1 — reconcile_gaps

**Reconcile diagnosed gaps against completed gap-closure plans (#1921):**

When verify-work resumes after `/gsd:execute-phase --gaps-only`, the UAT `## Gaps` entries still read `status: failed` even though their fix plans have executed. Without reconciliation verify-work re-diagnoses them as fresh blockers and spawns new gap plans — losing the verification state. This step closes the loop.

Read the UAT `## Gaps` section and the phase dir `*-PLAN.md` frontmatter. For each gap with `status: failed`:
1. Find a `*-PLAN.md` whose frontmatter `gap_ids` includes the gap's `gap_id` (`G-{phase}-{N}`).
2. If such a plan exists AND has a matching `*-SUMMARY.md` in the phase dir (the plan was executed by `--gaps-only`), the gap is **resolved** — update its YAML in place:
   ```yaml
   - gap_id: G-{phase}-{N}
     status: resolved        # was: failed
     resolved_by: {plan basename}
     resolved_at: {today}
   ```
3. If no plan references the `gap_id`, or the plan has no SUMMARY, leave the gap `status: failed` (still open).

Read plan frontmatter directly in-context — do not pipe it through a shell parser. After reconciliation, announce:
```
Reconciled gap-closure state: {resolved_count} gap(s) resolved by executed plans, {open_count} still open.
```

Resolved gaps are NOT re-diagnosed and do NOT spawn new gap plans. If the user later reports the same behavior as still broken, treat it as a new issue (a regression) with a fresh `gap_id`.

## § 2 — resume_from_file

**Resume testing from UAT file:**

**First run `reconcile_gaps`** (above) so gaps already fixed by `/gsd:execute-phase --gaps-only` are marked `resolved` before testing resumes (#1921).

Read the full UAT file.

(The find-pending / zero-pending guard clause is stated verbatim in the spine — a pre-existing
drift guard, `tests/verify-work-auto-transition.test.cjs` bug #1716, requires the two sentences
adjacent with nothing between them.)

Announce:
```
Resuming: Phase {phase} UAT
Progress: {passed + issues + skipped}/{total}
Issues found so far: {issues count}

Continuing from Test {N}...
```

Update the `## Current Test` section with the pending test IN MEMORY ONLY (#5105 C2) — do not write the UAT file here. The next batched write (`process_response`'s `update_rules`) persists it alongside the test's actual result, so a resume that finds a pending row and stops without answering it performs zero writes.
Then continue to `present_test` with it.

## § 3 — diagnose_issues, plan_gap_closure, verify_gap_plans, revision_loop (the gap-closure sub-flow)

This whole sub-flow only runs when UAT testing found UNRESOLVED issues (`complete_session` routes
here based on `unresolved_issues`, not the raw `issues` count — #4983, see § 4); a session with
zero unresolved issues never reaches it, including a resumed session whose issues were all
verified-resolved by an executed gap-closure plan.

### diagnose_issues

**Diagnose root causes before planning fixes:**

```
---

{N} issues found. Diagnosing root causes...

Spawning parallel debug agents to investigate each issue.
```

- Load diagnose-issues workflow
- Follow @~/.claude/gsd-core/workflows/diagnose-issues.md
- Spawn parallel debug agents for each issue
- Collect root causes
- Update UAT.md with root causes
- Proceed to `plan_gap_closure`

Diagnosis runs automatically - no user prompt. Parallel agents investigate simultaneously, so overhead is minimal and fixes are more accurate.

### plan_gap_closure

**Auto-plan fixes from diagnosed gaps:**

Display:
```
### GSD ► PLANNING FIXES

◆ Spawning planner for gap closure... (runs in a subagent — no output until it returns, ~1–5 min; expected, not a freeze)
```

Spawn gsd-planner in --gaps mode:

<!-- #2517 model-omit-on-inherit -->

> **Model omission (#2517).** Omit the `model` parameter entirely when the value it would carry (`planner_model`, `checker_model`) is `"inherit"` or empty. An empty value 404s on runtimes without native tier aliases — the default on non-Claude runtimes. Omitting it inherits the orchestrator's model. See @gsd-core/references/model-profile-resolution.md.

````
Agent(
  prompt="""
<planning_context>

**Phase:** {phase_number}
**Mode:** gap_closure

<required_reading>
- {phase_dir}/{phase_num}-UAT.md (UAT with diagnoses)
- {state_path} (Project State)
- {roadmap_path} (Roadmap)
</required_reading>

${AGENT_SKILLS_PLANNER}

</planning_context>

<downstream_consumer>
Output consumed by /gsd:execute-phase
Plans must be executable prompts.

<!-- #2508 runtime-aware-dispatch -->

> **Runtime-aware dispatch (#2508 Phase 4).** GSD workflows dispatch specialized subagents by role. Before dispatching on a built-in-only runtime (kimi-code — three built-ins only), resolve the role to a built-in via `gsd_run query resolve-dispatch-type --requested <role> --raw`. On named-dispatch runtimes (Claude/OpenCode/…) the role is returned unchanged; on kimi-code it maps to `coder`/`explore`/`plan` by role-suffix. The persona rides `${AGENT_SKILLS_<ROLE>}` (Phase 3) regardless. See @gsd-core/references/runtime-aware-dispatch.md.

**Gap linkage (#1921):** each created `*-PLAN.md` MUST list the UAT gap ids it addresses in its frontmatter:
```yaml
---
gap_closure: true
gap_ids: [G-{phase}-{N}, ...]   # the ## Gaps gap_id values this plan fixes
---
```
This lets `/gsd:verify-work` reconcile resolved gaps on resume (a gap whose plan has a matching `*-SUMMARY.md` is marked `status: resolved`, not re-diagnosed as a fresh blocker).
</downstream_consumer>
""",
  subagent_type="gsd-planner",
  model="{planner_model}",
  description="Plan gap fixes for Phase {phase}"
)
````

(The "stop working, wait for the subagent" orchestrator rule is stated in the spine, not repeated here.)

On return:
- **PLANNING COMPLETE:** Proceed to `verify_gap_plans`
- **PLANNING INCONCLUSIVE:** Report and offer manual intervention

### verify_gap_plans

**Verify fix plans with checker:**

Display:
```
### GSD ► VERIFYING FIX PLANS

◆ Spawning plan checker... (runs in a subagent — no output until it returns, ~1–5 min; expected, not a freeze)
```

Initialize: `iteration_count = 1`

Spawn gsd-plan-checker:

```
Agent(
  prompt="""
<verification_context>

**Phase:** {phase_number}
**Phase Goal:** Close diagnosed gaps from UAT

<required_reading>
- {phase_dir}/*-PLAN.md (Plans to verify)
</required_reading>

${AGENT_SKILLS_CHECKER}

</verification_context>

<expected_output>
Return one of:
- ## VERIFICATION PASSED — all checks pass
- ## ISSUES FOUND — structured issue list
</expected_output>
""",
  subagent_type="gsd-plan-checker",
  model="{checker_model}",
  description="Verify Phase {phase} fix plans"
)
```

(The "stop working, wait for the subagent" orchestrator rule, and the on-return handling for
VERIFICATION PASSED / ISSUES FOUND, are stated in the spine — the ISSUES FOUND handler's exact
wording is pinned by `tests/plan-checker-coupling.test.cjs`.)

### revision_loop

The full conflict-handling contract (non-binding `fix_hint`, the BEFORE-editing constraint
re-check, `## REVISION_CONFLICT` routing, the same-property/THIRD-conflict stall bound, and the
max-iteration escalation) is stated verbatim in the spine — a pre-existing drift guard
(`tests/revision-remediation-binding.test.cjs`, #3771) pins it there across every revision
orchestrator in the repo. This section adds only the surrounding `Agent()` scaffolding:

```
Agent(
  prompt="""
<revision_context>

**Phase:** {phase_number}
**Mode:** revision

<required_reading>
- {phase_dir}/*-PLAN.md (Existing plans)
</required_reading>

${AGENT_SKILLS_PLANNER}

**Checker issues:**
{structured_issues_from_checker}

</revision_context>

<instructions>
Read existing PLAN.md files. Make targeted updates to address checker issues. (See the spine for
the binding/non-binding contract and REVISION_CONFLICT handling stated above this point.)
</instructions>
""",
  subagent_type="gsd-planner",
  model="{planner_model}",
  description="Revise Phase {phase} plans"
)
```

## § 4 — complete_session's `unresolved_issues` count (#4983)

**Why this exists:** `reconcile_gaps` (§ 1) updates a resolved gap's YAML in the UAT file's
`## Gaps` section, but it never touches the matching `### N.` test block's `result: issue` line —
by design, that line is the historical record of what the user reported. Before #4983,
`complete_session` counted raw `result: issue` tests and routed into `diagnose_issues` whenever
that count was nonzero, so a resumed session whose issues had ALL been verified-resolved by an
executed gap-closure plan still fell straight back into diagnosis — the terminal sub-flow (§ 3)
has no path back to promotion. This is the sibling of #4546 (which fixed the same
misroute-forever shape for a deliberately deferred `skipped` test) for the `issue`-plus-resolved
case.

**`unresolved_issues` definition:** a test counts toward `unresolved_issues` when its
`result: issue` AND it is NOT a verified resolution. A `result: issue` test is a verified
resolution only when its `## Gaps` entry (matched by `test:`) has ALL of:
- `status: resolved` (case-insensitive);
- a non-empty `resolved_by`;
- `resolved_by`, as a bare basename (no path separators), names a `*-PLAN.md` file that exists in
  this phase directory;
- that plan has a matching `*-SUMMARY.md` sibling in the same directory (proof it actually ran).

This is the EXACT criterion `phase uat-passed` uses (`src/uat-predicate.cts`'s
`isTestGapResolved`) — apply it the same way here, by reading the phase directory's files
directly, not by trusting the Gaps entry's own text alone. A `status: resolved` entry whose
`resolved_by` names no such plan (missing, wrong suffix, or no matching SUMMARY) does NOT count as
a verified resolution — the test stays in `unresolved_issues` and still routes to
`diagnose_issues`, exactly as an unresolved issue always has. If a test has more than one `## Gaps`
entry (a later regression re-opens the same test number with a fresh `gap_id`, per § 1), it only
counts as resolved when EVERY entry for that test number is a verified resolution — one open
regression is enough to keep the test unresolved.

**Where this plugs in:** `complete_session`'s "Count results" step computes `unresolved_issues`
alongside `pending_count`/`blocked_count`/`skipped_no_reason`, and its issues-routing decision
(`diagnose_issues` vs. proceeding toward promotion) reads `unresolved_issues`, not the raw
`issues` count from `## Summary`. The raw `issues` count is unchanged and still drives the
presented summary numbers.
```
