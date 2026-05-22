---
type: Fixed
pr: 3808
---
**Codex adapter now activates TEXT_MODE when `request_user_input` is unavailable** — `bin/install.js:getCodexSkillAdapterHeader` previously told the agent only to "stop and present plain-text"; it now explicitly instructs the agent to append `--text` to `{{GSD_ARGS}}` so the workflow's built-in `TEXT_MODE` branching handles all `AskUserQuestion` gates consistently, eliminating silent-default selection in Codex Default mode (#3808).
