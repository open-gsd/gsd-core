---
type: Added
pr: 5720
---
**Per-repository release mapping: `git.repo_tagging` and `milestone complete --release-map` record each repository's release when a milestone ships** — a new opt-in `git.repo_tagging` setting (`single` by default, so today's `git.create_tag` behavior is unchanged) and a `--release-map <file.json>` flag that archives the release version, reference, environment and status per repository in `<version>-RELEASE-MAP.json` and in the MILESTONES.md entry. (#3628)
