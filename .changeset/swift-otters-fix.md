---
"@opengsd/gsd-core": patch
---

fix: route hardcoded $HOME gsd-tools invocations in agents and graphify/import commands through the gsd_run launcher (global/shim-only install resolution); add a regression guard over agents/ + commands/ bash blocks.
