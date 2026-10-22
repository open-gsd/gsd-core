---
type: Fixed
pr: 5598
---
**A clean Codex install no longer reports 26 false sandbox violations from `validate agents`** — the sandbox posture check derives each role's expected `sandbox_mode` from the canonical agent definitions that carry the `tools:` declaration, but in an installed config directory it looked in `<config>/agents`, the converted runtime copies without `tools:`, so every workspace-write role looked like it should be read-only. It now prefers `<config>/gsd-core/agents` and still resolves `agents/` in the repository and npm-package layouts; a TOML that truly disagrees with its role is still reported. Project-scoped (local) installs do not ship the canonical agent sources, so they are unchanged. (#5496)
