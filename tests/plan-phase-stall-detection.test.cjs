// allow-test-rule: source-text-is-the-product — see #2650
// Workflow markdown is the installed orchestration contract.

'use strict';

/**
 * #2650 — plan-phase hangs after gsd-planner writes all plans; completion never
 * reaches orchestrator.
 *
 * plan-phase.md's five planner/plan-checker Agent() spawns (standard planner,
 * chunked outline planner, chunked per-plan planner, plan-checker, and the
 * revision-loop planner respawn) previously waited for a subagent's return
 * with no time bound, no periodic check, and no config-driven threshold — the
 * only recovery path (9a/11a "Filesystem Fallback") required Agent() to have
 * already returned, so it could never fire when the call never returned
 * control at all. This mirrors the already-shipped `executor.stall_*` fix for
 * execute-phase.md (bug #3212, commit e7942c21b).
 *
 * The fix extracts the decision logic into a pure, unit-testable bash
 * function (`gsd_stall_should_recover`) embedded in the lazily-loaded
 * `gsd-core/workflows/plan-phase/steps/stall-detection-helpers.md` (kept out
 * of plan-phase.md's own measured bytes — plan-phase.md is frozen under the
 * ADR-857 Phase 6 `PRE_PHASE6` gate, `tests/phase6-capstone-conformance.test.cjs`,
 * with ~36 bytes of headroom at baseline) and exercised here via the SAME
 * extraction pattern already used by tests/worktree-cleanup.test.cjs
 * (extractCwdGuardBash) and tests/quick-branching.test.cjs
 * (extractStep25Bash) — the test runs the exact shipped bash, not a
 * hand-copied duplicate (avoids the "Generative Fix Divergence" defect
 * class).
 *
 * Seam: gsd-core/workflows/plan-phase.md,
 *       gsd-core/workflows/plan-phase/steps/stall-detection-helpers.md,
 *       src/config.cts (SCHEMA_DEFAULTS),
 *       gsd-core/bin/shared/config-schema.manifest.json, docs/CONFIGURATION.md
 */

const { describe, test, mock } = require('node:test');
const assert = require('node:assert/strict');
// Required as a MODULE OBJECT, not destructured, so `mock.method(processSeam, 'runHook', …)`
// can observe what runBashScript actually passes to the seam. tests/helpers.cjs:221-224
// documents this same pattern for runNode.
const processSeam = require('./helpers/process-seam.cjs');
const { runNode, OUTCOME } = processSeam;
const { toLegacyResult } = require('./helpers/git-fixture.cjs');
const { PROBE_TIMEOUT_MS, HOOK_FANOUT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('fast-check');
const { cleanup, readFileNormalized, readWorkflowCombined, runGsdTools } = require('./helpers.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const PLAN_PHASE_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'plan-phase.md');
const STALL_HELPERS_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'plan-phase', 'steps', 'stall-detection-helpers.md');
const CHUNKED_PLANNING_MODE_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'plan-phase', 'steps', 'chunked-planning-mode.md');
const CONFIG_SCHEMA_MANIFEST_PATH = path.join(REPO_ROOT, 'gsd-core', 'bin', 'shared', 'config-schema.manifest.json');
const CONFIG_DEFAULTS_MANIFEST_PATH = path.join(REPO_ROOT, 'gsd-core', 'bin', 'shared', 'config-defaults.manifest.json');
const CONFIGURATION_DOCS_PATH = path.join(REPO_ROOT, 'docs', 'CONFIGURATION.md');
const PT_BR_CONFIGURATION_DOCS_PATH = path.join(REPO_ROOT, 'docs', 'pt-BR', 'CONFIGURATION.md');
const ZH_CN_CONFIGURATION_DOCS_PATH = path.join(REPO_ROOT, 'docs', 'zh-CN', 'CONFIGURATION.md');
const JA_JP_CONFIGURATION_DOCS_PATH = path.join(REPO_ROOT, 'docs', 'ja-JP', 'CONFIGURATION.md');
const KO_KR_CONFIGURATION_DOCS_PATH = path.join(REPO_ROOT, 'docs', 'ko-KR', 'CONFIGURATION.md');
const ZH_CN_PLANNING_CONFIG_PATH = path.join(REPO_ROOT, 'docs', 'zh-CN', 'references', 'planning-config.md');
const SETTINGS_ADVANCED_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'settings-advanced.md');

function readPlanPhase() {
  return readFileNormalized(PLAN_PHASE_PATH);
}

// #2993 relocated plan-phase.md's chunked-planning-mode spawn sites into this
// lazily-loaded step file. Read directly rather than via the generic
// readWorkflowCombined() blob when a test needs to slice a SPECIFIC section by
// heading-to-heading boundaries: chunked-planning-mode.md is small and
// self-contained (8.5.1 immediately followed by 8.5.2, nothing else), so its
// own heading boundaries stay precise, whereas the combined multi-file blob's
// ordering (host file, then every steps/*.md sorted by filename) would put an
// unrelated step file's content between "### 8.5.2 Per-Plan Tasks" and any
// downstream anchor a slice tried to search for.
function readChunkedPlanningMode() {
  return readFileNormalized(CHUNKED_PLANNING_MODE_PATH);
}

function readStallHelpersDoc() {
  return readFileNormalized(STALL_HELPERS_PATH);
}

/**
 * Extract the ```bash fence that defines gsd_stall_should_recover (and its
 * sibling gsd_stall_watch) from the lazily-loaded stall-detection-helpers.md
 * step file. Throws with a clear message if the anchor or fence cannot be
 * found — this is what makes row 1 of the test matrix a genuine failing-first
 * regression test (pre-fix, the function does not exist anywhere in the repo).
 */
function extractStallHelpersBash() {
  const content = readStallHelpersDoc();

  const anchor = 'gsd_stall_should_recover';
  const anchorIdx = content.indexOf(anchor);
  if (anchorIdx === -1) {
    throw new Error(`extractStallHelpersBash: could not find "${anchor}" anywhere in ${STALL_HELPERS_PATH}`);
  }

  // Walk backward to the start of the fenced ```bash block containing the anchor.
  const before = content.slice(0, anchorIdx);
  const fenceOpenRe = /```bash\r?\n/g;
  let lastOpen = -1;
  let m;
  while ((m = fenceOpenRe.exec(before)) !== null) {
    lastOpen = m.index + m[0].length;
  }
  if (lastOpen === -1) {
    throw new Error(`extractStallHelpersBash: "${anchor}" is not inside a \`\`\`bash fence in ${STALL_HELPERS_PATH}`);
  }

  const after = content.slice(lastOpen);
  const closeIdx = after.indexOf('```');
  if (closeIdx === -1) {
    throw new Error('extractStallHelpersBash: unterminated ```bash fence');
  }

  const body = after.slice(0, closeIdx);
  if (!body.includes('gsd_stall_watch')) {
    throw new Error('extractStallHelpersBash: sanity check failed — extracted block does not also define gsd_stall_watch');
  }
  // readStallHelpersDoc() reads through helpers.cjs's readFileNormalized(),
  // which strips \r\n -> \n at the read boundary before any slicing above
  // runs. That guards against the repo's general CRLF-in-extracted-source
  // defect class (#1700) and is worth keeping on its own merits (a bare \n
  // regex against readFileSync content is fragile either way), but it is
  // NOT what caused the #2650 Windows CI failure: .gitattributes forces
  // `eol=lf` on this file, so a Windows checkout never receives CRLF here
  // in the first place. The real cause, confirmed by evidence rather than
  // argument: passing this file's ~73-line, quote-dense script body as a
  // single `bash -c <script>` argv element does not survive Windows argv
  // serialization (Node has no execve there; CreateProcess flattens the
  // whole argv into one command-line string, and Git Bash's MSYS layer
  // re-splits and unescapes it with its own rules — the script itself gets
  // mangled in transit, not just the boundary around it). Proven by an
  // A/B on real CI: converting only runShouldRecover() to the temp-file
  // form below took Windows from 11 failures to 4, and flipped
  // `full test (windows-latest, 22, shard 1/3)` and `shard 2/3` from fail
  // to pass — while runWatch() (no extra positional args at all, values
  // embedded directly in the script text) still failed identically to
  // before, so the trailing-args theory is ruled out: it is script size
  // and quote density, not argv-element count. `runBashScript()` below
  // (used by every call site in this file) removes the script from `-c`
  // transport entirely by writing it to a file and running it by path.
  // tests/worktree-cleanup.test.cjs's extractCwdGuardBash/runGuard stays on
  // `bash -c` and is green on Windows only because its script is small
  // enough to round-trip that transport intact.
  return body;
}

/**
 * Write `script` to a fresh temp file and run it as `bash <file> <args...>`
 * rather than `bash -c <script> <args...>` (#2650 Windows CI — see
 * extractStallHelpersBash()'s doc comment for the full evidence trail: a
 * quote-dense multi-line script does not survive Windows argv
 * serialization when passed as a `-c` argv element, regardless of how many
 * trailing positional args accompany it). Every bash-invoking call site in
 * this file routes through this one seam so a future call site cannot
 * silently reintroduce the transport bug in isolation. Cleans up the temp
 * dir in `finally` regardless of outcome.
 *
 * @param {string} script  the full bash script body (helpers + a final call)
 * @param {string[]} [args]  positional args passed to the script (become
 *   $1, $2, ... inside it) — empty when the caller embeds values directly
 *   into the script text instead (e.g. via JSON.stringify).
 * @param {object} [opts]  extra process-seam options (`{ timeoutMs, cwd, env, input,
 *   killSignal }`), merged over the defaults below. NOTE the key is `timeoutMs`, not
 *   spawnSync's `timeout` — the seam reads only its own documented options, so a stray
 *   `timeout` key is silently ignored rather than honoured.
 */
function runBashScript(script, args = [], opts = {}) {
  const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2650-sh-'));
  try {
    const scriptPath = path.join(scriptDir, 'script.sh');
    fs.writeFileSync(scriptPath, `#!/usr/bin/env bash\n${script}`, { mode: 0o755 });
    // Through the process seam, never a hand-rolled spawnSync (CONTRIBUTING.md:
    // "Anything that shells out goes through tests/helpers/process-seam.cjs"). Two
    // things that buys, both of which the raw call lacked:
    //
    //   1. HOOK_FANOUT_TIMEOUT_MS — the class norm for a bash invocation that FANS OUT
    //      to nested subprocesses. This script does exactly that: the extracted fence
    //      opens with the runtime-launcher preamble, which resolves gsd-tools.cjs and
    //      really runs two `gsd_run query config-get` lines, i.e. two Node spawns
    //      (measured 236ms vs 2ms for the fallback shape). The old hard-coded 10000ms
    //      was sized for a cheap probe and was exceeded at 10006ms on
    //      `full test (windows-latest, 24, shard 1/3)`. timeouts.cjs records the same
    //      failure mode on PR #3285: a bound sized for the wrong class, not a slow machine.
    //
    //   2. A typed `outcome`. spawnSync reports a kill as `status: null`, so an exceeded
    //      bound reached the call sites as `null !== 0` — naming neither the timeout nor
    //      the bound. OUTCOME.TIMED_OUT names itself.
    //
    // Looked up on the module object (`processSeam.runHook`) rather than destructured, so
    // a test can observe the options actually passed — same rationale as
    // tests/helpers.cjs:221-224 for runNode.
    const result = processSeam.runHook(scriptPath, args, {
      interpreter: 'bash',
      timeoutMs: HOOK_FANOUT_TIMEOUT_MS,
      ...opts,
    });
    // `status` is aliased from `exitCode` by toLegacyResult so the existing assertions in
    // this file keep reading the shape they were written against; `outcome`/`timedOut`
    // are additive, and are what make a bound failure self-describing.
    return { ...toLegacyResult(result), outcome: result.outcome, timedOut: result.timedOut };
  } finally {
    cleanup(scriptDir);
  }
}

/**
 * Run gsd_stall_should_recover with the given args inside the extracted
 * script and return its stdout (trimmed). No real sleeping happens — the
 * function is pure and synchronous.
 */
function runShouldRecover(helpersBash, elapsedSeconds, thresholdMinutes, markerFound, artifactFresh) {
  const script = `${helpersBash}\ngsd_stall_should_recover "$1" "$2" "$3" "$4"\n`;
  const result = runBashScript(script,
    [String(elapsedSeconds), String(thresholdMinutes), String(markerFound), String(artifactFresh)]);
  assert.equal(result.status, 0, `gsd_stall_should_recover exited non-zero: ${result.stderr}`);
  return result.stdout.trim();
}

