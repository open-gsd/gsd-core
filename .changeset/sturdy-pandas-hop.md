---
type: Added
pr: 0
---
**Projects can exempt a committed env template from the secret-read guard** — a repo whose placeholder template is named like a secret (`.env.production`) could not let agents read it without removing the guard for every `.env` file; list it in `hooks.secret_read_exempt` and the guard lets it through while it stays committed as a regular file, and an unconfigured project blocks exactly as before. (#4432)
