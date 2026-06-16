# PLAN.md schema reference

A per-plan `PLAN.md` is GSD Core's executable unit of work — a structured document that tells an executor agent exactly what to build and how to verify it was built correctly. This page documents its structure. See [docs index](../README.md).

---

## Overview

Plans live inside phase directories at:

```
.planning/phases/<NN>-<slug>/<NN>-<PP>-PLAN.md
```

For example: `.planning/phases/03-post-feed/03-02-PLAN.md` (Phase 3, Plan 2).

Plans are produced by the `gsd-planner` agent (spawned by `/gsd:plan-phase`) and consumed by `execute-phase`. A phase typically contains between one and four plans; plans within a phase are assigned to execution waves so that independent work runs in parallel.

---

## YAML frontmatter

Every PLAN.md opens with a YAML frontmatter block between `---` delimiters.

### Annotated example

```yaml
---
phase: 03-post-feed
plan: 02
type: execute
wave: 2
depends_on: ["03-01"]
files_modified:
  - src/components/PostFeed.tsx
  - src/components/PostCard.tsx
  - src/app/feed/page.tsx
autonomous: true
requirements: ["FEED-01", "FEED-03"]
user_setup: []

must_haves:
  truths:
    - "User can scroll through posts from followed accounts"
    - "Each post shows author avatar, name, timestamp, and content"
    - "Empty state appears when no posts exist"
  artifacts:
    - path: "src/components/PostFeed.tsx"
      provides: "Scrollable post list"
      min_lines: 40
    - path: "src/components/PostCard.tsx"
      provides: "Individual post card"
      exports: ["PostCard"]
  key_links:
    - from: "src/components/PostFeed.tsx"
      to: "src/app/api/feed/route.ts"
      via: "fetch in useEffect — calls /api/feed endpoint"
      pattern: "fetch.*api/feed"
---
```

### Frontmatter field reference

| Field | Required | Type | Purpose |
|---|---|---|---|
| `phase` | Yes | string | Phase identifier, e.g. `03-post-feed`. |
| `plan` | Yes | string | Plan number within the phase, e.g. `02`. |
| `type` | Yes | `execute` or `tdd` | `execute` for standard plans; `tdd` for test-driven plans where tests are written before implementation. |
| `wave` | Yes | integer | Execution wave. Plans in wave 1 run in parallel (no dependencies). Plans in wave 2+ wait for all plans in the previous wave to complete. Pre-computed at plan time by `gsd-planner`. |
| `depends_on` | Yes | array of plan IDs | Plans this plan must wait for. Empty array = wave 1. Example: `["03-01"]` means this plan runs after Plan 01 in Phase 3. |
| `files_modified` | Yes | array of paths | Every file this plan creates or modifies. Used by the plan-checker to detect same-wave file conflicts and by execute-phase for merge tracking. |
| `autonomous` | Yes | boolean | `true` when all tasks are type `auto`. `false` when the plan contains any `checkpoint:*` task that requires human interaction. |
| `requirements` | Yes | array of IDs | Requirement IDs from ROADMAP.md that this plan addresses. Every phase requirement ID must appear in at least one plan's `requirements` field. Empty arrays are a BLOCKER. |
| `user_setup` | No | array of objects | External-service setup steps that Claude cannot automate (account creation, secret retrieval, dashboard configuration). When present, execute-phase generates a `USER-SETUP.md` checklist for the developer. |
| `must_haves` | Yes | object | Goal-backward verification criteria. See below. |

---

## `must_haves` field

`must_haves` captures what must be observably true for the phase goal to be achieved. It is derived during planning and verified after execution by the `gsd-verifier` agent.

### Sub-fields

