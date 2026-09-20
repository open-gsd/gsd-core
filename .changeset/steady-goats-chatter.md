---
type: Fixed
pr: 4753
---
**The four translated READMEs no longer advertise a retired runtime** — Japanese, Korean, Brazilian Portuguese and Simplified Chinese each still listed `Gemini CLI` among the supported runtimes and in the installer's runtime prompt, a year after #1928 removed it; all three sites per locale now match English. `VERSIONING.md` also listed a manifest that #1928 deleted, and omitted the VS Code manifest that replaced it. A new `lint-retired-runtime-name` check now fails CI if a retired runtime is named as live in shipped Markdown. (#4729)
