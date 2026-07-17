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
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createTempDir, cleanup } = require('./helpers.cjs');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'gsd-write-guard.js');

/**
 * Run the hook with a given payload. The override env var is stripped by
 * default so an outer environment can never leak a bypass into the tests;
 * pass extraEnv to set it explicitly.
 */
function runHook(payload, extraEnv = {}) {
  const env = { ...process.env };
  delete env.GSD_ALLOW_PLANNING_SHRINK;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [HOOK_PATH], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env,
  });
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
    assert.ok(r.stderr.includes('GSD_ALLOW_PLANNING_SHRINK'),
      `stderr must carry the block reason incl. the override name. Got: ${r.stderr}`);
  });

  test('Kimi StrReplaceFile stays exempt (Edit-class, out of scope by design)', () => {
    fs.writeFileSync(roadmapPath, lines(292));
    const r = runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'StrReplaceFile',
      tool_input: { path: roadmapPath, edit: { old: 'line 1', new: 'line one' } },
    });
    assert.equal(r.status, 0, 'StrReplaceFile normalizes to Edit, which the guard exempts by design (#2255)');
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
});

describe('guard <-> complete-milestone workflow binding (the escape hatch is WIRED, not just present)', () => {
  // #2255 review Blocker 1: the one first-party legitimate milestone reset —
  // complete-milestone's reorganize step — must actually set the escape hatch,
  // or the guard hard-blocks the tree's own workflow mid-step. The env var
  // name is taken from the guard's typed output, so a rename on EITHER side
  // fails here instead of silently unwiring the hatch.
  const workflowPath = path.join(
    __dirname, '..', 'gsd-core', 'workflows', 'complete-milestone.md'
  );

  test('the reorganize step sets the exact override the guard honors', () => {
    const src = fs.readFileSync(workflowPath, 'utf8');
    const stepStart = src.indexOf('<step name="reorganize_roadmap_and_delete_originals">');
    assert.notEqual(stepStart, -1,
      'reorganize step missing or renamed in complete-milestone.md — rebind this test');
    const step = src.slice(stepStart, src.indexOf('</step>', stepStart));

    fs.writeFileSync(roadmapPath, lines(292));
    const blocked = runHook(writePayload(roadmapPath, lines(16)));
    assert.equal(blocked.status, 2, 'baseline: the reorganize-shaped Write must block without the hatch');
    const envVar = JSON.parse(blocked.stdout).overrideEnvVar;

    assert.ok(step.includes(`${envVar}=1`),
      `complete-milestone.md's reorganize step no longer sets ${envVar}=1 — ` +
      'its whole-file ROADMAP.md rewrite would be hard-blocked by gsd-write-guard (#2255 Blocker 1)');

    const allowed = runHook(writePayload(roadmapPath, lines(16)), { [envVar]: '1' });
    assert.equal(allowed.status, 0,
      'the identical catastrophic payload must pass under the env the workflow step sets');
  });
});
