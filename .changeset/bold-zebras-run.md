---
type: Fixed
pr: 0
---
**Antigravity agents get native tool names as a YAML sequence** — converted agents carried Gemini CLI tool names (`read_file`, `search_file_content`, `run_shell_command`) as a comma-separated scalar, while Antigravity's documented subagent contract wants a YAML sequence of native names (`view_file`, `grep_search`, `run_command`, `replace_file_content`); wrong or malformed grants can hang the subagent. The installer's twin converter changes in lockstep. (#4705)
