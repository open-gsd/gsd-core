---
type: Fixed
pr: 167
---
**`gsd-tools` query meta-command parity** — direct invocations like `node gsd-tools.cjs query init.progress` now behave the same as `node gsd-tools.cjs init.progress` instead of failing with `Unknown command: query`. This unblocks workflow preflight paths that call the CJS entrypoint directly with the `query` prefix.