| Sub-field | Type | Purpose |
|---|---|---|
| `truths` | array of strings | Observable behaviours from the user's perspective. Each must be verifiable. Example: `"User can send a message"`, not `"WebSocket library installed"`. |
| `artifacts` | array of objects | Files that must exist with substantive implementation (not stubs). |
| `artifacts[].path` | string | File path relative to project root. |
| `artifacts[].provides` | string | What capability this file delivers. |
| `artifacts[].min_lines` | integer (optional) | Minimum line count to be considered non-stub. |
| `artifacts[].exports` | array of strings (optional) | Expected named exports to verify. |
| `artifacts[].contains` | string (optional) | Regex or literal pattern that must appear in the file. |
| `key_links` | array of objects | Critical connections between artifacts — the wiring that makes the system work end-to-end. |
| `key_links[].from` | string | Source file (relative path from project root). Must be a literal file path — describe components or symbols in `via:`. |
| `key_links[].to` | string | Target file (relative path from project root). Must be a literal file path — describe endpoints, modules, or APIs in `via:`. |
| `key_links[].via` | string | Description of how they connect, including any endpoint, component, or symbol name (e.g. `fetch in useEffect — calls /api/feed`, `Prisma query via prisma.message`, `import`). |
| `key_links[].pattern` | string (optional) | Regex to verify the connection exists in source. |

---

## Body structure

After frontmatter, the plan body uses named XML-style blocks read by the executor agent.

### `<objective>`

States what the plan delivers and why it matters for the project:

```xml
<objective>
Implement the post feed as a scrollable card list.

Purpose: Core display feature for the social feed phase.
Output: PostFeed and PostCard components wired to /api/feed.
</objective>
```

### `<execution_context>`

Lists workflow files the executor reads before starting. Always includes the execute-plan workflow; adds the checkpoints reference when the plan contains checkpoint tasks:

```xml
<execution_context>
@~/.claude/gsd-core/workflows/execute-plan.md
@~/.claude/gsd-core/templates/summary.md
</execution_context>
```

### `<context>`

References source files the executor needs to read. Includes project-level planning docs and any source files whose patterns or types the plan must replicate. Prior plan `SUMMARY.md` files are included only when there is a genuine dependency (imported types, shared decision) — not reflexively:

```xml
<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@src/components/UserCard.tsx
</context>
```

### `<tasks>`

Contains one or more `<task>` elements. Every task element must carry `<name>`, `<files>`, `<read_first>`, `<action>`, `<verify>`, `<acceptance_criteria>`, and `<done>` for `type="auto"` tasks.

---

## Task types

| Type | Use | Autonomy |
|---|---|---|
| `auto` | Everything the executor can do independently. | Fully autonomous. |
| `checkpoint:human-verify` | Visual or functional verification that requires a human to look at a running UI or service. | Pauses execution; presents to the developer; resumes on approval. |
| `checkpoint:decision` | Implementation choices that arose during execution and require the developer's input. | Pauses execution; presents options; resumes on selection. |
| `checkpoint:human-action` | Truly unavoidable manual steps (account creation, hardware interaction). Used sparingly. | Pauses execution; resumes on confirmation. |

Plans that contain any checkpoint task must set `autonomous: false` in frontmatter.

---

## `auto` task structure

```xml
<task type="auto">
  <name>Task 1: Create PostCard component</name>
  <files>src/components/PostCard.tsx</files>
  <read_first>src/components/UserCard.tsx, src/types/post.ts</read_first>
  <action>Create PostCard component accepting a Post prop (id, authorId, content, createdAt,
    reactionCount). Render author avatar using UserAvatar from UserCard pattern. Show timestamp
    using date-fns formatDistanceToNow. Export as named export PostCard.</action>
  <verify>npx tsc --noEmit</verify>
  <acceptance_criteria>
    - src/components/PostCard.tsx exports named export PostCard
    - PostCard.tsx contains "reactionCount" prop usage
    - npx tsc --noEmit exits 0
  </acceptance_criteria>
  <done>PostCard renders post content with author and timestamp</done>
</task>
```

### Required fields for `auto` tasks

