# Claude Code Plugin Manifest Module owns the projection of gsd-core surfaces onto the Claude Code plugin contract

- **Status:** Accepted
- **Date:** 2026-06-07
- **Issue:** #766
- **Implementation:** PR #797

## Context

gsd-core has, until now, reached Claude Code through exactly one Adapter: the file-copy installer. The **Runtime Artifact Layout Module** (ADR-3660) projects gsd-core's artifact surfaces (`commands`, `agents`, `skills`) onto per-runtime filesystem placements, and the **Runtime Install Policy Module** (ADR-58) composes those placements with command text and config intentions into a typed install plan that adapters write to `~/.claude/` / `.claude/`.

Claude Code now exposes a second, first-class way to receive the same surfaces: the **plugin contract** — a `.claude-plugin/plugin.json` manifest plus a `hooks/hooks.json`, consumed either by a marketplace install or by the zero-friction `@skills-dir` path. This contract is an *external interface owned by Claude Code*, not by gsd-core: it has its own schema, its own namespacing rules (`/<plugin-name>:<command>`), its own validation tool (`claude plugin validate`), and its own constraints (notably: plugin-shipped agents may not carry `hooks` / `permissionMode` / `mcpServers` frontmatter — Claude Code silently ignores them).

Before this ADR, the only record of how gsd-core maps onto that external contract was the manifest files themselves. A hand-authored config file with no named Seam invites drift: the manifest's hook wiring silently diverges from what the Installer Module wires into `settings.json`; the identity fields drift from the Package Identity Module; and a future maintainer has no single place that says *which gsd-core surface maps to which manifest field, and why*. The plugin contract is exactly the kind of external interface that earns a defined, typed mapping rather than an ad-hoc file — the same reasoning that gave the file-copy path the Runtime Artifact Layout Module.

This is the structural signal the architecture review looks for: **two Adapters at one Seam.** The file-copy layout and the plugin manifest are two projections of *the same* gsd-core artifact surfaces onto two different distribution contracts. That makes the distribution Seam real, and the plugin-side projection deserves a name.

## Decision

Introduce the **Claude Code Plugin Manifest Module** as the Seam that owns the projection of gsd-core's artifact surfaces onto the Claude Code plugin contract. It is the plugin-contract sibling of the Runtime Artifact Layout Module: where that Module projects surfaces onto filesystem placements, this Module projects the same surfaces onto `.claude-plugin/plugin.json` + `hooks/hooks.json`.

The mapping is **defined, not incidental**:

