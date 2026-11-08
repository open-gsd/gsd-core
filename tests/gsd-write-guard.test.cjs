'use strict';

/**
 * gsd-write-guard.js — catastrophic-shrink guard for curated .planning/ writes
 *
 * Seam: hooks/gsd-write-guard.js (PreToolUse hook, spawned with a JSON payload
 * on stdin, exactly as every runtime bus invokes it).
 *
 * #2255 (fix 3 of #973): a planner read a ~16-line window of ROADMAP.md and
 * Write-overwrote the whole 292-line file with it. This hook hard-blocks
 * (decision: 'block', exit 2) a whole-file Write that shrinks a curated
 * .planning/ artifact below SHRINK_RATIO (40%) of its on-disk line count,
 * with a FLOOR_LINES (40) exemption for small stubs and a documented
 * GSD_ALLOW_PLANNING_SHRINK=1 escape hatch named in the block message.
 *
 * Acceptance criteria covered:
 *   1. Blocking polarity — decision: 'block' + exit 2, not advisory.
 *   2. Fires ONLY on the curated set — a wholesale rewrite of an arbitrary
 *      .md passes untouched.
 *   3. Compares the pending payload against the on-disk file.
 *   4. Documented env override exists and its name is in the block message.
 *   5. Line-count floor — a sub-floor file is exempt.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const helpers = require('./helpers.cjs');
const {
  createTempDir, createTempGitProject, cleanup, runGsdTools, homeSandboxEnv, readFileNormalized, toPosixPath,
} = helpers;
const { runHook: runHookSeam } = require('./helpers/process-seam.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { skipUnless } = require('./helpers/bash-probe.cjs');
const { QUICK_SPAWN_TIMEOUT_MS, GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'gsd-write-guard.js');

/**
 * Run the hook with a given payload. The override env var is stripped by
 * default so an outer environment can never leak a bypass into the tests;
 * pass extraEnv to set it explicitly.
 *
 * Returns an object shaped like the raw spawnSync() result (status/stdout/
 * stderr) because every call site in this file was written against that
 * shape; the seam itself returns exitCode, not status, so it is mapped here.
 * QUICK_SPAWN_TIMEOUT_MS: gsd-write-guard.js does no subprocess work of its
 * own (pure fs reads + JSON, no execFileSync/spawnSync inside the hook) —
 * generous headroom over the fs-bound workload without matching the
 * 30_000ms figure sibling suites use for guards that shell out to git.
 */
function runHook(payload, extraEnv = {}) {
  const env = { ...process.env };
  delete env.GSD_ALLOW_PLANNING_SHRINK;
  Object.assign(env, extraEnv);
  const r = runHookSeam(HOOK_PATH, [], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    env,
    timeoutMs: QUICK_SPAWN_TIMEOUT_MS,
  });
  return { status: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

function lines(n, tag = 'line') {
  return Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join('\n') + '\n';
}

function writePayload(filePath, content, overrides = {}) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: filePath, content },
    ...overrides,
  };
}

let projectDir;
let planningDir;
let roadmapPath;

before(() => {
  projectDir = createTempDir('gsd-write-guard-');
  planningDir = path.join(projectDir, '.planning');
  fs.mkdirSync(path.join(planningDir, 'milestones'), { recursive: true });
  roadmapPath = path.join(planningDir, 'ROADMAP.md');
});

after(() => {
  cleanup(projectDir);
});

describe('gsd-write-guard.js: catastrophic shrink of curated artifacts', () => {

  test('#973 shape: 292-line ROADMAP.md overwritten with 16 lines is BLOCKED (exit 2, decision block)', () => {
    fs.writeFileSync(roadmapPath, lines(292));
    const r = runHook(writePayload(roadmapPath, lines(16)));
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}; stdout: ${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'block', 'must emit decision: block (hard-block, not advisory)');
    assert.equal(out.oldLines, 292, 'typed oldLines field must carry the on-disk line count');
    assert.equal(out.newLines, 16, 'typed newLines field must carry the payload line count');
  });

  test('block output names the documented override in the typed overrideEnvVar field', () => {
    fs.writeFileSync(roadmapPath, lines(292));
    const r = runHook(writePayload(roadmapPath, lines(16)));
    assert.equal(r.status, 2);
    const out = JSON.parse(r.stdout);
    assert.equal(
      out.overrideEnvVar, 'GSD_ALLOW_PLANNING_SHRINK',
      'the escape hatch must be named in the block output — an undocumented bypass gets bypassed with the blunt instrument instead'
    );
  });

  test('GSD_ALLOW_PLANNING_SHRINK=1 bypasses the block (documented escape hatch)', () => {
    fs.writeFileSync(roadmapPath, lines(292));
    const r = runHook(writePayload(roadmapPath, lines(16)), { GSD_ALLOW_PLANNING_SHRINK: '1' });
    assert.equal(r.status, 0, `override must pass; stdout: ${r.stdout}`);
    assert.equal(r.stdout, '', 'override path must be silent');
  });

  test('milestone roadmap (.planning/milestones/v1-ROADMAP.md) is curated — blocked', () => {
    const msPath = path.join(planningDir, 'milestones', 'v1-ROADMAP.md');
    fs.writeFileSync(msPath, lines(120));
    const r = runHook(writePayload(msPath, lines(10)));
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}; stdout: ${r.stdout}`);
    assert.equal(JSON.parse(r.stdout).decision, 'block');
  });

  test('STATE.md under .planning/ is curated — blocked', () => {
    const statePath = path.join(planningDir, 'STATE.md');
    fs.writeFileSync(statePath, lines(90));
    const r = runHook(writePayload(statePath, lines(5)));
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}; stdout: ${r.stdout}`);
    assert.equal(JSON.parse(r.stdout).decision, 'block');
  });

  test('non-ENOENT read error fails CLOSED — curated target unreadable blocks (exit 2)', () => {
    // A directory at the curated path makes readFileSync throw EISDIR (or the
    // platform's equivalent) — any non-ENOENT read error must block, not wave
    // the Write through on a transient failure.
    // Injected via a directory-at-path collision rather than the usual
    // fs.readFileSync monkeypatch: runHook spawns the hook as a child process
    // (spawnSync), so an in-process fs patch can never reach the code under
    // test — the on-disk collision is the only injection that crosses the
    // process boundary, and it reproduces on all 3 CI platforms.
    const dirAsRoadmap = path.join(planningDir, 'milestones', 'vX-ROADMAP.md');
    fs.mkdirSync(dirAsRoadmap, { recursive: true });
    const r = runHook(writePayload(dirAsRoadmap, lines(300)));
    assert.equal(r.status, 2, `unreadable curated target must fail closed; stdout: ${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'block');
    assert.equal(out.overrideEnvVar, 'GSD_ALLOW_PLANNING_SHRINK');
    assert.notEqual(out.readError, undefined, 'typed readError field must carry the error code');
  });

  test('non-ENOENT read error still honors the documented override (fails open when set)', () => {
    const dirAsRoadmap = path.join(planningDir, 'milestones', 'vY-ROADMAP.md');
    fs.mkdirSync(dirAsRoadmap, { recursive: true });
    const r = runHook(writePayload(dirAsRoadmap, lines(300)), { GSD_ALLOW_PLANNING_SHRINK: '1' });
    assert.equal(r.status, 0, `override must bypass the fail-closed branch; stdout: ${r.stdout}`);
  });

  test('differently-cased path to a curated file is still guarded (case-insensitive FS bypass)', () => {
    fs.writeFileSync(roadmapPath, lines(292));
    // On a case-insensitive filesystem (macOS/Windows default) this path IS
    // ROADMAP.md; on a case-sensitive one it's a new file and ENOENT fails
    // open — either way the pattern match itself must be case-insensitive,
    // which this payload exercises via the resolved-path match.
    const casedPath = path.join(planningDir, 'roadmap.MD');
    const r = runHook(writePayload(casedPath, lines(16)));
    if (fs.existsSync(casedPath) && fs.statSync(casedPath).size > 0) {
      // case-insensitive FS: same real file — must block
      assert.equal(r.status, 2, `case-variant Write to the same real file must block; stdout: ${r.stdout}`);
    } else {
      // case-sensitive FS: genuinely a new file — new-file Writes pass
      assert.equal(r.status, 0, `stdout: ${r.stdout}`);
    }
  });

  test('relative file_path resolves against the payload cwd — blocked', () => {
    fs.writeFileSync(roadmapPath, lines(292));
    const payload = writePayload('.planning/ROADMAP.md', lines(16), { cwd: projectDir });
    const r = runHook(payload);
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}; stdout: ${r.stdout}`);
    assert.equal(JSON.parse(r.stdout).decision, 'block');
  });
});

