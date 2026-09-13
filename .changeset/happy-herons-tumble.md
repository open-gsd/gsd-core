---
type: Fixed
pr: 4659
---
**Secret-free `.env` templates with a qualifier are readable again** — the read guard compared everything after `.env.` as one token against a set of final extensions, so a committed template like `.env.local.example` was refused and the reader was pushed toward the real secret file it exists to replace. Classification now keys on the final extension. (#4580)