| gsd-core surface / source | Claude Code plugin field | Rule / invariant |
|---|---|---|
| Package Identity Module `binName` | `name` | `gsd-core` — drives the `/gsd-core:` command namespace; must be kebab-case (no colon/space/uppercase). |
| Package Identity Module `repoUrl` | `repository`, `homepage` | derived, never re-typed. |
| `package.json` `version` / `description` / `license` | `version` / `description` / `license` | `version` is **required** for `claude plugin validate --strict` (a missing version is a strict failure), so it is synced to `package.json` and held by a drift-guard test. |
| Command surface (`commands/gsd/*.md`) | _(not declared — superseded by the skills surface, see Amendment 2026-10-14)_ | was exposed as `/gsd-core:<command>`; namespacing replaces the file-copy path's `/gsd:<command>` (an additive UX change, not a data-format break). |
| Agent surface (`agents/*.md`) | *(omitted — default `agents/` discovery)* | the explicit `agents: <string>` form is rejected by the plugin schema; relying on Claude Code's default `agents/` discovery loads them and stays self-maintaining. Agents are already plugin-safe — their `hooks`/`permissionMode` frontmatter is inert. |
| Always-on hook policy (subset of the Installer Module's `settings.json` wiring) | `hooks: "./hooks/hooks.json"` | see below. |

The hook projection is the load-bearing part of this Module, because of the external constraint: a plugin's agents cannot carry hook frontmatter, so **all plugin-path hook wiring must live in `hooks/hooks.json`**. The Module projects *only the always-on subset* of the Installer Module's Claude hook wiring — `gsd-check-update` (SessionStart), `gsd-context-monitor` (PostToolUse), and the security guards `gsd-prompt-guard` / `gsd-read-guard` / `gsd-worktree-path-guard` / `gsd-read-injection-scanner` / `gsd-write-guard` (PreToolUse, #2255) / `gsd-secret-read-guard` (PreToolUse `Read|Grep|Bash`, #4221) — preserving each event, matcher, and timeout (the blocking guards register at the installer's 120 s host budget, because a timed-out hook does not block, #3981 / #5180). The installer's **config-gated opt-in** hooks (workflow-guard, validate-commit, graphify-update, session-state, phase-boundary, update-banner) are deliberately excluded: a static manifest cannot read a project's `.planning/config.json` to honor those gates, so projecting them would run them unconditionally — a behavior change the Module must not introduce. Hook commands reference bundled scripts through Claude Code's `${CLAUDE_PLUGIN_ROOT}` variable.

The interface of this Module is therefore a **conformance contract**, validated two ways: `claude plugin validate --strict` (the external tool's view) and an in-repo drift-guard test (`tests/plugin-manifest.test.cjs`) that locks the identity mapping, the version sync, the always-on hook contract, and the absence of opt-in hooks. Manifest component paths are resolved relative to the **plugin root** (the directory containing `.claude-plugin/`), which is the repository root.

This is **additive**. The file-copy path — Runtime Artifact Layout Module, Runtime Install Policy Module, Installer Module — is unchanged. The plugin manifest is a parallel Adapter, the fallback for users on older Claude Code versions that predate the plugin contract.

## What stays OUTSIDE this Module

To keep the Seam honest about where the plugin contract ends:

- **Runtime execution.** The Module projects the command/agent/hook *surface* and lifecycle metadata. It does not make gsd commands self-contained: their backing logic still resolves the gsd runtime CLI (`gsd-tools`) and `node` on `PATH`. The plugin delivers discoverability and lifecycle (`claude plugin enable|disable|update`); it does not replace the runtime.
- **The file-copy install.** Filesystem placement, `settings.json` merge semantics, and per-runtime config rendering remain owned by the Runtime Artifact Layout / Install Policy / Installer Modules.
- **Marketplace listing.** Publishing gsd-core to a marketplace registry is an external, out-of-repo act.
- **Manifest emission by the installer.** Having `bin/install.js` drop the manifest in-place for the npm `@skills-dir` path is a follow-up; the repo-root manifest already serves the marketplace and git-clone `@skills-dir` paths.

## Consequences

- gsd-core gains a one-command install/update/disable lifecycle and automatic `/gsd-core:` namespacing that prevents slash-command collisions, without disturbing the file-copy path.
- The plugin contract gains a named place in the glossary (`CONTEXT.md`) and a defined mapping, so future surface additions have an obvious projection target instead of an ad-hoc file edit.
- **Latent duplication is now named, not hidden.** The always-on hook policy is currently encoded twice — imperatively in the Installer Module's `settings.json` wiring, and declaratively in `hooks/hooks.json` — kept in agreement only by the drift-guard test. This ADR records that as the known cost of a *static* manifest. Elevating the Module from a hand-authored manifest to a **generated projection** (stamping `plugin.json` from the Package Identity Module + `package.json`, and `hooks/hooks.json` from `managed-hooks-registry.cjs` + a shared always-on-hook policy) would collapse the duplication to one source — the same generated-single-source move ADR-457 made for `.cjs` and the Runtime Install Policy Module made for install plans. Deferred; see Open questions.
- The `name` field is a stability surface: it is the published `/gsd-core:` namespace. Changing it is a user-visible break under Hyrum's law, the same way command names are.
- Rollout is incremental: this ADR + the hand-authored manifest land first (#766/PR#797); installer-emit, release-time version stamping, and the generated projection are tracked follow-ups under #766.

## Open questions

- Should this Module be **generated** rather than hand-authored, deriving `version` (and identity) at build/release time so a `package.json` bump cannot leave `plugin.json` stale? The release pipeline bumps via `npm version --no-git-tag-version` with no regeneration hook, so today the drift-guard test enforces the sync manually (idiomatic with the repo's other drift guards, but a release speed-bump).
- Should the always-on-hook policy be lifted into a single shared source consumed by *both* the Installer Module and this Module, retiring the dual hand-encoding?

## References

- ADR-3660 — Runtime Artifact Layout Module (the file-copy sibling: projects the same surfaces onto filesystem placements).
- ADR-58 — Runtime Install Policy Module (typed install-plan projection for the file-copy path).
- ADR-457 — Generated single-source (the precedent a generated manifest projection would follow).
- ADR-0008 — Installer Migration Module (adjacent installer Seam).
- Package Identity Module (`gsd-core/bin/lib/package-identity.cjs`) — source of the manifest's identity fields.
- Installer Module (`bin/install.js`) — owns the `settings.json` always-on hook wiring this Module mirrors for the plugin path.
- `CONTEXT.md` § Glossary — Domain modules and seams (where this Module is registered).
- Claude Code plugin contract: <https://code.claude.com/docs/en/plugins-reference>.

## Amendment 2026-06-22 — Skills surface projection (#1596)

The original mapping table projected commands + hooks but omitted skills. Phase B-provide of epic #1258 adds the skills surface:

| gsd-core surface / source | Claude Code plugin field | Rule / invariant |
|---|---|---|
| Skill surface (`commands/gsd/*.md` → build-converted) | `skills: "./skills/"` | A `skills/` dir of build-generated `gsd-<stem>/SKILL.md` files, produced by `scripts/gen-plugin-skills.cjs` running `convertClaudeCommandToClaudeSkill` (the same converter the file-copy installer uses). Generated at build time (`npm run build`) and committed (consistent with ADR-457's generated-committed-output pattern). This closes the gap where plugin-only installs lacked the skill surface because `bin/install.js` never ran. Methodology defined by ADR-1593 §5. |

The `skills/` dir is **generated, not hand-authored** — `scripts/gen-plugin-skills.cjs --check` verifies staleness. The conformance test (`tests/plugin-manifest.test.cjs` Section H) asserts the manifest field, dir presence, frontmatter validity, and count parity with `commands/gsd/*.md` (`DEFECT.GENERATIVE-FIX`).

## Amendment 2026-10-14 — One workflow surface (#4860)

The 2026-06-22 amendment added `skills: "./skills/"` beside the existing `commands: "./commands/gsd/"`. Both hold the same workflows, and Claude Code registers each component directory separately, so `claude plugin details gsd-core` listed 144 skills (each workflow once as `<stem>`, once as `gsd-<stem>`), measured on Claude Code 2.1.296: ~10,702 always-on tokens versus ~8,159 with one surface (the duplicated set is about a quarter of the inventory, not half — the agents account for most of the rest).

**Decision: the `skills/` surface is the single workflow surface; `plugin.json` no longer declares `commands`.**

- Claude Code's plugins reference calls `commands/` the older format ("Prefer `skills/` for new plugins"), and its skills page says commands and skills both create a slash command and that a skill wins a same-name collision. Plugin skills are namespaced `/plugin-name:skill-name`, so workflows are invoked as `/gsd-core:gsd-<stem>`.
- GSD's own workflows invoke each other as `Skill(skill="gsd-<stem>")`. Only the skills surface carries those names; dropping skills instead would break that chaining, and it would not even remove the duplicates: the default `skills/` directory is scanned whether or not the manifest names it (measured: 144 either way).
- It matches the rest of the system: the global npm install already uses skills for workflows, and the capability validator's `DEFAULT_TRIGGER_PRECEDENCE` is `['skills', 'commands']`.
- `commands/gsd/` stays in the repository: it is the source `scripts/gen-plugin-skills.cjs` generates `skills/` from and what the local file-copy installer ships. Claude Code's default scan reads only flat files in `commands/`, so the nested directory is not registered (measured: 72 skills, `claude plugin validate --strict` passes). *(That premise was wrong — see Amendment 2026-10-22.)*

Consequences: a plugin user's slash command becomes `/gsd-core:gsd-<stem>` (was `/gsd-core:<stem>`) — a visible rename, called out in the install guide and the changeset. `tests/plugin-manifest.test.cjs` now asserts `commands` is absent and, when the `claude` CLI is available, that the real loader registers each workflow once. *(Superseded: it now asserts `commands` is `[]` and reads the loader's `system init` entries — see Amendment 2026-10-22.)* The `tests/fixtures/plugin-manifest-schema.json` snapshot no longer lists `commands` as required (the strict validator does not require it).

## Amendment 2026-10-22 — The default `commands/` scan is not flat-only (#5504)

The 2026-10-14 amendment removed `commands` from `plugin.json` on the premise that "Claude Code's default scan reads only flat files in `commands/`, so the nested directory is not registered". That premise does not hold. Measured on Claude Code 2.1.302 and 2.1.305 with the real loader: with no `commands` key the loader's `system init` event lists 144 `gsd-core:` entries, each workflow once as `gsd-core:gsd-<stem>` (the `skills/` surface) and once as `gsd-core:gsd:<stem>` (the default scan descending into `commands/gsd/`); with `"commands": []` it lists 72. The earlier measurement used `claude plugin details`, which reports `Skills (72)` either way and does not count command entries, and `claude plugin validate --strict` passes both shapes.

**Decision: `plugin.json` declares `"commands": []`.** A `commands` key replaces the default `commands/` scan (Claude Code's plugins reference, "How each key combines with its default location"), so the empty array disables it without touching the files: `commands/gsd/` stays, because `scripts/gen-plugin-skills.cjs`, the file-copy installer and every other runtime's installer read it. The `skills/` surface is unchanged, so `Skill(skill="gsd-<stem>")` chaining and `/gsd-core:gsd-<stem>` invocation keep working.

`tests/plugin-manifest.test.cjs` now asserts `commands` is exactly `[]` (neither absent nor the old path string) and, when the `claude` CLI is available, reads the loader's own `system init` slash-command list (emitted before any model call, so it needs no login) and asserts one `gsd-core:gsd-<stem>` entry per workflow and none in the `gsd-core:gsd:<stem>` form. `tests/fixtures/plugin-manifest-schema.json` admits the array form for `commands`.
