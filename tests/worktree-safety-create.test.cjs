'use strict';

/**
 * `worktree create` / `worktree record-agent` — contract rows (#5232 mutation work).
 *
 * Seam: gsd-core/bin/lib/worktree-safety.cjs
 * Interface: planWorktreeRecordAgent, cmdWorktreeRecordAgent, planWorktreeCreate,
 *            executeWorktreeCreatePlan, cmdWorktreeCreate
 *
 * WHY A SEPARATE FILE
 * `tests/worktree-safety.test.cjs` already exercises the happy paths of both
 * verbs, but its rows assert `result.reason` and little else, so Stryker found
 * the operator-facing half of the contract unpinned: WHICH flag a missing-field
 * hint names, the exact `[gsd] worktree.<verb>: <reason> — <hint>` stderr line,
 * the machine-readable stdout JSON the orchestrator parses, the git argv and
 * `cwd` the create path hands to `execGit`, the fail-closed early return for a
 * non-ok plan, and the manifest-shape rules (bare array, missing `worktrees`,
 * scalar JSON). Each row below asserts one of those outcomes and, where one
 * exists, pairs it with the near-miss that must answer the other way.
 *
 * Every row drives the module IN-PROCESS through its injected `deps` seams
 * (`readFile`, `writeFile`, `write`, `writeErr`, `execGit`). The two "default
 * deps" rows use a real temp manifest and capture process stdio, because the
 * defaults themselves (fs + stdout/stderr) are the contract under test there.
 */

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');

const {
  planWorktreeRecordAgent,
  cmdWorktreeRecordAgent,
  planWorktreeCreate,
  executeWorktreeCreatePlan,
  cmdWorktreeCreate,
} = require('../gsd-core/bin/lib/worktree-safety.cjs');

// ─── Shared fixtures ─────────────────────────────────────────────────────────

const WT_PATH = '/repo/.claude/worktrees/agent-a1';
const BRANCH = 'worktree-agent-a1';
const BASE = 'abc123';
const FIELDS = Object.freeze({ agentId: 'a1', worktreePath: WT_PATH, branch: BRANCH, base: BASE });
const EMPTY_MANIFEST = '{"orchestrator_root":"/repo","worktrees":[]}';
/** The minimal 4-field on-disk entry both verbs must write (FIX 2 shape). */
const RECORDED = Object.freeze({ agent_id: 'a1', worktree_path: WT_PATH, branch: BRANCH, expected_base: BASE });

const recordArgs = (extra = []) => [
  '--manifest', 'manifest.json',
  '--agent-id', 'a1', '--path', WT_PATH, '--branch', BRANCH, '--base', BASE,
  ...extra,
];
const createArgs = (extra = []) => [...recordArgs(), '--root', '/repo', ...extra];

const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '', timedOut: false });

/**
 * Drive a cmd* verb with fake deps; capture stdout/stderr text, every git call,
 * every manifest write, and the exitCode the verb set (restored afterwards so a
 * deliberate failure row never fails the test process).
 */
function runCmd(cmd, args, { manifest = EMPTY_MANIFEST, readFile, writeFile, git } = {}) {
  const out = [];
  const err = [];
  const gitCalls = [];
  const writes = [];
  const saved = process.exitCode;
  let exitCode;
  let result;
  try {
    process.exitCode = undefined;
    result = cmd('/repo/main', args, {
      readFile: readFile || (() => manifest),
      writeFile: writeFile || ((p, c) => { writes.push({ path: p, content: c }); }),
      write: (s) => out.push(s),
      writeErr: (s) => err.push(s),
      execGit: (a, o) => { gitCalls.push({ args: a, opts: o }); return git ? git(a, o) : ok(); },
    });
    exitCode = process.exitCode;
  } finally {
    process.exitCode = saved;
  }
  const stdout = out.join('');
  return { result, stdout, stderr: err.join(''), gitCalls, writes, exitCode, json: stdout ? JSON.parse(stdout) : null };
}

/** Run `fn` with process.stdout/stderr captured and exitCode restored. */
function withProcessStdio(fn) {
  const out = [];
  const err = [];
  const savedOut = process.stdout.write;
  const savedErr = process.stderr.write;
  const savedCode = process.exitCode;
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  process.stderr.write = (s) => { err.push(String(s)); return true; };
  try {
    const result = fn();
    return { result, stdout: out.join(''), stderr: err.join(''), exitCode: process.exitCode };
  } finally {
    process.stdout.write = savedOut;
    process.stderr.write = savedErr;
    process.exitCode = savedCode;
  }
}

