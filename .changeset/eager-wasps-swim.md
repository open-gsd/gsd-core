---
type: Fixed
pr: 2445
---
**`GSD_ALLOW_SYMLINKED_DEST=1` lets users with intentional symlinked configHome layouts install/update again** — v1.7.0's destSubpath write-confinement (ADR-1239 Phase B) refused install/update whenever CLAUDE_CONFIG_DIR (or an artifact-kind child like `skills/` or `hooks/`) was a pre-existing symlink, with no opt-out. Three legitimate user-owned layouts were blocked: multi-account configs with symlinked shared skills/hooks (POSIX symlinks), Windows Junctions to shared skills dirs, and dotfiles-managed configHome (e.g. nix-darwin symlinking `~/.claude` itself to a version-controlled dir). The new env var follows user-owned symlinks instead of refusing them, while preserving the two load-bearing refusals from the original threat model: path-traversal in the destSubpath string itself (`../../etc`-style), and a symlink resolving to the install root itself (would let the prune pass wipe it). (#2393)
