# ADR-4962: Per-session pause — the handoff file is the marker, the role is the identity [Proposed]

- **Status:** Proposed — ratified to `Accepted` when the ratification conditions below are met.
- **Date:** 2026-11-27
- **Issue:** [#4962](https://github.com/open-gsd/gsd-core/issues/4962) (this ADR); the feature it governs is [#4845](https://github.com/open-gsd/gsd-core/issues/4845) (`approved-feature`, condition 1 of its triage verdict).
- **Builds on:** [ADR-3408](3408-state-write-path-preservation.md) (STATE.md write seam and the field-preservation classification that makes a legacy `paused_at` immortal), [ADR-1769](1769-state-md-transition-module.md) (the Transition Module that preserves it), [ADR-857](857-capability-system.md) (the core-versus-Capability line this ADR places pause/resume on).
- **Does not touch:** `STATUS_LIFECYCLE_ENUM` (`src/state-md-schema.cts`) and `normalizeStateStatus` (`src/state-document.cts`) — `paused` stays a valid status value. [ADR-3408](3408-state-write-path-preservation.md) §8.3's closed list of two sanctioned-permanent exceptions is not amended.
- **Supersedes:** nothing.

## Context

GSD assumed one session per project. Pause and resume followed from that assumption in three ways, and each breaks as soon as two sessions share one `.planning/`:

1. **One shared handoff name.** `gsd-core/workflows/pause-work.md` writes the project-wide `.planning/HANDOFF.json` and `.continue-here.md`. A second session that pauses overwrites the first session's handoff. `gsd-core/workflows/resume-project.md` reads that same path and deletes it as a one-shot artifact, so a session that resumes also destroys the handoff another session wrote.
2. **A project-wide pause marker.** "Paused" is derived from STATE.md's `paused_at` (`src/smart-entry.cts` `paused`, `gsd-core/workflows/next.md` Route 8, `normalizeStateStatus`). [ADR-3408](3408-state-write-path-preservation.md)'s classification table declares `paused_at` `preserve-when-unchanged`, and no shipped workflow clears it. Once any agent or older STATE.md puts the field there, every session on that `.planning/` reads as `PAUSED` with no GSD path back out. Conversely, a pause written by the shipped workflow sets no `paused_at`, so `smart-entry` reports `signals.paused: false` (reproduced on 1.19.0 in [#4845's comments](https://github.com/open-gsd/gsd-core/issues/4845)).
3. **Keying by session id alone does not recover.** `/clear` and restarts issue a new session id. A resuming session never recognizes a handoff as its own, nothing is deleted, and stale `HANDOFF*.json` files accumulate (18+ observed in one repository).

Workstreams do not cover this. A workstream isolates a *milestone area* (`.planning/workstreams/<name>/`, REQ-WS-01); handoffs are written to the project-root `.planning/`, and two sessions on the **same** workstream are indistinguishable.

Nothing in the tree states why the fix is shaped as it is. Those reasons are re-derivable from a diff, not from the docs. This ADR records them so the implementation PRs cite a decision rather than re-argue one.

## Decision

### 1. Pause is per session, and the marker is the handoff file

"This session is paused" means "a handoff file that belongs to this session exists under `.planning/`". No shipped workflow writes `paused_at` or sets `status: paused`.

*Failure prevented:* one session's pause marking every other session `PAUSED`, with no way to clear it, because the marker was a project-wide field that nothing owned clearing.

### 2. The role is the identity; the session id is the fallback; the legacy name still resolves

A **role** is an optional free-text label a human gives a session (any string). `role_id` is its ASCII slug. GSD assigns no roles. A role survives `/clear`; a session id does not.

Filename grammar — `src/session-store.cts` is the single owner (Decision 7):

| Form | Written by | Meaning |
|---|---|---|
| `HANDOFF.latest.<role_id>.json` + `.continue-here.latest.<role_id>.md` | pause, session with a role | one slot per role, overwritten by that role's next pause |
| `HANDOFF.<session_id>.json` | pause, role-less session | belongs to that session id |
| `HANDOFF.claimed.<role_id>.<session_id>.json` | resume, mid-claim | a session holds this role's handoff |
| `HANDOFF.json` + `.continue-here.md` | legacy | still resumable; any session may claim it |

The grammar reserves `latest`, `claimed` and `json` as first segments (`json` was added when #6796 implemented the store: without it `HANDOFF.json.json` would parse as a session named `json` next to the legacy `HANDOFF.json`). A session id whose first segment is reserved is escaped by the store before it is used in a filename, so `HANDOFF.latest.x.json` always parses as role `x`, never as session `latest.x`. Ownership is decided by the **filename** for role-keyed and session-keyed files. A body-recorded `role_id` — read only when it is already a valid slug, so a hook-side follower that cannot transliterate free text reads it identically (#6797); a free-text `role` is not read — is consulted only for a legacy unkeyed file, so two live sessions that share a role label cannot unlink each other's session-keyed handoff.

*Failure prevented:* a handoff nobody can recognize after `/clear` (the session-id-only design, implemented first and rejected), and cross-deletion between sessions that merely share a label.

### 3. Resume claims by atomic rename before reading

`resume-project.md` renames `HANDOFF.latest.<role_id>.json` to `HANDOFF.claimed.<role_id>.<session_id>.json` **before** reading it. Rename is atomic on one filesystem, so exactly one of two racing sessions succeeds. The loser finds no `.latest` file and is told so. The consumed files are then removed, and committed when `commit_docs` is on.

*Failure prevented:* two sessions resuming the same role and both acting on one handoff. A lock file would add a second artifact that can itself go stale; the rename needs none.

### 4. Session identity comes from `--session` or a runtime-issued env key — never the terminal

The session id resolves from `--session`, else from the first set key of `WORKSTREAM_SESSION_ENV_KEYS` (`src/active-workstream-store.cts`) in that list's own order, with the terminal-identity keys removed: `GSD_SESSION_KEY`, `CODEX_THREAD_ID`, `CLAUDE_SESSION_ID`, `CLAUDE_CODE_SESSION_ID`, `OPENCODE_SESSION_ID`, `GEMINI_SESSION_ID`, `CURSOR_SESSION_ID`, `WINDSURF_SESSION_ID`. The store derives its list from the workstream list (a parity test pins it) instead of copying it, so one session never gets different ids for its workstream pointer and its handoff. The terminal-identity keys (`TERM_SESSION_ID`, `WT_SESSION`, `TMUX_PANE`, `ZELLIJ_SESSION_NAME`, `CLAUDE_CODE_SSE_PORT`) and the controlling-TTY probe are excluded. With no `--session` and no runtime key, the verbs report `session_id: null` and delete nothing.

This deliberately **narrows** `getWorkstreamSessionKey()` for this module's own use. That function falls back to a terminal token because a workstream pointer wrongly shared by two panes is recoverable. Here a wrong "this is mine" deletes another session's handoff, and two panes of one terminal are two sessions.

*Failure prevented:* a session unlinking a handoff that belongs to a different session in the same terminal multiplexer.

### 5. `paused` / `paused_at` stay in the schema; the legacy value is repaired, never silently dropped

The STATE.md schema, `STATUS_LIFECYCLE_ENUM` and `normalizeStateStatus` are unchanged. Because [ADR-3408](3408-state-write-path-preservation.md) classifies `paused_at` as `preserve-when-unchanged` and [ADR-1769](1769-state-md-transition-module.md)'s Transition Module preserves it, a legacy value cannot be cleared by an ordinary write. `state session-resume` repairs a legacy **frontmatter-only** `status: paused` from the body `Status:` line, and only when no `Paused At:` line claims it. The repair runs through the ordinary write seam (`readModifyWriteStateMd`), declaring the one field through that function's own intent-first `authoritativeFm` option. It reports `status.before` / `status.after` / `status.cleared`, and declines with a reported reason whenever the case is ambiguous.

`authoritativeFm` is not an [ADR-3408](3408-state-write-path-preservation.md) §8.3 exception. §8.3's sanctioned-permanent list is closed at two entries (`state sync`, `REGENERATE_STATE`), whose shared contract is that the body wins wholesale. This ADR does not add a third and does not amend §8.3.

*Failure prevented:* an unclearable `PAUSED` for a project whose STATE.md already carries the legacy field, without weakening the preservation contract for every other field.

### 6. Three advisory primitives, one boundary each

| Primitive | Key | Solves | Does not solve |
|---|---|---|---|
| Workstream store (`src/active-workstream-store.cts`) | session key, falling back to terminal | which **milestone area** a session works in | two sessions on one area; handoffs |
| `milestone.lock` (`src/milestone-lock.cts`, #3311) | `(phase, session)` with a TTL | two sessions advancing **different phases** of one milestone | pause state; resuming |
| Session store (`src/session-store.cts`, this ADR) | `role_id`, else session id | **whose handoff** a session may resume; who is paused | phase ownership; workstream selection |

All three are advisory: best-effort fs operations that never throw into a CLI command, warn rather than steal. A new coordination problem picks the primitive whose key matches what it must distinguish; it does not add a fourth without an ADR. No ADR governs `milestone.lock`; this table states its boundary without recording a decision on its behalf.

### 7. `src/session-store.cts` owns the filename grammar; any hook-side copy is named and held to it by a parity guard

Hooks cannot require the compiled CLI (the #3582 no-new-require seam), so a reader exists outside the module: the statusline's inline `readHandoffs` (`hooks/gsd-statusline.js`). The `.continue-here` lookup in `hooks/lib/` that the proposal named does not exist on `next` and has no consumer, so none was built (#6797); a future one is a registry row plus a test. The copy is sanctioned and named in `CONTEXT.md` as a follower of the module. A follower that runs on every prompt may bound the entries it reads (the statusline reads at most 64 handoff files per render, the caller's own candidates first, and reports `others` as a count of readable entries within that bound); the parity guard covers the grammar, identity and ownership, not that bound. A **parity guard** holds them to it: one shared case table (filename, body, session id, role → expected `kind`, `role_id`, `is_self`), run against the store and each follower, and it fails when a reader is added without being registered in that table.

*Failure prevented:* generative fix divergence. The first implementation attempt shipped a statusline reader and a store reader that disagreed on the same directory (`state sessions` reported `is_self: true` while the statusline showed `⏸1`).

### 8. Core, not a Capability

[ADR-857](857-capability-system.md) names the five-step loop plus shared-infrastructure skills as the privileged core. Pause and resume are not on its enumerated list, so this is a decision, not a given. They are core because: the state a Capability would own is the project's own `.planning/` handoff, which the core `progress` / `next` routing and the `state` CLI read in every project; a Capability that is off removes the only recovery path for a session that ran out of context (the context-monitor CRITICAL breadcrumb writes through the same verb); and the change is a file-naming change inside two existing core workflows, not an optional feature with its own surface.

### 9. Role text never reaches a shell as code

A role is free text and reaches workflow shell fences from the user (or a repo role registry). Workflows capture it once through a quoted heredoc and pass it as `"$role"`; `role_id` is derived by the CLI, never by workflow prose. Handoff reads are bounded regular-file reads and `lstat`-checked; writes refuse a symlinked target. Inputs under `.planning/` are hostile per `CONTRIBUTING.md`.

*Failure prevented:* `$(...)`, backticks or a double quote in a role label executing or breaking out of a workflow fence; a planted symlink redirecting a session record write.

## Consequences

- Two `state` verbs become permanent CLI surface: `session-resume` and `sessions` (read-only), plus `--session` / `--role` / `--role-id` on `record-session`. Output of `record-session` without `--session` is byte-identical to before.
- Shipped workflows stop setting `paused_at`. A project that relied on GSD writing it sees `paused` derived from the handoff file instead.
- `.planning/sessions/<session_id>.json` is a new artifact, written alongside — not instead of — the STATE.md `## Session` block.
- A third advisory primitive exists. Decision 6's table is the cost control for "which one do I use".
- Docs owed by the implementation: `docs/features/session-management.md` (REQ-SESSION-01/02/06 describe the single `HANDOFF.json`), `docs/reference/state-md.md`, `docs/reference/planning-artifacts.md`, `docs/CLI-TOOLS.md`, a how-to for running two sessions with roles, and the i18n mirrors that reference `HANDOFF.json`.

## Implementation phases

The implementation of [#4845](https://github.com/open-gsd/gsd-core/issues/4845) is split so each decision lands in one reviewable PR:

| Phase | Issue | Decisions it implements |
|---|---|---|
| 1 — session store, `state` verbs, shared parity case table | [#6796](https://github.com/open-gsd/gsd-core/issues/6796) | 2, 4, 5, 9 (store side) |
| 2 — statusline, context-monitor, `smart-entry`, parity guard | [#6797](https://github.com/open-gsd/gsd-core/issues/6797) | 1 (readers), 7 |
| 3 — `pause-work` / `resume-project` / `next` workflows, docs, ratification | [#6798](https://github.com/open-gsd/gsd-core/issues/6798) | 1 (writers), 3, 9 (workflow side), 8 |

## Rejected alternatives

| Alternative | Why not |
|---|---|
| Keep project-wide pause and add a lock | still one handoff per repository; does not survive `/clear` |
| Session-id-keyed files only | the id changes on every `/clear`, so files were never reclaimed (implemented first, rejected) |
| One workstream per session | workstreams isolate areas, not sessions on one area; handoffs are not workstream-scoped |
| Terminal / tmux-derived identity | two panes of one terminal are two sessions; a wrong guess deletes another session's handoff |
| A lock file for the claim | a second artifact that can itself go stale; atomic rename needs none |
| A Capability under ADR-857 | see Decision 8 |

## Ratification conditions

This ADR moves from `Proposed` to `Accepted` when all of these hold on `next`:

1. `src/session-store.cts` exists and exports the grammar named in Decision 2.
2. `state session-resume` and `state sessions` ship with tests that run the real verbs against a temp `.planning/`.
3. The parity guard from Decision 7 is in CI and fails when a follower reader is added without a row in the shared case table.
4. The shipped `pause-work.md` and `resume-project.md` write and claim the filenames in Decision 2 and 3, and no shipped workflow writes `paused_at`.
5. `docs/features/session-management.md` describes the per-session model.

The ratifying PR edits only this file's `Status` line and the generated index.
