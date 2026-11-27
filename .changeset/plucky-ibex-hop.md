---
type: Changed
pr: 6657
---
**New projects use bracket phase IDs** — Previously, initialization required a convention and code choice to use bracket IDs. New projects now derive a code from the PROJECT.md title when it exists, otherwise from the directory name; valid explicit codes and convention choices win. Invalid inherited codes warn and derive a replacement. The deprecated sequential naming alias normalizes case-insensitively to generated. Custom bracket adds preserve supplied identities and refuse sentinel, unsafe or duplicate IDs; custom add-batch directs callers to individual phase add --id commands. Existing projects and config repair retain their convention.
