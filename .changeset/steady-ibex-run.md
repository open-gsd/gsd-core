---
type: Fixed
pr: 2049
---
**Skill-bearing capabilities now surface correctly on flat command-layout installs** — on an install using the flat `commands/gsd-<stem>.md` source layout (e.g. a Claude Code local project install with no `commands/gsd/` subdir), every skill-bearing capability (`nyquist`, `code-review`, `security`, `ui`, `mempalace`, `ai-integration`, `profile-pipeline`) was silently reported `surfaced:false`/`enabled:false`/`active:false`, so their loop hooks (`verify:post`, `execute:post`, etc.) never fired even with the corresponding `workflow.*` toggle on. The skill-manifest resolver now detects the flat layout and produces the same stems the nested `commands/gsd/*.md` loader does. (#1858)
