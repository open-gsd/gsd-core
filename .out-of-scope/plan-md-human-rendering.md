# Human-Readable Rendering of PLAN.md

GSD does not change PLAN.md's structural tag convention (`<task>`, `<action>`,
`<tasks>`, `<files>`, `<verify>`, etc.) to improve how a PLAN.md renders when a
human opens the raw file in a markdown viewer on GitHub/GitLab.

## Why this is out of scope

PLAN.md is a **machine artifact**, not a human-facing document. The docs are
explicit:

- `docs/reference/plan-md.md` — a PLAN.md is *"an executable unit of work — a
  structured document that tells an executor agent exactly what to build and how
  to verify it was built correctly."*
- `agents/gsd-planner.md` — *"Produce PLAN.md files that Claude executors can
  implement without interpretation. Plans are prompts, not documents that become
  prompts."*

PLAN.md is produced by `gsd-planner` and consumed by `gsd-executor`,
`gsd-plan-checker`, `gsd-verifier`, and cross-AI review agents. There is no
documented step in which a human opens, reads, reviews, or signs off on a
PLAN.md — unlike `SUMMARY.md` / `VERIFICATION.md`, which are produced for human
validation.

The reported symptom — alphabet-only tags like `<task>` / `<action>` tripping
CommonMark's HTML-block rule so inner markdown renders as cramped run-on text —
only manifests when a human views the raw file in a markdown renderer. It does
**not** affect either machine consumer:

- Tag location/extraction is regex-based (`extractTaggedBlocks` in
  `src/markdown-sectionizer.cts`), operating on raw text, not rendered HTML.
- Agents read the raw file content, not a rendered view.

```js
// The extraction contract is a raw-text regex, indifferent to CommonMark
// HTML-block folding:
new RegExp(`<${escapedTag}>([\\s\\S]*?)</${escapedTag}>`, 'g')
```

The proposed fixes (HTML-comment markers `<!-- task -->`, or underscored tag
names `<task_node>`) would change a load-bearing machine convention that is
duplicated across ~6 surfaces — the extractor regex, the `execute-plan` grep
counter, `verify.cjs`, `decisions.cjs`, and the planner/executor schema docs. A
drift between those surfaces silently breaks plan extraction (the executor finds
zero tasks), which is a far worse failure than cosmetic rendering. The
underscore option additionally increases token consumption on every plan read
(longer tag names, repeated across every PLAN.md, read in full by the executor)
and leaves the marker names visible as literal noise in any rendered view.
Incurring that cost and risk to improve a rendering path that is not a
documented use of PLAN.md does not align with the project's model of PLAN.md as
an agent instruction set.

The same reasoning covers the report's secondary point (unquoted `|` in PLAN.md
frontmatter breaking rendered markdown tables): that too is a human-render
concern for a machine artifact.

**Revisit if** GSD ever introduces a human-review gate for PLAN.md — a step
where a person reads and approves the plan before execution. At that point
PLAN.md gains a documented human audience and its rendering becomes in-scope.

## Prior requests

- #2158 — "PLAN.md XML task tags trigger CommonMark HTML-block rule — task content renders as cramped run-on text"