/** The operator-facing stderr line every failure path emits. */
const errLine = (verb, reason, detail) => `[gsd] worktree.${verb}: ${reason} — ${detail}\n`;

// ─── planWorktreeRecordAgent ─────────────────────────────────────────────────

describe('planWorktreeRecordAgent: the missing-field hint names exactly the absent flags', () => {
  test('every field absent → all four flags, in flag order, comma-separated', () => {
    const plan = planWorktreeRecordAgent(EMPTY_MANIFEST, {});
    assert.equal(plan.reason, 'missing_field');
    assert.match(plan.hint, /^record-agent requires --agent-id, --path, --branch, --base\. Re-run/);
    assert.equal(plan.manifest, null, 'a failed plan must never carry a manifest to write');
  });

  test('only --path absent (undefined, not empty) → the hint names --path alone', () => {
    const plan = planWorktreeRecordAgent(EMPTY_MANIFEST, { ...FIELDS, worktreePath: undefined });
    assert.equal(plan.ok, false);
    assert.match(plan.hint, /^record-agent requires --path\. /);
  });

  test('only --base absent (undefined) → the hint names --base alone', () => {
    const plan = planWorktreeRecordAgent(EMPTY_MANIFEST, { ...FIELDS, base: undefined });
    assert.equal(plan.ok, false);
    assert.match(plan.hint, /^record-agent requires --base\. /);
  });
});

describe('planWorktreeRecordAgent: --deletions (#3003) is recorded only when declared', () => {
  test('a declared deletion list lands on the entry AND in the manifest to write', () => {
    const plan = planWorktreeRecordAgent(EMPTY_MANIFEST, { ...FIELDS, deletions: 'old.txt  lib/gone.js' });
    assert.equal(plan.ok, true);
    assert.equal(plan.reason, 'ok');
    assert.deepEqual(plan.entry, { ...RECORDED, declared_deletions: ['old.txt', 'lib/gone.js'] });
    assert.deepEqual(JSON.parse(plan.manifest).worktrees, [plan.entry]);
  });

  test('near-miss: a whitespace-only --deletions leaves the 4-field shape untouched', () => {
    const plan = planWorktreeRecordAgent(EMPTY_MANIFEST, { ...FIELDS, deletions: '   ' });
    assert.deepEqual(plan.entry, RECORDED);
  });
});

describe('planWorktreeRecordAgent: manifest shell acceptance', () => {
  test('invalid JSON → invalid_manifest_json with the init-shell recovery hint', () => {
    const plan = planWorktreeRecordAgent('{not json', FIELDS);
    assert.equal(plan.reason, 'invalid_manifest_json');
    assert.match(plan.hint, /^Manifest is not valid JSON\. .*\{"orchestrator_root": "\.\.\.", "worktrees": \[\]\}/);
  });

  for (const raw of ['null', '42', '"a string"', 'true']) {
    test(`scalar JSON ${raw} → manifest_shape_invalid (never a write, never a throw)`, () => {
      const plan = planWorktreeRecordAgent(raw, FIELDS);
      assert.deepEqual(plan, {
        ok: false,
        reason: 'manifest_shape_invalid',
        hint: 'Manifest must be a JSON object {"worktrees": []} or a top-level array.',
        entry: null,
        manifest: null,
      });
    });
  }

  test('an object WITHOUT "worktrees" gets one created, other top-level keys preserved', () => {
    const plan = planWorktreeRecordAgent('{"orchestrator_root":"/repo"}', FIELDS);
    assert.equal(plan.ok, true);
    assert.deepEqual(JSON.parse(plan.manifest), { orchestrator_root: '/repo', worktrees: [RECORDED] });
  });

  test('near-miss: a non-array "worktrees" is a shape error, not silently replaced', () => {
    const plan = planWorktreeRecordAgent('{"worktrees":{}}', FIELDS);
    assert.equal(plan.reason, 'manifest_shape_invalid');
    assert.match(plan.hint, /^Manifest "worktrees" must be an array\. Re-initialize/);
  });
});

// ─── cmdWorktreeRecordAgent ──────────────────────────────────────────────────