describe('round 9: symlink resolution, CRLF counting, and denial-content pins', () => {
  test('a Write to a non-curated SYMLINK into a curated file is guarded (realpath before the match)',
    { skip: process.platform === 'win32' ? 'symlink creation needs privilege on Windows' : false }, () => {
    fs.writeFileSync(roadmapPath, lines(292));
    const linkPath = path.join(projectDir, 'innocent-notes.md');
    fs.symlinkSync(roadmapPath, linkPath);
    try {
      const r = runHook(writePayload(linkPath, lines(16)));
      assert.equal(r.status, 2,
        `writeFileSync follows the link into ROADMAP.md, so the guard must too. Got ${r.status}; stdout: ${r.stdout}`);
      assert.equal(JSON.parse(r.stdout).decision, 'block');
    } finally {
      cleanup(linkPath);
    }
  });

  test('the denial prose does NOT publish the sentinel recipe; the typed field still names it (round 9 Major 2)', () => {
    fs.writeFileSync(roadmapPath, lines(292));
    const r = runHook(writePayload(roadmapPath, lines(16)));
    assert.equal(r.status, 2);
    const out = JSON.parse(r.stdout);
    assert.equal(out.overrideSentinel, '.planning/.gsd-allow-shrink',
      'the typed field stays — the binding tests and workflow consumers key on it');
    assert.ok(!out.reason.includes(out.overrideSentinel),
      '#973 was an agent reasoning past an advisory: the agent-facing denial must not print the sentinel recipe');
    assert.ok(out.reason.includes(out.overrideEnvVar),
      "#2255 acceptance criterion: the env override's name stays in the block message");
  });

  test('CRLF content counts lines correctly on both sides of the compare', () => {
    const crlf = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\r\n') + '\r\n';
    fs.writeFileSync(roadmapPath, crlf(100));
    const blocked = runHook(writePayload(roadmapPath, crlf(39)));
    assert.equal(blocked.status, 2, `39/100 CRLF lines is under the 40% ratio and must block. Got ${blocked.status}`);
    const out = JSON.parse(blocked.stdout);
    assert.equal(out.oldLines, 100, 'CRLF on disk must not inflate or deflate the count');
    assert.equal(out.newLines, 39, 'CRLF in the payload must not inflate or deflate the count');
    const pass = runHook(writePayload(roadmapPath, crlf(40)));
    assert.equal(pass.status, 0, '40/100 CRLF lines sits exactly on the tolerated boundary and must pass');
  });
});

describe('gsd-write-guard.js: deliberately narrow trigger (no-op paths)', () => {

  test('wholesale rewrite of a NON-curated .md passes untouched (no override-fatigue)', () => {
    const notesPath = path.join(projectDir, 'docs-notes.md');
    fs.writeFileSync(notesPath, lines(200));
    const r = runHook(writePayload(notesPath, lines(5)));
    assert.equal(r.status, 0, `non-curated file must pass; stdout: ${r.stdout}`);
    assert.equal(r.stdout, '');
  });

  test('non-roadmap file under .planning/milestones/ is not curated — passes', () => {
    const auditPath = path.join(planningDir, 'milestones', 'v1-MILESTONE-AUDIT.md');
    fs.writeFileSync(auditPath, lines(200));
    const r = runHook(writePayload(auditPath, lines(5)));
    assert.equal(r.status, 0, `stdout: ${r.stdout}`);
  });

  test('sub-floor file (39 lines) is exempt from the ratio check', () => {
    fs.writeFileSync(roadmapPath, lines(39));
    const r = runHook(writePayload(roadmapPath, lines(2)));
    assert.equal(r.status, 0, `sub-floor stub must pass; stdout: ${r.stdout}`);
  });

  test('at-floor file (40 lines) IS guarded — the floor is exclusive', () => {
    fs.writeFileSync(roadmapPath, lines(40));
    const r = runHook(writePayload(roadmapPath, lines(15)));
    assert.equal(r.status, 2, `40-line file collapsing to 15 (37.5%) must block; stdout: ${r.stdout}`);
  });

  test('above-floor file (41 lines) IS guarded — floor boundary from above', () => {
    fs.writeFileSync(roadmapPath, lines(41));
    const r = runHook(writePayload(roadmapPath, lines(15)));
    assert.equal(r.status, 2, `41-line file collapsing to 15 (~36.6%) must block; stdout: ${r.stdout}`);
  });

  test('ratio boundary: exactly 40% of old passes; one line either side behaves', () => {
    fs.writeFileSync(roadmapPath, lines(100));
    const atThreshold = runHook(writePayload(roadmapPath, lines(40)));
    assert.equal(atThreshold.status, 0, `100 → 40 (exactly 40%) must pass; stdout: ${atThreshold.stdout}`);
    const belowThreshold = runHook(writePayload(roadmapPath, lines(39)));
    assert.equal(belowThreshold.status, 2, `100 → 39 (39%) must block; stdout: ${belowThreshold.stdout}`);
    const aboveThreshold = runHook(writePayload(roadmapPath, lines(41)));
    assert.equal(aboveThreshold.status, 0, `100 → 41 (41%) must pass; stdout: ${aboveThreshold.stdout}`);
  });

  test('creating a curated file that does not exist yet passes', () => {
    const freshPath = path.join(planningDir, 'milestones', 'v9-ROADMAP.md');
    const r = runHook(writePayload(freshPath, lines(3)));
    assert.equal(r.status, 0, `new-file Write must pass; stdout: ${r.stdout}`);
  });

  test('Edit tool call is out of scope — passes even on a curated target', () => {
    fs.writeFileSync(roadmapPath, lines(292));
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: roadmapPath, old_string: 'line 1', new_string: 'line one' },
    };
    const r = runHook(payload);
    assert.equal(r.status, 0, `Edit is scoped by construction; stdout: ${r.stdout}`);
  });

  test('MultiEdit tool call is out of scope — passes', () => {
    fs.writeFileSync(roadmapPath, lines(292));
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'MultiEdit',
      tool_input: { file_path: roadmapPath, edits: [] },
    };
    const r = runHook(payload);
    assert.equal(r.status, 0);
  });

  test('payload without content (non-string) fails open', () => {
    fs.writeFileSync(roadmapPath, lines(292));
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: roadmapPath },
    };
    const r = runHook(payload);
    assert.equal(r.status, 0, `missing content must fail open; stdout: ${r.stdout}`);
  });

  test('malformed JSON on stdin fails open (silent fail, never blocks)', () => {
    const r = runHook('{not json');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});

