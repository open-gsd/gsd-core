---
type: Fixed
pr: 4858
---
**Codex installs rewrite @ includes to the codex root** — codex-installed agents and commands kept `@~/.claude/gsd-core/…` and `@$HOME/.claude/gsd-core/…` includes pointing into the Claude install (silently reading the wrong copy on dual-runtime machines, resolving to nothing on codex-only ones). The installer now rewrites the @-include form across manifest-tracked artifacts; the deliberate `$PREFERRED_CONFIG_DIR`/`_GSD_RUNTIME_ROOT` fallback chains and prose `.claude` mentions stay untouched. (#4667)
