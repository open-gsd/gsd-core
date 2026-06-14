<!--
  MemPalace capability — contribution fragment.
  Rendered into the execute:wave:post verifier prompt when `mempalace.capture_artifacts` is true.
  Contributes DATA (capture instructions), not control flow. onError: skip — never fails a wave.
-->
### Capture problems → fixes (MemPalace)

**Gate first.** Read `.planning/config.json`. If `mempalace.enabled` is not `true`, or `mempalace.capture_artifacts` is `false`, **skip this entire section** and let the wave complete unchanged. (This contribution is only injected when the capability is enabled; the `capture_artifacts` check lets you turn capture off without disabling the rest of the capability.)

Otherwise — after verifying this wave, persist any *confirmed* problem→fix pairs into the palace so they are recalled in future phases. This is best-effort; if MemPalace is unreachable, skip silently — capture never fails a wave.

For each confirmed bug/issue resolved in this wave:

1. **Resolve the wing** (`mempalace.wing`, else `project_code`, else project dir) and target `room: problems`.
2. **Dedupe first.** Call `mempalace_check_duplicate` (interactive) before filing so re-runs don't create duplicate drawers.
3. **File the drawer verbatim.** Store the problem statement and its fix as a drawer in `room: problems` — interactive: `mempalace_add_drawer`; headless: `mempalace mine` / `mempalace hook run`. Include provenance (`source_file`, phase id).
4. **Mirror the KG fact** when `mempalace.mirror_kg` is on: add `(<bug>, fixed_by, <fix>)` with `valid_from` = the phase date via `mempalace_kg_add`.
5. **Mode awareness.** Only `augment` is currently wired: the fact is an *additive* mirror alongside `.planning/graphs/` (never a replacement). `kg_backend`/`replace` are forward-declared and behave as `augment` today.

Captures are idempotent: deterministic drawer IDs + `check_duplicate` mean re-running the wave re-files the same content without duplication. On any error, skip and let the wave complete normally.
