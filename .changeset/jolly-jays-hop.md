---
type: Fixed
pr: 0
---
**Cross-AI review no longer silently drops the Codex/Claude/Gemini lanes on large plan sets** — the prompt-fed reviewer blocks in review.md invoked each CLI with no explicit timeout, so a slow source-grounded review was killed at the host default (~2 min) and the lane was silently lost. The workflow now directs a high Bash timeout and frames an empty output as a timeout (not the crash it was misdiagnosed as). (#2194)
