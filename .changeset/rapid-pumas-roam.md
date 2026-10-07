---
type: Fixed
pr: 0
---
**`init`, `validate agents`, `docs-init` and `agent-skills` no longer exit 1 for an UNKNOWN runtime id** — an EoS host integration whose runtime GSD does not know now gets `agents_installed: null` with `agents_installed_reason: "unknown_runtime"` (`agents_found_reason` in `validate agents`) instead of `UnknownRuntimeError`; KNOWN runtimes are unchanged, and install still refuses an UNKNOWN id.
