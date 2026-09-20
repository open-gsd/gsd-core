---
type: Fixed
pr: 4712
---
**Slash-command suggestions no longer show the retired `/gsd:` form** — a handful of shipped command descriptions, agent bodies and workflow instructions used `/gsd:` tokens the installer could not convert, so they reached you as the deprecated colon form after a fresh install. One consequence was functional, not cosmetic: `/gsd-help --brief <topic>` looked for a signature line that the installed reference never renders, so every topic silently fell back to its first paragraph. (#4324)
