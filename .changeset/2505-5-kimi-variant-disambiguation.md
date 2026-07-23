---
type: Added
pr: 2535
---
<!-- docs-exempt: Phase 5 adds install-time notices (descriptions + mismatch warning) — no new user-facing command/config surface; the disambiguation is transient console output during `npx @opengsd/gsd-core`. -->
**The installer now distinguishes Kimi CLI (Python) from Kimi Code (Node) at install time** — running `--kimi` or `--kimi-code` prints a one-line description of each product, and if the selected variant doesn't match the detected `~/.kimi/config.toml` vs `~/.kimi-code/config.toml`, the installer warns with the correct `--kimi-code` / `--kimi` re-run command. Catches the "ran `--kimi --global` but actually on Kimi Code" mistake that produced inert YAMLs and empty agent-skills before the Phase 1 descriptor split. (#2513)
