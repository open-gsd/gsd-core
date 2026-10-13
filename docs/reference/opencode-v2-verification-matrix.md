# OpenCode 2.x feature verification matrix

Epic [#5331](https://github.com/open-gsd/gsd-core/issues/5331), Phase 3 ([#5339](https://github.com/open-gsd/gsd-core/issues/5339)): every GSD feature that reaches OpenCode, exercised on a **real** OpenCode 2.x (pinned minimum **2.0.27**) and on the OpenCode 1.x floor (**1.18.29**). Design and evidence IDs (E1–E34): [ADR-5331](../adr/5331-opencode-v2-support-and-v1-sunset.md).

## How it was run

Each row is a test in [`tests/opencode-matrix.smoke.test.cjs`](../../tests/opencode-matrix.smoke.test.cjs). A row installs GSD with the real installer (`node bin/install.js --opencode --global`) into a sandbox home, starts the real `opencode` binary against a scripted local OpenAI-compatible model (nothing leaves the machine), and asserts on what the model received, what the tools returned and which hook scripts ran. `GSD_HOOK_RUNTIME` and `GSD_HOOK_SHELL` point at wrappers that log every hook script the plugin starts, so "the guard ran" is observed, not inferred.

```bash
GSD_TEST_OPENCODE_V2_BIN=/path/to/opencode-2.0.27 \
GSD_TEST_OPENCODE_V1_BIN=/path/to/opencode-1.18.29 \
  node --test --test-concurrency=1 tests/opencode-matrix.smoke.test.cjs
```

Result of the recorded run: **51 rows, 51 pass** (2.0.27: 26, 1.18.29: 25; row A5 exists on 2.x only). The terminal-client rows (statusline) are in [`tests/opencode-statusline-plugin.test.cjs`](../../tests/opencode-statusline-plugin.test.cjs), run the same way with a pseudo-terminal.

## A. Commands, skills, agents, dispatch

| Row | Feature | What the run showed | 2.0.27 | 1.18.29 |
|---|---|---|---|---|
| A1 | 72 slash commands, foreground | 72 `gsd-*.md` command files installed, none marked `subagent`/`subtask`. The expanded `gsd-help` template reaches the model as one agent turn, no child session. **2.x `opencode run` has no `--command` flag and sends `/gsd-help` as plain text (E28)**: the row executes the command through the session command API (`session.command`); the terminal client runs slash commands natively. | pass | pass (`run --command`) |
| A2 | Skills, no duplicate ids | The system prompt advertises ≥ 60 `gsd-*` skills; `--print-logs` shows no duplicate-id warning. | pass | pass |
| A3 | 64 agents, subagent mode, per-agent permissions | The `subagent`/`task` tool description lists `gsd-executor`, `gsd-planner`, `gsd-verifier`, `gsd-plan-checker`. The read-only `gsd-plan-checker` child is offered `read`, `grep`, `glob`, `shell`/`bash` but **not** `edit` or `write` (2.x: `glob grep question read shell skill execute`). | pass | pass |
| A4 | `Agent(subagent_type=…)` → native dispatch | A parent calls `subagent` (2.x) / `task` (1.x) for a GSD agent; the child runs and its result returns to the parent. | pass | pass |
| A5 | Parallel / background agents | `subagent` with `background: true` returns a child session id at once and the parent is notified. 1.x `task` has no background mode. | pass | n/a |
| A4b | Nesting depth (asserted in A4) | The parent is offered the dispatch tool and the child session is not, on either generation (E29) → descriptor `nested: false`, `maxDepth: 1`. | pass | pass |
| A6 | Worktree isolation (spawn working directory) | A child started with `PWD` = a worktree runs `pwd` there on both generations (E30); 2.x has no `--dir`, so GSD sets the directory of the spawned process. | pass | pass |

## B. Tool guards (the 8 tool-hook scripts) and the opt-in hooks

Advisories are now appended to the tool result the model reads (E27); before this phase they went to stderr only and no model ever saw them.

| Row | Script | Observed (excerpt of the tool result the model received) | 2.0.27 | 1.18.29 |
|---|---|---|---|---|
| B1 | `gsd-secret-read-guard.js` | `Secret read guard: Read would read '.env', which matches a protected secret-file pattern …` — and the secret value never appears. | block | block |
| B2 | `gsd-prompt-guard.js` | `[GSD advisory] ⚠️ PROMPT INJECTION WARNING: Content being written to n.md triggered 1 injection detection pattern(s) …` | advise | advise |
| B3 | `gsd-read-guard.js` | Read-before-write reminder appended when a write targets an existing file. | advise | advise |
| B4 | `gsd-write-guard.js` | `Write guard: this Write would shrink '…/.planning/STATE.md' from 201 lines to 1 (0% of current) …`; the file is unchanged. | block | block |
| B5 | `gsd-workflow-guard.js` | `agent/worktree-agent branches must not run git add -f or git add --force …` on a `worktree-agent-*` branch with `hooks.workflow_guard`. | block | block |
| B6 | `gsd-worktree-path-guard.js` | Runs before every write/edit (logged by the hook wrapper). | ran | ran |
| B7 | `gsd-read-injection-scanner.js` | `[GSD advisory] ⚠️ INJECTION SCAN [LOW] (Read): "doc.md" triggered 1 pattern(s) …` | advise | advise |
| B8 | `gsd-context-monitor.js` | Runs after tool calls. It warns only when a context-metrics bridge file exists, and only the Claude Code statusline writes one; on OpenCode it stays silent (see waivers). | ran | ran |
| B9 | `gsd-validate-commit.sh` (opt-in `hooks.community`) | `Commit message must follow Conventional Commits: <type>(<scope>): <subject> …` — the commit is not made. **New on OpenCode in this phase.** | block | block |
| B10 | `gsd-phase-boundary.sh` (opt-in) | `[GSD advisory]` after a write under `.planning/`. **New.** | advise | advise |
| — | `gsd-graphify-update.sh` (opt-in `graphify.auto_update`) | Spawned only for an opted-in project and only after shell calls — [`tests/opencode-parity-hooks.test.cjs`](../../tests/opencode-parity-hooks.test.cjs) (needs the graphify CLI, so no real-binary row). **New.** | covered | covered |

## C. Session and file scripts, compaction

| Row | Feature | What the run showed | 2.0.27 | 1.18.29 |
|---|---|---|---|---|
| C1 | `gsd-ensure-canonical-path.js`, `gsd-check-update.js` at session start | Both run. **On 2.x they never ran before this phase**: a 2.x `run` emits no `session.created` (E26); the adapter now treats the first event naming a session as its start. | pass (fixed) | pass |
| C2 | `gsd-session-state.sh` (opt-in) | The project's `STATE.md` head is in the system prompt of the first model request. **New.** | pass | pass |
| C3 | `gsd-config-reload.js` | A completed write to `.planning/config.json` runs it (2.x derives `file.edited` from the edit tool; it emits none). | pass | pass |
| C4 | Compaction breadcrumb | The summarizer's request contains `[GSD] Active session: …` (2.x via `session.compact`, 1.x via `summarize`). | pass | pass |

## D. Tools GSD maps, MCP, instructions, paths

| Row | Feature | What the run showed | 2.0.27 | 1.18.29 |
|---|---|---|---|---|
| D1 | Tool inventory | `webfetch` on both. `websearch` and `question` offered by default on 2.x only. **`todowrite` exists on 1.x only** (answers open question 4, E31). 2.x tool ids: `edit glob grep question read shell skill subagent webfetch websearch write execute`. | pass | pass |
| D2 | `WebFetch` | `webfetch` returns the body of a local HTTP server. | pass | pass |
| D3 | `AGENTS.md` | A marker in the project's `AGENTS.md` is in the system prompt; no `CLAUDE.md` fallback is needed. | pass | pass |
| D4 | Path rewriting | A `Read` of `~/.claude/gsd-core/references/<file>.md` returns the installed payload on both generations. | pass | pass |
| D5 | MCP companion `gsd`, `codemode` decision | The installer-written entry (with `--no-prompts`) connects; **2.x**: the model calls `execute` and reads `.planning/config.json` through `tools.gsd.gsd_read_state(…)` (the tools are not in the model's tool list under Code Mode; `tools.search({ query: "gsd" })` finds them — E34); **1.x**: the model calls `gsd_gsd_read_state` by name. | pass | pass |
| D6 | `AskUserQuestion` → `question` | 2.x offers `question`; a non-interactive `run` cancels the call with `This non-interactive run cannot ask the user questions, so the question was cancelled. Continue without an answer …`. 1.x `run` offers no `question` tool. The interactive form in the terminal client was not driven headlessly (E31). | pass | pass |

## E. Rows verified by other suites

| Feature | Where | Result |
|---|---|---|
| Reviewer lane (`/gsd-review --opencode`): version-correct flags, stdin, text-part reconstruction | `tests/opencode-generations.smoke.test.cjs` (real binaries, `review-lane invoke`) | pass on 1.18.29, 1.19.0 and 2.0.27 |
| Update flow: generation detection, `hostGeneration` record, migration 011, data-directory notice, deprecation notice | `tests/opencode-install-notices.test.cjs`, `tests/installer-migration-opencode-mcp-no-prompts.test.cjs` | pass (stand-in `opencode` binary plus a real SQLite data directory) |
| Statusline and update banner in the terminal client | `tests/opencode-statusline-plugin.test.cjs` (real 2.0.27 in a pseudo-terminal) | the footer shows `OpenCode │ <project>`; 1.x terminal starts with identical output with and without the plugin directory |
| Uninstall round trip | `tests/opencode-uninstall-roundtrip.test.cjs`, smoke | byte-identical config tree on both generations |
| Kilo unchanged | `tests/kilo-upgrades.test.cjs` (the Kilo plugin equals the OpenCode plugin minus the `opencode-v2` and `opencode-parity` blocks), `tests/opencode-parity-hooks.test.cjs` (no parity hook in the Kilo plugin), `tests/opencode-statusline-plugin.test.cjs` (no CLI plugin for Kilo) | pass |

## Parity decisions (section B of the issue)

| Gap | Decision | Reason |
|---|---|---|
| `gsd-validate-commit.sh`, `gsd-phase-boundary.sh`, `gsd-session-state.sh`, `gsd-graphify-update.sh` not wired | **Implemented** (rows B9, B10, C2) | Needed only tool, session and shell events the plugin already receives. |
| Statusline / update banner | **Implemented** for 2.x as a CLI plugin | The 2.x terminal client has footer slots; 1.x has no equivalent surface. |
| `gsd-agent-isolation-guard.js` | **Not applicable** | It blocks a GSD executor dispatch that omits harness-managed worktree isolation. OpenCode's descriptor declares `dispatch.isolation: orchestrator-worktree`, so GSD manages the worktree and the guard would never act. The missing agent id in the 2.x prompt hook (anomalyco/opencode#54896) is therefore moot. |
| LSP-backed features | **Waived** | 2.x keeps the `lsp` setting but runs no language servers and exposes no LSP tools ([Migrate from V1](https://opencode.ai/v2/docs/migrate-v1/)); there is nothing to wire. |
| Context-window warnings on OpenCode | **Waived** | The monitor needs a metrics bridge file that only the Claude Code statusline writes; the OpenCode statusline plugin does not pass the model's context usage to the script. |

## Descriptor reconciliation

`dispatch.nested: false`, `dispatch.maxDepth: 1` (documented and observed); `dispatch.background: false` stays until the 1.x paths are removed — 2.x supports `background: true` (row A5) but the 1.x floor does not. See [OpenCode 2.x notes](host-integration-capability-matrix.md#opencode-2x-notes-adr-5331-5337).
