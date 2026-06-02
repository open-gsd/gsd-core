# How to recover and troubleshoot

**Goal:** Identify and fix common problems — from lost context and corrupted state to installation failures and permission errors — using a conditional recipe structure.

**Prerequisites:** GSD Core is installed. For install problems specifically, see [Install on your runtime](install-on-your-runtime.md).

---

## Context and session problems

### If you have lost track of where you are

```bash
/gsd-progress
```

Reads all state files and tells you exactly where you are and what to do next.

To automatically advance to the correct next step:

```bash
/gsd-progress --next
```

### If you are starting a new session and need to restore context

```bash
/gsd-resume-work
```

Restores your full session context from the last handoff, including current phase, planning decisions, and where work stopped.

### If quality is dropping during a long session

Clear your context window between major commands:

```bash
/clear
```

Then restore state:

```bash
/gsd-resume-work
```

GSD is designed around fresh contexts. Every subagent already gets a clean 200k window. The main session degrades over time — clearing it and resuming is the correct remedy, not pushing on.

### If you want to save context before stopping

```bash
/gsd-pause-work
```

Creates `.planning/HANDOFF.json` with your current position. Add `--report` to also write a post-session summary to `.planning/reports/`:

```bash
/gsd-pause-work --report
```

---

## Planning integrity problems

### If `.planning/` integrity is uncertain

```bash
/gsd-health
```

Reports status across errors, warnings, and informational notes:

| Status | Meaning |
|--------|---------|
| `HEALTHY` | All expected artefacts present and well-formed |
| `DEGRADED` | Warnings that should be addressed but work can continue |
| `BROKEN` | Critical errors that will block execution |

Common auto-repairable issues (errors E004, E005; warnings W003, W008):

```bash
/gsd-health --repair
```

This recreates missing `STATE.md`, resets a corrupt `config.json` to defaults, and adds any missing configuration keys. It will not overwrite `PROJECT.md` or `ROADMAP.md`.

### If STATE.md references a phase that does not exist

This produces warning `W002`. Use the state CLI to diagnose and repair:

```bash
node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" state validate
```

Preview what a sync would change without writing:

```bash
node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" state sync --verify
```

Apply the sync:

```bash
node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" state sync
```

These commands reconstruct `STATE.md` from actual project state on disk. They replace manual `STATE.md` editing.

### If you see "Project already initialised"

`.planning/PROJECT.md` already exists. `/gsd-new-project` is a safety check. If you genuinely want to start over, delete the `.planning/` directory first:

```bash
rm -rf .planning/
```

Then re-run `/gsd-new-project`.

### If context-window utilisation is high

```bash
/gsd-health --context
```

Probes the context-window utilisation guard. Warns at 60 %, critical at 70 %. If you are above the warning threshold, run `/clear` followed by `/gsd-resume-work` before starting the next major command.

---

## Execution problems

### If an executor gets "Permission denied" on Bash commands

GSD's `gsd-executor` subagents need write-capable Bash access. Add the required patterns to `~/.claude/settings.json` under `permissions.allow`. At minimum:

```json
"Bash(git add:*)",
"Bash(git commit:*)",
"Bash(git merge:*)",
"Bash(git checkout:*)"
```

For stack-specific patterns (Rails, Python, Node, Rust), see the full table in `docs/USER-GUIDE.md` under "Executor Subagent Gets Permission denied".

Per-project alternative: add the same block to `.claude/settings.local.json` in your project root.

### If execution fails or produces stubs

Check whether the plan is too ambitious. Plans should have two or three tasks at most. If tasks are too large they exceed what a single context window can produce reliably. Re-plan the phase with smaller scope:

```bash
/gsd-plan-phase 1
```

For systematic diagnosis of what went wrong, see [Debug a failed execution](debug-a-failed-execution.md).

### If parallel execution causes build lock errors or pre-commit hook failures

This is caused by multiple agents triggering build tools simultaneously. GSD handles this automatically since v1.26. If you are on an older version, or still seeing contention, disable parallel execution:

```bash
/gsd-settings
```

Set `parallelization.enabled` to `false`.

### If a subagent appears to fail but commits were made

Check git log before concluding something broke:

```bash
git log --oneline -10
```

A known Claude Code classification bug can report failure while work succeeded. GSD's orchestrators spot-check actual output, but if you see a mismatch, the commits are the ground truth.

---

## Plan and phase problems

### If plans seem wrong or misaligned with your intent

