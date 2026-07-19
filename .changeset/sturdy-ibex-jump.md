---
type: Fixed
pr: 2437
---
**`npm run lint:ci` (and every npm script banner) on `next` and feature branches cut from `next` no longer reports a stale pre-release version after a final release** — the release pipeline's `finalize` job shipped `X.Y.0` to npm `latest` but never bumped `next` to match, so `next` carried the last `rc.N` placeholder indefinitely (observed: `1.7.0-rc.6` lingering after `1.7.0` shipped). The `finalize` job now runs `scripts/sync-next-version.cjs` — the same step the `rc` job already ran — keeping `next` at the last published release for every release type as `scripts/sync-next-version.cjs:6-9` always promised. (#2423)
