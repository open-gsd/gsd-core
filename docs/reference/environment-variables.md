# Environment variables and file formats

Reference for the environment variables that GSD's installer, `gsd-tools`, hooks and plugins read, and for the state files GSD writes outside `.planning/`. Each entry names the code that reads the variable. Test-only variables (`GSD_TEST_*`, `GSD_NOW_MS`) are not listed.

A value is "set" when it is non-empty unless an entry says otherwise. An option that exists both as a flag and as a variable is listed under both; the flag wins where an entry says so.

## GSD store and location

| Variable | Read by | Effect |
|----------|---------|--------|
| `GSD_HOME` | installer, config loader, capability loader, hooks | Root of the GSD-owned store `$GSD_HOME/.gsd/` (`defaults.json`, `consent.json`, capability overlays). Default: the home directory. A blank value counts as unset. Written to as well as read. |
| `GSD_AGENTS_DIR` | agent install check | Directory the agent install check treats as the agents directory; takes priority over the runtime default. |
| `GSD_PROJECT` | planning directory resolution | Planning project name used when the caller passes none. Surrounding whitespace is trimmed; blank counts as unset. |
| `GSD_WORKSTREAM` | active workstream store, config loader | Active workstream. A `--ws` flag overrides it; it overrides the stored pointer. Surrounding whitespace is trimmed; blank counts as unset. |

### Session identifiers for the workstream pointer

