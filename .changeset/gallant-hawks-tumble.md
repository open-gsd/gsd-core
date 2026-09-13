---
type: Security
pr: 4672
---
**Installed capability skills can no longer be redirected or leaked through a symlink** — the three install paths that confine a capability skill name relied on a lexical check, which cannot see a symlink. A link planted at the destination let `mkdirSync` succeed silently and the SKILL.md write land outside the install root, and a link planted at a capability's own SKILL.md was followed by `statSync` so an outside file's contents were installed as a skill body. All three now refuse to write or read through a link. (#4636)
