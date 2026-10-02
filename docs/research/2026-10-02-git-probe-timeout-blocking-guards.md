# Internal git-probe timeout for blocking PreToolUse guards

Date: 2026-10-02. Point-in-time record for issue #5180. Sections 1-6 describe `origin/next` at 62549bf24 BEFORE the change; the final section records what was decided and shipped.
Trigger: `origin/next` Tests run 37037966537, job 110940840080 (`conformance test (windows-latest, 24, shard 3/3)`).

## 1. Claude Code hook timeout semantics (primary: https://code.claude.com/docs/en/hooks)

- Default: 600 s for `command`, `http`, `mcp_tool` hooks (30 on UserPromptSubmit/PreModelSwitch/PostModelSwitch, 10 on MessageDisplay). Unit of the `timeout` field: seconds.
- On timeout: Claude Code "cancels a `command`, `http`, or `mcp_tool` hook that reaches its `timeout`, discarding the hook's output, so on most events a timed-out hook renders no decision."
- PreToolUse: a timed-out `command`, `http`, or `mcp_tool` hook does not block the tool call; the call continues through the normal permission flow, so a stalled hook cannot be relied on as a gate (paraphrased from the hooks reference above).
- Exit 2: "Exit 2 means a blocking error... exit 2 blocks whether or not you print JSON". PreToolUse + exit 2 = "Blocks the tool call".
- "All matching hooks run in parallel."
- Consequence: a hook killed by the host and a hook that fails open on its own internal probe timeout have the SAME effect (tool call proceeds). The inner probe budget only matters for the window before the host kills the hook.

## 2. Node `spawnSync` `timeout` (primary: https://nodejs.org/api/child_process.html)

- `timeout`: "In milliseconds, the maximum amount of time the process is allowed to run." Default `undefined`.
- "When a timeout has been encountered and `killSignal` is sent, the method won't return until the process has completely exited." Default `killSignal` is `'SIGTERM'`. Result carries `error` (code `ETIMEDOUT`) and `signal` with `status: null`; hooks/lib/git-probe.js:31-57 classifies exactly this shape.
- Windows: "`'SIGKILL'`, `'SIGTERM'`, `'SIGINT'` and `'SIGQUIT'` terminate the process forcefully and abruptly". A timed-out probe is hard-killed; wall time = timeout + kill/reap latency (~460 ms extra in the failing run, section 4).
- Repo evidence that kill is direct-child only on Windows: issue #4601. git is the direct child here, so tree-kill is not an issue for the probe, but the reap cost is real.

## 3. Budgets elsewhere in gsd-core (origin/next, before the change)

