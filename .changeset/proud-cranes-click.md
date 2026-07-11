---
type: Changed
pr: 2173
---
**Long-context model names render compactly in the statusline** — the verbose " (1M context)" suffix Claude Code appends to the model display name now collapses to a compact " (1M)" badge (tolerant of future window sizes and the abbreviated "ctx" variant: "(500K context)" → "(500K)", "(1M ctx)" → "(1M)"). Lossless — the long-context signal stays, the 12 characters of width don't. (#2160)
