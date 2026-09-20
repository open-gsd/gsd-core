'use strict';

/**
 * #2351 — `gsd_run run-with-timeout`: a portable, coreutils-independent
 * wall-clock cap for a spawned command, plus the parity guard that keeps
 * hardcoded GNU `timeout` from reappearing in workflow/agent/reference markdown.
 *
 * Root cause it fixes: workflow gates hardcoded `timeout <n> <cmd>`. `timeout`
 * is GNU coreutils; stock macOS ships neither it nor `gtimeout`, so the call
 * exited 127 ("command not found") and a passing build/test was misreported as
 * a FAILURE. The verb replaces every such call with a Node-based cap that keeps
 * GNU `timeout`'s exit-code contract (124 on timeout) on every platform.
 *
 * These are behavioral tests driven through the real CLI entrypoint
 * (spawnSync of gsd-tools.cjs), never source-text assertions. The parity block
 * consumes the lint module's typed findings, not grepped text.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { setTimeout: sleep } = require('node:timers/promises');
const { createTempDir, cleanup } = require('./helpers.cjs');

/**
 * Backstop for spawnSync's OWN hard-kill, guarding against run-with-timeout's
 * internal wall-clock cap failing to fire. Not a measured probe duration —
 * this suite's verb-internal budgets top out at 10s (Windows .cmd/.bat
 * mediation tests), so this preserves ~3x headroom over that ceiling, the
 * pre-existing value unchanged by this migration.
 */
const RUN_WITH_TIMEOUT_HARNESS_BACKSTOP_MS = 30000;

/**
 * Tighter backstop for the tree-reap tests (the C1 POSIX group reap and the
 * #4601 win32 tree kill): their own verb-internal budgets are 2-3s plus ~900ms
 * of heartbeat-settle waits, so this keeps a smaller margin than the file
 * default while still comfortably covering them. Pre-existing value, unchanged
 * (generalized from C1-only to both reap tests by #4601).
 */
const RUN_WITH_TIMEOUT_REAP_BACKSTOP_MS = 20000;

