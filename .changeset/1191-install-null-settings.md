---
type: Fixed
pr: 1233
---
**`gsd install` no longer warns that `settings.local.json` "may be malformed" when the file contains a valid JSON `null`.** `readSettings` now treats a successfully-parsed `null` as empty settings (`{}`) instead of collapsing it into the parse-failure path, so a literal-`null` settings file is preserved silently; genuinely unparseable files still emit the warning. (#1191)