describe('cmdWorktreeRecordAgent: stdout JSON + stderr line per outcome', () => {
  test('unreadable manifest → read-failed hint names the path; stdout carries the error', () => {
    const r = runCmd(cmdWorktreeRecordAgent, recordArgs(), {
      readFile: () => { throw new Error('ENOENT: no such file'); },
    });
    assert.match(r.result.hint, /^Manifest not found or unreadable at manifest\.json\. The orchestrator must initialize it/);
    assert.deepEqual(r.result, { ok: false, reason: 'manifest_read_failed', hint: r.result.hint, entry: null });
    assert.deepEqual(r.json, { ok: false, reason: 'manifest_read_failed', hint: r.result.hint, error: 'ENOENT: no such file' });
    assert.ok(r.stdout.endsWith('}\n'));
    assert.equal(r.stderr, errLine('record-agent', 'manifest_read_failed', r.result.hint));
    assert.equal(r.exitCode, 1);
    assert.equal(r.writes.length, 0);
  });

  test('a planner rejection is mirrored to stdout as {ok:false, reason, hint}', () => {
    const r = runCmd(cmdWorktreeRecordAgent, ['--manifest', 'manifest.json', '--agent-id', 'a1']);
    assert.equal(r.result.reason, 'missing_field');
    assert.deepEqual(r.json, { ok: false, reason: 'missing_field', hint: r.result.hint });
    assert.equal(r.stderr, errLine('record-agent', 'missing_field', r.result.hint));
    assert.equal(r.exitCode, 1);
    assert.equal(r.writes.length, 0, 'a rejected entry must never reach the manifest');
  });

  test('success → writes the manifest at the resolved path and reports reason "ok"', () => {
    const r = runCmd(cmdWorktreeRecordAgent, recordArgs(['--deletions', 'gone.md']));
    const resolved = path.resolve('/repo/main', 'manifest.json');
    const entry = { ...RECORDED, declared_deletions: ['gone.md'] };
    assert.deepEqual(r.result, { ok: true, reason: 'ok', entry, manifest_path: resolved });
    assert.deepEqual(r.json, { ok: true, reason: 'ok', entry, manifest_path: resolved });
    assert.equal(r.writes.length, 1);
    assert.equal(r.writes[0].path, resolved);
    assert.deepEqual(JSON.parse(r.writes[0].content).worktrees, [entry], '--deletions must flow through the CLI');
    assert.equal(r.exitCode, undefined, 'success must not set a failing exit code');
  });
});

describe('cmdWorktreeRecordAgent: default deps are the real fs and process stdio', () => {
  const dirs = [];
  after(() => { for (const d of dirs) cleanup(d); });

  test('reads + rewrites the manifest on disk; JSON to stdout, nothing to stderr', () => {
    const dir = createTempDir('gsd-ws-record-');
    dirs.push(dir);
    const manifestPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestPath, EMPTY_MANIFEST);
    const { result, stdout, stderr } = withProcessStdio(() => cmdWorktreeRecordAgent(dir, recordArgs()));
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).worktrees, [RECORDED]);
    assert.deepEqual(JSON.parse(stdout).entry, RECORDED);
    assert.equal(stderr, '');
  });

  test('near-miss: a missing manifest file → stderr hint line + stdout JSON, exit 1', () => {
    const dir = createTempDir('gsd-ws-record-');
    dirs.push(dir);
    const { result, stdout, stderr, exitCode } = withProcessStdio(() => cmdWorktreeRecordAgent(dir, recordArgs()));
    assert.equal(result.reason, 'manifest_read_failed');
    assert.equal(stderr, errLine('record-agent', 'manifest_read_failed', result.hint));
    assert.equal(JSON.parse(stdout).reason, 'manifest_read_failed');
    assert.equal(exitCode, 1);
  });
});

// ─── planWorktreeCreate ──────────────────────────────────────────────────────

