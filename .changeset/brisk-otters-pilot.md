---
type: Feature
pr: 4952
---
**`--workbuddy` runtime support** — GSD Core now installs into WorkBuddy, the Tencent-built AI host built on the CodeBuddy Code core. The install shape, hook event dialect, and slash-command/skill/agent surface mirror CodeBuddy; only the root path (`~/.workbuddy` / `./.workbuddy`, env `WORKBUDDY_CONFIG_DIR`) and the per-command `$ARGUMENTS` interpolation differ. WorkBuddy preserves `$ARGUMENTS` verbatim in command bodies (CodeBuddy rewrites it to `{{GSD_ARGS}}`), so the conversion pipeline keeps the native form. Use `npx @opengsd/gsd-core@latest --workbuddy --global` (or `--local`) to install.
