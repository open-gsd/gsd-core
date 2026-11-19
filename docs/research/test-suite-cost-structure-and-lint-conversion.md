# Test-suite cost structure, and which tests can become lints

**Date:** 2026-11-18
**Trigger:** Owner review of [ADR-6315](../adr/6315-ci-redesign.md): the ADR split CI into more shards and changed nothing in the test architecture, and the first memo never asked which existing tests could be replaced by lints.
**Status:** Research input for the 2026-11-18 amendment to ADR-6315. No test was run to produce it. No code, workflow or setting was changed.
**Source labels:** **[M]** measured from a repo file or CI artifact (method stated), **[S]** static count from a script over `tests/*.test.cjs`, **[R]** repo file read (`path:line`), **[E]** estimate (method stated), **UNVERIFIED** not confirmed.

**Data files** (in `docs/research/data/`):

- `2026-11-18-test-file-classification.tsv` — every test file with its class, cost and tier membership.
- `2026-11-18-top100-test-cost.tsv` — the 100 costliest files with spawn and fixture counts.
- `2026-11-18-test-lint-duplicate-pairs.txt` — tests that repeat a check `lint:ci` already runs.

---

## 0. Summary

1. **Process-spawning tests are the cost.** Files that spawn a real process hold 89% of Linux test time and 94% of Windows-tier time [S][M]. A second, independent pass found the same: 540 files reach a spawn path and hold 91% of matched Linux time [S][M].
2. **Lint conversion is real but small in time.** 190 files are static checks over repo content. They are 16% of the files and 1.9% of Linux time. Three of them hold 126 s of the class's 133 s [S][M].
3. **The largest suites assert logic through a process they do not need.** `state`, `phase`, `roadmap`, `config`, `init` and `custom-phase-readers` hold about 2,800 CLI spawn sites between them, and the sampled assertions check JSON fields and file content [S][R].
4. **One helper is the seam.** `runGsdTools` (`tests/helpers.cjs:207`) is the adapter almost every CLI-spawning test goes through. Its own comment says it is the only place that builds the `{ success, output, error, exitCode }` shape its callers rely on [R].
5. **The CLI cannot be called in-process today.** `gsd-tools.cjs` does not export `main`, reads `process.argv`, `process.env` and `process.cwd()` directly, and writes with `fs.writeSync(1, …)` [R].

---

## 1. Where the time goes

### 1.1 By test class

Every `tests/*.test.cjs` file was put in one class by a script, then 112 files were read by hand to check it (86.6% agreement; the rules were corrected against that sample, so the figure is in-sample) [S].

| Class | Files | Test cases | Linux time share | Windows-tier time share |
|---|---|---|---|---|
| A — static assertion over repo content | 190 | 2,273 | 1.9% | 0.0% |
| B — test of a lint script or ESLint rule | 90 | 2,374 | 5.2% | 0.6% |
| C — type-shape only | 3 | 43 | 0.0% | 0.0% |
| D — in-process logic on built inputs | 418 | 12,560 | 3.8% | 5.2% |
| E — through a real process | 482 | 21,518 | 89.0% | 94.1% |
| F — mixed or unclear | 36 | 858 | 0.1% | 0.0% |

- Linux total is 7,183,116 ms from `tests/test-timings.json`. Seventy-two files have no Linux timing and count as zero [M].
- Windows total is 4,946,427 ms over the 340-file tier. 121 tier files have no win32 timing and count as zero [M].
- Class D is 418 files and 12,560 cases in 3.8% of the time. That is what an in-process test costs here.

### 1.2 By cause

Each file's whole time is assigned to the first cause that matches, in this order. This is an attribution rule, not a measurement: a file's time includes its in-process work, so each spawn row is an upper bound [E].

| Cause | Linux files | Linux share | Windows files | Windows share |
|---|---|---|---|---|
| Runs the installer (`bin/install.js`) | 79 | 26.8% | 33 | 26.2% |
| Spawns the `gsd-tools` CLI | 280 | 51.4% | 106 | 57.3% |
| Git only | 64 | 2.9% | 24 | 2.8% |
| Other subprocess (hooks, scripts, npm, bash) | 117 | 7.0% | 57 | 8.9% |
| In-process, uses fast-check | 121 | 5.3% | 13 | 2.0% |
| In-process, nothing else | 472 | 3.3% | 45 | 2.6% |
| Timing entry with no file on disk | 84 | 3.3% | 2 | 0.2% |

