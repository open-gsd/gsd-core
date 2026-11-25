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
const { assertNoLeftoverStall } = require('./helpers/stall-leftovers.cjs');
const { runNode, OUTCOME } = processSeam;
const { toLegacyResult } = require('./helpers/git-fixture.cjs');
const { isolatedEnv } = require('./helpers/isolated-env.cjs');
const { PROBE_TIMEOUT_MS, HOOK_FANOUT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { cleanup, createTempProject, readFileNormalized, readWorkflowCombined, runGsdTools } = require('./helpers.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const REPO_ROOT = path.join(__dirname, '..');

// Structural extraction for the prose-contract rows (review 5692447413 Nit 2): a row names an
// anchor token and asserts structural tokens (marker headings, step references, `{receipt}`,
// `gsd_stall_watch`) inside the block that anchor opens, so rewording the prose around them
// cannot break a row while removing the wired token still does. No character windows.
// blockAt: from the anchor to the next blank line (the paragraph or bullet it opens).
function blockAt(doc, anchor) {
  const at = doc.indexOf(anchor);
  assert.notEqual(at, -1, `missing anchor: ${anchor}`);
  const stop = doc.indexOf('\n\n', at);
  const block = doc.slice(at, stop === -1 ? undefined : stop);
  // The block must hold more than the anchor itself, so an anchor whose body was deleted fails here.
  assert.ok(block.length > anchor.length, `empty block at anchor: ${anchor}`);
  return block;
}
// lineWith: the first line of a section holding a structural token.
function lineWith(section, token) {
  assert.ok(section.trim().length > 0, 'section must not be empty');
  const line = section.split('\n').find((l) => l.includes(token));
  assert.ok(line, `no line holds token: ${token}`);
  return line;
}
// lineAfter: the text of the first line holding the anchor token, from the end of the anchor on,
// so the tokens a row then asserts cannot be satisfied by the anchor itself.
function lineAfter(section, anchor) {
  const line = lineWith(section, anchor);
  return line.slice(line.indexOf(anchor) + anchor.length);
}
// inOrder: every token appears, each after the previous one.
function inOrder(text, tokens, label) {
  assert.ok(text.trim().length > 0, `${label || 'text'} must not be empty`);
  assert.ok(tokens.length > 0, `${label || 'text'}: no tokens to assert`);
  let from = 0;
  for (const token of tokens) {
    const at = text.indexOf(token, from);
    assert.notEqual(at, -1, `${label || 'text'}: missing or out of order: ${token}`);
    from = at + token.length;
  }
}
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
 * @param {object} [opts]  extra process-seam options (`{ timeoutMs, cwd, input,
 *   killSignal }`), merged over the defaults below, plus `home` (the child's HOME and
 *   USERPROFILE; defaults to the script's own temp dir) and `env` (overrides laid over
 *   the isolated environment, never a whole environment). The child's environment is
 *   always built by `isolatedEnv` (CONTRIBUTING.md "Isolating a child's environment"),
 *   so no ambient `GSD_*`, config-location or session-identity variable reaches the
 *   helpers under test. NOTE the key is `timeoutMs`, not spawnSync's `timeout` — the
 *   seam reads only its own documented options, so a stray `timeout` key is silently
 *   ignored rather than honoured.
 */
function runBashScript(script, args = [], opts = {}) {
  const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2650-sh-'));
  const { home = scriptDir, env: override, ...seamOpts } = opts;
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
      env: isolatedEnv({ home, override }),
      ...seamOpts,
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
    const env = isolatedEnv({ home: tmp });

    const absent = runGsdTools(['config-get', 'planner.stall_detection_enabled', '--raw'], tmp, env);
    assert.equal(absent.success, true, absent.error);
    assert.equal(absent.output, 'true');

    const noConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4570-no-config-'));
    t.after(() => cleanup(noConfig));
    const absentFile = runGsdTools(
      ['config-get', 'planner.stall_detection_enabled', '--raw'],
      noConfig,
      isolatedEnv({ home: noConfig }),
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
    // Dispatcher help tokens (HELP_FLAGS in gsd-tools.cjs, #3019) are a help request wherever they appear in
    // argv, not a value that reaches config-set; the generator must not draw them (#5507). Pinned by the
    // fixed examples below. `-v`/`--version` are rejected with a non-zero exit, so they stay in the domain.
    const helpTokens = ['-h', '--h', '--help', '-?', '--usage'];
    const invalidValue = fc.array(fc.constantFrom(...printable), { minLength: 1, maxLength: 16 })
      .map((chars) => chars.join(''))
      .filter((value) => !['true', 'false', 'null', ...helpTokens].includes(value));

    const rejectedWithoutWrite = fc.property(invalidValue, (value) => {
      const result = runGsdTools(
        ['config-set', 'planner.stall_detection_enabled', value],
        tmp,
        isolatedEnv({ home: tmp }),
      );
      return result.success === false && fs.readFileSync(configPath, 'utf8') === before;
    });

    fc.assert(rejectedWithoutWrite, { numRuns: 20 });
    // #5507: the seed/path of the run that drew "-h" (a dispatcher help token that exits 0). Now that the
    // generator excludes help tokens this draws a different value, so it is a deterministic one-run smoke replay
    // of that seed, not the regression pin — the fixed help-token examples below are the contract.
    fc.assert(rejectedWithoutWrite, { seed: -1201433058, path: '3', endOnFailure: true, numRuns: 1 });
  });

  // #5507: the dispatcher treats a help token ANYWHERE in argv as a help request (#3019): usage, exit 0, the
  // command never runs. That is why the property above must not draw those tokens; this states the contract.
  for (const token of ['-h', '--h', '--help', '-?', '--usage']) {
    test(`config-set with the dispatcher help token ${token} prints usage and leaves config byte-identical`, (t) => {
      const tmp = makeProject(t, { planner: { stall_detection_enabled: true }, sentinel: 'preserve' });
      const configPath = path.join(tmp, '.planning', 'config.json');
      const before = fs.readFileSync(configPath, 'utf8');
      const result = runGsdTools(
        ['config-set', 'planner.stall_detection_enabled', token],
        tmp,
        isolatedEnv({ home: tmp }),
      );
      assert.equal(result.success, true, `${token} is a help request, not a config write: ${result.error}`);
      assert.match(result.output, /^Usage: gsd-tools/m, 'prints the dispatcher usage');
      assert.equal(fs.readFileSync(configPath, 'utf8'), before, 'config.json stays byte-identical');
    });
  }

  for (const value of ['-v', '--version', '-x', '--x', '-', 'abc', '1', 'yes', '[]']) {
    test(`config-set with the non-boolean, non-help value ${JSON.stringify(value)} is still rejected without a write`, (t) => {
      const tmp = makeProject(t, { planner: { stall_detection_enabled: true }, sentinel: 'preserve' });
      const configPath = path.join(tmp, '.planning', 'config.json');
      const before = fs.readFileSync(configPath, 'utf8');
      const result = runGsdTools(
        ['config-set', 'planner.stall_detection_enabled', value],
        tmp,
        isolatedEnv({ home: tmp }),
      );
      assert.equal(result.success, false, `${JSON.stringify(value)} must be rejected`);
      assert.equal(fs.readFileSync(configPath, 'utf8'), before, 'config.json stays byte-identical');
    });
  }

  test('hand-edited non-booleans fail safely to true on both config-get and Config Loader reads', (t) => {
    const tmp = makeProject(t, { planner: { stall_detection_enabled: 'false' } });
    const result = runGsdTools(
      ['config-get', 'planner.stall_detection_enabled', '--raw'],
      tmp,
      isolatedEnv({ home: tmp }),
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
    const home = isolatedEnv({ home: tmp });

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
          env: isolatedEnv({ home: tmp, override: { GSD_HOME: tmp, RUNTIME_DIR: REPO_ROOT, GSD_PROJECT: '', GSD_WORKSTREAM: '' } }),
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), expected, `stored ${JSON.stringify(stored)} resolved incorrectly`);
    }
  });

  test('#3923: stored interval/threshold resolve to a positive integer, or the default', (t) => {
    // Driven through the real config-get seam with the shape `config-set` and
    // `/gsd-config --advanced` write (JSON numbers), plus hand-edited shapes.
    // limit-1 (0) / limit (1) / limit+1 (2) for both keys.
    const helpersBash = extractStallHelpersBash();
    const cases = [
      [undefined, '5', '10'],
      [0, '5', '10'],
      [1, '1', '1'],
      [2, '2', '2'],
      [30, '30', '30'],
      // 9-digit cap so `* 60` cannot overflow: limit-1 / limit / limit+1.
      [99999999, '99999999', '99999999'], [999999999, '999999999', '999999999'], [1000000000, '5', '10'],
      [-1, '5', '10'],
      ['abc', '5', '10'],
      [null, '5', '10'],
    ];
    for (const [stored, expectedInterval, expectedThreshold] of cases) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3923-resolve-'));
      t.after(() => cleanup(tmp));
      fs.mkdirSync(path.join(tmp, '.planning'), { recursive: true });
      const config = stored === undefined
        ? {}
        : { planner: { stall_detect_interval_minutes: stored, stall_threshold_minutes: stored } };
      fs.writeFileSync(path.join(tmp, '.planning', 'config.json'), `${JSON.stringify(config)}\n`);
      const result = runBashScript(
        `${helpersBash}\nprintf '%s %s\\n' "$PLANNER_STALL_INTERVAL_MINUTES" "$PLANNER_STALL_THRESHOLD_MINUTES"\n`,
        [],
        {
          cwd: tmp,
          env: isolatedEnv({ home: tmp, override: { GSD_HOME: tmp, RUNTIME_DIR: REPO_ROOT, GSD_PROJECT: '', GSD_WORKSTREAM: '' } }),
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        result.stdout.trim(),
        `${expectedInterval} ${expectedThreshold}`,
        `stored ${JSON.stringify(stored)} resolved incorrectly`,
      );
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
    const workflow = readPlanPhase();
    const idx = workflow.indexOf('## 7.99. Bounded Stall-Detection Helpers');
    assert.notEqual(idx, -1);
    const nextSectionIdx = workflow.indexOf('## 8. Spawn gsd-planner Agent', idx);
    const section = workflow.slice(idx, nextSectionIdx === -1 ? undefined : nextSectionIdx);
    assert.match(section, /`\{receipt\}` = `gsd_receipt_path "\$\{PHASE_DIR\}" <spawn> "\$\{PROJECT_ROOT\}"`/, 'step 7.99 must bind {receipt} from gsd_receipt_path, anchored on the project root (review 5563209291 Minor 1)');
    // Every bind site passes the project root init resolved (ROOT is required).
    const binds = [...`${workflow}\n${readChunkedPlanningMode()}\n${readStallHelpersDoc()}`.matchAll(/`gsd_receipt_path "\$\{PHASE_DIR\}" [^`]*`/g)].map((m) => m[0]);
    assert.ok(binds.length >= 4, `the bind sites are found (${binds.length})`);
    for (const bind of binds) assert.match(bind, /"\$\{PROJECT_ROOT\}"`$/, `${bind}: passes the project root`);
    assert.match(workflow, /`project_root` \(`PROJECT_ROOT`\)/, 'plan-phase parses project_root from the init JSON');
    // The full binding contract lives in the lazily-loaded reference file to stay
    // under the PRE_PHASE6 cap — verify it is actually there, not just gestured at.
    // #5182 replaced the {outputFile} binding (a host transcript that already holds
    // the prompt and definition text) with the GSD-owned receipt.
    const helpersDoc = readStallHelpersDoc();
    assert.ok(helpersDoc.includes('substitutes the printed absolute path for `{receipt}`'), 'stall-detection-helpers.md must explain the {receipt} binding contract');
    inOrder(blockAt(helpersDoc, '**Plan-checker receipt:**'), ['PASSES', 'touches no `*-PLAN.md`', 'so its receipt', 'only completion signal', 'for this watch'],
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
   * Deliberately tiny (not generous headroom) to force a real `sleep 5.0861`
   * command past the bound within this test's own lifetime, proving an
   * exceeded bound reports TIMED_OUT, not a bare null status.
   */
  const RUN_BASH_SCRIPT_FORCED_TIMEOUT_MS = 250;
  /** The forced stall; a duration no other fixture uses, so a leftover is attributable (#6086). */
  const FORCED_STALL_COMMAND = 'sleep 5.0861';
  /** CLAUDE.md boundary-coverage triple (limit-1/limit/limit+1) on runBashScript's own timeoutMs value-domain validation: a negative bound must be rejected. */
  const RUN_BASH_SCRIPT_TIMEOUT_BOUNDARY_NEGATIVE_MS = -1;
  /** CLAUDE.md boundary-coverage triple (limit-1/limit/limit+1) on runBashScript's own timeoutMs value-domain validation: zero must be rejected, never read as unbounded. Used at both occurrences in this test (the throw assertion and the later leak-check re-throw). */
  const RUN_BASH_SCRIPT_TIMEOUT_BOUNDARY_ZERO_MS = 0;
  /** CLAUDE.md boundary-coverage triple (limit-1/limit/limit+1) on runBashScript's own timeoutMs value-domain validation: the smallest positive bound is valid and must be accepted. */
  const RUN_BASH_SCRIPT_TIMEOUT_BOUNDARY_ONE_MS = 1;

  test('bounds the fan-out with the class norm, and an explicit override still wins', (t) => {
    t.after(() => mock.restoreAll());
    const seen = [];
    mock.method(processSeam, 'runHook', (_target, _args, opts) => {
      seen.push(opts);
      return { outcome: OUTCOME.EXITED, exitCode: 0, stdout: '', stderr: '', timedOut: false, signal: null, killed: false, code: null };
    });

    // An ambient GSD_* variable planted for this test must never reach the child
    // (CONTRIBUTING.md "Isolating a child's environment": isolatedEnv strips every
    // ambient GSD_*, config-location and session-identity key).
    const LEAK = 'GSD_STALL_DETECTION_TEST_LEAK';
    process.env[LEAK] = 'leaked';
    t.after(() => { delete process.env[LEAK]; });

    runBashScript('echo hi\n');
    assert.ok(seen[0].env && typeof seen[0].env === 'object', 'runBashScript must hand the seam an explicit, isolated env');
    assert.equal(seen[0].env[LEAK], undefined, 'an ambient GSD_* variable must not reach the child (isolatedEnv)');
    assert.ok(path.isAbsolute(seen[0].env.HOME) && seen[0].env.HOME !== process.env.HOME,
      'the child HOME must be an isolated absolute path, never the real home');
    assert.equal(seen[0].env.USERPROFILE, seen[0].env.HOME, 'USERPROFILE must follow the isolated HOME');
    assert.equal(seen.length, 1,
      'runBashScript must route through the process seam (CONTRIBUTING.md: never a hand-rolled spawnSync in a suite)');
    assert.equal(seen[0].timeoutMs, HOOK_FANOUT_TIMEOUT_MS,
      `default bound must be the bash-fan-out class norm (${HOOK_FANOUT_TIMEOUT_MS}ms), not a probe-sized literal; got ${seen[0].timeoutMs}`);
    assert.equal(seen[0].interpreter, 'bash', 'the seam must be told to run the script under bash');

    runBashScript('echo hi\n', [], { timeoutMs: RUN_BASH_SCRIPT_OVERRIDE_TIMEOUT_MS });
    assert.equal(seen[1].timeoutMs, RUN_BASH_SCRIPT_OVERRIDE_TIMEOUT_MS, 'an explicit timeoutMs must override the class norm');
  });

  test('a caller-supplied home and env overrides reach the real child, on top of the isolated base', (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5182-home-'));
    t.after(() => cleanup(home));
    const result = runBashScript('printf \'%s|%s|%s\' "$HOME" "$USERPROFILE" "$GSD_STALL_DETECTION_TEST_OVERRIDE"\n', [],
      { home, env: { GSD_STALL_DETECTION_TEST_OVERRIDE: 'set' } });
    assert.equal(result.status, 0, result.stderr);
    // MSYS bash on windows-latest rewrites HOME to POSIX form (`C:\...` -> `/c/...`) at
    // startup and leaves USERPROFILE alone, so the two are compared by their last
    // segment (the mkdtemp name), which survives the conversion, never byte-for-byte.
    const [childHome, childProfile, override] = result.stdout.split('|');
    assert.equal(path.basename(childHome), path.basename(home), 'home must set the child HOME');
    assert.equal(path.basename(childProfile), path.basename(home), 'home must set the child USERPROFILE');
    assert.equal(override, 'set', 'env entries must override the isolated base');
  });

  test('an exceeded bound reports TIMED_OUT, not a bare null status', () => {
    // A real sleep against a deliberately tiny bound. The assertion is on the
    // CLASSIFICATION, never on elapsed time.
    // `exec` so the process the bound kills IS the stall: under a plain `sleep` the bound kills bash and the
    // sleep is reparented and outlives the test (#6086).
    const result = runBashScript(`exec ${FORCED_STALL_COMMAND}\n`, [], { timeoutMs: RUN_BASH_SCRIPT_FORCED_TIMEOUT_MS });
    assert.equal(result.outcome, OUTCOME.TIMED_OUT,
      `an exceeded bound must name itself; got outcome=${result.outcome} status=${result.status}`);
    assert.equal(result.timedOut, true, 'timedOut must be true when the bound is exceeded');
    assertNoLeftoverStall(assert, FORCED_STALL_COMMAND, 'runBashScript forced-timeout stall');
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

// #5451: the stall-detection gate names the config key behind PLANNER_STALL_DETECTION_ENABLED at
// every point of use, so an orchestrator resolving it never has to guess one (it used to try
// `workflow.plan_stall_detection` and fail with "Key not found").
describe('#5451: every stall-detection gate names its config key', () => {
  const nodeFs = require('node:fs');
  const nodePath = require('node:path');
  const WORKFLOWS = nodePath.join(__dirname, '..', 'gsd-core', 'workflows');
  // Exact gate-heading counts: deleting one must fail, not slip past a `> 0` check.
  const FILES = [['plan-phase.md', 3], [nodePath.join('plan-phase', 'steps', 'chunked-planning-mode.md'), 1]];
  const GATE_HEADING = /^\*\*Dispatch\/wait gate — `PLANNER_STALL_DETECTION_ENABLED`.*$/gm;

  for (const [rel, expectedHeadings] of FILES) {
    test(`${rel}: each dispatch/wait gate heading names planner.stall_detection_enabled and its helper step`, () => {
      const text = nodeFs.readFileSync(nodePath.join(WORKFLOWS, rel), 'utf-8');
      const headings = text.match(GATE_HEADING) ?? [];
      assert.equal(headings.length, expectedHeadings, `${rel} gate heading count`);
      for (const heading of headings) {
        assert.ok(heading.includes('planner.stall_detection_enabled'), `gate heading does not name the config key: ${heading}`);
        assert.ok(heading.includes('plan-phase/steps/stall-detection-helpers.md'), `gate heading does not point at the helper step path: ${heading}`);
      }
    });
  }

  test('the chunked per-plan dispatch gate (8.5.2) also names the key where PLANNER_STALL_DETECTION_ENABLED is first used', () => {
    const text = nodeFs.readFileSync(nodePath.join(WORKFLOWS, 'plan-phase', 'steps', 'chunked-planning-mode.md'), 'utf-8');
    const line = require('../gsd-core/bin/lib/text-lines.cjs').splitLines(text).find((l) => l.includes('exactly as today when `PLANNER_STALL_DETECTION_ENABLED`'));
    assert.ok(line, 'the per-plan dispatch line must still exist');
    assert.ok(line.includes('planner.stall_detection_enabled'), `per-plan gate does not name the config key: ${line}`);
  });

  test('the key the headings name is the one the helper step actually resolves', () => {
    const helper = nodeFs.readFileSync(nodePath.join(WORKFLOWS, 'plan-phase', 'steps', 'stall-detection-helpers.md'), 'utf-8');
    assert.match(helper, /PLANNER_STALL_DETECTION_ENABLED=.*config-get planner\.stall_detection_enabled/);
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
// that merely mentions a marker. Pre-fix, every watch call site bound `{outputFile}` (a host-specific handle; on
// Claude Code the subagent JSONL transcript) and `gsd_stall_watch` grepped the
// WHOLE file for the markers. The transcript holds the agent's prompt and its
// definition snapshot before the agent replies, so the watch reported
// `marker_received` at its first check; the revision watch passed no markers, so
// `stalled` was its only exit; a host with no output file could only reach `stalled`.
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
  function runHelpers(call, { interval = 5, threshold = 10, prelude = '' } = {}) {
    const helpersBash = extractStallFunctionsBash();
    const clock = `date() { if [ "$1" = "+%s" ]; then echo ${NOW}; else command date "$@"; fi; }`;
    const script = `${helpersBash}\nsleep() { :; }\n${clock}\n${prelude}\nPLANNER_STALL_INTERVAL_MINUTES=${interval}\nPLANNER_STALL_THRESHOLD_MINUTES=${threshold}\n${call}\n`;
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

  // #5182 hand-back (2026-11-22) and the owner's 2026-11-24 decision: the agent writes its receipt
  // as its LAST tool action, before its final message, so a receipt that held only the marker told
  // the watch an agent was finishing, not what it returned. The receipt now holds the agent's
  // COMPLETE return (marker line first), written atomically, and `gsd_return_body` prints it; the
  // orchestrator routes on it without waiting for the host's completion result.
  const CHECKER_MARKERS = ['## VERIFICATION PASSED', '## ISSUES FOUND'];
  const BODY_CAP_BYTES = 65536;
  // A realistic checker return: a marker line, prose and a YAML issue list, with the characters a
  // shell would mangle (quotes, $, backticks) and a line that looks like a heredoc delimiter.
  const RETURN_BODY = [
    '## ISSUES FOUND',
    '',
    'Phase 1: 2 plans checked. It\'s "not done": $HOME `date` $(echo injected) \\n stay literal.',
    'EOF',
    '```yaml',
    'issues:',
    ...Array.from({ length: 17 }, (_, i) => `  - {plan: "01-0${i % 3}", severity: warning, description: "finding ${i}: it's \\"quoted\\""}`),
    '```',
    'Plans: /tmp/p/01-01-PLAN.md',
  ];

  function writeReceipt(f, text) {
    fs.writeFileSync(f.receipt, text);
  }

  // The fenced snippet under "**Return receipt (#5182):**" in an agent definition.
  function receiptSnippetOf(rel) {
    const md = readFileNormalized(path.join(REPO_ROOT, rel));
    const at = md.indexOf('**Return receipt (#5182):**');
    assert.notEqual(at, -1, `${rel}: has the return receipt rule`);
    const open = md.indexOf('```bash\n', at);
    assert.notEqual(open, -1, `${rel}: the rule carries a bash snippet`);
    return md.slice(open + '```bash\n'.length, md.indexOf('\n```', open));
  }

  const RECEIPT_AGENT_FILES = ['agents/gsd-planner.md', 'agents/gsd-plan-checker.md', 'pi/package-agents/gsd-planner.md', 'pi/package-agents/gsd-plan-checker.md'];

  test('gsd_return_body prints the complete return the agent wrote, and the watch reports it (#5182)', (t) => {
    const f = fixture(t);
    writeReceipt(f, `${RETURN_BODY.join('\n')}\n`);
    assert.equal(runHelpers(`gsd_return_body ${q(f.receipt)}`), RETURN_BODY.join('\n'), 'the body is printed byte for byte');
    assert.equal(watch(NOW, f.receipt, f.noPlans, CHECKER_MARKERS), 'marker_received');
    assert.equal(runHelpers(`gsd_return_marker ${q(f.receipt)} ${CHECKER_MARKERS.map(q).join(' ')}`), '## ISSUES FOUND');
  });

  test('the documented receipt write is atomic and complete, in the agents and their Pi copies (#5182)', (t) => {
    for (const rel of RECEIPT_AGENT_FILES) {
      const f = fixture(t);
      const snippet = receiptSnippetOf(rel);
      assert.ok(snippet.includes("'PATH.part'") && snippet.includes("mv -f 'PATH.part' 'PATH'"), `${rel}: writes PATH.part then renames it`);
      const placeholder = '<your complete return, marker line first>';
      assert.ok(snippet.includes(placeholder), `${rel}: the snippet marks where the return goes`);
      const target = f.receipt.replace(/\\/g, '/');
      const script = `${snippet.replace(placeholder, () => RETURN_BODY.join('\n')).replace(/PATH/g, () => target)}\n`;
      for (const interpreter of [undefined, zshOnPath()].filter((x, i) => i === 0 || x)) {
        if (fs.existsSync(f.receipt)) fs.unlinkSync(f.receipt);
        const r = runBashScript(script, [], interpreter ? { interpreter } : {});
        const shell = interpreter ? 'zsh' : 'bash';
        assert.equal(r.status, 0, `${rel} (${shell}): ${r.stderr}`);
        assert.equal(fs.readFileSync(f.receipt, 'utf8'), `${RETURN_BODY.join('\n')}\n`, `${rel} (${shell}): the receipt is the return, byte for byte`);
        assert.ok(!fs.existsSync(`${f.receipt}.part`), `${rel} (${shell}): no .part file is left`);
      }
      // A failed write publishes nothing: cat fails (the directory is missing), so mv never runs.
      const lost = runBashScript(snippet.replace(placeholder, () => RETURN_BODY.join('\n')).replace(/PATH/g, () => `${target}-missing-dir/r.receipt`) + '\n', []);
      assert.notEqual(lost.status, 0, `${rel}: a failed write exits non-zero`);
      assert.ok(!fs.existsSync(`${f.receipt}-missing-dir`), `${rel}: nothing is created for a failed write`);
    }
  });

  test('planner, checker and their Pi copies carry the same receipt snippet (#5182)', () => {
    const [first, ...rest] = RECEIPT_AGENT_FILES.map(receiptSnippetOf);
    for (const [i, snippet] of rest.entries()) assert.equal(snippet, first, `${RECEIPT_AGENT_FILES[i + 1]} matches ${RECEIPT_AGENT_FILES[0]}`);
  });

  test('gsd_return_body caps the body at 64 KiB: limit-1 and limit whole, limit+1 is no body (a cut body could drop a finding) (#5182)', (t) => {
    const f = fixture(t);
    for (const [size, want] of [[BODY_CAP_BYTES - 1, BODY_CAP_BYTES - 1], [BODY_CAP_BYTES, BODY_CAP_BYTES], [BODY_CAP_BYTES + 1, 0]]) {
      writeReceipt(f, `## ISSUES FOUND\n${'a'.repeat(size - '## ISSUES FOUND\n'.length)}`);
      assert.equal(runHelpers(`gsd_return_body ${q(f.receipt)}`).length, want, `a ${size}-byte receipt prints ${want} bytes`);
    }
  });

  test('gsd_return_body prints nothing for a link, a NUL, a directory, a missing or an empty receipt (#5182)', (t) => {
    const f = fixture(t);
    const body = (file) => runHelpers(`gsd_return_body ${q(file)}`);
    assert.equal(body(f.receipt), '', 'missing');
    writeReceipt(f, '');
    assert.equal(body(f.receipt), '', 'empty');
    writeReceipt(f, '## ISSUES FOUND\nbefore\0after\n');
    assert.equal(body(f.receipt), '', 'a NUL byte in the first 4097 bytes');
    writeReceipt(f, `## ISSUES FOUND\n${'a'.repeat(5000)}\0b\n`);
    assert.equal(body(f.receipt), '', 'a NUL byte after the first 4097 bytes');
    assert.equal(body(f.dir.replace(/\\/g, '/')), '', 'a directory');
    const target = path.join(f.dir, 'real-return.md');
    fs.writeFileSync(target, '## ISSUES FOUND\nreal\n');
    fs.unlinkSync(f.receipt);
    try { fs.symlinkSync(target, f.receipt); } catch { t.skip('no symlink right on this OS; the other cases ran'); return; }
    assert.equal(body(f.receipt), '', 'a symlink is never read');
  });

  // Property (CLAUDE.md: a reader with a budget gets a fast-check row): any text of up to the cap that
  // holds no NUL round-trips byte for byte, and the same text with one NUL put anywhere prints nothing.
  test('gsd_return_body round-trips any NUL-free return up to the cap and refuses it with a NUL (#5182)', (t) => {
    const f = fixture(t);
    const textArb = fc.string({ unit: fc.constantFrom('a', 'Z', ' ', '#', '$', '`', "'", '"', '\\', '-', '\n'), minLength: 1, maxLength: 600 }).filter((x) => x.trim() !== '');
    fc.assert(fc.property(textArb, fc.nat(), (text, at) => {
      const body = `## ISSUES FOUND\n${text}x`;
      writeReceipt(f, body);
      const clean = runHelpers(`gsd_return_body ${q(f.receipt)}`) === body.replace(/\s+$/, '');
      const cut = at % body.length;
      writeReceipt(f, `${body.slice(0, cut)}\0${body.slice(cut)}`);
      return clean && runHelpers(`gsd_return_body ${q(f.receipt)}`) === '';
    }), { seed: 5182, numRuns: 8, examples: [['\n\n', 0], ['a', 15]] });
  });

  test('a half-written .part file is not a receipt (#5182)', (t) => {
    const f = fixture(t);
    writeReceipt({ receipt: `${f.receipt}.part` }, '## VERIFICATION PASSED\nhalf of the retu');
    assert.equal(watch(NOW, f.receipt, f.noPlans, CHECKER_MARKERS), 'waiting');
  });

  test('a marker-only receipt (an agent definition that predates the body) still reports its marker and carries no body (#5182)', (t) => {
    const f = fixture(t);
    writeReceipt(f, '## ISSUES FOUND\n');
    assert.equal(watch(NOW, f.receipt, f.noPlans, CHECKER_MARKERS), 'marker_received');
    assert.equal(runHelpers(`gsd_return_body ${q(f.receipt)}`), '## ISSUES FOUND', 'the marker line is all there is');
  });

  test('step 7.99 routes on the receipt body without waiting for the completion result (#5182)', () => {
    const step = sectionOf(readPlanPhase(), ['## 7.99.', '## 8. ']);
    inOrder(step, ['on `marker_received`', 'the return is `gsd_return_body "{receipt}"`', 'no completion-result wait'], 'the binding paragraph says where the return comes from');
  });

  test('the docs, the changeset, CONTEXT.md and the agent contracts describe the receipt as the complete return (#5182)', () => {
    const changeset = fs.readFileSync(path.join(REPO_ROOT, '.changeset', 'lively-sloths-forage.md'), 'utf8');
    assert.ok(changeset.includes('complete return'), 'the changeset says the receipt holds the complete return');
    for (const rel of ['docs/FEATURES.md', 'docs/features/planner-stall-watchdog.md', 'CONTEXT.md']) {
      assert.ok(readFileNormalized(path.join(REPO_ROOT, rel)).includes('complete return'), `${rel} says the receipt holds the complete return`);
    }
    assert.ok(readFileNormalized(path.join(REPO_ROOT, 'CONTEXT.md')).includes(String(BODY_CAP_BYTES)), 'CONTEXT.md states the body cap this suite pins');
  });

  test('AC1 wiring: all five watch sites bind {receipt}; none binds the host {outputFile}', () => {
    const combined = readWorkflowCombined(PLAN_PHASE_PATH);
    const receiptCalls = (combined.match(/gsd_stall_watch\s+"\$TS"\s+"\{receipt\}"/g) || []).length;
    assert.equal(receiptCalls, 5, `expected 5 gsd_stall_watch "$TS" "{receipt}" call sites, found ${receiptCalls}`);
    assert.doesNotMatch(combined, /gsd_stall_watch\s+"\$TS"\s+"\{outputFile\}"/,
      'no watch may read a host-specific output file (undocumented on Claude Code, absent on other hosts)');
  });

  // Minor 5 (fresh review 2): the marker list and artifact argument of ALL FIVE watch sites, parsed
  // per call, not just the spine; a dropped or renamed marker makes the watch end only stalled.
  test('each of the five watch sites passes its own artifact, markers and bind label (#5182)', () => {
    const plan = readPlanPhase();
    const chunked = readChunkedPlanningMode();
    const PLAN_GLOB = "\"${PHASE_DIR}\"'/*-PLAN.md'";
    const sites = [
      ['planner', sectionOf(plan, PLANNER_SECTION), PLAN_GLOB, ['## PLANNING COMPLETE', '## PHASE SPLIT RECOMMENDED', '## ⚠ Source Audit', '## CHECKPOINT REACHED', '## PLANNING INCONCLUSIVE'], ['`marker_received` -> step 9', '`stalled` -> 9a']],
      ['checker', sectionOf(plan, CHECKER_SECTION), PLAN_GLOB, ['## VERIFICATION PASSED', '## ISSUES FOUND'], []],
      ['revision', sectionOf(plan, REVISION_SECTION), PLAN_GLOB, ['## REVISION COMPLETE', '## REVISION_CONFLICT'], []],
      // The chunked binds sit before each Agent() call (row "each chunked site binds ...").
      ['chunked outline', sectionOf(chunked, ['### 8.5.1 Outline Phase', '### 8.5.2 Per-Plan Tasks']), '"$OUTLINE_FILE"', ['## OUTLINE COMPLETE'], []],
      ['chunked per-plan', sectionOf(chunked, ['### 8.5.2 Per-Plan Tasks', '\u0000']), '"$PLAN_FILE"', ['## PLAN COMPLETE'], ['for THAT entry']],
    ];
    let ran = 0;
    for (const [label, section, artifact, markers, tokens] of sites) {
      const para = rulePara(section);
      const m = para.match(/gsd_stall_watch\s+"\$TS"\s+"\{receipt\}"\s+(\S+?)((?:\s+"[^"]*")*)\)/);
      assert.ok(m, `${label}: the rule paragraph holds a parsable watch call`);
      assert.equal(m[1], artifact, `${label}: watched artifact`);
      assert.deepEqual([...m[2].matchAll(/"([^"]*)"/g)].map((x) => x[1]), markers, `${label}: marker list`);
      if (tokens.length) inOrder(para, tokens, `${label}: routes and bind label`);
      ran += 1;
    }
    assert.equal(ran, 5);
    // The orchestrator-visible spawn labels (helpers) and the step 11 recovery routes.
    inOrder(blockAt(readStallHelpersDoc(), '`gsd_receipt_path "${PHASE_DIR}" <spawn>'), ['`planner`', '`checker`', '`revision`', '`outline`'], 'the helpers name every spawn label');
    const step11 = sectionOf(plan, ['## 11. Handle Checker Return', '## 11a.']);
    inOrder(lineAfter(step11, '**`stalled`:**'), ["11a's recovery choice"], 'a stalled checker surfaces 11a');
    inOrder(lineAfter(step11, 'no recognized marker:**'), ['Filesystem fallback (step 11a)'], 'an unrecognized checker return falls back to 11a');
    // Helpers prose that a row title or the wiring depends on (one key token each).
    const doc = readStallHelpersDoc();
    lineWith(doc, 'A refused write is not fatal');
    lineWith(doc, '`stalled` at the threshold (#5182 ruling');
    lineWith(doc, 'only at the START of a receipt line');
    lineWith(doc, 'of the two ends the wait routes it');
    lineWith(doc, 'treat the return as unrecognized (9a/11a)');
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

  // Review 5904580537 Minor 2: a chunked site that binds {receipt} only in its `true` rule,
  // after the Agent() call, sends the planner a literal `{receipt}` (toggle false, or any
  // toggle in order), and the planner writes a file named `{receipt}` in the project root.
  // Each chunked site binds once, before its Agent() call, for either toggle, and drops
  // the prompt line when gsd_receipt_path prints nothing.
  test('each chunked site binds its own {receipt} once, before its Agent() call, for either toggle (#5182)', () => {
    const chunked = readChunkedPlanningMode();
    const sites = [
      ['chunked outline', sectionOf(chunked, ['### 8.5.1 Outline Phase', '### 8.5.2 Per-Plan Tasks']), 'gsd_receipt_path "${PHASE_DIR}" outline "${PROJECT_ROOT}"'],
      ['chunked per-plan', sectionOf(chunked, ['### 8.5.2 Per-Plan Tasks', '\u0000']), 'gsd_receipt_path "${PHASE_DIR}" "{plan_id}" "${PROJECT_ROOT}"'],
    ];
    let ran = 0;
    for (const [label, section, bind] of sites) {
      assert.equal(section.split('gsd_receipt_path').length - 1, 1, `${label}: exactly one bind`);
      const at = section.indexOf(bind);
      assert.notEqual(at, -1, `${label}: binds with ${bind}`);
      const call = section.indexOf('```javascript');
      assert.notEqual(call, -1, `${label}: the Agent() call is in a javascript fence`);
      assert.ok(at < call, `${label}: the bind comes before the Agent() call`);
      inOrder(lineWith(section, bind), ['either toggle', bind, 'prints nothing', 'drop the `<return_receipt>` line'], `${label}: the bind holds for either toggle and drops the prompt line when refused`);
      assert.ok(!rulePara(section).includes('gsd_receipt_path'), `${label}: the true-only rule no longer binds after dispatch`);
      ran += 1;
    }
    assert.equal(ran, 2);
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
    inOrder(lineAfter(step11, '`marker_received` + `## ISSUES FOUND`'), ['proceed to step 12'], 'ISSUES FOUND must route to step 12');
  });

  // Review 5692447413 Minor 5: with the toggle off the prompt still carries <return_receipt>,
  // so a receipt can still be written; each `false` branch must remove it. All five
  // watch sites: plan-phase.md's planner, checker and revision branches are one-line
  // bullets; chunked-planning-mode.md's outline (8.5.1) and per-plan (8.5.2) branches
  // are paragraphs (the per-plan one is an indented, wrapped bullet), so both files are
  // split on blank lines and a branch is the paragraph that opens with the `false` bullet.
  test('every `false` toggle branch at all five watch sites removes the receipt (#5182)', () => {
    const falseBranches = (doc) => doc.split(/\n\s*\n/).filter((p) => p.trimStart().startsWith('- **`false`:**'));
    const spine = falseBranches(readPlanPhase());
    assert.equal(spine.length, 3, 'planner, checker and revision each have a false branch');
    const chunked = falseBranches(readChunkedPlanningMode());
    assert.equal(chunked.length, 2, 'the chunked outline and per-plan sites each have a false branch');
    for (const b of [...spine, ...chunked]) assert.ok(b.includes('rm -f "{receipt}"'), `false branch must rm the receipt: ${b.trim().split('\n')[0]}`);
    // With no receipt bound (gsd_receipt_path printed nothing) `{receipt}` is `""` and the
    // rm is a no-op; each branch says so itself instead of leaning on the helpers' rule.
    // Each false branch keeps the foreground dispatch and hands the real result to its own step.
    for (const b of [...spine, ...chunked]) assert.ok(b.includes('omit `run_in_background`'), `false branch must dispatch in the foreground: ${b.trim().split('\n')[0]}`);
    assert.ok(spine[0].includes('pass the real returned result to step 9.'), 'the planner false branch hands its result to step 9');
    assert.ok(spine[1].includes('pass the real returned result to step 11.'), 'the checker false branch hands its result to step 11');
    assert.ok(chunked[1].includes('`rm -f "{receipt}"` for that entry'), 'the per-plan false branch cleans up per entry');
    for (const b of [...spine, ...chunked]) inOrder(b, ['rm -f "{receipt}"', '(no-op if unbound)'], `false branch must name the unbound case: ${b.trim().split('\n')[0]}`);
  });

  // Review 5692447413 Minor 1: the revision watch names where a finished revision goes.
  test('the revision watch routes ## REVISION COMPLETE to "Spawn checker again (step 10)" (#5182)', () => {
    const para = sectionOf(readPlanPhase(), REVISION_SECTION).split('\n').find((l) => l.includes('(`revision`)'));
    assert.ok(para, 'the revision ORCHESTRATOR RULE paragraph exists');
    inOrder(para, ['`marker_received`', '`## REVISION COMPLETE`: Spawn checker again (step 10)', '`## REVISION_CONFLICT`'], 'REVISION COMPLETE must route to the checker re-spawn (step 10) before the conflict route');
  });

  // The revision stalled menu and 11a's inline summary list Accept before Retry (byte
  // ceiling); each must say the receipt case is Retry first, the REVISION_CONFLICT rule's
  // order, and the note must qualify the menu as a whole, never its last option "Stop".
  test('the revision stalled menu and 11a note the receipt case is Retry first, ahead of the options (#5182)', () => {
    const plan = readPlanPhase();
    const para = sectionOf(plan, REVISION_SECTION).split('\n').find((l) => l.includes('(`revision`)'));
    assert.ok(para, 'the revision ORCHESTRATOR RULE paragraph exists');
    inOrder(para, ['`stalled`', '(receipt case: Retry first)', '1) Accept as revised, to step 13', '2) Retry', '3) Stop'], 'the revision stalled menu must open with the receipt-case note');
    const s11a = sectionOf(plan, ['## 11a.', '## 12.']);
    inOrder(lineAfter(s11a, '(receipt case: Retry first)'), ['1) Accept verification (treat as `## VERIFICATION PASSED`, continue to step 13)', '2) Retry checker (return to step 10)', '3) Stop'], '11a\'s inline menu must open with the receipt-case note');
    assert.ok(!plan.includes('3) Stop (receipt case'), 'the note must not read as a qualifier of "Stop"');
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
    assert.equal(run(`${filler(62)}## PLANNING COMPLETE\n${filler(10)}`), '## PLANNING COMPLETE', 'a marker on line 63 is found');
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
    // Word and non-word ASCII, non-ASCII letters (must NOT count as a boundary), and
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
      const out = runHelpers(`cd ${q(f.dir)}; P=$(pwd); i=0; while [ -f ${D}/$i.s ]; do IFS= read -r -d '' s < ${D}/$i.s || true; printf '%s\\t%s\\n' "$i" "$(gsd_receipt_path "$P/ph" "$s" "$P")"; i=$((i+1)); done; pwd`);
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
    // other dir is accepted. Each dir is a name under the project root, passed in the
    // absolute form the input contract requires. Values travel through files and are
    // read with -d '' so a newline reaches the helper intact.
    const dirArb = fc.string({ unit: fc.constantFrom(...'ab -\'"$`<>\n\t\r\x01\x1b\x7f'.split('')), minLength: 1, maxLength: 6 }).map((d) => `p${d}`);
    const unsafeDir = (d) => /['"$`<>]/.test(d) || [...d].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
    let accepted = 0;
    let refused = 0;
    fc.assert(fc.property(fc.array(dirArb, { minLength: 1, maxLength: 15 }), (dirs) => {
      const caseDir = fs.mkdtempSync(path.join(f.dir, 'pd-'));
      dirs.forEach((d, i) => fs.writeFileSync(path.join(caseDir, `${i}.d`), d));
      const D = q(caseDir.replace(/\\/g, '/'));
      const out = runHelpers(`cd ${q(f.dir)}; P=$(pwd); i=0; while [ -f ${D}/$i.d ]; do IFS= read -r -d '' d < ${D}/$i.d || true; if gsd_receipt_path "$P/$d" x "$P" >/dev/null; then echo "$i OK"; else echo "$i FAIL"; fi; i=$((i+1)); done`);
      cleanup(caseDir);
      const verdict = new Map(out.split('\n').map((l) => l.split(' ')));
      for (const v of verdict.values()) { if (v === 'OK') accepted += 1; else if (v === 'FAIL') refused += 1; }
      return verdict.size === dirs.length &&
        dirs.every((d, i) => verdict.get(String(i)) === (unsafeDir(d) ? 'FAIL' : 'OK'));
    }), { numRuns: 8, examples: [[['pab', 'p$a']]] });
    assert.ok(accepted > 0 && refused > 0, `the unsafe-dir property must see both verdicts (accepted ${accepted}, refused ${refused})`);
  });

  test('gsd_receipt_path: absolute, unique per call, under <phase>/.gsd-returns/, directory created, label sanitized', (t) => {
    const f = fixture(t);
    const rel = 'phase dir/01-x';
    fs.mkdirSync(path.join(f.dir, rel), { recursive: true });
    const script = `${extractStallFunctionsBash()}\ncd ${q(f.dir)}\nP=$(pwd)\na=$(gsd_receipt_path "$P/"${q(rel)} checker "$P")\nb=$(gsd_receipt_path "$P/"${q(rel)} checker "$P")\nc=$(gsd_receipt_path ${q(`${f.fwd}/${rel}`)} '../01/x y' ${q(f.fwd)})\nprintf '%s\\n' "$a" "$b" "$c"\n[ -d "${rel}/.gsd-returns" ] && echo DIR_OK\n[ -e "$a" ] || echo NOT_PRECREATED\n`;
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
      // A name under the project root in the contract's absolute form ('' stays empty).
      fs.writeFileSync(valueFile, bad === '' ? '' : `${f.fwd}/${bad}`);
      // -d '' reads the whole file, so an embedded or trailing newline reaches the helper.
      const r = runBashScript(`${helpers}\ncd ${q(f.dir)}\nIFS= read -r -d '' d < ${q(valueFile.replace(/\\/g, '/'))} || true\nif out=$(gsd_receipt_path "$d" checker ${q(f.fwd)}); then echo "OK:$out"; else echo FAIL; fi\n`, []);
      assert.equal(r.stdout.trim(), 'FAIL', `phase dir ${JSON.stringify(bad)} must be refused`);
      refused += 1;
    }
    assert.equal(refused, unsafe.length, 'every unsafe phase dir case must run');
    assert.equal(fs.readdirSync(f.dir).filter((n) => n.startsWith('ph') && n !== 'phase-dir-value.txt').length, 0, 'a refused phase dir is never created');
    const r = runBashScript(`${helpers}\ncd ${q(f.dir)}\ngsd_receipt_path "$(pwd)/ph" checker "$(pwd)" >/dev/null && cat ph/.gsd-returns/.gitignore\n`, []);
    assert.equal(r.stdout.trim(), '*', '.gsd-returns/ must ignore its own receipts');
  });

  // A hostile checkout can commit <phase>/.gsd-returns (or its .gitignore) as a
  // symlink; mkdir -p and the .gitignore printf would follow it out of the phase.
  // A skip is allowed only off CI: the CI runners create these links (at 35bf07e37 the
  // Windows shard that ran this file ran every symlink row without a skip), so in CI a
  // refused link fails the row instead of passing it with zero assertions.
  function symlinkOrSkip(t, target, link, type) {
    try {
      fs.symlinkSync(target, link, type === 'dir' && process.platform === 'win32' ? 'junction' : type);
      return true;
    } catch (error) {
      if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code) && !process.env.CI) {
        t.skip(`symlink creation is not available here (${error.code}); CI runs this row`);
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
    const r = runBashScript(`${extractStallFunctionsBash()}\ncd ${q(f.dir)}\ngsd_receipt_path "$(pwd)/ph" checker "$(pwd)"\n`, []);
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
    const script = `${extractStallFunctionsBash()}\ncd ${q(f.dir)}\ngsd_receipt_path "$(pwd)/ph" checker "$(pwd)"\n`;
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

  test('a receipt-routed ## ISSUES FOUND with no issue list fails closed (never counted as 0 issues)', () => {
    const step11 = sectionOf(readPlanPhase(), ['## 11. Handle Checker Return', '## 11a.']);
    inOrder(lineAfter(step11, '`marker_received` + `## ISSUES FOUND`'), ['step 12', '(no issue list: 11a)'], 'a missing issue list routes to 11a, never to a zero count');
    inOrder(blockAt(readStallHelpersDoc(), 'fails closed:'), ['`## ISSUES FOUND`', 'never counted as 0 issues', 'use 11a', 'Retry checker before Accept'], 'the helpers keep the ISSUES FOUND fail-closed polarity');
  });

  // Review 5563209291 Minor 2: step 12 reads the conflict record's fields (CONFLICT_*) from
  // the revision's return body, which a receipt never carries, so a receipt-only
  // ## REVISION_CONFLICT must sit in the fail-closed list beside the other body-needing routes.
  test('a receipt-routed ## REVISION_CONFLICT with no body fails closed (never an empty conflict record)', () => {
    const revisionSection = sectionOf(readPlanPhase(), REVISION_SECTION);
    assert.ok(watchCallOf(revisionSection).markers.includes('## REVISION_CONFLICT'), 'the revision watch passes the conflict marker');
    assert.ok(revisionSection.includes('CONFLICT_DIMENSION'), 'control: step 12 reads conflict fields from the return body');
    const failClosed = blockAt(readStallHelpersDoc(), 'fails closed:');
    inOrder(failClosed, ['`## REVISION_CONFLICT`', 'never writes an', 'empty conflict record'], 'a body-less REVISION_CONFLICT never writes an empty conflict record');
    let ran = 0;
    // Review 5904580537 Minor 1: ## PLANNING INCONCLUSIVE needs its body too (step 9 shows the attempts).
    for (const marker of ['## ISSUES FOUND', '## CHECKPOINT REACHED', '## PHASE SPLIT RECOMMENDED', '## ⚠ Source Audit', '## PLANNING INCONCLUSIVE', '## REVISION_CONFLICT']) {
      assert.ok(failClosed.includes(`\`${marker}\``), `${marker} is in the fail-closed list`);
      ran += 1;
    }
    assert.equal(ran, 6);
  });

  // Review 5904580537 Minor 1: the helpers send a body-less receipt-routed planner marker
  // to 9a "and offer Retry planner before Accept". 9a must carry that route itself, as
  // 11a does: a trigger that covers it, a banner naming the marker, Retry listed before
  // Accept, and a route for DISK_PLANS = 0 with a marker (never accepted as complete).
  test('9a covers a receipt-routed planner marker whose body never arrived: names the marker, Retry first, fails closed at 0 plans', () => {
    inOrder(blockAt(readStallHelpersDoc(), 'fails closed:'), ['`## CHECKPOINT REACHED`', 'use 9a', 'Retry planner before Accept'], 'control: the helpers send a body-less planner marker to 9a');
    const spine9a = sectionOf(readPlanPhase(), ['## 9a. Filesystem Fallback (Planner)', '## 9b.']);
    inOrder(lineWith(spine9a, '**Triggered when:**'), ['no recognized marker', 'receipt-only non-COMPLETE marker'], 'the spine 9a trigger names the receipt case, PLANNING COMPLETE excluded');
    inOrder(lineWith(spine9a, 'If `DISK_PLANS` is greater than 0'), ['(receipt case: Retry first)', 'Accept plans', 'If it is 0', 'receipt case: Retry / Stop'], 'the spine 9a menu orders the receipt case and routes 0 plans');
    const detail = readFileNormalized(path.join(REPO_ROOT, 'gsd-core', 'workflows', 'plan-phase', 'detail', 'elaboration.md'));
    const s9a = sectionOf(detail, ['## § 9a', '## § 9b']);
    inOrder(lineAfter(s9a, 'Fires when'), ['return receipt', 'has not arrived when', 'the watch ends'], '9a\'s trigger covers a receipt-routed marker with no body');
    const at = s9a.indexOf('**If `DISK_PLANS` > 0 and a marker arrived on the receipt without its body:**');
    assert.notEqual(at, -1, '9a has a case for plans on disk and a marker that arrived without its body');
    const receiptCase = s9a.slice(at, s9a.indexOf('**If `DISK_PLANS`', at + 1));
    assert.ok(receiptCase.includes('{MARKER}'), 'the receipt-case banner names the marker that arrived');
    const retry = receiptCase.indexOf('**Retry planner**');
    const accept = receiptCase.indexOf('**Accept plans**');
    assert.ok(retry !== -1 && accept !== -1, 'the receipt case offers both Retry planner and Accept plans');
    assert.ok(retry < accept, 'the receipt case lists Retry planner before Accept plans');
    const zero = s9a.indexOf('**If `DISK_PLANS` is 0 and a marker arrived on the receipt without its body:**');
    assert.notEqual(zero, -1, '9a has a route for no plans on disk and a body-less marker');
    const zeroCase = s9a.slice(zero, s9a.indexOf('**If `DISK_PLANS`', zero + 1));
    assert.ok(zeroCase.includes('{MARKER}') && zeroCase.includes('**Retry planner**'), 'the 0-plan receipt case names the marker and offers Retry planner');
    assert.ok(!zeroCase.includes('**Accept plans**'), 'with no plans on disk there is nothing to accept');
    // Control: the original empty/truncated route keeps its own banner and Accept-first menu.
    assert.ok(s9a.includes('did not emit a PLANNING COMPLETE marker'), 'control: the empty/truncated banner stays');
  });

  // Merge with next 39bb1b367 (#5578): step 11 now reads a ## VERIFICATION PASSED return's body for
  // listed BLOCKER/WARNING entries before proceeding, and a receipt never carries that body, so a
  // receipt-only PASSED must fail closed like the other body-needing routes instead of reaching step 13.
  test('a receipt-routed ## VERIFICATION PASSED with no body fails closed (step 11 reads its findings, #5578)', () => {
    const step11 = sectionOf(readPlanPhase(), ['## 11. Handle Checker Return', '## 11a.']);
    const passedLine = lineAfter(step11, '`marker_received` + `## VERIFICATION PASSED`');
    inOrder(passedLine, ['If the return lists an entry whose severity is', 'BLOCKER', 'WARNING', '`## ISSUES FOUND`', 'step 12'], 'control: step 11 reads the PASSED body (#5578)');
    const checker = watchCallOf(sectionOf(readPlanPhase(), CHECKER_SECTION));
    assert.ok(checker.markers.includes('## VERIFICATION PASSED'), 'control: the checker watch passes the PASSED marker');
    const failClosed = blockAt(readStallHelpersDoc(), 'fails closed:');
    assert.ok(failClosed.includes('`## VERIFICATION PASSED`'), '## VERIFICATION PASSED is in the fail-closed list');
    inOrder(failClosed, ['`## VERIFICATION PASSED`', 'never proceeds to', 'step 13', '11a', 'Retry checker before Accept'], 'a body-less PASSED never proceeds to step 13 on the receipt alone');
    inOrder(passedLine, ['proceed to step 13', '(receipt only, no body as the watch ends: 11a)'], 'step 11 itself points a body-less PASSED at 11a');
  });

  // The helpers send a body-less receipt-routed PASSED or ISSUES FOUND to 11a "and offer Retry
  // checker before Accept". 11a's elaboration must carry that entry route itself: a trigger that
  // covers it, a banner naming the marker that arrived, and Retry listed before Accept.
  test('11a covers a receipt-routed checker marker whose body never arrived: names the marker, Retry before Accept', () => {
    const detail = readFileNormalized(path.join(REPO_ROOT, 'gsd-core', 'workflows', 'plan-phase', 'detail', 'elaboration.md'));
    const s11a = sectionOf(detail, ['## § 11a', '## § 11 thinking-partner']);
    inOrder(lineAfter(s11a, 'Fires when'), ['return receipt', 'has not arrived when', 'the watch ends'], '11a\'s trigger covers a receipt-routed marker with no body');
    const at = s11a.indexOf('a marker arrived on the receipt without its body');
    assert.notEqual(at, -1, '11a has a case for a marker that arrived on the receipt without its body');
    const receiptCase = s11a.slice(at, s11a.indexOf('**If `DISK_PLANS`', at));
    assert.ok(receiptCase.includes('{MARKER}'), 'the receipt-case banner names the marker that arrived');
    const retry = receiptCase.indexOf('**Retry checker**');
    const accept = receiptCase.indexOf('**Accept verification**');
    assert.ok(retry !== -1 && accept !== -1, 'the receipt case offers both Retry checker and Accept verification');
    assert.ok(retry < accept, 'the receipt case lists Retry checker before Accept verification');
    // Control: the original empty/truncated route keeps its own banner and menu.
    assert.ok(s11a.includes('Checker return was empty or truncated'), 'control: the empty/truncated banner stays');
  });

  test('both agent definitions carry the receipt rule; the checker writes it through its shell and declares no Write', () => {
    const planner = readFileNormalized(path.join(REPO_ROOT, 'agents', 'gsd-planner.md'));
    const checker = readFileNormalized(path.join(REPO_ROOT, 'agents', 'gsd-plan-checker.md'));
    for (const [label, doc] of [['gsd-planner', planner], ['gsd-plan-checker', checker]]) {
      assert.match(doc, /<return_receipt>/, `${label} must define the <return_receipt> rule`);
    }
    // #5182 ruling 1 (issuecomment-6648383441): the checker keeps its read-only tools line
    // and writes the receipt with one Bash printf; a refused write (a read-only sandbox) is
    // noted in its return, never fatal.
    inOrder(blockAt(planner, '**Return receipt (#5182):**'), ['<return_receipt>PATH</return_receipt>', 'your LAST action'], 'the planner writes its receipt as its LAST action');
    const tools = checker.match(/^tools:.*$/m)[0];
    assert.doesNotMatch(tools, /\bWrite\b/, 'the checker declares no Write');
    assert.match(tools, /\bBash\b/, 'the checker holds Bash, which writes the receipt');
    // The rule is the paragraph, the snippet fence and the paragraph after it (to the next heading).
    const ruleAt = checker.indexOf('**Return receipt (#5182):**');
    const rule = checker.slice(ruleAt, checker.indexOf('\n## ', ruleAt));
    assert.ok(rule.includes("mv -f 'PATH.part' 'PATH'"), 'the receipt is written with one Bash call that renames a .part file into place');
    inOrder(rule, ['<return_receipt>PATH</return_receipt>', 'your LAST action', 'complete return', 'Make no other write', 'refused', 'in your return'], 'a refused receipt write is noted in the return, never fatal');
    assert.ok(!rule.includes('Write tool'), 'the rule no longer names the Write tool');
    // The limit must hold on spawns that send no receipt (quick, quick-batch, import), so it
    // also lives in <anti_patterns>, outside the receipt-conditional rule.
    const anti = checker.slice(checker.indexOf('<anti_patterns>'), checker.indexOf('</anti_patterns>'));
    assert.ok(anti.includes('`<return_receipt>`'), 'the write limit names the receipt path in <anti_patterns>');
  });

  // Prose-contract rows are reduced to command tokens, so rewording the explanation
  // around them does not break the suite (review 5563209291 Nit 4). The checker's
  // per-host posture is pinned on the installed artifacts in agent-tools.install.test.cjs.
  test('helpers doc: receipts are removed after routing', () => {
    const doc = readStallHelpersDoc();
    assert.match(doc, /rm -f "\{receipt\}"/, 'the orchestrator removes the receipt after routing');
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

  // gsd_receipt_path run from `cwd`, PHASE_DIR and ROOT (the third argument, init's
  // project_root) handed over through files (never argv). `root` is given forward
  // slashes unless `raw` is set; an undefined `root` omits the argument.
  function receiptPathFrom(f, cwd, phaseDir, root, { raw = false } = {}) {
    const valueFile = path.join(f.dir, 'phase-dir-value.bin');
    fs.writeFileSync(valueFile, phaseDir);
    let rootArg = '';
    if (root !== undefined) {
      const rootFile = path.join(f.dir, 'root-value.bin');
      fs.writeFileSync(rootFile, raw ? root : fwd(root));
      rootArg = ` "$r"`;
      return runBashScript(`${extractStallFunctionsBash()}\ncd ${q(cwd)}\nIFS= read -r -d '' d < ${q(fwd(valueFile))} || true\nIFS= read -r -d '' r < ${q(fwd(rootFile))} || true\ngsd_receipt_path "$d" checker${rootArg}\n`, []);
    }
    return runBashScript(`${extractStallFunctionsBash()}\ncd ${q(cwd)}\nIFS= read -r -d '' d < ${q(fwd(valueFile))} || true\ngsd_receipt_path "$d" checker\n`, []);
  }

  // A refusal names its reason in exactly one stderr line with a fixed prefix (the
  // reason text itself is not pinned).
  function assertRefusalReason(r, label) {
    const lines = r.stderr.split('\n').filter(Boolean);
    assert.equal(lines.length, 1, `${label}: one stderr line, got ${JSON.stringify(r.stderr)}`);
    assert.match(lines[0], /^gsd_receipt_path: no receipt: \S/, `${label}: the stderr line names a reason`);
  }

  // Review 5563209291 Minor 1: containment is anchored on the project root the workflow
  // resolved (init's project_root), not on the orchestrator's cwd.
  test('gsd_receipt_path accepts an absolute phase dir under the project root from a cwd outside it, and names the reason when it refuses', (t) => {
    const f = fixture(t);
    const proj = path.join(f.dir, 'proj');
    const phase = path.join(proj, '.planning', 'phases', '01-x');
    fs.mkdirSync(phase, { recursive: true });
    fs.mkdirSync(path.join(proj, 'sub'));
    const sibling = path.join(f.dir, 'sibling');
    fs.mkdirSync(sibling);
    // cwd is a subdirectory of the project, so the phase dir is outside the cwd.
    const ok = receiptPathFrom(f, path.join(proj, 'sub'), fwd(phase), proj);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stderr, '', 'an accepted receipt prints nothing on stderr');
    assert.match(ok.stdout.trim(), /\/proj\/\.planning\/phases\/01-x\/\.gsd-returns\/checker\.\d+\.[A-Za-z0-9]+$/);
    assert.ok(fs.existsSync(path.join(phase, '.gsd-returns', '.gitignore')), 'the receipt directory is created under the phase dir');
    // The same call from a cwd OUTSIDE the project (the orchestrator's cwd no longer matters).
    const fromSibling = receiptPathFrom(f, sibling, fwd(phase), proj);
    assert.equal(fromSibling.status, 0, fromSibling.stderr);
    // Without the root argument nothing anchors the check (the cwd is never used), so it is refused, with a reason.
    const noRoot = receiptPathFrom(f, proj, fwd(phase));
    assert.notEqual(noRoot.status, 0, 'with no root argument the receipt is refused');
    assert.equal(noRoot.stdout, '');
    assertRefusalReason(noRoot, 'no root');
    assert.ok(noRoot.stderr.includes('project root is empty'), 'names the missing root');
    // A phase dir outside the passed root is still refused, and nothing is created there.
    const outside = receiptPathFrom(f, proj, `${fwd(sibling)}/ph`, proj);
    assert.notEqual(outside.status, 0, 'a phase dir outside the project root is refused');
    assertRefusalReason(outside, 'outside the root');
    assert.deepEqual(treeOf(sibling), [], 'nothing is created outside the root');
    // A root that does not resolve refuses rather than falling back.
    const badRoot = receiptPathFrom(f, proj, fwd(phase), path.join(f.dir, 'no-such-root'));
    assert.notEqual(badRoot.status, 0, 'an unresolvable root is refused');
    assertRefusalReason(badRoot, 'unresolvable root');
  });

  test('every gsd_receipt_path refusal names its reason on one stderr line', (t) => {
    const f = fixture(t);
    const proj = path.join(f.dir, 'proj');
    fs.mkdirSync(path.join(proj, 'ph'), { recursive: true });
    const outside = outsideDir(t);
    const P = fwd(proj);
    const cases = [
      [`${P}/ph"ase`, 'unsafe character'],
      [`${P}/ph\nase`, 'control character'],
      ['', 'empty'],
      [`${P}/ph/../ph`, '.. component'],
      [`${P}/ph/./x`, '. component'],
      [`${fwd(outside)}/ph`, 'outside the project'],
      // Review 5904580537 Nit 1: mkdir's own error must not add a second stderr line, and
      // a .gitignore that cannot be written refuses instead of printing a path.
      [`${P}/ph-file`, '.gsd-returns is a regular file'],
      [`${P}/ph-gi`, '.gsd-returns/.gitignore is a directory'],
      // Q-4 and r5 MI-1: a .gitignore other than exactly `*` and a newline could let receipts be
      // committed (`*`, a blank line, then `!*` un-ignores them); so could `!keep`.
      [`${P}/ph-star`, '.gsd-returns/.gitignore is *, a blank line and !*'],
      [`${P}/ph-keep`, '.gsd-returns/.gitignore is !keep'],
    ];
    const reasonOf = { [`${P}/ph-file`]: 'cannot create .gsd-returns', [`${P}/ph-gi`]: '.gsd-returns/.gitignore is not a regular file', [`${P}/ph-star`]: 'not exactly the * line', [`${P}/ph-keep`]: 'not exactly the * line' };
    fs.mkdirSync(path.join(proj, 'ph-star', '.gsd-returns'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'ph-star', '.gsd-returns', '.gitignore'), '*\n\n!*\n');
    fs.mkdirSync(path.join(proj, 'ph-keep', '.gsd-returns'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'ph-keep', '.gsd-returns', '.gitignore'), '!keep\n');
    fs.mkdirSync(path.join(proj, 'ph-file'));
    fs.writeFileSync(path.join(proj, 'ph-file', '.gsd-returns'), 'not a directory\n');
    // A directory named .gitignore is refused before any write is tried.
    fs.mkdirSync(path.join(proj, 'ph-gi', '.gsd-returns', '.gitignore'), { recursive: true });
    if (symlinkOrSkip(t, outside, path.join(proj, 'ph', '.gsd-returns'), 'dir')) cases.push([`${P}/ph`, 'symlinked .gsd-returns']);
    let ran = 0;
    for (const [phaseDir, label] of cases) {
      const r = receiptPathFrom(f, proj, phaseDir, proj);
      assert.notEqual(r.status, 0, `${label}: refused`);
      assert.equal(r.stdout, '', `${label}: no path printed`);
      assertRefusalReason(r, label);
      if (reasonOf[phaseDir]) assert.ok(r.stderr.includes(reasonOf[phaseDir]), `${label}: names ${reasonOf[phaseDir]}`);
      assert.ok(phaseDir === '' || !r.stderr.includes(phaseDir), `${label}: the phase dir itself is never echoed`);
      ran += 1;
    }
    assert.ok(ran >= 10);
  });

  // Option B (#5192): the input contract. PHASE_DIR and ROOT are canonical absolute paths
  // (init's phase_dir and project_root); every other shape is refused, with its reason,
  // before the filesystem is touched. Each phase dir below is missing, so an accepted
  // one would be created.
  test('gsd_receipt_path refuses a phase dir or root outside its input contract before creating anything, and accepts the canonical form', (t) => {
    const f = fixture(t);
    const proj = path.join(f.dir, 'proj');
    fs.mkdirSync(path.join(proj, '.planning', 'phases'), { recursive: true });
    fs.mkdirSync(path.join(proj, 'sub'));
    const P = fwd(proj);
    const ok = `${P}/.planning/phases/01-x`;
    const before = treeOf(f.dir);
    const cases = [
      // [phase dir, root, reason]
      ['new', P, 'phase dir is not absolute'],
      ['.planning/phases/01-x', P, 'phase dir is not absolute'],
      [`${P}/.planning//01-x`, P, 'phase dir has an empty component'],
      [`${P}/./01-x`, P, 'phase dir has a . or .. component'],
      [`${P}/sub/../01-x`, P, 'phase dir has a . or .. component'],
      [`${P}/.planning/phases/01-x/`, P, 'phase dir ends in a separator'],
      [`${P}/a\\b`, P, 'phase dir holds a backslash'],
      [ok, '', 'project root is empty'],
      [ok, 'proj', 'project root is not absolute'],
      [ok, `${P}/`, 'project root ends in a separator'],
      [ok, `${P}/sub/..`, 'project root has a . or .. component'],
      [ok, `${P}/.`, 'project root has a . or .. component'],
      [ok, `${fwd(f.dir)}//proj`, 'project root has an empty component'],
      [ok, `${P}\n`, 'project root holds a quote'],
      [ok, `${P}'`, 'project root holds a quote'],
      // A UNC path starts with an empty component, so it is refused (stated in the contract).
      ['//host/share/proj/ph', P, 'phase dir has an empty component'],
    ];
    // Windows-only ROOT shapes: init's project_root there is the native path with backslashes.
    if (process.platform === 'win32') {
      cases.push([ok, `${proj}\\`, 'project root ends in a separator']);
      cases.push([ok, proj.replace(/\\([^\\]*)$/, '\\\\$1'), 'project root has an empty component']);
    }
    // A drive letter is absolute only where cygpath exists (Git Bash); elsewhere C:/x is a relative name.
    if (process.platform !== 'win32') cases.push(['C:/x', P, 'phase dir is not absolute']);
    for (const [phaseDir, root, why] of cases) {
      const r = receiptPathFrom(f, proj, phaseDir, root, { raw: true });
      const label = `${JSON.stringify(phaseDir)} under ${JSON.stringify(root)}`;
      assert.notEqual(r.status, 0, `${label}: refused`);
      assert.equal(r.stdout, '', `${label}: no path printed`);
      assertRefusalReason(r, label);
      assert.ok(r.stderr.includes(why), `${label}: names "${why}", got ${JSON.stringify(r.stderr)}`);
    }
    const created = treeOf(f.dir).filter((e) => !before.includes(e) && !/^(phase-dir|root)-value\.bin$/.test(e));
    assert.deepEqual(created, [], 'a refused input creates nothing');
    // init's canonical form is accepted, from a cwd outside the project.
    const good = receiptPathFrom(f, f.dir, ok, proj);
    assert.equal(good.status, 0, good.stderr);
    assert.match(good.stdout.trim(), /\/proj\/\.planning\/phases\/01-x\/\.gsd-returns\/checker\.\d+\.[A-Za-z0-9]+$/i);
    // Off Windows (where cygpath -m may respell the drive) the path starts with the phase dir passed in.
    if (process.platform !== 'win32') assert.ok(good.stdout.trim().startsWith(`${ok}/.gsd-returns/checker.`), good.stdout);
    // On Windows init's project_root is the native path (backslashes, no toPosixPath);
    // it is accepted as given.
    if (process.platform === 'win32') {
      const native = receiptPathFrom(f, f.dir, ok, proj, { raw: true });
      assert.equal(native.status, 0, native.stderr);
    }
  });

  // The contract as an oracle: a phase dir built from tokens (absolute under the root or
  // relative; segments plain, spaced, empty, `.`, `..` or holding a backslash; an optional
  // trailing slash), a ROOT drawn from canonical and non-canonical shapes, and a label of 0 to
  // 300 safe characters. A case is accepted iff both paths meet the contract; an accepted one
  // gets a receipt under its own .gsd-returns/ whose label is the first 64 characters; a
  // refused one prints nothing and one stderr line that echoes neither path.
  test('property: gsd_receipt_path accepts a generated phase dir and root iff both meet the input contract', (t) => {
    const f = fixture(t);
    const win = process.platform === 'win32';
    const segArb = fc.constantFrom('a', 'b c', 'd-1', '', '.', '..', 'x\\y');
    // ROOT shapes: canonical (ok, and a filesystem root `/` off Windows) and refused ones.
    const rootKinds = ['ok', 'ok', 'fsroot', 'trail', 'dot', 'dotdot', 'rel', 'empty', 'dslash', 'quote', 'newline', 'drive'];
    const caseArb = fc.record({
      abs: fc.boolean(), segs: fc.array(segArb, { minLength: 1, maxLength: 4 }), trail: fc.boolean(),
      root: fc.constantFrom(...rootKinds),
      label: fc.string({ unit: fc.constantFrom('a', 'Z', '9', '_', '-'), maxLength: 300 }),
    });
    const phaseMeets = ({ abs, segs, trail }) => abs && !trail && segs.every((s) => s !== '' && s !== '.' && s !== '..' && !s.includes('\\'));
    // On Windows `/` is Git Bash's own root (not above the temp dir) and C:/x is absolute there.
    const rootMeets = (k) => k === 'ok' || (k === 'fsroot' && !win) || (k === 'drive' && win);
    const rootOf = (k, P) => ({
      ok: P, fsroot: '/', trail: `${P}/`, dot: `${P}/.`, dotdot: `${P}/a/..`, rel: 'rel', empty: '',
      dslash: P.replace(/\/([^/]*)$/, '//$1'), quote: `${P}'q`, newline: `${P}\n`, drive: win ? P : 'C:/x',
    })[k];
    const seen = { accepted: 0, refused: 0, long: 0 };
    fc.assert(fc.property(fc.array(caseArb, { minLength: 1, maxLength: 12 }), (cases) => {
      const proj = fs.mkdtempSync(path.join(f.dir, 'ct-'));
      fs.mkdirSync(path.join(proj, 'a'));
      const caseDir = fs.mkdtempSync(path.join(f.dir, 'ctc-'));
      const P = fwd(proj);
      const dirs = cases.map(({ abs, segs, trail }) => (abs ? `${P}/` : '') + segs.join('/') + (trail ? '/' : ''));
      cases.forEach((c, i) => {
        fs.writeFileSync(path.join(caseDir, `${i}.d`), dirs[i]);
        fs.writeFileSync(path.join(caseDir, `${i}.r`), rootOf(c.root, P));
        fs.writeFileSync(path.join(caseDir, `${i}.l`), c.label);
      });
      const D = q(fwd(caseDir));
      const r = runBashScript(`${extractStallFunctionsBash()}\ncd ${q(proj)}\ni=0; while [ -f ${D}/$i.d ]; do IFS= read -r -d '' d < ${D}/$i.d || true; IFS= read -r -d '' rt < ${D}/$i.r || true; IFS= read -r -d '' l < ${D}/$i.l || true; out=$(gsd_receipt_path "$d" "$l" "$rt" 2>${D}/$i.err); printf '%s\\t%s\\t%s\\n' "$i" "$?" "$out"; i=$((i+1)); done\n`, []);
      const rows = new Map(r.stdout.split('\n').filter(Boolean).map((l) => { const [i, rc, out] = l.split('\t'); return [Number(i), { rc, out }]; }));
      const ok = r.status === 0 && cases.every((c, i) => {
        const row = rows.get(i);
        const errText = fs.readFileSync(path.join(caseDir, `${i}.err`), 'utf8');
        const err = splitLines(errText).filter(Boolean);
        if (!(phaseMeets(c) && rootMeets(c.root))) {
          seen.refused += 1;
          const echoed = [dirs[i], rootOf(c.root, P)].some((p) => p.length > 3 && errText.includes(p));
          return row.rc !== '0' && row.out === '' && err.length === 1 && /^gsd_receipt_path: no receipt: \S/.test(err[0]) && !echoed;
        }
        seen.accepted += 1;
        if (c.label.length > 64) seen.long += 1;
        const name = path.posix.basename(row.out);
        return row.rc === '0' && err.length === 0 && row.out.toLowerCase().includes(`/${c.segs.join('/')}/.gsd-returns/`.toLowerCase()) &&
          name.split('.')[0] === (c.label.slice(0, 64) || 'spawn');
      });
      cleanup(caseDir);
      cleanup(proj);
      return ok;
    }), { numRuns: 12, examples: [[[
      { abs: true, segs: ['a', 'b c'], trail: false, root: 'ok', label: 'x'.repeat(200) },
      { abs: false, segs: ['a'], trail: false, root: 'ok', label: 'x' },
      { abs: true, segs: ['a', ''], trail: false, root: 'ok', label: '' },
      { abs: true, segs: ['a'], trail: true, root: 'ok', label: 'x' },
      { abs: true, segs: ['a'], trail: false, root: 'trail', label: 'x' },
    ]]] });
    assert.ok(seen.accepted > 0 && seen.refused > 0 && seen.long > 0, `accepted, refused and long-label cases all occur (${JSON.stringify(seen)})`);
  });

  // r5 MI-1, generated: a .gsd-returns/.gitignore built from `*`, `!*`, `!keep`, blank lines,
  // spaces, CR, NUL and comment tokens is accepted iff it is exactly `*` and a newline.
  test('property: an existing .gsd-returns/.gitignore is accepted iff it is exactly the * line', (t) => {
    const f = fixture(t);
    const P = f.fwd;
    const tokArb = fc.constantFrom('*', '\n', '!*', '!keep', ' ', '\r', '\0', '#x', '/*');
    const seen = { accepted: 0, refused: 0 };
    fc.assert(fc.property(fc.array(fc.array(tokArb, { maxLength: 5 }).map((a) => a.join('')), { minLength: 1, maxLength: 10 }), (contents) => {
      const base = fs.mkdtempSync(path.join(f.dir, 'gi-'));
      const script = contents.map((content, i) => {
        fs.mkdirSync(path.join(base, `p${i}`, '.gsd-returns'), { recursive: true });
        fs.writeFileSync(path.join(base, `p${i}`, '.gsd-returns', '.gitignore'), content);
        return `if gsd_receipt_path ${q(`${fwd(base)}/p${i}`)} x ${q(P)} >/dev/null 2>${q(`${fwd(base)}/e${i}`)}; then echo "${i} OK"; else echo "${i} FAIL"; fi`;
      }).join('\n');
      const r = runBashScript(`${extractStallFunctionsBash()}\n${script}\n`, []);
      const verdict = new Map(r.stdout.split('\n').filter(Boolean).map((l) => l.split(' ')));
      const ok = r.status === 0 && contents.every((content, i) => {
        const exact = content === '*\n';
        if (exact) seen.accepted += 1; else seen.refused += 1;
        const err = splitLines(fs.readFileSync(path.join(base, `e${i}`), 'utf8')).filter(Boolean);
        return verdict.get(String(i)) === (exact ? 'OK' : 'FAIL') && err.length === (exact ? 0 : 1);
      });
      cleanup(base);
      return ok;
    }), { numRuns: 10, examples: [[['*\n', '*\n\n!*\n', '*', '* \n', '\uFEFF*\n', '*\r\n']]] });
    assert.ok(seen.accepted > 0 && seen.refused > 0, `both verdicts must occur (${JSON.stringify(seen)})`);
  });

  // Pre-push r4 NI-9: the contract is checked against what init actually emits, so a change
  // to init's path form that the helper would refuse fails here, not silently in the field.
  test('gsd_receipt_path accepts the phase_dir and project_root that init plan-phase emits', (t) => {
    const proj = createTempProject('gsd-5182-init-');
    t.after(() => cleanup(proj));
    fs.mkdirSync(path.join(proj, '.planning', 'phases', '01-setup'), { recursive: true });
    const result = runGsdTools('init plan-phase 1 --raw', proj);
    assert.ok(result.success, `init plan-phase failed: ${result.error}`);
    const init = JSON.parse(result.output);
    assert.ok(init.phase_dir && init.project_root, `init emits both paths: ${result.output.slice(0, 200)}`);
    const f = fixture(t);
    const r = receiptPathFrom(f, f.dir, init.phase_dir, init.project_root, { raw: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout.trim(), /\/\.planning\/phases\/01-setup\/\.gsd-returns\/checker\.\d+\.[A-Za-z0-9]+$/);
  });

  // Pre-push r4 MI-1, NI-1, NI-2: a failed cygpath or mktemp refuses with the one stderr line
  // (never a path built from an empty dir), a long label is cut to 64 characters, and the
  // control-character test is the ASCII set whatever the caller's locale.
  test('gsd_receipt_path refuses a failed cygpath or mktemp, cuts a long label, and tests ASCII controls in any locale', (t) => {
    const f = fixture(t);
    const P = f.fwd;
    fs.mkdirSync(path.join(f.dir, 'ph'));
    const helpers = extractStallFunctionsBash();
    for (const [stub, why] of [['cygpath() { return 1; }', 'cygpath failed'], ['cygpath() { :; }', 'cygpath failed'], ['mktemp() { return 1; }', 'mktemp failed']]) {
      const r = runBashScript(`${helpers}\n${stub}\ngsd_receipt_path ${q(`${P}/ph`)} x ${q(P)}\n`, []);
      assert.notEqual(r.status, 0, `${stub}: refused`);
      assert.equal(r.stdout, '', `${stub}: no path printed`);
      assertRefusalReason(r, stub);
      assert.ok(r.stderr.includes(why), `${stub}: names ${why}`);
    }
    const long = runBashScript(`${helpers}\ngsd_receipt_path ${q(`${P}/ph`)} ${q('p'.repeat(300))} ${q(P)}\n`, []);
    assert.equal(long.status, 0, long.stderr);
    const stem = path.posix.basename(long.stdout.trim()).split('.')[0];
    assert.equal(stem, 'p'.repeat(64), 'a long label is cut to 64 characters');
    // Under a UTF-8 locale a C1 control or U+2028 would match [[:cntrl:]]; the contract
    // tests ASCII controls only, so the verdict is the same in every locale.
    const valueFile = path.join(f.dir, 'locale-dir-value.bin');
    for (const [name, refused] of [['u\u0085x', false], ['u x', false], ['u\x01x', true], ['u\x7fx', true]]) {
      fs.writeFileSync(valueFile, `${P}/${name}`);
      // bash always; zsh too when it is on PATH (its locale handling is the other one in use).
      for (const interpreter of [undefined, zshOnPath()].filter((x, i) => i === 0 || x)) {
        for (const lc of ['C', 'C.UTF-8']) {
          const r = runBashScript(`export LC_ALL=${lc}\n${helpers}\nIFS= read -r -d '' d < ${q(fwd(valueFile))} || true\ngsd_receipt_path "$d" x ${q(P)}\n`, [], interpreter ? { interpreter } : {});
          assert.equal(r.status !== 0, refused, `${JSON.stringify(name)} under LC_ALL=${lc} (${interpreter ? 'zsh' : 'bash'}): ${refused ? 'refused' : 'accepted'}`);
        }
      }
    }
  });

  // Review 5692447413 Minor 2: a phase dir that IS the project root, or sits inside
  // .git, would put .gsd-returns/ (and a catch-all .gitignore) where it does not belong.
  test('gsd_receipt_path refuses a phase dir equal to the project root or inside .git, and creates nothing there (#5182)', (t) => {
    const f = fixture(t);
    const proj = path.join(f.dir, 'proj');
    fs.mkdirSync(path.join(proj, '.git', 'objects'), { recursive: true });
    fs.mkdirSync(path.join(proj, 'sub', 'ph'), { recursive: true });
    const cases = [
      [fwd(proj), 'the project root itself'],
      [`${fwd(proj)}/`, 'the project root with a trailing slash'],
      [`${fwd(proj)}/.git`, 'the .git directory'],
      [`${fwd(proj)}/.git/objects`, 'a directory inside .git'],
      [`${fwd(proj)}/.git/new-dir`, 'a missing directory inside .git'],
      // Review 5904580537 Minor 3: on a case-insensitive filesystem (APFS, Windows)
      // `.GIT` and `.Git` are the .git directory, so the refusal ignores case.
      [`${fwd(proj)}/.GIT/objects`, 'a directory inside .GIT'],
      [`${fwd(proj)}/.Git/new-dir`, 'a missing directory inside .Git'],
    ];
    for (const [phaseDir, label] of cases) {
      const r = receiptPathFrom(f, proj, phaseDir, proj);
      assert.notEqual(r.status, 0, `${label}: refused`);
      assert.equal(r.stdout, '', `${label}: no path printed`);
      assertRefusalReason(r, label);
    }
    assert.ok(!fs.existsSync(path.join(proj, '.gsd-returns')), 'nothing is created at the project root');
    assert.ok(!fs.existsSync(path.join(proj, '.git', '.gsd-returns')), 'nothing is created inside .git');
    assert.ok(!fs.existsSync(path.join(proj, '.git', 'objects', '.gsd-returns')), 'nothing is created inside .git/objects');
    assert.ok(!fs.existsSync(path.join(proj, '.GIT', 'objects', '.gsd-returns')), 'nothing is created inside .GIT/objects');
    assert.ok(!fs.existsSync(path.join(proj, '.Git', 'new-dir')), 'nothing is created inside .Git');
    // A normal phase dir under the same root is still accepted.
    const ok = receiptPathFrom(f, proj, `${fwd(proj)}/sub/ph`, proj);
    assert.equal(ok.status, 0, ok.stderr);
  });

  // Review 2026-11-20 Minor 1: Windows reads `GIT~1` (the 8.3 name) as `.git`. The generated
  // segment property draws that name only by chance (8 unseeded runs), so removing the
  // `*/git~1/*` arm left every row green; this row pins it, with the reason named.
  test('gsd_receipt_path refuses a phase dir under GIT~1, in any case, with the inside-.git reason, and creates nothing (#5182)', (t) => {
    const f = fixture(t);
    const proj = path.join(f.dir, 'proj');
    fs.mkdirSync(path.join(proj, 'sub', 'ph'), { recursive: true });
    for (const name of ['GIT~1', 'git~1', 'Git~1']) {
      for (const tail of ['', '/new-dir', '/a/b']) {
        const r = receiptPathFrom(f, proj, `${fwd(proj)}/${name}${tail}`, proj);
        assert.equal(r.status, 1, `${name}${tail}: refused with exit 1`);
        assert.equal(r.stdout, '', `${name}${tail}: no path printed`);
        assert.ok(r.stderr.includes('the phase dir is inside .git'), `${name}${tail}: names the inside-.git reason, got ${JSON.stringify(r.stderr)}`);
      }
    }
    for (const name of ['GIT~1', 'git~1', 'Git~1']) {
      assert.ok(!fs.existsSync(path.join(proj, name)), `nothing is created under ${name}`);
    }
    // Only the exact 8.3 name: `GIT~12` and `xGIT~1` are ordinary names.
    for (const okName of ['GIT~12', 'xGIT~1']) {
      const ok = receiptPathFrom(f, proj, `${fwd(proj)}/${okName}`, proj);
      assert.equal(ok.status, 0, `${okName}: accepted, ${ok.stderr}`);
    }
  });

  // Pre-push review r1 NI-1, NI-2, Q-3 and r2 MI-A.
  test('gsd_receipt_path: a link on the walked path is refused and a doubled slash is refused before anything is created; .git above the root is not the phase dir; a failed .git check refuses; a FIFO .gitignore is refused', (t) => {
    const f = fixture(t);
    const proj = path.join(f.dir, '.GIT', 'proj');
    fs.mkdirSync(path.join(proj, 'real'), { recursive: true });
    const P = fwd(proj);
    // NI-2: an ancestor of the project root named .GIT does not refuse every phase.
    const above = receiptPathFrom(f, proj, `${P}/ph`, proj);
    assert.equal(above.status, 0, above.stderr);
    // NI-1: lnk is a link; lnk/ph is refused by the walk, and a doubled slash by the contract.
    if (symlinkOrSkip(t, path.join(proj, 'real'), path.join(proj, 'lnk'), 'dir')) {
      for (const [d, why] of [[`${P}/lnk/ph`, 'a symlink on the path'], [`${P}/lnk//ph`, 'empty component'], [`${P}/real/x//ph`, 'empty component']]) {
        const r = receiptPathFrom(f, proj, d, proj);
        assert.notEqual(r.status, 0, `${d}: refused`);
        assertRefusalReason(r, d);
        assert.ok(r.stderr.includes(why), `${d}: names ${why}`);
      }
      assert.ok(!fs.existsSync(path.join(proj, 'real', 'x')), 'nothing is created before an empty-component refusal');
      assert.ok(!fs.existsSync(path.join(proj, 'real', 'ph')), 'nothing is created through the link');
    }
    // r2 MI-A and ADR-3409: if the .git test's tr or sed fails, the dir is refused under its
    // own reason (not as a .git hit), and nothing is created.
    for (const [stub, label] of [['sed() { return 1; }', 'failed sed'], ['tr() { return 1; }', 'failed tr']]) {
      const r = runBashScript(`${extractStallFunctionsBash()}\n${stub}\ngsd_receipt_path ${q(`${P}/ph2`)} x ${q(P)}\n`, []);
      assert.notEqual(r.status, 0, `${label}: refused`);
      assertRefusalReason(r, label);
      assert.ok(r.stderr.includes('cannot check the phase dir for .git'), `${label}: names the failed check`);
      assert.ok(!fs.existsSync(path.join(proj, 'ph2')), `${label}: nothing is created`);
    }
    // Q-3: a FIFO named .gitignore would block the write; it is refused, not opened.
    if (process.platform !== 'win32') {
      const fifoPhase = path.join(proj, 'fifo-ph');
      fs.mkdirSync(path.join(fifoPhase, '.gsd-returns'), { recursive: true });
      const made = runBashScript(`mkfifo ${q(path.join(fifoPhase, '.gsd-returns', '.gitignore'))}\n`, []);
      assert.equal(made.status, 0, made.stderr);
      const r = receiptPathFrom(f, proj, `${fwd(proj)}/fifo-ph`, proj);
      assert.notEqual(r.status, 0, 'a FIFO .gitignore is refused');
      assertRefusalReason(r, 'FIFO .gitignore');
      assert.ok(r.stderr.includes('not a regular file'));
      // A project root of `/`: containment is `/*`, not `//*`, so a phase under it is accepted.
      const top = receiptPathFrom(f, proj, `${f.fwd}/top-ph`, '/');
      assert.equal(top.status, 0, top.stderr);
      // A .gitignore that cannot be written (read-only .gsd-returns; root ignores mode bits).
      if (typeof process.getuid === 'function' && process.getuid() !== 0) {
        const ro = path.join(proj, 'ro-ph', '.gsd-returns');
        fs.mkdirSync(ro, { recursive: true });
        fs.chmodSync(ro, 0o555);
        const w = receiptPathFrom(f, proj, `${fwd(proj)}/ro-ph`, proj);
        fs.chmodSync(ro, 0o755);
        assert.notEqual(w.status, 0, 'an unwritable .gitignore is refused');
        assertRefusalReason(w, 'unwritable .gitignore');
        assert.ok(w.stderr.includes('cannot write .gsd-returns/.gitignore'));
      }
    }
  });

  // Minor 3 and Nit 1, generated: a phase dir built from segments that are plain names,
  // `.git` in several letter cases, names that merely contain `git`, `.` and `..`, and names
  // holding a refused character, absolute under the project root. The oracle
  // refuses iff the dir is empty or the project root, a segment holds a quote, `$`, backtick,
  // `<`, `>` or a control character, a segment is `.` or `..`, or a segment lowercases to
  // `.git`. A refusal prints nothing and one prefixed stderr line; an accepted dir prints a
  // path under its own .gsd-returns/ and nothing on stderr.
  test('property: gsd_receipt_path refuses a phase dir iff it is empty or the root, or a segment is unsafe, . or .., or .git in any case; one stderr line per refusal', (t) => {
    const f = fixture(t);
    const segArb = fc.constantFrom('a', 'b c', '.git', '.GIT', '.gIt', '.git.', '.GIT ', 'GIT~1', '.gitx', 'x.git', 'git', '.', '..', 'q"', 'd$', 'e`', 'f<', 'g>', 'h\tt');
    const caseArb = fc.record({ segs: fc.array(segArb, { maxLength: 4 }) });
    const refusedBy = ({ segs }) => (segs.length === 0) ||
      segs.some((s) => /['"$`<>]/.test(s) || [...s].some((c) => c.charCodeAt(0) < 0x20) || s === '.' || s === '..' || ['.git', 'git~1'].includes(s.toLowerCase().replace(/[. ]+$/, '')));
    const seen = { accepted: 0, refused: 0 };
    fc.assert(fc.property(fc.array(caseArb, { minLength: 1, maxLength: 12 }), (cases) => {
      const proj = fs.mkdtempSync(path.join(f.dir, 'rg-'));
      const caseDir = fs.mkdtempSync(path.join(f.dir, 'rgc-'));
      const dirs = cases.map(({ segs }) => [fwd(proj), ...segs].join('/'));
      dirs.forEach((d, i) => fs.writeFileSync(path.join(caseDir, `${i}.d`), d));
      const D = q(fwd(caseDir));
      const r = runBashScript(`${extractStallFunctionsBash()}\ncd ${q(proj)}\ni=0; while [ -f ${D}/$i.d ]; do IFS= read -r -d '' d < ${D}/$i.d || true; out=$(gsd_receipt_path "$d" x ${q(fwd(proj))} 2>${D}/$i.err); printf '%s\\t%s\\t%s\\n' "$i" "$?" "$out"; i=$((i+1)); done\n`, []);
      const rows = new Map(r.stdout.split('\n').filter(Boolean).map((l) => { const [i, rc, out] = l.split('\t'); return [Number(i), { rc, out }]; }));
      const ok = r.status === 0 && cases.every((c, i) => {
        const row = rows.get(i);
        const err = splitLines(fs.readFileSync(path.join(caseDir, `${i}.err`), 'utf8')).filter(Boolean);
        if (refusedBy(c)) {
          seen.refused += 1;
          return row.rc !== '0' && row.out === '' && err.length === 1 && /^gsd_receipt_path: no receipt: \S/.test(err[0]);
        }
        seen.accepted += 1;
        return row.rc === '0' && err.length === 0 && row.out.toLowerCase().includes(`/${c.segs.join('/')}/.gsd-returns/`.toLowerCase());
      });
      cleanup(caseDir);
      cleanup(proj);
      return ok;
    }), { numRuns: 8, examples: [[[{ segs: ['a', '.GIT'] }, { segs: ['b c', 'x.git'] }, { segs: [] }]]] });
    assert.ok(seen.accepted > 0 && seen.refused > 0, `both verdicts must occur (accepted ${seen.accepted}, refused ${seen.refused})`);
  });

  // Review 5563209291 Minor 3: path-shaped generation. Segments are drawn from `a`, `.`,
  // `..` and `link`; `proj/link` and `proj/a/link` are links to a directory outside the
  // project, and a `link` segment anywhere else is a plain (missing) directory name. A dir
  // is absolute under the project or absolute under a sibling outside it.
  // The oracle is the refusal set: a `.` or `..` segment, a `link` segment where the link
  // is, or a sibling base is refused; anything else gets a receipt under <dir>/.gsd-returns/.
  function crossesLink(segs) {
    return segs.some((seg, i) => seg === 'link' && (i === 0 || (i === 1 && segs[0] === 'a')));
  }
  test('property: a path built from a, ., .. and link segments gets a receipt iff it has no . or .., crosses no link and stays under the project root', (t) => {
    const f = fixture(t);
    const proj = path.join(f.dir, 'proj');
    const sibling = path.join(f.dir, 'sibling');
    fs.mkdirSync(path.join(proj, 'a', 'a'), { recursive: true });
    fs.mkdirSync(sibling);
    const outside = outsideDir(t);
    fs.mkdirSync(path.join(outside, 'a', 'a'), { recursive: true });
    if (!symlinkOrSkip(t, outside, path.join(proj, 'link'), 'dir')) return;
    if (!symlinkOrSkip(t, outside, path.join(proj, 'a', 'link'), 'dir')) return;
    const caseArb = fc.record({
      // `a` is weighted so accepted paths are common; one fixed case per side is
      // appended to every run below, so both sides of the oracle always execute.
      segs: fc.array(fc.oneof({ arbitrary: fc.constant('a'), weight: 5 }, fc.constantFrom('.', '..', 'link')), { minLength: 1, maxLength: 4 }),
      base: fc.constantFrom('abs', 'sibling'),
    });
    const P = fwd(proj);
    const S = fwd(sibling);
    let accepted = 0;
    let refused = 0;
    fc.assert(fc.property(fc.array(caseArb, { minLength: 1, maxLength: 12 }), (generated) => {
      const cases = [...generated, { segs: ['a'], base: 'abs' }, { segs: ['link', 'a'], base: 'abs' }];
      const outsideBefore = treeOf(outside);
      const siblingBefore = treeOf(sibling);
      const dirs = cases.map(({ segs, base }) => {
        const rel = segs.join('/');
        return base === 'abs' ? `${P}/${rel}` : `${S}/${rel}`;
      });
      const script = dirs.map((d, i) =>
        `if p=$(gsd_receipt_path ${q(d)} x ${q(P)} 2>/dev/null); then printf '%s\\t%s\\n' ${i} "$p"; else printf '%s\\tFAIL\\n' ${i}; fi`).join('\n');
      const out = runHelpers(`cd ${q(P)}\n${script}`);
      const got = new Map(out.split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('\t')), l.slice(l.indexOf('\t') + 1)]));
      const ok = cases.every(({ segs, base }, i) => {
        const expectRefused = base === 'sibling' || segs.some((s) => s === '.' || s === '..') || crossesLink(segs);
        const p = got.get(String(i));
        if (expectRefused) { refused += 1; return p === 'FAIL'; }
        accepted += 1;
        return p !== 'FAIL' && p.toLowerCase().includes(`/proj/${segs.join('/')}/.gsd-returns/x.`.toLowerCase());
      });
      return ok && got.size === cases.length &&
        JSON.stringify(treeOf(outside)) === JSON.stringify(outsideBefore) &&
        JSON.stringify(treeOf(sibling)) === JSON.stringify(siblingBefore);
    }), { numRuns: 8 });
    assert.ok(accepted > 0 && refused > 0, `both sides of the oracle ran (accepted ${accepted}, refused ${refused})`);
  });

  test('gsd_receipt_path refuses a symlinked phase directory (the dir itself or a missing child) and creates nothing in its target', (t) => {
    const f = fixture(t);
    const outside = outsideDir(t);
    if (!symlinkOrSkip(t, outside, path.join(f.dir, 'ph'), 'dir')) return;
    let ran = 0;
    for (const phaseDir of [`${f.fwd}/ph`, `${f.fwd}/ph/sub`]) {
      const r = receiptPathFrom(f, f.dir, phaseDir, f.dir);
      assert.notEqual(r.status, 0, `${phaseDir}: a symlinked phase dir must be refused`);
      assert.equal(r.stdout, '', `${phaseDir}: a refused receipt prints no path`);
      ran += 1;
    }
    assert.equal(ran, 2);
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
    for (const phaseDir of ['.planning/phases/01-x', '.planning/phases/02-new', '.planning/phases/01-x/sub'].map((d) => `${fwd(proj)}/${d}`)) {
      const r = receiptPathFrom(f, proj, phaseDir, proj);
      assert.notEqual(r.status, 0, `${phaseDir}: a phase dir that resolves outside the project must be refused`);
      assert.equal(r.stdout, '', `${phaseDir}: a refused receipt prints no path`);
      ran += 1;
    }
    assert.equal(ran, 3);
    assert.deepEqual(treeOf(outside), before, 'nothing may be created outside the project');
  });

  test('gsd_receipt_path refuses a phase dir with a .. component and creates nothing outside the project', (t) => {
    // A `..` after a component that does not exist yet passes the ancestor check
    // (the nearest existing ancestor is the project); mkdir -p would then resolve it
    // and create the receipt directory outside. No symlink is involved.
    const f = fixture(t);
    const proj = path.join(f.dir, 'proj');
    fs.mkdirSync(path.join(proj, '.planning'), { recursive: true });
    let ran = 0;
    for (const [phaseDir, escaped] of [
      [`${fwd(proj)}/newdir/../../ESCAPED`, 'ESCAPED'],
      [`${fwd(proj)}/n2/../../ESC2`, 'ESC2'],
      [`${fwd(proj)}/.planning/../../ESC3`, 'ESC3'],
    ]) {
      const r = receiptPathFrom(f, proj, phaseDir, proj);
      assert.notEqual(r.status, 0, `${phaseDir}: a .. component must be refused`);
      assert.equal(r.stdout, '', `${phaseDir}: a refused receipt prints no path`);
      assert.equal(fs.existsSync(path.join(f.dir, escaped)), false, `${phaseDir}: nothing may be created outside the project`);
      ran += 1;
    }
    assert.equal(ran, 3);
  });

  // The rows above link outside the project, so the containment check alone refuses
  // them. A link that stays inside the project is refused only by the walk's own
  // link test: a phase dir that is itself a link, and a link among the components
  // the walk visits (here one that points back at the project, followed by a missing
  // child). An existing phase dir reached through a parent link that stays inside the
  // project is accepted (only the walked components and physical containment are
  // checked), and that row pins the scope of the claim.
  test('gsd_receipt_path refuses an in-project link at the phase dir or on the walked path, and accepts an existing phase dir under an in-project parent link', (t) => {
    const f = fixture(t);
    const proj = path.join(f.dir, 'proj');
    fs.mkdirSync(path.join(proj, '.planning', 'phases'), { recursive: true });
    fs.mkdirSync(path.join(proj, 'inner', 'real'), { recursive: true });
    if (!symlinkOrSkip(t, path.join(proj, 'inner', 'real'), path.join(proj, '.planning', 'phases', '01-link'), 'dir')) return;
    if (!symlinkOrSkip(t, proj, path.join(proj, '.planning', 'up'), 'dir')) return;
    if (!symlinkOrSkip(t, path.join(proj, 'inner'), path.join(proj, '.planning', 'lp'), 'dir')) return;
    let ran = 0;
    for (const phaseDir of ['.planning/phases/01-link', '.planning/up/NEWCHILD'].map((d) => `${fwd(proj)}/${d}`)) {
      const r = receiptPathFrom(f, proj, phaseDir, proj);
      assert.notEqual(r.status, 0, `${phaseDir}: an in-project link at the phase dir or on the walked path must be refused`);
      assert.equal(r.stdout, '', `${phaseDir}: a refused receipt prints no path`);
      ran += 1;
    }
    assert.equal(ran, 2);
    assert.equal(fs.existsSync(path.join(proj, 'inner', 'real', '.gsd-returns')), false, 'nothing is created through the phase-dir link');
    assert.equal(fs.existsSync(path.join(proj, 'NEWCHILD')), false, 'nothing is created through the walked link');
    const ok = receiptPathFrom(f, proj, `${fwd(proj)}/.planning/lp/real`, proj);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout.trim(), /\/\.planning\/lp\/real\/\.gsd-returns\/checker\.\d+\.[A-Za-z0-9]+$/, 'an existing phase dir under an in-project parent link gets a receipt');
  });

  test('gsd_receipt_path refuses a dangling .gsd-returns link and a dangling phase-dir link without creating either target', (t) => {
    const f = fixture(t);
    const outside = outsideDir(t);
    fs.mkdirSync(path.join(f.dir, 'ph'));
    if (!symlinkOrSkip(t, path.join(outside, 'absent-returns'), path.join(f.dir, 'ph', '.gsd-returns'), 'dir')) return;
    if (!symlinkOrSkip(t, path.join(outside, 'absent-phase'), path.join(f.dir, 'ph2'), 'dir')) return;
    let ran = 0;
    for (const phaseDir of [`${f.fwd}/ph`, `${f.fwd}/ph2`]) {
      const r = receiptPathFrom(f, f.dir, phaseDir, f.dir);
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

  // The cap is asserted by output (what is and is not read), never by elapsed time.
  test('gsd_return_marker reads at most the first 4096 bytes, so one huge line cannot stall the watch', (t) => {
    const f = fixture(t);
    const run = (content, marker = '## PLANNING COMPLETE') => {
      fs.writeFileSync(f.receipt, content);
      return runHelpers(`gsd_return_marker ${q(fwd(f.receipt))} ${q(marker)}`);
    };
    assert.equal(run(`${'x'.repeat(4000)}\n## PLANNING COMPLETE\n`), '## PLANNING COMPLETE', 'a marker inside the first 4096 bytes is found');
    assert.equal(run(`${'x'.repeat(5000)}\n## PLANNING COMPLETE\n`), '', 'a marker past the first 4096 bytes is not read');
    assert.equal(run(`${'a'.repeat(1000000)}\n## PLANNING COMPLETE\n`), '', 'a marker after a 1,000,000-byte line is not read');
    assert.equal(run(`## PLANNING COMPLETE ${'a'.repeat(1000000)}\n`), '## PLANNING COMPLETE', 'a marker opening a 1,000,000-byte line is still found');
  });

  // Review 5563209291 Minor 4: limit-1 / limit / limit+1 for the 4096-byte cap. The marker
  // (20 bytes) is placed so its last byte is byte 4095, 4096 or 4097 of the receipt.
  test('gsd_return_marker byte cap: a marker ending at byte 4095 or 4096 is found, at 4097 it is not, and a word cut at the cap is not a marker', (t) => {
    const f = fixture(t);
    const run = (content, marker) => {
      fs.writeFileSync(f.receipt, content);
      return runHelpers(`gsd_return_marker ${q(fwd(f.receipt))} ${q(marker)}`);
    };
    const endingAt = (end, marker, after = '\n') => `${'x'.repeat(end - marker.length - 1)}\n${marker}${after}`;
    const M = '## PLANNING COMPLETE';
    const rows = [
      [endingAt(4095, M), M, M, 'ends at byte 4095 (limit-1)'],
      [endingAt(4096, M), M, M, 'ends at byte 4096 (limit)'],
      [endingAt(4097, M), M, '', 'ends at byte 4097 (limit+1)'],
      [endingAt(4096, M, ''), M, M, 'ends the file at byte 4096 with no newline'],
      [endingAt(4097, M, ''), M, '', 'ends the file at byte 4097 with no newline'],
      // A longer word straddling the cap: `## PLAN COMPLETE` ends at 4096 and `X` is byte
      // 4097. Cutting at 4096 alone would read the marker; the boundary byte is read too.
      [endingAt(4096, '## PLAN COMPLETE', 'X\n'), '## PLAN COMPLETE', '', 'a longer word cut at the cap'],
      [endingAt(4096, '## PLAN COMPLETE', ' x\n'), '## PLAN COMPLETE', '## PLAN COMPLETE', 'control: a real boundary at byte 4097'],
    ];
    let ran = 0;
    for (const [content, marker, expected, label] of rows) {
      assert.equal(Buffer.byteLength(content.split('\n').slice(0, 2).join('\n')) >= 4095, true, `${label}: fixture length`);
      assert.equal(run(content, marker), expected, label);
      ran += 1;
    }
    assert.equal(ran, rows.length);
  });

  // Review 5563209291 Minor 6: only a BOM at the start of the file is stripped.
  test('gsd_return_marker strips a BOM on line 1 only', (t) => {
    const f = fixture(t);
    const run = (content) => {
      fs.writeFileSync(f.receipt, content);
      return runHelpers(`gsd_return_marker ${q(fwd(f.receipt))} ${q('## ISSUES FOUND')}`);
    };
    assert.equal(run('\ufeff## ISSUES FOUND\n'), '## ISSUES FOUND', 'a leading BOM on line 1 is tolerated');
    assert.equal(run('note\n\ufeff## ISSUES FOUND\n'), '', 'a BOM opening line 2 is not stripped, so the line does not start with the marker');
    assert.equal(run('note\n## ISSUES FOUND\n'), '## ISSUES FOUND', 'control: the same line 2 without a BOM matches');
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

  // Review 5692447413 Minor 3: the chunked sites pass a literal file ($OUTLINE_FILE, $PLAN_FILE).
  // A literal name that holds glob metacharacters must be watched as that one file, never
  // expanded as a pattern (under nullglob `outline[1].md` would match nothing while present).
  test('a literal artifact path with glob metacharacters is watched as one file, not expanded (Minor 3)', (t) => {
    const f = fixture(t);
    const literal = path.join(f.dir, 'outline[1].md');
    assert.equal(watch(NOW - 11 * 60, f.receipt, fwd(literal), ['## OUTLINE COMPLETE'], { interval: 5 }), 'stalled', 'control: absent, past the threshold');
    fs.writeFileSync(literal, '# outline\n');
    assert.equal(watch(NOW - 11 * 60, f.receipt, fwd(literal), ['## OUTLINE COMPLETE'], { interval: 5 }), 'active', 'a fresh literal file whose name holds [ ] is activity');
    // A pattern still expands: the same directory's *-PLAN.md glob sees a fresh plan.
    fs.writeFileSync(path.join(f.dir, '01-PLAN.md'), '# plan\n');
    assert.equal(watch(NOW - 11 * 60, f.receipt, `${f.fwd}/*-PLAN.md`, ['## PLAN COMPLETE'], { interval: 5 }), 'active', 'control: a basename pattern still globs');
  });

  // Pre-push r4 NI-4: the literal branch counts regular files only, like the glob branch, so
  // a fresh symlink to an old file is not activity on either path.
  test('a fresh symlink passed as the literal artifact is not activity, like a symlink the glob matches (r4 NI-4)', (t) => {
    const f = fixture(t);
    const old = path.join(f.dir, 'old-outline.md');
    fs.writeFileSync(old, '# outline\n');
    const past = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(old, past, past);
    const link = path.join(f.dir, 'outline.md');
    if (!symlinkOrSkip(t, old, link, 'file')) return;
    assert.equal(watch(NOW - 11 * 60, f.receipt, fwd(link), ['## OUTLINE COMPLETE'], { interval: 5 }), 'stalled', 'a fresh link to an old file is not activity');
    fs.utimesSync(old, new Date(), new Date());
    assert.equal(watch(NOW - 11 * 60, f.receipt, fwd(old), ['## OUTLINE COMPLETE'], { interval: 5 }), 'active', 'control: the fresh regular file itself is activity');
    // Ten literal names (glob characters, spaces, a leading dash or dot): each fresh regular
    // file is activity, and the same name as a fresh link to the old file is not. NTFS has no
    // `*` or `?` in a name, so Windows tries two other names in their place.
    const globNames = process.platform === 'win32' ? ['r(1)-PLAN.md', 'v!-PLAN.md'] : ['s*t-PLAN.md', 'u?-PLAN.md'];
    const names = ['01-PLAN-OUTLINE.md', '02-PLAN.md', 'a b-PLAN.md', '-x-PLAN.md', '.h-PLAN.md', 'q[1]-PLAN.md', ...globNames, 'w{x}-PLAN.md', 'z~-PLAN.md'];
    fs.utimesSync(old, past, past);
    for (const name of names) {
      const file = path.join(f.dir, name);
      fs.writeFileSync(file, '# plan\n');
      assert.equal(watch(NOW - 11 * 60, f.receipt, fwd(file), ['## PLAN COMPLETE'], { interval: 5 }), 'active', `${name}: a fresh regular file is activity`);
      fs.unlinkSync(file);
      if (!symlinkOrSkip(t, old, file, 'file')) return;
      assert.equal(watch(NOW - 11 * 60, f.receipt, fwd(file), ['## PLAN COMPLETE'], { interval: 5 }), 'stalled', `${name}: a fresh link to an old file is not`);
      fs.unlinkSync(file);
    }
  });

  // Pre-push r4 NI-3: bash drops a NUL byte on read and zsh keeps it, so a receipt holding
  // one is never read; both shells agree on "no marker".
  test('gsd_return_marker never reads a receipt with a NUL byte (bash and zsh would disagree)', (t) => {
    const f = fixture(t);
    let ran = 0;
    const zsh = zshOnPath();
    for (const body of ['## ISSUES\0 FOUND\n', '## ISSUES FOUND\n\0\n', Buffer.from('## ISSUES FOUND\n', 'utf16le')]) {
      fs.writeFileSync(f.receipt, body);
      assert.equal(runHelpers(`gsd_return_marker ${q(fwd(f.receipt))} '## ISSUES FOUND'`), '', `${JSON.stringify(String(body))}: no marker (bash)`);
      if (zsh) {
        const z = runBashScript(`${extractStallFunctionsBash()}\ngsd_return_marker ${q(fwd(f.receipt))} '## ISSUES FOUND'\n`, [], { interpreter: zsh });
        assert.equal(z.status, 0, z.stderr);
        assert.equal(z.stdout.trim(), '', `${JSON.stringify(String(body))}: no marker (zsh)`);
      }
      ran += 1;
    }
    assert.equal(ran, 3);
    // A NUL at any of these offsets inside the first 4097 bytes keeps the receipt unread.
    for (const at of [0, 1, 5, 9, 14, 15, 16, 17, 40, 100, 1000, 4000, 4096]) {
      const body = Buffer.alloc(4200, 'x');
      Buffer.from('## ISSUES FOUND\n').copy(body, 0);
      body[at] = 0;
      fs.writeFileSync(f.receipt, body);
      assert.equal(runHelpers(`gsd_return_marker ${q(fwd(f.receipt))} '## ISSUES FOUND'`), '', `NUL at ${at}: no marker`);
    }
    fs.writeFileSync(f.receipt, '## ISSUES FOUND\n');
    assert.equal(runHelpers(`gsd_return_marker ${q(fwd(f.receipt))} '## ISSUES FOUND'`), '## ISSUES FOUND', 'control: a clean receipt is read');
  });

  // -- Review 5477738387 Minor 3: the cleanup is a command at each watch site, not
  // helper prose only. The clause lives in the site's ORCHESTRATOR RULE paragraph,
  // after its gsd_stall_watch call, and names stalled and Retry, so every route of
  // that site (success, ISSUES FOUND, stalled, Retry) removes its receipt.
  function rulePara(section) {
    const at = section.indexOf('ORCHESTRATOR RULE');
    assert.notEqual(at, -1, 'section must hold an ORCHESTRATOR RULE paragraph');
    const stop = section.indexOf('\n\n', at);
    return section.slice(at, stop === -1 ? undefined : stop);
  }

  test('every watch site removes its receipt after routing any result, stalled and Retry included', () => {
    const plan = readPlanPhase();
    const chunked = readChunkedPlanningMode();
    const sites = [
      ['planner', sectionOf(plan, PLANNER_SECTION)],
      ['checker', sectionOf(plan, CHECKER_SECTION)],
      ['revision', sectionOf(plan, REVISION_SECTION)],
      ['chunked outline', sectionOf(chunked, ['### 8.5.1 Outline Phase', '### 8.5.2 Per-Plan Tasks'])],
      ['chunked per-plan', sectionOf(chunked, ['### 8.5.2 Per-Plan Tasks', '\u0000'])],
    ];
    let ran = 0;
    for (const [label, section] of sites) {
      const para = rulePara(section);
      const call = para.search(/gsd_stall_watch\s+"\$TS"\s+"\{receipt\}"/);
      assert.notEqual(call, -1, `${label}: the rule paragraph holds the watch call`);
      // The site's own cleanup clause, after its watch call and outside any menu item: it must be
      // its own clause, so success, conflict, stalled, Retry and Stop all reach it.
      const tail = para.slice(call);
      assert.ok(tail.includes('; after routing any result (stalled/Retry too): `rm -f "{receipt}"`'),
        `${label}: the cleanup clause must be its own ;-separated clause, not part of a menu item`);
      ran += 1;
    }
    assert.equal(ran, 5);
  });

  test('helpers doc: a site with no receipt and no fresh artifact can only end stalled at the threshold', () => {
    const doc = readStallHelpersDoc();
    const limit = blockAt(doc, '**Known limit, no receipt and no fresh artifact:**');
    inOrder(limit, ['checker', 'no receipt', 'touches no `*-PLAN.md`', 'first `PLAN.md`', '`stalled` at the threshold', 'There is no heartbeat protocol'], 'the no-receipt limit names the checker, the planner PLAN.md and stalled at the threshold');
    inOrder(blockAt(doc, '**Known limit, kimi-code:**'), ['`plan`', '`explore`', 'no receipt', '`stalled` at the threshold'], 'the kimi-code limit stays pinned');
  });

  // gsd_receipt_path fails closed (rc=1, no output); the orchestrator must know what to
  // bind then, and an empty receipt argument must behave as "no receipt", never as a match.
  test('a refused receipt (gsd_receipt_path rc=1) drops the prompt line and watches with an empty receipt', (t) => {
    const f = fixture(t);
    const doc = readStallHelpersDoc();
    inOrder(blockAt(doc, 'If `gsd_receipt_path` prints nothing'), ['omit the `<return_receipt>` line', 'pass `""`', "watch's second argument", 'completion result or as `stalled`'],
      'the helpers doc states the binding for a refused receipt');
    const checker = watchCallOf(sectionOf(readPlanPhase(), CHECKER_SECTION));
    assert.equal(watch(NOW, '', f.noPlans, checker.markers), 'waiting', 'an empty receipt is no return');
    assert.equal(watch(NOW - 11 * 60, '', f.noPlans, checker.markers), 'stalled', 'past the threshold an empty receipt ends stalled');
  });

  // -- Review 5477738387 Minor 5 / 5563209291 Minor 5: the *-PLAN.md freshness window
  // (find -mmin -INTERVAL) at its edge, with no wall clock. A `find` shim (a shell
  // function shadows the binary for this script) logs its argv and reports a controlled
  // age, AGE seconds, for every path it is handed: a path is printed iff AGE is under
  // the -mmin window. The rows pin what gsd_stall_watch hands find and how it reads the
  // answer; real find's -mmin parsing is covered by the #2650 row above.
  test('*-PLAN.md freshness boundary: a plan just inside the interval is active, just outside is waiting', (t) => {
    const f = fixture(t);
    const markers = watchCallOf(sectionOf(readPlanPhase(), PLANNER_SECTION)).markers;
    const plan = path.join(f.dir, '01-PLAN.md');
    fs.writeFileSync(plan, '# plan\n');
    const argvLog = path.join(f.dir, 'find-argv.txt');
    const shim = [
      'find() {',
      `  printf '%s\\n' "$@" > ${q(fwd(argvLog))}`,
      // The shim models the two argv shapes the watch hands find: a literal file
      // (`find FILE -maxdepth 0 -type f -mmin -N`), or a directory with a basename pattern
      // (`find DIR -maxdepth 1 -type f -name PATTERN -mmin -N`). It prints each listed
      // file, or each regular file in DIR whose name matches PATTERN, when AGE is
      // inside the window.
      '  local mins="" name="" a e; local -a paths=()',
      '  while [ $# -gt 0 ]; do case "$1" in -mmin) mins="${2#-}"; shift 2 ;; -name) name="$2"; shift 2 ;; -maxdepth|-type) shift 2 ;; -H) shift ;; *) paths+=("$1"); shift ;; esac; done',
      '  [ "$AGE" -lt $(( mins * 60 )) ] || return 0',
      '  for a in "${paths[@]}"; do',
      '    if [ -n "$name" ]; then for e in "$a"/*; do [ -f "$e" ] || continue; case "${e##*/}" in $name) printf \'%s\\n\' "$e" ;; esac; done',
      '    else printf \'%s\\n\' "$a"; fi',
      '  done',
      '  return 0',
      '}',
    ].join('\n');
    const aged = (age, interval, glob = `${f.fwd}/*-PLAN.md`) => {
      cleanup(argvLog);
      const call = `gsd_stall_watch ${q(NOW)} ${q(f.receipt)} ${q(glob)}${markers.map((x) => ` ${q(x)}`).join('')}`;
      return runHelpers(`${shim}\nAGE=${age}\n${call}`, { interval, threshold: 99999 });
    };
    assert.equal(aged(299, 5), 'active', '4m59s old: inside a 5-minute interval');
    assert.deepEqual(splitLines(fs.readFileSync(argvLog, 'utf8')).filter(Boolean),
      ['-H', f.fwd, '-maxdepth', '1', '-type', 'f', '-name', '*-PLAN.md', '-mmin', '-5'],
      'find is handed -H, the quoted phase dir, the basename pattern and the interval as -mmin -N');
    assert.equal(aged(300, 5), 'waiting', '5m00s old: outside a 5-minute interval');
    assert.equal(aged(301, 5), 'waiting', '5m01s old: outside a 5-minute interval');
    assert.equal(aged(300, 7), 'active', 'the window follows the interval: 5m00s is inside 7 minutes');
    assert.equal(splitLines(fs.readFileSync(argvLog, 'utf8')).filter(Boolean).pop(), '-7');
    assert.equal(aged(0, 5, `${f.fwd}/none-*-PLAN.md`), 'waiting', 'a pattern no file matches gives no activity');
    assert.deepEqual(splitLines(fs.readFileSync(argvLog, 'utf8')).filter(Boolean).slice(0, 7),
      ['-H', f.fwd, '-maxdepth', '1', '-type', 'f', '-name'], 'the pattern goes to find unexpanded, beside 01-PLAN.md');
    assert.equal(splitLines(fs.readFileSync(argvLog, 'utf8')).filter(Boolean)[7], 'none-*-PLAN.md');
    aged(0, 5, '/none-*-PLAN.md');
    assert.equal(splitLines(fs.readFileSync(argvLog, 'utf8')).filter(Boolean)[1], '/', 'a root-level pattern searches /, not an empty dir');
  });

  // Review 5904580537 Major 1: the review traced the orchestrator's Bash calls on macOS Claude
  // Code to zsh, which has no `shopt` and does not glob a parameter's value (GLOB_SUBST off), so the old array
  // expansion left the literal pattern in place and a planner still writing plans was
  // reported `stalled`. find now matches the basename itself. This row runs the shipped
  // watch under a real zsh, so it needs a zsh on PATH and is skipped, visibly, where
  // there is none (asked of bash through the process seam, never by splitting PATH here).
  function zshOnPath() {
    const probe = runBashScript('command -v zsh >/dev/null 2>&1 && echo found\n', []);
    return probe.status === 0 && probe.stdout.trim() === 'found' ? 'zsh' : null;
  }

  test('under zsh, a fresh *-PLAN.md in a spaced phase dir reads as active, with no shell error (Major 1)', (t) => {
    const zsh = zshOnPath();
    if (!zsh) { t.skip('no zsh on PATH'); return; }
    const f = fixture(t);
    const phase = path.join(f.dir, 'phase dir');
    fs.mkdirSync(phase);
    fs.writeFileSync(path.join(phase, '01-PLAN.md'), '# plan\n');
    const fwdPhase = phase.replace(/\\/g, '/');
    const markers = watchCallOf(sectionOf(readPlanPhase(), PLANNER_SECTION)).markers;
    const clock = `date() { if [ "$1" = "+%s" ]; then echo ${NOW}; else command date "$@"; fi; }`;
    const run = (glob) => runBashScript([
      extractStallFunctionsBash(), 'sleep() { :; }', clock,
      'PLANNER_STALL_INTERVAL_MINUTES=5', 'PLANNER_STALL_THRESHOLD_MINUTES=10',
      `gsd_stall_watch ${q(NOW - 660)} ${q(f.receipt)} ${q(glob)}${markers.map((x) => ` ${q(x)}`).join('')}`,
    ].join('\n') + '\n', [], { interpreter: zsh });
    const fresh = run(`${fwdPhase}/*-PLAN.md`);
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.equal(fresh.stderr, '', 'the watch runs under zsh with no shell error');
    assert.equal(fresh.stdout.trim(), 'active', 'a fresh plan 660 s after dispatch is activity, not a stall');
    // Control: the same call with a pattern no file matches is past the threshold.
    assert.equal(run(`${fwdPhase}/none-*-PLAN.md`).stdout.trim(), 'stalled', 'control: no matching plan at 660 s is stalled');
  });

  // Pre-push review r1 MI-1: find does not descend a start path that is a symlink unless
  // given -H, so a phase dir committed as a link to a real dir lost its activity signal.
  // A plan file that is itself a link is not a regular file, so it is not activity (-type f).
  test('a fresh *-PLAN.md behind a symlinked phase dir is active; a symlinked plan file is not (-H, -type f)', (t) => {
    const f = fixture(t);
    const real = path.join(f.dir, 'real-phase');
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, '01-PLAN.md'), '# plan\n');
    if (!symlinkOrSkip(t, real, path.join(f.dir, 'linked-phase'), 'dir')) return;
    const markers = watchCallOf(sectionOf(readPlanPhase(), PLANNER_SECTION)).markers;
    assert.equal(watch(NOW - 660, f.receipt, `${f.fwd}/linked-phase/*-PLAN.md`, markers), 'active', 'the link is followed to the fresh plan');
    const other = path.join(f.dir, 'file-link-phase');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(f.dir, 'target.md'), '# plan\n');
    if (!symlinkOrSkip(t, path.join(f.dir, 'target.md'), path.join(other, '01-PLAN.md'), 'file')) return;
    assert.equal(watch(NOW - 660, f.receipt, `${f.fwd}/file-link-phase/*-PLAN.md`, markers), 'stalled', 'a linked plan file is not activity');
  });

  // Major 1, generated: phase dir names with spaces, glob characters, a leading `-` (relative
  // only) and a non-ASCII letter, each holding a drawn set of entries (regular files or
  // directories, fresh or an hour old). The oracle: the signal is active iff some entry is a
  // fresh regular file whose name ends in `-PLAN.md` (find's -name `*` also matches an empty
  // prefix and a leading dot); otherwise the call is stalled at 660 s. Run under bash, and
  // under zsh when one is on PATH, one shell spawn per batch.
  test('property: the *-PLAN.md activity signal matches its oracle under bash and zsh for generated phase dirs and entries (Major 1)', (t) => {
    const f = fixture(t);
    const shells = [['bash', undefined]];
    const zsh = zshOnPath();
    if (zsh) shells.push(['zsh', zsh]); else t.diagnostic('no zsh on PATH: this property ran under bash only');
    // `*` and `?` are left out on Windows, where a file name cannot hold them. A literal
    // entry named `*-PLAN.md` is the literal-path branch, covered by its own row.
    // `!` and `(` lead a relative path that find would otherwise read as an operator.
    // On Windows a name cannot end in a space (Win32 drops it, Git Bash keeps it).
    const segChars = process.platform === 'win32' ? 'ab -[]é\'!(' : 'ab -[]*?é\'!(';
    const segArb = fc.string({ unit: fc.constantFrom(...segChars.split('')), minLength: 1, maxLength: 6 })
      .filter((x) => process.platform !== 'win32' || !x.endsWith(' '));
    const nameArb = fc.constantFrom('01-PLAN.md', 'x-PLAN.md', '-PLAN.md', '.h-PLAN.md', '02-plan.md', 'PLAN.md', '01-PLAN.md.bak', '[1]-PLAN.md', 'a b-PLAN.md');
    const entryArb = fc.record({ name: nameArb, dir: fc.boolean(), fresh: fc.boolean() });
    const caseArb = fc.record({ seg: segArb, rel: fc.boolean(), entries: fc.uniqueArray(entryArb, { selector: (e) => e.name, maxLength: 4 }) });
    const old = new Date(Date.now() - 3600 * 1000);
    const counts = { active: 0, stalled: 0 };
    fc.assert(fc.property(fc.array(caseArb, { minLength: 1, maxLength: 8 }), (cases) => {
      const root = fs.mkdtempSync(path.join(f.dir, 'pp-'));
      const fr = root.replace(/\\/g, '/');
      cases.forEach((c, i) => {
        const d = path.join(root, String(i), c.seg);
        fs.mkdirSync(d, { recursive: true });
        for (const e of c.entries) {
          const p = path.join(d, e.name);
          if (e.dir) fs.mkdirSync(p); else fs.writeFileSync(p, 'x');
          if (!e.fresh) fs.utimesSync(p, old, old);
        }
        fs.writeFileSync(path.join(root, `${i}.g`), c.rel ? `${c.seg}/*-PLAN.md` : `${fr}/${i}/${c.seg}/*-PLAN.md`);
      });
      const expected = cases.map((c) => (c.entries.some((e) => !e.dir && e.fresh && e.name.endsWith('-PLAN.md')) ? 'active' : 'stalled'));
      const clock = `date() { if [ "$1" = "+%s" ]; then echo ${NOW}; else command date "$@"; fi; }`;
      const loop = `i=0; while [ -f ${q(fr)}/$i.g ]; do IFS= read -r g < ${q(fr)}/$i.g || true; printf '%s %s\\n' "$i" "$(cd ${q(fr)}/$i && gsd_stall_watch ${q(NOW - 660)} '' "$g" '## PLANNING COMPLETE')"; i=$((i+1)); done`;
      const ok = shells.every(([, interpreter]) => {
        const r = runBashScript([extractStallFunctionsBash(), 'sleep() { :; }', clock,
          'PLANNER_STALL_INTERVAL_MINUTES=5', 'PLANNER_STALL_THRESHOLD_MINUTES=10', loop].join('\n') + '\n', [], interpreter ? { interpreter } : {});
        const got = new Map(r.stdout.split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf(' ')), l.slice(l.indexOf(' ') + 1)]));
        return r.status === 0 && r.stderr === '' && expected.every((x, i) => got.get(String(i)) === x);
      });
      for (const x of expected) counts[x] += 1;
      cleanup(root);
      return ok;
    }), { numRuns: 6, examples: [[[{ seg: '-a b', rel: true, entries: [{ name: '01-PLAN.md', dir: false, fresh: true }] }, { seg: 'a', rel: false, entries: [{ name: '02-PLAN.md', dir: true, fresh: true }] }]]] });
    assert.ok(counts.active > 0 && counts.stalled > 0, `both outcomes must occur (active ${counts.active}, stalled ${counts.stalled})`);
  });
});
