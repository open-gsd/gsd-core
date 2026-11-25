---
type: Fixed
pr: 6668
---
**Settings files with an unterminated block comment are now rejected instead of silently truncated** — the installer, the shared config reader, and JSONC config edits walked past the end of the file looking for a block comment's closing `*/` without verifying one existed, so a settings.json truncated mid-comment parsed as valid and everything after the dangling `/*` was dropped. (#5990)
