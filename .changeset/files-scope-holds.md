---
type: Fixed
pr: 6417
---
**`/gsd-code-review --files` reviews exactly the listed files on macOS and zsh, and fails closed** — the comma split used bash-only `read -a` in a different block from the one that used it (zsh: `bad option: -a`, so the list was empty), the repository check used GNU `realpath -m` (BSD: every relative path looked outside), and a list that resolved to nothing silently widened to the phase scope while still logging `--files override`. The split now lives in the same block with a portable loop, paths resolve through `node`, and a list that resolves to no reviewable file inside the repository prints an error and exits non-zero. The reviewer-lane slug list splits portably too, and the macOS note no longer sends users to install coreutils. (#6152)