### 1.3 Spawn and fixture counts

- Static call sites that spawn, counted through the helpers: `gsd-tools` CLI 7,857; installer 667; git 7,238 (a `createTempGitProject` call counts as 6, because `tests/fixtures/index.cjs:16` runs init, three config calls, add and commit); other `node` 2,437; bash 802; npm 8 [S].
- Fixture builders: 3,939 calls sit inside test bodies and 1,098 in `beforeEach`. 160 sit in `before()` or module scope [S].
- Windows takes 1.98 times as long as Linux on the 278 files both tables cover [M].
- On two Windows shards of run 44424086346, installer spawns of 2 s or more averaged 2.8 s each (87 spawns, 242 s) and were 10% and 19% of the job's file time. Faster spawns are not recorded, so this is a floor [M].
- Cost per CLI spawn site, from a regression over files that only spawn the CLI: about 316 ms on Linux (n=136, R² 0.75) and 458 ms on Windows (n=35, R² 0.69). Static sites are not dynamic spawns, and the slope absorbs fixture work, so treat it as rough [E].
- A bare `node -e ""` takes a median of 64 ms and `gsd-tools generate-slug hello` 90 ms on a local Apple-silicon machine. That is not CI hardware [M].

### 1.4 The fifteen costliest files

"Boundary" means the assertion is about the process or install boundary itself. "Logic" means an in-process call to the same code would test it equally well. Rows marked * were classified from a sample of the file's assertions.

| File | Linux / Windows s | What makes it slow | Asserts |
|---|---|---|---|
| `fragment-single-edit-propagation.install` | 575 / — | Each row builds an overlay repo and installs 18 runtimes | Boundary |
| `state` * | 267 / 476 | 807 cases, 757 CLI spawn sites | Logic |
| `agent-fragments-emission.install` | 228 / — | Installer per runtime and scope in nested loops | Boundary |
| `run-tests-harness` | 199 / 120 | 227 cases spawn the test runner, which spawns `node --test` | Boundary |
| `custom-phase-readers` * | 184 / — | 201 CLI spawn sites, 115 of them in loops | Logic |
| `phase` * | 171 / 350 | 639 cases, 646 CLI spawn sites | Logic |
| `release-tarball-smoke.install` | 168 / — | One `npm pack` and global install | Boundary |
| `roadmap` * | 141 / 92 | 334 cases, 351 CLI spawn sites | Logic |
| `lint-gate-evidence-drift` | 134 / — | No spawn; cause UNVERIFIED | Logic |
| `config` * | 126 / 167 | 230 cases, 275 CLI spawn sites | Mostly logic |
| `workflow-fragments-emission.install` | 114 / — | Global install over every runtime, in loops | Boundary |
| `verification-status` | 110 / 58 | 156 CLI and about 500 git spawn sites | Logic and git state |
| `init` * | 85 / 161 | 294 cases, 240 CLI spawn sites | Logic |
| `emitted-attribution` | 78 / 5.6 | About 590 git spawn sites | Boundary |
| `portability-rule-disable-ban` | 76 / 11 | No spawn; parses the whole tree in a test | Logic (class A) |

---

## 2. What blocks in-process testing

- The dispatch hub is ready: `createHub` (`src/command-routing-hub.cts:337`) returns a synchronous `dispatch` that gives back a result and never prints or exits. Three test files call it [R][S].
- `gsd-tools.cjs` runs `main` only under `require.main === module` (`:5797`) and does not export it (`:5811-5840`) [R].
- `main` reads `process.argv.slice(2)`, `process.env` and `process.cwd()` and writes output with `fs.writeSync(1, …)` [R].
- Command handlers return nothing and print their own output. Ten of the nineteen `src/*-command-router.cts` files call `output()` [S].
- Exits: `process.exit` in `gsd-tools.cjs:294` and `src/cli-exit.cts:539/554/561`. `ExitError` (`src/cli-exit.cts:258`) is an existing throw seam [R].
- Helpers that already capture output in-process exist: `captureStdoutSyncWrites` (`src/io.cts:155`) and `withIsolatedProcessState` (`tests/helpers.cjs:1021`, used by 12 files) [R][S].
- Direct uses of process globals across the 262 files of `src/*.cts` plus `gsd-tools.cjs`: `process.exit(` 27 (including comments), `process.exitCode` 57, `process.stdout.write` 61, `process.stderr.write` 98, `process.cwd()` 31, `process.env` 141, `process.argv` 10, `new ExitError` 25 [S].
- 245 CLI-spawning test files (41.6 Linux minutes) contain no in-process call at all. 73 files already call a handler, router or the hub directly [S].
- UNVERIFIED: whether a handler-level in-process call reproduces every exit code and stderr text the spawned CLI gives. A parity suite has to prove it.

