---
type: Added
pr: 839
---
Added `/gsd-update --next` (alias `--rc`) to install or refresh from the `@next` RC dist-tag (ADR #660). A new `parse_update_channel` workflow step resolves the channel from `$ARGUMENTS`; the version check and all three npx install invocations thread `$TAG` instead of hardcoding `@latest`. When `--next` is used the version-comparison output gains a `Channel: next (RC)` banner so the user knows they are leaving the stable line; omitting the flag keeps `@latest` behavior byte-for-byte unchanged. `check-latest-version.cjs` gains `ALLOWED_TAGS`, `buildViewArgs`, and `resolveTag` exports, with an allowlist guard (enforced at both the CLI and function boundary) that rejects any dist-tag other than `latest`/`next`. (#815)
