---
name: gsd-mempalace-capture
description: "File a phase artifact into MemPalace; mirror decision facts into its temporal KG"
argument-hint: "[CONTEXT.md|PLAN.md|SUMMARY.md]"
allowed-tools:
  - Read
  - Bash
---


**STOP -- DO NOT READ THIS FILE. You are already reading it. This prompt was injected into your context by the command system. Using the Read tool on this file wastes tokens. Begin executing Step 0 immediately.**

## Step 0 -- Banner

**Before ANY tool calls**, display this banner:

```
GSD > MEMPALACE CAPTURE
```

Then proceed to Step 1.

## Step 1 -- Config Gate

Check whether the MemPalace capability is enabled by reading `.planning/config.json` directly with the Read tool.

1. Read `.planning/config.json` with the Read tool.
2. If the file does not exist, or `config.mempalace` is absent, or `config.mempalace.enabled !== true`, or `config.mempalace.capture_artifacts !== true`: display the disabled message and **STOP**.
3. Otherwise proceed to Step 2.

**Disabled message:**

```
GSD > MEMPALACE CAPTURE

MemPalace capture is disabled (mempalace.enabled / mempalace.capture_artifacts).
Nothing was filed; the loop proceeds normally.
```

This step is `onError: skip` at `discuss:post` / `plan:post` / `verify:post` -- capture never fails a phase.

## Step 2 -- Resolve target

1. **Artifact.** Take the artifact from `$ARGUMENTS`. If absent, infer from the loop point: `discuss:post` → `CONTEXT.md`, `plan:post` → `PLAN.md`, `verify:post` → `SUMMARY.md`.
2. **Room.** Map artifact → room:
   - `CONTEXT.md` → `decisions`
   - `PLAN.md` → `planning`
   - `SUMMARY.md` → `milestones`
   (Confirmed problem→fix pairs go to `problems` — see the `capture-problems` fragment used at `execute:wave:post`.)
3. **Wing.** `config.mempalace.wing` if non-empty, else `config.project_code`, else the repo directory name.
4. **Mode / transport.** Read `config.mempalace.memory_mode`. Prefer MCP (`mempalace_*`) when your MemPalace MCP server is registered and your runtime permits those tools; otherwise use the `mempalace` CLI (covered by this skill's `Bash` allow-tool), as in `mempalace-recall`.

## Step 3 -- File verbatim (idempotent)

On any error or timeout, stop and let the phase continue -- capture is best-effort.

1. **Dedup first.** Interactive: `mempalace_check_duplicate` on the artifact's deterministic drawer id. Headless: rely on `mempalace mine`'s content-hash idempotency.
2. **Add the drawer (verbatim).** File the exact artifact text into `room: <room>` of `wing: <wing>` with provenance (`source_file`, phase id). Interactive: `mempalace_add_drawer`. Headless: `mempalace mine <path> --wing <wing> --room <room>`.
3. **Mirror KG facts** when `config.mempalace.mirror_kg` is true: extract decision/delivery facts and `mempalace_kg_add` them with `valid_from` = the phase date (e.g. `(<project>, decided, <decision>)` from CONTEXT; `(<phase>, delivered, <capability>)` from SUMMARY). Only `augment` is currently wired, so these are an *additive* mirror of `.planning/graphs/`. (`kg_backend`/`replace` are forward-declared and behave as `augment` today.)
4. Re-running a phase MUST NOT create duplicate drawers (deterministic ids + `check_duplicate`).

## Step 4 -- Report

Print a one-line summary: `Filed <artifact> → <wing>/<room> (<n> KG facts)` or `MemPalace unavailable — capture skipped`.

## Anti-Patterns

1. DO NOT let any MemPalace error fail the step -- capture is `onError: skip`.
2. DO NOT write lossy summaries -- store the verbatim artifact text (AAAK compression is a separate, optional index).
3. DO NOT prune or delete drawers here -- pruning (`sync --apply`) is the curator agent's job at `ship:post`, wing-scoped only.
4. DO NOT skip the config gate or the dedup check.