| Field | Rule |
|---|---|
| `<files>` | Every file the task creates or modifies. The executor writes only these files. |
| `<read_first>` | Files the executor must read before touching anything — the file being modified, any source-of-truth pattern file, any file whose types or conventions must be replicated. |
| `<action>` | Concrete instructions with exact identifiers, file paths, function signatures, and expected values. Never says "align X with Y" without specifying the target state. Never contains fenced code blocks or full implementations. |
| `<verify>` | A runnable command or check that proves the task succeeded. Must distinguish pass from fail — `echo "done"` is not valid. |
| `<acceptance_criteria>` | Verifiable conditions: grep-verifiable strings, command exit codes, observable behaviours. No subjective language ("looks correct", "properly configured"). Negative greps (`! grep -Eq 'PAT' file`) are file-scoped — region-scope them (`sed -n`/`awk` range, then grep) when a sibling task needs the construct elsewhere in the same file (#968). |
| `<done>` | A short measurable statement of the completed outcome. |

---

## Plan quality dimensions

The `gsd-plan-checker` agent reviews every PLAN.md across 12 dimensions before execution begins. A plan that fails any BLOCKER-severity check is returned to `gsd-planner` for revision (up to 3 iterations):

| Dimension | What it checks |
|---|---|
| **1 — Requirement Coverage** | Every phase requirement ID from ROADMAP.md appears in at least one plan's `requirements` frontmatter field and has covering task(s). |
| **2 — Task Completeness** | Every `auto` task carries all required fields (`<files>`, `<action>`, `<verify>`, `<acceptance_criteria>`, `<done>`). No vague or empty fields. |
| **3 — Dependency Correctness** | `depends_on` references are valid, acyclic, and consistent with wave numbers. Wave N plan depends only on plans in waves < N. |
| **4 — Key Links Planned** | Artifacts in `must_haves.key_links` have corresponding tasks that implement the wiring — not just the artifact creation. |
| **5 — Scope Sanity** | Plans stay within context budget: 2–3 tasks per plan (4 = warning, 5+ = BLOCKER), ≤ 8–10 files per plan (15+ = BLOCKER). |
| **6 — Verification Derivation** | `must_haves.truths` are user-observable behaviours, not implementation details. Artifacts map to truths. Key links cover critical wiring. |
| **7 — Context Compliance** | Every `D-NN` decision from CONTEXT.md is addressed by at least one task. No task implements anything from `<deferred>`. |
| **7b — Scope Reduction Detection** | Task actions do not silently reduce a locked decision to a "v1", "stub", or "future enhancement" without delivering the full decision scope. Always a BLOCKER when found. |
| **7c — Architectural Tier Compliance** | Tasks assign capabilities to the correct tier per the RESEARCH.md Architectural Responsibility Map (when present). Security-sensitive capabilities in the wrong tier are BLOCKERs. |
| **8 — Nyquist Compliance** | When `workflow.nyquist_validation` is enabled and RESEARCH.md exists, every task has an `<automated>` verify command, no consecutive window of 3 tasks lacks coverage, and VALIDATION.md is present. |
| **9 — Cross-Plan Data Contracts** | When plans share data pipelines, their transformations are compatible — no plan strips data that another plan needs in original form. |
| **10 — CLAUDE.md Compliance** | Plans respect project-specific conventions, forbidden patterns, required tools, and security requirements from `./CLAUDE.md`. |
| **11 — Research Resolution** | When RESEARCH.md exists, its `## Open Questions` section is marked `(RESOLVED)` before planning proceeds. |
| **12 — Pattern Compliance** | When PATTERNS.md exists, tasks reference the correct analog patterns for each new or modified file. |

---

## Wave execution model

Wave numbers are pre-computed during planning. Execute-phase groups plans by wave number and runs each wave's plans in parallel:

```
Wave 1: Plan 01, Plan 02, Plan 03  (all run simultaneously — no dependencies)
Wave 2: Plan 04                    (waits for Wave 1 to complete)
Wave 3: Plan 05                    (waits for Wave 2 to complete)
```

Plans within a wave that modify overlapping files must not be in the same wave — the plan-checker's Dimension 3 flags this as a BLOCKER.

---

## Plan output

After a plan executes successfully, the executor writes a SUMMARY.md at:

```
.planning/phases/<NN>-<slug>/<NN>-<PP>-SUMMARY.md
```

The SUMMARY.md is the canonical record of what was built. Subsequent plans in the same phase may reference it when they have a genuine dependency on its types or decisions.

---

## Related

- [CONTEXT.md schema](context-md.md)
- [Planning artifacts](planning-artifacts.md)
- [Features](../FEATURES.md)
- [docs index](../README.md)
