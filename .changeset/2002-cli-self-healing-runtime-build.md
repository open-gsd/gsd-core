---
type: Changed
pr: 2036
---

**The GSD CLI now self-heals a missing runtime build.** The compiled `gsd-core/bin/lib/*.cjs` modules are gitignored build artifacts (ADR-457) that ship prebuilt in the npm tarball but are absent on a Claude Code plugin-marketplace / git-clone install, which never runs `npm run build:lib`. Previously every command died at load with `Cannot find module './lib/cli-exit.cjs'`. The `gsd-tools` entrypoint now detects the missing output and compiles it once, on demand (lock-guarded so parallel invocations don't race), then proceeds — a single no-op check on the already-built npm path. When TypeScript is genuinely unavailable it prints an actionable `npm install && npm run build:lib` message instead of crashing.
