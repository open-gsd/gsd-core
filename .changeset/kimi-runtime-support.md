---
type: Added
pr: 743
---
**Kimi CLI runtime support is now documented and installable** — users can install global GSD Agent Skills with `--kimi --global`, invoke them as `/skill:gsd-*`, and launch the generated custom agent explicitly with `kimi --agent-file`. The custom-agent (`--agent-file`) surface targets the legacy/Python `kimi-cli` contract; newer Kimi Code (`@moonshot-ai/kimi-code`) consumes the same `/skill:gsd-*` skills via `--skills-dir` instead.