describe('bug #2650 plan-phase stall detection — gsd_stall_should_recover (pure decision function)', () => {
  let helpersBash;

  test('stall-detection-helpers.md defines gsd_stall_should_recover inside a ```bash fence', () => {
    helpersBash = extractStallHelpersBash();
    assert.ok(helpersBash.length > 0);
  });

  test('boundary — one second under threshold keeps waiting (limit-1)', () => {
    const result = runShouldRecover(helpersBash, 599, 10, 'false', 'false'); // 10min = 600s
    assert.equal(result, 'waiting');
  });

  test('boundary — exactly at threshold stalls (limit)', () => {
    const result = runShouldRecover(helpersBash, 600, 10, 'false', 'false');
    assert.equal(result, 'stalled');
  });

  test('boundary — one second past threshold stalls (limit+1)', () => {
    const result = runShouldRecover(helpersBash, 601, 10, 'false', 'false');
    assert.equal(result, 'stalled');
  });

  test('marker found short-circuits regardless of elapsed time', () => {
    assert.equal(runShouldRecover(helpersBash, 0, 10, 'true', 'false'), 'marker_received');
    assert.equal(runShouldRecover(helpersBash, 99999, 10, 'true', 'false'), 'marker_received');
  });

  test('fresh artifact activity keeps waiting even past threshold (no false-fire while planner is actively writing)', () => {
    assert.equal(runShouldRecover(helpersBash, 99999, 10, 'false', 'true'), 'active');
  });

  test('default threshold (10 min) does not false-fire on a normal 1-5 minute planner run (AC3)', () => {
    // A normal run returns (marker_found=true) well before 300s (5 min).
    assert.equal(runShouldRecover(helpersBash, 300, 10, 'true', 'false'), 'marker_received');
    // And absent a marker, 5 minutes of pure silence is still "waiting", not "stalled".
    assert.equal(runShouldRecover(helpersBash, 300, 10, 'false', 'false'), 'waiting');
  });

  test('property — stalled iff elapsed seconds >= threshold minutes*60 (when no marker, no fresh activity)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 60 * 60 * 6 }),
        fc.integer({ min: 1, max: 120 }),
        (elapsedSeconds, thresholdMinutes) => {
          const result = runShouldRecover(helpersBash, elapsedSeconds, thresholdMinutes, 'false', 'false');
          const shouldStall = elapsedSeconds >= thresholdMinutes * 60;
          return shouldStall ? result === 'stalled' : result === 'waiting';
        },
      ),
      { numRuns: 25 },
    );
  });

  test('a malformed threshold_minutes value degrades to the safe default instead of crashing the watcher', (t) => {
    // A security review initially flagged this as a command-injection path
    // (bash arithmetic recursively re-evaluating a `$(cmd)`-shaped string).
    // Empirically disproven: bash's arithmetic evaluator hard-errors on such
    // an operand ("syntax error: operand expected") rather than invoking it —
    // verified directly against both macOS bash 3.2.57 and Docker bash:5; the
    // payload command never runs on either. The REAL risk this guard closes
    // is reliability, not RCE: without validation, a malformed
    // `planner.stall_threshold_minutes` config value would abort the
    // stall-watcher itself with that bash syntax error, silently defeating
    // the exact hang-recovery this issue exists to ship. Prove the function
    // degrades to a safe default instead of erroring.
    const marker = `gsd-2650-untouched-${process.pid}-${Date.now()}`;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2650-malformed-'));
    t.after(() => cleanup(tmp));
    const payload = `$(touch ${path.join(tmp, marker)})`;
    const result = runShouldRecover(helpersBash, 0, payload, 'false', 'false');
    // Must not error (proves the guard prevents the bash-abort), must not
    // have run the embedded command either way, and must fall back to the
    // safe default classification (threshold_minutes -> 10 -> elapsed 0 < 600 -> waiting).
    assert.equal(result, 'waiting');
    assert.equal(fs.existsSync(path.join(tmp, marker)), false, 'payload must not execute (also true without the guard — bash hard-errors on it instead)');
  });
});

describe('bug #2650 plan-phase stall detection — gsd_stall_watch (real execution, not just the pure classifier)', () => {
  // CORRECTION (#2650 follow-up): an earlier version of this comment claimed the
  // extracted script runs WITHOUT `gsd_run` defined, so the `|| echo "<default>"`
  // fallback in the config-get lines fires. That is false, and it is why the spawn
  // bound below was mis-sized. extractStallHelpersBash slices the ENTIRE ```bash
  // fence, which opens with the runtime-launcher preamble; that preamble finds
  // gsd-core/bin/gsd-tools.cjs from the repo root and DEFINES gsd_run, so both
  // config-get lines really spawn Node. Verified: `gsd_run defined: function`,
  // GSD_TOOLS=<repo>/gsd-core/bin/gsd-tools.cjs. The resolved values are then
  // discarded anyway — runWatch overrides both PLANNER_STALL_* vars right after the
  // helpers, and runShouldRecover passes them as arguments — so the two spawns are
  // dead cost that the bound must nonetheless accommodate. They are deliberately NOT
  // removed here: dropping them would change what the extracted script executes and
  // weaken the "the shipped fence is runnable end to end" property these tests carry.
  let helpersBash;
  let tmp;

  test('loads helpers', () => {
    helpersBash = extractStallHelpersBash();
    assert.ok(helpersBash.includes('gsd_stall_watch()'));
  });

  // Routed through the shared runBashScript() helper (#2650 Windows CI —
  // see extractStallHelpersBash()'s doc comment for the full evidence
  // trail). The call line is still built with JSON.stringify exactly as
  // before — that part was never the problem and correctly keeps Windows
  // paths and the injection-guard payload intact; only the transport of
  // the script itself changes.
  function runWatch(intervalMinutes, thresholdMinutes, dispatchTs, receiptFile, artifactGlob, markers) {
    const overrides = `PLANNER_STALL_INTERVAL_MINUTES=${intervalMinutes}\nPLANNER_STALL_THRESHOLD_MINUTES=${thresholdMinutes}\n`;
    const call = `gsd_stall_watch ${JSON.stringify(String(dispatchTs))} ${JSON.stringify(receiptFile)} ${JSON.stringify(artifactGlob)}` +
      markers.map((m) => ` ${JSON.stringify(m)}`).join('');
    const script = `${helpersBash}\n${overrides}${call}\n`;
    return runBashScript(script, []);
  }

  test('marker line present in the receipt (interval=0 so sleep is instant) -> marker_received', (t) => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2650-watch-'));
    t.after(() => cleanup(tmp));
    const receiptFile = path.join(tmp, 'receipt.md');
    fs.writeFileSync(receiptFile, 'some agent output\n## PLANNING COMPLETE\nmore text\n');
    const glob = `${tmp.replace(/\\/g, '/')}/*-PLAN.md`;
    const now = Math.floor(Date.now() / 1000);
    const result = runWatch(0, 10, now, receiptFile, glob, ['## PLANNING COMPLETE']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'marker_received');
  });

  test('no marker, no output file, dispatch far in the past, threshold=0 (via real find/date, interval=0) -> stalled', (t) => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2650-watch-'));
    t.after(() => cleanup(tmp));
    const missingOutputFile = path.join(tmp, 'never-written.txt');
    const glob = `${tmp.replace(/\\/g, '/')}/*-PLAN.md`; // the tmp dir contains no *-PLAN.md files -> no fresh activity
    const longAgo = Math.floor(Date.now() / 1000) - 999999;
    const result = runWatch(0, 0, longAgo, missingOutputFile, glob, ['## PLANNING COMPLETE']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'stalled');
  });

  test('marker absent, dispatch just now, non-zero threshold (via real find/date, interval=0) -> waiting', (t) => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2650-watch-'));
    t.after(() => cleanup(tmp));
    const missingOutputFile = path.join(tmp, 'never-written.txt');
    const glob = `${tmp.replace(/\\/g, '/')}/*-PLAN.md`;
    const now = Math.floor(Date.now() / 1000);
    const result = runWatch(0, 10, now, missingOutputFile, glob, ['## PLANNING COMPLETE']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'waiting');
  });

  test('real `find ... -mmin` correctly detects a fresh artifact -> active (CR: BSD find -newermt "@epoch" is unparseable on macOS)', (t) => {
    // Regression for a production (not test-only) defect a review surfaced:
    // the shipped freshness check used to be `find $glob -newermt "@$(( ...
    // ))" ` — GNU find's "@<epoch>" shorthand for -newermt, which the
    // BSD find(1) actually shipped on macOS does NOT understand ("Can't
    // parse date/time: @<epoch>", verified live against /usr/bin/find). With
    // the `2>/dev/null` beside it, that failed silently and permanently
    // degraded artifact_fresh to "false" on every macOS run — a real
    // plan-checker or planner actively writing plan files could still be
    // reported "stalled". Fixed to `find $glob -mmin -N` ("modified less
    // than N minutes ago"), which needs no date-string parsing and is
    // supported identically by GNU find and BSD find.
    //
    // This runs the REAL shipped gsd_stall_watch (not a hand-copied
    // find invocation — see this file's header on Generative Fix
    // Divergence), with `sleep` shadowed to a no-op bash function so the
    // test does not actually wait a real PLANNER_STALL_INTERVAL_MINUTES;
    // the `find ... -mmin` line itself still executes for real. threshold
    // is set absurdly high so "stalled" cannot fire independently — the
    // ONLY path to "active" is a correctly-working freshness check.
    // Routed through runBashScript() (#2650 Windows CI) rather than a raw
    // `bash -c` call — this test builds its own script inline (the `sleep`
    // stub isn't something runWatch() supports), so it needs the same
    // transport seam explicitly rather than inheriting it for free.
    // Windows CR: production's own glob (plan-phase.md:895 et al.,
    // `"${PHASE_DIR}"'/*-PLAN.md'`) is always forward-slash — PHASE_DIR is a
    // POSIX-style `.planning/phases/NN-slug` value, never a native Windows
    // path, and this all runs under Git Bash regardless of host OS. This
    // test previously built the glob with `path.join(tmp, '*-PLAN.md')`,
    // which on Windows yields a backslash path
    // (`C:\Users\RUNNER~1\...\*-PLAN.md`). In bash pathname expansion a
    // backslash escapes the next character, so that pattern can never
    // match anything — `find` silently returned empty and the test failed
    // with 'waiting' instead of 'active'. Confirmed as a TEST artifact, not
    // a production defect: production never constructs the glob this way.
    // Fixed by forward-slashing the tmp dir before building the glob — the
    // same `.replace(/\\/g, '/')` idiom this repo already uses elsewhere —
    // so the test matches what production actually passes, while still
    // exercising the real shipped `find` line. Do not "simplify" this back
    // to a bare `path.join`; that silently reintroduces the failure.
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2650-fresh-'));
    t.after(() => cleanup(tmp));
    fs.writeFileSync(path.join(tmp, 'x-PLAN.md'), 'freshly written\n');
    const glob = `${tmp.replace(/\\/g, '/')}/*-PLAN.md`;
    const missingOutputFile = path.join(tmp, 'never-written.txt');
    const now = Math.floor(Date.now() / 1000);
    const overrides = 'sleep() { :; }\nPLANNER_STALL_INTERVAL_MINUTES=1\nPLANNER_STALL_THRESHOLD_MINUTES=99999\n';
    const call = `gsd_stall_watch ${JSON.stringify(String(now))} ${JSON.stringify(missingOutputFile)} ${JSON.stringify(glob)}` +
      ` ${JSON.stringify('## PLANNING COMPLETE')}`;
    const script = `${helpersBash}\n${overrides}${call}\n`;
    const result = runBashScript(script, []);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'active');
  });
  // Note: this platform's real find(1) is exercised by the test above via a
  // stubbed `sleep`, not a real ~60s wait. The mtime-based transition is
  // ALSO covered deterministically at the pure-function level above
  // ("fresh artifact activity keeps waiting...") for the classification
  // logic downstream of a given artifact_fresh value.
});

