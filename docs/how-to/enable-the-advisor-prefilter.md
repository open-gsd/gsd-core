# How to enable the advisor pre-filter

**Goal:** Have the Claude Code session advisor check that the work is final and consistent before the next review gate opens, so a reviewer subagent does not spend its pass on output that has already changed.

**Prerequisites:** Claude Code with an advisor configured, and a GSD project on v1.23.0 or later. The pre-filter is **off by default**; a project that never enables it is unchanged.

For why it is shaped this way, see [Advisor Pre-filter](../FEATURES.md#4795-advisor-pre-filter) and [ADR-4795](../adr/4795-advisor-prefilter-in-review-pipeline.md).

---

## 1. Configure an advisor in Claude Code

The advisor is a host feature, not a GSD setting. Choose one for the session:

```bash
claude --advisor <model>
```

or run `/advisor <model>` in the session, or set `advisorModel` in your Claude Code settings. Pair it per [model profiles](../../gsd-core/references/model-profiles.md): the advisor must be at least as capable as the executor.

## 2. Turn the pre-filter on

```bash
gsd config-set workflow.advisor_prefilter true
```

From the next run, the orchestrator consults the advisor at two points: after verification passes (`verify:post`) and before shipping (`ship:pre`).

## 3. Read the result

Each run prints one advisory line:

```
advisor-prefilter (verify:post): consistent
```

or `drift-suspected` followed by up to five bullets: an edit made after the last reviewer pass, a partially applied fix, or an acknowledged finding that was not resolved. The workflow continues either way. Treat `drift-suspected` as a pointer for the reviewers that follow, and fix what it names before the gate if you agree.

## When nothing prints

Silence has two causes, and they are different:

| What you see | Cause |
|---|---|
| No `advisor-prefilter` line at any point | The key is `false` or unset (a string `"false"`, `"0"`, `"no"` or `"off"` also counts as off), or the point is not one of the two. Check `gsd config-get workflow.advisor_prefilter`. |
| The key is `true` and still no line | The session has no advisor tool (no advisor configured, `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1`, or a non-Claude-Code runtime), or the advisor call failed. The consult is a silent no-op by design. |

To confirm the hook is wired without running a phase:

```bash
node gsd-tools.cjs loop render-hooks verify:post --raw
```

An `activeHooks` entry with `"kind":"contribution"` and `"capId":"advisor-prefilter"` means the consult will be injected.

## Cost

Each consult sends the whole session transcript to the advisor model, billed at the advisor's rate and reported apart from the executor's tokens. A long session pays more per consult. Turn the key off with `gsd config-set workflow.advisor_prefilter false`.

## What it does not do

It never blocks the workflow and never replaces `gsd-plan-checker`, `gsd-code-reviewer`, `gsd-verifier`, `gsd-security-auditor` or the cross-AI lanes of `/gsd-plan-review-convergence`. A Claude advisor reviewing a Claude executor is correlated review; those reviewers stay the independent check.
