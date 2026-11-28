---
id: 168
title: Runtime Identity
group: v1.7.0 Features
---

**Purpose:** The predecessor package `get-shit-done-cc` publishes a binary named `gsd-tools`, and so does this one. They answer some of the same verb names with **different semantics** ([#3129](https://github.com/open-gsd/gsd-core/issues/3129): `phases.clear` archives here and deletes there, with no error and nothing recoverable from git). The workflow could not tell it had reached the wrong handler, and the handler could not tell it had been called by a workflow written for a different contract (#3146). The reasoning behind the design is in [Runtime identity: why the PATH branch and the anchored probe](../explanation/runtime-identity-design.md).

**Behavior:** two independent defenses, one structural and one asserted.

- **Structural — the `PATH` branch.** The launcher's `PATH` resolution branch looks for `gsd_run` instead of `gsd-tools`. Only this package publishes `gsd_run`, and it executes the `gsd-tools.cjs` beside it.
- **Asserted — every other branch.** After resolution and before any verb runs, the preamble probes the chosen tool with `runtime-identity --raw` and matches the answer anchored at both ends against the compact payload. It exports a two-valued `GSD_IDENTITY_STATUS` (`ok` / `unverified`) and, when `unverified`, prints one line naming both plausible causes. `gsd-tools runtime-identity` stays available by hand.
- **Fails closed.** If no `gsd_run` is reachable, the resolver falls through its path-based branches and finally errors with an install command; it never executes whatever `gsd-tools` is on `PATH`.

**Known limits:**
- **The assertion warns; it does not yet stop the run.** The rollout is warn-then-fail. It cannot hard-fail yet because an `@opengsd/gsd-core` older than the `runtime-identity` verb answers exactly as a foreign package does — neither answers — and at rollout the old-version case is the common one. The warning therefore names both causes. A later release turns `unverified` into a refusal.
- An installation old enough to predate `bin/gsd_run` ([#381](https://github.com/open-gsd/gsd-core/issues/381)) is not reachable through the `PATH` branch and must be upgraded or invoked through one of the path-based branches.
- The probe costs one extra process launch per preamble source. It is a pure local read of baked coordinates, deliberately kept off the SDK bridge for that reason.

**Reference:** [`runtime-identity`](COMMANDS.md#runtime-identity) · [Diagnose which gsd-tools is running](how-to/diagnose-a-foreign-gsd-tools.md)
