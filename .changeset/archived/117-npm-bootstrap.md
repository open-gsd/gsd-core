---
type: Added
pr: 117
---
**Environment bootstrap validator (`npm run check:env`)** — adds `scripts/check-env.sh` which validates Node version, npm version, lockfile presence, lockfile sync, and version-manager pin before test or audit runs. Catches environment mismatches early with structured `--json` output. Companion docs in `docs/contributing/bootstrap.md` cover prerequisites, one-time setup, daily commands, and troubleshooting. CI now runs the environment check after `setup-node` and before `npm ci` on every matrix lane. (#117)