// ────────────────────────────────────────────────────────────────────────
// #2304 — Kimi tool vocabulary engages the guard
// Payload shapes mirror kimi-cli's actual tool schemas
// (src/kimi_cli/tools/file/write.py): WriteFile takes `path`/`content`,
// not Claude's `file_path`. See PR #2326 for the sibling guards.
// ────────────────────────────────────────────────────────────────────────

describe('#2304: Kimi tool vocabulary engages the write guard', () => {
  test('Kimi WriteFile catastrophic shrink is BLOCKED like Write', () => {
    fs.writeFileSync(roadmapPath, lines(292));
    const r = runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'WriteFile',
      tool_input: { path: roadmapPath, content: lines(16) },
    });
    assert.equal(r.status, 2, `Kimi WriteFile shrink must be blocked. Got ${r.status}; stdout: ${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'block');
    assert.equal(out.oldLines, 292);
    assert.equal(out.newLines, 16);
  });

  test('module-qualified kimi_cli.tools.file:WriteFile is recognized', () => {
    fs.writeFileSync(roadmapPath, lines(292));
    const r = runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'kimi_cli.tools.file:WriteFile',
      tool_input: { path: roadmapPath, content: lines(16) },
    });
    assert.equal(r.status, 2, `qualified Kimi WriteFile shrink must be blocked. Got ${r.status}; stdout: ${r.stdout}`);
    assert.equal(JSON.parse(r.stdout).decision, 'block');
  });

  test('block reason reaches stderr (Kimi feeds stderr back to the model on exit 2)', () => {
    fs.writeFileSync(roadmapPath, lines(292));
    const r = runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'WriteFile',
      tool_input: { path: roadmapPath, content: lines(16) },
    });
    assert.equal(r.status, 2);
    assert.ok(r.stderr.length > 0, 'stderr must be non-empty — it is the channel Kimi feeds back');
    assert.equal(r.stderr, JSON.parse(r.stdout).reason,
      'stderr must carry exactly the typed reason — the same contract, without pinning prose');
  });

  test('Kimi StrReplaceFile stays exempt (Edit-class, out of scope by design)', () => {
    fs.writeFileSync(roadmapPath, lines(292));
    const r = runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'StrReplaceFile',
      tool_input: { path: roadmapPath, edit: { old: 'line 1', new: 'line one' } },
    });
    assert.equal(r.status, 0, 'StrReplaceFile is unmapped in this guard (Edit-class, out of scope by design #2255) and must fall through to the non-Write exemption');
    assert.equal(r.stdout, '');
  });

  test('Kimi WriteFile of a non-curated path stays exempt', () => {
    const otherPath = path.join(projectDir, 'notes.md');
    fs.writeFileSync(otherPath, lines(300));
    const r = runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'WriteFile',
      tool_input: { path: otherPath, content: lines(5) },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  test("a spurious model-supplied file_path cannot shadow Kimi's authoritative path (#2595 class)", () => {
    fs.writeFileSync(roadmapPath, lines(292));
    const r = runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'WriteFile',
      tool_input: { path: roadmapPath, file_path: '', content: lines(16) },
    });
    assert.equal(r.status, 2,
      `kimi-cli executes on \`path\`, so \`path\` must win outright — a spurious file_path:'' shadowed it pre-fix and the guard read '' and exited 0. Got ${r.status}; stdout: ${r.stdout}`);
    assert.equal(JSON.parse(r.stdout).decision, 'block');
  });

  test('null and primitive payloads fall through deliberately (total normalization, #2595 class)', () => {
    for (const payload of ['null', '42', '"write"']) {
      const r = runHook(payload);
      assert.equal(r.status, 0, `payload ${payload} has nothing to guard and must exit 0 without crashing`);
      assert.equal(r.stdout, '');
    }
  });
});

describe('single-use sentinel exemption (.planning/.gsd-allow-shrink) — the mechanical hatch the workflow uses', () => {
  // #2255 round 5 M1: a per-step env prefix cannot reach a PreToolUse hook
  // (the hook inherits the RUNTIME's environment), so the workflow's hatch is
  // a sentinel FILE the guard itself consults: the step writes the target's
  // path into .planning/.gsd-allow-shrink, and the guard consumes it (single
  // use) to allow exactly one otherwise-blocked shrink of exactly that file.
  const sentinelName = '.gsd-allow-shrink';
  let sentinelPath;

  before(() => {
    sentinelPath = path.join(planningDir, sentinelName);
  });

  function armSentinel(target = '.planning/ROADMAP.md') {
    fs.writeFileSync(sentinelPath, target + '\n');
  }

  function disarm() {
    cleanup(sentinelPath); // helpers.cleanup — carries the Windows-EBUSY retry budget
  }

  test('a reorganize-shaped Write PASSES under a fresh sentinel naming the target — and the sentinel is CONSUMED', () => {
    fs.writeFileSync(roadmapPath, lines(292));
    armSentinel();
    const r = runHook(writePayload(roadmapPath, lines(16), { cwd: projectDir }));
    assert.equal(r.status, 0,
      `fresh sentinel naming the target must exempt the shrink. Got ${r.status}; stdout: ${r.stdout}`);
    assert.equal(fs.existsSync(sentinelPath), false,
      'the sentinel must be consumed by the allow — single-use, never a standing unlock');

    // Single-use for real: the identical payload immediately after is blocked.
    const again = runHook(writePayload(roadmapPath, lines(16), { cwd: projectDir }));
    assert.equal(again.status, 2, 'the sentinel is spent — the identical second Write must block');
  });

  test('a STALE sentinel does not exempt', () => {
    fs.writeFileSync(roadmapPath, lines(292));
    armSentinel();
    const old = (Date.now() - 16 * 60 * 1000) / 1000; // past the 15-minute freshness window
    fs.utimesSync(sentinelPath, old, old);
    const r = runHook(writePayload(roadmapPath, lines(16), { cwd: projectDir }));
    assert.equal(r.status, 2, 'a stale sentinel is a leftover, not an authorization');
    disarm();
  });

  test('a sentinel naming a DIFFERENT file neither exempts nor is consumed', () => {
    fs.writeFileSync(roadmapPath, lines(292));
    armSentinel('.planning/STATE.md');
    const r = runHook(writePayload(roadmapPath, lines(16), { cwd: projectDir }));
    assert.equal(r.status, 2, 'the sentinel is path-bound — a token for STATE.md must not exempt ROADMAP.md');
    assert.equal(fs.existsSync(sentinelPath), true,
      'a mismatched sentinel must survive — it still authorizes the write it was armed for');
    disarm();
  });

  test('a within-tolerance Write does NOT consume a fresh sentinel (consulted only at the block point)', () => {
    fs.writeFileSync(roadmapPath, lines(292));
    armSentinel();
    const r = runHook(writePayload(roadmapPath, lines(200), { cwd: projectDir }));
    assert.equal(r.status, 0, `200/292 is within tolerance and must pass. Got ${r.status}; stdout: ${r.stdout}`);
    assert.equal(fs.existsSync(sentinelPath), true,
      'a passing Write must not burn the token the workflow armed for its collapse — true by construction, now asserted');
    disarm();
  });

  test('the block output names the sentinel via a typed field (consumers never regex the prose)', () => {
    fs.writeFileSync(roadmapPath, lines(292));
    const r = runHook(writePayload(roadmapPath, lines(16), { cwd: projectDir }));
    assert.equal(r.status, 2);
    const out = JSON.parse(r.stdout);
    assert.equal(out.overrideSentinel, `.planning/${sentinelName}`,
      'blocked callers are told the mechanical hatch by typed field, same contract as overrideEnvVar');
  });
});

