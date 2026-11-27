'use strict';

/**
 * #6797 (phase 2 of #4845; ADR-4962 Decisions 1, 2, 4, 7): the statusline's inline reader of the per-session
 * handoff grammar, and the other readers of that grammar (artifacts registry, legacy ownership).
 *
 * The statusline is a standalone hook (#3582: it cannot require the compiled CLI), so it carries its own
 * copy of the grammar; tests/session-handoff-parity.test.cjs holds that copy to the store. These rows pin
 * what the user sees.
 */

const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, cleanup } = require('./helpers.cjs');
const statusline = require('../hooks/gsd-statusline.js');
const store = require('../gsd-core/bin/lib/session-store.cjs');
const { isCanonicalPlanningFile } = require('../gsd-core/bin/lib/artifacts.cjs');

const STATE = [
  '---', 'gsd_state_version: 1.0', 'milestone: v1.0', 'milestone_name: Demo', 'status: executing', '---', '',
  '# Project State', '', '## Current Position', '', 'Phase: 2 of 5 (Build)', 'Status: Executing', '',
].join('\n');

function trySymlink(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath);
    return true;
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EACCES')) return false;
    throw err;
  }
}

describe('statusline: the per-session pause marker (#6797)', () => {
  let dir;
  let planning;
  beforeEach(() => {
    dir = createTempProject();
    planning = path.join(dir, '.planning');
    fs.writeFileSync(path.join(planning, 'STATE.md'), STATE);
  });
  afterEach(() => { mock.restoreAll(); cleanup(dir); });

  const put = (name, body = {}) => fs.writeFileSync(path.join(planning, name), typeof body === 'string' ? body : JSON.stringify(body));
  const record = (sid, roleId) => {
    fs.mkdirSync(path.join(planning, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(planning, 'sessions', `${sid}.json`), JSON.stringify({ session_id: sid, role_id: roleId }));
  };
  const render = (opts = {}, format = 'full') => {
    const state = statusline.readGsdState(dir, { env: {}, ...opts }) || {};
    return format === 'compact' ? statusline.formatGsdStateCompact(state, {}) : statusline.formatGsdState(state, {});
  };

  for (const format of ['full', 'compact']) {
    const PAUSED = format === 'compact' ? 'PAUSED' : 'paused';

    test(`statuslineShowsPausedForOwnRoleHandoff (${format}): the slot of the caller's recorded role marks it paused`, () => {
      record('me', 'coordinator');
      put('HANDOFF.latest.coordinator.json');
      assert.ok(render({ sessionId: 'me' }, format).includes(PAUSED), render({ sessionId: 'me' }, format));
    });

    test(`statuslineShowsPausedForOwnSessionHandoff (${format})`, () => {
      put('HANDOFF.me.json');
      assert.ok(render({ sessionId: 'me' }, format).includes(PAUSED));
    });

    test(`statuslineShowsPausedForRolelessLegacyHandoff (${format})`, () => {
      put('HANDOFF.json');
      assert.ok(render({ sessionId: 'me' }, format).includes(PAUSED));
    });

    test(`statuslineShowsOthersCount (${format}): other sessions' handoffs are counted, the caller is not marked paused`, () => {
      put('HANDOFF.a.json');
      put('HANDOFF.latest.implementer.json');
      const out = render({ sessionId: 'me' }, format);
      assert.ok(out.includes('⏸2'), out);
      assert.ok(!out.includes(PAUSED), out);
    });

    test(`statuslineShowsOwnAndOthers (${format})`, () => {
      put('HANDOFF.me.json');
      put('HANDOFF.other.json');
      const out = render({ sessionId: 'me' }, format);
      assert.ok(out.includes(PAUSED) && out.includes('⏸1'), out);
    });

    test(`statuslineWithoutHandoffIsByteIdentical (${format}): with no handoff the output is the pinned string this fixture rendered before the feature`, () => {
      // Literals, not a second render by the new code: the pre-feature formatters printed exactly these for this STATE.md.
      const GOLDEN = { full: 'v1.0 Demo · executing · Build (2/5)', compact: 'v1.0 · P2/5 · executing' };
      assert.equal(render({ sessionId: 'me' }, format), GOLDEN[format]);
      assert.equal(render({}, format), GOLDEN[format], 'the default call shape (no session option) renders the same');
    });
  }

  test('statuslineWithoutIdentityOwnsNothing: with no session id nothing is own, and others are still counted', () => {
    put('HANDOFF.json');
    put('HANDOFF.a.json');
    const out = render({ sessionId: undefined });
    assert.ok(!/paused/i.test(out), out);
    assert.ok(out.includes('⏸2'), out);
  });

  test('statuslineUsesRuntimeKeyBeforePayload: the CLI resolves env keys first, so the hook does too', () => {
    put('HANDOFF.from-env.json');
    const out = render({ sessionId: 'payload-id', env: { GSD_SESSION_KEY: 'from-env' } });
    assert.ok(/paused/i.test(out), out);
  });

  test('statuslineIgnoresTerminalKeys: a terminal variable is not a session', () => {
    put('HANDOFF.json');
    const out = render({ sessionId: undefined, env: { TMUX_PANE: '%1', TERM_SESSION_ID: 'x' } });
    assert.ok(!/paused/i.test(out), out);
  });

  test('statuslineKeepsLegacyPausedStatus: a STATE.md whose status is paused still reads paused to every session, with no handoff at all', () => {
    fs.writeFileSync(path.join(planning, 'STATE.md'), STATE.replace('status: executing', 'status: paused'));
    for (const sessionId of ['me', 'someone-else']) {
      assert.ok(/paused/i.test(render({ sessionId })), sessionId);
      assert.ok(/PAUSED/.test(render({ sessionId }, 'compact')), sessionId);
    }
  });

  test('statuslineNeverDoublesPaused: an own handoff on a state already saying paused prints it once', () => {
    fs.writeFileSync(path.join(planning, 'STATE.md'), STATE.replace('status: executing', 'status: paused'));
    put('HANDOFF.me.json');
    assert.equal((render({ sessionId: 'me' }).match(/paused/g) || []).length, 1);
    assert.equal((render({ sessionId: 'me' }, 'compact').match(/PAUSED/g) || []).length, 1);
  });

  test('statuslineReadsRoleFromOwnRecord: a role that is not a slug in the record is ignored (role-less)', () => {
    record('me', 'Not A Slug!');
    put('HANDOFF.latest.not-a-slug.json');
    const out = render({ sessionId: 'me' });
    assert.ok(!/paused/i.test(out), out);
    assert.ok(out.includes('⏸1'), out);
  });

  test('statuslineReadsHandoffsFromProjectRoot: under a workstream the root handoffs are still read', () => {
    const ws = path.join(planning, 'workstreams', 'alpha');
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'STATE.md'), STATE);
    fs.unlinkSync(path.join(planning, 'STATE.md'));
    put('HANDOFF.other.json');
    const saved = process.env.GSD_WORKSTREAM;
    process.env.GSD_WORKSTREAM = 'alpha';
    let state;
    try { state = statusline.readGsdState(dir, { env: {}, sessionId: 'me' }); } finally {
      if (saved === undefined) delete process.env.GSD_WORKSTREAM; else process.env.GSD_WORKSTREAM = saved;
    }
    assert.ok(state && !state.noActiveWorkstream, 'the workstream resolves, so the state under test is the workstream one');
    assert.equal(state.handoffs.others, 1);
  });

  test('statuslineIgnoresNonHandoffNames: only the grammar counts', () => {
    put('HANDOFF.md', 'x');
    put('handoff-notes.json');
    put('.continue-here.md', 'x');
    put('HANDOFF.json.json');
    put('HANDOFF.latest.json');
    record('other', 'r');
    const out = render({ sessionId: 'me' });
    assert.ok(!out.includes('⏸') && !/paused/i.test(out), out);
  });

  test('statuslineSkipsUnreadableHandoffs: oversized, invalid, array and directory entries are never counted', () => {
    const cap = statusline.HANDOFF_MAX_BYTES;
    const base = JSON.stringify({ pad: '' }).length;
    const pad = (n) => JSON.stringify({ pad: 'x'.repeat(n) });
    put('HANDOFF.ok1.json', pad(cap - base - 1)); // limit-1
    put('HANDOFF.ok2.json', pad(cap - base)); // limit
    put('HANDOFF.big.json', pad(cap - base + 1)); // limit+1
    put('HANDOFF.bad.json', '{nope');
    put('HANDOFF.arr.json', '[1]');
    fs.mkdirSync(path.join(planning, 'HANDOFF.dir.json'));
    const out = render({ sessionId: 'me' });
    assert.ok(out.includes('⏸2'), out);
  });

  test('statuslineSkipsSymlinkedHandoffs: a handoff-named symlink is not counted and not followed', (t) => {
    put('HANDOFF.real.json');
    if (!trySymlink(path.join(planning, 'HANDOFF.real.json'), path.join(planning, 'HANDOFF.link.json'))) {
      t.skip('creating a symlink needs a privilege this platform run does not have');
      return;
    }
    assert.ok(render({ sessionId: 'me' }).includes('⏸1'));
  });

  for (const [files, expected] of [[63, 63], [64, 64], [65, 64], [66, 64]]) {
    test(`statuslineReadsAtMostSixtyFourEntries: ${files} handoff files count as ${expected}`, () => {
      assert.equal(statusline.HANDOFF_ENTRY_CAP, 64);
      for (let i = 0; i < files; i++) put(`HANDOFF.s${String(i).padStart(3, '0')}.json`);
      const state = statusline.readGsdState(dir, { env: {}, sessionId: 'me' });
      assert.equal(state.handoffs.others, expected);
    });
  }

  test('statuslineReadsOwnHandoffBeyondTheCap: 70 claimed files held by others sort ahead of the caller\'s own file, which is still found', () => {
    for (let i = 0; i < 70; i++) put(`HANDOFF.claimed.r${String(i).padStart(3, '0')}.other${i}.json`);
    put('HANDOFF.me.json');
    const state = statusline.readGsdState(dir, { env: {}, sessionId: 'me' });
    assert.equal(state.handoffs.own, true, 'the own handoff is read before the cap applies');
    assert.equal(state.handoffs.others, statusline.HANDOFF_ENTRY_CAP - 1);
    assert.ok(/paused/i.test(statusline.formatGsdState(state, {})));
  });

  test('statuslineSurvivesReaddirFailure: an unreadable .planning listing renders as no handoff and never throws (fs patch restored)', () => {
    put('HANDOFF.other.json');
    const real = fs.readdirSync;
    mock.method(fs, 'readdirSync', (p, ...rest) => {
      if (path.resolve(String(p)) === path.resolve(planning)) throw Object.assign(new Error('EIO: simulated'), { code: 'EIO' });
      return real.call(fs, p, ...rest);
    });
    let out;
    try { out = render({ sessionId: 'me' }); } finally { mock.restoreAll(); }
    assert.ok(!out.includes('⏸'), out);
  });
});

