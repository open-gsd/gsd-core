---
type: Fixed
pr: 5665
---
**OpenCode and Kilo no longer draw the read-before-edit reminder over the prompt input** — the plugins wrote every hook advisory to stderr, which the TUI paints on top of the input field; advisories still reach the model through the tool output (OpenCode) and metadata (OpenCode and Kilo). (#5648)