---

## 3. Which tests can become lints

### 3.1 The candidates

| Sub-class | Files | Linux time | Replacement |
|---|---|---|---|
| A1 — parity between two repo artifacts | 13 | 26.9 s | Generate one side and use the `gen-*.cjs --check` pattern, or one table-driven check |
| A2 — generated file in sync | 1 | 0.1 s | `gen-*.cjs --check` |
| A3 — structure of a config or prose file | 17 | 0.4 s | Schema check in the static lane |
| A4 — a string is or is not present in a file | 154 | 105.6 s | ESLint rule for JavaScript; one static content checker for Markdown and YAML |
| A5 — inventory or count | 5 | 0.2 s | Static lane |
| B — lint-script and rule tests | 90 | 376.8 s | Keep the detection cases; delete the cases that re-scan the real tree |
| C — type shape | 3 | 0.1 s | `tsc` already proves it |

- Three files hold 126 s of class A's 133 s: `portability-rule-disable-ban` (76 s), `emitted-provenance` (26 s) and `fold-helper-shadowing` (23 s) [M].
- 29 tests repeat a check that `lint:ci` already runs on the real tree. Examples: `eslint-rules.test.cjs:3267` lints every file under `tests/`, as `eslint .` does; `lint-gate-evidence-drift.test.cjs:328` repeats the real-tree census [R].
- Class A barely touches the OS lanes: 2 files in the Windows tier and 3 in the macOS tier. Converting it does not change Windows or macOS time [S].
- No class-A file is in any Stryker module's test list (39 module-test pairs checked through `scripts/mutation-matrix.cjs`), so deleting one cannot lower a mutation score [S].

### 3.2 What it saves

- Time: about 2% of Linux test time if all of class A and the duplicated class-B cases go [E].
- Processes: 190 fewer `node --test` child processes per Linux run [S].
- Correct tiering: a check of repo content then runs once, in the static lane, and fails in about a minute.

### 3.3 What stands in the way

- ESLint lints only `.cjs`, `.js` and `.cts` here. `@eslint/json`, `@eslint/markdown` and `eslint-plugin-yml` are not installed, so the 144 class-A4 files that check prose have no ESLint path today [R].
- [ADR-452](../adr/452-eslint-lint-harness.md) says the homegrown `scripts/lint-*.cjs` scripts are retired. 59 exist and `lint:ci` runs about 55 of them [R]. The ADR and the tree disagree.
- `CONTEXT.md:787` sanctions `// allow-test-rule` for tests whose subject is product text. [ADR-456](../adr/456-test-rigor-architecture.md) lists a permanent `allow-test-rule` as a test to delete. 113 of the 154 class-A4 files carry the exemption [R][S].

### 3.4 What must stay a test

- Anything that executes product behaviour on a built input (classes D and E).
- The detection cases of class B: a lint needs tests that it catches what it should.
- Property tests for parsers and budget limits (`RULESET.TESTS.property-based-testing`, `CONTEXT.md:805`).

---

## 4. Not measured

- Per-spawn cost of the installer on Linux: install-class timings come from Docker runs and are not in the unit-job artifacts.
- Whether c8 inflates child-process time on Linux.
- The assertion split for the rows marked * beyond the sampled lines.
- Why `lint-gate-evidence-drift` (134 s) and `portability-rule-disable-ban` (76 s) are slow.
- `eslint .` wall time alone. The `lint:ci` step took 81 s and 62 s on two runs; the `lint-tests` job took 2 min 30 s [M].
- Dynamic spawn counts. All spawn counts here are static call sites.