To keep concurrent sessions in one working tree from sharing a single active-workstream pointer, GSD keys the pointer on a session identifier. It reads the first of these that is set and non-empty, in this order: `GSD_SESSION_KEY`, `CODEX_THREAD_ID`, `CLAUDE_SESSION_ID`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_SSE_PORT`, `OPENCODE_SESSION_ID`, `GEMINI_SESSION_ID`, `CURSOR_SESSION_ID`, `WINDSURF_SESSION_ID`, `TERM_SESSION_ID`, `WT_SESSION`, `TMUX_PANE`, `ZELLIJ_SESSION_NAME`. When none is set it falls back to the controlling terminal (`TTY`, `SSH_TTY`, or the terminal of a TTY stdin). With a key, the pointer is a file under the system temp directory in `gsd-workstream-sessions/`; with none, it is `.planning/active-workstream`. Set `GSD_SESSION_KEY` to choose the key yourself.

## Runtime config directories

`--config-dir <path>` takes priority over every variable in this table. Without it, the installer and `gsd-tools` use the first variable of the runtime that is set, then the runtime's default directory.

| Runtime | Variables (first set wins) | Default directory |
|---------|----------------------------|-------------------|
| Claude Code | `CLAUDE_CONFIG_DIR` | `~/.claude` |
| OpenCode | `OPENCODE_CONFIG_DIR`, then `OPENCODE_CONFIG` (a config file; its directory is used), then `XDG_CONFIG_HOME` | `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode` |
| Kilo | `KILO_CONFIG_DIR`, then `KILO_CONFIG` (a config file; its directory is used), then `XDG_CONFIG_HOME` | `$XDG_CONFIG_HOME/kilo` or `~/.config/kilo` |
| Codex | `CODEX_HOME` | `~/.codex` |
| Kimi CLI | `KIMI_CONFIG_DIR` selects the skills root; `KIMI_SHARE_DIR` selects the directory holding the native `config.toml` | skills: `~/.config/agents`; `config.toml`: `~/.kimi` |
| Kimi Code | `KIMI_CODE_HOME` selects the directory holding the native `config.toml` | `~/.kimi-code` |
| Copilot | `COPILOT_CONFIG_DIR`, `COPILOT_HOME` | `~/.copilot` |
| Antigravity | `ANTIGRAVITY_CONFIG_DIR` | `~/.gemini/antigravity` |
| Cursor | `CURSOR_CONFIG_DIR` | `~/.cursor` |
| Windsurf | `WINDSURF_CONFIG_DIR` | `~/.codeium/windsurf` |
| Augment | `AUGMENT_CONFIG_DIR` | `~/.augment` |
| Trae | `TRAE_CONFIG_DIR` | `~/.trae` |
| Qwen Code | `QWEN_CONFIG_DIR` | `~/.qwen` |
| Hermes Agent | `HERMES_HOME` | `~/.hermes` |
| Cline | `CLINE_CONFIG_DIR` | `~/.cline` |
| CodeBuddy | `CODEBUDDY_CONFIG_DIR` | `~/.codebuddy` |
| ZCode | `ZCODE_CONFIG_DIR` | `~/.zcode` |
| Pi | `PI_CODING_AGENT_DIR` | `~/.pi/agent` |

The two Kimi variables are scoped to their own product: `KIMI_SHARE_DIR` does not redirect Kimi Code, and `KIMI_CODE_HOME` does not redirect Kimi CLI. The skills root (`~/.config/agents`) is independent of the native `config.toml` directory for both.

## Runtime selection and hook execution

| Variable | Read by | Effect |
|----------|---------|--------|
| `GSD_RUNTIME` | agent isolation guard, Cursor subagent hook, agent install check | Runtime identity the hooks use. The value is normalized and mapped to its canonical runtime name (aliases are accepted). |
| `GSD_OPENCODE_GENERATION` | OpenCode version detection | `1` or `2` forces the OpenCode generation and skips the probe. |
| `GSD_HOOK_RUNTIME` | OpenCode and Kilo plugins, Pi extension | Executable that runs the JavaScript hooks. Without it: the host's own executable when the host is Node or Bun, otherwise `node` from `PATH`. |
| `GSD_HOOK_SHELL` | OpenCode plugin, Pi extension | Shell that runs the `.sh` hooks. Default: `bash`. |
| `GSD_BASH_PATH` | hook command projection (Windows) | First candidate for the `bash` executable that runs managed shell hooks, tried before the Git for Windows locations. |
| `GSD_NODE_RUNNER_NO_FALLBACKS` | `gsd-node-runner.sh` | `1` makes the runner try only the node path given as its first argument and skip the `PATH` and well-known-location fallbacks. A diagnostic switch. |

## Installer

| Variable | Equivalent flag | Effect |
|----------|-----------------|--------|
| `GSD_PORTABLE_HOOKS` | `--portable-hooks` | `1` resolves node at hook-fire time instead of install time. |
| `GSD_RELATIVE_INCLUDES` | `--relative-includes` | `1` makes local installs emit project-relative `@`-includes. |
| `GSD_ARGS_NONCE_OFF` | none | `1` stops the installer from writing the typed-text terminator nonce. |
| `GSD_ALLOW_SYMLINKED_DEST` | none | `1` or `true` lets an install write through a symlinked destination; otherwise it refuses. |
| `GSD_INSTALLER_MIGRATION_RESOLVE` | none | `keep` or `remove` answers prompt-user migration actions when the installer runs without a TTY. See [Installer migration architecture](../installer-migrations.md). |

See [Installer flags](installer-flags.md) for the flags.

## `gsd-tools` behavior

| Variable | Equivalent flag | Effect |
|----------|-----------------|--------|
| `GSD_JSON_ERRORS` | `--json-errors` | `1` selects JSON error mode. See [JSON error mode](../json-errors.md). |
| `GSD_EXIT_CONTRACT` | `--exit-contract=<v>` | `v1` (default) or `v2`. The flag wins over the variable; an empty variable counts as unset; any other value throws. See [Exit code reference](exit-codes.md). |
| `GSD_AUDIT` | none | `1` turns on the dispatch observability logger (a stderr line on error, plus the opt-in file audit). `audit.enabled` in the project config also turns it on. |
| `GSD_AUDIT_ARGS` | none | `1` includes command arguments in the audit record; the default omits them. |
| `GSD_DISPATCH_MAX_CONCURRENCY` | none | A positive integer sets the dispatch capacity. When unset or invalid, the runtime's declared capacity applies, and 1 when the runtime declares none. |
| `GSD_WEBSEARCH_TIMEOUT_MS` | none | Web search timeout in milliseconds; a positive integer, default `10000`. |
| `GSD_SKIP_SCHEMA_CHECK` | `--skip` on `verify schema-drift` | `true` bypasses the schema-drift gate. |
| `GSD_MODEL_CATALOG` | none | Adds a path to the candidates tried for `model-catalog.json`, after the co-located catalog. |
| `GSD_SECTION_MANIFEST` | none | Replaces the path of the shipped `section-manifest.json`. |

## Hook safety switches

| Variable | Hook | Effect |
|----------|------|--------|
| `GSD_ALLOW_PLANNING_SHRINK` | `gsd-write-guard.js` | Any value other than empty, `0` or `false` (case-insensitive) lets a whole-file `Write` shrink a curated `.planning/` artifact. |
| `GSD_SECRET_READ_GUARD_ON_CRASH` | `gsd-secret-read-guard.js` | `deny` makes the guard block when it fails on its own; any other value, or none, keeps the default of allowing. |

## Pi

| Variable | Effect |
|----------|--------|
| `PI_CODING_AGENT_DIR` | Pi's own override for its global agent directory; GSD installs there. |
| `GSD_PI_DISPATCH_DEPTH` | Current dispatch nesting depth; unset or empty means top level. A value must be a non-negative integer below the cap (the cap is 1); anything else is treated as over the cap. |
| `GSD_PI_DISPATCH_TIMEOUT_MS` | Dispatch timeout in milliseconds; a positive number, default 30 minutes. |

## Variables set by the host

GSD reads these but does not expect you to set them.

| Variable | Read by | Effect |
|----------|---------|--------|
| `CLAUDE_ENV_FILE` | `gsd-path-export.js`, Pi extension | File to which the hook appends the installed `gsd-core/bin` directory so later Bash calls find `gsd_run`. No effect when unset. |
| `CLAUDE_PLUGIN_ROOT` | plugin hook commands, `gsd-ensure-canonical-path.js` | Root of the Claude Code plugin install. |
| `CLAUDE_PROJECT_DIR` | local-install hook commands | Project directory that local hook paths are anchored on. |
| `CLAUDE_CODE_DISABLE_WORKFLOWS` | Claude orchestration capability | Claude Code's workflow kill switch, read together with the `disableWorkflows` and `enableWorkflows` settings keys to decide whether the workflow backend is available. |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | teams status | Claude Code's agent-teams switch, read to report teams status. |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | `gsd-statusline.js` | Claude Code's auto-compact settings, read so the statusline's context bar matches the compact threshold. |

## State files

| File | Location | Format |
|------|----------|--------|
| `.gsd-profile` | runtime config directory | The install profile name as plain text (`full` in a default install). |
| `gsd-core/.gsd-runtime` | runtime config directory | The runtime id as plain text (`claude`, `hermes`, ...). |
| `gsd-core/VERSION` | runtime config directory | The installed version, no trailing newline. |
| `gsd-file-manifest.json` | runtime config directory | JSON object with `manifestVersion`, `version`, `timestamp`, `mode`, `runtime`, `scope` and `files`, a map from each installed relative path to its SHA-256 hash. |
| `gsd-install-state.json` | runtime config directory | JSON object with `schemaVersion` (1) and `appliedMigrations`, a list of `{ id, appliedAt, journal, checksum }`. |
| `.gsd-surface.json` | runtime config directory | JSON object with `baseProfile`, `disabledClusters`, `explicitAdds` and `explicitRemoves`, written by `/gsd-surface`. |
| `defaults.json` | `$GSD_HOME/.gsd/` | User-level config defaults. A non-Claude install sets `runtime` and `resolve_model_ids: "omit"` here. |
| `defaults-provenance.json` | `$GSD_HOME/.gsd/` | JSON object with `version` and `keys`; each key an installer set records its `setValue` and the `runtimes` that set it. |
