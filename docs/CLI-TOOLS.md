# GSD CLI Tools Reference

> Reference for the `gsd-tools` CLI (`gsd-core/bin/gsd-tools.cjs`). For slash commands and user flows, see [Command Reference](COMMANDS.md). Return to [docs index](README.md).

---

## Overview

`gsd-tools.cjs` centralizes config parsing, model resolution, phase lookup, git commits, summary verification, state management, and template operations across GSD commands, workflows, and agents.


|                    |                                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Shipped path**   | `gsd-core/bin/gsd-tools.cjs`                                                                                                                                                                      |
| **Implementation** | 20 domain modules under `gsd-core/bin/lib/` (the directory is authoritative)                                                                                                                        |
| **Status**         | Primary runtime command surface for orchestration, workflows, and automation. |


**Usage (CJS):**

```bash
node gsd-tools.cjs <command> [args] [--raw] [--cwd <path>]
```

**Global flags (CJS):**


| Flag                | Description                                                                  |
| ------------------- | ---------------------------------------------------------------------------- |
| `--raw`             | Machine-readable output (JSON or plain text, no formatting)                  |
| `--cwd <path>`      | Override working directory (for sandboxed subagents)                         |
| `--ws <name>`       | Workstream context for `.planning/workstreams/<name>` paths |
| `--pick <field>`    | Extract one field from a command's JSON output — see [`--pick <field>` contract](#--pick-field-contract) below |

These global flags are read once, before the command runs, and are never passed on to the command. The full global set is recorded under `global` in [`CLI-SURFACE-MANIFEST.json`](CLI-SURFACE-MANIFEST.json). Besides the flags above, it includes `--project-dir`, `--default`, `--json-errors` and `--exit-contract=<v>`.

---

### Command flags and the CLI surface manifest

Each command declares its flags in one place, `src/cli-surface.cts` ([ADR-4909](adr/4909-shipped-surface-contract-seam.md) D1). [`docs/CLI-SURFACE-MANIFEST.json`](CLI-SURFACE-MANIFEST.json) is generated from those declarations. For each command it lists:
- the command name and its aliases;
- how many positional words it takes, and whether further words may appear among the flags (`freePositionals`), and whether a short flag such as `-n` is refused instead of read as a word (`rejectShortFlags`);
- each flag and its kind;
- the flags it requires;
- the global value flags it refuses before they are consumed (`rejectedGlobalFlags`), for the commands that declare any;
- whether the command reads the active workstream.

Regenerate the manifest with `npm run gen:cli-surface-manifest`. `npm run lint:generated-sync` fails when it is stale.

| Flag kind in the manifest | Accepted form |
| --- | --- |
| `value` | `--name <value>`. If the next token is missing or starts with `--`, the flag counts as absent. |
| `value-or-bare` | As `value`, but a bare `--name` means "present and empty". |
| `boolean` | `--name` |
| `optional-value` | `--name` with or without a value |
| `repeatable` | `--name <value>` any number of times; every non-empty value is kept, in order. An empty value counts as none. |
| `list` | `--name a b c`. The values run until the command's next list flag, and repeated runs merge. |
| `multiword` | `--name some words`. The words run until the next `--` token and are joined with spaces. |

A command whose manifest entry lists `eq` also accepts those flags as `--name=<value>`. The flags listed under `nonEmpty` must have a value whenever they are passed; `emptyValue` and `emptyEq` name the ones for which a literal empty value (`--name ''`, `--name=`) still counts as a value. When a flag is repeated, the first occurrence wins. A command with `passthroughAfter: "--"` does not check anything after a literal `--`.

A declared command rejects bad arguments before it does any work. Each rejection exits non-zero with reason `usage`, which `--json-errors` reports as `reason: "usage"`:

| Input | Message names |
| --- | --- |
| A flag the command does not declare | the flag, and the flags it accepts |
| A required flag missing, or given an empty value | `missing required flag --name` |
| A flag that must not be empty given without a value | `Missing value for --name` |
| A positional word the command does not take | the word |

Commands listed under `undeclared` in the manifest still parse their own flags. Their declarations land in [#6088](https://github.com/open-gsd/gsd-core/issues/6088), [#6089](https://github.com/open-gsd/gsd-core/issues/6089) and [#6090](https://github.com/open-gsd/gsd-core/issues/6090); the last one removes the `undeclared` list.

---

### `--pick <field>` contract

`--pick <field>` runs `<command>` as normal, parses its stdout as JSON, and
extracts one field by name (dotted paths and `[N]` array indices are
supported, e.g. `a.b.c`, `directories[-1]`). As of ADR-3473 §8.4 / #3884, the
three possible outcomes are distinguished **by exit code**, never by an
ambiguous empty string:

| Outcome | stdout | stderr | Exit code |
| --- | --- | --- | --- |
| Field present | The field's value, coerced to a string | (none) | `0` |
| Field absent (missing key, out-of-range index, dotted path partially missing, or a non-object JSON root) | empty | Diagnostic naming the field and the available top-level keys (or the actual JSON root type) | `1` (`pick_field_absent`) |
| Command output is not JSON (including `--raw` output, which is plain text/human-readable, not JSON) | empty | Diagnostic saying the output was not JSON | `1` (`pick_output_not_json`) |

A `null` or empty-string (`''`) field value is a real answer, not an absence
— it still prints (an empty line) at exit **0**. Only the *absence of the
field itself* is a failure. This is why `--raw` and `--pick` are, in
practice, mutually exclusive: `--raw` output is not JSON, so combining them
always hits `pick_output_not_json`.

**This replaces the previous behavior.** Before #3884, an absent field (or
non-JSON output) silently printed an empty string at exit `0` — indistinguishable
from a field that genuinely held `null` or `''`. That coercion is gone. The
common shell idiom

```bash
X=$(gsd_run query some.command --pick some_field 2>/dev/null) || X=default
```

now works as written: the `|| X=default` arm fires exactly when the field
could not be resolved, and never fires merely because the resolved value
happens to be empty.

---

## State Commands

Manage `.planning/STATE.md` — the project's living memory.

```bash
# Load full project config + state as JSON
node gsd-tools.cjs state load

# Output STATE.md frontmatter as JSON
node gsd-tools.cjs state json

# Update a single field. Frontmatter keys are projections of body fields —
# write the body field (see COMMANDS.md#state-update-field-value).
node gsd-tools.cjs state update <field> <value>

# Get STATE.md content or a specific section
node gsd-tools.cjs state get [section]

# Batch update multiple fields
node gsd-tools.cjs state patch --field1 val1 --field2 val2

# Increment plan counter
node gsd-tools.cjs state advance-plan
# When no labeled plan position can be parsed (e.g. ## Current Position drifted
# to pure narrative prose), declines with reason "plan_position_unreadable" plus
# the disk-derived counts and the exact labeled lines to re-insert; STATE.md is
# left byte-identical.

# Record execution metrics
node gsd-tools.cjs state record-metric --phase N --plan M --duration Xmin [--tasks N] [--files N]

# Recalculate progress bar
node gsd-tools.cjs state update-progress

# Add a decision
node gsd-tools.cjs state add-decision --summary "..." [--phase N] [--rationale "..."]
# Or from files:
node gsd-tools.cjs state add-decision --summary-file path [--rationale-file path]
# Text-file inputs (--summary-file, --rationale-file, --text-file, --note-file) are
# read once and copied into STATE.md, so any readable regular file of up to 256 KiB is
# accepted, including one in a temp/scratch directory outside the project; a relative
# path resolves against the project root. A file that cannot be read, a FIFO, device
# or directory, a file over 256 KiB, a required field left blank (an empty or
# whitespace-only --summary, --text or --note, inline or as a file), or a missing
# STATE.md is refused on stderr with a non-zero exit (reason "usage") and STATE.md is
# not touched. A blank rationale, inline or file, just means no rationale.
# (add-decision, add-blocker and add-roadmap-evolution only.)

# Add/resolve blockers
node gsd-tools.cjs state add-blocker --text "..."
node gsd-tools.cjs state add-blocker --text-file path
node gsd-tools.cjs state resolve-blocker --text "..."

# Record session continuity (at least one of --stopped-at / --resume-file is required).
# --session also writes .planning/sessions/<session_id>.json beside the STATE.md ## Session block;
# --role / --role-id label the session (role_id is the ASCII slug the CLI derives).
node gsd-tools.cjs state record-session --stopped-at "..." [--resume-file path] [--session ID] [--role TEXT] [--role-id SLUG]

# Per-session pause (ADR-4962): the resumed session records "Session resumed, proceeding to <action>",
# repairs a legacy frontmatter-only `status: paused`, and removes only its own handoff.
node gsd-tools.cjs state session-resume [--session ID] [--role TEXT] [--role-id SLUG] [--action TEXT] [--handoff NAME] [--keep-handoff]

# Read-only: every handoff and session record under .planning/, who owns each, and whether this session is paused
node gsd-tools.cjs state sessions [--session ID] [--role TEXT] [--role-id SLUG]

# Phase start — update STATE.md Status/Last activity for a new phase. When some of the phase's plans
# already have summaries (a gap-closure re-entry), Current Plan and `Plan: N of M` start at the first
# plan still to run instead of 1, and a **Current focus:** value that wraps onto further lines is
# replaced whole.
node gsd-tools.cjs state begin-phase --phase N --name SLUG --plans COUNT

# Agent-discoverable blocker signalling (used by discuss-phase / UI flows)
node gsd-tools.cjs state signal-waiting --type TYPE --question "..." --options "A|B" --phase P
node gsd-tools.cjs state signal-resume
```

`state update`, `state patch` and `state record-session` take single-line values: a value containing a line break — CR, LF, U+2028 LINE SEPARATOR or U+2029 PARAGRAPH SEPARATOR, each of which starts a new line for the STATE.md readers — is refused with an error naming the field or flag, before anything is written.

`state record-session` lists the fields it wrote under `updated`, and under `replacedRecord` any Stopped At / Resume File value the write displaced (the `None` placeholder is not a record). In the session section, a line inside a fenced code block is an example: no session writer (`record-session`, `state update`/`patch` of a session field, `phase complete`) changes it, and neither the frontmatter sync nor `state-snapshot` reads it as a field. A field whose current value continues onto the next line is left unchanged, because a single-line write would orphan the rest (a line directly below shaped `words: text` counts as a continuation unless its label is bold or one STATE.md defines, such as `Resume file` or `Status`, since a wrapped sentence can take that shape): it is listed under `skipped` as `{ "field", "reason": "wrapped_value", "continuation" }` with a warning on stderr (the continuation is echoed up to 200 characters, then `…`), and when every field to update was skipped the call reports `"recorded": false`. With no session heading, Last session, Last Date and Resume file are not written in place — `state-snapshot` reads them from a session section only — and the call appends a `## Session` section (reported as `"created": true`, which an insert into an existing section is not) holding the new Last session and Stopped at, and the passed Resume file or else the body's existing one rather than `None` (a Stopped at skipped as wrapped carries its existing value); a carried value holding U+2028/U+2029 is left out and listed as `{ "field", "reason": "line_separator" }`, and when the document ends inside an unclosed code fence nothing is appended (it would land inside the fence) and each field the call writes (Last session, and Stopped at or Resume file when passed) that was not written in place or skipped for another reason is listed with `"reason": "unclosed_fence"`. `state record-session`, `state update` and `state patch` write a session field (Stopped At, Paused At, Resume File, Last session, Last Date) inside the session section — not a fenced example there, and not a copy in another section such as `## Session Continuity Archive` — which is where the frontmatter sync and `state-snapshot` read it. `record-session` inserts a field the section lacks; `state update` and `state patch` report it updated, and a document whose session section lacks the field, or that has no session section, reports it not found and is left unchanged. `state patch`, like `state update`, reports a field that already holds the requested value as updated. `state update` and `state patch` replace a field's first line only and do not check for a wrapped value, so a continuation line below it stays in place: fold a wrapped value onto one line before updating it with them.

