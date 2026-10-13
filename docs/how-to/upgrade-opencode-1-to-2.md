# How to move GSD from OpenCode 1.x to OpenCode 2.x

**Goal:** Upgrade the `opencode` binary from 1.x to 2.x and bring your GSD install with it, before the OpenCode 1.x bug-fix-only window ends on **2026-12-31**.

**Prerequisites:** GSD Core installed for OpenCode (`--opencode`), and an `opencode` 1.x on your `PATH`. Kilo is a separate runtime on the 1.x line and is not affected by anything on this page.

---

## Why now

GSD supports OpenCode 1.x and 2.x side by side while both are current. From the release that ships this page, an OpenCode 1.x install prints a deprecation notice, 1.x receives bug fixes only, and **2026-12-31** is the end of that window. After it, a later release removes the OpenCode 1.x code paths for the `opencode` runtime ([ADR-5331](../adr/5331-opencode-v2-support-and-v1-sunset.md), Phase 4). The notice reads:

```
⚠ OpenCode 1.x is deprecated for GSD: it receives bug fixes only until 2026-12-31, after which GSD supports
  OpenCode 2.x only. Upgrade with `opencode upgrade --major` (OpenCode 1.19 and newer), or install OpenCode 2 …
```

## Steps

1. **Back up your OpenCode data directory** (optional but cheap). `opencode debug paths` prints it. OpenCode 2.x adds its own session tables beside the 1.x ones, and 1.x keeps working there; a data directory that 2.x creates from scratch cannot be opened by 1.x. GSD never writes this database.
2. **Upgrade the binary.**
   - OpenCode 1.19 and newer: `opencode upgrade --major` ("upgrade to OpenCode 2 and remove OpenCode 1").
   - Older 1.x (for example 1.18.29, which has no `--major`), or a package-managed 1.x: remove the 1.x package, then install OpenCode 2 with `curl -fsSL https://opencode.ai/v2/install | bash` or `npm install -g @opencode/cli`. The 2.x installer replaces the 1.x binary; the two cannot be installed side by side ([Migrate from V1](https://opencode.ai/v2/docs/migrate-v1/)).
3. **Re-run the GSD installer** (or `/gsd-update`):

   ```bash
   npx @opengsd/gsd-core@latest --opencode --global
   ```

   OpenCode 2.x rejects the plugin an older GSD installed, so this step is required. It installs the plugin that serves both generations, converges the `gsd` MCP entry (migration 011, keeping the comments in `opencode.jsonc`), and prints which generation it found.
4. **Check the result.** `opencode --version` reports 2.x; the installer line says `OpenCode 2.x detected`; start `opencode` in a GSD project and the footer shows the GSD statusline (see below).

## What changes for you on 2.x

| Area | OpenCode 1.x | OpenCode 2.x |
|---|---|---|
| Guards (secret read, injection, workflow, worktree, write) | enforced | enforced, same scripts |
| Guard advisories (read-before-write, injection findings, phase boundary) | now appended to the tool result the model reads | same |
| Opt-in community hooks (`hooks.community`): commit validation, phase boundary, session state, graphify auto-update | run through the plugin | run through the same plugin |
| Statusline and update banner | not available | footer of the terminal client, from `plugins/gsd-statusline/` |
| Slash commands | `opencode run --command` | in the terminal client, or the session command API; `opencode run` has no `--command` |
| Worktree dispatch | `--dir` | the spawned process's working directory (`$PWD`) |
| Reasoning effort | `--variant` | `provider/model#variant` |
| `TodoWrite` | `todowrite` tool | no equivalent tool; GSD workflows do not depend on it |
| Background subagents | not available | `subagent` with `background: true` |

## Going back

Reinstall OpenCode 1.x, then re-run the GSD installer. If 2.x created the data directory from scratch, 1.x cannot open it; restore the backup from step 1 or let 1.x create a new one. The installer warns when it sees that combination.

## Related

- [OpenCode 1.x and 2.x](../USER-GUIDE.md#opencode-1x-and-2x-5337) — how GSD tells the generations apart
- [Feature verification matrix](../reference/opencode-v2-verification-matrix.md) — what was run on real 1.x and 2.x binaries
- [Update GSD](update-gsd.md)
