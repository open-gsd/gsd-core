# How to discuss a phase

**Goal:** Gather the implementation decisions a phase needs before planning begins — so the researcher and planner can act without asking you again.

**Prerequisites:** `.planning/ROADMAP.md` exists. If not, run `/gsd-new-project` first.

---

## Choose your discuss mode

GSD Core offers two modes. Choose based on how well-understood the codebase is.

**If you want to express your own implementation preferences upfront** (interview mode, the default):

```bash
/gsd-discuss-phase 2
```

Claude identifies grey areas in the phase scope, lets you select which to discuss, then works through approximately four questions per area.

**If the codebase already has clear patterns and you find most questions obvious** (assumptions mode):

```bash
node gsd-tools.cjs config-set workflow.discuss_mode assumptions
/gsd-discuss-phase 2
```

Claude reads 5–15 relevant codebase files via a subagent, forms assumptions with evidence and confidence levels, and presents them for confirmation or correction. Typically 2–4 interactions rather than 15–20.

To switch back:

```bash
node gsd-tools.cjs config-set workflow.discuss_mode discuss
```

See [Discuss modes explained](../workflow-discuss-mode.md) for a full comparison, including when each mode is likely to save time.

---

## Discuss all grey areas without the selection step

By default, Claude presents grey areas and asks which you want to cover. If you want to work through all of them without that selection prompt:

```bash
/gsd-discuss-phase 2 --all
```

---

## Speed up a straightforward phase

**If the phase is well-understood and you want Claude to pick the recommended defaults without prompting you:**

```bash
/gsd-discuss-phase 3 --auto
```

Claude selects the recommended answer for every question and logs the choices. Use this for phases where the decisions are low-stakes or already implied by prior phases.

**If you have remote-session constraints (no TUI menus):**

```bash
/gsd-discuss-phase 2 --text
```

All prompts are rendered as plain-text numbered lists instead of interactive selectors.

---

## Work through questions in groups

If you prefer to answer several questions at once rather than one at a time:

```bash
/gsd-discuss-phase 2 --batch
```

Claude groups 2–5 questions per turn.

---

## Add trade-off analysis to each question

If you want a comparison table of the options before committing:

```bash
/gsd-discuss-phase 2 --analyze
```

---

## Bulk-answer from a prepared file

If you have a prepared answers file and want to push all decisions in one pass:

```bash
/gsd-discuss-phase 1 --power
```

---

## Surface Claude's assumptions before discussing

**If you want to see what Claude would assume and do before any interactive session** — useful for validating alignment before investing discussion time:

```bash
/gsd-discuss-phase 3 --assumptions
```

Claude outputs its assumptions (with codebase evidence and confidence levels) and exits. No CONTEXT.md is written. Review the output, then run a normal discuss or assumptions-mode session if anything needs correcting.

---

## What CONTEXT.md contains

Both discuss and assumptions mode produce the same `{phase}-CONTEXT.md` in the phase directory. Downstream agents (researcher, planner, plan-checker) read this file identically regardless of which mode produced it. It contains six sections:

| Section | Purpose |
|---|---|
| `<domain>` | Phase boundary — what this phase delivers |
| `<decisions>` | Locked implementation decisions from the session |
| `<canonical_refs>` | Specs, ADRs, and docs downstream agents must read |
| `<code_context>` | Reusable assets, patterns, and integration points |
| `<specifics>` | User references and preferences |
| `<deferred>` | Ideas noted for future phases |

The `<canonical_refs>` section is mandatory. If you reference a doc, spec, or ADR during the discussion, Claude adds it immediately and reads it to inform subsequent questions.

See [CONTEXT.md schema](../reference/context-md.md) for the full field reference.

---

## How decisions feed into planning

When you run `/gsd-plan-phase` next, the planner reads CONTEXT.md to know which decisions are locked. It will not re-ask questions already answered here. The researcher reads it first to know what to investigate.

**If CONTEXT.md is missing when you run `/gsd-plan-phase`**, you will be offered the choice to continue without context (plans use research and requirements only, without your design preferences) or to run `/gsd-discuss-phase` first.

---

## If you have a PRD or acceptance-criteria document

Skip discuss-phase entirely and go straight to planning:

```bash
/gsd-plan-phase 1 --prd path/to/prd.md
```

The planner synthesises CONTEXT.md from the PRD and treats all requirements as locked decisions.

---

## Related

- [Plan a phase](plan-a-phase.md)
- [Discuss modes](../workflow-discuss-mode.md)
- [CONTEXT.md schema](../reference/context-md.md)
- [docs index](../README.md)
