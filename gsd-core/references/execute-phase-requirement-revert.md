**Revert this phase's own requirement IDs out of `Complete` before rendering the gap report (#2388).** A shared requirement ID can already read `Complete` at this point (its first-declaring plan finished before this verification ran) — a `gaps_found` verdict must not leave that premature `Complete` sitting in REQUIREMENTS.md. Scoped strictly to `PHASE_REQ_IDS` (this phase's own citations from `init.execute-phase`), so another phase's `Complete` row is never touched:

```bash
if [ -n "${PHASE_REQ_IDS}" ]; then
  gsd_run query requirements.revert-phase ${PHASE_REQ_IDS} >/dev/null 2>&1 || true
  gsd_run query commit "docs(phase-{X}): revert premature Complete requirements after gaps found" --files .planning/REQUIREMENTS.md >/dev/null 2>&1 || true
fi
```
