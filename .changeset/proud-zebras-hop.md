---
type: Fixed
pr: 5617
---
**Non-Claude executor dispatch no longer breaks on apostrophes in the agent persona** — an apostrophe in spliced agent-skills text or an inlined role file used to close the prompt's single-quoted shell assignment and run the rest as shell (`unexpected EOF`, `command not found`); the orchestrator now writes the prompt to a `mktemp` file and the shell reads it back with `cat`, so apostrophes, `$(...)`, backticks and quotes in that text reach the executor unchanged and never run as shell, and the dispatch halts when the file is missing, unreadable or empty. (#5531)