describe('planWorktreeCreate: write-strict required fields', () => {
  test('every field absent → all four flags named, in flag order', () => {
    const plan = planWorktreeCreate({});
    assert.equal(plan.reason, 'missing_field');
    assert.match(plan.hint, /^worktree create requires --agent-id, --path, --branch, --base\. Re-run/);
  });

  const blanks = [
    ['agentId', '--agent-id'],
    ['worktreePath', '--path'],
    ['branch', '--branch'],
    ['base', '--base'],
  ];
  for (const [field, flag] of blanks) {
    test(`a whitespace-only ${flag} is missing, not a value (trimmed before the check)`, () => {
      const plan = planWorktreeCreate({ ...FIELDS, [field]: '   ' });
      assert.equal(plan.ok, false);
      assert.equal(plan.reason, 'missing_field');
      assert.match(plan.hint, new RegExp(`^worktree create requires ${flag}\\. `));
    });
  }

  test('near-miss: surrounding whitespace is trimmed off a real value', () => {
    const plan = planWorktreeCreate({ agentId: ' a1 ', worktreePath: ` ${WT_PATH} `, branch: ` ${BRANCH}`, base: `${BASE} ` });
    assert.equal(plan.ok, true);
    assert.equal(plan.entry.worktree_path, WT_PATH);
    assert.equal(plan.entry.branch, BRANCH);
    assert.equal(plan.entry.expected_base, BASE);
  });
});

describe('planWorktreeCreate: validation hints identify the offending value', () => {
  test('a branch outside the agent namespace → invalid_entry naming the pattern and the branch', () => {
    const plan = planWorktreeCreate({ ...FIELDS, branch: 'feature-x' });
    assert.equal(plan.reason, 'invalid_entry');
    assert.ok(plan.hint.startsWith('Entry failed cleanup-manifest validation: '), plan.hint);
    assert.ok(plan.hint.includes('--branch must match ^((worktree-)?agent-|worktree-wf_)'), plan.hint);
    assert.ok(plan.hint.includes('got branch="feature-x"'), plan.hint);
  });

  test('a leading-dash base is refused (would be parsed by git as a flag)', () => {
    const plan = planWorktreeCreate({ ...FIELDS, base: '--upload-pack=x' });
    assert.equal(plan.reason, 'unsafe_leading_dash');
    assert.ok(plan.hint.startsWith('--branch/--base/--path must not start with "-"'), plan.hint);
    assert.ok(plan.hint.includes(`base="--upload-pack=x" path="${WT_PATH}"`), plan.hint);
  });

  test('near-miss: a TRAILING dash on the branch is not a flag and is accepted', () => {
    const plan = planWorktreeCreate({ ...FIELDS, branch: 'worktree-agent-a1-' });
    assert.equal(plan.ok, true);
    assert.equal(plan.entry.branch, 'worktree-agent-a1-');
  });

  test('a ".." segment in --path → unsafe_path_traversal quoting the path', () => {
    const plan = planWorktreeCreate({ ...FIELDS, worktreePath: '/repo/../etc/agent-a1' });
    assert.equal(plan.reason, 'unsafe_path_traversal');
    assert.equal(plan.hint, '--path must not contain a ".." path segment (got: "/repo/../etc/agent-a1").');
  });

  test('--deletions is carried onto the entry; blank leaves it off', () => {
    assert.deepEqual(planWorktreeCreate({ ...FIELDS, deletions: 'a.md b.md' }).entry.declared_deletions, ['a.md', 'b.md']);
    assert.equal('declared_deletions' in planWorktreeCreate({ ...FIELDS, deletions: ' ' }).entry, false);
  });
});

// ─── executeWorktreeCreatePlan ───────────────────────────────────────────────