describe('legacy handoff ownership keys on a valid role_id only (#6797)', () => {
  const me = (roleId) => ({ session_id: 's1', role_id: roleId });
  const legacy = (body) => ({ kind: 'legacy', role_id: null, session_id: null, body });

  for (const [label, body, identity, expected] of [
    ['names no role', {}, me(null), true],
    ['role_id is a slug naming the caller', { role_id: 'reviewer' }, me('reviewer'), true],
    ['role_id is a slug naming another role', { role_id: 'reviewer' }, me('implementer'), false],
    ['role_id is a slug and the caller has no role', { role_id: 'reviewer' }, me(null), false],
    ['role_id is not a slug, so it names no role', { role_id: 'Not A Slug!' }, me('implementer'), true],
    ['role_id is uppercase, so it names no role', { role_id: 'Reviewer' }, me('implementer'), true],
    ['role_id is not a string', { role_id: 7 }, me('implementer'), true],
    ['role free text alone is not read', { role: 'Reviewer A' }, me('implementer'), true],
    ['role_id is a slug over the 80-character cap, so it names no role', { role_id: 'a'.repeat(81) }, me('implementer'), true],
    ['role_id is a slug at the 80-character cap and names another role', { role_id: 'a'.repeat(80) }, me('implementer'), false],
  ]) {
    test(`legacyOwnershipKeysOnRoleId: body ${label}`, () => {
      assert.equal(store.isOwnHandoff(legacy(body), identity), expected);
      assert.equal(statusline.isOwnHandoff(legacy(body), identity), expected);
    });
  }
});

