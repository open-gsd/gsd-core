---
type: Fixed
pr: 4735
---
`verify.artifacts` no longer aborts a plan's whole artifact check when one listed path is a directory. Reading a directory raised `EISDIR` out of the per-artifact loop, so the command printed `Error: EISDIR: illegal operation on a directory, read` and reported nothing at all — neither the offending entry nor the plan's other, perfectly checkable artifacts. A directory now fails as its own entry, with an issue distinct from `File not found`, and every other artifact is still checked and reported independently. A path that stat or read fails on for any other reason (a permissions error, an unreachable mount, or an artifact that disappears mid-check) fails the same way, carrying its errno, instead of discarding the run.
