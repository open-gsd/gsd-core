---
type: Fixed
pr: 1079
---
`validate agents` (and `validate health`) now cross-reference the install manifest to detect manifest-backed Codex agent pair drift: when a generated `agents/gsd-*.md` / `agents/gsd-*.toml` pair has one side missing on disk, the agent is reported as incomplete and `agents_found` is `false` (previously a false-healthy `agents_found: true, missing: []`). `validate health` names the incomplete agents and recommends re-running the installer. The check no-ops when no manifest is present. (#1058)
