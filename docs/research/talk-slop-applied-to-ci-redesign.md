# "All Code Is Slop (Except Mine)" applied to the CI redesign: fact check and fit

**Date:** 2026-11-18
**Trigger:** Owner asked for the Warden research note on Lauren Tan's talk to be fact-checked against primary sources, and for a statement of where gsd-core's tests could become lints or other static gates and how to change the test architecture rather than only shard it.
**Status:** Research input for [ADR-6315](../adr/6315-ci-redesign.md) (Proposed). No code, workflow, ruleset or setting was changed. No tests were run.
**Source labels:** **[T]** the talk's own machine transcript (timestamps are the conference recording's clock), **[P]** another primary source (URL), **[R]** repo file read (`path:line` or command), **[I]** inference by the author, **UNVERIFIED** not confirmed from a primary source.

**Document under review:** `docs/research/TALK-SLOP.md` in `The-Artificer-of-Ciphers-LLC/warden-of-the-gate` (read through `gh api`; link: https://github.com/The-Artificer-of-Ciphers-LLC/warden-of-the-gate/blob/main/docs/research/TALK-SLOP.md). Its sibling `docs/research/sources/lauren-tan-slop-transcript.md` was fetched the same way and used as the talk text [T]. The transcript is machine-generated and has recognition errors ("ploy crust" for pull requests; the product is rendered "Grabbot", "Grockbot" and "Graphbot").

---

## 1. What the document is

A summary of one conference talk, written for the Warden project (an AI maintenance loop), not for gsd-core. It reports the talk's thesis, a four-layer "trust pyramid", case studies, a verification section, self-reported team numbers and a closing order of operations. It then maps nine talk ideas onto Warden components and lists verified external tools.

**Thesis, in the document's words, compressed:** trust in agent-written code is built by moving each correction down a ladder, from prose rules to executable checks to design that removes the bad choice, so that review shrinks to verification evidence.

**Techniques and rules the talk proposes (the document's list, restated):**

| ID | Technique or rule |
|---|---|
| T1 | Correction ladder: every correction becomes a deterministic check, or better design removes the problem; prose is the last resort |
| T2 | Ban APIs that need nuance to use well (the example is React `useEffect`) |
| T3 | Encode context in directory structure and forbid cross-imports by dependency analysis plus lint |
| T4 | Ban almost all code comments; replace with lint rules whose error messages say to fix the root cause |
| T5 | When adding a rule, also clean up the old instances |
| T6 | Treat the codebase as the agent's largest input ("garden"); keep it pristine |
| T7 | Runtime verification: agent-driven app use, a "feature map", reusable custom CLIs inside skills |
| T8 | Formal verification: TLA+ for user flows, Lean for selected algorithms |
| T9 | Property-based UI testing (Bombadil) |
| T10 | Review verification artifacts (video, screenshots, diagrams), not diffs |
| T11 | Budget most agent tokens for verification |
| T12 | Foundations before automation ("factory") |
| T13 | Outer loop: fuzz each release, open fix PRs, automerge them |
| T14 | A "state chart" skill that draws state machines from the user's point of view |

**Sources the document cites:** the talk (two YouTube URLs and a reading edition), the transcript, Bombadil's repository, Biome v2.6's blog post, the ESLint `no-restricted-syntax` page, dependency-cruiser's repository, and sibling Warden files (`FRAMEWORK-CORRECTIONS.md`, `FEATURES.md`, `PITFALLS.md`, `SUMMARY.md`, `STACK.md`) that were not fetched here because they describe Warden's own plan, not the talk.

---

## 2. Claim-by-claim check

Primary sources used: the talk transcript [T]; the conference reading edition https://ai.engineer/code/2026/talks/lauren-tan [P]; https://biomejs.dev/blog/biome-v2-6 [P]; https://github.com/antithesishq/bombadil (README and GitHub repository metadata via `gh api`) [P]; https://eslint.org/docs/latest/rules/no-restricted-syntax [P]; https://github.com/sverweij/dependency-cruiser [P].

| # | Claim in the document | Primary source and pointer | Verdict |
|---|---|---|---|
| 1 | Talk "All Code Is Slop (Except Mine)", Lauren Tan, SpaceXSI, AI Engineer CODE 2026 main stage, 2026-11-11 | Reading edition lists title, speaker "Principal Engineer at SpaceXSI", event, date [P]; transcript title matches [T] | CONFIRMED |
| 2 | Talk spans 1:01:02 to 1:18:36 of the livestream | Transcript's first stamp `01:01:02`, last `01:18:36` [T] | CONFIRMED |
| 3 | Channel re-upload on 2026-11-14, 17:31 long, second URL `O_zcc6Xl12g` | Not fetched (YouTube not read in this run). The transcript header names only `ZZ19zhYnDKY` [T] | UNVERIFIED |
| 4 | She shipped 3,000 PRs to production "last month" | `01:02:06` "I shipped 3,000 ... to production" [T] | CONFIRMED |
| 5 | Scoreboard row: her 3,000 PRs were "the month before" the team's 11,000 | Both figures are given as "last month" [T] `01:02:06`, `01:14:56`; reading edition does not name a month [P]. The talk gives no basis for a different month | PARTLY: the document's own text calls it both "the month before the talk" and "the month before that"; the talk says "last month" for both |
| 6 | Thesis quote: the job is to maintain or improve quality while massively increasing productivity | `01:02:35` [T] | CONFIRMED |
| 7 | Prefers "trust" to "software factory"; six months of environment work | `01:02:47` to `01:03:11` [T] | CONFIRMED |
| 8 | Four-layer pyramid: code itself (1), static checks including tests (2), verification (3), prose (4) | `01:03:27` to `01:04:20` [T]: the first two layers are "deterministic" and are given as one list: API design, architecture, refactoring, lint rules, type systems, compilers, "different kinds of testing"; then verification; then prose. The split of that list into layers 1 and 2 was shown on a slide that is not in the transcript | PARTLY: the ordering and the deterministic/prose split are confirmed; the exact layer-1 versus layer-2 assignment is inferred from audio. Note tests sit in the deterministic group with lint, not under verification |
| 9 | Garden argument: reviewing 3 colleague PRs in 2024, about 300 now; workarounds are copied "since it looks like the established pattern" | `01:04:51` to `01:06:17` [T] | CONFIRMED |
| 10 | Dune is a client framework, "Next.js for Electron" in spirit, valuable for its encoded constraints | `01:06:24` to `01:06:48` [T] | CONFIRMED |
| 11 | Dune is internal and not public; a launch tweet in Aug 2026 quoted | Not searched in this run | UNVERIFIED |
| 12 | `useEffect` banned in product code, allowed only inside Dune APIs; "categorically eliminated" | `01:06:50` to `01:07:34` [T] | CONFIRMED |
| 13 | `electron-renderer` and `electron-main` directories; cross-imports banned by a dependency graph analyzer and lint rules | `01:07:34` to `01:08:18` [T] | CONFIRMED. The talk does not name dependency-cruiser; the document offers it as the tool class |
| 14 | Imperative timers (`setTimeout`, `requestAnimationFrame`, `requestIdleCallback`) are "banned outright in Grok Bot", enforced by lint, after the design was fixed so timers were unnecessary | `01:08:46` to `01:09:44` [T] describes Cursor agents using timers and the resulting GC jank, and writing justifying comments. The ban that follows (`01:09:44`) is on "99% of comments". No ban on timers and no design fix for them is stated | PARTLY: the anecdote is accurate; the timer ban and the "three-rung story" are the document's addition, not the talk's |
| 15 | 99% of comments banned in Grok Bot | `01:09:44` to `01:09:52` [T] | CONFIRMED |
| 16 | Agents use markdown and comments to justify not doing the right thing, and over-rotate on small corrections | `01:08:20` to `01:08:46` [T] | CONFIRMED |
| 17 | Why comments fail: go stale, not read, escape hatch, "not enforceable" | `01:09:49` to `01:10:20` [T] | CONFIRMED |
| 18 | Replacement is lint rules with helpful messages telling the agent to fix the root cause | `01:10:20` to `01:10:34` [T] | CONFIRMED |
| 19 | Correction principle: every correction becomes a deterministic check or is eliminated by API design or architecture; "nothing left to review" | `01:10:34` to `01:11:01` [T] | CONFIRMED |
| 20 | Reading edition's decision order: instruction, then check, then design | Reading edition: "Before adding another instruction, ask whether the requirement can become a check" and "Before adding a check, ask whether better design can remove the invalid choice altogether" [P] | CONFIRMED (editorial wording, not in the spoken talk) |
| 21 | Review shrank to verification artifacts; runtime verification via debugging tools; feature map; custom CLIs in skills | `01:11:04` to `01:12:12` [T] | CONFIRMED |
| 22 | TLA+ for notification flows, Lean for a virtualization library, "quite a few bugs", "not a silver bullet" | `01:12:14` to `01:12:57` [T] | CONFIRMED |
| 23 | Property-based UI testing with Bombadil caught a few UI bugs | `01:12:59` to `01:13:12` [T] | CONFIRMED |
| 24 | A "state chart" skill in her plugin, transcribed "PAC potato stack" | `01:14:18` to `01:14:43` [T] | CONFIRMED (spoken); plugin name is a transcription guess |
| 25 | Press coverage spells it "Potato Stack / pstack" | No press source named or fetched | UNVERIFIED |
| 26 | A tweet from "Cindy": 70% of daily tokens go to verification; Tan says hers is similar | `01:13:15` to `01:13:46` [T]; reading edition summary repeats it [P] | CONFIRMED that the talk says it |
| 27 | The underlying tweet, dated about May 2026 | Not located by the document, and not located here | UNVERIFIED (the document says so itself) |
| 28 | "Golden age of software testing and verification" because agents cut the cost of tools that were expensive to write or maintain | `01:13:46` to `01:14:18` [T] | CONFIRMED |
| 29 | Team numbers: 11,000 PRs last month, a stable release about daily, about 227 contributors in October, reverts about 0.5% and steady, performance improved | `01:14:56` to `01:16:33` [T]; reading edition: "reported outcomes, not a controlled experiment" [P] | CONFIRMED as self-reported; not independently verifiable |
| 30 | Outer loop: on each release a Cursor project fuzzes the app, opens fix PRs, automerges them; "most product code that we land no longer really requires deep human review" | `01:17:31` to `01:18:20` [T] | CONFIRMED |
| 31 | Bombadil: property-based testing for web and terminal UIs, by Antithesis, MIT, runs locally, in CI or in Antithesis; Rust | README text and `gh api repos/antithesishq/bombadil`: license MIT, language Rust [P] | CONFIRMED |
| 32 | Bombadil announced Jan 2026 by Oskar Wickström; TypeScript spec DSL on linear temporal logic; successor to Quickstrom; Quickstrom found bugs in over half of TodoMVC apps | Bombadil's README names none of these. Repository `created_at` is 2025-12-17. The Quickstrom README links a "TodoMVC Showdown" post but states no figure. The author's site returned HTTP 403 | UNVERIFIED |
| 33 | Biome v2.6, 2026-10-15: JavaScript plugins in developer preview, `defineRule`, `biome-manifest.json`, example banning `setTimeout`/`setInterval` | Biome blog: "developer preview", `defineRule` from `@biomejs/runtime/plugin`, `biome-manifest.json`, example flags `setTimeout`, `setInterval` and `eval`; date October 15, 2026 [P] | CONFIRMED |
| 34 | ESLint `no-restricted-syntax` takes AST selectors with custom messages | ESLint docs: object form with `selector` and `message`, e.g. a `CallExpression[callee.name='setTimeout']` entry [P] | CONFIRMED |
| 35 | dependency-cruiser gives declarative import-boundary rules | README: "Validate and visualise dependencies. With your rules." [P] | CONFIRMED |
| 36 | Speaker handle `poteto` (x.com/poteto) and product spelling "Grok Bot" | The transcript says "Potato" and renders the product four ways; no handle is spoken | UNVERIFIED |
| 37 | Dune "not public" and the document's remaining Warden-internal claims (STACK.md uses Biome, file cross-references) | Warden's own files, not fetched; not about the talk | UNVERIFIED |

**Verdict count: CONFIRMED 27, PARTLY 3 (rows 5, 8, 14), CONTRADICTED 0, UNVERIFIED 7 (rows 3, 11, 25, 27, 32, 36, 37).** Rows 11, 36 and 37 were not attempted beyond the talk; rows 3, 25 and 27 depend on sources the document does not give.

### What the summary left out or changed

- The talk opens with an anecdote that a named engineer "rewrote all of Google Maps in the weekend" (`01:02:18` [T]). It is a throwaway claim, not checked here, and not used by the document. It bears on nothing in this memo.
- The talk closes with a product pitch for the speaker's own platform as the way to build the outer loop (`01:17:31` [T]). The document does not flag that the speaker sells the tooling she recommends. The numbers should be read with that in mind.
- She says the six months of effort "will take you much less time than I did" (`01:03:15` [T]). No evidence is offered; the document omits it.
- The timer-ban and design-fix story (row 14) is the document's inference and should be removed or labelled as such.

---

## 3. Application to gsd-core

Context: ADR-6315 is Proposed. The suite is 1,204 `node:test` files (ADR-6315, "The measured state"); a directory listing shows 1,205 `*.test.cjs` files in `tests/` today [R: `ls tests`, count by suffix], so the ADR's figure is one behind; this memo uses the ADR figure when quoting it.

Rules applied from `/Users/trekkie/projects/gsd-core/CLAUDE.md`: no deferral, no local `node --test`, tests are run only through `gsd-test`, no wall-clock timeouts on git or npm calls, ORTHOGONAL REVIEW before any bug-fix or feature PR.

### 3.1 The honest scope

The talk is about how to keep agent-written code good: lint rules, banned APIs, directory boundaries, comment policy and verification. It says nothing about test-runner architecture, process-per-file cost, sharding, timeouts or CI wall-clock. Its only direct bearing on the owner's two questions is its ordering principle (T1): prefer design, then static check, then verification, then prose. That ordering supports moving some checks out of the test lane and into static gates. Everything about how to restructure the runner has to come from this repository's own evidence, and below it does.

### 3.2 Technique-by-technique

| ID | Does gsd-core already do it? | Conflict with an ADR or CLAUDE.md? | What it implies |
|---|---|---|---|
| T1 | Partly. ADR-452 makes ESLint "the single enforcement point" [R: `docs/adr/452-eslint-lint-harness.md`]; ADR-6315 I8 says "Checks on code shape are ESLint rules"; `eslint-rules/` holds 36 entries including `no-source-grep`, `no-elapsed-assertion`, `no-unbounded-spawn`, `no-tautological-assert` [R: `ls eslint-rules`]. CLAUDE.md itself is rung 4 (prose) backed by hooks (rung 2). The design rung (remove the invalid choice) is the least used: CLAUDE.md's "Generative Fix Divergence" asks for a parity test between parallel surfaces, which keeps both surfaces alive; a single generated source would remove the divergence | No conflict. Mild tension only: CLAUDE.md prescribes the parity test, the talk's top rung would delete the second source | When a shared constant has two surfaces, first ask whether one can be generated from the other and checked with the existing `gen-*.cjs --check` pattern (24 `gen-*` scripts exist [R: `ls scripts`]); keep the parity test only where generation is impossible |
| T2 | Yes. ADR-452 section 4 bans `setTimeout` at program level and `.only` through `no-restricted-syntax`; rules such as `no-bare-npm-exec`, `no-adhoc-timeout-literal`, `no-unbounded-spawn` ban shapes that need nuance [R: ADR-452; `ls eslint-rules`] | None | Nothing new. ADR-6315 item 11 is the same move applied to leak shapes |
| T3 | Partly. Seam rules exist: `@typescript-eslint/no-restricted-imports` at `eslint.config.mjs:1024` and `:1048`, `scripts/lint-seam-enforcement.cjs`, `n/no-missing-require` [R: survey section 2.6, lines 242]. CLAUDE.md names single seams (Command Routing Hub, OS Shell Projection). Whether every named module seam has a rule was not checked | ADR-6315 "Considered and rejected" rejects dependency-cruiser because existing seam lints cover import boundaries [R: ADR-6315]. The talk's example is a tool class, not a requirement, so no conflict | A one-time check that each seam in the CLAUDE.md "Core Domain Modules" table has a restriction rule. Not CI-performance work |
| T4 | No, and a ban would conflict. ADR-452 keeps `eslint-disable-next-line ... -- <reason>` comments as the exemption mechanism; ADR-456 requires `// allow-test-rule: see #NNN` [R: both ADRs] | A 99% comment ban conflicts with ADR-452 consequences and ADR-456 (d). Not recommended | The valid part of T4 is that justification comments are an escape hatch. ADR-456 already treats permanent `allow-test-rule` as a deletable defect. Whether the "tracking issue required" rule is machine-enforced was not found in `eslint-rules/` by name (UNVERIFIED); if it is not, a local rule that fails a disable directive with no `#NNN` makes the ADR-456 text enforceable |
| T5 | Yes in principle: ADR-6315 I9 ("First-run findings are fixed in the PR that adds the check") and CLAUDE.md "No Deferrals". ADR-456's sweep is the same idea | I8 ("ships at `warn`, then moves to `error`") sits beside I9 and `npm run lint` runs `eslint . ... --max-warnings 0` [R: `package.json:142`], so a `warn` rule already fails CI | I8 and I9 describe two different rollouts. The talk's version (rule plus cleanup in one change) is I9. Resolve I8 against `--max-warnings 0` in the ADR; see 4.3 |
| T6 | Partly. ADR-456 (d) and CLAUDE.md "Test Cleanup" delete pass-always, source-grep and elapsed-time tests [R] | None | The garden argument is a reason to prioritise the delete sweep: a surviving bad test is a template for the next agent. Number of remaining `allow-test-rule` exemptions and bad-shape tests: not measured here |
| T7 | Partly. ADR-456 (c) requires tests to assert on typed `--json` fields, which is the reusable CLI driver idea; `qa-loop-walk` is a CI job [R: ADR-6315 item 13 files]; `advertised-command-parity.test.cjs` and `cli-surface-parity.test.cjs` exist as command-surface checks [R: `ls tests`]. The talk's targets are browser UIs; gsd-core is a CLI | None | Nothing for CI. The feature-map idea has an existing analog in `docs/INVENTORY.md` plus the parity tests |
| T8 | No | None | Does not bear on CI or tests in this repository. The closest existing practice is the clock seam and fast-check in ADR-456; forcing a TLA+ or Lean connection would be invention |
| T9 | Yes for non-UI code: ADR-456 (b) mandates `fast-check` for parsers and bijective contracts; CLAUDE.md repeats it; ADR-6315 item 12 measures property-run cost | None | Nothing. Bombadil targets web and terminal UIs and does not apply |
| T10 | No. CLAUDE.md requires two orthogonal diff reviews for every bug-fix and feature change and an acceptance-criteria checklist | Direct conflict in philosophy: T10 shrinks diff review; CLAUDE.md "ORTHOGONAL REVIEW (ABSOLUTE)" requires it | Only the owner can amend CLAUDE.md. Not recommended here: the talk's own evidence is self-reported (row 29) |
| T11 | Not applicable to CI. It concerns agent token spend | None | None |
| T12 | Yes. ADR-6315 puts the static tier and ratchets first and runs selection in shadow mode before trusting it (item 10: "Selection is therefore measured before it is trusted") | None | Nothing. The ADR already follows the order the talk argues for |
| T13 | Not in the ADR. The `bug-fixer` skill sweeps confirmed bugs through merge, but there is no release fuzzing loop | Automerge of agent PRs conflicts with CLAUDE.md "Merge Constraints" and the review gates unless it goes through the queue and every gate | ADR-6315 I7 keeps T3 (scheduled lane) report-only. No change |
| T14 | No | None | Does not bear on CI or tests |

### 3.3 Where existing tests could become lints or other static gates

This is the owner's first question. The evidence available without running anything:

- **Name-based census (heuristic only).** 151 of the 1,205 `*.test.cjs` file names match `lint|parity|drift|inventory|manifest|contract|schema` [R: `ls tests`, case-insensitive match]. Names are not content; the number is an upper-bound hint, not a count of convertible files.
- **Two examples read in full, both are static checks running as tests.**
  - `tests/context7-tool-name-parity.test.cjs` scans markdown in `agents`, `gsd-core/references`, `gsd-core/workflows`, `commands/gsd`, `skills` and `docs` and fails if any file names a context7 tool the server does not register (the tool name is in the test; it is not repeated here because this file is inside the scanned tree) (lines 25-70 [R: `codegraph node`]). It executes nothing; it is a banned-string scan of the tree. It costs one process in the 1,204-process lane and is a candidate for a `scripts/lint-*.cjs` scan in the T0 or `lint-tests` lane. ESLint cannot own it because the targets are markdown, not JavaScript; the repo already uses scan scripts for this (about 46 `node scripts/...` segments in the `lint:ci` chain [R: `package.json`, counted by splitting the string on `&`], 69 files named `scripts/lint-*` [R: `ls scripts`]).
  - `tests/enumeration-drift-guard.test.cjs` is a unit test of the pure functions of `scripts/lint-phase-enumeration-drift.cjs`, with "injected" violating lines (lines 27-50 [R]). That is the talk's "tempting fixture" idea (see Warden's step five in the document) and should stay as a test of the linter, or move to ESLint `RuleTester` if the scanner becomes a rule.
- **Three shapes, three destinations [I].**
  1. Banned-string and tree-scan tests: move to a static script or `no-restricted-syntax`; the test file is deleted in the same change under ADR-456 (d) because the check keeps running.
  2. Parity tests that assert two surfaces agree: generate one from the other and use `gen-*.cjs --check`; the parity test goes away because divergence becomes impossible (T1 design rung).
  3. Test-hygiene checks: already ESLint rules (ADR-452); nothing to move.
- **A constraint from ADR-6315.** `static-fast` must stay under 60 s median to gate the matrix (item 3 AC2). Converted scans may not fit; the fallback is the existing parallel `lint-tests` lane, which still takes them off the 1,204-file runner.
- **Not measurable from the talk.** How many tests fall in each shape, and what the conversion saves, are unmeasured. The survey says there is no recorded read-ledger of which repo files each test reads [R: survey section 2.2 and its reject row for remote-cache tools]. A census is the missing step.

### 3.4 Changing the test architecture, not only sharding

The talk offers no runner architecture. What it does support, and what this repo's own documents already support, is reducing what the runner has to do:

1. Move static-in-disguise tests out of the process-per-file lane (3.3).
2. Remove per-assertion CLI spawns by calling modules in-process. ADR-6315 item 4 AC4 already schedules this for the ten slowest files, and the survey (section 2.9) names `fragment-single-edit-propagation.install.test.cjs` at 575 s as the largest [R]. The talk's design rung is the justification: make the typed in-process surface the thing tests touch (ADR-456 (c)).
3. Keep `--test-isolation=none` rejected: tests change env, cwd and temp state, and one process loses timeout attribution [R: ADR-6315 "Considered and rejected"]. Nothing in the talk contradicts that.

---

## 4. What this changes in ADR-6315

Each amendment is checkable by reading the ADR or running the stated command.

1. **Add a static-conversion census as a new item** (Phase 3, no dependencies). Checkable: a committed data file classifies every file in `tests/*.test.cjs` as (a) tree-scan or banned-string, (b) cross-surface parity, (c) in-process unit, (d) CLI or install spawn, with the method stated; each class-(a) and class-(b) file has a child issue to convert it; decision rule: convert when the replacement fits `static-fast` (under 60 s median) or the parallel `lint-tests` lane. The census answers the owner's question with counts instead of the name heuristic in 3.3.
2. **Item 11 AC2, record the rung.** For each leak shape, record whether the response is a lint rule or a shared helper that removes the shape (open issue #4635 is the helper epic [R: survey section 1.7]). Checkable: the PR body names the choice.
3. **Resolve ADR-6315 I8 against `--max-warnings 0`.** `package.json:142` fails CI on any warning, so "ships at `warn`" cannot hold for rules in `npm run lint`. Checkable: I8 text either drops the `warn` stage or says the rule lives in a separate config block excluded from `--max-warnings 0`. This is a repo-internal inconsistency exposed while reading T5, not a claim from the talk.
4. **Exemption hygiene as an acceptance criterion** under item 11 or item 4: a rule or script fails any `allow-test-rule` or `eslint-disable` directive that has no `#NNN` reference, if ADR-456's requirement is not already machine-enforced (UNVERIFIED below). Checkable: a fixture with a bare directive fails.
5. **Nothing** for T2, T3, T7, T8, T9, T11, T12, T13, T14. T2, T3, T7 (partly), T9 and T12 are already in the ADR or the code. T8, T11 and T14 do not bear on CI or tests. T13 and T10 would need an owner change to CLAUDE.md, which this memo does not recommend.

---

## 5. UNVERIFIED

From the fact check:

- The 2026-11-14 channel upload and its URL `O_zcc6Xl12g` (row 3).
- Whether Dune is non-public and the August 2026 launch tweet (row 11).
- The "Potato Stack / pstack" press spelling (row 25).
- The original "Cindy" tweet and its date (row 27).
- Bombadil's January 2026 announcement, author, spec language, Quickstrom lineage and the TodoMVC figure (row 32).
- Speaker handle and product spelling (row 36).
- Warden-internal claims (row 37).

From the repo analysis:

- Whether every module seam in CLAUDE.md "Core Domain Modules" has a restriction rule.
- Whether ADR-456's "tracking issue required" rule for `allow-test-rule` and disable directives is machine-enforced.
- How many of the 151 keyword-matched test files are tree-scan or parity checks. Names were counted; contents were not.
- The saving from converting any test to a static gate or to in-process calls.
- The discrepancy between 1,204 (ADR-6315) and 1,205 `*.test.cjs` files in `tests/` today was not traced to a cause.
