---
type: Fixed
pr: 6263
---
**A project-coded or unpadded phase directory now resolves its own `NN-UAT.md` and `NN-VERIFICATION.md`** — in a directory such as `XR-03-demo` or `5-demo` the resolver looked only for a file named after the directory's own token, so a sibling that sorts first (`03-HUMAN-UAT.md`, `03-CORRECTION-VERIFICATION.md`) won, and a passed phase could read as missing with route `execute-phase`. The resolver now also tries the code-stripped, zero-padded name the scaffolder writes, after a file that literally carries the directory's token. (#5931)