describe('guard <-> complete-milestone workflow binding (the escape hatch is WIRED, not just present)', () => {
  // #2255 review Blocker 1 (reopened round 5 as M1): the one first-party
  // legitimate milestone reset — complete-milestone's reorganize step — must
  // route through a hatch the guard MECHANICALLY honors, on the tool the
  // guard actually watches. Round 3's fix routed around Write via Bash+tee
  // with an env prefix nothing reads; this binding asserts the opposite: the
  // step arms the sentinel the guard consumes, keeps Write as the sanctioned
  // path, and no longer smuggles the rewrite through a shell pipe. The
  // sentinel name is taken from the guard's typed output, so a rename on
  // EITHER side fails here instead of silently unwiring the hatch.
  const workflowPath = path.join(
    __dirname, '..', 'gsd-core', 'workflows', 'complete-milestone.md'
  );

  test('the reorganize step arms the exact sentinel the guard consumes, and keeps Write as the path', () => {
    const src = fs.readFileSync(workflowPath, 'utf8');
    const stepStart = src.indexOf('<step name="reorganize_roadmap_and_delete_originals">');
    assert.notEqual(stepStart, -1,
      'reorganize step missing or renamed in complete-milestone.md — rebind this test');
    const step = src.slice(stepStart, src.indexOf('</step>', stepStart));

    fs.writeFileSync(roadmapPath, lines(292));
    const blocked = runHook(writePayload(roadmapPath, lines(16), { cwd: projectDir }));
    assert.equal(blocked.status, 2, 'baseline: the reorganize-shaped Write must block without the hatch');
    const sentinel = JSON.parse(blocked.stdout).overrideSentinel;
    assert.ok(sentinel, 'the guard must publish its sentinel path as a typed field');

    assert.ok(step.includes(sentinel),
      `complete-milestone.md's reorganize step no longer arms ${sentinel} — ` +
      'its whole-file ROADMAP.md rewrite would be hard-blocked by gsd-write-guard (#2255 M1)');

    assert.ok(!/GSD_ALLOW_PLANNING_SHRINK=1\s+tee/.test(step) && !/\btee\s+\.planning\/ROADMAP\.md/.test(step),
      'the reorganize step must not route the rewrite around Write via a shell pipe — ' +
      'that is the prose-level protection M1 exists to eliminate');

    // The real failure round 5 named: agent follows the step, arms the
    // sentinel, then calls Write — this exact sequence must pass.
    fs.writeFileSync(path.join(planningDir, '.gsd-allow-shrink'), '.planning/ROADMAP.md\n');
    const allowed = runHook(writePayload(roadmapPath, lines(16), { cwd: projectDir }));
    assert.equal(allowed.status, 0,
      'the identical catastrophic payload must pass under the sentinel the workflow step arms');
  });

  test('the sentinel-armed reorganize step is the ONLY ROADMAP-collapsing step in the workflow', () => {
    // #2255 round 8 Blocker: a second, hatch-less `reorganize_roadmap` step —
    // a vestige of the pre-archive-then-reorganize design, sitting BEFORE
    // archive_milestone, so running it would collapse ROADMAP.md before the
    // archive snapshots the full detail — was removed rather than wired. This
    // binding fails if any reorganize step other than the sentinel-armed one
    // is (re)introduced without hatch wiring of its own.
    const src = fs.readFileSync(workflowPath, 'utf8');
    // eslint-disable-next-line local/no-unbounded-quantifier -- parses maintainer-authored complete-milestone.md workflow, bounded prose, not adversarial input
    const names = [...src.matchAll(/<step name="([^"]*reorganize[^"]*)">/g)].map((m) => m[1]);
    assert.deepEqual(names, ['reorganize_roadmap_and_delete_originals'],
      'complete-milestone.md must contain exactly one ROADMAP-reorganize step — the ' +
      'sentinel-armed reorganize_roadmap_and_delete_originals; any additional reorganize ' +
      'step is an unguarded catastrophic-shrink Write (#2255 round 8 Blocker)');
  });
});

