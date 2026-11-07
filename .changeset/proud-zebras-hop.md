---
type: Fixed
pr: 5617
---
**Non-Claude executor dispatch no longer breaks on apostrophes in the agent persona** — an apostrophe in the persona used to end the prompt early and run the rest as shell, so the prompt now goes through a file and reaches the executor as written, trailing newlines included, and a prompt file a crashed wave left behind is swept after a day. (#5531)