| file:line | probe | timeout | on timeout |
|---|---|---|---|
| hooks/gsd-worktree-path-guard.js:31 (`SPAWNOPT`) | `git rev-parse --git-dir --abbrev-ref HEAD --show-toplevel` (cwd); `rev-parse --show-toplevel` (file dir); `rev-parse --is-inside-git-dir` (only when file dir is not a work tree). Max 3 sequential spawns; 2 on the cross-root block path | 2000 ms each | FAIL OPEN: `allow()`; outer catch uses `HOOK_ON_CRASH.ALLOW` (:19-30 comment); stderr diagnostic via hooks/lib/git-probe.js (#3911) |
| hooks/gsd-windsurf-pre-write.js:41 (`SPAWNOPT`, copy) | `rev-parse --show-toplevel` x2 + `--is-inside-git-dir` | 2000 ms each | FAIL OPEN (file header: "Fails OPEN on any error, timeout") |
| hooks/gsd-workflow-guard.js:94 | `git branch --show-current` | 2000 ms, `killSignal: 'SIGTERM'` | returns empty string (branch unknown) -> "cannot establish agent branch"; comment :88-92 cites a "5s budget for the whole hook" (STALE after #4175) |
| hooks/gsd-statusline.js:587, :675 | `git status --porcelain=v2`; state-freshness probe | 1500 ms (`GIT_STATUS_TIMEOUT_MS`, `STATE_FRESHNESS_GIT_TIMEOUT_MS`) | advisory; segment omitted |
| hooks/*.js `stdinTimeout` watchdogs | stdin read | 3000-10000 ms (windsurf-pre-write 10000) | allow() |
| hooks/lib/isolation-sentinel.js `resolveSentinelRoot` | delegates to src/worktree-safety.cts | 10 s via its default git budget | degrades to raw cwd |
| src/worktree-safety.cts:20 | all git plumbing | `DEFAULT_GIT_TIMEOUT_MS` (value 10000 ms); merge gets `DEFAULT_MERGE_TIMEOUT_MS` (10 minutes, :32). Comment: raising the shared default "would be the wrong lever" for hook-running merges, i.e. per-class budgets are the repo idiom | degrades / typed `timedOut` |
| CONTEXT.md:1078 (`DEFECT.UNBOUNDED-SUBPROCESS` -> `eslint-rules/require-subprocess-timeout.cjs`, scope `src/**`) | any spawn | "git 5-30s, npm 60s" | rule only requires a bound |
| hooks/hooks.json:22 (plugin surface) | host registration of worktree-path-guard | `"timeout": 5` (seconds) | host kill -> NOT a block. Not migrated by #4175 (section 6) |
| installer `applySettingsJsonHooks` (src/runtime-hooks-surface.cts:2472), PR #4175 body | six blocking guards | 120 s (was 5) | host kill = no block |
| tests/helpers/timeouts.cjs, QUICK class (10 s) | `runHook` for worktree-path-guard (tests/worktree-safety.test.cjs ~6556-6567) | 10000 ms | test fail |
| tests/helpers/timeouts.cjs, STAGED_HOOK_SCRIPT class (20 s) | "ONE already-staged hook script... a git-root check" | 20000 ms | test fail |
| tests/helpers/timeouts.cjs GIT / PROBE / HOOK_FANOUT classes | git plumbing / CLI probe / bash fan-out | 10000 / 15000 / 60000 ms | test fail |

Governing ADR: docs/adr/3889-process-exit-contract.md (hook fail-open instance #3838 referenced at :399). #3911 made hook crash policy explicit without changing any default (git-probe.js header). No ADR found that sets a numeric inner git-probe budget; the 2000 ms is an unexplained literal whose only stated rationale is hooks/gsd-workflow-guard.js:88-92 ("host wiring allows a 5s budget for the whole hook, so the probe gets 2s of it"), a premise #4175 invalidated.

Test helper misclassification: `runHook` in tests/worktree-safety.test.cjs says the hook is "synchronous, in-process... no subprocess or network work of its own" and uses the QUICK class (10 s). That is wrong: the hook spawns 2-3 git processes. timeouts.cjs already defines the STAGED_HOOK_SCRIPT class (20 s) for exactly "a git-root check" in one staged hook script.

## 4. Observed latency evidence

- Failing run 37037966537, job 110940840080: subtest "block output includes the offending path in reason" `not ok 3`, `duration_ms: 2460.8615`, location `tests\worktree-safety.test.cjs:6730:5`. Sibling subtests in the same describe: 170.0961 ms and 157.0905 ms; preceding in-worktree subtest 189.2027 ms. So normal ~160-190 ms vs 2460 ms: one probe hit the 2000 ms kill (+~460 ms node start/kill/reap). The true unbounded duration of that probe is UNKNOWN (killed at 2000).
- #3911 (hooks/lib/git-probe.js header): macOS CI deny cases at 2084 / 2112 / 2177 ms, empty stdout and stderr, exit 0. Same fingerprint, same 2000 ms budget.
- #3981 (dev machine, warm cache, median of 3): `node -e ''` 78 ms; worktree-path-guard 135 ms (main checkout) / 203 ms (linked worktree). Host stalls: 117 `hook_cancelled` in ~25 days, durationMs min 5.4 s, median 15.4 s, p90 54 s, max 84.3 s; 23 hit blocking gates, 8 of them worktree-path-guard; the host's own timer fired up to 79 s late.
- Same failed Windows job, other subtests: many 1.8-8.4 s, one 19.4 s: the runner was heavily loaded. PR #3285 (cited in tests/helpers/timeouts.cjs) recorded `outcome=timed_out` at 15000 ms on windows-latest for nested hook spawns (Defender scans).
- git's documentation gives no latency figure for `rev-parse` (not fetched; none cited in repo). UNKNOWN: distribution of git rev-parse wall time under Windows starvation beyond "exceeded 2000 ms".

## 5. Repo rules on raising timeouts

- Maintainer practice: raising a timeout to turn a slow test or CI job green is not accepted; each increase needs an explicit, named decision by a maintainer. Process constraint on whoever implements the change.
- TESTING-STANDARDS.md "No ad hoc timeout literals" (ESLint `local/no-adhoc-timeout-literal`) covers test call sites; hooks/*.js are not covered, but the house style is: name the class, show the margin.
- CONTEXT.md:1078: git bound norm 5-30 s (src/**). The hooks' 2000 ms is below that norm; src/worktree-safety.cts:20 explicitly prefers per-class budgets over bumping a shared default.
- No rule found that forbids raising a production fail-open guard's internal probe budget. Distinguishing facts: (a) in a test a raised timeout hides a hang; here the probe belongs to a production gate whose timeout silently DISABLES the gate (section 1), so a longer budget closes a bypass rather than masking a slowdown; (b) the "make it cheaper" lever is already used (3 spawns collapsed to 1, hooks/gsd-worktree-path-guard.js:166-175, whose comment says "Do not change any timeout value as part of this change"); the remaining levers are the budget and the wrongly-classed test helper; (c) each increase was still taken as an explicit, named decision (see the final section).

## 6. Constraints and arithmetic

T = per-probe timeout; N = max sequential probes = 3 (path-guard, windsurf-pre-write); O = node start + fs work + kill/reap, observed ~0.46 s (2460 - 2000) on starved Windows.
- Hook worst case = N*T + O.
- Test helper bound B currently 10 s (QUICK class). Need N*T + O < B. T=2000: 6.5 s OK. T=3000: 9.5 s (margin 0.5 s, too thin). T=5000: 15.5 s exceeds 10 s.
- With the helper moved to the STAGED_HOOK_SCRIPT class (20 s): T=5000 gives 15.5 s < 20 s (margin 4.5 s); the realistic cross-root block path has N=2, 10.5 s.
- Production host budget 120 s (installer path, #4175): 15.5 s is far below. Host stalls up to 84.3 s would still outlast any inner probe; the inner budget covers git slowness inside a live hook only.
- Before the change the plugin surface (hooks/hooks.json:22) registered worktree-path-guard at 5 s: with T=5000 the host could kill the hook before probes finish (no block) - the bypass #3981 described. Register at 120 in the same change, or keep N*T under 5 s there.
- Lower bound: must exceed observed starvation. Evidence only shows ">2000 ms"; 5000 ms is 2.5x the failing boundary and the bottom of the repo's 5-30 s git norm (CONTEXT.md:1078).

## DECISION (what shipped for #5180)

Per-probe budget 5000 ms (`BLOCKING_GUARD_PROBE_TIMEOUT_MS`, hooks/lib/git-probe.js) with at most 3 sequential probes (`BLOCKING_GUARD_MAX_SEQUENTIAL_PROBES`): worst case about 3 x 5000 + ~500 = ~15.5 s, below the 20 s staged-hook test class and far below the 120 s host budget.
- hooks/gsd-worktree-path-guard.js, hooks/gsd-windsurf-pre-write.js and hooks/gsd-workflow-guard.js use the shared constant. The workflow guard's stale "5s budget" comment was corrected.
- Host registrations: hooks/hooks.json blocking guards and the Kimi config.toml blocking guards moved to 120 s, matching the installer (`BLOCKING_GUARD_TIMEOUT_S`, `BLOCKING_GUARD_NAMES` in src/runtime-hooks-surface.cts). Advisory hooks keep their small budgets.
- Windsurf: no hook timeout is documented and its registration entry carries none, so its host budget is UNKNOWN. The 15 s worst case is not claimed to fit any host budget; the guard keeps its fail-open posture.
- OpenCode and Kilo plugins (.opencode/plugins/gsd-core.js, .kilo/plugins/gsd-core.js): their `runHook` reports a killed hook as exit 0 (allow), and its 8 s default was below the 15.5 s worst case. The two git-probing guards now get the shared worst case plus a margin (fallback bound used only when hooks/lib/git-probe.js is unresolvable). The pi adapter only runs the workflow guard on an event with no tool call, so it never reaches a probe and is unchanged.
- Test harness bounds that ran these guards moved to the staged-hook class (or derive their stub sleep from the shared constant): worktree-safety, windsurf-hooks-bridge, workflow-guard, hooks-crash-policy.
- Verification: tests/blocking-guard-budget-parity.test.cjs runs each guard as a real subprocess with a `child_process` recorder preloaded (tests/helpers/spawn-timeout-recorder.cjs) and asserts every git probe received the shared budget and no guard exceeded the probe count; it also checks the installer, hooks.json and Kimi registrations and the plugin bounds.
- Left unchanged: hooks/gsd-statusline.js (1500 ms, advisory).
