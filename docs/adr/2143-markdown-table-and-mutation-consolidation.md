# ADR-2143: Markdown Table Model, Bounded Mutation, and Fail-Loud Consolidation (#1372 part 2)

- **Status:** Accepted (Phase 0 — ADR only; locks the contract Phases 1–4 execute against. No production code lands in this PR.)
- **Date:** 2026-07-10
- **Issue:** [#2143](https://github.com/open-gsd/gsd-core/issues/2143) — epic (tech-debt / root-cause consolidation, `type: chore` + `approved-enhancement`)
- **Supersedes:** nothing
- **Relationship to prior work:** the second half of [#1372](https://github.com/open-gsd/gsd-core/issues/1372) (which built the `markdown-sectionizer` **read** seam and the `local/no-adhoc-markdown-parsing` rule, then closed). Sibling of [#2121](https://github.com/open-gsd/gsd-core/issues/2121) (`phase-id.cts`, the phase-identifier slice). The fail-loud decision (§5) is the document-mutation analog of **ADR-1411** (Resolution Provenance — "report provenance rather than fall open silently to defaults").

## Context

GSD's two canonical planning documents — `ROADMAP.md` and `STATE.md` — are read and rewritten by a dozen CLI surfaces (`phase complete`, `requirements mark-complete`, `milestone complete`, `roadmap update-plan-progress`, `getMilestoneInfo`, `deriveProgressFromRoadmap`, the `fast.md`/`quick.md` workflows, …). Epic #1372 **already** built the shared primitive these need for structure and closed after migrating the read-side parsers: `src/markdown-sectionizer.cts` exports `stripFencedCode`, `tokenizeHeadings`, `collectSection`/`collectSections`, `iterateBullets`, `extractTaggedBlocks`, and `replaceSection`, and `eslint-rules/no-adhoc-markdown-parsing.cjs` prohibits new hand-rolled fence/section/bullet scanning.

#1372 covered fenced code, headings, sections, and bullets. It **explicitly excluded three surfaces**, and every recurring `ROADMAP`/`STATE` parser bug since lives on one of them. This is the same class the standards already name under **Generative Fix Divergence** (`CLAUDE.md`):

> When sharing constants/arrays/parsers between parallel surfaces, add a parity assertion test that fails if they diverge.

The guard exists in the standard but is not applied to tables or to document mutation.

### The three excluded surfaces (with the bugs they produced)

| Surface #1372 excluded | Mechanism | Confirmed issues |
|---|---|---|
| **Markdown tables** — the seam models headings/bullets, never tables | Each canonical table (ROADMAP `## Progress`, Requirements traceability, Quick Tasks, SECURITY) is hand-parsed with a **hard-coded column count**. `deriveProgressFromRoadmap` (`src/phase-lifecycle.cts:45`) pins the `Status` column at cell position 3, so the 5-column milestone-grouped Progress table the project's own template ships returns all-null. The writer and the reader of a table are defined in two places and drift. | [#2137](https://github.com/open-gsd/gsd-core/issues/2137), [#2133](https://github.com/open-gsd/gsd-core/issues/2133), [#2012](https://github.com/open-gsd/gsd-core/issues/2012), [#2119](https://github.com/open-gsd/gsd-core/issues/2119) |
| **In-place document mutation** — no bounded-write primitive is used | Roughly 19 whole-document `content.replace()` call sites across `phase.cts` / `milestone.cts` / `state-transition.cts` / `roadmap.cts` / `state-document.cts` regex-edit the entire file. An unbounded lazy run escapes its phase section and rewrites a **later** phase (`phase.cts:1519-1522`, `planCountPattern`). The seam's `replaceSection` write primitive exists but these sites bypass it. | [#2130](https://github.com/open-gsd/gsd-core/issues/2130), [#2067](https://github.com/open-gsd/gsd-core/issues/2067), [#2080](https://github.com/open-gsd/gsd-core/issues/2080) |
| **Fail-loud** — parse-miss and partial writes collapse to "success" | Parse-miss returns `null`, swallowed by an empty `catch` (`phase-lifecycle.cts:77`), so the command silently skips its write and reports success. Multi-surface writes OR their outcomes into one `found` flag (`milestone.cts:78-91`), so a checkbox-only partial write reports `updated:true`. | [#2137](https://github.com/open-gsd/gsd-core/issues/2137), [#2012](https://github.com/open-gsd/gsd-core/issues/2012), [#2140](https://github.com/open-gsd/gsd-core/issues/2140), [#2118](https://github.com/open-gsd/gsd-core/issues/2118), [#2112](https://github.com/open-gsd/gsd-core/issues/2112) |

### The debt is orphaned, and the prohibition has no teeth

Two facts make this a structural gap rather than a backlog of point fixes:

1. **13 `allow-adhoc-markdown` grandfather markers remain in `src/`; 11 of them defer to "#1372" — a closed epic** (e.g. `phase-lifecycle.cts:52`: `allow-adhoc-markdown: … table parsing, out of seam scope; pending #1372`). The escape hatches point at work that shipped without covering their case, so nothing tracks them.
2. **`no-adhoc-markdown-parsing.cjs` only filename-guards `src/*.cts`.** It polices neither table-shaped regex nor `.replace()` mutation. A PR can add a fifth hard-coded table parser or a twentieth whole-document `.replace()` without a single failing check — which is why the class keeps re-opening under new numbers.

`#2135` is listed elsewhere in this epic's discussion; note that its *heading-resolution* slice belongs to #2121 (`phase-id.cts`), while its unvalidated-capture / write-through aspects are downstream of §5 here. Per `CONTRIBUTING.md` ("one issue = one ADR-or-PRD = one PR"), this ADR is that one file: it decides and **locks** the target seam extensions and ships no production code.

## Decision

Extend #1372's proven mechanism — one seam, a prohibition with teeth, and a tier-by-tier burndown — to the three surfaces it excluded. Seven decisions, locked below. Phases 1–4 execute against them as separate PRs.

### 1. The `markdown-sectionizer` seam is the sole owner of table parsing and document mutation for `ROADMAP.md` / `STATE.md`

"Markdown structure operations" is extended to the closed set: **strip fenced code · tokenize headings · collect sections · iterate bullets · parse table · mutate a bounded section**. Every function in that set lives in the seam (`src/markdown-sectionizer.cts`, or a co-located `src/markdown-table.cts` for the table half if size warrants — same seam, same ESLint scope, same QA matrix). Consumers `import` the canonical functions; **no consumer parses a table or rewrites a planning document with a local regex.**

*Rejected:* a second parsing module per document type (`roadmap-model.cts`, `state-model.cts`) — rejected because it re-creates the multi-seam divergence #1372 removed. The document-typed models (Decision 3/4) are thin typed views built **on** the one seam, not parallel parsers.

### 2. Extend, never mutate — the backward-compatibility guarantee (Hyrum's Law)

Phases 1–4 may only **add** exports to the seam. The observable behavior of the seven existing #1372 exports is frozen. Each migration of a consumer runs Memtrace `get_impact` on the function being rerouted **before** the change and states the blast radius in its PR; a consumer is migrated behaviour-preservingly except where its phase scope names a specific fixed bug (then a fail-first regression test drives the fix).

### 3. The table model (locked API)

Phase 1 adds a typed table primitive. Signatures are **locked**; later phases consume them verbatim.

- **`parseMarkdownTable(sectionText: string): Result<MarkdownTable>`** where `MarkdownTable = { columns: string[]; rows: Record<string, string>[] }`. Cells are addressed by **column name**, never by ordinal position. A row shorter/longer than the header is a typed parse error, not a silently mismatched cell.
- **A single-source `TABLE_SCHEMAS` registry** naming each canonical table's column set exactly once: `RoadmapProgress`, `RequirementsTraceability`, `QuickTasks`, `Security`. The registry supports variant column sets under one schema id (e.g. Quick Tasks *with* and *without* the `Status` column; the Progress table *with* and *without* the milestone-grouping column), so schema evolution is declared, not re-discovered by a reader.
- **Both the template writer and every reader consume the registry**, and a **parity test** asserts `template-emitted header ≡ TABLE_SCHEMAS[id] ≡ reader’s expected columns`. Drift fails CI (the `CLAUDE.md` Generative-Fix-Divergence rule, finally applied to tables). This is the durable fix for #2137 (reader hard-codes a shape the writer doesn't emit), #2133 (the `fast.md` shell guard and `quick.md` writer disagree on column count), and #2119 (dual SECURITY.md writers with conflicting shapes).

### 4. Bounded mutation (locked API)

- **`withSection(content: string, target: string | HeadingPredicate, edit: (body: string) => string): string`** — built on the existing `collectSection` + `replaceSection`. It resolves the target section's character range once and applies `edit` **only** to that range, then re-serializes. An edit **cannot** cross a section boundary, so the #2130 / #2067 / #2080 class becomes structurally impossible rather than tempered one regex at a time.
- ROADMAP per-phase edits go through **`withPhaseSection(content, phaseId, edit)`**, a thin wrapper that resolves the phase heading via the #2121 `phase-id` lookup sources and delegates to `withSection`.
- Whole-document `.replace()` against `ROADMAP`/`STATE` content is **prohibited** (enforced by §7). The ~19 existing sites are migrated in Phase 2.

### 5. Fail-loud parsing (no null-swallow)

Seam parse operations and the document-model accessors return a typed **`Result<T>`** (`{ ok: true; value: T } | { ok: false; reason: string }`) — never a bare `null` that a caller can mistake for "empty but fine." Empty `catch` blocks that mask a parse-miss (e.g. `phase-lifecycle.cts:77`) are removed; a command that cannot parse its input **reports the failure** instead of skipping its write and returning success. This is the document-mutation analog of ADR-1411: structure resolution reports provenance rather than defaulting silently.

### 6. Write-set results for multi-surface commands (no OR-into-one-flag)

A command that mutates more than one surface returns a **per-surface write-set** — an explicit list of `{ surface, applied }` outcomes — and its top-level `updated` / `found` / `complete` is true **only if every required surface applied**. OR-ing independent surfaces into a single boolean is prohibited. This is the direct fix for #2140 (checkbox surface OR traceability-row surface → partial write reports full success) and the shape #2118 (`--dry-run` honored per surface) and #2112 (declared paths vs the whole index) need.

### 7. Prohibition with teeth (what makes it stick)

The mechanism that ended the read-side game, applied to the two new surfaces:

- **Extend `local/no-adhoc-markdown-parsing`** to also flag (a) table-shaped regex (`/\|[^|]*\|/`-family literals over document content) and (b) `.replace()` on `ROADMAP`/`STATE` content outside the seam. A grandfather allowlist is burned down per phase; after each phase its entries are deleted, not renewed.
- **Re-point the 11 orphaned `pending #1372` markers to `pending #2143`** and burn them down as their owning site is migrated. Phase 4 asserts zero `pending #2143` markers remain.
- **Add a table-schema drift lint** (`scripts/lint-table-schema-drift.cjs`) modeled on the existing `capability-precedence-parity` / `package-identity-drift` guards, wired into `lint:ci`.

## Phases

Each phase is one `chore(#2143): … — Phase N` sub-issue + PR, gated on `gsd-test`. Behaviour-preserving except where a phase names a fixed bug (driven fail-first).

- **Phase 1 — table model + pilot migration.** Add `parseMarkdownTable` + `MarkdownTable`, the `TABLE_SCHEMAS` registry, and the writer/reader parity test. Migrate `deriveProgressFromRoadmap` as the pilot reader (**fixes #2137**). Convert the `quick.md`/`fast.md` Quick Tasks guard to a `gsd-tools` table helper backed by the shared schema so the column arithmetic is executed and tested once, not re-implemented in embedded `awk` (**fixes #2133**; addresses #2012, #2119).
- **Phase 2 — bounded-mutation seam.** Add `withSection` / `withPhaseSection`; migrate the ROADMAP mutation sites in `phase.cts` (**structurally retires the #2130 / #2067 / #2080 class**), verified by a property test that a mutation to phase *k* leaves every other phase byte-identical.
- **Phase 3 — fail-loud + write-set.** Introduce the parse `Result` type; remove the null-swallowing empty catches; add the per-surface write-set. Fixes **#2140**, **#2112**, **#2118**; closes the masking half of #2137 / #2012.
- **Phase 4 — prohibition with teeth.** Extend the ESLint rule to tables + mutation; delete the (now-migrated) grandfather entries; assert zero `pending #2143` markers; ship the drift lint.

## Consequences

- **Positive:** the recurring `ROADMAP`/`STATE` parser-bug game ends on the surfaces #1372 didn't reach — boundary-crossing becomes impossible by construction, table schema drift fails CI, and a partial or unparseable write can no longer masquerade as success. New commands inherit correctness from the seam instead of re-deriving it.
- **Cost:** four sequential PRs plus test/lint infrastructure; `get_impact` due diligence on each migrated consumer (some, like the `phase.cts` mutators, have non-trivial blast radius).
- **Risk:** behaviour-preserving migrations can regress subtle formatting; mitigated by the extend-never-mutate lock (§2), fail-first regression tests for each named bug, and the per-phase `gsd-test` gate.
- **Non-goals:** phase-identifier parsing (owned by #2121); any new user-facing command; changing the on-disk `ROADMAP`/`STATE` formats; migrating non-planning markdown (ADR/PRD/CONTEXT parsers already on the #1372 seam).

## References

- Epic: [#2143](https://github.com/open-gsd/gsd-core/issues/2143) · Phase 0 sub-issue: [#2144](https://github.com/open-gsd/gsd-core/issues/2144)
- Prior seam: [#1372](https://github.com/open-gsd/gsd-core/issues/1372) (`markdown-sectionizer`), ADR-1372
- Sibling consolidation: [#2121](https://github.com/open-gsd/gsd-core/issues/2121) (`phase-id.cts`), ADR-2121
- Fail-loud precedent: ADR-1411 (Resolution Provenance)
- Motivating bugs: #2137, #2133, #2130, #2119, #2140, #2118, #2112, #2012, #2067, #2080