describe('bug #2650 config schema — planner.stall_* keys mirror executor.stall_*', () => {
  test('config schemas register planner stall detector keys', () => {
    const { VALID_CONFIG_KEYS: cjsKeys } = require('../gsd-core/bin/lib/config-schema.cjs');
    const manifest = JSON.parse(fs.readFileSync(CONFIG_SCHEMA_MANIFEST_PATH, 'utf-8'));
    const manifestKeys = new Set(manifest.validKeys);

    for (const key of ['planner.stall_detect_interval_minutes', 'planner.stall_threshold_minutes']) {
      assert.ok(cjsKeys.has(key), `CJS VALID_CONFIG_KEYS must include ${key}`);
      assert.ok(manifestKeys.has(key), `Manifest validKeys must include ${key} (SDK sources from manifest)`);
    }
  });

  test('configuration docs describe planner stall detector defaults', () => {
    const docs = fs.readFileSync(CONFIGURATION_DOCS_PATH, 'utf-8');
    assert.match(docs, /`planner\.stall_detect_interval_minutes`\s*\|\s*number\s*\|\s*`5`/);
    assert.match(docs, /`planner\.stall_threshold_minutes`\s*\|\s*number\s*\|\s*`10`/);
  });

  test('config-get returns schema defaults for planner stall detector keys', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2650-'));
    t.after(() => cleanup(tmp));
    fs.mkdirSync(path.join(tmp, '.planning'));
    fs.writeFileSync(path.join(tmp, '.planning/config.json'), '{}\n');

    const toolsPath = path.join(REPO_ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');
    const interval = toLegacyResult(runNode([toolsPath, 'config-get', 'planner.stall_detect_interval_minutes', '--raw'], { cwd: tmp, timeoutMs: PROBE_TIMEOUT_MS }));
    const threshold = toLegacyResult(runNode([toolsPath, 'config-get', 'planner.stall_threshold_minutes', '--raw'], { cwd: tmp, timeoutMs: PROBE_TIMEOUT_MS }));

    assert.equal(interval.status, 0, interval.stderr);
    assert.equal(interval.stdout.trim(), '5');
    assert.equal(threshold.status, 0, threshold.stderr);
    assert.equal(threshold.stdout.trim(), '10');
  });
});

describe('enhancement #4570 config contract — planner stall detection has a typed default-on opt-out', () => {
  function makeProject(t, config = {}) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4570-config-'));
    t.after(() => cleanup(tmp));
    fs.mkdirSync(path.join(tmp, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.planning', 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
    return tmp;
  }

  test('central schema and canonical defaults manifest register planner.stall_detection_enabled=true', () => {
    const schema = JSON.parse(fs.readFileSync(CONFIG_SCHEMA_MANIFEST_PATH, 'utf8'));
    const defaults = JSON.parse(fs.readFileSync(CONFIG_DEFAULTS_MANIFEST_PATH, 'utf8'));
    assert.ok(schema.validKeys.includes('planner.stall_detection_enabled'));
    assert.equal(defaults.planner?.stall_detection_enabled, true);
    assert.equal(schema.validKeys.includes('executor.stall_detection_enabled'), false,
      'the planner opt-out must not introduce an executor sibling outside approved scope');
  });

  test('config-get defaults absent values to true; config-set false round-trips as boolean false', (t) => {
    const tmp = makeProject(t);
    const env = { HOME: tmp, USERPROFILE: tmp };

    const absent = runGsdTools(['config-get', 'planner.stall_detection_enabled', '--raw'], tmp, env);
    assert.equal(absent.success, true, absent.error);
    assert.equal(absent.output, 'true');

    const noConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4570-no-config-'));
    t.after(() => cleanup(noConfig));
    const absentFile = runGsdTools(
      ['config-get', 'planner.stall_detection_enabled', '--raw'],
      noConfig,
      { HOME: noConfig, USERPROFILE: noConfig },
    );
    assert.equal(absentFile.success, true, absentFile.error);
    assert.equal(absentFile.output, 'true');

    const set = runGsdTools(['config-set', 'planner.stall_detection_enabled', 'false'], tmp, env);
    assert.equal(set.success, true, set.error);
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, '.planning', 'config.json'), 'utf8'));
    assert.equal(onDisk.planner.stall_detection_enabled, false);
    assert.equal(typeof onDisk.planner.stall_detection_enabled, 'boolean');

    const roundTrip = runGsdTools(['config-get', 'planner.stall_detection_enabled', '--raw'], tmp, env);
    assert.equal(roundTrip.success, true, roundTrip.error);
    assert.equal(roundTrip.output, 'false');
  });

  test('property: every non-boolean CLI value is rejected without modifying config', (t) => {
    const tmp = makeProject(t, { planner: { stall_detection_enabled: true }, sentinel: 'preserve' });
    const configPath = path.join(tmp, '.planning', 'config.json');
    const before = fs.readFileSync(configPath, 'utf8');
    const printable = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789[]{}._- ';
    const invalidValue = fc.array(fc.constantFrom(...printable), { minLength: 1, maxLength: 16 })
      .map((chars) => chars.join(''))
      .filter((value) => !['true', 'false', 'null'].includes(value));

    fc.assert(
      fc.property(invalidValue, (value) => {
        const result = runGsdTools(
          ['config-set', 'planner.stall_detection_enabled', value],
          tmp,
          { HOME: tmp, USERPROFILE: tmp },
        );
        return result.success === false && fs.readFileSync(configPath, 'utf8') === before;
      }),
      { numRuns: 20 },
    );
  });

  test('hand-edited non-booleans fail safely to true on both config-get and Config Loader reads', (t) => {
    const tmp = makeProject(t, { planner: { stall_detection_enabled: 'false' } });
    const result = runGsdTools(
      ['config-get', 'planner.stall_detection_enabled', '--raw'],
      tmp,
      { HOME: tmp, USERPROFILE: tmp },
    );
    assert.equal(result.success, true, result.error);
    assert.equal(result.output, 'true', 'a string "false" must not disable the watchdog');

    const { loadConfig } = require('../gsd-core/bin/lib/config-loader.cjs');
    assert.equal(loadConfig(tmp).planner_stall_detection_enabled, true);
  });

  test('manifest skew cannot make a non-boolean planner setting disable detection', () => {
    const { resolvePlannerStallDetectionEnabled } = require('../gsd-core/bin/lib/config-loader.cjs');
    for (const value of [undefined, null, 'false', 0, {}]) {
      assert.equal(resolvePlannerStallDetectionEnabled(value), true);
    }
  });

  test('root, GSD_PROJECT, and workstream reads retain canonical scope precedence', (t) => {
    const tmp = makeProject(t, { planner: { stall_detection_enabled: false } });
    const projectDir = path.join(tmp, '.planning', 'product-a');
    const workstreamDir = path.join(tmp, '.planning', 'workstreams', 'alpha');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(workstreamDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'config.json'), '{"planner":{"stall_detection_enabled":true}}\n');
    fs.writeFileSync(path.join(workstreamDir, 'config.json'), '{"planner":{"stall_detection_enabled":true}}\n');
    const home = { HOME: tmp, USERPROFILE: tmp };

    assert.equal(runGsdTools(['config-get', 'planner.stall_detection_enabled', '--raw'], tmp, home).output, 'false');
    assert.equal(runGsdTools(
      ['config-get', 'planner.stall_detection_enabled', '--raw'], tmp,
      { ...home, GSD_PROJECT: 'product-a' },
    ).output, 'true');
    assert.equal(runGsdTools(
      ['config-get', 'planner.stall_detection_enabled', '--raw'], tmp,
      { ...home, GSD_WORKSTREAM: 'alpha' },
    ).output, 'true');

    const { loadConfig } = require('../gsd-core/bin/lib/config-loader.cjs');
    assert.equal(loadConfig(tmp).planner_stall_detection_enabled, false);
    assert.equal(loadConfig(tmp, { workstream: 'alpha' }).planner_stall_detection_enabled, true);

    fs.writeFileSync(path.join(workstreamDir, 'config.json'), '{"planner":{}}\n');
    assert.equal(runGsdTools(
      ['config-get', 'planner.stall_detection_enabled', '--raw'], tmp,
      { ...home, GSD_WORKSTREAM: 'alpha' },
    ).output, 'false', 'an omitted workstream value must inherit the root value');
    assert.equal(loadConfig(tmp, { workstream: 'alpha' }).planner_stall_detection_enabled, false);
  });

  test('English and enumerating localized docs state default, CLI opt-out, effect, and recovery loss', () => {
    for (const docsPath of [CONFIGURATION_DOCS_PATH, PT_BR_CONFIGURATION_DOCS_PATH, ZH_CN_CONFIGURATION_DOCS_PATH, JA_JP_CONFIGURATION_DOCS_PATH, KO_KR_CONFIGURATION_DOCS_PATH]) {
      const docs = fs.readFileSync(docsPath, 'utf8');
      assert.match(docs, /`planner\.stall_detection_enabled`\s*\|\s*boolean\s*\|\s*`true`/);
      assert.match(docs, /config-set planner\.stall_detection_enabled false/);
      assert.match(docs, /runtime-native|nativa do runtime|运行时原生|ランタイムネイティブ|런타임 네이티브/i);
      assert.match(docs, /bounded recovery|recupera[cç][aã]o limitada|有界恢复|有界な復旧|제한된 복구/i);
    }
    assert.match(fs.readFileSync(ZH_CN_PLANNING_CONFIG_PATH, 'utf8'), /planner\.stall_detection_enabled/);
  });

  test('advanced settings warns about recovery loss before offering to persist false', () => {
    const settings = fs.readFileSync(SETTINGS_ADVANCED_PATH, 'utf8');
    assert.match(settings, /planner\.stall_detection_enabled/);
    assert.match(settings, /default:\s*`true`/);
    assert.match(settings, /bounded automatic recovery[\s\S]{0,500}false/i);
    assert.match(settings, /config-set planner\.stall_detection_enabled false/);
  });
});

