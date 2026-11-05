**Revert this phase's own requirement IDs out of `Complete` before rendering the gap report (#2388).** A shared requirement ID can already read `Complete` at this point (its first-declaring plan finished before this verification ran) — a `gaps_found` verdict must not leave that premature `Complete` sitting in REQUIREMENTS.md. Scoped strictly to `PHASE_REQ_IDS` (this phase's own citations from `init.execute-phase`), so another phase's `Complete` row is never touched:

```bash
IFS= read -rd '' GSD_ARGS <<'GSD_ARGS_END' || true
$ARGUMENTS
GSD_ARGS_END
GSD_ARGS=${GSD_ARGS%$'\n'}
GSD_WS=$(echo " $GSD_ARGS" | sed -nE 's/.* --ws +([A-Za-z0-9][A-Za-z0-9._-]*).*/--ws \1/p' | head -n 1)
if [ -n "${PHASE_REQ_IDS}" ]; then
  gsd_run query requirements.revert-phase ${GSD_WS:+--ws=${GSD_WS##* }} ${PHASE_REQ_IDS} >/dev/null 2>&1 || true
  [ ! -f "{requirements_path}" ] || gsd_run query commit "docs(phase-{X}): revert premature Complete requirements after gaps found" --files "{requirements_path}" >/dev/null 2>&1 || true  # null (absent) requirements_path: nothing to commit, never an empty pathspec
fi
```
