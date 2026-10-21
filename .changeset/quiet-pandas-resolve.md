---
type: Fixed
pr: 5585
---
**The build and test gates now use the project's package manager** — with no `workflow.build_command` / `workflow.test_command` set, the post-merge gate, regression gate and audit-fix sniffed `package.json` and ran `npm run build` / `npm test` even in a pnpm, yarn or bun project. A new `resolve-package-manager` query reads the `packageManager` field, then the lockfile, and all four sites use it; npm projects are unchanged. The post-merge gate also logs which build script it is running and recommends `workflow.build_command`. It looks in the directory the gate runs from, so a workspace-root lockfile is not consulted from a sub-package. (#5346)
