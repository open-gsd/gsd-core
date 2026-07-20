---
type: Fixed
pr: 2464
---
**`/gsd-mempalace-capture` no longer crashes on first invocation** — the skill's own documented `rooms:` example wrote a flat list of bare strings, but mempalace's miner expects each entry as a dict with a `name` key, so following the example verbatim and running `mempalace mine` crashed with `TypeError: string indices must be integers, not 'str'`. Both `skills/gsd-mempalace-capture/SKILL.md` and `commands/gsd/mempalace-capture.md` now ship the corrected `- name: <room>` shape, so the documented example runs successfully end-to-end.
