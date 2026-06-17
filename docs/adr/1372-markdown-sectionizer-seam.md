# ADR-1372: Canonical markdown-structure parsing — the `markdown-sectionizer` seam

- **Status:** Accepted
- **Date:** 2026-06-17
- **Issue:** [#1372](https://github.com/open-gsd/gsd-core/issues/1372) (epic)
- **Resolves (via tier T1):** [#1364](https://github.com/open-gsd/gsd-core/issues/1364), [#1365](https://github.com/open-gsd/gsd-core/issues/1365)
- **Relates:** [#1343](https://github.com/open-gsd/gsd-core/issues/1343), [#1324](https://github.com/open-gsd/gsd-core/issues/1324), [#447](https://github.com/open-gsd/gsd-core/issues/447) — prior single-parser markdown bugs
- **Pattern precedent:** [ADR-857](857-capability-system.md) / epic [#1267](https://github.com/open-gsd/gsd-core/issues/1267) (retire a duplicated spine via tiered children)

## Context

GSD parses a lot of structured markdown — `CONTEXT.md`, `ROADMAP.md`, `STATE.md`, `*-PLAN.md`, UAT files, ADRs, frontmatter. There is **no shared primitive** for the three operations every one of these parsers needs (strip fenced code, tokenize headings into sections, iterate bullets), so each module hand-rolls them. A grounded map of `src/*.cts` found:

- **8+ independent markdown parsers**: `decisions`, `gap-checker`, `roadmap-parser`, `state`, `uat`, `uat-predicate`, `adr-parser`, `check-command-router`.
- **3–4 independent fenced-code strippers of different fidelity**: `decisions.cts` (fragile regex, no unclosed-fence handling), `roadmap-parser.cts` `stripFencedLines` (state machine, **duplicated 3× in one file**), `uat-predicate.cts` `_stripFencedBlocks` (CommonMark-correct, CRLF-safe, signals an unterminated fence), `check-command-router.cts` `stripCommentsAndFences` (another regex copy).
- **~20 hand-rolled section-collects**, with `state.cts` alone re-implementing the same `/(###?\s*<Name>\s*\n)([\s\S]*?)(?=\n###?|$)/i` shape **13 times**.

The consequence is a recurring maintenance game: every "the parser missed structure X" report (#1343 bullet-before-colon, #1364 markdown-header + em-dash, #1324 glued phase tokens, #447 gap scoping) is fixed *locally* with another regex, and the same class of bug re-opens in the next parser. The fixes do not compound — they accrete. Worse, in the decision-coverage case the failure mode is **silent**: a blocking gate that cannot parse its input reports `passed:true, covered 0/0` and ships the phase with its decisions unchecked.

There are two root causes, and a durable fix must address both:

1. **No canonical structure primitive** — so structural correctness (fences, CRLF, heading levels, Unicode, bullet shapes) is re-litigated per module and tested unevenly.
2. **Nothing prevents the next ad-hoc parser** — a new PR can add a fourth fence stripper and no gate objects, so the divergence regrows even after a cleanup.

## Decision

Establish a single canonical markdown-structure seam and make ad-hoc markdown scanning a lint-enforced prohibition. Migrate every existing parser onto the seam incrementally, tracked as tiered children of epic #1372.

### 1. The seam — `src/markdown-sectionizer.cts` (pure, Node built-ins only)

No external markdown library (the "no external dependencies in core" rule stands). Pure functions, string-in → value-out, no I/O:

- `stripFencedCode(content) → { text, unterminatedFence }` — the CommonMark-correct state machine promoted from `uat-predicate.cts` `_stripFencedBlocks` (CRLF-safe; ≤3-space indent tolerated; closes only on a same-or-longer fence run). `unterminatedFence` is a reusable malformed-input diagnostic.
- `tokenizeHeadings(content) → HeadingToken[]` — ATX headings `{ level, text, line, offset }` in document order.
- `collectSections(content, stopPredicate)` and `collectSection(content, headingPredicate, { levelBounded, stripFences })` — line-by-line (not greedy-regex) section collection; `levelBounded` encodes the dominant "stop at same-or-higher-level heading" pattern. Both populate `bodyStart`/`bodyEnd` character offsets on the returned `Section` for use by `replaceSection`.
- `iterateBullets(sectionText) → BulletItem[]` — dash/asterisk/plus, checkbox (`- [ ]`/`- [x]`), and numbered markers, with indented continuation-line accumulation.
- `extractTaggedBlocks(content, tagName) → string[]` — returns the inner text of every `<tagName>…</tagName>` block in document order; `tagName` is regex-escaped; the caller decides ordering (does not strip fences). Generalises `decisions.cts`'s bespoke `<decisions>` extractor for T1 adoption.
- `replaceSection(content, section, newBody) → string` — pure character-offset splice using `section.bodyStart`/`bodyEnd`; replaces a section body in a read-modify-write workflow (e.g. `state.cts`'s 7× inline `content.replace(/(##\s*Name\s*\n)([\s\S]*?)(?=\n##|$)/, ...)` pattern). CRLF-safe.

The seam is fully tested against the parser QA matrix (CRLF, Unicode headings, headings-inside-fences, unterminated fences, nested levels, malformed bullets) **once**, so every adopter inherits that correctness instead of re-deriving it.

### 2. Prohibition + enforcement — `local/no-adhoc-markdown-parsing`

A new ESLint rule in `eslint-rules/no-adhoc-markdown-parsing.cjs` (wired in `eslint.config.mjs`, mirroring `local/no-source-grep`) flags new hand-rolled markdown-structure scanning outside the seam — fenced-code strip regexes, `split(/\r?\n/)` + heading-regex section walks, and `D-`/checkbox bullet regexes — in `src/*.cts`. Existing sites are **grandfathered** by an explicit allowlist that is burned down as each tier migrates (the same grandfathering pattern `no-source-grep` uses). New code must import the seam. This is the part that stops the game permanently: after this rule lands, a PR cannot introduce a fourth fence stripper without a reviewer-visible failure.

### 3. Decisions realization (tier T1) — typed result + fail-loud gate

The first behavioral adopter, which also resolves the two open bugs. `decisions.cts` is rewritten onto the seam, and a typed result distinguishes the states the blocking gate cares about:

```
type DecisionExtraction = {
  decisions: Decision[];
  outcome: 'parsed' | 'none-present' | 'could-not-parse';
};
```

`parseDecisions(content): Decision[]` is preserved as a thin delegate (consumers untouched); `extractDecisions(content): DecisionExtraction` is the typed entry point. `cmdDecisionCoveragePlan` (blocking) treats `could-not-parse` — content is decision-shaped (a `<decisions>` block, a `/decisions?/i` heading, `\bD-` tokens, or `unterminatedFence`) yet 0 decisions extracted — as a **WARN/fail** ("could not parse decisions — possible format mismatch") instead of a green pass (**resolves #1365**). Routing through the seam recognises the markdown-header + em-dash variants (**resolves #1364**). Recall-first by design: a false "could-not-parse" is a loud warning a human clears; a false "none-present" is the silent bypass we are deleting.

### 4. Migration tiers (epic #1372 children)

Each tier is its own issue + PR (issue-first; one concern per PR), behaviour-preserving except T1, each separately tested, each burning down the `no-adhoc-markdown-parsing` grandfather list for the files it touches.

| Tier | Scope | Risk | Notes |
|---|---|---|---|
| **T0** | Seam foundation: `markdown-sectionizer.cts` + QA-matrix tests | none | No migration, no behavior change. Foundational. |
| **T1** | `decisions.cts` + coverage gate: adopt seam, typed result, fail-loud | low–med | **Resolves #1364, #1365.** First behavioral adopter. |
| **T2** | `adr-parser.cts`: `parseSections`/`splitEntries` → seam | none | CLI-only, no in-process callers — the safe prototype; its `parseSections` is the API shape the seam generalizes. |
| **T3** | `check-command-router.cts` + `gap-checker.cts`: dedupe `stripCommentsAndFences`, designated-section walk, requirements bullets | low | Gate-adjacent; covered by existing gate tests. |
| **T4** | `roadmap-parser.cts`: collapse the 3× inline fence loop + `computeSectionEnd` | med | Heavily tested; watch milestone-section boundaries. |
| **T5** | `uat.cts` + `uat-predicate.cts`: donate the canonical stripper, migrate heading/section scans | med | `_stripFencedBlocks` becomes the seam's source in T0; T5 removes the local copy. |
| **T6** | `state.cts`: 13 inline section-collects → `collectSection` | high | Highest payoff, highest risk — load-bearing for STATE.md mutation. Surgical, full regression, last. |
| **T7** | Enforcement: `no-adhoc-markdown-parsing` ESLint rule + grandfather burn-down | low | Lands once enough tiers are migrated that the grandfather list is small; thereafter new ad-hoc parsing is blocked. |

`frontmatter.cts` stays as-is — YAML frontmatter is a different grammar with its own well-used shared parser (`extractFrontmatter`); it is out of scope.

## Backward compatibility

No user-facing or authoring change. Behaviour-preserving migrations (T2–T6) keep each parser's outputs byte-identical (verified by each parser's existing tests + added characterization tests). T1 is the only behavior change: additive decision recall + the could-not-parse WARN; the `<decisions>` block stays canonical and parses identically (block presence still takes precedence). Internal API churn is contained per-tier; public CLI contracts are unchanged.

## Consequences

**Positive:** structural correctness (fences/CRLF/levels/bullets) is solved and tested once; the silent fail-open class is eliminated for the blocking gate; the per-module regex pile stops growing *and* is prohibited from regrowing; future markdown parsers inherit correctness for free; the change models the repo's own typed-IR / no-source-grep philosophy. Retires 3–4 duplicate strippers and ~20 inline section-collects.

**Negative / risks:** a large surface migrated incrementally — mitigated by tiering (zero-risk T2 prototype first, high-risk `state.cts` last, behavior-preserving with characterization tests, the epic visible end-to-end). A new shared module is a dependency for adopters — mitigated by purity + exhaustive tests. The recall-first "could-not-parse" heuristic may occasionally warn on decision-shaped-but-empty content — acceptable and tunable; a loud false alarm beats the silent miss it replaces. The enforcement rule (T7) must grandfather precisely to avoid blocking unrelated PRs mid-migration.

## Alternatives considered

- **Point-fix each parser bug as it's reported (status quo).** Rejected — this is the game we are ending; fixes accrete instead of compounding and the same class recurs in the next parser. The maintainer's explicit directive is a solution-wide structural fix, not another file edit.
- **Consolidate the primitive but skip the enforcement rule.** Rejected — without the lint guard the divergence regrows; the next PR adds a fifth stripper and no gate objects. The prohibition is what makes the consolidation durable.
- **External markdown library (remark/markdown-it/unified).** Rejected — "no external dependencies in core" is a hard rule.
- **LLM / semantic extraction.** Rejected — `gsd-tools` is a deterministic, no-LLM, zero-dependency CLI with regression-tested pure `Result` functions; an LLM breaks the determinism/testability a CI gate requires and contradicts the repo's no-LLM precedent.
- **One big-bang PR migrating every parser.** Rejected — `state.cts` alone is load-bearing and high-risk; a single PR would be unreviewable and unmergeable. Gall's Law: the working complex system is grown from a working simple seam (T0) plus incremental, individually-verified migrations.
