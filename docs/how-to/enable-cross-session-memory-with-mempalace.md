# How to enable cross-session memory with MemPalace

Give GSD durable memory across sessions and projects. When MemPalace is connected, GSD recalls prior decisions and patterns before you plan, and captures phase artifacts verbatim at each phase boundary.

**What you need:** [MemPalace](https://github.com/MemPalace/mempalace) installed locally. GSD never installs MemPalace for you — `pip install mempalace` is your action. A working MemPalace install is not required to complete GSD work; the capability is `onError: skip` at every hook, so an absent or unreachable MemPalace leaves the loop unchanged.

---

## Step 1 — Install MemPalace

Follow the [MemPalace installation guide](https://github.com/MemPalace/mempalace#installation). The quick path:

```bash
pip install mempalace
mempalace init          # creates the local palace (ChromaDB + SQLite)
mempalace status        # verify the server is reachable
```

For interactive use (Claude Code), MemPalace's MCP server must be running so `mempalace_*` tool calls resolve. For headless or cron runs, the CLI path (`mempalace wake-up`, `mempalace search`, etc.) is used automatically — no MCP server needed.

---

## Step 2 — Enable the capability

Inside your GSD project:

```bash
gsd-tools query config-set mempalace.enabled true
```

That is the only required step — `mempalace.enabled` is the master switch that gates all loop hooks. All other `mempalace.*` keys are optional refinements of the enabled behavior; they are honored at runtime by the skills, curator, and fragments.

---

## Step 3 — Choose a memory mode

The `mempalace.memory_mode` key controls how authoritative MemPalace is during recall and capture — how tightly it couples to GSD's native memory (`.planning/graphs/`, STATE, learnings). All three modes are wired. Every mode is `onError: skip` and default-resilient: an unreachable palace degrades to native memory, and GSD keeps writing `.planning/graphs/`, so no mode risks memory loss.

| Mode | What it does | When to use it |
|------|-------------|----------------|
| `augment` (default) | The palace is an *additional* recall layer alongside `.planning/graphs/` and learnings. Lowest coupling — native memory stays authoritative and the palace supplements it. | Most users. Safe to enable immediately. |
| `kg_backend` | Knowledge-graph queries resolve against the palace's temporal KG as the *primary* source; `.planning/graphs/` becomes the fallback. Non-KG drawer recall stays additive. | You want the palace's temporal KG to drive decision recall while keeping native graphs as a safety net. |
| `replace` | Recall resolves *through the palace as the source of truth*; native artifacts are consulted only as a fallback when the palace is unreachable. | You want the palace to be the authoritative memory store for this project. |

Set the mode with:

```bash
# augment is the default; most users need no change.
gsd-tools query config-set mempalace.memory_mode kg_backend   # or: replace
```

> **Note — cross-mode migration.** Switching an established project to `kg_backend` or `replace` changes how *new* recall and capture resolve; it does **not** retro-migrate memory already written to `.planning/graphs/` into the palace. Backfilling existing native memory into the palace is a separate, not-yet-implemented concern — choose the mode you want at the start of a project for the cleanest result.

---

## Step 4 — Run a phase and observe recall and capture

With `mempalace.enabled: true`, here is what you will see at each loop point:

**Discuss phase (`/gsd-discuss-phase`):**
1. At `discuss:pre` — MemPalace recall fires: prior decisions, patterns, and surprises are surfaced as context before the discussion begins.
2. At `discuss:post` — `CONTEXT.md` is filed into the `decisions` room in MemPalace.

**Plan phase (`/gsd-plan-phase`):**
3. At `plan:pre` — a `MEMORY-RECALL.md` file appears in the phase directory containing prior decisions, patterns, and surprises retrieved from the palace.
4. At `plan:post` — `PLAN.md` is filed into the `planning` room.

**Verify phase (`/gsd-verify-work`):**
5. At `verify:post` — `SUMMARY.md` is filed into `milestones` in MemPalace.

**Ship phase (`/gsd-ship`):**
6. At `ship:post` — the `gsd-mempalace-curator` agent writes a diary entry and (if enabled) proposes cross-project tunnels.

**Execute phase (`/gsd-execute-phase`, each wave):**
7. At `execute:wave:post` — confirmed problem→fix pairs are captured into the `problems` room via the `capture-problems` fragment.

If MemPalace is unreachable at any step, a skip-notice is written and the loop continues normally.

---

## Optional configuration

### Turn off recall or capture independently

```bash
# Disable recall injection at discuss:pre (keeps capture)
gsd-tools query config-set mempalace.recall_on_discuss false

# Disable the MEMORY-RECALL.md step at plan:pre
gsd-tools query config-set mempalace.recall_on_plan false

# Disable artifact capture at phase boundaries
gsd-tools query config-set mempalace.capture_artifacts false
```

### Cross-project tunnels

Enable tunnel proposals at `ship:post` to connect related rooms across projects:

```bash
gsd-tools query config-set mempalace.cross_project_tunnels true
```

The curator agent will call `mempalace_find_tunnels` and propose connections to the wings it finds semantically related to this project's wing.

### Passive mid-session capture (reserved — not yet implemented)

`mempalace.auto_capture_hooks` is a forward-declared key reserved for a future "Connected Capability" phase. Setting it to `true` currently has no effect — no native Claude Code hooks (`stop`, `precompact`, `session-start`) are installed by this key yet. The capability's hooks array is empty; the deliberate loop hooks are the only active integration today.

```bash
# Not yet functional — reserved for a future release
# gsd-tools query config-set mempalace.auto_capture_hooks true
```

### Override the wing name

By default, the wing name derives from `project_code` or the project directory. Override it:

```bash
gsd-tools query config-set mempalace.wing my-project-name
```

---

## What to expect when MemPalace is absent

If MemPalace is not installed, not running, or unreachable:

- Every hook logs a skip notice and continues.
- `MEMORY-RECALL.md` is written with an "unavailable" stub (the planner can still proceed without it).
- No phase step fails or blocks.
- Loop behaviour is identical to having `mempalace.enabled: false`.

You can safely leave `mempalace.enabled: true` in a config that will be used on machines without MemPalace — it is safe to do so.

---

## Full configuration reference

See [MemPalace Settings](../CONFIGURATION.md#mempalace-settings) in the Configuration Reference for the complete key list with types and defaults.
