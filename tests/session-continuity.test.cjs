'use strict';

/**
 * Per-session continuity for concurrent sessions sharing one .planning/
 * (src/session-store.cts + the `state record-session --session`,
 * `state session-resume`, `state sessions` verbs + the statusline's
 * per-session pause marker).
 *
 * The invariant under test: pause is per session. It is represented ONLY by
 * that session's HANDOFF*.json; STATE.md `status:` is never set to `paused`
 * by the tooling, a legacy `status: paused` (frontmatter only, no `Paused At:`
 * line) is repaired on resume, and other sessions' handoffs never render THIS
 * session as paused.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const sessionStore = require('../gsd-core/bin/lib/session-store.cjs');
const { isCanonicalPlanningFile } = require('../gsd-core/bin/lib/artifacts.cjs');
const statusline = require('../hooks/gsd-statusline.js');
const { buildRecordSessionArgv } = require('../hooks/gsd-context-monitor.js');
const { detectSignals } = require('../gsd-core/bin/lib/smart-entry.cjs');

const STATE_LEGACY_PAUSED = [
  '---',
  'gsd_state_version: "1.0"',
  'status: paused',
  'milestone: v1.0',
  '---',
  '',
  '# STATE',
  '',
  '## Current Position',
  '',
  '**Phase:** 2 of 5',
  '**Status:** Executing Phase 2',
  '',
  '## Session',
  '',
  '**Last session:** 2026-09-11T00:00:00Z',
  '**Stopped at:** Paused by coordinator',
  '**Resume file:** None',
  '',
].join('\n');

const STATE_EXPLICIT_PAUSED = STATE_LEGACY_PAUSED.replace(
  '**Resume file:** None',
  '**Resume file:** None\n**Paused At:** 2026-09-11T00:00:00Z',
);

function statePath(dir) {
  return path.join(dir, '.planning', 'STATE.md');
}

function writeHandoff(dir, name, body = {}) {
  fs.writeFileSync(path.join(dir, '.planning', name), JSON.stringify(body) + '\n');
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function fmStatus(dir) {
  const m = /^status:\s*(.+)$/m.exec(fs.readFileSync(statePath(dir), 'utf8'));
  return m ? m[1].trim() : null;
}

// ---------------------------------------------------------------------------
// session-store unit
// ---------------------------------------------------------------------------

describe('session-store: identity', () => {
  test('sanitizeSessionId neutralises traversal and rejects empty tokens', () => {
    assert.equal(sessionStore.sanitizeSessionId('abc-123'), 'abc-123');
    // Separators are folded to '_' (sanitizeWorkstreamSessionToken), so the
    // result is always a plain basename that stays inside sessions/.
    assert.equal(sessionStore.sanitizeSessionId('../../evil'), '.._.._evil');
    assert.equal(sessionStore.sanitizeSessionId('a/b'), 'a_b');
    assert.equal(sessionStore.sanitizeSessionId('..'), null);
    assert.equal(sessionStore.sanitizeSessionId('...'), null);
    assert.equal(sessionStore.sanitizeSessionId(''), null);
    assert.equal(sessionStore.sanitizeSessionId(null), null);
  });

  test('resolveSessionId: explicit wins, runtime env next, terminal identity never', () => {
    assert.equal(sessionStore.resolveSessionId('X', { CLAUDE_CODE_SESSION_ID: 'Y' }), 'X');
    assert.equal(sessionStore.resolveSessionId(null, { CLAUDE_CODE_SESSION_ID: 'Y' }), 'Y');
    assert.equal(sessionStore.resolveSessionId(null, { GSD_SESSION_KEY: 'K', CLAUDE_CODE_SESSION_ID: 'Y' }), 'K');
    assert.equal(sessionStore.resolveSessionId(null, { TMUX_PANE: '%1', WT_SESSION: 'w' }), null);
    assert.equal(sessionStore.resolveSessionId(null, {}), null);
    // An explicit-but-unusable id must not fall through to the env.
    assert.equal(sessionStore.resolveSessionId('..', { CLAUDE_CODE_SESSION_ID: 'Y' }), null);
    assert.equal(sessionStore.resolveSessionId('../x', { CLAUDE_CODE_SESSION_ID: 'Y' }), '.._x');
  });

  test('sanitizeRoleId slugs like pause-work.md', () => {
    assert.equal(sessionStore.sanitizeRoleId('code reviewer'), 'code-reviewer');
    assert.equal(sessionStore.sanitizeRoleId('coordinator'), 'coordinator');
    assert.equal(sessionStore.sanitizeRoleId('ÄÖÜ'), null); // nothing ASCII-alphanumeric survives → no slug
    assert.equal(sessionStore.sanitizeRoleId(null), null);
  });
});

describe('session-store: records + handoffs', () => {
  test('upsertSessionRecord merges and keeps role across a later heartbeat', (t) => {
    const dir = createTempProject('gsd-session-store-');
    t.after(() => cleanup(dir));
    const first = sessionStore.upsertSessionRecord(dir, 'A', { role: 'coordinator', stopped_at: 'x' }, '2026-01-01T00:00:00.000Z');
    assert.equal(first.role_id, 'coordinator');
    const second = sessionStore.upsertSessionRecord(dir, 'A', { stopped_at: 'y' }, '2026-01-02T00:00:00.000Z');
    assert.equal(second.role, 'coordinator');
    assert.equal(second.role_id, 'coordinator');
    assert.equal(second.stopped_at, 'y');
    assert.equal(second.updated_at, '2026-01-02T00:00:00.000Z');
    const onDisk = readJson(path.join(dir, '.planning', 'sessions', 'A.json'));
    assert.deepEqual(onDisk, second);
  });

  test('upsertSessionRecord keeps a traversal id inside sessions/ and refuses an empty one', (t) => {
    const dir = createTempProject('gsd-session-store-');
    t.after(() => cleanup(dir));
    sessionStore.upsertSessionRecord(dir, '../../evil', {});
    assert.ok(!fs.existsSync(path.join(dir, 'evil.json')));
    assert.ok(!fs.existsSync(path.join(dir, '.planning', 'evil.json')));
    assert.deepEqual(fs.readdirSync(path.join(dir, '.planning', 'sessions')), ['.._.._evil.json']);
    assert.throws(() => sessionStore.upsertSessionRecord(dir, '..', {}), /invalid session id/);
  });

  test('corrupt record / corrupt handoff never throw', (t) => {
    const dir = createTempProject('gsd-session-store-');
    t.after(() => cleanup(dir));
    fs.mkdirSync(path.join(dir, '.planning', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.planning', 'sessions', 'A.json'), '{ not json');
    fs.writeFileSync(path.join(dir, '.planning', 'HANDOFF.json'), '{ not json');
    assert.equal(sessionStore.readSessionRecord(dir, 'A'), null);
    assert.deepEqual(sessionStore.listSessionRecords(dir), []);
    const handoffs = sessionStore.listHandoffs(dir);
    assert.equal(handoffs.length, 1);
    assert.equal(handoffs[0].kind, 'legacy');
    assert.equal(handoffs[0].session_id, null);
    assert.doesNotThrow(() => sessionStore.listSessions(dir, { session_id: 'A', role_id: null }));
  });

  test('listHandoffs classifies every filename form', (t) => {
    const dir = createTempProject('gsd-session-store-');
    t.after(() => cleanup(dir));
    writeHandoff(dir, 'HANDOFF.json', { session_id: 'L' });
    writeHandoff(dir, 'HANDOFF.sid-1.json', {});
    writeHandoff(dir, 'HANDOFF.latest.design.json', { role: 'reviewer' });
    writeHandoff(dir, 'HANDOFF.claimed.hardware.sid-2.json', {});
    fs.writeFileSync(path.join(dir, '.planning', 'HANDOFF.txt'), 'not a handoff');
    const byFile = Object.fromEntries(sessionStore.listHandoffs(dir).map((h) => [h.file, h]));
    assert.deepEqual(Object.keys(byFile).sort(), [
      'HANDOFF.claimed.hardware.sid-2.json', 'HANDOFF.json', 'HANDOFF.latest.design.json', 'HANDOFF.sid-1.json',
    ]);
    assert.equal(byFile['HANDOFF.json'].kind, 'legacy');
    assert.equal(byFile['HANDOFF.json'].session_id, 'L');
    assert.equal(byFile['HANDOFF.sid-1.json'].kind, 'session');
    assert.equal(byFile['HANDOFF.sid-1.json'].session_id, 'sid-1');
    assert.equal(byFile['HANDOFF.latest.design.json'].kind, 'role');
    assert.equal(byFile['HANDOFF.latest.design.json'].role_id, 'design');
    assert.equal(byFile['HANDOFF.latest.design.json'].role, 'reviewer');
    assert.equal(byFile['HANDOFF.claimed.hardware.sid-2.json'].kind, 'claimed');
    assert.equal(byFile['HANDOFF.claimed.hardware.sid-2.json'].role_id, 'hardware');
    assert.equal(byFile['HANDOFF.claimed.hardware.sid-2.json'].session_id, 'sid-2');
  });

  test('isOwnHandoff: session id, role, claimed-by-other, legacy body', () => {
    const own = (entry, self) => sessionStore.isOwnHandoff({ path: '', file: '', role: null, timestamp: null, ...entry }, self);
    assert.equal(own({ kind: 'session', session_id: 'A', role_id: null }, { session_id: 'A', role_id: null }), true);
    assert.equal(own({ kind: 'session', session_id: 'B', role_id: null }, { session_id: 'A', role_id: null }), false);
    assert.equal(own({ kind: 'role', session_id: null, role_id: 'design' }, { session_id: 'A', role_id: 'design' }), true);
    assert.equal(own({ kind: 'role', session_id: null, role_id: 'design' }, { session_id: 'A', role_id: null }), false);
    // A claim names the session that took it — another session's claim is theirs even for our role.
    assert.equal(own({ kind: 'claimed', session_id: 'B', role_id: 'design' }, { session_id: 'A', role_id: 'design' }), false);
    assert.equal(own({ kind: 'claimed', session_id: 'A', role_id: 'design' }, { session_id: 'A', role_id: null }), true);
    assert.equal(own({ kind: 'legacy', session_id: null, role_id: null }, { session_id: 'A', role_id: 'design' }), false);
    assert.equal(own({ kind: 'legacy', session_id: 'A', role_id: null }, { session_id: 'A', role_id: null }), true);
  });

  test('listSessions joins handoffs with records and locates continue-here twins', (t) => {
    const dir = createTempProject('gsd-session-store-');
    t.after(() => cleanup(dir));
    sessionStore.upsertSessionRecord(dir, 'A', { role: 'coordinator', stopped_at: 'paused A' }, '2026-01-01T00:00:00.000Z');
    sessionStore.upsertSessionRecord(dir, 'C', { stopped_at: 'working' }, '2026-01-01T00:00:00.000Z');
    writeHandoff(dir, 'HANDOFF.A.json', { session_id: 'A' });
    writeHandoff(dir, 'HANDOFF.latest.design.json', { role: 'design' });
    fs.mkdirSync(path.join(dir, '.planning', 'phases', '02-x'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.planning', 'phases', '02-x', '.continue-here.A.md'), '# A');
    fs.writeFileSync(path.join(dir, '.planning', '.continue-here.latest.design.md'), '# design');

    const views = sessionStore.listSessions(dir, { session_id: 'A', role_id: 'coordinator' });
    const a = views.find((v) => v.session_id === 'A');
    const design = views.find((v) => v.role_id === 'design');
    const c = views.find((v) => v.session_id === 'C');
    assert.ok(a && design && c, JSON.stringify(views));
    assert.equal(a.is_self, true);
    assert.equal(a.paused, true);
    assert.equal(a.role, 'coordinator');
    assert.equal(a.stopped_at, 'paused A');
    assert.ok(a.continue_here_path.endsWith('.continue-here.A.md'));
    assert.equal(design.is_self, false);
    assert.equal(design.paused, true);
    assert.equal(design.session_id, null);
    assert.ok(design.continue_here_path.endsWith('.continue-here.latest.design.md'));
    assert.equal(c.is_self, false);
    assert.equal(c.paused, false);
    assert.equal(c.handoff_path, null);
    assert.equal(views.filter((v) => v.legacy).length, 0);
  });

  test('ownHandoffExists: env-resolved id, own vs others', (t) => {
    const dir = createTempProject('gsd-session-store-');
    t.after(() => cleanup(dir));
    writeHandoff(dir, 'HANDOFF.B.json', {});
    assert.equal(sessionStore.ownHandoffExists(dir, 'A'), false);
    assert.equal(sessionStore.ownHandoffExists(dir, 'B'), true);
    assert.equal(sessionStore.ownHandoffExists(dir, null), false);
    writeHandoff(dir, 'HANDOFF.latest.design.json', {});
    assert.equal(sessionStore.ownHandoffExists(dir, 'A'), false, 'role unknown → the role file is not ours');
    sessionStore.upsertSessionRecord(dir, 'A', { role: 'design' });
    assert.equal(sessionStore.ownHandoffExists(dir, 'A'), true, 'role recorded → the role file is ours');
  });
});

describe('artifacts: HANDOFF*.json is canonical at the .planning/ root', () => {
  test('all four filename forms', () => {
    for (const name of ['HANDOFF.json', 'HANDOFF.abc-123.json', 'HANDOFF.latest.design.json', 'HANDOFF.claimed.design.abc-123.json']) {
      assert.equal(isCanonicalPlanningFile(name), true, name);
    }
    assert.equal(isCanonicalPlanningFile('HANDOFF.md'), false);
    assert.equal(isCanonicalPlanningFile('handoff.json'), false);
  });
});

// ---------------------------------------------------------------------------
// state verbs (CLI)
// ---------------------------------------------------------------------------

describe('state record-session --session', () => {
  test('writes sessions/<sid>.json AND the STATE.md ## Session block', (t) => {
    const dir = createTempProject('gsd-record-session-');
    t.after(() => cleanup(dir));
    fs.writeFileSync(statePath(dir), STATE_LEGACY_PAUSED);
    const r = runGsdTools(['state', 'record-session', '--stopped-at', 'Paused: phase 2 task 3/7', '--session', 'abc', '--role', 'coordinator'], dir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.equal(out.recorded, true);
    assert.equal(out.session_id, 'abc');
    assert.equal(out.session_record, '.planning/sessions/abc.json');
    const rec = readJson(path.join(dir, '.planning', 'sessions', 'abc.json'));
    assert.equal(rec.role, 'coordinator');
    assert.equal(rec.role_id, 'coordinator');
    assert.equal(rec.stopped_at, 'Paused: phase 2 task 3/7');
    assert.match(fs.readFileSync(statePath(dir), 'utf8'), /\*\*Stopped at:\*\* Paused: phase 2 task 3\/7/);
    // Pause must NOT touch the project-wide status (it was paused already here; it must not be *set* anywhere).
    assert.doesNotMatch(fs.readFileSync(statePath(dir), 'utf8'), /Paused At/);
  });

  test('session id from CLAUDE_CODE_SESSION_ID env; TMUX_PANE alone does not attribute', (t) => {
    const dir = createTempProject('gsd-record-session-');
    t.after(() => cleanup(dir));
    fs.writeFileSync(statePath(dir), STATE_LEGACY_PAUSED);
    const viaEnv = runGsdTools(['state', 'record-session', '--stopped-at', 'x'], dir, { CLAUDE_CODE_SESSION_ID: 'env-sid' });
    assert.ok(viaEnv.success, viaEnv.error);
    assert.equal(JSON.parse(viaEnv.output).session_id, 'env-sid');
    assert.ok(fs.existsSync(path.join(dir, '.planning', 'sessions', 'env-sid.json')));

    const viaTmux = runGsdTools(['state', 'record-session', '--stopped-at', 'y'], dir, { TMUX_PANE: '%3' });
    assert.ok(viaTmux.success, viaTmux.error);
    assert.equal(JSON.parse(viaTmux.output).session_id, undefined);
    assert.deepEqual(fs.readdirSync(path.join(dir, '.planning', 'sessions')), ['env-sid.json']);
  });

  test('output shape without a session id is unchanged (no session_id / session_record keys)', (t) => {
    const dir = createTempProject('gsd-record-session-');
    t.after(() => cleanup(dir));
    fs.writeFileSync(statePath(dir), STATE_LEGACY_PAUSED);
    const r = runGsdTools(['state', 'record-session', '--stopped-at', 'plain'], dir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.equal(out.recorded, true);
    assert.ok(!('session_id' in out));
    assert.ok(!('session_record' in out));
    assert.ok(!fs.existsSync(path.join(dir, '.planning', 'sessions')));
  });

  test('--session with traversal stays inside sessions/ (rejected, not escaped)', (t) => {
    const dir = createTempProject('gsd-record-session-');
    t.after(() => cleanup(dir));
    fs.writeFileSync(statePath(dir), STATE_LEGACY_PAUSED);
    const r = runGsdTools(['state', 'record-session', '--stopped-at', 'x', '--session', '../../evil'], dir);
    assert.ok(r.success, r.error);
    assert.equal(JSON.parse(r.output).session_id, '.._.._evil');
    assert.ok(!fs.existsSync(path.join(dir, 'evil.json')));
    assert.ok(!fs.existsSync(path.join(dir, '.planning', 'evil.json')));
    assert.deepEqual(fs.readdirSync(path.join(dir, '.planning', 'sessions')), ['.._.._evil.json']);
  });

  test('second call without --role keeps the recorded role; identical STATE.md value still records the heartbeat', (t) => {
    const dir = createTempProject('gsd-record-session-');
    t.after(() => cleanup(dir));
    fs.writeFileSync(statePath(dir), STATE_LEGACY_PAUSED);
    assert.ok(runGsdTools(['state', 'record-session', '--stopped-at', 'same', '--session', 'A', '--role', 'implementer'], dir).success);
    const again = runGsdTools(['state', 'record-session', '--stopped-at', 'same', '--session', 'A'], dir);
    assert.ok(again.success, again.error);
    const out = JSON.parse(again.output);
    assert.equal(out.recorded, true, 'a per-session record write is a recorded heartbeat, not a no-op');
    assert.equal(out.session_id, 'A');
    const rec = readJson(path.join(dir, '.planning', 'sessions', 'A.json'));
    assert.equal(rec.role, 'implementer');
    assert.equal(rec.role_id, 'implementer');
  });
});

describe('state session-resume', () => {
  test('clears a legacy frontmatter status: paused from the body Status and consumes only the own handoff', (t) => {
    const dir = createTempProject('gsd-session-resume-');
    t.after(() => cleanup(dir));
    fs.writeFileSync(statePath(dir), STATE_LEGACY_PAUSED);
    writeHandoff(dir, 'HANDOFF.A.json', { session_id: 'A' });
    writeHandoff(dir, 'HANDOFF.B.json', { session_id: 'B' });
    assert.equal(fmStatus(dir), 'paused');

    const r = runGsdTools(['state', 'session-resume', '--session', 'A', '--action', 'execute-phase 2'], dir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.equal(out.resumed, true);
    assert.equal(out.session_id, 'A');
    assert.deepEqual(out.status, { before: 'paused', after: 'executing', cleared: true });
    assert.deepEqual(out.handoff_removed, ['.planning/HANDOFF.A.json']);
    assert.equal(out.session_record, '.planning/sessions/A.json');

    assert.equal(fmStatus(dir), 'executing');
    assert.match(fs.readFileSync(statePath(dir), 'utf8'), /\*\*Stopped at:\*\* Session resumed, proceeding to execute-phase 2/);
    assert.ok(!fs.existsSync(path.join(dir, '.planning', 'HANDOFF.A.json')));
    assert.ok(fs.existsSync(path.join(dir, '.planning', 'HANDOFF.B.json')), "another session's handoff is untouched");
    assert.equal(readJson(path.join(dir, '.planning', 'sessions', 'A.json')).stopped_at, 'Session resumed, proceeding to execute-phase 2');
  });

  test('an explicit Paused At line is respected (status stays paused, cleared:false)', (t) => {
    const dir = createTempProject('gsd-session-resume-');
    t.after(() => cleanup(dir));
    fs.writeFileSync(statePath(dir), STATE_EXPLICIT_PAUSED);
    const r = runGsdTools(['state', 'session-resume', '--session', 'A'], dir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.equal(out.status.cleared, false);
    assert.equal(out.status.after, 'paused');
    assert.match(out.status.reason, /Paused At/);
    assert.equal(fmStatus(dir), 'paused');
    assert.match(fs.readFileSync(statePath(dir), 'utf8'), /Stopped at:\*\* Session resumed, proceeding to next action/);
  });

  test('no body Status → frontmatter left as is', (t) => {
    const dir = createTempProject('gsd-session-resume-');
    t.after(() => cleanup(dir));
    fs.writeFileSync(statePath(dir), STATE_LEGACY_PAUSED.replace('**Status:** Executing Phase 2\n', ''));
    const r = runGsdTools(['state', 'session-resume', '--session', 'A'], dir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.equal(out.status.cleared, false);
    assert.equal(fmStatus(dir), 'paused');
  });

  test('status: completed is never touched', (t) => {
    const dir = createTempProject('gsd-session-resume-');
    t.after(() => cleanup(dir));
    fs.writeFileSync(statePath(dir), STATE_LEGACY_PAUSED.replace('status: paused', 'status: completed'));
    const r = runGsdTools(['state', 'session-resume', '--session', 'A'], dir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.equal(out.status.before, 'completed');
    assert.equal(out.status.cleared, false);
    assert.equal(fmStatus(dir), 'completed');
  });

  test('CRLF STATE.md: status cleared and Stopped at rewritten', (t) => {
    const dir = createTempProject('gsd-session-resume-');
    t.after(() => cleanup(dir));
    fs.writeFileSync(statePath(dir), STATE_LEGACY_PAUSED.replace(/\n/g, '\r\n'));
    writeHandoff(dir, 'HANDOFF.A.json', {});
    const r = runGsdTools(['state', 'session-resume', '--session', 'A', '--action', 'plan-phase 3'], dir);
    assert.ok(r.success, r.error);
    assert.equal(JSON.parse(r.output).status.cleared, true);
    assert.equal(fmStatus(dir), 'executing');
    assert.match(fs.readFileSync(statePath(dir), 'utf8'), /Session resumed, proceeding to plan-phase 3/);
    assert.ok(!fs.existsSync(path.join(dir, '.planning', 'HANDOFF.A.json')));
  });

  test('--keep-handoff leaves the file; --handoff adopts another session\'s file; traversal is rejected', (t) => {
    const dir = createTempProject('gsd-session-resume-');
    t.after(() => cleanup(dir));
    fs.writeFileSync(statePath(dir), STATE_LEGACY_PAUSED);
    writeHandoff(dir, 'HANDOFF.A.json', {});
    writeHandoff(dir, 'HANDOFF.B.json', {});

    const keep = runGsdTools(['state', 'session-resume', '--session', 'A', '--keep-handoff'], dir);
    assert.ok(keep.success, keep.error);
    assert.deepEqual(JSON.parse(keep.output).handoff_removed, []);
    assert.ok(fs.existsSync(path.join(dir, '.planning', 'HANDOFF.A.json')));

    const adopt = runGsdTools(['state', 'session-resume', '--session', 'A', '--handoff', '.planning/HANDOFF.B.json'], dir);
    assert.ok(adopt.success, adopt.error);
    assert.deepEqual(JSON.parse(adopt.output).handoff_removed, ['.planning/HANDOFF.B.json']);
    assert.ok(fs.existsSync(path.join(dir, '.planning', 'HANDOFF.A.json')), '--handoff consumes only the named file');
    assert.ok(!fs.existsSync(path.join(dir, '.planning', 'HANDOFF.B.json')));

    fs.writeFileSync(path.join(dir, 'HANDOFF.x.json'), '{}');
    const bad = runGsdTools(['state', 'session-resume', '--session', 'A', '--handoff', '../x.json'], dir);
    assert.ok(!bad.success);
    assert.match(bad.error, /--handoff must name a HANDOFF\*\.json file at the \.planning\/ root/);
    const outside = runGsdTools(['state', 'session-resume', '--session', 'A', '--handoff', 'HANDOFF.x.json'], dir);
    assert.ok(!outside.success, 'a HANDOFF-named file outside .planning/ is rejected');
    assert.ok(fs.existsSync(path.join(dir, 'HANDOFF.x.json')));
  });

  test('role-keyed: --role-id consumes HANDOFF.latest.<role>.json and the claimed form for this session only', (t) => {
    const dir = createTempProject('gsd-session-resume-');
    t.after(() => cleanup(dir));
    fs.writeFileSync(statePath(dir), STATE_LEGACY_PAUSED);
    writeHandoff(dir, 'HANDOFF.claimed.design.A.json', {});
    writeHandoff(dir, 'HANDOFF.claimed.design.B.json', {});
    writeHandoff(dir, 'HANDOFF.latest.hardware.json', {});
    const r = runGsdTools(['state', 'session-resume', '--session', 'A', '--role', 'reviewer', '--role-id', 'design'], dir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.equal(out.role_id, 'design');
    assert.deepEqual(out.handoff_removed, ['.planning/HANDOFF.claimed.design.A.json']);
    assert.ok(fs.existsSync(path.join(dir, '.planning', 'HANDOFF.claimed.design.B.json')));
    assert.ok(fs.existsSync(path.join(dir, '.planning', 'HANDOFF.latest.hardware.json')));
    assert.equal(readJson(path.join(dir, '.planning', 'sessions', 'A.json')).role, 'reviewer');
  });

  test('STATE.md missing → error payload, no throw', (t) => {
    const dir = createTempProject('gsd-session-resume-');
    t.after(() => cleanup(dir));
    assert.ok(!fs.existsSync(statePath(dir)), 'fixture must start without STATE.md');
    const r = runGsdTools(['state', 'session-resume', '--session', 'A'], dir);
    assert.match(r.output || r.error || '', /STATE\.md not found/);
  });
});

describe('state sessions', () => {
  test('lists keyed + legacy handoffs and records with is_self / paused', (t) => {
    const dir = createTempProject('gsd-sessions-');
    t.after(() => cleanup(dir));
    fs.writeFileSync(statePath(dir), STATE_LEGACY_PAUSED);
    writeHandoff(dir, 'HANDOFF.json', { session_id: 'L', role: 'observer' });
    writeHandoff(dir, 'HANDOFF.A.json', { session_id: 'A' });
    writeHandoff(dir, 'HANDOFF.latest.design.json', { role: 'design' });
    fs.mkdirSync(path.join(dir, '.planning', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.planning', 'sessions', 'broken.json'), '{');
    assert.ok(runGsdTools(['state', 'record-session', '--stopped-at', 'w', '--session', 'C'], dir).success);

    const r = runGsdTools(['state', 'sessions', '--session', 'A', '--raw'], dir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.deepEqual(out.self, { session_id: 'A', role_id: null });
    assert.equal(out.paused, true);
    const byKey = Object.fromEntries(out.sessions.map((v) => [v.handoff_path || v.record_path, v]));
    assert.equal(byKey['.planning/HANDOFF.A.json'].is_self, true);
    assert.equal(byKey['.planning/HANDOFF.json'].legacy, true);
    assert.equal(byKey['.planning/HANDOFF.json'].is_self, false);
    assert.equal(byKey['.planning/HANDOFF.json'].role, 'observer');
    assert.equal(byKey['.planning/HANDOFF.latest.design.json'].role_id, 'design');
    assert.equal(byKey['.planning/sessions/C.json'].paused, false);
    assert.ok(!Object.keys(byKey).some((k) => k.includes('broken')));

    const other = JSON.parse(runGsdTools(['state', 'sessions', '--session', 'Z'], dir).output);
    assert.equal(other.paused, false);
  });
});

// ---------------------------------------------------------------------------
// statusline
// ---------------------------------------------------------------------------

describe('statusline: per-session pause marker', () => {
  function makeProject(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-statusline-handoff-'));
    t.after(() => cleanup(dir));
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.planning', 'STATE.md'), '---\nstatus: executing\nmilestone: v1.0\n---\n');
    return dir;
  }

  test('readHandoffs: own / others / legacy body / role via record / traversal / missing dir', (t) => {
    const dir = makeProject(t);
    const planning = path.join(dir, '.planning');
    assert.deepEqual(statusline.readHandoffs(planning, 'A'), { self: false, others: 0 });
    writeHandoff(dir, 'HANDOFF.A.json', {});
    writeHandoff(dir, 'HANDOFF.B.json', {});
    assert.deepEqual(statusline.readHandoffs(planning, 'A'), { self: true, others: 1 });
    assert.deepEqual(statusline.readHandoffs(planning, 'C'), { self: false, others: 2 });
    assert.deepEqual(statusline.readHandoffs(planning, '../x'), { self: false, others: 2 });
    assert.deepEqual(statusline.readHandoffs(planning, ''), { self: false, others: 2 });
    writeHandoff(dir, 'HANDOFF.json', { session_id: 'C' });
    assert.deepEqual(statusline.readHandoffs(planning, 'C'), { self: true, others: 2 });
    writeHandoff(dir, 'HANDOFF.latest.design.json', {});
    assert.deepEqual(statusline.readHandoffs(planning, 'D'), { self: false, others: 4 });
    fs.mkdirSync(path.join(planning, 'sessions'));
    fs.writeFileSync(path.join(planning, 'sessions', 'D.json'), JSON.stringify({ role_id: 'design' }));
    assert.deepEqual(statusline.readHandoffs(planning, 'D'), { self: true, others: 3 });
    assert.deepEqual(statusline.readHandoffs(path.join(dir, 'nope'), 'A'), { self: false, others: 0 });
  });

  test('formatGsdState / compact render paused + ⏸N', () => {
    const base = { milestone: 'v1.0', status: 'executing' };
    assert.equal(statusline.formatGsdState({ ...base }), 'v1.0 · executing');
    assert.equal(statusline.formatGsdState({ ...base, handoffs: { self: false, others: 2 } }), 'v1.0 · executing · ⏸2');
    assert.equal(statusline.formatGsdState({ ...base, handoffs: { self: true, others: 1 } }), 'v1.0 · paused · ⏸1');
    assert.equal(statusline.formatGsdState({ ...base, handoffs: { self: true, others: 0 } }), 'v1.0 · paused');
    assert.equal(statusline.formatGsdState({ ...base, activePhase: '4.5', handoffs: { self: true, others: 0 } }), 'v1.0 · Phase 4.5 executing · paused');
    assert.equal(statusline.formatGsdStateCompact({ ...base, phaseNum: '4.5', handoffs: { self: true, others: 1 } }), 'v1.0 · P4.5 · PAUSED · ⏸1');
    assert.equal(statusline.formatGsdStateCompact({ ...base, handoffs: { self: false, others: 3 } }), 'v1.0 · executing · ⏸3');
  });

  test('readGsdState attaches handoffs only when sessionId is given', (t) => {
    const dir = makeProject(t);
    writeHandoff(dir, 'HANDOFF.A.json', {});
    assert.deepEqual(statusline.readGsdState(dir), { status: 'executing', milestone: 'v1.0' });
    assert.deepEqual(statusline.readGsdState(dir, { sessionId: 'A' }).handoffs, { self: true, others: 0 });
    assert.deepEqual(statusline.readGsdState(dir, { sessionId: 'B' }).handoffs, { self: false, others: 1 });
  });

  test('renderStatusline end to end', (t) => {
    const dir = makeProject(t);
    writeHandoff(dir, 'HANDOFF.A.json', {});
    writeHandoff(dir, 'HANDOFF.B.json', {});
    const render = (sid) => statusline.renderStatusline({ model: { display_name: 'Claude' }, workspace: { current_dir: dir }, session_id: sid })
      // eslint-disable-next-line no-control-regex -- strip ANSI SGR sequences from the rendered line
      .replace(/\x1b\[[0-9;]*m/g, '');
    assert.match(render('A'), /v1\.0 · paused · ⏸1/);
    assert.match(render('C'), /v1\.0 · executing · ⏸2/);
    assert.doesNotThrow(() => render('../x'));
  });
});

// ---------------------------------------------------------------------------
// context-monitor + smart-entry
// ---------------------------------------------------------------------------

describe('context-monitor breadcrumb carries --session', () => {
  test('buildRecordSessionArgv', () => {
    assert.deepEqual(buildRecordSessionArgv('T', 'ctx 90%', 'sid-1'), ['T', 'state', 'record-session', '--stopped-at', 'ctx 90%', '--session', 'sid-1']);
    assert.deepEqual(buildRecordSessionArgv('T', 'ctx 90%', undefined), ['T', 'state', 'record-session', '--stopped-at', 'ctx 90%']);
    assert.deepEqual(buildRecordSessionArgv('T', 'ctx 90%', '../x'), ['T', 'state', 'record-session', '--stopped-at', 'ctx 90%']);
  });

  test('record-session --session lands the exhaustion breadcrumb in the session record', (t) => {
    const dir = createTempProject('gsd-ctx-breadcrumb-');
    t.after(() => cleanup(dir));
    fs.writeFileSync(statePath(dir), STATE_LEGACY_PAUSED);
    const argv = buildRecordSessionArgv('ignored', 'context exhaustion at 80% (2026-01-01)', 'A').slice(1);
    const r = runGsdTools(argv, dir);
    assert.ok(r.success, r.error);
    assert.match(readJson(path.join(dir, '.planning', 'sessions', 'A.json')).stopped_at, /^context exhaustion at/);
  });
});

describe('smart-entry: paused is per session', () => {
  test('own handoff → paused; only another session\'s handoff → not paused', (t) => {
    const dir = createTempProject('gsd-smart-entry-');
    t.after(() => cleanup(dir));
    fs.writeFileSync(statePath(dir), STATE_LEGACY_PAUSED.replace('status: paused', 'status: executing'));
    fs.writeFileSync(path.join(dir, '.planning', 'ROADMAP.md'), '# Roadmap\n');
    writeHandoff(dir, 'HANDOFF.B.json', {});
    const saved = process.env.CLAUDE_CODE_SESSION_ID;
    try {
      process.env.CLAUDE_CODE_SESSION_ID = 'A';
      assert.equal(detectSignals(dir).paused, false);
      writeHandoff(dir, 'HANDOFF.A.json', {});
      assert.equal(detectSignals(dir).paused, true);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = saved;
    }
  });
});