const ROOT = path.join(__dirname, '..');
const GSD_TOOLS = path.join(ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');
const NODE = process.execPath;

// run-with-timeout intercepts before gsd-tools' cwd/workstream resolution, so it
// needs no project fixture — run from a neutral temp dir to prove independence.
function runVerb(args, opts = {}) {
  return spawnSync(NODE, [GSD_TOOLS, 'run-with-timeout', ...args], {
    cwd: os.tmpdir(),
    encoding: 'utf8',
    timeout: RUN_WITH_TIMEOUT_HARNESS_BACKSTOP_MS, // test-harness backstop; the verb's own cap is what we assert
    ...opts,
  });
}

// A guaranteed-hanging child, cross-platform (no reliance on `sleep`).
const HANG = [NODE, '-e', 'setTimeout(() => {}, 60000)'];
// A guaranteed-fast child.
const OK = [NODE, '-e', 'process.exit(0)'];

describe('#2351 run-with-timeout — exit-code contract', () => {
  test('passes a fast zero-exit command through as exit 0', () => {
    const r = runVerb(['5', '--', ...OK]);
    assert.equal(r.status, 0);
  });

  test('passes a non-zero exit code through unchanged', () => {
    const r = runVerb(['5', '--', NODE, '-e', 'process.exit(7)']);
    assert.equal(r.status, 7);
  });

  test('exits 124 when the wall-clock budget is exceeded (matches GNU timeout)', () => {
    const r = runVerb(['1', '--', ...HANG]);
    // exit 124 is itself the discriminator: a harness backstop kill surfaces
    // as status === null (signal), never as 124 — so no elapsed-time
    // assertion is needed or allowed here.
    assert.equal(r.status, 124, 'a timed-out command must exit 124');
  });

  test('exits 127 when the command is not found (matches GNU timeout)', () => {
    const r = runVerb(['5', '--', 'this-command-does-not-exist-2351']);
    assert.equal(r.status, 127);
  });

  test('runs without a timer when <seconds> is 0 — a slow child is NOT killed', () => {
    // Proves 0 = no timer (not "timer fired at 0ms"): a child that outlives any
    // mis-armed timer must still exit 0. A wrongly-armed 0ms timer would give 124.
    const r = runVerb(['0', '--', NODE, '-e', 'setTimeout(() => process.exit(0), 1500)']);
    assert.equal(r.status, 0, '<seconds> 0 must run untimed');
  });

  test('a budget past the 32-bit setTimeout ceiling does not spuriously time out', () => {
    // secs*1000 > 2**31-1 → Node clamps setTimeout to 1ms → an immediate false 124
    // unless the delay is capped. The fast child must still exit 0, with no warning.
    const r = runVerb(['3000000', '--', ...OK]);
    assert.equal(r.status, 0, 'oversized budget must not fire an immediate timeout');
    assert.doesNotMatch(r.stderr || '', /TimeoutOverflowWarning/, 'delay must be clamped');
  });
});

describe('#2351 run-with-timeout — argument handling (negative matrix)', () => {
  test('missing <seconds> is a usage error (exit 2), not a crash', () => {
    const r = runVerb([]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /missing <seconds>/);
    assert.doesNotMatch(r.stderr, /at Object|at Module|\.cjs:\d+/, 'no stack trace in usage error');
  });

  test('non-numeric <seconds> is a usage error (exit 2)', () => {
    const r = runVerb(['not-a-number', '--', ...OK]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /invalid <seconds>/);
  });

  test('blank / whitespace <seconds> is a usage error — never a silent unbounded run', () => {
    for (const blank of ['', '   ']) {
      const r = runVerb([blank, '--', ...OK]);
      assert.equal(r.status, 2, `blank seconds ${JSON.stringify(blank)} must error, not disable the timer`);
      assert.match(r.stderr, /invalid <seconds>/);
    }
  });

  test('missing <command> is a usage error (exit 2)', () => {
    const r = runVerb(['5']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /missing <command>/);
  });

  test('a trailing `s` on the duration is accepted (GNU-style unit)', () => {
    const r = runVerb(['5s', '--', ...OK]);
    assert.equal(r.status, 0);
  });

  test('the `--` separator is optional', () => {
    const r = runVerb(['5', ...OK]);
    assert.equal(r.status, 0);
  });

  test("the wrapped command's argv is opaque — gsd-tools flags are NOT consumed", (t) => {
    // --raw / --cwd / --pick are gsd-tools' own global flags. They must reach the
    // wrapped command verbatim, not be stripped by the dispatcher. Use a script
    // FILE, not `node -e` — node parses leading --flags after -e as its OWN options
    // ("bad option", exit 9); after a script path it treats them as argv.
    const dir = createTempDir('rwt-argv');
    t.after(() => cleanup(dir));
    const script = path.join(dir, 'argcheck.js');
    fs.writeFileSync(script,
      'process.exit(process.argv.slice(2).join(",") === "--raw,--cwd,x,--pick,y" ? 0 : 3);');
    const r = runVerb(['5', '--', NODE, script, '--raw', '--cwd', 'x', '--pick', 'y']);
    assert.equal(r.status, 0, 'wrapped --raw/--cwd/--pick must be passed through untouched');
  });

  test('the `query` meta-prefix form is accepted', () => {
    const r = spawnSync(NODE, [GSD_TOOLS, 'query', 'run-with-timeout', '5', '--', ...OK], {
      cwd: os.tmpdir(), encoding: 'utf8', timeout: RUN_WITH_TIMEOUT_HARNESS_BACKSTOP_MS,
    });
    assert.equal(r.status, 0);
  });
});

describe('#2351 run-with-timeout — kill semantics (POSIX process groups)', () => {
  const posix = process.platform !== 'win32';

  test('a timed-out command whose descendant traps SIGTERM is still reaped — no orphan/hang (C1)', { skip: !posix }, async (t) => {
    // The HIGH-severity regression: the direct child exits on SIGTERM fast, but a
    // descendant that IGNORES SIGTERM survives holding the inherited stdio. The
    // whole process group must be SIGKILL-reaped, or a captured/piped gate hangs
    // on the orphan. A node parent spawns the trapping child in the SAME process
    // group (spawn WITHOUT `detached` → the child inherits the parent's pgid,
    // deterministically, on every platform). We deliberately avoid `bash … &`:
    // bash job-control can move a backgrounded job into its own process group,
    // which no group-kill (nor GNU `timeout`) can reach. The parent exits fast on
    // SIGTERM; the child ignores it and must still be reaped.
    //
    // Liveness is detected by a HEARTBEAT the child rewrites every 100ms — NOT
    // `kill(pid, 0)`: a SIGKILL'd orphan lingers as a zombie until reaped, and a
    // container's PID 1 reaps slowly, so `kill(pid,0)` reads a dead child as
    // "alive". A reaped child stops ticking; a genuine orphan keeps ticking.
    //
    // The child writes its FIRST heartbeat synchronously at startup, before
    // arming the interval, and the kill window is 3s rather than 1s. Both are
    // load-independence requirements, not cosmetics: with the first write
    // deferred to the interval's initial 100ms tick inside a 1s window, a loaded
    // CI container can group-kill before that tick ever lands, and the existence
    // check below then fails for a reason that has nothing to do with reaping —
    // the behavior under test is the FREEZE assertion further down, which is
    // unaffected by writing one extra sample at t=0.
    const dir = createTempDir('rwt-c1');
    t.after(() => cleanup(dir));
    const parentFile = path.join(dir, 'parent.js');
    const hbFile = path.join(dir, 'heartbeat');
    fs.writeFileSync(parentFile, [
      'const cp = require("child_process");',
      "const childCode = 'const fs=require(\"fs\");const hb=process.argv[1];const tick=()=>fs.writeFileSync(hb,String(Date.now()));process.on(\"SIGTERM\",()=>{});tick();setInterval(tick,100);';",
      'cp.spawn(process.execPath, ["-e", childCode, process.argv[2]], { stdio: "ignore" });',
      'process.on("SIGTERM", () => process.exit(0));',
      'setInterval(() => {}, 1000);',
    ].join('\n'));
    const r = runVerb(['3', '--', NODE, parentFile, hbFile], { timeout: RUN_WITH_TIMEOUT_REAP_BACKSTOP_MS });
    assert.equal(r.status, 124, 'must report a timeout (124), not hang');
    assert.ok(fs.existsSync(hbFile), 'child heartbeat should exist');
    await sleep(300); // let any in-flight write settle after the SIGKILL
    const first = fs.readFileSync(hbFile, 'utf8');
    await sleep(600); // >> the 100ms heartbeat interval
    const second = fs.readFileSync(hbFile, 'utf8');
    assert.equal(second, first, 'descendant must be reaped (heartbeat frozen), not orphaned and still ticking');
  });

  test('a command killed by a signal exits 128+signum (bash convention)', { skip: !posix }, () => {
    const r = runVerb(['10', '--', 'bash', '-c', 'kill -TERM $$']);
    assert.equal(r.status, 143, 'self-SIGTERM (15) → 128+15 = 143');
  });
});

describe('#4601 run-with-timeout — tree reap (Windows has no process groups)', () => {
  // The #4601 defect: on Windows `detached` is always false, so killTree fell
  // through to a bare child.kill(), which terminates the DIRECT child only —
  // any process the child launched survived the timeout and kept running
  // (typically a model CLI wrapped via workflow.cross_ai_command, calling a
  // paid API with nothing bounding it). The fix tree-kills via
  // `taskkill /PID <pid> /T /F` on the FIRST kill attempt — it must run while
  // the root is alive, because child.kill on Windows is TerminateProcess and
  // the moment the direct child exits its descendants are orphaned and no
  // taskkill can reach them (the issue's graceful-then-forceful staging prose
  // is unsatisfiable there; its own snippet applies taskkill on every call).
  // Methodology mirrors the C1 test above: HEARTBEAT liveness, not
  // kill(pid,0); first sample written synchronously at startup; bounded
  // settle waits >> the 100ms tick.
  //
  // KNOWN RUNNER MASKING, recorded deliberately: on GitHub's windows runners
  // the test harness reaps orphaned descendants shortly after the verb exits,
  // so the freeze assertion can pass even against UNFIXED code (observed: the
  // direct tree test below was green on the unfixed RED head's windows tier).
  // The environment where the bug manifests is a user's real Windows session,
  // per the reporter's repro. These tests pin the contract; they are not a
  // full differential witness on CI runners.
  const isWin = process.platform === 'win32';

  test("a timed-out command's descendant stops ticking — the tree dies, not just the direct child", { skip: !isWin ? 'win32-only' : false }, async (t) => {
    const dir = createTempDir('rwt-4601-tree');
    t.after(() => cleanup(dir));
    const parentFile = path.join(dir, 'parent.js');
    const hbFile = path.join(dir, 'heartbeat');
    fs.writeFileSync(parentFile, [
      'const cp = require("child_process");',
      "const childCode = 'const fs=require(\"fs\");const hb=process.argv[1];const tick=()=>fs.writeFileSync(hb,String(Date.now()));tick();setInterval(tick,100);';",
      'cp.spawn(process.execPath, ["-e", childCode, process.argv[2]], { stdio: "ignore" });',
      // The parent does NOT trap or exit on SIGTERM: on Windows the graceful
      // stage is TerminateProcess on the direct child either way — what #4601
      // tests is that the DESCENDANT (which no direct kill can reach) is gone.
      'setInterval(() => {}, 1000);',
    ].join('\n'));
    const r = runVerb(['2', '--', NODE, parentFile, hbFile], { timeout: RUN_WITH_TIMEOUT_REAP_BACKSTOP_MS });
    assert.equal(r.status, 124, 'must report a timeout (124), not hang');
    assert.ok(fs.existsSync(hbFile), 'descendant heartbeat should exist');
    await sleep(300); // let any in-flight write settle after the tree kill
    const first = fs.readFileSync(hbFile, 'utf8');
    await sleep(600); // >> the 100ms heartbeat interval
    const second = fs.readFileSync(hbFile, 'utf8');
    assert.equal(second, first, 'descendant must be tree-killed (heartbeat frozen), not orphaned and still ticking');
  });

  test('a fast-exiting command still exits with its own code — the win32 branch never perturbs the normal path', { skip: !isWin ? 'win32-only' : false }, () => {
    // Negative-space guard: for a fast command no timer fires and killTree is
    // never invoked — the taskkill branch must only ever attach to killTree
    // attempts, never to the timerless normal path.
    const r = runVerb(['5', '--', NODE, '-e', 'process.exit(7)']);
    assert.equal(r.status, 7);
  });

  test('a timed-out .cmd-mediated command has its whole subtree reaped (the model-CLI shape)', { skip: !isWin ? 'win32-only' : false }, async (t) => {
    // The #2667 mediation makes cmd.exe the direct child, so the real command
    // is a GRANDCHILD even with no further nesting — this is the shape of
    // workflow.cross_ai_command wrapping a model CLI .cmd shim (the paid-orphan
    // case from the issue). taskkill /T from the cmd.exe pid must reach it.
    // The shim stays alive with a ping sleep-loop, NOT `pause`: pause blocks on
    // stdin, which spawnSync-harness semantics resolve differently (observed on
    // a real runner: the shim quit early and the verb exited 0, no timeout).
    const dir = createTempDir('rwt-4601-cmd');
    t.after(() => cleanup(dir));
    const shim = path.join(dir, 'slow.cmd');
    const hbFile = path.join(dir, 'heartbeat');
    fs.writeFileSync(shim, [
      '@echo off',
      `start "" /b "${NODE}" -e "const fs=require('fs');const hb=process.argv[1];const tick=()=>fs.writeFileSync(hb,String(Date.now()));tick();setInterval(tick,100);" "${hbFile}"`,
      ':loop',
      'ping -n 2 127.0.0.1 > NUL',
      'goto :loop',
    ].join('\r\n'), 'utf8');
    const r = runVerb(['2', '--', shim], { timeout: RUN_WITH_TIMEOUT_REAP_BACKSTOP_MS });
    assert.equal(r.status, 124, 'the mediated .cmd must time out (124), not exit early or hang');
    assert.ok(fs.existsSync(hbFile), 'grandchild heartbeat should exist');
    await sleep(300); // let any in-flight write settle after the tree kill
    const first = fs.readFileSync(hbFile, 'utf8');
    await sleep(600); // >> the 100ms heartbeat interval
    const second = fs.readFileSync(hbFile, 'utf8');
    assert.equal(second, first, 'the .cmd grandchild must be tree-killed (heartbeat frozen), not orphaned and still ticking');
  });
});

describe('#2667 run-with-timeout — Windows .cmd/.bat/.exe spawn mediation (CVE-2024-27980)', () => {
  // Node's CVE-2024-27980 hardening throws EINVAL when child_process.spawn is
  // given a .cmd/.bat without a shell. run-with-timeout now mediates .cmd/.bat
  // on win32 via an explicit `cmd.exe /d /s /c <cmd> ...args` argv ARRAY (not
  // shell:true — that space-joins unescaped args per DEP0190), while leaving
  // every `bash`/argv-array caller unchanged (the recorded no-shell-for-argv-
  // array contract). .exe is INTENTIONALLY excluded — real PEs spawn fine
  // directly and mediating them breaks the timeout reap + risks arg mis-parse.
  const isWin = process.platform === 'win32';

  test('win32 RED: a .cmd shim runs (exit 0, non-empty stdout) — pre-fix this threw EINVAL → exit 125 / empty stdout', { skip: !isWin ? 'win32-only' : false }, () => {
    const dir = createTempDir('rwt-2667-cmd');
    try {
      // A .cmd shim that echoes JSON to stdout (mimics fallow.cmd audit --format json).
      const shim = path.join(dir, 'fake.cmd');
      fs.writeFileSync(shim, '@echo {"verdict":"clean"}\r\n', 'utf8');
      const r = runVerb(['10', '--', shim]);
      assert.equal(r.status, 0, `expected the .cmd shim to run (exit 0); got ${r.status}. stderr: ${r.stderr}`);
      assert.ok((r.stdout || '').includes('clean'), `expected non-empty JSON stdout from the .cmd shim; got: ${r.stdout}`);
    } finally {
      cleanup(dir);
    }
  });

  test('win32: a .bat shim is also mediated (exit 0, non-empty stdout)', { skip: !isWin ? 'win32-only' : false }, () => {
    const dir = createTempDir('rwt-2667-bat');
    try {
      const shim = path.join(dir, 'fake.bat');
      fs.writeFileSync(shim, '@echo {"verdict":"clean"}\r\n', 'utf8');
      const r = runVerb(['10', '--', shim]);
      assert.equal(r.status, 0, `expected the .bat shim to run (exit 0); got ${r.status}. stderr: ${r.stderr}`);
      assert.ok((r.stdout || '').length > 0, 'expected non-empty stdout from the .bat shim');
    } finally {
      cleanup(dir);
    }
  });

  test('win32 negative-space: a .exe (node.exe) is spawned DIRECTLY, not mediated — no cmd.exe wrap', { skip: !isWin ? 'win32-only' : false }, () => {
    // .exe is intentionally excluded from the gate: real PE executables spawn
    // fine directly, and wrapping them in cmd.exe /c breaks the timeout cap's
    // process-group reap AND risks cmd.exe mis-parsing args (e.g. -e "code()").
    // node.exe -e "process.exit(0)" must exit 0 directly.
    const r = runVerb(['10', '--', process.execPath, '-e', 'process.exit(0)']);
    assert.equal(r.status, 0, `expected node.exe to run directly (exit 0); got ${r.status}. stderr: ${r.stderr}`);
  });

  test('POSIX negative-space: a bash -c caller is unchanged (no shell:true added) — argv stays array-only', { skip: isWin ? 'posix-only' : false }, () => {
    // The fix's gate (win32 && .cmd/.bat) skips `bash` on POSIX: behavior
    // must be identical to before. `bash -c 'echo ok'` exits 0 with stdout "ok".
    const r = runVerb(['10', '--', 'bash', '-c', 'echo ok']);
    assert.equal(r.status, 0, `expected bash caller to still work (exit 0); got ${r.status}`);
    assert.equal((r.stdout || '').trim(), 'ok', 'expected stdout "ok" from the unchanged bash caller');
  });
});

describe('#2351 run-with-timeout — coreutils independence (the regression)', () => {
  // The whole point: no dependency on GNU `timeout`/`gtimeout`. Prove it by
  // scrubbing PATH so neither could be found, and driving the child by absolute
  // path. Before #2351 the gates called `timeout …` directly and exited 127 here.
  const scrubbedEnv = { ...process.env, PATH: '' };

  test('a real zero-exit command passes even with an empty PATH (no coreutils)', () => {
    const r = runVerb(['5', '--', ...OK], { env: scrubbedEnv });
    assert.equal(r.status, 0, 'must pass (exit 0), not 127, when coreutils is absent');
  });

  test('a genuine timeout is still detected (exit 124) with an empty PATH', () => {
    const r = runVerb(['1', '--', ...HANG], { env: scrubbedEnv });
    assert.equal(r.status, 124);
  });
});

describe('#2351 parity guard — no hardcoded timeout in workflow/agent/reference/command md', () => {
  const { findRawTimeoutInvocations, scan, DEFAULT_ROOTS } = require('../scripts/lint-portable-timeout.cjs');

  // Decoy fixtures sourced from the issue report (an author independent of the
  // detector), per the fixture-provenance rule (#2371): the exact bug forms the
  // guard must catch.
  const BUG_FORMS = [
    'timeout 300 bash -c "$BUILD_CMD" 2>&1',
    'timeout "$TEST_GATE_TIMEOUT" bash -c "$TEST_CMD" 2>&1',
    'timeout "$TEST_GATE_TIMEOUT" bash -c "$AUDIT_TEST_CMD" 2>&1 | tail -20',
    'echo "$TASK_PROMPT" | timeout "${CROSS_AI_TIMEOUT}s" ${CROSS_AI_CMD} > out 2>err',
    'timeout 120 "$FALLOW_BIN" audit --format json --quiet',
    'REVIEW_OUTPUT=$(echo "$X" | timeout 120 ${REVIEW_CMD} 2>/tmp/e.log)',
    'timeout 30s bash "$probe"',
    'gtimeout 60 bash -c "x"',
    // GNU long options / no-space short opt / arithmetic budget (review #2351 C3)
    'timeout --kill-after=5 30 bash -c x',
    'timeout --foreground 30 bash -c x',
    'timeout --signal=KILL 30 bash -c x',
    'timeout -k5 30 bash -c x',
    'timeout $((60*5)) bash -c x',
    'cmd && timeout 30 bash x',
  ];

  // Forms that must NEVER be flagged: the approved verb, portable capability
  // probes, config keys, the agy flag, prose, and variable names.
  const CLEAN_FORMS = [
    'gsd_run run-with-timeout 300 -- bash -c "$BUILD_CMD"',
    'echo "$X" | gsd_run run-with-timeout "${CROSS_AI_TIMEOUT}" -- ${CROSS_AI_CMD}',
    '_AGY_KILLER="$(command -v timeout 2>/dev/null || command -v gtimeout 2>/dev/null || true)"',
    '"$_AGY_KILLER" 600 agy --print-timeout 540s "$@" -p "$PROMPT"',
    'TEST_GATE_TIMEOUT=$(gsd_run query config-get workflow.test_gate_timeout || echo "600")',
    'echo "⚠ test gate timed out after ${TEST_GATE_TIMEOUT}s"',
    '# bound the build with a 5-minute timeout',
    'const TIMEOUT = 300;',
    // prose mentions of "timeout <n>" mid-sentence must not be flagged (review #2351 C4)
    'increase the timeout 30 seconds if the runner is slow',
    '# we replaced timeout 300 with the run-with-timeout verb',
    'sometimeout 30 is not the timeout command',
  ];

  for (const form of BUG_FORMS) {
    test(`flags a bare timeout invocation: ${form.slice(0, 42)}…`, () => {
      const findings = findRawTimeoutInvocations(form);
      assert.equal(findings.length, 1, `should flag: ${form}`);
      assert.equal(findings[0].line, 1);
    });
  }

  for (const form of CLEAN_FORMS) {
    test(`does not flag a portable/unrelated form: ${form.slice(0, 42)}…`, () => {
      assert.deepEqual(findRawTimeoutInvocations(form), [], `should NOT flag: ${form}`);
    });
  }

  test('multi-line input reports the correct line numbers', () => {
    const text = ['clean line', 'gsd_run run-with-timeout 5 -- true', 'timeout 30 bash x'].join('\n');
    const findings = findRawTimeoutInvocations(text);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].line, 3);
  });

  test('every shipped workflow/agent/reference/command surface is clean (regression)', () => {
    // Would have returned 10 offenders before the #2351 conversions landed.
    const offenders = scan(DEFAULT_ROOTS);
    assert.deepEqual(
      offenders,
      [],
      `hardcoded timeout still present:\n${offenders.map((o) => `${o.file}:${o.line} ${o.snippet}`).join('\n')}`,
    );
  });
});
