---
type: Fixed
pr: 4127
---
**/gsd-code-review no longer sweeps commits landed outside the phase into the review scope** — the Tier-3 changed-file set is now derived from the phase's own commits instead of `DIFF_BASE..HEAD`, so re-reviewing a closed phase (or reviewing on a shared tree with interleaved work) no longer inflates the file count, no longer floods the review with unrelated files, and no longer silently downgrades `--depth=deep` to `standard` on a wrong >50 count. (#3926)
