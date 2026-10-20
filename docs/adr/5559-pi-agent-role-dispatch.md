# ADR-5559: Agent-role dispatch on Pi — a GSD-owned `gsd_dispatch` tool that runs each role in an isolated `pi` child process

- **Status:** Accepted
- **Date:** 2026-10-20
- **Issue:** [#5559](https://github.com/open-gsd/gsd-core/issues/5559) — Phase 2a of epic [#5556](https://github.com/open-gsd/gsd-core/issues/5556) (Pi runtime parity)
- **Builds on:** [ADR-1239](1239-gsd-embeddable-orchestration-engine.md) (interface point 2, agent dispatch, and the negotiated-degradation contract), [ADR-3660](3660-runtime-artifact-layout-module.md) (where artifacts install)
- **Unblocks:** Phase 1b ([#5558](https://github.com/open-gsd/gsd-core/issues/5558)) and Phase 2b (dispatch implementation; filed from this ADR)

## Context

Every GSD workflow that spawns a role (`new-project` spawns `gsd-project-researcher`, `gsd-research-synthesizer` and `gsd-roadmapper`; `plan-phase`, `execute-phase` and `map-codebase` spawn more) is written against Claude Code's `Agent(subagent_type="gsd-…")`. A host with no equivalent primitive needs a decision for what that call becomes.

Facts, each verified against the tree or against Pi 1.3.0 installed locally (`pi --version` → `1.3.0`):

- `capabilities/pi/capability.json` declares `dispatch.namedDispatch: false`, `maxDepth: 0`, `subagentToolkit: "undocumented"`, `maxConcurrency: "undocumented"`. `degradationFor('dispatch', …)` (`src/host-integration.cts`) therefore returns `{ level: 'absent', fallback: 'single-agent inline / SDK sub-session' }`.
- `projectNamedDispatchToStructuralDelegate` (`bin/install.js`) already defines the contract for a host without named dispatch: GSD resolves the role's prompt file from the active install, embeds its contents as the dispatched task's operating instructions, and **fails closed — surfaces an explicit error and stops — if the role prompt cannot be resolved; it never executes the role inline as a substitute.**
- Pi has no subagent primitive. Its own docs (`docs/sdk.md`, `docs/cli-integration.md`) give two supported ways to run a second agent: in-process `createAgentSession()` from `@earendil-works/pi-coding-agent`, or a child process — "For a language-independent or isolated subprocess, see CLI Integration". The `pi` binary accepts `--mode json|rpc`, `-p/--print`, `--no-session`, `--append-system-prompt <text|file>`, `--tools <allowlist>`, `--model`, and `@file` arguments.
- Pi ships a reference `subagent` extension (`examples/extensions/subagent/index.ts`) that implements exactly the child-process form: `spawn(pi, ["--mode","json","-p","--no-session", "--model", m, "--tools", t, "--append-system-prompt", <role prompt file>, "Task: …"])`, with agent definitions as markdown files with `name`, `description`, `tools`, `model` frontmatter. It loads user-level agents by default and treats project-local agents (`.pi/agents/`) as a trust decision.
- Probe on this machine: `pi --mode json -p --no-session --no-extensions --tools read --append-system-prompt <file> "go"` is accepted and emits the session header; the run then stops at "No API key found for the selected model". The flags exist and parse on 1.3.0; a completed model run was not observable here and is owed to the live verification in Phase 4 ([#5561](https://github.com/open-gsd/gsd-core/issues/5561)).
- `src/host-integration.cts` records that nesting is a numeric sub-field with a fail-closed floor, and the VS Code adapter (`vscode/extension.js`, `dispatchAsSubagent`) already refuses dispatch when `depth > GSD_MAX_SUBAGENT_DEPTH`.

## Decision

Pi keeps `namedDispatch: false` (the host has no primitive). GSD supplies the dispatch itself.

### 1. Mechanism: child `pi` process, fail closed

`pi/gsd.cjs` registers a second tool, **`gsd_dispatch`**, with parameters `{ role: string, task: string }`. Its `execute` resolves the role, spawns a child `pi` process, and returns the child's final assistant text as the tool result. The child is an isolated context window with its own tool allowlist, the same isolation Claude's `Agent` gives.

Argument contract of the spawned child (asserted by test):

- `--mode json -p --no-session`
- `--append-system-prompt <absolute path to the installed role file>` — the role prompt travels as a file path, never inlined into argv
- `--tools <comma list from the role's frontmatter>` — an allowlist; a role file without `tools` gets Pi's default set minus `gsd_dispatch`
- `--model <role model>` only when the role file pins one; otherwise the child inherits Pi's configured default
- the task text is written to a temp file and passed as an `@file` argument, so a task larger than the Windows argv limit (32,767 characters; chunk at 28K) cannot abort the spawn
- `env.GSD_PI_DISPATCH_DEPTH` set to parent depth + 1

Fail-closed rules (each is an error result returned to the model, never a throw, never an inline fallback):

1. `role` does not match `^gsd-[a-z0-9-]+$`, or no installed role file with that name exists → `role-unresolved`.
2. No runnable `pi` executable can be resolved (`process.execPath`-relative CLI, else `PATH`) → `pi-not-found`.
3. `GSD_PI_DISPATCH_DEPTH` ≥ 1 → `depth-exceeded`. Pi dispatch is flat: `nested: false`, `maxDepth: 1`. A role that itself needs to spawn a role is a workflow defect to surface, as on every other flat host.
4. The child exceeds the dispatch timeout (default 30 minutes, overridable by `GSD_PI_DISPATCH_TIMEOUT_MS`) → the child is killed, result `timeout`. The spawn is asynchronous (`spawn`, not `spawnSync`) and forwards the tool's abort signal as a kill, so a long role does not block Pi's extension host.
5. Child exits non-zero, or its final assistant stop reason is `error`/`aborted`/`length` → `child-failed`, with the child's stderr tail.

### 2. Execution mode: strictly sequential

`maxConcurrency` is declared **1** for Pi. Workflows that dispatch a wave in parallel run it as sequential `gsd_dispatch` calls. Raising it requires evidence that Pi runs tool calls from one assistant turn concurrently and that two children do not contend on credentials or session storage; that evidence is a later amendment, not part of this decision.

### 3. Role prompts install as `agents/gsd-*.md` under the Pi config home

Phase 2b adds `{ kind: "agents", destSubpath: "agents", prefix: "gsd-", nesting: "flat", recursive: false, converter: "convertClaudeAgentToPiAgent" }` to the Pi `artifactLayout`, both scopes, mirroring the Hermes layout. `<configHome>/agents/` is the directory Pi's reference subagent extension already scans, so a user who runs that extension also sees GSD roles, and the `gsd-` prefix keeps them from colliding with user-authored agents. Pi core does not load this directory; only `gsd_dispatch` and the reference extension read it.

`convertClaudeAgentToPiAgent` emits `name`, `description`, `tools` (Claude tool names mapped to Pi's lowercase tool names; an unmappable tool is dropped and recorded, never passed through), and the role body with the Pi content-rewrite profile applied. It omits `model` unless the active model profile bakes one.

`gsd_dispatch` reads **only** the user-level or the GSD-installed role directory it was installed with. It never reads a project-local `.pi/agents/`: a repository-controlled prompt that runs with shell tools is the trust boundary Pi's own reference extension gates, and GSD does not widen it.

### 4. Workflow text projects to `gsd_dispatch`, fail closed

The install-time content projection for Pi extends `projectNamedDispatchToStructuralDelegate` with a Pi tool configuration: `toolName: "gsd_dispatch"`, named-role parameter `role`, task parameter `task`, no per-call model parameter (`supportsPerCallModel: false`), no background parameter. Every `Agent(subagent_type="gsd-x", prompt=…)` in an installed workflow becomes `gsd_dispatch(role="gsd-x", task=…)`. The existing fail-closed assertion stays: a workflow that references a role absent from the install fails the install, not at run time.

### 5. Descriptor stays a statement of host facts

`capabilities/pi/capability.json` keeps `namedDispatch: false`, `maxDepth: 0` and `subagentToolkit: "undocumented"`: they describe what Pi itself provides, and Pi provides no subagent primitive. The properties of GSD's own dispatch (flat, depth 1, sequential, timeout) live in the Pi extension and the projection configuration, not in the host axes. `degradationFor('dispatch', …)` therefore continues to return `absent` with the fallback `single-agent inline / SDK sub-session`; this ADR designates the **sub-session** half of that fallback as the realized one and rules out the **inline** half.

## Rejected alternatives

| Alternative | Why not |
|---|---|
| **Fail closed only** (workflows that spawn roles stop with a message) | Meets "never a bare JSON bundle" for the epic criterion but leaves `new-project`, `plan-phase`, `execute-phase` and every other agent-driven flow unreachable on Pi. Retained as the failure mode for every unresolved or unsafe case above, not as the feature. |
| **Gated inline execution** (the orchestrating session adopts the role prompt itself) | The existing projection contract forbids it by name: "never execute the role inline as a substitute". It also removes the isolation that keeps a researcher's tool output out of the orchestrator's context, which is the reason roles exist. |
| **In-process `createAgentSession()`** | The extension runs inside Pi's own Node process; importing `@earendil-works/pi-coding-agent` from `pi/gsd.cjs` couples the extension to Pi's internal module graph and version, and the extension is a single `.js` file with no dependency install step (#2470). A child process uses only the documented CLI surface and survives Pi upgrades that reshuffle internals. |
| **RPC mode child** (`--mode rpc`) | Bidirectional control is not needed for one task in, one result out; it adds a framing protocol and lifecycle to own. `--mode json -p` is one invocation with one exit status. |
| **Depend on a community subagent extension** | Pi 1.3.0 ships it only as an example. GSD cannot make a workflow's correctness depend on a package the user may not have installed or may configure differently. |
| **Read roles from project-local `.pi/agents/`** | Trust boundary above. |

## Consequences

- Phase 2b has no remaining design questions: tool name and parameters, child argv, failure codes, depth and timeout, concurrency, install location, converter name and projection config are fixed here.
- Each dispatch pays a `pi` process start and model session. Waves are sequential on Pi. Both are documented limits, not defects.
- The child inherits the parent's credentials and working directory through `pi`'s own configuration. GSD adds no credential handling.
- The set of roles installed on Pi equals the set installed for Claude (non-compact agent files). Phase 4's parity matrix pins this.

## Acceptance (testable)

Phase 2b is accepted when all hold; each is a behavioral test, none inspects source text:

1. **Argv contract.** With an injected spawn seam, `gsd_dispatch({role:"gsd-roadmapper", task})` spawns `pi` with exactly the argument set in §1, the role file path (not its contents) after `--append-system-prompt`, the task as an `@file`, and `GSD_PI_DISPATCH_DEPTH=1` in the child env.
2. **Boundary on task size.** A task of 28,000 − 1, 28,000 and 28,000 + 1 characters spawns identically (argv length does not grow with the task).
3. **Fail closed.** Unknown role, malformed role id, missing `pi`, depth ≥ 1, timeout, and non-zero child exit each return the named error code and never run the role in-session. A property test over arbitrary role strings asserts only ids matching `^gsd-[a-z0-9-]+$` and present in the install ever reach a spawn.
4. **Timeout without wall-clock.** The timeout path is driven by `mock.timers`; the child is killed and the abort signal also kills it.
5. **Projection.** After install for Pi, no installed workflow contains `Agent(` or `subagent_type`; every `gsd_dispatch(role="…")` names a role file present in the Pi install; an install whose workflow names an absent role fails.
6. **Install parity.** The roles installed for Pi equal the non-compact `agents/*.md` set, and the Pi descriptor's dispatch axes are unchanged (`degradationFor('dispatch', …)` still reports `absent`; the host has no primitive).
7. **Live.** One `new-project` run through a live Pi session reaches `gsd-research-synthesizer` and `gsd-roadmapper` and writes `.planning/` files (verified in Phase 4, [#5561](https://github.com/open-gsd/gsd-core/issues/5561)).
