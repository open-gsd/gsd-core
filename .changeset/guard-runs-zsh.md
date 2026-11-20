---
type: Fixed
pr: 0
---
**The executor path guard runs under zsh and gives the same verdicts as under bash** — the guard that parallel executors run before an `<automated>` command used bash-only `read -ra` and a 0-based array pop in its path normalizer, and `${s:i:1}` substrings that zsh reads as a history modifier, so under zsh every command errored and no cwd drift or main-checkout path was ever reported. The normalizer is now plain string handling, the substrings use `${s:$i:1}`, and a path that normalizes to the filesystem root is `/` rather than `//`. (#6153)