Run `/gsd-discuss-phase N` before planning. Most plan quality issues come from assumptions that `CONTEXT.md` would have prevented:

```bash
/gsd-discuss-phase 1
```

To see what assumptions GSD is currently making without starting a full session:

```bash
/gsd-discuss-phase 3 --assumptions
```

### If you need to change something after execution

Do not re-run `/gsd-execute-phase`. Use `/gsd-quick` for targeted fixes:

```bash
/gsd-quick "Fix the login button not responding on mobile Safari"
```

Or use `/gsd-verify-work N` to systematically identify and fix issues through UAT.

### If a command appears frozen at "Spawning…"

Wait. GSD subagents run in a separate context window. Their work is invisible to the parent session while in progress. The liveness note on the spawn line confirms this is expected. Research and planning agents routinely take 1–5 minutes; verification agents can take longer on large phases.

Do not interrupt the session. Killing it discards in-progress subagent work.

If it has been more than 10 minutes, check whether the agent task still shows as active in the Claude Code sidebar.

---

## Workflow state problems

### If the workflow seems corrupted or state is inconsistent

```bash
/gsd-forensics
```

Or with a description:

```bash
/gsd-forensics "Phase 3 execution stalled after wave 1"
```

`/gsd-forensics` runs a post-mortem investigation: git history anomalies, artefact integrity, STATE.md consistency, uncommitted work, and orphaned worktrees. It writes a report to `.planning/forensics/` and surfaces recommended remediation steps. It is read-only and never modifies your project files.

### If you need to roll back a phase or plan

```bash
/gsd-undo --phase 03          # Roll back all commits for phase 3
/gsd-undo --plan 03-02        # Roll back commits for plan 02 of phase 3
/gsd-undo --last 5            # Pick interactively from the 5 most recent GSD commits
```

`/gsd-undo` checks dependent phases before reverting and always shows a confirmation gate.

---

## Install and update problems

### If GSD is not recognised after install

Restart your runtime. GSD installs slash commands into your runtime's command directory (for example `~/.claude/commands/gsd/`). Most runtimes discover new commands only at startup.

If the problem persists, verify the install:

```bash
npx @opengsd/gsd-core@latest --claude --local
```

For runtime-specific install paths and troubleshooting, see [Install on your runtime](install-on-your-runtime.md).

### If an update overwrote your local changes

Since v1.17, the installer backs up locally modified files to `gsd-local-patches/`. Reapply your changes:

```bash
/gsd-update --reapply
```

### If you cannot update via npm

If `npx @opengsd/gsd-core` fails due to npm outages or network restrictions, see `docs/manual-update.md` for a step-by-step manual update procedure that works without npm access.

For routine updates, see [Update GSD](update-gsd.md).

---

## Cost problems

### If model costs are too high

Switch to the budget profile:

```bash
/gsd-config --profile budget
```

Disable research and plan-check agents via settings if the domain is familiar:

```bash
/gsd-settings
```

Also audit which MCP servers are enabled. Every enabled MCP server injects its tool schema into every turn. Browser and platform-specific tools can cost 20k+ tokens each. Disable any that the current phase does not need in `.claude/settings.json`:

```json
{
  "disabledMcpjsonServers": ["playwright", "mac-tools"]
}
```

---

## Recovery quick reference

| Problem | Solution |
|---------|---------|
| Lost context or new session | `/gsd-resume-work` or `/gsd-progress` |
| Don't know what step is next | `/gsd-progress --next` |
| Phase went wrong | `/gsd-undo --phase NN`, then re-plan |
| Something broke | `/gsd-debug "description"` (add `--diagnose` for analysis without fixes) |
| STATE.md out of sync | `state validate` then `state sync` |
| `.planning/` integrity uncertain | `/gsd-health`, then `/gsd-health --repair` |
| Workflow state seems corrupted | `/gsd-forensics` |
| Quick targeted fix | `/gsd-quick` |
| Plan doesn't match your vision | `/gsd-discuss-phase N` then re-plan |
| Costs running high | `/gsd-config --profile budget` and `/gsd-settings` to toggle agents off |
| Update broke local changes | `/gsd-update --reapply` |
| Want session summary | `/gsd-pause-work --report` |
| Parallel execution build errors | Update GSD or set `parallelization.enabled: false` |

---

## Related

- [Debug a failed execution](debug-a-failed-execution.md)
- [Install on your runtime](install-on-your-runtime.md)
- [Commands](../COMMANDS.md)
- [docs index](../README.md)
