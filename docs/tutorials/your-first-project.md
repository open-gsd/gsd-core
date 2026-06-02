# Your first project

In this tutorial you will install GSD Core and build a small command-line to-do app from scratch — one phase, one PR, the full loop. By the end you will have run every command in the core phase loop at least once, and you will have seen the planning artefacts that each command produces.

---

## What you'll build

A Node.js CLI that lets you add, list, and complete to-do items stored in a local JSON file. It is small enough to finish in one session and uses nothing beyond the Node.js standard library, so there is nothing unusual to install.

---

## Prerequisites

- **Node.js 18 or later** — `node --version` should print `v18.x.x` or higher.
- **Claude Code** — open in the project directory you want to use.
- An internet connection for the initial install.

No other tools are required. GSD Core itself is installed in the next step.

---

## Step 1 — Install GSD Core

Open a terminal in your project directory and run:

```bash
npx @opengsd/gsd-core@latest
```

The installer asks which AI coding runtime you are using and whether to install globally or into the current project. Choose **Claude Code** and **local** (just this project) for now.

You'll see output like:

```text
✓ Installed 86 skills to .claude/commands/
✓ Installed agents to .claude/agents/
✓ GSD Core ready — run /gsd-new-project to start
```

Notice that a `.claude/` directory now exists in your project. That is where GSD Core's commands and agents live.

> Why local vs global? A local install keeps the skills version pinned to this project. See [Install on your runtime](../how-to/install-on-your-runtime.md) when you want to install globally.

---

## Step 2 — Start Claude Code with permissions

GSD Core spawns sub-agents that read and write files. Start Claude Code with the permissions flag so it does not pause to ask about every file operation:

```bash
claude --dangerously-skip-permissions
```

You'll land at the Claude Code prompt in your project directory.

---

## Step 3 — Create the project

Type this slash command at the Claude Code prompt:

```text
/gsd-new-project
```

GSD Core will open a conversation. It asks one question first:

```text
What do you want to build?
```

Type something like:

```text
A Node.js CLI tool for managing to-do items. Users run `todo add "buy milk"`,
`todo list`, and `todo done 1`. Items are saved to a local todos.json file.
No external dependencies — Node built-ins only.
```

GSD Core follows up with a handful of clarifying questions. Answer them naturally. It is learning what you care about before it writes a single plan.

After the questions, it offers to run domain research. For a project this small you can skip research — choose **Skip research** when prompted.

GSD Core then asks you to pick workflow settings (mode, granularity, research agents). Choose the recommended defaults for each. These are written to `.planning/config.json`.

