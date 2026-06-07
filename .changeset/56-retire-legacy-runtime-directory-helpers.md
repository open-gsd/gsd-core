---
type: Changed
pr: 802
---
Retire the installer's one-off runtime directory helpers (`getGlobalDir`/`getOpencodeGlobalDir`/`getKiloGlobalDir`) and consolidate per-runtime global config-dir resolution onto the single canonical projection `runtime-homes:getGlobalConfigDir`, extended with the `--config-dir` override and the opencode/kilo `*_CONFIG` file-path precedence. Behavior-preserving across all 15 install runtimes. (#56)

<!-- docs-exempt: internal behavior-preserving consolidation of duplicated directory-resolution helpers; no user-facing behavior change -->
