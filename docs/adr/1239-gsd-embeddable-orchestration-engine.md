# ADR-1239: GSD as an Embeddable Orchestration Engine

- **Status:** Proposed
- **Date:** 2026-06-14
- **Issue:** [#1239](https://github.com/open-gsd/gsd-core/issues/1239)
- **Epic:** [#857](https://github.com/open-gsd/gsd-core/issues/857) (Capability system)
- **Realizes / inverts:** [ADR-857](857-capability-system.md) Decision 8 — flips *projection* to *embedding*, and **unifies** them
- **Subsumes as adapters:** [ADR-1016](1016-runtime-capability-descriptor.md) (Runtime Capability Descriptor → the *declarative* adapter), [ADR-58](58-runtime-install-policy-module.md) (`InstallPlan`), [ADR-3660](3660-runtime-artifact-layout-module.md), [ADR-894](894-capability-declaration-format.md)
- **Distinct from:** [#956](https://github.com/open-gsd/gsd-core/issues/956) (third-party *feature* plugins / Connected Capabilities)

## Context

GSD is a **standalone installer that projects onto a host** — `npx @opengsd/gsd-core --codex` writes artifacts into `~/.codex` via a per-runtime descriptor (ADR-1016). That answers only "*how do we write our files onto a CLI we already know*." It does not let GSD be **embedded as an orchestration engine** a host loads as a plugin: a new host (a "pi console") has no path, and the dependency points the wrong way (GSD reaches into the host instead of the host embedding GSD).

We want the inversion: **GSD is the engine; the host loads it through a stable, negotiated interface; a third party writes the thin host-plugin.** This is "turn the CLIs into Capabilities like we did for the loop."

### The six interface points (the integration surface, already implicit in the code)

1. **Command / workflow invocation** — `gsd-tools.cjs` Command Routing Hub (ADR-0012) + the workflow/slash surface.
2. **Agent dispatch** — GSD spawns sub-agents through the host's Agent/Task primitive.
3. **Model invocation** — GSD tiers → host model ids.
4. **Lifecycle hooks** — `hookEvents`/`hooksSurface`/`extendedHookEvents`.
5. **State + config IO** — `.planning/` + config under a declared `configHome`.
6. **Artifact surface** — how the host renders GSD's commands/agents/skills.

### Research: how 8 supported/target hosts actually expose these (source of truth)

Surveyed Claude Code, Codex, OpenCode, **pi** (pi.dev), VS Code, Gemini CLI, Cursor, Cline, Hermes (official docs + local `capabilities/*/capability.json`). Two structural facts dominate:

**(a) Hosts split into two embedding modes.**
- **Imperative** (a programmatic plugin API): Claude Code (subagents + 30 hook events + MCP + `Agent()` tool), **pi** (TS extensions: `registerCommand`/`registerTool`/`registerProvider` + ~30 fine-grained hooks + `before_provider_request` payload mutation), OpenCode (JS plugins + ~25 events), VS Code (extension host: `vscode.lm`, chat participants, LM tools), Cline (SDK `AgentPlugin` with `beforeTool`).
- **Declarative** (files only, "no in-process extension API"): Gemini CLI (TOML commands + `.md` agents + 10 hook scripts), Cursor (`.mdc`/`.md` + 19 hook events via `hooks.json`), Codex (AGENTS.md prose + `/skills` menu, **no custom slash commands**), Cline-via-rules (`.clinerules` text — the surface GSD uses today, **0 programmatic events**).

→ **ADR-1016's projection model *is* the declarative-embedding adapter.** Imperative embedding is the new adapter. Both sit behind one negotiated interface.

**(b) Every interface point varies from rich → degraded → absent, per host.** Agent nesting alone: Claude foreground-unlimited/background-depth-5; Codex depth-1; Gemini strictly-flat; Cline depth-2 (leaf = read-only, no MCP); Hermes spawn-depth-2 orchestrator/leaf + kanban-async; OpenCode `subtask` synchronous-only; pi *no named-dispatch primitive*; VS Code DIY tool-loop. This is why the contract must be **negotiated**, not assumed.

### Precedent: MCP's negotiated lifecycle

MCP's `initialize` handshake has each side declare **capabilities** + a **protocol version**, and "a requestor SHOULD only augment a request with a capability the receiver declared." That is exactly the shape: the host-plugin declares which primitives it provides; GSD declares requirements; GSD **degrades gracefully** when a primitive is absent (generalizing #853 into a first-class contract).

## Decision

Define a **Host-Integration Interface**: a versioned, negotiated contract over the six interface points, with GSD as an **embeddable orchestration engine** consumed through it. A host integration is a **host-plugin** = a negotiated capability set + an *embedding-mode adapter* (declarative = ADR-1016 projection; imperative = code that drives host primitives) + a thin binding. First-party hosts are authored through the **same** interface a third party would use (dogfooding). Third-party loading is **purely additive** (opt-in loader + trust gate over the descriptor: schema validation + `configHome` write-confinement). This **unifies** projection and embedding rather than replacing one with the other.

### The negotiated capability schema (extends the ADR-1016 axes)

At load, host-plugin and engine exchange `protocolVersion` + a capability object. New axes the research requires:

- **`embeddingMode`**: `imperative` | `declarative` — does the host run GSD as code or interpret GSD's artifacts?
- **`commandSurface`**: `slash-file` (Claude/OpenCode, `gsd:`-namespaced) | `slash-programmatic` (pi/VS-Code-chat) | `slash-toml` (Gemini, `gsd.`-namespaced) | `palette` (VS Code) | `prose-only` (Codex). Drives how interface point 1 binds; `prose-only` is a real degradation.
- **`dispatch`**: `{ namedDispatch: bool, nested: bool, maxDepth: int, background: bool, subagentToolkit: 'full'|'read-only' }`. GSD's orchestration **flattens** when `maxDepth`/`nested` are insufficient (run plan/execute inline) — the #853 rule, generalized and tested.
- **`modelMode`**: `active` (host exposes `sendRequest`/provider registration → GSD calls the model: VS Code, pi) | `passive` (GSD can only inject prompts/instructions: Gemini/Cursor/Cline/Codex/OpenCode). Two model-layer adapters; `passive` means GSD expresses orchestration declaratively.
- **`hookBus`**: `host` (host fires events GSD subscribes to: Gemini/Cursor/Hermes/Codex/pi/OpenCode) | `engine` (host has no bus → GSD owns it internally and fires its own: VS Code) | `none` (no bus → degrade lifecycle gating to rule-text instructions: Cline-rules). Plus the **portable event floor** (`SessionStart`/`PreToolUse`/`PostToolUse`/`Stop`/`SessionEnd` — the "claude dialect" all hook-capable hosts share) and negotiated extended events.
- **`stateIO`**: `filesystem` (most) | `sandboxed-storage` (VS Code web: no arbitrary FS) | `session-log-append` (pi JSONL). `configHome` write-confinement applies to the filesystem case.
- **`transport`**: `mcp` (near-universal — Claude/Codex/OpenCode/VS-Code/Gemini/Cursor/Cline/Hermes all consume MCP) | `native-extension` (pi: MCP needs a community extension) — GSD may ship a **companion MCP server** binding interface points 1+5 (the MemPalace pattern, already shipping).
- **`runtime`**: `node` | `bun` (pi) | `sandboxed-web` (VS Code web: no `child_process`); + flags like `systemMessages: bool` (VS Code rejects system-role messages).

The **primitive vocabulary stays closed and first-party** (ADR-857 Decision 8): a host needing a novel primitive needs a *first-party* primitive; the negotiation surfaces "unsupported" rather than letting a descriptor inject code. (Third-party *code* contributions are #956.)

### Per-interface-point capability + degradation ladder (grounded)

| Interface point | Full | Degraded | Absent → fallback |
|---|---|---|---|
| 1 Command | `slash-file`/`slash-programmatic` (Claude, OpenCode, pi, Gemini, Cursor) | `slash-toml` namespacing (Gemini `gsd.`-prefixed) | `prose-only` (Codex): commands become AGENTS.md prose + skills menu |
| 2 Dispatch | nested + background + full toolkit (Claude fg) | shallow/flat/read-only (Codex d1, Gemini flat, Cline d2 read-only) | no named dispatch (pi): single-agent inline; build via SDK sub-session |
| 3 Model | `active` (VS Code `lm`, pi providers, `before_provider_request`) | per-agent model field only (OpenCode, Gemini sub-agent) | `passive`: instruction-injection only; no tier routing |
| 4 Hooks | host bus, rich events (Claude 30, pi 30, Cursor 19) | host bus, thin events (Hermes 6, Codex 10 command-only) | `engine`-owns-bus (VS Code) / `none` → rule-text (Cline) |
| 5 State | filesystem `.planning/` (all CLIs) | sandboxed storage (VS Code) | session-log append (pi); Memento index |
| 6 Artifact | `/` typeahead + `@agent` + mgmt UI (Claude) | menu/`@`-only (Codex `/skills`, Gemini passive skills) | palette + chat participant only (VS Code: skills become LM tools) |

## Consequences

**Positive:** GSD embeds into any host with a plugin mechanism (Codex/OpenCode/pi today; a new "pi console" tomorrow) with no GSD source change; projection and imperative embedding unify under one contract; the agent-nesting bug class becomes a declared, tested capability; the engine gains a clean boundary; per-host degradation is explicit and testable rather than scattered `runtime === '…'` checks.

**Negative / cost:** a multi-phase refactor drawing a boundary through `bin/install.js` (the residue: inline agent loop, missing `destSubpath` write-confinement, `getDirName`/`_applyRuntimeRewrites`/post-layout hooks); two model adapters + two embedding adapters to build and test; per-interface-point degradation must be specified and parity-tested per host; trust-gate (write-confinement) is security-load-bearing; IDE hosts (VS Code) break terminal/shell/file-slash assumptions and need a distinct profile.

## Phased migration (the epic, #1239)

- **Phase A — Define the interface** (this ADR): six points, the negotiated capability schema above, protocol version, and the degradation ladder.
- **Phase B — Engine ↔ host boundary**: separate orchestration core (loop, `gsd-tools`, state) from install/projection; fold per-runtime residue into descriptors (absorbs #1173/ADR-1235 + the `install.js` residue list); add `destSubpath` write-confinement.
- **Phase C — Two embedding adapters + trust gate**: formalize the *declarative* adapter (today's projection) and the *imperative* adapter; opt-in external-descriptor loader + schema validation + `configHome` confinement; the MCP-companion-server binding.
- **Phase D — Dogfood one reference host per profile**: a *programmatic-CLI* (Claude or pi), a *declarative-CLI* (Gemini or Codex), and an *IDE* (VS Code) — re-authored through the public interface, with golden parity for the CLIs.
- **Phase E — Third-party SDK + docs**: publish the interface + reference host-plugins; a new host is a plugin someone writes.

Each phase is its own `approved-*` issue + PR with equivalence/parity proof.

## Host-capability profiles (negotiation baselines)

- **Programmatic-CLI** (Claude Code, pi, OpenCode): imperative; full dispatch; host hook bus; MCP; `slash` surface. The richest target — minimal degradation.
- **Declarative-CLI** (Gemini, Cursor, Codex, Cline-rules, Hermes): declarative (projection); host hook bus or none; passive model; shallow/flat dispatch; MCP (except via rules). The ADR-1016 path.
- **IDE** (VS Code): imperative but *not a terminal* — palette/chat surface, engine-owned hook bus, `active` model (no system messages), sandboxed state, possible no-`child_process`. A distinct profile that most stresses the interface.

## OpenCode binding (worked host-plugin)

> **Amendment — OpenCode worked binding (#1239, 2026-06-22).** Makes the abstract *programmatic-CLI* profile concrete for OpenCode, grounded in its plugin API (`opencode.ai/docs/plugins`, retrieved 2026-06-22) — the first reference target for Phase D. It is also the answer to "can a GSD *capability* be a standalone OpenCode plugin": **the skills can; the loop overlay cannot — without the engine.**

### What an OpenCode plugin actually is (the binding substrate)

A plugin is a JS/TS module exporting an `async` function that returns a **hooks object**. It is loaded either from `.opencode/plugins/` (project) / `~/.config/opencode/plugins/` (global), or as an npm package named in `opencode.json` `"plugin": [...]` (installed with Bun at startup; deps via `.opencode/package.json`). The function receives `{ project, directory, worktree, client, $ }` — `client` is the OpenCode SDK, `$` is Bun's shell. Extension primitives: an `event` hook (the bus), `tool.execute.before`/`after` interceptors, per-tool `tool: { name: tool({...}) }` custom tools, `shell.env` injection, `experimental.session.compacting` context/prompt injection, and `client.app.log` structured logging. **This is the entire imperative adapter surface for OpenCode** — there is nothing phase-aware in it.

### Six interface points → OpenCode primitives

| Point | OpenCode binding | Negotiated axis value | Degradation |
|---|---|---|---|
| 1 Command | slash-file commands projected to the xdg command dir (`gsd:`-namespaced); plugin may also surface entrypoints as custom `tool()`s and drive `tui.command.execute` | `commandSurface: slash-file` | none (full) |
| 2 Dispatch | `mode: subagent` / `@`-mention; `subtask` is **synchronous-only** | `dispatch: { namedDispatch:true, nested:true, background:false, subagentToolkit:'full' }` | no background → waves run inline (the #853 flatten rule) |
| 3 Model | per-agent `model` field on the agent `.md`; no provider `sendRequest` | `modelMode: passive` | tier routing degrades to per-agent model field |
| 4 Hooks | host `event` bus (~25 events) | `hookBus: host`; ADR-1016 dialect = **`opencode-subset`** | session/tool-scoped only — see gap below |
| 5 State | filesystem `.planning/` + config under xdg `~/.config/opencode`; `opencode-jsonc` permissions sidecar (`permissionWriter: 'opencode'`) | `stateIO: filesystem` | `configHome` write-confinement applies |
| 6 Artifact | native Agent Skills + `@agent` subagents + slash commands | — | none (full) |

**Portable event floor → OpenCode events:** `SessionStart` ≈ plugin-init + `session.created`; `PreToolUse`/`PostToolUse` ≈ `tool.execute.before`/`after`; `Stop` ≈ `session.idle`; `SessionEnd` ≈ `session.deleted`; `PreCompact` ≈ `experimental.session.compacting`. `shell.env` covers env injection; `command.executed`, `file.edited`, and `permission.asked`/`replied` are extended events GSD can subscribe to but does not require.

### The load-bearing gap: the loop is phase-scoped, the bus is session-scoped

OpenCode's bus fires on **sessions, tools, files, and permissions** — never on **workflow phases**. GSD's 12 loop extension points (`plan:pre`, `verify:post`, `ship:post`…) have **no event on this bus**. So the imperative adapter for OpenCode cannot drive the loop *from host events*; the engine must own phase sequencing internally and treat OpenCode's bus as a **subset hook surface** (exactly what the ADR-1016 `opencode-subset` dialect already encodes). Concretely:

- **Steps, gates, and most contributions fire from GSD's own workflow/command invocation (point 1), engine-side** — not from the host bus. The plugin invokes `gsd-tools.cjs` (via `$` or the companion MCP server) and the engine runs the loop resolver.
- **Only the contributions that align with a real host event bind to the bus.** The clean case is memory: a MemPalace-style capability's capture/recall already keys on `discuss:post`/`plan:post`/`verify:post`; those can *additionally* bind to `experimental.session.compacting` so memory persists across OpenCode's compaction — a concrete win the host gives us for free.
- **Gates that cannot be evaluated at a host event fail closed**, reusing the overlay model's synthetic-blocking-gate semantics (see `capability-overlay-model.md`) — never fail open just because the host lacks a phase event.

### How a capability reaches OpenCode (two adapters, one engine)

1. **Declarative (today, via ADR-1016 projection).** The capability's `skills`/`agents`/commands convert into OpenCode's xdg home; OpenCode runs them as native skills/subagents. **Lossy by design:** `steps`/`contributions`/`gates` — the orchestration — are dropped, because projection has no loop. Good enough when the capability is "just skills."

2. **Imperative (this ADR, the faithful path).** A thin `@opengsd/opencode-plugin` (or local `.opencode/plugins/gsd.ts`) that on init calls the engine's `loadRegistry({ includeInstalled: true })` as a library, composing first-party ∪ installed capability overlays with the **same** precedence, consent, and fail-closed-gate guarantees GSD already enforces — then binds the composed registry to the OpenCode primitives in the table above. The plugin stays thin **because it does not reimplement the loop resolver**; it delegates to it. This is the difference between "port the capability to OpenCode" (rebuilds the loop in a place that can't express it) and "embed the engine under OpenCode" (the loop stays where it lives).

### Lowest-effort first cut

Because OpenCode consumes MCP, the **companion MCP server** (the MemPalace pattern, already shipping) binds interface points 1 + 5 with **no bespoke plugin at all** — OpenCode connects to it like any MCP server and gets GSD command + state IO. Ship that first; add the thin `event`-bus plugin only to capture the `experimental.session.compacting` / `session.idle` bindings that MCP cannot reach. Sequence for #1239 Phase D: **(i)** MCP-companion binding → **(ii)** declarative skill projection (already built) → **(iii)** thin imperative plugin for the compaction/idle hooks → **(iv)** golden parity vs. the Claude reference host.

### New open question (OpenCode-specific)

- OpenCode installs plugins with **Bun**, but the engine matrix lists `runtime: node`. Decide whether the imperative plugin invokes the engine in-process (requires Bun-compatible engine entry) or shells out to a Node `gsd-tools.cjs` via `$` — and whether the companion MCP server makes that question moot for the first cut.

## Alternatives considered

1. **Projection-only (ADR-1016 as-is)** — rejected: never embeds; reverses the dependency.
2. **Per-host bespoke integrations** — rejected: the add-a-host tax ADR-857 exists to end.
3. **Expose only `gsd-tools.cjs` as "the API"** — rejected: the engine is the *loop* (dispatch + hooks + model + state), not just deterministic CLI ops; the six points are irreducible.
4. **One embedding mode** — rejected: the research shows hosts are split imperative/declarative; forcing one strands half of them. Two adapters behind one interface is the minimum.
5. **Fold into #956 (Connected Capabilities)** — rejected: that's the heavier code-loading door; the host door is data + thin adapter (the "wrong altitude" finding).

## Open questions (narrowed by the research)

- Exact wire-shape of the `initialize` handshake — in-process descriptor merge (declarative) vs a serialized capability exchange (imperative/SDK hosts like pi/VS Code).
- Where precisely to cut the engine↔host boundary (which modules are "engine" vs "host adapter").
- Whether the **companion MCP server** becomes the *primary* imperative transport (it covers points 1+5 on nearly every host) — and the pi fallback.
- The degradation ladder's *fatal-vs-degradable* line per point (e.g. is `prose-only` command surface acceptable, or does Codex stay projection-only?).
- Interface versioning/deprecation policy across capability-set evolution.

## Appendix — per-host capability matrix (research evidence)

| Host | Mode | Cmd surface | Dispatch | Model | Hook bus (events) | MCP | Runtime |
|---|---|---|---|---|---|---|---|
| Claude Code | imperative | slash-file (`gsd:`-ns) | nested fg ∞ / bg depth-5; `Agent()` | passive (per-subagent `model`) | host (30) | yes (bundle) | node |
| pi (pi.dev) | imperative | slash-programmatic | no named dispatch; SDK sub-session | **active** (providers + `before_provider_request`) | host (~30 fine) | community ext | **bun** |
| OpenCode | imperative | slash-file | `mode:subagent`/`@`; `subtask` sync | per-agent model | host (~25) | yes | node |
| VS Code | imperative/**IDE** | palette + chat `/` | DIY `lm` tool-loop | **active** (`vscode.lm`, no system msg) | **engine-owned** (none) | yes (provider) | node / **sandboxed-web** |
| Codex | declarative | **prose-only** + `/skills` | `max_depth=1` | passive (session-only) | host (10, command-only) | yes | node |
| Gemini CLI | declarative | slash-toml (`gsd.`-ns) | **flat** (no nesting) | passive (sub-agent `model:`) | host (10: BeforeAgent/Model/Tool) | yes | node |
| Cursor | declarative | slash-file (`gsd-`-ns) | host sub-agents; 19 hook events | passive | host (19) | yes | node |
| Cline | declarative (rules) | slash-file | `use_subagents` depth-2 read-only | passive | **none** (rules) / SDK `beforeTool` | yes | node |
| Hermes | declarative | slash-file | `delegate_task` depth-2 + kanban | passive (`pre/post_llm_call` unbound) | host (6) writes shared config | yes | node |
