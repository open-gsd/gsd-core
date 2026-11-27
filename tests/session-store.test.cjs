'use strict';

/**
 * Session store (#6796, phase 1 of #4845; ADR-4962): the handoff filename
 * grammar, session-identity resolution, ownership, and bounded listing.
 * Pure in-process tests: no spawn, a temp `.planning/` per test.
 */

const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { createTempProject, cleanup } = require('./helpers.cjs');
const store = require('../gsd-core/bin/lib/session-store.cjs');
const cases = require('./fixtures/session-handoff-cases.json').cases;

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
const TERMINAL_KEYS = ['TMUX_PANE', 'TERM_SESSION_ID', 'WT_SESSION', 'ZELLIJ_SESSION_NAME', 'CLAUDE_CODE_SSE_PORT', 'TTY', 'SSH_TTY'];

describe('sanitizeSessionId', () => {
  for (const [label, length, expected] of [['limit-1', 159, 159], ['limit', 160, 160], ['limit+1', 161, 160]]) {
    test(`sanitizeSessionIdLengthBoundary ${label} keeps at most 160 characters`, () => {
      assert.equal(store.SESSION_ID_MAX, 160);
      assert.equal(store.sanitizeSessionId('a'.repeat(length)).length, expected);
    });
  }

  test('sanitizeSessionIdStripsUnsafe keeps only [A-Za-z0-9._-] and never yields a dot-only or separator-bearing id', () => {
    for (const hostile of ['a/b', 'a\\b', '../../etc/passwd', 'a b', 'a\u0000b', 'séssion', '..', '.', '...', '-x-', '___', '$(touch x)']) {
      const out = store.sanitizeSessionId(hostile);
      if (out === null) continue;
      assert.match(out, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, `${JSON.stringify(hostile)} -> ${out}`);
      assert.ok(!out.includes('..') || /[A-Za-z0-9]\.\.[A-Za-z0-9]/.test(out), out);
    }
    assert.equal(store.sanitizeSessionId('..'), null);
    assert.equal(store.sanitizeSessionId('a/b'), 'a_b');
  });

  test('sanitizeSessionIdRejectsEmpty returns null for empty, blank and non-string input', () => {
    for (const v of ['', '   ', null, undefined, 0, {}, [], '___']) assert.equal(store.sanitizeSessionId(v), null);
  });

  test('reservedFirstSegmentIsEscaped prefixes s_ when the first dot-segment is latest, claimed or json', () => {
    assert.equal(store.sanitizeSessionId('latest'), 's_latest');
    assert.equal(store.sanitizeSessionId('claimed.x'), 's_claimed.x');
    assert.equal(store.sanitizeSessionId('json'), 's_json');
    assert.equal(store.sanitizeSessionId('latest.x'), 's_latest.x');
    assert.equal(store.sanitizeSessionId('latestx'), 'latestx');
    assert.equal(store.sanitizeSessionId('x.latest'), 'x.latest');
  });
});

describe('sanitizeRoleId', () => {
  test('derives an ASCII slug from free text', () => {
    assert.equal(store.sanitizeRoleId('Reviewer A'), 'reviewer-a');
    assert.equal(store.sanitizeRoleId('  Bad Slug!!  '), 'bad-slug');
  });

  test('unusable text yields null', () => {
    for (const v of ['!!!', '', '   ', null, undefined, 42]) assert.equal(store.sanitizeRoleId(v), null);
  });

  for (const [label, length, expected] of [['limit-1', 79, 79], ['limit', 80, 80], ['limit+1', 81, 80]]) {
    test(`sanitizeRoleIdLengthBoundary ${label} is capped at 80 with no trailing hyphen`, () => {
      assert.equal(store.ROLE_ID_MAX, 80);
      const out = store.sanitizeRoleId('a'.repeat(length));
      assert.equal(out.length, expected);
      const spaced = store.sanitizeRoleId(`${'a'.repeat(79)} ${'b'.repeat(10)}`);
      assert.ok(!spaced.endsWith('-'), spaced);
    });
  }

  test('a role slug never contains a dot, so the filename grammar stays unambiguous', () => {
    fc.assert(fc.property(fc.string(), (s) => {
      const out = store.sanitizeRoleId(s);
      return out === null || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(out);
    }), { seed: 6796, numRuns: 300 });
  });
});

