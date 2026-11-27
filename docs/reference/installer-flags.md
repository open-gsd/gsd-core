# Installer flags

Reference for the options of the GSD Core installer, `npx @opengsd/gsd-core [options]` (the `gsd-core` binary takes the same options). Run without options, the installer asks for a runtime and a location interactively. For a task-oriented walkthrough see [Install on your runtime](../how-to/install-on-your-runtime.md); for an update see [Update GSD manually](../manual-update.md).

## Location

| Flag | Effect |
|------|--------|
| `-g`, `--global` | Install into the runtime's user-level config directory |
| `-l`, `--local` | Install into the current project |
| `-c <path>`, `--config-dir <path>` | Install into this config directory. Takes priority over the runtime's config-directory environment variable |

The environment variables that `--config-dir` overrides are `CLAUDE_CONFIG_DIR`, `OPENCODE_CONFIG_DIR`, `KILO_CONFIG_DIR`, `CODEX_HOME`, `KIMI_CONFIG_DIR`, `COPILOT_CONFIG_DIR`, `COPILOT_HOME`, `ANTIGRAVITY_CONFIG_DIR`, `CURSOR_CONFIG_DIR`, `WINDSURF_CONFIG_DIR`, `AUGMENT_CONFIG_DIR`, `TRAE_CONFIG_DIR`, `QWEN_CONFIG_DIR`, `HERMES_HOME`, `CLINE_CONFIG_DIR` and `CODEBUDDY_CONFIG_DIR`. Kimi Code reads `KIMI_CODE_HOME`, and Kimi CLI reads `KIMI_SHARE_DIR`.

## Runtime selection

Combine any number of runtime flags; with none, the installer asks.

| Flag | Installs for |
|------|--------------|
| `--claude` | Claude Code |
| `--opencode` | OpenCode |
| `--kilo` | Kilo |
| `--codex` | Codex |
| `--kimi` | Kimi CLI (config under `~/.kimi`) |
| `--kimi-code` | Kimi Code (config under `~/.kimi-code`) |
| `--copilot` | Copilot |
| `--antigravity` | Antigravity |
| `--cursor` | Cursor |
| `--windsurf`, `--devin-desktop` | Windsurf (`--devin-desktop` is an alias) |
| `--augment` | Augment |
| `--trae` | Trae |
| `--qwen` | Qwen Code |
| `--hermes` | Hermes Agent |
| `--cline` | Cline |
| `--codebuddy` | CodeBuddy |
| `--zcode` | ZCode |
| `--pi` | Pi |
| `--all` | All 18 runtimes above |
| `--both` | Claude Code and OpenCode |

**`--gemini` is retired.** Gemini CLI was sunset by Google on 2026-06-18. `--gemini` prints a redirect to `--antigravity` and exits with status 1 when it is the only runtime flag; combined with another runtime flag the notice is printed and the other runtime installs. `--gemini --uninstall` exits with status 1 and prints the manual cleanup steps. `--help` still lists `--gemini`. <!-- gsd-allow-retired-runtime-name: this paragraph documents that the retired runtime flag is refused (#1928) -->

**Kimi variants.** `--kimi` and `--kimi-code` are separate products with separate hook roots. When the selected variant does not match the config the installer finds (`~/.kimi/config.toml` or `~/.kimi-code/config.toml`), it prints a notice.

## Skill profile

| Flag | Effect |
|------|--------|
| `--profile=<name>` | Install a named skill profile: `core` (8 main-loop skills), `standard` (15 skills including `phase`, `review` and `config`), or `full` (every skill, the default). Names combine with commas, as in `--profile=core,audit`, and install the union of their closures. The profile is persisted and respected by `gsd update` |
| `--minimal`, `--core-only` | Aliases for `--profile=core`. Combining either with `--profile` exits with status 1 |

## Behavior flags

| Flag | Effect |
|------|--------|
| `-u`, `--uninstall` | Remove all GSD files for the selected runtime and location |
| `--dry-run` | Preview the legacy `get-shit-done-cc` cleanup and exit without installing. It does not preview `--uninstall`; with `--uninstall` it says so |
| `--no-legacy-cleanup` | Skip the legacy `get-shit-done-cc` artifact scan. An explicit `--config-dir` already limits the scan to that directory. With `--dry-run` the output notes that the scan was skipped |
| `--force-statusline` | Replace a `statusLine` setting that is already present, and write the statusLine on a `--local` install, which otherwise skips it to avoid overriding profile-level settings |
| `--portable-hooks` | Write `$HOME`-relative hook paths in `settings.json` and resolve the node runner when a hook fires, through `hooks/gsd-node-runner.sh`, for WSL and Docker bind-mount setups. Also enabled by `GSD_PORTABLE_HOOKS=1` |
| `--relative-includes` | With `--local`: write project-relative `@` includes (`.claude/gsd-core/...`) instead of this checkout's absolute path, so each git worktree of one repository reads its own copy. Also enabled by `GSD_RELATIVE_INCLUDES=1`; with `--global` it has no effect |
| `--reclaim-kimi-legacy` | With `--kimi-code`: also remove the GSD hooks that a Kimi Code install before 1.10.0 left in `~/.kimi`. Opt-in, because those files cannot be told apart from Kimi CLI's own |
| `-h`, `--help` | Print the option summary |

## See also

- [Clean up get-shit-done-cc](../cleanup-get-shit-done-cc.md): the procedure that uses `--dry-run` and `--no-legacy-cleanup`
- [Install minimal and add skills](../how-to/install-minimal-and-add-skills.md): the profile flags in use
