/**
 * #6798 (ADR-4962 Decisions 1-3, 9): the pause/resume workflows move onto per-session files.
 *
 * The shell fences in the workflow Markdown are the product here, so they are extracted by their
 * `# gsd:<name>` marker and RUN under bash against a real temp project with the real CLI. The role
 * is free text from the user's arguments; every hostile case below must stay data.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const fc = require('fast-check');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { runHook, runGit } = require('./helpers/process-seam.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const store = require('../gsd-core/bin/lib/session-store.cjs');

const TOOLS = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');
const WORKFLOWS = path.join(__dirname, '..', 'gsd-core', 'workflows');
const NO_KEYS = Object.fromEntries(store.SESSION_ENV_KEYS.map((k) => [k, '']));
const HAS_BASH = (() => {
  try {
    return runHook('-c', ['true'], { interpreter: 'bash' }).exitCode === 0;
  } catch {
    return false;
  }
})();

/** The body of the bash fence whose first line is `# fence=<marker>`. */
function fence(workflow, marker) {
  const lines = splitLines(fs.readFileSync(path.join(WORKFLOWS, workflow), 'utf-8'));
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== '```bash' || lines[i + 1] !== `# fence=${marker}`) continue;
    const body = [];
    for (let j = i + 1; j < lines.length && lines[j] !== '```'; j++) body.push(lines[j]);
    return body.join('\n');
  }
  throw new Error(`no fence marked fence=${marker} in ${workflow}`);
}

/** What the runtime does with `$ARGUMENTS`: textual substitution before the shell sees the fence. */
function withArgs(body, args) {
  return body.split('$ARGUMENTS').join(args);
}

// The CLI path reaches the shell as an environment value, never spliced into the script text.
const PRELUDE = 'gsd_run() { node "$GSD_TEST_TOOLS" "$@"; }\n';

function script(parts, args) {
  return PRELUDE + parts.map((p) => withArgs(p, args)).join('\n') + '\n';
}

function bashEnv(sessionId) {
  const git = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  return { ...process.env, ...git, GSD_TEST_TOOLS: TOOLS, ...NO_KEYS, ...(sessionId ? { GSD_SESSION_KEY: sessionId } : {}) };
}

function runBash(cwd, text, sessionId) {
  const r = runHook('-c', [text], { interpreter: 'bash', cwd, env: bashEnv(sessionId) });
  return { status: r.exitCode, out: r.stdout, err: r.stderr };
}

function runBashAsync(cwd, text, sessionId) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', text], { cwd, env: bashEnv(sessionId), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (status) => resolve({ status, out }));
  });
}

const STATE = [
  '---', 'gsd_state_version: 1.0', 'status: executing', '---', '',
  '# Project State', '', '## Current Position', '', 'Phase: 1 of 1', 'Status: Executing', '',
  '## Session', '', '**Last session:** 2026-01-01T00:00:00.000Z', '**Stopped at:** None', '**Resume file:** None', '',
].join('\n');

