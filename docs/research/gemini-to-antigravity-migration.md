# The Gemini → Antigravity migration: authoritative picture

Researched against primary sources only (source, capability manifests, ADRs, tests, git
history, CHANGELOG) on branch `next` at commit `c0b2a05d2f`. Every claim below is cited
`file:line` or a commit SHA.

## 1. Timeline / provenance

- **2026-06-18** — Google sunsets Gemini CLI for free/Pro/Ultra tiers. Cited throughout the
  codebase, e.g. `GEMINI.md:1`, `bin/install.js:1075`.
- **Removal commit: `8f2ebbe9bf`** — `feat(#1928): remove sunset Gemini CLI runtime, redirect
  to Antigravity (#1996)`, authored 2026-07-04. Commit message (verbatim): *"Remove the gemini
  runtime from the enum (16->15), aliases, labels, config-home fragment, install path,
  converters (convertClaudeToGemini{Markdown,Toml,Agent}, convertSlashCommandsToGeminiMentions),
  capability descriptor, gemini-extension.json, RULESET.GEMINI.*, and the interactive menu…
  Antigravity is preserved throughout: its GEMINI.md contextFileName, .gemini/antigravity
  config home, the shared convertGeminiToolName/claudeToGeminiTools tool vocabulary, and the
  'gemini' hookEvents dialect it declares."* This is the single authoritative statement of
  intent for the whole migration — the taxonomy in §2 is a direct expansion of it.
  - Deleted in this commit (via `git log --diff-filter=D --name-only`): `capabilities/gemini/capability.json`, `gemini-extension.json`, `tests/gemini-namespacing.test.cjs`, `tests/issue-775-gemini-extension.test.cjs`, `tests/bug-2557-gemini-local-hook-paths.test.cjs`, `tests/bug-3037-gemini-duplicate-commands.test.cjs`, `tests/enh-776-install-gemini-hook-events.test.cjs`, `tests/fixtures/golden-install-parity/gemini.json`.
  - Follow-up in the same PR: dropped Gemini CLI from `.github/ISSUE_TEMPLATE/bug_report.yml` and `feature_request.yml` (review nit from @davesienkowski).
  - Changeset: `.changeset/vivid-foxes-click.md` → rendered at `CHANGELOG.md:1012` / `CHANGELOG.md:1281` (duplicated, both a "recent" and an older archival copy of the same line): *"Removed the sunset Gemini CLI runtime — use Antigravity CLI instead… (#1928) (#1996)"*.
  - `GEMINI.md` itself was **repointed, not deleted**, in the same commit (`git log --oneline -- GEMINI.md` shows `8f2ebbe9bf` as the second-most-recent touch after the original `a3aa0ae142` "ship a gemini-extension.json extension package" (#775/#818)).
- **`capabilities/gemini/capability.json` was re-created later**, as a reviewer-lane-only
  manifest, by the reviewer-lane-declaration work: `6a9babda69` `chore(#2798): declare the
  eleven reviewer lanes as manifest data (#2837)`, per ADR-2782 (`docs/adr/2782-reviewer-lane-capability-surface.md`). Confirmed live today: `capabilities/gemini/capability.json:1-6` — `"role": "reviewer"`, description *"cross-AI `/gsd-review` reviewer lane only; not a GSD install target (no runtime body, no artifacts)"*. This is intentional, not a regression of #1928 — CHANGELOG.md:810 documents the same PR: *"Five reviewers GSD never installs into (Gemini, CodeRabbit, Ollama, LM Studio, llama.cpp) become lane-only capabilities with no install surface."*
- **Antigravity's own evolution as a runtime** (separate from the Gemini removal, but
  entangled with it because it shares the `.gemini` dialect):
  - `fbd62cd84f` `feat(#1035): phase 5a — author 16 role:runtime capability descriptors (registry-only) (#1039)` — Antigravity first declared as a capability descriptor.
  - `5695522d5f` `feat(#2096): migrate Antigravity onto EoS declarative adapter + permission-writer + MCP companion (ADR-1239)` — CHANGELOG.md:973 / :1240.
  - `3738`/`4274` (per CHANGELOG.md:224/343) — Antigravity's global skills/agents home corrected from `~/.gemini/antigravity` to `~/.gemini/config` (the dir `agy` actually scans), captured today as `runtime.artifactLayout.global[].home` = `.gemini/config` in `capabilities/antigravity/capability.json:31,40`; the retirement of the old spot is migration `src/installer-migrations/010-antigravity-retire-confighome-artifacts.cts`, changeset text at `docs/installer-migrations.md:583`.
- No ADR is dedicated solely to "retire Gemini runtime" — the decision is recorded as a
  changeset + PR (#1928/#1996), not an ADR. The relevant ADRs (`docs/adr/1244-capability-ecosystem.md`, `docs/adr/2782-reviewer-lane-capability-surface.md`, `docs/adr/3660-runtime-artifact-layout-module.md`, `docs/adr/894-capability-declaration-format.md`) describe the *general* capability/reviewer-lane machinery that both Gemini's reviewer lane and Antigravity's runtime lane now ride on, not the migration event itself. **UNDETERMINED** whether an ADR was ever intended for the removal decision specifically — none exists under `docs/adr/`.

## 2. Taxonomy of `gemini` senses

**(a) Gemini *runtime* / install target — RETIRED.** Proven by:
- `bin/install.js:1073-1087` — `if (args.includes('--gemini'))` prints the sunset notice and exits 1; no install path remains.
- `bin/install.js:1075`: `'Gemini CLI was sunset by Google on 2026-06-18 and is no longer served for free/Pro/Ultra tiers.'`
- Guard test `tests/gemini-runtime-removed.test.cjs:1-19` (docblock) states the contract explicitly: *"Coverage: A. CLI redirect contract… B. The `gemini` runtime is gone from every runtime-name-policy surface. C. Antigravity is PRESERVED everywhere it shared surface with gemini (GEMINI.md instruction file + the shared convertGeminiToolName tool vocabulary)."* Test body (`:60-93`) asserts `--gemini` exits 1, cites the sunset date, redirects to `--antigravity`, and creates no `.gemini` dir.
- `capabilities/antigravity/capability.json:1-6` no longer has a `gemini` sibling runtime descriptor; `capabilities/gemini/capability.json:1-4` explicitly has **no `runtime` body at all** — only `reviewer`.

**(b) Gemini *CLI reviewer lane* (`capabilities/gemini/`) — LIVE and INTENTIONAL.**
- `capabilities/gemini/capability.json:1-40` — `role: "reviewer"`, `reviewer.slug: "gemini"`, flags `--gemini`, spawn transport `gemini -p - -m <model>`. Still wired into the registry: `gsd-core/bin/lib/capability-registry.cjs:1793-1817` (reviewer body), `:4945-4947` (config-key ownership), `:8148` (`"gemini": []` — no requires).
- Documented as a live reviewer flag in `docs/COMMANDS.md:269,757,1038,1810,1826,1834,1847-1851` and `docs/CONFIGURATION.md:297,329,340,384,394,401,1464,1474,1476,1492`, and in `docs/reference/capability-matrix.md:125` — `| gemini | reviewer | full | >=1.8.0 | — | — | first-party |`.
- CHANGELOG.md:89 shows the lane still receiving fixes as recently as #3996/#4184. This is a maintained, first-party lane — not an oversight.

**(c) Google Gemini directories/dialect that Antigravity legitimately reuses — MUST NOT be renamed.**
Confirmed exactly as the CRITICAL CONTEXT states, all still present and load-bearing:
- `capabilities/antigravity/capability.json:11-15` — `configHome.kind: "dot-home-nested"`, `parent: ".gemini"`, nested under `~/.gemini/antigravity`.
- `capabilities/antigravity/capability.json:31,40` — `artifactLayout.global[].home: ".gemini/config"` (the dir `agy` scans for machine-local discovery, per #3738).
- `capabilities/antigravity/capability.json:56` — `hookEvents: "gemini"` (hook-event dialect).
- `capabilities/antigravity/capability.json:78` — `hostBehaviors.projectInstructionFile: "GEMINI.md"`.
- Confirmed as deliberate, not incidental, in `src/runtime-name-policy.cts:105,117,127` (doc comments: *"antigravity: GEMINI.md is Antigravity CLI's contextFileName (the Gemini…)"*) and in `docs/reference/host-integration-capability-matrix.md:342` (EoS migration note: `hostBehaviors.projectInstructionFile` reads `"GEMINI.md" — Antigravity CLI's contextFileName, successor to the sunset Gemini CLI per #1928`).
- Shared tool-name vocabulary: `bin/install.js:1628-1720` — `claudeToGeminiTools`, `convertGeminiToolName` — still present and used by Antigravity's agent converter (`convertClaudeAgentToAntigravityAgent`, imported by `tests/gemini-runtime-removed.test.cjs:53` specifically to assert this survives). CHANGELOG.md:1455 confirms the shared vocabulary: *"excluded from the Gemini and Gemini-backed Antigravity agent `tools:` frontmatter."*
- `docs/reference/host-integration-capability-matrix.md:315,317,322,330` cite Google's own migration blog (`developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli`) as the evidentiary source for Antigravity inheriting the Gemini backend.

**(d) Gemini *models* in the model catalog — legitimate product names.**
- `gsd-core/bin/shared/model-catalog.json` contains `gemini-*` model IDs (not read directly here per the guard, but referenced in CHANGELOG.md:1561: *"the gemini opus default `gemini-3-pro` → `gemini-3.1-pro-preview`"*).
- Config docs: `docs/CONFIGURATION.md:297,1492` (`"gemini": "gemini-2.5-pro"`), `docs/CLI-TOOLS.md:1426` (`review.models.gemini "gemini-2.5-pro"`). All legitimate — naming the provider's model, not the retired runtime.

**(e) Historical/archival references — immutable, must not be rewritten.**
- `CHANGELOG.md` (dozens of lines, e.g. :1012, :1281, :1455, :1456, :1557) — release history, must stay as-is per repo convention (`CHANGELOG.md is Locked` — CLAUDE.md §"CHANGESETS & RELEASE NOTES").
- `.changeset/archived/fix-3344-gemini-agent-tool.md`, `.changeset/archived/fix-3362-windows-powershell-gemini.md`, `.changeset/archived/gemini-skip-local-when-global.md`, `.changeset/archived/213-antigravity-2-runtime-dirs.md`, `.changeset/archived/3608-antigravity-update-runtime.md`, `.changeset/archived/503-antigravity-agent-local-detection.md` — archived fragments, immutable release-note history.
- `docs/RELEASE-NOTES-LEGACY.md`, `docs/whats-new-1.7.0.md`, `.pr-body-3514.md`, `.pr-body-3515.md` — point-in-time snapshots; PRESERVE.
- `VERSIONING.md:133` — `` `gemini-extension.json` — Gemini CLI extension manifest (issue #775) `` — this line documents a **file that no longer exists** (`gemini-extension.json` was deleted in `8f2ebbe9bf`, confirmed via `find . -iname 'gemini-extension.json'` returning nothing). This is borderline (e) vs. (f): it reads as changelog-style provenance for a retired artifact, but VERSIONING.md is not an archival/frozen document the way CHANGELOG.md is — it is an active reference doc (`file inventory / what ships in which package`). **Verdict: MIGRATE or annotate** — see §4.

**(f) STALE references — treat Gemini as a live runtime/install target.**
See the full inventory in §4. Headline finding: the four README translations and most of the
`docs/{ja-JP,ko-KR,pt-BR,zh-CN}/` doc mirrors still describe "Gemini CLI" as a currently
supported, installable runtime alongside Claude Code/OpenCode/Kilo/Codex/Copilot/Antigravity —
while the English originals were scrubbed clean in `8f2ebbe9bf` and have zero such language.

## 3. The `GEMINI.md` file at repo root

- **What it is now**: Antigravity's `contextFileName` (inherited from the shared Gemini 3
  backend) — the file Antigravity auto-reads for project context, analogous to `CLAUDE.md` for
  Claude Code or `AGENTS.md` for Codex/OpenCode. Confirmed by its own banner: `GEMINI.md:1-6`
  — *"# GSD Core — Antigravity CLI context… this file is the context Antigravity reads
  automatically (its `contextFileName` is `GEMINI.md`, inherited from the shared Gemini 3
  backend)."*
- **Provenance**: originally shipped as part of a Gemini CLI extension package
  (`a3aa0ae142` `feat(#775): ship a gemini-extension.json extension package (#818)`), then
  **repointed to Antigravity** in the removal commit `8f2ebbe9bf` (same commit that deleted
  the Gemini runtime). It is correctly an Antigravity artifact today, not a Gemini-runtime
  leftover — PRESERVE.
- **Who generates/consumes it for user projects** (distinct from this repo's own root
  `GEMINI.md`, which is GSD's self-description for AI agents working on GSD itself):
  `getProjectInstructionFile(runtime)` in `src/runtime-name-policy.cts:105-127` maps
  `antigravity → GEMINI.md` (also `gemini → GEMINI.md` per CHANGELOG.md:1488, though the
  `gemini` runtime key itself no longer resolves to an installable runtime — the mapping table
  entry is vestigial/defensive, not reachable through `--gemini`). Compiled counterpart:
  `gsd-core/bin/lib/runtime-name-policy.cjs:118,130,140`. Consumed by the new-project workflow
  and `generate-claude-md` path per CHANGELOG.md:1488: *"A shared `getProjectInstructionFile(runtime)` policy… is now the single source of truth consumed by both the new-project workflow and the generate-claude-md path, with a parity test guarding drift."*
- **Guard**: `tests/project-instruction-file-parity.test.cjs` exists (per the file inventory)
  and is the parity test CHANGELOG.md:1488 refers to. `tests/product-name-purity.test.cjs:23-41`
  (`PRODUCTS`, `README_FILES`, `findProductParentheticals`) is a different, narrower guard —
  it checks that product names aren't parenthetically mis-glossed in READMEs, not that
  Gemini-as-runtime language is absent. Neither test inspects the translated docs (§5).
- **Verdict: PRESERVE.** The root `GEMINI.md` is correct and current.

## 4. Inventory of stale references (representative — not all ~400 hits)

`grep -rliE gemini` across the tree (excluding `node_modules`, `.git`, `.changeset`) returns
**~280 files** referencing `gemini`; the overwhelming majority are legitimate senses (b)–(e) —
reviewer-lane docs, model-catalog entries, ADR/CHANGELOG history, and the Antigravity dialect
notes in `CONTEXT.md`, `docs/reference/host-integration-capability-matrix.md`, and
`docs/installer-migrations.md:446,583`. The generated files (`docs/FEATURES.md`,
`gsd-core/bin/lib/capability-registry.cjs`, `gsd-core/bin/lib/capability-validator.cjs`) are
**not hand-edited** — `docs/FEATURES.md` is emitted by `scripts/gen-features.cjs` (registered
in `scripts/docs-guard-registry.cjs`), and the `.cjs` registry files under `gsd-core/bin/lib/`
are the build output of the `.cts` sources under `src/` (per `CONTEXT.md:248`, "NOT generated
from `src/*.cts`" applies only to `bin/install.js` itself — the `gsd-core/bin/lib/*` modules
ARE generated). Do not hand-edit generated files; any fix belongs in the `.cts` source or the
capability `.json` and must be regenerated.

| File | Line | Current text (paraphrased) | Sense | Verdict | Why |
|---|---|---|---|---|---|
| `README.ja-JP.md` | 9, 24, 46 | Lists "Gemini CLI" as a supported runtime alongside Claude Code/OpenCode/Kilo/Codex/Copilot/Cursor/Windsurf | (f) | **MIGRATE** | English `README.md` has **zero** gemini mentions (verified via grep); translation was never updated after `8f2ebbe9bf` |
| `README.ko-KR.md` | 9, 24, 46 | Same as above (Korean) | (f) | **MIGRATE** | Same |
| `README.zh-CN.md` | 9, 24, 46 | Same as above (Chinese) | (f) | **MIGRATE** | Same |
| `README.pt-BR.md` | 9, 24, 46 | Same as above (Portuguese) | (f) | **MIGRATE** | Same |
| `docs/ja-JP/ARCHITECTURE.md` | 24, 115, 449, 561, 637 | Describes Gemini CLI as a live runtime with install paths (`~/.gemini/`), colon-form commands, and a runtime table row | (f) | **MIGRATE** | `docs/ARCHITECTURE.md` (EN) has no such runtime-table row for gemini; only legitimate Antigravity `.gemini/*` path mentions (`:708,995`) |
| `docs/ko-KR/ARCHITECTURE.md` | 24, 118, 487, 615 | Same (Korean) | (f) | **MIGRATE** | Same |
| `docs/ja-JP/COMMANDS.md` | 10, 1241 | "Gemini CLI: `/gsd:command-name`" colon-namespace install instructions; `--gemini` reviewer row mixed with stale namespace claim | (f) partial | **MIGRATE** (namespace claim only) | EN `docs/COMMANDS.md` documents `--gemini` only as a reviewer flag (sense b, legitimate); the colon-namespace-install prose is runtime-install language that no longer applies |
| `docs/ko-KR/COMMANDS.md` | 10, 1247 | Same | (f) partial | **MIGRATE** | Same |
| `docs/ja-JP/USER-GUIDE.md` | 39, 674, 751 | "Gemini CLI-only" colon-form install flag, `~/.gemini` config dir table row, non-Claude runtime list including Gemini CLI | (f) | **MIGRATE** | EN `docs/USER-GUIDE.md` has zero gemini mentions |
| `docs/ko-KR/USER-GUIDE.md`, `docs/pt-BR/USER-GUIDE.md`, `docs/zh-CN/USER-GUIDE.md` | (equivalent) | Same pattern | (f) | **MIGRATE** | Same |
| `docs/ja-JP/FEATURES.md` | 1016 | "REQ-RUNTIME-01: system must support Claude Code, OpenCode, Gemini CLI, Kilo, Codex, Copilot, Antigravity" | (f) | **MIGRATE** (or regenerate — see note) | EN `docs/FEATURES.md` is generated and does not list Gemini as a supported runtime requirement; translations of a generated doc need their own regeneration/translation pipeline, not hand-edits |
| `docs/ko-KR/FEATURES.md`, `docs/zh-CN/FEATURES.md` | (equivalent) | Same | (f) | **MIGRATE** | Same |
| `docs/ja-JP/how-to/set-up-cross-ai-review.md` | 11, 18, 144 | Lists Gemini CLI as one of the review-lane CLIs (legitimate, sense b) but frames install/auth instructions in runtime-like terms | (b), mostly legitimate | **VERIFY, likely PRESERVE** | Reviewer-lane language is legitimate; flagged only because it needs a human check that no install-target framing leaked in — lower priority than the ARCHITECTURE/USER-GUIDE/README hits |
| `docs/ja-JP/how-to/install-on-your-runtime.md` | 49, 55 | "### Gemini CLI" section header with its own install instructions (skills path `~/.gemini/`, restart Gemini CLI) | (f) | **MIGRATE/DELETE** | EN `docs/how-to/install-on-your-runtime.md` has no Gemini CLI section — only Antigravity's `.gemini/antigravity*` dialect notes (`:443,448`). The whole translated section describes a runtime that no longer installs |
| `docs/ko-KR/how-to/install-on-your-runtime.md`, `docs/pt-BR/...`, `docs/zh-CN/...` | (equivalent) | Same | (f) | **MIGRATE/DELETE** | Same |
| `docs/ja-JP/context-monitor.md`, `docs/ko-KR/context-monitor.md`, `docs/pt-BR/context-monitor.md`, `docs/zh-CN/context-monitor.md` | 3, 65 | "Gemini CLI's hook is `AfterTool`" | (c)-adjacent | **VERIFY** | This is describing the hook-event dialect (legitimate, sense c, since Antigravity inherits it) but phrased as "for Gemini CLI" rather than "for the Gemini-family hookEvents dialect (used by Antigravity)" — a wording/attribution nit, not a functional error; low priority |
| `VERSIONING.md` | 133 | `` `gemini-extension.json` — Gemini CLI extension manifest (issue #775) `` | (e)/(f) boundary | **MIGRATE (annotate as removed)** | The file was deleted in `8f2ebbe9bf`; VERSIONING.md is an active reference doc (not a frozen changelog), so this line should either be removed or annotated "(removed #1928)" |
| `bin/install.js` | 1628-1720 | `claudeToGeminiTools` / `convertGeminiToolName` | (c) | **PRESERVE — trap** | Actively used by Antigravity's agent converter; explicitly guarded by `tests/gemini-runtime-removed.test.cjs:53` Coverage C |
| `capabilities/gemini/capability.json` | whole file | Reviewer-lane-only manifest | (b) | **PRESERVE — trap** | Deliberately re-created post-removal; see §1, §2(b) |
| `capabilities/antigravity/capability.json` | 11-15, 31, 40, 56, 78 | `.gemini` configHome/artifactLayout/hookEvents/GEMINI.md | (c) | **PRESERVE — trap** | Antigravity's real on-disk contract; renaming breaks the actual IDE integration |
| `GEMINI.md` (root) | whole file | Antigravity context file | (c) | **PRESERVE — trap** | See §3 |
| `docs/CONFIGURATION.md`, `docs/COMMANDS.md`, `docs/CLI-TOOLS.md`, `docs/reference/capability-matrix.md` (EN) | many | `review.models.gemini`, `--gemini` reviewer flag, model IDs | (b), (d) | **PRESERVE** | Reviewer lane + model catalog, both live and correct |
| `CHANGELOG.md` | many (e.g. 1012, 1281, 1455-1456) | Migration history | (e) | **PRESERVE — locked** | `CHANGELOG.md is Locked` per CLAUDE.md; never hand-edit |
| `.changeset/archived/*gemini*`, `.changeset/archived/*antigravity*` | whole files | Archived fragments | (e) | **PRESERVE** | Immutable release history |

**Not checked exhaustively** (out of budget for this pass, flagged for a follow-up sweep):
`docs/pt-BR/COMMANDS.md`, `docs/pt-BR/CONFIGURATION.md`, `docs/pt-BR/CLI-TOOLS.md`,
`docs/zh-CN/COMMANDS.md`, `docs/zh-CN/CONFIGURATION.md`, `docs/zh-CN/CLI-TOOLS.md`,
`docs/{ja-JP,ko-KR,pt-BR,zh-CN}/how-to/{configure-model-profiles,execute-a-phase,set-up-cross-ai-review,spike-and-sketch,verify-and-ship}.md`,
`docs/{ja-JP,ko-KR,pt-BR,zh-CN}/INVENTORY.md`, `docs/{ja-JP,ko-KR,pt-BR,zh-CN}/CLI-TOOLS.md`. Given
the pattern found in ARCHITECTURE.md/COMMANDS.md/USER-GUIDE.md/FEATURES.md/README across all
four locales, it is highly likely the same "Gemini CLI listed as a live runtime" pattern
recurs in most of these — **UNDETERMINED exact count without a full per-file diff against the
EN originals; estimated 60-100 additional stale lines across the untranslated-drift set**
(the raw `grep -c 'Gemini CLI'` across `docs/pt-BR/ docs/zh-CN/` + the four translated READMEs
alone already returned 61 matches in this pass).

**Estimated total stale (sense-f) reference count: at least 30 confirmed above, likely
100+ once the full ja-JP/ko-KR/pt-BR/zh-CN doc tree is diffed line-by-line against the EN
originals.** This is overwhelmingly a **translation-parity problem**, not a scattered set of
independent bugs — one systemic gap (translations never re-synced after `8f2ebbe9bf`)
accounts for nearly all of it.

## 5. Guards: what catches regressions, and what doesn't

- `tests/gemini-runtime-removed.test.cjs` — **scope is explicitly stated in its own docblock
  (`:1-19`)**: (A) the `--gemini` CLI redirect contract, (B) `gemini` gone from
  `runtime-name-policy` surfaces (`canonicalizeRuntimeName`, `getRuntimeLabel`,
  `getGlobalConfigHomeFragment`, `getRuntimeNewProjectCommand`, `runtimeFlags`,
  `getProjectInstructionFile` — all imported at `:44-51`), (C) Antigravity's shared surface
  (`GEMINI.md`, `convertGeminiToolName`) survives. **It never reads any file under `docs/` or
  any `README.*` translation** — it only spawns the installer and inspects
  `runtime-name-policy.cjs`/`capability-registry.cjs`/`install.js` exports. A stale
  "Gemini CLI is a supported runtime" sentence in `README.ja-JP.md` cannot fail this test by
  construction.
- `tests/product-name-purity.test.cjs:23-41` — scoped to `PRODUCTS`/`README_FILES` and
  `findProductParentheticals`: checks that product names aren't mis-glossed parenthetically
  (e.g. "Claude (Anthropic's coding agent)" drift), not that a named product is still a live
  install target. Different axis entirely.
- `tests/project-instruction-file-parity.test.cjs` — guards that `getProjectInstructionFile`
  stays consistent between the new-project workflow and the generate-claude-md path
  (CHANGELOG.md:1488). Code-level parity, not prose-level.
- `tests/docs-parity-live-registry.test.cjs:43` (`LOCALES` constant) and
  `tests/docs-state-md-locale-parity.test.cjs:30` (`LOCALES` constant) — these **are** the
  repo's translation-parity guards, but (per their names and the `docs-guard-registry.cjs`
  registration table) they check *structural* parity — that a live registry-derived table
  (reviewer flags, STATE.md field reference) is present and enumerated identically across
  locales — not that free-form prose describing "which runtimes GSD supports" is factually
  current. They would catch a **missing row**, not a **stale but present** row.
- **Missing guard**: there is no test that asserts "no locale doc claims Gemini CLI is an
  installable runtime" the way `tests/gemini-runtime-removed.test.cjs` asserts it for the
  English surfaces and the installer itself. This is the specific gap that let ~30-100+ stale
  translated-doc references slip through three-plus release cycles since `8f2ebbe9bf`
  (2026-07-04) to today (2026-09-13).
- Recommended shape for the missing guard (not implemented by this research task, which is
  read-only): a locale-parity test that, for each `docs/<locale>/*.md` and `README.<locale>.md`
  file, asserts it contains no "Gemini CLI" occurrence outside a reviewer-lane-flag context
  (mirroring the EN original's own absence), OR a stronger structural fix — derive the
  runtime-list prose (`docs/ARCHITECTURE.md`'s "Claude Code / OpenCode / Kilo / Codex /
  Copilot / Antigravity / Trae / Cline / Augment Code" enumeration) from
  `runtime-name-policy`'s `allRuntimes` at doc-generation time instead of hand-authoring it in
  ten languages independently.

## 6. Ripple / bookkeeping requirements for any fix

Per this repo's own `CLAUDE.md` (project instructions) and repo conventions, a change that
touches the stale references identified in §4 must carry:

- **Changeset required.** `CLAUDE.md` §"CHANGESETS & RELEASE NOTES": drop a fragment in
  `.changeset/` via `npm run changeset -- --type <T> --pr <NNN> --body "..."`. Type would be
  `Fixed` (docs-only correction of stale claims) per the six allowed types
  (`Added|Changed|Deprecated|Removed|Fixed|Security`) — there is no `Documentation` type; a
  docs-only fix uses `Fixed`.
- **`CHANGELOG.md` stays locked** — never hand-edit; the changeset renders it.
- **`docs/INVENTORY.md` + manifest regen** if any file is added/removed/renamed:
  `node scripts/gen-inventory-manifest.cjs --write` (CLAUDE.md "KNOWN DEFECTS" §"Inventory
  Drift"). A pure text edit inside existing translated `.md` files likely does not trigger
  this, but deleting a stale section (e.g. the Gemini CLI subsection in
  `docs/*/how-to/install-on-your-runtime.md`) does not remove a *file*, so INVENTORY.md
  itself is probably unaffected — **UNDETERMINED without running the generator**.
- **Golden install-tree regeneration** — not applicable here; these are prose docs, not
  installer output fixtures (`tests/fixtures/install-tree/*.json`,
  `tests/fixtures/golden-install-parity/*.json`). No golden fixture references were found to
  need regeneration for a docs-only fix.
- **`docs/FEATURES.md` / generated capability fragments** — per this task's own note, these
  are generated by `scripts/gen-features.cjs` and the `.cts→.cjs` build; any fix to their
  *translated* counterparts (`docs/{ja-JP,ko-KR,zh-CN}/FEATURES.md`) needs to go through
  whatever translation/regeneration pipeline produces them (not located/verified in this pass
  — **UNDETERMINED**: no `gen-features-<locale>.cjs` or translation-sync script was found by
  name; the translated FEATURES.md files may be manually maintained mirrors, which would make
  them structurally prone to exactly this kind of drift).
- **Glossary gate** — `CLAUDE.md` "Repo conventions" cites `gsd-context-md-glossary-is-a-pr-gate` (per user memory index); `CONTEXT.md` itself mentions Gemini/Antigravity only in the legitimate installer/config-dir sense (`CONTEXT.md:248`) and does not need correction based on this pass.
- **Translation parity** — no dedicated "translation must match EN" gate was found beyond the
  narrow structural `LOCALES`-based tests in §5; this is the actual missing-guard finding.
- **ADR requirement** — a prose/docs correction of this kind (removing stale claims,
  no behavior change) does not meet the bar for "every bug-fix and feature change requires
  ADR" in the sense `docs/adr/` uses (ADRs there are architectural decisions, not doc
  corrections); **no new ADR is required** for fixing the stale references themselves. An ADR
  would only be warranted if the *fix* itself introduced a new mechanism (e.g. a
  runtime-list-derived doc generator).

## Scope note

This document is read-only research. No source file other than this one was modified. The
`docs/{ja-JP,ko-KR,pt-BR,zh-CN}` files listed as MIGRATE in §4 were identified but **not
edited** — remediation is a separate, subsequent change subject to the ripple requirements in
§6.

---

## 7. Addendum — the severest class the §4 sweep missed: live workflow behavior

§4 concluded the residue is "overwhelmingly a translation-parity problem". That is true by
*count*, but not by *severity*. Runtime-loaded workflow text under `gsd-core/workflows/` still
assigns and offers the retired `gemini` runtime id, and the name policy resolves that id to
**Claude Code** instead of failing loudly.

### 7.1 Measured: an unknown runtime id resolves to a safe-looking known

Executed against `next@c0b2a05d2f`:

```
canonicalizeRuntimeName('gemini')       = null
getProjectInstructionFile('gemini')     = "AGENTS.md"
getRuntimeLabel('gemini')               = "Claude Code"
getGlobalConfigHomeFragment('gemini')   = "'.claude'"
getGlobalConfigDir('gemini')            = ~/.claude
getGlobalConfigDir('antigravity')       = ~/.gemini/antigravity
```

`gemini` is correctly non-canonical, so `tests/gemini-runtime-removed.test.cjs` Coverage B
passes. But the other accessors do not reject it — they fall through to Claude Code defaults.
A stale `RUNTIME="gemini"` therefore produces a *plausible wrong answer* rather than an error:
the Claude config dir, the label "Claude Code", and `AGENTS.md` as the instruction file.

Note `AGENTS.md` also contradicts the workflow's own documented claim at
`gsd-core/workflows/new-project.md:1216` and `:1238` ("`GEMINI.md` for gemini/antigravity").
The prose and the policy disagree about the same retired id.

### 7.2 The live assignment sites that reach it

| File | Line | Text | Verdict |
|---|---|---|---|
| `gsd-core/workflows/new-project.md` | 76 | `` Path contains `/.gemini/` → `RUNTIME=gemini` `` | **MIGRATE** — `~/.gemini` is Antigravity's parent; the only live child is `~/.gemini/antigravity` |
| `gsd-core/workflows/new-project.md` | 84 | `elif [ -n "$GEMINI_CONFIG_DIR" ]; then RUNTIME="gemini"` | **MIGRATE** — live shell branch minting a non-canonical id that silently resolves to Claude Code (§7.1) |
| `gsd-core/workflows/new-project.md` | 576 | "required for non-Claude runtimes: Codex, Gemini CLI, OpenCode…" | **MIGRATE** — names a sunset product as a supported runtime |
| `gsd-core/workflows/new-project.md` | 1216, 1238 | "`GEMINI.md` for gemini/antigravity" | **MIGRATE** — drop `gemini/`; keep `antigravity` |
| `gsd-core/workflows/settings-advanced.md` | 412 | `{ label: "gemini", description: "Gemini CLI." }` | **MIGRATE** — a user-facing `AskUserQuestion` menu still **offers Gemini CLI as a selectable runtime** |
| `gsd-core/workflows/settings-advanced.md` | 393 | "Common runtimes: claude, codex, gemini, qwen" | **MIGRATE** |
| `gsd-core/workflows/settings-advanced.md` | 360 | model-profile table row keyed `gemini` (runtime axis) | **MIGRATE** — the row key is the retired runtime; the `gemini-*` model IDs in it are legitimate (sense d) |
| `gsd-core/workflows/settings-advanced.md` | 510-512 | `config-set runtime gemini`, `model_profile_overrides.gemini.*` | **MIGRATE** — documented examples that set a non-canonical runtime |
| `gsd-core/workflows/settings-advanced.md` | 673-675 | `google` provider rows | **PRESERVE** — provider axis, not runtime |
| `gsd-core/workflows/reapply-patches.md` | 62-63, 91-92, 101 | probes `$GEMINI_CONFIG_DIR` and `~/.gemini/gsd-local-patches`; bare `.gemini` in the dir scan | **MIGRATE** — same class as #4347 but **hand-written, so `npm run sync:launcher` does not reach it** |
| `gsd-core/workflows/update.md` | 77, 135, 276, 277, 315 | bare `~/.gemini/` / `./.gemini/` as a runtime config dir | **MIGRATE** — the live dir is `~/.gemini/antigravity` |
| `gsd-core/workflows/update.md` | 466 | dir scan list including bare `.gemini` | **MIGRATE** |
| `gsd-core/workflows/update.md` | 17, 466 | `.gemini/antigravity{,-ide,-cli}` → `antigravity` | **PRESERVE** |

These are **not** doc-only paths for gating purposes: `pre-pr-gate.sh`'s `DOC_ONLY_RE` anchors
its `*.md` arm at repo root only, so `gsd-core/workflows/*.md` is gated code.

### 7.3 Second, un-migrated launcher generation

`commands/gsd/graphify.md:83,100,125,144,164` and `skills/gsd-graphify/SKILL.md` carry an
**older** launcher form (the long `elif [ -f … ]` chain) than the compact `_gsd_at` form in
`gsd-core/workflows/_runtime-launcher.snippet.sh:1`. Both generations carry the
`${GEMINI_CONFIG_DIR:-$HOME/.gemini}` arm. Any fix that only re-runs the launcher sync will
therefore miss the graphify copies — a generative-fix divergence hazard.

### 7.4 Consequence for the guard design

The missing guard proposed in §5 was scoped to locale prose. It must also cover code and
runtime-loaded workflow text, and the cheapest durable form is to make the name policy
**fail loud** on a non-canonical id rather than defaulting to Claude Code — which would have
turned every site in §7.2 into a hard error on the day #1928 landed.
