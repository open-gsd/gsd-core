Apply response_language to all user-facing prose — narration between tool calls, status updates, progress notes, and findings included; preserve code, paths, and identifiers.

<purpose>
Emit a section from the full reference for the topic in `$ARGUMENTS`. Read `workflows/help/modes/full.md`, resolve the topic alias to a section heading using the table below, and output the resolved-routing preamble plus the section content. Scope is controlled by a `--brief` flag in `$ARGUMENTS`: full scope (default) emits the entire section; compact scope (`--brief <topic>`) emits only the signature line + one-line summary for a compact scoped lookup. No additions, no surrounding chrome.
</purpose>

<reference>
**Topic resolution table.** Match the topic alias case-insensitively. Strip a single leading `--` if present.

| Topic alias(es) | Section heading in `full.md` |
|---|---|
| `next`, `smart-entry` | `### Smart Entry` |
| `workflow`, `core`, `core-workflow` | `## Core Workflow` (entire section through end of `### Quick Mode`) |
| `init`, `new-project`, `onboard`, `onboarding`, `brownfield` | `### Project Initialization` |
| `map`, `map-codebase` | The `/gsd:map-codebase` block under `### Project Initialization` |
| `discuss`, `discuss-phase` | The `/gsd:discuss-phase` block under `### Phase Planning` |
| `plan`, `planning`, `plan-phase` | `### Phase Planning` |
| `execute`, `exec`, `execute-phase` | `### Execution` |
| `progress`, `route` | `### Progress Tracking` plus `### Smart Router` |
| `quick`, `quick-mode` | `### Quick Mode` |
| `fast` | The `/gsd:fast` block under `### Quick Mode` |
| `phase`, `phases`, `roadmap` | `### Roadmap Management` |
| `milestone`, `milestones` | `### Milestone Management` plus `### Milestone Auditing` |
| `session`, `pause`, `resume` | `### Session Management` |
| `debug`, `debugging` | `### Debugging` |
| `spike` | The `/gsd:spike` and `/gsd:spike --wrap-up` blocks under `### Spiking & Sketching` |
| `sketch` | The `/gsd:sketch` and `/gsd:sketch --wrap-up` blocks under `### Spiking & Sketching` |
| `spike-sketch`, `experiments` | `### Spiking & Sketching` |
| `capture`, `notes`, `todos` | `### Capturing Ideas, Notes, and Todos` |
| `verify`, `verify-work`, `uat` | `### User Acceptance Testing` plus the `/gsd:audit-uat` block |
| `ship`, `pr` | `### Ship Work` plus the `/gsd:pr-branch` block |
| `review`, `peer-review` | The `/gsd:review` block under `### Ship Work` |
| `audit`, `auditing`, `audit-milestone` | `### Milestone Auditing` |
| `config`, `settings`, `configuration` | `### Configuration` |
| `cleanup` | The `/gsd:cleanup` block under `### Utility Commands` |
| `update` | The `/gsd:update` block under `### Utility Commands` |
| `files`, `structure`, `layout` | `## Files & Structure` |
| `modes`, `interactive`, `yolo` | `## Workflow Modes` |
| `planning-config` | `## Planning Configuration` |
| `workflows`, `common-workflows`, `examples` | `## Common Workflows` |
| `help` | `## Getting Help` |

**Output rules:**

1. Parse `$ARGUMENTS`: detect a `--brief` (or `-b`) flag — this selects **compact scope**. Otherwise scope is **full**. Strip the flag, then take the remaining token (with a single leading `--` stripped) as the topic alias.
2. Resolve the alias against the table.
3. If no match: emit a one-line error followed by a comma-separated list of the canonical topic names from the leftmost column (one per row, deduplicated). Suggest `/gsd:help --full` for the complete reference. Stop.
4. If matched: emit a single resolved-routing preamble line so the user sees what was matched:

   ```text
   **Topic:** `<alias>` → `<heading>` *(scope: full | compact)*
   ```

   Use the canonical alias from the leftmost column. Use the literal heading text from the matched cell. State the scope you are about to emit.

5. Read `workflows/help/modes/full.md` — when `workflow.compact_content` is on, the installed reference is its `full.compact.md` sibling instead, and the two differ in where a command's one-line summary sits (see *Locating the summary* below). Strip `<reference>` / `</reference>` wrapper tags — never emit them. Apply the extraction rule for the matched table cell, modulated by scope:

   5a. **Single section** (cell contains a single `` `## Heading` `` or `` `### Heading` ``):
   - *Full scope:* emit from that heading up to (but not including) the next sibling or higher-level heading.
   - *Compact scope:* emit the heading, then the first **command-signature** bold line within the section (a `` **`<command> [args]`** `` line, whatever prefix the installed reference uses) together with its one-line summary, located per *Locating the summary* below. If the section has no command-signature bold line, emit the heading and the first paragraph.

   5b. **Multiple sections joined by "plus"**: apply rule 5a to each listed section in document order and emit them sequentially with no gap between them.

   5c. **Sub-block** (cell says `the <command> block under ### Heading` or `the <command> ... blocks under ### Heading`): within the named heading's section, start at each command-signature bold line for that command.
   - *Full scope:* stop immediately before the next command-signature bold line or the next heading, whichever comes first.
   - *Compact scope:* emit the bold line together with its one-line summary, located per *Locating the summary* below.

   For cells listing multiple sub-blocks, emit them sequentially.

   **Locating the summary.** The summary sits in one of two places, and which one depends on which
   reference variant is installed — decide per signature line, by looking at the line itself:
   - If the signature line continues past its closing `**` with an em-dash followed by prose, that
     trailing prose **is** the summary. Emit that one line and stop; do not also emit the line
     after it.
   - Otherwise the summary is the single non-blank line immediately after the signature line. Emit
     both lines.
   A `Usage:` line is never a summary. If applying the second case would emit one, emit the
   signature line alone.

6. After the section content, emit a single closing line:

   ```text
   More: /gsd:help --full · /gsd:help <topic> · /gsd:help --brief <topic>
   ```

7. No project-specific commentary, no follow-up questions.
</reference>