describe('pauseFileNames and the pause_files view', () => {
  test('rolePausesIntoTheRoleSlot', () => {
    assert.deepEqual(store.pauseFileNames({ session_id: 's1', role_id: 'coordinator' }), {
      handoff: 'HANDOFF.latest.coordinator.json',
      continue_here: '.continue-here.latest.coordinator.md',
    });
  });

  test('roleLessSessionPausesIntoItsOwnFile', () => {
    assert.deepEqual(store.pauseFileNames({ session_id: 's1', role_id: null }), {
      handoff: 'HANDOFF.s1.json',
      continue_here: '.continue-here.md',
    });
  });

  test('noSessionIdKeepsTheLegacyNames', () => {
    assert.deepEqual(store.pauseFileNames({ session_id: null, role_id: null }), { handoff: 'HANDOFF.json', continue_here: '.continue-here.md' });
    assert.deepEqual(store.pauseFileNames({ session_id: null, role_id: 'coordinator' }), { handoff: 'HANDOFF.json', continue_here: '.continue-here.md' });
  });

  test('theNamesRoundTripThroughTheGrammarForAnyIdentity', () => {
    const slug = fc.stringMatching(/^[a-z0-9]+(?:-[a-z0-9]+){0,4}$/).filter((s) => s.length > 0 && s.length <= store.ROLE_ID_MAX);
    const session = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_-]{0,30}$/).filter((s) => store.sanitizeSessionId(s) === s);
    fc.assert(
      fc.property(session, fc.option(slug, { nil: null }), (sid, role) => {
        const identity = { session_id: sid, role_id: role };
        const names = store.pauseFileNames(identity);
        const parsed = store.classifyHandoffName(names.handoff);
        assert.ok(parsed, names.handoff);
        assert.equal(store.isOwnHandoff({ ...parsed, body: {} }, identity), true);
        assert.equal(parsed.kind, role === null ? 'session' : 'latest');
      }),
      { seed: 6798, numRuns: 200 },
    );
  });

  describe('through the CLI', () => {
    let tmp;
    beforeEach(() => { tmp = createTempProject(); });
    afterEach(() => cleanup(tmp));
    const pick = (args, key, env = {}) => {
      const r = runGsdTools(['state', 'sessions', ...args, '--pick', key], tmp, { ...NO_KEYS, ...env });
      assert.ok(r.success, r.error);
      return r.output.trim();
    };

    test('sessionsPicksThePauseFilesAndTheIdentity', () => {
      assert.equal(pick(['--role', 'Lead Reviewer'], 'pause_files.handoff', { GSD_SESSION_KEY: 's1' }), 'HANDOFF.latest.lead-reviewer.json');
      assert.equal(pick(['--role', 'Lead Reviewer'], 'pause_files.continue_here', { GSD_SESSION_KEY: 's1' }), '.continue-here.latest.lead-reviewer.md');
      assert.equal(pick([], 'pause_files.handoff', { GSD_SESSION_KEY: 's1' }), 'HANDOFF.s1.json');
      assert.equal(pick([], 'pause_files.handoff'), 'HANDOFF.json');
      assert.equal(pick([], 'session_id'), '');
      assert.equal(pick([], 'own_handoff', { GSD_SESSION_KEY: 's1' }), '');
    });

    test('roleIdLengthBoundsLimitMinusOneLimitLimitPlusOne', () => {
      for (const n of [store.ROLE_ID_MAX - 1, store.ROLE_ID_MAX, store.ROLE_ID_MAX + 1]) {
        const handoff = pick(['--role', 'a'.repeat(n)], 'pause_files.handoff', { GSD_SESSION_KEY: 's1' });
        const parsed = store.classifyHandoffName(handoff);
        assert.ok(parsed && parsed.kind === 'latest', `${n}: ${handoff}`);
        assert.ok(parsed.role_id.length <= store.ROLE_ID_MAX);
      }
    });

    test('pausedIsTrueOnlyForTheCallersOwnHandoff', () => {
      const planning = path.join(tmp, '.planning');
      fs.writeFileSync(path.join(planning, 'HANDOFF.s2.json'), '{}');
      assert.equal(pick([], 'paused', { GSD_SESSION_KEY: 's1' }), 'false');
      assert.equal(pick([], 'paused', { GSD_SESSION_KEY: 's2' }), 'true');
    });

    test('ownHandoffPrefersAClaimOverTheSlotOverALegacyFile', () => {
      const planning = path.join(tmp, '.planning');
      fs.writeFileSync(path.join(planning, 'HANDOFF.json'), '{}');
      fs.writeFileSync(path.join(planning, 'HANDOFF.latest.coordinator.json'), '{}');
      assert.equal(pick(['--role', 'coordinator'], 'own_handoff', { GSD_SESSION_KEY: 's1' }), 'HANDOFF.latest.coordinator.json');
      fs.writeFileSync(path.join(planning, 'HANDOFF.claimed.coordinator.s1.json'), '{}');
      assert.equal(pick(['--role', 'coordinator'], 'own_handoff', { GSD_SESSION_KEY: 's1' }), 'HANDOFF.claimed.coordinator.s1.json');
      assert.equal(pick(['--role', 'coordinator'], 'own_handoff', { GSD_SESSION_KEY: 's2' }), 'HANDOFF.latest.coordinator.json');
    });
  });
});

