# A user-configurable dispatch backend for `gsd_dispatch` on Pi

**Source:** [#6467](https://github.com/open-gsd/gsd-core/issues/6467)
**Decision:** wontfix — No-go as filed; a safe way to resolve a `pi.cmd` install stays welcome as a separate issue
**Date:** 2026-11-21

## Proposal summary

Reporter asked that `gsd_dispatch` (the Pi tool that runs a `gsd-*` agent role in an isolated child `pi` process) be configurable in how it dispatches: through a Pi plugin such as `pi-subagents`, through a wrapper script, or through another harness shipped by an LLM provider. The trigger was Windows, where `gsd_dispatch` looks for `pi.exe` and fails when only `pi.cmd` is installed. The reporter's own workaround is a local patch of the workflow files, replayed after each update.

## Why GSD does not own this

- **Dispatch on Pi is GSD-owned by design.** ADR-5559 section 1 has `gsd_dispatch` resolve the role from the install's own agent directory, check the role bytes against the install manifest, and run the child with `--no-extensions`, `--no-mcp` and `--no-approve`. A pluggable backend would hand the role prompt and the task to code GSD does not verify, which removes the properties that section exists to give.
- **A second dispatch path is a permanent tax.** `opencode-native-dispatch-backend.md` (#6435) declined a second core-resident dispatch backend on the ground that every later change to the executor lifecycle would be made twice. The same ground applies to a configurable backend here.
- **The `pi.cmd` refusal is deliberate, not a defect.** `resolvePiCommand` in `pi/gsd.cjs` accepts only `pi.exe` on Windows, with the comment that a `.cmd` shim cannot be spawned without a shell (Node refuses it, CVE-2024-27980). The report is right that this fails for a `pi.cmd`-only install; that failure is not a ground for rejection.

## What this does NOT cover

This entry denies a **user-configurable or pluggable dispatch backend for `gsd_dispatch`**. Its keyword surface (dispatch, Pi, wrapper, plugin, Windows) overlaps requests this decision does not deny. Do not apply it to:

- **A safe resolution of a `pi.cmd` install on Windows**, for example resolving the shim to the executable it launches without spawning a shell. That is a bug report or an enhancement of the shipped resolver.
- **Defects in the shipped `gsd_dispatch`** (refusal codes, timeouts, process-group kill, output caps). Each is a bug report, one per defect.
- **Pi runtime support generally**, and the parity items tracked under ADR-5559.

## Re-open criteria

- A resubmission names a specific failure of the shipped dispatcher that remains after a safe `pi.cmd` resolution exists, and shows that no change inside `gsd_dispatch` can address it.
- Or Pi dispatch is reduced to one backend-neutral seam, so a second backend adds no second copy of role verification, argv construction and process control.

## Related

- [`opencode-native-dispatch-backend.md`](./opencode-native-dispatch-backend.md): the same ground decided for OpenCode (#6435)
- [`codex-native-supervisor-adapter.md`](./codex-native-supervisor-adapter.md): the earlier decision on the same class of request
- [ADR-5559](../docs/adr/5559-pi-agent-role-dispatch.md): agent-role dispatch on Pi
- [#6467](https://github.com/open-gsd/gsd-core/issues/6467): the issue this was decided on
