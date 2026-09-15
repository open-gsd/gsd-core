---
type: Fixed
pr: 4756
---
**Asking for a retired runtime no longer silently installs Claude Code** — passing a sunset runtime id resolved to Claude Code's label and config home, so `getGlobalConfigDir('gemini')` and `getGlobalConfigDir('claude')` returned byte-identical paths and the install reported itself as Claude Code. The four runtime-resolution accessors now fail with a message naming the successor and the retiring issue. Genuinely unknown and future runtime ids keep their existing safe defaults, which is a deliberate distinction: absence of knowledge is not the same as recorded retirement. (#4709)