describe('executeWorktreeCreatePlan: fail-closed, base-first, exact git argv', () => {
  const validEntry = () => planWorktreeCreate(FIELDS).entry;
  function exec(plan, git) {
    const calls = [];
    const result = executeWorktreeCreatePlan(plan, '/repo/main', {
      execGit: (a, o) => { calls.push({ args: a, opts: o }); return git ? git(a) : ok(); },
    });
    return { result, calls };
  }

  test('no plan → missing_plan, and no git runs', () => {
    const { result, calls } = exec(null);
    assert.deepEqual(result, { ok: false, reason: 'missing_plan' });
    assert.equal(calls.length, 0);
  });

  test('a non-ok plan never runs git, even if it happens to carry an entry', () => {
    const { result, calls } = exec({ ok: false, reason: 'invalid_entry', entry: validEntry() });
    assert.deepEqual(result, { ok: false, reason: 'invalid_entry' });
    assert.equal(calls.length, 0);
  });

  test('an ok-flagged plan WITHOUT an entry still fails closed before git', () => {
    const { result, calls } = exec({ ok: true, reason: 'ok', entry: null });
    assert.equal(result.ok, false);
    assert.equal(calls.length, 0);
  });

  test('success: peel base to a commit, then add -b <branch> <path> <base>, both in repoRoot', () => {
    const { result, calls } = exec({ ok: true, reason: 'ok', entry: validEntry() });
    assert.deepEqual(calls, [
      { args: ['rev-parse', '--verify', '--quiet', `${BASE}^{commit}`], opts: { cwd: '/repo/main' } },
      { args: ['worktree', 'add', '-b', BRANCH, WT_PATH, BASE], opts: { cwd: '/repo/main' } },
    ]);
    assert.deepEqual(result, { ok: true, reason: 'created', worktree_path: WT_PATH, branch: BRANCH, base: BASE, cwd: WT_PATH });
  });

  test('an unresolvable base stops before add and surfaces git stderr verbatim', () => {
    const { result, calls } = exec({ ok: true, reason: 'ok', entry: validEntry() },
      () => ({ exitCode: 128, stdout: '', stderr: 'fatal: bad revision', timedOut: false }));
    assert.equal(calls.length, 1, 'nothing may be created on a bad base');
    assert.deepEqual(result, { ok: false, reason: 'base_unresolved', worktree_path: WT_PATH, branch: BRANCH, base: BASE, stderr: 'fatal: bad revision' });
  });

  test('near-miss: a base failure with NO stderr reports stderr as an empty string', () => {
    const { result } = exec({ ok: true, reason: 'ok', entry: validEntry() },
      () => ({ exitCode: 1, stdout: '', timedOut: false }));
    assert.equal(result.reason, 'base_unresolved');
    assert.equal(result.stderr, '');
  });

  test('a clean add failure with no stderr → worktree_add_failed, stderr "", and NO rollback', () => {
    const { result, calls } = exec({ ok: true, reason: 'ok', entry: validEntry() },
      (a) => (a[0] === 'rev-parse' ? ok('deadbeef') : { exitCode: 128, stdout: '', timedOut: false }));
    assert.equal(result.reason, 'worktree_add_failed');
    assert.equal(result.stderr, '');
    assert.equal(calls.length, 2, 'FIX 5: a collision may be a live peer — never `remove --force` it');
  });
});

// ─── cmdWorktreeCreate ───────────────────────────────────────────────────────

describe('cmdWorktreeCreate: manifest problems fail before any git side effect', () => {
  test('unreadable manifest → read-failed hint + stdout JSON carrying the IO error', () => {
    const r = runCmd(cmdWorktreeCreate, createArgs(), { readFile: () => { throw new Error('EACCES'); } });
    assert.match(r.result.hint, /^Manifest not found or unreadable at manifest\.json\. .*before creating agent worktrees\.$/);
    assert.deepEqual(r.result, { ok: false, reason: 'manifest_read_failed', hint: r.result.hint });
    assert.deepEqual(r.json, { ok: false, reason: 'manifest_read_failed', hint: r.result.hint, error: 'EACCES' });
    assert.equal(r.stderr, errLine('create', 'manifest_read_failed', r.result.hint));
    assert.equal(r.gitCalls.length, 0);
  });

  test('invalid JSON → invalid_manifest_json on stderr AND stdout, no git', () => {
    const r = runCmd(cmdWorktreeCreate, createArgs(), { manifest: '{oops' });
    assert.match(r.result.hint, /^Manifest is not valid JSON\. .*before creating agent worktrees\.$/);
    assert.deepEqual(r.json, { ok: false, reason: 'invalid_manifest_json', hint: r.result.hint });
    assert.equal(r.stderr, errLine('create', 'invalid_manifest_json', r.result.hint));
    assert.equal(r.exitCode, 1);
    assert.equal(r.gitCalls.length, 0);
  });

  test('a non-array "worktrees" → manifest_shape_invalid, no git', () => {
    const r = runCmd(cmdWorktreeCreate, createArgs(), { manifest: '{"worktrees":"x"}' });
    assert.match(r.result.hint, /^Manifest "worktrees" must be an array\. /);
    assert.deepEqual(r.json, { ok: false, reason: 'manifest_shape_invalid', hint: r.result.hint });
    assert.equal(r.stderr, errLine('create', 'manifest_shape_invalid', r.result.hint));
    assert.equal(r.gitCalls.length, 0);
  });

  for (const raw of ['null', '7', '"str"']) {
    test(`scalar JSON ${raw} → manifest_shape_invalid (object-or-array hint), no git`, () => {
      const r = runCmd(cmdWorktreeCreate, createArgs(), { manifest: raw });
      const hint = 'Manifest must be a JSON object {"worktrees": []} or a top-level array.';
      assert.deepEqual(r.result, { ok: false, reason: 'manifest_shape_invalid', hint });
      assert.deepEqual(r.json, { ok: false, reason: 'manifest_shape_invalid', hint });
      assert.equal(r.stderr, errLine('create', 'manifest_shape_invalid', hint));
      assert.equal(r.exitCode, 1);
      assert.equal(r.gitCalls.length, 0);
    });
  }
});

