# How GSD runs on OpenCode

> Explanation. How one `opencode` runtime serves OpenCode 1.x and 2.x. Install flags are in
> [Installer flags](../reference/installer-flags.md); the variables are in
> [Environment variables](../reference/environment-variables.md).

One `opencode` runtime serves OpenCode 1.x and 2.x (design: [ADR-5331](../adr/5331-opencode-v2-support-and-v1-sunset.md)).

| Setting | Where | Effect |
|---------|-------|--------|
| `GSD_OPENCODE_GENERATION` | environment | `1`, `2`, `v1`, `v2` (any case). Forces the generation GSD assumes when it builds an `opencode run` command line; otherwise GSD runs `opencode --version`. An unreadable version leaves the 1.x behavior. |
| `GSD_HOOK_RUNTIME` | environment | Executable the OpenCode plugin starts GSD's hook scripts with. Default: `node` from `PATH`. The OpenCode binary itself cannot run them. |
| `review.models.opencode` | `.planning/config.json` | Reviewer model, `provider/model`. On 2.x a configured reasoning effort is appended as `#<level>` (`provider/model#high`); a model that already has a `#variant` is used as written. |
| `review.effort.opencode` | `.planning/config.json` | Reasoning effort for the OpenCode reviewer. On 1.x it is passed as `--variant <level>`; on 2.x it needs a configured model to ride on, and is dropped with a warning otherwise. |

OpenCode 1.x is deprecated for GSD: bug fixes only until **2026-12-31**. The installer prints the notice when it finds a 1.x binary (never for 2.x, and never for Kilo). The opt-in community hooks (`hooks.community`) and the graphify auto-update hook (`graphify.auto_update`) run through the OpenCode plugin when enabled in `.planning/config.json`; they need `bash` on `PATH` and are skipped silently without it. `GSD_HOOK_SHELL` overrides the shell they start with.

Installed agents carry a `permission:` block that denies the tools their Claude `tools:` allowlist leaves out (and any
`disallowedTools:`); allowed tools keep your own configured default, and MCP tool entries are not restricted. An agent
with neither key inherits everything. `effort sync` keeps the effort in `variant:` on 1.x and in the `#variant` suffix of
`model:` when an agent already uses the 2.x form.

GSD edits `opencode.json`/`opencode.jsonc` (and Kilo's `kilo.json(c)`) as text when the file has comments or trailing
commas, so annotations survive install, update and uninstall. It writes the `mcp.gsd` companion entry with
`--no-prompts`; remove or edit the entry and GSD treats it as yours.

## Architecture notes

OpenCode 1.x and 2.x use the same `opencode` command and config directories and cannot be installed side by side,
so one `opencode` runtime serves both. The design is recorded in
[ADR-5331](../adr/5331-opencode-v2-support-and-v1-sunset.md); Kilo is a fork on the 1.x line and is unaffected.

- **Generation detection** (`opencode-version.cts`): a bounded, argv-only `opencode --version` run (`1.19.0` on 1.x,
  `opencode v2.0.27` on 2.x), `GSD_OPENCODE_GENERATION=1|2` to force it, and 2.x-only config signals as a fallback.
  An undeterminable generation is `null` and keeps today's behavior. The installer prints the result and records it as
  `hostGeneration` in `gsd-install-state.json`, which `update-context` reports.
- **One plugin, two entrypoints:** `plugins/gsd-core.js` exports `server` (1.x) and a non-enumerable `setup` (2.x). `setup`
  is inert unless it is handed a 2.x context (1.18.29 and 1.19.0 also call it, with one that has no `tool`). Both
  adapters run the same guards; the 2.x `shell` and `patch` tool ids map to `Bash` and `MultiEdit`; `file.edited`, which
  2.x never emits, is derived from completed edit-tool calls on `.planning/config.json`.
- **Hooks run under Node.** Inside OpenCode `process.execPath` is the OpenCode binary, so the plugin starts hook
  scripts with `node` from `PATH` (override: `GSD_HOOK_RUNTIME`); before this every guard was silently skipped (#4849).
- **Spawn arguments differ by generation** and are adapted when a command line is built: 2.x has no `--dir` (the worker
  binds through its working directory, which 2.x takes from `$PWD`, so it must be launched from a shell that has
  `cd`'d there) and no `--variant` (effort rides on the model as `provider/model#variant`); the reviewer lane drops the
  trailing stdin `-`, which 2.x sends to the model as text, and runs `--standalone` so no background service outlives it.
- **Config edits preserve JSONC.** `jsonc-edit.cts` splices only the keys GSD owns, so an annotated `opencode.jsonc` or
  `kilo.jsonc` keeps its comments, trailing commas and layout through install, migration and uninstall (#5334). Plain
  JSON without comments is rewritten as before. GSD never writes 2.x-only shapes to user config.
- **MCP companion.** The installer registers `mcp.gsd` with `--no-prompts`; OpenCode would otherwise list every GSD
  prompt as a second `gsd:<name>` slash command next to the command files. Migration 011 converges existing entries.
  The entry stays in the 1.x shape, which 2.x reads in place; 2.x's default Code Mode is left as it is, because the
  companion's tools are reached by exact name from GSD workflows and nothing relies on them being native tools.
- **Data directory.** 2.x adds its own session tables beside 1.x's and 1.x keeps working; a data directory 2.x creates
  from scratch has no 1.x tables and 1.x cannot open it. The installer reads the schema (never writes it) and says which
  case applies.
- **Uninstall is complete on both generations:** it removes every staged `hooks/lib` helper (derived from what the
  installer copies, so the lists cannot drift), the install state and migration-journal records (backups of files the
  user modified are kept), an empty `settings.json`, the GSD `mcp` entry in both shapes, empty directories GSD created,
  and the `~/.gsd/defaults.json` keys the install set once no other runtime needs them and the user has not changed them.

- **Phase 3 additions (#5339).** The OpenCode-only parity code in the plugin sits between `gsd:opencode-parity` markers and
  is absent from the byte-identical Kilo mirror: the four opt-in `.sh` hooks (commit validation, phase boundary, session
  state, graphify auto-update) run under bash, with their config gates re-checked in-process so a project that has not
  opted in pays no spawn; advisories are appended to the tool result (OpenCode shows neither a plugin's stderr nor its
  metadata to the model); the 2.x adapter treats the first event naming a session as `session.created`, because a 2.x
  `run` never emits one. The terminal-client plugin `plugins/gsd-statusline/tui.tsx` (descriptor key
  `hostBehaviors.nativeCliPlugin`) renders the output of `hooks/gsd-statusline.js` in the `home.footer.status` and
  `prompt.footer.status` slots; 1.x never loads it. The deprecation notice and freeze date live in `opencode-version.cts`
  (`describeDeprecationNotice`, `OPENCODE_V1_FREEZE_DATE`). Execution evidence: [verification matrix](../reference/opencode-v2-verification-matrix.md).