Finally, a roadmapper sub-agent runs (you'll see the "Spawning roadmapper…" notice — this is normal and takes roughly a minute). When it returns, GSD Core presents a proposed roadmap. For a single-phase project it will look something like:

```text
Proposed Roadmap

1 phase | 4 requirements mapped | All v1 requirements covered ✓

| # | Phase              | Goal                                    | Requirements      |
|---|--------------------|-----------------------------------------|-------------------|
| 1 | Core CLI           | add / list / done commands, todos.json  | CLI-01 … CLI-04   |
```

Type **Approve** to accept the roadmap.

**What gets created in `.planning/`:**

```text
.planning/
  PROJECT.md          ← your project description and requirements
  REQUIREMENTS.md     ← REQ-IDs for every v1 capability
  ROADMAP.md          ← Phase 1, status: pending
  STATE.md            ← session memory, current position
  config.json         ← workflow settings
```

Open `.planning/ROADMAP.md` now and read through it. Notice that Phase 1 has a Goal, a list of Requirements it must satisfy, and Success Criteria — these are the observable behaviours that execution must deliver.

---

## Step 4 — Clear context and discuss Phase 1

GSD Core is designed around fresh contexts. Clear the main session window before each phase:

```text
/clear
```

Then start the discussion for Phase 1:

```text
/gsd-discuss-phase 1
```

GSD Core reads the phase goal and asks about your implementation preferences. These are the decisions that shape *how* it builds, not just *what* it builds. Example exchange:

```text
> How should done items be stored — mark them in place or move them?
  Mark them in place with a "done" flag.

> Should `todo list` show completed items by default?
  No, hide them unless --all is passed.

> Error format when todos.json doesn't exist yet?
  Create it silently on first add.
```

When the discussion closes, GSD Core writes:

```text
.planning/phases/01-core-cli/CONTEXT.md
```

Open that file. You'll see an `## Implementation Decisions` section capturing exactly what you said. The planner reads this file — so the decisions you made here will flow through into every task plan.

---

## Step 5 — Plan Phase 1

```text
/gsd-plan-phase 1
```

Four research sub-agents fan out in parallel (you'll see the "Spawning 4 researchers…" notice). They take 1–5 minutes. Do not interrupt.

When they return, a planner reads CONTEXT.md plus the research findings and creates atomic task plans. A plan-checker then verifies each plan achieves the phase goal before saving.

**What gets created:**

```text
.planning/phases/01-core-cli/
  RESEARCH.md         ← domain findings
  01-01-PLAN.md       ← Task: create todos.json read/write helpers
  01-02-PLAN.md       ← Task: implement add / list / done commands
```

Open `01-01-PLAN.md`. You'll see a `<task>` block with a name, the files it touches, the action steps, a verify command, and a done condition. Notice the `<verify>` tag — GSD Core's executor will run that command after writing the code.

---

## Step 6 — Execute Phase 1

```text
/gsd-execute-phase 1
```

GSD Core groups the plans into waves (independent plans run in parallel), spawns a fresh 200k-context executor per plan, and commits each task atomically.

You'll see something like:

```text
Wave 1 (parallel):
  [Executor A] → 01-01-PLAN.md (read/write helpers)   ✓ committed
  [Executor B] → 01-02-PLAN.md (CLI commands)          ✓ committed

[Verifier] Checking codebase against phase goals...
  CLI-01 todo add   ✓
  CLI-02 todo list  ✓
  CLI-03 todo done  ✓
  CLI-04 --all flag ✓
  Status: PASS
```

**What gets created:**

```text
.planning/phases/01-core-cli/
  01-01-SUMMARY.md    ← what Executor A built and committed
  01-02-SUMMARY.md    ← what Executor B built and committed
  VERIFICATION.md     ← REQ coverage: PASS
```

Run your CLI now:

```bash
node todo.js add "buy milk"
node todo.js add "write tests"
node todo.js list
node todo.js done 1
node todo.js list
```

You should see items appear, and item 1 disappear from the default list after marking it done. That is your first visible result delivered by GSD Core.

---

## Step 7 — Verify the work

```text
/gsd-verify-work 1
```

GSD Core extracts the phase's success criteria and walks you through each one:

```text
[1/3] Can you run `node todo.js add "buy milk"` without errors?
> yes

[2/3] Does `node todo.js list` show only incomplete items by default?
> yes

[3/3] Does `node todo.js done 1` mark item 1 complete and hide it from the default list?
> yes

All 3 checks passed. Phase 1 verified.
```

If any check fails, GSD Core diagnoses the root cause and creates a fix plan. Run `/gsd-execute-phase 1` again to apply it, then re-run `/gsd-verify-work 1`.

**What gets created:**

```text
.planning/phases/01-core-cli/UAT.md   ← all checks and their outcomes
```

---

## Step 8 — Ship it

```text
/gsd-ship 1
```

GSD Core creates a pull request with a generated body. The PR body always includes: Summary, Changes, Requirements Addressed, Verification, and Key Decisions.

You'll see:

```text
Pull request created: https://github.com/your-org/your-repo/pull/1

Title: feat(phase-1): core CLI — add / list / done commands
```

That is the full loop — from idea to merged PR — for one phase.

---

## What you've learned

- How to install GSD Core with `npx @opengsd/gsd-core@latest`.
- How `/gsd-new-project` turns a conversation into a roadmap backed by `.planning/` artefacts.
- How `/gsd-discuss-phase` captures implementation decisions before any planning happens.
- How `/gsd-plan-phase` spawns parallel researchers and produces atomic task plans.
- How `/gsd-execute-phase` runs those plans in parallel waves and commits each task.
- How `/gsd-verify-work` walks through success criteria and generates fix plans when needed.
- How `/gsd-ship` turns a verified phase into a pull request.

For a multi-phase project, repeat Steps 4–8 for each phase, then run `/gsd-progress --next` to let GSD Core detect the next step automatically.

---

## Related

- [The phase loop](../explanation/the-phase-loop.md) — why the loop is shaped this way
- [How-to guides](../README.md#how-to-guides) — task-focused recipes for specific situations
- [Onboarding an existing codebase](onboarding-an-existing-codebase.md) — bring GSD Core to a brownfield repo