describe('cmdWorktreeCreate: planner and confinement rejections', () => {
  test('a planner rejection prints its hint on stderr and mirrors it to stdout', () => {
    const r = runCmd(cmdWorktreeCreate, ['--manifest', 'manifest.json', '--root', '/repo']);
    assert.equal(r.result.reason, 'missing_field');
    assert.match(r.result.hint, /^worktree create requires --agent-id, --path, --branch, --base\./);
    assert.equal(r.stderr, errLine('create', 'missing_field', r.result.hint));
    assert.deepEqual(r.json, { ok: false, reason: 'missing_field', hint: r.result.hint });
    assert.equal(r.gitCalls.length, 0);
  });

  test('no --root → root_required with the #3050 recovery hint, no git', () => {
    const r = runCmd(cmdWorktreeCreate, recordArgs());
    assert.match(r.result.hint, /^--root is required \(fail-closed root confinement, #3050\)\. Pass --root/);
    assert.deepEqual(r.json, { ok: false, reason: 'root_required', hint: r.result.hint });
    assert.equal(r.stderr, errLine('create', 'root_required', r.result.hint));
    assert.equal(r.gitCalls.length, 0);
  });

  test('a path outside --root → the hint quotes BOTH resolved paths, no git', () => {
    const r = runCmd(cmdWorktreeCreate, [...recordArgs(), '--root', '/repo/main']);
    const absRoot = path.resolve('/repo/main', '/repo/main');
    const absWt = path.resolve('/repo/main', WT_PATH);
    assert.ok(r.result.hint.startsWith(`--path must resolve INSIDE --root (root="${absRoot}", path="${absWt}"). `), r.result.hint);
    assert.deepEqual(r.json, { ok: false, reason: 'path_outside_root', hint: r.result.hint });
    assert.equal(r.stderr, errLine('create', 'path_outside_root', r.result.hint));
    assert.equal(r.gitCalls.length, 0);
  });
});

describe('cmdWorktreeCreate: the manifest it writes', () => {
  test('success without --files/--deletions → the minimal 4-field entry, reason "created" on stdout', () => {
    const r = runCmd(cmdWorktreeCreate, createArgs());
    const resolved = path.resolve('/repo/main', 'manifest.json');
    assert.deepEqual(r.result, { ok: true, reason: 'created', entry: RECORDED, cwd: WT_PATH, manifest_path: resolved });
    assert.deepEqual(r.json, r.result);
    assert.deepEqual(JSON.parse(r.writes[0].content), { orchestrator_root: '/repo', worktrees: [RECORDED] });
    assert.equal(r.stderr, '');
  });

  test('--files and --deletions both flow from the CLI onto the written entry', () => {
    const r = runCmd(cmdWorktreeCreate, createArgs(['--files', 'src/a.js', '--deletions', 'old.js legacy.js']));
    const entry = { ...RECORDED, files_modified: ['src/a.js'], declared_deletions: ['old.js', 'legacy.js'] };
    assert.deepEqual(r.result.entry, entry);
    assert.deepEqual(JSON.parse(r.writes[0].content).worktrees, [entry]);
  });

  test('a bare top-level array manifest stays an array, with the entry appended', () => {
    const r = runCmd(cmdWorktreeCreate, createArgs(), { manifest: '[]' });
    assert.equal(r.result.ok, true);
    assert.deepEqual(JSON.parse(r.writes[0].content), [RECORDED]);
  });

  test('an object with no "worktrees" key gains exactly [entry], other keys kept', () => {
    const r = runCmd(cmdWorktreeCreate, createArgs(), { manifest: '{"orchestrator_root":"/repo"}' });
    assert.deepEqual(JSON.parse(r.writes[0].content), { orchestrator_root: '/repo', worktrees: [RECORDED] });
  });

  test('a malformed existing entry is ignored by dedupe (as the reader would) and preserved', () => {
    const junk = { agent_id: 'junk' };
    const r = runCmd(cmdWorktreeCreate, createArgs(), { manifest: JSON.stringify({ worktrees: [junk] }) });
    assert.equal(r.result.ok, true);
    assert.deepEqual(JSON.parse(r.writes[0].content).worktrees, [junk, RECORDED]);
  });
});

describe('cmdWorktreeCreate: git and write failures', () => {
  test('a git failure prints reason + git stderr on stderr; stdout JSON carries the stderr', () => {
    const r = runCmd(cmdWorktreeCreate, createArgs(), {
      git: () => ({ exitCode: 128, stdout: '', stderr: 'fatal: invalid ref', timedOut: false }),
    });
    assert.deepEqual(r.result, { ok: false, reason: 'base_unresolved', stderr: 'fatal: invalid ref' });
    assert.equal(r.stderr, errLine('create', 'base_unresolved', 'fatal: invalid ref'));
    assert.deepEqual(r.json, { ok: false, reason: 'base_unresolved', stderr: 'fatal: invalid ref' });
    assert.equal(r.writes.length, 0, 'a failed create must not record a manifest entry');
  });

  test('near-miss: a git timeout (no stderr) prints an empty detail, not a placeholder', () => {
    const r = runCmd(cmdWorktreeCreate, createArgs(), { git: () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }) });
    assert.equal(r.result.reason, 'git_timeout');
    assert.equal(r.stderr, errLine('create', 'git_timeout', ''));
    assert.deepEqual(r.json, { ok: false, reason: 'git_timeout' });
  });

  test('a manifest write failure after add rolls the worktree back and reports manifest_write_failed', () => {
    const r = runCmd(cmdWorktreeCreate, createArgs(), { writeFile: () => { throw new Error('ENOSPC'); } });
    assert.equal(r.result.reason, 'manifest_write_failed');
    assert.ok(r.result.hint.startsWith('The worktree was created but the manifest write failed (ENOSPC); rolled back'), r.result.hint);
    assert.deepEqual(r.json, { ok: false, reason: 'manifest_write_failed', hint: r.result.hint, error: 'ENOSPC' });
    assert.equal(r.stderr, errLine('create', 'manifest_write_failed', r.result.hint));
    assert.deepEqual(r.gitCalls[r.gitCalls.length - 1], {
      args: ['worktree', 'remove', '--force', WT_PATH], opts: { cwd: '/repo/main' },
    });
  });
});

