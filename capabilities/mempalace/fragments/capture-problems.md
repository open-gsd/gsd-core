<!--
  MemPalace capability — contribution fragment.
  Rendered into the execute:post verifier prompt when `mempalace.capture_artifacts` is true.
  Contributes DATA (capture instructions), not control flow. onError: skip — never fails a phase.
-->
### Capture problems → fixes (MemPalace)

**Gate first.** Read `.planning/config.json`. If `mempalace.enabled` is not `true`, or `mempalace.capture_artifacts` is `false`, **skip this entire section** and let verification complete unchanged. (This contribution is only injected when the capability is enabled; the `capture_artifacts` check lets you turn capture off without disabling the rest of the capability.)

Otherwise — after verifying this phase, persist any *confirmed* problem→fix pairs into the palace so they are recalled in future phases. This is best-effort; if MemPalace is unreachable, skip silently — capture never fails a phase.

**Tool availability.** The verifier's default tools are Read, Write, Bash, Grep, Glob and Skill; the `mempalace_*` MCP calls below run only where your runtime exposes them to this agent. Otherwise take the headless path in step 3 and skip steps 2 and 4 (the headless mine files under deterministic drawer IDs).

For each confirmed bug/issue resolved in this phase:

1. **Resolve the wing** (`mempalace.wing`, else `project_code`, else project dir) and target `room: problems`.
2. **Dedupe first.** Call `mempalace_check_duplicate` (interactive) before filing so re-runs don't create duplicate drawers.
3. **File the drawer verbatim.** Store the problem statement and its fix as a drawer in `room: problems` — interactive: `mempalace_add_drawer`; headless: stage the artifact under the `problems/` folder and run `mempalace mine` with the daemon route and bounded retry of `gsd-mempalace-capture` step 3 — `--daemon --background` only when `mempalace daemon status` already reports a running daemon, never starting one (#6266) (no `--room` flag; a running daemon queues the write when another writer holds the palace lock, otherwise a held lock is retried and a failure is reported, #4700 — see [CLI reference](https://mempalaceofficial.com/reference/cli.html); room assignment is via `detect_room()` folder-path match per the [mining guide](https://mempalaceofficial.com/guide/mining.html); use the same staging pattern documented in `gsd-mempalace-capture` Step 3). Include provenance (`source_file`, phase id).
4. **Mirror the KG fact** when `mempalace.mirror_kg` is on: add `(<bug>, fixed_by, <fix>)` with `valid_from` = the phase date via `mempalace_kg_add`.
5. **Mode awareness** (`mempalace.memory_mode`). Under `augment` the fact is an *additive* mirror alongside `.planning/graphs/`. Under `kg_backend`/`replace` the palace is the *authoritative* store for the fact; GSD still writes `.planning/graphs/` through its normal graphify, so an unreachable palace never loses it.

Captures are idempotent: deterministic drawer IDs + `check_duplicate` mean re-running the phase re-files the same content without duplication. On any error, skip and let verification complete normally.
