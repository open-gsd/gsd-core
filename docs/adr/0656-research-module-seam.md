# ADR-0656: Research Module — L2-hybrid seam for cached, curated-first research

- **Status:** Accepted
- **Date:** 2026-06-03

## Context

Research in GSD was entirely prose-duplicated. Seven researcher agents each carried their own copy of the provider waterfall (Context7, Ref, Jina, Exa, Tavily, Perplexity, Brave, Firecrawl, websearch), their own confidence-tier definitions, and their own fallback policy. Every time a new provider was added or the ordering changed, all seven files drifted independently — the exact failure mode `META.RULE.brief-no-paraphrase` exists to prevent.

There was no research cache. Agents checked for an existing `RESEARCH.md` file but had no TTL, no content-addressing, and no notion of staleness. Identical queries re-fetched from live providers across phases and projects.

Package legitimacy was a pip-install `slopcheck` bolt-on. When the `slopcheck` binary was absent or crashed, every package was silently downgraded to `[ASSUMED]`, removing the legitimacy gate entirely rather than degrading gracefully.

Context7 was prompt-only: agents mentioned it in prose but there was no code-level integration, no cache, and no structured verdict returned to the orchestrator.

## Decision

Introduce an **L2-hybrid seam**: code owns cache, provider policy, legitimacy verdicts, and confidence classification; MCP owns the actual network fetch (a `.cjs` module cannot call MCP tools directly).

Three modules are introduced under `src/` compiled to `gsd-core/bin/lib/*.cjs` per ADR-457 (generated-single-source):

**Research Store** (`src/research-store.cts`): content-addressed cache keyed by `sha256(ecosystem + library + version + query + kind)`. `getResearch()` never throws — it returns `{ hit, stale }` mirroring the graphify staleness tri-state pattern. TTL is per-source: curated-doc providers get 30 days (HIGH), medium-quality sources get 7 days (MED), web/synthesis gets 1 day (LOW). Two storage tiers: curated-doc kinds write to `~/.gsd/research-cache` (cross-project reuse); web and synthesis results write to `.planning/research/.cache` (project-local, gitignored).

**Research Provider** (`src/research-provider.cts`): single source of truth for `PROVIDER_WATERFALL`. Docs waterfall: Context7 → Ref → Jina → websearch. Web waterfall: Exa → Tavily → Perplexity → Brave → websearch. Scrape: Firecrawl → Jina (Firecrawl is scrape-only, not in docs/web discovery). `planResearch()` returns cache hits plus a fetch plan for misses. `classifyConfidence()` stamps `HIGH | MEDIUM | LOW` by provider tier. Provider availability is driven by config flags and `_API_KEY` env vars; `context7`, `jina`, and `websearch` are always available as the terminal fallback.

**Package Legitimacy** (`src/package-legitimacy.cts`): registry-API verdicts via injectable adapters for npm, PyPI, and crates.io. Thresholds: `{ minAgeDays: 30, minWeeklyDownloads: 1000, requireRepo: true }`. Verdict per package: `OK | SUS | SLOP`. `slopcheck` is an optional escalate-only adapter — it can only raise a verdict, never lower it — and is not the install-or-degrade gate. Absence of `slopcheck` leaves registry-API verdicts intact rather than downgrading everything to `[ASSUMED]`.

All three modules are reachable via `gsd-tools query research-plan | research-store | package-legitimacy`.

Agents return a `RESEARCH.md` path; they never return raw fetched content. This enforces context discipline: subagent isolation, compact provider output, fetches-to-disk, cache-returns-digest.

## Consequences

**Positive:**
- Provider policy lives in one tested module. Adding or reordering a provider is a one-line change that propagates to all researcher agents.
- Content-addressed cache eliminates redundant fetches across phases and projects.
- Package legitimacy is registry-API-first and degrades gracefully; `slopcheck` enriches without gating.
- The `gsd-tools query` interface is the test surface — behavioral tests can assert typed JSON output without source-grep.

**Deferred to #657:**
- Collapsing the seven researcher agent `.md` files into generated-from-profiles agents (the prose waterfall duplication in those files is the primary `DEFECT.RESEARCH-PROVIDER-PROSE-DRIFT` site).
- The `install.js` MCP tool-mapping for tavily, ref, and jina (those land where the agents declare the tools they need).

**Known constraint:**
API context-editing primitives (`clear_tool_uses`, memory tool) are the conceptual model for context discipline, but they are not configurable through the Claude Code harness today. The current implementation achieves context discipline through subagent isolation and fetch-to-disk patterns.