describe('cmdWorktreeCreate: default deps are the real fs and process stdio', () => {
  const dirs = [];
  after(() => { for (const d of dirs) cleanup(d); });

  function fixture() {
    const dir = createTempDir('gsd-ws-create-');
    dirs.push(dir);
    const manifestPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestPath, EMPTY_MANIFEST);
    const wt = path.join(dir, 'wts', 'agent-a1');
    const args = ['--manifest', 'manifest.json', '--agent-id', 'a1', '--path', wt,
      '--branch', BRANCH, '--base', BASE, '--root', dir];
    return { dir, manifestPath, wt, args };
  }

  test('success reads + rewrites the on-disk manifest and reports on stdout only', () => {
    const { dir, manifestPath, wt, args } = fixture();
    const { result, stdout, stderr } = withProcessStdio(() => cmdWorktreeCreate(dir, args, { execGit: () => ok() }));
    assert.equal(result.reason, 'created');
    const onDisk = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(onDisk.worktrees.length, 1);
    assert.equal(onDisk.worktrees[0].worktree_path, wt);
    assert.equal(JSON.parse(stdout).reason, 'created');
    assert.equal(stderr, '');
  });

  test('near-miss: a rejection goes to stderr as the hint line, stdout as JSON', () => {
    const { dir, args } = fixture();
    const noRoot = args.slice(0, -2);
    const { result, stdout, stderr, exitCode } = withProcessStdio(() => cmdWorktreeCreate(dir, noRoot, { execGit: () => ok() }));
    assert.equal(result.reason, 'root_required');
    assert.equal(stderr, errLine('create', 'root_required', result.hint));
    assert.equal(JSON.parse(stdout).reason, 'root_required');
    assert.equal(exitCode, 1);
  });
});
