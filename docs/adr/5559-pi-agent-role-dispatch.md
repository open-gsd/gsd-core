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

### 1. Mechanism: a child `pi` process per role, fail closed

`pi/gsd.cjs` registers a second tool, **`gsd_dispatch`**, with parameters `{ role: string, task: string }`. Its `execute` resolves the role, spawns a child `pi` process, and returns the child's final assistant text as the tool result. The child is an isolated context window with its own tool allowlist, the isolation Claude's `Agent` gives.

**Child argv (asserted by test), in full:**

| Flag | Why |
|---|---|
| `--mode json -p --no-session` | one invocation, structured events, nothing persisted |
| `--append-system-prompt <absolute path of the role file>` | the role prompt travels as a path, never inlined into argv |
| `--tools <role frontmatter list>`; a role without `tools` gets `--tools -gsd_dispatch` (Pi's defaults minus the dispatch tool, the only-minus form in `docs/cli.md`) | tool allowlist |
| `--no-mcp` | `--tools` keeps MCP tools unless an entry starts with `mcp__`, so the allowlist alone is not a restriction; the child gets no MCP |
| `--no-extensions` | the child must not load `gsd.js` and re-register `gsd_dispatch`, and must not auto-load a hostile repository's `.pi/extensions`. Roles reach `gsd-tools` through `bash`, as on every other host |
| `--no-approve` | the child never trusts project-local files (`.pi/settings.json`, prompts, skills, extensions) and `-p` can never stall on a trust prompt |
| `--model <role model>` only when the role file pins one | otherwise the child inherits Pi's default |
| `@<task file>` | the task text is written to a file and passed as an `@file` argument (Pi resolves it from cwd, so the path is absolute), so a task larger than the Windows argv limit (32,767 characters; chunk at 28K) cannot abort the spawn |
| env `GSD_PI_DISPATCH_DEPTH` = parent depth + 1 | defense in depth only; the structural cap is that the child has no `gsd_dispatch` (`--no-extensions`) |

Context files (`AGENTS.md`, `CLAUDE.md`) still load in the child: Pi loads them independent of project trust (`docs/security.md`), and roles on Claude see them too. This is accepted, not an omission. The child also inherits the parent's full environment, including provider API keys, as any `bash` a role runs would; GSD adds no credential handling and no scrubbing. This is accepted for the same reason a Claude subagent inherits its parent's environment.

**Task file.** Created inside a directory made with `mkdtemp` (mode `0700`, unpredictable name), absolute path, removed in a `finally` after the child exits or is killed. Whether Pi presents an `@file` argument to the model as the user's task was not probed (no credential on the verification machine); it is the first thing the live smoke test checks. If it does not, the task moves to a positional `Task: …` message, which the reference extension uses, with the file retained only above 28K.

**Role resolution.** `gsd_dispatch` resolves a role by listing the single directory `ROLE_DIR = <directory of the running extension file>/../agents` and matching `<role>.md` among the listing's entries, never by joining the caller's string onto a path. It `lstat`-rejects a symlinked role file. The role id must match `^gsd-[a-z0-9-]+$`. `ROLE_DIR` is by construction the `agents/` directory of the install the running extension belongs to: `<configHome>/agents` for a global install, `.pi/agents` for a local one, `<package root>/agents` for the Phase 1b package. It is never searched across scopes or taken from the project's cwd. A project-committed `.pi/agents/gsd-x.md` therefore cannot shadow the user-level role, and, because the installer records a content hash per installed file in its manifest (`writeManifest`), `gsd_dispatch` also verifies the role file's hash against that entry and returns `role-tampered` on mismatch. Phase 2b adds the role files to the manifest `files` map.

**Fail-closed results.** Each is an error result returned to the model, never a throw, never an inline fallback:

| Code | When |
|---|---|
| `role-unresolved` | malformed id, role not in `ROLE_DIR`, or role file is a symlink |
| `role-tampered` | role file hash differs from the install manifest |
| `pi-not-found` | no runnable `pi` (`process.execPath`-relative CLI, else `PATH`) |
| `depth-exceeded` | `GSD_PI_DISPATCH_DEPTH` ≥ 1 |
| `timeout` | child exceeds the dispatch timeout (default 30 minutes, `GSD_PI_DISPATCH_TIMEOUT_MS`) or the tool's abort signal fires |
| `child-failed` | exit non-zero, or the final assistant message's `stopReason` is `error`, `aborted` or `length` (the three `docs/cli-integration.md` treats as failure) |

**Process control.** The child is started with `spawn` (never `spawnSync`, which would block Pi's extension host) in its own process group on POSIX (`detached: true`). Timeout and abort send `SIGTERM` to the group (`process.kill(-pid)`), then `SIGKILL` after a 5 second grace, so `bash` grandchildren do not outlive the role. On Windows the kill is `taskkill /T /F /PID <pid>`, itself bounded at 10 seconds. A kill that fails is reported inside the `timeout` result, not thrown.

**Output handling.** stdout is parsed incrementally as JSONL and events are discarded as they pass; only the final assistant message text is retained, capped at 1 MiB with a visible truncation marker. stderr is kept as an 8 KiB tail. "Final" means the last assistant `message_end` observed before `agent_settled`; `agent_end` is not used because automatic retry can follow it. A run whose last assistant message is a retried error and whose retry succeeds reports the retry's text.

### 2. Execution mode: strictly sequential

Pi dispatch is flat (a child has no dispatch tool) and sequential: `gsd_dispatch` serializes calls behind a single in-process queue, so a wave the workflow expresses as parallel calls runs one at a time. The concurrency of 1 is a property of the extension, not of the host descriptor (which is unchanged, §5). Raising it needs evidence that Pi runs the tool calls of one assistant turn concurrently and that two children do not contend on credentials; that is a later amendment.

**Nested roles.** Flat dispatch makes a role that itself spawns roles undispatchable. `agents/` contains exactly one: `gsd-debug-session-manager` (its `tools:` list includes `Agent`; it spawns `gsd-debugger`). Decision: the `/gsd-debug` flow is **`unsupported-on-pi`** with the reason "needs nested dispatch; Pi dispatch is flat". Phase 4's parity matrix records that disposition and a test pins it; the installed Pi command prints the reason instead of starting. _Amended by #5630: `list` and `status <slug>` start no agent and run on Pi, so the skill is `partial-on-pi` (`PI_PARTIAL_SKILLS`); `new`, `continue` and `--diagnose` keep the `unsupported-on-pi` behavior above._ Nested dispatch (`maxDepth: 2`) is not adopted: the recursion cap would then rest on an env var instead of on the child's lack of the tool.

### 3. Role prompts install as `agents/gsd-*.md` under the Pi config home

Phase 2b adds `{ kind: "agents", destSubpath: "agents", prefix: "gsd-", nesting: "flat", recursive: false, converter: "convertClaudeAgentToPiAgent" }` to the Pi `artifactLayout`, both scopes, mirroring the Hermes layout. `<configHome>/agents/` is the directory Pi's reference subagent extension already scans, so a user who runs that extension also sees GSD roles; the `gsd-` prefix keeps them from colliding with user-authored agents. Pi core does not load this directory; only `gsd_dispatch` and the reference extension read it.

`convertClaudeAgentToPiAgent` emits `name`, `description`, `tools` (Claude tool names mapped to Pi's lowercase tool names; an unmappable tool is dropped and recorded, never passed through), and the role body with the Pi content-rewrite profile applied. It omits `model` unless the active model profile bakes one. The `.compact.md` variants are not installed for Pi.

### 4. Workflow text projects onto `gsd_dispatch`

The existing contract in `projectNamedDispatchToStructuralDelegate` (`bin/install.js`) is for a host whose dispatch tool takes the role prompt as an argument: it rewrites `Agent(subagent_type="gsd-x", …)` into `<toolName>(<namedRoleParam>=gsd-x, <promptContentParam>=<resolve the role and load its contents; FAIL CLOSED…>, <structuralRoleParam>="<leaf>")`, leaving the model to load and pass the prompt. Pi's `gsd_dispatch` resolves the prompt itself (§1), so passing contents through the model would be both larger and less safe. Phase 2b therefore adds one field to the projection's `toolConfig`: `rolePromptResolution: 'tool'`. When set, the projection emits only `<namedRoleParam>=<role>` and `<taskParam>=<prompt text>` and omits the contents and structural-role arguments. Output for every other runtime is unchanged and stays byte-identical (the existing Hermes projection tests pin it). Pi's configuration: `toolName: "gsd_dispatch"`, `namedRoleParam: "role"`, `taskParam: "task"`, `supportsPerCallModel: false`, no background parameter, `rolePromptResolution: 'tool'`, `availableRoles` from `_resolveAvailableGsdRoles()`.

The install-time fail-closed seam is the existing `_assertRoleResolvable` (#2284): a workflow that names a `gsd-*` role with no shipped `agents/<role>.md` makes the install throw. Phase 2b keeps that call on the Pi path.

### 5. Descriptor stays a statement of host facts

`capabilities/pi/capability.json` keeps `namedDispatch: false`, `maxDepth: 0`, `subagentToolkit: "undocumented"` and `maxConcurrency: "undocumented"`: they describe what Pi itself provides, and Pi provides no subagent primitive. The properties of GSD's own dispatch (flat, sequential, timeout) live in the extension and the projection configuration. `degradationFor('dispatch', …)` therefore continues to return `absent` with the fallback `single-agent inline / SDK sub-session`. That string is descriptive. This ADR designates the **sub-session** half as the realized fallback and rules out the **inline** half; the guard that enforces it is the projection in §4 (an installed Pi workflow never contains an `Agent(` call), and Phase 2b audits the consumers of `degradationFor('dispatch')` and records that none executes the fallback.

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
- The child inherits the parent's environment and working directory (§1 records this as accepted). GSD adds no credential handling.
- `/gsd-debug` is `unsupported-on-pi` until nested dispatch is separately decided (§2). Amended by #5630: `list` and `status <slug>` run on Pi because they start no agent; the rest stays unsupported.
- The set of roles installed on Pi equals the set installed for Claude (non-compact agent files). Phase 4's parity matrix pins this.

## Acceptance (testable)

Phase 2b is accepted when items 1-6 hold; each is a behavioral test, none inspects source text. Item 7 is a live check owned by Phase 4 and does not gate 2b.

1. **Argv contract.** With an injected spawn seam, `gsd_dispatch({role:"gsd-roadmapper", task})` spawns `pi` with exactly the argument set in §1 (including `--no-extensions`, `--no-approve`, `--no-mcp`), the role file path (not its contents) after `--append-system-prompt`, the task as an absolute `@file`, `GSD_PI_DISPATCH_DEPTH=1` in the child env, and a `0700` temp directory that no longer exists after return, kill and failure.
2. **Boundary on task size.** Tasks of 28,000 - 1, 28,000 and 28,000 + 1 characters spawn with identical argv length.
3. **Fail closed.** Unknown role, malformed id, symlinked role file, hash mismatch, missing `pi`, depth ≥ 1 and non-zero exit each return the named code and never run the role in-session. A `fast-check` property over arbitrary role strings asserts only ids matching `^gsd-[a-z0-9-]+$` that are present in `ROLE_DIR` ever reach a spawn. A project-committed `<cwd>/.pi/agents/gsd-x.md` is never read when the running extension lives elsewhere.
4. **Timeout, kill, output bounds.** Driven by `mock.timers` with an injected process seam: timeout and abort send `SIGTERM` to the group then `SIGKILL` after the grace; a child that exits on `SIGTERM` is not sent `SIGKILL`; stdout of N+1 MiB retains at most the cap with the truncation marker; stderr retains the tail. A retried-then-successful run reports the retry's text; `error`, `aborted` and `length` stop reasons map to `child-failed`.
5. **Projection.** For every Pi-installed workflow and command, `findDispatchCallSpans(content, 'Agent')` returns no span and no `subagent_type=` argument remains; every `gsd_dispatch(role=…)` names a role file present in the Pi install; an install whose workflow names an absent role throws (`_assertRoleResolvable`). Output for hermes, kimi and the other projecting runtimes is byte-identical to before.
6. **Install parity.** The roles installed for Pi equal the non-compact `agents/*.md` set; the Pi descriptor's dispatch axes are unchanged; `/gsd-debug` is recorded with its reason and prints it for every form except `list` and `status <slug>` (`partial-on-pi`, #5630).
7. **Live (Phase 4, [#5561](https://github.com/open-gsd/gsd-core/issues/5561)).** One `new-project` run through a live Pi session reaches `gsd-research-synthesizer` and `gsd-roadmapper` and writes `.planning/` files; the same run confirms Pi presents the `@file` task to the child as its task.

## Amendment (2026-10-20): Pi package distribution (#5558)

Phase 1b ([#5558](https://github.com/open-gsd/gsd-core/issues/5558)) adds `pi install npm:@opengsd/gsd-core` as a second way to put GSD in Pi. Decisions recorded here because they fix where role files live for dispatch:

- **Name, version, pipeline.** The Pi package is the existing `@opengsd/gsd-core` npm package (a `pi` manifest and the `pi-package` keyword in its `package.json`), not a second package. One version stream, the existing release workflow, no extra publish step. Publishing to npm stays a maintainer action.
- **One extension file.** The manifest names `./pi/gsd.cjs`, the file the installer copies to `extensions/gsd.js`. Pi loads an explicit `.cjs` manifest path (verified on Pi 1.3.0).
- **Skills are rendered, not installed.** Skill bodies embed the absolute engine path. The templates in `pi/package-skills/` are the installer's output with the engine root replaced by a token (`npm run gen:pi-package-skills`, checked by `lint:generated-sync`); the extension renders them for the real package root into a `gsd-package-cache` directory under the Pi agent directory (`<id>/skills` inside it) and returns that skills directory from `resources_discover`. A test pins render(template, R) byte-identical to the installer's skills for config dir R, so the two paths cannot diverge.
- **`ROLE_DIR` in the package.** The invariant in section 1 (`<extension directory>/../agents`) holds for the package: the extension is `<package root>/pi/gsd.cjs` and the roles are `<package root>/agents`. Phase 2b must install the converted Pi role files where `ROLE_DIR` resolves for each layout; for the package that means shipping the converted files in the tarball, not the Claude-format `agents/` directory the tarball carries today.
- **One path at a time.** If the installer's `extensions/gsd.js` is also present, the package copy stands down with a warning.
