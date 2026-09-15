---
type: Changed
pr: 4732
---
**Antigravity's tool-name converter is named for Antigravity** — the helpers that map Claude tool names into Antigravity agent frontmatter were still named for the Gemini CLI runtime that was removed in 1.8.0, so anyone reading the installer saw a converter for a runtime GSD no longer supports. The mapping itself is unchanged: Antigravity runs on the Gemini backend and still receives the same tool names it always did. (#4727)
