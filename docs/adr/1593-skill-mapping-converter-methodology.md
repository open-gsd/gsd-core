# Skill mapping & converter methodology across runtimes

- **Status:** Accepted
- **Date:** 2026-06-22
- **Issue:** [#1593](https://github.com/open-gsd/gsd-core/issues/1593)
- **Epic:** [#1258](https://github.com/open-gsd/gsd-core/issues/1258) (Phase A — *"do first"*)
- **Extends:** [ADR-3660](3660-runtime-artifact-layout-module.md) (layout), [ADR-1016](1016-runtime-capability-descriptor.md) (enum — accepted here)
- **Sibling:** [ADR-1508](1508-runtime-artifact-conversion-module.md) (module ownership), [ADR-766](766-claude-code-plugin-manifest-module.md) (Claude plugin manifest)

## Context

GSD installs skills into 16 host CLIs (claude, codex, gemini, opencode, kilo, cursor, copilot, antigravity, windsurf, augment, trae, qwen, hermes, codebuddy, cline, kimi). The methodology governing *how* a source command file in `commands/gsd/*.md` becomes an installed skill on each runtime is real, load-bearing, and documented in fragments across three sources that disagree on what they own:

1. **[ADR-3660](3660-runtime-artifact-layout-module.md)** (Accepted) — owns the *structural* layout: the `{ kind, destSubpath, prefix, nesting, recursive, converter }` `ArtifactKindDescriptor` shape, per-runtime dest path, the `gsd-` prefix, flat-vs-nested under `gsd-ns-*` routers, and the `stage` closure contract binding each layout to its converter. ADR-3660 says where artifacts go; it does not describe what the converters *do*.
2. **[ADR-1016](1016-runtime-capability-descriptor.md)** (header Status: Proposed — **corrected to Accepted by this ADR**, see Decision 2) — owns the closed `ConverterName` enum and declares `artifactLayout` as descriptor data. Vocabulary only: it closes the set of named converters; it does not describe each converter's transform contract.
3. **`src/runtime-artifact-conversion.cts`** (~2,600 lines, the converter functions) — the actual per-runtime transform semantics: frontmatter filtering, tool-name rewrites, path rewrites, namespacing, description truncation, SKILL.md-vs-flat body format. **No ADR.** A future maintainer (human or agent) has no single place that says "this converter rewrites X, drops Y, truncates at Z."

A just-merged sibling — **[ADR-1508](1508-runtime-artifact-conversion-module.md)** (PR #1509, 2026-06-21) — owns *module ownership + dependency direction* for the conversion engine. Its body explicitly defers the methodology to this ADR: *"Distinct from epic #1258: #1258 Phase A documents the converter transform-contract catalog; this ADR decides module ownership + dependency direction."* The module now has a home; the *methodology it implements* did not.

Two concrete failures fall out of this documentation gap (surfaced while triaging #1243):

1. **Consumption:** `agent_skills`'s `global:` resolver hand-resolved a file path and could not reach plugin-provided skills. The resolution (PR #1261, Claude consume side) had to reverse-engineer the converter + layout + the platform's native skill-resolution mechanism separately because no ADR described how they relate.
2. **Provision:** GSD ships as a first-party plugin/extension on multiple platforms (`.claude-plugin/plugin.json` per ADR-766, `gemini-extension.json` per #775), but those manifests do not provide GSD's skills the platform-native way — the Claude manifest declares `commands` + `hooks`, no `skills`. No ADR states the provision methodology each platform demands.

## Decision

### 1. This ADR is the single authoritative description of the per-runtime skill mapping and converter transform contracts

It codifies — in one place — what ADR-3660 (layout), ADR-1016 (vocabulary), and `runtime-artifact-conversion.cts` (semantics) each carry a third of. The companion reference page, [`docs/reference/skill-mapping-matrix.md`](../reference/skill-mapping-matrix.md), holds the maintainable per-runtime table; this ADR holds the *decisions* behind it. **References, does not duplicate, ADR-3660** (the layout owner) — extends it with the converter + mapping methodology.

### 2. ADR-1016's `ConverterName` enum is Accepted (header correction)

ADR-1016's header says `Proposed`, but its `ConverterName` closed enum is **already code-enforced**: `gsd-core/bin/lib/capability-validator.cjs` rejects unknown converter names (*"is not a known ConverterName"*), and the enum is locked by a fail-first regression test at `tests/capability-registry.test.cjs:3956` (ADR-857 phase 5e). The decision is realized; the record is stale. This ADR accepts the enum and the ADR-1016 header is corrected `Proposed` → `Accepted` as a metadata correction (no behavior change).

The closed enum `VALID_CONVERTER_NAMES` (`capability-validator.cjs:651-678`) holds **24 names** in two blocks:

- **15 commands/skills converters** — the block ADR-1016's *"15 named first-party functions covering the 16 runtimes"* refers to. Of these, 13 are skill converters and 2 are command converters (`convertClaudeCommandToCodebuddyCommand`, `convertClaudeCommandToCursorCommand`). Three runtimes share `convertClaudeCommandToClaudeSkill` (claude, qwen, hermes), so the 15 skill-bearing runtimes (all except commands-only Gemini) resolve to 13 distinct skill converters.
- **9 agent converters** (`convertClaudeAgentTo{Copilot,Antigravity,Cursor,Windsurf,Augment,Trae,Codebuddy,Cline,Codex}Agent`) — added by #1173 for the descriptor-driven agent-conversion wiring (ADR-1235). These are not yet declared by any runtime's `agents` kind descriptor (the `convertedAgentsKind` builder exists but the declarations are deferred to a #1173 follow-up; the legacy `bin/install.js` agent loop remains authoritative).

### 3. The converter transform-contract categories

Every skill converter in `runtime-artifact-conversion.cts` composes some subset of eight transform categories. This is the catalog ADR-1508 deferred:

| # | Category | What it does | Representative functions |
|---|----------|--------------|--------------------------|
| 1 | **Frontmatter extraction & reconstruction** | Extract `(name, description, allowed-tools, argument-hint, agent, context, effort)` from the source command frontmatter; reconstruct in the runtime's skill frontmatter shape. | `extractFrontmatterAndBody`, `skillFrontmatterName`, every `convertClaudeCommandTo*Skill` |
| 2 | **Description truncation** | Runtimes with description-length limits truncate to the cap (e.g. Codex: 180 chars → `metadata.short-description`). | `convertClaudeCommandToCodexSkill` (`toSingleLine` + 177-char slice) |
| 3 | **Tool-name rewrites** | Map Claude tool names to runtime equivalents. | `convertToolName`, `convertKimiToolName`, `convertCopilotToolName`, `convertGeminiToolName`; inline: `AskUserQuestion`→`question`, `SlashCommand`→`skill` (opencode) |
| 4 | **Path rewrites** | `~/.claude` → the runtime's config path; `computePathPrefix` derives the install-target prefix; `transformContentToHyphen` normalizes `/gsd:<cmd>` → `gsd-<cmd>`. | `computePathPrefix`, `applyOpencodeFamilyPathPrefix`, `convertClaudeToOpencodeFrontmatter` |
| 5 | **Slash-command → skill-mention conversion** | For runtimes that surface skills (not slash commands), rewrite `/gsd:<cmd>` invocations into skill-tool mentions. | `convertSlashCommandsTo{Cursor,Windsurf,Augment,Trae,Codebuddy}SkillMentions` |
| 6 | **Runtime-specific branding / fields** | Emit runtime-required frontmatter the source does not carry. | Hermes: `version:`; Qwen: numeric `priority:` (`QWEN_SKILL_PRIORITY`); Codex: `metadata.short-description`; Kimi: name normalization |
| 7 | **Agent-reference neutralization** | For non-Claude runtimes, replace "Claude" → "the agent" and `CLAUDE.md` → the runtime's instruction file. | `neutralizeAgentReferences` |
| 8 | **Body format (SKILL.md-vs-flat)** | Governed by the layout `nesting` flag + the `stage` closure: nested runtimes ship `<router>/skills/<name>/SKILL.md`; flat runtimes ship `<prefix><stem>/SKILL.md` at one level. | `stageSkillsForRuntimeAsSkills` (in `install-profiles.cts`), `buildNamespaceBundleMap` |

A converter's contract is the fixed subset of these eight categories it applies, in order. **Transform order is load-bearing for byte-parity** (cf. ADR-1235 §0): stale-cleanup → path-prefix rewrite → `processAttribution` → runtime converter/branding → body normalization → filename rename. A converter that silently inherits another's ordering breaks byte-for-byte parity without a test signal.

### 4. The per-runtime skill mapping

The full 16-runtime matrix — dest path, prefix, nesting, loader recursion, converter, and per-runtime notes — lives in the companion reference page: [`docs/reference/skill-mapping-matrix.md`](../reference/skill-mapping-matrix.md). The authoritative source for any cell is the runtime's `capabilities/<runtime>/capability.json` `artifactLayout` descriptor (resolved by `resolveRuntimeArtifactLayout` in `runtime-artifact-layout.cts`); the reference page is the human-readable projection, kept in sync going forward.

Three structural facts the matrix encodes:

- **All 15 skill-bearing runtimes use `prefix: "gsd-"`.** (Gemini is commands-only — no skills kind.)
- **Six runtimes nest** under `gsd-ns-*` routers (cline, qwen, hermes, augment, trae, antigravity) because their skill loaders scan one level deep; the rest stay flat because their loaders recurse (cursor, opencode, kilo) or because nesting was reverted (claude — Skill-tool errors on unknown names, #924).
- **Three runtimes share `convertClaudeCommandToClaudeSkill`** (claude, qwen, hermes); the other 12 skill-bearing runtimes each have a dedicated converter.

### 5. Plugin / external-skill provision + consumption methodology

GSD's first-party plugin/extension on every supported platform should both **provide** its own skills and **consume** external/plugin-provided skills through each platform's *documented, native* mechanism — **never** by reaching into an undocumented or ephemeral cache.

**Provision** — ship GSD's skills the platform-native way:
- **Claude Code:** the `.claude-plugin/plugin.json` manifest should declare a `skills` field / `skills/` dir (today it declares only `commands` + `hooks`, per ADR-766). This is Phase B-provide / Phase D.
- **Other platforms:** assessed per-platform in Phase C; where a platform has no documented skill-provision model, record N/A with rationale.

**Consumption** — resolve plugin/external skills through the platform's native skill-resolution mechanism:
- **Claude Code:** the sub-agent `skills:` frontmatter preload (full content injected) and the runtime `Skill` tool (loads a namespaced skill by name). PR #1261 (Phase B consume side, merged 2026-06-15) is the reference implementation: `agent_skills` accepts the namespaced form `global:<plugin>:<skill>` and emits a by-name Skill-tool directive — no cache path is ever read.
- **Other platforms:** assessed per-platform in Phase C.

**Rejected:** reading another plugin's ephemeral cache (e.g. Claude Code's `${CLAUDE_PLUGIN_ROOT}` / `~/.claude/plugins/cache`, which *"changes when the plugin updates"*), or copying skill files to undocumented locations. These are workarounds, not fixes — the platform's native mechanism is the contract.

## Consequences

- **+** One authoritative description of the per-runtime skill mapping + converter transform contracts. A future maintainer or agent reads this ADR + the reference matrix instead of reverse-engineering three sources.
- **+** Unblocks Phases B-provide, C (C1–C6), and D of epic #1258 — each per-platform implementation cites this ADR as its methodology contract.
- **+** ADR-1016's header reflects reality (Accepted, not Proposed) — the ADR README index is corrected.
- **+** Closes the documentation leak adjacent to ADR-1508: the module has a home (ADR-1508), the methodology it implements has a record (this ADR).
- **−** The reference matrix must stay in sync with the capability descriptors. The descriptors (`capabilities/<runtime>/capability.json` `artifactLayout`) remain the source of truth; the reference page is a projection. A future runtime addition must update both the descriptor and the matrix row (the descriptor's `TypeError` on unknown runtime is the structural guard; the matrix drift is a documentation gap, not a runtime failure).
- **−** The eight transform-contract categories are descriptive, not type-enforced. A converter that grows a ninth category does not trip a gate — the closed `ConverterName` enum (ADR-1016) gates the *set* of converters, not the *shape* of each converter's transform.

## Relationship to other ADRs and issues

- **[ADR-3660](3660-runtime-artifact-layout-module.md)** (layout owner, Accepted) — extended, not duplicated. This ADR documents the converter contracts that ADR-3660's `stage` closure binds but does not describe.
- **[ADR-1016](1016-runtime-capability-descriptor.md)** (enum owner, header corrected to Accepted here) — the closed `ConverterName` enum is the type-enforcement substrate; this ADR documents what each named converter *does*.
- **[ADR-1508](1508-runtime-artifact-conversion-module.md)** (module owner, Accepted) — sibling. ADR-1508 decides *module ownership + dependency direction*; this ADR decides *methodology + transform contracts*. ADR-1508's Phase 1–2 implementation (epic #1507, relocating helpers inside `runtime-artifact-conversion.cts`) touches the same file this ADR documents — they are sequenced, not conflicting.
- **[ADR-766](766-claude-code-plugin-manifest-module.md)** (Claude plugin manifest, Accepted) — referenced for the provision methodology (the `skills` manifest field Phase B-provide / Phase D adds).
- **[ADR-1235](1235-descriptor-driven-agent-conversion-migration.md)** (descriptor-driven agent conversion) — complementary; its byte-parity transform-ordering rule is cited in Decision 3.
- **Epic [#1258](https://github.com/open-gsd/gsd-core/issues/1258)** — this is Phase A. Phase B-consume (PR #1261, merged) is the reference implementation canonized in Decision 5. Phases B-provide, C (C1–C6), D are tracked as separate issues per the epic's governance.