describe('bug #2650 plan-phase — all five planner/plan-checker spawns dispatch in the background with bounded stall surveillance', () => {
  let workflow;

  test('loads', () => {
    workflow = readPlanPhase();
    assert.ok(workflow.length > 0);
  });

  test('plan-phase.md points at the lazily-loaded stall-detection-helpers.md step file (step 7.99)', () => {
    assert.match(workflow, /gsd-core\/workflows\/plan-phase\/steps\/stall-detection-helpers\.md/);
  });

  test('stall-detection-helpers.md resolves PLANNER_STALL_INTERVAL_MINUTES / PLANNER_STALL_THRESHOLD_MINUTES from config', () => {
    const helpersDoc = readStallHelpersDoc();
    assert.match(helpersDoc, /PLANNER_STALL_DETECTION_ENABLED=.*planner\.stall_detection_enabled/);
    assert.match(helpersDoc, /PLANNER_STALL_INTERVAL_MINUTES=.*planner\.stall_detect_interval_minutes/);
    assert.match(helpersDoc, /PLANNER_STALL_THRESHOLD_MINUTES=.*planner\.stall_threshold_minutes/);
  });

  test('invalid or absent toggle values normalize to default-on; only boolean false disables', (t) => {
    const helpersBash = extractStallHelpersBash();
    for (const [stored, expected] of [[undefined, 'true'], [true, 'true'], [false, 'false'], ['false', 'true'], [0, 'true'], [null, 'true']]) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4570-resolve-'));
      t.after(() => cleanup(tmp));
      fs.mkdirSync(path.join(tmp, '.planning'), { recursive: true });
      const config = stored === undefined ? {} : { planner: { stall_detection_enabled: stored } };
      fs.writeFileSync(path.join(tmp, '.planning', 'config.json'), `${JSON.stringify(config)}\n`);
      const result = runBashScript(
        `${helpersBash}\nprintf '%s\\n' "$PLANNER_STALL_DETECTION_ENABLED"\n`,
        [],
        {
          cwd: tmp,
          env: { ...process.env, HOME: tmp, USERPROFILE: tmp, RUNTIME_DIR: REPO_ROOT, GSD_PROJECT: '', GSD_WORKSTREAM: '' },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), expected, `stored ${JSON.stringify(stored)} resolved incorrectly`);
    }
  });

  test('standard planner spawn (step 8) dispatches with run_in_background=true and calls gsd_stall_watch', () => {
    const idx = workflow.indexOf('## 8. Spawn gsd-planner Agent');
    assert.notEqual(idx, -1);
    // #2993 moved "## 8.5. Chunked Planning Mode" itself out of plan-phase.md
    // (now a <!-- gsd:section --> pointer to steps/chunked-planning-mode.md,
    // asserted separately below) — bound this slice at the next heading that
    // still actually exists in plan-phase.md instead.
    const nextSectionIdx = workflow.indexOf('## 9. Handle Planner Return', idx);
    const section = workflow.slice(idx, nextSectionIdx === -1 ? undefined : nextSectionIdx);
    assert.match(section, /run_in_background\s*=\s*true/, 'standard planner spawn must set run_in_background=true');
    assert.match(section, /gsd_stall_watch/, 'standard planner spawn must invoke the bounded stall watcher');
    assert.match(section, /gsd_stall_watch\s+"\$TS"\s+"\{receipt\}"/, 'standard planner spawn must bind {receipt} (#5182) into the stall watcher call, not a dead bash variable');
  });

  test('plan-phase.md points at the lazily-loaded chunked-planning-mode.md step file (8.5, #2993)', () => {
    // #2993 (epic #1671 Phase 6.2, unrelated to #2650) extracted the whole
    // "Chunked Planning Mode" section into gsd-core/workflows/plan-phase/steps/
    // chunked-planning-mode.md, leaving a <!-- gsd:section --> pointer behind.
    // The two stall-watch spawn sites that used to live inline (8.5.1 outline,
    // 8.5.2 per-plan) moved with it — asserted directly against that file below.
    assert.match(workflow, /gsd-core\/workflows\/plan-phase\/steps\/chunked-planning-mode\.md/);
  });

  test('chunked outline spawn (8.5.1) dispatches with run_in_background=true and calls gsd_stall_watch', () => {
    // Lives in the extracted steps/chunked-planning-mode.md since #2993, not
    // in plan-phase.md itself — read that file directly (see
    // readChunkedPlanningMode()'s doc comment for why not the generic
    // combined-blob reader).
    const chunkedDoc = readChunkedPlanningMode();
    const idx = chunkedDoc.indexOf('### 8.5.1 Outline Phase');
    assert.notEqual(idx, -1);
    const nextSectionIdx = chunkedDoc.indexOf('### 8.5.2 Per-Plan Tasks', idx);
    const section = chunkedDoc.slice(idx, nextSectionIdx === -1 ? undefined : nextSectionIdx);
    assert.match(section, /run_in_background\s*=\s*true/, 'chunked outline spawn must set run_in_background=true');
    assert.match(section, /gsd_stall_watch/, 'chunked outline spawn must invoke the bounded stall watcher');
    assert.match(section, /gsd_stall_watch\s+"\$TS"\s+"\{receipt\}"/, 'chunked outline spawn must bind {receipt} (#5182) into the stall watcher call, not a dead bash variable');
  });

  test('chunked per-plan spawn (8.5.2) dispatches with run_in_background=true and calls gsd_stall_watch', () => {
    // Same relocation as the outline spawn above (#2993) — read
    // steps/chunked-planning-mode.md directly. 8.5.2 is the LAST section in
    // that file, so an unbounded slice to EOF is precise here (unlike slicing
    // the generic multi-file combined blob, which would run on into whatever
    // step file sorts next after this one).
    const chunkedDoc = readChunkedPlanningMode();
    const idx = chunkedDoc.indexOf('### 8.5.2 Per-Plan Tasks');
    assert.notEqual(idx, -1);
    const section = chunkedDoc.slice(idx);
    assert.match(section, /run_in_background\s*=\s*true/, 'chunked per-plan spawn must set run_in_background=true');
    assert.match(section, /gsd_stall_watch/, 'chunked per-plan spawn must invoke the bounded stall watcher');
    assert.match(section, /gsd_stall_watch\s+"\$TS"\s+"\{receipt\}"/, 'chunked per-plan spawn must bind {receipt} (#5182) into the stall watcher call, not a dead bash variable');
  });

  test('plan-checker spawn (step 10) dispatches with run_in_background=true and calls gsd_stall_watch', () => {
    const idx = workflow.indexOf('## 10. Spawn gsd-plan-checker Agent');
    assert.notEqual(idx, -1);
    const nextSectionIdx = workflow.indexOf('## 11. Handle Checker Return', idx);
    const section = workflow.slice(idx, nextSectionIdx === -1 ? undefined : nextSectionIdx);
    assert.match(section, /run_in_background\s*=\s*true/, 'plan-checker spawn must set run_in_background=true');
    assert.match(section, /gsd_stall_watch/, 'plan-checker spawn must invoke the bounded stall watcher');
    assert.match(section, /gsd_stall_watch\s+"\$TS"\s+"\{receipt\}"/, 'plan-checker spawn must bind {receipt} (#5182) into the stall watcher call — this is the ONLY watch-visible completion signal on a clean PASS, since a passing checker touches no *-PLAN.md files');
  });

  test('revision-loop planner respawn (step 12) dispatches with run_in_background=true and calls gsd_stall_watch', () => {
    const idx = workflow.indexOf('## 12. Revision Loop');
    assert.notEqual(idx, -1);
    const nextSectionIdx = workflow.indexOf('## 12.5. Plan Bounce', idx);
    const section = workflow.slice(idx, nextSectionIdx === -1 ? undefined : nextSectionIdx);
    assert.match(section, /run_in_background\s*=\s*true/, 'revision-loop planner respawn must set run_in_background=true');
    assert.match(section, /gsd_stall_watch/, 'revision-loop planner respawn must invoke the bounded stall watcher');
    assert.match(section, /gsd_stall_watch\s+"\$TS"\s+"\{receipt\}"/, 'revision-loop planner respawn must bind {receipt} (#5182) into the stall watcher call, not a dead bash variable');
  });

  test('no spawn site references an unbound $PLANNER_OUTPUT_FILE / $CHECKER_OUTPUT_FILE bash variable', () => {
    // Regression for the blocker an independent review found: the original
    // design named PLANNER_OUTPUT_FILE/CHECKER_OUTPUT_FILE as bash variables
    // in the gsd_stall_watch calls, but nothing in plan-phase.md ever ASSIGNED
    // them — with the variable permanently empty, `[ -f "$output_file" ]` is
    // always false, marker_found can never become true, and marker_received is
    // unreachable. Worse for the plan-checker spawn specifically: a checker
    // that PASSES touches no *-PLAN.md files, so it has NO working completion
    // signal at all without the marker path — a healthy, already-succeeded
    // checker would be reported as stalled. The fix replaces the dead bash
    // variable with an orchestrator-substitution token (#5182 later replaced
    // `{outputFile}` with the GSD-owned `{receipt}`; the token convention is the
    // same convention docs-update.md:471 already uses for a real
    // run_in_background=true Agent() return). This test proves the dead
    // variable name is gone from every spawn site, not just that
    // gsd_stall_watch behaves correctly when handed a valid argument
    // (tests/fix-2650-plan-phase-stall-detection.test.cjs's gsd_stall_watch
    // describe block below already covers that half — this covers the
    // production wiring the previous tests never exercised).
    assert.doesNotMatch(workflow, /\$PLANNER_OUTPUT_FILE\b/, 'plan-phase.md must not reference an unassigned $PLANNER_OUTPUT_FILE bash variable');
    assert.doesNotMatch(workflow, /\$CHECKER_OUTPUT_FILE\b/, 'plan-phase.md must not reference an unassigned $CHECKER_OUTPUT_FILE bash variable');
    // #2993 moved two of the five spawn sites into steps/chunked-planning-mode.md
    // — check there too, not just plan-phase.md, now that it's a separate file.
    const chunkedDoc = readChunkedPlanningMode();
    assert.doesNotMatch(chunkedDoc, /\$PLANNER_OUTPUT_FILE\b/, 'chunked-planning-mode.md must not reference an unassigned $PLANNER_OUTPUT_FILE bash variable');
    assert.doesNotMatch(chunkedDoc, /\$CHECKER_OUTPUT_FILE\b/, 'chunked-planning-mode.md must not reference an unassigned $CHECKER_OUTPUT_FILE bash variable');
  });

  test('exactly five gsd_stall_watch spawn-site invocations exist across plan-phase.md and its steps/*.md files', () => {
    // The whole point of #2650 is that EVERY planner/plan-checker spawn is
    // bounded — not "at least one". #2993 relocated two of the five call
    // sites (chunked outline, chunked per-plan) into
    // steps/chunked-planning-mode.md; this counts across the combined
    // surface so a future relocation can't silently drop a site without a
    // test noticing (mirrors tests/plan-phase-drift-guard.test.cjs's #913
    // ORCHESTRATOR RULE label count, which already does this).
    const combined = readWorkflowCombined(PLAN_PHASE_PATH);
    const callCount = (combined.match(/gsd_stall_watch\s+"\$TS"\s+"\{receipt\}"/g) || []).length;
    assert.equal(callCount, 5,
      `expected exactly 5 gsd_stall_watch "$TS" "{receipt}" spawn-site invocations across plan-phase.md + steps/*.md, found ${callCount}`);
  });

  test('all five spawn classes gate background surveillance and retain a runtime-native blocking result path', () => {
    const mainSections = [
      ['standard planner', '## 8. Spawn gsd-planner Agent', '## 9. Handle Planner Return'],
      ['plan-checker', '## 10. Spawn gsd-plan-checker Agent', '## 11. Handle Checker Return'],
      ['revision planner', '## 12. Revision Loop', '## 12.5. Plan Bounce'],
    ];
    const chunkedDoc = readChunkedPlanningMode();
    const sections = mainSections.map(([label, start, end]) => {
      const startAt = workflow.indexOf(start);
      return [label, workflow.slice(startAt, workflow.indexOf(end, startAt))];
    });
    sections.push(
      ['chunked outline', chunkedDoc.slice(
        chunkedDoc.indexOf('### 8.5.1 Outline Phase'),
        chunkedDoc.indexOf('### 8.5.2 Per-Plan Tasks'),
      )],
      ['chunked per-plan', chunkedDoc.slice(chunkedDoc.indexOf('### 8.5.2 Per-Plan Tasks'))],
    );

    for (const [label, section] of sections) {
      assert.match(section, /PLANNER_STALL_DETECTION_ENABLED/, `${label}: missing toggle gate`);
      assert.match(section, /`true`[\s\S]*run_in_background=true[\s\S]*gsd_stall_watch/,
        `${label}: default-on branch must retain background watcher behavior`);
      assert.match(section, /`false`[\s\S]{0,700}(?:omit|without) `?run_in_background`?[\s\S]{0,700}(?:ordinary|runtime-native)[\s\S]{0,500}(?:return|result)/i,
        `${label}: explicit-off branch must omit backgrounding and await the real runtime result`);
    }
  });

  test('step 7.99 documents that {receipt} must be bound from gsd_receipt_path before dispatch (not passed literally) (#5182)', () => {
    const idx = workflow.indexOf('## 7.99. Bounded Stall-Detection Helpers');
    assert.notEqual(idx, -1);
    const nextSectionIdx = workflow.indexOf('## 8. Spawn gsd-planner Agent', idx);
    const section = workflow.slice(idx, nextSectionIdx === -1 ? undefined : nextSectionIdx);
    assert.match(section, /`\{receipt\}` = `gsd_receipt_path "\$\{PHASE_DIR\}" <spawn>`/, 'step 7.99 must bind {receipt} from gsd_receipt_path, not leave it as literal text');
    // The full binding contract lives in the lazily-loaded reference file to stay
    // under the PRE_PHASE6 cap — verify it is actually there, not just gestured at.
    // #5182 replaced the {outputFile} binding (a host transcript that already holds
    // the prompt and definition text) with the GSD-owned receipt.
    const helpersDoc = readStallHelpersDoc();
    assert.match(helpersDoc, /substitutes the printed absolute path for `\{receipt\}`/, 'stall-detection-helpers.md must explain the {receipt} binding contract');
    assert.match(helpersDoc, /\*\*Plan-checker receipt:\*\* a checker that PASSES touches no `\*-PLAN\.md`, so its receipt\s+is its only completion signal for this watch/,
      'stall-detection-helpers.md must explain why the receipt is load-bearing for the plan-checker spawn specifically');
  });

  test('stall surveillance is not gated behind the teams-status guard (AC2)', () => {
    // The only actual `query teams-status` CALL in plan-phase.md must stay
    // scoped to the researcher spawn banner (its pre-existing, unrelated
    // purpose) — the new stall blocks must not add a second call site or make
    // their own behavior conditional on it. The helpers doc is allowed (and
    // expected) to name "teams-status" in prose explaining that independence
    // (AC2 self-documentation) — what must never appear is a SECOND `query
    // teams-status` invocation, or any conditional gating on its result.
    const teamsStatusCallOccurrences = workflow.split('query teams-status').length - 1;
    assert.equal(teamsStatusCallOccurrences, 1, 'teams-status guard must remain scoped to its single pre-existing call site');
    assert.doesNotMatch(readStallHelpersDoc(), /query teams-status/, 'stall-detection helpers must not add their own teams-status call site');
  });

  test('completion-marker contract is unchanged (AC4)', () => {
    for (const marker of ['## PLANNING COMPLETE', '## CHECKPOINT REACHED', '## VERIFICATION PASSED', '## ISSUES FOUND', '## PLANNING INCONCLUSIVE']) {
      assert.ok(workflow.includes(marker), `completion-marker contract must still include ${marker}`);
    }
  });

  test('researcher (line ~404) and pattern-mapper (line ~681) spawns are untouched (out of scope)', () => {
    const researcherIdx = workflow.indexOf('### Spawn gsd-phase-researcher');
    const patternMapperIdx = workflow.indexOf('## 7.8. Spawn gsd-pattern-mapper Agent');
    assert.notEqual(researcherIdx, -1);
    assert.notEqual(patternMapperIdx, -1);
    const researcherSection = workflow.slice(researcherIdx, workflow.indexOf('### Handle Researcher Return'));
    const patternMapperSection = workflow.slice(patternMapperIdx, workflow.indexOf('## 7.9. Regenerate API-SURFACE.md'));
    assert.doesNotMatch(researcherSection, /gsd_stall_watch/, 'researcher spawn must remain a plain blocking call (out of scope per Agent Brief)');
    assert.doesNotMatch(patternMapperSection, /gsd_stall_watch/, 'pattern-mapper spawn must remain a plain blocking call (out of scope per Agent Brief)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #2650 follow-up: the spawn bound was sized for the wrong CLASS of call.
//
// runBashScript hard-coded `timeout: 10000`. The script it runs is not a cheap
// probe: extractStallHelpersBash slices the ENTIRE ```bash fence, whose runtime-launcher
// preamble resolves gsd-tools.cjs and really runs two `gsd_run query config-get` lines —
// two full Node spawns (measured 236ms vs 2ms for the fallback the old comment claimed
// fires: 118x). On `full test (windows-latest, 24, shard 1/3)` that bound was exceeded at
// 10006ms and spawnSync's kill surfaced as `status: null`, which the call site asserted
// as `null !== 0` — a message naming neither the timeout nor the bound.
//
// tests/helpers/timeouts.cjs already owns this exact class (HOOK_FANOUT_TIMEOUT_MS), and
// its comment records the identical failure on PR #3285: "a bound sized for the wrong
// class, not a slow machine."
// ─────────────────────────────────────────────────────────────────────────────

describe('#2650 follow-up: runBashScript bounds and reports a bash fan-out correctly', () => {
  /**
   * An arbitrary value proving `runBashScript`'s explicit timeoutMs
   * argument overrides its own class-norm default (HOOK_FANOUT_TIMEOUT_MS).
   */
  const RUN_BASH_SCRIPT_OVERRIDE_TIMEOUT_MS = 1234;
  /**
   * Deliberately tiny (not generous headroom) to force a real `sleep 5`
   * command past the bound within this test's own lifetime, proving an
   * exceeded bound reports TIMED_OUT, not a bare null status.
   */
  const RUN_BASH_SCRIPT_FORCED_TIMEOUT_MS = 250;
  /** CLAUDE.md boundary-coverage triple (limit-1/limit/limit+1) on runBashScript's own timeoutMs value-domain validation: a negative bound must be rejected. */
  const RUN_BASH_SCRIPT_TIMEOUT_BOUNDARY_NEGATIVE_MS = -1;
  /** CLAUDE.md boundary-coverage triple (limit-1/limit/limit+1) on runBashScript's own timeoutMs value-domain validation: zero must be rejected, never read as unbounded. Used at both occurrences in this test (the throw assertion and the later leak-check re-throw). */
  const RUN_BASH_SCRIPT_TIMEOUT_BOUNDARY_ZERO_MS = 0;
  /** CLAUDE.md boundary-coverage triple (limit-1/limit/limit+1) on runBashScript's own timeoutMs value-domain validation: the smallest positive bound is valid and must be accepted. */
  const RUN_BASH_SCRIPT_TIMEOUT_BOUNDARY_ONE_MS = 1;

  test('bounds the fan-out with the class norm, and an explicit override still wins', (t) => {
    t.after(() => mock.restoreAll());
    const seen = [];
    mock.method(processSeam, 'runHook', (target, args, opts) => {
      seen.push(opts);
      return { outcome: OUTCOME.EXITED, exitCode: 0, stdout: '', stderr: '', timedOut: false, signal: null, killed: false, code: null };
    });

    runBashScript('echo hi\n');
    assert.equal(seen.length, 1,
      'runBashScript must route through the process seam (CONTRIBUTING.md: never a hand-rolled spawnSync in a suite)');
    assert.equal(seen[0].timeoutMs, HOOK_FANOUT_TIMEOUT_MS,
      `default bound must be the bash-fan-out class norm (${HOOK_FANOUT_TIMEOUT_MS}ms), not a probe-sized literal; got ${seen[0].timeoutMs}`);
    assert.equal(seen[0].interpreter, 'bash', 'the seam must be told to run the script under bash');

    runBashScript('echo hi\n', [], { timeoutMs: RUN_BASH_SCRIPT_OVERRIDE_TIMEOUT_MS });
    assert.equal(seen[1].timeoutMs, RUN_BASH_SCRIPT_OVERRIDE_TIMEOUT_MS, 'an explicit timeoutMs must override the class norm');
  });

  test('an exceeded bound reports TIMED_OUT, not a bare null status', () => {
    // A real sleep against a deliberately tiny bound. The assertion is on the
    // CLASSIFICATION, never on elapsed time.
    const result = runBashScript('sleep 5\n', [], { timeoutMs: RUN_BASH_SCRIPT_FORCED_TIMEOUT_MS });
    assert.equal(result.outcome, OUTCOME.TIMED_OUT,
      `an exceeded bound must name itself; got outcome=${result.outcome} status=${result.status}`);
    assert.equal(result.timedOut, true, 'timedOut must be true when the bound is exceeded');
  });

  test('a genuine non-zero exit is EXITED, never confused with a timeout', () => {
    const result = runBashScript('exit 3\n');
    assert.equal(result.outcome, OUTCOME.EXITED,
      'a prompt non-zero exit is an EXITED outcome, not a timeout');
    assert.equal(result.status, 3, 'the real exit code must survive');
    assert.equal(result.timedOut, false, 'a real exit must not be reported as timed out');
  });

  test('boundary: a non-positive bound is rejected, never silently run unbounded', () => {
    // limit-1 / limit / limit+1 on the VALUE DOMAIN of the bound, not on wall-clock
    // timing — the previous test already covers the exceeded-bound classification, and
    // an exact-millisecond timing edge would be a race, not a boundary.
    //
    // Zero is the load-bearing case: spawnSync reads `timeout: 0` as "no timeout at
    // all", which is precisely the unbounded-spawn hazard local/no-unbounded-spawn
    // exists to prevent (CONTRIBUTING.md: "`timeout: 0` — Node reads zero as *no
    // timeout*"). The seam rejects it instead of honouring it.
    assert.throws(() => runBashScript('exit 0\n', [], { timeoutMs: RUN_BASH_SCRIPT_TIMEOUT_BOUNDARY_ZERO_MS }), TypeError,
      'limit: zero must be rejected, never read as unbounded');
    assert.throws(() => runBashScript('exit 0\n', [], { timeoutMs: RUN_BASH_SCRIPT_TIMEOUT_BOUNDARY_NEGATIVE_MS }), TypeError,
      'limit-1: a negative bound must be rejected');
    assert.doesNotThrow(() => runBashScript('exit 0\n', [], { timeoutMs: RUN_BASH_SCRIPT_TIMEOUT_BOUNDARY_ONE_MS }),
      'limit+1: the smallest positive bound is valid and must be accepted');

    // The helper must still clean up its temp dir when the seam throws — the throw
    // escapes through runBashScript's `finally`, which is what makes the rejection safe
    // to rely on rather than a resource leak.
    const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('gsd-2650-sh-')).length;
    assert.throws(() => runBashScript('exit 0\n', [], { timeoutMs: RUN_BASH_SCRIPT_TIMEOUT_BOUNDARY_ZERO_MS }), TypeError);
    const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('gsd-2650-sh-')).length;
    assert.equal(after, before, 'a rejected bound must not leak the script temp dir');
  });
});

// The #5182 rows need only the shipped FUNCTION definitions, not the whole fence:
// the fence opens with the runtime-locator preamble and two `gsd_run query
// config-get` lines, i.e. two Node spawns per bash call (about 1 s each on the
// Windows runners). Run through every #5182 row, that preamble cost 169.5 s on
// Windows CI shard 1/3, enough to starve a concurrent file into a spawn timeout.
// Slicing from the first function keeps the executed code the shipped code;
// config resolution stays covered by the #2650 rows above, which run the full fence.
function extractStallFunctionsBash() {
  const fence = extractStallHelpersBash();
  const at = fence.indexOf('gsd_stall_should_recover() {');
  if (at === -1) throw new Error('extractStallFunctionsBash: gsd_stall_should_recover() not found in the helpers fence');
  return fence.slice(at);
}

// ─────────────────────────────────────────────────────────────────────────────
// #5182 — the stall watch must observe the spawned agent's REAL return, not text
// that merely mentions a marker.
//
// Pre-fix, every watch call site bound `{outputFile}` (a host-specific handle; on
// Claude Code the subagent JSONL transcript) and `gsd_stall_watch` grepped the
// WHOLE file for the markers. The transcript holds the agent's prompt and its
// definition snapshot before the agent replies, so the planner/checker watch
// reported `marker_received` at its first check; the revision watch passed no
// markers, so `stalled` was its only exit; and a host with no output file could
// only ever reach `stalled`.
//
// The fix binds a GSD-owned, per-dispatch return receipt (`{receipt}`, printed by
// `gsd_receipt_path`) that the agent writes as its LAST action, and matches a
// marker only at the START of a receipt line (`gsd_return_marker`), which is also
// what step 11 routes on. These rows drive the SHIPPED bash and read the SHIPPED
// call sites (markers are extracted from plan-phase.md, not hand-copied), so a
// call site that drops its markers or rebinds a host file fails here.
// ─────────────────────────────────────────────────────────────────────────────

describe('bug #5182 — the stall watch observes a GSD-owned return receipt, never prompt or transcript text', () => {
  const CHECKER_SECTION = ['## 10. Spawn gsd-plan-checker Agent', '## 11. Handle Checker Return'];
  const REVISION_SECTION = ['## 12. Revision Loop', '## 12.5. Plan Bounce'];
  const PLANNER_SECTION = ['## 8. Spawn gsd-planner Agent', '## 9. Handle Planner Return'];

  function sectionOf(doc, [start, end]) {
    const at = doc.indexOf(start);
    assert.notEqual(at, -1, `missing section heading: ${start}`);
    const stop = doc.indexOf(end, at);
    return doc.slice(at, stop === -1 ? undefined : stop);
  }

  // Parse the one `gsd_stall_watch "$TS" "<token>" <glob> "m1" "m2" ...` call in a
  // section: returns the bound token and the marker list exactly as shipped.
  function watchCallOf(section) {
    const m = section.match(/gsd_stall_watch\s+"\$TS"\s+"(\{[A-Za-z]+\})"\s+\S+?((?:\s+"[^"]*")*)\)/);
    assert.ok(m, 'section must contain one gsd_stall_watch "$TS" "<token>" <glob> [markers...] call');
    const markers = [...m[2].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
    return { token: m[1], markers };
  }

  // An injected clock: every row reads "now" from this constant through a stubbed
  // `date +%s`, never from the wall clock, so threshold boundaries are exact.
  const NOW = 1800000000;

  // Run the shipped helpers with `sleep` stubbed (no real interval wait), `date +%s`
  // pinned to NOW and the interval/threshold pinned, then run `call`. Returns
  // trimmed stdout.
  function runHelpers(call, { interval = 5, threshold = 10 } = {}) {
    const helpersBash = extractStallFunctionsBash();
    const clock = `date() { if [ "$1" = "+%s" ]; then echo ${NOW}; else command date "$@"; fi; }`;
    const script = `${helpersBash}\nsleep() { :; }\n${clock}\nPLANNER_STALL_INTERVAL_MINUTES=${interval}\nPLANNER_STALL_THRESHOLD_MINUTES=${threshold}\n${call}\n`;
    const result = runBashScript(script, []);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }

  const q = (s) => JSON.stringify(String(s));

  function watch(dispatchTs, file, glob, markers, opts) {
    return runHelpers(`gsd_stall_watch ${q(dispatchTs)} ${q(file)} ${q(glob)}${markers.map((x) => ` ${q(x)}`).join('')}`, opts);
  }

  function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5182-'));
    t.after(() => cleanup(dir));
    const fwd = dir.replace(/\\/g, '/');
    // A Claude-Code-shaped transcript of a checker that has NOT returned yet:
    // record 1 is the prompt (lists both markers), then a definition snapshot
    // (quotes the planner's own marker heading). Neither is a return.
    const transcript = path.join(dir, 'agent-transcript.jsonl');
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: '... Return:\n- ## VERIFICATION PASSED — all checks pass\n- ## ISSUES FOUND — structured issue list\n' } }),
      JSON.stringify({ type: 'attachment', attachment: { type: 'prompt_snapshot', content: '## Return Markers\n\n```markdown\n## PLANNING COMPLETE\n```\n' } }),
    ].join('\n') + '\n');
    return { dir, fwd, transcript, noPlans: `${fwd}/none-*-PLAN.md`, receipt: path.join(dir, 'receipt.md') };
  }

  test('AC1: markers present only in a prompt or definition snapshot yield waiting, not marker_received', (t) => {
    const f = fixture(t);
    const checker = watchCallOf(sectionOf(readPlanPhase(), CHECKER_SECTION));
    assert.equal(watch(NOW, f.transcript, f.noPlans, checker.markers), 'waiting',
      'a file whose only marker text is the prompt/definition must not count as the agent returning');
    const planner = watchCallOf(sectionOf(readPlanPhase(), PLANNER_SECTION));
    assert.equal(watch(NOW, f.transcript, f.noPlans, planner.markers), 'waiting');
  });

  test('AC1 wiring: all five watch sites bind {receipt}; none binds the host {outputFile}', () => {
    const combined = readWorkflowCombined(PLAN_PHASE_PATH);
    const receiptCalls = (combined.match(/gsd_stall_watch\s+"\$TS"\s+"\{receipt\}"/g) || []).length;
    assert.equal(receiptCalls, 5, `expected 5 gsd_stall_watch "$TS" "{receipt}" call sites, found ${receiptCalls}`);
    assert.doesNotMatch(combined, /gsd_stall_watch\s+"\$TS"\s+"\{outputFile\}"/,
      'no watch may read a host-specific output file (undocumented on Claude Code, absent on other hosts)');
  });

  test('every watched spawn prompt hands the agent its receipt path', () => {
    const plan = readPlanPhase();
    const chunked = readChunkedPlanningMode();
    const sections = [
      ['planner', sectionOf(plan, PLANNER_SECTION)],
      ['checker', sectionOf(plan, CHECKER_SECTION)],
      ['revision', sectionOf(plan, REVISION_SECTION)],
      ['chunked outline', chunked.slice(chunked.indexOf('### 8.5.1 Outline Phase'), chunked.indexOf('### 8.5.2 Per-Plan Tasks'))],
      ['chunked per-plan', chunked.slice(chunked.indexOf('### 8.5.2 Per-Plan Tasks'))],
    ];
    for (const [label, section] of sections) {
      assert.match(section, /<return_receipt>\{receipt\}<\/return_receipt>/, `${label}: prompt must carry <return_receipt>{receipt}</return_receipt>`);
    }
    // The binding itself: once at step 7.99 for plan-phase.md's three sites, and at
    // each chunked site.
    assert.match(sectionOf(plan, ['## 7.99.', '## 8. ']), /gsd_receipt_path "\$\{PHASE_DIR\}" <spawn>/);
    for (const [label, section] of sections.slice(3)) {
      assert.match(section, /gsd_receipt_path "\$\{PHASE_DIR\}"/, `${label}: must bind {receipt} from gsd_receipt_path`);
    }
  });

  test('AC2: a checker receipt of ## ISSUES FOUND routes to the revision step, never the pass step', (t) => {
    const f = fixture(t);
    const plan = readPlanPhase();
    const checker = watchCallOf(sectionOf(plan, CHECKER_SECTION));
    assert.deepEqual(checker.markers, ['## VERIFICATION PASSED', '## ISSUES FOUND']);
    fs.writeFileSync(f.receipt, '## ISSUES FOUND\n');
    const markerArgs = checker.markers.map((x) => ` ${q(x)}`).join('');
    assert.equal(watch(NOW - 120, f.receipt, f.noPlans, checker.markers), 'marker_received');
    assert.equal(runHelpers(`gsd_return_marker ${q(f.receipt)}${markerArgs}`), '## ISSUES FOUND');
    fs.writeFileSync(f.receipt, '## VERIFICATION PASSED\n');
    assert.equal(runHelpers(`gsd_return_marker ${q(f.receipt)}${markerArgs}`), '## VERIFICATION PASSED');
    // The routing marker comes from the one matcher over the receipt (helpers doc,
    // loaded at 7.99); step 11 sends ISSUES FOUND to step 12.
    assert.match(readStallHelpersDoc(), /gsd_return_marker "\{receipt\}"/);
    const step11 = sectionOf(plan, ['## 11. Handle Checker Return', '## 11a.']);
    assert.match(step11, /## ISSUES FOUND[^\n]*step 12/, 'ISSUES FOUND must route to step 12');
  });

  test('AC3: a finished revision yields marker_received within one poll interval', (t) => {
    const f = fixture(t);
    const revision = watchCallOf(sectionOf(readPlanPhase(), REVISION_SECTION));
    assert.ok(revision.markers.includes('## REVISION COMPLETE'), 'the revision watch must pass the revision success marker');
    assert.ok(revision.markers.includes('## REVISION_CONFLICT'), 'the revision watch must pass the conflict marker');
    // The revision finished and rewrote a plan during the first interval.
    fs.writeFileSync(path.join(f.dir, '01-PLAN.md'), '# plan\n');
    fs.writeFileSync(f.receipt, '## REVISION COMPLETE\n');
    assert.equal(watch(NOW - 5 * 60, f.receipt, `${f.fwd}/*-PLAN.md`, revision.markers, { interval: 5 }), 'marker_received');
    fs.writeFileSync(f.receipt, '## REVISION_CONFLICT\n');
    assert.equal(watch(NOW - 5 * 60, f.receipt, `${f.fwd}/*-PLAN.md`, revision.markers, { interval: 5 }), 'marker_received');
  });

  // Preservation row (green on next too): the receipt must not weaken the stall exit.
  // Boundary triple on the 10-minute threshold (600 s), against the injected clock.
  test('AC4: a spawn that never writes its receipt is stalled from the threshold on (limit-1 / limit / limit+1)', (t) => {
    const f = fixture(t);
    const LIMIT_SECONDS = 10 * 60;
    for (const section of [PLANNER_SECTION, CHECKER_SECTION, REVISION_SECTION]) {
      const call = watchCallOf(sectionOf(readPlanPhase(), section));
      assert.equal(watch(NOW - (LIMIT_SECONDS - 1), f.receipt, f.noPlans, call.markers, { threshold: 10 }), 'waiting', 'limit-1');
      assert.equal(watch(NOW - LIMIT_SECONDS, f.receipt, f.noPlans, call.markers, { threshold: 10 }), 'stalled', 'limit');
      assert.equal(watch(NOW - (LIMIT_SECONDS + 1), f.receipt, f.noPlans, call.markers, { threshold: 10 }), 'stalled', 'limit+1');
    }
  });

  // The call-site half of AC5 (all five sites bind {receipt}, none {outputFile})
  // is the "AC1 wiring" row above; this row is the behavioral half.
  test('AC5: a host transcript or a missing host output is never a return; only the receipt ends the wait', (t) => {
    const f = fixture(t);
    const checker = watchCallOf(sectionOf(readPlanPhase(), CHECKER_SECTION));
    assert.ok(fs.readFileSync(f.transcript, 'utf8').includes('## VERIFICATION PASSED'),
      'precondition: the transcript contains the checker marker text, so a watch that searched it for that text would find it');
    // Argument 2 given each host's output in place of a receipt: neither one is
    // treated as a return, before or past the threshold.
    const missing = path.join(f.dir, 'no-such-output');
    for (const hostOutput of [f.transcript, missing]) {
      const host = path.basename(hostOutput);
      assert.equal(watch(NOW - 60, hostOutput, f.noPlans, checker.markers), 'waiting', `${host}: before the threshold`);
      assert.equal(watch(NOW - 11 * 60, hostOutput, f.noPlans, checker.markers), 'stalled', `${host}: past the threshold`);
    }
    // Only the receipt ends the wait.
    fs.writeFileSync(f.receipt, '## VERIFICATION PASSED\n');
    assert.equal(watch(NOW - 60, f.receipt, f.noPlans, checker.markers), 'marker_received');
  });

  test('gsd_return_marker: line-start literal match, CR-tolerant, empty on anything else', (t) => {
    const f = fixture(t);
    const m = ` ${q('## PLAN COMPLETE')} ${q('## PLANNING COMPLETE')} ${q('## ⚠ Source Audit')}`;
    const run = (content) => {
      cleanup(f.receipt);
      if (content !== null) fs.writeFileSync(f.receipt, content);
      return runHelpers(`gsd_return_marker ${q(f.receipt)}${m}`);
    };
    assert.equal(run(null), '', 'missing receipt -> no marker, exit 0');
    assert.equal(run(''), '', 'empty receipt -> no marker');
    assert.equal(run('## PLANNING COMPLETE\r\n'), '## PLANNING COMPLETE', 'CRLF receipt still matches');
    assert.equal(run('## PLANNING COMPLETE (3 plans)\n'), '## PLANNING COMPLETE', 'trailing text after the marker matches');
    assert.equal(run('## PLAN COMPLETE\n'), '## PLAN COMPLETE', '## PLAN COMPLETE is not confused with ## PLANNING COMPLETE');
    assert.equal(run('## ⚠ Source Audit\n'), '## ⚠ Source Audit', 'non-ASCII marker matches literally');
    assert.equal(run('  ## PLANNING COMPLETE\n'), '', 'an indented (quoted) marker does not match');
    assert.equal(run('Emit ## PLANNING COMPLETE when done\n'), '', 'a marker mid-line does not match');
    assert.equal(run(fs.readFileSync(f.transcript, 'utf8')), '', 'JSONL transcript records never match');
    assert.equal(run('note\n## PLAN COMPLETE\n## PLANNING COMPLETE\n'), '## PLAN COMPLETE', 'first marker line wins');
    assert.equal(run('## PLANNING COMPLETE'), '## PLANNING COMPLETE', 'a receipt with no final newline still matches');
    assert.equal(run('\uFEFF## PLANNING COMPLETE\n'), '## PLANNING COMPLETE', 'a leading UTF-8 BOM is tolerated');
    assert.equal(run('## PLAN COMPLETED\n'), '', 'a marker must end at a word boundary');
    cleanup(f.receipt);
    fs.mkdirSync(f.receipt);
    assert.equal(runHelpers(`gsd_return_marker ${q(f.receipt)}${m}`), '', 'a directory at the receipt path -> no marker');
  });

  test('gsd_return_marker reads at most the first 64 lines of the receipt', (t) => {
    const f = fixture(t);
    const m = ` ${q('## PLANNING COMPLETE')}`;
    const filler = (n) => 'note\n'.repeat(n);
    const run = (content) => {
      fs.writeFileSync(f.receipt, content);
      return runHelpers(`gsd_return_marker ${q(f.receipt)}${m}`);
    };
    assert.equal(run(`## PLANNING COMPLETE\n${filler(500)}`), '## PLANNING COMPLETE', 'a marker on line 1 of a long receipt is found');
    assert.equal(run(`${filler(63)}## PLANNING COMPLETE\n${filler(10)}`), '## PLANNING COMPLETE', 'a marker on line 64 is found');
    assert.equal(run(`${filler(64)}## PLANNING COMPLETE\n`), '', 'a marker only on line 65 is past the cap');
  });

  // ── fast-check properties (RULESET.TESTS: a discriminating property per parser /
  // sanitizer). Each property run is ONE bash invocation over a whole batch of
  // generated cases, written to files (never argv: Windows MSYS re-unescapes argv),
  // so the shrinker still works on the case array while the spawn cost stays low.

  // Runs `gsd_return_marker` for each [marker, receiptContent] case; returns the
  // printed marker ('' for none) per case, in order.
  function returnMarkerBatch(dir, cases) {
    const caseDir = fs.mkdtempSync(path.join(dir, 'rm-'));
    cases.forEach(([marker, content], i) => {
      fs.writeFileSync(path.join(caseDir, `${i}.m`), marker);
      fs.writeFileSync(path.join(caseDir, `${i}.l`), content);
    });
    const D = q(caseDir.replace(/\\/g, '/'));
    const out = runHelpers(`i=0; while [ -f ${D}/$i.m ]; do IFS= read -r -d '' m < ${D}/$i.m || true; printf '%s\\t[%s]\\n' "$i" "$(gsd_return_marker ${D}/$i.l "$m")"; i=$((i+1)); done`);
    cleanup(caseDir);
    const got = new Map(out.split('\n').filter(Boolean).map((l) => {
      const tab = l.indexOf('\t');
      // Bracketed so trimming the output can never eat an empty result.
      return [Number(l.slice(0, tab)), l.slice(tab + 2, -1)];
    }));
    return cases.map((_, i) => got.get(i));
  }

  // The specification, independent of the bash: strip one trailing CR, then one
  // leading BOM; match iff the line starts with the marker and the marker is
  // followed by the end of the line, whitespace (space, tab, CR, VT, FF) or a
  // colon (the planner's Source Audit return puts `: Unplanned Items Found` after its
  // marker). Any other character, ASCII or not (`-x`, a letter with an accent), is not
  // a boundary.
  function returnMarkerOracle(marker, line) {
    let l = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (l.startsWith('﻿')) l = l.slice(1);
    return l.startsWith(marker) && /^(?:$|[ \t\r\v\f:])/.test(l.slice(marker.length)) ? marker : '';
  }

  test('property: gsd_return_marker matches iff the line starts with the marker and the next char is end, whitespace or a colon (CR- and BOM-tolerant)', (t) => {
    const f = fixture(t);
    const markerArb = fc.constantFrom('## PLANNING COMPLETE', '## PLAN COMPLETE', '## ISSUES FOUND', '## ⚠ Source Audit', '## REVISION_CONFLICT', '#');
    // Word and non-word ASCII, non-ASCII letters (must count as a boundary), and
    // marker-ish characters; no newline, CR or NUL inside the line body.
    const charArb = fc.constantFrom(...'aZ9_ -(.:#\té⚠ß'.split(''));
    const freeArb = fc.string({ unit: charArb, maxLength: 8 });
    const lineArb = markerArb.chain((m) => fc.tuple(
      fc.constant(m),
      fc.oneof(
        freeArb,                                                    // unrelated text
        fc.constant(m),                                             // exactly the marker
        fc.tuple(charArb, freeArb).map(([c, rest]) => m + c + rest), // marker, then one char
        freeArb.map((pre) => pre + m),                              // marker not at line start
        fc.nat(m.length).map((k) => m.slice(0, k)),                 // truncated marker
      ),
      fc.boolean(), fc.boolean(), fc.boolean(),                     // BOM, trailing CR, final newline
    ));
    fc.assert(fc.property(fc.array(lineArb, { minLength: 1, maxLength: 40 }), (rows) => {
      const lines = rows.map(([, body, bom, cr]) => (bom ? '﻿' : '') + body + (cr ? '\r' : ''));
      const cases = rows.map(([m], i) => [m, lines[i] + (rows[i][4] ? '\n' : '')]);
      const got = returnMarkerBatch(f.dir, cases);
      return rows.every(([m], i) => got[i] === returnMarkerOracle(m, lines[i]));
    }), { numRuns: 10 });
  });

  test('property: gsd_receipt_path never leaves <phase>/.gsd-returns/ for any spawn label, and refuses an unsafe phase dir', (t) => {
    const f = fixture(t);
    const W = /^[A-Za-z0-9_-]+$/;
    const labelArb = fc.string({ unit: fc.constantFrom(...'aZ9_-./\\ \'"$`*?\né⚠'.split('').concat(['..'])), maxLength: 12 });
    fc.assert(fc.property(fc.array(labelArb, { minLength: 1, maxLength: 25 }), (labels) => {
      const caseDir = fs.mkdtempSync(path.join(f.dir, 'rp-'));
      labels.forEach((l, i) => fs.writeFileSync(path.join(caseDir, `${i}.s`), l));
      const D = q(caseDir.replace(/\\/g, '/'));
      const out = runHelpers(`cd ${q(f.dir)}; i=0; while [ -f ${D}/$i.s ]; do IFS= read -r -d '' s < ${D}/$i.s || true; printf '%s\\t%s\\n' "$i" "$(gsd_receipt_path ph "$s")"; i=$((i+1)); done; pwd`);
      cleanup(caseDir);
      const outLines = out.split('\n');
      const root = outLines.pop();
      const returns = (root.replace(/^\/([A-Za-z])\//, '$1:/') + '/ph/.gsd-returns').toLowerCase();
      return labels.every((label, i) => {
        const line = outLines.find((l) => l.startsWith(`${i}\t`));
        const p = line.slice(line.indexOf('\t') + 1);
        const slash = p.lastIndexOf('/');
        const parent = p.slice(0, slash).toLowerCase();
        const [stem, epoch, rand] = p.slice(slash + 1).split('.');
        const sameDir = parent === returns || parent.endsWith('/ph/.gsd-returns');
        const ascii = /^[\x20-\x7e]*$/.test(label);
        const expected = label.replace(/[^A-Za-z0-9_-]/g, '_') || 'spawn';
        // A non-ASCII character becomes one `_` per character (UTF-8 locale) or one per
        // byte (C locale), so for those labels compare with runs of `_` collapsed; an
        // ASCII label must match exactly.
        const collapse = (x) => x.replace(/_+/g, '_');
        return sameDir && W.test(stem) && epoch === String(NOW) && /^[A-Za-z0-9]+$/.test(rand) &&
          (ascii ? stem === expected : collapse(stem) === collapse(expected));
      });
    }), { numRuns: 12 });
    // Unsafe phase dirs: any dir holding a quote, `$`, backtick, `<`, `>` or a control
    // character (newline, tab, CR, ESC, DEL...) fails closed (no output, non-zero); any
    // other dir is accepted. Values travel through files and are read with -d '' so a
    // newline reaches the helper intact.
    const dirArb = fc.string({ unit: fc.constantFrom(...'ab -\'"$`<>\n\t\r\x01\x1b\x7f'.split('')), minLength: 1, maxLength: 6 }).map((d) => `p${d}`);
    const unsafeDir = (d) => /['"$`<>]/.test(d) || [...d].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
    let checked = 0;
    fc.assert(fc.property(fc.array(dirArb, { minLength: 1, maxLength: 15 }), (dirs) => {
      const caseDir = fs.mkdtempSync(path.join(f.dir, 'pd-'));
      dirs.forEach((d, i) => fs.writeFileSync(path.join(caseDir, `${i}.d`), d));
      const D = q(caseDir.replace(/\\/g, '/'));
      const out = runHelpers(`cd ${q(f.dir)}; i=0; while [ -f ${D}/$i.d ]; do IFS= read -r -d '' d < ${D}/$i.d || true; if gsd_receipt_path "$d" x >/dev/null; then echo "$i OK"; else echo "$i FAIL"; fi; i=$((i+1)); done`);
      cleanup(caseDir);
      const verdict = new Map(out.split('\n').map((l) => l.split(' ')));
      checked += verdict.size;
      return verdict.size === dirs.length &&
        dirs.every((d, i) => verdict.get(String(i)) === (unsafeDir(d) ? 'FAIL' : 'OK'));
    }), { numRuns: 8 });
    assert.ok(checked > 0, 'the unsafe-dir property must execute at least one case');
  });

  test('gsd_receipt_path: absolute, unique per call, under <phase>/.gsd-returns/, directory created, label sanitized', (t) => {
    const f = fixture(t);
    const rel = 'phase dir/01-x';
    fs.mkdirSync(path.join(f.dir, rel), { recursive: true });
    const script = `${extractStallFunctionsBash()}\ncd ${q(f.dir)}\na=$(gsd_receipt_path ${q(rel)} checker)\nb=$(gsd_receipt_path ${q(rel)} checker)\nc=$(gsd_receipt_path ${q(`${f.fwd}/${rel}`)} '../01/x y')\nprintf '%s\\n' "$a" "$b" "$c"\n[ -d "${rel}/.gsd-returns" ] && echo DIR_OK\n[ -e "$a" ] || echo NOT_PRECREATED\n`;
    const result = runBashScript(script, []);
    assert.equal(result.status, 0, result.stderr);
    const [a, b, c, dirOk, notPre] = result.stdout.trim().split('\n');
    for (const p of [a, b, c]) {
      assert.match(p, /^(\/|[A-Za-z]:\/)/, `receipt path must be absolute: ${p}`);
      assert.match(p, /\/phase dir\/01-x\/\.gsd-returns\/[^/]+$/, `receipt must live in <phase>/.gsd-returns/: ${p}`);
    }
    assert.notEqual(a, b, 'two dispatches in the same second must get distinct receipts');
    assert.match(path.posix.basename(c), /^___01_x_y/, 'a hostile label cannot leave .gsd-returns/');
    assert.equal(dirOk, 'DIR_OK');
    assert.equal(notPre, 'NOT_PRECREATED', 'the receipt must not be pre-created (a host Write tool may refuse to overwrite an unread file)');
  });

  test('gsd_receipt_path fails closed on an unsafe phase dir and writes a catch-all .gitignore', (t) => {
    const f = fixture(t);
    const helpers = extractStallFunctionsBash();
    // A newline, tab, CR or any other control character, `<` and `>` would land in the
    // `<return_receipt>` prompt line the orchestrator substitutes (review 5477738387 Minor 1).
    const unsafe = ['', 'ph"ase', "ph'ase", 'ph$ase', 'ph`ase',
      'ph\nase', 'ph\tase', 'ph\rase', 'ph\x01ase', 'ph\x1base', 'ph\x7fase', 'ph<ase', 'ph>ase', 'ph\n'];
    let refused = 0;
    for (const bad of unsafe) {
      // Handed over through a file, never interpolated or passed as argv: a `$` or
      // backtick in a double-quoted literal is expanded by bash first, and on Windows
      // Git Bash's MSYS layer re-splits and unescapes argv, so a `'` argument arrives
      // stripped (observed in CI: "ph'ase" reached the helper as "phase"). See
      // extractStallFunctionsBash()'s doc comment for the same transport hazard.
      const valueFile = path.join(f.dir, 'phase-dir-value.txt');
      fs.writeFileSync(valueFile, bad);
      // -d '' reads the whole file, so an embedded or trailing newline reaches the helper.
      const r = runBashScript(`${helpers}\ncd ${q(f.dir)}\nIFS= read -r -d '' d < ${q(valueFile.replace(/\\/g, '/'))} || true\nif out=$(gsd_receipt_path "$d" checker); then echo "OK:$out"; else echo FAIL; fi\n`, []);
      assert.equal(r.stdout.trim(), 'FAIL', `phase dir ${JSON.stringify(bad)} must be refused`);
      refused += 1;
    }
    assert.equal(refused, unsafe.length, 'every unsafe phase dir case must run');
    assert.equal(fs.readdirSync(f.dir).filter((n) => n.startsWith('ph') && n !== 'phase-dir-value.txt').length, 0, 'a refused phase dir is never created');
    const r = runBashScript(`${helpers}\ncd ${q(f.dir)}\ngsd_receipt_path ph checker >/dev/null && cat ph/.gsd-returns/.gitignore\n`, []);
    assert.equal(r.stdout.trim(), '*', '.gsd-returns/ must ignore its own receipts');
  });

  // A hostile checkout can commit <phase>/.gsd-returns (or its .gitignore) as a
  // symlink; mkdir -p and the .gitignore printf would follow it out of the phase.
  function symlinkOrSkip(t, target, link, type) {
    try {
      fs.symlinkSync(target, link, type === 'dir' && process.platform === 'win32' ? 'junction' : type);
      return true;
    } catch (error) {
      if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
        t.skip('symlink creation is not available on this platform');
        return false;
      }
      throw error;
    }
  }

  test('gsd_receipt_path refuses a symlinked <phase>/.gsd-returns and writes nothing through it', (t) => {
    const f = fixture(t);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5182-outside-'));
    t.after(() => cleanup(outside));
    fs.mkdirSync(path.join(f.dir, 'ph'));
    if (!symlinkOrSkip(t, outside, path.join(f.dir, 'ph', '.gsd-returns'), 'dir')) return;
    const r = runBashScript(`${extractStallFunctionsBash()}\ncd ${q(f.dir)}\ngsd_receipt_path ph checker\n`, []);
    assert.notEqual(r.status, 0, 'a symlinked .gsd-returns must be refused');
    assert.equal(r.stdout, '', 'a refused receipt prints no path');
    assert.deepEqual(fs.readdirSync(outside), [], 'nothing may be created in the link target');
  });

  test('gsd_receipt_path refuses a symlinked .gsd-returns/.gitignore and leaves its target untouched', (t) => {
    const f = fixture(t);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5182-outside-'));
    t.after(() => cleanup(outside));
    const returns = path.join(f.dir, 'ph', '.gsd-returns');
    fs.mkdirSync(returns, { recursive: true });
    const victim = path.join(outside, 'victim.txt');
    fs.writeFileSync(victim, 'ORIGINAL\n');
    if (!symlinkOrSkip(t, victim, path.join(returns, '.gitignore'), 'file')) return;
    const script = `${extractStallFunctionsBash()}\ncd ${q(f.dir)}\ngsd_receipt_path ph checker\n`;
    let r = runBashScript(script, []);
    assert.notEqual(r.status, 0, 'a symlinked .gitignore must be refused');
    assert.equal(r.stdout, '', 'a refused receipt prints no path');
    assert.equal(fs.readFileSync(victim, 'utf8'), 'ORIGINAL\n', 'the link target must be unchanged');
    // A dangling link is the write-through case: [ -f ] is false, so an unguarded
    // printf would create the target outside the phase.
    fs.unlinkSync(path.join(returns, '.gitignore'));
    const absent = path.join(outside, 'absent.txt');
    if (!symlinkOrSkip(t, absent, path.join(returns, '.gitignore'), 'file')) return;
    r = runBashScript(script, []);
    assert.notEqual(r.status, 0, 'a dangling .gitignore symlink must be refused');
    assert.equal(r.stdout, '', 'a refused receipt prints no path');
    assert.equal(fs.existsSync(absent), false, 'the dangling target must not be created');
  });

  test('a lost $TS falls back to the dispatch epoch stamped in the receipt name, so the threshold stays reachable', (t) => {
    const f = fixture(t);
    const checker = watchCallOf(sectionOf(readPlanPhase(), CHECKER_SECTION));
    const stale = path.join(f.dir, `checker.${NOW - 11 * 60}.AbCdEfGh`);
    assert.equal(watch('', stale, f.noPlans, checker.markers), 'stalled');
    const fresh = path.join(f.dir, `checker.${NOW}.AbCdEfGh`);
    assert.equal(watch('', fresh, f.noPlans, checker.markers), 'waiting');
  });

  test('a receipt-routed ## ISSUES FOUND with no issue list fails closed (never counted as 0 issues)', () => {
    const step11 = sectionOf(readPlanPhase(), ['## 11. Handle Checker Return', '## 11a.']);
    assert.match(step11, /## ISSUES FOUND[^\n]*11a/, 'a missing issue list routes to 11a, never to a zero count');
  });

  test('both agent definitions carry the receipt rule; the checker writes it with Write, its only write', () => {
    const planner = readFileNormalized(path.join(REPO_ROOT, 'agents', 'gsd-planner.md'));
    const checker = readFileNormalized(path.join(REPO_ROOT, 'agents', 'gsd-plan-checker.md'));
    for (const [label, doc] of [['gsd-planner', planner], ['gsd-plan-checker', checker]]) {
      assert.match(doc, /<return_receipt>/, `${label} must define the <return_receipt> rule`);
    }
    // #5182 AC5: a Bash write is refused by a read-only sandbox (Codex), so the checker
    // declares Write (Group B) and the receipt is its only write.
    assert.match(checker.match(/^tools:.*$/m)[0], /\bWrite\b/, 'the checker declares Write for its receipt');
    const rule = checker.slice(checker.indexOf('**Return receipt (#5182):**'));
    assert.match(rule.slice(0, 600), /the Write tool/, 'the checker receipt rule names the Write tool');
    assert.match(rule.slice(0, 600), /only write/, 'the receipt is the checker\'s only write');
    assert.doesNotMatch(rule.slice(0, 600), /printf/, 'no Bash printf write remains in the checker receipt rule');
    // The limit must hold on spawns that send no receipt (quick, quick-batch, import), so it
    // also lives in <anti_patterns>, outside the receipt-conditional rule.
    const anti = checker.slice(checker.indexOf('<anti_patterns>'), checker.indexOf('</anti_patterns>'));
    assert.match(anti, /DO NOT\*\* use Write on any file except the `<return_receipt>` path/, 'the write limit is unconditional');
  });

  // Prose-contract rows are deliberately reduced to command tokens and one keyword,
  // so rewording the explanation around them does not break the suite.
  test('helpers doc: receipts are removed after routing and the checker receipt is written on every host', () => {
    const doc = readStallHelpersDoc();
    assert.match(doc, /rm -f "\{receipt\}"/, 'the orchestrator removes the receipt after routing');
    assert.match(doc, /Group B report-writer/, 'the checker posture (#767 Group B) is stated');
    assert.doesNotMatch(doc, /refuses that write/, 'the retired read-only degradation is no longer described');
  });

  // -- Review 5477738387 (#5182): physical containment of the receipt directory, hostile
  // phase-dir names, receipt reads that cannot be steered or stalled, a spaced phase dir's
  // freshness signal, and receipt cleanup at every watch.
  const fwd = (p) => p.replace(/\\/g, '/');

  function outsideDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5182-outside-'));
    t.after(() => cleanup(dir));
    return dir;
  }

  // Every entry under `root`, recursively (lstat, so a link is listed, never followed).
  function treeOf(root) {
    const out = [];
    const walk = (d, rel) => {
      for (const name of fs.readdirSync(d).sort()) {
        const r = rel ? `${rel}/${name}` : name;
        out.push(r);
        const st = fs.lstatSync(path.join(d, name));
        if (st.isDirectory()) walk(path.join(d, name), r);
      }
    };
    walk(root, '');
    return out;
  }

  // gsd_receipt_path run from `cwd`, PHASE_DIR handed over through a file (never argv).
  function receiptPathFrom(f, cwd, phaseDir) {
    const valueFile = path.join(f.dir, 'phase-dir-value.bin');
    fs.writeFileSync(valueFile, phaseDir);
    return runBashScript(`${extractStallFunctionsBash()}\ncd ${q(cwd)}\nIFS= read -r -d '' d < ${q(fwd(valueFile))} || true\ngsd_receipt_path "$d" checker\n`, []);
  }

  test('gsd_receipt_path refuses a symlinked phase directory (relative or absolute) and creates nothing in its target', (t) => {
    const f = fixture(t);
    const outside = outsideDir(t);
    if (!symlinkOrSkip(t, outside, path.join(f.dir, 'ph'), 'dir')) return;
    let ran = 0;
    for (const phaseDir of ['ph', `${f.fwd}/ph`, 'ph/sub']) {
      const r = receiptPathFrom(f, f.dir, phaseDir);
      assert.notEqual(r.status, 0, `${phaseDir}: a symlinked phase dir must be refused`);
      assert.equal(r.stdout, '', `${phaseDir}: a refused receipt prints no path`);
      ran += 1;
    }
    assert.equal(ran, 3);
    assert.deepEqual(treeOf(outside), [], 'nothing may be created in the link target');
  });

  test('gsd_receipt_path refuses a phase dir under a symlinked ancestor (.planning linked outside the project)', (t) => {
    const f = fixture(t);
    const outside = outsideDir(t);
    const proj = path.join(f.dir, 'proj');
    fs.mkdirSync(proj);
    fs.mkdirSync(path.join(outside, 'phases', '01-x'), { recursive: true });
    if (!symlinkOrSkip(t, outside, path.join(proj, '.planning'), 'dir')) return;
    const before = treeOf(outside);
    let ran = 0;
    // An existing phase dir reached through the link, a missing one, and the absolute form.
    for (const phaseDir of ['.planning/phases/01-x', '.planning/phases/02-new', `${fwd(proj)}/.planning/phases/01-x`]) {
      const r = receiptPathFrom(f, proj, phaseDir);
      assert.notEqual(r.status, 0, `${phaseDir}: a phase dir that resolves outside the project must be refused`);
      assert.equal(r.stdout, '', `${phaseDir}: a refused receipt prints no path`);
      ran += 1;
    }
    assert.equal(ran, 3);
    assert.deepEqual(treeOf(outside), before, 'nothing may be created outside the project');
  });

  test('gsd_receipt_path refuses a dangling .gsd-returns link and a dangling phase-dir link without creating either target', (t) => {
    const f = fixture(t);
    const outside = outsideDir(t);
    fs.mkdirSync(path.join(f.dir, 'ph'));
    if (!symlinkOrSkip(t, path.join(outside, 'absent-returns'), path.join(f.dir, 'ph', '.gsd-returns'), 'dir')) return;
    if (!symlinkOrSkip(t, path.join(outside, 'absent-phase'), path.join(f.dir, 'ph2'), 'dir')) return;
    let ran = 0;
    for (const phaseDir of ['ph', 'ph2']) {
      const r = receiptPathFrom(f, f.dir, phaseDir);
      assert.notEqual(r.status, 0, `${phaseDir}: a dangling link must be refused`);
      assert.equal(r.stdout, '', `${phaseDir}: a refused receipt prints no path`);
      ran += 1;
    }
    assert.equal(ran, 2);
    assert.deepEqual(treeOf(outside), [], 'no dangling target may be created');
  });

  test('gsd_return_marker ignores a receipt that is a symlink, even to a file holding a marker', (t) => {
    const f = fixture(t);
    const outside = outsideDir(t);
    const target = path.join(outside, 'forged.md');
    fs.writeFileSync(target, '## ISSUES FOUND\n');
    const link = path.join(f.dir, 'receipt-link.md');
    if (!symlinkOrSkip(t, target, link, 'file')) return;
    const m = ` ${q('## VERIFICATION PASSED')} ${q('## ISSUES FOUND')}`;
    assert.equal(runHelpers(`gsd_return_marker ${q(fwd(target))}${m}`), '## ISSUES FOUND', 'control: the target itself carries a marker');
    assert.equal(runHelpers(`gsd_return_marker ${q(fwd(link))}${m}`), '', 'a symlinked receipt is never read');
  });

  test('gsd_return_marker reads at most the first 4096 bytes, so one huge line cannot stall the watch', (t) => {
    const f = fixture(t);
    const m = ` ${q('## PLANNING COMPLETE')}`;
    const run = (content) => {
      fs.writeFileSync(f.receipt, content);
      const r = runBashScript(`${extractStallFunctionsBash()}\ngsd_return_marker ${q(fwd(f.receipt))}${m}\n`, [], { timeoutMs: PROBE_TIMEOUT_MS });
      assert.equal(r.outcome, OUTCOME.EXITED, `the read must finish within ${PROBE_TIMEOUT_MS} ms (outcome ${r.outcome})`);
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    assert.equal(run(`${'x'.repeat(4000)}\n## PLANNING COMPLETE\n`), '## PLANNING COMPLETE', 'a marker inside the first 4096 bytes is found');
    assert.equal(run(`${'x'.repeat(5000)}\n## PLANNING COMPLETE\n`), '', 'a marker past the first 4096 bytes is not read');
    assert.equal(run(`${'a'.repeat(1000000)}\n`), '', 'a 1,000,000-byte line with no marker returns nothing, fast');
    assert.equal(run(`## PLANNING COMPLETE ${'a'.repeat(1000000)}\n`), '## PLANNING COMPLETE', 'a marker opening a 1,000,000-byte line is still found, fast');
  });

  test('gsd_return_marker: a marker ends at end of line, whitespace, CR or a colon; `-x` or a letter is not a boundary', (t) => {
    const f = fixture(t);
    const m = ` ${q('## PLAN COMPLETE')} ${q('## ⚠ Source Audit')}`;
    const run = (content) => {
      fs.writeFileSync(f.receipt, content);
      return runHelpers(`gsd_return_marker ${q(fwd(f.receipt))}${m}`);
    };
    const cases = [
      ['## PLAN COMPLETE-x\n', ''],
      ['## PLAN COMPLETE.x\n', ''],
      ['## PLAN COMPLETEé\n', ''],
      ['## PLAN COMPLETE x\n', '## PLAN COMPLETE'],
      ['## PLAN COMPLETE\tx\n', '## PLAN COMPLETE'],
      ['## PLAN COMPLETE\r\n', '## PLAN COMPLETE'],
      ['## PLAN COMPLETE\rx\n', '## PLAN COMPLETE'],
      ['## PLAN COMPLETE\n', '## PLAN COMPLETE'],
      ['## ⚠ Source Audit: Unplanned Items Found\n', '## ⚠ Source Audit'],
    ];
    let ran = 0;
    for (const [content, expected] of cases) {
      assert.equal(run(content), expected, JSON.stringify(content));
      ran += 1;
    }
    assert.equal(ran, cases.length);
  });

  test('a spaced PHASE_DIR with a fresh *-PLAN.md reads as active, not stalled (the glob is expanded quoted)', (t) => {
    const f = fixture(t);
    const markers = watchCallOf(sectionOf(readPlanPhase(), PLANNER_SECTION)).markers;
    const spaced = path.join(f.dir, 'sp ace', 'ph');
    fs.mkdirSync(spaced, { recursive: true });
    const glob = `${fwd(spaced)}/*-PLAN.md`;
    assert.equal(watch(NOW - 11 * 60, f.receipt, glob, markers, { interval: 5 }), 'stalled', 'control: no plan yet, past the threshold');
    fs.writeFileSync(path.join(spaced, '01-PLAN.md'), '# plan\n');
    assert.equal(watch(NOW - 11 * 60, f.receipt, glob, markers, { interval: 5 }), 'active', 'a fresh plan in a spaced phase dir is activity');
    // A literal (non-glob) artifact path with a space, as the chunked sites pass it.
    assert.equal(watch(NOW - 11 * 60, f.receipt, `${fwd(spaced)}/01-PLAN.md`, markers, { interval: 5 }), 'active');
  });
});
