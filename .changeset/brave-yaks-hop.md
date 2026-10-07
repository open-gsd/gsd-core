---
type: Fixed
pr: 5250
---
**The GSD plugin now loads on OpenCode 2.x, and its guards now actually block on OpenCode 1.x and Kilo** — OpenCode 2.x rejected the plugin at every start with `Missing key at ["default"]["effect"] / ["default"]["setup"]`; the plugin now also exports the 2.x `setup` entrypoint, and on 2.x the tool guards (including on `shell` and `patch` calls), `GSD_DIR` in shells, the compaction context, the session-start hooks and the config reload run through the same hooks 1.x uses. On OpenCode 1.x and on Kilo, which ships the same plugin, the guard hooks never ran, because each hook subprocess relaunched the host binary instead of running the hook as JavaScript; hooks now run as JavaScript under the host's Bun, so secret reads and worktree-escaping writes that used to pass are now blocked there.