describe('workstream-scoped curated paths (#4455)', () => {
  // Security-review finding on #4455: planningDir(cwd) (src/planning-workspace.cts)
  // resolves to `.planning/[<project>/]workstreams/<ws>/...` whenever GSD_WORKSTREAM
  // is set — but CURATED_PATTERNS only matched the root form, so the guard's ENTIRE
  // catastrophic-shrink protection (not just the sentinel step — the ratio check too)
  // silently never engaged for a workstream-scoped ROADMAP.md/STATE.md/milestone
  // archive Write. complete-milestone.md's reorganize step explicitly targets a
  // resolved (potentially workstream-scoped) $ROADMAP_PATH via the Write tool and
  // claims "the guard allows this one shrink" — that claim was FALSE under an active
  // workstream, since the guard never recognized the target as curated at all.
  let wsProjectDir;
  let wsRoadmapPath;
  let wsStatePath;
  let wsMilestoneArchivePath;
  let wsPlanningDir;

  before(() => {
    wsProjectDir = createTempDir('gsd-write-guard-ws-');
    wsPlanningDir = path.join(wsProjectDir, '.planning');
    const wsDir = path.join(wsPlanningDir, 'workstreams', 'alpha');
    fs.mkdirSync(path.join(wsDir, 'milestones'), { recursive: true });
    wsRoadmapPath = path.join(wsDir, 'ROADMAP.md');
    wsStatePath = path.join(wsDir, 'STATE.md');
    wsMilestoneArchivePath = path.join(wsDir, 'milestones', 'v1.0-ROADMAP.md');
  });

  after(() => {
    cleanup(wsProjectDir);
  });

  test('a workstream-scoped ROADMAP.md catastrophic shrink is BLOCKED (was silently unguarded before #4455)', () => {
    fs.writeFileSync(wsRoadmapPath, lines(292));
    const r = runHook(writePayload(wsRoadmapPath, lines(16), { cwd: wsProjectDir }));
    assert.equal(r.status, 2, `expected exit 2 (blocked), got ${r.status}; stdout: ${r.stdout}`);
    assert.equal(JSON.parse(r.stdout).decision, 'block');
  });

  test('a workstream-scoped STATE.md catastrophic shrink is BLOCKED', () => {
    fs.writeFileSync(wsStatePath, lines(292));
    const r = runHook(writePayload(wsStatePath, lines(16), { cwd: wsProjectDir }));
    assert.equal(r.status, 2, `expected exit 2 (blocked), got ${r.status}; stdout: ${r.stdout}`);
    assert.equal(JSON.parse(r.stdout).decision, 'block');
  });

  test('a workstream-scoped milestone archive ROADMAP catastrophic shrink is BLOCKED', () => {
    fs.writeFileSync(wsMilestoneArchivePath, lines(292));
    const r = runHook(writePayload(wsMilestoneArchivePath, lines(16), { cwd: wsProjectDir }));
    assert.equal(r.status, 2, `expected exit 2 (blocked), got ${r.status}; stdout: ${r.stdout}`);
    assert.equal(JSON.parse(r.stdout).decision, 'block');
  });

  test('the sentinel hatch (armed at the ROOT .planning/.gsd-allow-shrink, naming the workstream path) unblocks a workstream ROADMAP.md write', () => {
    // complete-milestone.md's sentinel fence always writes to the ROOT
    // .planning/.gsd-allow-shrink (unchanged by #4455 — consumeSentinelFor
    // derives that same root location from the write TARGET's path
    // regardless of how deep a workstream target is nested), naming the
    // resolved (workstream-scoped) $ROADMAP_PATH as its content.
    fs.writeFileSync(wsRoadmapPath, lines(292));
    fs.writeFileSync(path.join(wsPlanningDir, '.gsd-allow-shrink'), `${wsRoadmapPath}\n`);
    const r = runHook(writePayload(wsRoadmapPath, lines(16), { cwd: wsProjectDir }));
    assert.equal(r.status, 0,
      `expected the sentinel to unblock the workstream-scoped write, got status ${r.status}; stdout: ${r.stdout}`);
  });

  test('a non-curated file inside a workstream dir stays exempt (no widening beyond ROADMAP/STATE/milestone-archive)', () => {
    const notesPath = path.join(wsPlanningDir, 'workstreams', 'alpha', 'NOTES.md');
    fs.writeFileSync(notesPath, lines(292));
    const r = runHook(writePayload(notesPath, lines(16), { cwd: wsProjectDir }));
    assert.equal(r.status, 0, `non-curated workstream file must pass; stdout: ${r.stdout}`);
  });

  test('the sentinel hatch unblocks even when cwd sits under a symlink (macOS full-test CI finding)',
    { skip: process.platform === 'win32' ? 'symlink creation needs privilege on Windows' : false }, () => {
    // PR CI's macos-latest full-test shard caught this for free — os.tmpdir()
    // on macOS resolves through a /var -> /private/var symlink, so the
    // ABOVE test (identical cwd/target shape) failed there while passing
    // everywhere gsd-test's Linux bench runs, where /tmp is not a symlink.
    // This test reproduces the same asymmetry deterministically on any
    // platform via an EXPLICIT symlink, so a regression here is caught by
    // gsd-test too, not only by a real macOS CI run.
    //
    // Root cause: the caller (guard's main flow) realpath-resolves the
    // WRITE TARGET before the curated match (round 9 Minor 1), but
    // consumeSentinelFor compared the sentinel TOKEN's resolved path
    // without the same realpath step — an armed, correct sentinel then
    // never matched whenever cwd traversed a symlink.
    const realBase = createTempDir('gsd-write-guard-symlink-real-');
    const linkedProjectDir = path.join(os.tmpdir(), `gsd-write-guard-symlink-link-${process.pid}-${Date.now()}`);
    fs.symlinkSync(realBase, linkedProjectDir, 'dir');
    try {
      const linkedPlanningDir = path.join(linkedProjectDir, '.planning');
      const linkedWsDir = path.join(linkedPlanningDir, 'workstreams', 'alpha');
      fs.mkdirSync(linkedWsDir, { recursive: true });
      const linkedRoadmapPath = path.join(linkedWsDir, 'ROADMAP.md');
      fs.writeFileSync(linkedRoadmapPath, lines(292));
      // Armed with the LEXICAL (through-the-symlink) path, matching exactly
      // what the workflow's own $ROADMAP_PATH (from init.complete-milestone,
      // never realpath-resolved) would contain.
      fs.writeFileSync(path.join(linkedPlanningDir, '.gsd-allow-shrink'), `${linkedRoadmapPath}\n`);
      const r = runHook(writePayload(linkedRoadmapPath, lines(16), { cwd: linkedProjectDir }));
      assert.equal(r.status, 0,
        `expected the sentinel to unblock through the symlinked cwd, got status ${r.status}; stdout: ${r.stdout}`);
    } finally {
      cleanup(linkedProjectDir);
      cleanup(realBase);
    }
  });
});

describe('project-only-scoped curated paths (#4455 follow-up)', () => {
  // planningDir(cwd) ALSO resolves to `.planning/<project>/...` when
  // GSD_PROJECT is set with NO GSD_WORKSTREAM — an independent dimension
  // from the workstream nesting covered above. Found during this same PR's
  // own review pass (identical root cause, one more path-shape variant) and
  // fixed in the same change per this repo's no-deferral policy rather than
  // left open as a "pre-existing, out of scope" gap.
  let projProjectDir;
  let projPlanningDir;
  let projRoadmapPath;
  let projStatePath;
  let projMilestoneArchivePath;

  before(() => {
    projProjectDir = createTempDir('gsd-write-guard-proj-');
    projPlanningDir = path.join(projProjectDir, '.planning');
    const projDir = path.join(projPlanningDir, 'myproject');
    fs.mkdirSync(path.join(projDir, 'milestones'), { recursive: true });
    projRoadmapPath = path.join(projDir, 'ROADMAP.md');
    projStatePath = path.join(projDir, 'STATE.md');
    projMilestoneArchivePath = path.join(projDir, 'milestones', 'v1.0-ROADMAP.md');
  });

  after(() => {
    cleanup(projProjectDir);
  });

  test('a project-scoped ROADMAP.md catastrophic shrink is BLOCKED (was silently unguarded before this fix)', () => {
    fs.writeFileSync(projRoadmapPath, lines(292));
    const r = runHook(writePayload(projRoadmapPath, lines(16), { cwd: projProjectDir }));
    assert.equal(r.status, 2, `expected exit 2 (blocked), got ${r.status}; stdout: ${r.stdout}`);
    assert.equal(JSON.parse(r.stdout).decision, 'block');
  });

  test('a project-scoped STATE.md catastrophic shrink is BLOCKED', () => {
    fs.writeFileSync(projStatePath, lines(292));
    const r = runHook(writePayload(projStatePath, lines(16), { cwd: projProjectDir }));
    assert.equal(r.status, 2, `expected exit 2 (blocked), got ${r.status}; stdout: ${r.stdout}`);
    assert.equal(JSON.parse(r.stdout).decision, 'block');
  });

  test('a project-scoped milestone archive ROADMAP catastrophic shrink is BLOCKED', () => {
    fs.writeFileSync(projMilestoneArchivePath, lines(292));
    const r = runHook(writePayload(projMilestoneArchivePath, lines(16), { cwd: projProjectDir }));
    assert.equal(r.status, 2, `expected exit 2 (blocked), got ${r.status}; stdout: ${r.stdout}`);
    assert.equal(JSON.parse(r.stdout).decision, 'block');
  });

  test('a non-curated file inside a project dir stays exempt', () => {
    const notesPath = path.join(projPlanningDir, 'myproject', 'NOTES.md');
    fs.writeFileSync(notesPath, lines(292));
    const r = runHook(writePayload(notesPath, lines(16), { cwd: projProjectDir }));
    assert.equal(r.status, 0, `non-curated project-scoped file must pass; stdout: ${r.stdout}`);
  });

  test('a project-scoped path is not accidentally matched by the workstream patterns (regex specificity check)', () => {
    // Guards against a regression where the workstream patterns' optional
    // `(?:[^/]+\/)?` project prefix is loosened enough to also swallow this
    // shape by accident — asserting BOTH describe blocks' patterns exist
    // independently, not that this one only passes via the other's regex.
    const wsShapeAtProjectPath = path.join(projPlanningDir, 'myproject', 'workstreams');
    fs.mkdirSync(wsShapeAtProjectPath, { recursive: true });
    // Sanity: the project-scoped ROADMAP.md itself (not inside `workstreams/`)
    // must still be curated — already proven above; this test only confirms
    // the directory literally named "workstreams" existing alongside it
    // doesn't change that outcome.
    fs.writeFileSync(projRoadmapPath, lines(292));
    const r = runHook(writePayload(projRoadmapPath, lines(16), { cwd: projProjectDir }));
    assert.equal(r.status, 2, `project-scoped ROADMAP.md must stay blocked; stdout: ${r.stdout}`);
  });
});

