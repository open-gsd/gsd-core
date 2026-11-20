---
type: Fixed
pr: 0
---
**The secret-read guard denies a read nested past the nesting limit instead of allowing it unscanned** — `cat .env` inside four `bash -c` layers (or five nested `"$( )"`, backticks, process substitutions, `eval`, `xargs` or `git -c` scripts) was allowed because the guard stopped rescanning at three levels, while three layers were blocked. A command nested deeper than three levels is now blocked with the named code `nesting-too-deep`, the way an over-length command is blocked as `command-too-large`; a secret read found at a shallower level is still the block reported. The guard also now descends into backticks nested with escaped backticks (`` `echo \`cat .env\`` ``), which it used to end at the first escaped backtick and read as plain text. (#6136)
