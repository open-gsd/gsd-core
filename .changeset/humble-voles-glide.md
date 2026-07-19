---
type: Fixed
pr: 2428
---
**Subagent prompts embedding orchestrator-relative planning paths now resolve correctly when the spawned subagent's own working directory differs from the orchestrator's (e.g. a git worktree)** — `init.*` (and `state.load`) command handlers now emit `state_path`, `roadmap_path`, `phase_dir`, `project_path`, `research_dir`, `codebase_dir`, `intel_dir`, `conflicts_path`, `debug_dir`, and similar fields as absolute paths anchored on the project root, and the planner/checker/verifier/synthesizer/roadmapper/debugger/mapper/classifier subagent-prompt blocks that previously hardcoded bare `.planning/...` literals now reference those fields instead; a subagent spawned into a different cwd would previously report real, already-committed files as missing. (#2376)