describe('the shipped claim matches the shipped guarantee (round 10 Major 2)', () => {
  // The guard's reach is bounded: the sentinel is a plain file, so an agent
  // that would reason past an advisory can arm one with a single Bash call.
  // Round 10 asked that the claim not outrun that, and specifically that the
  // stronger wording not reach CHANGELOG.md. Pinned on the DURABLE surfaces
  // only — a changeset fragment is consumed at release, so a test reading it
  // would start failing the moment the release lands.
  const RETIRED = 'the only defense independent of per-agent tool config';
  const surfaces = [
    ['hooks/gsd-write-guard.js', path.join(__dirname, '..', 'hooks', 'gsd-write-guard.js')],
    ['docs/USER-GUIDE.md', path.join(__dirname, '..', 'docs', 'USER-GUIDE.md')],
  ];

  for (const [label, file] of surfaces) {
    test(`${label} does not restate the retired unbounded claim`, () => {
      const src = fs.readFileSync(file, 'utf8');
      assert.ok(!src.includes(RETIRED),
        `${label} carries the retired claim "${RETIRED}" — it overstates what the guard ` +
        'delivers, because the sentinel is agent-armable (#2255 round 10 Major 2)');
    });

    test(`${label} states the determined-agent bound`, () => {
      // Normalize before matching: the claim is prose, and in a source file it
      // is prose wrapped in `//` across several lines. A pin that breaks when
      // a paragraph is reflowed tests the formatter, not the claim.
      const src = fs.readFileSync(file, 'utf8')
        .replace(/^\s*\/\/ ?/gm, '')
        .replace(/\s+/g, ' ');
      assert.match(src, /not a defense against (a determined agent|an evader)/,
        `${label} must state that the guard does not stop a determined agent — the bound is ` +
        'the half a reader acts on (#2255 round 10 Major 2)');
    });
  }
});

