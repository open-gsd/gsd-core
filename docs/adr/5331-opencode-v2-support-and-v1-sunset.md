# ADR-5331: OpenCode 2.x support as a version-gated target of the `opencode` runtime, and sunset of OpenCode 1.x support

- **Status:** Proposed (Phase 0 — ADR only. **No production code lands in this PR.** `Proposed` is deliberate: ADR wording is maintainer-owned, and eight questions below are recorded as *undecided* because they can only be answered by running a real OpenCode 2.x with a model provider. Phases 1–4 execute against this ADR once a maintainer ratifies it.)
- **Date:** 2026-10-12
- **Issue:** [#5331](https://github.com/open-gsd/gsd-core/issues/5331) — epic (`feature-request` + `approved-feature`). This Phase-0 sub-issue: [#5336](https://github.com/open-gsd/gsd-core/issues/5336)
- **Builds on:** [ADR-1239](1239-gsd-embeddable-orchestration-engine.md) (**EoS**; its OpenCode binding describes the V1 plugin and event surface), [ADR-1016](1016-runtime-capability-descriptor.md) (runtime capability descriptor), [ADR-0008](0008-installer-migration-module.md) (installer migrations)
- **Relationship to prior work:** neither supersedes nor amends an accepted ADR. It specifies the V2 surface that [ADR-1239](1239-gsd-embeddable-orchestration-engine.md)'s OpenCode binding does not cover; a dated amendment note in that ADR is Phase 3 documentation work. Same epic-plus-Phase-0 shape as [ADR-2313](2313-codex-passive-model-posture.md).
- **Sub-issues:** Phase 1 [#5337](https://github.com/open-gsd/gsd-core/issues/5337) · Phase 2 [#5338](https://github.com/open-gsd/gsd-core/issues/5338) · Phase 3 [#5339](https://github.com/open-gsd/gsd-core/issues/5339) · Phase 4 [#5340](https://github.com/open-gsd/gsd-core/issues/5340)

## Context

OpenCode 2.0 shipped as `@opencode/cli`; at the time of writing `npm` `latest` is `2.0.27` and the V1 line's `latest` is `1.19.0` (E1). GSD's `opencode` runtime was built for the V1 line.

**What OpenCode says changed.** The official migration guide lists exactly three intentional breaking changes: a new plugin API, new server API and client contracts, and terminal-client configuration moving to one global `cli.json` ([D1](https://opencode.ai/v2/docs/migrate-v1/)). Everything else — "existing supported server config fields, agent definitions, command definitions, skills, and other files in `.opencode/`" — is intended to keep working, and a supported behavior that breaks is "a compatibility bug rather than an expected migration requirement" ([D1]). V1 and V2 "both use the `opencode` command and are no longer installed side by side by default"; the V2 installer "replaces the V1 binary" ([D1]). They read the same config locations, and V2 normalizes V1-shaped fields in memory without rewriting the file ([D1]).

**What GSD ships for OpenCode today** (v1.16.0). One descriptor, `capabilities/opencode/capability.json`, drives a flat `commands/gsd-*.md` layout, a duplicate `skills/gsd-*` layout, `agents/gsd-*.md`, a native plugin `plugins/gsd-core.js`, and edits to `opencode.json(c)` (`permission.read`, `permission.external_directory`, and an `mcp.gsd` entry). The plugin is a V1 object entrypoint (`module.exports = { server }`) that invokes 11 hook scripts: six pre-tool guards, the read-injection scanner and the context monitor on the tool hooks, and three session/file scripts (`.opencode/plugins/gsd-core.js:634-791`). The CLI wiring uses `opencode run --dir <cwd>` for worktree dispatch (`orchestratorExec.cwdFlag`) and renders reasoning effort as `--variant <level>` for the reviewer lane (`src/model-catalog.cts:333`, `capabilities/opencode/capability.json:111-118`, `:150-164`).

**What breaks, as observed on real binaries** (E-numbers refer to the register below):

- The plugin is rejected by OpenCode 2.0.27 at every start with `Plugin must export a default definition with an id and an effect or setup function` (E5). The failure is a WARN in the server log; the run continues and `plugin list` shows nothing, so a user sees no error while every GSD guard is absent.
- OpenCode 2.0.27's `opencode run` has no `--dir` and no `--variant`; both exit 1 with usage (E3).
- V2's tool ids are `shell`, `patch` and `subagent` where V1 used `bash`, `apply_patch` and `task` ([D6](https://opencode.ai/v2/docs/tools)). GSD's `TOOL_NAME_MAP` (`.opencode/plugins/gsd-core.js:136-149`) has no `shell` and no `patch` entry.
- A V1 binary cannot open a data directory that V2 has used (`Database is not empty and has no session table`), while V2 opened a directory V1 created (E8). An in-place upgrade (`opencode upgrade --major`, "upgrade to OpenCode 2 and remove OpenCode 1", E9) therefore cannot be rolled back by reinstalling V1.

**What works unchanged, as observed.** GSD's V1-shaped `permission.*` and `mcp.gsd` keys load on 2.0.27 with no config warning, and V2 tried to start the `gsd` MCP server (E7). V2 discovers the `commands/`, `agents/` and `skills/` directories GSD already writes ([D1] § Agent, Command and Skill files).

**Kilo.** Kilo reuses GSD's OpenCode-family install pipeline but runs on the OpenCode **1.x** line: "Kilo CLI is a fork of OpenCode" with the V1 plugin shape ([K1](https://kilo.ai/docs/code-with-ai/platforms/cli), [K2](https://kilo.ai/docs/automate/extending/plugins)); its `main` "stays the V1 product line" and its V2 port is an internal preview with an isolated `kilo2` identity ([K3](https://github.com/Kilo-Org/kilocode/issues/13750), [K4](https://github.com/Kilo-Org/kilocode/issues/12887)). A change that removes the V1 path from shared code would break Kilo.

**Adjacent defects found while researching this.** The OpenCode uninstaller leaves files and keys behind ([#5335](https://github.com/open-gsd/gsd-core/issues/5335), [#5333](https://github.com/open-gsd/gsd-core/issues/5333)) and the installer drops JSONC comments ([#5334](https://github.com/open-gsd/gsd-core/issues/5334)); the hook runner spawns `process.execPath` ([#4849](https://github.com/open-gsd/gsd-core/issues/4849)). They are tracked on their own and are dependencies, not decisions of this ADR.

## Evidence register

Nothing in this ADR is asserted without a source. Three kinds of evidence are used: **D** = official documentation, **K** = Kilo documentation or repository issues, **E** = a reproduction run for this ADR (2026-10-12, Linux, Node 22.22.0, isolated `HOME`/`XDG_*`, `opencode-ai@1.19.0`, `@opencode/cli@2.0.27`, `@opengsd/gsd-core@1.16.0`), and **R** = a `path:line` in this repository.

### Official documentation

| ID | Page | Used for |
|---|---|---|
| D1 | https://opencode.ai/v2/docs/migrate-v1/ | Breaking changes; shared binary and config locations; in-place config normalization; renames; accepted-but-unsupported fields; agent/command/skill file discovery; `cli.json` |
| D2 | https://opencode.ai/v2/docs/build/plugins/migrate-v1 | Plugin entrypoint; V1→V2 hook table; dual export; V1 object entrypoints from OpenCode 1.18.29 |
| D3 | https://opencode.ai/v2/docs/build/plugins | `ctx.app.version`, `ctx.location`, transforms, `ctx.tool.list()` ids |
| D4 | https://opencode.ai/v2/docs/cli/plugins | Plugin discovery under the global config dir and `.opencode/plugins/` |
| D5 | https://opencode.ai/v2/docs/cli/commands | `run`, `upgrade`, `uninstall`, `debug paths`, `plugin` subcommands |
| D6 | https://opencode.ai/v2/docs/tools | Tool ids and their permission actions |
| D7 | https://opencode.ai/v2/docs/permissions | Rule array, last-match-wins, default `ask`, `~`/`$HOME` expansion |
| D8 | https://opencode.ai/v2/docs/agents | Agent files, `permissions`, `model#variant`, built-in agents |
| D9 | https://opencode.ai/v2/docs/commands | Command fields, `subagent` behavior |
| D10 | https://opencode.ai/v2/docs/skills | Skill frontmatter (`slash`, `metadata.opencode/autoinvoke`) |
| D11 | https://opencode.ai/v2/docs/mcp-servers | `mcp.servers`, `codemode` default |
| D12 | https://opencode.ai/v2/docs/instructions | `AGENTS.md` only |
| D13 | https://opencode.ai/v2/docs/config | JSONC support, locations, `instructions` accepted but not loaded |
| D14 | https://opencode.ai/v2/docs | Install commands |
| K1 | https://kilo.ai/docs/code-with-ai/platforms/cli | Kilo is a fork of OpenCode; `kilo.json[c]`, `.kilo/`, no `.opencode` fallback |
| K2 | https://kilo.ai/docs/automate/extending/plugins | Kilo's plugin shape and directories |
| K3 | https://github.com/Kilo-Org/kilocode/issues/13750 | Kilo's phased port onto OpenCode V2 |
| K4 | https://github.com/Kilo-Org/kilocode/issues/12887 | Kilo's migration plan and cutover criteria |

### Reproduction runs

Each run used an isolated environment (`HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME` pointing into a scratch directory; `OPENCODE_DISABLE_AUTOUPDATE=true`). Provider calls were blocked by the sandbox network, so model output was not observed.

| ID | Observation | Reproduce with |
|---|---|---|
| E1 | `@opencode/cli` `latest` is `2.0.27`; its `bin` map exposes `opencode` and `opencode2`. `opencode-ai` `latest` is `1.19.0` (bin `opencode`). | `npm view @opencode/cli dist-tags --json`; `npm view opencode-ai dist-tags.latest`; read `package.json` `bin` after `npm install --prefix <dir>` |
| E2 | `--version` prints `1.19.0` on V1 and `opencode v2.0.27` on V2; `-v` is identical; `opencode2 --version` is identical to V2 `opencode`. | `opencode --version` (each install) |
| E3 | V2 `run` flags: `--standalone --server --continue/-c --session/-s --fork --model/-m (provider/model#variant) --agent --format (default\|json) --file/-f --title --thinking --auto`. `opencode run --dir /tmp hello` and `opencode run --variant high hello` print usage and exit 1. V1 1.19.0 `run` lists `--dir` and `--variant`. | `opencode run --help`; `opencode run --dir /tmp hello; echo $?` |
| E4 | V2 accepts a piped prompt: `echo "say hi" \| opencode run --standalone --format json` creates a session and emits NDJSON (`{"type":"error",…}`; the provider call was blocked). | the quoted command |
| E5 | GSD 1.16.0's `plugins/gsd-core.js` on V2 2.0.27: `WARN failed to load plugin … PluginModule.LoadError: Plugin must export a default definition with an id and an effect or setup function. (… Missing key at ["default"]["effect"] … Missing key at ["default"]["setup"])`. `opencode plugin list --builtin` prints `No plugins found`. The run continues. | copy the file to `$XDG_CONFIG_HOME/opencode/plugins/`; `opencode run --standalone --print-logs --log-level debug "hi"` |
| E6 | A CommonJS object with enumerable `server` and **non-enumerable** `id` and `setup`: V2 loads it and runs `setup()` with `ctx.app.version == "2.0.27"`. V1 1.19.0 runs `server()` **and also `setup()`**, with a context that has no `ctx.app`. | the probe object described in this row, same run commands as E5 (V1: `opencode run --print-logs --log-level DEBUG "hi"`) |
| E7 | With only `permission.read`, `permission.external_directory` and `mcp.gsd` in V1 shape (exactly what GSD writes), V2 emits no config warning and tries to start the `gsd` MCP server. | write those keys to `opencode.json`; run as in E5 |
| E8 | A V2 run over a data dir that V1 1.19.0 had created succeeded; V1 1.19.0 over a data dir V2 had used failed with `Database is not empty and has no session table`. Both use `~/.local/share/opencode/opencode.db`. | `opencode debug paths db` on each; run V2 then V1 against one `XDG_DATA_HOME` |
| E9 | `opencode upgrade --major` exists on V1 1.19.0: "upgrade to OpenCode 2 and remove OpenCode 1". V1 `--method` choices: curl, npm, pnpm, bun, brew, choco, scoop. V2: curl, npm, pnpm, bun, yarn, vp, brew. | `opencode upgrade --help` |
| E10 | GSD 1.16.0 on OpenCode, install then `--uninstall`: install warns `72 triggers shadowed` and `Found 364 unreplaced .claude path reference(s) in 118 file(s)`; the user's `opencode.jsonc` comments are gone after install; uninstall leaves 8 of 12 `hooks/lib` helpers, `gsd-install-state.json`, `gsd-migration-journal/`, `settings.json` (`{}`), `mcp.gsd`, and `~/.gsd/defaults.json` (`runtime: "opencode"`). User files were preserved. Detail in [#5335](https://github.com/open-gsd/gsd-core/issues/5335). | `node <pkg>/bin/install.js --opencode --global` then `… --uninstall`, with `HOME`/`XDG_CONFIG_HOME` isolated |
| E11 | V1 1.19.0 with GSD's installed plugin logged no `failed to load plugin` line for it during the first seconds of a run. Hook *execution* was not observed (no provider). | `opencode run --print-logs --log-level DEBUG "hi"` |

### Repository references

`capabilities/opencode/capability.json:78-81` (trigger precedence), `:104`, `:108` (`modelMode`, `runtime`), `:111-118` (`orchestratorExec`), `:119-138` (`hostBehaviors`), `:150-164` (reviewer invocation); `capabilities/kilo/capability.json:27-82`, `:119-128`; `.opencode/plugins/gsd-core.js:97`, `:136-149`, `:264`, `:634-791`, `:874`; `src/model-catalog.cts:333`; `src/runtime-homes.cts:320-337`; `src/update-context.cts:89-90`, `:100`, `:119-121`; `src/install-engine.cts:1490`, `:1777`, `:1845`, `:2007`; `src/review-lane-runner.cts:513`; `bin/install.js:414`, `:6977-7012`, `:8877-8902`, `:9179-9218`, `:9372-9463`; `src/installer-migrations/000–010`.

## Decision

Eight decisions. D1–D8 each name their evidence; where evidence is only a reproduction on one machine, Phase 1 re-verifies it on the CI matrix.

### D1 — OpenCode 2.x is a version-gated target of the existing `opencode` runtime

GSD keeps one `opencode` descriptor and one install path. The installer selects a generation (1 or 2) per install. It does **not** add a sibling descriptor.

*Evidence:* V1 and V2 share the `opencode` command, the config locations and the manifest-relevant directories, and are mutually exclusive on a machine ([D1], E1, E2).

### D2 — The major version is detected by running `opencode --version`

The probe parses both observed forms (`1.19.0` and `opencode v2.0.27`, E2), runs with a bounded timeout and without a shell, and falls back to config signals (`cli.json`, V2-shaped keys, an existing GSD manifest — [D1]) when the binary is missing or the output is unparseable. It then prompts rather than guesses. An explicit override is allowed. The result is recorded in the installer state file. The probe applies to the `opencode` runtime only.

*Evidence:* E2; config signals from [D1]; the state file exists today (E10).

### D3 — One tracked plugin source with a dual export

The plugin file carries the V1 `server` and a V2 `id` + `setup`. V2 documents this shape ([D2]) and 2.0.27 loads it (E6). Because V1 1.19.0 also invokes `setup()` with a V1 input (E6), `setup()` must be inert unless it receives a V2 context, detected by feature (the presence of `ctx.tool.hook`), not by version string. The source stays one file so the installer's pristine/local-patch mechanism restages the right content on update.

*Evidence:* [D2] dual-export section; E5, E6. *Re-verify in Phase 1:* behavior at the documented 1.18.29 floor ([D2]) and on 2.0.27.

### D4 — User config is not rewritten by default

GSD's `permission.*` and `mcp.gsd` keys stay V1-shaped; V2 reads them in place (E7, [D1]). Native-V2 output (per-agent `permissions`, `mcp.servers.gsd` with `codemode`, `model#variant`) is opt-in, applied per entry, and never mixes V1 and V2 forms inside one agent, command, provider or model entry ([D1]). Every config write must preserve JSONC comments ([#5334](https://github.com/open-gsd/gsd-core/issues/5334); JSONC is supported — [D13]).

*Evidence:* [D1], [D13], E7, E10.

### D5 — Tool-name and CLI-flag mapping is version-aware

For V2: add `shell`→Bash and `patch`→MultiEdit to the plugin's tool-name map ([D6]; `.opencode/plugins/gsd-core.js:136-149`); do not emit `--dir` or `--variant` (E3); use the spawn working directory and `--model provider/model#variant` ([D5] documents `--model`; E3 documents the `#variant` form). V1 keeps its current names and flags (E3).

*Evidence:* [D6], E3. *Re-verify in Phase 1:* the tool ids actually delivered to hooks (open question 3).

### D6 — Migration record 011 handles the upgrade, and the rollback state warns

A journaled migration, modelled on 005, 008 and 010 under `src/installer-migrations/`, runs when the probe reports a V2 binary while the manifest records 1.x-era GSD artifacts. It replaces the plugin, removes duplicates, rewrites only GSD-owned keys with comment-preserving edits, preserves unmanaged files and prompts on locally modified ones. A "V1 binary + data dir last used by V2" state warns and offers to reinstall the 1.x artifacts; GSD never touches the OpenCode database.

*Evidence:* migration framework (`docs/installer-migrations.md`, [ADR-0008](0008-installer-migration-module.md)); E8, E9 (in-place upgrade removes V1; V1 cannot reopen V2's database).

### D7 — The sunset applies to the `opencode` runtime only

After a maintainer-set freeze window, GSD stops installing and testing the 1.x target for the `opencode` runtime and redirects such users to `opencode upgrade --major` or the V2 installer. The shared V1 plugin half, V1 converters and shared pipeline **remain** while Kilo is on the OpenCode 1.x line. A separate issue opens for a Kilo-V2 target when Kilo ships a V2-based release.

*Evidence:* [K1], [K2], [K3], [K4]; E9; [D1].

### D8 — Uninstall is complete on both versions and derived from what the installer staged

The removal set for `hooks/lib` and the state files comes from the staged list or manifest, not a hard-coded array (`GSD_HOOK_LIB_FILES` lists 4 of the 12 staged files — `bin/install.js:414`, `:8877-8902`; E10). A round-trip test compares the config directory before install and after uninstall.

*Evidence:* E10, [#5335](https://github.com/open-gsd/gsd-core/issues/5335).

## Options Considered

### Option A: version-gated single `opencode` runtime — **chosen (D1–D8)**

| Dimension | Assessment |
|---|---|
| Complexity | Medium: one probe, one dual-export plugin, version-aware tables |
| Cost | Moderate; most files already work on V2 (E7, [D1]) |
| Scalability | Good: a future V3 adds a generation, not a descriptor |
| Team familiarity | High: same descriptor, installer and migration framework |

**Pros:** matches how OpenCode ships (one command, shared locations, no side-by-side install — [D1]); a single plugin source survives the `gsd-local-patches` restaging; Kilo is untouched.
**Cons:** version branches inside converters and the CLI-arg builder; the dual export needs care because V1 1.19.0 calls `setup()` (E6).

### Option B: a sibling `opencode2` descriptor

| Dimension | Assessment |
|---|---|
| Complexity | High: two descriptors for one binary name, one config directory and one manifest |
| Cost | High: duplicated converters, tests and docs |
| Scalability | Poor: each OpenCode major would need another descriptor |
| Team familiarity | Medium |

**Pros:** clean separation of V1 and V2 code; mirrors how Kilo isolates its V2 preview identity ([K3]).
**Cons:** both descriptors resolve the same binary and the same directories, so install, update-context and uninstall would have to disambiguate on exactly the version probe Option A uses anyway; Kilo's isolation relies on a *separate* binary identity (`kilo2`) that OpenCode V2 does not have for the user (`opencode` is shared — [D1]; the `opencode2` bin in E1 is an alias of the same executable).

### Option C: stay on V1 only and document a warning

| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Cost | Low now; unbounded user cost |
| Scalability | Poor |
| Team familiarity | High |

**Pros:** no code.
**Cons:** on V2 every GSD guard is silently absent (E5: the failure is a WARN in a server log) and the reviewer and worktree dispatch break on removed flags (E3). Not acceptable for "full OpenCode 2.0 support for all GSD features where possible" (#5331).

## Trade-off Analysis

The decisive facts are structural: one command name, one set of config locations, no side-by-side install ([D1]). They make a second descriptor (B) pay the cost of version detection without gaining isolation, while staying put (C) leaves silent loss of enforcement. A is the only option that keeps Kilo and 1.x unchanged while adding V2. Its main risk is the dual-export call into `setup()` on V1 (E6), which D3 contains by feature detection and which Phase 1 tests on real binaries.

## Consequences

- **Easier:** V2 users get working guards and a clean upgrade path; the installer can warn 1.x users with a sourced upgrade command; config files stay as users wrote them (D4).
- **Harder:** the plugin, converters and the CLI-arg builder carry version branches until the sunset; CI needs real-binary legs for 1.18.29, 1.19.0 and 2.0.27; the shared V1 code stays while Kilo is on V1.
- **Behavior changes to release-note:** guards that silently allowed on 1.x/Kilo (hook runner spawning the host binary — [#4849](https://github.com/open-gsd/gsd-core/issues/4849)) start enforcing once fixed; commands whose agent has `mode: subagent` run as background child sessions on V2 unless `subagent: false` ([D9]).
- **To revisit:** the open questions below; whether `todowrite` has a V2 equivalent; a Kilo-V2 target.

## Phases and gates

| Phase | Issue | Scope | Gate to start | Gate to close |
|---|---|---|---|---|
| 0 | [#5336](https://github.com/open-gsd/gsd-core/issues/5336) | This ADR | epic approved | ADR merged, index regenerated, maintainer ratifies, Phases 1–4 approved |
| 1 | [#5337](https://github.com/open-gsd/gsd-core/issues/5337) | Version probe, dual-export plugin, version-aware tool/CLI mapping | Phase 0 accepted | real-binary smoke on 1.18.29, 1.19.0, 2.0.27; Kilo output unchanged |
| 2 | [#5338](https://github.com/open-gsd/gsd-core/issues/5338) | Installer output, migration 011, complete uninstall | Phase 0 accepted, Phase 1 probe merged | uninstall round-trip on both versions; JSONC preserved |
| 3 | [#5339](https://github.com/open-gsd/gsd-core/issues/5339) | Feature verification matrix, parity decisions, deprecation notice, 1.x freeze | Phases 1–2 merged | every matrix row recorded or waived; freeze date set |
| 4 | [#5340](https://github.com/open-gsd/gsd-core/issues/5340) | Sunset of OpenCode 1.x for the `opencode` runtime; Kilo retained | Phase 3 + freeze window over | 1.x install redirected; Kilo suite green; Kilo-V2 follow-up opened |

## Open questions (undecided — not answered by inference)

| # | Question | Why it matters | Resolved by |
|---|---|---|---|
| 1 | What is the `--format json` event shape for assistant text with a real provider? | The reviewer lane rebuilds the review from text parts (`src/review-lane-runner.cts:513`). | **Answered in Phase 1 (E12):** same `{type:"text", part:{text}}` lines as 1.x; `handleOpencodeOutput` rebuilds the review unchanged. 2.x emits no `step_finish`, so the diagnostic reads `?` |
| 2 | Does `opencode run` accept a `-` positional for stdin? | GSD's reviewer invocation ends with `-` (`capabilities/opencode/capability.json:158`). E4 shows piped stdin is accepted without it. | **Answered in Phase 1 (E12):** no — on 2.x `-` is message text (the model receives `-\n<prompt>`); stdin alone is read. The 2.x plan drops the `-` |
| 3 | Which tool ids and event names do V2 hooks actually receive (`shell`, `edit`, `write`, `patch`, `subagent`; session/file events)? | Guards key on tool names. [D6] lists ids; `ctx.tool.list()` shows `read` ([D3]). | **Answered in Phase 1 (E13):** tools `edit glob grep question read shell skill subagent webfetch websearch write execute`; `execute.before` gets `{tool, input}`, `execute.after` `{tool, status, input, result}`; events carry `{type, location:{directory}, data:{sessionID,…}}` (`session.created`, `session.compaction.*`, `session.tool.*`, `session.execution.*`); **no `file.edited` and no `session.idle`** are emitted — the config-reload hook is driven from the edit tools instead |
| 4 | Is there a V2 equivalent of `todowrite`? | GSD maps `TodoWrite` to it. Not on the Tools page ([D6]). | Phase 3 matrix. Phase 1 observation (E13): not in the 2.0.27 tool list |
| 5 | Do `OPENCODE_CONFIG_DIR` / `OPENCODE_CONFIG` still redirect config on V2? | GSD's config-dir cascade uses them (`src/runtime-homes.cts:320-337`). Documented for V1 (https://opencode.ai/docs/config/); the V2 [D1] lists three fixed locations. | **Answered in Phase 1 (E14):** `OPENCODE_CONFIG_DIR` is honored on 2.0.27 and 1.18.29 (config and `plugins/` loaded from it). `OPENCODE_CONFIG` alone loaded no provider on either generation in the same harness, so behavior is identical and GSD does not rely on it for loading |
| 6 | Is `codemode` honored on V1-shaped `mcp.<name>` entries? | `codemode` defaults to `true` ([D11]); GSD's tools may be reached only through Code Mode. | Phase 2 |
| 7 | How does the dual export behave exactly at the documented floor, OpenCode 1.18.29? | [D2] says object entrypoints work from 1.18.29; E6 shows 1.19.0 also calls `setup()`. | **Answered in Phase 1 (E15):** 1.18.29 also calls `setup()` with a context that has no `tool` (keys `options agent aisdk catalog command integration plugin reference skill`); the guard keeps it inert, and the guard, a full install and the reviewer lane all pass on 1.18.29 |
| 8 | Which plugin directory does Kilo read (`plugin/` per [K2] vs the `plugins/` GSD installs), and are `.opencode` directories still scanned? | Kilo must not regress ([K1] says it no longer falls back to `.opencode`). | Phase 2/4 |

## Amendment — 2026-10-12, Phase 1 findings (#5337)

New evidence from the Phase 1 implementation, each reproduced on `opencode` 1.18.29, 1.19.0 and 2.0.27 with an offline local model (`tests/opencode-generations.smoke.test.cjs`).

| ID | Finding | Consequence |
|---|---|---|
| E12 | 2.x `run --format json` emits `text` parts shaped as on 1.x and no `step_finish`. `opencode run … -` sends `-` to the model as message text on 2.x (prompt `-\nPlease review…`); stdin alone is read. Without `--standalone`, `run` attaches to a long-lived managed service on a fixed port and failed with "port … already in use" when another process held it. `--model provider/model#high` is accepted. | Reviewer plan on 2.x: drop `-`, add `--standalone` (`adaptLanePlanForGeneration`). |
| E13 | 2.0.27 tool ids: `edit glob grep question read shell skill subagent webfetch websearch write execute` (no `todowrite`, no `bash`). Hook payloads and event shapes as in open question 3. `shell.create.before` receives `{command, cwd, timeout, shell, env}` and edits to `env` reach the command (`GSD_DIR` verified). `session.compaction` receives `{sessionID, model, system:[{type:"text",text}], messages, options, agent, tools}`; items pushed onto `system` reach the summarizer. | Plugin `setup()` adapts these; `file.edited` is derived from completed `write`/`edit`/`patch` calls on `.planning/config.json`. |
| E14 | `OPENCODE_CONFIG_DIR` redirects config and `plugins/` on 1.18.29 and 2.0.27. | Config-dir cascade unchanged. |
| E15 | 1.18.29 calls `setup()` with a non-2.x context. | `setup()` feature-detects `ctx.tool.hook`. |
| E16 | `process.execPath` inside both generations is the OpenCode binary; spawning it with a `.js` path runs OpenCode, not the script, so every GSD hook was silently skipped (#4849). On 2.0.27 the secret-read guard did not block until hooks were started with Node. | Hooks run under `node` from `PATH` or `GSD_HOOK_RUNTIME`. |
| E17 | 2.0.27 resolves its working directory from `$PWD`, not the process cwd: a child spawned with `cwd: X` but an inherited `PWD` ran in the parent's directory. | The worktree-dispatch step must launch from a shell that has `cd`'d into the worktree (documented in `executor-isolation-dispatch.md`). |

Descriptor reconciliation (`runtime: bun`, `modelMode: active`): resolved in `docs/reference/host-integration-capability-matrix.md` § OpenCode 2.x notes — the matrix, not ADR-1239's pre-research prose table, is the source of truth, and `runtime` names the host's plugin runtime while GSD hooks run under Node.

## Action Items

1. [x] Open the epic, the Phase-0 sub-issue and the Phase 1–4 sub-issues
2. [ ] Maintainer ratifies this ADR (sets `Status`) and applies `approved-feature` to #5337–#5340
3. [ ] Phase 1 answers open questions 1, 2, 3, 5, 7 with a real V2 and updates this table in a dated amendment
4. [ ] Phase 2 answers 6; Phases 2/4 answer 8
5. [ ] Phase 3 answers 4 and adds the dated amendment note to [ADR-1239](1239-gsd-embeddable-orchestration-engine.md)
6. [ ] Open the Kilo-V2 target issue when Kilo ships a V2-based release