describe('resolveSessionId', () => {
  test('resolveSessionIdFlagBeatsEnv', () => {
    assert.equal(store.resolveSessionId({ session: 'from-flag', env: { ...NO_KEYS, CLAUDE_CODE_SESSION_ID: 'from-env' } }), 'from-flag');
  });

  test('resolveSessionIdFromEnvInOrder takes the first set key in the declared order', () => {
    assert.deepEqual(store.SESSION_ENV_KEYS, [
      'GSD_SESSION_KEY', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'OPENCODE_SESSION_ID',
      'GEMINI_SESSION_ID', 'CURSOR_SESSION_ID', 'WINDSURF_SESSION_ID',
    ]);
    store.SESSION_ENV_KEYS.forEach((key, i) => {
      const env = { ...NO_KEYS, [key]: `id-${i}` };
      assert.equal(store.resolveSessionId({ env }), `id-${i}`);
    });
  });

  test('resolveSessionIdKeyOrder: an earlier key wins when two are set', () => {
    const env = { ...NO_KEYS, WINDSURF_SESSION_ID: 'w', CODEX_THREAD_ID: 'c', CLAUDE_CODE_SESSION_ID: 'cc' };
    assert.equal(store.resolveSessionId({ env }), 'cc');
  });

  test('resolveSessionIdNeverUsesTerminal: terminal identity keys never produce an id', () => {
    for (const key of TERMINAL_KEYS) {
      assert.equal(store.resolveSessionId({ env: { ...NO_KEYS, [key]: 'pane-7' } }), null, key);
    }
  });

  test('an env value that sanitizes to nothing falls through to the next key', () => {
    assert.equal(store.resolveSessionId({ env: { ...NO_KEYS, GSD_SESSION_KEY: '///', CODEX_THREAD_ID: 'next' } }), 'next');
  });

  test('a blank --session falls back to the environment', () => {
    assert.equal(store.resolveSessionId({ session: '   ', env: { ...NO_KEYS, GSD_SESSION_KEY: 'k' } }), 'k');
  });
});

describe('filename grammar', () => {
  test('classifyHandoffNameFourForms', () => {
    assert.deepEqual(store.classifyHandoffName('HANDOFF.json'), { kind: 'legacy', role_id: null, session_id: null });
    assert.deepEqual(store.classifyHandoffName('HANDOFF.latest.coordinator.json'), { kind: 'latest', role_id: 'coordinator', session_id: null });
    assert.deepEqual(store.classifyHandoffName('HANDOFF.s1.json'), { kind: 'session', role_id: null, session_id: 's1' });
    assert.deepEqual(store.classifyHandoffName('HANDOFF.claimed.coordinator.s1.json'), { kind: 'claimed', role_id: 'coordinator', session_id: 's1' });
    assert.equal(store.latestHandoffName('coordinator'), 'HANDOFF.latest.coordinator.json');
    assert.equal(store.sessionHandoffName('s1'), 'HANDOFF.s1.json');
    assert.equal(store.claimedHandoffName('coordinator', 's1'), 'HANDOFF.claimed.coordinator.s1.json');
    assert.equal(store.continueHereName('coordinator'), '.continue-here.latest.coordinator.md');
    assert.equal(store.continueHereName(null), '.continue-here.md');
  });

  test('classifyHandoffNameRejectsMalformed', () => {
    for (const name of ['HANDOFF.latest.json', 'HANDOFF.json.json', 'HANDOFF..json', 'HANDOFF.claimed.r.json', 'handoff.x.json',
      'HANDOFF.x.json.bak', 'HANDOFF.x.JSON', 'HANDOFF.', 'HANDOFF', '', 'HANDOFF.latest..json', 'HANDOFF.x/y.json', 'HANDOFF.x\\y.json']) {
      assert.equal(store.classifyHandoffName(name), null, JSON.stringify(name));
    }
    assert.equal(store.classifyHandoffName(null), null);
    assert.equal(store.classifyHandoffName(42), null);
  });

  test('handoffGrammarRoundTripProperty: builders round-trip through classify for any input', () => {
    fc.assert(fc.property(fc.string(), (raw) => {
      const sid = store.sanitizeSessionId(raw);
      if (sid !== null) {
        const parsed = store.classifyHandoffName(store.sessionHandoffName(sid));
        if (!parsed || parsed.kind !== 'session' || parsed.session_id !== sid) return false;
      }
      const role = store.sanitizeRoleId(raw);
      if (role !== null) {
        const latest = store.classifyHandoffName(store.latestHandoffName(role));
        if (!latest || latest.kind !== 'latest' || latest.role_id !== role) return false;
        if (sid !== null) {
          const claimed = store.classifyHandoffName(store.claimedHandoffName(role, sid));
          if (!claimed || claimed.kind !== 'claimed' || claimed.role_id !== role || claimed.session_id !== sid) return false;
        }
      }
      return true;
    }), { seed: 4845, numRuns: 500 });
  });

  test('classifyNeverThrowsProperty: arbitrary input never throws and never yields a dotted role', () => {
    fc.assert(fc.property(fc.oneof(fc.string(), fc.constant(null), fc.integer()), (name) => {
      const parsed = store.classifyHandoffName(name);
      return parsed === null || parsed.role_id === null || !parsed.role_id.includes('.');
    }), { seed: 4962, numRuns: 500 });
  });
});

describe('ownership: the shared case table', () => {
  for (const row of cases) {
    test(`handoffCaseTableMatchesStore: ${row.name}`, () => {
      const parsed = store.classifyHandoffName(row.file);
      assert.equal(parsed ? parsed.kind : null, row.expect.kind);
      if (parsed === null) return;
      assert.equal(parsed.role_id, row.expect.role_id);
      assert.equal(parsed.session_id, row.expect.session_id);
      const entry = { file: row.file, ...parsed, body: row.body };
      assert.equal(store.isOwnHandoff(entry, row.identity), row.expect.is_self);
    });
  }
});

