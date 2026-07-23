<!--
  Optional hero image (ships alongside this file in the PR as
  docs/tutorials/assets/your-first-project-hero.png):
  <p align="center"><img src="assets/your-first-project-hero.png" alt="GSD Core — Git. Ship. Done." width="100%"></p>
-->

<div align="center">

# 🚀 Your first project

**From an empty folder to a shipped pull request — in one guided loop.**

![level](https://img.shields.io/badge/level-beginner-3fb950?style=flat-square)
![time](https://img.shields.io/badge/time-30–45%20min-f0883e?style=flat-square)
![runtime](https://img.shields.io/badge/runtime-Claude%20Code-8957e5?style=flat-square)
![prereq](https://img.shields.io/badge/prereq-Node%2018%2B-2f81f7?style=flat-square)

</div>

> [!TIP]
> **This is the one guaranteed path.** You will build a tiny app, run **every**
> command in the core loop exactly once, and — the part most tutorials skip —
> understand *why* each step exists. No prior GSD knowledge assumed.

---

## 📖 Table of contents

1. [The one idea that makes GSD click](#-the-one-idea-that-makes-gsd-click)
2. [What you'll build](#-what-youll-build)
3. [Prerequisites](#-prerequisites)
4. [Step 1 — Install GSD Core](#step-1--install-gsd-core)
5. [Step 2 — Start Claude Code](#step-2--start-claude-code-with-permissions)
6. [Step 3 — Create the project](#step-3--create-the-project)
7. [Step 4 — Discuss Phase 1](#step-4--clear-context-then-discuss-phase-1)
8. [Step 5 — Plan Phase 1](#step-5--plan-phase-1)
9. [Step 6 — Execute Phase 1](#step-6--execute-phase-1)
10. [Step 7 — Verify the work](#step-7--verify-the-work)
11. [Step 8 — Ship it](#step-8--ship-it)
12. [Glossary](#-mini-glossary) · [Troubleshooting](#-troubleshooting) · [What next](#-what-next)

---

## 💡 The one idea that makes GSD click

GSD Core does **not** "write your whole app in one shot." It runs a **repeating
five-step loop**, and it does the heavy thinking in **fresh, throwaway
sub-agents** so your main chat window never fills up with clutter — the quality
killer GSD calls [context rot](../explanation/context-engineering.md).

You drive that loop **one phase at a time**:

```mermaid
flowchart LR
    D([💬 Discuss]) --> P([📐 Plan])
    P --> E([⚙️ Execute])
    E --> V([✅ Verify])
    V --> S([🚀 Ship])
    S -. next phase .-> D
    classDef step fill:#1f2430,stroke:#f0883e,stroke-width:2px,color:#e6edf3;
    class D,P,E,V,S step;
```

| Step | Command | In one sentence | Typical time |
|:----:|---------|-----------------|:------------:|
| 💬 **Discuss** | `/gsd-discuss-phase` | GSD asks *how* to build it and writes your answers down. | 2–4 min |
| 📐 **Plan** | `/gsd-plan-phase` | Researchers fan out; work is split into small, checkable tasks. | 1–5 min |
| ⚙️ **Execute** | `/gsd-execute-phase` | Fresh agents write the code and commit each task. | 2–6 min |
| ✅ **Verify** | `/gsd-verify-work` | GSD walks you through "does it actually work?" | 1–3 min |
| 🚀 **Ship** | `/gsd-ship` | A pull request is opened for you. | <1 min |

> [!NOTE]
> **Keep that table handy.** Whenever you feel lost, ask yourself one question:
> *"which step of the loop am I on?"* That's the entire mental model.

<details>
<summary>🧠 <b>Why fresh sub-agents? (the 30-second version)</b></summary>

<br>

A single long chat slowly degrades: the more it holds, the more the model
juggles, and quality quietly drops. GSD sidesteps this by spawning a **clean
200k-token worker** for each heavy job (research, execution) and throwing it away
after. Your main session stays lean; the shared `.planning/` files carry memory
between them.

```mermaid
flowchart TB
    subgraph main [Your main session · stays lean]
        you([You + GSD])
    end
    subgraph workers [Fresh sub-agents · clean context each time]
        r1[Researcher]
        r2[Researcher]
        ex[Executor A]
        ey[Executor B]
    end
    you -- spawns --> r1 & r2 & ex & ey
    r1 & r2 & ex & ey -- write --> plan[(.planning/ files)]
    plan -- memory --> you
    classDef m fill:#132a1a,stroke:#3fb950,color:#e6edf3;
    classDef w fill:#1f2430,stroke:#58a6ff,color:#e6edf3;
    classDef f fill:#2d2410,stroke:#f0883e,color:#e6edf3;
    class you m; class r1,r2,ex,ey w; class plan f;
```

</details>

---

## 🎯 What you'll build

A small **Node.js command-line to-do app**:

```bash
todo add "buy milk"      # ➕ add an item
todo list                # 📋 see open items
todo done 1              # ✅ complete item 1
```

Items live in a local `todos.json`. It uses **only the Node.js standard library**
— nothing to install, nothing to configure — so you focus entirely on the GSD
loop, not a toolchain.

> [!TIP]
> Small on purpose. Once the loop is muscle memory, the *exact same* eight steps
> scale to a real multi-phase product.

---

## ✅ Prerequisites

Run each check. If one fails, fix it before continuing.

| You need | Check with | "Good" looks like |
|----------|------------|-------------------|
| **Node.js 18+** | `node --version` | `v18.x.x` or higher |
| **Claude Code** | `claude --version` | any version prints |
| **A terminal in an empty folder** | `pwd` | the project dir you want to use |
| **Internet** | — | needed once, for the installer |

```mermaid
flowchart LR
    A[node --version ≥ 18?] -->|no| A1[Install/upgrade Node] --> A
    A -->|yes| B[claude installed?]
    B -->|no| B1[Install Claude Code] --> B
    B -->|yes| C[In an empty project folder?]
    C -->|no| C1[cd into one] --> C
    C -->|yes| R([✅ Ready for Step 1])
    classDef ok fill:#132a1a,stroke:#3fb950,color:#e6edf3;
    class R ok;
```

No database, no framework, no API keys. Got the four? You're ready.

---

## Step 1 — Install GSD Core

From a terminal **in your project directory**:

```bash
npx @opengsd/gsd-core@latest
```

Answer two prompts: **runtime → Claude Code**, **scope → local** (just this
project). You'll see:

```text
✓ Installed 86 skills to .claude/commands/
✓ Installed agents to .claude/agents/
✓ GSD Core ready — run /gsd-new-project to start
```

<details>
<summary>💡 <b>What just happened?</b></summary>

<br>

A `.claude/` directory now exists in your project. It holds GSD's **commands**
(the `/gsd-*` slash commands) and **agents** (the sub-agents that research and
execute). You never edit these by hand — the installer owns them.

</details>

> [!NOTE]
> **Why local, not global?** A local install pins the GSD version to *this*
> project, so an update elsewhere can't silently change its behaviour here.
> [Install on your runtime](../how-to/install-on-your-runtime.md) covers global
> installs and the other 14 supported runtimes.

> [!WARNING]
> **If it fails:** `npx: command not found` → Node isn't on your `PATH`
> (re-check prerequisites). Network error → check your connection/proxy; the
> first install needs internet. Picked the wrong runtime → just re-run the
> command and choose again.

---

## Step 2 — Start Claude Code with permissions

GSD spawns sub-agents that read and write files. Start with the permissions flag
so it doesn't stop to confirm **every** file operation:

```bash
claude --dangerously-skip-permissions
```

You'll land at the Claude Code prompt, inside your project.

> [!CAUTION]
> **About that scary flag.** It lets GSD's agents edit files without a prompt
> each time — exactly what you want for a throwaway tutorial in an empty folder.
> For real work in a repo you care about, read the
> [security model](../explanation/security-model.md) first.

---

## Step 3 — Create the project

At the Claude Code prompt:

```text
/gsd-new-project
```

The first question is always **"What do you want to build?"** Paste this:

```text
A Node.js CLI tool for managing to-do items. Users run `todo add "buy milk"`,
`todo list`, and `todo done 1`. Items are saved to a local todos.json file.
No external dependencies — Node built-ins only.
```

Then:

- A few **clarifying questions** → answer naturally (GSD is learning what you care
  about *before* it plans).
- **Domain research?** → choose **Skip research** (project's too small to need it).
- **Workflow settings** (mode, granularity, research agents) → take the
  **recommended default** for each.
- A **roadmapper** sub-agent runs (`Spawning roadmapper…`, ~1 min).

You'll get a proposed roadmap — type **Approve**:

```text
Proposed Roadmap
1 phase | 4 requirements mapped | All v1 requirements covered ✓

| # | Phase    | Goal                                   | Requirements    |
|---|----------|----------------------------------------|-----------------|
| 1 | Core CLI | add / list / done commands, todos.json | CLI-01 … CLI-04 |
```

<details>
<summary>💡 <b>What just got created in <code>.planning/</code>?</b></summary>

<br>

```mermaid
flowchart TD
    root[.planning/]
    root --> PROJECT[PROJECT.md<br/>your description + requirements]
    root --> REQ[REQUIREMENTS.md<br/>a REQ-ID per capability]
    root --> ROAD[ROADMAP.md<br/>Phase 1 · status: pending]
    root --> STATE[STATE.md<br/>session memory · where you are]
    root --> CFG[config.json<br/>your workflow settings]
    classDef f fill:#1f2430,stroke:#f0883e,color:#e6edf3;
    class root,PROJECT,REQ,ROAD,STATE,CFG f;
```

These files are GSD's **shared memory** — they survive `/clear`, survive closing
your laptop, and let a fresh sub-agent pick up exactly where the last left off.

</details>

👉 **Do this now:** open `.planning/ROADMAP.md`. Phase 1 has a **Goal**,
**Requirements**, and **Success Criteria** — the observable behaviours execution
must deliver. This file is your map for the rest of the tutorial.

---

## Step 4 — Clear context, then discuss Phase 1

GSD is built around **fresh contexts**. Clear the window before each phase:

```text
/clear
```

Then open the discussion:

```text
/gsd-discuss-phase 1
```

GSD asks about your **implementation preferences** — *how* to build, not just
*what*:

```text
> How should done items be stored — mark them in place or move them?
  Mark them in place with a "done" flag.
> Should `todo list` show completed items by default?
  No, hide them unless --all is passed.
> What if todos.json doesn't exist yet?
  Create it silently on first add.
```

It writes `.planning/phases/01-core-cli/CONTEXT.md`.

👉 **Do this now:** open that file → find `## Implementation Decisions`. Those are
your words, captured. The planner reads this next, so every decision here flows
into the task plans.

> [!NOTE]
> **Why discuss before planning?** Decide the small stuff up front and the plan is
> right the first time — instead of you correcting a wrong plan, choice by choice.

---

## Step 5 — Plan Phase 1

```text
/gsd-plan-phase 1
```

```mermaid
sequenceDiagram
    participant You
    participant GSD
    participant R as 4 Researchers (parallel)
    participant PL as Planner
    participant PC as Plan-checker
    You->>GSD: /gsd-plan-phase 1
    GSD->>R: spawn (fresh context each)
    R-->>GSD: RESEARCH.md findings
    GSD->>PL: CONTEXT.md + research
    PL-->>GSD: atomic task plans
    GSD->>PC: verify each plan hits the goal
    PC-->>You: plans saved ✓
```

Four researchers fan out (`Spawning 4 researchers…`, 1–5 min — don't interrupt).
A **planner** turns `CONTEXT.md` + research into **atomic task plans**; a
**plan-checker** verifies each before saving.

<details>
<summary>💡 <b>What just got created?</b></summary>

<br>

```text
.planning/phases/01-core-cli/
  RESEARCH.md         ← domain findings
  01-01-PLAN.md       ← Task: todos.json read/write helpers
  01-02-PLAN.md       ← Task: add / list / done commands
```

</details>

👉 **Do this now:** open `01-01-PLAN.md`. Inside the `<task>` block: a name, the
files it touches, action steps, a `<verify>` command, and a "done" condition.
That `<verify>` isn't decoration — the executor runs it after writing code.

---

## Step 6 — Execute Phase 1

```text
/gsd-execute-phase 1
```

GSD groups plans into **waves** (independent plans run in parallel), spawns a
**fresh 200k-context executor per plan**, and commits each task atomically:

```text
Wave 1 (parallel):
  [Executor A] → 01-01-PLAN.md (read/write helpers)   ✓ committed
  [Executor B] → 01-02-PLAN.md (CLI commands)          ✓ committed

[Verifier] Checking codebase against phase goals...
  CLI-01 todo add   ✓   CLI-03 todo done  ✓
  CLI-02 todo list  ✓   CLI-04 --all flag ✓
  Status: PASS
```

**Run your app** — your first visible result:

```bash
node todo.js add "buy milk"
node todo.js add "write tests"
node todo.js list        # → both items
node todo.js done 1
node todo.js list        # → only "write tests"
```

🎉 Item 1 disappears from the default list after `done`. It works.

<details>
<summary>💡 <b>What just got created?</b></summary>

<br>

```text
.planning/phases/01-core-cli/
  01-01-SUMMARY.md    ← what Executor A built + committed
  01-02-SUMMARY.md    ← what Executor B built + committed
  VERIFICATION.md     ← requirement coverage: PASS
```

</details>

---

## Step 7 — Verify the work

```text
/gsd-verify-work 1
```

GSD extracts the phase's **success criteria** and walks each one:

```text
[1/3] Run `node todo.js add "buy milk"` without errors?   > yes
[2/3] Does `list` show only incomplete items by default?  > yes
[3/3] Does `done 1` complete item 1 and hide it?          > yes
All 3 checks passed. Phase 1 verified.
```

If a check **fails**, GSD diagnoses the root cause and writes a fix plan → re-run
`/gsd-execute-phase 1`, then `/gsd-verify-work 1` again. (Result:
`.planning/phases/01-core-cli/UAT.md`.)

> [!NOTE]
> **Why a separate verify step?** "The code was written" and "the code works" are
> different claims. Verify proves the second one *before* you open a PR.

---

## Step 8 — Ship it

```text
/gsd-ship 1
```

GSD creates a pull request with a generated body (Summary · Changes ·
Requirements Addressed · Verification · Key Decisions):

```text
Pull request created: https://github.com/your-org/your-repo/pull/1
Title: feat(phase-1): core CLI — add / list / done commands
```

That's the **full loop** — idea → merged PR — for one phase. 🚀

```mermaid
flowchart LR
    idea([💡 idea]) --> loop
    subgraph loop [one phase]
      direction LR
      d[Discuss]-->p[Plan]-->e[Execute]-->v[Verify]-->s[Ship]
    end
    loop --> pr([✅ Pull request])
    classDef a fill:#1f2430,stroke:#f0883e,color:#e6edf3;
    classDef ok fill:#132a1a,stroke:#3fb950,color:#e6edf3;
    class d,p,e,v,s a; class pr,idea ok;
```

---

## 🔁 Doing more than one phase

For a multi-phase project, repeat **Steps 4–8** for each phase. Not sure what's
next? Let GSD detect it:

```text
/gsd-progress --next
```

---

## 📚 Mini-glossary

| Term | Meaning in GSD |
|------|----------------|
| **Phase** | One slice of the roadmap you take through the whole loop. |
| **The loop** | Discuss → Plan → Execute → Verify → Ship. |
| **Sub-agent** | A fresh, throwaway worker GSD spawns for research or execution. |
| **Context rot** | Quality decay as the main window fills up; fresh sub-agents prevent it. |
| **`.planning/`** | GSD's shared memory: PROJECT, REQUIREMENTS, ROADMAP, STATE, per-phase files. |
| **Requirement (REQ-ID)** | A single v1 capability the roadmap must cover, e.g. `CLI-01`. |
| **Success criteria** | Observable behaviours a phase must deliver, checked in Verify. |
| **Wave** | A batch of independent task plans executed in parallel. |

---

## 🛟 Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| A `/gsd-*` command isn't recognized | GSD installed in another folder | Confirm `.claude/commands/` exists here; re-run the installer. |
| `Spawning researchers…` looks stuck | Research runs 1–5 min | Wait — don't interrupt. If truly hung, `/clear` and re-run the step. |
| Verify keeps failing | Real bug in the code | Let GSD write the fix plan → `/gsd-execute-phase 1` → re-verify. |
| Lost track of where you are | — | Open `.planning/STATE.md`, or run `/gsd-progress --next`. |
| Something is badly wedged | — | See [Recover and troubleshoot](../how-to/recover-and-troubleshoot.md). |

---

## 🎓 What next

- [The phase loop](../explanation/the-phase-loop.md) — why it's shaped this way
- [Context engineering](../explanation/context-engineering.md) — the theory behind fresh sub-agents
- [How-to guides](../README.md#how-to-guides) — task-focused recipes
- [Configure model profiles](../how-to/configure-model-profiles.md) — quality / balanced / budget tiers
- [Onboarding an existing codebase](onboarding-an-existing-codebase.md) — bring GSD to a brownfield repo

> [!TIP]
> **You now know the whole loop.** Everything else in GSD is a refinement of these
> eight steps. Welcome aboard. 🚀
