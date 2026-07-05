---
type: Fixed
pr: 2031
---
**`applySurface` no longer deletes every `gsd-*` agent when the skills manifest resolves empty** — the agent-prune loop in `_syncGsdDir` deleted any `gsd-*.md` not in the staged set, and when the manifest was empty/unresolvable (null manifest, no array entries, no `files` key, or an unresolvable install source root), the staged set was empty → every agent was pruned. Skills were guarded by `pruneSkillDirs`'s manifest-membership check (conservative preservation on empty manifest); agents had no equivalent. The agent-prune loop is now skipped when the manifest is empty/absent, so agents are preserved while copy (adding genuinely new agents) still runs. (#2018)
