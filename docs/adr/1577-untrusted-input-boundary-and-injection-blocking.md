# ADR-1577: Untrusted-input boundary + opt-in injection blocking

- **Status:** Accepted — ratified 2026-07-17 (originally Proposed 2026-06-25); see "Ratification" below
- **Issue:** [#1577](https://github.com/open-gsd/gsd-core/issues/1577)
- **Part of:** [#1573](https://github.com/open-gsd/gsd-core/issues/1573) (harden the agent layer against documented LLM failure modes)

## Ratification (2026-07-17): Proposed → Accepted

Ratified by explicit maintainer directive; the Proposed status had gone unconfirmed for 22 days since the ADR landed on 2026-06-25.

**Evidence the decision shipped:**

- Issue #1577 is closed (`state=CLOSED`, `stateReason=COMPLETED`, closed 2026-06-24T21:07:24Z) as split A of the umbrella #1573, scoped exactly to this ADR's decision.
- `hooks/gsd-read-injection-scanner.js:118` extends the scanner to `SCANNED_TOOLS = new Set(['Read', 'WebFetch', 'WebSearch'])`, wired via `hooks/hooks.json:34`'s `"Read|WebFetch|WebSearch"` matcher — closing the WebFetch/WebSearch gap named in Context.
- `hooks/gsd-read-injection-scanner.js:212` gates blocking on `cfg.security?.injection_blocking === true`, read directly via `fs.readFileSync`/`JSON.parse` (independent of `src/configuration.cts`'s key whitelist, so no drop risk).
- `security.injection_blocking` is a registered config key end-to-end: `gsd-core/bin/shared/config-schema.manifest.json:109` lists it and `gsd-core/bin/shared/config-defaults.manifest.json:103` defaults it `false`; `src/configuration.cts:47` builds `VALID_CONFIG_KEYS` from that manifest and `src/config-schema.cts:61` (`isValidConfigKey`) consults it.
- `gsd-core/references/untrusted-input-boundary.md` exists and is `@`-included by exactly the 10 ingest agents named in the Decision: `gsd-advisor-researcher`, `gsd-ai-researcher`, `gsd-assumptions-analyzer`, `gsd-doc-classifier`, `gsd-doc-synthesizer`, `gsd-domain-researcher`, `gsd-phase-researcher`, `gsd-project-researcher`, `gsd-research-synthesizer`, `gsd-ui-researcher`.
- `docs/explanation/security-model.md:150-165` documents the PostToolUse pre-filter framing and names all 10 agents; `docs/CONFIGURATION.md:910` documents `security.injection_blocking` with a direct link to ADR-1577.
- `tests/read-injection-scanner.security.test.cjs` runs `SCAN-WF-01`, `SCAN-WF-02`, `SCAN-WF-03`, and `SCAN-WS-01` against the real hook subprocess for WebFetch/WebSearch payloads and asserts real detections.
- `tests/injection-blocking-config.test.cjs` asserts `isValidConfigKey('security.injection_blocking')` is true, `isValidConfigKey('security')` is false, and `CONFIG_DEFAULTS.security.injection_blocking === false`.

**Governance state:** owning issue #1577 — CLOSED, stateReason COMPLETED, closed 2026-06-24T21:07:24Z.

## Context

The research/doc-ingest agents concatenate text returned by WebFetch / WebSearch / Read into their context with no data/instruction separation, and the `gsd-read-injection-scanner` hook only scanned the `Read` tool — leaving WebFetch/WebSearch (the largest untrusted channel) unscanned. Prompt injection via fetched content is a documented LLM failure mode (arXiv [2506.05739](https://arxiv.org/abs/2506.05739), [2507.15219](https://arxiv.org/abs/2507.15219), [2504.20472](https://arxiv.org/abs/2504.20472)).

Two mechanisms were considered for the **hook-level** control:

1. **Redaction** — strip the detected content before it reaches the model. This requires `hookSpecificOutput.updatedToolOutput`, which is unused anywhere in this repo and not verifiable in CI for a PostToolUse hook. Claiming redaction the code can't reliably perform would re-introduce exactly the overclaim this work set out to remove.
2. **Circuit-breaker** — a PostToolUse hook that, *after* the fetch has executed and the content is already in the transcript, emits `decision: "block"` to halt the agent's next step. It does **not** redact content already in context.

## Decision

- Extend the scanner to match `Read | WebFetch | WebSearch`, documented honestly as a **pattern-based pre-filter**, not a model-level guard.
- Make the **prompt-level boundary the primary control**: a shared `gsd-core/references/untrusted-input-boundary.md`, `@`-included by the 10 ingest agents, instructs treat-fetched-text-as-data, self-scan before use, task-anchoring, and a fresh random delimiter per quoted wrap. This is the layer that keeps an injection from being *followed* even while it sits in context.
- Ship hook-level blocking as an **opt-in circuit-breaker**: `security.injection_blocking` (a registered config key; default advisory). Documentation states plainly that enabling it halts further processing on a HIGH detection — it does not retroactively redact the already-fetched content. Redaction via `updatedToolOutput` is **deferred** until that field's behavior is verifiable in this runtime.

## Consequences

- **Non-breaking.** The default posture is advisory; no existing default changes. Blocking is reached only by an explicit opt-in.
- The strongest guarantee is prompt-level (data/instruction separation), which is unenforced at runtime — this is defense-in-depth (arXiv [2503.00061](https://arxiv.org/abs/2503.00061)), not a hard sandbox. A determined adaptive attacker or a weaker model may still be influenced.
- Localized docs are managed separately; only the canonical English `docs/explanation/security-model.md` is updated here.
- Follow-up: if/when `updatedToolOutput` redaction is confirmed supported, the circuit-breaker can be upgraded to an actual redactor without changing the opt-in surface.
