---
type: Fixed
pr: 6387
---
**The real-loader plugin test no longer starts `claude -p` with the developer's credentials** — it inherited `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` and the provider-selection variables, so a contributor with one set ran a real model turn on their account, and the plugin's SessionStart hook spawned the update worker, which queried the npm registry; the spawn now carries none of them, runs with npm offline and hooks disabled, and still reads the loader's `system init` slash-command list. (#6091)
