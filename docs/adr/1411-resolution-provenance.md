# Resolution must report provenance, not fall open silently

- **Status:** Accepted
- **Date:** 2026-06-17

## Context

A verb resolves config (or a skill set, or a planning path) from the invoking **cwd / `GSD_WORKSTREAM` / stored workstream pointer**. When that ambient context is "off" — a descendant subdirectory with no `.planning/`, or a workstream with no scoped config — resolution **silently falls open to bare defaults**, the verb **succeeds with empty output and no signal**, and a downstream subagent plans or verifies without its configured context. The gap is invisible: output is still produced.

We have shipped the **same fix-shape ≈11 times** between April and June 2026 — *anchor to the project root* / *fall back to the root config instead of defaults* / *bolt a diagnostic onto one verb*. The recurrence is concentrated, not scattered:

- **`loadConfig` is a 9-patch `try/catch` ladder** (#315, #443, #910, #1683, #2517, #2714, #3023, #3024, #3523). Each "config fell to defaults" bug adds a branch, and **the returned object is the same shape whether it found real config or bare defaults** — so every caller that cares re-detects degradation by sniffing the contents.
- The **agent-skills verb received this exact fix twice in two weeks**: #1374/#1376 (the `warnings[]` field) and then #1366 (PR #1408).
- The diagnostic half is **hand-rolled eight ways across seven files**; the I/O Module's `output()` has no notion of a "degraded" result.
- The walk-up to the project root exists **three-to-four times**; PR #1408 adds a *weaker fourth* (`resolvePlanningCwd`) because the canonical `findProjectRoot` (Project-Root Resolution Module) skips the plain single-repo-descendant case.

### The #1366 trigger

`gsd-tools query agent-skills <agent>` resolved a configured agent's `<agent_skills>` block to **empty** with no diagnostic under two invocation-context drifts: (1) invoked from a descendant subdirectory with no `.planning/`, config fell through to bare defaults → `agent_skills` was `{}`; (2) `GSD_WORKSTREAM` pointed at a workstream with no scoped config → the same fall-through. In both cases the verb exited 0 and emitted an empty block, so a planner/checker subagent planned or verified without its configured skill/rule context, invisibly.

### The generalizing precedent

**ADR-227** established that *input* validation at a trust boundary must check semantic shape, not just type, and surface coercion rather than propagate a contractually-invalid value. This ADR is the analog for the *resolution* side of the same trust boundary: looking a value up from ambient context (cwd, env, a stored pointer) is itself a trust boundary, and **silently substituting defaults when the lookup misses is the resolution-side equivalent of propagating a garbage value** — the caller cannot tell a real answer from a degraded one. CONTEXT.md's *Planning Path Projection Module* already states the rule for the SDK path-projection seam — "invalid workspace context is a validation error at this seam rather than a silent fallback" — but the CJS `loadConfig` never adopted it.

## Decision

Context resolution at a trust boundary — reading config, anchoring to a project root, resolving a workstream — **MUST report its provenance**. A resolver may fall back, but the fallback **must be a visible value, not a silent substitution**. Three sub-rules:

1. **Deterministic anchoring.** Resolve the project root through **one** walk-up module. Resolution MUST NOT depend on an arbitrary descendant cwd. The single owner is the Project-Root Resolution Module; ad-hoc walk-ups (e.g. `resolvePlanningCwd`) are retired into it.
2. **Provenance, not a bare value.** A resolver returns *what* it resolved **and** *where it came from*. Callers branch on the provenance field, never on the resolved contents, to detect degradation.
3. **Visible degradation.** A *configured* input that resolves empty MUST emit a diagnostic. "Not configured" and "configured-but-resolved-empty" MUST be distinguishable in the output contract.

Concretely, the principle binds three seams:

- **Config Loader Module** — `loadConfig` exposes a `ConfigResolution { config, source: 'workstream' | 'root' | 'global-defaults' | 'builtin-defaults', degraded: boolean }`. Introduced additively (`loadConfigResolved`) so the ~16 existing `loadConfig` call sites, SDK parity, and the generated `.cjs` are unaffected until they opt in.
- **Project-Root Resolution Module** — absorbs the nearest-`.planning/` ancestor as a first-class heuristic; `resolvePlanningCwd` and any sibling walk-up are deleted.
- **I/O Module** — a shared `Resolution<T> { value, configured, reason, warnings }` envelope; `output()` carries degradation so the eight hand-rolled `warnings[]` shapes converge on one.

A *configured* input that resolves empty **without** a reason is a CI-guarded regression (grandfather burn-down, mirroring the `no-adhoc-markdown-parsing` rule).

## Consequences

### Bug classes avoided

- **Silent context drop** — a planner/checker subagent planning or verifying without its configured skills (the #1366 / #1374 class).
- **N callers re-sniffing** — every consumer re-deriving "did this fall open?" from config contents instead of reading one field.
- **Walk-up drift** — a fourth or fifth project-root resolver diverging from the canonical one.

### Cost

- `loadConfig`'s result type grows — mitigated by the additive `loadConfigResolved`; callers migrate incrementally.
- One envelope to learn; ~18 verbs migrate onto it across phases P3–P4.

### Tradeoff

As in ADR-227, resolution may still fall back to preserve continuity — a missing workstream config should not abort the verb. The difference is that the fallback is now a **visible value plus an opt-in warning**, never a silent success. Fields where a miss is genuinely fatal may throw; that is a per-call decision, not the general rule.

## Alternatives considered

### Per-verb patching (status quo)

Rejected. The same fix-shape regenerated ≈11 times because each patch fixed one call site without changing the policy that the resolver fails open and hides which branch fired.

### Throw on a resolution miss

Rejected, for ADR-227's reason: throwing breaks pipeline continuity. A missing workstream config must not abort `query agent-skills`. Visible provenance preserves continuity *and* visibility.

### Deterministic anchoring only (no provenance)

Rejected. Fixing cwd/workstream drift removes the most common trigger but leaves callers re-sniffing contents and the diagnostic hand-rolled per verb — the bug class would keep regenerating at the next new consumer.

## Related

- **Epic:** #1411 (Resolution Provenance) · **This ADR (P0):** #1412
- **Supersedes** the tactical fix in PR #1408 (closed) — its `resolvePlanningCwd` and local `AgentSkillsReason`/`AgentSkillsDiagnostics` are redelivered through the seams above in P1–P3.
- **Builds on:** ADR-227 (input validation shape), ADR-0004 (Planning Workspace Module), ADR-0006 (Planning Path Projection Module).
- **Prior recurrences of this class:** #1374/#1376, #1683, #991, #2714, #2638, #3523, #2652, #2791, #2555, #2623, #3196.

## Amendment — 2026-06-18: P3 narrowed (the shared envelope is not a real seam)

The original P3 plan was a single `Resolution<T> { value, configured, reason, warnings }` envelope adopted by `agent-skills`, `capability-state`, and `capability-writer`. An adversarial fit-analysis showed this fails the deletion test: `configured`/`reason` are meaningless for the capability read/mutation verbs, and `capability-writer`'s `errors[]` (operation-not-applied) is load-bearing and cannot fold into `warnings[]` (advisory). The only genuinely shared seam across the three is `warnings: string[]`.

P3 is therefore narrowed to an honest convention rather than a forced generic:

- `Resolution<T> { value, configured, reason, warnings }` (`src/resolution.cts`) is the canonical shape for **config-interpreting read verbs**. `agent-skills` is the first adopter — the `value` field is added additively to its `--json` IR with the flat fields retained for back-compat; `source`/`degraded` remain config-provenance extras.
- Capability verbs keep their existing shapes, named explicitly: read = `{ runtimeConfigDir, capabilities, warnings? }`; mutation = `{ capabilities, warnings, errors }`.
- The shared contract is documented, not forced: read verbs expose `warnings[]`; mutation verbs expose `warnings[]` + `errors[]`; `configured`/`reason` appear only on config-interpreting read verbs.

Recurrence prevention does not depend on a shared envelope — it is delivered by P4's CI guard (a configured input resolving empty must carry a `reason`). (#1416)

## Amendment — 2026-07-26: corrupt is not absent

This ADR reasons exclusively about a **resolution miss** — ambient context is "off", the lookup finds nothing, resolution falls open to defaults. It is silent on the adjacent case: input that is *present but not usable*. That silence is why five engine read paths (#1879) could fold an unusable input into the very value that means "genuinely absent" without contradicting an Accepted ADR.

The failure detection differs per site and is not one mechanism — naming them precisely, because the fix differs with them:

| Site | How "not usable" is detected |
|---|---|
| `config-loader.cts` (#1880) | `SyntaxError` from `JSON.parse`, or an errno (`EACCES`) re-thrown by `platformReadSync` |
| `roadmap-parser.cts` (#1881) | errno only — the parse is regex over text and cannot throw |
| `frontmatter.cts` (#1882) | **neither** — no I/O and no throw site; an opening `---` with no closing fence is a *structural* check the function must make for itself |
| `planning-workspace.cts` / `verify.cts` (#1883) | errno from `readdirSync` (`EACCES`/`EIO`) |
| `planning-workspace.cts` (#1884) | an errno that was swallowed, then misclassified as a different condition |

### What the two governing ADRs actually permit

Read together rather than selectively, ADR-1411 and ADR-227 converge, and they do **not** license throwing as a cluster-wide answer:

- **ADR-227's Decision** requires malformed input to be *"silently coerced to the contract's safe default … It MUST NOT be propagated. Throw only if the surrounding codebase treats throws as a normal-flow signal (it usually does not …)"*, and its rejection of throwing carves out only fields where a value is *"genuinely fatal (not just malformed) … a per-field decision, not the general rule."* Malformed is explicitly on the coerce side of that line.
- **This ADR's own Decision** says: *"A resolver may fall back, but the fallback **must be a visible value, not a silent substitution**."*

The gap in the five sites is therefore **not** that they fall back. It is that they fall back **invisibly**. Continuity is correct and stays; the silence is the defect.

### The pattern — keep the fallback, make it visible

Both mechanisms below preserve every current return value. Neither changes a return type, so no caller that treats "absent" and "unusable" identically breaks.

- **In-band, where the result already carries provenance.** A read whose result is a provenance envelope names the cause in that envelope. `loadConfigResolved`'s `ConfigResolution { config, source, degraded }` is the first adopter (#1880): genuine absence keeps `degraded:false`; an unusable config sets `degraded:true` and adds a `reason`. `Resolution<T>` (`src/resolution.cts`) has **no** value for this case today — its documented vocabulary is `resolved` / `not_configured` / `configured_empty` / `configured_unresolved`, all of which describe a miss. #1880 introduces the unusable-input values and is responsible for documenting them alongside the existing four.
- **Out-of-band, where the return is a bare value that cannot carry provenance.** A read that returns a bare sentinel or a plausible default keeps returning exactly that, and emits a **deduplicated `stderr` diagnostic** naming the file and the errno. This covers `getRoadmapPhaseInternal` (#1881), `findContextMdIn` / `listMilestoneArchiveDirs` (#1883), `getMilestoneInfo` (#1881) — whose fallback is a populated `{ version: 'v1.0', name: 'milestone' }` rather than an empty sentinel, and a plausible-looking default is *more* in need of a diagnostic than an empty one, not less — and `extractFrontmatter` (#1882), which returns `{}`. The repo's existing seam is `config-loader.cts`'s `_warnedUnknownConfigKeys` guard around `process.stderr.write`.

  **This is unconditional, and that is a deliberate divergence from ADR-227.** ADR-227's Tradeoff proposes mitigating silent coercion with *"an opt-in debug log (`process.env.GSD_DEBUG`)"*; that env var has never been implemented, and an opt-in nobody sets is indistinguishable from the silence #1879 is about. This ADR's own Decision is the stronger rule and the one that governs here — degradation must be **visible**, not discoverable-on-request. The `_warnedUnknownConfigKeys` precedent is likewise unconditional. Appliers follow this ADR, not ADR-227's tradeoff, on that point.

  **Dedup key.** Key the guard on the *resolved absolute path plus the errno*, not on the message text or the bare errno. Keying too coarsely suppresses a genuine second failure in a different file; keying on prose couples the guard to wording.

**Throwing is not the cluster's answer.** It remains available only under ADR-227's genuinely-fatal carve-out, decided per call and justified in that PR — never inferred from the return shape. `withPlanningLock` (#1884) is the one site that qualifies, and it already throws; its defect is that it throws the *wrong* error after swallowing the real one.

**Detection, not propagation, where there is no exception.** #1882 takes the out-of-band mechanism above like its siblings — the difference is only in how the condition is *found*. `extractFrontmatter` takes a `string`, does no I/O, and has no throw site, so there is nothing to catch: an opening `---` with no closing fence is a structural check the function must make for itself, and having made it, it distinguishes malformed-truncated from well-formed-and-empty and emits the same deduplicated diagnostic. The check has to be written; the signal shape is not a new one.

**Wiring clause.** A `reason` that exists only inside an envelope no caller reads is not a delivered signal — it is an unreachable field. An in-band adopter MUST also expose the cause on the surface its callers actually use. `loadConfig`, the thin wrapper over `loadConfigResolved`, returns `.config` alone to roughly thirty call sites; adding `reason` to the envelope without a diagnostic on that path leaves every one of them exactly as blind as before.

**Caller audit is mandatory per applier.** Implemented as specified, neither mechanism can break a caller — no return type changes. The audit exists to prove the applier *did* implement it as specified, which is a different claim. The concrete hazard: `src/state.cts` carries a comment recording that a defensive `try/catch` around `getMilestoneInfo` was **deliberately removed** under the #2245 audit because that function "never throws". An applier who reaches for a throw here — the intuitive fix, and the one this amendment rules out — silently breaks that invariant. Each applying PR records its caller audit for that reason.

**CI ratchet.** `scripts/lint-resolution-provenance.cjs`'s `REGISTRY` currently holds one verb (`agent-skills`). The config-loader seam is not registered, so nothing today would catch a regression of #1880's contract. #1880 registers it.

**Test methodology.** Assert the typed surface, not the diagnostic prose — `CONTRIBUTING.md`'s *Prohibited: Raw Text Matching on Test Outputs* applies to `stderr` as much as to `stdout`, and `tests/roadmap-parser.test.cjs` already states the local convention for this call surface. Where the mechanism's only observable is a diagnostic, the applier exposes the typed surface (a frozen reason enum, or the dedup set) and asserts on that.

First appliers: #1880 (in-band), #1881 / #1882 / #1883 (out-of-band), #1884 (genuinely-fatal carve-out, already throwing) — epic #1879, Phase 0 = #2674.

## Amendment — 2026-09-17: per-key provenance, and one encoder at the CLI boundary

This ADR's `ConfigResolution { config, source, degraded, reason }` is **whole-config** provenance: it
says which layer supplied *the object*, and says nothing about where any individual key inside that
object came from after merging. Epic #4633 is the bill for that silence. Four `confirmed-bug` issues (all four closed as duplicates of the epic on 2026-09-11)
divide into two halves of one pipeline — resolve a value across layers, then hand it to a caller —
and both halves are implemented more than once, so a consumer that needs the producing layer either
re-derives it from contents (which this ADR's Decision 2 forbids) or discards it.

This amendment is the **design lock** for that epic (Phase 0 = #4671). It changes no code. It fixes
the owner, the result type, the family boundaries, the encoding contract and the child boundaries so
that the implementation children can be reviewed against a written contract rather than against each
other. It stays in this file rather than opening a second ADR because per-key provenance is the same
decision as Decision 2 applied one level down — a separate ADR would split ownership of one rule.

### What is actually live on `next`

Measured on `next` at `c9a5cc3e1`, in a hermetic fixture (`HOME` redirected, `.planning/config.json`
authored per case), not inferred from the issue text. The epic's own framing is corrected in two
places, and the corrections make the seam argument stronger, not weaker.

| Absorbed | Claim | Measured on `next` |
|---|---|---|
| #4071 | `~/.gsd/defaults.json` is dropped wholesale when a project config exists | **Live.** With a project config, `research:false` / `model_profile:"quality"` from the global file do not survive (`research:true`, `model_profile:"balanced"`); the file is only read by Branch D, which requires no `.planning/` at all. `_warnShadowedGlobalDefaults` (#3532) prints that this happened — the defect is announced, not fixed |
| #4090 | The evaluator discards which layer produced `worktree.baseRef` | **Live.** `resolveEffectiveBaseRef` returns `string \| null`. A user/global `head` reaches `evaluateWorktreeBaseDegrade` as the bare string `"head"`, indistinguishable from a project-local one |
| #4262 | `config-get --default` emits a JSON string, not the JSON value | **Live.** `--default '[]'` → `"[]"`, `--default 5` → `"5"`, `--default true` → `"true"`, `--default null` → `"null"` |
| #4382 | `config-get` without `--raw` double-encodes an already-JSON value | **Not reproducible as stated.** A *present* array emits a real JSON array, not a string containing JSON text. #4382's own reproduction uses `--default`, so it reports the same defect as #4262 from the consumer side. There is **one** encoding defect, on the `--default` arm only |

Two further facts the epic does not state, both of which constrain the design:

- **`--default` is already correct under `--raw`.** `--raw --default '[]'` prints `[]` and
  `--raw --default 5` prints `5`, because the raw arm emits the argv string verbatim. The disagreement
  is confined to the JSON arm, where the same argv string is JSON-encoded *as a string*. This is why
  the remedy is a parser at the boundary and not a change to `output()`.
- **`--raw` cannot round-trip today, for present values, by construction.** `output()`'s raw arm is
  `String(value)`. Measured: `[]` → the empty string, `[{path,depth}]` → `[object Object]`,
  `["codex","gemini"]` → `codex,gemini`, `200000` → `200000` (indistinguishable from `"200000"`),
  `project_code:"007"` → `007` (decodes back as the number `7`). See Decision 4.

### Decision 1 — one resolution owner, and it returns the producing layer

A new leaf module, the **Config Value Resolution Module** (`src/config-value-resolver.cts`), owns
per-key precedence for every configuration family. It is a new module rather than a function grafted
onto `config-loader.cts` because the two answer different questions with different return types —
"assemble the effective config object" versus "resolve one key and say which layer produced it" —
and because the anti-divergence rule of Decision 5 needs a boundary it can name.

```ts
type ConfigLayer =
  | 'workstream' | 'root' | 'global-defaults' | 'schema-default' | 'builtin-default'  // family A
  | 'runtime-local' | 'runtime-shared' | 'runtime-user';                               // family B

interface ConfigValueResolution {
  found: boolean;
  value: unknown;                 // `undefined` if and only if `found === false`
  layer: ConfigLayer | null;      // `null` if and only if `found === false`
  reason: ConfigReason;           // config-loader's frozen CONFIG_REASON — not a second vocabulary
  composite?: Readonly<Record<string, ConfigLayer>>;  // per-leaf layer; present only for merged keys
}

function resolveConfigValue(key: string, opts: { cwd: string; family?: ConfigFamily }): ConfigValueResolution;
```

- **Absence** is `{ found:false, value:undefined, layer:null, reason:'not_configured' }`. It is never
  represented by a falsy value, because a falsy value is a legitimate answer (below).
- **Unusable input** reuses `CONFIG_REASON.CONFIG_UNPARSEABLE` / `CONFIG_UNREADABLE` and the
  deduplicated diagnostic introduced by the 2026-07-26 amendment. A corrupt layer does not silently
  become an absent one, and the resolver introduces **no** new reason vocabulary — `CONFIG_REASON` is
  already frozen, and `tests/config-loader.test.cjs` already pins its values as the wire contract.
- **Layer-file access belongs to this boundary.** The resolver obtains each layer from
  `config-loader.cts`'s existing per-layer read (`_readConfigFile`, promoted to an internal export),
  so "who may open a config layer file" and "who may decide precedence" are the same two modules.
  Every other module becomes a *reader of a resolution*, never a participant in one.
- **Traversal is own-property only.** Dotted paths walk with `Object.prototype.hasOwnProperty.call`,
  as `cmdConfigGet` already does, so `__proto__` / `constructor` resolve as absent rather than to
  inherited values.
- **Key eligibility is preserved, not widened.** The resolver honours the existing
  `VALID_CONFIG_KEYS` / `DYNAMIC_KEY_PATTERNS` / federated-schema eligibility exactly as today. The
  epic's non-goals forbid expanding `GLOBAL_DEFAULTS_RESOLUTION_KEYS` or revisiting the `loadConfig`
  whitelist, and this amendment does neither.

`loadConfig` / `loadConfigResolved` keep their callers (the epic counts 45 direct call sites) and their shape. The owner is additive at
introduction; adoption and deletion are Decision 5's job.

### Decision 2 — two families, declared separately, with no invented precedence between them

The epic speaks of "layers" as though there were one ladder. There are two, they are read from
different files by different code for different consumers, and merging their orderings would invent
a precedence nobody decided.

| Family | Layers (highest first) | Read from |
|---|---|---|
| **A — GSD project configuration** | `workstream` → `root` → `global-defaults` → `schema-default` → `builtin-default` | `planningDir(cwd)/config.json`, `planningRoot(cwd)/config.json`, `~/.gsd/defaults.json`, federated/capability `configSchema` default, `CONFIG_DEFAULTS` |
| **B — runtime harness settings** | `runtime-local` → `runtime-shared` → `runtime-user` | `<cwd>/.claude/settings.local.json`, `<cwd>/.claude/settings.json`, `<userClaudeDir>/settings.json` |

A key belongs to **exactly one** family, declared in one table in the resolver. `worktree.baseRef` is
family B despite its dotted, GSD-looking name — the value #4090 is about never appears in
`.planning/config.json`. No ordering is declared between A and B; a caller that needs both asks
twice and composes the answer itself, visibly.

**Normalization.** `normalizeLegacyKeys` runs per layer, before precedence, exactly where
`config-loader` runs it today. Family B parses with `parseJsonc`, as `resolveEffectiveBaseRef` does.
Normalization never crosses layers and never rewrites a file — the resolver is a read path and
passes `persist:false` semantics all the way down.

**Explicitly falsy values are configured values.** `false`, `0`, `""`, `[]`, `{}` and a JSON `null`
present in a layer all resolve `found:true` with that value and that layer. Only a key *absent* from
every layer is `found:false`. This makes #4071's mechanism unrepresentable only when every key is
correctly classified into its resolution family: a bad declaration can reintroduce the failure as a
classification defect. Today's `_globalBaseCfg` uses `??` and `||` against 26 named keys, so a
global `false` or `0` survives one branch and not another, and "is this key set?" is answered by the
truthiness of its value in four different places.

**Composite values.** Some keys are objects assembled from more than one layer (`effort`,
`model_overrides`, `agent_tools`, `agent_skills`). Merge-eligibility is **declared per key** in the
resolver, not decided at a call site by whether a file happens to exist — which is precisely #4071's
mechanism, where the *existence* of any project config suppresses the whole global file. For a
declared-merge key:

- `layer` names the highest layer that contributed at least one leaf;
- `composite` maps each leaf key to the layer that produced it, at whatever depth the declaration
  says the merge is deep (`effort.agent_overrides` and `effort.routing_tier_defaults` are per-key
  deep today, per #3531 — that behaviour is preserved and becomes a declaration);
- a consumer that branches on origin reads `composite[leaf]`. It never re-derives provenance by
  re-reading a layer file, which is this ADR's Decision 2 restated for leaves.

Every other key **replaces**: the highest layer that has it wins outright.

### Decision 3 — one parser and one encoder own the CLI boundary

`cmdConfigSet` already contains the only value parser at the config CLI boundary: `true`/`false` → boolean,
`null` → JSON null, a finite `Number(val)` → number, a leading `[`/`{` → `JSON.parse` with
fall-through to string, everything else → string. It is extracted verbatim as
`parseConfigArgValue(raw: string): unknown` and shared, unchanged, with `config-get --default`.
Extracted, not copied — a second copy would be the defect this epic exists to close.

- **`null` parses to the value `null`. Unsetting is a setter action, not a parse result.** The two are
  conflated today only because `cmdConfigSet` happens to branch on `parsedValue === null` *after*
  parsing. That branch stays in the setter, where it is a documented "clear" action (#2046). The
  getter's `--default null` must emit JSON `null` and unset nothing. Any child that moves the unset
  decision into the parser has broken this contract.
- **Per-key setter policy stays in the setter.** `project_code` re-reading `val` verbatim so `"007"`
  does not collapse to `7`, and every `assertEnumValue` / range validator, are *setter* key policies.
  The shared parser is type-directed only.
- **One encoder.** `encodeConfigValue(value, { raw })` is the single emission path for every arm of
  `cmdConfigGet`: present key, root-inherited key (#2702), `--default`, schema default (#2256), and
  the masked-secret arm. Today those arms reach `output()` through two different helpers, and the
  `--default` one hands it a value of the wrong type.
- **Masking stays ahead of encoding.** `isSecretKey(kp)` → `maskSecret(value)` → encoder. The mask
  yields a string and is encoded as one; the encoder never sees the plaintext. `emitResolvedDefault`
  already established this for the schema-default arm and it becomes the rule for all of them.
- **Both consumer kinds are audited by the children, not assumed.** Structured consumers:
  `gsd-core/workflows/code-review.md` (`workflow.code_review_depth_overrides --default '[]'`),
  `ship.md` (`ship.pr_body_sections --default '[]'`), `plan-review-convergence.md`
  (`review.default_reviewers`), `pr-branch.md` (`planning.sub_repos`). Shell-string consumers:
  `src/review-lane-invocation.cts`'s `configString()`, which treats the literal four characters
  `null` as "unset" — a live contract on raw output — and the `config-get … --raw` command strings
  that `src/runtime-artifact-conversion.cts` bakes into generated runtime artifacts.

### Decision 4 — the round-trip property is asserted in JSON mode; raw output is frozen (ruled 2026-09-20)

The epic asks for `decode(encode(v)) === v` "across `--raw` / `--default` / neither". Measured, that
property **cannot hold in raw mode** while raw means `String(value)`: `[]` and `""` both print
empty, `[{…}]` prints `[object Object]`, and `5` and `"5"` are the same three bytes. The epic's
requirement is therefore split rather than silently weakened:

1. **JSON mode (no `--raw`) — the property holds for every supported type and every layer**, including
   the `--default` and schema-default arms once they route through the parser. This is the property
   test the epic asks for, and the cell it is currently red in is `--default`.
2. **Raw mode — the contract is a display and shell-interpolation contract, and it is frozen.**
   `String(value)` rendering is preserved byte-for-byte and pinned by tests. Raw makes no round-trip
   claim, including for scalars: `5` and `"5"` collide, and `"007"` can be decoded as the number `7`.

Making raw lossless — emitting compact JSON for non-scalars, say — is a **user-visible output-contract
change** to a surface that live consumers parse by hand (`configString()` above; four workflow call
sites; baked artifact command strings). It is out of scope for #4633, and needs its own issue and its
own approval. No child may change raw's non-scalar rendering "while it is in there".

**Ruled:** freeze `--raw` as the display/shell-interpolation contract described above. A lossless
`--raw` would need its own issue before any child that touches raw output is planned; none is filed.

### Decision 5 — migration census, child boundaries, and the anti-divergence guard

**Census.** Every site that reads a configuration layer file directly or re-implements precedence,
found by path-construction search over `src/`, `bin/`, `hooks/`, `scripts/` at `c9a5cc3e1`.

*Precedence implementations to delete or reduce to delegation:*

| Site | What it re-implements |
|---|---|
| `src/capability-activation.cts` `resolveConfigKey` | A full four-level walk (loadConfig result → workstream file → root file → schema default) returning `{found, value}` with **no layer**. The closest thing to the epic's owner that already exists, and the reason the owner must absorb these rather than become another walk beside them |
| `src/config.cts` `resolveFromRootConfig` + `resolveSchemaDefault` | `cmdConfigGet`'s own workstream→root→schema cascade (#2702, #2256) |
| `src/config-loader.cts` `_globalBaseCfg` (Branch D) | The 26-key `??` / `\|\|` projection of `~/.gsd/defaults.json` — #4071's site |
| `src/config.cts` `buildNewProjectConfig` | A project-creation merge of `~/.gsd/defaults.json` |
| `src/install-model-override-resolver.cts` | Install-time global+project merges (`model_overrides`, `agent_tools`, runtime/profile) |
| `src/install-effort-resolver.cts` | Install-time `effort` merge, deep per sub-field |
| `src/worktree-base-ref.cts` `resolveEffectiveBaseRef` | Family B's three-layer cascade, returning a bare `string \| null` — #4090's site |
| `src/model-resolver.cts` `projectExplicitlySetsOmit` | A workstream→root two-layer walk over `config.json` for `resolve_model_ids`, re-implementing `loadConfig`'s precedence order by hand specifically to avoid its normalization side effects |

*Single-layer readers that bypass precedence entirely* (each reads one file and therefore silently
ignores root inheritance, global defaults and schema defaults): `src/estimate-cli.cts`
(`workflow.smart_zone_tokens`), `src/gap-checker.cts` (`workflow.post_planning_gaps`),
`src/check-command-router.cts` (`readWorkflowConfig`), `src/runtime-slash.cts` (`runtime`),
`src/verify.cts` (`workflow.drift_threshold`), `src/phase.cts` (`workflow.auto_prune_state`),
`hooks/gsd-agent-isolation-guard.js` and `hooks/gsd-cursor-subagent-start.js` (both read
`~/.gsd/defaults.json` directly), `src/init.cts`'s `readConfigJsonBoolean`/`readConfigJsonValue`
(single-layer reads of the workstream-aware planning dir only — no root fallback, no schema
default). `runtime-slash.cts` records its reason for bypassing `loadConfig` —
the normalize-and-write-back side effect — and that reason expired when `persist:false` shipped
(#3648); a child adopting the owner there must delete the stale comment with the code.

*Excluded, with reasons:* `src/config.cts` setters, `src/capability-writer.cts`'s pre-write parse
check and `src/planning-snapshot.cts`'s snapshot field are **writes and probes**, not resolutions;
`hooks/gsd-config-reload.js` and `hooks/gsd-context-monitor.js` watch the file for **change
detection and display**. None of them may grow a merge or a precedence branch; the guard below still
watches them.

**Child boundaries.** Each is its own issue, opened and approved separately — this Phase-0 child's
`type: chore` authorizes none of them.

| Child | Scope | Epic criterion it closes |
|---|---|---|
| **C1** | Introduce the owner: module, typed result, family declarations, `fast-check` layer × type matrix over (absent/present) × (array, object, number, boolean, string, null) asserting **value and layer**; register the verb in `scripts/lint-resolution-provenance.cjs`'s `REGISTRY`. No call sites change | "resolver's return type carries the producing layer"; "layer × type matrix" |
| **C2** | The encoding boundary: extract `parseConfigArgValue`, share it with `--default`, route every `cmdConfigGet` arm through one encoder, freeze raw. Failing-first regressions for #4262 and #4382 | "one encoder owns `--raw` / `--default` / default output"; "encoder round-trip property"; "`/gsd-code-review` runs in a project that has set no config keys at all" |
| **C3** | Family A adoption + deletion: the six family-A precedence implementations above reduced to delegation or deleted, then the single-layer readers. Failing-first regression for #4071 | "one implementation of layer precedence; the other merge paths deleted" |
| **C4** | Family B adoption: `resolveEffectiveBaseRef` returns a resolution, `evaluateWorktreeBaseDegrade` branches on `layer` instead of on the bare value. Failing-first regression for #4090 | "consumers that branch on it read it rather than re-infer it" |
| **C5** | The ratchet: `local/no-adhoc-config-merge`, allowlist drained to empty, and a deliberately reintroduced copy demonstrated going red | "`local/no-adhoc-config-merge` runs with an empty allowlist" |

The epic's remaining criterion — a failing-first regression per absorbed issue — is carried by the
child that owns each symptom: #4262 and #4382 in C2, #4071 in C3, #4090 in C4. Each writes the test
first, watches it fail on the unfixed tree, and says so in its PR.

**The guard (`eslint-rules/no-adhoc-config-merge.cjs`).** Follows the `no-adhoc-markdown-parsing` /
`no-unconfined-path-join` pattern already in the tree: a rule plus a JSON allowlist validated by
`scripts/lib/allowlist-ratchet.cjs`, which fails on stale entries so the list can only shrink. It
flags two shapes: (a) constructing a layer-file path — `path.join(…, '.gsd', 'defaults.json')`,
`path.join(planningDir(…)|planningRoot(…), 'config.json')`, `path.join(…, '.claude', 'settings*.json')`
— outside the resolver boundary; (b) spread-merging two parsed config objects.

Two exemption kinds, kept apart in the file and not interchangeable:

- **Resolver-internal**, permanent: `src/config-value-resolver.cts` and `src/config-loader.cts` are
  the boundary and are exempt by construction.
- **Temporary migration**, each carrying its adopting child's issue number, each removed by that
  child. C5 lands only when the temporary section is empty. Write and probe sites (the exclusions
  above) are exempted by *rule shape* — they parse or stat without merging, so they never match —
  rather than by allowlist entry, so the list is not padded with entries that can never drain.

**Validation.** Hermetic fixtures with a redirected `HOME` and an authored `.planning/` tree, plus
the real published entry points (`gsd-core/bin/gsd-tools.cjs`, `bin/install.js` — the installer
already imports both install-time resolvers), never a mocked CLI. C5 additionally demonstrates the
guard **failing**: reintroduce one deleted merge, watch the rule go red, remove it again. A guard
that has never been observed red is an assumption.

### The #4588 boundary, restated

#4588 separately investigates what a current Claude Code harness actually honours when it forks a
worktree. This amendment delivers **provenance** — the evaluator will know that a `head` came from
the user/global layer. It does **not** assert what the harness does with that fact. C4 preserves
today's `isolationMode` semantics (#3659, #48) unless #4588 changes them; if #4588's finding and the
epic's expected evaluator behaviour conflict, that is resolved with the maintainer before C4 locks
an assertion, not inside C4.

### Limits of this amendment

- No runtime code, configuration behaviour or generated artifact changes here. Every symptom in
  #4071, #4090, #4262 and #4382 stays live until C2–C4 land.
- The child issues do not exist yet; C1–C5 are proposed boundaries, and each needs its own approval.
- Decision 4 freezes raw output (ruled 2026-09-20). A lossless raw mode would reverse a decision
  recorded here and needs its own issue before C2 is planned.