describe('listHandoffs and listRecords', () => {
  let tmp;
  let planning;
  beforeEach(() => { tmp = createTempProject(); planning = path.join(tmp, '.planning'); });
  afterEach(() => { cleanup(tmp); });

  const put = (name, content) => fs.writeFileSync(path.join(planning, name), typeof content === 'string' ? content : JSON.stringify(content));

  test('sessionsSkipsUnreadableEntries: cap-1 and cap are read; cap+1, invalid JSON, a symlink and a directory are skipped with a reason', () => {
    const pad = (n) => JSON.stringify({ pad: 'x'.repeat(n) });
    const base = JSON.stringify({ pad: '' }).length;
    put('HANDOFF.a1.json', pad(store.HANDOFF_MAX_BYTES - base - 1));
    put('HANDOFF.a2.json', pad(store.HANDOFF_MAX_BYTES - base));
    put('HANDOFF.a3.json', pad(store.HANDOFF_MAX_BYTES - base + 1));
    put('HANDOFF.a4.json', '{not json');
    fs.mkdirSync(path.join(planning, 'HANDOFF.a6.json'));
    const { handoffs, skipped } = store.listHandoffs(planning);
    assert.deepEqual(handoffs.map((h) => h.file).sort(), ['HANDOFF.a1.json', 'HANDOFF.a2.json']);
    const reasons = Object.fromEntries(skipped.map((s) => [s.file, s.reason]));
    assert.deepEqual(Object.keys(reasons).sort(), ['HANDOFF.a3.json', 'HANDOFF.a4.json', 'HANDOFF.a6.json']);
    for (const reason of Object.values(reasons)) assert.equal(typeof reason, 'string');
    assert.ok(fs.existsSync(path.join(planning, 'HANDOFF.a3.json')), 'a skipped file is never deleted');
  });

  test('listHandoffsSkipsSymlinks: a handoff-named symlink is skipped with a reason and its target is untouched', (t) => {
    put('HANDOFF.a1.json', {});
    if (!trySymlink(path.join(planning, 'HANDOFF.a1.json'), path.join(planning, 'HANDOFF.a5.json'))) {
      t.skip('creating a symlink needs a privilege this platform run does not have');
      return;
    }
    const { handoffs, skipped } = store.listHandoffs(planning);
    assert.deepEqual(handoffs.map((h) => h.file), ['HANDOFF.a1.json']);
    assert.deepEqual(skipped.map((s) => [s.file, s.reason]), [['HANDOFF.a5.json', 'symlink']]);
  });

  test('a file that is not named like a handoff is not listed or skipped', () => {
    put('HANDOFF.latest.json', {});
    put('notes.json', {});
    const { handoffs, skipped } = store.listHandoffs(planning);
    assert.deepEqual([handoffs, skipped], [[], []]);
  });

  test('body role fields are read for the legacy file only', () => {
    put('HANDOFF.json', { role: 'Reviewer A' });
    put('HANDOFF.s9.json', { role: 'Reviewer A', role_id: 'reviewer-a' });
    const byFile = Object.fromEntries(store.listHandoffs(planning).handoffs.map((h) => [h.file, h]));
    assert.equal(byFile['HANDOFF.json'].body.role, 'Reviewer A');
    assert.equal(byFile['HANDOFF.s9.json'].role_id, null);
  });

  test('listHandoffs on a missing directory returns empty lists', () => {
    assert.deepEqual(store.listHandoffs(path.join(tmp, 'absent')), { handoffs: [], skipped: [] });
  });

  test('listHandoffsReadFailureIsReportedNotThrown: an unreadable directory entry read is skipped (fs monkeypatch restored)', () => {
    put('HANDOFF.b1.json', {});
    const real = fs.openSync;
    mock.method(fs, 'openSync', (p, ...rest) => {
      if (String(p).endsWith('HANDOFF.b1.json')) throw Object.assign(new Error('EIO: simulated'), { code: 'EIO' });
      return real.call(fs, p, ...rest);
    });
    try {
      const { handoffs, skipped } = store.listHandoffs(planning);
      assert.deepEqual(handoffs, []);
      assert.equal(skipped.length, 1);
    } finally {
      mock.restoreAll();
    }
  });

  test('listRecords reads sessions/*.json and skips what is not a regular JSON object', () => {
    fs.mkdirSync(path.join(planning, 'sessions'));
    fs.writeFileSync(path.join(planning, 'sessions', 's1.json'), JSON.stringify({ session_id: 's1', role_id: 'r' }));
    fs.writeFileSync(path.join(planning, 'sessions', 's2.json'), '[1,2]');
    fs.writeFileSync(path.join(planning, 'sessions', 's3.json'), '{bad');
    const { records, skipped } = store.listRecords(planning);
    assert.deepEqual(records.map((r) => r.session_id), ['s1']);
    assert.deepEqual(skipped.map((s) => s.file).sort(), ['s2.json', 's3.json']);
  });
});
