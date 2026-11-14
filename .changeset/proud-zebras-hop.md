---
type: Fixed
pr: 5617
---
**Non-Claude executor dispatch no longer breaks on apostrophes in the agent persona** — an apostrophe in the persona used to end the prompt early and run the rest as shell, so the orchestrator now writes the prompt with its file tool to a file in the `.claude` directory that the first block creates, and a second block reads it back and the prompt reaches the executor as written, trailing newlines included. The orchestrator now substitutes nine plan placeholders, and fills the template's TDD line from the `TDD_APPLICABLE=` value block 1 prints. A prompt holding a NUL byte halts instead, and every halt this adds exits 69. A prompt file a crashed wave left behind is swept after a day. (#5531)
