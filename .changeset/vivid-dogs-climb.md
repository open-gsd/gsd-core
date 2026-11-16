---
type: Fixed
pr: 0
---
**A quoted grep pattern that ends in a regex escape like `\.env` is no longer denied as a secret-file read** — the secret-read guard read the backslash of the escape as a path separator in Bash operands, so `grep -E 'migrations/|\.env'` was blocked although no file named `.env` is read. Windows-shaped paths (`C:\proj\.env`, `\\host\share\.env`) are still blocked. (#5883)