describe('the pause and resume fences, executed', { skip: !HAS_BASH }, () => {
  let tmp;
  let planning;
  const put = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(planning, rel)), { recursive: true });
    fs.writeFileSync(path.join(planning, rel), typeof content === 'string' ? content : JSON.stringify(content));
  };
  const exists = (rel) => fs.existsSync(path.join(planning, rel));
  const identify = () => fence('pause-work.md', 'pause-identify');
  const record = () => fence('pause-work.md', 'pause-record');
  const claim = () => fence('resume-project.md', 'claim-handoff');
  const consume = () => fence('resume-project.md', 'consume-handoff');

  beforeEach(() => {
    tmp = createTempProject();
    planning = path.join(tmp, '.planning');
    fs.writeFileSync(path.join(planning, 'STATE.md'), STATE);
    assert.equal(runGit(['init', '-q'], { cwd: tmp }).exitCode, 0);
  });
  afterEach(() => cleanup(tmp));

  describe('pause', () => {
    test('aRoleSessionGetsTheRoleSlotNames', () => {
      const r = runBash(tmp, script([identify()], '--role Lead Reviewer'), 's1');
      assert.equal(r.status, 0, r.err);
      assert.match(r.out, /session=s1 role_id=lead-reviewer handoff=HANDOFF\.latest\.lead-reviewer\.json continue_here=\.continue-here\.latest\.lead-reviewer\.md/);
    });

    test('aRoleLessSessionGetsItsOwnFileAndNoSessionGetsTheLegacyNames', () => {
      const own = runBash(tmp, script([identify()], ''), 's1');
      assert.match(own.out, /handoff=HANDOFF\.s1\.json continue_here=\.continue-here\.md/);
      const none = runBash(tmp, script([identify()], ''), null);
      assert.match(none.out, /session=none role_id=none handoff=HANDOFF\.json continue_here=\.continue-here\.md/);
    });

    test('recordingASessionNeverWritesPausedAtOrPausedStatus', () => {
      const r = runBash(tmp, script([identify(), record()], '--role coordinator'), 's1');
      assert.equal(r.status, 0, r.err);
      const state = fs.readFileSync(path.join(planning, 'STATE.md'), 'utf-8');
      assert.doesNotMatch(state, /paused_at/);
      assert.doesNotMatch(state, /status:\s*paused/i);
      assert.match(state, /status: executing/);
      assert.match(state, /Paused at \[X\]\/\[Y\]/);
      assert.match(r.out, /state_file=.*STATE\.md/);
    });

    test('withNoStateFileTheRecordStepIsSkipped', () => {
      fs.unlinkSync(path.join(planning, 'STATE.md'));
      const r = runBash(tmp, script([identify(), record()], ''), 's1');
      assert.equal(r.status, 0, r.err);
      assert.match(r.out, /state_file=none/);
    });
  });

  describe('a role is data', () => {
    const hostile = [
      'x"; touch PWNED; "',
      '$(touch PWNED)',
      '`touch PWNED`',
      "it's a 'role' && touch PWNED",
      '--role touch PWNED',
    ];
    for (const role of hostile) {
      test(`neverExecutes: ${role}`, () => {
        const r = runBash(tmp, script([identify(), record(), claim(), consume()], `--role ${role}`), 's1');
        assert.ok(!fs.existsSync(path.join(tmp, 'PWNED')), `${r.out}\n${r.err}`);
        assert.ok(!fs.existsSync(path.join(planning, 'PWNED')));
      });
    }

    test('aMultiLineRoleIsRefusedByTheCliAndStillNeverRuns', () => {
      const r = runBash(tmp, script([identify()], '--role first\n; touch PWNED'), 's1');
      assert.ok(!fs.existsSync(path.join(tmp, 'PWNED')), r.out);
    });
  });

  describe('claim', () => {
    test('aRoleSessionClaimsByRenameBeforeReading', () => {
      put('HANDOFF.latest.coordinator.json', { role_id: 'coordinator', next_action: 'ship it' });
      const r = runBash(tmp, script([claim()], '--role coordinator'), 's1');
      assert.equal(r.status, 0, r.err);
      assert.match(r.out, /HANDOFF_FILE=\.planning\/HANDOFF\.claimed\.coordinator\.s1\.json/);
      assert.match(r.out, /ship it/);
      assert.equal(exists('HANDOFF.latest.coordinator.json'), false);
      assert.equal(exists('HANDOFF.claimed.coordinator.s1.json'), true);
    });

    // The marker holds its creation time in epoch seconds; the claim removes one older than a day (ADR-4962 Decision 3).
    const MARKER = '.handoff-claim.coordinator';
    const claimWith = (content) => {
      const marker = path.join(planning, MARKER);
      fs.writeFileSync(marker, content);
      put('HANDOFF.latest.coordinator.json', { role_id: 'coordinator', next_action: 'after a crash' });
      return { marker, r: runBash(tmp, script([claim()], '--role coordinator'), 's1') };
    };

    test('aHeldFreshClaimMarkerMakesTheSessionLoseAndLeavesTheHandoffAndTheMarker', () => {
      const { marker, r } = claimWith(Math.floor(Date.now() / 1000) + '\n');
      assert.equal(r.status, 0, r.err);
      assert.match(r.out, /NO_UNCLAIMED_HANDOFF role_id=coordinator/);
      assert.doesNotMatch(r.out, /HANDOFF_FILE=/);
      assert.equal(exists('HANDOFF.latest.coordinator.json'), true, 'the handoff stays for the marker holder');
      assert.equal(fs.existsSync(marker), true, 'a loser never removes the winner marker');
    });

    test('aMarkerOlderThanADayIsSweptAndTheClaimSucceedsAndLeavesNoMarker', () => {
      const { marker, r } = claimWith('1\n');
      assert.equal(r.status, 0, r.err);
      assert.match(r.out, /HANDOFF_FILE=\.planning\/HANDOFF\.claimed\.coordinator\.s1\.json/);
      assert.match(r.out, /after a crash/);
      assert.equal(fs.existsSync(marker), false, 'the winner removes the marker in the same block');
    });

    for (const [name, content] of [['anEmptyMarkerIsALiveOneBeingWrittenAndIsNotSwept', ''], ['aNonNumericMarkerIsNotSwept', 'not a time\n']]) {
      test(name, () => {
        const { marker, r } = claimWith(content);
        assert.match(r.out, /NO_UNCLAIMED_HANDOFF/);
        assert.equal(fs.existsSync(marker), true);
        assert.equal(exists('HANDOFF.latest.coordinator.json'), true);
      });
    }

    test('twoSessionsResumingOneRoleYieldExactlyOneWinner', async () => {
      put('HANDOFF.latest.coordinator.json', { role_id: 'coordinator', next_action: 'only one reads this' });
      const results = await Promise.all([
        runBashAsync(tmp, script([claim()], '--role coordinator'), 's1'),
        runBashAsync(tmp, script([claim()], '--role coordinator'), 's2'),
      ]);
      const winners = results.filter((r) => /HANDOFF_FILE=/.test(r.out));
      const losers = results.filter((r) => /NO_UNCLAIMED_HANDOFF/.test(r.out));
      assert.equal(winners.length, 1, JSON.stringify(results));
      assert.equal(losers.length, 1, JSON.stringify(results));
      assert.doesNotMatch(losers[0].out, /only one reads this/);
      assert.equal(fs.readdirSync(planning).filter((f) => f.startsWith('HANDOFF.claimed.coordinator.')).length, 1);
    });

    test('theSecondSessionIsToldNoUnclaimedHandoffExists', () => {
      put('HANDOFF.claimed.coordinator.s1.json', { role_id: 'coordinator', next_action: 'held by s1' });
      const r = runBash(tmp, script([claim()], '--role coordinator'), 's2');
      assert.match(r.out, /NO_UNCLAIMED_HANDOFF role_id=coordinator/);
      assert.doesNotMatch(r.out, /held by s1/);
      assert.equal(exists('HANDOFF.claimed.coordinator.s1.json'), true);
    });

    test('aRoleLessSessionReadsItsOwnFileOnly', () => {
      put('HANDOFF.s1.json', { next_action: 'mine' });
      put('HANDOFF.s2.json', { next_action: 'theirs' });
      const r = runBash(tmp, script([claim()], ''), 's1');
      assert.match(r.out, /mine/);
      assert.doesNotMatch(r.out, /theirs/);
    });

    test('aLegacyHandoffNamingAnotherRoleIsNotReadWithoutASessionEither', () => {
      put('HANDOFF.json', { role_id: 'reviewer', next_action: 'reviewer work' });
      assert.doesNotMatch(runBash(tmp, script([claim()], '--role coordinator'), null).out, /reviewer work/);
      assert.match(runBash(tmp, script([claim()], '--role reviewer'), null).out, /reviewer work/);
    });

    test('aLegacyHandoffIsReadUnlessItNamesAnotherRole', () => {
      put('HANDOFF.json', { next_action: 'legacy work' });
      assert.match(runBash(tmp, script([claim()], ''), 's1').out, /legacy work/);
      assert.match(runBash(tmp, script([claim()], ''), null).out, /legacy work/);
      put('HANDOFF.json', { role_id: 'someone-else', next_action: 'not for s1' });
      assert.doesNotMatch(runBash(tmp, script([claim()], ''), 's1').out, /not for s1/);
    });
  });

  describe('consume', () => {
    test('removesOnlyThisSessionsHandoffAndContinueHereFiles', () => {
      put('HANDOFF.claimed.coordinator.s1.json', { role_id: 'coordinator' });
      put('.continue-here.latest.coordinator.md', 'mine');
      put('phases/01-x/.continue-here.latest.coordinator.md', 'mine in phase');
      put('.continue-here.latest.reviewer.md', 'other role');
      put('phases/01-x/.continue-here.latest.reviewer.md', 'other role in phase');
      put('HANDOFF.claimed.reviewer.s2.json', { role_id: 'reviewer' });
      put('HANDOFF.latest.reviewer.json', { role_id: 'reviewer' });
      const r = runBash(tmp, script([consume()], '--role coordinator'), 's1');
      assert.equal(r.status, 0, r.err);
      assert.equal(exists('HANDOFF.claimed.coordinator.s1.json'), false);
      assert.equal(exists('.continue-here.latest.coordinator.md'), false);
      assert.equal(exists('phases/01-x/.continue-here.latest.coordinator.md'), false);
      for (const kept of ['.continue-here.latest.reviewer.md', 'phases/01-x/.continue-here.latest.reviewer.md', 'HANDOFF.claimed.reviewer.s2.json', 'HANDOFF.latest.reviewer.json']) {
        assert.equal(exists(kept), true, kept);
      }
    });

    test('aClaimLoserNeverRemovesTheWinnersContinueHere', () => {
      put('HANDOFF.claimed.coordinator.s1.json', { role_id: 'coordinator' });
      put('.continue-here.latest.coordinator.md', 'winner context');
      const r = runBash(tmp, script([consume()], '--role coordinator'), 's2');
      assert.equal(r.status, 0, r.err);
      assert.equal(exists('.continue-here.latest.coordinator.md'), true);
      assert.equal(exists('HANDOFF.claimed.coordinator.s1.json'), true);
    });

    test('theSharedUnkeyedContinueHereStaysWhileAnotherRoleLessSessionIsPaused', () => {
      put('HANDOFF.s1.json', {});
      put('HANDOFF.s2.json', {});
      put('.continue-here.md', 'shared name');
      const r = runBash(tmp, script([consume()], ''), 's1');
      assert.equal(r.status, 0, r.err);
      assert.equal(exists('HANDOFF.s1.json'), false);
      assert.equal(exists('HANDOFF.s2.json'), true);
      assert.equal(exists('.continue-here.md'), true);
    });

    test('aCheckpointOnlyResumeRecordsTheResumeAndRemovesNothing', () => {
      put('.continue-here.md', 'checkpoint');
      const r = runBash(tmp, script([consume()], ''), 's1');
      assert.equal(r.status, 0, r.err);
      assert.equal(exists('.continue-here.md'), true);
      assert.match(fs.readFileSync(path.join(planning, 'STATE.md'), 'utf-8'), /Session resumed/);
    });

    test('theCommitRecordsTheRoleSlotDeletionNotTheUntrackedClaim', () => {
      put('HANDOFF.latest.coordinator.json', { role_id: 'coordinator' });
      assert.equal(runGit(['add', '-A'], { cwd: tmp }).exitCode, 0);
      assert.equal(runGit(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'pause'], { cwd: tmp }).exitCode, 0);
      const claimed = runBash(tmp, script([claim()], '--role coordinator'), 's1');
      assert.match(claimed.out, /HANDOFF_FILE=/);
      const r = runBash(tmp, script([consume()], '--role coordinator'), 's1');
      assert.equal(r.status, 0, r.err);
      const status = runGit(['status', '--porcelain', '--', '.planning/HANDOFF.latest.coordinator.json'], { cwd: tmp }).stdout;
      assert.equal(status.trim(), '', `the slot deletion must be committed: ${status}`);
    });

    test('theLegacyPairIsConsumedWithoutARole', () => {
      put('HANDOFF.json', { next_action: 'x' });
      put('.continue-here.md', 'checkpoint');
      const r = runBash(tmp, script([consume()], ''), null);
      assert.equal(r.status, 0, r.err);
      assert.equal(exists('HANDOFF.json'), false);
      assert.equal(exists('.continue-here.md'), false);
    });
  });
});

describe('the next gate, executed', { skip: !HAS_BASH }, () => {
  let tmp;
  beforeEach(() => { tmp = createTempProject(); });
  afterEach(() => cleanup(tmp));
  const gate = (args, sid) => runBash(tmp, script([fence('next.md', 'next-paused')], args), sid).status;

  test('onlyTheCallersOwnHandoffPausesIt', () => {
    fs.writeFileSync(path.join(tmp, '.planning', 'HANDOFF.s2.json'), '{}');
    assert.equal(gate('', 's1'), 1);
    assert.equal(gate('', 's2'), 0);
  });

  test('aRoleHandoffPausesTheSessionThatNamesTheRole', () => {
    fs.writeFileSync(path.join(tmp, '.planning', 'HANDOFF.latest.coordinator.json'), '{}');
    assert.equal(gate('', 's1'), 1);
    assert.equal(gate('--role Coordinator', 's1'), 0);
  });
});

