---
type: Fixed
pr: 4768
---
**`/gsd-execute-phase`, `/gsd-autonomous --from|--to|--only`, `/gsd-plan-review-convergence` and the TDD plan path now handle letter-variant phase ids (`12A`, `3A`, `23A.1.2`)** — seven shell sites outside #4660's six still assumed a phase number was digits-and-dots: the post-#4619 `$((10#$PHASE_INT))` split aborted bash on `03A`, the review-file lookup's `printf "%02d"` printed the wrong file (and read an already-padded `08` as octal), and the `--from`/`--to`/`--only` and plan-review-convergence extractions silently truncated `12A` to `12` (and `23.1.2` to `23.1`). The split now stops at the first non-digit, `init execute-phase` emits `padded_phase` for the lookup, the extractions use the canonical grammar, the legacy normalizer pads a letter id, a parity test drives every site's live shell against a letter-suffixed fixture, and `lint-phase-id-drift` gains three ratchets so none of the shapes can return silently. (#4748)