describe('hasOwnHandoff reads only names that could be the caller\'s (#6797)', () => {
  let dir;
  beforeEach(() => { dir = createTempProject(); });
  afterEach(() => { mock.restoreAll(); cleanup(dir); });
  const planning = () => path.join(dir, '.planning');
  const put = (name, body = {}) => fs.writeFileSync(path.join(planning(), name), typeof body === 'string' ? body : JSON.stringify(body));
  const me = { session_id: 's1', role_id: 'coordinator' };

  test('hasOwnHandoffTrueForOwnNames: its session file, its role slot, a legacy file that names no other role', () => {
    for (const name of ['HANDOFF.s1.json', 'HANDOFF.latest.coordinator.json', 'HANDOFF.json']) {
      const fresh = createTempProject();
      try {
        fs.writeFileSync(path.join(fresh, '.planning', name), '{}');
        assert.equal(store.hasOwnHandoff(path.join(fresh, '.planning'), me), true, name);
      } finally { cleanup(fresh); }
    }
  });

  test('hasOwnHandoffFalseForOthersAndNoIdentity', () => {
    put('HANDOFF.s2.json');
    put('HANDOFF.latest.implementer.json');
    put('HANDOFF.json', { role_id: 'reviewer' });
    assert.equal(store.hasOwnHandoff(planning(), me), false);
    assert.equal(store.hasOwnHandoff(planning(), { session_id: null, role_id: null }), false);
  });

  test('hasOwnHandoffNeverOpensOtherSessionsFiles: a file whose name is not the caller\'s is not read (fs patch restored)', () => {
    put('HANDOFF.s2.json');
    put('HANDOFF.s1.json');
    const opened = [];
    const real = fs.openSync;
    mock.method(fs, 'openSync', (p, ...rest) => { opened.push(path.basename(String(p))); return real.call(fs, p, ...rest); });
    let result;
    try { result = store.hasOwnHandoff(planning(), me); } finally { mock.restoreAll(); }
    assert.equal(result, true);
    assert.ok(!opened.includes('HANDOFF.s2.json'), `opened: ${opened.join(',')}`);
  });

  test('hasOwnHandoffIgnoresUnreadableOwnFile: an invalid own file is not a pause', () => {
    put('HANDOFF.s1.json', '{nope');
    assert.equal(store.hasOwnHandoff(planning(), me), false);
  });
});

describe('artifacts: every handoff-grammar name is a canonical planning file (#6797)', () => {
  test('artifactsKnowsHandoffGrammar', () => {
    for (const name of ['HANDOFF.json', 'HANDOFF.latest.coordinator.json', 'HANDOFF.abc-123.json', 'HANDOFF.a.b.c.json', 'HANDOFF.claimed.coordinator.s1.json']) {
      assert.equal(isCanonicalPlanningFile(name), true, name);
    }
    for (const name of ['HANDOFF.latest.json', 'HANDOFF.json.json', 'HANDOFF.md', 'HANDOFF..json', 'handoff.json', 'HANDOFF.x.json.bak']) {
      assert.equal(isCanonicalPlanningFile(name), false, name);
    }
    assert.equal(isCanonicalPlanningFile('STATE.md'), true);
  });
});