**Per-session pause (ADR-4962).** A session is paused when a handoff file that belongs to it exists under `.planning/`. The handoff filename grammar is owned by `src/session-store.cts`: `HANDOFF.latest.<role_id>.json` (one slot per role, with `.continue-here.latest.<role_id>.md`), `HANDOFF.<session_id>.json` (a session without a role), `HANDOFF.claimed.<role_id>.<session_id>.json` (a resume in progress), and the legacy `HANDOFF.json` + `.continue-here.md`, which stays resumable. A keyed file is owned by its filename; the legacy file is owned by any session unless its body names a different role. The session id comes from `--session`, else the first set of `GSD_SESSION_KEY`, `CODEX_THREAD_ID`, `CLAUDE_SESSION_ID`, `CLAUDE_CODE_SESSION_ID`, `OPENCODE_SESSION_ID`, `GEMINI_SESSION_ID`, `CURSOR_SESSION_ID`, `WINDSURF_SESSION_ID` (the workstream store's own list in its own order, minus the terminal-identity keys, so one session never gets two ids); a terminal, tmux or TTY identity is never used, so with none of these set `session_id` is `null` and `session-resume` writes and deletes nothing.

`state record-session --session S` also writes `.planning/sessions/S.json` (`session_id`, `role`, `role_id`, `stopped_at`, `last_session`, `resume_file`; a field the call does not pass keeps its earlier value) and adds `session_record: { written, path | reason }` to its output. Without `--session` the output and STATE.md are unchanged and no record is written, even when a runtime key is set. A `sessions/` directory or record path that is a symlink or not a regular file is not written through: the record is reported `written: false` with a `reason` and the STATE.md write stands.

`state session-resume` reports `{ session_id, role_id, recorded, status, handoff }`. `status` is `{ before, after, cleared }`, plus `reason` when nothing changed: a legacy frontmatter `status: paused` is repaired from the body `Status:` line only when no `Paused At:` line (or frontmatter `paused_at`) claims the pause. `handoff` is `{ removed, failed, refused? }`: `removed` lists the caller's own handoff and its `.continue-here` companion, `failed` any unlink that could not complete (for example `EBUSY` on Windows), and `refused` a `--handoff` name that is not a plain handoff file name. `--handoff NAME` adopts that one file instead, including another session's (a role-less session after `/clear` takes over its old session's file), except a `HANDOFF.claimed.*` file held by a different session, which is a resume in progress and is refused with `refused: "claimed by another session"`; `--keep-handoff` removes nothing. The legacy status repair does not depend on owning a handoff: any caller with a session id may clear a stuck frontmatter `paused`, since the value is project-wide and no shipped workflow clears it.

`state sessions` is read-only and reports `{ session_id, role_id, paused, handoffs, records, skipped }`: each handoff carries `kind`, `role_id`, `session_id`, `is_self` and `continue_here_path`; `skipped` lists files that were not read, each with a `reason` (`symlink`, `not a regular file`, `EFBIG` over 256 KiB, `invalid JSON`, `not a JSON object`, or the errno).

### State Snapshot

Structured parse of the full STATE.md:

```bash
node gsd-tools.cjs state-snapshot
```

Returns JSON with: current position, phase, plan, status, decisions, blockers, metrics, last activity.

### Smart Entry

Read-only situation classifier used by `/gsd-next`.

```bash
node gsd-tools.cjs smart-entry          # Human summary + recommended route
node gsd-tools.cjs smart-entry --json   # Machine-readable result for workflows
```

The JSON result contains `situation`, `recommended`, `summary`, `signals`, and ordered `actions[]`. Detection reads `.planning/STATE.md`, `ROADMAP.md`, latest verification/summary artifacts, and git status; it does not write files or dispatch commands.

---

## Phase Commands

Manage phases — directories, numbering, and roadmap sync.

```bash
# Find phase directory by number
node gsd-tools.cjs find-phase <phase>

# Calculate next decimal phase number for insertions
# (bracket convention: canonical two-digit sub-phase, see below)
node gsd-tools.cjs phase next-decimal <phase>

# Append new phase to roadmap + create directory
node gsd-tools.cjs phase add <description>

# Insert decimal phase after existing
node gsd-tools.cjs phase insert <after> <description> [--sibling]
# add, add-batch and insert also write the phase's ROADMAP record (#5221): a checklist entry
# after the active checklist, else a progress-table row, else no readable record; the output's
# roadmap_entry says which ("checklist" | "progress_table" | "none")

# Remove phase, renumber subsequent
# (bracket convention: also reports roadmap_lines_rewritten and
# references_left_untouched, see below)
node gsd-tools.cjs phase remove <phase> [--force]

# Mark phase complete, update state + roadmap
# Also emits advisory `warnings[]` when a phase SUMMARY references a file that
# is not on disk — see "Phase SUMMARY artifact check" below.
node gsd-tools.cjs phase complete <phase>

# Evaluate HUMAN-UAT results for a phase (markdown-aware; ignores false-positive contexts)
# Returns JSON: { passed, uat_files[], verification_files[], checks[], blockers[], policy }
# Exit 0 when passed, 1 when not (#5170); a phase it cannot read is error() with empty stdout
node gsd-tools.cjs phase uat-passed <phase> [--require-verification]

# Index plans with waves and status (the output is always JSON; --json is accepted and changes nothing)
node gsd-tools.cjs phase-plan-index <phase> [--json]

# List phases with filtering
node gsd-tools.cjs phases list [--type planned|executed|all] [--phase N] [--include-archived]

# Archive every current phase directory into milestones/<label>-phases/ (label: `--archive-version` when given, else the current milestone version, else `archived-<date>`; `new-milestone` passes the outgoing version) —
# used by /gsd-new-milestone before roadmapping the next cycle.
# --force skips the uncommitted-changes check only; nothing is deleted.
node gsd-tools.cjs phases clear [--confirm] [--force] [--archive-version <version>]
```

### Custom bracket phase IDs

New-project project_code derives from the PROJECT.md title when it exists, otherwise from the directory name.
Derived codes contain at most six characters, including a digit-leading `P` prefix.

With custom naming, `phase add "Auth" --id CK.02-05` or
`--id "[CK.02] 05"` accepts a canonical active-milestone identity, preserving
its number even when higher IDs exist. Invalid, foreign, unpadded, plan or
slug-suffixed IDs fail with reason `usage`; duplicates fail with `phase_id_collision`, both with zero writes.
Sentinel phase/subphase numbers (00, 999) and integers outside the safe range are invalid. Output matches a
generated bracket add; inferred dependencies are omitted. Custom bracket add
without an ID and custom add-batch refuse; use `phase add --id`.

### Bracket phase ids (`phase remove`, `phase next-decimal`)

When `phase_id_convention` is `"bracket"` (see [CONFIGURATION.md](CONFIGURATION.md)),
these commands work on the active milestone's `[CODE.MM] NN` identities:

- `phase next-decimal <phase>` inventories every spelling the readers accept
  for that parent, on disk and in `ROADMAP.md` (bracket and legacy directories,
  headings, checklist rows), and returns the next sub-phase in canonical
  two-digit form (`02.03`, not `2.3`). The legacy `999` backlog parent keeps
  its upstream spelling.
- `phase remove <phase>` accepts a bare number (`2`, `02`), a qualified id
  (`CK.02-02`, `CK.02-01.01`) or the display form (`[CK.02] 02`). A qualified
  directory name with a slug (`CK.02-02-two`) is accepted only when the slug
  exactly matches the selected directory. It deletes
  the phase, renumbers the milestone's later phases and sub-phases on disk and
  in `ROADMAP.md` from one mapping, and leaves shipped and archived history
  byte-identical. It refuses, before anything is deleted or renamed, in the
  cases listed below.

`phase remove` refuses, with nothing changed, when:

- a qualified argument carries a slug that does not exactly match the
  directory for its phase number;
- the target has neither a directory nor a live heading or checklist row in the
  active milestone window, or the argument names a `.00` sub-phase;
- the phase is outside the active milestone, has executed plans (without
  `--force`) or live sub-phases, or resolves only to legacy-spelled artifacts;
- a pipe-table row keyed by the removed id would survive outside the
  milestone's own Progress tables: a shared Progress table the rewrite cannot
  attribute, or any other phase-keyed table (for example a Requirements
  Traceability table) under a heading of any level. A Progress-table row is
  one whose nearest heading is a Progress-titled heading, a phase heading or
  the milestone heading itself;
- a phase id in the active milestone, such as `02a`, is one the bracket grammar
  cannot represent and the removal would renumber it;
- the `STATE.md` current phase (frontmatter `current_phase`, the
  `Current Phase` field, or the Current Position `Phase:` line, read in that
  order) is the removed phase or a phase the removal renumbers, that is, the
  target is the current phase or any phase before it. Bracket `phase remove` deletes only phases after the current phase, because
  it does not rewrite the current-phase fields. To remove such a phase, point
  the current phase at a phase before the target, or, when there is none,
  clear the current-phase fields, then retry. A current phase qualified with
  another milestone (`[CK.01] 02`) does not count.

Known limits of bracket `phase remove`, which it neither rewrites nor refuses:

- A checklist row for the removed id outside the active milestone window (a
  stale copy elsewhere in `ROADMAP.md`) is kept as written and is not
  reported.
- The dash form is matched case-sensitively: `CK.02-03` is renumbered and
  reported, `ck.02-03` is neither.
- Paths are recognized only with forward slashes. A plan or summary filename
  after a backslash (`phases\CK.02-03-three\03-01-PLAN.md`) is renumbered as
  a bare artifact reference, where the forward-slash form is left alone.
- An on-disk `CK.MM-NNa` directory with no `ROADMAP.md` line is not checked;
  the unrepresentable-id refusal reads `ROADMAP.md` only.

The bracket `phase remove` JSON output adds two fields:

| Field | Meaning |
|---|---|
| `roadmap_lines_rewritten` | Number of `ROADMAP.md` edits: the deleted phase section counts once, plus each deleted owned line (checklist row, Progress row) and each line whose references were renumbered. |
| `references_left_untouched` | Line numbers, in the written `ROADMAP.md`, of live lines in the active milestone that still mention the removed id or a pre-renumber id in any spelling (for example prose such as `Phase 03`). Review these by hand. Empty when nothing was left. |

### Milestone-scoped phase listing (`phases list`)

The bare `phases list` (no `--phase`, no `--include-archived`) is scoped to the
current milestone's `ROADMAP.md` window **and** filtered through the canonical
sentinel predicate: `999.*` backlog directories and `0-*` pre-milestone
directories are not listed as current-milestone phases. `--phase <N>` (a direct
lookup) and `--include-archived` (an archive listing) are deliberately **not**
scoped or sentinel-filtered — they answer "does this phase exist" and "what has
ever existed here," not "what belongs to this milestone," so they still see
sentinel and out-of-window directories.

### `phases clear` and sentinel directories

`phases clear` moves every phase directory under `.planning/phases/` except
sentinels into `milestones/<label>-phases/` (`--archive-version` when given, else the current milestone version, else `archived-<date>`); it never deletes. `--force`
skips only the uncommitted-changes check, and those edits are archived with the
directory. It excludes both `999.*` (backlog) and `0-*` (pre-milestone)
directories via the same canonical sentinel predicate `phases list` uses —
previously its own regex excluded `999` but not `0`, so a `0-*` directory was
archived with the rest.

### `find-phase` plan/summary counts (live vs physical)

`find-phase`'s JSON carries the existing `plans[]` / `summaries[]` arrays
**unchanged**, plus three additive scalar fields:

| Field | Set | Answers |
|---|---|---|
| `plan_count` | live — `status: superseded` plans excluded | "how much outstanding work is left in this phase?" (same set as `plans[]`) |
| `summary_count` | live | same, for `summaries[]` |
| `plan_count_all` | physical — every canonically-named plan file on disk, superseded included | "what has the planner actually written to disk?" |

Naming mirrors `roadmap analyze`'s existing `plan_count`/`summary_count`, and the
`_all` suffix echoes the underlying `scanPhasePlans` field it is drawn from.
**Pick by the question you're asking, not by which number looks bigger:** a
phase where every plan is `status: superseded` correctly reports `plan_count: 0`
— that is a real "nothing outstanding" answer, not a bug — while
`plan_count_all` still reports the physical count, so a check for "did the
planner produce anything at all" doesn't misread a fully-superseded phase as
untouched.

When the phase can't be resolved, all three fields are `null`, not `0` — a
fabricated `0` would read identically to a genuinely empty phase.

### Phase SUMMARY artifact check

A phase `SUMMARY.md` asserts which files the phase created or modified. On
`phase complete`, each SUMMARY in the phase is scanned for referenced file paths
and any path that is not on disk is reported in the command's existing
`warnings[]` array — the case where a summary reports work that never landed.

**Advisory only.** Findings never block completion; the completion gate is the
phase's `VERIFICATION.md` status, which this does not touch. `/gsd-execute-phase`
surfaces the warnings before advancing.

Scope and limits, so the output is not read as more than it is:

- Paths are recovered heuristically from the SUMMARY body — backticked paths and
  `Created:`/`Modified:`-style lines. Globs, URLs, bare hostnames, and paths
  resolving outside the project are skipped rather than reported.
- The `key-files:` frontmatter block is **not** read. Its YAML flow-sequence form
  (`created: [a.ts, b.ts]`) is not matched by the prose scan, so a summary whose
  only file claims live there produces no findings.
- Commit hashes in the SUMMARY are **not** resolved here. The pattern matches any
  hex-shaped token in prose, which is too loose to surface.

Every path the scan does recover is checked — there is no cap. The standalone
`verify-summary` verb keeps its historical default of checking the first two.

### `phase-plan-index`: unresolved `depends_on` tokens (ADR-3473 §8.5, #3427/#3885)

A plan's `depends_on:` token must resolve to another plan in the same phase (by
exact id or by canonical id). When a token resolves to neither, the edge is
dropped and the dependent plan becomes a DAG root — `phase-plan-index` now
names this in `warnings[]` instead of silently discarding it:

```text
Plan 03-02: depends_on token "typo-plan-id" does not resolve to any plan in this
phase — edge dropped, wave placement for this plan may be unreliable
```

The token is escaped (quoted, control characters and embedded newlines
backslash-escaped) before it is embedded in the warning, so a `depends_on`
value crafted to contain a newline or a quote cannot forge a second,
fabricated warning entry when `warnings[]` is printed one-per-line.

**The wave-mismatch warning is suppressed for an affected plan.** Normally a
plan whose declared `wave:` disagrees with the computed DAG wave gets its own
warning (`"declared wave: N but depends_on DAG places it in wave M"`). When
the disagreement is caused by a dropped edge on that same plan, that warning
would blame the author for a mismatch the tool itself manufactured by losing
an edge — so it does not fire for that plan; the unresolved-token warning above
stands in its place. A plan with **no** dropped edges and a genuinely wrong
`wave:` still gets the mismatch warning as before.

This does not repair `waves` / `wave` themselves — those fields stay computed
from the DAG with the edge missing, since the edge cannot be invented. A
consumer using `wave` for scheduling (`WAVE_FILTER`, the wave-safety check)
is still working from the degraded assignment; only the diagnostic surfaces
the loss.

### The ROADMAP `**Requirements**:` line grammar

`phase complete` reads each phase's `**Requirements**:` line to decide which
REQ-IDs to mark. The grammar is deliberately small, and it is documented here
because the command now warns about it (#3697) — a warning about a rule that
cannot be looked up is not actionable.

**The canonical form is a comma-separated list of REQ-IDs.** Square brackets are
optional; a REQ-ID is `PREFIX-N`, where the prefix is a letter followed by
letters or digits. Two tolerances are worth knowing because the warnings below
do **not** fire on them: the line is split on commas *and whitespace*, so
`REQ-01 REQ-02` selects both; and the ID shape is matched case-insensitively,
so `req-01` is selected and marked. Write the comma list anyway — it is what
every template and every example uses — but neither spelling is an error:

```
**Requirements**: REQ-01, REQ-02, REQ-03
**Requirements**: [REQ-01, REQ-02, REQ-03]
```

**Ranges are not expanded** — `REQ-01 … REQ-05` selects the two endpoints and
nothing between them, and `REQ-01..REQ-05` selects nothing at all, because the
whole token fails the ID shape. This is a deliberate non-feature, not an
oversight: the line is a traceability record, and silently inventing IDs that
appear nowhere in `REQUIREMENTS.md` is worse than declining to.

**A deliberately empty line is written `TBD` or `None`.** Those two words are
the placeholder vocabulary, and they are matched as the line's leading token, so
`None (per ADR-7)` and `**None**` are declared-empty too. **Any other wording
that selects no REQ-IDs warns** — `Deferred`, `N/A`, `Pending`, `TBA`, a bare
`-`, or free prose — because from the command's side an unrecognised word is
indistinguishable from a line that was meant to cite requirements and failed
to. A line whose only content is an HTML comment is not "other wording" and
stays silent, so the shipped template's own `<!-- ... -->` does not warn.

**Write each requirement as a bare ID, separated by a comma.** The line is
split on commas and whitespace only, and nothing else is stripped, so anything
attached to an ID takes the ID with it. `REQ-01; REQ-02` marks **only**
`REQ-02`; so do `REQ-01 ;REQ-02`, `**REQ-01;** REQ-02` and an ID carrying a
stray invisible character. Those are the cases the warning names — it reports
the dropped ID, because this is the quietest way to lose a requirement here
(the command reports `requirements_updated: true` either way).

**What the warning does NOT reach.** Stated so its silence is not read as a
clean bill, and enumerated rather than summarised, because each of these is a
requirement that goes missing without a word. The check fires only when the
thing touching the ID is a `;`, a `:`, or an invisible character:

- **Markdown styling on its own is silent.** `**REQ-01**, REQ-02` drops
  `REQ-01` and says nothing at all. Styling is not evidence that a separator
  was meant. `**REQ-01**; REQ-02` is silent for the same reason — the `**`
  sits between the ID and the `;`, so nothing is touching the ID.
- **Any other attached punctuation is silent.** `REQ-01/ REQ-02`,
  `REQ-01| REQ-02`, `REQ-01. REQ-02`, `REQ-01+ REQ-02`, `REQ-01> REQ-02` and
  their full-width and non-ASCII equivalents (`；`, `，`, `؛`) each mark only
  `REQ-02`. A fully crossed sweep — 21 separators against bare, leading-space,
  trailing-space and both-spaces spellings, 84 combinations — found **34**
  silent under-selections, every one of them a separator glued to exactly one
  of the two IDs. Only `;` and `:` are in the set. Widening it is a live
  option — say the word — but each past widening of this check first fired on
  a citation, so it is not done blind.
- **A dropped ID whose prefix matches nothing selected is silent.**
  `REQ-01, REQ-02: login` is reported; `REQ-01, FOO-02: x` is not. A citation
  is textually identical to a dropped requirement — `REQ-01, see ADR-7:
  section 3` carries `ADR-7:` in exactly the shape `REQ-01;` has — and prefix
  agreement is the only thing that separates them without guessing at prose.
  Anything inside matched parentheses is left alone for the same reason:
  `(see ADR-7: section 3)` is a citation.

The prefix gate is not complete in the other direction either: a citation that
*shares* a selected prefix — `REQ-01, see REQ-7: sec 3` — does warn, naming
`REQ-7` as dropped. Nothing at the token level separates that from a real
drop.

**Dash spellings need a full ID on both sides.** `REQ-01-REQ-05` reads as a
range; `REQ-01-05` does not, and neither does any of its typographic variants
(en dash, em dash, minus sign, and the rest). The reason is that
`PREFIX-<digits><dash><digits>` is also a date (`FY-2026-08`) and a sub-numbered
ID (`API-2-01`), so warning on it would be noise on lines that are perfectly
correct. `..`, `…`, `to`, `thru` and `through` have no such reading and do
accept a bare numeric endpoint (`REQ-01..05`). The cost is that
`REQ-01, REQ-02-05` is not reported; a bare `REQ-02-05` still is, because it
selects nothing.

**What warns, and in which of the three voices.** All go to `warnings[]` and
none blocks completion:

- *"could not be parsed as a comma-separated REQ-ID list"* — the line did not
  yield the requirements it appears to name. That covers two cases, and the
  message says which one it is: ID-shaped text on the line was **not**
  selected, so something was demonstrably dropped; **or** the line selected
  nothing at all while not being a `TBD`/`None` placeholder, in which case
  there may be no ID-shaped text on it whatsoever (`Deferred` takes this
  voice). Either way nothing was marked and the line needs fixing.
- *"contains what reads as a range between two cited REQ-IDs"* — the separator
  is the only thing in question: a separator between two cited IDs could equally
  be a range or an annotation, and the command cannot tell them apart, so it
  states both readings rather than asserting a failure that may not have
  happened. It speaks about the **separator**, not about the whole line. It is
  also the *weakest* of the three claims, so it yields to the other two: a
  demonstrated drop elsewhere on the line makes it a misparse, and an
  unexamined over-cap token makes the line unverified — a voice whose claim is
  that nothing was dropped cannot speak over a token no rule read.

**Each warning carries a machine-readable kind.** The prose goes to
`warnings[]` as before — that field is unchanged and is still an array of
strings — and the kind is emitted beside it as `requirements_line_warning`,
one of `req-line-misparse`, `req-line-range-reading` or `req-line-unverified`.
The field is absent entirely when the line is clean. Key on the kind rather
than on the wording; the wording is free to improve.

Either of those two voices may add a factual note naming **ID-shaped text on the
line that was not selected**. Square brackets *are* stripped — `[REQ-01, REQ-02]`
is the documented form — but parentheses are not, so `(REQ-02)` is not marked.
The command cannot tell that from `(ADR-7)`, which is a citation and correctly
ignored, so it names what it skipped and leaves the judgement to you. Where the
skipped text is `PREFIX-<digits>-<digits>` — the shape the dash rule above
declines to adjudicate, because `FY-2026-08` is a date and `API-2-01` is a
legal requirement id and no rule separates them — it is still named, with that
ambiguity stated alongside it. Naming it and saying why it is ambiguous beats
both alternatives: filtering it hides a real dropped requirement, and reporting
it bare asks you to check whether a date is a requirement.
The third voice is for input the command could not examine: *"could not be
checked ... the REQ-ID selection on this line is unverified"*. Range detection
is bounded at 2,048 characters per token, so a longer token is not classified —
and unclassified is reported, never treated as clean. Selection itself is *not*
bounded, so a valid REQ-ID longer than that is still selected and marked
normally; it only triggers this voice if something beside it could have formed a
range with it, which is the case where the bound actually suppressed a check.

---

## Roadmap Commands

Parse and update `ROADMAP.md`.

```bash
# Extract phase section from ROADMAP.md
node gsd-tools.cjs roadmap get-phase <phase>

# Full roadmap parse with disk status
node gsd-tools.cjs roadmap analyze

# Update progress table row from disk
node gsd-tools.cjs roadmap update-plan-progress <N>
```

When the phase has no writable ROADMAP entry — no matching Progress-table row,
no `### Phase N` detail section, and no checklist bullet this command can update
(the checklist-only form) — the command declines with `updated: false` and a
`missing_phase_details` reason instead of claiming success, and leaves
`ROADMAP.md` byte-identical.

### Checkbox conflicts (`roadmap analyze`)

`roadmap analyze` derives `current_phase`, `next_phase`, and `completed_phases`
from each phase's on-disk status (`disk_status`), not from the ROADMAP
checkbox: a ticked `[x]` is a human annotation with no machine authority
(ADR-3180 §7.4, [#2957](https://github.com/open-gsd/gsd-core/issues/2957)).
The two signals can legitimately disagree, for example a backfilled phase that
has a `SUMMARY.md` and no `PLAN.md` (`disk_status: empty`) or a phase whose
plans are all summarized but which has no passing `*-VERIFICATION.md`
(`disk_status: executed`), both ticked `[x]`.

`checkbox_conflict` lists every such phase so a caller is never handed a
ticked phase, or withheld an unticked-but-verified one, with no signal. It is
always an array when `ROADMAP.md` exists (empty when every phase agrees). A
phase is listed when its `roadmap_complete` differs from
`disk_status === "complete"`. Only phases that have a ROADMAP checkbox are
compared: a phase declared only by a progress-table row, or by a heading with
no checklist entry, has no checkbox to disagree with and is never listed
(its `roadmap_complete` is `false` because there is nothing to read).

| Field | Type | Meaning |
|-------|------|---------|
| `number` | string | Phase number, as in `phases[].number` |
| `roadmap_complete` | boolean | The ROADMAP checkbox state (`true` for `[x]`) |
| `disk_status` | string | The disk-derived status the selectors use |
| `plan_count` | number | Plans found for the phase |
| `summary_count` | number | Summaries paired with a plan |

`roadmap_record` (#5221) maps each phase number (leading zeros stripped per segment; under `phase_naming: custom`, also each custom id such as `AUTH`) to `true` when every recognised ROADMAP record of it — each checklist entry, under any bracket, and its progress-table Status cell — reads complete, else `false`; a phase with no checklist entry or table row is absent, and the whole field is `null` when the phase table does not parse or its `Phase`/`Status` headers are not recognised (a `Plans Complete` table headed in another case or wording). It reads the record only (whatever the disk says); `/gsd-ship` ships only a `true` phase.

The selectors are unchanged: `checkbox_conflict` only reports the
disagreement. To treat a phase as done despite its disk status, verify it
(`verify-phase`) so a passing `*-VERIFICATION.md` exists.
([#4757](https://github.com/open-gsd/gsd-core/issues/4757))

### Milestone window scope (`roadmap analyze`)

`roadmap analyze` scopes its phase list to the current milestone's section of
`ROADMAP.md`. Its JSON output carries a `scope` field describing how much of the
intended input that scoping actually saw:

| `scope` | Meaning |
|---|---|
| `complete` | The window was computed over the whole intended input. `phase_count: 0` here is a **real** answer — a freshly-declared milestone genuinely has no phases yet. |
| `truncated` | The milestone's heading was found, but its window closed before reaching the document's phase region — typically because a closed-milestone heading sits between the active milestone and its `### Phase N:` sections. `phase_count: 0` here is a **non**-answer. |
| `unscoped` | No milestone version could be resolved (or its section is absent) on a ROADMAP that does use versioned milestones, so the result is not milestone-scoped. |
| `unreadable` | `ROADMAP.md` could not be read. |

Before this field existed, all four cases produced the same well-formed
`phase_count: 0` with no error, so a consumer could not tell a genuinely empty
milestone from a scoping failure. Branch on `scope`, not on `phase_count` alone.

A ROADMAP with no versioned milestone headings at all (the free-form legacy
shape) reports `complete`: the whole document *is* the milestone there. Note
this answer is specific to *windowing* — see the next section for why milestone
*identity* answers the same document differently.

### A non-`COMPLETE` scope withholds the percentage entirely (#3217)

`roadmap analyze --json`'s `progress_percent`, `stats --raw`'s `percent` /
`plan_percent`, `query progress --raw`'s `percent`, and `state json --raw`'s
`progress.percent` are now **nullable** — a Tier-2 contract change. When the
phase set a percentage would be computed from is not fully trustworthy (any
scope other than `complete`), these surfaces render **no percentage at all**
rather than a number computed from a truncated, unscoped, or unreadable set:

| Surface | Non-`complete` behavior |
|---|---|
| `roadmap analyze --json` | `progress_percent: null` |
| `stats --raw` | `percent: null`, `plan_percent: null` |
| `query progress --raw` | `percent: null` |
| `state json --raw` | `progress.percent` is **omitted** from the `progress` object (not `0`, not present as `null`) |
| `state update-progress --raw` | `false` — no write; `STATE.md`'s Progress field is left untouched, and a `[gsd-tools] WARNING:` line is written to stderr naming the scope; for an `unscoped` scope the line (and, without `--raw`, a `hint` field) also names the cause (STATE.md's milestone has no matching ROADMAP.md heading, STATE.md names none beside milestone headings, or a Phase title reads as a milestone heading) and its fix; `state sync` names the same cause where it skips Progress |

`0` is a legitimate, real answer under a `complete` scope (e.g. a
freshly-declared milestone with zero phases, or a phase with zero plan files)
and is never withheld — only a non-`complete` scope withholds.

`roadmap analyze --json` gates `total_plans` / `total_summaries` / `phases` /
`completed_phases` on the top-level `scope` field described above (heading
windowing identity), but `progress_percent` is governed by a **separate**
`progress_scope` field — the scope of the phase-directory set the percentage
was actually computed from. The two can legitimately disagree (e.g.
`scope: "complete"` — the ROADMAP heading resolves fine — alongside
`progress_scope: "unreadable"` when `.planning/phases` itself cannot be read),
so a consumer must branch on `progress_scope`, not `scope`, to know why
`progress_percent` is `null`.

### Milestone identity (which milestone, and what it is called)

Milestone identity — the version and name behind `STATE.md`'s `milestone:`
field, `roadmap analyze`'s `milestones[]` array, and the milestone shown by
`query progress`, `stats`, `init manager`, `validate health` and
`workstream create` — is resolved by one implementation:

- `STATE.md`'s `milestone:` field selects the version when present. The ROADMAP
  heuristics are the fallback, not the primary.
- The heading is located by the same canonical locator that computes the
  milestone window, so a `### Phase N: …` heading is **never** read as the
  milestone heading — even when it mentions a version. Previously a ROADMAP
  whose phase heading preceded its milestone heading could write a wrong
  `milestone:` to disk.
- The **name** is the heading text after that heading's own version token, with
  one leading delimiter (`—`, `–`, `:`, `-`) and any trailing `✅`/`📋`/`🚧`
  marker removed. Parentheses are ordinary characters: a milestone named
  `v3.3 — Portability (Windows)` keeps its full name rather than being cut at
  the `(`.
- When identity **cannot** be determined it is reported as absent rather than
  defaulted. A free-form legacy ROADMAP with no version anywhere is `unscoped`
  with no identity — unlike windowing above, there is no version token to
  report, and inventing one would be indistinguishable from a real answer.

Two consumers act on that distinction rather than just displaying it:
`state sync` / `state record-session` write `null` instead of a fabricated
`milestone:`/name, and `phases clear` falls back to its dated archive label
(`archived-<YYYYMMDD>`) instead of filing phase history under a fabricated
`milestones/<version>-phases/` directory.

### `milestone complete` refuses an untrustworthy window

`milestone complete` archives `ROADMAP.md`/`REQUIREMENTS.md` and **moves phase
directories** — a one-way door. When the milestone window's `scope` is
`truncated` — the milestone heading was found but its section closes before
reaching any phase entries, even though the ROADMAP has phase entries
elsewhere — phase scoping cannot be trusted, and the command now refuses
rather than falling back to an over-inclusive filter that would archive every
phase directory in the project. `unreadable` (no ROADMAP.md at all) and
`unscoped` (no section for this version) are pre-existing, legitimately
handled states and are not refused here. Pass `--force --confirm` to override, the same
affordance the unstarted-phase guard uses (`--confirm` is required for any mutating run —
#3726; `--force` alone does not imply it).

---

## Config Commands

Read and write `.planning/config.json`.

```bash
# Initialize config.json with defaults
node gsd-tools.cjs config-ensure-section

# Set a config value (dot notation)
node gsd-tools.cjs config-set <key> <value> [--dry-run]

# Get a config value
node gsd-tools.cjs config-get <key> [--default <value>] [--raw]

# Set model profile
node gsd-tools.cjs config-set-model-profile <profile>

# Migrate legacy config keys to their canonical names
node gsd-tools.cjs migrate-config

# Create config.json for a new project from the chosen settings
node gsd-tools.cjs config-new-project '<choices-json>' [--dry-run]
```

`config-set --dry-run` validates the key and value and prints what would change (`dry_run: true`, the key, its new value and its previous value, masked for secrets) without writing `config.json`.

`config-get` prints the key's value as JSON. A key absent from the config falls back to the
project root config (when a workstream is active), then to `--default`, then to the key's
schema default; with none of those it fails with `CONFIG_KEY_NOT_FOUND` (`CONFIG_NO_FILE` when
there is no `config.json`). `--default` is parsed
exactly as `config-set` parses its value: `true`, `false` and `null` become those JSON values, a
decimal number (`5`, `-1`, `.5`, `5.0`, `1e3`, with no surrounding spaces and no `0x` prefix)
becomes a number, text starting with `[` or `{` is parsed as JSON (and stays a string if it is
not valid JSON), and anything else is a string, including ` 5`, `0x10` and a number too large to
represent (`1e400`). So `--default '[]'` prints `[]`,
the same as a key set to an empty array.

`--raw` prints the value as plain text for shell use. It is a display format, not JSON: an array
prints its items joined by commas and an object prints `[object Object]`, so read structured
values without `--raw`. Under `--raw`, a `--default` value prints exactly as typed (`007` stays
`007`). Secret keys (`brave_search`, `firecrawl`, `exa_search`) print masked in both modes, and an
unset one prints `(unset)`.

New projects default to bracket IDs and generated naming, deriving a project code
from the scoped PROJECT.md title or directory basename. Explicit valid codes win;
explicit convention `sequential` opts out (null does not). See
[identity defaults](CONFIGURATION.md#new-project-identity-defaults) for derivation
and alias semantics. `--dry-run` previews without writing; config repair and
existing projects retain legacy convention behavior.

`config-new-project` takes the chosen settings as one JSON object, nested by section
(`'{"mode":"yolo","workflow":{"research":false}}'`), and layers them over the built-in and
user defaults. It checks each choice with the same key and value rules as `config-set` and
creates nothing if any choice is refused: an unknown key, a value the key does not accept,
or a dotted key (`"workflow.research"`) in place of a nested one. A `null` choice is treated
as not chosen: its key is still checked, and it takes the value it would have had without the
choice (the built-in or user default). That is the creation-time counterpart of `config-set
<key> null`, which removes the key from an existing config.

An object is read as a section whenever settings live under its key, and its entries are
checked one by one. An empty section sets nothing (`"workflow":{}`, `"agent_skills":{}`), with
one exception: below the first level of a dynamic key family
(`"model_profile_overrides":{"claude":{}}`) an empty object is refused as an unknown key, as
`config-set` refuses it. Under a key with no settings below it, an object is a value, held to
that key's rule as `config-set` holds it (`"model_overrides":{"gsd-executor":{}}` is written,
`"mode":{}` is refused). Under a name that is neither, it is refused as an unknown key. A
section given anything but an object is refused, unless its key is itself a setting
(`agent_tools`), where the value is held to that setting's rule as `config-set` holds it. An
empty or blank choices argument is the same as none.

Two differences from `config-set` follow from the input being JSON rather than typed text:

- Values are JSON-typed and never coerced. `config-set workflow.research true` parses the
  text `true` to a boolean; the choice `"research":"true"` is a string and is refused.
- A setting that also has per-entry settings under it (`review.max_prompt_tokens_per_reviewer`,
  `agent_tools`) takes an object of those entries, each checked as `config-set` checks that
  entry's own key: for the reviewer budget `{"codex":5000}` is accepted and `{"a":1}` is
  refused, where `config-set` stores any object given to the setting whole.
  `review.max_prompt_tokens_per_reviewer` also takes a number for itself.

One difference does not: a `null` choice under `__proto__`, `prototype` or `constructor`, for a
key that is otherwise known (`{"model_overrides":{"constructor":null}}`), is refused by the
prototype-pollution guard.
`config-set model_overrides.constructor null` reaches that guard only when the config has a
`model_overrides` section; without one it finds nothing to remove and exits 0, having checked
that the key is known but not that guard. The default config (`config-new-project '{}'`) has
some of these sections (`agent_skills`) and not others (`model_overrides`, `agent_tools`,
`features`), so the difference can hold after creation too.

`--dry-run` prints the config that would be created and writes nothing, with secret keys
masked as `config-set` masks them; any other flag is refused. The choices are checked first,
so a refused choice, malformed JSON included, fails even when `config.json` already exists;
with valid choices and an existing `config.json`, the command reports `already_exists` and
leaves it untouched. The user defaults file is read only to build a new config, so a problem in
it is not reported when the config already exists.

`config-ensure-section`, `config-set-model-profile`, and `migrate-config` accept
`--raw` but do not support `--dry-run`, `--pick`, or `--default`. They reject unsupported flags with a
usage error before writing, including `--json`, `--force`, `--workstream` (`--ws` remains supported), and
repeated global `--cwd` / `--project-dir` flags, including flags before the
profile argument. Extra positional arguments are refused too. The same contract
applies with the `query` prefix. `config-set --dry-run` supports previewing an
individual value change without writing.

---

## Capability Commands

The capability command family resolves and mutates capability state (ADR-857). One resolved state composes three substrates: the install profile (`.gsd-profile`), the runtime surface (`.gsd-surface.json`), and config gates (`.planning/config.json` `workflow.*`). `enabled = installed && surfaced`; a hook is `active` only when its capability is enabled and its config gate is on.

### `capability state`

```bash
node gsd-tools.cjs capability state [--config-dir <path>] [--raw]
```

Resolves and prints every capability's `installed`, `surfaced`, `enabled`, and per-hook `active` state. Read-only. `--config-dir` selects the runtime config directory (defaults to the resolved Claude home). `--raw` emits JSON.

### `capability set`

```bash
node gsd-tools.cjs capability set <id> [--on | --off] [--gate <key>=<true|false>]... [--config-dir <path>] [--runtime <name>] [--scope <global|project>] [--raw]
```

Mutates one capability, re-resolves, and reports the result. Two axes:

- `--on` / `--off` (aliases `--enable` / `--disable`): the capability on/off switch, applied through the runtime surface. `--off` unsurfaces the capability; the change is reversible and reclaims the surface budget. A capability that owns no skills has no surface footprint — use `--gate` for those.
- `--gate <key>=<true|false>` (repeatable): toggles one of the capability's own config keys (a hook gate) within an enabled capability.
- `--runtime` / `--scope`: materialise the surface change for that runtime's artifact layout.

After writing, the command re-resolves and prints two message classes to stderr: errors (non-zero exit) — unknown capability id, a `--gate` key the capability does not own, a non-boolean gate value, or `--on` for a capability whose skills are not in the install profile; warnings (exit 0) — `--on`/`--off` on a skill-less capability, or a capability left surfaced while every hook is gated off ("present but dead"). Exit status is non-zero only when a requested change could not be applied.

**Examples:**

```bash
# Turn the UI capability off
node gsd-tools.cjs capability set ui --off --config-dir ~/.claude

# Keep the capability on, gate one hook off
node gsd-tools.cjs capability set code-review --gate workflow.code_review=false
```

---

## Teams Status

### `query teams-status`

```bash
node gsd-tools.cjs query teams-status [--active]
```

Read-only detector for claude-code's experimental agent-teams feature (issue #1355). Resolves the runtime via the canonical `GSD_RUNTIME` → `config.runtime` → per-install runtime marker → `'claude'` precedence (#3897), then checks `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`.

**Default (no flags):** prints a JSON object and exits 0:

```json
{
  "active": false,
  "runtime": "claude",
  "env_present": false,
  "source": "off: flag absent"
}
```

Fields:

| Field | Type | Description |
|---|---|---|
| `active` | boolean | `true` only when `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is strictly truthy (`"1"` or `"true"`, case-insensitive) **and** the resolved runtime is `"claude"` |
| `runtime` | string | The resolved runtime name (e.g. `"claude"`, `"codex"`) |
| `env_present` | boolean | `true` when the env flag is set to a strictly-truthy value |
| `source` | string | One of: `"on: env"`, `"off: flag absent"`, `"off: non-claude"` |

**`--active` flag:** exits 0 if `active` is true, exits 1 otherwise. Prints nothing. Useful in bash conditionals:

```bash
if gsd_run query teams-status --active >/dev/null 2>&1; then
  echo "agent-teams is on"
fi
```

This command is strictly read-only — no config writes, no disk mutation.

---

### `query eval.score`

```bash
node gsd-tools.cjs query eval.score --covered <N> --total <N> --infra <tooling>,<dataset>,<cicd>,<guardrails>,<tracing>
```

Deterministic scorer for eval-auditor results. Computes coverage, infrastructure, and overall scores from audited inputs. Called by `gsd-eval-auditor` in its `calculate_scores` step — agents must not recompute these values by hand.

**Inputs:**

| Flag | Type | Description |
|---|---|---|
| `--covered` | integer | Number of eval dimensions scored COVERED |
| `--total` | integer | Total planned eval dimensions |
| `--infra` | string | Comma-separated list of 5 infra component statuses (order: tooling, dataset, cicd, guardrails, tracing); each value is `ok`, `partial`, or `missing` |

**Output JSON:**

| Field | Type | Description |
|---|---|---|
| `coverage_score` | number | `covered / total × 100` |
| `infra_score` | number | `(sum of component weights) / 5 × 100` (`ok`=1, `partial`=0.5, `missing`=0) |
| `overall_score` | number | `(coverage_score × 0.6) + (infra_score × 0.4)` |
| `verdict` | string | `PRODUCTION READY` (80–100) / `NEEDS WORK` (60–<80) / `SIGNIFICANT GAPS` (40–<60) / `NOT IMPLEMENTED` (0–<40) |

**Example:**

```bash
node gsd-tools.cjs query eval.score --covered 3 --total 5 --infra ok,partial,missing,ok,ok
# → {"coverage_score":60,"infra_score":70,"overall_score":64,"verdict":"NEEDS WORK"}
```

This command is strictly read-only — no config writes, no disk mutation.

---

### `query context-predicates`

```bash
node gsd-tools.cjs query context-predicates --class <CLASS> | --prefix <dotted.prefix> | --contains <text>
```

Selector surface for the `CONTEXT.md` predicate fact-store (ADR-1671, #2928). Parses the repo-root `CONTEXT.md` **live** on every call via the compiled `context-predicates.cjs` — it never reads the committed `docs/CONTEXT-INDEX.json` (that artifact is a CI drift-guard byproduct, not a query source, so it can never go stale relative to the live predicates it answers about).

**Selectors** (at least one required; when more than one is given they are ANDed together):

| Flag | Type | Description |
|---|---|---|
| `--class <CLASS>` | string | Exact match on the predicate's class (the segment before the first `.`) |
| `--prefix <dotted.prefix>` | string | Match predicate ids starting with this dotted prefix |
| `--contains <text>` | string | Case-insensitive substring match against `id + ' ' + value` |

Each flag also accepts the inline-assignment form (`--contains=<text>`), which is the escape
hatch for a flag-shaped value the space-separated form cannot express — e.g.
`--contains=--dry-run` to search for the literal substring `--dry-run`. The space-separated form
(`--contains --dry-run`) always reads a following `--...` token as a missing value, by design.

**Output JSON:**

```json
{
  "matched": 2,
  "predicates": [
    { "id": "RULESET.EXAMPLE", "klass": "RULESET", "value": "…", "line": 42, "section": "Glossary" }
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `matched` | number | Count of predicates satisfying all given selectors |
| `predicates` | array | Each entry is a live `Predicate` — `id`, `klass`, `value`, `line` (1-based source line), `section` (nearest enclosing heading) |

This command is strictly read-only — no config writes, no disk mutation. See [ADR-1671](adr/1671-dynamic-context-management-platform.md) and [Architecture — CLI Tools](ARCHITECTURE.md#cli-tools-gsd-corebin).

---

## Intel Commands

```bash
node gsd-tools.cjs intel query <term>
```

Searches every JSON intel file under `.planning/intel/` (keys and values, including
`arch-decisions.json`) for `<term>`. No-ops with `{ enabled: false }` when the `intel`
capability is not active (`intel.enabled` in config).

**Output JSON:**

```json
{ "matches": [{ "source": "file-roles.json", "entries": [...] }], "term": "…", "total": 3, "truncated": false }
```

| Field | Type | Description |
|---|---|---|
| `total` | number | Count of matched entries across every intel file |
| `truncated` | boolean | `true` when the recursive walk of at least one intel file hit the 48-level depth ceiling before finishing — see below |

### The 48-level recursion ceiling and `truncated` (ADR-3473 §8.5, #3885)

The search recurses into nested objects/arrays up to **48 levels deep** (the bound is on
depth, not breadth or total node count — a wide-but-shallow structure is unaffected). A
match at or above the ceiling is not returned, and `truncated` is set to `true` on the
result so a caller can tell "I stopped looking" apart from "there is no match here."

`truncated: false` means the walk reached the bottom of every branch it visited — it does
**not** by itself mean anything was found; check `total` for that. Before this fix, a
search past the ceiling threw an uncaught `RangeError: Maximum call stack size exceeded`
instead of returning a diagnosable result; a shallower search (depth ≤ 48) is unaffected
and its result is unchanged.

---

## Model Resolution

```bash
# Get model for agent based on current profile
node gsd-tools.cjs resolve-model <agent-name>
# Raw output returns the selected model ID/tier.
# JSON output also includes profile and, when the active runtime supports it,
# reasoning_effort.
```

Agent names: `gsd-planner`, `gsd-executor`, `gsd-phase-researcher`, `gsd-project-researcher`, `gsd-research-synthesizer`, `gsd-verifier`, `gsd-plan-checker`, `gsd-integration-checker`, `gsd-roadmapper`, `gsd-debugger`, `gsd-codebase-mapper`, `gsd-nyquist-auditor`

```bash
# Resolve a specialist executor's model, falling back to another agent's resolution
node gsd-tools.cjs query resolve-model <agent-name> --fallback-agent gsd-executor
```

| Flag | Effect |
|---|---|
| `--fallback-agent <name>` | When `<agent-name>` has no usable `model_overrides` entry and no catalog tier, `model` and `tier` resolve as `<name>` instead of the generic profile default. `effort` stays resolved by `<agent-name>`. A missing value (the flag as the last token, followed by another flag, or an empty value) is a usage error (`Missing value for --fallback-agent`, exit code 1), as for the other value flags. `<name>` must be a GSD agent; a value that is not one is ignored. JSON output adds `fallback_agent: "<name>"` when the fallback applied. Without the flag, output is unchanged. |

---

## Executor Routing and Dispatch Identity

Used by `execute-phase` for per-plan executor routing (`agent_hint:`, see [PLAN.md](reference/plan-md.md#per-plan-executor-routing)).

```bash
# Resolve a plan's agent_hint to the subagent_type to dispatch
node gsd-tools.cjs query resolve-agent --name <hint> [--json]
# ...or read the hint from the plan on disk (honours workflow.agent_hint_routing)
node gsd-tools.cjs query resolve-agent --plan <id> [--phase <n>] [--json]

# Resolve and record the dispatch isolation decision for one plan
node gsd-tools.cjs query dispatch-isolation --phase <n> --plan <id> [--force-isolation <mode>] [--json]

# Record a dispatch isolation decision directly
node gsd-tools.cjs query record-dispatch-isolation --isolation <harness-worktree|orchestrator-worktree|none> \
  [--harness-flag <flag>] [--phase <n>] [--plan <id>] [--executor-type <agent>]
```

| Verb | Executor behavior |
|---|---|
| `resolve-agent` | With `--name`: prints the hint when an agent file for it exists on the active runtime, else `gsd-executor`. With `--plan` (and optional `--phase`): reads that plan's `agent_hint:` and resolves it the same way (`--json` carries `requested`, the hint or `null`, and `fallback`, true when the hint was not found or not used, as with `--name`); `workflow.agent_hint_routing: false`, an unknown plan, or a plan id found in more than one phase prints `gsd-executor`. A hint naming a GSD role other than `gsd-executor` (compared trimmed and case-insensitively) is refused: prints `gsd-executor`, writes a warning to stderr, and `--json` adds `refused: "non-executor-role"`. |
| `dispatch-isolation` | Records the executor with the decision, derived from the plan files with the same rules as `resolve-agent --plan`. With `--plan`: `executor_type` is that plan's routed executor (the phase is looked up when `--phase` is empty). With `--phase` only: `executor_types` lists the routed executors of every plan in the phase other than `gsd-executor` (at most 64; names beyond the cap, or that do not fit the record, are reported on stderr: "capped at 64 names or did not fit the record"). With neither `--phase` nor `--plan`: `executor_types` lists the routed executors of every milestone phase. |
| `record-dispatch-isolation` | `--executor-type` records that agent as the executor. A value that is not a bare agent name (letters, digits, `.`, `_`, `-`; no `..`; at most 128 characters) is recorded as `null`. An `--executor-type` naming a GSD non-executor role (for example `gsd-verifier`) is refused with a stderr warning (`warning: --executor-type "<name>" names a GSD non-executor role; recording no executor (#6213)`) and records no executor. |
| `inspect-dispatch-isolation` | Records nothing; recording-only flags are rejected. |

The isolation guards treat a dispatch as an executor when (a) it is `gsd-executor`; (b) any well-formed dispatch record in the project (keyed records under `.gsd/dispatch-isolation/` and the legacy slot), at most 24 hours old by `written_at`, names its type in `executor_type` or `executor_types`, whatever its phase or plan; or (c) its prompt carries the `[gsd:dispatch …]` marker and its type is not a GSD role (a GSD role is never an executor dispatch, and both hooks return before the record scan). Classification fails closed, treating a valid agent name that is not a GSD role as an executor, when the record scan hits its bound (more than 1024 entries in `.gsd/dispatch-isolation`), when `.gsd` or `.gsd/dispatch-isolation` exists but is a link, not a directory or unreadable, when a recent `.json` record file (the suffix is matched case-insensitively, so `.JSON` counts too) or the legacy slot is refused or malformed, when a recent record's `written_at` is more than 5 seconds in the future, or when any recent record has `executor_types_truncated: true`. While any of these holds, every valid non-GSD-role agent, host built-ins such as `Explore` included, is held to the worktree rule exactly as `gsd-executor` is; recover by case: (i) A legacy slot `.gsd/dispatch-isolation-sentinel.json` that is refused or malformed: remove it (or rewrite it as valid JSON). (ii) `.gsd` or `.gsd/dispatch-isolation` that is a link or any other non-directory: replace it with a real directory. (iii) A truncated record (more than 64 hinted executors in a phase or milestone, or names over the record's byte budget): shorten or reduce the `agent_hint` names; every phase- or milestone-level write rewrites the record, and the case clears 24 hours after the last write. (iv) A recent record whose `written_at` is in the future (beyond the clock-skew allowance), or a future-dated legacy slot: the legacy slot (`.gsd/dispatch-isolation-sentinel.json`) clears on the next dispatch-isolation write; a keyed file clears 24 hours after its mtime (the writer prunes it and the reader stops counting it) or when removed by hand. (v) A scan overflow (more than 1024 entries in `.gsd/dispatch-isolation`): remove stale entries from `.gsd/dispatch-isolation/` until 1024 or fewer remain, or remove the directory (it is recreated on the next write). (vi) An unreadable `.gsd` or `.gsd/dispatch-isolation` directory: restore read and execute permission on it. (vii) A recent keyed record file in `.gsd/dispatch-isolation/` that the reader refuses or rejects (malformed, wrong key, hard link, link, FIFO, device, unreadable (mode 000), no phase, oversize): remove it. Records are otherwise pruned after 24 hours. `--json` on `dispatch-isolation` adds `executor_types_truncated: true` when the phase-level list did not fit the record. A plain query that holds a recorded `none` writes no decision; it writes the executor identity it derives for its own scope to `.gsd/dispatch-isolation-identity/` (one file per scope), which the guards read beside the records above, with the same bounds and fail-closed cases; a query that cannot write that file still holds and records no decision, and any write that records a decision for a scope removes that scope's file. While a fresh caller `none` inside its ten-minute hold window is among the records read (of any scope), classification also fails closed in the states that stop that write: the held record's phase or plan is not a bare name, a directory sits at an identity file name (`all.json`, `phase+…`, `plan+…`), `.gsd/dispatch-isolation-identity` (or, with none, `.gsd`) cannot be written and searched, or `.gsd/.gitignore` is a link. Recovery is the same, reading `.gsd/dispatch-isolation-identity` wherever (ii), (v), (vi) and (vii) name `.gsd/dispatch-isolation`; (viii) for those states, remove the directory at the file name, restore read, write and execute permission, replace the linked `.gitignore` with a regular file, or record the decision again for a bare phase and plan; each also clears once no such caller `none` remains, at the latest ten minutes after the latest one's decision, except that an identity directory that cannot be listed is also a scan overflow (vi); a truncated identity file clears when a decision is recorded for its scope, when the next held query rewrites it, or 24 hours after it was written, or remove it. Background: [About executor identity](explanation/executor-identity.md).

---

## Verification Commands

Validate plans, phases, references, and commits.

```bash
# Verify SUMMARY.md file
node gsd-tools.cjs verify-summary <path> [--check-count N]

# Check PLAN.md structure + tasks
node gsd-tools.cjs verify plan-structure <file>

# Check all plans have summaries
node gsd-tools.cjs verify phase-completeness <phase>

# Check @-refs + paths resolve
node gsd-tools.cjs verify references <file>

# Batch verify commit hashes
node gsd-tools.cjs verify commits <hash1> [hash2] ...

# Check must_haves.artifacts
node gsd-tools.cjs verify artifacts <plan-file>

# Check must_haves.key_links
node gsd-tools.cjs verify key-links <plan-file>
```

**Exit status (#5170).** These verbs are verdict-driven: the JSON on stdout is the verdict and is unchanged, and the exit status follows it, so a caller can branch on `$?`. `0` = positive verdict (`valid` / `complete` / `all_valid` / `all_passed` / `all_verified` is `true`); `1` = negative verdict (read the JSON for what failed); `66` (`NO_INPUT`) = the plan was read and declares nothing to verify (`verify artifacts` with no `must_haves.artifacts`, `verify key-links` with no `must_haves.key_links`); `69` (`UNAVAILABLE`) = the verb could not look (the plan or document is absent or unreadable, the phase did not resolve, the directory is not a git work tree): never a clean exit. A plan file that exists but is empty was read: for `verify artifacts` and `verify key-links` it is `66`, for `verify plan-structure` a negative verdict (`1`). `verify schema-drift` is the exception: it is also the capability gate dispatched as `check verify-schema-drift`, whose consumer reads `.block` from stdout and routes a non-zero exit by `onError`, so a blocking drift verdict stays exit `0` and only "could not look" exits `69`.

`verify key-links` confines each link's `from:`/`to:` to the project directory (#3493): a path that resolves outside the project (via `../` traversal, an absolute path, or a symlink) is never read. That link's `links[]` entry reports `path_rejected: "from"` or `path_rejected: "to"` (whichever field was rejected) alongside `verified: false`, without echoing the underlying path-confinement error (which would embed an absolute host path). A rejected link fails independently — it does not abort evaluation of the other links in the same plan, and does not set `path_rejected` on links whose paths resolve inside the project.

### Gate verb exit statuses (#5170)

The exit status of a gate verb is a function of its verdict (`gateExitOutcome`, [Gate Exit Module](../CONTEXT.md)); no verb picks a code itself. The stdout JSON is authoritative in every row.

| Exit | Outcome | Meaning |
|---|---|---|
| `0` | `PASS` | Positive verdict; or, in payload mode, any delivered verdict including a blocking one |
| `1` | `FAIL` | Negative verdict (status mode only). Also `error()` (a usage or runtime failure), which prints nothing on stdout |
| `66` | `NO_INPUT` | The evidence was read and the scope it defines is genuinely empty (status mode: `verify artifacts` with no `must_haves.artifacts`, `verify key-links` with no `must_haves.key_links`) |
| `69` | `UNAVAILABLE` | The gate could not look: the evidence is absent where it must exist, unreadable (`EISDIR`, `EACCES`, `EIO`, an encoding failure), the phase did not resolve, or a plan scan did not see every plan. Never `0` |

| Mode | Verbs | Verdict is carried by | Non-zero exit means |
|---|---|---|---|
| Status | `phase uat-passed`, `verify artifacts`, `verify plan-structure`, `verify phase-completeness`, `verify references`, `verify commits`, `verify key-links` | stdout JSON and `$?` (`valid` / `complete` / `all_valid` / `all_passed` / `all_verified` / `passed`) | `1` negative verdict, `66` empty scope, `69` could not look |
| Payload | every `check <verb>`, `verify schema-drift`, `verify codebase-drift`, `verify context-drift`, `check prohibition-enforcement` | stdout JSON, `.block` | only `69` (or an `error()`): the gate dispatch routes a non-zero status by `onError`, so a blocking verdict stays `0` |

`phase uat-passed` exits `0` when `passed` is `true` and `1` when it is `false` with the JSON on stdout; a phase it cannot read is `error()` (exit `1`, stdout empty), so the two are told apart by whether stdout is empty. `verify commits` outside a git work tree answers `{"error":"Not a git repository"}` with `69`. `verify schema-drift` reads `files_modified` through the Frontmatter Module, so a YAML block sequence and CRLF line endings yield their files (#4562). `verify plan-structure` flags a `! grep -q 'LIT' f` negative gate whose literal also appears in the same task `<action>`, as it does for the positive form (#4541). To handle every status from a script see [Handle gate verb exit statuses](how-to/handle-gate-verb-exit-statuses.md).

### `verify codebase-drift` (structural drift of the codebase map, #2003, #5134)

```bash
node gsd-tools.cjs verify codebase-drift
```

Compares the changes since `last_mapped_commit` against the codebase map in `.planning/codebase/` and reports whether the map has drifted past `workflow.drift_threshold`. Warn-only by contract: an internal failure returns a `skipped` payload, never an error. A non-blocking verdict computed from fewer documents than the map has (a map document that could not be read) exits `69` with the payload plus `documents_unreadable`; a blocking verdict stands and exits `0` (payload mode, #5170).

**Territory.** The command reads all seven generated documents (`STACK.md`, `ARCHITECTURE.md`, `STRUCTURE.md`, `CONVENTIONS.md`, `TESTING.md`, `INTEGRATIONS.md`, `CONCERNS.md`). A directory is *mapped* when its path appears, at a path-component boundary, in any of them. `STRUCTURE.md` is still required; the other six are optional, so a partial map works.

**Categories.** Added files are drift outside mapped territory; modified and deleted files are drift inside it (an edit or deletion changes something the map describes).

| Category | Change | Rule |
|---|---|---|
| `new_dir` | added file | its directory is not mapped |
| `barrel` | added file | a barrel export at `(packages\|apps)/*/src/index.*` |
| `migration` | added file | a migration file |
| `route` | added file | a route module under `routes/` or `api/` |
| `modified` | modified file | its directory is mapped |
| `deleted` | deleted file | its directory is mapped |

A rename counts its old path as `deleted` and its new path as an addition; a typechange counts as `modified`. For an added file the specific category (`migration`, then `route`, then `barrel`) wins over `new_dir`. Every element counts toward `workflow.drift_threshold`.

**Skip reasons** (`skipped: true`, with `reason`): `no-structure-md` (no `STRUCTURE.md`), `cannot-read-structure-md` (`STRUCTURE.md` is not a regular file or is larger than 1 MiB), plus the existing git and baseline reasons. Any other document that is not a regular file or is larger than 1 MiB is unreadable: it is left out and listed in `documents_unreadable`.

**Payload fields added by #5134:**

| Field | Meaning |
|---|---|
| `documents_read` | The map documents that were read |
| `documents_unreadable` | Map documents (other than `STRUCTURE.md`) that were skipped as unreadable |
| `withheld_paths` | The first 50 paths withheld from output, display-escaped, each capped at 200 characters |
| `withheld_count` | Total number of withheld paths, before the cap of 50 |

`elements[].path` values are display-escaped: control, bidirectional and zero-width characters are shown as `\uXXXX`.

**Path allowlist.** `affected_paths`, the `--paths` argument and every path listed in `message` pass only through one allowlist: components of ASCII letters, digits, `_`, `.` and `-`, separated by `/`; no `..` component, no lone `.`, not absolute. A path that fails is never printed in `message`; the message instead states `N path(s) withheld: not passed to the mapper or listed (absolute, traversal, whitespace, non-ASCII or shell-metacharacter characters)`. A directory with a non-ASCII or space-containing name is therefore withheld and counted, not silently dropped. `spawn_mapper` is `false` when no safe path remains, so `auto-remap` does not run (an empty `--paths` would remap the whole repository); `action_required` and `directive` are unchanged.

### `verification status` (the verification verdict, #5118)

```bash
node gsd-tools.cjs verification status <phase-dir> [--pick <field>]
```

Reads the phase's `*-VERIFICATION.md` frontmatter and answers with one member of a **closed enum**, projected through **one routing table** (`VERIFICATION_ROUTES` in `src/verification.cts`, ADR-5057 Phase 4). Every workflow that needs the verdict reads this answer; none re-reads the report or branches on a status word of its own.

| `status` | Meaning | `route` (bare command) |
|----------|---------|------------------------|
| `passed` | Report says `passed` and its covered-input fingerprint is current | `""` (continue) |
| `gaps_found` | Report says `gaps_found` | `plan-phase` (`next_command` carries `--gaps`) |
| `human_needed` | Report says `human_needed` | `verify-work` |
| `stale` | Covered source changed after the verifier ran, or (older v1/v2 reports) a current plan/summary was never declared in `covered_files` | `execute-phase` (its shared verification step re-runs the verifier) |
| `missing` | Phase directory exists but holds no report, or the report has no `status` | `execute-phase` (resumes at the verification gates) |
| `unparseable` | The report's frontmatter is not YAML | `""` (fix the report itself) |
| `phase_dir_not_found` | There is no phase directory at that path | `""` (a usage error — see below) |

The JSON result carries `status`, `next_action`, `next_command` (the route projected for the project's runtime, for example `/gsd-execute-phase 3` or `$gsd-execute-phase 3` on Codex), and — additive since #5118 — `route`, the bare command from the same table entry, so the two can never disagree. `message` is present only where a usage error needs one. `uncovered_artifacts` (#4817) is present only on a `stale` result for an older v1/v2 report that never declared some current plan or summary in `covered_files`: it lists those file names, and `next_action` names them and says whether a covered file also changed, so "a covered file changed" and "an artifact was never covered" read differently. The remedy and route are the same. A report written by the current fingerprint verb (v4) cannot reach that state: it covers the phase's own artifacts itself. Newly written v4 fingerprints hash CRLF byte pairs as LF, preserving every other byte (including lone CR and non-UTF-8 input), so a line-ending-only checkout rewrite leaves the report fresh. Stored v1–v3 fingerprints are recomputed with their original raw-byte semantics; upgrading does not re-fingerprint them. `moved_files` (#4857) is present on a `stale` result whose digest moved and names the declared covered files modified after the report was written (by clean commit time, or mtime for an uncommitted edit; report paths and shared planning documents are excluded exactly as the digest excludes them), so an edit to a covered file reads differently from a missing artifact or a self-covering report. It is advisory: the digest alone decides staleness, and a stale report that carries no `moved_files` was not invalidated by an edit to a file it covers. `staleCheckIndeterminate` is unchanged. The `init *` bundles expose the same bare command as `verification_route` beside `verification_next_command`, and each `planning inspect` phase carries `verification.route` beside `verification.status`.

- **`phase_dir_not_found`** is a usage error, not a verification state: nothing was there to look in (a dangling symlink and a path that is a regular file both read this way). It has no next command — re-running `execute-phase` could re-run a phase already archived under `.planning/milestones/`. Resolve the directory with `find-phase`.
- **`unknown` no longer exists.** A `status` outside the set used to route as `unknown` to `execute-phase`; that is now the hard error below, and no command emits `unknown`.
- **A report may carry only `passed`, `gaps_found`, or `human_needed`.** Any other value — `verified`, `Passed`, `stale` (a reader-only member), a number — fails every command that reads the report with `verification_status_invalid`, stdout empty, naming the file, the value (quoted, control characters escaped, truncated at 120 characters) and the accepted values. Recovery: set the report's frontmatter `status:` to one of the accepted values, or delete the report (it then reads `missing` and routes to `execute-phase`, whose verification step regenerates it). `validate health` reports the same file as warning `W030` instead of failing.
- **No write before the error.** A command that writes (`phase complete`, `phase remove`, `state sync`, `milestone complete`, `milestone archive-quick`, `validate health --repair`) validates every report it will read before its first write, so a refused report leaves `STATE.md`, `ROADMAP.md` and the phase directories untouched.
- **Exact match, no folding (behavior change).** The check is an exact string match. Case-folded and legacy statuses — `Passed`, `pending`, `partial` — that `phase complete`'s warning pre-scan and `audit-uat` used to fold into a known status now hard-error like any other out-of-set value, on every command; correct the report's `status:` to an accepted value.
- **`missing` on `verify-work`.** `/gsd-verify-work` runs the regeneration step for a `stale` report, and for a `missing` one only when every plan has a `SUMMARY.md` (the verify step never ran on an executed phase). A `missing` report on a phase that is not fully executed does not dispatch it: the command blocks with `next_command` (`execute-phase`) instead.
- **Containment.** Two checks, both before any read. The phase directory must resolve under its phases root, and the report (and each `*-UAT.md` and `*-HUMAN-UAT.md`) must resolve inside its phase directory. Anything that escapes (a symlink out of the project) is never read and none of its content reaches any output: an escaped report reads `missing` from `verification status`, an escaped UAT file is treated as absent, and an escaped phase directory reads `missing` from `verification status` but `phase_dir_not_found` from `init verify-work`.

### `verification all-summarized` (execute-phase's all-plans-summarized decision, #6096)

```bash
node gsd-tools.cjs verification all-summarized <phase-dir> [--filter-active] [--plan-index <json|@file:path>] [--phase-marked <true|false>] [--pick <field>]
```

When every plan in a phase has a `SUMMARY.md`, `execute-phase` has no plan work left to dispatch. Whether it then exits, presents a route, or resumes at the verification gates is decided here, by code, so a judgment such as "this change is test-only" cannot override the owner's staleness verdict. The result is `{ "decision": <one of the values below> }`, plus the full `verification status` result (`status`, `next_action`, `next_command`, `route`, ...) whenever the decision needed the report, so a caller can `--pick decision` and, for `present-route`, read `next_action` and `next_command` from the same call.

`--filter-active` says a `--gaps-only` or wave filter is set. `--plan-index` is `phase-plan-index`'s own output (inline JSON, or the `@file:` form it prints for a large one); the blocked and not-ready skips are derived from it by the command, never asserted by the caller: an incomplete plan (no `has_summary`) with a non-empty `blocked_by` is a blocked skip, one with `ready: false` is a not-ready skip. It is required unless `--filter-active` already decides. `--phase-marked` is the roadmap checkbox from `roadmap.analyze` (`roadmap_complete`); any value other than `true`, including an empty one, reads as not marked. An unknown option, a missing or unparseable plan index, and a valueless option are errors.

| `decision` | When (first match wins, in this order) |
|------------|-----------------------------------------|
| `exit-filtered` | `--filter-active` |
| `exit-blocked` | the plan index holds a blocked skip |
| `exit-not-ready` | the plan index holds a not-ready skip |
| `resume-at-gates` | the owner's `route` is `execute-phase`: a `stale` or `missing` report, on both sides of `--phase-marked`, whatever the report's own `status` field says |
| `update-roadmap` | a fresh `passed` report and the phase is not marked complete |
| `exit-unchanged` | a fresh `passed` report and the phase is marked complete |
| `present-route` | any other route (`gaps_found`, `human_needed`, `unparseable`, `phase_dir_not_found`) |

The three plan-index exits never read the report, so they answer even when the report's `status` is outside the closed set; every other decision reads it and fails with `verification_status_invalid` like `verification status`. The branch is derived from the same `VERIFICATION_ROUTES` table as `verification status`, not a second one.

---

## Validation Commands

Check project integrity.

```bash
# Check phase numbering, disk/roadmap sync
node gsd-tools.cjs validate consistency

# Check .planning/ integrity, optionally repair
node gsd-tools.cjs validate health [--repair]

# Probe context-window utilization for status-line / hook callers (v1.40.0)
node gsd-tools.cjs validate context

# Context utilization as typed JSON surface (#455)
node gsd-tools.cjs validate context --json
```

`validate consistency`'s `warnings` entries are coded diagnostics (`{code, message, fix, repairable}`), not bare strings. A phase declared in ROADMAP.md with no directory on disk, or a directory on disk with no ROADMAP.md entry, reports under `W006`/`W007` — the same codes `validate health` uses for the identical check, since it's one enumeration with two callers, not a separate check. The four subjects unique to this command (numbering gaps in phases or plans, orphan `*-SUMMARY.md` files, plans missing `wave` frontmatter) use a new `C0NN` code range (`C001`-`C004`).

`validate context` emits a structured envelope with `utilization`, `status`
(`ok` / `warn` / `critical` at the 60 % / 70 % thresholds), and a
`suggestion` string. The same data backs `/gsd-health --context`.
Pass `--json` to receive the typed IR directly (useful in scripts and test assertions).

---

## Planning Snapshot Commands

### `planning inspect`

Emits a read-only, schema-versioned snapshot of everything `.planning/` knows,
as one JSON document. It exists so a downstream tool — a harness UI, a
mission-control view, a dashboard — can consume planning state without parsing
`ROADMAP.md` / `REQUIREMENTS.md` / `*-PLAN.md` / `*-SUMMARY.md` a second time
and drifting from gsd-core's own answers.

```bash
gsd-tools query planning inspect
gsd-tools query planning.inspect     # dotted canonical form — identical output
```

**Takes no arguments.** A stray positional or an unrecognized flag is a
fail-loud usage error, not a silently-ignored one: a caller who believed
`--phase 3` was scoping the query would otherwise receive a whole-project
snapshot presented as a scoped one.

`planning inspect` writes nothing, anywhere. It is safe to run against a
project mid-workflow.

#### The schema contract

```json
{ "schema_version": 1, "...": "..." }
```

`schema_version` is the contract. **A consumer must reject any value other than
the one it was written against** rather than best-effort-parsing a shape it does
not know. Every top-level key is always present; a key is never omitted to
signal absence, because omission is itself something callers come to depend on.

| Key | What it carries |
|-----|-----------------|
| `schema_version` | Always `1` today |
| `generated_from` | Resolved `cwd` and `.planning/` root (`null` when there is no planning root) |
| `milestone` | `version`, `name`, and the `scope` of that answer |
| `active` | `phase`, `plan`, and `status` — three distinct STATE.md facts, each scoped separately |
| `phases[]` | Per phase: completion, verification (`status`, `next_action`, and the additive `route` — see [`verification status`](#verification-status-the-verification-verdict-5118)), roadmap acceptance, UAT, plan and task rows |
| `orphan_phase_dirs[]` | Directories under `phases/` that the current milestone window does not declare |
| `requirements[]` | Requirement rows with mapped-phase traceability |
| `progress` | `accepted_phases` and `completed_plans`, as independent fractions |
| `diagnostics[]` | Coded reasons for every non-answer above |

#### Three kinds of evidence, never folded together

Each phase reports `verification`, `roadmap_acceptance`, and `uat` **side by
side**. They are not combined into a single verdict, because they answer
different questions and can legitimately disagree — a phase can pass
verification while UAT items remain open.

`roadmap_acceptance.checkbox` is reported with `authoritative: false`. A ticked
ROADMAP checkbox is a human annotation with no machine authority: completion is
derived from disk state (a passing `*-VERIFICATION.md`), and a stale tick never
overrides it. See [Milestone window scope](#milestone-window-scope-roadmap-analyze).

#### Unknown is a real answer; nothing is inferred

Where the evidence is absent, or where two sources disagree, the value is `null`
or `"unknown"` and a coded entry in `diagnostics[]` says why. It is never
reconciled, guessed, or filled from a plausible default.

The most common case is task-scoped file provenance. A `<task>` block declares
the files it plans to touch, but `SUMMARY.md`'s `## Files Created/Modified`
section describes the **whole plan**, not an individual task. Spreading that
plan-level list across the plan's tasks would be inference, so instead:

| `provenance` | Meaning |
|---|---|
| `task_scoped` | The summary attributed files to this specific task (via a deviation block naming `Found during: Task N`) |
| `plan_scoped` | A summary exists, but only carries a plan-level file list — this task's changed files are unknown |
| `absent` | No summary exists yet |

When a task's planned and changed file sets both exist and disagree,
`agreement` is `"conflicting"` and **both lists are emitted verbatim**.

#### Percentages are withheld rather than guessed

`progress.accepted_phases` and `progress.completed_plans` are independent
fractions, each `{completed, total, percent, scope}`. `percent` is `null`
whenever `scope` is anything other than `complete` — the same rule the roadmap
and progress surfaces follow, for the same reason. See
[A non-`COMPLETE` scope withholds the percentage entirely](#a-non-complete-scope-withholds-the-percentage-entirely-3217).

`0` is a real answer under a `complete` scope and is never withheld.

#### Large payloads

Output over ~50 KB is written to a temp file and returned as
`@file:<path>`, which `gsd-tools` resolves transparently before writing to
stdout — the same channel `init` uses. Callers see JSON either way.

---

## Template Commands

Template selection and filling.

```bash
# Select summary template based on granularity
node gsd-tools.cjs template select <type>

# Fill template with variables
node gsd-tools.cjs template fill <type> --phase N [--plan M] [--name "..."] [--type execute|tdd] [--wave N] [--fields '{json}']
```

Template types for `fill`: `summary`, `plan`, `verification`

---

## Frontmatter Commands

YAML frontmatter CRUD operations on any Markdown file.

```bash
# Extract frontmatter as JSON
node gsd-tools.cjs frontmatter get <file> [--field key]

# Update single field
node gsd-tools.cjs frontmatter set <file> --field key --value jsonVal

# Merge JSON into frontmatter
node gsd-tools.cjs frontmatter merge <file> --data '{json}'

# Validate required fields
node gsd-tools.cjs frontmatter validate <file> --schema plan|summary|verification
```

---

## Scaffold Commands

Create pre-structured files and directories.

```bash
# Create CONTEXT.md template
node gsd-tools.cjs scaffold context --phase N

# Create UAT.md template
node gsd-tools.cjs scaffold uat --phase N

# Create VERIFICATION.md template
node gsd-tools.cjs scaffold verification --phase N

# Create phase directory
node gsd-tools.cjs scaffold phase-dir --phase N --name "phase name"
```

The verification scaffold omits frontmatter `status` until the verifier writes a verdict
(`passed`, `gaps_found`, or `human_needed`). `verification status` therefore reports the
fresh scaffold as `missing` and routes to `execute-phase`; phase completion stays blocked
until verification passes. The UAT scaffold retains its blocking `status: pending`.

---

## Init Commands (Compound Context Loading)

Load all context needed for a specific workflow in one call. Returns JSON with project info, config, state, and workflow-specific data. `init onboard [--fast] [--text]` reports brownfield signals, planning-doc candidates, codebase-map completeness, fast-map readiness, text-mode routing, partial planning state, and onboarding summary status for `/gsd-onboard`.

```bash
node gsd-tools.cjs init execute-phase <phase>
node gsd-tools.cjs init plan-phase <phase>
node gsd-tools.cjs init new-project
node gsd-tools.cjs init new-milestone
node gsd-tools.cjs init onboard [--fast] [--text]
node gsd-tools.cjs init quick <description>
node gsd-tools.cjs init resume
node gsd-tools.cjs init verify-work <phase>
node gsd-tools.cjs init phase-op <phase>
node gsd-tools.cjs init code-review <phase> [--fix]
node gsd-tools.cjs init review <phase>
node gsd-tools.cjs init discuss-phase-assumptions <phase> [--auto]
node gsd-tools.cjs init todos [area]
node gsd-tools.cjs init milestone-op
node gsd-tools.cjs init map-codebase
node gsd-tools.cjs init progress
node gsd-tools.cjs init manager
node gsd-tools.cjs init complete-milestone
node gsd-tools.cjs init autonomous [--converge] [--cross-ai]
node gsd-tools.cjs init docs-update
node gsd-tools.cjs init update [--next] [--rc]
node gsd-tools.cjs init transition

# Workstream-scoped init (`--ws` flag)
node gsd-tools.cjs init execute-phase <phase> --ws <name>
node gsd-tools.cjs init plan-phase <phase> --ws <name>
```

**Large payload handling:** When output exceeds ~50KB, the CLI writes to a temp file and returns `@file:/tmp/gsd-init-XXXXX.json`. Workflows check for the `@file:` prefix and read from disk:

```bash
INIT=$(node gsd-tools.cjs init execute-phase "1")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

---

## Milestone Commands

```bash
# Archive milestone
node gsd-tools.cjs milestone complete <version> (--confirm | --dry-run) [--name <name>] [--no-archive-phases] [--force] [--archive-quick] [--release-map <file>]

# Archive .planning/quick/* into milestones/<version>-quick/ WITHOUT the milestone complete close-out (#2142)
node gsd-tools.cjs milestone archive-quick <version> [--dry-run]

# Preflight, then create annotated release tags per sub-repo (#5705)
node gsd-tools.cjs milestone release-tags --map <file.json> [--dry-run]

# Mark requirements as complete
node gsd-tools.cjs requirements mark-complete <ids>
# Accepts: REQ-01,REQ-02 or REQ-01 REQ-02 or [REQ-01, REQ-02]
```

**`milestone complete` flags**

| Flag | Description |
|------|-------------|
| `<version>` | Milestone version label to archive (e.g. `v1.0`). |
| `--confirm` | **Required to mutate (#3726).** The archive is irreversible — ROADMAP.md/REQUIREMENTS.md archived, phase directories MOVED, STATE.md rewritten — so without this flag the command refuses and changes nothing (exit 1, with a message naming both `--confirm` and `--dry-run`). Not implied by `--force`, which only overrides the guards below. |
| `--name <name>` | Display name for the MILESTONES.md entry. Defaults to `<version>`. |
| `--archive-phases` | Move phase directories into `.planning/milestones/<version>-phases/`. This is the default, so the flag only states it explicitly; `--no-archive-phases` is the inverse. |
| `--no-archive-phases` | Leave phase directories in place instead of moving them into `.planning/milestones/<version>-phases/`. |
| `--archive-quick` | Opt-in (default OFF, #2142): also move every directory under `.planning/quick/` into `.planning/milestones/<version>-quick/`, (re)write that archive directory's `README.md` index, and clear STATE.md's `### Quick Tasks Completed` table rows. See "`milestone archive-quick`" below for the narrower standalone form and the full behavior. |
| `--release-map <file>` | Opt-in (#5706): archive a per-repository release map. `<file>` is a JSON array of `{ repo, release, reference, environment, status, tag }` entries (fields and limits in [Per-repository release mapping](CONFIGURATION.md#per-repository-release-mapping)). The map is validated before anything is written; any problem fails the command with every error listed and changes nothing. On success the map is written to `.planning/milestones/<version>-RELEASE-MAP.json`, a `**Release mapping:**` table is added to the MILESTONES.md entry, and the JSON result carries `release_map: { path, entries }`. The file must be a regular file of at most 1 MiB. A later run for the same version never overwrites an archived map that differs. Without the flag, output and files are unchanged. |
| `--force` | Override the unstarted-phase guard (see below). |
| `--dry-run` | Print the archive plan (roadmap, requirements, phases, and — when `--archive-quick` is also passed — quick-task dirs to move) without mutating anything. With `--release-map`, the map is validated and reported under `would_archive.release_map`. |

**Unstarted-phase guard.** Before archiving, the command scans the ROADMAP scoped for `<version>` and refuses if any `### Phase N:` heading in that slice has no matching phase directory on disk (`disk_status: no_directory`). Phase 0 (pre-milestone) and Phase 999 (backlog) sentinels are excluded. The guard runs whenever `--force` is absent, independent of `STATE.md`'s `milestone:` field — if that field is present but does not match `<version>`, a WARNING naming both values is emitted to stderr and the scan still runs (#2946). Pass `--force --confirm` to override (`--confirm` is required for any mutating run — #3726; `--force` alone does not imply it).

**Sentinel directories are never archived.** The phase-directory move performed when `--no-archive-phases` is absent is now filtered through the same canonical sentinel predicate as `phases list` and `phases clear`: `999.*` (backlog) and `0-*` (pre-milestone) directories are left in place rather than moved into `.planning/milestones/<version>-phases/`. Previously this path was scoped only by the milestone window, with no sentinel filter, so a sentinel directory sitting inside the window could be archived along with the milestone's real phases.

**`milestone archive-quick` (#2142 escalation)**

A narrower sibling of `milestone complete --archive-quick`, for callers that need to sweep `.planning/quick/*` WITHOUT the full milestone close-out — chiefly `gsd-core/workflows/cleanup.md`, which runs against milestones that are typically already completed.

| Flag | Description |
|------|-------------|
| `<version>` | Milestone version label to archive quick-task directories under (e.g. `v1.0`). Same validation as `milestone complete`'s `<version>` — letters/digits/`.`/`-`/`_` only, no path separators or `..`. |
| `--dry-run` | List what would move (`would_archive`) without mutating anything. |

It moves every directory under `.planning/quick/` into `.planning/milestones/<version>-quick/`, (re)writes that archive directory's `README.md` index, and clears STATE.md's `### Quick Tasks Completed` table rows — the same move/index/reset logic `milestone complete --archive-quick` uses. Unlike `milestone complete`, it never archives `ROADMAP.md`/`REQUIREMENTS.md`, never writes a `MILESTONES.md` entry, and runs neither the unstarted-phase guard nor the milestone-window refusal — so, unlike `milestone complete --archive-quick`, it can be safely re-run against an already-completed milestone. JSON result: `{ version, archived, entries, archive_dir, state_updated, warnings }`.

`milestone archive-quick` is a second subcommand of `milestone` (alongside `complete`) — it is not a separate top-level command.

**`milestone release-tags` (#5705)**

Creates one annotated git tag per repository listed in `sub_repos`. `--map` points at a JSON file (at most 1 MiB) holding an array of at most 256 entries (`skip` entries count toward the limit): `{ "repo": "api", "tag": "v1.2.0", "ref": "HEAD", "message": "...", "skip": false }`. `repo` must be listed in `sub_repos` (a leading `./` and trailing `/` are ignored; absolute paths, `..` segments and backslash variants are rejected). `ref` defaults to `HEAD`; `message` defaults to the tag name; `skip: true` reports the repo as skipped without touching it.

Every entry is validated before the first tag is written, so a predictable failure creates nothing anywhere. A tag that already exists at the requested commit is reported `already_tagged` (re-running the same map is safe); a tag at a different commit is a `tag_conflict` and is never overwritten. `--dry-run` runs the validation only and reports `would_create`. Nothing is pushed.

Tag creation is not transactional across repositories. If a write fails after earlier ones succeeded, the remaining repositories are still attempted, `created` lists every `repo:tag` already written, and the command exits non-zero; re-run the same map to retry only the failed ones.

JSON result: `{ ok, phase, repos, created, errors }`. `phase` is `preflight` (validation failed), `dry_run` or `apply`. `repos` is keyed by repo path (`repo:tag` when one repo receives two tags); each value has `status` (`created`, `already_tagged`, `skipped`, `would_create`, `failed`, `error`) plus `tag`, `commit`, and on failure `reason`, `error`, `existing_commit`, `requested_commit`. Reason codes: `no_sub_repos`, `invalid_request`, `too_many_entries`, `repo_not_configured`, `repo_path_invalid`, `repo_missing`, `not_a_git_repo`, `tag_invalid`, `ref_unresolved`, `tag_conflict`, `duplicate_entry`, `git_timeout`, `tag_create_failed`.

---

## Agent Skills

Emit the skill block for a given agent type.

```bash
# Emit raw XML skill block (default — safe for shell expansion)
node gsd-tools.cjs agent-skills <agent-type>

# Emit typed JSON surface (#455) — { agent_type, block, skills_count, warnings, configured, reason, source, degraded }
node gsd-tools.cjs agent-skills <agent-type> --json

# Configured skills only (#5122): the agent's own self-load, never the persona fallback served to orchestrator-side injection
node gsd-tools.cjs agent-skills <agent-type> --skills-only
```

The `--json` flag returns a typed IR object suitable for structured consumption and test assertions, while the default (no flag) preserves the raw XML output that workflow shell expansions rely on.

**`--json` field reference** (as of #1415, Resolution Provenance P2):

| Field | Type | Description |
|---|---|---|
| `agent_type` | `string` | The agent type that was queried. |
| `block` | `string` | The `<agent_skills>` XML block, or `""` when empty. |
| `skills_count` | `number` | Number of skill paths configured for this agent type. |
| `warnings` | `string[]` | Per-path warnings for skills that were skipped (missing `SKILL.md`, unsafe path, etc.). Empty when all configured paths resolved. |
| `configured` | `boolean` | `true` when the agent type appears in `agent_skills` in the config; `false` when the key is absent entirely. |
| `reason` | `string` | Resolution reason: `"resolved"` (block non-empty), `"not_configured"` (agent not in `agent_skills` — silent), `"configured_empty"` (configured but paths list is empty — emits stderr WARNING), `"configured_unresolved"` (configured with paths but all failed to resolve — emits stderr WARNING). |
| `source` | `string` | Config provenance: `"root"` (`.planning/config.json`), `"workstream"` (workstream-scoped config), `"global-defaults"` (`~/.gsd/defaults.json`), `"builtin-defaults"` (no project config). |
| `degraded` | `boolean` | `true` when a workstream was requested but its config.json was absent and the command fell back to root config; `false` otherwise. |

The command anchors to the project root via `findProjectRoot` before loading config, so invoking it from a descendant subdirectory resolves the same config as the project root.

---

## Skill Manifest

Pre-compute and cache skill discovery for faster command loading.

```bash
# Print the manifest of every skill root (project, global and legacy)
node gsd-tools.cjs skill-manifest

# Also write it to skill-manifest.json in the planning directory (when that directory exists)
node gsd-tools.cjs skill-manifest --write

# List one directory only: this is what the project-skills discovery step runs per directory
node gsd-tools.cjs skill-manifest --skills-dir .claude/skills
```

Each entry carries the skill's `name`, `description`, `triggers`, `path` and `file_path` from its `SKILL.md` frontmatter. The body is not emitted, apart from lines that start `TRIGGER when:`, which are collected into `triggers`; `description` and `triggers` are not length-limited. Within one directory a skill is keyed by its frontmatter `name`: two skill folders that declare the same `name` are listed once. A skill directory that is a symlink is listed; a dangling link or a link to a file is skipped. A skill with no usable `description` (missing key, unparseable or unterminated frontmatter) is listed with `description: ""`. `--skills-dir` replaces the default roots with that one directory (scope `custom`); a directory that does not exist is reported with `present: false`.

Returns JSON mapping of all available GSD skills with their metadata (name, description, file path, argument hints). Used by the installer and session-start hooks to avoid repeated filesystem scans.

---

## Drift Guard, Workstream, UAT, Todo and Stats Verbs

These verbs run as `node gsd-tools.cjs <verb>` or `node gsd-tools.cjs query <verb>`; the dotted manifest name (`workstream.status`) and the spaced form (`workstream status`) are interchangeable where both are listed. Output is JSON unless stated; the [global flags](#command-flags-and-the-cli-surface-manifest) apply.

### `drift-guard authority`

Prints the effective source-grounding authority for plan review, one of `grep`, `intel`, `treesitter`, `lsp`, `scip`. The configured value is `plan_review.source_grounding_authority` in `config.json` (default `grep`; an unknown value is an error naming the valid ones). A configured `grep` is upgraded to `intel` when `intel.enabled` is `true`; every other configured value is returned unchanged. Takes no flags.

### `drift-guard severity --status <status> [--authority <authority>]`

Classifies one source-grounding verdict. `--status` is required and is one of `VERIFIED`, `MISSING`, `AMBIGUOUS`, `UNCHECKABLE`; `--authority` defaults to the effective authority above. Output: `{severity, hardBlock}`.

| Status | Authority | Severity | `hardBlock` |
|--------|-----------|----------|-------------|
| `VERIFIED` | any | `none` | `false` |
| `MISSING` | `lsp` or `scip` | `HIGH` | `true` |
| `MISSING` | `grep`, `intel` or `treesitter` | `needs-acknowledgement` | `false` |
| `AMBIGUOUS` | any | `MEDIUM` | `false` |
| `UNCHECKABLE` | any | `INFO` | `false` |

### `drift-guard phase-status [--phase <N>]`

Compares the `Status:` line in STATE.md's `## Current Position` section with the Status cell of that phase's row in ROADMAP.md's `## Progress` table. `--phase` defaults to the phase named by `Phase:` in the same section. Output: `{verdict, phase, stateStatus, roadmapStatus, stateRank, roadmapRank, authority}` with `authority` always `STATE.md`.

| `verdict` | Meaning |
|-----------|---------|
| `consistent` | Both statuses sit on the same lifecycle rung |
| `lag` | The two statuses are one rung apart |
| `drifted` | Two or more rungs apart; or exactly one side is terminal; or exactly one side is `deferred` and the other is past rung 0 |
| `uncheckable` | A status was not recognised, or a source is missing (see `reason`) |

An `uncheckable` verdict caused by a missing source also carries `reason`: `missing_state` (no STATE.md), `no_current_position` (STATE.md has no Current Position section; the verb never guesses from the rest of the file), `missing_roadmap` (no ROADMAP.md) or `phase_not_in_roadmap` (no Progress row for the phase).

### `workstream status <name>`

Reports one workstream. Output when it exists: `{found: true, workstream, path, files: {roadmap, state, requirements}, phases, phase_count, completed_phases, status, milestone_shipped_unverified, current_phase, last_activity}`; otherwise `{found: false, workstream}`. `<name>` is required and must be a valid workstream name.

### `workstream complete <name>`

Archives a workstream: every entry of `.planning/workstreams/<name>/` moves to `.planning/milestones/ws-<name>-<YYYY-MM-DD>/` (a numeric suffix `-1`, `-2`, … is appended when that directory exists), and the workstream is cleared as the active one if it was. Output: `{completed: true, workstream, archived_to, remaining_workstreams, reverted_to_flat}`; `reverted_to_flat` is `true` when no workstream remains, in which case the empty `workstreams/` directory is removed. A name with no directory returns `{completed: false, error: "not_found", workstream}`. If a move fails, moved entries are put back and the result is `{completed: false, error: "archive_failed", message, workstream}`.

### `uat render-checkpoint --file <path>`

Renders the pending checkpoint of a UAT file as the text a verifier presents. `--file` is required and must resolve inside the project root. Output: `{file_path, test_number, test_name, checkpoint}`, where `checkpoint` is a Markdown block (`### CHECKPOINT: Verification Required`, the test name, its expected behavior, and the prompt `Type pass or describe what's wrong.`); the banner and prompt follow the configured `response_language`. A UAT file whose `## Current Test` section reads `[testing complete]` is an error: `UAT session is already complete; no pending checkpoint to render`.

### `uat complete-session <uat-file> [--message <text>]`

Closes a UAT session. The file must resolve inside the project root. The verb sets the frontmatter `status` to `complete`, or to `partial` when the `## Tests` section holds a test with result `pending`, result `blocked`, result `skipped` with no reason, or a `###` test heading with no `result:` line; and replaces the `## Current Test` body with `[testing complete]`. Output:

| Case | Output |
|------|--------|
| Nothing material changed (ignoring the `updated:` line) | `{changed: false, status}`; with `restored: true` when the live file differed from its committed form and was reset to it. Nothing is committed |
| The file changed | The file is written and committed alone, with `--message` or `test: complete UAT session (<path>)`: `{changed: true, status, committed}`, plus `reason` when `committed` is `false` |

A frontmatter block that cannot be parsed is refused: nothing is written or committed.

### `todo match-phase <phase>`

Ranks the pending todos in `.planning/todos/pending/*.md` by relevance to a phase. Each todo's `title:` (default `Untitled`), `area:` (default `general`) and `files:` lines are read; the rest of the body contributes its first 200 characters. Output: `{phase, matches, todo_count}`, where `matches` is `[{file, title, area, score, reasons}]` for every todo scoring above zero, highest score first, and `todo_count` is the number of pending todos read. The score is the sum of:

| Signal | Score |
|--------|-------|
| Words of more than two letters shared between the todo's title and body and the phase's name, goal and ROADMAP section (stop words excluded): 0.2 each | up to 0.6 |
| The todo's `area` (when not `general`) appears in the phase text | 0.3 |
| A path in the todo's `files:` overlaps a path in a phase plan's `files_modified` | 0.4 |

`<phase>` is required.

### `stats json`

Prints project statistics as JSON; bare `stats` does the same, and `stats table` prints a Markdown summary instead (`{rendered}`). Output fields:

| Field | Meaning |
|-------|---------|
| `milestone_version`, `milestone_name` | The current milestone; `null` when none |
| `phases` | `[{number, display_id?, name, plans, summaries, status}]`; `status` is a display label such as `Not Started`, `Planned`, `Complete` |
| `phases_completed`, `phases_total` | Phases at the `Complete` rung, and all phases |
| `total_plans`, `total_summaries` | Plan and summary counts across the phases |
| `percent` | `phases_completed` as a percentage of `phases_total` |
| `plan_percent` | `total_summaries` as a percentage of `total_plans` |
| `requirements_total`, `requirements_complete` | Count of `- [x] **` and `- [ ] **` lines in REQUIREMENTS.md |
| `git_commits`, `git_first_commit_date` | Commits reachable from `HEAD`, and the date of the root commit (`YYYY-MM-DD`) |
| `last_activity` | The last-activity line of STATE.md; `null` when absent |
| `phase_scope` | `complete` when every phase was enumerated; any other value means the phase list could not be fully read |

`percent` and `plan_percent` are `null` unless `phase_scope` is `complete`, so an unreadable phase directory is never reported as `0%`.

## Dispatch, Isolation, Review Lane and Workstream Verbs

These verbs are called by the workflows (and by hooks and health checks) rather than typed by hand, but each is a stable surface: its flags and output are what the callers depend on. Run a verb as `gsd_run query <verb>` or `gsd-tools <verb>`.

### Dispatch

```bash
# Parallel dispatch capacity of the current runtime
gsd-tools dispatch-capacity [--json]

# Whether the current runtime runs a subagent inline instead of dispatching it
gsd-tools dispatch-should-flatten [--json]

# Isolation to use for an executor dispatch; records the decision (see below)
gsd-tools dispatch-isolation [--phase <n>] [--plan <id>] [--force-isolation <mode>] [--renew-held <ms>] [--cwd-target <path>] [--prompt <text>] [--json]

# The same resolution without recording it
gsd-tools inspect-dispatch-isolation [--cwd-target <path>] [--prompt <text>] [--json]

# Record an isolation decision directly
gsd-tools record-dispatch-isolation --isolation <mode> [--harness-flag <flag>] [--phase <n>] [--plan <id>] [--executor-type <agent>] [--json]

# The type an Agent() call should use for a GSD subagent on the current runtime
gsd-tools resolve-dispatch-type --requested <name> [--json]
```

The current runtime is resolved in this order: `GSD_RUNTIME`, `runtime` in the config, the install's `.gsd-runtime` marker, then `claude`.

**`dispatch-capacity`** prints a positive integer. Its value comes from `GSD_DISPATCH_MAX_CONCURRENCY` when that is a positive integer, otherwise from the runtime's declared `dispatch.maxConcurrency`, otherwise `1`. With `--json` it prints `{ runtime, capacity, declared, source, reason }`: `source` is `live`, `descriptor` or `fallback`, and `reason` is `ok` or the reason the fallback applied (`missing`, `undocumented`, `non_integer`, `unsafe_integer`, `non_positive`, `non_numeric`, `unknown_runtime`).

**`dispatch-should-flatten`** prints `true` or `false`. It fails closed: an unknown runtime, a missing `dispatch` declaration or an error gives `true` (inline). With `--json` it prints `{ runtime, shouldFlatten, dispatch }`.

**`dispatch-isolation`** prints the isolation mode for the dispatch: `harness-worktree`, `orchestrator-worktree` or `none`. An unknown runtime, a missing or out-of-vocabulary declaration, or an error gives `none` (sequential execution). It also records the decision, with the harness flag and the phase and plan identifiers, in `.gsd/dispatch-isolation-sentinel.json`, which the isolation guard hooks read; a failed write never fails the call. With `--json` it prints `{ runtime, executorRuntime, isolation, exec, harnessFlag, fallback, held, decidedAt }`. `held` is `true` when a recorded degrade is being held, and `decidedAt` is then that decision's time in epoch milliseconds (otherwise `null`).

| Flag | Description |
|------|-------------|
| `--phase <n>`, `--plan <id>` | Identifiers recorded with the decision. |
| `--force-isolation <mode>` | Override the resolved mode with context the resolver cannot see (for example a per-plan submodule check). A value outside the closed mode list is ignored. `none` clears the harness flag and `exec`. |
| `--renew-held <ms>` | With `--force-isolation none`, marks the write as a dispatch following a held degrade and carries that decision's own `decidedAt`. |
| `--cwd-target <path>` | The worktree path the orchestrator will run in. `exec` (the resolved `{ command, args, cwd }`) is returned only for `orchestrator-worktree`, and only when this is given. |
| `--prompt <text>` | Prompt bound into `exec` when `--cwd-target` is given. |
| `--json` | Print the object above instead of the bare mode. |

**`inspect-dispatch-isolation`** resolves the same answer without writing the sentinel, for diagnostics such as `/gsd-health` and `/gsd-settings`. It accepts `--cwd-target`, `--prompt` and `--json`; `--force-isolation`, `--phase` and `--plan` are recording-only and are refused with a usage error.

**`record-dispatch-isolation`** writes the same sentinel from the caller's own decision and prints `{ recorded, path }`; `path` is `.gsd/dispatch-isolation-sentinel.json`. `--isolation` is required and must be one of the three modes. `--harness-flag` takes the flag in `--harness-flag=<flag>` form when the flag itself starts with `--` (for example `--harness-flag=--worktree`). A GSD role other than the executor passed as `--executor-type` is refused with a warning and recorded as no executor type. The CLI surface registry also declares a boolean `--worktree`; the handler does not read it.

**`resolve-dispatch-type`** prints the subagent type to use for `--requested <name>`: the name unchanged on runtimes with named dispatch (Claude Code, OpenCode and others), and on a runtime with built-in types only (Kimi Code) the closest built-in (`coder`, `explore` or `plan`) chosen by the name's role suffix.

### Execution settings

```bash
gsd-tools resolve-execution <agent-type> [--effort <level>] [--fast-mode true|false] [--attempt <n>] [--failure-class <class>] [--host <name>]
```

Resolves the model, effort and fast-mode settings for an agent type and prints them as JSON:

`{ model, profile, effort, effort_rendered, effort_param, effort_propagation, effort_requested, effort_clamped, effort_clamp_reason, effort_effective, effort_effective_source, fast_mode, fast_mode_supported }`

`effort_effective_source` is `frontmatter` or `frontmatter-absent` when the installed agent file decides (Claude Code), and `resolved` when no file evidence exists. An agent type that is not in the model catalog adds `unknown_agent: true`.

| Flag | Description |
|------|-------------|
| `--effort <level>` | Override the effort from the configuration cascade. |
| `--fast-mode true\|false` | Override fast mode. Any other value leaves the resolved setting. |
| `--attempt <n>` | A non-negative integer: resolve the model and effort for retry `n`, so dynamic routing can escalate both. |
| `--failure-class <class>` | Why the previous attempt failed: `quota-exceeded`, `classify-handoff-bug` or `unknown-failure`. Only `quota-exceeded` consults the provider-escalation ladder, and the result adds an `escalation` object. |
| `--host <name>` | Also render the invocation-time effort argument for that host. Adds `host`, `effort_surface`, `effort_argv`, `effort_argv_string` and `effort_argv_value`. |

Exactly one agent type is required.

### Prompt budget

```bash
gsd-tools prompt-budget --budget <tokens> --instructions-file <f> --roadmap-file <f> --plan-file <f> [--plan-file <f> ...] --output-prompt <f> --output-metadata <f> [--project-file <f>] [--context-file <f>] [--research-file <f>] [--requirements-file <f>] [--safety-margin-pct <n>] [--project-md-head-lines <n>]
```

Assembles a reviewer prompt from the given sections within a token budget, writes the prompt to `--output-prompt` and the budget metadata (JSON) to `--output-metadata`. `--budget`, `--instructions-file`, `--roadmap-file`, at least one `--plan-file`, `--output-prompt` and `--output-metadata` are required; the other files are optional and a missing optional file is skipped. `--budget` must be a positive integer. A missing required file exits `1` with the path; a prompt that cannot be brought within the budget exits `2` after writing both outputs, with `hardFailed` set in the metadata.

### Review lanes

```bash
gsd-tools review-lane plan [--selected <a,b>] [--run-dir <dir>] [--repo-root <dir>]
gsd-tools review-lane sections [--selected <a,b>] [--run-dir <dir>] [--repo-root <dir>]
gsd-tools review-lane invoke --slug <lane> [--as <name>] [--agent <name>] [--model <id>] [--prompt-file <f>] [--explicit] [--selected <a,b>] [--run-dir <dir>] [--repo-root <dir>] [--json]
gsd-tools review-lane flags [--selected <a,b>] [--run-dir <dir>] [--repo-root <dir>]
gsd-tools review-lane availability [--selected <a,b>] [--run-dir <dir>] [--repo-root <dir>]
gsd-tools review-lane dispatch-step [--explicit <flags>] [--depth <n>] [--base-sha <sha>] [--cap-id <id> --point <point>] [--run-dir <dir>] [--repo-root <dir>]
```

The lane roster is the first-party lanes plus installed third-party lanes. Without `--selected` every lane is used (`dispatch-step` always uses the whole roster and does not take it); `--run-dir` (default `.`) is where prompts and results are written; `--repo-root` defaults to the working directory.

- **`plan`** prints a JSON array with one entry per lane: `{ slug, ok, section, transport, promptBudget, promptCapSource, contextWindowTokens, promptPath }`. A lane that cannot run has `ok: false` with a `reason`.
- **`sections`** prints one `<slug><TAB><reviews section>` line per lane.
- **`flags`** prints the reviewer flags the roster declares, one per line in roster order, for the first-party and installed lanes (a lane can declare more than one, for example `--antigravity` and `--agy`). Only flags of the form `--` followed by lowercase letters, digits and hyphens are printed, so the output is safe to word-split in a shell loop; with no flag there is no output and no trailing newline.
- **`availability`** prints one `<slug>:available|missing` line per first-party local OpenAI-compatible lane (`ollama`, `lm_studio`, `llama_cpp`), in roster order. The probe is a bounded GET of `/v1/models` on the host `review.<lane>_host` names, or the lane's built-in default host when that key is unset. A host left at the built-in default counts as `available` only when the listing answers with a 2xx OpenAI-style `/v1/models` response, and warnings go to stderr.
- **`dispatch-step`** is what a capability step calls to run the reviewer lanes a caller asked for. `--explicit` is a comma-separated list of lane flags; `--depth` and `--base-sha` are passed through to the dispatch. `--cap-id` and `--point` together name the capability and loop point whose `supportsReviewerLanes` trait is resolved; giving only one of them prints a warning and leaves the trait off. The changed file paths are read from stdin, one per line (none when stdin is a terminal).
- **`invoke`** runs the lane named by `--slug` and prints its result as JSON; an unknown or not-ok lane prints `{ slug, ok: false, reason, detail }`. `--as <name>` runs the lane as a [reviewer instance](CONFIGURATION.md#review-settings) of that name, writing `gsd-review-<name>.md` under `--run-dir`, with `--model` and `--agent` supplying the instance's model and agent. `--prompt-file` substitutes a different prompt. `--explicit` marks the lane as explicitly requested. A prompt over the lane's cap is refused, never trimmed.

### Loop hooks

```bash
gsd-tools loop render-hooks <point> [--config-dir <path>] [--runtime <runtime>] [--active-cap <id>] [--after-fingerprint <phase-dir>]
```

Renders the active loop extension-point hooks for `<point>` (for example `plan:pre`) and prints `{ point, activeHooks, rendered }`, plus `warnings` and `skippedHooks` when there are any. `--config-dir` selects the runtime config directory; `--runtime` names the runtime explicitly instead of using the persisted one; `--active-cap <id>` makes the command print only `true` or `false`, whether that capability has an active hook at the point; `--after-fingerprint` drops `verify:post` steps whose declared artifact already exists in that phase directory, and errors when the directory cannot be read. Any other `loop` subcommand is an error.

### Package legitimacy

```bash
gsd-tools package-legitimacy check --ecosystem <npm|pypi|crates> <package> [<package> ...]
```

Looks each package up in the registry API of its ecosystem (npm, PyPI or crates.io) and prints the results as JSON, one entry per package, each with a `verdict`. `--ecosystem` is required and must be `npm`, `pypi` or `crates`; at least one package name is required; either missing is a usage error. A registry or network failure does not fail the command: that package gets a degraded verdict with the failed lookups noted in its `signals` and `reasons`. The command needs network access. How `gsd-phase-researcher` uses the verdicts is described under [`/gsd-plan-phase`](COMMANDS.md#gsd-plan-phase).

### Assumption delta

```bash
gsd-tools assumption-delta scan <phase> [--terms <csv>] [--json]
```

Reads the phase section the way `roadmap get-phase` does and runs the deterministic assumption-delta detector for the advisory architecture checkpoint, printing its result as JSON. `--terms` replaces the default pluralization cues with a comma-separated list; the list is lower-cased, de-duplicated and reduced to alphanumerics, and an empty or flag-shaped value restores the defaults. A missing or flag-shaped `<phase>` is a usage error.

### Commit guard

```bash
gsd-tools check-commit
gsd-tools commit-docs-guard enable
gsd-tools commit-docs-guard disable
```

`check-commit` inspects the staged files and, when `.planning/` files are staged, allows the commit only if `commit_docs` resolves to `true` (phase-level or project-level); otherwise it exits with an error that lists the files and how to unstage them. It prints `{ allowed: true, reason }` with `reason` one of `phase_commit_docs_true`, `commit_docs_enabled` or `no_planning_files_staged`; `--raw` prints `allowed`.

`commit-docs-guard enable` installs a GSD-marked `pre-commit` hook and prints `{ enabled: true, action, path }` with `action` `written` or `already_enabled`. It refuses outside a git repository and when `core.hooksPath` is set (the hook would never run). `commit-docs-guard disable` removes that hook and prints `{ disabled: true, action, path }` with `action` `removed` or `noop`; it refuses to remove a `pre-commit` hook that does not carry the GSD marker.

### Workstreams

```bash
gsd-tools workstream create <name> [--migrate-name <name>] [--no-migrate]
gsd-tools workstream list
gsd-tools workstream get
gsd-tools workstream set <name>
gsd-tools workstream progress
```

- **`create`** makes `.planning/workstreams/<name>/` with its `STATE.md` and `phases/` and prints `{ created, workstream, path, state_path, phases_path, migration, active }`. When the project is still in flat mode (no `workstreams/` directory) and already has a `ROADMAP.md`, `STATE.md` or `phases/`, the existing work is first migrated into a workstream named after the current milestone (or `default`): `--migrate-name` chooses that name and `--no-migrate` skips the migration. An existing workstream prints `{ created: false, error: "already_exists" }`.
- **`list`** prints `{ mode, workstreams }`; each entry has `name`, `path`, `has_roadmap`, `has_state`, `status`, `milestone_shipped_unverified`, `current_phase`, `phase_count` and `completed_phases`.
- **`get`** prints `{ active, mode }`; `active` is `null` when no workstream is active.
- **`set <name>`** makes the workstream active and prints `{ active, set: true }`; an unknown name prints `{ active: null, error: "not_found", workstream }`.
- **`progress`** prints `{ mode, active, workstreams }`; each entry has `name`, `active`, `status`, `milestone_shipped_unverified`, `current_phase`, `phases` and `plans` as completed-over-total strings such as `0/1`, and `progress_percent`.

### Environment and codebase-map helpers

```bash
gsd-tools config-path
gsd-tools skills-root <runtime>
gsd-tools update-context [--runtime <runtime>] [--config-dir <path>] [--json]
gsd-tools normalize-test-command <command> [--cwd <dir>]
gsd-tools stamp-codebase-map [--files <names>]
```

- **`config-path`** prints the resolved `config.json` path as plain text; it is the workstream's config when a workstream is active.
- **`skills-root <runtime>`** prints `{ "skills_root": "<path>" }`, the global skills directory of the runtime. An unregistered runtime id is an error, and a missing argument is a usage error.
- **`update-context`** probes the runtime config directories for an installed GSD and prints `{ installedVersion, scope, runtime, gsdDir }`; `scope` is `LOCAL` or `GLOBAL`, and with no install found it prints version `0.0.0`, scope `UNKNOWN` and empty `runtime` and `gsdDir`. `--config-dir` names a preferred install directory, probed first, and `--runtime` names the preferred runtime.
- **`normalize-test-command <command>`** prints the command rewritten to a one-shot form so a watch-mode runner cannot hang a verification gate: `vitest` becomes `vitest run`, `jest --watch` becomes `jest --watchAll=false`, a package-manager `test` script whose `package.json` runs vitest or jest in watch mode gets a `CI=true` prefix, and any other command is printed unchanged. `--cwd` locates `package.json`.
- **`stamp-codebase-map`** stamps the codebase map documents under `.planning/codebase/` with the current `HEAD` commit and date. It never fails the caller: with no `.planning/codebase/`, outside a git repository or with no map documents it prints `{ stamped: [], commit: null, stamped_at: null, skipped: true, reason }`. `--files <names>` restricts the stamp to the named map documents; an unknown name or an empty value is skipped with a reason.

## Utility Commands

```bash
# Convert text to URL-safe slug
node gsd-tools.cjs generate-slug "Some Text Here"
# → some-text-here

# Get timestamp
node gsd-tools.cjs current-timestamp [full|date|filename]

# Count and list pending todos
node gsd-tools.cjs list-todos [area]

# List captured seeds (optionally filter by status: dormant|active|triggered|closed)
# `dormant`, `active` and `triggered` are the open statuses; `closed` is the one value that takes a
# seed out of `audit-open` and out of `/gsd-new-milestone`'s candidates (#4647). Each seed object carries
# seed_id, slug, status, scope, trigger_when, planted, title, path, and the outcome fields outcome_kind
# (promoted|built|dropped), outcome_ref (requirement id or phase number; empty when dropped) and
# outcome (one line), which are empty strings on a seed that is not closed.
node gsd-tools.cjs list-seeds [status]

# Check file/directory existence
node gsd-tools.cjs verify-path-exists <path>

# Append a row to STATE.md's "Quick Tasks Completed" table (schema-backed; #2133)
node gsd-tools.cjs quick-tasks-append --task "<description>"
# Optional (#3356) — supply a real quick id and task directory to write the canonical row the
# `/gsd-quick` workflow itself renders, instead of a positional `#` and an em-dash `Directory`:
node gsd-tools.cjs quick-tasks-append --task "<description>" --quick-id <id> --slug <slug>
node gsd-tools.cjs quick-tasks-append --task "<description>" --directory "[<id>-<slug>](./quick/<id>-<slug>/)"
# All four flags are optional. Omit them (as `fast.md` does, having neither an id nor a task
# directory) and the emitted row is byte-identical to the pre-#3356 behavior. `--directory` wins
# outright when given; otherwise `--quick-id` + `--slug` together derive the permalink.
# --status (#4906 Phase 3, #4958) writes the Status column on a table that has one (the
# $VALIDATE_MODE row shape workflows/quick.md renders) — omitted, the Status cell falls back to
# `appendQuickTaskRow`'s own '—' default, unchanged for every caller that never sets it:
node gsd-tools.cjs quick-tasks-append --task "<description>" --quick-id <id> --slug <slug> --status PASS
# This append touches only the body table — it no longer forces a re-derive of the disk-derived
# `progress.*` frontmatter, which previously overwrote curated values (#3356).
# A --task over 240 characters (the #2618 todo-bullet bound; "characters" are UTF-16 code units,
# JavaScript string length, so an emoji counts as 2) is still written in full and the command
# still exits 0, but the JSON result's `warnings` (a string[], empty otherwise) carries one entry;
# under --raw the warning goes to stderr. `quick-batch complete` returns the same `warnings` for
# the row it appends. Pass a one-line title; detail belongs in the task's SUMMARY (#5830).
# See "Milestone Commands" below for `milestone archive-quick` (#2142) — sweeps .planning/quick/* into
# milestones/<version>-quick/ and clears this table, without a full `milestone complete`.

# Aggregate all SUMMARY.md data
node gsd-tools.cjs history-digest

# Extract structured data from SUMMARY.md
node gsd-tools.cjs summary-extract <path> [--fields field1,field2]

# Project statistics
node gsd-tools.cjs stats [json|table]

# Progress rendering (human-readable)
node gsd-tools.cjs progress [json|table|bar]

# Progress as one bar: { bar, percent, completed, total }, and with --raw only the bar text,
# e.g. [░░░░░░░░░░░░░░░░░░░░] 0/0 plans
node gsd-tools.cjs progress bar

# Progress as typed JSON surface (#455)
node gsd-tools.cjs progress --json
```

Both `stats` and `progress` are scoped to the current milestone's `ROADMAP.md`
window and sentinel-filtered: `999.*` backlog directories and `0-*`
pre-milestone directories are not counted as current-milestone phases, and the
aggregate completion percentage no longer reads `100` while phases from the
active window are still outstanding.

On a project explicitly configured with `phase_id_convention: "bracket"`, both
JSON surfaces keep the phase's bare join key in `phases[].number` and add its
canonical human label in `phases[].display_id` (for example,
`{"number":"05.03","display_id":"[GSD.02] 05.03"}`). Their
`milestone_version` and table headings use `[GSD.02]` rather than the legacy
`v2.0` marker. Other conventions retain their prior object and table shapes.

```bash
# Complete a todo
node gsd-tools.cjs todo complete <filename> [--dry-run]
```

`--dry-run` previews the completion (a `dry_run`/`would_*` JSON payload naming
the source, the destination, and the frontmatter keys it would set) without
moving the file or touching anything on disk. A real completion moves the todo
from `todos/pending/` to `todos/completed/` and upserts `completed:` and
`status: completed` inside the file's frontmatter block. Unknown flags are
rejected loudly.

`<filename>` is a **basename inside the todos root**, not a path. A basename
guard runs first, before `<filename>` is joined onto any directory: a value
containing an embedded separator (either `/` or `\`, e.g. `sub/name.md` or
`sub\name.md`), a value whose own basename differs from itself (e.g.
`a/../../b.md`, `../sibling.md`), a bare `.` or `..`, an absolute path (e.g.
`/etc/passwd`), or a NUL byte is rejected as a usage error **before** any file
is read or moved (#4327, #4652). A traversal that only escapes the `pending`/
`completed` subdirectory without leaving the todos root (`../sibling.md`) is
caught by this same guard, not by containment. Containment against the todos
root still runs afterward as defense-in-depth for the resolved source and
target paths, so neither half of the move can land outside the root. The
check covers both halves of the move, and `--dry-run` is rejected on the same
terms rather than previewing a resolved outside path.

```bash
# UAT audit — scan all phases for unresolved items
node gsd-tools.cjs audit-uat

# Cross-artifact audit queue — scan `.planning/` for unresolved audit items
node gsd-tools.cjs audit-open [--json]

# Suppress one open audit item — writes a self-invalidating `audit_acknowledged`
# marker; never overwrites the artifact's own `status:` (except `deferred_items`,
# where the marker IS the entry's `status:`). See docs/COMMANDS.md's
# `/gsd-complete-milestone` entry for the full per-category identifier flag table.
node gsd-tools.cjs audit-open acknowledge --category <category> --milestone <version> [--at <date>] <identifier flags…>

# Reverse-migrate a GSD-2 project into the current structure (backs `/gsd-import --from-gsd2`)
node gsd-tools.cjs from-gsd2 [--path <dir>] [--force] [--dry-run]

# Git commit with config checks
node gsd-tools.cjs commit <message> [--files f1 f2] [--files-removed f3 dir/] [--amend] [--no-verify] [--respect-staged]
```

> `--files-removed <paths>` (#4208): the caller-declared deletions. A `--files` entry that is missing on disk is skipped, never staged as a deletion (#2014) — so a moved file's old path cannot be recorded through `--files` at all, and the only form that recorded a move was a directory entry, which also commits any unrelated file sitting in that directory. Each `--files-removed` entry names a file, or a directory whose tracked-but-absent files are the removals; those paths are staged as deletions and join the commit pathspec. "Tracked" means in the index or in `HEAD`, so a deletion the caller already staged with `git rm` is committed too; "present" is the path itself (`lstat`), so a symlink counts as present even when its target is gone. A file entry that is still present on disk fails the commit closed (`reason: 'staging_failed'`); a path git never tracked is a no-op. Absence alone is not removal: an index entry that is absent from the worktree by design — a submodule gitlink, a skip-worktree (sparse-checkout) path, an assume-unchanged path, an unmerged entry, an intent-to-add (`git add -N`) entry — is never staged as a deletion; under a directory entry it is left alone like a present file, and named directly (by any spelling that resolves to it) it fails closed naming the state. On a staging failure the rollback puts back every index entry this call removed with its recorded mode and blob (`update-index --cacheinfo`), including on an unborn `HEAD` where `git reset` has nothing to restore from; like the addition-side reset it is best-effort — an index that cannot be written reports the staging error, not a clean rollback. `--files` keeps its skip-if-missing contract unchanged. A move is therefore `--files new/path --files-removed old/path`. GSD's own `close_phase_todos` step (`execute-phase.md`) uses exactly that form, naming each moved todo on both sides rather than passing the two directories: a directory entry would also commit an unrelated todo a concurrent session dropped into `pending/` or `completed/` while the phase was closing.

> `--no-verify`: Skips pre-commit hooks. Used by parallel executor agents during wave-based execution to avoid build lock contention (e.g., cargo lock fights in Rust projects). The orchestrator runs hooks once after each wave completes. Do not use `--no-verify` during sequential execution — let hooks run normally.
> `--files <paths>` **staging behaviour**: by default, `--files` runs `git add -- <path>` for each named file before committing. This overwrites any per-hunk staging set up via `git add -p`. Pass `--respect-staged` to skip the `git add` step and commit only what is already in the index within the requested pathspec. If nothing is staged within that scope, the command returns `{ committed: false, reason: 'nothing staged' }` without error. The trailing `-- <paths>` pathspec on the commit is applied under both modes, so files staged outside the `--files` scope are never included (#3061 invariant).

```bash
# Web search (requires Brave API key)
node gsd-tools.cjs websearch <query> [--limit N] [--freshness day|week|month]
```

---

## Commit Selection, Sub-repo and Reviewer-flag Verbs

These verbs run as `node gsd-tools.cjs <verb>` (or `node gsd-tools.cjs query <verb>`); the [global flags](#command-flags-and-the-cli-surface-manifest) apply.

### `select-revert-commits --range <git-range> (--phase <id> | --plan <id>)`

Selects, from a git range, the commits that belong to one phase or one plan, for `/gsd-undo`. Exactly one of `--phase` and `--plan` is required, and `--range` is required and must not start with `-`; each failure is a usage error. The verb runs `git log --no-merges` over `--range` in the directory it was invoked from (not the main worktree) and reads each subject's declared scope: the `scope` of a `type(scope):` header, with a leading `fixup! ` or `squash! ` or a `Revert "…"` wrapper removed first. A subject with no scope, or no `type:` header, has no declared scope and is never selected.

| Flag | Selects a commit when its declared scope is |
|------|---------------------------------------------|
| `--phase <id>` | the phase id, or starts with `<id>-` (so `3` selects `03` and `03-01`; an all-digit id is zero-padded first; a bracket-style id such as `PROJ-42` is used as given) |
| `--plan <id>` | exactly the plan id, in the two-segment form `NN-MM` (`3-1` is padded to `03-01`). A three-segment id, or a bracket-style phase segment, is refused |

Output: `{selected: [{sha, subject}], classified: [{sha, subject, parsedScope, matched}]}`, `classified` holding every commit in the range with its parsed scope. With `--raw` the output is one `<sha> <subject>` line per selected commit. A `git log` failure (an invalid range, or one that takes more than 15 seconds) is a usage error naming the range.

```bash
node gsd-tools.cjs select-revert-commits --range main..HEAD --plan 03-01
node gsd-tools.cjs select-revert-commits --range HEAD~20..HEAD --phase 3 --raw
```

### `commit-to-subrepo "<message>" --files <path>...`

Commits files in the sub-repositories listed in `sub_repos` of `.planning/config.json`, one commit per sub-repository. The message is required, `sub_repos` must be non-empty, and `--files` is required, each a usage error. Each path is assigned to the sub-repository whose name is the longest prefix of the path (`sub_repos: ["packages", "packages/core"]` sends `packages/core/x.ts` to `packages/core`); a path matching none is reported on stderr and listed in `unmatched`. Within each sub-repository the verb stages the named paths (relative to it) and commits only those, never the rest of the index. A path that fails to stage unstages what this call staged and records `staging_failed` (or `staging_timeout`) for that sub-repository.

Output: `{committed, repos: {<repo>: {committed, hash, files, reason?, error?}}, unmatched?}`. `committed` is `true` when any sub-repository committed. A sub-repository that did not commit carries `reason`: `nothing_to_commit`, `staging_failed`, `staging_timeout`, `commit_timeout` or `error`. With `--raw` the output is `<repo>:<hash>` pairs, `skip` standing for a missing hash.

### `pr-subrepo "<message>" --repo <path> --branch <name>`

Puts a sub-repository's tracked changes on a new branch and pushes it, ready for a pull request. The message, `--repo` and `--branch` are required; `--branch` must not start with `-`; `--repo` must resolve inside the project root (an escaping path is refused). The verb collects the tracked changes of the sub-repository (untracked files are excluded; a rename counts both paths), refuses when the branch already exists, creates the branch, stages exactly those files, commits them with the message, and runs `git push --set-upstream origin <branch>`. It does not open the pull request.

| Result | Output |
|--------|--------|
| No tracked changes | `{ok: true, repo, branch, committed: false, reason: "nothing_to_commit", files: []}`; no branch is created |
| Pushed | `{ok: true, repo, branch, committed: true, files, commit_hash, remote_url, remote_slug}`; `remote_slug` is the `owner/repo` of a GitHub `origin`, else `null` |
| Staging or commit fails | The branch is deleted and the previous branch restored; the verb exits with an error |
| Push fails | The error names the retry command; the local branch and its commit are kept |

### `quick-tasks-migrate`

Rewrites the `### Quick Tasks Completed` table of STATE.md into the canonical column set `# | Description | Date | Commit | Status | Directory`. Each legacy column is mapped onto its canonical column; a column with no canonical counterpart, or a second column mapping to an already-filled one, is folded into `Description` as `<column>: <value>`, so no value is dropped. Empty canonical cells are written as `—`. The write goes through the STATE.md writer, which also refreshes the file's frontmatter.

Output: `{ok: true, migrated: true, from: [<legacy columns>], rows: <count>}` after a migration; `{ok: true, migrated: false}` when the table is absent or already canonical; `{ok: true, migrated: false, reason}` when STATE.md is missing (`reason` names the path). The verb is idempotent.

### `review-lane explicit-from-argv [--selected <a,b>] [--run-dir <dir>] [--repo-root <dir>] -- <argument>...`

Tells the review workflows which reviewer lanes the user named. Every token after `--` is compared with the flags each lane declares (the first-party lanes plus installed third-party reviewer lanes; `antigravity` declares both `--antigravity` and `--agy`), and the slugs of the matching lanes are printed as plain text, sorted and comma-joined, with no trailing newline. Output is empty when no token matches. `--selected`, `--run-dir` and `--repo-root` are accepted for parity with the other `review-lane` subcommands and do not affect this one.

```bash
node gsd-tools.cjs review-lane explicit-from-argv -- --claude --agy --all
# antigravity,claude
```

## Update Backup and Restore

The two halves of `/gsd-update`'s user-added-file protection. `detect-custom-files`
lists files that exist inside GSD-managed directories but are absent from
`gsd-file-manifest.json` — the update workflow copies those into
`gsd-user-files-backup/` before the clean-install wipe. `restore-custom-files`
puts them back afterwards.

```bash
# List user-added files the installer would destroy (JSON)
node gsd-tools.cjs detect-custom-files --config-dir <config-dir>

# Plan a restore — reports what would be restored, writes nothing
node gsd-tools.cjs restore-custom-files --config-dir <config-dir>

# Restore the eligible entries
node gsd-tools.cjs restore-custom-files --config-dir <config-dir> --apply
```

`restore-custom-files` emits one entry per backed-up file:

| Field | Meaning |
|---|---|
| `path` | Path relative to the config dir — where the file came from and goes back to |
| `outcome` | `eligible` (plan mode) · `restored` · `already_present` · `skipped_destination_managed` · `skipped_destination_exists` · `skipped_copy_failed` · `skipped_unsafe_path` |
| `warnings` | Advisory `{code, detail}` findings from the compatibility pass; never blocks a restore |

Warning codes: `destination_managed`, `destination_exists`,
`missing_referenced_path`, `missing_referenced_command`,
`frontmatter_missing_field`, `write_failed`.

The compatibility pass runs against the **newly installed** release, so it
catches a backed-up skill that `@`-references a workflow the new version
retired, invokes a `/gsd:` command that no longer exists, or is missing the
`name` / `description` frontmatter its runtime needs.

Three things the restore never does: it never deletes the backup, it never
overwrites a path the new release ships (`skipped_destination_managed`), and it
never overwrites a different file already on disk
(`skipped_destination_exists`). A destination that is already byte-identical to
its backup is reported as `already_present` and left untouched — it counts
toward neither `eligible_count` nor `restored_count`, so a plan run after a
successful restore no longer offers the same file again. Symlinked backup
entries are skipped outright rather than followed (`skipped_unsafe_path`). A
single unwritable entry is reported and the remaining entries still restore.

---

## Worktree Commands

Diagnose and configure the worktree fork base used by Claude Code's `isolation="worktree"` executor dispatch. These commands address the branch-divergence condition described in [Fix the worktree base-mismatch (exit 42) error](how-to/fix-worktree-base-mismatch.md).

```bash
# Check whether the current HEAD has diverged from the worktree fork base.
# Returns JSON: { shouldDegrade, reason, message, headSha, forkRef, forkSha }
node gsd-tools.cjs worktree base-check

# Same check, but against the fork base a worktree this host created was
# actually observed to have (git rev-parse HEAD inside it, before any commit).
node gsd-tools.cjs worktree base-check --observed-fork-base <sha>

# Write worktree.baseRef:"head" into .claude/settings.local.json (no-clobber).
# Returns JSON: { changed, skipped, previous, baseRef, file }
node gsd-tools.cjs worktree set-baseref
```

**`worktree base-check`** reads `worktree.baseRef` from a three-layer cascade — `.claude/settings.local.json`, then `.claude/settings.json`, then the user/global `settings.json` under `CLAUDE_CONFIG_DIR` (or `~/.claude`) — and compares the current `HEAD` SHA against `origin/HEAD`. Project-level settings take precedence over the user/global layer, so a machine-wide `worktree.baseRef:"head"` set via `/config` is honored when no project override exists. The result names the settings layer that produced the value in `baseRefLayer` (`runtime-local`, `runtime-shared`, `runtime-user`, or `null` when `worktree.baseRef` is set nowhere); a layer whose `baseRef` is not a string is skipped. The layer is provenance only: it does not change `shouldDegrade` or `reason`. A settings layer that cannot be read or parsed is skipped, and the resolver now writes its one-time unusable-config warning to stderr for it; stdout and the verdict are unaffected. The `shouldDegrade` field is `true` when the execute-phase orchestrator will fall back to sequential execution. `--mode` declares who creates the isolated worktree (#3659): `harness-worktree` (the default — the runtime harness forks it) or `orchestrator-worktree` (GSD itself runs `git worktree add` with an explicit start-point). `worktree.baseRef:"head"` is honored by the orchestrator by construction and by the Claude Code harness as measured from all three settings layers (#4588; the #48 finding that the harness did not read the setting predates upstream claude-code#54940); Cursor, the other `harness-worktree` host, is unmeasured. With `"head"` set the check does not compare in either mode unless `--observed-fork-base` is given (below), with one further exception under `harness-worktree` and no observation: when a Claude Code `WorktreeCreate` hook is configured in any of the same three settings files, or one of them does not parse, the hook creates the agent worktree and Claude Code does not apply `worktree.baseRef` to it, so the check compares `HEAD` against `origin/HEAD` as if the setting were absent (#4588). The #4868 prior-worktree observation is **not** consulted on that path: a worktree sitting at `HEAD` records nothing about which creator made it, so one the plain harness left there before the hook was configured would read as evidence for the hook (#4881). Pass `--observed-fork-base` for a trusted verdict on a hook host. Hooks from managed policy settings, a `--settings` file, plugins, agent frontmatter or SDK registrations are not visible to the check; the exit-42 guard remains the backstop for those. `--observed-fork-base <sha>` supplies the fork base a worktree created for a dispatch was actually measured to have (`git rev-parse HEAD` inside it, before any commit — a full 40- or 64-hex sha, case-insensitive; abbreviations are refused because the comparison is exact); when given, it replaces the `origin/HEAD` inference as the fork side of the comparison and `"head"` no longer short-circuits — the verdict then reports a measurement, and a mismatch under `"head"` means the worktree was not forked from HEAD despite the setting. Invalid values for either flag fail closed with an error. Possible `reason` values:

| `reason` | `shouldDegrade` | Meaning |
|---|---|---|
| `baseref-head-bypassed-by-hook` | `true` | `worktree.baseRef:"head"` is set under `harness-worktree` with no fork base observed, but a Claude Code `WorktreeCreate` hook is configured in one of the three settings files (or one of them does not parse, so a hook cannot be ruled out), and `HEAD` differs from the inferred fork base. The hook creates the agent worktree and Claude Code does not apply `worktree.baseRef` to it, so the setting is not trusted; `message` names the file (#4588). The #4868 prior-worktree observation does **not** lift it: a worktree sitting at `HEAD` carries no record of which creator left it there, so one the plain harness created before the hook was configured is indistinguishable from one the hook created (#4881). Only `--observed-fork-base` restores a trusted verdict here. The fallback comparison is not a measurement of the hook: when `HEAD` matches the inferred fork base the check does not degrade, and the exit-42 guard remains the backstop. `--observed-fork-base` gives a measured verdict |
| `baseref-head` | `false` | `worktree.baseRef:"head"` is set and no fork base was observed (and, under `harness-worktree`, no `WorktreeCreate` hook was found in the settings files) — the fork base is the orchestrator HEAD in either mode (by construction under `orchestrator-worktree`; under `harness-worktree` as measured on Claude Code, #4588 — Cursor is unmeasured). The spawn-time `worktree-branch-check` exit-42 guard remains the backstop on a host that does not honor it |
| `baseref-head-ignored-by-harness` | `true` | `worktree.baseRef:"head"` is set but the fork base passed via `--observed-fork-base` differs from HEAD — the worktree was not forked from HEAD despite the setting (in either mode), so the run degrades to sequential (#3659, #4588) |
| `observed-fork-matches-head` | `false` | The fork base passed via `--observed-fork-base` equals HEAD (#4588) |
| `fork-from-head-observed` | `false` | Under `harness-worktree` with no `--observed-fork-base`, a clean linked worktree under `.claude/worktrees/agent-*` sits at the current `HEAD` — positive evidence that this host's worktree creator forks from `HEAD` (#4868). Reached only when `"head"` is absent or not `"head"` — with the setting trusted the check returns `baseref-head` first, and under a `WorktreeCreate` hook with `"head"` set the observation is withheld rather than consulted, because it cannot be attributed to the hook (#4881). Cached per `HEAD` in `.gsd/harness-fork-probe.json`; a dirty worktree, one at another commit, none at all, or a git failure is inconclusive and falls through |
| `head-matches-fork` | `false` | HEAD and the inferred fork base (`origin/HEAD`, or its symbolic-ref fallback such as `origin/next` — reported in `forkRef`) are the same commit |
| `head-diverged-from-fork` | `true` | Branch is ahead of or diverged from the fork base — the inferred `origin/HEAD` (or its fallback), or the `--observed-fork-base` value when one was given (`forkRef: "observed"`) |
| `fork-ref-unknown` | `true` | `origin/HEAD` could not be resolved |
| `no-head` | `true` for exit 128, `false` for exit 0 with empty stdout | Exit 128 is git's definitive "no resolvable HEAD here" answer — not a git repository, or a repository with no commits; no harness worktree can be created, so the check degrades to sequential (#4734), with a `message` explaining why. Exit 0 with empty stdout is ambiguous (git completed without a definitive answer) and stays non-degrading (`headAbsenceVerified` distinguishes the two: `true` / `false`) |
| `head-unresolvable` | `true` | `git rev-parse HEAD` did not return a definitive answer (timed out, `git` missing, or any other non-128 failure) — fails closed rather than being treated as `no-head` |

**`worktree set-baseref`** applies a no-clobber write of `worktree.baseRef:"head"` to `.claude/settings.local.json`. If the file already contains an explicit `baseRef` value other than `"head"`, the existing value is preserved and `skipped:"explicit-other"` is returned. Malformed JSON causes an error rather than a silent overwrite. Both fresh installs and upgrades of GSD Core run this automatically when `workflow.use_worktrees` is enabled (the default); the command is also available for manual use — for example, to apply the setting when worktrees were toggled on after installation, or to re-apply it after a settings change.

### Worktree creation

```bash
# Create an agent worktree and atomically record it in the wave cleanup manifest.
# Returns JSON: { ok, reason, entry, manifest_path } (exit 0), or
#   { ok:false, reason, hint } with a non-zero exit on a rejected/failed create.
node gsd-tools.cjs worktree create \
  --manifest <path> --agent-id <id> --path <worktree> --branch <branch> --base <sha> --root <dir> \
  [--files "<space-separated declared paths>"]
```

**`worktree create`** validates and records the manifest entry BEFORE running any git command, then runs `git worktree add` for the validated `{path, branch, base}`, and only on success finalizes the manifest write — a rejected entry or a failed `git worktree add` never leaves a partially-recorded manifest or an unmanifested worktree on disk. `--root` is **mandatory** (#3050): the fail-closed root-confinement check resolves `--path` and `--root` and rejects (`reason:"path_outside_root"`) unless `--path` resolves strictly inside `--root` — this closes a prior gap where an unconfined `--path` (no `--root` check at all) could point a spawned executor's worktree anywhere on the filesystem. Omitting `--root` fails closed with `reason:"root_required"` rather than silently skipping confinement. All other flags share `worktree record-agent`'s validation rules above (`--branch` namespace, non-empty/non-whitespace `--path`/`--branch`/`--base`, `--agent-id` required). It also accepts the same optional `--files` as `record-agent` (#2596). `--files`/`--deletions` values are whitespace-separated: a value containing a comma is rejected with `reason:"comma_joined_scope"` and a hint naming the space separator, before any git command runs and with nothing written (#6510).

### Wave-manifest recording

The execute-phase orchestrator records each spawned executor's worktree identity into a wave cleanup manifest so the matching `cleanup-wave` reader can later merge and remove exactly those worktrees.

```bash
# Append a validated per-agent entry to the wave cleanup manifest.
# Returns JSON: { ok, reason, entry, manifest_path } (exit 0), or
#   { ok:false, reason, hint } with a non-zero exit on a rejected entry.
node gsd-tools.cjs worktree record-agent \
  --manifest <path> --agent-id <id> --path <worktree> --branch <branch> --base <sha> \
  [--files "<space-separated declared paths>"]
```

**`worktree record-agent`** appends one `{agent_id, worktree_path, branch, expected_base}` entry to an already-initialized manifest, validating every field **at write time using the same rules the `cleanup-wave` reader enforces** — `--branch` must match the disposable `^(worktree-)?agent-[A-Za-z0-9._/-]+$` namespace (accepts both `agent-<id>` and legacy `worktree-agent-<id>`), and `--path`/`--branch`/`--base` must be non-empty. `--agent-id` is required (write-strict), even though the reader treats it as optional. A missing or garbled field — or a duplicate `(worktree_path, branch)` the reader would dedup away — fails loudly with a recovery hint and a non-zero exit **without** writing, instead of appending an under-populated or silently-dropped entry. Whitespace-only `--path`/`--base` are rejected (values are trimmed). The on-disk manifest shape is unchanged unless `--files` is supplied (see below); the reader still re-derives `allowed_bases`, and the orchestrator still initializes the empty `{orchestrator_root, worktrees: []}` shell inline before any agent is recorded. `--files`/`--deletions` values are whitespace-separated: a value containing a comma is rejected with `reason:"comma_joined_scope"` and a hint naming the space separator, and nothing is written (#6510).

`--files` is optional (#2596). When supplied it records the plan's declared `files_modified` — the same whitespace-separated `PLAN_FILES` list the per-plan worktree gate already builds — as an extra `files_modified` array on the entry, and `cleanup-wave` then reports any path the branch committed outside it. A blank or omitted `--files` writes no field at all, leaving the 4-field on-disk shape untouched, and the scope check is simply skipped for that entry: an unrecorded scope means *unknown*, never *declares nothing*. Values are compared against a diff, never opened as paths and never passed to a shell.

`--deletions` is optional (#3003). When supplied it records the plan's declared `files_deleted` — built by the per-plan worktree gate exactly like `PLAN_FILES`, from the plan's own frontmatter — as a `declared_deletions` array on the entry. It is the opt-in the deletions guard reads (see below). A blank or omitted `--deletions` writes no field, leaving the on-disk shape untouched and the guard's original unconditional block in force. Like `--files`, values are compared against a diff and never opened or passed to a shell.

**Intentional deletions (gate, #3003)**

`cleanup-wave` blocks the merge of any executor branch whose diff deletes a file — a net against a mass-deletion accident. A plan whose scope legitimately includes removing a file declares those paths in its `files_deleted` frontmatter, which reaches the entry as `declared_deletions`; the guard then blocks only the deletions **not** in that list.

| Branch deletes | Entry declares | Result |
|---|---|---|
| nothing | — | merges |
| `tests/a.ts` | *(no field)* | **blocked** — unchanged pre-#3003 behavior |
| `tests/a.ts` | `["tests/a.ts"]` | merges |
| `tests/a.ts`, `src/b.ts` | `["tests/a.ts"]` | **blocked**, and the block detail names only `src/b.ts` |
| `tests/a.ts` | `["tests"]` | **blocked** — a directory does not authorize its children |
| `tests/a.ts` | `["*.ts"]` | **blocked** — globs are literal paths here, matching nothing |

Matching is **exact after normalization**: git's C-quoting is decoded, backslashes become forward slashes, and a leading `./` and any trailing `/` are stripped — on both sides. The decode matters more than it looks: with `core.quotepath` at its git default, a path like `tests/é.ts` is reported as the literal `"tests/\303\251.ts"`, which would never compare equal to the plainly-declared path, so a correctly declared deletion of any non-ASCII path would block forever with nothing pointing at the encoding. It is deliberately neither a prefix nor a glob match — either would let one declaration authorize a whole set of deletions, which is the accident the guard exists to catch. A declared path that was not in fact deleted is inert. A blocked entry still isolates: the rest of the wave proceeds (#2852). If the deletion check itself fails the entry blocks on `deletion_check_failed` and is never filtered — a broken check is not an authorization.

A declared deletion is also treated as in-scope by the advisory below, so authorizing a removal does not then warn that the removed path was out of the declared scope. That is done by **subtracting** declared deletions from the advisory's findings, not by adding them to the declared scope it matches against — the advisory reads its scope list with prefix-and-glob semantics, so adding them would quietly give `declared_deletions` a second, wider matching rule than the table above, and `["*.md"]` would go from inert to silencing the advisory entirely. One field, one matching rule, on every surface. Subtraction also means the advisory's activation is unchanged: it still runs only when `files_modified` is recorded, so a plan that declares deletions alone stays as silent as it was before #3003.

One limit worth knowing, shared with `--files` and failing closed: a declared path containing a **space** cannot be expressed, because the flag value is whitespace-separated — such a path splits into fragments, matches nothing, and the entry blocks. Flag values are also read positionally and, apart from the documented comma rejection (#6510), never re-inspected for shape, so a malformed `--deletions --files src/a.ts` records the literal `--files` as the declaration; that is harmless (it is a path git never reports as deleted, so it authorizes nothing) and `--files` still resolves to `src/a.ts` on its own lookup.

**Scope conformance at merge (advisory, #2596)**

When a manifest entry carries a declared `files_modified`, `cleanup-wave` compares the branch's actual committed diff (`HEAD...<branch>`) against it and appends one entry to the result's `warnings` array for every path outside the declared scope, with `code: "scope_out_of_declared"` and the offending `path`. If the diff itself cannot be computed the entry gets a single `code: "scope_check_unavailable"` warning instead, so an unknown result is never mistaken for a clean one. Warnings are also aggregated on the top-level `warnings` array, each tagged with its `branch`.

This is advisory: it does not change `ok`, `reason`, the per-entry `status`, or the exit code, and the merge proceeds either way. Promotion to a hard gate would be a separate, disclosed change.

Two deliberate limits keep it from crying wolf. `.planning/**/*SUMMARY.md` paths are always exempt — the executor writes a SUMMARY by orchestration contract and no plan declares it. Glob patterns are matched by their literal prefix only, so `src/**/*.ts` covers everything under `src/`, and a pattern with no literal prefix (`*.md`) suppresses warnings for that entry rather than reporting every file.

**Merge timeout and a killed merge's residue (#4721)**

The merge step is the one git call in `cleanup-wave` that runs the commit-family hooks (`pre-merge-commit`, `prepare-commit-msg`, `commit-msg`, `post-merge`), so it runs under its own budget — 10 minutes by default (`DEFAULT_MERGE_TIMEOUT_MS`; `deps.mergeTimeoutMs` for callers of the module) — rather than the 10-second timeout every other git call in the wave keeps. (`worktree add` runs `post-checkout` and every ref update runs `reference-transaction`; those are plumbing-cheap and stay on the default.) A repo whose pre-merge hook is a test-suite gate therefore merges instead of being killed mid-hook.

When the merge does exceed its budget the entry blocks on `reason: "merge_timed_out"`, and its `stderr` names the budget, says the hook may still be running, and labels whatever the hook had printed as output before the kill — instead of the old `merge_failed`, which carried that partial output as though it were git's own error. `merge_failed` is otherwise unchanged — a merge git refused, one that conflicted, or one killed by a signal from outside (which the seam reports with the signal, not as a timeout; that case still takes the restore below).

A merge killed while its hook runs has already staged the merged tree into the primary checkout's index but never wrote `MERGE_HEAD`, so `git merge --abort` finds nothing and the mid-merge check (#2852) reads the primary as clean. Left there, a plain `git commit` from the primary would squash the executor's history into a single-parent commit. After a merge that was **killed** — at its budget, or by a signal from outside — and only then, `cleanup-wave` reads the index, runs `git reset --merge` (which restores exactly the paths the merge staged and keeps unrelated unstaged edits), and re-reads it. Each restored path is reported as a `code: "merge_residue_restored"` warning and the wave continues. If the index is still dirty afterwards, or cannot be read at all, each remaining path (or a single `path: null` when the read itself failed) is reported as `code: "merge_residue_left_staged"` and the remaining entries are moved to `pending` — the same repo-level halt an unfinished merge triggers, because every later merge would run against that dirty index.

The kill gate is what makes the staged set attributable to the merge. A merge git *refuses* (`error: Your local changes to the following files would be overwritten by merge`) is the immediate exit a pre-existing dirty index earns, and it leaves that index untouched; on that path nothing is read or reset, because anything staged is your own work. The one exception is `merge.autoStash`: git then parks your staged work in `MERGE_AUTOSTASH` and starts anyway, and a merge killed before `MERGE_HEAD` exists never re-applies it. `git reset --merge` moves that autostash into the stash list, and `cleanup-wave` then runs `git stash pop --index` to put it back with its staged state intact. If the pop fails, or the autostash state could not be determined, the entry carries a `code: "merge_autostash_unrestored"` warning (`path: null`) and your work stays in `git stash list`; the index is then re-read, and the wave continues only if it is clean — a pop that left conflict entries behind halts the remaining entries as `merge_residue_left_staged`, since the next merge would fail on unmerged files. A kill that lands once `MERGE_HEAD` exists (inside `commit-msg`, say) is the ordinary abort path: `git merge --abort` restores the tree and re-applies an autostash itself — unstaged, as git does for any aborted autostashed merge — and the residue step finds nothing to do.

Known limit: the kill terminates `git`, not the hook process it spawned. A hook that keeps running and itself stages files after the wave has verified the index clean can re-dirty the primary; the `merge_timed_out` detail says so, and a hook that takes minutes belongs under a larger `mergeTimeoutMs`, not under this recovery.

---

## Graphify

Build, query, and inspect the project knowledge graph in `.planning/graphs/`. Requires `graphify.enabled: true` in `config.json` (see [Configuration Reference](CONFIGURATION.md#graphify-settings)).

```bash
# Build or rebuild the knowledge graph
node gsd-tools.cjs graphify build

# Search the graph for a term
node gsd-tools.cjs graphify query <term>

# Show graph freshness and statistics
node gsd-tools.cjs graphify status

# Show changes since the last build
node gsd-tools.cjs graphify diff

# Write a named snapshot of the current graph
node gsd-tools.cjs graphify snapshot [name]
```

User-facing entry point: `/gsd-graphify` (see [Command Reference](COMMANDS.md#gsd-graphify)).

---

## Knowledge Store, Research Cache and Resolver Commands

Every verb below is invoked as `node gsd-tools.cjs <verb> [args]` or `node gsd-tools.cjs query <verb> [args]`; the dotted manifest names (`learnings.list`) and the spaced forms (`learnings list`) are both accepted. Output is JSON unless stated; the [global flags](#command-flags-and-the-cli-surface-manifest) apply.

### `learnings` — the global knowledge store

Learnings are JSON records in `~/.gsd/knowledge/<id>.json` (one file per learning), shared across projects. Each record carries `id`, `source_project`, `date`, `context`, `learning`, `tags` and `content_hash` (SHA-256 of the learning text plus the source project; a second write with the same hash is skipped).

| Verb | Arguments | Output | Behavior |
|------|-----------|--------|----------|
| `learnings list` | none | `{learnings, count}` | Every record, newest first. A malformed file is skipped with a warning on stderr. |
| `learnings query --tag <tag>` | `--tag` required | `{learnings, count, tag}` | Records whose `tags` array contains `<tag>` exactly, newest first. |
| `learnings copy` | none | `{total, created, skipped}` | Copies the current project's learnings into the store. Reads the most recently modified `.planning/phases/*/*-LEARNINGS.md`, falling back to `.planning/LEARNINGS.md`; returns zeros when neither exists. Each `###` item under a `##` category becomes one record (a `##` section with no `###` items becomes one record); tags are the first word of the category plus the words of the item title longer than two characters. `source_project` is the name of the directory that contains `.planning`. Records whose hash is already stored count as `skipped`. |
| `learnings prune --older-than <Nd>` | `--older-than` required, format `<digits>d` (for example `90d`) | `{removed, kept}` | Deletes records older than `N` days. Any other format exits with `Invalid duration format`. |
| `learnings delete <id>` | the record id (`<base36>-<hex>`) | `{id, deleted}` | Deletes one record; `deleted` is `false` when no such file exists. An id that does not match `^[a-z0-9]+-[a-f0-9]+$` exits with `Invalid learning ID`. |

```bash
node gsd-tools.cjs learnings copy
node gsd-tools.cjs learnings query --tag testing
node gsd-tools.cjs learnings prune --older-than 90d
```

### `research-plan`, `research-store get`, `research-store put` — the research cache

The research cache keeps fetched research so a repeated question is not fetched again. A key is a 64-character lowercase hex SHA-256 of the lower-cased, trimmed `ecosystem`, `library`, `version`, `query` and `kind`; `research-plan` computes it, and the store rejects any other key shape.

`research-plan --input <file>` reads a JSON file `{"questions": [{"text", "kind", "library"?, "version"?}], "ecosystem"?}` and prints `{items: [{question, key, cache?, fetch?}]}`. A question with a fresh cache entry yields `{question, key, cache: {hit: true, stale: false}}` and no `fetch`. A cache miss yields `{question, key, fetch: {provider, query}}`; a stale entry yields the same plus `cache: {hit: true, stale: true}`. A question whose `text` is missing or empty is dropped from `items`. `fetch.provider` is the first available provider in the waterfall for the question's `kind`: `docs` → `context7`, `ref`, `jina`, `websearch`; `web` → `exa`, `tavily`, `perplexity`, `brave`, `serply`, `websearch`; `scrape` → `firecrawl`, `jina`. Any other `kind` uses the `web` waterfall, and `websearch` is the fallback. `context7`, `jina` (unless the `jina` config value is falsy) and `websearch` are always available; `exa`, `tavily`, `brave`, `firecrawl`, `ref`, `perplexity` and `serply` are available when the config keys `exa_search`, `tavily_search`, `brave_search`, `firecrawl`, `ref_search`, `perplexity` and `serply_search` respectively are truthy.

| Verb | Arguments | Output |
|------|-----------|--------|
| `research-store get <key> [--kind <k>]` | 64-hex key; `--kind` optional | `{hit, stale, entry}`; `entry` is `null` on a miss and for a key that is not 64-hex. Both tiers are searched, whatever the entry's source. A file that is not valid JSON, or whose `fetched_at` or `ttl` is invalid, is a miss |
| `research-store put <key> --content <text> --source <s> --provider <p> --kind <k> --confidence <level>` | all five flags required | the stored entry `{content, source, provider, confidence, fetched_at, ttl, kind}` |

`--content` is stored as the string given (a JSON argument is not parsed). The entry lives at `<key>.json` in one of two tiers, chosen by `--source`: `curated` entries go to the user tier `~/.gsd/research-cache/`, every other source to the project tier `.planning/research/.cache/`. The `ttl` is 30 days for `curated` with confidence `HIGH`, 7 days for `curated` with `MEDIUM`, and 1 day otherwise; `stale` is `true` once the entry is older than its `ttl`.

### `classify-confidence`

```bash
node gsd-tools.cjs query classify-confidence --provider <id> [--package <name> --ecosystem <npm|pypi|crates>] [--verified]
```

| Flag | Required | Description |
|------|----------|-------------|
| `--provider <id>` | Yes | The research provider that produced the finding |
| `--package <name>`, `--ecosystem <npm\|pypi\|crates>` | Together or not at all | Look up the package's legitimacy verdict (`OK`, `SUS`, `SLOP`) on its registry and use it as ground truth; giving only one of the two is a usage error |
| `--verified` | No | The finding was corroborated against the official source |

Output: `{provider, package, ecosystem, legitimacyVerdict, verified, confidence}`, with `confidence` one of `HIGH`, `MEDIUM`, `LOW`. Provider authority: `context7` and `ref` are `official`; `jina` and `firecrawl` are `scrape`; `exa`, `tavily`, `perplexity`, `brave`, `serply` and `websearch` are `web`; any other id is `none`. The first matching rule wins:

| Rule | Confidence |
|------|------------|
| verdict is `SLOP` | `LOW` |
| verdict is `OK` and authority is not `none` | `HIGH` |
| authority is `official` or `scrape` | `MEDIUM` |
| verdict is `OK` (authority `none`) | `MEDIUM` |
| authority is `web` and `--verified` | `MEDIUM` |
| anything else | `LOW` |

### `resolve-package-manager <script>`

Prints, as plain text, the command that runs package script `<script>` with the project's package manager, or nothing when `<script>` is not a plain identifier (`[A-Za-z0-9_][A-Za-z0-9:_-]{0,63}`). The manager is the `packageManager` field of `package.json` (read only when the file is at most 1 MiB), else the first lockfile found in the order `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, `bun.lockb`, else `npm`. `test` prints `<manager> test` except under `bun`; every other case prints `<manager> run <script>`.

### `resolve-granularity <phase-type> [--granularity <coarse|standard|fine>]`

Resolves the planning granularity for a phase type. Precedence: the `--granularity` override (an invalid value exits with `invalid granularity`), then `granularities.<phase-type>` in config, then top-level `granularity`, then `planning.granularity`, then `standard`. Output: `{granularity, phase_type}`, plus `unknown_phase_type: true` when `<phase-type>` is not one of `planning`, `discuss`, `research`, `execution`, `verification`, `completion`. The phase type is required.

### `user-story.validate --story "<text>"`

Checks a user story against `As a [role], I want to [capability], so that [outcome].` Output: `{valid, errors, slots}`, where `slots` is `{role, capability, outcome}` when valid and `null` otherwise. Each failed requirement adds one entry to `errors`: the `As a` opening, the `, I want to` clause, the `, so that` clause, a non-empty value in each slot, and a closing period.

### `project-instruction-file [--runtime <id>]`

Prints, as plain text, the project instruction file a runtime reads: `.claude/CLAUDE.md` for `claude`, `.github/copilot-instructions.md` for `copilot`, `.trae/rules/rules.md` for `trae`, `GEMINI.md` for `antigravity`, and `AGENTS.md` for every other runtime and when `--runtime` is omitted. The retired runtime `gemini` is refused with an error that names its replacement.

## Module Architecture

| Module | File | Exports |
|--------|------|---------|
| Core | `lib/core.cjs` | `error()`, `output()`, `parseArgs()`, shared utilities, compatibility re-exports |
| State | `lib/state.cjs` | All `state` subcommands, `state-snapshot` |
| Phase | `lib/phase.cjs` | Phase CRUD, `find-phase`, `phase-plan-index`, `phases list` |
| Planning Workspace | `lib/planning-workspace.cjs` | Planning seam: `planningDir`, `planningPaths`, active workstream routing, `.planning/.lock` |
| Roadmap | `lib/roadmap.cjs` | Roadmap parsing, phase extraction, progress updates |
| Config | `lib/config.cjs` | Config read/write, section initialization |
| Verify | `lib/verify.cjs` | All verification and validation commands |
| Template | `lib/template.cjs` | Template selection and variable filling |
| Frontmatter | `lib/frontmatter.cjs` | YAML frontmatter CRUD |
| Init | `lib/init.cjs` | Compound context loading for all workflows |
| Milestone | `lib/milestone.cjs` | Milestone archival, requirements marking |
| Commands | `lib/commands.cjs` | Misc: slug, timestamp, todos, scaffold, stats, websearch |
| Model Profiles | `lib/model-profiles.cjs` | Profile resolution table |
| UAT | `lib/uat.cjs` | Cross-phase UAT/verification audit |
| Profile Output | `lib/profile-output.cjs` | Developer profile formatting |
| Profile Pipeline | `lib/profile-pipeline.cjs` | Session analysis pipeline |
| Graphify | `lib/graphify.cjs` | Knowledge graph build/query/status/diff/snapshot (backs `/gsd-graphify`) |
| Learnings | `lib/learnings.cjs` | Extract learnings from phases/SUMMARY artifacts (backs `/gsd-extract-learnings`) |
| Audit | `lib/audit.cjs` | Phase/milestone audit queue handlers; `audit-open` helper |
| GSD2 Import | `lib/gsd2-import.cjs` | Reverse-migration importer from GSD-2 projects (backs `/gsd-import --from-gsd2`) |
| Intel | `lib/intel.cjs` | Queryable codebase intelligence index (backs `/gsd-map-codebase --query`) |
| Context Predicates | `lib/context-predicates.cjs` | `CONTEXT.md` predicate fact-store parser/selector (ADR-1671, #2928) — backs `query context-predicates` and `scripts/gen-context-index.cjs`'s `docs/CONTEXT-INDEX.json` drift guard |
| Capability State | `lib/capability-state.cjs` | Capability-state resolver — composes install profile, surface, and config into per-capability `enabled`/`active` view |
| Capability Writer | `lib/capability-writer.cjs` | Capability-state writer (ADR-1213) — write-side inverse; projects `--on`/`--off`/`--gate` onto surface + config substrates then re-resolves |
| Worktree Base Ref | `lib/worktree-base-ref.cjs` | Worktree fork-base detection and `worktree base-check` / `set-baseref` commands (#683) |

---

## Reviewer CLI Routing

`review.models.<cli>` maps a reviewer flavor to a bare model id injected into the CLI's `--model` (or `-m`) flag by the code-review workflow. Set via [`/gsd-config --integrations`](COMMANDS.md#gsd-config) or directly:

```bash
node gsd-tools.cjs config-set review.models.codex    "gpt-5"
node gsd-tools.cjs config-set review.models.agy      "gemini-3.1-pro-preview"
node gsd-tools.cjs config-set review.models.opencode "claude-sonnet-4"
node gsd-tools.cjs config-set review.models.claude   ""   # clear — fall back to session model
```

Slugs are validated against `[a-zA-Z0-9_-]+`; empty or path-containing slugs are rejected. See [`docs/CONFIGURATION.md`](CONFIGURATION.md#code-review-cli-routing) for the full field reference.

## Secret Handling

API keys configured via `/gsd-settings` (`brave_search`, `firecrawl`, `exa_search`) are written plaintext to `.planning/config.json` but are masked (`****<last-4>`) in every `config-set` / `config-get` output, confirmation table, and interactive prompt. See `gsd-core/bin/lib/secrets.cjs` for the masking implementation. The `config.json` file itself is the security boundary — protect it with filesystem permissions and keep it out of git (`.planning/` is gitignored by default).

---

## Related

- [Commands](COMMANDS.md)
- [Configuration](CONFIGURATION.md)
- [Architecture](ARCHITECTURE.md)
- [Fix the worktree base-mismatch (exit 42) error](how-to/fix-worktree-base-mismatch.md)
- [docs index](README.md)