describe('guard <-> gsd-roadmapper binding (the /gsd:new-milestone collapse path is hatched)', () => {
  // #2255 round 10 Blocker 1: complete-milestone was not the only first-party
  // flow that overwrites a curated artifact wholesale. gsd-roadmapper's Step 7
  // Writes BOTH .planning/ROADMAP.md and .planning/STATE.md, and
  // /gsd:new-milestone spawns it against the OUTGOING milestone's files —
  // new-milestone's `phases.clear` archives phase DIRECTORIES, never
  // ROADMAP.md, so nothing compacts it first and no ordering rule forces
  // /gsd:complete-milestone to run before /gsd:new-milestone.
  //
  // Measured against the shipped hook at the #973 file size (292 lines): a new
  // 4-phase roadmap lands at 18.2% and an 8-phase one at 31.8% — both blocked;
  // only a 12-phase replacement (45.5%) clears. The sentinel is path-bound and
  // single-use, so each Write needs its own arming. As in the sibling binding
  // above, the sentinel name is taken from the guard's typed output so a
  // rename on EITHER side fails here instead of silently unwiring the hatch.
  const roadmapperPath = path.join(__dirname, '..', 'agents', 'gsd-roadmapper.md');

  test('the roadmapper write step arms the exact sentinel the guard consumes, for BOTH curated targets', () => {
    const src = fs.readFileSync(roadmapperPath, 'utf8');
    const stepStart = src.indexOf('## Step 7: Write Files Immediately');
    assert.notEqual(stepStart, -1,
      'roadmapper Step 7 missing or renamed in gsd-roadmapper.md — rebind this test');
    const step = src.slice(stepStart, src.indexOf('## Step 8', stepStart));

    fs.writeFileSync(roadmapPath, lines(292));
    const blocked = runHook(writePayload(roadmapPath, lines(53), { cwd: projectDir }));
    assert.equal(blocked.status, 2,
      'baseline: the new-milestone-shaped roadmap Write must block without the hatch');
    const sentinel = JSON.parse(blocked.stdout).overrideSentinel;
    assert.ok(sentinel, 'the guard must publish its sentinel path as a typed field');

    assert.ok(step.includes(sentinel),
      `gsd-roadmapper.md Step 7 no longer arms ${sentinel} — its whole-file ROADMAP.md ` +
      'write would be hard-blocked by gsd-write-guard on /gsd:new-milestone (#2255 round 10 Blocker 1)');

    // Both curated targets the step writes must be armed by name — one arming
    // cannot cover both, because the token is path-bound and single-use. The
    // names are variables bound to the prompt's write targets (#5859), so a
    // workstream's or named project's file is armed, never the root project's.
    for (const target of ['"$ROADMAP_TARGET"', '"$STATE_TARGET"']) {
      assert.ok(step.includes(`printf '%s\\n' ${target} > ${sentinel}`),
        `Step 7 must arm ${sentinel} for ${target} immediately before writing it — ` +
        'the sentinel is path-bound and single-use, so a single arming covers only one file');
    }
  });

  test('the armed sequence passes the exact collapse /gsd:new-milestone produces', () => {
    // The real failure: roadmapper follows Step 7, arms the sentinel, Writes.
    fs.writeFileSync(roadmapPath, lines(292));
    fs.writeFileSync(path.join(planningDir, '.gsd-allow-shrink'), '.planning/ROADMAP.md\n');
    const allowed = runHook(writePayload(roadmapPath, lines(53), { cwd: projectDir }));
    assert.equal(allowed.status, 0,
      'the identical collapse must pass under the sentinel the roadmapper step arms');

    // And the STATE.md leg, which the same step writes seconds later — its own
    // arming, because the ROADMAP arming was consumed by the write above.
    const statePath = path.join(planningDir, 'STATE.md');
    fs.writeFileSync(statePath, lines(195));
    const stateBlocked = runHook(writePayload(statePath, lines(60), { cwd: projectDir }));
    assert.equal(stateBlocked.status, 2,
      'a collapsing STATE.md rewrite must block once the ROADMAP arming is spent');
    fs.writeFileSync(path.join(planningDir, '.gsd-allow-shrink'), '.planning/STATE.md\n');
    const stateAllowed = runHook(writePayload(statePath, lines(60), { cwd: projectDir }));
    assert.equal(stateAllowed.status, 0,
      'the STATE.md collapse must pass under its own arming');
  });

  test('arming is conditional on the target existing, so /gsd:new-project leaves no unconsumed token', () => {
    // A new-project run has no ROADMAP.md: the guard exempts via ENOENT and
    // never consumes a token, so an unconditional arming would strand a live
    // 15-minute unlock on disk. The step must guard both armings with [ -f ].
    const src = fs.readFileSync(roadmapperPath, 'utf8');
    const stepStart = src.indexOf('## Step 7: Write Files Immediately');
    const step = src.slice(stepStart, src.indexOf('## Step 8', stepStart));
    for (const target of ['"$ROADMAP_TARGET"', '"$STATE_TARGET"']) {
      assert.ok(step.includes(`[ -f ${target} ] &&`),
        `Step 7 must gate the ${target} arming on the file existing — an unconditional ` +
        'arming on the new-project path strands an unconsumed sentinel (#2255 round 10)');
    }
  });

  // #5859: under a workstream (--ws) or a named project (GSD_PROJECT), init resolves ROADMAP.md
  // and STATE.md inside that scope's directory, and the spawn passes them as write targets. Step 7
  // must arm exactly those targets. Arming the root literal blocks the scoped Write and leaves a
  // live token on disk that authorizes a collapse of the root project's file instead.
  //
  // Each case runs Step 7's arming fence as shipped, with the init-resolved write target put in
  // place of the agent's placeholder (a no-op when the fence names a literal path), then sends the
  // Write through the real guard.
  const ROADMAP_LEG = { file: 'ROADMAP.md', field: 'roadmap_path', placeholder: '{roadmap_path}', fence: 1 };
  const STATE_LEG = { file: 'STATE.md', field: 'state_path', placeholder: '{state_path}', fence: 2 };
  const WORKSTREAM = { label: 'a workstream (--ws alpha)', args: ['--ws=alpha'], env: { GSD_PROJECT: '', GSD_WORKSTREAM: '' } };
  const NAMED_PROJECT = { label: 'a named project (GSD_PROJECT=beta)', args: [], env: { GSD_PROJECT: 'beta', GSD_WORKSTREAM: '' } };
  const FLAT = { label: 'a flat project', args: [], env: { GSD_PROJECT: '', GSD_WORKSTREAM: '' }, flat: true };
  // The compact variant carries its own inline copy of the arming, so both are run.
  const ROADMAPPERS = ['gsd-roadmapper.md', 'gsd-roadmapper.compact.md'];

  function scopedFixture() {
    const dir = fs.realpathSync(createTempGitProject('gsd-roadmapper-scope-'));
    fs.mkdirSync(path.join(dir, '.planning', 'workstreams', 'alpha'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.planning', 'beta'), { recursive: true });
    return dir;
  }

  function initPaths(dir, command, scope) {
    const r = runGsdTools(['init', command, ...scope.args], dir, { ...homeSandboxEnv(dir), ...scope.env });
    assert.equal(r.success, true, r.error);
    return JSON.parse(r.output);
  }

  function armingCommands(agent, leg) {
    const src = readFileNormalized(path.join(__dirname, '..', 'agents', agent));
    if (agent.endsWith('.compact.md')) {
      const m = src.match(new RegExp(`^\\d+\\. \\*\\*Write ${leg.file.replace('.', '\\.')}\\*\\* — arm first: \`([^\`]+)\``, 'm'));
      assert.ok(m, `${agent}: the inline ${leg.file} arming is missing or reworded — rebind this test`);
      return m[1];
    }
    const stepStart = src.indexOf('## Step 7: Write Files Immediately');
    assert.notEqual(stepStart, -1,
      `roadmapper Step 7 missing or renamed in ${agent} — rebind this test`);
    const step = src.slice(stepStart, src.indexOf('## Step 8', stepStart));
    return step.split('```bash')[leg.fence].split('```')[0];
  }

  function runStep7Arming(dir, leg, target, agent = 'gsd-roadmapper.md') {
    const fence = armingCommands(agent, leg).split(leg.placeholder).join(target);
    // `[ -f X ] && printf ...` exits 1 when X is absent; only a shell error fails here.
    const armed = spawnSync('bash', ['-c', fence], { cwd: dir, encoding: 'utf8', timeout: QUICK_SPAWN_TIMEOUT_MS });
    assert.equal(armed.error, undefined, `bash could not run Step 7's ${leg.file} fence: ${armed.error}`);
    assert.equal(armed.stderr, '', `Step 7's ${leg.file} fence must run cleanly: ${armed.stderr}`);
  }

  for (const agent of ROADMAPPERS) for (const scope of [WORKSTREAM, NAMED_PROJECT, FLAT]) {
    test(`${agent} /gsd:new-milestone under ${scope.label}: Step 7 arms the init-resolved ROADMAP.md and STATE.md${scope.flat ? '' : ', never the root project\'s'} (#5859)`,
      { skip: skipUnless('bash') }, () => {
        const dir = scopedFixture();
        try {
          const paths = initPaths(dir, 'new-milestone', scope);
          const tokenPath = path.join(dir, '.planning', '.gsd-allow-shrink');
          for (const leg of [ROADMAP_LEG, STATE_LEG]) {
            const rootFile = path.join(dir, '.planning', leg.file);
            const target = paths[leg.field];
            if (scope.flat) {
              // init now hands the fence an absolute root path where Step 7 once armed a literal.
              assert.equal(path.resolve(target), rootFile, `fixture: a flat project's ${leg.file} target is the root file`);
            } else {
              fs.writeFileSync(rootFile, lines(292, 'root'));
              assert.notEqual(path.resolve(target), rootFile, `fixture: init must resolve a scoped ${leg.file}`);
            }
            fs.writeFileSync(target, lines(292, 'outgoing milestone'));

            runStep7Arming(dir, leg, target, agent);
            // The new milestone's file (53 of 292 lines) is a legitimate collapse of the OUTGOING
            // scoped file: Step 7's arming must authorize exactly that Write.
            const res = runHook(writePayload(target, lines(53), { cwd: dir }));
            assert.equal(res.status, 0,
              `Step 7's arming must authorize the scoped target ${target}; the guard blocked it: ${res.stdout}`);
            assert.equal(fs.existsSync(tokenPath), false,
              `no unconsumed shrink token may be left after the ${leg.file} write: it would authorize ` +
              `collapsing the root project's ${leg.file}`);
            if (!scope.flat) {
              assert.equal(fs.readFileSync(rootFile, 'utf8'), lines(292, 'root'), `the root ${leg.file} must be untouched`);
            }
          }
        } finally {
          cleanup(dir);
        }
      });
  }

  for (const agent of ROADMAPPERS) test(`${agent} /gsd:new-project under ${NAMED_PROJECT.label}: Step 7 leaves no token armed for the root project's ROADMAP.md or STATE.md (#5859)`,
    { skip: skipUnless('bash') }, () => {
      const dir = scopedFixture();
      try {
        fs.writeFileSync(path.join(dir, '.planning', 'ROADMAP.md'), lines(292, 'root'));
        fs.writeFileSync(path.join(dir, '.planning', 'STATE.md'), lines(292, 'root'));
        const paths = initPaths(dir, 'new-project', NAMED_PROJECT);
        const tokenPath = path.join(dir, '.planning', '.gsd-allow-shrink');
        for (const leg of [ROADMAP_LEG, STATE_LEG]) {
          const target = paths[leg.field];
          assert.ok(target, `init new-project must report ${leg.field}, the roadmapper's ${leg.file} write target`);
          assert.equal(fs.existsSync(target), false, `fixture: the named project has no ${leg.file} yet`);

          runStep7Arming(dir, leg, target, agent);
          const res = runHook(writePayload(target, lines(53), { cwd: dir }));
          assert.equal(res.status, 0, `the new project's first ${leg.file} Write must pass: ${res.stdout}`);
          assert.equal(fs.existsSync(tokenPath), false,
            `Step 7 must not arm a token when the named project's ${leg.file} does not exist yet: an ` +
            `unconsumed token lives 15 minutes and lets a later collapse of the root ${leg.file} through`);
        }
      } finally {
        cleanup(dir);
      }
    });

  // #5859: the fixture tests above substitute init's paths for the agent's
  // placeholders themselves, so they cannot see the workflow -> agent link. The
  // roadmapper falls back to root .planning/ paths when its prompt names no
  // target, so every create/revise spawn must pass all three targets.
  test('new-project and new-milestone pass the init-resolved write targets to every roadmapper spawn (#5859)', () => {
    const want = ['ROADMAP.md: {roadmap_path}', 'STATE.md: {state_path}', 'REQUIREMENTS.md: {requirements_path}'];
    for (const [file, spawns] of [['new-project.md', 2], ['new-milestone.md', 1]]) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'workflows', file), 'utf8');
      const blocks = [...src.matchAll(/<write_targets>([\s\S]{0,400}?)<\/write_targets>/g)].map((m) => m[1]);
      assert.equal(blocks.length, spawns, `${file}: expected ${spawns} <write_targets> block(s), one per roadmapper spawn`);
      for (const body of blocks) {
        for (const line of want) assert.ok(body.includes(line), `${file}: <write_targets> must name "${line}"`);
      }
    }
    const milestone = fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'workflows', 'new-milestone.md'), 'utf8');
    assert.match(milestone, /re-spawn roadmapper[^\n]*same `<write_targets>` block/,
      'new-milestone.md: the Adjust re-spawn must reuse the same <write_targets> block');
  });

  // #5859: the synthesizer commits all the research in one call (its Step 7). A named project keeps
  // its research in its own directory, so that commit must stage that directory only; committing the
  // root .planning/research/ commits the root project's research and leaves the named project's
  // untracked. Each case runs the Step 7 fence as shipped, launcher preamble and real `query commit`
  // included, with the research directory put in place of the agent's placeholder (a no-op when the
  // fence names a literal path). The directory stands in for init's research_dir, which still
  // resolves to the root under GSD_PROJECT until #5858 lands.
  for (const agent of ['gsd-research-synthesizer.md', 'gsd-research-synthesizer.compact.md']) {
    test(`${agent} Step 7 under ${NAMED_PROJECT.label}: the research commit stages only the named project's research directory (#5859)`,
      { skip: skipUnless('bash') }, () => {
        const dir = scopedFixture();
        try {
          fs.writeFileSync(path.join(dir, '.planning', 'beta', 'PROJECT.md'), '# Beta\n');
          gitOrThrow(['add', '-A'], { cwd: dir });
          gitOrThrow(['commit', '-m', 'add the beta project'], { cwd: dir });
          const rootResearch = path.join(dir, '.planning', 'research');
          const scopedResearch = path.join(dir, '.planning', 'beta', 'research');
          for (const [researchDir, tag] of [[rootResearch, 'root'], [scopedResearch, 'beta']]) {
            fs.mkdirSync(researchDir, { recursive: true });
            for (const file of ['STACK.md', 'SUMMARY.md']) fs.writeFileSync(path.join(researchDir, file), `${tag} ${file}\n`);
          }

          const src = readFileNormalized(path.join(__dirname, '..', 'agents', agent));
          const stepStart = src.indexOf('## Step 7: Commit All Research');
          assert.notEqual(stepStart, -1, `synthesizer Step 7 missing or renamed in ${agent} — rebind this test`);
          const step = src.slice(stepStart, src.indexOf('## Step 8', stepStart));
          const fence = step.split('```bash')[1].split('```')[0].split('{research_dir}').join(toPosixPath(scopedResearch));
          // RUNTIME_DIR pins the preamble's gsd_run to this checkout's gsd-tools.cjs; an empty
          // CLAUDE_ENV_FILE keeps it from appending to a live session's env file.
          const env = {
            ...process.env, ...helpers.TEST_ENV_BASE, ...homeSandboxEnv(dir), ...NAMED_PROJECT.env,
            RUNTIME_DIR: path.join(__dirname, '..'), CLAUDE_ENV_FILE: '',
          };
          const run = spawnSync('bash', ['-c', fence], { cwd: dir, env, encoding: 'utf8', timeout: GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS });
          assert.equal(run.error, undefined, `bash could not run ${agent}'s Step 7 fence: ${run.error}`);
          assert.equal(run.status, 0, `${agent}'s Step 7 commit fence failed: ${run.stderr}`);
          assert.equal(JSON.parse(run.stdout).committed, true, `query commit must commit the research: ${run.stdout}`);

          const committed = gitOrThrow(['show', '--name-only', '--format=', 'HEAD'], { cwd: dir }).split('\n').filter(Boolean).sort();
          assert.deepEqual(committed, ['.planning/beta/research/STACK.md', '.planning/beta/research/SUMMARY.md'],
            `${agent}'s Step 7 must commit the named project's research directory and nothing else`);
          const pending = gitOrThrow(['status', '--porcelain', '--untracked-files=all', '--', '.planning'], { cwd: dir })
            .split('\n').filter(Boolean).sort();
          assert.deepEqual(pending, ['?? .planning/research/STACK.md', '?? .planning/research/SUMMARY.md'],
            "the root project's research must be neither staged nor committed");
          for (const file of ['STACK.md', 'SUMMARY.md']) {
            assert.equal(fs.readFileSync(path.join(rootResearch, file), 'utf8'), `root ${file}\n`, `the root ${file} must be untouched`);
          }
        } finally {
          cleanup(dir);
        }
      });
  }
});
