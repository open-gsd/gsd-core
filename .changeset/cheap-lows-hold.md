---
type: Fixed
pr: 6410
---
**Budget `low` routes every tier to the provider's cheapest model** — the `anthropic` and `anthropic-fable` presets sent opus-tier agents (the quality-profile planner and executor) to `claude-opus-4-5`, which collapses to the current Opus on Claude, under the budget the settings table documents as haiku in every column. The opus `low` cell is now `claude-haiku-4-5` in both presets, and the same disagreement is fixed for `openai` (`gpt-5.6-luna`) and `qwen` (`qwen3-coder-next`). A test now fails when a preset's `low` cells differ from the documented table row. (#6125)
