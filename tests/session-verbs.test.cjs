'use strict';

/**
 * `state record-session --session`, `state session-resume`, `state sessions`
 * (#6796, phase 1 of #4845; ADR-4962). The real CLI runs in-process against a
 * temp `.planning/`; runtime session keys are blanked so the developer's own
 * environment never leaks in.
 */

const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const store = require('../gsd-core/bin/lib/session-store.cjs');

const NO_KEYS = Object.fromEntries(store.SESSION_ENV_KEYS.map((k) => [k, '']));

/** True when the symlink was created; false when this platform run may not create one (Windows without the privilege). */
function trySymlink(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath);
    return true;
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EACCES')) return false;
    throw err;
  }
}
const STATE = [
  '---', 'gsd_state_version: 1.0', 'status: executing', '---', '',
  '# Project State', '', '## Current Position', '', 'Phase: 1 of 1', 'Status: Executing', '',
  '## Session', '', '**Last session:** 2026-01-01T00:00:00.000Z', '**Stopped at:** None', '**Resume file:** None', '',
].join('\n');

function json(result) {
  assert.ok(result.success, result.error);
  return JSON.parse(result.output);
}

describe('session verbs', () => {
  let tmp;
  let planning;
  const run = (args, env = {}) => runGsdTools(args, tmp, { ...NO_KEYS, ...env });
  const state = () => fs.readFileSync(path.join(planning, 'STATE.md'), 'utf-8');
  const exists = (rel) => fs.existsSync(path.join(planning, rel));
  const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(planning, rel), 'utf-8'));
  const put = (name, content) => fs.writeFileSync(path.join(planning, name), typeof content === 'string' ? content : JSON.stringify(content));

  beforeEach(() => {
    tmp = createTempProject();
    planning = path.join(tmp, '.planning');
    fs.writeFileSync(path.join(planning, 'STATE.md'), STATE);
  });
  afterEach(() => { mock.restoreAll(); cleanup(tmp); });

  describe('record-session', () => {
    const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

    test('recordSessionWithoutSessionIsByteIdentical: no --session means no sessions dir, no session_record key, STATE.md independent of the session flags', () => {
      const plain = json(run(['state', 'record-session', '--stopped-at', 'paused here']));
      const plainState = state().replace(ISO, '<ts>');
      assert.equal('session_record' in plain, false);
      assert.equal(exists('sessions'), false);

      fs.writeFileSync(path.join(planning, 'STATE.md'), STATE);
      const withSession = json(run(['state', 'record-session', '--stopped-at', 'paused here', '--session', 's1', '--role', 'Coordinator']));
      assert.equal(state().replace(ISO, '<ts>'), plainState);
      assert.equal(withSession.session_record.written, true);
    });

    test('recordSessionWritesPerSessionRecord', () => {
      const out = json(run(['state', 'record-session', '--stopped-at', 'stop A', '--resume-file', 'plan.md', '--session', 's1']));
      assert.equal(out.session_record.path, '.planning/sessions/s1.json');
      assert.deepEqual(
        { ...readJson('sessions/s1.json'), last_session: 'x' },
        { session_id: 's1', role: null, role_id: null, stopped_at: 'stop A', last_session: 'x', resume_file: 'plan.md' },
      );
      assert.match(state(), /\*\*Stopped at:\*\* stop A/);
    });

    test('recordSessionDerivesRoleIdFromRole: the CLI derives role_id, the role text is stored verbatim', () => {
      run(['state', 'record-session', '--stopped-at', 'x', '--session', 's1', '--role', 'Reviewer A']);
      assert.deepEqual([readJson('sessions/s1.json').role, readJson('sessions/s1.json').role_id], ['Reviewer A', 'reviewer-a']);
    });

    test('recordSessionReslugsRoleId', () => {
      run(['state', 'record-session', '--stopped-at', 'x', '--session', 's1', '--role-id', 'Bad Slug!!']);
      assert.equal(readJson('sessions/s1.json').role_id, 'bad-slug');
    });

    test('recordSessionUnusableRoleIdIsNull', () => {
      const out = json(run(['state', 'record-session', '--stopped-at', 'x', '--session', 's1', '--role-id', '!!!']));
      assert.equal(out.session_record.written, true);
      assert.equal(readJson('sessions/s1.json').role_id, null);
    });

    test('recordSessionMergesPriorRecord: a later call without --role keeps the earlier role and resume file', () => {
      run(['state', 'record-session', '--stopped-at', 'one', '--resume-file', 'a.md', '--session', 's1', '--role', 'Coordinator']);
      run(['state', 'record-session', '--stopped-at', 'two', '--session', 's1']);
      const rec = readJson('sessions/s1.json');
      assert.deepEqual([rec.role, rec.role_id, rec.resume_file, rec.stopped_at], ['Coordinator', 'coordinator', 'a.md', 'two']);
    });

    test('roleTextIsDataNeverExecuted: shell metacharacters in a role are inert; a newline is refused', () => {
      const role = '$(touch pwned) `touch pwned2` "q" ../x';
      const out = json(run(['state', 'record-session', '--stopped-at', 'x', '--session', 's1', '--role', role]));
      assert.equal(out.session_record.written, true);
      assert.equal(readJson('sessions/s1.json').role, role);
      assert.equal(fs.existsSync(path.join(tmp, 'pwned')) || fs.existsSync(path.join(tmp, 'pwned2')), false);
      assert.match(readJson('sessions/s1.json').role_id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      const bad = run(['state', 'record-session', '--stopped-at', 'x', '--session', 's2', '--role', 'a\nb']);
      assert.equal(bad.success, false);
      assert.equal(exists('sessions/s2.json'), false);
    });

    test('recordSessionIgnoresRuntimeKeysWithoutSession: only an explicit --session writes a record, so a caller that passes none (the shipped context monitor) is unchanged', () => {
      const out = json(run(['state', 'record-session', '--stopped-at', 'x'], { CLAUDE_CODE_SESSION_ID: 'env-sess' }));
      assert.equal('session_record' in out, false);
      assert.equal(exists('sessions'), false);
    });

    test('recordSessionMissingStateWritesNothing', () => {
      fs.unlinkSync(path.join(planning, 'STATE.md'));
      const result = run(['state', 'record-session', '--stopped-at', 'x', '--session', 's1']);
      assert.match(result.output + result.error, /STATE\.md not found/);
      assert.equal(exists('sessions'), false);
    });

    test('recordSessionRefusesSymlinkedSessionsDir: nothing is written through the link and STATE.md is still updated', (t) => {
      const elsewhere = path.join(tmp, 'elsewhere');
      fs.mkdirSync(elsewhere);
      if (!trySymlink(elsewhere, path.join(planning, 'sessions'))) { t.skip('symlink privilege unavailable'); return; }
      const out = json(run(['state', 'record-session', '--stopped-at', 'x', '--session', 's1']));
      assert.equal(out.session_record.written, false);
      assert.equal(typeof out.session_record.reason, 'string');
      assert.deepEqual(fs.readdirSync(elsewhere), []);
      assert.match(state(), /\*\*Stopped at:\*\* x/);
    });

    test('recordSessionNeverWritesThroughSymlink: a symlinked record file leaves its target untouched', (t) => {
      fs.mkdirSync(path.join(planning, 'sessions'));
      const victim = path.join(tmp, 'victim.txt');
      fs.writeFileSync(victim, 'keep');
      if (!trySymlink(victim, path.join(planning, 'sessions', 's1.json'))) { t.skip('symlink privilege unavailable'); return; }
      json(run(['state', 'record-session', '--stopped-at', 'x', '--session', 's1']));
      assert.equal(fs.readFileSync(victim, 'utf-8'), 'keep');
    });

    test('recordSessionSurvivesWriteFailure: a failing record write is reported, STATE.md stands, exit stays 0', () => {
      const real = fs.renameSync;
      mock.method(fs, 'renameSync', (from, to, ...rest) => {
        if (String(to).includes(`${path.sep}sessions${path.sep}`)) throw Object.assign(new Error('EIO: simulated'), { code: 'EIO' });
        return real.call(fs, from, to, ...rest);
      });
      let out;
      try { out = json(run(['state', 'record-session', '--stopped-at', 'x', '--session', 's1'])); } finally { mock.restoreAll(); }
      assert.equal(out.session_record.written, false);
      assert.match(state(), /\*\*Stopped at:\*\* x/);
    });
  });

  describe('sessions', () => {
    test('sessionsEmptyPlanning', () => {
      const out = json(run(['state', 'sessions', '--session', 's1']));
      assert.deepEqual([out.handoffs, out.records, out.paused, out.session_id], [[], [], false, 's1']);
    });

    test('sessionsMarksOwnAndPaused', () => {
      run(['state', 'record-session', '--stopped-at', 'x', '--session', 's1', '--role', 'Coordinator']);
      put('HANDOFF.latest.coordinator.json', {});
      put('HANDOFF.latest.implementer.json', {});
      put('HANDOFF.s2.json', {});
      put('HANDOFF.json', { role_id: 'reviewer' });
      const out = json(run(['state', 'sessions', '--session', 's1']));
      const own = Object.fromEntries(out.handoffs.map((h) => [h.file, h.is_self]));
      assert.deepEqual(own, {
        'HANDOFF.json': false,
        'HANDOFF.latest.coordinator.json': true,
        'HANDOFF.latest.implementer.json': false,
        'HANDOFF.s2.json': false,
      });
      assert.equal(out.paused, true);
      assert.equal(out.role_id, 'coordinator');
      assert.deepEqual(out.records.map((r) => [r.session_id, r.is_self]), [['s1', true]]);
    });

    test('sessions lists the continue-here companion path for a role handoff', () => {
      put('HANDOFF.latest.coordinator.json', {});
      put('.continue-here.latest.coordinator.md', '# resume');
      const out = json(run(['state', 'sessions', '--session', 's1', '--role-id', 'coordinator']));
      assert.equal(out.handoffs[0].continue_here_path, '.planning/.continue-here.latest.coordinator.md');
    });

    test('sessionsWithoutIdentityOwnsNothing', () => {
      put('HANDOFF.json', {});
      put('HANDOFF.s1.json', {});
      const out = json(run(['state', 'sessions']));
      assert.equal(out.session_id, null);
      assert.equal(out.paused, false);
      assert.deepEqual(out.handoffs.map((h) => h.is_self), [false, false]);
    });

    test('sessionsNeverWrites: the directory listing and every byte are unchanged', () => {
      put('HANDOFF.s1.json', { a: 1 });
      const snap = () => fs.readdirSync(planning).sort().map((f) => [f, fs.statSync(path.join(planning, f)).isFile() ? fs.readFileSync(path.join(planning, f), 'utf-8') : null]);
      const before = snap();
      json(run(['state', 'sessions', '--session', 's1']));
      assert.deepEqual(snap(), before);
    });

    test('sessions reports skipped entries instead of failing', () => {
      put('HANDOFF.s1.json', '{bad');
      const out = json(run(['state', 'sessions', '--session', 's1']));
      assert.deepEqual(out.skipped.map((s) => s.file), ['HANDOFF.s1.json']);
    });
  });

  describe('session-resume', () => {
    const resume = (extra = [], env = {}) => json(run(['state', 'session-resume', ...extra], env));

    test('sessionResumeRemovesOwnRoleHandoff: the role handoff and its continue-here go, nothing else', () => {
      put('HANDOFF.latest.coordinator.json', {});
      put('.continue-here.latest.coordinator.md', 'x');
      put('HANDOFF.latest.implementer.json', {});
      put('.continue-here.latest.implementer.md', 'x');
      const out = resume(['--session', 's1', '--role-id', 'coordinator']);
      assert.deepEqual(out.handoff.removed.sort(), ['.continue-here.latest.coordinator.md', 'HANDOFF.latest.coordinator.json']);
      assert.equal(exists('HANDOFF.latest.coordinator.json'), false);
      assert.equal(exists('HANDOFF.latest.implementer.json'), true);
      assert.equal(exists('.continue-here.latest.implementer.md'), true);
    });

    test('sessionResumeRemovesOwnSessionHandoff', () => {
      put('HANDOFF.s1.json', {});
      put('HANDOFF.s2.json', {});
      resume(['--session', 's1']);
      assert.equal(exists('HANDOFF.s1.json'), false);
      assert.equal(exists('HANDOFF.s2.json'), true);
    });

    test('sessionResumeRemovesRolelessLegacy', () => {
      put('HANDOFF.json', {});
      put('.continue-here.md', 'x');
      resume(['--session', 's1']);
      assert.deepEqual([exists('HANDOFF.json'), exists('.continue-here.md')], [false, false]);
    });

    test('sessionResumeKeepsOtherRoleLegacy', () => {
      put('HANDOFF.json', { role_id: 'reviewer' });
      resume(['--session', 's1', '--role-id', 'implementer']);
      assert.equal(exists('HANDOFF.json'), true);
    });

    test('sessionResumeIgnoresBodyRoleOnKeyedFiles: another session file whose body names the caller role is kept', () => {
      put('HANDOFF.s2.json', { role_id: 'coordinator', role: 'coordinator' });
      resume(['--session', 's1', '--role-id', 'coordinator']);
      assert.equal(exists('HANDOFF.s2.json'), true);
    });

    test('sessionResumeUsesRecordedRole: with no role flag the caller role comes from its own session record', () => {
      run(['state', 'record-session', '--stopped-at', 'x', '--session', 's1', '--role', 'Coordinator']);
      put('HANDOFF.latest.coordinator.json', {});
      resume(['--session', 's1']);
      assert.equal(exists('HANDOFF.latest.coordinator.json'), false);
    });

    test('sessionResumeHandoffFlag: adopts one valid named file, refuses separators and unknown names', () => {
      put('HANDOFF.s2.json', {});
      put('HANDOFF.s3.json', {});
      const out = resume(['--session', 's1', '--handoff', 'HANDOFF.s2.json']);
      assert.deepEqual(out.handoff.removed, ['HANDOFF.s2.json']);
      assert.equal(exists('HANDOFF.s3.json'), true);
      for (const name of ['../STATE.md', 'sub/HANDOFF.s3.json', 'HANDOFF.latest.json', 'STATE.md', 'HANDOFF.s3.json\\x']) {
        const refused = resume(['--session', 's1', '--handoff', name]);
        assert.deepEqual(refused.handoff.removed, [], name);
        assert.equal(typeof refused.handoff.refused, 'string', name);
      }
      assert.equal(exists('STATE.md'), true);
      assert.equal(exists('HANDOFF.s3.json'), true);
    });

    test('sessionResumeKeepHandoff: nothing deleted, record still written', () => {
      put('HANDOFF.s1.json', {});
      const out = resume(['--session', 's1', '--keep-handoff', '--action', 'plan 2']);
      assert.equal(exists('HANDOFF.s1.json'), true);
      assert.deepEqual(out.handoff.removed, []);
      assert.equal(exists('sessions/s1.json'), true);
    });

    test('sessionResumeWithoutIdentityDeletesNothing', () => {
      put('HANDOFF.json', {});
      put('HANDOFF.s1.json', {});
      const out = resume([]);
      assert.equal(out.session_id, null);
      assert.deepEqual(out.handoff.removed, []);
      assert.deepEqual([exists('HANDOFF.json'), exists('HANDOFF.s1.json'), exists('sessions')], [true, true, false]);
    });

    test('sessionResumeReportsUnlinkFailure: an EBUSY unlink is reported, never thrown (fs monkeypatch restored)', () => {
      put('HANDOFF.s1.json', {});
      const real = fs.unlinkSync;
      mock.method(fs, 'unlinkSync', (p, ...rest) => {
        if (String(p).endsWith('HANDOFF.s1.json')) throw Object.assign(new Error('EBUSY: simulated'), { code: 'EBUSY' });
        return real.call(fs, p, ...rest);
      });
      let out;
      try { out = resume(['--session', 's1']); } finally { mock.restoreAll(); }
      assert.deepEqual(out.handoff.removed, []);
      assert.deepEqual(out.handoff.failed.map((f) => f.file), ['HANDOFF.s1.json']);
      assert.equal(exists('HANDOFF.s1.json'), true);
    });

    test('sessionResumeRecordsAction: the action lands in the record and in STATE.md', () => {
      resume(['--session', 's1', '--action', 'plan 2']);
      assert.equal(readJson('sessions/s1.json').stopped_at, 'Session resumed, proceeding to plan 2');
      assert.match(state(), /Session resumed, proceeding to plan 2/);
    });

    describe('legacy paused status repair', () => {
      const legacy = (bodyStatusLine, extraBody = '') => [
        '---', 'gsd_state_version: 1.0', 'status: paused', '---', '',
        '# Project State', '', '## Current Position', '', 'Phase: 1 of 1', bodyStatusLine, extraBody, '',
        '## Session', '', '**Last session:** 2026-01-01T00:00:00.000Z', '**Stopped at:** None', '**Resume file:** None', '',
      ].join('\n');

      test('sessionResumeRepairsLegacyPausedStatus', () => {
        fs.writeFileSync(path.join(planning, 'STATE.md'), legacy('Status: Executing'));
        const out = resume(['--session', 's1']);
        assert.deepEqual(out.status, { before: 'paused', after: 'executing', cleared: true });
        assert.match(state(), /^status: executing$/m);
      });

      test('sessionResumeKeepsPausedWhenPausedAtPresent', () => {
        fs.writeFileSync(path.join(planning, 'STATE.md'), legacy('Status: Executing', 'Paused At: 2026-01-02'));
        const out = resume(['--session', 's1']);
        assert.equal(out.status.cleared, false);
        assert.equal(typeof out.status.reason, 'string');
        assert.match(state(), /^status: paused$/m);
        assert.match(state(), /Paused At: 2026-01-02/);
      });

      test('sessionResumeLeavesNonPausedStatus', () => {
        const out = resume(['--session', 's1']);
        assert.equal(out.status.cleared, false);
        assert.equal(out.status.before, out.status.after);
        assert.match(state(), /^status: executing$/m);
      });
    });
  });

  describe('surface', () => {
    test('sessionVerbsRejectUnknownFlags: an unknown flag is a usage error and writes nothing', () => {
      for (const verb of ['sessions', 'session-resume']) {
        const result = run(['state', verb, '--session', 's1', '--bogus', 'x']);
        assert.equal(result.success, false, verb);
      }
      assert.equal(exists('sessions'), false);
    });

    test('sessionVerbsAreRegistered: both verbs are in the alias table with the right mutation flag', () => {
      const aliases = require('../gsd-core/bin/lib/command-aliases.cjs');
      const byName = Object.fromEntries(aliases.STATE_COMMAND_ALIASES.map((a) => [a.subcommand, a]));
      assert.equal(byName['session-resume'].mutation, true);
      assert.equal(byName['sessions'].mutation, false);
      assert.ok(aliases.STATE_SUBCOMMANDS.includes('sessions'));
    });
  });
});
