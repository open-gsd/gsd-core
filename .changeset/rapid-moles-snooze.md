---
type: Changed
pr: 6555
---
**A fifth configuration-precedence copy now fails lint** — `local/no-adhoc-config-merge` flags reading a config layer file by a hand-built path, spread-merging parsed configs, and walking layers by hand, with an empty exemption list. Every layer file location now comes from one owner module per execution context (the loader and planning workspace, and a hook-side mirror). (#6555)
